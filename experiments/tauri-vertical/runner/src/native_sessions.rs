//! Profile-private native conversation reservations, independent of core history.
//! A reservation does NOT establish that provider history exists. Call reserve
//! before launching Claude, then pass the exact conversation_id on resume.
//! `resumed_from` is an optional Jauria session ID, not a provider-history lookup.
//! The caller supplies an existing, app-owned absolute 0700 profile directory;
//! this module never opens a provider profile, transcript, shell, or CLI.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}},
    path::{Component, Path},
};

const DIRECTORY: &str = "native-sessions";
const MAX_BYTES: u64 = 4096;
// Core session metadata is capped at 2 MiB before native admission. This
// capacity exceeds the number of valid retained session rows in that budget;
// abandoned files are still bounded and never silently discard conversation IDs.
#[cfg(not(test))]
const MAX_BINDINGS: usize = 16_384;
#[cfg(test)]
const MAX_BINDINGS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub conversation_id: String,
    pub provider: String,
    pub source: String,
    pub resumed_from: Option<String>,
}

/// Generate an RFC 4122 version 4 UUID using OS entropy only.
pub fn new_uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// Strict UUID text syntax; accepts either hex case without normalizing identity.
pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

/// Never creates directories or files. Malformed/unsafe existing entries are errors.
pub fn load(data_dir: &Path, session_id: &str) -> Result<Option<Binding>> {
    valid_id(session_id)?;
    let profile = open_profile(data_dir)?;
    let Some(directory) = open_directory(&profile, false)? else { return Ok(None) };
    let _lock = Lock::acquire(&directory, libc::LOCK_SH)?;
    read_binding(&directory, session_id)
}

/// An exact retry is idempotent; changing any field of a reservation is an error.
/// Publication never replaces an existing entry. Errors after publication (e.g.
/// directory fsync failure) can leave a complete reservation: retry the SAME
/// request to confirm durability, and do not launch a provider after an error.
/// Crashed temporary files count toward the quota; no untrusted entry is deleted.
pub fn reserve(
    data_dir: &Path,
    session_id: &str,
    provider: &str,
    conversation_id: &str,
    resumed_from: Option<&str>,
) -> Result<Binding> {
    valid_id(session_id)?;
    ensure!(matches!(provider, "claude" | "codex"), "unsupported native provider");
    ensure!(valid_uuid(conversation_id), "invalid native conversation UUID");
    if let Some(id) = resumed_from { valid_id(id)?; }
    let requested = Binding {
        conversation_id: conversation_id.into(), provider: provider.into(),
        source: "app_reserved".into(), resumed_from: resumed_from.map(str::to_owned),
    };
    let profile = open_profile(data_dir)?;
    let directory = open_directory(&profile, true)?.context("missing reservation directory")?;
    let _lock = Lock::acquire(&directory, libc::LOCK_EX)?;
    // Also sync on retries: a previous call may have committed before fsync failed.
    profile.sync_all()?;
    if let Some(existing) = read_binding(&directory, session_id)? {
        ensure!(existing == requested, "native reservation mismatch");
        directory.sync_all()?;
        return Ok(existing);
    }
    check_quota(&directory)?;
    let bytes = serde_json::to_vec(&json!({
        "schemaVersion": 1, "session_id": session_id,
        "conversation_id": requested.conversation_id, "provider": requested.provider,
        "source": requested.source, "resumed_from": requested.resumed_from,
    }))?;
    ensure!(bytes.len() as u64 <= MAX_BYTES, "native reservation too large");
    let (temporary, mut file) = create_temp(&directory)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    // Ensure the public profile still designates the directories we pinned.
    let current_profile = open_profile(data_dir)?;
    same_inode(&profile, &current_profile)?;
    let current_directory = open_directory(&current_profile, false)?.context("reservation directory disappeared")?;
    same_inode(&directory, &current_directory)?;
    let target = CString::new(format!("{session_id}.json"))?;
    match publish(&directory, &temporary.name, &target) {
        Ok(()) => {},
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_binding(&directory, session_id)?.context("raced reservation disappeared")?;
            ensure!(existing == requested, "native reservation mismatch");
        },
        Err(e) => return Err(e.into()),
    }
    directory.sync_all()?;
    Ok(requested)
}

fn valid_id(id: &str) -> Result<()> {
    ensure!(!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "invalid Jauria session ID");
    Ok(())
}

fn cvt(value: libc::c_int) -> std::io::Result<libc::c_int> {
    if value < 0 { Err(std::io::Error::last_os_error()) } else { Ok(value) }
}

fn open_at(directory: &File, name: &CStr, flags: libc::c_int) -> std::io::Result<File> {
    let fd = cvt(unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(),
        flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o600) })?;
    // SAFETY: fd is a fresh owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn private_directory(file: &File) -> Result<()> {
    let m = file.metadata()?;
    ensure!(m.is_dir() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o7777 == 0o700,
        "native profile directories must be owned and exactly 0700");
    Ok(())
}

fn private_file(m: &Metadata) -> Result<()> {
    ensure!(m.is_file() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o7777 == 0o600 && m.nlink() == 1,
        "native reservation must be an owned 0600 regular file with one link");
    Ok(())
}

fn open_profile(path: &Path) -> Result<File> {
    ensure!(path.is_absolute(), "profile path must be absolute");
    let fd = cvt(unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) })?;
    // SAFETY: fd is a fresh owned descriptor.
    let mut directory = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(name) => directory = open_at(&directory, &CString::new(name.as_bytes())?, libc::O_RDONLY | libc::O_DIRECTORY)?,
            _ => bail!("profile path must not contain parent traversal"),
        }
    }
    private_directory(&directory)?;
    Ok(directory)
}

fn open_directory(profile: &File, create: bool) -> Result<Option<File>> {
    let name = CString::new(DIRECTORY)?;
    let created = if create {
        match cvt(unsafe { libc::mkdirat(profile.as_raw_fd(), name.as_ptr(), 0o700) }) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        }
    } else { false };
    let directory = match open_at(profile, &name, libc::O_RDONLY | libc::O_DIRECTORY) {
        Ok(directory) => directory,
        Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if created { cvt(unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) })?; }
    private_directory(&directory)?;
    Ok(Some(directory))
}

fn same_inode(a: &File, b: &File) -> Result<()> {
    let a = a.metadata()?;
    let b = b.metadata()?;
    ensure!(a.dev() == b.dev() && a.ino() == b.ino(), "native profile directory changed");
    Ok(())
}

fn read_binding(directory: &File, session_id: &str) -> Result<Option<Binding>> {
    let name = CString::new(format!("{session_id}.json"))?;
    let file = match open_at(directory, &name, libc::O_RDONLY) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    private_file(&file.metadata()?)?;
    ensure!(file.metadata()?.len() <= MAX_BYTES, "native reservation too large");
    let mut bytes = Vec::new();
    (&file).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_BYTES, "native reservation too large");
    private_file(&file.metadata()?)?;
    let value: Value = serde_json::from_slice(&bytes)?;
    let object = value.as_object().context("native reservation must be an object")?;
    ensure!(object.len() == 6 && object.get("schemaVersion").and_then(Value::as_u64) == Some(1)
        && object.get("session_id").and_then(Value::as_str) == Some(session_id), "invalid native reservation schema or session");
    let string = |key| object.get(key).and_then(Value::as_str).context("missing native reservation string");
    let conversation_id = string("conversation_id")?;
    ensure!(valid_uuid(conversation_id), "invalid native conversation UUID");
    let provider = string("provider")?;
    ensure!(matches!(provider, "claude" | "codex"), "unsupported native provider");
    ensure!(string("source")? == "app_reserved", "invalid native reservation source");
    let resumed_from = match object.get("resumed_from") {
        Some(Value::Null) => None,
        Some(Value::String(id)) => { valid_id(id)?; Some(id.clone()) },
        _ => bail!("invalid native reservation origin"),
    };
    Ok(Some(Binding { conversation_id: conversation_id.into(), provider: provider.into(), source: "app_reserved".into(), resumed_from }))
}

struct Lock<'a>(&'a File);
impl<'a> Lock<'a> {
    fn acquire(directory: &'a File, operation: libc::c_int) -> Result<Self> {
        loop {
            match cvt(unsafe { libc::flock(directory.as_raw_fd(), operation) }) {
                Ok(_) => return Ok(Self(directory)),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
}
impl Drop for Lock<'_> {
    fn drop(&mut self) { unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN); } }
}

fn check_quota(directory: &File) -> Result<()> {
    // A new open description avoids sharing a directory offset across calls.
    let scan = open_at(directory, c".", libc::O_RDONLY | libc::O_DIRECTORY)?;
    use std::os::fd::IntoRawFd;
    let fd = scan.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(fd); }
        return Err(error.into());
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
    let stream = Stream(stream);
    let mut count = 0;
    loop {
        // readdir signals EOF and error with null; clear errno to distinguish.
        #[cfg(target_os = "macos")]
        unsafe { *libc::__error() = 0; }
        #[cfg(target_os = "linux")]
        unsafe { *libc::__errno_location() = 0; }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            ensure!(error.raw_os_error() == Some(0), "cannot enumerate native reservations: {error}");
            return Ok(());
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name == b"." || name == b".." { continue; }
        count += 1;
        ensure!(count < MAX_BINDINGS, "native reservation quota exhausted");
    }
}

struct Temporary<'a> { directory: &'a File, name: CString }
impl Drop for Temporary<'_> {
    fn drop(&mut self) { unsafe { libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0); } }
}
fn create_temp(directory: &File) -> Result<(Temporary<'_>, File)> {
    for _ in 0..16 {
        let name = CString::new(format!(".{}.tmp", new_uuid()?))?;
        match open_at(directory, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL) {
            Ok(file) => {
                let temporary = Temporary { directory, name };
                cvt(unsafe { libc::fchmod(file.as_raw_fd(), 0o600) })?;
                private_file(&file.metadata()?)?;
                return Ok((temporary, file));
            },
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("cannot create native reservation temporary file")
}

fn publish(directory: &File, temporary: &CStr, target: &CStr) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renameatx_np(directory.as_raw_fd(), temporary.as_ptr(), directory.as_raw_fd(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::renameat2(directory.as_raw_fd(), temporary.as_ptr(), directory.as_raw_fd(), target.as_ptr(), libc::RENAME_NOREPLACE) };
    cvt(result).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::{PermissionsExt, symlink}, sync::{Arc, Barrier}, thread};

    const UUID: &str = "12345678-1234-4234-8234-123456789abc";
    fn profile() -> tempfile::TempDir {
        // macOS /var is a symlink; canonicalize the temporary root for openat walks.
        let root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let temp = tempfile::tempdir_in(root).unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        temp
    }
    fn save(path: &Path) -> Binding { reserve(path, "session-1", "claude", UUID, None).unwrap() }
    fn record(path: &Path) -> std::path::PathBuf { path.join(DIRECTORY).join("session-1.json") }

    #[test]
    fn uuid_syntax_and_entropy() {
        let a = new_uuid().unwrap();
        assert!(valid_uuid(&a));
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(b"89ab".contains(&a.as_bytes()[19]));
        assert_ne!(a, new_uuid().unwrap());
        assert!(valid_uuid(&UUID.to_uppercase()));
        for bad in ["", "12345678123442348234123456789abc", "12345678_1234-4234-8234-123456789abc", "g2345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abc\n"] {
            assert!(!valid_uuid(bad));
        }
    }

    #[test]
    fn absent_load_never_creates_and_exact_retry_reopens() {
        let p = profile();
        assert_eq!(load(p.path(), "session-1").unwrap(), None);
        assert!(!p.path().join(DIRECTORY).exists());
        let binding = save(p.path());
        assert_eq!(binding.source, "app_reserved");
        assert_eq!(binding.conversation_id, UUID);
        assert_eq!(load(p.path(), "session-1").unwrap(), Some(binding.clone()));
        assert_eq!(save(p.path()), binding);
        assert_eq!(load(p.path(), "other").unwrap(), None);
        assert_eq!(fs::metadata(record(p.path())).unwrap().nlink(), 1);
        assert_eq!(fs::metadata(record(p.path())).unwrap().mode() & 0o7777, 0o600);
        assert_eq!(fs::metadata(p.path().join(DIRECTORY)).unwrap().mode() & 0o7777, 0o700);
        assert_eq!(fs::read_dir(p.path().join(DIRECTORY)).unwrap().count(), 1);
    }

    #[test]
    fn mismatch_and_optional_origin_are_exact() {
        let p = profile();
        let original = reserve(p.path(), "s", "codex", UUID, Some("parent-1")).unwrap();
        assert_eq!(load(p.path(), "s").unwrap(), Some(original.clone()));
        assert_eq!(reserve(p.path(), "s", "codex", UUID, Some("parent-1")).unwrap(), original);
        for (provider, uuid, origin) in [
            ("claude", UUID.to_owned(), Some("parent-1")),
            ("codex", new_uuid().unwrap(), Some("parent-1")),
            ("codex", UUID.to_owned(), None),
            ("codex", UUID.to_owned(), Some("parent-2")),
            ("codex", UUID.to_uppercase(), Some("parent-1")),
        ] { assert!(reserve(p.path(), "s", provider, &uuid, origin).is_err()); }
        assert_eq!(load(p.path(), "s").unwrap(), Some(original));
    }

    #[test]
    fn invalid_arguments_do_not_write() {
        let p = profile();
        for id in ["", ".", "..", "../escape", "/absolute", "a/b", "a_b", "é", "a\0b", &"a".repeat(65)] {
            assert!(load(p.path(), id).is_err());
            assert!(reserve(p.path(), id, "claude", UUID, None).is_err());
            assert!(reserve(p.path(), "good", "claude", UUID, Some(id)).is_err());
        }
        assert!(reserve(p.path(), "good", "Claude", UUID, None).is_err());
        assert!(reserve(p.path(), "good", "claude", "invalid", None).is_err());
        assert!(!p.path().join(DIRECTORY).exists());
        assert!(reserve(p.path(), &"a".repeat(64), "codex", UUID, None).is_ok());
        assert!(load(Path::new("relative"), "good").is_err());
        assert!(load(&p.path().join(".."), "good").is_err());
    }

    #[test]
    fn unsafe_directories_and_links_are_rejected() {
        let p = profile();
        let other = profile();
        fs::set_permissions(p.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        assert!(reserve(p.path(), "session-1", "claude", UUID, None).is_err());
        fs::set_permissions(p.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias = other.path().join("alias");
        symlink(p.path(), &alias).unwrap();
        assert!(load(&alias, "session-1").is_err());
        symlink(other.path(), p.path().join(DIRECTORY)).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        assert!(reserve(p.path(), "session-1", "claude", UUID, None).is_err());
        fs::remove_file(p.path().join(DIRECTORY)).unwrap();
        save(p.path());
        fs::set_permissions(p.path().join(DIRECTORY), fs::Permissions::from_mode(0o750)).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        fs::set_permissions(p.path().join(DIRECTORY), fs::Permissions::from_mode(0o700)).unwrap();
        fs::hard_link(record(p.path()), other.path().join("hardlink")).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        assert!(reserve(p.path(), "session-1", "claude", UUID, None).is_err());
        fs::remove_file(other.path().join("hardlink")).unwrap();
        fs::remove_file(record(p.path())).unwrap();
        symlink(other.path().join("missing"), record(p.path())).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        assert!(reserve(p.path(), "session-1", "claude", UUID, None).is_err());
    }

    #[test]
    fn corrupt_existing_records_fail_closed() {
        let p = profile();
        save(p.path());
        let original = fs::read(record(p.path())).unwrap();
        let value: Value = serde_json::from_slice(&original).unwrap();
        let mut variants = vec![b"{".to_vec(), vec![b' '; MAX_BYTES as usize + 1], b"null".to_vec()];
        for (key, bad) in [
            ("schemaVersion", json!(2)), ("session_id", json!("another")),
            ("provider", json!("other")), ("conversation_id", json!("bad")),
            ("source", json!("discovered")), ("resumed_from", json!(false)),
            ("resumed_from", json!("../bad")), ("extra", json!(1)),
        ] {
            let mut changed = value.clone();
            changed[key] = bad;
            variants.push(serde_json::to_vec(&changed).unwrap());
        }
        for bytes in variants {
            fs::write(record(p.path()), &bytes).unwrap();
            assert!(load(p.path(), "session-1").is_err());
            assert!(reserve(p.path(), "session-1", "claude", UUID, None).is_err());
            assert_eq!(fs::read(record(p.path())).unwrap(), bytes);
        }
        fs::write(record(p.path()), original).unwrap();
        fs::set_permissions(record(p.path()), fs::Permissions::from_mode(0o640)).unwrap();
        assert!(load(p.path(), "session-1").is_err());
        fs::set_permissions(record(p.path()), fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(record(p.path())).unwrap();
        fs::create_dir(record(p.path())).unwrap();
        assert!(load(p.path(), "session-1").is_err());
    }

    #[test]
    fn concurrent_reservations_have_one_winner() {
        let p = profile();
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|_| {
            let path = p.path().to_owned();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let uuid = new_uuid().unwrap();
                barrier.wait();
                reserve(&path, "same", "claude", &uuid, None)
            })
        }).collect();
        let winners: Vec<_> = workers.into_iter().filter_map(|w| w.join().unwrap().ok()).collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(load(p.path(), "same").unwrap(), Some(winners[0].clone()));
        assert_eq!(fs::read_dir(p.path().join(DIRECTORY)).unwrap().count(), 1);
    }

    #[test]
    fn quota_is_bounded_and_retries_still_work() {
        let p = profile();
        let original = save(p.path());
        for i in 1..MAX_BINDINGS {
            fs::write(p.path().join(DIRECTORY).join(format!("orphan-{i}.tmp")), []).unwrap();
        }
        assert!(reserve(p.path(), "new", "claude", UUID, None).is_err());
        assert_eq!(save(p.path()), original);
        fs::remove_file(p.path().join(DIRECTORY).join("orphan-1.tmp")).unwrap();
        assert!(reserve(p.path(), "new", "claude", UUID, None).is_ok());
        assert_eq!(fs::read_dir(p.path().join(DIRECTORY)).unwrap().count(), MAX_BINDINGS);
    }

    #[test]
    fn exclusive_publication_preserves_raced_target() {
        let p = profile();
        save(p.path());
        let profile = open_profile(p.path()).unwrap();
        let directory = open_directory(&profile, false).unwrap().unwrap();
        let before = fs::read(record(p.path())).unwrap();
        let (temporary, mut file) = create_temp(&directory).unwrap();
        file.write_all(b"incomplete replacement").unwrap();
        file.sync_all().unwrap();
        let error = publish(&directory, &temporary.name, c"session-1.json").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(record(p.path())).unwrap(), before);
        drop(temporary);
        assert_eq!(fs::read_dir(p.path().join(DIRECTORY)).unwrap().count(), 1);
    }
}

//! Durable, profile-local settings. The caller must hold the global session
//! mutation gate while changing the limit; this module never accesses processes.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::{Read, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}},
    path::{Component, Path, PathBuf},
    sync::{Mutex, atomic::{AtomicU64, Ordering}},
};

const NAME: &str = "app-settings.json";
const MAX_BYTES: u64 = 16 * 1024;
const WARNING: &str = "No se pudo cargar la configuración. Se usan los valores predeterminados; guarda para reemplazarla.";
const DURABILITY_WARNING: &str = "La configuración se guardó, pero no se pudo confirmar su persistencia ante un apagado inesperado. Vuelve a guardar para reintentar.";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct State {
    limit: usize,
    warning: Option<&'static str>,
}

pub struct AppSettings {
    profile: PathBuf,
    directory: File,
    state: Mutex<State>,
    #[cfg(test)]
    pub(crate) fail_directory_sync: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(crate) fail_before_rename: std::sync::atomic::AtomicBool,
}

impl AppSettings {
    /// Requires an existing absolute, owned 0700 profile directory. Opening never
    /// creates or repairs files. Invalid settings remain available for inspection.
    pub fn open(profile: &Path) -> Result<Self> {
        let directory = open_profile(profile)?;
        let (limit, warning) = match load(&directory) {
            Ok(Some(limit)) => (limit, None),
            Ok(None) => (2, None),
            Err(_) => (2, Some(WARNING)),
        };
        Ok(Self {
            profile: profile.to_owned(),
            directory,
            state: Mutex::new(State { limit, warning }),
            #[cfg(test)]
            fail_directory_sync: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fail_before_rename: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn limit(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).limit
    }

    pub fn snapshot(&self) -> Value {
        snapshot(&self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Call under the runner's global session mutation gate. Lowering the limit
    /// affects admission only: no existing session is stopped here.
    /// Errors leave the previous file and memory intact. Once rename commits,
    /// returns the new snapshot; directory-fsync failure becomes a durability warning.
    pub fn set_limit(&self, limit: usize) -> Result<Value> {
        ensure!((1..=8).contains(&limit), "session limit must be an integer from 1 to 8");
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.validate_profile()?;
        validate_target(&self.directory)?;
        let bytes = serde_json::to_vec(&json!({
            "schemaVersion": 1, "maxConcurrentSessions": limit
        }))?;

        let (temporary, mut file) = create_temp(&self.directory)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Recheck immediately before replacing the directory entry. All I/O is
        // relative to the pinned directory, so path substitution cannot redirect it.
        self.validate_profile()?;
        validate_target(&self.directory)?;
        #[cfg(test)]
        if self.fail_before_rename.swap(false, Ordering::Relaxed) {
            anyhow::bail!("injected precommit failure");
        }
        let target = CString::new(NAME)?;
        cvt(unsafe { libc::renameat(
            self.directory.as_raw_fd(), temporary.name.as_ptr(),
            self.directory.as_raw_fd(), target.as_ptr(),
        ) })?;
        // Rename is the commit point. A later directory-fsync failure cannot be
        // reported as a failed save: memory and admission must match the new file.
        state.limit = limit;
        state.warning = if self.sync_directory().is_err() { Some(DURABILITY_WARNING) } else { None };
        Ok(snapshot(&state))
    }

    fn sync_directory(&self) -> std::io::Result<()> {
        #[cfg(test)]
        if self.fail_directory_sync.swap(false, Ordering::Relaxed) {
            return Err(std::io::Error::other("injected directory fsync failure"));
        }
        self.directory.sync_all()
    }

    fn validate_profile(&self) -> Result<()> {
        let current = open_profile(&self.profile)?.metadata()?;
        let pinned = self.directory.metadata()?;
        ensure!(current.dev() == pinned.dev() && current.ino() == pinned.ino(),
            "profile directory changed");
        Ok(())
    }
}

fn snapshot(state: &State) -> Value {
    json!({
        "schemaVersion": 1,
        "maxConcurrentSessions": state.limit,
        "maxSupportedSessions": 8,
        "warning": state.warning,
    })
}

fn cvt(fd: libc::c_int) -> std::io::Result<libc::c_int> {
    if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(fd) }
}

fn open_at(directory: &File, name: &CString, flags: libc::c_int) -> std::io::Result<File> {
    let fd = cvt(unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(),
        flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o600) })?;
    // SAFETY: openat returned a fresh owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_profile(path: &Path) -> Result<File> {
    ensure!(path.is_absolute(), "profile path must be absolute");
    let root = CString::new("/")?;
    let fd = cvt(unsafe { libc::open(root.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) })?;
    // SAFETY: open returned a fresh owned descriptor.
    let mut directory = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(name) => {
                directory = open_at(&directory, &CString::new(name.as_bytes())?,
                    libc::O_RDONLY | libc::O_DIRECTORY)?;
            },
            _ => anyhow::bail!("profile path must not contain parent traversal"),
        }
    }
    let meta = directory.metadata()?;
    ensure!(meta.is_dir() && meta.uid() == unsafe { libc::geteuid() }
        && meta.mode() & 0o7777 == 0o700, "profile must be an owned 0700 directory");
    Ok(directory)
}

fn private_file(meta: &Metadata) -> Result<()> {
    ensure!(meta.is_file() && meta.uid() == unsafe { libc::geteuid() }
        && meta.mode() & 0o7777 == 0o600 && meta.nlink() == 1,
        "settings must be an owned 0600 regular file with one link");
    Ok(())
}

fn existing(directory: &File) -> Result<Option<File>> {
    match open_at(directory, &CString::new(NAME)?, libc::O_RDONLY) {
        Ok(file) => { private_file(&file.metadata()?)?; Ok(Some(file)) },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn validate_target(directory: &File) -> Result<()> {
    existing(directory).map(|_| ())
}

fn load(directory: &File) -> Result<Option<usize>> {
    let Some(file) = existing(directory)? else { return Ok(None) };
    ensure!(file.metadata()?.len() <= MAX_BYTES, "settings too large");
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_BYTES, "settings too large");
    let value: Value = serde_json::from_slice(&bytes)?;
    let object = value.as_object().context("settings must be an object")?;
    ensure!(object.len() == 2 && object.contains_key("schemaVersion")
        && object.contains_key("maxConcurrentSessions"), "unknown or missing settings fields");
    ensure!(object["schemaVersion"].as_u64() == Some(1), "unsupported settings schema");
    let limit = object["maxConcurrentSessions"].as_u64().context("invalid session limit")?;
    ensure!((1..=8).contains(&limit), "invalid session limit");
    Ok(Some(limit as usize))
}

fn create_temp(directory: &File) -> Result<(Temporary<'_>, File)> {
    for _ in 0..128 {
        let name = CString::new(format!(".app-settings-{}-{}.tmp", std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)))?;
        match open_at(directory, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL) {
            Ok(file) => {
                let temporary = Temporary { directory, name };
                // Defeat restrictive umasks without changing the process umask.
                cvt(unsafe { libc::fchmod(file.as_raw_fd(), 0o600) })?;
                private_file(&file.metadata()?)?;
                return Ok((temporary, file));
            },
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("could not create settings temporary file")
}

struct Temporary<'a> { directory: &'a File, name: CString }
impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        // Cleanup only our exclusively created entry, relative to the pinned fd.
        unsafe { libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0); }
    }
}

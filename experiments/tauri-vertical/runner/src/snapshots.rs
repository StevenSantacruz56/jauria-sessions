//! Read-only snapshots, schema `aw.snapshot.v1`; only public entry point: `capture`.
//!
//! Contract for registry/review/handoff: store the entire returned JSON. Compare
//! `fingerprint` as an opaque string. It identifies base + HEAD + raw index + all
//! selected effective files (tracked + nonignored untracked), paths, bytes and executable modes.
//! Index stat-cache changes conservatively invalidate it. The index is evidence,
//! not the source of the effective tree. `files` describes base -> working tree;
//! `diff` is a bounded readable rendering of that comparison; `head_diff` is base
//! -> HEAD (agent commits); `local_files`/`local_diff` are HEAD -> working tree. Renames are represented as delete/add. Text rendering
//! uses complete old/new lines, not a minimal patch; it is never executable.
//!
//! IDs use Git's blob hash, WITHOUT writing objects: `git-blob:<sha1|sha256>:<oid>`.
//! The hashed bytes are deterministic serde_json serialization of a versioned
//! manifest containing base, head, index identity and sorted file identities.
//! No timestamps, absolute checkout paths, temp paths or rendering enter the ID.
//! Binary/large files retain complete content identities; only their preview is
//! omitted. A preview omission is explicit and never truncates fingerprint input.
//!
//! Limits: 45s cooperative aggregate deadline, 2048 files/tree, 8192 filesystem
//! metadata entries, depth 64, path 4096 bytes, file 16 MiB, content 64 MiB/pass (worktree,
//! index and fetched changed base/HEAD blobs combined), Git output 20 MiB/call,
//! text 16 KiB/file, combined preview 256 KiB. Memory is bounded by these budgets
//! (two result manifests plus one bounded subprocess input/output, <256 MiB of
//! payload; allocator overhead excluded). Git child RSS is sampled (256 MiB), with possible spikes between samples. Filesystem syscalls are cooperative:
//! hung kernel/filesystem I/O cannot be given a hard wall-clock guarantee here.
//!
//! Two complete captures must match by content identity, including HEAD/index;
//! otherwise Err("unstable: ..."). This detects observed changes, NOT an atomic
//! OS snapshot or ABA writes between observations. Caller serializes writers and
//! owns the registry/review gates. External writers are never signaled or killed.
//!
//! Errors have stable category prefixes: missing, unsupported, limit, deadline,
//! unstable, busy, git, io. No partial JSON is returned. Missing leaf files in a
//! base tree are deletions; missing root/base/objects are errors. Unsupported:
//! non-UTF8 paths, gitlinks/submodules/nested repos, special files, split index,
//! reftable, object alternates, symlinked metadata. File symlinks are captured as
//! link bytes, never followed. All worktree directory walks use openat/NOFOLLOW.
//! Ignored untracked files are excluded: dependencies/ignored configuration are
//! outside this evidence and must be considered by verification policy. Base/HEAD
//! paths remain tracked evidence even if removed from the index. Git evaluates
//! working .gitignore + common info/exclude, never global excludes/configuration.
//! Selection uses an isolated copy of the index and check-ignore pruning;
//! directory enumeration and file reads use openat/NOFOLLOW.
//! No filters/attributes evaluation, hooks, user/global/local Git configuration, network,
//! stage, write-tree, commit, or object writes. Git reads through an isolated
//! temporary bare metadata directory, deleted on return. Metadata must not be
//! maliciously replaced concurrently; double capture is not a security lock.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::{CString, OsStr}, fs::{self, File}, io::{Read, Write},
    os::unix::{ffi::OsStrExt, fs::MetadataExt, io::{AsRawFd, FromRawFd}, process::CommandExt},
    path::{Component, Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

const FILE: usize = 16 * 1024 * 1024;
const TOTAL: usize = 64 * 1024 * 1024;
const OUTPUT: usize = 20 * 1024 * 1024;
const FILES: usize = 2048;
const TEXT: usize = 16 * 1024;
const PREVIEW: usize = 256 * 1024;

type Tree = BTreeMap<String, Entry>;
#[derive(Clone, Debug, PartialEq)]
struct Entry { mode: String, oid: String, size: usize, binary: bool, text: Option<String> }
struct Budget { end: Instant, bytes: usize, entries: usize }
impl Budget {
    fn check(&self) -> Result<()> { ensure!(Instant::now() < self.end, "deadline: snapshot exceeded 45 seconds"); Ok(()) }
    fn bytes(&mut self, n: usize) -> Result<()> {
        self.check()?;
        self.bytes = self.bytes.checked_add(n).context("limit: byte counter overflow")?;
        ensure!(self.bytes <= TOTAL, "limit: snapshot content exceeds 64 MiB/pass"); Ok(())
    }
}
fn io_error(e: std::io::Error) -> anyhow::Error {
    anyhow::anyhow!("{}: {}", if e.kind() == std::io::ErrorKind::NotFound { "missing" } else { "io" }, e)
}
fn cstr(s: &OsStr) -> Result<CString> { CString::new(s.as_bytes()).context("unsupported: NUL in path") }
fn open_at(dir: &File, name: &OsStr, directory: bool) -> Result<File> {
    let name = cstr(name)?;
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
    if fd == -1 {
        let e = std::io::Error::last_os_error();
        if matches!(e.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) { bail!("unsupported: symlink/non-directory path component"); }
        return Err(io_error(e));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn absolute(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "unsupported: root/metadata path must be absolute");
    let mut out = PathBuf::from("/");
    for c in path.components() { match c { Component::Normal(s) => out.push(s), Component::ParentDir => { out.pop(); }, Component::RootDir | Component::CurDir => {}, _ => bail!("unsupported: path prefix") } }
    ensure!(out.as_os_str().len() <= 4096 && out.to_str().is_some(), "unsupported: oversized/non-UTF8 path");
    Ok(out)
}
fn directory(path: &Path) -> Result<File> {
    let path = absolute(path)?;
    let mut fd = File::open("/").map_err(io_error)?;
    for part in path.components() { if let Component::Normal(s) = part { fd = open_at(&fd, s, true)?; } }
    Ok(fd)
}
fn read_file(mut f: File, b: &mut Budget) -> Result<Vec<u8>> {
    let m = f.metadata().map_err(io_error)?;
    ensure!(m.is_file(), "unsupported: non-regular metadata/content file");
    ensure!(m.len() <= FILE as u64, "limit: file exceeds 16 MiB");
    let mut out = Vec::new();
    let mut buf = [0u8; 32768];
    loop {
        b.check()?;
        let n = f.read(&mut buf).map_err(io_error)?;
        if n == 0 { break; }
        ensure!(out.len() + n <= FILE, "limit: file exceeds 16 MiB");
        b.bytes(n)?; out.extend_from_slice(&buf[..n]);
    }
    let after = f.metadata().map_err(io_error)?;
    ensure!(m.len() == after.len() && m.mtime() == after.mtime() && m.mtime_nsec() == after.mtime_nsec()
        && m.ctime() == after.ctime() && m.ctime_nsec() == after.ctime_nsec(), "unstable: file changed while reading");
    Ok(out)
}
fn optional_file(dir: &File, name: &str, b: &mut Budget) -> Result<Option<Vec<u8>>> {
    match open_at(dir, OsStr::new(name), false) {
        Ok(f) => Ok(Some(read_file(f, b)?)),
        Err(e) if e.to_string().starts_with("missing:") => Ok(None), Err(e) => Err(e),
    }
}
fn names(dir: &File, b: &mut Budget) -> Result<Vec<String>> {
    b.check()?;
    let copy = unsafe { libc::openat(dir.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    ensure!(copy >= 0, "io: opening directory enumeration");
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() { unsafe { libc::close(copy); } bail!("io: fdopendir"); }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
    let stream = Stream(stream);
    let mut out = Vec::new();
    loop {
        b.check()?;
        // readdir's errno must be distinguished from end-of-stream.
        unsafe { *errno() = 0; }
        let e = unsafe { libc::readdir(stream.0) };
        if e.is_null() { ensure!(unsafe { *errno() } == 0, "io: directory enumeration failed"); break; }
        let raw = unsafe { std::ffi::CStr::from_ptr((*e).d_name.as_ptr()) }.to_bytes();
        if raw == b"." || raw == b".." { continue; }
        b.entries += 1;
        ensure!(b.entries <= 8192, "limit: more than 8192 directory entries");
        out.push(std::str::from_utf8(raw).context("unsupported: non-UTF8 filename")?.to_owned());
    }
    out.sort(); Ok(out)
}
#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut libc::c_int { unsafe { libc::__error() } }
#[cfg(not(target_os = "macos"))]
unsafe fn errno() -> *mut libc::c_int { unsafe { libc::__errno_location() } }
fn stat(dir: &File, name: &str) -> Result<libc::stat> {
    let mut st = unsafe { std::mem::zeroed() };
    let name = cstr(OsStr::new(name))?;
    if unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(st)
}

struct Scratch(PathBuf);
impl Scratch {
    fn new(format: &str) -> Result<Self> {
        let template = std::env::temp_dir().join("aw-snapshot-XXXXXX");
        let mut bytes = cstr(template.as_os_str())?.into_bytes_with_nul();
        ensure!(!unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null(), "io: creating isolated Git metadata");
        let p = PathBuf::from(std::ffi::OsString::from_vec(bytes[..bytes.len()-1].to_vec()));
        let s = Self(p);
        fs::create_dir(s.0.join("objects"))?; fs::create_dir(s.0.join("refs"))?;
        fs::write(s.0.join("HEAD"), "ref: refs/heads/snapshot\n")?;
        fs::write(s.0.join("config"), format!("[core]\nbare = true\nrepositoryformatversion = {}\n{}", if format == "sha256" {1} else {0}, if format == "sha256" {"[extensions]\nobjectformat = sha256\n"} else {""}))?;
        Ok(s)
    }
}
use std::os::unix::ffi::OsStringExt;
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

// Bounded duplex I/O. Only our own Git child/session is ever signaled.
fn execute(cmd: Command, input: &[u8], b: &Budget) -> Result<Vec<u8>> { execute_codes(cmd, input, b, false) }
fn execute_codes(mut cmd: Command, input: &[u8], b: &Budget, allow_one: bool) -> Result<Vec<u8>> {
    b.check()?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe { cmd.pre_exec(|| {
        if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }); }
    let child = cmd.spawn().context("git: starting /usr/bin/git")?;
    struct Child(std::process::Child);
    impl Drop for Child { fn drop(&mut self) { unsafe { libc::killpg(self.0.id() as i32, libc::SIGKILL); } let _ = self.0.wait(); } }
    let mut child = Child(child);
    let mut stdin = child.0.stdin.take();
    let mut stdout = child.0.stdout.take().unwrap(); let mut stderr = child.0.stderr.take().unwrap();
    for fd in [stdin.as_ref().unwrap().as_raw_fd(), stdout.as_raw_fd(), stderr.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0, "io: nonblocking Git pipes");
    }
    let (mut sent, mut out, mut err) = (0, Vec::new(), Vec::new());
    let (mut out_done, mut err_done) = (false, false);
    loop {
        b.check()?;
        child_memory(child.0.id())?;
        if let Some(pipe) = stdin.as_mut() {
            if sent < input.len() { match pipe.write(&input[sent..input.len().min(sent+32768)]) {
                Ok(n) => sent += n, Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {}, Err(e) => return Err(e).context("git: writing input"),
            } }
            if sent == input.len() { stdin.take(); }
        }
        for (reader, data, done) in [(&mut stdout as &mut dyn Read, &mut out, &mut out_done), (&mut stderr as &mut dyn Read, &mut err, &mut err_done)] {
            let mut buf = [0; 8192];
            for _ in 0..8 { match reader.read(&mut buf) {
                Ok(0) => { *done = true; break; }, Ok(n) => { ensure!(data.len()+n <= OUTPUT, "limit: Git output exceeded 20 MiB"); data.extend_from_slice(&buf[..n]); },
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e).context("git: reading output"),
            } }
        }
        // Do not reap until Drop: the group ID must not be reused before killpg.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::waitid(libc::P_PID, child.0.id(), &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        ensure!(rc == 0, "git: observing process exit");
        if unsafe { info.si_pid() } != 0 && out_done && err_done {
            // waitid status is the exit code for CLD_EXITED.
            ensure!(info.si_code == libc::CLD_EXITED && (unsafe { info.si_status() } == 0 || (allow_one && unsafe { info.si_status() } == 1)),
                "git: command failed: {}", String::from_utf8_lossy(&err));
            return Ok(out);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
// macOS does not support a useful hard RLIMIT_DATA/AS cap. Sample our owned
// child's RSS during every nonblocking I/O cycle and abort on overflow. This is
// a cooperative bound, with possible allocation spikes between samples.
#[cfg(target_os = "macos")]
fn child_memory(pid: u32) -> Result<()> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let got = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size) };
    if got == size { ensure!(info.pti_resident_size <= 256 * 1024 * 1024, "limit: Git child RSS exceeds 256 MiB"); }
    // A process transitioning to zombie can no longer supply task info.
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn child_memory(pid: u32) -> Result<()> {
    if let Ok(data) = fs::read_to_string(format!("/proc/{pid}/statm")) {
        let pages: u64 = data.split_ascii_whitespace().nth(1).context("io: child RSS")?.parse()?;
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        ensure!(page > 0 && pages.saturating_mul(page as u64) <= 256 * 1024 * 1024, "limit: Git child RSS exceeds 256 MiB");
    }
    Ok(())
}
fn command() -> Command {
    let mut c = Command::new("/usr/bin/git");
    c.current_dir("/").env_clear().env("PATH", "/usr/bin:/bin").env("LANG", "C").env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_SYSTEM", "/dev/null").env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("HOME", "/dev/null").env("GIT_OPTIONAL_LOCKS", "0").env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1").env("GIT_ALLOW_PROTOCOL", "").env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ATTR_NOSYSTEM", "1");
    c.args(["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "gc.auto=0", "-c", "maintenance.auto=false"]);
    c
}
struct Git { scratch: Scratch, objects: PathBuf, format: String }
impl Git {
    fn run(&self, args: &[&str], input: &[u8], b: &Budget) -> Result<Vec<u8>> {
        let mut cmd = command(); cmd.arg("--git-dir").arg(&self.scratch.0).args(args).env("GIT_OBJECT_DIRECTORY", &self.objects);
        execute(cmd, input, b)
    }
    fn hash(&self, data: &[u8], b: &Budget) -> Result<String> {
        let out = self.run(&["hash-object", "--stdin", "--no-filters"], data, b)?;
        let oid = std::str::from_utf8(&out)?.trim_end_matches('\n'); valid_oid(oid)?; Ok(oid.to_owned())
    }
    fn blob(&self, oid: &str, b: &mut Budget) -> Result<Vec<u8>> {
        let size = self.run(&["cat-file", "-s", oid], &[], b)?;
        let size: usize = std::str::from_utf8(&size)?.trim().parse()?;
        ensure!(size <= FILE, "limit: Git blob exceeds 16 MiB");
        b.bytes(size)?;
        let data = self.run(&["cat-file", "blob", oid], &[], b)?;
        ensure!(data.len() == size, "unstable: Git blob size changed"); Ok(data)
    }
}
fn valid_oid(s: &str) -> Result<()> { ensure!(matches!(s.len(), 40 | 64) && s.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "unsupported: expected full lowercase 40/64-digit object ID"); Ok(()) }
fn line(data: &[u8]) -> Result<&str> { let s = std::str::from_utf8(data).context("unsupported: non-UTF8 Git metadata")?; Ok(s.strip_suffix('\n').unwrap_or(s)) }
fn git_path(parent: &Path, value: &str) -> Result<PathBuf> { absolute(&parent.join(value)) }
fn metadata(root: &Path, b: &mut Budget) -> Result<(PathBuf, PathBuf)> {
    let dir = directory(root)?;
    let st = stat(&dir, ".git")?;
    let admin = if st.st_mode & libc::S_IFMT == libc::S_IFDIR { root.join(".git") } else {
        let data = read_file(open_at(&dir, OsStr::new(".git"), false)?, b)?;
        git_path(root, line(&data)?.strip_prefix("gitdir: ").context("unsupported: malformed .git pointer")?)?
    };
    let fd = directory(&admin)?;
    let common = match optional_file(&fd, "commondir", b)? { Some(v) => git_path(&admin, line(&v)?)?, None => admin.clone() };
    directory(&common)?; Ok((admin, common))
}
fn check_metadata(dir: &File, b: &mut Budget) -> Result<()> {
    for name in names(dir, b)? {
        ensure!(!name.ends_with(".lock"), "busy: Git metadata lock sentinel {name}");
    }
    for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"] {
        match stat(dir, name) { Ok(_) => bail!("busy: unfinished Git operation {name}"), Err(e) if e.to_string().starts_with("missing:") => {}, Err(e) => return Err(e) }
    }
    Ok(())
}
fn object_safety(dir: &File, b: &mut Budget, depth: usize) -> Result<()> {
    ensure!(depth <= 64, "limit: metadata depth");
    for name in names(dir, b)? {
        let st = stat(dir, &name)?;
        match st.st_mode & libc::S_IFMT {
            libc::S_IFDIR => object_safety(&open_at(dir, OsStr::new(&name), true)?, b, depth+1)?,
            libc::S_IFREG => {
                ensure!(!name.ends_with(".lock"), "busy: metadata lock sentinel {name}");
                ensure!(name != "alternates" && name != "http-alternates", "unsupported: Git object alternates");
            },
            _ => bail!("unsupported: symlink/special Git object metadata"),
        }
    }
    Ok(())
}
fn head(admin: &File, common_path: &Path, b: &mut Budget) -> Result<String> {
    let data = optional_file(admin, "HEAD", b)?.context("missing: HEAD")?;
    let s = line(&data)?;
    if !s.starts_with("ref: ") { valid_oid(s)?; return Ok(s.to_owned()); }
    let r = s.strip_prefix("ref: ").unwrap();
    ensure!(r.starts_with("refs/heads/") && Path::new(r).components().all(|c| matches!(c, Component::Normal(_))), "unsupported: symbolic HEAD target");
    let path = common_path.join(r);
    let parent = directory(path.parent().unwrap());
    if let Ok(parent) = parent.as_ref() {
        if let Some(data) = optional_file(parent, path.file_name().unwrap().to_str().unwrap(), b)? { let s = line(&data)?; valid_oid(s)?; return Ok(s.to_owned()); }
    } else if !parent.as_ref().unwrap_err().to_string().starts_with("missing:") { return Err(parent.unwrap_err()); }
    let common = directory(common_path)?;
    if let Some(packed) = optional_file(&common, "packed-refs", b)? {
        for l in std::str::from_utf8(&packed)?.lines() { if let Some((oid, name)) = l.split_once(' ') { if name == r { valid_oid(oid)?; return Ok(oid.to_owned()); } } }
    }
    bail!("missing: HEAD ref")
}
fn entry(mode: &str, oid: String, bytes: &[u8]) -> Entry {
    let binary = bytes.contains(&0) || std::str::from_utf8(bytes).is_err();
    Entry { mode: mode.into(), oid, size: bytes.len(), binary,
        text: if !binary && bytes.len() <= TEXT { Some(String::from_utf8(bytes.to_vec()).unwrap()) } else { None } }
}
// Git selects tracked + nonignored untracked paths with a disposable index.
// This never refreshes/stages the real index. Ignore rules affect selection only.
fn selected(git: &Git, root: &Path, index: Option<&[u8]>, common: &File, b: &mut Budget) -> Result<(Vec<String>,Tree)> {
    if let Some(index) = index { fs::write(git.scratch.0.join("index"), index)?; }
    if let Ok(info) = open_at(common, OsStr::new("info"), true) {
        if let Some(exclude) = optional_file(&info, "exclude", b)? {
            fs::create_dir(git.scratch.0.join("info"))?;
            fs::write(git.scratch.0.join("info/exclude"), exclude)?;
        }
    } else {
        match stat(common, "info") { Err(e) if e.to_string().starts_with("missing:") => {}, Err(e) => return Err(e), Ok(_) => bail!("unsupported: symlink/special Git info directory") }
    }
    let mut paths = Vec::new();
    let mut index_tree=Tree::new();
        let mut cmd = command();
        cmd.arg("--git-dir").arg(&git.scratch.0).arg("--work-tree").arg(root)
            .env("GIT_OBJECT_DIRECTORY", &git.objects)
            .args(["-c", "core.bare=false", "-c", "core.excludesFile=/dev/null", "ls-files", "--full-name", "-z"]);
        cmd.args(["--cached", "--stage"]);
        let data = execute(cmd, &[], b)?;
        ensure!(data.is_empty() || data.ends_with(&[0]), "git: incomplete ls-files listing");
        for raw in data.split(|c| *c == 0).filter(|s| !s.is_empty()) {
            let tab = raw.iter().position(|c| *c == b'\t').context("git: malformed index entry")?;
            let fields: Vec<_> = std::str::from_utf8(&raw[..tab])?.split(' ').collect();
            ensure!(fields.len() == 3 && matches!(fields[0], "100644" | "100755" | "120000") && fields[2] == "0",
                "unsupported: gitlink/submodule/unmerged/sparse index entry");
            valid_oid(fields[1])?;
            ensure!(fields[1].bytes().any(|byte|byte!=b'0'),"unsupported: intent-to-add index entry; stage content before capture");
            let path = std::str::from_utf8(&raw[tab+1..]).context("unsupported: non-UTF8 selected path")?;
            safe_path(path)?;
            index_tree.insert(path.to_owned(),Entry{mode:fields[0].into(),oid:fields[1].into(),size:0,binary:false,text:None});
            paths.push(path.to_owned());
            ensure!(paths.len() <= FILES * 4, "limit: selected index entries exceed bound");
        }
    discover(git, root, &directory(root)?, "", 0, &mut paths, b)?;
    paths.sort(); paths.dedup();
    ensure!(paths.len() <= FILES, "limit: more than 2048 selected files");
    Ok((paths,index_tree))
}
// ls-files intentionally omits untracked FIFO/socket/device files. Enumerate
// nonignored directories ourselves so unsupported content cannot disappear from
// evidence. check-ignore only selects paths; it never opens their content.
fn discover(git: &Git, root: &Path, dir: &File, prefix: &str, depth: usize, paths: &mut Vec<String>, b: &mut Budget) -> Result<()> {
    ensure!(depth <= 64, "limit: worktree directory depth");
    let mut entries = Vec::new(); let mut input = Vec::new();
    for name in names(dir, b)? {
        if name == ".git" { ensure!(prefix.is_empty(), "unsupported: nested repository/submodule"); continue; }
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        safe_path(&path)?;
        let st = stat(dir, &name)?;
        let directory = st.st_mode & libc::S_IFMT == libc::S_IFDIR;
        let query = if directory { format!("{path}/") } else { path.clone() };
        input.extend_from_slice(query.as_bytes()); input.push(0);
        entries.push((name, path, query, directory));
    }
    if entries.is_empty() { return Ok(()); }
    let mut cmd = command();
    cmd.arg("--git-dir").arg(&git.scratch.0).arg("--work-tree").arg(root)
        .env("GIT_OBJECT_DIRECTORY", &git.objects)
        .args(["-c", "core.bare=false", "-c", "core.excludesFile=/dev/null", "check-ignore", "--stdin", "-z"]);
    let ignored = execute_codes(cmd, &input, b, true)?;
    ensure!(ignored.is_empty() || ignored.ends_with(&[0]), "git: incomplete check-ignore response");
    let ignored: std::collections::BTreeSet<&[u8]> = ignored.split(|c| *c == 0).filter(|s| !s.is_empty()).collect();
    for (name, path, query, is_dir) in entries {
        if ignored.contains(query.as_bytes()) { continue; }
        if is_dir { discover(git, root, &open_at(dir, OsStr::new(&name), true)?, &path, depth+1, paths, b)?; }
        else { paths.push(path); ensure!(paths.len() <= FILES * 4, "limit: selected path count"); }
    }
    Ok(())
}
fn safe_path(path: &str) -> Result<()> {
    ensure!(!path.is_empty() && path.len() <= 4096 && !path.starts_with('/') && !path.ends_with('/')
        && path.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && p != ".git")
        && path.split('/').count() <= 64, "unsupported: unsafe/nested repository/oversized path");
    Ok(())
}
fn working_entry(root: &File, path: &str, git: &Git, b: &mut Budget) -> Result<Option<Entry>> {
    safe_path(path)?;
    let parts: Vec<_> = path.split('/').collect();
    let mut dir = root.try_clone()?;
    for name in &parts[..parts.len()-1] {
        let st = match stat(&dir, name) { Ok(st) => st, Err(e) if e.to_string().starts_with("missing:") => return Ok(None), Err(e) => return Err(e) };
        // A former directory replaced by a file/link deletes its old descendants.
        if st.st_mode & libc::S_IFMT != libc::S_IFDIR { return Ok(None); }
        dir = open_at(&dir, OsStr::new(name), true)?;
        ensure!(stat(&dir, ".git").is_err_and(|e| e.to_string().starts_with("missing:")), "unsupported: nested repository/submodule");
    }
    let name = parts.last().unwrap();
    let st = match stat(&dir, name) { Ok(st) => st, Err(e) if e.to_string().starts_with("missing:") => return Ok(None), Err(e) => return Err(e) };
    let (mode, data) = match st.st_mode & libc::S_IFMT {
        libc::S_IFDIR => {
            let fd = open_at(&dir, OsStr::new(name), true)?;
            ensure!(stat(&fd, ".git").is_err_and(|e| e.to_string().starts_with("missing:")), "unsupported: nested repository/submodule");
            return Ok(None);
        },
        libc::S_IFREG => {
            let f = open_at(&dir, OsStr::new(name), false)?;
            let mode = if f.metadata()?.mode() & 0o111 != 0 { "100755" } else { "100644" };
            (mode, read_file(f, b)?)
        },
        libc::S_IFLNK => {
            let mut data = vec![0; 4097]; let n = cstr(OsStr::new(name))?;
            let len = unsafe { libc::readlinkat(dir.as_raw_fd(), n.as_ptr(), data.as_mut_ptr().cast(), data.len()) };
            ensure!(len >= 0, "io: readlinkat failed"); ensure!((len as usize) < data.len(), "limit: symlink length");
            data.truncate(len as usize); b.bytes(data.len())?; ("120000", data)
        },
        _ => bail!("unsupported: special file at {path:?}"),
    };
    Ok(Some(entry(mode, git.hash(&data, b)?, &data)))
}
fn tree(git: &Git, commit: &str, b: &mut Budget) -> Result<Tree> {
    let kind = git.run(&["cat-file", "-t", commit], &[], b).map_err(|e| {
        if e.to_string().starts_with("git: command failed:") { anyhow::anyhow!("missing: commit {commit}: {e}") } else { e }
    })?;
    ensure!(kind == b"commit\n", "unsupported: base/HEAD must be commits");
    let raw = git.run(&["ls-tree", "-r", "-z", "--full-tree", "-l", commit], &[], b)?;
    ensure!(raw.is_empty() || raw.ends_with(&[0]), "git: incomplete tree output");
    let mut tree = Tree::new();
    for row in raw.split(|c| *c == 0).filter(|r| !r.is_empty()) {
        b.check()?;
        ensure!(tree.len() < FILES, "limit: base/HEAD exceeds 2048 files");
        let tab = row.iter().position(|c| *c == b'\t').context("git: malformed tree")?;
        let fields: Vec<_> = std::str::from_utf8(&row[..tab])?.split_ascii_whitespace().collect();
        ensure!(fields.len() == 4 && fields[1] == "blob" && matches!(fields[0], "100644" | "100755" | "120000"), "unsupported: gitlink/submodule/tree mode");
        valid_oid(fields[2])?;
        let name = std::str::from_utf8(&row[tab+1..]).context("unsupported: non-UTF8 tree path")?;
        ensure!(name.len() <= 4096 && !name.is_empty() && Path::new(name).components().all(|c| matches!(c, Component::Normal(_)))
            && !name.split('/').any(|s| s == ".git"), "unsupported: unsafe tree path");
        let size: usize = fields[3].parse()?; ensure!(size <= FILE, "limit: base/HEAD blob exceeds 16 MiB");
        tree.insert(name.into(), Entry { mode: fields[0].into(), oid: fields[2].into(), size, binary: false, text: None });
    }
    Ok(tree)
}
fn identity(e: &Entry) -> Value { json!({"mode":e.mode,"oid":e.oid,"bytes":e.size}) }
fn render(git: &Git, base: &Tree, after: &Tree, load_after: bool, b: &mut Budget, preview: &mut usize) -> Result<(Vec<Value>, String)> {
    let mut paths: Vec<_> = base.keys().chain(after.keys()).collect(); paths.sort(); paths.dedup();
    let mut files = Vec::new(); let mut diff = String::new();
    for path in paths {
        let old = base.get(path); let new = after.get(path);
        if old.zip(new).is_some_and(|(a,z)| a.mode == z.mode && a.oid == z.oid) { continue; }
        let mut old = old.cloned(); let mut new = new.cloned();
        if let Some(e) = old.as_mut() { let bytes = git.blob(&e.oid, b)?; *e = entry(&e.mode, e.oid.clone(), &bytes); }
        if load_after { if let Some(e) = new.as_mut() { let bytes = git.blob(&e.oid, b)?; *e = entry(&e.mode, e.oid.clone(), &bytes); } }
        let binary = old.as_ref().is_some_and(|e| e.binary) || new.as_ref().is_some_and(|e| e.binary);
        let large = old.as_ref().is_some_and(|e| e.size > TEXT) || new.as_ref().is_some_and(|e| e.size > TEXT);
        let status = if old.is_none() { "added" } else if new.is_none() { "deleted" } else { "modified" };
        let mut patch = format!("--- {}\n+++ {}\n", serde_json::to_string(&format!("before/{path}"))?, serde_json::to_string(&format!("after/{path}"))?);
        if old.as_ref().map(|e| &e.mode) != new.as_ref().map(|e| &e.mode) {
            patch.push_str(&format!("mode {} -> {}\n", old.as_ref().map_or("missing", |e| e.mode.as_str()), new.as_ref().map_or("missing", |e| e.mode.as_str())));
        }
        let mut omission = if binary { Some("binary") } else if large { Some("large") } else { None };
        if omission.is_none() {
            for (prefix, e) in [('-', &old), ('+', &new)] { if let Some(e) = e { if let Some(text) = &e.text {
                for l in text.split_inclusive('\n') {
                    // Escape terminal controls; keep readable Unicode and ordinary tabs.
                    patch.push(prefix);
                    for ch in l.chars() { if ch.is_control() && ch != '\n' && ch != '\t' { patch.extend(ch.escape_default()); } else { patch.push(ch); } }
                    if !l.ends_with('\n') { patch.push_str("\n\\ No newline at end of file\n"); }
                }
            } } }
        }
        if *preview + patch.len() > PREVIEW { omission = Some("preview_budget"); }
        if let Some(reason) = omission { patch = format!("[{}: {reason}; content identity retained]\n", serde_json::to_string(path)?); }
        if *preview + patch.len() <= PREVIEW { *preview += patch.len(); diff.push_str(&patch); }
        files.push(json!({"path":path,"status":status,"before":old.as_ref().map(identity),"after":new.as_ref().map(identity),"binary":binary,"large":large,"preview_omitted":omission}));
    }
    Ok((files, diff))
}
fn validate_index(data: &[u8], oid_bytes: usize) -> Result<()> {
    let number = |at: usize| -> Result<usize> {
        let bytes: [u8; 4] = data.get(at..at+4).context("unsupported: truncated index")?.try_into()?;
        Ok(u32::from_be_bytes(bytes) as usize)
    };
    ensure!(data.starts_with(b"DIRC") && data.len() >= 12 + oid_bytes, "unsupported: malformed index");
    let version = number(4)?; ensure!(matches!(version, 2..=4), "unsupported: index version");
    let count = number(8)?; ensure!(count <= FILES * 4, "limit: index entry count");
    let end = data.len() - oid_bytes;
    let mut at = 12;
    for _ in 0..count {
        let start = at;
        let flags_at = at + 40 + oid_bytes;
        let flags = data.get(flags_at..flags_at+2).context("unsupported: truncated index flags")?;
        if flags[0] & 0x40 != 0 {
            let extra=data.get(flags_at+2..flags_at+4).context("unsupported: truncated extended index flags")?;
            let extra=u16::from_be_bytes([extra[0],extra[1]]);
            ensure!(extra & 0x6000==0,"unsupported: skip-worktree/sparse or intent-to-add index entry");
        }
        at = flags_at + 2 + if flags[0] & 0x40 != 0 { 2 } else { 0 };
        if version == 4 {
            for i in 0..10 {
                let byte = *data.get(at).context("unsupported: truncated index prefix")?; at += 1;
                if byte & 0x80 == 0 { break; }
                ensure!(i < 9, "unsupported: oversized index prefix");
            }
        }
        let nul = data.get(at..end).context("unsupported: index bounds")?.iter().position(|c| *c == 0).context("unsupported: unterminated index path")?;
        at += nul + 1;
        if version != 4 { at = start + (at - start).div_ceil(8) * 8; }
        ensure!(at <= end, "unsupported: index entry exceeds bounds");
    }
    while at < end {
        let name = data.get(at..at+4).context("unsupported: truncated index extension")?;
        ensure!(name != b"link" && name != b"sdir", "unsupported: split/sparse index extension");
        let size = number(at+4)?;
        at = at.checked_add(8).and_then(|p| p.checked_add(size)).context("unsupported: index extension overflow")?;
        ensure!(at <= end, "unsupported: index extension exceeds bounds");
    }
    Ok(())
}
struct Pass { manifest: Value, value: Value }
fn once(root: &Path, base: &str, end: Instant) -> Result<Pass> {
    let mut b = Budget { end, bytes: 0, entries: 0 };
    let (admin_path, common_path) = metadata(root, &mut b)?;
    let admin = directory(&admin_path)?; let common = directory(&common_path)?;
    check_metadata(&admin, &mut b)?; if admin_path != common_path { check_metadata(&common, &mut b)?; }
    let config = optional_file(&common, "config", &mut b)?.context("missing: Git config")?;
    let mut cmd = command(); cmd.args(["config", "--no-includes", "--file", "-", "--null", "--list"]);
    let parsed = execute(cmd, &config, &b)?;
    let mut format = "sha1".to_owned();
    for row in parsed.split(|c| *c == 0).filter(|s| !s.is_empty()) {
        let (key, value) = std::str::from_utf8(row)?.split_once('\n').unwrap_or((std::str::from_utf8(row)?, ""));
        if key == "extensions.objectformat" { ensure!(matches!(value, "sha1" | "sha256"), "unsupported: object format"); format = value.into(); }
        if key.starts_with("extensions.") { ensure!(matches!(key, "extensions.objectformat" | "extensions.worktreeconfig" | "extensions.preciousobjects"), "unsupported: Git repository extension {key}"); }
    }
    ensure!(base.len() == if format == "sha256" {64} else {40}, "unsupported: base hash format mismatch");
    if let Ok(refs) = open_at(&common, OsStr::new("refs"), true) { object_safety(&refs, &mut b, 0)?; }
    let objects = common_path.join("objects"); object_safety(&directory(&objects)?, &mut b, 0)?;
    let git = Git { scratch: Scratch::new(&format)?, objects, format };
    let head = head(&admin, &common_path, &mut b)?;
    let index = optional_file(&admin, "index", &mut b)?;
    if let Some(index) = &index { validate_index(index, if git.format == "sha256" {32} else {20})?; }
    let index_hash = index.as_ref().map(|bytes| git.hash(bytes, &b)).transpose()?;
    let base_tree = tree(&git, base, &mut b)?; let head_tree = tree(&git, &head, &mut b)?;
    let (mut paths,index_tree) = selected(&git, root, index.as_deref(), &common, &mut b)?;
    paths.extend(base_tree.keys().cloned()); paths.extend(head_tree.keys().cloned());
    paths.sort(); paths.dedup();
    ensure!(paths.len() <= FILES, "limit: selected/base/HEAD union exceeds 2048 files");
    let root_fd = directory(root)?;
    let mut working = Tree::new();
    for path in paths { b.check()?; if let Some(e) = working_entry(&root_fd, &path, &git, &mut b)? { working.insert(path, e); } }
    let manifest = json!({"schema":"aw.snapshot.manifest.v1","object_format":git.format,"base":base,"head":head,"index":index_hash,
        "files":working.iter().map(|(path,e)| json!({"path":path,"entry":identity(e)})).collect::<Vec<_>>()});
    let fingerprint = format!("git-blob:{}:{}", git.format, git.hash(&serde_json::to_vec(&manifest)?, &b)?);
    let mut preview = 0;
    let (files, diff) = render(&git, &base_tree, &working, false, &mut b, &mut preview)?;
    let (staged_files, staged_diff)=render(&git,&head_tree,&index_tree,true,&mut b,&mut preview)?;
    let (unstaged_files, unstaged_diff)=render(&git,&index_tree,&working,false,&mut b,&mut preview)?;
    let (head_files, head_diff) = render(&git, &base_tree, &head_tree, true, &mut b, &mut preview)?;
    let (local_files, local_diff) = render(&git, &head_tree, &working, false, &mut b, &mut preview)?;
    // Recheck sentinels after traversal; a lock at either boundary is refused.
    check_metadata(&admin, &mut b)?; check_metadata(&common, &mut b)?; b.check()?;
    Ok(Pass { manifest, value: json!({"schema":"aw.snapshot.v1","fingerprint":fingerprint,"base":base,"head":head,"object_format":git.format,
        "index_fingerprint":index_hash,"files":files,"diff":diff,"head_files":head_files,"head_diff":head_diff,"local_files":local_files,"local_diff":local_diff,"staged_files":staged_files,"staged_diff":staged_diff,"unstaged_files":unstaged_files,"unstaged_diff":unstaged_diff,
        "file_count":working.len(),"ignored_files":"excluded","verification_context":"ignored files/dependencies are outside fingerprint","submodules":"unsupported","stability":"double_capture_content","atomic":false,
        "diff_format":"escaped-full-before-after-v1"}) })
}

/// Capture complete content evidence or fail; never returns a partial fingerprint.
/// Root must be the worktree root, absolute and free of directory symlinks.
/// Base is a pinned full lowercase commit OID, never a ref or revision expression.
pub fn capture(root: &Path, base: &str) -> Result<Value> {
    valid_oid(base)?; let root = absolute(root)?;
    let end = Instant::now() + Duration::from_secs(45);
    capture_twice(&root, base, end, || {}).map_err(|e| {
        let message = e.to_string();
        if ["missing:", "unsupported:", "limit:", "deadline:", "unstable:", "busy:", "git:", "io:"].iter().any(|p| message.starts_with(p)) { e }
        else { e.context("io: snapshot capture failed") }
    })
}
fn capture_twice(root: &Path, base: &str, end: Instant, between: impl FnOnce()) -> Result<Value> {
    let first = once(root, base, end)?;
    between();
    let second = once(root, base, end)?;
    ensure!(first.manifest == second.manifest && first.value == second.value, "unstable: content/HEAD/index changed between captures; retry with writer stopped");
    Ok(second.value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Fixture { _temp: tempfile::TempDir, root: PathBuf, base: String }
    fn g(root: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("/usr/bin/git").current_dir(root).env_clear()
            .env("PATH", "/usr/bin:/bin").env("HOME", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null"])
            .args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr)); out.stdout
    }
    impl Fixture {
        fn new(format: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            // macOS temp directories may have a symlinked /var ancestor. The
            // public contract requires the actual, nonsymlinked absolute root.
            let root = fs::canonicalize(temp.path()).unwrap().join("répo space");
            fs::create_dir(&root).unwrap();
            g(&root, &["init", "-q", &format!("--object-format={format}")]);
            fs::write(root.join("tracked"), "base\n").unwrap();
            fs::write(root.join("deleted"), "gone\n").unwrap();
            g(&root, &["add", "."]); g(&root, &["commit", "-qm", "base"]);
            let base = String::from_utf8(g(&root, &["rev-parse", "HEAD"])).unwrap().trim().into();
            Self { _temp: temp, root, base }
        }
        fn capture(&self) -> Value { capture(&self.root, &self.base).unwrap() }
    }
    fn file<'a>(s: &'a Value, path: &str) -> &'a Value { s["files"].as_array().unwrap().iter().find(|e| e["path"] == path).unwrap() }
    #[test]
    fn snapshots_content_modes_deleted_unicode_binary_large_and_readonly() {
        let f = Fixture::new("sha1");
        fs::write(f.root.join("hyperlink"), "ordinary tracked name\n").unwrap();
        g(&f.root, &["add", "hyperlink"]);
        let index = fs::read(f.root.join(".git/index")).unwrap();
        let objects = g(&f.root, &["count-objects", "-v"]);
        fs::write(f.root.join("tracked"), "changed\n\u{1b}[31mtext\n").unwrap();
        fs::remove_file(f.root.join("deleted")).unwrap();
        fs::write(f.root.join("nuevo ñ space"), "new\n").unwrap();
        fs::write(f.root.join("binary"), [0,1,2,255]).unwrap();
        fs::write(f.root.join("large"), vec![b'x'; TEXT+1]).unwrap();
        fs::set_permissions(f.root.join("nuevo ñ space"), fs::Permissions::from_mode(0o755)).unwrap();
        let a = f.capture(); let b = f.capture();
        assert_eq!(a, b); assert!(a["fingerprint"].as_str().unwrap().starts_with("git-blob:sha1:"));
        assert_eq!(file(&a,"deleted")["status"], "deleted");
        assert_eq!(file(&a,"nuevo ñ space")["after"]["mode"], "100755");
        assert_eq!(file(&a,"binary")["preview_omitted"], "binary");
        assert_eq!(file(&a,"large")["preview_omitted"], "large");
        assert!(!a["diff"].as_str().unwrap().contains('\u{1b}'));
        assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
        assert_eq!(g(&f.root, &["count-objects", "-v"]), objects);
        fs::write(f.root.join("binary"), [0,1,3,255]).unwrap();
        assert_ne!(a["fingerprint"], f.capture()["fingerprint"]);
        fs::write(f.root.join("large"), vec![b'y'; TEXT+1]).unwrap();
        assert_ne!(b["fingerprint"], f.capture()["fingerprint"]);
    }
    #[test]
    fn snapshots_agent_commits_and_index_only_changes_invalidate() {
        let f = Fixture::new("sha1"); let a = f.capture();
        fs::write(f.root.join("tracked"), "agent commit\n").unwrap();
        g(&f.root, &["add", "tracked"]); g(&f.root, &["commit", "-qm", "agent"]);
        let b = f.capture();
        assert!(b["head_diff"].as_str().unwrap().contains("agent commit"));
        assert_eq!(b["local_diff"], "");
        assert_ne!(a["head"], b["head"]); assert_ne!(a["fingerprint"], b["fingerprint"]);
        assert!(b["head_diff"].as_str().unwrap().contains("agent commit"));
        assert!(b["diff"].as_str().unwrap().contains("agent commit"));
        fs::write(f.root.join("tracked"), "staged content\n").unwrap(); g(&f.root, &["add", "tracked"]);
        fs::write(f.root.join("tracked"), "agent commit\n").unwrap();
        let c = f.capture();
        assert_eq!(b["files"], c["files"]); assert_ne!(b["fingerprint"], c["fingerprint"]);
        assert_ne!(b["index_fingerprint"], c["index_fingerprint"]);
        assert!(c["staged_diff"].as_str().unwrap().contains("+staged content"));
        assert!(c["unstaged_diff"].as_str().unwrap().contains("-staged content"));
        assert!(c["unstaged_diff"].as_str().unwrap().contains("+agent commit"));
        assert_eq!(c["local_diff"],"");
    }
    #[test]
    fn skip_worktree_and_intent_to_add_are_explicitly_unsupported() {
        let f=Fixture::new("sha1");
        g(&f.root,&["update-index","--skip-worktree","tracked"]);
        fs::remove_file(f.root.join("tracked")).unwrap();
        assert!(capture(&f.root,&f.base).unwrap_err().to_string().contains("unsupported:"));
        g(&f.root,&["update-index","--no-skip-worktree","tracked"]);
        fs::write(f.root.join("tracked"),"base\n").unwrap();
        fs::write(f.root.join("intent"),"not staged yet\n").unwrap();g(&f.root,&["add","-N","intent"]);
        assert!(capture(&f.root,&f.base).unwrap_err().to_string().contains("unsupported:"));
    }
    #[test]
    fn snapshots_ignored_dependencies_and_secrets_excluded_tracked_retained() {
        let f = Fixture::new("sha1");
        fs::write(f.root.join(".gitignore"), "node_modules/\n.env\ntracked\n").unwrap();
        fs::create_dir(f.root.join("node_modules")).unwrap();
        for i in 0..2200 { fs::write(f.root.join(format!("node_modules/{i}")), "dep").unwrap(); }
        fs::write(f.root.join(".env"), "TOP_SECRET=never-preview").unwrap();
        fs::write(f.root.join("tracked"), "tracked despite ignore\n").unwrap();
        let a = f.capture();
        assert_eq!(a["ignored_files"], "excluded");
        assert!(!a.to_string().contains("TOP_SECRET"));
        assert!(!a["files"].as_array().unwrap().iter().any(|v| v["path"] == ".env"));
        assert!(a["diff"].as_str().unwrap().contains("tracked despite ignore"));
        fs::write(f.root.join(".env"), "changed secret").unwrap();
        fs::write(f.root.join("node_modules/0"), "changed dep").unwrap();
        assert_eq!(a["fingerprint"], f.capture()["fingerprint"]);
    }
    #[test]
    fn snapshots_symlinks_are_content_never_traversed() {
        let f = Fixture::new("sha1");
        let outside = f._temp.path().join("outside"); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), "do not read").unwrap();
        symlink(&outside, f.root.join("link")).unwrap();
        let a = f.capture();
        assert_eq!(file(&a,"link")["after"]["mode"], "120000");
        assert!(!a.to_string().contains("do not read"));
        fs::write(outside.join("secret"), "changed outside").unwrap();
        assert_eq!(a["fingerprint"], f.capture()["fingerprint"]);
        let alias = f._temp.path().join("alias"); symlink(&f.root, &alias).unwrap();
        assert!(capture(&alias, &f.base).is_err());
    }
    #[test]
    fn snapshots_limits_missing_unsupported_and_locks_fail_closed() {
        let f = Fixture::new("sha1");
        let err = capture(&f.root.join("missing"), &f.base).unwrap_err(); assert!(err.to_string().starts_with("missing:"), "{err:#}");
        let err = capture(&f.root, &"0".repeat(40)).unwrap_err(); assert!(err.to_string().starts_with("missing:"), "{err:#}");
        let lock = f.root.join(".git/index.lock"); fs::write(&lock, "external writer").unwrap();
        assert!(f.capture_error().starts_with("busy:")); assert_eq!(fs::read(&lock).unwrap(), b"external writer");
        fs::remove_file(lock).unwrap(); // fixture-owned lock only
        let big = File::create(f.root.join("oversized")).unwrap(); big.set_len(FILE as u64+1).unwrap();
        assert!(f.capture_error().starts_with("limit:")); fs::remove_file(f.root.join("oversized")).unwrap();
        g(&f.root, &["update-index", "--add", "--cacheinfo", &format!("160000,{},submodule", f.base)]);
        assert!(f.capture_error().starts_with("unsupported:"));
    }
    impl Fixture { fn capture_error(&self) -> String { capture(&self.root, &self.base).unwrap_err().to_string() } }
    #[test]
    fn snapshots_config_filters_hooks_external_includes_never_loaded() {
        let f = Fixture::new("sha1"); let sentinel = f._temp.path().join("executed");
        // If loaded, this malformed include makes every normal Git invocation fail.
        let bad = f._temp.path().join("malformed-config"); fs::write(&bad,"[broken\n").unwrap();
        let mut config = fs::OpenOptions::new().append(true).open(f.root.join(".git/config")).unwrap();
        writeln!(config,"[include]\npath = {}\n[core]\nfsmonitor = touch {}\n[filter \"evil\"]\nclean = touch {}\n[diff]\nexternal = touch {}",bad.display(),sentinel.display(),sentinel.display(),sentinel.display()).unwrap();
        fs::write(f.root.join(".gitattributes"),"* filter=evil diff=evil\n").unwrap();
        fs::write(f.root.join("tracked"),"changed\n").unwrap();
        assert!(f.capture()["diff"].as_str().unwrap().contains("changed")); assert!(!sentinel.exists());
    }
    #[test]
    fn snapshots_sha256_linked_worktree_and_packed_refs() {
        let f = Fixture::new("sha256"); let linked = fs::canonicalize(f._temp.path()).unwrap().join("linked");
        g(&f.root, &["worktree", "add", "-qb", "task", linked.to_str().unwrap()]);
        g(&f.root, &["pack-refs", "--all"]);
        fs::write(linked.join("tracked"),"linked\n").unwrap();
        let a = capture(&linked, &f.base).unwrap();
        assert!(a["fingerprint"].as_str().unwrap().starts_with("git-blob:sha256:"));
        assert!(a["diff"].as_str().unwrap().contains("linked"));
    }
    #[test]
    fn snapshots_split_index_is_rejected_and_index_v4_is_supported() {
        let f = Fixture::new("sha1");
        g(&f.root, &["update-index", "--index-version=4"]);
        f.capture();
        g(&f.root, &["update-index", "--split-index"]);
        assert!(f.capture_error().starts_with("unsupported:"));
    }
    #[test]
    fn snapshots_preview_limit_is_explicit_and_does_not_truncate_identity() {
        let f = Fixture::new("sha1");
        for i in 0..32 { fs::write(f.root.join(format!("text-{i:02}")), "line\n".repeat(2400)).unwrap(); }
        let a = f.capture();
        assert!(a["diff"].as_str().unwrap().len() + a["head_diff"].as_str().unwrap().len() <= PREVIEW);
        assert_eq!(file(&a,"text-31")["preview_omitted"], "preview_budget");
        fs::write(f.root.join("text-31"), "other\n".repeat(2400)).unwrap();
        assert_ne!(a["fingerprint"], f.capture()["fingerprint"]);
    }
    #[test]
    fn snapshots_nonutf8_special_files_and_file_count_are_explicit_errors() {
        let f = Fixture::new("sha1");
        let odd = f.root.join(std::ffi::OsString::from_vec(vec![0xff]));
        assert!(capture(&odd, &f.base).unwrap_err().to_string().starts_with("unsupported:"));
        // APFS rejects invalid UTF-8 names at creation (EILSEQ); Linux can
        // additionally exercise rejection of a non-UTF8 ls-files result.
        #[cfg(not(target_os = "macos"))]
        { fs::write(&odd, "x").unwrap(); assert!(f.capture_error().starts_with("unsupported:")); fs::remove_file(odd).unwrap(); }
        let fifo = cstr(f.root.join("fifo").as_os_str()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(f.capture_error().starts_with("unsupported:")); fs::remove_file(f.root.join("fifo")).unwrap();
        for i in 0..FILES { fs::write(f.root.join(format!("file-{i}")), "x").unwrap(); }
        assert!(f.capture_error().starts_with("limit:"));
    }
    #[test]
    fn snapshots_deadline_and_stability_compare_content() {
        let f = Fixture::new("sha1");
        let err = once(&f.root, &f.base, Instant::now()).err().unwrap(); assert!(err.to_string().starts_with("deadline:"));
        let end = Instant::now()+Duration::from_secs(45);
        let a = once(&f.root, &f.base, end).unwrap();
        // Same byte count; content identity must change regardless of timestamps.
        fs::write(f.root.join("tracked"),"evil\n").unwrap();
        let z = once(&f.root, &f.base, end).unwrap(); assert_ne!(a.manifest, z.manifest);
        let error = capture_twice(&f.root, &f.base, end, || { fs::write(f.root.join("tracked"), "new!\n").unwrap(); }).unwrap_err();
        assert!(error.to_string().starts_with("unstable:"), "{error:#}");
    }
}

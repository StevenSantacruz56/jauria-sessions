//! Execution primitive, NOT an authorization boundary. The caller MUST first
//! durably persist the approved request and obtain native human confirmation of
//! this exact argv and cwd. Do not call while holding runner/ledger/global locks.
//! No ledger, UI, command discovery, shell selection, or retry lives here.
//!
//! argv[0] and cwd must be absolute; argv (including NUL terminators) <=16 KiB.
//! We execute the supplied binary and arguments literally. An explicitly approved
//! `/bin/zsh -f -c ...` is allowed; no shell is ever inserted. HOME/USER come from
//! the effective user's passwd entry, never inherited environment; PATH is a controlled local-tool search path, never inherited.
//! This is environment hygiene, NOT a filesystem/network/credential sandbox:
//! the program can read the user's files, including credentials, and change cwd.
//!
//! Output is a combined 512 KiB of raw bytes, decoded lossily in the JSON result
//! (UTF-8 replacement/JSON escaping can expand its serialized size). `truncated`
//! also covers pipes closed before EOF. Deadline is 45s INCLUDING a reserved
//! cleanup window. SIGTERM then SIGKILL target ONLY the new owned process group;
//! WNOWAIT pins the leader's PID until all group signals and SID inventory finish.
//! No discovered PID is signalled. Live same-SID survivors / inspection errors
//! override the outcome to `uncertain`. Inventory is observational and racy;
//! descendants which create another SID cannot be contained or reliably detected.
//! A passed result means exit zero and no observed cleanup problem, NOT proof of
//! absence of escaped descendants or of side effects. No rollback is attempted.
//!
//! Invalid input returns Err; failed spawn/exec returns failed + spawned:false,
//! after std reaps child-side setup without running the requested command. No
//! automatic retry. Post-spawn supervision errors return an `uncertain` result
//! after cleanup. Always finally wait/reap. Like any synchronous Unix supervisor,
//! an uninterruptible kernel task can make that final wait exceed the deadline;
//! synchronous identity lookup, spawn, inventory and scheduling can also overrun.
//! no strict wall-clock bound and unconditional reaping can both be guaranteed.
//! Requires exclusive wait ownership (no external SIGCHLD reaper / SA_NOCLDWAIT).

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    os::{fd::AsRawFd, unix::{ffi::OsStrExt, fs::{MetadataExt,OpenOptionsExt}, process::CommandExt}},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 512 * 1024;
const ARGV_LIMIT: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(45);
const CLEANUP: Duration = Duration::from_millis(500);
const GRACE: Duration = Duration::from_millis(100);

/// See module contract: authorization and durable request persistence are caller
/// obligations, not facts this function can infer from argv/cwd.
pub fn execute(argv: &[String], cwd: &Path) -> Result<Value> {
    execute_with_deadline(argv, cwd, DEADLINE)
}

/// Current-generation cancellation only; never signal a persisted/discovered PID.
pub fn execute_with_cancel(argv: &[String], cwd: &Path, cancel: &std::sync::atomic::AtomicBool) -> Result<Value> {
    execute_controlled(argv,cwd,DEADLINE,Control{cancel:Some(cancel),..Control::default()})
}

/// Serialize only fork/exec against shutdown/admission, never command runtime.
pub fn execute_with_launch_gate(argv:&[String],cwd:&Path,cancel:&std::sync::atomic::AtomicBool,gate:&std::sync::Mutex<()>)->Result<Value>{
    execute_controlled(argv,cwd,DEADLINE,Control{cancel:Some(cancel),launch:Some(gate),directory:None})
}

/// Pins the directory object approved by the ledger, even if another process
/// renames/replaces its pathname before fork. Never persisted or sent to the UI.
pub struct ApprovedDirectory { file:std::fs::File, path:PathBuf }
impl ApprovedDirectory {
    pub fn open(path:&Path,device:u64,inode:u64)->Result<Self>{
        let directory=Self::current(path)?;let meta=directory.file.metadata()?;
        ensure!(meta.dev()==device && meta.ino()==inode,"approved working directory identity changed");Ok(directory)
    }
    fn current(path:&Path)->Result<Self>{
        ensure!(path.is_absolute(),"working directory must be absolute");
        let file=std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC).open(path).context("open working directory without following a leaf symlink")?;
        ensure!(file.metadata()?.is_dir(),"working directory is not a directory");Ok(Self{file,path:path.into()})
    }
}
#[derive(Default)]
struct Control<'a>{cancel:Option<&'a std::sync::atomic::AtomicBool>,launch:Option<&'a std::sync::Mutex<()>>,directory:Option<&'a ApprovedDirectory>}

pub fn execute_approved(argv:&[String],directory:&ApprovedDirectory,cancel:&std::sync::atomic::AtomicBool,gate:&std::sync::Mutex<()>)->Result<Value>{
    execute_controlled(argv,&directory.path,DEADLINE,Control{cancel:Some(cancel),launch:Some(gate),directory:Some(directory)})
}

pub(crate) fn identity() -> Result<(PathBuf, std::ffi::OsString)> {
    // getpwuid_r avoids global passwd state and inherited HOME/USER. Bound NSS
    // storage rather than accepting arbitrarily large environment values.
    let mut storage = vec![0u8; 64 * 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(libc::geteuid(), &mut entry, storage.as_mut_ptr().cast(),
            storage.len(), &mut found)
    };
    ensure!(rc == 0 && !found.is_null(), "effective user lookup failed ({rc})");
    ensure!(!entry.pw_dir.is_null() && !entry.pw_name.is_null(), "missing user identity");
    let home = std::ffi::OsStr::from_bytes(unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }.to_bytes());
    let user = std::ffi::OsStr::from_bytes(unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }.to_bytes());
    ensure!(Path::new(home).is_absolute() && !user.is_empty(), "invalid user identity");
    Ok((PathBuf::from(home), user.to_owned()))
}

pub(crate) fn tool_path(home:&Path)->Result<std::ffi::OsString> {
    let mut paths=vec![home.join(".cargo/bin"),home.join(".local/bin"),home.join(".bun/bin")];
    // The selected local development toolchain may be installed without rustup
    // shims. Only this conventional stable SDK location is considered.
    let stable=home.join(format!(".rustup/toolchains/stable-{}-apple-darwin/bin",std::env::consts::ARCH));
    if cfg!(target_os="macos") && stable.is_dir(){paths.push(stable);}
    paths.extend(["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin","/usr/sbin","/sbin"].iter().map(PathBuf::from));
    Ok(std::env::join_paths(paths)?)
}

pub(crate) struct Owned {
    pub(crate) child: Child,
    // Becomes false BEFORE wait: never signal after any reap, even if wait fails.
    pinned: bool,
}

impl Owned {
    /// Only a newly spawned child whose pre_exec successfully ran setsid.
    pub(crate) fn new_session(child:Child)->Self{Self{child,pinned:true}}
    pub(crate) fn pid(&self) -> libc::pid_t { self.child.id() as libc::pid_t }

    pub(crate) fn exited(&mut self) -> io::Result<bool> {
        // A reaped PID may be recycled: never inspect it after losing custody.
        if !self.pinned { return Err(io::Error::other("leader no longer pinned")); }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let rc = unsafe { libc::waitid(libc::P_PID, self.child.id(), &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
            if rc == 0 { return Ok(unsafe { info.si_pid() } != 0); }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                // An external reaper violates our exclusive-wait contract.
                // Ownership is lost: do not risk any further group signal.
                self.pinned = false;
            }
            if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
        }
    }

    pub(crate) fn signal(&mut self, signal: i32) -> io::Result<()> {
        if !self.pinned { return Err(io::Error::other("leader no longer pinned")); }
        // pre_exec setsid succeeded before spawn returned: PGID == SID == PID.
        // A session leader cannot change its process group or join another SID.
        if unsafe { libc::killpg(self.pid(), signal) } == 0 { return Ok(()); }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) { return Ok(()); }
        // Darwin reports EPERM for zombie-only groups (not ESRCH). Accept it
        // only with BOTH WNOWAIT-confirmed leader exit and read-only evidence
        // that no live member remains in our group. Other EPERM is uncertainty.
        if error.raw_os_error() == Some(libc::EPERM) && self.exited()? &&
            survivors(self.pid()).is_ok_and(|live| live.iter().all(|(_, pgid)| *pgid != self.pid())) {
            return Ok(());
        }
        Err(error)
    }

    pub(crate) fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.pinned = false;
        self.child.wait()
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if self.pinned {
            // Panic fallback; ordinary paths implement TERM grace first.
            let _ = self.signal(libc::SIGKILL);
            let _ = self.wait();
        }
    }
}

fn nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Default)]
struct Capture { out: Vec<u8>, err: Vec<u8>, eof: [bool; 2], overflow: bool }

impl Capture {
    fn read(&mut self, index: usize, reader: &mut impl Read) -> io::Result<()> {
        if self.eof[index] { return Ok(()); }
        // Bound work per pipe per tick: a continuously writing child cannot
        // starve stderr, exit observation, or deadline/cleanup checks.
        for _ in 0..8 {
            let mut bytes = [0u8; 8192];
            match reader.read(&mut bytes) {
                Ok(0) => { self.eof[index] = true; break; }
                Ok(n) => {
                    let remaining = OUTPUT_LIMIT - self.out.len() - self.err.len();
                    let keep = n.min(remaining);
                    let target = if index == 0 { &mut self.out } else { &mut self.err };
                    target.extend_from_slice(&bytes[..keep]);
                    if keep < n { self.overflow = true; break; }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => break,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

fn poll_pipes(fds: [i32; 2], eof: [bool; 2], until: Instant) -> io::Result<()> {
    let mut items = [0, 1].map(|i| libc::pollfd {
        fd: if eof[i] { -1 } else { fds[i] }, events: libc::POLLIN, revents: 0,
    });
    let millis = until.saturating_duration_since(Instant::now()).as_millis().min(10) as i32;
    let rc = unsafe { libc::poll(items.as_mut_ptr(), 2, millis) };
    if rc < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
    }
    ensure_poll(&items)
}

fn ensure_poll(items: &[libc::pollfd]) -> io::Result<()> {
    if items.iter().any(|p| p.revents & (libc::POLLNVAL | libc::POLLERR) != 0) {
        Err(io::Error::other("output pipe poll error"))
    } else { Ok(()) }
}

// Read-only inventory while the session leader is still pinned. Discovered
// process IDs are evidence ONLY. Never kill additional groups or individual PIDs.
#[cfg(target_os = "macos")]
pub(crate) fn survivors(sid: libc::pid_t) -> Result<Vec<(i32, i32)>> {
    let mut pids = vec![0i32; 65536];
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(),
        std::mem::size_of_val(pids.as_slice()) as i32) };
    ensure!(count > 0 && (count as usize) < pids.len(), "SID inventory unavailable/truncated");
    let mut live = Vec::new();
    for pid in pids.into_iter().take(count as usize).filter(|p| *p > 0 && *p != sid) {
        let session = unsafe { libc::getsid(pid) };
        if session < 0 {
            ensure!(io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
                "SID inspection failed");
        } else if session == sid {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let rc = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0,
                (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
            if rc != size {
                ensure!(unsafe { libc::getsid(pid) } < 0 &&
                    io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
                    "survivor inspection failed");
            } else if info.pbi_status != libc::SZOMB as u32 {
                live.push((pid, info.pbi_pgid as i32));
            }
        }
    }
    Ok(live)
}

#[cfg(target_os = "linux")]
fn survivors(sid: libc::pid_t) -> Result<Vec<(i32, i32)>> {
    let mut live = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else { continue; };
        if pid == sid { continue; }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let (_, fields) = stat.rsplit_once(')').context("invalid proc stat")?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        ensure!(fields.len() >= 4, "short proc stat");
        if fields[3].parse::<i32>()? == sid && fields[0] != "Z" && fields[0] != "X" {
            live.push((pid, fields[2].parse()?));
        }
    }
    Ok(live)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn survivors(_: libc::pid_t) -> Result<Vec<(i32, i32)>> {
    anyhow::bail!("SID inventory unsupported on this platform")
}

fn execute_with_deadline(argv: &[String], cwd: &Path, budget: Duration) -> Result<Value> {
    execute_controlled(argv,cwd,budget,Control::default())
}
fn execute_controlled(argv: &[String], cwd: &Path, budget: Duration, control:Control<'_>) -> Result<Value> {
    let cancel=control.cancel;let launch=control.launch;
    let started = Instant::now();
    ensure!(!argv.is_empty() && Path::new(&argv[0]).is_absolute(), "argv[0] must be absolute");
    ensure!(cwd.is_absolute() && !cwd.as_os_str().as_bytes().contains(&0), "cwd must be absolute and NUL-free");
    let mut length = 0usize;
    for arg in argv {
        ensure!(!arg.as_bytes().contains(&0), "argv contains NUL");
        length = length.checked_add(arg.len()).and_then(|n| n.checked_add(1)).context("argv too large")?;
        ensure!(length <= ARGV_LIMIT, "argv exceeds 16 KiB including terminators");
    }
    ensure!(budget > CLEANUP, "deadline must include cleanup reserve");
    let deadline = started + budget;
    let run_until = deadline - CLEANUP;
    let (home, user) = identity()?;
    let path=tool_path(&home)?;
    let opened=if control.directory.is_none(){Some(ApprovedDirectory::current(cwd)?)}else{None};
    let directory=control.directory.or(opened.as_ref()).context("working directory handle unavailable")?;
    let directory_fd=directory.file.as_raw_fd();
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).env_clear()
        .env("HOME", home).env("USER", user)
        .env("PATH", path)
        .env("LANG", "C").env("TERM", "dumb").env("GIT_OPTIONAL_LOCKS","0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 { return Err(io::Error::last_os_error()); }
            if libc::fchdir(directory_fd)<0{return Err(io::Error::last_os_error());}
            Ok(())
        });
    }
    ensure!(Instant::now() < run_until, "deadline expired before spawn");
    let child={
        let _launch=launch.map(|gate|gate.lock().map_err(|_|anyhow::anyhow!("launch gate unavailable"))).transpose()?;
        if cancel.is_some_and(|flag|flag.load(std::sync::atomic::Ordering::Acquire)) {
            return Ok(json!({"status":"cancelled","exitCode":null,"stdout":"","stderr":"","truncated":false,"elapsedMs":started.elapsed().as_millis() as u64,"spawned":false,"explanation":"cancelled before spawn; no verification command started"}));
        }
        if Instant::now() >= run_until {
            return Ok(json!({"status":"timeout","exitCode":null,"stdout":"","stderr":"","truncated":false,"elapsedMs":started.elapsed().as_millis() as u64,"spawned":false,"explanation":"deadline expired while waiting for launch; command not started"}));
        }
        match command.spawn() {
            Ok(child)=>child,
            Err(_)=>return Ok(json!({"status":"failed","exitCode":null,"stdout":"","stderr":"","truncated":false,"elapsedMs":started.elapsed().as_millis() as u64,"spawned":false,"explanation":"verification spawn/exec failed; command not started, no implicit retry"})),
        }
    };
    let mut owned = Owned { child, pinned: true };
    let mut stdout = owned.child.stdout.take().context("missing stdout pipe")?;
    let mut stderr = owned.child.stderr.take().context("missing stderr pipe")?;
    let fds = [stdout.as_raw_fd(), stderr.as_raw_fd()];
    let mut capture = Capture::default();
    let mut notes = Vec::<String>::new();
    let mut uncertain = false;
    let mut status = "failed";
    let mut pipes_ready = true;
    for fd in fds {
        if let Err(e) = nonblocking(fd) {
            notes.push(format!("nonblocking setup: {e}"));
            uncertain = true;
            pipes_ready = false;
        }
    }
    // No fallible early returns after spawn: every normal path reaches cleanup
    // and final wait; Owned also provides a panic/early-error fallback.
    if pipes_ready {
        loop {
            if cancel.is_some_and(|flag|flag.load(std::sync::atomic::Ordering::Acquire)){status="cancelled";break;}
            let read = capture.read(0, &mut stdout).and_then(|_| capture.read(1, &mut stderr));
            if let Err(e) = read {
                notes.push(format!("output read: {e}")); uncertain = true; break;
            }
            if capture.overflow { status = "output_limit"; break; }
            if Instant::now() >= run_until { status = "timeout"; break; }
            match owned.exited() {
                Ok(true) => break, // pipes may still be held by descendants
                Ok(false) => (),
                Err(e) => { notes.push(format!("WNOWAIT: {e}")); uncertain = true; break; }
            }
            if let Err(e) = poll_pipes(fds, capture.eof, run_until) {
                notes.push(format!("poll: {e}")); uncertain = true; break;
            }
        }
    }
    if let Err(e) = owned.signal(libc::SIGTERM) {
        notes.push(format!("group SIGTERM: {e}")); uncertain = true;
    }
    let grace_until = (Instant::now() + GRACE).min(deadline);
    let mut killed = false;
    loop {
        if !killed && Instant::now() >= grace_until {
            if let Err(e) = owned.signal(libc::SIGKILL) {
                notes.push(format!("group SIGKILL: {e}")); uncertain = true;
            }
            killed = true;
        }
        if pipes_ready {
            if let Err(e) = capture.read(0, &mut stdout).and_then(|_| capture.read(1, &mut stderr)) {
                notes.push(format!("cleanup read: {e}")); uncertain = true; pipes_ready = false;
            }
        }
        // Always send KILL after the grace; no reaping, including exit-zero paths,
        // before the last group signal. The dead leader still reserves its PID.
        if killed {
            match (owned.exited(), survivors(owned.pid())) {
                (Ok(true), Ok(live)) if live.is_empty() &&
                    (!pipes_ready || capture.eof == [true, true] || capture.overflow) => break,
                (Err(e), _) => { notes.push(format!("cleanup WNOWAIT: {e}")); uncertain = true; break; }
                (_, Err(e)) => { notes.push(format!("SID inventory: {e:#}")); uncertain = true; break; }
                _ => (),
            }
        }
        if Instant::now() >= deadline { break; }
        // Avoid HUP/poll spin during grace or after the output budget is spent.
        std::thread::sleep(Duration::from_millis(5));
    }
    // Final observational snapshot still precedes wait. Never signal these PIDs.
    match survivors(owned.pid()) {
        Ok(live) if !live.is_empty() => {
            notes.push(format!("live SID survivors (pid, pgid): {live:?}; other groups are not signalled"));
            uncertain = true;
        }
        Err(e) => { notes.push(format!("final SID inventory: {e:#}")); uncertain = true; }
        _ => (),
    }
    if pipes_ready {
        // Finite last drain, even if a process outside the SID holds a pipe.
        for _ in 0..9 {
            if let Err(e) = capture.read(0, &mut stdout).and_then(|_| capture.read(1, &mut stderr)) {
                notes.push(format!("final output read: {e}")); uncertain = true; break;
            }
            if capture.eof == [true, true] || capture.overflow { break; }
        }
    }
    let exit = match owned.wait() {
        Ok(exit) => Some(exit),
        Err(e) => { notes.push(format!("final wait: {e}")); uncertain = true; None }
    };
    let incomplete = capture.eof != [true, true];
    if incomplete && !capture.overflow {
        notes.push("output pipes did not reach EOF after group cleanup".into()); uncertain = true;
    }
    if capture.overflow { status = "output_limit"; }
    if status == "failed" && exit.is_some_and(|e| e.success()) { status = "passed"; }
    if uncertain {
        notes.push(format!("underlying execution outcome: {status}"));
        status = "uncertain";
    }
    notes.insert(0, match status {
        "passed" => "command exited zero; owned group cleaned up",
        "failed" => "command exited nonzero or was terminated by a signal",
        "cancelled" => "cancellation requested; owned group cleanup completed; side effects are not rolled back",
        "timeout" => "execution deadline reached (cleanup time reserved within 45s)",
        "output_limit" => "combined stdout/stderr exceeded 512 KiB",
        _ => "supervision or containment could not be established",
    }.into());
    notes.push("read-only SID inventory cannot detect/contain descendants that escape with setsid; side effects are not rolled back".into());
    Ok(json!({
        "status": status, "exitCode": exit.and_then(|e| e.code()),
        "stdout": String::from_utf8_lossy(&capture.out),
        "stderr": String::from_utf8_lossy(&capture.err),
        "truncated": capture.overflow || incomplete,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "explanation": notes.join("; "),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_fixture(name: &str, seconds: u64) -> Value {
        let dir = tempfile::tempdir().unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let args = vec![std::env::current_exe().unwrap().to_str().unwrap().into(),
            "--exact".into(), format!("{module}::fixture_{name}"), "--ignored".into(),
            "--nocapture".into(), "--test-threads=1".into()];
        execute_with_deadline(&args, dir.path(), Duration::from_secs(seconds)).unwrap()
    }

    // Fixtures run only in separately exec'd test binaries. They touch no user
    // files or network. alarm provides independent expiry for escaped descendants.
    #[test] #[ignore = "subprocess fixture"]
    fn fixture_success() {
        assert_eq!(unsafe { libc::getsid(0) }, unsafe { libc::getpid() });
        assert_eq!(unsafe { libc::getpgrp() }, unsafe { libc::getpid() });
        let (home, user) = identity().unwrap();
        let expected_path=tool_path(&home).unwrap();
        let expected = [("HOME", home.into_os_string()), ("USER", user),
            ("PATH", expected_path),
            ("LANG", "C".into()), ("TERM", "dumb".into()),("GIT_OPTIONAL_LOCKS","0".into())];
        assert_eq!(std::env::vars_os().count(), expected.len());
        for (key, value) in expected { assert_eq!(std::env::var_os(key), Some(value)); }
        assert_eq!(io::stdin().read(&mut [0; 1]).unwrap(), 0);
        println!("fixture stdout"); eprintln!("fixture stderr");
    }

    #[test] #[ignore = "subprocess fixture"]
    fn fixture_failure() { std::process::exit(7); }

    #[test] #[ignore = "subprocess fixture"]
    fn fixture_timeout() {
        unsafe { libc::alarm(4); libc::signal(libc::SIGTERM, libc::SIG_IGN); }
        loop { std::thread::sleep(Duration::from_millis(10)); }
    }

    #[test] #[ignore = "subprocess fixture"]
    fn fixture_flood() {
        use std::io::Write;
        unsafe { libc::alarm(4); }
        loop {
            let _ = io::stdout().write_all(&[b'x'; 8192]);
            let _ = io::stderr().write_all(&[b'y'; 8192]);
        }
    }

    fn fork_pipe_holder(escape: bool) {
        // The child only uses async-signal-safe libc calls following fork.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::alarm(3);
                if escape && libc::setpgid(0, 0) != 0 { libc::_exit(90); }
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
                loop { libc::pause(); }
            }
        }
        // Give the forked child time to install TERM handling / change group.
        std::thread::sleep(Duration::from_millis(40));
        std::process::exit(0);
    }

    #[test] #[ignore = "subprocess fixture"]
    fn fixture_pipe() { fork_pipe_holder(false); }

    #[test] #[ignore = "subprocess fixture"]
    fn fixture_escape() { fork_pipe_holder(true); }

    #[test]
    fn success_and_failure() {
        let result = run_fixture("success", 3);
        assert_eq!(result["status"], "passed", "{}", result["explanation"]);
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["truncated"], false);
        assert!(result["stdout"].as_str().unwrap().contains("fixture stdout"));
        assert!(result["stderr"].as_str().unwrap().contains("fixture stderr"));
        let result = run_fixture("failure", 3);
        assert_eq!(result["status"], "failed", "{}", result["explanation"]);
        assert_eq!(result["exitCode"], 7);
    }

    #[test]
    fn deadline_and_flood_are_bounded() {
        let result = run_fixture("timeout", 1);
        assert_eq!(result["status"], "timeout", "{}", result["explanation"]);
        assert!(result["elapsedMs"].as_u64().unwrap() < 2000);
        let result = run_fixture("flood", 3);
        assert_eq!(result["status"], "output_limit", "{}", result["explanation"]);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["stdout"].as_str().unwrap().len() + result["stderr"].as_str().unwrap().len(), OUTPUT_LIMIT);
    }

    #[test]
    fn cleans_group_after_leader_exit_without_waiting_for_pipe_eof() {
        let result = run_fixture("pipe", 3);
        assert_eq!(result["status"], "passed", "{}", result["explanation"]);
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["truncated"], false);
        assert!(result["elapsedMs"].as_u64().unwrap() < 1500);
    }

    #[test]
    fn escaped_group_is_uncertain_and_never_signalled() {
        let result = run_fixture("escape", 1);
        assert_eq!(result["status"], "uncertain", "{}", result["explanation"]);
        assert!(result["explanation"].as_str().unwrap().contains("live SID survivors"));
        assert_eq!(result["truncated"], true);
        // Independent alarm, not PID signalling, disposes of this fixture.
        std::thread::sleep(Duration::from_secs(3));
    }

    #[test]
    fn cancellation_reaps_owned_group_and_pre_spawn_never_executes() {
        use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
        let dir=tempfile::tempdir().unwrap();
        let module=module_path!().split_once("::").unwrap().1;
        let args=vec![std::env::current_exe().unwrap().to_str().unwrap().into(),"--exact".into(),format!("{module}::fixture_timeout"),"--ignored".into(),"--nocapture".into(),"--test-threads=1".into()];
        let cancel=Arc::new(AtomicBool::new(false));let flag=cancel.clone();
        let worker=std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(120));flag.store(true,Ordering::Release);});
        let result=execute_controlled(&args,dir.path(),Duration::from_secs(3),Control{cancel:Some(&cancel),..Control::default()}).unwrap();worker.join().unwrap();
        assert_eq!(result["status"],"cancelled");assert!(result["elapsedMs"].as_u64().unwrap()<2000);
        let result=execute_with_cancel(&["/nonexistent-cancelled-fixture".into()],dir.path(),&cancel).unwrap();
        assert_eq!(result["spawned"],false);assert_eq!(result["status"],"cancelled");
    }

    #[test]
    fn cancellation_before_launch_gate_release_prevents_any_command_effect() {
        use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
        let dir=tempfile::tempdir().unwrap();let marker=dir.path().join("must-not-exist");
        let gate=Arc::new(Mutex::new(()));let held=gate.lock().unwrap();
        let cancel=Arc::new(AtomicBool::new(false));let child_gate=gate.clone();let flag=cancel.clone();
        let cwd=dir.path().to_path_buf();let target=marker.clone();
        let worker=std::thread::spawn(move||execute_with_launch_gate(&["/usr/bin/touch".into(),target.to_str().unwrap().into()],&cwd,&flag,&child_gate).unwrap());
        cancel.store(true,Ordering::Release);drop(held);
        let result=worker.join().unwrap();assert_eq!(result["spawned"],false);assert!(!marker.exists());
    }

    #[test]
    fn deadline_expiring_while_waiting_for_launch_never_executes() {
        use std::sync::{Arc,Mutex};
        let dir=tempfile::tempdir().unwrap();let marker=dir.path().join("must-not-exist");
        let gate=Arc::new(Mutex::new(()));let held=gate.lock().unwrap();let child_gate=gate.clone();
        let cwd=dir.path().to_path_buf();let target=marker.clone();
        assert!(CLEANUP>Duration::from_millis(400));
        let worker=std::thread::spawn(move||execute_controlled(&["/usr/bin/touch".into(),target.to_str().unwrap().into()],&cwd,Duration::from_millis(1000),Control{launch:Some(&child_gate),..Control::default()}).unwrap());
        std::thread::sleep(Duration::from_millis(600));drop(held);
        let result=worker.join().unwrap();assert_eq!(result["status"],"timeout");assert_eq!(result["spawned"],false);assert!(!marker.exists());
    }

    #[test]
    fn approved_directory_handle_survives_rename_without_writing_replacement() {
        let dir=tempfile::tempdir().unwrap();let original=dir.path().join("approved");let moved=dir.path().join("moved");
        std::fs::create_dir(&original).unwrap();let metadata=std::fs::metadata(&original).unwrap();
        let approved=ApprovedDirectory::open(&original,metadata.dev(),metadata.ino()).unwrap();
        std::fs::rename(&original,&moved).unwrap();std::fs::create_dir(&original).unwrap();
        assert!(ApprovedDirectory::open(&original,metadata.dev(),metadata.ino()).is_err());
        let result=execute_approved(&["/usr/bin/touch".into(),"proof".into()],&approved,&std::sync::atomic::AtomicBool::new(false),&std::sync::Mutex::new(())).unwrap();
        assert_eq!(result["status"],"passed");assert!(moved.join("proof").exists());assert!(!original.join("proof").exists());
    }

    #[test]
    fn rejects_invalid_requests_and_spawn_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(execute(&[], dir.path()).is_err());
        assert!(execute(&["relative".into()], dir.path()).is_err());
        assert!(execute(&["/nonexistent-fixture".into()], Path::new("relative")).is_err());
        assert!(execute(&["/nonexistent-fixture".into(), "\0".into()], dir.path()).is_err());
        assert!(execute(&["/nonexistent-fixture".into(), "x".repeat(ARGV_LIMIT)], dir.path()).is_err());
        let failed=execute(&[dir.path().join("missing-fixture").to_str().unwrap().into()], dir.path()).unwrap();
        assert_eq!(failed["status"],"failed");assert_eq!(failed["spawned"],false);
    }
}

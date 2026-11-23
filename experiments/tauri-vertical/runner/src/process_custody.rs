//! Owned process-group custody shared by the structured Codex transport.
//! Identity and PATH come from the effective user's passwd entry, never from
//! inherited environment. WNOWAIT keeps a leader pinned through group signals
//! and read-only SID inventory; a discovered PID never becomes signal authority.
//! Inventory is observational and racy: descendants in another SID can escape.
//! Requires exclusive wait ownership (no external SIGCHLD reaper / SA_NOCLDWAIT).

use anyhow::{Result, ensure};
use std::{
    io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Child,
};

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
pub(crate) fn survivors(sid: libc::pid_t) -> Result<Vec<(i32, i32)>> {
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
        let (_, fields) = stat.rsplit_once(')').ok_or_else(|| anyhow::anyhow!("invalid proc stat"))?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        ensure!(fields.len() >= 4, "short proc stat");
        if fields[3].parse::<i32>()? == sid && fields[0] != "Z" && fields[0] != "X" {
            live.push((pid, fields[2].parse()?));
        }
    }
    Ok(live)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn survivors(_: libc::pid_t) -> Result<Vec<(i32, i32)>> {
    anyhow::bail!("SID inventory unsupported on this platform")
}

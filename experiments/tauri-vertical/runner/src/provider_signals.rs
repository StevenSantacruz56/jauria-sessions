//! Explicit turn and permission signals from the providers' own hooks
//! (proposal branch `feat/1.4-avisos-proveedores`).
//!
//! Claude Code and Codex in a terminal do not emit OSC 7501 by themselves, so
//! Jauría cannot tell «finished its turn» or «waiting for your permission»
//! from their PTY output. Each session Jauría launches gets per-invocation
//! hooks that run `aw-runner --attention-hook <state>`, which writes one OSC
//! 7501 sequence to the session's PTY (the one the runner already reads),
//! found through `JAURIA_SESSION_TTY` or an ancestor's terminal: Claude Code
//! runs hooks without a controlling terminal, so `/dev/tty` is only a last resort. The existing scanner turns it into state and
//! alerts: nothing new crosses the socket, and no content of the provider
//! (prompt, tool, message) is read or forwarded.
//!
//! - Claude Code: `--settings` (one invocation, merged with the user's own
//!   settings; the user's hooks keep running) gets `UserPromptSubmit`,
//!   `PostToolUse` and `PostToolUseFailure` → working, `PermissionRequest`
//!   (immediate, no decision returned) and `Notification` for a permission
//!   prompt or an elicitation dialog → blocked, `Stop` → done, `StopFailure`
//!   (turn ended by an API error) → error.
//! - Codex in a terminal: `-c notify=[...]` (agent-turn-complete) → a turn
//!   (working then done: Codex has no turn-start hook, so the duration is not
//!   measured). Codex's `notify` is a single program, not a list: when the
//!   user's `config.toml` already sets `notify`, Jauría leaves it alone.
//!
//! The hook never fails a session: it prints nothing, always exits 0, never
//! waits for more than ~200 ms on stdin, and gives up silently without a tty.
//! (Earlier builds wrote only to `/dev/tty`: no signal ever reached the runner
//! from a real Claude Code, whose hooks have no controlling terminal.)
//! Off switch: the file `provider-signals-off` in the profile directory.
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::{Duration, Instant}};

/// Earlier off switch, still respected as «off» (app_settings reads it at startup).
pub const OFF_FILE: &str = crate::app_settings::PROVIDER_OFF_FILE;

/// Whether new sessions of this profile get the provider hooks: the setting
/// «Avisos de Claude Code y Codex», and never while the earlier off file exists.
pub fn enabled(setting: bool, data_dir: &Path) -> bool { setting && !data_dir.join(OFF_FILE).exists() }

/// The OSC 7501 bytes for one hook state; `turn` is a whole turn (Codex).
pub fn sequence(state: &str) -> Option<&'static [u8]> {
    Some(match state {
        "working" => b"\x1b]7501;state=working\x07",
        "blocked" => b"\x1b]7501;state=blocked\x07",
        "done" => b"\x1b]7501;state=done\x07",
        "error" => b"\x1b]7501;state=error\x07",
        "turn" => b"\x1b]7501;state=working\x07\x1b]7501;state=done\x07",
        _ => return None,
    })
}

/// The session's PTY (its slave device), set by the runner in the environment
/// of every Claude Code / Codex session it starts. Hooks inherit it.
pub const TTY_ENV: &str = "JAURIA_SESSION_TTY";

/// `aw-runner --attention-hook <state> [ignored provider arguments…]`.
/// Silent, bounded and always successful for the caller: errors are swallowed.
///
/// Claude Code runs its hooks in a session of their own without a controlling
/// terminal (`/dev/tty` fails with ENXIO there), so the PTY is found, in order:
/// 1. `JAURIA_SESSION_TTY`, validated (`/dev/ttys<digits>`, a character
///    device owned by this user, checked on the open descriptor);
/// 2. the controlling terminal of the nearest ancestor that has one (Claude
///    itself), walking up at most 16 parents with `proc_pidinfo`;
/// 3. `/dev/tty`.
pub fn hook(state: Option<&str>) {
    drain_stdin(Duration::from_millis(200));
    let Some(bytes) = state.and_then(sequence) else { return };
    let _ = write_session_tty(bytes, std::env::var_os(TTY_ENV).as_deref());
}

fn write_session_tty(bytes: &[u8], from_env: Option<&std::ffi::OsStr>) -> Result<()> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(path) = from_env.and_then(|p| p.to_str()).filter(|p| session_tty_path(p)) { candidates.push(path.into()); }
    if let Some(path) = ancestor_tty() { candidates.push(path); }
    for path in candidates {
        if let Ok(mut tty) = open_own_tty(&path) { tty.write_all(bytes)?; return Ok(()); }
    }
    use std::os::unix::fs::OpenOptionsExt;
    let mut tty = std::fs::OpenOptions::new().write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC).open("/dev/tty")?;
    tty.write_all(bytes)?;
    Ok(())
}

/// `/dev/ttys` followed by 1 to 4 digits: the macOS pseudo-terminal slaves.
pub fn session_tty_path(path: &str) -> bool {
    path.strip_prefix("/dev/ttys").is_some_and(|n| (1..=4).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Opens for writing only, never as controlling terminal, without blocking, and
/// keeps it only if the descriptor is a character device owned by this user.
fn open_own_tty(path: &Path) -> Result<std::fs::File> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
    ensure!(path.to_str().is_some_and(session_tty_path), "not a session tty path");
    let file = std::fs::OpenOptions::new().write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path)?;
    let meta = file.metadata()?;
    ensure!(meta.file_type().is_char_device() && meta.uid() == unsafe { libc::geteuid() }, "not this user's terminal");
    ensure!(unsafe { libc::isatty(std::os::fd::AsRawFd::as_raw_fd(&file)) } == 1, "not a terminal");
    Ok(file)
}

unsafe extern "C" { fn devname(dev: libc::dev_t, kind: libc::mode_t) -> *const libc::c_char; }

/// The controlling terminal of the nearest ancestor that has one.
fn ancestor_tty() -> Option<std::path::PathBuf> {
    let mut pid = unsafe { libc::getppid() };
    for _ in 0..16 {
        if pid <= 1 { return None; }
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        if read != size { return None; }
        if info.e_tdev != u32::MAX && info.e_tdev != 0 {
            let name = unsafe { devname(info.e_tdev as libc::dev_t, libc::S_IFCHR) };
            if name.is_null() { return None; }
            let name = unsafe { std::ffi::CStr::from_ptr(name) }.to_str().ok()?;
            let path = format!("/dev/{name}");
            return session_tty_path(&path).then(|| path.into());
        }
        pid = info.pbi_ppid as libc::pid_t;
    }
    None
}

/// Claude writes the hook's JSON on stdin and may fail the hook on a broken
/// pipe: read and discard it, without ever reading a terminal (Codex runs
/// `notify` with the PTY as stdin: those bytes are the person's keystrokes).
fn drain_stdin(limit: Duration) {
    if unsafe { libc::isatty(0) } == 1 { return; }
    let flags = unsafe { libc::fcntl(0, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(0, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 { return; }
    let end = Instant::now() + limit;
    let mut buffer = [0u8; 8192];
    let mut total = 0usize;
    while total < 1 << 20 {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() { break; }
        let mut poll = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut poll, 1, left.as_millis().max(1) as i32) } <= 0 { break; }
        let read = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read <= 0 { break; }
        total += read as usize;
    }
}

fn quote(path: &Path) -> Result<String> {
    ensure!(path.is_absolute(), "La ruta del hook debe ser absoluta.");
    let text = path.to_str().ok_or_else(|| anyhow::anyhow!("Ruta de hook no compatible."))?;
    ensure!(!text.contains('\0'), "Ruta de hook no compatible.");
    Ok(format!("'{}'", text.replace('\'', "'\\''")))
}

/// Claude Code `hooks` for `--settings`, merged by the caller with the rest
/// of Jauría's per-session settings.
pub fn claude_hooks(executable: &Path) -> Result<Value> {
    let exe = quote(executable)?;
    let run = |state: &str| json!([{"type": "command", "command": format!("{exe} --attention-hook {state}"), "timeout": 5}]);
    // Event names checked against Claude Code 2.1.331 (its hook event list) and
    // https://code.claude.com/docs/en/hooks. PermissionRequest fires as the
    // prompt appears (Notification permission_prompt only after ~6 s of waiting);
    // the hook returns no decision (exit 0, no stdout): the dialog still decides.
    // StopFailure replaces Stop when the turn ends on an API error.
    Ok(json!({
        "UserPromptSubmit": [{"hooks": run("working")}],
        "PostToolUse": [{"matcher": "*", "hooks": run("working")}],
        "PostToolUseFailure": [{"matcher": "*", "hooks": run("working")}],
        "PermissionRequest": [{"matcher": "*", "hooks": run("blocked")}],
        "Notification": [{"matcher": "permission_prompt|elicitation_dialog", "hooks": run("blocked")}],
        "Stop": [{"hooks": run("done")}],
        "StopFailure": [{"hooks": run("error")}],
    }))
}

/// Codex `-c` override, or None when the user already configured `notify`
/// (Codex runs a single notify program: replacing theirs would break it).
pub fn codex_notify(executable: &Path, home: &Path, cwd: &Path) -> Result<Option<String>> {
    // The account config and a project config in the session's folder.
    if user_has_notify(&home.join(".codex/config.toml")) || user_has_notify(&cwd.join(".codex/config.toml")) { return Ok(None); }
    let exe = executable.to_str().ok_or_else(|| anyhow::anyhow!("Ruta de hook no compatible."))?;
    ensure!(executable.is_absolute() && !exe.contains('\0'), "Ruta de hook no compatible.");
    Ok(Some(format!("notify={}", serde_json::to_string(&[exe, "--attention-hook", "turn"])?)))
}

/// A top-level `notify` key in config.toml (before the first table header).
/// Conservative: an unreadable file counts as configured (never override it).
/// Whether a Codex config may set `notify`. The runner has no TOML parser (and
/// adds no dependency for this), so the test is deliberately conservative:
/// any appearance of the word `notify` (bare, "quoted", 'literal', dotted, in
/// any table or comment), any unicode escape that could spell it, a file that
/// is not UTF-8 or cannot be read all count as «the person has one» and Jauría
/// leaves `notify` alone. Only a missing file, or one that never mentions it,
/// lets Jauría add its own.
fn user_has_notify(path: &Path) -> bool {
    match std::fs::read(path) {
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        Ok(bytes) => match String::from_utf8(bytes) {
            Err(_) => true,
            Ok(text) => text.contains("notify") || text.contains("\\u") || text.contains("\\U"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_tty_from_the_environment_is_written_and_validated() {
        let (mut master, mut slave) = (0, 0);
        let mut name = [0 as libc::c_char; 128];
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, name.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
        let path = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }.to_str().unwrap().to_owned();
        assert!(session_tty_path(&path), "{path}");
        write_session_tty(sequence("blocked").unwrap(), Some(std::ffi::OsStr::new(&path))).unwrap();
        let mut buffer = [0u8; 64];
        let read = unsafe { libc::read(master, buffer.as_mut_ptr().cast(), buffer.len()) };
        assert!(read > 0 && buffer[..read as usize].windows(13).any(|w| w == b"state=blocked"), "the PTY did not get the sequence");
        unsafe { libc::close(master); libc::close(slave); }
        // Only /dev/ttys<digits>; a regular file with that shape of name cannot pass open_own_tty either.
        for bad in ["/dev/null", "/dev/tty", "/dev/ttys", "/dev/ttys12345", "/dev/ttys1/../null", "/tmp/ttys001", "/dev/ttysa01"] { assert!(!session_tty_path(bad), "{bad}"); }
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(open_own_tty(file.path()).is_err());
    }

    #[test]
    fn sequences_are_what_the_scanner_reads() {
        use crate::agent_signals::{Declared, Scanner, Signal};
        for (state, expected) in [("working", vec![Signal::State(Declared::Working)]), ("blocked", vec![Signal::State(Declared::Blocked)]),
            ("done", vec![Signal::State(Declared::Done)]), ("error", vec![Signal::State(Declared::Error)]), ("turn", vec![Signal::State(Declared::Working), Signal::State(Declared::Done)])] {
            let mut scanner = Scanner::new();
            let mut seen = Vec::new();
            scanner.feed(sequence(state).unwrap(), |_, signal| seen.push(signal));
            assert_eq!(seen, expected, "{state}");
        }
        assert!(sequence("rm -rf").is_none());
    }

    #[test]
    fn claude_hooks_cover_turn_and_permission_and_quote_the_path() {
        let hooks = claude_hooks(Path::new("/Applications/Jau'ria.app/aw-runner")).unwrap();
        let command = |event: &str| hooks[event][0]["hooks"][0]["command"].as_str().unwrap().to_owned();
        assert_eq!(command("UserPromptSubmit"), r"'/Applications/Jau'\''ria.app/aw-runner' --attention-hook working");
        assert!(command("Stop").ends_with("--attention-hook done"));
        assert!(command("Notification").ends_with("--attention-hook blocked"));
        assert_eq!(hooks["Notification"][0]["matcher"], "permission_prompt|elicitation_dialog", "idle reminders are not a permission");
        assert!(command("PermissionRequest").ends_with("--attention-hook blocked"), "the permission is announced when it appears");
        assert!(command("PostToolUseFailure").ends_with("--attention-hook working"));
        assert!(command("StopFailure").ends_with("--attention-hook error"), "an API error ends the turn as «te necesita»");
        // Every configured event exists in the installed-version list (Claude Code 2.1.331).
        const KNOWN: &[&str] = &["PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch","Notification","UserPromptSubmit","UserPromptExpansion","SessionStart","SessionEnd","Stop","StopFailure","SubagentStart","SubagentStop","PreCompact","PostCompact","PreModelSwitch","PostModelSwitch","PermissionRequest","PermissionDenied"];
        for event in hooks.as_object().unwrap().keys() { assert!(KNOWN.contains(&event.as_str()), "{event}"); }
        assert!(claude_hooks(Path::new("relative")).is_err());
    }

    #[test]
    fn codex_notify_respects_the_users_own() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let exe = Path::new("/opt/jauria/aw-runner");
        let ours = |home: &Path| codex_notify(exe, home, project.path()).unwrap();
        assert_eq!(ours(home.path()).unwrap(), r#"notify=["/opt/jauria/aw-runner","--attention-hook","turn"]"#);
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        let config = home.path().join(".codex/config.toml");
        std::fs::write(&config, "model = \"o3\"\n[tui]\nnotifications = true\n").unwrap();
        assert!(ours(home.path()).is_some(), "a config that never says notify");
        // Every TOML spelling of the key keeps the person's own program (Codex runs only one).
        for text in ["notify = [\"terminal-notifier\"]\n", "\"notify\" = [\"x\"]\n", "'notify' = [\"/ruta/programa\"]\n",
            "  notify=[\"x\"] # mine\n", "\"\\u006eotify\" = [\"x\"]\n", "[tui]\nnotify = true\n", "# notify = [\"x\"]\n"] {
            std::fs::write(&config, text).unwrap();
            assert!(ours(home.path()).is_none(), "{text:?}");
        }
        // Unreadable or not UTF-8: in doubt, leave it alone.
        std::fs::write(&config, [0xff, 0xfe, b'x']).unwrap();
        assert!(ours(home.path()).is_none());
        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir(&config).unwrap();
        assert!(ours(home.path()).is_none(), "a config that cannot be read");
        std::fs::remove_dir(&config).unwrap();
        // A project config in the session's folder counts too.
        std::fs::create_dir(project.path().join(".codex")).unwrap();
        std::fs::write(project.path().join(".codex/config.toml"), "'notify' = [\"x\"]\n").unwrap();
        assert!(ours(home.path()).is_none());
    }

    #[test]
    fn the_setting_decides_and_the_earlier_off_file_still_means_off() {
        let profile = tempfile::tempdir().unwrap();
        assert!(enabled(true, profile.path()));
        assert!(!enabled(false, profile.path()));
        std::fs::write(profile.path().join(OFF_FILE), "").unwrap();
        assert!(!enabled(true, profile.path()));
    }
}

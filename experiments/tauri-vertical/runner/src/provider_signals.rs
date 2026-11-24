//! Explicit turn and permission signals from the providers' own hooks
//! (proposal branch `feat/1.4-avisos-proveedores`).
//!
//! Claude Code and Codex in a terminal do not emit OSC 7501 by themselves, so
//! Jauría cannot tell «finished its turn» or «waiting for your permission»
//! from their PTY output. Each session Jauría launches gets per-invocation
//! hooks that run `aw-runner --attention-hook <state>`, which writes one OSC
//! 7501 sequence to the session's controlling terminal (`/dev/tty`, i.e. the
//! PTY the runner already reads). The existing scanner turns it into state and
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

/// `aw-runner --attention-hook <state> [ignored provider arguments…]`.
/// Silent, bounded and always successful for the caller: errors are swallowed.
pub fn hook(state: Option<&str>) {
    drain_stdin(Duration::from_millis(200));
    let Some(bytes) = state.and_then(sequence) else { return };
    let _ = write_tty(bytes);
}

fn write_tty(bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut tty = std::fs::OpenOptions::new().write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC).open("/dev/tty")?;
    tty.write_all(bytes)?;
    Ok(())
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
pub fn codex_notify(executable: &Path, home: &Path) -> Result<Option<String>> {
    if user_has_notify(&home.join(".codex/config.toml")) { return Ok(None); }
    let exe = executable.to_str().ok_or_else(|| anyhow::anyhow!("Ruta de hook no compatible."))?;
    ensure!(executable.is_absolute() && !exe.contains('\0'), "Ruta de hook no compatible.");
    Ok(Some(format!("notify={}", serde_json::to_string(&[exe, "--attention-hook", "turn"])?)))
}

/// A top-level `notify` key in config.toml (before the first table header).
/// Conservative: an unreadable file counts as configured (never override it).
fn user_has_notify(path: &Path) -> bool {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    for line in text.lines() {
        let line = line.trim_start();
        if line.starts_with('[') { break; }
        let key = line.split('=').next().unwrap_or("").trim().trim_matches('"');
        if line.contains('=') && key == "notify" { return true; }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let exe = Path::new("/opt/jauria/aw-runner");
        assert_eq!(codex_notify(exe, home.path()).unwrap().unwrap(), r#"notify=["/opt/jauria/aw-runner","--attention-hook","turn"]"#);
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        let config = home.path().join(".codex/config.toml");
        std::fs::write(&config, "model = \"o3\"\n[tui]\nnotify = true\n").unwrap();
        assert!(codex_notify(exe, home.path()).unwrap().is_some(), "a notify inside a table is not the top-level one");
        std::fs::write(&config, "# mine\nnotify = [\"terminal-notifier\"]\nmodel = \"o3\"\n").unwrap();
        assert!(codex_notify(exe, home.path()).unwrap().is_none(), "the user's notify is kept");
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

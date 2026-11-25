//! Provider hooks with a fake `claude` that behaves like Claude Code with
//! hooks: it reads `--settings`, then runs the configured hook commands with a
//! JSON payload on stdin, each in a session of its own without a controlling
//! terminal and with piped stdio, as Claude Code 2.1 does (observed on the
//! installed app: its hook children have tty `??` and `/dev/tty` fails with
//! ENXIO). Disposable HOME, data dir and socket. Never the real CLI, profile
//! or runner.
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Read, Write}, os::unix::{fs::PermissionsExt, net::UnixStream}, path::PathBuf,
    process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

/// Fake Claude Code: python3 from the system only parses the JSON of --settings.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
settings=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--settings" ]; then settings="$2"; shift; fi
  shift
done
printf '%s' "$settings" > "$HOME/settings.json"
/usr/bin/python3 - "$HOME/settings.json" <<'PY'
import json, subprocess, sys, time
hooks = json.load(open(sys.argv[1])).get("hooks")
if not hooks:
    print("NOHOOKS", flush=True); sys.exit(0)
import os
home = os.environ["HOME"]
given = os.environ.get("JAURIA_SESSION_TTY", "")
open(os.path.join(home, "tty-env"), "w").write("ttys" if given.startswith("/dev/ttys") else "missing")
env = dict(os.environ)
if os.path.exists(os.path.join(home, "no-tty-env")):
    env.pop("JAURIA_SESSION_TTY", None)   # fallback: only the ancestors' terminal is left
if os.path.exists(os.path.join(home, "bogus-tty")):
    env["JAURIA_SESSION_TTY"] = os.path.join(home, "bogus")   # tampered: a regular file
def fire(event, payload):
    # Like Claude Code: each hook in a session of its own, without a controlling
    # terminal (/dev/tty fails there), stdin/stdout/stderr through pipes.
    for group in hooks.get(event, []):
        for hook in group["hooks"]:
            done = subprocess.run(["/bin/sh", "-c", hook["command"]], input=json.dumps(payload).encode(), timeout=5,
                start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            if done.returncode != 0 or done.stdout or done.stderr:
                open(os.path.join(home, "hook-noise"), "a").write(event + "\n")
fire("UserPromptSubmit", {"hook_event_name": "UserPromptSubmit", "prompt": "SECRET-PROMPT"})
time.sleep(0.2)
if os.path.exists(os.path.join(os.environ["HOME"], "api-error")):
    # A tool fails, then the turn ends on an API error: StopFailure instead of Stop.
    fire("PostToolUseFailure", {"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "error": "SECRET-ERROR"})
    time.sleep(0.2)
    fire("StopFailure", {"hook_event_name": "StopFailure", "error": "rate_limit"})
else:
    # The permission appears (PermissionRequest at once), is approved, the tool runs, the turn ends.
    fire("PermissionRequest", {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "SECRET-TOOL"}})
    time.sleep(0.2)
    fire("PostToolUse", {"hook_event_name": "PostToolUse", "tool_name": "Bash"})
    time.sleep(0.2)
    fire("Stop", {"hook_event_name": "Stop"})
print("FAKE_DONE", flush=True)
PY
exec /bin/cat
"#;

struct Fixture { root: tempfile::TempDir, child: Child }
impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("awps-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(home.join(".local/bin")).unwrap();
        let cli = home.join(".local/bin/claude");
        fs::write(&cli, FAKE_CLAUDE).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_aw-runner")).arg("--data-dir").arg(root.path().join("data"))
            .arg("--socket").arg(root.path().join("sock")).arg("--token-file").arg(root.path().join("token"))
            .env("HOME", &home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
        let f = Self { root, child };
        let end = Instant::now() + Duration::from_secs(8);
        while f.try_rpc("status", json!({})).is_none() { assert!(Instant::now() < end, "runner not ready"); thread::sleep(Duration::from_millis(10)); }
        f
    }
    fn path(&self, name: &str) -> PathBuf { self.root.path().join(name) }
    fn try_rpc(&self, op: &str, args: Value) -> Option<Value> {
        let token = fs::read_to_string(self.path("token")).ok()?;
        let mut s = UnixStream::connect(self.path("sock")).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
        serde_json::to_writer(&mut s, &json!({"version":1,"token":token,"op":op,"args":args})).ok()?;
        s.write_all(b"\n").ok()?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }
    fn rpc(&self, op: &str, args: Value) -> Value {
        let r = self.try_rpc(op, args).unwrap();
        assert_eq!(r["ok"], true, "{op}: {}", r["error"]);
        r["result"].clone()
    }
    fn output(&self, id: &str) -> String {
        let (mut after, mut text) = (0u64, String::new());
        loop {
            let page = self.rpc("terminal_live", json!({"id":id,"after":after,"limit":64}));
            for frame in page["frames"].as_array().unwrap() {
                after = after.max(frame["index"].as_u64().unwrap_or(after));
                if let Some(d) = frame["data"].as_str() {
                    use base64::{Engine, engine::general_purpose::STANDARD};
                    text.push_str(&String::from_utf8_lossy(&STANDARD.decode(d).unwrap_or_default()));
                }
            }
            if page["hasMore"] != true { return text; }
        }
    }
    fn wait_output(&self, id: &str, needle: &str) -> String {
        let end = Instant::now() + Duration::from_secs(15);
        loop {
            let text = self.output(id);
            if text.contains(needle) { return text; }
            assert!(Instant::now() < end, "{needle} never printed");
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn agent(&self, id: &str) -> Value {
        self.rpc("status", json!({}))["sessions"].as_array().unwrap().iter().find(|r| r["id"] == id).map(|r| r["agent"].clone()).unwrap_or(Value::Null)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.try_rpc("shutdown", json!({}));
        let end = Instant::now() + Duration::from_secs(10);
        while self.child.try_wait().unwrap().is_none() && Instant::now() < end { thread::sleep(Duration::from_millis(10)); }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}

#[test]
fn claude_hooks_declare_turn_and_permission_through_the_pty() {
    let f = Fixture::new();
    f.rpc("start", json!({"id":"cl","title":"cl","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("cl", "FAKE_DONE");
    let end = Instant::now() + Duration::from_secs(5);
    let agent = loop {
        let agent = f.agent("cl");
        if agent["pending"]["finished"].is_object() { break agent; }
        assert!(Instant::now() < end, "no finished from the Stop hook: {agent}");
        thread::sleep(Duration::from_millis(20));
    };
    // UserPromptSubmit → working, PermissionRequest → blocked (needs), PostToolUse → working (needs leaves), Stop → done.
    assert_eq!(agent["alertSeq"], 2, "needs then finished: {agent}");
    assert!(agent["pending"].get("needs").is_none(), "the permission was answered: needs left by itself");
    assert_eq!(agent["state"], "done");
    assert!(agent["lastTurnMs"].as_u64().unwrap() >= 500, "measured turn: {agent}");
    // Nothing of the provider's payload reaches status or the screen.
    let status = f.rpc("status", json!({})).to_string();
    assert!(!status.contains("SECRET"));
    assert!(!f.output("cl").contains("SECRET"));
    // The settings keep the quota statusLine next to the hooks.
    let settings: Value = serde_json::from_str(&fs::read_to_string(f.path("home/settings.json")).unwrap()).unwrap();
    assert!(settings["statusLine"].is_object() && settings["hooks"]["Stop"].is_array());
    // The runner gave the session its PTY path; the hooks (no controlling terminal) stayed silent and exited 0.
    assert_eq!(fs::read_to_string(f.path("home/tty-env")).unwrap(), "ttys");
    assert!(!f.path("home/hook-noise").exists(), "a hook failed or printed");
}

/// Fallback: without JAURIA_SESSION_TTY (a session started otherwise), the
/// hook finds the PTY as the controlling terminal of its nearest ancestor.
#[test]
fn without_the_variable_the_hook_finds_the_ancestor_terminal() {
    let f = Fixture::new();
    fs::write(f.path("home/no-tty-env"), "").unwrap();
    f.rpc("start", json!({"id":"anc","title":"anc","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("anc", "FAKE_DONE");
    let end = Instant::now() + Duration::from_secs(5);
    while !f.agent("anc")["pending"]["finished"].is_object() {
        assert!(Instant::now() < end, "no finished through the ancestor's terminal: {}", f.agent("anc"));
        thread::sleep(Duration::from_millis(20));
    }
}

/// A tampered variable (a regular file, not this user's tty) is never written;
/// the hook still reaches the session through its ancestor.
#[test]
fn a_tampered_variable_is_not_written() {
    let f = Fixture::new();
    fs::write(f.path("home/bogus-tty"), "").unwrap();
    fs::write(f.path("home/bogus"), "").unwrap();
    f.rpc("start", json!({"id":"bog","title":"bog","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("bog", "FAKE_DONE");
    let end = Instant::now() + Duration::from_secs(5);
    while !f.agent("bog")["pending"]["finished"].is_object() {
        assert!(Instant::now() < end, "no finished: {}", f.agent("bog"));
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read(f.path("home/bogus")).unwrap(), b"", "the tampered path was written");
}

#[test]
fn an_api_error_ends_the_turn_as_needs_you_not_working() {
    let f = Fixture::new();
    fs::write(f.path("home/api-error"), "").unwrap();
    f.rpc("start", json!({"id":"err","title":"err","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("err", "FAKE_DONE");
    let end = Instant::now() + Duration::from_secs(5);
    let agent = loop {
        let agent = f.agent("err");
        if agent["state"] == "error" { break agent; }
        assert!(Instant::now() < end, "StopFailure left the row as: {agent}");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(agent["pending"]["needs"].is_object(), "«te necesita» after the API error: {agent}");
    assert!(!f.rpc("status", json!({})).to_string().contains("SECRET"));
}

#[test]
fn the_setting_turns_hooks_off_for_new_sessions_and_on_again() {
    let f = Fixture::new();
    assert_eq!(f.rpc("get_settings", json!({}))["providerSignals"], true, "on by default");
    assert_eq!(f.rpc("set_provider_signals", json!({"enabled":false}))["providerSignals"], false);
    assert_eq!(f.try_rpc("set_provider_signals", json!({"enabled":"no"})).unwrap()["ok"], false);
    assert_eq!(f.rpc("status", json!({}))["settings"]["providerSignals"], false);
    f.rpc("start", json!({"id":"quiet","title":"quiet","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("quiet", "NOHOOKS");
    let settings: Value = serde_json::from_slice(&fs::read(f.path("home/settings.json")).unwrap()).unwrap();
    assert!(settings.get("hooks").is_none() && settings["statusLine"].is_object());
    f.rpc("set_provider_signals", json!({"enabled":true}));
    f.rpc("start", json!({"id":"loud","title":"loud","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("loud", "FAKE_DONE");
}

#[test]
fn the_earlier_off_file_still_launches_claude_without_hooks() {
    let f = Fixture::new();
    fs::write(f.path("data/provider-signals-off"), "").unwrap();
    f.rpc("start", json!({"id":"off","title":"off","kind":"claude","rows":24,"cols":80,"cwd":f.path("home").to_str().unwrap()}));
    f.wait_output("off", "NOHOOKS");
    let settings: Value = serde_json::from_str(&fs::read_to_string(f.path("home/settings.json")).unwrap()).unwrap();
    assert!(settings.get("hooks").is_none() && settings["statusLine"].is_object());
}

#[test]
fn the_hook_is_silent_bounded_and_successful_without_a_terminal() {
    // stdin is a pipe that never closes and there is no controlling terminal (setsid-less
    // test process may have one: either way the hook must return fast, exit 0 and print nothing).
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_aw-runner")).args(["--attention-hook", "done", "{\"type\":\"agent-turn-complete\"}"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let _keep_open = child.stdin.take();
    let status = child.wait().unwrap();
    assert!(status.success());
    assert!(started.elapsed() < Duration::from_secs(2), "the hook waited on stdin: {:?}", started.elapsed());
    let (mut out, mut err) = (String::new(), String::new());
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
    assert_eq!((out.as_str(), err.as_str()), ("", ""));
    // Unknown states and missing arguments are just as quiet.
    for args in [vec!["--attention-hook"], vec!["--attention-hook", "rm"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_aw-runner")).args(&args).stdin(Stdio::null()).output().unwrap();
        assert!(out.status.success() && out.stdout.is_empty() && out.stderr.is_empty());
    }
}

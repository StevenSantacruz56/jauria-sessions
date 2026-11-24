//! Review of every alert signal against the real runner (1.4 avisos review).
//! Disposable data dir, socket, token and HOME per instance; only `shell`
//! sessions (zsh -f) that print controlled sequences with `printf`. Never a
//! real provider, profile or the live runner.
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Write}, os::unix::{fs::PermissionsExt, net::UnixStream}, path::PathBuf,
    process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

struct Instance { root: tempfile::TempDir, child: Option<Child> }

impl Instance {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("awrv-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        let mut instance = Self { root, child: None };
        instance.launch();
        instance
    }
    fn path(&self, name: &str) -> PathBuf { self.root.path().join(name) }
    fn launch(&mut self) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_aw-runner"));
        cmd.arg("--data-dir").arg(self.path("data")).arg("--socket").arg(self.path("sock")).arg("--token-file").arg(self.path("token"));
        cmd.env("HOME", self.path("home")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        self.child = Some(cmd.spawn().unwrap());
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if self.path("token").exists() && self.try_rpc("status", json!({})).is_some() { break; }
            assert!(Instant::now() < end, "runner did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn try_rpc(&self, op: &str, args: Value) -> Option<Value> {
        let token = fs::read_to_string(self.path("token")).ok()?;
        let mut stream = UnixStream::connect(self.path("sock")).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
        serde_json::to_writer(&mut stream, &json!({"version":1,"token":token,"op":op,"args":args})).ok()?;
        stream.write_all(b"\n").ok()?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }
    fn rpc(&self, op: &str, args: Value) -> Value {
        let response = self.try_rpc(op, args).unwrap_or_else(|| panic!("RPC {op}: transport failure"));
        assert_eq!(response["ok"], true, "RPC {op}: {}", response["error"]);
        response["result"].clone()
    }
    fn shell(&self, id: &str) { self.rpc("start", json!({"id":id,"title":id,"kind":"shell","rows":24,"cols":80})); }
    fn type_line(&self, id: &str, line: &str) { self.rpc("input", json!({"id":id,"data":format!("{line}\n")})); }
    fn row(&self, id: &str) -> Value {
        self.rpc("status", json!({}))["sessions"].as_array().unwrap().iter().find(|v| v["id"] == id).cloned().unwrap_or(Value::Null)
    }
    fn wait_row(&self, id: &str, what: &str, mut ok: impl FnMut(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let row = self.row(id);
            if ok(&row) { return row; }
            assert!(Instant::now() < end, "timeout waiting for {what}: {row}");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn wait_agent(&self, id: &str, what: &str, mut ok: impl FnMut(&Value) -> bool) -> Value {
        self.wait_row(id, what, |row| ok(&row["agent"]))["agent"].clone()
    }
    /// Prints a marker after `line` and waits until it is in the stream, so
    /// every byte before it was already read and scanned by the runner.
    fn settle(&self, id: &str, marker: &str) {
        self.type_line(id, &format!("echo {marker}-$((1+1))"));
        let wanted = format!("{marker}-2");
        let end = Instant::now() + Duration::from_secs(10);
        let (mut after, mut text) = (0u64, String::new());
        loop {
            let page = self.rpc("terminal_live", json!({"id":id,"after":after,"limit":64}));
            for frame in page["frames"].as_array().unwrap() {
                after = after.max(frame["index"].as_u64().unwrap_or(after));
                if let Some(d) = frame["data"].as_str() { text.push_str(&String::from_utf8_lossy(&base64(d))); }
            }
            if text.contains(&wanted) { return; }
            if page["hasMore"] == true { continue; }
            assert!(Instant::now() < end, "marker {marker} never echoed");
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = self.try_rpc("shutdown", json!({}));
            let end = Instant::now() + Duration::from_secs(10);
            while child.try_wait().unwrap().is_none() && Instant::now() < end { thread::sleep(Duration::from_millis(10)); }
            if child.try_wait().unwrap().is_none() { let _ = child.kill(); }
            let _ = child.wait();
        }
    }
}
impl Drop for Instance { fn drop(&mut self) { self.stop(); } }

fn base64(data: &str) -> Vec<u8> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    STANDARD.decode(data).unwrap_or_default()
}
fn pending(agent: &Value) -> Vec<String> {
    let mut kinds: Vec<String> = agent["pending"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    kinds.sort();
    kinds
}
fn seq(agent: &Value) -> u64 { agent["alertSeq"].as_u64().unwrap_or(0) }

#[test]
fn each_explicit_signal_and_nothing_else_raises_an_alert() {
    let app = Instance::new();
    app.shell("sig");
    app.settle("sig", "ready");
    // Silent sequences first: titles (OSC 0/2, also terminated by BEL), OSC 9;4
    // progress, OSC 777 that is not notify, raw output and cursor redraws.
    app.type_line("sig", r"printf '\033]0;titulo\007\033]2;otro\033\\\033]9;4;1;50\007\033]9;4;0;0\033\\\033]777;preexec;x\007\r| working\033[K\r/ working\033[2K\033[1G\n'");
    app.settle("sig", "quiet");
    let row = app.row("sig");
    assert!(row["agent"].is_null() || seq(&row["agent"]) == 0, "no alert from titles, progress or raw output: {}", row["agent"]);
    // BEL alone.
    app.type_line("sig", r"printf '\007'");
    let agent = app.wait_agent("sig", "bell", |a| a["pending"]["bell"].is_object());
    assert_eq!(pending(&agent), ["bell"]);
    let bell_frame = agent["pending"]["bell"]["frame"].as_u64();
    assert!(bell_frame.is_some(), "a live BEL carries its frame");
    // OSC 9 text notification (more than a second later: one per kind and second).
    thread::sleep(Duration::from_millis(1100));
    app.type_line("sig", r"printf '\033]9;Necesito permiso\007'");
    let agent = app.wait_agent("sig", "notify", |a| a["pending"]["notify"].is_object());
    assert_eq!(pending(&agent), ["bell", "notify"], "a second alert while the first is unseen keeps both");
    // OSC 777 notify; after the rate window, moves notify to a new sequence.
    thread::sleep(Duration::from_millis(1100));
    let before = seq(&agent);
    app.type_line("sig", r"printf '\033]777;notify;Codex;listo\033\\'");
    let agent = app.wait_agent("sig", "notify 777", |a| seq(a) == before + 1);
    assert_eq!(agent["pending"]["notify"]["seq"], before + 1);
    // Payloads never reach status.
    let status = app.rpc("status", json!({})).to_string();
    for secret in ["Necesito permiso", "listo", "titulo"] { assert!(!status.contains(secret), "{secret} leaked into status"); }
}

#[test]
fn needs_resolves_itself_and_finished_survives_a_new_turn() {
    let app = Instance::new();
    app.shell("agt");
    app.type_line("agt", r"printf '\033]7501;state=working\007'");
    app.wait_agent("agt", "working", |a| a["state"] == "working");
    app.type_line("agt", r"printf '\033]7501;state=blocked\007'");
    let agent = app.wait_agent("agt", "needs", |a| a["pending"]["needs"].is_object());
    assert_eq!(app.rpc("status", json!({}))["agentAttention"]["pendingAlerts"], 1);
    // The agent unblocks by itself: needs leaves without anyone marking it.
    app.type_line("agt", r"printf '\033]7501;state=working\007'");
    let agent2 = app.wait_agent("agt", "unblocked", |a| a["state"] == "working");
    assert_eq!(pending(&agent2), Vec::<String>::new(), "needs is superseded when the agent unblocks");
    assert_eq!(seq(&agent2), seq(&agent));
    assert_eq!(app.rpc("status", json!({}))["agentAttention"]["pendingAlerts"], 0);
    // End of turn, then a new turn nobody saw: finished stays.
    app.type_line("agt", r"printf '\033]7501;state=done\007'");
    app.wait_agent("agt", "finished", |a| a["pending"]["finished"].is_object());
    app.type_line("agt", r"printf '\033]7501;state=working\007'");
    let agent = app.wait_agent("agt", "working again", |a| a["state"] == "working");
    assert_eq!(pending(&agent), ["finished"]);
    // clear does not clear an unseen finish either.
    app.type_line("agt", r"printf '\033]7501;state=clear\007'");
    let agent = app.wait_agent("agt", "clear", |a| a["state"].is_null());
    assert_eq!(pending(&agent), ["finished"]);
}

#[test]
fn process_end_with_any_exit_code_is_one_ended_alert() {
    let app = Instance::new();
    for (id, code) in [("ok0", 0), ("err1", 1)] {
        app.shell(id);
        app.type_line(id, &format!("exit {code}"));
        let row = app.wait_row(id, "ended", |r| r["agent"]["pending"]["ended"].is_object());
        assert_eq!(row["status"], "exited", "{id}");
        assert_eq!(pending(&row["agent"]), ["ended"]);
        assert!(row["agent"]["pending"]["ended"]["frame"].is_null(), "ended has no frame: never auto-seen");
    }
}

#[test]
fn two_clients_race_and_seen_survives_restart_without_replaying_alerts() {
    let mut app = Instance::new();
    app.shell("two");
    app.type_line("two", r"printf '\007'");
    let painted = app.wait_agent("two", "bell", |a| a["pending"]["bell"].is_object());
    let epoch = painted["epoch"].as_u64().unwrap();
    // A notify lands after client A painted the bell, before it marks.
    thread::sleep(Duration::from_millis(1100));
    app.type_line("two", r"printf '\033]9;nuevo\007'");
    app.wait_agent("two", "notify", |a| a["pending"]["notify"].is_object());
    let a = app.rpc("mark_seen", json!({"items":[{"id":"two","epoch":epoch,"through":seq(&painted)}]}));
    assert_eq!(pending(&a["items"][0]["agent"]), ["notify"], "seeing what was painted never hides the newer alert");
    // Client B saw everything; then A repeats its older mark: the maximum wins.
    let b = app.rpc("mark_seen", json!({"items":[{"id":"two","epoch":epoch,"through":u64::MAX}]}));
    assert_eq!(pending(&b["items"][0]["agent"]), Vec::<String>::new());
    let again = app.rpc("mark_seen", json!({"items":[{"id":"two","epoch":epoch,"through":1}]}));
    assert_eq!(again["items"][0]["agent"]["seenSeq"], b["items"][0]["agent"]["seenSeq"]);
    let total = seq(&b["items"][0]["agent"]);
    // Another session with an unseen BEL, then restart the runner.
    app.shell("unseen");
    app.type_line("unseen", r"printf '\007'");
    app.wait_agent("unseen", "bell", |a| a["pending"]["bell"].is_object());
    app.stop();
    app.launch();
    let status = app.rpc("status", json!({}));
    let find = |id: &str| status["sessions"].as_array().unwrap().iter().find(|r| r["id"] == id).cloned().unwrap();
    // Seen survives: the record is listed only when pending or live (both ended now).
    let two = find("two");
    let two_agent = &two["agent"];
    assert!(two_agent.is_null() || pending(two_agent).iter().all(|k| k == "ended"), "a seen bell/notify never comes back: {two_agent}");
    let unseen = find("unseen");
    assert!(unseen["agent"]["pending"]["bell"].is_object(), "an unseen BEL survives the restart");
    assert!(unseen["agent"]["pending"]["bell"]["frame"].is_null(), "old-generation frames are not offered for automatic seen");
    // Reading the whole history again (what a reconnecting client replays) raises nothing.
    let before = seq(&unseen["agent"]);
    let _ = app.try_rpc("terminal_live", json!({"id":"unseen","after":0,"limit":64}));
    let _ = app.try_rpc("events", json!({"after":0,"limit":1000}));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(seq(&app.row("unseen")["agent"]), before, "replayed history never raises alerts");
    let _ = total;
}

/// Terminar (stop RPC) is the person's own action: the runner must not answer
/// it with an unseen «Proceso terminó» (bell, Dock and macOS notice).
#[test]
fn terminar_requested_by_the_person_is_not_an_unseen_alert() {
    let app = Instance::new();
    app.shell("kill");
    app.settle("kill", "up");
    let result = app.rpc("stop", json!({"id":"kill"}));
    assert_eq!(result["status"], "stopped");
    let row = app.wait_row("kill", "stopped", |r| r["status"] == "stopped");
    thread::sleep(Duration::from_millis(300));
    let agent = &app.row("kill")["agent"];
    assert!(agent.is_null() || !agent["pending"]["ended"].is_object(), "stop raised an unseen ended alert: {}", row["agent"]);
    assert_eq!(app.rpc("status", json!({}))["agentAttention"]["pendingAlerts"], 0);
}

/// An unseen finish of a session the person then terminates is still theirs to see.
#[test]
fn terminar_keeps_earlier_unseen_alerts() {
    let app = Instance::new();
    app.shell("keep");
    app.type_line("keep", r"printf '\033]7501;state=working\007'; sleep 0.05; printf '\033]7501;state=done\007'");
    app.wait_agent("keep", "finished", |a| a["pending"]["finished"].is_object());
    app.rpc("stop", json!({"id":"keep"}));
    let agent = app.wait_agent("keep", "still finished", |a| a["pending"]["finished"].is_object());
    assert_eq!(pending(&agent), ["finished"]);
}

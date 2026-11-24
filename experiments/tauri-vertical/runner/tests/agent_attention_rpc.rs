//! Runner-side agent attention over the real socket protocol. Disposable data
//! dir, socket, token and HOME per instance; only `shell` (zsh -f) sessions.
//! Never a real profile or the live runner.
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Write}, os::unix::{fs::PermissionsExt, net::UnixStream}, path::PathBuf,
    process::{Child, Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};

struct Instance { root: tempfile::TempDir, child: Option<Child>, binary: PathBuf }

impl Instance {
    fn new() -> Self { Self::with_binary(PathBuf::from(env!("CARGO_BIN_EXE_aw-runner"))) }
    fn with_binary(binary: PathBuf) -> Self {
        assert!(binary.is_absolute());
        let root = tempfile::Builder::new().prefix("awaa-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        let mut instance = Self { root, child: None, binary };
        instance.launch();
        instance
    }
    fn path(&self, name: &str) -> PathBuf { self.root.path().join(name) }
    fn launch(&mut self) {
        let mut cmd = Command::new(&self.binary);
        cmd.arg("--data-dir").arg(self.path("data")).arg("--socket").arg(self.path("sock")).arg("--token-file").arg(self.path("token"));
        // Own HOME: nothing of the account's configuration is read.
        cmd.env("HOME", self.path("home")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        self.child = Some(cmd.spawn().unwrap());
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if self.path("token").exists() && self.try_rpc("status", json!({})).is_some() { break; }
            assert!(Instant::now() < end, "runner did not become ready");
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(), "runner exited at startup");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn raw(&self, request: Value) -> std::io::Result<(Value, usize)> {
        let mut stream = UnixStream::connect(self.path("sock"))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        serde_json::to_writer(&mut stream, &request)?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok((serde_json::from_str(&line)?, line.len()))
    }
    fn try_raw(&self, op: &str, args: Value) -> Option<(Value, usize)> {
        let token = fs::read_to_string(self.path("token")).ok()?;
        self.raw(json!({"version":1,"token":token,"op":op,"args":args})).ok()
    }
    fn try_rpc(&self, op: &str, args: Value) -> Option<Value> { self.try_raw(op, args).map(|(v, _)| v) }
    fn rpc(&self, op: &str, args: Value) -> Value {
        let response = self.try_rpc(op, args).unwrap_or_else(|| panic!("RPC {op}: transport failure"));
        assert_eq!(response["ok"], true, "RPC {op}: {}", response["error"]);
        response["result"].clone()
    }
    fn shell(&self, id: &str) {
        self.rpc("start", json!({"id":id,"title":id,"kind":"shell","rows":24,"cols":80}));
    }
    fn row(&self, id: &str) -> Value {
        self.rpc("status", json!({}))["sessions"].as_array().unwrap().iter().find(|v| v["id"] == id).cloned().unwrap_or(Value::Null)
    }
    fn wait_agent(&self, id: &str, what: &str, mut ok: impl FnMut(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let row = self.row(id);
            if ok(&row["agent"]) { return row["agent"].clone(); }
            assert!(Instant::now() < end, "timeout waiting for {what}: {}", row["agent"]);
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

const SENTINEL: &str = "SENTINEL-OSC-TITLE-7f3a";

#[test]
fn status_and_terminal_live_publish_state_with_frame_and_never_the_payload() {
    let app = Instance::new();
    let status = app.rpc("status", json!({}));
    assert_eq!(status["agentAttentionVersion"], 1);
    // Existing capability values are never raised (1.3.x compares === 1).
    for key in ["pulsoVersion", "pulsoBoardVersion", "terminalStreamVersion", "nativePermissionsVersion", "codexVersion"] { assert_eq!(status[key], 1, "{key}"); }
    assert_eq!(status["statusVersion"], 2);
    app.shell("s1");
    // The typed line is echoed as text ("\\033" literally), never as ESC.
    app.rpc("input", json!({"id":"s1","data":format!("printf '\\033]7501;state=working:title={SENTINEL}:msg={SENTINEL}\\007\\033]9;{SENTINEL}\\007'\n")}));
    let agent = app.wait_agent("s1", "working", |a| a["state"] == "working" && a["pending"]["notify"].is_object());
    assert_eq!(agent["turnOpen"], true);
    let frame = agent["stateFrame"].as_u64().unwrap();
    assert!(agent["pending"]["notify"]["frame"].as_u64().unwrap() >= frame);
    // The frame cursor points at the frame holding the completing byte.
    let page = app.rpc("terminal_live", json!({"id":"s1","after":frame - 1,"limit":1}));
    let data = STANDARD.decode(page["frames"][0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(page["frames"][0]["index"], frame);
    assert!(data.contains(&0x07), "completing BEL is in frame {frame}");
    assert_eq!(page["agent"]["state"], "working");
    assert!(page["agent"]["stateFrame"].as_u64().unwrap() <= page["lastFrame"].as_u64().unwrap() || page["hasMore"] == true);
    // Neither status nor the agent object carries the OSC title or message.
    let (status, bytes) = app.try_raw("status", json!({})).unwrap();
    assert!(!status.to_string().contains(SENTINEL));
    assert!(!page["agent"].to_string().contains(SENTINEL));
    let size = serde_json::to_vec(&status["result"]["sessions"][0]["agent"]).unwrap().len();
    eprintln!("agent object: {size} bytes; status response: {bytes} bytes");
    assert!(size < 400);
    // Seen through the painted seq; the second client's older value is a no-op.
    let through = agent["alertSeq"].as_u64().unwrap();
    let epoch = agent["epoch"].as_u64().unwrap();
    assert!(epoch > 0 && epoch < (1 << 53), "JavaScript-safe epoch");
    let seen = app.rpc("mark_seen", json!({"items":[{"id":"s1","epoch":epoch,"through":through}]}));
    assert_eq!(seen["durable"], true);
    assert_eq!(seen["items"][0]["agent"]["seenSeq"], through);
    assert!(seen["items"][0]["agent"]["pending"].as_object().unwrap().is_empty());
    let older = app.rpc("mark_seen", json!({"items":[{"id":"s1","epoch":epoch,"through":0},{"id":"missing-1","epoch":1,"through":9}]}));
    assert_eq!(older["items"][0]["agent"]["seenSeq"], through);
    assert_eq!(older["items"][1]["agent"], Value::Null);
    // Another incarnation's epoch has no effect and returns the current agent.
    app.rpc("input", json!({"id":"s1","data":"printf '\\007'\n"}));
    let agent = app.wait_agent("s1", "bell", |a| a["pending"]["bell"].is_object());
    let stale = app.rpc("mark_seen", json!({"items":[{"id":"s1","epoch":epoch ^ 1,"through":u64::MAX}]}));
    assert_eq!(stale["items"][0]["rejected"], "epoch");
    assert_eq!(stale["items"][0]["agent"]["seenSeq"], agent["seenSeq"]);
}

#[test]
fn mark_seen_rejects_every_other_shape() {
    let app = Instance::new();
    for bad in [json!({}), json!({"items":[]}), json!({"items":[{"id":"a"}]}), json!({"items":[{"id":"a","through":1}]}),
        json!({"items":[{"id":"a","epoch":1,"through":-1}]}), json!({"items":[{"id":"a","epoch":0,"through":1}]}),
        json!({"items":[{"id":"../x","epoch":1,"through":1}]}), json!({"items":[{"id":"a","epoch":1,"through":1}],"extra":1}),
        json!({"items":[{"id":"a","epoch":1,"through":"1"}]}),
        json!({"items":(0..65).map(|i| json!({"id":format!("s{i}"),"epoch":1,"through":1})).collect::<Vec<_>>()})] {
        let response = app.try_rpc("mark_seen", bad.clone()).unwrap();
        assert_eq!(response["ok"], false, "{bad}");
    }
}

#[test]
fn status_keeps_agent_while_the_database_is_locked() {
    let app = Instance::new();
    app.shell("busy");
    app.rpc("status", json!({}));
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    app.rpc("input", json!({"id":"busy","data":"printf '\\033]7501;state=blocked\\007'\n"}));
    let started = Instant::now();
    let agent = app.wait_agent("busy", "blocked under lock", |a| a["state"] == "blocked");
    assert_eq!(agent["pending"]["needs"]["seq"], 1);
    let status = app.rpc("status", json!({}));
    assert_eq!(status["agentAttention"]["pendingAlerts"], 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    // mark_seen still answers, honestly not durable while the lock is held.
    let item = json!({"id":"busy","epoch":agent["epoch"],"through":1});
    let seen = app.rpc("mark_seen", json!({"items":[item.clone()]}));
    assert_eq!(seen["durable"], false);
    db.execute_batch("ROLLBACK").unwrap();
    let seen = app.rpc("mark_seen", json!({"items":[item]}));
    assert_eq!(seen["durable"], true);
}

#[test]
fn process_end_closes_the_turn_and_unseen_alerts_survive_a_restart() {
    let mut app = Instance::new();
    app.shell("w");
    app.rpc("input", json!({"id":"w","data":"printf '\\033]7501;state=working\\007'; sleep 0.2; exit\n"}));
    let agent = app.wait_agent("w", "ended", |a| a["pending"]["ended"].is_object());
    assert_eq!(agent["turnInterrupted"], true);
    assert!(agent["lastTurnMs"].as_u64().unwrap() >= 150);
    assert!(agent["state"].is_null());
    app.shell("b");
    app.rpc("input", json!({"id":"b","data":"printf '\\033]7501;state=blocked\\007'\n"}));
    app.wait_agent("b", "blocked", |a| a["state"] == "blocked");
    app.stop();
    app.launch();
    let status = app.rpc("status", json!({}));
    let rows = status["sessions"].as_array().unwrap();
    let w = &rows.iter().find(|r| r["id"] == "w").unwrap()["agent"];
    assert_eq!(w["pending"]["ended"]["seq"], agent["pending"]["ended"]["seq"]);
    let b = &rows.iter().find(|r| r["id"] == "b").unwrap()["agent"];
    assert!(b["state"].is_null(), "no PTY survives a restart");
    // The orderly restart stopped it: its needs left with the process and the end is the unseen alert.
    assert!(b["pending"].get("needs").is_none(), "a dead process no longer asks for the person");
    assert!(b["pending"]["ended"]["seq"].as_u64().unwrap() > 0);
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
}

/// Opt-in: 50 MB of PTY output with OSC/CSI noise while resize runs
/// concurrently. AGENT_BASELINE_RUNNER=/abs/path/to/older/aw-runner compares.
/// cargo test --release --test agent_attention_rpc -- --ignored --nocapture
#[test]
#[ignore]
fn burst_with_concurrent_resize_latency() {
    let mut runs = vec![("current", PathBuf::from(env!("CARGO_BIN_EXE_aw-runner")))];
    if let Some(path) = std::env::var_os("AGENT_BASELINE_RUNNER") {
        // Alternate the order to expose machine noise (AGENT_BASELINE_LAST=1).
        let at = if std::env::var_os("AGENT_BASELINE_LAST").is_some() { 1 } else { 0 };
        runs.insert(at, ("baseline", PathBuf::from(path)));
    }
    for (name, binary) in runs {
        for round in 0..3 {
            let app = Arc::new(Instance::with_binary(binary.clone()));
            app.shell("burst");
            thread::sleep(Duration::from_millis(200));
            let done = Arc::new(AtomicBool::new(false));
            let resizer = { let app = app.clone(); let done = done.clone(); thread::spawn(move || {
                let mut samples = Vec::new();
                let mut cols = 80;
                // AGENT_BENCH_NO_RESIZE=1 isolates the reader's own throughput.
                let enabled = std::env::var_os("AGENT_BENCH_NO_RESIZE").is_none();
                while enabled && !done.load(Ordering::Acquire) {
                    cols = if cols == 80 { 100 } else { 80 };
                    let at = Instant::now();
                    let response = app.try_rpc("resize", json!({"id":"burst","rows":24,"cols":cols}));
                    if response.is_some_and(|r| r["ok"] == true) { samples.push(at.elapsed().as_secs_f64() * 1000.0); }
                    thread::sleep(Duration::from_millis(5));
                }
                samples
            }) };
            let started = Instant::now();
            app.rpc("input", json!({"id":"burst","data":"yes \"$(printf '\\033[32mok\\033[0m \\033]7501;state=working\\007 compiling crate 42%%')\" | head -c 52428800; exit\n"}));
            let end = Instant::now() + Duration::from_secs(300);
            loop {
                let row = app.row("burst");
                if matches!(row["status"].as_str(), Some("exited" | "stopped" | "failed" | "needs_attention")) { break; }
                assert!(Instant::now() < end, "burst did not finish");
                thread::sleep(Duration::from_millis(50));
            }
            let total = started.elapsed().as_secs_f64();
            done.store(true, Ordering::Release);
            let mut samples = resizer.join().unwrap();
            samples.sort_by(f64::total_cmp);
            if samples.is_empty() { samples.push(f64::NAN); }
            let pick = |q: f64| samples[((samples.len() as f64 * q) as usize).min(samples.len() - 1)];
            eprintln!("{name} round {round}: 50 MiB in {total:.2}s, resize n={} p50={:.2}ms p99={:.2}ms max={:.2}ms, final={}",
                samples.len(), pick(0.5), pick(0.99), samples[samples.len() - 1], app.row("burst")["status"]);
        }
    }
}

fn attention_rows(app: &Instance) -> Vec<String> {
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    db.prepare("SELECT * FROM agent_attention ORDER BY session_id").unwrap()
        .query_map([], |r| Ok((0..25).map(|i| format!("{:?}", r.get_ref(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

/// Release checklist step (docs/DEVELOPMENT.md): a 1.4 profile with
/// agent_attention opens in the previous release's runner, which purges and
/// compacts a final session without touching the table; 1.4 then reopens it.
/// JAURIA_PREVIOUS_RUNNER=/abs/path/to/v1.3.3/aw-runner \
///   cargo test --test agent_attention_rpc rollback -- --ignored --nocapture
#[test]
#[ignore]
fn rollback_to_previous_runner_keeps_rows_and_schema_version() {
    let previous = PathBuf::from(std::env::var_os("JAURIA_PREVIOUS_RUNNER").expect("JAURIA_PREVIOUS_RUNNER"));
    let mut app = Instance::new();
    app.shell("done1");
    app.rpc("input", json!({"id":"done1","data":"printf '\\033]7501;state=working\\007'; sleep 0.1; printf '\\033]7501;state=done\\007\\007'; sleep 0.1; exit\n"}));
    app.wait_agent("done1", "ended", |a| a["pending"]["ended"].is_object() && a["pending"]["finished"].is_object());
    app.shell("live1");
    app.rpc("input", json!({"id":"live1","data":"printf '\\033]7501;state=blocked\\007'\n"}));
    app.wait_agent("live1", "blocked", |a| a["state"] == "blocked");
    app.stop();
    let before = attention_rows(&app);
    assert_eq!(before.len(), 2);
    // Previous runner: same disposable data dir, socket, token and HOME.
    app.binary = previous;
    app.launch();
    let status = app.rpc("status", json!({}));
    assert!(status.get("agentAttentionVersion").is_none(), "this must be the previous runner");
    assert!(status["sessions"].as_array().unwrap().iter().all(|r| r.get("agent").is_none()));
    let purged = app.rpc("purge_history", json!({"id":"done1","confirmed":true}));
    let compacted = app.rpc("compact_history", json!({"id":"done1","confirmed":true}));
    eprintln!("previous runner: purge {} ranges, compaction {} ranges", purged["purgedRanges"], compacted["purgedRanges"]);
    app.stop();
    assert_eq!(attention_rows(&app), before, "previous runner left agent_attention untouched");
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
    drop(db);
    // Back to this runner: rows intact, unseen alerts still pending.
    app.binary = PathBuf::from(env!("CARGO_BIN_EXE_aw-runner"));
    app.launch();
    let status = app.rpc("status", json!({}));
    let agent = |id: &str| status["sessions"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap()["agent"].clone();
    assert!(agent("done1")["pending"]["ended"].is_object() && agent("done1")["pending"]["finished"].is_object());
    assert!(agent("live1")["pending"]["needs"].is_object());
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('sessions','events')", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
    eprintln!("rollback: {} rows kept across the previous runner", before.len());
}

#[test]
fn concurrent_mark_seen_never_starves_status_or_stop() {
    let app = Arc::new(Instance::new());
    app.shell("victim");
    app.rpc("input", json!({"id":"victim","data":"printf '\\007'\n"}));
    app.wait_agent("victim", "bell", |a| a["pending"]["bell"].is_object());
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let callers: Vec<_> = (0..20).map(|_| { let app = app.clone(); thread::spawn(move || {
        let agent = app.row("victim")["agent"].clone();
        let mut item = json!({"id":"victim","through":1});
        if let Some(epoch) = agent.get("epoch") { item["epoch"] = epoch.clone(); }
        app.try_rpc("mark_seen", json!({"items":[item]}))
    }) }).collect();
    thread::sleep(Duration::from_millis(150));
    let started = Instant::now();
    assert_eq!(app.try_rpc("status", json!({})).map(|r| r["ok"] == true), Some(true), "status lost its slot");
    assert_eq!(app.try_rpc("stop", json!({"id":"victim"})).map(|r| r["ok"] == true), Some(true), "stop lost its slot");
    assert!(started.elapsed() < Duration::from_secs(3));
    for caller in callers { let _ = caller.join(); }
    db.execute_batch("ROLLBACK").unwrap();
}

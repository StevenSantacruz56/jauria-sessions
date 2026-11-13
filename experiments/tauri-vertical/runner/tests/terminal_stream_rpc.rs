//! Real fixture PTY regression tests for terminalStreamVersion 1.
//!
//! The live ring (terminal_live) must keep serving output, input, resize,
//! interrupt and stop while the durable archive (provider events tagged
//! `jauria/terminalFrames`) is rejected by quota or fails outright. Durable
//! history is then reported as not complete; process truth is unchanged.
//!
//! Assumptions (documented where used):
//! - Frame indices are positive and strictly increasing; `after:0` reads from
//!   the oldest retained frame; frames returned satisfy `index > after`.
//! - `gap` describes frames evicted from the ring; reading resumes after
//!   `gap.lastFrame`.
//! - A healthy active archive reports `recording`; `complete` is reserved for
//!   a durably closed stream. Quota and I/O errors are independent of status. A quota rejection mentions "quota" in `history.reason`; an
//!   injected writer error does not.
//! - terminal_live keeps answering for exited/stopped sessions owned by the
//!   current runner generation.
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Write}, os::unix::{fs::PermissionsExt, net::UnixStream}, path::PathBuf, process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

const LIVE_LIMIT: usize = 64;
const MAX_RESPONSE: usize = 256 * 1024;
const WAIT: Duration = Duration::from_secs(15);
const HISTORY_COMPLETE: &str = "complete";
const FLOOD_X: usize = 5 * 1024 * 1024;

struct Instance {
    root: tempfile::TempDir,
    child: Option<Child>,
}

impl Instance {
    fn new() -> Self {
        let mut instance = Self { root: tempfile::Builder::new().prefix("awts-").tempdir_in("/tmp").unwrap(), child: None };
        fs::set_permissions(instance.root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        instance.launch();
        let status=instance.rpc("status", json!({}));
        assert_eq!(status["terminalStreamVersion"], 1);
        assert_eq!(status["runnerVersion"], env!("CARGO_PKG_VERSION"));
        instance
    }
    fn path(&self, name: &str) -> PathBuf { self.root.path().join(name) }
    fn launch(&mut self) {
        let executable=std::env::var_os("JAURIA_TEST_RUNNER").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_BIN_EXE_aw-runner")));
        assert!(executable.is_absolute(),"test runner must use an absolute path");
        let mut cmd = Command::new(executable);
        cmd.arg("--data-dir").arg(self.path("data")).arg("--socket").arg(self.path("sock")).arg("--token-file").arg(self.path("token"));
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
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
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        serde_json::to_writer(&mut stream, &request)?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok((serde_json::from_str(&line)?, line.len()))
    }
    /// The token is read per request and never included in any message.
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
    fn start(&self, id: &str) -> Value {
        self.rpc("start", json!({"id":id,"title":id,"kind":"fixture","rows":24,"cols":80}))
    }
    fn session(&self, id: &str) -> Value {
        self.rpc("status", json!({}))["sessions"].as_array().unwrap().iter().find(|v| v["id"] == id).unwrap().clone()
    }
    fn input(&self, id: &str, data: &str) { self.rpc("input", json!({"id":id,"data":data})); }
    fn alive(&mut self) -> bool { self.child.as_mut().unwrap().try_wait().unwrap().is_none() }
    fn db(&self) -> Connection {
        let db = Connection::open(self.path("data/runner.sqlite")).unwrap();
        db.busy_timeout(Duration::from_secs(5)).unwrap();
        db
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // Graceful shutdown, then kill/wait only our own child; never a persisted PID.
        if self.child.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none()) {
            let _ = self.try_rpc("shutdown", json!({}));
            let end = Instant::now() + Duration::from_secs(5);
            let child = self.child.as_mut().unwrap();
            while child.try_wait().ok().flatten().is_none() && Instant::now() < end { thread::sleep(Duration::from_millis(10)); }
            if child.try_wait().ok().flatten().is_none() { let _ = child.kill(); }
            let _ = child.wait();
        }
    }
}

/// Incremental terminal_live reader for one session.
struct Live {
    id: String,
    after: i64,
    generation: Option<Value>,
    output: Vec<u8>,
    gaps: Vec<(i64, i64)>,
    last: Value,
}

impl Live {
    fn new(id: &str) -> Self {
        Self { id: id.into(), after: 0, generation: None, output: Vec::new(), gaps: Vec::new(), last: Value::Null }
    }
    /// Drains all currently available pages, validating bounds and ordering.
    fn poll(&mut self, app: &Instance) -> &Value {
        let end = Instant::now() + WAIT;
        loop {
            let (response, bytes) = app.try_raw("terminal_live", json!({"id":self.id,"after":self.after,"limit":LIVE_LIMIT}))
                .unwrap_or_else(|| panic!("terminal_live {}: transport failure", self.id));
            assert!(bytes <= MAX_RESPONSE, "terminal_live {} response {bytes} bytes exceeds 256KiB", self.id);
            assert_eq!(response["ok"], true, "terminal_live {}: {}", self.id, response["error"]);
            let page = response["result"].clone();
            assert!(!page["generation"].is_null(), "generation missing for {}", self.id);
            let generation = self.generation.get_or_insert_with(|| page["generation"].clone()).clone();
            assert_eq!(page["generation"], generation, "live generation changed for {}", self.id);
            for key in ["firstFrame", "lastFrame", "durableFrame"] { assert!(page[key].is_i64(), "{key} missing: {page}"); }
            assert!(page["session"].is_object() && page["history"].is_object());
            let before = self.after;
            if !page["gap"].is_null() {
                let (first, last) = (page["gap"]["firstFrame"].as_i64().unwrap(), page["gap"]["lastFrame"].as_i64().unwrap());
                assert!(first > self.after && first <= last, "invalid gap {first}..{last} after {}", self.after);
                self.gaps.push((first, last));
                self.after = last;
            }
            let frames = page["frames"].as_array().unwrap();
            assert!(frames.len() <= LIVE_LIMIT);
            for frame in frames {
                let index = frame["index"].as_i64().unwrap();
                assert!(index > self.after, "frame {index} not after {}", self.after);
                self.after = index;
                match frame["kind"].as_str().unwrap() {
                    "output" => self.output.extend(STANDARD.decode(frame["data"].as_str().unwrap()).unwrap()),
                    "resize" | "state" => assert!(frame["data"].is_object(), "{frame}"),
                    other => panic!("unexpected frame kind {other}"),
                }
            }
            assert!(self.after <= page["lastFrame"].as_i64().unwrap());
            let more = page["hasMore"] == true;
            self.last = page;
            if !more { break; }
            assert!(self.after > before, "hasMore without progress");
            assert!(Instant::now() < end, "terminal_live {} never drained", self.id);
        }
        &self.last
    }
    fn contains_from(&self, mark: usize, text: &str) -> bool {
        self.output.get(mark..).is_some_and(|tail| tail.windows(text.len()).any(|w| w == text.as_bytes()))
    }
    fn wait_text(&mut self, app: &Instance, mark: usize, text: &str) {
        let end = Instant::now() + WAIT;
        loop {
            self.poll(app);
            if self.contains_from(mark, text) { return; }
            assert!(Instant::now() < end, "timed out waiting for live {text:?} on {}", self.id);
            thread::sleep(Duration::from_millis(25));
        }
    }
    /// Sends `ping` and confirms a fresh PONG through the live ring only.
    fn ping(&mut self, app: &Instance) {
        self.poll(app);
        let mark = self.output.len();
        app.input(&self.id, "ping\n");
        let needle = format!("PONG {}", self.id);
        self.wait_text(app, mark, &needle);
    }
    fn wait_page(&mut self, app: &Instance, what: &str, mut predicate: impl FnMut(&Value) -> bool) -> Value {
        let end = Instant::now() + WAIT;
        loop {
            let page = self.poll(app).clone();
            if predicate(&page) { return page; }
            assert!(Instant::now() < end, "timed out waiting for {what} on {}: {}", self.id, page["history"]);
            thread::sleep(Duration::from_millis(25));
        }
    }
    /// Awaits the archive writer persisting everything seen so far (it batches
    /// 64KiB/250ms, so a flush is never assumed to be immediate).
    fn await_durable(&mut self, app: &Instance) {
        let target = self.poll(app)["lastFrame"].as_i64().unwrap();
        self.wait_page(app, "durable archive", |p| {
            matches!(p["history"]["state"].as_str(),Some("recording"|"complete")) && p["history"]["durableFrame"].as_i64().unwrap() >= target
        });
    }
}

fn reason(history: &Value) -> String { history["reason"].as_str().unwrap_or("").to_lowercase() }
fn degraded(history: &Value) -> bool { matches!(history["state"].as_str(),Some("limited"|"error"|"incomplete"|"unknown_tail")) }

fn ready(app: &Instance, id: &str) -> Live {
    app.start(id);
    let mut live = Live::new(id);
    live.wait_text(app, 0, &format!("READY {id} isatty=true"));
    assert_eq!(app.session(id)["terminalStream"]["generation"], *live.generation.as_ref().unwrap());
    live
}

#[test]
fn row_quota_keeps_live_input_resize_and_admits_new_native_session() {
    let mut app = Instance::new();
    let mut a = ready(&app, "rows-a");
    let mut b = ready(&app, "rows-b");
    a.await_durable(&app);
    b.await_durable(&app);
    let (gen_a, gen_b) = (a.generation.clone(), b.generation.clone());
    app.db().execute("UPDATE storage_meta SET max_event_rows=event_rows+lifecycle_reserve_rows WHERE singleton=1", []).unwrap();
    a.ping(&app);
    b.ping(&app);
    for live in [&mut a, &mut b] {
        let page = live.wait_page(&app, "row quota", |p| degraded(&p["history"]) && reason(&p["history"]).contains("quota"));
        assert_eq!(page["session"]["status"], "running");
    }
    assert_eq!((a.generation.clone(), b.generation.clone()), (gen_a.clone(), gen_b));
    // Resize at quota still applies to the PTY and reports actual geometry.
    assert_eq!(app.rpc("resize", json!({"id":"rows-a","rows":35,"cols":111})), json!({"rows":35,"cols":111}));
    let mark = a.output.len();
    app.input("rows-a", "size\n");
    a.wait_text(&app, mark, "SIZE rows-a 35 111");
    // Lifecycle/metadata stays writable: stop frees a slot for a new native session.
    assert_eq!(app.rpc("stop", json!({"id":"rows-b"}))["status"], "stopped");
    let mut c = ready(&app, "rows-c");
    c.ping(&app);
    a.ping(&app);
    assert_eq!(a.generation, gen_a);
    assert_eq!(app.session("rows-a")["status"], "running");
    assert!(app.alive());
    for id in ["rows-a", "rows-c"] { assert_eq!(app.rpc("stop", json!({"id":id}))["status"], "stopped"); }
}

#[test]
fn byte_quota_keeps_live_and_stop_with_incomplete_final_history() {
    let mut app = Instance::new();
    let mut live = ready(&app, "bytes");
    live.await_durable(&app);
    let generation = live.generation.clone();
    app.db().execute("UPDATE storage_meta SET max_output_encoded_bytes=output_encoded_bytes WHERE singleton=1", []).unwrap();
    live.ping(&app);
    let page = live.wait_page(&app, "byte quota", |p| degraded(&p["history"]) && reason(&p["history"]).contains("quota"));
    assert_eq!(page["session"]["status"], "running");
    live.ping(&app);
    assert_eq!(app.rpc("stop", json!({"id":"bytes"}))["status"], "stopped");
    // Process truth is stopped; durable truth stays not complete.
    let page = live.wait_page(&app, "stopped", |p| p["session"]["status"] == "stopped");
    assert!(degraded(&page["history"]), "{}", page["history"]);
    let session = app.session("bytes");
    assert_eq!(session["status"], "stopped");
    assert_ne!(session["terminalStream"]["history"]["state"], HISTORY_COMPLETE);
    assert_eq!(live.generation, generation);
    assert!(app.alive());
}

#[test]
fn archive_writer_failure_is_error_not_quota_and_interrupt_stop_still_work() {
    let mut app = Instance::new();
    let mut a = ready(&app, "fail-a");
    let mut b = ready(&app, "fail-b");
    a.await_durable(&app);
    b.await_durable(&app);
    let (gen_a, gen_b) = (a.generation.clone(), b.generation.clone());
    app.db().execute_batch("CREATE TRIGGER inject_archive_failure AFTER INSERT ON events WHEN NEW.kind='provider' \
        BEGIN SELECT RAISE(ABORT,'injected archive failure'); END;").unwrap();
    a.ping(&app);
    b.ping(&app);
    for live in [&mut a, &mut b] {
        let page = live.wait_page(&app, "archive error", |p| degraded(&p["history"]));
        assert!(!reason(&page["history"]).contains("quota"), "writer error misreported as quota: {}", page["history"]);
        assert_eq!(page["session"]["status"], "running");
    }
    // Not a quota condition: the injected failure must not flip output_rejected.
    let rejected: bool = app.db().query_row("SELECT output_rejected FROM storage_meta WHERE singleton=1", [], |r| r.get(0)).unwrap();
    assert!(!rejected);
    a.ping(&app);
    app.rpc("interrupt", json!({"id":"fail-a"}));
    a.wait_page(&app, "interrupt exit", |p| p["session"]["status"] == "exited");
    assert_eq!(app.rpc("stop", json!({"id":"fail-b"}))["status"], "stopped");
    b.wait_page(&app, "stopped", |p| p["session"]["status"] == "stopped" && degraded(&p["history"]));
    assert_eq!((a.generation.clone(), b.generation.clone()), (gen_a, gen_b));
    assert_eq!(app.session("fail-a")["status"], "exited");
    assert!(app.alive());
}

#[test]
fn flood_live_poll_is_bounded_reports_gaps_and_other_fixture_stays_responsive() {
    let mut app = Instance::new();
    let mut flood = ready(&app, "flood");
    let mut other = ready(&app, "calm");
    let other_mark = { other.poll(&app); other.output.len() };
    let flood_mark = flood.output.len();
    app.input("flood", "flood\n");
    app.input("calm", "ping\n");
    // Interleave both readers: the calm fixture must answer during the flood.
    let end = Instant::now() + WAIT;
    let (mut flood_done, mut pong) = (false, false);
    while !(flood_done && pong) {
        flood.poll(&app);
        other.poll(&app);
        flood_done = flood.contains_from(flood_mark, "FLOOD_END flood");
        pong = other.contains_from(other_mark, "PONG calm");
        assert!(Instant::now() < end, "flood_done={flood_done} pong={pong} gaps={:?}", flood.gaps);
        thread::sleep(Duration::from_millis(5));
    }
    let xs = flood.output[flood_mark..].iter().filter(|&&b| b == b'X').count();
    if flood.gaps.is_empty() {
        assert_eq!(xs, FLOOD_X, "no gap reported but flood payload incomplete");
    } else {
        // Ring eviction is explicit: missing payload is accounted for by gaps.
        assert!(xs < FLOOD_X);
        assert!(flood.gaps.windows(2).all(|w| w[0].1 < w[1].0));
    }
    assert!(other.gaps.is_empty(), "calm fixture lost live frames: {:?}", other.gaps);
    flood.ping(&app);
    other.ping(&app);
    for id in ["flood", "calm"] {
        assert_eq!(app.session(id)["status"], "running");
        assert_eq!(app.rpc("stop", json!({"id":id}))["status"], "stopped");
    }
    assert!(app.alive());
}

#[test]
fn temporary_sqlite_write_lock_preserves_recording_and_fast_owned_controls() {
    let app=Instance::new();
    let mut a=ready(&app,"busy-a");
    let mut b=ready(&app,"busy-b");
    a.await_durable(&app);b.await_durable(&app);
    let lock=app.db();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    // A geometry barrier makes the archive writer encounter the held lock now,
    // rather than after the ordinary 250 ms archival batching interval.
    app.rpc("resize",json!({"id":"busy-a","rows":35,"cols":111}));
    thread::sleep(Duration::from_millis(120));
    let begin=Instant::now();
    a.ping(&app);
    assert!(begin.elapsed()<Duration::from_secs(1),"live input waited behind archive lock");
    let begin=Instant::now();
    assert_eq!(app.rpc("stop",json!({"id":"busy-b"}))["status"],"stopped");
    assert!(begin.elapsed()<Duration::from_secs(1),"stop waited behind archive lock");
    lock.execute_batch("COMMIT").unwrap();
    a.await_durable(&app);
    assert_eq!(a.last["history"]["state"],"recording");
    assert!(a.last["history"]["reason"].is_null(),"transient lock poisoned history");
    b.wait_page(&app,"durable clean end after lock",|p|p["history"]["state"]=="complete");
    assert_eq!(app.rpc("stop",json!({"id":"busy-a"}))["status"],"stopped");
}

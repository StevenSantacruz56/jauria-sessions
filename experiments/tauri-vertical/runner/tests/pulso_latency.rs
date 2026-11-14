//! Opt in: cargo test --test pulso_latency -- --ignored --nocapture
//! Same binary, synthetic profiles, no providers or network. Timing distributions
//! are observations; only delivery and the explicit one-second control budget
//! are assertions. The benchmark is deliberately excluded from normal CI.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Client { socket: PathBuf, token: String }
impl Client {
    fn request(&self, op: &str, args: Value) -> io::Result<Value> {
        let mut stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        serde_json::to_writer(&mut stream, &json!({"version":1,"token":self.token,"op":op,"args":args}))?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(stream).take(2 * 1024 * 1024).read_line(&mut line)?;
        if !line.ends_with('\n') { return Err(io::Error::other("incomplete RPC reply")); }
        let reply: Value = serde_json::from_str(&line)?;
        if reply["ok"] != true { return Err(io::Error::other(format!("{op} rejected"))); }
        Ok(reply["result"].clone())
    }
    fn rpc(&self, op: &str, args: Value) -> Value {
        self.request(op, args).expect("synthetic fixture RPC failed")
    }
}
struct Fixture { root: tempfile::TempDir, child: Child, core: Client, pulso: Client }
impl Fixture {
    fn open() -> Self {
        let root = tempfile::Builder::new().prefix("pulso-lat-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        for dir in ["tmp", "home"] {
            fs::create_dir(root.path().join(dir)).unwrap();
            fs::set_permissions(root.path().join(dir), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let child = Command::new(env!("CARGO_BIN_EXE_aw-runner"))
            .arg("--data-dir").arg(root.path().join("data"))
            .arg("--socket").arg(root.path().join("tmp/sock"))
            .arg("--token-file").arg(root.path().join("tmp/token"))
            .env("HOME", root.path().join("home"))
            .env("XDG_CONFIG_HOME", root.path().join("home/config"))
            .env("XDG_DATA_HOME", root.path().join("home/data"))
            .env("TMPDIR", root.path().join("tmp"))
            .current_dir(root.path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let mut app = Self {
            core: Client { socket: root.path().join("tmp/sock"), token: String::new() },
            pulso: Client { socket: root.path().join("tmp/pulso.sock"), token: String::new() }, root, child,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let (Ok(core), Ok(pulso)) = (
                fs::read_to_string(app.root.path().join("tmp/token")),
                fs::read_to_string(app.root.path().join("tmp/pulso.token")),
            ) {
                app.core.token = core;
                app.pulso.token = pulso;
                if app.core.request("status", json!({})).is_ok_and(|s| s["pulsoAvailable"] == true) { break; }
            }
            assert!(app.child.try_wait().unwrap().is_none(), "runner exited at startup");
            assert!(Instant::now() < deadline, "runner startup timeout");
            thread::sleep(Duration::from_millis(10));
        }
        app
    }
    fn await_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "runner shutdown timeout");
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            // SIGTERM reaches the owned runner's normal fixture cleanup path.
            unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM); }
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); }
        }
        let _ = self.child.wait();
    }
}

struct Load {
    stop: Arc<AtomicBool>,
    writes: Arc<AtomicUsize>,
    worker: Option<JoinHandle<io::Result<()>>>,
    // Partial requests and peers that never read replies only occupy Pulso's socket.
    slow: Vec<UnixStream>,
    slow_worker: Option<JoinHandle<()>>,
}
impl Load {
    fn start(client: Client, revision: Value) -> Self {
        let mut slow = Vec::new();
        for i in 0..8 {
            let mut stream = UnixStream::connect(&client.socket).unwrap();
            stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
            if i < 4 {
                stream.write_all(b"{\"version\":1,").unwrap();
            } else {
                serde_json::to_writer(&mut stream, &json!({"version":1,"token":client.token,"op":"items","args":{"projectId":"load-project","limit":100}})).unwrap();
                stream.write_all(b"\n").unwrap();
            }
            slow.push(stream);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let writes = Arc::new(AtomicUsize::new(0));
        let slow_stop=stop.clone();let slow_socket=client.socket.clone();
        let slow_worker=thread::spawn(move||{
            while !slow_stop.load(Ordering::Acquire){
                let mut peers=Vec::new();
                for _ in 0..4 {if let Ok(mut peer)=UnixStream::connect(&slow_socket){let _=peer.set_write_timeout(Some(Duration::from_millis(100)));let _=peer.write_all(b"{\"version\":1,");peers.push(peer);}}
                for _ in 0..80 {if slow_stop.load(Ordering::Acquire){return;}thread::sleep(Duration::from_millis(10));}
                drop(peers);thread::sleep(Duration::from_millis(30));
            }
        });
        let worker_stop = stop.clone();
        let worker_writes = writes.clone();
        let worker = thread::spawn(move || {
            let mut revision = revision;
            let mut sequence = 0;
            let mut failures=0;
            while !worker_stop.load(Ordering::Acquire) {
                let result = (|| -> io::Result<()> {
                    client.request("items", json!({"projectId":"load-project","limit":100}))?;
                    let updated = client.request("item_update", json!({"id":"load-000","requestId":format!("load-update-{sequence}"),"expectedRevision":revision,"note":format!("Synthetic write {sequence}")}))?;
                    revision = updated["item"]["revision"].clone();
                    worker_writes.fetch_add(1, Ordering::Release);
                    sequence += 1;
                    Ok(())
                })();
                if let Err(error) = result {
                    if worker_stop.load(Ordering::Acquire) { return Ok(()); }
                    failures+=1;if failures>100{return Err(error);}
                    // Admission exhaustion is expected during the initial burst.
                    // Retain revision/requestId/payload on retry after uncertain IO.
                    thread::sleep(Duration::from_millis(20));continue;
                }
                // Five writes/sec at most, cancellation checked every 10 ms.
                for _ in 0..20 {
                    if worker_stop.load(Ordering::Acquire) { return Ok(()); }
                    thread::sleep(Duration::from_millis(10));
                }
            }
            Ok(())
        });
        Self { stop, writes, worker: Some(worker), slow, slow_worker:Some(slow_worker) }
    }
    fn finish(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.slow.clear();
        if let Some(worker)=self.slow_worker.take(){let _=worker.join();}
        if let Some(worker) = self.worker.take() {
            worker.join().expect("load thread panicked").expect("Pulso load failed");
        }
    }
}
impl Drop for Load {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.slow.clear();
        if let Some(worker)=self.slow_worker.take(){let _=worker.join();}
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}
fn summary(mut samples: Vec<f64>) -> Value {
    samples.sort_by(f64::total_cmp);
    json!({"n":samples.len(),"medianMs":samples[samples.len()/2],"p95Ms":samples[(samples.len()*95).div_ceil(100)-1]})
}
fn ms(at: Instant) -> f64 { at.elapsed().as_secs_f64() * 1000.0 }
fn measure(core: &Client, sessions: usize, phase: &str) -> Value {
    let mut cursors = vec![0u64; sessions];
    let mut pending = vec![String::new(); sessions];
    let mut ack = Vec::new();
    let mut echo = Vec::new();
    let mut status_times = Vec::new();
    for sample in 0..80 {
        let index = sample % sessions;
        let id = format!("fixture-{index}");
        let marker = format!("PULSO_CHILD_{phase}_{sample:04}");
        let at = Instant::now();
        core.rpc("status", json!({}));
        status_times.push(ms(at));
        let at = Instant::now();
        core.rpc("input", json!({"id":id,"data":format!("echo {marker}\n")}));
        ack.push(ms(at));
        loop {
            let page = core.rpc("terminal_live", json!({"id":id,"after":cursors[index],"limit":64}));
            for frame in page["frames"].as_array().unwrap() {
                let frame_index = frame["index"].as_u64().unwrap();
                assert!(frame_index > cursors[index], "duplicate or reordered frame");
                cursors[index] = frame_index;
                if frame["kind"] == "output" {
                    let bytes = STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
                    pending[index].push_str(std::str::from_utf8(&bytes).unwrap());
                }
            }
            let mut delivered = 0;
            while let Some(newline) = pending[index].find('\n') {
                let line: String = pending[index].drain(..=newline).collect();
                // The PTY echoes "echo MARKER". Only the child prints MARKER.
                if line.trim_end_matches(['\r', '\n']) == marker { delivered += 1; }
            }
            assert!(delivered <= 1, "duplicate child reply");
            if delivered == 1 { break; }
            assert!(at.elapsed() < Duration::from_secs(5), "lost child reply");
            thread::sleep(Duration::from_millis(1));
        }
        echo.push(ms(at));
        // Keep the window long enough for several writes/sec to overlap input.
        thread::sleep(Duration::from_millis(25));
    }
    assert_eq!(echo.len(), 80, "child reply loss");
    json!({"status":summary(status_times),"inputAck":summary(ack),"childEcho":summary(echo),"sent":80,"received":80})
}
fn control(core: &Client, op: &str, args: Value) -> f64 {
    let at = Instant::now();
    let response = core.rpc(op, args.clone());
    if op == "stop" { assert_eq!(response["status"], "stopped"); }
    if op == "interrupt" {
        loop {
            let status = core.rpc("status", json!({}));
            let session = status["sessions"].as_array().unwrap().iter()
                .find(|session| session["id"] == args["id"]).unwrap();
            if session["status"] == "exited" { break; }
            assert!(at.elapsed() < Duration::from_secs(1), "interrupt completion exceeded one second");
            thread::sleep(Duration::from_millis(1));
        }
    }
    let elapsed = ms(at);
    assert!(elapsed < 1000.0, "{op} exceeded one-second control budget");
    elapsed
}

#[test]
#[ignore = "opt-in same-binary Pulso A/B benchmark with private 2/8 PTY fixtures"]
fn core_input_under_pulso_load_and_dedicated_slow_clients() {
    for sessions in [2, 8] {
        let mut app = Fixture::open();
        app.core.rpc("set_settings", json!({"maxConcurrentSessions":8}));
        app.pulso.rpc("project_create", json!({"id":"load-project","requestId":"load-project","title":"Synthetic load"}));
        let mut revision = Value::Null;
        // Exactly 500 fixture items; timed load only updates, never grows the DB.
        for i in 0..500 {
            let item = app.pulso.rpc("item_create", json!({"id":format!("load-{i:03}"),"requestId":format!("prepare-{i}"),"projectId":"load-project","title":format!("Fixture {i}"),"note":"x".repeat(512)}));
            if i == 0 { revision = item["item"]["revision"].clone(); }
        }
        for i in 0..sessions {
            app.core.rpc("start", json!({"id":format!("fixture-{i}"),"title":"Synthetic fixture","kind":"fixture"}));
        }
        let idle = measure(&app.core, sessions, "idle");
        let mut load = Load::start(app.pulso.clone(), revision);
        let deadline = Instant::now() + Duration::from_secs(5);
        while load.writes.load(Ordering::Acquire) < 2 {
            assert!(Instant::now() < deadline, "load did not begin");
            thread::sleep(Duration::from_millis(10));
        }
        let loaded = measure(&app.core, sessions, "loaded");
        let resize = control(&app.core, "resize", json!({"id":"fixture-0","rows":31,"cols":99}));
        let stop = control(&app.core, "stop", json!({"id":"fixture-0"}));
        let interrupt = control(&app.core, "interrupt", json!({"id":"fixture-1"}));
        assert!(load.writes.load(Ordering::Acquire) >= 5, "insufficient concurrent writes");
        // Cancellation precedes shutdown so a racing load RPC can exit cleanly;
        // dedicated stalled peers stay connected throughout the shutdown control.
        load.stop.store(true, Ordering::Release);
        let shutdown_at = Instant::now();
        control(&app.core, "shutdown", json!({}));
        app.await_exit();
        let shutdown = ms(shutdown_at);
        assert!(shutdown < 1000.0, "shutdown completion exceeded one-second control budget");
        load.finish();
        println!("{}", json!({"sessions":sessions,"idle":idle,"pulsoLoad":loaded,"writes":load.writes.load(Ordering::Acquire),"controlsMs":{"resize":resize,"stop":stop,"interrupt":interrupt,"shutdown":shutdown}}));
    }
}

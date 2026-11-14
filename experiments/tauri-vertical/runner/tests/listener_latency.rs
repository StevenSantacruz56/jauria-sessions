//! Opt-in benchmark against disposable dual PTY fixtures, never user profiles.
//! LISTENER_BASELINE_RUNNER=/private/.../before-runner cargo test --test
//! listener_latency -- --ignored --nocapture
//! Prints measurements, not machine-dependent CI latency assertions.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value,json};
use std::{fs,io::{BufRead,BufReader,Write},os::unix::{fs::PermissionsExt,net::UnixStream},
    path::{Path,PathBuf},process::{Child,Command,Stdio},thread,time::{Duration,Instant}};

struct Fixture { root:tempfile::TempDir, child:Child, token:String }
impl Fixture {
    fn open(binary:&Path)->Self {
        assert!(binary.is_absolute() && binary.is_file());
        let root=tempfile::Builder::new().prefix("aw-listener-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(),fs::Permissions::from_mode(0o700)).unwrap();
        let child=Command::new(binary).arg("--data-dir").arg(root.path().join("data"))
            .arg("--socket").arg(root.path().join("sock")).arg("--token-file").arg(root.path().join("token"))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut fixture=Self {root,child,token:String::new()};
        let until=Instant::now()+Duration::from_secs(5);
        loop {
            if let Ok(token)=fs::read_to_string(fixture.root.path().join("token")) {
                fixture.token=token;
                if UnixStream::connect(fixture.root.path().join("sock")).is_ok() {break;}
            }
            assert!(fixture.child.try_wait().unwrap().is_none(),"runner exited");
            assert!(Instant::now()<until,"startup timeout");thread::sleep(Duration::from_millis(5));
        }
        fixture
    }
    fn rpc(&self,op:&str,args:Value)->Value {
        let mut stream=UnixStream::connect(self.root.path().join("sock")).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        serde_json::to_writer(&mut stream,&json!({"version":1,"token":self.token,"op":op,"args":args})).unwrap();
        stream.write_all(b"\n").unwrap();
        let mut line=String::new();BufReader::new(stream).read_line(&mut line).unwrap();
        let response:Value=serde_json::from_str(&line).unwrap();
        assert_eq!(response["ok"],true,"{op}: {}",response["error"]);
        response["result"].clone()
    }
    fn shutdown(&mut self)->f64 {
        let started=Instant::now();self.rpc("shutdown",json!({}));
        let until=Instant::now()+Duration::from_secs(5);
        while self.child.try_wait().unwrap().is_none() {
            assert!(Instant::now()<until,"shutdown timeout");thread::sleep(Duration::from_millis(1));
        }
        started.elapsed().as_secs_f64()*1000.0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            // Signal only the child owned by this disposable fixture.
            unsafe {libc::kill(self.child.id() as i32,libc::SIGTERM);}
            let until=Instant::now()+Duration::from_secs(5);
            while self.child.try_wait().ok().flatten().is_none() && Instant::now()<until {thread::sleep(Duration::from_millis(5));}
            if self.child.try_wait().ok().flatten().is_none() {let _=self.child.kill();}
        }
        let _=self.child.wait();
    }
}
fn summary(mut samples:Vec<f64>)->Value {
    samples.sort_by(f64::total_cmp);
    let round=|x:f64|(x*1000.0).round()/1000.0;
    json!({"n":samples.len(),"medianMs":round(samples[samples.len()/2]),
        "p95Ms":round(samples[(samples.len()*95).div_ceil(100)-1])})
}
fn measure(binary:&Path)->Value {
    let mut app=Fixture::open(binary);
    for id in ["first","second"] {
        app.rpc("start",json!({"id":id,"title":id,"kind":"fixture","rows":24,"cols":80}));
    }
    let mut cursors=[0u64;2];
    for (i,id) in ["first","second"].into_iter().enumerate() {
        cursors[i]=app.rpc("terminal_live",json!({"id":id,"after":0,"limit":64}))["lastFrame"].as_u64().unwrap();
    }
    let mut status=Vec::new();let mut events=Vec::new();let mut ack=Vec::new();let mut echo=Vec::new();
    for i in 0..40 {
        let at=Instant::now();let snapshot=app.rpc("status",json!({}));status.push(at.elapsed().as_secs_f64()*1000.0);
        let at=Instant::now();app.rpc("events",json!({"after":snapshot["lastSeq"],"limit":1}));events.push(at.elapsed().as_secs_f64()*1000.0);
        let index=i%2;let id=["first","second"][index];let marker=format!("CHILD_ECHO_{i:04}");
        let at=Instant::now();app.rpc("input",json!({"id":id,"data":format!("echo {marker}\n")}));
        ack.push(at.elapsed().as_secs_f64()*1000.0);
        let mut output=String::new();
        loop {
            let page=app.rpc("terminal_live",json!({"id":id,"after":cursors[index],"limit":64}));
            for frame in page["frames"].as_array().unwrap() {
                cursors[index]=frame["index"].as_u64().unwrap();
                if frame["kind"]=="output" {
                    output.push_str(std::str::from_utf8(&STANDARD.decode(frame["data"].as_str().unwrap()).unwrap()).unwrap());
                }
            }
            // Require the fixture's exact reply line. Kernel command echo is
            // "echo CHILD_ECHO_...", which cannot satisfy this assertion.
            if output.lines().any(|line|line.trim_end_matches('\r')==marker) {break;}
            assert!(at.elapsed()<Duration::from_secs(3),"missing child echo");
        }
        echo.push(at.elapsed().as_secs_f64()*1000.0);
    }
    for id in ["first","second"] {app.rpc("stop",json!({"id":id}));}
    let shutdown=app.shutdown();
    json!({"status":summary(status),"events":summary(events),"inputAck":summary(ack),"inputToChildEcho":summary(echo),"idleShutdownMs":shutdown})
}

#[test]
#[ignore="opt-in disposable A/B latency benchmark; no CI timing thresholds"]
fn listener_readiness_dual_fixture_latency() {
    if let Some(baseline)=std::env::var_os("LISTENER_BASELINE_RUNNER") {
        println!("baseline {}",measure(&PathBuf::from(baseline)));
    }
    println!("readiness {}",measure(Path::new(env!("CARGO_BIN_EXE_aw-runner"))));
}

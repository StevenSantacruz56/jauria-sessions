use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Write}, os::unix::{fs::PermissionsExt,net::UnixStream}, path::PathBuf, process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

struct Instance {
    root: tempfile::TempDir,
    child: Option<Child>,
}

impl Instance {
    fn new() -> Self {
        let mut instance=Self {root:tempfile::Builder::new().prefix("awrt-").tempdir_in("/tmp").unwrap(),child:None};
        fs::set_permissions(instance.root.path(),fs::Permissions::from_mode(0o700)).unwrap();
        instance.launch();
        instance
    }
    fn path(&self,name:&str)->PathBuf {self.root.path().join(name)}
    fn command(&self)->Command {
        let mut cmd=Command::new(env!("CARGO_BIN_EXE_aw-runner"));
        cmd.arg("--data-dir").arg(self.path("data")).arg("--socket").arg(self.path("sock")).arg("--token-file").arg(self.path("token"));
        // Normal terminal fixtures isolate startup files without changing the
        // test process environment or ever loading the real user's config.
        if self.path("terminal-home").is_dir() {
            cmd.env("HOME",self.path("terminal-home"));
            cmd.env("SSH_AUTH_SOCK",self.path("terminal-home/fixture-agent.sock"));
            cmd.env("TMPDIR",self.path("terminal-home/tmp"));
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        cmd
    }
    fn launch(&mut self) {
        self.child=Some(self.command().spawn().unwrap());
        let end=Instant::now()+Duration::from_secs(5);
        loop {
            if self.path("token").exists() && self.try_rpc("status",json!({})).is_some() {break;}
            assert!(Instant::now()<end,"runner did not become ready");
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(),"runner exited at startup");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn raw(&self, request:Value)->std::io::Result<Value> {
        let mut stream=UnixStream::connect(self.path("sock"))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        serde_json::to_writer(&mut stream,&request)?;
        stream.write_all(b"\n")?;
        let mut line=String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok(serde_json::from_str(&line)?)
    }
    fn try_rpc(&self,op:&str,args:Value)->Option<Value> {
        let token=fs::read_to_string(self.path("token")).ok()?;
        self.raw(json!({"version":1,"token":token,"op":op,"args":args})).ok()
    }
    fn rpc(&self,op:&str,args:Value)->Value {
        let response=self.try_rpc(op,args).unwrap();
        assert_eq!(response["ok"],true,"RPC {op}: {response}");
        response["result"].clone()
    }
    fn reject(&self,op:&str,args:Value) {
        assert_eq!(self.try_rpc(op,args).unwrap()["ok"],false);
    }
    fn start(&self,id:&str)->Value {
        self.rpc("start",json!({"id":id,"title":id,"kind":"fixture","rows":24,"cols":80}))
    }
    fn session(&self,id:&str)->Value {
        self.rpc("status",json!({}))["sessions"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap().clone()
    }
    fn output(&self,id:&str)->Vec<u8> {
        let mut output=Vec::new();
        let mut cursor=0;
        loop {
            let page=self.rpc("events",json!({"after":cursor,"limit":256}));
            assert!(serde_json::to_vec(&page).unwrap().len()<=256*1024);
            let events=page["events"].as_array().unwrap();
            assert!(events.len()<=256);
            for event in events {
                assert!(event["seq"].as_i64().unwrap()>cursor);
                cursor=event["seq"].as_i64().unwrap();
                if event["sessionId"]==id && event["kind"]=="output" {
                    output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
                }
            }
            assert_eq!(page["lastSeq"],cursor);
            if page["hasMore"]==false {break;}
            assert!(!events.is_empty());
        }
        output
    }
    fn wait_for(&self,mut predicate:impl FnMut()->bool) {
        let end=Instant::now()+Duration::from_secs(15);
        while !predicate() {
            assert!(Instant::now()<end,"timed out waiting for fixture");
            thread::sleep(Duration::from_millis(25));
        }
    }
    fn contains(&self,id:&str,text:&str)->bool {self.output(id).windows(text.len()).any(|w|w==text.as_bytes())}
    fn kill_and_restart(&mut self) {
        let mut old=self.child.take().unwrap();
        old.kill().unwrap();old.wait().unwrap();
        // Remove only a stale socket belonging to this disposable instance.
        self.launch();
    }
}

#[test]
fn normal_terminal_login_interactive_unicode_cwd_replay_exit_and_stop() {
    let mut app=Instance {root:tempfile::Builder::new().prefix("awrt-term-").tempdir_in("/tmp").unwrap(),child:None};
    fs::set_permissions(app.root.path(),fs::Permissions::from_mode(0o700)).unwrap();
    let home=app.path("terminal-home");fs::create_dir(&home).unwrap();fs::create_dir(home.join("tmp")).unwrap();
    fs::write(home.join(".zprofile"),"export JAURIA_LOGIN_FIXTURE=profile\n").unwrap();
    fs::write(home.join(".zshrc"),"export JAURIA_INTERACTIVE_FIXTURE=rc\nPROMPT=''\n").unwrap();
    // Print readiness only after every normal startup file has loaded. A joined
    // marker in later commands keeps PTY input echo from satisfying assertions.
    fs::write(home.join(".zlogin"),"print -r -- READY_NORMAL_TERMINAL\n").unwrap();
    let cwd=home.join("carpeta acción 中文");fs::create_dir(&cwd).unwrap();
    let cwd=fs::canonicalize(cwd).unwrap();
    app.launch();
    assert_eq!(app.rpc("status",json!({}))["normalTerminalVersion"],1);
    let args=json!({"id":"normal","title":"Terminal","kind":"terminal","cwd":cwd,"rows":24,"cols":80});
    let started=app.rpc("start",args.clone());
    assert_eq!(started["cwd"],json!(cwd));assert!(started["workspace"].is_null());
    app.wait_for(||app.contains("normal","READY_NORMAL_TERMINAL"));
    app.rpc("input",json!({"id":"normal","data":"print -r -- CHECK_$options[interactive]_$options[login]_${JAURIA_LOGIN_FIXTURE}_${JAURIA_INTERACTIVE_FIXTURE}; print -r -- CWD_$PWD; print -r -- HOME_$HOME; print -r -- SHELL_$SHELL; print -r -- AGENT_$SSH_AUTH_SOCK; print -r -- TEMP_$TMPDIR; print -r -- UTF8_acción中文\n"}));
    app.wait_for(||app.contains("normal","CHECK_on_on_profile_rc") && app.contains("normal",&format!("CWD_{}",cwd.display())) && app.contains("normal",&format!("HOME_{}",home.display())));
    assert!(app.contains("normal","UTF8_acción中文"));
    assert!(app.contains("normal","SHELL_/bin/zsh"));
    assert!(app.contains("normal",&format!("AGENT_{}",home.join("fixture-agent.sock").display())));
    assert!(app.contains("normal",&format!("TEMP_{}",home.join("tmp").display())));
    assert_eq!(app.rpc("start",args.clone())["pid"],started["pid"]);
    let second=json!({"id":"second","title":"Terminal","kind":"terminal","cwd":cwd});
    app.rpc("start",second);
    app.wait_for(||app.contains("second","READY_NORMAL_TERMINAL"));
    app.reject("start",json!({"id":"third","title":"Terminal","kind":"terminal","cwd":cwd}));
    app.rpc("resize",json!({"id":"normal","rows":37,"cols":101}));
    app.rpc("input",json!({"id":"normal","data":"/bin/stty size\n"}));
    app.wait_for(||app.contains("normal","37 101"));
    let telemetry=app.rpc("telemetry",json!({}));
    assert!(telemetry["resources"]["processes"].as_array().unwrap().iter().any(|row|row["pid"]==started["pid"] && row["role"]=="cli"));
    let diagnostics=app.rpc("diagnostic_preview",json!({}));
    assert!(diagnostics["sessions"]["byKind"].as_array().unwrap().iter().any(|row|row["kind"]=="terminal" && row["count"]==2));
    assert_eq!(app.rpc("stop",json!({"id":"second"}))["status"],"stopped");
    app.rpc("input",json!({"id":"normal","data":"print -r -- FINAL_$JAURIA_LOGIN_FIXTURE; exit 7\n"}));
    app.wait_for(||app.session("normal")["status"]=="exited");
    assert_eq!(app.session("normal")["detail"]["exitCode"],7);
    assert!(app.contains("normal","FINAL_profile"));
    let output=app.output("normal");
    let cursor=app.rpc("status",json!({}))["lastSeq"].clone();
    assert_eq!(app.rpc("start",args)["status"],"exited");
    assert_eq!(app.rpc("status",json!({}))["lastSeq"],cursor);
    app.kill_and_restart();
    assert_eq!(app.session("normal")["kind"],"terminal");
    assert_eq!(app.session("normal")["status"],"exited");
    assert_eq!(app.output("normal"),output);
    // Freed slots and locks permit another normal terminal after restart.
    app.rpc("start",json!({"id":"after","title":"Terminal","kind":"terminal","cwd":cwd}));
    app.wait_for(||app.contains("after","READY_NORMAL_TERMINAL"));
    assert_eq!(app.rpc("stop",json!({"id":"after"}))["status"],"stopped");
}

impl Drop for Instance {
    fn drop(&mut self) {
        if self.child.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none()) {
            let _=self.try_rpc("shutdown",json!({}));
            let end=Instant::now()+Duration::from_secs(5);
            let child=self.child.as_mut().unwrap();
            while child.try_wait().ok().flatten().is_none() && Instant::now()<end {thread::sleep(Duration::from_millis(10));}
            if child.try_wait().ok().flatten().is_none() {let _=child.kill();}
            let _=child.wait();
        }
    }
}

#[test]
fn authenticated_bounded_rpc_and_singleton() {
    let app=Instance::new();
    let status=app.rpc("status",json!({}));
    let token=fs::read_to_string(app.path("token")).unwrap();
    for request in [json!({"version":1,"token":"wrong","op":"shutdown","args":{}}),json!({"version":2,"token":token,"op":"status","args":{}})] {
        assert_eq!(app.raw(request).unwrap()["ok"],false);
    }
    assert_eq!(app.rpc("status",json!({}))["pid"],status["pid"]);
    app.reject("run",json!({"command":"touch nope"}));
    app.reject("start",json!({"id":"../bad","title":"bad","kind":"fixture"}));
    app.reject("start",json!({"id":"bad","title":"bad","kind":"fixture","command":"anything"}));
    app.reject("start",json!({"id":"bad","title":"bad","kind":"arbitrary"}));
    app.reject("events",json!({"after":-1}));
    app.reject("events",json!({"limit":0}));
    // A peer still writing beyond the cap may get a transport close instead of JSON.
    let oversized=app.try_rpc("status",json!({"oversized":"X".repeat(130*1024)}));
    assert!(oversized.is_none_or(|reply|reply["ok"]==false));
    assert!(!app.command().status().unwrap().success());
    assert_eq!(app.rpc("status",json!({}))["pid"],status["pid"]);
    for path in [app.path("token"),app.path("sock"),app.path("data/runner.sqlite")] {
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077,0);
    }
    // A stalled client must not block unrelated status requests.
    let mut stalled=UnixStream::connect(app.path("sock")).unwrap();
    stalled.write_all(b"{").unwrap();
    assert_eq!(app.rpc("status",json!({}))["pid"],status["pid"]);
}

#[test]
fn real_two_ptys_utf8_size_flood_interrupt_and_stop() {
    let app=Instance::new();
    let first=app.start("fixture-1");
    app.start("fixture-2");
    app.wait_for(||app.contains("fixture-1","READY fixture-1 isatty=true") && app.contains("fixture-2","READY fixture-2"));
    assert_eq!(app.start("fixture-1")["pid"],first["pid"]);
    app.reject("start",json!({"id":"third","title":"third","kind":"fixture"}));
    app.reject("input",json!({"id":"fixture-1","data":"a".repeat(16*1024+1)}));
    app.rpc("input",json!({"id":"fixture-1","data":"ping\necho acción 中文\nsize\n"}));
    app.wait_for(||app.contains("fixture-1","PONG fixture-1") && app.contains("fixture-1","acción 中文\r\n"));
    assert_eq!(app.rpc("resize",json!({"id":"fixture-1","rows":35,"cols":111})),json!({"rows":35,"cols":111}));
    app.rpc("input",json!({"id":"fixture-1","data":"size\n"}));
    app.wait_for(||app.contains("fixture-1","SIZE fixture-1 35 111"));
    for id in ["fixture-1","fixture-2"] {app.rpc("input",json!({"id":id,"data":"flood\n"}));}
    app.wait_for(||app.contains("fixture-1","FLOOD_END fixture-1") && app.contains("fixture-2","FLOOD_END fixture-2"));
    for id in ["fixture-1","fixture-2"] {
        assert_eq!(app.output(id).iter().filter(|&&b| b==b'X').count(),5*1024*1024);
    }
    app.wait_for(||app.contains("fixture-1","HEARTBEAT fixture-1"));
    assert_eq!(app.rpc("stop",json!({"id":"fixture-2"}))["status"],"stopped");
    assert_eq!(app.session("fixture-1")["status"],"running");
    app.start("interrupt-check");
    app.wait_for(||app.contains("interrupt-check","READY interrupt-check"));
    app.rpc("interrupt",json!({"id":"interrupt-check"}));
    app.wait_for(||app.session("interrupt-check")["status"]=="exited");
    app.rpc("input",json!({"id":"fixture-1","data":"exit\n"}));
    app.wait_for(||app.session("fixture-1")["status"]=="exited");
    let before=app.rpc("status",json!({}))["lastSeq"].clone();
    assert_eq!(app.start("fixture-1")["status"],"exited");
    assert_eq!(app.rpc("status",json!({}))["lastSeq"],before);
}

#[test]
fn crash_recovery_preserves_history_and_never_signals_database_pid() {
    let mut app=Instance::new();
    app.start("old");
    app.wait_for(||app.contains("old","READY old"));
    let old_output=app.output("old");
    let seq=app.rpc("status",json!({}))["lastSeq"].as_i64().unwrap();
    let generation=app.rpc("status",json!({}))["generation"].clone();
    // Seed a PID that really is alive but is not owned by the runner.
    let mut foreign=Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let db=Connection::open(app.path("data/runner.sqlite")).unwrap();
    db.busy_timeout(Duration::from_secs(2)).unwrap();
    db.execute("INSERT INTO sessions(id,title,kind,status,pid,rows,cols) VALUES('foreign','foreign','fixture','running',?,24,80)",params![foreign.id()]).unwrap();
    db.execute("INSERT INTO sessions(id,title,kind,status,pid,rows,cols) VALUES('uncertain','uncertain','fixture','starting',NULL,24,80)",[]).unwrap();
    drop(db);
    app.kill_and_restart();
    assert_ne!(app.rpc("status",json!({}))["generation"],generation);
    assert!(app.output("old").starts_with(&old_output));
    assert!(matches!(app.session("old")["status"].as_str(),Some("interrupted"|"needs_attention")));
    assert_eq!(app.session("foreign")["status"],"needs_attention");
    assert_eq!(app.session("uncertain")["status"],"needs_attention");
    app.reject("stop",json!({"id":"foreign"}));
    app.reject("input",json!({"id":"foreign","data":"exit\n"}));
    app.reject("release",json!({"id":"foreign"}));
    app.reject("release",json!({"id":"foreign","confirmed":false}));
    assert_eq!(app.rpc("release",json!({"id":"foreign","confirmed":true}))["status"],"released");
    assert!(foreign.try_wait().unwrap().is_none());
    assert_eq!(app.rpc("release",json!({"id":"uncertain","confirmed":true}))["status"],"released");
    let old=app.session("old");
    assert_eq!(app.start("old"),old);
    assert!(app.rpc("status",json!({}))["lastSeq"].as_i64().unwrap()>seq);
    assert!(foreign.try_wait().unwrap().is_none());
    app.rpc("shutdown",json!({}));
    app.child.as_mut().unwrap().wait().unwrap();
    assert!(foreign.try_wait().unwrap().is_none());
    foreign.kill().unwrap();foreign.wait().unwrap();
    let db=Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(db.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
}

#[test]
fn exit_drains_final_burst_and_marker_before_terminal_state() {
    let app=Instance::new();
    app.start("burst-tail");
    app.wait_for(||app.contains("burst-tail","READY burst-tail"));
    app.rpc("input",json!({"id":"burst-tail","data":"burst\n"}));
    app.wait_for(||app.session("burst-tail")["status"]=="exited");
    let output=app.output("burst-tail");
    assert_eq!(output.split(|&b|b!=b'Y').map(|run|run.len()).max(),Some(64*1024));
    assert!(output.windows(b"BURST_END burst-tail\r\n".len()).any(|w|w==b"BURST_END burst-tail\r\n"));
}

#[test]
fn stop_and_natural_exit_kill_resistant_same_group_descendants() {
    for natural in [false,true] {
    let app=Instance::new();app.start("group-stop");
    app.wait_for(||app.contains("group-stop","READY group-stop"));
    app.rpc("input",json!({"id":"group-stop","data":"descendant\n"}));
    app.wait_for(||app.contains("group-stop","DESCENDANT_READY "));
    let text=String::from_utf8(app.output("group-stop")).unwrap();
    let pid=text.lines().find_map(|line|line.trim().strip_prefix("DESCENDANT_READY "))
        .unwrap().parse::<u32>().unwrap();
    if natural {
        app.rpc("input",json!({"id":"group-stop","data":"exit\n"}));
        app.wait_for(||app.session("group-stop")["status"]=="exited");
    } else {assert_eq!(app.rpc("stop",json!({"id":"group-stop"}))["status"],"stopped");}
    app.wait_for(|| {
        let result=Command::new("/bin/ps").args(["-o","stat=","-p",&pid.to_string()]).output().unwrap();
        let stat=String::from_utf8_lossy(&result.stdout);
        !result.status.success() || stat.trim().is_empty() || stat.trim_start().starts_with('Z')
    });
    }
}

#[test]
fn escaped_process_group_retains_attention_and_can_be_released_explicitly() {
    // Native standalone sessions now have null workspace: recovery must still
    // inventory their SID and retain the slot while a descendant survives.
    for tracked_workspace in [false,true] {
    for restart in [false,true] {
    let mut app=Instance::new();app.start("other-group");
    let db=Connection::open(app.path("data/runner.sqlite")).unwrap();
    if tracked_workspace { db.execute("UPDATE sessions SET workspace=? WHERE id='other-group'",params![app.path("data/work/other-group").to_str().unwrap()]).unwrap(); }
    else { db.execute("UPDATE sessions SET workspace=NULL WHERE id='other-group'",[]).unwrap(); }
    drop(db);
    app.wait_for(||app.contains("other-group","READY other-group"));
    app.rpc("input",json!({"id":"other-group","data":"descendant-group\n"}));
    app.wait_for(||app.contains("other-group","DESCENDANT_READY "));
    app.rpc("input",json!({"id":"other-group","data":"exit\n"}));
    app.wait_for(||app.session("other-group")["status"]=="needs_attention");
    if restart {
        app.kill_and_restart();
        assert_eq!(app.session("other-group")["status"],"needs_attention");
    }
    // User-verifiable cleanup marker, not a signal to a discovered PID.
    fs::write(app.path("data/work/other-group/stop-descendant"),b"stop").unwrap();
    app.reject("release",json!({"id":"other-group","confirmed":false}));
    assert_eq!(app.rpc("release",json!({"id":"other-group","confirmed":true}))["status"],"released");
    app.kill_and_restart();
    assert_eq!(app.session("other-group")["status"],"released");
    }
    }
}

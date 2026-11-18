//! Disposable authenticated RPC fixtures: never use provider or user profiles.
use serde_json::{Value, json};
use std::{fs, io::{BufRead, BufReader, Write}, os::unix::{net::UnixStream, fs::PermissionsExt},
    path::PathBuf, process::{Child, Command, Stdio}, thread, time::{Duration, Instant}};

struct Instance { root: tempfile::TempDir, child: Option<Child> }
impl Instance {
    fn new() -> Self {
        let mut app=Self {root:tempfile::Builder::new().prefix("awprefs-").tempdir_in("/tmp").unwrap(),child:None};
        fs::set_permissions(app.root.path(),fs::Permissions::from_mode(0o700)).unwrap();
        app.launch();app
    }
    fn path(&self,name:&str)->PathBuf {self.root.path().join(name)}
    fn launch(&mut self) {
        let executable=std::env::var_os("JAURIA_TEST_RUNNER").map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(env!("CARGO_BIN_EXE_aw-runner")));
        assert!(executable.is_absolute(),"test runner must use an absolute path");
        self.child=Some(Command::new(executable)
            .arg("--data-dir").arg(self.path("data")).arg("--socket").arg(self.path("sock"))
            .arg("--token-file").arg(self.path("token"))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap());
        let until=Instant::now()+Duration::from_secs(10);
        loop {
            if let Some(response)=self.try_raw("status",json!({})) {if response["ok"]==true {break;}}
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(),"runner exited");
            assert!(Instant::now()<until,"runner startup timeout");thread::sleep(Duration::from_millis(10));
        }
    }
    fn try_raw(&self,op:&str,args:Value)->Option<Value> {
        let token=fs::read_to_string(self.path("token")).ok()?;
        let mut stream=UnixStream::connect(self.path("sock")).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
        stream.set_write_timeout(Some(Duration::from_secs(10))).ok()?;
        serde_json::to_writer(&mut stream,&json!({"version":1,"token":token,"op":op,"args":args})).ok()?;
        stream.write_all(b"\n").ok()?;
        let mut line=String::new();BufReader::new(stream).read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }
    fn rpc(&self,op:&str,args:Value)->Value {
        let response=self.try_raw(op,args).expect("RPC transport failure");
        assert_eq!(response["ok"],true,"{op}: {}",response["error"]);response["result"].clone()
    }
    fn reject(&self,op:&str,args:Value) {
        assert_eq!(self.try_raw(op,args).expect("RPC transport failure")["ok"],false,"{op} unexpectedly accepted");
    }
    fn start_args(id:&str)->Value {json!({"id":id,"title":id,"kind":"fixture","rows":24,"cols":80})}
    fn start(&self,id:&str)->Value {self.rpc("start",Self::start_args(id))}
    fn session(&self,id:&str)->Value {
        self.rpc("status",json!({}))["sessions"].as_array().unwrap().iter().find(|s|s["id"]==id).unwrap().clone()
    }
    fn stop_runner(&mut self) {
        if let Some(mut child)=self.child.take() {
            let _=self.try_raw("shutdown",json!({}));
            let until=Instant::now()+Duration::from_secs(10);
            while child.try_wait().unwrap().is_none() && Instant::now()<until {thread::sleep(Duration::from_millis(10));}
            if child.try_wait().unwrap().is_none() {let _=child.kill();}
            let _=child.wait();
        }
    }
}
impl Drop for Instance {fn drop(&mut self) {self.stop_runner();}}

#[test]
fn settings_cap_four_lowering_preserves_custody_and_persists() {
    let mut app=Instance::new();
    assert_eq!(app.rpc("get_settings",json!({}))["maxConcurrentSessions"],2);
    assert_eq!(app.rpc("set_settings",json!({"maxConcurrentSessions":4}))["maxConcurrentSessions"],4);
    let status=app.rpc("status",json!({}));
    assert_eq!(status["settingsVersion"],2);assert_eq!(status["sessionRenameVersion"],1);
    assert_eq!(status["settings"]["pulsoAutoAccess"],true);
    assert_eq!(status["settings"]["maxConcurrentSessions"],4);
    for id in ["one","two","three","four"] {assert_eq!(app.start(id)["status"],"running");}
    app.reject("start",Instance::start_args("five"));
    app.rpc("set_settings",json!({"maxConcurrentSessions":2}));
    for id in ["one","two","three","four"] {
        assert_eq!(app.session(id)["status"],"running");
        app.rpc("input",json!({"id":id,"data":"ping\n"}));
    }
    app.reject("start",Instance::start_args("five"));
    for id in ["one","two"] {assert_eq!(app.rpc("stop",json!({"id":id}))["status"],"stopped");}
    app.reject("start",Instance::start_args("five"));
    app.rpc("stop",json!({"id":"three"}));assert_eq!(app.start("five")["status"],"running");
    app.stop_runner();app.launch();
    assert_eq!(app.rpc("get_settings",json!({}))["maxConcurrentSessions"],2);
    app.rpc("set_settings",json!({"maxConcurrentSessions":4}));app.stop_runner();app.launch();
    assert_eq!(app.rpc("status",json!({}))["settings"]["maxConcurrentSessions"],4);
}

#[test]
fn rename_active_final_and_reopen_preserves_native_truth() {
    let mut app=Instance::new();app.start("renamed");
    app.rpc("resize",json!({"id":"renamed","rows":35,"cols":111}));
    let before=app.session("renamed");
    let renamed=app.rpc("rename_session",json!({"id":"renamed","title":"  Trabajo 🐺  "}));
    assert_eq!(renamed["title"],"Trabajo 🐺");
    for key in ["id","pid","status","rows","cols","cwd","workspace","taskId","kind"] {assert_eq!(renamed[key],before[key]);}
    assert!(renamed["detail"]["terminalStream"]["revision"].as_u64().unwrap()>
        before["detail"]["terminalStream"]["revision"].as_u64().unwrap());
    assert_eq!(app.rpc("terminal_live",json!({"id":"renamed","after":0}))["session"]["title"],"Trabajo 🐺");
    app.rpc("input",json!({"id":"renamed","data":"exit\n"}));
    let until=Instant::now()+Duration::from_secs(10);
    while app.session("renamed")["status"]!="exited" {
        assert!(Instant::now()<until,"fixture did not exit");thread::sleep(Duration::from_millis(10));
    }
    let final_row=app.rpc("rename_session",json!({"id":"renamed","title":"Historial"}));
    assert_eq!(final_row["status"],"exited");assert_eq!(final_row["title"],"Historial");
    assert!(final_row["detail"]["terminalStream"].is_object());
    app.stop_runner();app.launch();
    let saved=app.session("renamed");assert_eq!(saved["title"],"Historial");assert_eq!(saved["status"],"exited");
    assert_eq!(saved["rows"],35);assert_eq!(saved["cols"],111);
    assert!(saved["detail"]["terminalStream"].is_object());
    app.rpc("rename_session",json!({"id":"renamed","title":"Archived without live cache"}));
    app.stop_runner();app.launch();assert_eq!(app.session("renamed")["title"],"Archived without live cache");
}

#[test]
fn strict_preferences_and_rename_validation_default_two() {
    let app=Instance::new();app.start("one");app.start("two");app.reject("start",Instance::start_args("three"));
    for value in [json!(0),json!(9),json!(-1),json!(2.5),json!("4"),json!(null),json!(true)] {
        app.reject("set_settings",json!({"maxConcurrentSessions":value}));
    }
    for args in [json!({}),json!({"maxConcurrentSessions":4,"extra":true})] {app.reject("set_settings",args);}
    for value in [json!(null),json!(1),json!("false")] {app.reject("set_settings",json!({"pulsoAutoAccess":value}));}
    assert_eq!(app.rpc("set_settings",json!({"pulsoAutoAccess":false}))["pulsoAutoAccess"],false);
    assert_eq!(app.rpc("get_settings",json!({}))["pulsoAutoAccess"],false);
    app.reject("get_settings",json!({"extra":true}));
    assert_eq!(app.rpc("get_settings",json!({}))["maxConcurrentSessions"],2);
    for title in [json!(""),json!("  "),json!("x".repeat(121)),json!("🐺".repeat(121)),
        json!("a\0b"),json!("a\nb"),json!("a\u{1b}b"),json!("a\u{85}b"),json!("trailing\n"),json!(42),json!(null)] {
        app.reject("rename_session",json!({"id":"one","title":title}));
    }
    app.reject("rename_session",json!({"id":"missing","title":"valid"}));
    app.reject("rename_session",json!({"id":"one","title":"valid","extra":1}));
    assert_eq!(app.session("one")["title"],"one");
    assert_eq!(app.rpc("rename_session",json!({"id":"one","title":"🐺".repeat(120)}))["title"],"🐺".repeat(120));
}

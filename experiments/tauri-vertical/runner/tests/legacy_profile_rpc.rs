//! A profile written before 1.4 can hold Git repositories, tasks, reviews,
//! handoffs and verifications. The retired feature's rows must be kept byte for
//! byte, while sessions and Pulso work normally. The only old row still read is
//! an unfinished verification: it blocks a writer in its folder only while its
//! command still runs. Synthetic data in a disposable profile, socket and HOME.
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Instance { root: tempfile::TempDir, child: Option<Child> }

impl Instance {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("legacy-profile-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        for dir in ["tmp", "home", "data"] {
            fs::create_dir(root.path().join(dir)).unwrap();
            fs::set_permissions(root.path().join(dir), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut app = Self { root, child: None };
        app.launch();
        app
    }
    fn path(&self, name: &str) -> PathBuf { fs::canonicalize(self.root.path()).unwrap().join(name) }
    fn launch(&mut self) {
        self.child = Some(Command::new(env!("CARGO_BIN_EXE_aw-runner"))
            .args(["--data-dir"]).arg(self.path("data"))
            .arg("--socket").arg(self.path("tmp/sock"))
            .arg("--token-file").arg(self.path("tmp/token"))
            .env("HOME", self.path("home")).env("TMPDIR", self.path("tmp"))
            .current_dir(self.root.path())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.request(false, "status", json!({})).is_ok_and(|r| r["ok"] == true) {
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(), "runner exited during startup");
            assert!(Instant::now() < deadline, "runner startup timeout");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn request(&self, pulso: bool, op: &str, args: Value) -> io::Result<Value> {
        let (socket, credential) = if pulso { ("tmp/pulso.sock", "tmp/pulso.token") } else { ("tmp/sock", "tmp/token") };
        let mut stream = UnixStream::connect(self.path(socket))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        serde_json::to_writer(&mut stream, &json!({"version":1,"token":fs::read_to_string(self.path(credential))?,"op":op,"args":args}))?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(stream).take(2 * 1024 * 1024).read_line(&mut line)?;
        Ok(serde_json::from_str(&line)?)
    }
    fn call(&self, pulso: bool, op: &str, args: Value) -> Value {
        let response = self.request(pulso, op, args).expect("RPC transport failed");
        assert_eq!(response["ok"], true, "RPC {op} failed");
        response["result"].clone()
    }
    fn stop_runner(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = self.request(false, "shutdown", json!({}));
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().ok().flatten().is_none() && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
            if child.try_wait().ok().flatten().is_none() { let _ = child.kill(); }
            let _ = child.wait();
        }
    }
    fn session(&self, id: &str) -> Value {
        self.call(false, "status", json!({}))["sessions"].as_array().unwrap().iter().find(|s| s["id"] == id).cloned().unwrap_or(Value::Null)
    }
}
impl Drop for Instance { fn drop(&mut self) { self.stop_runner(); } }

const LEGACY_TABLES: [&str; 7] = ["projects", "project_states", "tasks", "task_audit", "task_workflow", "task_artifacts", "verification_runs"];

fn dump(db: &Connection) -> Vec<String> {
    let mut rows = Vec::new();
    for table in LEGACY_TABLES {
        let mut stmt = db.prepare(&format!("SELECT * FROM {table} ORDER BY 1")).unwrap();
        let width = stmt.column_count();
        let found = stmt.query_map([], |r| {
            (0..width).map(|i| r.get_ref(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()
        }).unwrap();
        for row in found { rows.push(format!("{table}:{}", row.unwrap().join("|"))); }
    }
    rows
}

#[test]
fn legacy_git_task_profile_opens_and_keeps_old_rows_untouched() {
    let mut app = Instance::new();
    app.call(true, "project_create", json!({"id":"plan","requestId":"create-plan","title":"Synthetic plan"}));
    app.stop_runner();

    let home = app.path("home");
    // A 1.3.x verification that may have outlived its runner: argv, folder and creation time.
    let verifier = ["/bin/sleep".to_owned(), format!("{}.75", 600 + std::process::id() % 1000)];
    let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 1;
    let run = json!({"argv":verifier,"cwd":home,"createdAt":created,"status":"running"}).to_string();
    let worktree = app.path("data/worktrees/task-ready");
    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    db.execute_batch(&format!("
        INSERT INTO projects VALUES('project-legacy','/synthetic/repo','/synthetic/repo/.git','repo','0123456789abcdef',NULL);
        INSERT INTO project_states VALUES('project-legacy',1,3);
        INSERT INTO tasks VALUES('task-preparing','project-legacy','Preparing','Objective','','0123456789abcdef','jauria/preparing','/synthetic/preparing','preparing',NULL);
        INSERT INTO tasks VALUES('task-ready','project-legacy','Ready','Objective','Criteria','0123456789abcdef','jauria/ready','{worktree}','ready',NULL);
        INSERT INTO task_audit(task_id,state,detail) VALUES('task-ready','ready','prepared');
        INSERT INTO task_workflow VALUES('task-ready',1);
        INSERT INTO task_artifacts VALUES('purged-legacy','task-ready','purged','{{}}');
        INSERT INTO task_artifacts VALUES('handoff-legacy','task-ready','handoff_open','{{\"phase\":\"prepared\",\"sessionId\":\"reserved\",\"request\":{{\"sessionId\":\"reserved\"}}}}');
        INSERT INTO verification_runs VALUES('run-legacy','task-ready','request-legacy','hash','running',0,'{run}');
        INSERT INTO sessions(id,title,kind,status,pid,rows,cols,cwd,workspace,task_id) VALUES('task-session','Old task session','fixture','exited',NULL,24,80,'{worktree}','{worktree}','task-ready');
    ", worktree = worktree.display(), run = run)).unwrap();
    let before = dump(&db);
    drop(db);

    app.launch();
    let status = app.call(false, "status", json!({}));
    for retired in ["projects", "tasks", "workspaceRevision", "workspaceNotModified", "workspaceVersion", "workflowVersion", "verificationVersion", "handoffVersion", "recoveryVersion", "projectLifecycleVersion"] {
        assert!(status.get(retired).is_none(), "{retired} is still announced");
    }
    assert_eq!(app.session("task-session")["title"], "Old task session");
    // A 1.3.x app still sends its workspace cursor; it is accepted and ignored.
    assert_eq!(app.call(false, "status", json!({"workspaceAfter":"0:0:0:0"}))["sessions"], status["sessions"]);
    for (op, args) in [
        ("register_project", json!({"id":"project-new","path":home})),
        ("start_task", json!({"id":"task-ready","sessionId":"new","kind":"shell","rows":24,"cols":80})),
        ("workflow", json!({"id":"task-ready"})),
        ("open_handoff", json!({"id":"task-ready","artifactId":"a","requestId":"r","sessionId":"reserved","rows":24,"cols":80})),
        ("prepare_verification", json!({"id":"task-ready","requestId":"r","snapshotId":"s","argv":["/usr/bin/true"]})),
    ] {
        let reply = app.request(false, op, args).unwrap();
        assert_eq!(reply["ok"], false, "{op} is still served");
        assert_eq!(reply["error"], "unknown operation", "{op}");
    }

    // While the old verification command still runs in HOME, no writer is admitted there.
    let mut child = {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(&verifier[0]);
        command.args(&verifier[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        unsafe { command.pre_exec(|| if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }); }
        command.spawn().unwrap()
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while String::from_utf8_lossy(&Command::new("/bin/ps").args(["-o", "args=", "-p", &child.id().to_string()]).output().unwrap().stdout).trim() != verifier.join(" ") {
        assert!(Instant::now() < deadline, "synthetic verifier did not start");
        thread::sleep(Duration::from_millis(10));
    }
    let start = json!({"id":"reserved","title":"Terminal","kind":"terminal","cwd":home,"rows":24,"cols":80});
    let refused = app.request(false, "start", start.clone()).unwrap();
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"], format!("Un proceso de verificación de una versión anterior sigue activo en esta carpeta (pid {}). Termínalo y vuelve a intentar.", child.id()));
    child.kill().unwrap(); child.wait().unwrap();

    // Once it has ended, neither that row, the old handoff reservation nor the
    // purged record without provenance blocks an ordinary session.
    app.call(false, "start", start);
    let deadline = Instant::now() + Duration::from_secs(10);
    while app.session("reserved")["status"] != "running" {
        assert!(Instant::now() < deadline, "terminal did not start");
        thread::sleep(Duration::from_millis(10));
    }
    app.call(false, "stop", json!({"id":"reserved"}));
    let projects = app.call(true, "projects", json!({}));
    assert_eq!(projects["projects"].as_array().unwrap().iter().map(|p| p["id"].clone()).collect::<Vec<_>>(), [json!("plan")]);
    app.stop_runner();

    let db = Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(dump(&db), before, "retired rows were changed");
    assert_eq!(db.query_row("SELECT task_id FROM sessions WHERE id='task-session'", [], |r| r.get::<_, String>(0)).unwrap(), "task-ready");
    assert!(db.query_row("SELECT task_id FROM sessions WHERE id='reserved'", [], |r| r.get::<_, Option<String>>(0)).unwrap().is_none());
}

//! Black-box Pulso contract tests. All credentials and data are disposable.
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Instance {
    root: tempfile::TempDir,
    child: Option<Child>,
}

impl Instance {
    fn empty() -> Self {
        let root = tempfile::Builder::new().prefix("pulso-rpc-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        for dir in ["tmp", "home", "data"] {
            fs::create_dir(root.path().join(dir)).unwrap();
            fs::set_permissions(root.path().join(dir), fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self { root, child: None }
    }
    fn new() -> Self {
        let mut app = Self::empty();
        app.launch();
        app
    }
    fn path(&self, name: &str) -> PathBuf { self.root.path().join(name) }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aw-runner"));
        command.args(["--data-dir"]).arg(self.path("data"))
            .arg("--socket").arg(self.path("tmp/sock"))
            .arg("--token-file").arg(self.path("tmp/token"))
            .env("HOME", self.path("home"))
            .env("XDG_CONFIG_HOME", self.path("home/config"))
            .env("XDG_DATA_HOME", self.path("home/data"))
            .env("TMPDIR", self.path("tmp"))
            .current_dir(self.root.path())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command
    }
    fn launch(&mut self) {
        self.child = Some(self.command().spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.request(false, "status", json!({})).is_ok_and(|r| r["ok"] == true) { break; }
            assert!(self.child.as_mut().unwrap().try_wait().unwrap().is_none(), "runner exited during startup");
            assert!(Instant::now() < deadline, "runner startup timeout");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn wire(&self, socket: &str, token: &str, version: u64, op: &str, args: Value) -> io::Result<Value> {
        let mut stream = UnixStream::connect(self.path(socket))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        serde_json::to_writer(&mut stream, &json!({"version":version,"token":token,"op":op,"args":args}))?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(stream).take_line(&mut line)?;
        Ok(serde_json::from_str(&line)?)
    }
    fn request(&self, pulso: bool, op: &str, args: Value) -> io::Result<Value> {
        let (socket, credential) = if pulso { ("tmp/pulso.sock", "tmp/pulso.token") } else { ("tmp/sock", "tmp/token") };
        self.wire(socket, &fs::read_to_string(self.path(credential))?, 1, op, args)
    }
    fn call(&self, pulso: bool, op: &str, args: Value) -> Value {
        let response = self.request(pulso, op, args).expect("RPC transport failed");
        // Never format responses: grant responses contain credentials.
        assert_eq!(response["ok"], true, "RPC {op} failed");
        response["result"].clone()
    }
    fn core(&self, op: &str, args: Value) -> Value { self.call(false, op, args) }
    fn pulso(&self, op: &str, args: Value) -> Value { self.call(true, op, args) }
    fn reject(&self, op: &str, args: Value) {
        let reply = self.request(true, op, args).unwrap();
        assert_eq!(reply["ok"], false, "{op} unexpectedly accepted");
        assert!(!reply["error"].is_null(), "missing typed error");
    }
    fn project(&self, id: &str) -> Value {
        self.pulso("project_create", json!({"id":id,"requestId":format!("create-{id}"),"title":id,"plan":"Synthetic plan"}))["project"].clone()
    }
    fn item(&self, id: &str, project: &str) -> Value {
        self.pulso("item_create", json!({"id":id,"requestId":format!("create-{id}"),"projectId":project,"title":id,"note":"Synthetic note"}))["item"].clone()
    }
    fn start(&self, id: &str) {
        self.core("start", json!({"id":id,"title":id,"kind":"fixture"}));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = self.core("status", json!({}));
            if status["sessions"].as_array().unwrap().iter().any(|s| s["id"] == id && s["status"] == "running") { break; }
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn stop_runner(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = self.request(false, "shutdown", json!({}));
            if child.try_wait().ok().flatten().is_none() {
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if child.try_wait().ok().flatten().is_none() { let _ = child.kill(); }
            let _ = child.wait();
        }
    }
    fn agent(&self, credential: &Value, op: &str, args: Value) -> Value {
        assert!(credential["socket"].as_str().is_some());
        let socket = PathBuf::from(credential["socket"].as_str().unwrap());
        assert_eq!(fs::canonicalize(socket).unwrap(), fs::canonicalize(self.path("tmp/pulso.sock")).unwrap());
        self.wire("tmp/pulso.sock", credential["token"].as_str().unwrap(), 1, op, args).unwrap()
    }
}

// Bound replies as well as socket time, even when a server omits the newline.
trait BoundedLine { fn take_line(&mut self, line: &mut String) -> io::Result<()>; }
impl BoundedLine for BufReader<UnixStream> {
    fn take_line(&mut self, line: &mut String) -> io::Result<()> {
        use std::io::Read;
        let n = self.take(2 * 1024 * 1024).read_line(line)?;
        if n == 0 || !line.ends_with('\n') { return Err(io::Error::other("missing or oversized RPC line")); }
        Ok(())
    }
}
impl Drop for Instance { fn drop(&mut self) { self.stop_runner(); } }

#[test]
fn dedicated_credentials_protocol_and_core_capability() {
    let app = Instance::new();
    let status = app.core("status", json!({}));
    assert_eq!(status["pulsoVersion"], 1);
    assert_eq!(status["pulsoAvailable"], true);
    let master = fs::read_to_string(app.path("tmp/token")).unwrap();
    let ui = fs::read_to_string(app.path("tmp/pulso.token")).unwrap();
    assert!(master != ui, "Pulso must use a separate UI credential");
    for path in ["tmp/pulso.sock", "tmp/pulso.token", "data/pulso.sqlite"] {
        assert_eq!(fs::metadata(app.path(path)).unwrap().permissions().mode() & 0o077, 0);
    }
    for (token, version) in [(&master, 1), (&ui, 2)] {
        assert_eq!(app.wire("tmp/pulso.sock", token, version, "projects", json!({})).unwrap()["ok"], false);
    }
    assert_eq!(app.wire("tmp/sock", &ui, 1, "status", json!({})).unwrap()["ok"], false);
    app.reject("shutdown", json!({}));
    assert_eq!(app.core("status", json!({}))["pid"], status["pid"]);
}

#[test]
fn persistence_idempotency_and_revision_conflicts_do_not_overwrite() {
    let mut app = Instance::new();
    let p = app.project("project-one");
    let create = json!({"id":"item-one","requestId":"create-item-one","projectId":"project-one","title":"item-one","note":"Synthetic note"});
    let item = app.pulso("item_create", create.clone())["item"].clone();
    let revision = app.pulso("revision", json!({}));
    assert_eq!(app.pulso("item_create", create.clone())["item"], item);
    assert_eq!(app.pulso("revision", json!({})), revision);
    let mut mismatch = create;
    mismatch["title"] = json!("must not overwrite");
    app.reject("item_create", mismatch);
    let update = json!({"id":"item-one","requestId":"edit-item","expectedRevision":item["revision"],"title":"Updated","note":"Kept note"});
    let updated = app.pulso("item_update", update.clone())["item"].clone();
    assert_ne!(updated["revision"], item["revision"]);
    assert_eq!(app.pulso("item_update", update.clone())["item"], updated);
    let mut mismatch = update;
    mismatch["note"] = json!("not allowed");
    app.reject("item_update", mismatch);
    app.reject("item_update", json!({"id":"item-one","requestId":"stale-item","expectedRevision":item["revision"],"title":"Lost update"}));
    let project_update = json!({"id":"project-one","requestId":"edit-project","expectedRevision":p["revision"],"title":"Updated project","plan":"New plan"});
    let project = app.pulso("project_update", project_update.clone())["project"].clone();
    assert_eq!(app.pulso("project_update", project_update)["project"], project);
    app.reject("project_update", json!({"id":"project-one","requestId":"stale-project","expectedRevision":p["revision"],"plan":"Lost plan"}));
    assert_eq!(app.pulso("item", json!({"id":"item-one"}))["item"], updated);
    assert_eq!(app.pulso("project", json!({"id":"project-one"}))["project"], project);
    let revision = app.pulso("revision", json!({}));
    app.stop_runner();
    app.launch();
    assert_eq!(app.pulso("revision", json!({})), revision);
    assert_eq!(app.pulso("item", json!({"id":"item-one"}))["item"], updated);
    assert_eq!(app.pulso("project", json!({"id":"project-one"}))["project"], project);
    assert_eq!(app.pulso("projects", json!({}))["projects"].as_array().unwrap().len(), 1);
    assert_eq!(app.pulso("items", json!({"projectId":"project-one","limit":10}))["items"].as_array().unwrap().len(), 1);
}

#[test]
fn checkpoints_remain_immutable_after_later_item_edits_and_restart() {
    let mut app = Instance::new();
    app.project("checkpoints");
    let item = app.item("checkpoint-item", "checkpoints");
    let args = json!({"id":"checkpoint-one","requestId":"checkpoint-request","itemId":"checkpoint-item","expectedRevision":item["revision"],"brief":"Original checkpoint","nextAction":"Continue synthetic work"});
    let first = app.pulso("checkpoint_create", args.clone());
    assert_eq!(app.pulso("checkpoint_create", args.clone()), first);
    let checkpoint = first["checkpoint"].clone();
    assert_eq!(checkpoint["brief"], "Original checkpoint");
    assert_eq!(checkpoint["nextAction"], "Continue synthetic work");
    let mut mismatch = args;
    mismatch["brief"] = json!("Overwrite attempt");
    app.reject("checkpoint_create", mismatch);
    app.reject("checkpoint_create", json!({"id":"stale-checkpoint","requestId":"stale-checkpoint","itemId":"checkpoint-item","expectedRevision":item["revision"],"brief":"stale","nextAction":"stale"}));
    let edited = app.pulso("item_update", json!({"id":"checkpoint-item","requestId":"after-checkpoint","expectedRevision":first["item"]["revision"],"title":"Later title","note":"Later note"}))["item"].clone();
    for restart in [false, true] {
        if restart { app.stop_runner(); app.launch(); }
        let detail = app.pulso("item", json!({"id":"checkpoint-item"}));
        assert_eq!(detail["item"], edited);
        assert!(detail["links"].is_array());
        assert_eq!(detail["checkpoints"], json!([checkpoint]));
    }
}

#[test]
fn agent_scope_denies_other_projects_grants_archive_and_stopped_sessions() {
    let app = Instance::new();
    let p = app.project("allowed");
    let other = app.project("other");
    let item = app.item("allowed-item", "allowed");
    app.item("other-item", "other");
    app.start("agent-fixture");
    let grant = app.pulso("grant", json!({"sessionId":"agent-fixture","projectId":"allowed","canCreateProjects":false,"remember":false}));
    let handle = &grant["handle"];
    assert!(grant["command"].is_string());
    assert!(grant["guidance"].is_string());
    assert_eq!(fs::metadata(handle.as_str().unwrap()).unwrap().permissions().mode() & 0o077, 0);
    let credential: Value = serde_json::from_slice(&fs::read(handle.as_str().expect("grant.handle must be a credential path")).unwrap()).unwrap();
    assert_eq!(app.agent(&credential, "project", json!({"id":"allowed"}))["ok"], true);
    assert_eq!(app.agent(&credential, "item", json!({"id":"allowed-item"}))["ok"], true);
    let projects = app.agent(&credential, "projects", json!({}));
    assert_eq!(projects["ok"], true);
    assert!(projects["result"]["projects"].as_array().unwrap().iter().all(|row| row["id"] == "allowed"));
    for (op, args) in [
        ("project", json!({"id":"other"})),
        ("item", json!({"id":"other-item"})),
        ("items", json!({"projectId":"other"})),
        ("project_update", json!({"id":"other","requestId":"cross-project","expectedRevision":other["revision"],"title":"Forbidden"})),
        ("item_create", json!({"id":"cross-item","requestId":"cross-item","projectId":"other","title":"Forbidden"})),
        ("project_create", json!({"id":"agent-project","requestId":"agent-project","title":"Forbidden"})),
        ("grant", json!({"sessionId":"agent-fixture","projectId":"other"})),
        ("project_update", json!({"id":"allowed","requestId":"archive-project","expectedRevision":p["revision"],"archived":true})),
        ("item_update", json!({"id":"allowed-item","requestId":"archive-item","expectedRevision":item["revision"],"archived":true})),
    ] {
        assert_eq!(app.agent(&credential, op, args)["ok"], false, "agent accepted {op}");
    }
    assert_eq!(app.agent(&credential, "item_create", json!({"id":"agent-item","requestId":"agent-item","projectId":"allowed","title":"Agent work"}))["ok"], true);
    app.core("stop", json!({"id":"agent-fixture"}));
    assert_eq!(app.agent(&credential, "items", json!({"projectId":"allowed"}))["ok"], false);
}

#[test]
fn pulso_mutations_do_not_create_git_workspaces_or_sessions() {
    let app = Instance::new();
    let before = app.core("status", json!({}));
    app.project("standalone");
    let item = app.item("standalone-item", "standalone");
    app.pulso("checkpoint_create", json!({"id":"standalone-checkpoint","requestId":"standalone-checkpoint","itemId":"standalone-item","expectedRevision":item["revision"],"brief":"Only notes","nextAction":"No process"}));
    let after = app.core("status", json!({}));
    assert_eq!(after["sessions"], before["sessions"]);
    assert_eq!(after["lastSeq"], before["lastSeq"]);
    fn assert_no_git(path: &std::path::Path) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            assert!(entry.file_name() != ".git", "Pulso created a Git workspace");
            if entry.file_type().unwrap().is_dir() { assert_no_git(&entry.path()); }
        }
    }
    assert_no_git(app.root.path());
    let work = app.path("data/work");
    assert!(!work.exists() || fs::read_dir(work).unwrap().next().is_none());
}

#[test]
fn corrupt_pulso_database_degrades_without_disabling_core() {
    let mut app = Instance::empty();
    fs::write(app.path("data/pulso.sqlite"), b"synthetic corrupt sqlite database").unwrap();
    fs::set_permissions(app.path("data/pulso.sqlite"), fs::Permissions::from_mode(0o600)).unwrap();
    app.launch();
    let status = app.core("status", json!({}));
    assert_eq!(status["pulsoVersion"], 1);
    assert_eq!(status["pulsoAvailable"], false);
    app.start("core-survives");
    app.core("input", json!({"id":"core-survives","data":"ping\n"}));
    assert_eq!(app.core("stop", json!({"id":"core-survives"}))["status"], "stopped");
    let db = rusqlite::Connection::open(app.path("data/runner.sqlite")).unwrap();
    assert_eq!(db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
}

#[test]
fn actual_binary_cli_uses_private_handle_and_reports_errors() {
    let app = Instance::new();
    app.start("cli-fixture");
    let grant = app.pulso("grant", json!({"sessionId":"cli-fixture","canCreateProjects":true,"remember":false}));
    let project_args=json!({"id":"cli-project","requestId":"cli-plan-create","title":"Plan desde terminal"});
    let shell = Command::new("/bin/zsh").arg("-f").arg("-c")
        .arg(format!("{} project_create '{}'",grant["command"].as_str().unwrap(),project_args))
        .env("HOME",app.path("home")).current_dir(app.root.path()).output().unwrap();
    assert!(shell.status.success(),"the copyable command must create a project from a shell");
    let created:Value=serde_json::from_slice(&shell.stdout).unwrap();
    assert_eq!(created["project"]["mainSessionId"],"cli-fixture");
    let run = |op: &str, args: Value| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aw-runner"));
        command.arg("--pulso-client").arg("--handle").arg(grant["handle"].as_str().unwrap())
            .arg(op).arg(if op=="item_create" {"-".into()} else {args.to_string()}).env("HOME", app.path("home"))
            .current_dir(app.root.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        if op=="item_create" {let mut input=child.stdin.take().unwrap();input.write_all(args.to_string().as_bytes()).unwrap();} else {drop(child.stdin.take());}
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill(); let _ = child.wait();
                panic!("CLI client timeout");
            }
            thread::sleep(Duration::from_millis(10));
        }
        child.wait_with_output().unwrap()
    };
    let output = run("item_create", json!({"id":"cli-item","requestId":"cli-create","projectId":"cli-project","title":"From CLI"}));
    assert!(output.status.success(), "CLI create failed");
    let output: Value = serde_json::from_slice(&output.stdout).expect("CLI must return JSON");
    // CLI may expose the result directly or retain the RPC envelope.
    let result = output.get("result").unwrap_or(&output);
    assert_eq!(result["item"]["id"], "cli-item");
    assert_eq!(app.pulso("item", json!({"id":"cli-item"}))["item"]["title"], "From CLI");
    assert_eq!(app.pulso("items",json!({"projectId":"cli-project"}))["items"].as_array().unwrap().len(),1);
    assert!(!run("item", json!({"id":"missing"})).status.success());
    app.core("stop", json!({"id":"cli-fixture"}));
    assert!(!run("items", json!({"projectId":"cli-project"})).status.success());
}

#[test]
fn stdio_mcp_creates_project_and_phase_with_scoped_permission_and_stable_retry() {
    let app=Instance::new();app.start("mcp-fixture");
    let grant=app.pulso("grant",json!({"sessionId":"mcp-fixture","canCreateProjects":true,"remember":false}));
    let exchange=|messages:Vec<Value>| -> Vec<Value> {
        let mut child=Command::new(env!("CARGO_BIN_EXE_aw-runner"))
            .arg("--pulso-mcp").env("JAURIA_PULSO_HANDLE",grant["handle"].as_str().unwrap())
            .env("HOME",app.path("home")).current_dir(app.root.path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        {
            let mut input=child.stdin.take().unwrap();
            for message in messages {writeln!(input,"{message}").unwrap();}
        }
        let deadline=Instant::now()+Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            if Instant::now()>=deadline {let _=child.kill();let _=child.wait();panic!("MCP stdio timeout");}
            thread::sleep(Duration::from_millis(10));
        }
        let output=child.wait_with_output().unwrap();
        assert!(output.status.success(),"MCP server exited unsuccessfully");
        output.stdout.split(|b|*b==b'\n').filter(|line|!line.is_empty())
            .map(|line|serde_json::from_slice::<Value>(line).expect("MCP stdout must contain only JSON-RPC lines")).collect()
    };
    let request=|id:u64,method:&str,params:Value|json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    let project=json!({"title":"Plan MCP","idempotencyKey":"mcp-plan-1"});
    let phase=json!({"projectId":"project-mcp-plan-1","title":"Primera fase","idempotencyKey":"mcp-phase-1"});
    let replies=exchange(vec![
        request(1,"initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"synthetic-test","version":"1"}})),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        request(2,"tools/list",json!({})),
        request(3,"tools/call",json!({"name":"jauria_create_project","arguments":project})),
        request(4,"tools/call",json!({"name":"jauria_create_project","arguments":project})),
        request(5,"tools/call",json!({"name":"jauria_create_phase","arguments":phase})),
        request(6,"tools/call",json!({"name":"jauria_create_phase","arguments":phase})),
        request(7,"tools/call",json!({"name":"jauria_phases","arguments":{"projectId":"project-mcp-plan-1"}})),
    ]);
    assert_eq!(replies.len(),7,"the initialized notification must not produce a reply");
    assert_eq!(replies[0]["result"]["protocolVersion"],"2025-11-25");
    assert!(replies[1]["result"]["tools"].as_array().unwrap().iter().any(|tool|tool["name"]=="jauria_create_phase"));
    assert_eq!(replies[2]["result"]["structuredContent"],replies[3]["result"]["structuredContent"]);
    assert_eq!(replies[2]["result"]["structuredContent"]["project"]["mainSessionId"],"mcp-fixture");
    assert_eq!(replies[4]["result"]["structuredContent"],replies[5]["result"]["structuredContent"]);
    assert_eq!(replies[6]["result"]["structuredContent"]["items"].as_array().unwrap().len(),1);
    assert_eq!(app.pulso("projects",json!({}))["projects"].as_array().unwrap().len(),1);
    assert_eq!(app.pulso("items",json!({"projectId":"project-mcp-plan-1"}))["items"].as_array().unwrap().len(),1);
    let phase_read=exchange(vec![request(8,"tools/call",json!({"name":"jauria_phase","arguments":{"id":"phase-mcp-phase-1"}}))]);
    let revision=phase_read[0]["result"]["structuredContent"]["item"]["revision"].clone();
    let updated=exchange(vec![request(9,"tools/call",json!({"name":"jauria_update_phase","arguments":{"id":"phase-mcp-phase-1","expectedRevision":revision,"status":"doing","idempotencyKey":"mcp-phase-edit-1"}}))]);
    assert_eq!(updated[0]["result"]["structuredContent"]["item"]["status"],"doing");
    let revision=updated[0]["result"]["structuredContent"]["item"]["revision"].clone();
    let checkpoint=exchange(vec![request(10,"tools/call",json!({"name":"jauria_checkpoint","arguments":{"itemId":"phase-mcp-phase-1","expectedRevision":revision,"brief":"Fase iniciada","nextAction":"Seguir con la integración","idempotencyKey":"mcp-checkpoint-1"}}))]);
    assert_eq!(checkpoint[0]["result"]["structuredContent"]["checkpoint"]["brief"],"Fase iniciada");
    // An unknown tool (for example the UI-only sidebar_summary) and an invalid
    // status get their own messages, never the uncertain-retry advice.
    let current=app.pulso("item",json!({"id":"phase-mcp-phase-1"}))["item"]["revision"].clone();
    let unclear=exchange(vec![
        request(20,"tools/call",json!({"name":"sidebar_summary","arguments":{}})),
        request(21,"tools/call",json!({"name":"jauria_update_phase","arguments":{"id":"phase-mcp-phase-1","expectedRevision":current,"status":"archived","idempotencyKey":"mcp-phase-bad-status"}})),
    ]);
    assert_eq!(unclear[0]["result"]["isError"],true);
    let unknown=unclear[0]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(unknown.starts_with("Herramienta desconocida") && !unknown.contains("idempotencyKey") && !unknown.contains("reintentar con el mismo"),"{unknown}");
    assert_eq!(unclear[1]["result"]["isError"],true);
    let invalid=unclear[1]["result"]["content"][0]["text"].as_str().unwrap();
    assert!(invalid.starts_with("Estado no válido") && !invalid.contains("idempotencyKey"),"{invalid}");
    assert_eq!(app.pulso("item",json!({"id":"phase-mcp-phase-1"}))["item"]["status"],"doing","an invalid status changes nothing");
    let direct=app.request(true,"item_update",json!({"id":"phase-mcp-phase-1","requestId":"direct-bad-status","expectedRevision":current,"status":"archived"})).unwrap();
    assert_eq!((direct["ok"].clone(),direct["error"].clone()),(json!(false),json!("invalid status")));
    app.pulso("grant",json!({"sessionId":"mcp-fixture","projectId":"project-mcp-plan-1","canCreateProjects":false,"remember":false}));
    let restricted=exchange(vec![
        request(11,"tools/call",json!({"name":"jauria_create_project","arguments":{"title":"Fuera de alcance","idempotencyKey":"mcp-outside-1"}})),
        request(12,"tools/call",json!({"name":"jauria_phase","arguments":{"id":"phase-mcp-phase-1"}})),
        request(13,"tools/call",json!({"name":"jauria_create_phase","arguments":{"projectId":"project-mcp-plan-1","title":"Segunda fase","idempotencyKey":"mcp-phase-2"}})),
    ]);
    assert_eq!(restricted[0]["result"]["isError"],true);
    assert_eq!(restricted[1]["result"]["structuredContent"]["item"]["title"],"Primera fase");
    assert_eq!(restricted[2]["result"]["structuredContent"]["item"]["title"],"Segunda fase");
    assert_eq!(app.pulso("items",json!({"projectId":"project-mcp-plan-1"}))["items"].as_array().unwrap().len(),2);
    app.pulso("revoke",json!({"sessionId":"mcp-fixture"}));
    let denied=exchange(vec![request(14,"tools/call",json!({"name":"jauria_projects","arguments":{}}))]);
    assert_eq!(denied[0]["result"]["isError"],true);
    assert!(!denied[0].to_string().contains(grant["handle"].as_str().unwrap()));
}

#[test]
fn bounded_item_pages_status_position_and_explicit_ui_archive() {
    let app = Instance::new();
    let project = app.project("pages");
    for id in ["page-a", "page-b", "page-c"] { app.item(id, "pages"); }
    let first = app.pulso("items", json!({"projectId":"pages","limit":2}));
    let rows = first["items"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(first["hasMore"], true);
    assert!(first["nextCursor"].is_u64(), "missing numeric continuation cursor");
    let second = app.pulso("items", json!({"projectId":"pages","cursor":first["nextCursor"],"limit":2}));
    let tail = second["items"].as_array().unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(second["hasMore"], false);
    assert!(second["nextCursor"].is_null());
    assert!(rows.iter().all(|row| row["id"] != tail[0]["id"]));
    app.reject("items", json!({"projectId":"pages","limit":0}));
    let original = app.pulso("item", json!({"id":"page-a"}))["item"].clone();
    let updated = app.pulso("item_update", json!({"id":"page-a","requestId":"move-page-a","expectedRevision":original["revision"],"status":"doing","position":12.5}))["item"].clone();
    assert_eq!(updated["status"], "doing");
    assert_eq!(updated["position"], 12.5);
    app.reject("item_update", json!({"id":"page-a","requestId":"invalid-status","expectedRevision":updated["revision"],"status":"not-a-status"}));
    assert_eq!(app.pulso("item", json!({"id":"page-a"}))["item"], updated);
    let archived = app.pulso("item_update", json!({"id":"page-a","requestId":"archive-page-a","expectedRevision":updated["revision"],"archived":true}))["item"].clone();
    assert_eq!(archived["archived"], true);
    assert_eq!(app.pulso("items", json!({"projectId":"pages"}))["items"].as_array().unwrap().len(), 2);
    assert_eq!(app.pulso("project_update", json!({"id":"pages","requestId":"archive-pages","expectedRevision":project["revision"],"archived":true}))["project"]["archived"], true);
}

#[test]
fn kanban_pages_count_exact_filters_and_reject_changed_snapshots() {
    let app = Instance::new();
    app.project("kanban");
    app.project("hidden");
    // Unrelated rows precede the visible rows, exercising SQL scope before LIMIT.
    for n in 0..55 { app.item(&format!("hidden-{n}"), "hidden"); }
    for n in 0..55 { app.item(&format!("todo-{n}"), "kanban"); }
    for status in ["doing", "done"] {
        app.pulso("item_create", json!({"id":status,"requestId":status,"projectId":"kanban","title":status,"status":status}));
    }
    app.pulso("item_create", json!({"id":"standalone","requestId":"standalone","title":"Standalone"}));
    let archived = app.item("archived", "kanban");
    app.pulso("item_update", json!({"id":"archived","requestId":"archive","expectedRevision":archived["revision"],"archived":true}));
    let revision = app.pulso("revision", json!({}))["revision"].clone();
    let first = app.pulso("items", json!({"projectId":"kanban","status":"todo","limit":50,"expectedSnapshotRevision":revision}));
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(first["totalCount"], 55);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["nextCursor"], 50);
    assert_eq!(first["revision"], revision);
    let tail_args = json!({"projectId":"kanban","status":"todo","limit":50,"cursor":first["nextCursor"],"expectedSnapshotRevision":revision});
    let tail = app.pulso("items", tail_args.clone());
    assert_eq!(tail["items"].as_array().unwrap().len(), 5);
    assert_eq!(tail["totalCount"], 55);
    assert_eq!(tail["hasMore"], false);
    assert!(tail["nextCursor"].is_null());
    assert!(tail["items"].as_array().unwrap().iter().all(|row| first["items"].as_array().unwrap().iter().all(|old| old["id"] != row["id"])));
    for (status, count) in [("doing", 1), ("waiting", 0), ("done", 1)] {
        let page = app.pulso("items", json!({"projectId":"kanban","status":status,"limit":50,"expectedSnapshotRevision":revision}));
        assert_eq!(page["totalCount"], count);
        assert_eq!(page["items"].as_array().unwrap().len(), count as usize);
    }
    assert_eq!(app.pulso("items", json!({"projectId":"kanban"}))["totalCount"], 57);
    assert_eq!(app.pulso("items", json!({"projectId":"kanban","archived":true,"status":"todo"}))["totalCount"], 1);
    assert_eq!(app.pulso("items", json!({"projectId":null,"status":"todo"}))["totalCount"], 1);
    for value in [json!(null), json!(true), json!("1"), json!(-1), json!(1.0), json!([]), json!({})] {
        app.reject("items", json!({"expectedSnapshotRevision":value}));
    }
    for value in [json!(null), json!(1), json!("unknown"), json!("TODO")] {
        app.reject("items", json!({"status":value}));
    }
    app.reject("projects", json!({"status":"todo"}));
    app.reject("projects", json!({"expectedSnapshotRevision":revision}));
    thread::scope(|scope| { scope.spawn(|| app.item("concurrent-create", "kanban")).join().unwrap(); });
    let stale = app.request(true, "items", tail_args).unwrap();
    assert_eq!(stale["ok"], false);
    assert_eq!(stale["error"], "revision conflict");
    let revision = app.pulso("revision", json!({}))["revision"].clone();
    let original = app.pulso("item", json!({"id":"todo-0"}))["item"].clone();
    let movement = json!({"id":"todo-0","requestId":"status-only-move","expectedRevision":original["revision"],"status":"doing"});
    let moved = thread::scope(|scope| { scope.spawn(|| app.pulso("item_update", movement.clone())).join().unwrap() });
    assert_eq!(moved["item"]["status"], "doing");
    assert_eq!(moved["item"]["position"], original["position"]);
    assert_eq!(app.pulso("item_update", movement.clone()), moved);
    app.reject("item_update", json!({"id":"todo-0","requestId":"stale-move","expectedRevision":original["revision"],"status":"done"}));
    app.reject("item_update", json!({"id":"todo-0","requestId":"status-only-move","expectedRevision":original["revision"],"status":"done"}));
    assert_eq!(app.pulso("item", json!({"id":"todo-0"}))["item"], moved["item"]);
    assert_eq!(app.request(true, "items", json!({"projectId":"kanban","status":"todo","cursor":50,"expectedSnapshotRevision":revision})).unwrap()["error"], "revision conflict");

    app.start("kanban-agent");
    let grant = app.pulso("grant", json!({"sessionId":"kanban-agent","projectId":"kanban","remember":false}));
    let credential: Value = serde_json::from_slice(&fs::read(grant["handle"].as_str().unwrap()).unwrap()).unwrap();
    let scoped_revision = app.agent(&credential, "revision", json!({}))["result"]["revision"].clone();
    let scoped = app.agent(&credential, "items", json!({"status":"todo","limit":50,"expectedSnapshotRevision":scoped_revision}));
    assert_eq!(scoped["ok"], true);
    assert_eq!(scoped["result"]["totalCount"], 55);
    assert_eq!(scoped["result"]["items"].as_array().unwrap().len(), 50);
    assert!(scoped["result"]["items"].as_array().unwrap().iter().all(|row| row["projectId"] == "kanban"));
    app.item("unrelated-change", "hidden");
    let scoped_tail = app.agent(&credential, "items", json!({"status":"todo","cursor":50,"limit":50,"expectedSnapshotRevision":scoped_revision}));
    assert_eq!(scoped_tail["ok"], true);
    assert_eq!(scoped_tail["result"]["totalCount"], 55);
    assert_eq!(scoped_tail["result"]["items"].as_array().unwrap().len(), 5);
    assert_eq!(app.agent(&credential, "items", json!({"projectId":"hidden","status":"todo"}))["ok"], false);
    assert_eq!(app.agent(&credential, "items", json!({"projectId":null,"status":"todo"}))["result"]["totalCount"], 0);
    app.item("scoped-change", "kanban");
    assert_eq!(app.agent(&credential, "items", json!({"status":"todo","cursor":50,"expectedSnapshotRevision":scoped_revision}))["error"], "revision conflict");
    app.core("stop", json!({"id":"kanban-agent"}));
}

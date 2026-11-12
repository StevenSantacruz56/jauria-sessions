use crate::storage::Store;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt}, io::AsRawFd, net::{UnixListener, UnixStream}},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering}},
    thread,
    time::{Duration, Instant},
};

const MAX_REQUEST: usize = 128 * 1024;
const MAX_INPUT: usize = 16 * 1024;
static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop_signal(_: libc::c_int) { SIGNAL_STOP.store(true, Ordering::Relaxed); }

pub fn validate_id(id: &str) -> Result<()> {
    ensure!(!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "invalid id");
    Ok(())
}

fn dimensions(args: &Value) -> Result<PtySize> {
    fn dimension(args: &Value, key: &str, default: u64) -> Result<u16> {
        let n = match args.get(key) { Some(v) => v.as_u64().context("invalid dimensions")?, None => default };
        ensure!((1..=1000).contains(&n), "dimensions must be 1..1000");
        Ok(n as u16)
    }
    Ok(PtySize { rows: dimension(args,"rows",24)?, cols: dimension(args,"cols",80)?, pixel_width:0, pixel_height:0 })
}

// Only final path components created/owned by this runner are changed. Never chmod a shared parent.
fn private_dir(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(e.into()),
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0, "directory must be owned and private (0700): {}", path.display());
    Ok(())
}

fn private_file(path: &Path) -> Result<File> {
    let f = OpenOptions::new().read(true).write(true).create(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(path)?;
    let meta = f.metadata()?;
    ensure!(meta.is_file() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0 && meta.nlink() == 1, "file must be owned and private (0600)");
    Ok(f)
}

// Read-only inventory; never use discovered/persisted PIDs as signal authority.
// The Unix session leader is pinned by WNOWAIT during the exit-time check.
#[cfg(target_os="macos")]
fn session_survivors(sid: u32) -> Result<Vec<u32>> {
    let mut pids=vec![0i32;65536];
    let count=unsafe {libc::proc_listallpids(pids.as_mut_ptr().cast(),(pids.len()*std::mem::size_of::<i32>()) as i32)};
    ensure!(count>0 && (count as usize)<pids.len(),"process inventory unavailable or truncated");
    let mut survivors=Vec::new();
    for pid in pids.into_iter().take(count as usize).filter(|&p|p>0 && p!=sid as i32) {
        let found=unsafe {libc::getsid(pid)};
        if found==sid as i32 {survivors.push(pid as u32);}
        else if found<0 {
            let error=std::io::Error::last_os_error();
            ensure!(error.raw_os_error()==Some(libc::ESRCH),"cannot inspect process session safely");
        }
    }
    Ok(survivors)
}
#[cfg(not(target_os="macos"))]
fn session_survivors(_: u32) -> Result<Vec<u32>> { bail!("session inventory is only implemented for this macOS trial") }

struct Lifecycle { reaped: bool, uncertain: bool, stopping: bool }
struct Owned {
    pid: u32,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    lifecycle: Mutex<Lifecycle>,
    exited: AtomicBool,
    reader_done: AtomicBool,
    output_lost: AtomicBool,
    done: Mutex<bool>,
    wake: Condvar,
}

impl Owned {
    fn signal(&self, signal: i32) -> Result<()> {
        let mut life = self.lifecycle.lock().unwrap();
        if life.reaped { return Ok(()); }
        ensure!(!life.uncertain, "child identity uncertain; refusing signal");
        // The wait thread uses WNOWAIT, then takes this same mutex before reaping.
        // Therefore this owned, unreaped child pins the PID for the entire signal operation.
        let pid = self.pid as i32;
        // portable-pty 0.9's Unix spawn calls setsid before exec. The unreaped
        // leader pins this group ID, including when getpgid(zombie) would fail.
        let target = -pid;
        if unsafe { libc::kill(target, signal) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) { return Err(error.into()); }
        }
        life.stopping = true;
        Ok(())
    }

    fn wait_done(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap();
        *self.wake.wait_timeout_while(done, timeout, |v| !*v).unwrap().0
    }

    fn stop(&self) -> Result<bool> {
        self.signal(libc::SIGTERM)?;
        if self.wait_done(Duration::from_millis(500)) { return Ok(true); }
        self.signal(libc::SIGKILL)?;
        Ok(self.wait_done(Duration::from_millis(1500)))
    }

    fn input(&self, data: &[u8]) -> Result<()> {
        ensure!(!self.exited.load(Ordering::Acquire), "child already exited");
        let mut writer = self.writer.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut offset = 0;
        while offset < data.len() {
            match writer.write(&data[offset..]) {
                Ok(0) => bail!("PTY closed"),
                Ok(n) => offset += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                Err(e) => return Err(e).context(format!("PTY input failed after {offset} bytes")),
            }
        }
        Ok(())
    }
}

struct ClientPermit(Arc<AtomicUsize>);
impl Drop for ClientPermit { fn drop(&mut self){self.0.fetch_sub(1,Ordering::AcqRel);} }

struct CodexJob {control:crate::codex_runtime::Control,worker:thread::JoinHandle<()>}

struct VerificationJob { cancel: Arc<AtomicBool>, worker: thread::JoinHandle<()> }

pub struct Runner {
    data_dir: PathBuf,
    socket: PathBuf,
    token: String,
    generation: String,
    _lock: File,
    db: Arc<Mutex<Store>>,
    owned: Mutex<HashMap<String, Arc<Owned>>>,
    mutations: Arc<Mutex<()>>,
    workspace_mutations: Mutex<()>,
    quitting: AtomicBool,
    quota_cache: Mutex<Value>,
    quota_refreshing: AtomicBool,
    quota_task: Mutex<Option<thread::JoinHandle<()>>>,
    verification_jobs: Mutex<HashMap<String,VerificationJob>>,
    codex_jobs:Mutex<HashMap<String,CodexJob>>,
    resources: Mutex<crate::resources::ResourcesSampler>,
    // Per-instance fault injection: never change process-wide environment or inventory.
    #[cfg(test)]
    inventory: Arc<dyn Fn(u32) -> Result<Vec<u32>> + Send + Sync>,
}

impl Runner {
    pub fn open(data_dir: PathBuf, socket: PathBuf, token_file: PathBuf) -> Result<Self> {
        ensure!(data_dir.is_absolute() && socket.is_absolute() && token_file.is_absolute(), "paths must be absolute");
        private_dir(&data_dir)?;
        let data_dir = fs::canonicalize(data_dir)?;
        private_dir(socket.parent().context("socket parent")?)?;
        private_dir(token_file.parent().context("token parent")?)?;
        ensure!(socket.as_os_str().as_encoded_bytes().len() < 104, "socket path too long");
        let lock = private_file(&data_dir.join("runner.lock"))?;
        ensure!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0, "runner already owns data-dir");
        let mut token_handle = private_file(&token_file)?;
        let mut token = String::new();
        (&mut token_handle).take(4097).read_to_string(&mut token)?;
        if token.is_empty() {
            let mut bytes = [0u8; 32];
            File::open("/dev/urandom")?.read_exact(&mut bytes)?;
            token = bytes.iter().map(|b| format!("{b:02x}")).collect();
            token_handle.write_all(token.as_bytes())?;
            token_handle.sync_all()?;
        }
        let token = token.trim().to_owned();
        ensure!((32..=4096).contains(&token.len()) && !token.chars().any(char::is_whitespace), "invalid token file");
        // Reject pre-existing symlinks/hardlinks before SQLite opens its files.
        for name in ["runner.sqlite", "runner.sqlite-wal", "runner.sqlite-shm"] {
            let path = data_dir.join(name);
            if path.try_exists()? { private_file(&path)?; }
        }
        let db_file = private_file(&data_dir.join("runner.sqlite"))?;
        drop(db_file);
        let mut db = Store::open(&data_dir.join("runner.sqlite"))?;
        for session in db.sessions()? {
            if matches!(session["status"].as_str(), Some("starting" | "running" | "needs_attention")) {
                let status = match session["pid"].as_u64() {
                    Some(pid) if pid > 0 && pid <= i32::MAX as u64 => {
                        let found = unsafe { libc::kill(pid as i32, 0) };
                        if found < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                            // workspace=null now also identifies native standalone
                            // providers; it never proves their descendants are gone.
                            if session_survivors(pid as u32).is_ok_and(|p|p.is_empty()) {"interrupted"} else {"needs_attention"}
                        } else { "needs_attention" }
                    }
                    _ => "needs_attention",
                };
                db.state(session["id"].as_str().unwrap(), status, json!({"reason":"previous generation; no owned handle; never restarted", "identity":"unverified"}))?;
            }
        }
        let mut random = [0u8;16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        Ok(Self {data_dir, socket, token, generation: STANDARD.encode(random), _lock:lock, db:Arc::new(Mutex::new(db)), owned:Mutex::new(HashMap::new()), mutations:Arc::new(Mutex::new(())), workspace_mutations:Mutex::new(()), quitting:AtomicBool::new(false), quota_cache:Mutex::new(json!({"codex":{"available":false,"error":"Pulsa actualizar para consultar"},"claude":{"available":false,"error":"Sin consultar"}})), quota_refreshing:AtomicBool::new(false), quota_task:Mutex::new(None), verification_jobs:Mutex::new(HashMap::new()),codex_jobs:Mutex::new(HashMap::new()), resources:Mutex::new(crate::resources::ResourcesSampler::default()),
            #[cfg(test)] inventory: Arc::new(session_survivors),
        })
    }

    fn inventory(&self, sid: u32) -> Result<Vec<u32>> {
        #[cfg(test)]
        { (self.inventory)(sid) }
        #[cfg(not(test))]
        { session_survivors(sid) }
    }

    pub fn serve(self: Arc<Self>) -> Result<()> {
        unsafe {
            libc::signal(libc::SIGTERM, stop_signal as *const () as usize);
            libc::signal(libc::SIGINT, stop_signal as *const () as usize);
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
        // Never unlink a socket with a live listener, even when it belongs to another data-dir.
        if fs::symlink_metadata(&self.socket).is_ok() {
            ensure!(fs::symlink_metadata(&self.socket)?.file_type().is_socket(), "socket path is not a socket");
            match UnixStream::connect(&self.socket) {
                Ok(_) => bail!("socket already live"),
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => fs::remove_file(&self.socket)?,
                Err(e) => return Err(e.into()),
            }
        }
        let listener = UnixListener::bind(&self.socket)?;
        fs::set_permissions(&self.socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let clients = Arc::new(AtomicUsize::new(0));
        let mut accept_error = None;
        while !self.quitting.load(Ordering::Acquire) && !SIGNAL_STOP.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream,_)) => {
                    if clients.load(Ordering::Acquire) >= 16 { drop(stream); continue; }
                    clients.fetch_add(1, Ordering::AcqRel);
                    let runner = self.clone();
                    let permit=ClientPermit(clients.clone());
                    let _=thread::Builder::new().name("jauria-client".into()).spawn(move || {
                        let _permit=permit;
                        let _ = runner.connection(stream);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => { accept_error = Some(e); break; }
            }
        }
        self.cleanup_owned();
        drop(listener);
        fs::remove_file(&self.socket)?;
        if let Some(e) = accept_error { return Err(e.into()); }
        Ok(())
    }

    // Cleanup-only access after quitting is fenced. Poisoned admission gates
    // never authorize new work; recovering their guard here only stops custody.
    fn cleanup_owned(&self) {
        self.quitting.store(true, Ordering::Release);
        let _workspace = self.workspace_mutations.lock().unwrap_or_else(|error|error.into_inner());
        let _guard = self.mutations.lock().unwrap_or_else(|error|error.into_inner());
        let codex_jobs=std::mem::take(&mut *self.codex_jobs.lock().unwrap());
        for job in codex_jobs.values(){job.control.stop.store(true,Ordering::Release);}
        let children: Vec<_> = self.owned.lock().unwrap().values().cloned().collect();
        let verification_jobs=std::mem::take(&mut *self.verification_jobs.lock().unwrap());
        for job in verification_jobs.values(){job.cancel.store(true,Ordering::Release);}
        // At most two active children. Cleanup never consults persisted PIDs.
        for child in children { if let Err(e) = child.stop() { eprintln!("cleanup: {e:#}"); } }
        // Verification post-capture takes the workspace gate. Release both
        // gates before joining; quitting already fences every new writer.
        drop(_guard);drop(_workspace);
        for (_,job) in verification_jobs {let _=job.worker.join();}
        for (_,job) in codex_jobs {let _=job.worker.join();}
        // Join the bounded account-query task so its child is reaped before the
        // supervisor exits. No query runs while holding the session mutation lock.
        if let Some(task)=self.quota_task.lock().unwrap().take(){let _=task.join();}
    }

    fn connection(self: &Arc<Self>, mut stream: UnixStream) -> Result<()> {
        // BSD/macOS accept can inherit O_NONBLOCK from the listener.
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let response = (|| -> Result<Value> {
            let mut line = Vec::new();
            BufReader::new((&stream).take((MAX_REQUEST + 1) as u64)).read_until(b'\n', &mut line)?;
            ensure!(line.len() <= MAX_REQUEST && line.last() == Some(&b'\n'), "request too large or missing newline");
            self.request(serde_json::from_slice(&line)?)
        })();
        let value = match response { Ok(value) => json!({"ok":true,"result":value}), Err(e) => json!({"ok":false,"error":e.to_string()}) };
        serde_json::to_writer(&mut stream, &value)?;
        stream.write_all(b"\n")?;
        Ok(())
    }

    fn request(self: &Arc<Self>, request: Value) -> Result<Value> {
        ensure!(request["version"] == 1, "unsupported protocol version");
        let supplied = request["token"].as_str().unwrap_or("");
        let mismatch = supplied.as_bytes().iter().zip(self.token.as_bytes()).fold(0u8, |v,(a,b)| v | (a ^ b));
        ensure!(supplied.len() == self.token.len() && mismatch == 0, "unauthorized");
        let op = request["op"].as_str().context("op required")?;
        let args = request["args"].as_object().context("args must be an object")?;
        let allowed: &[&str] = match op {
            "status" => &["workspaceAfter"],
            "shutdown" | "diagnostic_preview" | "telemetry" | "refresh_quotas" => &[],
            "register_project" => &["id","path"],
            "close_project" | "reopen_project" => &["id"],
            "create_task" => &["id","projectId","title","objective","acceptanceCriteria"],
            "prepare_task" | "revalidate_task" | "workflow" | "reopen_task" | "verifications" => &["id"],
            "verification" | "cancel_verification" => &["id","runId"],
            "prepare_verification" => &["id","requestId","snapshotId","argv"],
            "begin_verification" => &["id","runId","approvalNonce"],
            "release_verification" => &["id","runId","confirmed"],
            "purge_verifications" => &["id","confirmed"],
            "snapshot_task" | "workflow_artifact" => &["id","artifactId"],
            "review_task" => &["id","artifactId","snapshotId","verdict","notes","confirmed","verificationId"],
            "handoff_task" => &["id","artifactId","snapshotId","destination","notes"],
            "archive_task" | "purge_workflow" => &["id","confirmed"],
            "start_task" => &["id","sessionId","kind","rows","cols"],
            "open_handoff" => &["id","artifactId","requestId","sessionId","rows","cols"],
            "start_codex" => &["id","title","kind","cwd","rows","cols"],
            "start_codex_task" => &["id","sessionId","kind","rows","cols"],
            "codex_state" => &["id"],"codex_request" => &["id","requestId"],
            "codex_resume" => &["id","generation"],
            "codex_turn" | "codex_command" => &["id","commandId","turnId","attemptId","generation","prompt"],
            "codex_interrupt" => &["id","turnId","attemptId","generation"],
            "codex_permission" => &["id","requestId","generation","decision","nativeConfirmed"],
            "start" => &["id","title","kind","rows","cols","cwd"],
            "input" => &["id","data"], "resize" => &["id","rows","cols"],
            "stop" => &["id","generation"], "interrupt" => &["id"], "purge_history" | "compact_history" => &["id","confirmed"], "release" => &["id","confirmed","generation"], "events" => &["after","limit"],
            _ => bail!("unknown operation"),
        };
        ensure!(args.keys().all(|k| allowed.contains(&k.as_str())), "unexpected argument");
        let args = &request["args"];
        if matches!(op,"start_codex"|"start_codex_task"|"codex_state"|"codex_request"|"codex_resume"|"codex_turn"|"codex_command"|"codex_interrupt"|"codex_permission") {return self.codex_request(op,args);}
        if op=="stop" {
            let id=args["id"].as_str().context("Falta sesión")?;
            let structured=self.db.lock().unwrap().session(id)?.is_some_and(|s|s["transport"]=="app-server");
            if structured{return self.stop_codex(id,args["generation"].as_i64().context("La detención estructurada requiere la generación esperada")?);}
        }
        if op == "refresh_quotas" {
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            if self.quota_refreshing.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_ok() {
                let owner=self.clone();
                let task=thread::spawn(move || {
                    let result=std::panic::catch_unwind(crate::quotas::read);
                    if let Ok(value)=result { *owner.quota_cache.lock().unwrap()=value; }
                    owner.quota_refreshing.store(false,Ordering::Release);
                });
                *self.quota_task.lock().unwrap()=Some(task);
            }
            return Ok(json!({"refreshing":true}));
        }
        if op == "telemetry" {
            // Only current-generation owned unreaped leaders. Persisted PIDs never
            // confer authority; metrics never send signals. Keep leaders pinned.
            let mut owned:Vec<_>=self.owned.lock().unwrap().values().cloned().collect();
            owned.sort_by_key(|child|child.pid);
            let guards:Vec<_>=owned.iter().map(|child|child.lifecycle.lock().unwrap()).collect();
            let discovery=crate::resource_tree::observe(std::process::id());
            let mut pids=vec![std::process::id()];
            if let Some(observed)=discovery["pids"].as_array(){pids.extend(observed.iter().filter_map(|p|p.as_u64().map(|p|p as u32)));}
            for (child,life) in owned.iter().zip(&guards) { if !life.reaped && !life.uncertain {pids.push(child.pid);} }
            let mut resources=self.resources.lock().unwrap().sample(&pids);
            if let Some(rows)=resources["processes"].as_array_mut() {
                for row in rows { row["role"]=json!(if row["pid"]==std::process::id(){"runner"}else if owned.iter().zip(&guards).any(|(child,life)|!life.reaped && !life.uncertain && row["pid"]==child.pid){"cli"}else{"tool"}); }
            }
            resources["discovery"]=discovery;
            drop(guards);
            let mut quotas=self.quota_cache.lock().unwrap().clone();
            quotas["claude"]=crate::claude_quota::read(&self.data_dir);
            return Ok(json!({"resources":resources,"quotas":quotas,"quotasRefreshing":self.quota_refreshing.load(Ordering::Acquire)}));
        }
        if op == "diagnostic_preview" { return crate::diagnostics::preview(&self.db.lock().unwrap()); }
        if op == "status" {
            let db = self.db.lock().unwrap();
            let revision:String=db.0.query_row("SELECT printf('%d:%d:%d:%d',(SELECT count(*) FROM projects),(SELECT count(*) FROM tasks),(SELECT COALESCE(MAX(seq),0) FROM task_audit),(SELECT COALESCE(sum(revision),0) FROM project_states))",[],|row|row.get(0))?;
            let unchanged=args["workspaceAfter"].as_str()==Some(revision.as_str());
            let mut result=json!({"pid":std::process::id(),"generation":self.generation,"sessions":db.sessions()?,"lastSeq":db.last_seq()?,"statusVersion":2,"terminalSessionVersion":1,"normalTerminalVersion":1,"claudeNativeConfigVersion":1,"projectLifecycleVersion":1,"workspaceVersion":1,"workflowVersion":1,"telemetryVersion":1,"verificationVersion":1,"recoveryVersion":1,"handoffVersion":1,"codexVersion":1,"retention":db.retention()?,"workspaceRevision":revision,"workspaceNotModified":unchanged});
            if !unchanged {result["projects"]=json!(crate::projects::projects(&db.0)?);result["tasks"]=json!(crate::projects::tasks(&db.0)?);}
            return Ok(result);
        }
        if op == "events" {
            let after = args.get("after").map(|v| v.as_i64().context("invalid cursor")).transpose()?.unwrap_or(0);
            let limit = args.get("limit").map(|v| v.as_u64().context("invalid limit")).transpose()?.unwrap_or(128);
            return self.db.lock().unwrap().events(after, limit.min(256) as usize);
        }
        if matches!(op,"verifications"|"verification") {
            let db=self.db.lock().unwrap();let id=args["id"].as_str().context("Falta tarea")?;
            return if op=="verifications" {crate::verification::summary(&db.0,id)} else {crate::verification::get(&db.0,id,args["runId"].as_str().context("Falta verificación")?)};
        }
        if op=="cancel_verification" {
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            let id=args["id"].as_str().context("Falta tarea")?;let run=args["runId"].as_str().context("Falta verificación")?;
            crate::verification::get(&self.db.lock().unwrap().0,id,run)?;
            let jobs=self.verification_jobs.lock().unwrap();
            // A durable begin may precede job registration. Persist cancellation
            // even in that gap; registration reads this intent under mutations.
            let result=crate::verification::cancel_requested(&self.db,run)?;
            if let Some(job)=jobs.get(run){job.cancel.store(true,Ordering::Release);}
            return Ok(result);
        }
        if matches!(op,"prepare_verification"|"begin_verification"|"release_verification"|"purge_verifications") {
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Operación de proyecto en curso. Espera y consulta el estado."))?;
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            if matches!(op,"prepare_verification"|"begin_verification") {
                crate::projects::ensure_task_open(&self.db.lock().unwrap().0,args["id"].as_str().context("Falta tarea")?)?;
            }
            return match op {
                "prepare_verification"=>crate::verification::prepare(&self.db,args),
                "begin_verification"=>self.begin_verification(args),
                "release_verification"=>crate::verification::release(&self.db,args),
                "purge_verifications"=>crate::verification::purge(&self.db,args),
                _=>unreachable!(),
            };
        }
        if matches!(op,"purge_workflow"|"workflow_artifact"|"workflow"|"snapshot_task"|"review_task"|"handoff_task"|"archive_task"|"reopen_task") {
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Operación de proyecto en curso. Espera y consulta el estado."))?;
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            return crate::git_worktree::operation(||crate::workflow::request(&self.db,op,args));
        }
        if matches!(op,"register_project"|"close_project"|"reopen_project"|"create_task"|"prepare_task"|"revalidate_task"|"open_handoff"|"start_task") {
            let _workspace = self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Hay una operación de proyecto en curso; consulta su estado antes de reintentar"))?;
            ensure!(!self.quitting.load(Ordering::Acquire), "runner is shutting down");
            let id = args["id"].as_str().context("id required")?;
            crate::projects::id(id)?;
            return crate::git_worktree::operation(|| {
                match op {
                    "register_project" => crate::projects::register(&self.db,id,args["path"].as_str().context("Falta ruta")?),
                    "close_project" | "reopen_project" => {
                        let _guard=self.mutations.lock().map_err(|_|anyhow::anyhow!("No se pudo confirmar el estado; reconecta antes de continuar"))?;
                        crate::projects::set_closed(&self.db,id,op=="close_project")
                    },
                    "create_task" => crate::projects::create(&self.db,&self.data_dir,args),
                    "revalidate_task" => {
                        crate::workflow::revalidatable(&self.db,id)?;
                        crate::projects::revalidate(&self.db,&self.data_dir,id)
                    },
                    "prepare_task" => {
                        {let db=self.db.lock().unwrap();crate::verification::ensure_available(&db.0,id)?;
                        let task=crate::projects::task(&db.0,id)?;
                        ensure_workspace_available(Path::new(task["worktreePath"].as_str().context("Ruta inválida")?),&db.sessions()?)?;}
                        crate::projects::prepare(&self.db,&self.data_dir,id)
                    },
                    "open_handoff" => {
                        crate::projects::ensure_task_open(&self.db.lock().unwrap().0,id)?;
                        let effect=crate::handoff::claim(&self.db,args)?;
                        let sid=args["sessionId"].as_str().context("Falta sesión")?;
                        if effect["shouldStart"]!=true {
                            let mut result=effect;result["session"]=self.db.lock().unwrap().session(sid)?.unwrap_or(Value::Null);return Ok(result);
                        }
                        let _guard=self.mutations.lock().unwrap();
                        let started=if self.quitting.load(Ordering::Acquire){Err(anyhow::anyhow!("Runner closing; handoff session not started"))}
                            else {
                                (|| -> Result<Value> {
                                    crate::workflow::writable(&self.db,id)?;
                                    let grant=crate::handoff::claimed_start(&self.db.lock().unwrap().0,args)?;
                                    let launch=json!({"id":sid,"kind":effect["kind"],"title":effect["title"],"cwd":effect["cwd"],"taskId":id,"rows":args["rows"],"cols":args["cols"]});
                                    self.start_claimed(sid,&launch,Some(&grant))
                                })()
                            };
                        let stored=self.db.lock().unwrap().session(sid)?;
                        let phase=if started.is_ok(){"opened"}else if stored.is_some(){"uncertain"}else{"failed"};
                        let mut result=crate::handoff::complete(&self.db,args,&json!({"phase":phase,"sessionId":stored.as_ref().map(|_|sid)}))?;
                        result["shouldStart"]=json!(false);result["session"]=stored.unwrap_or(Value::Null);
                        if started.is_err(){result["notice"]=json!("La apertura no se confirmó. Consulta el estado; no se reintenta ni se envía contexto automáticamente.");}
                        Ok(result)
                    },
                    "start_task" => {
                        let session_id = args["sessionId"].as_str().context("Falta ID de sesión")?;
                        validate_id(session_id)?;
                        let kind = args["kind"].as_str().context("Falta proveedor")?;
                        ensure!(["codex","claude","fixture","shell"].contains(&kind),"Proveedor de tarea inválido");
                        if let Some(existing) = self.db.lock().unwrap().session(session_id)? {
                            ensure!(existing["taskId"] == id && existing["kind"] == kind,"El ID de sesión ya tiene otro contenido");
                            return Ok(existing);
                        }
                        crate::handoff::session_admission(&self.db.lock().unwrap().0,session_id,&Value::Null,None)?;
                        let size = dimensions(args)?;
                        // Do not inspect Git while an existing task writer may be
                        // committing/rebasing. Refuse before any task-state change.
                        {
                            let db = self.db.lock().unwrap();
                            let sessions = db.sessions()?;
                            ensure!(!sessions.iter().any(|s|s["taskId"]==id && matches!(s["status"].as_str(),Some("starting"|"running"|"needs_attention"))), "La tarea ya tiene una sesión abierta o incierta");
                            let task = crate::projects::task(&db.0,id)?;
                            ensure_workspace_available(Path::new(task["worktreePath"].as_str().context("Ruta de tarea inválida")?),&sessions)?;
                            ensure!(occupied_slots(&sessions)<2,"concurrency limit is 2");
                        }
                        ensure!(!crate::workflow::archived(&self.db.lock().unwrap().0,id)?,"La tarea está archivada. Reábrela antes de iniciar una sesión.");
                        crate::verification::ensure_available(&self.db.lock().unwrap().0,id)?;
                        let task = crate::projects::ready(&self.db,id)?;
                        let _guard = self.mutations.lock().unwrap();
                        ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
                        self.start(session_id,&json!({"id":session_id,"kind":kind,"title":task["title"],"cwd":task["worktreePath"],"taskId":id,"rows":size.rows,"cols":size.cols}))
                    }
                    _ => unreachable!(),
                }
            });
        }
        if op=="start" {
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Hay una operación de proyecto en curso; consulta su estado antes de reintentar"))?;
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            let id=args["id"].as_str().context("id required")?;validate_id(id)?;
            return self.start(id,args);
        }
        let _guard = self.mutations.lock().unwrap();
        ensure!(!self.quitting.load(Ordering::Acquire), "runner is shutting down");
        if op == "shutdown" {
            for job in self.verification_jobs.lock().unwrap().values(){job.cancel.store(true,Ordering::Release);}
            self.quitting.store(true, Ordering::Release);
            return Ok(json!({"shuttingDown":true}));
        }
        let id = args["id"].as_str().context("id required")?;
        validate_id(id)?;
        if matches!(op,"purge_history"|"compact_history") {
            ensure!(args["confirmed"]==true,"Confirma la eliminación del historial.");
            return if op=="compact_history" {self.db.lock().unwrap().compact_final_history(&[id.to_owned()])}else{self.db.lock().unwrap().purge_history(&[id.to_owned()])};
        }
        let stored = self.db.lock().unwrap().session(id)?.context("unknown session")?;
        let child = self.owned.lock().unwrap().get(id).cloned();
        if op == "release" {
            ensure!(args["confirmed"] == true, "explicit confirmation is required");
            ensure!(stored["status"] == "needs_attention", "only uncertain sessions can be released");
            if stored["transport"]=="app-server"{ensure!(args["generation"].as_i64().is_some() && args["generation"]==stored["codex"]["generation"],"La conexión cambió; confirma la liberación de la generación actual");}
            if let Some(child)=&child {ensure!(*child.done.lock().unwrap(),"session is still closing; wait before releasing");}
            ensure!(self.codex_jobs.lock().unwrap().get(id).is_none_or(|job|job.worker.is_finished()),"La conexión propia sigue cerrándose; espera antes de liberar");
            self.owned.lock().unwrap().remove(id);
            if stored["transport"]=="app-server" {
                let db=self.db.lock().unwrap();let generation=crate::codex_store::get_session(&db.0,id)?["generation"].as_i64().context("Generación inválida")?;
                crate::codex_store::fence_session(&db.0,id,generation)?;
            }
            self.db.lock().unwrap().state(id,"released",json!({"reason":"explicit operator acknowledgement; no process was signaled; history retained"}))?;
            return self.db.lock().unwrap().session(id)?.context("session missing");
        }
        if op == "stop" && child.is_none() {
            ensure!(matches!(stored["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")), "session is not owned; refusing signal");
            return Ok(stored);
        }
        let child = child.context("session is not owned by this generation")?;
        match op {
            "input" => {
                let data = args["data"].as_str().context("data must be UTF8 string")?;
                ensure!(data.len() <= MAX_INPUT, "input exceeds 16KiB");
                child.input(data.as_bytes())?;
                Ok(json!({"written":data.len()}))
            }
            "interrupt" => {
                let vintr = child.master.lock().unwrap().get_termios().context("PTY termios unavailable")?.control_chars[libc::VINTR];
                child.input(&[vintr])?;
                Ok(json!({"sent":true}))
            }
            "resize" => {
                ensure!(!child.exited.load(Ordering::Acquire), "child already exited");
                let size = dimensions(args)?;
                let master = child.master.lock().unwrap();
                master.resize(size)?;
                let actual = master.get_size()?;
                self.db.lock().unwrap().resize(id,actual.rows,actual.cols)?;
                Ok(json!({"rows":actual.rows,"cols":actual.cols}))
            }
            "stop" => {
                ensure!(child.stop()?, "termination pending; no confirmed wait result");
                self.db.lock().unwrap().session(id)?.context("session missing")
            }
            _ => bail!("unknown operation"),
        }
    }

    // Caller holds workspace/session admission gates only through durable begin
    // and worker registration. No gate is held during command execution.
    fn begin_verification(self:&Arc<Self>,args:&Value)->Result<Value>{
        let existing=crate::verification::get(&self.db.lock().unwrap().0,args["id"].as_str().context("Falta tarea")?,args["runId"].as_str().context("Falta verificación")?)?;
        if existing["status"]!="prepared" {return Ok(existing);}
        {
            let mut jobs=self.verification_jobs.lock().unwrap();
            jobs.retain(|_,job|!job.worker.is_finished());
            ensure!(jobs.len()<1,"Ya hay una verificación en curso. Espera o cancélala.");
        }
        let run=crate::verification::begin(&self.db,args)?;
        if run["shouldExecute"]!=true{return Ok(run);}
        self.register_begun_verification(args,run)
    }

    fn register_begun_verification(self:&Arc<Self>,args:&Value,run:Value)->Result<Value>{
        let _launch_registration=self.mutations.lock().unwrap();
        if self.quitting.load(Ordering::Acquire){
            return crate::verification::finish(&self.db,run["runId"].as_str().context("Falta verificación")?,json!({"status":"cancelled","spawned":false,"stdout":"","stderr":"","truncated":false}),Err(anyhow::anyhow!("Runner closing before spawn")));
        }
        let run_id=args["runId"].as_str().context("Falta verificación")?.to_owned();
        let execution=(||->Result<_>{
            let argv=run["argv"].as_array().context("Comando inválido")?.iter().map(|arg|arg.as_str().map(str::to_owned).context("Argumento inválido")).collect::<Result<Vec<_>>>()?;
            let cwd=PathBuf::from(run["cwd"].as_str().context("Carpeta inválida")?);
            let approved=crate::verification_process::ApprovedDirectory::open(&cwd,run["cwdDev"].as_u64().context("Identidad de carpeta inválida")?,run["cwdIno"].as_u64().context("Identidad de carpeta inválida")?)?;
            Ok((argv,approved))
        })();
        let (argv,approved)=match execution {
            Ok(values)=>values,
            Err(_)=>return crate::verification::finish(&self.db,&run_id,json!({"status":"cancelled","spawned":false,"stdout":"","stderr":"","truncated":false}),Err(anyhow::anyhow!("Approved execution could not be validated; command not started"))),
        };
        let cancel=Arc::new(AtomicBool::new(false));
        // cancel_verification and registration share mutations: cancellation in
        // the durable-begin gap is transferred before any worker can launch.
        let current=crate::verification::get(&self.db.lock().unwrap().0,args["id"].as_str().context("Falta tarea")?,&run_id)?;
        cancel.store(current["status"]=="cancel_requested",Ordering::Release);
        let token=cancel.clone();let owner=self.clone();let identity=run_id.clone();
        let worker=thread::Builder::new().name("jauria-verification".into()).spawn(move||{
            let executed=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||crate::verification_process::execute_approved(&argv,&approved,&token,&owner.mutations)));
            let process=match executed {
                Ok(Ok(value))=>value,
                Ok(Err(error))=>json!({"status":"uncertain","stdout":"","stderr":"","truncated":true,"explanation":error.to_string().chars().take(512).collect::<String>()}),
                Err(_)=>json!({"status":"uncertain","stdout":"","stderr":"","truncated":true,"explanation":"Execution supervisor panicked; explicit inspection required"}),
            };
            let after={
                let _workspace=owner.workspace_mutations.lock().unwrap();
                if owner.quitting.load(Ordering::Acquire){Err(anyhow::anyhow!("Runner closing; post-command snapshot not captured"))}
                else{crate::verification::capture_for_run(&owner.db,&identity)}
            };
            if crate::verification::finish(&owner.db,&identity,process,after).is_err(){
                eprintln!("verification persistence failed; retaining recovery fence");owner.quitting.store(true,Ordering::Release);
            }
        });
        let worker=match worker {
            Ok(worker)=>worker,
            Err(_)=>return crate::verification::finish(&self.db,&run_id,json!({"status":"failed","spawned":false,"stdout":"","stderr":"","truncated":false}),Err(anyhow::anyhow!("Verification worker unavailable; command not started"))),
        };
        self.verification_jobs.lock().unwrap().insert(run_id,VerificationJob{cancel,worker});
        let mut response=run;response["shouldExecute"]=json!(false);response["executionStarted"]=json!(true);
        Ok(response)
    }

    fn start(self: &Arc<Self>, id: &str, args: &Value) -> Result<Value> {
        self.start_claimed(id,args,None)
    }
    // Callers hold workspace_mutations then mutations through durable insert/spawn.
    fn start_claimed(self: &Arc<Self>, id: &str, args: &Value, grant: Option<&crate::handoff::ClaimedStart>) -> Result<Value> {
        if grant.is_some(){crate::handoff::session_admission(&self.db.lock().unwrap().0,id,args,grant)?;}
        if let Some(existing) = self.db.lock().unwrap().session(id)? {
            ensure!(existing["kind"] == args["kind"] && existing["title"] == args["title"] && existing["taskId"] == args["taskId"] && (args["cwd"].is_null() || existing["cwd"] == args["cwd"]), "El ID de sesión ya tiene otro contenido");
            return Ok(existing);
        }
        crate::handoff::session_admission(&self.db.lock().unwrap().0,id,args,grant)?;
        {let db=self.db.lock().unwrap();db.ensure_capacity()?;ensure!(occupied_slots(&db.sessions()?)<2,"El límite es 2; las sesiones inciertas conservan su plaza hasta liberarlas");}
        let size = dimensions(args)?;
        let title = args["title"].as_str().context("title required")?;
        ensure!(title.len() <= 512, "title too long");
        let kind = args["kind"].as_str().context("kind required")?;
        ensure!(["fixture","shell","terminal","claude_probe","codex_probe","claude","codex"].contains(&kind), "unknown kind");
        let interactive = matches!(kind, "claude" | "codex" | "terminal");
        let selected = if interactive || args["taskId"].is_string() {
            let requested = PathBuf::from(args["cwd"].as_str().context("select a working directory first")?);
            ensure!(requested.is_absolute(), "working directory must be absolute");
            let cwd = fs::canonicalize(&requested).context("working directory is unavailable")?;
            ensure!(cwd.is_dir(), "working directory must be a directory");
            ensure!(!cwd.starts_with(self.data_dir.join("worktrees")) || args["taskId"].is_string(), "Inicia una carpeta administrada desde su tarea, no como sesión independiente");
            let workspace = git_workspace_for(&cwd)?;
            ensure!(workspace.is_some() || !args["taskId"].is_string(), "task working directory must be a Git worktree");
            if let Some(workspace) = &workspace {
                ensure_workspace_available(workspace, &self.db.lock().unwrap().sessions()?)?;
            }
            // A standalone cwd may still be an ancestor of a fenced worktree.
            crate::verification::ensure_path_available(&self.db.lock().unwrap().0,workspace.as_deref().unwrap_or(&cwd))?;
            Some((cwd,workspace))
        } else {
            ensure!(args.get("cwd").is_none_or(Value::is_null), "cwd is only accepted for interactive sessions");
            None
        };
        // Keep only live handles; never count historical database rows as owned children.
        let mut owned = self.owned.lock().unwrap();
        owned.retain(|_,v| !(*v.done.lock().unwrap() && v.lifecycle.lock().unwrap().reaped));
        ensure!(owned.len()+self.codex_jobs.lock().unwrap().values().filter(|job|!job.worker.is_finished()).count() < 2, "concurrency limit is 2");
        drop(owned);
        let work_root = self.data_dir.join("work");
        private_dir(&work_root)?;
        let (cwd,workspace) = match selected {
            Some((cwd,workspace)) => (cwd,workspace),
            None => { let cwd=work_root.join(id);private_dir(&cwd)?;(cwd,None) },
        };
        let mut cmd = command(kind, id, &cwd)?;
        if kind=="claude" {
            cmd.arg("--settings");cmd.arg(crate::claude_quota::settings(&std::env::current_exe()?,&self.data_dir)?);
        }
        let pair = native_pty_system().openpty(size).context("open PTY")?;
        let reader = pair.master.try_clone_reader().context("clone PTY reader")?;
        let writer = pair.master.take_writer().context("take PTY writer")?;
        let fd = pair.master.as_raw_fd().context("Unix PTY fd required")?;
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(flags >= 0 && unsafe { libc::fcntl(fd,libc::F_SETFL,flags | libc::O_NONBLOCK) } >= 0, "cannot set PTY nonblocking");
        let mut session = json!({"id":id,"title":title,"kind":kind,"status":"starting","pid":null,"rows":size.rows,"cols":size.cols,
            "cwd":cwd,"workspace":workspace,"taskId":args["taskId"]});
        self.db.lock().unwrap().insert(&session)?;
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => { self.db.lock().unwrap().state(id,"failed",json!({"reason":e.to_string()}))?; return Err(e.context("spawn PTY child")); }
        };
        drop(pair.slave);
        let pid = match child.process_id() {
            Some(pid) => pid,
            None => {
                let _=child.kill();let _=child.wait();
                self.db.lock().unwrap().state(id,"failed",json!({"reason":"child PID unavailable; owned handle stopped"}))?;
                bail!("child PID unavailable");
            }
        };
        session["pid"] = json!(pid);
        session["status"] = json!("running");
        let saved = self.db.lock().unwrap().activate(id,pid);
        if let Err(e) = saved {
            unsafe { libc::kill(-(pid as i32),libc::SIGKILL); }
            let _ = child.wait();
            let _=self.db.lock().unwrap().state(id,"failed",json!({"reason":"activation failed; owned child stopped"}));
            return Err(e);
        }
        let owned = Arc::new(Owned { pid, master:Mutex::new(pair.master),writer:Mutex::new(writer),
            lifecycle:Mutex::new(Lifecycle {reaped:false,uncertain:false,stopping:false}),
            exited:AtomicBool::new(false),reader_done:AtomicBool::new(false),output_lost:AtomicBool::new(false),done:Mutex::new(false),wake:Condvar::new() });
        self.owned.lock().unwrap().insert(id.to_owned(),owned.clone());
        self.read_output(id.to_owned(),owned.clone(),reader);
        let runner = self.clone();
        let id = id.to_owned();
        thread::spawn(move || {
            // WNOWAIT leaves the owned child unreaped: no PID reuse while stop signals it.
            let observed = loop {
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let result = unsafe { libc::waitid(libc::P_PID,pid as _,&mut info,libc::WEXITED | libc::WNOWAIT) };
                if result == 0 { break Ok(()); }
                let e = std::io::Error::last_os_error();
                if e.kind() != std::io::ErrorKind::Interrupted { break Err(e); }
            };
            let mut life = owned.lifecycle.lock().unwrap();
            let (status, detail) = match observed {
                Ok(()) => {
                    // The unreaped child pins the owned session/group until wait.
                    // End of a managed session also ends its same-group tools,
                    // including natural CLI exit. Escaped groups remain a limit.
                    unsafe { libc::kill(-(pid as i32),libc::SIGKILL); }
                    let remaining={
                        let mut remaining=runner.inventory(pid);
                        for _ in 0..5 {
                            if remaining.as_ref().is_ok_and(|p|p.is_empty()) {break;}
                            thread::sleep(Duration::from_millis(10));remaining=runner.inventory(pid);
                        }
                        Some(remaining)
                    };
                    match child.wait() {
                    Ok(exit) => {
                        life.reaped = true;
                        let detail=json!({"exitCode":exit.exit_code(),"wait":format!("{exit:?}")});
                        match remaining {
                            Some(Ok(pids)) if !pids.is_empty() => ("needs_attention",json!({"waitResult":detail,"survivors":pids,"reason":"other process groups remain in the managed Unix session; no signals sent to discovered PIDs"})),
                            Some(Err(e)) => ("needs_attention",json!({"waitResult":detail,"inventoryError":e.to_string()})),
                            _ => (if life.stopping {"stopped"} else {"exited"},detail),
                        }
                    }
                    Err(e) => {life.uncertain=true; ("needs_attention",json!({"waitError":e.to_string()}))}
                    }
                },
                Err(e) => {life.uncertain=true; ("needs_attention",json!({"waitError":e.to_string()}))}
            };
            owned.exited.store(true,Ordering::Release);
            drop(life);
            let until = Instant::now() + Duration::from_millis(500);
            while !owned.reader_done.load(Ordering::Acquire) && Instant::now() < until { thread::sleep(Duration::from_millis(5)); }
            let (mut status, mut detail) = if owned.reader_done.load(Ordering::Acquire) {
                (status, detail)
            } else {
                ("needs_attention", json!({"waitResult":detail,"outputTail":"incomplete: reader still draining after 500ms"}))
            };
            if owned.output_lost.load(Ordering::Acquire) {
                if status!="needs_attention" {status="failed";}
                detail["outputNotRetained"]=json!(true);
                detail["reason"]=json!("La salida alcanzó la cuota o no pudo guardarse. Se detuvo el runner; el último tramo no está retenido.");
            }
            if let Err(e) = runner.db.lock().unwrap().state(&id,status,detail) {
                eprintln!("persist wait: {e:#}");
                runner.quitting.store(true,Ordering::Release);
            }
            *owned.done.lock().unwrap() = true;
            owned.wake.notify_all();
        });
        Ok(session)
    }

    fn read_output(self: &Arc<Self>, id: String, child: Arc<Owned>, mut reader: Box<dyn Read + Send>) {
        let runner = self.clone();
        thread::spawn(move || {
            let mut buffer = [0u8;12*1024];
            let mut pending = Vec::with_capacity(36*1024);
            let mut last_flush = Instant::now();
            let flush = |pending: &mut Vec<u8>| -> Result<()> {
                if !pending.is_empty() {
                    runner.db.lock().unwrap().output(&id,&STANDARD.encode(&*pending))?;
                    pending.clear();
                }
                Ok(())
            };
            let mut storage_failed = false;
            loop {
                // Require an empty read after observing exit, not one before it.
                let was_exited = child.exited.load(Ordering::Acquire);
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => pending.extend_from_slice(&buffer[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if was_exited { break; }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                    Err(e) => { eprintln!("read PTY: {e}"); break; }
                }
                // Bound latency and memory while avoiding one FULL fsync for
                // every ~1 KiB kernel read during a continuous output burst.
                if pending.len() >= 24*1024 || last_flush.elapsed() >= Duration::from_millis(10) {
                    if let Err(e) = flush(&mut pending) {
                        eprintln!("persist output: {e:#}");
                        runner.quitting.store(true,Ordering::Release);
                        child.output_lost.store(true,Ordering::Release);
                        storage_failed = true;
                        break;
                    }
                    last_flush = Instant::now();
                }
            }
            if !storage_failed { if let Err(e) = flush(&mut pending) { eprintln!("persist final output: {e:#}"); child.output_lost.store(true,Ordering::Release); runner.quitting.store(true,Ordering::Release); } }
            child.reader_done.store(true,Ordering::Release);
        });
    }
}

// Uncertain custody keeps its global slot until explicit release. A finished
// worker alone does not prove that every writer it launched is gone.
fn occupied_slots(sessions:&[Value])->usize {
    sessions.iter().filter(|s|!matches!(s["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released"))).count()
}
fn ensure_workspace_available(workspace: &Path, sessions: &[Value]) -> Result<()> {
    for previous in sessions {
        if !matches!(previous["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")) {
            if let Some(existing) = previous["workspace"].as_str() {
                let existing = Path::new(existing);
                ensure!(!workspace.starts_with(existing) && !existing.starts_with(workspace),
                    "working directory already has an active or unverified session; use a separate worktree");
            }
        }
    }
    Ok(())
}

// Preserve the structured adapter's existing path contract. Native standalone
// sessions use the optional Git identity below; cwd is not a writer lock.
fn workspace_for(cwd: &Path) -> Result<PathBuf> {
    Ok(git_workspace_for(cwd)?.unwrap_or_else(||cwd.to_path_buf()))
}

fn git_workspace_for(cwd: &Path) -> Result<Option<PathBuf>> {
    // rev-parse does not execute repository hooks. Remove ambient GIT_DIR etc.
    let mut child = std::process::Command::new("/usr/bin/git")
        .args(["-C"]).arg(cwd).args(["rev-parse","--show-toplevel"])
        .env_clear().env("PATH","/usr/bin:/bin").env("LANG","C")
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped()).spawn().context("inspect selected workspace")?;
    let until = Instant::now() + Duration::from_millis(1500);
    while child.try_wait()?.is_none() {
        if Instant::now() >= until { let _=child.kill();let _=child.wait();bail!("workspace inspection timed out"); }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        // Remove only git's trailing newline; spaces are valid path characters.
        let path=std::str::from_utf8(&output.stdout)?.trim_end_matches(['\n','\r']);
        ensure!(!path.is_empty(), "empty Git worktree root");
        Ok(Some(fs::canonicalize(path)?))
    } else {
        let diagnostic=String::from_utf8_lossy(&output.stderr);
        ensure!(output.status.code()==Some(128) && diagnostic.starts_with("fatal: not a git repository"),
            "cannot determine Git workspace safely; check Git installation, repository ownership and permissions");
        Ok(None)
    }
}

fn command(kind: &str, id: &str, cwd: &Path) -> Result<CommandBuilder> {
    let home = std::env::var_os("HOME").context("HOME required for native CLI access")?;
    // Claude Code's native credential lookup needs USER even with the same HOME.
    // Resolve the current OS account without importing shell configuration or secrets.
    let identity = std::process::Command::new("/usr/bin/id").arg("-un").output()
        .context("resolve local account")?;
    ensure!(identity.status.success(), "could not resolve local account");
    let account = std::str::from_utf8(&identity.stdout)?.trim();
    ensure!(!account.is_empty() && !account.contains('\n'), "invalid local account name");
    let mut cmd = match kind {
        "fixture" => {let mut cmd=CommandBuilder::new(std::env::current_exe()?);cmd.args(["--fixture",id]);cmd},
        "shell" => {let mut cmd=CommandBuilder::new("/bin/zsh");cmd.arg("-f");cmd},
        // Normal user terminal: zsh loads the account's login and interactive config.
        "terminal" => {let mut cmd=CommandBuilder::new("/bin/zsh");cmd.arg("-il");cmd},
        "codex" => {
            let mut cmd=CommandBuilder::new("/opt/homebrew/bin/codex");
            cmd.args(["--no-daemon","--no-alt-screen","--sandbox","workspace-write","--ask-for-approval","on-request","-c","approvals_reviewer=\"user\""]);
            cmd
        },
        "claude" => {
            let mut cmd=CommandBuilder::new(PathBuf::from(&home).join(".local/bin/claude"));
            // Interactive Claude uses the account's native settings and MCP
            // discovery, including project trust/approval prompts. The empty
            // MCP override belongs only to the isolated diagnostic probe.
            cmd.args(["--permission-mode","default","--no-chrome"]);
            cmd
        },
        "codex_probe" => {
            let mut cmd=CommandBuilder::new("/opt/homebrew/bin/codex");
            cmd.args(["exec","--ignore-user-config","--ignore-rules","--skip-git-repo-check","--sandbox","read-only","--ephemeral","--json","Responde exactamente TAURI_CODEX_OK. No uses herramientas."]);
            cmd
        },
        "claude_probe" => {
            let mut cmd=CommandBuilder::new(PathBuf::from(&home).join(".local/bin/claude"));
            cmd.args(["-p","--tools","","--strict-mcp-config","--mcp-config","{\"mcpServers\":{}}","--setting-sources","","--disable-slash-commands","--no-chrome","--output-format","json","Responde exactamente TAURI_CLAUDE_OK. No uses herramientas ni escribas archivos."]);
            cmd
        },
        _ => bail!("unknown kind"),
    };
    cmd.env_clear();
    cmd.env("HOME", &home);
    cmd.env("USER", account);
    cmd.env("LOGNAME", account);
    if kind=="terminal" {
        cmd.env("SHELL","/bin/zsh");
        // Preserve desktop shell integration without importing provider credentials.
        for key in ["SSH_AUTH_SOCK","TMPDIR","__CF_USER_TEXT_ENCODING"] {
            if let Some(value)=std::env::var_os(key) { cmd.env(key,value); }
        }
    }
    let cli_bin = PathBuf::from(&home).join(".local/bin");
    let path = std::env::join_paths([cli_bin,PathBuf::from("/opt/homebrew/bin"),PathBuf::from("/usr/local/bin"),PathBuf::from("/usr/bin"),PathBuf::from("/bin")])?;
    cmd.env("PATH",path);
    cmd.env("TERM","xterm-256color");
    cmd.env("LANG","en_US.UTF-8");
    cmd.cwd(cwd);
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_inventory_uncertainty(found_survivor: bool, stopping: bool) {
        use std::{os::unix::process::CommandExt, process::{Child, Command, Stdio}};
        struct Sentinel(Child);
        impl Drop for Sentinel {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        // This disposable process is never an owned runner child. Even a PID
        // returned by inventory must not acquire signal authority.
        let mut sentinel = Sentinel(Command::new("/bin/sleep").arg("30").process_group(0)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
        let discovered = sentinel.0.id();
        let tmp = tempfile::Builder::new().prefix("aw-inv-").tempdir_in("/tmp").unwrap();
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        assert!(std::process::Command::new("/usr/bin/git").arg("init").arg(&workspace)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap().success());
        let mut runner = Runner::open(root.join("data"), root.join("sock"), root.join("token")).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        runner.inventory = Arc::new(move |sid| {
            assert_ne!(sid, discovered);
            observed.fetch_add(1, Ordering::Relaxed);
            if found_survivor { Ok(vec![discovered]) } else { bail!("injected inventory failure") }
        });
        let runner = Arc::new(runner);
        let request = |op: &str, args: Value| runner.request(json!({
            "version":1,"token":runner.token,"op":op,"args":args
        }));
        // Use only a shell in the disposable profile; no native provider starts.
        request("start", json!({"id":"inventory","title":"inventory","kind":"shell"})).unwrap();
        let child = runner.owned.lock().unwrap()["inventory"].clone();
        // Give the shell fixture a workspace just as the RPC survivor fixture does.
        runner.db.lock().unwrap().0.execute("UPDATE sessions SET workspace=? WHERE id='inventory'",
            [workspace.to_str().unwrap()]).unwrap();
        if stopping { assert!(child.stop().unwrap(), "stop did not confirm wait completion"); } else { child.input(b"exit\n").unwrap(); }
        assert!(child.wait_done(Duration::from_secs(5)), "wait did not finish");
        assert!(calls.load(Ordering::Relaxed) > 0, "wait bypassed the injected inventory");
        let session = runner.db.lock().unwrap().session("inventory").unwrap().unwrap();
        assert_eq!(session["status"], "needs_attention");
        assert!(session["detail"]["waitResult"]["exitCode"].is_number());
        if found_survivor {
            assert_eq!(session["detail"]["survivors"], json!([discovered]));
        } else {
            assert_eq!(session["detail"]["inventoryError"], "injected inventory failure");
        }
        // Verify the real start gate against the persisted result, before any
        // provider command can be constructed or spawned.
        for kind in ["codex", "claude", "terminal"] {
            let error = request("start", json!({"id":kind,"title":kind,"kind":kind,"cwd":workspace})).unwrap_err();
            assert!(error.to_string().contains("active or unverified session"), "{error:#}");
            assert!(runner.db.lock().unwrap().session(kind).unwrap().is_none());
        }
        assert!(child.lifecycle.lock().unwrap().reaped);
        runner.owned.lock().unwrap().remove("inventory");
        let error = request("stop", json!({"id":"inventory"})).unwrap_err();
        assert!(error.to_string().contains("not owned; refusing signal"));
        assert_eq!(request("release", json!({"id":"inventory","confirmed":false})).unwrap_err().to_string(), "explicit confirmation is required");
        assert_eq!(runner.db.lock().unwrap().session("inventory").unwrap().unwrap()["status"], "needs_attention");
        assert_eq!(request("release", json!({"id":"inventory","confirmed":true})).unwrap()["status"], "released");
        assert!(ensure_workspace_available(&workspace, &runner.db.lock().unwrap().sessions().unwrap()).is_ok());
        assert!(sentinel.0.try_wait().unwrap().is_none(), "discovered process was signaled");
    }

    #[test]
    fn inventory_failure_after_wait_retains_attention_and_blocks_workspace() {
        for stopping in [false, true] { check_inventory_uncertainty(false, stopping); }
    }

    #[test]
    fn discovered_inventory_pid_never_becomes_signal_authority() {
        for stopping in [false,true] {check_inventory_uncertainty(true, stopping);}
    }

    #[test]
    fn workspace_identity_and_writer_exclusion() {
        let tmp=tempfile::tempdir().unwrap();
        let repo=tmp.path().join("repo con espacios 中文");fs::create_dir(&repo).unwrap();
        assert!(std::process::Command::new("/usr/bin/git").arg("init").arg(&repo)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap().success());
        let nested=repo.join("nested");fs::create_dir(&nested).unwrap();
        let alias=tmp.path().join("alias");std::os::unix::fs::symlink(&nested,&alias).unwrap();
        let root=fs::canonicalize(&repo).unwrap();
        assert_eq!(workspace_for(&fs::canonicalize(alias).unwrap()).unwrap(),root);
        for status in ["starting","running","needs_attention","unknown_future"] {
            let sessions=vec![json!({"status":status,"workspace":root})];
            assert!(ensure_workspace_available(&root,&sessions).is_err());
            assert!(ensure_workspace_available(&root.join("nested"),&sessions).is_err());
            assert!(ensure_workspace_available(&fs::canonicalize(tmp.path()).unwrap(),&sessions).is_err());
            assert!(ensure_workspace_available(&root.parent().unwrap().join("another"),&sessions).is_ok());
        }
        assert!(ensure_workspace_available(&root,&[json!({"status":"stopped","workspace":root})]).is_ok());
        let upper=repo.with_file_name("REPO CON ESPACIOS 中文");
        if upper.exists() {assert_eq!(workspace_for(&fs::canonicalize(upper).unwrap()).unwrap(),root);}
        let broken=tmp.path().join("broken");fs::create_dir(&broken).unwrap();
        fs::write(broken.join(".git"),"invalid gitfile").unwrap();
        assert!(workspace_for(&fs::canonicalize(broken).unwrap()).is_err());
        for kind in ["claude","codex"] {
            let cmd=command(kind,"test",&nested).unwrap();
            assert_eq!(cmd.get_cwd(),Some(&nested.as_os_str().to_owned()));
            let argv=format!("{:?}",cmd.get_argv());
            assert!(!argv.contains("bypass") && !argv.contains("skip-permissions"));
        }
    }
    #[test]
    fn interactive_claude_discovers_native_mcp_but_probe_stays_isolated() -> Result<()> {
        let interactive=command("claude","mcp-config-regression",Path::new("/tmp"))?;
        let args=interactive.get_argv();
        for flag in ["--strict-mcp-config","--mcp-config","--setting-sources","--dangerously-skip-permissions"] {
            assert!(!args.iter().any(|arg|arg==flag),"interactive configuration suppressed: {flag}");
        }
        assert!(args.windows(2).any(|pair|pair[0]=="--permission-mode" && pair[1]=="default"));
        let probe=command("claude_probe","mcp-config-probe",Path::new("/tmp"))?;
        assert!(probe.get_argv().windows(2).any(|pair|pair[0]=="--mcp-config" && pair[1]=="{\"mcpServers\":{}}"));
        assert!(probe.get_argv().iter().any(|arg|arg=="--strict-mcp-config"));
        Ok(())
    }
    #[test]
    fn normal_terminal_and_diagnostic_shell_keep_distinct_fixed_commands() -> Result<()> {
        for (kind, flag) in [("terminal","-il"),("shell","-f")] {
            let cmd=command(kind,"command-test",Path::new("/tmp"))?;
            assert_eq!(cmd.get_argv(), &[std::ffi::OsString::from("/bin/zsh"),std::ffi::OsString::from(flag)]);
            assert_eq!(cmd.get_cwd(),Some(&std::ffi::OsString::from("/tmp")));
            assert_eq!(cmd.get_env("SHELL").and_then(|value|value.to_str()),if kind=="terminal" {Some("/bin/zsh")} else {None});
            for key in ["SSH_AUTH_SOCK","TMPDIR","__CF_USER_TEXT_ENCODING"] {
                let expected=if kind=="terminal" {std::env::var_os(key)} else {None};
                assert_eq!(cmd.get_env(key),expected.as_deref(),"{kind}: {key}");
            }
            for key in ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","OPENAI_API_KEY"] {
                assert!(cmd.get_env(key).is_none(),"no ambient API credentials: {kind}/{key}");
            }
        }
        Ok(())
    }
    #[test]
    fn child_environment_preserves_os_identity_without_auth_secrets() {
        let cmd = command("claude_probe", "identity-test", Path::new("/tmp")).unwrap();
        let account = cmd.get_env("USER").expect("native credential lookup requires USER");
        assert!(!account.is_empty());
        assert_eq!(cmd.get_env("LOGNAME"), Some(account));
        let os_account = std::process::Command::new("/usr/bin/id").arg("-un").output().unwrap();
        assert_eq!(account.to_str().unwrap(), std::str::from_utf8(&os_account.stdout).unwrap().trim());
        for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] {
            assert!(cmd.get_env(key).is_none(), "auth secrets must not be imported");
        }
    }
    #[test]fn uncertain_and_unknown_custody_reserve_global_capacity_until_release(){
        let mut sessions=vec![json!({"status":"needs_attention"}),json!({"status":"running"})];
        assert_eq!(occupied_slots(&sessions),2);sessions[0]["status"]=json!("released");assert_eq!(occupied_slots(&sessions),1);
        sessions[0]["status"]=json!("future_unknown");assert_eq!(occupied_slots(&sessions),2);
        for status in ["exited","stopped","failed","interrupted","released"] {assert_eq!(occupied_slots(&[json!({"status":status})]),0);}
    }
    #[test]
    fn ids_and_dimensions_are_strict() {
        for id in ["", "a_b", "../a", "a b", "中文", &"x".repeat(65)] { assert!(validate_id(id).is_err()); }
        assert!(validate_id("A-12z").is_ok());
        for args in [json!({"rows":0}),json!({"cols":1001}),json!({"rows":-1}),json!({"rows":"24"})] { assert!(dimensions(&args).is_err()); }
    }
}

#[cfg(test)]
mod standalone_native_tests {
    use super::*;

    fn fixture() -> Result<(tempfile::TempDir, Arc<Runner>, PathBuf)> {
        let tmp = tempfile::Builder::new().prefix("jauria-standalone-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700))?;
        let root = fs::canonicalize(tmp.path())?;
        let cwd = root.join("home con espacios");
        fs::create_dir(&cwd)?;
        let runner = Arc::new(Runner::open(root.join("data"), root.join("sock"), root.join("token"))?);
        // Exercise real admission and command construction, but never spawn a
        // provider. Tests distinguish this sentinel from an admission rejection.
        runner.db.lock().unwrap().0.execute_batch("CREATE TRIGGER no_provider BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture reached durable insert'); END;")?;
        Ok((tmp, runner, cwd))
    }
    fn request(r: &Arc<Runner>, id: &str, kind: &str, cwd: &Path) -> Result<Value> {
        r.request(json!({"version":1,"token":r.token,"op":"start","args":{"id":id,"title":id,"kind":kind,"cwd":cwd}}))
    }
    fn record(r: &Arc<Runner>, id: &str, cwd: &Path, workspace: Option<&Path>, status: &str) -> Result<()> {
        let mut db = r.db.lock().unwrap();
        db.0.execute_batch("DROP TRIGGER no_provider;")?;
        db.insert(&json!({"id":id,"title":id,"kind":"codex","cwd":cwd,"workspace":workspace,"status":status,"rows":24,"cols":80}))?;
        db.0.execute_batch("CREATE TRIGGER no_provider BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture reached durable insert'); END;")?;
        Ok(())
    }
    fn admitted(error: anyhow::Error) {
        assert!(error.to_string().contains("fixture reached durable insert"), "{error:#}");
    }
    fn init_git(path: &Path) -> Result<()> {
        let output = std::process::Command::new("/usr/bin/git").env_clear().env("PATH","/usr/bin:/bin")
            .args(["-c","init.templateDir=","init"]).arg(path).output()?;
        ensure!(output.status.success(), "fixture git init failed");
        Ok(())
    }

    #[test]
    fn non_git_native_sessions_share_cwd_but_uncertain_sessions_keep_global_slots() -> Result<()> {
        let (_tmp, r, cwd) = fixture()?;
        assert_eq!(git_workspace_for(&cwd)?, None);
        assert_eq!(workspace_for(&cwd)?, cwd); // structured caller contract unchanged
        r.db.lock().unwrap().0.execute_batch("CREATE TRIGGER require_null_workspace BEFORE INSERT ON sessions WHEN NEW.workspace IS NOT NULL BEGIN SELECT RAISE(ABORT,'non-Git workspace must be null'); END;")?;
        for kind in ["codex", "claude", "terminal"] { admitted(request(&r,"first",kind,&cwd).unwrap_err()); }
        record(&r,"first",&cwd,None,"running")?;
        for kind in ["codex", "claude", "terminal"] { admitted(request(&r,"second",kind,&cwd).unwrap_err()); }
        record(&r,"second",&cwd,None,"needs_attention")?;
        for kind in ["codex", "claude", "terminal"] {
            assert!(request(&r,"third",kind,&cwd).unwrap_err().to_string().contains("El límite es 2"));
        }
        let sessions = r.db.lock().unwrap().sessions()?;
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|s|s["workspace"].is_null() && s["cwd"] == json!(cwd)));
        assert_eq!(occupied_slots(&sessions), 2);
        r.db.lock().unwrap().state("second","released",json!({}))?;
        admitted(request(&r,"third","codex",&cwd).unwrap_err());
        assert!(r.owned.lock().unwrap().is_empty());
        assert!(r.codex_jobs.lock().unwrap().is_empty());
        let status = r.request(json!({"version":1,"token":r.token,"op":"status","args":{}}))?;
        assert_eq!(status["terminalSessionVersion"], 1);
        assert_eq!(status["normalTerminalVersion"], 1);
        assert_eq!(status["claudeNativeConfigVersion"], 1);
        Ok(())
    }

    #[test]
    fn git_native_admission_rejects_same_worktree_subfolders_and_aliases_only() -> Result<()> {
        let (_tmp, r, home) = fixture()?;
        let repo = home.join("repo"); init_git(&repo)?;
        let nested = repo.join("nested"); fs::create_dir(&nested)?;
        let alias = home.join("alias"); std::os::unix::fs::symlink(&nested,&alias)?;
        let prefix = home.join("repo-extra"); init_git(&prefix)?;
        let root = fs::canonicalize(&repo)?;
        record(&r,"writer",&nested,Some(&root),"needs_attention")?;
        for cwd in [&repo,&nested,&alias] {
            assert_eq!(git_workspace_for(&fs::canonicalize(cwd)?)?, Some(root.clone()));
            for kind in ["codex","claude","terminal"] {
                assert!(request(&r,"blocked",kind,cwd).unwrap_err().to_string().contains("active or unverified session"));
            }
        }
        admitted(request(&r,"prefix","codex",&prefix).unwrap_err());
        // A non-Git home session does not claim all repositories beneath home.
        admitted(request(&r,"home","codex",&home).unwrap_err());
        assert!(r.db.lock().unwrap().session("blocked")?.is_none());
        assert!(r.owned.lock().unwrap().is_empty());
        Ok(())
    }

    #[test]
    fn malformed_git_and_managed_directories_never_become_standalone() -> Result<()> {
        let (_tmp, r, cwd) = fixture()?;
        let broken = cwd.join("broken"); fs::create_dir(&broken)?;
        fs::write(broken.join(".git"),"invalid gitfile")?;
        assert!(git_workspace_for(&broken).is_err());
        let managed = r.data_dir.join("worktrees"); fs::create_dir(&managed)?;
        for kind in ["codex", "claude", "terminal"] {
            assert!(request(&r,"broken",kind,&broken).unwrap_err().to_string().contains("cannot determine Git workspace safely"));
            assert!(request(&r,"managed",kind,&managed).unwrap_err().to_string().contains("desde su tarea"));
        }
        for cwd in [Value::Null, json!("relative"), json!(42)] {
            let error = r.request(json!({"version":1,"token":r.token,"op":"start","args":{"id":"invalid","title":"invalid","kind":"codex","cwd":cwd}})).unwrap_err();
            assert!(!error.to_string().contains("fixture reached durable insert"));
        }
        assert!(r.db.lock().unwrap().sessions()?.is_empty());
        Ok(())
    }

    #[test]
    fn non_git_standalone_keeps_verification_fences_for_ancestor_cwd() -> Result<()> {
        let (_tmp, r, home) = fixture()?;
        let repo = home.join("repo"); init_git(&repo)?;
        {
            let db = r.db.lock().unwrap();
            db.0.execute("INSERT INTO projects VALUES('p',?,?,'fixture','base',NULL)",
                rusqlite::params![repo.to_str(),repo.join(".git").to_str()])?;
            db.0.execute("INSERT INTO tasks VALUES('t','p','T','O','','base','b',?,'ready',NULL)", [repo.to_str()])?;
            db.0.execute("INSERT INTO verification_runs VALUES('v','t','req','hash','needs_attention',0,?)",
                [json!({"cwd":repo}).to_string()])?;
        }
        for kind in ["codex","claude","terminal"] {
            assert!(request(&r,"fenced",kind,&home).unwrap_err().to_string().contains("fenced by verification"));
            assert!(request(&r,"fenced",kind,&repo).unwrap_err().to_string().contains("fenced by verification"));
        }
        let sibling = home.parent().unwrap().join("home-extra"); fs::create_dir(&sibling)?;
        admitted(request(&r,"sibling","codex",&sibling).unwrap_err());
        assert!(r.db.lock().unwrap().sessions()?.is_empty());
        Ok(())
    }
}

#[cfg(test)]
mod workspace_queue_tests {
    use super::*;
    #[test]
    fn git_workspace_gate_rejects_new_intents_without_blocking_pty_stop_or_input() -> Result<()> {
        let tmp=tempfile::Builder::new().prefix("aw-gate-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let runner=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        let request=|op:&str,args:Value|runner.request(json!({"version":1,"token":runner.token,"op":op,"args":args}));
        request("start",json!({"id":"live","title":"live","kind":"shell","rows":24,"cols":80}))?;
        let observed = |marker:&str| -> Result<bool> {
            let events = runner.db.lock().unwrap().events(0,256)?;
            for event in events["events"].as_array().unwrap() {
                if event["kind"] == "output" {
                    let bytes=STANDARD.decode(event["data"].as_str().unwrap())?;
                    if String::from_utf8_lossy(&bytes).contains(marker) { return Ok(true); }
                }
            }
            Ok(false)
        };
        request("input",json!({"id":"live","data":"printf 'READY_%s\n' SHELL
"}))?;
        let until=Instant::now()+Duration::from_secs(3);
        while !observed("READY_SHELL")? && Instant::now()<until { thread::sleep(Duration::from_millis(10)); }
        assert!(observed("READY_SHELL")?,"real shell did not report readiness");
        let gate=runner.workspace_mutations.lock().unwrap();
        let started=Instant::now();
        assert!(request("create_task",json!({"id":"task-busy","projectId":"p","title":"t","objective":"o","acceptanceCriteria":""})).unwrap_err().to_string().contains("en curso"));
        request("input",json!({"id":"live","data":"printf 'PTY_%s\n' GATE_OK
"}))?;
        let until=Instant::now()+Duration::from_secs(2);
        while !observed("PTY_GATE_OK")? && Instant::now()<until { thread::sleep(Duration::from_millis(10)); }
        assert!(observed("PTY_GATE_OK")?,"held Git gate blocked the live PTY");
        assert!(started.elapsed()<Duration::from_secs(2));
        assert_eq!(runner.db.lock().unwrap().session("live")?.unwrap()["status"],"running");
        request("interrupt",json!({"id":"live"}))?;
        request("stop",json!({"id":"live"}))?;
        drop(gate);
        assert!(crate::projects::tasks(&runner.db.lock().unwrap().0)?.is_empty(),"busy request acquired a late effect");
        Ok(())
    }
}

#[cfg(test)]
mod verification_registration_tests {
    use super::*;
    fn fixture() -> Result<(tempfile::TempDir,Arc<Runner>,Value,Value,PathBuf)> {
        let tmp=tempfile::Builder::new().prefix("jauria-cancel-gap-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;let repo=root.join("repo");fs::create_dir(&repo)?;
        let git=|args:&[&str]|->Result<()> {
            let output=std::process::Command::new("/usr/bin/git").env_clear().env("HOME",&root).env("PATH","/usr/bin:/bin")
                .args(["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-c","user.name=Fixture","-c","user.email=fixture@local.invalid","-C"]).arg(&repo).args(args).output()?;
            ensure!(output.status.success(),"Git fixture failed");Ok(())
        };
        git(&["init","-b","main"])?;fs::write(repo.join("base"),"base\n")?;git(&["add","base"])?;git(&["commit","-m","base"])?;
        let runner=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        let request=|op:&str,args:Value|runner.request(json!({"version":1,"token":runner.token,"op":op,"args":args}));
        request("register_project",json!({"id":"p","path":repo}))?;
        request("create_task",json!({"id":"t","projectId":"p","title":"T","objective":"O","acceptanceCriteria":""}))?;
        let task=request("prepare_task",json!({"id":"t"}))?;
        request("snapshot_task",json!({"id":"t","artifactId":"s"}))?;
        let run=request("prepare_verification",json!({"id":"t","requestId":"r","snapshotId":"s","argv":["/usr/bin/touch","must-not-exist"]}))?;
        let args=json!({"id":"t","runId":run["runId"],"approvalNonce":run["approvalNonce"]});
        let begun=crate::verification::begin(&runner.db,&args)?;assert_eq!(begun["shouldExecute"],true);
        Ok((tmp,runner,args,begun,PathBuf::from(task["worktreePath"].as_str().unwrap())))
    }
    #[test]
    fn cancellation_in_durable_begin_registration_gap_never_launches() -> Result<()> {
        let (_tmp,runner,args,begun,cwd)=fixture()?;
        let result=runner.request(json!({"version":1,"token":runner.token,"op":"cancel_verification","args":{"id":"t","runId":args["runId"]}}))?;
        assert_eq!(result["status"],"cancel_requested");
        runner.register_begun_verification(&args,begun)?;
        let job=runner.verification_jobs.lock().unwrap().remove(args["runId"].as_str().unwrap()).unwrap();
        job.worker.join().unwrap();
        let run=crate::verification::get(&runner.db.lock().unwrap().0,"t",args["runId"].as_str().unwrap())?;
        assert_eq!(run["process"]["spawned"],false);assert_eq!(run["outcome"],"cancelled");assert_eq!(run["verification"],"not_verified");assert!(!cwd.join("must-not-exist").exists());
        Ok(())
    }
    #[test]
    fn quitting_before_registration_never_launches() -> Result<()> {
        let (_tmp,runner,args,begun,cwd)=fixture()?;runner.quitting.store(true,Ordering::Release);
        let run=runner.register_begun_verification(&args,begun)?;
        assert_eq!(run["process"]["spawned"],false);assert_eq!(run["verification"],"not_verified");
        assert!(runner.verification_jobs.lock().unwrap().is_empty());assert!(!cwd.join("must-not-exist").exists());Ok(())
    }
    #[test]
    fn poisoned_admission_gate_cleanup_stops_owned_pty_and_does_not_launch_verification() -> Result<()> {
        let (_tmp,runner,args,_begun,cwd)=fixture()?;
        runner.request(json!({"version":1,"token":runner.token,"op":"start","args":{"id":"cleanup-shell","title":"fixture","kind":"shell","rows":24,"cols":80}}))?;
        let owned=runner.owned.lock().unwrap()["cleanup-shell"].clone();
        let poison=runner.clone();assert!(thread::spawn(move||{let _guard=poison.mutations.lock().unwrap();panic!("owned gate poison fixture");}).join().is_err());
        runner.cleanup_owned();assert!(owned.wait_done(Duration::from_secs(5)));assert!(owned.lifecycle.lock().unwrap().reaped);
        let run=crate::verification::get(&runner.db.lock().unwrap().0,"t",args["runId"].as_str().unwrap())?;
        assert_eq!(run["status"],"running");assert!(!cwd.join("must-not-exist").exists());Ok(())
    }
    #[test]
    fn client_permit_releases_capacity_on_panic() {
        let clients=Arc::new(AtomicUsize::new(1));let counter=clients.clone();
        assert!(thread::spawn(move||{let _permit=ClientPermit(counter);panic!("owned client permit fixture");}).join().is_err());
        assert_eq!(clients.load(Ordering::Acquire),0);
    }
    #[test]
    fn malformed_post_begin_parameters_finish_without_owner_or_fence() -> Result<()> {
        let (_tmp,runner,args,mut begun,cwd)=fixture()?;begun["argv"]=json!(false);
        let result=runner.register_begun_verification(&args,begun)?;
        assert_eq!(result["process"]["spawned"],false);assert_eq!(result["outcome"],"cancelled");
        assert!(runner.verification_jobs.lock().unwrap().is_empty());
        crate::verification::ensure_available(&runner.db.lock().unwrap().0,"t")?;
        assert!(!cwd.join("must-not-exist").exists());Ok(())
    }
}

#[path="runner_codex.rs"] mod codex;

#[cfg(test)]
mod handoff_admission_tests {
    use super::*;
    fn fixture() -> Result<(tempfile::TempDir,Arc<Runner>)> {
        let tmp=tempfile::tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let r=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        {
            let db=r.db.lock().unwrap();
            db.0.execute("INSERT INTO projects VALUES('p','/r','/r/.git','r','base',NULL)",[])?;
            db.0.execute("INSERT INTO tasks VALUES('t','p','Title','Objective','','base','b','/w','draft',NULL)",[])?;
        }
        Ok((tmp,r))
    }
    fn request(r:&Arc<Runner>,op:&str,args:Value)->Result<Value>{
        r.request(json!({"version":1,"token":r.token,"op":op,"args":args}))
    }
    fn starts()->Vec<(&'static str,Value)>{vec![
        ("start",json!({"id":"reserved","title":"Title","kind":"shell","rows":24,"cols":80})),
        ("start_task",json!({"id":"t","sessionId":"reserved","kind":"shell","rows":24,"cols":80})),
        ("start_codex",json!({"id":"reserved","title":"Title","kind":"codex","cwd":"/missing","rows":24,"cols":80})),
        ("start_codex_task",json!({"id":"t","sessionId":"reserved","kind":"codex","rows":24,"cols":80})),
    ]}
    #[test]
    fn every_generic_creator_rejects_handoff_reservations_and_rpc_bypass() -> Result<()> {
        let (_tmp,r)=fixture()?;
        for phase in ["prepared","uncertain","failed","opened","purged"] {
            let db=r.db.lock().unwrap();
            db.0.execute("DELETE FROM task_artifacts",[])?;
            let payload=if phase=="purged"{json!({"originalKind":"handoff_open","sessionId":"reserved"})}
                else{json!({"phase":phase,"sessionId":"reserved","request":{"sessionId":"reserved"}})};
            db.0.execute("INSERT INTO task_artifacts VALUES('effect','t',?,?)",rusqlite::params![if phase=="purged"{"purged"}else{"handoff_open"},payload.to_string()])?;
            drop(db);
            for (op,args) in starts(){
                let error=request(&r,op,args.clone()).unwrap_err().to_string();
                assert!(error.contains("reserved"),"{phase}/{op}: {error}");
                for key in ["requestId","claimed","handoffGrant"] {
                    let mut forged=args.clone();forged[key]=json!("effect");
                    assert!(request(&r,op,forged).unwrap_err().to_string().contains("unexpected argument"));
                }
            }
            assert!(r.db.lock().unwrap().sessions()?.is_empty());
            assert!(r.owned.lock().unwrap().is_empty());assert!(r.codex_jobs.lock().unwrap().is_empty());
        }
        Ok(())
    }
    #[test]
    fn every_start_admission_is_serialized_by_workspace_gate() -> Result<()> {
        let (_tmp,r)=fixture()?;let _gate=r.workspace_mutations.lock().unwrap();
        let mut calls=starts();calls.push(("open_handoff",json!({"id":"t","artifactId":"h","requestId":"e","sessionId":"reserved","rows":24,"cols":80})));
        calls.push(("codex_resume",json!({"id":"reserved","generation":1})));
        for (op,args) in calls {
            assert!(request(&r,op,args).unwrap_err().to_string().contains("en curso"),"{op}");
        }
        assert!(r.db.lock().unwrap().sessions()?.is_empty());Ok(())
    }
    #[test]
    fn existing_exact_session_retries_do_not_spawn_or_consume_reservation() -> Result<()> {
        let (_tmp,r)=fixture()?;
        {
            let mut db=r.db.lock().unwrap();
            db.insert(&json!({"id":"reserved","title":"Title","kind":"shell","status":"stopped","rows":24,"cols":80,"taskId":"t"}))?;
            db.0.execute("INSERT INTO task_artifacts VALUES('effect','t','purged',?)",[json!({"originalKind":"handoff_open","sessionId":"reserved"}).to_string()])?;
        }
        let generic=json!({"id":"reserved","title":"Title","kind":"shell","taskId":"t"});
        // Internal exact retry and public task retry preserve existing semantics.
        assert_eq!(r.start("reserved",&generic)?["status"],"stopped");
        assert_eq!(request(&r,"start_task",json!({"id":"t","sessionId":"reserved","kind":"shell","rows":24,"cols":80}))?["status"],"stopped");
        let mut conflict=generic;conflict["title"]=json!("Changed");assert!(r.start("reserved",&conflict).is_err());
        assert!(r.owned.lock().unwrap().is_empty());assert!(r.codex_jobs.lock().unwrap().is_empty());Ok(())
    }
    #[test]
    fn durable_insert_failure_prevents_pty_and_codex_worker_start() -> Result<()> {
        let (tmp,r)=fixture()?;
        r.db.lock().unwrap().0.execute_batch("CREATE TRIGGER reject_fixture_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture admission failed'); END;")?;
        assert!(request(&r,"start",json!({"id":"pty","title":"Title","kind":"shell","rows":24,"cols":80})).unwrap_err().to_string().contains("fixture admission failed"));
        assert!(request(&r,"start_codex",json!({"id":"codex","title":"Title","kind":"codex","cwd":fs::canonicalize(tmp.path())?,"rows":24,"cols":80})).unwrap_err().to_string().contains("fixture admission failed"));
        assert!(r.db.lock().unwrap().sessions()?.is_empty());assert_eq!(r.db.lock().unwrap().last_seq()?,0);
        assert!(r.owned.lock().unwrap().is_empty());assert!(r.codex_jobs.lock().unwrap().is_empty());Ok(())
    }
    #[test]
    fn post_spawn_activation_error_keeps_durable_parent_row() -> Result<()> {
        let (_tmp,r)=fixture()?;
        r.db.lock().unwrap().0.execute_batch("CREATE TRIGGER reject_fixture_activation BEFORE UPDATE OF status ON sessions WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'fixture activation failed'); END;")?;
        let error=request(&r,"start",json!({"id":"pty","title":"Title","kind":"shell","rows":24,"cols":80})).unwrap_err();
        assert!(error.to_string().contains("fixture activation failed"));
        let row=r.db.lock().unwrap().session("pty")?.context("Durable pre-spawn row was lost")?;
        assert_eq!(row["status"],"failed");assert!(r.owned.lock().unwrap().is_empty());
        assert_eq!(request(&r,"start",json!({"id":"pty","title":"Title","kind":"shell","rows":24,"cols":80}))?,row);
        Ok(())
    }
}

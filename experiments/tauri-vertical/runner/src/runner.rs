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
    publication: Mutex<()>,
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
    codex_jobs:Mutex<HashMap<String,CodexJob>>,
    resources: Mutex<crate::resources::ResourcesSampler>,
    terminal_streams: Arc<crate::terminal_stream::TerminalStreams>,
    status_cache: Mutex<Value>,
    settings: crate::app_settings::AppSettings,
    pulso: Option<Arc<crate::pulso::Service>>,
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
        // Read preferences only after obtaining exclusive profile custody.
        let settings = crate::app_settings::AppSettings::open(&data_dir)?;
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
                let mut detail=json!({"reason":"previous generation; no owned handle; never restarted", "identity":"unverified"});
                if !session["detail"]["terminalStream"].is_null() {
                    detail["terminalStream"]=session["detail"]["terminalStream"].clone();
                    detail["terminalStream"]["history"]["state"]=json!("unknown_tail");
                }
                db.state(session["id"].as_str().unwrap(), status, detail)?;
            }
        }
        let mut random = [0u8;16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let generation = STANDARD.encode(random);
        let terminal_streams = crate::terminal_stream::TerminalStreams::new(&data_dir.join("runner.sqlite"), generation.clone())?;
        let db = Arc::new(Mutex::new(db));
        let pulso_db = db.clone();
        let pulso_streams = terminal_streams.clone();
        let lookup: crate::pulso::SessionLookup = Arc::new(move |id| {
            pulso_streams.session(id).or_else(|| pulso_db.try_lock().ok().and_then(|db| db.session(id).ok().flatten()))
        });
        let pulso = match crate::pulso::Service::start(&data_dir, socket.parent().context("socket parent")?, lookup) {
            Ok(service) => { service.set_auto_enabled(settings.pulso_auto_access()); Some(service) },
            Err(_) => { eprintln!("Pulso no disponible; las terminales siguen operativas. Conserva sus datos y revisa el módulo."); None },
        };
        Ok(Self {data_dir, socket, token, generation, terminal_streams, settings, pulso, status_cache:Mutex::new(Value::Null), _lock:lock, db, owned:Mutex::new(HashMap::new()), mutations:Arc::new(Mutex::new(())), workspace_mutations:Mutex::new(()), quitting:AtomicBool::new(false), quota_cache:Mutex::new(json!({"codex":{"available":false,"error":"Pulsa actualizar para consultar"},"claude":{"available":false,"error":"Sin consultar"}})), quota_refreshing:AtomicBool::new(false), quota_task:Mutex::new(None),codex_jobs:Mutex::new(HashMap::new()), resources:Mutex::new(crate::resources::ResourcesSampler::default()),
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
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // Wake on connection readiness, rather than adding a fixed
                    // 10 ms delay to each sequential RPC. The bounded wait also
                    // observes shutdown/SIGTERM while the socket is idle.
                    let mut ready=libc::pollfd {fd:listener.as_raw_fd(),events:libc::POLLIN,revents:0};
                    let result=unsafe {libc::poll(&mut ready,1,50)};
                    if result<0 {
                        let error=std::io::Error::last_os_error();
                        if error.kind()==std::io::ErrorKind::Interrupted {continue;}
                        accept_error=Some(error);break;
                    }
                    if ready.revents & (libc::POLLERR|libc::POLLHUP|libc::POLLNVAL)!=0 {
                        accept_error=Some(std::io::Error::other(format!("listener readiness failed: {}",ready.revents)));
                        break;
                    }
                }
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
        if let Some(pulso)=&self.pulso { pulso.shutdown(); }
        let codex_jobs=std::mem::take(&mut *self.codex_jobs.lock().unwrap());
        for job in codex_jobs.values(){job.control.stop.store(true,Ordering::Release);}
        let children: Vec<_> = self.owned.lock().unwrap().values().cloned().collect();
        // Cleanup owned children only; never consult persisted PIDs.
        for child in children { if let Err(e) = child.stop() { eprintln!("cleanup: {e:#}"); } }
        self.terminal_streams.shutdown();
        // Release both gates before joining; quitting already fences every new writer.
        drop(_guard);drop(_workspace);
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
            // workspaceAfter is still accepted, and ignored, so a 1.3.x app can
            // connect while this runner keeps serving its sessions.
            "status" => &["workspaceAfter"],
            "get_settings" => &[],
            "set_settings" => &["maxConcurrentSessions","pulsoAutoAccess"],
            "rename_session" => &["id","title"],
            "native_binding" => &["id"],
            "resume_native" => &["id","sourceId","rows","cols"],
            "shutdown" | "diagnostic_preview" | "telemetry" | "refresh_quotas" => &[],
            "start_codex" => &["id","title","kind","cwd","rows","cols"],
            "codex_state" => &["id"],"codex_request" => &["id","requestId"],
            "codex_resume" => &["id","generation"],
            "codex_turn" | "codex_command" => &["id","commandId","turnId","attemptId","generation","prompt"],
            "codex_interrupt" => &["id","turnId","attemptId","generation"],
            "codex_permission" => &["id","requestId","generation","decision","nativeConfirmed"],
            "start" => &["id","title","kind","rows","cols","cwd"],
            "input" => &["id","data"], "resize" => &["id","rows","cols"],
            "stop" => &["id","generation"], "interrupt" => &["id"], "purge_history" | "compact_history" => &["id","confirmed"], "release" => &["id","confirmed","generation"], "events" => &["after","limit"],
            "terminal_live" => &["id","after","limit"],
            _ => bail!("unknown operation"),
        };
        ensure!(args.keys().all(|k| allowed.contains(&k.as_str())), "unexpected argument");
        let args = &request["args"];
        if op == "get_settings" { return Ok(self.settings.snapshot()); }
        if op == "set_settings" {
            let limit=args.get("maxConcurrentSessions").map(|value|value.as_u64().filter(|n|(1..=8).contains(n))
                .context("maxConcurrentSessions must be an integer from 1 to 8")).transpose()?;
            let auto=args.get("pulsoAutoAccess").map(|value|value.as_bool().context("pulsoAutoAccess must be a boolean")).transpose()?;
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            let result=self.settings.update(limit.map(|n|n as usize),auto)?;
            if let (Some(pulso),Some(enabled))=(&self.pulso,auto) {pulso.set_auto_enabled(enabled);}
            return Ok(result);
        }
        if op == "native_binding" {
            let id=args["id"].as_str().context("Falta sesión")?; validate_id(id)?;
            let binding=crate::native_sessions::load(&self.data_dir,id)?;
            let mut active=None;
            if let Some(binding)=&binding {
                for session in self.terminal_streams.sessions() {
                    if session["kind"]!=binding.provider || !matches!(session["status"].as_str(),Some("running"|"starting")) {continue;}
                    if let Some(key)=session["id"].as_str() {
                        if crate::native_sessions::load(&self.data_dir,key)?.is_some_and(|other|other.provider==binding.provider && other.conversation_id.eq_ignore_ascii_case(&binding.conversation_id)) {active=Some(key.to_owned());break;}
                    }
                }
            }
            return Ok(json!({"binding":binding.map(|b|json!({"provider":b.provider,"conversationId":b.conversation_id,"source":b.source,"resumedFrom":b.resumed_from})),"activeSessionId":active}));
        }
        if op == "terminal_live" {
            let id=args["id"].as_str().context("id required")?;validate_id(id)?;
            let after=args["after"].as_u64().context("invalid terminal cursor")?;
            let limit=args.get("limit").map(|v|v.as_u64().context("invalid terminal limit")).transpose()?.unwrap_or(64);
            ensure!((1..=64).contains(&limit),"invalid terminal limit");
            if self.terminal_streams.session(id).is_none() {
                return Ok(json!({"archivedOnly":true,"sessionId":id,"generation":self.generation}));
            }
            return match self.terminal_streams.live(id,after,limit as usize) {
                Ok(page)=>Ok(page),
                Err(_) if self.terminal_streams.session(id).is_none()=>Ok(json!({"archivedOnly":true,"sessionId":id,"generation":self.generation})),
                Err(error)=>Err(error),
            };
        }
        if op == "stop" {
            if let (Some(pulso), Some(id)) = (&self.pulso, args["id"].as_str()) { validate_id(id)?; let _ = pulso.revoke_session(id); }
        }
        // An owned handle is the authority for native controls. Neither a busy
        // archive writer nor an unreadable database may disable stop or input.
        if matches!(op,"input"|"resize"|"interrupt"|"stop") {
            let id=args["id"].as_str().context("id required")?;validate_id(id)?;
            let owned=self.owned.lock().unwrap().get(id).cloned();
            if let Some(child)=owned {
                ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
                return self.native_control(op,id,args,&child);
            }
        }
        if matches!(op,"start"|"start_codex"|"codex_resume") {
            self.sync_native_lifecycle()?;
        }
        if matches!(op,"start_codex"|"codex_state"|"codex_request"|"codex_resume"|"codex_turn"|"codex_command"|"codex_interrupt"|"codex_permission") {return self.codex_request(op,args);}
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
            self.db.try_lock().ok().and_then(|db| {
                let value=(|| -> Result<Value> {
                Ok(json!({"pid":std::process::id(),"generation":self.generation,"sessions":db.sessions()?,"lastSeq":db.last_seq()?,"statusVersion":2,"pulsoVersion":1,"pulsoBoardVersion":1,"pulsoAvailable":self.pulso.as_ref().is_some_and(|p|p.available()),"nativeResumeVersion":1,"terminalSessionVersion":1,"normalTerminalVersion":1,"claudeNativeConfigVersion":1,"terminalStreamVersion":1,"nativePermissionsVersion":1,"runnerVersion":env!("CARGO_PKG_VERSION"),"telemetryVersion":1,"codexVersion":1,"retention":db.retention()?}))
                })().ok()?;
                // Publish while holding DB -> cache, the same order as rename.
                // A pre-rename snapshot cannot overwrite the renamed fallback.
                *self.status_cache.lock().unwrap()=value;
                Some(())
            });
            let mut result=self.status_cache.lock().unwrap().clone();
            ensure!(!result.is_null(),"Storage status unavailable; terminal_live and owned controls remain available");
            // Settings remain current even when SQLite uses the cached fallback.
            result["pulsoAvailable"]=json!(self.pulso.as_ref().is_some_and(|p|p.available()));
            result["settings"]=self.settings.snapshot();
            result["settingsVersion"]=json!(2);
            result["sessionRenameVersion"]=json!(1);
            // New capabilities get new fields: 1.3.x clients compare the existing
            // *Version values with === 1, so none of them may ever be raised.
            result["pulsoSummaryVersion"]=json!(1);
            // In-memory counter published after each Pulso COMMIT; no SQLite here,
            // so it stays current even when the session store uses the cache.
            if let Some(pulso)=self.pulso.as_ref().filter(|p|p.available()) {
                result["pulsoRevision"]=json!(pulso.revision());
                result["pulsoRevisionVersion"]=json!(1);
            }
            let sessions=result["sessions"].as_array_mut().context("Invalid session cache")?;
            for live in self.terminal_streams.sessions() {
                if let Some(row)=sessions.iter_mut().find(|row|row["id"]==live["id"]) {*row=live;} else {sessions.push(live);}
            }
            return Ok(result);
        }
        if op == "events" {
            let after = args.get("after").map(|v| v.as_i64().context("invalid cursor")).transpose()?.unwrap_or(0);
            let limit = args.get("limit").map(|v| v.as_u64().context("invalid limit")).transpose()?.unwrap_or(128);
            return self.db.lock().unwrap().events(after, limit.min(256) as usize);
        }
        if op=="resume_native" {
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Hay otra apertura de sesión en curso; consulta su estado antes de reintentar"))?;
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            let id=args["id"].as_str().context("Falta nueva sesión")?;validate_id(id)?;
            let source=args["sourceId"].as_str().context("Falta sesión de origen")?;validate_id(source)?;
            ensure!(id!=source,"Usa una sesión nueva para la reanudación");
            if let Some(existing)=self.db.lock().unwrap().session(id)? {
                let binding=crate::native_sessions::load(&self.data_dir,id)?.context("El ID pertenece a otra sesión")?;
                ensure!(existing["kind"]=="claude" && existing["transport"]!="app-server" && binding.provider=="claude" && binding.resumed_from.as_deref()==Some(source),"El ID pertenece a otra reanudación");
                return Ok(self.terminal_streams.session(id).unwrap_or(existing));
            }
            let old=self.db.lock().unwrap().session(source)?.context("Sesión de origen desconocida")?;
            ensure!(old["kind"]=="claude" && old["transport"]!="app-server","Solo se reanudan conversaciones nativas con identidad registrada");
            ensure!(old["pid"].as_u64().is_some(),"La conversación no llegó a iniciarse; usa un punto de continuidad");
            crate::native_sessions::load(&self.data_dir,source)?.context("No se registró la identidad nativa; usa el historial o un punto de continuidad")?;
            return self.start(id,&json!({"id":id,"kind":old["kind"],"title":old["title"],"cwd":old["cwd"],"rows":args["rows"],"cols":args["cols"],"resumeFrom":source}));
        }
        if op=="start" {
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Hay otra apertura de sesión en curso; consulta su estado antes de reintentar"))?;
            let _guard=self.mutations.lock().unwrap();
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            let id=args["id"].as_str().context("id required")?;validate_id(id)?;
            return self.start(id,args);
        }
        let _guard = self.mutations.lock().unwrap();
        ensure!(!self.quitting.load(Ordering::Acquire), "runner is shutting down");
        if op == "shutdown" {
            self.quitting.store(true, Ordering::Release);
            return Ok(json!({"shuttingDown":true}));
        }
        let id = args["id"].as_str().context("id required")?;
        validate_id(id)?;
        if op == "rename_session" {
            let title=args["title"].as_str().context("title must be a string")?;
            ensure!(!title.chars().any(char::is_control),"Session title must not contain control characters");
            let title=title.trim();
            ensure!(!title.is_empty() && title.chars().count()<=120 && title.len()<=480,
                "Session title must contain 1 to 120 Unicode characters and at most 480 bytes");
            let mut db=self.db.lock().unwrap();
            if let Some(row)=self.terminal_streams.session(id) { db.native_checkpoint(&row)?; }
            let saved=db.rename_session(id,title)?;
            // Merge into the current cache: finish/output may have advanced it
            // since the observed checkpoint. Never restore a stale full row.
            let result=self.terminal_streams.rename(id,title)?.unwrap_or(saved);
            let mut cache=self.status_cache.lock().unwrap();
            if let Some(rows)=cache["sessions"].as_array_mut() {
                if let Some(row)=rows.iter_mut().find(|row|row["id"]==id) {row["title"]=json!(title);}
            }
            return Ok(result);
        }
        if matches!(op,"purge_history"|"compact_history") {
            ensure!(args["confirmed"]==true,"Confirma la eliminación del historial.");
            self.terminal_streams.ensure_purgeable(id)?;
            let result=(|| -> Result<(Value,bool)> {
                let mut db=self.db.lock().unwrap();
                if let Some(row)=self.terminal_streams.session(id) {db.native_checkpoint(&row)?;}
                let result=if op=="compact_history" {db.compact_final_history(&[id.to_owned()])?}else{db.purge_history(&[id.to_owned()])?};
                Ok((result,db.ensure_capacity().is_ok()))
            })();
            match result {
                Ok((value,available))=>{
                    self.terminal_streams.purged(id);
                    if available {self.terminal_streams.retention_changed();}
                    return Ok(value);
                }
                Err(error)=>{self.terminal_streams.cancel_purge(id);return Err(error);}
            }
        }
        let stored = match self.terminal_streams.session(id) {
            Some(row)=>row,
            None=>self.db.lock().unwrap().session(id)?.context("unknown session")?,
        };
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
            if self.terminal_streams.session(id).is_some() {
                self.terminal_streams.release(id);
                let row=self.terminal_streams.session(id).context("session missing")?;
                self.db.lock().unwrap().native_checkpoint(&row)?;
                return Ok(row);
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

    // Callers hold workspace_mutations then mutations through durable insert/spawn.
    fn start(self: &Arc<Self>, id: &str, args: &Value) -> Result<Value> {
        if let Some(existing) = self.db.lock().unwrap().session(id)? {
            ensure!(existing["kind"] == args["kind"] && existing["title"] == args["title"] && (args["cwd"].is_null() || existing["cwd"] == args["cwd"]), "El ID de sesión ya tiene otro contenido");
            if let Some(source)=args["resumeFrom"].as_str() {
                let binding=crate::native_sessions::load(&self.data_dir,id)?.context("El ID ya pertenece a otra sesión")?;
                ensure!(binding.resumed_from.as_deref()==Some(source),"El ID ya pertenece a otra reanudación");
            }
            return Ok(self.terminal_streams.session(id).unwrap_or(existing));
        }
        {let db=self.db.lock().unwrap();db.ensure_native_capacity()?;ensure!(occupied_slots(&db.sessions_with_live(&self.terminal_streams.sessions())?)<self.settings.limit(),"El límite es {}; las sesiones inciertas conservan su plaza hasta liberarlas",self.settings.limit());}
        let size = dimensions(args)?;
        let title = args["title"].as_str().context("title required")?;
        ensure!(title.len() <= 512, "title too long");
        let kind = args["kind"].as_str().context("kind required")?;
        ensure!(["fixture","shell","terminal","claude_probe","codex_probe","claude","codex"].contains(&kind), "unknown kind");
        let interactive = matches!(kind, "claude" | "codex" | "terminal");
        let selected = if interactive {
            let requested = PathBuf::from(args["cwd"].as_str().context("select a working directory first")?);
            ensure!(requested.is_absolute(), "working directory must be absolute");
            let cwd = fs::canonicalize(&requested).context("working directory is unavailable")?;
            ensure!(cwd.is_dir(), "working directory must be a directory");
            let workspace = git_workspace_for(&cwd)?;
            if let Some(workspace) = &workspace {
                ensure_workspace_available(workspace, &self.db.lock().unwrap().sessions_with_live(&self.terminal_streams.sessions())?)?;
            }
            // A standalone cwd may still overlap a 1.3.x verification that outlived its runner.
            crate::legacy_tasks::ensure_no_live_verification(&self.db.lock().unwrap().0,workspace.as_deref().unwrap_or(&cwd))?;
            Some((cwd,workspace))
        } else {
            ensure!(args.get("cwd").is_none_or(Value::is_null), "cwd is only accepted for interactive sessions");
            None
        };
        // Keep only live handles; never count historical database rows as owned children.
        let mut owned = self.owned.lock().unwrap();
        owned.retain(|_,v| !(*v.done.lock().unwrap() && v.lifecycle.lock().unwrap().reaped));
        ensure!(owned.len()+self.codex_jobs.lock().unwrap().values().filter(|job|!job.worker.is_finished()).count() < self.settings.limit(), "concurrency limit is {}",self.settings.limit());
        drop(owned);
        let work_root = self.data_dir.join("work");
        private_dir(&work_root)?;
        let (cwd,workspace) = match selected {
            Some((cwd,workspace)) => (cwd,workspace),
            None => { let cwd=work_root.join(id);private_dir(&cwd)?;(cwd,None) },
        };
        let binding = if kind=="claude" {
            let previous=args["resumeFrom"].as_str().map(|source|crate::native_sessions::load(&self.data_dir,source)?.context("Identidad nativa no disponible")).transpose()?;
            let conversation=match &previous {Some(binding)=>binding.conversation_id.clone(),None=>match crate::native_sessions::load(&self.data_dir,id)? {Some(binding)=>{ensure!(binding.provider=="claude" && binding.resumed_from.is_none(),"El ID ya pertenece a otra conversación");binding.conversation_id},None=>crate::native_sessions::new_uuid()?}};
            // Fence exact provider identity even when cwd is not a Git repository.
            for other in self.db.lock().unwrap().sessions_with_live(&self.terminal_streams.sessions())? {
                if other["id"]==id || other["kind"]!="claude" || matches!(other["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")) {continue;}
                if let Some(key)=other["id"].as_str() {
                    if let Some(existing)=crate::native_sessions::load(&self.data_dir,key)? {
                        ensure!(!existing.conversation_id.eq_ignore_ascii_case(&conversation),"Esta conversación ya tiene una sesión activa o incierta. Vuelve a ella antes de reanudar.");
                    }
                }
            }
            Some(crate::native_sessions::reserve(&self.data_dir,id,kind,&conversation,args["resumeFrom"].as_str())?)
        } else {None};
        let mut cmd = command(kind, id, &cwd)?;
        if let Some(binding)=binding {
            cmd.arg(if args["resumeFrom"].is_string() {"--resume"} else {"--session-id"});
            cmd.arg(&binding.conversation_id);
        }
        if matches!(kind,"claude"|"codex") {
            let runner=std::env::current_exe()?;
            let handle=self.data_dir.join("pulso-grants").join(format!("{id}.json"));
            cmd.env("JAURIA_PULSO_HANDLE", &handle);
            cmd.env("JAURIA_PULSO_CLIENT", &runner);
            if self.settings.pulso_auto_access() && self.pulso.as_ref().is_some_and(|service|service.available()) {
                let mcp=crate::pulso_mcp_config::PulsoMcp::new(runner,handle)?;
                if kind=="claude" {cmd.arg("--mcp-config");cmd.arg(mcp.claude_config());}
                else {for override_value in mcp.codex_overrides()? {cmd.arg("-c");cmd.arg(override_value);}}
            }
        }
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
            "cwd":cwd,"workspace":workspace,"detail":{"terminalStream":{"generation":self.generation,"history":{"state":"recording","lastFrame":0,"durableFrame":0}}}});
        self.terminal_streams.prepare_register(&session)?;
        self.db.lock().unwrap().insert_native(&session)?;
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
            exited:AtomicBool::new(false),reader_done:AtomicBool::new(false),output_lost:AtomicBool::new(false),publication:Mutex::new(()),done:Mutex::new(false),wake:Condvar::new() });
        if let Err(error)=self.terminal_streams.register(session.clone()) {
            unsafe {libc::kill(-(pid as i32),libc::SIGKILL);}
            let _=child.wait();
            let _=self.db.lock().unwrap().state(id,"failed",json!({"reason":"native live admission failed; owned child stopped before publication"}));
            return Err(error);
        }
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
            let (status, mut detail) = if owned.reader_done.load(Ordering::Acquire) {
                (status, detail)
            } else {
                ("needs_attention", json!({"waitResult":detail,"outputTail":"incomplete: reader still draining after 500ms"}))
            };
            if owned.output_lost.load(Ordering::Acquire) {
                detail["outputNotRetained"]=json!(true);
                detail["outputTail"]=json!("PTY read ended with an error; history may be incomplete");
            }
            // Lifecycle remains the actual wait/stop result. History completeness
            // is tracked separately and persisted asynchronously, best effort.
            runner.terminal_streams.finish(&id,status,detail);
            if let Some(pulso)=&runner.pulso { let _=pulso.revoke_session(&id); }
            *owned.done.lock().unwrap() = true;
            owned.wake.notify_all();
        });
        // Policy lookup may touch Pulso SQLite. Neither PTY draining nor child
        // reaping nor the caller's admission gates may wait for it.
        if let Some(pulso)=self.pulso.clone() {
            let session=session.clone();
            let _=thread::Builder::new().name("pulso-session-policy".into()).spawn(move || {
                let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||pulso.auto_grant(&session)));
            });
        }
        Ok(session)
    }

    /// Flush final observed custody when a DB-backed action needs it. Older
    /// asynchronous checkpoints cannot overwrite this revision in Store.
    fn sync_native_lifecycle(&self)->Result<()> {
        let live=self.terminal_streams.sessions();
        if !live.iter().any(|row|!matches!(row["status"].as_str(),Some("running"|"starting"))) {return Ok(());}
        let mut db=self.db.lock().unwrap();
        let stored=db.sessions()?;
        for row in live.iter().filter(|row|!matches!(row["status"].as_str(),Some("running"|"starting"))) {
            if stored.iter().any(|old|old["id"]==row["id"] && old["status"]!=row["status"]) {
                db.native_checkpoint(row)?;
            }
        }
        Ok(())
    }

    fn native_control(&self,op:&str,id:&str,args:&Value,child:&Arc<Owned>)->Result<Value> {
        match op {
            "input" => {
                let data=args["data"].as_str().context("data must be UTF8 string")?;
                ensure!(data.len()<=MAX_INPUT,"input too large");child.input(data.as_bytes())?;Ok(json!({"written":data.len()}))
            }
            "interrupt" => {
                let vintr=child.master.lock().unwrap().get_termios().context("PTY termios unavailable")?.control_chars[libc::VINTR];
                child.input(&[vintr])?;Ok(json!({"sent":true}))
            }
            "resize" => {
                ensure!(!child.exited.load(Ordering::Acquire),"child already exited");
                let size=dimensions(args)?;
                let _publication=child.publication.lock().unwrap();
                let master=child.master.lock().unwrap();master.resize(size)?;
                let actual=master.get_size()?;
                self.terminal_streams.resize(id,actual.rows,actual.cols);
                Ok(json!({"rows":actual.rows,"cols":actual.cols}))
            }
            "stop" => {
                ensure!(child.stop()?,"termination pending; no confirmed wait result");
                match self.terminal_streams.session(id) {
                    Some(row)=>Ok(row),
                    None=>self.db.lock().unwrap().session(id)?.context("session missing"),
                }
            }
            _=>bail!("unknown native control"),
        }
    }

    fn read_output(self: &Arc<Self>, id: String, child: Arc<Owned>, mut reader: Box<dyn Read + Send>) {
        let runner=self.clone();
        thread::spawn(move || {
            let mut buffer=[0u8;12*1024];
            loop {
                let was_exited=child.exited.load(Ordering::Acquire);
                let result={
                    let _publication=child.publication.lock().unwrap();
                    let result=reader.read(&mut buffer);
                    if let Ok(n)=result {if n>0 {runner.terminal_streams.output(&id,&buffer[..n]);}}
                    result
                };
                match result {
                    Ok(0)=>break,
                    Ok(_)=>{},
                    Err(e) if e.kind()==std::io::ErrorKind::Interrupted=>continue,
                    Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{
                        if was_exited {break;}thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) if e.raw_os_error()==Some(libc::EIO)=>break,
                    Err(e)=>{eprintln!("read PTY: {e}");child.output_lost.store(true,Ordering::Release);break;}
                }
            }
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
            // Let the native CLI resolve persisted approvals, sandbox and reviewer
            // settings. Presentation flags must not reset the account policy.
            cmd.args(["--no-daemon","--no-alt-screen"]);
            cmd
        },
        "claude" => {
            let mut cmd=CommandBuilder::new(PathBuf::from(&home).join(".local/bin/claude"));
            // Interactive Claude uses the account's native settings and MCP
            // discovery, including project trust/approval prompts. The empty
            // MCP override belongs only to the isolated diagnostic probe.
            // A forced permission mode overrides permissions.defaultMode, including
            // a mode the user already saved for future sessions.
            cmd.arg("--no-chrome");
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
        let deadline=Instant::now()+Duration::from_secs(3);
        let session=loop {
            let row=runner.db.lock().unwrap().session("inventory").unwrap().unwrap();
            if row["status"]=="needs_attention" {break row;}
            assert!(Instant::now()<deadline,"native lifecycle checkpoint did not commit");
            thread::sleep(Duration::from_millis(5));
        };
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
        assert_eq!(args, &[PathBuf::from(std::env::var_os("HOME").unwrap()).join(".local/bin/claude").into_os_string(),std::ffi::OsString::from("--no-chrome")]);
        let probe=command("claude_probe","mcp-config-probe",Path::new("/tmp"))?;
        assert!(probe.get_argv().windows(2).any(|pair|pair[0]=="--mcp-config" && pair[1]=="{\"mcpServers\":{}}"));
        assert!(probe.get_argv().iter().any(|arg|arg=="--strict-mcp-config"));
        Ok(())
    }
    #[test]
    fn native_providers_preserve_saved_policy_sources_and_probes_stay_isolated() -> Result<()> {
        let cwd=Path::new("/tmp");
        for kind in ["claude","codex"] {
            let cmd=command(kind,"saved-policy-regression",cwd)?;
            let args=cmd.get_argv();
            for forbidden in ["--permission-mode","--allowedTools","--disallowedTools","--dangerously-skip-permissions", "--sandbox","--ask-for-approval","--approve-for-me","--dangerously-bypass-approvals-and-sandbox","--ignore-user-config","--ignore-rules","--setting-sources","--strict-mcp-config","--config","-c"] {
                assert!(!args.iter().any(|arg|arg==forbidden),"{kind}: native policy overridden by {forbidden}");
            }
            assert_eq!(cmd.get_cwd(),Some(&std::ffi::OsString::from(cwd)));
            assert_eq!(cmd.get_env("HOME"),std::env::var_os("HOME").as_deref());
        }
        let codex=command("codex","saved-policy-regression",cwd)?;
        assert_eq!(codex.get_argv(),&[std::ffi::OsString::from("/opt/homebrew/bin/codex"),std::ffi::OsString::from("--no-daemon"),std::ffi::OsString::from("--no-alt-screen")]);
        let probe=command("codex_probe","saved-policy-probe",cwd)?;
        assert!(probe.get_argv().iter().any(|arg|arg=="--ignore-user-config"));
        assert!(probe.get_argv().windows(2).any(|pair|pair[0]=="--sandbox" && pair[1]=="read-only"));
        let settings:Value=serde_json::from_str(&crate::claude_quota::settings(Path::new("/tmp/runner"),Path::new("/tmp/profile"))?)?;
        assert_eq!(settings.as_object().unwrap().keys().collect::<Vec<_>>(),vec!["statusLine"]);
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
    fn malformed_git_directories_never_become_standalone() -> Result<()> {
        let (_tmp, r, cwd) = fixture()?;
        let broken = cwd.join("broken"); fs::create_dir(&broken)?;
        fs::write(broken.join(".git"),"invalid gitfile")?;
        assert!(git_workspace_for(&broken).is_err());
        for kind in ["codex", "claude", "terminal"] {
            assert!(request(&r,"broken",kind,&broken).unwrap_err().to_string().contains("cannot determine Git workspace safely"));
        }
        for cwd in [Value::Null, json!("relative"), json!(42)] {
            let error = r.request(json!({"version":1,"token":r.token,"op":"start","args":{"id":"invalid","title":"invalid","kind":"codex","cwd":cwd}})).unwrap_err();
            assert!(!error.to_string().contains("fixture reached durable insert"));
        }
        assert!(r.db.lock().unwrap().sessions()?.is_empty());
        Ok(())
    }

    /// Spawns `argv` as its own session leader, like a 1.3.x verification, and
    /// waits until the process inventory sees its exec'd arguments.
    fn verifier(argv: &[String]) -> Result<std::process::Child> {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new(&argv[0]);
        command.args(&argv[1..]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        unsafe { command.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
        let child = command.spawn()?;
        let until = Instant::now() + Duration::from_secs(3);
        while crate::process_custody::live_session_leader(argv, 0)? != Some(child.id() as i32) {
            ensure!(Instant::now() < until, "synthetic verifier not visible");
            thread::sleep(Duration::from_millis(10));
        }
        Ok(child)
    }

    #[test]
    fn legacy_verification_blocks_writers_only_while_its_command_lives() -> Result<()> {
        let (_tmp, r, home) = fixture()?;
        let fenced = home.join("repo/sub"); fs::create_dir_all(fenced.join("deeper"))?;
        let sibling = home.join("sibling"); fs::create_dir(&sibling)?;
        let argv = vec!["/bin/sleep".to_owned(), format!("{}.25", 600 + std::process::id() % 1000)];
        let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() - 1;
        let payload = |argv: &[String], created: u64| json!({"argv":argv,"cwd":fenced,"createdAt":created,"status":"running"}).to_string();
        let row = |r: &Arc<Runner>| -> Result<(String,String)> { Ok(r.db.lock().unwrap().0.query_row("SELECT status,payload FROM verification_runs", [], |row| Ok((row.get(0)?,row.get(1)?)))?) };
        {
            let db = r.db.lock().unwrap();
            db.0.execute("INSERT INTO projects VALUES('p','/synthetic/repo','/synthetic/repo/.git','fixture','base',NULL)", [])?;
            db.0.execute("INSERT INTO tasks VALUES('t','p','T','O','','base','b','/synthetic/elsewhere','ready',NULL)", [])?;
            db.0.execute("INSERT INTO verification_runs VALUES('v','t','req','hash','running',0,?)", [payload(&argv,created)])?;
        }
        let before = row(&r)?;
        let mut child = verifier(&argv)?;
        let pid = format!("(pid {})", child.id());
        // (a) every writer kind in the fenced folder; (d) its ancestors and descendants.
        for (kind, cwd) in [("codex",&fenced),("claude",&fenced),("terminal",&fenced),("terminal",&home.join("repo")),("terminal",&home),("codex",&fenced.join("deeper"))] {
            let error = request(&r,"blocked",kind,cwd).unwrap_err().to_string();
            assert!(error.contains("Un proceso de verificación de una versión anterior sigue activo") && error.contains(&pid), "{kind} {error}");
        }
        let error = r.request(json!({"version":1,"token":r.token,"op":"start_codex","args":{"id":"structured","title":"t","kind":"codex","cwd":fenced,"rows":24,"cols":80}})).unwrap_err().to_string();
        assert!(error.contains(&pid), "{error}");
        admitted(request(&r,"sibling","terminal",&sibling).unwrap_err());
        // (c) another identity: a different argv, or a process older than the run.
        for other in [payload(&[argv[0].clone(),"other".into()],created), payload(&argv,created+3600)] {
            r.db.lock().unwrap().0.execute("UPDATE verification_runs SET payload=?",[other])?;
            admitted(request(&r,"other","terminal",&fenced).unwrap_err());
        }
        r.db.lock().unwrap().0.execute("UPDATE verification_runs SET payload=?",[payload(&argv,created)])?;
        assert_eq!(row(&r)?, before);
        // (b) the command has ended: admitted, and the old row is left untouched.
        child.kill()?; child.wait()?;
        admitted(request(&r,"ended","terminal",&fenced).unwrap_err());
        assert_eq!(row(&r)?, before);
        assert!(r.db.lock().unwrap().sessions()?.is_empty());
        Ok(())
    }
}

#[cfg(test)]
mod session_preferences_tests {
    use super::*;

    #[test]
    fn renamed_archive_and_current_settings_survive_busy_status_fallback()->Result<()> {
        let tmp=tempfile::Builder::new().prefix("aw-prefs-cache-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let runner=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        let request=|op:&str,args:Value|runner.request(json!({"version":1,"token":runner.token,"op":op,"args":args}));
        for status in ["running","exited"] {
            runner.db.lock().unwrap().insert(&json!({"id":status,"title":"old","kind":"fixture","status":status,"rows":24,"cols":80}))?;
        }
        request("status",json!({}))?;
        for id in ["running","exited"] {request("rename_session",json!({"id":id,"title":"renamed"}))?;}
        request("set_settings",json!({"maxConcurrentSessions":4}))?;
        let _busy=runner.db.lock().unwrap();
        let cached=request("status",json!({}))?;
        assert_eq!(cached["settings"]["maxConcurrentSessions"],4);
        assert_eq!(cached["settingsVersion"],2);assert_eq!(cached["sessionRenameVersion"],1);
        for row in cached["sessions"].as_array().unwrap() {assert_eq!(row["title"],"renamed");}
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
            let page=runner.terminal_streams.live("live",0,64)?;
            for event in page["frames"].as_array().unwrap() {
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
        assert!(request("start",json!({"id":"busy","title":"busy","kind":"shell","rows":24,"cols":80})).unwrap_err().to_string().contains("en curso"));
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
        assert!(runner.db.lock().unwrap().session("busy")?.is_none(),"busy request acquired a late effect");
        Ok(())
    }
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    #[test]
    fn poisoned_admission_gate_cleanup_stops_owned_pty() -> Result<()> {
        let tmp=tempfile::Builder::new().prefix("aw-cleanup-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let runner=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        runner.request(json!({"version":1,"token":runner.token,"op":"start","args":{"id":"cleanup-shell","title":"fixture","kind":"shell","rows":24,"cols":80}}))?;
        let owned=runner.owned.lock().unwrap()["cleanup-shell"].clone();
        let poison=runner.clone();assert!(thread::spawn(move||{let _guard=poison.mutations.lock().unwrap();panic!("owned gate poison fixture");}).join().is_err());
        runner.cleanup_owned();assert!(owned.wait_done(Duration::from_secs(5)));assert!(owned.lifecycle.lock().unwrap().reaped);
        Ok(())
    }
    #[test]
    fn client_permit_releases_capacity_on_panic() {
        let clients=Arc::new(AtomicUsize::new(1));let counter=clients.clone();
        assert!(thread::spawn(move||{let _permit=ClientPermit(counter);panic!("owned client permit fixture");}).join().is_err());
        assert_eq!(clients.load(Ordering::Acquire),0);
    }
}

#[path="runner_codex.rs"] mod codex;

#[cfg(test)]
mod session_admission_tests {
    use super::*;
    fn fixture() -> Result<(tempfile::TempDir,Arc<Runner>)> {
        let tmp=tempfile::tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let r=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        Ok((tmp,r))
    }
    fn request(r:&Arc<Runner>,op:&str,args:Value)->Result<Value>{
        r.request(json!({"version":1,"token":r.token,"op":op,"args":args}))
    }
    #[test]
    fn every_start_admission_is_serialized_by_workspace_gate() -> Result<()> {
        let (_tmp,r)=fixture()?;let _gate=r.workspace_mutations.lock().unwrap();
        for (op,args) in [
            ("start",json!({"id":"queued","title":"Title","kind":"shell","rows":24,"cols":80})),
            ("start_codex",json!({"id":"queued","title":"Title","kind":"codex","cwd":"/missing","rows":24,"cols":80})),
            ("codex_resume",json!({"id":"queued","generation":1})),
            ("resume_native",json!({"id":"queued","sourceId":"source","rows":24,"cols":80})),
        ] {
            assert!(request(&r,op,args).unwrap_err().to_string().contains("en curso"),"{op}");
        }
        assert!(r.db.lock().unwrap().sessions()?.is_empty());Ok(())
    }
    #[test]
    fn existing_exact_session_retries_do_not_spawn() -> Result<()> {
        let (_tmp,r)=fixture()?;
        r.db.lock().unwrap().insert(&json!({"id":"existing","title":"Title","kind":"shell","status":"stopped","rows":24,"cols":80}))?;
        let generic=json!({"id":"existing","title":"Title","kind":"shell"});
        assert_eq!(r.start("existing",&generic)?["status"],"stopped");
        let mut conflict=generic;conflict["title"]=json!("Changed");assert!(r.start("existing",&conflict).is_err());
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

#[cfg(test)]
mod terminal_history_recovery_tests {
    use super::*;

    fn final_checkpoint_failure(release: bool) -> Result<()> {
        let tmp=tempfile::Builder::new().prefix("aw-history-final-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let mut runner=Runner::open(root.join("data"),root.join("sock"),root.join("token"))?;
        if release {runner.inventory=Arc::new(|_|bail!("fixture inventory unavailable"));}
        let runner=Arc::new(runner);
        let request=|op:&str,args:Value|runner.request(json!({"version":1,"token":runner.token,"op":op,"args":args}));
        request("start",json!({"id":"ended","kind":"shell","title":"ended","rows":24,"cols":80}))?;
        runner.db.lock().unwrap().0.execute_batch("CREATE TRIGGER fail_terminal_final BEFORE INSERT ON events WHEN NEW.kind='state' AND json_extract(NEW.data,'$.status') IN ('exited','stopped','needs_attention') BEGIN SELECT RAISE(ABORT,'fixture final checkpoint unavailable'); END;")?;
        let child=runner.owned.lock().unwrap()["ended"].clone();
        child.input(b"exit\n")?;
        assert!(child.wait_done(Duration::from_secs(5)));
        let expected=if release {"needs_attention"}else{"exited"};
        assert_eq!(runner.terminal_streams.session("ended").unwrap()["status"],expected);
        let deadline=Instant::now()+Duration::from_secs(3);
        while runner.terminal_streams.session("ended").unwrap()["history"]["reason"]!="io" {
            assert!(Instant::now()<deadline,"fault was not exercised");thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(runner.db.lock().unwrap().session("ended")?.unwrap()["status"],"running");
        runner.db.lock().unwrap().0.execute_batch("DROP TRIGGER fail_terminal_final")?;
        if release {
            let released=request("release",json!({"id":"ended","confirmed":true}))?;
            assert_eq!(released["status"],"released");
            assert!(released["detail"]["reason"].as_str().unwrap().contains("explicit operator"));
            assert_eq!(runner.db.lock().unwrap().session("ended")?.unwrap()["status"],"released");
        } else {
            // A DB-backed new admission first reconciles the final in-memory
            // lifecycle; the stale running row cannot keep occupying a slot.
            request("start",json!({"id":"next","kind":"shell","title":"next","rows":24,"cols":80}))?;
            assert_eq!(runner.db.lock().unwrap().session("ended")?.unwrap()["status"],"exited");
            request("stop",json!({"id":"next"}))?;
        }
        let deadline=Instant::now()+Duration::from_secs(3);
        loop {
            match request("purge_history",json!({"id":"ended","confirmed":true})) {
                Ok(_)=>break,
                Err(error) if error.to_string().contains("draining") && Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),
                Err(error)=>return Err(error),
            }
        }
        let row=runner.db.lock().unwrap().session("ended")?.unwrap();
        assert_eq!(row["detail"]["terminalStream"]["history"]["reason"],"explicit_purge");
        runner.cleanup_owned();
        Ok(())
    }
    #[test]
    fn failed_final_checkpoint_does_not_block_new_admission_or_purge()->Result<()> {final_checkpoint_failure(false)}
    #[test]
    fn release_uses_observed_custody_even_when_database_still_says_running()->Result<()> {final_checkpoint_failure(true)}
}

#[cfg(test)]
mod pulso_revision_tests {
    use super::*;
    use std::{io::BufRead, os::unix::net::UnixStream};
    // Synthetic profile, own socket and token in a temporary directory.
    fn fixture() -> Result<(tempfile::TempDir,PathBuf,Arc<Runner>)> {
        let tmp=tempfile::Builder::new().prefix("aw-pulso-rev-").tempdir_in("/tmp")?;
        fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let root=fs::canonicalize(tmp.path())?;
        let runner=Arc::new(Runner::open(root.join("data"),root.join("sock"),root.join("token"))?);
        Ok((tmp,root,runner))
    }
    fn status(r:&Arc<Runner>)->Result<Value> { r.request(json!({"version":1,"token":r.token,"op":"status","args":{}})) }
    fn pulso(root:&Path,op:&str,args:Value)->Result<Value> {
        let token=fs::read_to_string(root.join("pulso.token"))?;
        let mut stream=UnixStream::connect(root.join("pulso.sock"))?;
        writeln!(stream,"{}",json!({"version":1,"token":token,"op":op,"args":args}))?;
        let mut line=String::new();std::io::BufReader::new(stream).read_line(&mut line)?;
        let reply:Value=serde_json::from_str(&line)?;
        ensure!(reply["ok"]==true,"{}",reply["error"]);
        Ok(reply["result"].clone())
    }
    fn meta(root:&Path)->Result<u64> { pulso(root,"revision",json!({}))?["revision"].as_u64().context("revision") }

    #[test]
    fn status_revision_tracks_ui_and_mcp_commits_but_not_rejections() -> Result<()> {
        let (_tmp,root,runner)=fixture()?;
        let initial=status(&runner)?;
        assert_eq!(initial["pulsoRevisionVersion"],1);
        assert_eq!(initial["pulsoRevision"],0);
        assert_eq!(initial["pulsoSummaryVersion"],1);
        assert_eq!(initial["statusVersion"],2);assert_eq!(initial["pulsoVersion"],1);assert_eq!(initial["pulsoBoardVersion"],1);
        // UI write through the Pulso socket.
        pulso(&root,"project_create",json!({"id":"p","requestId":"p","title":"Synthetic"}))?;
        assert_eq!(meta(&root)?,1);
        assert_eq!(status(&runner)?["pulsoRevision"],1);
        // Real MCP path: tool mapping from pulso_mcp and the scoped client over the socket.
        runner.db.lock().unwrap().insert(&json!({"id":"agent-s","title":"agent","kind":"claude","status":"running","rows":24,"cols":80,"cwd":root.to_str()}))?;
        let grant=pulso(&root,"grant",json!({"sessionId":"agent-s","projectId":"p"}))?;
        let handle=PathBuf::from(grant["handle"].as_str().context("handle")?);
        let (op,args)=crate::pulso_mcp::operation("jauria_create_phase",&json!({"projectId":"p","title":"Phase","idempotencyKey":"k1"}))?;
        crate::pulso_client::request(&handle,op,args.clone())?;
        assert_eq!(meta(&root)?,2);
        assert_eq!(status(&runner)?["pulsoRevision"],2);
        // A receipt replay, a rejected write and an unauthorized UI-only read move nothing.
        crate::pulso_client::request(&handle,op,args)?;
        assert!(crate::pulso_client::request(&handle,"item_update",json!({"id":"phase-k1","requestId":"bad","expectedRevision":999,"status":"done"})).is_err());
        assert!(crate::pulso_client::request(&handle,"board",json!({"projectId":"p"})).is_err());
        assert!(pulso(&root,"project_create",json!({"id":"p","requestId":"dup","title":"Duplicate"})).is_err());
        assert_eq!(meta(&root)?,2);
        assert_eq!(status(&runner)?["pulsoRevision"],2);
        // Budget rollback: the transaction aborts after allocating a revision.
        runner.pulso.as_ref().unwrap().with_store_for_test(|c|c.execute("UPDATE pulso_budget SET bytes=? WHERE id=1",[64*1024*1024]).map(|_|()))?;
        assert!(pulso(&root,"project_create",json!({"id":"q","requestId":"q","title":"Blocked"})).is_err());
        assert_eq!(meta(&root)?,2);
        assert_eq!(status(&runner)?["pulsoRevision"],2);
        Ok(())
    }

    #[test]
    fn status_revision_is_current_while_the_session_store_is_busy() -> Result<()> {
        let (_tmp,root,runner)=fixture()?;
        status(&runner)?;
        let busy=runner.db.lock().unwrap();
        pulso(&root,"project_create",json!({"id":"p","requestId":"p","title":"Synthetic"}))?;
        let cached=status(&runner)?;
        assert_eq!(cached["pulsoRevision"],1);
        assert_eq!(cached["pulsoRevisionVersion"],1);
        drop(busy);
        Ok(())
    }

    #[test]
    fn status_omits_revision_when_pulso_is_unavailable() -> Result<()> {
        let (_tmp,_root,runner)=fixture()?;
        runner.pulso.as_ref().unwrap().shutdown();
        let value=status(&runner)?;
        assert_eq!(value["pulsoAvailable"],false);
        assert!(value.get("pulsoRevision").is_none() && value.get("pulsoRevisionVersion").is_none());
        Ok(())
    }
}

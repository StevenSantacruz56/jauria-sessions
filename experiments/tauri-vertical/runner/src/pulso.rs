//! Private, independent Pulso service. No core-store or process-launch operations.
#[path = "pulso_store.rs"]
mod store;
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
pub type SessionLookup = Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>;
const REQUEST_MAX: usize = 128 * 1024;
const RESPONSE_MAX: usize = 512 * 1024;
struct Grant {
    policy: Option<(String,String)>,
    principal: store::Principal,
    token: String,
    automatic: bool,
}
struct State {
    store: store::Store,
    grants: HashMap<String, Grant>,
}
struct Shared {
    state: Mutex<State>,
    tokens: Mutex<HashMap<String, (String, u64)>>,
    revoked: Mutex<HashMap<String, u64>>,
    lookup: SessionLookup,
    // Same counter as `State.store.1`; read without the state mutex or SQLite.
    revision: Arc<AtomicU64>,
    quitting: AtomicBool,
    listening: AtomicBool,
    auto_enabled: AtomicBool,
    ui: String,
    grants_dir: PathBuf,
    socket: PathBuf,
}
pub struct Service {
    shared: Arc<Shared>,
    listener: Mutex<Option<JoinHandle<()>>>,
    workers: Arc<Mutex<Vec<JoinHandle<()>>>>,
    owned: Vec<(PathBuf, u64, u64)>,
    _lock: File,
}
impl Service {
    pub fn start(
        data_dir: &Path,
        socket_parent: &Path,
        lookup: SessionLookup,
    ) -> Result<Arc<Self>> {
        private_dir(data_dir)?;
        private_dir(socket_parent)?;
        let grants_dir = data_dir.join("pulso-grants");
        private_dir(&grants_dir)?;
        let lock = private_file(&socket_parent.join("pulso.lock"), false)?;
        ensure!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "Pulso already active"
        );
        let socket = socket_parent.join("pulso.sock");
        let token_path = socket_parent.join("pulso.token");
        if let Ok(m) = fs::symlink_metadata(&socket) {
            fence(&m, false)?;
            ensure!(m.file_type().is_socket(), "unsafe socket path");
            match UnixStream::connect(&socket) {
                Ok(_) => bail!("Pulso socket is live"),
                Err(e) => ensure!(
                    matches!(
                        e.raw_os_error(),
                        Some(libc::ECONNREFUSED) | Some(libc::ENOENT)
                    ),
                    "cannot establish stale socket"
                ),
            }
            fs::remove_file(&socket)?;
        }
        let database = data_dir.join("pulso.sqlite");
        let f = private_file(&database, false)?;
        for suffix in ["-journal", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{suffix}", database.display()));
            if let Ok(m) = fs::symlink_metadata(p) {
                fence(&m, true)?;
            }
        }
        let store = store::Store::open(&database)?;
        drop(f);
        let ui = random()?;
        let mut f = private_file(&token_path, false)?;
        f.set_len(0)?;
        f.write_all(ui.as_bytes())?;
        f.sync_all()?;
        let mut owned = vec![identity(&token_path)?];
        let listener = match UnixListener::bind(&socket) {
            Ok(l) => l,
            Err(e) => {
                cleanup(&owned);
                return Err(e.into());
            }
        };
        if let Err(e) = (|| -> Result<()> {
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            Ok(())
        })() {
            let _ = fs::remove_file(&socket);
            cleanup(&owned);
            return Err(e);
        }
        owned.push(identity(&socket)?);
        let revision = store.1.clone();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                store,
                grants: HashMap::new(),
            }),
            tokens: Mutex::new(HashMap::new()),
            revoked: Mutex::new(HashMap::new()),
            lookup,
            revision,
            quitting: AtomicBool::new(false),
            listening: AtomicBool::new(true),
            auto_enabled: AtomicBool::new(true),
            ui,
            grants_dir,
            socket,
        });
        let workers = Arc::new(Mutex::new(Vec::<JoinHandle<()>>::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let s = shared.clone();
        let w = workers.clone();
        let task = thread::Builder::new()
            .name("pulso-listener".into())
            .spawn(move || {
                while !s.quitting.load(Ordering::Acquire) {
                    {
                        let mut jobs = w.lock().unwrap_or_else(|e| e.into_inner());
                        let mut i = 0;
                        while i < jobs.len() {
                            if jobs[i].is_finished() {
                                let _ = jobs.swap_remove(i).join();
                            } else {
                                i += 1;
                            }
                        }
                    }
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if active.load(Ordering::Acquire) >= 8 {
                                continue;
                            }
                            active.fetch_add(1, Ordering::AcqRel);
                            let s = s.clone();
                            let count = active.clone();
                            match thread::Builder::new().name("pulso-client".into()).spawn(
                                move || {
                                    struct Active(Arc<AtomicUsize>);
                                    impl Drop for Active {
                                        fn drop(&mut self) {
                                            self.0.fetch_sub(1, Ordering::AcqRel);
                                        }
                                    }
                                    let _active = Active(count);
                                    let _ = serve(&s, stream);
                                },
                            ) {
                                Ok(h) => w.lock().unwrap_or_else(|e| e.into_inner()).push(h),
                                Err(_) => {
                                    active.fetch_sub(1, Ordering::AcqRel);
                                }
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10))
                        }
                        Err(e) if matches!(e.kind(),std::io::ErrorKind::Interrupted|std::io::ErrorKind::ConnectionAborted) => continue,
                        Err(e) if matches!(e.raw_os_error(),Some(libc::EMFILE)|Some(libc::ENFILE)|Some(libc::ENOBUFS)|Some(libc::ENOMEM)) => thread::sleep(Duration::from_millis(100)),
                        Err(_) => break,
                    }
                }
                s.listening.store(false,Ordering::Release);
            });
        let task = match task {
            Ok(t) => t,
            Err(e) => {
                cleanup(&owned);
                return Err(e.into());
            }
        };
        Ok(Arc::new(Self {
            shared,
            listener: Mutex::new(Some(task)),
            workers,
            owned,
            _lock: lock,
        }))
    }
    /// Intentionally independent of SQLite and filesystem IO; safe before native stop.
    pub fn revoke_session(&self, id: &str) -> Result<()> {
        let mut revoked = self
            .shared
            .revoked
            .lock()
            .map_err(|_| anyhow::anyhow!("revocation unavailable"))?;
        let epoch = revoked.entry(id.into()).or_default();
        *epoch = epoch
            .checked_add(1)
            .context("revocation generation exhausted")?;
        Ok(())
    }
    pub fn auto_grant(&self, session: &Value) -> Result<()> {
        self.auto_grant_inner(session,false)
    }
    pub fn auto_grant_resume(&self, session: &Value) -> Result<()> {
        self.auto_grant_inner(session,true)
    }
    fn auto_grant_inner(&self, session: &Value, resume: bool) -> Result<()> {
        if !self.shared.auto_enabled.load(Ordering::Acquire) { return Ok(()); }
        ensure!(
            !self.shared.quitting.load(Ordering::Acquire),
            "service stopped"
        );
        let sid = store::id(session, "id")?;
        let epoch = self.shared.epoch(&sid)?;
        ensure!(resume || epoch == 0, "automatic grant cancelled after revocation");
        let live = (self.shared.lookup)(&sid).context("session unavailable")?;
        live_session(&live)?;
        ensure!(matches!(live["kind"].as_str(),Some("claude"|"codex")),"automatic access requires a Jauria agent session");
        let key = policy_key(&live)?;
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Pulso unavailable"))?;
        if state.grants.contains_key(&sid) && !resume {
            return Ok(());
        }
        let policy: Option<String> = state
            .store
            .0
            .query_row("SELECT body FROM policies WHERE key=?", [&key], |r| r.get(0))
            .optional()?;
        // A session that was explicitly narrowed by the user must not widen
        // merely because its structured Codex connection resumed.
        if resume && policy.is_none() && state.grants.get(&sid).is_some_and(|grant|!grant.automatic) {
            return Ok(());
        }
        if let Some(policy) = policy {
            let policy: Value = serde_json::from_str(&policy)?;
            let mut a = json!({"sessionId":sid,"canCreateProjects":policy["canCreateProjects"].as_bool().unwrap_or(false)});
            if let Some(project) = policy["projectId"].as_str() {
                a["projectId"] = json!(project);
            }
            self.shared.issue(&mut state, &a, &live, epoch, Some(&key), false, true)?;
        } else {
            // The Jauria-owned session is the principal. Its handle remains
            // session-local and revocable; external CLIs receive no handle.
            let a=json!({"sessionId":sid,"canCreateProjects":true});
            self.shared.issue(&mut state,&a,&live,epoch,None,true,true)?;
        }
        Ok(())
    }
    pub fn set_auto_enabled(&self, enabled: bool) {
        self.shared.auto_enabled.store(enabled,Ordering::Release);
    }
    /// Last committed `meta.revision`, published by the store after COMMIT
    /// while the service mutex is held. Covers UI and MCP writes alike: both
    /// reach this process through the Pulso socket. Never touches SQLite.
    pub fn revision(&self) -> u64 { self.shared.revision.load(Ordering::Acquire) }
    #[cfg(test)]
    pub(crate) fn with_store_for_test<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T> {
        let state = self.shared.state.lock().map_err(|_| anyhow::anyhow!("Pulso unavailable"))?;
        Ok(f(&state.store.0)?)
    }
    pub fn available(&self)->bool { self.shared.listening.load(Ordering::Acquire) && !self.shared.quitting.load(Ordering::Acquire) }
    pub fn shutdown(&self) {
        if self.shared.quitting.swap(true, Ordering::AcqRel) { return; }
        if let Some(h) = self
            .listener
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = h.join();
        }
        let mut jobs = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        for h in jobs.drain(..) {
            let _ = h.join();
        }
        self.shared
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        if let Ok(mut state) = self.shared.state.lock() {
            for (sid, g) in state.grants.drain() {
                remove_handle(&self.shared.grants_dir, &sid, &g.token);
            }
        }
        cleanup(&self.owned);
        unsafe { libc::flock(self._lock.as_raw_fd(), libc::LOCK_UN); }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}
impl Shared {
    fn epoch(&self, sid: &str) -> Result<u64> {
        Ok(*self
            .revoked
            .lock()
            .map_err(|_| anyhow::anyhow!("revocation unavailable"))?
            .get(sid)
            .unwrap_or(&0))
    }
    fn issue(&self, state: &mut State, a: &Value, live: &Value, epoch: u64, origin_policy: Option<&str>, all_projects: bool, automatic: bool) -> Result<Value> {
        store::fields(
            a,
            &["sessionId", "projectId", "canCreateProjects", "remember"],
        )?;
        let sid = store::id(a, "sessionId")?;
        live_session(live)?;
        for k in ["canCreateProjects", "remember"] {
            if let Some(v) = a.get(k) {
                ensure!(v.is_boolean(), "invalid boolean");
            }
        }
        let policy = if a["remember"] == true {
            Some(policy_key(live)?)
        } else {
            origin_policy.map(str::to_owned)
        };
        let mut projects = HashSet::new();
        if a.get("projectId").is_some() {
            let i = store::id(a, "projectId")?;
            state.store.get("project", &i)?;
            projects.insert(i);
        }
        let create = a["canCreateProjects"].as_bool().unwrap_or(false);
        ensure!(create || all_projects || !projects.is_empty(), "empty grant scope");
        let principal: Option<String> = state
            .store
            .0
            .query_row("SELECT id FROM principals WHERE session=?", [&sid], |r| {
                r.get(0)
            })
            .optional()?;
        let principal = match principal {
            Some(p) => p,
            None => {
                let p = format!("session-{}", random()?);
                state
                    .store
                    .0
                    .execute("INSERT INTO principals VALUES(?,?)", params![sid, p])?;
                p
            }
        };
        if create {
            let mut q=state.store.0.prepare("SELECT result FROM receipts WHERE principal=? AND json_extract(body,'$.op')='project_create'")?;
            for row in q.query_map([&principal], |r| r.get::<_, String>(0))? {
                let v: Value = serde_json::from_str(&row?)?;
                if let Some(i) = v["project"]["id"].as_str() {
                    projects.insert(i.into());
                }
            }
        }
        if let Some(key) = &policy {
            let mut policy = a.clone();
            policy.as_object_mut().unwrap().remove("sessionId");
            policy["remember"] = json!(false);
            let (provider, cwd) = policy_context(live)?;
            policy["provider"] = json!(provider);
            policy["cwd"] = json!(cwd);
            let old:Option<String>=state.store.0.query_row("SELECT body FROM policies WHERE key=?",[key],|r|r.get(0)).optional()?;
            let old=old.map(|b|serde_json::from_str::<Value>(&b)).transpose()?;
            let generation=old.as_ref().filter(|old|policy_scope(old)==policy_scope(&policy)).and_then(|old|old["generation"].as_str()).map(str::to_owned).unwrap_or(random()?);
            policy["generation"]=json!(generation);
            state.store.0.execute("INSERT INTO policies VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",params![key,policy.to_string()])?;
        }
        let bound_policy=if let Some(key)=&policy {
            let body:String=state.store.0.query_row("SELECT body FROM policies WHERE key=?",[key],|r|r.get(0))?;
            Some((key.clone(),policy_fingerprint(&serde_json::from_str(&body)?)))
        } else {None};
        let exe = std::env::current_exe()?;
        let token = random()?;
        let path = self.grants_dir.join(format!("{sid}.json"));
        let tmp = self.grants_dir.join(format!(".{}", random()?));
        let mut file = private_file(&tmp, true)?;
        let result = (|| -> Result<()> {
            file.write_all(
                json!({"socket":self.socket,"token":token})
                    .to_string()
                    .as_bytes(),
            )?;
            file.sync_all()?;
            if let Ok(m) = fs::symlink_metadata(&path) {
                fence(&m, true)?;
            }
            fs::rename(&tmp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result?;
        let command = format!(
            "{} --pulso-client --handle {}",
            quote(&exe.to_string_lossy()),
            quote(&path.to_string_lossy())
        );
        let revoked = self
            .revoked
            .lock()
            .map_err(|_| anyhow::anyhow!("revocation unavailable"))?;
        ensure!(
            !self.quitting.load(Ordering::Acquire) && *revoked.get(&sid).unwrap_or(&0) == epoch,
            "unauthorized"
        );
        let mut tokens = self
            .tokens
            .lock()
            .map_err(|_| anyhow::anyhow!("credential unavailable"))?;
        tokens.retain(|_, (s, _)| s != &sid);
        tokens.insert(token.clone(), (sid.clone(), epoch));
        state.grants.insert(
            sid.clone(),
            Grant {
                policy: bound_policy,
                principal: store::Principal {
                    id: principal,
                    session: Some(sid.clone()),
                    projects,
                    create,
                    all_projects,
                },
                token,
                automatic,
            },
        );
        drop(tokens);
        drop(revoked);
        let guidance = format!(
            "Sesión de contexto: {sid}. Consulta: {command} projects '{{\"limit\":50}}' o {command} items '{{\"limit\":50}}'. Genera un UUID distinto por registro y requestId (por ejemplo con uuidgen); no reutilices los IDs de ejemplo. Para crear un plan: {command} project_create '{{\"id\":\"plan-id\",\"requestId\":\"solicitud-id\",\"title\":\"Plan\"}}'. Usa requestId estable y expectedRevision para editar. mainSessionId por defecto es tu sesión al crear. Cierra con status done explícito. No leas ni imprimas credenciales."
        );
        Ok(json!({"handle":path,"command":command,"policyId":policy,"guidance":guidance}))
    }
    fn dispatch(&self, v: &Value) -> Result<Value> {
        store::fields(v, &["version", "token", "op", "args"])?;
        ensure!(v["version"].as_u64() == Some(1), "unsupported version");
        let token = v["token"].as_str().context("unauthorized")?;
        ensure!(token.len() == 64, "unauthorized");
        let op = v["op"].as_str().context("missing op")?;
        let a = v.get("args").context("missing args")?;
        ensure!(a.is_object(), "args must be an object");
        ensure!(!self.quitting.load(Ordering::Acquire), "service stopped");
        if constant_eq(token, &self.ui) {
            let live = if op == "grant" {
                let sid = store::id(a, "sessionId")?;
                let epoch = self.epoch(&sid)?;
                let live = (self.lookup)(&sid).context("session unavailable")?;
                live_session(&live)?;
                Some((live, epoch))
            } else {
                None
            };
            // Revoke is also an in-memory barrier before acquiring the database lock.
            if op == "revoke" {
                store::fields(a, &["sessionId"])?;
                let sid = store::id(a, "sessionId")?;
                let mut revoked = self.revoked.lock().unwrap();
                let epoch = revoked.entry(sid).or_default();
                *epoch = epoch
                    .checked_add(1)
                    .context("revocation generation exhausted")?;
                return Ok(json!({}));
            }
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("Pulso unavailable"))?;
            match op {
                "grant" => {
                    let (live, epoch) = live.unwrap();
                    return self.issue(&mut state, a, &live, epoch, None, false, false);
                }
                "policies" => {
                    store::fields(a, &[])?;
                    let mut q = state
                        .store
                        .0
                        .prepare("SELECT key,body FROM policies ORDER BY key")?;
                    let rows =
                        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                    let mut out = Vec::new();
                    for row in rows {
                        let (key, b) = row?;
                        out.push(json!({"id":key,"policy":serde_json::from_str::<Value>(&b)?}));
                    }
                    return Ok(json!({"policies":out}));
                }
                "revoke_policy" => {
                    store::fields(a, &["id"])?;
                    let key = store::string(a, "id", 64, true)?;
                    state
                        .store
                        .0
                        .execute("DELETE FROM policies WHERE key=?", [key])?;
                    return Ok(json!({}));
                }
                _ => {}
            }
            return operate(&mut state.store, &mut store::Principal::ui(), op, a);
        }
        let (sid, epoch) = self
            .tokens
            .lock()
            .map_err(|_| anyhow::anyhow!("unauthorized"))?
            .get(token)
            .cloned()
            .context("unauthorized")?;
        ensure!(self.epoch(&sid)? == epoch, "unauthorized");
        let live = (self.lookup)(&sid).context("session unavailable")?;
        live_session(&live)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Pulso unavailable"))?;
        ensure!(
            !self.quitting.load(Ordering::Acquire) && self.epoch(&sid)? == epoch,
            "unauthorized"
        );
        let mut grant = state.grants.remove(&sid).context("unauthorized")?;
        if !constant_eq(token, &grant.token) {
            state.grants.insert(sid, grant);
            bail!("unauthorized");
        }
        let result = (|| -> Result<Value> {
            ensure!(!grant.automatic || self.auto_enabled.load(Ordering::Acquire),"unauthorized");
            if let Some((key,expected))=&grant.policy {
                let body:Option<String>=state.store.0.query_row("SELECT body FROM policies WHERE key=?",[key],|r|r.get(0)).optional()?;
                let body=body.context("unauthorized")?;
                let policy:Value=serde_json::from_str(&body)?;
                ensure!(&policy_fingerprint(&policy)==expected,"unauthorized");
            }
            operate(&mut state.store, &mut grant.principal, op, a)
        })();
        state.grants.insert(sid, grant);
        result
    }
}
fn operate(s: &mut store::Store, p: &mut store::Principal, op: &str, a: &Value) -> Result<Value> {
    match op {
        "board" | "sidebar_summary" | "revision" | "projects" | "project" | "items" | "item" | "links" | "activity" | "checkpoint_history" => {
            s.read(p, op, a)
        }
        "project_create" | "project_update" | "item_create" | "item_update" | "link"
        | "checkpoint_create" => s.write(p, op, a),
        _ => bail!("unknown operation"),
    }
}
fn serve(s: &Shared, mut stream: UnixStream) -> Result<()> {
    // BSD accept may inherit O_NONBLOCK from the listening socket.
    stream.set_nonblocking(false)?;
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        ensure!(
            unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut cred as *mut _ as *mut _,
                    &mut len,
                )
            } == 0
                && cred.uid == unsafe { libc::geteuid() },
            "unauthorized peer"
        );
    }
    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    {
        let (mut uid, mut gid) = (0, 0);
        ensure!(
            unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0
                && uid == unsafe { libc::geteuid() },
            "unauthorized peer"
        );
    }
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    let response_deadline=std::time::Instant::now()+Duration::from_secs(2);
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let mut bytes = Vec::new();
    let result = (|| -> Result<Value> {
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            ensure!(!remaining.is_zero(), "request timeout");
            ensure!(!s.quitting.load(Ordering::Acquire),"service stopped");
            stream.set_read_timeout(Some(remaining.min(Duration::from_millis(100))))?;
            let mut b = [0u8; 4096];
            let n=match stream.read(&mut b){Ok(n)=>n,Err(e) if matches!(e.kind(),std::io::ErrorKind::Interrupted|std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>continue,Err(e)=>return Err(e.into())};
            ensure!(n > 0, "incomplete request");
            if let Some(end) = b[..n].iter().position(|b| *b == b'\n') {
                ensure!(bytes.len() + end <= REQUEST_MAX, "request too large");
                bytes.extend_from_slice(&b[..end]);
                break;
            }
            ensure!(bytes.len() + n <= REQUEST_MAX, "request too large");
            bytes.extend_from_slice(&b[..n]);
        }
        let v: Value = serde_json::from_slice(&bytes).context("invalid JSON")?;
        s.dispatch(&v)
    })();
    let response = match result {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":public_error(&e)}),
    };
    let mut out = serde_json::to_vec(&response)?;
    if out.len() > RESPONSE_MAX {
        out = serde_json::to_vec(
            &json!({"ok":false,"error":"response too large; use a smaller page"}),
        )?;
    }
    out.push(b'\n');
    let mut sent=0;
    while sent<out.len() {
        let remaining=response_deadline.saturating_duration_since(std::time::Instant::now());
        ensure!(!remaining.is_zero(),"response timeout");
        ensure!(!s.quitting.load(Ordering::Acquire),"service stopped");
        stream.set_write_timeout(Some(remaining.min(Duration::from_millis(100))))?;
        match stream.write(&out[sent..]) {
            Ok(0)=>bail!("response closed"),
            Ok(n)=>sent+=n,
            Err(e) if matches!(e.kind(),std::io::ErrorKind::Interrupted|std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>continue,
            Err(e)=>return Err(e.into()),
        }
    }
    Ok(())
}
fn policy_scope(policy:&Value)->Value {
    json!({"projectId":policy.get("projectId").cloned().unwrap_or(Value::Null),"canCreateProjects":policy["canCreateProjects"].as_bool().unwrap_or(false)})
}
fn policy_fingerprint(policy:&Value)->String {
    format!("{:x}",Sha256::digest(json!([policy_scope(policy),policy["generation"]]).to_string().as_bytes()))
}
fn public_error(e: &anyhow::Error) -> String {
    let text = e.to_string();
    for safe in [
        "Pulso local storage budget reached",
        "unknown field",
        "unknown operation",
        "unauthorized",
        "session unavailable",
        "session is not live",
        "revision conflict",
        "stale board snapshot",
        "requestId reused with different body",
        "not found or not authorized",
        "id already exists",
        "request too large",
        "invalid JSON",
        "unsupported version",
        "empty grant scope",
        "project creation not authorized",
        "standalone items not authorized",
        "field not authorized",
        "session not authorized",
        "exactly one link target required",
        "service stopped",
        "limit must be 1..100",
        "invalid status",
    ] {
        if text == safe {
            return safe.into();
        }
    }
    "invalid request or storage unavailable".into()
}
fn live_session(v: &Value) -> Result<()> {
    ensure!(
        matches!(v["status"].as_str(), Some("starting" | "running")),
        "session is not live"
    );
    Ok(())
}
fn policy_context(v: &Value) -> Result<(String, PathBuf)> {
    let provider = v
        .get("provider")
        .or_else(|| v.get("kind"))
        .and_then(Value::as_str)
        .context("provider unavailable")?;
    ensure!(!provider.is_empty(), "provider unavailable");
    let cwd = fs::canonicalize(v["cwd"].as_str().context("cwd unavailable")?)?;
    ensure!(cwd.is_dir(), "cwd unavailable");
    Ok((provider.into(), cwd))
}
fn policy_key(v: &Value) -> Result<String> {
    let (provider, cwd) = policy_context(v)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(json!([provider, cwd]).to_string().as_bytes())
    ))
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn random() -> Result<String> {
    let mut b = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0, |d, (a, b)| d | (a ^ b)) == 0
}
fn fence(m: &fs::Metadata, regular: bool) -> Result<()> {
    ensure!(
        m.uid() == unsafe { libc::geteuid() }
            && !m.file_type().is_symlink()
            && (!regular || m.is_file())
            && m.nlink() == 1,
        "unsafe private path"
    );
    ensure!(
        m.mode() & 0o077 == 0,
        "private path permissions must be 0600/0700"
    );
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) => ensure!(
            m.is_dir()
                && !m.file_type().is_symlink()
                && m.uid() == unsafe { libc::geteuid() }
                && m.mode() & 0o077 == 0,
            "unsafe private directory"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
fn private_file(path: &Path, exclusive: bool) -> Result<File> {
    let mut o = OpenOptions::new();
    o.read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    if exclusive {
        o.create_new(true);
    } else {
        o.create(true);
    }
    let f = o.open(path)?;
    fence(&f.metadata()?, true)?;
    Ok(f)
}
fn identity(p: &Path) -> Result<(PathBuf, u64, u64)> {
    let m = fs::symlink_metadata(p)?;
    Ok((p.into(), m.dev(), m.ino()))
}
fn cleanup(owned: &[(PathBuf, u64, u64)]) {
    for (p, dev, ino) in owned {
        if let Ok(m) = fs::symlink_metadata(p) {
            if m.dev() == *dev && m.ino() == *ino {
                let _ = fs::remove_file(p);
            }
        }
    }
}
fn remove_handle(dir: &Path, sid: &str, token: &str) {
    let p = dir.join(format!("{sid}.json"));
    if let Ok(m) = fs::symlink_metadata(&p) {
        if fence(&m, true).is_ok() {
            if let Ok(b) = fs::read(&p) {
                if let Ok(v) = serde_json::from_slice::<Value>(&b) {
                    if v["token"].as_str().is_some_and(|t| constant_eq(t, token)) {
                        let _ = fs::remove_file(p);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    struct Fixture {
        _root: TempDir,
        data: PathBuf,
        sock: PathBuf,
        live: Arc<AtomicBool>,
        service: Arc<Service>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("data");
            let sock = root.path().join("socket");
            let live = Arc::new(AtomicBool::new(true));
            let l = live.clone();
            let cwd = root.path().to_owned();
            let service=Service::start(&data,&sock,Arc::new(move|sid|Some(json!({"id":sid,"status":if l.load(Ordering::Acquire){"running"}else{"exited"},"kind":"claude","cwd":cwd})))).unwrap();
            Self {
                _root: root,
                data,
                sock,
                live,
                service,
            }
        }
        fn ui(&self, op: &str, a: Value) -> Result<Value> {
            self.service
                .shared
                .dispatch(&json!({"version":1,"token":self.service.shared.ui,"op":op,"args":a}))
        }
        fn grant(&self) -> String {
            self.ui("grant", json!({"sessionId":"s1","canCreateProjects":true}))
                .unwrap();
            serde_json::from_slice::<Value>(
                &fs::read(self.data.join("pulso-grants/s1.json")).unwrap(),
            )
            .unwrap()["token"]
                .as_str()
                .unwrap()
                .into()
        }
        fn agent(&self, t: &str, op: &str, a: Value) -> Result<Value> {
            self.service
                .shared
                .dispatch(&json!({"version":1,"token":t,"op":op,"args":a}))
        }
    }
    #[test]
    fn retries_conflicts_and_immutable_audit() {
        let f = Fixture::new();
        let a = json!({"id":"p","requestId":"r1","title":"Plan"});
        let p = f.ui("project_create", a.clone()).unwrap();
        assert_eq!(p, f.ui("project_create", a).unwrap());
        assert!(
            f.ui(
                "project_create",
                json!({"id":"p","requestId":"r1","title":"Changed"})
            )
            .is_err()
        );
        let i = f
            .ui(
                "item_create",
                json!({"id":"i","requestId":"r2","title":"Item","projectId":"p"}),
            )
            .unwrap();
        let rev = i["item"]["revision"].clone();
        assert!(
            f.ui(
                "item_update",
                json!({"id":"i","requestId":"r3","expectedRevision":0,"status":"done"})
            )
            .is_err()
        );
        let updated=f.ui("checkpoint_create",json!({"id":"c","requestId":"r4","itemId":"i","expectedRevision":rev,"brief":"Work","nextAction":"Finish"})).unwrap();
        assert_ne!(updated["item"]["revision"], rev);
        assert_eq!(
            f.ui("activity", json!({"itemId":"i"})).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn scope_before_pagination_and_closed_session() {
        let f = Fixture::new();
        f.ui(
            "project_create",
            json!({"id":"a-secret","requestId":"ui1","title":"Secret"}),
        )
        .unwrap();
        let t = f.grant();
        f.agent(
            &t,
            "project_create",
            json!({"id":"z-own","requestId":"a1","title":"Own"}),
        )
        .unwrap();
        let v = f
            .agent(&t, "projects", json!({"limit":1,"cursor":0}))
            .unwrap();
        assert_eq!(v["projects"].as_array().unwrap().len(), 1);
        assert_eq!(v["projects"][0]["id"], "z-own");
        assert_eq!(v["hasMore"], false);
        assert!(f.agent(&t, "project", json!({"id":"a-secret"})).is_err());
        assert!(
            f.agent(
                &t,
                "item_create",
                json!({"id":"i","requestId":"a2","title":"Standalone"})
            )
            .is_err()
        );
        f.live.store(false, Ordering::Release);
        assert!(f.agent(&t, "revision", json!({})).is_err());
        assert!(
            f.ui("grant", json!({"sessionId":"s1","canCreateProjects":true}))
                .is_err()
        );
    }
    #[test]
    fn refresh_keeps_receipts_and_revoke_never_waits_for_store() {
        let f = Fixture::new();
        let old = f.grant();
        let a = json!({"id":"own","requestId":"same","title":"Own"});
        let v = f.agent(&old, "project_create", a.clone()).unwrap();
        assert_eq!(v["project"]["mainSessionId"], "s1");
        let new = f.grant();
        assert_ne!(old, new);
        assert!(f.agent(&old, "revision", json!({})).is_err());
        assert_eq!(v, f.agent(&new, "project_create", a).unwrap());
        let lock = f.service.shared.state.lock().unwrap();
        f.service.revoke_session("s1").unwrap();
        assert!(f.agent(&new, "revision", json!({})).is_err());
        drop(lock);
    }
    #[test]
    fn concurrent_expected_revision_has_one_winner() {
        let f = Fixture::new();
        let p = f
            .ui(
                "project_create",
                json!({"id":"p","requestId":"r","title":"P"}),
            )
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut jobs = Vec::new();
        for n in 0..2 {
            let s = f.service.clone();
            let b = barrier.clone();
            let rev = p["project"]["revision"].clone();
            jobs.push(thread::spawn(move||{b.wait();s.shared.dispatch(&json!({"version":1,"token":s.shared.ui,"op":"project_update","args":{"id":"p","requestId":format!("r{n}"),"expectedRevision":rev,"title":"Changed"}})).is_ok()}));
        }
        barrier.wait();
        assert_eq!(
            jobs.into_iter()
                .filter_map(|h| h.join().ok())
                .filter(|ok| *ok)
                .count(),
            1
        );
    }
    #[test]
    fn permissions_socket_ownership_and_shutdown() {
        let f = Fixture::new();
        let token = f.grant();
        for path in [
            f.sock.join("pulso.sock"),
            f.sock.join("pulso.token"),
            f.data.join("pulso.sqlite"),
            f.data.join("pulso-grants/s1.json"),
        ] {
            assert_eq!(fs::symlink_metadata(path).unwrap().mode() & 0o777, 0o600);
        }
        assert!(Service::start(&f.data, &f.sock, Arc::new(|_| None)).is_err());
        assert!(f.agent(&token, "grant", json!({"sessionId":"s2"})).is_err());
        f.service.shutdown();
        assert!(!f.sock.join("pulso.sock").exists());
        assert!(!f.data.join("pulso-grants/s1.json").exists());
        assert!(f.agent(&token, "revision", json!({})).is_err());
    }
    #[test]
    fn corruption_and_future_schema_preserved() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path().join("bad");
        fs::write(&p, b"not a database").unwrap();
        assert!(store::Store::open(&p).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"not a database");
        let future = root.path().join("future");
        let c = rusqlite::Connection::open(&future).unwrap();
        c.execute_batch("PRAGMA application_id=1347767379; PRAGMA user_version=2;")
            .unwrap();
        drop(c);
        assert!(store::Store::open(&future).is_err());
    }
    #[test]
    fn wire_limits_and_unknown_claims() {
        use std::io::BufRead;
        let f = Fixture::new();
        let t = f.grant();
        assert!(f.agent(&t, "projects", json!({"actor":"ui"})).is_err());
        let mut stream = UnixStream::connect(f.sock.join("pulso.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let bytes = vec![b'x'; REQUEST_MAX + 1];
        let _ = stream.write_all(&bytes);
        let _ = stream.write_all(b"\n");
        let mut line = String::new();
        let _ = std::io::BufReader::new(stream).read_line(&mut line);
        if !line.is_empty() {
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["ok"], false);
            assert!(!line.contains(&t));
        }
    }
    #[test]
    fn symlinks_and_hardlinks_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        fs::write(&target, b"safe").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(private_file(&link, false).is_err());
        fs::remove_file(&link).unwrap();
        fs::hard_link(&target, &link).unwrap();
        assert!(private_file(&link, false).is_err());
        assert_eq!(fs::read(target).unwrap(), b"safe");
    }

    #[test]
    fn remembered_policy_has_trusted_context_and_emits_fresh_grants() {
        let f = Fixture::new();
        let grant = f
            .ui(
                "grant",
                json!({"sessionId":"s1","canCreateProjects":true,"remember":true}),
            )
            .unwrap();
        assert!(grant["policyId"].is_string());
        let policies = f.ui("policies", json!({})).unwrap();
        assert_eq!(policies["policies"][0]["policy"]["provider"], "claude");
        assert!(policies["policies"][0]["policy"]["cwd"].is_string());
        f.service.auto_grant(&json!({"id":"s2"})).unwrap();
        let path = f.data.join("pulso-grants/s2.json");
        let credential: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let token = credential["token"].as_str().unwrap();
        assert!(f.agent(token, "projects", json!({})).is_ok());
        assert!(f.agent(token, "policies", json!({})).is_err());
        f.ui("revoke_policy", json!({"id":grant["policyId"]}))
            .unwrap();
        f.service.auto_grant(&json!({"id":"s3"})).unwrap();
        assert!(f.data.join("pulso-grants/s3.json").exists());
        f.live.store(false, Ordering::Release);
        assert!(f.service.auto_grant(&json!({"id":"s4"})).is_err());
    }
    #[test]
    fn new_agent_sessions_get_all_projects_until_global_access_is_disabled() {
        let f=Fixture::new();
        for id in ["alpha","beta"] {
            f.ui("project_create",json!({"id":id,"requestId":id,"title":id})).unwrap();
        }
        f.ui("item_create",json!({"id":"private-note","requestId":"private-note","title":"Standalone"})).unwrap();
        f.service.auto_grant(&json!({"id":"s1"})).unwrap();
        let path=f.data.join("pulso-grants/s1.json");
        let credential:Value=serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let token=credential["token"].as_str().unwrap();
        let projects=f.agent(token,"projects",json!({})).unwrap();
        assert_eq!(projects["projects"].as_array().unwrap().len(),2);
        assert!(f.agent(token,"project",json!({"id":"beta"})).is_ok());
        assert_eq!(f.agent(token,"items",json!({})).unwrap()["totalCount"],0);
        assert!(f.agent(token,"item",json!({"id":"private-note"})).is_err());
        assert!(f.agent(token,"activity",json!({"projectId":null})).is_err());
        assert!(f.agent(token,"project_create",json!({"id":"gamma","requestId":"gamma","title":"Gamma"})).is_ok());
        f.service.set_auto_enabled(false);
        assert!(f.agent(token,"project",json!({"id":"alpha"})).is_err());
        f.ui("grant",json!({"sessionId":"manual","projectId":"alpha"})).unwrap();
        let manual:Value=serde_json::from_slice(&fs::read(f.data.join("pulso-grants/manual.json")).unwrap()).unwrap();
        assert!(f.agent(manual["token"].as_str().unwrap(),"project",json!({"id":"alpha"})).is_ok());
        f.service.auto_grant(&json!({"id":"s2"})).unwrap();
        assert!(!f.data.join("pulso-grants/s2.json").exists());
        f.service.set_auto_enabled(true);
        f.service.auto_grant(&json!({"id":"s2"})).unwrap();
        assert!(f.data.join("pulso-grants/s2.json").exists());
    }
    #[test]
    fn structured_resume_replaces_a_revoked_generation_credential() {
        let f=Fixture::new();
        f.service.auto_grant(&json!({"id":"s1"})).unwrap();
        let path=f.data.join("pulso-grants/s1.json");
        let old:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        f.service.revoke_session("s1").unwrap();
        assert!(f.agent(old["token"].as_str().unwrap(),"projects",json!({})).is_err());
        f.service.auto_grant_resume(&json!({"id":"s1"})).unwrap();
        let new:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_ne!(old["token"],new["token"]);
        assert!(f.agent(new["token"].as_str().unwrap(),"projects",json!({})).is_ok());
    }
    #[test]
    fn structured_resume_never_widens_an_explicit_manual_scope() {
        let f=Fixture::new();
        for id in ["one","two"] {f.ui("project_create",json!({"id":id,"requestId":id,"title":id})).unwrap();}
        f.ui("grant",json!({"sessionId":"s1","projectId":"one"})).unwrap();
        let path=f.data.join("pulso-grants/s1.json");
        let old:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        f.service.revoke_session("s1").unwrap();
        f.service.auto_grant_resume(&json!({"id":"s1"})).unwrap();
        let unchanged:Value=serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(unchanged["token"],old["token"]);
        assert!(f.agent(old["token"].as_str().unwrap(),"project",json!({"id":"two"})).is_err());
    }
    #[test]
    fn narrowed_scope_does_not_replay_receipts_from_removed_project() {
        let f = Fixture::new();
        for id in ["a", "b"] {
            f.ui("project_create", json!({"id":id,"requestId":id,"title":id}))
                .unwrap();
        }
        f.ui("grant", json!({"sessionId":"s1","projectId":"a"}))
            .unwrap();
        let credential: Value =
            serde_json::from_slice(&fs::read(f.data.join("pulso-grants/s1.json")).unwrap())
                .unwrap();
        let a = json!({"id":"i","requestId":"work","title":"Private","projectId":"a"});
        f.agent(
            credential["token"].as_str().unwrap(),
            "item_create",
            a.clone(),
        )
        .unwrap();
        f.service.revoke_session("s1").unwrap();
        f.ui("grant", json!({"sessionId":"s1","projectId":"b"}))
            .unwrap();
        let credential: Value =
            serde_json::from_slice(&fs::read(f.data.join("pulso-grants/s1.json")).unwrap())
                .unwrap();
        assert!(
            f.agent(credential["token"].as_str().unwrap(), "item_create", a)
                .is_err()
        );
        assert!(
            f.agent(
                credential["token"].as_str().unwrap(),
                "project",
                json!({"id":"a"})
            )
            .is_err()
        );
    }
    #[test]
    fn corrupt_existing_document_cannot_be_replaced_by_create() {
        let f = Fixture::new();
        {
            let state = f.service.shared.state.lock().unwrap();
            // Simulate a corrupted legacy document before JSON expression
            // indexes existed. Normal inserts now reject malformed JSON earlier.
            state.store.0.execute_batch("DROP INDEX pulso_docs_item; DROP INDEX pulso_docs_project;").unwrap();
            state
                .store
                .0
                .execute("INSERT INTO docs VALUES('project','broken','not-json')", [])
                .unwrap();
        }
        assert!(
            f.ui(
                "project_create",
                json!({"id":"broken","requestId":"repair","title":"Cannot replace"})
            )
            .is_err()
        );
        let state = f.service.shared.state.lock().unwrap();
        let body: String = state
            .store
            .0
            .query_row("SELECT body FROM docs WHERE id='broken'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "not-json");
    }

    #[test]
    fn restart_invalidates_old_credentials_but_preserves_session_receipts() {
        let f = Fixture::new();
        let token = f.grant();
        let args =
            json!({"id":"restart-project","requestId":"restart-request","title":"Persistent"});
        let expected = f.agent(&token, "project_create", args.clone()).unwrap();
        let Fixture {
            _root,
            data,
            sock,
            live: _,
            service,
        } = f;
        let lookup = service.shared.lookup.clone();
        service.shutdown();
        drop(service);
        let service = Service::start(&data, &sock, lookup).unwrap();
        assert!(
            service
                .shared
                .dispatch(&json!({"version":1,"token":token,"op":"revision","args":{}}))
                .is_err()
        );
        let grant=service.shared.dispatch(&json!({"version":1,"token":service.shared.ui,"op":"grant","args":{"sessionId":"s1","canCreateProjects":true}})).unwrap();
        let credential: Value =
            serde_json::from_slice(&fs::read(grant["handle"].as_str().unwrap()).unwrap()).unwrap();
        let actual = service
            .shared
            .dispatch(
                &json!({"version":1,"token":credential["token"],"op":"project_create","args":args}),
            )
            .unwrap();
        assert_eq!(expected, actual);
        drop(service);
        drop(_root);
    }
    #[test]
    fn responses_are_bounded_and_small_pages_remain_available() {
        use std::io::BufRead;
        let f = Fixture::new();
        for n in 0..18 {
            f.ui("project_create",json!({"id":format!("large{n}"),"requestId":format!("large{n}"),"title":"Large","plan":"x".repeat(32000)})).unwrap();
        }
        let mut stream = UnixStream::connect(f.sock.join("pulso.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(
            stream,
            "{}",
            json!({"version":1,"token":f.service.shared.ui,"op":"projects","args":{}})
        )
        .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut line)
            .unwrap();
        assert!(line.len() <= RESPONSE_MAX + 1);
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["ok"], true);
        assert!(reply["result"]["projects"].as_array().unwrap().iter().all(|p|p["plan"]==""));
        assert_eq!(f.ui("project",json!({"id":"large0"})).unwrap()["project"]["plan"].as_str().unwrap().len(),32000);
        let page = f.ui("projects", json!({"limit":1})).unwrap();
        assert_eq!(page["nextCursor"], 1);
        assert_eq!(page["hasMore"], true);
        assert!(f.ui("projects", json!({"limit":101})).is_err());
        assert!(
            f.ui(
                "project_create",
                json!({"id":"oversize","requestId":"oversize","title":"x".repeat(241)})
            )
            .is_err()
        );
    }
    #[test]
    fn revoking_a_remembered_policy_cuts_its_live_grant() {
        let f=Fixture::new();
        let grant=f.ui("grant",json!({"sessionId":"s1","canCreateProjects":true,"remember":true})).unwrap();
        let token:Value=serde_json::from_slice(&fs::read(grant["handle"].as_str().unwrap()).unwrap()).unwrap();
        f.agent(token["token"].as_str().unwrap(),"project_create",json!({"id":"kept","requestId":"new","title":"Kept"})).unwrap();
        f.ui("revoke_policy",json!({"id":grant["policyId"]})).unwrap();
        assert!(f.agent(token["token"].as_str().unwrap(),"project",json!({"id":"kept"})).is_err());
        assert_eq!(f.ui("project",json!({"id":"kept"})).unwrap()["project"]["title"],"Kept");
    }
    #[test]
    fn automatic_policy_cannot_reactivate_a_revoked_session() {
        let f=Fixture::new();
        f.ui("grant",json!({"sessionId":"s1","canCreateProjects":true,"remember":true})).unwrap();
        f.service.revoke_session("s1").unwrap();
        assert!(f.service.auto_grant(&json!({"id":"s1"})).is_err());
    }
    #[test]
    fn shutdown_is_idempotent_and_does_not_remove_replacement_endpoints() {
        let f=Fixture::new();f.service.shutdown();
        let replacement=Service::start(&f.data,&f.sock,f.service.shared.lookup.clone()).unwrap();
        let token=fs::read(f.sock.join("pulso.token")).unwrap();
        f.service.shutdown();
        assert_eq!(fs::read(f.sock.join("pulso.token")).unwrap(),token);
        assert!(UnixStream::connect(f.sock.join("pulso.sock")).is_ok());
        replacement.shutdown();
    }

    #[test]
    fn recreating_a_policy_never_revives_previously_revoked_tokens() {
        let f=Fixture::new();
        let old=f.ui("grant",json!({"sessionId":"s1","canCreateProjects":true,"remember":true})).unwrap();
        let token:Value=serde_json::from_slice(&fs::read(old["handle"].as_str().unwrap()).unwrap()).unwrap();
        let token=token["token"].as_str().unwrap();
        f.agent(token,"project_create",json!({"id":"owned","requestId":"own","title":"Own"})).unwrap();
        f.ui("revoke_policy",json!({"id":old["policyId"]})).unwrap();
        f.ui("grant",json!({"sessionId":"s2","canCreateProjects":true,"remember":true})).unwrap();
        assert!(f.agent(token,"project",json!({"id":"owned"})).is_err());
        assert_eq!(f.ui("project",json!({"id":"owned"})).unwrap()["project"]["title"],"Own");
    }
    #[test]
    fn a_slow_reader_has_a_total_response_deadline() {
        let f=Fixture::new();
        f.ui("project_create",json!({"id":"p","requestId":"p","title":"Load"})).unwrap();
        for n in 0..100 {f.ui("item_create",json!({"id":format!("n{n}"),"requestId":format!("n{n}"),"projectId":"p","title":"Phase","note":"é".repeat(1000)})).unwrap();}
        let (server,mut client)=UnixStream::pair().unwrap();
        let bytes:libc::c_int=4096;
        assert_eq!(unsafe{libc::setsockopt(server.as_raw_fd(),libc::SOL_SOCKET,libc::SO_SNDBUF,&bytes as *const _ as *const _,std::mem::size_of_val(&bytes) as _)},0);
        let shared=f.service.shared.clone();let (tx,rx)=std::sync::mpsc::channel();
        let worker=thread::spawn(move||{let result=serve(&shared,server);let _=tx.send(result.is_err());});
        writeln!(client,"{}",json!({"version":1,"token":f.service.shared.ui,"op":"items","args":{"projectId":"p","limit":100}})).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(4)).expect("unbounded slow-reader worker"));
        worker.join().unwrap();
    }

    #[test]
    fn checkpoint_history_is_paged_and_latest_continuity_is_preserved() {
        let f=Fixture::new();f.ui("project_create",json!({"id":"p","requestId":"p","title":"P"})).unwrap();
        let mut item=f.ui("item_create",json!({"id":"i","requestId":"i","projectId":"p","title":"Phase"})).unwrap()["item"].clone();
        for n in 0..12 {item=f.ui("checkpoint_create",json!({"id":format!("cp{n}"),"requestId":format!("cp{n}"),"itemId":"i","expectedRevision":item["revision"],"brief":format!("Point {n}"),"nextAction":"Next"})).unwrap()["item"].clone();}
        let detail=f.ui("item",json!({"id":"i"})).unwrap();assert_eq!(detail["checkpoints"].as_array().unwrap().len(),10);assert_eq!(detail["checkpointsHasMore"],true);
        assert_eq!(detail["checkpoints"].as_array().unwrap().last().unwrap()["brief"],"Point 11");
        let older=f.ui("checkpoint_history",json!({"itemId":"i","cursor":10,"limit":10})).unwrap();assert_eq!(older["checkpoints"].as_array().unwrap().len(),2);assert_eq!(older["hasMore"],false);
        assert!(f.ui("checkpoint_history",json!({"itemId":"i","limit":11})).is_err());
    }
    #[test]
    fn storage_budget_rolls_back_writes_but_preserves_receipt_recovery() {
        let f=Fixture::new();let args=json!({"id":"kept","requestId":"kept","title":"Kept"});let original=f.ui("project_create",args.clone()).unwrap();
        let before=f.ui("revision",json!({})).unwrap();
        f.service.shared.state.lock().unwrap().store.0.execute("UPDATE pulso_budget SET bytes=? WHERE id=1",[64*1024*1024]).unwrap();
        assert!(f.ui("project_create",json!({"id":"blocked","requestId":"blocked","title":"Blocked"})).is_err());
        assert_eq!(f.ui("project_create",args).unwrap(),original);
        assert!(f.ui("project",json!({"id":"blocked"})).is_err());
        assert_eq!(f.ui("revision",json!({})).unwrap(),before);
    }

    #[test]
    fn failed_permission_storage_preserves_existing_handle() {
        let f=Fixture::new();
        let token=f.grant();
        let path=f.data.join("pulso-grants/s1.json");
        let before=fs::read(&path).unwrap();
        f.service.shared.state.lock().unwrap().store.0.execute("UPDATE pulso_budget SET bytes=? WHERE id=1",[65*1024*1024]).unwrap();
        assert!(f.ui("grant",json!({"sessionId":"s1","canCreateProjects":true,"remember":true})).is_err());
        assert_eq!(fs::read(path).unwrap(),before);
        assert!(f.agent(&token,"projects",json!({})).is_ok());
    }
    #[test]
    fn permission_and_revocation_remain_available_at_data_budget() {
        let f=Fixture::new();
        f.ui("project_create",json!({"id":"p","requestId":"p","title":"Plan"})).unwrap();
        f.service.shared.state.lock().unwrap().store.0.execute("UPDATE pulso_budget SET bytes=?,rows=? WHERE id=1",params![64*1024*1024,100_000]).unwrap();
        let grant=f.ui("grant",json!({"sessionId":"s2","projectId":"p","remember":true})).unwrap();
        let handle:Value=serde_json::from_slice(&fs::read(f.data.join("pulso-grants/s2.json")).unwrap()).unwrap();
        assert!(f.agent(handle["token"].as_str().unwrap(),"project",json!({"id":"p"})).is_ok());
        f.ui("revoke_policy",json!({"id":grant["policyId"]})).unwrap();
        assert!(f.agent(handle["token"].as_str().unwrap(),"project",json!({"id":"p"})).is_err());
    }

    #[test]
    fn board_endpoint_is_ui_only_and_does_not_expand_agent_scope() {
        let f=Fixture::new();
        f.ui("project_create",json!({"id":"board","requestId":"board","title":"Board"})).unwrap();
        let token=f.grant();
        assert_eq!(f.ui("board",json!({"projectId":"board"})).unwrap()["columns"]["todo"]["totalCount"],0);
        assert!(f.agent(&token,"board",json!({"projectId":null})).is_err());
        assert!(f.agent(&token,"board",json!({"projectId":"board"})).is_err());
    }

    #[test]
    fn sidebar_summary_is_ui_only_over_the_socket() {
        use std::io::BufRead;
        let f=Fixture::new();
        f.ui("project_create",json!({"id":"p","requestId":"p","title":"P"})).unwrap();
        let token=f.grant();
        let summary=f.ui("sidebar_summary",json!({})).unwrap();
        assert_eq!(summary["projects"][0]["id"],"p");
        assert_eq!(f.agent(&token,"sidebar_summary",json!({})).unwrap_err().to_string(),"unauthorized");
        assert_eq!(f.agent(&token,"sidebar_summary",json!({"ifRevision":summary["revision"]})).unwrap_err().to_string(),"unauthorized");
        assert_eq!(f.ui("sidebar_summary",json!({"projectId":"p"})).unwrap_err().to_string(),"unknown field");
        // Over the wire the agent sees only the public error.
        let mut stream=UnixStream::connect(f.sock.join("pulso.sock")).unwrap();
        writeln!(stream,"{}",json!({"version":1,"token":token,"op":"sidebar_summary","args":{}})).unwrap();
        let mut line=String::new();std::io::BufReader::new(stream).read_line(&mut line).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(),json!({"ok":false,"error":"unauthorized"}));
    }


    /// Every Pulso payload the app sends (desktop/tests/fixtures/rpc-contract.json)
    /// is accepted by the runner: run in order on a fresh store, each one succeeds
    /// or, for the fixed synthetic revisions, fails only the revision check
    /// (which runs after every field was parsed).
    #[test]
    fn every_pulso_payload_the_app_sends_is_accepted() {
        let f = Fixture::new();
        let contract: Value = serde_json::from_str(include_str!("../../desktop/tests/fixtures/rpc-contract.json")).unwrap();
        let mut failures = Vec::new();
        for entry in contract["pulso"].as_array().unwrap() {
            let op = entry["op"].as_str().unwrap();
            match f.ui(op, entry["args"].clone()) {
                Err(error) if error.to_string() != "revision conflict" => failures.push(format!("{op} {}: {error}", entry["args"])),
                _ => {}
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }
}

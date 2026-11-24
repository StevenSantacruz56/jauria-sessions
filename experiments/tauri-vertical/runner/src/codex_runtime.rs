//! Single owned connection actor. No inference during boot, replay or recovery.
//! The parent owns admission claims, registration, joins and resource fences.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::{HashMap,HashSet}, io::Read, path::PathBuf, sync::{Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering}, mpsc::{self, Receiver, SyncSender, TryRecvError}},
    time::{Duration, Instant}};
use crate::{codex_protocol::{self as codec, Approval, ApprovalKind, Incoming, RpcId},
    codex_store as ledger, codex_transport::Process, storage::Store};

pub enum Intent {
    Start { claim: Value, prompt: String, command_id: String },
    Interrupt { identity: Value },
    Permission { request: Value, decision: String },
}
#[derive(Clone)]
pub struct Control { pub stop: Arc<AtomicBool>, pub ready:Arc<AtomicBool>, pub tx: SyncSender<Intent>, pub generation: i64,
    /// Runner attention ledger; told only about newly inserted permission requests.
    pub attention: Option<Arc<crate::agent_attention::Attention>>,
    /// PID of the provider process last spawned for this session (0: none).
    /// A label for telemetry attribution only; never signal or trust it.
    pub pid: Arc<AtomicU32> }
pub fn channel(generation: i64) -> (Control, Receiver<Intent>) {
    let (tx, rx) = mpsc::sync_channel(32);
    (Control { stop: Arc::new(AtomicBool::new(false)), ready:Arc::new(AtomicBool::new(false)), tx, generation, attention: None, pid: Arc::new(AtomicU32::new(0)) }, rx)
}
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| anyhow::anyhow!("Actor mutex poisoned"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty()).context("Missing actor identity")
}
fn rpc_value(id: &RpcId) -> Value {
    match id { RpcId::String(s) => json!(s), RpcId::Number(n) => json!(n) }
}
fn verify_local_environment(reply:&Value,cwd:&std::path::Path)->Result<()> {
    let expected=cwd.to_str().context("Non UTF-8 local directory")?;
    let envs=reply["thread"]["environments"].as_array().context("Native local environment binding missing")?;
    ensure!(envs.len()==1 && envs[0]["environmentId"]=="local" && envs[0]["cwd"]==expected,"Native environment is not the requested local directory");
    let roots=&envs[0]["runtimeWorkspaceRoots"];
    ensure!(roots==&json!([expected]),"Native workspace roots differ from local task");Ok(())
}
fn identity(v: &Value) -> Result<Value> {
    let v = if v.get("result").is_some() { &v["result"] } else { v };
    Ok(json!({"sessionId":text(v,"sessionId")?,"turnId":text(v,"turnId")?,
        "attemptId":text(v,"attemptId")?,"generation":v["generation"].as_i64().context("Missing generation")?}))
}
fn uuid() -> Result<String> {
    let mut b = [0u8; 16]; std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    let h: String = b.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}
// Raw config/account responses live only on the stack. Missing configuration is
// unsafe: an explicit effective MCP table is required even when empty.
fn servers(v: &Value, disabled: bool, pulso: Option<&crate::pulso_mcp_config::PulsoMcp>) -> Result<Vec<String>> {
    let table = v.pointer("/config/mcp_servers").and_then(Value::as_object)
        .context("Effective MCP table unavailable")?;
    ensure!(table.len() <= 64, "MCP server quota");
    for (name, entry) in table {
        ensure!(!name.is_empty() && name.len() <= 256 && !name.contains('\0'), "Invalid MCP name");
        if disabled {
            if name=="jauria-pulso" && pulso.is_some() {
                let pulso=pulso.unwrap();
                ensure!(entry["enabled"]==true
                    && entry["command"].as_str()==pulso.runner.to_str()
                    && entry["args"]==json!(["--pulso-mcp"])
                    && entry["env"].as_object().is_some_and(|env|env.len()==1)
                    && entry["env"]["JAURIA_PULSO_HANDLE"].as_str()==pulso.handle.to_str(),
                    "Jauria Pulso MCP configuration differs from the owned session");
            } else { ensure!(entry["enabled"] == false, "MCP server not explicitly disabled"); }
        }
    }
    if disabled && pulso.is_some() {ensure!(table.contains_key("jauria-pulso"),"Jauria Pulso MCP unavailable");}
    Ok(table.keys().cloned().collect())
}
fn spawn(admission: &Mutex<()>, control: &Control, cwd: &std::path::Path,
    names: Option<&[String]>, pulso: Option<&crate::pulso_mcp_config::PulsoMcp>) -> Result<Process> {
    let _guard = lock(admission)?;
    ensure!(!control.stop.load(Ordering::Acquire), "Actor stopped before fork");
    let process = match names { Some(names) => Process::codex_with_pulso(cwd, names, pulso), None => Process::codex(cwd) }?;
    control.pid.store(process.pid(), Ordering::Release);
    Ok(process)
}
fn boot_rpc(p: &mut Process, c: &Control, end: Instant, id: u64, method: &str, params: Value) -> Result<Value> {
    ensure!(Instant::now() < end && !c.stop.load(Ordering::Acquire), "Boot stopped or expired");
    let mut thread = params["threadId"].as_str().map(str::to_owned);
    p.send_packet(&codec::request(id, method, params)?)?;
    let ack = end.min(Instant::now() + Duration::from_secs(10));
    loop {
        ensure!(!c.stop.load(Ordering::Acquire) && Instant::now() < ack, "Boot ACK stopped or expired");
        match p.receive()? {
            Some(Incoming::Response { id: RpcId::Number(n), result }) if n == id => {
                if let Some(thread) = &thread { ensure!(result["thread"]["id"] == *thread, "Boot thread mismatch"); }
                return Ok(result);
            }
            Some(Incoming::Error { .. }) => bail!("Boot RPC rejected"),
            Some(ref incoming @ Incoming::Request { ref id, .. }) => {
                let bytes = match codec::parse_approval(incoming) {
                    Ok(a) => codec::deny_reply(&a)?, Err(_) => codec::unsupported_reply(id)?,
                }; p.send_packet(&bytes)?;
            }
            Some(Incoming::Notification { method, params }) => {
                ensure!(method != "error" && !method.starts_with("turn/") && !method.starts_with("item/"), "Unexpected boot activity");
                if let Some(event) = codec::normalize_event(&method, &params)? {
                    let v = &event["params"];
                    let observed = if method == "thread/started" { v["thread"]["id"].as_str() } else { v["threadId"].as_str() };
                    if let Some(observed) = observed {
                        ensure!(thread.as_deref().is_none_or(|old| old == observed), "Boot notification thread mismatch");
                        thread = Some(observed.to_owned());
                    }
                    ensure!(v["status"]["type"] != "systemError", "Provider boot system error");
                }
            }
            Some(_) => bail!("Unexpected boot response"),
            None => { ensure!(!p.leader_exited()?, "Provider exited during boot"); std::thread::sleep(Duration::from_millis(2)); }
        }
    }
}
fn initialize(p: &mut Process, c: &Control, end: Instant) -> Result<()> {
    boot_rpc(p,c,end,1,"initialize",json!({"clientInfo":{"name":"jauria","version":"0.1.0"},"capabilities":{"experimentalApi":false}}))?;
    p.send_packet(&codec::initialized()?)
}
struct Turn { identity: Value, command: String, native: Option<String>, terminal: bool,
    acked: bool, cancelled: bool, interrupt_sent: bool, native_started:bool, ready_notified:bool }
struct Pending { method: &'static str, deadline: Instant }
struct Actor<'a> {
    db: &'a Mutex<Store>, control: &'a Control, sid: &'a str, thread: String,
    next: u64, pending: HashMap<u64, Pending>, retired_interrupts:HashSet<u64>, approvals: HashMap<String, Approval>, turn: Option<Turn>,
}
impl Actor<'_> {
    fn event(&self, mut event: Value) -> Result<()> {
        event["generation"] = json!(self.control.generation);
        if let Some(t) = &self.turn {
            event["turnId"] = t.identity["turnId"].clone(); event["attemptId"] = t.identity["attemptId"].clone();
        }
        lock(self.db)?.provider_event(self.sid, &event)?; Ok(())
    }
    fn advertise_ready(&mut self){
        if let Some(turn)=self.turn.as_mut(){
            if turn.terminal && turn.acked && !turn.ready_notified {
                turn.ready_notified=true;
                if !self.control.stop.load(Ordering::Acquire){self.control.ready.store(true,Ordering::Release);}
            }
        }
    }
    fn send(&mut self, p: &mut Process, method: &'static str, params: Value) -> Result<()> {
        self.next = self.next.checked_add(1).context("RPC id exhausted")?;
        let bytes = codec::request(self.next, method, params)?;
        self.pending.insert(self.next, Pending { method, deadline: Instant::now()+Duration::from_secs(10) });
        p.send_packet(&bytes)
    }
    fn bind(&mut self, native: &str) -> Result<()> {
        let t = self.turn.as_mut().context("Unclaimed native turn")?;
        if let Some(old) = &t.native { ensure!(old == native, "Native turn conflict"); return Ok(()); }
        let mut binding = t.identity.clone(); binding["nativeTurnId"] = json!(native);
        ledger::bind_turn(&lock(self.db)?.0, &binding)?;
        t.native = Some(native.to_owned()); Ok(())
    }
    fn interrupt(&mut self, p: &mut Process) -> Result<()> {
        let t = self.turn.as_mut().context("Interrupt without claim")?;
        if t.terminal || t.interrupt_sent || !t.cancelled || !t.native_started { return Ok(()); }
        if let Some(native) = t.native.clone() {
            t.interrupt_sent = true; // Mark before any possibly partial write.
            self.send(p,"turn/interrupt",json!({"threadId":self.thread,"turnId":native}))?;
        } Ok(())
    }
    /// Known pre-delivery cancellation has no native effect. Settle it locally
    /// without sacrificing a healthy connection or leaving a claimed command.
    fn settle_unsent_cancelled(&mut self)->Result<bool>{
        let t=self.turn.as_ref().context("Missing claimed turn")?;
        if !t.cancelled && !self.control.stop.load(Ordering::Acquire){return Ok(false);}
        ensure!(t.native.is_none() && !t.acked,"Cannot classify a native turn as not sent");
        let mut end=t.identity.clone();end["status"]=json!("failed");end["nativeTurnId"]=Value::Null;
        {let db=lock(self.db)?;ledger::finish_turn(&db.0,&end)?;ledger::finish_command(&db.0,&json!({"commandId":t.command,"result":{"delivery":"not_sent","reason":"cancelled_before_delivery"}}))?;}
        let t=self.turn.as_mut().unwrap();t.terminal=true;t.acked=true;
        self.advertise_ready();
        self.event(json!({"method":"notice","params":{"text":"Turno cancelado antes del envío. No se inició una inferencia."}}))?;
        Ok(true)
    }
    fn approval_cancelled(&mut self,a:&Approval,db:&rusqlite::Connection)->Result<bool>{
        let t=self.turn.as_mut().context("Approval without claim")?;
        let scope=a.scope().context("Command scope absent")?;
        ensure!(scope.thread_id==self.thread && t.native.as_deref()==Some(scope.turn_id.as_str()),"Out of scope approval");
        let state=ledger::get_turn(db,text(&t.identity,"turnId")?)?;
        if state["status"]=="cancel_requested" {t.cancelled=true;}
        Ok(t.terminal || t.cancelled || self.control.stop.load(Ordering::Acquire) || !matches!(state["status"].as_str(),Some("running")))
    }
    fn intent(&mut self, p: &mut Process, intent: Intent) -> Result<()> {
        match intent {
            Intent::Start { claim, prompt, command_id } => {
                ensure!(self.turn.as_ref().is_none_or(|t| t.terminal && t.acked), "Overlapping turn claim");
                let id = identity(&claim)?;
                ensure!(id["sessionId"] == self.sid && id["generation"] == self.control.generation, "Stale start claim");
                let db = lock(self.db)?;
                let command = ledger::get_command(&db.0,&command_id)?;
                let stored = ledger::get_turn(&db.0,text(&id,"turnId")?)?;
                ensure!(command["state"] == "claimed" && command["result"] == id && stored["prompt"] == prompt,
                    "Start is not the durable claim");
                ensure!(identity(&stored)? == id && matches!(stored["status"].as_str(),Some("running"|"cancel_requested")), "Start claim no longer live");
                self.turn = Some(Turn { identity:id, command:command_id, native:None, terminal:false,
                    acked:false, cancelled:stored["status"] == "cancel_requested", interrupt_sent:false,native_started:false,ready_notified:false });
                // The helper commits terminal evidence itself; do not retain this
                // guard while it accesses the same single writer mutex.
                drop(db);
                if self.settle_unsent_cancelled()?{return Ok(());}
                let db=lock(self.db)?;
                let current=ledger::get_turn(&db.0,text(&self.turn.as_ref().unwrap().identity,"turnId")?)?;
                if current["status"]=="cancel_requested"{drop(db);self.turn.as_mut().unwrap().cancelled=true;self.settle_unsent_cancelled()?;return Ok(());}
                if self.control.stop.load(Ordering::Acquire){drop(db);self.settle_unsent_cancelled()?;return Ok(());}
                self.send(p,"turn/start",json!({"threadId":self.thread,"input":[{"type":"text","text":prompt}],
                    "approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":{"type":"workspaceWrite","networkAccess":false}}))?;
                drop(db);
            }
            Intent::Interrupt { identity: id } => {
                let t = self.turn.as_mut().context("Interrupt without turn")?;
                ensure!(identity(&id)? == t.identity, "Stale interrupt");
                if t.terminal { return Ok(()); }
                ledger::cancel_turn(&lock(self.db)?.0,&t.identity)?;
                t.cancelled = true; self.approvals.clear(); self.interrupt(p)?;
            }
            Intent::Permission { request, decision } => {
                let rid = text(&request,"id")?;
                let Some(a) = self.approvals.remove(rid) else {
                    ledger::invalidate_request(&lock(self.db)?.0,rid,self.sid,self.control.generation)?;return Ok(());
                };
                let db = lock(self.db)?;
                let stored = ledger::get_request(&db.0,rid)?;
                let t = self.turn.as_ref().context("Permission without turn")?;
                let live = ledger::get_turn(&db.0,text(&t.identity,"turnId")?)?;
                let session = ledger::get_session(&db.0,self.sid)?;
                // Hold the DB mutex through this single bounded write, serializing
                // the final check with parent cancellation/permission mutations.
                if self.control.stop.load(Ordering::Acquire) || t.terminal || t.cancelled || live["status"] != "running"
                    || session["generation"] != self.control.generation || session["status"] != "running"
                    || stored["status"] != "answered" {
                    ledger::invalidate_request(&db.0,rid,self.sid,self.control.generation)?;return Ok(());
                }
                ensure!(identity(&stored)? == t.identity && identity(&request)? == t.identity
                    && stored["nativeRpcId"] == rpc_value(a.id()) && request["nativeRpcId"] == stored["nativeRpcId"]
                    && stored["decision"] == decision, "Permission identity conflict");
                let scope = a.scope().context("Permission scope missing")?;
                ensure!(scope.thread_id == self.thread && Some(scope.turn_id.as_str()) == t.native.as_deref()
                    && stored["payload"]["params"] == *a.presentation(), "Permission scope changed");
                let bytes = match decision.as_str() {
                    "accept" => codec::command_accept_reply(&a,scope)?,
                    "deny" => codec::deny_reply(&a)?, _ => bail!("Unsupported permission decision"),
                };
                p.send_packet(&bytes)?;
                ledger::mark_permission_delivered(&db.0,&json!({"id":stored["id"],"sessionId":stored["sessionId"],"turnId":stored["turnId"],"attemptId":stored["attemptId"],"generation":stored["generation"],"nativeRpcId":stored["nativeRpcId"]}))?;
            }
        } Ok(())
    }
    fn response(&mut self, id: RpcId, result: Option<Value>) -> Result<()> {
        let RpcId::Number(n) = id else { bail!("Unexpected response identity"); };
        if self.retired_interrupts.remove(&n){return Ok(());}
        let pending = self.pending.remove(&n).context("Unmatched native response")?;
        if pending.method == "turn/start" {
            if let Some(v) = result {
                let native = text(&v["turn"],"id")?; self.bind(native)?;
                let t = self.turn.as_mut().unwrap();
                ledger::finish_command(&lock(self.db)?.0,&json!({"commandId":t.command,"result":{"nativeTurnId":native}}))?;
                t.acked = true;
            } else {
                let t = self.turn.as_mut().context("Rejected unclaimed turn")?;
                ledger::finish_command(&lock(self.db)?.0,&json!({"commandId":t.command,"result":{"error":"native_start_rejected"}}))?;
                if !t.terminal {
                    let mut end = t.identity.clone(); end["nativeTurnId"] = json!(t.native); end["status"] = json!("failed");
                    ledger::finish_turn(&lock(self.db)?.0,&end)?; t.terminal = true;
                }
                bail!("Native start rejected");
            }
        } else if result.is_none() {
            // Rejection is not completion. Keep the durable cancellation fence,
            // await native terminal observation, and never resend the interrupt.
            self.event(json!({"method":"notice","params":{"text":"Codex no confirmó la interrupción. Esperando el estado final nativo; puedes detener la conexión. No se repite la solicitud."}}))?;
        }
        self.advertise_ready();Ok(())
    }
    fn request(&mut self, p: &mut Process, incoming: Incoming) -> Result<()> {
        let Incoming::Request { ref id, ref method, .. } = incoming else { unreachable!() };
        let a = match codec::parse_approval(&incoming) {
            Ok(a) => a, Err(_) => { p.send_packet(&codec::unsupported_reply(id)?)?; bail!("Malformed native approval"); }
        };
        if a.kind() != ApprovalKind::CommandExecution {
            p.send_packet(&codec::deny_reply(&a)?)?;
            return self.event(json!({"method":"notice","params":{"text":"Se rechazó una solicitud de herramienta no compatible con este adaptador."}}));
        }
        let db=lock(self.db)?;
        if self.approval_cancelled(&a,&db.0)? {
            drop(db);
            p.send_packet(&codec::deny_reply(&a)?)?;
            if self.turn.as_ref().is_some_and(|t|t.cancelled && !t.terminal){self.interrupt(p)?;}
            return Ok(());
        }
        let t=self.turn.as_ref().unwrap();
        ensure!(!self.approvals.values().any(|old| old.id() == id), "Duplicate native request");
        let rid = uuid()?;
        // Reparseable filtered params retain all scope, including approvalId;
        // no policy amendments or nested native metadata enter persistence.
        let payload = json!({"params":a.presentation()});
        ensure!(serde_json::to_vec(&payload)?.len() <= 16*1024, "Approval presentation exceeds 16 KiB");
        let mut row = t.identity.clone(); row["id"] = json!(rid); row["nativeRpcId"] = rpc_value(id);
        row["method"] = json!(method); row["payload"] = payload;
        let (_,inserted)=ledger::record_request_reporting(&db.0,&row)?;
        drop(db);
        // Committed (autocommit savepoint) and new: a deduplicated retry is not an alert.
        if inserted { if let Some(attention)=&self.control.attention { attention.permission(self.sid,&rid,self.control.generation); } }
        self.approvals.insert(rid.clone(),a);
        self.event(json!({"method":"runtime/approval","params":{"id":rid,"method":method,"payload":row["payload"]}}))
    }
    fn notification(&mut self, method: &str, params: &Value) -> Result<()> {
        let Some(event) = codec::normalize_event(method,params)? else { return Ok(()); };
        let v = &event["params"];
        if method == "thread/started" {
            ensure!(v["thread"]["id"] == self.thread, "Unexpected thread"); return Ok(());
        }
        ensure!(v["threadId"] == self.thread, "Notification thread mismatch");
        if method == "serverRequest/resolved" {
            let ids: Vec<_> = self.approvals.iter().filter(|(_,a)| rpc_value(a.id()) == v["requestId"])
                .map(|(id,_)| id.clone()).collect();
            for id in ids {
                ledger::invalidate_request(&lock(self.db)?.0,&id,self.sid,self.control.generation)?;
                self.approvals.remove(&id);
            }
        } else if method.starts_with("turn/") {
            let native = text(&v["turn"],"id")?; self.bind(native)?;
            if method == "turn/started" {self.turn.as_mut().unwrap().native_started=true;}
            if method == "turn/completed" {
                let status = text(&v["turn"],"status")?;
                ensure!(["completed","failed","interrupted"].contains(&status), "Nonterminal completion");
                let t = self.turn.as_mut().unwrap();
                let first = !t.terminal;
                let mut end = t.identity.clone(); end["nativeTurnId"] = json!(native); end["status"] = json!(status);
                ledger::finish_turn(&lock(self.db)?.0,&end)?; t.terminal = true; self.approvals.clear();
                // Committed end of turn: «Turno terminado» for whoever is not looking (once per turn).
                if first { if let Some(attention)=&self.control.attention { attention.structured_turn_finished(self.sid,status); } }
                // Native completion is authoritative even when an interrupt ACK
                // is late or rejects an already-finished turn. Retire exact IDs
                // so a late reply cannot affect any subsequent turn.
                let ids:Vec<_>=self.pending.iter().filter(|(_,p)|p.method=="turn/interrupt").map(|(id,_)|*id).collect();
                ensure!(self.retired_interrupts.len()+ids.len()<=2048,"Retired interrupt identity limit");
                for id in ids{self.pending.remove(&id);self.retired_interrupts.insert(id);}
            }
        } else if method.starts_with("item/") || method == "error" {
            let t = self.turn.as_ref().context("Unclaimed item event")?;
            ensure!(!t.terminal && t.native.as_deref() == v["turnId"].as_str(), "Notification turn mismatch");
        }
        self.advertise_ready();
        self.event(event)?;
        ensure!(method != "error" && !(method == "thread/status/changed" && params["status"]["type"] == "systemError"),
            "Provider reported execution error"); Ok(())
    }
    fn pump(&mut self, p: &mut Process, rx: &Receiver<Intent>) -> Result<()> {
        loop {
            if self.control.stop.load(Ordering::Acquire) { return Ok(()); }
            ensure!(self.pending.values().all(|p| Instant::now() < p.deadline), "Native RPC ACK expired; no resend");
            // Bound each batch so neither native output nor UI intents starve.
            for _ in 0..32 {
                match p.receive()? {
                    Some(Incoming::Response { id,result }) => self.response(id,Some(result))?,
                    Some(Incoming::Error { id,.. }) => self.response(id,None)?,
                    Some(Incoming::Notification { method,params }) => self.notification(&method,&params)?,
                    Some(v @ Incoming::Request { .. }) => self.request(p,v)?, None => break,
                }
                if self.turn.is_some() { self.interrupt(p)?; }
                if self.control.stop.load(Ordering::Acquire) { return Ok(()); }
            }
            match rx.try_recv() {
                Ok(intent) => self.intent(p,intent)?,
                Err(TryRecvError::Disconnected) => return Ok(()), Err(TryRecvError::Empty) => (),
            }
            ensure!(!p.leader_exited()?, "Owned provider exited");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

pub fn run(db: Arc<Mutex<Store>>, admission: Arc<Mutex<()>>, control: Control,
    rx: Receiver<Intent>, session_id: String, cwd: PathBuf, pulso: Option<crate::pulso_mcp_config::PulsoMcp>) -> Result<()> {
    let deadline = Instant::now()+Duration::from_secs(20);
    let mut process: Option<Process> = None;
    let mut wait_confirmed = true;
    let mut thread_requested=false;
    let result = (|| -> Result<()> {
        ensure!(control.generation > 0, "Invalid generation");
        let version = match Process::installed_version_with_control(&admission,&control.stop) {
            Ok(version) => version,
            // The opaque owned probe cannot return its cleanup receipt on Err.
            // Conservatively retain the parent's fence rather than assert wait.
            Err(error) => { wait_confirmed = false; return Err(error); }
        };
        ensure!(version == codec::PROTOCOL_VERSION, "Codex version must be 0.167.1");
        process = Some(spawn(&admission,&control,&cwd,None,None)?);
        let p = process.as_mut().unwrap();
        initialize(p,&control,deadline)?;
        let config_params = json!({"cwd":cwd.to_str().context("Non UTF-8 cwd")?,"includeLayers":false});
        let names = servers(&boot_rpc(p,&control,deadline,2,"config/read",config_params.clone())?,false,None)?;
        let closed = p.close(); wait_confirmed = closed["waitConfirmed"] == true;
        ensure!(wait_confirmed, "Bootstrap cleanup uncertain");
        process = None;
        ensure!(Instant::now() < deadline, "Boot deadline expired");
        process = Some(spawn(&admission,&control,&cwd,Some(&names),pulso.as_ref())?);
        let p = process.as_mut().unwrap(); initialize(p,&control,deadline)?;
        let account = boot_rpc(p,&control,deadline,2,"account/read",json!({}))?;
        ensure!(account.pointer("/account/type").and_then(Value::as_str) == Some("chatgpt"), "Native ChatGPT authentication required");
        drop(account);
        servers(&boot_rpc(p,&control,deadline,3,"config/read",config_params)?,true,pulso.as_ref())?;
        let session = ledger::get_session(&lock(&db)?.0,&session_id)?;
        ensure!(session["generation"] == control.generation, "Stale connection generation");
        let mut params = json!({"cwd":cwd.to_str().context("Non UTF-8 cwd")?,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"});
        let resume = session["nativeThreadId"].as_str().filter(|s| !s.is_empty());
        if let Some(thread) = resume { params["threadId"] = json!(thread); params["excludeTurns"] = json!(true); }
        thread_requested=true;
        let reply = boot_rpc(p,&control,deadline,4,if resume.is_some(){"thread/resume"}else{"thread/start"},params)?;
        ensure!(reply["modelProvider"]=="openai" && reply["approvalsReviewer"]=="user" && reply["approvalPolicy"]=="on-request" && reply["sandbox"]["type"]=="workspaceWrite" && reply["sandbox"]["networkAccess"]==false,"Native provider or permission policy differs from approved configuration");
        verify_local_environment(&reply,&cwd)?;
        let thread = text(&reply["thread"],"id")?.to_owned();
        ensure!(resume.is_none_or(|old| old == thread), "Resume returned another thread");
        ensure!(Instant::now() < deadline && !control.stop.load(Ordering::Acquire), "Boot stopped or expired");
        { let mut store = lock(&db)?; ledger::bind_thread(&store.0,&session_id,control.generation,&thread)?;
            store.activate(&session_id,p.pid())?; }
        control.ready.store(true,Ordering::Release);
        let pumped=Actor { db:&db, control:&control, sid:&session_id, thread, next:4, pending:HashMap::new(),retired_interrupts:HashSet::new(),
            approvals:HashMap::new(), turn:None }.pump(p,&rx);
        control.ready.store(false,Ordering::Release);pumped
    })();
    control.ready.store(false,Ordering::Release);
    // Cleanup executes for every Result path, including persistence failure.
    if let Some(p) = process.as_mut() { wait_confirmed &= p.close()["waitConfirmed"] == true; }
    let mut store = lock(&db)?;
    if wait_confirmed { ledger::close_session(&store.0,&session_id,control.generation)?; }
    let stopped = result.is_ok() && control.stop.load(Ordering::Acquire);
    let final_status=if !wait_confirmed || (result.is_err() && thread_requested){"needs_attention"}else if result.is_err(){"failed"}else if stopped{"stopped"}else{"exited"};
    store.state(&session_id,final_status,
        json!({"waitConfirmed":wait_confirmed,"generation":control.generation,"fault":result.is_err(),"reason":result.as_ref().err().map(|error|error.to_string().chars().take(240).collect::<String>())}))?;
    drop(store);
    if let Some(attention)=&control.attention { attention.structured_ended(&session_id,final_status); }
    ensure!(wait_confirmed, "Owned process quiescence unconfirmed; retain resource fence");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn native_environment_is_bound_to_exact_local_cwd_and_roots_before_turns(){
        let cwd=std::path::Path::new("/owned/task");let valid=json!({"thread":{"environments":[{"environmentId":"local","cwd":"/owned/task","runtimeWorkspaceRoots":["/owned/task"]}]}});
        assert!(verify_local_environment(&valid,cwd).is_ok());
        for roots in [Value::Null,json!([]),json!(["/owned/task","/"]),json!("/owned/task")] {let mut bad=valid.clone();bad["thread"]["environments"][0]["runtimeWorkspaceRoots"]=roots;assert!(verify_local_environment(&bad,cwd).is_err());}
        let mut missing=valid.clone();missing["thread"]["environments"][0].as_object_mut().unwrap().remove("runtimeWorkspaceRoots");assert!(verify_local_environment(&missing,cwd).is_err());
        for bad in [json!({}),json!({"thread":{"environments":[]}}),json!({"thread":{"environments":[{"environmentId":"remote","cwd":"/owned/task"}]}}),json!({"thread":{"environments":[{"environmentId":"local","cwd":"/owned/task-other"}]}}),json!({"thread":{"environments":[{"environmentId":"local","cwd":"/owned/task","runtimeWorkspaceRoots":["/"]}]}})]{assert!(verify_local_environment(&bad,cwd).is_err());}
    }
    #[test]fn start_ack_binds_identity_but_only_native_started_confirms_running(){
        let (db,c,id)=fixture();let mut a=actor(&db,&c,id);
        a.response(RpcId::Number(5),Some(json!({"turn":{"id":"native"}}))).unwrap();
        assert!(a.turn.as_ref().unwrap().acked);assert!(!a.turn.as_ref().unwrap().native_started);
        a.notification("turn/started",&json!({"threadId":"thread","turn":{"id":"native","status":"inProgress"}})).unwrap();
        assert!(a.turn.as_ref().unwrap().native_started);
    }
    #[test]fn rejected_interrupt_keeps_cancellation_fenced_until_native_completion(){
        let (db,c,id)=fixture();let mut a=actor(&db,&c,id.clone());a.bind("native").unwrap();ledger::cancel_turn(&lock(&db).unwrap().0,&id).unwrap();
        a.pending.insert(6,Pending{method:"turn/interrupt",deadline:Instant::now()+Duration::from_secs(10)});
        a.response(RpcId::Number(6),None).unwrap();
        assert_eq!(ledger::get_session(&lock(&db).unwrap().0,"s").unwrap()["status"],"cancel_requested");assert!(!c.ready.load(Ordering::Acquire));
        a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":"interrupted"}})).unwrap();
        assert_eq!(ledger::get_session(&lock(&db).unwrap().0,"s").unwrap()["status"],"interrupted");
    }
    #[test]fn terminal_completion_retires_interrupt_and_tolerates_exact_late_error(){
        let (db,c,id)=fixture();let mut a=actor(&db,&c,id);
        a.pending.insert(6,Pending{method:"turn/interrupt",deadline:Instant::now()});
        a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":"completed"}})).unwrap();
        assert!(!a.pending.contains_key(&6));assert!(a.retired_interrupts.contains(&6));
        a.response(RpcId::Number(6),None).unwrap();assert!(!a.retired_interrupts.contains(&6));
        assert!(a.response(RpcId::Number(7),None).is_err());
        assert_eq!(ledger::get_turn(&lock(&db).unwrap().0,"t").unwrap()["outcome"],"success");
    }
    #[test]fn ready_requires_completion_and_ack_and_is_advertised_only_once(){
        let (db,c,id)=fixture();let mut a=actor(&db,&c,id);
        a.turn.as_mut().unwrap().terminal=true;a.advertise_ready();assert!(!c.ready.load(Ordering::Acquire));
        a.turn.as_mut().unwrap().acked=true;a.advertise_ready();assert!(c.ready.swap(false,Ordering::AcqRel));
        a.advertise_ready();assert!(!c.ready.load(Ordering::Acquire));
        a.turn.as_mut().unwrap().ready_notified=false;c.stop.store(true,Ordering::Release);a.advertise_ready();assert!(!c.ready.load(Ordering::Acquire));
    }
    #[test]fn cancellation_before_native_delivery_settles_without_rpc_or_connection_fault(){
        let (db,c,id)=fixture();ledger::cancel_turn(&lock(&db).unwrap().0,&id).unwrap();let mut a=actor(&db,&c,id);
        a.pending.clear();a.turn.as_mut().unwrap().cancelled=true;
        assert!(a.settle_unsent_cancelled().unwrap());assert!(a.turn.as_ref().unwrap().terminal && a.turn.as_ref().unwrap().acked);assert!(a.pending.is_empty());
        let db=lock(&db).unwrap();assert_eq!(ledger::get_session(&db.0,"s").unwrap()["status"],"idle");assert_eq!(ledger::get_command(&db.0,"c").unwrap()["result"]["delivery"],"not_sent");assert!(ledger::get_turn(&db.0,"t").unwrap()["nativeTurnId"].is_null());
    }
    #[test]fn approval_observes_durable_cancel_before_queued_interrupt(){
        let (db,c,id)=fixture();let mut a=actor(&db,&c,id.clone());a.bind("native").unwrap();ledger::cancel_turn(&lock(&db).unwrap().0,&id).unwrap();
        assert!(!a.turn.as_ref().unwrap().cancelled);
        let request=Incoming::Request{id:RpcId::Number(7),method:"item/commandExecution/requestApproval".into(),params:json!({"threadId":"thread","turnId":"native","itemId":"i","kind":"command","command":"pwd","cwd":"/fixture","startedAtMs":0})};
        let approval=codec::parse_approval(&request).unwrap();assert!(a.approval_cancelled(&approval,&lock(&db).unwrap().0).unwrap());assert!(a.turn.as_ref().unwrap().cancelled);
        assert_eq!(lock(&db).unwrap().0.query_row("SELECT count(*) FROM provider_requests",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test] fn effective_mcp_must_be_explicitly_disabled() {
        assert!(servers(&json!({}),true,None).is_err());
        assert!(servers(&json!({"config":{"mcp_servers":{"a":{}}}}),true,None).is_err());
        assert!(servers(&json!({"config":{"mcp_servers":{"a":{"enabled":true}}}}),true,None).is_err());
        assert_eq!(servers(&json!({"config":{"mcp_servers":{"a":{"enabled":false}}}}),true,None).unwrap(),vec!["a"]);
    }
    #[test] fn effective_mcp_allows_only_the_owned_pulso_server() {
        let own=crate::pulso_mcp_config::PulsoMcp::new(PathBuf::from("/app/aw-runner"),PathBuf::from("/private/grant.json")).unwrap();
        let mut config=json!({"config":{"mcp_servers":{
            "other":{"enabled":false},
            "jauria-pulso":{"enabled":true,"command":"/app/aw-runner","args":["--pulso-mcp"],"env":{"JAURIA_PULSO_HANDLE":"/private/grant.json"}}
        }}});
        assert_eq!(servers(&config,true,Some(&own)).unwrap().len(),2);
        config["config"]["mcp_servers"]["other"]["enabled"]=json!(true);
        assert!(servers(&config,true,Some(&own)).is_err());
        config["config"]["mcp_servers"]["other"]["enabled"]=json!(false);
        config["config"]["mcp_servers"]["jauria-pulso"]["command"]=json!("/bin/sh");
        assert!(servers(&config,true,Some(&own)).is_err());
        config["config"]["mcp_servers"]["jauria-pulso"]["command"]=json!("/app/aw-runner");
        config["config"]["mcp_servers"]["jauria-pulso"]["env"]["JAURIA_PULSO_HANDLE"]=json!("/private/other.json");
        assert!(servers(&config,true,Some(&own)).is_err());
        config["config"]["mcp_servers"]["jauria-pulso"]["env"]["JAURIA_PULSO_HANDLE"]=json!("/private/grant.json");
        config["config"]["mcp_servers"]["jauria-pulso"]["env"]["EXTRA"]=json!("unexpected");
        assert!(servers(&config,true,Some(&own)).is_err());
    }
    #[test] fn claim_projection_and_typed_ids() {
        let v=json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":2});
        assert_eq!(identity(&json!({"result":v})).unwrap(),v);
        assert_ne!(rpc_value(&RpcId::Number(7)),rpc_value(&RpcId::String("7".into())));
        assert!(identity(&json!({"sessionId":"s"})).is_err());
    }
    #[test] fn generated_ids_and_bounded_channel() {
        let a=uuid().unwrap(); let b=uuid().unwrap(); assert_eq!(a.len(),36); assert_ne!(a,b);
        assert_eq!(&a[14..15],"4");
        let (c,_rx)=channel(3); assert_eq!(c.generation,3); assert!(!c.stop.load(Ordering::Acquire));
        for _ in 0..32 { c.tx.try_send(Intent::Interrupt{identity:Value::Null}).unwrap(); }
        assert!(c.tx.try_send(Intent::Interrupt{identity:Value::Null}).is_err());
    }
    fn fixture() -> (Mutex<Store>, Control, Value) {
        let db=rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT);INSERT INTO sessions VALUES('s','codex');
            CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,kind TEXT,data TEXT);").unwrap();
        ledger::init(&db).unwrap();
        ledger::attach_session(&db,&json!({"sessionId":"s","expectedGeneration":0})).unwrap();
        ledger::bind_thread(&db,"s",1,"thread").unwrap();
        let claim=ledger::start_turn(&db,&json!({"commandId":"c","sessionId":"s","turnId":"t",
            "attemptId":"a","generation":1,"prompt":"fixture"})).unwrap();
        (Mutex::new(Store(db)),channel(1).0,identity(&claim).unwrap())
    }
    fn actor<'a>(db: &'a Mutex<Store>, control: &'a Control, id: Value) -> Actor<'a> {
        Actor { db,control,sid:"s",thread:"thread".into(),next:5,approvals:HashMap::new(),
            retired_interrupts:HashSet::new(),pending:HashMap::from([(5,Pending{method:"turn/start",deadline:Instant::now()+Duration::from_secs(10)})]),
            turn:Some(Turn{identity:id,command:"c".into(),native:None,terminal:false,acked:false,
                cancelled:false,interrupt_sent:false,native_started:false,ready_notified:false}) }
    }
    #[test] fn completion_before_ack_is_terminal_and_ack_cannot_reopen() {
        let (db,c,id)=fixture(); let mut a=actor(&db,&c,id);
        a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":"completed"}})).unwrap();
        a.response(RpcId::Number(5),Some(json!({"turn":{"id":"native"}}))).unwrap();
        assert!(a.turn.as_ref().unwrap().terminal && a.turn.as_ref().unwrap().acked);
        assert_eq!(ledger::get_turn(&lock(&db).unwrap().0,"t").unwrap()["outcome"],"success");
        assert_eq!(ledger::get_session(&lock(&db).unwrap().0,"s").unwrap()["status"],"idle");
        assert!(a.response(RpcId::Number(5),Some(json!({"turn":{"id":"native"}}))).is_err());
        assert!(a.bind("other").is_err());
    }
    #[test] fn structured_turn_completion_is_one_finished_alert_and_a_cancel_is_none() {
        use crate::agent_attention::{Attention, Config, system_clock};
        for (status, alerts) in [("completed", 1), ("failed", 1), ("interrupted", 0)] {
            let (db,mut c,id)=fixture();
            let attention=Attention::open(None,"g".into(),&[],system_clock(),Config::default());
            c.attention=Some(attention.clone());
            let mut a=actor(&db,&c,id);
            a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":status}})).unwrap();
            // A repeated delivery of the same completion never raises a second alert.
            let _=a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":status}}));
            let seq=attention.snapshot("s").map_or(0,|v|v["alertSeq"].as_u64().unwrap());
            assert_eq!(seq,alerts,"{status}");
            if alerts==1 { assert!(attention.snapshot("s").unwrap()["pending"]["finished"].is_object()); }
        }
    }
    #[test] fn wrong_thread_and_oversized_output_fail_without_event_loss() {
        let (db,c,id)=fixture(); let mut a=actor(&db,&c,id); a.bind("native").unwrap();
        assert!(a.notification("item/agentMessage/delta",&json!({"threadId":"other","turnId":"native","itemId":"i","delta":"x"})).is_err());
        assert!(a.notification("item/agentMessage/delta",&json!({"threadId":"thread","turnId":"native","itemId":"i","delta":"x".repeat(codec::MAX_TEXT_BYTES+1)})).is_err());
        let count:i64=lock(&db).unwrap().0.query_row("SELECT count(*) FROM events",[],|r|r.get(0)).unwrap();
        assert_eq!(count,0);
    }
    #[test] fn native_resolution_invalidates_durable_and_owned_request() {
        let (db,c,id)=fixture(); let mut a=actor(&db,&c,id.clone()); a.bind("native").unwrap();
        let params=json!({"threadId":"thread","turnId":"native","itemId":"i","command":"pwd","cwd":"/fixture","startedAtMs":0});
        let incoming=Incoming::Request{id:RpcId::Number(7),method:"item/commandExecution/requestApproval".into(),params};
        let approval=codec::parse_approval(&incoming).unwrap(); let rid=uuid().unwrap();
        let mut row=id; row["id"]=json!(rid); row["nativeRpcId"]=json!(7);
        row["method"]=json!("item/commandExecution/requestApproval"); row["payload"]=json!({"params":approval.presentation()});
        ledger::record_request(&lock(&db).unwrap().0,&row).unwrap(); a.approvals.insert(rid.clone(),approval);
        a.notification("serverRequest/resolved",&json!({"threadId":"thread","requestId":"7"})).unwrap();
        assert_eq!(a.approvals.len(),1); // Typed IDs must not collide.
        a.notification("serverRequest/resolved",&json!({"threadId":"thread","requestId":7})).unwrap();
        assert!(a.approvals.is_empty());
        assert_eq!(ledger::get_request(&lock(&db).unwrap().0,&rid).unwrap()["status"],"invalidated");
    }
    #[test] fn cancellation_before_ack_keeps_native_binding_and_fences_permissions() {
        let (db,c,id)=fixture(); let mut a=actor(&db,&c,id.clone());
        ledger::cancel_turn(&lock(&db).unwrap().0,&id).unwrap(); a.turn.as_mut().unwrap().cancelled=true;
        a.response(RpcId::Number(5),Some(json!({"turn":{"id":"native"}}))).unwrap();
        assert_eq!(ledger::get_turn(&lock(&db).unwrap().0,"t").unwrap()["status"],"cancel_requested");
        assert!(a.turn.as_ref().unwrap().cancelled && !a.turn.as_ref().unwrap().interrupt_sent);
        c.stop.store(true,Ordering::Release);
        assert!(spawn(&Mutex::new(()),&c,std::path::Path::new("/"),None,None).is_err());
    }
    #[test] fn native_failed_is_failed_and_system_error_is_never_green() {
        let (db,c,id)=fixture(); let mut a=actor(&db,&c,id);
        a.notification("turn/completed",&json!({"threadId":"thread","turn":{"id":"native","status":"failed"}})).unwrap();
        assert_eq!(ledger::get_turn(&lock(&db).unwrap().0,"t").unwrap()["outcome"],"failed");
        assert!(a.notification("thread/status/changed",&json!({"threadId":"thread","status":{"type":"systemError"}})).is_err());
    }
}

//! Durable Codex ledger. No processes, auth, provider calls, Store or event coupling.
//!
//! Frozen Value contract (camelCase): attach_session takes {sessionId,
//! expectedGeneration,nativeThreadId?:string|null} and returns a session. Initial
//! expectedGeneration is 0; subsequent explicit attaches increment the generation.
//! bind_thread fills a previously empty binding without changing generation.
//! bind_turn takes {sessionId,turnId,attemptId,generation,nativeTurnId} and
//! records an immutable native turn binding, even after native completion.
//! cancel_turn takes {sessionId,turnId,attemptId,generation}: first committed
//! transition returns shouldSend:true for ONE interrupt, without finishing.
//! Pending and answered-but-undelivered requests are invalidated before that response. Parent owns signalling.
//! close_session(db,sessionId,generation) is called ONLY after the parent has
//! waited for its OWNED process and confirmed quiescence. It closes the generation
//! and fences unfinished attempts as interrupted/uncertain; it never signals.
//! summary(db,sessionId) returns session metadata, latest <=16 turn projections,
//! and pending request projections; no prompts or request payloads. Serialized
//! summary <=32 KiB, with hasMoreRequests/hasMoreTurns and pendingRequestCount.
//! hasNativeTurns is EXISTS(native_turn_id IS NOT NULL) across ALL session turns,
//! independent of the latest-16 window; each projected turn retains nativeTurnId.
//! Request details remain available by get_request; summary never grants effects.
//! start_turn takes {commandId,sessionId,turnId,attemptId,generation,prompt}.
//! record_request takes {id:<local UUID>,sessionId,turnId,attemptId,generation,
//! nativeRpcId:<JSON string|integer>,method,payload}. answer_permission takes the
//! same identity fields (without method/payload), plus decision:"accept"|"deny".
//! Permission lifecycle: pending -> answered (durable one-shot intent only) ->
//! delivered (bytes written, NOT proof of execution). mark_permission_delivered
//! takes {id,sessionId,turnId,attemptId,generation,nativeRpcId}; actor calls ONLY
//! after successful send_packet while retaining its DB lock across send and mark.
//! It requires autocommit, exact current live identity, and answered-only CAS.
//! A lost send/mark outcome is uncertain: never replay. Cancel/finish/fence/close/
//! recovery invalidate undelivered intents and preserve delivered history.
//! invalidate_request(db,id,sessionId,generation) handles native withdrawal or
//! actor discard without sending; delivered/invalidated rows stay terminal.
//! fence_session(db,sessionId,generation) is metadata ONLY: turns/attempts become
//! interrupted/uncertain, undelivered requests invalidated, claimed starts uncertain,
//! session interrupted. It does NOT attest process stop or authorize a writer.
//! Parent calls it only for needs_attention + finished owned job + human ack;
//! never use it to infer quiescence, auto signal or retry. close_session reuses
//! the fence after confirmed owned wait, then marks closed.
//! finish_turn takes {sessionId,turnId,attemptId,generation,status,nativeTurnId?};
//! status is completed/failed/interrupted, mapped to success/failed/uncertain.
//! finish_command takes {commandId,result:<JSON>} to acknowledge a claimed start.
//! IDs other than request UUIDs are opaque nonempty strings <=128 UTF-8 bytes,
//! without NUL. Prompt length counts UTF-8 bytes, not JSON escaping.
//!
//! Every public Value result has shouldSend:false except the FIRST committed
//! start_turn/answer_permission/cancel_turn CAS result. These APIs require autocommit:
//! never send until persistence commits. Lost CAS responses are NOT replayable.
//! A duplicate command returns its stored result with shouldSend:false even after
//! recovery; a different digest conflicts. No automatic retries or deletion API.
//! Requests expose nativeRpcId as its original JSON type (1 and "1" differ).
//! Decisions are generic intent only: parent must enforce native method/scope,
//! capability and policy gates BEFORE accepting. No auto grants or scope widening.
//!
//! Parent serializes provider lifecycle and holds its writer gate across attach,
//! start and permission admission. Explicit reattach after uncertainty requires
//! parent evidence of quiescence; a generation alone cannot stop external writers.
//! init is startup-only, nestable and atomic via SAVEPOINT; does not own schema
//! version or connection pragmas. validate_schema reads sqlite_master only on the
//! supplied connection and compares exact definitions, including indexes/triggers.
//!
//! Global retained row caps: 256 sessions, 2048 turns, 4096 attempts, 4096 requests
//! (256 outstanding pending/answered), 4096 commands. Metadata admission budget 8 MiB reserves 2048 bytes
//! per session/turn/attempt and 4096 per request, PLUS prompt/payload bytes.
//! Command budget is separate: 8 MiB, 2048 reserved bytes per command. Native IDs
//! <=256 bytes, RPC JSON <=256, method <=128, payload <=16 KiB, result <=1 KiB,
//! prompt <=32 KiB UTF-8 bytes. Reserved bytes cover all fixed fields, final states,
//! decisions and results, so quota exhaustion cannot starve terminal writes.
//! These are logical retained-content budgets, not a physical SQLite disk limit.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const METADATA_BYTES: i64 = 8 * 1024 * 1024;
pub const COMMAND_BYTES: i64 = 8 * 1024 * 1024;
pub const PROMPT_BYTES: usize = 32 * 1024;
pub const SUMMARY_BYTES: usize = 32 * 1024;

/// Exact owned schema; parent creates sessions and owns schema5 migration.
pub const SCHEMA_SQL: &str = r#"CREATE TABLE IF NOT EXISTS codex_sessions(
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    native_thread_id TEXT, generation INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_turns(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES codex_sessions(session_id),
    prompt TEXT NOT NULL, native_turn_id TEXT, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_attempts(
    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES model_turns(id),
    generation INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT);
CREATE TABLE IF NOT EXISTS provider_commands(
    id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_requests(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES codex_sessions(session_id),
    turn_id TEXT NOT NULL REFERENCES model_turns(id),
    attempt_id TEXT NOT NULL REFERENCES model_attempts(id), generation INTEGER NOT NULL,
    native_rpc_id TEXT NOT NULL, method TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, decision TEXT,
    UNIQUE(session_id,generation,native_rpc_id));
CREATE INDEX IF NOT EXISTS codex_turn_session ON model_turns(session_id,status);
CREATE INDEX IF NOT EXISTS codex_attempt_turn ON model_attempts(turn_id,status);
CREATE INDEX IF NOT EXISTS codex_request_pending ON provider_requests(status);
"#;

/// Read-only exact preflight, including unexpected indexes/triggers on our tables.
pub fn validate_schema(db: &Connection) -> Result<()> {
    fn objects(db: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
        Ok(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN
            ('codex_sessions','model_turns','model_attempts','provider_commands','provider_requests')
            OR name IN ('codex_turn_session','codex_attempt_turn','codex_request_pending')
            ORDER BY type,name")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(SCHEMA_SQL)?;
    ensure!(objects(db)? == objects(&reference)?, "Unsupported Codex ledger schema");
    Ok(())
}

// &Connection SAVEPOINT guard also rolls back on unwinding. All mutation paths
// are synchronous; no callbacks or provider calls run while the savepoint is held.
fn atomic<T>(db: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    struct Guard<'a>(&'a Connection, bool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if !self.1 { let _ = self.0.execute_batch("ROLLBACK TO codex_ledger; RELEASE codex_ledger;"); }
        }
    }
    db.execute_batch("SAVEPOINT codex_ledger;")?;
    let mut guard = Guard(db, false);
    let result = f()?;
    db.execute_batch("RELEASE codex_ledger;")?;
    guard.1 = true;
    Ok(result)
}

/// Create only an absent complete schema; reject partial/modified layouts before
/// DDL or recovery. Non-safe/unknown states are fenced rather than inferred live.
pub fn init(db: &Connection) -> Result<()> {
    atomic(db, || {
        let present: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE
            name IN ('codex_sessions','model_turns','model_attempts','provider_commands',
            'provider_requests','codex_turn_session','codex_attempt_turn','codex_request_pending'))", [], |r| r.get(0))?;
        if present { validate_schema(db)?; } else { db.execute_batch(SCHEMA_SQL)?; }
        validate_schema(db)?;
        recover_inner(db)
    })
}

/// Startup recovery, never resend. Unknown states also become interrupted /
/// uncertain / invalidated. Terminal rows are preserved. Idempotent.
pub fn recover(db: &Connection) -> Result<()> {
    atomic(db, || { validate_schema(db)?; recover_inner(db) })
}
fn recover_inner(db: &Connection) -> Result<()> {
    db.execute_batch("UPDATE codex_sessions SET status='interrupted' WHERE status NOT IN ('idle','interrupted','closed');
        UPDATE model_attempts SET status='interrupted',outcome='uncertain'
            WHERE status NOT IN ('completed','failed','interrupted') OR outcome IS NULL
            OR (status='completed' AND outcome!='success')
            OR (status='failed' AND outcome!='failed')
            OR (status='interrupted' AND outcome!='uncertain');
        UPDATE model_turns SET status='interrupted' WHERE status NOT IN ('completed','failed','interrupted')
            OR NOT EXISTS(SELECT 1 FROM model_attempts a WHERE a.turn_id=model_turns.id)
            OR EXISTS(SELECT 1 FROM model_attempts a WHERE a.turn_id=model_turns.id AND
                COALESCE((a.status=model_turns.status AND a.outcome=CASE model_turns.status
                    WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'failed' ELSE 'uncertain' END),0)=0);
        UPDATE model_attempts SET status='interrupted',outcome='uncertain'
            WHERE turn_id IN (SELECT id FROM model_turns WHERE status='interrupted');
        UPDATE provider_requests SET status='invalidated' WHERE status NOT IN ('delivered','invalidated');
        UPDATE provider_commands SET state='uncertain' WHERE state NOT IN ('completed','uncertain');")?;
    Ok(())
}
fn bounded(s: &str, max: usize, empty: bool) -> Result<()> {
    ensure!((empty || !s.is_empty()) && s.len() <= max && !s.contains('\0'), "Invalid or oversized string (max {max} bytes)");
    Ok(())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().with_context(|| format!("Missing string {key}"))
}
fn id<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    let s = text(v, key)?; bounded(s, 128, false)?; Ok(s)
}
fn generation(v: &Value) -> Result<i64> {
    let n = v["generation"].as_i64().context("Missing integer generation")?;
    ensure!(n > 0, "Invalid generation"); Ok(n)
}
fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    let obj = v.as_object().context("Expected object")?;
    ensure!(obj.keys().all(|k| allowed.contains(&k.as_str())), "Unknown input field"); Ok(())
}
fn canonical(v: &Value) -> Result<String> {
    fn ordered(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let sorted: std::collections::BTreeMap<_, _> = o.iter().collect();
                let mut map = serde_json::Map::new();
                for (k, v) in sorted { map.insert(k.clone(), ordered(v)); }
                Value::Object(map)
            }
            Value::Array(a) => Value::Array(a.iter().map(ordered).collect()),
            _ => v.clone(),
        }
    }
    Ok(serde_json::to_string(&ordered(v))?)
}
fn response(mut v: Value, send: bool) -> Value { v["shouldSend"] = json!(send); v }
fn known(s: &str, allowed: &[&str]) -> Result<()> {
    ensure!(allowed.contains(&s), "Unknown or unsafe ledger state: {s}"); Ok(())
}
fn session_inner(db: &Connection, sid: &str) -> Result<Value> {
    let (thread, gen_, state): (Option<String>, i64, String) = db.query_row(
        "SELECT native_thread_id,generation,status FROM codex_sessions WHERE session_id=?", [sid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    known(&state, &["idle","running","cancel_requested","interrupted","closed"])?;
    ensure!(gen_ > 0, "Invalid stored generation");
    Ok(response(json!({"sessionId":sid,"nativeThreadId":thread,"generation":gen_,"status":state}), false))
}
/// Read-only session projection. Unknown states fail closed.
pub fn get_session(db: &Connection, sid: &str) -> Result<Value> {
    bounded(sid,128,false)?; session_inner(db,sid)
}
/// Read-only turn projection with its single explicit attempt. No retry API.
pub fn get_turn(db: &Connection, tid: &str) -> Result<Value> {
    bounded(tid,128,false)?;
    let value = db.query_row("SELECT t.session_id,t.prompt,t.native_turn_id,t.status,
        a.id,a.generation,a.status,a.outcome FROM model_turns t JOIN model_attempts a ON a.turn_id=t.id WHERE t.id=?", [tid], |r| {
        Ok(json!({"turnId":tid,"sessionId":r.get::<_,String>(0)?,"prompt":r.get::<_,String>(1)?,
            "nativeTurnId":r.get::<_,Option<String>>(2)?,"status":r.get::<_,String>(3)?,
            "attemptId":r.get::<_,String>(4)?,"generation":r.get::<_,i64>(5)?,
            "attemptStatus":r.get::<_,String>(6)?,"outcome":r.get::<_,Option<String>>(7)?}))
    })?;
    known(text(&value,"status")?, &["running","cancel_requested","completed","failed","interrupted"])?;
    known(text(&value,"attemptStatus")?, &["running","cancel_requested","completed","failed","interrupted"])?;
    let expected = match text(&value,"status")? {
        "running" | "cancel_requested" => Value::Null, "completed" => json!("success"),
        "failed" => json!("failed"), _ => json!("uncertain"),
    };
    ensure!(value["attemptStatus"]==value["status"] && value["outcome"]==expected,
        "Inconsistent turn/attempt terminal state");
    Ok(response(value,false))
}
fn count(db: &Connection, table: &str) -> Result<i64> {
    Ok(db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
}
fn budget(db: &Connection, extra: i64) -> Result<()> {
    let used: i64 = db.query_row("SELECT
        (SELECT count(*)*2048 FROM codex_sessions)+
        (SELECT COALESCE(sum(2048+length(CAST(prompt AS BLOB))),0) FROM model_turns)+
        (SELECT count(*)*2048 FROM model_attempts)+
        (SELECT COALESCE(sum(4096+length(CAST(payload AS BLOB))),0) FROM provider_requests)", [], |r|r.get(0))?;
    ensure!(used + extra <= METADATA_BYTES, "Codex metadata quota (8 MiB including reservations)"); Ok(())
}
fn parent_codex(db: &Connection, sid: &str) -> Result<()> {
    let kind: String = db.query_row("SELECT kind FROM sessions WHERE id=?", [sid], |r|r.get(0))?;
    ensure!(kind == "codex", "Existing parent session kind must be codex"); Ok(())
}
fn consistent_execution(db: &Connection, sid: &str) -> Result<()> {
    let unsafe_row: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM model_turns t
        LEFT JOIN model_attempts a ON a.turn_id=t.id WHERE t.session_id=? AND COALESCE(
            (t.status IN ('running','cancel_requested') AND a.status=t.status AND a.outcome IS NULL AND a.id IS NOT NULL) OR
            (t.status='completed' AND a.status='completed' AND a.outcome='success') OR
            (t.status='failed' AND a.status='failed' AND a.outcome='failed') OR
            (t.status='interrupted' AND a.status='interrupted' AND a.outcome='uncertain'),0)=0)", [sid], |r|r.get(0))?;
    ensure!(!unsafe_row,"Unknown/inconsistent execution state; startup recovery required"); Ok(())
}
/// Explicit attach/reconnect, never creates the parent session. Native thread
/// binding is immutable except NULL/empty -> nonempty. No attach while a live turn exists.
pub fn attach_session(db: &Connection, v: &Value) -> Result<Value> {
    keys(v,&["sessionId","expectedGeneration","nativeThreadId"])?;
    let sid = id(v,"sessionId")?;
    let expected = v["expectedGeneration"].as_i64().context("Missing expectedGeneration")?;
    ensure!(expected >= 0 && expected < i64::MAX, "Invalid expectedGeneration");
    let thread = match &v["nativeThreadId"] { Value::Null => None, Value::String(s) => { bounded(s,256,true)?; if s.is_empty() { None } else { Some(s.as_str()) } }, _ => anyhow::bail!("Invalid nativeThreadId") };
    atomic(db, || {
        parent_codex(db,sid)?; consistent_execution(db,sid)?;
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM codex_sessions WHERE session_id=?)", [sid], |r|r.get(0))?;
        if exists {
            let old = session_inner(db,sid)?;
            ensure!(old["generation"] == expected, "Stale attach generation");
            let live: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM model_turns WHERE session_id=? AND status NOT IN ('completed','failed','interrupted'))", [sid], |r|r.get(0))?;
            ensure!(!live && old["status"] != "running" && old["status"] != "cancel_requested", "Session has a live or unknown turn");
            if let (Some(old),Some(new)) = (old["nativeThreadId"].as_str(),thread) { ensure!(old.is_empty() || old==new,"Native thread binding is immutable"); }
            ensure!(db.execute("UPDATE codex_sessions SET native_thread_id=COALESCE(NULLIF(native_thread_id,''),?),generation=generation+1,status='idle' WHERE session_id=? AND generation=?",params![thread,sid,expected])?==1,"Attach CAS failed");
            db.execute("UPDATE provider_requests SET status='invalidated' WHERE session_id=? AND status NOT IN ('delivered','invalidated')",[sid])?;
        } else {
            ensure!(expected==0,"Initial generation must be zero");
            ensure!(count(db,"codex_sessions")?<256,"Codex session row quota"); budget(db,2048)?;
            db.execute("INSERT INTO codex_sessions VALUES(?,?,1,'idle')",params![sid,thread])?;
        }
        session_inner(db,sid)
    })
}
/// Persist an observed native thread binding, including during a running turn.
pub fn bind_thread(db: &Connection, sid: &str, gen_: i64, thread: &str) -> Result<Value> {
    bounded(sid,128,false)?; bounded(thread,256,false)?;
    atomic(db, || {
        parent_codex(db,sid)?;
        let old = session_inner(db,sid)?;
        ensure!(old["generation"]==gen_,"Stale generation");
        if let Some(native) = old["nativeThreadId"].as_str() { ensure!(native.is_empty() || native==thread,"Native thread binding is immutable"); }
        ensure!(db.execute("UPDATE codex_sessions SET native_thread_id=? WHERE session_id=? AND generation=? AND (native_thread_id IS NULL OR native_thread_id='' OR native_thread_id=?)", params![thread,sid,gen_,thread])?==1,"Binding CAS failed");
        session_inner(db,sid)
    })
}
/// Read-only durable command result, always shouldSend:false.
pub fn get_command(db: &Connection, cid: &str) -> Result<Value> {
    bounded(cid,128,false)?;
    let (digest,kind,state,data): (String,String,String,String) = db.query_row(
        "SELECT request_hash,kind,state,result FROM provider_commands WHERE id=?",[cid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    known(&kind,&["start_turn"])?; known(&state,&["claimed","completed","uncertain"])?;
    Ok(response(json!({"commandId":cid,"requestHash":digest,"kind":kind,"state":state,"result":serde_json::from_str::<Value>(&data)?}),false))
}
/// Atomically insert a durable command and claim one turn/attempt. Never replay
/// shouldSend on duplicate, even if the first caller crashed before sending.
pub fn start_turn(db: &Connection, v: &Value) -> Result<Value> {
    ensure!(db.is_autocommit(),"start_turn requires autocommit for durable shouldSend");
    keys(v,&["commandId","sessionId","turnId","attemptId","generation","prompt"])?;
    let cid=id(v,"commandId")?; let sid=id(v,"sessionId")?;
    let tid=id(v,"turnId")?; let aid=id(v,"attemptId")?; let gen_=generation(v)?;
    let prompt=text(v,"prompt")?; ensure!(!prompt.is_empty() && prompt.len()<=PROMPT_BYTES,"Prompt must contain 1..32768 UTF-8 bytes");
    let digest=format!("{:x}",Sha256::digest(canonical(v)?.as_bytes()));
    atomic(db, || {
        let old: Option<String> = db.query_row("SELECT request_hash FROM provider_commands WHERE id=?",[cid],|r|r.get(0)).optional()?;
        if let Some(old)=old { ensure!(old==digest,"Command digest conflict"); return get_command(db,cid); }
        parent_codex(db,sid)?;
        consistent_execution(db,sid)?;
        let s=session_inner(db,sid)?;
        ensure!(s["generation"]==gen_ && s["status"]=="idle","Session is not idle at expected generation");
        let blocked: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM model_turns WHERE session_id=? AND status NOT IN ('completed','failed'))",[sid],|r|r.get(0))?;
        // Interrupted historical turns may be crossed only by explicit reattach.
        if blocked {
            let same: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM model_turns t JOIN model_attempts a ON a.turn_id=t.id WHERE t.session_id=? AND (a.generation>=? OR t.status NOT IN ('completed','failed','interrupted')))",params![sid,gen_],|r|r.get(0))?;
            ensure!(!same,"Unresolved turn at current generation");
        }
        ensure!(count(db,"model_turns")?<2048 && count(db,"model_attempts")?<4096,"Turn/attempt row quota");
        let commands=count(db,"provider_commands")?;
        ensure!(commands<4096 && (commands+1)*2048<=COMMAND_BYTES,"Command quota (4096 / 8 MiB reserved)");
        budget(db,4096+prompt.len() as i64)?;
        let result=json!({"sessionId":sid,"turnId":tid,"attemptId":aid,"generation":gen_});
        ensure!(canonical(&result)?.len()<=1024,"Encoded command identity exceeds 1 KiB");
        db.execute("INSERT INTO provider_commands VALUES(?,?,'start_turn','claimed',?)",params![cid,digest,canonical(&result)?])?;
        db.execute("INSERT INTO model_turns VALUES(?,?,?,NULL,'running')",params![tid,sid,prompt])?;
        db.execute("INSERT INTO model_attempts VALUES(?,?,?,'running',NULL)",params![aid,tid,gen_])?;
        ensure!(db.execute("UPDATE codex_sessions SET status='running' WHERE session_id=? AND generation=? AND status='idle'",params![sid,gen_])?==1,"Start CAS failed");
        Ok(response(get_command(db,cid)?,true))
    })
}
fn live(db: &Connection, v: &Value) -> Result<()> {
    let sid=id(v,"sessionId")?; let tid=id(v,"turnId")?; let aid=id(v,"attemptId")?; let gen_=generation(v)?;
    parent_codex(db,sid)?;
    let valid: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM codex_sessions s
        JOIN model_turns t ON t.session_id=s.session_id JOIN model_attempts a ON a.turn_id=t.id
        WHERE s.session_id=? AND t.id=? AND a.id=? AND s.generation=? AND a.generation=?
        AND s.status='running' AND t.status='running' AND a.status='running' AND a.outcome IS NULL)",params![sid,tid,aid,gen_,gen_],|r|r.get(0))?;
    ensure!(valid,"Stale, interrupted or nonpending execution identity"); Ok(())
}
fn request_uuid(s: &str) -> Result<()> {
    ensure!(s.len()==36 && s.bytes().enumerate().all(|(i,b)| if [8,13,18,23].contains(&i) { b==b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() }),"Request id must be a lowercase UUID"); Ok(())
}
fn rpc(v: &Value) -> Result<String> {
    ensure!(v.is_string() || v.as_i64().is_some() || v.as_u64().is_some(),"RPC id must be a string or integer");
    let s=canonical(v)?; bounded(&s,256,false)?; Ok(s)
}
/// Read-only request with parsed typed RPC id and payload; unknown states fail closed.
pub fn get_request(db: &Connection, rid: &str) -> Result<Value> {
    request_uuid(rid)?;
    let mut v=db.query_row("SELECT session_id,turn_id,attempt_id,generation,native_rpc_id,method,payload,status,decision FROM provider_requests WHERE id=?",[rid],|r| {
        Ok(json!({"id":rid,"sessionId":r.get::<_,String>(0)?,"turnId":r.get::<_,String>(1)?,
            "attemptId":r.get::<_,String>(2)?,"generation":r.get::<_,i64>(3)?,"nativeRpcId":r.get::<_,String>(4)?,
            "method":r.get::<_,String>(5)?,"payload":r.get::<_,String>(6)?,"status":r.get::<_,String>(7)?,
            "decision":r.get::<_,Option<String>>(8)?}))
    })?;
    known(text(&v,"status")?,&["pending","answered","delivered","invalidated"])?;
    if let Some(d)=v["decision"].as_str() { known(d,&["accept","deny"])?; }
    ensure!(((v["status"]!="answered" && v["status"]!="delivered") || v["decision"].is_string()) &&
        (v["status"]!="pending" || v["decision"].is_null()), "Inconsistent permission state");
    let native:Value=serde_json::from_str(text(&v,"nativeRpcId")?)?; rpc(&native)?;
    v["nativeRpcId"]=native;
    v["payload"]=serde_json::from_str(text(&v,"payload")?)?;
    Ok(response(v,false))
}
/// Persist a permission request, deduplicated by local UUID and typed native id.
/// No request insertion authorizes a response. Unknown native methods stay opaque.
pub fn record_request(db: &Connection, v: &Value) -> Result<Value> {
    keys(v,&["id","sessionId","turnId","attemptId","generation","nativeRpcId","method","payload"])?;
    let rid=id(v,"id")?; request_uuid(rid)?;
    let sid=id(v,"sessionId")?; let tid=id(v,"turnId")?; let aid=id(v,"attemptId")?; let gen_=generation(v)?;
    let native=rpc(&v["nativeRpcId"])?; let method=text(v,"method")?; bounded(method,128,false)?;
    ensure!(v.get("payload").is_some(),"Missing payload");
    let payload=canonical(&v["payload"])?; ensure!(payload.len()<=16*1024,"Request payload exceeds 16 KiB");
    atomic(db, || {
        let duplicate: Option<String>=db.query_row("SELECT id FROM provider_requests WHERE id=? OR (session_id=? AND generation=? AND native_rpc_id=?)",params![rid,sid,gen_,native],|r|r.get(0)).optional()?;
        if let Some(existing)=duplicate {
            let old=get_request(db,&existing)?;
            for field in ["id","sessionId","turnId","attemptId","generation","nativeRpcId","method","payload"] { ensure!(old[field]==v[field],"Request identity/payload conflict: {field}"); }
            return Ok(old);
        }
        live(db,v)?;
        ensure!(count(db,"provider_requests")?<4096,"Request retained row quota");
        let pending:i64=db.query_row("SELECT count(*) FROM provider_requests WHERE status NOT IN ('delivered','invalidated')",[],|r|r.get(0))?;
        ensure!(pending<256,"Pending approval quota (256)"); budget(db,4096+payload.len() as i64)?;
        db.execute("INSERT INTO provider_requests VALUES(?,?,?,?,?,?,?,?,'pending',NULL)",params![rid,sid,tid,aid,gen_,native,method,payload])?;
        get_request(db,rid)
    })
}
/// One-shot permission CAS. Exact retries return shouldSend:false; opposite
/// decisions, stale generations and responses after interruption are rejected.
/// Parent native policy gate must run before calling with decision accept.
pub fn answer_permission(db: &Connection, v: &Value) -> Result<Value> {
    ensure!(db.is_autocommit(),"answer_permission requires autocommit for durable shouldSend");
    keys(v,&["id","sessionId","turnId","attemptId","generation","nativeRpcId","decision"])?;
    let rid=id(v,"id")?; request_uuid(rid)?; rpc(&v["nativeRpcId"])?;
    let decision=text(v,"decision")?; known(decision,&["accept","deny"])?;
    atomic(db, || {
        let old=get_request(db,rid)?;
        for field in ["sessionId","turnId","attemptId","generation","nativeRpcId"] { ensure!(old[field]==v[field],"Permission identity conflict: {field}"); }
        live(db,v)?;
        if old["status"]=="answered" || old["status"]=="delivered" { ensure!(old["decision"]==decision,"Decision conflict"); return Ok(old); }
        ensure!(old["status"]=="pending" && old["decision"].is_null(),"Permission not pending");
        ensure!(db.execute("UPDATE provider_requests SET status='answered',decision=? WHERE id=? AND status='pending' AND decision IS NULL",params![decision,rid])?==1,"Permission CAS failed");
        Ok(response(get_request(db,rid)?,true))
    })
}
/// Actor-only delivery observation: call AFTER successful send_packet, retaining
/// the DB lock across send and this commit. Means bytes written, not execution.
/// Exact answered-only CAS; no authorization, no resend, no replay on mark failure.
pub fn mark_permission_delivered(db: &Connection, v: &Value) -> Result<Value> {
    ensure!(db.is_autocommit(),"mark_permission_delivered requires autocommit");
    keys(v,&["id","sessionId","turnId","attemptId","generation","nativeRpcId"])?;
    let rid=id(v,"id")?;request_uuid(rid)?;let native=rpc(&v["nativeRpcId"])?;
    let sid=id(v,"sessionId")?;let tid=id(v,"turnId")?;let aid=id(v,"attemptId")?;let gen_=generation(v)?;
    atomic(db, || {
        let old=get_request(db,rid)?;
        for field in ["sessionId","turnId","attemptId","generation","nativeRpcId"] {ensure!(old[field]==v[field],"Delivery identity conflict: {field}");}
        live(db,v)?;
        ensure!(old["status"]=="answered","Only an answered intent can be marked delivered");
        ensure!(db.execute("UPDATE provider_requests SET status='delivered' WHERE id=? AND session_id=? AND turn_id=? AND attempt_id=? AND generation=? AND native_rpc_id=? AND status='answered' AND decision IN ('accept','deny')",
            params![rid,sid,tid,aid,gen_,native])?==1,"Delivery CAS failed");
        get_request(db,rid)
    })
}
/// Native withdrawal / actor discard. No admission quota, no send authority.
/// Invalidating an intent retains its decision as history, never as delivery.
pub fn invalidate_request(db: &Connection, rid: &str, sid: &str, gen_: i64) -> Result<Value> {
    request_uuid(rid)?;bounded(sid,128,false)?;ensure!(gen_>0,"Invalid generation");
    atomic(db, || {
        let old=get_request(db,rid)?;
        let session=session_inner(db,sid)?;
        ensure!(old["sessionId"]==sid && old["generation"]==gen_ && session["generation"]==gen_,"Stale request invalidation identity");
        if old["status"]=="delivered" || old["status"]=="invalidated" {return Ok(old);}
        ensure!(db.execute("UPDATE provider_requests SET status='invalidated' WHERE id=? AND session_id=? AND generation=? AND status IN ('pending','answered')",
            params![rid,sid,gen_])?==1,"Request invalidation CAS failed");
        get_request(db,rid)
    })
}
/// Cancel intent is durably fenced before ONE wire interrupt. An interrupted
/// transport must instead be closed after confirmed quiescence; no auto resend.
pub fn cancel_turn(db: &Connection, v: &Value) -> Result<Value> {
    ensure!(db.is_autocommit(),"cancel_turn requires autocommit for durable shouldSend");
    keys(v,&["sessionId","turnId","attemptId","generation"])?;
    let sid=id(v,"sessionId")?;let tid=id(v,"turnId")?;let aid=id(v,"attemptId")?;let gen_=generation(v)?;
    atomic(db, || {
        execution_identity(db,v)?;
        let old=get_turn(db,tid)?;
        if old["status"]!="running" { return Ok(old); }
        live(db,v)?;
        ensure!(db.execute("UPDATE model_turns SET status='cancel_requested' WHERE id=? AND status='running'",[tid])?==1,"Cancel turn CAS failed");
        ensure!(db.execute("UPDATE model_attempts SET status='cancel_requested' WHERE id=? AND generation=? AND status='running'",params![aid,gen_])?==1,"Cancel attempt CAS failed");
        db.execute("UPDATE provider_requests SET status='invalidated' WHERE attempt_id=? AND status NOT IN ('delivered','invalidated')",[aid])?;
        db.execute("UPDATE codex_sessions SET status='cancel_requested' WHERE session_id=? AND generation=?",params![sid,gen_])?;
        Ok(response(get_turn(db,tid)?,true))
    })
}
// Exact session/turn/attempt/generation, accepting cancellation and safe final
// observations without granting permission to send or reopening anything.
fn execution_identity(db: &Connection, v: &Value) -> Result<()> {
    let sid=id(v,"sessionId")?;let tid=id(v,"turnId")?;let aid=id(v,"attemptId")?;let gen_=generation(v)?;
    parent_codex(db,sid)?;
    let session=session_inner(db,sid)?;let turn=get_turn(db,tid)?;
    ensure!(session["generation"]==gen_ && turn["sessionId"]==sid && turn["attemptId"]==aid && turn["generation"]==gen_,"Stale execution identity");
    Ok(())
}
/// Record an immutable native turn/start observation. A completion may precede
/// its ACK: binding a terminal row is allowed and never changes status/outcome.
pub fn bind_turn(db: &Connection, v: &Value) -> Result<Value> {
    keys(v,&["sessionId","turnId","attemptId","generation","nativeTurnId"])?;
    let tid=id(v,"turnId")?; let native=text(v,"nativeTurnId")?; bounded(native,256,false)?;
    atomic(db, || {
        execution_identity(db,v)?;
        ensure!(db.execute("UPDATE model_turns SET native_turn_id=? WHERE id=? AND (native_turn_id IS NULL OR native_turn_id=?)",
            params![native,tid,native])?==1,"Native turn binding conflict");
        get_turn(db,tid)
    })
}
/// Metadata-only fence. Parent requires needs_attention, a finished owned job
/// and explicit human acknowledgement. This does not attest process stop, release a writer or permit retry.
pub fn fence_session(db: &Connection, sid: &str, gen_: i64) -> Result<Value> {
    bounded(sid,128,false)?;ensure!(gen_>0,"Invalid generation");
    atomic(db, || {fence_inner(db,sid,gen_)?;session_inner(db,sid)})
}
fn fence_inner(db: &Connection, sid: &str, gen_: i64) -> Result<()> {
        parent_codex(db,sid)?;
        let stored:i64=db.query_row("SELECT generation FROM codex_sessions WHERE session_id=?",[sid],|r|r.get(0))?;
        ensure!(stored==gen_,"Stale fence generation");
        db.execute("UPDATE model_attempts SET status='interrupted',outcome='uncertain' WHERE turn_id IN
            (SELECT id FROM model_turns WHERE session_id=?) AND (status NOT IN ('completed','failed','interrupted') OR outcome IS NULL
            OR (status='completed' AND outcome!='success') OR (status='failed' AND outcome!='failed') OR (status='interrupted' AND outcome!='uncertain'))",[sid])?;
        db.execute("UPDATE model_turns SET status='interrupted' WHERE session_id=? AND
            (status NOT IN ('completed','failed','interrupted') OR NOT EXISTS(SELECT 1 FROM model_attempts a WHERE a.turn_id=model_turns.id)
            OR EXISTS(SELECT 1 FROM model_attempts a WHERE a.turn_id=model_turns.id AND COALESCE(a.status=model_turns.status AND a.outcome=CASE model_turns.status
            WHEN 'completed' THEN 'success' WHEN 'failed' THEN 'failed' ELSE 'uncertain' END,0)=0))",[sid])?;
        db.execute("UPDATE model_attempts SET status='interrupted',outcome='uncertain' WHERE turn_id IN
            (SELECT id FROM model_turns WHERE session_id=? AND status='interrupted')",[sid])?;
        db.execute("UPDATE provider_requests SET status='invalidated' WHERE session_id=? AND status NOT IN ('delivered','invalidated')",[sid])?;
        db.execute("UPDATE provider_commands SET state='uncertain' WHERE kind='start_turn' AND state NOT IN ('completed','uncertain')
            AND CASE WHEN json_valid(result) THEN json_extract(result,'$.sessionId') END=?",[sid])?;
        ensure!(db.execute("UPDATE codex_sessions SET status='interrupted' WHERE session_id=? AND generation=?",params![sid,gen_])?==1,"Fence CAS failed");
        Ok(())
}
/// Close ONLY after parent confirms owned process wait. The metadata fence alone
/// is never evidence of quiescence; unknown states remain conservatively uncertain.
pub fn close_session(db: &Connection, sid: &str, gen_: i64) -> Result<Value> {
    bounded(sid,128,false)?;ensure!(gen_>0,"Invalid generation");
    atomic(db, || {
        fence_inner(db,sid,gen_)?;
        ensure!(db.execute("UPDATE codex_sessions SET status='closed' WHERE session_id=? AND generation=?",params![sid,gen_])?==1,"Close CAS failed");
        session_inner(db,sid)
    })
}
/// Allowlisted read snapshot, <=32 KiB after JSON escaping. Latest turns are in
/// reverse insertion order. Requests are oldest first; truncation is explicit.
pub fn summary(db: &Connection, sid: &str) -> Result<Value> {
    bounded(sid,128,false)?;
    atomic(db, || {
        let mut out=session_inner(db,sid)?;
        let turns:i64=db.query_row("SELECT count(*) FROM model_turns WHERE session_id=?",[sid],|r|r.get(0))?;
        let has_native:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM model_turns WHERE session_id=? AND native_turn_id IS NOT NULL)",[sid],|r|r.get(0))?;
        out["hasNativeTurns"]=json!(has_native);
        let pending:i64=db.query_row("SELECT count(*) FROM provider_requests WHERE session_id=? AND status='pending'",[sid],|r|r.get(0))?;
        out["turns"]=json!([]);out["requests"]=json!([]);
        out["hasMoreTurns"]=json!(turns>16);out["hasMoreRequests"]=json!(pending>0);out["pendingRequestCount"]=json!(pending);
        let tids=db.prepare("SELECT id FROM model_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 16")?.query_map([sid],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for tid in tids {
            let t=get_turn(db,&tid)?;
            let projection=json!({"turnId":t["turnId"],"attemptId":t["attemptId"],"generation":t["generation"],
                "status":t["status"],"attemptStatus":t["attemptStatus"],"outcome":t["outcome"],"nativeTurnId":t["nativeTurnId"]});
            out["turns"].as_array_mut().unwrap().push(projection);
            if serde_json::to_vec(&out)?.len()>SUMMARY_BYTES-16 {
                out["turns"].as_array_mut().unwrap().pop();out["hasMoreTurns"]=json!(true);break;
            }
        }
        let rids=db.prepare("SELECT id FROM provider_requests WHERE session_id=? AND status='pending' ORDER BY rowid LIMIT 256")?.query_map([sid],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for rid in rids {
            let r=get_request(db,&rid)?;
            let projection=json!({"id":r["id"],"turnId":r["turnId"],"attemptId":r["attemptId"],"generation":r["generation"],
                "nativeRpcId":r["nativeRpcId"],"method":r["method"],"status":r["status"]});
            out["requests"].as_array_mut().unwrap().push(projection);
            if serde_json::to_vec(&out)?.len()>SUMMARY_BYTES-16 {out["requests"].as_array_mut().unwrap().pop();break;}
        }
        out["hasMoreRequests"]=json!((out["requests"].as_array().unwrap().len() as i64)<pending);
        ensure!(serde_json::to_vec(&out)?.len()<=SUMMARY_BYTES,"Stored metadata exceeds summary bound");
        Ok(out)
    })
}
/// Persist a safe terminal observation without new rows/admission checks.
pub fn finish_turn(db: &Connection, v: &Value) -> Result<Value> {
    keys(v,&["sessionId","turnId","attemptId","generation","status","nativeTurnId"])?;
    let tid=id(v,"turnId")?; let sid=id(v,"sessionId")?; let aid=id(v,"attemptId")?; let gen_=generation(v)?;
    let status=text(v,"status")?; known(status,&["completed","failed","interrupted"])?;
    let native=match &v["nativeTurnId"] { Value::Null=>None,Value::String(s)=>{bounded(s,256,false)?;Some(s.as_str())},_=>anyhow::bail!("Invalid nativeTurnId") };
    atomic(db, || {
        let old=get_turn(db,tid)?;
        ensure!(old["sessionId"]==sid && old["attemptId"]==aid && old["generation"]==gen_,"Finish identity conflict");
        if let (Some(old),Some(new))=(old["nativeTurnId"].as_str(),native) { ensure!(old==new,"Native turn binding conflict"); }
        if old["status"]!="running" && old["status"]!="cancel_requested" {
            ensure!(old["status"]==status && (native.is_none() || native.is_some_and(|n| old["nativeTurnId"]==n)),"Terminal turn conflict"); return Ok(old);
        }
        execution_identity(db,v)?;
        let session=session_inner(db,sid)?;
        ensure!(session["status"]==old["status"],"Session/turn state mismatch");
        let outcome=match status {"completed"=>"success","failed"=>"failed",_=>"uncertain"};
        ensure!(db.execute("UPDATE model_turns SET status=?,native_turn_id=COALESCE(native_turn_id,?) WHERE id=? AND status IN ('running','cancel_requested')",params![status,native,tid])?==1,"Turn CAS failed");
        ensure!(db.execute("UPDATE model_attempts SET status=?,outcome=? WHERE id=? AND status IN ('running','cancel_requested') AND generation=?",params![status,outcome,aid,gen_])?==1,"Attempt CAS failed");
        db.execute("UPDATE provider_requests SET status='invalidated' WHERE attempt_id=? AND status NOT IN ('delivered','invalidated')",[aid])?;
        db.execute("UPDATE codex_sessions SET status=? WHERE session_id=? AND generation=?",params![if status=="interrupted" {"interrupted"} else {"idle"},sid,gen_])?;
        get_turn(db,tid)
    })
}
/// Acknowledge a start command's native send/result. Unknown/uncertain commands
/// cannot be upgraded to completed. This API never authorizes sending.
pub fn finish_command(db: &Connection, v: &Value) -> Result<Value> {
    keys(v,&["commandId","result"])?; let cid=id(v,"commandId")?;
    ensure!(v.get("result").is_some(),"Missing result");
    let result=canonical(&v["result"])?; ensure!(result.len()<=1024,"Command result exceeds 1 KiB");
    atomic(db, || {
        let old=get_command(db,cid)?;
        if old["state"]=="completed" { ensure!(old["result"]==v["result"],"Command result conflict"); return Ok(old); }
        ensure!(old["state"]=="claimed","Command uncertain; reconcile without resend");
        ensure!(db.execute("UPDATE provider_commands SET state='completed',result=? WHERE id=? AND state='claimed'",params![result,cid])?==1,"Command completion CAS failed");
        get_command(db,cid)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const RID: &str = "00000000-0000-4000-8000-000000000001";
    fn db() -> Connection {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT NOT NULL);
            INSERT INTO sessions VALUES('s','codex'),('other','claude');").unwrap();
        init(&db).unwrap(); db
    }
    fn attach(db: &Connection) { attach_session(db,&json!({"sessionId":"s","expectedGeneration":0})).unwrap(); }
    fn start() -> Value { json!({"commandId":"c","sessionId":"s","turnId":"t","attemptId":"a","generation":1,"prompt":"hola"}) }
    fn request() -> Value { json!({"id":RID,"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"nativeRpcId":7,"method":"opaque/approval","payload":{"scope":"once"}}) }
    fn answer() -> Value { let mut v=request(); v.as_object_mut().unwrap().remove("method");v.as_object_mut().unwrap().remove("payload");v["decision"]=json!("deny");v }
    fn finish(status: &str) -> Value { json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"status":status}) }
    fn live_db() -> Connection { let db=db();attach(&db);start_turn(&db,&start()).unwrap();db }

    #[test]
    fn schema_exact_readonly_partial_and_nested_init() {
        let db=db();
        db.execute_batch("PRAGMA user_version=4; SAVEPOINT parent;").unwrap();
        init(&db).unwrap();
        assert_eq!(db.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),4);
        assert!(!db.is_autocommit());
        db.execute_batch("ROLLBACK TO parent; RELEASE parent; PRAGMA query_only=ON;").unwrap();
        validate_schema(&db).unwrap();
        db.execute_batch("PRAGMA query_only=OFF; CREATE TRIGGER injected AFTER INSERT ON model_turns BEGIN SELECT 1; END;").unwrap();
        assert!(validate_schema(&db).is_err()); assert!(init(&db).is_err());
        db.execute_batch("DROP TRIGGER injected; DROP INDEX codex_attempt_turn;").unwrap();
        assert!(init(&db).is_err());
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name='codex_attempt_turn'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn attach_parent_kind_binding_and_generation() {
        let db=db();
        assert!(attach_session(&db,&json!({"sessionId":"missing","expectedGeneration":0})).is_err());
        assert!(attach_session(&db,&json!({"sessionId":"other","expectedGeneration":0})).is_err());
        attach(&db);
        bind_thread(&db,"s",1,"thread").unwrap(); bind_thread(&db,"s",1,"thread").unwrap();
        assert!(bind_thread(&db,"s",1,"different").is_err());
        assert!(attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1,"nativeThreadId":"different"})).is_err());
        let next=attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).unwrap();
        assert_eq!(next["generation"],2); assert_eq!(next["nativeThreadId"],"thread");
        assert!(start_turn(&db,&start()).is_err());
    }
    #[test]
    fn start_dedup_digest_no_retry_and_atomic_rollback() {
        let db=db();attach(&db);
        assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],true);
        assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],false);
        let mut conflicting=start();conflicting["prompt"]=json!("otro");
        assert!(start_turn(&db,&conflicting).is_err());
        let mut second=start();second["commandId"]=json!("new");
        assert!(start_turn(&db,&second).is_err());
        assert_eq!(count(&db,"provider_commands").unwrap(),1);
        assert!(attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).is_err());
        recover(&db).unwrap();
        assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
        assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],false);
        assert!(start_turn(&db,&second).is_err());
        attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).unwrap();
        second["generation"]=json!(2); // same turn id forces rollback after command insertion
        assert!(start_turn(&db,&second).is_err());
        assert_eq!(count(&db,"provider_commands").unwrap(),1);
        assert_eq!(get_session(&db,"s").unwrap()["status"],"idle");
    }
    #[test]
    fn permission_typed_id_cas_scope_and_conflicts() {
        let db=live_db();let req=request();
        assert_eq!(record_request(&db,&req).unwrap()["shouldSend"],false);
        assert_eq!(record_request(&db,&req).unwrap()["nativeRpcId"],7);
        assert_eq!(record_request(&db,&req).unwrap()["shouldSend"],false);
        let mut other=req.clone();other["id"]=json!("00000000-0000-4000-8000-000000000002");
        assert!(record_request(&db,&other).is_err());
        other["nativeRpcId"]=json!("7");
        record_request(&db,&other).unwrap(); // numeric and string IDs are distinct
        let mut ans=answer();ans["nativeRpcId"]=json!("7");assert!(answer_permission(&db,&ans).is_err());
        ans=answer();ans["attemptId"]=json!("wrong");assert!(answer_permission(&db,&ans).is_err());
        ans=answer();ans["decision"]=json!("acceptForSession");assert!(answer_permission(&db,&ans).is_err());
        assert_eq!(answer_permission(&db,&answer()).unwrap()["shouldSend"],true);
        assert_eq!(answer_permission(&db,&answer()).unwrap()["shouldSend"],false);
        ans=answer();ans["decision"]=json!("accept");assert!(answer_permission(&db,&ans).is_err());
        ans=answer();ans["scope"]=json!("all");assert!(answer_permission(&db,&ans).is_err());
    }
    #[test]
    fn late_permissions_interruption_reconnect_and_recovery() {
        for recover_first in [false,true] {
            let db=live_db();record_request(&db,&request()).unwrap();
            if recover_first { recover(&db).unwrap(); } else { finish_turn(&db,&finish("interrupted")).unwrap(); }
            assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
            assert!(answer_permission(&db,&answer()).is_err());
            attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).unwrap();
            let mut next=start();next["commandId"]=json!("c2");next["turnId"]=json!("t2");next["attemptId"]=json!("a2");next["generation"]=json!(2);
            start_turn(&db,&next).unwrap();
            assert!(answer_permission(&db,&answer()).is_err());
            let mut forged=answer();forged["generation"]=json!(2);assert!(answer_permission(&db,&forged).is_err());
        }
    }
    #[test]
    fn recover_unknown_states_fail_closed_and_idempotent() {
        let db=live_db();record_request(&db,&request()).unwrap();
        db.execute_batch("UPDATE model_turns SET status='future'; UPDATE model_attempts SET status='future',outcome='future';
            UPDATE codex_sessions SET status='future'; UPDATE provider_requests SET status='future';
            UPDATE provider_commands SET state='future';").unwrap();
        assert!(get_turn(&db,"t").is_err());assert!(get_session(&db,"s").is_err());
        assert!(get_request(&db,RID).is_err());assert!(get_command(&db,"c").is_err());
        assert!(answer_permission(&db,&answer()).is_err());assert!(start_turn(&db,&start()).is_err());
        recover(&db).unwrap();
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert_eq!(get_session(&db,"s").unwrap()["status"],"interrupted");
        assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
        let before=get_command(&db,"c").unwrap();recover(&db).unwrap();assert_eq!(before,get_command(&db,"c").unwrap());
        assert!(finish_command(&db,&json!({"commandId":"c","result":{}})).is_err());
    }
    #[test]
    fn bounds_utf8_and_atomic_rejection() {
        let db=db();attach(&db);
        let mut v=start();v["prompt"]=json!("é".repeat(PROMPT_BYTES/2+1));
        assert!(start_turn(&db,&v).is_err());assert_eq!(count(&db,"provider_commands").unwrap(),0);
        v["prompt"]=json!("é".repeat(PROMPT_BYTES/2));start_turn(&db,&v).unwrap();
        let mut req=request();req["payload"]=json!("x".repeat(16384));assert!(record_request(&db,&req).is_err());
        req=request();req["nativeRpcId"]=Value::Null;assert!(record_request(&db,&req).is_err());
        req["nativeRpcId"]=json!(1.5);assert!(record_request(&db,&req).is_err());
        req=request();req["id"]=json!("not-local-uuid");assert!(record_request(&db,&req).is_err());
        assert_eq!(count(&db,"provider_requests").unwrap(),0);
    }
    #[test]
    fn pending_quota_preserves_permission_and_finish_space() {
        let db=live_db();
        for i in 0..256 { let mut req=request();req["id"]=json!(format!("00000000-0000-4000-8000-{i:012x}"));req["nativeRpcId"]=json!(i);record_request(&db,&req).unwrap(); }
        let mut req=request();req["id"]=json!("00000000-0000-4000-8000-000000001000");req["nativeRpcId"]=json!(1000);
        assert!(record_request(&db,&req).is_err());
        let mut ans=answer();ans["nativeRpcId"]=json!(1);answer_permission(&db,&ans).unwrap();
        assert!(record_request(&db,&req).is_err()); // answered intent still occupies an outstanding slot
        let mut identity=ans.clone();identity.as_object_mut().unwrap().remove("decision");
        mark_permission_delivered(&db,&identity).unwrap();
        record_request(&db,&req).unwrap();
        finish_turn(&db,&finish("completed")).unwrap();
        assert!(answer_permission(&db,&ans).is_err());
        assert_eq!(get_turn(&db,"t").unwrap()["status"],"completed");
    }
    #[test]
    fn terminal_writes_when_both_budgets_exhausted() {
        let db=live_db();record_request(&db,&request()).unwrap();
        // Trusted SQL fixtures fill retained reservations, without changing limits.
        for i in 1..4096 { db.execute("INSERT INTO provider_commands VALUES(?,'hash','start_turn','completed','null')",[format!("fill{i}")]).unwrap(); }
        let mut i=0;
        while budget(&db,4096+16384).is_ok() {
            db.execute("INSERT INTO provider_requests VALUES(?,'s','t','a',1,?,'fixture',?,'invalidated',NULL)",
                params![format!("10000000-0000-4000-8000-{i:012x}"),format!("\"fill{i}\""),"x".repeat(16384)]).unwrap();i+=1;
        }
        assert!(budget(&db,2048).is_err());
        let before=count(&db,"provider_requests").unwrap();
        let mut extra=request();extra["id"]=json!("20000000-0000-4000-8000-000000000001");extra["nativeRpcId"]=json!(9000);
        assert!(record_request(&db,&extra).is_err());assert_eq!(count(&db,"provider_requests").unwrap(),before);
        assert_eq!(answer_permission(&db,&answer()).unwrap()["shouldSend"],true);
        assert_eq!(mark_permission_delivered(&db,&permission_identity()).unwrap()["status"],"delivered");
        finish_command(&db,&json!({"commandId":"c","result":"r".repeat(1022)})).unwrap();
        let mut end=finish("completed");end["nativeTurnId"]=json!("n".repeat(256));
        finish_turn(&db,&end).unwrap();assert_eq!(finish_turn(&db,&end).unwrap()["shouldSend"],false);
        recover(&db).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["status"],"completed");
    }
    #[test]
    fn row_caps_and_command_quota_fail_atomically() {
        let db=db();attach(&db);
        for i in 1..256 { db.execute("INSERT INTO sessions VALUES(?,'codex')",[format!("s{i}")]).unwrap();db.execute("INSERT INTO codex_sessions VALUES(?,NULL,1,'idle')",[format!("s{i}")]).unwrap(); }
        db.execute("INSERT INTO sessions VALUES('overflow','codex')",[]).unwrap();
        assert!(attach_session(&db,&json!({"sessionId":"overflow","expectedGeneration":0})).is_err());
        for i in 0..4096 { db.execute("INSERT INTO provider_commands VALUES(?,'hash','start_turn','completed','null')",[format!("fill{i}")]).unwrap(); }
        assert!(start_turn(&db,&start()).is_err());
        assert_eq!(count(&db,"model_turns").unwrap(),0);
        db.execute("DELETE FROM provider_commands",[]).unwrap();
        for i in 0..2048 { db.execute("INSERT INTO model_turns VALUES(?,'s','',NULL,'completed')",[format!("t{i}")]).unwrap(); }
        assert!(start_turn(&db,&start()).is_err()); assert_eq!(count(&db,"provider_commands").unwrap(),0);
    }
    #[test]
    fn bindings_terminal_observations_and_command_results() {
        let db=live_db();
        let binding=json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"nativeTurnId":"native"});
        assert_eq!(bind_turn(&db,&binding).unwrap()["shouldSend"],false);
        bind_turn(&db,&binding).unwrap();
        let mut wrong=binding.clone();wrong["nativeTurnId"]=json!("different");assert!(bind_turn(&db,&wrong).is_err());
        wrong=binding.clone();wrong["generation"]=json!(2);assert!(bind_turn(&db,&wrong).is_err());
        let done=json!({"commandId":"c","result":{"nativeTurnId":"native"}});
        finish_command(&db,&done).unwrap();assert_eq!(finish_command(&db,&done).unwrap()["shouldSend"],false);
        assert!(finish_command(&db,&json!({"commandId":"c","result":{}})).is_err());
        assert!(finish_command(&db,&json!({"commandId":"c","result":"x".repeat(1024)})).is_err());
        finish_turn(&db,&finish("failed")).unwrap();
        assert_eq!(get_turn(&db,"t").unwrap()["nativeTurnId"],"native");
        assert!(finish_turn(&db,&finish("completed")).is_err());
        assert_eq!(bind_turn(&db,&binding).unwrap()["status"],"failed");
        recover(&db).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"failed");
        assert_eq!(get_command(&db,"c").unwrap()["state"],"completed");
    }
    #[test]
    fn malformed_state_pairs_do_not_authorize() {
        let db=live_db();record_request(&db,&request()).unwrap();
        db.execute_batch("UPDATE provider_requests SET status='answered'; UPDATE model_attempts SET outcome='success';").unwrap();
        assert!(get_request(&db,RID).is_err()); assert!(answer_permission(&db,&answer()).is_err());
        assert!(get_turn(&db,"t").is_err());
        db.execute_batch("UPDATE codex_sessions SET status='idle';UPDATE model_turns SET status='completed';UPDATE model_attempts SET status='future';").unwrap();
        let mut next=start();next["commandId"]=json!("c2");next["turnId"]=json!("t2");next["attemptId"]=json!("a2");
        assert!(start_turn(&db,&next).is_err());
        assert!(attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).is_err());
        recover(&db).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
    }
    #[test]
    fn effect_claims_refuse_outer_transaction() {
        let db=live_db();record_request(&db,&request()).unwrap();
        db.execute_batch("SAVEPOINT outer_scope;").unwrap();
        assert!(start_turn(&db,&start()).is_err());assert!(answer_permission(&db,&answer()).is_err());assert!(cancel_turn(&db,&cancel()).is_err());
        db.execute_batch("RELEASE outer_scope;").unwrap();
        assert_eq!(answer_permission(&db,&answer()).unwrap()["shouldSend"],true);
    }
    fn cancel() -> Value { json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1}) }
    #[test]
    fn cancel_fences_permissions_until_native_final_no_resend() {
        let db=live_db();record_request(&db,&request()).unwrap();
        let cancelled=cancel_turn(&db,&cancel()).unwrap();
        assert_eq!(cancelled["shouldSend"],true);assert_eq!(cancelled["status"],"cancel_requested");
        assert!(cancelled["outcome"].is_null());assert_eq!(cancelled["attemptStatus"],"cancel_requested");
        assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
        assert!(answer_permission(&db,&answer()).is_err());
        assert_eq!(cancel_turn(&db,&cancel()).unwrap()["shouldSend"],false);
        assert!(attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).is_err());
        let mut next=start();next["commandId"]=json!("c2");next["turnId"]=json!("t2");next["attemptId"]=json!("a2");
        assert!(start_turn(&db,&next).is_err());
        let mut req=request();req["id"]=json!("00000000-0000-4000-8000-000000000002");req["nativeRpcId"]=json!(2);
        assert!(record_request(&db,&req).is_err());
        let binding=json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"nativeTurnId":"native"});
        assert_eq!(bind_turn(&db,&binding).unwrap()["status"],"cancel_requested");
        finish_turn(&db,&finish("completed")).unwrap();
        assert_eq!(bind_turn(&db,&binding).unwrap()["status"],"completed");
        assert_eq!(cancel_turn(&db,&cancel()).unwrap()["shouldSend"],false);
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"success");
        assert_eq!(start_turn(&db,&next).unwrap()["shouldSend"],true);
    }
    #[test]
    fn completion_before_native_ack_never_reopens() {
        let db=live_db();finish_turn(&db,&finish("completed")).unwrap();
        let binding=json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"nativeTurnId":"late"});
        let v=bind_turn(&db,&binding).unwrap();assert_eq!(v["status"],"completed");assert_eq!(v["outcome"],"success");
        assert_eq!(v["shouldSend"],false);bind_turn(&db,&binding).unwrap();
        let mut different=binding.clone();different["nativeTurnId"]=json!("wrong");assert!(bind_turn(&db,&different).is_err());
        assert_eq!(get_session(&db,"s").unwrap()["status"],"idle");
    }
    #[test]
    fn owned_quiescence_closes_only_expected_generation() {
        let db=live_db();record_request(&db,&request()).unwrap();cancel_turn(&db,&cancel()).unwrap();
        assert!(close_session(&db,"s",2).is_err());
        assert_eq!(close_session(&db,"s",1).unwrap()["status"],"closed");
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
        assert!(answer_permission(&db,&answer()).is_err());assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],false);
        assert_eq!(close_session(&db,"s",1).unwrap()["shouldSend"],false);
        recover(&db).unwrap();assert_eq!(get_session(&db,"s").unwrap()["status"],"closed");
        attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).unwrap();
        assert!(close_session(&db,"s",1).is_err());assert!(answer_permission(&db,&answer()).is_err());
        let binding=json!({"sessionId":"s","turnId":"t","attemptId":"a","generation":1,"nativeTurnId":"late"});
        assert!(bind_turn(&db,&binding).is_err());
    }
    #[test]
    fn close_and_recovery_fence_unknown_cancel_states() {
        let db=live_db();record_request(&db,&request()).unwrap();
        db.execute_batch("UPDATE codex_sessions SET status='future';UPDATE model_turns SET status='future';UPDATE model_attempts SET status='future';UPDATE provider_requests SET status='future';").unwrap();
        close_session(&db,"s",1).unwrap();
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert_eq!(summary(&db,"s").unwrap()["status"],"closed");
        let db=live_db();record_request(&db,&request()).unwrap();cancel_turn(&db,&cancel()).unwrap();
        recover(&db).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert_eq!(cancel_turn(&db,&cancel()).unwrap()["shouldSend"],false);
    }
    #[test]
    fn summary_is_bounded_allowlisted_latest_sixteen() {
        let db=db();attach(&db);
        for i in 0..20 {
            let mut input=start();input["commandId"]=json!(format!("c{i}"));input["turnId"]=json!(format!("t{i}"));input["attemptId"]=json!(format!("a{i}"));input["prompt"]=json!("secret".repeat(5000));
            start_turn(&db,&input).unwrap();
            if i<19 {let mut end=finish("completed");end["turnId"]=input["turnId"].clone();end["attemptId"]=input["attemptId"].clone();finish_turn(&db,&end).unwrap();}
        }
        for i in 0..256 {
            let mut req=request();req["id"]=json!(format!("00000000-0000-4000-8000-{i:012x}"));req["nativeRpcId"]=json!(i);req["turnId"]=json!("t19");req["attemptId"]=json!("a19");req["method"]=json!("\u{1}".repeat(128));
            req["payload"]=json!({"neverExpose":"private"});record_request(&db,&req).unwrap();
        }
        bind_turn(&db,&json!({"sessionId":"s","turnId":"t19","attemptId":"a19","generation":1,"nativeTurnId":"native-last"})).unwrap();
        let out=summary(&db,"s").unwrap();assert_eq!(out["turns"][0]["nativeTurnId"],"native-last");let encoded=serde_json::to_vec(&out).unwrap();
        assert!(encoded.len()<=SUMMARY_BYTES);assert_eq!(out["turns"].as_array().unwrap().len(),16);
        assert_eq!(out["turns"][0]["turnId"],"t19");assert_eq!(out["turns"][15]["turnId"],"t4");
        assert_eq!(out["hasMoreTurns"],true);assert_eq!(out["hasMoreRequests"],true);assert_eq!(out["pendingRequestCount"],256);
        assert!(!out["requests"].as_array().unwrap().is_empty());
        assert!(!String::from_utf8(encoded).unwrap().contains("secret"));
        for t in out["turns"].as_array().unwrap() { assert!(t.get("prompt").is_none());assert!(t.get("attemptId").is_some()); }
        for r in out["requests"].as_array().unwrap() {assert!(r.get("payload").is_none());assert!(r.get("decision").is_none());}
        assert_eq!(out["shouldSend"],false);
    }
    #[test]
    fn cancel_close_reserve_survives_exhausted_admission() {
        let db=live_db();record_request(&db,&request()).unwrap();
        let mut i=0;
        while budget(&db,4096+16384).is_ok() {
            db.execute("INSERT INTO provider_requests VALUES(?,'s','t','a',1,?,'fixture',?,'invalidated',NULL)",params![format!("10000000-0000-4000-8000-{i:012x}"),format!("\"fill{i}\""),"x".repeat(16384)]).unwrap();i+=1;
        }
        assert!(budget(&db,2048).is_err());
        answer_permission(&db,&answer()).unwrap();
        assert_eq!(cancel_turn(&db,&cancel()).unwrap()["shouldSend"],true);
        assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
        close_session(&db,"s",1).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
    }
    #[test]
    fn disk_reopen_recovers_claim_without_resend() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("ledger.sqlite");
        {
            let db=Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT);INSERT INTO sessions VALUES('s','codex');").unwrap();
            init(&db).unwrap();attach(&db);assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],true);
            record_request(&db,&request()).unwrap();
        }
        let db=Connection::open(&path).unwrap();init(&db).unwrap();
        assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],false);
        assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert!(answer_permission(&db,&answer()).is_err());
    }
    fn permission_identity() -> Value {let mut v=answer();v.as_object_mut().unwrap().remove("decision");v}
    fn accept() -> Value {let mut v=answer();v["decision"]=json!("accept");v}
    #[test]
    fn dropped_answer_intent_is_invalidated_not_delivered() {
        let db=live_db();record_request(&db,&request()).unwrap();
        assert_eq!(answer_permission(&db,&accept()).unwrap()["status"],"answered");
        assert_eq!(answer_permission(&db,&accept()).unwrap()["shouldSend"],false);
        let out=summary(&db,"s").unwrap();assert_eq!(out["pendingRequestCount"],0);assert_eq!(out["requests"],json!([]));
        assert!(invalidate_request(&db,RID,"s",2).is_err());
        assert!(invalidate_request(&db,RID,"other",1).is_err());
        let dropped=invalidate_request(&db,RID,"s",1).unwrap();assert_eq!(dropped["status"],"invalidated");
        assert_eq!(dropped["decision"],"accept");assert_eq!(dropped["shouldSend"],false);
        assert_eq!(invalidate_request(&db,RID,"s",1).unwrap(),dropped);
        assert!(answer_permission(&db,&accept()).is_err());assert!(mark_permission_delivered(&db,&permission_identity()).is_err());
        // Withdrawing a pending native request is also terminal, without a decision.
        let mut req=request();req["id"]=json!("00000000-0000-4000-8000-000000000002");req["nativeRpcId"]=json!(8);
        record_request(&db,&req).unwrap();let v=invalidate_request(&db,text(&req,"id").unwrap(),"s",1).unwrap();assert!(v["decision"].is_null());
    }
    #[test]
    fn every_teardown_invalidates_answered_accept_but_keeps_intent_history() {
        for path in ["cancel","finish","close","recover","fence"] {
            let db=live_db();record_request(&db,&request()).unwrap();answer_permission(&db,&accept()).unwrap();
            match path {
                "cancel"=>{cancel_turn(&db,&cancel()).unwrap();},
                "finish"=>{finish_turn(&db,&finish("completed")).unwrap();},
                "close"=>{close_session(&db,"s",1).unwrap();},
                "fence"=>{fence_session(&db,"s",1).unwrap();},
                _=>{recover(&db).unwrap();},
            }
            let v=get_request(&db,RID).unwrap();assert_eq!(v["status"],"invalidated","{path}");assert_eq!(v["decision"],"accept");
            assert!(mark_permission_delivered(&db,&permission_identity()).is_err());assert!(answer_permission(&db,&accept()).is_err());
        }
    }
    #[test]
    fn delivered_records_bytes_written_never_execution_or_resend() {
        let db=live_db();record_request(&db,&request()).unwrap();
        assert!(mark_permission_delivered(&db,&permission_identity()).is_err());
        answer_permission(&db,&accept()).unwrap();
        for field in ["sessionId","turnId","attemptId","generation","nativeRpcId"] {
            let mut wrong=permission_identity();wrong[field]=if field=="generation"{json!(2)}else{json!("wrong")};
            assert!(mark_permission_delivered(&db,&wrong).is_err(),"{field}");
        }
        db.execute_batch("SAVEPOINT outer_delivery;").unwrap();
        assert!(mark_permission_delivered(&db,&permission_identity()).is_err());db.execute_batch("RELEASE outer_delivery;").unwrap();
        // Simulate the trusted actor's successful send boundary; no provider calls.
        let delivered=mark_permission_delivered(&db,&permission_identity()).unwrap();
        assert_eq!(delivered["status"],"delivered");assert_eq!(delivered["decision"],"accept");assert_eq!(delivered["shouldSend"],false);
        assert_eq!(get_turn(&db,"t").unwrap()["status"],"running");assert!(get_turn(&db,"t").unwrap()["outcome"].is_null());
        assert_eq!(answer_permission(&db,&accept()).unwrap()["shouldSend"],false);
        assert!(answer_permission(&db,&answer()).is_err());assert!(mark_permission_delivered(&db,&permission_identity()).is_err());
        assert_eq!(invalidate_request(&db,RID,"s",1).unwrap()["status"],"delivered");
        cancel_turn(&db,&cancel()).unwrap();assert_eq!(get_request(&db,RID).unwrap()["status"],"delivered");
        finish_turn(&db,&finish("interrupted")).unwrap();close_session(&db,"s",1).unwrap();recover(&db).unwrap();
        assert_eq!(get_request(&db,RID).unwrap()["status"],"delivered");assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");
        assert!(answer_permission(&db,&accept()).is_err());
    }
    #[test]
    fn recovered_delivery_persists_but_unwritten_answer_does_not() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("delivery.sqlite");
        let second="00000000-0000-4000-8000-000000000002";
        {
            let db=Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT);INSERT INTO sessions VALUES('s','codex');").unwrap();
            init(&db).unwrap();attach(&db);start_turn(&db,&start()).unwrap();record_request(&db,&request()).unwrap();
            answer_permission(&db,&accept()).unwrap();mark_permission_delivered(&db,&permission_identity()).unwrap();
            let mut req=request();req["id"]=json!(second);req["nativeRpcId"]=json!(8);record_request(&db,&req).unwrap();
            let mut ans=accept();ans["id"]=json!(second);ans["nativeRpcId"]=json!(8);answer_permission(&db,&ans).unwrap();
        }
        let db=Connection::open(&path).unwrap();init(&db).unwrap();
        assert_eq!(get_request(&db,RID).unwrap()["status"],"delivered");assert_eq!(get_request(&db,second).unwrap()["status"],"invalidated");
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");assert_eq!(summary(&db,"s").unwrap()["requests"],json!([]));
        recover(&db).unwrap();assert_eq!(get_request(&db,RID).unwrap()["status"],"delivered");
    }
    #[test]
    fn close_fences_claimed_starts_only_in_its_session() {
        let db=live_db();db.execute("INSERT INTO sessions VALUES('s2','codex')",[]).unwrap();
        attach_session(&db,&json!({"sessionId":"s2","expectedGeneration":0})).unwrap();
        let mut next=start();next["commandId"]=json!("c2");next["sessionId"]=json!("s2");next["turnId"]=json!("t2");next["attemptId"]=json!("a2");start_turn(&db,&next).unwrap();
        db.execute("INSERT INTO provider_commands VALUES('done','digest','start_turn','completed',?)",[r#"{"sessionId":"s"}"#]).unwrap();
        assert!(close_session(&db,"s",2).is_err());assert_eq!(get_command(&db,"c").unwrap()["state"],"claimed");
        close_session(&db,"s",1).unwrap();assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
        assert_eq!(get_command(&db,"c2").unwrap()["state"],"claimed");assert_eq!(get_command(&db,"done").unwrap()["state"],"completed");
        assert_eq!(start_turn(&db,&start()).unwrap()["shouldSend"],false);
        assert!(finish_command(&db,&json!({"commandId":"c","result":{}})).is_err());
    }
    #[test]
    fn metadata_fence_cannot_grant_or_attest_quiescence() {
        let db=live_db();record_request(&db,&request()).unwrap();answer_permission(&db,&accept()).unwrap();
        assert!(fence_session(&db,"s",2).is_err());assert_eq!(get_request(&db,RID).unwrap()["status"],"answered");
        let fenced=fence_session(&db,"s",1).unwrap();assert_eq!(fenced["status"],"interrupted");assert_eq!(fenced["shouldSend"],false);
        assert!(fenced.get("waitConfirmed").is_none());assert!(fenced.get("writerReleased").is_none());
        assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
        let mut next=start();next["commandId"]=json!("next");next["turnId"]=json!("next");next["attemptId"]=json!("next");
        assert!(start_turn(&db,&next).is_err());assert!(answer_permission(&db,&accept()).is_err());assert!(mark_permission_delivered(&db,&permission_identity()).is_err());
        assert_eq!(fence_session(&db,"s",1).unwrap(),fenced);recover(&db).unwrap();assert_eq!(get_session(&db,"s").unwrap()["status"],"interrupted");
        // Unknown states are fenced durably too, without inferring success.
        db.execute_batch("UPDATE codex_sessions SET status='future';UPDATE model_turns SET status='future';UPDATE model_attempts SET status='future';UPDATE provider_requests SET status='future';UPDATE provider_commands SET state='future';").unwrap();
        fence_session(&db,"s",1).unwrap();assert_eq!(get_turn(&db,"t").unwrap()["outcome"],"uncertain");assert_eq!(get_request(&db,RID).unwrap()["status"],"invalidated");
        assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
    }
    #[test]
    fn summary_native_history_is_session_scoped_beyond_latest_sixteen() {
        let db=db();attach(&db);assert_eq!(summary(&db,"s").unwrap()["hasNativeTurns"],false);
        for i in 0..18 {
            let mut input=start();input["commandId"]=json!(format!("c{i}"));input["turnId"]=json!(format!("t{i}"));input["attemptId"]=json!(format!("a{i}"));
            start_turn(&db,&input).unwrap();
            let mut end=finish("completed");end["turnId"]=input["turnId"].clone();end["attemptId"]=input["attemptId"].clone();
            if i==0 {end["nativeTurnId"]=json!("old-native");}
            finish_turn(&db,&end).unwrap();
        }
        let out=summary(&db,"s").unwrap();assert_eq!(out["hasNativeTurns"],true);assert_eq!(out["hasMoreTurns"],true);
        assert_eq!(out["turns"].as_array().unwrap().len(),16);
        assert!(out["turns"].as_array().unwrap().iter().all(|t|t["nativeTurnId"].is_null()));
        assert!(serde_json::to_vec(&out).unwrap().len()<=SUMMARY_BYTES);assert_eq!(out["shouldSend"],false);
        db.execute("INSERT INTO sessions VALUES('s2','codex')",[]).unwrap();
        attach_session(&db,&json!({"sessionId":"s2","expectedGeneration":0})).unwrap();
        assert_eq!(summary(&db,"s2").unwrap()["hasNativeTurns"],false);
        // Reattach changes generation, never discards historical native existence.
        attach_session(&db,&json!({"sessionId":"s","expectedGeneration":1})).unwrap();
        assert_eq!(summary(&db,"s").unwrap()["hasNativeTurns"],true);
    }
    #[test]
    fn fence_and_close_make_claimed_and_unknown_commands_uncertain() {
        for close in [false,true] {
            let db=live_db();
            db.execute("INSERT INTO provider_commands VALUES('unknown','digest','start_turn','future',?)",[r#"{"sessionId":"s","decision":"unknown"}"#]).unwrap();
            record_request(&db,&request()).unwrap();
            db.execute("UPDATE provider_requests SET status='answered',decision='unknown'",[]).unwrap();
            assert!(get_request(&db,RID).is_err());
            if close {close_session(&db,"s",1).unwrap();} else {fence_session(&db,"s",1).unwrap();}
            assert_eq!(get_command(&db,"c").unwrap()["state"],"uncertain");
            assert_eq!(get_command(&db,"unknown").unwrap()["state"],"uncertain");
            let state:String=db.query_row("SELECT status FROM provider_requests WHERE id=?",[RID],|r|r.get(0)).unwrap();assert_eq!(state,"invalidated");
            assert!(get_request(&db,RID).is_err()); // Unknown decisions never become grants.
            assert!(answer_permission(&db,&accept()).is_err());assert!(mark_permission_delivered(&db,&permission_identity()).is_err());
        }
    }
    #[test]
    fn delivered_requires_decision_and_known_decision_values() {
        let db=live_db();record_request(&db,&request()).unwrap();
        db.execute("UPDATE provider_requests SET status='delivered'",[]).unwrap();assert!(get_request(&db,RID).is_err());
        db.execute("UPDATE provider_requests SET decision='future'",[]).unwrap();assert!(get_request(&db,RID).is_err());
        db.execute("UPDATE provider_requests SET status='pending',decision='accept'",[]).unwrap();assert!(get_request(&db,RID).is_err());
    }
    #[test]
    fn concurrent_connections_send_at_most_once() {
        let dir=tempfile::tempdir().unwrap(); let path=dir.path().join("ledger.sqlite");
        let db=Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT);INSERT INTO sessions VALUES('s','codex');").unwrap();
        init(&db).unwrap();attach(&db);drop(db);
        fn race(path: &std::path::Path, permission: bool) -> usize {
            let barrier=std::sync::Arc::new(std::sync::Barrier::new(8));
            let workers:Vec<_>=(0..8).map(|_|{let path=path.to_owned();let barrier=barrier.clone();std::thread::spawn(move||{
                let db=Connection::open(path).unwrap();db.busy_timeout(std::time::Duration::from_secs(3)).unwrap();
                barrier.wait();let result=if permission {answer_permission(&db,&answer())}else{start_turn(&db,&start())};
                result.ok().is_some_and(|v|v["shouldSend"]==true) as usize
            })}).collect();workers.into_iter().map(|w|w.join().unwrap()).sum()
        }
        assert_eq!(race(&path,false),1);
        let db=Connection::open(&path).unwrap();record_request(&db,&request()).unwrap();drop(db);
        assert_eq!(race(&path,true),1);
        let db=Connection::open(&path).unwrap();assert_eq!(count(&db,"model_turns").unwrap(),1);
        assert_eq!(answer_permission(&db,&answer()).unwrap()["shouldSend"],false);
    }
}

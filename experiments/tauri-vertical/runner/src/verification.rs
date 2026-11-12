//! Durable verification ledger; no command execution or process signalling here.
//!
//! Frozen contract: every run object uses `id` for the task and `runId` for the
//! server-generated run. `status` is prepared/running/cancel_requested/completed/
//! not_executed/cancelled/needs_attention/released/purged; `outcome` is passed/mutated/
//! failed/cancelled/timeout/output_limit/uncertain/not_executed/purged. `verification`
//! is verified only for a clean exit-zero with equal fingerprints, otherwise
//! not_verified. The unmodified process result lives under `process`.
//!
//! All responses contain ephemeral `shouldExecute:false`, except the ONE successful
//! begin CAS response. Only that response authorizes one call to the executor,
//! using its `argv` and `cwd`. Never execute a get/prepare/retry response. An exec
//! error must still reach finish as a process result (e.g. status failed,
//! spawned:false); abandoning it leaves a recovery fence. A lost begin response
//! is deliberately NOT replayable. Approval expires after 300 seconds.
//!
//! Parent holds its workspace gate across prepare/begin/capture_for_run and across
//! competing writer admission; releases it BEFORE executing and before joining
//! workers. This module never acquires that gate. DB guards never span capture,
//! filesystem canonicalization, or projects::ready/Git. External writers remain
//! outside the gate; a fingerprint is evidence, not a filesystem sandbox.
//!
//! init is startup-only, nestable inside the parent's migration transaction and
//! never changes user_version. Recovered live runs require explicit release;
//! prepared approvals are cancelled. Purged tombstones retain request digests,
//! IDs, nonce hashes and fingerprints forever; exact request retries return the
//! tombstone and never recreate evidence or authorization. Purge invalidates
//! verification and retains historicalStatus/historicalOutcome. Released
//! uncertainty is eligible for explicit purge; unresolved uncertainty is not.
//!
//! Limits: 256 nonpurged runs / 32 MiB logical ledger, 4 MiB per record. Each
//! prepared/live run reserves 4 MiB so completion cannot be starved by prepares.
//! Output JSON content <=3 MiB (512 KiB raw can expand sixfold), process
//! metadata <=64 KiB; both fit within the 4-MiB record.
//! Environment policy v1 is part of the definition; it is not a sandbox and
//! does not pin tool versions, repository scripts, HOME contents or ignored deps.
//! Purge frees logical budget, not SQLite pages/backups or secure deletion.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, os::unix::fs::MetadataExt, path::Path, sync::Mutex};
use crate::{projects, storage::Store};

const RECORD_LIMIT: usize = 4 * 1024 * 1024;
const OUTPUT_JSON_LIMIT: usize = 3 * 1024 * 1024;
const PROCESS_METADATA_LIMIT: usize = 64 * 1024;
const LEDGER_LIMIT: i64 = 32 * 1024 * 1024;
const RUN_LIMIT: i64 = 256;
const TTL: u64 = 300;
pub const ENVIRONMENT_POLICY_VERSION: u64 = 1;

/// Exact schema owned by this module; no user_version or transaction statements.
pub const SCHEMA_SQL: &str = r#"CREATE TABLE IF NOT EXISTS verification_runs(
        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        status TEXT NOT NULL, evidence_purged INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS verification_task ON verification_runs(task_id,status);
"#;

/// Read-only preflight. Reject missing/changed columns, constraints, indexes,
/// additional ledger triggers/indexes and partial schemas before recovery.
pub fn validate_schema(db: &Connection) -> Result<()> {
    fn objects(db: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
        Ok(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='verification_runs' ORDER BY type,name")?
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY);")?;
    expected.execute_batch(SCHEMA_SQL)?;
    ensure!(objects(db)? == objects(&expected)?, "Unsupported or missing verification ledger schema");
    Ok(())
}

pub fn init(db: &Connection) -> Result<()> {
    // No BEGIN/COMMIT: storage migration can already own the transaction.
    db.execute_batch(SCHEMA_SQL)?;
    validate_schema(db)?;
    db.execute_batch("        UPDATE verification_runs SET
          payload=json_set(payload,'$.status',CASE WHEN status='prepared' THEN 'cancelled' ELSE 'needs_attention' END,
            '$.outcome',CASE WHEN status='prepared' THEN 'cancelled' ELSE 'uncertain' END,
            '$.verification','not_verified','$.approvalNonce',NULL,
            '$.updatedAt',unixepoch(),'$.reason','startup_recovery_no_resend'),
          status=CASE WHEN status='prepared' THEN 'cancelled' ELSE 'needs_attention' END
        WHERE status IN ('prepared','running','cancel_requested');")?;
    Ok(())
}
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().with_context(|| format!("Missing string {key}"))
}
fn canonical(value: &Value) -> Result<Vec<u8>> {
    // Explicit ordering also works if the integrating crate enables preserve_order.
    fn ordered(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let sorted: std::collections::BTreeMap<_, _> = o.iter().collect();
                let mut result = serde_json::Map::new();
                for (k, v) in sorted { result.insert(k.clone(), ordered(v)); }
                Value::Object(result)
            }
            Value::Array(a) => Value::Array(a.iter().map(ordered).collect()),
            _ => v.clone(),
        }
    }
    Ok(serde_json::to_vec(&ordered(value))?)
}
fn hash(v: &Value) -> Result<String> { Ok(format!("{:x}", Sha256::digest(canonical(v)?))) }
fn random() -> Result<String> {
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn response(mut value: Value, execute: bool) -> Value {
    value["shouldExecute"] = json!(execute);
    value
}
fn read(db: &Connection, run: &str) -> Result<Value> {
    projects::id(run)?;
    let data: String = db.query_row("SELECT payload FROM verification_runs WHERE run_id=?", [run], |r| r.get(0))
        .optional()?.context("Unknown verification run")?;
    Ok(serde_json::from_str(&data)?)
}
fn by_request(db: &Connection, request: &str, digest: &str) -> Result<Option<Value>> {
    let found: Option<(String, String)> = db.query_row(
        "SELECT request_hash,payload FROM verification_runs WHERE request_id=?", [request],
        |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    found.map(|(old, payload)| {
        ensure!(old == digest, "requestId already belongs to a different exact request");
        Ok(response(serde_json::from_str(&payload)?, false))
    }).transpose()
}
fn reserved(status: &str) -> bool {
    matches!(status, "prepared" | "running" | "cancel_requested" | "needs_attention")
}
fn budget(db: &Connection, value: &Value) -> Result<String> {
    let data = serde_json::to_string(value)?;
    ensure!(data.len() <= RECORD_LIMIT, "Verification record exceeds 4 MiB");
    let (count, bytes): (i64, i64) = db.query_row(
        "SELECT count(*),COALESCE(sum(CASE WHEN status IN ('prepared','running','cancel_requested','needs_attention')
         THEN 4194304 ELSE length(CAST(payload AS BLOB)) END),0)
         FROM verification_runs WHERE evidence_purged=0 AND run_id!=?", [text(value,"runId")?],
        |r| Ok((r.get(0)?, r.get(1)?)))?;
    let purged = value["evidencePurged"] == true;
    let cost = if purged { 0 } else if reserved(text(value,"status")?) { RECORD_LIMIT } else { data.len() };
    ensure!(purged || count < RUN_LIMIT, "Verification quota: 256 runs; explicitly purge terminal evidence");
    // Replacing a reserved record cannot be starved by other ledger admissions.
    ensure!(bytes + cost as i64 <= LEDGER_LIMIT, "Verification quota: 32 MiB including live reservations");
    Ok(data)
}
fn save(db: &Connection, value: &Value, previous: &str) -> Result<()> {
    let data = budget(db, value)?;
    ensure!(db.execute("UPDATE verification_runs SET status=?,evidence_purged=?,payload=? WHERE run_id=? AND status=?",
        params![text(value,"status")?,value["evidencePurged"]==true,data,text(value,"runId")?,previous])? == 1,
        "Verification state changed; never execute from a stale response");
    Ok(())
}
fn argv(value: &Value) -> Result<Vec<String>> {
    let args = value.as_array().context("argv must be an array")?;
    ensure!(!args.is_empty() && args.len() <= 128, "argv must contain 1..128 strings");
    let mut bytes = 0usize;
    let mut result = Vec::new();
    for arg in args {
        let arg = arg.as_str().context("argv entries must be strings")?;
        ensure!(!arg.as_bytes().contains(&0), "argv contains NUL");
        bytes = bytes.checked_add(arg.len()+1).context("argv too large")?;
        ensure!(bytes <= 16*1024, "argv exceeds 16 KiB including terminators");
        result.push(arg.to_owned());
    }
    ensure!(Path::new(&result[0]).is_absolute(), "argv[0] must be absolute");
    Ok(result)
}
fn cwd_identity(path: &str) -> Result<Value> {
    let canonical = fs::canonicalize(path)?;
    let meta = fs::metadata(&canonical)?;
    ensure!(meta.is_dir(), "Verification cwd must be a directory");
    let path = canonical.to_str().context("Non UTF-8 cwd")?;
    ensure!(path.len() <= 4096 && !path.as_bytes().contains(&0), "Invalid cwd");
    Ok(json!({"cwd":path,"cwdDev":meta.dev(),"cwdIno":meta.ino()}))
}
fn same_cwd(run: &Value, current: &Value) -> Result<()> {
    ensure!(["cwd","cwdDev","cwdIno"].iter().all(|k| run[k] == current[k]), "cwd identity changed after approval");
    Ok(())
}
fn fingerprint(snapshot: &Value) -> Result<&str> {
    let fp = text(snapshot,"fingerprint")?;
    ensure!(!fp.is_empty() && fp.len() <= 4096, "Invalid snapshot fingerprint");
    Ok(fp)
}
fn definition(args: &Value, cwd: &Value, fp: &str) -> Result<String> {
    // JSON tuple frames canonical argv/cwd/fingerprint and environment policy.
    hash(&json!([args,cwd,fp,ENVIRONMENT_POLICY_VERSION]))
}
fn path_fence(db: &Connection, root: &Path, task: Option<&str>, except: Option<&str>) -> Result<()> {
    ensure!(root.is_absolute() && !root.components().any(|c| matches!(c,std::path::Component::ParentDir)),
        "Workspace path must be absolute and contain no parent traversal");
    // Only explicitly known nonwriter states may bypass the fence. Unknown
    // states remain blocked until their lifecycle is understood.
    let mut query = db.prepare("SELECT v.run_id,t.id,t.worktree_path,json_extract(v.payload,'$.cwd') FROM verification_runs v JOIN tasks t ON t.id=v.task_id
        WHERE v.status NOT IN ('prepared','completed','not_executed','cancelled','released','purged')")?;
    for row in query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))? {
        let (run, other, path, approved_cwd) = row?;
        if except == Some(run.as_str()) { continue; }
        let overlap = |p: &str| root.starts_with(p) || Path::new(p).starts_with(root);
        ensure!(task != Some(other.as_str()) && !overlap(&path) && !approved_cwd.as_deref().is_some_and(overlap),
            "Workspace fenced by verification {run}; resolve it explicitly");
    }
    Ok(())
}
fn fence(db: &Connection, task: &str, except: Option<&str>) -> Result<()> {
    let t = projects::task(db, task)?;
    path_fence(db,Path::new(text(&t,"worktreePath")?),Some(task),except)
}
pub fn ensure_available(db: &Connection, taskid: &str) -> Result<()> { fence(db,taskid,None) }
/// Generic writer admission, including ancestors of managed worktrees. Caller
/// supplies its canonical absolute workspace path while holding the parent gate.
/// This only reads SQLite and compares path components; no Git or filesystem I/O.
pub fn ensure_path_available(db: &Connection, path: &Path) -> Result<()> {
    path_fence(db,path,None,None)
}
fn writers(db: &Connection, task: &str, except: Option<&str>) -> Result<()> {
    fence(db, task, except)?;
    ensure!(!crate::workflow::archived(db,task)?, "Task is archived");
    let t = projects::task(db, task)?;
    let root = Path::new(text(&t,"worktreePath")?);
    let mut query = db.prepare("SELECT id,task_id,workspace FROM sessions WHERE status NOT IN ('exited','stopped','failed','interrupted','released')")?;
    for row in query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?)))? {
        let (session, other, path) = row?;
        let overlap = path.as_ref().is_some_and(|p| root.starts_with(p) || Path::new(p).starts_with(root));
        ensure!(other.as_deref() != Some(task) && !overlap, "Workspace has active writer session {session}");
    }
    Ok(())
}
fn fresh(store: &Mutex<Store>, task: &str) -> Result<Value> {
    let t = projects::ready(store,task)?;
    crate::snapshots::capture(Path::new(text(&t,"worktreePath")?), text(&t,"baseSha")?)
}
fn stored_snapshot(db: &Connection, task: &str, snapshot: &str) -> Result<String> {
    let payload: String = db.query_row("SELECT payload FROM task_artifacts WHERE id=? AND task_id=? AND kind='snapshot'",
        params![snapshot,task], |r| r.get(0)).optional()?.context("Unknown stored snapshot for task")?;
    Ok(fingerprint(&serde_json::from_str::<Value>(&payload)?["snapshot"])?.to_owned())
}

pub fn prepare(store: &Mutex<Store>, args: &Value) -> Result<Value> {
    prepare_with(store,args,fresh)
}
fn prepare_with(store: &Mutex<Store>, args: &Value,
    capture: impl FnOnce(&Mutex<Store>, &str) -> Result<Value>) -> Result<Value> {
    let task = text(args,"id")?; projects::id(task)?;
    let request = text(args,"requestId")?; projects::id(request)?;
    let digest = hash(args)?;
    // Dedup precedes all live filesystem/workspace checks, including after purge.
    {
        let db = store.lock().unwrap();
        if let Some(known) = by_request(&db.0,request,&digest)? { return Ok(known); }
    }
    let snapshot = text(args,"snapshotId")?; projects::id(snapshot)?;
    argv(&args["argv"])?;
    let (t, before) = {
        let db = store.lock().unwrap(); writers(&db.0,task,None)?;
        (projects::task(&db.0,task)?,stored_snapshot(&db.0,task,snapshot)?)
    };
    let identity = cwd_identity(text(&t,"worktreePath")?)?;
    let current = capture(store,task)?;
    ensure!(fingerprint(&current)? == before, "Snapshot changed; capture and approve again");
    same_cwd(&identity,&cwd_identity(text(&t,"worktreePath")?)?)?;
    let run = random()?;
    let nonce = random()?; // independent random draws, never derived from runId
    let timestamp = now();
    let value = json!({"id":task,"runId":run,"requestId":request,"requestHash":digest,
        "snapshotId":snapshot,"argv":args["argv"],"cwd":identity["cwd"],
        "cwdDev":identity["cwdDev"],"cwdIno":identity["cwdIno"],
        "definitionHash":definition(&args["argv"],&identity["cwd"],&before)?,
        "beforeFingerprint":before,"afterFingerprint":null,"status":"prepared",
        "environmentPolicyVersion":ENVIRONMENT_POLICY_VERSION,
        "outcome":null,"verification":"not_verified","createdAt":timestamp,"updatedAt":timestamp,
        "approvalExpiresAt":timestamp+TTL,"approvalNonce":nonce,"approvalNonceHash":hash(&json!(nonce))?,
        "evidencePurged":false});
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(known) = by_request(&tx,request,&digest)? { return Ok(known); }
    writers(&tx,task,None)?;
    ensure!(stored_snapshot(&tx,task,snapshot)? == before, "Stored snapshot changed");
    let data = budget(&tx,&value)?;
    tx.execute("INSERT INTO verification_runs(run_id,task_id,request_id,request_hash,status,payload) VALUES(?,?,?,?,'prepared',?)",
        params![run,task,request,digest,data])?;
    tx.commit()?;
    Ok(response(value,false))
}

pub fn begin(store: &Mutex<Store>, args: &Value) -> Result<Value> { begin_with(store,args,fresh) }
fn begin_with(store: &Mutex<Store>, args: &Value,
    capture: impl FnOnce(&Mutex<Store>, &str) -> Result<Value>) -> Result<Value> {
    let task = text(args,"id")?; projects::id(task)?;
    let run_id = text(args,"runId")?;
    let original = {
        let db = store.lock().unwrap();
        let v = read(&db.0,run_id)?;
        ensure!(v["id"] == task,"Run belongs to another task");
        if v["status"] != "prepared" { return Ok(response(v,false)); }
        ensure!(v["approvalNonce"].as_str() == Some(text(args,"approvalNonce")?), "Invalid approval nonce");
        v
    };
    // Every validation error with a valid approval is durably not_executed.
    let validation = (|| -> Result<()> {
        ensure!(now() < original["approvalExpiresAt"].as_u64().context("Invalid approval expiry")?, "Approval expired");
        argv(&original["argv"])?;
        {
            let db = store.lock().unwrap(); writers(&db.0,task,None)?;
            ensure!(stored_snapshot(&db.0,task,text(&original,"snapshotId")?)? == text(&original,"beforeFingerprint")?, "Stored snapshot changed");
        }
        let t = projects::task(&store.lock().unwrap().0,task)?;
        same_cwd(&original,&cwd_identity(text(&t,"worktreePath")?)?)?;
        ensure!(definition(&original["argv"],&original["cwd"],text(&original,"beforeFingerprint")?)? == text(&original,"definitionHash")?, "Verification definition changed");
        let current = capture(store,task)?;
        ensure!(fingerprint(&current)? == text(&original,"beforeFingerprint")?, "Snapshot changed after approval");
        same_cwd(&original,&cwd_identity(text(&t,"worktreePath")?)?)?;
        Ok(())
    })();
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut value = read(&tx,run_id)?;
    if value["status"] != "prepared" { return Ok(response(value,false)); }
    ensure!(value == original, "Prepared definition changed during validation");
    let validation = validation.and_then(|_| {
        ensure!(now() < value["approvalExpiresAt"].as_u64().unwrap_or(0), "Approval expired during capture");
        writers(&tx,task,None)?;
        ensure!(stored_snapshot(&tx,task,text(&value,"snapshotId")?)? == text(&value,"beforeFingerprint")?, "Stored snapshot changed during capture");
        Ok(())
    });
    let execute = validation.is_ok();
    value["approvalNonce"] = Value::Null;
    value["updatedAt"] = json!(now());
    if let Err(error) = validation {
        value["status"] = json!("not_executed"); value["outcome"] = json!("not_executed");
        value["reason"] = json!(format!("{error:#}").chars().take(2048).collect::<String>());
    } else { value["status"] = json!("running"); }
    save(&tx,&value,"prepared")?;
    tx.commit()?;
    Ok(response(value,execute))
}

/// Fresh post evidence, bypassing ONLY this run's own live fence.
pub fn capture_for_run(store: &Mutex<Store>, run_id: &str) -> Result<Value> {
    capture_for_run_with(store,run_id,fresh)
}
fn capture_for_run_with(store: &Mutex<Store>, run_id: &str,
    capture: impl FnOnce(&Mutex<Store>, &str) -> Result<Value>) -> Result<Value> {
    let value = {
        let db = store.lock().unwrap(); let v = read(&db.0,run_id)?;
        ensure!(matches!(v["status"].as_str(), Some("running"|"cancel_requested")), "Run is not live");
        writers(&db.0,text(&v,"id")?,Some(run_id))?; v
    };
    let task = text(&value,"id")?;
    let t = projects::task(&store.lock().unwrap().0,task)?;
    same_cwd(&value,&cwd_identity(text(&t,"worktreePath")?)?)?;
    let captured = capture(store,task)?;
    fingerprint(&captured)?;
    same_cwd(&value,&cwd_identity(text(&t,"worktreePath")?)?)?;
    let db = store.lock().unwrap();
    ensure!(matches!(read(&db.0,run_id)?["status"].as_str(),Some("running"|"cancel_requested")), "Run ceased to be live during capture");
    writers(&db.0,task,Some(run_id))?;
    Ok(captured)
}

/// `after` must be capture_for_run's fresh result, not the approved snapshot.
/// Only call after execution/cleanup has returned. Retry returns the stored result.
pub fn finish(store: &Mutex<Store>, run_id: &str, result: Value, after: Result<Value>) -> Result<Value> {
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut value = read(&tx,run_id)?;
    let previous = text(&value,"status")?.to_owned();
    if !matches!(previous.as_str(),"running"|"cancel_requested") { return Ok(response(value,false)); }
    ensure!(result.is_object(), "Process result must be an object");
    let process_status = text(&result,"status")?;
    ensure!(["passed","failed","cancelled","timeout","output_limit","uncertain"].contains(&process_status), "Invalid process status");
    // 512 KiB raw can become 3 MiB of escaped JSON, plus object framing.
    // The primitive owns the raw-byte limit (lossy UTF-8 loses that information).
    let mut encoded_output = 0usize;
    let mut metadata = result.clone();
    for key in ["stdout","stderr"] {
        ensure!(result[key].is_null() || result[key].is_string(), "Output must be a string");
        if result[key].is_string() { encoded_output += serde_json::to_vec(&result[key])?.len()-2; }
        metadata.as_object_mut().unwrap().remove(key);
    }
    ensure!(encoded_output <= OUTPUT_JSON_LIMIT, "Escaped output exceeds 3 MiB (512 KiB raw, up to sixfold JSON expansion)");
    ensure!(serde_json::to_vec(&metadata)?.len() <= PROCESS_METADATA_LIMIT, "Process metadata exceeds 64 KiB");
    let after = after.and_then(|v| Ok(fingerprint(&v)?.to_owned()));
    // A definitive pre-spawn failed/cancelled/timeout result owns no child.
    // Missing post evidence never verifies files, but creates no custody fence.
    let known_not_started = matches!(process_status,"cancelled"|"failed"|"timeout") && result["spawned"] == false;
    let uncertain = process_status == "uncertain" || (after.is_err() && !known_not_started);
    let outcome = if uncertain { "uncertain" }
        else if after.is_err() { process_status }
        else if after.as_ref().unwrap() != text(&value,"beforeFingerprint")? { "mutated" }
        else if previous == "cancel_requested" || process_status == "cancelled" { "cancelled" }
        else if process_status == "passed" && result["exitCode"] == 0 && result["spawned"] != false { "passed" }
        else if process_status == "passed" { "failed" }
        else { process_status };
    value["outcome"] = json!(outcome);
    value["verification"] = json!(if outcome == "passed" { "verified" } else { "not_verified" });
    value["status"] = json!(if uncertain { "needs_attention" } else { "completed" });
    value["updatedAt"] = json!(now());
    match after {
        Ok(fp) => value["afterFingerprint"] = json!(fp),
        Err(error) => value["postCaptureError"] = json!(format!("{error:#}").chars().take(2048).collect::<String>()),
    }
    value["process"] = result;
    save(&tx,&value,&previous)?;
    tx.commit()?;
    Ok(response(value,false))
}

pub fn get(db: &Connection, taskid: &str, run_id: &str) -> Result<Value> {
    projects::id(taskid)?;
    let value = read(db,run_id)?;
    ensure!(value["id"] == taskid,"Run belongs to another task");
    Ok(response(value,false))
}
/// Fixed allowlist: at most 16 records, never commands, output, nonces or notes.
pub fn summary(db: &Connection, taskid: &str) -> Result<Value> {
    projects::task(db,taskid)?;
    let mut query = db.prepare("SELECT payload FROM verification_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 16")?;
    let rows = query.query_map([taskid],|r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut runs = Vec::new();
    for row in rows {
        let value: Value = serde_json::from_str(&row)?;
        let mut item = json!({"shouldExecute":false});
        for key in ["id","runId","requestId","snapshotId","status","outcome","verification","createdAt","updatedAt","evidencePurged","definitionHash","beforeFingerprint","afterFingerprint","environmentPolicyVersion","historicalStatus","historicalOutcome"] {
            item[key] = value[key].clone();
        }
        runs.push(item);
    }
    Ok(json!({"id":taskid,"runs":runs}))
}

/// Records intent only. Parent sets its owned AtomicBool separately; no signals.
pub fn cancel_requested(store: &Mutex<Store>, run_id: &str) -> Result<Value> {
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut value = read(&tx,run_id)?;
    let previous = text(&value,"status")?.to_owned();
    if previous == "prepared" || previous == "running" {
        value["status"] = json!(if previous == "prepared" { "cancelled" } else { "cancel_requested" });
        if previous == "prepared" { value["outcome"] = json!("cancelled"); }
        value["approvalNonce"] = Value::Null;
        value["updatedAt"] = json!(now());
        save(&tx,&value,&previous)?;
    }
    tx.commit()?;
    Ok(response(value,false))
}

pub fn release(store: &Mutex<Store>, args: &Value) -> Result<Value> {
    ensure!(args["confirmed"] == true,"Explicit confirmation required after manual/native process inspection");
    let task = text(args,"id")?;
    let run = text(args,"runId")?;
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut value = read(&tx,run)?;
    ensure!(value["id"] == task,"Run belongs to another task");
    if value["status"] == "released" { return Ok(response(value,false)); }
    ensure!(value["status"] == "needs_attention", "Only needs_attention can be manually released");
    value["status"] = json!("released"); value["approvalNonce"] = Value::Null;
    value["updatedAt"] = json!(now());
    value["release"] = json!("human_confirmed_manual_native_inspection_no_process_signals");
    save(&tx,&value,"needs_attention")?;
    tx.commit()?;
    Ok(response(value,false))
}

/// Purges terminal evidence for args.id, including explicitly released uncertainty.
/// Live and unresolved needs_attention runs always retain their evidence/fence.
pub fn purge(store: &Mutex<Store>, args: &Value) -> Result<Value> {
    ensure!(args["confirmed"] == true,"Explicit evidence purge confirmation required");
    let task = text(args,"id")?; projects::id(task)?;
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    projects::task(&tx,task)?;
    let rows = tx.prepare("SELECT payload FROM verification_runs WHERE task_id=? AND evidence_purged=0
        AND status IN ('completed','not_executed','cancelled','released')")?
        .query_map([task],|r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut count = 0;
    for row in rows {
        let old: Value = serde_json::from_str(&row)?;
        if old["outcome"] == "uncertain" && old["status"] != "released" { continue; }
        // Allowlist drops command/cwd/output/notes/error and all future evidence.
        let mut tombstone = json!({"evidencePurged":true,"approvalNonce":null,"purgedAt":now(),
            "verification":"not_verified","status":"purged","outcome":"purged",
            "historicalStatus":old["status"],"historicalOutcome":old["outcome"]});
        for key in ["id","runId","requestId","requestHash","snapshotId","definitionHash","approvalNonceHash",
            "beforeFingerprint","afterFingerprint","environmentPolicyVersion","createdAt","updatedAt"] {
            tombstone[key] = old[key].clone();
        }
        save(&tx,&tombstone,text(&old,"status")?)?;
        count += 1;
    }
    tx.commit()?;
    Ok(json!({"id":task,"purgedRuns":count,"secureDeletion":false,"shouldExecute":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};

    struct Fixture { dir: tempfile::TempDir, store: Mutex<Store>, args: Value }
    impl Fixture {
        fn new() -> Result<Self> {
            let dir = tempfile::tempdir()?;
            fs::create_dir(dir.path().join("cwd"))?;
            let db = Connection::open(dir.path().join("ledger.sqlite"))?;
            db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                CREATE TABLE sessions(id TEXT PRIMARY KEY,task_id TEXT,workspace TEXT,status TEXT);")?;
            projects::init(&db)?;
            crate::workflow::init(&db)?;
            init(&db)?;
            db.execute("INSERT INTO projects VALUES('p','/fixture','/fixture/.git','fixture','base',NULL)",[])?;
            db.execute("INSERT INTO tasks VALUES('t','p','T','O','','base','b',?,'ready',NULL)",
                [dir.path().join("cwd").to_str().unwrap()])?;
            db.execute("INSERT INTO task_artifacts VALUES('s','t','snapshot',?)",
                [json!({"createdAt":now(),"snapshot":{"fingerprint":"before","files":[]},"request":{"id":"t","artifactId":"s"}}).to_string()])?;
            Ok(Self { dir, store: Mutex::new(Store(db)), args: json!({"id":"t","requestId":"r","snapshotId":"s","argv":["/fixture/never-executed","arg"]}) })
        }
        fn prepare(&self) -> Result<Value> { prepare_with(&self.store,&self.args,|s,_| {
            assert!(s.try_lock().is_ok(),"DB mutex held across capture"); Ok(json!({"fingerprint":"before"}))
        }) }
        fn approval(v: &Value) -> Value { json!({"id":"t","runId":v["runId"],"approvalNonce":v["approvalNonce"]}) }
        fn begin(&self, v: &Value) -> Result<Value> { begin_with(&self.store,&Self::approval(v),|s,_| {
            assert!(s.try_lock().is_ok()); Ok(json!({"fingerprint":"before"}))
        }) }
        fn finish(&self, v: &Value, fp: &str) -> Result<Value> {
            finish(&self.store,text(v,"runId")?,json!({"status":"passed","exitCode":0,"stdout":"evidence","stderr":""}),Ok(json!({"fingerprint":fp})))
        }
    }

    #[test]
    fn exact_dedup_nonce_and_known_retries_never_execute() -> Result<()> {
        let f = Fixture::new()?;
        let v = f.prepare()?;
        assert_eq!(v["shouldExecute"],false);
        assert_eq!(v["environmentPolicyVersion"],1);
        assert_ne!(v["runId"],v["approvalNonce"]);
        assert_eq!(f.prepare()?,v);
        let mut changed = f.args.clone(); changed["argv"][1] = json!("other");
        assert!(prepare_with(&f.store,&changed,|_,_| panic!("dedup must precede capture")).is_err());
        let mut bad = Fixture::approval(&v); bad["approvalNonce"] = json!("wrong");
        assert!(begin_with(&f.store,&bad,|_,_| panic!("bad nonce must not capture")).is_err());
        assert_eq!(f.begin(&v)?["shouldExecute"],true);
        let retry = begin_with(&f.store,&Fixture::approval(&v),|_,_| panic!("running retry must not capture"))?;
        assert_eq!(retry["shouldExecute"],false); assert!(retry["approvalNonce"].is_null());
        let done = f.finish(&v,"before")?;
        assert_eq!(done["outcome"],"passed"); assert_eq!(done["verification"],"verified");
        assert_eq!(f.begin(&v)?["status"],"completed");
        assert_eq!(f.prepare()?["outcome"],"passed");
        assert_eq!(finish(&f.store,text(&v,"runId")?,Value::Null,Err(anyhow::anyhow!("retry")))?,done);
        Ok(())
    }

    #[test]
    fn concurrent_begin_has_one_cas_winner() -> Result<()> {
        let f = Arc::new(Fixture::new()?);
        let v = f.prepare()?;
        let barrier = Arc::new(Barrier::new(2));
        let winners = Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let (f,barrier,winners,v) = (f.clone(),barrier.clone(),winners.clone(),v.clone());
                scope.spawn(move || {
                    let result = begin_with(&f.store,&Fixture::approval(&v),|_,_| {
                        barrier.wait(); Ok(json!({"fingerprint":"before"}))
                    }).unwrap();
                    if result["shouldExecute"] == true { winners.fetch_add(1,Ordering::SeqCst); }
                });
            }
        });
        assert_eq!(winners.load(Ordering::SeqCst),1);
        Ok(())
    }

    #[test]
    fn recovery_is_durable_nested_safe_and_invalidates_approval() -> Result<()> {
        let f = Fixture::new()?;
        let prepared = f.prepare()?;
        let mut other = f.args.clone(); other["requestId"] = json!("running");
        let live = prepare_with(&f.store,&other,|_,_| Ok(json!({"fingerprint":"before"})))?;
        f.begin(&live)?;
        cancel_requested(&f.store,text(&live,"runId")?)?;
        // A separate connection models runner restart, not an in-memory inference.
        let mut reopened = Connection::open(f.dir.path().join("ledger.sqlite"))?;
        { let tx = reopened.transaction()?; init(&tx)?; tx.commit()?; }
        let p = get(&reopened,"t",text(&prepared,"runId")?)?;
        assert_eq!(p["status"],"cancelled"); assert!(p["approvalNonce"].is_null());
        let r = get(&reopened,"t",text(&live,"runId")?)?;
        assert_eq!(r["status"],"needs_attention"); assert!(ensure_available(&reopened,"t").is_err());
        init(&reopened)?; assert_eq!(get(&reopened,"t",text(&live,"runId")?)?,r);
        assert_eq!(f.begin(&prepared)?["shouldExecute"],false);
        let args = json!({"id":"t","runId":live["runId"],"confirmed":true});
        assert!(release(&f.store,&json!({"id":"t","runId":live["runId"]})).is_err());
        assert_eq!(release(&f.store,&args)?["status"],"released");
        ensure_available(&reopened,"t")?;
        assert_eq!(f.begin(&live)?["shouldExecute"],false);
        Ok(())
    }

    #[test]
    fn stale_directory_inode_and_snapshot_burn_approval() -> Result<()> {
        let f = Fixture::new()?;
        let v = f.prepare()?;
        let cwd = f.dir.path().join("cwd");
        fs::rename(&cwd,f.dir.path().join("old-cwd"))?; fs::create_dir(&cwd)?;
        let rejected = begin_with(&f.store,&Fixture::approval(&v),|_,_| panic!("stale cwd must precede capture"))?;
        assert_eq!(rejected["status"],"not_executed"); assert_eq!(rejected["shouldExecute"],false);
        assert!(rejected["reason"].as_str().unwrap().contains("identity"));
        assert_eq!(f.begin(&v)?["shouldExecute"],false);
        let f = Fixture::new()?;
        let v = f.prepare()?;
        let rejected = begin_with(&f.store,&Fixture::approval(&v),|_,_| Ok(json!({"fingerprint":"changed"})))?;
        assert_eq!(rejected["status"],"not_executed"); assert!(rejected["approvalNonce"].is_null());
        let mut args = f.args.clone(); args["requestId"] = json!("changed-snapshot");
        assert!(prepare_with(&f.store,&args,|_,_| Ok(json!({"fingerprint":"changed"}))).is_err());
        Ok(())
    }

    #[test]
    fn ttl_and_definition_tampering_are_not_executed() -> Result<()> {
        for field in ["approvalExpiresAt","argv"] {
            let f = Fixture::new()?; let v = f.prepare()?;
            let mut stored = read(&f.store.lock().unwrap().0,text(&v,"runId")?)?;
            if field == "argv" { stored["argv"][1] = json!("tampered"); }
            else { stored[field] = json!(0); }
            f.store.lock().unwrap().0.execute("UPDATE verification_runs SET payload=? WHERE run_id=?",
                params![stored.to_string(),text(&v,"runId")?])?;
            let result = begin_with(&f.store,&Fixture::approval(&v),|_,_| panic!("invalid definition/TTL must not capture"))?;
            assert_eq!(result["status"],"not_executed"); assert_eq!(result["shouldExecute"],false);
        }
        Ok(())
    }

    #[test]
    fn postcapture_only_ignores_own_fence_and_captures_fresh() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?;
        let run = text(&v,"runId")?;
        assert!(ensure_available(&f.store.lock().unwrap().0,"t").is_err());
        let post = capture_for_run_with(&f.store,run,|s,_| {
            assert!(s.try_lock().is_ok()); Ok(json!({"fingerprint":"fresh-post"}))
        })?;
        assert_eq!(post["fingerprint"],"fresh-post");
        let db = f.store.lock().unwrap();
        db.0.execute("INSERT INTO sessions VALUES('writer','t',NULL,'running')",[])?;
        drop(db);
        assert!(capture_for_run_with(&f.store,run,|_,_| panic!("writer must block capture")).is_err());
        f.store.lock().unwrap().0.execute("DELETE FROM sessions",[])?;
        let mut conflict = read(&f.store.lock().unwrap().0,run)?;
        conflict["runId"] = json!("other-run");
        f.store.lock().unwrap().0.execute("INSERT INTO verification_runs VALUES('other-run','t','other-request','other-hash','running',0,?)",[conflict.to_string()])?;
        assert!(capture_for_run_with(&f.store,run,|_,_| panic!("other run must block capture")).is_err());
        Ok(())
    }

    #[test]
    fn changed_post_and_cancelled_never_green_uncertain_stays_fenced() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?;
        let done = f.finish(&v,"different")?;
        assert_eq!(done["outcome"],"mutated"); assert_eq!(done["verification"],"not_verified");
        assert_eq!(done["process"]["status"],"passed"); assert_eq!(done["process"]["exitCode"],0);
        for (status,post_error) in [("cancelled",false),("passed",true),("uncertain",false)] {
            let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?;
            let process = json!({"status":status,"exitCode":0,"stdout":"kept","spawned":false});
            let post = if post_error { Err(anyhow::anyhow!("capture failed")) } else { Ok(json!({"fingerprint":"before"})) };
            let done = finish(&f.store,text(&v,"runId")?,process.clone(),post)?;
            assert_eq!(done["process"],process); assert_eq!(done["verification"],"not_verified");
            if post_error || status == "uncertain" {
                assert_eq!(done["status"],"needs_attention"); assert_eq!(done["outcome"],"uncertain");
                assert!(ensure_available(&f.store.lock().unwrap().0,"t").is_err());
                assert_eq!(purge(&f.store,&json!({"id":"t","confirmed":true}))?["purgedRuns"],0);
            } else { assert_eq!(done["outcome"],"cancelled"); }
        }
        Ok(())
    }

    #[test]
    fn cancellation_before_begin_and_during_run_is_idempotent() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?;
        let cancelled = cancel_requested(&f.store,text(&v,"runId")?)?;
        assert_eq!(cancelled["status"],"cancelled"); assert_eq!(f.begin(&v)?["shouldExecute"],false);
        let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?;
        let cancelled = cancel_requested(&f.store,text(&v,"runId")?)?;
        assert_eq!(cancelled["status"],"cancel_requested");
        assert_eq!(cancel_requested(&f.store,text(&v,"runId")?)?,cancelled);
        let done = f.finish(&v,"before")?;
        assert_eq!(done["outcome"],"cancelled"); assert_eq!(done["process"]["status"],"passed");
        Ok(())
    }

    #[test]
    fn purge_keeps_tombstone_dedup_and_frees_run_quota() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?; f.finish(&v,"before")?;
        // Seed real, bounded terminal records, not a mocked budget result.
        for n in 1..RUN_LIMIT {
            let mut item = read(&f.store.lock().unwrap().0,text(&v,"runId")?)?;
            item["runId"] = json!(format!("seed-{n}")); item["requestId"] = json!(format!("request-{n}"));
            f.store.lock().unwrap().0.execute("INSERT INTO verification_runs VALUES(?,?,?,?,'completed',0,?)",
                params![text(&item,"runId")?,"t",text(&item,"requestId")?,"seed-hash",item.to_string()])?;
        }
        let mut next = f.args.clone(); next["requestId"] = json!("next");
        assert!(prepare_with(&f.store,&next,|_,_| Ok(json!({"fingerprint":"before"}))).is_err());
        assert!(purge(&f.store,&json!({"id":"t"})).is_err());
        assert_eq!(purge(&f.store,&json!({"id":"t","confirmed":true}))?["purgedRuns"],RUN_LIMIT);
        let tombstone = f.prepare()?;
        assert_eq!(tombstone["evidencePurged"],true); assert_eq!(tombstone["definitionHash"],v["definitionHash"]);
        assert_eq!(tombstone["verification"],"not_verified");
        assert_eq!(tombstone["status"],"purged"); assert_eq!(tombstone["outcome"],"purged");
        assert_eq!(tombstone["historicalStatus"],"completed"); assert_eq!(tombstone["historicalOutcome"],"passed");
        assert_eq!(tombstone["requestHash"],v["requestHash"]);
        assert_eq!(tombstone["approvalNonceHash"],v["approvalNonceHash"]);
        assert_eq!(tombstone["beforeFingerprint"],"before"); assert!(tombstone["approvalNonce"].is_null());
        assert!(!tombstone.as_object().unwrap().contains_key("argv"));
        assert!(!tombstone.as_object().unwrap().contains_key("process"));
        assert_eq!(f.begin(&v)?["shouldExecute"],false);
        assert!(prepare_with(&f.store,&next,|_,_| Ok(json!({"fingerprint":"before"}))).is_ok());
        let summary = summary(&f.store.lock().unwrap().0,"t")?;
        assert_eq!(summary["runs"].as_array().unwrap().len(),16);
        for item in summary["runs"].as_array().unwrap() {
            for key in ["argv","process","approvalNonce","stdout","reason"] { assert!(item.get(key).is_none()); }
        }
        Ok(())
    }

    #[test]
    fn byte_reservations_escaped_output_and_record_limits() -> Result<()> {
        let f = Fixture::new()?; let mut runs = Vec::new();
        for n in 0..8 {
            let mut args = f.args.clone(); args["requestId"] = json!(format!("reserve-{n}"));
            runs.push(prepare_with(&f.store,&args,|_,_| Ok(json!({"fingerprint":"before"})))?);
        }
        let mut extra = f.args.clone(); extra["requestId"] = json!("over-budget");
        assert!(prepare_with(&f.store,&extra,|_,_| Ok(json!({"fingerprint":"before"}))).is_err());
        let v = &runs[0]; f.begin(v)?;
        let process = json!({"status":"passed","exitCode":0,"stdout":"\0".repeat(512*1024+1),"stderr":""});
        // Output beyond the encoded cap is rejected without dropping the fence.
        assert!(finish(&f.store,text(v,"runId")?,process,Ok(json!({"fingerprint":"before"}))).is_err());
        assert!(ensure_available(&f.store.lock().unwrap().0,"t").is_err());
        let process = json!({"status":"passed","exitCode":0,"stdout":"\0".repeat(512*1024),"stderr":""});
        let done = finish(&f.store,text(v,"runId")?,process.clone(),Ok(json!({"fingerprint":"before"})))?;
        assert_eq!(done["process"],process);
        let mut huge = read(&f.store.lock().unwrap().0,text(v,"runId")?)?;
        huge["notes"] = json!("x".repeat(RECORD_LIMIT));
        assert!(budget(&f.store.lock().unwrap().0,&huge).is_err());
        purge(&f.store,&json!({"id":"t","confirmed":true}))?;
        assert!(prepare_with(&f.store,&extra,|_,_| Ok(json!({"fingerprint":"before"}))).is_ok());
        Ok(())
    }

    #[test]
    fn schema_validation_is_read_only_and_rejects_unknown_definitions() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?;
        let db = f.store.lock().unwrap();
        validate_schema(&db.0)?;
        assert_eq!(read(&db.0,text(&v,"runId")?)?["status"],"prepared");
        db.0.execute_batch("CREATE INDEX unknown_verification_index ON verification_runs(status)")?;
        assert!(validate_schema(&db.0).is_err());
        db.0.execute_batch("DROP INDEX unknown_verification_index; ALTER TABLE verification_runs ADD COLUMN unknown TEXT")?;
        assert!(validate_schema(&db.0).is_err());
        let empty = Connection::open_in_memory()?;
        assert!(validate_schema(&empty).is_err());
        assert_eq!(empty.query_row("SELECT count(*) FROM sqlite_master",[],|r|r.get::<_,i64>(0))?,0);
        Ok(())
    }

    #[test]
    fn generic_path_admission_blocks_ancestors_descendants_and_uncertainty() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?;
        let root = fs::canonicalize(f.dir.path().join("cwd"))?;
        let check = |blocked: bool| -> Result<()> {
            let db = f.store.lock().unwrap();
            for path in [root.clone(),root.join("nested"),root.parent().unwrap().to_path_buf(),std::path::PathBuf::from("/")] {
                assert_eq!(ensure_path_available(&db.0,&path).is_err(),blocked,"{}",path.display());
            }
            // Compare components: a shared string prefix is not an overlap.
            ensure_path_available(&db.0,&root.with_file_name("cwd-sibling"))?;
            assert!(ensure_path_available(&db.0,Path::new("relative")).is_err());
            assert!(ensure_path_available(&db.0,&root.join("../elsewhere")).is_err());
            Ok(())
        };
        check(false)?; // prepared is not a writer
        f.begin(&v)?; check(true)?;
        cancel_requested(&f.store,text(&v,"runId")?)?; check(true)?;
        init(&f.store.lock().unwrap().0)?; check(true)?;
        release(&f.store,&json!({"id":"t","runId":v["runId"],"confirmed":true}))?;
        check(false)?;
        Ok(())
    }

    #[test]
    fn released_uncertainty_can_be_purged_to_free_byte_quota() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?;
        cancel_requested(&f.store,text(&v,"runId")?)?;
        let mut seed = read(&f.store.lock().unwrap().0,text(&v,"runId")?)?;
        seed["status"] = json!("needs_attention"); seed["outcome"] = json!("uncertain");
        // Real bounded rows close to the 4-MiB record cap model retained evidence.
        // Check actual byte admission, not a mocked quota or a count-only failure.
        seed["notes"] = json!("x".repeat(RECORD_LIMIT-4096));
        {
            let db = f.store.lock().unwrap();
            save(&db.0,&seed,"cancelled")?;
            for n in 1..8 {
                let mut item = seed.clone();
                item["runId"] = json!(format!("uncertain-{n}"));
                item["requestId"] = json!(format!("uncertain-request-{n}"));
                let payload = budget(&db.0,&item)?;
                db.0.execute("INSERT INTO verification_runs VALUES(?,?,?,?,'needs_attention',0,?)",
                    params![text(&item,"runId")?,"t",text(&item,"requestId")?,text(&item,"requestHash")?,payload])?;
            }
        }
        assert_eq!(purge(&f.store,&json!({"id":"t","confirmed":true}))?["purgedRuns"],0);
        for run in std::iter::once(text(&v,"runId")?.to_owned()).chain((1..8).map(|n|format!("uncertain-{n}"))) {
            release(&f.store,&json!({"id":"t","runId":run,"confirmed":true}))?;
        }
        ensure_available(&f.store.lock().unwrap().0,"t")?;
        let bytes: i64 = f.store.lock().unwrap().0.query_row(
            "SELECT sum(length(CAST(payload AS BLOB))) FROM verification_runs WHERE evidence_purged=0",[],|r|r.get(0))?;
        assert!(bytes > LEDGER_LIMIT-RECORD_LIMIT as i64);
        let mut next = f.args.clone(); next["requestId"] = json!("after-released-purge");
        assert!(prepare_with(&f.store,&next,|_,_|Ok(json!({"fingerprint":"before"}))).is_err());
        assert_eq!(purge(&f.store,&json!({"id":"t","confirmed":true}))?["purgedRuns"],8);
        let tombstone = f.prepare()?;
        assert_eq!(tombstone["status"],"purged"); assert_eq!(tombstone["outcome"],"purged");
        assert_eq!(tombstone["verification"],"not_verified");
        assert_eq!(tombstone["historicalStatus"],"released");
        assert_eq!(tombstone["historicalOutcome"],"uncertain");
        assert_eq!(f.begin(&v)?["shouldExecute"],false);
        assert!(prepare_with(&f.store,&next,|_,_|Ok(json!({"fingerprint":"before"}))).is_ok());
        Ok(())
    }

    #[test]
    fn unknown_status_fails_closed_without_execution_release_or_purge() -> Result<()> {
        let f = Fixture::new()?; let v = f.prepare()?;
        {
            let db = f.store.lock().unwrap();
            let mut unknown = read(&db.0,text(&v,"runId")?)?;
            unknown["status"] = json!("unknown_future_state");
            db.0.execute("UPDATE verification_runs SET status='unknown_future_state',payload=? WHERE run_id=?",
                params![unknown.to_string(),text(&v,"runId")?])?;
            assert!(ensure_available(&db.0,"t").is_err());
            let cwd = Path::new(text(&v,"cwd")?);
            assert!(ensure_path_available(&db.0,cwd).is_err());
            assert!(ensure_path_available(&db.0,cwd.parent().unwrap()).is_err());
        }
        assert_eq!(f.begin(&v)?["shouldExecute"],false);
        assert!(release(&f.store,&json!({"id":"t","runId":v["runId"],"confirmed":true})).is_err());
        assert_eq!(purge(&f.store,&json!({"id":"t","confirmed":true}))?["purgedRuns"],0);
        assert!(ensure_available(&f.store.lock().unwrap().0,"t").is_err());
        Ok(())
    }

    #[test]
    fn known_prespawn_cancellation_with_failed_postcapture_has_no_fence() -> Result<()> {
        // A definitive non-started failed/cancelled/timeout owns no child; none verifies files.
        for (status,spawned,known) in [("cancelled",json!(false),true),
            ("cancelled",json!(true),false),("cancelled",Value::Null,false),
            ("failed",json!(false),true),("timeout",json!(false),true),("passed",json!(false),false)] {
            let f = Fixture::new()?; let v = f.prepare()?; f.begin(&v)?;
            let process = json!({"status":status,"spawned":spawned,"exitCode":0,"stdout":"kept"});
            let done = finish(&f.store,text(&v,"runId")?,process.clone(),Err(anyhow::anyhow!("post unavailable")))?;
            assert_eq!(done["process"],process);
            assert_eq!(done["verification"],"not_verified");
            assert_eq!(done["shouldExecute"],false);
            assert!(done["postCaptureError"].as_str().unwrap().contains("post unavailable"));
            assert!(done["afterFingerprint"].is_null());
            if known {
                assert_eq!(done["status"],"completed"); assert_eq!(done["outcome"],status);
                ensure_available(&f.store.lock().unwrap().0,"t")?;
                ensure_path_available(&f.store.lock().unwrap().0,Path::new(text(&v,"cwd")?))?;
                assert_eq!(f.begin(&v)?["shouldExecute"],false);
            } else {
                assert_eq!(done["status"],"needs_attention"); assert_eq!(done["outcome"],"uncertain");
                assert!(ensure_available(&f.store.lock().unwrap().0,"t").is_err());
            }
        }
        Ok(())
    }

    #[test]
    fn argv_validation_is_explicit_and_unambiguous_hashes() -> Result<()> {
        for args in [json!([]),json!(["relative"]),json!(["/absolute","\0"]),json!(["/absolute",1]),
            json!(["/absolute","a".repeat(16*1024)]),json!(vec!["/absolute";129])] {
            assert!(argv(&args).is_err());
        }
        assert!(argv(&json!(["/absolute","spaces allowed",""])).is_ok());
        assert_ne!(definition(&json!(["/a","bc"]),&json!("/cwd"),"fp")?,definition(&json!(["/ab","c"]),&json!("/cwd"),"fp")?);
        assert_eq!(hash(&json!({"b":2,"a":1}))?,hash(&json!({"a":1,"b":2}))?);
        Ok(())
    }
}

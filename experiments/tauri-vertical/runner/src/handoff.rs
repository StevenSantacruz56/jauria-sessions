//! Manual handoff admission. Frozen API: `claim(&Mutex<Store>, &Value)` and
//! `complete(&Mutex<Store>, &Value, &Value)`, both returning `Result<Value>`.
//!
//! claim requires EXACTLY {id,artifactId,requestId,sessionId,rows,cols}; IDs use
//! projects::id (1..64 ASCII alphanumeric/hyphen), dimensions are 2..1000.
//! artifactId identifies an existing immutable workflow handoff. requestId is
//! the globally unique effect ID in task_artifacts, kind handoff_open.
//! Only the first durable claim returns shouldStart:true. Parent must hold its
//! workspace admission gate across claim -> self.start -> complete, and supply
//! taskId=id to start. Never send context to PTY: the user copies it manually.
//! No DB guard spans Git/canonicalization. This module owns no process handles.
//!
//! Responses contain exactly shouldStart,sessionId,kind,cwd,title,context,phase.
//! Fresh phase=prepared; a prepared retry projects phase=uncertain (inspection
//! required, NEVER permission to retry start). Retry sessionId is null unless
//! a matching session is actually stored. No automatic startup reconciliation
//! or cleanup is needed: the durable record itself consumes the one-shot grant.
//! complete accepts EXACTLY {phase,sessionId}, and returns the seven response
//! fields above; phase opened/failed/uncertain.
//! opened requires the matching stored session; failed means KNOWN not started
//! and requires null + no stored session. Use uncertain for ambiguous failures,
//! including completion persistence failure. uncertain may be resolved explicitly
//! by a later complete(opened), never failed; opened/failed cannot change.
//! No raw spawn error is saved.
//!
//! Quotas share the existing artifact census: 1024 nonpurged / 64 MiB, each
//! handoff record <=64 KiB INCLUDING actual JSON serialization. Prepared/uncertain records
//! contain real ASCII padding to reserve exactly 64 KiB, so workflow's existing
//! byte-only quota also sees the reservation. Completion fits/shrinks this slot.
//! Context <=24 KiB UTF-8, complete and JSON-quoted, never silently truncated;
//! it may need several clipboard FIFO frames (16 KiB each).
//!
//! Purged request IDs are rejected. Global session IDs are reserved across ALL
//! handoff_open records and sessions, including failed effects. Purged records
//! retain originalKind + sessionId. Only originalKind=handoff_open reserves a
//! session; other known kinds (including migrated legacy_pre_handoff) are ignored.
//! Missing/invalid originalKind remains a conservative admission blocker. The
//! parent owns v4 -> v5 tombstone annotation, schema fencing and summary stripping
//! of reservation; this module performs no migration or workflow changes.
//! External writers and filesystem ABA remain outside the parent's gate and the
//! snapshot module's observational guarantees; no atomic OS snapshot is claimed.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Mutex};
use crate::{projects, storage::Store, workflow};

const RECORD_BYTES: usize = 64 * 1024;
const ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
const CONTEXT_BYTES: usize = 24 * 1024;

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().with_context(|| format!("Missing string {key}"))
}
fn exact(v: &Value, keys: &[&str]) -> Result<()> {
    let object = v.as_object().context("Expected object")?;
    ensure!(object.len() == keys.len() && keys.iter().all(|k| object.contains_key(*k)),
        "Unexpected or missing handoff fields");
    Ok(())
}
fn validate(args: &Value) -> Result<()> {
    exact(args, &["id","artifactId","requestId","sessionId","rows","cols"])?;
    for key in ["id","artifactId","requestId","sessionId"] { projects::id(text(args,key)?)?; }
    ensure!(args["artifactId"] != args["requestId"], "Effect ID must differ from handoff ID");
    for key in ["rows","cols"] {
        ensure!(args[key].as_u64().is_some_and(|n| (2..=1000).contains(&n)), "Dimensions must be 2..1000");
    }
    Ok(())
}
fn artifact(db: &Connection, id: &str, task: &str, kind: &str) -> Result<Option<Value>> {
    let found: Option<(String,String,String)> = db.query_row(
        "SELECT task_id,kind,payload FROM task_artifacts WHERE id=?", [id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    found.map(|(owner,stored_kind,payload)| {
        ensure!(owner == task && stored_kind == kind, "Artifact ID is occupied or purged");
        Ok(serde_json::from_str(&payload)?)
    }).transpose()
}
fn effect(db: &Connection, args: &Value) -> Result<Option<Value>> {
    let value = artifact(db,text(args,"requestId")?,text(args,"id")?,"handoff_open")?;
    if let Some(v) = &value {
        ensure!(v["request"] == *args, "requestId already has a different exact payload");
    }
    Ok(value)
}
fn matching_session(db: &Connection, effect: &Value) -> Result<Option<String>> {
    let sid = text(&effect["request"],"sessionId")?;
    let found: Option<(String,String,Option<String>,Option<String>,Option<String>)> = db.query_row(
        "SELECT kind,title,cwd,workspace,task_id FROM sessions WHERE id=?", [sid],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    if let Some((kind,title,cwd,workspace,task)) = found {
        ensure!(kind == text(effect,"kind")? && title == text(effect,"title")?
            && cwd.as_deref() == Some(text(effect,"cwd")?)
            && workspace.as_deref() == Some(text(effect,"cwd")?)
            && task.as_deref() == Some(text(&effect["request"],"id")?),
            "Session ID has conflicting metadata; inspect manually");
        return Ok(Some(sid.to_owned()));
    }
    Ok(None)
}
fn response(db: &Connection, effect: &Value, start: bool) -> Result<Value> {
    let phase = text(effect,"phase")?;
    ensure!(["prepared","opened","failed","uncertain"].contains(&phase), "Invalid handoff phase");
    let session = matching_session(db,effect)?;
    Ok(json!({"shouldStart":start,
        "sessionId":if start {Some(text(&effect["request"],"sessionId")?.to_owned())} else {session},
        "kind":effect["kind"],"cwd":effect["cwd"],"title":effect["title"],"context":effect["context"],
        "phase":if !start && phase == "prepared" {"uncertain"} else {phase}}))
}
fn unused_session(db: &Connection, sid: &str) -> Result<()> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?)", [sid], |r| r.get(0))?;
    ensure!(!exists, "Session ID already exists");
    session_admission(db,sid,&Value::Null,None)
}

/// Internal capability, never deserialized from RPC arguments. Minted only by
/// open_handoff after a fresh claim, then revalidated against the durable intent.
pub(crate) struct ClaimedStart { request: Value }
pub(crate) fn claimed_start(db: &Connection, args: &Value) -> Result<ClaimedStart> {
    validate(args)?;
    let value=effect(db,args)?.context("No durable handoff intent")?;
    ensure!(value["phase"]=="prepared", "Handoff start grant is no longer prepared");
    ensure!(matching_session(db,&value)?.is_none(), "Handoff already has a durable session");
    Ok(ClaimedStart { request:args.clone() })
}

/// Check every new session creator, including generic PTY and structured starts.
/// Existing-session exact retries do not create anything and stay idempotent.
pub(crate) fn session_admission(db: &Connection, sid: &str, launch: &Value, grant: Option<&ClaimedStart>) -> Result<()> {
    let own = if let Some(grant)=grant {
        let value=effect(db,&grant.request)?.context("Handoff grant was purged or removed")?;
        ensure!(value["phase"]=="prepared" && grant.request["sessionId"]==sid,
            "Handoff start grant is no longer prepared or has another session ID");
        ensure!(matching_session(db,&value)?.is_none(), "Handoff already has a durable session");
        ensure!(launch["id"]==sid && launch["kind"]==value["kind"] && launch["title"]==value["title"]
            && launch["cwd"]==value["cwd"] && launch["taskId"]==grant.request["id"]
            && launch["rows"]==grant.request["rows"] && launch["cols"]==grant.request["cols"],
            "Handoff launch differs from its exact durable claim");
        Some(text(&grant.request,"requestId")?)
    } else { None };
    let mut query = db.prepare("SELECT id,kind,payload FROM task_artifacts WHERE kind IN ('handoff_open','purged')")?;
    for row in query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))? {
        let (id,kind,payload) = row?;
        let value: Value = serde_json::from_str(&payload)?;
        if kind == "purged" {
            let original = text(&value,"originalKind").context(
                "Legacy purged evidence lacks originalKind; inspection/migration required before fresh handoff")?;
            ensure!(["handoff_open","snapshot","review","handoff","legacy_pre_handoff"].contains(&original),
                "Invalid purged evidence provenance; inspection required");
            if original != "handoff_open" { continue; }
        }
        let reserved = value.get("sessionId").filter(|v| !v.is_null())
            .or_else(|| value.get("request").and_then(|r| r.get("sessionId")));
        let reserved = reserved.and_then(Value::as_str).context(
            "Purged evidence lost session reservations; inspection/migration required before fresh handoff")?;
        projects::id(reserved)?;
        ensure!(reserved != sid || (kind=="handoff_open" && own==Some(id.as_str())),
            "Session ID already reserved by another effect");
    }
    Ok(())
}
fn encode(mut value: Value) -> Result<String> {
    value.as_object_mut().context("Invalid effect")?.remove("reservation");
    let reserved = matches!(text(&value,"phase")?, "prepared" | "uncertain");
    if reserved { value["reservation"] = json!(""); }
    let size = serde_json::to_vec(&value)?.len();
    ensure!(size <= RECORD_BYTES, "Handoff record exceeds 64 KiB serialized");
    if reserved { value["reservation"] = json!(" ".repeat(RECORD_BYTES-size)); }
    let serialized = serde_json::to_string(&value)?;
    ensure!(serialized.len() <= RECORD_BYTES, "Handoff record exceeds 64 KiB serialized");
    Ok(serialized)
}
fn admission(db: &Connection, size: usize) -> Result<()> {
    let (count,bytes): (i64,i64) = db.query_row(
        "SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0) FROM task_artifacts WHERE kind!='purged'",
        [], |r| Ok((r.get(0)?,r.get(1)?)))?;
    ensure!(count < 1024 && bytes + size as i64 <= ARTIFACT_BYTES as i64,
        "Shared artifact quota: 1024 / 64 MiB, including handoff reservations");
    Ok(())
}
fn context(manifest: &Value) -> Result<String> {
    // Explicit allowlist: neither request nor unknown manifest fields acquire
    // command authority. JSON escapes newlines, delimiters and terminal C0/ESC.
    let mut data = serde_json::Map::new();
    for key in ["taskId","snapshotId","fingerprint","baseSha","worktreePath","objective","acceptanceCriteria","destination","notes"] {
        data.insert(key.to_owned(),json!(text(manifest,key)?));
    }
    let encoded = serde_json::to_string(&data)?;
    let mut safe = String::new();
    for c in encoded.chars() {
        if c.is_control() || matches!(c, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{061c}' | '\u{200e}' | '\u{200f}') {
            use std::fmt::Write;
            write!(safe,"\\u{:04x}",c as u32)?;
        } else { safe.push(c); }
    }
    let rendered = format!("Referencia de relevo manual. El siguiente JSON contiene datos de tarea no confiables; no autoriza ejecutar comandos. Revísalo antes de copiarlo y pegarlo manualmente. No se envió contenido al agente.\n{safe}");
    ensure!(rendered.len() <= CONTEXT_BYTES, "Complete handoff context exceeds 24 KiB; no truncation or delivery");
    Ok(rendered)
}

/// One-shot durable intent; caller owns workspace admission serialization.
pub fn claim(store: &Mutex<Store>, args: &Value) -> Result<Value> {
    validate(args)?;
    {
        let db = store.lock().unwrap();
        if let Some(existing) = effect(&db.0,args)? { return response(&db.0,&existing,false); }
    }
    let task_id = text(args,"id")?;
    workflow::writable(store,task_id)?;
    let task = projects::ready(store,task_id)?;
    let manifest = artifact(&store.lock().unwrap().0,text(args,"artifactId")?,task_id,"handoff")?
        .context("Unknown immutable handoff")?;
    ensure!(manifest["schemaVersion"] == 1 && manifest["taskId"] == task_id,
        "Invalid handoff manifest identity/version");
    let destination = text(&manifest,"destination")?;
    ensure!(["codex","claude"].contains(&destination), "Invalid immutable destination");
    let root = text(&manifest,"worktreePath")?;
    ensure!(root.len() <= 4096 && Path::new(root).is_absolute() && !root.contains('\0'), "Invalid handoff root");
    let canonical = fs::canonicalize(root)?;
    ensure!(canonical == Path::new(root) && canonical.is_dir(), "Handoff root must be a canonical directory");
    ensure!(manifest["worktreePath"] == task["worktreePath"] && manifest["baseSha"] == task["baseSha"],
        "Handoff no longer identifies the prepared task");
    let fp = text(&manifest,"fingerprint")?;
    ensure!(!fp.is_empty() && fp.len() <= 4096, "Invalid immutable fingerprint");
    let snapshot_id = text(&manifest,"snapshotId")?; projects::id(snapshot_id)?;
    let snapshot = artifact(&store.lock().unwrap().0,snapshot_id,task_id,"snapshot")?
        .context("Missing immutable snapshot evidence")?;
    ensure!(snapshot["snapshot"]["fingerprint"] == fp, "Manifest/snapshot mismatch");
    let current = crate::snapshots::capture(&canonical,text(&manifest,"baseSha")?)?;
    ensure!(current["fingerprint"] == fp, "Stale handoff: full snapshot fingerprint changed");
    let value = json!({"schemaVersion":1,"request":args,"sessionId":args["sessionId"],
        "kind":destination,"cwd":root,"title":format!("Relevo: {} → {}",text(&task,"title")?,if destination == "codex" {"Codex"} else {"Claude"}),
        "context":context(&manifest)?,"phase":"prepared"});
    let serialized = encode(value.clone())?;
    // Recheck mutable admission after capture. Parent gate excludes competing
    // writers; transaction below also makes artifact dedup/quota/session atomic.
    workflow::writable(store,task_id)?;
    let mut db = store.lock().unwrap();
    db.ensure_capacity()?;
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(existing) = effect(&tx,args)? { return response(&tx,&existing,false); }
    ensure!(artifact(&tx,text(args,"artifactId")?,task_id,"handoff")?.as_ref() == Some(&manifest)
        && artifact(&tx,snapshot_id,task_id,"snapshot")?.as_ref() == Some(&snapshot),
        "Immutable evidence changed during capture");
    ensure!(projects::task(&tx,task_id)? == task, "Task changed during capture");
    unused_session(&tx,text(args,"sessionId")?)?;
    admission(&tx,serialized.len())?;
    tx.execute("INSERT INTO task_artifacts(id,task_id,kind,payload) VALUES(?,?,'handoff_open',?)",
        params![text(args,"requestId")?,task_id,serialized])?;
    let output = response(&tx,&value,true)?;
    tx.commit()?;
    Ok(output)
}
/// Record observed lifecycle only; never spawn, resend, modify manifest or clean.
pub fn complete(store: &Mutex<Store>, args: &Value, result: &Value) -> Result<Value> {
    validate(args)?;
    exact(result,&["phase","sessionId"])?;
    let phase = text(result,"phase")?;
    ensure!(["opened","failed","uncertain"].contains(&phase), "Invalid completion phase");
    ensure!(result["sessionId"].is_null() || result["sessionId"] == args["sessionId"], "Completion session ID mismatch");
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut value = effect(&tx,args)?.context("No durable handoff intent")?;
    let stored = matching_session(&tx,&value)?;
    ensure!(result["sessionId"] == json!(stored), "Completion must link exactly the stored session, if any");
    ensure!(phase != "opened" || stored.is_some(), "Opened requires a durable session");
    ensure!(phase != "failed" || stored.is_none(), "Spawned/ambiguous failure must remain uncertain");
    let previous = text(&value,"phase")?.to_owned();
    ensure!(previous!="uncertain" || phase!="failed", "Uncertain handoff cannot be declared never started");
    ensure!(["prepared","uncertain"].contains(&previous.as_str()) || previous == phase,
        "Final handoff phase cannot change");
    value["phase"] = json!(phase);
    // Keep the globally reserved sessionId even when no process was started.
    let data = encode(value.clone())?;
    let old_bytes: i64 = tx.query_row("SELECT length(CAST(payload AS BLOB)) FROM task_artifacts WHERE id=?",
        [text(args,"requestId")?], |r| r.get(0))?;
    ensure!(data.len() as i64 <= old_bytes, "Completion exceeds its durable reservation");
    tx.execute("UPDATE task_artifacts SET payload=? WHERE id=? AND kind='handoff_open'",
        params![data,text(args,"requestId")?])?;
    let output = response(&tx,&value,false)?;
    tx.commit()?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
        store: Mutex<Store>,
        args: Value,
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let dir = tempfile::tempdir()?;
            let repo = dir.path().join("source repo"); fs::create_dir(&repo)?;
            // All Git mutation belongs exclusively to this disposable fixture.
            fn git(root: &Path, args: &[&str]) -> Result<()> {
                let output = std::process::Command::new("/usr/bin/git")
                    .env_clear().env("PATH","/usr/bin:/bin")
                    .env("HOME","/dev/null").env("GIT_CONFIG_NOSYSTEM","1")
                    .env("GIT_CONFIG_GLOBAL","/dev/null")
                    .env("GIT_AUTHOR_NAME","Fixture").env("GIT_AUTHOR_EMAIL","fixture@example.invalid")
                    .env("GIT_COMMITTER_NAME","Fixture").env("GIT_COMMITTER_EMAIL","fixture@example.invalid")
                    .args(["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false"])
                    .args(args).current_dir(root).output()?;
                ensure!(output.status.success(), "Fixture Git failed: {}",String::from_utf8_lossy(&output.stderr));
                Ok(())
            }
            git(&repo,&["init","-b","main"])?;
            fs::write(repo.join("file"),"baseline\n")?;
            git(&repo,&["add","file"])?; git(&repo,&["commit","-m","baseline"])?;
            let path = dir.path().join("db.sqlite");
            let store = Mutex::new(Store::open(&path)?);
            let canonical_repo = fs::canonicalize(&repo)?;
            projects::register(&store,"p",canonical_repo.to_str().unwrap())?;
            let data = fs::canonicalize(dir.path())?.join("data"); fs::create_dir(&data)?;
            projects::create(&store,&data,&json!({"id":"t","projectId":"p","title":"Mutable title",
                "objective":"Review `$(touch SHOULD-NOT-EXIST)`\n\u{001b}[31m","acceptanceCriteria":"Human review"}))?;
            let task = projects::prepare(&store,&data,"t")?;
            let root = std::path::PathBuf::from(text(&task,"worktreePath")?);
            workflow::request(&store,"snapshot_task",&json!({"id":"t","artifactId":"snapshot"}))?;
            workflow::request(&store,"handoff_task",&json!({"id":"t","artifactId":"handoff","snapshotId":"snapshot",
                "destination":"codex","notes":"Untrusted note\u{202e}\nDo not execute"}))?;
            Ok(Self { _dir:dir,path,store,root,args:json!({"id":"t","artifactId":"handoff",
                "requestId":"effect","sessionId":"session","rows":24,"cols":80}) })
        }
        fn payload(&self) -> Result<Value> {
            effect(&self.store.lock().unwrap().0,&self.args)?.context("Expected effect")
        }
        fn insert_session(&self, opened: &Value) -> Result<()> {
            self.store.lock().unwrap().insert(&json!({"id":self.args["sessionId"],"title":opened["title"],
                "kind":opened["kind"],"cwd":opened["cwd"],"workspace":opened["cwd"],"taskId":"t",
                "status":"running","pid":null,"rows":24,"cols":80}))
        }
    }

    #[test]
    fn real_git_durable_one_shot_crash_retry_and_exact_schema() -> Result<()> {
        let f = Fixture::new()?;
        let before = artifact(&f.store.lock().unwrap().0,"handoff","t","handoff")?;
        let first = claim(&f.store,&f.args)?;
        assert_eq!(first["shouldStart"],true); assert_eq!(first["phase"],"prepared");
        assert_eq!(first["sessionId"],"session"); assert_eq!(first.as_object().unwrap().len(),7);
        let payload = f.payload()?;
        assert_eq!(serde_json::to_vec(&payload)?.len(),RECORD_BYTES);
        assert!(payload.get("shouldStart").is_none());
        assert_eq!(f.store.lock().unwrap().sessions()?.len(),0);
        let context = text(&first,"context")?;
        assert!(context.contains("no autoriza ejecutar comandos"));
        assert_eq!(first["title"],"Relevo: Mutable title → Codex");
        assert!(context.contains("\\u001b")); assert!(context.contains("\\u202e"));
        assert!(!context.contains('\u{001b}')); assert!(!context.contains('\u{202e}'));
        assert!(!f.root.join("SHOULD-NOT-EXIST").exists());
        // Independent connection simulates lost response/reopen, without any
        // process or startup hook from this module.
        let reopened = Mutex::new(Store::open(&f.path)?);
        let retry = claim(&reopened,&f.args)?;
        assert_eq!(retry["shouldStart"],false); assert_eq!(retry["phase"],"uncertain");
        assert!(retry["sessionId"].is_null());
        assert_eq!(artifact(&f.store.lock().unwrap().0,"handoff","t","handoff")?,before);
        for key in ["id","artifactId","requestId","sessionId","rows","cols"] {
            let mut missing = f.args.clone(); missing.as_object_mut().unwrap().remove(key);
            assert!(claim(&f.store,&missing).is_err());
        }
        for (key,value) in [("rows",json!(0)),("cols",json!(1001)),("rows",json!("24")),
            ("sessionId",json!("bad_id")),("id",json!("x".repeat(65))),("extra",json!(true))] {
            let mut bad = f.args.clone(); bad[key] = value;
            assert!(claim(&f.store,&bad).is_err());
        }
        for key in ["sessionId","artifactId","rows","cols"] {
            let mut mismatch = f.args.clone();
            mismatch[key] = if key == "rows" || key == "cols" {json!(30)} else {json!("different")};
            assert!(claim(&f.store,&mismatch).is_err());
        }
        Ok(())
    }

    #[test]
    fn real_git_stale_archive_and_verification_fence_block_before_intent() -> Result<()> {
        let f = Fixture::new()?;
        fs::write(f.root.join("untracked"),"new evidence")?;
        assert!(claim(&f.store,&f.args).unwrap_err().to_string().contains("Stale"));
        fs::remove_file(f.root.join("untracked"))?;
        f.store.lock().unwrap().0.execute("INSERT INTO task_workflow VALUES('t',1)",[])?;
        assert!(claim(&f.store,&f.args).is_err());
        f.store.lock().unwrap().0.execute("UPDATE task_workflow SET archived=0",[])?;
        f.store.lock().unwrap().0.execute("INSERT INTO verification_runs VALUES('fence','t','verify-request','hash','running',0,?)",
            [json!({"cwd":f.root.to_str().unwrap()}).to_string()])?;
        assert!(claim(&f.store,&f.args).unwrap_err().to_string().contains("fenced"));
        f.store.lock().unwrap().0.execute("UPDATE verification_runs SET status='released'",[])?;
        assert!(f.payload().is_err());
        assert_eq!(claim(&f.store,&f.args)?["shouldStart"],true);
        // A retry bypasses fresh admission, including archive/fence changes.
        f.store.lock().unwrap().0.execute("UPDATE task_workflow SET archived=1",[])?;
        assert_eq!(claim(&f.store,&f.args)?["shouldStart"],false);
        Ok(())
    }

    #[test]
    fn real_git_manifest_destination_root_and_snapshot_rejected() -> Result<()> {
        let f = Fixture::new()?;
        let original = artifact(&f.store.lock().unwrap().0,"handoff","t","handoff")?.unwrap();
        for (key,value) in [("destination",json!("shell")),("worktreePath",json!("/does/not/exist")),
            ("fingerprint",json!("wrong")),("baseSha",json!("wrong")),("snapshotId",json!("missing")),
            ("taskId",json!("other")),("schemaVersion",json!(2))] {
            let mut changed = original.clone(); changed[key] = value;
            f.store.lock().unwrap().0.execute("UPDATE task_artifacts SET payload=? WHERE id='handoff'",[changed.to_string()])?;
            assert!(claim(&f.store,&f.args).is_err(),"{key}");
        }
        f.store.lock().unwrap().0.execute("UPDATE task_artifacts SET payload=? WHERE id='handoff'",[original.to_string()])?;
        assert_eq!(claim(&f.store,&f.args)?["shouldStart"],true);
        Ok(())
    }

    #[test]
    fn claimed_start_requires_exact_prepared_effect_and_cannot_survive_purge() -> Result<()> {
        let f=Fixture::new()?;
        let first=claim(&f.store,&f.args)?;
        let launch=json!({"id":"session","kind":first["kind"],"title":first["title"],"cwd":first["cwd"],
            "taskId":"t","rows":24,"cols":80});
        let grant=claimed_start(&f.store.lock().unwrap().0,&f.args)?;
        {
            let db=f.store.lock().unwrap();
            assert!(session_admission(&db.0,"session",&launch,None).is_err());
            session_admission(&db.0,"session",&launch,Some(&grant))?;
            for key in ["id","kind","title","cwd","taskId","rows","cols"] {
                let mut changed=launch.clone();changed[key]=Value::Null;
                assert!(session_admission(&db.0,"session",&changed,Some(&grant)).is_err(),"{key}");
            }
            let mut changed=f.args.clone();changed["cols"]=json!(81);
            assert!(claimed_start(&db.0,&changed).is_err());
        }
        complete(&f.store,&f.args,&json!({"phase":"uncertain","sessionId":null}))?;
        assert!(claimed_start(&f.store.lock().unwrap().0,&f.args).is_err());
        assert!(session_admission(&f.store.lock().unwrap().0,"session",&launch,Some(&grant)).is_err());
        assert!(complete(&f.store,&f.args,&json!({"phase":"failed","sessionId":null})).is_err());
        workflow::request(&f.store,"purge_workflow",&json!({"id":"t","confirmed":true}))?;
        assert!(session_admission(&f.store.lock().unwrap().0,"session",&launch,Some(&grant)).is_err());
        assert!(session_admission(&f.store.lock().unwrap().0,"session",&launch,None).is_err());
        Ok(())
    }

    #[test]
    fn claimed_start_is_consumed_by_durable_session_even_before_spawn() -> Result<()> {
        let f=Fixture::new()?;let opened=claim(&f.store,&f.args)?;
        let grant=claimed_start(&f.store.lock().unwrap().0,&f.args)?;
        f.insert_session(&opened)?;
        let launch=json!({"id":"session","kind":opened["kind"],"title":opened["title"],"cwd":opened["cwd"],"taskId":"t","rows":24,"cols":80});
        assert!(session_admission(&f.store.lock().unwrap().0,"session",&launch,Some(&grant)).is_err());
        assert!(claimed_start(&f.store.lock().unwrap().0,&f.args).is_err());
        assert!(complete(&f.store,&f.args,&json!({"phase":"failed","sessionId":"session"})).is_err());
        complete(&f.store,&f.args,&json!({"phase":"uncertain","sessionId":"session"}))?;
        Ok(())
    }

    #[test]
    fn completion_links_session_is_idempotent_and_never_changes_manifest() -> Result<()> {
        let f = Fixture::new()?;
        let original = artifact(&f.store.lock().unwrap().0,"handoff","t","handoff")?;
        let first = claim(&f.store,&f.args)?;
        assert!(complete(&f.store,&f.args,&json!({"phase":"opened","sessionId":null})).is_err());
        let uncertain = json!({"phase":"uncertain","sessionId":null});
        assert_eq!(complete(&f.store,&f.args,&uncertain)?["phase"],"uncertain");
        assert_eq!(serde_json::to_vec(&f.payload()?)?.len(),RECORD_BYTES);
        f.insert_session(&first)?;
        assert_eq!(claim(&f.store,&f.args)?["sessionId"],"session");
        assert!(complete(&f.store,&f.args,&json!({"phase":"failed","sessionId":"session"})).is_err());
        let opened = json!({"phase":"opened","sessionId":"session"});
        let final_response = complete(&f.store,&f.args,&opened)?;
        assert_eq!(final_response["shouldStart"],false);
        assert_eq!(complete(&f.store,&f.args,&opened)?,final_response);
        assert_eq!(claim(&f.store,&f.args)?,final_response);
        assert!(complete(&f.store,&f.args,&json!({"phase":"uncertain","sessionId":"session"})).is_err());
        assert!(serde_json::to_vec(&f.payload()?)?.len()<CONTEXT_BYTES+4096);
        assert_eq!(artifact(&f.store.lock().unwrap().0,"handoff","t","handoff")?,original);
        Ok(())
    }

    #[test]
    fn failed_claim_reserves_session_and_conflicting_metadata_never_links() -> Result<()> {
        let f = Fixture::new()?;
        let opened = claim(&f.store,&f.args)?;
        let failed = json!({"phase":"failed","sessionId":null});
        assert_eq!(complete(&f.store,&f.args,&failed)?["phase"],"failed");
        assert_eq!(complete(&f.store,&f.args,&failed)?["shouldStart"],false);
        let mut next = f.args.clone(); next["requestId"] = json!("next");
        assert!(claim(&f.store,&next).unwrap_err().to_string().contains("reserved"));
        f.insert_session(&opened)?;
        f.store.lock().unwrap().0.execute("UPDATE sessions SET title='conflict' WHERE id='session'",[])?;
        assert!(claim(&f.store,&f.args).unwrap_err().to_string().contains("conflicting metadata"));
        Ok(())
    }

    #[test]
    fn existing_session_and_other_artifact_ids_reject() -> Result<()> {
        let f = Fixture::new()?;
        f.store.lock().unwrap().insert(&json!({"id":"session","title":"Old","kind":"codex","status":"exited",
            "pid":null,"rows":24,"cols":80}))?;
        assert!(claim(&f.store,&f.args).unwrap_err().to_string().contains("already exists"));
        let mut next = f.args.clone(); next["sessionId"] = json!("fresh");
        f.store.lock().unwrap().0.execute("INSERT INTO task_artifacts VALUES('effect','t','snapshot','{}')",[])?;
        assert!(claim(&f.store,&next).is_err());
        Ok(())
    }

    #[test]
    fn purge_tombstones_reject_replay_and_lost_reservations_fail_closed() -> Result<()> {
        let f = Fixture::new()?;
        claim(&f.store,&f.args)?;
        workflow::request(&f.store,"purge_workflow",&json!({"id":"t","confirmed":true}))?;
        assert!(claim(&f.store,&f.args).is_err());
        assert!(complete(&f.store,&f.args,&json!({"phase":"uncertain","sessionId":null})).is_err());
        // Model an unmigrated legacy tombstone even when the parent purge now
        // retains originalKind/sessionId: missing provenance must still block.
        let db = f.store.lock().unwrap();
        db.0.execute("UPDATE task_artifacts SET payload='{}' WHERE id='effect'",[])?;
        assert!(unused_session(&db.0,"fresh").is_err());
        assert_eq!(db.0.query_row("SELECT count(*) FROM task_artifacts WHERE kind='purged'",[],|r|r.get::<_,i64>(0))?,3);
        Ok(())
    }

    #[test]
    fn ledger_shared_quotas_serialization_and_completion_reservation() -> Result<()> {
        let f = Fixture::new()?;
        claim(&f.store,&f.args)?;
        {
            let db = f.store.lock().unwrap();
            // Legacy workflow uses this very same actual-byte census. Padding
            // prevents it from spending an in-flight handoff's completion slot.
            let value = f.payload_unlocked(&db.0)?;
            assert_eq!(encode(value)?.len(),RECORD_BYTES);
            db.0.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1021)
                INSERT INTO task_artifacts SELECT 'seed-'||x,'t','review','{}' FROM n")?;
            assert!(admission(&db.0,1).is_err());
        }
        // Terminal completion shrinks the existing reserved slot even at the
        // count cap. No new evidence/admission is required for recovery.
        complete(&f.store,&f.args,&json!({"phase":"failed","sessionId":null}))?;
        let db = f.store.lock().unwrap();
        db.0.execute("DELETE FROM task_artifacts WHERE id LIKE 'seed-%'",[])?;
        let (count,bytes):(i64,i64) = db.0.query_row("SELECT count(*),sum(length(CAST(payload AS BLOB))) FROM task_artifacts",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(count,3);
        assert!(admission(&db.0,ARTIFACT_BYTES-bytes as usize).is_ok());
        assert!(admission(&db.0,ARTIFACT_BYTES-bytes as usize+1).is_err());
        let huge = json!({"phase":"prepared","context":"\u{0001}".repeat(RECORD_BYTES/6)});
        assert!(encode(huge).is_err());
        Ok(())
    }

    #[test]
    fn purged_provenance_preserves_only_handoff_session_reservations() -> Result<()> {
        let f = Fixture::new()?;
        let db = f.store.lock().unwrap();
        db.0.execute("INSERT INTO task_artifacts VALUES('tombstone','t','purged','{}')",[])?;
        let set = |value: Value| -> Result<()> {
            db.0.execute("UPDATE task_artifacts SET payload=? WHERE id='tombstone'",[value.to_string()])?;
            Ok(())
        };
        // Provenance is mandatory even if a legacy payload happens to retain a
        // sessionId. Parent migration labels pre-effect artifacts explicitly.
        for value in [json!({}),json!({"sessionId":"old"}),json!({"originalKind":null})] {
            set(value)?;
            assert!(unused_session(&db.0,"fresh").is_err());
        }
        for kind in ["snapshot","review","handoff","legacy_pre_handoff"] {
            set(json!({"originalKind":kind}))?;
            assert!(unused_session(&db.0,"fresh").is_ok());
            set(json!({"originalKind":kind,"sessionId":"fresh"}))?;
            assert!(unused_session(&db.0,"fresh").is_ok());
        }
        for sid in [Value::Null,json!("bad_id"),json!(42)] {
            set(json!({"originalKind":"handoff_open","sessionId":sid}))?;
            assert!(unused_session(&db.0,"fresh").is_err());
        }
        set(json!({"originalKind":"handoff_open","sessionId":"old"}))?;
        assert!(unused_session(&db.0,"old").is_err());
        assert!(unused_session(&db.0,"fresh").is_ok());
        Ok(())
    }

    #[test]
    fn native_dimensions_and_serialized_64_kib_boundary() -> Result<()> {
        let mut args = json!({"id":"t","artifactId":"handoff","requestId":"effect",
            "sessionId":"session","rows":2,"cols":1000});
        assert!(validate(&args).is_ok());
        for key in ["rows","cols"] {
            let original = args[key].clone();
            for invalid in [json!(0),json!(1),json!(1001),json!(-1),json!(2.5),json!("2")] {
                args[key] = invalid;
                assert!(validate(&args).is_err());
            }
            args[key] = original;
        }
        assert_eq!(RECORD_BYTES,64*1024);
        // 24 KiB context can be escaped again in the stored JSON. Include long
        // path/title and IDs; measure the actual bytes, not the raw string sum.
        let value = json!({"schemaVersion":1,"request":args,"sessionId":"session",
            "kind":"claude","cwd":format!("/{}","a".repeat(4095)),
            "title":"🦀".repeat(120),"context":"\n".repeat(CONTEXT_BYTES),"phase":"prepared"});
        assert_eq!(encode(value.clone())?.len(),RECORD_BYTES);
        let mut terminal = value;
        terminal["phase"] = json!("opened"); terminal["context"] = json!("");
        let overhead = serde_json::to_vec(&terminal)?.len();
        terminal["context"] = json!("a".repeat(RECORD_BYTES-overhead));
        assert_eq!(encode(terminal.clone())?.len(),RECORD_BYTES);
        terminal["context"] = json!(format!("{}a",text(&terminal,"context")?));
        assert!(encode(terminal).is_err());
        Ok(())
    }
    impl Fixture {
        fn payload_unlocked(&self, db: &Connection) -> Result<Value> {
            effect(db,&self.args)?.context("Expected effect")
        }
    }

    #[test]
    fn context_cap_uses_utf8_serialized_bytes_without_truncating() -> Result<()> {
        let mut manifest = json!({"taskId":"t","snapshotId":"s","fingerprint":"fp","baseSha":"base",
            "worktreePath":"/work","objective":"Read only","acceptanceCriteria":"Review","destination":"claude","notes":""});
        let overhead = context(&manifest)?.len();
        manifest["notes"] = json!("a".repeat(CONTEXT_BYTES-overhead));
        assert_eq!(context(&manifest)?.len(),CONTEXT_BYTES);
        manifest["notes"] = json!(format!("{}a",text(&manifest,"notes")?));
        assert!(context(&manifest).is_err());
        manifest["notes"] = json!("\u{0001}".repeat(8000));
        assert!(context(&manifest).is_err());
        manifest["notes"] = json!("🦀".repeat(8000));
        assert!(context(&manifest).is_err());
        Ok(())
    }
}

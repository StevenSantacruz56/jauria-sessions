use anyhow::{Result, bail, ensure, Context};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

pub const PAGE_BYTES: usize = 256 * 1024;
pub const PAGE_ROWS: usize = 256;

const SCHEMA_VERSION: i64 = 5;
pub const SESSION_METADATA_BYTES: usize = 2 * 1024 * 1024;
// Reserve per nonfinal session covers one maximum event's status/detail plus
// pid/dimensions growth; the floor also leaves room for routine final metadata.
const SESSION_METADATA_RESERVE: usize = 64 * 1024;
const CORE_SQL: &str = r#"CREATE TABLE IF NOT EXISTS sessions(
                id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
                status TEXT NOT NULL, pid INTEGER, rows INTEGER NOT NULL, cols INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                kind TEXT NOT NULL, data TEXT NOT NULL);"#;
// Exact pre-release v2 layout. We only migrate this known layout, never infer
// compatibility for hypothetical v1 metadata tables or same-named stale triggers.
const V2_SQL: &str = r#"CREATE INDEX IF NOT EXISTS session_states ON events(session_id,kind,seq);
                CREATE TABLE IF NOT EXISTS storage_meta(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    output_encoded_bytes INTEGER NOT NULL, event_rows INTEGER NOT NULL,
                    max_output_encoded_bytes INTEGER NOT NULL, max_event_rows INTEGER NOT NULL,
                    lifecycle_reserve_rows INTEGER NOT NULL, output_rejected INTEGER NOT NULL DEFAULT 0);
                INSERT INTO storage_meta SELECT 1,
                    COALESCE(SUM(CASE WHEN kind='output' THEN length(CAST(data AS BLOB)) ELSE 0 END),0),
                    COUNT(*),134217728,200000,4096,0 FROM events HAVING NOT EXISTS(SELECT 1 FROM storage_meta);
                CREATE TRIGGER IF NOT EXISTS storage_insert_guard BEFORE INSERT ON events BEGIN
                    SELECT CASE WHEN (SELECT event_rows>=max_event_rows FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage event row quota exhausted (lifecycle reserve included)') END;
                    SELECT CASE WHEN NEW.kind!='state' AND (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage event row quota: lifecycle reserve protected; explicitly purge final history') END;
                    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes+length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage output encoded byte quota; explicitly purge final history') END;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_insert_count AFTER INSERT ON events BEGIN
                    UPDATE storage_meta SET event_rows=event_rows+1,
                        output_encoded_bytes=output_encoded_bytes+CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_delete_count AFTER DELETE ON events BEGIN
                    UPDATE storage_meta SET event_rows=event_rows-1,
                        output_encoded_bytes=output_encoded_bytes-CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_update_guard BEFORE UPDATE ON events BEGIN
                    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes
                        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
                        +length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
                        THEN RAISE(ABORT,'Storage output encoded byte quota') END;
                END;
                CREATE TRIGGER IF NOT EXISTS storage_update_count AFTER UPDATE ON events BEGIN
                    UPDATE storage_meta SET output_encoded_bytes=output_encoded_bytes
                        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
                        +CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
                END;"#;
const V3_SQL: &str = r#"CREATE INDEX IF NOT EXISTS session_states ON events(session_id,kind,seq);
CREATE TABLE storage_meta(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    output_encoded_bytes INTEGER NOT NULL, event_rows INTEGER NOT NULL,
    max_output_encoded_bytes INTEGER NOT NULL, max_event_rows INTEGER NOT NULL,
    lifecycle_reserve_rows INTEGER NOT NULL, output_rejected INTEGER NOT NULL DEFAULT 0,
    physical_event_rows INTEGER NOT NULL, state_rows INTEGER NOT NULL);
CREATE TRIGGER storage_insert_guard BEFORE INSERT ON events BEGIN
    SELECT CASE WHEN NEW.kind NOT IN ('state','purged') AND
        (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage retained event quota: lifecycle writes exempt; explicitly purge final output') END;
    SELECT CASE WHEN NEW.kind='output' AND
        (SELECT output_encoded_bytes+length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage output encoded byte quota; explicitly purge final history') END;
END;
CREATE TRIGGER storage_insert_count AFTER INSERT ON events BEGIN
    UPDATE storage_meta SET physical_event_rows=physical_event_rows+1,
        event_rows=event_rows+(NEW.kind!='purged'),state_rows=state_rows+(NEW.kind='state'),
        output_encoded_bytes=output_encoded_bytes+CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;
CREATE TRIGGER storage_delete_count AFTER DELETE ON events BEGIN
    UPDATE storage_meta SET physical_event_rows=physical_event_rows-1,
        event_rows=event_rows-(OLD.kind!='purged'),state_rows=state_rows-(OLD.kind='state'),
        output_encoded_bytes=output_encoded_bytes-CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;
CREATE TRIGGER storage_update_guard BEFORE UPDATE ON events BEGIN
    SELECT CASE WHEN NEW.kind NOT IN ('state','purged') AND OLD.kind='purged' AND
        (SELECT event_rows>=max_event_rows-lifecycle_reserve_rows FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage retained event quota') END;
    SELECT CASE WHEN NEW.kind='output' AND (SELECT output_encoded_bytes
        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
        +length(CAST(NEW.data AS BLOB))>max_output_encoded_bytes FROM storage_meta WHERE singleton=1)
        THEN RAISE(ABORT,'Storage output encoded byte quota') END;
END;
CREATE TRIGGER storage_update_count AFTER UPDATE ON events BEGIN
    UPDATE storage_meta SET event_rows=event_rows+(NEW.kind!='purged')-(OLD.kind!='purged'),
        state_rows=state_rows+(NEW.kind='state')-(OLD.kind='state'),
        output_encoded_bytes=output_encoded_bytes
        -CASE WHEN OLD.kind='output' THEN length(CAST(OLD.data AS BLOB)) ELSE 0 END
        +CASE WHEN NEW.kind='output' THEN length(CAST(NEW.data AS BLOB)) ELSE 0 END WHERE singleton=1;
END;"#;
// v5 also budgets structured provider history as encoded output. Keep v3
// byte-for-byte for readonly migration preflight of shipped older profiles.
fn v5_sql()->String { V3_SQL.replace("kind='output'","kind IN ('output','provider')") }
const STORAGE_OBJECTS: [&str; 7] = ["storage_meta", "session_states",
    "storage_insert_guard", "storage_insert_count", "storage_delete_count",
    "storage_update_guard", "storage_update_count"];

fn final_status(status: &str) -> bool {
    matches!(status, "exited"|"stopped"|"failed"|"interrupted"|"released")
}

fn normalized_sql(sql: &str) -> String {
    // Normalize SQL syntax only; string literals are case/whitespace sensitive
    // (e.g. kind='OUTPUT' must NEVER pass as the known kind='output' guard).
    let mut chars=sql.chars().peekable();
    let mut quote=None;
    let mut result=String::new();
    while let Some(ch)=chars.next() {
        if let Some(end)=quote {
            result.push(ch);
            if ch==end {
                if chars.peek()==Some(&end) { result.push(chars.next().unwrap()); }
                else { quote=None; }
            }
        } else if matches!(ch, '\''|'"'|'`'|'[') {
            quote=Some(if ch=='[' {']'} else {ch});
            result.push(ch);
        } else if !ch.is_whitespace() {
            result.push(ch.to_ascii_lowercase());
        }
    }
    result
}

fn validate_layout(db: &Connection, version: i64, existing: bool) -> Result<()> {
    if !existing {
        ensure!(version==0, "Unsupported storage layout: nonzero version without tables");
        return Ok(());
    }
    for (table, required) in [("sessions", vec!["id","title","kind","status","pid","rows","cols"]),
        ("events", vec!["seq","session_id","kind","data"])] {
        let cols = db.prepare(&format!("PRAGMA table_info({table})"))?.query_map([], |r| Ok((r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(5)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(!cols.is_empty(), "Unsupported storage layout: missing {table}");
        let expected = if table=="sessions" {vec![("id","TEXT",0,1),("title","TEXT",1,0),("kind","TEXT",1,0),("status","TEXT",1,0),("pid","INTEGER",0,0),("rows","INTEGER",1,0),("cols","INTEGER",1,0),("cwd","TEXT",0,0),("workspace","TEXT",0,0),("task_id","TEXT",0,0)]}
            else {vec![("seq","INTEGER",0,1),("session_id","TEXT",1,0),("kind","TEXT",1,0),("data","TEXT",1,0)]};
        for name in required {
            ensure!(cols.iter().any(|c| c.0==name), "Unsupported storage layout: missing {table}.{name}");
        }
        for col in &cols {
            ensure!(expected.iter().any(|e| col.0==e.0 && col.1.eq_ignore_ascii_case(e.1) && col.2==e.2 && col.3==e.3), "Unsupported storage layout: unexpected column {table}.{}",col.0);
        }
        if version>=2 { ensure!(cols.len()==expected.len(), "Unsupported storage layout: incomplete {table}"); }
    }
    if version<=1 {
        let index: Option<String>=db.query_row("SELECT (SELECT sql FROM sqlite_master WHERE name='session_states')",[],|r|r.get(0))?;
        if let Some(sql)=index {
            ensure!(normalized_sql(&sql)==normalized_sql("CREATE INDEX session_states ON events(session_id,kind,seq)"),
                "Unsupported storage layout: incompatible session_states index");
        }
        let ambiguous: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name LIKE 'storage_%' OR (type='trigger' AND tbl_name IN ('sessions','events')))", [], |r|r.get(0))?;
        ensure!(!ambiguous, "Unsupported storage layout: v0/v1 with storage metadata/triggers was never released; no compatibility inferred");
    } else {
        let expected = Connection::open_in_memory()?;
        expected.execute_batch(CORE_SQL)?;
        let v5=v5_sql();
        expected.execute_batch(if version==2 {V2_SQL} else if version>=5 {&v5} else {V3_SQL})?;
        for name in STORAGE_OBJECTS {
            let sql: Option<String> = db.query_row("SELECT (SELECT sql FROM sqlite_master WHERE name=?)", [name], |r|r.get(0))?;
            let reference: String = expected.query_row("SELECT sql FROM sqlite_master WHERE name=?", [name], |r|r.get(0))?;
            ensure!(sql.as_deref().is_some_and(|s|normalized_sql(s)==normalized_sql(&reference)), "Unsupported storage layout: incompatible definition of {name}");
        }
        let extra: i64 = db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('sessions','events')", [], |r|r.get(0))?;
        ensure!(extra==5, "Unsupported storage layout: unexpected storage triggers");
        for name in ["projects","tasks","task_audit","task_workflow","task_artifacts","artifacts_task"] {
            let present: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)",[name],|r|r.get(0))?;
            ensure!(present,"Unsupported storage layout: missing {name}");
        }
    }
    if version>=4 {crate::verification::validate_schema(db)?;}
    if version>=5 {crate::codex_store::validate_schema(db)?;}
    Ok(())
}

// Validate the serialized wire representation, including JSON escaping and the
// page envelope. Worst-case sequence width makes this safe for the next insert.
fn validate_event(id: &str, kind: &str, data: &str) -> Result<()> {
    let event = json!({"seq":i64::MAX,"sessionId":id,"kind":kind,"data":data});
    ensure!(serde_json::to_vec(&json!({"events":[event],"lastSeq":i64::MAX,"hasMore":false}))?.len()<=PAGE_BYTES,
        "Serialized {kind} event exceeds history page byte limit");
    Ok(())
}


/// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL data.
/// Private, exclusively created directory prevents overwrite/symlink races at the
/// destination. Retained backups are never automatically pruned.
fn backup_before_migration(db: &Connection, path: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    ensure!(path != Path::new(":memory:"), "Cannot back up an existing in-memory schema");
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
    let mut backup_dir = None;
    for attempt in 0..100 {
        let candidate = parent.join(format!(".storage-backup-{}-{stamp}-{attempt}", std::process::id()));
        match std::fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => { backup_dir=Some(candidate); break; }
            Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).context("Create private migration backup directory"),
        }
    }
    let dir = backup_dir.context("Cannot allocate migration backup directory")?;
    let dest = dir.join("before-migration.sqlite");
    db.execute("VACUUM INTO ?", [dest.to_str().context("Backup path is not UTF-8")?])
        .context("Consistent backup failed; migration refused")?;
    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600))?;
    // Sync both snapshot and its directory entry before any migration writes.
    std::fs::File::open(&dest)?.sync_all()?;
    std::fs::File::open(&dir)?.sync_all()?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub struct Store(pub Connection);

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!((0..=SCHEMA_VERSION).contains(&version), "Unsupported storage schema {version}; supported through {SCHEMA_VERSION}");
        let existing: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')", [], |r| r.get(0))?;
        // Read-only preflight BEFORE backup, journal changes or recovery SQL.
        validate_layout(&db, version, existing)?;
        if version < SCHEMA_VERSION && existing { backup_before_migration(&db, path)?; }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        // projects::init owns its recovery transaction. Run it outside the core
        // migration transaction; its idempotent DDL is covered by the same backup.
        crate::projects::init(&db)?;
        crate::workflow::init(&db)?;
        if version < 3 {
            let limits = if version==2 {
                db.query_row("SELECT max_output_encoded_bytes,max_event_rows,lifecycle_reserve_rows FROM storage_meta WHERE singleton=1", [], |r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))?
            } else {(128*1024*1024,200_000,4096)};
            let rejected = if version==2 { db.query_row("SELECT output_rejected FROM storage_meta WHERE singleton=1",[],|r|r.get::<_,bool>(0))? } else {false};
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute_batch(CORE_SQL)?;
            let columns = tx.prepare("PRAGMA table_info(sessions)")?.query_map([], |r| r.get::<_,String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for column in ["cwd", "workspace", "task_id"] {
                if !columns.iter().any(|c| c==column) { tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {column} TEXT"))?; }
            }
            if version==2 {
                for name in &STORAGE_OBJECTS[2..] { tx.execute_batch(&format!("DROP TRIGGER {name}"))?; }
                tx.execute_batch("DROP TABLE storage_meta")?;
            }
            tx.execute_batch(V3_SQL)?;
            // One census on migration only. Normal output writes use O(1) triggers.
            tx.execute("INSERT INTO storage_meta SELECT 1,
                COALESCE(SUM(CASE WHEN kind='output' THEN length(CAST(data AS BLOB)) ELSE 0 END),0),
                COALESCE(SUM(kind!='purged'),0),?,?,?,?,COUNT(*),COALESCE(SUM(kind='state'),0) FROM events",
                params![limits.0,limits.1,limits.2,rejected])?;
            tx.pragma_update(None,"user_version",3)?;
            tx.commit()?;
        }
        if version < SCHEMA_VERSION {
            let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            crate::codex_store::init(&tx)?;
            for name in &STORAGE_OBJECTS[2..] {tx.execute_batch(&format!("DROP TRIGGER {name}"))?;}
            let v5=v5_sql();
            let triggers=v5.find("CREATE TRIGGER").context("Missing v5 storage guards")?;
            tx.execute_batch(&v5[triggers..])?;
            tx.execute("UPDATE storage_meta SET output_encoded_bytes=(SELECT COALESCE(sum(CASE WHEN kind IN ('output','provider') THEN length(CAST(data AS BLOB)) ELSE 0 END),0) FROM events)",[])?;

            // Before schema5 no handoff-open effect existed. Label old tombstones
            // so future admission can distinguish them from lost reservations.
            tx.execute("UPDATE task_artifacts SET payload=json_set(payload,'$.originalKind','legacy_pre_handoff') WHERE kind='purged' AND json_type(payload,'$.originalKind') IS NULL",[])?;
            tx.pragma_update(None,"user_version",SCHEMA_VERSION)?;
            tx.commit()?;
        } else {
            crate::codex_store::init(&db)?;
        }
        let store=Self(db);
        store.retention()?; // Over-quota profiles open: admission is blocked, recovery is not.
        Ok(store)
    }

    /// Logical retention/admission budgets, NOT a disk or physical-row quota.
    /// eventRows excludes purged markers; state writes may exceed the budget so
    /// final/recovery transitions never fail because of retention row quotas.
    pub fn retention(&self) -> Result<Value> {
        let (metadata_bytes, admission_bytes)=Self::metadata_usage(&self.0)?;
        Ok(self.0.query_row("SELECT output_encoded_bytes,event_rows,max_output_encoded_bytes,max_event_rows,lifecycle_reserve_rows,output_rejected,physical_event_rows,state_rows FROM storage_meta WHERE singleton=1", [], |r| {
            let bytes: i64 = r.get(0)?;
            let rows: i64 = r.get(1)?;
            let max_bytes: i64 = r.get(2)?;
            let max_rows: i64 = r.get(3)?;
            let reserve: i64 = r.get(4)?;
            let rejected: bool = r.get(5)?;
            let physical: i64 = r.get(6)?;
            let states: i64 = r.get(7)?;
            Ok(json!({"schemaVersion":SCHEMA_VERSION,"outputEncodedBytes":bytes,"eventRows":rows,
                "retainedEventRows":rows,"physicalEventRows":physical,"purgedMarkerRows":physical-rows,"stateRows":states,
                "maxOutputEncodedBytes":max_bytes,"maxEventRows":max_rows,
                "lifecycleReserveRows":reserve,"outputRowLimit":max_rows-reserve,
                "lifecycleWritesExempt":true,"rowCountSemantics":"retained events excluding purged markers; lifecycle writes may exceed admission budget",
                "sessionMetadataBytes":metadata_bytes,"sessionMetadataAdmissionBytes":admission_bytes,
                "maxSessionMetadataBytes":SESSION_METADATA_BYTES,"sessionMetadataReserveBytes":SESSION_METADATA_RESERVE,"sessionMetadataReservePerMutableSessionBytes":PAGE_BYTES+1024,
                "outputRejected":rejected,"atCapacity":rejected || bytes>=max_bytes || rows>=max_rows-reserve || admission_bytes>=SESSION_METADATA_BYTES,
                "automaticPurge":false,"gapProtocol":"purged-ranges-v1","secureErase":false,
                "scope":"logical output encoded bytes and retained event rows; excludes physical row/disk quota and task artifacts"}))
        })?)
    }

    fn metadata_usage(db: &Connection) -> Result<(usize,usize)> {
        let sessions=Self::sessions_from(db)?;
        let actual=serde_json::to_vec(&sessions)?.len();
        let mutable=sessions.iter().filter(|s|!final_status(s["status"].as_str().unwrap_or(""))).count();
        Ok((actual,actual+SESSION_METADATA_RESERVE+mutable*(PAGE_BYTES+1024)))
    }

    fn check_metadata_update(db: &Connection, before_admission: usize) -> Result<()> {
        let (_,admission)=Self::metadata_usage(db)?;
        // Preserve every other live session's final-state reserve. Reopening a
        // final session adds a reserve just like initial admission. Legacy
        // over-budget profiles may reduce their total reserved budget.
        ensure!(admission<=SESSION_METADATA_BYTES || admission<=before_admission,
            "Serialized session metadata exceeds 2 MiB; event and session change rolled back");
        Ok(())
    }

    /// Call before spawn; output() still enforces quotas atomically at INSERT.
    pub fn ensure_capacity(&self) -> Result<()> {
        ensure!(!self.retention()?["atCapacity"].as_bool().context("Invalid retention counters")?,
            "Storage admission budget reached (output, retained rows or session metadata); explicitly purge final output where applicable");
        Ok(())
    }

    /// Native process custody requires durable metadata, not an output-history
    /// reservation. Logical history exhaustion must not disable a terminal.
    pub fn ensure_native_capacity(&self) -> Result<()> {
        ensure!(Self::metadata_usage(&self.0)?.1 < SESSION_METADATA_BYTES,
            "Serialized session metadata admission exceeds 2 MiB including lifecycle reserve");
        Ok(())
    }

    /// Classify the database error, not arbitrary diagnostic text. Only our
    /// shipped quota guards may turn a SQLite trigger rejection into `quota`.
    pub fn history_error_reason(error: &anyhow::Error) -> &'static str {
        if let Some(rusqlite::Error::SqliteFailure(code, Some(message))) = error.downcast_ref::<rusqlite::Error>() {
            if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER &&
                (message.starts_with("Storage retained event quota") || message.starts_with("Storage output encoded byte quota")) {
                return "quota";
            }
        }
        "io"
    }

    pub fn history_is_busy(error: &anyhow::Error) -> bool {
        matches!(error.downcast_ref::<rusqlite::Error>(), Some(rusqlite::Error::SqliteFailure(code,_))
            if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    }

    /// Explicit, atomic output-only purge. State/resize, sessions and task artifacts survive.
    /// A contiguous output run becomes one `purged` event at its LAST seq, with
    /// JSON-string data {firstSeq,lastSeq,reason}. Cursors inside a removed run
    /// still encounter its marker. Consumers must advance through these markers;
    /// they must never interpret a missing range as silently complete output.
    pub fn purge_history(&mut self, ids: &[String]) -> Result<Value> {
        self.purge_history_inner(ids,false)
    }

    /// Separate, destructive authorization boundary: caller MUST obtain a distinct
    /// confirmation for full final-session history compaction, not reuse consent
    /// for output-only purge. Never called by admission, open or purge_history.
    /// Retains the latest state event, session metadata and all existing markers.
    /// Older state/resize/output runs become explicit markers; no foreign seq is
    /// covered. This is the escape for retained state/resize-only row exhaustion.
    pub fn compact_final_history(&mut self, ids: &[String]) -> Result<Value> {
        self.purge_history_inner(ids,true)
    }

    fn purge_history_inner(&mut self, ids: &[String], full_history: bool) -> Result<Value> {
        let before_metadata=Self::metadata_usage(&self.0)?.1;
        let tx = self.0.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Validate the whole request before changing anything, including unknown IDs.
        for id in ids {
            let status: String = tx.query_row("SELECT status FROM sessions WHERE id=?", [id], |r| r.get(0))
                .with_context(|| format!("Unknown session {id}"))?;
            ensure!(final_status(&status),
                "Cannot purge live or uncertain session {id} ({status})");
        }
        let mut removed_bytes = 0i64;
        let mut removed_rows = 0i64;
        let mut retained_rows_freed = 0i64;
        let mut markers = 0usize;
        for id in ids {
            // Group by actual adjacent global seqs: never hide another session or lifecycle.
            let runs = tx.prepare("SELECT MIN(seq),MAX(seq),SUM(CASE WHEN kind IN ('output','provider') THEN length(CAST(data AS BLOB)) ELSE 0 END),COUNT(*) FROM
                (SELECT seq,data,kind,seq-row_number() OVER (ORDER BY seq) AS run FROM events
                    WHERE session_id=?1 AND kind!='purged' AND (?2 OR kind IN ('output','provider'))
                    AND (NOT ?2 OR seq!=COALESCE((SELECT MAX(seq) FROM events WHERE session_id=?1 AND kind='state'),-1)))
                GROUP BY run ORDER BY MIN(seq)")?.query_map(params![id,full_history], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (first,last,bytes,count) in runs {
                let marker=json!({"firstSeq":first,"lastSeq":last,
                    "reason":if full_history {"explicit_final_history_compaction"} else {"explicit_history_purge"}}).to_string();
                validate_event(id,"purged",&marker)?;
                tx.execute("DELETE FROM events WHERE seq>=? AND seq<? AND session_id=? AND kind!='purged'",params![first,last,id])?;
                tx.execute("UPDATE events SET kind='purged',data=? WHERE seq=? AND session_id=? AND kind!='purged'",
                    params![marker,last,id])?;
                removed_bytes += bytes;
                removed_rows += count-1;
                retained_rows_freed += count;
                markers += 1;
            }
            // A successful purge must never leave the latest native checkpoint
            // claiming that deleted terminal frames are a complete archive.
            let saved: Option<String>=tx.query_row("SELECT (SELECT data FROM events WHERE session_id=? AND kind='state' ORDER BY seq DESC LIMIT 1)",[id],|r|r.get(0))?;
            if let Some(saved)=saved {
                let mut state:Value=serde_json::from_str(&saved)?;
                if state["detail"]["terminalStream"].is_object() {
                    let stream=&mut state["detail"]["terminalStream"];
                    stream["revision"]=json!(stream["revision"].as_u64().unwrap_or(0)+1);
                    stream["durableFrame"]=json!(0);
                    stream["history"]["state"]=json!("incomplete");
                    stream["history"]["reason"]=json!("explicit_purge");
                    stream["history"]["fromFrame"]=json!(1);
                    stream["history"]["durableFrame"]=json!(0);
                    state["detail"]["history"]=state["detail"]["terminalStream"]["history"].clone();
                    let data=state.to_string();validate_event(id,"state",&data)?;
                    tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;
                }
            }
        }
        Self::check_metadata_update(&tx,before_metadata)?;
        if retained_rows_freed > 0 {
            tx.execute("UPDATE storage_meta SET output_rejected=0 WHERE singleton=1 AND output_encoded_bytes<max_output_encoded_bytes AND event_rows<max_event_rows-lifecycle_reserve_rows", [])?;
        }
        tx.commit()?;
        Ok(json!({"purgedOutputEncodedBytes":removed_bytes,"removedEventRows":removed_rows,
            "freedRetainedEventRows":retained_rows_freed,"removedPhysicalEventRows":removed_rows,
            "compactedLifecycleHistory":full_history,"purgedRanges":markers,"replayRequired":markers>0,"replayAfter":0,"retention":self.retention()?}))
    }

    #[cfg(test)]
    pub fn set_test_limits(&self, bytes: i64, rows: i64, reserve: i64) -> Result<()> {
        ensure!(bytes>0 && rows>reserve && reserve>0,"Invalid test limits");
        self.0.execute("UPDATE storage_meta SET max_output_encoded_bytes=?,max_event_rows=?,lifecycle_reserve_rows=?,output_rejected=0 WHERE singleton=1",params![bytes,rows,reserve])?;
        Ok(())
    }

    pub fn sessions(&self) -> Result<Vec<Value>> { Self::sessions_from(&self.0) }

    pub fn sessions_with_live(&self, live: &[Value]) -> Result<Vec<Value>> {
        let mut sessions=self.sessions()?;
        for value in live {
            if let Some(row)=sessions.iter_mut().find(|row|row["id"]==value["id"]) {
                for key in ["status","pid","rows","cols","detail","terminalStream","history"] {
                    if let Some(field)=value.get(key) {row[key]=field.clone();}
                }
            }
        }
        Ok(sessions)
    }

    fn sessions_from(db: &Connection) -> Result<Vec<Value>> {
        let mut stmt=db.prepare("SELECT id,title,kind,status,pid,rows,cols,cwd,workspace,task_id,
            (SELECT data FROM events WHERE session_id=sessions.id AND kind='state' ORDER BY seq DESC LIMIT 1),
            (SELECT generation FROM codex_sessions WHERE session_id=sessions.id),
            (SELECT native_thread_id FROM codex_sessions WHERE session_id=sessions.id),
            (SELECT status FROM codex_sessions WHERE session_id=sessions.id) FROM sessions ORDER BY rowid")?;
        Ok(stmt.query_map([],|r|{
            let generation=r.get::<_,Option<i64>>(11)?;
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,
                "pid":r.get::<_,Option<u32>>(4)?,"rows":r.get::<_,u16>(5)?,"cols":r.get::<_,u16>(6)?,"cwd":r.get::<_,Option<String>>(7)?,"workspace":r.get::<_,Option<String>>(8)?,"taskId":r.get::<_,Option<String>>(9)?,
                "detail":r.get::<_,Option<String>>(10)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()).map(|v|v["detail"].clone()),
                "transport":if generation.is_some(){"app-server"}else{"pty"},
                "codex":generation.map(|generation|json!({"generation":generation,"nativeThreadId":r.get::<_,Option<String>>(12).ok().flatten(),"status":r.get::<_,Option<String>>(13).ok().flatten()}))
            }))
        })?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn session(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.sessions()?.into_iter().find(|s| s["id"] == id))
    }

    pub fn last_seq(&self) -> Result<i64> {
        Ok(self.0.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?)
    }

    pub fn insert(&mut self, session:&Value)->Result<()> {self.insert_inner(session,false,false).map(|_|())}
    pub fn insert_native(&mut self, session:&Value)->Result<()> {self.insert_inner(session,false,true).map(|_|())}
    /// Session, model generation and the first replay event commit together.
    /// Other windows must know the transport before the first provider frame.
    pub fn insert_codex(&mut self,session:&Value)->Result<Value>{self.insert_inner(session,true,false)}
    fn insert_inner(&mut self,session:&Value,structured:bool,native:bool)->Result<Value>{
        let id=session["id"].as_str().context("Session id required")?;
        if native { self.ensure_native_capacity()?; } else { self.ensure_capacity()?; }
        let tx=self.0.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO sessions(id,title,kind,status,pid,rows,cols,cwd,workspace,task_id) VALUES(?,?,?,?,?,?,?,?,?,?)",params![id,session["title"].as_str(),session["kind"].as_str(),session["status"].as_str(),session["pid"].as_i64(),session["rows"].as_i64(),session["cols"].as_i64(),session["cwd"].as_str(),session["workspace"].as_str(),session["taskId"].as_str()])?;
        let mut event=session.clone();
        let attached=if structured {
            let attached=crate::codex_store::attach_session(&tx,&json!({"sessionId":id,"expectedGeneration":0,"nativeThreadId":null}))?;
            event["transport"]=json!("app-server");event["codex"]=json!({"generation":attached["generation"],"nativeThreadId":null,"status":attached["status"]});attached
        }else{Value::Null};
        let data=event.to_string();validate_event(id,"state",&data)?;
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;
        let (_,admission)=Self::metadata_usage(&tx)?;ensure!(admission<=SESSION_METADATA_BYTES,"Serialized session metadata admission exceeds 2 MiB including lifecycle reserve");
        tx.commit()?;Ok(attached)
    }

    pub fn state(&mut self, id: &str, status: &str, extra: Value) -> Result<()> {
        let data=json!({"status":status,"detail":extra}).to_string();
        validate_event(id,"state",&data)?;
        let before=Self::metadata_usage(&self.0)?.1;
        let tx = self.0.transaction()?;
        ensure!(tx.execute("UPDATE sessions SET status=? WHERE id=?", params![status,id])?==1,"Unknown session");
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;
        Self::check_metadata_update(&tx,before)?;
        tx.commit()?;
        Ok(())
    }

    /// Persist the observed native lifecycle and geometry as one exempt state
    /// checkpoint. Applying a PTY resize never depends on this succeeding.
    pub fn native_checkpoint(&mut self, session: &Value) -> Result<()> {
        let id=session["id"].as_str().context("Session id required")?;
        let data=json!({"status":session["status"],"rows":session["rows"],"cols":session["cols"],"detail":session["detail"]}).to_string();
        validate_event(id,"state",&data)?;
        let before=Self::metadata_usage(&self.0)?.1;
        let tx=self.0.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let prior:Option<String>=tx.query_row("SELECT (SELECT data FROM events WHERE session_id=? AND kind='state' ORDER BY seq DESC LIMIT 1)",[id],|r|r.get(0))?;
        if let Some(prior)=prior {
            let previous:Value=serde_json::from_str(&prior)?;
            let old=&previous["detail"]["terminalStream"];
            let new=&session["detail"]["terminalStream"];
            if old.is_object() && new.is_object() && old["generation"]==new["generation"] {
                let old_revision=old["revision"].as_u64().unwrap_or(0);
                let new_revision=new["revision"].as_u64().unwrap_or(0);
                if new_revision<old_revision || (new_revision==old_revision &&
                    (new["history"]["durableFrame"].as_u64().unwrap_or(0)<old["history"]["durableFrame"].as_u64().unwrap_or(0) ||
                        (old["history"]["state"]=="complete" && new["history"]["state"]!="complete"))) {
                    return Ok(());
                }
            }
        }
        ensure!(tx.execute("UPDATE sessions SET status=?,rows=?,cols=? WHERE id=?",params![session["status"].as_str(),session["rows"].as_i64(),session["cols"].as_i64(),id])?==1,"Unknown session");
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;
        Self::check_metadata_update(&tx,before)?;
        tx.commit()?;
        Ok(())
    }

    pub fn restarting(&mut self,id:&str)->Result<()> {
        let data=json!({"status":"starting","pid":null,"detail":{"reason":"explicit reconnect; no message resend"}}).to_string();validate_event(id,"state",&data)?;
        let before=Self::metadata_usage(&self.0)?.1;let tx=self.0.transaction()?;
        ensure!(tx.execute("UPDATE sessions SET status='starting',pid=NULL WHERE id=?",[id])?==1,"Unknown session");
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;Self::check_metadata_update(&tx,before)?;tx.commit()?;Ok(())
    }

    pub fn activate(&mut self, id: &str, pid: u32) -> Result<()> {
        let detail=self.session(id)?.context("Unknown session")?["detail"].clone();
        let data=json!({"status":"running","pid":pid,"detail":detail}).to_string();
        validate_event(id,"state",&data)?;
        let before=Self::metadata_usage(&self.0)?.1;
        let tx = self.0.transaction()?;
        ensure!(tx.execute("UPDATE sessions SET status='running',pid=? WHERE id=?",params![pid,id])?==1,"Unknown session");
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'state',?)",params![id,data])?;
        Self::check_metadata_update(&tx,before)?;
        tx.commit()?;
        Ok(())
    }

    pub fn resize(&mut self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let data=json!({"rows":rows,"cols":cols}).to_string();
        validate_event(id,"resize",&data)?;
        let before=Self::metadata_usage(&self.0)?.1;
        let tx = self.0.transaction()?;
        ensure!(tx.execute("UPDATE sessions SET rows=?,cols=? WHERE id=?", params![rows,cols,id])?==1,"Unknown session");
        tx.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'resize',?)",params![id,data])?;
        Self::check_metadata_update(&tx,before)?;
        tx.commit()?;
        Ok(())
    }

    pub fn output(&self, id: &str, data: &str) -> Result<()> {
        validate_event(id,"output",data)?;
        if let Err(error) = self.0.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'output',?)", params![id,data]) {
            let error=anyhow::Error::from(error);
            if Self::history_error_reason(&error)=="quota" {
                let _ = self.0.execute("UPDATE storage_meta SET output_rejected=1 WHERE singleton=1", []);
            }
            return Err(error);
        }
        Ok(())
    }

    /// Structured text shares the same output-byte/row quotas as PTY output.
    pub fn provider_event(&mut self,id:&str,value:&Value)->Result<()> {
        let data=serde_json::to_string(value)?;validate_event(id,"provider",&data)?;
        if let Err(error)=self.0.execute("INSERT INTO events(session_id,kind,data) VALUES(?,'provider',?)",params![id,data]) {
            let error=anyhow::Error::from(error);
            if Self::history_error_reason(&error)=="quota" {let _=self.0.execute("UPDATE storage_meta SET output_rejected=1 WHERE singleton=1",[]);}
            return Err(error);
        }
        Ok(())
    }

    pub fn events(&self, after: i64, limit: usize) -> Result<Value> {
        if after < 0 || limit == 0 { bail!("invalid events cursor/limit"); }
        let limit = limit.min(PAGE_ROWS);
        let mut stmt = self.0.prepare("SELECT seq,session_id,kind,data FROM events WHERE seq>? ORDER BY seq LIMIT ?")?;
        let mut rows = stmt.query(params![after,(limit + 1) as i64])?;
        let mut events = Vec::new();
        let mut event_bytes = 0;
        let mut cursor = after;
        let mut has_more = false;
        while let Some(r) = rows.next()? {
            let event = json!({"seq":r.get::<_,i64>(0)?,"sessionId":r.get::<_,String>(1)?,
                "kind":r.get::<_,String>(2)?,"data":r.get::<_,String>(3)?});
            let size = serde_json::to_vec(&event)?.len();
            let seq=event["seq"].as_i64().unwrap();
            let envelope=serde_json::to_vec(&json!({"events":[],"lastSeq":seq,"hasMore":false}))?.len();
            let candidate_bytes=envelope+event_bytes+size+events.len(); // commas between events
            if candidate_bytes > PAGE_BYTES && events.is_empty() {
                bail!("History event {seq} exceeds serialized page byte limit; legacy oversized event requires explicit repair/purge");
            }
            if events.len() == limit || candidate_bytes > PAGE_BYTES {
                has_more = true;
                break;
            }
            event_bytes += size;
            cursor = event["seq"].as_i64().unwrap();
            events.push(event);
        }
        Ok(json!({"events":events,"lastSeq":cursor,"hasMore":has_more}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_profiles_migrate_without_rewriting_history() -> Result<()> {
        let tmp=tempfile::tempdir()?;let path=tmp.path().join("legacy.sqlite");
        let db=Connection::open(&path)?;
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL);
            CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
            INSERT INTO sessions VALUES('old','old','fixture','exited',123,24,80);
            INSERT INTO events(session_id,kind,data) VALUES('old','output','aGVsbG8=');")?;
        drop(db);
        let store=Store::open(&path)?;
        assert_eq!(store.sessions()?[0]["cwd"],Value::Null);
        assert_eq!(store.sessions()?[0]["workspace"],Value::Null);
        assert_eq!(store.events(0,10)?["events"][0]["data"],"aGVsbG8=");
        drop(store);assert_eq!(Store::open(&path)?.last_seq()?,1);
        Ok(())
    }

    #[test]
    fn durable_cursor_and_byte_bounded_pages() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("db");
        let db = Store::open(&path)?;
        for _ in 0..40 { db.output("a", &"A".repeat(16384))?; }
        let page = db.events(0, 1000)?;
        assert!(serde_json::to_vec(&page)?.len() <= PAGE_BYTES);
        assert_eq!(page["hasMore"], true);
        let cursor = page["lastSeq"].as_i64().unwrap();
        drop(db);
        let db = Store::open(&path)?;
        assert_eq!(db.last_seq()?, 40);
        assert_eq!(db.events(cursor, 1)?["events"][0]["seq"], cursor + 1);
        db.output("a", "next")?;
        assert_eq!(db.last_seq()?, 41);
        assert!(db.events(-1, 1).is_err());
        assert!(db.events(0, 0).is_err());
        Ok(())
    }
}

//! Storage-only fixtures; real project/workflow initializers are retained.
#![allow(dead_code)]
#[path = "../src/storage.rs"] mod storage;
#[path = "../src/verification.rs"] mod verification;
#[path = "../src/codex_store.rs"] mod codex_store;
#[path = "../src/projects.rs"] mod projects;
#[path = "../src/workflow.rs"] mod workflow;
#[path = "../src/git_worktree.rs"] mod git_worktree;

// Snapshot capture is outside these storage fixtures. Fail if accidentally called;
// keep the real projects/workflow schema and recovery initializers above.
mod snapshots {
    pub fn capture(_: &std::path::Path, _: &str) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("Snapshot capture is outside storage fixtures")
    }
}

use anyhow::Result;
use rusqlite::Connection;
use serde_json::json;
use storage::Store;

fn session(db: &mut Store, id: &str, state: &str) -> Result<()> {
    db.insert(&json!({"id":id,"title":id,"kind":"fixture","status":state,"rows":24,"cols":80}))
}

#[test]
fn storage_quotas_reserve_and_atomic_counters() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    db.set_test_limits(8,8,3)?;
    session(&mut db,"a","running")?;
    db.output("a","éé")?; // encoded TEXT bytes, not characters or decoded output
    db.output("a","abcd")?;
    assert!(db.output("a","x").is_err());
    assert!(db.ensure_capacity().is_err());
    assert!(session(&mut db,"new","starting").is_err());
    assert_eq!(db.retention()?["outputEncodedBytes"],8);
    assert_eq!(db.retention()?["eventRows"],3);
    db.state("a","failed",json!({"outputLost":true}))?;
    assert_eq!(db.sessions()?[0]["detail"]["outputLost"],true);
    db.purge_history(&["a".into()])?;
    assert_eq!(db.retention()?["outputEncodedBytes"],0);
    db.ensure_capacity()?;
    db.set_test_limits(1000,8,3)?;
    db.output("a","1")?;
    db.output("a","2")?;
    assert_eq!(db.retention()?["eventRows"],4);
    db.output("a","3")?;
    assert!(db.output("a","4").is_err());
    assert!(db.ensure_capacity().is_err());
    for _ in 0..3 { db.state("a","failed",json!({"outputLost":true}))?; }
    db.state("a","failed",json!({}))?;
    assert_eq!(db.retention()?["eventRows"],9);
    assert_eq!(db.retention()?["outputEncodedBytes"],3);
    Ok(())
}

#[test]
fn storage_purge_cursor_ranges_survive_restart() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("db");
    let mut db=Store::open(&path)?;
    session(&mut db,"a","exited")?; // seq 1
    for data in ["one","two","three"] { db.output("a",data)?; } // 2..4
    session(&mut db,"b","exited")?; // 5 breaks run
    db.output("a","four")?; // 6
    db.state("a","exited",json!({"exitCode":0}))?; // 7
    let last=db.last_seq()?;
    let purged=db.purge_history(&["a".into(),"a".into()])?;
    assert_eq!(purged["removedEventRows"],2);
    assert_eq!(purged["purgedRanges"],2);
    assert_eq!(db.last_seq()?,last);
    assert_eq!(db.retention()?["eventRows"],3);
    assert_eq!(db.retention()?["physicalEventRows"],5);
    assert_eq!(purged["freedRetainedEventRows"],4);
    for cursor in 1..4 {
        let page=db.events(cursor,1)?;
        assert_eq!(page["events"][0]["kind"],"purged");
        assert_eq!(page["lastSeq"],4);
        let gap: serde_json::Value=serde_json::from_str(page["events"][0]["data"].as_str().unwrap())?;
        assert_eq!(gap["firstSeq"],2);
        assert_eq!(gap["lastSeq"],4);
    }
    assert_eq!(db.events(4,1)?["events"][0]["sessionId"],"b");
    assert_eq!(db.purge_history(&["a".into()])?["purgedRanges"],0);
    drop(db);
    let db=Store::open(&path)?;
    assert_eq!(db.events(3,1)?["lastSeq"],4);
    assert_eq!(db.last_seq()?,7);
    db.output("b","next")?;
    assert_eq!(db.last_seq()?,8);
    Ok(())
}

#[test]
fn storage_live_uncertain_and_unknown_purge_rejected_atomically() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"final","failed")?;
    db.output("final","keep")?;
    for status in ["running","starting","needs_attention","unknown","uncertain"] {
        session(&mut db,status,status)?;
        assert!(db.purge_history(&["final".into(),status.into()]).is_err());
        assert_eq!(db.retention()?["outputEncodedBytes"],4);
    }
    assert!(db.purge_history(&["final".into(),"missing".into()]).is_err());
    assert_eq!(db.retention()?["outputEncodedBytes"],4);
    Ok(())
}

#[test]
fn storage_failure_rolls_back_event_and_counter() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"a","running")?;
    db.0.execute_batch("CREATE TRIGGER injected_failure AFTER INSERT ON events WHEN NEW.kind='output' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;")?;
    assert!(db.output("a","lost").is_err());
    assert_eq!(db.last_seq()?,1);
    assert_eq!(db.retention()?["outputEncodedBytes"],0);
    assert_eq!(db.retention()?["eventRows"],1);
    db.state("a","failed",json!({"outputLost":true}))?;
    db.0.execute_batch("DROP TRIGGER injected_failure")?;
    db.output("a","saved")?;
    db.0.execute_batch("PRAGMA query_only=ON")?;
    assert!(db.output("a","lost").is_err());
    assert!(db.purge_history(&["a".into()]).is_err());
    assert_eq!(db.retention()?["eventRows"],3);
    assert_eq!(db.retention()?["outputEncodedBytes"],5);
    Ok(())
}

#[test]
fn storage_backup_contains_wal_and_gate_preserves_future_schema() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("old.sqlite");
    let writer=Connection::open(&path)?;
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
        INSERT INTO events(session_id,kind,data) VALUES('old','output','from WAL'); PRAGMA user_version=1;")?;
    let db=Store::open(&path)?;
    assert_eq!(db.retention()?["outputEncodedBytes"],8);
    let dirs=std::fs::read_dir(tmp.path())?.filter_map(|e| e.ok()).filter(|e|e.file_name().to_string_lossy().starts_with(".storage-backup-")).collect::<Vec<_>>();
    assert_eq!(dirs.len(),1);
    assert_eq!(dirs[0].metadata()?.permissions().mode() & 0o777,0o700);
    let backup=Connection::open(dirs[0].path().join("before-migration.sqlite"))?;
    assert_eq!(backup.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(backup.query_row("SELECT data FROM events",[],|r|r.get::<_,String>(0))?,"from WAL");
    assert_eq!(backup.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='cwd'",[],|r|r.get::<_,i64>(0))?,0);
    drop(db);
    drop(Store::open(&path)?);
    assert_eq!(std::fs::read_dir(tmp.path())?.filter_map(|e|e.ok()).filter(|e|e.file_name().to_string_lossy().starts_with(".storage-backup-")).count(),1);
    let future=tmp.path().join("future");
    let db=Connection::open(&future)?;
    db.execute_batch("CREATE TABLE sentinel(value); PRAGMA user_version=99;")?;
    let before=std::fs::read(&future)?;
    assert!(Store::open(&future).is_err());
    assert_eq!(std::fs::read(&future)?,before);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'",[],|r|r.get::<_,i64>(0))?,1);
    Ok(())
}

#[test]
fn storage_oversize_event_does_not_stall_cursor_silently() -> Result<()> {
    let db=Store::open(std::path::Path::new(":memory:"))?;
    assert!(db.output("a",&"x".repeat(storage::PAGE_BYTES)).is_err());
    // Legacy oversized rows remain accessible to explicit purge, but paging errors clearly.
    db.0.execute("INSERT INTO events(session_id,kind,data) VALUES('a','output',?)",["x".repeat(storage::PAGE_BYTES)])?;
    assert!(db.events(0,1).is_err());
    Ok(())
}

#[test]
fn storage_rejected_chunk_blocks_start_until_explicit_purge() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("db");
    let mut db=Store::open(&path)?;
    db.set_test_limits(10,20,3)?;
    session(&mut db,"a","running")?;
    db.output("a","123456")?;
    assert!(db.output("a","12345").is_err());
    assert_eq!(db.retention()?["outputEncodedBytes"],6);
    assert!(db.ensure_capacity().is_err());
    drop(db);
    let mut db=Store::open(&path)?;
    assert!(db.ensure_capacity().is_err());
    db.state("a","failed",json!({"outputLost":true}))?;
    db.purge_history(&["a".into()])?;
    db.ensure_capacity()?;
    Ok(())
}

#[test]
fn storage_purge_failure_restores_deleted_rows_and_counters() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"a","exited")?;
    for _ in 0..3 { db.output("a","keep")?; }
    db.0.execute_batch("CREATE TRIGGER injected_purge_failure BEFORE UPDATE ON events WHEN NEW.kind='purged' BEGIN SELECT RAISE(ABORT,'injected purge failure'); END;")?;
    assert!(db.purge_history(&["a".into()]).is_err());
    assert_eq!(db.retention()?["outputEncodedBytes"],12);
    assert_eq!(db.retention()?["eventRows"],4);
    assert_eq!(db.events(1,10)?["events"].as_array().unwrap().len(),3);
    assert_eq!(db.last_seq()?,4);
    Ok(())
}

#[test]
fn storage_backup_failure_refuses_additive_sql() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("old");
    let db=Connection::open(&path)?;
    db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL); PRAGMA user_version=1;")?;
    drop(db);
    let before=std::fs::read(&path)?;
    std::fs::set_permissions(tmp.path(),std::fs::Permissions::from_mode(0o500))?;
    let result=Store::open(&path);
    std::fs::set_permissions(tmp.path(),std::fs::Permissions::from_mode(0o700))?;
    assert!(result.is_err());
    assert_eq!(std::fs::read(&path)?,before);
    let db=Connection::open(&path)?;
    assert_eq!(db.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'",[],|r|r.get::<_,i64>(0))?,3);
    Ok(())
}

#[test]
fn storage_h1_interleaved_singletons_free_logical_quota() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    db.set_test_limits(1<<30,16,4)?;
    session(&mut db,"a","running")?;
    session(&mut db,"b","running")?;
    for n in 0..10 { db.output(if n%2==0 {"a"} else {"b"},"x")?; }
    assert!(db.output("a","rejected").is_err());
    db.state("a","stopped",json!({}))?;
    db.state("b","stopped",json!({}))?;
    let result=db.purge_history(&["a".into(),"b".into()])?;
    assert_eq!(result["removedEventRows"],0); // physical rows unchanged
    assert_eq!(result["freedRetainedEventRows"],10);
    assert_eq!(db.retention()?["eventRows"],4);
    assert_eq!(db.retention()?["physicalEventRows"],14);
    assert_eq!(db.retention()?["purgedMarkerRows"],10);
    db.ensure_capacity()?;
    session(&mut db,"new","starting")?;
    let events=db.events(0,256)?;
    assert_eq!(events["events"].as_array().unwrap().len(),15);
    assert_eq!(events["events"][1]["sessionId"],"b");
    for seq in 3..=12 {
        let page=db.events(seq-1,1)?;
        let gap: serde_json::Value=serde_json::from_str(page["events"][0]["data"].as_str().unwrap())?;
        assert_eq!(gap["firstSeq"],seq);
        assert_eq!(gap["lastSeq"],seq);
    }
    Ok(())
}

#[test]
fn storage_h2_lifecycle_survives_exhausted_reserve() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    db.set_test_limits(1<<30,10,2)?;
    session(&mut db,"a","running")?;
    for _ in 0..7 { db.output("a","x")?; }
    db.state("a","needs_attention",json!({}))?;
    db.state("a","running",json!({}))?;
    assert_eq!(db.retention()?["eventRows"],10);
    db.state("a","stopped",json!({"outputLost":true}))?;
    assert_eq!(db.session("a")?.unwrap()["status"],"stopped");
    assert_eq!(db.retention()?["eventRows"],11);
    assert!(db.ensure_capacity().is_err());
    db.purge_history(&["a".into()])?;
    db.ensure_capacity()?;
    Ok(())
}

#[test]
fn storage_h4_serialized_event_guards_prevent_cursor_poison() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    let huge=json!({"id":"bad","title":"x".repeat(300_000),"kind":"fixture","status":"starting","rows":24,"cols":80});
    assert!(db.insert(&huge).is_err());
    assert!(db.sessions()?.is_empty());
    assert_eq!(db.last_seq()?,0);
    session(&mut db,"a","running")?;
    let last=db.last_seq()?;
    // Escaping doubles quotes twice (detail JSON, then event data JSON string).
    assert!(db.state("a","failed",json!({"why":"\"".repeat(70_000)})).is_err());
    assert!(db.state("a","failed",json!({"why":"x".repeat(300_000)})).is_err());
    assert!(db.resize(&"\"".repeat(140_000),80,80).is_err());
    assert!(db.activate(&"x".repeat(storage::PAGE_BYTES),42).is_err());
    assert_eq!(db.last_seq()?,last);
    assert_eq!(db.session("a")?.unwrap()["status"],"running");
    db.state("a","stopped",json!({"outputLost":true}))?;
    db.output("a","later")?;
    let page=db.events(0,256)?;
    assert_eq!(page["hasMore"],false);
    assert_eq!(page["lastSeq"],3);
    assert!(serde_json::to_vec(&page)?.len()<=storage::PAGE_BYTES);
    Ok(())
}

#[test]
fn storage_session_metadata_admission_reserves_lifecycle_space() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    let mut accepted=0;
    loop {
        let result=db.insert(&json!({"id":format!("final-{accepted}"),"title":"x".repeat(180_000),"kind":"fixture","status":"exited","rows":24,"cols":80}));
        if result.is_err() { break; }
        accepted+=1;
        assert!(accepted<20);
    }
    assert!(accepted>=5);
    assert_eq!(db.sessions()?.len(),accepted);
    assert_eq!(db.last_seq()?,accepted as i64);
    assert!(serde_json::to_vec(&db.sessions()?)?.len()<=storage::SESSION_METADATA_BYTES);
    // New active sessions reserve a full page each before their INSERT commits.
    assert!(session(&mut db,"live","starting").is_err());
    // Reserve remains available for the final state's actual JSON detail.
    db.state("final-0","failed",json!({"reason":"x".repeat(30_000)}))?;
    assert_eq!(db.session("final-0")?.unwrap()["status"],"failed");
    let cursor=db.last_seq()?;
    assert!(db.state("final-0","failed",json!({"reason":"x".repeat(180_000)})).is_err());
    assert_eq!(db.last_seq()?,cursor);
    assert!(serde_json::to_vec(&db.sessions()?)?.len()<=storage::SESSION_METADATA_BYTES);
    Ok(())
}

#[test]
fn storage_legacy_overquota_opens_and_recovers_before_explicit_purge() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("legacy");
    let db=Connection::open(&path)?;
    db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
        INSERT INTO sessions VALUES('a','a','fixture','running',123,24,80);
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200001)
        INSERT INTO events(session_id,kind,data) SELECT 'a','output','x' FROM n;")?;
    drop(db);
    let mut db=Store::open(&path)?;
    assert!(db.ensure_capacity().is_err());
    assert_eq!(db.events(0,1)?["events"][0]["data"],"x");
    db.state("a","interrupted",json!({"reason":"previous generation; unverified identity"}))?;
    assert_eq!(db.session("a")?.unwrap()["status"],"interrupted");
    assert_eq!(db.retention()?["eventRows"],200002);
    db.purge_history(&["a".into()])?;
    db.ensure_capacity()?;
    assert_eq!(db.retention()?["eventRows"],1);
    assert_eq!(db.retention()?["physicalEventRows"],2);
    Ok(())
}

#[test]
fn storage_m2_ambiguous_v1_layout_rejected_before_backup_or_mutation() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("hypothetical");
    let db=Connection::open(&path)?;
    db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE storage_meta(singleton INTEGER PRIMARY KEY,event_rows INTEGER);
        PRAGMA user_version=1;")?;
    drop(db);
    let before=std::fs::read(&path)?;
    let result=Store::open(&path);
    let error=match result {Ok(_)=>panic!("unsupported layout accepted"),Err(e)=>e.to_string()};
    assert!(error.contains("Unsupported storage layout"));
    assert_eq!(std::fs::read(&path)?,before);
    assert_eq!(std::fs::read_dir(tmp.path())?.count(),1);
    Ok(())
}

#[test]
fn storage_v2_known_layout_migrates_and_recounts_markers() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("v2");
    let db=Connection::open(&path)?;
    db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,rows INTEGER NOT NULL,cols INTEGER NOT NULL,cwd TEXT,workspace TEXT,task_id TEXT);
        CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);")?;
    projects::init(&db)?;
    workflow::init(&db)?;
    db.execute_batch(include_str!("storage_v2.sql"))?;
    db.execute_batch("INSERT INTO sessions VALUES('a','a','fixture','exited',NULL,24,80,NULL,NULL,NULL);
        INSERT INTO events(session_id,kind,data) VALUES('a','state','{}'),('a','output','discarded'),('a','output','keep');
        UPDATE events SET kind='purged',data='{\"firstSeq\":2,\"lastSeq\":2,\"reason\":\"explicit_history_purge\"}' WHERE seq=2;
        PRAGMA user_version=2;")?;
    drop(db);
    let mut db=Store::open(&path)?;
    assert_eq!(db.retention()?["schemaVersion"],5);
    assert_eq!(db.retention()?["eventRows"],2);
    assert_eq!(db.retention()?["physicalEventRows"],3);
    assert_eq!(db.retention()?["outputEncodedBytes"],4);
    db.set_test_limits(100,2,1)?;
    assert!(db.ensure_capacity().is_err());
    db.state("a","stopped",json!({"recovery":true}))?;
    assert_eq!(db.retention()?["eventRows"],3);
    drop(db);
    assert_eq!(Store::open(&path)?.retention()?["physicalEventRows"],4);
    Ok(())
}

#[test]
fn storage_current_trigger_definition_mismatch_rejected_without_mutation() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("tampered");
    let db=Store::open(&path)?;
    db.0.execute_batch("DROP TRIGGER storage_insert_guard; CREATE TRIGGER storage_insert_guard BEFORE INSERT ON events BEGIN SELECT 1; END;")?;
    drop(db);
    let before=std::fs::read(&path)?;
    let result=Store::open(&path);
    let error=match result {Ok(_)=>panic!("stale guard accepted"),Err(e)=>e.to_string()};
    assert!(error.contains("incompatible definition of storage_insert_guard"));
    assert_eq!(std::fs::read(&path)?,before);
    assert!(!std::fs::read_dir(tmp.path())?.any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".storage-backup-")));
    Ok(())
}

#[test]
fn storage_full_compaction_is_separate_and_keeps_latest_state_and_foreign_events() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"a","running")?; // 1
    session(&mut db,"b","running")?; // 2 must never be hidden by a's marker
    for _ in 0..3 { db.resize("a",25,80)?; } // 3..5
    db.state("a","needs_attention",json!({"old":true}))?; // 6
    db.output("a","old output")?; // 7
    db.state("a","stopped",json!({"outputLost":true}))?; // 8 survives
    db.set_test_limits(1000,8,2)?;
    db.purge_history(&["a".into()])?; // only output: cannot remove resize/state history
    assert!(db.ensure_capacity().is_err());
    assert!(db.compact_final_history(&["a".into(),"b".into()]).is_err());
    let result=db.compact_final_history(&["a".into()])?;
    assert_eq!(result["freedRetainedEventRows"],5); // initial state + resize x3 + old state
    assert_eq!(result["compactedLifecycleHistory"],true);
    db.ensure_capacity()?;
    let session=db.session("a")?.unwrap();
    assert_eq!(session["status"],"stopped");
    assert_eq!(session["detail"]["outputLost"],true);
    let first=db.events(0,1)?;
    assert_eq!(first["events"][0]["seq"],1);
    let second=db.events(1,1)?;
    assert_eq!(second["events"][0]["sessionId"],"b");
    assert_eq!(second["events"][0]["kind"],"state");
    let gap=db.events(2,1)?;
    assert_eq!(gap["events"][0]["seq"],6);
    let data: serde_json::Value=serde_json::from_str(gap["events"][0]["data"].as_str().unwrap())?;
    assert_eq!(data["firstSeq"],3);
    assert_eq!(data["lastSeq"],6);
    assert_eq!(data["reason"],"explicit_final_history_compaction");
    assert_eq!(db.events(6,1)?["events"][0]["seq"],7); // old output marker retained
    assert_eq!(db.events(7,1)?["events"][0]["kind"],"state");
    assert_eq!(db.last_seq()?,8);
    Ok(())
}

#[test]
fn storage_schema_guard_literals_are_case_sensitive() -> Result<()> {
    let tmp=tempfile::tempdir()?;
    let path=tmp.path().join("literal");
    let db=Store::open(&path)?;
    let guard=db.0.query_row("SELECT sql FROM sqlite_master WHERE name='storage_insert_guard'",[],|r|r.get::<_,String>(0))?;
    db.0.execute_batch("DROP TRIGGER storage_insert_guard")?;
    let changed=guard.replace("'output'","'OUTPUT'");assert_ne!(changed,guard,"fixture must mutate the guarded literal");
    db.0.execute_batch(&changed)?;
    drop(db);
    let result=Store::open(&path);
    let error=match result {Ok(_)=>panic!("case-changed guard literal accepted"),Err(e)=>e.to_string()};
    assert!(error.contains("incompatible definition of storage_insert_guard"));
    Ok(())
}

#[test]
fn storage_metadata_reservation_allows_both_live_sessions_to_finish() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"live-a","running")?;
    session(&mut db,"live-b","running")?;
    let mut n=0;
    loop {
        if db.insert(&json!({"id":format!("old-{n}"),"title":"x".repeat(180_000),"kind":"fixture","status":"exited","rows":24,"cols":80})).is_err() { break; }
        n+=1;
        assert!(n<20);
    }
    assert!(n>0);
    for id in ["live-a","live-b"] {
        db.state(id,"stopped",json!({"reason":"x".repeat(250_000),"outputLost":true}))?;
        assert_eq!(db.session(id)?.unwrap()["status"],"stopped");
    }
    assert!(serde_json::to_vec(&db.sessions()?)?.len()<=storage::SESSION_METADATA_BYTES);
    let mut cursor=0;
    loop {
        let page=db.events(cursor,256)?;
        assert!(serde_json::to_vec(&page)?.len()<=storage::PAGE_BYTES);
        let next=page["lastSeq"].as_i64().unwrap();
        assert!(next>cursor);
        cursor=next;
        if page["hasMore"]==false {break;}
    }
    assert_eq!(cursor,db.last_seq()?);
    Ok(())
}

#[test]
fn storage_v3_to_v5_preserves_limits_counters_rejection_and_private_backup() -> Result<()> {
    let tmp=tempfile::tempdir()?;let path=tmp.path().join("v3");
    let mut db=Store::open(&path)?;
    session(&mut db,"old","running")?;db.output("old","old-output")?;
    db.set_test_limits(12345,123,17)?;
    db.0.execute("UPDATE storage_meta SET output_rejected=1",[])?;
    let before=db.retention()?;
    db.0.execute_batch("UPDATE storage_meta SET output_rejected=1; DROP TABLE verification_runs; DROP TRIGGER storage_insert_guard; DROP TRIGGER storage_update_guard; DROP TRIGGER storage_insert_count; DROP TRIGGER storage_update_count; DROP TRIGGER storage_delete_count; DROP TABLE provider_requests; DROP TABLE model_attempts; DROP TABLE model_turns; DROP TABLE provider_commands; DROP TABLE codex_sessions; PRAGMA user_version=3;")?;
    db.0.execute_batch(include_str!("storage_v3_triggers.sql"))?;
    drop(db);
    let db=Store::open(&path)?;let after=db.retention()?;
    assert_eq!(after["schemaVersion"],5);
    let mut expected=before;expected["schemaVersion"]=json!(5);assert_eq!(after,expected);
    verification::validate_schema(&db.0)?;
    let backups=std::fs::read_dir(tmp.path())?.filter_map(|e|e.ok()).filter(|e|e.file_name().to_string_lossy().starts_with(".storage-backup-")).collect::<Vec<_>>();
    assert_eq!(backups.len(),1);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(backups[0].metadata()?.permissions().mode() & 0o777,0o700);
    let files=std::fs::read_dir(backups[0].path())?.collect::<std::io::Result<Vec<_>>>()?;
    assert_eq!(files.len(),1);
    let old=Connection::open_with_flags(files[0].path(),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_eq!(old.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?,3);
    assert_eq!(old.query_row("SELECT data FROM events WHERE kind='output'",[],|r|r.get::<_,String>(0))?,"old-output");
    assert_eq!(old.query_row("SELECT output_rejected FROM storage_meta",[],|r|r.get::<_,bool>(0))?,true);
    Ok(())
}

#[test]
fn structured_provider_history_shares_byte_budget_and_preserves_lifecycle() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    session(&mut db,"structured","running")?;
    let payload=json!({"method":"notice","params":{"text":"á"}});
    let length=serde_json::to_vec(&payload)?.len() as i64;
    db.set_test_limits(length,100,5)?;
    db.provider_event("structured",&payload)?;
    assert_eq!(db.retention()?["outputEncodedBytes"],length);
    assert!(db.provider_event("structured",&payload).is_err());
    assert!(db.ensure_capacity().is_err());
    db.state("structured","stopped",json!({"reason":"owned wait confirmed"}))?;
    assert_eq!(db.session("structured")?.unwrap()["status"],"stopped");
    db.purge_history(&["structured".into()])?;
    assert_eq!(db.retention()?["outputEncodedBytes"],0);db.ensure_capacity()?;
    assert!(db.events(0,100)?["events"].as_array().unwrap().iter().any(|event|event["kind"]=="purged"));
    Ok(())
}

#[test]
fn structured_admission_first_event_identifies_transport_and_rolls_back_as_one() -> Result<()> {
    let mut db=Store::open(std::path::Path::new(":memory:"))?;
    let row=json!({"id":"model","kind":"codex","title":"Model","status":"starting","pid":null,"rows":24,"cols":80});
    let attached=db.insert_codex(&row)?;assert_eq!(attached["generation"],1);
    let events=db.events(0,10)?;
    let first:serde_json::Value=serde_json::from_str(events["events"][0]["data"].as_str().unwrap())?;
    assert_eq!(first["transport"],"app-server");assert_eq!(first["codex"]["generation"],1);
    assert_eq!(db.session("model")?.unwrap()["transport"],"app-server");
    let cursor=db.last_seq()?;let mut wrong=row;wrong["id"]=json!("wrong");wrong["kind"]=json!("claude");
    assert!(db.insert_codex(&wrong).is_err());assert!(db.session("wrong")?.is_none());assert_eq!(db.last_seq()?,cursor);
    assert!(codex_store::get_session(&db.0,"wrong").is_err());Ok(())
}

#[test]
fn storage_final_updates_and_reopens_cannot_spend_another_live_sessions_reserve()->Result<()>{
    let mut db=Store::open(std::path::Path::new(":memory:"))?;session(&mut db,"live","running")?;
    let mut n=0;loop{
        if db.insert(&json!({"id":format!("old-{n}"),"title":"x".repeat(180_000),"kind":"fixture","status":"exited","rows":24,"cols":80})).is_err(){break;}
        n+=1;assert!(n<20);
    }assert!(n>0);let cursor=db.last_seq()?;let before=db.retention()?;
    assert!(db.state("old-0","exited",json!({"reason":"x".repeat(250_000)})).is_err());
    assert!(db.restarting("old-0").is_err());assert!(db.activate("old-0",123).is_err());assert!(db.state("old-0","running",json!({})).is_err());
    assert_eq!(db.last_seq()?,cursor);assert_eq!(db.retention()?,before);
    db.state("live","interrupted",json!({"reason":"x".repeat(250_000),"outputLost":true}))?;
    assert_eq!(db.session("live")?.unwrap()["status"],"interrupted");Ok(())
}
#[test]
fn storage_unknown_lifecycle_ids_do_not_create_exempt_orphan_events()->Result<()>{
    let mut db=Store::open(std::path::Path::new(":memory:"))?;let seq=db.last_seq()?;
    assert!(db.state("missing","stopped",json!({})).is_err());assert!(db.restarting("missing").is_err());assert!(db.activate("missing",123).is_err());assert!(db.resize("missing",24,80).is_err());
    assert_eq!(db.last_seq()?,seq);assert!(db.sessions()?.is_empty());Ok(())
}
#[test]
fn storage_provider_nonquota_failure_does_not_poison_capacity()->Result<()>{
    let mut db=Store::open(std::path::Path::new(":memory:"))?;session(&mut db,"s","running")?;
    db.0.execute_batch("CREATE TRIGGER inject_nonquota BEFORE INSERT ON events WHEN NEW.kind='provider' BEGIN SELECT RAISE(ABORT,'fixture unavailable');END;")?;
    assert!(db.provider_event("s",&json!({"method":"notice","params":{"text":"fixture"}})).is_err());assert_eq!(db.retention()?["outputRejected"],false);db.ensure_capacity()?;
    db.0.execute_batch("DROP TRIGGER inject_nonquota")?;db.provider_event("s",&json!({"method":"notice","params":{"text":"recovered"}}))?;Ok(())
}

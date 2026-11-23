//! Retired Git repositories and tasks (removed in 1.4). Nothing reads or writes
//! these tables any more. Their definitions stay so that a profile keeps the
//! exact storage layout in both directions: a 1.4 runner opens a profile that
//! holds old projects, tasks, reviews, handoffs or verifications without
//! touching them, and a 1.3.x runner still validates a profile created or
//! migrated by 1.4. The SQL text must not change: SQLite stores it verbatim and
//! 1.3.x compares the verification ledger definition byte for byte.
//! No recovery or cleanup runs here: old rows, worktrees and branches are kept.
//! The one remaining reader is the single-writer guard below.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

const TASKS_SQL: &str = "        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,root TEXT NOT NULL,common_dir TEXT NOT NULL UNIQUE,name TEXT NOT NULL,head TEXT NOT NULL,branch TEXT);
        CREATE TABLE IF NOT EXISTS project_states(project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),closed INTEGER NOT NULL CHECK(closed IN (0,1)),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,objective TEXT NOT NULL,criteria TEXT NOT NULL,base_sha TEXT NOT NULL,branch TEXT NOT NULL,worktree_path TEXT NOT NULL UNIQUE,state TEXT NOT NULL,error TEXT);
        CREATE TABLE IF NOT EXISTS task_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,detail TEXT);";
const WORKFLOW_SQL: &str = "CREATE TABLE IF NOT EXISTS task_workflow(task_id TEXT PRIMARY KEY REFERENCES tasks(id), archived INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS task_artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS artifacts_task ON task_artifacts(task_id,kind);";
const VERIFICATION_SQL: &str = r#"CREATE TABLE IF NOT EXISTS verification_runs(
        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        status TEXT NOT NULL, evidence_purged INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS verification_task ON verification_runs(task_id,status);
"#;

/// Idempotent DDL only; safe inside or outside the caller's transaction.
pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch(TASKS_SQL)?;
    db.execute_batch(WORKFLOW_SQL)?;
    db.execute_batch(VERIFICATION_SQL)?;
    validate_verification_schema(db)
}

/// Read-only preflight kept from 1.3.x: a profile whose old verification ledger
/// has another shape is rejected before any migration, as it was before.
pub fn validate_verification_schema(db: &Connection) -> Result<()> {
    fn objects(db: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
        Ok(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='verification_runs' ORDER BY type,name")?
            .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY);")?;
    expected.execute_batch(VERIFICATION_SQL)?;
    ensure!(objects(db)? == objects(&expected)?, "Unsupported or missing verification ledger schema");
    Ok(())
}

/// Single-writer guard for a 1.3.x verification command that may have
/// outlived its runner. 1.3.x fenced the task folder of every unfinished run
/// until a human released it; the run row stores no PID, only the approved
/// argv, folder and creation time. Read-only: a run blocks a new writer in an
/// overlapping folder (same, ancestor or descendant) only while a process of
/// this user that leads its own session, started after the run was created,
/// still runs that exact argv. Otherwise the row is ignored and left as is.
pub fn ensure_no_live_verification(db: &Connection, root: &Path) -> Result<()> {
    ensure!(root.is_absolute() && !root.components().any(|c| matches!(c, std::path::Component::ParentDir)),
        "Workspace path must be absolute and contain no parent traversal");
    let mut query = db.prepare("SELECT t.worktree_path,v.payload FROM verification_runs v LEFT JOIN tasks t ON t.id=v.task_id
        WHERE v.status NOT IN ('prepared','completed','not_executed','cancelled','released','purged')")?;
    let rows = query.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (task_path, payload) in rows {
        let Ok(payload) = serde_json::from_str::<Value>(&payload) else { continue };
        let overlap = |p: &str| root.starts_with(p) || Path::new(p).starts_with(root);
        if !task_path.as_deref().is_some_and(overlap) && !payload["cwd"].as_str().is_some_and(overlap) { continue; }
        let Some(argv) = payload["argv"].as_array().and_then(|a| a.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()).filter(|a| !a.is_empty()) else { continue };
        let created = payload["createdAt"].as_u64().unwrap_or(0);
        let live = crate::process_custody::live_session_leader(&argv, created)
            .context("No se pudo comprobar si sigue activo un proceso de verificación de una versión anterior en esta carpeta")?;
        if let Some(pid) = live {
            bail!("Un proceso de verificación de una versión anterior sigue activo en esta carpeta (pid {pid}). Termínalo y vuelve a intentar.");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Frozen copy of what 1.3.x creates and compares; a change here breaks downgrades.
    #[test]
    fn retained_layout_matches_the_1_3_definitions() -> Result<()> {
        let db = Connection::open_in_memory()?;
        init(&db)?;
        init(&db)?;
        let names: Vec<String> = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        assert_eq!(names, ["artifacts_task","project_states","projects","task_artifacts","task_audit","task_workflow","tasks","verification_runs","verification_task"]);
        let ledger: String = db.query_row("SELECT sql FROM sqlite_master WHERE name='verification_runs'", [], |r| r.get(0))?;
        assert_eq!(ledger, "CREATE TABLE verification_runs(\n        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),\n        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,\n        status TEXT NOT NULL, evidence_purged INTEGER NOT NULL DEFAULT 0,\n        payload TEXT NOT NULL)");
        db.execute_batch("DROP INDEX verification_task; CREATE INDEX verification_task ON verification_runs(status);")?;
        assert!(validate_verification_schema(&db).is_err());
        Ok(())
    }
}

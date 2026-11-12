//! Prototype project/task metadata. Git effects are explicit, durable and never retried on recovery.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::{DirBuilderExt, MetadataExt}, path::{Path, PathBuf}, sync::Mutex};
use crate::{git_worktree::{self, Repo}, storage::Store};

pub fn init(db: &Connection) -> Result<()> {
    // Additive UI metadata follows the existing module init pattern; core storage
    // user_version and the positional projects/tasks layouts remain unchanged.
    db.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,root TEXT NOT NULL,common_dir TEXT NOT NULL UNIQUE,name TEXT NOT NULL,head TEXT NOT NULL,branch TEXT);
        CREATE TABLE IF NOT EXISTS project_states(project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),closed INTEGER NOT NULL CHECK(closed IN (0,1)),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,objective TEXT NOT NULL,criteria TEXT NOT NULL,base_sha TEXT NOT NULL,branch TEXT NOT NULL,worktree_path TEXT NOT NULL UNIQUE,state TEXT NOT NULL,error TEXT);
        CREATE TABLE IF NOT EXISTS task_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,detail TEXT);")?;
    // A crash may have happened on either side of the Git effect. Retain all files/refs.
    db.execute_batch("BEGIN IMMEDIATE;
        INSERT INTO task_audit(task_id,state,detail) SELECT id,'needs_attention','Interrupted preparation; no automatic retry' FROM tasks WHERE state='preparing';
        UPDATE tasks SET state='needs_attention',error='La preparación se interrumpió. Conservamos la carpeta y la rama; revisa el estado antes de continuar.' WHERE state='preparing';
        COMMIT;")?;
    Ok(())
}
const METADATA_BYTES: usize = 2 * 1024 * 1024;
fn budget(db: &Connection, candidate: &Value) -> Result<()> {
    let total = serde_json::to_vec(&projects(db)?)?.len() + serde_json::to_vec(&tasks(db)?)?.len() + serde_json::to_vec(candidate)?.len();
    ensure!(total <= METADATA_BYTES, "Límite de metadatos del prototipo (2 MiB); no se guarda más contenido ni se borra historial automáticamente");
    Ok(())
}
pub fn id(value: &str) -> Result<()> {
    ensure!(!value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'), "ID inválido");
    Ok(())
}
pub fn projects(db: &Connection) -> Result<Vec<Value>> {
    Ok(db.prepare("SELECT p.id,p.name,p.root,p.common_dir,p.head,p.branch,COALESCE(s.closed,0) FROM projects p LEFT JOIN project_states s ON s.project_id=p.id ORDER BY p.rowid")?.query_map([], |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"root":r.get::<_,String>(2)?,"commonDir":r.get::<_,String>(3)?,"head":r.get::<_,String>(4)?,"branch":r.get::<_,Option<String>>(5)?,"closed":r.get::<_,bool>(6)?
    })))?.collect::<rusqlite::Result<_>>()?)
}
pub fn tasks(db: &Connection) -> Result<Vec<Value>> {
    Ok(db.prepare("SELECT id,project_id,title,objective,criteria,base_sha,branch,worktree_path,state,error FROM tasks ORDER BY rowid")?.query_map([], |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"projectId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"objective":r.get::<_,String>(3)?,"acceptanceCriteria":r.get::<_,String>(4)?,"baseSha":r.get::<_,String>(5)?,"branch":r.get::<_,String>(6)?,"worktreePath":r.get::<_,String>(7)?,"state":r.get::<_,String>(8)?,"error":r.get::<_,Option<String>>(9)?
    })))?.collect::<rusqlite::Result<_>>()?)
}
pub fn task(db: &Connection, key: &str) -> Result<Value> {
    id(key)?;
    tasks(db)?.into_iter().find(|t| t["id"] == key).context("Tarea desconocida")
}
fn project(db: &Connection, key: &str) -> Result<Value> {
    projects(db)?.into_iter().find(|p| p["id"] == key).context("Proyecto desconocido")
}
/// Historical task reads remain available; callers gate only new work.
pub fn ensure_task_open(db: &Connection, task_id: &str) -> Result<()> {
    let t = task(db, task_id)?;
    ensure_project_open(db, t["projectId"].as_str().context("Proyecto inválido")?)
}
fn ensure_project_open(db: &Connection, key: &str) -> Result<()> {
    ensure!(project(db,key)?["closed"] != true, "El proyecto está cerrado; reábrelo antes de iniciar trabajo");
    Ok(())
}

/// Caller holds workspace and mutation admission gates. The database lock spans
/// lifecycle checks and the metadata write; no filesystem or Git effects occur.
pub fn set_closed(store: &Mutex<Store>, key: &str, closed: bool) -> Result<Value> {
    id(key)?;
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let p = project(&tx,key)?;
    if p["closed"] == closed { return Ok(p); }
    if closed {
        let owned: Vec<_> = tasks(&tx)?.into_iter().filter(|t|t["projectId"]==key).collect();
        for t in &owned {
            ensure!(t["state"] != "preparing", "La tarea se está preparando; espera antes de cerrar el proyecto");
            let task_id = t["id"].as_str().context("Tarea inválida")?;
            crate::verification::ensure_available(&tx,task_id)?;
            // Prepared approvals are not writers, but must be resolved before
            // hiding the project so no approved intent is stranded invisibly.
            let prepared: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM verification_runs WHERE task_id=? AND status='prepared')",[task_id],|r|r.get(0))?;
            ensure!(!prepared, "La tarea tiene una verificación preparada; resuélvela antes de cerrar el proyecto");
        }
        let mut roots = vec![Path::new(p["root"].as_str().context("Raíz inválida")?)];
        for t in &owned { roots.push(Path::new(t["worktreePath"].as_str().context("Ruta inválida")?)); }
        for session in db_sessions(&tx)? {
            let (session_id, task_id, workspace) = session;
            let task_owned = task_id.as_deref().is_some_and(|id|owned.iter().any(|t|t["id"]==id));
            // Stored roots are canonical admission-time identities. Null Git
            // identity on native non-Git sessions must not claim cwd children.
            let overlap = workspace.as_deref().is_some_and(|path|roots.iter().any(|root|root.starts_with(path) || Path::new(path).starts_with(root)));
            ensure!(!task_owned && !overlap, "El proyecto tiene una sesión activa o incierta ({session_id}); resuélvela antes de cerrarlo");
        }
    }
    tx.execute("INSERT INTO project_states(project_id,closed,revision) VALUES(?,?,1)
        ON CONFLICT(project_id) DO UPDATE SET closed=excluded.closed,revision=project_states.revision+1
        WHERE project_states.closed!=excluded.closed",params![key,closed])?;
    let result = project(&tx,key)?;
    tx.commit()?;
    Ok(result)
}
fn db_sessions(db: &Connection) -> Result<Vec<(String,Option<String>,Option<String>)>> {
    Ok(db.prepare("SELECT id,task_id,workspace FROM sessions WHERE status NOT IN ('exited','stopped','failed','interrupted','released')")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
}
fn checked_repo(p: &Value) -> Result<Repo> {
    let repo = git_worktree::inspect(Path::new(p["root"].as_str().context("Raíz inválida")?))?;
    ensure!(repo.root == p["root"] && repo.common_dir == p["commonDir"], "La identidad del repositorio cambió; no se modifica ninguna carpeta");
    Ok(repo)
}
pub fn register(store: &Mutex<Store>, key: &str, path: &str) -> Result<Value> {
    id(key)?;
    ensure!(path.len() <= 4096 && Path::new(path).is_absolute(), "Selecciona una ruta absoluta válida");
    let repo = git_worktree::inspect(Path::new(path))?;
    let db = store.lock().unwrap();
    let existing = projects(&db.0)?;
    if let Some(p) = existing.iter().find(|p| p["id"] == key) {
        ensure!(p["commonDir"] == repo.common_dir, "El ID del proyecto ya pertenece a otro repositorio");
        return Ok(p.clone());
    }
    if let Some(p) = existing.iter().find(|p| p["commonDir"] == repo.common_dir) { return Ok(p.clone()); }
    ensure!(existing.len() < 64, "Límite del prototipo: 64 proyectos");
    let name = Path::new(&repo.root).file_name().and_then(|n|n.to_str()).unwrap_or(&repo.root);
    budget(&db.0,&json!({"id":key,"root":repo.root,"commonDir":repo.common_dir,"name":name,"head":repo.head,"branch":repo.branch}))?;
    db.0.execute("INSERT INTO projects(id,root,common_dir,name,head,branch) VALUES(?,?,?,?,?,?)", params![key,repo.root,repo.common_dir,name,repo.head,repo.branch])?;
    project(&db.0,key)
}
pub fn create(store: &Mutex<Store>, data: &Path, args: &Value) -> Result<Value> {
    let key = args["id"].as_str().context("Falta id")?; id(key)?;
    let project_id = args["projectId"].as_str().context("Falta proyecto")?; id(project_id)?;
    let title = args["title"].as_str().context("Falta título")?.trim();
    let objective = args["objective"].as_str().context("Falta objetivo")?.trim();
    let criteria = args["acceptanceCriteria"].as_str().context("Faltan criterios")?;
    ensure!(!title.is_empty() && title.chars().count() <= 120, "Título requerido (máximo 120 caracteres)");
    ensure!(!objective.is_empty() && objective.chars().count() <= 8000 && criteria.chars().count() <= 8000, "Objetivo requerido; objetivo y criterios admiten hasta 8000 caracteres");
    let p = {
        let db = store.lock().unwrap();
        let existing = tasks(&db.0)?;
        if let Some(t) = existing.iter().find(|t| t["id"] == key) {
            ensure!(t["projectId"] == project_id && t["title"] == title && t["objective"] == objective && t["acceptanceCriteria"] == criteria, "El ID de la tarea ya tiene otro contenido; no se reemplaza");
            return Ok(t.clone());
        }
        ensure!(existing.len() < 128, "Límite del prototipo: 128 tareas");
        ensure_project_open(&db.0, project_id)?;
        project(&db.0, project_id)?
    };
    let repo = checked_repo(&p)?;
    let path = data.join("worktrees").join(key);
    let path = path.to_str().context("Ruta de trabajo no UTF-8")?;
    let branch = format!("aw/{key}");
    let mut db = store.lock().unwrap();
    ensure_project_open(&db.0, project_id)?;
    budget(&db.0,&json!({"id":key,"projectId":project_id,"title":title,"objective":objective,"acceptanceCriteria":criteria,"baseSha":repo.head,"branch":branch,"worktreePath":path,"state":"draft","error":null}))?;
    let tx = db.0.transaction()?;
    tx.execute("INSERT INTO tasks(id,project_id,title,objective,criteria,base_sha,branch,worktree_path,state) VALUES(?,?,?,?,?,?,?,?,'draft')",params![key,project_id,title,objective,criteria,repo.head,branch,path])?;
    tx.execute("INSERT INTO task_audit(task_id,state,detail) VALUES(?,'draft','Saved without Git or provider effects')",[key])?;
    tx.commit()?;
    task(&db.0,key)
}
fn state(store: &Mutex<Store>, key: &str, status: &str, error: Option<&str>) -> Result<Value> {
    let error = error.map(|s|s.chars().take(512).collect::<String>());
    let mut db = store.lock().unwrap();
    let tx = db.0.transaction()?;
    tx.execute("UPDATE tasks SET state=?,error=? WHERE id=?",params![status,error.as_deref(),key])?;
    tx.execute("INSERT INTO task_audit(task_id,state,detail) VALUES(?,?,?)",params![key,status,error.as_deref()])?;
    tx.commit()?;
    task(&db.0,key)
}
fn plan(store: &Mutex<Store>, key: &str) -> Result<(Value,Value)> {
    let db = store.lock().unwrap();
    ensure_task_open(&db.0,key)?;
    let t = task(&db.0,key)?;
    let p = project(&db.0,t["projectId"].as_str().context("Proyecto inválido")?)?;
    Ok((t,p))
}
fn verify_task(t: &Value, p: &Value) -> Result<()> {
    git_worktree::verify(&checked_repo(p)?,Path::new(t["worktreePath"].as_str().context("Ruta inválida")?),t["branch"].as_str().context("Rama inválida")?,t["baseSha"].as_str().context("Base inválida")?)
}
pub fn prepare(store: &Mutex<Store>, data: &Path, key: &str) -> Result<Value> {
    let (t,p) = plan(store,key)?;
    if t["state"] == "ready" {
        if let Err(e) = verify_task(&t,&p) {
            let detail = format!("{e:#}");
            if !git_worktree::transient(&e) { state(store,key,"needs_attention",Some(&detail))?; }
            bail!("{detail}");
        }
        return Ok(t);
    }
    ensure!(t["state"] == "draft", "La tarea requiere revisión; no se vuelve a ejecutar Git automáticamente");
    let repo = checked_repo(&p)?;
    let parent = data.join("worktrees");
    match fs::DirBuilder::new().mode(0o700).create(&parent) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(e) => return Err(e.into()) }
    let meta = fs::symlink_metadata(&parent)?;
    ensure!(meta.is_dir() && !meta.file_type().is_symlink() && meta.uid() == unsafe {libc::geteuid()} && meta.mode() & 0o077 == 0, "La raíz de worktrees debe ser privada y sin enlaces simbólicos");
    let dest = PathBuf::from(t["worktreePath"].as_str().context("Ruta inválida")?);
    ensure!(dest == data.join("worktrees").join(key), "Ruta de tarea fuera de su carpeta administrada");
    ensure!(!dest.starts_with(&repo.root), "El worktree administrado debe quedar fuera del repositorio original");
    let prepared = match git_worktree::preflight(&repo,&dest,t["branch"].as_str().unwrap(),t["baseSha"].as_str().unwrap()) {
        Ok(plan) => plan,
        Err(e) => {
            let detail = format!("{e:#}");
            state(store,key,"draft",Some(&detail))?;
            bail!("No se inició el checkout: {detail}");
        }
    };
    state(store,key,"preparing",None)?;
    if let Err(e) = git_worktree::apply(prepared) {
        let detail = format!("{e:#}");
        state(store,key,"needs_attention",Some(&detail))?;
        bail!("Preparación sin confirmar: {detail}. Conservamos carpeta y rama; no hay reintento automático.");
    }
    state(store,key,"ready",None)
}
pub fn ready(store: &Mutex<Store>, key: &str) -> Result<Value> {
    let (t,p) = plan(store,key)?;
    ensure!(t["state"] == "ready", "Prepara el worktree antes de iniciar una sesión de tarea");
    if let Err(e) = verify_task(&t,&p) {
        let detail = format!("{e:#}");
        if !git_worktree::transient(&e) { state(store,key,"needs_attention",Some(&detail))?; }
        bail!("El worktree no pudo validarse: {detail}");
    }
    Ok(t)
}

/// Explicit read-only recovery after the user repairs the existing folder/ref.
/// Never recreates, checks out, cleans, or retries a partial worktree operation.
pub fn revalidate(store: &Mutex<Store>, data: &Path, key: &str) -> Result<Value> {
    let (t,p)=plan(store,key)?;
    ensure!(matches!(t["state"].as_str(),Some("ready"|"needs_attention")),"Solo se revalida una carpeta preparada que requiere atención");
    ensure!(Path::new(t["worktreePath"].as_str().context("Ruta inválida")?)==data.join("worktrees").join(key),"Ruta fuera de la carpeta administrada");
    if let Err(error)=verify_task(&t,&p) {
        if t["state"]=="ready" && !git_worktree::transient(&error) {state(store,key,"needs_attention",Some(&format!("{error:#}")))?;}
        bail!("La carpeta sigue sin validar: {error:#}. Se conservan archivos y rama.");
    }
    if t["state"]=="ready" {return Ok(t);}
    let mut db=store.lock().unwrap();
    let tx=db.0.transaction()?;
    tx.execute("UPDATE tasks SET state='ready',error=NULL WHERE id=? AND state='needs_attention'",[key])?;
    tx.execute("INSERT INTO task_audit(task_id,state,detail) VALUES(?,'ready','Explicit read-only revalidation; no checkout or cleanup')",[key])?;
    tx.commit()?;
    task(&db.0,key)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_uncertain_effect_without_retry() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let db = Connection::open(dir.path().join("db"))?; init(&db)?;
        db.execute("INSERT INTO projects VALUES('p','/repo','/repo/.git','repo','base',NULL)",[])?;
        for (key,status) in [("a","draft"),("b","preparing"),("c","ready")] {
            db.execute("INSERT INTO tasks VALUES(?,'p','Task','Objective','','base','branch',?, ?,NULL)",params![key,format!("/work/{key}"),status])?;
        }
        init(&db)?;
        let rows = tasks(&db)?;
        assert_eq!(rows[0]["state"],"draft"); assert_eq!(rows[1]["state"],"needs_attention"); assert_eq!(rows[2]["state"],"ready");
        assert_eq!(db.query_row("SELECT COUNT(*) FROM task_audit WHERE task_id='b'",[],|r|r.get::<_,i64>(0))?,1);
        init(&db)?;
        assert_eq!(db.query_row("SELECT COUNT(*) FROM task_audit WHERE task_id='b'",[],|r|r.get::<_,i64>(0))?,1);
        Ok(())
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn escaped_json_and_repeated_errors_stay_bounded() -> Result<()> {
        let store=Mutex::new(Store::open(Path::new(":memory:"))?);
        let db=store.lock().unwrap();
        assert!(budget(&db.0,&json!({"objective":"\u{0001}".repeat(8000),"criteria":"\u{0001}".repeat(8000)})).is_ok());
        assert!(budget(&db.0,&json!({"objective":"\u{0001}".repeat(400000)})).is_err());
        db.0.execute("INSERT INTO projects VALUES('p','/repo','/repo/.git','repo','base',NULL)",[])?;
        db.0.execute("INSERT INTO tasks VALUES('t','p','T','O','','base','b','/w','draft',NULL)",[])?;
        drop(db);
        for _ in 0..3 { state(&store,"t","needs_attention",Some(&"\u{0001}".repeat(50000)))?; }
        let db=store.lock().unwrap();
        assert!(task(&db.0,"t")?["error"].as_str().unwrap().chars().count()<=512);
        assert!(serde_json::to_vec(&tasks(&db.0)?)?.len()<4096);
        Ok(())
    }
}

#[cfg(test)]
mod close_tests {
    use super::*;

    fn fixture() -> Result<Mutex<Store>> {
        let store = Store::open(Path::new(":memory:"))?;
        seed(&store.0)?;
        Ok(Mutex::new(store))
    }
    fn seed(db: &Connection) -> Result<()> {
        db.execute("INSERT INTO projects VALUES('p','/repo','/repo/.git','repo','base',NULL)",[])?;
        db.execute("INSERT INTO tasks VALUES('t','p','T','O','','base','b','/work/t','ready',NULL)",[])?;
        db.execute("INSERT INTO task_audit(task_id,state,detail) VALUES('t','ready','preserve history')",[])?;
        Ok(())
    }
    fn revision(db: &Connection) -> Result<i64> {
        Ok(db.query_row("SELECT COALESCE(SUM(revision),0) FROM project_states",[],|r|r.get(0))?)
    }
    fn session(db: &Connection, status: &str, task: Option<&str>, path: Option<&str>) -> Result<()> {
        db.execute("INSERT INTO sessions(id,title,kind,status,rows,cols,cwd,workspace,task_id) VALUES('s','S','codex',?,24,80,'/',?,?)",params![status,path,task])?;
        Ok(())
    }
    fn verification(db: &Connection, status: &str) -> Result<()> {
        db.execute("INSERT INTO verification_runs(run_id,task_id,request_id,request_hash,status,payload) VALUES('v','t','r','h',?,'{}')",[status])?;
        Ok(())
    }
    #[test]
    fn close_reopen_are_idempotent_and_preserve_history() -> Result<()> {
        let store = fixture()?;
        assert_eq!(set_closed(&store,"p",false)?["closed"],false);
        assert_eq!(revision(&store.lock().unwrap().0)?,0);
        let before = tasks(&store.lock().unwrap().0)?;
        assert_eq!(set_closed(&store,"p",true)?["closed"],true);
        set_closed(&store,"p",true)?;
        assert_eq!(revision(&store.lock().unwrap().0)?,1);
        {
            let db = store.lock().unwrap();
            assert!(ensure_task_open(&db.0,"t").is_err());
            assert_eq!(task(&db.0,"t")?,before[0]);
        }
        // All these paths fail before touching Git, even with absent fixture roots.
        assert!(prepare(&store,Path::new("/absent"),"t").is_err());
        assert!(ready(&store,"t").is_err());
        assert!(revalidate(&store,Path::new("/absent"),"t").is_err());
        assert!(create(&store,Path::new("/absent"),&json!({"id":"new","projectId":"p","title":"T","objective":"O","acceptanceCriteria":""})).is_err());
        // Reopen is metadata-only, even if live activity appears after closure.
        session(&store.lock().unwrap().0,"running",Some("t"),None)?;
        set_closed(&store,"p",false)?;
        set_closed(&store,"p",false)?;
        let db = store.lock().unwrap();
        ensure_task_open(&db.0,"t")?;
        assert_eq!(revision(&db.0)?,2);
        assert_eq!(tasks(&db.0)?,before);
        assert_eq!(db.0.query_row("SELECT COUNT(*) FROM task_audit",[],|r|r.get::<_,i64>(0))?,1);
        Ok(())
    }
    #[test]
    fn closure_persists_through_reopen_and_reinitialization() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("db");
        let store = Store::open(&path)?;
        seed(&store.0)?;
        let store = Mutex::new(store);
        let version: i64 = store.lock().unwrap().0.query_row("PRAGMA user_version",[],|r|r.get(0))?;
        set_closed(&store,"p",true)?;
        drop(store);
        let db = Store::open(&path)?;
        init(&db.0)?;
        init(&db.0)?;
        assert_eq!(projects(&db.0)?[0]["closed"],true);
        assert_eq!(revision(&db.0)?,1);
        assert_eq!(db.0.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?,version);
        let store = Mutex::new(db);
        set_closed(&store,"p",false)?;
        drop(store);
        let db = Store::open(&path)?;
        assert_eq!(projects(&db.0)?[0]["closed"],false);
        assert_eq!(revision(&db.0)?,2);
        Ok(())
    }
    #[test]
    fn active_uncertain_and_unknown_sessions_fence_task_root_and_sibling_worktree() -> Result<()> {
        for status in ["starting","running","needs_attention","future_unknown"] {
            for (task,path) in [(Some("t"),None),(None,Some("/repo")),(None,Some("/repo/child")),(None,Some("/")),(None,Some("/work/t")),(None,Some("/work/t/child")),(None,Some("/work"))] {
                let store = fixture()?;
                session(&store.lock().unwrap().0,status,task,path)?;
                assert!(set_closed(&store,"p",true).is_err(),"{status} {task:?} {path:?}");
                assert_eq!(revision(&store.lock().unwrap().0)?,0);
            }
        }
        Ok(())
    }
    #[test]
    fn final_sessions_and_unrelated_or_null_workspaces_allow_close() -> Result<()> {
        for status in ["exited","stopped","failed","interrupted","released"] {
            let store = fixture()?;
            session(&store.lock().unwrap().0,status,Some("t"),Some("/repo"))?;
            set_closed(&store,"p",true)?;
        }
        for path in [None,Some("/repo-other"),Some("/work/other"),Some("/work/task")] {
            let store = fixture()?;
            session(&store.lock().unwrap().0,"needs_attention",None,path)?;
            set_closed(&store,"p",true)?;
        }
        Ok(())
    }
    #[test]
    fn verification_and_preparing_task_fences_leave_metadata_untouched() -> Result<()> {
        for status in ["prepared","running","needs_attention","future_unknown"] {
            let store = fixture()?;
            verification(&store.lock().unwrap().0,status)?;
            assert!(set_closed(&store,"p",true).is_err(),"{status}");
            assert_eq!(revision(&store.lock().unwrap().0)?,0);
        }
        let store = fixture()?;
        store.lock().unwrap().0.execute("UPDATE tasks SET state='preparing'",[])?;
        assert!(set_closed(&store,"p",true).is_err());
        assert_eq!(revision(&store.lock().unwrap().0)?,0);
        for status in ["completed","not_executed","cancelled","released","purged"] {
            let store = fixture()?;
            verification(&store.lock().unwrap().0,status)?;
            set_closed(&store,"p",true)?;
        }
        Ok(())
    }
    #[test]
    fn bad_keys_and_state_constraints_never_write() -> Result<()> {
        let store = fixture()?;
        for key in ["","../p","p/p","missing",&"x".repeat(65)] {
            assert!(set_closed(&store,key,true).is_err());
            assert!(set_closed(&store,key,false).is_err());
        }
        let db = store.lock().unwrap();
        for sql in [
            "INSERT INTO project_states VALUES('p',2,1)",
            "INSERT INTO project_states VALUES('p',0,0)",
            "INSERT INTO project_states VALUES('p',0,1.5)",
            "INSERT INTO project_states VALUES('p',0,'bad')",
            "INSERT INTO project_states VALUES('missing',0,1)",
        ] { assert!(db.0.execute(sql,[]).is_err(),"{sql}"); }
        assert_eq!(revision(&db.0)?,0);
        assert_eq!(projects(&db.0)?[0]["closed"],false);
        Ok(())
    }
    #[test]
    fn revision_failure_rolls_back_transition_and_later_tasks_are_checked() -> Result<()> {
        let store = fixture()?;
        {
            let db = store.lock().unwrap();
            db.0.execute("INSERT INTO tasks VALUES('second','p','T','O','','base','b2','/work/second','ready',NULL)",[])?;
            db.0.execute("INSERT INTO verification_runs(run_id,task_id,request_id,request_hash,status,payload) VALUES('v','second','r','h','prepared','{}')",[])?;
        }
        assert!(set_closed(&store,"p",true).is_err());
        {
            let db = store.lock().unwrap();
            assert_eq!(revision(&db.0)?,0);
            db.0.execute("DELETE FROM verification_runs",[])?;
            db.0.execute("INSERT INTO project_states VALUES('p',0,9223372036854775807)",[])?;
        }
        // SQLite promotes overflowing integer arithmetic to REAL; the explicit
        // integer constraint must fail instead of committing closed=true.
        assert!(set_closed(&store,"p",true).is_err());
        let db = store.lock().unwrap();
        assert_eq!(projects(&db.0)?[0]["closed"],false);
        assert_eq!(revision(&db.0)?,i64::MAX);
        Ok(())
    }
    #[test]
    fn close_reopen_and_register_preserve_git_and_files() -> Result<()> {
        use std::process::Command;
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("repo");
        fs::create_dir(&root)?;
        let git = |args: &[&str]| -> Result<Vec<u8>> {
            let output = Command::new("/usr/bin/git").arg("-C").arg(&root).args(args).output()?;
            ensure!(output.status.success(),"git fixture failed: {:?}",args);
            Ok(output.stdout)
        };
        git(&["init","-q"])?;
        fs::write(root.join("tracked"),"initial")?;
        git(&["add","tracked"])?;
        git(&["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","initial"])?;
        fs::write(root.join("tracked"),"dirty tracked content")?;
        fs::write(root.join("untracked"),"keep me")?;
        let before = [git(&["status","--porcelain=v1"] )?,git(&["show-ref"] )?,git(&["worktree","list","--porcelain"] )?];
        let store = Mutex::new(Store::open(&dir.path().join("db"))?);
        register(&store,"p",root.to_str().unwrap())?;
        set_closed(&store,"p",true)?;
        assert_eq!(register(&store,"p",root.to_str().unwrap())?["closed"],true);
        assert_eq!(register(&store,"alias",root.to_str().unwrap())?["closed"],true);
        assert_eq!(revision(&store.lock().unwrap().0)?,1);
        set_closed(&store,"p",false)?;
        assert_eq!(before,[git(&["status","--porcelain=v1"] )?,git(&["show-ref"] )?,git(&["worktree","list","--porcelain"] )?]);
        assert_eq!(fs::read_to_string(root.join("tracked"))?,"dirty tracked content");
        assert_eq!(fs::read_to_string(root.join("untracked"))?,"keep me");
        Ok(())
    }
}

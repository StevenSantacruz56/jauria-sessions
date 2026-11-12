//! Durable, explicit review workflow. Readiness and human acceptance are separate.
//! No operation deletes a worktree or applies a patch, commit, or merge.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{path::Path, sync::Mutex};
use crate::{projects, storage::Store};

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS task_workflow(task_id TEXT PRIMARY KEY REFERENCES tasks(id), archived INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS task_artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS artifacts_task ON task_artifacts(task_id,kind);")?;
    crate::verification::init(db)?;
    Ok(())
}
fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
pub fn archived(db: &Connection, task: &str) -> Result<bool> {
    Ok(db.query_row("SELECT COALESCE((SELECT archived FROM task_workflow WHERE task_id=?),0)",[task],|r|r.get::<_,bool>(0))?)
}
fn quiescent(store: &Mutex<Store>, task: &str, require_open: bool) -> Result<()> {
    let db=store.lock().unwrap();
    crate::verification::ensure_available(&db.0,task)?;
    ensure!(!require_open || !archived(&db.0,task)?,"La tarea está archivada. Reábrela antes de iniciar una sesión.");
    let task=projects::task(&db.0,task)?;
    let root=Path::new(task["worktreePath"].as_str().context("Ruta de tarea inválida")?);
    for session in db.sessions()? {
        if !matches!(session["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")) {
            let overlap=session["workspace"].as_str().is_some_and(|path|root.starts_with(path)||Path::new(path).starts_with(root));
            ensure!(session["taskId"]!=task["id"] && !overlap,"Detén y resuelve las sesiones de esta carpeta antes de revisar o archivar.");
        }
    }
    Ok(())
}
pub fn writable(store: &Mutex<Store>, task: &str) -> Result<()> { quiescent(store,task,true) }
pub fn revalidatable(store: &Mutex<Store>, task: &str) -> Result<()> { quiescent(store,task,false) }
fn lookup(db: &Connection, key: &str, task: &str, kind: &str) -> Result<Option<Value>> {
    let mut statement=db.prepare("SELECT task_id,kind,payload FROM task_artifacts WHERE id=?")?;
    let mut rows=statement.query([key])?;
    if let Some(row)=rows.next()? {
        ensure!(row.get::<_,String>(0)?==task && row.get::<_,String>(1)?==kind,"El identificador ya pertenece a otro resultado.");
        return Ok(Some(serde_json::from_str(&row.get::<_,String>(2)?)?));
    }
    Ok(None)
}
fn persist(store: &Mutex<Store>, key: &str, task: &str, kind: &str, payload: &Value) -> Result<Value> {
    let serialized=serde_json::to_string(payload)?;
    ensure!(serialized.len()<=4*1024*1024,"El resultado supera 4 MiB; no se guarda una revisión parcial.");
    let db=store.lock().unwrap();
    if let Some(existing)=lookup(&db.0,key,task,kind)? { ensure!(&existing==payload,"El identificador del resultado ya tiene otro contenido."); return Ok(existing); }
    let (count,bytes):(i64,i64)=db.0.query_row("SELECT count(*),COALESCE(sum(length(CAST(payload AS BLOB))),0) FROM task_artifacts WHERE kind!='purged'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    ensure!(count<1024 && bytes+serialized.len() as i64<=64*1024*1024,"Límite de revisiones guardadas (1024 / 64 MiB). No se elimina evidencia automáticamente.");
    db.0.execute("INSERT INTO task_artifacts(id,task_id,kind,payload) VALUES(?,?,?,?)",params![key,task,kind,serialized])?;
    Ok(payload.clone())
}
pub fn summary(db: &Connection, task: &str) -> Result<Value> {
    let metadata=projects::task(db,task)?;
    let mut statement=db.prepare("SELECT id,kind,payload FROM task_artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT 32")?;
    let artifacts=statement.query_map([task],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?.into_iter().map(|(id,kind,payload)| {
            // Summary never returns the potentially large diff.
            let mut value=serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null);
            if let Some(object)=value.as_object_mut(){
                object.remove("files");object.remove("diff");object.remove("request");object.remove("reservation");object.remove("context");
                if let Some(snapshot)=object.get_mut("snapshot").and_then(Value::as_object_mut) { snapshot.remove("files");snapshot.remove("diff");snapshot.remove("head_files");snapshot.remove("head_diff");snapshot.remove("local_files");snapshot.remove("local_diff");snapshot.remove("staged_files");snapshot.remove("staged_diff");snapshot.remove("unstaged_files");snapshot.remove("unstaged_diff"); }
            }
            if kind=="review" {
                if let Some(run_id)=value["verificationId"].as_str(){
                    let available=crate::verification::get(db,task,run_id).is_ok_and(|run|run["evidencePurged"]!=true && run["verification"]=="verified");
                    value["verificationEvidenceAvailable"]=json!(available);
                }
            }
            json!({"id":id,"kind":kind,"data":value})
        }).collect::<Vec<_>>();
    Ok(json!({"archived":archived(db,task)?,"artifacts":artifacts,"task":{"id":metadata["id"],"title":metadata["title"],"worktreePath":metadata["worktreePath"]}}))
}
pub fn capture(store: &Mutex<Store>, task: &str) -> Result<Value> {
    writable(store,task)?;
    let task=projects::ready(store,task)?;
    crate::snapshots::capture(Path::new(task["worktreePath"].as_str().context("Ruta inválida")?),task["baseSha"].as_str().context("Base inválida")?)
}
pub fn request(store: &Mutex<Store>, op: &str, args: &Value) -> Result<Value> {
    let task=args["id"].as_str().context("Falta tarea")?; projects::id(task)?;
    if op=="workflow" {return summary(&store.lock().unwrap().0,task);}
    if op=="workflow_artifact" {
        let key=args["artifactId"].as_str().context("Falta resultado")?;projects::id(key)?;
        let db=store.lock().unwrap();
        let mut query=db.0.prepare("SELECT kind,payload FROM task_artifacts WHERE id=? AND task_id=?")?;
        let mut rows=query.query(params![key,task])?;
        let row=rows.next()?.context("Resultado desconocido")?;
        return Ok(json!({"id":key,"kind":row.get::<_,String>(0)?,"data":serde_json::from_str::<Value>(&row.get::<_,String>(1)?)?}));
    }
    if op=="purge_workflow" {
        ensure!(args["confirmed"]==true,"Confirma la eliminación de la evidencia guardada.");
        let mut db=store.lock().unwrap();projects::task(&db.0,task)?;
        let payload=json!({"purged":true,"createdAt":now(),"reason":"explicit_evidence_purge","warning":"Respaldo de revisión eliminado; no es borrado seguro del disco o backups."}).to_string();
        let tx=db.0.transaction()?;
        let count=tx.execute("UPDATE task_artifacts SET kind='purged',payload=json_set(?,'$.originalKind',kind,'$.sessionId',CASE WHEN kind='handoff_open' THEN json_extract(payload,'$.sessionId') ELSE NULL END) WHERE task_id=? AND kind!='purged'",params![payload,task])?;
        tx.commit()?;
        return Ok(json!({"purgedArtifacts":count,"workflow":summary(&db.0,task)?}));
    }
    if op=="reopen_task" {
        // Validate identity and writer quiescence before changing archive status.
        revalidatable(store,task)?;
        projects::ready(store,task)?;
        store.lock().unwrap().0.execute("UPDATE task_workflow SET archived=0 WHERE task_id=?",[task])?;
        return summary(&store.lock().unwrap().0,task);
    }
    if op=="archive_task" {
        writable(store,task)?;
        ensure!(args["confirmed"]==true,"Confirma el archivo de esta tarea.");
        projects::ready(store,task)?;
        store.lock().unwrap().0.execute("INSERT INTO task_workflow(task_id,archived) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET archived=1",[task])?;
        return summary(&store.lock().unwrap().0,task);
    }
    let key=args["artifactId"].as_str().context("Falta identificador del resultado")?;projects::id(key)?;
    let kind=match op {"snapshot_task"=>"snapshot","review_task"=>"review","handoff_task"=>"handoff",_=>anyhow::bail!("Operación de revisión desconocida")};
    if let Some(existing)=lookup(&store.lock().unwrap().0,key,task,kind)? { ensure!(existing["request"]==*args,"El identificador ya se usó para otra petición; no se reemplaza evidencia."); return Ok(existing); }
    writable(store,task)?;
    let current=capture(store,task)?;
    if op=="snapshot_task" {return persist(store,key,task,kind,&json!({"request":args,"createdAt":now(),"snapshot":current}));}
    let snapshot_key=args["snapshotId"].as_str().context("Selecciona un snapshot")?;
    let previous=lookup(&store.lock().unwrap().0,snapshot_key,task,"snapshot")?.context("Snapshot desconocido")?;
    ensure!(previous["snapshot"]["fingerprint"].is_string() && previous["snapshot"]["fingerprint"]==current["fingerprint"],"Los archivos cambiaron desde el snapshot. Captura y revisa de nuevo.");
    let notes=args["notes"].as_str().context("Faltan notas")?;
    ensure!(notes.chars().count()<=8000,"Notas demasiado largas (máximo 8000 caracteres).");
    if op=="review_task" {
        ensure!(args["confirmed"]==true,"La aceptación requiere confirmación humana.");
        let verdict=args["verdict"].as_str().context("Falta decisión")?;
        ensure!(["accepted","rejected"].contains(&verdict),"Decisión inválida");
        let mut payload=json!({"request":args,"createdAt":now(),"snapshotId":snapshot_key,"fingerprint":current["fingerprint"],"verdict":verdict,"notes":notes,"actor":"human","verification":"not_recorded"});
        if let Some(run_id)=args.get("verificationId").filter(|v|!v.is_null()).map(|v|v.as_str().context("Verificación inválida")).transpose()? {
            projects::id(run_id)?;
            let run=crate::verification::get(&store.lock().unwrap().0,task,run_id)?;
            ensure!(run["status"]=="completed" && run["outcome"]=="passed" && run["verification"]=="verified" && run["evidencePurged"]!=true,"El resultado no está verificado o su evidencia fue eliminada.");
            ensure!(run["beforeFingerprint"]==current["fingerprint"] && run["afterFingerprint"]==current["fingerprint"],"La verificación corresponde a otros archivos. Captura y verifica de nuevo.");
            payload["verification"]=json!("passed");payload["verificationId"]=json!(run_id);payload["verificationDefinitionHash"]=run["definitionHash"].clone();
        }
        return persist(store,key,task,kind,&payload);
    }
    let destination=args["destination"].as_str().context("Falta proveedor de destino")?;
    ensure!(["codex","claude"].contains(&destination),"Destino inválido");
    let task_data=projects::task(&store.lock().unwrap().0,task)?;
    persist(store,key,task,kind,&json!({"schemaVersion":1,"request":args,"createdAt":now(),"taskId":task,"snapshotId":snapshot_key,"fingerprint":current["fingerprint"],"baseSha":task_data["baseSha"],"worktreePath":task_data["worktreePath"],"objective":task_data["objective"],"acceptanceCriteria":task_data["acceptanceCriteria"],"destination":destination,"notes":notes,"delivery":"manual; no instructions sent"}))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn archive_and_artifacts_survive_reopen_without_deleting_files() -> Result<()> {
        let dir=tempfile::tempdir()?;let path=dir.path().join("db");
        let store=Mutex::new(Store::open(&path)?);
        {let db=store.lock().unwrap();db.0.execute("INSERT INTO projects VALUES('p','/r','/r/.git','r','base',NULL)",[])?;db.0.execute("INSERT INTO tasks VALUES('t','p','Title','Objective','','base','b','/w','draft',NULL)",[])?;}
        let payload=json!({"notes":"evidence"});
        assert_eq!(persist(&store,"one","t","review",&payload)?,payload);
        assert!(persist(&store,"one","t","review",&json!({"changed":true})).is_err());
        assert!(persist(&store,"one","t","handoff",&payload).is_err());
        store.lock().unwrap().0.execute("INSERT INTO task_workflow VALUES('t',1)",[])?;
        assert!(writable(&store,"t").is_err());drop(store);
        let store=Mutex::new(Store::open(&path)?);assert!(archived(&store.lock().unwrap().0,"t")?);assert_eq!(summary(&store.lock().unwrap().0,"t")?["artifacts"][0]["data"],payload);
        store.lock().unwrap().0.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1023) INSERT INTO task_artifacts SELECT 'seed-'||x,'t','snapshot','{}' FROM n")?;
        assert!(persist(&store,"quota-blocked","t","review",&payload).is_err());
        let purge=request(&store,"purge_workflow",&json!({"id":"t","confirmed":true}))?;
        assert_eq!(purge["purgedArtifacts"],1024);
        assert!(persist(&store,"after-purge","t","review",&payload).is_ok());
        assert!(persist(&store,"one","t","review",&payload).is_err());
        Ok(())
    }
}

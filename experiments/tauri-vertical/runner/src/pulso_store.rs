//! Pulso's independent, transactional document store. Never opens the core database.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, atomic::{AtomicU64, Ordering}},
    time::{SystemTime, UNIX_EPOCH},
};

/// The second field mirrors `meta.revision` for readers that must not touch
/// SQLite (runner `status`). It is set from `meta` on open and republished only
/// after a successful COMMIT, while the caller still holds the service mutex.
pub(super) struct Store(pub Connection, pub Arc<AtomicU64>);
#[derive(Clone)]
pub(super) struct Principal {
    pub id: String,
    pub session: Option<String>,
    pub projects: HashSet<String>,
    pub create: bool,
    pub all_projects: bool,
}
impl Principal {
    pub fn ui() -> Self {
        Self {
            id: "ui".into(),
            session: None,
            projects: HashSet::new(),
            create: true,
            all_projects: true,
        }
    }
    pub fn sees(&self, p: &str) -> bool {
        self.all_projects || self.projects.contains(p)
    }
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(super) fn fields(a: &Value, allowed: &[&str]) -> Result<()> {
    let o = a.as_object().context("args must be an object")?;
    ensure!(
        o.keys().all(|k| allowed.contains(&k.as_str())),
        "unknown field"
    );
    Ok(())
}
pub(super) fn string<'a>(a: &'a Value, k: &str, max: usize, required: bool) -> Result<&'a str> {
    let s = match a.get(k) {
        Some(v) => v.as_str().context("expected string")?,
        None if !required => "",
        None => bail!("missing field {k}"),
    };
    ensure!(
        s.chars().count() <= max && (!required || !s.trim().is_empty()),
        "invalid {k} length"
    );
    Ok(s)
}
pub(super) fn id(a: &Value, k: &str) -> Result<String> {
    let s = string(a, k, 80, true)?;
    ensure!(
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            && s != "."
            && s != "..",
        "invalid identifier"
    );
    Ok(s.into())
}
fn boolean(a: &Value, k: &str) -> Result<()> {
    if let Some(v) = a.get(k) {
        ensure!(v.is_boolean(), "invalid boolean");
    }
    Ok(())
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(1))?;
        let app: i64 = c.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            app == 0x50554c53 || (app == 0 && version == 0),
            "foreign database"
        );
        ensure!(version <= 1, "future Pulso schema");
        let check: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        ensure!(check == "ok", "corrupt Pulso database");
        if version == 0 {
            let count: i64 = c.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            ensure!(count == 0, "unrecognized database");
            c.execute_batch(
                "BEGIN IMMEDIATE;
                 PRAGMA application_id=1347767379;
                 CREATE TABLE docs(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 INSERT INTO meta VALUES('revision','0');
                 CREATE TABLE receipts(principal TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,request));
                 CREATE TABLE events(seq INTEGER PRIMARY KEY,body TEXT NOT NULL);
                 CREATE TABLE principals(session TEXT PRIMARY KEY,id TEXT NOT NULL);
                 CREATE TABLE policies(key TEXT PRIMARY KEY,body TEXT NOT NULL);
                 PRAGMA user_version=1;
                 COMMIT;",
            )?;
        }
        ensure!(
            c.query_row("PRAGMA application_id", [], |r| r.get::<_, i64>(0))? == 0x50554c53,
            "invalid application id"
        );
        c.prepare("SELECT principal,request,body,result FROM receipts LIMIT 0")?;
        c.prepare("SELECT kind,id,body FROM docs LIMIT 0")?;
        c.prepare("SELECT session,id FROM principals LIMIT 0")?;
        c.prepare("SELECT key,body FROM policies LIMIT 0")?;
        c.prepare("SELECT seq,body FROM events LIMIT 0")?;
        for sql in [
            "SELECT count(*) FROM docs WHERE NOT json_valid(body)",
            "SELECT count(*) FROM receipts WHERE NOT json_valid(body) OR NOT json_valid(result)",
            "SELECT count(*) FROM events WHERE NOT json_valid(body)",
            "SELECT count(*) FROM policies WHERE NOT json_valid(body)",
        ] {
            ensure!(
                c.query_row(sql, [], |r| r.get::<_, i64>(0))? == 0,
                "corrupt Pulso documents"
            );
        }
        configure_budget(&c)?;
        let store = Self(c, Arc::new(AtomicU64::new(0)));
        let revision = store.revision()?;
        ensure!(revision < i64::MAX as u64, "invalid Pulso revision");
        store.1.store(revision, Ordering::Release);
        Ok(store)
    }
    pub fn revision(&self) -> Result<u64> {
        Ok(self
            .0
            .query_row("SELECT value FROM meta WHERE key='revision'", [], |r| {
                r.get::<_, String>(0)
            })?
            .parse()?)
    }
    pub fn get(&self, kind: &str, id: &str) -> Result<Value> {
        let s: Option<String> = self
            .0
            .query_row(
                "SELECT body FROM docs WHERE kind=? AND id=?",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()?;
        serde_json::from_str(&s.context("not found or not authorized")?).map_err(Into::into)
    }
    fn exists(&self, kind: &str, id: &str) -> Result<bool> {
        Ok(self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM docs WHERE kind=? AND id=?)",
            params![kind, id],
            |r| r.get(0),
        )?)
    }
    fn insert(&self, kind: &str, v: &Value) -> Result<()> {
        self.0.execute(
            "INSERT INTO docs(kind,id,body) VALUES(?,?,?)",
            params![kind, v["id"].as_str().context("missing id")?, v.to_string()],
        )?;
        Ok(())
    }
    fn related(&self,kind:&str,path:&str,id:&str,limit:usize,cursor:u64)->Result<Vec<Value>> {
        ensure!(matches!(path,"$.itemId"|"$.projectId"),"invalid relationship path");
        let mut q=self.0.prepare(&format!("SELECT body FROM docs WHERE kind=? AND json_extract(body,'{path}')=? ORDER BY rowid DESC LIMIT ? OFFSET ?"))?;
        let rows=q.query_map(params![kind,id,limit as i64,i64::try_from(cursor)?],|r|r.get::<_,String>(0))?;
        rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
    }
    fn put(&self, kind: &str, v: &Value) -> Result<()> {
        self.0.execute(
            "INSERT INTO docs VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
            params![kind, v["id"].as_str().context("missing id")?, v.to_string()],
        )?;
        Ok(())
    }
    pub fn authorized(&self, p: &Principal, kind: &str, id: &str) -> Result<Value> {
        let v = self.get(kind, id)?;
        let project = if kind == "project" {
            v["id"].as_str()
        } else {
            v["projectId"].as_str()
        };
        ensure!(
            p.session.is_none() || project.is_some_and(|x| p.sees(x)),
            "not found or not authorized"
        );
        Ok(v)
    }
    pub fn read(&self, p: &Principal, op: &str, a: &Value) -> Result<Value> {
        match op {
            "revision" => {
                fields(a, &[])?;
                // Ignore activity outside the grant, including link-only changes.
                let revision = if p.session.is_none() {
                    self.revision()?
                } else if p.all_projects {
                    self.0.query_row("SELECT COALESCE(MAX(seq),0) FROM events WHERE json_extract(body,'$.projectId') IS NOT NULL",[],|r|r.get::<_,i64>(0))? as u64
                } else {
                    // Each grant performs one indexed lookup; unrelated history is never scanned.
                    self.0.query_row(
                        "SELECT COALESCE(max((SELECT max(seq) FROM events
                         WHERE json_extract(body,'$.projectId')=grant.value)),0)
                         FROM json_each(?) AS grant",
                        [serde_json::to_string(&p.projects)?],
                        |r| r.get::<_, i64>(0),
                    )? as u64
                };
                Ok(json!({"revision":revision}))
            }
            "project" => {
                fields(a, &["id"])?;
                Ok(json!({"project":self.authorized(p,"project",&id(a,"id")?)?}))
            }
            "item" => {
                fields(a, &["id"])?;
                let i = id(a, "id")?;
                let item = self.authorized(p, "item", &i)?;
                let links=self.related("link","$.itemId",&i,101,0)?;
                let links_more=links.len()>100;let links:Vec<_>=links.into_iter().take(100).collect();
                let checkpoints=self.related("checkpoint","$.itemId",&i,11,0)?;
                let checkpoints_more=checkpoints.len()>10;let checkpoints:Vec<_>=checkpoints.into_iter().take(10).rev().collect();
                Ok(json!({"item":item,"links":links,"checkpoints":checkpoints,"linksHasMore":links_more,"checkpointsHasMore":checkpoints_more,"checkpointCursor":10}))
            }
            "checkpoint_history"=>{
                fields(a,&["itemId","cursor","limit"])?;let item=id(a,"itemId")?;self.authorized(p,"item",&item)?;
                let size=limit(a,10)?;ensure!(size<=10,"checkpoint pages admit at most 10 records");
                let cursor=a.get("cursor").map(|v|v.as_u64().context("invalid cursor")).transpose()?.unwrap_or(0);
                let records=self.related("checkpoint","$.itemId",&item,size+1,cursor)?;
                let more=records.len()>size;let records:Vec<_>=records.into_iter().take(size).collect();
                Ok(json!({"checkpoints":records,"hasMore":more,"nextCursor":if more{Some(cursor+size as u64)}else{None}}))
            }

            "board" => {
                fields(a, &["projectId", "ifRevision"])?;
                ensure!(p.session.is_none(), "unauthorized");
                let project = a.get("projectId").context("missing projectId")?;
                ensure!(project.is_null() || project.is_string(), "invalid projectId");
                if !project.is_null() { id(a, "projectId")?; }
                let expected = a.get("ifRevision").map(|v| v.as_u64().context("invalid ifRevision")).transpose()?;
                let revision = self.revision()?;
                if expected == Some(revision) {
                    return Ok(json!({"revision":revision,"unchanged":true}));
                }
                let mut columns = serde_json::Map::new();
                for status in ["todo", "doing", "waiting", "done"] {
                    let mut page = self.read(p, "items", &json!({"projectId":project,"status":status,"limit":20,"expectedSnapshotRevision":revision}))?;
                    page.as_object_mut().unwrap().remove("revision");
                    // Board cards carry previews, not full detail. Bound escaped JSON
                    // even for legacy C0 notes; stored notes and other reads stay intact.
                    for item in page["items"].as_array_mut().unwrap() {
                        let preview = item["note"].as_str().and_then(|note| {
                            note.char_indices().nth(240).map(|(end, _)| note[..end].to_owned())
                        });
                        if let Some(preview) = preview {
                            item["note"] = json!(preview);
                            item["noteTruncated"] = json!(true);
                        }
                    }
                    columns.insert(status.into(), page);
                }
                Ok(json!({"revision":revision,"columns":columns}))
            }

            "sidebar_summary" => {
                fields(a, &["ifRevision"])?;
                // UI only, exactly like `board`: an agent token is refused even
                // when it calls the operation directly.
                ensure!(p.session.is_none(), "unauthorized");
                let expected = a.get("ifRevision").map(|v| v.as_u64().context("invalid ifRevision")).transpose()?;
                let revision = self.revision()?;
                if expected == Some(revision) {
                    return Ok(json!({"revision":revision,"unchanged":true}));
                }
                self.sidebar_summary(revision)
            }

            "projects" | "items" => {
                fields(
                    a,
                    if op == "projects" {
                        &["cursor", "limit", "archived"]
                    } else {
                        &["projectId", "cursor", "limit", "archived", "status", "expectedSnapshotRevision"]
                    },
                )?;
                boolean(a, "archived")?;
                if a.get("status").is_some() {
                    status_ok(string(a, "status", 20, true)?)?;
                }
                let expected = a.get("expectedSnapshotRevision")
                    .map(|v| v.as_u64().context("invalid expectedSnapshotRevision")).transpose()?;
                // Service holds its state mutex across this check, count and page query.
                let rev = self.read(p, "revision", &json!({}))?["revision"].clone();
                ensure!(expected.is_none_or(|n| rev.as_u64() == Some(n)), "revision conflict");
                let limit = limit(a, 50)?;
                let cursor = match a.get("cursor") {
                    None => 0,
                    Some(v) => v.as_u64().context("invalid cursor")? as usize,
                };
                if let Some(v) = a.get("projectId") {
                    ensure!(v.is_null() || v.is_string(), "invalid projectId");
                    if !v.is_null() {
                        let i = id(a, "projectId")?;
                        self.authorized(p, "project", &i)?;
                    }
                }
                let kind=if op=="projects"{"project"}else{"item"};
                use rusqlite::types::Value as SqlValue;
                let mut predicate = String::from("kind=? AND COALESCE(json_extract(body,'$.archived'),0)=?");
                let mut parameters = vec![SqlValue::Text(kind.into()), SqlValue::Integer(i64::from(a["archived"].as_bool().unwrap_or(false)))];
                if !p.all_projects {
                    predicate.push_str(if op=="projects" {
                        " AND id IN (SELECT value FROM json_each(?))"
                    } else {
                        " AND json_extract(body,'$.projectId') IN (SELECT value FROM json_each(?))"
                    });
                    parameters.push(SqlValue::Text(serde_json::to_string(&p.projects)?));
                } else if p.session.is_some() && op=="items" {
                    // All Pulso projects never includes standalone Pendientes.
                    predicate.push_str(" AND json_extract(body,'$.projectId') IS NOT NULL");
                }
                if op=="items" && a.get("projectId").is_some() {
                    predicate.push_str(" AND json_extract(body,'$.projectId') IS ?");
                    parameters.push(a["projectId"].as_str().map(|id|SqlValue::Text(id.into())).unwrap_or(SqlValue::Null));
                }
                if let Some(status) = a.get("status") {
                    predicate.push_str(" AND json_extract(body,'$.status')=?");
                    parameters.push(SqlValue::Text(status.as_str().unwrap().into()));
                }
                // Count in SQLite using exactly the same scope/filters, without fetching bodies.
                let total: i64 = self.0.query_row(&format!("SELECT count(*) FROM docs WHERE {predicate}"), rusqlite::params_from_iter(parameters.iter()), |r| r.get(0))?;
                let order = if op=="items" { "CAST(json_extract(body,'$.position') AS REAL)," } else { "" };
                let sql=format!("SELECT CASE WHEN kind='project' THEN json_set(body,'$.plan','') ELSE body END FROM docs
                    WHERE {predicate} ORDER BY {order}CAST(json_extract(body,'$.createdAt') AS INTEGER),id LIMIT ? OFFSET ?");
                parameters.push(SqlValue::Integer((limit+1) as i64));parameters.push(SqlValue::Integer(i64::try_from(cursor)?));
                let mut query=self.0.prepare(&sql)?;
                let rows=query.query_map(rusqlite::params_from_iter(parameters),|r|r.get::<_,String>(0))?;
                let mut values:Vec<Value>=rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect::<Result<_>>()?;
                let more=values.len()>limit;values.truncate(limit);
                Ok(
                    json!({if op=="projects"{"projects"}else{"items"}:values,"totalCount":total,"revision":rev,"hasMore":more,"nextCursor":if more{Some(cursor+limit)}else{None}}),
                )
            }

            "links" => {
                fields(a, &["projectId"])?;
                let i = id(a, "projectId")?;
                self.authorized(p, "project", &i)?;
                let mut links=self.related("link","$.projectId",&i,101,0)?;let more=links.len()>100;links.truncate(100);
                Ok(json!({"links":links,"hasMore":more}))
            }
            "activity" => {
                fields(a, &["projectId", "itemId", "limit"])?;
                let limit = limit(a, 50)?;
                if let Some(project) = a.get("projectId") {
                    if project.is_null() {
                        ensure!(p.session.is_none(), "not found or not authorized");
                    } else {
                        self.authorized(p, "project", &id(a, "projectId")?)?;
                    }
                }
                if a.get("itemId").is_some() {
                    self.authorized(p, "item", &id(a, "itemId")?)?;
                }
                use rusqlite::types::Value as SqlValue;
                let mut predicates = Vec::new();
                let mut parameters = Vec::new();
                if !p.all_projects {
                    predicates.push("json_extract(body,'$.projectId') IN (SELECT value FROM json_each(?))");
                    parameters.push(SqlValue::Text(serde_json::to_string(&p.projects)?));
                } else if p.session.is_some() {
                    predicates.push("json_extract(body,'$.projectId') IS NOT NULL");
                }
                for (field, predicate) in [
                    ("projectId", "json_extract(body,'$.projectId') IS ?"),
                    ("itemId", "json_extract(body,'$.itemId') = ?"),
                ] {
                    if let Some(value) = a.get(field) {
                        predicates.push(predicate);
                        parameters.push(value.as_str().map(|s| SqlValue::Text(s.into())).unwrap_or(SqlValue::Null));
                    }
                }
                let filter = if predicates.is_empty() {
                    String::new()
                } else {
                    format!("WHERE {}", predicates.join(" AND "))
                };
                parameters.push(SqlValue::Integer(limit as i64));
                let mut q = self.0.prepare(&format!(
                    "SELECT body FROM events {filter} ORDER BY seq DESC LIMIT ?"
                ))?;
                let rows = q.query_map(rusqlite::params_from_iter(parameters), |r| r.get::<_, String>(0))?;
                let events: Vec<Value> = rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect::<Result<_>>()?;
                Ok(json!({"events":events}))
            }
            _ => bail!("unknown operation"),
        }
    }
    /// Sidebar snapshot in four statements under the caller's service mutex:
    /// the first page of non-archived projects (same order as `projects`),
    /// per-project counts, open Pendientes and session links of those projects.
    fn sidebar_summary(&self, revision: u64) -> Result<Value> {
        let mut q = self.0.prepare(SUMMARY_PROJECTS_SQL)?;
        let rows = q.query_map([(SUMMARY_PROJECTS + 1) as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
        })?;
        let mut projects = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = projects.len() > SUMMARY_PROJECTS;
        projects.truncate(SUMMARY_PROJECTS);
        let ids = serde_json::to_string(&projects.iter().map(|(id, _, _)| id).collect::<Vec<_>>())?;
        let mut counts = std::collections::HashMap::new();
        let mut q = self.0.prepare(SUMMARY_COUNTS_SQL)?;
        for row in q.query_map([&ids], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))? {
            let (id, total, done) = row?;
            counts.insert(id, (total, done));
        }
        let pending_open: i64 = self.0.query_row(SUMMARY_PENDING_SQL, [], |r| r.get(0))?;
        let mut q = self.0.prepare(SUMMARY_LINKS_SQL)?;
        let rows = q.query_map(params![ids, (SUMMARY_LINKS + 1) as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        let (mut links, mut bytes, mut truncated) = (Vec::new(), 0usize, false);
        for row in rows {
            let (session, project, via) = row?;
            let link = json!({"sessionId":session,"projectId":project,"via":if via == 0 { "project" } else { "item" }});
            bytes += link.to_string().len() + 1;
            if links.len() == SUMMARY_LINKS || bytes > SUMMARY_LINK_BYTES {
                truncated = true;
                break;
            }
            links.push(link);
        }
        let projects: Vec<Value> = projects
            .into_iter()
            .map(|(id, title, main)| {
                let (total, done) = counts.get(&id).copied().unwrap_or((0, 0));
                json!({"id":id,"title":title,"mainSessionId":main,"done":done,"total":total})
            })
            .collect();
        Ok(json!({"revision":revision,"projects":projects,"hasMore":has_more,"pendingOpen":pending_open,"links":links,"linksTruncated":truncated}))
    }
    pub fn write(&mut self, p: &mut Principal, op: &str, a: &Value) -> Result<Value> {
        let req = id(a, "requestId")?;
        let body = json!({"op":op,"args":a}).to_string();
        self.0.execute_batch("BEGIN IMMEDIATE")?;
        let mut committed: Option<u64> = None;
        let result = (|| -> Result<Value> {
            let receipt: Option<(String, String)> = self
                .0
                .query_row(
                    "SELECT body,result FROM receipts WHERE principal=? AND request=?",
                    params![p.id, req],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((b, r)) = receipt {
                ensure!(b == body, "requestId reused with different body");
                let result: Value = serde_json::from_str(&r)?;
                // Receipts retain identity across refresh, but never restore a removed grant scope.
                if p.session.is_some() {
                    match op {
                        "project_create" | "project_update" => {
                            self.authorized(p, "project", &id(a, "id")?)?;
                        }
                        "item_create" | "item_update" => {
                            self.authorized(p, "item", &id(a, "id")?)?;
                        }
                        "checkpoint_create" => {
                            self.authorized(p, "item", &id(a, "itemId")?)?;
                        }
                        "link" => {
                            if a.get("projectId").is_some() {
                                self.authorized(p, "project", &id(a, "projectId")?)?;
                            } else {
                                self.authorized(p, "item", &id(a, "itemId")?)?;
                            }
                        }
                        _ => bail!("unknown operation"),
                    }
                }
                return Ok(result);
            }
            let rev = self
                .revision()?
                .checked_add(1)
                .context("revision exhausted")?;
            let t = now();
            let mut event = json!({"op":op,"actor":p.id,"sessionId":p.session,"createdAt":t,"revision":rev});
            let result = match op {
                "project_create" | "item_create" => {
                    let project = op == "project_create";
                    fields(
                        a,
                        if project {
                            &["id", "requestId", "title", "plan", "mainSessionId"]
                        } else {
                            &["id", "requestId", "projectId", "title", "note", "status"]
                        },
                    )?;
                    let i = id(a, "id")?;
                    ensure!(
                        !self.exists(if project { "project" } else { "item" }, &i)?,
                        "id already exists"
                    );
                    let title = string(a, "title", 240, true)?;
                    let v = if project {
                        ensure!(p.create, "project creation not authorized");
                        if p.session.is_some() {
                            ensure!(
                                a.get("mainSessionId").is_none_or(
                                    |v| v.is_null() || v.as_str() == p.session.as_deref()
                                ),
                                "cannot set another main session"
                            );
                        }
                        if a.get("mainSessionId").is_some_and(|v| !v.is_null()) {
                            id(a, "mainSessionId")?;
                        }
                        json!({"id":i,"title":title,"plan":string(a,"plan",32000,false)?,"mainSessionId":a.get("mainSessionId").cloned().unwrap_or_else(||p.session.as_ref().map_or(Value::Null,|s|json!(s))),"revision":rev,"archived":false,"createdAt":t,"updatedAt":t})
                    } else {
                        let proj = a.get("projectId").cloned().unwrap_or(Value::Null);
                        if !proj.is_null() {
                            self.authorized(p, "project", &id(a, "projectId")?)?;
                        } else {
                            ensure!(p.session.is_none(), "standalone items not authorized");
                        }
                        let status = a.get("status").and_then(Value::as_str).unwrap_or("todo");
                        if a.get("status").is_some() {
                            string(a, "status", 20, true)?;
                        }
                        status_ok(status)?;
                        json!({"id":i,"projectId":proj,"title":title,"note":string(a,"note",1000,false)?,"status":status,"position":rev,"updatedBy":p.id,"updatedSessionId":p.session,"revision":rev,"archived":false,"createdAt":t,"updatedAt":t})
                    };
                    let kind = if project { "project" } else { "item" };
                    self.insert(kind, &v)?;
                    event["projectId"] = if project {
                        json!(i)
                    } else {
                        v["projectId"].clone()
                    };
                    if !project {
                        event["itemId"] = json!(i);
                    }
                    json!({kind:v})
                }
                "project_update" | "item_update" => {
                    let project = op == "project_update";
                    fields(
                        a,
                        if project {
                            &[
                                "id",
                                "requestId",
                                "expectedRevision",
                                "title",
                                "plan",
                                "mainSessionId",
                                "archived",
                            ]
                        } else {
                            &[
                                "id",
                                "requestId",
                                "expectedRevision",
                                "title",
                                "note",
                                "status",
                                "position",
                                "archived",
                            ]
                        },
                    )?;
                    if p.session.is_some() {
                        ensure!(
                            a.get("archived").is_none() && a.get("mainSessionId").is_none(),
                            "field not authorized"
                        );
                    }
                    let i = id(a, "id")?;
                    let kind = if project { "project" } else { "item" };
                    let mut v = self.authorized(p, kind, &i)?;
                    expected(a, &v)?;
                    boolean(a, "archived")?;
                    for (k, max, required) in [
                        ("title", 240, true),
                        ("plan", 32000, false),
                        ("note", 1000, false),
                        ("status", 20, true),
                    ] {
                        if a.get(k).is_some() {
                            let s = string(a, k, max, required)?;
                            if k == "status" {
                                status_ok(s)?;
                            }
                            v[k] = json!(s);
                        }
                    }
                    if let Some(pos) = a.get("position") {
                        ensure!(pos.as_f64().is_some_and(f64::is_finite), "invalid position");
                        v["position"] = pos.clone();
                    }
                    if let Some(x) = a.get("archived") {
                        v["archived"] = x.clone();
                    }
                    if let Some(x) = a.get("mainSessionId") {
                        if !x.is_null() {
                            id(a, "mainSessionId")?;
                        }
                        v["mainSessionId"] = x.clone();
                    }
                    v["revision"] = json!(rev);
                    v["updatedAt"] = json!(t);
                    if !project { v["updatedBy"] = json!(p.id); v["updatedSessionId"] = json!(p.session); }
                    self.put(kind, &v)?;
                    event["projectId"] = if project {
                        json!(i)
                    } else {
                        v["projectId"].clone()
                    };
                    if !project {
                        event["itemId"] = json!(i);
                    }
                    json!({kind:v})
                }
                "link" => {
                    fields(a, &["requestId", "projectId", "itemId", "sessionId"])?;
                    ensure!(
                        a.get("projectId").is_some() != a.get("itemId").is_some(),
                        "exactly one link target required"
                    );
                    let session = id(a, "sessionId")?;
                    ensure!(
                        p.session.as_ref().is_none_or(|s| s == &session),
                        "session not authorized"
                    );
                    let mut v =
                        json!({"id":format!("link-{rev}"),"sessionId":session,"createdAt":t});
                    if a.get("itemId").is_some() {
                        let i = id(a, "itemId")?;
                        let item = self.authorized(p, "item", &i)?;
                        v["itemId"] = json!(i);
                        event["itemId"] = json!(i);
                        event["projectId"] = item["projectId"].clone();
                    } else {
                        let i = id(a, "projectId")?;
                        self.authorized(p, "project", &i)?;
                        v["projectId"] = json!(i);
                        event["projectId"] = json!(i);
                    }
                    self.insert("link", &v)?;
                    json!({"link":v})
                }
                "checkpoint_create" => {
                    fields(
                        a,
                        &[
                            "id",
                            "requestId",
                            "itemId",
                            "expectedRevision",
                            "brief",
                            "nextAction",
                            "sessionId",
                        ],
                    )?;
                    ensure!(
                        a.get("brief").is_some() && a.get("nextAction").is_some(),
                        "missing checkpoint field"
                    );
                    let i = id(a, "id")?;
                    ensure!(!self.exists("checkpoint", &i)?, "id already exists");
                    let item_id = id(a, "itemId")?;
                    let mut item = self.authorized(p, "item", &item_id)?;
                    expected(a, &item)?;
                    let mut v = json!({"id":i,"itemId":item_id,"brief":string(a,"brief",4000,false)?,"nextAction":string(a,"nextAction",1000,false)?,"createdAt":t,"revision":rev,"actor":p.id});
                    if a.get("sessionId").is_some() {
                        let s = id(a, "sessionId")?;
                        ensure!(
                            p.session.as_ref().is_none_or(|x| x == &s),
                            "session not authorized"
                        );
                        v["sessionId"] = json!(s);
                    } else if let Some(s) = &p.session {
                        v["sessionId"] = json!(s);
                    }
                    item["revision"] = json!(rev);
                    item["updatedAt"] = json!(t);
                    self.put("item", &item)?;
                    self.insert("checkpoint", &v)?;
                    event["projectId"] = item["projectId"].clone();
                    event["itemId"] = json!(item_id);
                    json!({"checkpoint":v,"item":item})
                }
                _ => bail!("unknown operation"),
            };
            event["result"] = result.clone();
            self.0.execute(
                "INSERT INTO events(seq,body) VALUES(?,?)",
                params![i64::try_from(rev)?, event.to_string()],
            )?;
            self.0.execute(
                "UPDATE meta SET value=? WHERE key='revision'",
                [rev.to_string()],
            )?;
            self.0.execute(
                "INSERT INTO receipts VALUES(?,?,?,?)",
                params![p.id, req, body, result.to_string()],
            )?;
            committed = Some(rev);
            Ok(result)
        })();
        match result {
            Ok(v) => {
                if let Err(e) = self.0.execute_batch("COMMIT") {
                    let _ = self.0.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
                // Publish only a committed revision. A receipt replay returns
                // before allocating one, and a rollback never reaches here.
                if let Some(rev) = committed {
                    self.1.store(rev, Ordering::Release);
                }
                if op == "project_create" && p.session.is_some() {
                    if let Some(i) = v["project"]["id"].as_str() {
                        p.projects.insert(i.into());
                    }
                }
                Ok(v)
            }
            Err(e) => {
                let _ = self.0.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}
// sidebar_summary bounds: at most 50 projects (the UI shows 20) and 2,048
// distinct session/project pairs within 256 KiB, far below RESPONSE_MAX.
const SUMMARY_PROJECTS: usize = 50;
const SUMMARY_LINKS: usize = 2048;
const SUMMARY_LINK_BYTES: usize = 256 * 1024;
// First page of non-archived projects: same predicate and order as `projects`.
const SUMMARY_PROJECTS_SQL: &str = "SELECT id,json_extract(body,'$.title'),json_extract(body,'$.mainSessionId') FROM docs
    WHERE kind='project' AND COALESCE(json_extract(body,'$.archived'),0)=0
    ORDER BY CAST(json_extract(body,'$.createdAt') AS INTEGER),id LIMIT ?";
// Non-archived phases of the listed projects, one aggregate row per project.
const SUMMARY_COUNTS_SQL: &str = "SELECT json_extract(body,'$.projectId'),count(*),COALESCE(sum(json_extract(body,'$.status')='done'),0) FROM docs
    WHERE kind='item' AND json_extract(body,'$.projectId') IN (SELECT value FROM json_each(?))
    AND COALESCE(json_extract(body,'$.archived'),0)=0 GROUP BY 1";
// Open Pendientes: non-archived items without a project that are not done.
const SUMMARY_PENDING_SQL: &str = "SELECT count(*) FROM docs WHERE kind='item' AND json_extract(body,'$.projectId') IS NULL
    AND COALESCE(json_extract(body,'$.archived'),0)=0 AND json_extract(body,'$.status')<>'done'";
// Session -> listed project, through a project link or a link to one of its
// phases (archived phases included: the link itself still exists). CROSS JOIN
// pins the phases of the listed projects as the outer loop, so links are
// reached through pulso_docs_item instead of scanning every link (`+i.id`
// drops the column's TEXT affinity so the expression index applies). A session
// linked both ways yields one pair and the project link wins (0=project,1=item).
const SUMMARY_LINKS_SQL: &str = "SELECT sid,pid,min(via) FROM (
      SELECT json_extract(body,'$.sessionId') AS sid,json_extract(body,'$.projectId') AS pid,0 AS via FROM docs
      WHERE kind='link' AND json_extract(body,'$.projectId') IN (SELECT value FROM json_each(?1))
      UNION ALL
      SELECT json_extract(l.body,'$.sessionId'),json_extract(i.body,'$.projectId'),1 FROM docs i
      CROSS JOIN docs l ON l.kind='link' AND json_extract(l.body,'$.itemId')=+i.id
      WHERE i.kind='item' AND json_extract(i.body,'$.projectId') IN (SELECT value FROM json_each(?1))
    ) WHERE sid IS NOT NULL GROUP BY sid,pid ORDER BY pid,sid LIMIT ?2";
fn expected(a: &Value, v: &Value) -> Result<()> {
    ensure!(
        a["expectedRevision"].as_u64().is_some() && a["expectedRevision"] == v["revision"],
        "revision conflict"
    );
    Ok(())
}
fn status_ok(s: &str) -> Result<()> {
    ensure!(
        ["todo", "doing", "waiting", "done"].contains(&s),
        "invalid status"
    );
    Ok(())
}
fn limit(a: &Value, default: usize) -> Result<usize> {
    let n = match a.get("limit") {
        None => default,
        Some(v) => v.as_u64().context("invalid limit")? as usize,
    };
    ensure!((1..=100).contains(&n), "limit must be 1..100");
    Ok(n)
}

// Logical growth is O(1) per mutation. The counter includes immutable receipts
// and activity, so a busy agent cannot fill the disk by repeatedly updating one
// small item. Reading/replaying an existing receipt remains available at budget.
const BUDGET_BYTES:i64=64*1024*1024;
const BUDGET_ROWS:i64=100_000;
const CONTROL_RESERVE_BYTES:i64=1024*1024;
const CONTROL_RESERVE_ROWS:i64=2_000;
fn configure_budget(c:&Connection)->Result<()> {
    let page:i64=c.query_row("PRAGMA page_size",[],|r|r.get(0))?;
    ensure!(page>0,"invalid page size");
    c.execute_batch(&format!("PRAGMA max_page_count={}",128*1024*1024/page))?;
    c.execute_batch("BEGIN IMMEDIATE")?;
    let result=(||->Result<()>{
        c.execute_batch("CREATE TABLE IF NOT EXISTS pulso_budget(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,rows INTEGER NOT NULL)")?;
        let tables:[(&str,&[&str]);5]=[("docs",&["kind","id","body"]),("receipts",&["principal","request","body","result"]),("events",&["body"]),("principals",&["session","id"]),("policies",&["key","body"])];
        {
            // Recount on open to migrate counters from older trigger definitions.
            let(mut bytes,mut rows)=(0i64,0i64);
            for(table,columns)in &tables {
                let size=columns.iter().map(|col|format!("COALESCE(length(CAST({col} AS BLOB)),0)")).collect::<Vec<_>>().join("+");
                let(b,n):(i64,i64)=c.query_row(&format!("SELECT COALESCE(sum({size}),0),count(*) FROM {table}"),[],|r|Ok((r.get(0)?,r.get(1)?)))?;bytes+=b;rows+=n;
            }
            c.execute("INSERT INTO pulso_budget VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,rows=excluded.rows",params![bytes,rows])?;
        }
        for(table,columns)in &tables {
            let size=|prefix:&str|columns.iter().map(|col|format!("COALESCE(length(CAST({prefix}.{col} AS BLOB)),0)")).collect::<Vec<_>>().join("+");
            for(op,delta,count)in [("INSERT",size("NEW"),1),("UPDATE",format!("({})-({})",size("NEW"),size("OLD")),0),("DELETE",format!("-({})",size("OLD")),-1)] {
                let control = matches!(*table, "principals" | "policies");
                let byte_limit = BUDGET_BYTES + if control { CONTROL_RESERVE_BYTES } else { 0 };
                let row_limit = BUDGET_ROWS + if control { CONTROL_RESERVE_ROWS } else { 0 };
                // Deletions and non-growing updates must remain available above either cap.
                let check = if op == "DELETE" {
                    String::new()
                } else {
                    format!("SELECT CASE WHEN ({count}>0 OR ({delta})>0) AND (SELECT bytes>{byte_limit} OR rows>{row_limit} FROM pulso_budget WHERE id=1) THEN RAISE(ABORT,'Pulso local storage budget reached') END;")
                };
                c.execute_batch(&format!("DROP TRIGGER IF EXISTS pulso_budget_{table}_{op}; CREATE TRIGGER pulso_budget_{table}_{op} AFTER {op} ON {table} BEGIN UPDATE pulso_budget SET bytes=bytes+({delta}),rows=rows+({count}) WHERE id=1; {check} END;"))?;
            }
        }
        c.execute_batch("CREATE INDEX IF NOT EXISTS pulso_docs_item ON docs(kind,json_extract(body,'$.itemId')); CREATE INDEX IF NOT EXISTS pulso_docs_project ON docs(kind,json_extract(body,'$.projectId'),json_extract(body,'$.archived'));
            CREATE INDEX IF NOT EXISTS pulso_docs_kanban ON docs(kind,json_extract(body,'$.projectId'),COALESCE(json_extract(body,'$.archived'),0),json_extract(body,'$.status'),CAST(json_extract(body,'$.position') AS REAL),CAST(json_extract(body,'$.createdAt') AS INTEGER),id) WHERE kind='item';
            CREATE INDEX IF NOT EXISTS pulso_events_project ON events(json_extract(body,'$.projectId'),seq);
            CREATE INDEX IF NOT EXISTS pulso_events_item ON events(json_extract(body,'$.itemId'),seq);")?;
        Ok(())
    })();
    match result{Ok(())=>{c.execute_batch("COMMIT")?;Ok(())},Err(e)=>{let _=c.execute_batch("ROLLBACK");Err(e)}}
}


#[cfg(test)]
mod store_tests {
    use super::*;

    #[test]
    fn board_is_bounded_ui_snapshot_with_query_free_unchanged_columns() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        store.write(&mut ui, "project_create", &json!({"id":"p","requestId":"p","title":"Project"})).unwrap();
        for status in ["todo", "doing", "waiting", "done"] {
            for n in 0..21 {
                let id = format!("{status}-{n}");
                store.write(&mut ui, "item_create", &json!({"id":id,"requestId":id,"projectId":"p","status":status,"title":"🦊".repeat(240),"note":"🦊".repeat(1000)})).unwrap();
            }
        }
        let revision = store.revision().unwrap();
        let board = store.read(&ui, "board", &json!({"projectId":"p"})).unwrap();
        assert_eq!(board["revision"], revision);
        assert_eq!(board["columns"].as_object().unwrap().len(), 4);
        for status in ["todo", "doing", "waiting", "done"] {
            let column = &board["columns"][status];
            assert_eq!(column["totalCount"], 21);
            assert_eq!(column["items"].as_array().unwrap().len(), 20);
            assert!(column["items"].as_array().unwrap().iter().all(|item| item["status"] == status));
            assert!(column["items"].as_array().unwrap().iter().all(|item| item["note"] == "🦊".repeat(240) && item["noteTruncated"] == true));
            assert_eq!(column["hasMore"], true);
            assert_eq!(column["nextCursor"], 20);
            let tail = store.read(&ui, "items", &json!({"projectId":"p","status":status,"limit":50,"cursor":column["nextCursor"],"expectedSnapshotRevision":revision})).unwrap();
            assert_eq!(tail["items"].as_array().unwrap().len(), 1);
            assert_eq!(tail["totalCount"], 21);
        }
        assert!(serde_json::to_vec(&json!({"ok":true,"result":board})).unwrap().len() < 512 * 1024);
        assert_eq!(store.read(&ui, "board", &json!({"projectId":"p","ifRevision":revision})).unwrap(), json!({"revision":revision,"unchanged":true}));
        assert!(store.read(&ui, "board", &json!({"projectId":"p","ifRevision":revision-1})).unwrap()["columns"].is_object());
        assert_eq!(store.read(&ui, "board", &json!({"projectId":null})).unwrap()["columns"]["todo"]["totalCount"], 0);
        let agent = Principal { session:Some("agent".into()), projects:HashSet::from(["p".into()]), all_projects:false, ..Principal::ui() };
        assert_eq!(store.read(&agent, "board", &json!({"projectId":"p","ifRevision":revision})).unwrap_err().to_string(), "unauthorized");
        for args in [json!({}), json!({"projectId":false}), json!({"projectId":"../bad"}), json!({"projectId":null,"status":"todo"})] {
            assert!(store.read(&ui, "board", &args).is_err());
        }
        for value in [json!(null), json!(true), json!("1"), json!(-1), json!(1.0), json!([])] {
            assert!(store.read(&ui, "board", &json!({"projectId":null,"ifRevision":value})).is_err());
        }
        let item = store.get("item", "todo-0").unwrap();
        store.write(&mut ui, "item_update", &json!({"id":"todo-0","requestId":"move","expectedRevision":item["revision"],"status":"doing"})).unwrap();
        let refreshed = store.read(&ui, "board", &json!({"projectId":"p","ifRevision":revision})).unwrap();
        assert_eq!(refreshed["revision"], revision+1);
        assert_eq!(refreshed["columns"]["todo"]["totalCount"], 20);
        assert_eq!(refreshed["columns"]["doing"]["totalCount"], 22);
        assert_eq!(store.get("item", "todo-0").unwrap()["position"], item["position"]);
        // Dropping docs makes any count/page/authorization query fail. The shortcut
        // must read only meta and still succeed.
        store.0.execute_batch("DROP TABLE docs").unwrap();
        assert_eq!(store.read(&ui, "board", &json!({"projectId":"p","ifRevision":revision+1})).unwrap(), json!({"revision":revision+1,"unchanged":true}));
    }

    #[test]
    fn published_revision_follows_commits_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pulso.sqlite");
        let mut ui = Principal::ui();
        {
            let mut store = Store::open(&path).unwrap();
            assert_eq!(store.1.load(Ordering::Acquire), 0);
            store.write(&mut ui, "project_create", &json!({"id":"p","requestId":"p","title":"P"})).unwrap();
            assert_eq!(store.1.load(Ordering::Acquire), store.revision().unwrap());
            assert_eq!(store.1.load(Ordering::Acquire), 1);
            // Receipt replay, validation failure and budget rollback leave it alone.
            store.write(&mut ui, "project_create", &json!({"id":"p","requestId":"p","title":"P"})).unwrap();
            assert!(store.write(&mut ui, "project_create", &json!({"id":"p","requestId":"p2","title":"P"})).is_err());
            store.0.execute("UPDATE pulso_budget SET bytes=? WHERE id=1", [BUDGET_BYTES]).unwrap();
            assert!(store.write(&mut ui, "project_create", &json!({"id":"q","requestId":"q","title":"Q"})).is_err());
            assert_eq!(store.revision().unwrap(), 1);
            assert_eq!(store.1.load(Ordering::Acquire), 1);
            store.0.execute("UPDATE pulso_budget SET bytes=0 WHERE id=1", []).unwrap();
            store.write(&mut ui, "item_create", &json!({"id":"i","requestId":"i","projectId":"p","title":"I"})).unwrap();
        }
        // Reopening initializes the counter from meta.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.1.load(Ordering::Acquire), 2);
    }

    #[test]
    fn board_c0_note_previews_bound_payload_without_changing_full_notes() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        let title = "\u{0001}".repeat(240);
        let note = "\u{0002}".repeat(1000);
        store.write(&mut ui, "project_create", &json!({"id":"p","requestId":"p","title":"Project"})).unwrap();
        for status in ["todo", "doing", "waiting", "done"] {
            for n in 0..20 {
                let id = format!("{status}-{n}");
                store.write(&mut ui, "item_create", &json!({"id":id,"requestId":id,"projectId":"p","status":status,"title":title,"note":note})).unwrap();
            }
        }
        let revision = store.revision().unwrap();
        let board = store.read(&ui, "board", &json!({"projectId":"p"})).unwrap();
        let wire = serde_json::to_vec(&json!({"ok":true,"result":board})).unwrap();
        assert!(wire.len() + 1 <= 512 * 1024, "board envelope and newline: {} bytes", wire.len() + 1);
        assert_eq!(store.revision().unwrap(), revision);
        for status in ["todo", "doing", "waiting", "done"] {
            let column = &board["columns"][status];
            assert_eq!(column["totalCount"], 20);
            assert_eq!(column["items"].as_array().unwrap().len(), 20);
            assert_eq!(column["hasMore"], false);
            assert!(column["nextCursor"].is_null());
            for card in column["items"].as_array().unwrap() {
                assert_eq!(card["title"], title);
                assert_eq!(card["note"], "\u{0002}".repeat(240));
                assert_eq!(card["noteTruncated"], true);
                let detail = store.read(&ui, "item", &json!({"id":card["id"]})).unwrap();
                assert_eq!(detail["item"]["note"], note);
                assert!(detail["item"].get("noteTruncated").is_none());
                assert_eq!(store.get("item", card["id"].as_str().unwrap()).unwrap()["note"], note);
            }
            let page = store.read(&ui, "items", &json!({"projectId":"p","status":status,"limit":50,"expectedSnapshotRevision":revision})).unwrap();
            assert!(page["items"].as_array().unwrap().iter().all(|item| item["note"] == note && item.get("noteTruncated").is_none()));
        }
        let original = store.get("item", "todo-0").unwrap();
        let moved = store.write(&mut ui, "item_update", &json!({"id":"todo-0","requestId":"move","expectedRevision":original["revision"],"status":"doing"})).unwrap();
        assert_eq!(moved["item"]["note"], note);
        assert_eq!(moved["item"]["title"], title);
        assert_eq!(moved["item"]["position"], original["position"]);
        assert_eq!(moved["item"]["status"], "doing");
        assert!(moved["item"].get("noteTruncated").is_none());
    }

    #[test]
    fn board_note_preview_counts_characters_at_exact_boundary() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        for length in [0, 239, 240, 241] {
            let id = format!("note-{length}");
            store.write(&mut ui, "item_create", &json!({"id":id,"requestId":id,"title":id,"note":"🦊".repeat(length)})).unwrap();
        }
        let board = store.read(&ui, "board", &json!({"projectId":null})).unwrap();
        let cards = board["columns"]["todo"]["items"].as_array().unwrap();
        for length in [0, 239, 240, 241] {
            let card = cards.iter().find(|card| card["id"] == format!("note-{length}")).unwrap();
            assert_eq!(card["note"], "🦊".repeat(length.min(240)));
            if length > 240 { assert_eq!(card["noteTruncated"], true); }
            else { assert!(card.get("noteTruncated").is_none()); }
        }
    }

    #[test]
    fn kanban_index_covers_project_status_count_and_order() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        for select in ["count(*)", "body"] {
            let sql = format!("EXPLAIN QUERY PLAN SELECT {select} FROM docs WHERE kind=?
                AND json_extract(body,'$.projectId') IS 'p'
                AND COALESCE(json_extract(body,'$.archived'),0)=0
                AND json_extract(body,'$.status')='todo'
                ORDER BY CAST(json_extract(body,'$.position') AS REAL),CAST(json_extract(body,'$.createdAt') AS INTEGER),id LIMIT 51 OFFSET 20");
            let mut q = store.0.prepare(&sql).unwrap();
            let plan = q.query_map(["item"], |r| r.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join("; ");
            assert!(plan.contains("pulso_docs_kanban"), "{plan}");
            assert!(!plan.contains("SCAN docs"), "{plan}");
            assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        }
    }

    fn plan(store: &Store, sql: &str, params: impl rusqlite::Params) -> String {
        let mut q = store.0.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        q.query_map(params, |r| r.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join("; ")
    }
    fn put_raw(store: &Store, kind: &str, body: Value) {
        store.0.execute("INSERT INTO docs VALUES(?,?,?)", params![kind, body["id"].as_str().unwrap(), body.to_string()]).unwrap();
    }

    #[test]
    fn sidebar_summary_statements_use_existing_indexes() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let ids = r#"["p","q"]"#;
        let plans = [
            plan(&store, SUMMARY_PROJECTS_SQL, [51]),
            plan(&store, SUMMARY_COUNTS_SQL, [ids]),
            plan(&store, SUMMARY_PENDING_SQL, []),
            plan(&store, SUMMARY_LINKS_SQL, params![ids, 2049]),
        ];
        for (n, p) in plans.iter().enumerate() { eprintln!("sidebar_summary[{n}]: {p}"); }
        // Projects: a range on kind (one row per project), exactly like `projects`.
        assert!(plans[0].contains("SEARCH docs USING INDEX") && plans[0].contains("(kind=?)"), "{}", plans[0]);
        for p in &plans[1..] { assert!(!p.contains("SCAN docs") && !p.contains("SCAN i ") && !p.contains("SCAN l "), "{p}"); }
        assert!(plans[1].contains("pulso_docs_"), "{}", plans[1]);
        assert!(plans[2].contains("pulso_docs_kanban"), "{}", plans[2]);
        assert!(plans[3].contains("SEARCH l USING INDEX pulso_docs_item (kind=? AND <expr>=?)"), "{}", plans[3]);
        assert!(plans[3].contains("SEARCH i USING COVERING INDEX pulso_docs_kanban"), "{}", plans[3]);
    }

    fn write(store: &mut Store, ui: &mut Principal, op: &str, a: Value) -> Value { store.write(ui, op, &a).unwrap() }
    fn archive(store: &mut Store, ui: &mut Principal, kind: &str, id: &str) {
        let current = store.get(kind, id).unwrap();
        write(store, ui, &format!("{kind}_update"), json!({"id":id,"requestId":format!("archive-{id}"),"expectedRevision":current["revision"],"archived":true}));
    }

    #[test]
    fn sidebar_summary_counts_pending_links_and_scope() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        for p in ["p1", "p2", "p3"] {
            write(&mut store, &mut ui, "project_create", json!({"id":p,"requestId":p,"title":format!("Title {p}"),"mainSessionId":format!("main-{p}")}));
        }
        for (id, project, status) in [("a","p1","todo"),("b","p1","done"),("c","p1","doing"),("z","p1","done"),("d","p3","waiting"),("e","p2","done")] {
            write(&mut store, &mut ui, "item_create", json!({"id":id,"requestId":id,"projectId":project,"title":id,"status":status}));
        }
        for (id, status) in [("n1","todo"),("n2","doing"),("n3","done"),("n4","todo")] {
            write(&mut store, &mut ui, "item_create", json!({"id":id,"requestId":id,"title":id,"status":status}));
        }
        archive(&mut store, &mut ui, "item", "z");
        archive(&mut store, &mut ui, "item", "n4");
        let link = |store: &mut Store, n: &str, target: Value, session: &str| {
            let mut a = target; a["requestId"] = json!(n); a["sessionId"] = json!(session);
            write(store, &mut ui.clone(), "link", a);
        };
        link(&mut store, "l1", json!({"projectId":"p1"}), "s-project");
        link(&mut store, "l2", json!({"itemId":"a"}), "s-item");
        link(&mut store, "l3", json!({"itemId":"c"}), "s-both");
        link(&mut store, "l4", json!({"projectId":"p1"}), "s-both");
        link(&mut store, "l5", json!({"itemId":"a"}), "s-item"); // duplicate pair
        link(&mut store, "l6", json!({"itemId":"z"}), "s-archived-phase");
        link(&mut store, "l7", json!({"projectId":"p2"}), "s-archived-project");
        link(&mut store, "l8", json!({"itemId":"e"}), "s-archived-project-phase");
        link(&mut store, "l9", json!({"itemId":"n1"}), "s-pending");
        for n in 0..150 { link(&mut store, &format!("m{n}"), json!({"projectId":"p3"}), &format!("s-many-{n:03}")); }
        archive(&mut store, &mut ui, "project", "p2");
        let revision = store.revision().unwrap();
        let summary = store.read(&ui, "sidebar_summary", &json!({})).unwrap();
        assert_eq!(summary["revision"], revision);
        assert!(summary.get("unchanged").is_none());
        assert_eq!(summary["hasMore"], false);
        assert_eq!(summary["pendingOpen"], 2);
        assert_eq!(summary["projects"], json!([
            {"id":"p1","title":"Title p1","mainSessionId":"main-p1","done":1,"total":3},
            {"id":"p3","title":"Title p3","mainSessionId":"main-p3","done":0,"total":1},
        ]));
        // Same order as `projects`.
        let order: Vec<_> = store.read(&ui, "projects", &json!({"archived":false})).unwrap()["projects"].as_array().unwrap().iter().map(|p| p["id"].clone()).collect();
        assert_eq!(order, summary["projects"].as_array().unwrap().iter().map(|p| p["id"].clone()).collect::<Vec<_>>());
        let links = summary["links"].as_array().unwrap();
        assert_eq!(summary["linksTruncated"], false);
        let p1: Vec<_> = links.iter().filter(|l| l["projectId"] == "p1").cloned().collect();
        assert_eq!(p1, vec![
            json!({"sessionId":"s-archived-phase","projectId":"p1","via":"item"}),
            json!({"sessionId":"s-both","projectId":"p1","via":"project"}),
            json!({"sessionId":"s-item","projectId":"p1","via":"item"}),
            json!({"sessionId":"s-project","projectId":"p1","via":"project"}),
        ]);
        // More than 100 links on one project are no longer cut at 100.
        assert_eq!(links.iter().filter(|l| l["projectId"] == "p3").count(), 150);
        assert_eq!(store.read(&ui, "links", &json!({"projectId":"p3"})).unwrap()["hasMore"], true);
        assert_eq!(links.len(), 154);
        assert!(links.iter().all(|l| l["projectId"] != "p2" && l["sessionId"] != "s-pending"));
        // Deterministic order: projectId, then sessionId.
        let keys: Vec<_> = links.iter().map(|l| (l["projectId"].as_str().unwrap().to_owned(), l["sessionId"].as_str().unwrap().to_owned())).collect();
        let mut sorted = keys.clone(); sorted.sort(); assert_eq!(keys, sorted);
        assert_eq!(store.read(&ui, "sidebar_summary", &json!({})).unwrap(), summary);
        // ifRevision: shortcut reads only meta.
        assert_eq!(store.read(&ui, "sidebar_summary", &json!({"ifRevision":revision})).unwrap(), json!({"revision":revision,"unchanged":true}));
        assert!(store.read(&ui, "sidebar_summary", &json!({"ifRevision":revision - 1})).unwrap()["projects"].is_array());
        for value in [json!(null), json!(true), json!("1"), json!(-1), json!(1.0), json!([])] {
            assert!(store.read(&ui, "sidebar_summary", &json!({"ifRevision":value})).is_err());
        }
        for args in [json!({"projectId":"p1"}), json!({"limit":50}), json!({"ifRevision":revision,"extra":1})] {
            assert_eq!(store.read(&ui, "sidebar_summary", &args).unwrap_err().to_string(), "unknown field");
        }
        // Agent principals are refused even with all-projects scope.
        let agent = Principal { id:"a".into(), session:Some("agent".into()), projects:HashSet::new(), create:true, all_projects:true };
        assert_eq!(store.read(&agent, "sidebar_summary", &json!({})).unwrap_err().to_string(), "unauthorized");
        assert_eq!(store.read(&agent, "sidebar_summary", &json!({"ifRevision":revision})).unwrap_err().to_string(), "unauthorized");
        store.0.execute_batch("DROP TABLE docs").unwrap();
        assert_eq!(store.read(&ui, "sidebar_summary", &json!({"ifRevision":revision})).unwrap(), json!({"revision":revision,"unchanged":true}));
    }

    #[test]
    fn sidebar_summary_caps_projects_and_links_deterministically() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        for n in 0..51 { write(&mut store, &mut ui, "project_create", json!({"id":format!("p{n:02}"),"requestId":format!("p{n:02}"),"title":"P"})); }
        // Direct inserts keep the fixture fast; the store only reads these rows.
        for n in 0..2100 { put_raw(&store, "link", json!({"id":format!("link-x{n}"),"projectId":format!("p{:02}", n % 50),"sessionId":format!("s{n:05}")})); }
        put_raw(&store, "link", json!({"id":"link-late","projectId":"p50","sessionId":"s-late"}));
        let summary = store.read(&ui, "sidebar_summary", &json!({})).unwrap();
        assert_eq!(summary["projects"].as_array().unwrap().len(), 50);
        assert_eq!(summary["hasMore"], true);
        assert_eq!(summary["linksTruncated"], true);
        let links = summary["links"].as_array().unwrap();
        assert_eq!(links.len(), 2048);
        // p50 is beyond the page: its links are not reported.
        assert!(links.iter().all(|l| l["projectId"] != "p50"));
        assert_eq!(links[0], json!({"sessionId":"s00000","projectId":"p00","via":"project"}));
        assert_eq!(store.read(&ui, "sidebar_summary", &json!({})).unwrap(), summary);
        let wire = serde_json::to_vec(&json!({"ok":true,"result":summary})).unwrap().len();
        eprintln!("sidebar_summary capped wire bytes: {wire}");
        assert!(wire < 256 * 1024);
        // Worst-case identifiers (80 bytes) hit the byte budget before 2,048 pairs.
        let store = Store::open(Path::new(":memory:")).unwrap();
        for n in 0..50 { put_raw(&store, "project", json!({"id":format!("{n:02}{}", "p".repeat(78)),"title":"\u{0001}".repeat(240),"mainSessionId":"m".repeat(80),"archived":false,"createdAt":n})); }
        for n in 0..2100 { put_raw(&store, "link", json!({"id":format!("link-{n}"),"projectId":format!("{:02}{}", n % 50, "p".repeat(78)),"sessionId":format!("{n:05}{}", "s".repeat(75))})); }
        let summary = store.read(&ui, "sidebar_summary", &json!({})).unwrap();
        let wire = serde_json::to_vec(&json!({"ok":true,"result":summary})).unwrap().len();
        eprintln!("sidebar_summary worst-case wire bytes: {wire}, links {}", summary["links"].as_array().unwrap().len());
        assert_eq!(summary["linksTruncated"], true);
        assert!(summary["links"].as_array().unwrap().len() < 2048);
        assert!(wire < 400 * 1024, "{wire}");
    }

    /// Opt-in measurement: `cargo test --release --locked pulso_summary_scale -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn pulso_summary_scale() {
        for (items, extra) in [(20_000usize, 0usize), (20_000, 77_000)] {
            let store = Store::open(Path::new(":memory:")).unwrap();
            store.0.execute_batch("DELETE FROM pulso_budget; DROP TRIGGER pulso_budget_docs_INSERT;").unwrap();
            let ui = Principal::ui();
            store.0.execute_batch("BEGIN").unwrap();
            for n in 0..50 { put_raw(&store, "project", json!({"id":format!("project-{n:02}"),"title":format!("Proyecto sintético {n}"),"mainSessionId":format!("{n:08}-0000-4000-8000-000000000000"),"archived":false,"createdAt":n})); }
            for n in 0..items {
                let project = if n % 10 == 0 { Value::Null } else { json!(format!("project-{:02}", n % 50)) };
                let status = ["todo","doing","waiting","done"][n % 4];
                put_raw(&store, "item", json!({"id":format!("item-{n}"),"projectId":project,"title":"Fase","note":"","status":status,"position":n,"archived":n % 17 == 0,"createdAt":n}));
            }
            for n in 0..2100 {
                let session = format!("{n:08}-1111-4000-8000-000000000000");
                if n % 2 == 0 { put_raw(&store, "link", json!({"id":format!("link-{n}"),"projectId":format!("project-{:02}", n % 50),"sessionId":session})); }
                else { put_raw(&store, "link", json!({"id":format!("link-{n}"),"itemId":format!("item-{}", n * 7 % items),"sessionId":session})); }
            }
            for n in 0..extra { put_raw(&store, "checkpoint", json!({"id":format!("cp-{n}"),"itemId":format!("item-{}", n % items),"brief":"b","nextAction":"n","createdAt":n})); }
            store.0.execute_batch("COMMIT").unwrap();
            let docs: i64 = store.0.query_row("SELECT count(*) FROM docs", [], |r| r.get(0)).unwrap();
            let started = std::time::Instant::now();
            let runs = 20;
            let mut summary = Value::Null;
            for _ in 0..runs { summary = store.read(&ui, "sidebar_summary", &json!({})).unwrap(); }
            let per = started.elapsed() / runs;
            let wire = serde_json::to_vec(&json!({"ok":true,"result":summary})).unwrap().len();
            eprintln!("docs={docs} items={items} links={} truncated={} pendingOpen={} wire={wire} B time/op={per:?}",
                summary["links"].as_array().unwrap().len(), summary["linksTruncated"], summary["pendingOpen"]);
            assert!(wire < 512 * 1024);
        }
    }

    fn budget(c: &Connection) -> (i64, i64) {
        c.query_row("SELECT bytes,rows FROM pulso_budget WHERE id=1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        }).unwrap()
    }

    #[test]
    fn budget_counts_all_tables_and_preserves_control_reserve() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let c = &store.0;
        for sql in [
            "INSERT INTO docs VALUES('item','i','{}')",
            "INSERT INTO receipts VALUES('p','r','{}','{}')",
            "INSERT INTO events VALUES(1,'{}')",
            "INSERT INTO principals VALUES('s','p')",
            "INSERT INTO policies VALUES('k','{}')",
        ] {
            c.execute_batch(sql).unwrap();
        }
        assert_eq!(budget(c), (20, 5));
        c.execute("UPDATE pulso_budget SET bytes=?,rows=?", params![BUDGET_BYTES, BUDGET_ROWS]).unwrap();
        assert!(c.execute("INSERT INTO events VALUES(2,'{}')", []).is_err());
        c.execute("INSERT INTO principals VALUES('s2','p2')", []).unwrap();
        c.execute("INSERT INTO policies VALUES('k2','{}')", []).unwrap();
        assert_eq!(budget(c), (BUDGET_BYTES + 8, BUDGET_ROWS + 2));
        // Control-plane usage still counts against ordinary writes.
        assert!(c.execute(r#"UPDATE docs SET body='{"x":1}'"#, []).is_err());
        for (bytes, rows) in [
            (BUDGET_BYTES + CONTROL_RESERVE_BYTES, 5),
            (20, BUDGET_ROWS + CONTROL_RESERVE_ROWS),
        ] {
            c.execute("UPDATE pulso_budget SET bytes=?,rows=?", params![bytes, rows]).unwrap();
            assert!(c.execute("INSERT INTO principals VALUES('blocked','p')", []).is_err());
            assert!(c.execute("INSERT INTO policies VALUES('blocked','{}')", []).is_err());
            assert_eq!(budget(c), (bytes, rows));
        }
    }

    #[test]
    fn budget_allows_shrinking_updates_and_deletes_above_both_caps() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let c = &store.0;
        c.execute_batch("INSERT INTO docs VALUES('item','i','{\"long\":true}');
            INSERT INTO receipts VALUES('p','r','{}','{\"long\":true}');
            INSERT INTO events VALUES(1,'{\"long\":true}');
            INSERT INTO principals VALUES('s','principal');
            INSERT INTO policies VALUES('k','{\"long\":true}');").unwrap();
        c.execute("UPDATE pulso_budget SET bytes=?,rows=?", params![BUDGET_BYTES + CONTROL_RESERVE_BYTES + 100, BUDGET_ROWS + CONTROL_RESERVE_ROWS + 10]).unwrap();
        let before = budget(c);
        for sql in [
            "UPDATE docs SET body='{}'",
            "UPDATE receipts SET result='{}'",
            "UPDATE events SET body='{}'",
            "UPDATE principals SET id='p'",
            "UPDATE policies SET body='{}'",
        ] {
            let old = budget(c);
            c.execute_batch(sql).unwrap();
            assert!(budget(c).0 < old.0);
            assert_eq!(budget(c).1, old.1);
        }
        for table in ["docs", "receipts", "events", "principals", "policies"] {
            c.execute_batch(&format!("DELETE FROM {table}")).unwrap();
        }
        assert!(budget(c).0 < before.0);
        assert_eq!(budget(c).1, before.1 - 5);
    }

    #[test]
    fn reopening_migrates_old_triggers_and_recounts_control_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pulso.sqlite");
        {
            let store = Store::open(&path).unwrap();
            store.0.execute_batch("DROP TRIGGER pulso_budget_principals_INSERT;
                DROP TRIGGER pulso_budget_policies_INSERT;
                INSERT INTO principals VALUES('s','p');
                INSERT INTO policies VALUES('k','{}');
                DROP TRIGGER pulso_budget_policies_DELETE;
                CREATE TRIGGER pulso_budget_policies_DELETE AFTER DELETE ON policies
                BEGIN SELECT RAISE(ABORT,'old trigger'); END;").unwrap();
            assert_eq!(budget(&store.0), (0, 0));
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(budget(&store.0), (5, 2));
        store.0.execute("UPDATE pulso_budget SET bytes=?,rows=?", params![BUDGET_BYTES, BUDGET_ROWS]).unwrap();
        store.0.execute("INSERT INTO principals VALUES('s2','p2')", []).unwrap();
        store.0.execute("DELETE FROM policies", []).unwrap();
        assert_eq!(budget(&store.0), (BUDGET_BYTES + 1, BUDGET_ROWS));
    }

    #[test]
    fn event_queries_scope_before_limit_and_use_expression_indexes() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let mut ui = Principal::ui();
        for project in ["p", "q"] {
            store.write(&mut ui, "project_create", &json!({"id":project,"requestId":project,"title":project})).unwrap();
        }
        for (item, project) in [("i", json!("p")), ("j", json!("q")), ("solo", Value::Null)] {
            store.write(&mut ui, "item_create", &json!({"id":item,"requestId":item,"projectId":project,"title":item})).unwrap();
        }
        store.0.execute("DELETE FROM events", []).unwrap();
        for (seq, body) in [
            (1, json!({"projectId":"p","itemId":"i"})),
            (2, json!({"projectId":"p","itemId":"other"})),
            (3, json!({"projectId":null,"itemId":"solo"})),
            (4, json!({"projectId":"q","itemId":"j"})),
            (5, json!({"projectId":"prefix-p","itemId":"i-suffix"})),
        ] {
            store.0.execute("INSERT INTO events VALUES(?,?)", params![seq, body.to_string()]).unwrap();
        }
        let mut agent = Principal { id:"a".into(), session:Some("s".into()), projects:HashSet::from(["p".into()]), create:false, all_projects:false };
        assert_eq!(store.read(&agent, "revision", &json!({})).unwrap()["revision"], 2);
        let activity = store.read(&agent, "activity", &json!({"limit":1})).unwrap();
        assert_eq!(activity["events"], json!([{"projectId":"p","itemId":"other"}]));
        assert_eq!(store.read(&agent, "activity", &json!({"itemId":"i","limit":1})).unwrap()["events"], json!([{"projectId":"p","itemId":"i"}]));
        assert_eq!(store.read(&ui, "activity", &json!({"projectId":"q","itemId":"i"})).unwrap()["events"], json!([]));
        assert_eq!(store.read(&ui, "activity", &json!({"projectId":null})).unwrap()["events"], json!([{"projectId":null,"itemId":"solo"}]));
        assert!(store.read(&agent, "activity", &json!({"projectId":null})).is_err());
        agent.projects.insert("q".into());
        assert_eq!(store.read(&agent, "revision", &json!({})).unwrap()["revision"], 4);
        agent.projects.clear();
        assert_eq!(store.read(&agent, "revision", &json!({})).unwrap()["revision"], 0);
        assert_eq!(store.read(&agent, "activity", &json!({})).unwrap()["events"], json!([]));
        for (sql, index) in [
            ("SELECT COALESCE(max((SELECT max(seq) FROM events WHERE json_extract(body,'$.projectId')=grant.value)),0) FROM json_each('[\"p\"]') AS grant", "pulso_events_project"),
            ("SELECT body FROM events WHERE json_extract(body,'$.projectId') IN (SELECT value FROM json_each('[\"p\"]')) ORDER BY seq DESC LIMIT 1", "pulso_events_project"),
            ("SELECT body FROM events WHERE json_extract(body,'$.itemId')='i' ORDER BY seq DESC LIMIT 1", "pulso_events_item"),
        ] {
            let mut q = store.0.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let plan = q.query_map([], |r| r.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join("; ");
            assert!(plan.contains(index), "{plan}");
            assert!(!plan.contains("SCAN events"), "{plan}");
        }
    }
}

//! Allowlisted structural diagnostics. Free-form values are never exported.
use anyhow::Result;
use serde_json::{Value,json};
use crate::storage::Store;
pub fn preview(store: &Store) -> Result<Value> {
    let sessions=store.sessions()?;
    let kinds=["codex","claude","shell","terminal","fixture"];
    let states=["starting","running","exited","stopped","failed","interrupted","needs_attention","released"];
    let counts=kinds.iter().map(|kind|json!({"kind":kind,"count":sessions.iter().filter(|s|s["kind"]==*kind).count()})).collect::<Vec<_>>();
    let states=states.iter().map(|state|json!({"state":state,"count":sessions.iter().filter(|s|s["status"]==*state).count()})).collect::<Vec<_>>();
    let tasks:i64=store.0.query_row("SELECT count(*) FROM tasks",[],|r|r.get(0))?;
    let projects:i64=store.0.query_row("SELECT count(*) FROM projects",[],|r|r.get(0))?;
    Ok(json!({"product":"Jauria","diagnosticSchemaVersion":1,"storageSchemaVersion":store.0.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0))?,"runnerVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"sessions":{"total":sessions.len(),"byKind":counts,"byState":states},"projects":projects,"tasks":tasks,"excludes":["terminal output","credentials","environment","paths","titles","notes","commands","errors","process identifiers"]}))
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn excludes_secret_canaries_even_in_allowlisted_field_values()->Result<()> {
        let store=Store::open(std::path::Path::new(":memory:"))?;
        store.0.execute("INSERT INTO sessions(id,title,kind,status,rows,cols,cwd) VALUES('secret-id','secret-title','secret-kind','secret-status',24,80,'secret-path')",[])?;
        store.output("secret-id","secret-terminal")?;
        let serialized=serde_json::to_string(&preview(&store)?)?;
        assert!(!serialized.contains("secret-"));assert!(serialized.contains("Jauria"));
        Ok(())
    }
}

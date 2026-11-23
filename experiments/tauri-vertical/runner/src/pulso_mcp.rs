//! Local stdio MCP adapter. Every tool call reopens the session's scoped grant;
//! discovery never grants access and this process never reads the UI token.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{env, fs, io::{self, BufRead, BufReader, Read, Write}, path::PathBuf, thread, time::{Duration, Instant}};

const MAX_LINE: u64 = 128 * 1024;
const VERSION: &str = "2025-11-25";

fn tools() -> Value {
    json!([
      {"name":"jauria_projects","description":"Lista los proyectos de Pulso a los que esta sesión tiene acceso.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50},"cursor":{"type":"integer","minimum":0}},"additionalProperties":false}},
      {"name":"jauria_create_project","description":"Crea un proyecto de Pulso. Usa un idempotencyKey nuevo (por ejemplo, un UUID) y consérvalo si debes reintentar una respuesta incierta. La sesión actual queda como principal.","inputSchema":{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":240},"plan":{"type":"string","maxLength":32000},"idempotencyKey":{"type":"string","minLength":1,"maxLength":60}},"required":["title","idempotencyKey"],"additionalProperties":false}},
      {"name":"jauria_project","description":"Lee el plan y la revisión actual de un proyecto accesible.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}},
      {"name":"jauria_phases","description":"Lista las fases de un proyecto accesible.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50},"cursor":{"type":"integer","minimum":0}},"required":["projectId"],"additionalProperties":false}},
      {"name":"jauria_create_phase","description":"Crea una fase en el proyecto indicado. Usa un idempotencyKey nuevo y consérvalo al reintentar.","inputSchema":{"type":"object","properties":{"projectId":{"type":"string"},"title":{"type":"string","minLength":1,"maxLength":240},"note":{"type":"string","maxLength":1000},"status":{"type":"string","enum":["todo","doing","waiting","done"]},"idempotencyKey":{"type":"string","minLength":1,"maxLength":60}},"required":["projectId","title","idempotencyKey"],"additionalProperties":false}},
      {"name":"jauria_phase","description":"Lee la fase y su revisión actual antes de editarla.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}},
      {"name":"jauria_update_phase","description":"Actualiza una fase. Usa la revisión obtenida de jauria_phase; ante conflicto vuelve a leer y decide, sin sobrescribir a ciegas. Conserva idempotencyKey al reintentar.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"expectedRevision":{"type":"integer","minimum":1},"title":{"type":"string","minLength":1,"maxLength":240},"note":{"type":"string","maxLength":1000},"status":{"type":"string","enum":["todo","doing","waiting","done"]},"idempotencyKey":{"type":"string","minLength":1,"maxLength":60}},"required":["id","expectedRevision","idempotencyKey"],"additionalProperties":false}},
      {"name":"jauria_checkpoint","description":"Guarda qué quedó listo y la siguiente acción en una fase. Lee antes su revisión y conserva idempotencyKey si la respuesta es incierta.","inputSchema":{"type":"object","properties":{"itemId":{"type":"string"},"expectedRevision":{"type":"integer","minimum":1},"brief":{"type":"string","minLength":1,"maxLength":4000},"nextAction":{"type":"string","minLength":1,"maxLength":1000},"idempotencyKey":{"type":"string","minLength":1,"maxLength":60}},"required":["itemId","expectedRevision","brief","nextAction","idempotencyKey"],"additionalProperties":false}}
    ])
}

fn field(args: &Value, name: &str) -> Result<Value> {
    args.get(name).cloned().with_context(|| format!("Falta {name}"))
}

fn only(args: &Value, fields: &[&str]) -> Result<()> {
    let object=args.as_object().context("Los argumentos deben ser un objeto")?;
    ensure!(object.keys().all(|key| fields.contains(&key.as_str())),"Argumento MCP no disponible para esta herramienta");
    Ok(())
}

fn key(args: &Value, prefix: &str) -> Result<(String, String)> {
    let value = args["idempotencyKey"].as_str().context("Falta idempotencyKey")?;
    ensure!(!value.is_empty() && value.len() <= 60 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "idempotencyKey debe ser estable y contener solo letras, números o guiones");
    Ok((format!("{prefix}-{value}"), value.to_owned()))
}

pub(crate) fn operation(name: &str, args: &Value) -> Result<(&'static str, Value)> {
    ensure!(args.is_object(), "Los argumentos deben ser un objeto");
    let fields: &[&str]=match name {
        "jauria_projects"=>&["limit","cursor"],
        "jauria_create_project"=>&["title","plan","idempotencyKey"],
        "jauria_project"|"jauria_phase"=>&["id"],
        "jauria_phases"=>&["projectId","limit","cursor"],
        "jauria_create_phase"=>&["projectId","title","note","status","idempotencyKey"],
        "jauria_update_phase"=>&["id","expectedRevision","title","note","status","idempotencyKey"],
        "jauria_checkpoint"=>&["itemId","expectedRevision","brief","nextAction","idempotencyKey"],
        _=>bail!("Herramienta desconocida"),
    };
    only(args,fields)?;
    let pair = match name {
        "jauria_projects" => ("projects", json!({"limit":args.get("limit").cloned().unwrap_or(json!(50)),"cursor":args.get("cursor").cloned().unwrap_or(json!(0))})),
        "jauria_create_project" => { let (id,request_id)=key(args,"project")?; ("project_create",json!({"id":id,"requestId":request_id,"title":field(args,"title")?,"plan":args.get("plan").cloned().unwrap_or(json!(""))})) },
        "jauria_project" => ("project",json!({"id":field(args,"id")?})),
        "jauria_phases" => ("items",json!({"projectId":field(args,"projectId")?,"limit":args.get("limit").cloned().unwrap_or(json!(50)),"cursor":args.get("cursor").cloned().unwrap_or(json!(0))})),
        "jauria_create_phase" => { let (id,request_id)=key(args,"phase")?; let mut value=json!({"id":id,"requestId":request_id,"projectId":field(args,"projectId")?,"title":field(args,"title")?}); for name in ["note","status"] {if let Some(v)=args.get(name){value[name]=v.clone();}} ("item_create",value) },
        "jauria_phase" => ("item",json!({"id":field(args,"id")?})),
        "jauria_update_phase" => {let (_,request_id)=key(args,"update")?;let mut value=json!({"id":field(args,"id")?,"requestId":request_id,"expectedRevision":field(args,"expectedRevision")?});for name in ["title","note","status"]{if let Some(v)=args.get(name){value[name]=v.clone();}}ensure!(value.as_object().is_some_and(|v|v.len()>3),"Indica un cambio de título, nota o estado");("item_update",value)},
        "jauria_checkpoint" => {let (id,request_id)=key(args,"checkpoint")?;("checkpoint_create",json!({"id":id,"requestId":request_id,"itemId":field(args,"itemId")?,"expectedRevision":field(args,"expectedRevision")?,"brief":field(args,"brief")?,"nextAction":field(args,"nextAction")?}))},
        _ => bail!("Herramienta desconocida"),
    };
    Ok(pair)
}

fn tool_call(params: &Value) -> Value {
    let result = (|| -> Result<Value> {
        let name=params["name"].as_str().context("Falta nombre de herramienta")?;
        let args=params.get("arguments").cloned().unwrap_or_else(||json!({}));
        let (op,request_args)=operation(name,&args)?;
        let path=PathBuf::from(env::var_os("JAURIA_PULSO_HANDLE").context("Esta sesión no tiene acceso a Pulso")?);
        // PTY admission publishes the private grant just after the native child
        // starts. Wait only while the handle is absent; never retry a tool write.
        let until=Instant::now()+Duration::from_secs(2);
        while fs::symlink_metadata(&path).is_err() && Instant::now()<until {
            thread::sleep(Duration::from_millis(20));
        }
        crate::pulso_client::request(&path,op,request_args)
    })();
    match result {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}),
        Err(error) => {
            let detail=error.to_string();
            let message=if detail=="revision conflict" {"La fase cambió. Consulta su revisión actual antes de decidir qué conservar."}
              else if detail=="requestId reused with different body" {"El identificador de reintento ya se usó con otro contenido. Conserva la solicitud original o crea otra con un UUID nuevo."}
              else if detail=="unauthorized" || detail=="Esta sesión no tiene acceso a Pulso" || detail.contains("Habilita el acceso del agente") {"Esta sesión no tiene acceso a Pulso. Concédelo desde Configuración en Jauria."}
              else if detail=="project creation not authorized" {"Este permiso permite trabajar en un proyecto existente, pero no crear otro."}
              else if detail=="not found or not authorized" {"El proyecto o la fase no está disponible para esta sesión."}
              else if detail=="session is not live" {"La sesión terminó. Abre una sesión nueva y concede acceso si aún lo necesitas."}
              else if detail=="Herramienta desconocida" {"Herramienta desconocida: este servidor solo ofrece las herramientas de tools/list (jauria_projects, jauria_project, jauria_create_project, jauria_phases, jauria_phase, jauria_create_phase, jauria_update_phase y jauria_checkpoint). No se hizo ningún cambio; no reintentes con este nombre."}
              else if detail=="invalid status" {"Estado no válido: usa todo, doing, waiting o done. No se hizo ningún cambio."}
              else if detail.starts_with("Falta ") || detail=="Argumento MCP no disponible para esta herramienta" || detail.starts_with("idempotencyKey debe ser estable") || detail=="Indica un cambio de título, nota o estado" {detail.as_str()}
              else {"No se confirmó la operación. Comprueba el acceso y consulta el resultado antes de reintentar con el mismo idempotencyKey."};
            json!({"content":[{"type":"text","text":message}],"isError":true})
        }
    }
}

fn response(message: &Value) -> Option<Value> {
    let id=message.get("id")?.clone();
    if message["jsonrpc"]!="2.0" || !(id.is_string() || id.is_number()) {return Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"Solicitud JSON-RPC inválida"}}));}
    let result=match message["method"].as_str() {
        Some("initialize") => json!({"protocolVersion":VERSION,"capabilities":{"tools":{}},"serverInfo":{"name":"jauria-pulso","version":env!("CARGO_PKG_VERSION")}}),
        Some("ping") => json!({}),
        Some("tools/list") => json!({"tools":tools()}),
        Some("tools/call") => tool_call(&message["params"]),
        _ => return Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Método MCP no disponible"}})),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

pub fn run() -> Result<()> {
    let stdin=io::stdin();let mut input=BufReader::new(stdin.lock());let stdout=io::stdout();let mut output=stdout.lock();
    loop {
        let mut line=Vec::new();
        let count=(&mut input).take(MAX_LINE+1).read_until(b'\n',&mut line)?;
        if count==0 {return Ok(());}
        ensure!(count as u64<=MAX_LINE && line.last()==Some(&b'\n'),"Mensaje MCP demasiado grande o incompleto");
        let message:Value=match serde_json::from_slice(&line) {
            Ok(value)=>value,
            Err(_)=>{writeln!(output,"{}",json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"JSON inválido"}}))?;output.flush()?;continue;}
        };
        if let Some(value)=response(&message) {serde_json::to_writer(&mut output,&value)?;output.write_all(b"\n")?;output.flush()?;}
    }
}

//! Small local client. It knows only a scoped grant handle, never the core/UI token.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{ffi::OsString, fs::OpenOptions, io::{BufRead, BufReader, Read, Write}, os::unix::{fs::{MetadataExt, OpenOptionsExt}, net::UnixStream}, path::{Path, PathBuf}, time::Duration};

fn handle(path: &Path) -> Result<Value> {
    ensure!(path.is_absolute(), "La ruta del permiso debe ser absoluta");
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
        .context("Habilita el acceso del agente desde Pulso y usa su comando de conexión")?;
    let meta = file.metadata()?;
    ensure!(meta.is_file() && meta.uid() == unsafe {libc::geteuid()} && meta.mode() & 0o077 == 0 && meta.nlink() == 1 && meta.len() <= 16*1024, "Archivo de permiso no privado o inválido");
    let mut text = String::new(); (&mut file).take(16*1024+1).read_to_string(&mut text)?;
    ensure!(text.len() <= 16*1024, "Archivo de permiso demasiado grande");
    let value:Value=serde_json::from_str(&text).context("Permiso inválido; vuelve a conectarlo desde Pulso")?;
    ensure!(value["token"].as_str().is_some_and(|s|s.len()>=32 && s.len()<=4096 && !s.chars().any(char::is_whitespace)), "Permiso inválido");
    let socket=Path::new(value["socket"].as_str().context("Falta endpoint de Pulso")?);
    ensure!(socket.is_absolute() && socket.as_os_str().len()<104, "Endpoint de Pulso inválido");
    Ok(value)
}

pub fn run(args: &[OsString]) -> Result<()> {
    if args.is_empty() || args[0] == "--help" {
        println!("{}", r#"Jauria Pulso · cliente local
Uso: aw-runner --pulso-client [--handle RUTA] OPERACIÓN [JSON o -]

Lectura: projects {limit,cursor}; project {id}; items {projectId,limit,cursor}; item {id}; activity {projectId,itemId,limit}; checkpoint_history {itemId,cursor,limit<=10}.
Escritura: project_create {id,requestId,title,plan?,mainSessionId?}; project_update {id,requestId,expectedRevision,title?,plan?}; item_create {id,requestId,projectId,title,note?,status?}; item_update {id,requestId,expectedRevision,title?,note?,status?,position?}; link {requestId,projectId|itemId,sessionId}; checkpoint_create {id,requestId,itemId,expectedRevision,brief,nextAction,sessionId?}.
Estados: todo, doing, waiting, done. Una fase es un item de proyecto.

Genera un UUID distinto por registro y solicitud (por ejemplo con uuidgen).
Conserva requestId, ID y contenido al reintentar una operación incierta. Consulta la revisión actual antes de una edición nueva. Un conflicto nunca debe sobrescribirse a ciegas.
Usa - para leer un objeto JSON por stdin en vez de incluir el plan en argumentos de shell.
El acceso se concede y revoca desde Pulso. Esta CLI no inicia sesiones, no envía texto al PTY y no modifica Jira."#);
        return Ok(());
    }
    let (path, rest) = if args[0]=="--handle" {
        ensure!(args.len()>=3, "Faltan ruta de permiso y operación");
        (PathBuf::from(&args[1]), &args[2..])
    } else { (PathBuf::from(std::env::var_os("JAURIA_PULSO_HANDLE").context("Sin permiso: habilita esta sesión desde Pulso")?), args) };
    ensure!(!rest.is_empty() && rest.len()<=2, "Usa OPERACIÓN y un único objeto JSON");
    let op=rest[0].to_str().context("Operación inválida")?;
    ensure!(!op.is_empty() && op.len()<=48 && op.bytes().all(|b|b.is_ascii_lowercase()||b==b'_'), "Operación inválida");
    let raw=rest.get(1).map(|s|s.to_str().context("JSON inválido")).transpose()?.unwrap_or("{}");
    let mut input=String::new();
    let raw=if raw=="-" {std::io::stdin().take(120*1024+1).read_to_string(&mut input)?;input.as_str()} else {raw};
    ensure!(raw.len()<=120*1024, "La petición supera el límite del cliente");
    let args:Value=serde_json::from_str(raw).context("Envía un objeto JSON válido")?;
    ensure!(args.is_object(), "Los argumentos deben ser un objeto JSON");
    let credential=handle(&path)?;
    let socket=credential["socket"].as_str().unwrap();
    let mut stream=UnixStream::connect(socket).context("Pulso no está disponible. Abre Jauria y comprueba la conexión; no se encola la acción")?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut request=serde_json::to_vec(&json!({"version":1,"token":credential["token"],"op":op,"args":args}))?;
    request.push(b'\n'); ensure!(request.len()<=128*1024, "La petición es demasiado grande");
    stream.write_all(&request).context("No se confirmó el envío; consulta el resultado o reintenta con el mismo requestId")?;
    let mut line=Vec::new(); BufReader::new(stream).take(512*1024+1).read_until(b'\n', &mut line)
        .context("No se confirmó el resultado; conserva requestId y revisiones al reintentar")?;
    ensure!(line.len()<=512*1024 && line.last()==Some(&b'\n'), "Respuesta incompleta; consulta el resultado antes de repetir");
    let response:Value=serde_json::from_slice(&line).context("Respuesta inválida")?;
    // The server derives identity. Do not echo requests, credentials, or handle content.
    if response["ok"] != true { anyhow::bail!("{}",response["error"].as_str().unwrap_or("La operación no se confirmó")); }
    println!("{}",serde_json::to_string(&response["result"])?);
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt,symlink};
    #[test] fn rejects_public_linked_and_oversized_handles() -> Result<()> {
        let temp=tempfile::tempdir()?;let path=temp.path().join("grant");
        std::fs::write(&path,"{}")?;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o644))?;assert!(handle(&path).is_err());
        std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600))?;
        let linked=temp.path().join("link");symlink(&path,&linked)?;assert!(handle(&linked).is_err());
        std::fs::write(&path,vec![b'x';16*1024+1])?;assert!(handle(&path).is_err());Ok(())
    }
}

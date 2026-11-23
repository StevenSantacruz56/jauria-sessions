#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path="../../../runner/src/approval_text.rs"] mod approval_text;

use serde::Serialize;
use serde_json::{Value, json};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, os::unix::{fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}, net::UnixStream, process::CommandExt}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc,Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
mod start_policy;
#[path = "../../../runner/src/resources.rs"]
mod resources;
#[path = "../../../runner/src/resource_tree.rs"]
mod resource_tree;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Layout { data_dir: PathBuf, socket: PathBuf, token_file: PathBuf }
#[derive(Default)]
struct Bridge { layout: Mutex<Option<Layout>>, connect: Mutex<()>, resources: Arc<Mutex<resources::ResourcesSampler>>, diagnostic: Mutex<Option<(String,String)>> }
type Result<T> = std::result::Result<T, String>;
fn error(e: impl std::fmt::Display) -> String { e.to_string() }

fn private_dir(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {},
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(error(e)),
    }
    let meta = fs::symlink_metadata(path).map_err(error)?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 { return Err("El directorio debe pertenecer al usuario y ser privado (0700); no se cambian permisos existentes".into()); }
    Ok(())
}
fn layout_for(app: &tauri::AppHandle) -> Result<Layout> {
    let data_dir = match std::env::var_os("AW_VERTICAL_HOME") {
        Some(p) => PathBuf::from(p), None => app.path().app_local_data_dir().map_err(error)?,
    };
    if !data_dir.is_absolute() { return Err("AW_VERTICAL_HOME debe ser absoluto".into()); }
    private_dir(&data_dir)?;
    // FNV-1a over exact absolute UTF-8 dataDir, stable for the harness (no random hasher).
    let mut hash = 0xcbf29ce484222325u64;
    for b in data_dir.to_str().ok_or("dataDir no es UTF-8")?.as_bytes() { hash ^= *b as u64; hash = hash.wrapping_mul(0x100000001b3); }
    let home = std::env::var_os("HOME").ok_or("HOME no disponible")?;
    let dir = PathBuf::from(home).join("Library/Caches").join(format!("aw-vertical-{hash:016x}"));
    private_dir(&dir)?;
    let layout = Layout { data_dir, socket: dir.join("runner.sock"), token_file: dir.join("runner.token") };
    if layout.socket.as_os_str().len() >= 104 { return Err("Ruta de socket demasiado larga".into()); }
    // Never replace an existing token: a live daemon must remain reachable on reconnect.
    match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&layout.token_file) {
        Ok(mut file) => {
            let mut bytes = [0u8; 32];
            fs::File::open("/dev/urandom").map_err(error)?.read_exact(&mut bytes).map_err(error)?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            file.write_all(token.as_bytes()).map_err(error)?;
            file.sync_all().map_err(error)?;
        },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(error(e)),
    }
    let meta = fs::symlink_metadata(&layout.token_file).map_err(error)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 || meta.nlink() != 1 { return Err("Archivo de token inválido o no privado".into()); }
    // Atomic publication: the harness never sees partial JSON.
    let tmp = layout.data_dir.join(format!(".layout-{}.tmp", std::process::id()));
    let mut out = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(error)?;
    out.write_all(&serde_json::to_vec_pretty(&layout).map_err(error)?).map_err(error)?;
    out.sync_all().map_err(error)?;
    fs::rename(tmp, layout.data_dir.join("layout.json")).map_err(error)?;
    Ok(layout)
}
fn rpc(layout: &Layout, op: &str, args: Value) -> Result<Value> {
    rpc_timeout(layout, op, args, Duration::from_secs(3))
}
fn rpc_timeout(layout: &Layout, op: &str, args: Value, timeout: Duration) -> Result<Value> {
    let token = fs::read_to_string(&layout.token_file).map_err(|_| "No se puede leer el token privado")?;
    if token.trim().len() < 32 || token.len() > 256 { return Err("Token privado inválido".into()); }
    let mut stream = UnixStream::connect(&layout.socket).map_err(|_| "Runner no disponible; pulsa Conectar / Reintentar")?;
    stream.set_read_timeout(Some(timeout)).map_err(error)?;
    stream.set_write_timeout(Some(timeout)).map_err(error)?;
    let mut request = serde_json::to_vec(&json!({"version":1,"token":token.trim(),"op":op,"args":args})).map_err(error)?;
    request.push(b'\n');
    if request.len() > 128 * 1024 { return Err("Petición demasiado grande".into()); }
    stream.write_all(&request).map_err(|_| "No se pudo enviar al runner")?;
    let mut reader = std::io::BufReader::new(stream);
    let mut response = Vec::new();
    use std::io::BufRead;
    reader.by_ref().take(8 * 1024 * 1024).read_until(b'\n', &mut response).map_err(|_| "Runner no respondió a tiempo")?;
    if response.last() != Some(&b'\n') { return Err("Respuesta del runner incompleta o demasiado grande".into()); }
    serde_json::from_slice(&response).map_err(|_| "Respuesta JSON del runner inválida".into())
}
fn validate(op: &str, args: &Value) -> Result<()> {
    let obj = args.as_object().ok_or("args debe ser objeto")?;
    let fields: &[&str] = match op {
        "status" | "telemetry" | "refresh_quotas" | "get_settings" => &[],
        "set_settings" => &["maxConcurrentSessions"],
        "rename_session" => &["id","title"],
        "native_binding" => &["id"],
        "resume_native" => &["id","sourceId","rows","cols"],
        "purge_history" | "compact_history" => &["id","confirmed"],
        "start_codex" => &["id","title","kind","cwd","rows","cols"],
        "codex_state" => &["id"],"codex_request" => &["id","requestId"],
        "codex_resume" => &["id","generation"],
        "codex_turn" | "codex_command" => &["id","commandId","turnId","attemptId","generation","prompt"],
        "codex_interrupt" => &["id","turnId","attemptId","generation"],
        "codex_permission" => &["id","requestId","generation","decision"],
        "start" => &["id","title","kind","rows","cols","cwd"],
        "input" => &["id","data"], "resize" => &["id","rows","cols"],
        "stop" => &["id","generation"], "interrupt" => &["id"], "events" => &["after","limit"],
        "terminal_live" => &["id","after","limit"],
        _ => return Err("Operación no permitida".into()),
    };
    if obj.keys().any(|k| !fields.contains(&k.as_str())) { return Err("Argumento no permitido".into()); }
    if fields.contains(&"id") {
        let id = args["id"].as_str().ok_or("Falta id")?;
        if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("ID inválido".into()); }
    }
    if op == "set_settings" && args["maxConcurrentSessions"].as_u64().is_none_or(|n| !(1..=8).contains(&n)) {
        return Err("El límite de sesiones debe ser un entero entre 1 y 8".into());
    }
    if op == "rename_session" {
        let title = args["title"].as_str().ok_or("Falta título de sesión")?;
        let trimmed = title.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.len() > 480 || title.chars().any(char::is_control) {
            return Err("El título debe contener entre 1 y 120 caracteres, hasta 480 bytes y sin controles".into());
        }
    }
    if matches!(op,"start"|"start_codex") {
        if !matches!(args["kind"].as_str(), Some("fixture" | "shell" | "terminal" | "claude_probe" | "codex_probe" | "claude" | "codex")) { return Err("Tipo de sesión inválido".into()); }
        if matches!(args["kind"].as_str(), Some("claude" | "codex" | "terminal")) || obj.contains_key("cwd") {
            let cwd = args["cwd"].as_str().ok_or("Selecciona una carpeta para iniciar la sesión")?;
            let path = Path::new(cwd);
            if !path.is_absolute() || !path.is_dir() { return Err("cwd debe ser un directorio absoluto existente".into()); }
            let canonical = fs::canonicalize(path).map_err(error)?;
            if canonical.to_str() != Some(cwd) { return Err("cwd debe ser una ruta canónica; vuelve a seleccionar la carpeta".into()); }
        }
        if args["title"].as_str().is_none_or(|s| s.len() > 160) { return Err("Título inválido".into()); }
    }
    if matches!(op, "start" | "start_codex" | "resize") {
        for field in ["rows", "cols"] { if args[field].as_u64().is_none_or(|n| !(if op=="resize" {1..=1000} else {2..=1000}).contains(&n)) { return Err("Tamaño inválido".into()); } }
    }
    if op=="start_codex" && args["kind"]!="codex" {return Err("Proveedor estructurado inválido".into());}
    if matches!(op,"codex_resume"|"codex_turn"|"codex_command"|"codex_interrupt"|"codex_permission") && args["generation"].as_i64().is_none_or(|n|n<=0) {return Err("Generación inválida".into());}
    if matches!(op,"codex_turn"|"codex_command") && args["prompt"].as_str().is_none_or(|s|s.is_empty() || s.len()>32768 || s.contains('\0')) {return Err("El mensaje debe contener entre 1 y 32768 bytes UTF8 sin NUL".into());}
    if op=="codex_permission" && !matches!(args["decision"].as_str(),Some("accept"|"deny")){return Err("Decisión inválida".into());}
    if op == "input" && args["data"].as_str().is_none_or(|s| s.len() > 16 * 1024) { return Err("Entrada inválida o mayor de 16 KiB".into()); }
    if op == "events" && (args["after"].as_u64().is_none() || args["limit"].as_u64().is_none_or(|n| !(1..=1000).contains(&n))) { return Err("Cursor o límite inválido".into()); }
    if op == "terminal_live" && (args["after"].as_u64().is_none() || args["limit"].as_u64().is_none_or(|n| !(1..=64).contains(&n))) { return Err("Cursor o límite de terminal inválido".into()); }
    Ok(())
}
#[tauri::command]
async fn connect_runner(app: tauri::AppHandle) -> Result<Value> {
    let app2 = app.clone();
    // No blocking socket or launch work on the WebView/UI thread.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<Bridge>();
        let _guard = state.connect.lock().map_err(error)?;
        let layout = layout_for(&app2)?;
        *state.layout.lock().map_err(error)? = Some(layout.clone());
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut status = rpc_timeout(&layout, "status", json!({}), Duration::from_millis(400));
        if !status.as_ref().is_ok_and(|v| v["ok"] == true) {
            let binary = app2.path().resource_dir().map_err(error)?.join("bin/aw-runner");
            if !binary.is_file() { return Err(format!("Falta recurso bin/aw-runner: {}", binary.display())); }
            let mut command = Command::new(binary);
            command.args(["--data-dir"]).arg(&layout.data_dir).arg("--socket").arg(&layout.socket).arg("--token-file").arg(&layout.token_file)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            unsafe { command.pre_exec(|| { if libc::setsid() == -1 { return Err(std::io::Error::last_os_error()); } Ok(()) }); }
            let mut child = command.spawn().map_err(|_| "No se pudo iniciar runner")?;
            std::thread::spawn(move || { let _ = child.wait(); });
            while Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() { break; }
                status = rpc_timeout(&layout, "status", json!({}), remaining.min(Duration::from_millis(400)));
                if status.as_ref().is_ok_and(|v| v["ok"] == true) { break; }
                std::thread::sleep(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(80)));
            }
        }
        let status = status?;
        if status["ok"] != true { return Err("Runner rechazó conexión".into()); }
        Ok(json!({"dataDir":layout.data_dir,"socket":layout.socket,"status":status["result"],"smoke":std::env::var("AW_VERTICAL_SMOKE").as_deref()==Ok("1")}))
    }).await.map_err(error)?;
    result
}
#[tauri::command]
async fn runner_request(op: String, args: Value, state: tauri::State<'_, Bridge>) -> Result<Value> {
    validate(&op, &args)?;
    if matches!(op.as_str(),"codex_permission"|"purge_history"|"compact_history") { return Err("Usa la confirmación nativa para esta acción".into()); }
    start_policy::validate_start_mode(&op,&args,std::env::var("AW_VERTICAL_SMOKE").as_deref()==Ok("1"))?;
    let layout = state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero al runner")?;
    let sampler=state.resources.clone();
    tauri::async_runtime::spawn_blocking(move || {
    let app_metrics=if op=="telemetry" {
        let discovery=resource_tree::observe(std::process::id());
        let mut pids=vec![std::process::id()];
        if let Some(rows)=discovery["pids"].as_array(){pids.extend(rows.iter().filter_map(|p|p.as_u64().map(|p|p as u32)));}
        let mut sample=sampler.lock().map_err(error)?.sample(&pids);sample["discovery"]=discovery;Some(sample)
    }else{None};
        if matches!(op.as_str(),"start_codex"|"codex_resume"|"resume_native"|"stop") { rpc_timeout(&layout,&op,args,Duration::from_secs(60)) }
        else {
            let mut response=rpc(&layout,&op,args)?;
            if let Some(mut metrics)=app_metrics {
                let backend:std::collections::HashSet<u64>=response["result"]["resources"]["processes"].as_array().into_iter().flatten().filter_map(|r|r["pid"].as_u64()).collect();
                if let Some(rows)=metrics["processes"].as_array_mut(){rows.retain(|r|r["pid"].as_u64().is_some_and(|pid|!backend.contains(&pid)));}
                response["result"]["resources"]["app"]=metrics;
            }
            Ok(response)
        }
    }).await.map_err(error)?
}

fn validate_pulso(op: &str, args: &Value) -> Result<()> {
    let fields: &[&str] = match op {
        "revision" => &[],
        "projects" => &["cursor","limit","archived"],
        "project" | "item" => &["id"],
        "items" => &["projectId","cursor","limit","archived","status","expectedSnapshotRevision"],
        "board" => &["projectId","ifRevision"],
        "sidebar_summary" => &["ifRevision"],
        "links" => &["projectId"],
        "checkpoint_history" => &["itemId","cursor","limit"],
        "activity" => &["projectId","itemId","limit"],
        "project_create" => &["id","requestId","title","plan","mainSessionId"],
        "project_update" => &["id","requestId","expectedRevision","title","plan","mainSessionId","archived"],
        "item_create" => &["id","requestId","projectId","title","note","status"],
        "item_update" => &["id","requestId","expectedRevision","title","note","status","position","archived"],
        "link" => &["requestId","projectId","itemId","sessionId"],
        "checkpoint_create" => &["id","requestId","itemId","expectedRevision","brief","nextAction","sessionId"],
        "grant" => &["sessionId","projectId","canCreateProjects","remember"],
        "revoke" => &["sessionId"],
        "policies" => &[],
        "revoke_policy" => &["id"],
        _ => return Err("Operación de Pulso no permitida".into()),
    };
    let object=args.as_object().ok_or("args debe ser objeto")?;
    if object.keys().any(|key|!fields.contains(&key.as_str())) { return Err("Argumento de Pulso no permitido".into()); }
    if op == "items" {
        if let Some(status) = args.get("status") {
            if !status.as_str().is_some_and(|s| ["todo","doing","waiting","done"].contains(&s)) {
                return Err("Estado de Pulso inválido".into());
            }
        }
        if args.get("expectedSnapshotRevision").is_some_and(|v| v.as_u64().is_none()) {
            return Err("Revisión de Pulso inválida".into());
        }
    }
    if op == "sidebar_summary" && args.get("ifRevision").is_some_and(|v| v.as_u64().is_none()) {
        return Err("Revisión de Pulso inválida".into());
    }
    if op == "board" {
        if !args.get("projectId").is_some_and(|v| v.is_null() || v.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 80 && id != "." && id != ".." && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b)))) {
            return Err("Proyecto de Pulso inválido".into());
        }
        if args.get("ifRevision").is_some_and(|v| v.as_u64().is_none()) {
            return Err("Revisión de Pulso inválida".into());
        }
    }
    if serde_json::to_vec(args).map_err(error)?.len()>120*1024 { return Err("Petición de Pulso demasiado grande".into()); }
    Ok(())
}

// Separate connection, credential and worker: planning never enters PTY polling.
#[tauri::command]
async fn pulso_request(op:String,args:Value,state:tauri::State<'_,Bridge>)->Result<Value> {
    validate_pulso(&op,&args)?;
    let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero al runner")?;
    tauri::async_runtime::spawn_blocking(move || {
        let parent=layout.socket.parent().ok_or("Endpoint de Pulso no disponible")?;
        let file=parent.join("pulso.token");
        let mut token_file=OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK).open(file)
            .map_err(|_|"Pulso no está disponible en este runner")?;
        let meta=token_file.metadata().map_err(error)?;
        if !meta.is_file() || meta.uid()!=unsafe {libc::geteuid()} || meta.mode()&0o077!=0 || meta.nlink()!=1 || meta.len()>4096 {
            return Err("Credencial local de Pulso inválida".into());
        }
        let mut token=String::new(); (&mut token_file).take(4097).read_to_string(&mut token).map_err(error)?;
        let token=token.trim();
        if token.len()<32 || token.len()>4096 || token.chars().any(char::is_whitespace) { return Err("Credencial local de Pulso inválida".into()); }
        let mut stream=UnixStream::connect(parent.join("pulso.sock")).map_err(|_|"Pulso no responde; vuelve a conectar")?;
        stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(error)?;
        stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(error)?;
        let mut request=serde_json::to_vec(&json!({"version":1,"token":token,"op":op,"args":args})).map_err(error)?;
        request.push(b'\n');
        if request.len()>128*1024 { return Err("Petición de Pulso demasiado grande".into()); }
        stream.write_all(&request).map_err(|_|"No se confirmó el envío a Pulso; conserva el mismo requestId al reintentar")?;
        use std::io::BufRead;
        let mut line=Vec::new();
        std::io::BufReader::new(stream).take(512*1024+1).read_until(b'\n',&mut line)
            .map_err(|_|"Pulso no confirmó el resultado; consulta o reintenta con el mismo requestId")?;
        if line.len()>512*1024 || line.last()!=Some(&b'\n') { return Err("Respuesta incompleta de Pulso".into()); }
        serde_json::from_slice(&line).map_err(|_|"Respuesta inválida de Pulso".into())
    }).await.map_err(error)?
}
// Keep the renderer limited to selecting a single directory. No generic file API.
#[tauri::command]
fn home_directory(app: tauri::AppHandle) -> Result<String> {
    let path = fs::canonicalize(app.path().home_dir().map_err(error)?).map_err(error)?;
    if !path.is_dir() { return Err("La carpeta personal no está disponible".into()); }
    Ok(path.to_str().ok_or("La ruta de la carpeta personal no es UTF-8")?.to_owned())
}
#[tauri::command]
async fn select_directory(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app.dialog().file().set_title("Seleccionar carpeta de trabajo").blocking_pick_folder() else { return Ok(None); };
        let path = folder.into_path().map_err(error)?;
        let canonical = fs::canonicalize(path).map_err(error)?;
        if !canonical.is_dir() { return Err("Selecciona un directorio existente".into()); }
        Ok(Some(canonical.to_str().ok_or("La ruta no es UTF-8")?.to_owned()))
    }).await.map_err(error)?
}
#[tauri::command]
async fn release_session(app: tauri::AppHandle, id: String) -> Result<bool> {
    if id.is_empty() || id.len()>64 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-') { return Err("ID inválido".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<Bridge>();
        let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
        let status=rpc(&layout,"status",json!({}))?;
        let session=status["result"]["sessions"].as_array().and_then(|rows|rows.iter().find(|s|s["id"]==id)).ok_or("Sesión desconocida")?;
        if session["status"]!="needs_attention" { return Err("Solo se liberan sesiones sin identidad confirmada".into()); }
        let cwd=session["cwd"].as_str().unwrap_or("carpeta desconocida");
        let reason=session["detail"]["reason"].as_str().unwrap_or("El runner no puede confirmar el cierre seguro de esta sesión.");
        let survivors=session["detail"]["survivors"].as_array().map(|p|p.iter().map(Value::to_string).collect::<Vec<_>>().join(", ")).unwrap_or_else(||"sin inventario confirmado".into());
        let inventory=session["detail"]["inventoryError"].as_str().unwrap_or("sin error registrado");
        let window=app.get_webview_window("main").ok_or("Ventana de confirmación no disponible")?;
        let confirmed=app.dialog().message(format!("Verifica que los procesos y herramientas hayan terminado antes de liberar esta carpeta:\n\n{cwd}\n\nMotivo: {reason}\nPID original (solo informativo): {}\nProcesos observados en la sesión: {survivors}\nInventario: {inventory}\n\nLiberar no detiene procesos ni reanuda la sesión. Conserva el historial y permite crear otra sesión. ¿Confirmas que comprobaste los procesos?",session["pid"]))
            .parent(&window)
            .title("Liberar carpeta de sesión")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show_with_result();
        eprintln!("release confirmation {id}: {confirmed:?}");
        if !matches!(confirmed,MessageDialogResult::Ok) { return Ok(false); }
        let mut args=json!({"id":id,"confirmed":true});
        if session["transport"]=="app-server"{args["generation"]=session["codex"]["generation"].clone();}
        let response=rpc(&layout,"release",args)?;
        if response["ok"]!=true { return Err(response["error"].as_str().unwrap_or("No se pudo liberar la carpeta").to_owned()); }
        Ok(true)
    }).await.map_err(error)?
}
#[tauri::command]
async fn probe_tools() -> Result<Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut results = Vec::new();
        let claude = PathBuf::from(std::env::var_os("HOME").ok_or("HOME no disponible")?).join(".local/bin/claude");
        for (name, default) in [("claude", claude), ("codex", PathBuf::from("/opt/homebrew/bin/codex"))] {
            let path = if default.is_file() { Some(default) } else {
                std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|p| p.is_absolute() && p.is_file()))
            };
            let Some(path) = path else { results.push(json!({"tool":name,"available":false})); continue; };
            let mut command = Command::new(&path);
            command.arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped());
            let mut child = command.spawn().map_err(error)?;
            let stdout = child.stdout.take().ok_or("stdout no disponible")?;
            let output = std::thread::spawn(move || { let mut out = Vec::new(); let _ = stdout.take(4096).read_to_end(&mut out); out });
            let deadline = Instant::now() + Duration::from_secs(3);
            let success = loop {
                if let Some(status) = child.try_wait().map_err(error)? { break status.success(); }
                if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); break false; }
                std::thread::sleep(Duration::from_millis(30));
            };
            let bytes = output.join().unwrap_or_default();
            results.push(json!({"tool":name,"path":path,"available":success,"version":String::from_utf8_lossy(&bytes).trim()}));
        }
        Ok(json!(results))
    }).await.map_err(error)?
}
fn validate_stream_metrics(payload:&Value)->Result<()> {
    let Some(metrics)=payload.get("streamMetrics") else{return Ok(());};
    let obj=metrics.as_object().ok_or("Métricas inválidas")?;
    let numbers=["pages","lastPageMs","lastParseMs","lastTransferMs","lastYieldMs","maxParseMs","maxYieldMs","pageBytes"];
    for (key,value) in obj {
        if key=="visibility" {if !matches!(value.as_str(),Some("unknown"|"visible"|"hidden")){return Err("Visibilidad inválida".into());}}
        else if !numbers.contains(&key.as_str()) || !value.as_f64().is_some_and(|n|n.is_finite() && (0.0..=1_000_000_000.0).contains(&n)){return Err("Métricas inválidas".into());}
    }
    Ok(())
}
#[tauri::command]
async fn record_ui_evidence(payload: Value, state: tauri::State<'_, Bridge>) -> Result<()> {
    if std::env::var("AW_VERTICAL_SMOKE").as_deref() != Ok("1") { return Err("Evidencia UI deshabilitada".into()); }
    let obj = payload.as_object().ok_or("Payload inválido")?;
    if obj.keys().any(|k| !["renderedSeq","sessions","ready","connection","runnerPid","generation","streamMetrics"].contains(&k.as_str())) || payload["renderedSeq"].as_u64().is_none() { return Err("Evidencia inválida".into()); }
    validate_stream_metrics(&payload)?;
    let bytes = serde_json::to_vec_pretty(&payload).map_err(error)?;
    if bytes.len() > 128 * 1024 { return Err("Evidencia demasiado grande".into()); }
    let layout = state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
    tauri::async_runtime::spawn_blocking(move || {
    let tmp = layout.data_dir.join(".ui-evidence.tmp");
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(error)?;
    file.write_all(&bytes).map_err(error)?;
    fs::rename(tmp, layout.data_dir.join("ui-evidence.json")).map_err(error)
    }).await.map_err(error)?
}
#[tauri::command]
async fn confirm_codex_permission(app:tauri::AppHandle,mut args:Value,state:tauri::State<'_,Bridge>)->Result<Value>{
    validate("codex_permission",&args)?;
    let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
    tauri::async_runtime::spawn_blocking(move||{
        let response=rpc(&layout,"codex_request",json!({"id":args["id"],"requestId":args["requestId"]}))?;
        if response["ok"]!=true{return Ok(response);}
        let request=&response["result"];
        if request["sessionId"]!=args["id"] || request["generation"]!=args["generation"] || request["status"]!="pending" {return Err("El permiso ya cambió o pertenece a otra conexión.".into());}
        if args["decision"]=="accept" {
            let data=&request["payload"]["params"];
            if request["method"]!="item/commandExecution/requestApproval" || data["kind"]!="command" || !approval_text::local_environment(&data["environmentId"]) || !data["networkApprovalContext"].is_null() {return Err("Este alcance no admite aprobación en Jauria. Puedes rechazarlo y pedir una alternativa.".into());}
            let command=data["command"].as_str().ok_or("Falta el comando exacto")?;
            let cwd=data["cwd"].as_str().ok_or("Falta carpeta exacta")?;
            if command.len()>8192 || cwd.len()>4096 || !Path::new(cwd).is_absolute(){return Err("El comando o la carpeta no se pueden confirmar íntegramente.".into());}
            if !approval_text::supported(command) || !approval_text::supported(cwd){return Err("El comando contiene controles o caracteres de formato que no admitimos para aprobar. Recházalo y pide un comando visible en una línea.".into());}
            let (visible_command,visible_cwd)=approval_text::compact_command(command,cwd).ok_or("El comando supera el tamaño visible admitido. Recházalo y pide un comando más corto, sin relleno de espacios.")?;
            let description=format!("Solicitud de Codex para esta ejecución.\n\nCarpeta: {}\nComando exacto informado por el proveedor: {}\n\nLa política nativa de Codex gobierna su ejecución. Puede cambiar archivos; interrumpir no revierte efectos. Se permite una sola respuesta, sin reglas de sesión ni permisos heredados. Cancelar este diálogo rechaza la solicitud.",visible_cwd,visible_command);
            let window=app.get_webview_window("main").ok_or("Ventana de confirmación no disponible")?;
        let approved=app.dialog().message(description).parent(&window).title("Permitir comando de Codex · Jauria").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
            if !approved {args["decision"]=json!("deny");} else {args["nativeConfirmed"]=json!(true);}
        }
        rpc(&layout,"codex_permission",args)
    }).await.map_err(error)?
}
#[tauri::command]
async fn restart_runner(app:tauri::AppHandle,state:tauri::State<'_,Bridge>)->Result<bool>{
    let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
    tauri::async_runtime::spawn_blocking(move|| {
        let window=app.get_webview_window("main").ok_or("Ventana de confirmación no disponible")?;
        let confirmed=app.dialog().message(format!("Perfil: {}\n\nSe detendrán TODAS las sesiones administradas de este perfil y se reiniciará el runner con la versión de Jauria abierta. Se conservan archivos e historial. Una operación interrumpida puede requerir revisión. Confirma solo cuando puedas detener este trabajo.",layout.data_dir.display())).parent(&window).title("Reiniciar runner de Jauria").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
        if !confirmed{return Ok(false);}
        let response=rpc(&layout,"shutdown",json!({}))?;
        if response["ok"]!=true{return Err("El runner no confirmó el cierre".into());}
        let deadline=Instant::now()+Duration::from_secs(8);
        while layout.socket.exists() {
            if Instant::now()>=deadline{return Err("El runner sigue cerrando. Espera y pulsa Reconectar; no se inicia un segundo runner.".into());}
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(true)
    }).await.map_err(error)?
}
#[tauri::command]
async fn preview_diagnostic(state: tauri::State<'_,Bridge>) -> Result<Value> {
    let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
    let response=tauri::async_runtime::spawn_blocking(move||rpc(&layout,"diagnostic_preview",json!({}))).await.map_err(error)??;
    if response["ok"]!=true {return Err("No se pudo preparar diagnóstico".into());}
    let content=serde_json::to_string_pretty(&response["result"]).map_err(error)?;
    let mut random=[0u8;16];fs::File::open("/dev/urandom").map_err(error)?.read_exact(&mut random).map_err(error)?;
    let id:String=random.iter().map(|b|format!("{b:02x}")).collect();
    *state.diagnostic.lock().map_err(error)?=Some((id.clone(),content.clone()));
    Ok(json!({"previewId":id,"content":content}))
}
#[tauri::command]
async fn export_diagnostic(app:tauri::AppHandle, preview_id:String, state:tauri::State<'_,Bridge>) -> Result<bool> {
    let (id,content)=state.diagnostic.lock().map_err(error)?.clone().ok_or("Previsualiza el diagnóstico primero")?;
    if id!=preview_id {return Err("La previsualización cambió. Revísala de nuevo antes de exportar".into());}
    tauri::async_runtime::spawn_blocking(move|| {
        let Some(file)=app.dialog().file().set_title("Guardar diagnóstico revisado").set_file_name("jauria-diagnostico.json").blocking_save_file() else{return Ok(false);};
        let path=file.into_path().map_err(error)?;
        // create_new rejects symlinks and existing files. Never overwrite a file
        // the user may have changed while the native save panel was open.
        let mut output=OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(error)?;
        output.write_all(content.as_bytes()).map_err(error)?;output.sync_all().map_err(error)?;
        Ok(true)
    }).await.map_err(error)?
}
#[tauri::command]
async fn confirm_history(app: tauri::AppHandle, op: String, mut args: Value, state: tauri::State<'_, Bridge>) -> Result<Value> {
    if !matches!(op.as_str(),"purge_history"|"compact_history") {return Err("Confirmación no disponible para esta operación".into());}
    if !args.is_object(){return Err("Argumentos inválidos".into());}
    args["confirmed"]=json!(true);validate(&op,&args)?;
    let layout=state.layout.lock().map_err(error)?.clone().ok_or("Conecta primero")?;
    tauri::async_runtime::spawn_blocking(move || {
        let label=if op=="compact_history" {"Compactar TODOS los eventos antiguos de esta sesión finalizada, incluida la salida y los tamaños. Se conserva el último estado y los archivos; se declaran los tramos retirados. No es borrado seguro del disco o backups."}else{"Eliminar la salida de esta sesión finalizada y liberar su cuota lógica. Conserva estado y archivos; el tramo se marcará como eliminado. No es borrado seguro del disco o backups."};
        let status=rpc(&layout,"status",json!({}))?;
        let selected=status["result"]["sessions"].as_array().and_then(|rows|rows.iter().find(|row|row["id"]==args["id"])).ok_or("Sesión desconocida")?;
        let description=format!("{}\n\nSesión: {}\nCarpeta: {}\nID: {}",label,selected["title"],selected["cwd"],args["id"].as_str().unwrap_or(""));
        let window=app.get_webview_window("main").ok_or("Ventana de confirmación no disponible")?;
        let approved=app.dialog().message(description).parent(&window).title("Jauria").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
        if !approved {return Err("Acción cancelada".into());}
        rpc_timeout(&layout,&op,args,Duration::from_secs(60))
    }).await.map_err(error)?
}
#[tauri::command]
fn quit_ui(app: tauri::AppHandle) { app.exit(0); }
const SETTINGS_MENU_ID: &str = "open-settings";
fn application_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let menu = Menu::default(app)?;
    let settings = MenuItem::with_id(app, SETTINGS_MENU_ID, "Configuración…", true, Some("CmdOrCtrl+,"))?;
    #[cfg(target_os = "macos")]
    {
        // Extend Tauri's app submenu, preserving About, Services, Hide and Quit,
        // and all the other default Edit/Window/Help menu actions.
        if let Some(application) = menu.items()?.first().and_then(|item| item.as_submenu()) {
            application.insert(&settings, 2)?;
            application.insert(&tauri::menu::PredefinedMenuItem::separator(app)?, 3)?;
        } else {
            menu.append(&Submenu::with_items(app, "Jauria", true, &[&settings])?)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    menu.append(&Submenu::with_items(app, "Configuración", true, &[&settings])?)?;
    Ok(menu)
}
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_dialog::init()).manage(Bridge::default())
        .menu(application_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == SETTINGS_MENU_ID {
                let _ = app.emit("open-settings", ());
            }
        })
        .invoke_handler(tauri::generate_handler![connect_runner, runner_request, pulso_request, confirm_codex_permission, restart_runner, preview_diagnostic, export_diagnostic, confirm_history, select_directory, home_directory, release_session, probe_tools, record_ui_evidence, quit_ui])
        .run(tauri::generate_context!()).expect("No se pudo iniciar la interfaz Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_bridge_has_strict_fields_and_integer_limits() {
        assert!(validate("get_settings", &json!({})).is_ok());
        for args in [json!({"path":"/tmp"}), json!({"maxConcurrentSessions":2}), json!(null), json!([])] {
            assert!(validate("get_settings", &args).is_err());
        }
        for limit in [1, 2, 8] {
            assert!(validate("set_settings", &json!({"maxConcurrentSessions":limit})).is_ok());
        }
        for value in [json!(0), json!(9), json!(-1), json!(2.5), json!(2.0), json!("2"), json!(true), json!(null)] {
            assert!(validate("set_settings", &json!({"maxConcurrentSessions":value})).is_err());
        }
        assert!(validate("set_settings", &json!({})).is_err());
        assert!(validate("set_settings", &json!({"maxConcurrentSessions":2,"force":true})).is_err());
    }
    #[test]
    fn rename_bridge_requires_bounded_nonempty_title_without_controls() {
        for title in [" Nuevo título ".to_owned(), "x".repeat(120), "🦊".repeat(120), format!(" {} ", "🦊".repeat(120))] {
            assert!(validate("rename_session", &json!({"id":"session-1","title":title})).is_ok());
        }
        for title in [json!(""), json!(" \u{2003} "), json!("x".repeat(121)), json!("🦊".repeat(121)),
            json!("bad\nname"), json!("\tname"), json!("name\r"), json!("bad\u{7f}name"),
            json!("bad\u{85}name"), json!("bad\0name"), json!(null), json!(42)] {
            assert!(validate("rename_session", &json!({"id":"session-1","title":title})).is_err());
        }
        for args in [json!({"title":"Name"}), json!({"id":"session-1"}),
            json!({"id":"../escape","title":"Name"}), json!({"id":"session-1","title":"Name","cwd":"/tmp"})] {
            assert!(validate("rename_session", &args).is_err());
        }
    }
    fn start_args(kind: &str) -> Value {
        json!({"id":"session-123","title":"Prueba","kind":kind,"rows":24,"cols":80})
    }
    #[test]
    fn native_live_rpc_bounds_and_capabilities_are_explicit() {
        assert!(validate("terminal_live",&json!({"id":"native","after":0,"limit":64})).is_ok());
        for args in [json!({"id":"native","after":-1,"limit":64}),json!({"id":"native","after":0,"limit":65}),json!({"id":"native","after":0,"limit":0}),json!({"id":"native","after":0,"limit":64,"path":"/tmp"})] {
            assert!(validate("terminal_live",&args).is_err());
        }
    }

    #[test]
    fn interactive_requires_canonical_directory() {
        let cwd = fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
        for kind in ["codex", "claude", "terminal"] {
            let mut args = start_args(kind);
            assert!(validate("start", &args).is_err());
            for invalid in [json!(null), json!(12), json!("relative"), json!(cwd.join("Cargo.toml")), json!(cwd.join("src/..")), json!(cwd.join("missing-directory"))] {
                args["cwd"] = invalid;
                assert!(validate("start", &args).is_err());
            }
            args["cwd"] = json!(cwd);
            assert!(validate("start", &args).is_ok());
        }
    }
    #[test]
    fn legacy_starts_remain_valid_and_no_launch_flags_exposed() {
        for kind in ["fixture", "shell", "claude_probe", "codex_probe"] {
            assert!(validate("start", &start_args(kind)).is_ok());
        }
        let mut args = start_args("fixture");
        args["command"] = json!("ignored");
        assert!(validate("start", &args).is_err());
        assert!(validate("shutdown", &json!({})).is_err());
    }
}

#[cfg(test)]mod metrics_contract_tests {
    use super::*;
    #[test]fn smoke_metrics_accept_current_frontend_and_reject_unbounded_or_extra_fields(){
        let valid=json!({"streamMetrics":{"pages":0,"lastPageMs":0,"lastParseMs":0,"lastTransferMs":0,"lastYieldMs":0,"maxParseMs":0,"maxYieldMs":0,"visibility":"unknown","pageBytes":0}});
        assert!(validate_stream_metrics(&valid).is_ok());assert!(validate_stream_metrics(&json!({})).is_ok());
        for bad in [json!({"streamMetrics":{"extra":"private"}}),json!({"streamMetrics":{"visibility":"else"}}),json!({"streamMetrics":{"lastYieldMs":-1}}),json!({"streamMetrics":{"pages":1e30}})]{assert!(validate_stream_metrics(&bad).is_err());}
    }
}

#[cfg(test)]
mod pulso_board_bridge_tests {
    use super::*;

    #[test]
    fn accepts_bounded_kanban_reads_and_legacy_items() {
        assert!(validate_pulso("items", &json!({"projectId":null,"limit":50,"cursor":20})).is_ok());
        for status in ["todo", "doing", "waiting", "done"] {
            assert!(validate_pulso("items", &json!({"status":status,"expectedSnapshotRevision":0})).is_ok());
        }
        for project in [json!(null), json!("project_1.2-3")] {
            assert!(validate_pulso("board", &json!({"projectId":project})).is_ok());
            assert!(validate_pulso("board", &json!({"projectId":project,"ifRevision":u64::MAX})).is_ok());
        }
    }

    #[test]
    fn rejects_invalid_kanban_fields_types_and_states() {
        for value in [json!(null), json!(true), json!("1"), json!(-1), json!(1.0), json!({}), json!([])] {
            assert!(validate_pulso("items", &json!({"expectedSnapshotRevision":value})).is_err());
            assert!(validate_pulso("board", &json!({"projectId":null,"ifRevision":value})).is_err());
        }
        for value in [json!(null), json!(1), json!(true), json!("unknown"), json!("TODO"), json!("")] {
            assert!(validate_pulso("items", &json!({"status":value})).is_err());
        }
        for args in [json!({}), json!({"projectId":1}), json!({"projectId":"../bad"}),
            json!({"projectId":null,"status":"todo"}), json!({"projectId":null,"limit":50})] {
            assert!(validate_pulso("board", &args).is_err());
        }
        assert!(validate_pulso("projects", &json!({"status":"todo"})).is_err());
        assert!(validate_pulso("projects", &json!({"expectedSnapshotRevision":0})).is_err());
        assert!(validate_pulso("items", &json!({"status":"todo","extra":true})).is_err());
    }

    #[test]
    fn sidebar_summary_accepts_only_an_optional_unsigned_if_revision() {
        assert!(validate_pulso("sidebar_summary", &json!({})).is_ok());
        for revision in [0, 7, u64::MAX] {
            assert!(validate_pulso("sidebar_summary", &json!({"ifRevision":revision})).is_ok());
        }
        for value in [json!(null), json!(true), json!("1"), json!(-1), json!(1.0), json!({}), json!([])] {
            assert!(validate_pulso("sidebar_summary", &json!({"ifRevision":value})).is_err());
        }
        for args in [json!({"projectId":null}), json!({"limit":50}), json!({"ifRevision":1,"extra":true}), json!([])] {
            assert!(validate_pulso("sidebar_summary", &args).is_err());
        }
        // The runner status RPC stays argument-free through the bridge.
        assert!(validate("status", &json!({"pulsoRevision":1})).is_err());
    }
}

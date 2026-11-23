//! Admission and durable intent for owned app-server connections.
use super::*;
use crate::{codex_store as ledger,codex_runtime::{self,Control,Intent}};

impl Runner {
    pub(super) fn codex_request(self:&Arc<Self>,op:&str,args:&Value)->Result<Value>{
        let id=args["id"].as_str().context("Falta sesión")?;validate_id(id)?;
        if op=="codex_state" {let jobs=self.codex_jobs.lock().unwrap();let db=self.db.lock().unwrap();let mut result=ledger::summary(&db.0,id)?;let session=db.session(id)?.context("Sesión desconocida")?;result["acceptingTurns"]=json!(result["status"]=="idle" && jobs.get(id).is_some_and(|job|job.control.generation==result["generation"].as_i64().unwrap_or(0) && !job.worker.is_finished() && !job.control.stop.load(Ordering::Acquire) && job.control.ready.load(Ordering::Acquire)));result["connectionStatus"]=session["status"].clone();result["connectionDetail"]=session["detail"].clone();return Ok(result);}
        if op=="codex_command" {
            let db=self.db.lock().unwrap();let cid=args["commandId"].as_str().context("Falta comando")?;
            let exists:bool=db.0.query_row("SELECT EXISTS(SELECT 1 FROM provider_commands WHERE id=?)",[cid],|r|r.get(0))?;
            let session=ledger::get_session(&db.0,id)?;
            if !exists{return Ok(json!({"observed":false,"shouldSend":false,"currentGeneration":session["generation"],"connectionStatus":db.session(id)?.context("Sesión desconocida")?["status"]}));}
            let input=json!({"commandId":args["commandId"],"sessionId":id,"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":args["generation"],"prompt":args["prompt"]});
            // Existing immutable command is verified by digest. This branch can
            // never create a missing command or authorize provider delivery.
            let command=ledger::start_turn(&db.0,&input)?;
            let turn=ledger::get_turn(&db.0,args["turnId"].as_str().context("Falta turno")?)?;
            return Ok(json!({"observed":true,"sessionId":id,"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":args["generation"],"shouldSend":false,"delivery":"recorded_without_resend","commandState":command["state"],"turnStatus":turn["status"],"nativeTurnId":turn["nativeTurnId"]}));
        }
        if op=="codex_request" {
            let request=ledger::get_request(&self.db.lock().unwrap().0,args["requestId"].as_str().context("Falta permiso")?)?;
            ensure!(request["sessionId"]==id,"El permiso pertenece a otra sesión");return Ok(request);
        }
        if matches!(op,"start_codex"|"codex_resume"){
            let _workspace=self.workspace_mutations.try_lock().map_err(|_|anyhow::anyhow!("Hay otra apertura de sesión en curso; consulta su estado"))?;
            ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
            if op=="codex_resume" {
                let current=ledger::get_session(&self.db.lock().unwrap().0,id)?;
                ensure!(current["generation"]==args["generation"],"La conexión cambió; consulta el estado antes de reconectar");
                let has_turn:bool=self.db.lock().unwrap().0.query_row("SELECT EXISTS(SELECT 1 FROM model_turns WHERE session_id=? AND native_turn_id IS NOT NULL)",[id],|r|r.get(0))?;
                ensure!(has_turn,"Esta conversación no tiene turnos nativos registrados para reanudar. Abre una sesión nueva; no se sustituye el hilo automáticamente.");
                if self.codex_jobs.lock().unwrap().get(id).is_some_and(|job|!job.worker.is_finished()) {
                    ensure!(current["status"]=="interrupted","Detén la conexión antes de reanudarla");
                    self.stop_codex(id,current["generation"].as_i64().context("Generación inválida")?)?;
                }
                let session=self.db.lock().unwrap().session(id)?.context("Sesión desconocida")?;
                ensure!(matches!(session["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")),"Inspecciona y libera la sesión incierta antes de reanudar");
                let _guard=self.mutations.lock().unwrap();
                return self.launch_codex(id,&session,Some(current["generation"].as_i64().context("Generación inválida")?));
            }
            let _guard=self.mutations.lock().unwrap();
            return self.launch_codex(id,args,None);
        }
        let _guard=self.mutations.lock().unwrap();
        ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
        if op=="codex_turn" {
            let input=json!({"commandId":args["commandId"],"sessionId":id,"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":args["generation"],"prompt":args["prompt"]});
            let cid=args["commandId"].as_str().context("Falta comando")?;
            let duplicate:bool=self.db.lock().unwrap().0.query_row("SELECT EXISTS(SELECT 1 FROM provider_commands WHERE id=?)",[cid],|r|r.get(0))?;
            if duplicate {
                let db=self.db.lock().unwrap();let command=ledger::start_turn(&db.0,&input)?;let turn=ledger::get_turn(&db.0,args["turnId"].as_str().context("Falta turno")?)?;
                return Ok(json!({"sessionId":id,"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":args["generation"],"shouldSend":false,"delivery":"recorded_without_resend","commandState":command["state"],"turnStatus":turn["status"],"nativeTurnId":turn["nativeTurnId"]}));
            }
            let control=self.codex_control(id,args["generation"].as_i64().context("Generación inválida")?)?;
            let mut db=self.db.lock().unwrap();db.ensure_capacity()?;
            ensure!(db.session(id)?.is_some_and(|s|s["status"]=="running"),"La conexión aún no está lista");
            ensure!(ledger::get_session(&db.0,id)?["status"]=="idle","La conversación no está disponible. Si se interrumpió, detén y reanuda la conexión antes de enviar otra instrucción.");
            ensure!(control.ready.compare_exchange(true,false,Ordering::AcqRel,Ordering::Acquire).is_ok(),"Codex aún confirma el turno anterior; espera su estado nativo");
            let claim=match ledger::start_turn(&db.0,&input){Ok(value)=>value["result"].clone(),Err(error)=>{if !control.stop.load(Ordering::Acquire){control.ready.store(true,Ordering::Release);}return Err(error);}};
            let event=json!({"method":"userPrompt","params":{"text":args["prompt"]},"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":args["generation"]});
            let logged=db.provider_event(id,&event);drop(db);
            if logged.is_err() || control.tx.try_send(Intent::Start{claim:claim.clone(),prompt:args["prompt"].as_str().context("Prompt inválido")?.to_owned(),command_id:cid.to_owned()}).is_err() {
                let db=self.db.lock().unwrap();let mut finish=claim.clone();finish.as_object_mut().unwrap().remove("shouldSend");finish["status"]=json!("failed");finish["nativeTurnId"]=Value::Null;
                ledger::finish_turn(&db.0,&finish)?;
                ledger::finish_command(&db.0,&json!({"commandId":cid,"result":{"delivery":"not_sent"}}))?;
                if !control.stop.load(Ordering::Acquire){control.ready.store(true,Ordering::Release);}
                bail!("El mensaje no se envió. El intento queda registrado; conserva el texto para una acción nueva.");
            }
            let mut result=claim;result["shouldSend"]=json!(false);result["delivery"]=json!("queued_once");return Ok(result);
        }
        let generation=args["generation"].as_i64().context("Generación inválida")?;
        let control=self.codex_control(id,generation)?;
        if op=="codex_interrupt" {
            let identity=json!({"sessionId":id,"turnId":args["turnId"],"attemptId":args["attemptId"],"generation":generation});
            let mut result=ledger::cancel_turn(&self.db.lock().unwrap().0,&identity)?;
            if result["shouldSend"]==true && control.tx.try_send(Intent::Interrupt{identity}).is_err(){control.stop.store(true,Ordering::Release);bail!("Interrupción sin confirmar; se solicita detener la conexión propia");}
            result["shouldSend"]=json!(false);return Ok(result);
        }
        ensure!(op=="codex_permission","Operación Codex desconocida");
        let db=self.db.lock().unwrap();let request=ledger::get_request(&db.0,args["requestId"].as_str().context("Falta permiso")?)?;
        ensure!(request["sessionId"]==id && request["generation"]==generation,"Permiso de otra conexión");
        let decision=args["decision"].as_str().context("Decisión inválida")?;
        if decision=="accept" {
            ensure!(args["nativeConfirmed"]==true,"La aprobación requiere confirmación nativa");
            let incoming=crate::codex_protocol::Incoming::Request{id:match &request["nativeRpcId"]{Value::String(s)=>crate::codex_protocol::RpcId::String(s.clone()),v=>crate::codex_protocol::RpcId::Number(v.as_u64().context("ID nativo inválido")?)},method:request["method"].as_str().context("Método inválido")?.to_owned(),params:request["payload"]["params"].clone()};
            let approval=crate::codex_protocol::parse_approval(&incoming)?;
            crate::codex_protocol::command_accept_reply(&approval,approval.scope().context("Alcance no compatible")?)?;
        }
        let identity=json!({"id":request["id"],"sessionId":id,"turnId":request["turnId"],"attemptId":request["attemptId"],"generation":generation,"nativeRpcId":request["nativeRpcId"],"decision":decision});
        let mut result=ledger::answer_permission(&db.0,&identity)?;drop(db);
        if result["shouldSend"]==true && control.tx.try_send(Intent::Permission{request,decision:decision.to_owned()}).is_err(){control.stop.store(true,Ordering::Release);bail!("Respuesta sin confirmar; la aprobación no se reenvía");}
        result["shouldSend"]=json!(false);Ok(result)
    }

    fn codex_control(&self,id:&str,generation:i64)->Result<Control>{
        let jobs=self.codex_jobs.lock().unwrap();let job=jobs.get(id).context("La conexión no está bajo custodia de este runner; no se reenvía la instrucción")?;
        ensure!(!job.worker.is_finished() && job.control.generation==generation && !job.control.stop.load(Ordering::Acquire),"La conexión cambió o se está cerrando");
        Ok(Control{stop:job.control.stop.clone(),ready:job.control.ready.clone(),tx:job.control.tx.clone(),generation,attention:job.control.attention.clone()})
    }
    pub(super) fn stop_codex(&self,id:&str,generation:i64)->Result<Value>{
        {
            let _guard=self.mutations.lock().unwrap();
            let jobs=self.codex_jobs.lock().unwrap();
            let stored=self.db.lock().unwrap().session(id)?.context("Sesión desconocida")?;
            ensure!(stored["codex"]["generation"]==generation,"La conexión cambió; la detención no se aplica a otra generación");
            if let Some(pulso)=&self.pulso {let _=pulso.revoke_session(id);}
            if let Some(job)=jobs.get(id){ensure!(job.control.generation==generation,"La conexión cambió");job.control.ready.store(false,Ordering::Release);job.control.stop.store(true,Ordering::Release);}
            else {ensure!(matches!(stored["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released")),"Sesión sin custodia; no se envían señales");return Ok(stored);}
        }
        let until=Instant::now()+Duration::from_secs(10);
        loop {
            let jobs=self.codex_jobs.lock().unwrap();
            if let Some(job)=jobs.get(id){ensure!(job.control.generation==generation,"La conexión cambió tras la solicitud; consulta el estado actual");}
            let worker_done=jobs.get(id).is_some_and(|job|job.worker.is_finished());
            let stored=self.db.lock().unwrap().session(id)?.context("Sesión desconocida")?;
            ensure!(stored["codex"]["generation"]==generation,"La conexión cambió tras la solicitud; consulta el estado actual");
            if worker_done || !matches!(stored["status"].as_str(),Some("starting"|"running")){return Ok(stored);}
            drop(jobs);
            ensure!(Instant::now()<until,"Detención solicitada; espera y consulta el estado antes de liberar");thread::sleep(Duration::from_millis(10));
        }
    }
    /// Caller owns workspace -> mutations through registration, never execution.
    pub(super) fn launch_codex(self:&Arc<Self>,id:&str,args:&Value,resume:Option<i64>)->Result<Value>{
        ensure!(!self.quitting.load(Ordering::Acquire),"runner is shutting down");
        if resume.is_none(){if let Some(old)=self.db.lock().unwrap().session(id)?{ensure!(old["kind"]=="codex" && old["transport"]=="app-server" && old["title"]==args["title"] && old["cwd"]==args["cwd"],"El ID tiene otro contenido");return Ok(old);}}
        let cwd=fs::canonicalize(args["cwd"].as_str().context("Selecciona una carpeta")?)?;
        ensure!(cwd.is_dir() && cwd.to_str()==args["cwd"].as_str(),"Selecciona una carpeta canónica existente");
        let workspace=workspace_for(&cwd)?;
        let db=self.db.lock().unwrap();let others=db.sessions_with_live(&self.terminal_streams.sessions())?.into_iter().filter(|s|s["id"]!=id).collect::<Vec<_>>();
        ensure_workspace_available(&workspace,&others)?;crate::legacy_tasks::ensure_no_live_verification(&db.0,&workspace)?;db.ensure_capacity()?;
        ensure!(occupied_slots(&others)<self.settings.limit(),"concurrency limit is {}",self.settings.limit());drop(db);
        let size=dimensions(args)?;let title=args["title"].as_str().context("Falta título")?;ensure!(title.len()<=512,"Título demasiado largo");
        let mut db=self.db.lock().unwrap();
        let attached=if resume.is_none(){
            db.insert_codex(&json!({"id":id,"kind":"codex","title":title,"status":"starting","pid":null,"rows":size.rows,"cols":size.cols,"cwd":cwd,"workspace":workspace}))?
        }else{
            db.restarting(id)?;
            match ledger::attach_session(&db.0,&json!({"sessionId":id,"expectedGeneration":resume.unwrap(),"nativeThreadId":null})){
                Ok(v)=>v,Err(e)=>{db.state(id,"failed",json!({"reason":"Structured connection admission failed before spawn"}))?;return Err(e);}
            }
        };
        let generation=attached["generation"].as_i64().context("Generación inválida")?;drop(db);
        let pulso_mcp=if self.settings.pulso_auto_access() {
            if let Some(service)=self.pulso.as_ref().filter(|service|service.available()) {
                let session=self.db.lock().unwrap().session(id)?.context("Sesión desconocida")?;
                let grant_result=if resume.is_some() {service.auto_grant_resume(&session)} else {service.auto_grant(&session)};
                if let Err(error)=grant_result {
                    self.db.lock().unwrap().state(id,"failed",json!({"reason":"No se pudo preparar Pulso para Codex"}))?;
                    return Err(error.context("No se pudo preparar Pulso para Codex"));
                }
                Some(crate::pulso_mcp_config::PulsoMcp::new(std::env::current_exe()?,self.data_dir.join("pulso-grants").join(format!("{id}.json")))?)
            }else{None}
        }else{None};
        let (control,rx)=codex_runtime::channel(generation);let worker_control=Control{stop:control.stop.clone(),ready:control.ready.clone(),tx:control.tx.clone(),generation,attention:Some(self.attention.clone())};let owner=self.clone();let sid=id.to_owned();
        let worker=thread::Builder::new().name("jauria-codex".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||codex_runtime::run(owner.db.clone(),owner.mutations.clone(),worker_control,rx,sid.clone(),cwd,pulso_mcp)));
            if let Some(pulso)=&owner.pulso {let _=pulso.revoke_session(&sid);}
            if !matches!(result,Ok(Ok(()))){
                let mut db=owner.db.lock().unwrap();
                if db.session(&sid).is_ok_and(|s|s.is_some_and(|s|!matches!(s["status"].as_str(),Some("exited"|"stopped"|"failed"|"interrupted"|"released"|"needs_attention")))){
                    if db.state(&sid,"needs_attention",json!({"reason":"Codex connection ended without confirmed completion; no prompt resend"})).is_err(){owner.quitting.store(true,Ordering::Release);}
                }
            }
        });
        let worker=match worker{Ok(worker)=>worker,Err(e)=>{self.db.lock().unwrap().state(id,"failed",json!({"reason":"Connection worker not started"}))?;return Err(e.into());}};
        self.codex_jobs.lock().unwrap().insert(id.to_owned(),CodexJob{control,worker});
        self.db.lock().unwrap().session(id)?.context("Sesión desconocida")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn first_submission_returns_root_identity_and_queue_rejection_settles_not_sent()->Result<()>{
        for full in [false,true]{
            let tmp=tempfile::tempdir_in("/tmp")?;fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
            let r=Arc::new(Runner::open(tmp.path().join("data"),tmp.path().join("sock"),tmp.path().join("token"))?);
            {let mut db=r.db.lock().unwrap();db.insert_codex(&json!({"id":"query","title":"query","kind":"codex","cwd":tmp.path(),"status":"running","rows":24,"cols":80}))?;ledger::bind_thread(&db.0,"query",1,"thread")?;}
            let (control,rx)=codex_runtime::channel(1);control.ready.store(true,Ordering::Release);
            if full{for _ in 0..32{control.tx.try_send(Intent::Interrupt{identity:Value::Null}).unwrap();}}
            let (tx,end)=std::sync::mpsc::channel();let worker=thread::spawn(move||{let _=end.recv();});
            r.codex_jobs.lock().unwrap().insert("query".into(),CodexJob{control:control.clone(),worker});
            let checked=(||->Result<()>{
                let result=r.codex_request("codex_turn",&json!({"id":"query","commandId":"c","turnId":"t","attemptId":"a","generation":1,"prompt":"fixture"}));
                if full{
                    assert!(result.unwrap_err().to_string().contains("no se envió"));assert!(control.ready.load(Ordering::Acquire));
                    let db=r.db.lock().unwrap();assert_eq!(ledger::get_session(&db.0,"query")?["status"],"idle");assert_eq!(ledger::get_command(&db.0,"c")?["result"]["delivery"],"not_sent");
                }else{
                    let result=result?;assert_eq!(result["sessionId"],"query");assert_eq!(result["turnId"],"t");assert_eq!(result["attemptId"],"a");assert_eq!(result["generation"],1);assert_eq!(result["shouldSend"],false);
                    assert!(matches!(rx.try_recv().unwrap(),Intent::Start{..}));
                }Ok(())
            })();tx.send(()).unwrap();r.codex_jobs.lock().unwrap().remove("query").unwrap().worker.join().unwrap();checked?;
        }Ok(())
    }
    #[test]fn interrupted_ledger_rejects_new_instruction_without_consuming_ready_or_claim()->Result<()>{
        let tmp=tempfile::tempdir_in("/tmp")?;fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let r=Arc::new(Runner::open(tmp.path().join("data"),tmp.path().join("sock"),tmp.path().join("token"))?);
        {let mut db=r.db.lock().unwrap();db.insert_codex(&json!({"id":"query","title":"query","kind":"codex","cwd":tmp.path(),"status":"running","rows":24,"cols":80}))?;
        ledger::bind_thread(&db.0,"query",1,"native-thread")?;
        let claim=ledger::start_turn(&db.0,&json!({"sessionId":"query","commandId":"first","turnId":"first-turn","attemptId":"first-attempt","generation":1,"prompt":"first"}))?;
        let mut end=claim["result"].clone();end["status"]=json!("interrupted");end["nativeTurnId"]=json!("native-turn");ledger::finish_turn(&db.0,&end)?;}
        let (control,_rx)=codex_runtime::channel(1);control.ready.store(true,Ordering::Release);
        let (tx,rx)=std::sync::mpsc::channel();let worker=thread::spawn(move||{let _=rx.recv();});
        r.codex_jobs.lock().unwrap().insert("query".into(),CodexJob{control:control.clone(),worker});
        let result=(||->Result<()>{
            assert_eq!(r.codex_request("codex_state",&json!({"id":"query"}))?["acceptingTurns"],false);
            let error=r.codex_request("codex_turn",&json!({"id":"query","commandId":"second","turnId":"second-turn","attemptId":"second-attempt","generation":1,"prompt":"must not send"})).unwrap_err();
            assert!(error.to_string().contains("detén y reanuda"));assert!(control.ready.load(Ordering::Acquire));
            assert_eq!(r.db.lock().unwrap().0.query_row("SELECT count(*) FROM provider_commands",[],|row|row.get::<_,i64>(0))?,1);Ok(())
        })();tx.send(()).unwrap();r.codex_jobs.lock().unwrap().remove("query").unwrap().worker.join().unwrap();result
    }
    #[test]fn querying_an_unobserved_command_has_no_start_or_ledger_effect()->Result<()>{
        let tmp=tempfile::tempdir_in("/tmp")?;fs::set_permissions(tmp.path(),fs::Permissions::from_mode(0o700))?;
        let r=Arc::new(Runner::open(tmp.path().join("data"),tmp.path().join("sock"),tmp.path().join("token"))?);
        r.db.lock().unwrap().insert_codex(&json!({"id":"query","title":"query","kind":"codex","cwd":tmp.path(),"status":"starting","rows":24,"cols":80}))?;
        let args=json!({"id":"query","commandId":"command","turnId":"turn","attemptId":"attempt","generation":1,"prompt":"must never be sent"});
        for _ in 0..2 {let result=r.codex_request("codex_command",&args)?;assert_eq!(result["observed"],false);assert_eq!(result["shouldSend"],false);}
        let db=r.db.lock().unwrap();for table in ["provider_commands","model_turns","model_attempts"]{
            let count:i64=db.0.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get(0))?;assert_eq!(count,0);
        }
        assert!(r.codex_jobs.lock().unwrap().is_empty());Ok(())
    }
}

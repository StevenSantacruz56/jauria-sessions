//! Owned stdio transport, with no model, permission, retry or persistence policy.
//! Each instance owns a newly spawned Unix session. WNOWAIT keeps its leader
//! pinned through final group signals and read-only inventory, then finally reaps.
//! Never reconstruct this object from a stored PID. Another SID can escape;
//! cleanup is not a sandbox or a guarantee against escaped descendants.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{io::{self, Read, Write}, os::{fd::AsRawFd, unix::process::CommandExt},
    path::Path, process::{ChildStdin, ChildStdout, Command, Stdio}, time::{Duration, Instant}};
use crate::process_custody::{Owned, identity, tool_path, survivors};
use crate::codex_protocol::{Incoming,parse_line};

const LINE_LIMIT:usize=1024*1024;
const WRITE_LIMIT:usize=256*1024;

fn nonblocking(fd:i32)->Result<()> {
    let flags=unsafe{libc::fcntl(fd,libc::F_GETFL)};
    ensure!(flags>=0 && unsafe{libc::fcntl(fd,libc::F_SETFL,flags|libc::O_NONBLOCK)}>=0,"Cannot configure provider pipe");Ok(())
}

pub struct Process {
    owner:Owned,
    input:ChildStdin,
    output:ChildStdout,
    buffered:Vec<u8>,
    eof:bool,
    closed:Option<Value>,
}
impl Process {
    /// No shell initialization, inherited API keys or shared daemon. Native HOME
    /// remains available to the provider's own login implementation.
    pub fn codex(cwd:&Path)->Result<Self>{Self::codex_with_disabled_mcp(cwd,&[])}
    pub fn codex_with_disabled_mcp(cwd:&Path,servers:&[String])->Result<Self>{
        Self::codex_with_pulso(cwd,servers,None)
    }
    pub fn codex_with_pulso(cwd:&Path,servers:&[String],pulso:Option<&crate::pulso_mcp_config::PulsoMcp>)->Result<Self>{
        ensure!(servers.len()<=64,"Too many configured MCP servers for this adapter");
        let (home,user)=identity()?;
        let mut command=Command::new("/opt/homebrew/bin/codex");
        command.args(["--disable","daemon_auto_start","--disable","apps","--disable","plugins","--disable","hooks","--disable","skill_mcp_dependency_install","app-server","--stdio"])
            .env_clear().env("HOME",&home).env("USER",&user).env("LOGNAME",&user)
            .env("PATH",tool_path(&home)?).env("LANG","C").env("TERM","dumb");
        for name in servers {
            // This CLI's dotted override parser rejects quoted TOML key segments.
            // Never silently leave an inherited server enabled for odd names.
            ensure!(!name.is_empty() && name.len()<=256 && name.bytes().all(|b|b.is_ascii_alphanumeric() || b"_-".contains(&b)),"Unsupported MCP name for CLI override syntax");
            if name!="jauria-pulso" || pulso.is_none() {
                command.arg("-c").arg(format!("mcp_servers.{name}.enabled=false"));
            }
        }
        if let Some(pulso)=pulso {for override_value in pulso.codex_overrides()? {command.arg("-c").arg(override_value);}}
        Self::spawn(command,cwd)
    }
    fn spawn(mut command:Command,cwd:&Path)->Result<Self>{
        ensure!(cwd.is_absolute() && cwd.is_dir(),"Provider directory unavailable");
        command.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        unsafe{command.pre_exec(||{if libc::setsid()<0 {return Err(io::Error::last_os_error());}Ok(())});}
        let mut owner=Owned::new_session(command.spawn().context("Cannot start provider; no automatic retry")?);
        let input=owner.child.stdin.take().context("Provider stdin unavailable")?;
        let output=owner.child.stdout.take().context("Provider stdout unavailable")?;
        nonblocking(input.as_raw_fd())?;nonblocking(output.as_raw_fd())?;
        Ok(Self{owner,input,output,buffered:Vec::new(),eof:false,closed:None})
    }
    pub fn installed_version()->Result<String>{Self::version_controlled(None)}
    pub fn installed_version_with_control(gate:&std::sync::Mutex<()>,stop:&std::sync::atomic::AtomicBool)->Result<String>{Self::version_controlled(Some((gate,stop)))}
    fn version_controlled(control:Option<(&std::sync::Mutex<()>,&std::sync::atomic::AtomicBool)>)->Result<String>{
        let (home,user)=identity()?;let mut command=Command::new("/opt/homebrew/bin/codex");
        command.arg("--version").env_clear().env("HOME",&home).env("USER",&user).env("PATH",tool_path(&home)?).env("LANG","C");
        let mut process={
            let _guard=control.map(|(gate,_)|gate.lock().map_err(|_|anyhow::anyhow!("Version launch gate unavailable"))).transpose()?;
            ensure!(!control.is_some_and(|(_,stop)|stop.load(std::sync::atomic::Ordering::Acquire)),"Version probe cancelled before launch");
            Self::spawn(command,Path::new("/private/tmp"))?
        };
        let end=Instant::now()+Duration::from_secs(3);let mut bytes=Vec::new();let mut buf=[0u8;256];
        let collected=(||->Result<()> {loop{
            ensure!(Instant::now()<end,"Codex version probe timed out");
            match process.output.read(&mut buf){
                Ok(0)=>return Ok(()),Ok(n)=>{bytes.extend_from_slice(&buf[..n]);ensure!(bytes.len()<=1024,"Codex version output exceeds limit");},
                Err(error) if error.kind()==io::ErrorKind::Interrupted=>(),
                Err(error) if error.kind()==io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(2)),
                Err(_)=>bail!("Codex version output unavailable"),
            }
        }})();
        let result=process.close();collected?;
        ensure!(result["waitConfirmed"]==true && result["exitCode"]==0,"Codex version process did not exit cleanly");
        let text=std::str::from_utf8(&bytes)?.trim();
        let version=text.strip_prefix("codex-cli ").context("Unsupported Codex version format")?;
        ensure!(version.len()<=32 && version.bytes().all(|b|b.is_ascii_digit()||b==b'.'),"Unsupported Codex version format");
        Ok(version.to_owned())
    }
    pub fn pid(&self)->u32{self.owner.pid() as u32}
    pub fn send(&mut self,value:&Value)->Result<()> {
        ensure!(self.closed.is_none(),"Provider connection is closed");
        let mut data=serde_json::to_vec(value)?;data.push(b'\n');self.send_packet(&data)
    }
    pub fn send_packet(&mut self,data:&[u8])->Result<()> {
        ensure!(self.closed.is_none(),"Provider connection is closed");
        ensure!(data.len()<=WRITE_LIMIT && data.ends_with(b"\n") && !data[..data.len()-1].contains(&b'\n'),"Invalid provider frame or request exceeds 256 KiB");
        let until=Instant::now()+Duration::from_secs(1);let mut offset=0;
        while offset<data.len(){
            match self.input.write(&data[offset..]){
                Ok(0)=>bail!("Provider pipe closed after partial/uncertain delivery; no resend"),
                Ok(n)=>offset+=n,
                Err(e) if e.kind()==io::ErrorKind::Interrupted=>(),
                Err(e) if e.kind()==io::ErrorKind::WouldBlock && Instant::now()<until=>std::thread::sleep(Duration::from_millis(2)),
                Err(_)=>bail!("Provider delivery unconfirmed; no resend"),
            }
            ensure!(offset==data.len() || Instant::now()<until,"Provider write deadline; delivery unconfirmed, no resend");
        }
        Ok(())
    }
    /// Returns at most one complete JSON frame without waiting. No credential
    /// redaction is promised: callers must select fields before persistence/UI.
    pub fn receive(&mut self)->Result<Option<Incoming>> {
        ensure!(self.closed.is_none(),"Provider connection is closed");
        loop {
            if let Some(end)=self.buffered.iter().position(|b|*b==b'\n') {
                ensure!(end<=LINE_LIMIT,"Provider frame exceeds 1 MiB");
                let line=self.buffered.drain(..=end).collect::<Vec<_>>();
                if line.iter().all(u8::is_ascii_whitespace){continue;}
                return Ok(Some(parse_line(&line).context("Malformed or unsupported provider frame")?));
            }
            ensure!(self.buffered.len()<=LINE_LIMIT,"Provider frame exceeds 1 MiB");
            if self.eof {
                ensure!(self.buffered.is_empty(),"Provider closed with an incomplete frame");
                bail!("Provider stdout closed");
            }
            let mut chunk=[0u8;8192];
            match self.output.read(&mut chunk){
                Ok(0)=>self.eof=true,
                Ok(n)=>self.buffered.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind()==io::ErrorKind::Interrupted=>(),
                Err(e) if e.kind()==io::ErrorKind::WouldBlock=>return Ok(None),
                Err(_)=>bail!("Provider stdout unavailable"),
            }
        }
    }
    pub fn leader_exited(&mut self)->Result<bool>{Ok(self.owner.exited()?)}
    /// Called after normal tail draining, on explicit stop, or after a protocol
    /// fault. It never signals discovered PIDs. Safe to repeat after final wait.
    pub fn close(&mut self)->Value {
        self.close_with_signals(|owner,signal|owner.signal(signal))
    }
    fn close_with_signals(&mut self,mut signal:impl FnMut(&mut Owned,i32)->io::Result<()>)->Value {
        if let Some(result)=&self.closed{return result.clone();}
        let mut uncertain=false;let mut reasons=Vec::<&str>::new();let mut signal_warnings=Vec::<&str>::new();
        // Signal delivery is advisory: a naturally exiting child can reject
        // TERM on Darwin before WNOWAIT reports exit. Final pinned-leader and
        // SID quiescence evidence, plus wait, determine custody confirmation.
        if signal(&mut self.owner,libc::SIGTERM).is_err(){signal_warnings.push("group_term_unconfirmed");}
        let grace=Instant::now()+Duration::from_millis(100);
        while Instant::now()<grace {self.discard();std::thread::sleep(Duration::from_millis(2));}
        if signal(&mut self.owner,libc::SIGKILL).is_err(){signal_warnings.push("group_kill_unconfirmed");}
        let until=Instant::now()+Duration::from_millis(500);
        loop {
            self.discard();
            match (self.owner.exited(),survivors(self.owner.pid())){
                (Ok(true),Ok(live)) if live.is_empty()=>break,
                (Err(_),_)=>{uncertain=true;reasons.push("wait_identity_unavailable");break;},
                (_,Err(_))=>{uncertain=true;reasons.push("sid_inventory_unavailable");break;},
                _ if Instant::now()>=until=>{uncertain=true;reasons.push("group_cleanup_timeout");break;},
                _=>std::thread::sleep(Duration::from_millis(5)),
            }
        }
        // An uninterruptible OS wait may exceed the cooperative cleanup budget.
        // Never release PID ownership before the last group signal/inventory.
        let waited=self.owner.wait();
        if waited.is_err(){uncertain=true;reasons.push("final_wait_unconfirmed");}
        let value=json!({"status":if uncertain{"needs_attention"}else{"exited"},"exitCode":waited.ok().and_then(|s|s.code()),"waitConfirmed":!uncertain,"reasons":reasons,"signalWarnings":signal_warnings,"scope":"owned group; SID escapes are not contained"});
        self.closed=Some(value.clone());value
    }
    fn discard(&mut self){
        // Cleanup does not fabricate complete turn evidence from unread tails.
        self.buffered.clear();let mut data=[0u8;8192];
        for _ in 0..32{match self.output.read(&mut data){Ok(0)=>{self.eof=true;break;},Ok(_)=>(),Err(e)if e.kind()==io::ErrorKind::Interrupted=>(),Err(_)=>break}}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(source:&str)->(tempfile::TempDir,Process){
        let dir=tempfile::tempdir().unwrap();let script=dir.path().join("provider.py");std::fs::write(&script,source).unwrap();
        let mut command=Command::new("/usr/bin/python3");command.env_clear().env("PATH","/usr/bin:/bin").arg("-I").arg(&script);
        let process=Process::spawn(command,dir.path()).unwrap();(dir,process)
    }
    fn frame(p:&mut Process)->Result<Value>{let until=Instant::now()+Duration::from_secs(3);loop{if let Some(Incoming::Response{result,..})=p.receive()?{return Ok(result);}ensure!(Instant::now()<until,"Fixture frame timeout");std::thread::sleep(Duration::from_millis(2));}}
    #[test]fn provider_not_reading_stdin_reaches_write_deadline_and_is_reaped(){
        let (_dir,mut p)=fixture("import time\ntime.sleep(10)\n");
        let mut bytes=vec![b'x';WRITE_LIMIT-1];bytes.push(b'\n');let start=Instant::now();
        assert!(p.send_packet(&bytes).is_err());assert!(start.elapsed()<Duration::from_secs(3));
        assert_eq!(p.close()["waitConfirmed"],true);
    }
    #[test]fn signal_warning_is_superseded_only_by_final_owned_quiescence_and_wait(){
        let (_dir,mut p)=fixture("print('ready',flush=True)\n");
        let receipt=p.close_with_signals(|owner,signal|if signal==libc::SIGTERM{Err(io::Error::from_raw_os_error(libc::EPERM))}else{owner.signal(signal)});
        assert_eq!(receipt["waitConfirmed"],true,"{receipt}");assert!(receipt["signalWarnings"].as_array().unwrap().contains(&json!("group_term_unconfirmed")));assert_eq!(receipt["reasons"],json!([]));
    }
    #[test]fn unsuccessful_signals_without_timely_quiescence_remain_uncertain(){
        let (_dir,mut p)=fixture("import time\ntime.sleep(1)\n");
        let receipt=p.close_with_signals(|_,_|Err(io::Error::from_raw_os_error(libc::EPERM)));
        assert_eq!(receipt["waitConfirmed"],false,"{receipt}");assert!(receipt["reasons"].as_array().unwrap().contains(&json!("group_cleanup_timeout")));
    }
    #[test]fn reaped_leader_never_regains_signal_authority_or_confirmation(){
        let (_dir,mut p)=fixture("pass\n");p.owner.wait().unwrap();
        assert_eq!(p.owner.exited().unwrap_err().to_string(),"leader no longer pinned");
        let receipt=p.close();assert_eq!(receipt["waitConfirmed"],false,"{receipt}");assert!(receipt["reasons"].as_array().unwrap().contains(&json!("wait_identity_unavailable")));
    }
    #[test]fn utf8_frames_roundtrip_and_explicit_reap(){
        let (_dir,mut p)=fixture("import sys,json\nfor line in sys.stdin:\n print(json.dumps({'id':1,'result':json.loads(line)},ensure_ascii=False),flush=True)\n");
        let pid=p.pid();p.send(&json!({"id":1,"text":"á 🐺"})).unwrap();assert_eq!(frame(&mut p).unwrap()["text"],"á 🐺");
        let result=p.close();assert_eq!(result["waitConfirmed"],true);assert_eq!(p.close(),result);
        assert!(p.send(&json!({"id":2})).is_err());let mut status=0;assert_eq!(unsafe{libc::waitpid(pid as _,&mut status,libc::WNOHANG)},-1);assert_eq!(io::Error::last_os_error().raw_os_error(),Some(libc::ECHILD));
    }
    #[test]fn oversized_and_incomplete_frames_fail_before_persisting(){
        for source in ["import sys,time\nsys.stdout.write('x'*1100000);sys.stdout.flush();time.sleep(2)\n","import sys\nsys.stdout.write('{');sys.stdout.flush()\n"]{
            let (_dir,mut p)=fixture(source);assert!(frame(&mut p).is_err());p.close();
        }
    }
    #[test]fn output_burst_is_parsed_as_separate_frames(){
        let (_dir,mut p)=fixture("import json\nfor i in range(300): print(json.dumps({'id':i,'result':{'index':i}}),flush=True)\n");
        for i in 0..300{assert_eq!(frame(&mut p).unwrap()["index"],i);}
        let receipt=p.close();assert_eq!(receipt["waitConfirmed"],true,"{receipt}");
    }
    #[test]fn closure_cleans_same_group_child_after_leader_exit(){
        let (dir,mut p)=fixture("import subprocess,sys,json\np=subprocess.Popen(['/bin/sleep','3'])\nprint(json.dumps({'id':1,'result':{'child':p.pid}}),flush=True)\n");
        let child=frame(&mut p).unwrap()["child"].as_i64().unwrap();
        let until=Instant::now()+Duration::from_secs(2);while !p.leader_exited().unwrap() && Instant::now()<until{std::thread::sleep(Duration::from_millis(2));}
        assert!(p.leader_exited().unwrap());let result=p.close();assert_eq!(result["waitConfirmed"],true,"{result}");
        // Read-only group inventory, not signalling a discovered child PID.
        assert!(survivors(p.pid() as _).unwrap().is_empty());assert!(child>0);drop(dir);
    }
}

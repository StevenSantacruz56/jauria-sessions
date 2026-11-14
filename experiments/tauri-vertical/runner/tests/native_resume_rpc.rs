//! Exact native identity without contacting a provider. Only our fake Claude runs.
use serde_json::{Value,json};
use std::{fs,io::{BufRead,BufReader,Write},os::unix::{fs::PermissionsExt,net::UnixStream},path::PathBuf,process::{Child,Command,Stdio},thread,time::{Duration,Instant}};
struct Fixture{root:tempfile::TempDir,child:Child}
impl Fixture {
 fn open()->Self{
  let root=tempfile::Builder::new().prefix("jnr-").tempdir_in("/tmp").unwrap();fs::set_permissions(root.path(),fs::Permissions::from_mode(0o700)).unwrap();
  let home=root.path().join("home");fs::create_dir_all(home.join(".local/bin")).unwrap();fs::create_dir(root.path().join("work")).unwrap();
  let cli=home.join(".local/bin/claude");
  fs::write(&cli,"#!/bin/sh\nprintf '%s\\n' BEGIN \"$@\" END >> \"$HOME/native-argv.log\"\nprintf 'FAKE_CLAUDE_READY\\n'\n/bin/cat\n").unwrap();fs::set_permissions(cli,fs::Permissions::from_mode(0o700)).unwrap();
  let child=Command::new(env!("CARGO_BIN_EXE_aw-runner")).args(["--data-dir"]).arg(root.path().join("data")).arg("--socket").arg(root.path().join("sock")).arg("--token-file").arg(root.path().join("token"))
    .env("HOME",&home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
  let mut f=Self{root,child};let end=Instant::now()+Duration::from_secs(8);
  while !f.root.path().join("sock").exists(){assert!(f.child.try_wait().unwrap().is_none());assert!(Instant::now()<end);thread::sleep(Duration::from_millis(10));} f
 }
 fn rpc(&self,op:&str,args:Value)->Value{
  let token=fs::read_to_string(self.root.path().join("token")).unwrap();let mut s=UnixStream::connect(self.root.path().join("sock")).unwrap();s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
  serde_json::to_writer(&mut s,&json!({"version":1,"token":token,"op":op,"args":args})).unwrap();s.write_all(b"\n").unwrap();let mut line=String::new();BufReader::new(s).read_line(&mut line).unwrap();serde_json::from_str(&line).unwrap()
 }
 fn ok(&self,op:&str,args:Value)->Value{let r=self.rpc(op,args);assert_eq!(r["ok"],true,"{op}: {}",r["error"]);r["result"].clone()}
 fn wait_args(&self,needle:&str)->String{let end=Instant::now()+Duration::from_secs(3);loop{let text=fs::read_to_string(self.root.path().join("home/native-argv.log")).unwrap_or_default();if text.contains(needle){return text;}assert!(Instant::now()<end);thread::sleep(Duration::from_millis(10));}}
}
impl Drop for Fixture{fn drop(&mut self){if self.child.try_wait().ok().flatten().is_none(){let _=self.rpc("shutdown",json!({}));let end=Instant::now()+Duration::from_secs(4);while self.child.try_wait().ok().flatten().is_none()&&Instant::now()<end{thread::sleep(Duration::from_millis(10));}let _=self.child.kill();}let _=self.child.wait();}}

#[test]fn exact_resume_preserves_identity_and_fences_non_git_conversation(){
 let f=Fixture::open();let cwd:PathBuf=f.root.path().join("work");
 f.ok("start",json!({"id":"original","title":"A synthetic plan","kind":"claude","cwd":cwd,"rows":24,"cols":80}));
 let binding=f.ok("native_binding",json!({"id":"original"}))["binding"].clone();let uuid=binding["conversationId"].as_str().unwrap();assert_eq!(binding["source"],"app_reserved");assert_eq!(uuid.len(),36);
 let initial=f.wait_args(uuid);assert!(initial.contains("--session-id\n"));assert!(!initial.contains("--resume\n"));
 // Outside Git, a second PTY still cannot own this exact native conversation.
 assert_eq!(f.rpc("resume_native",json!({"id":"duplicate","sourceId":"original","rows":24,"cols":80}))["ok"],false);
 f.ok("stop",json!({"id":"original"}));
 f.ok("resume_native",json!({"id":"continued","sourceId":"original","rows":24,"cols":80}));
 let args=f.wait_args("--resume\n");assert!(args.contains(&format!("--resume\n{uuid}\n")));assert!(!args.contains("--last"));assert!(!args.contains("bypass"));
 let continued=f.ok("native_binding",json!({"id":"continued"}))["binding"].clone();assert_eq!(continued["conversationId"],uuid);assert_eq!(continued["resumedFrom"],"original");
 let source=f.ok("native_binding",json!({"id":"original"}));assert_eq!(source["activeSessionId"],"continued");
 // A retry of the launch identity reuses the session rather than starting again.
 let retry=f.ok("resume_native",json!({"id":"continued","sourceId":"original","rows":24,"cols":80}));assert_eq!(retry["id"],"continued");
 assert_eq!(f.rpc("resume_native",json!({"id":"other","sourceId":"original","rows":24,"cols":80}))["ok"],false);
 f.ok("stop",json!({"id":"continued"}));
 assert!(f.ok("native_binding",json!({"id":"original"}))["activeSessionId"].is_null());
}

#[test]fn legacy_or_unknown_session_never_guesses_a_provider_conversation(){
 let f=Fixture::open();assert!(f.ok("native_binding",json!({"id":"unknown"}))["binding"].is_null());
 assert_eq!(f.rpc("resume_native",json!({"id":"new","sourceId":"unknown","rows":24,"cols":80}))["ok"],false);
 assert!(!f.root.path().join("home/native-argv.log").exists());
}

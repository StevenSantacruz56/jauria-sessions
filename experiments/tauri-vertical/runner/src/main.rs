use anyhow::{Context, Result, bail};
use std::{path::PathBuf, sync::Arc};

mod fixture;
mod runner;
mod storage;
mod terminal_stream;
mod agent_signals;
mod agent_attention;
mod app_settings;
mod rpc_contract;
mod legacy_tasks;
mod pulso;
mod pulso_client;
mod pulso_mcp;
mod pulso_mcp_config;
mod native_sessions;
mod provider_signals;

fn main() {
    if let Err(error) = run() {
        eprintln!("aw-runner: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|a| a == "--pulso-client") {
        return pulso_client::run(&args[1..]);
    }
    if args.first().is_some_and(|a| a == "--pulso-mcp") {
        anyhow::ensure!(args.len()==1,"--pulso-mcp no acepta argumentos");
        return pulso_mcp::run();
    }
    if args.first().is_some_and(|a| a == "--attention-hook") {
        // Provider hook (Claude Code, Codex notify): silent and always successful.
        provider_signals::hook(args.get(1).and_then(|a| a.to_str()));
        return Ok(());
    }
    if args.first().is_some_and(|a|a=="--quota-hook") {
        anyhow::ensure!(args.len()==3 && args[1]=="--data-dir","invalid quota callback arguments");
        return claude_quota::run(std::path::Path::new(&args[2]));
    }
    if args.first().is_some_and(|a| a == "--fixture-descendant") {
        if args.get(1).is_some_and(|a|a=="--own-group") {
            anyhow::ensure!(unsafe {libc::setpgid(0,0)}==0,"fixture setpgid failed");
        }
        unsafe {
            libc::signal(libc::SIGTERM,libc::SIG_IGN);
            libc::signal(libc::SIGHUP,libc::SIG_IGN);
        }
        println!("DESCENDANT_READY {}",std::process::id());
        // Self-expire even if an assertion aborts its disposable harness.
        for _ in 0..3000 {
            if std::path::Path::new("stop-descendant").exists() {return Ok(());}
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "--fixture") {
        let id = args.get(1).context("fixture requires id")?.to_str().context("invalid id")?;
        runner::validate_id(id)?;
        return fixture::run(id);
    }
    let mut data = None;
    let mut socket = None;
    let mut token = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let value = PathBuf::from(iter.next().context("missing option value")?);
        match arg.to_str() {
            Some("--data-dir") => data = Some(value),
            Some("--socket") => socket = Some(value),
            Some("--token-file") => token = Some(value),
            _ => bail!("unknown option"),
        }
    }
    unsafe { libc::umask(0o077); }
    let runner = Arc::new(runner::Runner::open(
        data.context("--data-dir required")?,
        socket.context("--socket required")?,
        token.context("--token-file required")?,
    )?);
    runner.serve()
}

mod resources;
mod quotas;

mod diagnostics;

mod claude_quota;

mod resource_tree;

mod process_custody;

mod codex_transport;

mod codex_protocol;

mod codex_store;

mod codex_runtime;

mod approval_text;

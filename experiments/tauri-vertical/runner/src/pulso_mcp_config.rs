//! Session-local MCP launch configuration. No token is placed in CLI arguments;
//! the private handle path identifies the Jauria-owned session to the server.
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::path::PathBuf;

#[derive(Clone)]
pub struct PulsoMcp {
    pub runner: PathBuf,
    pub handle: PathBuf,
}

impl PulsoMcp {
    pub fn new(runner: PathBuf, handle: PathBuf) -> Result<Self> {
        ensure!(runner.is_absolute() && handle.is_absolute(),"Pulso MCP requires absolute paths");
        Ok(Self { runner, handle })
    }

    pub fn claude_config(&self) -> String {
        json!({"mcpServers":{"jauria-pulso":{
            "command":self.runner,"args":["--pulso-mcp"],
            "env":{"JAURIA_PULSO_HANDLE":self.handle}
        }}}).to_string()
    }

    pub fn codex_overrides(&self) -> Result<Vec<String>> {
        let runner=self.runner.to_str().context("Non UTF-8 Pulso runner path")?;
        let handle=self.handle.to_str().context("Non UTF-8 Pulso handle path")?;
        Ok(vec![
            format!("mcp_servers.jauria-pulso.command={}",serde_json::to_string(runner)?),
            "mcp_servers.jauria-pulso.args=[\"--pulso-mcp\"]".into(),
            format!("mcp_servers.jauria-pulso.env.JAURIA_PULSO_HANDLE={}",serde_json::to_string(handle)?),
            "mcp_servers.jauria-pulso.env_vars=[]".into(),
            "mcp_servers.jauria-pulso.enabled=true".into(),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_exposes_only_the_private_handle_path() -> Result<()> {
        let mcp=PulsoMcp::new(PathBuf::from("/app/aw-runner"),PathBuf::from("/private/one.json"))?;
        let claude:serde_json::Value=serde_json::from_str(&mcp.claude_config())?;
        assert_eq!(claude["mcpServers"]["jauria-pulso"]["command"],"/app/aw-runner");
        assert_eq!(claude["mcpServers"]["jauria-pulso"]["env"]["JAURIA_PULSO_HANDLE"],"/private/one.json");
        assert!(!mcp.claude_config().contains("token"));
        assert_eq!(mcp.codex_overrides()?.len(),5);
        assert!(PulsoMcp::new(PathBuf::from("relative"),PathBuf::from("/private/one.json")).is_err());
        Ok(())
    }
}

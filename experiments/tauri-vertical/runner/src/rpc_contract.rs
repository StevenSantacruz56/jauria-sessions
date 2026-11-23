//! Argument allowlist of the runner socket protocol, in one place.
//!
//! The runner uses it in `Runner::request`. The desktop bridge includes this
//! file through `#[path]` only in its tests, to check that every payload the
//! app sends (`desktop/tests/fixtures/rpc-contract.json`) passes both the
//! bridge validation and this allowlist. Depends only on `serde_json`.
use serde_json::Value;

/// Keys each operation accepts; `None` means unknown operation.
pub fn allowed_args(op: &str) -> Option<&'static [&'static str]> {
    Some(match op {
        // workspaceAfter is still accepted, and ignored, so a 1.3.x app can
        // connect while this runner keeps serving its sessions.
        "status" => &["workspaceAfter"],
        "get_settings" => &[],
        "set_settings" => &["maxConcurrentSessions", "pulsoAutoAccess"],
        "rename_session" => &["id", "title"],
        "native_binding" => &["id"],
        "resume_native" => &["id", "sourceId", "rows", "cols"],
        "shutdown" | "diagnostic_preview" | "telemetry" | "refresh_quotas" => &[],
        "start_codex" => &["id", "title", "kind", "cwd", "rows", "cols"],
        "codex_state" => &["id"],
        "codex_request" => &["id", "requestId"],
        "codex_resume" => &["id", "generation"],
        "codex_turn" | "codex_command" => &["id", "commandId", "turnId", "attemptId", "generation", "prompt"],
        "codex_interrupt" => &["id", "turnId", "attemptId", "generation"],
        "codex_permission" => &["id", "requestId", "generation", "decision", "nativeConfirmed"],
        "start" => &["id", "title", "kind", "rows", "cols", "cwd"],
        "input" => &["id", "data"],
        "resize" => &["id", "rows", "cols"],
        "stop" => &["id", "generation"],
        "interrupt" => &["id"],
        "purge_history" | "compact_history" => &["id", "confirmed"],
        "release" => &["id", "confirmed", "generation"],
        "events" => &["after", "limit"],
        "terminal_live" => &["id", "after", "limit"],
        "mark_seen" => &["items"],
        _ => return None,
    })
}

/// `set_settings` values: an optional limit from 1 to 8 and an optional
/// boolean `pulsoAutoAccess` (settingsVersion 2).
pub fn settings_args(args: &Value) -> Result<(Option<u64>, Option<bool>), &'static str> {
    let limit = match args.get("maxConcurrentSessions") {
        None => None,
        Some(value) => Some(value.as_u64().filter(|n| (1..=8).contains(n)).ok_or("maxConcurrentSessions must be an integer from 1 to 8")?),
    };
    let auto = match args.get("pulsoAutoAccess") {
        None => None,
        Some(value) => Some(value.as_bool().ok_or("pulsoAutoAccess must be a boolean")?),
    };
    Ok((limit, auto))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn settings_args_are_optional_and_strict() {
        assert_eq!(settings_args(&json!({})), Ok((None, None)));
        assert_eq!(settings_args(&json!({"maxConcurrentSessions":8,"pulsoAutoAccess":false})), Ok((Some(8), Some(false))));
        for bad in [json!({"maxConcurrentSessions":0}), json!({"maxConcurrentSessions":"2"}), json!({"pulsoAutoAccess":1}), json!({"pulsoAutoAccess":null})] {
            assert!(settings_args(&bad).is_err(), "{bad}");
        }
        assert!(allowed_args("register_project").is_none());
        assert!(allowed_args("set_settings").unwrap().contains(&"pulsoAutoAccess"));
    }
}

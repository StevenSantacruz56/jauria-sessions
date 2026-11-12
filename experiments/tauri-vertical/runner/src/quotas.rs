//! On-demand subscription quotas. The caller owns caching/polling and should run
//! this blocking operation off its RPC/UI thread. No model sessions are started.
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const IO_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_BYTES: usize = 256 * 1024;
const MAX_LINE: usize = 64 * 1024;
const MAX_BUCKETS: usize = 32;
const CLAUDE_REASON: &str = "claude_statusline_observation_required";

/// Read current native Codex login quotas, without reading credential files,
/// forwarding API-key environment variables, or starting inference. Budgets:
/// 10 s for spawn/handshake/read, 500 ms for cleanup (under 12 s total under
/// normal OS scheduling). stdout is bounded; stderr is discarded, never logged.
/// Only the child created here is killed. No shared daemon is stopped.
pub fn read() -> Value {
    let codex = match std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        Some(home) => {
            let mut command = Command::new("/opt/homebrew/bin/codex");
            command.env_clear().env("HOME", &home)
                .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
                .current_dir(&home)
                .args(["app-server", "--stdio", "--disable", "daemon_auto_start",
                    "-c", "analytics.enabled=false"]);
            if let Some(user) = std::env::var_os("USER") {
                command.env("USER", user);
            }
            match collect(command, IO_TIMEOUT) {
                Ok(result) => parse_limits(&result, epoch_seconds()),
                Err(reason) => unavailable(reason),
            }
        }
        None => unavailable("home_unavailable"),
    };
    json!({"codex": codex, "claude": unavailable(CLAUDE_REASON)})
}

fn epoch_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn unavailable(reason: &str) -> Value {
    let explanation = match reason {
        CLAUDE_REASON => "Cuota de Claude aún no disponible. Claude informa la cuota tras la primera respuesta de una sesión nativa compatible. La captura de esos datos todavía no está integrada y no hay una consulta CLI independiente documentada.",
        "home_unavailable" => "No se encontró el directorio personal para usar el acceso nativo de Codex.",
        "no_observed_windows" => "Codex no entregó ventanas de cuota vigentes. No se estima el saldo restante.",
        "deadline_exceeded" => "La consulta de cuota de Codex agotó el tiempo de espera.",
        "spawn_failed" => "No se pudo iniciar la consulta local de cuota de Codex.",
        "rpc_error" => "Codex rechazó la consulta de cuota. Revisa el acceso nativo y su disponibilidad en Codex.",
        "output_limit_exceeded" | "line_limit_exceeded" | "too_many_buckets" => "La respuesta de cuota de Codex superó el tamaño permitido.",
        "invalid_quota_schema" | "invalid_rpc_json" | "invalid_rpc_response" | "unexpected_rpc_response" => "Codex devolvió un formato de cuota no compatible.",
        _ => "No se pudo completar la consulta local de cuota de Codex.",
    };
    json!({"status": "unavailable", "reasonCode": reason, "reason": explanation, "windows": []})
}

// Never propagate provider error messages, account identity, credits or tokens.
fn parse_limits(result: &Value, now: u64) -> Value {
    match windows(result, now) {
        Ok(windows) if !windows.is_empty() => json!({
            "status": "available", "source": "account/rateLimits/read",
            "observedAt": now, "windows": windows
        }),
        Ok(_) => unavailable("no_observed_windows"),
        Err(reason) => unavailable(reason),
    }
}

fn windows(result: &Value, now: u64) -> Result<Vec<Value>, &'static str> {
    let mut output = Vec::new();
    match result.get("rateLimitsByLimitId") {
        Some(Value::Object(buckets)) if !buckets.is_empty() => {
            if buckets.len() > MAX_BUCKETS { return Err("too_many_buckets"); }
            for (id, snapshot) in buckets {
                add_windows(&mut output, id, snapshot, now)?;
            }
        }
        None | Some(Value::Null) | Some(Value::Object(_)) => {
            let snapshot = result.get("rateLimits").ok_or("invalid_quota_schema")?;
            let id = match snapshot.get("limitId") {
                None | Some(Value::Null) => "codex",
                Some(value) => value.as_str().ok_or("invalid_quota_schema")?,
            };
            add_windows(&mut output, id, snapshot, now)?;
        }
        _ => return Err("invalid_quota_schema"),
    }
    Ok(output)
}

fn add_windows(out: &mut Vec<Value>, id: &str, snapshot: &Value, now: u64) -> Result<(), &'static str> {
    if !snapshot.is_object() || id.is_empty() || id.len() > 96
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
        return Err("invalid_quota_schema");
    }
    for name in ["primary", "secondary"] {
        let window = match snapshot.get(name) {
            None | Some(Value::Null) => continue,
            Some(window) if window.is_object() => window,
            _ => return Err("invalid_quota_schema"),
        };
        let used = window.get("usedPercent").and_then(Value::as_i64)
            .filter(|n| (0..=100).contains(n)).ok_or("invalid_quota_schema")?;
        let duration = optional_integer(window, "windowDurationMins", 1)?;
        let resets = optional_integer(window, "resetsAt", 0)?;
        // Expired observations do not imply a fresh 100% quota.
        if resets.is_some_and(|reset| reset as u64 <= now) { continue; }
        out.push(json!({"limitId": id, "window": name, "remainingPercent": 100 - used,
            "windowDurationMins": duration, "resetsAt": resets}));
    }
    Ok(())
}

fn optional_integer(value: &Value, key: &str, minimum: i64) -> Result<Option<i64>, &'static str> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_i64().filter(|n| *n >= minimum)
            .map(Some).ok_or("invalid_quota_schema"),
    }
}

struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Child::kill targets this PID only; never kill a group or a named CLI.
        let _ = self.0.kill();
        let end = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            match self.0.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(5)),
                Ok(None) => {
                    // Preserve the public deadline even if OS reaping stalls.
                    // A cloned process handle is unavailable: transfer ownership
                    // through a PID-specific waitpid reaper instead.
                    let pid = self.0.id() as libc::pid_t;
                    let _ = std::thread::Builder::new().name("quota-reaper".into()).spawn(move || {
                        unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0); }
                    });
                    break;
                }
            }
        }
    }
}

fn nonblocking(fd: std::os::fd::RawFd) -> Result<(), &'static str> {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err("pipe_setup_failed");
        }
    }
    Ok(())
}

fn collect(mut command: Command, timeout: Duration) -> Result<Value, &'static str> {
    let deadline = Instant::now() + timeout;
    let mut child = OwnedChild(command.stdin(Stdio::piped()).stdout(Stdio::piped())
        .stderr(Stdio::null()).spawn().map_err(|_| "spawn_failed")?);
    let mut input = child.0.stdin.take().ok_or("pipe_setup_failed")?;
    let mut output = child.0.stdout.take().ok_or("pipe_setup_failed")?;
    nonblocking(input.as_raw_fd())?;
    nonblocking(output.as_raw_fd())?;
    let mut pending = serde_json::to_vec(&json!({"id": 1, "method": "initialize",
        "params": {"clientInfo": {"name": "jauria_quotas", "version": "0.1.0"}}}))
        .map_err(|_| "request_encode_failed")?;
    pending.push(b'\n');
    let mut sent = 0;
    let mut expected_id = 1;
    let mut line = Vec::new();
    let mut total = 0;
    loop {
        if Instant::now() >= deadline { return Err("deadline_exceeded"); }
        if sent < pending.len() {
            match input.write(&pending[sent..]) {
                Ok(0) => return Err("stdin_closed"),
                Ok(n) => sent += n,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {},
                Err(_) => return Err("stdin_failed"),
            }
        }
        let mut buffer = [0u8; 4096];
        match output.read(&mut buffer) {
            Ok(0) => return Err("stdout_closed"),
            Ok(n) => {
                total += n;
                if total > MAX_BYTES { return Err("output_limit_exceeded"); }
                for byte in &buffer[..n] {
                    if *byte != b'\n' {
                        if line.len() >= MAX_LINE { return Err("line_limit_exceeded"); }
                        line.push(*byte);
                        continue;
                    }
                    let message: Value = serde_json::from_slice(&line).map_err(|_| "invalid_rpc_json")?;
                    line.clear();
                    if !message.is_object() { return Err("invalid_rpc_response"); }
                    // Notifications and unrelated IDs are not quota responses.
                    if message.get("id").and_then(Value::as_u64) != Some(expected_id) { continue; }
                    if sent != pending.len() { return Err("unexpected_rpc_response"); }
                    if message.get("error").is_some() { return Err("rpc_error"); }
                    let result = message.get("result").filter(|v| v.is_object())
                        .ok_or("invalid_rpc_response")?;
                    if expected_id == 2 { return Ok(result.clone()); }
                    expected_id = 2;
                    pending = b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{\"excludeResetCreditDetails\":true}}\n".to_vec();
                    sent = 0;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {},
            Err(_) => return Err("stdout_failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(script: &str, timeout: Duration) -> Result<Value, &'static str> {
        let mut command = Command::new("/bin/sh");
        command.env_clear().args(["-c", script]);
        collect(command, timeout)
    }

    #[test]
    fn multi_bucket_observed_windows_no_context_or_identity() {
        let parsed = parse_limits(&json!({"accountId":"PRIVATE", "rateLimits":{"primary":{"usedPercent":99}},
            "context_window":{"remaining_percentage":77},
            "rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":200},
                "secondary":{"usedPercent":100,"windowDurationMins":10080}},
                "codex_other":{"primary":{"usedPercent":0},"secondary":null}}}), 100);
        assert_eq!(parsed["status"], "available");
        assert_eq!(parsed["windows"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["windows"][0]["remainingPercent"], 75);
        assert_eq!(parsed["windows"][1]["remainingPercent"], 0);
        assert_eq!(parsed["windows"][2]["remainingPercent"], 100);
        assert!(!parsed.to_string().contains("PRIVATE"));
        assert!(!parsed.to_string().contains("context"));
    }

    #[test]
    fn legacy_nullable_empty_and_expired() {
        for map in [Value::Null, json!({})] {
            let p = parse_limits(&json!({"rateLimitsByLimitId":map,
                "rateLimits":{"primary":{"usedPercent":12},"secondary":null}}), 100);
            assert_eq!(p["windows"][0]["remainingPercent"], 88);
            assert!(p["windows"][0]["resetsAt"].is_null());
        }
        for result in [json!({"rateLimits":{}}), json!({"rateLimits":{"primary":{"usedPercent":20,"resetsAt":100}}}),
            json!({"rateLimits":{"credits":{"unlimited":true}},"context_window":{"remaining_percentage":90}})] {
            assert_eq!(parse_limits(&result, 100)["reasonCode"], "no_observed_windows");
        }
    }

    #[test]
    fn reject_invalid_schema_without_fabricating_percentages() {
        for used in [json!(-1), json!(101), json!(1.5), json!("20"), Value::Null] {
            assert_eq!(parse_limits(&json!({"rateLimits":{"primary":{"usedPercent":used}}}), 100)["reasonCode"], "invalid_quota_schema");
        }
        for result in [json!({}), json!({"rateLimits":null}), json!({"rateLimitsByLimitId":[]}),
            json!({"rateLimits":{"primary":{"usedPercent":10,"resetsAt":"tomorrow"}}}),
            json!({"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":0}}})] {
            assert_eq!(parse_limits(&result, 100)["reasonCode"], "invalid_quota_schema");
        }
        let buckets: serde_json::Map<String, Value> = (0..33).map(|n| (format!("bucket{n}"), json!({}))).collect();
        assert_eq!(parse_limits(&json!({"rateLimitsByLimitId":buckets}), 100)["reasonCode"], "too_many_buckets");
    }

    #[test]
    fn handshake_order_and_notification_filtering() {
        let result = fixture(r#"
            IFS= read -r init
            case "$init" in *'"method":"initialize"'*) ;; *) exit 1;; esac
            printf '%s\n' '{"id":99,"result":{}}' '{"id":1,"result":{}}'
            IFS= read -r ready
            [ "$ready" = '{"method":"initialized"}' ] || exit 2
            IFS= read -r request
            case "$request" in *'"method":"account/rateLimits/read"'*) ;; *) exit 3;; esac
            printf '%s\n' '{"method":"account/rateLimits/updated","params":{"secret":"PRIVATE"}}' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":42}}}}'
            while :; do :; done
        "#, Duration::from_secs(1)).unwrap();
        assert_eq!(parse_limits(&result, 100)["windows"][0]["remainingPercent"], 58);
    }

    #[test]
    fn bounded_failure_and_redaction() {
        for (script, reason) in [
            ("IFS= read -r x; printf '%s\\n' '{\"id\":1,\"error\":{\"message\":\"PRIVATE\"}}'", "rpc_error"),
            ("IFS= read -r x; printf '%s\\n' 'PRIVATE invalid json'", "invalid_rpc_json"),
            ("IFS= read -r x; exit 7", "stdout_closed"),
            ("while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done", "line_limit_exceeded"),
            ("while :; do printf '%s\\n' '{\"method\":\"ignored\"}'; done", "output_limit_exceeded"),
        ] {
            assert_eq!(fixture(script, Duration::from_secs(2)).unwrap_err(), reason);
        }
        assert_eq!(collect(Command::new("/nonexistent/jauria-fixture"), Duration::from_secs(1)).unwrap_err(), "spawn_failed");
    }

    #[test]
    fn unavailable_has_spanish_ui_reason_and_stable_code() {
        let value = unavailable(CLAUDE_REASON);
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["reasonCode"], "claude_statusline_observation_required");
        assert!(value["reason"].as_str().unwrap().contains("primera respuesta"));
        assert_eq!(value["windows"], json!([]));
    }

    #[test]
    fn timeout_kills_and_reaps_owned_child() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("pid");
        let mut command = Command::new("/bin/sh");
        command.env_clear().args(["-c", "printf '%s' $$ > \"$1\"; while :; do :; done", "fixture"])
            .arg(&pid_file);
        let start = Instant::now();
        assert_eq!(collect(command, Duration::from_millis(100)).unwrap_err(), "deadline_exceeded");
        assert!(start.elapsed() < Duration::from_secs(1));
        let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        assert_eq!(unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) }, -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ECHILD));
    }
}

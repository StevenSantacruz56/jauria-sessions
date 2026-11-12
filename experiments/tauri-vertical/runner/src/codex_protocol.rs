//! Pure, bounded Codex app-server 0.167.1 codec. Only dependency: serde_json.
//!
//! Sources: docs/reviews/jauria-codex-protocol/{schema,protocol.sanitized.jsonl,
//! README.md,resolution.md} and experiments/tauri-vertical/codex_protocol_check.py.
//! `parse_line` decodes one native envelope (optional jsonrpc="2.0"). `request`
//! emits newline-terminated native requests using a deliberately small parameter
//! subset. `initialized` completes the handshake. `normalize_event` returns
//! {method,params} presentation metadata, never task acceptance or execution.
//! Unknown notifications return None; known events without a preserved local
//! schema/observation return Unsupported. No capability negotiation is inferred.
//!
//! `parse_approval` recognizes approvals and unsupported server request families.
//! `deny_reply` is the default; `approval_reply` accepts ONLY exact denial shapes
//! and an unchanged native scope. command_accept_reply is separately guarded by
//! the parent native-human consent + durable generation/permission CAS.
//! The caller must track connection generation, direction, typed RPC id, current
//! scope, cancellation/resolution and single-use replies before sending bytes.
//!
//! `account/read` is read-only (empty params, no refresh/login option). Its raw
//! response remains an ephemeral Incoming value. Parent must project native auth
//! type and drop account ids/email before storage. Likewise config/read must be
//! projected to server names and effective policy BEFORE starting a thread; never
//! store config credentials, env, headers or commands. These response schemas
//! were not preserved here: no fabricated response normalizer is provided.
//!
//! No I/O, logging, credential reads or sanitization. Raw Incoming values and
//! preserved free text may contain secrets: callers must not persist them as
//! sanitized evidence. Projection drops unlisted fields; it is NOT a generic
//! secret redactor. Limits reject oversized fields instead of silently clipping.
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fmt;

pub const PROTOCOL_VERSION: &str = "0.167.1";
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError { Malformed, Envelope, InvalidId, Limit, Params, Unsupported, Scope }
pub type Result<T> = std::result::Result<T, ProtocolError>;
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "Codex protocol: {self:?}") }
}
impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RpcId { String(String), Number(u64) }
impl RpcId {
    fn parse(v: &Value) -> Result<Self> {
        match v {
            Value::String(s) if s.len() <= MAX_ID_BYTES => Ok(Self::String(s.clone())),
            Value::Number(n) => n.as_u64().map(Self::Number).ok_or(ProtocolError::InvalidId),
            _ => Err(ProtocolError::InvalidId),
        }
    }
    pub fn value(&self) -> Result<Value> {
        let v = match self { Self::String(s) => json!(s), Self::Number(n) => json!(n) };
        Self::parse(&v)?;
        Ok(v)
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response { id: RpcId, result: Value },
    Error { id: RpcId, error: Value },
    Notification { method: String, params: Value },
    Request { id: RpcId, method: String, params: Value },
}

fn object(v: &Value) -> Result<&Map<String, Value>> { v.as_object().ok_or(ProtocolError::Params) }
fn keys(m: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if m.keys().any(|k| !allowed.contains(&k.as_str())) { return Err(ProtocolError::Params); }
    Ok(())
}
fn string<'a>(m: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    m.get(key).and_then(Value::as_str).ok_or(ProtocolError::Params)
}
fn native_id(m: &Map<String, Value>, key: &str) -> Result<String> {
    let s = string(m, key)?;
    if s.is_empty() || s.len() > MAX_ID_BYTES { return Err(ProtocolError::InvalidId); }
    Ok(s.to_owned())
}
fn optional_strings(m: &Map<String, Value>, fields: &[&str]) -> Result<()> {
    for k in fields {
        if let Some(v) = m.get(*k) { if !v.is_null() && !v.is_string() { return Err(ProtocolError::Params); } }
    }
    Ok(())
}
fn bounded(v: &Value) -> Result<()> {
    fn walk(v: &Value, depth: usize, count: &mut usize) -> Result<()> {
        *count += 1;
        if depth > 48 || *count > 8192 { return Err(ProtocolError::Limit); }
        match v {
            Value::String(s) if s.len() > MAX_TEXT_BYTES => return Err(ProtocolError::Limit),
            Value::Array(a) => {
                if a.len() > 256 { return Err(ProtocolError::Limit); }
                for x in a { walk(x, depth + 1, count)?; }
            }
            Value::Object(m) => {
                if m.len() > 256 || m.keys().any(|s| s.len() > 256) { return Err(ProtocolError::Limit); }
                for x in m.values() { walk(x, depth + 1, count)?; }
            }
            _ => {}
        }
        Ok(())
    }
    walk(v, 0, &mut 0)
}

// Run only after serde_json syntax validation. Detect duplicate decoded keys,
// including escaped spellings, throughout the envelope before trusting Value.
fn unique_keys(bytes: &[u8]) -> Result<()> {
    fn ws(b: &[u8], i: &mut usize) { while *i < b.len() && b[*i].is_ascii_whitespace() { *i += 1; } }
    fn quoted(b: &[u8], i: &mut usize) -> Result<String> {
        let start = *i; *i += 1;
        while *i < b.len() {
            match b[*i] {
                b'\\' => *i += 2,
                b'"' => { *i += 1; return serde_json::from_slice(&b[start..*i]).map_err(|_| ProtocolError::Malformed); }
                _ => *i += 1,
            }
        }
        Err(ProtocolError::Malformed)
    }
    fn visit(b: &[u8], i: &mut usize, depth: usize) -> Result<()> {
        if depth > 48 { return Err(ProtocolError::Limit); }
        ws(b, i);
        match b.get(*i) {
            Some(b'{') => {
                *i += 1; ws(b, i); let mut seen = HashSet::new();
                while b.get(*i) != Some(&b'}') {
                    let k = quoted(b, i)?;
                    if !seen.insert(k) { return Err(ProtocolError::Malformed); }
                    ws(b, i); *i += 1; visit(b, i, depth + 1)?; ws(b, i);
                    if b.get(*i) != Some(&b',') { break; }
                    *i += 1; ws(b, i);
                }
                *i += 1;
            }
            Some(b'[') => {
                *i += 1; ws(b, i);
                while b.get(*i) != Some(&b']') {
                    visit(b, i, depth + 1)?; ws(b, i);
                    if b.get(*i) != Some(&b',') { break; }
                    *i += 1;
                }
                *i += 1;
            }
            Some(b'"') => { quoted(b, i)?; }
            Some(_) => { while *i < b.len() && !b",]} \r\n\t".contains(&b[*i]) { *i += 1; } }
            None => return Err(ProtocolError::Malformed),
        }
        Ok(())
    }
    visit(bytes, &mut 0, 0)
}

/// One UTF-8 JSON object, optionally terminated by LF/CRLF. No batches or embedded
/// physical line breaks. The 1 MiB bound includes the optional line terminator.
pub fn parse_line(line: &[u8]) -> Result<Incoming> {
    if line.len() > MAX_LINE_BYTES { return Err(ProtocolError::Limit); }
    let b = if let Some(b) = line.strip_suffix(b"\n") { b.strip_suffix(b"\r").unwrap_or(b) } else { line };
    if b.contains(&b'\n') || b.contains(&b'\r') { return Err(ProtocolError::Malformed); }
    let v: Value = serde_json::from_slice(b).map_err(|_| ProtocolError::Malformed)?;
    bounded(&v)?; unique_keys(b)?;
    let m = v.as_object().ok_or(ProtocolError::Envelope)?;
    if m.get("jsonrpc").is_some_and(|x| x != "2.0") { return Err(ProtocolError::Envelope); }
    if m.contains_key("method") {
        keys(m, &["jsonrpc", "id", "method", "params", "emittedAtMs"]).map_err(|_| ProtocolError::Envelope)?;
        // Native probe notifications include this envelope timestamp. Incoming
        // intentionally omits it; it is never an identity or completion signal.
        if let Some(v) = m.get("emittedAtMs") {
            if m.contains_key("id") || v.as_i64().is_none() { return Err(ProtocolError::Envelope); }
        }
        let method = string(m, "method")?.to_owned();
        if method.is_empty() || method.len() > 256 { return Err(ProtocolError::Envelope); }
        let params = m.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() { return Err(ProtocolError::Params); }
        return if let Some(id) = m.get("id") {
            Ok(Incoming::Request { id: RpcId::parse(id)?, method, params })
        } else { Ok(Incoming::Notification { method, params }) };
    }
    keys(m, &["jsonrpc", "id", "result", "error"]).map_err(|_| ProtocolError::Envelope)?;
    let id = RpcId::parse(m.get("id").ok_or(ProtocolError::Envelope)?)?;
    match (m.get("result"), m.get("error")) {
        (Some(result), None) => Ok(Incoming::Response { id, result: result.clone() }),
        (None, Some(error)) => {
            let e = object(error)?;
            keys(e, &["code", "message", "data"])?;
            if !e.get("code").is_some_and(|x| x.as_i64().is_some()) { return Err(ProtocolError::Envelope); }
            string(e, "message")?;
            Ok(Incoming::Error { id, error: error.clone() })
        }
        _ => Err(ProtocolError::Envelope),
    }
}
fn encode(v: Value) -> Result<Vec<u8>> {
    bounded(&v)?;
    let mut b = serde_json::to_vec(&v).map_err(|_| ProtocolError::Malformed)?;
    if b.len() >= MAX_LINE_BYTES { return Err(ProtocolError::Limit); }
    b.push(b'\n'); Ok(b)
}

/// Deliberately restricted, observed text-only request subset. Unknown options,
/// experimental capabilities, auth/model/provider/config overrides and broader
/// sandbox policies are unsupported. account/read, config/read and account/rateLimits/read
/// allow only {}: their parameter schemas were not retained in this snapshot.
pub fn request(id: u64, method: &str, params: Value) -> Result<Vec<u8>> {
    bounded(&params)?;
    let p = object(&params)?;
    match method {
        "initialize" => {
            keys(p, &["clientInfo", "capabilities"])?;
            let c = object(p.get("clientInfo").ok_or(ProtocolError::Params)?)?;
            keys(c, &["name", "version", "title"])?;
            string(c, "name")?; string(c, "version")?; optional_strings(c, &["title"])?;
            if let Some(v) = p.get("capabilities") {
                if v != &json!({"experimentalApi": false}) { return Err(ProtocolError::Unsupported); }
            }
        }
        "thread/start" | "thread/resume" => {
            let mut allowed = vec!["cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "developerInstructions"];
            if method == "thread/resume" { allowed.extend(["threadId", "excludeTurns"]); native_id(p, "threadId")?; }
            keys(p, &allowed)?;
            optional_strings(p, &["cwd", "developerInstructions"])?;
            if p.get("sandbox").is_some_and(|v| v != "read-only" && v!="workspace-write") { return Err(ProtocolError::Unsupported); }
            if p.get("excludeTurns").is_some_and(|v| !v.is_boolean()) { return Err(ProtocolError::Params); }
            policy(p)?;
        }
        "turn/start" => {
            keys(p, &["threadId", "input", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"])?;
            native_id(p, "threadId")?; policy(p)?;
            if p.get("sandboxPolicy").is_some_and(|v| v != &json!({"type":"readOnly","networkAccess":false}) && v != &json!({"type":"workspaceWrite","networkAccess":false})) {
                return Err(ProtocolError::Unsupported);
            }
            let input = p.get("input").and_then(Value::as_array).ok_or(ProtocolError::Params)?;
            if input.is_empty() { return Err(ProtocolError::Params); }
            for v in input {
                let t = object(v)?; keys(t, &["type", "text"])?;
                if string(t, "type")? != "text" { return Err(ProtocolError::Unsupported); }
                string(t, "text")?;
            }
        }
        "turn/interrupt" => { keys(p, &["threadId", "turnId"])?; native_id(p, "threadId")?; native_id(p, "turnId")?; }
        "account/read" | "account/rateLimits/read" => keys(p, &[])?,
        "config/read" => {
            keys(p,&["cwd","includeLayers"])?;
            if p.get("includeLayers").is_some_and(|v|v!=false){return Err(ProtocolError::Unsupported);}
            if let Some(cwd)=p.get("cwd") {if !cwd.as_str().is_some_and(|s|std::path::Path::new(s).is_absolute() && !s.contains('\0')) {return Err(ProtocolError::Params);}}
        },
        _ => return Err(ProtocolError::Unsupported),
    }
    encode(json!({"id":id,"method":method,"params":params}))
}
fn policy(p: &Map<String, Value>) -> Result<()> {
    if p.get("approvalsReviewer").is_some_and(|v|v!="user"){return Err(ProtocolError::Unsupported);}
    if p.get("approvalPolicy").is_some_and(|v| v != "untrusted" && v != "on-request") { return Err(ProtocolError::Unsupported); }
    Ok(())
}
pub fn initialized() -> Result<Vec<u8>> { encode(json!({"method":"initialized"})) }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind { CommandExecution, FileChange, Permissions, McpElicitation, UserInput, DynamicTool, Unknown }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalScope { pub thread_id: String, pub turn_id: String, pub item_id: String, pub approval_id: Option<String> }
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    id: RpcId,
    kind: ApprovalKind,
    scope: Option<ApprovalScope>,
    presentation: Value,
}
impl Approval {
    pub fn id(&self) -> &RpcId { &self.id }
    pub fn kind(&self) -> ApprovalKind { self.kind }
    pub fn scope(&self) -> Option<&ApprovalScope> { self.scope.as_ref() }
    /// Untrusted display data only. Does not authorize command execution.
    pub fn presentation(&self) -> &Value { &self.presentation }
}

pub fn parse_approval(incoming: &Incoming) -> Result<Approval> {
    let Incoming::Request { id, method, params } = incoming else { return Err(ProtocolError::Envelope); };
    id.value()?; bounded(params)?;
    let kind = match method.as_str() {
        "item/commandExecution/requestApproval" => ApprovalKind::CommandExecution,
        "item/fileChange/requestApproval" => ApprovalKind::FileChange,
        "item/permissions/requestApproval" => ApprovalKind::Permissions,
        "mcpServer/elicitation/request" => ApprovalKind::McpElicitation,
        "item/tool/requestUserInput" => ApprovalKind::UserInput,
        "item/tool/call" => ApprovalKind::DynamicTool,
        _ => ApprovalKind::Unknown,
    };
    let mut a = Approval { id: id.clone(), kind, scope: None, presentation: json!({}) };
    if matches!(kind, ApprovalKind::McpElicitation | ApprovalKind::UserInput | ApprovalKind::DynamicTool | ApprovalKind::Unknown) { return Ok(a); }
    let p = object(params)?;
    let mut allowed = vec!["threadId", "turnId", "itemId", "startedAtMs", "reason"];
    match kind {
        ApprovalKind::CommandExecution => allowed.extend(["approvalId", "kind", "command", "cwd", "environmentId", "commandActions", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"]),
        ApprovalKind::FileChange => allowed.push("grantRoot"),
        ApprovalKind::Permissions => allowed.extend(["cwd", "environmentId", "permissions"]),
        _ => unreachable!(),
    }
    keys(p, &allowed)?;
    optional_strings(p, &["reason", "approvalId", "command", "cwd", "environmentId", "grantRoot"])?;
    if !p.get("startedAtMs").is_some_and(|v| v.as_i64().is_some()) { return Err(ProtocolError::Params); }
    if let Some(v) = p.get("kind") {
        if !matches!(v.as_str(), Some("command" | "writeStdin" | "humanCommand")) { return Err(ProtocolError::Params); }
    }
    if kind == ApprovalKind::Permissions {
        string(p, "cwd")?;
        // Validate the preserved permission schema, but never grant any part of it.
        validate_permissions(p.get("permissions").ok_or(ProtocolError::Params)?)?;
    }
    // Known nested command metadata is not interpreted or copied. Require its
    // outer type; there is no command policy or authority based on these fields.
    for k in ["commandActions", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"] {
        if p.get(k).is_some_and(|v| !v.is_null() && !v.is_array()) { return Err(ProtocolError::Params); }
    }
    if p.get("networkApprovalContext").is_some_and(|v| !v.is_null() && !v.is_object()) { return Err(ProtocolError::Params); }
    let approval_id = p.get("approvalId").filter(|v| !v.is_null()).map(|_| native_id(p, "approvalId")).transpose()?;
    a.scope = Some(ApprovalScope { thread_id: native_id(p,"threadId")?, turn_id: native_id(p,"turnId")?, item_id: native_id(p,"itemId")?, approval_id });
    a.presentation = project(p, &["threadId", "turnId", "itemId", "approvalId", "kind", "command", "cwd", "reason", "startedAtMs", "grantRoot", "environmentId", "networkApprovalContext"]);
    Ok(a)
}
fn deny_result(kind: ApprovalKind) -> Option<Value> {
    match kind {
        ApprovalKind::CommandExecution | ApprovalKind::FileChange => Some(json!({"decision":"decline"})),
        ApprovalKind::Permissions => Some(json!({"permissions":{},"scope":"turn"})),
        ApprovalKind::McpElicitation => Some(json!({"action":"decline","content":null})),
        _ => None,
    }
}
/// Native results carry only the RPC id, not thread/turn/item scope. Unsupported
/// user input/dynamic tools use -32601 rather than an invented result schema.
pub fn deny_reply(a: &Approval) -> Result<Vec<u8>> {
    match deny_result(a.kind) {
        Some(result) => encode(json!({"id":a.id.value()?,"result":result})),
        None => unsupported_reply(&a.id),
    }
}
/// Explicit reply validator: only a denial, exact result keys and unchanged scope.
/// No session grants, amendments, attestation, auto-review, or acceptance supported.
pub fn approval_reply(a: &Approval, scope: &ApprovalScope, result: Value) -> Result<Vec<u8>> {
    if a.scope.as_ref() != Some(scope) { return Err(ProtocolError::Scope); }
    if deny_result(a.kind).as_ref() != Some(&result) { return Err(ProtocolError::Unsupported); }
    encode(json!({"id":a.id.value()?,"result":result}))
}
/// Only AFTER durable native-human approval of this exact current request.
/// No automatic reviewer, writeStdin, remote environment, network grant, session
/// permission, policy amendment or filesystem scope grant is supported here.
pub fn command_accept_reply(a:&Approval,scope:&ApprovalScope)->Result<Vec<u8>> {
    if a.scope.as_ref()!=Some(scope){return Err(ProtocolError::Scope);}
    if !a.presentation["command"].as_str().is_some_and(crate::approval_text::supported) || !a.presentation["cwd"].as_str().is_some_and(crate::approval_text::supported){return Err(ProtocolError::Unsupported);}
    if crate::approval_text::compact_command(a.presentation["command"].as_str().unwrap_or(""),a.presentation["cwd"].as_str().unwrap_or("")).is_none(){return Err(ProtocolError::Unsupported);}
    if a.kind!=ApprovalKind::CommandExecution || a.presentation["kind"]!="command"
        || !crate::approval_text::local_environment(&a.presentation["environmentId"]) || !a.presentation["networkApprovalContext"].is_null()
        || !a.presentation["command"].is_string() || !a.presentation["cwd"].as_str().is_some_and(|s|std::path::Path::new(s).is_absolute()) {return Err(ProtocolError::Unsupported);}
    encode(json!({"id":a.id.value()?,"result":{"decision":"accept"}}))
}
/// Safe fallback for malformed/unknown server requests; never echoes provider text.
pub fn unsupported_reply(id: &RpcId) -> Result<Vec<u8>> {
    encode(json!({"id":id.value()?,"error":{"code":-32601,"message":"Unsupported by bounded Codex 0.167.1 codec"}}))
}
fn project(m: &Map<String, Value>, fields: &[&str]) -> Value {
    Value::Object(fields.iter().filter_map(|k| m.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect())
}

/// Fixed projection of observed native events, preserving identity/text/status.
/// Unknown item variants return None. Turn item lists are deliberately omitted:
/// correlate item events separately. Terminal turn state is never task acceptance.
pub fn normalize_event(method: &str, params: &Value) -> Result<Option<Value>> {
    if !matches!(method, "thread/started" | "thread/status/changed" | "turn/started" | "turn/completed" | "item/started" | "item/completed" | "item/agentMessage/delta" | "serverRequest/resolved" | "item/commandExecution/outputDelta" | "error") { return Ok(None); }
    bounded(params)?;
    let p = object(params)?;
    let mut out = Map::new();
    if method=="item/commandExecution/outputDelta" {
        for key in ["threadId","turnId","itemId"] {native_id(p,key)?;} string(p,"delta")?;
        return Ok(Some(json!({"method":method,"params":project(p,&["threadId","turnId","itemId","delta"])})));
    }
    if method=="error" {
        native_id(p,"threadId")?;native_id(p,"turnId")?;
        if !p.get("willRetry").is_some_and(Value::is_boolean){return Err(ProtocolError::Params);}
        let error=object(p.get("error").ok_or(ProtocolError::Params)?)?;string(error,"message")?;
        return Ok(Some(json!({"method":method,"params":{"threadId":p["threadId"],"turnId":p["turnId"],"willRetry":p["willRetry"],"error":project(error,&["message"])}})));
    }
    if method == "thread/started" {
        let t = object(p.get("thread").ok_or(ProtocolError::Params)?)?;
        native_id(t, "id")?;
        if t.get("cliVersion").is_some_and(|v| v != PROTOCOL_VERSION) { return Err(ProtocolError::Unsupported); }
        let mut thread = project(t, &["id", "cliVersion"]);
        if let Some(s) = t.get("status") { validate_status(s)?; thread["status"] = project(object(s)?, &["type"]); }
        out.insert("thread".into(), thread);
    } else {
        native_id(p, "threadId")?; out.insert("threadId".into(), p["threadId"].clone());
        match method {
            "thread/status/changed" => {
                let s = p.get("status").ok_or(ProtocolError::Params)?; validate_status(s)?;
                out.insert("status".into(), project(object(s)?, &["type"]));
            }
            "serverRequest/resolved" => {
                let id = RpcId::parse(p.get("requestId").ok_or(ProtocolError::Params)?)?;
                out.insert("requestId".into(), id.value()?);
            }
            "turn/started" | "turn/completed" => {
                let t = object(p.get("turn").ok_or(ProtocolError::Params)?)?;
                native_id(t, "id")?;
                let status = string(t, "status")?;
                if (method == "turn/started" && status != "inProgress") ||
                   (method == "turn/completed" && !["completed", "interrupted","failed"].contains(&status)) { return Err(ProtocolError::Params); }
                out.insert("turn".into(), project(t, &["id", "status"]));
            }
            _ => {
                native_id(p,"turnId")?; out.insert("turnId".into(), p["turnId"].clone());
                if method == "item/agentMessage/delta" {
                    native_id(p,"itemId")?; string(p,"delta")?;
                    out.insert("itemId".into(),p["itemId"].clone()); out.insert("delta".into(),p["delta"].clone());
                } else {
                    let item = object(p.get("item").ok_or(ProtocolError::Params)?)?;
                    native_id(item,"id")?;
                    let typ = string(item,"type")?;
                    if !["userMessage", "agentMessage", "reasoning", "commandExecution"].contains(&typ) { return Ok(None); }
                    let mut fields = vec!["id", "type"];
                    if typ == "agentMessage" { string(item,"text")?; optional_strings(item,&["phase"])?; fields.extend(["text", "phase"]); }
                    if typ == "commandExecution" {
                        string(item,"command")?; string(item,"cwd")?;
                        if !["inProgress", "completed", "failed", "declined"].contains(&string(item,"status")?) { return Err(ProtocolError::Unsupported); }
                        optional_strings(item,&["aggregatedOutput"])?;
                        if item.get("exitCode").is_some_and(|v| !v.is_null() && v.as_i64().is_none()) { return Err(ProtocolError::Params); }
                        fields.extend(["command", "cwd", "status", "aggregatedOutput", "exitCode"]);
                    }
                    out.insert("item".into(),project(item,&fields));
                }
            }
        }
    }
    Ok(Some(json!({"method":method,"params":out})))
}
fn validate_status(v: &Value) -> Result<()> {
    let s = object(v)?;
    // Only states actually present in the preserved probe.
    if !["notLoaded","idle", "active","systemError"].contains(&string(s,"type")?) { return Err(ProtocolError::Unsupported); }
    Ok(())
}

fn validate_permissions(v: &Value) -> Result<()> {
    let p = object(v)?; keys(p, &["network", "fileSystem"])?;
    if let Some(v) = p.get("network").filter(|v| !v.is_null()) {
        let n = object(v)?; keys(n, &["enabled"])?;
        if n.get("enabled").is_some_and(|v| !v.is_null() && !v.is_boolean()) { return Err(ProtocolError::Params); }
    }
    if let Some(v) = p.get("fileSystem").filter(|v| !v.is_null()) {
        let f = object(v)?; keys(f, &["entries", "read", "write", "globScanMaxDepth"])?;
        if f.get("globScanMaxDepth").is_some_and(|v| !v.is_null() && !v.as_u64().is_some_and(|n| n > 0)) { return Err(ProtocolError::Params); }
        for key in ["read", "write"] {
            if let Some(v) = f.get(key).filter(|v| !v.is_null()) {
                let a = v.as_array().ok_or(ProtocolError::Params)?;
                if a.iter().any(|v| !v.is_string()) { return Err(ProtocolError::Params); }
            }
        }
        if let Some(v) = f.get("entries").filter(|v| !v.is_null()) {
            for entry in v.as_array().ok_or(ProtocolError::Params)? {
                let e = object(entry)?; keys(e, &["access", "path"])?;
                if !["read", "write", "deny"].contains(&string(e,"access")?) { return Err(ProtocolError::Params); }
                let path = object(e.get("path").ok_or(ProtocolError::Params)?)?;
                match string(path,"type")? {
                    "path" => { keys(path,&["type","path"])?; string(path,"path")?; }
                    "glob_pattern" => { keys(path,&["type","pattern"])?; string(path,"pattern")?; }
                    "special" => {
                        keys(path,&["type","value"])?;
                        let val = object(path.get("value").ok_or(ProtocolError::Params)?)?;
                        match string(val,"kind")? {
                            "root" | "minimal" => keys(val,&["kind"] )?,
                            "project_roots" => { keys(val,&["kind","subpath"])?; optional_strings(val,&["subpath"])?; }
                            "unknown" => { keys(val,&["kind","path","subpath"])?; string(val,"path")?; optional_strings(val,&["subpath"])?; }
                            _ => return Err(ProtocolError::Unsupported),
                        }
                    }
                    _ => return Err(ProtocolError::Unsupported),
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(v: Value) -> Result<Incoming> { parse_line(&serde_json::to_vec(&v).unwrap()) }
    fn approval(method: &str, params: Value) -> Result<Approval> {
        parse_approval(&parse(json!({"id":"7","method":method,"params":params})).unwrap())
    }
    fn scope_params() -> Value { json!({"threadId":"thread","turnId":"turn","itemId":"item","startedAtMs":123}) }
    fn wire(b: Vec<u8>) -> Value {
        assert_eq!(b.last(),Some(&b'\n'));
        assert_eq!(b.iter().filter(|b| **b == b'\n').count(),1);
        serde_json::from_slice(&b).unwrap()
    }
    #[test]
    fn envelope_variants_and_typed_ids() {
        assert_eq!(parse(json!({"id":7,"result":null})).unwrap(),Incoming::Response{id:RpcId::Number(7),result:Value::Null});
        assert_ne!(RpcId::String("7".into()),RpcId::Number(7));
        assert!(matches!(parse(json!({"id":"7","error":{"code":-32601,"message":"no"}})).unwrap(), Incoming::Error{id:RpcId::String(_),..}));
        assert!(matches!(parse_line(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}\r\n").unwrap(),Incoming::Notification{..}));
        assert!(matches!(parse(json!({"id":u64::MAX,"method":"unknown"})).unwrap(),Incoming::Request{..}));
        for id in [json!(null),json!(true),json!(-1),json!(1.0),json!([]),json!({})] {
            assert!(parse(json!({"id":id,"result":{}})).is_err());
        }
        for id in ["1e0","18446744073709551616","-0"] {
            assert!(parse_line(format!("{{\"id\":{id},\"result\":{{}}}}").as_bytes()).is_err());
        }
    }
    #[test]
    fn rejects_malformed_mixed_duplicate_and_batch_envelopes() {
        for b in [b"".as_slice(),b"null",b"[]",b"{}",b"{",b"\xff",b"{\"id\":1,\"result\":0} {}",b"{\n\"method\":\"x\"}",b"{\"method\":\"x\"}\r",
            br#"{"id":1,"id":2,"result":{}}"#,
            br#"{"id":1,"result":{"k":1,"\u006b":2}}"#] { assert!(parse_line(b).is_err(),"{b:?}"); }
        for v in [json!({"id":1,"result":{},"error":{"code":1,"message":"x"}}),json!({"id":1,"method":"x","result":{}}),json!({"method":"x","error":{}}),json!({"method":"x","params":null}),json!({"method":"x","params":[]}),json!({"method":"x","jsonrpc":"1.0"}),json!({"method":"x","jsonrpc":null}),json!({"id":1,"error":{"code":1.5,"message":"x"}}),json!({"id":1,"error":{"code":1,"message":9}}),json!({"id":1,"result":{},"authToken":"secret"})] { assert!(parse(v).is_err()); }
    }
    #[test]
    fn bounded_lines_values_and_error_messages() {
        assert_eq!(parse_line(&vec![b' ';MAX_LINE_BYTES+1]),Err(ProtocolError::Limit));
        let mut boundary = br#"{"id":1,"result":null}"#.to_vec(); boundary.resize(MAX_LINE_BYTES,b' ');
        assert!(parse_line(&boundary).is_ok());
        assert_eq!(parse(json!({"id":1,"result":"x".repeat(MAX_TEXT_BYTES+1)})),Err(ProtocolError::Limit));
        assert!(parse(json!({"id":"x".repeat(MAX_ID_BYTES+1),"result":{}})).is_err());
        assert!(parse(json!({"id":1,"result":vec![0;257]})).is_err());
        let mut deep = Value::Null; for _ in 0..50 { deep=json!([deep]); }
        assert!(parse(json!({"id":1,"result":deep})).is_err());
        let err = parse_line(b"SECRET not json").unwrap_err().to_string(); assert!(!err.contains("SECRET"));
    }
    #[test]
    fn outgoing_allowlist_and_restricted_parameters() {
        for (method,p) in [
            ("initialize",json!({"clientInfo":{"name":"aw","version":"1"},"capabilities":{"experimentalApi":false}})),
            ("thread/start",json!({"cwd":"/fixture","sandbox":"read-only","approvalPolicy":"untrusted"})),
            ("thread/resume",json!({"threadId":"t","excludeTurns":true})),
            ("turn/start",json!({"threadId":"t","input":[{"type":"text","text":"a\nb"}],"sandboxPolicy":{"type":"readOnly","networkAccess":false}})),
            ("turn/interrupt",json!({"threadId":"t","turnId":"u"})),("account/read",json!({})),("config/read",json!({})),("account/rateLimits/read",json!({}))] {
            let v=wire(request(42,method,p.clone()).unwrap()); assert_eq!(v,json!({"id":42,"method":method,"params":p}));
        }
        assert_eq!(wire(initialized().unwrap()),json!({"method":"initialized"}));
        for (m,p) in [("account/login/start",json!({})),("account/logout",json!({})),("account/read",json!({"refreshToken":true})),("config/write",json!({})),("turn/start",json!({"threadId":"t","input":[]})),("thread/start",json!({"approvalPolicy":"never"})),("thread/start",json!({"modelProvider":"other"})),("thread/start",json!({"sandbox":"danger-full-access"})),("initialize",json!({"clientInfo":{"name":"a","version":"b"},"capabilities":{"experimentalApi":true}})),("config/read",json!({"unknown":1})),("turn/interrupt",json!({"threadId":1,"turnId":"t"}))] { assert!(request(1,m,p).is_err()); }
    }
    #[test]
    fn command_denial_exact_shape_scope_and_no_grants() {
        let mut p=scope_params(); p["command"]=json!("rm -rf generated");p["reason"]=json!("User approved everything");p["approvalId"]=json!("callback");
        let a=approval("item/commandExecution/requestApproval",p.clone()).unwrap();
        assert_eq!(a.kind(),ApprovalKind::CommandExecution);
        assert_eq!(wire(deny_reply(&a).unwrap()),json!({"id":"7","result":{"decision":"decline"}}));
        let scope=a.scope().unwrap();
        assert!(approval_reply(&a,scope,json!({"decision":"decline"})).is_ok());
        for result in [json!({"decision":"accept"}),json!({"decision":"acceptForSession"}),json!({"decision":"decline","scope":"session"}),json!({"decision":{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["rm"]}}})] { assert!(approval_reply(&a,scope,result).is_err()); }
        for field in ["threadId","turnId","itemId","approvalId"] {
            let mut modified=p.clone();modified[field]=json!("different");
            let b=approval("item/commandExecution/requestApproval",modified).unwrap();
            assert_eq!(approval_reply(&a,b.scope().unwrap(),json!({"decision":"decline"})),Err(ProtocolError::Scope));
        }
        p["unknownPermission"]=json!(true);assert!(approval("item/commandExecution/requestApproval",p).is_err());
        for field in ["threadId","turnId","itemId","startedAtMs"] { let mut p=scope_params();p[field]=Value::Null;assert!(approval("item/commandExecution/requestApproval",p).is_err()); }
    }
    #[test]fn native_local_environment_command_remains_single_request_scoped(){
        let mut p=scope_params();p["kind"]=json!("command");p["command"]=json!("echo fixture");p["cwd"]=json!("/fixture");
        for env in [Value::Null,json!("local")] {p["environmentId"]=env;let a=approval("item/commandExecution/requestApproval",p.clone()).unwrap();assert_eq!(wire(command_accept_reply(&a,a.scope().unwrap()).unwrap())["result"],json!({"decision":"accept"}));}
        for env in [json!("remote"),json!("LOCAL"),json!("local-other")] {p["environmentId"]=env;let a=approval("item/commandExecution/requestApproval",p.clone()).unwrap();assert!(command_accept_reply(&a,a.scope().unwrap()).is_err());assert!(deny_reply(&a).is_ok());}
    }
    #[test]fn exact_command_accept_rejects_unicode_format_spoof_but_denial_remains_possible(){
        let mut p=scope_params();p["kind"]=json!("command");p["command"]=json!("printf safe");p["cwd"]=json!("/repo con á");
        let valid=approval("item/commandExecution/requestApproval",p.clone()).unwrap();assert_eq!(wire(command_accept_reply(&valid,valid.scope().unwrap()).unwrap())["result"]["decision"],"accept");
        for character in ['\u{202e}','\u{2066}','\u{200b}','\u{feff}','\u{0085}','\u{009b}','\n'] {
            for key in ["command","cwd"]{let mut bad=p.clone();bad[key]=json!(format!("{}{character}hidden",bad[key].as_str().unwrap()));let a=approval("item/commandExecution/requestApproval",bad).unwrap();assert!(command_accept_reply(&a,a.scope().unwrap()).is_err());assert!(deny_reply(&a).is_ok());}
        }
    }
    #[test]
    fn native_permission_file_and_unsupported_denials() {
        let mut p=scope_params();p["cwd"]=json!("/fixture");p["permissions"]=json!({"network":{"enabled":true},"fileSystem":{"write":["/fixture"],"entries":[{"access":"write","path":{"type":"special","value":{"kind":"project_roots"}}}]}});
        let a=approval("item/permissions/requestApproval",p.clone()).unwrap();
        assert_eq!(wire(deny_reply(&a).unwrap())["result"],json!({"permissions":{},"scope":"turn"}));
        assert!(approval_reply(&a,a.scope().unwrap(),json!({"permissions":{},"scope":"session"})).is_err());
        p["permissions"]["network"]["enabled"]=json!("yes");assert!(approval("item/permissions/requestApproval",p).is_err());
        let a=approval("item/fileChange/requestApproval",scope_params()).unwrap();assert_eq!(wire(deny_reply(&a).unwrap())["result"],json!({"decision":"decline"}));
        for (m,k) in [("mcpServer/elicitation/request",ApprovalKind::McpElicitation),("item/tool/requestUserInput",ApprovalKind::UserInput),("item/tool/call",ApprovalKind::DynamicTool),("unrecognized",ApprovalKind::Unknown)] {
            let a=approval(m,json!({"api_key":"unknown-secret"})).unwrap();assert_eq!(a.kind(),k);assert_eq!(a.presentation(),&json!({}));
            let v=wire(deny_reply(&a).unwrap());assert_eq!(v["id"],"7");
            if k==ApprovalKind::McpElicitation { assert_eq!(v["result"],json!({"action":"decline","content":null})); } else { assert_eq!(v["error"]["code"],-32601); }
            assert!(!v.to_string().contains("unknown-secret"));
        }
        assert_ne!(wire(unsupported_reply(&RpcId::Number(7)).unwrap())["id"],wire(unsupported_reply(&RpcId::String("7".into())).unwrap())["id"]);
    }
    #[test]
    fn projections_drop_unknown_fields_but_do_not_claim_text_redaction() {
        let p=json!({"threadId":"t","turnId":"u","itemId":"i","delta":"arbitrary-secret","accountId":"private","authToken":"private"});
        let n=normalize_event("item/agentMessage/delta",&p).unwrap().unwrap();
        assert_eq!(n["params"]["delta"],"arbitrary-secret");assert!(!n.to_string().contains("private"));
        assert_eq!(normalize_event("unknown",&p).unwrap(),None);
        assert!(normalize_event("error",&p).is_err());
        assert!(normalize_event("item/commandExecution/outputDelta",&json!({"threadId":"t","turnId":"u","itemId":"i","delta":"out"})).unwrap().is_some());
        assert!(normalize_event("item/agentMessage/delta",&json!({"threadId":"t","turnId":"u","delta":1})).is_err());
        let p=json!({"thread":{"id":"t","cliVersion":"0.167.1","status":{"type":"idle","authToken":"private"},"codexHome":"private"}});
        assert!(!normalize_event("thread/started",&p).unwrap().unwrap().to_string().contains("private"));
        let n=normalize_event("turn/completed",&json!({"threadId":"t","turn":{"id":"u","status":"interrupted","items":[]}})).unwrap().unwrap();
        assert_eq!(n["params"]["turn"]["status"],"interrupted");assert!(!n.to_string().contains("task"));
    }
    #[test]
    fn replay_synthetic_protocol_offline() {
        let fixture=include_str!("../tests/fixtures/protocol.synthetic.jsonl");
        let mut approvals=0; let mut events=0; let mut terminal=0;
        for line in fixture.lines() {
            let record:Value=serde_json::from_str(line).unwrap();
            if let Some(m)=record.get("data").and_then(|v|v.get("message")) {
                let incoming=parse(m.clone()).unwrap_or_else(|e| panic!("probe envelope: {e}, keys={:?}",m.as_object().map(|m|m.keys().collect::<Vec<_>>())));
                match &incoming {
                    Incoming::Request{method,..} if method=="item/commandExecution/requestApproval" => { let a=parse_approval(&incoming).unwrap(); assert_eq!(wire(deny_reply(&a).unwrap())["result"]["decision"],"decline"); approvals+=1; }
                    Incoming::Notification{method,params} => {
                        if normalize_event(method,params).unwrap().is_some() { events+=1; }
                        if method=="turn/completed" { terminal+=1; }
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(approvals,2); assert_eq!(terminal,3); assert!(events>20);
    }
}

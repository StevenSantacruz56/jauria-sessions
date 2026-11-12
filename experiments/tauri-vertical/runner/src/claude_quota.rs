//! Native statusline callback cache. No provider requests or credential access.
//! One private profile represents one account. Last committed callback wins;
//! missing quota data leaves the previous observation untouched (never freshened).
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: usize = 128 * 1024;
const STALE_AFTER: u64 = 300;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const FILE_NAME: &str = "claude-quota.json";

/// Consume one bounded statusline JSON on stdin. Always silent on stdout.
/// Failures contain only a generic message, never JSON, paths or IO details.
pub fn run(data: &Path) -> Result<()> {
    (|| {
        let bytes = stdin_bytes()?;
        ingest(data, &bytes, now())
    })().map_err(|_: anyhow::Error| anyhow!("No se pudo guardar la observación de cuota de Claude."))
}

/// Read cached observations without refreshing their timestamp or contacting Claude.
/// Observations older than five minutes are unavailable, even without reset time.
pub fn read(data: &Path) -> Value {
    match load(data, now()) {
        Ok(Some(value)) => value,
        Ok(None) => unavailable("missing", None),
        Err(_) => unavailable("invalid_cache", None),
    }
}

/// Pass this JSON as one literal argument after `--settings`, without a shell.
/// Only statusLine is configured; command arguments are POSIX shell quoted.
pub fn settings(executable: &Path, data: &Path) -> Result<String> {
    let command = format!("{} --quota-hook --data-dir {}", quote(executable)?, quote(data)?);
    Ok(serde_json::to_string(&json!({"statusLine":{"type":"command","command":command}}))?)
}

fn quote(path: &Path) -> Result<String> {
    ensure!(path.is_absolute(), "La ruta del hook debe ser absoluta.");
    let text = path.to_str().ok_or_else(|| anyhow!("Ruta de hook no compatible."))?;
    ensure!(!text.contains('\0'), "Ruta de hook no compatible.");
    Ok(format!("'{}'", text.replace('\'', "'\\''")))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn unavailable(code: &str, observed: Option<u64>) -> Value {
    let reason = match code {
        "missing" => "Cuota de Claude aún no disponible. Esperando datos tras la primera respuesta de una sesión nativa compatible.",
        "stale" => "La última cuota observada de Claude está desactualizada. Se actualizará cuando la sesión nativa entregue nuevos datos.",
        "expired" => "Las ventanas observadas de Claude vencieron. Se necesitan nuevos datos de la sesión nativa.",
        _ => "No se pudo leer de forma segura la cuota guardada de Claude.",
    };
    let mut result = json!({"status":"unavailable", "reasonCode":code, "reason":reason, "windows":[]});
    if let Some(timestamp) = observed { result["observedAt"] = json!(timestamp); }
    result
}

fn stdin_bytes() -> Result<Vec<u8>> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "stdin timeout");
        let mut poll = libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 };
        let status = unsafe { libc::poll(&mut poll, 1, remaining.as_millis().max(1) as i32) };
        if status < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue; }
        ensure!(status > 0, "stdin unavailable");
        ensure!(poll.revents & (libc::POLLERR | libc::POLLNVAL) == 0, "stdin unavailable");
        let mut chunk = [0; 4096];
        let n = unsafe { libc::read(libc::STDIN_FILENO, chunk.as_mut_ptr().cast(), chunk.len()) };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted { continue; }
            return Err(error.into());
        }
        let n = n as usize;
        if n == 0 { return Ok(bytes); }
        ensure!(bytes.len() + n <= MAX_BYTES, "stdin too large");
        bytes.extend_from_slice(&chunk[..n]);
    }
}

fn bounded(mut input: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input.by_ref().take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "snapshot too large");
    Ok(bytes)
}

fn number(value: &Value) -> Result<f64> {
    value.as_f64().filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
        .ok_or_else(|| anyhow!("invalid percentage"))
}

fn reset(value: Option<&Value>) -> Result<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(value.as_u64().ok_or_else(|| anyhow!("invalid reset"))?)),
    }
}

fn source_windows(value: &Value, timestamp: u64) -> Result<Vec<Value>> {
    ensure!(value.is_object(), "invalid callback");
    let limits = match value.get("rate_limits") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(limits) => limits.as_object().ok_or_else(|| anyhow!("invalid limits"))?,
    };
    let mut windows = Vec::new();
    for (name, duration) in [("five_hour", 300), ("seven_day", 10080)] {
        let value = match limits.get(name) {
            None | Some(Value::Null) => continue,
            Some(value) => value.as_object().ok_or_else(|| anyhow!("invalid window"))?,
        };
        let used = match value.get("used_percentage") {
            None | Some(Value::Null) => continue,
            Some(used) => number(used)?,
        };
        let reset = reset(value.get("resets_at"))?;
        if reset.is_some_and(|reset| reset <= timestamp) { continue; }
        windows.push(json!({"limitId":"claude", "window":name,
            "remainingPercent":100.0 - used, "windowDurationMins":duration, "resetsAt":reset}));
    }
    Ok(windows)
}

fn snapshot(windows: Vec<Value>, timestamp: u64) -> Value {
    json!({"schemaVersion":1, "provider":"claude", "status":"available",
        "source":"claude/statusline", "observedAt":timestamp, "windows":windows})
}

fn ingest(data: &Path, bytes: &[u8], timestamp: u64) -> Result<()> {
    ensure!(bytes.len() <= MAX_BYTES, "callback too large");
    let value: Value = serde_json::from_slice(bytes).map_err(|_| anyhow!("invalid callback"))?;
    let windows = source_windows(&value, timestamp)?;
    let dir = directory(data)?;
    // Missing/null/expired data cannot overwrite or rejuvenate prior observations.
    if windows.is_empty() { return Ok(()); }
    store(&dir, &snapshot(windows, timestamp))
}

fn cstring(bytes: &[u8]) -> Result<CString> {
    CString::new(bytes).map_err(|_| anyhow!("invalid path"))
}

fn open_at(dir: i32, name: &CString, flags: i32, mode: libc::mode_t) -> Result<File> {
    let fd = unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode as libc::c_uint) };
    if fd < 0 { return Err(std::io::Error::last_os_error().into()); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

// Pin each component to a directory FD: reject symlinks in the entire data path,
// including ancestors. Never mkdir/chmod user directories on behalf of the hook.
fn directory(data: &Path) -> Result<File> {
    ensure!(data.is_absolute(), "absolute data path required");
    let mut dir = File::open("/")?;
    for component in data.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(name) => {
                dir = open_at(dir.as_raw_fd(), &cstring(name.as_bytes())?, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            }
            _ => return Err(anyhow!("invalid data path")),
        }
    }
    let metadata = dir.metadata()?;
    ensure!(metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.mode() & 0o7777 == 0o700, "private directory required");
    Ok(dir)
}

fn private_file(file: &File) -> Result<()> {
    let m = file.metadata()?;
    ensure!(m.is_file() && m.uid() == unsafe { libc::geteuid() }
        && m.mode() & 0o7777 == 0o600 && m.nlink() <= 1, "unsafe quota file");
    // A concurrent atomic rename can unlink the previous, already-open inode.
    // nlink=0 is safe for that reader; nlink>1 is always a rejected hardlink.
    Ok(())
}

fn existing(dir: &File) -> Result<Option<File>> {
    // O_NONBLOCK also prevents a substituted FIFO/device from blocking the hook.
    match open_at(dir.as_raw_fd(), &cstring(FILE_NAME.as_bytes())?, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
        Ok(file) => { private_file(&file)?; Ok(Some(file)) },
        Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

struct Temporary<'a> { dir: &'a File, name: CString, active: bool }
impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if self.active { unsafe { libc::unlinkat(self.dir.as_raw_fd(), self.name.as_ptr(), 0); } }
    }
}

fn store(dir: &File, value: &Value) -> Result<()> {
    // Atomic replacement is sufficient for concurrent callbacks: no read/merge,
    // and the last completed rename is the global account snapshot.
    existing(dir)?;
    let mut entropy = [0u8; 16];
    ensure!(unsafe { libc::getentropy(entropy.as_mut_ptr().cast(), entropy.len()) } == 0, "temporary name unavailable");
    let suffix: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
    let name = cstring(format!(".claude-quota-{suffix}.tmp").as_bytes())?;
    let mut file = open_at(dir.as_raw_fd(), &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
    let mut temporary = Temporary { dir, name, active: true };
    ensure!(unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } == 0, "temporary permissions failed");
    private_file(&file)?;
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= MAX_BYTES, "snapshot too large");
    file.write_all(&bytes)?;
    file.sync_all()?;
    private_file(&file)?;
    existing(dir)?;
    let target = cstring(FILE_NAME.as_bytes())?;
    ensure!(unsafe { libc::renameat(dir.as_raw_fd(), temporary.name.as_ptr(), dir.as_raw_fd(), target.as_ptr()) } == 0,
        "snapshot replacement failed");
    temporary.active = false;
    dir.sync_all()?;
    Ok(())
}

fn load(data: &Path, timestamp: u64) -> Result<Option<Value>> {
    let dir = directory(data)?;
    let Some(file) = existing(&dir)? else { return Ok(None); };
    let bytes = bounded(&file)?;
    private_file(&file)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid snapshot"))?;
    Ok(Some(validate_snapshot(&value, timestamp)?))
}

fn validate_snapshot(value: &Value, timestamp: u64) -> Result<Value> {
    ensure!(value["schemaVersion"] == 1 && value["provider"] == "claude"
        && value["source"] == "claude/statusline" && value["status"] == "available", "invalid snapshot");
    let observed = value["observedAt"].as_u64().filter(|n| *n <= timestamp)
        .ok_or_else(|| anyhow!("invalid observation time"))?;
    let windows = value["windows"].as_array().filter(|v| !v.is_empty() && v.len() <= 2)
        .ok_or_else(|| anyhow!("invalid windows"))?;
    let mut output = Vec::new();
    let mut seen = [false; 2];
    for window in windows {
        let (index, duration) = match window["window"].as_str() {
            Some("five_hour") => (0, 300),
            Some("seven_day") => (1, 10080),
            _ => return Err(anyhow!("invalid window name")),
        };
        ensure!(!seen[index] && window["limitId"] == "claude"
            && window["windowDurationMins"] == duration, "invalid window metadata");
        seen[index] = true;
        let remaining = number(&window["remainingPercent"])?;
        let reset = reset(window.get("resetsAt"))?;
        if reset.is_some_and(|reset| reset <= timestamp) { continue; }
        output.push(json!({"limitId":"claude", "window":window["window"],
            "remainingPercent":remaining, "windowDurationMins":duration, "resetsAt":reset}));
    }
    if timestamp - observed > STALE_AFTER { return Ok(unavailable("stale", Some(observed))); }
    if output.is_empty() { return Ok(unavailable("expired", Some(observed))); }
    // Reconstruct from validated fields rather than returning arbitrary file data.
    Ok(snapshot(output, observed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn profile() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }
    fn path(dir: &tempfile::TempDir) -> std::path::PathBuf { dir.path().canonicalize().unwrap() }
    fn callback(used: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"rate_limits":{"five_hour":{"used_percentage":used}},
            "transcript":"PRIVATE", "context_window":{"remaining_percentage":99}})).unwrap()
    }

    #[test]
    fn selected_floats_zero_null_and_prior_observations() {
        let d = profile(); let p = path(&d);
        for (used, expected) in [(0.0, 100.0), (100.0, 0.0), (12.5, 87.5)] {
            ingest(&p, &callback(json!(used)), 100).unwrap();
            let value = load(&p, 110).unwrap().unwrap();
            assert_eq!(value["observedAt"], 100);
            assert_eq!(value["windows"][0]["remainingPercent"], expected);
            assert!(!value.to_string().contains("PRIVATE"));
        }
        let previous = std::fs::read(p.join(FILE_NAME)).unwrap();
        for bytes in [callback(Value::Null), b"{}".to_vec(), b"{\"rate_limits\":null}".to_vec()] {
            ingest(&p, &bytes, 120).unwrap();
            assert_eq!(std::fs::read(p.join(FILE_NAME)).unwrap(), previous);
        }
        assert_eq!(load(&p, 401).unwrap().unwrap()["reasonCode"], "stale");
        assert_eq!(load(&p, 401).unwrap().unwrap()["observedAt"], 100);
    }

    #[test]
    fn malformed_and_oversized_preserve_valid_file() {
        let d = profile(); let p = path(&d);
        ingest(&p, &callback(json!(25)), 100).unwrap();
        let before = std::fs::read(p.join(FILE_NAME)).unwrap();
        for bytes in [callback(json!(-1)), callback(json!(101)), callback(json!("0")),
            b"PRIVATE invalid".to_vec(), vec![b'x'; MAX_BYTES + 1],
            br#"{"rate_limits":{"five_hour":{"used_percentage":1,"resets_at":"bad"}}}"#.to_vec()] {
            assert!(ingest(&p, &bytes, 101).is_err());
            assert_eq!(std::fs::read(p.join(FILE_NAME)).unwrap(), before);
        }
        assert!(bounded(&vec![0; MAX_BYTES + 1][..]).is_err());
        assert_eq!(bounded(&vec![0; MAX_BYTES][..]).unwrap().len(), MAX_BYTES);
    }

    #[test]
    fn future_reset_expiration_missing_and_forged_cache() {
        let d = profile(); let p = path(&d);
        assert_eq!(read(&p)["reasonCode"], "missing");
        ingest(&p, br#"{"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":110},"seven_day":{"used_percentage":22.25,"resets_at":null}}}"#, 100).unwrap();
        let v = load(&p, 110).unwrap().unwrap();
        assert_eq!(v["windows"].as_array().unwrap().len(), 1);
        assert_eq!(v["windows"][0]["remainingPercent"], 77.75);
        let mut v = load(&p, 100).unwrap().unwrap();
        assert!(validate_snapshot(&v, 99).is_err());
        v["windows"][0]["remainingPercent"] = Value::Null;
        assert!(validate_snapshot(&v, 100).is_err());
        std::fs::write(p.join(FILE_NAME), vec![b'x'; MAX_BYTES+1]).unwrap();
        assert_eq!(read(&p)["reasonCode"], "invalid_cache");
    }

    #[test]
    fn private_permissions_and_unsafe_paths() {
        let d = profile(); let p = path(&d);
        ingest(&p, &callback(json!(0)), 100).unwrap();
        let target = p.join(FILE_NAME);
        assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o7777, 0o600);
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ingest(&p, &callback(json!(1)), 101).is_err());
        assert_eq!(read(&p)["reasonCode"], "invalid_cache");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ingest(&p, &callback(json!(1)), 101).is_err());
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = p.join("directory-link"); symlink(&p, &link).unwrap();
        assert!(directory(&link).is_err());
        assert!(directory(&link.join("nested")).is_err());
        std::fs::hard_link(&target, p.join("hardlink")).unwrap();
        assert!(ingest(&p, &callback(json!(1)), 101).is_err());
        assert_eq!(read(&p)["reasonCode"], "invalid_cache");
        std::fs::remove_file(p.join("hardlink")).unwrap();
        std::fs::remove_file(&target).unwrap();
        symlink(p.join("outside"), &target).unwrap();
        assert!(ingest(&p, &callback(json!(1)), 101).is_err());
        assert!(!p.join("outside").exists());
    }

    #[test]
    fn cached_fields_revalidated_and_only_selected_fields_returned() {
        let d = profile(); let p = path(&d);
        ingest(&p, &callback(json!(7.5)), 100).unwrap();
        let mut original = load(&p, 100).unwrap().unwrap();
        original["secret"] = json!("PRIVATE");
        original["windows"][0]["secret"] = json!("PRIVATE");
        assert!(!validate_snapshot(&original, 100).unwrap().to_string().contains("PRIVATE"));
        for (key, bad) in [("schemaVersion", json!(2)), ("provider", json!("other")),
            ("observedAt", Value::Null), ("status", json!("unavailable"))] {
            let mut value = original.clone(); value[key] = bad;
            assert!(validate_snapshot(&value, 100).is_err());
        }
        for (key, bad) in [("remainingPercent", Value::Null), ("remainingPercent", json!(101)),
            ("windowDurationMins", json!(10080)), ("resetsAt", json!(-1)), ("limitId", json!("other"))] {
            let mut value = original.clone(); value["windows"][0][key] = bad;
            assert!(validate_snapshot(&value, 100).is_err());
        }
        let mut duplicate = original.clone();
        duplicate["windows"].as_array_mut().unwrap().push(original["windows"][0].clone());
        assert!(validate_snapshot(&duplicate, 100).is_err());
        original["windows"][0]["resetsAt"] = json!(101);
        assert_eq!(validate_snapshot(&original, 101).unwrap()["reasonCode"], "expired");
    }

    #[test]
    fn concurrent_snapshots_are_complete_and_latest_commit_wins() {
        let d = profile(); let p = path(&d);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for _ in 0..100 {
                    if let Some(value) = load(&p, 100).unwrap() {
                        assert_eq!(value["status"], "available");
                    }
                }
            });
            for n in 0..12 {
                let p = &p;
                scope.spawn(move || { ingest(p, &callback(json!(n)), 100).unwrap(); });
            }
        });
        assert_eq!(load(&p, 100).unwrap().unwrap()["status"], "available");
        ingest(&p, &callback(json!(88.5)), 101).unwrap();
        let latest = load(&p, 102).unwrap().unwrap();
        assert_eq!(latest["observedAt"], 101);
        assert_eq!(latest["windows"][0]["remainingPercent"], 11.5);
        assert_eq!(std::fs::read_dir(&p).unwrap().count(), 1);
    }

    #[test]
    fn shell_quoting_preserves_malicious_paths_exactly() {
        let d = profile(); let p = path(&d);
        let executable = p.join("runner ' $(touch PWNED) `touch OTHER` ; test\nname");
        let data = p.join("profile ' ; $(touch THIRD)");
        let settings: Value = serde_json::from_str(&super::settings(&executable, &data).unwrap()).unwrap();
        assert_eq!(settings.as_object().unwrap().len(), 1);
        let command = settings["statusLine"]["command"].as_str().unwrap();
        // Evaluate only argument parsing, replacing execution with shell builtins.
        let output = std::process::Command::new("/bin/sh").current_dir(&p)
            .args(["-c", &format!("set -- {command}; printf '%s\\000' \"$@\"")]).output().unwrap();
        assert!(output.status.success());
        let actual: Vec<&[u8]> = output.stdout.split(|b| *b == 0).filter(|b| !b.is_empty()).collect();
        assert_eq!(actual, vec![executable.as_os_str().as_bytes(), b"--quota-hook", b"--data-dir", data.as_os_str().as_bytes()]);
        assert!(!p.join("PWNED").exists() && !p.join("OTHER").exists() && !p.join("THIRD").exists());
        assert!(super::settings(Path::new("relative"), &data).is_err());
    }
}

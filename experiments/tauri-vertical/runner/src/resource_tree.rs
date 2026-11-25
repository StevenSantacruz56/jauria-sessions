//! Read-only, best-effort macOS process-tree observation; no resource totals.
//!
//! Caller supplies its known current GUI/runner PID or an owned, unreaped CLI
//! child, pinned by its lifecycle lock throughout observation AND resource
//! sampling. Never use a persisted PID. These reads establish neither ownership
//! nor authority to signal, reap or otherwise control any returned process.
//!
//! Integration: feed `pids` immediately to ResourcesSampler, then inspect its
//! per-PID availability and CPU warmup (first sample has no CPU interval).
//! Discovery, identity revalidation and resource reads are sequential and
//! provisional, NOT atomic. PID reuse/exit can occur after the last validation;
//! the sampler's own start identity is a separate check, not a transaction with
//! this module. Concurrent polls need caller serialization/lifecycle locking.
//! The parent integrates metrics groups/roles and deduplicates overlapping roots.
//!
//! `pids` includes the root, followed by at most 128 descendants, with a maximum
//! ancestry depth of 32. `available` means a revalidated root is included;
//! `partial` flags detected incompleteness, not a numeric total. Even false
//! cannot rule out concurrent forks/reparenting. `reason`, when present, is the
//! first detected limitation (root failure takes precedence). AppKit/WebKit
//! helpers reparented to launchd or brokers are excluded: no name attribution,
//! and no promise of a whole-application total. Other-UID ancestry is excluded.
//!
//! Inventory is capped at 65,536 PIDs and a cooperative 100ms deadline, checked
//! between kernel calls and traversal steps. A synchronous kernel call cannot
//! be preempted by this deadline. No argv/env/name inspection, logging,
//! persistence, subprocess discovery commands or signals (including signal 0).
//! PROC_PIDTBSDINFO necessarily fills a kernel ABI struct containing other
//! fields: only PID/PPID/effective UID/start time and exit status are inspected;
//! its name/user-data fields are never accessed, copied out or exported.
//!
//! `parents[i]` is the observed PPID of `pids[i]`, so the caller can attribute
//! a descendant to the nearest owned ancestor (e.g. a session leader) without
//! a second inventory. Processes of other users are outside the scope: the
//! kernel denies PROC_PIDTBSDINFO across users (EPERM), so the inventory reads
//! their UID with PROC_PIDT_SHORTBSDINFO and skips them; a process that exits
//! between the listing and its read (ESRCH) is skipped as well. Neither makes
//! the inventory partial: only an unreadable same-user process does.
//!
//! `observe_app` additionally reports `helpers`: same-user processes parented
//! by launchd whose *responsible* process (the kernel's attribution of XPC
//! services, e.g. WebKit WebContent/GPU/Networking, to the app that launched
//! them) is the root. This uses `responsibility_get_pid_responsible_for_pid`,
//! exported by libSystem but undocumented, looked up with dlsym at run time.
//! It is only meaningful when the root is responsible for itself (an app
//! launched by LaunchServices); a binary started from a terminal shares the
//! terminal's responsibility, so `helpersStatus` is then `not_attributable` and
//! no helper is claimed. `unsupported` when the symbol is missing.
//!
//! Responsibility is inherited on fork, so a job a session left behind (its
//! shell exited, it was reparented to launchd) is also "responsible = app".
//! Only system XPC services count as helpers: their executable path, read with
//! proc_pidpath for these launchd-parented candidates only and never exported,
//! is under the system's `/System/Library/…/XPCServices/` (WebKit WebContent,
//! GPU, Networking; Metal, audio…). The rest go to `others`: kernel-attributed
//! to the app but not part of the window. `webkit` lists the helpers whose
//! executable is WebKit's WebContent/GPU/Networking. `helpersStatus` is
//! `included` only when at least one of those was found, else `none_found`
//! (other system services still count as the window's); `disabled` when
//! RESPONSIBILITY_ATTRIBUTION is off.
//!
//! Standalone: only std, libc and serde_json; also usable via `#[path = "..."]`
//! in the GUI bridge. No integration or manifest edits required here.

use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

const PID_CAP: usize = 65_536;
const DESCENDANT_CAP: usize = 128;
const MAX_DEPTH: usize = 32;
const SCOPE: &str = "same_uid_observed_descendants";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Process {
    pid: u32,
    ppid: u32,
    uid: u32,
    // Preserve the kernel pair exactly; no lossy arithmetic or JS conversion.
    start: (u64, u64),
}

/// `read` errors: `process_exited` and `foreign_uid` mean "outside the scope"
/// during inventory; any other error is an unreadable process (partial).
trait Source {
    fn expired(&self) -> bool;
    fn read(&mut self, pid: u32) -> Result<Process, &'static str>;
    fn list(&mut self) -> Result<Vec<u32>, &'static str>;
    /// The kernel's responsible PID; None when unknown or unsupported.
    fn responsible(&mut self, pid: u32) -> Option<u32>;
    fn responsibility_supported(&self) -> bool;
    /// False when RESPONSIBILITY_ATTRIBUTION is off: the private API is never called.
    fn attribution_enabled(&self) -> bool;
    /// What the executable is (system XPC service, WebKit's or not); None when unreadable.
    fn service(&mut self, pid: u32) -> Option<Service>;
}

/// Single switch for the window's helper attribution, which relies on the
/// undocumented `responsibility_get_pid_responsible_for_pid`. Set to `false`
/// to ship without it: `observe_app` then reports `helpersStatus: "disabled"`
/// (no helpers, no others), and the view says the web engine is not included
/// and marks the total as partial. Pending Steven's decision on the private API.
pub const RESPONSIBILITY_ATTRIBUTION: bool = true;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Service { WebKit, System, Other }

/// System XPC service executables (also in the OS cryptex used by Rapid
/// Security Responses). Compared only, never exported.
fn service_of_path(path: &str) -> Service {
    let system = ["/System/Library/", "/System/Cryptexes/OS/System/Library/", "/System/Volumes/Preboot/Cryptexes/OS/System/Library/"]
        .iter().any(|prefix| path.starts_with(prefix))
        && path.contains(".xpc/Contents/MacOS/") && path.contains("/XPCServices/");
    if !system { return Service::Other; }
    // WebContent (and its variants), GPU and Networking of WebKit.framework.
    let webkit = path.contains("/WebKit.framework/") && path.rsplit('/').next()
        .is_some_and(|name| ["com.apple.WebKit.WebContent", "com.apple.WebKit.GPU", "com.apple.WebKit.Networking"].iter().any(|p| name.starts_with(p)));
    if webkit { Service::WebKit } else { Service::System }
}

fn output(root: u32, selected: Vec<Process>, reason: Option<&'static str>) -> Value {
    let pids: Vec<u32> = selected.iter().map(|p| p.pid).collect();
    let parents: Vec<u32> = selected.iter().map(|p| p.ppid).collect();
    let mut value = json!({
        "root": root,
        "available": !pids.is_empty(),
        "pids": pids,
        "parents": parents,
        "partial": reason.is_some(),
        "scope": SCOPE,
    });
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    }
    value
}

/// Map every observed PID to the label of its nearest labelled ancestor (itself
/// included), walking `parents` within the observed tree only. PIDs with no
/// labelled ancestor are absent. Labels are attribution, never authority.
pub fn nearest_labels(tree: &Value, labels: &HashMap<u32, String>) -> HashMap<u32, String> {
    let pids: Vec<u32> = tree["pids"].as_array().into_iter().flatten()
        .filter_map(|p| p.as_u64().map(|p| p as u32)).collect();
    let parents: Vec<u32> = tree["parents"].as_array().into_iter().flatten()
        .filter_map(|p| p.as_u64().map(|p| p as u32)).collect();
    if pids.len() != parents.len() { return HashMap::new(); }
    let parent: HashMap<u32, u32> = pids.iter().copied().zip(parents).collect();
    let mut out = HashMap::new();
    for &pid in &pids {
        let mut current = pid;
        // The tree is acyclic after selection; the depth cap still bounds it.
        for _ in 0..=MAX_DEPTH + 1 {
            if let Some(label) = labels.get(&current) { out.insert(pid, label.clone()); break; }
            match parent.get(&current) { Some(&next) => current = next, None => break }
        }
    }
    out
}

fn valid_pid(pid: u32) -> bool {
    pid != 0 && pid <= i32::MAX as u32
}

/// Observe only current same-effective-UID ancestry; see module contract.
/// Used by the runner (the GUI bridge uses `observe_app`).
#[allow(dead_code)]
pub fn observe(root: u32) -> Value {
    observe_root(root, false)
}

/// `observe` plus the launchd-parented helpers the kernel attributes to `root`.
/// Used by the GUI bridge (this file is shared with it by `#[path]`).
#[allow(dead_code)]
pub fn observe_app(root: u32) -> Value {
    observe_root(root, true)
}

fn observe_root(root: u32, helpers: bool) -> Value {
    if !valid_pid(root) {
        return output(root, vec![], Some("invalid_root"));
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: geteuid has no arguments, memory access or side effects.
        let uid = unsafe { libc::geteuid() };
        let mut source = Kernel { uid, attribution: RESPONSIBILITY_ATTRIBUTION, deadline: std::time::Instant::now()
            + std::time::Duration::from_millis(100) };
        observe_with(root, uid, &mut source, helpers)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = helpers;
        output(root, vec![], Some("unsupported_platform"))
    }
}

fn observe_with(root: u32, uid: u32, source: &mut impl Source, helpers: bool) -> Value {
    let fail = |reason| {
        let mut value = output(root, vec![], Some(reason));
        if helpers { value["helpers"] = json!([]); value["webkit"] = json!([]); value["others"] = json!([]); value["helpersStatus"] = json!("unavailable"); }
        value
    };
    if !valid_pid(root) {
        return fail("invalid_root");
    }
    if source.expired() {
        return fail("deadline");
    }
    let initial = match source.read(root) {
        Ok(p) if p.pid == root && p.uid == uid => p,
        Ok(_) => return fail("root_identity_or_uid_mismatch"),
        Err(_) => return fail("root_unavailable"),
    };
    if source.expired() {
        return fail("deadline");
    }
    let inventory = match source.list() {
        Ok(pids) => pids,
        Err(reason) => return fail(reason),
    };
    let mut reason = (inventory.len() >= PID_CAP).then_some("pid_cap");
    let mut forest = HashMap::new();
    let mut seen = HashSet::new();
    for pid in inventory.into_iter().take(PID_CAP) {
        if source.expired() {
            return fail("deadline");
        }
        if !valid_pid(pid) || !seen.insert(pid) {
            continue;
        }
        match source.read(pid) {
            Ok(p) if p.pid == pid && p.uid == uid => { forest.insert(pid, p); }
            Ok(p) if p.pid == pid => {} // Different UID is outside this scope.
            // Another user's process (denied across users) or one that exited
            // after the listing cannot belong to this tree: not incompleteness.
            Err("foreign_uid" | "process_exited") => {}
            _ => { reason.get_or_insert("inventory_incomplete"); }
        }
    }
    // Helpers: launchd-parented, same user, and attributed by the kernel to a
    // root that is responsible for itself. Never inferred from names.
    let helper_status = if !helpers { None }
        else if !source.attribution_enabled() { Some("disabled") }
        else if !source.responsibility_supported() { Some("unsupported") }
        else if source.responsible(root) != Some(root) { Some("not_attributable") }
        else { Some("included") };
    let mut helper_candidates = Vec::new();
    if helper_status == Some("included") {
        let mut candidates: Vec<Process> = forest.values()
            .filter(|p| p.pid != root && p.ppid == 1).copied().collect();
        candidates.sort_unstable_by_key(|p| p.pid);
        for process in candidates {
            if source.expired() {
                return fail("deadline");
            }
            if source.responsible(process.pid) == Some(root) { helper_candidates.push(process); }
        }
    }
    // Do not quietly insert the root into an inventory that missed/reused it.
    if forest.get(&root) != Some(&initial) {
        return fail("root_missing_or_changed");
    }
    let selected = select(&forest, initial, source, &mut reason);
    // Validate every identity AND PPID before export. Children whose ancestor
    // failed revalidation are excluded even if their own metadata still matches.
    let mut validated = HashSet::new();
    let mut kept = Vec::new();
    for process in selected {
        if source.expired() {
            return fail("deadline");
        }
        if process.pid != root && !validated.contains(&process.ppid) {
            reason.get_or_insert("ancestor_changed");
            continue;
        }
        match source.read(process.pid) {
            Ok(current) if current == process => {
                validated.insert(process.pid);
                kept.push(process);
            }
            _ if process.pid == root => return fail("root_changed_or_exited"),
            _ => { reason.get_or_insert("descendant_changed_or_exited"); }
        }
    }
    // A helper that exited or changed since the inventory is simply dropped.
    // Only system XPC services are the window's; the rest (e.g. a job a
    // session left behind) are reported apart, never as the web engine.
    let mut helper_pids = Vec::new();
    let mut webkit_pids = Vec::new();
    let mut other_pids = Vec::new();
    for process in helper_candidates {
        if source.expired() {
            return fail("deadline");
        }
        if source.read(process.pid) == Ok(process) && source.responsible(process.pid) == Some(root) {
            match source.service(process.pid) {
                Some(Service::WebKit) => { helper_pids.push(process.pid); webkit_pids.push(process.pid); }
                Some(Service::System) => helper_pids.push(process.pid),
                _ => other_pids.push(process.pid),
            }
        }
    }
    if source.expired() {
        return fail("deadline");
    }
    // Bracket the entire observation with the caller-pinned root identity.
    if source.read(root) != Ok(initial) {
        return fail("root_changed_or_exited");
    }
    if source.expired() {
        return fail("deadline");
    }
    let mut value = output(root, kept, reason);
    if let Some(status) = helper_status {
        // «included» only when a WebKit process was found and counted; other
        // system services (Metal, audio…) still count as the window's.
        let status = if status == "included" && webkit_pids.is_empty() { "none_found" } else { status };
        value["helpers"] = json!(helper_pids);
        value["webkit"] = json!(webkit_pids);
        value["others"] = json!(other_pids);
        value["helpersStatus"] = json!(status);
    }
    value
}

// Pure forest selection apart from the injected budget check. BFS guarantees
// ancestors precede children during revalidation, with deterministic PID order.
fn select(
    forest: &HashMap<u32, Process>,
    root: Process,
    source: &impl Source,
    reason: &mut Option<&'static str>,
) -> Vec<Process> {
    let mut children: HashMap<u32, Vec<Process>> = HashMap::new();
    for &process in forest.values() {
        if source.expired() {
            reason.get_or_insert("deadline");
            return vec![];
        }
        children.entry(process.ppid).or_default().push(process);
    }
    for siblings in children.values_mut() {
        siblings.sort_unstable_by_key(|p| p.pid);
    }
    let mut queue = VecDeque::from([(root, 0)]);
    let mut visited = HashSet::from([root.pid]);
    let mut selected = vec![root];
    while let Some((parent, depth)) = queue.pop_front() {
        if source.expired() {
            reason.get_or_insert("deadline");
            break;
        }
        for &child in children.get(&parent.pid).into_iter().flatten() {
            if source.expired() {
                reason.get_or_insert("deadline");
                return selected;
            }
            if visited.contains(&child.pid) {
                reason.get_or_insert("ancestry_cycle");
                continue;
            }
            // A child older than its observed parent suggests parent PID reuse.
            if child.start < parent.start {
                reason.get_or_insert("ancestor_identity_inconsistent");
                continue;
            }
            if depth >= MAX_DEPTH {
                reason.get_or_insert("depth_cap");
                continue;
            }
            if selected.len() > DESCENDANT_CAP {
                reason.get_or_insert("descendant_cap");
                return selected;
            }
            visited.insert(child.pid);
            selected.push(child);
            queue.push_back((child, depth + 1));
        }
    }
    selected
}

#[cfg(target_os = "macos")]
struct Kernel {
    uid: u32,
    /// RESPONSIBILITY_ATTRIBUTION; false never resolves nor calls the private API.
    attribution: bool,
    deadline: std::time::Instant,
}

/// `pid_t responsibility_get_pid_responsible_for_pid(pid_t)`, resolved once.
#[cfg(target_os = "macos")]
fn responsibility_fn() -> Option<extern "C" fn(libc::pid_t) -> libc::pid_t> {
    static ADDRESS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let address = *ADDRESS.get_or_init(|| {
        // SAFETY: NUL-terminated literal; RTLD_DEFAULT searches loaded images.
        unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) as usize }
    });
    // SAFETY: the libSystem symbol has this C signature (pid in, pid out).
    (address != 0).then(|| unsafe { std::mem::transmute::<usize, extern "C" fn(libc::pid_t) -> libc::pid_t>(address) })
}

#[cfg(target_os = "macos")]
impl Source for Kernel {
    fn expired(&self) -> bool {
        std::time::Instant::now() >= self.deadline
    }

    fn list(&mut self) -> Result<Vec<u32>, &'static str> {
        // Fixed cap, no count-then-allocate race or unbounded retry. An exactly
        // full buffer is conservatively partial, even if nothing was omitted.
        let mut buffer = vec![0_i32; PID_CAP];
        let bytes = (buffer.len() * std::mem::size_of::<i32>()) as i32;
        // SAFETY: writable, aligned allocation of exactly `bytes` bytes. The
        // return value is a PID count (not bytes), per libproc.h/libproc.c.
        let count = unsafe { libc::proc_listallpids(buffer.as_mut_ptr().cast(), bytes) };
        if count <= 0 || count as usize > buffer.len() {
            return Err("inventory_unavailable");
        }
        buffer.truncate(count as usize);
        Ok(buffer.into_iter().map(|pid| pid as u32).collect())
    }

    fn read(&mut self, pid: u32) -> Result<Process, &'static str> {
        if !valid_pid(pid) {
            return Err("invalid_pid");
        }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: signed-range PID and exact writable ABI buffer; no argv/env
        // API. Only a complete successful struct may be inspected below.
        let count = unsafe {
            libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0,
                info.as_mut_ptr().cast(), size)
        };
        if count != size {
            let errno = std::io::Error::last_os_error().raw_os_error();
            if errno == Some(libc::ESRCH) {
                return Err("process_exited");
            }
            if errno == Some(libc::EPERM) {
                // Cross-user reads of the full struct are denied; the short
                // struct still carries the UID (its name field is not read).
                let mut short = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
                let short_size = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
                // SAFETY: as above, exact writable buffer for this flavor.
                let read = unsafe {
                    libc::proc_pidinfo(pid as i32, libc::PROC_PIDT_SHORTBSDINFO, 0,
                        short.as_mut_ptr().cast(), short_size)
                };
                if read == short_size {
                    // SAFETY: exact-size successful kernel result.
                    let short = unsafe { short.assume_init() };
                    if short.pbsi_pid == pid && short.pbsi_uid != self.uid {
                        return Err("foreign_uid");
                    }
                }
            }
            return Err("metadata_unavailable");
        }
        // SAFETY: exact-size successful kernel result, integer/byte-array fields.
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid || info.pbi_status == libc::SZOMB {
            return Err("process_changed_or_exited");
        }
        if info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
            return Err("identity_unavailable");
        }
        Ok(Process {
            pid: info.pbi_pid, ppid: info.pbi_ppid, uid: info.pbi_uid,
            start: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }

    fn responsible(&mut self, pid: u32) -> Option<u32> {
        if !self.attribution { return None; }
        let f = responsibility_fn()?;
        if !valid_pid(pid) { return None; }
        let responsible = f(pid as libc::pid_t);
        (responsible > 0).then_some(responsible as u32)
    }

    fn responsibility_supported(&self) -> bool {
        self.attribution && responsibility_fn().is_some()
    }

    fn attribution_enabled(&self) -> bool { self.attribution }

    fn service(&mut self, pid: u32) -> Option<Service> {
        if !valid_pid(pid) { return None; }
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: writable buffer of exactly the size passed; returns bytes written.
        let written = unsafe { libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if written <= 0 || written as usize > buffer.len() { return None; }
        let path = std::str::from_utf8(&buffer[..written as usize]).ok()?;
        Some(service_of_path(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        forest: HashMap<u32, Process>,
        inventory: Option<Vec<u32>>,
        reads: HashMap<u32, usize>,
        change: Option<(u32, usize, Option<Process>)>,
        expired: bool,
        expire_after_reads: Option<usize>,
        /// Read errors returned for listed PIDs absent from the forest.
        errors: HashMap<u32, &'static str>,
        /// Kernel responsibility; None models a missing symbol.
        responsible: Option<HashMap<u32, u32>>,
        /// Executable kind per PID; absent PIDs are not system services.
        services: HashMap<u32, Service>,
        /// RESPONSIBILITY_ATTRIBUTION for the fixture.
        attribution: bool,
    }

    fn p(pid: u32, ppid: u32) -> Process {
        Process { pid, ppid, uid: 7, start: (100, 0) }
    }

    fn fixture(processes: &[Process]) -> Fixture {
        Fixture { forest: processes.iter().map(|p| (p.pid, *p)).collect(),
            inventory: None, reads: HashMap::new(), change: None, expired: false,
            expire_after_reads: None, errors: HashMap::new(), responsible: None, services: HashMap::new(), attribution: true }
    }

    impl Source for Fixture {
        fn expired(&self) -> bool { self.expired }
        fn list(&mut self) -> Result<Vec<u32>, &'static str> {
            if let Some(pids) = &self.inventory {
                return Ok(pids.clone());
            }
            let mut pids: Vec<_> = self.forest.keys().copied().collect();
            pids.sort_unstable();
            Ok(pids)
        }
        fn read(&mut self, pid: u32) -> Result<Process, &'static str> {
            if let Some(limit) = self.expire_after_reads {
                self.expired = self.reads.values().sum::<usize>() + 1 >= limit;
            }
            let count = self.reads.entry(pid).or_default();
            *count += 1;
            if let Some((target, at, replacement)) = self.change {
                if target == pid && *count >= at {
                    return replacement.ok_or("exited");
                }
            }
            if let Some(error) = self.errors.get(&pid) {
                return Err(error);
            }
            self.forest.get(&pid).copied().ok_or("missing")
        }
        fn responsible(&mut self, pid: u32) -> Option<u32> {
            self.responsible.as_ref()?.get(&pid).copied()
        }
        fn responsibility_supported(&self) -> bool { self.responsible.is_some() }
        fn attribution_enabled(&self) -> bool { self.attribution }
        fn service(&mut self, pid: u32) -> Option<Service> { Some(self.services.get(&pid).copied().unwrap_or(Service::Other)) }
    }

    #[test]
    fn only_system_xpc_paths_are_window_services_and_only_webkit_ones_are_the_web_engine() {
        for path in ["/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
            "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.EnhancedSecurity.xpc/Contents/MacOS/com.apple.WebKit.WebContent.EnhancedSecurity",
            "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking",
            "/System/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU"] {
            assert_eq!(service_of_path(path), Service::WebKit, "{path}");
        }
        for path in ["/System/Library/Frameworks/Metal.framework/Versions/A/XPCServices/MTLCompilerService.xpc/Contents/MacOS/MTLCompilerService",
            "/System/Library/Frameworks/AudioToolbox.framework/XPCServices/com.apple.audio.SandboxHelper.xpc/Contents/MacOS/com.apple.audio.SandboxHelper",
            "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Other.xpc/Contents/MacOS/com.apple.WebKit.Other"] {
            assert_eq!(service_of_path(path), Service::System, "{path}");
        }
        for path in ["/bin/sleep", "/opt/homebrew/bin/node", "/Applications/Jauria.app/Contents/MacOS/aw-vertical-desktop",
            "/Users/x/System/Library/Fake.xpc/Contents/MacOS/x", "/Applications/Other.app/Contents/XPCServices/A.xpc/Contents/MacOS/A",
            "/Applications/X.app/Contents/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"] {
            assert_eq!(service_of_path(path), Service::Other, "{path}");
        }
    }

    #[test]
    fn included_requires_a_webkit_process_and_the_switch_can_turn_attribution_off() {
        let processes = [p(5, 1), p(10, 1), p(11, 1)];
        // Only Metal/audio-like services: counted as helpers, but the web engine was not found.
        let mut f = fixture(&processes);
        f.responsible = Some(HashMap::from([(5, 5), (10, 5), (11, 5)]));
        f.services = HashMap::from([(10, Service::System), (11, Service::System)]);
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!(value["helpers"], json!([10, 11]));
        assert_eq!(value["webkit"], json!([]));
        assert_eq!(value["helpersStatus"], "none_found");
        f.services.insert(11, Service::WebKit);
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!((value["helpersStatus"].clone(), value["webkit"].clone()), (json!("included"), json!([11])));
        // RESPONSIBILITY_ATTRIBUTION = false: the private API is never asked.
        let mut f = fixture(&processes);
        f.attribution = false;
        f.responsible = Some(HashMap::from([(5, 5), (10, 5), (11, 5)]));
        f.services = HashMap::from([(10, Service::WebKit)]);
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!(value["helpersStatus"], "disabled");
        assert_eq!((value["helpers"].clone(), value["others"].clone()), (json!([]), json!([])));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn kernel_with_attribution_off_never_resolves_responsibility() {
        // SAFETY: no arguments or side effects.
        let uid = unsafe { libc::geteuid() };
        let mut kernel = Kernel { uid, attribution: false, deadline: std::time::Instant::now() + std::time::Duration::from_secs(1) };
        assert!(!kernel.responsibility_supported() && !kernel.attribution_enabled());
        assert_eq!(kernel.responsible(std::process::id()), None);
        assert_eq!(observe_with(std::process::id(), uid, &mut kernel, true)["helpersStatus"], "disabled");
    }

    #[test]
    fn descendants_take_the_label_of_their_nearest_labelled_ancestor() {
        // runner 1 → session leaders 2 (a) and 3 (b); 4 under 2; 5 under 4;
        // 6 is a runner helper without a session.
        let value = observe_with(1, 7, &mut fixture(&[p(1, 0), p(2, 1), p(3, 1), p(4, 2), p(5, 4), p(6, 1)]), false);
        let labels = HashMap::from([(2, "a".to_owned()), (3, "b".to_owned())]);
        let got = nearest_labels(&value, &labels);
        assert_eq!(got.get(&2).map(String::as_str), Some("a"));
        assert_eq!(got.get(&4).map(String::as_str), Some("a"));
        assert_eq!(got.get(&5).map(String::as_str), Some("a"));
        assert_eq!(got.get(&3).map(String::as_str), Some("b"));
        assert!(!got.contains_key(&1) && !got.contains_key(&6));
        assert!(nearest_labels(&json!({"pids":[1,2],"parents":[0]}), &labels).is_empty());
    }

    #[test]
    fn other_users_and_exited_processes_do_not_make_the_inventory_partial() {
        // The idle false positive: every root/system process used to fail its
        // read (EPERM across users) and flag the whole inventory as partial.
        let mut f = fixture(&[p(1, 0), p(2, 1)]);
        f.inventory = Some(vec![1, 2, 50, 51, 52]);
        f.errors = HashMap::from([(50, "foreign_uid"), (51, "foreign_uid"), (52, "process_exited")]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["pids"], json!([1, 2]));
        assert_eq!(value["parents"], json!([0, 1]));
        assert_eq!(value["partial"], false, "{value}");
        // A same-user process that cannot be read still is incompleteness.
        f.errors.insert(53, "metadata_unavailable");
        f.inventory = Some(vec![1, 2, 50, 53]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["reason"], "inventory_incomplete");
    }

    #[test]
    fn helpers_require_a_self_responsible_root_and_launchd_parent() {
        // 5: app launched by launchd (PID 1) and responsible for itself; 6: its
        // child; 10, 11: launchd-parented helpers attributed to the app; 12:
        // another app's helper; 13: app-attributed but already in the tree.
        // 14: a job a session left behind (reparented to launchd, responsible
        // still the app by fork inheritance) but not a system XPC service.
        let processes = [p(5, 1), p(6, 5), p(10, 1), p(11, 1), p(12, 1), p(13, 6), p(14, 1)];
        let mut f = fixture(&processes);
        f.responsible = Some(HashMap::from([(5, 5), (6, 5), (10, 5), (11, 5), (12, 99), (13, 5), (14, 5)]));
        f.services = HashMap::from([(10, Service::WebKit), (11, Service::System), (12, Service::WebKit)]);
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!(value["pids"], json!([5, 6, 13]));
        assert_eq!(value["helpersStatus"], "included");
        assert_eq!(value["helpers"], json!([10, 11]));
        assert_eq!(value["others"], json!([14]), "an orphan is never counted as the web engine");
        assert_eq!(value["partial"], false);
        // Self-responsible root but no service found: not «included».
        let mut f = fixture(&processes);
        f.responsible = Some(HashMap::from([(5, 5), (14, 5)]));
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!(value["helpersStatus"], "none_found");
        assert_eq!(value["helpers"], json!([]));
        assert_eq!(value["others"], json!([14]));
        // A helper that changes before revalidation is dropped, silently.
        let mut f = fixture(&processes);
        f.services = HashMap::from([(10, Service::WebKit), (11, Service::WebKit)]);
        f.responsible = Some(HashMap::from([(5, 5), (10, 5), (11, 5)]));
        f.change = Some((11, 2, None));
        assert_eq!(observe_with(5, 7, &mut f, true)["helpers"], json!([10]));
        // Started from a terminal (responsible is the terminal): nothing claimed.
        let mut f = fixture(&processes);
        f.responsible = Some(HashMap::from([(5, 500), (10, 500)]));
        let value = observe_with(5, 7, &mut f, true);
        assert_eq!(value["helpersStatus"], "not_attributable");
        assert_eq!(value["helpers"], json!([]));
        let value = observe_with(5, 7, &mut fixture(&processes), true);
        assert_eq!(value["helpersStatus"], "unsupported");
        assert!(observe_with(5, 7, &mut fixture(&processes), false).get("helpers").is_none());
    }

    #[test]
    fn forest_is_deterministic_and_filters_uid_and_disconnected_ancestry() {
        let mut foreign = p(4, 1);
        foreign.uid = 8;
        let mut f = fixture(&[p(1, 0), p(3, 2), p(2, 1), foreign,
            p(5, 4), p(6, 0), p(8, 9), p(9, 8)]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["pids"], json!([1, 2, 3]));
        assert_eq!(value["available"], true);
        assert_eq!(value["partial"], false);
        assert_eq!(value["scope"], SCOPE);
        assert_eq!(value["parents"], json!([0, 1, 2]));
        assert_eq!(value.as_object().unwrap().len(), 6);
    }

    #[test]
    fn cycles_are_bounded_and_partial() {
        let value = observe_with(1, 7, &mut fixture(&[p(1, 2), p(2, 1)]), false);
        assert_eq!(value["pids"], json!([1, 2]));
        assert_eq!(value["reason"], "ancestry_cycle");
    }

    #[test]
    fn root_missing_foreign_or_invalid_has_no_available_pids() {
        for root in [0, u32::MAX, 99] {
            let value = observe_with(root, 7, &mut fixture(&[p(1, 0)]), false);
            assert_eq!(value["pids"], json!([]));
            assert_eq!(value["available"], false);
            assert_eq!(value["partial"], true);
        }
        let value = observe_with(1, 8, &mut fixture(&[p(1, 0)]), false);
        assert_eq!(value["available"], false);
    }

    #[test]
    fn root_reuse_or_exit_at_every_reread_discards_entire_tree() {
        for at in [2, 3, 4] {
            for replacement in [None, Some(Process { start: (101, 0), ..p(1, 0) })] {
                let mut f = fixture(&[p(1, 0), p(2, 1)]);
                f.change = Some((1, at, replacement));
                let value = observe_with(1, 7, &mut f, false);
                assert_eq!(value["pids"], json!([]), "{value}");
                assert_eq!(value["partial"], true);
            }
        }
    }

    #[test]
    fn incomplete_inventory_never_claims_complete_coverage() {
        let mut f = fixture(&[p(1, 0), p(2, 1)]);
        f.inventory = Some(vec![2]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["reason"], "root_missing_or_changed");
        assert_eq!(value["pids"], json!([]));

        f.inventory = Some(vec![1, 2, 99]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["pids"], json!([1, 2]));
        assert_eq!(value["reason"], "inventory_incomplete");

        // A full buffer is partial even if duplicates reduce the selected set.
        // No OS processes are created for this cap test.
        f.inventory = Some(vec![1; PID_CAP]);
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["pids"], json!([1]));
        assert_eq!(value["reason"], "pid_cap");
    }

    #[test]
    fn deadline_during_inventory_or_revalidation_discards_candidates() {
        for limit in 1..=8 {
            let mut f = fixture(&[p(1, 0), p(2, 1), p(3, 2)]);
            f.expire_after_reads = Some(limit);
            let value = observe_with(1, 7, &mut f, false);
            assert_eq!(value["pids"], json!([]), "limit={limit}: {value}");
            assert_eq!(value["reason"], "deadline");
        }
    }

    #[test]
    fn changed_or_exited_ancestor_prunes_its_subtree() {
        for replacement in [None, Some(Process { start: (101, 0), ..p(2, 1) }),
            Some(p(2, 99)), Some(Process { uid: 8, ..p(2, 1) })] {
            let mut f = fixture(&[p(1, 0), p(2, 1), p(3, 2), p(4, 1)]);
            f.change = Some((2, 2, replacement));
            let value = observe_with(1, 7, &mut f, false);
            assert_eq!(value["pids"], json!([1, 4]));
            assert_eq!(value["partial"], true);
        }
    }

    #[test]
    fn older_child_cannot_attach_to_reused_parent() {
        let older = Process { start: (99, 0), ..p(2, 1) };
        let value = observe_with(1, 7, &mut fixture(&[p(1, 0), older]), false);
        assert_eq!(value["pids"], json!([1]));
        assert_eq!(value["reason"], "ancestor_identity_inconsistent");
    }

    #[test]
    fn depth_and_descendant_caps_and_deadline_are_explicit() {
        let chain: Vec<_> = (1..=35).map(|pid| p(pid, pid - 1)).collect();
        let value = observe_with(1, 7, &mut fixture(&chain), false);
        assert_eq!(value["pids"].as_array().unwrap().len(), 33);
        assert_eq!(value["reason"], "depth_cap");
        let mut wide = vec![p(1, 0)];
        wide.extend((2..=131).map(|pid| p(pid, 1)));
        let value = observe_with(1, 7, &mut fixture(&wide), false);
        assert_eq!(value["pids"].as_array().unwrap().len(), 129);
        assert_eq!(value["reason"], "descendant_cap");
        let mut f = fixture(&[p(1, 0)]);
        f.expired = true;
        let value = observe_with(1, 7, &mut f, false);
        assert_eq!(value["reason"], "deadline");
        assert_eq!(value["available"], false);
        assert!(f.reads.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_owned_sleep_child_without_signals_or_load() {
        // Owned and unreaped until wait; naturally exits in <1s, no kill even
        // for cleanup. Collect results first, reap before assertions can panic.
        let mut child = std::process::Command::new("/bin/sleep").arg("0.3")
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()).spawn().unwrap();
        let child_pid = child.id();
        let value = observe(std::process::id());
        let owned = observe(child_pid);
        let status = child.wait().unwrap();
        assert!(status.success());
        assert_eq!(value["available"], true, "{value}");
        assert!(value["pids"].as_array().unwrap().contains(&json!(child_pid)), "{value}");
        // Other users' processes (root daemons, always present) are not an
        // incomplete inventory. Parallel tests may still race descendants.
        assert_ne!(value["reason"], "inventory_incomplete", "{value}");
        assert_eq!(value["parents"].as_array().unwrap().len(), value["pids"].as_array().unwrap().len());
        assert_eq!(owned["pids"], json!([child_pid]), "{owned}");
        let exited = observe(child_pid);
        assert_eq!(exited["available"], false);
        assert_eq!(exited["partial"], true);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_launchd_is_another_user_not_an_unreadable_process() {
        // SAFETY: no arguments or side effects.
        let uid = unsafe { libc::geteuid() };
        if uid == 0 { return; } // root reads every process; nothing to show.
        let mut kernel = Kernel { uid, attribution: true, deadline: std::time::Instant::now() + std::time::Duration::from_secs(1) };
        assert_eq!(kernel.read(1), Err("foreign_uid"));
        assert_eq!(kernel.read(i32::MAX as u32), Err("process_exited"));
        let own = std::process::id();
        assert_eq!(kernel.read(own).map(|p| p.pid), Ok(own));
        // A test binary started by cargo is not responsible for itself.
        if kernel.responsibility_supported() {
            assert_ne!(kernel.responsible(own), None);
            assert_eq!(observe_app(own)["helpersStatus"], "not_attributable");
        }
    }

    /// Manual check against a WKWebView app you launched with `open` (not a
    /// terminal): `JAURIA_OBSERVE_APP_PID=<pid> cargo test observe_app_manual
    /// -- --ignored --nocapture`, then compare `helpers` with `ps -o pid,ppid`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn observe_app_manual() {
        let pid: u32 = std::env::var("JAURIA_OBSERVE_APP_PID").unwrap().parse().unwrap();
        println!("{}", observe_app(pid));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_are_explicitly_unavailable() {
        assert_eq!(observe(1)["reason"], "unsupported_platform");
    }
}

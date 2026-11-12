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

trait Source {
    fn expired(&self) -> bool;
    fn read(&mut self, pid: u32) -> Result<Process, &'static str>;
    fn list(&mut self) -> Result<Vec<u32>, &'static str>;
}

fn output(root: u32, pids: Vec<u32>, reason: Option<&'static str>) -> Value {
    let mut value = json!({
        "root": root,
        "available": !pids.is_empty(),
        "pids": pids,
        "partial": reason.is_some(),
        "scope": SCOPE,
    });
    if let Some(reason) = reason {
        value["reason"] = json!(reason);
    }
    value
}

fn valid_pid(pid: u32) -> bool {
    pid != 0 && pid <= i32::MAX as u32
}

/// Observe only current same-effective-UID ancestry; see module contract.
pub fn observe(root: u32) -> Value {
    if !valid_pid(root) {
        return output(root, vec![], Some("invalid_root"));
    }
    #[cfg(target_os = "macos")]
    {
        let mut source = Kernel { deadline: std::time::Instant::now()
            + std::time::Duration::from_millis(100) };
        // SAFETY: geteuid has no arguments, memory access or side effects.
        observe_with(root, unsafe { libc::geteuid() }, &mut source)
    }
    #[cfg(not(target_os = "macos"))]
    output(root, vec![], Some("unsupported_platform"))
}

fn observe_with(root: u32, uid: u32, source: &mut impl Source) -> Value {
    let fail = |reason| output(root, vec![], Some(reason));
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
            _ => { reason.get_or_insert("inventory_incomplete"); }
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
    let mut pids = Vec::new();
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
                pids.push(process.pid);
            }
            _ if process.pid == root => return fail("root_changed_or_exited"),
            _ => { reason.get_or_insert("descendant_changed_or_exited"); }
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
    output(root, pids, reason)
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
    deadline: std::time::Instant,
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
    }

    fn p(pid: u32, ppid: u32) -> Process {
        Process { pid, ppid, uid: 7, start: (100, 0) }
    }

    fn fixture(processes: &[Process]) -> Fixture {
        Fixture { forest: processes.iter().map(|p| (p.pid, *p)).collect(),
            inventory: None, reads: HashMap::new(), change: None, expired: false,
            expire_after_reads: None }
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
            self.forest.get(&pid).copied().ok_or("missing")
        }
    }

    #[test]
    fn forest_is_deterministic_and_filters_uid_and_disconnected_ancestry() {
        let mut foreign = p(4, 1);
        foreign.uid = 8;
        let mut f = fixture(&[p(1, 0), p(3, 2), p(2, 1), foreign,
            p(5, 4), p(6, 0), p(8, 9), p(9, 8)]);
        let value = observe_with(1, 7, &mut f);
        assert_eq!(value["pids"], json!([1, 2, 3]));
        assert_eq!(value["available"], true);
        assert_eq!(value["partial"], false);
        assert_eq!(value["scope"], SCOPE);
        assert_eq!(value.as_object().unwrap().len(), 5);
    }

    #[test]
    fn cycles_are_bounded_and_partial() {
        let value = observe_with(1, 7, &mut fixture(&[p(1, 2), p(2, 1)]));
        assert_eq!(value["pids"], json!([1, 2]));
        assert_eq!(value["reason"], "ancestry_cycle");
    }

    #[test]
    fn root_missing_foreign_or_invalid_has_no_available_pids() {
        for root in [0, u32::MAX, 99] {
            let value = observe_with(root, 7, &mut fixture(&[p(1, 0)]));
            assert_eq!(value["pids"], json!([]));
            assert_eq!(value["available"], false);
            assert_eq!(value["partial"], true);
        }
        let value = observe_with(1, 8, &mut fixture(&[p(1, 0)]));
        assert_eq!(value["available"], false);
    }

    #[test]
    fn root_reuse_or_exit_at_every_reread_discards_entire_tree() {
        for at in [2, 3, 4] {
            for replacement in [None, Some(Process { start: (101, 0), ..p(1, 0) })] {
                let mut f = fixture(&[p(1, 0), p(2, 1)]);
                f.change = Some((1, at, replacement));
                let value = observe_with(1, 7, &mut f);
                assert_eq!(value["pids"], json!([]), "{value}");
                assert_eq!(value["partial"], true);
            }
        }
    }

    #[test]
    fn incomplete_inventory_never_claims_complete_coverage() {
        let mut f = fixture(&[p(1, 0), p(2, 1)]);
        f.inventory = Some(vec![2]);
        let value = observe_with(1, 7, &mut f);
        assert_eq!(value["reason"], "root_missing_or_changed");
        assert_eq!(value["pids"], json!([]));

        f.inventory = Some(vec![1, 2, 99]);
        let value = observe_with(1, 7, &mut f);
        assert_eq!(value["pids"], json!([1, 2]));
        assert_eq!(value["reason"], "inventory_incomplete");

        // A full buffer is partial even if duplicates reduce the selected set.
        // No OS processes are created for this cap test.
        f.inventory = Some(vec![1; PID_CAP]);
        let value = observe_with(1, 7, &mut f);
        assert_eq!(value["pids"], json!([1]));
        assert_eq!(value["reason"], "pid_cap");
    }

    #[test]
    fn deadline_during_inventory_or_revalidation_discards_candidates() {
        for limit in 1..=8 {
            let mut f = fixture(&[p(1, 0), p(2, 1), p(3, 2)]);
            f.expire_after_reads = Some(limit);
            let value = observe_with(1, 7, &mut f);
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
            let value = observe_with(1, 7, &mut f);
            assert_eq!(value["pids"], json!([1, 4]));
            assert_eq!(value["partial"], true);
        }
    }

    #[test]
    fn older_child_cannot_attach_to_reused_parent() {
        let older = Process { start: (99, 0), ..p(2, 1) };
        let value = observe_with(1, 7, &mut fixture(&[p(1, 0), older]));
        assert_eq!(value["pids"], json!([1]));
        assert_eq!(value["reason"], "ancestor_identity_inconsistent");
    }

    #[test]
    fn depth_and_descendant_caps_and_deadline_are_explicit() {
        let chain: Vec<_> = (1..=35).map(|pid| p(pid, pid - 1)).collect();
        let value = observe_with(1, 7, &mut fixture(&chain));
        assert_eq!(value["pids"].as_array().unwrap().len(), 33);
        assert_eq!(value["reason"], "depth_cap");
        let mut wide = vec![p(1, 0)];
        wide.extend((2..=131).map(|pid| p(pid, 1)));
        let value = observe_with(1, 7, &mut fixture(&wide));
        assert_eq!(value["pids"].as_array().unwrap().len(), 129);
        assert_eq!(value["reason"], "descendant_cap");
        let mut f = fixture(&[p(1, 0)]);
        f.expired = true;
        let value = observe_with(1, 7, &mut f);
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
        assert_eq!(owned["pids"], json!([child_pid]), "{owned}");
        let exited = observe(child_pid);
        assert_eq!(exited["available"], false);
        assert_eq!(exited["partial"], true);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_are_explicitly_unavailable() {
        assert_eq!(observe(1)["reason"], "unsupported_platform");
    }
}

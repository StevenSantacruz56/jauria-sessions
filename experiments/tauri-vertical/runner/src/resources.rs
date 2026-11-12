//! Read-only, explicit-PID resource sampling. No process discovery, argv/env reads,
//! logging, signals (including signal 0), persistence, or application attribution.
//!
//! Integration (deliberately not performed here): declare `mod resources;` and
//! keep `Mutex<resources::ResourcesSampler>` in the runner. Call
//! `sampler.lock()?.sample(&pids)` on successive polls (e.g. once per second).
//! The caller must select the runner PID and currently owned, unreaped children,
//! holding their lifecycle locks through sampling to pin their identities. Never
//! feed historical SQLite PIDs without independent ownership verification. A
//! successful read establishes an observation, not ownership or signal authority.
//!
//! The same file can be included with `#[path = "..."] mod resources;` in the
//! GUI bridge; keep a separate sampler there and pass the GUI's current PID.
//! Only `std`, `libc` and `serde_json` are required (already runner dependencies).
//!
//! JSON v1: `processes` contains one row per distinct input PID, in input order.
//! `available` on a row means its identity and RSS were read; CPU has its own
//! `cpuAvailable`. Missing values are null, never fabricated zeroes. `startIdentity`
//! is an opaque decimal string of macOS boot-relative process-start ticks (not an
//! epoch timestamp; string avoids JavaScript integer truncation). It detects PID
//! reuse between samples, but cannot authenticate the caller's initial PID.
//! `timestampUnixMs` is UTC epoch milliseconds at observation/completion; CPU uses
//! monotonic Mach ticks, not wall time. One busy core = 100%, multiple may exceed
//! 100%. First/new/reused PID, failed read, removal and counter reset need warmup.
//! `available` at the top means at least one readable row, not complete coverage;
//! consult every row, including failures. An empty request has no available data.
//!
//! Kernel units/ABI: Apple's sys/resource.h, libsyscall/wrappers/libproc/libproc.c,
//! bsd/kern/kern_resource.c (gather_rusage_info) and osfmk/kern/task.c
//! (task_power_info_locked) in https://github.com/apple-oss-distributions/xnu.
//! RUSAGE_INFO_V0 user/system times and mach_absolute_time use Mach ticks: take
//! their ratio directly, with no nanosecond assumption on Apple Silicon.

use serde_json::{Value, json};
use std::{collections::{HashMap, HashSet}, time::{SystemTime, UNIX_EPOCH}};

const LIMITATIONS: &[&str] = &[
    "Only explicitly supplied PIDs; no descendants, process-tree discovery or whole-app total.",
    "Caller must verify ownership; startIdentity detects reuse between observations only, within this boot.",
    "Samples are sequential and provisional; processes may exit immediately after a read.",
    "CPU is an interval average of this process's threads; first sample or reset is unavailable.",
    "RSS is resident bytes, not physical footprint or private memory; shared pages can be counted more than once.",
    "macOS only; exited processes and restricted or failed reads have unavailable metrics.",
];

/// Retain one instance per polling source; no global state or background threads.
#[derive(Default)]
pub struct ResourcesSampler {
    previous: HashMap<u32, Observation>,
}

#[derive(Clone, Copy)]
struct Observation {
    start: u64,
    user: u64,
    system: u64,
    ticks: u64,
    rss: u64,
}

struct Unavailable {
    reason: &'static str,
    errno: Option<i32>,
}

impl Unavailable {
    fn new(reason: &'static str) -> Self {
        Self { reason, errno: None }
    }
}

impl ResourcesSampler {
    /// Never sleeps or launches a command. Null CPU requires another successful
    /// sample of the same identity. Calls require exclusive access (`&mut self`).
    pub fn sample(&mut self, pids: &[u32]) -> Value {
        self.sample_with(pids, read_process)
    }

    fn sample_with(
        &mut self,
        pids: &[u32],
        mut read: impl FnMut(u32) -> Result<Observation, Unavailable>,
    ) -> Value {
        let mut seen = HashSet::new();
        let mut next = HashMap::new();
        let mut rows = Vec::new();
        for &pid in pids {
            if !seen.insert(pid) {
                continue;
            }
            // Do not cast invalid u32 values to signed PIDs or interpret 0 as self.
            let result = if pid == 0 || pid > i32::MAX as u32 {
                Err(Unavailable::new("invalid_pid"))
            } else {
                read(pid)
            };
            let row = match result {
                Ok(current) => {
                    let cpu = cpu_percent(self.previous.get(&pid), &current);
                    next.insert(pid, current);
                    json!({
                        "pid": pid,
                        "startIdentity": current.start.to_string(),
                        "timestampUnixMs": timestamp_ms(),
                        "available": true,
                        "unavailableReason": null,
                        "errno": null,
                        "rssBytes": current.rss,
                        "cpuPercent": cpu.as_ref().ok(),
                        "cpuAvailable": cpu.is_ok(),
                        "cpuUnavailableReason": cpu.err(),
                    })
                }
                Err(error) => json!({
                    "pid": pid,
                    "startIdentity": null,
                    "timestampUnixMs": timestamp_ms(),
                    "available": false,
                    "unavailableReason": error.reason,
                    "errno": error.errno,
                    "rssBytes": null,
                    "cpuPercent": null,
                    "cpuAvailable": false,
                    "cpuUnavailableReason": error.reason,
                }),
            };
            rows.push(row);
        }
        // Failures and omitted PIDs erase baselines: never return cached metrics
        // or keep an ever-growing history of previously managed processes.
        self.previous = next;
        let available = rows.iter().any(|row| row["available"] == true);
        json!({
            "schemaVersion": 1,
            "timestampUnixMs": timestamp_ms(),
            "source": if cfg!(target_os = "macos") { "proc_pid_rusage_v0" } else { "unsupported" },
            "scope": "explicit_pids",
            "available": available,
            "processes": rows,
            "limitations": LIMITATIONS,
        })
    }
}

fn timestamp_ms() -> Option<u64> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn cpu_percent(previous: Option<&Observation>, current: &Observation) -> Result<f64, &'static str> {
    let previous = previous.ok_or("warming_up")?;
    if previous.start != current.start {
        return Err("identity_changed");
    }
    let elapsed = current.ticks.checked_sub(previous.ticks)
        .filter(|&ticks| ticks > 0).ok_or("invalid_interval")?;
    let user = current.user.checked_sub(previous.user).ok_or("counter_reset")?;
    let system = current.system.checked_sub(previous.system).ok_or("counter_reset")?;
    // Add as u128 to avoid overflow of individually valid 64-bit counters.
    Ok((u128::from(user) + u128::from(system)) as f64 / elapsed as f64 * 100.0)
}

#[cfg(target_os = "macos")]
// libc deprecates Mach bindings in favor of mach2; retaining the existing libc
// dependency is intentional for this standalone module (no manifest changes).
#[allow(deprecated)]
fn read_process(pid: u32) -> Result<Observation, Unavailable> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v0>::zeroed();
    // SAFETY: positive signed-range PID validated above; writable, aligned buffer
    // of the exact V0 size. libproc's historical pointer-to-void* signature takes
    // the address of the struct itself, not the address of a buffer pointer.
    let before = unsafe { libc::mach_absolute_time() };
    let result = unsafe {
        libc::proc_pid_rusage(pid as i32, libc::RUSAGE_INFO_V0, usage.as_mut_ptr().cast())
    };
    if result != 0 {
        let errno = std::io::Error::last_os_error().raw_os_error();
        return Err(Unavailable {
            reason: match errno {
                Some(libc::ESRCH | libc::ENOENT) => "process_unavailable",
                Some(libc::EPERM | libc::EACCES) => "permission_denied",
                _ => "read_failed",
            },
            errno,
        });
    }
    let after = unsafe { libc::mach_absolute_time() };
    // SAFETY: successful V0 call filled this integer-only struct.
    let usage = unsafe { usage.assume_init() };
    if usage.ri_proc_exit_abstime != 0 {
        return Err(Unavailable::new("process_exited"));
    }
    if usage.ri_proc_start_abstime == 0 {
        return Err(Unavailable::new("identity_unavailable"));
    }
    let interval = after.checked_sub(before).ok_or(Unavailable::new("invalid_interval"))?;
    Ok(Observation {
        start: usage.ri_proc_start_abstime,
        user: usage.ri_user_time,
        system: usage.ri_system_time,
        ticks: before + interval / 2,
        rss: usage.ri_resident_size,
    })
}

#[cfg(not(target_os = "macos"))]
fn read_process(_: u32) -> Result<Observation, Unavailable> {
    Err(Unavailable::new("unsupported_platform"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(start: u64, user: u64, system: u64, ticks: u64) -> Observation {
        Observation { start, user, system, ticks, rss: 8_192 }
    }

    #[test]
    fn one_core_is_100_multicore_exceeds_100_and_idle_is_zero() {
        let first = observation(1, 100, 200, 1_000);
        assert_eq!(cpu_percent(Some(&first), &observation(1, 600, 700, 2_000)), Ok(100.0));
        assert_eq!(cpu_percent(Some(&first), &observation(1, 1_600, 1_200, 2_000)), Ok(250.0));
        assert_eq!(cpu_percent(Some(&first), &observation(1, 100, 200, 2_000)), Ok(0.0));
    }

    #[test]
    fn invalid_baselines_cannot_fabricate_cpu() {
        let first = observation(1, 100, 200, 1_000);
        assert_eq!(cpu_percent(None, &first), Err("warming_up"));
        assert_eq!(cpu_percent(Some(&first), &observation(2, 200, 300, 2_000)), Err("identity_changed"));
        assert_eq!(cpu_percent(Some(&first), &observation(1, 99, 300, 2_000)), Err("counter_reset"));
        assert_eq!(cpu_percent(Some(&first), &observation(1, 300, 199, 2_000)), Err("counter_reset"));
        assert_eq!(cpu_percent(Some(&first), &first), Err("invalid_interval"));
        assert_eq!(cpu_percent(Some(&first), &observation(1, 200, 300, 999)), Err("invalid_interval"));
    }

    #[test]
    fn counter_addition_does_not_overflow() {
        let first = observation(1, 0, 0, 1);
        let next = observation(1, u64::MAX, u64::MAX, u64::MAX);
        let cpu = cpu_percent(Some(&first), &next).unwrap();
        assert!(cpu.is_finite() && (cpu - 200.0).abs() < 0.001);
    }

    #[test]
    fn duplicates_invalid_pids_order_and_json_contract() {
        let mut sampler = ResourcesSampler::default();
        let mut reads = Vec::new();
        let value = sampler.sample_with(&[7, 0, 7, u32::MAX, 3], |pid| {
            reads.push(pid);
            Ok(observation(u64::MAX, 0, 0, 1))
        });
        assert_eq!(reads, [7, 3]);
        let rows = value["processes"].as_array().unwrap();
        assert_eq!(rows.iter().map(|row| row["pid"].as_u64().unwrap()).collect::<Vec<_>>(), [7, 0, u32::MAX as u64, 3]);
        assert_eq!(rows[0]["startIdentity"], u64::MAX.to_string());
        assert_eq!(rows[0]["rssBytes"], 8_192);
        assert_eq!(rows[0]["cpuAvailable"], false);
        assert!(rows[0]["cpuPercent"].is_null());
        assert_eq!(rows[1]["unavailableReason"], "invalid_pid");
        assert!(rows[1]["rssBytes"].is_null());
        assert!(rows[1]["startIdentity"].is_null());
        assert!(value["timestampUnixMs"].as_u64().unwrap() > 0);
        assert!(rows[0]["timestampUnixMs"].as_u64().unwrap() > 0);
        assert_eq!(value["scope"], "explicit_pids");
        assert_eq!(value["schemaVersion"], 1);
        // Explicit allowlist prevents accidental command/environment metadata.
        assert_eq!(rows[0].as_object().unwrap().len(), 10);
        assert!(serde_json::to_string(&value).is_ok());
    }

    #[test]
    fn reused_pid_restarts_baseline_without_claiming_ownership() {
        let mut sampler = ResourcesSampler::default();
        sampler.sample_with(&[7], |_| Ok(observation(1, 10, 10, 100)));
        let reused = sampler.sample_with(&[7], |_| Ok(observation(2, 20, 20, 200)));
        assert_eq!(reused["processes"][0]["cpuUnavailableReason"], "identity_changed");
        assert_eq!(reused["processes"][0]["startIdentity"], "2");
        let next = sampler.sample_with(&[7], |_| Ok(observation(2, 70, 70, 300)));
        assert_eq!(next["processes"][0]["cpuPercent"], 100.0);
    }

    #[test]
    fn failed_reads_are_null_and_erase_baseline_then_recover() {
        let mut sampler = ResourcesSampler::default();
        sampler.sample_with(&[7], |_| Ok(observation(1, 10, 10, 100)));
        let failed = sampler.sample_with(&[7], |_| Err(Unavailable {
            reason: "permission_denied", errno: Some(libc::EPERM),
        }));
        assert_eq!(failed["available"], false);
        let row = &failed["processes"][0];
        assert_eq!(row["unavailableReason"], "permission_denied");
        assert_eq!(row["errno"], libc::EPERM);
        assert!(row["rssBytes"].is_null() && row["cpuPercent"].is_null());
        assert!(sampler.previous.is_empty());
        let recovered = sampler.sample_with(&[7], |_| Ok(observation(1, 20, 20, 200)));
        assert_eq!(recovered["processes"][0]["cpuUnavailableReason"], "warming_up");
    }

    #[test]
    fn omitted_pids_are_pruned_and_empty_input_does_not_discover_processes() {
        let mut sampler = ResourcesSampler::default();
        sampler.sample_with(&[7, 8], |_| Ok(observation(1, 0, 0, 1)));
        sampler.sample_with(&[8], |_| Ok(observation(1, 0, 0, 2)));
        assert_eq!(sampler.previous.len(), 1);
        assert!(!sampler.previous.contains_key(&7));
        let empty = sampler.sample_with(&[], |_| panic!("must not enumerate processes"));
        assert_eq!(empty["processes"], json!([]));
        assert_eq!(empty["available"], false);
        assert!(sampler.previous.is_empty());
    }

    #[test]
    fn partial_failure_does_not_hide_success_or_return_stale_rows() {
        let mut sampler = ResourcesSampler::default();
        let value = sampler.sample_with(&[7, 8], |pid| {
            if pid == 7 { Ok(observation(1, 0, 0, 1)) }
            else { Err(Unavailable::new("process_unavailable")) }
        });
        assert_eq!(value["available"], true);
        assert_eq!(value["processes"][1]["available"], false);
        assert_eq!(sampler.previous.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_self_metrics_without_workload_or_signals() {
        let mut sampler = ResourcesSampler::default();
        let pid = std::process::id();
        let first = sampler.sample(&[pid]);
        let row = &first["processes"][0];
        assert_eq!(row["available"], true, "{first}");
        assert!(row["rssBytes"].as_u64().unwrap() > 0);
        assert!(row["startIdentity"].as_str().unwrap().parse::<u64>().unwrap() > 0);
        assert_eq!(row["cpuUnavailableReason"], "warming_up");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = sampler.sample(&[pid]);
        let next = &second["processes"][0];
        assert_eq!(next["startIdentity"], row["startIdentity"]);
        assert_eq!(next["cpuAvailable"], true, "{second}");
        assert!(next["cpuPercent"].as_f64().unwrap().is_finite());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_missing_pid_is_unavailable() {
        // macOS PIDs are well below i32::MAX. No child or signal needed.
        let value = ResourcesSampler::default().sample(&[i32::MAX as u32]);
        assert_eq!(value["processes"][0]["available"], false, "{value}");
        assert!(value["processes"][0]["rssBytes"].is_null());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_platform_is_explicit() {
        let value = ResourcesSampler::default().sample(&[std::process::id()]);
        assert_eq!(value["processes"][0]["unavailableReason"], "unsupported_platform");
        assert_eq!(value["available"], false);
    }
}

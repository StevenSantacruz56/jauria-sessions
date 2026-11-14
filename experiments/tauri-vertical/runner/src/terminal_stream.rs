//! Current-generation terminal streams. SQLite is used exclusively by the writer;
//! callers only acquire the short-lived memory mutex. No provider is owned here.
use crate::storage::Store;
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::{Arc, Condvar, Mutex, MutexGuard, Weak, mpsc},
    thread,
    time::{Duration, Instant},
};

// Leave room for the authenticated RPC result wrapper and trailing newline.
const WIRE: usize = 256 * 1024 - 64;
const CHUNK: usize = 12 * 1024;
const BATCH: usize = 64 * 1024;
const LATENCY: Duration = Duration::from_millis(250);
const RETRY: Duration = Duration::from_secs(2);
const RELEASE_REASON: &str = "explicit operator acknowledgement; no process was signaled; history retained";
const DRAIN: Duration = Duration::from_millis(500);
const METADATA: usize = 2 * 1024 * 1024;
const SESSION_METADATA: usize = 64 * 1024;
// 120 Unicode scalars can each need six JSON bytes, plus the string quotes.
// Every row reserves this title envelope so a committed rename cannot fail for
// lack of cache space, including when finished caches fill the global budget.
const TITLE_METADATA: usize = 120 * 6 + 2;

fn metadata_row_bytes(row: &Value) -> usize {
    row.to_string().len() + TITLE_METADATA.saturating_sub(row["title"].to_string().len())
}

#[derive(Clone)]
struct Config {
    ring_bytes: usize,
    session_ring_bytes: usize,
    ring_frames: usize,
    session_ring_frames: usize,
    pending_bytes: usize,
    pending_frames: usize,
    session_pending_bytes: usize,
    session_pending_frames: usize,
    archive_bytes: usize,
    metadata_limit: usize,
    session_limit: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self { ring_bytes: 8*1024*1024, session_ring_bytes: 4*1024*1024,
            ring_frames: 8192, session_ring_frames: 4096,
            // Two existing concurrent 5 MiB raw floods need ~13.4 MiB base64.
            // This queue budget is independent of the unchanged 4/8 MiB rings.
            pending_bytes: 16*1024*1024, pending_frames: 8192,
            session_pending_bytes: 8*1024*1024, session_pending_frames: 4096,
            archive_bytes: 32*1024*1024, metadata_limit: METADATA, session_limit: 4096 }
    }
}

struct Frame {
    value: Value,
    index: u64,
    serial: u64,
    bytes: usize,
    raw: usize,
}
struct Session {
    row: Value,
    metadata_bytes: usize,
    ring: VecDeque<Arc<Frame>>,
    ring_bytes: usize,
    pending: VecDeque<Arc<Frame>>,
    pending_bytes: usize, // includes the writer's in-flight batch
    pending_frames: usize,
    pending_raw: usize,
    since: Option<Instant>,
    barrier: bool,
    last: u64,
    durable: u64,
    archived_bytes: usize,
    missing: Option<u64>, // One conservative range [missing, last], never a range list.
    reason: Option<&'static str>,
    finished: bool,
    complete: bool,
    marker_dirty: bool,
    revision: u64,
    saved_revision: Option<u64>,
    marker_inflight: bool,
    purging: bool,
    created: u64,
}
struct Memory {
    sessions: BTreeMap<String, Session>,
    order: VecDeque<String>,
    ring_order: BTreeMap<u64, String>,
    ring_bytes: usize,
    pending_bytes: usize,
    pending_frames: usize,
    metadata_bytes: usize,
    serial: u64,
    global_failure: Option<&'static str>,
    stop: Option<Instant>,
}
struct Shared {
    memory: Mutex<Memory>,
    wake: Condvar,
    config: Config,
    generation: String,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, Memory> {
        self.memory.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct TerminalStreams {
    shared: Arc<Shared>,
    done: Mutex<Option<mpsc::Receiver<()>>>,
}

impl TerminalStreams {
    /// The main Store must already have initialized the schema. In particular,
    /// opening this connection must never run Store::open's recovery routines.
    pub fn new(path: &Path, generation: String) -> Result<Arc<Self>> {
        Self::configured(path, generation, Config::default())
    }

    fn configured(path: &Path, generation: String, config: Config) -> Result<Arc<Self>> {
        ensure!(!generation.is_empty() && generation.len() <= 256, "Invalid terminal generation");
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_millis(50))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        let shared = Arc::new(Shared {
            memory: Mutex::new(Memory { sessions: BTreeMap::new(), order: VecDeque::new(),
                ring_order: BTreeMap::new(), ring_bytes: 0, pending_bytes: 0,
                pending_frames: 0, metadata_bytes: 0, serial: 0,
                global_failure: None, stop: None }),
            wake: Condvar::new(), config, generation,
        });
        let weak = Arc::downgrade(&shared);
        let (tx, rx) = mpsc::channel();
        thread::Builder::new().name("terminal-archive".into()).spawn(move || {
            writer(weak, Store(conn));
            let _ = tx.send(());
        })?;
        Ok(Arc::new(Self { shared, done: Mutex::new(Some(rx)) }))
    }

    /// Admission preflight before spawning or inserting a durable session. Only
    /// finished caches whose latest checkpoint committed can make room. This is
    /// not a reservation: register rechecks atomically under the memory mutex.
    pub fn prepare_register(&self, row: &Value) -> Result<()> {
        let (id, bytes) = registration(row)?;
        prepare(&mut self.shared.lock(), &self.shared.config, &id, bytes)
    }

    pub fn register(&self, row: Value) -> Result<()> {
        let (id, bytes) = registration(&row)?;
        let rows = row["rows"].as_u64().unwrap();
        let cols = row["cols"].as_u64().unwrap();
        let mut m = self.shared.lock();
        prepare(&mut m, &self.shared.config, &id, bytes)?;
        let created = m.serial;
        m.metadata_bytes += bytes;
        m.order.push_back(id.clone());
        m.sessions.insert(id.clone(), Session { row, metadata_bytes: bytes,
            ring: VecDeque::new(), ring_bytes: 0, pending: VecDeque::new(),
            pending_bytes: 0, pending_frames: 0, pending_raw: 0, since: None,
            barrier: false, last: 0, durable: 0, archived_bytes: 0,
            missing: None, reason: None, finished: false, complete: false,
            marker_dirty: true, revision: 0, saved_revision: None,
            marker_inflight: false, purging: false, created });
        publish(&self.shared, &mut m, &id, "resize", json!({"rows":rows,"cols":cols}), 0, true);
        self.shared.wake.notify_one();
        Ok(())
    }

    pub fn output(&self, id: &str, bytes: &[u8]) {
        // Even a caller violating the normal 12 KiB read contract cannot create
        // a single oversized live/archive frame.
        for chunk in bytes.chunks(CHUNK) {
            let data = json!(STANDARD.encode(chunk));
            let mut m = self.shared.lock();
            publish(&self.shared, &mut m, id, "output", data, chunk.len(), false);
            self.shared.wake.notify_one();
        }
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) {
        let mut m = self.shared.lock();
        if let Some(s) = m.sessions.get_mut(id).filter(|s| !s.finished) {
            s.row["rows"] = json!(rows);
            s.row["cols"] = json!(cols);
        }
        publish(&self.shared, &mut m, id, "resize", json!({"rows":rows,"cols":cols}), 0, true);
        self.shared.wake.notify_one();
    }

    /// Merge only a validated title into the latest cache. Lifecycle/output can
    /// advance during Store I/O; replacing the observed row would erase them.
    /// Title space is reserved at registration/finish, so accounting stays fixed
    /// even across repeated renames. Older writer markers are revision-fenced.
    pub fn rename(&self, id: &str, title: &str) -> Result<Option<Value>> {
        ensure!(!title.chars().any(char::is_control),"Session title must not contain control characters");
        let title=title.trim();
        ensure!(!title.is_empty() && title.chars().count()<=120 && title.len()<=480,
            "Invalid session title");
        let mut m=self.shared.lock();
        let Some(s)=m.sessions.get_mut(id) else {return Ok(None)};
        s.row["title"]=json!(title);
        debug_assert!(metadata_row_bytes(&s.row)+id.len()+512<=s.metadata_bytes,
            "rename title must fit the preallocated metadata envelope");
        s.revision+=1;
        s.marker_dirty=true;
        let row=decorated(&self.shared,s);
        self.shared.wake.notify_one();
        Ok(Some(row))
    }

    pub fn finish(&self, id: &str, status: &str, detail: Value) {
        let mut m = self.shared.lock();
        let Some(s) = m.sessions.get(id) else { return };
        if s.finished { return; }
        // Bound lifecycle input as well as registration. Normal Store-owned rows
        // fit this reserve. Oversized external details get an explicit omission.
        let detail = if detail.to_string().len() <= 32*1024 { detail }
            else { json!({"terminalStreamDetailOmitted":true,"reason":"metadata_limit"}) };
        let status = if status.len() <= 64 { status } else { "failed" };
        let old_bytes = s.metadata_bytes;
        let mut row = s.row.clone();
        row["status"] = json!(status);
        let mut merged = row["detail"].as_object().cloned().unwrap_or_default();
        if let Some(fields) = detail.as_object() { merged.extend(fields.clone()); }
        else { merged.insert("originalDetail".into(), detail); }
        row["detail"] = Value::Object(merged);
        let new_bytes = metadata_row_bytes(&row) + id.len() + 512 + 256;
        // Admission reserves 32 KiB per mutable session below (see accounting).
        // If the shared budget is full, preserve lifecycle with bounded detail.
        if m.metadata_bytes - old_bytes + new_bytes > METADATA || new_bytes > SESSION_METADATA {
            row["detail"] = json!({"terminalStreamDetailOmitted":true,"reason":"metadata_limit"});
        }
        let new_bytes = metadata_row_bytes(&row) + id.len() + 512 + 256;
        m.metadata_bytes = m.metadata_bytes - old_bytes + new_bytes;
        let s = m.sessions.get_mut(id).unwrap();
        s.row = row;
        s.metadata_bytes = new_bytes;
        let detail = s.row["detail"].clone();
        publish(&self.shared, &mut m, id, "state", json!({"status":status,"detail":detail}), 0, true);
        let s = m.sessions.get_mut(id).unwrap();
        s.finished = true;
        let detail = &s.row["detail"];
        if detail["outputNotRetained"] == true || detail["incomplete"] == true ||
            detail["readError"].as_bool() == Some(true) ||
            detail["readError"].as_str().is_some_and(|v| !v.is_empty()) ||
            detail["outputTail"].as_str().is_some_and(|v| !v.is_empty()) {
            lose(s, s.last + 1, "reader_error");
        }
        if s.row["detail"]["terminalStreamDetailOmitted"] == true {
            lose(s, s.last, "metadata_limit");
        }
        s.marker_dirty = true;
        s.revision += 1;
        self.shared.wake.notify_one();
    }

    /// Called after the main Store has explicitly released uncertain custody.
    /// A revision check makes any in-flight older marker rewrite this lifecycle.
    pub fn release(&self, id: &str) {
        let mut m = self.shared.lock();
        if let Some(s) = m.sessions.get_mut(id) {
            let old_bytes = s.metadata_bytes;
            s.row["status"] = json!("released");
            if !s.row["detail"].is_object() {
                s.row["detail"] = json!({"originalDetail":s.row["detail"]});
            }
            s.row["detail"]["reason"] = json!(RELEASE_REASON);
            // finish reserves 256 bytes for this fixed operator explanation.
            let new_bytes = old_bytes.max(metadata_row_bytes(&s.row) + id.len() + 512);
            s.metadata_bytes = new_bytes;
            s.revision += 1;
            s.complete = false;
            s.marker_dirty = true;
            m.metadata_bytes = m.metadata_bytes - old_bytes + new_bytes;
        }
        self.shared.wake.notify_one();
    }

    /// Atomically seals a registered session until purged/cancel_purge. No batch
    /// or checkpoint can start between this preflight and the main Store purge.
    pub fn ensure_purgeable(&self, id: &str) -> Result<()> {
        let mut m = self.shared.lock();
        if let Some(s) = m.sessions.get_mut(id) {
            ensure!(s.finished, "Terminal session is still running");
            ensure!(s.pending_frames == 0, "Terminal archive is still draining; retry purge");
            ensure!(!s.marker_inflight, "Terminal checkpoint is still draining; retry purge");
            ensure!(!s.purging, "Terminal purge is already in progress");
            s.purging = true;
        }
        Ok(())
    }

    pub fn cancel_purge(&self, id: &str) {
        if let Some(s) = self.shared.lock().sessions.get_mut(id) { s.purging = false; }
        self.shared.wake.notify_one();
    }

    /// Call only after Store purge succeeds and ensure_purgeable has sealed it.
    pub fn purged(&self, id: &str) {
        let mut m = self.shared.lock();
        if !m.sessions.get(id).is_some_and(|s| s.purging && s.finished &&
            s.pending_frames == 0 && !s.marker_inflight) { return; }
        while !m.sessions[id].ring.is_empty() { evict(&mut m, id); }
        let s = m.sessions.get_mut(id).unwrap();
        s.missing = Some(1);
        s.reason = Some("explicit_purge");
        s.durable = 0;
        s.complete = false;
        s.revision += 1;
        s.marker_dirty = true;
        s.purging = false;
        self.shared.wake.notify_one();
    }

    /// The caller must first complete explicit purge and Store::ensure_capacity.
    /// Existing missing ranges remain permanent; newly registered streams may
    /// archive again. This does not retry or resurrect any discarded batch.
    pub fn retention_changed(&self) {
        self.shared.lock().global_failure = None;
        self.shared.wake.notify_one();
    }

    pub fn session(&self, id: &str) -> Option<Value> {
        self.shared.lock().sessions.get(id).map(|s| decorated(&self.shared, s))
    }

    pub fn sessions(&self) -> Vec<Value> {
        self.shared.lock().sessions.values().map(|s| decorated(&self.shared, s)).collect()
    }

    pub fn live(&self, id: &str, after: u64, limit: usize) -> Result<Value> {
        ensure!(limit > 0, "Invalid terminal frame limit");
        let m = self.shared.lock();
        let s = m.sessions.get(id).context("Unknown terminal session")?;
        ensure!(after <= s.last, "Terminal cursor is ahead of stream");
        let first = s.ring.front().map_or(s.last.saturating_add(1), |f| f.index);
        let gap = if after.saturating_add(1) < first {
            json!({"firstFrame":after+1,"lastFrame":first-1})
        } else { Value::Null };
        let mut response = json!({"generation":self.shared.generation,"frames":[],"gap":gap,
            "firstFrame":first,"lastFrame":s.last,"durableFrame":s.durable,
            "hasMore":false,"session":decorated(&self.shared,s),"history":history(s)});
        let mut frames = Vec::new();
        let mut size = serde_json::to_vec(&response)?.len();
        for f in s.ring.iter().filter(|f| f.index > after) {
            let added = f.value.to_string().len() + usize::from(!frames.is_empty());
            if frames.len() == limit.min(64) || size + added > WIRE { break; }
            size += added;
            frames.push(f.value.clone());
        }
        let cursor = frames.last().and_then(|f| f["index"].as_u64()).unwrap_or(after.max(first-1));
        response["hasMore"] = json!(cursor < s.last);
        response["frames"] = json!(frames);
        ensure!(serde_json::to_vec(&response)?.len() <= WIRE, "Terminal metadata exceeds response limit");
        Ok(response)
    }

    /// Signals a bounded drain. It neither stops nor waits for any provider.
    /// A stalled filesystem may outlive this call; the detached writer owns only
    /// its connection and a Weak pointer, never the TerminalStreams manager.
    pub fn shutdown(&self) {
        {
            let mut m = self.shared.lock();
            if m.stop.is_none() { m.stop = Some(Instant::now()); }
            self.shared.wake.notify_all();
        }
        let rx = self.done.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(rx) = rx { let _ = rx.recv_timeout(DRAIN + Duration::from_millis(150)); }
    }
}
impl Drop for TerminalStreams {
    fn drop(&mut self) { self.shutdown(); }
}

fn history(s: &Session) -> Value {
    let state = if s.complete { "complete" }
        else if s.reason == Some("io") || s.reason == Some("invalid") { "error" }
        else if s.missing.is_some() { if s.finished { "incomplete" } else { "limited" } }
        else { "recording" };
    let mut value = json!({"state":state,"durableFrame":s.durable,"lastFrame":s.last});
    if let Some(reason) = s.reason { value["reason"] = json!(reason); }
    if let Some(first) = s.missing { value["fromFrame"] = json!(first); }
    value
}
fn stream(shared: &Shared, s: &Session) -> Value {
    json!({"generation":shared.generation,"revision":s.revision,"firstFrame":s.ring.front().map_or(s.last+1,|f|f.index),
        "lastFrame":s.last,"durableFrame":s.durable,"history":history(s)})
}
fn decorated(shared: &Shared, s: &Session) -> Value {
    let mut row = s.row.clone();
    let terminal = stream(shared, s);
    row["terminalStream"] = terminal.clone();
    row["history"] = history(s);
    if !row["detail"].is_object() { row["detail"] = json!({"originalDetail":row["detail"]}); }
    row["detail"]["terminalStream"] = terminal;
    row["detail"]["history"] = history(s);
    row
}

fn lose(s: &mut Session, first: u64, reason: &'static str) {
    s.missing = Some(s.missing.map_or(first, |old| old.min(first)));
    // An I/O error must not be disguised as an ordinary quota limitation.
    if s.reason.is_none() || reason == "io" { s.reason = Some(reason); }
    s.complete = false;
    s.marker_dirty = true;
    s.revision += 1;
}
fn discard(m: &mut Memory, id: &str) {
    let s = m.sessions.get_mut(id).unwrap();
    for frame in s.pending.drain(..) {
        s.pending_bytes -= frame.bytes;
        s.pending_frames -= 1;
        m.pending_bytes -= frame.bytes;
        m.pending_frames -= 1;
    }
    s.pending_raw = 0;
    s.since = None;
    s.barrier = false;
}
fn evict(m: &mut Memory, id: &str) {
    let s = m.sessions.get_mut(id).unwrap();
    if let Some(f) = s.ring.pop_front() {
        s.ring_bytes -= f.bytes;
        m.ring_bytes -= f.bytes;
        m.ring_order.remove(&f.serial);
    }
}
fn publish(shared: &Shared, m: &mut Memory, id: &str, kind: &str, data: Value, raw: usize, barrier: bool) {
    let Some(s) = m.sessions.get_mut(id) else { return };
    if s.finished { return; }
    s.last += 1;
    if barrier { s.revision += 1; }
    m.serial += 1;
    let value = json!({"index":s.last,"kind":kind,"data":data});
    let frame = Arc::new(Frame { bytes: value.to_string().len() + 128, value,
        index: s.last, serial: m.serial, raw });
    // Publish live before admitting archive work. Both views share immutable frames.
    s.ring_bytes += frame.bytes;
    m.ring_bytes += frame.bytes;
    s.ring.push_back(frame.clone());
    m.ring_order.insert(frame.serial, id.to_owned());
    while m.sessions[id].ring_bytes > shared.config.session_ring_bytes ||
        m.sessions[id].ring.len() > shared.config.session_ring_frames { evict(m, id); }
    while m.ring_bytes > shared.config.ring_bytes || m.ring_order.len() > shared.config.ring_frames {
        let victim = m.ring_order.first_key_value().unwrap().1.clone();
        evict(m, &victim);
    }
    let s = m.sessions.get_mut(id).unwrap();
    if let Some(reason) = m.global_failure {
        if s.missing.is_none() { lose(s, frame.index, reason); }
    }
    if m.stop.is_some() && s.missing.is_none() { lose(s, frame.index, "shutdown"); }
    if s.missing.is_some() { return; }
    let c = &shared.config;
    if m.pending_bytes + frame.bytes > c.pending_bytes || m.pending_frames >= c.pending_frames ||
        s.pending_bytes + frame.bytes > c.session_pending_bytes || s.pending_frames >= c.session_pending_frames {
        let first = s.pending.front().map_or(frame.index, |f| f.index);
        lose(s, first, "queue_overflow");
        discard(m, id);
        return;
    }
    s.pending_bytes += frame.bytes;
    s.pending_frames += 1;
    s.pending_raw += raw;
    m.pending_bytes += frame.bytes;
    m.pending_frames += 1;
    s.pending.push_back(frame);
    s.since.get_or_insert_with(Instant::now);
    s.barrier |= barrier;
    // Geometry persists at the next lifecycle checkpoint, not every resize.
}

struct Batch { id: String, frames: Vec<Arc<Frame>>, payload: Value, encoded: usize }
struct Marker { id: String, row: Value, revision: u64, can_complete: bool }
enum Work { Batch(Batch), Marker(Marker), Wait, Stop }
fn work(shared: &Shared, m: &mut Memory) -> Work {
    if m.stop.is_some_and(|t| t.elapsed() >= DRAIN) {
        let ids: Vec<_> = m.sessions.keys().cloned().collect();
        for id in ids {
            let s = m.sessions.get_mut(&id).unwrap();
            if s.durable < s.last && s.missing.is_none() { lose(s, s.durable+1, "shutdown"); }
            discard(m, &id);
        }
        return Work::Stop;
    }
    for _ in 0..m.order.len() {
        let id = m.order.pop_front().unwrap();
        m.order.push_back(id.clone());
        let s = m.sessions.get_mut(&id).unwrap();
        if s.purging || s.marker_inflight { continue; }
        if !s.pending.is_empty() && (s.barrier || s.pending_raw >= BATCH ||
            s.since.is_some_and(|t| t.elapsed() >= LATENCY) || m.stop.is_some()) {
            let mut frames = Vec::new();
            let mut raw = 0;
            let mut encoded = 0;
            while let Some(f) = s.pending.front() {
                // Conservative JSON allowance includes escaping again in the
                // provider history wire envelope, id, generation and wrappers.
                if frames.len() == 64 || (!frames.is_empty() &&
                    (raw + f.raw > BATCH || encoded + f.bytes > 80*1024)) { break; }
                let f = s.pending.pop_front().unwrap();
                raw += f.raw;
                encoded += f.bytes;
                s.pending_raw -= f.raw;
                frames.push(f);
            }
            if s.pending.is_empty() { s.since = None; s.barrier = false; }
            let payload = json!({"method":"jauria/terminalFrames","params":{
                "generation":shared.generation,"frames":frames.iter().map(|f|f.value.clone()).collect::<Vec<_>>()}});
            let encoded = payload.to_string().len();
            return Work::Batch(Batch { id, frames, payload, encoded });
        }
        if s.marker_dirty && s.pending.is_empty() {
            s.marker_dirty = false;
            s.marker_inflight = true;
            return Work::Marker(Marker { id, row: decorated(shared, s), revision: s.revision,
                can_complete: s.finished && s.missing.is_none() && s.durable == s.last });
        }
    }
    if m.stop.is_some() { Work::Stop } else { Work::Wait }
}

fn writer(weak: Weak<Shared>, mut store: Store) {
    loop {
        let Some(shared) = weak.upgrade() else { return };
        let next = { let mut m = shared.lock(); work(&shared, &mut m) };
        match next {
            Work::Stop => return,
            Work::Wait => {
                let m = shared.lock();
                // Recheck under the mutex to avoid a lost notification.
                let immediate = m.stop.is_some() || m.sessions.values().any(|s|
                    !s.purging && !s.marker_inflight &&
                    ((s.marker_dirty && s.pending.is_empty()) || s.barrier || s.pending_raw >= BATCH));
                if !immediate {
                    let wait = m.sessions.values().filter(|s| !s.purging && !s.marker_inflight).filter_map(|s| s.since)
                        .map(|since| LATENCY.saturating_sub(since.elapsed()))
                        .min().unwrap_or(LATENCY);
                    let _ = shared.wake.wait_timeout(m, wait);
                }
            }
            Work::Batch(batch) => archive(&shared, &mut store, batch),
            Work::Marker(task) => marker(&shared, &mut store, task),
        }
        // No strong manager/shared reference survives the next iteration/wait.
    }
}

fn archive(shared: &Shared, store: &mut Store, batch: Batch) {
    let local_limit = {
        let m = shared.lock();
        m.sessions[&batch.id].archived_bytes + batch.encoded > shared.config.archive_bytes
    };
    let result = if local_limit { None } else { Some(retry_busy(shared, || store.provider_event(&batch.id, &batch.payload))) };
    let mut m = shared.lock();
    let s = m.sessions.get_mut(&batch.id).unwrap();
    for f in &batch.frames {
        s.pending_bytes -= f.bytes;
        s.pending_frames -= 1;
    }
    let first = batch.frames[0].index;
    let last = batch.frames.last().unwrap().index;
    let failure = match result {
        None => Some(("session_quota", false)),
        Some(Ok(())) => {
            s.archived_bytes += batch.encoded;
            // A producer may have overflowed the remaining queue during I/O.
            s.durable = last.min(s.missing.map_or(last, |first| first.saturating_sub(1)));
            s.marker_dirty |= s.finished || s.missing.is_some();
            None
        }
        Some(Err(error)) => Some((Store::history_error_reason(&error), true)),
    };
    let bytes: usize = batch.frames.iter().map(|f| f.bytes).sum();
    m.pending_bytes -= bytes;
    m.pending_frames -= batch.frames.len();
    if let Some((reason, global)) = failure {
        if global {
            m.global_failure = Some(reason);
            let ids: Vec<_> = m.sessions.keys().cloned().collect();
            for id in ids {
                let s = m.sessions.get_mut(&id).unwrap();
                let missing = if id == batch.id { Some(first) }
                    else { s.pending.front().map(|f| f.index) };
                if let Some(first) = missing { lose(s, first, reason); }
                discard(&mut m, &id);
            }
        } else {
            lose(m.sessions.get_mut(&batch.id).unwrap(), first, reason);
            discard(&mut m, &batch.id);
        }
    }
}

// SQLite BUSY/LOCKED failures have not committed: provider_event is one
// statement, and native_checkpoint rolls its failed transaction back on drop.
// Retry the exact immutable operation, keeping in-flight accounting charged.
fn retry_busy(shared: &Shared, mut write: impl FnMut() -> Result<()>) -> Result<()> {
    let deadline = Instant::now() + RETRY;
    let mut last = None;
    loop {
        let end = {
            let m = shared.lock();
            m.stop.map_or(deadline, |stop| deadline.min(stop + DRAIN))
        };
        // Leave room for the connection's 50 ms busy timeout within the bound.
        if end.saturating_duration_since(Instant::now()) <= Duration::from_millis(50) {
            return Err(last.unwrap_or_else(|| anyhow::anyhow!("Terminal archive shutdown deadline")));
        }
        match write() {
            Ok(()) => return Ok(()),
            Err(error) if Store::history_is_busy(&error) => last = Some(error),
            Err(error) => return Err(error),
        }
        // Worker only; never sleep or run SQLite while holding the memory lock.
        thread::sleep(Duration::from_millis(20));
    }
}

fn marker(shared: &Shared, store: &mut Store, mut task: Marker) {
    // Snapshot and marker_inflight were captured atomically by work(). Purge
    // and cache eviction cannot race this I/O. Store also fences old revisions.
    if task.can_complete {
        task.row["detail"]["terminalStream"]["history"]["state"] = json!("complete");
        task.row["detail"]["history"]["state"] = json!("complete");
    }
    let result = retry_busy(shared, || store.native_checkpoint(&task.row));
    let mut m = shared.lock();
    let s = m.sessions.get_mut(&task.id).unwrap();
    s.marker_inflight = false;
    match result {
        Ok(()) => {
            s.saved_revision = Some(task.revision);
            if s.revision == task.revision { s.complete = task.can_complete; }
            // Mutations requiring an immediate checkpoint set marker_dirty
            // themselves. A geometry-only race waits for finish's checkpoint.
        }
        Err(_) => {
            lose(s, s.durable.saturating_add(1), "io");
            s.marker_dirty = false;
            discard(&mut m, &task.id);
        }
    }
    shared.wake.notify_all();
}

fn registration(row: &Value) -> Result<(String, usize)> {
    let id = row["id"].as_str().context("Session id required")?.to_owned();
    ensure!(!id.is_empty() && id.len() <= 256 && row.is_object(), "Invalid session id");
    ensure!(row["status"].as_str().is_some_and(|s| s.len() <= 64), "Session status required");
    let rows = row["rows"].as_u64().context("Session rows required")?;
    let cols = row["cols"].as_u64().context("Session cols required")?;
    ensure!(rows <= u16::MAX as u64 && cols <= u16::MAX as u64, "Invalid dimensions");
    let actual = metadata_row_bytes(row) + id.len() + 512;
    ensure!(actual <= SESSION_METADATA, "Terminal session metadata exceeds 64 KiB");
    Ok((id, actual + 32*1024))
}
fn prepare(m: &mut Memory, config: &Config, id: &str, bytes: usize) -> Result<()> {
    ensure!(m.stop.is_none(), "Terminal streams shut down");
    ensure!(!m.sessions.contains_key(id), "Terminal session already registered");
    ensure!(bytes <= config.metadata_limit, "Terminal session metadata capacity reached");
    while m.sessions.len() >= config.session_limit || m.metadata_bytes + bytes > config.metadata_limit {
        let victim = m.sessions.iter().filter(|(_, s)| s.finished && s.pending_frames == 0 &&
            !s.marker_inflight && !s.purging && !s.marker_dirty && s.saved_revision == Some(s.revision))
            .min_by_key(|(_,s)| s.created).map(|(id,_)| id.clone())
            .context("Terminal session metadata capacity reached; final checkpoints still draining")?;
        while !m.sessions[&victim].ring.is_empty() { evict(m, &victim); }
        let removed = m.sessions.remove(&victim).unwrap();
        m.metadata_bytes -= removed.metadata_bytes;
        m.order.retain(|id| id != &victim);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn eight_active_caches_and_repeated_renames_fit_reserved_metadata() {
        let t=manual(Config::default());
        let mut store=db(&[]);
        for n in 0..8 {
            let id=format!("native-{n}");
            t.register(row(&id)).unwrap();
            store.insert_native(&t.session(&id).unwrap()).unwrap();
        }
        let before=t.shared.lock().metadata_bytes;
        for n in 0..8 {
            let id=format!("native-{n}");
            for title in ["🐺".repeat(120),"\"".repeat(120),"short".into()] {
                store.native_checkpoint(&t.session(&id).unwrap()).unwrap();
                store.rename_session(&id,&title).unwrap();
                let renamed=t.rename(&id,&title).unwrap().unwrap();
                assert_eq!(renamed["title"],title);assert_eq!(renamed["status"],"running");
                assert_eq!(t.shared.lock().metadata_bytes,before);
                check_bounds(&t);
            }
        }
        assert!(before<=METADATA);
        assert!(serde_json::to_vec(&t.sessions()).unwrap().len()<=METADATA);
        for title in ["\n", "a\0b", "\u{1b}escaped", "a\u{7f}b", "trailing\n"] {
            assert!(t.rename("native-0",title).is_err());
        }
        drain(&t,&mut store);
        for n in 0..8 {
            let id=format!("native-{n}");
            t.finish(&id,"exited",json!({"reason":"x".repeat(31*1024)}));
        }
        drain(&t,&mut store);check_bounds(&t);
        assert!(serde_json::to_vec(&t.sessions()).unwrap().len()<=METADATA);
    }

    #[test]
    fn rename_merges_latest_lifecycle_and_fences_inflight_checkpoint() {
        let t=manual(Config::default());let mut store=db(&[]);
        t.register(row("s")).unwrap();store.insert_native(&t.session("s").unwrap()).unwrap();
        drain(&t,&mut store);
        t.shared.lock().sessions.get_mut("s").unwrap().marker_dirty=true;
        let old=match work(&t.shared,&mut t.shared.lock()) {Work::Marker(task)=>task,_=>panic!("expected marker")};
        t.finish("s","exited",json!({"exitCode":0,"custom":"preserved"}));
        let latest=t.session("s").unwrap();let bytes=t.shared.lock().metadata_bytes;
        store.native_checkpoint(&latest).unwrap();store.rename_session("s","History").unwrap();
        let renamed=t.rename("s","History").unwrap().unwrap();
        assert_eq!(renamed["status"],"exited");assert_eq!(renamed["detail"]["exitCode"],0);
        assert_eq!(renamed["detail"]["custom"],"preserved");
        assert_eq!(t.shared.lock().metadata_bytes,bytes);
        assert!(renamed["terminalStream"]["revision"].as_u64().unwrap()>latest["terminalStream"]["revision"].as_u64().unwrap());
        marker(&t.shared,&mut store,old);
        assert_eq!(store.session("s").unwrap().unwrap()["status"],"exited");
        assert_eq!(t.session("s").unwrap()["title"],"History");
        drain(&t,&mut store);
        assert_eq!(store.session("s").unwrap().unwrap()["title"],"History");
        check_bounds(&t);
    }

    fn row(id: &str) -> Value {
        json!({"id":id,"title":id,"kind":"fixture","status":"running","rows":24,"cols":80,
            "detail":{"custom":"preserved"}})
    }
    // Deterministic queue and fault tests drive exactly the production writer
    // steps without relying on thread scheduling or a background consumer.
    fn manual(config: Config) -> TerminalStreams {
        TerminalStreams { shared: Arc::new(Shared {
            memory: Mutex::new(Memory { sessions: BTreeMap::new(), order: VecDeque::new(),
                ring_order: BTreeMap::new(), ring_bytes: 0, pending_bytes: 0,
                pending_frames: 0, metadata_bytes: 0, serial: 0, global_failure: None, stop: None }),
            wake: Condvar::new(), config, generation: "test-generation".into(),
        }), done: Mutex::new(None) }
    }
    fn next_batch(t: &TerminalStreams) -> Batch {
        let mut m = t.shared.lock();
        for s in m.sessions.values_mut() { if !s.pending.is_empty() { s.barrier = true; } }
        match work(&t.shared, &mut m) { Work::Batch(batch) => batch, _ => panic!("expected batch") }
    }
    fn drain(t: &TerminalStreams, store: &mut Store) {
        for _ in 0..10000 {
            let step = {
                let mut m = t.shared.lock();
                for s in m.sessions.values_mut() { if !s.pending.is_empty() { s.barrier = true; } }
                work(&t.shared, &mut m)
            };
            match step {
                Work::Batch(batch) => archive(&t.shared, store, batch),
                Work::Marker(task) => marker(&t.shared, store, task),
                _ => return,
            }
        }
        panic!("writer failed to become idle");
    }
    fn db(ids: &[&str]) -> Store {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        for id in ids { store.insert(&row(id)).unwrap(); }
        store
    }
    fn check_bounds(t: &TerminalStreams) {
        let m = t.shared.lock();
        let c = &t.shared.config;
        assert!(m.ring_bytes <= c.ring_bytes);
        assert!(m.ring_order.len() <= c.ring_frames);
        assert!(m.pending_bytes <= c.pending_bytes);
        assert!(m.pending_frames <= c.pending_frames);
        assert!(m.metadata_bytes <= METADATA);
        assert_eq!(m.ring_bytes, m.sessions.values().map(|s|s.ring_bytes).sum::<usize>());
        assert_eq!(m.pending_bytes, m.sessions.values().map(|s|s.pending_bytes).sum::<usize>());
        assert_eq!(m.pending_frames, m.sessions.values().map(|s|s.pending_frames).sum::<usize>());
        for s in m.sessions.values() {
            assert!(s.ring_bytes <= c.session_ring_bytes);
            assert!(s.ring.len() <= c.session_ring_frames);
            assert!(s.pending_bytes <= c.session_pending_bytes);
            assert!(s.pending_frames <= c.session_pending_frames);
        }
    }

    #[test]
    fn ring_and_queue_byte_frame_bounds_and_explicit_gaps() {
        let t = manual(Config { ring_bytes: 1800, session_ring_bytes: 1000,
            ring_frames: 6, session_ring_frames: 4, pending_bytes: 1400,
            session_pending_bytes: 900, pending_frames: 5, session_pending_frames: 3,
            ..Config::default() });
        t.register(row("a")).unwrap();
        t.register(row("b")).unwrap();
        for n in 0..10000 {
            t.output(if n%2==0 {"a"} else {"b"}, &[n as u8; 200]);
            check_bounds(&t);
        }
        let a = t.live("a", 0, 64).unwrap();
        assert!(a["gap"]["lastFrame"].as_u64().unwrap() > 1);
        let m = t.shared.lock();
        let s = &m.sessions["a"];
        assert_eq!(s.reason, Some("queue_overflow"));
        assert!(s.pending.is_empty());
        assert_eq!(s.missing, Some(1));
        assert_eq!(s.last, 5001);
        assert_eq!(a["history"]["fromFrame"], 1);
        drop(m);
        assert!(t.live("missing", 0, 1).is_err());
        assert!(t.live("a", 5002, 1).is_err());
        assert!(t.live("a", 0, 0).is_err());
    }

    #[test]
    fn zero_byte_frames_are_bounded_and_session_fairness_survives_overflow() {
        let t = manual(Config { ring_frames: 8, session_ring_frames: 4,
            pending_frames: 10, session_pending_frames: 3, ..Config::default() });
        t.register(row("a")).unwrap();
        t.register(row("b")).unwrap();
        for _ in 0..1000 { t.resize("a", 24, 80); }
        t.output("b", b"still archived");
        check_bounds(&t);
        let m = t.shared.lock();
        assert_eq!(m.sessions["a"].missing, Some(1));
        assert_eq!(m.sessions["b"].missing, None);
        assert_eq!(m.sessions["b"].pending_frames, 2);
    }

    #[test]
    fn byte_exact_order_hash_wire_bounds_and_final_checkpoint() {
        let t = manual(Config::default());
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        let input: Vec<u8> = (0..180000).map(|n| (n%251) as u8).collect();
        t.output("a", &input[..90000]);
        t.resize("a", 41, 123);
        t.output("a", &input[90000..]);
        t.finish("a", "exited", json!({"exitCode":0}));
        assert_ne!(t.session("a").unwrap()["history"]["state"], "complete");
        let mut recovered = Vec::new();
        let mut indices = Vec::new();
        loop {
            let empty = t.shared.lock().sessions["a"].pending.is_empty();
            if empty { break; }
            let batch = next_batch(&t);
            assert!(batch.frames.len() <= 64);
            assert!(batch.frames.iter().map(|f|f.raw).sum::<usize>() <= BATCH);
            let outer = json!({"events":[{"seq":i64::MAX,"sessionId":"a","kind":"provider","data":batch.payload.to_string()}],"lastSeq":i64::MAX,"hasMore":false});
            assert!(outer.to_string().len() <= WIRE);
            for f in &batch.frames {
                indices.push(f.index);
                if f.value["kind"] == "output" {
                    recovered.extend(STANDARD.decode(f.value["data"].as_str().unwrap()).unwrap());
                }
            }
            archive(&t.shared, &mut store, batch);
        }
        let last = t.session("a").unwrap()["terminalStream"]["lastFrame"].as_u64().unwrap();
        assert_eq!(indices, (1..=last).collect::<Vec<_>>());
        assert_eq!(Sha256::digest(&recovered), Sha256::digest(&input));
        assert_eq!(recovered, input);
        drain(&t, &mut store);
        let session = t.session("a").unwrap();
        assert_eq!(session["history"]["state"], "complete");
        assert_eq!(session["detail"]["custom"], "preserved");
        assert_eq!(session["detail"]["exitCode"], 0);
        assert_eq!(session["detail"]["terminalStream"], session["terminalStream"]);
        let saved = store.session("a").unwrap().unwrap();
        assert_eq!(saved["rows"], 41);
        assert_eq!(saved["cols"], 123);
        assert_eq!(saved["status"], "exited");
        assert_eq!(saved["detail"]["terminalStream"]["history"]["state"], "complete");
        let mut after = 0;
        while after < last {
            let page = t.live("a", after, 10000).unwrap();
            assert!(page.to_string().len() <= WIRE);
            assert!(page["frames"].as_array().unwrap().len() <= 64);
            after = page["frames"].as_array().unwrap().last().unwrap()["index"].as_u64().unwrap();
        }
        assert_eq!(t.live("a",last,64).unwrap()["hasMore"], false);
        let before = store.last_seq().unwrap();
        drain(&t, &mut store);
        assert_eq!(before, store.last_seq().unwrap(), "idle complete markers must not retry");
    }

    #[test]
    fn session_quota_isolated_but_global_quota_stops_all_affected_ranges() {
        let t = manual(Config { archive_bytes: 900, ..Config::default() });
        let mut store = db(&["a","b"]);
        t.register(row("a")).unwrap();
        t.register(row("b")).unwrap();
        t.output("a", &[1; 1000]);
        t.output("b", b"small");
        t.finish("a", "exited", json!({}));
        t.finish("b", "exited", json!({}));
        drain(&t, &mut store);
        assert_eq!(t.session("a").unwrap()["history"]["reason"], "session_quota");
        assert_eq!(t.session("b").unwrap()["history"]["state"], "complete");
        assert!(t.shared.lock().global_failure.is_none());

        let t = manual(Config::default());
        let mut store = db(&["a","b","c"]);
        store.set_test_limits(1, 100, 1).unwrap();
        t.register(row("a")).unwrap();
        t.register(row("b")).unwrap();
        t.output("a", b"quota");
        t.output("b", b"also affected");
        archive(&t.shared, &mut store, next_batch(&t));
        for id in ["a","b"] {
            assert_eq!(t.session(id).unwrap()["history"]["reason"], "quota");
            assert_eq!(t.session(id).unwrap()["history"]["fromFrame"], 1);
        }
        check_bounds(&t);
        store.set_test_limits(1024*1024, 100, 1).unwrap();
        t.retention_changed();
        t.register(row("c")).unwrap();
        t.output("c", b"after explicit capacity restoration");
        t.finish("c", "exited", json!({}));
        drain(&t, &mut store);
        assert_eq!(t.session("c").unwrap()["history"]["state"], "complete");
        assert_eq!(t.session("a").unwrap()["history"]["reason"], "quota");
    }

    #[test]
    fn inflight_purge_preflight_release_and_purged_ring() {
        let t = manual(Config::default());
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        assert!(t.ensure_purgeable("a").is_err());
        t.output("a", b"never replay after purge");
        t.finish("a", "needs_attention", json!({"readError":"broken pipe","outputTail":"incomplete"}));
        let batch = next_batch(&t);
        assert!(t.shared.lock().sessions["a"].pending.is_empty());
        assert!(t.ensure_purgeable("a").is_err(), "in-flight batch counts as pending");
        archive(&t.shared, &mut store, batch);
        t.release("a");
        drain(&t, &mut store);
        assert_eq!(store.session("a").unwrap().unwrap()["status"], "released");
        t.ensure_purgeable("a").unwrap();
        store.purge_history(&["a".into()]).unwrap();
        t.purged("a");
        let live = t.live("a", 0, 64).unwrap();
        assert!(live["frames"].as_array().unwrap().is_empty());
        assert_eq!(live["gap"]["firstFrame"], 1);
        assert_eq!(live["history"]["reason"], "explicit_purge");
        assert_eq!(live["session"]["status"], "released");
        drain(&t, &mut store);
        assert_eq!(t.session("a").unwrap()["history"]["state"], "incomplete");
        check_bounds(&t);
    }

    #[test]
    fn reader_loss_and_failed_final_marker_never_claim_complete() {
        for detail in [json!({"outputNotRetained":true}), json!({"outputTail":"incomplete: still draining"}), json!({"readError":"I/O"})] {
            let t = manual(Config::default());
            let mut store = db(&["a"]);
            t.register(row("a")).unwrap();
            t.output("a", b"prefix");
            t.finish("a", "exited", detail.clone());
            drain(&t, &mut store);
            let s = t.session("a").unwrap();
            assert_eq!(s["history"]["state"], "incomplete");
            for (key, value) in detail.as_object().unwrap() { assert_eq!(s["detail"][key], *value); }
        }
        let t = manual(Config::default());
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        t.finish("a", "exited", json!({"exitCode":0}));
        archive(&t.shared, &mut store, next_batch(&t));
        store.0.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON events WHEN NEW.kind='state' BEGIN SELECT RAISE(ABORT,'test checkpoint failure'); END;").unwrap();
        drain(&t, &mut store);
        let s = t.session("a").unwrap();
        assert_eq!(s["status"], "exited");
        assert_eq!(s["history"]["state"], "error");
        assert_eq!(s["history"]["reason"], "io");
        assert!(!t.shared.lock().sessions["a"].marker_dirty);
        let last = store.last_seq().unwrap();
        drain(&t, &mut store);
        assert_eq!(store.last_seq().unwrap(), last);
    }

    #[test]
    fn actual_sqlite_full_is_io_and_does_not_stop_runtime() {
        let mut store = db(&["a"]);
        let pages: i64 = store.0.query_row("PRAGMA page_count", [], |r|r.get(0)).unwrap();
        store.0.pragma_update(None, "max_page_count", pages).unwrap();
        let t = manual(Config::default());
        t.register(row("a")).unwrap();
        t.output("a", &[42; 64*1024]);
        let batch = next_batch(&t);
        let error = store.provider_event("a", &batch.payload).unwrap_err();
        match error.downcast_ref::<rusqlite::Error>() {
            Some(rusqlite::Error::SqliteFailure(code, _)) => assert_eq!(code.code, rusqlite::ErrorCode::DiskFull),
            other => panic!("expected typed SQLITE_FULL, got {other:?}"),
        }
        assert_eq!(Store::history_error_reason(&error), "io");
        archive(&t.shared, &mut store, batch);
        assert_eq!(t.session("a").unwrap()["history"]["state"], "error");
        assert_eq!(t.session("a").unwrap()["status"], "running");
        let before = t.session("a").unwrap()["terminalStream"]["lastFrame"].as_u64().unwrap();
        t.output("a", b"live after full");
        assert_eq!(t.session("a").unwrap()["terminalStream"]["lastFrame"], before+1);
        assert_eq!(t.session("a").unwrap()["history"]["fromFrame"], 1);
    }

    #[test]
    fn locked_database_never_blocks_publication_or_bounded_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        store.insert(&row("a")).unwrap();
        let t = TerminalStreams::new(&path, "locked".into()).unwrap();
        let lock = Connection::open(&path).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let start = Instant::now();
        t.register(row("a")).unwrap();
        for _ in 0..100 { t.output("a", b"available while SQLite is locked"); }
        t.resize("a", 40, 100);
        assert_eq!(t.live("a",0,64).unwrap()["frames"][0]["kind"], "resize");
        t.finish("a", "stopped", json!({"exitCode":0}));
        assert_eq!(t.session("a").unwrap()["status"], "stopped");
        assert!(start.elapsed() < Duration::from_millis(150), "public API waited for SQLite");
        let start = Instant::now();
        t.shutdown();
        assert!(start.elapsed() < Duration::from_millis(850));
        assert_ne!(t.session("a").unwrap()["history"]["state"], "complete");
        lock.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn real_writer_flushes_within_latency_and_weak_ownership_ends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut store = Store::open(&path).unwrap();
        store.insert(&row("a")).unwrap();
        let t = TerminalStreams::new(&path, "async".into()).unwrap();
        t.register(row("a")).unwrap();
        t.output("a", b"immediate live, bounded archive latency");
        assert_eq!(t.live("a",1,64).unwrap()["frames"][0]["kind"], "output");
        let until = Instant::now() + Duration::from_secs(2);
        while t.session("a").unwrap()["history"]["durableFrame"].as_u64().unwrap() < 2 {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        t.finish("a", "exited", json!({"exitCode":0}));
        t.shutdown();
        assert_eq!(t.session("a").unwrap()["history"]["state"], "complete");
        let weak = Arc::downgrade(&t.shared);
        drop(t);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn metadata_admission_is_bounded_without_database_access() {
        let t = manual(Config::default());
        let mut oversized = row("large");
        oversized["detail"] = json!({"large":"x".repeat(SESSION_METADATA)});
        assert!(t.register(oversized).is_err());
        let mut count = 0;
        while t.register(row(&format!("s{count}"))).is_ok() { count += 1; }
        assert!(count > 0 && count <= 4096);
        for n in 0..count {
            t.finish(&format!("s{n}"), "exited", json!({"detail":"x".repeat(32*1024)}));
        }
        check_bounds(&t);
    }

    fn take_marker(t: &TerminalStreams) -> Marker {
        match work(&t.shared, &mut t.shared.lock()) {
            Work::Marker(task) => task,
            _ => panic!("expected marker"),
        }
    }

    #[test]
    fn archive_busy_150ms_retries_exact_batch_without_loss_or_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy-archive");
        let mut store = Store::open(&path).unwrap();
        store.0.busy_timeout(Duration::from_millis(50)).unwrap();
        store.insert(&row("a")).unwrap();
        let t = manual(Config::default());
        t.register(row("a")).unwrap();
        let input: Vec<u8> = (0..140000).map(|n| (n%251) as u8).collect();
        t.output("a", &input);
        t.finish("a", "exited", json!({"exitCode":0}));
        let batch = next_batch(&t);
        let lock = Connection::open(&path).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let error = store.provider_event("a", &batch.payload).unwrap_err();
        assert!(Store::history_is_busy(&error));
        let shared = t.shared.clone();
        let worker = thread::spawn(move || { archive(&shared, &mut store, batch); store });
        thread::sleep(Duration::from_millis(150));
        assert!(t.shared.lock().sessions["a"].pending_frames > 0);
        assert!(t.ensure_purgeable("a").is_err());
        assert_eq!(t.session("a").unwrap()["status"], "exited");
        lock.execute_batch("ROLLBACK").unwrap();
        let mut store = worker.join().unwrap();
        drain(&t, &mut store);
        assert_eq!(t.session("a").unwrap()["history"]["state"], "complete");
        assert!(t.shared.lock().global_failure.is_none());
        let groups: Vec<String> = store.0.prepare("SELECT data FROM events WHERE kind='provider' ORDER BY seq")
            .unwrap().query_map([], |r|r.get(0)).unwrap().map(Result::unwrap).collect();
        let mut recovered = Vec::new();
        let mut indices = Vec::new();
        for data in groups {
            let value: Value = serde_json::from_str(&data).unwrap();
            for f in value["params"]["frames"].as_array().unwrap() {
                indices.push(f["index"].as_u64().unwrap());
                if f["kind"] == "output" { recovered.extend(STANDARD.decode(f["data"].as_str().unwrap()).unwrap()); }
            }
        }
        assert_eq!(recovered, input);
        let last = t.shared.lock().sessions["a"].last;
        assert_eq!(indices, (1..=last).collect::<Vec<_>>());
        check_bounds(&t);
    }

    #[test]
    fn busy_checkpoint_is_inflight_fenced_and_commits_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy-marker");
        let mut store = Store::open(&path).unwrap();
        store.0.busy_timeout(Duration::from_millis(50)).unwrap();
        store.insert(&row("a")).unwrap();
        let t = manual(Config { session_limit: 1, ..Config::default() });
        t.register(row("a")).unwrap();
        t.finish("a", "exited", json!({}));
        archive(&t.shared, &mut store, next_batch(&t));
        let task = take_marker(&t);
        assert!(t.shared.lock().sessions["a"].marker_inflight);
        assert!(t.ensure_purgeable("a").is_err());
        assert!(t.prepare_register(&row("b")).is_err());
        let before = store.last_seq().unwrap();
        let lock = Connection::open(&path).unwrap();
        lock.execute_batch("BEGIN IMMEDIATE").unwrap();
        let shared = t.shared.clone();
        let worker = thread::spawn(move || { marker(&shared, &mut store, task); store });
        thread::sleep(Duration::from_millis(150));
        assert!(t.shared.lock().sessions["a"].marker_inflight);
        assert!(t.ensure_purgeable("a").is_err());
        lock.execute_batch("ROLLBACK").unwrap();
        let store = worker.join().unwrap();
        assert_eq!(store.last_seq().unwrap(), before+1);
        let m = t.shared.lock();
        assert!(!m.sessions["a"].marker_inflight);
        assert_eq!(m.sessions["a"].saved_revision, Some(m.sessions["a"].revision));
        assert!(m.sessions["a"].complete);
        drop(m);
        t.ensure_purgeable("a").unwrap();
        assert!(matches!(work(&t.shared, &mut t.shared.lock()), Work::Wait));
        assert!(t.prepare_register(&row("b")).is_err(), "sealed session must not evict");
        t.cancel_purge("a");
        t.prepare_register(&row("b")).unwrap();
        assert!(t.session("a").is_none());
    }

    #[test]
    fn retry_locked_is_bounded_and_nonbusy_errors_are_not_retried() {
        let t = manual(Config::default());
        let mut attempts = 0;
        retry_busy(&t.shared, || {
            attempts += 1;
            if attempts < 3 {
                Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED), None).into())
            } else { Ok(()) }
        }).unwrap();
        assert_eq!(attempts, 3);
        let mut attempts = 0;
        let start = Instant::now();
        let result = retry_busy(&t.shared, || {
            attempts += 1;
            Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY), None).into())
        });
        assert!(result.is_err());
        assert!(attempts > 1 && attempts < 110);
        assert!(start.elapsed() >= Duration::from_millis(1900));
        assert!(start.elapsed() < Duration::from_millis(2200));
        let mut attempts = 0;
        retry_busy(&t.shared, || {
            attempts += 1;
            Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL), None).into())
        }).unwrap_err();
        assert_eq!(attempts, 1);
    }

    #[test]
    fn durable_finished_caches_evict_oldest_beyond_capacity() {
        let t = manual(Config { session_limit: 3, ..Config::default() });
        let mut store = db(&[]);
        for n in 0..40 {
            let id = format!("s{n}");
            let session = row(&id);
            t.prepare_register(&session).unwrap();
            store.insert(&session).unwrap();
            t.register(session).unwrap();
            t.output(&id, b"retained in database after cache eviction");
            t.finish(&id, "exited", if n%2==0 { json!({"outputNotRetained":true}) } else { json!({}) });
            drain(&t, &mut store);
            let m = t.shared.lock();
            assert!(m.sessions.len() <= 3);
            assert_eq!(m.order.len(), m.sessions.len());
            drop(m);
            if n >= 3 { assert!(t.session(&format!("s{}",n-3)).is_none()); }
            check_bounds(&t);
        }
        assert_eq!(store.sessions().unwrap().len(), 40);
        assert!(store.session("s0").unwrap().unwrap()["detail"]["terminalStream"].is_object());
        assert_eq!(t.sessions().len(), 3);
    }

    #[test]
    fn unpersisted_final_and_stale_checkpoint_never_evict() {
        let t = manual(Config { session_limit: 1, ..Config::default() });
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        t.finish("a", "needs_attention", json!({"outputNotRetained":true}));
        archive(&t.shared, &mut store, next_batch(&t));
        let task = take_marker(&t);
        assert!(t.prepare_register(&row("b")).is_err());
        t.release("a"); // An older, already captured marker must not permit eviction.
        store.native_checkpoint(&t.session("a").unwrap()).unwrap();
        marker(&t.shared, &mut store, task);
        assert_eq!(store.session("a").unwrap().unwrap()["status"], "released");
        assert!(t.prepare_register(&row("b")).is_err());
        assert_eq!(t.session("a").unwrap()["detail"]["reason"], RELEASE_REASON);
        assert_eq!(t.session("a").unwrap()["detail"]["custom"], "preserved");
        drain(&t, &mut store);
        assert_eq!(store.session("a").unwrap().unwrap()["status"], "released");
        t.prepare_register(&row("b")).unwrap();
        assert!(t.session("a").is_none());

        let t = manual(Config { session_limit: 1, ..Config::default() });
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        t.finish("a", "needs_attention", json!({}));
        archive(&t.shared, &mut store, next_batch(&t));
        store.0.execute_batch("CREATE TRIGGER fail_final BEFORE INSERT ON events WHEN NEW.kind='state' BEGIN SELECT RAISE(ABORT,'unpersisted final'); END;").unwrap();
        drain(&t, &mut store);
        assert!(t.prepare_register(&row("b")).is_err());
        assert!(t.session("a").is_some());
        assert_eq!(t.shared.lock().sessions["a"].saved_revision, None);
    }

    #[test]
    fn thousand_resize_barriers_do_not_flood_exempt_state_rows() {
        let t = manual(Config::default());
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        drain(&t, &mut store);
        let states = |store: &Store| store.0.query_row("SELECT count(*) FROM events WHERE kind='state'", [], |r|r.get::<_,i64>(0)).unwrap();
        let initial = states(&store);
        for n in 1..=1000 {
            t.resize("a", n%100+1, n%200+1);
            drain(&t, &mut store);
        }
        assert_eq!(states(&store), initial);
        assert_eq!(t.session("a").unwrap()["rows"], 1);
        t.resize("a", 73, 151);
        t.finish("a", "exited", json!({"exitCode":0}));
        drain(&t, &mut store);
        assert_eq!(states(&store), initial+1);
        let saved = store.session("a").unwrap().unwrap();
        assert_eq!(saved["rows"], 73);
        assert_eq!(saved["cols"], 151);
        assert_eq!(saved["detail"]["terminalStream"]["revision"], t.session("a").unwrap()["terminalStream"]["revision"]);
        assert_eq!(t.session("a").unwrap()["history"]["state"], "complete");
    }

    #[test]
    fn failed_purge_cancel_preserves_ring_and_reenables_checkpoints() {
        let t = manual(Config::default());
        let mut store = db(&["a"]);
        t.register(row("a")).unwrap();
        t.output("a", b"must survive a cancelled purge");
        t.finish("a", "exited", json!({}));
        drain(&t, &mut store);
        let before = t.live("a", 0, 64).unwrap();
        t.ensure_purgeable("a").unwrap();
        t.release("a");
        assert!(matches!(work(&t.shared, &mut t.shared.lock()), Work::Wait));
        assert_eq!(t.live("a",0,64).unwrap()["frames"], before["frames"]);
        store.0.execute_batch("CREATE TRIGGER fail_purge BEFORE UPDATE OF kind ON events WHEN NEW.kind='purged' BEGIN SELECT RAISE(ABORT,'test failed purge'); END;").unwrap();
        assert!(store.purge_history(&["a".into()]).is_err());
        t.cancel_purge("a");
        store.0.execute_batch("DROP TRIGGER fail_purge").unwrap();
        drain(&t, &mut store);
        assert_eq!(t.live("a",0,64).unwrap()["frames"], before["frames"]);
        assert_eq!(t.session("a").unwrap()["history"]["state"], "complete");
        assert_eq!(store.session("a").unwrap().unwrap()["detail"]["reason"], RELEASE_REASON);
        t.ensure_purgeable("a").unwrap();
        let rev = t.shared.lock().sessions["a"].revision;
        store.purge_history(&["a".into()]).unwrap();
        t.purged("a");
        assert_eq!(t.shared.lock().sessions["a"].revision, rev+1);
        drain(&t, &mut store);
        assert_eq!(t.session("a").unwrap()["history"]["reason"], "explicit_purge");
        assert!(t.live("a",0,64).unwrap()["frames"].as_array().unwrap().is_empty());
        t.cancel_purge("unknown");
        t.ensure_purgeable("unknown").unwrap();
        check_bounds(&t);
    }


    #[test]
    fn metadata_byte_pressure_evicts_only_saved_final_caches() {
        let config = Config { metadata_limit: 36*1024, ..Config::default() };
        let t = manual(config);
        let mut store = db(&[]);
        for n in 0..30 {
            let id = format!("bytes{n}");
            let session = row(&id);
            t.prepare_register(&session).unwrap();
            store.insert(&session).unwrap();
            t.register(session).unwrap();
            t.finish(&id, "exited", json!({"exitCode":0}));
            drain(&t, &mut store);
            let m = t.shared.lock();
            assert!(m.metadata_bytes <= t.shared.config.metadata_limit);
            assert!(m.sessions.len() < 10);
            assert_eq!(m.order.len(), m.sessions.len());
            drop(m);
            check_bounds(&t);
        }
        assert!(t.session("bytes0").is_none());
        assert!(t.session("bytes29").is_some());
        assert!(store.session("bytes0").unwrap().is_some());
    }

}

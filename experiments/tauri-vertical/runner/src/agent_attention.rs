//! Runner-side declared agent state and seen/unseen alerts (Jauría 1.4 E).
//!
//! Memory: one `Record` per session that produced a signal. Callers only take
//! the short `inner` mutex; the PTY reader never touches the main Store.
//! SQLite: the `agent_attention` table in runner.sqlite, written exclusively by
//! the `agent-attention` thread through its own connection.
//!
//! Alerts are sequenced per session. Every alert takes `alert_seq + 1`, and the
//! record keeps, per kind, the sequence of its latest occurrence. An alert is
//! pending while `seq > seen_seq`. `mark_seen(epoch, through)` only raises
//! `seen_seq` to `min(through, alert_seq)`, and only for the record's current
//! incarnation (`epoch`), so a client that saw N can never hide a racing N+1,
//! nor an alert of a row that was pruned and created again.
//!
//! Superseding: `needs` lasts while blocked/error is declared (leaving it, by
//! any later declaration, removes it, as the client tracker does). `finished`
//! is never removed by a later declaration: it stays pending until seen, and
//! a later end of turn moves it to the new sequence. Process end and restarts
//! never clear an unseen alert. After process end the session is sealed: late
//! PTY bytes (a reader still draining) are not interpreted at all.
//!
//! Durability: `mark_seen` waits until its change is committed (one waiter at
//! a time, bounded by `seen_timeout`) and reports `durable`. Other changes are
//! committed within `flush_delay` (250 ms) plus SQLite time; a crash inside
//! that window loses at most those changes, never a confirmed seen. Shutdown
//! runs after the PTY wait threads and Codex workers end and flushes with best
//! effort for at most SHUTDOWN_FLUSH (3 s); with SQLite still busy after that,
//! the queued changes are lost. If the table exists with an unexpected
//! definition, or the writer fails, attention stays in memory (`durable:false`).
//!
//! Retention: rows survive purge_history and compact_final_history (those only
//! touch `events`). Orphans (no `sessions` row) are deleted at startup. Rows
//! of sessions whose process ended (confirmed final) with every alert seen are
//! capped at IDLE_ROWS, oldest first: at startup, and at run time when they
//! exceed IDLE_ROWS + IDLE_SLACK. Rows with a pending alert, a live process or
//! an uncertain end are never dropped.
use crate::agent_signals::{Declared, Signal};
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    sync::{Arc, Condvar, Mutex, MutexGuard, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS agent_attention(
    session_id TEXT PRIMARY KEY NOT NULL,
    generation TEXT NOT NULL,
    state TEXT CHECK(state IS NULL OR state IN ('working','blocked','error','done','idle')),
    state_changed_at INTEGER,
    state_frame INTEGER,
    turn_open INTEGER NOT NULL DEFAULT 0 CHECK(turn_open IN (0,1)),
    turn_started_at INTEGER,
    turn_ended_at INTEGER,
    last_turn_ms INTEGER,
    turn_interrupted INTEGER NOT NULL DEFAULT 0 CHECK(turn_interrupted IN (0,1)),
    alert_seq INTEGER NOT NULL DEFAULT 0 CHECK(alert_seq>=0),
    seen_seq INTEGER NOT NULL DEFAULT 0 CHECK(seen_seq>=0 AND seen_seq<=alert_seq),
    needs_seq INTEGER NOT NULL DEFAULT 0, needs_frame INTEGER,
    finished_seq INTEGER NOT NULL DEFAULT 0, finished_frame INTEGER,
    bell_seq INTEGER NOT NULL DEFAULT 0, bell_frame INTEGER,
    notify_seq INTEGER NOT NULL DEFAULT 0, notify_frame INTEGER,
    ended_seq INTEGER NOT NULL DEFAULT 0,
    permission_seq INTEGER NOT NULL DEFAULT 0, permission_request TEXT, permission_generation INTEGER,
    updated_at INTEGER NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>0))";
const COLUMNS: &str = "session_id,generation,state,state_changed_at,state_frame,turn_open,turn_started_at,turn_ended_at,last_turn_ms,turn_interrupted,alert_seq,seen_seq,needs_seq,needs_frame,finished_seq,finished_frame,bell_seq,bell_frame,notify_seq,notify_frame,ended_seq,permission_seq,permission_request,permission_generation,updated_at,epoch";
pub const IDLE_ROWS: usize = 512;
/// Hot pruning starts above IDLE_ROWS + IDLE_SLACK, then trims to IDLE_ROWS.
const IDLE_SLACK: usize = 64;
/// Most `agent` objects in one status response; see `status_into`. Live
/// sessions are at most 8 (admission limit); the rest are pending ones.
pub const STATUS_AGENTS: usize = 128;
pub const MARK_SEEN_ITEMS: usize = 64;
const RATE: Duration = Duration::from_secs(1);
/// Best-effort flush bound at shutdown (SQLite busy keeps retrying until then).
pub const SHUTDOWN_FLUSH: Duration = Duration::from_secs(3);
const FINAL: [&str; 5] = ["exited", "stopped", "failed", "interrupted", "released"];

pub type Clock = Arc<dyn Fn() -> (i64, Instant) + Send + Sync>;
pub fn system_clock() -> Clock {
    Arc::new(|| (SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64), Instant::now()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Needs, Finished, Bell, Notify, Ended, Permission }
impl Kind {
    pub const ALL: [Kind; 6] = [Kind::Needs, Kind::Finished, Kind::Bell, Kind::Notify, Kind::Ended, Kind::Permission];
    pub fn name(self) -> &'static str {
        match self { Kind::Needs => "needs", Kind::Finished => "finished", Kind::Bell => "bell", Kind::Notify => "notify", Kind::Ended => "ended", Kind::Permission => "permission" }
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Alert { seq: u64, frame: Option<u64> }

#[derive(Clone, Default, Debug)]
pub struct Record {
    state: Option<Declared>,
    state_changed_at: Option<i64>,
    state_frame: Option<u64>,
    turn_open: bool,
    turn_started_at: Option<i64>,
    turn_clock: Option<Instant>,
    turn_ended_at: Option<i64>,
    last_turn_ms: Option<u64>,
    turn_interrupted: bool,
    alert_seq: u64,
    seen_seq: u64,
    alerts: [Alert; 6],
    permission: Option<(String, i64)>,
    last_bell: Option<Instant>,
    last_notify: Option<Instant>,
    updated_at: i64,
    /// Incarnation of this row: random, published as `epoch`, required by
    /// mark_seen. A row created again for the same id gets a new one.
    epoch: u64,
    /// Process ended with a confirmed final status (or row loaded as final):
    /// eligible for idle pruning once every alert is seen.
    finished_process: bool,
}

/// 53-bit (JavaScript-safe), nonzero.
fn new_epoch() -> u64 {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    let random = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_ok();
    let value = if random { u64::from_le_bytes(bytes) } else {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64)
    };
    (value & ((1 << 53) - 1)).max(1)
}

impl Record {
    fn alert(&self, kind: Kind) -> Alert { self.alerts[kind as usize] }
    fn pending(&self, kind: Kind) -> bool { self.alert(kind).seq > self.seen_seq }
    pub fn pending_count(&self) -> usize { Kind::ALL.iter().filter(|k| self.pending(**k)).count() }
    fn raise(&mut self, kind: Kind, frame: Option<u64>) {
        self.alert_seq += 1;
        self.alerts[kind as usize] = Alert { seq: self.alert_seq, frame };
    }
    fn supersede(&mut self, kind: Kind) { self.alerts[kind as usize] = Alert::default(); }
    fn close_turn(&mut self, now: (i64, Instant), interrupted: bool) {
        if !self.turn_open { return; }
        self.turn_open = false;
        self.turn_ended_at = Some(now.0);
        self.last_turn_ms = self.turn_clock.map(|t| now.1.saturating_duration_since(t).as_millis() as u64);
        self.turn_clock = None;
        self.turn_interrupted = interrupted;
    }
    fn declare(&mut self, next: Option<Declared>, frame: Option<u64>, now: (i64, Instant)) {
        use Declared::*;
        let previous = self.state;
        if previous == next { return; }
        let alerting = |s: Option<Declared>| matches!(s, Some(Blocked | Error));
        let working_like = |s: Option<Declared>| matches!(s, Some(Working | Blocked | Error));
        self.state = next;
        self.state_changed_at = Some(now.0);
        self.state_frame = frame;
        // `needs` lasts while the program declares blocked/error (client
        // ProgramStatusTracker parity): an agent that unblocked itself no
        // longer needs the person. `finished` is NOT superseded (unlike the
        // client tracker): an unseen end of turn stays pending until
        // mark_seen, even if the agent already started another turn.
        if alerting(previous) && !alerting(next) { self.supersede(Kind::Needs); }
        if next == Some(Working) && !self.turn_open {
            self.turn_open = true;
            self.turn_started_at = Some(now.0);
            self.turn_clock = Some(now.1);
            self.turn_ended_at = None;
            self.turn_interrupted = false;
        }
        if alerting(next) && !alerting(previous) { self.raise(Kind::Needs, frame); }
        if matches!(next, Some(Done | Idle)) && working_like(previous) { self.raise(Kind::Finished, frame); }
        if matches!(next, Some(Done | Idle) | None) { self.close_turn(now, false); }
    }

    fn json(&self, current: &str, generation: &str) -> Value {
        // Frame cursors only mean something inside the generation that wrote them.
        let frame = |f: Option<u64>| if current == generation { f.map(Value::from).unwrap_or(Value::Null) } else { Value::Null };
        let mut pending = serde_json::Map::new();
        for kind in Kind::ALL {
            if !self.pending(kind) { continue; }
            let alert = self.alert(kind);
            let mut value = json!({"seq": alert.seq});
            match kind {
                Kind::Ended => {}
                Kind::Permission => if let Some((request, generation)) = &self.permission {
                    value["requestId"] = json!(request);
                    value["generation"] = json!(generation);
                },
                _ => value["frame"] = frame(alert.frame),
            }
            pending.insert(kind.name().into(), value);
        }
        json!({"epoch": self.epoch, "state": self.state.map(Declared::as_str), "changedAt": self.state_changed_at,
            "stateFrame": frame(self.state_frame), "turnOpen": self.turn_open,
            "turnStartedAt": self.turn_started_at, "turnEndedAt": self.turn_ended_at,
            "lastTurnMs": self.last_turn_ms, "turnInterrupted": self.turn_interrupted,
            "alertSeq": self.alert_seq, "seenSeq": self.seen_seq,
            "finishedUnseen": self.pending(Kind::Finished), "pending": pending})
    }
}

struct Entry { record: Record, generation: String }

struct Inner {
    records: HashMap<String, Entry>,
    /// PTY sessions whose process ended in this generation: their late
    /// output is never interpreted (no state, turn, BEL or notify).
    sealed: std::collections::HashSet<String>,
    deleted: BTreeSet<String>,
    /// At most one mark_seen waits for durability; others answer at once.
    waiting: bool,
    dirty: BTreeSet<String>,
    since: Option<Instant>,
    requested: u64,
    flushed: u64,
    urgent: bool,
    durable: bool,
    /// Set by shutdown: the writer drains everything queued until then and
    /// keeps accepting changes until it empties the queue or SHUTDOWN_FLUSH.
    stop: Option<Instant>,
    #[cfg(test)] crash: bool,
}

pub struct Config { pub flush_delay: Duration, pub seen_timeout: Duration }
impl Default for Config {
    fn default() -> Self { Self { flush_delay: Duration::from_millis(250), seen_timeout: Duration::from_secs(2) } }
}

pub struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
    flushed: Condvar,
    generation: String,
    clock: Clock,
    config: Config,
}

/// Owner handle. The writer only holds a Weak<Shared>, so dropping the last
/// Attention always runs the bounded flush from the dropping thread.
pub struct Attention {
    shared: Arc<Shared>,
    done: Mutex<Option<mpsc::Receiver<()>>>,
}
impl std::ops::Deref for Attention {
    type Target = Shared;
    fn deref(&self) -> &Shared { &self.shared }
}

fn lock(m: &Mutex<Inner>) -> MutexGuard<'_, Inner> { m.lock().unwrap_or_else(|e| e.into_inner()) }

/// Exactly our table and its primary-key autoindex; nothing else on it.
fn objects(db: &Connection) -> Result<Vec<(String, String, Option<String>)>> {
    Ok(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='agent_attention' OR name='agent_attention' ORDER BY type,name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.map(|s| crate::storage::normalized_sql(&s)))))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Creates the table if absent. Returns Ok(false) when it exists with another
/// definition: the caller then stays in memory and never rejects the profile.
pub fn ensure_schema(db: &Connection) -> Result<bool> {
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(SCHEMA_SQL)?;
    let expected = objects(&reference)?;
    let found = objects(db)?;
    if found.is_empty() {
        db.execute_batch(SCHEMA_SQL)?;
        return Ok(objects(db)? == expected);
    }
    Ok(found == expected)
}

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, Record)> {
    let u = |i: usize| -> rusqlite::Result<u64> { Ok(r.get::<_, i64>(i)?.max(0) as u64) };
    let o = |i: usize| -> rusqlite::Result<Option<u64>> { Ok(r.get::<_, Option<i64>>(i)?.map(|v| v.max(0) as u64)) };
    let mut record = Record {
        state: r.get::<_, Option<String>>(2)?.as_deref().and_then(Declared::parse),
        state_changed_at: r.get(3)?, state_frame: o(4)?, turn_open: r.get::<_, i64>(5)? == 1,
        turn_started_at: r.get(6)?, turn_ended_at: r.get(7)?, last_turn_ms: o(8)?,
        turn_interrupted: r.get::<_, i64>(9)? == 1, alert_seq: u(10)?, seen_seq: u(11)?,
        updated_at: r.get(24)?, epoch: u(25)?.max(1), ..Record::default()
    };
    for (kind, seq, frame) in [(Kind::Needs, 12, Some(13)), (Kind::Finished, 14, Some(15)), (Kind::Bell, 16, Some(17)), (Kind::Notify, 18, Some(19)), (Kind::Ended, 20, None), (Kind::Permission, 21, None)] {
        record.alerts[kind as usize] = Alert { seq: u(seq)?.min(record.alert_seq), frame: match frame { Some(i) => o(i)?, None => None } };
    }
    let request: Option<String> = r.get(22)?;
    let generation: Option<i64> = r.get(23)?;
    record.permission = request.zip(generation);
    record.seen_seq = record.seen_seq.min(record.alert_seq);
    Ok((r.get(0)?, r.get(1)?, record))
}

fn write_row(tx: &Connection, id: &str, generation: &str, r: &Record) -> Result<()> {
    let i = |v: u64| v.min(i64::MAX as u64) as i64;
    let f = |v: Option<u64>| v.map(i);
    let a = |k: Kind| r.alert(k);
    tx.execute(&format!("INSERT OR REPLACE INTO agent_attention({COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)"),
        params![id, generation, r.state.map(Declared::as_str), r.state_changed_at, f(r.state_frame), r.turn_open as i64,
            r.turn_started_at, r.turn_ended_at, f(r.last_turn_ms), r.turn_interrupted as i64, i(r.alert_seq), i(r.seen_seq),
            i(a(Kind::Needs).seq), f(a(Kind::Needs).frame), i(a(Kind::Finished).seq), f(a(Kind::Finished).frame),
            i(a(Kind::Bell).seq), f(a(Kind::Bell).frame), i(a(Kind::Notify).seq), f(a(Kind::Notify).frame),
            i(a(Kind::Ended).seq), i(a(Kind::Permission).seq), r.permission.as_ref().map(|p| p.0.as_str()),
            r.permission.as_ref().map(|p| p.1), r.updated_at, i(r.epoch.max(1))])?;
    Ok(())
}

impl Attention {
    /// `sessions` are (id, status) after the runner's own startup recovery.
    /// `path` None means memory only (tests, or no profile).
    pub fn open(path: Option<&Path>, generation: String, sessions: &[(String, String)], clock: Clock, config: Config) -> Arc<Self> {
        let mut records = HashMap::new();
        let conn = path.and_then(|path| match Self::load(path, &generation, sessions, &clock, &mut records) {
            Ok(conn) => conn,
            Err(error) => { eprintln!("agent_attention: persistence unavailable, memory only: {error:#}"); records.clear(); None }
        });
        let durable = conn.is_some();
        let attention = Arc::new(Self { shared: Arc::new(Shared {
            inner: Mutex::new(Inner { records, sealed: Default::default(), deleted: BTreeSet::new(), waiting: false, dirty: BTreeSet::new(), since: None, requested: 0, flushed: 0,
                urgent: false, durable, stop: None, #[cfg(test)] crash: false }),
            wake: Condvar::new(), flushed: Condvar::new(), generation, clock, config }), done: Mutex::new(None),
        });
        if let Some(conn) = conn {
            let weak = Arc::downgrade(&attention.shared);
            let (tx, rx) = mpsc::channel();
            let spawned = thread::Builder::new().name("agent-attention".into()).spawn(move || {
                writer(weak, conn);
                let _ = tx.send(());
            });
            match spawned {
                Ok(_) => *attention.done.lock().unwrap() = Some(rx),
                Err(_) => lock(&attention.inner).durable = false,
            }
        }
        attention
    }

    fn load(path: &Path, generation: &str, sessions: &[(String, String)], clock: &Clock, records: &mut HashMap<String, Entry>) -> Result<Option<Connection>> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_millis(1000))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        if !ensure_schema(&conn)? {
            eprintln!("agent_attention: table has an unexpected definition; keeping attention in memory only");
            return Ok(None);
        }
        let now = clock();
        let status: HashMap<&str, &str> = sessions.iter().map(|(id, s)| (id.as_str(), s.as_str())).collect();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let rows = tx.prepare(&format!("SELECT {COLUMNS} FROM agent_attention"))?
            .query_map([], read_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut idle = Vec::new();
        for (id, _old, mut record) in rows {
            if !status.contains_key(id.as_str()) {
                tx.execute("DELETE FROM agent_attention WHERE session_id=?", [&id])?;
                continue;
            }
            // No PTY survives a runner restart: the declared state is gone and
            // an open turn ends interrupted without an invented duration.
            if record.turn_open {
                record.turn_open = false;
                record.turn_interrupted = true;
                record.last_turn_ms = None;
                record.turn_ended_at = None;
            }
            if record.state.is_some() { record.state = None; record.state_changed_at = Some(now.0); }
            record.state_frame = None;
            for alert in &mut record.alerts { alert.frame = None; }
            record.updated_at = record.updated_at.max(0);
            write_row(&tx, &id, generation, &record)?;
            record.finished_process = FINAL.contains(&status[id.as_str()]);
            if record.pending_count() == 0 && record.finished_process { idle.push((record.updated_at, id.clone())); }
            records.insert(id, Entry { record, generation: generation.to_owned() });
        }
        idle.sort();
        let excess = idle.len().saturating_sub(IDLE_ROWS);
        for (_, id) in idle.into_iter().take(excess) {
            tx.execute("DELETE FROM agent_attention WHERE session_id=?", [&id])?;
            records.remove(&id);
        }
        tx.commit()?;
        Ok(Some(conn))
    }

    fn touch(&self, m: &mut Inner, id: &str) {
        m.dirty.insert(id.to_owned());
        m.requested += 1;
        m.since.get_or_insert_with(Instant::now);
        self.wake.notify_one();
    }

    fn entry<'a>(&self, m: &'a mut Inner, id: &str) -> &'a mut Record {
        let entry = m.records.entry(id.to_owned()).or_insert_with(|| Entry { record: Record { epoch: new_epoch(), ..Record::default() }, generation: self.generation.clone() });
        entry.generation = self.generation.clone();
        &mut entry.record
    }

    /// PTY reader path: signals with the frame index that completed them.
    pub fn pty(&self, id: &str, signals: &[(Signal, Option<u64>)]) {
        if signals.is_empty() { return; }
        let now = (self.clock)();
        let mut m = lock(&self.inner);
        if m.sealed.contains(id) { return; }
        let record = self.entry(&mut m, id);
        let before = (record.alert_seq, record.state, record.turn_open);
        for &(signal, frame) in signals {
            match signal {
                Signal::State(state) => record.declare(Some(state), frame, now),
                Signal::Clear => record.declare(None, frame, now),
                Signal::Bell | Signal::Notify => {
                    let (last, kind) = if signal == Signal::Bell { (&mut record.last_bell, Kind::Bell) } else { (&mut record.last_notify, Kind::Notify) };
                    if last.is_some_and(|t| now.1.saturating_duration_since(t) < RATE) { continue; }
                    *last = Some(now.1);
                    record.raise(kind, frame);
                }
            }
        }
        if (record.alert_seq, record.state, record.turn_open) != before {
            record.updated_at = now.0;
            self.touch(&mut m, id);
        }
    }

    /// A PTY child's wait result was published. Only confirmed final statuses
    /// raise `ended`; needs_attention keeps its own session status cause.
    pub fn process_ended(&self, id: &str, status: &str) {
        let now = (self.clock)();
        let mut m = lock(&self.inner);
        // Sealed first: a reader still draining after finish cannot reopen it.
        m.sealed.insert(id.to_owned());
        let confirmed = matches!(status, "exited" | "stopped" | "failed");
        if !confirmed && !m.records.contains_key(id) { return; }
        let record = self.entry(&mut m, id);
        record.close_turn(now, true);
        if record.state.is_some() { record.state = None; record.state_changed_at = Some(now.0); record.state_frame = None; }
        if confirmed { record.raise(Kind::Ended, None); record.finished_process = true; }
        record.updated_at = now.0;
        self.touch(&mut m, id);
        self.prune(&mut m);
    }

    /// Hot cap with hysteresis: above IDLE_ROWS + IDLE_SLACK fully seen rows of
    /// processes that ended (confirmed), trim the oldest down to IDLE_ROWS.
    /// Rows with a pending alert or a live/uncertain process are never dropped.
    fn prune(&self, m: &mut Inner) {
        if m.records.len() <= IDLE_ROWS + IDLE_SLACK { return; }
        let mut idle: Vec<(i64, String)> = m.records.iter()
            .filter(|(_, e)| e.record.finished_process && e.record.pending_count() == 0)
            .map(|(id, e)| (e.record.updated_at, id.clone())).collect();
        if idle.len() <= IDLE_ROWS + IDLE_SLACK { return; }
        idle.sort();
        let excess = idle.len() - IDLE_ROWS;
        for (_, id) in idle.into_iter().take(excess) {
            m.records.remove(&id);
            m.dirty.remove(&id);
            m.deleted.insert(id);
        }
        m.requested += 1;
        m.since.get_or_insert_with(Instant::now);
        self.wake.notify_one();
    }

    /// Only after a new, committed provider_requests insertion.
    pub fn permission(&self, id: &str, request_id: &str, generation: i64) {
        let now = (self.clock)();
        let mut m = lock(&self.inner);
        let record = self.entry(&mut m, id);
        record.raise(Kind::Permission, None);
        record.permission = Some((request_id.to_owned(), generation));
        record.updated_at = now.0;
        self.touch(&mut m, id);
    }

    pub fn snapshot(&self, id: &str) -> Option<Value> {
        let m = lock(&self.inner);
        m.records.get(id).map(|e| e.record.json(&self.generation, &e.generation))
    }

    /// Validated items `(id, epoch, through)`. An item whose epoch is not the
    /// record's current incarnation has no effect and returns the current
    /// agent (`rejected: "epoch"`), so a cursor from a pruned and recreated
    /// row can never mark a newer alert. Never resolves a permission or
    /// changes custody. Only one call at a time waits for durability (at most
    /// `seen_timeout`); concurrent calls answer at once, durable or not, so
    /// mark_seen can never hold the socket's client slots.
    pub fn mark_seen(&self, items: &[(String, u64, u64)]) -> Value {
        let now = (self.clock)();
        let mut m = lock(&self.inner);
        let mut results = Vec::with_capacity(items.len());
        for (id, epoch, through) in items {
            let Some(entry) = m.records.get_mut(id) else { results.push(json!({"id": id, "agent": null})); continue; };
            let record = &mut entry.record;
            if record.epoch != *epoch {
                results.push(json!({"id": id, "rejected": "epoch", "agent": record.json(&self.generation, &entry.generation)}));
                continue;
            }
            let next = record.seen_seq.max((*through).min(record.alert_seq));
            if next != record.seen_seq { record.seen_seq = next; record.updated_at = now.0; }
            results.push(json!({"id": id, "agent": record.json(&self.generation, &entry.generation)}));
            // Re-confirm even when unchanged: an earlier change may still be in flight.
            m.dirty.insert(id.clone());
        }
        self.prune(&mut m);
        let wanted = if m.dirty.is_empty() && m.deleted.is_empty() { m.flushed } else { m.requested += 1; m.requested };
        m.urgent = true;
        self.wake.notify_one();
        if !m.waiting && m.durable && m.flushed < wanted {
            m.waiting = true;
            let deadline = Instant::now() + self.config.seen_timeout;
            while m.durable && m.flushed < wanted {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() { break; }
                m = self.flushed.wait_timeout(m, left).unwrap_or_else(|e| e.into_inner()).0;
            }
            m.waiting = false;
        }
        json!({"items": results, "durable": m.durable && m.flushed >= wanted})
    }

    /// Adds `agent` to session rows and a top-level `agentAttention` summary.
    /// Only sessions with a pending alert or a live process get one: pending
    /// first, then live, newest first, at most STATUS_AGENTS. `hasMore` and
    /// the totals are exact; terminal_live always carries a session's agent.
    pub fn status_into(&self, result: &mut Value) {
        let m = lock(&self.inner);
        let Some(rows) = result["sessions"].as_array_mut() else { return };
        let mut pending_sessions = 0usize;
        let mut pending_alerts = 0usize;
        let mut candidates = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let Some(entry) = row["id"].as_str().and_then(|id| m.records.get(id)) else { continue };
            let pending = entry.record.pending_count();
            pending_sessions += usize::from(pending > 0);
            pending_alerts += pending;
            let live = matches!(row["status"].as_str(), Some("running" | "starting"));
            if pending > 0 || live {
                candidates.push((pending == 0, std::cmp::Reverse(entry.record.updated_at), index));
            }
        }
        candidates.sort();
        let has_more = candidates.len() > STATUS_AGENTS;
        for (_, _, index) in candidates.into_iter().take(STATUS_AGENTS) {
            let row = &mut rows[index];
            let entry = &m.records[row["id"].as_str().unwrap()];
            row["agent"] = entry.record.json(&self.generation, &entry.generation);
        }
        result["agentAttention"] = json!({"hasMore": has_more, "pendingSessions": pending_sessions,
            "pendingAlerts": pending_alerts, "durable": m.durable, "maxAgents": STATUS_AGENTS});
        result["agentAttentionVersion"] = json!(1);
    }

    /// Orderly shutdown: flush everything dirty, then stop the writer. Bounded.
    pub fn shutdown(&self) {
        {
            let mut m = lock(&self.inner);
            m.stop.get_or_insert_with(Instant::now);
            m.urgent = true;
            self.wake.notify_all();
        }
        let rx = self.done.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(rx) = rx { let _ = rx.recv_timeout(SHUTDOWN_FLUSH + Duration::from_millis(500)); }
    }

    #[cfg(test)]
    pub fn durable(&self) -> bool { lock(&self.inner).durable }
    /// Test-only crash: the writer exits without committing what is dirty.
    #[cfg(test)]
    pub fn crash(&self) {
        { let mut m = lock(&self.inner); m.crash = true; m.stop = Some(Instant::now()); self.wake.notify_all(); }
        let rx = self.done.lock().unwrap().take();
        if let Some(rx) = rx { let _ = rx.recv_timeout(Duration::from_secs(3)); }
    }
    #[cfg(test)]
    pub fn wait_flushed(&self) {
        let mut m = lock(&self.inner);
        let wanted = m.requested;
        m.urgent = true;
        self.wake.notify_one();
        while m.durable && m.flushed < wanted { m = self.flushed.wait(m).unwrap(); }
    }
}

impl Drop for Attention { fn drop(&mut self) { self.shutdown(); } }

fn writer(weak: std::sync::Weak<Shared>, mut conn: Connection) {
    let mut failures = 0u32;
    loop {
        let Some(owner) = weak.upgrade() else { return };
        let batch = {
            let mut m = lock(&owner.inner);
            loop {
                #[cfg(test)] if m.crash { return; }
                let work = !m.dirty.is_empty() || !m.deleted.is_empty();
                let due = m.urgent || m.stop.is_some() || m.since.is_some_and(|t| t.elapsed() >= owner.config.flush_delay);
                if work && due { break; }
                if !work && m.stop.is_some() { return; }
                if !work { m.urgent = false; }
                let wait = m.since.map_or(Duration::from_millis(500), |t| owner.config.flush_delay.saturating_sub(t.elapsed()).max(Duration::from_millis(1)));
                m = owner.wake.wait_timeout(m, wait).unwrap_or_else(|e| e.into_inner()).0;
            }
            let ids = std::mem::take(&mut m.dirty);
            let deleted = std::mem::take(&mut m.deleted);
            m.since = None;
            m.urgent = false;
            let epoch = m.requested;
            let rows: Vec<_> = ids.iter().filter_map(|id| m.records.get(id).map(|e| (id.clone(), e.generation.clone(), e.record.clone()))).collect();
            (ids, deleted, rows, epoch)
        };
        let (ids, deleted, rows, epoch) = batch;
        let result = (|| -> Result<()> {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            // Deletions first: an id pruned and then recreated is upserted after.
            for id in &deleted { tx.execute("DELETE FROM agent_attention WHERE session_id=?", [id])?; }
            for (id, generation, record) in &rows { write_row(&tx, id, generation, record)?; }
            tx.commit()?;
            Ok(())
        })();
        let ok = result.is_ok();
        let mut m = lock(&owner.inner);
        match result {
            Ok(()) => { failures = 0; m.flushed = m.flushed.max(epoch); }
            Err(error) => {
                // Not committed: requeue. BUSY/LOCKED is retried until shutdown's
                // flush deadline (mark_seen answers durable:false meanwhile);
                // repeated other failures degrade to memory only.
                if !crate::storage::Store::history_is_busy(&error) { failures += 1; }
                let deleted: Vec<_> = deleted.into_iter().filter(|id| !m.records.contains_key(id)).collect();
                m.deleted.extend(deleted);
                let ids: Vec<_> = ids.into_iter().filter(|id| m.records.contains_key(id)).collect();
                m.dirty.extend(ids);
                m.since.get_or_insert_with(Instant::now);
                let expired = m.stop.is_some_and(|t| t.elapsed() >= SHUTDOWN_FLUSH);
                if failures >= 5 || expired {
                    eprintln!("agent_attention: writes failing, memory only: {error:#}");
                    m.durable = false;
                    owner.flushed.notify_all();
                    return;
                }
            }
        }
        owner.flushed.notify_all();
        drop(m);
        if !ok { thread::sleep(Duration::from_millis(50)); }
    }
}

/// Validates `mark_seen` arguments: {items:[{id,epoch,through}]}, 1..=64.
pub fn seen_items(args: &Value) -> Result<Vec<(String, u64, u64)>> {
    let items = args["items"].as_array().ok_or_else(|| anyhow::anyhow!("items must be an array"))?;
    ensure!((1..=MARK_SEEN_ITEMS).contains(&items.len()), "items must contain 1 to {MARK_SEEN_ITEMS} entries");
    items.iter().map(|item| {
        let object = item.as_object().ok_or_else(|| anyhow::anyhow!("each item must be an object"))?;
        ensure!(object.len() == 3 && ["id", "epoch", "through"].iter().all(|k| object.contains_key(*k)), "each item takes exactly id, epoch and through");
        let id = item["id"].as_str().ok_or_else(|| anyhow::anyhow!("invalid id"))?;
        crate::runner::validate_id(id)?;
        let epoch = item["epoch"].as_u64().filter(|e| *e > 0).ok_or_else(|| anyhow::anyhow!("epoch must be a positive integer"))?;
        let through = item["through"].as_u64().ok_or_else(|| anyhow::anyhow!("through must be a non-negative integer"))?;
        Ok((id.to_owned(), epoch, through))
    }).collect()
}

/// Existing row count, for tests and diagnostics.
#[cfg(test)]
pub fn stored(conn: &Connection, id: &str) -> Result<Option<(u64, u64)>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT alert_seq,seen_seq FROM agent_attention WHERE session_id=?", [id], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))).optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_signals::{Declared::*, Signal::*};
    use crate::storage::Store;

    struct Fake(Arc<Mutex<(i64, Instant)>>);
    impl Fake {
        fn new() -> Self { Self(Arc::new(Mutex::new((1_700_000_000_000, Instant::now())))) }
        fn clock(&self) -> Clock { let c = self.0.clone(); Arc::new(move || *c.lock().unwrap()) }
        fn advance(&self, ms: u64) { let mut c = self.0.lock().unwrap(); c.0 += ms as i64; c.1 += Duration::from_millis(ms); }
    }
    fn memory(fake: &Fake) -> Arc<Attention> { Attention::open(None, "gen-a".into(), &[], fake.clock(), Config::default()) }
    fn agent(a: &Attention, id: &str) -> Value { a.snapshot(id).unwrap() }
    fn epoch(a: &Attention, id: &str) -> u64 { a.snapshot(id).map_or(1, |v| v["epoch"].as_u64().unwrap()) }
    /// mark_seen items carrying each record's current epoch.
    fn items<S: AsRef<str>>(a: &Attention, list: &[(S, u64)]) -> Vec<(String, u64, u64)> {
        list.iter().map(|(id, through)| (id.as_ref().to_owned(), epoch(a, id.as_ref()), *through)).collect()
    }
    fn ms(a: &Attention, id: &str, through: u64) -> Value { a.mark_seen(&items(a, &[(id, through)])) }
    fn seen(a: &Attention, id: &str, through: u64) -> Value { ms(a, id, through)["items"][0]["agent"].clone() }

    #[test]
    fn transitions_turns_and_durations_follow_the_client_tracker() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("s", &[(State(Working), Some(3))]);
        let v = agent(&a, "s");
        assert_eq!((v["state"].as_str(), v["turnOpen"].as_bool(), v["alertSeq"].as_u64(), v["stateFrame"].as_u64()), (Some("working"), Some(true), Some(0), Some(3)));
        let started = v["turnStartedAt"].as_i64().unwrap();
        fake.advance(1500);
        a.pty("s", &[(State(Blocked), Some(4))]);
        let v = agent(&a, "s");
        assert_eq!(v["pending"]["needs"], json!({"seq":1,"frame":4}));
        assert_eq!(v["turnStartedAt"].as_i64(), Some(started), "blocked continues the turn");
        fake.advance(500);
        a.pty("s", &[(State(Working), Some(5))]);
        assert!(agent(&a, "s")["pending"].get("needs").is_none(), "leaving blocked supersedes needs");
        fake.advance(1000);
        a.pty("s", &[(State(Done), Some(9))]);
        let v = agent(&a, "s");
        assert_eq!((v["lastTurnMs"].as_u64(), v["turnOpen"].as_bool(), v["turnInterrupted"].as_bool()), (Some(3000), Some(false), Some(false)));
        assert_eq!(v["pending"]["finished"], json!({"seq":2,"frame":9}));
        assert_eq!(v["finishedUnseen"], true);
        // Same state again is not a change; done -> idle keeps the unseen finish.
        a.pty("s", &[(State(Done), Some(10)), (State(Idle), Some(11))]);
        assert_eq!(agent(&a, "s")["alertSeq"], 2);
        assert_eq!(agent(&a, "s")["finishedUnseen"], true);
        // Unlike the client tracker, a new turn keeps the unseen finish.
        a.pty("s", &[(State(Working), Some(12))]);
        assert_eq!(agent(&a, "s")["finishedUnseen"], true);
        // idle -> blocked -> done still finishes work (blocked counts).
        a.pty("t", &[(State(Idle), None), (State(Error), None), (State(Done), None)]);
        let v = agent(&a, "t");
        assert_eq!(v["alertSeq"], 2);
        assert!(v["pending"].get("needs").is_none());
        assert_eq!(v["pending"]["finished"]["seq"], 2);
        assert!(v["lastTurnMs"].is_null(), "no working, no turn duration");
        // clear closes the turn and supersedes needs (it left blocked).
        a.pty("u", &[(State(Working), None), (State(Blocked), None), (Clear, None)]);
        let v = agent(&a, "u");
        assert!(v["state"].is_null() && v["pending"].as_object().unwrap().is_empty() && v["turnOpen"] == false);
    }

    #[test]
    fn alert_after_seen_snapshot_survives_a_racing_mark_seen() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("s", &[(State(Blocked), Some(1))]);
        let shown = agent(&a, "s")["alertSeq"].as_u64().unwrap(); // the client painted N
        // Alert N+1 lands between the client's snapshot and its mark_seen(N).
        a.pty("s", &[(Bell, Some(2))]);
        let v = seen(&a, "s", shown);
        assert_eq!(v["seenSeq"], shown);
        assert_eq!(v["pending"], json!({"bell":{"seq":shown + 1,"frame":2}}));
        // Two clients in reverse order: the maximum wins, never moves back.
        let v = seen(&a, "s", shown + 1);
        assert_eq!(v["seenSeq"], shown + 1);
        let v = seen(&a, "s", shown);
        assert_eq!(v["seenSeq"], shown + 1);
        // Out of range clamps to alertSeq; repeating is idempotent.
        a.pty("s", &[(State(Working), Some(3)), (State(Done), Some(4))]);
        let v = seen(&a, "s", u64::MAX);
        assert_eq!(v["seenSeq"], v["alertSeq"]);
        let again = seen(&a, "s", u64::MAX);
        assert_eq!(again, v);
        // A later alert after a max-through still becomes pending.
        fake.advance(2000);
        a.pty("s", &[(Bell, Some(5))]);
        assert_eq!(agent(&a, "s")["pending"]["bell"]["seq"], v["alertSeq"].as_u64().unwrap() + 1);
        // Unknown ids answer null without creating a record.
        assert_eq!(ms(&a, "nobody", 3)["items"][0]["agent"], Value::Null);
        assert!(a.snapshot("nobody").is_none());
    }

    #[test]
    fn bell_and_notify_are_limited_per_kind_and_second() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("s", &[(Bell, Some(1)), (Bell, Some(2)), (Notify, Some(3)), (Notify, Some(4)), (Bell, Some(5))]);
        let v = agent(&a, "s");
        assert_eq!(v["alertSeq"], 2);
        assert_eq!(v["pending"]["bell"], json!({"seq":1,"frame":1}));
        assert_eq!(v["pending"]["notify"], json!({"seq":2,"frame":3}));
        fake.advance(999);
        a.pty("s", &[(Bell, Some(6))]);
        assert_eq!(agent(&a, "s")["alertSeq"], 2);
        fake.advance(1);
        a.pty("s", &[(Bell, Some(7)), (Notify, Some(8))]);
        assert_eq!(agent(&a, "s")["alertSeq"], 4);
        // Another session has its own budget.
        a.pty("t", &[(Bell, None)]);
        assert_eq!(agent(&a, "t")["alertSeq"], 1);
    }

    #[test]
    fn ended_only_for_confirmed_final_states_and_working_turn_is_interrupted() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("w", &[(State(Working), Some(1))]);
        fake.advance(4200);
        a.process_ended("w", "exited");
        let v = agent(&a, "w");
        assert_eq!((v["turnInterrupted"].as_bool(), v["lastTurnMs"].as_u64(), v["turnOpen"].as_bool()), (Some(true), Some(4200), Some(false)));
        assert!(v["state"].is_null());
        assert_eq!(v["pending"]["ended"], json!({"seq":1}));
        for status in ["stopped", "failed"] { a.process_ended(status, status); assert!(agent(&a, status)["pending"]["ended"].is_object()); }
        // Uncertain custody: no ended alert, and no record invented for it.
        a.process_ended("u", "needs_attention");
        assert!(a.snapshot("u").is_none());
        a.pty("b", &[(State(Blocked), Some(1))]);
        a.process_ended("b", "needs_attention");
        let v = agent(&a, "b");
        assert!(v["pending"].get("ended").is_none());
        assert_eq!(v["pending"]["needs"]["seq"], 1, "process end never clears an unseen alert");
    }

    #[test]
    fn permission_alert_identity_and_seen_never_resolves_it() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.permission("c", "00000000-0000-4000-8000-000000000001", 3);
        let v = agent(&a, "c");
        assert_eq!(v["pending"]["permission"], json!({"seq":1,"requestId":"00000000-0000-4000-8000-000000000001","generation":3}));
        assert!(v["state"].is_null(), "structured Codex never declares a state");
        let v = seen(&a, "c", 1);
        assert!(v["pending"].get("permission").is_none());
        // A later request of a new generation is a new alert with its identity.
        a.permission("c", "00000000-0000-4000-8000-000000000002", 4);
        assert_eq!(agent(&a, "c")["pending"]["permission"]["generation"], 4);
    }

    #[test]
    fn mark_seen_arguments_are_strict() {
        assert!(seen_items(&json!({"items":[{"id":"a-1","epoch":7,"through":3}]})).is_ok());
        for bad in [json!({}), json!({"items":[]}), json!({"items":"x"}), json!({"items":[{"id":"a"}]}),
            json!({"items":[{"id":"a","through":1}]}), json!({"items":[{"id":"a","epoch":0,"through":1}]}),
            json!({"items":[{"id":"a","epoch":-3,"through":1}]}), json!({"items":[{"id":"a","epoch":"7","through":1}]}),
            json!({"items":[{"id":"a","epoch":1,"through":-1}]}), json!({"items":[{"id":"a","epoch":1,"through":1.5}]}),
            json!({"items":[{"id":"a b","epoch":1,"through":1}]}), json!({"items":[{"id":"a","epoch":1,"through":1,"x":1}]}),
            json!({"items":(0..65).map(|i|json!({"id":format!("s{i}"),"epoch":1,"through":1})).collect::<Vec<_>>()})] {
            assert!(seen_items(&bad).is_err(), "{bad}");
        }
        assert_eq!(seen_items(&json!({"items":[{"id":"a","epoch":u64::MAX,"through":u64::MAX}]})).unwrap()[0].2, u64::MAX);
    }

    #[test]
    fn status_never_presents_a_truncated_list_as_complete() {
        let fake = Fake::new();
        let a = memory(&fake);
        let mut sessions = Vec::new();
        for n in 0..300 {
            let id = format!("s{n}");
            a.pty(&id, &[(Bell, Some(1))]);
            sessions.push(json!({"id":id,"status":"exited"}));
        }
        sessions.push(json!({"id":"quiet","status":"exited"}));
        let mut status = json!({"sessions":sessions});
        a.status_into(&mut status);
        let with: Vec<_> = status["sessions"].as_array().unwrap().iter().filter(|r| r.get("agent").is_some()).collect();
        assert_eq!(with.len(), STATUS_AGENTS);
        assert_eq!(status["agentAttention"]["hasMore"], true);
        assert_eq!(status["agentAttention"]["pendingSessions"], 300);
        assert_eq!(status["agentAttention"]["pendingAlerts"], 300);
        assert_eq!(status["agentAttentionVersion"], 1);
        let size = serde_json::to_vec(&with[0]["agent"]).unwrap().len();
        assert!(size < 400, "agent object is {size} bytes");
    }

    fn profile() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner.sqlite");
        drop(Store::open(&path).unwrap());
        (dir, path)
    }
    fn add_session(path: &Path, id: &str, status: &str) {
        let db = Connection::open(path).unwrap();
        db.execute("INSERT INTO sessions(id,title,kind,status,pid,rows,cols) VALUES(?,?,'fixture',?,NULL,24,80)", params![id, id, status]).unwrap();
    }
    fn open_at(path: &Path, generation: &str, fake: &Fake, sessions: &[(&str, &str)]) -> Arc<Attention> {
        let sessions: Vec<_> = sessions.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        Attention::open(Some(path), generation.into(), &sessions, fake.clock(), Config { flush_delay: Duration::from_millis(20), seen_timeout: Duration::from_millis(400) })
    }

    #[test]
    fn schema_is_tolerated_by_the_profile_validation_and_keeps_its_invariants() {
        let (_dir, path) = profile();
        add_session(&path, "s", "running");
        let others = |path: &Path| -> Vec<(String, String, Option<String>)> {
            Connection::open(path).unwrap().prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name!='agent_attention' ORDER BY type,name").unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let before = others(&path);
        let fake = Fake::new();
        let a = open_at(&path, "g1", &fake, &[("s", "running")]);
        assert!(a.durable());
        a.pty("s", &[(Bell, Some(1))]);
        drop(a);
        assert_eq!(others(&path), before, "no other schema object is created or changed");
        let db = Connection::open(&path).unwrap();
        assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('sessions','events')", [], |r| r.get::<_, i64>(0)).unwrap(), 5);
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='agent_attention'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name LIKE 'storage_%'", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
        assert_eq!(db.query_row("SELECT count(*) FROM pragma_foreign_key_list('agent_attention')", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(db);
        // The main Store (same validate_layout as 1.3.3) still opens the profile.
        Store::open(&path).unwrap();
        // legacy_tasks::init still runs on that path; its tables remain.
        let db = Connection::open(&path).unwrap();
        assert!(db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='task_artifacts')", [], |r| r.get::<_, bool>(0)).unwrap());
    }

    #[test]
    fn reopen_keeps_unseen_interrupts_working_and_drops_orphans() {
        let (_dir, path) = profile();
        for id in ["w", "b", "seen", "gone"] { add_session(&path, id, "running"); }
        let fake = Fake::new();
        let a = open_at(&path, "g1", &fake, &[("w", "running"), ("b", "running"), ("seen", "running"), ("gone", "running")]);
        a.pty("w", &[(State(Done), Some(1)), (State(Working), Some(2))]);
        a.pty("b", &[(State(Blocked), Some(7))]);
        a.pty("seen", &[(Bell, Some(1))]);
        a.pty("gone", &[(Bell, Some(1))]);
        assert_eq!(ms(&a, "seen", 1)["durable"], true);
        a.wait_flushed();
        drop(a);
        Connection::open(&path).unwrap().execute("DELETE FROM sessions WHERE id='gone'", []).unwrap();
        let a = open_at(&path, "g2", &fake, &[("w", "interrupted"), ("b", "needs_attention"), ("seen", "interrupted")]);
        let w = agent(&a, "w");
        assert_eq!((w["turnInterrupted"].as_bool(), w["turnOpen"].as_bool()), (Some(true), Some(false)));
        assert!(w["lastTurnMs"].is_null() && w["state"].is_null(), "no invented duration or stale state");
        let b = agent(&a, "b");
        assert_eq!(b["pending"]["needs"], json!({"seq":1,"frame":null}), "unseen kept; old-generation frame dropped");
        assert_eq!(agent(&a, "seen")["seenSeq"], 1);
        assert!(a.snapshot("gone").is_none());
        drop(a);
        assert!(stored(&Connection::open(&path).unwrap(), "gone").unwrap().is_none());
    }

    #[test]
    fn unexpected_table_definition_keeps_memory_mode_without_rejecting_the_profile() {
        let (_dir, path) = profile();
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE agent_attention(session_id TEXT PRIMARY KEY, other TEXT)").unwrap();
        add_session(&path, "s", "running");
        let fake = Fake::new();
        let a = open_at(&path, "g1", &fake, &[("s", "running")]);
        assert!(!a.durable());
        a.pty("s", &[(Bell, Some(1))]);
        assert_eq!(agent(&a, "s")["alertSeq"], 1);
        assert_eq!(ms(&a, "s", 1)["durable"], false);
        drop(a);
        Store::open(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        let sql: String = db.query_row("SELECT sql FROM sqlite_master WHERE name='agent_attention'", [], |r| r.get(0)).unwrap();
        assert!(sql.contains("other TEXT"), "foreign table left untouched");
        // An extra index on our table is also a different definition.
        let (_dir2, path2) = profile();
        drop(open_at(&path2, "g1", &fake, &[]));
        Connection::open(&path2).unwrap().execute_batch("CREATE INDEX extra ON agent_attention(state)").unwrap();
        assert!(!open_at(&path2, "g2", &fake, &[]).durable());
    }

    #[test]
    fn crash_before_and_after_commit() {
        let (_dir, path) = profile();
        add_session(&path, "s", "running");
        let fake = Fake::new();
        // Alert committed, then crash: it survives.
        let a = open_at(&path, "g1", &fake, &[("s", "running")]);
        a.pty("s", &[(Bell, Some(1))]);
        a.wait_flushed();
        // Alert raised but not yet committed (inside the flush window), crash.
        let slow = Attention::open(Some(&path), "g1b".into(), &[("s".into(), "running".into())], fake.clock(), Config { flush_delay: Duration::from_secs(60), seen_timeout: Duration::from_millis(400) });
        drop(a);
        fake.advance(2000);
        slow.pty("s", &[(Bell, Some(2))]);
        assert_eq!(agent(&slow, "s")["alertSeq"], 2);
        slow.crash();
        drop(slow);
        assert_eq!(stored(&Connection::open(&path).unwrap(), "s").unwrap(), Some((1, 0)), "only the uncommitted alert is lost");
        // Seen confirmed before responding survives an immediate crash.
        let a = open_at(&path, "g2", &fake, &[("s", "interrupted")]);
        assert_eq!(ms(&a, "s", 1)["durable"], true);
        a.crash();
        drop(a);
        assert_eq!(stored(&Connection::open(&path).unwrap(), "s").unwrap(), Some((1, 1)));
        // Seen that cannot commit (database locked) answers durable:false; after
        // a crash the alert is still unseen: the failure direction is re-alerting.
        let a = open_at(&path, "g3", &fake, &[("s", "interrupted")]);
        a.permission("s", "00000000-0000-4000-8000-000000000009", 2);
        a.wait_flushed();
        let blocker = Connection::open(&path).unwrap();
        blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        assert_eq!(ms(&a, "s", 2)["durable"], false);
        a.crash();
        drop(a);
        blocker.execute_batch("ROLLBACK").unwrap();
        assert_eq!(stored(&blocker, "s").unwrap(), Some((2, 1)));
    }

    #[test]
    fn purge_and_compaction_keep_attention_rows() {
        let (_dir, path) = profile();
        let mut store = Store::open(&path).unwrap();
        store.insert_native(&json!({"id":"s","title":"s","kind":"fixture","status":"running","rows":24,"cols":80,"detail":{}})).unwrap();
        store.output("s", "aGVsbG8=").unwrap();
        store.state("s", "exited", json!({})).unwrap();
        let fake = Fake::new();
        let a = open_at(&path, "g1", &fake, &[("s", "exited")]);
        a.pty("s", &[(State(Working), Some(1)), (State(Done), Some(2))]);
        a.process_ended("s", "exited");
        a.wait_flushed();
        store.purge_history(&["s".into()]).unwrap();
        store.compact_final_history(&["s".into()]).unwrap();
        assert_eq!(stored(&store.0, "s").unwrap(), Some((2, 0)));
        drop(a);
        let a = open_at(&path, "g2", &fake, &[("s", "exited")]);
        assert_eq!(agent(&a, "s")["pending"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn many_sessions_never_lose_a_pending_alert() {
        let (_dir, path) = profile();
        let fake = Fake::new();
        let ids: Vec<String> = (0..1300).map(|n| format!("s{n}")).collect();
        { let db = Connection::open(&path).unwrap(); let tx = db.unchecked_transaction().unwrap();
          for id in &ids { tx.execute("INSERT INTO sessions(id,title,kind,status,pid,rows,cols) VALUES(?,?,'fixture','exited',NULL,24,80)", params![id, id]).unwrap(); }
          tx.commit().unwrap(); }
        let sessions: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), "exited")).collect();
        let a = open_at(&path, "g1", &fake, &sessions);
        for (n, id) in ids.iter().enumerate() { fake.advance(1); a.pty(id, &[(Bell, Some(n as u64))]); }
        // The first 700 are seen (idle rows); the last 600 stay pending.
        let seen: Vec<_> = ids[..700].iter().map(|id| (id.clone(), 1u64)).collect();
        for chunk in seen.chunks(64) { assert_eq!(a.mark_seen(&items(&a, chunk))["durable"], true); }
        a.wait_flushed();
        drop(a);
        let a = open_at(&path, "g2", &fake, &sessions);
        let pending = ids.iter().filter(|id| a.snapshot(id).is_some_and(|v| v["pending"]["bell"].is_object())).count();
        assert_eq!(pending, 600);
        let kept_idle = ids[..700].iter().filter(|id| a.snapshot(id).is_some()).count();
        assert_eq!(kept_idle, IDLE_ROWS, "only fully seen final rows are capped, oldest first");
        assert!(a.snapshot(&ids[699]).is_some() && a.snapshot(&ids[0]).is_none());
        let rows: i64 = Connection::open(&path).unwrap().query_row("SELECT count(*) FROM agent_attention", [], |r| r.get(0)).unwrap();
        assert_eq!(rows as usize, 600 + IDLE_ROWS);
    }
    // --- Codex review round 2 reproductions ---
    #[test]
    fn unseen_finished_survives_new_turns_until_seen() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("s", &[(State(Working), Some(1)), (State(Done), Some(2)), (State(Working), Some(3))]);
        assert_eq!(agent(&a, "s")["pending"]["finished"], json!({"seq":1,"frame":2}), "unseen finished must survive working");
        // clear and an alert do not remove it either.
        a.pty("s", &[(State(Blocked), Some(4)), (Clear, Some(5)), (State(Working), Some(6))]);
        assert_eq!(agent(&a, "s")["pending"]["finished"]["seq"], 1);
        // A second end of turn moves the same single pending entry forward.
        a.pty("s", &[(State(Done), Some(7))]);
        let v = agent(&a, "s");
        assert_eq!(v["pending"]["finished"], json!({"seq":3,"frame":7}));
        assert_eq!(v["pending"].as_object().unwrap().len(), 1);
        // Seen through it: gone.
        let v = seen(&a, "s", v["alertSeq"].as_u64().unwrap());
        assert!(v["pending"].get("finished").is_none() && v["finishedUnseen"] == false);
    }

    #[test]
    fn needs_lasts_while_declared_like_the_client_tracker() {
        // ProgramStatusTracker: 'program:needs' exists only while blocked/error.
        let fake = Fake::new();
        let a = memory(&fake);
        // One printf: blocked then working. By design needs disappears: the
        // agent unblocked itself and no longer needs the person.
        a.pty("p", &[(State(Blocked), Some(1)), (State(Working), Some(1))]);
        let v = agent(&a, "p");
        assert_eq!(v["alertSeq"], 1);
        assert!(v["pending"].get("needs").is_none());
        // blocked -> error is one continuous need (no new alert), clear ends it.
        a.pty("q", &[(State(Blocked), Some(1)), (State(Error), Some(2))]);
        assert_eq!(agent(&a, "q")["pending"]["needs"], json!({"seq":1,"frame":1}));
        a.pty("q", &[(Clear, Some(3))]);
        assert!(agent(&a, "q")["pending"].get("needs").is_none());
        // A process end does not clear it.
        a.pty("r", &[(State(Error), Some(1))]);
        a.process_ended("r", "exited");
        assert_eq!(agent(&a, "r")["pending"]["needs"]["seq"], 1);
    }

    #[test]
    fn process_end_seals_the_record_against_late_pty_bytes() {
        let fake = Fake::new();
        let a = memory(&fake);
        a.pty("s", &[(State(Working), Some(1))]);
        a.process_ended("s", "exited");
        a.pty("s", &[(State(Working), None), (Bell, None)]);
        let v = agent(&a, "s");
        assert!(v["state"].is_null() && v["turnOpen"] == false, "late PTY bytes reopened the record: {v}");
    }

    #[test]
    fn reused_id_after_prune_rejects_an_old_epoch() {
        let (_dir, path) = profile();
        let fake = Fake::new();
        let ids: Vec<String> = (0..IDLE_ROWS + 1).map(|n| format!("p{n}")).collect();
        for id in &ids { add_session(&path, id, "exited"); }
        let sessions: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), "exited")).collect();
        let a = open_at(&path, "g1", &fake, &sessions);
        for _ in 0..5 { fake.advance(1000); a.pty(&ids[0], &[(Bell, None)]); }
        for id in &ids[1..] { fake.advance(1); a.pty(id, &[(Bell, None)]); }
        let old_epoch = epoch(&a, &ids[0]);
        for chunk in ids.chunks(64) { let list: Vec<_> = chunk.iter().map(|id| (id.clone(), 100)).collect(); a.mark_seen(&items(&a, &list)); }
        a.wait_flushed(); drop(a);
        let a = open_at(&path, "g2", &fake, &sessions);
        assert!(a.snapshot(&ids[0]).is_none(), "oldest idle row pruned");
        a.permission(&ids[0], "00000000-0000-4000-8000-000000000001", 2);
        // A client that kept the pruned row's epoch and a high through.
        let stale = a.mark_seen(&[(ids[0].clone(), old_epoch, 5)]);
        assert_eq!(stale["items"][0]["rejected"], "epoch");
        assert!(agent(&a, &ids[0])["pending"]["permission"].is_object(), "old through hid a new incarnation's alert");
    }

    #[test]
    fn idle_rows_are_capped_without_reopening() {
        let (_dir, path) = profile();
        let fake = Fake::new();
        let a = open_at(&path, "g1", &fake, &[]);
        // Kept regardless of age: a live session, an uncertain one, a pending one.
        a.pty("live", &[(Bell, None)]); ms(&a, "live", 100);
        a.pty("uncertain", &[(Bell, None)]); a.process_ended("uncertain", "needs_attention"); ms(&a, "uncertain", 100);
        a.pty("pending", &[(Bell, None)]); a.process_ended("pending", "exited");
        for n in 0..IDLE_ROWS + 200 {
            let id = format!("s{n}");
            fake.advance(1);
            a.pty(&id, &[(Bell, None)]);
            a.process_ended(&id, "exited");
            ms(&a, &id, 100);
        }
        let count = lock(&a.inner).records.len();
        assert!(count <= IDLE_ROWS + IDLE_SLACK + 3, "{count} records kept in memory");
        for id in ["live", "uncertain", "pending"] { assert!(a.snapshot(id).is_some(), "{id} dropped"); }
        assert!(a.snapshot("s0").is_none() && a.snapshot(&format!("s{}", IDLE_ROWS + 199)).is_some(), "oldest first");
        a.wait_flushed();
        let rows: i64 = Connection::open(&path).unwrap().query_row("SELECT count(*) FROM agent_attention", [], |r| r.get(0)).unwrap();
        assert_eq!(rows as usize, count, "table pruned in step with memory");
    }

    /// Measured size of what status adds: 8 live sessions (the admission
    /// limit) and 100 closed sessions with pending alerts.
    #[test]
    fn status_size_with_live_and_closed_pending_sessions() {
        let fake = Fake::new();
        let a = memory(&fake);
        let mut sessions = Vec::new();
        for n in 0..8 {
            let id = format!("live-{n}");
            a.pty(&id, &[(State(Working), Some(10)), (Bell, Some(11))]);
            sessions.push(json!({"id":id,"status":"running"}));
        }
        for n in 0..100 {
            let id = format!("closed-{n}");
            a.pty(&id, &[(State(Working), Some(5)), (State(Done), Some(9))]);
            a.process_ended(&id, "exited");
            sessions.push(json!({"id":id,"status":"exited"}));
        }
        // Closed and fully seen: no agent object at all.
        for n in 0..200 { let id = format!("old-{n}"); a.pty(&id, &[(Bell, None)]); a.process_ended(&id, "exited"); ms(&a, &id, 9); sessions.push(json!({"id":id,"status":"exited"})); }
        let base = serde_json::to_vec(&json!({"sessions":sessions.clone()})).unwrap().len();
        let measure = |rows: Vec<Value>| { let mut status = json!({"sessions":rows}); a.status_into(&mut status); status };
        let live_only = measure(sessions[..8].to_vec());
        let all = measure(sessions.clone());
        let live_bytes = serde_json::to_vec(&live_only).unwrap().len() - serde_json::to_vec(&json!({"sessions":sessions[..8].to_vec()})).unwrap().len();
        let all_bytes = serde_json::to_vec(&all).unwrap().len() - base;
        eprintln!("status adds {live_bytes} bytes for 8 live sessions; {all_bytes} bytes for 8 live + 100 closed pending (+200 closed seen)");
        let with = all["sessions"].as_array().unwrap().iter().filter(|r| r.get("agent").is_some()).count();
        assert_eq!(with, 108);
        assert_eq!(all["agentAttention"]["hasMore"], false);
        assert_eq!(all["agentAttention"]["pendingSessions"], 108);
        assert!(all_bytes < 40 * 1024, "{all_bytes}");
    }

}

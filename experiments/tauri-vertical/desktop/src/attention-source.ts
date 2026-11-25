/**
 * Where attention comes from. Two implementations behind one interface:
 *
 * - `WindowAttentionSource` (runner without `agentAttentionVersion`, 1.3.x):
 *   exactly the 1.3 behaviour. xterm parses OSC 7501/BEL/OSC 9/777, the
 *   `ProgramStatusTracker` keeps state, seen is window-local and the first
 *   snapshot is quiet.
 * - `RunnerAttentionSource` (`agentAttentionVersion: 1`): the runner's `agent`
 *   record is the only source of declared state, turn duration and pending
 *   alerts. The client parser does not produce state or alerts (no duplicates).
 *   Seen goes back to the runner with `mark_seen`, under the contract rules
 *   (docs/SESSION_ALERTS.md, «La interfaz con el runner (1.4 E)»).
 *
 * Both keep using `SessionAttention` for lifecycle causes (failed, interrupted,
 * needs_attention) and the Codex permission snapshot (`codex_state`), which the
 * runner does not replace: `pending.permission` only means «arrived, not seen».
 */
import { SessionAttention, type Attention, type AttentionSession, type ExternalCause } from './attention';
export { SessionAttention };
import { parseProgramStatus, ProgramStatusTracker, type ProgramState } from './program-status';
import { agentActivity, endReason, exitFailure, sessionActivity, type ActivityKind } from './session-activity';
import { isLiveStatus } from './session-lifecycle';

export type DisplayState = Exclude<ProgramState, 'clear'>;
export type AgentAlertKind = 'needs' | 'finished' | 'bell' | 'notify' | 'ended' | 'permission';
export const agentAlertKinds: readonly AgentAlertKind[] = ['needs', 'finished', 'bell', 'notify', 'ended', 'permission'];
export type AgentAlert = { seq: number; frame: number | null; requestId?: string; generation?: number };
export type AgentRecord = {
  epoch: number; state: DisplayState | null; changedAt: number | null; stateFrame: number | null;
  turnOpen: boolean; turnStartedAt: number | null; turnEndedAt: number | null; lastTurnMs: number | null; turnInterrupted: boolean;
  alertSeq: number; seenSeq: number; pending: Partial<Record<AgentAlertKind, AgentAlert>>;
};
export type AgentAttentionSummary = { hasMore: boolean; pendingSessions: number; pendingAlerts: number; durable: boolean };
export type Activity = { kind: ActivityKind; label: string; detail: string };
type MarkItem = { id: string; epoch: number; through: number };
type MarkResponse = { items?: { id?: unknown; agent?: unknown; rejected?: unknown }[]; durable?: unknown };

const states: ReadonlySet<string> = new Set(['working', 'blocked', 'error', 'done', 'idle']);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const optional = (v: unknown) => count(v) ? v : null;

/** Strict reading of a runner `agent` object. `undefined` = unusable (ignored), `null` = no record. */
export function parseAgent(value: unknown): AgentRecord | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!count(v.epoch) || v.epoch < 1 || !count(v.alertSeq) || !count(v.seenSeq) || v.seenSeq > v.alertSeq) return undefined;
  if (v.state !== null && v.state !== undefined && !(typeof v.state === 'string' && states.has(v.state))) return undefined;
  const pending: AgentRecord['pending'] = {};
  const raw = v.pending && typeof v.pending === 'object' ? v.pending as Record<string, unknown> : {};
  for (const kind of agentAlertKinds) {
    const entry = raw[kind] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object') continue;
    if (!count(entry.seq) || entry.seq <= (v.seenSeq as number) || entry.seq > (v.alertSeq as number)) continue;
    pending[kind] = { seq: entry.seq, frame: optional(entry.frame),
      ...(typeof entry.requestId === 'string' ? { requestId: entry.requestId } : {}),
      ...(count(entry.generation) ? { generation: entry.generation } : {}) };
  }
  return { epoch: v.epoch, state: (v.state ?? null) as DisplayState | null, changedAt: optional(v.changedAt), stateFrame: optional(v.stateFrame),
    turnOpen: v.turnOpen === true, turnStartedAt: optional(v.turnStartedAt), turnEndedAt: optional(v.turnEndedAt),
    lastTurnMs: optional(v.lastTurnMs), turnInterrupted: v.turnInterrupted === true, alertSeq: v.alertSeq, seenSeq: v.seenSeq, pending };
}

/** A newer snapshot of the same incarnation never lowers sequences or the state clock. */
export function fresher(old: AgentRecord | undefined, next: AgentRecord): boolean {
  if (!old || old.epoch !== next.epoch) return true;
  if (next.alertSeq < old.alertSeq || next.seenSeq < old.seenSeq) return false;
  return (next.changedAt ?? 0) >= (old.changedAt ?? 0);
}

export const agentKey = (id: string, kind: AgentAlertKind, epoch: number, seq: number) => `${id}:agent:${kind}:${epoch}:${seq}`;
function keyParts(key: string): { id: string; epoch: number; seq: number } | null {
  const match = /^(.*):agent:[a-z]+:(\d+):(\d+)$/.exec(key);
  return match ? { id: match[1], epoch: Number(match[2]), seq: Number(match[3]) } : null;
}

/** What main.ts needs from either source; every surface reads the same answers. */
export interface AttentionSource {
  readonly mode: 'runner' | 'window';
  /** Session rows as the attention model sees them. */
  sessions<T extends AttentionSession>(sessions: readonly T[]): T[];
  list(sessions: readonly AttentionSession[]): Attention[];
  activity(session: AttentionSession, alert: Attention | undefined, now?: number): Activity;
  /** Pane heading / Pulso word: blocked, error, working, done (unseen end) or idle. */
  display(id: string): DisplayState | null;
  /** Anchor of the sidebar duration (turn start while working). */
  since(id: string): number | null;
  /** Alerts the runner reports but `status` did not list (`hasMore`). */
  hiddenUnseen(): number;
  /** Native macOS input: alerts that predate this connection are not new. */
  nativeItems(items: readonly Attention[]): Attention[];
  /** Selecting or opening a session. */
  select(id: string, sessions: readonly AttentionSession[]): void;
  /** «Marcar vistos». */
  markAll(sessions: readonly AttentionSession[]): void;
  /** Called by refresh with the sessions in view; may mark consumed frame alerts seen. */
  paint(attended: readonly string[]): void;
  /** xterm OSC 7501 report (window mode only). */
  program(id: string, data: string, attended: boolean): boolean;
  /** xterm BEL/OSC 9/777 (window mode only). */
  signal(id: string): void;
  observeEnd(id: string, previous: string, status: string): void;
  consumeActivity(id: string): boolean;
  forget(id: string): void;
  reset(): void;
}

/** 1.3.x behaviour, unchanged: the parser in xterm and window-local seen. */
export class WindowAttentionSource implements AttentionSource {
  readonly mode = 'window' as const;
  readonly tracker = new ProgramStatusTracker();
  constructor(private readonly base: SessionAttention) {}
  sessions<T extends AttentionSession>(sessions: readonly T[]): T[] {
    return sessions.map(s => ({ ...s, programState: this.tracker.get(s.id), programFinishedUnseen: this.tracker.finishedUnseen(s.id) }));
  }
  list(sessions: readonly AttentionSession[]) { return this.base.list(sessions); }
  activity(session: AttentionSession, alert: Attention | undefined, now = Date.now()) {
    return sessionActivity(session, alert, this.tracker.display(session.id), this.tracker.changedAt(session.id), now);
  }
  display(id: string) { return this.tracker.display(id); }
  since(id: string) { return this.tracker.changedAt(id); }
  hiddenUnseen() { return 0; }
  nativeItems(items: readonly Attention[]) { return [...items]; }
  select(id: string, sessions: readonly AttentionSession[]) {
    this.base.see(this.base.list(sessions).filter(item => item.id === id));
    this.tracker.markSeen(id); this.base.seeProgram(id);
  }
  markAll(sessions: readonly AttentionSession[]) {
    this.base.see(this.base.list(sessions)); for (const s of sessions) this.tracker.markSeen(s.id);
  }
  paint() { /* Window mode marks seen inside list/see. */ }
  program(id: string, data: string, attended: boolean): boolean {
    const state = parseProgramStatus(data); if (state === null) return false;
    const result = this.tracker.set(id, state, attended);
    if (attended) { this.tracker.markSeen(id); this.base.seeProgram(id); }
    return result.changed;
  }
  signal(id: string) { this.base.signal(id, 'bell'); }
  observeEnd(id: string, previous: string, status: string) { this.base.observeEnd(id, previous, status); }
  consumeActivity(id: string) { return this.base.consumeActivity(id); }
  forget(id: string) { this.tracker.clear(id); this.base.clearProgram(id); }
  reset() { this.tracker.reset(); }
}

export type RunnerHooks = {
  request(op: 'mark_seen', args: { items: MarkItem[] }): Promise<unknown>;
  /** Connected, not replaying, the session's stream not replaying (liveReady). */
  canMark(id: string): boolean;
  /** Last terminal_live frame xterm already consumed (write callback), current runner generation; null otherwise. */
  consumedFrame(id: string): number | null;
  isAttended(id: string): boolean;
  changed(): void;
  /** Retry scheduling; tests inject a fake. */
  later?(run: () => void, ms: number): unknown;
  /** Clock for retained native notices; tests inject a fake. */
  now?(): number;
};

/**
 * How long a dropped record keeps offering its new alerts to macOS. Longer
 * than the 1.5 s grouping in NativeAttention plus a status cycle, so a notice
 * queued before the record left the capped list is still found at delivery.
 */
const RETAIN_NATIVE_MS = 5000;

const reasons: Record<AgentAlertKind, (a: AgentRecord) => string> = {
  needs: a => a.state === 'error' ? 'El agente informó un error' : 'El agente solicita atención',
  finished: () => 'El agente terminó su turno',
  bell: () => 'La sesión emitió una alerta',
  notify: () => 'La sesión emitió una alerta',
  ended: () => 'El proceso terminó',
  permission: () => 'Solicitud de permiso sin ver',
};

/** Runner 1.4 E: state, turns and pending alerts come from `agent`. */
export class RunnerAttentionSource implements AttentionSource {
  readonly mode = 'runner' as const;
  private agents = new Map<string, AgentRecord>();
  private painted = new Map<string, AgentRecord>();
  /** Keys this window already marked seen; the runner confirms them later. */
  private optimistic = new Set<string>();
  private wanted = new Map<string, MarkItem>();
  private sent = new Map<string, MarkItem>();
  /** Native notices: per session, alerts at or below this were never new (connection baseline, or what a dropped record already showed). */
  private baseline = new Map<string, { epoch: number; seq: number }>();
  private baselined = false;
  private baselineFirstSight = false;
  /** First status with hasMore: sessions it listed without `agent`; their baseline is fixed when first seen. */
  private unlistedAtConnect = new Set<string>();
  /** Records terminal_live refreshed since the last status (the session is in view). */
  private liveSince = new Set<string>();
  /** New alerts (above the native baseline) of records dropped by omission, offered to macOS for RETAIN_NATIVE_MS. */
  private retained = new Map<string, { keys: string[]; at: number }>();
  /** Sessions whose process end this window observed while attended: their `ended` (no frame) was seen on screen. */
  private endedOnScreen = new Set<string>();
  /** Frameless alerts (structured Codex end of turn) that arrived while their pane was attended. */
  private seenOnScreen = new Set<string>();
  /** Pending sessions `status` did not list, from that same status: a mark_seen answer never changes it (only the next status). */
  private hidden = 0;
  private generation: string | null = null;
  private token = 0;
  private flying = false;
  private retry: unknown;
  summary: AgentAttentionSummary = { hasMore: false, pendingSessions: 0, pendingAlerts: 0, durable: true };
  /** Last `mark_seen` answered `durable:false`: seen holds now, may reappear after a runner crash. */
  volatileSeen = false;

  constructor(private readonly base: SessionAttention, private readonly hooks: RunnerHooks) {}

  /** status: new generation discards cursors; the first one fixes the native baseline before any render. */
  ingestStatus(status: { generation: string; agentAttention?: Partial<AgentAttentionSummary>; sessions: { id: string; agent?: unknown }[] }): boolean {
    if (status.generation !== this.generation) { this.reset(); this.generation = status.generation; }
    const s = status.agentAttention ?? {};
    this.summary = { hasMore: s.hasMore === true, pendingSessions: count(s.pendingSessions) ? s.pendingSessions : 0,
      pendingAlerts: count(s.pendingAlerts) ? s.pendingAlerts : 0, durable: s.durable !== false };
    let changed = false;
    const listed = new Set<string>(), present = new Set<string>();
    for (const session of status.sessions) {
      present.add(session.id);
      if ('agent' in session) { listed.add(session.id); changed = this.ingest(session.id, session.agent) || changed; }
    }
    // Status is the truth each cycle. A record it did not list is dropped:
    // without hasMore the session has nothing pending and is not live; with
    // hasMore it is counted again inside pendingSessions/pendingAlerts
    // (hiddenUnseen). Only a record terminal_live refreshed since the previous
    // status survives (its session is in view, and terminal_live always
    // carries the agent). The dropped record's alertSeq becomes its native
    // baseline, so it is not announced again if it reappears.
    for (const [id, a] of [...this.agents]) {
      if (listed.has(id) || this.liveSince.has(id)) continue;
      this.agents.delete(id); changed = true;
      const base = this.baseline.get(id);
      // Its new alerts may be queued for the macOS grouping right now: keep
      // offering them for a while, so dropping never swallows a notice. The
      // advanced baseline below still keeps a reappearance from repeating it.
      const fresh = this.pending(id, a).filter(([, p]) => !base || base.epoch !== a.epoch || p.seq > base.seq).map(([kind, p]) => agentKey(id, kind, a.epoch, p.seq));
      if (fresh.length) this.retained.set(id, { keys: fresh, at: this.now() });
      if (!base || base.epoch !== a.epoch || base.seq < a.alertSeq) this.baseline.set(id, { epoch: a.epoch, seq: a.alertSeq });
    }
    this.liveSince.clear();
    // Bounded by the sessions status still lists.
    for (const id of [...this.baseline.keys()]) if (!present.has(id)) this.baseline.delete(id);
    if (!this.baselined) {
      this.baselined = true; this.baselineFirstSight = this.summary.hasMore;
      for (const [id, a] of this.agents) this.baseline.set(id, { epoch: a.epoch, seq: a.alertSeq });
      // Existing sessions the capped list omitted: their baseline is unknown
      // until seen. A session id first seen later was born after connecting
      // and keeps no baseline: its alerts are new.
      if (this.summary.hasMore) for (const id of present) if (!listed.has(id)) this.unlistedAtConnect.add(id);
    }
    for (const id of [...this.unlistedAtConnect]) if (!present.has(id)) this.unlistedAtConnect.delete(id);
    for (const id of [...this.endedOnScreen]) if (!present.has(id)) this.endedOnScreen.delete(id);
    // Same snapshot as the totals: pending records kept from this status (listed, or refreshed by terminal_live).
    const listedPending = [...this.agents.values()].filter(a => Object.keys(a.pending).length > 0).length;
    this.hidden = this.summary.hasMore ? Math.max(0, this.summary.pendingSessions - listedPending) : 0;
    return changed;
  }

  /** terminal_live or status `agent`; returns true when what is shown changes. */
  ingest(id: string, raw: unknown, force = false): boolean {
    const next = parseAgent(raw);
    if (next === undefined) return false;
    const old = this.agents.get(id);
    if (next === null) return this.agents.delete(id);
    if (!force && !fresher(old, next)) return false;
    // Structured Codex has no frames: an end of turn that arrives while its pane is attended was seen there.
    const finished = next.pending.finished;
    if (old && finished && finished.frame === null && old.pending.finished?.seq !== finished.seq && this.hooks.isAttended(id) && this.hooks.canMark(id))
      this.seenOnScreen.add(agentKey(id, 'finished', next.epoch, finished.seq));
    this.agents.set(id, next);
    if (this.baselineFirstSight && this.unlistedAtConnect.delete(id) && !this.baseline.has(id)) this.baseline.set(id, { epoch: next.epoch, seq: next.alertSeq });
    return !old || JSON.stringify(old) !== JSON.stringify(next);
  }

  agent(id: string) { return this.painted.get(id) ?? this.agents.get(id); }
  /** Pending alerts minus those this window already marked seen. */
  pending(id: string, a = this.agent(id)): [AgentAlertKind, AgentAlert][] {
    if (!a) return [];
    return agentAlertKinds.flatMap(kind => { const p = a.pending[kind]; return p && !this.optimistic.has(agentKey(id, kind, a.epoch, p.seq)) ? [[kind, p] as [AgentAlertKind, AgentAlert]] : []; });
  }

  sessions<T extends AttentionSession>(sessions: readonly T[]): T[] { return [...sessions]; }
  list(sessions: readonly AttentionSession[]): Attention[] {
    return this.base.list(sessions, { permissionsSeen: true, causes: s => this.causes(s) });
  }
  private causes(s: AttentionSession): ExternalCause[] {
    const a = this.agent(s.id); if (!a) return [];
    const result: ExternalCause[] = [];
    const pending = this.pending(s.id, a);
    if (!pending.some(([kind]) => kind === 'needs') && (a.state === 'blocked' || a.state === 'error'))
      result.push({ key: `${s.id}:program:needs`, reason: reasons.needs(a), unseen: false });
    let alerted = false;
    for (const [kind, p] of pending) {
      const terminal = kind === 'bell' || kind === 'notify';
      const reason = kind === 'permission' && this.base.pendingPermissions(s.id) > 0 ? ''
        : kind === 'permission' && p.generation !== undefined && s.codex && p.generation !== s.codex.generation ? `${reasons.permission(a)} · generación anterior, caducado`
        : kind === 'ended' ? endReason(s)
        : terminal && alerted ? '' : reasons[kind](a);
      if (terminal) alerted = true;
      result.push({ key: agentKey(s.id, kind, a.epoch, p.seq), reason, unseen: true, ...(kind === 'ended' && exitFailure(s).failed ? { urgent: true } : {}) });
    }
    return result;
  }
  activity(session: AttentionSession, alert: Attention | undefined, now = Date.now()) {
    const a = this.agent(session.id);
    return agentActivity(session, alert, a ? { ...a, pending: Object.fromEntries(this.pending(session.id, a)) } : null, now);
  }
  display(id: string): DisplayState | null {
    const a = this.agent(id); if (!a) return null;
    if (a.state === 'blocked' || a.state === 'error' || a.state === 'working') return a.state;
    if (this.pending(id, a).some(([kind]) => kind === 'finished')) return 'done';
    return a.state === null ? null : 'idle';
  }
  since(id: string) { const a = this.agent(id); return !a ? null : a.state === 'working' ? a.turnStartedAt ?? a.changedAt : a.changedAt; }
  hiddenUnseen() { return this.hidden; }
  /** Agent alerts at or below the connection baseline never become a macOS notice. */
  nativeItems(items: readonly Attention[]): Attention[] {
    const fresh = (key: string) => {
      const parts = keyParts(key); if (!parts) return true;
      const base = this.baseline.get(parts.id);
      return !base || base.epoch !== parts.epoch || parts.seq > base.seq;
    };
    const now = this.now();
    for (const [id, r] of [...this.retained]) if (now - r.at > RETAIN_NATIVE_MS) this.retained.delete(id);
    return [...items.map(item => {
      const unseenKeys = (item.unseenKeys ?? []).filter(fresh);
      return { ...item, keys: item.keys.filter(fresh), unseenKeys, unseen: unseenKeys.length > 0 };
    }), ...[...this.retained].map(([id, r]) => ({ id, reason: '', unseen: true, stale: false, keys: r.keys, unseenKeys: r.keys }))];
  }
  private now() { return (this.hooks.now ?? Date.now)(); }
  select(id: string, sessions: readonly AttentionSession[]) {
    this.base.see(this.list(sessions).filter(item => item.id === id));
    this.explicit(id); this.retained.delete(id); void this.flush();
  }
  markAll(sessions: readonly AttentionSession[]) {
    this.base.see(this.list(sessions));
    for (const id of this.painted.keys()) this.explicit(id);
    // What the person just marked seen is no longer news for macOS either.
    this.retained.clear();
    void this.flush();
  }
  /** Explicit action: everything painted for the session, through the painted alertSeq and epoch. */
  private explicit(id: string) {
    const a = this.painted.get(id); const pending = this.pending(id, a);
    if (!a || !pending.length) return;
    this.mark(id, a, a.alertSeq, pending);
  }
  /**
   * Snapshot what the UI paints now, then mark automatically only frame alerts
   * of attended sessions whose frame xterm already consumed, outside replay.
   */
  paint(attended: readonly string[]) {
    this.painted = new Map(this.agents);
    const live = new Set<string>();
    for (const [id, a] of this.painted) for (const kind of agentAlertKinds) { const p = a.pending[kind]; if (p) live.add(agentKey(id, kind, a.epoch, p.seq)); }
    for (const key of this.optimistic) if (!live.has(key)) this.optimistic.delete(key);
    for (const key of this.seenOnScreen) if (!live.has(key)) this.seenOnScreen.delete(key);
    for (const id of attended) {
      const a = this.painted.get(id);
      if (!a || !this.hooks.isAttended(id) || !this.hooks.canMark(id)) continue;
      const consumed = this.hooks.consumedFrame(id);
      const pending = this.pending(id, a);
      // A frame alert once xterm consumed its frame; a process end (no frame) once this window saw it happen here.
      const ready = (kind: AgentAlertKind, p: AgentAlert) => p.frame !== null ? consumed !== null && consumed >= p.frame
        : (kind === 'ended' && this.endedOnScreen.has(id)) || this.seenOnScreen.has(agentKey(id, kind, a.epoch, p.seq));
      const blocked = pending.filter(([kind, p]) => !ready(kind, p)).map(([, p]) => p.seq);
      const through = blocked.length ? Math.min(...blocked) - 1 : a.alertSeq;
      const marked = pending.filter(([kind, p]) => ready(kind, p) && p.seq <= through);
      if (marked.length) this.mark(id, a, through, marked);
    }
    void this.flush();
  }
  /** terminal_live page: its `agent` (if any) plus whether an attended frame alert became consumable. */
  live(id: string, page: { agent?: unknown }, attended: boolean, consumed: number): boolean {
    if ('agent' in page && page.agent !== null) this.liveSince.add(id); else if ('agent' in page) this.liveSince.delete(id);
    const changed = 'agent' in page && this.ingest(id, page.agent);
    return changed || (attended && this.wantsFrame(id, consumed));
  }
  /** True when a painted frame alert of this session became consumable. */
  wantsFrame(id: string, consumed: number): boolean {
    return this.pending(id, this.painted.get(id)).some(([, p]) => p.frame !== null && p.frame <= consumed);
  }
  private mark(id: string, a: AgentRecord, through: number, alerts: [AgentAlertKind, AgentAlert][]) {
    for (const [kind, p] of alerts) this.optimistic.add(agentKey(id, kind, a.epoch, p.seq));
    const sent = this.sent.get(id), wanted = this.wanted.get(id);
    const floor = Math.max(a.seenSeq, sent?.epoch === a.epoch ? sent.through : -1, wanted?.epoch === a.epoch ? wanted.through : -1);
    if (through > floor) this.wanted.set(id, { id, epoch: a.epoch, through });
  }
  /** At most 64 per call, one call at a time, only when there is something new. */
  async flush(): Promise<void> {
    if (this.flying) return;
    const items = [...this.wanted.values()].filter(item => this.hooks.canMark(item.id)).slice(0, 64);
    if (!items.length) return;
    const token = this.token;
    this.flying = true;
    for (const item of items) { this.wanted.delete(item.id); this.sent.set(item.id, item); }
    let response: MarkResponse;
    try { response = await this.hooks.request('mark_seen', { items }) as MarkResponse; }
    catch {
      if (token !== this.token) return;
      // Keep the local seen and try again; never lose the mark.
      for (const item of items) {
        if (this.sent.get(item.id) === item) this.sent.delete(item.id);
        const newer = this.wanted.get(item.id);
        if (!newer || (newer.epoch === item.epoch && newer.through < item.through)) this.wanted.set(item.id, item);
      }
      this.retry ??= (this.hooks.later ?? setTimeout)(() => { this.retry = undefined; void this.flush(); }, 2000);
      return;
    } finally { if (token === this.token) this.flying = false; }
    if (token !== this.token) return;
    this.volatileSeen = response?.durable === false;
    for (const result of Array.isArray(response?.items) ? response.items : []) {
      if (typeof result?.id !== 'string') continue;
      const id = result.id;
      if (result.rejected === 'epoch') {
        // Another incarnation: resynchronise, never retry with the old through.
        this.wanted.delete(id); this.sent.delete(id);
        for (const key of this.optimistic) if (key.startsWith(`${id}:agent:`)) this.optimistic.delete(key);
        // Only a record still shown: status decides which sessions carry one.
        if (result.agent === null) this.agents.delete(id); else if (this.agents.has(id)) this.ingest(id, result.agent, true);
      } else if (result.agent === null) { this.sent.delete(id); this.agents.delete(id); }
      else if (this.agents.has(id)) this.ingest(id, result.agent);
    }
    this.hooks.changed();
    if (this.wanted.size) void this.flush();
  }
  program() { return false; }
  signal() { /* The runner reads BEL/OSC; the client parser stays quiet. */ }
  /** `ended` comes from the runner; this only notes an end that happened in the attended pane (seen there). */
  observeEnd(id: string, previous: string, status: string) {
    if (isLiveStatus(previous) && (status === 'exited' || status === 'stopped' || status === 'failed') && this.hooks.isAttended(id)) this.endedOnScreen.add(id);
  }
  consumeActivity() { return false; }
  forget() { /* Records are the runner's. */ }
  reset() {
    this.token++; this.flying = false;
    this.agents.clear(); this.painted.clear(); this.optimistic.clear(); this.wanted.clear(); this.sent.clear();
    this.baseline.clear(); this.baselined = false; this.baselineFirstSight = false; this.generation = null; this.volatileSeen = false;
    this.unlistedAtConnect.clear(); this.liveSince.clear(); this.retained.clear(); this.endedOnScreen.clear(); this.seenOnScreen.clear(); this.hidden = 0;
  }
}

/** Older runners (no pulsoRevision): a session whose word just became done/idle probably wrote to Pulso. */
export function turnEnded(seen: Map<string, string>, sessions: readonly { id: string }[], source: Pick<AttentionSource, 'display'>): boolean {
  let ended = false;
  const present = new Set<string>();
  for (const s of sessions) {
    present.add(s.id);
    const state = source.display(s.id) ?? '', previous = seen.get(s.id);
    if (previous !== undefined && previous !== state && (state === 'done' || state === 'idle')) ended = true;
    seen.set(s.id, state);
  }
  // Only the sessions still listed: the map never outgrows the session list.
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  return ended;
}

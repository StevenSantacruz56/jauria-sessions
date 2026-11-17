/**
 * Passive OSC 7501 program-status contract.
 *
 * The payload (what xterm hands to an OSC handler, already reassembled across
 * chunks) is a colon-separated list of `key=value` fields. Only `state` is
 * meaningful; every other field (title, msg, app, progress, unknown keys) is
 * ignored without being decoded, displayed or interpreted. Anything ambiguous is
 * rejected (`null`) so a hostile or buggy program can at worst lose its own
 * status update. Nothing here replies to the terminal, touches the DOM, performs
 * I/O, schedules timers or triggers phase actions.
 */
export type ProgramState = 'working' | 'blocked' | 'error' | 'done' | 'idle' | 'clear';

const MAX_PAYLOAD_BYTES = 1024;
const STATES: ReadonlySet<string> = new Set<ProgramState>(['working', 'blocked', 'error', 'done', 'idle', 'clear']);

function isProgramState(value: unknown): value is ProgramState {
  return typeof value === 'string' && STATES.has(value);
}

/**
 * Single pass: rejects C0, DEL, C1 and unpaired surrogates, and counts UTF-8
 * bytes without allocating (no TextEncoder needed). Returns false when the
 * payload is unsafe or exceeds the byte budget.
 */
function isSafeAndWithinBudget(data: string): boolean {
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = data.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      bytes += 4; i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > MAX_PAYLOAD_BYTES) return false;
  }
  return true;
}

/** Parses a root-level OSC 7501 payload. Returns the declared state or null. */
export function parseProgramStatus(data: string): ProgramState | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  // Cheap precheck: UTF-8 bytes are never fewer than UTF-16 code units.
  if (data.length > MAX_PAYLOAD_BYTES) return null;
  if (!isSafeAndWithinBudget(data)) return null;

  let state: ProgramState | null = null;
  for (const field of data.split(':')) {
    const eq = field.indexOf('=');
    if (eq <= 0) return null; // empty field, missing '=', or empty key
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1); // further '=' belong to the value
    if (key.includes('?') || value === '?') return null; // queries never get answered
    const lower = key.toLowerCase();
    if (lower === 'id') return null; // child/targeted records are out of scope
    if (lower === 'state') {
      if (key !== 'state') return null; // no case-folded lookalikes
      if (state !== null) return null; // duplicate state, even if identical
      if (!isProgramState(value)) return null; // closed set, exact lowercase
      state = value;
    }
    // Any other key: ignored without inspecting its value.
  }
  return state;
}

type TrackedProgramState = Exclude<ProgramState, 'clear'>;
type Tracked = { state: TrackedProgramState; since: number; finishedUnseen: boolean };

export function programStateLabel(state: TrackedProgramState): string {
  return ({ working: 'Trabajando', blocked: 'Solicita atención', error: 'Error informado', done: 'Turno finalizado', idle: 'En espera' })[state];
}

function isAlert(state: TrackedProgramState | null): boolean {
  return state === 'blocked' || state === 'error';
}

/**
 * Remembers the last live state per session id and decides whether a
 * transition deserves attention. Bounded: once `limit` ids are tracked, the
 * least recently reported id is evicted. Rate limiting, replay suppression and
 * UI coalescing belong to the caller.
 */
export class ProgramStatusTracker {
  readonly #limit: number;
  readonly #states = new Map<string, Tracked>();

  constructor(limit = 512) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('ProgramStatusTracker limit must be a positive integer');
    this.#limit = limit;
  }

  set(id: string, state: ProgramState, attended: boolean): { changed: boolean; attention: boolean } {
    if (typeof id !== 'string' || !isProgramState(state)) return { changed: false, attention: false };
    if (state === 'clear') return { changed: this.#states.delete(id), attention: false };

    const previous = this.#states.get(id);
    // Delete + insert keeps Map order equal to "least recently reported first".
    this.#states.delete(id);
    const changed = previous?.state !== state;
    const finishesWork = (state === 'done' || state === 'idle') &&
      (previous?.state === 'working' || previous?.state === 'blocked' || previous?.state === 'error');
    const finishedUnseen = state === 'working' || isAlert(state) ? false
      : (finishesWork && !attended) || (previous?.finishedUnseen ?? false);
    this.#states.set(id, { state, since: changed ? Date.now() : previous.since, finishedUnseen });
    if (this.#states.size > this.#limit) {
      const oldest = this.#states.keys().next().value;
      if (oldest !== undefined) this.#states.delete(oldest);
    }
    if (!changed) return { changed: false, attention: false };

    const entersAlert = isAlert(state) && !isAlert(previous?.state ?? null);
    return { changed: true, attention: !attended && (entersAlert || finishesWork) };
  }

  get(id: string): Exclude<ProgramState, 'clear'> | null {
    return this.#states.get(id)?.state ?? null;
  }

  /** The last reported word is distinct from a finished turn the person has not seen. */
  display(id: string): TrackedProgramState | null {
    const tracked = this.#states.get(id);
    if (!tracked) return null;
    return tracked.state === 'blocked' || tracked.state === 'error' ? tracked.state
      : tracked.finishedUnseen ? 'done' : tracked.state === 'done' ? 'idle' : tracked.state;
  }

  changedAt(id: string): number | null { return this.#states.get(id)?.since ?? null; }
  finishedUnseen(id: string): boolean { return this.#states.get(id)?.finishedUnseen ?? false; }

  markSeen(id: string): boolean {
    const tracked = this.#states.get(id);
    if (!tracked?.finishedUnseen) return false;
    tracked.finishedUnseen = false;
    return true;
  }

  clear(id: string): boolean {
    return this.#states.delete(id);
  }

  reset(): void {
    this.#states.clear();
  }
}

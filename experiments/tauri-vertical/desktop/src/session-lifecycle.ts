/**
 * Session lifecycle (1.4.0): four categories over the runner states. Pure.
 *
 * - Abierta: `starting`, `running`. The agent is alive and takes input.
 * - Sin confirmar: `needs_attention` and any unknown state. Jauría cannot
 *   assert the process ended; it keeps its slot until the person frees it.
 * - Interrumpida: `interrupted`, `failed`, `released`. It ended without being
 *   asked to; it can be continued or started again.
 * - Terminada: `exited`, `stopped`, and the interrupted ones the person
 *   dismissed or continued (a view mark kept per profile, never a runner state).
 *
 * The runner gives no session dates: «most recent first» reverses creation
 * order (`status` lists sessions oldest first).
 */
export type LifecycleCategory = 'open' | 'unconfirmed' | 'interrupted' | 'ended';

/** Runner states without a process or slot. The only list of them in the client. */
export const CLOSED: readonly string[] = Object.freeze(['exited', 'stopped', 'failed', 'interrupted', 'released']);
const INTERRUPTED: readonly string[] = ['interrupted', 'failed', 'released'];

export function isClosed(status: string): boolean { return CLOSED.includes(status); }
export function isLiveStatus(status: string): boolean { return status === 'starting' || status === 'running'; }

/** `retired`: an interrupted session the person dismissed or continued (it is Terminada). */
export function category(status: string, retired = false): LifecycleCategory {
  if (isLiveStatus(status)) return 'open';
  if (status === 'exited' || status === 'stopped') return 'ended';
  if (INTERRUPTED.includes(status)) return retired ? 'ended' : 'interrupted';
  return 'unconfirmed';
}

export function categoryLabel(value: LifecycleCategory): string {
  switch (value) {
    case 'open': return 'Abierta';
    case 'unconfirmed': return 'Sin confirmar — ocupa plaza';
    case 'interrupted': return 'Interrumpida';
    case 'ended': return 'Terminada';
  }
}

/** One word per runner state, from its category; «Abriendo» while it starts. */
export function lifecycleLabel(status: string): string {
  return status === 'starting' ? 'Abriendo' : categoryLabel(category(status));
}

/**
 * A `failed` session that did run: the runner recorded its exit, or that the last output was lost.
 * A failure before the process existed records neither.
 */
export type EndDetail = { [key: string]: unknown } | null | undefined;
export function ranBeforeFailing(detail: EndDetail): boolean {
  return !!detail && (typeof detail.exitCode === 'number' || detail.outputNotRetained === true);
}

/** Why an Interrumpida ended, in the person's words. Empty for the other categories. */
export function interruptionDetail(status: string, detail?: EndDetail): string {
  switch (status) {
    case 'interrupted': return 'El runner se reinició y el proceso ya no existe';
    case 'failed': return !ranBeforeFailing(detail) ? 'No llegó a iniciarse'
      : detail!.outputNotRetained === true ? 'Se detuvo y su último tramo de salida no quedó guardado' : 'Terminó con un error';
    case 'released': return 'Se liberó su plaza sin confirmar el cierre';
    default: return '';
  }
}

/**
 * Runner states that are an incident for the alerts (local lifecycle causes):
 * custody in doubt, an end nobody asked for, and anything unknown. `released`
 * follows the person's own Liberar plaza, so it is not an alert.
 */
export function lifecycleIncident(status: string): boolean {
  return status === 'needs_attention' || status === 'failed' || status === 'interrupted' || (!isLiveStatus(status) && !isClosed(status));
}

export type ContinuationSession = {
  kind: string;
  status: string;
  transport?: string;
  pid?: number;
  detail?: EndDetail;
  codex?: { nativeThreadId: string | null } | null;
};
/** What the recovery offers: continue the same conversation, or a new session in the same folder. */
export type Continuation = { action: 'continue' | 'restart'; note: string };

/**
 * The one recovery rule (plan C.4). `binding` is what `native_binding` said
 * about a Claude session: 'present' (a registered identity), 'none', or
 * 'unknown' while it is not read yet (the action is offered and the runner
 * has the last word).
 */
export function continuation(session: ContinuationSession, caps: { nativeResume: boolean }, binding: 'unknown' | 'none' | 'present' = 'unknown'): Continuation {
  // The card already says why it ended; the note only says what the action does.
  const fresh: Continuation = { action: 'restart', note: 'Se abre una sesión nueva en la misma carpeta.' };
  // A failure after running is recovered like any other interruption of that kind of session.
  const unstarted = session.status === 'failed' && !ranBeforeFailing(session.detail);
  if (session.transport === 'app-server') {
    if (session.status === 'failed') return fresh;
    return session.codex?.nativeThreadId
      ? { action: 'continue', note: 'Continúa el mismo hilo de Codex.' }
      : { action: 'restart', note: 'Esta conversación de Codex no tiene turnos registrados para continuar.' };
  }
  if (session.kind === 'claude') {
    if (unstarted || session.pid === undefined || session.pid === null) return fresh;
    if (!caps.nativeResume) return { action: 'restart', note: 'Este runner no permite continuar conversaciones; reinícialo para hacerlo.' };
    if (binding === 'none') return { action: 'restart', note: 'No se registró la identidad de la conversación.' };
    return { action: 'continue', note: 'Abre una sesión nueva con la misma conversación de Claude Code.' };
  }
  if (unstarted) return fresh;
  if (session.kind === 'codex') return { action: 'restart', note: 'Codex en terminal no permite continuar la conversación.' };
  return { action: 'restart', note: 'Una terminal no guarda la conversación; se abre otra en la misma carpeta.' };
}

/** Most recent first. The runner lists oldest first and gives no dates (1.3.x and 1.4.0). */
export function orderRecent<T>(sessions: readonly T[]): T[] { return [...sessions].reverse(); }

/*
 * «Descartar» and «continuada»: view metadata per profile, like the agent
 * grouping. `continuedAs` is the session that continued it (null for a plain
 * dismissal). Bounded to the most recent `dismissedLimit` entries; a read
 * validates every field and drops what it does not understand.
 */
export const dismissedLimit = 2000;
export type DismissedSessions = Map<string, string | null>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);

export function dismissedKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria:session-dismissed:${profile}` : null;
}
export function readDismissed(storage: Pick<Storage, 'getItem'>, profile: string | null): DismissedSessions {
  const result: DismissedSessions = new Map();
  const key = dismissedKey(profile); if (!key) return result;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (value?.schemaVersion !== 1 || !Array.isArray(value.sessions)) return result;
    for (const entry of value.sessions.slice(-dismissedLimit)) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validId(entry[0]) || (entry[1] !== null && !validId(entry[1]))) continue;
      result.delete(entry[0]); result.set(entry[0], entry[1]);
    }
  } catch { /* Optional view metadata: an unreadable value is an empty one. */ }
  return result;
}
export function saveDismissed(storage: Pick<Storage, 'setItem'>, profile: string | null, sessions: DismissedSessions): void {
  const key = dismissedKey(profile); if (!key) return;
  const entries = [...sessions].filter(([id, next]) => validId(id) && (next === null || validId(next))).slice(-dismissedLimit);
  try { storage.setItem(key, JSON.stringify({ schemaVersion: 1, sessions: entries })); } catch { /* Optional view metadata. */ }
}
/**
 * Interrupted/failed incidents the person already saw in an earlier opening
 * (id → status), per profile. `null` when nothing was ever stored (first run
 * of 1.4.0 on this profile): the caller keeps the quiet first snapshot then.
 */
export type SeenIncidents = Map<string, string>;
const incidentStatus = (value: unknown) => value === 'interrupted' || value === 'failed';
export function incidentsKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria:incidents-seen:${profile}` : null;
}
export function readSeenIncidents(storage: Pick<Storage, 'getItem'>, profile: string | null): SeenIncidents | null {
  const key = incidentsKey(profile); if (!key) return null;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (value?.schemaVersion !== 1 || !Array.isArray(value.incidents)) return null;
    const result: SeenIncidents = new Map();
    for (const entry of value.incidents.slice(-dismissedLimit)) {
      if (Array.isArray(entry) && entry.length === 2 && validId(entry[0]) && incidentStatus(entry[1])) { result.delete(entry[0]); result.set(entry[0], entry[1]); }
    }
    return result;
  } catch { return null; }
}
export function saveSeenIncidents(storage: Pick<Storage, 'setItem'>, profile: string | null, incidents: SeenIncidents): void {
  const key = incidentsKey(profile); if (!key) return;
  const entries = [...incidents].filter(([id, status]) => validId(id) && incidentStatus(status)).slice(-dismissedLimit);
  try { storage.setItem(key, JSON.stringify({ schemaVersion: 1, incidents: entries })); } catch { /* Optional: it holds for this window. */ }
}

/** Adds (or moves to the newest end) one entry, keeping the bound. */
export function withDismissed(sessions: DismissedSessions, id: string, continuedAs: string | null = null): DismissedSessions {
  const next = new Map(sessions); next.delete(id); next.set(id, continuedAs);
  while (next.size > dismissedLimit) next.delete(next.keys().next().value!);
  return next;
}

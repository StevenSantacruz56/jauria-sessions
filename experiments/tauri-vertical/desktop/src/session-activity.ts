import type { Attention } from './attention';
import { programStateLabel, type ProgramState } from './program-status';
import { statusLabel, type WorkspaceSession } from './workspace';

/**
 * A confirmed process end that failed: status `failed`, or `exited` with a
 * non-zero exit code (`detail.exitCode`, or `detail.waitResult.exitCode` when
 * the runner wrapped the wait result; the only datum read). A stop (`stopped`,
 * Terminar or runner shutdown) is never a failure.
 */
export function exitFailure(session: { status: string; detail?: { [key: string]: unknown } | null }): { failed: boolean; code: number | null } {
  const detail = session.detail ?? {};
  const raw = 'exitCode' in detail ? detail.exitCode : (detail.waitResult as { exitCode?: unknown } | undefined)?.exitCode;
  const code = Number.isSafeInteger(raw) ? raw as number : null;
  return { failed: session.status === 'failed' || (session.status === 'exited' && code !== null && code !== 0), code };
}
/** «Proceso falló (código N)» or «Proceso terminó»: the end alert's text. */
export function endReason(session: { status: string; detail?: { [key: string]: unknown } | null }): string {
  const end = exitFailure(session);
  return end.failed ? (end.code !== null && end.code !== 0 ? `Proceso falló (código ${end.code})` : 'Proceso falló') : 'El proceso terminó';
}

export type ActivityKind ='needs' | 'notice' | 'finished' | 'working' | 'idle' | 'unreported';
export const activitySections: readonly { kind: ActivityKind; label: string }[] = [
  { kind: 'needs', label: 'Necesitan tu acción' },
  { kind: 'notice', label: 'Avisos' },
  { kind: 'finished', label: 'Terminaron' },
  { kind: 'working', label: 'En curso' },
  { kind: 'idle', label: 'En espera' },
  { kind: 'unreported', label: 'Sin estado del agente' },
];

/** Program progress is explicit. A live PTY alone is never called working. */
export function sessionActivity(
  session: WorkspaceSession,
  alert: Attention | undefined,
  program: ProgramState | null,
  changedAt: number | null = null,
  now = Date.now(),
): { kind: ActivityKind; label: string; detail: string } {
  const keys = alert?.keys ?? [];
  const has = (part: string) => keys.some(key => key.includes(part));
  if (program === 'blocked' || program === 'error') return {
    kind: 'needs', label: program === 'error' ? 'Error del agente' : 'Solicita atención',
    detail: alert?.reason ?? programStateLabel(program),
  };
  if (has(':permissions:')) return { kind: 'needs', label: 'Permiso pendiente', detail: alert!.reason };
  if (has(':state:')) return { kind: 'needs', label: statusLabel(session.status), detail: alert!.reason };
  if (has(':unconfirmed')) return { kind: 'needs', label: 'Sin confirmar', detail: alert!.reason };
  if (has(':signal:bell') || has(':signal:notification')) return { kind: 'notice', label: 'Aviso del terminal', detail: alert!.reason };
  if (has(':signal:ended')) return exitFailure(session).failed ? { kind: 'needs', label: 'Proceso falló', detail: endReason(session) } : { kind: 'finished', label: 'Proceso terminó', detail: alert!.reason };
  if (has(':program:done')) return { kind: 'finished', label: 'Turno terminado', detail: alert!.reason };
  if (program === 'working') {
    const elapsed = changedAt === null ? '' : Math.max(0, Math.floor((now - changedAt) / 60000));
    const duration = elapsed === '' ? '' : elapsed < 1 ? '<1 min' : elapsed < 60 ? `${elapsed} min` : `${Math.floor(elapsed / 60)} h`;
    return { kind: 'working', label: 'Trabajando', detail: duration ? `Desde hace ${duration}` : 'Estado informado por el agente' };
  }
  if (program === 'idle' || program === 'done') return { kind: 'idle', label: 'En espera', detail: 'Sin trabajo declarado' };
  return { kind: 'unreported', label: statusLabel(session.status), detail: 'Progreso no informado' };
}

/** Duration of a closed turn, from the runner's monotonic `lastTurnMs`. */
export function turnDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms % 3_600_000 / 60_000)} min`;
}
type AgentPending = Partial<Record<'needs' | 'finished' | 'bell' | 'notify' | 'ended' | 'permission', unknown>>;
export type AgentActivityInput = { state: Exclude<ProgramState, 'clear'> | null; changedAt: number | null; turnStartedAt: number | null; lastTurnMs: number | null; turnInterrupted: boolean; pending: AgentPending };

/**
 * Runner 1.4 E: the same priority as `sessionActivity`, from the runner record.
 * Working only with state=working; an unseen finish outranks a new turn.
 */
export function agentActivity(session: WorkspaceSession, alert: Attention | undefined, agent: AgentActivityInput | null, now = Date.now()): { kind: ActivityKind; label: string; detail: string } {
  const keys = alert?.keys ?? [];
  const has = (part: string) => keys.some(key => key.includes(part));
  const state = agent?.state ?? null, pending = agent?.pending ?? {};
  const since = (at: number | null) => { if (at === null) return ''; const m = Math.max(0, Math.floor((now - at) / 60000)); return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`; };
  const working = () => { const d = since(agent?.turnStartedAt ?? agent?.changedAt ?? null); return d ? `Desde hace ${d}` : 'Estado informado por el agente'; };
  if (state === 'blocked' || state === 'error' || pending.needs) return { kind: 'needs', label: state === 'error' ? 'Error del agente' : 'Solicita atención', detail: alert?.reason ?? programStateLabel(state ?? 'blocked') };
  if (has(':permissions:')) return { kind: 'needs', label: 'Permiso pendiente', detail: alert!.reason };
  if (has(':state:')) return { kind: 'needs', label: statusLabel(session.status), detail: alert!.reason };
  if (has(':unconfirmed')) return { kind: 'needs', label: 'Sin confirmar', detail: alert!.reason };
  // A failed end needs the person; a clean one is «terminó».
  if (pending.ended && exitFailure(session).failed) return { kind: 'needs', label: 'Proceso falló', detail: endReason(session) };
  if (pending.bell || pending.notify) return { kind: 'notice', label: 'Aviso del terminal', detail: alert?.reason ?? '' };
  if (pending.permission) return { kind: 'notice', label: 'Permiso sin ver', detail: alert?.reason ?? '' };
  if (pending.ended) return { kind: 'finished', label: 'Proceso terminó', detail: alert?.reason ?? '' };
  if (pending.finished) return { kind: 'finished', label: 'Turno terminado', detail: state === 'working' ? `Trabaja de nuevo · ${working().toLowerCase()}` : alert?.reason ?? '' };
  if (state === 'working') return { kind: 'working', label: 'Trabajando', detail: working() };
  if (state === 'idle' || state === 'done') return { kind: 'idle', label: 'En espera',
    detail: agent?.lastTurnMs != null ? `Último turno: ${turnDuration(agent.lastTurnMs)}` : agent?.turnInterrupted ? 'Último turno interrumpido' : 'Sin trabajo declarado' };
  return { kind: 'unreported', label: statusLabel(session.status), detail: 'Progreso no informado' };
}

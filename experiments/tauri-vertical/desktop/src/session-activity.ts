import type { Attention } from './attention';
import { programStateLabel, type ProgramState } from './program-status';
import { statusLabel, type WorkspaceSession } from './workspace';

export type ActivityKind = 'needs' | 'notice' | 'finished' | 'working' | 'idle' | 'unreported';
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
  if (has(':signal:ended')) return { kind: 'finished', label: 'Proceso terminó', detail: alert!.reason };
  if (has(':program:done')) return { kind: 'finished', label: 'Turno terminado', detail: alert!.reason };
  if (program === 'working') {
    const elapsed = changedAt === null ? '' : Math.max(0, Math.floor((now - changedAt) / 60000));
    const duration = elapsed === '' ? '' : elapsed < 1 ? '<1 min' : elapsed < 60 ? `${elapsed} min` : `${Math.floor(elapsed / 60)} h`;
    return { kind: 'working', label: 'Trabajando', detail: duration ? `Desde hace ${duration}` : 'Estado informado por el agente' };
  }
  if (program === 'idle' || program === 'done') return { kind: 'idle', label: 'En espera', detail: 'Sin trabajo declarado' };
  return { kind: 'unreported', label: statusLabel(session.status), detail: 'Progreso no informado' };
}

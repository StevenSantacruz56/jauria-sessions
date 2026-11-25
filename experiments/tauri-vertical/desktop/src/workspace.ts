import { category, lifecycleIncident, lifecycleLabel } from './session-lifecycle';

export type WorkspaceSession = {
  id: string;
  title: string;
  kind: string;
  status: string;
  cwd: string | null;
  workspace?: string | null;
  pid?: number;
  rows: number;
  cols: number;
};

export type SessionFilter = 'all' | 'open' | 'activity' | 'attention' | 'closed';

/** The word for a runner state: its lifecycle category (session-lifecycle.ts), «Abriendo» while it starts. */
export function statusLabel(status: string): string { return lifecycleLabel(status); }

export function providerLabel(kind: string): string {
  switch (kind) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude Code';
    case 'fixture': return 'Fixture';
    case 'shell': return 'Shell';
    case 'terminal': return 'Terminal';
    case 'codex_probe': return 'Prueba Codex';
    case 'claude_probe': return 'Prueba Claude Code';
    default: return kind;
  }
}

export function isProviderSession(session: WorkspaceSession): boolean {
  return session.kind === 'codex' || session.kind === 'claude';
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().normalize('NFC');
}

/**
 * Session lifecycle only: an open PTY says nothing about turn or task progress.
 * open = Abiertas (with Sin confirmar); activity adds the Interrumpidas;
 * attention = lifecycle incidents; closed = Terminadas. `retired`: an
 * interrupted session the person dismissed or continued (it is Terminada).
 */
export function matchesSession(session: WorkspaceSession, filter: SessionFilter, query: string, retired = false): boolean {
  const value = category(session.status, retired);
  const allowed = filter === 'all' ? true
    : filter === 'open' ? value === 'open' || value === 'unconfirmed'
    : filter === 'activity' ? value !== 'ended'
    : filter === 'attention' ? lifecycleIncident(session.status) && value !== 'ended'
    : value === 'ended';
  if (!allowed) return false;
  const needle = normalize(query.trim());
  return [session.title, providerLabel(session.kind), session.cwd, session.workspace]
    .some(value => value !== null && value !== undefined && normalize(value).includes(needle));
}

export function groupSessions(sessions: readonly WorkspaceSession[]): Array<{
  key: string;
  path: string | null;
  name: string;
  sessions: WorkspaceSession[];
}> {
  const groups = new Map<string, {
    key: string;
    path: string | null;
    name: string;
    sessions: WorkspaceSession[];
  }>();
  for (const session of sessions) {
    const diagnostic = ['fixture', 'shell', 'codex_probe', 'claude_probe'].includes(session.kind);
    const path = diagnostic ? null : session.workspace || session.cwd || null;
    const key = diagnostic ? '__diagnostics__' : path || '__unassigned__';
    let group = groups.get(key);
    if (!group) {
      // Strip trailing slashes for the display name only; preserve path identity.
      const name = diagnostic ? 'Pruebas locales'
        : path ? path.replace(/\/+$/, '').split('/').pop() || '/' : 'Sin carpeta';
      group = { key, path, name, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}

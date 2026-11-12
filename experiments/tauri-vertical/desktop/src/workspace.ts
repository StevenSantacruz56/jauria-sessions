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

export type SessionFilter = 'all' | 'open' | 'attention' | 'closed';

export function statusLabel(status: string): string {
  switch (status) {
    case 'starting': return 'Abriendo';
    case 'running': return 'Abierta';
    case 'exited': return 'Cerrada';
    case 'stopped': return 'Detenida';
    case 'released': return 'Carpeta liberada';
    case 'needs_attention': return 'Requiere atención';
    case 'failed': return 'Falló';
    case 'interrupted': return 'Interrumpida';
    default: return 'Estado desconocido';
  }
}

export function providerLabel(kind: string): string {
  switch (kind) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude Code';
    case 'fixture': return 'Fixture';
    case 'shell': return 'Shell';
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

/** Session lifecycle only: an open PTY says nothing about turn or task progress. */
export function matchesSession(session: WorkspaceSession, filter: SessionFilter, query: string): boolean {
  const statuses: Record<Exclude<SessionFilter, 'all'>, readonly string[]> = {
    open: ['starting', 'running'],
    attention: ['needs_attention', 'failed', 'interrupted'],
    closed: ['exited', 'stopped', 'released'],
  };
  const known = Object.values(statuses).some(list => list.includes(session.status));
  if (filter !== 'all' && !statuses[filter].includes(session.status) && !(filter === 'attention' && !known)) return false;
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

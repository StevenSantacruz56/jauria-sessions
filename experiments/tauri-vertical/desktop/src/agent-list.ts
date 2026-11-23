import { activitySections, type ActivityKind } from './session-activity';

/** Sidebar agent list: presentation only. No terminal text is inspected here. */
export type AgentGrouping = 'project' | 'state';
export type AgentIndicatorShape = 'spinner' | 'halo' | 'check' | 'dash' | 'ring';
export type AgentIndicatorTone = 'working' | 'attention' | 'ready' | 'paused' | 'unreported';
export type AgentIndicator = { shape: AgentIndicatorShape; tone: AgentIndicatorTone };

/**
 * Each state has its own shape, so meaning never depends on colour alone:
 * spinning ring (working), dot with halo (needs you), check (finished),
 * dash (waiting), empty ring (no report). Only an explicit `working` report
 * spins; an open process without a declared state never does
 * (docs/SESSION_ALERTS.md).
 */
export function agentIndicator(kind: ActivityKind): AgentIndicator {
  switch (kind) {
    case 'working': return { shape: 'spinner', tone: 'working' };
    case 'finished': return { shape: 'check', tone: 'ready' };
    case 'needs': case 'notice': return { shape: 'halo', tone: 'attention' };
    case 'idle': return { shape: 'dash', tone: 'paused' };
    default: return { shape: 'ring', tone: 'unreported' };
  }
}

const checkSvg = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3 5 8.7l4.5-5.2"/></svg>';
/**
 * Paints an `.agent-indicator` (sidebar rows, top-bar tabs, pane heading,
 * alerts and status bar share it). Writes only what changed; the label is the
 * title so the state is also available as text.
 */
export function paintAgentIndicator(el: HTMLElement, kind: ActivityKind, label: string): void {
  const shape = agentIndicator(kind);
  if (el.dataset.state !== kind) el.dataset.state = kind;
  if (el.dataset.tone !== shape.tone) el.dataset.tone = shape.tone;
  if (el.dataset.shape !== shape.shape) {
    el.dataset.shape = shape.shape;
    // The check is drawn; the other shapes are CSS. All share one 12px box.
    el.innerHTML = shape.shape === 'check' ? checkSvg : '';
  }
  if (el.title !== label) el.title = label;
}

/** Provider badge: C (Claude Code), X (Codex) or $ (terminal and anything else). */
export function providerBadge(kind: string): { provider: 'claude' | 'codex' | 'terminal'; letter: string } {
  return kind === 'claude' ? { provider: 'claude', letter: 'C' } : kind === 'codex' ? { provider: 'codex', letter: 'X' } : { provider: 'terminal', letter: '$' };
}

/** Same order as docs/SESSION_ALERTS.md: action, notices, unseen finish, working, waiting, no report. */
export function agentRank(kind: ActivityKind): number {
  return ({ needs: 0, notice: 1, finished: 2, working: 3, idle: 4, unreported: 5 } as const)[kind] ?? 5;
}

export function sortAgents<T extends { id: string }>(sessions: readonly T[], kindOf: (id: string) => ActivityKind): T[] {
  return sessions.map((session, index) => ({ session, index, rank: agentRank(kindOf(session.id)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.session);
}

export type AgentProject = { id: string; title: string; mainSessionId: string | null };
/** `via` (runner 1.4 sidebar_summary): the pair comes from a project link or a link to one of its phases. */
export type AgentProjectLink = { projectId?: string | null; sessionId: string; via?: 'project' | 'item' };

/**
 * Session → Pulso project. A project's main session wins over a link (to the
 * project or to one of its phases); projects keep their listed order and the first match is kept, so a session appears once.
 */
export function projectSessionIndex(projects: readonly AgentProject[], links: readonly AgentProjectLink[]): Map<string, string> {
  const index = new Map<string, string>();
  const known = new Set(projects.map(project => project.id));
  for (const project of projects) if (project.mainSessionId && !index.has(project.mainSessionId)) index.set(project.mainSessionId, project.id);
  const order = new Map(projects.map((project, position) => [project.id, position]));
  const sorted = links.filter(link => link.projectId && known.has(link.projectId))
    .map((link, position) => ({ link, position }))
    .sort((a, b) => order.get(a.link.projectId!)! - order.get(b.link.projectId!)! || a.position - b.position);
  for (const { link } of sorted) if (!index.has(link.sessionId)) index.set(link.sessionId, link.projectId!);
  return index;
}

export type AgentGroup<T> = { key: string; name: string; kind: ActivityKind | null; projectId: string | null; sessions: T[] };
export const unassignedProjectLabel = 'Sin proyecto';

export function groupAgents<T extends { id: string }>(
  sessions: readonly T[],
  grouping: AgentGrouping,
  kindOf: (id: string) => ActivityKind,
  projects: readonly AgentProject[] = [],
  index: ReadonlyMap<string, string> = new Map(),
): AgentGroup<T>[] {
  if (grouping === 'state') {
    return activitySections.map(section => ({ key: `state:${section.kind}`, name: section.label, kind: section.kind, projectId: null,
      sessions: sessions.filter(session => kindOf(session.id) === section.kind) })).filter(group => group.sessions.length);
  }
  const groups: AgentGroup<T>[] = projects.map(project => ({ key: `project:${project.id}`, name: project.title, kind: null, projectId: project.id,
    sessions: sortAgents(sessions.filter(session => index.get(session.id) === project.id), kindOf) }));
  const assigned = new Set(projects.map(project => project.id));
  groups.push({ key: 'project:none', name: unassignedProjectLabel, kind: null, projectId: null,
    sessions: sortAgents(sessions.filter(session => !assigned.has(index.get(session.id) ?? '')), kindOf) });
  return groups.filter(group => group.sessions.length);
}

/** Coarse, minute-based duration so periodic status refreshes do not churn the row. */
export function compactDuration(since: number | null, now = Date.now()): string {
  if (since === null || !Number.isFinite(since)) return '';
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  return minutes < 1 ? '<1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** View metadata only, namespaced by profile like the Pulso board preference. */
export function agentGroupingKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria:agent-grouping:${profile}` : null;
}
export function readAgentGrouping(storage: Pick<Storage, 'getItem'>, profile: string | null): AgentGrouping {
  const key = agentGroupingKey(profile); if (!key) return 'project';
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value?.schemaVersion === 1 && (value.grouping === 'project' || value.grouping === 'state') ? value.grouping : 'project';
  } catch { return 'project'; }
}
export function saveAgentGrouping(storage: Pick<Storage, 'setItem'>, profile: string | null, grouping: AgentGrouping): void {
  const key = agentGroupingKey(profile); if (!key || (grouping !== 'project' && grouping !== 'state')) return;
  try { storage.setItem(key, JSON.stringify({ schemaVersion: 1, grouping })); } catch { /* Optional view preference. */ }
}

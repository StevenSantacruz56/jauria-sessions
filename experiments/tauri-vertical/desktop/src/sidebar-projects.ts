import type { AgentProject, AgentProjectLink } from './agent-list';

/**
 * Read-only Pulso summary for the sidebar, never polled on a timer.
 *
 * Runner 1.4 (`pulsoSummaryVersion: 1`): one `sidebar_summary` read with
 * `ifRevision`, so an unchanged Pulso costs one tiny reply. It carries the
 * project and phase links (`via`), so sessions linked to a phase group under
 * their project. main.ts triggers it when `status.pulsoRevision` changes.
 *
 * Older runners: the existing UI reads (`projects`, then `links` and two
 * `items` counts per project, two counts for Pendientes) on connect, window
 * focus, leaving the board, Pulso changes, session-set changes and when an
 * agent reports done/idle. `links` has no cursor and returns at most 100
 * links with `hasMore`; that truncation is recorded, not paginated.
 */
export const SIDEBAR_PROJECT_LIMIT = 20;
export type SidebarProject = AgentProject & { done: number | null; total: number | null; linksTruncated: boolean };
export type SidebarSnapshot = { projects: SidebarProject[]; links: AgentProjectLink[]; pendingOpen: number | null; hasMore: boolean; revision: number | null; linksTruncated: boolean };
type Request = (op: string, args: Record<string, unknown>) => Promise<any>;

export const emptySidebarSnapshot = (): SidebarSnapshot => ({ projects: [], links: [], pendingOpen: null, hasMore: false, revision: null, linksTruncated: false });
const isConflict = (error: unknown) => /revision conflict|stale snapshot/i.test(error instanceof Error ? error.message : String(error));

export class SidebarProjects {
  #request: Request;
  #snapshot = emptySidebarSnapshot();
  #generation = 0;
  #running: Promise<boolean> | null = null;
  #again = false;
  #summary: () => boolean;
  /** `summary` says, at each read, whether the runner offers `sidebar_summary`. */
  constructor(request: Request, summary: () => boolean = () => false) { this.#request = request; this.#summary = summary; }
  get snapshot(): SidebarSnapshot { return this.#snapshot; }
  /** Profile or runner changed: forget data, fence in-flight reads and, if one is running, read again for the new connection. */
  reset(): void { this.#generation++; this.#snapshot = emptySidebarSnapshot(); this.#again = this.#running !== null; }
  /**
   * Single flight. A trigger during a read schedules exactly one more read;
   * a failed read never drops that pending reread. Resolves true if the
   * snapshot changed; rejects only when the last read failed.
   */
  load(): Promise<boolean> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      let changed = false; let failure: { error: unknown } | null = null;
      try {
        do {
          this.#again = false;
          try { changed = await this.#readOnce() || changed; failure = null; }
          catch (error) { failure = { error }; }
        } while (this.#again);
      } finally { this.#running = null; }
      if (failure) throw failure.error;
      return changed;
    })();
    return this.#running;
  }
  /** A snapshot conflict means Pulso changed mid-read: retry once with the new revision. */
  async #readOnce(): Promise<boolean> {
    try { return await this.#read(); }
    catch (error) { if (isConflict(error)) return this.#read(); throw error; }
  }
  async #read(): Promise<boolean> {
    return this.#summary() ? this.#readSummary() : this.#readEach();
  }
  async #readSummary(): Promise<boolean> {
    const generation = this.#generation;
    const known = this.#snapshot.revision;
    const data = await this.#request('sidebar_summary', known === null ? {} : { ifRevision: known });
    if (generation !== this.#generation || data?.unchanged === true) return false;
    if (typeof data?.revision !== 'number' || !Array.isArray(data.projects) || !Array.isArray(data.links)) throw new Error('Resumen de Pulso no válido');
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const rows = data.projects.filter((p: any) => typeof p?.id === 'string' && typeof p?.title === 'string') as { id: string; title: string; mainSessionId?: unknown; done?: unknown; total?: unknown }[];
    const shown = rows.slice(0, SIDEBAR_PROJECT_LIMIT);
    const ids = new Set(shown.map(p => p.id));
    const pairs = data.links.filter((l: any) => typeof l?.sessionId === 'string' && typeof l?.projectId === 'string') as { sessionId: string; projectId: string; via?: unknown }[];
    // Pairs come ordered by project id: a cut can only hide pairs of the last
    // returned project and of the ones that sort after it.
    const truncated = data.linksTruncated === true;
    const last = pairs.at(-1)?.projectId;
    this.#snapshot = {
      projects: shown.map(p => ({ id: p.id, title: p.title, mainSessionId: typeof p.mainSessionId === 'string' ? p.mainSessionId : null,
        total: count(p.total), done: count(p.done), linksTruncated: truncated && (last === undefined || p.id >= last) })),
      links: pairs.filter(l => ids.has(l.projectId)).map(l => ({ projectId: l.projectId, sessionId: l.sessionId, ...(l.via === 'project' || l.via === 'item' ? { via: l.via } : {}) })),
      pendingOpen: count(data.pendingOpen), hasMore: data.hasMore === true || rows.length > SIDEBAR_PROJECT_LIMIT, revision: data.revision, linksTruncated: truncated,
    };
    return true;
  }
  async #readEach(): Promise<boolean> {
    const generation = this.#generation;
    const page = await this.#request('projects', { archived: false, limit: SIDEBAR_PROJECT_LIMIT });
    if (generation !== this.#generation) return false;
    const revision = typeof page?.revision === 'number' ? page.revision : null;
    if (revision !== null && revision === this.#snapshot.revision) return false;
    const rows: { id: string; title: string; mainSessionId?: string | null }[] = Array.isArray(page?.projects) ? page.projects.slice(0, SIDEBAR_PROJECT_LIMIT) : [];
    const snapshotArgs = revision === null ? {} : { expectedSnapshotRevision: revision };
    const count = async (projectId: string | null, status?: string) => {
      const data = await this.#request('items', { projectId, archived: false, limit: 1, ...(status ? { status } : {}), ...snapshotArgs });
      return typeof data?.totalCount === 'number' ? data.totalCount : null;
    };
    const projects: SidebarProject[] = [];
    const links: AgentProjectLink[] = [];
    // One project at a time: at most three small reads in flight.
    for (const row of rows) {
      const [linked, total, done] = await Promise.all([this.#request('links', { projectId: row.id }), count(row.id), count(row.id, 'done')]);
      if (generation !== this.#generation) return false;
      projects.push({ id: row.id, title: row.title, mainSessionId: row.mainSessionId ?? null, total, done, linksTruncated: !!linked?.hasMore });
      for (const link of Array.isArray(linked?.links) ? linked.links : []) if (typeof link?.sessionId === 'string') links.push({ projectId: row.id, sessionId: link.sessionId });
    }
    const [pendingTotal, pendingDone] = await Promise.all([count(null), count(null, 'done')]);
    if (generation !== this.#generation) return false;
    const total = typeof page?.totalCount === 'number' ? page.totalCount : rows.length;
    this.#snapshot = { projects, links, pendingOpen: pendingTotal === null || pendingDone === null ? null : Math.max(0, pendingTotal - pendingDone),
      hasMore: !!page?.hasMore || total > rows.length, revision, linksTruncated: projects.some(p => p.linksTruncated) };
    return true;
  }
}

export function projectProgressLabel(project: Pick<SidebarProject, 'done' | 'total'>): string {
  return project.total === null || project.done === null ? '' : `${project.done}/${project.total}`;
}

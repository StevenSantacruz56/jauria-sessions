import type { AgentProject, AgentProjectLink } from './agent-list';

/**
 * Read-only Pulso summary for the sidebar. It uses only existing UI reads
 * (`projects`, `links`, `items` counts) and never polls on a timer: callers
 * trigger it on connect, on window focus, on returning from the board, on
 * Pulso changes, on session-set changes and when an agent reports done/idle,
 * so planning stays out of the terminal loop.
 *
 * Cost is bounded: the first SIDEBAR_PROJECT_LIMIT projects, three small reads
 * each. The runner's `links` read has no cursor and returns at most 100 links
 * with `hasMore`; the summary records that truncation instead of paginating.
 * A single runner operation for this summary (and a Pulso revision in the
 * runner status, so agents' MCP edits are seen without a trigger) is planned
 * for delivery E.
 */
export const SIDEBAR_PROJECT_LIMIT = 20;
export type SidebarProject = AgentProject & { done: number | null; total: number | null; linksTruncated: boolean };
export type SidebarSnapshot = { projects: SidebarProject[]; links: AgentProjectLink[]; pendingOpen: number | null; hasMore: boolean; revision: number | null };
type Request = (op: string, args: Record<string, unknown>) => Promise<any>;

export const emptySidebarSnapshot = (): SidebarSnapshot => ({ projects: [], links: [], pendingOpen: null, hasMore: false, revision: null });
const isConflict = (error: unknown) => /revision conflict|stale snapshot/i.test(error instanceof Error ? error.message : String(error));

export class SidebarProjects {
  #request: Request;
  #snapshot = emptySidebarSnapshot();
  #generation = 0;
  #running: Promise<boolean> | null = null;
  #again = false;
  constructor(request: Request) { this.#request = request; }
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
      hasMore: !!page?.hasMore || total > rows.length, revision };
    return true;
  }
}

export function projectProgressLabel(project: Pick<SidebarProject, 'done' | 'total'>): string {
  return project.total === null || project.done === null ? '' : `${project.done}/${project.total}`;
}

import type { AgentProject, AgentProjectLink } from './agent-list';

/**
 * Read-only Pulso summary for the sidebar. It uses only existing UI reads
 * (`projects`, `links`, `items` counts) and never polls on a timer: callers
 * trigger it on connect, on returning from the board, on Pulso changes and on
 * session-set changes, so planning stays out of the terminal loop.
 */
export type SidebarProject = AgentProject & { done: number | null; total: number | null };
export type SidebarSnapshot = { projects: SidebarProject[]; links: AgentProjectLink[]; pendingOpen: number | null; hasMore: boolean; revision: number | null };
type Request = (op: string, args: Record<string, unknown>) => Promise<any>;

export const emptySidebarSnapshot = (): SidebarSnapshot => ({ projects: [], links: [], pendingOpen: null, hasMore: false, revision: null });

export class SidebarProjects {
  #request: Request;
  #snapshot = emptySidebarSnapshot();
  #generation = 0;
  #running: Promise<boolean> | null = null;
  #again = false;
  constructor(request: Request) { this.#request = request; }
  get snapshot(): SidebarSnapshot { return this.#snapshot; }
  /** Profile or runner changed: forget data and fence in-flight reads. */
  reset(): void { this.#generation++; this.#snapshot = emptySidebarSnapshot(); this.#again = false; }
  /** Single flight; a trigger during a read schedules exactly one more read. Resolves true if the snapshot changed. */
  load(): Promise<boolean> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      let changed = false;
      try {
        do { this.#again = false; changed = await this.#read() || changed; } while (this.#again);
      } finally { this.#running = null; }
      return changed;
    })();
    return this.#running;
  }
  async #read(): Promise<boolean> {
    const generation = this.#generation;
    const page = await this.#request('projects', { archived: false, limit: 50 });
    if (generation !== this.#generation) return false;
    const revision = typeof page?.revision === 'number' ? page.revision : null;
    if (revision !== null && revision === this.#snapshot.revision) return false;
    if (revision !== null && this.#snapshot.revision !== null && revision < this.#snapshot.revision) return false;
    const rows: { id: string; title: string; mainSessionId?: string | null }[] = Array.isArray(page?.projects) ? page.projects : [];
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
      projects.push({ id: row.id, title: row.title, mainSessionId: row.mainSessionId ?? null, total, done });
      for (const link of Array.isArray(linked?.links) ? linked.links : []) if (typeof link?.sessionId === 'string') links.push({ projectId: row.id, sessionId: link.sessionId });
    }
    const [pendingTotal, pendingDone] = await Promise.all([count(null), count(null, 'done')]);
    if (generation !== this.#generation) return false;
    this.#snapshot = { projects, links, pendingOpen: pendingTotal === null || pendingDone === null ? null : Math.max(0, pendingTotal - pendingDone), hasMore: !!page?.hasMore, revision };
    return true;
  }
}

export function projectProgressLabel(project: Pick<SidebarProject, 'done' | 'total'>): string {
  return project.total === null || project.done === null ? '' : `${project.done}/${project.total}`;
}

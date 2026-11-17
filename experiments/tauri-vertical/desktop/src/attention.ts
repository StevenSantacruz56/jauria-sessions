import { matchesSession, statusLabel, type WorkspaceSession } from './workspace';
import type { ProgramState } from './program-status';
type Session = WorkspaceSession & { transport?: string; codex?: { generation: number }; programState?: ProgramState | null; programFinishedUnseen?: boolean };
type Observation = { generation: number; count: number; keys: string[]; stale: boolean };
export type Attention = { id: string; reason: string; unseen: boolean; stale: boolean; keys: string[] };

/** Window-local observations. Acknowledgement never changes custody or permissions. */
export class SessionAttention {
  private permissions = new Map<string, Observation>();
  private signals = new Map<string, Set<string>>();
  private seen = new Set<string>();
  private initialized = new Set<string>();
  private permissionBaseline = new Map<string, number>();
  private ended = new Set<string>();

  consumeActivity(id: string): boolean { return this.signals.delete(id); }
  clearProgram(id:string):boolean {const values=this.signals.get(id);const changed=values?.delete('program')??false;if(values&&!values.size)this.signals.delete(id);return changed;}
  signal(id: string, kind: 'output' | 'bell' | 'notification' | 'ended' | 'program') {
    // A PTY emits spinner redraws, cursor moves and progress while working.
    // Raw output is not evidence that a person needs to attend the session.
    if (kind === 'output') return;
    const values = this.signals.get(id) ?? new Set<string>();
    values.add(kind); this.signals.set(id, values);
  }
  invalidate() { for (const p of this.permissions.values()) p.stale = true; }
  list(sessions: readonly Session[]): Attention[] {
    const next = new Set<string>();
    const result: Attention[] = [];
    const ids = new Set(sessions.map(s => s.id));
    for (const id of this.permissions.keys()) if (!ids.has(id)) this.permissions.delete(id);
    for (const s of sessions) {
      const reasons: string[] = [], keys: string[] = [];
      const add = (key: string, reason: string) => { keys.push(`${s.id}:${key}`); reasons.push(reason); };
      if (matchesSession(s, 'attention', '')) add(`state:${s.status}`, s.status === 'needs_attention' ? 'Estado de sesión incierto · revisar custodia o recuperación' : statusLabel(s.status));
      const p = s.transport === 'app-server' ? this.permissions.get(s.id) : undefined;
      const stale = !!p && (p.stale || p.generation !== s.codex?.generation);
      if (stale && !p?.count) add('unconfirmed', 'Estado de permisos sin confirmar');
      if (p?.count) add(`permissions:${p.generation}:${p.count}:${JSON.stringify(p.keys)}`, `${p.count} ${p.count === 1 ? 'permiso pendiente' : 'permisos pendientes'}${p.generation !== s.codex?.generation ? ' · generación anterior, caducado' : stale ? ' · sin confirmar' : ''}`);
      if (s.programState === 'blocked' || s.programState === 'error') add('program:needs', s.programState === 'error' ? 'El agente informó un error' : 'El agente solicita atención');
      if (s.programFinishedUnseen) add('program:done', 'El agente terminó su turno');
      for (const kind of this.signals.get(s.id) ?? []) add(`signal:${kind}`, kind === 'ended' ? 'El proceso terminó' : 'La sesión emitió una alerta');
      for (const key of keys) next.add(key);
      // Initial lifecycle snapshot is quiet, but remains available in the list.
      if (!this.initialized.has(s.id)) { for (const key of keys) this.seen.add(key); this.initialized.add(s.id); }
      if (keys.length) result.push({ id: s.id, reason: reasons.join(' · '), unseen: keys.some(k => !this.seen.has(k)), stale, keys });
    }
    for (const key of this.seen) if (!next.has(key)) this.seen.delete(key);
    return result;
  }
  see(items: readonly Attention[]) {
    for (const item of items) {
      for (const key of item.keys) this.seen.add(key);
      // Activity is consumed by viewing; lifecycle and permission causes stay listed.
      this.signals.delete(item.id);
    }
  }
  seeProgram(id: string) { this.seen.add(`${id}:program:needs`); }
  observeEnd(id: string, previous: string, status: string) {
    if (['running', 'starting'].includes(previous) && ['exited', 'stopped', 'failed'].includes(status) && !this.ended.has(id)) {
      this.ended.add(id); this.signal(id, 'ended');
    }
  }
  async poll(sessions: readonly Session[], rpc: (op: string, args: { id: string }) => Promise<unknown>, current: () => boolean): Promise<void> {
    const queue = sessions.filter(s => s.transport === 'app-server' &&
      (!['exited', 'stopped', 'released'].includes(s.status) || (this.permissions.get(s.id)?.count ?? 0) > 0));
    let index = 0;
    const worker = async () => { while (index < queue.length && current()) {
      const s = queue[index++];
      try {
        const v = await rpc('codex_state', { id: s.id }) as { sessionId?: string; generation?: number; pendingRequestCount?: number; hasMoreRequests?: boolean; requests?: { id: string; generation: number; status: string }[] };
        if (!v || v.sessionId !== s.id || !Number.isSafeInteger(v.generation) || v.generation !== s.codex?.generation || !Array.isArray(v.requests) || !v.requests.every(r => r && typeof r.id === 'string' && Number.isSafeInteger(r.generation) && typeof r.status === 'string')) throw new Error('Invalid attention snapshot');
        const pending = v.requests.filter(r => r.status === 'pending');
        const count = v.pendingRequestCount ?? (v.hasMoreRequests ? NaN : pending.length);
        if (!Number.isSafeInteger(count) || count < pending.length || count < 0) throw new Error('Invalid pending count');
        if (!current()) return;
        const first = this.permissionBaseline.get(s.id) !== v.generation;
        const p = { generation: v.generation!, count, keys: pending.map(r => `${r.generation}:${r.id}`).sort(), stale: false };
        this.permissions.set(s.id, p); this.permissionBaseline.set(s.id, v.generation!);
        if (first && count) this.seen.add(`${s.id}:permissions:${p.generation}:${count}:${JSON.stringify(p.keys)}`);
      } catch { if (current()) { const p = this.permissions.get(s.id); if (p) p.stale = true; else this.permissions.set(s.id, { generation: s.codex?.generation ?? 0, count: 0, keys: [], stale: true }); } }
    } };
    await Promise.all([worker(), worker()]);
  }
}

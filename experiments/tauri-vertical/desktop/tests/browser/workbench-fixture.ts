/** Shared synthetic Tauri boundary for the 1.4.0 sidebar, settings and floating
 * control suites. Real shell, CSS and xterm; no runner, provider or profile.
 * Counts every `resize` RPC, records `set_settings` and the native commands
 * (diagnostic, restart) so tests can assert what reached the boundary. */
import type { Page } from 'playwright';

export type WorkbenchOptions = {
  open?: number;
  closed?: number;
  projects?: number;
  runnerVersion?: string | null;
  settingsVersion?: 1 | 2 | null;
  restartConfirms?: boolean;
  kinds?: string[];
};

export async function installWorkbench(page: Page, options: WorkbenchOptions = {}) {
  await page.addInitScript(options => {
    const w = window as any;
    const kinds = options.kinds ?? ['claude', 'codex', 'terminal'];
    const sessions: any[] = [];
    for (let i = 0; i < (options.open ?? 2); i++) sessions.push({ id: `open-${i}`, title: `Sesión abierta ${i + 1}`, kind: kinds[i % kinds.length], cwd: `/synthetic/open-${i}`, status: 'running', rows: 24, cols: 80 });
    for (let i = 0; i < (options.closed ?? 1); i++) sessions.push({ id: `closed-${i}`, title: `Historial ${i + 1}`, kind: kinds[i % kinds.length], cwd: `/synthetic/closed-${i}`, status: 'exited', rows: 24, cols: 80 });
    const projects = Array.from({ length: options.projects ?? 3 }, (_, i) => ({ id: `p${i}`, title: `Proyecto sintético ${i + 1}`, mainSessionId: null, done: i % 3, total: 4 }));
    const events: any[] = []; const resizes: any[] = []; const inputs: any[] = []; const calls: any[] = []; const native: any[] = [];
    let settings: any = { schemaVersion: 2, maxConcurrentSessions: 8, maxSupportedSessions: 8, pulsoAutoAccess: true };
    if (options.settingsVersion === 1) settings = { schemaVersion: 1, maxConcurrentSessions: 8, maxSupportedSessions: 8 };
    const out = (sessionId: string, data: string) => events.push({ seq: events.length + 1, sessionId, kind: 'output', data: btoa(unescape(encodeURIComponent(data))) });
    const status = () => structuredClone({ pid: 77, generation: 'workbench', ...(options.runnerVersion === null ? {} : { runnerVersion: options.runnerVersion ?? '1.4.0' }),
      pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true, pulsoSummaryVersion: 1, pulsoRevisionVersion: 1, pulsoRevision: 1,
      normalTerminalVersion: 1, sessionRenameVersion: 1, telemetryVersion: 1, codexVersion: 1, terminalSessionVersion: 1, claudeNativeConfigVersion: 1, terminalStreamVersion: undefined, nativePermissionsVersion: 1,
      ...(options.settingsVersion === null ? {} : { settingsVersion: options.settingsVersion ?? 2, settings }), sessions, lastSeq: events.length });
    let failNextStart = false; let stopMode: 'stopped' | 'needs_attention' | 'hang' | 'reject' = 'stopped';
    w.workbench = { out, resizes, inputs, calls, native, sessions, get settings() { return settings; },
      setStatus(id: string, value: string) { sessions.find(s => s.id === id).status = value; }, failStart() { failNextStart = true; }, stopMode(mode: typeof stopMode) { stopMode = mode; } };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') { native.push(cmd); return { dataDir: '/synthetic-profile', socket: '/synthetic.sock', status: status(), smoke: false }; }
      if (cmd === 'probe_tools') return [{ tool: 'claude', available: true, version: '2.1.325 (Claude Code)', path: '/synthetic/bin/claude' }, { tool: 'codex', available: false }];
      if (cmd === 'home_directory') return '/synthetic-home';
      if (cmd.startsWith('plugin:')) return cmd === 'plugin:event|listen' ? 1 : cmd === 'plugin:notification|is_permission_granted' ? false : undefined;
      if (cmd === 'record_ui_evidence') return;
      if (cmd === 'preview_diagnostic') { native.push(cmd); return { previewId: 'preview-1', content: '{"product":"Jauria","sessions":{"open":2}}' }; }
      if (cmd === 'export_diagnostic') { native.push([cmd, a.previewId]); return true; }
      if (cmd === 'restart_runner') { native.push(cmd); return !!options.restartConfirms; }
      if (cmd === 'confirm_history') { native.push([cmd, a.op]); return { ok: false, error: 'Cancelado' }; }
      if (cmd === 'pulso_request') {
        calls.push(a.op);
        if (a.op === 'sidebar_summary') return { ok: true, result: a.args.ifRevision === 1 ? { revision: 1, unchanged: true } : { revision: 1, projects: structuredClone(projects), hasMore: false, pendingOpen: 2, links: [], linksTruncated: false } };
        if (a.op === 'revision') return { ok: true, result: { revision: 1 } };
        if (a.op === 'projects') return { ok: true, result: { projects: projects.map(p => ({ id: p.id, title: p.title, plan: '', mainSessionId: null, revision: 1, archived: false, createdAt: 1, updatedAt: 1 })), revision: 1, totalCount: projects.length, hasMore: false } };
        if (a.op === 'policies') return { ok: true, result: { policies: [] } };
        if (a.op === 'board') return { ok: true, result: { revision: 1, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => [s, { items: [], totalCount: 0, hasMore: false }])) } };
        if (a.op === 'items') return { ok: true, result: { items: [], revision: 1, totalCount: 0, hasMore: false } };
        return { ok: false, error: 'unexpected' };
      }
      if (cmd === 'runner_request') {
        calls.push(a.op);
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'telemetry') return { ok: true, result: {} };
        if (a.op === 'events') return { ok: true, result: { events: events.filter(e => e.seq > a.args.after).slice(0, a.args.limit ?? 64), lastSeq: events.length, hasMore: false } };
        if (a.op === 'get_settings') return { ok: true, result: structuredClone(settings) };
        if (a.op === 'set_settings') { native.push(['set_settings', structuredClone(a.args)]); settings = { ...settings, ...a.args }; return { ok: true, result: structuredClone(settings) }; }
        if (a.op === 'resize') { resizes.push(structuredClone(a.args)); const s = sessions.find(s => s.id === a.args.id); if (s) { s.cols = a.args.cols; s.rows = a.args.rows; } return { ok: true, result: { cols: a.args.cols, rows: a.args.rows } }; }
        if (a.op === 'input') { inputs.push(structuredClone(a.args)); return { ok: true, result: {} }; }
        if (a.op === 'native_binding') return { ok: true, result: { binding: null } };
        if (a.op === 'interrupt') return { ok: true, result: {} };
        if (a.op === 'stop') {
          native.push(['stop', a.args.id]);
          if (stopMode === 'hang') return new Promise(() => {});
          if (stopMode === 'reject') return { ok: false, error: 'El runner rechazó la parada sintética.' };
          const s = sessions.find(s => s.id === a.args.id); s.status = stopMode; return { ok: true, result: structuredClone(s) };
        }
        if (a.op === 'start') {
          if (failNextStart) { failNextStart = false; return { ok: false, error: 'No se pudo abrir la carpeta sintética.' }; }
          const s = { id: a.args.id, title: a.args.title, kind: a.args.kind, cwd: a.args.cwd ?? null, status: 'starting', rows: a.args.rows, cols: a.args.cols };
          sessions.push(s); return { ok: true, result: structuredClone(s) };
        }
      }
      throw new Error(`Unexpected synthetic RPC ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  }, options);
}

export async function workbenchReady(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
  await page.waitForTimeout(500);
}
export const resizeCount = (page: Page) => page.evaluate(() => (window as any).workbench.resizes.length as number);
export const rect = (page: Page, selector: string) => page.evaluate(selector => {
  const node = document.querySelector(selector); if (!node) return null;
  const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}, selector);
/** Every element matched is inside the viewport and not covered at its centre. */
export const visibleAt = (page: Page, selector: string) => page.evaluate(selector => {
  const node = document.querySelector<HTMLElement>(selector); if (!node) return 'missing';
  const r = node.getBoundingClientRect(); if (!r.width || !r.height) return 'empty';
  if (r.top < 0 || r.bottom > innerHeight + 0.5 || r.left < 0 || r.right > innerWidth + 0.5) return 'outside the window';
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return hit === node || node.contains(hit) ? 'ok' : `covered by ${(hit as HTMLElement | null)?.className || hit?.tagName}`;
}, selector);

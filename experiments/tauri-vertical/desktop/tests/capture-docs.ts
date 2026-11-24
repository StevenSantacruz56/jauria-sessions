/** Documentation screenshots of Jauría 1.4.0, regenerated with one command.
 * Real shell, CSS and xterm in Chrome; synthetic Tauri boundary and synthetic
 * data only (no runner, providers, profile, real names or real paths).
 * Not part of the test globs. From experiments/tauri-vertical/desktop:
 *
 *   node tests/capture-docs.ts                       # writes ../../../docs/screenshots/*-1.4.0*.png
 *   CAPTURE_DOCS_DIR=/abs/dir node tests/capture-docs.ts   # elsewhere (review before replacing)
 *
 * Same names and sizes as the published images (1220×800, Pulso 1280×820,
 * scale 1). Each image waits for its content, so none shows a loading state.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';

const dir = process.env.CAPTURE_DOCS_DIR ?? fileURLToPath(new URL('../../../../docs/screenshots/', import.meta.url));
const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

async function install(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const HOME = '/Users/tu-usuario';
    const sessions: any[] = [
      { id: 'main', title: 'Planificar la entrega 1.4', kind: 'claude', cwd: HOME, status: 'running', rows: 24, cols: 80 },
      { id: 'precios', title: 'Revisar la tabla de precios', kind: 'codex', cwd: `${HOME}/proyectos/precios`, status: 'running', rows: 24, cols: 80 },
      { id: 'tokens', title: 'Migrar tokens de color', kind: 'codex', cwd: `${HOME}/proyectos/tokens`, status: 'running', rows: 24, cols: 80 },
      { id: 'shell', title: 'Terminal', kind: 'terminal', cwd: HOME, status: 'running', rows: 24, cols: 80 },
      { id: 'anterior', title: 'Borrador del plan', kind: 'claude', cwd: HOME, status: 'exited', rows: 24, cols: 80 },
    ];
    const events: any[] = []; let focused = true; let revision = 7;
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    const out = (sessionId: string, data: string) => events.push({ seq: events.length + 1, sessionId, kind: 'output', data: btoa(unescape(encodeURIComponent(data))) });
    const day = (d: string) => Date.parse(`${d}T10:00:00Z`);
    const projects: any[] = [
      { id: 'plan', title: 'Integrar Pulso en Jauría', plan: 'Objetivo: un tablero local de fases ligado a las sesiones.\n1. Definir el alcance\n2. Integrar el tablero\n3. Validar con sesiones reales', mainSessionId: 'main', revision: 3, archived: false, createdAt: day('2026-11-10'), updatedAt: day('2026-11-23') },
      { id: 'rediseno', title: 'Rediseño 1.4', plan: '', mainSessionId: null, revision: 1, archived: false, createdAt: day('2026-11-12'), updatedAt: day('2026-11-12') },
      { id: 'alertas', title: 'Migrar las alertas', plan: '', mainSessionId: null, revision: 4, archived: true, archivedAt: day('2026-11-20'), createdAt: day('2026-11-01'), updatedAt: day('2026-11-20') },
      { id: 'costos', title: 'Revisión de costos', plan: '', mainSessionId: null, revision: 2, archived: true, archivedAt: day('2026-11-18'), createdAt: day('2026-11-02'), updatedAt: day('2026-11-18') },
    ];
    const item = (id: string, projectId: string, title: string, status: string, note = '', session: any = null, checkpointCount = 0) => ({ id, projectId, title, note, status, position: 0, revision: 1, archived: false, createdAt: 1, updatedAt: 1, session, checkpointCount });
    const items = [
      item('alcance', 'plan', 'Definir el alcance de la entrega', 'todo', 'Qué entra en 1.4 y qué queda fuera.', { id: 'precios', source: 'link' }, 1),
      item('fluidez', 'plan', 'Validar la fluidez de las terminales', 'doing', 'Desplazamiento, cambio de panel y posición de lectura con ocho sesiones.', { id: 'main', source: 'link' }, 3),
      item('shell', 'plan', 'Integrar el tablero con el shell', 'doing', '', { id: 'tokens', source: 'checkpoint' }, 2),
      item('espera', 'plan', 'Revisar textos con el equipo', 'waiting', 'Pendiente de la revisión del viernes.'),
      item('modelo', 'plan', 'Modelo y checkpoints verificados', 'done', 'Revisado con datos de prueba.', { id: 'anterior', source: 'checkpoint' }, 4),
      item('a1', 'alertas', 'Inventario de alertas', 'done'), item('a2', 'alertas', 'Migración y prueba', 'done'),
      item('c1', 'costos', 'Recoger facturas', 'done'), item('c2', 'costos', 'Comparar proveedores', 'doing'), item('c3', 'costos', 'Propuesta final', 'todo'),
      item('p1', null as any, 'Renovar el certificado del dominio', 'todo'), item('p2', null as any, 'Responder a soporte', 'doing'),
    ];
    const open = () => projects.filter(p => !p.archived);
    const status = () => structuredClone({ pid: 4242, generation: 'docs', runnerVersion: '1.4.0', pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true,
      pulsoSummaryVersion: 1, pulsoRevisionVersion: 1, pulsoRevision: revision, pulsoBoardCardsVersion: 1, nativeResumeVersion: 1, normalTerminalVersion: 1, sessionRenameVersion: 1,
      telemetryVersion: 1, codexVersion: 1, terminalSessionVersion: 1, claudeNativeConfigVersion: 1, nativePermissionsVersion: 1,
      settingsVersion: 2, settings: { schemaVersion: 2, maxConcurrentSessions: 6, maxSupportedSessions: 8, pulsoAutoAccess: true }, sessions, lastSeq: events.length });
    const MiB = 1024 ** 2;
    const telemetry = () => {
      const now = Math.floor(Date.now() / 1000);
      const row = (pid: number, mib: number, cpu: number, extra: any = {}) => ({ pid, available: true, rssBytes: mib * MiB, cpuPercent: cpu, cpuAvailable: true, ...extra });
      return {
        quotas: {
          codex: { status: 'available', source: 'account/rateLimits/read', observedAt: now - 90, windows: [
            { limitId: 'codex', window: 'primary', windowDurationMins: 300, remainingPercent: 64, resetsAt: now + 7200 },
            { limitId: 'codex', window: 'secondary', windowDurationMins: 10080, remainingPercent: 88, resetsAt: now + 3 * 86400 }] },
          // Same shape as runner/src/claude_quota.rs (statusline windows five_hour / seven_day).
          claude: { schemaVersion: 1, provider: 'claude', status: 'available', source: 'claude/statusline', observedAt: now - 60, windows: [
            { limitId: 'claude', window: 'five_hour', windowDurationMins: 300, remainingPercent: 71, resetsAt: now + 9000 },
            { limitId: 'claude', window: 'seven_day', windowDurationMins: 10080, remainingPercent: 93, resetsAt: now + 4 * 86400 }] },
        }, quotasRefreshing: false,
        resources: {
          source: 'proc_pid_rusage_v0', timestampUnixMs: Date.now(), discovery: { partial: false },
          processes: [row(77, 7, 0.4, { role: 'runner' }), row(201, 186, 6.5, { role: 'cli', sessionId: 'main' }), row(202, 42, 1.2, { role: 'tool', sessionId: 'main' }),
            row(301, 132, 3.1, { role: 'cli', sessionId: 'precios' }), row(401, 118, 9.4, { role: 'cli', sessionId: 'tokens' }), row(501, 9, 0, { role: 'cli', sessionId: 'shell' })],
          app: { webEngine: 'included', source: 'proc_pid_rusage_v0', discovery: { partial: false }, processes: [row(1, 104, 2.2, { role: 'app' }), row(2, 214, 3.8, { role: 'web' }), row(3, 31, 0.6, { role: 'web' })] },
        },
      };
    };
    w.capture = { out, focus(value: boolean) { focused = value; } };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') return { dataDir: '/tmp/perfil-de-ejemplo', socket: '/tmp/perfil-de-ejemplo/runner.sock', status: status(), smoke: false };
      if (cmd === 'probe_tools') return [{ tool: 'claude', available: true, version: '2.1.0 (Claude Code)' }, { tool: 'codex', available: true, version: 'codex-cli 0.60.0' }];
      if (cmd === 'home_directory') return HOME;
      if (cmd.startsWith('plugin:')) return cmd === 'plugin:event|listen' ? 1 : cmd === 'plugin:notification|is_permission_granted' ? false : undefined;
      if (cmd === 'record_ui_evidence') return;
      if (cmd === 'pulso_request') {
        const x = a.args; const op = a.op; let result: any;
        const counts = (id: string) => { const rows = items.filter(i => i.projectId === id); return { done: rows.filter(i => i.status === 'done').length, total: rows.length }; };
        if (op === 'revision') result = { revision };
        else if (op === 'sidebar_summary') result = x.ifRevision === revision ? { revision, unchanged: true } : { revision, projects: open().map(p => ({ id: p.id, title: p.title, mainSessionId: p.mainSessionId, ...counts(p.id) })), hasMore: false,
          pendingOpen: items.filter(i => !i.projectId && i.status !== 'done').length, links: [{ sessionId: 'main', projectId: 'plan', via: 'project' }, { sessionId: 'precios', projectId: 'plan', via: 'item' }, { sessionId: 'tokens', projectId: 'plan', via: 'item' }], linksTruncated: false };
        else if (op === 'projects') { const rows = projects.filter(p => !!p.archived === !!x.archived); result = { projects: rows.slice(0, x.limit).map(p => ({ ...p, plan: '' })), revision, totalCount: rows.length, hasMore: rows.length > x.limit }; }
        else if (op === 'project') result = { project: structuredClone(projects.find(p => p.id === x.id)) };
        else if (op === 'links') result = { links: x.projectId === 'plan' ? [{ projectId: 'plan', sessionId: 'precios' }] : [] };
        else if (op === 'items') { const rows = items.filter(i => i.projectId === x.projectId && (!x.status || i.status === x.status)); result = { items: rows.slice(0, x.limit), totalCount: rows.length, revision, hasMore: rows.length > x.limit }; }
        else if (op === 'board') result = x.ifRevision === revision ? { revision, unchanged: true } : { revision, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => { const rows = items.filter(i => i.projectId === x.projectId && i.status === s); return [s, { items: rows, totalCount: rows.length, hasMore: false }]; })) };
        else if (op === 'policies') result = { policies: [] };
        else return { ok: false, error: 'unexpected' };
        return { ok: true, result: structuredClone(result) };
      }
      if (cmd === 'runner_request') {
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'telemetry') return { ok: true, result: telemetry() };
        if (a.op === 'get_settings') return { ok: true, result: status().settings };
        if (a.op === 'events') return { ok: true, result: { events: events.filter(e => e.seq > a.args.after), lastSeq: events.length, hasMore: false } };
        if (a.op === 'resize') { const s = sessions.find(s => s.id === a.args.id); if (s) { s.cols = a.args.cols; s.rows = a.args.rows; } return { ok: true, result: { cols: a.args.cols, rows: a.args.rows } }; }
        if (a.op === 'input') return { ok: true, result: {} };
        if (a.op === 'native_binding') return { ok: true, result: { binding: a.args.id === 'main' || a.args.id === 'anterior' ? { provider: 'claude', conversationId: `conv-${a.args.id}`, source: 'reserved', resumedFrom: null } : null, activeSessionId: null } };
        if (a.op === 'mark_seen') return { ok: true, result: {} };
      }
      throw new Error(`Unexpected synthetic RPC ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  });
}

async function ready(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
  // The status bar total comes from the first telemetry read.
  await page.waitForFunction(() => /CPU \d/.test(document.querySelector('#telemetry-summary')?.textContent ?? ''), undefined, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); getSelection()?.removeAllRanges(); });
  await page.mouse.move(1, 1); await page.waitForTimeout(350);
  await page.screenshot({ path: `${dir}/${name}`, animations: 'disabled' });
  console.log(`${dir}/${name}`);
}
async function terminalOutput(page: Page) {
  await page.evaluate(() => {
    const c = (window as any).capture;
    c.out('main', '\x1b]7501;state=working\x07\x1b[2m$ claude\x1b[0m\r\n> Revisa el plan de la entrega 1.4 y dime qué falta.\r\n\r\n\x1b[32m✓\x1b[0m Leí el plan y las fases de Pulso\r\n\x1b[32m✓\x1b[0m Comprobé los textos de la ventana Nueva sesión\r\n\x1b[33m…\x1b[0m Preparando la lista de pendientes\r\n');
    c.out('precios', '• Ejecuté git diff --stat\r\n  tabla-precios.css | 15 ++++++++++-----\r\n\r\n• Ajusté los espaciados de la tabla.\r\n\x1b]7501;state=done\x07');
    c.out('tokens', '\x1b]7501;state=working\x07Migrando tokens… 12 de 40 archivos\r\n');
    c.out('shell', '\x1b[2m~\x1b[0m $ ls proyectos\r\nprecios   tokens   notas\r\n\x1b[2m~\x1b[0m $ ');
  });
  await page.waitForTimeout(900);
}

await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const theme of ['light', 'dark'] as const) {
    const suffix = theme === 'dark' ? '-oscuro' : '';
    const page = await browser.newPage({ viewport: { width: 1220, height: 800 }, deviceScaleFactor: 1 });
    await page.addInitScript(value => { try { localStorage.setItem('aw-theme', value); } catch { /* optional */ } }, theme);
    await install(page); await ready(page); await terminalOutput(page);
    // Terminal: sidebar (Proyectos and Agentes), tabs with provider marks, pane heading, status bar.
    await page.locator('#session-tabs [data-session-id="main"], #session-tabs button').first().waitFor();
    await shot(page, `terminal-1.4.0${suffix}.png`);
    if (theme === 'light') {
      await page.locator('#toggle-split').click(); await page.waitForTimeout(800);
      await shot(page, 'terminal-dividida-1.4.0.png');
      await page.locator('#toggle-split').click(); await page.waitForTimeout(500);
    }
    // Activity: an unseen alert from a background session, bell open.
    await page.evaluate(() => { const c = (window as any).capture; c.focus(false); c.out('tokens', '\x1b]7501;state=blocked\x07Necesito permiso para escribir en src/\r\n\x07'); });
    await page.waitForFunction(() => !(document.querySelector('#session-alerts') as HTMLElement).hidden);
    await page.evaluate(() => (window as any).capture.focus(true));
    await page.locator('#session-alerts').click(); await page.locator('#attention-banner:not([hidden])').waitFor();
    await page.waitForTimeout(300); await page.screenshot({ path: `${dir}/actividad-1.4.0-aviso${suffix}.png`, animations: 'disabled' }); console.log(`${dir}/actividad-1.4.0-aviso${suffix}.png`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    // Command palette as it opens: Te necesitan, Sesiones, Proyectos and Acciones.
    await page.locator('#open-command-palette').click(); await page.locator('.command-palette[open], dialog.command-palette').first().waitFor().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/paleta-1.4.0${suffix}.png`, animations: 'disabled' }); console.log(`${dir}/paleta-1.4.0${suffix}.png`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    if (theme === 'light') {
      await page.locator('#open-settings').click(); await page.getByRole('dialog', { name: 'Configuración' }).waitFor(); await page.waitForTimeout(600);
      await page.screenshot({ path: `${dir}/configuracion-1.4.0.png`, animations: 'disabled' }); console.log(`${dir}/configuracion-1.4.0.png`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      await page.locator('#tab-new-session').click(); await page.locator('#new-session-dialog[open]').waitFor();
      await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement)?.value === '/Users/tu-usuario');
      await page.locator('input[name=provider][value=claude]').check();
      await page.locator('#session-project').selectOption('plan'); await page.locator('#session-title').fill('Revisar la entrega');
      await page.locator('#session-title').blur(); await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/nueva-sesion-1.4.0.png`, animations: 'disabled' }); console.log(`${dir}/nueva-sesion-1.4.0.png`);
      await page.locator('#cancel-session').click(); await page.waitForTimeout(300);
      await page.locator('#open-telemetry').click(); await page.locator('#telemetry-dialog[open]').waitFor();
      await page.waitForFunction(() => /Interfaz/.test(document.querySelector('#telemetry-dialog')?.textContent ?? ''));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${dir}/uso-recursos-1.4.0.png`, animations: 'disabled' }); console.log(`${dir}/uso-recursos-1.4.0.png`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
    await page.close();
    // Pulso at 1280×820: boards-only tabs, Nuevo proyecto, Histórico with its counter, Proyecto/Sesiones, card footers.
    const pulso = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
    await pulso.addInitScript(value => { try { localStorage.setItem('aw-theme', value); } catch { /* optional */ } }, theme);
    await install(pulso); await ready(pulso); await terminalOutput(pulso);
    await pulso.locator('#open-pulso').click();
    await pulso.locator('#pulso-tabs-host').getByRole('button', { name: 'Integrar Pulso en Jauría', exact: true }).click();
    await pulso.locator('.pulso-card-session').first().waitFor();
    await pulso.waitForFunction(() => document.querySelector('.pulso-archive-count')?.textContent === '2');
    await shot(pulso, `pulso-1.4.0${suffix}.png`);
    if (theme === 'light') {
      await pulso.locator('.pulso-board-toolbar').getByRole('button', { name: 'Proyecto', exact: true }).click();
      await pulso.getByLabel('Nombre del proyecto', { exact: true }).waitFor(); await pulso.waitForTimeout(300);
      await pulso.screenshot({ path: `${dir}/pulso-proyecto-1.4.0.png`, animations: 'disabled' }); console.log(`${dir}/pulso-proyecto-1.4.0.png`);
      await pulso.getByRole('button', { name: 'Cerrar detalle', exact: true }).click(); await pulso.waitForTimeout(300);
      await pulso.getByRole('button', { name: /^Histórico/ }).click();
      await pulso.getByText(/Archivado sin terminar el/).waitFor(); await pulso.getByText(/Terminado el/).waitFor(); await pulso.waitForTimeout(300);
      await pulso.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await pulso.screenshot({ path: `${dir}/pulso-historico-1.4.0.png`, animations: 'disabled' }); console.log(`${dir}/pulso-historico-1.4.0.png`);
    }
    await pulso.close();
  }
} finally { await browser.close(); await server.close(); }

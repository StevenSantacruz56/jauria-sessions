/** Synthetic screenshots and PTY measurements of the 1.4 workbench. Real shell,
 * CSS and xterm; synthetic Tauri boundary only (no runner, providers or profiles).
 * Not part of the test globs. From desktop:
 *   CAPTURE_DIR=/abs/dir node tests/capture-redesign.ts            # screenshots (Chromium)
 *   CAPTURE_MEASURE=1 node tests/capture-redesign.ts                # cols × rows table
 *   CAPTURE_MEASURE=1 CAPTURE_BASELINE_REF=d190a6b node tests/capture-redesign.ts
 * The baseline ref serves that commit's ui.ts, style.css and main.ts in memory.
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';

const baselineRef = process.env.CAPTURE_BASELINE_REF;
const historical = new Map(baselineRef ? ['ui.ts', 'style.css', 'main.ts'].map(name => [name,
  execFileSync('git', ['show', `${baselineRef}:experiments/tauri-vertical/desktop/src/${name}`], { encoding: 'utf8' })]) : []);
const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'historical-layout-in-memory', enforce: 'pre', load(id) {
    for (const [name, source] of historical) if (id.split('?')[0].endsWith(`/src/${name}`)) return source;
  } }] });
await server.listen();
const url = server.resolvedUrls!.local[0];

async function install(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const sessions = [
      { id: 'main', title: 'Orquestador · Integración', kind: 'claude', cwd: '/Users/demo/proyectos/integrar-pulso', status: 'running', rows: 24, cols: 80 },
      { id: 'related', title: 'Fase sintética · Validación', kind: 'codex', cwd: '/Users/demo/proyectos/validacion', status: 'running', rows: 24, cols: 80 },
      { id: 'tokens', title: 'Migrar tokens de color', kind: 'codex', cwd: '/Users/demo/proyectos/tokens', status: 'running', rows: 24, cols: 80 },
      { id: 'shell', title: 'Terminal', kind: 'terminal', cwd: '/Users/demo', status: 'exited', rows: 24, cols: 80 },
    ];
    const events: any[] = []; const resizes: any[] = []; const inputs: any[] = []; let focused = true;
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    const out = (sessionId: string, data: string) => events.push({ seq: events.length + 1, sessionId, kind: 'output', data: btoa(unescape(encodeURIComponent(data))) });
    const projects = [{ id: 'plan', title: 'Integrar Pulso en Jauría', plan: 'Plan sintético.', mainSessionId: 'main', revision: 1, archived: false, createdAt: 1, updatedAt: 1 },
      { id: 'redesign', title: 'Rediseño 1.4', plan: '', mainSessionId: null, revision: 1, archived: false, createdAt: 2, updatedAt: 2 }];
    const item = (id: string, title: string, status: string, note = '') => ({ id, projectId: 'plan', title, note, status, position: 0, revision: 1, archived: false, createdAt: 1, updatedAt: 1 });
    const items = [item('scope', 'Definir el alcance de la entrega', 'todo', 'Datos de prueba sintéticos.'),
      item('fluidez', 'Validar la fluidez de las terminales', 'doing', 'Contenido sintético para comprobar la navegación entre sesiones, el desplazamiento y la posición de lectura.'),
      item('shell', 'Integrar el tablero con el shell', 'doing'),
      item('model', 'Modelo y checkpoints verificados', 'done', 'Revisado con datos sintéticos.')];
    const status = () => structuredClone({ pid: 4242, generation: 'capture', runnerVersion: '1.4.0', pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true, nativeResumeVersion: 1,
      normalTerminalVersion: 1, sessionRenameVersion: 1, settingsVersion: 2, settings: { schemaVersion: 2, maxConcurrentSessions: 4, maxSupportedSessions: 8, pulsoAutoAccess: true },
      sessions, lastSeq: events.length });
    w.capture = { out, resizes, inputs, focus(value: boolean) { focused = value; } };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: false };
      if (cmd === 'probe_tools') return [];
      if (cmd === 'home_directory') return '/Users/demo';
      if (cmd.startsWith('plugin:')) return cmd === 'plugin:event|listen' ? 1 : undefined;
      if (cmd === 'record_ui_evidence') return;
      if (cmd === 'pulso_request') {
        const x = a.args; const op = a.op; let result: any;
        if (op === 'revision') result = { revision: 3 };
        else if (op === 'projects') result = { projects: projects.map(p => ({ ...p, plan: '' })), revision: 3, totalCount: projects.length, hasMore: false };
        else if (op === 'project') result = { project: projects.find(p => p.id === x.id) };
        else if (op === 'links') result = { links: [] };
        else if (op === 'items') { const rows = items.filter(i => i.projectId === x.projectId && (!x.status || i.status === x.status)); result = { items: rows.slice(0, x.limit), totalCount: rows.length, revision: 3, hasMore: rows.length > x.limit }; }
        else if (op === 'board') result = { revision: 3, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => { const rows = items.filter(i => i.projectId === x.projectId && i.status === s); return [s, { items: rows, totalCount: rows.length, hasMore: false }]; })) };
        else if (op === 'policies') result = { policies: [] };
        else return { ok: false, error: 'unexpected' };
        return { ok: true, result: structuredClone(result) };
      }
      if (cmd === 'runner_request') {
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'telemetry') return { ok: true, result: { resources: { app: { processes: [{ cpuPercent: 3.2, rssBytes: 412 * 1024 * 1024 }] } } } };
        if (a.op === 'get_settings') return { ok: true, result: status().settings };
        if (a.op === 'events') return { ok: true, result: { events: events.filter(e => e.seq > a.args.after), lastSeq: events.length, hasMore: false } };
        if (a.op === 'resize') { resizes.push(structuredClone(a.args)); const s = sessions.find(s => s.id === a.args.id)!; s.cols = a.args.cols; s.rows = a.args.rows; return { ok: true, result: { cols: s.cols, rows: s.rows } }; }
        if (a.op === 'input') { inputs.push(structuredClone(a.args)); return { ok: true, result: {} }; }
        if (a.op === 'native_binding') return { ok: true, result: { binding: null } };
      }
      throw new Error(`Unexpected synthetic RPC ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  });
}

const sizeOf = (page: Page) => page.evaluate(() => {
  const latest = new Map<string, any>(); for (const r of (window as any).capture.resizes) latest.set(r.id, r);
  return Object.fromEntries([...latest].map(([id, r]) => [id, `${r.cols}×${r.rows}`]));
});
async function ready(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
  await page.waitForTimeout(600);
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  if (process.env.CAPTURE_MEASURE) {
    for (const viewport of [{ width: 1220, height: 800 }, { width: 760, height: 560 }]) {
      const page = await browser.newPage({ viewport }); await install(page); await ready(page);
      const one = await sizeOf(page);
      await page.locator('#toggle-split').click(); await page.waitForTimeout(700);
      const two = await sizeOf(page);
      console.log(JSON.stringify({ layout: baselineRef ?? 'working tree', viewport: `${viewport.width}×${viewport.height}`, onePane: one.main, twoPanes: [two.main, two.related] }));
      await page.close();
    }
  }
  const dir = process.env.CAPTURE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
      await page.addInitScript(value => { try { localStorage.setItem('aw-theme', value); } catch {} }, theme);
      await install(page); await ready(page);
      await page.evaluate(() => {
        const c = (window as any).capture;
        c.out('main', '\x1b]7501;state=working\x07\x1b[2m$ jauria-demo revisar-avisos\x1b[0m\r\n\x1b[32m[ok]\x1b[0m Estados declarados por el agente\r\n\x1b[32m[ok]\x1b[0m Sesiones agrupadas por prioridad\r\n\x1b[33m[pendiente]\x1b[0m Confirmar permiso para continuar\r\n\r\n');
        c.out('related', '• Ejecuté git diff --stat\r\n  src/tabla.css | 15 ++++++++++-----\r\n\r\n• Actualicé tabla.css con variables de espaciado.\r\n\x1b]7501;state=done\x07');
        c.out('tokens', '\x1b]7501;state=working\x07Migrando tokens… 12 de 40 archivos\r\n');
      });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${dir}/${theme}-1-terminal-un-panel.png` });
      await page.locator('#toggle-split').click(); await page.waitForTimeout(700);
      await page.screenshot({ path: `${dir}/${theme}-2-terminal-dos-paneles.png` });
      // An explicit alert from the background pane while the window is unfocused.
      await page.evaluate(() => { const c = (window as any).capture; c.focus(false); c.out('tokens', '\x1b]7501;state=blocked\x07Necesito permiso para escribir en src/\r\n\x07'); });
      await page.waitForFunction(() => !(document.querySelector('#session-alerts') as HTMLElement).hidden);
      await page.evaluate(() => (window as any).capture.focus(true));
      await page.locator('#session-alerts').click(); await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/${theme}-3-aviso-popover.png` });
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      await page.locator('#session-0').click(); await page.keyboard.type('val'); await page.waitForTimeout(200);
      await page.screenshot({ path: `${dir}/${theme}-4-selector-sesion.png` });
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      await page.locator('#open-pulso').click();
      await page.locator('#pulso-tabs-host').getByRole('button', { name: 'Integrar Pulso en Jauría', exact: true }).click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${dir}/${theme}-5-pulso.png` });
      await page.getByRole('button', { name: 'Mover Validar la fluidez de las terminales', exact: true }).click(); await page.waitForTimeout(200);
      await page.screenshot({ path: `${dir}/${theme}-6-pulso-menu-mover.png` });
      await page.keyboard.press('Escape');
      await page.locator('#open-settings').click(); await page.waitForTimeout(600);
      await page.screenshot({ path: `${dir}/${theme}-7-configuracion.png` });
      await page.keyboard.press('Escape'); await page.locator('#session-list .session-item').first().click();
      await page.setViewportSize({ width: 760, height: 560 }); await page.waitForTimeout(700);
      await page.screenshot({ path: `${dir}/${theme}-8-terminal-760.png` });
      await page.close();
    }
  }
} finally { await browser.close(); await server.close(); }

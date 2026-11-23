/** Delivery 1.4 E (client): Pulso revision in status, sidebar_summary, board
 * card footers and phases in the palette, against a synthetic native boundary
 * that can announce or omit the runner 1.4 capabilities. No runner, provider
 * or profile. Run from desktop with PULSO_PANEL_BROWSER=1 (PULSO_PANEL_WEBKIT=1
 * adds WebKit). PULSO_E_SCREENSHOT_DIR=/absolute/dir writes review captures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

async function install(page: Page, caps: boolean) {
  await page.addInitScript(caps => {
    const w = window as any;
    const sessions: any[] = [
      { id: 'main', title: 'Plan sintético · Integración', kind: 'claude', cwd: '/synthetic/project', status: 'running', rows: 24, cols: 80 },
      { id: 'related', title: 'Fase sintética · Validación con un nombre largo para truncar', kind: 'codex', cwd: '/synthetic/other', status: 'running', rows: 24, cols: 80 },
      { id: 'closed', title: 'Historial sintético', kind: 'terminal', cwd: '/synthetic/closed', status: 'exited', rows: 24, cols: 80 },
    ];
    const stamp = '2026-11-14T10:00:00Z';
    const projects: any[] = [{ id: 'plan', title: 'Integrar Pulso en Jauria', plan: '', mainSessionId: 'main', revision: 1, archived: false, createdAt: stamp, updatedAt: stamp }];
    const item = (id: string, title: string, status: string, extra: any = {}) => ({ id, projectId: 'plan', title, note: '', status, position: 0, revision: 1, archived: false, createdAt: stamp, updatedAt: stamp, ...extra });
    const items: any[] = [
      item('phase', 'Validar la fluidez de las terminales', 'doing', { note: 'Contenido sintético.' }),
      item('scope', 'Definir el alcance de la entrega', 'todo'),
      item('ghost', 'Esperar la sesión que ya no está', 'waiting'),
      item('history', 'Revisar el historial de la prueba', 'waiting'),
      item('model', 'Modelo y checkpoints verificados', 'done'),
      { ...item('loose', 'Preparar la revisión de mañana', 'todo'), projectId: null },
    ];
    // Footer source per phase (runner 1.4 `board`): link, checkpoint, missing session, closed session.
    const footers: Record<string, { session: any; checkpointCount: number }> = {
      phase: { session: { id: 'related', source: 'link' }, checkpointCount: 2 },
      model: { session: { id: 'main', source: 'checkpoint' }, checkpointCount: 1 },
      ghost: { session: { id: 'gone', source: 'link' }, checkpointCount: 0 },
      history: { session: { id: 'closed', source: 'link' }, checkpointCount: 3 },
    };
    const summaryLinks = [{ sessionId: 'closed', projectId: 'plan', via: 'item' }, { sessionId: 'gone', projectId: 'plan', via: 'item' }, { sessionId: 'related', projectId: 'plan', via: 'item' }];
    const events: any[] = []; const calls: any[] = []; const resizes: any[] = []; const inputs: any[] = []; const updates: any[] = [];
    let rev = 3, statusReads = 0;
    const f = w.pulsoE = { calls, resizes, inputs, updates, sessions, items, statusReads: 0, caps,
      bump(title?: string) { rev++; if (title) items[0].title = title; },
      output(id: string, data: string) { events.push({ seq: events.length + 1, sessionId: id, kind: 'output', data: btoa(data) }); },
      setHidden(hidden: boolean) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      },
      pulsoOps: () => calls.map((c: any) => c.op) };
    const status = () => {
      statusReads++; f.statusReads = statusReads;
      return structuredClone({ pid: 9, generation: 'pulso-e', pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true, nativeResumeVersion: 1, normalTerminalVersion: 1,
        sessionRenameVersion: 1, settingsVersion: 1, settings: { schemaVersion: 1, maxConcurrentSessions: 4, maxSupportedSessions: 8 }, sessions, lastSeq: events.length,
        ...(caps ? { pulsoRevision: rev, pulsoRevisionVersion: 1, pulsoSummaryVersion: 1, pulsoBoardCardsVersion: 1 } : {}) });
    };
    const column = (projectId: string | null, state: string) => {
      const rows = items.filter(i => !i.archived && i.projectId === projectId && i.status === state);
      return { items: structuredClone(rows.slice(0, 20)).map((i: any) => caps ? { ...i, session: footers[i.id]?.session ?? null, checkpointCount: footers[i.id]?.checkpointCount ?? 0 } : i), totalCount: rows.length, hasMore: rows.length > 20, nextCursor: 20 };
    };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') return { dataDir: '/synthetic-e', socket: '/synthetic-e/sock', status: status(), smoke: false };
      if (cmd === 'probe_tools') return []; if (cmd === 'record_ui_evidence') return; if (cmd === 'plugin:window|set_badge_count') return;
      if (cmd === 'pulso_request') {
        calls.push({ op: a.op, args: structuredClone(a.args) }); const x = a.args; let result: any;
        if (a.op === 'revision') result = { revision: rev };
        else if (a.op === 'sidebar_summary') {
          if (!caps) return { ok: false, error: 'unknown operation' };
          if (x.ifRevision === rev) result = { revision: rev, unchanged: true };
          else result = { revision: rev, projects: projects.map(p => ({ id: p.id, title: p.title, mainSessionId: p.mainSessionId, done: items.filter(i => i.projectId === p.id && i.status === 'done').length, total: items.filter(i => i.projectId === p.id).length })),
            hasMore: false, pendingOpen: items.filter(i => i.projectId === null && i.status !== 'done').length, links: summaryLinks, linksTruncated: false };
        }
        else if (a.op === 'projects') result = { projects: structuredClone(projects), revision: rev, totalCount: projects.length, hasMore: false };
        else if (a.op === 'project') result = { project: structuredClone(projects.find(p => p.id === x.id)) };
        else if (a.op === 'board') result = x.ifRevision === rev ? { revision: rev, unchanged: true } : { revision: rev, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => [s, column(x.projectId, s)])) };
        else if (a.op === 'items') { if (x.expectedSnapshotRevision !== undefined && x.expectedSnapshotRevision !== rev) return { ok: false, error: 'stale snapshot' };
          const rows = items.filter(i => !i.archived && i.projectId === x.projectId && (!x.status || i.status === x.status)); result = { items: structuredClone(rows.slice(0, x.limit)), revision: rev, totalCount: rows.length, hasMore: rows.length > x.limit }; }
        else if (a.op === 'links') result = { links: [] };
        else if (a.op === 'item') result = { item: structuredClone(items.find(i => i.id === x.id)), links: [], checkpoints: [] };
        else if (a.op === 'policies') result = { policies: [] };
        else if (a.op === 'item_update') { const row = items.find(i => i.id === x.id); updates.push(structuredClone(x)); Object.assign(row, { status: x.status, revision: ++rev }); result = { item: structuredClone(row) }; }
        else return { ok: false, error: 'Unexpected synthetic operation' };
        return { ok: true, result };
      }
      if (cmd === 'runner_request') {
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'get_settings') return { ok: true, result: { schemaVersion: 1, maxConcurrentSessions: 4, maxSupportedSessions: 8 } };
        if (a.op === 'telemetry') return { ok: true, result: {} };
        if (a.op === 'events') return { ok: true, result: { events: events.filter(e => e.seq > a.args.after), lastSeq: events.length, hasMore: false } };
        if (a.op === 'resize') { resizes.push(a.args); return { ok: true, result: { rows: a.args.rows, cols: a.args.cols } }; }
        if (a.op === 'input') { inputs.push(a.args); return { ok: true, result: { written: a.args.data.length } }; }
        if (a.op === 'native_binding') return { ok: true, result: { binding: null, activeSessionId: null } };
        return { ok: true, result: {} };
      }
      throw Error(`Unexpected fixture command ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  }, caps);
}

const fx = (page: Page, source: string) => page.evaluate(source => Function('f', source)((window as any).pulsoE), source);
const callCount = (page: Page) => fx(page, 'return f.calls.length') as Promise<number>;
const opsSince = (page: Page, from: number) => fx(page, `return f.calls.slice(${from}).map(c=>c.op)`) as Promise<string[]>;
async function statusCycles(page: Page, n: number) {
  const start = await fx(page, 'return f.statusReads') as number;
  await page.waitForFunction(([start, n]) => (window as any).pulsoE.statusReads >= start + n, [start, n], { timeout: 4000 + n * 1500 });
}
async function boot(page: Page, caps: boolean) {
  await install(page, caps); await page.goto(url);
  await page.waitForFunction(() => !(document.querySelector('#open-pulso') as HTMLButtonElement).disabled);
  // The sidebar summary is in once the project row shows its progress.
  await page.locator('#sidebar-project-list [data-board="plan"] .sidebar-row-meta').filter({ hasText: '1/5' }).waitFor();
}
async function openBoard(page: Page) {
  await page.locator('#sidebar-project-list [data-board="plan"]').click();
  await page.locator('.pulso-card[data-item-id="phase"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.pulso-panel')?.getAttribute('aria-busy') === 'false');
}
const foot = (page: Page, id: string) => page.locator(`.pulso-card[data-item-id="${id}"] .pulso-card-foot`);

if (process.env.PULSO_PANEL_BROWSER !== '1') test('Pulso revision browser coverage requires PULSO_PANEL_BROWSER=1', { skip: true }, () => {});
try {
  for (const engine of process.env.PULSO_PANEL_BROWSER === '1' ? (process.env.PULSO_PANEL_WEBKIT === '1' ? [chromium, webkit] : [chromium]) : []) {
    const name = engine.name();
    const launch = () => engine.launch(engine === chromium ? { channel: 'chrome' } : {});

    await test(`${name}: sidebar follows status.pulsoRevision with one summary read, none while hidden`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await boot(page, true);
      assert.deepEqual([...new Set(await opsSince(page, 0))], ['sidebar_summary'], 'the sidebar reads only sidebar_summary');
      // Phase-linked sessions are grouped under their project; the main session too.
      const group = page.locator('#session-list section[data-project="plan"]');
      assert.deepEqual(await group.locator('.session-item').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.sessionId).sort()), ['main', 'related']);
      const idle = await callCount(page); await statusCycles(page, 3);
      assert.equal(await callCount(page) - idle, 0, 'unchanged status cycles cost zero Pulso reads');
      t.diagnostic(`terminal view, 3 unchanged status cycles: ${await callCount(page) - idle} Pulso calls`);
      let before = await callCount(page); await fx(page, 'f.bump()');
      await page.waitForFunction(n => (window as any).pulsoE.calls.length > n, before); await statusCycles(page, 2);
      assert.deepEqual(await opsSince(page, before), ['sidebar_summary'], 'a visible revision change rereads once');
      before = await callCount(page); await fx(page, 'f.setHidden(true);f.bump()'); await statusCycles(page, 3);
      assert.deepEqual(await opsSince(page, before), [], 'hidden: the change only stays pending');
      await fx(page, 'f.setHidden(false)');
      await page.waitForFunction(n => (window as any).pulsoE.calls.length > n, before); await statusCycles(page, 2);
      assert.deepEqual(await opsSince(page, before), ['sidebar_summary'], 'back to visible: exactly one reread');
      // A declared turn end no longer rereads: the revision says when Pulso changed.
      before = await callCount(page);
      await fx(page, `f.output('main','\\u001b]7501;state=working\\u0007');`); await statusCycles(page, 2);
      await fx(page, `f.output('main','\\u001b]7501;state=done\\u0007');`); await statusCycles(page, 2);
      assert.deepEqual(await opsSince(page, before), [], 'no turn-end heuristic with pulsoRevisionVersion');
      assert.deepEqual(errors, []);
    });

    await test(`${name}: visible board refreshes from status, not from a 2 s timer`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await boot(page, true); await openBoard(page);
      const idle = await callCount(page); await statusCycles(page, 3); await page.waitForTimeout(300);
      const idleOps = await opsSince(page, idle);
      assert.deepEqual(idleOps, [], 'no `revision` polling and no reads while nothing changes');
      t.diagnostic(`board view, 3 unchanged status cycles: ${idleOps.length} Pulso calls`);
      let before = await callCount(page); await fx(page, 'f.bump("Título remoto vía MCP")');
      await page.getByRole('button', { name: 'Abrir Título remoto vía MCP', exact: true }).waitFor();
      await statusCycles(page, 2);
      const changed = await opsSince(page, before);
      assert.deepEqual([...changed].sort(), ['board', 'projects', 'sidebar_summary'], `one board refresh and one summary read (${changed.join(',')})`);
      // A session-set change re-renders without reading Pulso.
      before = await callCount(page);
      await fx(page, `f.sessions.push({id:'fresh',title:'Sesión nueva',kind:'claude',cwd:'/synthetic/new',status:'running',rows:24,cols:80})`);
      await statusCycles(page, 2);
      assert.deepEqual((await opsSince(page, before)).filter(op => op !== 'sidebar_summary'), [], 'session changes need no board read');
      // Hidden document: no reads; back: one refresh.
      before = await callCount(page); await fx(page, 'f.setHidden(true);f.bump("Cambio mientras está oculto")'); await statusCycles(page, 3);
      assert.deepEqual(await opsSince(page, before), []);
      await fx(page, 'f.setHidden(false)'); await page.getByRole('button', { name: 'Abrir Cambio mientras está oculto', exact: true }).waitFor();
      // The draft guard still holds a remote refresh.
      await page.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Añadir fase', exact: true }).click();
      await page.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título de la fase', { exact: true }).fill('Borrador local');
      before = await callCount(page); await fx(page, 'f.bump("No pisar el borrador")'); await statusCycles(page, 2);
      assert.deepEqual((await opsSince(page, before)).filter(op => op !== 'sidebar_summary'), [], 'no board refresh over a draft');
      assert.equal(await page.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título de la fase', { exact: true }).inputValue(), 'Borrador local');
      await page.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
      await page.getByRole('button', { name: 'Abrir No pisar el borrador', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    });

    await test(`${name}: card footers show the linked session live and open it`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await boot(page, true); await openBoard(page);
      assert.equal(await foot(page, 'scope').count(), 0, 'no session and no checkpoints: no footer');
      for (const [id, count, label] of [['phase', '2', '2 checkpoints'], ['model', '1', '1 checkpoint']]) {
        const tally = foot(page, id).locator('.pulso-card-checkpoints');
        assert.equal(await tally.textContent(), count, 'compact count: flag icon and number');
        assert.equal(await tally.getAttribute('aria-label'), label); assert.equal(await tally.getAttribute('title'), label);
        assert.equal(await tally.getAttribute('role'), 'img'); assert.equal(await tally.locator('svg').count(), 1);
      }
      assert.equal(await foot(page, 'ghost').locator('.pulso-card-checkpoints').count(), 0, 'zero checkpoints are not shown');
      const linked = foot(page, 'phase').locator('button.pulso-card-session');
      assert.match(await linked.getAttribute('aria-label') ?? '', /^Abrir sesión vinculada Fase sintética/);
      const fromCheckpoint = foot(page, 'model').locator('button.pulso-card-session');
      assert.match(await fromCheckpoint.getAttribute('aria-label') ?? '', /^Sesión del último checkpoint: Plan sintético · Integración/);
      assert.match(await fromCheckpoint.getAttribute('title') ?? '', /Sesión del último checkpoint/);
      // A session the client does not know: no indicator and no action.
      assert.equal(await foot(page, 'ghost').locator('button').count(), 0);
      assert.equal(await foot(page, 'ghost').locator('.agent-indicator').count(), 0);
      assert.match(await foot(page, 'ghost').textContent() ?? '', /Sesión no disponible/);
      // Truncated name inside the card width.
      assert.equal(await linked.locator('.pulso-card-session-name').evaluate(n => getComputedStyle(n).textOverflow), 'ellipsis');
      // Live state: declared states only; changes arrive with status, without reading board.
      assert.equal(await foot(page, 'model').locator('.agent-indicator').getAttribute('data-state'), 'unreported', 'a running PTY alone never shows working');
      const before = await callCount(page);
      await fx(page, `f.output('main','\\u001b]7501;state=working\\u0007');`);
      await page.waitForFunction(() => document.querySelector('.pulso-card[data-item-id="model"] .agent-indicator')?.getAttribute('data-shape') === 'spinner');
      await fx(page, `f.sessions.find(s=>s.id==='related').status='exited'`);
      await page.waitForFunction(() => document.querySelector('.pulso-card[data-item-id="phase"] .agent-indicator')?.getAttribute('data-state') !== 'unreported');
      await statusCycles(page, 1);
      assert.deepEqual(await opsSince(page, before), [], 'footer state updates without board or other Pulso reads');
      await fx(page, `f.sessions.find(s=>s.id==='related').status='running'`); await statusCycles(page, 2);
      // Draft guard: an inline add form with text disables the footer actions.
      const todo = page.getByRole('region', { name: 'Por hacer', exact: true });
      await todo.getByRole('button', { name: 'Añadir fase', exact: true }).click(); await todo.getByLabel('Título de la fase', { exact: true }).fill('Borrador');
      assert.equal(await linked.isDisabled(), true);
      await todo.getByRole('button', { name: 'Cancelar', exact: true }).click(); assert.equal(await linked.isEnabled(), true);
      // Pointer: a live session focuses the terminal; no drawer opens.
      await linked.click();
      await page.waitForFunction(() => (document.querySelector('#pulso-panel-host') as HTMLElement).hidden);
      assert.equal(await page.locator('#workspace-title').textContent(), 'Fase sintética · Validación con un nombre largo para truncar');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      // Keyboard: Enter on a closed session's footer opens its history.
      await page.locator('#open-pulso').click(); await page.locator('.pulso-card[data-item-id="history"] .pulso-card-foot button').waitFor();
      await page.locator('.pulso-card[data-item-id="history"] .pulso-card-foot button').focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => (document.querySelector('#pulso-panel-host') as HTMLElement).hidden);
      assert.equal(await page.locator('#workspace-title').textContent(), 'Historial sintético');
      assert.match(await page.locator('.pane').first().textContent() ?? '', /Historial · solo lectura/);
      assert.equal(await fx(page, 'return f.inputs.length'), 0, 'opening a session never sends input');
      assert.equal(await fx(page, 'return f.calls.filter(c=>/^(link|grant)$|_update|_create/.test(c.op)).length'), 0);
      // Dragging a card with a footer still moves it.
      await page.locator('#open-pulso').click(); await openBoardIfNeeded(page);
      const grip = await page.getByRole('button', { name: 'Arrastrar Validar la fluidez de las terminales', exact: true }).boundingBox();
      const target = await page.getByRole('region', { name: 'Hecho', exact: true }).boundingBox(); assert.ok(grip && target);
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, target.y + 120, { steps: 10 }); await page.mouse.up();
      await page.getByRole('region', { name: 'Hecho', exact: true }).getByRole('button', { name: 'Abrir Validar la fluidez de las terminales', exact: true }).waitFor();
      assert.deepEqual(await fx(page, 'return f.updates.map(u=>u.status)'), ['done']);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.deepEqual(errors, []);
    });

    await test(`${name}: the palette lists the loaded board's phases without reading Pulso per key`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await boot(page, true);
      await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open]').waitFor();
      assert.equal(await page.locator('.command-palette-group[data-group="phases"]').count(), 0, 'no board loaded yet: no phases');
      await page.keyboard.press('Escape');
      await openBoard(page);
      const before = await callCount(page);
      await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open] .command-palette-search').waitFor();
      await page.keyboard.type('fluidez');
      const option = page.locator('.command-palette-group[data-group="phases"] [role="option"][data-item-id="phase:phase"]');
      await option.waitFor();
      assert.equal(await page.locator('.command-palette-group[data-group="phases"] .command-palette-heading').textContent(), 'Fases');
      assert.match(await option.textContent() ?? '', /En curso · Integrar Pulso en Jauria/);
      assert.deepEqual(await opsSince(page, before), [], 'typing in the palette reads nothing');
      await page.keyboard.press('Enter');
      await page.locator('dialog.pulso-drawer[open]').getByLabel('Título de la fase', { exact: true }).waitFor();
      assert.equal(await page.locator('dialog.pulso-drawer[open]').getByLabel('Título de la fase', { exact: true }).inputValue(), 'Validar la fluidez de las terminales');
      // From the terminal view the same entry brings Pulso back and opens the phase.
      await page.keyboard.press('Escape'); await page.locator('#pulso-back-terminal').click();
      await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open] .command-palette-search').waitFor();
      await page.keyboard.type('alcance'); await page.locator('[role="option"][data-item-id="phase:scope"]').waitFor(); await page.keyboard.press('Enter');
      await page.locator('dialog.pulso-drawer[open]').getByLabel('Título de la fase', { exact: true }).waitFor();
      assert.equal(await page.locator('dialog.pulso-drawer[open]').getByLabel('Título de la fase', { exact: true }).inputValue(), 'Definir el alcance de la entrega');
      // A draft keeps the drawer: the palette cannot replace it.
      await page.locator('dialog.pulso-drawer[open]').getByLabel('Notas', { exact: true }).fill('Borrador sin guardar');
      await page.keyboard.press('Meta+Shift+P');
      if (await page.locator('dialog.command-palette[open]').count()) {
        await page.keyboard.type('fluidez'); await page.keyboard.press('Enter');
      }
      assert.equal(await page.locator('dialog.pulso-drawer[open]').getByLabel('Notas', { exact: true }).inputValue(), 'Borrador sin guardar');
      assert.deepEqual(errors, []);
    });

    await test(`${name}: an old runner (1.3.x) keeps the previous behaviour`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await boot(page, false);
      const ops = await opsSince(page, 0);
      assert.equal(ops.includes('sidebar_summary'), false);
      assert.deepEqual([...new Set(ops)].sort(), ['items', 'links', 'projects'], 'per-project reads as before');
      assert.deepEqual(await page.locator('#session-list section[data-project="plan"] .session-item').evaluateAll(ns => ns.map(n => (n as HTMLElement).dataset.sessionId)), ['main'], 'only main session and project links group');
      // Turn-end heuristic still rereads the summary.
      let before = await callCount(page);
      await fx(page, `f.output('main','\\u001b]7501;state=working\\u0007');`); await statusCycles(page, 2);
      await fx(page, `f.output('main','\\u001b]7501;state=done\\u0007');`);
      await page.waitForFunction(n => (window as any).pulsoE.calls.slice(n).some((c: any) => c.op === 'projects'), before);
      await openBoard(page);
      assert.equal(await page.locator('.pulso-card-foot').count(), 0, 'cards stay as before');
      before = await callCount(page); await page.waitForTimeout(2300);
      const polled = await opsSince(page, before);
      assert.ok(polled.includes('revision'), `the 2 s revision timer still runs (${polled.join(',')})`);
      t.diagnostic(`old runner, board view, ~2.3 s unchanged: ${polled.length} Pulso calls (${polled.join(',')})`);
      await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open] .command-palette-search').waitFor();
      await page.keyboard.type('fluidez');
      await page.locator('[role="option"][data-item-id="phase:phase"]').waitFor();
      await page.keyboard.press('Escape');
      assert.deepEqual(errors, []);
    });

    const shots = process.env.PULSO_E_SCREENSHOT_DIR;
    if (shots && engine === chromium) await test(`${name}: review captures`, async t => {
      const browser = await launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await mkdir(shots, { recursive: true });
      await boot(page, true);
      await fx(page, `f.output('main','\\u001b]7501;state=working\\u0007');`);
      await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="main"] .agent-indicator')?.getAttribute('data-shape') === 'spinner');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await page.waitForTimeout(200);
        await page.locator('#sidebar').screenshot({ path: `${shots}/sidebar-fase-agrupada-${theme}.png` });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await openBoard(page);
      await page.waitForFunction(() => document.querySelector('.pulso-card[data-item-id="model"] .agent-indicator')?.getAttribute('data-shape') === 'spinner');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await page.waitForTimeout(200);
        await page.screenshot({ path: `${shots}/tablero-pies-${theme}.png` });
      }
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open] .command-palette-search').waitFor();
        await page.keyboard.type('a'); await page.locator('.command-palette-group[data-group="phases"]').waitFor(); await page.waitForTimeout(150);
        await page.screenshot({ path: `${shots}/paleta-fases-${theme}.png` });
        await page.keyboard.press('Escape');
      }
    });
  }
} finally { await server.close(); }

async function openBoardIfNeeded(page: Page) {
  await page.locator('.pulso-card[data-item-id="phase"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.pulso-panel')?.getAttribute('aria-busy') === 'false');
}

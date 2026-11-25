/** 1.4 C command palette (⌘⇧P). Real shell/CSS/xterm; synthetic Tauri boundary
 * only (no runner, providers or profiles). Run from desktop:
 * node --test tests/browser/command-palette.test.ts
 * PALETTE_SCREENSHOT_DIR=/absolute/dir also writes the review captures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

async function install(page: Page, options: { codex?: boolean } = {}) {
  await page.addInitScript(options => {
    const w = window as any;
    const sessions = [
      { id: 'live', title: 'Sesión viva sintética', kind: 'claude', cwd: '/synthetic/live', status: 'running', rows: 24, cols: 80 },
      { id: 'other', title: 'Otra sesión sintética', kind: 'codex', cwd: '/synthetic/other', status: 'running', rows: 24, cols: 80 },
      { id: 'closed', title: 'Historial sintético', kind: 'terminal', cwd: '/synthetic/closed', status: 'exited', rows: 24, cols: 80 },
    ];
    // A structured Codex conversation (its own text field instead of a PTY).
    if (options.codex) sessions.push({ id: 'chat', title: 'Conversación Codex sintética', kind: 'codex', transport: 'app-server', cwd: '/synthetic/chat', status: 'running', rows: 24, cols: 80,
      codex: { generation: 1, status: 'running', nativeThreadId: 'synthetic' } } as any);
    const projects = [{ id: 'plan', title: 'Integrar Pulso en Jauría', plan: '', mainSessionId: 'live', revision: 1, archived: false, createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z' }];
    const items = [{ id: 'phase', projectId: 'plan', title: 'Validar la paleta sintética', note: '', status: 'doing', position: 0, revision: 2, archived: false, createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z' }];
    const calls: any[] = []; const pulso: any[] = []; const resizes: any[] = []; const inputs: any[] = []; let rev = 3;
    const status = () => structuredClone({ pid: 7, generation: 'palette', pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true, normalTerminalVersion: 1,
      sessionRenameVersion: 1, settingsVersion: 1, settings: { schemaVersion: 1, maxConcurrentSessions: options.codex ? 4 : 2, maxSupportedSessions: 8 }, sessions, lastSeq: 0 });
    w.paletteFixture = { calls, pulso, resizes, inputs, failMoves: false };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: false };
      if (cmd === 'probe_tools') return [];
      if (cmd.startsWith('plugin:')) return cmd === 'plugin:event|listen' ? 1 : undefined;
      if (cmd === 'record_ui_evidence') return;
      if (cmd === 'pulso_request') {
        pulso.push(a.op); const x = a.args; let result: any;
        if (a.op === 'revision') result = { revision: rev };
        else if (a.op === 'projects') result = { projects: structuredClone(projects), revision: rev, totalCount: projects.length, hasMore: false };
        else if (a.op === 'project') result = { project: structuredClone(projects.find(p => p.id === x.id)) };
        else if (a.op === 'links') result = { links: [] };
        else if (a.op === 'items') { const rows = items.filter(i => i.projectId === x.projectId && (!x.status || i.status === x.status)); result = { items: structuredClone(rows.slice(0, x.limit)), revision: rev, totalCount: rows.length, hasMore: false }; }
        else if (a.op === 'board') result = { revision: rev, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => { const rows = items.filter(i => i.projectId === x.projectId && i.status === s); return [s, { items: structuredClone(rows), totalCount: rows.length, hasMore: false }]; })) };
        else if (a.op === 'policies') result = { policies: [] };
        else if (a.op === 'item_update') {
          if (w.paletteFixture.failMoves) return { ok: false, error: 'synthetic network failure' };
          const item = items.find(i => i.id === x.id)!; Object.assign(item, { status: x.status, revision: ++rev }); result = { item: structuredClone(item) };
        }
        else return { ok: false, error: 'unexpected' };
        return { ok: true, result };
      }
      if (cmd === 'runner_request') {
        calls.push(a.op);
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'telemetry') return { ok: true, result: {} };
        if (a.op === 'get_settings') return { ok: true, result: { schemaVersion: 1, maxConcurrentSessions: 2, maxSupportedSessions: 8 } };
        if (a.op === 'events') return { ok: true, result: { events: [], lastSeq: 0, hasMore: false } };
        if (a.op === 'resize') { resizes.push(structuredClone(a.args)); return { ok: true, result: { cols: a.args.cols, rows: a.args.rows } }; }
        if (a.op === 'input') { inputs.push(structuredClone(a.args)); return { ok: true, result: {} }; }
        if (a.op === 'codex_state') return { ok: true, result: { sessionId: a.args.id, generation: 1, status: 'running', nativeThreadId: 'synthetic', turns: [], pendingRequestCount: 0, requests: [] } };
      }
      throw new Error(`Unexpected synthetic RPC ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  }, options);
}
async function ready(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado' && !!document.querySelector('.pane:nth-child(1) .xterm-helper-textarea'));
  await page.waitForFunction(() => !(document.querySelector('#open-pulso') as HTMLButtonElement).disabled && !!document.querySelector('#sidebar-project-list [data-board="plan"]'));
  await page.waitForTimeout(400);
}
const fixture = (page: Page) => page.evaluate(() => { const f = (window as any).paletteFixture; return { inputs: f.inputs.length as number, resizes: f.resizes.length as number, calls: [...f.calls] as string[] }; });
const hostRect = (page: Page) => page.evaluate(() => { const r = document.querySelector('.pane:nth-child(1) .terminal-host')!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
const focusTerminal = (page: Page) => page.locator('.pane:nth-child(1) .xterm-helper-textarea').focus();
const inTerminal = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.pane:nth-child(1) .terminal-view'));
const paletteOpen = (page: Page) => page.evaluate(() => !!document.querySelector('dialog.command-palette[open]'));
async function openPalette(page: Page) { await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open] .command-palette-search').waitFor(); }
const option = (page: Page, id: string) => page.locator(`.command-palette [role="option"][data-item-id="${id}"]`);
const activeId = (page: Page) => page.evaluate(() => { const id = document.querySelector('.command-palette-search')!.getAttribute('aria-activedescendant'); return id ? document.getElementById(id)?.dataset.itemId ?? null : null; });

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: command palette`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      try {
        await install(page); await ready(page);
        await page.evaluate(() => window.addEventListener('keydown', e => { if (e.code === 'KeyP' && e.repeat) (window as any).lastPaletteRepeat = true; }, true));

        await t.test('⌘⇧P from a focused terminal: no key reaches the PTY and the terminal keeps its size', async () => {
          await focusTerminal(page);
          await page.keyboard.type('x');
          await page.waitForFunction(() => (window as any).paletteFixture.inputs.length === 1);
          const before = await fixture(page); const rect = await hostRect(page);
          await openPalette(page);
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('command-palette-search')), true);
          assert.deepEqual(await hostRect(page), rect, 'opening the palette keeps the terminal host');
          const input = page.locator('.command-palette-search');
          assert.equal(await input.getAttribute('role'), 'combobox');
          assert.deepEqual(await page.locator('.command-palette-heading').allTextContents(), ['Sesiones', 'Proyectos', 'Acciones']);
          assert.equal(await page.locator('.command-palette [role="group"]').first().getAttribute('aria-labelledby') !== null, true);
          await page.keyboard.type('ñandú zeta 123 ✓');
          for (const key of ['Backspace', 'ArrowDown', 'ArrowUp', 'Tab', 'Shift+Tab', 'Control+c', 'Meta+n', 'Meta+k', 'Meta+i', 'Meta+,', 'Enter', 'Space']) await page.keyboard.press(key);
          assert.equal(await paletteOpen(page), true, 'still open: nothing matched, Enter did nothing');
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('command-palette-search')), true, 'Tab stays in the field of the modal');
          assert.equal(await page.locator('dialog[open]:not(.command-palette)').count(), 0, 'global shortcuts are ignored while the palette is open');
          assert.equal(await page.locator('#inspector').count(), 0, 'the Información panel is retired; ⌘I opens nothing');
          await page.waitForTimeout(300);
          assert.deepEqual(await hostRect(page), rect);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await inTerminal(page), true, 'Escape returns focus to the terminal');
          await page.waitForTimeout(300);
          const after = await fixture(page);
          assert.equal(after.inputs, before.inputs, 'no key typed in the palette, nor the chord, reached the PTY');
          assert.equal(after.resizes, before.resizes, 'no resize was emitted');
          assert.deepEqual(await hostRect(page), rect);
          await page.keyboard.type('y');
          await page.waitForFunction(n => (window as any).paletteFixture.inputs.length === n + 1, before.inputs);
          assert.equal(await page.evaluate(() => (window as any).paletteFixture.inputs.at(-1).data), 'y', 'the terminal receives keys again after closing');
          // On macOS Ctrl+Shift+P is left to the terminal; only ⌘⇧P opens the palette.
          await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(100);
          assert.equal(await paletteOpen(page), false);
        });

        await t.test('a held ⌘⇧P (key repeat) keeps the palette open; nothing reaches the PTY', async () => {
          const before = await fixture(page);
          await focusTerminal(page);
          await page.keyboard.down('Meta'); await page.keyboard.down('Shift');
          for (let i = 0; i < 4; i++) await page.keyboard.down('KeyP');
          assert.equal(await page.evaluate(() => (window as any).lastPaletteRepeat), true, 'the harness sent repeated keydowns');
          await page.keyboard.up('KeyP'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
          assert.equal(await paletteOpen(page), true, 'key repeat does not toggle it closed');
          await page.keyboard.type('x'); await page.waitForTimeout(300);
          assert.equal(await page.locator('.command-palette-search').inputValue(), 'x', 'typing after the repeat stays in the palette');
          assert.equal((await fixture(page)).inputs, before.inputs, 'no key reached the PTY');
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await inTerminal(page), true);
        });

        await t.test('the empty palette lists sessions with state, projects and actions with hints; arrows, Home/End and live count', async () => {
          await focusTerminal(page); await openPalette(page);
          assert.match(await page.locator('.command-palette [role="status"]').textContent() ?? '', /^\d+ resultados$/);
          const live = option(page, 'session:live');
          assert.equal(await live.locator('.agent-indicator').count(), 1, 'sessions carry their state indicator');
          assert.equal(await live.locator('.command-palette-detail').textContent(), 'Integrar Pulso en Jauría', 'and their Pulso project');
          assert.equal(await option(page, 'session:closed').count(), 0, 'closed sessions stay in Historial');
          assert.equal(await option(page, 'board:plan').count(), 1); assert.equal(await option(page, 'board:').count(), 1, 'Pendientes is listed');
          assert.equal(await option(page, 'action:settings').locator('kbd').textContent(), '⌘,');
          assert.equal(await option(page, 'action:new-session').locator('kbd').textContent(), '⌘N');
          await page.keyboard.press('End'); assert.equal(await activeId(page), 'action:stop');
          await page.keyboard.press('Home'); assert.equal(await activeId(page), 'session:other', '1.4.0: most recent session first');
          await page.keyboard.press('ArrowUp'); assert.equal(await activeId(page), 'action:stop', 'wraps around');
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
        });

        await t.test('Enter on a session selects it in the focused pane', async () => {
          await focusTerminal(page); await openPalette(page);
          await page.keyboard.type('otra sesion');
          assert.equal(await activeId(page), 'session:other');
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-0')?.dataset.sessionId === 'other');
          assert.equal(await paletteOpen(page), false);
          await page.waitForFunction(() => !!document.activeElement?.closest('.pane:nth-child(1) .terminal-view'));
          // Back to the first session for the next checks.
          await openPalette(page); await page.keyboard.type('viva'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-0')?.dataset.sessionId === 'live');
        });

        await t.test('a disabled action is listed with its reason and does not run', async () => {
          await focusTerminal(page); await openPalette(page);
          await page.keyboard.type('nueva sesion');
          const row = option(page, 'action:new-session');
          assert.equal(await row.getAttribute('aria-disabled'), 'true');
          assert.equal(await row.locator('.command-palette-detail').textContent(), 'Sin plazas libres (2 de 2)');
          assert.equal(await activeId(page), 'action:new-session', 'reachable so its reason is read');
          await page.keyboard.press('Enter'); await row.click({ force: true });
          await page.waitForTimeout(200);
          assert.equal(await paletteOpen(page), true, 'a disabled entry keeps the palette open');
          assert.equal(await page.locator('#new-session-dialog').evaluate(d => (d as HTMLDialogElement).open), false);
          assert.match(await page.locator('.command-palette [role="status"]').textContent() ?? '', /no disponible\. Sin plazas libres/);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await inTerminal(page), true);
        });

        await t.test('Terminar reaches the existing confirmation; cancel sends no stop; Interrumpir only focuses its control', async () => {
          await focusTerminal(page); await openPalette(page);
          await page.keyboard.type('terminar');
          assert.equal(await activeId(page), 'action:stop');
          await page.keyboard.press('Enter');
          await page.locator('#stop-session-dialog[open]').waitFor();
          assert.match(await page.locator('#stop-session-description').textContent() ?? '', /Sesión viva sintética/);
          await page.locator('#cancel-stop').click();
          await page.waitForTimeout(200);
          assert.equal((await fixture(page)).calls.includes('stop'), false, 'cancel sends nothing');
          assert.equal(await inTerminal(page), true);
          await openPalette(page); await page.keyboard.type('interrumpir'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.activeElement?.matches('.pane:nth-child(1) [data-action="interrupt"]'));
          await page.waitForTimeout(200);
          assert.equal((await fixture(page)).calls.includes('interrupt'), false, 'Ctrl-C is not sent until the control is pressed');
        });

        await t.test('the palette never opens over a modal dialog; a popover closes first', async () => {
          await focusTerminal(page); await openPalette(page);
          await page.keyboard.type('cambiar nombre'); await page.keyboard.press('Enter');
          await page.locator('#rename-session-dialog[open]').waitFor();
          await page.keyboard.press('Meta+Shift+P'); await page.waitForTimeout(150);
          assert.equal(await paletteOpen(page), false, 'not over a modal');
          assert.equal(await page.locator('#rename-session-input').inputValue(), 'Sesión viva sintética', 'the chord typed nothing into the field');
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#rename-session-dialog[open]'));
          assert.equal(await inTerminal(page), true, 'rename returns focus to the terminal');
          // The session picker swallows its keys; the palette chord still closes it and opens.
          await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor();
          await openPalette(page);
          assert.equal(await page.locator('.pane:nth-child(1) .session-picker').isHidden(), true, 'the picker closed first');
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'session-0', 'focus returns to the picker button, not body');
          // A click outside closes it too.
          await focusTerminal(page); await openPalette(page);
          await page.mouse.click(8, 790);
          await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
        });

        await t.test('the top-bar button opens it with the shortcut as hint and keeps the terminal focus to return to', async () => {
          const button = page.locator('#open-command-palette');
          assert.equal(await button.getAttribute('aria-keyshortcuts'), 'Meta+Shift+P');
          assert.match(await button.getAttribute('title') ?? '', /⌘⇧P/);
          await focusTerminal(page); await button.click();
          await page.locator('dialog.command-palette[open]').waitFor();
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await inTerminal(page), true);
        });

        await t.test('⌘K keeps filtering the agent list, from the terminal too', async () => {
          const before = (await fixture(page)).inputs;
          await focusTerminal(page); await page.keyboard.press('Meta+k');
          await page.waitForFunction(() => document.activeElement?.id === 'session-search');
          assert.equal(await paletteOpen(page), false);
          await page.keyboard.press('Escape');
          assert.equal((await fixture(page)).inputs, before);
        });

        await t.test('repeated status refreshes with the palette open change nothing in its DOM or live region', async () => {
          await focusTerminal(page); await openPalette(page); await page.waitForTimeout(150);
          await page.evaluate(() => {
            const w = window as any; w.paletteMutations = { status: 0, list: 0 };
            new MutationObserver(r => { w.paletteMutations.status += r.length; }).observe(document.querySelector('.command-palette [role="status"]')!, { childList: true, characterData: true, subtree: true });
            new MutationObserver(r => { w.paletteMutations.list += r.length; }).observe(document.querySelector('.command-palette-list')!, { childList: true, attributes: true, characterData: true, subtree: true });
            w.statusBefore = w.paletteFixture.calls.filter((c: string) => c === 'status').length;
          });
          await page.waitForFunction(() => { const w = window as any; return w.paletteFixture.calls.filter((c: string) => c === 'status').length >= w.statusBefore + 3; }, undefined, { timeout: 8000 });
          assert.deepEqual(await page.evaluate(() => (window as any).paletteMutations), { status: 0, list: 0 }, 'three unchanged status cycles: no mutation');
          // A disabled entry's reason is not overwritten by the next refresh.
          await page.keyboard.type('nueva sesion'); await page.keyboard.press('Enter');
          const reason = await page.locator('.command-palette [role="status"]').textContent();
          assert.match(reason ?? '', /no disponible/);
          await page.waitForFunction(() => { const w = window as any; return w.paletteFixture.calls.filter((c: string) => c === 'status').length >= w.statusBefore + 5; }, undefined, { timeout: 8000 });
          assert.equal(await page.locator('.command-palette [role="status"]').textContent(), reason);
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
        });

        await t.test('Unificar from the palette with the second pane focused keeps the keyboard on the visible terminal', async () => {
          await openPalette(page); await page.keyboard.type('dividir'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('#panes')?.getAttribute('data-split') === 'true' && !!document.querySelector('.pane:nth-child(2) .xterm-helper-textarea'));
          await page.locator('.pane:nth-child(2) .xterm-helper-textarea').focus();
          const second = await page.evaluate(() => document.querySelector<HTMLElement>('#session-1')!.dataset.sessionId);
          await openPalette(page); await page.keyboard.type('unificar'); assert.equal(await activeId(page), 'action:split'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('#panes')?.getAttribute('data-split') === 'false');
          assert.equal(await inTerminal(page), true, 'focus is on the remaining terminal, not body');
          const before = (await fixture(page)).inputs;
          await page.keyboard.type('u');
          await page.waitForFunction(n => (window as any).paletteFixture.inputs.length === n + 1, before);
          const sent = await page.evaluate(() => (window as any).paletteFixture.inputs.at(-1));
          assert.equal(sent.data, 'u'); assert.equal(sent.id, second, 'the key reaches the session now visible');
          // Back to the first session for the remaining checks.
          await openPalette(page); await page.keyboard.type('viva'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-0')?.dataset.sessionId === 'live');
        });

        await t.test('at 760 px, opening from the overlay sidebar returns focus to the terminal', async () => {
          await page.setViewportSize({ width: 760, height: 560 }); await page.waitForTimeout(250);
          await page.locator('#toggle-sidebar').click(); await page.waitForTimeout(250);
          await page.locator('#session-list .session-item').first().focus();
          await openPalette(page);
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await inTerminal(page), true, 'the overlay closed, so focus falls back to the focused pane');
          await page.setViewportSize({ width: 1220, height: 800 }); await page.waitForTimeout(250);
        });

        await t.test('Pulso draft guard: a failed save keeps the board when navigating from the palette', async () => {
          const inputs = (await fixture(page)).inputs;
          await focusTerminal(page); await openPalette(page);
          await page.keyboard.type('integrar'); assert.equal(await activeId(page), 'board:plan'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('.pulso-board')?.getAttribute('data-project-id') === 'plan' && !!document.querySelector('.pulso-card-menu'));
          // Opened from the card's move menu: the menu closes first and Escape returns to its "…" button.
          const mover = page.getByRole('button', { name: 'Mover Validar la paleta sintética', exact: true });
          await mover.click(); await page.getByRole('menuitem', { name: 'Mover a En espera', exact: true }).focus();
          await openPalette(page);
          assert.equal(await page.getByRole('menuitem').count(), 0, 'the move menu closed before the palette opened');
          await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
          assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Mover Validar la paleta sintética', 'focus returns to the menu button');
          await page.evaluate(() => { (window as any).paletteFixture.failMoves = true; });
          await mover.click();
          await page.getByRole('menuitem', { name: 'Mover a En espera', exact: true }).click();
          await page.getByRole('button', { name: 'Liberar borrador', exact: true }).waitFor();
          // Pulso entries use the same state as the disabled tabs and "+": listed, disabled, with the reason.
          for (const [query, id] of [['pendientes', 'board:'], ['volver', 'action:pulso'], ['nuevo proyecto', 'action:new-project'], ['validar', 'phase:phase']]) {
            await openPalette(page); await page.keyboard.type(query); assert.equal(await activeId(page), id, query);
            assert.equal(await option(page, id).getAttribute('aria-disabled'), 'true', `${query}: disabled`);
            assert.equal(await option(page, id).locator('.command-palette-detail').textContent(), 'Guarda o descarta el borrador de Pulso');
            await page.keyboard.press('Enter'); await page.waitForTimeout(150);
            assert.equal(await paletteOpen(page), true, `${query}: does not run`);
            await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
            assert.equal(await page.locator('.pulso-board').getAttribute('data-project-id'), 'plan', `${query}: the board stays`);
            assert.equal(await page.locator('dialog.pulso-drawer[open]').count(), 0);
          }
          // Leaving Pulso for a session keeps the same guard and says why.
          await openPalette(page); await page.keyboard.type('otra sesion'); assert.equal(await activeId(page), 'session:other'); await page.keyboard.press('Enter');
          await page.waitForTimeout(250);
          assert.equal(await page.locator('#pulso-panel-host').isVisible(), true, 'Pulso stays');
          assert.match(await page.locator('#notice-text').textContent() ?? '', /borrador de Pulso/);
          await page.getByRole('button', { name: 'Liberar borrador', exact: true }).click();
          await openPalette(page); await page.keyboard.type('pendientes'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('.pulso-board')?.getAttribute('data-project-id') === '');
          await openPalette(page); await page.keyboard.type('volver'); await page.keyboard.press('Enter');
          await page.waitForFunction(() => (document.querySelector('#pulso-panel-host') as HTMLElement).hidden);
          await page.waitForFunction(() => !!document.activeElement?.closest('.pane:nth-child(1) .terminal-view'), undefined, { timeout: 2000 });
          assert.equal((await fixture(page)).inputs, inputs, 'navigating Pulso from the palette sent nothing to the PTY');
        });

        await t.test('a held ⌘⇧P over a Codex conversation field types nothing into it', async () => {
          const codex = await browser.newPage({ viewport: { width: 1220, height: 800 } });
          try {
            await install(codex, { codex: true }); await ready(codex);
            await codex.locator('#session-list .session-item[data-session-id="chat"]').click();
            const field = codex.locator('.pane:nth-child(1) .codex-host textarea');
            await field.waitFor(); await field.focus(); await codex.keyboard.type('a');
            assert.equal(await field.inputValue(), 'a');
            await codex.keyboard.down('Meta'); await codex.keyboard.down('Shift');
            for (let i = 0; i < 4; i++) await codex.keyboard.down('KeyP');
            await codex.keyboard.up('KeyP'); await codex.keyboard.up('Shift'); await codex.keyboard.up('Meta');
            assert.equal(await paletteOpen(codex), true, 'key repeat keeps it open');
            await codex.keyboard.type('zz'); await codex.keyboard.press('Escape');
            await codex.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
            assert.equal(await field.inputValue(), 'a', 'nothing typed in the palette reached the Codex field');
            assert.equal(await codex.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'focus returns to the Codex field');
            const calls = await codex.evaluate(() => (window as any).paletteFixture.calls as string[]);
            assert.equal(calls.some(op => op === 'input' || op.startsWith('codex_turn') || op.startsWith('codex_command')), false);
          } finally { await codex.close(); }
        });

        const shots = process.env.PALETTE_SCREENSHOT_DIR;
        if (shots) await t.test('review captures', async () => {
          await mkdir(shots, { recursive: true });
          await page.evaluate(() => { (window as any).paletteFixture.failMoves = false; (document.querySelector('#notice') as HTMLElement).hidden = true; });
          for (const theme of ['light', 'dark']) {
            await page.setViewportSize({ width: 1220, height: 800 });
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await focusTerminal(page); await openPalette(page); await page.waitForTimeout(150);
            await page.screenshot({ path: `${shots}/${engine.name()}-${theme}-1-vacia.png` });
            await page.keyboard.type('ses'); await page.waitForTimeout(100);
            await page.screenshot({ path: `${shots}/${engine.name()}-${theme}-2-busqueda.png` });
            await page.locator('.command-palette-search').fill(''); await page.keyboard.type('nueva');
            await page.waitForTimeout(100);
            await page.screenshot({ path: `${shots}/${engine.name()}-${theme}-3-deshabilitada.png` });
            await page.keyboard.press('Escape');
            await page.setViewportSize({ width: 760, height: 560 }); await page.waitForTimeout(300);
            await focusTerminal(page); await openPalette(page); await page.waitForTimeout(150);
            await page.screenshot({ path: `${shots}/${engine.name()}-${theme}-4-760.png` });
            await page.keyboard.press('Escape');
          }
          await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        });

        assert.deepEqual(errors, []);
      } finally { await page.close(); await browser.close(); }
    });
  }
} finally { await server.close(); }

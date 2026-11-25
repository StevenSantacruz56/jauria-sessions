/** 1.4 workbench chrome: pane menu, session picker keys, Pulso ⇄ Terminal and
 * the read-only history label. Real shell/CSS/xterm; synthetic Tauri boundary
 * only (no runner, providers or profiles). Run from desktop:
 * node --test tests/browser/workbench-chrome.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

type Fixture = { sessions?: 'none' | 'two' };
async function install(page: Page, options: Fixture = {}) {
  await page.addInitScript(options => {
    const w = window as any;
    const sessions = options.sessions === 'none' ? [] : [
      { id: 'live', title: 'Sesión viva sintética', kind: 'claude', cwd: '/synthetic/live', status: 'running', rows: 24, cols: 80 },
      { id: 'other', title: 'Otra sesión sintética', kind: 'codex', cwd: '/synthetic/other', status: 'running', rows: 24, cols: 80 },
      { id: 'closed', title: 'Historial sintético', kind: 'terminal', cwd: '/synthetic/closed', status: 'exited', rows: 24, cols: 80 },
    ];
    const calls: any[] = []; const resizes: any[] = []; const inputs: any[] = [];
    const status = () => structuredClone({ pid: 7, generation: 'chrome', pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true, normalTerminalVersion: 1,
      sessionRenameVersion: 1, sessions, lastSeq: 0 });
    w.chromeFixture = { calls, resizes, inputs, end(id: string) { sessions.find((s: any) => s.id === id)!.status = 'exited'; } };
    w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, async invoke(cmd: string, a: any) {
      if (cmd === 'connect_runner') return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: false };
      if (cmd === 'probe_tools') return [];
      if (cmd.startsWith('plugin:')) return cmd === 'plugin:event|listen' ? 1 : undefined;
      if (cmd === 'record_ui_evidence') return;
      if (cmd === 'pulso_request') {
        calls.push(a.op);
        if (a.op === 'revision') return { ok: true, result: { revision: 1 } };
        if (a.op === 'projects') return { ok: true, result: { projects: [], revision: 1, totalCount: 0, hasMore: false } };
        if (a.op === 'items') return { ok: true, result: { items: [], revision: 1, totalCount: 0, hasMore: false } };
        if (a.op === 'board') return { ok: true, result: { revision: 1, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(s => [s, { items: [], totalCount: 0, hasMore: false }])) } };
        return { ok: false, error: 'unexpected' };
      }
      if (cmd === 'runner_request') {
        calls.push(a.op);
        if (a.op === 'status') return { ok: true, result: status() };
        if (a.op === 'telemetry') return { ok: true, result: {} };
        if (a.op === 'events') return { ok: true, result: { events: [], lastSeq: 0, hasMore: false } };
        if (a.op === 'resize') { resizes.push(structuredClone(a.args)); return { ok: true, result: { cols: a.args.cols, rows: a.args.rows } }; }
        if (a.op === 'input') { inputs.push(structuredClone(a.args)); return { ok: true, result: {} }; }
      }
      throw new Error(`Unexpected synthetic RPC ${cmd}:${a?.op ?? ''}`);
    }, transformCallback() { return 1; }, unregisterCallback() {} };
  }, options);
}
async function ready(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
  await page.waitForTimeout(400);
}
const hostRect = (page: Page, pane = 1) => page.evaluate(pane => { const r = document.querySelector(`.pane:nth-child(${pane}) .terminal-host`)!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }, pane);
/** The element is visible and the topmost hit at its centre (not clipped or covered). */
async function clickable(page: Page, selector: string) {
  return page.evaluate(selector => {
    const node = document.querySelector<HTMLElement>(selector); if (!node) return 'missing';
    const r = node.getBoundingClientRect(); if (!r.width || !r.height) return 'empty box';
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === node || node.contains(hit) ? 'ok' : `covered by ${hit?.className || hit?.tagName}`;
  }, selector);
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: workbench chrome`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      try {
        await t.test('the pane "…" menu is not clipped: Terminar sesión reaches its confirmation and the terminal keeps its size', async () => {
          const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
          try {
            await install(page); await ready(page);
            const before = await hostRect(page); const resizes = await page.evaluate(() => (window as any).chromeFixture.resizes.length);
            await page.locator('.pane').first().locator('.pane-menu > summary').click();
            for (const action of ['rename', 'stop']) assert.equal(await clickable(page, `.pane:nth-child(1) .pane-menu [data-action="${action}"]`), 'ok', action);
            assert.deepEqual(await hostRect(page), before, 'opening the menu keeps the terminal host');
            await page.locator('.pane').first().getByRole('button', { name: 'Terminar sesión…', exact: true }).click();
            await page.locator('#stop-session-dialog[open]').waitFor();
            assert.match(await page.locator('#stop-session-description').textContent() ?? '', /Sesión viva sintética/);
            await page.locator('#cancel-stop').click();
            assert.equal(await page.evaluate(() => (window as any).chromeFixture.calls.includes('stop')), false, 'cancel sends nothing');
            await page.waitForTimeout(300);
            assert.equal(await page.evaluate(() => (window as any).chromeFixture.resizes.length), resizes);
          } finally { await page.close(); }
        });

        await t.test('session picker: Tab leaves naturally, Home/End move the active option only while the query is empty', async () => {
          const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
          try {
            await install(page); await ready(page);
            const active = () => page.evaluate(() => { const input = document.querySelector('.pane:nth-child(1) .session-picker-search')!; const id = input.getAttribute('aria-activedescendant'); return id ? document.getElementById(id)?.dataset.sessionId : null; });
            await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor();
            await page.keyboard.press('End'); assert.equal(await active(), ':new', 'End: last option (1.4.0: «Nueva sesión…»; a Terminada is never offered)');
            await page.keyboard.press('Home'); assert.equal(await active(), '', 'Home: first option (Sin sesión)');
            await page.keyboard.type('sint');
            const caret = () => page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart);
            // With text, Home/End are left to the field (not prevented); macOS WebKit does not move the caret on Home.
            await page.evaluate(() => { const w = window as any; w.homePrevented = null; document.addEventListener('keydown', e => { if (e.key === 'Home') setTimeout(() => { w.homePrevented = e.defaultPrevented; }); }, { once: true, capture: true }); });
            await page.keyboard.press('Home');
            await page.waitForFunction(() => (window as any).homePrevented !== null);
            assert.equal(await page.evaluate(() => (window as any).homePrevented), false, 'with text Home belongs to the field');
            if (engine === chromium) assert.equal(await caret(), 0, 'Chromium moves the caret to the start');
            assert.equal(await active(), 'other', 'active option unchanged by Home with text (the first match; 1.4.0: most recent first)');
            await page.keyboard.press('End'); if (engine === chromium) assert.equal(await caret(), 4);
            await page.keyboard.press('Tab');
            await page.waitForFunction(() => (document.querySelector('.pane:nth-child(1) .session-picker') as HTMLElement).hidden);
            assert.equal(await page.evaluate(() => document.activeElement?.closest('.pane:nth-child(1) .terminal-host') !== null), true, 'Tab moves on to the terminal');
            await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor();
            await page.keyboard.press('Shift+Tab');
            await page.waitForFunction(() => (document.querySelector('.pane:nth-child(1) .session-picker') as HTMLElement).hidden);
            assert.equal(await page.evaluate(() => document.activeElement?.matches('.pane:nth-child(1) .pane-menu > summary')), true, 'Shift+Tab moves back to the heading');
            assert.deepEqual(await page.evaluate(() => (window as any).chromeFixture.inputs), [], 'no key reached the PTY');
          } finally { await page.close(); }
        });

        // 1.4.0: a Terminada can no longer be chosen for a pane (it opens the Historial view);
        // the label is for a session that ends while on screen, which keeps its pane.
        await t.test('a session that ends on screen shows a visible fixed-height read-only label, also at 760 px; the picker never offers a Terminada', async () => {
          const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
          try {
            await install(page); await ready(page);
            const before = await hostRect(page);
            await page.locator('#session-0').click();
            assert.equal(await page.locator('.pane:nth-child(1) .session-picker [role="option"][data-session-id="closed"]').count(), 0);
            await page.keyboard.press('Escape');
            const shown = await page.evaluate(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId!);
            await page.evaluate(id => (window as any).chromeFixture.end(id), shown);
            const label = page.locator('.pane:nth-child(1) .history-banner');
            await label.waitFor({ state: 'visible' });
            assert.equal(await label.innerText(), 'Terminada · solo lectura');
            assert.deepEqual(await hostRect(page), before, 'the label does not resize the terminal host');
            await page.setViewportSize({ width: 760, height: 560 }); await page.waitForTimeout(300);
            assert.equal(await label.isVisible(), true); assert.equal(await label.innerText(), 'Solo lectura');
            assert.equal(await page.locator('.pane:nth-child(1) .pane-heading').evaluate(el => el.getBoundingClientRect().height), 32);
          } finally { await page.close(); }
        });

        await t.test('without sessions, Pulso returns to the terminal view; Escape on the board does not change views', async () => {
          const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
          try {
            await install(page, { sessions: 'none' }); await ready(page);
            await page.waitForFunction(() => !(document.querySelector('#open-pulso') as HTMLButtonElement).disabled);
            assert.equal(await page.locator('#welcome').isVisible(), true);
            await page.locator('#open-pulso').click();
            await page.locator('.pulso-board').waitFor();
            assert.equal(await page.locator('#open-pulso').getAttribute('aria-pressed'), 'true');
            await page.locator('.pulso-board').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
            assert.equal(await page.locator('#pulso-panel-host').isVisible(), true, 'Escape keeps Pulso');
            await page.getByRole('button', { name: 'Terminal', exact: true }).click();
            await page.locator('#welcome').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#pulso-panel-host').isVisible(), false);
            // The Pulso button toggles both ways.
            await page.locator('#open-pulso').click(); await page.locator('.pulso-board').waitFor();
            await page.locator('#open-pulso').click(); await page.locator('#welcome').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#open-pulso').getAttribute('aria-pressed'), 'false');
          } finally { await page.close(); }
        });
      } finally { await browser.close(); }
    });
  }
} finally { await server.close(); }

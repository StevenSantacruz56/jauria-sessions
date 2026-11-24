/** Session lifecycle (1.4.0). A pane is for working: its picker offers Abiertas
 * (with Sin confirmar), Interrumpidas that can be continued and «Nueva
 * sesión…», never a Terminada; Dividir only brings an Abierta. Every list is
 * most recent first. An Interrumpida shows a floating recovery (Continuar
 * conversación or Empezar de nuevo aquí, Ver salida, Descartar) that never
 * resizes the terminal; continuing puts the new session in the same pane,
 * inherits the Pulso links and writes nothing to the PTY. A Terminada is read
 * in the Historial view, entering and leaving it sends no `resize`.
 * Synthetic Tauri boundary; real shell and xterm. From desktop:
 * node --test tests/browser/session-lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady, type WorkbenchOptions } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

// Runner order is creation order: the most recent session is the last one.
const lifecycle: WorkbenchOptions = {
  open: 2, closed: 1, projects: 2, nativeResume: true, bindings: ['crash-claude'],
  sessions: [
    { id: 'crash-claude', title: 'Claude caída', kind: 'claude', cwd: '/synthetic/crash', status: 'interrupted', pid: 41 },
    { id: 'crash-codex', title: 'Codex caída', kind: 'codex', cwd: '/synthetic/codex', status: 'interrupted', pid: 42 },
    { id: 'custody', title: 'Custodia', kind: 'claude', cwd: '/synthetic/custody', status: 'needs_attention', pid: 43 },
    { id: 'old-stop', title: 'Detenida vieja', kind: 'terminal', cwd: '/synthetic/old', status: 'stopped' },
  ],
};
const paneSession = (page: Page, pane = 1) => page.evaluate(pane => (document.querySelector(`#session-${pane - 1}`) as HTMLElement).dataset.sessionId ?? '', pane);
const listIds = (page: Page, selector: string) => page.locator(selector).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.sessionId));
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('jauria:session-dismissed:/synthetic-profile') ?? 'null'));
/** Rule (1.4.0): a continuation counts once consecutive status reads see it running for about a second. */
async function confirmRunning(page: Page, id: string) {
  await page.evaluate(id => (window as any).workbench.setStatus(id, 'running'), id);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('jauria:session-dismissed:/synthetic-profile') ?? 'null') !== null, undefined, { timeout: 6000 });
}
const focusIn = (page: Page) => page.evaluate(() => {
  const a = document.activeElement; if (!a || a === document.body) return 'body';
  return a.id || (a as HTMLElement).dataset.recovery || a.className;
});

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: session lifecycle`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function open(options: WorkbenchOptions = lifecycle, width = 1220) {
        const page = await browser.newPage({ viewport: { width, height: 800 } }); t.after(() => page.close());
        await installWorkbench(page, options); await workbenchReady(page, url); return page;
      }

      await t.test('the picker offers Abiertas (Sin confirmar marked), continuable Interrumpidas and «Nueva sesión…», most recent first; never a Terminada', async () => {
        const page = await open();
        assert.equal(await paneSession(page), 'open-0', 'the first Abierta opens first, as before 1.4.0');
        await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor();
        const rows = await page.locator('.pane:nth-child(1) .session-picker-option').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.sessionId));
        assert.deepEqual(rows, ['', 'custody', 'open-1', 'open-0', 'crash-claude', ':new']);
        const groups = await page.locator('.pane:nth-child(1) .session-picker-group').allTextContents();
        assert.deepEqual(groups, ['Abiertas', 'Interrumpidas · se pueden continuar']);
        assert.match(await page.locator('.pane:nth-child(1) [data-session-id="custody"] .session-picker-detail').textContent() ?? '', /Sin confirmar — ocupa plaza/);
        // Search keeps «Nueva sesión…» as the way out.
        await page.keyboard.type('nada coincide');
        assert.deepEqual(await page.locator('.pane:nth-child(1) .session-picker-option').evaluateAll(n => n.map(x => (x as HTMLElement).dataset.sessionId)), [':new']);
        await page.locator('.pane:nth-child(1) [data-session-id=":new"]').click();
        await page.locator('#new-session-dialog[open]').waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await focusIn(page), 'session-0', 'cancelling returns to the pane trigger, never body');
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.inputs), [], 'no key reached the PTY');
      });

      await t.test('Dividir brings the most recent other Abierta; with none the second pane stays empty', async () => {
        const page = await open({ ...lifecycle, open: 3 });
        assert.equal(await paneSession(page), 'open-0');
        await page.locator('#toggle-split').click(); await page.waitForTimeout(300);
        assert.equal(await paneSession(page, 2), 'open-2', 'the most recent Abierta not in the other pane');
        const lone = await open({ ...lifecycle, open: 1 });
        await lone.locator('#toggle-split').click(); await lone.waitForTimeout(300);
        assert.equal(await paneSession(lone, 2), '', 'never an Interrumpida, Sin confirmar or Terminada');
        assert.equal(await lone.locator('.pane:nth-child(2) .empty').isVisible(), true);
      });

      await t.test('sidebar: Interrumpidas on top of Abiertas, Historial only Terminadas, both most recent first; Descartar is remembered', async () => {
        const page = await open();
        assert.equal(await page.locator('#session-list > section').first().getAttribute('data-lifecycle'), 'interrupted');
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['crash-codex', 'crash-claude']);
        assert.equal(await page.locator('#session-list .session-item[data-session-id="custody"]').count(), 1, 'Sin confirmar is an Abierta');
        await page.locator('button[data-filter="closed"]').click();
        assert.deepEqual(await listIds(page, '#session-list .session-item'), ['old-stop', 'closed-0']);
        await page.locator('button[data-filter="open"]').click();
        const dismiss = page.locator('.session-dismiss[data-session-id="crash-codex"]');
        assert.equal(await dismiss.getAttribute('title'), 'La pasa a Terminadas; no borra nada');
        await dismiss.click();
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['crash-claude']);
        assert.equal(await focusIn(page), 'quiet session-dismiss', 'focus stays on the next Descartar');
        assert.deepEqual(await stored(page), { schemaVersion: 1, sessions: [['crash-codex', null]] });
        await page.locator('button[data-filter="closed"]').click();
        assert.deepEqual(await listIds(page, '#session-list .session-item'), ['old-stop', 'crash-codex', 'closed-0']);
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(400);
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['crash-claude'], 'survives a reload');
      });

      await t.test('Interrumpida: the recovery floats over the pane, Ver salida folds it, Continuar conversación uses the same pane and writes nothing', async () => {
        const page = await open();
        const host = await rect(page, '.pane:nth-child(1) .terminal-host'); const resizes = await resizeCount(page);
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        assert.equal(await paneSession(page), 'crash-claude');
        const recovery = page.locator('.pane:nth-child(1) .pane-recovery');
        await recovery.waitFor();
        assert.equal(await recovery.locator('[data-recovery="primary"]').innerText(), 'Continuar conversación');
        assert.match(await recovery.innerText(), /El runner se reinició/);
        assert.equal(await focusIn(page), 'primary', 'the keyboard lands on the recovery, not on a dead terminal');
        await recovery.locator('[data-recovery="output"]').click();
        assert.equal(await recovery.getAttribute('data-folded'), 'true');
        assert.equal(await recovery.locator('[data-recovery="expand"]').isVisible(), true);
        await page.waitForTimeout(300);
        assert.deepEqual(await rect(page, '.pane:nth-child(1) .terminal-host'), host, 'the overlay never changes the terminal');
        assert.equal(await resizeCount(page), resizes, 'no resize from showing or folding it');
        await recovery.locator('[data-recovery="primary"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        const next = await paneSession(page);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.native.filter((c: any) => c[0] === 'resume_native').map((c: any) => c[1])), ['crash-claude']);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.inputs), [], 'nothing is pasted or sent');
        assert.equal(await stored(page), null, 'not marked while the new session is only starting');
        await confirmRunning(page, next);
        assert.deepEqual(await stored(page), { schemaVersion: 1, sessions: [['crash-claude', next]] }, 'the original is marked continued');
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['crash-codex']);
        await page.locator('button[data-filter="closed"]').click();
        assert.equal(await page.locator('#session-list .session-item[data-session-id="crash-claude"]').count(), 1, 'continued: Terminada');
      });

      await t.test('no free slot: Continuar conversación says why and starts nothing', async () => {
        const page = await open({ ...lifecycle, limit: 2 });
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('error'));
        assert.match(await page.locator('#notice-text').innerText(), /límite de 2 sesiones/);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.native.filter((c: any) => c[0] === 'resume_native')), []);
        assert.equal(await paneSession(page), 'crash-claude');
      });

      await t.test('Codex in a terminal: Empezar de nuevo aquí opens Nueva sesión prefilled; Descartar leaves the pane', async () => {
        const page = await open();
        await page.locator('#session-list .session-item[data-session-id="crash-codex"]').click();
        const recovery = page.locator('.pane:nth-child(1) .pane-recovery');
        assert.equal(await recovery.locator('[data-recovery="primary"]').innerText(), 'Empezar de nuevo aquí');
        assert.match(await recovery.innerText(), /Codex en terminal no permite continuar la conversación/);
        await recovery.locator('[data-recovery="primary"]').click();
        await page.locator('#new-session-dialog[open]').waitFor();
        assert.equal(await page.locator('#session-title').inputValue(), 'Codex caída');
        assert.equal(await page.locator('input[name=provider][value=codex]').isChecked(), true);
        assert.equal(await page.locator('#session-folder').inputValue(), '/synthetic/codex');
        await page.locator('#cancel-session').click();
        await recovery.locator('[data-recovery="dismiss"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId !== 'crash-codex');
        assert.match(await page.locator('#notice-text').innerText(), /pasó a Terminadas.*no se borró nada/);
        assert.notEqual(await focusIn(page), 'body');
      });

      await t.test('continuing inherits the Pulso project and phase links of the original, with a visible notice', async () => {
        const page = await open({ ...lifecycle, pulsoLinks: [{ sessionId: 'crash-claude', projectId: 'p0', via: 'project' }, { sessionId: 'crash-claude', projectId: 'p1', via: 'item' }],
          boardItems: [{ id: 'item-7', projectId: 'p1', title: 'Fase sintética', status: 'doing', session: { id: 'crash-claude', source: 'link' }, checkpointCount: 0 }] });
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        const next = await paneSession(page);
        await page.waitForTimeout(1500);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.links), [], 'no link before the new session is confirmed running');
        await confirmRunning(page, next);
        await page.waitForFunction(() => (window as any).workbench.links.length === 2);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.links), [
          { projectId: 'p0', sessionId: next, requestId: `resume-link-${next}-project-p0` },
          { itemId: 'item-7', sessionId: next, requestId: `resume-link-${next}-item-item-7` },
        ]);
        await page.waitForFunction(() => /vinculada en Pulso como la original/.test(document.querySelector('#notice-text')?.textContent ?? ''));
        assert.match(await page.locator('#notice-text').innerText(), /Proyecto sintético 1.*una fase de «Proyecto sintético 2»/);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.inputs), []);
      });

      await t.test('a continuation that fails to start is never accepted: the original stays, a retry is a new request (Codex ronda 2, 1)', async () => {
        const page = await open();
        await page.evaluate(() => (window as any).workbench.resumeMode('failed'));
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('error'));
        assert.match(await page.locator('#notice-text').innerText(), /no llegó a arrancar.*sigue en Interrumpidas/);
        assert.equal(await paneSession(page), 'crash-claude', 'the pane keeps the original');
        assert.equal(await stored(page), null, 'the original is not marked continued');
        await page.evaluate(() => (window as any).workbench.resumeMode('ok'));
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => (window as any).workbench.native.filter((c: any) => c[0] === 'resume_native').length === 2);
        const ids = await page.evaluate(() => (window as any).workbench.native.filter((c: any) => c[0] === 'resume_native').map((c: any) => c[2]));
        assert.notEqual(ids[0], ids[1], 'the retry asks for a new session, not the failed row');
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
      });

      await t.test('a continuation that ends right after starting is not marked nor linked; the original stays in Interrumpidas (Codex ronda 2, 3)', async () => {
        const page = await open({ ...lifecycle, pulsoLinks: [{ sessionId: 'crash-claude', projectId: 'p0', via: 'project' }] });
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        const next = await paneSession(page);
        await page.evaluate(id => (window as any).workbench.setStatus(id, 'running'), next);
        await page.waitForTimeout(1100);
        await page.evaluate(id => (window as any).workbench.setStatus(id, 'exited'), next);
        await page.waitForFunction(() => /terminó al arrancar/.test(document.querySelector('#notice-text')?.textContent ?? ''), undefined, { timeout: 6000 });
        assert.equal(await stored(page), null);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.links), []);
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['crash-codex', 'crash-claude']);
      });

      await t.test('Pulso inheritance is honest: a summary with more projects and a link that fails are named (Codex ronda 2, 2)', async () => {
        const page = await open({ ...lifecycle, summaryHasMore: true });
        await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await page.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        await confirmRunning(page, await paneSession(page));
        await page.waitForFunction(() => /No se pudo comprobar el vínculo de Pulso en todos los proyectos/.test(document.querySelector('#notice-text')?.textContent ?? ''));
        const other = await open({ ...lifecycle, failLinks: ['p1'], pulsoLinks: [{ sessionId: 'crash-claude', projectId: 'p0', via: 'project' }, { sessionId: 'crash-claude', projectId: 'p1', via: 'project' }] });
        await other.locator('#session-list .session-item[data-session-id="crash-claude"]').click();
        await other.locator('.pane:nth-child(1) [data-recovery="primary"]').click();
        await other.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        await confirmRunning(other, await paneSession(other));
        await other.waitForFunction(() => /no se pudo vincular/i.test(document.querySelector('#notice-text')?.textContent ?? ''));
        const text = await other.locator('#notice-text').innerText();
        assert.match(text, /Proyecto sintético 1/); assert.match(text, /no se pudo vincular.*Proyecto sintético 2/i);
        assert.equal(await other.evaluate(() => (window as any).workbench.links.length), 1);
      });

      await t.test('a terminal under its recovery or its open picker is not attended (Codex ronda 2, 4)', async () => {
        const page = await open({ open: 2, closed: 0, projects: 1 });
        await page.locator('.pane:nth-child(1) .xterm').click();
        // The picker of the focused pane covers the terminal: a BEL there is a new alert.
        await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor();
        await page.evaluate(() => (window as any).workbench.out('open-0', '\u0007'));
        await page.waitForFunction(() => document.querySelector('#session-alerts')?.getAttribute('data-unread') === '1', undefined, { timeout: 4000 });
        await page.keyboard.press('Escape');
        // The recovery overlay covers it too: the process end stays an alert, not consumed by looking.
        const second = await open({ open: 2, closed: 0, projects: 1 });
        await second.locator('.pane:nth-child(1) .xterm').click();
        await second.evaluate(() => (window as any).workbench.setStatus('open-0', 'failed'));
        await second.locator('.pane:nth-child(1) .pane-recovery').waitFor();
        await second.waitForTimeout(1500);
        assert.match(await second.locator('.session-item[data-session-id="open-0"] .session-item-meta').textContent() ?? '', /El proceso terminó/);
      });

      await t.test('a Terminada opens the Historial view: search, copy, back; zero resize entering and leaving', async () => {
        const page = await open({ ...lifecycle, open: 2 });
        await page.locator('#toggle-split').click(); await page.waitForTimeout(400);
        await page.evaluate(() => { const w = (window as any).workbench; w.out('closed-0', 'primera aguja\r\nnada\r\nsegunda AGUJA\r\n'); });
        await page.waitForTimeout(400);
        const panesBefore = [await rect(page, '.pane:nth-child(1) .terminal-host'), await rect(page, '.pane:nth-child(2) .terminal-host')];
        const ids = [await paneSession(page, 1), await paneSession(page, 2)];
        const resizes = await resizeCount(page);
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list .session-item[data-session-id="closed-0"]').click();
        await page.locator('#history-view').waitFor();
        assert.equal(await page.locator('#panes').isVisible(), false);
        assert.equal(await page.locator('#history-title').innerText(), 'Historial 1');
        assert.match(await page.locator('#history-state').innerText(), /^Terminada · solo lectura/);
        assert.equal(await page.locator('#history-terminal .terminal-view').count(), 1);
        assert.deepEqual([await paneSession(page, 1), await paneSession(page, 2)], ids, 'never placed in a pane');
        assert.equal(await focusIn(page), 'history-back');
        await page.locator('#history-search').fill('aguja');
        assert.equal(await page.locator('#history-search-count').innerText(), '1 de 2');
        await page.locator('#history-search').press('Enter');
        assert.equal(await page.locator('#history-search-count').innerText(), '2 de 2');
        await page.evaluate(() => { (window as any).copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (v: string) => { (window as any).copied = v; return Promise.resolve(); } } }); });
        await page.locator('#history-copy').click();
        await page.waitForFunction(() => (window as any).copied);
        assert.match(await page.evaluate(() => (window as any).copied), /primera aguja\nnada\nsegunda AGUJA$/);
        assert.equal(await page.locator('#history-continue').isHidden(), true, 'a terminal has no conversation to continue');
        await page.locator('#history-back').click();
        await page.locator('#panes').waitFor();
        await page.waitForTimeout(400);
        assert.deepEqual([await rect(page, '.pane:nth-child(1) .terminal-host'), await rect(page, '.pane:nth-child(2) .terminal-host')], panesBefore, 'the panes come back as they were');
        assert.equal(await resizeCount(page), resizes, 'entering and leaving the view sends no resize');
        assert.notEqual(await focusIn(page), 'body');
        // Escape leaves too.
        await page.locator('#session-list .session-item[data-session-id="old-stop"]').click();
        await page.locator('#history-view').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('#panes').waitFor();
        await page.waitForTimeout(300);
        assert.equal(await resizeCount(page), resizes);
      });

      await t.test('back from Historial, a pane that showed the session (it ended on screen) shows it again (Codex ronda 2, 5)', async () => {
        const page = await open();
        await page.evaluate(() => (window as any).workbench.setStatus('open-0', 'exited'));
        await page.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'Terminada');
        const resizes = await resizeCount(page);
        await page.locator('#open-pulso').click(); await page.locator('#pulso-panel-host').waitFor();
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list .session-item[data-session-id="open-0"]').click();
        await page.locator('#history-view').waitFor();
        await page.locator('#history-back').click(); await page.locator('#panes').waitFor();
        assert.equal(await paneSession(page), 'open-0');
        await page.waitForTimeout(300);
        assert.equal(await resizeCount(page), resizes);
      });

      await t.test('a session that leaves status closes the Historial view with focus on a real control (Codex ronda 2, 8)', async () => {
        const page = await open();
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list .session-item[data-session-id="closed-0"]').click();
        await page.locator('#history-view').waitFor();
        assert.equal(await focusIn(page), 'history-back');
        await page.evaluate(() => (window as any).workbench.remove('closed-0'));
        await page.waitForFunction(() => (document.querySelector('#history-view') as HTMLElement).hidden, undefined, { timeout: 5000 });
        assert.notEqual(await focusIn(page), 'body');
      });

      await t.test('Historial says when the saved output is longer than what the view holds; the count tops at 1000+ (Codex ronda 2, 6)', async () => {
        const page = await open();
        await page.evaluate(() => { const lines = ['unicaprimera']; for (let i = 0; i < 8300; i++) lines.push(`linea ${i} x`); (window as any).workbench.out('closed-0', lines.join('\r\n') + '\r\n'); });
        await page.waitForTimeout(1500);
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list .session-item[data-session-id="closed-0"]').click();
        await page.locator('#history-view').waitFor();
        await page.locator('#history-trimmed').waitFor();
        assert.match(await page.locator('#history-trimmed').innerText(), /Se muestran las últimas \d[\d.]* líneas/);
        await page.locator('#history-search').fill('unicaprimera');
        assert.equal(await page.locator('#history-search-count').innerText(), 'Sin coincidencias en lo que se muestra');
        await page.locator('#history-search').fill('x');
        assert.match(await page.locator('#history-search-count').innerText(), /de 1000\+$/);
      });

      await t.test('a Claude ended with Terminar offers Continuar conversación as a secondary action in the Historial view', async () => {
        const page = await open({ ...lifecycle, bindings: ['stopped-claude'], sessions: [...lifecycle.sessions!, { id: 'stopped-claude', title: 'Claude terminada', kind: 'claude', cwd: '/synthetic/s', status: 'stopped', pid: 50 }] });
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list .session-item[data-session-id="stopped-claude"]').click();
        const resume = page.locator('#history-continue');
        await resume.waitFor();
        assert.equal(await resume.evaluate(n => n.classList.contains('secondary')), true, 'secondary, not the amber action');
        await resume.click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId?.startsWith('claude-'));
        assert.equal(await page.locator('#history-view').isVisible(), false);
        await confirmRunning(page, await paneSession(page));
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.inputs), []);
      });

      await t.test('an interruption is an alert until it is seen; then it leaves the bell and stays in Interrumpidas', async () => {
        const page = await open({ open: 2, closed: 0, projects: 1, nativeResume: true });
        await page.evaluate(() => (window as any).workbench.setStatus('open-1', 'interrupted'));
        await page.waitForFunction(() => document.querySelector('#session-alerts')?.getAttribute('data-unread') === '1');
        await page.locator('#session-list .session-item[data-session-id="open-1"]').click();
        await page.waitForFunction(() => (document.querySelector('#session-alerts') as HTMLElement).hidden);
        assert.deepEqual(await listIds(page, '.session-group-interrupted .session-item'), ['open-1']);
      });
    });
  }
} finally { await server.close(); }

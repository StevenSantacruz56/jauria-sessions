/** Ending a session (1.4.0). Terminar, confirmed by the person: the pane leaves
 * the ended session for the next open one not shown in the other pane (needs
 * you → finished unseen → working → most recently used) or the empty state;
 * its tab disappears and it stays in Historial (read only). An end nobody
 * asked for keeps the pane, labels it and offers Cerrar. An uncertain stop
 * says so instead of «Terminando…» forever. Synthetic Tauri boundary; real
 * shell and xterm. From desktop: node --test tests/browser/session-end.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const paneSession = (page: Page, pane = 1) => page.evaluate(pane => (document.querySelector(`#session-${pane - 1}`) as HTMLElement).dataset.sessionId ?? '', pane);
const tabs = (page: Page) => page.locator('#session-tabs .session-tab').evaluateAll(n => n.map(b => (b as HTMLElement).dataset.sessionId));
const focusIn = (page: Page) => page.evaluate(() => {
  const a = document.activeElement; if (!a || a === document.body) return 'body';
  const pane = a.closest('.pane'); return pane ? `pane:${(pane.querySelector('.pane-session-button') as HTMLElement).dataset.sessionId}` : a.id || a.className;
});
async function terminate(page: Page, pane = 1) {
  await page.locator(`.pane:nth-child(${pane}) .pane-menu > summary`).click();
  await page.locator(`.pane:nth-child(${pane}) [data-action="stop"]`).click();
  await page.locator('#stop-session-dialog[open]').waitFor();
  await page.locator('#confirm-stop').click();
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: ending sessions`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function open(openCount: number) {
        const page = await browser.newPage({ viewport: { width: 1220, height: 800 } }); t.after(() => page.close());
        await installWorkbench(page, { open: openCount, closed: 1, projects: 1 }); await workbenchReady(page, url); return page;
      }

      await t.test('Terminar with other open sessions: the pane moves to the priority one, the tab goes, focus follows, Historial keeps it', async () => {
        const page = await open(3);
        // open-2 needs you: it wins over the most recently used one.
        await page.evaluate(() => (window as any).workbench.out('open-2', '\u001b]7501;state=blocked\u0007'));
        await page.waitForFunction(() => document.querySelector('[data-session-id="open-2"].session-item')?.getAttribute('data-activity') === 'needs');
        assert.equal(await paneSession(page), 'open-0');
        await terminate(page);
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId === 'open-2');
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.native.filter((c: any) => c[0] === 'stop')), [['stop', 'open-0']]);
        assert.equal((await tabs(page)).includes('open-0'), false, 'the ended tab disappears');
        assert.equal(await focusIn(page), 'pane:open-2', 'focus goes to the terminal that comes in');
        assert.match(await page.locator('#notice-text').innerText(), /terminada.*Historial/);
        await page.locator('button[data-filter="closed"]').click();
        await page.locator('#session-list [data-session-id="open-0"]').click();
        // 1.4.0: a Terminada chosen from Historial opens the Historial view, never a pane.
        await page.locator('#history-view').waitFor();
        assert.match(await page.locator('#history-state').innerText(), /Terminada · solo lectura/);
        assert.equal(await paneSession(page), 'open-2', 'the pane keeps its working session');
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.inputs), []);
      });

      await t.test('Terminar the only open session: the empty state with Nueva sesión, focus on it', async () => {
        const page = await open(1);
        await terminate(page);
        await page.locator('#welcome').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.activeElement?.id === 'welcome-create', undefined, { timeout: 2000 });
        assert.equal(await focusIn(page), 'welcome-create');
        assert.deepEqual(await tabs(page), []);
      });

      await t.test('two panes: only the affected pane changes and the other terminal keeps its size', async () => {
        const page = await open(3);
        await page.locator('#toggle-split').click(); await page.waitForTimeout(500);
        const second = await paneSession(page, 2); const other = await rect(page, '.pane:nth-child(2) .terminal-host');
        const sentTo = (id: string) => page.evaluate(id => (window as any).workbench.resizes.filter((r: any) => r.id === id).length, id);
        const resizes = await sentTo(second);
        await terminate(page, 1);
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId !== 'open-0');
        const first = await paneSession(page, 1);
        assert.notEqual(first, second, 'never the session shown in the other pane');
        assert.equal(await paneSession(page, 2), second);
        assert.deepEqual(await rect(page, '.pane:nth-child(2) .terminal-host'), other);
        await page.waitForTimeout(300);
        assert.equal(await sentTo(second), resizes, 'the other terminal gets no resize');
      });

      await t.test('an end nobody asked for keeps the pane, labels it and offers Cerrar', async () => {
        const page = await open(2);
        await page.evaluate(() => (window as any).workbench.setStatus('open-0', 'exited'));
        await page.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'Terminada');
        assert.equal(await paneSession(page), 'open-0', 'the pane stays to read the last output');
        assert.equal(await page.locator('.pane:nth-child(1) .history-banner').isVisible(), true);
        const close = page.locator('.pane:nth-child(1) .pane-close');
        assert.equal(await close.isVisible(), true);
        await close.click();
        await page.waitForFunction(() => (document.querySelector('#session-0') as HTMLElement).dataset.sessionId === 'open-1');
        assert.equal(await focusIn(page), 'pane:open-1');
      });

      await t.test('an uncertain stop says so and offers Liberar plaza; a stop that never answers stops saying «Terminando…»', async () => {
        const page = await open(2);
        await page.evaluate(() => (window as any).workbench.stopMode('needs_attention'));
        await terminate(page);
        await page.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'No se pudo confirmar el cierre');
        assert.equal(await paneSession(page), 'open-0', 'an uncertain session stays');
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        assert.equal(await page.locator('.pane:nth-child(1) [data-action="release"]').isVisible(), true);
        await page.keyboard.press('Escape');
        const other = await open(2);
        await other.evaluate(() => (window as any).workbench.stopMode('hang'));
        await terminate(other);
        await other.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'Terminando…');
        await other.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'No se pudo confirmar el cierre', undefined, { timeout: 20000 });
        assert.equal(await other.locator('#notice').evaluate(n => n.classList.contains('error')), true);
      });

      await t.test('a rejected stop leaves the session open and usable, never «Terminando…» (Codex 1)', async () => {
        const page = await open(2);
        await page.evaluate(() => (window as any).workbench.stopMode('reject'));
        await terminate(page);
        await page.locator('#notice.error').waitFor();
        await page.waitForTimeout(300);
        assert.notEqual(await page.locator('.pane:nth-child(1) .session-state').textContent(), 'Terminando…');
        assert.equal(await page.evaluate(() => (document.querySelector('.pane:nth-child(1) .xterm') as any) && !(window as any).document.querySelector('.pane:nth-child(1) [data-action="stop"]').disabled), true, 'Terminar can be asked again');
        await page.locator('.pane:nth-child(1) .xterm').click(); await page.keyboard.type('x');
        await page.waitForFunction(() => (window as any).workbench.inputs.length > 0);
      });

      await t.test('an unanswered stop keeps one barrier: no second stop while the first is pending (Codex 3)', async () => {
        const page = await open(2);
        await page.evaluate(() => (window as any).workbench.stopMode('hang'));
        await terminate(page);
        await page.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'No se pudo confirmar el cierre', undefined, { timeout: 20000 });
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        assert.equal(await page.locator('.pane:nth-child(1) [data-action="stop"]').isDisabled(), true, 'Terminar waits for the first answer');
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.native.filter((c: any) => c[0] === 'stop').length), 1);
      });
    });
  }
} finally { await server.close(); }

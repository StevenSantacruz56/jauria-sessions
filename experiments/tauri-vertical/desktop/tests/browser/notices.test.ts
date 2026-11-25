/** The floating notice (bottom right of the stage). Progress messages leave on
 * their own when what they announce ends, short confirmations after a few
 * seconds, errors stay until closed (button or Escape) and a new message
 * replaces the previous one. Opening a session shows no floating notice: the
 * pane heading says «Abriendo». Nothing resizes a terminal. Synthetic Tauri
 * boundary; real shell and xterm. From desktop:
 * node --test tests/browser/notices.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const noticeVisible = (page: Page) => page.locator('#notice').isVisible();
async function startSession(page: Page) {
  await page.locator('#new-session').click();
  await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement)?.value === '/synthetic-home');
  await page.locator('input[name=provider][value=terminal]').check();
  await page.locator('#start-session').click();
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: floating notice`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function open() {
        const page = await browser.newPage({ viewport: { width: 1220, height: 800 } }); t.after(() => page.close());
        await installWorkbench(page, { open: 1, closed: 0, projects: 1 }); await workbenchReady(page, url); return page;
      }

      await t.test('opening a session shows «Abriendo» in the pane heading, no floating notice; it is announced politely', async () => {
        const page = await open();
        await startSession(page);
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        assert.equal(await page.locator('.pane:nth-child(1) .session-state').innerText(), 'Abriendo');
        assert.equal(await noticeVisible(page), false, 'no floating notice over the terminal');
        assert.match(await page.locator('#app-announcer').textContent() ?? '', /Abriendo Terminal/);
        const id = await page.evaluate(() => (window as any).workbench.sessions.at(-1).id);
        await page.evaluate(id => { const w = (window as any).workbench; w.setStatus(id, 'running'); w.out(id, '$ '); }, id);
        await page.waitForFunction(() => document.querySelector('.pane:nth-child(1) .session-state')?.textContent === 'Abierta');
        assert.equal(await noticeVisible(page), false);
      });

      await t.test('the recovery notice leaves when the stored history ends on a terminal checkpoint (interrupted sessions after a runner restart)', async () => {
        // A `state` event carrying terminalStream is a checkpoint: it skips the per-event end-of-replay check.
        const page = await browser.newPage({ viewport: { width: 1220, height: 800 } }); t.after(() => page.close());
        const stream = { generation: 'previous-runner', history: { state: 'recording', durableFrame: 0, lastFrame: 0 } };
        await installWorkbench(page, { open: 0, closed: 0, projects: 1,
          sessions: [{ id: 'cut-0', title: 'Cortada', kind: 'terminal', cwd: '/synthetic/cut-0', status: 'exited', detail: { terminalStream: stream } }],
          history: [{ sessionId: 'cut-0', kind: 'output', data: btoa('$ ') },
            { sessionId: 'cut-0', kind: 'state', data: JSON.stringify({ id: 'cut-0', status: 'exited', terminalStream: stream }) }] });
        await workbenchReady(page, url);
        await page.waitForFunction(() => (document.querySelector('#workbench') as HTMLElement).dataset.renderedSeq === '2');
        await page.waitForFunction(() => (document.querySelector('#notice') as HTMLElement).hidden, null, { timeout: 3000 });
        assert.equal(await page.locator('#new-session').isDisabled(), false, 'controls come back with the end of the replay');
      });

      await t.test('an error stays until closed with its button or Escape; a new message replaces the previous one', async () => {
        const page = await open();
        await page.evaluate(() => (window as any).workbench.failStart());
        await startSession(page);
        await page.locator('#new-session-error').waitFor();
        await page.locator('#cancel-session').click();
        // Session start errors stay in the dialog; a pane action error uses the notice.
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        await page.locator('.pane:nth-child(1) [data-action="copy-id"]').evaluate((b: HTMLButtonElement) => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Portapapeles no disponible')) } }); b.click();
        });
        await page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('error'));
        await page.waitForTimeout(6000);
        assert.equal(await noticeVisible(page), true, 'an error does not leave on its own');
        assert.equal(await page.locator('#dismiss-notice').isVisible(), true);
        await page.locator('#notice-text').focus(); await page.keyboard.press('Escape');
        assert.equal(await noticeVisible(page), false, 'Escape closes it');
        // Replacement: a confirmation replaces an error; a second confirmation replaces the first.
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        await page.locator('.pane:nth-child(1) [data-action="copy-id"]').click();
        await page.waitForFunction(() => document.querySelector('#notice-text')?.textContent === 'Portapapeles no disponible' && document.querySelector('#notice')?.classList.contains('error'));
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        await page.locator('.pane:nth-child(1) [data-action="copy-id"]').click();
        await page.waitForFunction(() => document.querySelector('#notice-text')?.textContent === 'Identificador copiado.');
        assert.equal(await page.locator('#notice').evaluate(n => n.classList.contains('error')), false);
        assert.equal(await page.locator('#notice-text').count(), 1, 'messages never stack');
      });

      await t.test('keyboard: a pane menu action and the notice close button never leave focus on body (Codex 6, 8)', async () => {
        const page = await open();
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Portapapeles no disponible')) } }));
        await page.locator('.pane:nth-child(1) .pane-menu > summary').focus(); await page.keyboard.press('Enter');
        await page.locator('.pane:nth-child(1) [data-action="copy-id"]').focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('error'));
        assert.notEqual(await page.evaluate(() => document.activeElement === document.body), true, 'the menu action moves focus back to its trigger');
        assert.equal(await page.evaluate(() => document.activeElement?.closest('.pane-menu') !== null), true);
        await page.locator('#dismiss-notice').focus(); await page.keyboard.press('Enter');
        assert.equal(await noticeVisible(page), false);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), false, 'closing the notice with its button keeps a focus');
      });

      await t.test('a short confirmation leaves on its own after a few seconds and never resizes the terminal', async () => {
        const page = await open();
        const host = await rect(page, '.pane:nth-child(1) .terminal-host'); const resizes = await resizeCount(page);
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        await page.locator('.pane:nth-child(1) [data-action="copy-cwd"]').click();
        await page.waitForFunction(() => document.querySelector('#notice-text')?.textContent === 'Carpeta copiada.');
        assert.equal(await noticeVisible(page), true);
        await page.waitForFunction(() => (document.querySelector('#notice') as HTMLElement).hidden, undefined, { timeout: 8000 });
        assert.deepEqual(await rect(page, '.pane:nth-child(1) .terminal-host'), host);
        assert.equal(await resizeCount(page), resizes);
      });
    });
  }
} finally { await server.close(); }

/** One dismissal rule for every floating control: pane "…" menu, session
 * picker, alerts popover and the Pulso card menu. A press outside closes it
 * (a press on a terminal also focuses that terminal), Escape closes it and
 * returns focus to its trigger, Tab out closes it, opening another closes the
 * previous, choosing an option closes it, and none of this resizes a terminal
 * or sends keys to the PTY. Synthetic Tauri boundary; real shell and xterm.
 * From desktop: node --test tests/browser/floating-controls.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

type Floating = { name: string; open: (page: Page) => Promise<void>; isOpen: (page: Page) => Promise<boolean>; trigger: string };
const menuOpen = (pane: number) => (page: Page) => page.evaluate(pane => (document.querySelector(`.pane:nth-child(${pane}) .pane-menu`) as HTMLDetailsElement).open, pane);
const floats: Floating[] = [
  { name: 'pane "…" menu', trigger: '.pane:nth-child(1) .pane-menu > summary', isOpen: menuOpen(1),
    open: async page => { await page.locator('.pane:nth-child(1) .pane-menu > summary').click(); } },
  { name: 'session picker', trigger: '#session-0', isOpen: page => page.locator('.pane:nth-child(1) .session-picker').isVisible(),
    open: async page => { await page.locator('#session-0').click(); await page.locator('.pane:nth-child(1) .session-picker-search').waitFor(); } },
  { name: 'alerts popover', trigger: '#session-alerts', isOpen: page => page.locator('#attention-banner').isVisible(),
    open: async page => { await page.locator('#session-alerts').click(); await page.locator('#attention-banner').waitFor(); } },
];
const inTerminal = (page: Page, pane = 1) => page.evaluate(pane => !!document.activeElement?.closest(`.pane:nth-child(${pane}) .terminal-host`), pane);

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: floating controls close on outside interaction`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function page() {
        const p = await browser.newPage({ viewport: { width: 1220, height: 800 } }); t.after(() => p.close());
        await installWorkbench(p, { open: 3, closed: 1, projects: 2 }); await workbenchReady(p, url);
        // One alert keeps the bell visible; split shows a second pane (1.4.0: the most recent Abierta, open-2),
        // so the alert goes to open-1, which no pane shows.
        await p.evaluate(() => (window as any).workbench.out('open-1', '\u0007'));
        await p.waitForFunction(() => !document.querySelector<HTMLElement>('#session-alerts')!.hidden);
        await p.locator('#toggle-split').click(); await p.waitForTimeout(400);
        return p;
      }
      const outside: [string, string][] = [
        ['the terminal of the same pane', '.pane:nth-child(1) .terminal-host .xterm-screen'],
        ['the other pane', '.pane:nth-child(2) .terminal-host .xterm-screen'],
        ['the sidebar', '#sidebar-agents-heading'],
        ['the top bar', '.top-spacer'],
        ['the status bar', '.status-spacer'],
      ];
      for (const floating of floats) {
        await t.test(`${floating.name}: outside presses, Escape, Tab and geometry`, async () => {
          const p = await page();
          const hosts = () => Promise.all([rect(p, '.pane:nth-child(1) .terminal-host'), rect(p, '.pane:nth-child(2) .terminal-host')]);
          const before = await hosts(); const resizes = await resizeCount(p);
          for (const [where, selector] of outside) {
            await floating.open(p); assert.equal(await floating.isOpen(p), true, `${where}: opened`);
            const box = (await p.locator(selector).first().boundingBox())!;
            // Lower left of the target: clear of the picker and menus, which float at the top of a pane.
            await p.mouse.click(box.x + Math.min(40, box.width / 2), box.y + Math.max(box.height - 24, box.height / 2));
            await p.waitForTimeout(100);
            assert.equal(await floating.isOpen(p), false, `${where}: one press closes it`);
            if (where === 'the terminal of the same pane') assert.equal(await inTerminal(p, 1), true, 'the same press focuses the terminal');
            if (where === 'the other pane') assert.equal(await inTerminal(p, 2), true, 'the same press focuses the other terminal');
          }
          await floating.open(p); await p.keyboard.press('Escape'); await p.waitForTimeout(50);
          assert.equal(await floating.isOpen(p), false, 'Escape closes it');
          if (floating.name !== 'session picker') assert.equal(await p.evaluate(s => document.activeElement === document.querySelector(s), floating.trigger), true, 'Escape returns focus to the trigger');
          await floating.open(p);
          // Chromium walks the buttons with Tab; WebKit's Tab only stops at fields, so focus moves to the other terminal instead.
          if (engine === chromium) for (let i = 0; i < 8 && await floating.isOpen(p); i++) await p.keyboard.press('Tab');
          else await p.locator('.pane:nth-child(2) .xterm-helper-textarea').focus();
          await p.waitForTimeout(50);
          assert.equal(await floating.isOpen(p), false, 'focus leaving it closes it');
          await p.waitForTimeout(300);
          assert.deepEqual(await hosts(), before, 'opening and closing never resizes a terminal');
          assert.equal(await resizeCount(p), resizes);
          assert.deepEqual(await p.evaluate(() => (window as any).workbench.inputs), [], 'no key reached the PTY');
        });
      }

      await t.test('only one floating control is open at a time, also when opened with the keyboard', async () => {
        const p = await page();
        await floats[0].open(p);
        await p.locator('.pane:nth-child(2) .pane-menu > summary').click();
        assert.deepEqual([await menuOpen(1)(p), await menuOpen(2)(p)], [false, true], 'the other pane menu replaces it');
        await p.locator('#session-alerts').focus(); await p.keyboard.press('Enter'); await p.locator('#attention-banner').waitFor();
        assert.equal(await menuOpen(2)(p), false, 'opening the alerts popover closes the menu');
        await p.locator('#session-0').focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(100);
        assert.equal(await p.locator('#attention-banner').isVisible(), false, 'opening the picker closes the popover');
        await p.keyboard.press('Escape');
        await p.locator('.pane:nth-child(1) .pane-menu > summary').focus(); await p.keyboard.press('Enter');
        assert.equal(await menuOpen(1)(p), true);
        await p.keyboard.press('Meta+Shift+P'); await p.locator('dialog.command-palette[open]').waitFor();
        assert.equal(await menuOpen(1)(p), false, 'the palette closes it too');
        await p.keyboard.press('Escape');
      });

      await t.test('the last alert going away with focus inside the popover never leaves focus on body (Codex 7)', async () => {
        const p = await browser.newPage({ viewport: { width: 1220, height: 800 } }); t.after(() => p.close());
        await installWorkbench(p, { open: 2, closed: 0, projects: 1 }); await workbenchReady(p, url);
        await p.evaluate(() => (window as any).workbench.setStatus('open-1', 'needs_attention'));
        await p.waitForFunction(() => !document.querySelector<HTMLElement>('#session-alerts')!.hidden);
        await p.locator('#session-alerts').click(); await p.locator('#attention-banner').waitFor();
        await p.locator('#open-attention-session').focus();
        await p.evaluate(() => (window as any).workbench.setStatus('open-1', 'running'));
        await p.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')!.hidden);
        await p.waitForTimeout(100);
        assert.equal(await p.evaluate(() => document.activeElement === document.body || !document.activeElement), false);
      });

      await t.test('choosing a menu option closes the menu', async () => {
        const p = await page();
        await floats[0].open(p);
        await p.locator('.pane:nth-child(1) [data-action="rename"]').click();
        await p.locator('#rename-session-dialog[open]').waitFor();
        assert.equal(await menuOpen(1)(p), false);
        await p.keyboard.press('Escape');
      });
    });
  }
} finally { await server.close(); }

/** 1.4.0 sidebar: Proyectos and Agentes as two regions with their own scroll,
 * the split and width separators, folding, persistence per profile and the
 * terminal geometry rule (dragging the width sends at most one `resize`, on
 * release). Real shell, CSS and xterm; synthetic Tauri boundary only. From
 * desktop: node --test tests/browser/sidebar-layout.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, visibleAt, workbenchReady } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const many = { open: 40, closed: 60, projects: 12 };

const projectRowsVisible = (page: Page) => page.evaluate(() => {
  const list = document.querySelector('#sidebar-project-list')!.getBoundingClientRect();
  const sidebar = document.querySelector('#sidebar')!.getBoundingClientRect();
  return Array.from(document.querySelectorAll('#sidebar-project-list [data-board]')).filter(row => {
    const r = row.getBoundingClientRect(); return r.height >= 29 && r.top >= list.top - .5 && r.bottom <= list.bottom + .5 && r.bottom <= sidebar.bottom && r.bottom <= innerHeight;
  }).length;
});
const sidebarWidth = (page: Page) => page.evaluate(() => Math.round(document.querySelector('#sidebar')!.getBoundingClientRect().width));
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('jauria:sidebar-layout:/synthetic-profile'));
async function drag(page: Page, selector: string, dx: number, dy: number, steps = 12, during?: () => Promise<void>) {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + dx * i / steps, y + dy * i / steps); if (i === Math.floor(steps / 2)) await during?.(); }
  await page.mouse.up();
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: sidebar regions and separators`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      const open = async (width = 1220, height = 800, options = many) => {
        const page = await browser.newPage({ viewport: { width, height } }); t.after(() => page.close());
        await installWorkbench(page, options); await workbenchReady(page, url); return page;
      };

      await t.test('many sessions: Proyectos keeps its heading and two rows, each region scrolls on its own, the footer stays (1220×800 and 760×560)', async () => {
        for (const [width, height] of [[1220, 800], [760, 560]] as const) {
          const page = await open(width, height);
          if (width <= 860) { await page.locator('#toggle-sidebar').click(); await page.waitForTimeout(300); }
          for (const filter of ['open', 'closed']) {
            await page.locator(`button[data-filter="${filter}"]`).click(); await page.waitForTimeout(100);
            for (const selector of ['#sidebar-projects-heading', '#sidebar-agents-heading', 'button[data-filter="closed"]', '#open-settings', '#telemetry-host > summary'])
              assert.equal(await visibleAt(page, selector), 'ok', `${width}×${height} ${filter}: ${selector}`);
            assert.ok(await projectRowsVisible(page) >= 2, `${width}×${height} ${filter}: at least two projects visible`);
          }
          const scrollers = await page.evaluate(() => {
            const list = document.querySelector<HTMLElement>('#sidebar-project-list')!, nav = document.querySelector<HTMLElement>('.workspace-navigation')!;
            const heading = () => Math.round(document.querySelector('#sidebar-agents-heading')!.getBoundingClientRect().top);
            const before = { list: list.scrollTop, heading: heading() };
            nav.scrollTop = 400; const afterNav = { list: list.scrollTop, nav: nav.scrollTop, heading: heading() };
            list.scrollTop = 120; const afterList = { list: list.scrollTop, nav: nav.scrollTop, heading: heading() };
            return { before, afterNav, afterList, sidebarScroll: document.querySelector('#sidebar')!.scrollTop, listScrolls: list.scrollHeight > list.clientHeight, navScrolls: nav.scrollHeight > nav.clientHeight };
          });
          assert.equal(scrollers.listScrolls && scrollers.navScrolls, true, 'both regions have their own scroll');
          assert.equal(scrollers.afterNav.list, scrollers.before.list, 'scrolling Agentes leaves Proyectos');
          assert.equal(scrollers.afterNav.nav > 0 && scrollers.afterList.list > 0, true);
          assert.equal(scrollers.afterList.nav, scrollers.afterNav.nav, 'scrolling Proyectos leaves Agentes');
          assert.equal(scrollers.afterList.heading, scrollers.before.heading, 'headings never scroll');
          assert.equal(scrollers.sidebarScroll, 0);
        }
      });

      await t.test('dragging the split resizes the regions live, persists per profile and survives a reload; no PTY resize', async () => {
        const page = await open();
        const before = await rect(page, '.sidebar-projects'); const resizes = await resizeCount(page);
        await drag(page, '#sidebar-split', 0, 120);
        const after = await rect(page, '.sidebar-projects');
        assert.ok(after!.height > before!.height + 80, `Proyectos grew (${before!.height} → ${after!.height})`);
        const share = Number(await page.locator('#sidebar-split').getAttribute('aria-valuenow'));
        assert.ok(share > 34 && share <= 85, String(share));
        assert.equal(JSON.parse((await stored(page))!).projectsShare, share);
        await page.waitForTimeout(300); assert.equal(await resizeCount(page), resizes, 'the split never resizes a terminal');
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(400);
        assert.equal(Number(await page.locator('#sidebar-split').getAttribute('aria-valuenow')), share);
        assert.equal((await rect(page, '.sidebar-projects'))!.height, after!.height);
        // Agentes keeps its minimum however far the split goes.
        await drag(page, '#sidebar-split', 0, 900);
        assert.equal(await visibleAt(page, 'button[data-filter="closed"]'), 'ok');
        assert.ok((await rect(page, '.workspace-navigation'))!.height >= 58, 'two agent rows remain');
      });

      await t.test('keyboard on both separators: arrows, Home/End, Enter and double click restore; accessible values', async () => {
        const page = await open();
        const split = page.locator('#sidebar-split');
        assert.deepEqual(await split.evaluate(n => [n.getAttribute('role'), n.getAttribute('aria-orientation'), n.getAttribute('aria-valuemin'), n.getAttribute('aria-valuemax'), n.getAttribute('aria-valuenow'), n.tabIndex]), ['separator', 'horizontal', '15', '85', '34', 0]);
        await split.focus();
        assert.equal(await split.evaluate(n => getComputedStyle(n).boxShadow !== 'none' || getComputedStyle(n, '::before').backgroundColor !== ''), true);
        await page.keyboard.press('ArrowDown'); assert.equal(await split.getAttribute('aria-valuenow'), '39');
        await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); assert.equal(await split.getAttribute('aria-valuenow'), '29');
        await page.keyboard.press('Home'); assert.equal(await split.getAttribute('aria-valuenow'), '15');
        await page.keyboard.press('End'); assert.equal(await split.getAttribute('aria-valuenow'), '85');
        await page.keyboard.press('Enter'); assert.equal(await split.getAttribute('aria-valuenow'), '34');
        await page.keyboard.press('End'); await split.dblclick(); assert.equal(await split.getAttribute('aria-valuenow'), '34');
        const width = page.locator('#sidebar-width-handle');
        assert.deepEqual(await width.evaluate(n => [n.getAttribute('role'), n.getAttribute('aria-orientation'), n.getAttribute('aria-valuemin'), n.getAttribute('aria-valuemax'), n.getAttribute('aria-valuenow')]), ['separator', 'vertical', '220', '420', '264']);
        const resizes = await resizeCount(page);
        await width.focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await width.getAttribute('aria-valuenow'), '272'); await page.waitForTimeout(400);
        assert.equal(await sidebarWidth(page), 272);
        assert.equal(await resizeCount(page) - resizes, 1, 'one key press, one resize of the visible terminal');
        await page.keyboard.press('End'); assert.equal(await width.getAttribute('aria-valuenow'), '420');
        await page.keyboard.press('Home'); assert.equal(await width.getAttribute('aria-valuenow'), '220');
        await page.keyboard.press('Enter'); assert.equal(await width.getAttribute('aria-valuenow'), '264');
        await page.waitForTimeout(400); assert.equal(await sidebarWidth(page), 264);
        assert.equal(await stored(page), null, 'the default layout stores nothing');
      });

      await t.test('dragging the width moves only a guide: zero resizes while dragging, exactly one on release; persists', async () => {
        const page = await open(1220, 800, { open: 2, closed: 1, projects: 3 });
        const host = await rect(page, '.pane:nth-child(1) .terminal-host'); const resizes = await resizeCount(page);
        let during: { width: number; host: unknown; resizes: number; guide: boolean; selection: string } | null = null;
        await drag(page, '#sidebar-width-handle', 96, 0, 16, async () => {
          await page.waitForTimeout(250);
          during = { width: await sidebarWidth(page), host: await rect(page, '.pane:nth-child(1) .terminal-host'), resizes: await resizeCount(page),
            guide: await page.locator('.sidebar-width-guide').isVisible(), selection: await page.evaluate(() => String(getSelection())) };
        });
        assert.deepEqual(during, { width: 264, host, resizes, guide: true, selection: '' }, 'nothing but the guide moves while dragging');
        await page.waitForTimeout(500);
        const dropped = await sidebarWidth(page);
        assert.ok(Math.abs(dropped - 360) <= 2, `the width follows the pointer (${dropped})`);
        assert.equal(await resizeCount(page) - resizes, 1, 'one resize after release');
        assert.equal(await page.locator('.sidebar-width-guide').count(), 0);
        assert.equal(JSON.parse((await stored(page))!).width, dropped);
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(500);
        assert.equal(await sidebarWidth(page), dropped);
        // Escape during a drag cancels it.
        const box = (await page.locator('#sidebar-width-handle').boundingBox())!;
        const count = await resizeCount(page);
        await page.mouse.move(box.x + 4, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x - 60, box.y + 200);
        await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(400);
        assert.equal(await sidebarWidth(page), dropped); assert.equal(await resizeCount(page), count);
      });

      await t.test('folding a section gives the other its room; remembered; palette resets the layout', async () => {
        const page = await open();
        const toggle = page.locator('#sidebar-projects-heading button');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        const agents = (await rect(page, '.workspace-navigation'))!.height;
        await toggle.click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#sidebar-project-list').isVisible(), false);
        assert.equal(await page.locator('#sidebar-split').isVisible(), false);
        assert.ok((await rect(page, '.workspace-navigation'))!.height > agents + 60);
        assert.equal(await visibleAt(page, '#sidebar-projects-heading'), 'ok', 'the folded heading stays');
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(400);
        assert.equal(await page.locator('#sidebar-projects-heading button').getAttribute('aria-expanded'), 'false');
        // Folding Agentes while Proyectos is folded unfolds Proyectos: one section always shows its list.
        await page.locator('#sidebar-agents-heading button').click();
        assert.equal(await page.locator('#sidebar-projects-heading button').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#sidebar-agents-heading button').getAttribute('aria-expanded'), 'false');
        assert.ok(await projectRowsVisible(page) >= 12, 'Proyectos takes the room of Agentes');
        await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open]').waitFor();
        await page.keyboard.type('restablecer barra');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('dialog.command-palette[open]'));
        assert.equal(await page.locator('#sidebar-agents-heading button').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#sidebar-split').getAttribute('aria-valuenow'), '34');
        assert.equal(await stored(page), null);
      });

      await t.test('a new alert or state never changes the size of the regions or the terminal', async () => {
        const page = await open();
        await page.waitForTimeout(300);
        const shape = () => Promise.all(['.sidebar-projects', '.sidebar-agents', '#sidebar-split', '.pane:nth-child(1) .terminal-host'].map(s => rect(page, s)));
        const before = await shape(); const resizes = await resizeCount(page);
        await page.evaluate(() => { const w = (window as any).workbench; w.out('open-5', '\u0007'); w.out('open-6', '\u001b]7501;state=blocked\u0007'); w.out('open-7', '\u001b]9;Listo\u0007'); });
        await page.waitForFunction(() => Number(document.querySelector('#session-alerts')?.getAttribute('data-total')) > 0, undefined, { timeout: 5000 });
        await page.waitForTimeout(400);
        assert.deepEqual(await shape(), before);
        assert.equal(await resizeCount(page), resizes);
      });

      await t.test('760 px: the drawer keeps 264 px and hides the width handle; a stored width does not apply', async () => {
        const page = await open(760, 560, { open: 2, closed: 1, projects: 3 });
        await page.evaluate(() => localStorage.setItem('jauria:sidebar-layout:/synthetic-profile', JSON.stringify({ schemaVersion: 1, width: 400, projectsShare: 50 })));
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(400);
        await page.locator('#toggle-sidebar').click(); await page.waitForTimeout(300);
        assert.equal(await sidebarWidth(page), 264);
        assert.equal(await page.locator('#sidebar-width-handle').isVisible(), false);
        assert.equal(await page.locator('#sidebar-split').getAttribute('aria-valuenow'), '50');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        // Corrupt values fall back field by field.
        await page.evaluate(() => localStorage.setItem('jauria:sidebar-layout:/synthetic-profile', JSON.stringify({ schemaVersion: 1, width: 9999, projectsShare: 'x', agentsCollapsed: true })));
        await page.setViewportSize({ width: 1220, height: 800 });
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(400);
        assert.equal(await sidebarWidth(page), 264);
        assert.equal(await page.locator('#sidebar-split').getAttribute('aria-valuenow'), '34');
        assert.equal(await page.locator('#sidebar-agents-heading button').getAttribute('aria-expanded'), 'false');
      });
    });
  }
} finally { await server.close(); }

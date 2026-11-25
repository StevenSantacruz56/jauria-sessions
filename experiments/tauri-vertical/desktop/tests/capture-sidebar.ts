/** Synthetic measurements and screenshots of the sidebar with many sessions and
 * of Configuración. Real shell, CSS and xterm; synthetic Tauri boundary only.
 * Not part of the test globs. From desktop:
 *   node tests/capture-sidebar.ts                                   # measurements (JSON)
 *   CAPTURE_DIR=/abs/dir node tests/capture-sidebar.ts              # plus screenshots
 *   CAPTURE_BASELINE_REF=6bb6a24 node tests/capture-sidebar.ts      # the same against an earlier commit
 * The baseline ref serves that commit's src/*.ts and src/*.css in memory.
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, workbenchReady } from './browser/workbench-fixture.ts';

const baselineRef = process.env.CAPTURE_BASELINE_REF;
const historical = (name: string) => {
  try { return execFileSync('git', ['show', `${baselineRef}:experiments/tauri-vertical/desktop/src/${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'historical-source-in-memory', enforce: 'pre', load(id) {
    if (!baselineRef) return;
    const match = id.split('?')[0].match(/\/src\/([\w-]+\.(?:ts|css))$/); if (!match) return;
    return historical(match[1]) ?? undefined;
  } }] });
await server.listen();
const url = server.resolvedUrls!.local[0];
const dir = process.env.CAPTURE_DIR;
if (dir) await mkdir(dir, { recursive: true });
const suffix = baselineRef ? 'antes' : 'despues';

const measure = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => { const n = document.querySelector(selector); if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const sidebar = document.querySelector('#sidebar')!.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll<HTMLElement>('#sidebar-project-list [data-board]'));
  const list = document.querySelector<HTMLElement>('#sidebar-project-list')!;
  const lr = list.getBoundingClientRect();
  const fullyVisible = rows.filter(r => { const b = r.getBoundingClientRect(); return b.height > 0 && b.top >= lr.top - .5 && b.bottom <= lr.bottom + .5 && b.bottom <= sidebar.bottom; }).length;
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>('#sidebar *')).filter(n => { const s = getComputedStyle(n); return /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1; }).map(n => `${n.id ? `#${n.id}` : `.${n.className.split(' ')[0]}`} (${n.clientHeight}/${n.scrollHeight})`);
  return { sidebarHeight: Math.round(sidebar.height), projectsSection: box('.sidebar-projects'), projectsHeading: box('#sidebar-projects-heading'), projectList: box('#sidebar-project-list'),
    projectRowsVisible: fullyVisible, projectRows: rows.length, agentsSection: box('.sidebar-agents'), navigation: box('.workspace-navigation'), footer: box('.sidebar-footer'), scrollers };
});

const browser = await chromium.launch({ channel: 'chrome' });
const results: Record<string, unknown> = {};
try {
  for (const [width, height] of [[1220, 800], [760, 560]] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      await installWorkbench(page, { open: 40, closed: 60, projects: 12 });
      await page.emulateMedia({ colorScheme: theme });
      await workbenchReady(page, url);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (width <= 860) { await page.locator('#toggle-sidebar').click(); await page.waitForTimeout(300); }
      for (const filter of ['open', 'closed'] as const) {
        await page.locator(`button[data-filter="${filter}"]`).click(); await page.waitForTimeout(150);
        if (theme === 'light') results[`${width}x${height} ${filter}`] = await measure(page);
        if (dir) await page.screenshot({ path: `${dir}/barra-${suffix}-${width}x${height}-${filter === 'open' ? 'abiertas' : 'historial'}-${theme === 'light' ? 'claro' : 'oscuro'}.png` });
      }
      if (dir && !baselineRef && width === 1220) {
        // Separators: hover the split and focus the width handle to show their highlight.
        await page.locator('button[data-filter="open"]').click();
        await page.locator('#sidebar-split').hover(); await page.waitForTimeout(100);
        await page.screenshot({ path: `${dir}/divisores-${theme === 'light' ? 'claro' : 'oscuro'}.png` });
        await page.locator('#sidebar-width-handle').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
        await page.screenshot({ path: `${dir}/divisor-ancho-teclado-${theme === 'light' ? 'claro' : 'oscuro'}.png` });
        await page.keyboard.press('Enter'); await page.waitForTimeout(300);
        await page.locator('#sidebar-projects-heading button').click(); await page.waitForTimeout(150);
        await page.screenshot({ path: `${dir}/proyectos-plegado-${theme === 'light' ? 'claro' : 'oscuro'}.png` });
        await page.locator('#sidebar-projects-heading button').click();
        await page.locator('#open-settings').click();
        await page.waitForFunction(() => document.querySelector('dialog.settings-dialog')?.getAttribute('aria-busy') === 'false');
        await page.locator('.settings-dialog').evaluate(dialog => { const content = dialog.querySelector<HTMLElement>('.settings-dialog-content')!; dialog.style.maxHeight = 'none'; (dialog.querySelector('form') as HTMLElement).style.maxHeight = 'none'; content.style.overflow = 'visible'; });
        await page.setViewportSize({ width, height: 2400 }); await page.waitForTimeout(200);
        await page.locator('.settings-dialog').screenshot({ path: `${dir}/configuracion-completa-${theme === 'light' ? 'claro' : 'oscuro'}.png` });
        await page.setViewportSize({ width, height });
      }
      if (dir && baselineRef && width === 1220 && theme === 'light') {
        await page.locator('#open-settings').click(); await page.waitForTimeout(600);
        await page.screenshot({ path: `${dir}/configuracion-antes-claro.png` });
      }
      await page.close();
    }
  }
} finally { await browser.close(); await server.close(); }
console.log(JSON.stringify(results, null, 1));

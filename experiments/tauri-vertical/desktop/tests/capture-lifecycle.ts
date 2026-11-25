/** Synthetic screenshots of the session lifecycle (1.4.0): the pane picker, a
 * pane with an Interrumpida and its recovery, the sidebar with Interrumpidas
 * and the Historial view, in light and dark. Real shell, CSS and xterm;
 * synthetic Tauri boundary only. Not part of the test globs. From desktop:
 *   CAPTURE_DIR=/abs/dir node tests/capture-lifecycle.ts
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, workbenchReady } from './browser/workbench-fixture.ts';

const dir = process.env.CAPTURE_DIR;
if (!dir) throw new Error('CAPTURE_DIR is required');
await mkdir(dir, { recursive: true });
const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const options = {
  open: 3, closed: 4, projects: 3, nativeResume: true, bindings: ['crash-claude'],
  sessions: [
    { id: 'crash-claude', title: 'Refactor del cobro', kind: 'claude', cwd: '/synthetic/pagos', status: 'interrupted', pid: 41 },
    { id: 'crash-codex', title: 'Migración de tokens', kind: 'codex', cwd: '/synthetic/tokens', status: 'interrupted', pid: 42 },
    { id: 'custody', title: 'Revisión de permisos', kind: 'claude', cwd: '/synthetic/permisos', status: 'needs_attention', pid: 43 },
    { id: 'old-stop', title: 'Pruebas de carga', kind: 'terminal', cwd: '/synthetic/carga', status: 'stopped' },
  ],
};
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const theme of ['light', 'dark'] as const) {
    const name = theme === 'light' ? 'claro' : 'oscuro';
    const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
    await installWorkbench(page, options);
    await page.emulateMedia({ colorScheme: theme });
    await workbenchReady(page, url);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(() => {
      const w = (window as any).workbench;
      w.out('open-2', '$ npm test\r\n\r\n  42 passing (3s)\r\n\r\n$ ');
      w.out('crash-claude', '> Revisando el módulo de cobro…\r\n  Leí 12 archivos y propuse 3 cambios.\r\n');
      w.out('closed-0', '$ ./scripts/backup.sh\r\nCopia 1 de 3: lista\r\nCopia 2 de 3: lista\r\nCopia 3 de 3: lista\r\nBackup completo.\r\n');
    });
    await page.waitForTimeout(500);
    // Picker.
    await page.locator('#session-0').click(); await page.waitForTimeout(200);
    await page.screenshot({ path: `${dir}/selector-${name}.png` });
    await page.keyboard.press('Escape');
    // Sidebar with Interrumpidas and a pane with the recovery.
    await page.locator('#session-list .session-item[data-session-id="crash-claude"]').click(); await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/panel-interrumpida-${name}.png` });
    await page.locator('.pane:nth-child(1) [data-recovery="output"]').click(); await page.waitForTimeout(200);
    await page.screenshot({ path: `${dir}/panel-interrumpida-ver-salida-${name}.png` });
    await page.locator('#sidebar').screenshot({ path: `${dir}/barra-interrumpidas-${name}.png` });
    // Codex in a terminal: Empezar de nuevo aquí.
    await page.locator('#session-list .session-item[data-session-id="crash-codex"]').click(); await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/panel-empezar-de-nuevo-${name}.png` });
    // Historial view.
    await page.locator('button[data-filter="closed"]').click(); await page.waitForTimeout(150);
    await page.locator('#session-list .session-item[data-session-id="closed-0"]').click(); await page.waitForTimeout(300);
    await page.locator('#history-search').fill('lista'); await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/vista-historial-${name}.png` });
    await page.close();
    const narrow = await browser.newPage({ viewport: { width: 760, height: 560 } });
    await installWorkbench(narrow, options); await narrow.emulateMedia({ colorScheme: theme }); await workbenchReady(narrow, url);
    await narrow.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await narrow.locator('#session-0').click(); await narrow.waitForTimeout(150); await narrow.keyboard.press('Escape');
    await narrow.evaluate(() => (document.querySelector('#session-list .session-item[data-session-id="crash-claude"]') as HTMLElement).click());
    await narrow.waitForTimeout(400);
    await narrow.screenshot({ path: `${dir}/panel-interrumpida-760-${name}.png` });
    await narrow.close();
  }
} finally { await browser.close(); await server.close(); }

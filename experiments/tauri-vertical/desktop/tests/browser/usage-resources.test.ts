/** «Uso y recursos» (1.4.0) inside the real shell: its own dialog opened from
 * the sidebar footer row, the status bar total and the palette; Escape and
 * «Cerrar» return focus; nothing in the sidebar or the terminal changes size;
 * quotas without data / stale / current; one row per open session, runner,
 * window and the total, which the status bar repeats. No provider query
 * happens until «Actualizar». Synthetic Tauri boundary only. From desktop:
 * node --test tests/browser/usage-resources.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady, type WorkbenchOptions } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const MiB = 1024 ** 2;
const calls = (page: Page) => page.evaluate(() => [...(window as any).workbench.calls] as string[]);
const dialogText = (page: Page) => page.locator('#telemetry-dialog').innerText();

/** Telemetry built in the page so quota ages are relative to its clock. */
async function setTelemetry(page: Page, quotaAgeHours: { codex?: number | null; claudeStaleHours?: number | null }, webEngine = 'included') {
  await page.evaluate(({ quotaAgeHours, webEngine, MiB }) => {
    const now = Math.floor(Date.now() / 1000);
    const row = (pid: number, mib: number, cpu: number, extra: any = {}) => ({ pid, available: true, rssBytes: mib * MiB, cpuPercent: cpu, cpuAvailable: true, ...extra });
    const codex = quotaAgeHours.codex == null ? { available: false, error: 'Pulsa actualizar para consultar' } : {
      status: 'available', source: 'account/rateLimits/read', observedAt: now - Math.round(quotaAgeHours.codex * 3600),
      windows: [{ limitId: 'codex', window: 'primary', windowDurationMins: 300, remainingPercent: 64, resetsAt: now + 7200 },
        { limitId: 'codex', window: 'secondary', windowDurationMins: 10080, remainingPercent: 92, resetsAt: now + 86400 }] };
    const claude = quotaAgeHours.claudeStaleHours == null ? { status: 'unavailable', reasonCode: 'missing', windows: [] }
      : { status: 'unavailable', reasonCode: 'stale', observedAt: now - Math.round(quotaAgeHours.claudeStaleHours * 3600), windows: [] };
    (window as any).workbench.setTelemetry({
      quotas: { codex, claude }, quotasRefreshing: false,
      resources: {
        source: 'proc_pid_rusage_v0', timestampUnixMs: Date.now(), discovery: { partial: false },
        processes: [row(77, 6, 0.5, { role: 'runner' }), row(200, 120, 10, { role: 'cli', sessionId: 'open-0' }), row(201, 30, 2, { role: 'tool', sessionId: 'open-0' }),
          row(300, 90, 1, { role: 'cli', sessionId: 'open-1' })],
        app: { webEngine, source: 'proc_pid_rusage_v0', discovery: { partial: false }, processes: [row(1, 108, 3, { role: 'app' }), ...(webEngine === 'included' ? [row(2, 216, 4, { role: 'web' }), row(3, 29, 1, { role: 'web' })] : [])] },
      },
    });
  }, { quotaAgeHours, webEngine, MiB });
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: Uso y recursos`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function open(options: WorkbenchOptions = {}, width = 1220, height = 800) {
        const page = await browser.newPage({ viewport: { width, height } }); t.after(() => page.close());
        await installWorkbench(page, { open: 2, closed: 1, projects: 2, ...options }); await workbenchReady(page, url);
        return page;
      }

      await t.test('the sidebar row opens a dialog; nothing in the sidebar or the terminal changes size; Escape and Cerrar return focus', async () => {
        const page = await open();
        assert.equal(await page.locator('#telemetry-host').count(), 0, 'no disclosure in the sidebar any more');
        assert.equal(await page.locator('#open-telemetry').evaluate(node => node.tagName), 'BUTTON');
        const before = { sidebar: await rect(page, '#sidebar'), projects: await rect(page, '.sidebar-projects'), agents: await rect(page, '.sidebar-agents'), footer: await rect(page, '.sidebar-footer'), host: await rect(page, '.pane:nth-child(1) .terminal-host') };
        const resizes = await resizeCount(page);
        await page.locator('#open-telemetry').click();
        await page.waitForSelector('#telemetry-dialog[open]');
        assert.equal(await page.locator('#telemetry-dialog h2').innerText(), 'Uso y recursos');
        assert.equal(await page.locator('#telemetry-dialog').getByText('Uso y recursos', { exact: true }).count(), 1, 'the title appears once');
        const after = { sidebar: await rect(page, '#sidebar'), projects: await rect(page, '.sidebar-projects'), agents: await rect(page, '.sidebar-agents'), footer: await rect(page, '.sidebar-footer'), host: await rect(page, '.pane:nth-child(1) .terminal-host') };
        assert.deepEqual(after, before);
        await page.waitForTimeout(300); assert.equal(await resizeCount(page), resizes);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#telemetry-dialog[open]'));
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-telemetry');
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
        assert.equal(await page.locator('dialog[open]').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-telemetry');
        assert.equal(await resizeCount(page), resizes);
      });

      await t.test('no provider is queried on mount or open; «Actualizar» asks once', async () => {
        const page = await open();
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForTimeout(400);
        assert.equal((await calls(page)).filter(op => op === 'refresh_quotas').length, 0);
        assert.ok((await calls(page)).includes('telemetry'));
        await page.locator('#telemetry-dialog').getByRole('button', { name: 'Actualizar', exact: true }).click();
        await page.waitForFunction(() => (window as any).workbench.calls.includes('refresh_quotas'));
        await page.waitForTimeout(300);
        assert.equal((await calls(page)).filter(op => op === 'refresh_quotas').length, 1);
      });

      await t.test('quotas without data: one line each saying why and what to do', async () => {
        const page = await open();
        await setTelemetry(page, { codex: null, claudeStaleHours: null });
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForFunction(() => /Sin consultar/.test(document.querySelector('#telemetry-dialog')?.textContent ?? ''));
        assert.equal(await page.locator('.telemetry-provider[data-provider="claude"]').innerText(), 'Claude Code: Sin dato. Se actualiza cuando hay una sesión de Claude abierta en Jauría.');
        assert.equal(await page.locator('.telemetry-provider[data-provider="codex"]').innerText(), 'Codex: Sin consultar. Pulsa Actualizar para ver tu cuota.');
        assert.equal(await page.locator('.telemetry-meter').count(), 0);
      });

      await t.test('quotas current and stale: plain windows with their reset; a stale one says how old and is not presented as current', async () => {
        const page = await open();
        await setTelemetry(page, { codex: 0.01, claudeStaleHours: 11 });
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForSelector('.telemetry-provider[data-provider="codex"][data-state="current"]');
        const codex = await page.locator('.telemetry-provider[data-provider="codex"]').innerText();
        assert.match(codex, /Actualizado hace (un momento|1 min)/);
        assert.match(codex, /5 horas: 64 % libre · se reinicia el \d{1,2} [a-z]{3}, \d{2}:\d{2}/);
        assert.match(codex, /Semana: 92 % libre · se reinicia el /);
        assert.equal(await page.locator('.telemetry-provider[data-provider="codex"] meter').count(), 2);
        assert.equal(await page.locator('.telemetry-provider[data-provider="claude"]').innerText(), 'Claude Code: Último dato hace 11 h, ya vencido. Se actualiza cuando hay una sesión de Claude abierta en Jauría.');
        await setTelemetry(page, { codex: 11, claudeStaleHours: 11 });
        await page.waitForSelector('.telemetry-provider[data-provider="codex"][data-state="stale"]', { timeout: 5000 });
        const stale = await page.locator('.telemetry-provider[data-provider="codex"]').innerText();
        assert.match(stale, /Dato vencido · hace 11 h/);
        assert.doesNotMatch(stale, /Actualizado/);
        assert.match(stale, /Puede haber cambiado\. Pulsa Actualizar/);
        assert.match(await page.locator('.telemetry-provider[data-provider="codex"] meter').first().getAttribute('aria-label') ?? '', /Dato vencido/);
      });

      await t.test('resources: a row per open session by its title (children added), runner, window with the web engine, the total; the status bar shows that total; no jargon', async () => {
        const page = await open();
        await setTelemetry(page, { codex: 0.01 });
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForSelector('tr.telemetry-session');
        const rows = await page.locator('.telemetry-table tbody tr, .telemetry-table tfoot tr').evaluateAll(trs => trs.map(tr => Array.from(tr.children).map(c => (c as HTMLElement).innerText)));
        assert.deepEqual(rows, [
          ['Sesión abierta 1', '12 %', '150 MiB'],
          ['Sesión abierta 2', '1 %', '90 MiB'],
          ['Runner (servicio de sesiones)', '0,5 %', '6 MiB'],
          ['Interfaz (ventana)', '8 %', '353 MiB'],
          ['Total de Jauría', '21,5 %', '599 MiB'],
        ]);
        assert.equal(await page.locator('#telemetry-summary').innerText(), 'Jauría · CPU 21,5 % · RAM 599 MiB');
        const text = await dialogText(page);
        for (const jargon of [/Fuente/, /RSS/, /proc_pid/, /reparent/i, /rateLimits/, /Primera muestra/, /Inventario parcial/, /PID/]) assert.doesNotMatch(text, jargon);
        assert.doesNotMatch(text, /motor web/, 'the web engine is counted: no note');
        assert.equal(await page.locator('.telemetry-table th', { hasText: 'CPU' }).getAttribute('title'), '100 % equivale a un núcleo completo; con varios núcleos puede pasar de 100 %.');
      });

      await t.test('without an attributable web engine the window row says so in one plain line', async () => {
        const page = await open();
        await setTelemetry(page, {}, 'not_attributable');
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForFunction(() => /motor web/.test(document.querySelector('#telemetry-dialog')?.textContent ?? ''));
        assert.match(await dialogText(page), /La interfaz no incluye el motor web de la ventana/);
        assert.doesNotMatch(await dialogText(page), /Puede faltar/);
      });

      await t.test('zero open sessions: «Ninguna sesión abierta», runner and window rows, no partial warning at rest', async () => {
        const page = await open({ open: 0, closed: 1, telemetry: { resources: { discovery: { partial: false }, processes: [{ pid: 77, available: true, rssBytes: 6 * MiB, cpuPercent: 0, cpuAvailable: true, role: 'runner' }],
          app: { webEngine: 'included', discovery: { partial: false }, processes: [{ pid: 1, available: true, rssBytes: 100 * MiB, cpuPercent: 1, cpuAvailable: true, role: 'app' }] } } } });
        await page.locator('#open-telemetry').click(); await page.waitForSelector('#telemetry-dialog[open]');
        await page.waitForSelector('tr.telemetry-empty');
        assert.equal(await page.locator('tr.telemetry-empty').innerText(), 'Ninguna sesión abierta.');
        assert.equal(await page.locator('tr.telemetry-total').innerText().then(t => t.replace(/\s+/g, ' ')), 'Total de Jauría 1 % 106 MiB');
        assert.doesNotMatch(await dialogText(page), /Puede faltar|parcial/);
      });

      await t.test('the palette and the status bar total open the same dialog', async () => {
        const page = await open();
        await page.locator('#open-command-palette').click();
        await page.keyboard.type('uso y recursos');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#telemetry-dialog[open]');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        await page.locator('#telemetry-summary').click();
        await page.waitForSelector('#telemetry-dialog[open]');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'telemetry-summary');
      });
    });
  }
} finally {
  await server.close();
}

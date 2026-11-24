/** Configuración inside the real shell (1.4.0): every option applies at once,
 * the runner settings reach the boundary with the contract's shapes, the
 * terminal font changes each visible terminal with exactly one `resize`, and
 * «Acerca de y diagnóstico» holds what the retired Información panel had that
 * was useful (versions, CLI check, diagnostic preview/export, restart with its
 * confirmation). Synthetic Tauri boundary only. From desktop:
 * node --test tests/browser/settings-app.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, rect, resizeCount, workbenchReady, type WorkbenchOptions } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const native = (page: Page) => page.evaluate(() => structuredClone((window as any).workbench.native));
const settingsReady = (page: Page) => page.waitForFunction(() => document.querySelector('dialog.settings-dialog')?.getAttribute('aria-busy') === 'false');

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: settings in the app`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      t.after(() => browser.close());
      async function open(options: WorkbenchOptions = {}, width = 1220, height = 800) {
        const page = await browser.newPage({ viewport: { width, height } }); t.after(() => page.close());
        await installWorkbench(page, { open: 2, closed: 1, projects: 2, ...options }); await workbenchReady(page, url);
        return page;
      }
      async function settings(page: Page) { await page.locator('#open-settings').click(); await settingsReady(page); }

      await t.test('sections by task, no Guardar, opening keeps the terminal; the Información panel and ⌘I are gone', async () => {
        const page = await open();
        const host = await rect(page, '.pane:nth-child(1) .terminal-host'); const resizes = await resizeCount(page);
        assert.equal(await page.locator('#inspector, #toggle-inspector').count(), 0);
        await page.locator('.pane:nth-child(1) .terminal-host').click();
        await page.keyboard.press('Meta+i'); await page.waitForTimeout(200);
        assert.equal(await page.locator('dialog[open]').count(), 0, '⌘I opens nothing');
        await settings(page);
        assert.deepEqual(await page.locator('.settings-dialog h3').allTextContents(), ['Apariencia', 'Barra lateral', 'Sesiones', 'Pulso y agentes', 'Avisos', 'Acerca de y diagnóstico']);
        assert.equal(await page.getByRole('button', { name: 'Guardar', exact: true }).count(), 0);
        // «Cerrar» is a secondary button with a visible border, as in Uso y recursos.
        const close = await page.locator('.settings-dialog').getByRole('button', { name: 'Cerrar', exact: true }).evaluate(node => { const s = getComputedStyle(node); return { cls: node.className, width: s.borderTopWidth, color: s.borderTopColor }; });
        assert.equal(close.cls, 'secondary');
        assert.notEqual(close.width, '0px');
        assert.doesNotMatch(close.color, /rgba\(0, 0, 0, 0\)|transparent/);
        assert.match(await page.locator('.settings-dialog').innerText(), /se aplican y se guardan al momento/);
        assert.match(await page.locator('.settings-sessions').innerText(), /Cerrar la ventana no detiene las sesiones/);
        assert.match(await page.locator('.settings-sessions').innerText(), /Bajarlo no cierra las sesiones abiertas/);
        assert.match(await page.locator('.settings-pulso').innerText(), /leer y editar todos tus proyectos de Pulso.*crear proyectos nuevos.*No ve los Pendientes/s);
        assert.deepEqual(await rect(page, '.pane:nth-child(1) .terminal-host'), host);
        await page.waitForTimeout(300); assert.equal(await resizeCount(page), resizes);
        assert.match(await page.locator('#welcome, .settings-dialog').allInnerTexts().then(t => t.join(' ')), /Cerrar la ventana no detiene las sesiones/);
      });

      await t.test('the session limit and Pulso access are saved at once with both keys; the capacity updates', async () => {
        const page = await open();
        await settings(page);
        const limit = page.getByLabel('Máximo de sesiones simultáneas');
        assert.equal(await limit.inputValue(), '8');
        assert.equal(await limit.locator('option').count(), 8);
        await limit.selectOption('4');
        await page.waitForFunction(() => document.querySelector('.settings-dialog-status')?.textContent?.startsWith('Guardado'));
        await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).uncheck();
        await page.waitForFunction(() => /desactivado/.test(document.querySelector('.settings-dialog-status')?.textContent ?? ''));
        const saves = (await native(page)).filter((c: any) => Array.isArray(c) && c[0] === 'set_settings').map((c: any) => c[1]);
        assert.deepEqual(saves, [{ maxConcurrentSessions: 4, pulsoAutoAccess: true }, { maxConcurrentSessions: 4, pulsoAutoAccess: false }]);
        assert.match(await page.locator('#capacity').innerText(), /de 4 plazas/);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('dialog[open]').count(), 0);
      });

      await t.test('an older runner (settingsVersion 1) sends only the limit and says why Pulso access is unavailable', async () => {
        const page = await open({ settingsVersion: 1 });
        await settings(page);
        assert.equal(await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).isDisabled(), true);
        assert.match(await page.locator('.settings-pulso').innerText(), /no ofrece el acceso automático/);
        await page.getByLabel('Máximo de sesiones simultáneas').selectOption('3');
        await page.waitForFunction(() => document.querySelector('.settings-dialog-status')?.textContent?.startsWith('Guardado'));
        assert.deepEqual((await native(page)).filter((c: any) => Array.isArray(c) && c[0] === 'set_settings').map((c: any) => c[1]), [{ maxConcurrentSessions: 3 }]);
      });

      await t.test('terminal font: one resize per visible terminal, applied to xterm, remembered per profile; 13 px is the default', async () => {
        const page = await open();
        await page.locator('#toggle-split').click(); await page.waitForTimeout(500);
        const resizes = await resizeCount(page);
        const font = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.pane .xterm-rows')).map(n => getComputedStyle(n).fontSize));
        assert.deepEqual(await font(), ['13px', '13px']);
        await settings(page);
        const select = page.getByLabel('Tamaño de letra del terminal');
        assert.equal(await select.inputValue(), '13');
        assert.deepEqual(await select.locator('option').evaluateAll(o => o.map(n => (n as HTMLOptionElement).value)), ['11', '12', '13', '14', '15', '16', '17', '18']);
        await select.selectOption('16'); await page.waitForTimeout(600);
        assert.deepEqual(await font(), ['16px', '16px']);
        const sent = await page.evaluate(n => (window as any).workbench.resizes.slice(n), resizes);
        assert.equal(sent.length, 2, `one resize per visible terminal: ${JSON.stringify(sent)}`);
        assert.deepEqual(new Set(sent.map((r: any) => r.id)).size, 2);
        await page.keyboard.press('Escape');
        await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado'); await page.waitForTimeout(500);
        assert.deepEqual((await font())[0], '16px');
        assert.equal(await page.evaluate(() => localStorage.getItem('jauria:terminal-font:/synthetic-profile')), '{"schemaVersion":1,"size":16}');
      });

      await t.test('grouping and sidebar reset from Configuración', async () => {
        const page = await open();
        await settings(page);
        await page.getByLabel('Agrupar agentes').selectOption('state');
        assert.equal(await page.locator('#agent-grouping').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        await page.locator('#sidebar-width-handle').focus(); await page.keyboard.press('End'); await page.waitForTimeout(300);
        await settings(page);
        await page.getByRole('button', { name: 'Restablecer tamaño y secciones de la barra lateral' }).click();
        assert.equal(await page.locator('#sidebar-width-handle').getAttribute('aria-valuenow'), '264');
        assert.match(await page.locator('.settings-dialog-status').innerText(), /Barra lateral restablecida/);
      });

      await t.test('Acerca de y diagnóstico: versions, mismatch advice, CLI check, preview before export, restart with confirmation', async () => {
        const page = await open({ runnerVersion: '1.3.3' });
        await settings(page);
        const about = page.locator('.settings-about');
        assert.match(await about.innerText(), /Jauría \d+\.\d+\.\d+/);
        assert.match(await about.innerText(), /Servicio de sesiones \(runner\): 1\.3\.3/);
        assert.match(await about.innerText(), /no coinciden/);
        assert.match(await about.innerText(), /Claude Code: 2\.1\.325/);
        assert.doesNotMatch(await about.innerText(), /\/synthetic/, 'no paths');
        await page.getByRole('button', { name: 'Previsualizar diagnóstico' }).click();
        await page.locator('#diagnostic-preview').waitFor();
        await page.getByRole('button', { name: 'Guardar diagnóstico…' }).click();
        await page.waitForFunction(() => document.querySelector('#diagnostic-export-state')?.textContent === 'Diagnóstico guardado.');
        await page.getByRole('button', { name: 'Reiniciar runner…' }).click(); await page.waitForTimeout(200);
        assert.deepEqual((await native(page)).filter((c: any) => typeof c === 'string' || c[0] === 'export_diagnostic'), ['connect_runner', 'preview_diagnostic', ['export_diagnostic', 'preview-1'], 'restart_runner']);
        assert.match(await about.innerText(), /Termina todas las sesiones/);
        const same = await open({ runnerVersion: '1.4.0' });
        await settings(same);
        assert.doesNotMatch(await same.locator('.settings-about').innerText(), /no coinciden/);
      });

      await t.test('a confirmed restart reconnects', async () => {
        const page = await open({ restartConfirms: true });
        await settings(page);
        await page.getByRole('button', { name: 'Reiniciar runner…' }).click();
        await page.waitForFunction(() => (window as any).workbench.native.filter((c: any) => c === 'connect_runner').length === 2);
      });

      await t.test('the pane menu has the session details that Información showed', async () => {
        const page = await open();
        await page.locator('.pane:nth-child(1) .pane-menu > summary').click();
        const menu = page.locator('.pane:nth-child(1) .pane-menu-content');
        assert.match(await menu.innerText(), /\/synthetic\/open-0/);
        for (const name of ['Copiar carpeta', 'Copiar identificador', 'Nueva sesión en esta carpeta…']) assert.equal(await menu.getByRole('button', { name, exact: true }).count(), 1, name);
      });
    });
  }
} finally { await server.close(); }

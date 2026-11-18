/** Real native dialog/DOM, injected persistence only; no runner or providers.
 * Opt-in from desktop (Chrome + Playwright WebKit installed):
 * SETTINGS_PANEL_BROWSER=1 node --test tests/settings-panel.test.ts
 * Plain node --test skips browsers, including CI glob runs.
 * Uses the existing esbuild + Playwright dependencies, with no DOM shim.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { chromium, webkit, type Browser, type Page } from 'playwright';

if (process.env.SETTINGS_PANEL_BROWSER !== '1') {
  test('settings browser tests require SETTINGS_PANEL_BROWSER=1', { skip: true }, () => {});
} else {
const root = new URL('../', import.meta.url);
const bundle = await build({
  entryPoints: [new URL('src/settings-panel.ts', root).pathname],
  bundle: true, write: false, format: 'iife', globalName: 'SettingsComponent',
  loader: { '.css': 'empty' },
});
const styles = (await Promise.all(['style.css', 'settings-panel.css'].map(name =>
  readFile(new URL(`src/${name}`, root), 'utf8')))).join('\n');
const ready = (page: Page) => page.waitForFunction(() =>
  document.querySelector('dialog')?.getAttribute('aria-busy') === 'false');
const action = (page: Page, source: string) => page.evaluate(source =>
  Function('f', source)((window as any).fixture), source);

async function fixture(browser: Browser, config = '') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.setContent('<button id="opener">Configuración</button><main id="pty" style="position:fixed;inset:40px 0 0">Terminal</main>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(config => {
    const w = window as any;
    const f = w.fixture = {
      reads: 0, saves: [] as number[], autoSaves: [] as boolean[], themes: [] as string[], saved: [] as any[],
      editable: true, readError: false, saveError: false, holdRead: false, holdSave: false,
      settings: { schemaVersion: 2, maxConcurrentSessions: 2, maxSupportedSessions: 8, pulsoAutoAccess: true, warning: null },
      resolveRead: null as any, resolveSave: null as any,
    };
    Function('f', config)(f);
    f.panel = w.SettingsComponent.mountSettings({
      read: async () => {
        f.reads++;
        if (f.holdRead) return new Promise(resolve => { f.resolveRead = resolve; });
        if (f.readError) throw Error('Synthetic read error');
        return structuredClone(f.settings);
      },
      save: async (value: number, pulsoAutoAccess?: boolean) => {
        f.saves.push(value);
        if (pulsoAutoAccess !== undefined) f.autoSaves.push(pulsoAutoAccess);
        if (f.holdSave) return new Promise(resolve => { f.resolveSave = resolve; });
        if (f.saveError) throw Error('Synthetic save error');
        return { ...structuredClone(f.settings), maxConcurrentSessions: value, pulsoAutoAccess };
      },
      getTheme: () => 'system', setTheme: (value: string) => f.themes.push(value),
      version: '1.0.0', canEdit: () => f.editable,
      onSaved: (settings: any) => f.saved.push(settings),
    });
    document.querySelector('#opener')!.addEventListener('click', () => f.panel.open());
  }, config);
  return page;
}

for (const engine of [chromium, webkit]) {
  await test(`${engine.name()}: settings dialog`, async t => {
    const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
    t.after(() => browser.close());
    async function mounted(config = '') {
      const page = await fixture(browser, config); t.after(() => page.close()); return page;
    }

    await t.test('native focus, Escape and explicit persistence; opening leaves terminal geometry stable', async () => {
      const page = await mounted();
      assert.equal(await action(page, 'return f.reads'), 0);
      const bounds = await page.locator('#pty').boundingBox();
      // WebKit mouse clicks do not necessarily focus buttons; establish the
      // keyboard opener whose focus the dialog promises to restore.
      await page.locator('#opener').focus();
      await page.keyboard.press('Enter'); await ready(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.deepEqual(await page.locator('#pty').boundingBox(), bounds);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '2');
      assert.match(await page.locator('dialog').innerText(), /Jauría 1\.0\.0/);
      assert.deepEqual(await action(page, 'return [f.saves, f.themes, f.saved]'), [[], [], []]);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog')!.contains(document.activeElement)), true, 'native dialog can yield one Tab stop to browser chrome; background stays inert');
      }
      await page.getByLabel('Apariencia').selectOption('dark');
      await page.getByLabel('Máximo de sesiones simultáneas').fill('4');
      assert.deepEqual(await action(page, 'return [f.saves, f.themes]'), [[], []]);
      await page.getByRole('button', { name: 'Guardar', exact: true }).click(); await ready(page);
      assert.deepEqual(await action(page, 'return [f.saves, f.themes, f.saved[0].maxConcurrentSessions]'), [[4], ['dark'], 4]);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.waitForFunction(() => document.activeElement?.id === 'opener');
      assert.equal(await page.locator('#opener').evaluate(el => el === document.activeElement), true);
      assert.deepEqual(await page.locator('#pty').boundingBox(), bounds);
    });

    await t.test('integer validation and server cap never clamp an invalid draft or save it', async () => {
      const page = await mounted('f.settings.maxSupportedSessions = 3;');
      await page.locator('#opener').click(); await ready(page);
      const limit = page.getByLabel('Máximo de sesiones simultáneas');
      assert.equal(await limit.getAttribute('max'), '3');
      for (const value of ['', '0', '-1', '1.5', '4', '9']) {
        await limit.fill(value);
        await page.getByRole('button', { name: 'Guardar', exact: true }).click();
        assert.equal(await limit.getAttribute('aria-invalid'), 'true');
        assert.match(await page.getByRole('alert').innerText(), /entero entre 1 y 3/);
        assert.equal(await limit.inputValue(), value);
      }
      assert.deepEqual(await action(page, 'return [f.saves, f.themes]'), [[], []]);
      await limit.fill('3'); await page.keyboard.press('Enter'); await ready(page);
      assert.deepEqual(await action(page, 'return f.saves'), [3]);
    });

    await t.test('Pulso access starts enabled and saves a clear opt out', async () => {
      const page = await mounted();
      await page.locator('#opener').click(); await ready(page);
      const toggle = page.getByRole('checkbox', { name: 'Acceso automático a Pulso' });
      assert.equal(await toggle.isChecked(), true);
      assert.match(await page.locator('.settings-pulso').innerText(), /Claude Code y Codex iniciados desde Jauría/);
      await toggle.uncheck();
      await page.getByRole('button', { name: 'Guardar', exact: true }).click(); await ready(page);
      assert.deepEqual(await action(page, 'return [f.autoSaves, f.saved[0].pulsoAutoAccess]'), [[false], false]);
    });

    await t.test('read failure stays open, retries and preserves drafts when server bounds change', async () => {
      const page = await mounted('f.readError = true;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Guardar', exact: true }).isDisabled(), true);
      assert.match(await page.getByRole('alert').innerText(), /No se pudo leer/);
      await action(page, 'f.readError = false;');
      await page.getByRole('button', { name: 'Reintentar consulta' }).click(); await ready(page);
      await page.getByLabel('Máximo de sesiones simultáneas').fill('7');
      await page.getByLabel('Apariencia').selectOption('light');
      assert.match(await page.locator('.settings-dialog-status').innerText(), /Cambios sin guardar/);
      assert.equal(await page.getByRole('button', { name: 'Cerrar y conservar borrador', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Cerrar y conservar borrador', exact: true }).click();
      await action(page, 'f.readError = true;');
      await page.locator('#opener').click(); await ready(page);
      await action(page, 'f.readError = false; f.settings.maxSupportedSessions = 4; f.settings.warning = "Límite actualizado por el runner";');
      await page.getByRole('button', { name: 'Reintentar consulta' }).click(); await ready(page);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '7');
      assert.equal(await page.getByLabel('Apariencia').inputValue(), 'light');
      assert.match(await page.locator('.settings-dialog-status').innerText(), /Cambios sin guardar/);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').getAttribute('max'), '4');
      assert.match(await page.locator('dialog').innerText(), /Límite actualizado por el runner/);
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      assert.deepEqual(await action(page, 'return [f.saves, f.themes]'), [[], []]);
    });

    await t.test('in-flight requests freeze controls, refuse close and apply theme only after success', async () => {
      const page = await mounted('f.holdRead = true;');
      await page.locator('#opener').click();
      await page.keyboard.press('Escape'); await action(page, 'f.panel.close(); f.panel.open();');
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await action(page, 'return f.reads'), 1);
      assert.equal(await page.getByLabel('Apariencia').isDisabled(), true);
      await action(page, 'f.resolveRead(f.settings);'); await ready(page);
      await page.getByLabel('Apariencia').selectOption('dark');
      await page.getByLabel('Máximo de sesiones simultáneas').fill('5');
      await action(page, 'f.saveError = true;');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click(); await ready(page);
      assert.deepEqual(await action(page, 'return f.themes'), []);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '5');
      await action(page, 'f.holdSave = true;');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.keyboard.press('Escape'); await action(page, 'f.panel.close();');
      assert.equal(await page.locator('dialog[open]').count(), 1);
      for (const control of ['input', 'select', 'button[type=submit]', 'button.quiet']) {
        for (const element of await page.locator(`dialog ${control}`).all()) assert.equal(await element.isDisabled(), true);
      }
      assert.deepEqual(await action(page, 'return f.themes'), []);
      await action(page, 'f.resolveSave({...f.settings, maxSupportedSessions: 4, maxConcurrentSessions: 4});'); await ready(page);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '4');
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').getAttribute('max'), '4');
      assert.deepEqual(await action(page, 'return [f.themes, f.saved.length]'), [['dark'], 1]);
    });

    await t.test('forced native close during save reopens; an intentional close event cannot undo a rapid reopen', async () => {
      const page = await mounted('f.holdSave = true;');
      await page.locator('#opener').click(); await ready(page);
      await page.getByLabel('Apariencia').selectOption('dark');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      await page.locator('dialog').evaluate((dialog: HTMLDialogElement) => dialog.close());
      await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
      assert.deepEqual(await action(page, 'return f.themes'), []);
      await action(page, 'f.resolveSave(f.settings);'); await ready(page);
      await action(page, 'f.panel.close(); f.panel.open();'); await ready(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('dialog')?.open === false);
    });

    await t.test('older runner allows theme only, including when the settings RPC is unavailable', async () => {
      const page = await mounted('f.editable = false; f.readError = true;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), true);
      await page.getByLabel('Apariencia').selectOption('dark');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click(); await ready(page);
      assert.deepEqual(await action(page, 'return [f.saves, f.themes, f.saved]'), [[], ['dark'], []]);
    });

    await t.test('dispose fences late reads and saves, including theme and onSaved side effects', async () => {
      for (const operation of ['read', 'save']) {
        const page = await mounted(operation === 'read' ? 'f.holdRead = true;' : 'f.holdSave = true;');
        await page.locator('#opener').click();
        if (operation === 'save') {
          await ready(page); await page.getByLabel('Apariencia').selectOption('dark');
          await page.getByRole('button', { name: 'Guardar', exact: true }).click();
        }
        await action(page, `f.panel.dispose(); f.panel.dispose(); f.resolve${operation === 'read' ? 'Read' : 'Save'}(f.settings);`);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
        assert.equal(await page.locator('dialog').count(), 0);
        assert.deepEqual(await action(page, 'return [f.themes, f.saved, f.panel.isOpen]'), [[], [], false]);
        await action(page, 'f.panel.open(); f.panel.close();');
        assert.equal(await page.locator('dialog').count(), 0);
      }
    });

    await t.test('malformed read and save responses cannot apply appearance', async () => {
      const page = await mounted('f.settings.maxSupportedSessions = 0;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.getByRole('alert').isVisible(), true);
      await action(page, 'f.settings.maxSupportedSessions = 8;');
      await page.getByRole('button', { name: 'Reintentar consulta' }).click(); await ready(page);
      await action(page, 'f.holdSave = true;');
      await page.getByLabel('Apariencia').selectOption('dark');
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      await action(page, 'f.resolveSave({...f.settings, maxConcurrentSessions: 9});'); await ready(page);
      assert.equal(await page.getByRole('alert').isVisible(), true);
      assert.deepEqual(await action(page, 'return [f.themes, f.saved]'), [[], []]);
    });

    await t.test('bounded desktop and narrow layouts scroll internally in both themes', async () => {
      const page = await mounted();
      for (const [width, height, theme] of [[1100, 900, 'light'], [760, 640, 'dark'], [360, 500, 'light']] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await action(page, 'f.panel.open();'); await ready(page);
        const dimensions = await page.locator('dialog').evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width,
            overflow: el.scrollWidth > el.clientWidth, font: getComputedStyle(el).fontFamily };
        });
        assert.ok(dimensions.width <= 760 && dimensions.x >= 0 && dimensions.y >= 0);
        assert.ok(dimensions.right <= width && dimensions.bottom <= height);
        assert.equal(dimensions.overflow, false);
        assert.match(dimensions.font, /Inter/);
        await page.getByRole('button', { name: /^Cerrar/ }).click();
      }
    });
  });
}

}

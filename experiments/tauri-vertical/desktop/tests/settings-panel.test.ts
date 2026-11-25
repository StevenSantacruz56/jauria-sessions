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
      reads: 0, saves: [] as number[], autoSaves: [] as boolean[], themes: [] as string[], saved: [] as any[], fonts: [] as number[], groupings: [] as string[], resets: 0,
      font: 13, grouping: 'project', editable: true, readError: false, saveError: false, holdRead: false, holdSave: false, local: true,
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
      ...(f.local ? {
        terminalFont: { min: 11, max: 18, default: 13, get: () => f.font, set: (size: number) => { f.font = size; f.fonts.push(size); } },
        grouping: { get: () => f.grouping, set: (value: string) => { f.grouping = value; f.groupings.push(value); } },
        resetSidebar: () => { f.resets++; },
      } : {}),
      ...(f.provider ? {
        saveProviderSignals: async (enabled: boolean) => {
          f.providerSaves = [...(f.providerSaves ?? []), enabled];
          if (f.saveError) throw Error('Synthetic save error');
          f.settings = { ...f.settings, providerSignals: enabled }; return structuredClone(f.settings);
        },
        openNotificationSettings: async () => { f.opened = (f.opened ?? 0) + 1; if (f.openError) throw Error('Synthetic open error'); },
      } : {}),
      version: '1.0.0', canEdit: () => f.editable,
      onSaved: (settings: any) => f.saved.push(settings),
    });
    document.querySelector('#opener')!.addEventListener('click', () => f.panel.open());
  }, config);
  return page;
}
const status = (page: Page) => page.locator('.settings-dialog-status').innerText();
const saved = (page: Page, prefix = 'Guardado') => page.waitForFunction(prefix => document.querySelector('.settings-dialog-status')?.textContent?.startsWith(prefix), prefix);

for (const engine of [chromium, webkit]) {
  await test(`${engine.name()}: settings dialog`, async t => {
    const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
    t.after(() => browser.close());
    async function mounted(config = '') {
      const page = await fixture(browser, config); t.after(() => page.close()); return page;
    }

    await t.test('Avisos: Claude Code y Codex toggle saves at once for new sessions; Abrir Ajustes de notificaciones; old runner disables it', async () => {
      const page = await mounted('f.provider = true; f.settings.providerSignals = true;');
      await page.locator('#opener').click(); await ready(page);
      const toggle = page.getByLabel('Avisos de Claude Code y Codex');
      assert.equal(await toggle.isChecked(), true, 'on by default');
      assert.match(await page.locator('.settings-notices').innerText(), /No cambia tu configuración de Claude ni de Codex/);
      assert.match(await page.locator('.settings-notices').innerText(), /sesiones que abras después/);
      await toggle.uncheck(); await saved(page, 'Avisos de Claude Code y Codex desactivados');
      assert.deepEqual(await action(page, 'return [f.providerSaves, f.saves]'), [[false], []], 'only its own call; the limit is not sent');
      assert.equal(await toggle.isChecked(), false);
      await page.getByRole('button', { name: 'Abrir Ajustes de notificaciones' }).click();
      await page.waitForFunction(() => (window as any).fixture.opened === 1);
      assert.match(await status(page), /Notificaciones/);
      // A failed save puts the control back on the runner's value and says so.
      await action(page, 'f.saveError = true');
      await toggle.click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('.form-error')!.hidden);
      assert.equal(await toggle.isChecked(), false);
      // Pulso access depends on the runner offering it, not on the file schema (an early 1.4.0 answered 3).
      const v3 = await mounted('f.provider = true; f.settings = { ...f.settings, schemaVersion: 3, providerSignals: false };');
      await v3.locator('#opener').click(); await ready(v3);
      assert.equal(await v3.getByLabel('Acceso automático a Pulso').isDisabled(), false);
      assert.equal(await v3.locator('.settings-pulso .settings-unavailable').isHidden(), true);
      // A runner without the setting: the toggle is disabled and the reason is shown.
      const old = await mounted('f.provider = true;');
      await old.locator('#opener').click(); await ready(old);
      assert.equal(await old.getByLabel('Avisos de Claude Code y Codex').isDisabled(), true);
      assert.match(await old.locator('.settings-notices').innerText(), /Este runner no ofrece estos avisos/);
    });

    await t.test('native focus and Escape; every change applies at once, nothing on open; no Guardar; terminal geometry stable', async () => {
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
      assert.match(await page.locator('dialog').innerText(), /se aplican y se guardan al momento/);
      assert.match(await page.locator('.settings-sessions').innerText(), /Hasta 2 sesiones a la vez/);
      assert.equal(await page.getByRole('button', { name: 'Guardar', exact: true }).count(), 0, 'one saving model: no Guardar');
      assert.deepEqual(await action(page, 'return [f.saves, f.themes, f.saved, f.fonts, f.groupings]'), [[], [], [], [], []]);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog')!.contains(document.activeElement)), true, 'native dialog can yield one Tab stop to browser chrome; background stays inert');
      }
      await page.getByLabel('Tema de colores').selectOption('dark');
      assert.deepEqual(await action(page, 'return [f.themes, f.saves]'), [['dark'], []], 'appearance applies at once, alone');
      assert.match(await status(page), /Tema de colores: Oscura/);
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('4'); await saved(page);
      assert.deepEqual(await action(page, 'return [f.saves, f.autoSaves, f.saved.length, f.saved[0].maxConcurrentSessions]'), [[4], [true], 1, 4], 'both keys, once');
      assert.match(await status(page), /Guardado: 4 sesiones a la vez; acceso automático a Pulso activado/);
      assert.match(await page.locator('.settings-sessions').innerText(), /Hasta 4 sesiones a la vez/);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.waitForFunction(() => document.activeElement?.id === 'opener');
      assert.deepEqual(await page.locator('#pty').boundingBox(), bounds);
    });

    await t.test('the limit only offers 1 to the server cap; an out-of-range value is never saved', async () => {
      const page = await mounted('f.settings.maxSupportedSessions = 3;');
      await page.locator('#opener').click(); await ready(page);
      const limit = page.getByLabel('Máximo de sesiones simultáneas');
      assert.deepEqual(await limit.locator('option').evaluateAll(o => o.map(n => [(n as HTMLOptionElement).value, n.textContent])), [['1', '1 sesión'], ['2', '2 sesiones'], ['3', '3 sesiones']]);
      for (const value of ['0', '4', '9', '1.5', '']) {
        await limit.evaluate((select: HTMLSelectElement, value) => { const o = document.createElement('option'); o.value = value; select.append(o); select.value = value; select.dispatchEvent(new Event('change')); o.remove(); }, value);
        assert.deepEqual(await action(page, 'return f.saves'), [], `forged ${value}`);
        assert.equal(await limit.inputValue(), '2', 'the control goes back to the runner value');
      }
      await limit.selectOption('3'); await saved(page);
      assert.deepEqual(await action(page, 'return f.saves'), [3]);
      // Selecting the value already saved sends nothing.
      await limit.selectOption('3'); await page.waitForTimeout(100);
      assert.deepEqual(await action(page, 'return f.saves'), [3]);
    });

    await t.test('Pulso access starts enabled, saves a clear opt out at once and keeps the full scope warning', async () => {
      const page = await mounted();
      await page.locator('#opener').click(); await ready(page);
      const toggle = page.getByRole('checkbox', { name: 'Acceso automático a Pulso' });
      assert.equal(await toggle.isChecked(), true);
      const text = await page.locator('.settings-pulso').innerText();
      for (const phrase of [/sesión nueva de Claude Code o Codex que abras desde Jauría/, /leer y editar todos tus proyectos de Pulso/, /crear proyectos nuevos/, /No ve los Pendientes/,
        /puede llegar al proveedor/, /se retira solo al terminar/, /archivos, comandos o red/, /fuera de Jauría/, /corta al momento el acceso automático de todas las sesiones, también de las abiertas/, /Activado: las sesiones nuevas reciben acceso/])
        assert.match(text, phrase);
      assert.match(await toggle.getAttribute('aria-describedby') ?? '', /scope/);
      await toggle.uncheck(); await saved(page);
      assert.deepEqual(await action(page, 'return [f.saves, f.autoSaves, f.saved[0].pulsoAutoAccess]'), [[2], [false], false]);
      assert.match(await page.locator('.settings-pulso').innerText(), /Desactivado: ninguna sesión lo recibe/);
    });

    await t.test('read failure: runner options disabled with the reason, local options still apply, retry works; runner warnings show', async () => {
      const page = await mounted('f.readError = true;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), true);
      assert.equal(await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).isDisabled(), true);
      assert.match(await page.getByRole('alert').innerText(), /No se pudo leer la configuración/);
      await page.getByLabel('Tema de colores').selectOption('light');
      await page.getByLabel('Tamaño de letra del terminal').selectOption('15');
      assert.deepEqual(await action(page, 'return [f.themes, f.fonts, f.saves]'), [['light'], [15], []]);
      await action(page, 'f.readError = false; f.settings.maxSupportedSessions = 4; f.settings.warning = "Límite actualizado por el runner";');
      await page.getByRole('button', { name: 'Reintentar consulta' }).click(); await ready(page);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), false);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').locator('option').count(), 4);
      assert.match(await page.locator('dialog').innerText(), /Límite actualizado por el runner/);
      assert.equal(await page.getByRole('alert').isVisible(), false);
    });

    await t.test('in flight: a read freezes runner options and refuses close; changes during a save are sent once after it', async () => {
      const page = await mounted('f.holdRead = true;');
      await page.locator('#opener').click();
      await page.keyboard.press('Escape'); await action(page, 'f.panel.close(); f.panel.open();');
      assert.equal(await page.locator('dialog[open]').count(), 1);
      assert.equal(await action(page, 'return f.reads'), 1);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), true);
      await action(page, 'f.resolveRead(f.settings);'); await ready(page);
      await action(page, 'f.holdSave = true;');
      const limit = page.getByLabel('Máximo de sesiones simultáneas');
      await limit.selectOption('5');
      assert.match(await status(page), /Guardando/);
      assert.equal(await page.getByRole('button', { name: 'Guardando…' }).isDisabled(), true);
      await page.keyboard.press('Escape'); await action(page, 'f.panel.close();');
      assert.equal(await page.locator('dialog[open]').count(), 1, 'a save in flight keeps the dialog');
      // Still editable: the latest choice wins and is sent once, after the first save.
      await limit.selectOption('6'); await limit.selectOption('7');
      await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).uncheck();
      assert.deepEqual(await action(page, 'return f.saves'), [5]);
      await action(page, 'const r = f.resolveSave; f.holdSave = false; r({...f.settings, maxConcurrentSessions: 5, pulsoAutoAccess: true});');
      await page.waitForFunction(() => /7 sesiones.*desactivado/.test(document.querySelector('.settings-dialog-status')?.textContent ?? ''));
      assert.deepEqual(await action(page, 'return [f.saves, f.autoSaves, f.saved.length]'), [[5, 7], [true, false], 2]);
      assert.equal(await limit.inputValue(), '7');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
    });

    await t.test('a failed save puts the control back on the runner value and says so', async () => {
      const page = await mounted('f.saveError = true;');
      await page.locator('#opener').click(); await ready(page);
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('5');
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').innerText(), /No se pudo guardar. Sigue el valor anterior: 2 sesiones a la vez, acceso automático activado/);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '2');
      assert.deepEqual(await action(page, 'return f.saved'), []);
      // The switch springs back too (a click, since its state does not stay changed).
      await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).click();
      await page.waitForFunction(() => (document.querySelector('input[type=checkbox]') as HTMLInputElement).checked && /acceso automático activado/.test(document.querySelector('[role=alert]')?.textContent ?? ''));
      assert.deepEqual(await action(page, 'return [f.saves, f.autoSaves]'), [[5, 2], [true, false]]);
      await action(page, 'f.saveError = false;');
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('5'); await saved(page);
      assert.equal(await page.getByRole('alert').isVisible(), false);
    });

    await t.test('a failed save reverts only what it sent: a change queued meanwhile is still sent', async () => {
      const page = await mounted('f.holdSave = true;');
      await page.locator('#opener').click(); await ready(page);
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('5');
      // Queued while the first save is pending: the Pulso switch.
      await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).uncheck();
      assert.deepEqual(await action(page, 'return f.saves'), [5]);
      await action(page, 'const r = f.resolveSave; f.holdSave = false; f.resolveSave = null; r(Promise.reject(Error("Synthetic save error")));');
      await page.waitForFunction(() => (window as any).fixture.saves.length === 2);
      await page.waitForFunction(() => /desactivado/.test(document.querySelector('.settings-dialog-status')?.textContent ?? ''));
      // The limit that failed goes back to the runner value; the queued switch reaches the runner.
      assert.deepEqual(await action(page, 'return [f.saves, f.autoSaves]'), [[5, 2], [true, false]]);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '2');
      assert.equal(await page.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).isChecked(), false);
    });

    await t.test('the queue follows the latest choice, not values: 2 → 5 (pending) → 6 → 5 with the first save failing sends 5 (Codex ronda 2, 7)', async () => {
      const page = await mounted('f.holdSave = true;');
      await page.locator('#opener').click(); await ready(page);
      const limit = page.getByLabel('Máximo de sesiones simultáneas');
      await limit.selectOption('5');
      await limit.selectOption('6'); await limit.selectOption('5');
      assert.deepEqual(await action(page, 'return f.saves'), [5]);
      await action(page, 'const r = f.resolveSave; f.holdSave = false; f.resolveSave = null; r(Promise.reject(Error("Synthetic save error")));');
      await page.waitForFunction(() => (window as any).fixture.saves.length === 2);
      await page.waitForFunction(() => /5 sesiones/.test(document.querySelector('.settings-dialog-status')?.textContent ?? ''));
      assert.deepEqual(await action(page, 'return f.saves'), [5, 5], 'the last choice (5) is sent again after the failure');
      assert.equal(await limit.inputValue(), '5');
    });

    await t.test('forced native close during a save reopens; an intentional close event cannot undo a rapid reopen', async () => {
      const page = await mounted('f.holdSave = true;');
      await page.locator('#opener').click(); await ready(page);
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('3');
      await page.locator('dialog').evaluate((dialog: HTMLDialogElement) => dialog.close());
      await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
      await action(page, 'f.resolveSave({...f.settings, maxConcurrentSessions: 3});'); await ready(page);
      await action(page, 'f.panel.close(); f.panel.open();'); await ready(page);
      assert.equal(await page.locator('dialog[open]').count(), 1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('dialog')?.open === false);
    });

    await t.test('older runner: theme and local options only; the limit says why it cannot change', async () => {
      const page = await mounted('f.editable = false; f.readError = true;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), true);
      await page.getByLabel('Tema de colores').selectOption('dark');
      assert.deepEqual(await action(page, 'return [f.saves, f.themes, f.saved]'), [[], ['dark'], []]);
      const old = await mounted('f.editable = false; f.settings = { schemaVersion: 1, maxConcurrentSessions: 2, maxSupportedSessions: 2, warning: null };');
      await old.locator('#opener').click(); await ready(old);
      assert.match(await old.locator('.settings-sessions').innerText(), /no permite cambiar el máximo/);
      assert.equal(await old.getByRole('checkbox', { name: 'Acceso automático a Pulso' }).isDisabled(), true);
      assert.match(await old.locator('.settings-pulso').innerText(), /no ofrece el acceso automático/);
    });

    await t.test('dispose fences late reads and saves, including onSaved side effects', async () => {
      for (const operation of ['read', 'save']) {
        const page = await mounted(operation === 'read' ? 'f.holdRead = true;' : 'f.holdSave = true;');
        await page.locator('#opener').click();
        if (operation === 'save') { await ready(page); await page.getByLabel('Máximo de sesiones simultáneas').selectOption('4'); }
        await action(page, `f.panel.dispose(); f.panel.dispose(); f.resolve${operation === 'read' ? 'Read' : 'Save'}(f.settings);`);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
        assert.equal(await page.locator('dialog').count(), 0);
        assert.deepEqual(await action(page, 'return [f.themes, f.saved, f.panel.isOpen]'), [[], [], false]);
        await action(page, 'f.panel.open(); f.panel.close();');
        assert.equal(await page.locator('dialog').count(), 0);
      }
    });

    await t.test('malformed read and save responses never apply', async () => {
      const page = await mounted('f.settings.maxSupportedSessions = 0;');
      await page.locator('#opener').click(); await ready(page);
      assert.equal(await page.getByRole('alert').isVisible(), true);
      await action(page, 'f.settings.maxSupportedSessions = 8;');
      await page.getByRole('button', { name: 'Reintentar consulta' }).click(); await ready(page);
      await action(page, 'f.holdSave = true;');
      await page.getByLabel('Máximo de sesiones simultáneas').selectOption('6');
      await action(page, 'f.resolveSave({...f.settings, maxConcurrentSessions: 9});'); await ready(page);
      assert.equal(await page.getByRole('alert').isVisible(), true);
      assert.deepEqual(await action(page, 'return f.saved'), []);
      assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '2');
    });

    await t.test('local view options: terminal font, grouping and sidebar reset, each at once and confirmed', async () => {
      const page = await mounted();
      await page.locator('#opener').click(); await ready(page);
      const font = page.getByLabel('Tamaño de letra del terminal');
      assert.equal(await font.inputValue(), '13');
      assert.deepEqual(await font.locator('option').evaluateAll(o => o.map(n => (n as HTMLOptionElement).value)), ['11', '12', '13', '14', '15', '16', '17', '18']);
      await font.selectOption('17');
      assert.match(await status(page), /Letra del terminal: 17 px/);
      assert.match(await page.locator('.settings-appearance').innerText(), /Letra de 17 px en todos los terminales/);
      await page.getByLabel('Agrupar agentes').selectOption('state');
      await page.getByRole('button', { name: 'Restablecer tamaño y secciones de la barra lateral' }).click();
      assert.deepEqual(await action(page, 'return [f.fonts, f.groupings, f.resets, f.saves]'), [[17], ['state'], 1, []]);
      const bare = await mounted('f.local = false;');
      await bare.locator('#opener').click(); await ready(bare);
      assert.equal(await bare.locator('.settings-sidebar').count(), 0, 'no Barra lateral section without its callbacks');
      assert.equal(await bare.getByLabel('Tamaño de letra del terminal').count(), 0);
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

/** «Nueva sesión» (1.4.0) in the real shell with the synthetic boundary: order, copy, tools,
 * folders and recents, Pulso project link and its retry, capacity and reasons, keyboard, 760×560.
 * NEW_SESSION_SCREENSHOT_DIR also saves the dialog in light and dark at 1220×800 and 760×560. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { installWorkbench, workbenchReady, type WorkbenchOptions } from './workbench-fixture.ts';

const server = await createServer({ configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const wb = (page: Page, source: string) => page.evaluate(source => Function('w', source)((window as any).workbench), source);
// The fixture records runner/Pulso operation names in `calls`; started sessions are appended to `sessions`.
const startCalls = (page: Page) => page.evaluate(() => (window as any).workbench.calls.filter((op: string) => op === 'start').length) as Promise<number>;
const lastSession = (page: Page) => page.evaluate(() => (window as any).workbench.sessions.at(-1));
async function openDialog(page: Page) {
  await page.locator('#new-session').click();
  await page.locator('#new-session-dialog[open]').waitFor();
  await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement)?.value === '/synthetic-home');
}

try {
  for (const engine of process.env.NEW_SESSION_BROWSER === '0' ? [] : [chromium, webkit]) {
    await test(`${engine.name()}: Nueva sesión`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {}); t.after(() => browser.close());
      async function open(options: WorkbenchOptions = {}, size = { width: 1220, height: 800 }) {
        const page = await browser.newPage({ viewport: size }); t.after(() => page.close());
        await installWorkbench(page, options); await workbenchReady(page, url); return page;
      }

      await t.test('order, copy, provider marks, capacity and focus on the selected tool', async () => {
        const page = await open();
        await openDialog(page);
        const dialog = page.getByRole('dialog', { name: 'Nueva sesión' });
        assert.equal(await page.locator('#new-session-subtitle').innerText(), 'Elige una herramienta y una carpeta para empezar.');
        assert.doesNotMatch(await dialog.innerText(), /sin crear un proyecto|sin registrar un proyecto|worktrees/i);
        const order = await dialog.locator('fieldset legend, .form-field:not([hidden]) > label, .new-session-footer').evaluateAll(ns => ns.map(n => n.tagName === 'FOOTER' ? 'pie' : n.textContent!.trim()));
        assert.deepEqual(order, ['Herramienta', 'Carpeta de trabajo', 'Proyecto de Pulso (opcional)', 'Nombre de la sesión (opcional)', 'pie']);
        assert.deepEqual(await dialog.locator('.provider-option .provider-badge').evaluateAll(ns => ns.map(n => n.getAttribute('data-provider'))), ['codex', 'claude', 'terminal']);
        assert.equal(await page.locator('#start-session').innerText(), 'Abrir sesión');
        assert.match(await page.locator('#cancel-session').getAttribute('class') ?? '', /secondary/);
        assert.equal(await page.locator('#session-capacity').innerText(), '2 de 8 plazas ocupadas · 6 disponibles');
        // Codex CLI missing in the fixture: disabled, said so, and the dialog chose an available tool.
        assert.equal(await page.locator('input[name=provider][value=codex]').isDisabled(), true);
        assert.equal(await page.locator('#new-codex-status').innerText(), 'CLI no instalada');
        assert.equal(await page.locator('#provider-help').isVisible(), true);
        assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.value), 'claude');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.value), 'terminal', 'arrows move inside the group');
        assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ''), '', 'nothing (the title included) is selected on open');
        assert.equal(await page.locator('#folder-error').isHidden(), true);
      });

      await t.test('Comprobar otra vez enables a CLI that is now installed', async () => {
        const page = await open(); await openDialog(page);
        await wb(page, "w.setTools([{tool:'claude',available:true},{tool:'codex',available:true}])");
        await page.getByRole('button', { name: 'Comprobar otra vez', exact: true }).click();
        await page.waitForFunction(() => !(document.querySelector('input[name=provider][value=codex]') as HTMLInputElement).disabled);
        assert.equal(await page.locator('#new-codex-status').innerText(), 'CLI disponible'); assert.equal(await page.locator('#provider-help').isHidden(), true);
      });

      await t.test('folders: home first, another folder, recents per profile, a missing folder beside the field', async () => {
        const page = await open(); await openDialog(page);
        assert.equal(await page.locator('#session-folder option').first().innerText(), 'Mi carpeta personal · /synthetic-home');
        await wb(page, "w.nextDirectory='/synthetic-home/app'");
        await page.getByRole('button', { name: 'Elegir otra carpeta…', exact: true }).click();
        await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement).value === '/synthetic-home/app');
        await page.locator('input[name=provider][value=terminal]').check();
        await wb(page, "w.failStart('working directory is unavailable')");
        await page.locator('#start-session').click();
        await page.locator('#folder-error').getByText('Esta carpeta ya no existe. Elige otra carpeta.').waitFor();
        assert.equal(await page.locator('#new-session-dialog').evaluate(d => (d as HTMLDialogElement).open), true);
        assert.equal(await page.locator('#start-session').isDisabled(), true);
        assert.equal(await page.locator('#start-blocked-text').innerText(), 'Esta carpeta ya no existe. Elige otra carpeta.');
        await page.locator('#session-folder').selectOption('/synthetic-home/app');
        await page.locator('#session-title').fill('Con carpeta');
        await page.locator('#start-session').click(); await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal(await startCalls(page), 2);
        assert.equal((await lastSession(page)).cwd, '/synthetic-home/app');
        await openDialog(page);
        assert.deepEqual(await page.locator('#session-folder optgroup[label="Recientes"] option').allInnerTexts(), ['~/app']);
        assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('jauria-new-session:recent-folders:'))), ['jauria-new-session:recent-folders:/synthetic-profile']);
      });

      await t.test('a Pulso project is linked without changing its main session; a failed link retries only the link', async () => {
        const page = await open(); await openDialog(page);
        await page.locator('#session-project').selectOption('p0'); await page.locator('input[name=provider][value=terminal]').check();
        await page.locator('#start-session').click(); await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        const calls: string[] = await page.evaluate(() => (window as any).workbench.calls);
        const started = (await lastSession(page)).id;
        const links = await page.evaluate(() => (window as any).workbench.links);
        assert.equal(links.length, 1); assert.equal(links[0].projectId, 'p0'); assert.equal(links[0].sessionId, started);
        assert.equal(calls.filter(op => op === 'project_update').length, 0, 'the main session is not changed');
        await wb(page, "w.failLinks.push('p1')"); await openDialog(page);
        await page.locator('#session-project').selectOption('p1'); await page.locator('input[name=provider][value=terminal]').check();
        await page.locator('#start-session').click();
        await page.getByText('La sesión se abrió, pero no quedó vinculada a «Proyecto sintético 2».').waitFor();
        assert.equal(await page.locator('#start-session').isHidden(), true, 'no second session from this dialog');
        assert.equal(await startCalls(page), 2);
        await wb(page, 'w.failLinks.length=0');
        await page.getByRole('button', { name: 'Reintentar vínculo', exact: true }).click();
        await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal(await startCalls(page), 2);
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.links.map((l: any) => l.projectId)), ['p0', 'p1']);
      });

      await t.test('no slots: the exact reason sits beside the disabled button; Claude in the same folder is a warning', async () => {
        const page = await open({ limit: 3 }); await openDialog(page);
        await wb(page, "w.nextDirectory='/synthetic/open-0'"); await page.getByRole('button', { name: 'Elegir otra carpeta…', exact: true }).click();
        await page.locator('input[name=provider][value=claude]').check();
        await page.locator('#session-conflict').getByText('Ya hay otra sesión de Claude Code en esta carpeta. Ambas podrían modificar los mismos archivos.').waitFor();
        assert.equal(await page.locator('#start-session').isEnabled(), true, 'a warning, not a block');
        await wb(page, "w.sessions.push({id:'extra',title:'Otra',kind:'terminal',cwd:'/x',status:'running',rows:24,cols:80})");
        await page.locator('#start-blocked-text').getByText('No quedan plazas (3 de 3). Termina una sesión o cambia el límite en Configuración.').waitFor({ timeout: 5000 });
        assert.equal(await page.locator('#start-session').isDisabled(), true);
        assert.equal(await page.locator('#session-capacity').innerText(), '3 de 3 plazas ocupadas · 0 disponibles');
      });

      await t.test('a project archived while the dialog is open is refused beside the field, before any session opens', async () => {
        const page = await open(); await openDialog(page);
        await page.locator('#session-project').selectOption('p0'); await page.locator('input[name=provider][value=terminal]').check();
        await wb(page, "w.archive('p0')");
        await page.locator('#start-session').click();
        await page.locator('#session-project-error').getByText('Ese proyecto ya no está abierto; elige otro o Sin proyecto.').waitFor();
        assert.equal(await startCalls(page), 0); assert.equal(await page.locator('#session-project').inputValue(), '');
        assert.equal(await page.locator('#new-session-dialog').evaluate(d => (d as HTMLDialogElement).open), true);
      });
      await t.test('while it opens every field is locked and the captured project and name are what is sent', async () => {
        const page = await open(); await openDialog(page);
        await page.locator('#session-project').selectOption('p0'); await page.locator('input[name=provider][value=terminal]').check();
        await page.locator('#session-title').fill('Nombre A'); await wb(page, 'w.holdStart=true');
        await page.locator('#start-session').click(); await page.waitForFunction(() => typeof (window as any).workbench.releaseStart === 'function');
        assert.equal(await page.locator('#start-session').innerText(), 'Abriendo sesión…');
        for (const id of ['#session-project', '#session-title', '#session-folder', 'input[name=provider][value=claude]', 'input[name=provider][value=terminal]']) assert.equal(await page.locator(id).isDisabled(), true, id);
        await wb(page, 'w.releaseStart()'); await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal((await lastSession(page)).title, 'Nombre A');
        assert.deepEqual(await page.evaluate(() => (window as any).workbench.links.map((l: any) => l.projectId)), ['p0']);
      });
      await t.test('an older CLI check arriving last never marks an installed CLI as missing again', async () => {
        const page = await open(); await openDialog(page);
        await wb(page, 'w.holdProbe=true'); await page.getByRole('button', { name: 'Comprobar otra vez', exact: true }).click();
        await page.waitForFunction(() => typeof (window as any).workbench.releaseProbe === 'function');
        assert.equal(await page.locator('#recheck-tools').isDisabled(), true, 'no second check while one is running');
        // The held (older) check saw Codex missing; meanwhile Codex is installed and a send checks again.
        await wb(page, "w.setTools([{tool:'claude',available:true},{tool:'codex',available:true}])");
        await page.locator('input[name=provider][value=claude]').check(); await page.locator('#start-session').click();
        await page.waitForFunction(() => (window as any).workbench.probes >= 2);
        await wb(page, 'w.releaseProbe()'); await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        await openDialog(page);
        assert.equal(await page.locator('#new-codex-status').innerText(), 'CLI disponible');
        assert.equal(await page.locator('input[name=provider][value=codex]').isDisabled(), false);
      });
      await t.test('a folder with a line break opens normally; it is just not kept in Recientes', async () => {
        const page = await open(); await openDialog(page);
        await wb(page, "w.nextDirectory='/synthetic-home/a\\nb'"); await page.getByRole('button', { name: 'Elegir otra carpeta…', exact: true }).click();
        await page.locator('input[name=provider][value=terminal]').check(); await page.locator('#start-session').click();
        await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal((await lastSession(page)).cwd, '/synthetic-home/a\nb');
        await openDialog(page); assert.equal(await page.locator('#session-folder optgroup[label="Recientes"]').count(), 0);
      });
      await t.test('Nueva sesión en esta carpeta fills the folder and opens there', async () => {
        const page = await open(); await page.locator('.pane:nth-child(1) .pane-menu summary').click();
        await page.locator('.pane:nth-child(1) [data-action="new-in-folder"]').click(); await page.locator('#new-session-dialog[open]').waitFor();
        await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement)?.value === '/synthetic/open-0');
        assert.equal(await page.locator('#session-folder optgroup[label="Carpeta elegida"] option').innerText(), '/synthetic/open-0');
        await page.locator('input[name=provider][value=terminal]').check(); await page.locator('#start-session').click();
        await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal((await lastSession(page)).cwd, '/synthetic/open-0');
      });
      await t.test('keyboard: Enter sends a valid form once; Escape closes and returns focus to the opener', async () => {
        const page = await open(); await openDialog(page);
        await page.locator('input[name=provider][value=terminal]').check();
        await page.locator('#session-title').fill('Desde el teclado'); await page.locator('#session-title').press('Enter'); await page.locator('#session-title').press('Enter').catch(() => {});
        await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        assert.equal(await startCalls(page), 1);
        await page.locator('#new-session').focus(); await page.keyboard.press('Enter'); await page.locator('#new-session-dialog[open]').waitFor();
        await page.keyboard.press('Escape'); await page.locator('#new-session-dialog[open]').waitFor({ state: 'detached' });
        // Focus returns in the dialog's `close` task, after `open` is gone: wait for it to land.
        await page.waitForFunction(() => document.activeElement?.id === 'new-session', undefined, { timeout: 2000 });
      });

      await t.test('at 760×560 the dialog fits without horizontal scroll', async () => {
        const page = await open({}, { width: 760, height: 560 });
        await page.locator('#tab-new-session').click(); await page.locator('#new-session-dialog[open]').waitFor();
        const box = await page.locator('#new-session-dialog').evaluate(d => { const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, sw: d.scrollWidth, cw: d.clientWidth }; });
        assert.ok(box.left >= 0 && box.right <= 760, JSON.stringify(box)); assert.ok(box.sw <= box.cw, JSON.stringify(box));
        await page.locator('#start-session').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#start-session').isVisible(), true);
      });

      const dir = process.env.NEW_SESSION_SCREENSHOT_DIR;
      if (dir && engine === chromium) for (const theme of ['light', 'dark']) for (const size of [{ width: 1220, height: 800 }, { width: 760, height: 560 }]) await t.test(`capture ${theme} ${size.width}`, async () => {
        await mkdir(dir, { recursive: true });
        const page = await open({}, size); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.locator('#tab-new-session').click(); await page.waitForFunction(() => (document.querySelector('#session-folder') as HTMLSelectElement)?.value === '/synthetic-home');
        await page.waitForTimeout(250); await page.screenshot({ path: `${dir}/nueva-sesion-${theme}-${size.width}.png`, animations: 'disabled' });
      });
    });
  }
} finally { await server.close(); }

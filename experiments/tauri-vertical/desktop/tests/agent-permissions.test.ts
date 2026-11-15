/** Synthetic, isolated Settings fixture. No application shell, profile or runner.
 * SETTINGS_PANEL_BROWSER=1 node --test tests/agent-permissions.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type Page } from 'playwright';

if (process.env.SETTINGS_PANEL_BROWSER !== '1') {
  test('permissions browsers require SETTINGS_PANEL_BROWSER=1', { skip: true }, () => {});
} else {
  const root = new URL('../', import.meta.url);
  const bundle = await build({ entryPoints: [new URL('src/settings-panel.ts', root).pathname], bundle: true, write: false, format: 'iife', globalName: 'Settings', loader: { '.css': 'empty' } });
  const styles = (await Promise.all(['style.css', 'settings-panel.css'].map(name => readFile(new URL(`src/${name}`, root), 'utf8')))).join('\n');
  const act = (page: Page, code: string) => page.evaluate(code => Function('f', code)((window as any).f), code);
  const ready = (page: Page) => page.waitForFunction(() => document.querySelector('.settings-permissions')?.getAttribute('aria-busy') === 'false' && document.querySelector('.settings-dialog')?.getAttribute('aria-busy') === 'false');
  async function fixture(browser: Browser) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.setContent('<dialog id="pulso"><button id="opener">Configurar permisos…</button></dialog><aside id="old"><section class="settings-section"><button id="enable-native-notifications">Activar avisos</button></section></aside>');
    await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const w = window as any;
      const f = w.f = { calls: [] as any[], themes: [] as string[], editable: true, available: true, attention: 0, notices: 0, copied: [] as string[],
        hold: '', pending: null as any, fail: false, projectPages: null as any, failPolicies: false,
        sessions: [{ id: 's1', title: 'Synthetic Claude', kind: 'claude', cwd: '/synthetic/work', status: 'running' }, { id: 's2', title: 'Synthetic Codex', kind: 'codex', cwd: '/synthetic/two', status: 'starting' }, { id: 'old', title: 'Closed history', kind: 'codex', cwd: '/synthetic/old', status: 'exited' }],
        policies: [{ id: 'p1', policy: { provider: 'claude', cwd: '/synthetic/work', projectId: 'project1' } }, { id: 'p2', policy: { provider: 'codex', cwd: '/synthetic/two', projectId: 'missing-project' } }],
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { f.copied.push(value); } } });
      const notifications = document.querySelector('#enable-native-notifications')!;
      notifications.addEventListener('click', () => f.notices++);
      f.controls = notifications.closest('.settings-section');
      f.panel = w.Settings.mountSettings({
        read: async () => ({ schemaVersion: 1, maxConcurrentSessions: 2, maxSupportedSessions: 8 }),
        save: async (limit: number) => ({ schemaVersion: 1, maxConcurrentSessions: limit, maxSupportedSessions: 8 }),
        canEdit: () => f.editable, getTheme: () => 'system', setTheme: (t: string) => f.themes.push(t), onSaved: () => {}, version: '1.2.0',
        notificationControls: f.controls, onOpenAttention: () => f.attention++,
        permissions: { available: () => f.available, sessions: () => f.sessions, request: async (op: string, args: any) => {
          f.calls.push([op, args]);
          if (f.hold === op) return new Promise(resolve => { f.pending = resolve; });
          if (f.fail || (op === 'policies' && f.failPolicies)) throw Error('secret-error-token');
          if (op === 'policies') return { policies: structuredClone(f.policies) };
          if (op === 'projects' && f.projectPages) return structuredClone(f.projectPages[args.cursor]);
          if (op === 'projects') return { projects: [{ id: 'project1', title: 'Synthetic project' }], hasMore: true };
          if (op === 'grant') return { command: "jauria-pulso --handle '/synthetic/safe-handle'", token: 'secret-token', handle: 'secret-handle', guidance: 'secret-guidance' };
          if (op === 'revoke_policy') f.policies = f.policies.filter((p: any) => p.id !== args.id);
          return {};
        } },
      });
      document.querySelector<HTMLDialogElement>('#pulso')!.showModal();
      document.querySelector('#opener')!.addEventListener('click', () => f.panel.open('permissions', f.context));
    });
    return page;
  }
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: global agent permissions`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {}); t.after(() => browser.close());
      const mounted = async () => { const page = await fixture(browser); t.after(() => page.close()); return page; };
      const open = async (page: Page) => { await page.locator('#opener').focus(); await page.keyboard.press('Enter'); await ready(page); };
      await t.test('bounded reads only, live sessions, opt-in grant, safe command, project policy names and explicit revocations', async () => {
        const page = await mounted();
        assert.deepEqual(await act(page, 'return f.calls'), []);
        await open(page);
        assert.deepEqual(await act(page, 'return f.calls'), [['policies', {}], ['projects', { limit: 50, cursor: 0, archived: false }]]);
        assert.equal(await page.locator('form form').count(), 0);
        assert.equal(await page.getByLabel('Sesión que recibirá permiso').locator('option').count(), 3);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), '');
        assert.equal(await page.getByRole('checkbox').isChecked(), false);
        assert.match(await page.locator('.settings-permissions').innerText(), /Synthetic project/);
        assert.match(await page.locator('.settings-permissions').innerText(), /missing-project/);
        await page.getByLabel('Sesión que recibirá permiso').selectOption('s1');
        await page.getByRole('button', { name: 'Permitir registrar planes' }).click(); await ready(page);
        assert.deepEqual(await act(page, 'return f.calls.find(c => c[0] === "grant")'), ['grant', { sessionId: 's1', canCreateProjects: true }]);
        assert.equal(await page.getByLabel('Comando de registro').inputValue(), "jauria-pulso --handle '/synthetic/safe-handle'");
        assert.doesNotMatch(await page.locator('body').evaluate(el => el.outerHTML + Array.from(el.querySelectorAll('input,textarea')).map(n => (n as HTMLInputElement).value).join('')), /secret-token|secret-handle|secret-guidance/);
        await page.getByRole('button', { name: 'Copiar comando de registro' }).click();
        assert.deepEqual(await act(page, 'return f.copied'), ["jauria-pulso --handle '/synthetic/safe-handle'"]);
        await page.getByLabel('Alcance del permiso').selectOption('project1'); await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Permitir registrar planes' }).click(); await ready(page);
        assert.deepEqual(await act(page, 'return f.calls.filter(c => c[0] === "grant").at(-1)'), ['grant', { sessionId: 's1', projectId: 'project1', canCreateProjects: false, remember: true }]);
        await page.getByRole('button', { name: 'Revocar permiso de la sesión' }).click(); await ready(page);
        assert.deepEqual(await act(page, 'return f.calls.at(-1)'), ['revoke', { sessionId: 's1' }]);
        await page.getByRole('button', { name: 'Revocar permiso recordado', exact: true }).first().click(); await ready(page);
        assert.equal(await page.getByRole('button', { name: 'Revocar permiso recordado', exact: true }).count(), 1);
        assert.deepEqual(await act(page, 'return f.calls.filter(c => c[0] === "revoke_policy")'), [['revoke_policy', { id: 'p1' }]]);
      });
      await t.test('unknown context cannot silently grant bootstrap; settings drafts survive refresh; old settings capability is independent', async () => {
        const page = await mounted(); await act(page, 'f.context = {projectId:"unlisted",sessionId:"s2"}; f.editable = false;'); await open(page);
        assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Permitir registrar planes' }).isDisabled(), true);
        assert.equal(await page.getByLabel('Sesión que recibirá permiso').inputValue(), 's2');
        await page.getByLabel('Apariencia').selectOption('dark');
        await page.getByLabel('Alcance del permiso').selectOption('project1');
        await page.getByRole('button', { name: 'Permitir registrar planes' }).click(); await ready(page);
        assert.equal(await page.getByLabel('Apariencia').inputValue(), 'dark'); assert.deepEqual(await act(page, 'return f.themes'), []);
        await act(page, 'f.sessions[1].status = "exited";');
        await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('[id$="-session"]')?.querySelector('option[value="s2"]'));
        assert.equal(await page.getByRole('button', { name: 'Permitir registrar planes' }).isDisabled(), true);
      });
      await t.test('explicit project pages use server cursors, find context beyond 50, deduplicate and stop at exhaustion', async () => {
        const page = await mounted();
        await act(page, `f.context = {projectId:"target",sessionId:"s1"}; f.projectPages = {
          0: {projects: Array.from({length:50},(_,i)=>({id:"project"+i,title:"Project "+i})),hasMore:true,nextCursor:50},
          50: {projects:[{id:"project1",title:"Project 1 updated"},{id:"target",title:"Target project"}],hasMore:true,nextCursor:125},
          125: {projects:[{id:"last",title:"Last project"}],hasMore:false,nextCursor:null}
        };`);
        await open(page);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'target');
        assert.equal(await page.getByRole('button', {name:'Permitir registrar planes'}).isDisabled(), true);
        assert.match(await page.locator('.settings-permissions').innerText(), /Pulsa Más proyectos/);
        assert.equal(await act(page, 'return f.calls.filter(c=>c[0]==="projects").length'), 1);
        await page.getByRole('button', {name:'Más proyectos',exact:true}).click(); await ready(page);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'target');
        assert.equal(await page.getByLabel('Alcance del permiso').locator('option').count(), 52);
        assert.equal(await page.getByRole('button', {name:'Permitir registrar planes'}).isEnabled(), true);
        assert.equal(await act(page, 'return f.calls.filter(c=>c[0]==="projects").length'), 2, 'never auto-fetch the next page');
        await page.getByRole('button', {name:'Más proyectos',exact:true}).click(); await ready(page);
        assert.equal(await page.getByRole('button', {name:'Más proyectos',exact:true}).isVisible(), false);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'target');
        assert.deepEqual(await act(page, 'return f.calls.filter(c=>c[0]==="projects").map(c=>c[1])'), [0,50,125].map(cursor=>({limit:50,cursor,archived:false})));
        assert.equal(await act(page, 'return f.calls.some(c=>!["projects","policies"].includes(c[0]))'), false);
      });
      await t.test('more preserves scope and opt-in on failure/retry, and rejects nonadvancing or oversized pages', async () => {
        const page = await mounted(); await open(page);
        await page.getByLabel('Sesión que recibirá permiso').selectOption('s1');
        await page.getByLabel('Alcance del permiso').selectOption('project1'); await page.getByRole('checkbox').check();
        await act(page, 'f.fail = true;'); await page.getByRole('button', {name:'Más proyectos',exact:true}).click(); await ready(page);
        assert.match(await page.locator('.settings-permissions').innerText(), /No se pudieron cargar más proyectos/);
        for (const response of [
          '{projects:[{id:"bad",title:"Bad cursor"}],hasMore:true,nextCursor:1}',
          '{projects:Array.from({length:51},(_,i)=>({id:"bad"+i,title:"Oversized"})),hasMore:false}',
          '{projects:[{id:"project2",title:"Second project"}],hasMore:false}',
        ]) {
          await act(page, `f.fail=false; f.projectPages={1:${response}};`);
          await page.getByRole('button', {name:'Más proyectos',exact:true}).click(); await ready(page);
          assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'project1');
          assert.equal(await page.getByRole('checkbox').isChecked(), true);
        }
        assert.equal(await page.getByLabel('Alcance del permiso').locator('option').count(), 3);
        assert.deepEqual(await act(page, 'return f.calls.filter(c=>c[0]==="projects").map(c=>c[1].cursor)'), [0,1,1,1,1]);
        await page.getByRole('button', {name:'Permitir registrar planes'}).click(); await ready(page);
        assert.deepEqual(await act(page, 'return f.calls.find(c=>c[0]==="grant")[1]'), {sessionId:'s1',projectId:'project1',canCreateProjects:false,remember:true});
      });
      await t.test('missing context stays blocked after final page, and a late page cannot cross close/reopen', async () => {
        const page = await mounted(); await act(page, 'f.context={projectId:"missing",sessionId:"s1"};'); await open(page);
        await act(page, 'f.hold="projects";'); await page.getByRole('button', {name:'Más proyectos',exact:true}).click();
        await page.getByRole('button', {name:'Cerrar',exact:true}).click();
        await act(page, 'f.oldPending=f.pending; f.hold="";'); await open(page);
        await act(page, 'f.oldPending({projects:[{id:"missing",title:"Late project"}],hasMore:false});');
        assert.equal(await page.getByRole('button', {name:'Permitir registrar planes'}).isDisabled(), true);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'missing');
        assert.equal(await page.getByLabel('Alcance del permiso').locator('option', {hasText:'Late project'}).count(), 0);
        await act(page, 'f.projectPages={1:{projects:[],hasMore:false}};');
        await page.getByRole('button', {name:'Más proyectos',exact:true}).click(); await ready(page);
        assert.match(await page.locator('.settings-permissions').innerText(), /El proyecto solicitado no está disponible/);
        assert.equal(await page.getByLabel('Alcance del permiso').inputValue(), 'missing');
        assert.equal(await page.getByRole('button', {name:'Permitir registrar planes'}).isDisabled(), true);
        assert.equal(await page.getByRole('button', {name:'Más proyectos',exact:true}).isVisible(), false);
        assert.equal(await act(page, 'return f.calls.some(c=>c[0]==="grant")'), false);
      });
      await t.test('picker filters providers, ignores unrelated status fields, and resets on plain reopen', async () => {
        const page = await mounted();
        await act(page, 'f.sessions.push({id:"terminal",title:"Terminal",kind:"terminal",cwd:"/synthetic",status:"running"},{id:"fixture",title:"Fixture",kind:"fixture",cwd:"/synthetic",status:"running"});');
        await open(page);
        const picker = page.getByLabel('Sesión que recibirá permiso');
        assert.equal(await picker.locator('option').count(), 3);
        await picker.selectOption('s1');
        await picker.locator('option[value="s1"]').evaluate(el => { (window as any).f.originalOption = el; });
        await act(page, 'f.sessions[0].programState="working"; f.sessions[0].updatedAt=123;');
        await page.waitForTimeout(1100);
        assert.equal(await picker.locator('option[value="s1"]').evaluate(el => el === (window as any).f.originalOption), true);
        assert.equal(await picker.inputValue(), 's1');
        await page.getByRole('button', {name:'Cerrar',exact:true}).click(); await act(page, 'f.panel.open();'); await ready(page);
        assert.equal(await picker.inputValue(), '');
        assert.equal(await page.getByRole('button', {name:'Permitir registrar planes'}).isDisabled(), true);
      });
      await t.test('legacy policy shows both project and bootstrap flags; grant success survives a policy refresh failure', async () => {
        const page = await mounted();
        await act(page, 'f.policies[0].policy.canCreateProjects=true; f.policies[1].policy.canCreateProjects=false;'); await open(page);
        const rows = page.locator('.settings-permissions-policy');
        assert.match(await rows.first().innerText(), /Proyecto: Synthetic project/);
        assert.match(await rows.first().innerText(), /Puede crear proyectos propios/);
        assert.match(await rows.nth(1).innerText(), /No puede crear proyectos propios/);
        await page.getByLabel('Sesión que recibirá permiso').selectOption('s1');
        await page.getByLabel('Alcance del permiso').selectOption('project1'); await page.getByRole('checkbox').check();
        await act(page, 'f.failPolicies=true;');
        await page.getByRole('button', {name:'Permitir registrar planes'}).click(); await ready(page);
        assert.match(await page.locator('.settings-permissions [role="status"]').innerText(), /Permiso concedido.*No se pudo actualizar la lista/);
        assert.doesNotMatch(await page.locator('.settings-permissions [role="status"]').innerText(), /No se pudo confirmar/);
        assert.equal(await page.getByRole('checkbox').isChecked(), false);
        assert.equal(await page.getByLabel('Comando de registro').inputValue(), "jauria-pulso --handle '/synthetic/safe-handle'");
        await act(page, 'f.failPolicies=false;');
        await page.getByRole('button', {name:'Actualizar permisos y proyectos'}).click(); await ready(page);
        assert.equal(await act(page, 'return f.calls.filter(c=>c[0]==="grant").length'), 1);
      });
      await t.test('closing Settings focuses the underlying drawer when polling replaced its opener', async () => {
        const page = await mounted(); await open(page);
        await act(page, 'document.querySelector("#opener").outerHTML="<button id=replacement>Nuevo control</button>";');
        await page.getByRole('button', {name:'Cerrar',exact:true}).click();
        await page.waitForFunction(() => document.activeElement?.id === 'replacement');
        assert.equal(await page.locator('#pulso[open]').count(), 1);
        // Also cover Escape with a drawer containing no remaining focusable controls.
        await act(page, 'document.querySelector("#replacement").focus(); f.panel.open();'); await ready(page);
        await act(page, 'document.querySelector("#replacement").remove();');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.id === 'pulso');
      });
      await t.test('write guards Escape, public and forced close; returns focus to underlying Pulso; remember resets', async () => {
        const page = await mounted(); await open(page); await page.getByLabel('Sesión que recibirá permiso').selectOption('s1');
        await page.getByRole('checkbox').check(); await act(page, 'f.hold = "grant";');
        await page.getByRole('button', { name: 'Permitir registrar planes' }).click();
        await page.keyboard.press('Escape'); await act(page, 'f.panel.close(); document.querySelector(".settings-dialog").close();');
        await page.waitForFunction(() => document.querySelector<HTMLDialogElement>('.settings-dialog')?.open);
        await act(page, 'f.hold = ""; f.pending({command:"safe-command"});'); await ready(page);
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.id === 'opener');
        assert.equal(await page.locator('#pulso[open]').count(), 1);
        await open(page); assert.equal(await page.getByRole('checkbox').isChecked(), false);
      });
      await t.test('close and profile disposal fence late reads and writes; unavailable makes no RPCs', async () => {
        for (const operation of ['policies', 'grant']) {
          const page = await mounted();
          if (operation === 'policies') await act(page, 'f.hold = "policies";');
          await page.locator('#opener').click();
          if (operation === 'grant') { await ready(page); await page.getByLabel('Sesión que recibirá permiso').selectOption('s1'); await act(page, 'f.hold = "grant";'); await page.getByRole('button', { name: 'Permitir registrar planes' }).click(); }
          await page.waitForFunction(() => (window as any).f.pending !== null);
          await act(page, 'f.available = false; f.panel.dispose(); f.pending({command:"late-secret",policies:[]});');
          assert.equal(await page.locator('.settings-dialog').count(), 0);
          assert.doesNotMatch(await page.locator('body').innerText(), /late-secret/);
          assert.equal(await act(page, 'return f.calls.filter(c => c[0] === "policies").length'), 1);
        }
        const page = await mounted(); await act(page, 'f.available = false;'); await open(page);
        assert.deepEqual(await act(page, 'return f.calls'), []);
      });
      await t.test('read closure fences stale results across reopen; drafts and notification node/listeners survive', async () => {
        const page = await mounted(); await open(page);
        await page.getByLabel('Máximo de sesiones simultáneas').fill('5'); await page.getByLabel('Apariencia').selectOption('light');
        await act(page, 'f.hold = "policies";'); await page.getByRole('button', { name: 'Actualizar permisos y proyectos' }).click();
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
        await act(page, 'f.oldPending = f.pending; f.hold = "";'); await open(page);
        await act(page, 'f.oldPending({policies:[{id:"late",policy:{cwd:"late-cwd"}}]});');
        assert.doesNotMatch(await page.locator('.settings-permissions').innerText(), /late-cwd/);
        assert.equal(await page.getByLabel('Máximo de sesiones simultáneas').inputValue(), '5');
        assert.equal(await page.getByLabel('Apariencia').inputValue(), 'light');
        assert.equal(await page.locator('#enable-native-notifications').count(), 1);
        assert.equal(await act(page, 'return document.querySelector(".settings-dialog").contains(f.controls)'), true);
        assert.equal(await page.locator('#old .settings-section').count(), 0);
        await page.locator('#enable-native-notifications').click(); assert.equal(await act(page, 'return f.notices'), 1);
        await page.getByRole('button', { name: 'Ver sesiones que necesitan atención' }).click();
        assert.equal(await act(page, 'return f.attention'), 1); assert.equal(await page.locator('.settings-dialog[open]').count(), 0);
      });
      await t.test('read failures allow retry without leaking errors; desktop minimum stays bounded', async () => {
        const page = await mounted(); await act(page, 'f.fail = true;'); await open(page);
        assert.match(await page.locator('.settings-permissions').innerText(), /Reintenta la consulta/);
        assert.doesNotMatch(await page.locator('body').innerText(), /secret-error/);
        await act(page, 'f.fail = false;'); await page.getByRole('button', { name: 'Actualizar permisos y proyectos' }).click(); await ready(page);
        for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width: 760, height: 560 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          const bounds = await page.locator('.settings-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, overflow: el.scrollWidth > el.clientWidth }; });
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= 760 && bounds.bottom <= 560); assert.equal(bounds.overflow, false);
          if (process.env.SETTINGS_PANEL_SCREENSHOTS === '1') await page.screenshot({ path: `/tmp/jauria-permissions-${engine.name()}-${theme}.png` });
        }
      });
    });
  }
}

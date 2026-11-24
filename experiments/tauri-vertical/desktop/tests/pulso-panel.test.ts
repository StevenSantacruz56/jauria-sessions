/** Synthetic bridge only. No runner, provider profiles or terminal processes.
 * node --test tests/pulso-panel.test.ts
 * PULSO_PANEL_BROWSER=1 node --test tests/pulso-panel.test.ts
 * PULSO_PANEL_BROWSER=1 PULSO_PANEL_WEBKIT=1 ... also checks WebKit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type Page } from 'playwright';

const root = new URL('../', import.meta.url);
const esm = await build({ entryPoints: [new URL('src/pulso-panel.ts', root).pathname], bundle: true, write: false, format: 'esm', loader: { '.css': 'empty' } });
const model = await import(`data:text/javascript;base64,${Buffer.from(esm.outputFiles[0].text).toString('base64')}`);
test('live means starting/running; attention and unknown states never claim a live PTY', () => {
  for (const status of ['starting', 'running']) assert.equal(model.isLivePulsoSession({ status }), true);
  for (const status of ['needs_attention', 'exited', 'failed', 'unknown']) assert.equal(model.isLivePulsoSession({ status }), false);
});
test('continuation uses the newest checkpoint without mutating append-only history', () => {
  const checkpoints = [{ createdAt: '2026-11-14T12:00:00Z', brief: 'Nuevo', nextAction: 'Seguir' }, { createdAt: '2026-11-13T12:00:00Z', brief: 'Viejo', nextAction: 'Esperar' }];
  const before = structuredClone(checkpoints);
  const value = model.pulsoContinuation({ title: 'Proyecto', plan: '<script>texto</script>' }, { title: 'Fase', note: 'Nota' }, checkpoints);
  assert.match(value, /Plan completo:\n<script>texto<\/script>/);
  assert.match(value, /Último checkpoint:\nNuevo/); assert.doesNotMatch(value, /Viejo/);
  assert.deepEqual(checkpoints, before);
});
test('numeric backend timestamps, numeric strings and ISO history sort consistently', () => {
  const value = model.pulsoContinuation(null, { title: 'Fase', note: '' }, [
    { createdAt: 100, brief: 'Primero', nextAction: '' },
    { createdAt: 1000, brief: 'Último', nextAction: 'Seguir' },
    { createdAt: '900', brief: 'Intermedio', nextAction: '' },
  ]);
  assert.match(value, /Último/); assert.doesNotMatch(value, /Primero|Intermedio/);
});

if (process.env.PULSO_PANEL_BROWSER !== '1') {
  test('browser coverage requires PULSO_PANEL_BROWSER=1', { skip: true }, () => {});
} else {
  const bundle = await build({ entryPoints: [new URL('src/pulso-panel.ts', root).pathname], bundle: true, write: false, format: 'iife', globalName: 'Pulso', loader: { '.css': 'empty' } });
  const styles = (await Promise.all(['style.css', 'pulso-panel.css'].map(name => readFile(new URL(`src/${name}`, root), 'utf8')))).join('\n');
  const run = (page: Page, source: string) => page.evaluate(source => Function('f', source)((window as any).fixture), source);
  const idle = (page: Page) => page.waitForFunction(() => document.querySelector('.pulso-panel')?.getAttribute('aria-busy') === 'false');
  async function fixture(browser: Browser, setup = '') {
    const page = await browser.newPage({ viewport: { width: 1120, height: 850 } });
    page.setDefaultTimeout(5000);
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="stage" style="height:100dvh"></main><input id="pty" aria-label="Terminal sintética">' }));
    await page.goto('http://localhost/'); await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(setup => {
      const w = window as any;
      const stamp = Date.parse('2026-11-14T12:00:00Z');
      const project = (id: string) => ({ id, title: `Proyecto ${id}`, plan: '<script>window.compromised=true</script>\nPlan completo', mainSessionId: 'ended', revision: 1, archived: false, createdAt: stamp, updatedAt: stamp });
      const item = (id: string, projectId: string | null = null) => ({ id, projectId, title: `Fase ${id}`, note: '', status: 'todo', position: 0, revision: 1, archived: false, createdAt: stamp, updatedAt: stamp });
      const f = w.fixture = {
        delayed: [] as any[], holdOps: [] as string[], calls: [] as any[], revision: 1, projects: [project('p1')], items: [item('i1', 'p1'), item('solo')], checkpoints: [] as any[], links: [] as any[],
        policies: [{ id: 'policy-1', policy: { projectId: 'p1', provider: 'claude', cwd: '/synthetic', canCreateProjects: true } }],
        sessions: [{ id: 'ended', title: 'Claude anterior', kind: 'claude', cwd: '/synthetic', status: 'exited' }, { id: 'live', title: 'Claude viva', kind: 'claude', cwd: '/synthetic', status: 'running' }, { id: 'attention', title: 'Sin confirmar', kind: 'claude', cwd: null, status: 'needs_attention' }],
        sessionDialogs: [] as any[], profile: null as string | null, storage: {} as Record<string, string>, bindingFailures: 0, failProjectReads: 0, cacheKey: 'synthetic-connection-1', bindingHeld: [] as any[], holdBinding: false, currentId: 'live',
        opened: [] as string[], created: [] as any[], notices: [] as string[], resumed: [] as string[], bindings: [] as string[], copied: [] as string[],
        receipts: new Map(), failWrite: false, failRead: false, timeoutAfterCommit: false, holdRead: false, held: [] as any[], bindingProvider: 'claude',
        project, item,
      };
      Function('f', setup)(f);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { f.copied.push(text); } } });
      f.request = async (op: string, args: any) => {
        f.calls.push({ op, args: structuredClone(args) });
        const deliver = async (snapshot: any) => {
          const index = f.holdOps.indexOf(op);
          if (index !== -1) { f.holdOps.splice(index, 1); await new Promise(resolve => f.delayed.push({ op, resolve })); if (f.rejectDelayed === op) throw 'delayed read failure'; }
          return snapshot;
        };
        if (f.holdRead && op === 'projects') await new Promise(resolve => f.held.push(resolve));
        if (f.failRead && ['projects', 'board', 'items', 'revision'].includes(op)) throw 'offline';
        if (op === 'revision') return { revision: f.revision };
        if (op === 'board') {
          if (args.ifRevision === f.revision) return { revision: f.revision, unchanged: true };
          const snapshot = { revision: f.revision, columns: Object.fromEntries(['todo', 'doing', 'waiting', 'done'].map(status => {
            const all = f.items.filter((i: any) => !i.archived && i.projectId === args.projectId && i.status === status);
            return [status, { items: structuredClone(all.slice(0, 20)), totalCount: all.length, hasMore: all.length > 20, nextCursor: 20 }];
          })) };
          if (f.holdBoard === args.projectId) await new Promise(resolve => f.held.push(resolve));
          return deliver(snapshot);
        }
        if (op === 'projects' || op === 'items') {
          if (op === 'items' && args.expectedSnapshotRevision !== f.revision) throw 'stale snapshot';
          const all = op === 'projects' ? f.projects.filter((p: any) => args.archived === undefined || p.archived === args.archived) : f.items.filter((i: any) => !i.archived && i.projectId === args.projectId && (!args.status || i.status === args.status));
          const cursor = args.cursor ?? 0; if (typeof cursor !== 'number') throw 'numeric offset required';
          const rows = all.slice(cursor, cursor + args.limit);
          return deliver({ [op]: structuredClone(rows), revision: f.revision, hasMore: all.length > cursor + rows.length, totalCount: all.length, ...(op === 'items' ? { nextCursor: cursor + rows.length } : {}) });
        }
        if (op === 'project') { if(f.failProjectReads>0){f.failProjectReads--;throw new Error('synthetic transient project read');} return deliver({ project: structuredClone(f.projects.find((p: any) => p.id === args.id)) }); }
        if (op === 'item') { const all=f.checkpoints.filter((c:any)=>c.itemId===args.id);return { item: structuredClone(f.items.find((i: any) => i.id === args.id)), links: structuredClone(f.links.filter((l: any) => l.itemId === args.id)), checkpoints: structuredClone(all.slice(-10)), checkpointsHasMore:all.length>10,checkpointCursor:10 }; }
        if(op==='checkpoint_history'){const all=[...f.checkpoints.filter((c:any)=>c.itemId===args.itemId)].reverse();const cursor=args.cursor??0;return{checkpoints:structuredClone(all.slice(cursor,cursor+args.limit)),hasMore:all.length>cursor+args.limit,nextCursor:cursor+args.limit};}
        if (op === 'links') return { links: structuredClone(f.links.filter((l: any) => l.projectId === args.projectId)) };
        if (op === 'grant') return { handle: 'opaque-not-for-dom', token: 'secret-not-for-dom', command: 'jauria pulso --handle /synthetic/handle.json', guidance: 'Ejecuta el comando en la sesión elegida.' };
        if (op === 'revoke') return {};
        if (op === 'policies') return { policies: structuredClone(f.policies) };
        if (op === 'revoke_policy') { f.policies = f.policies.filter((p: any) => p.id !== args.id); return {}; }
        if (f.receipts.has(args.requestId)) return structuredClone(f.receipts.get(args.requestId));
        if (f.failWrite) throw 'timeout or revision conflict';
        let result: any;
        if (op.endsWith('_create') && op !== 'checkpoint_create') {
          const isProject = op === 'project_create'; const row = { ...(isProject ? project(args.id) : item(args.id, args.projectId ?? null)), ...args, revision: ++f.revision };
          (isProject ? f.projects : f.items).push(row); result = { [isProject ? 'project' : 'item']: row };
        } else if (op === 'item_update' || op === 'project_update' || op === 'checkpoint_create') {
          const isProject = op === 'project_update'; const row = (isProject ? f.projects : f.items).find((i: any) => i.id === (args.itemId ?? args.id));
          if (row.revision !== args.expectedRevision) throw 'revision conflict';
          row.revision = ++f.revision;
          if (op === 'checkpoint_create') {
            const checkpoint = { ...args, actor: 'fixture', createdAt: stamp }; f.checkpoints.push(checkpoint); result = { checkpoint, item: row };
          } else { const { id, requestId, expectedRevision, ...patch } = args; Object.assign(row, patch); result = { [isProject ? 'project' : 'item']: row }; }
        } else if (op === 'link') { f.links.push(args); result = { link: args }; }
        else throw `unknown operation ${op}`;
        f.receipts.set(args.requestId, structuredClone(result));
        if (f.timeoutAfterCommit) { f.timeoutAfterCommit = false; throw 'timeout after commit'; }
        return structuredClone(result);
      };
      for (const [key, value] of Object.entries(f.storage)) localStorage.setItem(key, value as string);
      f.mount = () => f.panel = w.Pulso.mountPulsoPanel({
        host: document.querySelector('#stage'), request: f.request, sessions: () => f.sessions, currentSession: () => f.sessions.find((s: any) => s.id === f.currentId) ?? null,
        openSession: (id: string) => f.opened.push(id), newSession: (cwd?: string) => f.created.push(cwd), notice: (text: string) => f.notices.push(text),
        persistenceKey: () => f.profile, bindingCacheKey: () => f.cacheKey,
        // Nueva sesión dialog stand-in: tests call f.sessionDialogs[n](id) as if a session started there.
        startProjectSession: (started: (id: string) => void) => { if (f.dialogUnavailable) return false; f.sessionDialogs.push(started); return true; },
        binding: async (id: string) => {
          f.bindings.push(id);
          const data = { binding: f.bindingProvider ? { provider: f.bindingProvider, conversationId: 'synthetic-conversation' } : null, activeSessionId: f.activeNative ?? null };
          if (f.holdBinding) await new Promise(resolve => f.bindingHeld.push(resolve));
          if (f.bindingFailures > 0) { f.bindingFailures--; throw new Error('synthetic binding unavailable'); }
          return data;
        },
        resumeSession: async (id: string) => { f.resumed.push(id); if (f.resumeError) throw new Error('secret-runner-detail'); },
      });
      f.mount();
    }, setup);
    await run(page, 'f.panel.show()'); await page.getByRole('button', { name: 'Pendientes', exact: true }).waitFor();
    return page;
  }
  // Moving a card without dragging: the card's «…» menu (replaces the native Mover select since 1.4).
  const statusLabels: Record<string, string> = { todo: 'Por hacer', doing: 'En curso', waiting: 'En espera', done: 'Hecho' };
  async function move(p: Page, title: string, status: string) {
    await p.getByRole('button', { name: `Mover ${title}`, exact: true }).click();
    await p.getByRole('menuitem', { name: `Mover a ${statusLabels[status]}`, exact: true }).click();
  }
  const columnOf = (p: Page, title: string) => p.locator('.pulso-card', { has: p.getByRole('button', { name: `Abrir ${title}`, exact: true }) }).getAttribute('data-state');
  for (const engine of process.env.PULSO_PANEL_WEBKIT === '1' ? [chromium, webkit] : [chromium]) {
    await test(`${engine.name()}: Pulso isolated stage`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {}); t.after(() => browser.close());
      async function mounted(setup = '') { const p = await fixture(browser, setup); t.after(() => p.close()); return p; }
      const projectBoard = async (p: Page) => { await p.getByRole('button', { name: 'Proyecto p1', exact: true }).click(); await p.getByRole('button', { name: 'Proyecto', exact: true }).waitFor(); };
      // «Plan y sesiones» became two entries: Proyecto (name and plan, saved by themselves) and Sesiones.
      const projectDetail = async (p: Page) => { await projectBoard(p); assert.equal(await p.locator('dialog[open]').count(), 0); await p.getByRole('button', { name: 'Proyecto', exact: true }).click(); await p.getByLabel('Nombre del proyecto', { exact: true }).waitFor(); };
      const sessionsDetail = async (p: Page) => { await projectBoard(p); assert.equal(await p.locator('dialog[open]').count(), 0); await p.getByRole('button', { name: 'Sesiones', exact: true }).click(); await p.getByLabel('Sesión principal', { exact: true }).waitFor(); };
      const itemDetail = async (p: Page) => { await projectBoard(p); await p.getByRole('button', { name: 'Abrir Fase i1', exact: true }).click(); await p.getByRole('dialog').getByLabel('Título de la fase', { exact: true }).waitFor(); };

      await t.test('capture needs only title; plans are literal text, main session remains canonical', async () => {
        const p = await mounted();
        await p.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Añadir pendiente', exact: true }).click();
        assert.equal(await p.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título del pendiente', { exact: true }).getAttribute('maxlength'), '240');
        await p.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título del pendiente', { exact: true }).fill('Comprar material'); await p.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Añadir pendiente', exact: true }).click(); await idle(p);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_create")'); assert.equal(calls.length, 1);
        assert.deepEqual(Object.keys(calls[0].args).sort(), ['id', 'projectId', 'requestId', 'status', 'title']);
        await projectDetail(p);
        assert.match(await p.getByLabel('Plan (opcional) ·').inputValue(), /<script>/); assert.equal(await run(p, 'return window.compromised'), undefined);
        assert.equal(await p.getByLabel('Plan (opcional) ·').getAttribute('maxlength'), '32000');
        await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
        await p.getByRole('button', { name: 'Sesiones', exact: true }).click(); assert.equal(await p.getByLabel('Sesión principal', { exact: true }).inputValue(), 'ended');
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="grant")')).length, 0);
      });
      await t.test('a new plan can explicitly keep the selected conversation as its main session', async () => {
        const p=await mounted();
        await p.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
        assert.equal(await p.locator('dialog[open]').count(), 1);
        const origin=p.getByLabel(/Usar.*sesión principal/);assert.equal(await origin.isChecked(),true);
        await p.getByLabel('Nombre del proyecto').fill('Plan de la conversación');await p.getByRole('button',{name:'Crear proyecto',exact:true}).click();await idle(p);
        assert.equal(await run(p,'return f.calls.find(x=>x.op==="project_create").args.mainSessionId'),'live');
        assert.equal(await run(p,'return f.projects.find(p=>p.id==="p1").mainSessionId'),'ended');
      });
      await t.test('new project keeps the session named in its checked origin even if terminal selection changes', async () => {
        const p = await mounted(); await p.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
        assert.match(await p.getByText(/Usar «Claude viva» como sesión principal/).innerText(), /Claude viva/);
        await run(p, 'f.currentId="attention"');
        await p.getByLabel('Nombre del proyecto').fill('Origen estable');
        await p.getByRole('button', { name: 'Crear proyecto', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.calls.find(c=>c.op==="project_create").args.mainSessionId'), 'live');
      });
      await t.test('Proyecto saves name and plan by itself, without Guardar or Descartar', async () => {
        const p = await mounted(); await projectDetail(p);
        assert.equal(await p.getByRole('button', { name: /Guardar proyecto|Descartar borrador/ }).count(), 0);
        await p.getByLabel('Plan (opcional) ·').fill('Plan nuevo');
        await p.waitForFunction(() => (window as any).fixture.calls.some((c: any) => c.op === 'project_update'));
        await p.locator('.pulso-autosave-state').getByText('Guardado.', { exact: true }).waitFor();
        let writes = await run(p, 'return f.calls.filter(c=>c.op==="project_update").map(c=>c.args)');
        assert.equal(writes.length, 1); assert.equal(writes[0].plan, 'Plan nuevo'); assert.equal(writes[0].expectedRevision, 1); assert.equal(writes[0].mainSessionId, undefined);
        // Leaving the field saves at once and the tab follows the new name.
        const name = p.getByLabel('Nombre del proyecto', { exact: true }); await name.fill('Proyecto renombrado'); await p.getByLabel('Plan (opcional) ·').focus();
        await p.waitForFunction(() => (window as any).fixture.calls.filter((c: any) => c.op === 'project_update').length === 2);
        writes = await run(p, 'return f.calls.filter(c=>c.op==="project_update").map(c=>c.args)'); assert.equal(writes[1].expectedRevision, 2); assert.equal(writes[1].title, 'Proyecto renombrado');
        await p.getByRole('button', { name: 'Proyecto renombrado', exact: true }).waitFor({ state: 'attached' });
        assert.equal(await name.evaluate(n => n.isConnected), true);
        await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click(); await p.locator('dialog[open]').waitFor({ state: 'detached' });
      });
      await t.test('a failed autosave keeps the text visible and resumes after reviewing the conflict', async () => {
        const p = await mounted(); await projectDetail(p);
        await run(p, 'f.failWrite=true'); const plan = p.getByLabel('Plan (opcional) ·'); await plan.fill('Texto que no se pierde');
        await p.getByRole('button', { name: 'Reintentar mismo cambio', exact: true }).waitFor();
        assert.match(await p.locator('.pulso-autosave-state').innerText(), /No se guardó/);
        await p.keyboard.press('Escape'); assert.equal(await p.locator('dialog[open]').count(), 1); assert.equal(await plan.inputValue(), 'Texto que no se pierde');
        await run(p, 'f.failWrite=false; f.projects[0].revision=9; f.projects[0].plan="Remoto"');
        await p.getByRole('button', { name: 'Reintentar mismo cambio', exact: true }).click(); await p.getByRole('button', { name: 'Consultar versión actual', exact: true }).click();
        await p.getByRole('button', { name: 'Revisé los cambios; conservar mi borrador', exact: true }).click();
        await p.waitForFunction(() => (window as any).fixture.projects[0].plan === 'Texto que no se pierde');
        const writes = await run(p, 'return f.calls.filter(c=>c.op==="project_update").map(c=>c.args.expectedRevision)'); assert.deepEqual(writes, [1, 1, 9]);
        await p.locator('.pulso-autosave-state').getByText('Guardado.', { exact: true }).waitFor(); assert.equal(await plan.inputValue(), 'Texto que no se pierde');
      });
      await t.test('Sesiones applies the main session on change and links another session', async () => {
        const p = await mounted(); await sessionsDetail(p);
        assert.equal(await p.getByRole('dialog').getByRole('button', { name: /Guardar|Descartar/ }).count(), 0);
        await p.getByLabel('Sesión principal', { exact: true }).selectOption('live'); await idle(p);
        const update = await run(p, 'return f.calls.find(c=>c.op==="project_update").args');
        assert.equal(update.mainSessionId, 'live'); assert.equal(update.title, undefined); assert.equal(update.plan, undefined);
        assert.equal(await p.locator('dialog[open]').count(), 1);
        await p.locator('.pulso-board-toolbar').getByRole('button', { name: 'Abrir sesión principal', exact: true }).waitFor({ state: 'attached' });
        await p.getByLabel('Vincular otra sesión', { exact: true }).selectOption('attention');
        await p.getByRole('button', { name: 'Vincular sesión', exact: true }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>c.op==="link").map(c=>[c.args.projectId,c.args.sessionId])'), [['p1', 'attention']]);
        await p.getByRole('dialog').locator('.pulso-session').getByText('Sin confirmar', { exact: true }).waitFor();
        await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click(); assert.equal(await p.locator('dialog[open]').count(), 0);
      });
      await t.test('Nuevo proyecto has a label, can start a new session and opens the first phase', async () => {
        const p = await mounted();
        const add = p.getByRole('button', { name: 'Nuevo proyecto', exact: true }); assert.equal((await add.innerText()).trim(), 'Nuevo proyecto');
        await add.click();
        const fresh = p.getByLabel('Empezar una sesión nueva para este proyecto'); const origin = p.getByLabel(/Usar.*sesión principal/);
        assert.equal(await fresh.isChecked(), false); assert.equal(await origin.isChecked(), true);
        await fresh.check(); assert.equal(await origin.isChecked(), false);
        await p.getByLabel('Nombre del proyecto').fill('Con sesión nueva'); await p.getByRole('button', { name: 'Crear proyecto', exact: true }).click(); await idle(p);
        const created = await run(p, 'return f.calls.find(c=>c.op==="project_create").args'); assert.equal(created.mainSessionId, undefined);
        assert.equal(await run(p, 'return f.sessionDialogs.length'), 1);
        const todo = p.getByRole('region', { name: 'Por hacer', exact: true }); const first = todo.getByLabel('Título de la fase', { exact: true });
        await first.waitFor(); assert.equal(await first.evaluate(n => n === document.activeElement), true);
        await run(p, 'f.sessionDialogs[0]("started-session")');
        await p.waitForFunction(() => (window as any).fixture.projects.at(-1).mainSessionId === 'started-session');
        assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="project_update").length'), 1);
        await first.fill('Primera fase'); await todo.getByRole('button', { name: 'Añadir fase', exact: true }).click(); await idle(p);
        await todo.getByRole('button', { name: 'Abrir Primera fase', exact: true }).waitFor();
      });
      await t.test('a cancelled session dialog leaves the new project created without a session', async () => {
        const p = await mounted('f.currentId=null;');
        await p.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
        await p.getByLabel('Empezar una sesión nueva para este proyecto').check();
        await p.getByLabel('Nombre del proyecto').fill('Sin sesión al final'); await p.getByRole('button', { name: 'Crear proyecto', exact: true }).click(); await idle(p);
        await p.getByRole('button', { name: 'Sin sesión al final', exact: true }).waitFor();
        assert.equal(await run(p, 'return f.sessionDialogs.length'), 1);
        assert.equal(await run(p, 'return "mainSessionId" in f.calls.find(c=>c.op==="project_create").args'), false);
        assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="project_update").length'), 0);
        await p.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título de la fase', { exact: true }).waitFor();
      });
      await t.test('Añadir fase sits right below the last phase of every column, Hecho included', async () => {
        const p = await mounted('f.items.push({...f.item("hecha","p1"),status:"done"});'); await projectBoard(p);
        for (const status of ['todo', 'doing', 'waiting', 'done']) {
          const last = await p.locator(`.pulso-cards[data-status="${status}"] > :not(form)`).evaluateAll(ns => ns.filter(n => !(n as HTMLElement).hidden).map(n => n.textContent?.trim()).at(-1));
          assert.equal(last, 'Añadir fase', status);
        }
        assert.equal(await p.locator('.pulso-board').getByText(/tarjeta/i).count(), 0);
        const done = p.getByRole('region', { name: 'Hecho', exact: true });
        await done.getByRole('button', { name: 'Añadir fase', exact: true }).click(); await done.getByLabel('Título de la fase', { exact: true }).fill('Ya estaba hecha');
        await done.getByRole('button', { name: 'Añadir fase', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.calls.find(c=>c.op==="item_create").args.status'), 'done');
        await done.getByRole('button', { name: 'Abrir Ya estaba hecha', exact: true }).waitFor();
      });
      await t.test('Dar por terminado appears only when every phase is done and archives after confirming', async () => {
        const p = await mounted(); await projectBoard(p);
        assert.equal(await p.getByRole('button', { name: 'Dar por terminado', exact: true }).count(), 0);
        await move(p, 'Fase i1', 'done'); await idle(p);
        assert.match(await p.locator('.pulso-progress').innerText(), /1 de 1 fases hechas/);
        await p.getByRole('button', { name: 'Dar por terminado', exact: true }).click();
        await p.getByRole('button', { name: 'Cancelar', exact: true }).click();
        assert.equal(await p.getByRole('button', { name: 'Dar por terminado', exact: true }).evaluate(n => n === document.activeElement), true);
        assert.equal(await run(p, 'return f.projects[0].archived'), false);
        await p.getByRole('button', { name: 'Dar por terminado', exact: true }).click(); await p.getByRole('button', { name: 'Sí, terminar', exact: true }).click(); await idle(p);
        const archive = await run(p, 'return f.calls.filter(c=>c.op==="project_update").map(c=>c.args)');
        assert.equal(archive.length, 1); assert.equal(archive[0].archived, true); assert.equal(archive[0].expectedRevision, 1);
        await p.getByRole('button', { name: 'Proyecto p1', exact: true }).waitFor({ state: 'detached' });
        assert.equal(await p.getByRole('button', { name: 'Pendientes', exact: true }).getAttribute('aria-current'), 'true');
        assert.match((await run(p, 'return f.notices')).join(' '), /Terminados/);
      });
      await t.test('Terminados lists archived projects, shows a read-only board and reopens', async () => {
        const p = await mounted('f.projects.push({...f.project("old"),title:"Proyecto viejo",archived:true});f.items.push({...f.item("v1","old"),status:"done"},{...f.item("v2","old"),status:"doing"});');
        await p.getByRole('button', { name: 'Terminados', exact: true }).click();
        const dialog = p.getByRole('dialog'); await dialog.getByText('Proyecto viejo', { exact: true }).waitFor();
        await dialog.getByText(/1 de 2 fases hechas · Terminado el/).waitFor();
        assert.equal(await dialog.getByText('Proyecto p1', { exact: true }).count(), 0);
        await dialog.getByRole('button', { name: 'Ver tablero', exact: true }).click(); await idle(p);
        await p.locator('.pulso-archived-badge').waitFor();
        assert.equal(await p.getByRole('button', { name: 'Terminados', exact: true }).getAttribute('aria-current'), 'true');
        assert.equal(await p.getByRole('button', { name: /Añadir fase|^Mover |^Abrir Fase|^Proyecto$|^Sesiones$|Dar por terminado/ }).count(), 0);
        await p.getByText('Fase v2', { exact: true }).waitFor();
        await p.locator('.pulso-board-toolbar').getByRole('button', { name: 'Reabrir', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.projects.find(x=>x.id==="old").archived'), false);
        const tab = p.getByRole('button', { name: 'Proyecto viejo', exact: true }); await tab.waitFor(); assert.equal(await tab.getAttribute('aria-current'), 'true');
        await p.getByRole('region', { name: 'En curso', exact: true }).getByRole('button', { name: 'Añadir fase', exact: true }).waitFor();
      });
      await t.test('a project with open phases can be archived by hand from Proyecto after confirming', async () => {
        const p = await mounted(); await projectDetail(p);
        await p.getByRole('button', { name: 'Archivar proyecto', exact: true }).click();
        await p.getByRole('button', { name: 'Cancelar', exact: true }).click(); assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="project_update").length'), 0);
        await p.getByRole('button', { name: 'Archivar proyecto', exact: true }).click(); await p.getByRole('button', { name: 'Sí, archivar', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.projects[0].archived'), true); assert.equal(await p.locator('dialog[open]').count(), 0);
        assert.equal(await p.getByRole('button', { name: 'Proyecto p1', exact: true }).count(), 0);
        await p.getByRole('button', { name: 'Terminados', exact: true }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Reabrir', exact: true }).click(); await idle(p);
        await p.getByRole('button', { name: 'Proyecto p1', exact: true }).waitFor(); assert.equal(await run(p, 'return f.projects[0].archived'), false);
      });
      await t.test('uncertain mutation keeps draft, freezes edits and manually reuses UUID/payload', async () => {
        const p = await mounted(); await itemDetail(p);
        await p.getByLabel('Notas', { exact: true }).fill('Mi borrador'); await run(p, 'f.failWrite=true');
        await p.getByRole('button', { name: 'Guardar fase', exact: true }).click(); await p.getByRole('button', { name: 'Reintentar mismo cambio' }).waitFor();
        assert.equal(await p.getByLabel('Notas', { exact: true }).inputValue(), 'Mi borrador'); assert.equal(await p.getByLabel('Notas', { exact: true }).isDisabled(), true);
        await run(p, 'f.failWrite=false'); await p.getByRole('button', { name: 'Reintentar mismo cambio' }).click(); await idle(p);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_update")'); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
        assert.equal(await p.getByLabel('Notas', { exact: true }).inputValue(), 'Mi borrador');
      });
      await t.test('commit followed by timeout retries the original creation without duplicating it', async () => {
        const p = await mounted(); await run(p, 'f.timeoutAfterCommit=true');
        await p.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Añadir pendiente', exact: true }).click();
        await p.getByRole('region', { name: 'Por hacer', exact: true }).getByLabel('Título del pendiente', { exact: true }).fill('Captura única'); await p.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: 'Añadir pendiente', exact: true }).click();
        await p.getByRole('button', { name: 'Reintentar mismo cambio' }).click(); await idle(p);
        assert.equal(await run(p, 'return f.items.filter(x=>x.title==="Captura única").length'), 1);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_create")'); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
      });
      await t.test('undo uses inverse status and the resulting revision, never overwrites a concurrent edit', async () => {
        const p = await mounted(); await itemDetail(p); await p.getByLabel('Estado', { exact: true }).selectOption('done');
        await p.getByRole('button', { name: 'Guardar fase', exact: true }).click(); await idle(p);
        await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
        await run(p, 'f.items[0].revision=99; f.items[0].note="Edición ajena";');
        await p.getByRole('button', { name: 'Deshacer cambio de estado' }).click(); await p.getByRole('button', { name: 'Consultar versión actual' }).waitFor();
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_update")'); assert.equal(calls[1].args.status, 'todo'); assert.equal(calls[1].args.expectedRevision, 2);
        assert.equal(await run(p, 'return f.items[0].status'), 'done'); assert.equal(await run(p, 'return f.items[0].note'), 'Edición ajena');
      });
      await t.test('conflict inspection preserves text; updating revision requires explicit review and a new save', async () => {
        const p = await mounted(); await itemDetail(p); await p.getByLabel('Notas', { exact: true }).fill('Mi texto');
        await run(p, 'f.items[0].revision=7; f.items[0].note="Remoto"');
        await p.getByRole('button', { name: 'Guardar fase', exact: true }).click(); await p.getByRole('button', { name: 'Consultar versión actual' }).click();
        await p.getByRole('button', { name: 'Revisé los cambios; conservar mi borrador' }).click();
        assert.equal(await p.getByLabel('Notas', { exact: true }).inputValue(), 'Mi texto');
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="item_update")')).length, 1);
        await p.getByRole('button', { name: 'Guardar fase', exact: true }).click(); await idle(p);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_update")'); assert.equal(calls[1].args.expectedRevision, 7); assert.notEqual(calls[0].args.requestId, calls[1].args.requestId);
      });
      await t.test('checkpoint appends; editable continuation copies only, opening a session passes only cwd', async () => {
        const p = await mounted(); await itemDetail(p);
        await p.getByText('Guardar avance', { exact: true }).click();
        await p.getByLabel('Qué quedó listo ·').fill('Implementado'); await p.getByLabel('Siguiente acción ·').fill('Verificar');
        await p.getByRole('button', { name: 'Registrar checkpoint', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.checkpoints.length'), 1);
        assert.equal(await run(p, 'return f.calls.find(c=>c.op==="checkpoint_create").args.sessionId'), undefined);
        assert.match(await p.locator('.pulso-history').innerText(), /Implementado/);
        await p.getByRole('button', { name: 'Preparar contexto' }).click(); await p.getByLabel('Contexto editable para continuar').fill('Contexto revisado');
        await p.getByRole('button', { name: 'Copiar contexto', exact: true }).click();
        await p.getByRole('button', { name: 'Abrir nueva sesión', exact: true }).click();
        assert.deepEqual(await run(p, 'return f.copied'), ['Contexto revisado']); assert.deepEqual(await run(p, 'return f.created'), ['/synthetic']);
        assert.equal((await run(p, 'return f.calls.filter(x=>/pty|input|turn/.test(x.op))')).length, 0);
      });
      await t.test('checkpoint save then immediate board move uses the fresh revision before polling', async () => {
        const p = await mounted(); await itemDetail(p);
        await p.getByText('Guardar avance', { exact: true }).click();
        await p.getByLabel('Qué quedó listo ·').fill('Checkpoint antes de mover');
        await p.getByLabel('Siguiente acción ·').fill('Continuar en curso');
        await p.getByRole('button', { name: 'Registrar checkpoint', exact: true }).click(); await idle(p);
        await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
        await move(p, 'Fase i1', 'doing'); await idle(p);
        const calls = await run(p, 'return f.calls');
        const checkpoint = calls.find((c: any) => c.op === 'checkpoint_create');
        const moves = calls.filter((c: any) => c.op === 'item_update');
        assert.equal(checkpoint.args.expectedRevision, 1);
        assert.equal(moves.length, 1);
        assert.deepEqual(moves[0].args, { id: 'i1', status: 'doing', expectedRevision: 2, requestId: moves[0].args.requestId });
        assert.equal(calls.filter((c: any) => c.op === 'revision').length, 0, 'the move must use the checkpoint revision without waiting for the two-second poll');
        await p.getByRole('region', { name: 'En curso', exact: true }).getByRole('button', { name: 'Abrir Fase i1', exact: true }).waitFor();
        assert.equal(await p.locator('dialog[open]').count(), 0);
        assert.deepEqual(await run(p, 'return [f.items.find(i=>i.id==="i1").revision,f.checkpoints.map(c=>c.brief)]'), [3, ['Checkpoint antes de mover']]);
      });
      await t.test('older continuity points load only on request while the latest context remains selected', async () => {
        const p=await mounted('f.checkpoints=Array.from({length:12},(_,i)=>({id:"cp"+i,itemId:"i1",brief:"Point "+i,nextAction:"Next",revision:i,actor:"fixture",createdAt:Date.parse("2026-11-14T12:00:00Z")}));');await itemDetail(p);
        assert.equal((await run(p,'return f.calls.filter(c=>c.op==="checkpoint_history")')).length,0);
        await p.getByRole('button',{name:'Ver puntos anteriores',exact:true}).click();await idle(p);
        assert.equal(await p.locator('.pulso-history li').count(),12);
        const call=await run(p,'return f.calls.find(c=>c.op==="checkpoint_history")');assert.deepEqual(call.args,{itemId:'i1',cursor:10,limit:10});
        await p.getByRole('button',{name:'Preparar contexto'}).click();assert.match(await p.getByLabel('Contexto editable para continuar').inputValue(),/Point 11/);
        assert.equal(await p.getByRole('button',{name:'Ver puntos anteriores',exact:true}).count(),0);
        await run(p,'f.revision++; return f.panel.refresh()');
        assert.equal(await p.locator('.pulso-history li').count(),12);
        assert.equal(await p.getByRole('button',{name:'Ver puntos anteriores',exact:true}).count(),0);
      });
      await t.test('background refresh keeps open phase controls, focus and context without extra project reads', async () => {
        const p = await mounted(); await itemDetail(p);
        await p.getByText('Guardar avance', { exact: true }).click();
        await p.getByRole('button', { name: 'Preparar contexto' }).click();
        const context = p.getByLabel('Contexto editable para continuar'); await context.focus();
        const before = await run(p, 'return f.calls.filter(c=>c.op==="project").length');
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await p.getByText('Guardar avance', { exact: true }).evaluate(el => (el.parentElement as HTMLDetailsElement).open), true);
        assert.equal(await context.isVisible(), true);
        assert.equal(await context.evaluate(el => el === document.activeElement), true);
        assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="project").length'), before);
        await run(p, 'f.sessions.push({id:"unrelated",title:"Otra terminal",kind:"terminal",cwd:"/other",status:"running"}); return f.panel.refresh()');
        assert.equal(await context.isVisible(), true);
        assert.equal(await context.evaluate(el => el === document.activeElement), true);
        assert.doesNotMatch(await p.locator('.pulso-feedback').innerText(), /Consultando fase/);
      });
      await t.test('background refresh keeps an untouched quick-add and card move focus', async () => {
        const p = await mounted(); await projectBoard(p);
        const doing = p.getByRole('region', { name: 'En curso', exact: true });
        await doing.getByRole('button', { name: 'Añadir fase', exact: true }).click();
        const title = doing.getByLabel('Título de la fase', { exact: true });
        assert.equal(await title.evaluate(el => el === document.activeElement), true);
        await run(p, 'f.sessions.push({id:"unrelated",title:"Otra terminal",kind:"terminal",cwd:"/other",status:"running"}); return f.panel.refresh()');
        assert.equal(await title.isVisible(), true);
        assert.equal(await title.evaluate(el => el === document.activeElement), true);
        await doing.getByRole('button', { name: 'Cancelar', exact: true }).click();
        const move = p.getByLabel('Mover Fase i1', { exact: true }); await move.focus();
        await run(p, 'f.sessions.push({id:"another",title:"Otra más",kind:"terminal",cwd:"/other",status:"running"}); return f.panel.refresh()');
        assert.equal(await move.evaluate(el => el === document.activeElement), true);
      });
      await t.test('asynchronous recovery action regains keyboard focus after a session refresh', async () => {
        const p = await mounted(); await itemDetail(p);
        const resume = p.getByRole('dialog').getByRole('button', { name: 'Continuar sesión de la fase', exact: true });
        await resume.waitFor(); await resume.focus();
        assert.equal(await resume.evaluate(el => el === document.activeElement), true, 'the recovery action receives focus before refresh');
        await run(p, 'f.sessions.push({id:"unrelated",title:"Otra terminal",kind:"terminal",cwd:"/other",status:"running"}); return f.panel.refresh()');
        await resume.waitFor();
        const active = await run(p, 'return [document.activeElement?.tagName,document.activeElement?.className,document.activeElement?.textContent?.trim().slice(0,80)]');
        assert.equal(await resume.evaluate(el => el === document.activeElement), true, JSON.stringify(active));
      });
      await t.test('history, live focus, uncertain inspection and Claude resume are separate; bindings do not poll', async () => {
        const p = await mounted('f.links=[{itemId:"i1",sessionId:"live"},{itemId:"i1",sessionId:"attention"}];'); await itemDetail(p);
        await p.getByRole('button', { name: 'Continuar conversación' }).waitFor();
        assert.match(await p.locator('.pulso-detail').innerText(), /Historial local/);
        await p.getByRole('button', { name: 'Abrir sesión de la fase' }).click(); await p.getByRole('button', { name: 'Inspeccionar sesión' }).click();
        await p.getByRole('button',{name:'Ver historial',exact:true}).click();
        await p.getByRole('button', { name: 'Continuar conversación' }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.opened'), ['live', 'attention', 'ended']); assert.deepEqual(await run(p, 'return f.resumed'), ['ended']);
        await run(p, 'f.revision++; return f.panel.refresh()');
        const count = await run(p, 'return f.bindings.length');
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await run(p, 'return f.bindings.length'), count, 'explicit resume may invalidate metadata once; later refreshes reuse it');
        const q = await mounted('f.bindingProvider="codex";'); await itemDetail(q);
        assert.equal(await q.getByRole('button', { name: 'Continuar conversación' }).count(), 0);
      });
      await t.test('an exact live continuation opens without launching the conversation again',async()=>{
        const p=await mounted('f.activeNative="live";');await sessionsDetail(p);
        await p.getByRole('dialog').getByRole('button',{name:'Abrir conversación activa',exact:true}).click();
        assert.deepEqual(await run(p,'return f.opened'),['live']);assert.deepEqual(await run(p,'return f.resumed'),[]);
        assert.equal(await p.getByRole('button',{name:'Continuar sesión principal',exact:true}).count(),0);
      });
      await t.test('resume failure keeps history and does not display raw runner details', async () => {
        const p = await mounted('f.resumeError=true;'); await projectBoard(p);
        await p.locator('.pulso-board-toolbar').getByRole('button', { name: 'Continuar sesión principal', exact: true }).click();
        await p.getByText(/No se pudo continuar la conversación/).waitFor();
        assert.doesNotMatch(await p.locator('.pulso-panel').innerText(), /secret-runner-detail/);
        assert.deepEqual(await run(p, 'return f.resumed'), ['ended']);
      });
      await t.test('same-titled histories have one conversation action and distinct local history links', async () => {
        const p = await mounted('f.sessions.push({id:"older",title:"Claude anterior",kind:"claude",cwd:"/synthetic",status:"exited"});f.links=[{projectId:"p1",sessionId:"older"}];f.activeNative="live";');
        await sessionsDetail(p);
        const dialog = p.getByRole('dialog');
        assert.equal(await dialog.getByRole('button', { name: 'Abrir conversación activa', exact: true }).count(), 1);
        assert.equal(await dialog.getByRole('button', { name: 'Ver historial', exact: true }).count(), 2);
        assert.match(await dialog.innerText(), /Claude anterior · ended/);
        assert.match(await dialog.innerText(), /Claude anterior · older/);
        assert.deepEqual(await run(p, 'return f.bindings'), ['ended']);
      });
      await t.test('a stopped session changes to history without a planning mutation or provider poll',async()=>{
        const p=await mounted('f.projects[0].mainSessionId="live"');
        await sessionsDetail(p);await idle(p);
        assert.equal(await p.getByRole('dialog').getByRole('button',{name:'Abrir sesión principal',exact:true}).count(),1);
        assert.equal(await p.getByRole('dialog').getByRole('button',{name:'Enfocar sesión viva',exact:true}).count(),0);
        await run(p,'f.sessions.find(s=>s.id==="live").status="exited"');
        await p.getByRole('button',{name:'Ver historial',exact:true}).waitFor({timeout:4000});
        assert.equal(await p.getByRole('button',{name:'Enfocar sesión viva',exact:true}).count(),0);
        assert.equal(await run(p,'return f.revision'),1);
      });
      await t.test('phase recovery shows one live-session action', async () => {
        const p = await mounted('f.checkpoints=[{id:"cp-live",itemId:"i1",brief:"Avance",nextAction:"Seguir",sessionId:"live",actor:"fixture",createdAt:Date.parse("2026-11-14T12:00:00Z")}];');
        await itemDetail(p);
        const dialog = p.getByRole('dialog');
        assert.equal(await dialog.getByRole('button', { name: 'Abrir sesión de la fase', exact: true }).count(), 1);
        assert.equal(await dialog.getByRole('button', { name: 'Enfocar sesión viva', exact: true }).count(), 0);
        await dialog.getByRole('button', { name: 'Abrir sesión de la fase', exact: true }).click();
        assert.deepEqual(await run(p, 'return [f.opened,f.resumed]'), [['live'], []]);
      });
      await t.test('Proyecto and Sesiones carry no agent access section or local authority controls', async () => {
        const p = await mounted(); await projectDetail(p);
        for (const drawer of ['Proyecto', 'Sesiones']) {
          if (drawer === 'Sesiones') { await p.getByRole('button', { name: 'Cerrar detalle', exact: true }).click(); await p.getByRole('button', { name: 'Sesiones', exact: true }).click(); await p.getByLabel('Sesión principal', { exact: true }).waitFor(); }
          assert.equal(await p.getByRole('dialog').getByText('Acceso de agentes', { exact: true }).count(), 0, drawer);
          assert.equal(await p.getByRole('button', { name: 'Configurar permisos…', exact: true }).count(), 0, drawer);
          assert.equal(await p.getByRole('button', { name: /Guardar proyecto|Descartar borrador/ }).count(), 0, drawer);
        }
        assert.equal(await p.getByLabel('Sesión que recibe el acceso').count(), 0);
        assert.equal(await p.getByRole('button', { name: /^Dar acceso$|Quitar el acceso de esta sesión|Olvidar este acceso|Conceder acceso y ver comando|Revocar permiso|Gestionar permisos recordados/ }).count(), 0);
        assert.equal(await p.getByLabel('Comando local para el agente', { exact: true }).count(), 0);
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>/^(grant|revoke|policies|revoke_policy)$/.test(c.op))'), []);
      });
      await t.test('toolbar continues a live main session without launching or sending input', async () => {
        const p = await mounted('f.projects[0].mainSessionId="live";'); await projectBoard(p);
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [[], [], []]);
        const cta = p.locator('.pulso-board-toolbar').getByRole('button', { name: 'Abrir sesión principal', exact: true });
        assert.match(await cta.getAttribute('class') ?? '', /primary/); await cta.click();
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [['live'], [], []]);
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>/grant|pty|input|turn/.test(c.op))'), []);
      });
      await t.test('a project without phases recovers its ended main session only on explicit action', async () => {
        const p = await mounted('f.items=f.items.filter(i=>i.projectId!=="p1");'); await projectBoard(p);
        const resume = p.locator('.pulso-board-toolbar').getByRole('button', { name: /Continuar.*principal/ });
        await resume.waitFor(); assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [[], [], []]);
        await resume.click(); assert.deepEqual(await run(p, 'return f.resumed'), ['ended']);
      });
      await t.test('a project created from live Claude recovers after automatic refresh with uncached binding', async () => {
        const p = await mounted(); await p.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
        await p.getByLabel('Nombre del proyecto').fill('Proyecto de Claude vivo');
        await p.getByRole('button', { name: 'Crear proyecto', exact: true }).click(); await idle(p);
        assert.equal(await p.locator('dialog[open]').count(), 0);
        await p.locator('.pulso-board-toolbar').getByRole('button', { name: 'Abrir sesión principal', exact: true }).waitFor();
        assert.equal(await run(p, 'return f.bindings.filter(id=>id==="live").length'), 0);
        await run(p, 'f.sessions.find(s=>s.id==="live").status="exited"');
        await p.locator('.pulso-board-toolbar').getByRole('button', { name: /Continuar.*principal/ }).waitFor({ timeout: 5000 });
        assert.equal(await run(p, 'return f.bindings.filter(id=>id==="live").length'), 1);
        assert.deepEqual(await run(p, 'return [f.created,f.resumed]'), [[], []]);
      });
      await t.test('closed rows fetch once even when their live detail refresh disables binding queries', async () => {
        const p = await mounted('f.projects[0].mainSessionId="live";'); await sessionsDetail(p);
        await run(p, 'f.sessions.find(s=>s.id==="live").status="exited"');
        await p.getByRole('dialog').getByRole('button', { name: 'Continuar sesión principal', exact: true }).waitFor();
        assert.equal(await run(p, 'return f.bindings.filter(id=>id==="live").length'), 1);
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await run(p, 'return f.bindings.filter(id=>id==="live").length'), 1);
      });
      await t.test('binding lookup shows checking, failure and a bounded explicit retry', async () => {
        const p = await mounted('f.holdBinding=true; f.bindingFailures=1;'); await projectBoard(p);
        await p.locator('.pulso-board-toolbar').getByText(/Comprobando|Consultando|Verificando/i).waitFor();
        await run(p, 'f.holdBinding=false; f.bindingHeld.splice(0).forEach(resolve=>resolve())');
        const retry = p.locator('.pulso-board-toolbar').getByRole('button', { name: /Reintentar/ }); await retry.waitFor();
        assert.match(await p.locator('.pulso-board-toolbar').innerText(), /no.*pudo|fall|error/i);
        const calls = await run(p, 'return f.bindings.length');
        await run(p, 'f.revision++; return f.panel.refresh()'); assert.equal(await run(p, 'return f.bindings.length'), calls);
        await retry.click(); await p.locator('.pulso-board-toolbar').getByRole('button', { name: /Continuar.*principal/ }).waitFor();
        assert.equal(await run(p, 'return f.bindings.length'), calls + 1);
      });
      await t.test('phase continuation prefers its newest checkpoint session over the project main session', async () => {
        const p = await mounted('f.checkpoints=[{id:"old",itemId:"i1",sessionId:"ended",brief:"Viejo",nextAction:"",actor:"fixture",revision:1,createdAt:1},{id:"new",itemId:"i1",sessionId:"live",brief:"Nuevo",nextAction:"",actor:"fixture",revision:2,createdAt:2}];');
        await itemDetail(p); await p.getByRole('button', { name: 'Preparar contexto' }).click();
        await p.getByRole('button', { name: 'Abrir sesión de la fase', exact: true }).first().click();
        assert.deepEqual(await run(p, 'return [f.opened,f.resumed,f.created]'), [['live'], [], []]);
      });
      await t.test('missing recoverable binding retains an explicit editable context fallback', async () => {
        const p = await mounted('f.bindingProvider=null;'); await itemDetail(p);
        await p.getByRole('button', { name: 'Preparar contexto' }).click();
        await p.getByLabel('Contexto editable para continuar').waitFor();
        assert.equal(await p.getByRole('button', { name: 'Continuar sesión de la fase', exact: true }).count(), 0);
        assert.equal(await p.getByRole('button', { name: 'Copiar contexto', exact: true }).isVisible(), true);
        assert.equal(await p.getByRole('button', { name: 'Abrir nueva sesión', exact: true }).isVisible(), true);
        assert.deepEqual(await run(p, 'return [f.created,f.resumed]'), [[], []]);
      });
      await t.test('committed board preference survives remount and show without provider commands', async () => {
        const p = await mounted('f.profile="synthetic-profile-a";'); await projectBoard(p);
        assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('jauria-pulso:last-board:synthetic-profile-a')!)), { schemaVersion: 1, projectId: 'p1' });
        await run(p, 'f.panel.dispose(); f.mount(); f.panel.show()');
        await p.getByRole('button', { name: 'Proyecto', exact: true }).waitFor();
        await run(p, 'f.panel.hide(); f.panel.show()'); await idle(p);
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed,f.calls.filter(c=>/grant|pty|input|turn/.test(c.op))]'), [[], [], [], []]);
        await p.getByRole('button', { name: 'Pendientes', exact: true }).click();
        await p.getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
        assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('jauria-pulso:last-board:synthetic-profile-a')!)), { schemaVersion: 1, projectId: null });
      });
      for (const saved of ['malformed', 'missing', 'archived']) await t.test(`saved ${saved} project falls back to Pendientes without commands`, async () => {
        const value = saved === 'malformed' ? '{bad json' : JSON.stringify({ schemaVersion: 1, projectId: saved === 'missing' ? 'absent' : 'p1' });
        const p = await mounted(`f.profile="synthetic-fallback"; f.storage["jauria-pulso:last-board:synthetic-fallback"]=${JSON.stringify(value)}; ${saved === 'archived' ? 'f.projects[0].archived=true;' : ''}`);
        await p.getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
        assert.equal(await p.getByRole('button', { name: 'Proyecto', exact: true }).count(), 0);
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [[], [], []]);
      });
      await t.test('failed board navigation cannot persist an uncommitted project', async () => {
        const p = await mounted('f.profile="synthetic-commit";');
        await run(p, 'f.failRead=true'); await p.getByRole('button', { name: 'Proyecto p1', exact: true }).click();
        await p.getByRole('button', { name: /Reintentar|Actualizar tablero/ }).first().waitFor();
        assert.notEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('jauria-pulso:last-board:synthetic-commit') ?? 'null')?.projectId), 'p1');
      });
      await t.test('profile namespaces restore independently', async () => {
        const p = await mounted('f.profile="synthetic-a"; f.storage["jauria-pulso:last-board:synthetic-b"]=JSON.stringify({schemaVersion:1,projectId:"p1"});');
        await p.getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
        await run(p, 'f.panel.dispose(); f.profile="synthetic-b"; f.mount(); f.panel.show()');
        await p.getByRole('button', { name: 'Proyecto', exact: true }).waitFor();
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [[], [], []]);
      });
      for (const change of ['session', 'reconnect', 'profile']) await t.test(`binding cache invalidates once on ${change} lifecycle changes`, async () => {
        const p=await mounted('f.profile="synthetic-lifecycle-a";'); await projectBoard(p);
        await p.locator('.pulso-board-toolbar').getByRole('button',{name:/Continuar.*principal/}).waitFor();
        const before=await run(p,'return f.bindings.filter(id=>id==="ended").length');
        await run(p, `f.bindingProvider=null; ${change === 'session' ? 'f.sessions.find(s=>s.id==="live").status="exited";' : 'f.cacheKey="synthetic-connection-2";'} ${change === 'profile' ? 'f.panel.hide();f.profile="synthetic-lifecycle-b";f.panel.show();' : ''} return f.panel.refresh()`);
        await p.locator('.pulso-board-toolbar').getByText('Sin conversación que continuar').waitFor();
        assert.equal(await run(p,'return f.bindings.filter(id=>id==="ended").length'),before+1);
        await run(p,'return f.panel.refresh()');
        assert.equal(await run(p,'return f.bindings.filter(id=>id==="ended").length'),before+1,'stable lifecycle must reuse metadata');
        assert.deepEqual(await run(p,'return [f.opened,f.resumed,f.created]'),[[],[],[]]);
      });
      await t.test('late binding response from before reconnect cannot restore an obsolete resume action', async () => {
        const p=await mounted('f.holdBinding=true;'); await projectBoard(p);
        await p.locator('.pulso-board-toolbar').getByText(/Comprobando conversación/).waitFor();
        await run(p,'f.holdBinding=false;f.bindingProvider=null;f.cacheKey="synthetic-reconnected";return f.panel.refresh()');
        await p.locator('.pulso-board-toolbar').getByText('Sin conversación que continuar').waitFor();
        await run(p,'f.bindingHeld.splice(0).forEach(resolve=>resolve())');
        assert.equal(await p.locator('.pulso-board-toolbar').getByRole('button',{name:/Continuar.*principal/}).count(),0);
        assert.equal(await run(p,'return f.bindings.filter(id=>id==="ended").length'),2);
      });
      await t.test('an attention-state active continuation offers review without a duplicate resume', async () => {
        const p=await mounted('f.activeNative="attention";'); await projectBoard(p);
        const review=p.locator('.pulso-board-toolbar').getByRole('button',{name:'Revisar estado de la sesión',exact:true}); await review.waitFor();
        assert.equal(await p.locator('.pulso-board-toolbar').getByRole('button',{name:/Continuar.*principal/}).count(),0);
        await review.click(); assert.deepEqual(await run(p,'return [f.opened,f.resumed,f.created]'),[['attention'],[],[]]);
      });
      await t.test('transient restore failure preserves the saved project for a later show', async () => {
        const p=await mounted('f.profile="synthetic-transient";f.failProjectReads=1;f.storage["jauria-pulso:last-board:synthetic-transient"]=JSON.stringify({schemaVersion:1,projectId:"p1"});');
        await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).waitFor();
        assert.deepEqual(await p.evaluate(()=>JSON.parse(localStorage.getItem('jauria-pulso:last-board:synthetic-transient')!)),{schemaVersion:1,projectId:'p1'});
        await run(p,'f.panel.hide();f.panel.show()'); await p.getByRole('button',{name:'Proyecto',exact:true}).waitFor();
        assert.deepEqual(await run(p,'return [f.opened,f.resumed,f.created]'),[[],[],[]]);
      });
      await t.test('transient restore failure followed by choosing Pendientes clears the restore candidate', async () => {
        const p=await mounted('f.profile="synthetic-explicit-pending";f.failProjectReads=1;f.storage["jauria-pulso:last-board:synthetic-explicit-pending"]=JSON.stringify({schemaVersion:1,projectId:"p1"});');
        await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).waitFor();
        await p.getByRole('button',{name:'Reintentar consulta',exact:true}).waitFor();
        assert.equal(await run(p,'return f.calls.filter(c=>c.op==="project").length'),1);
        await p.getByRole('button',{name:'Pendientes',exact:true}).click();
        await p.waitForFunction(()=>JSON.parse(localStorage.getItem('jauria-pulso:last-board:synthetic-explicit-pending') ?? 'null')?.projectId===null);
        await run(p,'return f.panel.refresh()');
        assert.equal(await p.getByRole('button',{name:'Pendientes',exact:true}).getAttribute('aria-current'),'true');
        assert.equal(await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).isVisible(),true);
        assert.equal(await p.getByRole('button',{name:'Proyecto',exact:true}).count(),0);
        assert.equal(await run(p,'return f.calls.filter(c=>c.op==="project").length'),1,'refresh must not retry the abandoned project restoration');
        assert.deepEqual(await run(p,'return [f.opened,f.resumed,f.created,f.calls.filter(c=>/grant|pty|input|turn/.test(c.op))]'),[[],[],[],[]]);
      });
      await t.test('a restored project outside the first page remains a visible selected tab', async () => {
        const p=await mounted('f.projects=Array.from({length:55},(_,i)=>f.project("p"+(i+1)));f.profile="synthetic-offpage";f.storage["jauria-pulso:last-board:synthetic-offpage"]=JSON.stringify({schemaVersion:1,projectId:"p55"});');
        const tab=p.getByRole('button',{name:'Proyecto p55',exact:true}); await tab.waitFor();
        assert.equal(await tab.getAttribute('aria-current'),'true');
        assert.deepEqual(await run(p,'return [f.opened,f.resumed,f.created]'),[[],[],[]]);
      });
      await t.test('pages are bounded to 50 and numeric fallback offsets advance without duplicate rows', async () => {
        const p = await mounted('f.projects=Array.from({length:55},(_,i)=>f.project(i===0?"p1":"p"+(i+1)));');
        assert.equal(await p.locator('.pulso-project-tabs .pulso-tab').count(), 51);
        await p.getByRole('button', { name: 'Más proyectos' }).click(); await idle(p);
        assert.equal(await p.locator('.pulso-project-tabs .pulso-tab').count(), 56);
        const pages = await run(p, 'return f.calls.filter(x=>x.op==="projects")'); assert.equal(pages[1].args.cursor, 50); assert.equal(pages[1].args.limit, 50);
      });
      await t.test('a pending detail neither offers agent access nor reads or mutates authority', async () => {
        const p = await mounted();
        await p.getByRole('button', { name: 'Abrir Fase solo', exact: true }).click(); await p.getByRole('dialog').getByLabel('Título del pendiente', { exact: true }).waitFor();
        assert.equal(await p.getByRole('button', { name: 'Configurar permisos…', exact: true }).count(), 0);
        assert.equal(await p.getByRole('dialog').getByText('Acceso de agentes', { exact: true }).count(), 0);
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>/^(grant|revoke|policies|revoke_policy)$/.test(c.op))'), []);
        assert.equal(await p.getByLabel('Recordar para las próximas sesiones de esta herramienta en esta carpeta').count(), 0);
      });
      await t.test('fixed columns show standalone done cards; tabs select boards without opening a drawer', async () => {
        const p=await mounted('f.items.push({...f.item("finished"),status:"done"});');
        assert.deepEqual(await p.locator('.pulso-column').evaluateAll(ns=>ns.map(n=>[n.getAttribute('data-state'),n.getAttribute('aria-label')])),[['todo','Por hacer'],['doing','En curso'],['waiting','En espera'],['done','Hecho']]);
        await p.getByRole('region',{name:'Hecho',exact:true}).getByRole('button',{name:'Abrir Fase finished',exact:true}).waitFor();
        await projectBoard(p);assert.equal(await p.locator('dialog[open]').count(),0);
        assert.equal(await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).count(),0);
        await p.getByRole('button',{name:'Pendientes',exact:true}).click();await p.getByRole('button',{name:'Abrir Fase finished',exact:true}).waitFor();
        assert.deepEqual(await run(p,'return f.calls.filter(c=>c.op==="board").map(c=>c.args.projectId)'),[null,'p1',null]);
      });
      await t.test('columns independently page beyond fifty including doing without hiding completed work', async () => {
        const p=await mounted('f.items=[...Array.from({length:73},(_,i)=>f.item("todo"+i)),...Array.from({length:73},(_,i)=>({...f.item("doing"+i),status:"doing"})),{...f.item("done"),status:"done"}];');
        for(const [label,status] of [['Por hacer','todo'],['En curso','doing']]){
          const col=p.getByRole('region',{name:label,exact:true});assert.equal(await col.getByRole('button',{name:/^Abrir /}).count(),20);
          for(const count of [70,73]){await col.getByRole('button',{name:'Ver más pendientes',exact:true}).click();await idle(p);assert.equal(await col.getByRole('button',{name:/^Abrir /}).count(),count);}
          const calls=await run(p,`return f.calls.filter(c=>c.op==="items"&&c.args.status==="${status}")`);
          assert.deepEqual(calls.map((c:any)=>c.args.cursor),[20,70]);assert.ok(calls.every((c:any)=>c.args.expectedSnapshotRevision===1&&c.args.limit===50&&c.args.projectId===null));
        }
        assert.equal(await p.getByRole('region',{name:'Hecho',exact:true}).getByRole('button',{name:'Abrir Fase done',exact:true}).isVisible(),true);
        assert.match(await p.locator('.pulso-progress').innerText(),/1 de 147/);
      });
      await t.test('stale snapshot keeps loaded cards and requests explicit refresh before paging', async () => {
        const p=await mounted('f.items=Array.from({length:55},(_,i)=>f.item("page"+i));');await run(p,'f.revision++');
        await p.getByRole('button',{name:'Ver más pendientes',exact:true}).click();await idle(p);
        assert.equal(await p.getByRole('button',{name:/^Abrir /}).count(),20);assert.match(await p.locator('.pulso-feedback').innerText(),/tablero cambió|Actualiza/);
        await p.getByRole('button',{name:'Reintentar consulta',exact:true}).click();await idle(p);
        assert.equal(await p.getByRole('alert').count(), 0, 'successful reload clears the stale-page error');
        await p.getByRole('button',{name:'Ver más pendientes',exact:true}).click();await idle(p);
        assert.equal(await p.getByRole('button',{name:/^Abrir /}).count(),55);
        assert.deepEqual(await run(p,'return f.calls.filter(c=>c.op==="items").map(c=>c.args.expectedSnapshotRevision)'),[1,2]);
      });
      await t.test('card menu moves by keyboard, disables the current column and keeps undo', async () => {
        const p = await mounted();
        const button = p.getByRole('button', { name: 'Mover Fase solo', exact: true });
        await button.focus(); await p.keyboard.press('Enter');
        const menu = p.getByRole('menu', { name: 'Mover Fase solo', exact: true }); await menu.waitFor();
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        assert.equal(await menu.getByRole('menuitem', { name: /^Mover a Por hacer/ }).getAttribute('aria-disabled'), 'true');
        assert.equal(await p.evaluate(() => document.activeElement?.textContent), 'Mover a En curso');
        await p.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
        assert.equal(await button.evaluate(el => el === document.activeElement), true, 'Escape returns focus to the card button');
        assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="item_update").length'), 0);
        // Tab inside the open menu closes it and continues from the "…" button; focus never falls to body.
        await p.keyboard.press('Enter'); await menu.waitFor(); await p.keyboard.press('Tab'); await menu.waitFor({ state: 'detached' });
        assert.notEqual(await p.evaluate(() => document.activeElement?.tagName), 'BODY', 'focus never falls to body');
        // macOS WebKit skips buttons in the Tab order (no full keyboard access), so only Chromium lands on the grip.
        if (engine !== webkit) {
          assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Arrastrar Fase solo', 'Tab lands on the next control after the menu button');
          await p.keyboard.press('Shift+Tab');
        } else await button.focus();
        assert.equal(await button.evaluate(el => el === document.activeElement), true);
        await p.keyboard.press('Enter'); await menu.waitFor(); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await idle(p);
        assert.equal(await columnOf(p, 'Fase solo'), 'waiting');
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>c.op==="item_update").map(c=>c.args.status)'), ['waiting']);
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed,f.calls.filter(c=>/grant|link|pty|input|turn/.test(c.op))]'), [[], [], [], []]);
        await p.getByRole('button', { name: 'Deshacer cambio de estado', exact: true }).click(); await idle(p);
        assert.equal(await columnOf(p, 'Fase solo'), 'todo');
      });
      await t.test('cross-column CAS move retries an uncertain committed receipt with identical payload', async () => {
        const p=await mounted();await run(p,'f.timeoutAfterCommit=true');await move(p, 'Fase solo', 'doing');
        await p.getByRole('button',{name:'Reintentar mismo cambio',exact:true}).click();await idle(p);
        const calls=await run(p,'return f.calls.filter(c=>c.op==="item_update")');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
        assert.deepEqual(calls[0].args,{id:'solo',status:'doing',expectedRevision:1,requestId:calls[0].args.requestId});
        assert.equal(await run(p,'return f.items.find(i=>i.id==="solo").revision'),2);
        await p.getByRole('region',{name:'En curso',exact:true}).getByRole('button',{name:'Abrir Fase solo',exact:true}).waitFor();
        assert.equal(await p.locator('dialog[open]').count(),0);
        assert.deepEqual(await run(p,'return [f.opened,f.created,f.resumed,f.calls.filter(c=>/grant|link|pty|input|turn/.test(c.op))]'),[[],[],[],[]]);
      });
      await t.test('pointer grip moves to another column without launching sessions, sending input or granting access', async () => {
        const p=await mounted();const grip=await p.getByRole('button',{name:'Arrastrar Fase solo',exact:true}).boundingBox();const target=await p.getByRole('region',{name:'En espera',exact:true}).boundingBox();assert.ok(grip&&target);
        await p.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await p.mouse.down();await p.mouse.move(target.x+target.width/2,target.y+100,{steps:12});await p.mouse.up();
        await p.getByRole('region',{name:'En espera',exact:true}).getByRole('button',{name:'Abrir Fase solo',exact:true}).waitFor();
        const calls=await run(p,'return f.calls.filter(c=>c.op==="item_update")');assert.equal(calls.length,1);assert.equal(calls[0].args.expectedRevision,1);assert.equal(calls[0].args.status,'waiting');
        assert.equal(await p.locator('dialog[open]').count(),0);assert.deepEqual(await run(p,'return [f.opened,f.created,f.resumed,f.calls.filter(c=>/grant|link|pty|input|turn/.test(c.op))]'),[[],[],[],[]]);
      });
      await t.test('late project scope response cannot overwrite the newly selected pending board', async () => {
        const p=await mounted('f.holdBoard="p1";');await p.getByRole('button',{name:'Proyecto p1',exact:true}).click();await p.waitForFunction(()=>(window as any).fixture.held.length===1);
        await p.getByRole('button',{name:'Pendientes',exact:true}).click();await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).waitFor();
        await run(p,'f.holdBoard=undefined;f.held.splice(0).forEach(resolve=>resolve())');await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await p.getByRole('button',{name:'Pendientes',exact:true}).getAttribute('aria-current'),'true');assert.equal(await p.getByRole('button',{name:'Abrir Fase i1',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Abrir Fase solo',exact:true}).count(),1);
      });
      for (const mode of ['dirty', 'failed']) await t.test(`native forced close preserves ${mode} drawer, refocuses and keeps recovery reachable`, async () => {
        const p = await mounted(); await itemDetail(p);
        const notes = p.getByRole('dialog').getByLabel('Notas', { exact: true });
        await notes.fill('Borrador irremplazable'); await notes.focus();
        await notes.evaluate((n: HTMLTextAreaElement) => n.setSelectionRange(4, 9));
        if (mode === 'failed') {
          await run(p, 'f.failWrite=true'); await p.getByRole('button', { name: 'Guardar fase', exact: true }).click();
          await p.getByRole('button', { name: 'Reintentar mismo cambio', exact: true }).waitFor();
        }
        await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
        await p.locator('dialog[open]').waitFor();
        await p.locator('dialog').evaluate((n: HTMLDialogElement) => n.close());
        await p.waitForFunction(() => document.querySelector('dialog')?.matches(':modal'));
        assert.equal(await notes.inputValue(), 'Borrador irremplazable');
        assert.equal(await p.getByRole('dialog').evaluate(n => n.contains(document.activeElement)), true);
        if (mode === 'failed') {
          const retry = p.getByRole('dialog').getByRole('button', { name: 'Reintentar mismo cambio', exact: true });
          assert.equal(await retry.isEnabled(), true); await run(p, 'f.failWrite=false'); await retry.click(); await idle(p);
          const writes = await run(p, 'return f.calls.filter(c=>c.op==="item_update")'); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
        } else {
          assert.equal(await notes.evaluate(n => n === document.activeElement), true);
          assert.deepEqual(await notes.evaluate((n: HTMLTextAreaElement) => [n.selectionStart, n.selectionEnd]), [4, 9]);
        }
        assert.equal(await notes.inputValue(), 'Borrador irremplazable');
      });
      await t.test('project refresh already awaiting its record must preserve a newly started draft and caret', async () => {
        const p = await mounted(); await projectDetail(p);
        const title = p.getByRole('dialog').getByLabel('Nombre del proyecto', { exact: true });
        await title.evaluate(n => { (window as any).fixture.originalProjectInput = n; });
        await run(p, 'f.revision++;f.holdOps=["project"];f.pendingRefresh=f.panel.refresh();');
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'project'));
        await title.fill('Mi nuevo título'); await title.focus(); await title.evaluate((n: HTMLInputElement) => n.setSelectionRange(3, 7));
        await run(p, 'f.delayed.find(d=>d.op==="project").resolve();return f.pendingRefresh;');
        assert.equal(await title.inputValue(), 'Mi nuevo título');
        assert.equal(await title.evaluate(n => n === (window as any).fixture.originalProjectInput && n === document.activeElement), true);
        assert.deepEqual(await title.evaluate((n: HTMLInputElement) => [n.selectionStart, n.selectionEnd]), [3, 7]);
        // Proyecto saves by itself: Escape writes the pending name, then closes.
        await p.keyboard.press('Escape'); await p.locator('dialog[open]').waitFor({ state: 'detached' });
        assert.equal(await run(p, 'return f.projects[0].title'), 'Mi nuevo título');
      });
      await t.test('older board response after a completed move cannot roll back the card or its CAS revision', async () => {
        const p = await mounted();
        await run(p, 'f.revision=2;f.holdOps=["board"];f.pendingRefresh=f.panel.refresh();');
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'board'));
        await move(p, 'Fase solo', 'doing'); await idle(p);
        await run(p, 'f.delayed.find(d=>d.op==="board").resolve();return f.pendingRefresh;');
        await p.getByRole('region', { name: 'En curso', exact: true }).getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
        assert.equal(await columnOf(p, 'Fase solo'), 'doing');
        await move(p, 'Fase solo', 'done'); await idle(p);
        assert.deepEqual(await run(p, 'return f.calls.filter(c=>c.op==="item_update").map(c=>c.args.expectedRevision)'), [1, 3]);
        await p.getByRole('region', { name: 'Hecho', exact: true }).getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
      });
      await t.test('old pagination response arriving after a newer board cannot merge snapshot rows', async () => {
        const p = await mounted('f.items=Array.from({length:55},(_,i)=>f.item("race"+i));');
        // Begin refresh before pagination becomes busy; hold each response independently.
        await run(p, 'f.holdOps=["projects","items"];f.pendingRefresh=f.panel.refresh();');
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'projects'));
        await p.getByRole('button', { name: 'Ver más pendientes', exact: true }).click();
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'items'));
        await run(p, 'f.items[0].status="done";f.items[0].revision=++f.revision;f.delayed.find(d=>d.op==="projects").resolve();return f.pendingRefresh;');
        await p.getByRole('region', { name: 'Hecho', exact: true }).getByRole('button', { name: 'Abrir Fase race0', exact: true }).waitFor();
        await run(p, 'f.delayed.find(d=>d.op==="items").resolve();'); await idle(p);
        assert.equal(await p.getByRole('region', { name: 'Por hacer', exact: true }).getByRole('button', { name: /^Abrir / }).count(), 20);
        assert.equal(await p.getByRole('button', { name: 'Abrir Fase race0', exact: true }).count(), 1);
        assert.match(await p.locator('.pulso-progress').innerText(), /1 de 55/);
        assert.equal(await run(p, 'return f.calls.find(c=>c.op==="items").args.expectedSnapshotRevision'), 1);
      });
      await t.test('releasing an uncertain board move restores the selector and allows the same destination again', async () => {
        const p = await mounted(); await run(p, 'f.failWrite=true');
        await move(p, 'Fase solo', 'done');
        await p.getByRole('button', { name: 'Liberar borrador', exact: true }).click();
        assert.equal(await columnOf(p, 'Fase solo'), 'todo');
        await run(p, 'f.failWrite=false'); await move(p, 'Fase solo', 'done'); await idle(p);
        const calls = await run(p, 'return f.calls.filter(c=>c.op==="item_update")'); assert.equal(calls.length, 2);
        assert.notEqual(calls[0].args.requestId, calls[1].args.requestId); assert.equal(calls[1].args.expectedRevision, 1);
        await p.getByRole('region', { name: 'Hecho', exact: true }).getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
      });
      await t.test('remote revision refresh retains seventy loaded cards and their scroll without leaking counts across projects', async () => {
        const p = await mounted('f.items=[...Array.from({length:90},(_,i)=>f.item("prefix"+i)),...Array.from({length:90},(_,i)=>f.item("project"+i,"p1"))];');
        const todo = p.getByRole('region', { name: 'Por hacer', exact: true });
        await todo.getByRole('button', { name: 'Ver más pendientes', exact: true }).click(); await idle(p);
        assert.equal(await todo.getByRole('button', { name: /^Abrir / }).count(), 70);
        const cards = todo.locator('.pulso-cards');
        const scroll = await cards.evaluate(n => { n.scrollTop = 500; return n.scrollTop; }); assert.ok(scroll > 0);
        const ids = await todo.locator('.pulso-card').evaluateAll(ns => ns.map(n => n.getAttribute('data-item-id')));
        const before = await run(p, 'return f.calls.length');
        await run(p, 'f.items[12].title="Actualización remota";f.items[12].revision=++f.revision;return f.panel.refresh();');
        assert.equal(await todo.getByRole('button', { name: /^Abrir / }).count(), 70);
        assert.deepEqual(await todo.locator('.pulso-card').evaluateAll(ns => ns.map(n => n.getAttribute('data-item-id'))), ids);
        assert.equal(await todo.getByRole('button', { name: 'Abrir Actualización remota', exact: true }).count(), 1);
        assert.equal(await cards.evaluate(n => n.scrollTop), scroll);
        const reads = await run(p, `return f.calls.slice(${before})`);
        assert.deepEqual(reads.find((c: any) => c.op === 'board').args, { projectId: null, ifRevision: 1 });
        const pages = reads.filter((c: any) => c.op === 'items'); assert.equal(pages.length, 1);
        assert.deepEqual(pages[0].args, { projectId: null, status: 'todo', archived: false, limit: 50, cursor: 20, expectedSnapshotRevision: 2 });
        await projectBoard(p);
        assert.equal(await todo.getByRole('button', { name: /^Abrir / }).count(), 20, 'a different board starts with its own initial page');
        assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="items"&&c.args.projectId==="p1").length'), 0);
      });
      await t.test('stale continuation halfway through expanded refresh retains every old column atomically', async () => {
        const p = await mounted('f.items=[...Array.from({length:90},(_,i)=>f.item("atomic"+i)),...Array.from({length:90},(_,i)=>({...f.item("active"+i),status:"doing"}))];');
        for (const name of ['Por hacer', 'En curso']) { await p.getByRole('region', { name, exact: true }).getByRole('button', { name: 'Ver más pendientes', exact: true }).click(); await idle(p); }
        const before = await p.locator('.pulso-column').evaluateAll(ns => ns.map(n => ({ state: n.getAttribute('data-state'), text: n.textContent })));
        const cards = p.getByRole('region', { name: 'Por hacer', exact: true }).locator('.pulso-cards');
        const scroll = await cards.evaluate(n => { n.scrollTop = 500; return n.scrollTop; }); assert.ok(scroll > 0);
        await run(p, 'f.items[0].title="No mezclar esta versión";f.items[1].status="done";f.revision=2;f.holdOps=["board"];f.pendingRefresh=f.panel.refresh();');
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'board'));
        // The initial snapshot was revision 2; subsequent prefix pages now reject it.
        await run(p, 'f.revision=3;f.delayed.find(d=>d.op==="board").resolve();return f.pendingRefresh;');
        assert.deepEqual(await p.locator('.pulso-column').evaluateAll(ns => ns.map(n => ({ state: n.getAttribute('data-state'), text: n.textContent }))), before);
        assert.equal(await cards.evaluate(n => n.scrollTop), scroll);
        assert.equal(await p.getByRole('alert').count(), 1);
        assert.ok(await run(p, 'return f.calls.some(c=>c.op==="items"&&c.args.expectedSnapshotRevision===2)'));
        await p.getByRole('button', { name: 'Reintentar consulta', exact: true }).click();
        await p.getByRole('button', { name: 'Abrir No mezclar esta versión', exact: true }).waitFor();
        assert.equal(await p.getByRole('alert').count(), 0);
        for (const name of ['Por hacer', 'En curso']) assert.equal(await p.getByRole('region', { name, exact: true }).getByRole('button', { name: /^Abrir / }).count(), 70);
        assert.equal(await p.getByRole('region', { name: 'Hecho', exact: true }).getByRole('button', { name: 'Abrir Fase atomic1', exact: true }).count(), 1);
      });
      await t.test('failed project navigation locks board controls and keeps inline creation in the committed project', async () => {
        const p = await mounted('f.projects.push(f.project("p2"));'); await projectBoard(p);
        await run(p, 'f.holdOps=["project"];f.rejectDelayed="project";');
        await p.getByRole('button', { name: 'Proyecto p2', exact: true }).click();
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'project'));
        assert.equal(await p.getByLabel('Mover Fase i1', { exact: true }).isDisabled(), true);
        assert.equal(await p.getByRole('button', { name: 'Abrir Fase i1', exact: true }).isDisabled(), true);
        assert.equal(await p.getByRole('button', { name: 'Proyecto', exact: true }).isDisabled(), true);
        const todo = p.getByRole('region', { name: 'Por hacer', exact: true });
        assert.equal(await todo.getByRole('button', { name: 'Añadir fase', exact: true }).isDisabled(), true);
        assert.equal(await p.getByRole('button', { name: 'Proyecto p1', exact: true }).isEnabled(), true, 'tabs remain available for a newer selection');
        await run(p, 'f.delayed.find(d=>d.op==="project").resolve();');
        await p.waitForFunction(() => !(document.querySelector('.pulso-add-trigger') as HTMLButtonElement)?.disabled);
        assert.equal(await p.getByRole('alert').count(), 1);
        assert.equal(await p.getByRole('button', { name: 'Proyecto p1', exact: true }).getAttribute('aria-current'), 'true');
        await todo.getByRole('button', { name: 'Añadir fase', exact: true }).click();
        await todo.getByLabel('Título de la fase', { exact: true }).fill('Crear en el proyecto confirmado');
        await todo.getByRole('button', { name: 'Añadir fase', exact: true }).click(); await idle(p);
        const writes = await run(p, 'return f.calls.filter(c=>c.op==="item_create")');
        assert.equal(writes.length, 1); assert.equal(writes[0].args.projectId, 'p1'); assert.equal(writes[0].args.status, 'todo');
        await todo.getByRole('button', { name: 'Abrir Crear en el proyecto confirmado', exact: true }).waitFor();
        assert.equal(await run(p, 'return f.items.some(i=>i.projectId==="p2"&&i.title==="Crear en el proyecto confirmado")'), false);
      });
      await t.test('hiding during project navigation reopens the committed board with usable controls', async () => {
        const p = await mounted('f.projects.push(f.project("p2"));'); await projectBoard(p);
        await run(p, 'f.holdOps=["project"];'); await p.getByRole('button', { name: 'Proyecto p2', exact: true }).click();
        await p.waitForFunction(() => (window as any).fixture.delayed.some((d: any) => d.op === 'project'));
        await run(p, 'f.panel.hide();f.panel.show();');
        await p.waitForFunction(() => !(document.querySelector('[aria-label="Mover Fase i1"]') as HTMLSelectElement)?.disabled);
        assert.equal(await p.getByRole('button', { name: 'Proyecto p1', exact: true }).getAttribute('aria-current'), 'true');
        assert.equal(await p.getByLabel('Mover Fase i1', { exact: true }).isEnabled(), true);
        await run(p, 'f.delayed.find(d=>d.op==="project").resolve();');
        await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await p.getByRole('button', { name: 'Proyecto p1', exact: true }).getAttribute('aria-current'), 'true');
        assert.equal(await p.getByRole('button', { name: 'Abrir Fase i1', exact: true }).isEnabled(), true);
      });
      await t.test('Escape and leaving Pulso cancel active pointer drags without a late mutation', async () => {
        const p = await mounted();
        for (const cancel of ['escape', 'hide']) {
          const grip = await p.getByRole('button', { name: 'Arrastrar Fase solo', exact: true }).boundingBox();
          const target = await p.getByRole('region', { name: 'En espera', exact: true }).boundingBox(); assert.ok(grip && target);
          await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await p.mouse.down();
          await p.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 8 });
          assert.equal(await p.locator('.is-dragging').count(), 1);
          if (cancel === 'escape') await p.keyboard.press('Escape'); else await run(p, 'f.panel.hide();');
          await p.mouse.up(); if (cancel === 'hide') await run(p, 'f.panel.show();');
          await p.getByRole('button', { name: 'Abrir Fase solo', exact: true }).waitFor();
          assert.equal(await p.locator('.is-dragging,.is-drop-target').count(), 0);
          assert.equal(await columnOf(p, 'Fase solo'), 'todo');
          assert.equal(await run(p, 'return f.calls.filter(c=>c.op==="item_update").length'), 0);
        }
        assert.deepEqual(await run(p, 'return [f.opened,f.created,f.resumed]'), [[], [], []]);
      });
      await t.test('visible polling requests revision only; hidden/document hidden/dispose stop polling and fence late reads', async () => {
        const p = await mounted(); const initial = await run(p, 'return f.calls.length');
        await p.waitForTimeout(2150); const poll = await run(p, `return f.calls.slice(${initial})`); assert.deepEqual(poll.map((x: any) => x.op), ['revision']);
        await run(p, 'f.panel.hide()'); const hidden = await run(p, 'return f.calls.length'); await p.waitForTimeout(2150); assert.equal(await run(p, 'return f.calls.length'), hidden);
        await run(p, 'f.panel.show()'); await p.waitForTimeout(30);
        await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
        const docHidden = await run(p, 'return f.calls.length'); await p.waitForTimeout(2150); assert.equal(await run(p, 'return f.calls.length'), docHidden);
        await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
        await p.waitForTimeout(30); await run(p, 'f.holdRead=true; f.panel.refresh()'); await p.waitForTimeout(30);
        await run(p, 'f.panel.dispose(); f.panel.dispose(); f.held.forEach(r=>r());');
        assert.equal(await p.locator('.pulso-panel').count(), 0); await run(p, 'f.panel.show()'); assert.equal(await p.locator('.pulso-panel').count(), 0);
      });
      await t.test('dirty draft and caret survive revision refresh; compact layouts fit light and dark themes', async () => {
        const p = await mounted(); await itemDetail(p); const notes = p.getByLabel('Notas', { exact: true });
        await notes.fill('No perder'); await notes.focus(); await notes.evaluate((n: HTMLTextAreaElement) => n.setSelectionRange(2, 5)); await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await notes.inputValue(), 'No perder'); assert.equal(await notes.evaluate(n => n === document.activeElement), true);
        assert.deepEqual(await notes.evaluate((n: HTMLTextAreaElement) => [n.selectionStart, n.selectionEnd]), [2, 5]);
        await p.keyboard.press('Escape'); assert.equal(await p.locator('dialog[open]').count(), 1);
        assert.equal(await notes.inputValue(), 'No perder');
        await p.getByRole('button', { name: 'Descartar borrador', exact: true }).first().click(); await idle(p);
        for (const [width, height, theme] of [[1120, 850, 'light'], [760, 640, 'dark'], [360, 600, 'light']] as const) {
          await p.setViewportSize({ width, height }); await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          const dimensions = await p.locator('.pulso-panel').evaluate(n => ({ width: n.getBoundingClientRect().width, overflow: n.scrollWidth > n.clientWidth }));
          assert.ok(dimensions.width <= width); assert.equal(dimensions.overflow, false);
          assert.equal(await p.locator('.pulso-detail').evaluate(n => n.scrollWidth > n.clientWidth), false);
          if (process.env.PULSO_SCREENSHOTS && (width === 1120 || width === 360)) await p.screenshot({ path: `${process.env.PULSO_SCREENSHOTS}/pulso-${width}.png` });
        }
        assert.equal(await p.getByRole('dialog').evaluate(n => n instanceof HTMLDialogElement && n.matches(':modal')), true);
        await p.keyboard.press('Escape'); assert.equal(await p.locator('dialog[open]').count(), 0);
      });
    });
  }
}

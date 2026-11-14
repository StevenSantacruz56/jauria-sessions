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
        calls: [] as any[], revision: 1, projects: [project('p1')], items: [item('i1', 'p1'), item('solo')], checkpoints: [] as any[], links: [] as any[],
        policies: [{ id: 'policy-1', policy: { projectId: 'p1', provider: 'claude', cwd: '/synthetic', canCreateProjects: true } }],
        sessions: [{ id: 'ended', title: 'Claude anterior', kind: 'claude', cwd: '/synthetic', status: 'exited' }, { id: 'live', title: 'Claude viva', kind: 'claude', cwd: '/synthetic', status: 'running' }, { id: 'attention', title: 'Sin confirmar', kind: 'claude', cwd: null, status: 'needs_attention' }],
        opened: [] as string[], created: [] as any[], notices: [] as string[], resumed: [] as string[], bindings: [] as string[], copied: [] as string[],
        receipts: new Map(), failWrite: false, failRead: false, timeoutAfterCommit: false, holdRead: false, held: [] as any[], bindingProvider: 'claude',
        project, item,
      };
      Function('f', setup)(f);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { f.copied.push(text); } } });
      f.request = async (op: string, args: any) => {
        f.calls.push({ op, args: structuredClone(args) });
        if (f.holdRead && op === 'projects') await new Promise(resolve => f.held.push(resolve));
        if (f.failRead && ['projects', 'items', 'revision'].includes(op)) throw 'offline';
        if (op === 'revision') return { revision: f.revision };
        if (op === 'projects' || op === 'items') {
          const all = op === 'projects' ? f.projects : f.items.filter((i: any) => i.projectId === args.projectId);
          const cursor = args.cursor ?? 0; if (typeof cursor !== 'number') throw 'numeric offset required';
          const rows = all.slice(cursor, cursor + args.limit);
          return { [op]: structuredClone(rows), revision: f.revision, hasMore: all.length > cursor + rows.length };
        }
        if (op === 'project') return { project: structuredClone(f.projects.find((p: any) => p.id === args.id)) };
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
      f.panel = w.Pulso.mountPulsoPanel({
        host: document.querySelector('#stage'), request: f.request, sessions: () => f.sessions, currentSession: () => f.sessions[1],
        openSession: (id: string) => f.opened.push(id), newSession: (cwd?: string) => f.created.push(cwd), notice: (text: string) => f.notices.push(text),
        binding: async (id: string) => { f.bindings.push(id); return { binding: f.bindingProvider ? { provider: f.bindingProvider, conversationId: 'synthetic-conversation' } : null,activeSessionId:f.activeNative??null }; },
        resumeSession: async (id: string) => { f.resumed.push(id); },
      });
    }, setup);
    await run(page, 'f.panel.show()'); await page.getByRole('button', { name: 'Proyecto p1', exact: true }).waitFor();
    return page;
  }
  for (const engine of process.env.PULSO_PANEL_WEBKIT === '1' ? [chromium, webkit] : [chromium]) {
    await test(`${engine.name()}: Pulso isolated stage`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {}); t.after(() => browser.close());
      async function mounted(setup = '') { const p = await fixture(browser, setup); t.after(() => p.close()); return p; }
      const projectDetail = async (p: Page) => { await p.getByRole('button', { name: 'Proyecto p1', exact: true }).click(); await p.getByLabel('Título del proyecto', { exact: true }).waitFor(); };
      const itemDetail = async (p: Page) => { await projectDetail(p); await p.getByRole('button', { name: 'Fase i1 Por hacer', exact: true }).click(); await p.getByLabel('Título de la fase', { exact: true }).waitFor(); };

      await t.test('capture needs only title; plans are literal text, main session remains canonical', async () => {
        const p = await mounted();
        assert.equal(await p.getByLabel('Captura rápida').getAttribute('maxlength'), '240');
        await p.getByLabel('Captura rápida').fill('Comprar material'); await p.getByRole('button', { name: 'Añadir', exact: true }).click(); await idle(p);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_create")'); assert.equal(calls.length, 1);
        assert.deepEqual(Object.keys(calls[0].args).sort(), ['id', 'requestId', 'title']);
        await projectDetail(p); assert.equal(await p.getByLabel('Sesión principal', { exact: true }).inputValue(), 'ended');
        await p.getByText('Plan completo (opcional)', { exact: true }).click();
        assert.match(await p.getByLabel('Plan completo ·').inputValue(), /<script>/); assert.equal(await run(p, 'return window.compromised'), undefined);
        assert.equal(await p.getByLabel('Plan completo ·').getAttribute('maxlength'), '32000');
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="grant")')).length, 0);
      });
      await t.test('a new plan can explicitly keep the selected conversation as its main session', async () => {
        const p=await mounted();
        await p.getByLabel('Guardar como').selectOption('project');
        const origin=p.getByLabel(/Usar.*sesión principal/);assert.equal(await origin.isChecked(),true);
        await p.getByLabel('Captura rápida').fill('Plan de la conversación');await p.getByRole('button',{name:'Añadir',exact:true}).click();await idle(p);
        assert.equal(await run(p,'return f.calls.find(x=>x.op==="project_create").args.mainSessionId'),'live');
        assert.equal(await run(p,'return f.projects.find(p=>p.id==="p1").mainSessionId'),'ended');
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
        await p.getByLabel('Captura rápida').fill('Captura única'); await p.getByRole('button', { name: 'Añadir', exact: true }).click();
        await p.getByRole('button', { name: 'Reintentar mismo cambio' }).click(); await idle(p);
        assert.equal(await run(p, 'return f.items.filter(x=>x.title==="Captura única").length'), 1);
        const calls = await run(p, 'return f.calls.filter(x=>x.op==="item_create")'); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
      });
      await t.test('undo uses inverse status and the resulting revision, never overwrites a concurrent edit', async () => {
        const p = await mounted(); await itemDetail(p); await p.getByLabel('Estado', { exact: true }).selectOption('done');
        await p.getByRole('button', { name: 'Guardar fase', exact: true }).click(); await idle(p);
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
        await p.getByLabel('Qué quedó listo ·').fill('Implementado'); await p.getByLabel('Siguiente acción ·').fill('Verificar');
        await p.getByRole('button', { name: 'Registrar checkpoint', exact: true }).click(); await idle(p);
        assert.equal(await run(p, 'return f.checkpoints.length'), 1);
        assert.match(await p.locator('.pulso-history').innerText(), /Implementado/);
        await p.getByRole('button', { name: 'Preparar contexto' }).click(); await p.getByLabel('Contexto editable para continuar').fill('Contexto revisado');
        await p.getByRole('button', { name: 'Copiar contexto', exact: true }).click();
        await p.getByRole('button', { name: 'Abrir nueva sesión', exact: true }).click();
        assert.deepEqual(await run(p, 'return f.copied'), ['Contexto revisado']); assert.deepEqual(await run(p, 'return f.created'), ['/synthetic']);
        assert.equal((await run(p, 'return f.calls.filter(x=>/pty|input|turn/.test(x.op))')).length, 0);
      });
      await t.test('older continuity points load only on request while the latest context remains selected', async () => {
        const p=await mounted('f.checkpoints=Array.from({length:12},(_,i)=>({id:"cp"+i,itemId:"i1",brief:"Point "+i,nextAction:"Next",revision:i,actor:"fixture",createdAt:Date.parse("2026-11-14T12:00:00Z")}));');await itemDetail(p);
        assert.equal((await run(p,'return f.calls.filter(c=>c.op==="checkpoint_history")')).length,0);
        await p.getByRole('button',{name:'Ver puntos anteriores',exact:true}).click();await idle(p);
        assert.equal(await p.locator('.pulso-history li').count(),12);
        const call=await run(p,'return f.calls.find(c=>c.op==="checkpoint_history")');assert.deepEqual(call.args,{itemId:'i1',cursor:10,limit:10});
        await p.getByRole('button',{name:'Preparar contexto'}).click();assert.match(await p.getByLabel('Contexto editable para continuar').inputValue(),/Point 11/);
        assert.equal(await p.getByRole('button',{name:'Ver puntos anteriores',exact:true}).count(),0);
      });
      await t.test('history, live focus, uncertain inspection and Claude resume are separate; bindings do not poll', async () => {
        const p = await mounted('f.links=[{itemId:"i1",sessionId:"live"},{itemId:"i1",sessionId:"attention"}];'); await itemDetail(p);
        await p.getByRole('button', { name: 'Intentar reanudar conversación' }).waitFor();
        assert.match(await p.locator('.pulso-detail').innerText(), /Historial local/);
        await p.getByRole('button', { name: 'Enfocar sesión viva' }).click(); await p.getByRole('button', { name: 'Inspeccionar sesión' }).click();
        await p.getByRole('button',{name:'Ver historial',exact:true}).click();
        await p.getByRole('button', { name: 'Intentar reanudar conversación' }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.opened'), ['live', 'attention', 'ended']); assert.deepEqual(await run(p, 'return f.resumed'), ['ended']);
        const count = await run(p, 'return f.bindings.length'); await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await run(p, 'return f.bindings.length'), count);
        const q = await mounted('f.bindingProvider="codex";'); await itemDetail(q);
        assert.equal(await q.getByRole('button', { name: 'Intentar reanudar conversación' }).count(), 0);
      });
      await t.test('an exact live continuation opens without launching the conversation again',async()=>{
        const p=await mounted('f.activeNative="live";');await projectDetail(p);
        await p.getByRole('button',{name:'Volver a conversación reanudada',exact:true}).click();
        assert.deepEqual(await run(p,'return f.opened'),['live']);assert.deepEqual(await run(p,'return f.resumed'),[]);
        assert.equal(await p.getByRole('button',{name:'Intentar reanudar conversación',exact:true}).count(),0);
      });
      await t.test('a stopped session changes to history without a planning mutation or provider poll',async()=>{
        const p=await mounted('f.projects[0].mainSessionId="live"');
        await p.getByRole('button',{name:'Proyecto p1',exact:true}).click();await idle(p);
        assert.equal(await p.getByRole('button',{name:'Enfocar sesión viva',exact:true}).count(),1);
        await run(p,'f.sessions.find(s=>s.id==="live").status="exited"');
        await p.getByRole('button',{name:'Ver historial',exact:true}).waitFor({timeout:4000});
        assert.equal(await p.getByRole('button',{name:'Enfocar sesión viva',exact:true}).count(),0);
        assert.equal(await run(p,'return f.revision'),1);
      });
      await t.test('grant is explicitly scoped, command is copyable, opaque credentials never enter DOM', async () => {
        const p = await mounted(); await projectDetail(p);
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="grant")')).length, 0);
        await p.getByLabel('Sesión que recibirá permiso').selectOption('live');
        await p.getByRole('button', { name: 'Permitir registrar planes' }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.calls.find(x=>x.op==="grant").args'), { sessionId: 'live', projectId: 'p1', canCreateProjects: true });
        assert.doesNotMatch(await p.locator('.pulso-panel').innerText(), /opaque-not-for-dom|secret-not-for-dom/);
        assert.match(await p.getByLabel('Comando de registro', { exact: true }).inputValue(), /--handle/);
        await p.getByRole('button', { name: 'Copiar comando de registro' }).click();
        assert.equal((await run(p, 'return f.copied')).length, 1);
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await p.getByLabel('Sesión que recibirá permiso').inputValue(), 'live');
        assert.equal(await p.getByRole('button', { name: 'Revocar permiso', exact: true }).isVisible(), true);
        await p.getByRole('button', { name: 'Revocar permiso', exact: true }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.calls.find(x=>x.op==="revoke").args'), { sessionId: 'live' });
      });
      await t.test('pages are bounded to 50 and numeric fallback offsets advance without duplicate rows', async () => {
        const p = await mounted('f.projects=Array.from({length:55},(_,i)=>f.project(i===0?"p1":"p"+(i+1)));');
        assert.equal(await p.locator('.pulso-outline .pulso-row').count(), 51);
        await p.getByRole('button', { name: 'Cargar más proyectos' }).click(); await idle(p);
        assert.equal(await p.locator('.pulso-outline .pulso-row').count(), 56);
        const pages = await run(p, 'return f.calls.filter(x=>x.op==="projects")'); assert.equal(pages[1].args.cursor, 50); assert.equal(pages[1].args.limit, 50);
      });
      await t.test('remember requires opt-in; saved policies load and revoke only on explicit action', async () => {
        const p = await mounted(); await projectDetail(p);
        const remember = p.getByLabel('Recordar para futuras sesiones de esta herramienta en esta carpeta');
        assert.equal(await remember.isChecked(), false);
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="policies")')).length, 0);
        await p.getByLabel('Sesión que recibirá permiso').selectOption('live'); await remember.check();
        await p.getByRole('button', { name: 'Permitir registrar planes' }).click(); await idle(p);
        assert.equal(await run(p, 'return f.calls.find(x=>x.op==="grant").args.remember'), true);
        await p.getByRole('button', { name: 'Gestionar permisos recordados' }).click(); await idle(p);
        assert.match(await p.locator('.pulso-policies').innerText(), /claude · \/synthetic/);
        await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal((await run(p, 'return f.calls.filter(x=>x.op==="policies")')).length, 1);
        await p.getByRole('button', { name: 'Gestionar permisos recordados' }).click(); await idle(p);
        await p.getByRole('button', { name: 'Revocar permiso recordado' }).click(); await idle(p);
        assert.deepEqual(await run(p, 'return f.calls.find(x=>x.op==="revoke_policy").args'), { id: 'policy-1' });
        assert.match(await p.locator('.pulso-policies').innerText(), /No hay permisos recordados/);
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
        await notes.fill('No perder'); await notes.focus(); await run(p, 'f.revision++; return f.panel.refresh()');
        assert.equal(await notes.inputValue(), 'No perder'); assert.equal(await notes.evaluate(n => n === document.activeElement), true);
        await p.getByRole('button', { name: 'Descartar borrador', exact: true }).first().click(); await idle(p);
        for (const [width, height, theme] of [[1120, 850, 'light'], [760, 640, 'dark'], [360, 600, 'light']] as const) {
          await p.setViewportSize({ width, height }); await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          const dimensions = await p.locator('.pulso-panel').evaluate(n => ({ width: n.getBoundingClientRect().width, overflow: n.scrollWidth > n.clientWidth }));
          assert.ok(dimensions.width <= width); assert.equal(dimensions.overflow, false);
          assert.equal(await p.locator('.pulso-detail').evaluate(n => n.scrollWidth > n.clientWidth), false);
          if (process.env.PULSO_SCREENSHOTS && (width === 1120 || width === 360)) await p.screenshot({ path: `${process.env.PULSO_SCREENSHOTS}/pulso-${width}.png` });
        }
      });
    });
  }
}

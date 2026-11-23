/** Real shell/xterm; synthetic native boundary. No providers or user profiles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,hmr:false}});await server.listen();
const url=server.resolvedUrls!.local[0];
type FixtureOptions = { mainClosed?: boolean; activeContinuation?: boolean; savedProject?: string; volatileStatus?: boolean };
async function install(page:Page, history = '', options: FixtureOptions = {}){await page.addInitScript(({history, options})=>{
 const w=window as any;const sessions=[{id:'main',title:'Plan sintético · Integración',kind:'claude',cwd:'/synthetic/project',status:'running',rows:24,cols:80},{id:'related',title:'Fase sintética · Validación',kind:'codex',cwd:'/synthetic/other',status:'running',rows:24,cols:80}];
 if(options.mainClosed)sessions[0].status='exited';
 if(options.activeContinuation)sessions.push({...sessions[0],id:'continued',title:'Continuación sintética',status:'running'});
 const runnerCalls:any[]=[];
 if(options.savedProject && !localStorage.getItem('jauria-pulso:last-board:/synthetic'))localStorage.setItem('jauria-pulso:last-board:/synthetic',JSON.stringify({schemaVersion:1,projectId:options.savedProject}));
 const events:any[]=history?[{seq:1,sessionId:'main',kind:'output',data:btoa(history)}]:[],resizes:any[]=[],inputs:any[]=[],calls:any[]=[];let rev=3,statusReads=0;
 const projects:any[]=[{id:'plan',title:'Integrar Pulso en Jauria',plan:'Plan de demostración sintético.\n1. Definir el modelo\n2. Implementar\n3. Validar la fluidez',mainSessionId:'main',revision:1,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 const items:any[]=[{id:'phase',projectId:'plan',title:'Validar la fluidez de las terminales',note:'Contenido sintético para comprobar navegación.',status:'doing',position:0,revision:2,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'},{id:'todo',projectId:null,title:'Preparar la revisión de mañana',note:'',status:'todo',position:0,revision:3,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 // Keep every board column populated for visual review; the phase under test stays first.
 for(const [id,title,status] of [['scope','Definir el alcance de la entrega','todo'],['implementation','Integrar el tablero con el shell','doing'],['model','Modelo y checkpoints verificados','done']])items.push({...items[0],id,title,status,note:'Datos de prueba sintéticos.',revision:1});
 const status=()=>{statusReads++;w.pulsoFixture.statusReads=statusReads;return{pid:123,generation:'pulso-synthetic',pulsoVersion:1,pulsoBoardVersion:1,pulsoAvailable:true,nativeResumeVersion:1,workspaceVersion:1,projectLifecycleVersion:1,projects:[],tasks:[],normalTerminalVersion:1,settingsVersion:1,settings:{schemaVersion:1,maxConcurrentSessions:2,maxSupportedSessions:8},sessions:structuredClone(sessions).map(s=>options.volatileStatus?{...s,lastObservedAt:statusReads}:s),lastSeq:events.length};};
 w.pulsoFixture={calls,runnerCalls,resizes,inputs,sessions,statusReads:0,connections:0,holdNext:null,held:[],output(data:string){events.push({seq:events.length+1,sessionId:'main',kind:'output',data:btoa(data)});},phase:()=>structuredClone(items[0])};
 w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},async invoke(cmd:string,a:any){
  if(cmd==='connect_runner'){w.pulsoFixture.connections++;return{dataDir:'/synthetic',socket:'/synthetic/sock',status:status(),smoke:true};}
  if(cmd==='probe_tools')return[];if(cmd==='record_ui_evidence')return;if(cmd==='plugin:window|set_badge_count')return;
  if(cmd==='pulso_request'){
   calls.push({op:a.op,args:structuredClone(a.args)});const x=a.args;let result:any;
   if(a.op==='revision')result={revision:rev};
   else if(a.op==='projects'){const cursor=x.cursor??0;result={projects:structuredClone(projects.slice(cursor,cursor+x.limit)),revision:rev,totalCount:projects.length,hasMore:projects.length>cursor+x.limit};}
   else if(a.op==='project')result={project:structuredClone(projects.find(p=>p.id===x.id))};
   else if(a.op==='board')result={revision:rev,columns:Object.fromEntries(['todo','doing','waiting','done'].map(status=>{const rows=items.filter(i=>!i.archived&&i.projectId===x.projectId&&i.status===status);return[status,{items:structuredClone(rows.slice(0,20)),totalCount:rows.length,hasMore:rows.length>20,nextCursor:20}];}))};
   else if(a.op==='items'){if(x.expectedSnapshotRevision!==rev)return{ok:false,error:'stale snapshot'};const rows=items.filter(i=>!i.archived&&i.projectId===x.projectId&&(!x.status||i.status===x.status));const cursor=x.cursor??0;result={items:structuredClone(rows.slice(cursor,cursor+x.limit)),revision:rev,totalCount:rows.length,hasMore:rows.length>cursor+x.limit};}
   else if(a.op==='links')result={links:[]};
   else if(a.op==='item')result={item:structuredClone(items.find(i=>i.id===x.id)),links:[{itemId:'phase',sessionId:'related'}],checkpoints:[{id:'cp',itemId:'phase',brief:'Modelo terminado. Pendiente medir latencia.',nextAction:'Ejecutar las pruebas con ocho sesiones sintéticas.',sessionId:'main',actor:'synthetic-agent',createdAt:'2026-11-14T11:00:00Z'}]};
   else if(a.op==='activity')result={events:[]};
   else if(a.op==='policies')result={policies:[]};
   else if(a.op==='link')result={link:structuredClone(x)};
   else if(a.op==='item_update'){const item=items.find(i=>i.id===x.id);if(item.revision!==x.expectedRevision)return{ok:false,error:'revision conflict'};Object.assign(item,Object.fromEntries(Object.entries(x).filter(([k])=>!['requestId','expectedRevision'].includes(k))),{revision:++rev});result={item:structuredClone(item)};}
   else return{ok:false,error:'Unexpected synthetic operation'};
   if(w.pulsoFixture.holdNext===a.op&&Object.entries(w.pulsoFixture.holdWhen??{}).every(([k,v])=>x[k]===v)){w.pulsoFixture.holdNext=null;w.pulsoFixture.holdWhen=null;await new Promise(resolve=>w.pulsoFixture.held.push({op:a.op,result,resolve}));}
   return{ok:true,result};
  }
  if(cmd==='runner_request'){
   runnerCalls.push({op:a.op,args:structuredClone(a.args)});
   if(a.op==='get_settings')return{ok:true,result:{schemaVersion:1,maxConcurrentSessions:2,maxSupportedSessions:8}};
   if(a.op==='status')return{ok:true,result:status()};if(a.op==='telemetry')return{ok:true,result:{}};
   if(a.op==='events')return{ok:true,result:{events:events.filter(e=>e.seq>a.args.after),lastSeq:events.length,hasMore:false}};
   if(a.op==='resize'){resizes.push(a.args);const s=sessions.find(s=>s.id===a.args.id)!;s.rows=a.args.rows;s.cols=a.args.cols;return{ok:true,result:{rows:s.rows,cols:s.cols}};}
   if(a.op==='input'){inputs.push(a.args);return{ok:true,result:{written:a.args.data.length}};}
   if(a.op==='native_binding')return{ok:true,result:{binding:a.args.id==='main'?{provider:'claude',conversationId:'synthetic-main-conversation'}:null,activeSessionId:options.activeContinuation?'continued':null}};
   if(a.op==='resume_native'){const session={...sessions[0],id:a.args.id,status:'running'};sessions.push(session);return{ok:true,result:structuredClone(session)};}
  }
  throw Error(`Unexpected fixture command ${cmd}:${a?.op??''}`);
 },transformCallback(){return 1;},unregisterCallback(){}};
}, {history, options});}
if(process.env.PULSO_PANEL_BROWSER!=='1')test('workbench browser coverage requires PULSO_PANEL_BROWSER=1',{skip:true},()=>{});
try{
 for(const engine of(process.env.PULSO_PANEL_BROWSER==='1'?(process.env.PULSO_PANEL_WEBKIT==='1'?[chromium,webkit]:[chromium]):[])){await test(`${engine.name()}: Pulso preserves the live terminal and isolates polling`,async()=>{
  const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await install(page);await page.goto(url);await page.locator('#open-pulso').waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
   await page.locator('#session-list').getByRole('button',{name:/Plan sintético · Integración/}).click();
   await page.locator('#toggle-split').click();await page.waitForTimeout(300);await page.evaluate(()=>{const f=(window as any).pulsoFixture;f.original=document.querySelector('.xterm');f.output(Array.from({length:120},(_,i)=>`Synthetic line ${i}`).join('\r\n')+'\r\n');});
   await page.waitForTimeout(500);await page.evaluate(()=>{const viewport=document.querySelector('.xterm-viewport')as HTMLElement;viewport.scrollTop=200;(window as any).pulsoFixture.scroll=viewport.scrollTop;});
   const prior=await page.evaluate(()=>(window as any).pulsoFixture.resizes.length);
   await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
   assert.equal(await page.locator('dialog[open]').count(),0,'project tab opens only the board');
   await page.getByRole('button',{name:'Mover Validar la fluidez de las terminales',exact:true}).click();await page.getByRole('menuitem',{name:'Mover a En espera',exact:true}).click();
   await page.getByRole('region',{name:'En espera',exact:true}).getByRole('button',{name:'Abrir Validar la fluidez de las terminales',exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='grant'||c.op==='link').length),0);
   await page.getByRole('button',{name:'Abrir Validar la fluidez de las terminales',exact:true}).click();
   await page.locator('dialog[open]').waitFor();await page.getByText('Modelo terminado. Pendiente medir latencia.',{exact:true}).first().waitFor();
   await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.resizes.length),prior,'opening planning must not resize PTY');
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0,'planning must not send provider input');
   const screenshotDir=process.env.PULSO_SCREENSHOT_DIR;if(screenshotDir){
    await mkdir(screenshotDir,{recursive:true});
    await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-detail-light.png`});
    await page.getByRole('button',{name:'Cerrar detalle',exact:true}).click();await page.waitForTimeout(300);
    await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-light-1280.png`});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(300);await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-dark-1280.png`});
    await page.setViewportSize({width:760,height:640});await page.waitForTimeout(300);await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-dark-760.png`});
    await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.waitForTimeout(300);await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-light-760.png`});
    await page.setViewportSize({width:1280,height:820});await page.waitForTimeout(300);
    await page.getByRole('button',{name:'Abrir Validar la fluidez de las terminales',exact:true}).click();
   }
   await page.getByRole('button',{name:/Enfocar sesión viva/}).first().click();await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.original===document.querySelector('.xterm')),true,'same xterm instance retained');
   assert.equal(await page.evaluate(()=>(document.querySelector('.xterm-viewport') as HTMLElement).scrollTop), await page.evaluate(()=>(window as any).pulsoFixture.scroll), 'reading position retained across planning navigation');
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.resizes.some((r:any)=>r.cols<2||r.rows<2)),false);
   const calls=await page.evaluate(()=>(window as any).pulsoFixture.calls.length);await page.waitForTimeout(2200);assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.length),calls,'no planning polls while hidden');
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
  await test(`${engine.name()}: session buttons survive status polling during a switch`, async () => {
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});
    try {
      await install(page,'',{volatileStatus:true});await page.goto(url);
      const other=page.locator('#session-list .session-item').filter({hasText:'Fase sintética · Validación'});
      await other.waitFor();await other.scrollIntoViewIfNeeded();
      await page.evaluate(()=>{(window as any).pulsoFixture.switchButton=document.querySelectorAll('#session-list .session-item')[1];});
      const before=await page.evaluate(()=>(window as any).pulsoFixture.statusReads);
      await page.waitForFunction(before=>(window as any).pulsoFixture.statusReads>before,before);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.switchButton===document.querySelectorAll('#session-list .session-item')[1]),true,'status metadata must not replace the button');
      const box=await other.boundingBox();assert.ok(box);
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      const pressedAt=await page.evaluate(()=>(window as any).pulsoFixture.statusReads);
      await page.waitForFunction(before=>(window as any).pulsoFixture.statusReads>before,pressedAt);
      await page.mouse.up();
      assert.equal(await page.locator('#workspace-title').textContent(),'Fase sintética · Validación');
      assert.equal(await page.locator('#session-0').getAttribute('data-session-id'),'related');
      await page.locator('#session-0').click();await page.locator('.pane:nth-child(1) .session-picker [role="option"][data-session-id="main"]').click();
      assert.equal(await page.locator('#workspace-title').textContent(),'Plan sintético · Integración');
      await page.locator('#toggle-split').click();
      assert.equal(await page.locator('#session-1').getAttribute('data-session-id'),'related');
      await other.click();
      assert.equal(await page.locator('#workspace-title').textContent(),'Fase sintética · Validación');
      assert.equal(await page.locator('#session-0').getAttribute('data-session-id'),'main','split navigation must keep the other pane');
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0,'switching must not send terminal input');
      await page.keyboard.type('x');
      await page.waitForFunction(()=>(window as any).pulsoFixture.inputs.length>0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.at(-1).id),'related','typing after the switch must reach the focused session');
    } finally {await browser.close();}
  });
  await test(`${engine.name()}: ended main conversation resumes through the native boundary only after explicit click`, async () => {
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{}); const page=await browser.newPage();
    try {
      await install(page, '', {mainClosed:true}); await page.goto(url);
      await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.locator('#open-pulso').click(); await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      const resume=page.locator('.pulso-board-toolbar').getByRole('button',{name:/Reanudar.*principal/}); await resume.waitFor();
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.runnerCalls.filter((c:any)=>/resume_native|^(start|input)$/.test(c.op))),[]);
      const bindings=await page.evaluate(()=>(window as any).pulsoFixture.runnerCalls.filter((c:any)=>c.op==='native_binding'));
      assert.deepEqual(bindings.map((c:any)=>c.args),[{id:'main'}]);
      await resume.click(); await page.waitForFunction(()=>(window as any).pulsoFixture.runnerCalls.some((c:any)=>c.op==='resume_native'));
      const commands=await page.evaluate(()=>(window as any).pulsoFixture.runnerCalls.filter((c:any)=>/resume_native|^(start|input)$/.test(c.op)));
      assert.equal(commands.length,1); assert.equal(commands[0].op,'resume_native'); assert.equal(commands[0].args.sourceId,'main');
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
    } finally {await browser.close();}
  });
  await test(`${engine.name()}: existing native continuation receives focus at full capacity without launch`, async () => {
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{}); const page=await browser.newPage();
    try {
      await install(page,'',{mainClosed:true,activeContinuation:true}); await page.goto(url);
      await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.locator('#open-pulso').click(); await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      const cta=page.locator('.pulso-board-toolbar').getByRole('button',{name:/Abrir sesión principal|Abrir conversación activa/}); await cta.click();
      await page.waitForFunction(()=>document.querySelector('.session-item[aria-current="true"]')?.textContent?.includes('Continuación sintética'));
      assert.equal(await page.locator('#pulso-panel-host').isVisible(),false);
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.runnerCalls.filter((c:any)=>/resume_native|^(start|input)$/.test(c.op))),[]);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.sessions.filter((s:any)=>s.status==='running').length),2);
    } finally {await browser.close();}
  });
  await test(`${engine.name()}: project permission shortcut scopes the project and requires session choice`, async () => {
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{}); const page=await browser.newPage();
    try {
      await install(page); await page.goto(url); await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.locator('#session-list').getByRole('button',{name:/Plan sintético · Integración/}).click();
      await page.locator('#open-pulso').click(); await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      await page.getByRole('button',{name:'Plan y sesiones',exact:true}).click();
      await page.getByRole('button',{name:'Configurar permisos…',exact:true}).click();
      const settings=page.getByRole('dialog',{name:'Configuración',exact:true}); await settings.waitFor();
      const session=settings.getByLabel('Sesión que recibirá permiso',{exact:true}); await page.waitForFunction(()=>document.querySelector('.settings-permissions')?.getAttribute('aria-busy')==='false');
      assert.equal(await session.inputValue(),''); assert.equal(await session.locator('option').count(),3,'two active sessions plus placeholder');
      assert.equal(await settings.getByLabel('Alcance del permiso',{exact:true}).inputValue(),'plan');
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>/^(grant|revoke|revoke_policy)$/.test(c.op))),[]);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      const docsDir=process.env.PULSO_DOC_SCREENSHOT_DIR;
      if(docsDir && engine===chromium){
        await mkdir(docsDir,{recursive:true}); await page.setViewportSize({width:1440,height:1400});
        await page.evaluate(()=>document.documentElement.dataset.theme='light');
        await settings.locator('.settings-dialog-content').evaluate(n=>n.scrollTop=0);
        await page.waitForTimeout(300);
        await page.screenshot({path:`${docsDir}/configuracion-1.3.2.png`,animations:'disabled'});
        await settings.getByRole('button',{name:'Cerrar',exact:true}).click();
        await page.getByRole('button',{name:'Cerrar detalle',exact:true}).click();
        await page.setViewportSize({width:1440,height:1000});
        await page.locator('.pulso-board-toolbar').getByRole('button',{name:'Abrir sesión principal',exact:true}).waitFor();
        await page.screenshot({path:`${docsDir}/pulso-1.3.2.png`,animations:'disabled'});
      }
    } finally {await browser.close();}
  });
  await test(`${engine.name()}: held Pulso response is fenced after reconnect with the same runner generation`, async () => {
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{}); const page=await browser.newPage();
    try {
      await install(page); await page.goto(url); await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.locator('#open-settings').click();
      const settings=page.getByRole('dialog',{name:'Configuración',exact:true}); await settings.waitFor();
      // Manual access is a collapsed section since 1.3.3: expanding it starts the
      // permissions read. Hold only that page (limit 50) so a sidebar refresh of
      // 'projects' (limit 20) cannot take the hold instead.
      await page.evaluate(()=>{const f=(window as any).pulsoFixture;f.holdNext='projects';f.holdWhen={limit:50,cursor:0};});
      await settings.getByText('Acceso manual para sesiones existentes',{exact:true}).click();
      await page.waitForFunction(()=>(window as any).pulsoFixture.held.length===1);
      await page.evaluate(()=>{const f=(window as any).pulsoFixture;f.held[0].result.projects=[{id:'stale-project',title:'STALE SYNTHETIC RESPONSE'}];});
      // Exercise the shell's real reconnect handler while the modal read is held.
      await page.locator('#connect').evaluate(n=>(n as HTMLButtonElement).click());
      await page.waitForFunction(()=>(window as any).pulsoFixture.connections===2 && document.querySelector('#connection-state')?.textContent==='Conectado');
      await page.evaluate(()=>(window as any).pulsoFixture.held.splice(0).forEach((held:any)=>held.resolve()));
      await settings.getByText('No se pudieron consultar los permisos y proyectos. Reintenta la consulta.',{exact:true}).waitFor();
      assert.equal(await settings.getByLabel('Alcance del permiso',{exact:true}).locator('option[value="stale-project"]').count(),0);
      await settings.getByRole('button',{name:'Actualizar permisos y proyectos',exact:true}).click();
      await settings.getByLabel('Alcance del permiso',{exact:true}).locator('option[value="plan"]').waitFor({state:'attached'});
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>/^(grant|revoke|revoke_policy)$/.test(c.op))),[]);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
    } finally {await browser.close();}
  });
  for(const savedProject of ['plan','missing-synthetic-project']) await test(`${engine.name()}: restart restores ${savedProject} with zero provider commands`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{}); const page=await browser.newPage();
    try {
      await install(page,'',{savedProject}); await page.goto(url); await page.reload();
      await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled); await page.locator('#open-pulso').click();
      if(savedProject==='plan')await page.getByRole('button',{name:'Plan y sesiones',exact:true}).waitFor();
      else await page.getByRole('button',{name:'Abrir Preparar la revisión de mañana',exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.runnerCalls.filter((c:any)=>/resume_native|^(start|input)$/.test(c.op))),[]);
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>/^(grant|revoke|revoke_policy)$/.test(c.op))),[]);
    } finally {await browser.close();}
  });
  for(const theme of ['light','dark'])await test(`${engine.name()}: undo leaves waiting quick-add clickable at 760 in ${theme}`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(300);
      await page.locator('#session-list').getByRole('button',{name:/Plan sintético · Integración/}).click();await page.waitForTimeout(300);
      const prior=await page.evaluate(()=>(window as any).pulsoFixture.resizes.length);
      await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      await page.setViewportSize({width:760,height:640});await page.waitForTimeout(300);
      await page.getByRole('button',{name:'Mover Validar la fluidez de las terminales',exact:true}).click();await page.getByRole('menuitem',{name:'Mover a En espera',exact:true}).click();
      const undo=page.locator('.pulso-undo');await undo.getByRole('button',{name:'Deshacer cambio de estado',exact:true}).waitFor();
      const waiting=page.getByRole('region',{name:'En espera',exact:true});
      const add=waiting.getByRole('button',{name:'Añadir fase',exact:true});
      await add.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
      const bannerBox=await undo.boundingBox();const addBox=await add.boundingBox();assert.ok(bannerBox&&addBox);
      const disjoint=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y;
      assert.ok(disjoint(bannerBox,addBox),'undo must not overlap the waiting quick-add button');
      assert.equal(await add.evaluate(n=>{const r=n.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===n||!!hit&&n.contains(hit);}),true,'quick-add receives pointer input');
      await add.click();const input=waiting.getByLabel('Título de la fase',{exact:true});await input.fill('Nueva fase de revisión');
      assert.equal(await input.isVisible(),true);assert.equal(await input.evaluate(n=>n===document.activeElement),true);
      await page.waitForTimeout(300);
      const formBox=await waiting.locator('.pulso-add-form').boundingBox();const currentBanner=await undo.boundingBox();assert.ok(formBox&&currentBanner);
      assert.ok(disjoint(currentBanner,formBox),'undo must not overlap the open inline editor');
      assert.equal(await undo.isVisible(),true);assert.equal(await waiting.getByRole('button',{name:'Añadir tarjeta',exact:true}).isVisible(),true);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.resizes.length),prior,'undo and quick-add must not resize the hidden PTY');
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='item_update').length),1);
      const screenshotDir=process.env.PULSO_SCREENSHOT_DIR;if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-undo-add-${theme}-760.png`});}
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  await test(`${engine.name()}: passive OSC 7501 uses real xterm, ignores untrusted fields and history, and never changes the board`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page,'\x1b]7501;state=blocked\x07\x1b]7501;state=done\x07');await page.goto(url);
      await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      const session=page.locator('#session-list').getByRole('button',{name:/Plan sintético · Integración/});
      assert.doesNotMatch(await session.innerText(),/Trabajando|Solicita atención|Turno finalizado/,'replayed history stays quiet');
      await session.click();
      const before=await page.evaluate(()=>(window as any).pulsoFixture.phase());
      const emit=async(data:string)=>page.evaluate(data=>(window as any).pulsoFixture.output(data),data);
      await emit('\x1b]7501;sta');await page.waitForTimeout(350);
      assert.doesNotMatch(await session.innerText(),/Trabajando/,'incomplete OSC must not publish');
      await emit('te=working:msg=<img src=x onerror=alert(1)>:title=UNTRUSTED_PROGRAM_MESSAGE');await page.waitForTimeout(350);
      assert.doesNotMatch(await session.innerText(),/Trabajando/,'unfinished payload must not publish');
      await emit('\x1b\\');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item-state')).some(n=>n.textContent?.includes('Trabajando')));
      assert.doesNotMatch(await page.locator('body').innerText(),/UNTRUSTED_PROGRAM_MESSAGE|onerror=alert/);assert.equal(await page.locator('img[src="x"]').count(),0);
      await emit('\x1b]7501;state=blocked:id=child\x07\x1b]7501;state=?\x07\x1b]7501;state=done:state=blocked\x07\x1b]7501;state=done:msg='+ 'x'.repeat(1024)+'\x07');
      await page.waitForTimeout(650);assert.match(await session.innerText(),/Trabajando/);assert.doesNotMatch(await session.innerText(),/Solicita atención|Turno finalizado/);
      await emit('\x1b]7501;state=clear\x07');await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.session-item-state')).some(n=>/Trabajando|Solicita atención|Turno terminado/.test(n.textContent??'')));
      await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      await page.getByRole('region',{name:'En curso',exact:true}).getByRole('button',{name:'Abrir Validar la fluidez de las terminales',exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>(window as any).pulsoFixture.phase()),before);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='item_update').length),0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0,'status reports and queries never send PTY input');assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  await test(`${engine.name()}: working and idle program reports preserve the checkpoint disclosure without board reloads`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      await page.getByRole('button',{name:'Abrir Validar la fluidez de las terminales',exact:true}).click();
      await page.getByText('Guardar avance',{exact:true}).click();
      await page.getByLabel('Qué quedó listo ·').evaluate(n=>{(window as any).pulsoFixture.checkpointInput=n;});
      const reads=await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>['board','item','project'].includes(c.op)).length);
      for(const [state,label] of [['working','Trabajando'],['idle','Turno terminado']]){
        const polls=await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='revision').length);
        await page.evaluate(state=>(window as any).pulsoFixture.output(`\x1b]7501;state=${state}\x07`),state);
        await page.waitForFunction(label=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.textContent?.includes(label)),label);
        await page.waitForFunction(polls=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='revision').length>polls,polls);
        assert.equal(await page.getByLabel('Qué quedó listo ·').isVisible(),true,'program state must not collapse Guardar avance');
        assert.equal(await page.getByLabel('Qué quedó listo ·').evaluate(n=>n===(window as any).pulsoFixture.checkpointInput),true,'the checkpoint form is retained');
        assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>['board','item','project'].includes(c.op)).length),reads);
      }
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='item_update').length),0);assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  await test(`${engine.name()}: sidebar lists Pulso boards and groups agents by project or by state`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      // Proyectos: existing reads only; progress is Hecho/total and Pendientes counts unfinished cards.
      await page.waitForFunction(()=>document.querySelector('#sidebar-project-list button[data-board="plan"] .sidebar-row-meta')?.textContent==='1/4');
      assert.equal(await page.locator('#sidebar-project-list button[data-board="plan"]').getAttribute('aria-label'),'Abrir tablero Integrar Pulso en Jauria, 1 de 4 hechas');
      assert.equal(await page.locator('#sidebar-project-list button[data-board=""]').getAttribute('aria-label'),'Abrir tablero Pendientes, 1 sin terminar');
      assert.equal(await page.locator('#register-project, #new-task, #show-task, #handoff-toggle').count(),0,'Git repositories and tasks were retired');
      assert.deepEqual(await page.evaluate(()=>[...new Set((window as any).pulsoFixture.calls.map((c:any)=>c.op))].sort()),['items','links','projects']);
      // Por proyecto is the default: the main session sits under its project, the rest under Sin proyecto.
      const groupingButton=page.locator('#agent-grouping');
      await page.waitForFunction(()=>document.querySelector('#agent-grouping')?.getAttribute('data-grouping')==='project');
      assert.equal(await groupingButton.getAttribute('aria-pressed'),'false');assert.match(await groupingButton.getAttribute('title')??'',/Agrupados por proyecto/);
      await page.locator('.session-group[data-project="plan"] .session-item[data-session-id="main"]').waitFor();
      await page.locator('.session-group[data-project="none"] .session-item[data-session-id="related"]').waitFor();
      assert.deepEqual(await page.locator('#session-list .group-heading > span:first-child').allTextContents(),['Integrar Pulso en Jauria','Sin proyecto']);
      const related=page.locator('.session-item[data-session-id="related"]');const main=page.locator('.session-item[data-session-id="main"]');
      assert.equal(Math.round((await related.boundingBox())!.height),30,'one-line 30px agent rows');
      assert.equal(await related.locator('.agent-indicator').getAttribute('data-shape'),'ring','an open process without a declared state never spins');
      assert.equal(await related.locator('.session-item-state-label').textContent(),'Abierta');
      assert.equal(await related.locator('.provider-badge').getAttribute('data-provider'),'codex');
      await page.evaluate(()=>(window as any).pulsoFixture.output('\x1b]7501;state=working\x07'));
      await page.waitForFunction(()=>document.querySelector('.session-item[data-session-id="main"] .agent-indicator')?.getAttribute('data-shape')==='spinner');
      assert.equal(await main.locator('.agent-indicator').getAttribute('title'),'Trabajando');
      assert.equal(await main.locator('.session-item-state-label').textContent(),'Trabajando','state is available as text, not only colour');
      assert.equal(await main.locator('.session-item-duration').textContent(),'<1 min');
      // Each state has its own shape inside the same 12px box.
      const box=async()=>main.locator('.session-item-state').evaluate(n=>{const r=n.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];});
      const spinnerBox=await box();
      await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false}));
      await page.evaluate(()=>(window as any).pulsoFixture.output('\x1b]7501;state=idle\x07'));
      await page.waitForFunction(()=>document.querySelector('.session-item[data-session-id="main"] .agent-indicator')?.getAttribute('data-shape')==='check');
      assert.equal(await main.locator('.agent-indicator svg').count(),1,'finished draws a check mark');
      assert.deepEqual(await box(),spinnerBox,'the indicator box does not change with the state');
      if(process.env.PULSO_SCREENSHOT_DIR){const dir=process.env.PULSO_SCREENSHOT_DIR;await mkdir(dir,{recursive:true});for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await page.locator('#sidebar').screenshot({path:`${dir}/${engine.name()}-sidebar-finished-${theme}.png`,animations:'disabled'});}await page.evaluate(()=>document.documentElement.dataset.theme='light');}
      await page.evaluate(()=>(window as any).pulsoFixture.output('\x1b]7501;state=blocked\x07'));
      await page.waitForFunction(()=>document.querySelector('.session-item[data-session-id="main"] .agent-indicator')?.getAttribute('data-shape')==='halo');
      assert.equal(await main.locator('.agent-indicator svg').count(),0);
      await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true}));
      await page.evaluate(()=>(window as any).pulsoFixture.output('\x1b]7501;state=working\x07'));
      await page.waitForFunction(()=>document.querySelector('.session-item[data-session-id="main"] .agent-indicator')?.getAttribute('data-shape')==='spinner');
      // Compact header: the search field opens from its button or ⌘K and closes with Escape.
      assert.equal(await page.locator('#session-search').isVisible(),false);
      await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());await page.keyboard.press('Meta+k');
      await page.waitForFunction(()=>document.activeElement?.id==='session-search');
      assert.equal(await page.locator('#toggle-search').getAttribute('aria-expanded'),'true');
      await page.keyboard.type('Validación');await page.waitForFunction(()=>document.querySelectorAll('#session-list .session-item').length===1);
      await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('#session-list .session-item').length===2);
      assert.equal(await page.locator('#session-search').isVisible(),false);
      await page.locator('#toggle-search').click();await page.waitForFunction(()=>document.activeElement?.id==='session-search');await page.locator('#toggle-search').click();await page.waitForFunction(()=>(document.querySelector('#session-search-field') as HTMLElement).hidden);assert.equal(await page.locator('#toggle-search').getAttribute('aria-expanded'),'false','the search button also closes an empty field');
      assert.equal(await page.locator('#new-session').getAttribute('aria-label'),'Nueva sesión');
      const shots=process.env.PULSO_SCREENSHOT_DIR;
      if(shots){await mkdir(shots,{recursive:true});for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await page.screenshot({path:`${shots}/${engine.name()}-sidebar-project-${theme}.png`,animations:'disabled'});}await page.evaluate(()=>document.documentElement.dataset.theme='light');}
      // Por estado keeps Abiertas, reuses the activity sections and is remembered per profile.
      await groupingButton.click();
      assert.equal(await groupingButton.getAttribute('aria-pressed'),'true');assert.match(await groupingButton.getAttribute('title')??'',/Agrupados por estado/);
      await page.locator('.session-group[data-activity="working"] .session-item[data-session-id="main"]').waitFor();
      assert.equal(await page.locator('[data-filter="open"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>localStorage.getItem('jauria:agent-grouping:/synthetic')),JSON.stringify({schemaVersion:1,grouping:'state'}));
      if(shots){for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await page.screenshot({path:`${shots}/${engine.name()}-sidebar-state-${theme}.png`,animations:'disabled'});}await page.evaluate(()=>document.documentElement.dataset.theme='light');}
      await page.reload();await page.waitForFunction(()=>document.querySelector('#agent-grouping')?.getAttribute('aria-pressed')==='true'&&!!document.querySelector('.session-group[data-activity] .session-item'));
      assert.equal(await page.locator('.session-group[data-project]').count(),0);
      // A project row opens that board; Pendientes opens the standalone board.
      await page.waitForFunction(()=>!(document.querySelector('#sidebar-project-list button[data-board="plan"]')as HTMLButtonElement|null)?.disabled);
      // Keyboard activation keeps focus on the row although the list is rebuilt.
      await page.locator('#sidebar-project-list button[data-board="plan"]').focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('.pulso-board')?.getAttribute('data-project-id')==='plan'&&document.querySelector('#sidebar-project-list button[data-board="plan"]')?.getAttribute('aria-current')==='true');
      assert.equal(await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.dataset.board),'plan','focus stays on the activated project row');
      assert.equal(await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).getAttribute('aria-current'),'true');
      if(shots){for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await page.screenshot({path:`${shots}/${engine.name()}-sidebar-pulso-${theme}.png`,animations:'disabled'});}await page.evaluate(()=>document.documentElement.dataset.theme='light');}
      await page.locator('#sidebar-project-list button[data-board=""]').click();
      await page.waitForFunction(()=>document.querySelector('.pulso-board')?.getAttribute('data-project-id')===''&&document.querySelector('#sidebar-project-list button[data-board=""]')?.getAttribute('aria-current')==='true');
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  await test(`${engine.name()}: a reported blocker stays visible and reappears after new work`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false}));
      const session=page.locator('.session-item').filter({hasText:'Plan sintético · Integración'});
      const emit=async(state:string)=>page.evaluate(state=>(window as any).pulsoFixture.output(`\x1b]7501;state=${state}\x07`),state);
      await emit('blocked');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.getAttribute('data-attention')==='true'));
      assert.equal(await session.getAttribute('data-unseen'),'true');
      await emit('working');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.getAttribute('data-attention')==='false'));
      await emit('blocked');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.textContent?.includes('Solicita atención')&&n.getAttribute('data-attention')==='true'));
      assert.equal(await session.getAttribute('data-unseen'),'true');
      await page.locator('#agent-grouping').click();
      assert.equal(await page.locator('[data-filter="open"]').getAttribute('aria-pressed'),'true','Por estado stays inside Abiertas');
      await page.locator('.session-group[data-activity="needs"]').waitFor();
      // The priority alert reaches the pane heading, the status bar and the bell's list (no message rail since 1.4).
      assert.equal(await page.locator('.pane').first().locator('.session-state').textContent(),'Solicita atención');
      assert.equal(await page.locator('#status-needs-text').textContent(),'1 te necesita');
      await page.locator('#session-alerts').click();
      assert.match(await page.locator('#attention-list .alerts-row').first().textContent() ?? '', /Plan sintético · Integración.*Solicita atención/);
      await page.keyboard.press('Escape');
      const screenshotDir=process.env.PULSO_SCREENSHOT_DIR;
      if(screenshotDir){
        await mkdir(screenshotDir,{recursive:true});
        await page.evaluate(()=>(window as any).pulsoFixture.output('$ jauria-demo revisar-avisos\r\n[ok] Estados declarados por el agente\r\n[ok] Sesiones agrupadas por prioridad\r\n[pendiente] Confirmar permiso para continuar\r\n'));
        await page.waitForTimeout(650);
        await page.screenshot({path:`${screenshotDir}/${engine.name()}-activity-alert-light.png`,animations:'disabled'});
        await page.evaluate(()=>document.documentElement.dataset.theme='dark');
        await page.screenshot({path:`${screenshotDir}/${engine.name()}-activity-alert-dark.png`,animations:'disabled'});
        await page.evaluate(()=>document.documentElement.dataset.theme='light');
      }
      await emit('working');await page.locator('.session-group[data-activity="working"]').waitFor();
      assert.equal(await session.getAttribute('data-attention'),'false');
      if(screenshotDir){
        await page.evaluate(()=>(window as any).pulsoFixture.output('[ok] Permiso confirmado\r\n[en curso] Validando la vista de actividad...\r\n'));
        await page.waitForTimeout(650);
        await page.screenshot({path:`${screenshotDir}/${engine.name()}-activity-working-light.png`,animations:'disabled'});
      }
      await emit('idle');await page.locator('.session-group[data-activity="finished"]').waitFor();
      assert.match(await session.textContent() ?? '', /Turno terminado/);
      await session.click();
      assert.match(await session.textContent() ?? '', /En espera/);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='item_update').length),0);assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
 }
}finally{await server.close();}

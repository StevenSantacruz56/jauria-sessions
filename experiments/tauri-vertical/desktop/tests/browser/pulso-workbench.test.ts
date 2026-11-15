/** Real shell/xterm; synthetic native boundary. No providers or user profiles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,hmr:false}});await server.listen();
const url=server.resolvedUrls!.local[0];
async function install(page:Page, history = ''){await page.addInitScript((history)=>{
 const w=window as any;const sessions=[{id:'main',title:'Plan sintético · Integración',kind:'claude',cwd:'/synthetic/project',status:'running',rows:24,cols:80},{id:'related',title:'Fase sintética · Validación',kind:'codex',cwd:'/synthetic/other',status:'running',rows:24,cols:80}];
 const events:any[]=history?[{seq:1,sessionId:'main',kind:'output',data:btoa(history)}]:[],resizes:any[]=[],inputs:any[]=[],calls:any[]=[];let rev=3;
 const projects:any[]=[{id:'plan',title:'Integrar Pulso en Jauria',plan:'Plan de demostración sintético.\n1. Definir el modelo\n2. Implementar\n3. Validar la fluidez',mainSessionId:'main',revision:1,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 const items:any[]=[{id:'phase',projectId:'plan',title:'Validar la fluidez de las terminales',note:'Contenido sintético para comprobar navegación.',status:'doing',position:0,revision:2,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'},{id:'todo',projectId:null,title:'Preparar la revisión de mañana',note:'',status:'todo',position:0,revision:3,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 // Keep every board column populated for visual review; the phase under test stays first.
 for(const [id,title,status] of [['scope','Definir el alcance de la entrega','todo'],['implementation','Integrar el tablero con el shell','doing'],['model','Modelo y checkpoints verificados','done']])items.push({...items[0],id,title,status,note:'Datos de prueba sintéticos.',revision:1});
 const status=()=>({pid:123,generation:'pulso-synthetic',pulsoVersion:1,pulsoBoardVersion:1,pulsoAvailable:true,nativeResumeVersion:1,workspaceVersion:1,projectLifecycleVersion:1,projects:[],tasks:[],normalTerminalVersion:1,sessions:structuredClone(sessions),lastSeq:events.length});
 w.pulsoFixture={calls,resizes,inputs,output(data:string){events.push({seq:events.length+1,sessionId:'main',kind:'output',data:btoa(data)});},phase:()=>structuredClone(items[0])};
 w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},async invoke(cmd:string,a:any){
  if(cmd==='connect_runner')return{dataDir:'/synthetic',socket:'/synthetic/sock',status:status(),smoke:true};
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
   else if(a.op==='item_update'){const item=items.find(i=>i.id===x.id);if(item.revision!==x.expectedRevision)return{ok:false,error:'revision conflict'};Object.assign(item,Object.fromEntries(Object.entries(x).filter(([k])=>!['requestId','expectedRevision'].includes(k))),{revision:++rev});result={item:structuredClone(item)};}
   else return{ok:false,error:'Unexpected synthetic operation'};
   return{ok:true,result};
  }
  if(cmd==='runner_request'){
   if(a.op==='status')return{ok:true,result:status()};if(a.op==='telemetry')return{ok:true,result:{}};
   if(a.op==='events')return{ok:true,result:{events:events.filter(e=>e.seq>a.args.after),lastSeq:events.length,hasMore:false}};
   if(a.op==='resize'){resizes.push(a.args);const s=sessions.find(s=>s.id===a.args.id)!;s.rows=a.args.rows;s.cols=a.args.cols;return{ok:true,result:{rows:s.rows,cols:s.cols}};}
   if(a.op==='input'){inputs.push(a.args);return{ok:true,result:{written:a.args.data.length}};}
   if(a.op==='native_binding')return{ok:true,result:{binding:null}};
  }
  throw Error(`Unexpected fixture command ${cmd}:${a?.op??''}`);
 },transformCallback(){return 1;},unregisterCallback(){}};
}, history);}
if(process.env.PULSO_PANEL_BROWSER!=='1')test('workbench browser coverage requires PULSO_PANEL_BROWSER=1',{skip:true},()=>{});
try{
 for(const engine of(process.env.PULSO_PANEL_BROWSER==='1'?(process.env.PULSO_PANEL_WEBKIT==='1'?[chromium,webkit]:[chromium]):[])){await test(`${engine.name()}: Pulso preserves the live terminal and isolates polling`,async()=>{
  const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await install(page);await page.goto(url);await page.locator('#open-pulso').waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
   await page.getByRole('button',{name:/Plan sintético · Integración/}).click();
   await page.locator('#toggle-split').click();await page.waitForTimeout(300);await page.evaluate(()=>{const f=(window as any).pulsoFixture;f.original=document.querySelector('.xterm');f.output(Array.from({length:120},(_,i)=>`Synthetic line ${i}`).join('\r\n')+'\r\n');});
   await page.waitForTimeout(500);await page.evaluate(()=>{const viewport=document.querySelector('.xterm-viewport')as HTMLElement;viewport.scrollTop=200;(window as any).pulsoFixture.scroll=viewport.scrollTop;});
   const prior=await page.evaluate(()=>(window as any).pulsoFixture.resizes.length);
   await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
   assert.equal(await page.locator('dialog[open]').count(),0,'project tab opens only the board');
   await page.getByLabel('Mover Validar la fluidez de las terminales',{exact:true}).selectOption('waiting');
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
  for(const theme of ['light','dark'])await test(`${engine.name()}: undo leaves waiting quick-add clickable at 760 in ${theme}`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(300);
      await page.getByRole('button',{name:/Plan sintético · Integración/}).click();await page.waitForTimeout(300);
      const prior=await page.evaluate(()=>(window as any).pulsoFixture.resizes.length);
      await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
      await page.setViewportSize({width:760,height:640});await page.waitForTimeout(300);
      await page.getByLabel('Mover Validar la fluidez de las terminales',{exact:true}).selectOption('waiting');
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
      const session=page.getByRole('button',{name:/Plan sintético · Integración/});
      assert.doesNotMatch(await session.innerText(),/Trabajando|Solicita atención|Turno finalizado/,'replayed history stays quiet');
      await session.click();
      const before=await page.evaluate(()=>(window as any).pulsoFixture.phase());
      const emit=async(data:string)=>page.evaluate(data=>(window as any).pulsoFixture.output(data),data);
      await emit('\x1b]7501;sta');await page.waitForTimeout(350);
      assert.doesNotMatch(await session.innerText(),/Trabajando/,'incomplete OSC must not publish');
      await emit('te=working:msg=<img src=x onerror=alert(1)>:title=UNTRUSTED_PROGRAM_MESSAGE');await page.waitForTimeout(350);
      assert.doesNotMatch(await session.innerText(),/Trabajando/,'unfinished payload must not publish');
      await emit('\x1b\\');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item-meta')).some(n=>n.textContent?.includes('Trabajando')));
      assert.doesNotMatch(await page.locator('body').innerText(),/UNTRUSTED_PROGRAM_MESSAGE|onerror=alert/);assert.equal(await page.locator('img[src="x"]').count(),0);
      await emit('\x1b]7501;state=blocked:id=child\x07\x1b]7501;state=?\x07\x1b]7501;state=done:state=blocked\x07\x1b]7501;state=done:msg='+ 'x'.repeat(1024)+'\x07');
      await page.waitForTimeout(650);assert.match(await session.innerText(),/Trabajando/);assert.doesNotMatch(await session.innerText(),/Solicita atención|Turno finalizado/);
      await emit('\x1b]7501;state=clear\x07');await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.session-item-meta')).some(n=>/Trabajando|Solicita atención|Turno finalizado/.test(n.textContent??'')));
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
      for(const [state,label] of [['working','Trabajando'],['idle','En espera']]){
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
  await test(`${engine.name()}: a suppressed unattended blocked alert is delivered after the five-second cooldown`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try{
      await install(page);await page.goto(url);await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
      await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false}));
      const session=page.locator('.session-item').filter({hasText:'Plan sintético · Integración'});
      const emit=async(state:string)=>page.evaluate(state=>(window as any).pulsoFixture.output(`\x1b]7501;state=${state}\x07`),state);
      await emit('blocked');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.getAttribute('data-attention')==='true'));
      const firstAlert=Date.now();assert.equal(await session.getAttribute('data-unseen'),'true');
      await emit('working');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.getAttribute('data-attention')==='false'));
      await emit('blocked');await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.textContent?.includes('Solicita atención')));
      assert.equal(await session.getAttribute('data-attention'),'false','second blocked report is initially rate limited');
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-item')).some(n=>n.textContent?.includes('Plan sintético · Integración')&&n.getAttribute('data-attention')==='true'),undefined,{timeout:6500});
      assert.ok(Date.now()-firstAlert>=4500,'the deferred alert must respect the real five-second cooldown');
      assert.equal(await session.getAttribute('data-unseen'),'true');
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0);
      assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.filter((c:any)=>c.op==='item_update').length),0);assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
 }
}finally{await server.close();}

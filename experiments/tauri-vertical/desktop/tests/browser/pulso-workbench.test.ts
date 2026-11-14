/** Real shell/xterm; synthetic native boundary. No providers or user profiles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,hmr:false}});await server.listen();
const url=server.resolvedUrls!.local[0];
async function install(page:Page){await page.addInitScript(()=>{
 const w=window as any;const sessions=[{id:'main',title:'Plan sintético · Integración',kind:'claude',cwd:'/synthetic/project',status:'running',rows:24,cols:80},{id:'related',title:'Fase sintética · Validación',kind:'codex',cwd:'/synthetic/other',status:'running',rows:24,cols:80}];
 const events:any[]=[],resizes:any[]=[],inputs:any[]=[],calls:any[]=[];let rev=3;
 const projects:any[]=[{id:'plan',title:'Integrar Pulso en Jauria',plan:'Plan de demostración sintético.\n1. Definir el modelo\n2. Implementar\n3. Validar la fluidez',mainSessionId:'main',revision:1,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 const items:any[]=[{id:'phase',projectId:'plan',title:'Validar la fluidez de las terminales',note:'Contenido sintético para comprobar navegación.',status:'doing',position:0,revision:2,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'},{id:'todo',projectId:null,title:'Preparar la revisión de mañana',note:'',status:'todo',position:0,revision:3,archived:false,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z'}];
 const status=()=>({pid:123,generation:'pulso-synthetic',pulsoVersion:1,pulsoAvailable:true,nativeResumeVersion:1,workspaceVersion:1,projectLifecycleVersion:1,projects:[],tasks:[],normalTerminalVersion:1,sessions:structuredClone(sessions),lastSeq:events.length});
 w.pulsoFixture={calls,resizes,inputs,output(data:string){events.push({seq:events.length+1,sessionId:'main',kind:'output',data:btoa(data)});},phase:()=>structuredClone(items[0])};
 w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},async invoke(cmd:string,a:any){
  if(cmd==='connect_runner')return{dataDir:'/synthetic',socket:'/synthetic/sock',status:status(),smoke:true};
  if(cmd==='probe_tools')return[];if(cmd==='record_ui_evidence')return;if(cmd==='plugin:window|set_badge_count')return;
  if(cmd==='pulso_request'){
   calls.push({op:a.op,args:structuredClone(a.args)});const x=a.args;let result:any;
   if(a.op==='revision')result={revision:rev};
   else if(a.op==='projects')result={projects:structuredClone(projects),revision:rev,hasMore:false};
   else if(a.op==='project')result={project:structuredClone(projects.find(p=>p.id===x.id))};
   else if(a.op==='items')result={items:structuredClone(items.filter(i=>(i.projectId??null)===(x.projectId??null))),revision:rev,hasMore:false};
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
});}
try{
 for(const engine of[chromium,webkit])await test(`${engine.name()}: Pulso preserves the live terminal and isolates polling`,async()=>{
  const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1280,height:820}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await install(page);await page.goto(url);await page.locator('#open-pulso').waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('#open-pulso')as HTMLButtonElement).disabled);
   await page.getByRole('button',{name:/Plan sintético · Integración/}).click();
   await page.locator('#toggle-split').click();await page.waitForTimeout(300);await page.evaluate(()=>{const f=(window as any).pulsoFixture;f.original=document.querySelector('.xterm');f.output(Array.from({length:120},(_,i)=>`Synthetic line ${i}`).join('\r\n')+'\r\n');});
   await page.waitForTimeout(500);await page.evaluate(()=>{const viewport=document.querySelector('.xterm-viewport')as HTMLElement;viewport.scrollTop=200;(window as any).pulsoFixture.scroll=viewport.scrollTop;});
   const prior=await page.evaluate(()=>(window as any).pulsoFixture.resizes.length);
   await page.locator('#open-pulso').click();await page.getByRole('button',{name:'Integrar Pulso en Jauria',exact:true}).click();
   await page.getByRole('button',{name:/Validar la fluidez/}).click();await page.getByText('Punto de continuidad',{exact:false}).first().waitFor({state:'visible',timeout:3000}).catch(()=>{});
   await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.resizes.length),prior,'opening planning must not resize PTY');
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.inputs.length),0,'planning must not send provider input');
   const screenshotDir=process.env.PULSO_SCREENSHOT_DIR;if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-light.png`});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(200);await page.screenshot({path:`${screenshotDir}/${engine.name()}-pulso-dark.png`});}
   await page.getByRole('button',{name:/Enfocar sesión viva/}).first().click();await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.original===document.querySelector('.xterm')),true,'same xterm instance retained');
   assert.equal(await page.evaluate(()=>(document.querySelector('.xterm-viewport') as HTMLElement).scrollTop), await page.evaluate(()=>(window as any).pulsoFixture.scroll), 'reading position retained across planning navigation');
   assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.resizes.some((r:any)=>r.cols<2||r.rows<2)),false);
   const calls=await page.evaluate(()=>(window as any).pulsoFixture.calls.length);await page.waitForTimeout(2200);assert.equal(await page.evaluate(()=>(window as any).pulsoFixture.calls.length),calls,'no planning polls while hidden');
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
}finally{await server.close();}

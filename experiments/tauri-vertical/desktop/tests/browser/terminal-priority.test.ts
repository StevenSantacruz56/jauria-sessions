/** Real main.ts and xterm with a synthetic native boundary. No user sessions. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile:false, server:{ host:'127.0.0.1', port:0, hmr:false } });
await server.listen();
const url = server.resolvedUrls!.local[0];

async function install(page:Page) {
  await page.addInitScript(() => {
    const w=window as any;
    const generation='priority-fixture';
    const sessions=[
      {id:'foreground',title:'Foreground',kind:'fixture',transport:'pty',status:'running',cwd:'/synthetic/foreground',rows:24,cols:80},
      {id:'background',title:'Background',kind:'fixture',transport:'pty',status:'running',cwd:'/synthetic/background',rows:24,cols:80},
    ];
    const frames=new Map(sessions.map(s=>[s.id,[{index:1,kind:'resize',data:{rows:24,cols:80}}] as any[]]));
    const inputs:any[]=[];
    let hold=false,waiting=false,release:(()=>void)|undefined,connectCount=0;
    const history=(id:string)=>({state:'recording',durableFrame:frames.get(id)!.length,lastFrame:frames.get(id)!.length});
    const row=(s:any)=>({...s,terminalStream:{generation,history:history(s.id)}});
    const status=()=>({pid:123,generation,terminalStreamVersion:1,normalTerminalVersion:1,sessions:sessions.map(row),lastSeq:0});
    w.priorityFixture={inputs,get waiting(){return waiting;},get connectCount(){return connectCount;},hold(){hold=true;},finishBackground(){sessions[1].status='exited';},release(){release?.();release=undefined;waiting=false;}};
    w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},async invoke(command:string,request:any){
      if(command==='connect_runner'){connectCount++;return{dataDir:'/synthetic',socket:'/synthetic',status:status(),smoke:false};}
      if(command==='probe_tools')return[];
      if(command==='plugin:window|set_badge_count'||command==='plugin:event|listen'||command==='plugin:event|unlisten')return;
      if(command==='runner_request'){
        const {op,args}=request;
        if(op==='status')return{ok:true,result:status()};
        if(op==='events')return{ok:true,result:{events:[],lastSeq:0,hasMore:false}};
        if(op==='telemetry')return{ok:true,result:{}};
        if(op==='resize')return{ok:true,result:{rows:args.rows,cols:args.cols}};
        if(op==='input'){
          inputs.push(structuredClone(args));
          const stream=frames.get(args.id)!;
          stream.push({index:stream.length+1,kind:'output',data:btoa(args.data)});
          return{ok:true,result:{written:args.data.length}};
        }
        if(op==='terminal_live'){
          const stream=frames.get(args.id)!;
          const s=sessions.find(session=>session.id===args.id)!;
          const snapshotSession=row(s);
          if(args.id==='background'&&args.after>=1&&hold){
            hold=false;waiting=true;
            await new Promise<void>(resolve=>{release=resolve;});
          }
          const result={generation,frames:structuredClone(stream.filter(frame=>frame.index>args.after).slice(0,args.limit)),gap:null,
            firstFrame:1,lastFrame:stream.length,durableFrame:stream.length,hasMore:false,session:snapshotSession,history:history(args.id)};
          return{ok:true,result};
        }
      }
      throw Error(`Unexpected synthetic request ${command}:${request?.op??''}`);
    },transformCallback(){return 1;},unregisterCallback(){}};
  });
}

// Session picker in the pane heading (replaces the native select since 1.4).
async function choose(page:Page,pane:number,id:string){
  await page.locator(`#session-${pane}`).click();
  await page.locator(`.pane:nth-child(${pane+1}) .session-picker [role="option"][data-session-id="${id}"]`).click();
}
try {
  for(const engine of [chromium,webkit])await test(`${engine.name()}: slow background terminal cannot hold focused echo`,async()=>{
    const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
    const page=await browser.newPage({viewport:{width:1220,height:800}});
    try {
      await install(page);await page.goto(url);
      await page.waitForFunction(()=>document.querySelector('#connection-state')?.textContent==='Conectado');
      await page.waitForFunction(()=>!(document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.disabled);
      await page.evaluate(()=>(window as any).priorityFixture.hold());
      await page.waitForFunction(()=>(window as any).priorityFixture.waiting);
      const initialScreen=await page.locator('.xterm-rows').textContent();
      assert.equal(initialScreen?.includes('a'),false,`foreground begins without echoed input: ${JSON.stringify(initialScreen)}`);
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('a');
      await page.waitForFunction(()=>(window as any).priorityFixture.inputs.some((input:any)=>input.id==='foreground'&&input.data==='a'));
      await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('a'),undefined,{timeout:250});
      assert.equal(await page.evaluate(()=>(window as any).priorityFixture.waiting),true,'background response remains held while foreground echo paints');
      // A previously background session must become responsive immediately on selection.
      await choose(page,0,'background');
      assert.equal(await page.locator('.xterm-rows').textContent()?.then(text=>text?.includes('b')),false);
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('b');
      await page.waitForFunction(()=>(window as any).priorityFixture.inputs.some((input:any)=>input.id==='background'&&input.data==='b'));
      await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('b'),undefined,{timeout:250});
      assert.equal(await page.evaluate(()=>(window as any).priorityFixture.waiting),true,'old background request is still held');
      await page.evaluate(()=>(window as any).priorityFixture.finishBackground());
      await page.waitForFunction(()=>document.querySelector('.pane-heading .session-state')?.textContent==='Cerrada');
      await page.evaluate(()=>(window as any).priorityFixture.release());
      await page.waitForTimeout(200);
      assert.equal((await page.locator('.xterm-rows').textContent())?.split('b').length,2,'stale response cannot duplicate output');
      assert.equal(await page.locator('.pane-heading .session-state').first().textContent(),'Cerrada','late snapshot cannot reopen a closed session');
      await choose(page,0,'foreground');
      await page.evaluate(()=>(window as any).priorityFixture.hold());
      await page.waitForFunction(()=>(window as any).priorityFixture.waiting);
      await page.locator('#connect').click();
      await page.waitForFunction(()=>(window as any).priorityFixture.connectCount===2 && document.querySelector('#connection-state')?.textContent==='Conectado');
      await page.evaluate(()=>(window as any).priorityFixture.release());
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('c');
      await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('c'),undefined,{timeout:250});
    } finally {
      await page.evaluate(()=>(window as any).priorityFixture?.release()).catch(()=>{});
      await browser.close();
    }
  });
} finally {await server.close();}

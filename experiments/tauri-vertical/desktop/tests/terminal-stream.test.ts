import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalStreamCursor, HistoryQuotaWarnings, historyUsage, deferTerminalGap, terminalFramesPayload, terminalGapNotice, validateFrames, historyLabel, historyReasonLabel, type TerminalFrame } from '../src/terminal-stream.ts';
const resize = (index = 1): TerminalFrame => ({index,kind:'resize',data:{rows:24,cols:80}});
const output = (index: number): TerminalFrame => ({index,kind:'output',data:btoa('\x1b[6n')});
test('history reasons use plain Spanish and never echo unknown backend codes',()=>{
  for (const [reason,label] of [
    ['quota','Cuota alcanzada'],
    ['session_quota','Cuota alcanzada'],
    ['io','Almacenamiento no disponible'],
    ['queue_overflow','El guardado no siguió el ritmo de la salida'],
    ['explicit_purge','Historial eliminado'],
    ['reader_error','Salida incompleta'],
  ]) assert.equal(historyReasonLabel(reason),label);
  for (const reason of [undefined,'','unknown_tail','unexpected_internal_code','<backend detail>']) {
    assert.equal(historyReasonLabel(reason),'No se pudo conservar toda la salida');
  }
});
function sink() {
  const applied: TerminalFrame[] = [], resets: string[] = [];
  return {applied,resets,frame:async (f: TerminalFrame)=>{applied.push(f);},gap:async (s: string)=>{resets.push(s);}};
}
test('tagged envelopes are opt-in; app-server provider methods remain untouched',()=>{
  assert.equal(terminalFramesPayload('{"method":"thread/started","params":{}}'),null);
  const params={generation:'old',frames:[resize(),output(2)]};
  assert.deepEqual(terminalFramesPayload(JSON.stringify({method:'jauria/terminalFrames',params})),params);
  assert.throws(()=>terminalFramesPayload('{"method":"jauria/terminalFrames"}'));
  assert.equal(terminalFramesPayload(JSON.stringify({method:'jauria/terminalFrames',params}), 'app-server'),null);
  assert.equal(terminalFramesPayload('{"method":"jauria/terminalFrames"}', 'app-server'),null,'do not even validate structured provider params');
  assert.deepEqual(terminalFramesPayload(JSON.stringify({method:'jauria/terminalFrames',params}), 'pty'),params);
});
test('monotonic indexes, frame 1 geometry and malformed payloads fail before side effects',async()=>{
  for(const frames of [[resize(),output(1)],[resize(2),output(1)],[output(1)],[resize(0)],
    [resize(Number.MAX_SAFE_INTEGER+1)], [{index:1,kind:'resize',data:{rows:0,cols:80}}],
    [resize(),{index:2,kind:'output',data:'%%%='}],[resize(),{index:2,kind:'state',data:{}}],
    [{index:1,kind:'unknown',data:{}}]]) {
    const cursor=new TerminalStreamCursor('g'), consumer=sink();
    await assert.rejects(cursor.consume('g',frames as TerminalFrame[],consumer));
    assert.equal(cursor.lastFrame,0);assert.equal(consumer.applied.length,0);
  }
  assert.throws(()=>validateFrames('',[]));
});
test('terminal resize frames accept 1..1000 rows and columns',async()=>{
  const frames:TerminalFrame[]=[{index:1,kind:'resize',data:{rows:1,cols:1}},{index:2,kind:'resize',data:{rows:1000,cols:1000}}];
  validateFrames('g',frames);
  const cursor=new TerminalStreamCursor('g'),consumer=sink();await cursor.consume('g',frames,consumer);
  assert.deepEqual(consumer.applied,frames);
  for(const data of [{rows:1001,cols:1},{rows:1,cols:1001},{rows:0,cols:1},{rows:1,cols:-1}]) {
    assert.throws(()=>validateFrames('g',[{index:1,kind:'resize',data}]));
  }
});
test('durable backfill and pending writer completion preserve every byte without resetting',async()=>{
  for(const state of ['recording','complete','limited'] as const){
    const cursor=new TerminalStreamCursor('g'),consumer=sink();await cursor.consume('g',[resize()],consumer);
    const gap={firstFrame:2,lastFrame:3};
    const history={state,durableFrame:state==='recording'?1:3,lastFrame:4};
    assert.equal(deferTerminalGap(cursor.lastFrame,gap,history.durableFrame,history,true),true);
    assert.equal(cursor.lastFrame,1,'defer cannot skip missing frames');
    const finished={...history,state:'complete' as const,durableFrame:3};
    assert.equal(deferTerminalGap(cursor.lastFrame,gap,3,finished,true),true,'writer finished but archive has not arrived yet');
    const frames:TerminalFrame[]=[{index:2,kind:'output',data:btoa('A')},{index:3,kind:'output',data:btoa('B')},{index:4,kind:'output',data:btoa('C')}];
    await cursor.consume('g',frames.slice(0,2),consumer);
    assert.equal(deferTerminalGap(cursor.lastFrame,gap,3,finished,true),false);
    await cursor.consume('g',frames.slice(2),consumer,gap);
    await cursor.consume('g',[resize(),...frames],consumer);
    assert.equal(consumer.applied.filter(f=>f.kind==='output').map(f=>atob(f.data as string)).join(''),'ABC');
    assert.equal(consumer.resets.length,0);assert.equal(cursor.desynchronized,false);
  }
});
test('unavailable archive or an undurable limited/error gap requires explicit desynchronization',async()=>{
  const gap={firstFrame:2,lastFrame:3};
  for(const state of ['limited','error','incomplete'] as const){
    const history={state,durableFrame:1,lastFrame:4};
    assert.equal(deferTerminalGap(1,gap,1,history,true),false);
    assert.equal(deferTerminalGap(1,gap,3,history,true),true,'durable prefix remains recoverable even if later recording failed');
    const cursor=new TerminalStreamCursor('g'),consumer=sink();await cursor.consume('g',[resize()],consumer);
    await cursor.consume('g',[output(4)],consumer,gap);
    assert.equal(consumer.resets.length,1);assert.equal(cursor.desynchronized,true);
  }
  assert.equal(deferTerminalGap(1,gap,3,{state:'recording',durableFrame:3,lastFrame:4},false),false);
  assert.equal(deferTerminalGap(3,null,3,{state:'recording',durableFrame:3,lastFrame:4},true),false);
});
test('archive/live duplicates and concurrent late archives never roll back or reapply resize',async()=>{
  const cursor=new TerminalStreamCursor('g'),consumer=sink();
  await cursor.consume('g',[resize(),output(2)],consumer);
  await cursor.consume('g',[output(2),resize(3),output(4)],consumer);
  await cursor.consume('g',[resize(),output(2),resize(3)],consumer);
  assert.deepEqual(consumer.applied.map(f=>f.index),[1,2,3,4]);
  assert.equal(cursor.lastFrame,4);assert.equal(cursor.desynchronized,false);
});
test('different generation cannot reuse a native cursor; older sessions have independent cursors',async()=>{
  const cursor=new TerminalStreamCursor('old'),consumer=sink();
  await cursor.consume('old',[resize()],consumer);
  await assert.rejects(cursor.consume('new',[resize()],consumer),/generation/);
  assert.equal(cursor.lastFrame,1);assert.equal(consumer.resets.length,0);
  const current=new TerminalStreamCursor('new');await current.consume('new',[resize()],sink());
  assert.equal(current.lastFrame,1);
});
test('explicit gap requests ANSI reset and persistent indication; late archive is deduplicated',async()=>{
  const cursor=new TerminalStreamCursor('g'),consumer=sink();
  await cursor.consume('g',[resize()],consumer);
  await cursor.consume('g',[output(5)],consumer,{firstFrame:2,lastFrame:4});
  assert.deepEqual(consumer.resets,[terminalGapNotice]);assert.equal(cursor.desynchronized,true);
  await cursor.consume('g',[output(2),resize(3),output(4),output(5)],consumer);
  assert.deepEqual(consumer.applied.map(f=>f.index),[1,5]);assert.equal(cursor.lastFrame,5);
});
test('implicit hole resets too; empty live ring acknowledges gap without rollback',async()=>{
  const cursor=new TerminalStreamCursor('g'),consumer=sink();
  await cursor.consume('g',[resize(4)],consumer);
  await cursor.consume('g',[],consumer,{firstFrame:5,lastFrame:9});
  await cursor.consume('g',[],consumer,{firstFrame:1,lastFrame:3});
  assert.equal(cursor.lastFrame,9);assert.equal(consumer.resets.length,2);
  await assert.rejects(cursor.consume('g',[],consumer,{firstFrame:11,lastFrame:10}));
});
test('cursor and resize/state barriers wait for parser callback; failed writes are not acknowledged',async()=>{
  const cursor=new TerminalStreamCursor('g');let acknowledge!:()=>void;const order:string[]=[];
  const pending=cursor.consume('g',[resize(),output(2),resize(3),{index:4,kind:'state',data:{status:'exited'}}],{
    gap:async()=>{throw new Error('unexpected gap');},frame:async f=>{
      order.push(`begin:${f.index}`);
      if(f.index===2)await new Promise<void>(resolve=>{acknowledge=resolve;});
      order.push(`ack:${f.index}`);
    },
  });
  await Promise.resolve();await Promise.resolve();
  assert.equal(cursor.lastFrame,1);assert.deepEqual(order,['begin:1','ack:1','begin:2']);
  acknowledge();await pending;
  assert.deepEqual(order,['begin:1','ack:1','begin:2','ack:2','begin:3','ack:3','begin:4','ack:4']);
  await assert.rejects(cursor.consume('g',[output(5)],{gap:async()=>{},frame:async()=>{throw new Error('parser failed');}}));
  assert.equal(cursor.lastFrame,4);
});
test('finish status and storage history remain independent',async()=>{
  const cursor=new TerminalStreamCursor('g'),consumer=sink();
  await cursor.consume('g',[resize(),{index:2,kind:'state',data:{status:'exited',detail:{exitCode:0}}}],consumer);
  for(const state of ['recording','limited','error','complete','incomplete'] as const){
    const history={state,durableFrame:1,lastFrame:2};
    assert.equal(cursor.lastFrame,2);if(state!=='recording')assert.ok(historyLabel(history));
  }
  assert.equal(historyLabel({state:'limited',durableFrame:1,lastFrame:2}),'Historial limitado');
  assert.equal(historyLabel({state:'incomplete',durableFrame:1,lastFrame:2}),'Historial incompleto');
});

test('real browser: native replay is quiet, live survives archive errors, gaps reset, checkpoints cannot roll back', {timeout:30000,skip:process.env.TERMINAL_STREAM_BROWSER !== '1'}, async()=>{
  const {chromium,webkit}=await import('playwright');
  const {createServer}=await import('vite');
  const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,hmr:false}});
  await server.listen();
  const browser=await (process.env.TERMINAL_STREAM_ENGINE==='webkit' ? webkit.launch({headless:true}) : chromium.launch({headless:true,channel:'chrome'})).catch(async error=>{await server.close();throw error;});
  try {
    const page=await browser.newPage({viewport:{width:1220,height:800}});
    await page.addInitScript(()=>{
      const w=window as any;
      const generation='native-browser';
      const history={state:'recording',durableFrame:2,lastFrame:3};
      const session:any={id:'native',title:'Native',kind:'fixture',transport:'pty',status:'running',cwd:'/synthetic',rows:17,cols:65,terminalStream:{generation,history}};
      const frames:any[]=[{index:1,kind:'resize',data:{rows:17,cols:65}},
        {index:2,kind:'output',data:btoa('archive\x07\x1b[6n')},
        {index:3,kind:'output',data:btoa('catchup\x1b[6n')}];
      const events:any[]=[{seq:1,sessionId:'native',kind:'provider',data:JSON.stringify({method:'jauria/terminalFrames',params:{generation,frames:frames.slice(0,2)}})}];
      const inputs:any[]=[],afters:number[]=[];let evidence:any;let fail=false;let first=1;let archivedOnly=false;let pendingArchive:any[]=[];
      const status=()=>structuredClone({pid:123,generation,terminalStreamVersion:1,normalTerminalVersion:1,sessions:[session],lastSeq:events.length});
      Object.defineProperty(document,'hasFocus',{value:()=>false});
      w.nativeFixture={inputs,afters,snapshot:()=>evidence,
        backfill(pending:boolean){
          const base=history.lastFrame;
          pendingArchive=[{index:base+1,kind:'output',data:btoa(`saved-${base}-A\x1b[6n`)},{index:base+2,kind:'output',data:btoa(`saved-${base}-B`)}];
          first=base+3;history.lastFrame=base+3;history.durableFrame=pending?base:base+2;
          history.state=pending?'recording':'complete';
          frames.splice(0,frames.length,{index:base+3,kind:'output',data:btoa(`live-${base}-C`)});
        },
        releaseBackfill(){history.durableFrame=history.lastFrame;history.state='complete';events.push({seq:events.length+1,sessionId:'native',kind:'provider',data:JSON.stringify({method:'jauria/terminalFrames',params:{generation,frames:pendingArchive}})});pendingArchive=[];},
        retire(){archivedOnly=true;session.detail={terminalStream:structuredClone(session.terminalStream)};},
        gap(){fail=true;first=history.lastFrame+4;frames.splice(0,frames.length,{index:first,kind:'resize',data:{rows:16,cols:62}},{index:first+1,kind:'output',data:btoa('after-gap')});history.state='limited';history.lastFrame=first+1;},
        finish(){fail=false;session.status='exited';history.state='incomplete';history.lastFrame+=1;frames.push({index:history.lastFrame,kind:'state',data:{status:'exited',detail:{exitCode:0}}});},
        checkpoint(){events.push({seq:events.length+1,sessionId:'native',kind:'state',data:JSON.stringify({status:'running',rows:3,cols:4,detail:{terminalStream:{generation,history}}})});},
        archiveDuplicate(){events.push({seq:events.length+1,sessionId:'native',kind:'provider',data:JSON.stringify({method:'jauria/terminalFrames',params:{generation,frames:frames.slice()}})});},
      };
      w.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},async invoke(cmd:string,args:any){
        if(cmd==='connect_runner')return{dataDir:'/synthetic',socket:'/synthetic',status:status(),smoke:true};
        if(cmd==='probe_tools')return[];
        if(cmd==='record_ui_evidence'){evidence=args.payload;return;}
        if(cmd==='plugin:window|set_badge_count')return;
        if(cmd==='runner_request'){
          const op=args.op;
          if(op==='status')return fail?{ok:false,error:'archive status unavailable'}:{ok:true,result:status()};
          if(op==='events')return fail?{ok:false,error:'archive unavailable'}:{ok:true,result:{events:events.filter(e=>e.seq>args.args.after),lastSeq:events.length,hasMore:false}};
          if(op==='terminal_live'){
            const after=args.args.after;afters.push(after);
            if(archivedOnly)return{ok:true,result:{archivedOnly:true,sessionId:'native',generation}};
            return{ok:true,result:structuredClone({generation,frames:frames.filter(f=>f.index>after),gap:after+1<first?{firstFrame:after+1,lastFrame:first-1}:null,firstFrame:first,lastFrame:history.lastFrame,durableFrame:history.durableFrame,hasMore:false,session,history})};
          }
          if(op==='input'){inputs.push(args.args);return{ok:true,result:{}};}
          if(op==='resize')return{ok:true,result:{rows:args.args.rows,cols:args.args.cols}};
          if(op==='telemetry')return{ok:true,result:{}};
          throw new Error(`Unexpected RPC ${op}`);
        }
        throw new Error(`Unexpected invoke ${cmd}`);
      }};
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForFunction(()=>(window as any).nativeFixture.afters.includes(3));
    assert.deepEqual(await page.evaluate(()=>(window as any).nativeFixture.inputs),[],'historical DSR must not become input');
    assert.equal(await page.locator('#attention-banner').isVisible(),false,'historical BEL stays quiet');
    for(const [pending,after] of [[false,6],[true,9]] as const){
      await page.evaluate(value=>(window as any).nativeFixture.backfill(value),pending);
      await page.waitForFunction(()=>document.querySelector('#notice-text')?.textContent?.includes('Recuperando salida guardada'));
      assert.equal(await page.locator('#connection-state').textContent(),'Conectado');
      await page.locator('.xterm-helper-textarea').press('x');
      assert.deepEqual(await page.evaluate(()=>(window as any).nativeFixture.inputs),[],'catchup disables input');
      assert.equal(await page.locator('[data-action=interrupt]').first().isDisabled(),false,'interrupt remains available');
      await page.evaluate(()=>(window as any).nativeFixture.releaseBackfill());
      await page.waitForFunction(value=>(window as any).nativeFixture.afters.includes(value),after);
      await page.waitForFunction(()=>!document.querySelector('.session-state')?.textContent?.includes('Recuperando salida guardada'));
      await page.waitForFunction(value=>String((window as any).nativeFixture.snapshot()?.sessions[0].lastLines).includes(`live-${value-3}-C`),after);
      const saved=await page.evaluate(()=>(window as any).nativeFixture.snapshot().sessions[0].lastLines.join('\n'));
      const base=after-3;
      assert.match(saved,new RegExp(`saved-${base}-Asaved-${base}-Blive-${base}-C`));
      assert.doesNotMatch(await page.locator('.session-state').first().textContent()??'',/desincronizada/);
      assert.deepEqual(await page.evaluate(()=>(window as any).nativeFixture.inputs),[],'saved DSR never becomes new input');
    }
    await page.evaluate(()=>(window as any).nativeFixture.gap());
    await page.waitForFunction(()=>(window as any).nativeFixture.afters.includes(14));
    await page.waitForFunction(()=>document.querySelector('.session-state')?.textContent?.includes('Vista desincronizada'));
    assert.equal(await page.locator('#connection-state').textContent(),'Conectado');
    assert.match(await page.locator('#notice-text').textContent()??'',/Vista desincronizada/);
    await page.locator('#dismiss-notice').click();
    assert.equal(await page.locator('#notice').isVisible(),true,'gap notice remains persistent');
    await page.evaluate(()=>(window as any).nativeFixture.finish());
    await page.waitForFunction(()=>(window as any).nativeFixture.afters.includes(15));
    await page.evaluate(()=>{(window as any).nativeFixture.checkpoint();(window as any).nativeFixture.archiveDuplicate();});
    await page.waitForFunction(()=>(window as any).nativeFixture.snapshot()?.renderedSeq===5);
    const result=await page.evaluate(()=>(window as any).nativeFixture.snapshot().sessions[0]);
    assert.equal(result.status,'exited');assert.equal(result.cols,62);assert.equal(result.rows,16);
    assert.match(result.lastLines.join('\n'),/after-gap/);assert.doesNotMatch(result.lastLines.join('\n'),/archive|catchup/);
    assert.deepEqual(await page.evaluate(()=>(window as any).nativeFixture.inputs),[],'gap never injects provider input');
    await page.evaluate(()=>(window as any).nativeFixture.retire());
    await page.waitForTimeout(1300);
    const polls=await page.evaluate(()=>(window as any).nativeFixture.afters.length);
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(()=>(window as any).nativeFixture.afters.length),polls,'archivedOnly is not revived by stale status metadata');
    assert.equal(await page.locator('#connection-state').textContent(),'Conectado');
    assert.match(await page.locator('.session-state').first().textContent()??'',/Historial incompleto|desincronizada/);
  } finally {await browser.close();await server.close();}
});


test('quota warnings consider row saturation independently of bytes and rearm with hysteresis',()=>{
  const quota=new HistoryQuotaWarnings();
  const retention={outputEncodedBytes:17,maxOutputEncodedBytes:100,eventRows:100,outputRowLimit:100};
  assert.equal(historyUsage(retention),1);assert.equal(quota.sample(historyUsage(retention)),95);
  assert.equal(quota.sample(1),null);assert.equal(quota.sample(.94),null);
  assert.equal(quota.sample(.9),null);assert.equal(quota.sample(.95),null);
  assert.equal(quota.sample(.89),null);assert.equal(quota.sample(.95),95);
  assert.equal(quota.sample(.76),null);assert.equal(quota.sample(.8),null);
  assert.equal(quota.sample(.74),null);assert.equal(quota.sample(.8),80);
  assert.equal(quota.sample(.81),null);assert.equal(quota.sample(.95),95);
  assert.equal(historyUsage({...retention,outputEncodedBytes:99,eventRows:2}),.99);
  assert.equal(historyUsage({outputEncodedBytes:81,maxOutputEncodedBytes:100,eventRows:100}),.81,'legacy retention has no row limit');
  assert.equal(historyLabel({state:'unknown_tail',durableFrame:1,lastFrame:2}),'Historial sin confirmar');
});

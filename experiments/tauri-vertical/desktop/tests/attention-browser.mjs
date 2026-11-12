import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.JAURIA_PLAYWRIGHT_MODULE || 'playwright');
await mkdir('.impeccable/review', {recursive:true});
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true,channel:'chrome'});
const page = await browser.newPage({viewport:{width:1220,height:800}});
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  const sessions = [
    {id:'foreground',title:'Terminal de trabajo',kind:'terminal',status:'running',transport:'pty',cwd:'/demo/jauria',rows:24,cols:80},
    {id:'claude',title:'Claude · revisión de cambios',kind:'claude',status:'running',transport:'pty',cwd:'/demo/review',rows:24,cols:80},
    {id:'structured',title:'Codex · permiso estructurado',kind:'codex',status:'running',transport:'app-server',codex:{generation:1,status:'running',nativeThreadId:'demo'},cwd:'/demo/codex',rows:24,cols:80}
  ];
  const replay = location.search.includes('replay');
  let events=replay?[{seq:1,sessionId:'claude',kind:'output',data:btoa('historical synthetic output\x07')}]:[],seq=replay?1:0,pending=0;
  window.fixture={output(data){ events.push({seq:++seq,sessionId:'claude',kind:'output',data:btoa(data)}); },pending(n){pending=n;},end(){sessions[1].status='exited';}};
  const status=()=>structuredClone({pid:123,generation:'fixture',sessions,lastSeq:seq,normalTerminalVersion:1});
  window.__TAURI_INTERNALS__={
    async invoke(cmd,args){
      if(cmd==='connect_runner')return {dataDir:'/demo/synthetic',socket:'/demo/synthetic.sock',status:status(),smoke:false};
      if(cmd==='probe_tools')return {};
      if(cmd==='runner_request') {
        if(args.op==='status')return {ok:true,result:status()};
        if(args.op==='events')return {ok:true,result:{events:events.filter(e=>e.seq>args.args.after),lastSeq:seq,hasMore:false}};
        if(args.op==='codex_state')return {ok:true,result:{sessionId:args.args.id,generation:1,status:'running',nativeThreadId:'demo',requests:pending?[{id:'p1',generation:1,status:'pending',turnId:'t',attemptId:'a',method:'item/commandExecution/requestApproval'}]:[],pendingRequestCount:pending,turns:[]}};
        if(args.op==='resize')return {ok:true,result:{cols:80,rows:24}};
        return {ok:false,error:'Synthetic fixture: unsupported operation'};
      }
      if(cmd==='record_ui_evidence')return;
      throw Error('Synthetic fixture: '+cmd);
    },transformCallback(){return 1;},unregisterCallback(){}
  };
});
await page.goto('http://127.0.0.1:5189');
await page.waitForFunction(()=>document.querySelector('#connection-state')?.textContent==='Conectado');
await page.waitForTimeout(3500);
assert.equal(await page.locator('#attention-banner').isVisible(),false,'baseline quiet');
await page.evaluate(()=>window.fixture.output('demo synthetic activity\r\n\x07'));
await page.waitForFunction(()=>!document.querySelector('#attention-banner').hidden, null, {timeout:5000});
assert.match(await page.locator('#session-alerts').innerText(),/1/);
await page.locator('#review-attention').click();
assert.equal(await page.locator('.session-item').count(),1);
await page.screenshot({path:'.impeccable/review/desktop.png'});
await page.locator('.session-item').click();
await page.waitForFunction(()=>document.querySelector('#attention-banner').hidden);
assert.equal(await page.locator('#session-alerts').isVisible(),false,'viewing consumes PTY activity');
await page.evaluate(()=>window.fixture.pending(1));
await page.waitForTimeout(3600);
assert.equal(await page.locator('#attention-banner').isVisible(),true,'new hidden structured permission alerts');
await page.locator('#see-attention').click();
assert.equal(await page.locator('#session-alerts').isVisible(),true,'seen permission remains listed');
await page.setViewportSize({width:760,height:640});
await page.locator('#session-alerts').click();
await page.waitForTimeout(300);
await page.screenshot({path:'.impeccable/review/minimum-window.png'});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'no page overflow');
assert.deepEqual(errors,[]);
console.log('PASS synthetic browser: quiet baseline, hidden PTY activity/BEL, navigation and consumption, hidden Codex delta, seen != resolved, desktop and minimum window; no provider/profile or native permission calls.');
await page.goto('http://127.0.0.1:5189/?replay');
await page.waitForFunction(()=>document.querySelector('#connection-state')?.textContent==='Conectado');
await page.waitForTimeout(1000);
assert.equal(await page.locator('#session-alerts').isVisible(),false,'historical output and BEL replay stay quiet');
console.log('PASS replay suppression: initial historical output/BEL cannot create activity or native notices.');
await page.evaluate(()=>window.fixture.end());
await page.waitForFunction(()=>!document.querySelector('#attention-banner').hidden, null, {timeout:5000});
await page.locator('#review-attention').click();
await page.locator('#session-list .session-item').first().waitFor({state:'visible',timeout:5000});
assert.match(await page.locator('#session-list').textContent(), /El proceso terminó/);
console.log('PASS process end: hidden PTY live-to-exited status creates an actionable process notice.');
await browser.close();

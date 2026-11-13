/** Real main/xterm, synthetic Tauri and Notification boundaries only.
 * Run from desktop: node tests/attention-browser.mjs
 * No native app, profile, provider, or native permission calls.
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium, webkit } = await import(process.env.JAURIA_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0];

async function installMock(page) {
  await page.addInitScript(() => {
    const sessions = [
      {id:'foreground',title:'Terminal de trabajo',kind:'terminal',status:'running',transport:'pty',cwd:'/synthetic/jauria',rows:24,cols:80},
      {id:'codex',title:'Codex nativo',kind:'codex',status:'running',transport:'pty',cwd:'/synthetic/review',rows:24,cols:80},
      {id:'structured',title:'Codex estructurado',kind:'codex',status:'running',transport:'app-server',codex:{generation:1,status:'running',nativeThreadId:'synthetic'},cwd:'/synthetic/codex',rows:24,cols:80}
    ];
    const replay = location.search.includes('replay');
    let events = replay ? [{seq:1,sessionId:'codex',kind:'output',data:btoa('historical synthetic output\x07\x1b]9;notice\x07\x1b]777;notify;title;body\x1b\\')}] : [];
    let seq = events.length, pending = 0, focused = true;
    const badges = [], notifications = [], unexpected = [];
    Object.defineProperty(document, 'hasFocus', {value: () => focused});
    // Exercise native-notification scheduling without touching the OS API.
    window.Notification = class {
      static permission = 'granted';
      constructor(title, options) { notifications.push({title, options}); }
      static async requestPermission() { throw Error('Unexpected permission prompt'); }
    };
    window.fixture = {
      badges, notifications, unexpected,
      output(data, id = 'codex') { events.push({seq:++seq,sessionId:id,kind:'output',data:btoa(data)}); return seq; },
      pending(n) { pending = n; },
      end() { sessions[1].status = 'exited'; },
      custody() { sessions[1].status = 'needs_attention'; },
      focus(value) { focused = value; if (value) window.dispatchEvent(new Event('focus')); },
    };
    const status = () => structuredClone({pid:123,generation:'fixture',sessions,lastSeq:seq,normalTerminalVersion:1});
    window.__TAURI_INTERNALS__ = {
      metadata: {currentWindow: {label: 'main'}},
      async invoke(cmd,args) {
        if(cmd === 'connect_runner') return {dataDir:'/synthetic',socket:'/synthetic.sock',status:status(),smoke:false};
        if(cmd === 'probe_tools') return [];
        if(cmd === 'plugin:window|set_badge_count') { badges.push(args.value); return; }
        if(cmd === 'record_ui_evidence') return;
        if(cmd === 'runner_request') {
          if(args.op === 'status') return {ok:true,result:status()};
          if(args.op === 'events') return {ok:true,result:{events:events.filter(e=>e.seq>args.args.after),lastSeq:seq,hasMore:false}};
          if(args.op === 'codex_state') return {ok:true,result:{sessionId:args.args.id,generation:1,status:'running',nativeThreadId:'synthetic',requests:pending?[{id:`p${pending}`,generation:1,status:'pending',turnId:'t',attemptId:'a',method:'item/commandExecution/requestApproval'}]:[],pendingRequestCount:pending,turns:[]}};
          if(args.op === 'resize') return {ok:true,result:{cols:args.args.cols,rows:args.args.rows}};
          if(args.op === 'telemetry') return {ok:true,result:{}};
        }
        unexpected.push(`${cmd}:${args?.op ?? ''}`);
        throw Error(`Unexpected synthetic RPC: ${cmd}:${args?.op ?? ''}`);
      }, transformCallback() { return 1; }, unregisterCallback() {}
    };
  });
}
async function quiet(page, label) {
  assert.equal(await page.locator('#attention-banner').isVisible(), false, `${label}: banner`);
  assert.equal(await page.locator('#session-alerts').isVisible(), false, `${label}: header`);
  assert.equal(await page.locator('#attention-filter').isVisible(), false, `${label}: filter`);
  assert.equal(await page.title(), 'Jauría', `${label}: document title`);
  assert.equal(await page.locator('#session-list [data-attention="true"]').count(), 0, `${label}: session list`);
  assert.equal(await page.locator('#workbench-messages').getAttribute('data-active'), 'idle', `${label}: rail`);
  assert.deepEqual(await page.evaluate(() => window.fixture.badges.filter(n => n > 0)), [], `${label}: Dock`);
  assert.deepEqual(await page.evaluate(() => window.fixture.notifications), [], `${label}: native notices`);
}
async function output(page, data, id = 'codex') {
  const seq = await page.evaluate(({data,id}) => window.fixture.output(data,id), {data,id});
  await page.waitForFunction(seq => Number(document.querySelector('#cursor')?.textContent?.split(':').at(-1)) >= seq, seq);
  await page.waitForTimeout(150); // xterm's asynchronous parser must finish too.
}
async function newAlert(page) {
  await page.waitForFunction(() => !document.querySelector('#attention-banner').hidden);
  assert.equal(await page.locator('#session-alerts').textContent(), 'Avisos nuevos · 1');
  assert.equal(await page.title(), '(1) Avisos · Jauría');
}
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? {headless:true,channel:'chrome'} : {headless:true});
    try {
      for (const viewport of [{width:1220,height:800},{width:760,height:640}]) {
        const page = await browser.newPage({viewport});
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        try {
          await installMock(page);
          await page.goto(url);
          await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
          await page.waitForTimeout(3500); // Prime lifecycle and structured permission baselines.
          await quiet(page, 'primed running native Codex');
          await page.evaluate(() => document.querySelector('#enable-native-notifications').click());
          await page.waitForFunction(() => document.querySelector('#native-notification-status')?.textContent?.startsWith('Activadas'));
          for (const focused of [true, false]) {
            await page.evaluate(value => window.fixture.focus(value), focused);
            for (const id of ['foreground', 'codex']) {
              for (const data of [
                'ordinary output\r\n', '\r| working\x1b[K', '\r/ working\x1b[2K\x1b[1G',
                '\x1b]9;4;1;75\x07', '\x1b]9;4;0;0\x1b\\',
              ]) {
                await output(page, data.repeat(25), id);
                await quiet(page, `${id}, focused=${focused}, ${JSON.stringify(data)}`);
              }
            }
          }
          await page.waitForTimeout(1700); // Beyond native notification debounce.
          await quiet(page, 'raw redraw/progress after native debounce');
          for (const data of ['\x07', '\x1b]9;explicit notice\x07', '\x1b]777;notify;Codex;review\x1b\\']) {
            const nativeBefore = await page.evaluate(() => window.fixture.notifications.length);
            await output(page, data);
            await newAlert(page);
            await page.waitForFunction(n => window.fixture.notifications.length > n, nativeBefore);
            await page.waitForFunction(() => window.fixture.badges.at(-1) === 1);
            await page.locator('#review-attention').click();
            assert.equal(await page.locator('#session-list .session-item').count(), 1);
            assert.match(await page.locator('#session-list').textContent(), /alerta/);
            await page.locator('#session-list .session-item').click();
            await page.waitForFunction(() => document.querySelector('#attention-banner').hidden);
            assert.equal(await page.locator('#session-alerts').isVisible(), false, 'viewing consumes explicit activity');
            assert.equal(await page.title(), 'Jauría');
            await page.waitForFunction(() => window.fixture.badges.at(-1) == null);
          }
          await page.evaluate(() => window.fixture.pending(24));
          await newAlert(page);
          await page.locator('#see-attention').click();
          assert.equal(await page.locator('#session-alerts').textContent(), 'Pendientes · 1', 'seen permission stays unresolved');
          assert.equal(await page.title(), 'Jauría', 'seen permission no longer claims new attention');
          await page.locator('#session-alerts').click();
          assert.match(await page.locator('#session-list').textContent(), /24 permisos pendientes/);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.evaluate(() => window.fixture.pending(0));
          await page.waitForFunction(() => document.querySelector('#session-alerts').hidden);
          // Reviewing permissions opens the narrow navigation drawer. Close it
          // before interacting with the workbench's mark-seen control.
          if (await page.locator('#sidebar-scrim').isVisible()) await page.locator('#sidebar-scrim').click();
          await page.evaluate(() => window.fixture.custody());
          await newAlert(page);
          await page.locator('#see-attention').click();
          assert.equal(await page.locator('#session-alerts').textContent(), 'Pendientes · 1', 'seen custody stays unresolved');
          await page.locator('#session-alerts').click();
          assert.match(await page.locator('#session-list').textContent(), /custodia/);
          assert.deepEqual(await page.evaluate(() => window.fixture.unexpected), []);
          assert.deepEqual(errors, []);

          await page.goto(`${url}?replay`);
          await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
          await page.waitForTimeout(1700);
          await quiet(page, 'historical BEL and OSC replay');
          await page.evaluate(() => window.fixture.end());
          await newAlert(page);
          await page.locator('#review-attention').click();
          await page.locator('#session-list .session-item').first().waitFor({state:'visible'});
          assert.match(await page.locator('#session-list').textContent(), /El proceso terminó/);
          assert.deepEqual(await page.evaluate(() => window.fixture.unexpected), []);
          assert.deepEqual(errors, []);
          console.log(`PASS ${engine.name()} ${viewport.width}x${viewport.height}: primed native Codex; foreground/background raw redraw and OSC 9;4 quiet (BEL/ST); zero banner/header/title/list/Dock/native notices; explicit BEL/OSC 9/777 alert and view consumes; structured permissions/custody stay pending after seen; replay quiet; process end alerts.`);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }

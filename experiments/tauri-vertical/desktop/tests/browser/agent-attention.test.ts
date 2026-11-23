/**
 * Runner 1.4 E attention in the real app (main.ts + xterm), synthetic Tauri
 * boundary only: no runner, profile, provider or OS settings. The harness
 * toggles `agentAttentionVersion`: with it, state, duration and pending alerts
 * come from `status`/`terminal_live` `agent` and seen goes back through
 * `mark_seen`; without it (1.3.x runner) the client parser and window-local
 * seen stay as before.
 * AGENT_ATTENTION_SCREENSHOT_DIR=/absolute/dir saves synthetic light/dark captures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = server.resolvedUrls!.local[0];
const shots = process.env.AGENT_ATTENTION_SCREENSHOT_DIR;

type Options = { runner: boolean; hasMore?: boolean };
async function install(page: Page, options: Options) {
  await page.addInitScript((options: Options) => {
    const w = window as any;
    const generation = 'agent-fixture';
    const minute = 60_000;
    // The synthetic runner outlives the page: its clock origin survives a reload.
    const now = Number(sessionStorage.getItem('agent-fixture-t0') ?? Date.now());
    sessionStorage.setItem('agent-fixture-t0', String(now));
    const sessions: any[] = [
      { id: 'foreground', title: 'Claude foreground', kind: 'claude', transport: 'pty', status: 'running', cwd: '/synthetic/foreground', rows: 24, cols: 80 },
      { id: 'background', title: 'Claude background', kind: 'claude', transport: 'pty', status: 'running', cwd: '/synthetic/background', rows: 24, cols: 80 },
    ];
    const frames = new Map<string, any[]>(sessions.map(s => [s.id, [{ index: 1, kind: 'resize', data: { rows: 24, cols: 80 } }, { index: 2, kind: 'output', data: btoa(`${s.title}\r\n`) }]]));
    const base = { epoch: 4503599627370495, state: null, changedAt: now - 5 * minute, stateFrame: null, turnOpen: false, turnStartedAt: null, turnEndedAt: null,
      lastTurnMs: null, turnInterrupted: false, alertSeq: 0, seenSeq: 0, finishedUnseen: false, pending: {} as any };
    const agents = new Map<string, any>([
      ['foreground', { ...base, state: 'working', turnOpen: true, turnStartedAt: now - 5 * minute, changedAt: now - 5 * minute, stateFrame: 2 }],
      ['background', { ...base, epoch: 777, state: 'idle', lastTurnMs: 3 * minute, alertSeq: 1, finishedUnseen: true, pending: { finished: { seq: 1, frame: 2 } } }],
    ]);
    const marks: any[] = [], calls: string[] = [], resizes: any[] = [], notices: any[] = [], badges: any[] = [], unexpected: string[] = [];
    let focused = true, hold = false, release: (() => void) | undefined, rejectNext = false, connectCount = 0;
    const summary = () => {
      const pending = [...agents.values()].filter(a => Object.keys(a.pending).length);
      return options.hasMore ? { hasMore: true, pendingSessions: pending.length + 3, pendingAlerts: pending.length + 4, durable: true, maxAgents: 128 }
        : { hasMore: false, pendingSessions: pending.length, pendingAlerts: pending.reduce((n, a) => n + Object.keys(a.pending).length, 0), durable: true, maxAgents: 128 };
    };
    const history = (id: string) => ({ state: 'recording', durableFrame: frames.get(id)!.length, lastFrame: frames.get(id)!.length });
    const row = (s: any) => ({ ...s, terminalStream: { generation, history: history(s.id) }, ...(options.runner && agents.has(s.id) ? { agent: structuredClone(agents.get(s.id)) } : {}) });
    const status = () => structuredClone({ pid: 123, generation, terminalStreamVersion: 1, normalTerminalVersion: 1, sessions: sessions.map(row), lastSeq: 0,
      ...(options.runner ? { agentAttentionVersion: 1, agentAttention: summary() } : {}) });
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    w.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(...args: any[]) { notices.push(args); } };
    w.agentFixture = {
      marks, calls, resizes, notices, badges, unexpected,
      get connectCount() { return connectCount; }, get waiting() { return !!release; },
      focus(value: boolean) { focused = value; },
      hold() { hold = true; }, release() { hold = false; release?.(); release = undefined; },
      rejectNext() { rejectNext = true; },
      agent(id: string, patch: any) { const a = agents.get(id); agents.set(id, { ...a, ...patch }); },
      raise(id: string, kind: string, frame: number | null) {
        const a = agents.get(id); const seq = a.alertSeq + 1;
        agents.set(id, { ...a, alertSeq: seq, pending: { ...a.pending, [kind]: frame === undefined ? { seq } : { seq, frame } } });
      },
      output(id: string, data: string) { const f = frames.get(id)!; f.push({ index: f.length + 1, kind: 'output', data: btoa(data) }); return f.length; },
      agentOf(id: string) { return structuredClone(agents.get(id)); },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      async invoke(cmd: string, request: any) {
        if (cmd === 'connect_runner') { connectCount++; return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: false }; }
        if (cmd === 'probe_tools') return [];
        if (cmd === 'plugin:event|listen' || cmd === 'plugin:event|unlisten') return 1;
        if (cmd === 'plugin:window|set_badge_count') { badges.push(request.value); return; }
        if (cmd === 'plugin:notification|is_permission_granted') return true;
        if (cmd === 'runner_request') {
          const { op, args } = request; calls.push(op);
          if (op === 'status') return { ok: true, result: status() };
          if (op === 'events') return { ok: true, result: { events: [], lastSeq: 0, hasMore: false } };
          if (op === 'telemetry') return { ok: true, result: {} };
          if (op === 'resize') { resizes.push(structuredClone(args)); return { ok: true, result: { rows: args.rows, cols: args.cols } }; }
          if (op === 'terminal_live') {
            if (hold) await new Promise<void>(resolve => { release = resolve; });
            const stream = frames.get(args.id)!; const s = sessions.find(x => x.id === args.id);
            return { ok: true, result: structuredClone({ generation, frames: stream.filter(f => f.index > args.after).slice(0, args.limit), gap: null, firstFrame: 1,
              lastFrame: stream.length, durableFrame: stream.length, hasMore: false, session: row(s), history: history(args.id),
              ...(options.runner ? { agent: agents.get(args.id) ?? null } : {}) }) };
          }
          if (op === 'mark_seen' && options.runner) {
            marks.push(structuredClone(args.items));
            const items = args.items.map((item: any) => {
              const a = agents.get(item.id); if (!a) return { id: item.id, agent: null };
              if (rejectNext || a.epoch !== item.epoch) {
                rejectNext = false;
                const fresh = { ...base, epoch: a.epoch + 1, alertSeq: 1, pending: { ended: { seq: 1 } } };
                agents.set(item.id, fresh); return { id: item.id, rejected: 'epoch', agent: structuredClone(fresh) };
              }
              const seen = Math.max(a.seenSeq, Math.min(item.through, a.alertSeq));
              const pending = Object.fromEntries(Object.entries(a.pending).filter(([, p]: any) => p.seq > seen));
              const next = { ...a, seenSeq: seen, pending, finishedUnseen: !!(pending as any).finished };
              agents.set(item.id, next); return { id: item.id, agent: structuredClone(next) };
            });
            return { ok: true, result: { items, durable: true } };
          }
        }
        unexpected.push(`${cmd}:${request?.op ?? ''}`);
        throw new Error(`Unexpected synthetic RPC ${cmd}:${request?.op ?? ''}`);
      },
      transformCallback() { return 1; }, unregisterCallback() {},
    };
  }, options);
}

const fx = (page: Page, body: string) => page.evaluate(`(() => { const f = window.agentFixture; ${body} })()`);
const row = (page: Page, id: string) => page.locator(`#session-list .session-item[data-session-id="${id}"]`);
async function open(page: Page) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
}
async function capture(page: Page, engine: string, name: string) {
  if (!shots || engine !== 'chromium') return;
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${shots}/${name}-${theme}.png`, animations: 'disabled' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: runner agent attention`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      const fixture = async (options: Options, run: (page: Page) => Promise<void>) => {
        const context = await browser.newContext({ viewport: { width: 1220, height: 800 } });
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        try {
          await install(page, options);
          await run(page);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.unexpected), []);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      };

      await t.test('runner pendings show at once in bell, status bar and sidebar, with no native notice; duration is the runner turn', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          assert.equal(await page.locator('#status-finished-text').textContent(), '1 terminó');
          assert.equal(await row(page, 'background').getAttribute('data-unseen'), 'true');
          assert.equal(await row(page, 'background').getAttribute('data-activity'), 'finished');
          assert.equal(await row(page, 'foreground').getAttribute('data-activity'), 'working');
          assert.equal(await row(page, 'foreground').locator('.session-item-duration').textContent(), '5 min');
          assert.equal(await page.locator('.pane-heading .session-state').first().textContent(), 'Trabajando');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 1, 'Dock agrees with the bell');
          await capture(page, engine.name(), 'pendientes-al-abrir');
          // Enabling macOS notices now never announces what was already pending, nor after reconnecting.
          await page.locator('#open-settings').click();
          await page.locator('#enable-native-notifications').click();
          await page.waitForFunction(() => document.querySelector('#enable-native-notifications')?.textContent?.startsWith('Desactivar'));
          await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
          await fx(page, `f.raise('background','bell',2); document.querySelector('#connect').click();`);
          await page.waitForFunction(() => (window as any).agentFixture.connectCount === 2 && document.querySelector('#connection-state')?.textContent === 'Conectado');
          await page.waitForTimeout(2000);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.notices), [], 'pending before connecting is not a new macOS notice');
          await fx(page, `f.raise('background','notify',2);`);
          await page.waitForFunction(() => (window as any).agentFixture.notices.length === 1, undefined, { timeout: 5000 });
          assert.equal(JSON.stringify(await page.evaluate(() => (window as any).agentFixture.notices[0])).includes('background'), false, 'generic text only');
        });
      });

      await t.test('no mark_seen during replay nor before its frame is consumed; then the painted epoch and through', async () => {
        await fixture({ runner: true }, async page => {
          await page.addInitScript(() => { const f = (window as any).agentFixture; f.hold(); f.raise('foreground', 'bell', 3); });
          await page.goto(url);
          await page.waitForFunction(() => (window as any).agentFixture.waiting);
          await page.waitForTimeout(1500);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks), [], 'nothing during replay');
          await fx(page, `f.release();`);
          await page.waitForTimeout(1500);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks), [], 'frame 3 is not consumed yet');
          await fx(page, `f.output('foreground','\\u0007bell\\r\\n');`);
          await page.waitForFunction(() => (window as any).agentFixture.marks.length === 1);
          const agent = await page.evaluate(() => (window as any).agentFixture.agentOf('foreground'));
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks[0]), [{ id: 'foreground', epoch: 4503599627370495, through: 1 }]);
          assert.equal(agent.seenSeq, 1);
          // The background finish is not attended: still pending, never auto-marked.
          assert.equal(await row(page, 'background').getAttribute('data-unseen'), 'true');
        });
      });

      await t.test('selecting marks the painted record; "terminó" stays visible while working again; epoch rejection resyncs', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          // The agent starts another turn without anyone looking: the finish stays.
          await fx(page, `f.agent('background',{state:'working',turnOpen:true,turnStartedAt:Date.now()-120000,changedAt:Date.now()-120000});`);
          await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="background"] .session-item-duration')?.textContent === '2 min');
          assert.equal(await row(page, 'background').getAttribute('data-activity'), 'finished');
          assert.equal(await page.locator('#status-finished-text').textContent(), '1 terminó');
          await capture(page, engine.name(), 'termino-visible-trabajando');
          await row(page, 'background').click();
          await page.waitForFunction(() => (window as any).agentFixture.marks.length === 1);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks[0]), [{ id: 'background', epoch: 777, through: 1 }]);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '0');
          assert.equal(await row(page, 'background').getAttribute('data-activity'), 'working');
          // Rejected epoch: resynchronise with the returned record, no retry with the old through.
          await row(page, 'foreground').click();
          await fx(page, `f.raise('background','ended',null); f.rejectNext();`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          await row(page, 'background').click();
          await page.waitForFunction(() => (window as any).agentFixture.marks.length === 2);
          await page.waitForTimeout(1500);
          assert.equal(await page.evaluate(() => (window as any).agentFixture.marks.length), 2, 'the old through is not retried');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.agentOf('background').epoch), 778);
          await row(page, 'foreground').click();
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          await row(page, 'background').click();
          await page.waitForFunction(() => (window as any).agentFixture.marks.length === 3);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks[2]), [{ id: 'background', epoch: 778, through: 1 }]);
        });
      });

      await t.test('state and duration survive a reconnection and a page reload', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="foreground"] .session-item-duration')?.textContent === '5 min');
          await page.locator('#connect').click();
          await page.waitForFunction(() => (window as any).agentFixture.connectCount === 2 && document.querySelector('#connection-state')?.textContent === 'Conectado');
          await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="foreground"] .session-item-duration')?.textContent === '5 min');
          await page.reload(); await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
          await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="foreground"] .session-item-duration')?.textContent === '5 min');
          assert.equal(await page.locator('.pane-heading .session-state').first().textContent(), 'Trabajando');
          await capture(page, engine.name(), 'duracion-tras-reconectar');
        });
      });

      await t.test('hasMore: totals from the runner and a discreet "y N más"', async () => {
        await fixture({ runner: true, hasMore: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '4');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 4);
          await page.locator('#session-alerts').click();
          assert.match(await page.locator('#attention-list').textContent() ?? '', /y 3 más/);
          await capture(page, engine.name(), 'hasmore');
        });
      });

      await t.test('state and alerts fed by status never resize the terminal', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForTimeout(900);
          const before = await page.evaluate(() => ({ resizes: (window as any).agentFixture.resizes.length, box: JSON.stringify(document.querySelector('.terminal-host')!.getBoundingClientRect()) }));
          for (const patch of [`f.agent('foreground',{state:'blocked'}); f.raise('foreground','needs',null);`, `f.agent('foreground',{state:'done'}); f.raise('foreground','finished',null);`,
            `f.raise('background','bell',2); f.raise('background','notify',2);`, `f.agent('foreground',{state:null}); f.raise('foreground','ended',null);`]) {
            await fx(page, patch); await page.waitForTimeout(1300);
          }
          await page.locator('#session-alerts').click(); await page.locator('#see-attention').click(); await page.waitForTimeout(900);
          const after = await page.evaluate(() => ({ resizes: (window as any).agentFixture.resizes.length, box: JSON.stringify(document.querySelector('.terminal-host')!.getBoundingClientRect()) }));
          assert.deepEqual(after, before);
        });
      });

      await t.test('runner mode: OSC and BEL in the frames never create client state or alerts (no duplicates)', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          await fx(page, `f.agent('background',{pending:{},alertSeq:1,seenSeq:1,finishedUnseen:false}); f.output('background','\\u001b]7501;state=blocked\\u0007\\u0007\\u001b]9;hola\\u0007');`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.hidden === true);
          await page.waitForTimeout(1500);
          assert.equal(await page.locator('#session-alerts').isHidden(), true, 'the runner record decides: no client alert');
          assert.equal(await row(page, 'background').getAttribute('data-activity'), 'idle', 'no client-side blocked state');
        });
      });

      await t.test('degraded (runner without the capability): client parser, no mark_seen, window-local seen as before', async () => {
        await fixture({ runner: false }, async page => {
          await open(page);
          await page.waitForTimeout(900);
          assert.equal(await page.locator('#session-alerts').isHidden(), true, 'first snapshot is quiet');
          assert.equal(await row(page, 'foreground').getAttribute('data-activity'), 'unreported', 'no agent record is read');
          await fx(page, `f.output('foreground','\\u001b]7501;state=working\\u0007');`);
          await page.waitForFunction(() => document.querySelector('.pane-heading .session-state')?.textContent === 'Trabajando');
          await fx(page, `f.output('background','\\u001b]7501;state=working\\u0007');`);
          await page.waitForTimeout(600);
          await fx(page, `f.output('background','\\u001b]7501;state=done\\u0007');`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          await row(page, 'background').click();
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '0');
          assert.equal((await page.evaluate(() => (window as any).agentFixture.calls)).includes('mark_seen'), false);
        });
      });
      await browser.close();
    });
  }
} finally { await server.close(); }

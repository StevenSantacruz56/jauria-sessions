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

/**
 * `closed`: extra exited sessions, each with a pending `ended`, older than the
 * two live ones; with more than `maxAgents` candidates the synthetic status is
 * capped exactly like the runner's status_into. `pulso`: a minimal empty Pulso
 * so the stage can switch to it. `viewport`: the window size.
 */
type Options = { runner: boolean; closed?: number; maxAgents?: number; pulso?: boolean; viewport?: { width: number; height: number } };
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
      ...Array.from({ length: options.closed ?? 0 }, (_, n) => ({ id: `closed-${n}`, title: `Cerrada ${n}`, kind: 'claude', transport: 'pty', status: 'exited', cwd: '/synthetic/closed', rows: 24, cols: 80 })),
    ];
    const frames = new Map<string, any[]>(sessions.map(s => [s.id, [{ index: 1, kind: 'resize', data: { rows: 24, cols: 80 } }, { index: 2, kind: 'output', data: btoa(`${s.title}\r\n`) }]]));
    const base = { epoch: 4503599627370495, state: null, changedAt: now - 5 * minute, stateFrame: null, turnOpen: false, turnStartedAt: null, turnEndedAt: null,
      lastTurnMs: null, turnInterrupted: false, alertSeq: 0, seenSeq: 0, finishedUnseen: false, pending: {} as any };
    const agents = new Map<string, any>([
      ['foreground', { ...base, state: 'working', turnOpen: true, turnStartedAt: now - 5 * minute, changedAt: now - 5 * minute, stateFrame: 2 }],
      ['background', { ...base, epoch: 777, state: 'idle', lastTurnMs: 3 * minute, alertSeq: 1, finishedUnseen: true, pending: { finished: { seq: 1, frame: 2 } } }],
      ...Array.from({ length: options.closed ?? 0 }, (_, n) => [`closed-${n}`, { ...base, epoch: 1000 + n, alertSeq: 1, pending: { ended: { seq: 1 } } }] as [string, any]),
    ]);
    // The runner's updated_at: closed sessions oldest, then the live ones; every change bumps it.
    let clock = 0;
    const updated = new Map<string, number>([...agents.keys()].map(id => [id, id.startsWith('closed-') ? clock++ : 0]));
    for (const id of ['foreground', 'background']) updated.set(id, clock++);
    const touch = (id: string) => updated.set(id, clock++);
    const maxAgents = options.maxAgents ?? 128;
    const marks: any[] = [], calls: string[] = [], resizes: any[] = [], notices: any[] = [], badges: any[] = [], unexpected: string[] = [];
    let focused = true, hold = false, release: (() => void) | undefined, rejectNext = false, connectCount = 0;
    const pendingCount = (a: any) => Object.keys(a.pending).length;
    /** agent_attention.rs status_into: only live or pending sessions, pending first, newest first, at most maxAgents; exact totals. */
    const listing = () => {
      const candidates = sessions.flatMap((s, index) => {
        const a = agents.get(s.id); if (!a) return [];
        const live = s.status === 'running' || s.status === 'starting';
        return pendingCount(a) > 0 || live ? [{ id: s.id, pending: pendingCount(a) > 0, updated: updated.get(s.id) ?? 0, index }] : [];
      }).sort((x, y) => Number(x.pending === false) - Number(y.pending === false) || y.updated - x.updated || x.index - y.index);
      const all = [...agents.entries()].filter(([id]) => sessions.some(s => s.id === id)).map(([, a]) => a);
      return { listed: new Set(candidates.slice(0, maxAgents).map(c => c.id)),
        summary: { hasMore: candidates.length > maxAgents, pendingSessions: all.filter(a => pendingCount(a) > 0).length,
          pendingAlerts: all.reduce((n, a) => n + pendingCount(a), 0), durable: true, maxAgents } };
    };
    const history = (id: string) => ({ state: 'recording', durableFrame: frames.get(id)!.length, lastFrame: frames.get(id)!.length });
    // Closed sessions come from a previous runner generation: only status carries their agent (no terminal_live ring).
    const row = (s: any, listed?: Set<string>) => ({ ...s, terminalStream: { generation: s.id.startsWith('closed-') ? 'previous-generation' : generation, history: history(s.id) }, ...(options.runner && listed?.has(s.id) ? { agent: structuredClone(agents.get(s.id)) } : {}) });
    const status = () => { const { listed, summary } = listing();
      return structuredClone({ pid: 123, generation, terminalStreamVersion: 1, normalTerminalVersion: 1, sessions: sessions.map(s => row(s, listed)), lastSeq: 0,
        ...(options.pulso ? { pulsoVersion: 1, pulsoBoardVersion: 1, pulsoAvailable: true } : {}),
        ...(options.runner ? { agentAttentionVersion: 1, agentAttention: summary } : {}) }); };
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    w.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(...args: any[]) { notices.push(args); } };
    w.agentFixture = {
      marks, calls, resizes, notices, badges, unexpected,
      get connectCount() { return connectCount; }, get waiting() { return !!release; },
      focus(value: boolean) { focused = value; },
      hold() { hold = true; }, release() { hold = false; release?.(); release = undefined; },
      rejectNext() { rejectNext = true; },
      agent(id: string, patch: any) { const a = agents.get(id); agents.set(id, { ...a, ...patch }); touch(id); },
      raise(id: string, kind: string, frame: number | null) {
        const a = agents.get(id); const seq = a.alertSeq + 1;
        agents.set(id, { ...a, alertSeq: seq, pending: { ...a.pending, [kind]: frame === undefined ? { seq } : { seq, frame } } }); touch(id);
      },
      /** What another window's mark_seen does: everything seen. */
      seenElsewhere(id: string) { const a = agents.get(id); agents.set(id, { ...a, seenSeq: a.alertSeq, pending: {}, finishedUnseen: false }); touch(id); },
      listed() { return [...listing().listed]; },
      output(id: string, data: string) { const f = frames.get(id)!; f.push({ index: f.length + 1, kind: 'output', data: btoa(data) }); return f.length; },
      agentOf(id: string) { return structuredClone(agents.get(id)); },
      /** The session's runner status (a process end: exited, stopped, failed). */
      status(id: string, value: string) { sessions.find(s => s.id === id).status = value; touch(id); },
      /** A process end as the runner reports it: status and detail.exitCode, plus the ended alert. */
      end(id: string, value: string, code: number) {
        const s = sessions.find(s => s.id === id); s.status = value; s.detail = { exitCode: code };
        const a = agents.get(id); const seq = a.alertSeq + 1;
        agents.set(id, { ...a, state: null, turnOpen: false, alertSeq: seq, pending: { ...a.pending, ended: { seq } } }); touch(id);
      },
      /** Hold the next mark_seen answer until releaseMark(); meanwhile alerts may arrive. */
      holdMark() { holdMark = true; }, releaseMark() { holdMark = false; markRelease?.(); markRelease = undefined; },
      get markWaiting() { return !!markRelease; },
      /** document.visibilityState as macOS reports a hidden/minimised window. */
      visibility(value: 'visible' | 'hidden') { visibility = value; document.dispatchEvent(new Event('visibilitychange')); },
    };
    let holdMark = false, markRelease: (() => void) | undefined, visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      async invoke(cmd: string, request: any) {
        if (cmd === 'connect_runner') { connectCount++; return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: false }; }
        if (cmd === 'probe_tools') return [];
        if (cmd === 'plugin:event|listen' || cmd === 'plugin:event|unlisten') return 1;
        if (cmd === 'plugin:window|set_badge_count') { badges.push(request.value); return; }
        if (cmd === 'plugin:notification|is_permission_granted') return true;
        if (cmd === 'pulso_request' && options.pulso) {
          const { op } = request;
          const empty = { items: [], totalCount: 0, hasMore: false, nextCursor: 0 };
          if (op === 'revision') return { ok: true, result: { revision: 1 } };
          if (op === 'projects') return { ok: true, result: { projects: [], revision: 1, totalCount: 0, hasMore: false } };
          if (op === 'board') return { ok: true, result: { revision: 1, columns: { todo: empty, doing: empty, waiting: empty, done: empty } } };
          if (op === 'items') return { ok: true, result: { items: [], revision: 1, totalCount: 0, hasMore: false } };
          if (op === 'policies') return { ok: true, result: { policies: [] } };
          if (op === 'links') return { ok: true, result: { links: [] } };
        }
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
            if (holdMark) await new Promise<void>(resolve => { markRelease = resolve; });
            const items = args.items.map((item: any) => {
              const a = agents.get(item.id); if (!a) return { id: item.id, agent: null }; touch(item.id);
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
        const context = await browser.newContext({ viewport: options.viewport ?? { width: 1220, height: 800 } });
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

      await t.test('hasMore as the runner caps it: totals from the runner, "y N más", and a record the next status omits is dropped', async () => {
        // 130 closed sessions with a pending end, plus background (pending, newest) and foreground (live): 132 candidates for 128 places.
        await fixture({ runner: true, closed: 130 }, async page => {
          await open(page);
          const listed = await page.evaluate(() => (window as any).agentFixture.listed());
          assert.equal(listed.length, 128);
          assert.ok(listed.includes('background') && !listed.includes('foreground'), 'pending first; the live one without alerts falls outside the cap');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '131');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 131);
          // The pane still shows the foreground state: terminal_live carries its agent although status omits it.
          assert.equal(await page.locator('.pane-heading .session-state').first().textContent(), 'Trabajando');
          await page.locator('#session-alerts').click();
          assert.match(await page.locator('#attention-list').textContent() ?? '', /y 3 más/);
          assert.match(await page.locator('#attention-list').textContent() ?? '', /Cerrada 129Sin ver/);
          await capture(page, engine.name(), 'hasmore');
          await page.keyboard.press('Escape');
          // Another window marks the newest closed session seen: the next status omits it (still hasMore).
          await fx(page, `f.seenElsewhere('closed-129');`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '130');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.listed().includes('closed-129')), false);
          await page.locator('#session-alerts').click();
          const list = await page.locator('#attention-list').textContent() ?? '';
          assert.doesNotMatch(list, /Cerrada 129Sin ver/, 'a session seen elsewhere is not kept as pending');
          assert.match(list, /y 2 más/, 'the omitted slots are counted, not hidden by a stale record');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 130);
        });
      });

      // A frame alert of the selected session, already consumed by xterm, is auto-marked only
      // when nothing covers the terminal. Each cover keeps it pending; removing it marks.
      const covers: { name: string; options?: Partial<Options>; cover: (page: Page) => Promise<void>; uncover: (page: Page) => Promise<void> }[] = [
        { name: 'sidebar drawer at 760 px', options: { viewport: { width: 760, height: 640 } },
          cover: async page => { await page.locator('#toggle-sidebar').click(); await page.waitForFunction(() => getComputedStyle(document.querySelector('#sidebar-scrim')!).display !== 'none'); },
          uncover: async page => { await page.evaluate(() => document.querySelector<HTMLButtonElement>('#sidebar-scrim')!.click()); } },
        { name: 'command palette', cover: async page => { await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open]').waitFor(); },
          uncover: async page => { await page.keyboard.press('Escape'); await page.locator('dialog.command-palette[open]').waitFor({ state: 'detached' }).catch(() => {}); } },
        { name: 'Pulso stage', options: { pulso: true }, cover: async page => { await page.locator('#open-pulso').click(); await page.waitForFunction(() => document.querySelector('#open-pulso')?.getAttribute('aria-pressed') === 'true'); },
          uncover: async page => { await page.locator('#open-pulso').click(); } },
      ];
      for (const c of covers) {
        await t.test(`covered terminal (${c.name}) is not attended: no automatic mark_seen until uncovered`, async () => {
          await fixture({ runner: true, ...c.options }, async page => {
            await open(page);
            await page.waitForTimeout(600);
            await c.cover(page);
            await fx(page, `f.raise('foreground','bell',f.output('foreground','\\u0007bell\\r\\n'));`);
            await page.waitForTimeout(2000);
            assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks), [], 'the frame was consumed, but the terminal is covered');
            await c.uncover(page);
            await page.waitForFunction(() => (window as any).agentFixture.marks.length === 1);
            assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks[0]), [{ id: 'foreground', epoch: 4503599627370495, through: 1 }]);
          });
        });
      }

      const enableNative = async (page: Page) => {
        await page.locator('#open-settings').click();
        await page.locator('#enable-native-notifications').click();
        await page.waitForFunction(() => document.querySelector('#enable-native-notifications')?.textContent?.startsWith('Desactivar'));
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
      };
      const unread = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread ?? '0');

      await t.test('bell, title, Dock, rows and status bar agree with several kinds pending', async () => {
        await fixture({ runner: true, closed: 2 }, async page => {
          await open(page);
          await fx(page, `f.agent('foreground',{state:'blocked'}); f.raise('foreground','needs',null);`);
          // The attended foreground is not counted as new; the three others are.
          await page.waitForFunction(() => document.querySelector('#status-needs-text')?.textContent === '1 te necesita');
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '3');
          assert.equal(await page.locator('#session-alerts').getAttribute('data-total'), '4');
          assert.equal(await page.title(), '(3) Avisos · Jauría');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 3, 'Dock = bell');
          assert.equal(await page.locator('#status-finished-text').textContent(), '3 terminaron');
          // Leaving the window: the foreground counts too, everywhere at once.
          await fx(page, `f.focus(false); window.dispatchEvent(new Event('blur'));`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '4');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 4);
          assert.equal(await page.title(), '(4) Avisos · Jauría');
        });
      });

      await t.test('a hidden window marks nothing seen and counts the alert; showing it marks the consumed frame', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForTimeout(600);
          await fx(page, `f.visibility('hidden'); f.raise('foreground','bell',f.output('foreground','\\u0007bell\\r\\n'));`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '2');
          await page.waitForTimeout(1500);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks), [], 'nobody is looking');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 2);
          await fx(page, `f.visibility('visible');`);
          await page.waitForFunction(() => (window as any).agentFixture.marks.length === 1);
          assert.equal(await unread(page), '1', 'only the background finish is left');
        });
      });

      await t.test('an alert arriving while mark_seen is in flight stays unseen', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          await fx(page, `f.holdMark();`);
          await row(page, 'background').click();
          await page.waitForFunction(() => (window as any).agentFixture.markWaiting);
          await fx(page, `f.raise('background','notify',null);`);
          await page.waitForTimeout(1200);
          await fx(page, `f.releaseMark();`);
          await row(page, 'foreground').click();
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.marks[0]), [{ id: 'background', epoch: 777, through: 1 }]);
          assert.equal(await row(page, 'background').getAttribute('data-unseen'), 'true', 'the notify that raced the mark is still new');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.agentOf('background').seenSeq), 1);
        });
      });

      await t.test('a process end seen on screen is not news later: no unread and no macOS notice after leaving', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await enableNative(page);
          await page.waitForTimeout(600);
          await fx(page, `f.status('foreground','exited'); f.agent('foreground',{state:null,turnOpen:false}); f.raise('foreground','ended',null);`);
          await page.waitForFunction(() => document.querySelector('#session-list .session-item[data-session-id="foreground"]')?.getAttribute('data-activity') !== 'working');
          await page.waitForTimeout(1500);
          // The person saw it end in the focused pane: same rule as a consumed BEL.
          await page.waitForFunction(() => (window as any).agentFixture.agentOf('foreground').seenSeq === 1);
          await row(page, 'background').click();
          await page.waitForTimeout(2000);
          assert.equal(await unread(page), '0');
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.notices), [], 'no «Actividad finalizada» for what was on screen');
        });
      });

      await t.test('split stage: the second visible pane is attended too (automatic seen, no unread, no macOS), unless covered', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await page.locator('#toggle-split').click();
          await page.waitForFunction(() => document.querySelector('.pane:nth-child(2) .pane-heading')?.textContent?.includes('Claude background'));
          await page.waitForTimeout(800);
          // The background finish (frame 2) is now on screen in pane 2 and its frame consumed: marked seen.
          await page.waitForFunction(() => (window as any).agentFixture.marks.some((m: any[]) => m.some(i => i.id === 'background')));
          await enableNative(page);
          const before = await page.evaluate(() => (window as any).agentFixture.marks.length);
          // A BEL in the second (not focused) pane, frame consumed by its xterm: seen there.
          await fx(page, `f.raise('background','bell',f.output('background','\\u0007bell\\r\\n'));`);
          await page.waitForFunction(n => (window as any).agentFixture.marks.length > n, before);
          assert.equal(await unread(page), '0');
          await page.waitForTimeout(1800);
          assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.notices), [], 'on screen: no macOS notice');
          // Covered by the palette: the second pane is not attended either.
          await page.keyboard.press('Meta+Shift+P'); await page.locator('dialog.command-palette[open]').waitFor();
          const covered = await page.evaluate(() => (window as any).agentFixture.marks.length);
          await page.waitForTimeout(1100);
          await fx(page, `f.raise('background','notify',f.output('background','\\u001b]9;x\\u0007'));`);
          await page.waitForTimeout(1500);
          assert.equal(await page.evaluate(() => (window as any).agentFixture.marks.length), covered, 'covered: no automatic seen');
          await page.keyboard.press('Escape');
          await page.waitForFunction(n => (window as any).agentFixture.marks.length > n, covered);
        });
      });

      await t.test('a process that failed (code 2) is «Proceso falló (código 2)», counts in «te necesita» and is a «Necesita tu atención» notice', async () => {
        await fixture({ runner: true }, async page => {
          await open(page);
          await enableNative(page);
          // The background finish is seen first so only the end counts.
          await row(page, 'background').click(); await row(page, 'foreground').click();
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '0' || document.querySelector<HTMLElement>('#session-alerts')?.hidden);
          await fx(page, `f.end('background','exited',2);`);
          await page.waitForFunction(() => document.querySelector('#status-needs-text')?.textContent === '1 te necesita');
          assert.equal(await page.locator('#status-finished').isHidden(), true, 'not «terminó»');
          await page.locator('#session-alerts').click();
          assert.match(await page.locator('#attention-list').textContent() ?? '', /Proceso falló \(código 2\)/);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => (window as any).agentFixture.notices.length === 1, undefined, { timeout: 5000 });
          assert.match(JSON.stringify(await page.evaluate(() => (window as any).agentFixture.notices[0])), /Necesita tu atención/);
          assert.doesNotMatch(JSON.stringify(await page.evaluate(() => (window as any).agentFixture.notices[0])), /código|background/, 'the notice copy stays generic');
          // A clean exit (code 0) that happens while nobody looks (window in the background) is «terminó».
          await fx(page, `f.focus(false); window.dispatchEvent(new Event('blur')); f.end('foreground','exited',0);`);
          await page.waitForFunction(() => document.querySelector('#status-finished-text')?.textContent === '1 terminó');
          assert.equal(await page.locator('#status-needs-text').textContent(), '1 te necesita', 'the failure still counts apart');
        });
      });

      await t.test('Descartar an Interrumpida also marks its runner alerts seen (H7)', async () => {
        await fixture({ runner: true, closed: 1 }, async page => {
          await open(page);
          await fx(page, `f.status('closed-0','interrupted');`);
          const dismiss = page.locator('.session-dismiss[data-session-id="closed-0"]');
          await dismiss.waitFor();
          await page.waitForFunction(() => Number(document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread) >= 2);
          await dismiss.click();
          await page.waitForFunction(() => (window as any).agentFixture.marks.some((m: any[]) => m.some(i => i.id === 'closed-0')));
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          assert.equal(await page.evaluate(() => (window as any).agentFixture.agentOf('closed-0').seenSeq), 1);
          assert.equal(await page.evaluate(() => (window as any).agentFixture.badges.at(-1)), 1, 'only the background finish is left');
        });
      });

      await t.test('degraded mode: a BEL behind the sidebar drawer at 760 px is an unread alert', async () => {
        await fixture({ runner: false, viewport: { width: 760, height: 640 } }, async page => {
          await open(page);
          await page.waitForTimeout(900);
          await page.locator('#toggle-sidebar').click();
          await page.waitForFunction(() => getComputedStyle(document.querySelector('#sidebar-scrim')!).display !== 'none');
          await fx(page, `f.output('foreground','\\u0007');`);
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
          assert.equal(await row(page, 'foreground').getAttribute('data-unseen'), 'true');
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

      // Formerly tests/attention-browser.mjs: raw output never alerts; explicit BEL/OSC 9/777 do, everywhere; replay is quiet.
      await t.test('degraded: replayed BEL/OSC and raw redraws/progress stay quiet; live BEL, OSC 9 and OSC 777 alert bell, title, Dock and macOS, and opening consumes', async () => {
        await fixture({ runner: false }, async page => {
          await page.addInitScript(() => { (window as any).agentFixture.output('background', '\u0007\u001b]9;historia\u0007\u001b]777;notify;t;b\u001b\\'); });
          const quiet = async (label: string) => {
            assert.equal(await page.locator('#session-alerts').isHidden(), true, `${label}: bell`);
            assert.equal(await page.title(), 'Jauría', `${label}: title`);
            assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.badges.filter((n: number) => n > 0)), [], `${label}: Dock`);
            assert.deepEqual(await page.evaluate(() => (window as any).agentFixture.notices), [], `${label}: macOS`);
            assert.equal(await page.locator('#session-list [data-unseen="true"]').count(), 0, `${label}: list`);
          };
          await open(page);
          await page.waitForTimeout(1500);
          await quiet(page, 'historical BEL/OSC 9/777 replay');
          await page.locator('#open-settings').click();
          await page.locator('#enable-native-notifications').click();
          await page.waitForFunction(() => document.querySelector('#enable-native-notifications')?.textContent?.startsWith('Desactivar'));
          await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
          for (const id of ['foreground', 'background']) {
            for (const data of ['ordinary output\r\n', '\r| working\u001b[K', '\r/ working\u001b[2K\u001b[1G', '\u001b]9;4;1;75\u0007', '\u001b]9;4;0;0\u001b\\']) {
              await page.evaluate(([id, data]) => (window as any).agentFixture.output(id, data.repeat(25)), [id, data]);
            }
          }
          await page.waitForTimeout(1800); // beyond the 1.5 s native grouping
          await quiet(page, 'raw output, spinner redraws and OSC 9;4 progress');
          for (const data of ['\u0007', '\u001b]9;aviso explícito\u0007', '\u001b]777;notify;Codex;revisión\u001b\\']) {
            const before = await page.evaluate(() => (window as any).agentFixture.notices.length);
            await page.evaluate(data => (window as any).agentFixture.output('background', data), data);
            await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.dataset.unread === '1');
            assert.equal(await page.title(), '(1) Avisos · Jauría');
            await page.waitForFunction(() => (window as any).agentFixture.badges.at(-1) === 1);
            await page.waitForFunction(n => (window as any).agentFixture.notices.length > n, before);
            assert.equal(JSON.stringify(await page.evaluate(() => (window as any).agentFixture.notices.at(-1))).includes('background'), false, 'generic copy');
            await row(page, 'background').click();
            await page.waitForFunction(() => document.querySelector<HTMLElement>('#session-alerts')?.hidden === true);
            assert.equal(await page.title(), 'Jauría', 'opening the session consumes the alert');
            await row(page, 'foreground').click();
          }
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

/** Real application + real xterm, synthetic Tauri boundary only; no native app,
 * profiles, providers, or live runner. Since 1.4 there is no message rail: the
 * priority alert lives in the pane heading label, the top-bar bell (popover)
 * and the status bar; generic notices float. This proves none of them, nor the
 * session picker, ever moves the terminal host or sends a resize RPC.
 * (Original header:)
 * profiles, providers, or live runner. Run from desktop:
 * node --test tests/browser/notification-geometry.test.ts
 * Historical UI/CSS/main (served in memory; never replaces checkout files):
 * NOTIFICATION_GEOMETRY_BASELINE_REF=5431021 node --test tests/browser/notification-geometry.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const baselineRef = process.env.NOTIFICATION_GEOMETRY_BASELINE_REF;
const historical = new Map(baselineRef ? ['ui.ts', 'style.css', 'main.ts'].map(name => [name,
  execFileSync('git', ['show', `${baselineRef}:experiments/tauri-vertical/desktop/src/${name}`], { encoding: 'utf8' }),
]) : []);
const server = await createServer({
  configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'historical-notification-layout-in-memory', enforce: 'pre', load(id) {
    for (const [name, source] of historical) if (id.split('?')[0].endsWith(`/src/${name}`)) return source;
  } }],
});
await server.listen();
const url = server.resolvedUrls!.local[0];

async function installMock(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const session = { id: 'foreground', title: 'Codex PTY geometry fixture', kind: 'codex',
      transport: 'pty', status: 'running', cwd: '/synthetic/notification-geometry', rows: 24, cols: 80 };
    // Long title and folder: the heading truncates them and never grows.
    const other = { id: 'background', title: 'Background shell fixture with a very long synthetic title that must truncate inside the pane heading', kind: 'terminal',
      transport: 'pty', status: 'running', cwd: '/synthetic/' + 'a-very-long-folder-name/'.repeat(12) + 'other', rows: 24, cols: 80 };
    const closed = { id: 'history', title: 'Closed history fixture', kind: 'codex', transport: 'pty', status: 'exited', cwd: '/synthetic/history', rows: 24, cols: 80 };
    const events: any[] = [];
    const resizes: any[] = [];
    const inputs: any[] = [];
    const badges: any[] = [];
    const unexpected: string[] = [];
    let focused = true, holdReplay = false, interruptError = '', evidence: any;
    const status = () => structuredClone({ pid: 123, generation: 'synthetic-geometry',
      normalTerminalVersion: 1, sessions: [session, other, closed], lastSeq: events.length });
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    const output = (data: string, sessionId = session.id) => events.push({ seq: events.length + 1,
      sessionId, kind: 'output', data: btoa(data) });
    w.geometryFixture = {
      resizes, badges, unexpected, output, inputs,
      focus(value: boolean) { focused = value; },
      failInterrupt(value: string) { interruptError = value; },
      holdReplay(value: boolean) { holdReplay = value; },
      snapshot() { return { resizes: structuredClone(resizes), evidence: structuredClone(evidence) }; },
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      async invoke(cmd: string, args: any) {
        if (cmd === 'connect_runner') return { dataDir: '/synthetic', socket: '/synthetic.sock', status: status(), smoke: true };
        if (cmd === 'probe_tools') return [];
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'record_ui_evidence') { evidence = args.payload; return; }
        if (cmd === 'plugin:window|set_badge_count') { badges.push(args); return; }
        if (cmd === 'runner_request') {
          if (args.op === 'telemetry') return { ok: true, result: {} };
          if (args.op === 'status') return { ok: true, result: status() };
          if (args.op === 'events') return { ok: true, result: {
            events: holdReplay ? [] : events.filter(e => e.seq > args.args.after), lastSeq: events.length, hasMore: false,
          } };
          if (args.op === 'resize') {
            resizes.push(structuredClone(args.args));
            const target = args.args.id === other.id ? other : session;
            target.cols = args.args.cols; target.rows = args.args.rows;
            return { ok: true, result: { cols: target.cols, rows: target.rows } };
          }
          if (args.op === 'input') { inputs.push(structuredClone(args.args)); return { ok: true, result: {} }; }
          if (args.op === 'interrupt') return interruptError ? { ok: false, error: interruptError } : { ok: true, result: {} };
        }
        unexpected.push(`${cmd}:${args?.op ?? ''}`);
        throw new Error(`Unexpected synthetic RPC: ${cmd}:${args?.op ?? ''}`);
      },
      transformCallback() { return 1; }, unregisterCallback() {},
    };
  });
}

// Cover ResizeObserver's 80ms debounce, xterm writes, and the 500ms evidence
// cadence. This is observation time, with all production polling/fitting active.
async function settle(page: Page) { await page.waitForTimeout(850); }
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.terminal-host:has(.xterm)')!;
    const rect = host.getBoundingClientRect();
    const f = (window as any).geometryFixture.snapshot();
    const terminal = f.evidence?.sessions.find((s: any) => s.id === 'foreground');
    return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      cols: terminal?.cols, rows: terminal?.rows, resizeCount: f.resizes.length, resizes: f.resizes };
  });
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: notification geometry${baselineRef ? ` (layout ${baselineRef})` : ''}`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      try {
        for (const viewport of [{ width: 1220, height: 800 }, { width: 760, height: 640 }, { width: 760, height: 560 }]) {
          await t.test(`${viewport.width}x${viewport.height}: attention, pane state, popover, picker, notices and replay never resize PTY`, async () => {
            const page = await browser.newPage({ viewport });
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
              await installMock(page);
              await page.goto(url);
              await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
              await page.waitForFunction(() => (window as any).geometryFixture.resizes.length > 0);
              await page.evaluate(() => (window as any).geometryFixture.output(
                Array.from({ length: 160 }, (_, i) => `synthetic Codex output ${i}\r\n`).join('')));
              await page.waitForFunction(() => document.querySelector('#cursor')?.textContent?.includes(': 1'));
              await settle(page);
              assert.equal(await page.locator('#attention-banner').isVisible(), false);
              assert.equal(await page.locator('#notice').isVisible(), false);
              if (!baselineRef) {
                // Fixed chrome: 42 px top bar, 32 px pane heading, 28 px status bar.
                assert.equal(await page.locator('.workbench-header').evaluate(el => el.getBoundingClientRect().height), 42);
                assert.equal(await page.locator('.pane-heading').first().evaluate(el => el.getBoundingClientRect().height), 32);
                assert.equal(await page.locator('.status-bar').evaluate(el => el.getBoundingClientRect().height), 28);
                assert.equal(await page.locator('#workbench-messages').count(), 0, 'no message rail in the flow');
              }
              const before = await snapshot(page);
              assert.ok(before.cols > 2 && before.rows > 2, 'evidence reports actual fitted xterm dimensions');
              assert.deepEqual({ cols: before.cols, rows: before.rows }, {
                cols: before.resizes.at(-1).cols, rows: before.resizes.at(-1).rows,
              }, 'resize RPC carries the actual xterm dimensions');
              assert.ok(await page.locator('.xterm-viewport').evaluate(el =>
                Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2), 'terminal starts at live bottom');
              // Sample every frame as well as settled states, so a temporary
              // shrink/grow cannot hide behind a final equal bounding box.
              await page.evaluate(() => {
                const w = window as any; w.geometryFrames = []; w.geometrySampling = true;
                const sample = () => {
                  const r = document.querySelector('.terminal-host:has(.xterm)')!.getBoundingClientRect();
                  w.geometryFrames.push({ x: r.x, y: r.y, width: r.width, height: r.height });
                  if (w.geometrySampling) requestAnimationFrame(sample);
                }; sample();
              });
              const chrome = () => page.evaluate(() => ['.workbench-header', '.pane-heading', '.status-bar'].map(selector =>
                document.querySelector(selector)!.getBoundingClientRect().height));
              const chromeBefore = await chrome();
              const check = async (label: string) => {
                await settle(page);
                const after = await snapshot(page);
                assert.deepEqual(await chrome(), chromeBefore, `${label}: fixed top bar, pane heading and status bar`);
                t.diagnostic(JSON.stringify({ viewport, label, before, after }));
                assert.deepEqual(after.bounds, before.bounds, `${label}: terminal host bounds`);
                assert.equal(after.resizeCount, before.resizeCount, `${label}: no extra PTY resize RPC / SIGWINCH`);
                assert.deepEqual([after.cols, after.rows], [before.cols, before.rows], `${label}: actual xterm cols/rows`);
                const frames = await page.evaluate(() => (window as any).geometryFrames.splice(0));
                assert.ok(frames.length > 0, `${label}: observed rendered frames`);
                for (const frame of frames) assert.deepEqual(frame, before.bounds, `${label}: transient host bounds`);
              };
              // Running native Codex has already been listed and fitted. Ordinary
              // output (including OSC's BEL terminator) must stay quiet while away.
              await page.evaluate(() => (window as any).geometryFixture.focus(false));
              for (const data of [
                'ordinary native Codex output\r\n',
                '\r| working\x1b[K', '\r/ working\x1b[2K\x1b[1G',
                '\x1b]9;4;1;75\x07', '\x1b]9;4;0;0\x1b\\',
              ]) {
                const seq = await page.evaluate(data => {
                  const f = (window as any).geometryFixture; f.output(data.repeat(20));
                  return Number(document.querySelector('#cursor')?.textContent?.split(':').at(-1)) + 1;
                }, data);
                await page.waitForFunction(seq => Number(document.querySelector('#cursor')?.textContent?.split(':').at(-1)) >= seq, seq);
                await check('raw redraw/progress remains quiet');
                assert.equal(await page.locator('#attention-banner').isVisible(), false);
                assert.equal(await page.locator('#session-alerts').isVisible(), false);
                assert.equal(await page.locator('#attention-filter').isVisible(), false);
                assert.equal(await page.locator('#notice').isVisible(), false);
                assert.deepEqual(await page.evaluate(() => (window as any).geometryFixture.badges.filter((args: any) => args.value > 0)), [], 'no positive Dock writes');
              }
              // Each explicit protocol must still alert, recur after consumption,
              // and leave the fixed rail and PTY geometry unchanged.
              for (const data of ['\x07', '\x1b]9;explicit Codex notice\x07', '\x1b]777;notify;Codex;review needed\x1b\\']) {
                await page.evaluate(data => (window as any).geometryFixture.output(data), data);
                await page.waitForFunction(() => !(document.querySelector('#session-alerts') as HTMLElement).hidden);
                // The bell is the primary alert; it opens the popover. The status
                // bar counts the session; neither changes the terminal.
                await check('explicit notification before opening the popover');
                await page.evaluate(() => (document.querySelector('#session-alerts') as HTMLButtonElement).click());
                await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
                assert.equal(await page.locator('#session-alerts').isVisible(), true);
                assert.equal(await page.locator('#session-alerts').getAttribute('aria-expanded'), 'true');
                assert.match(await page.locator('#attention-announcer').textContent() ?? '', /Nuevo aviso/, 'polite live region announces it');
                await page.waitForFunction(() => (window as any).geometryFixture.badges.some((args: any) => args.value === 1));
                await check('explicit notification shown');
                await page.evaluate(() => { (window as any).geometryFixture.focus(true); window.dispatchEvent(new Event('focus')); });
                await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
                assert.equal(await page.locator('#session-alerts').isVisible(), false, 'view consumes explicit activity');
                await check('explicit notification consumed by viewing');
                await page.evaluate(() => (window as any).geometryFixture.focus(false));
              }
              const attention = async () => {
                await page.evaluate(() => { const f = (window as any).geometryFixture;
                  f.focus(false); f.output('foreground output while window unfocused\r\n\x07'); });
                await page.waitForFunction(() => !(document.querySelector('#session-alerts') as HTMLElement).hidden);
                if (await page.locator('#session-alerts').getAttribute('aria-expanded') !== 'true')
                  await page.evaluate(() => (document.querySelector('#session-alerts') as HTMLButtonElement).click());
                await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
              };
              await attention();
              await settle(page);
              const shown = await snapshot(page);
              t.diagnostic(JSON.stringify({ viewport, label: 'foreground output/BEL attention shown', before, after: shown }));
              await page.evaluate(() => { (window as any).geometryFixture.focus(true); window.dispatchEvent(new Event('focus')); });
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              await page.locator('.top-spacer').click();
              await check('window focus and blank header consume activity');
              assert.deepEqual(shown.bounds, before.bounds, 'attention shown: terminal host bounds');
              assert.equal(shown.resizeCount, before.resizeCount, 'attention shown: no extra resize RPC');
              assert.deepEqual([shown.cols, shown.rows], [before.cols, before.rows], 'attention shown: actual xterm cols/rows');
              await attention();
              // Popover open/close by keyboard and pointer, with an alert present.
              // First Escape from the expanded bell itself closes the popover.
              await page.locator('#session-alerts').focus();
              assert.equal(await page.locator('#session-alerts').getAttribute('aria-expanded'), 'true');
              await page.keyboard.press('Escape');
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              assert.equal(await page.locator('#session-alerts').getAttribute('aria-expanded'), 'false');
              assert.equal(await page.evaluate(() => document.activeElement?.id), 'session-alerts', 'focus stays on the bell');
              await check('alerts popover closed with Escape from the bell');
              // Escape from inside the popover closes it and returns focus to the bell.
              await page.locator('#session-alerts').click();
              await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
              await page.locator('#attention-banner').locator('button').first().focus();
              await page.keyboard.press('Escape');
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              assert.equal(await page.evaluate(() => document.activeElement?.id), 'session-alerts', 'Escape returns focus to the bell');
              await check('alerts popover closed with Escape inside');
              await page.locator('#session-alerts').click();
              await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
              await check('alerts popover reopened');
              await page.locator('#see-attention').click();
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              await check('mark seen hides attention');
              // Program states change the pane heading label and the status bar only.
              for (const state of ['working', 'blocked', 'done', 'idle', 'clear']) {
                await page.evaluate(state => (window as any).geometryFixture.output(`\x1b]7501;state=${state}\x07`), state);
                await page.waitForFunction(state => (document.querySelector('.pane-heading .session-state') as HTMLElement)?.textContent !== '' &&
                  (state === 'clear' || (document.querySelector('.pane-heading .pane-status .agent-indicator') as HTMLElement)?.dataset.state !== undefined), state);
                await check(`pane heading state ${state}`);
              }
              assert.equal(await page.locator('.pane-heading .session-state').first().evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
              await page.evaluate(() => (window as any).geometryFixture.output('\x1b]7501;state=blocked\x07'));
              await page.waitForFunction(() => document.querySelector('#status-needs-text')?.textContent === '1 te necesita');
              await check('status bar counts a session that needs you');
              await page.evaluate(() => (window as any).geometryFixture.output('\x1b]7501;state=clear\x07'));
              await page.waitForFunction(() => (document.querySelector('#status-needs') as HTMLElement).hidden);
              await check('status bar counter cleared');
              // The session picker floats over the pane; typing in its search never reaches the PTY.
              const inputsBefore = await page.evaluate(() => (window as any).geometryFixture.inputs.length);
              await page.locator('#session-0').click();
              await page.locator('.session-picker-search').first().waitFor();
              await page.keyboard.type('Background shell');
              await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
              await check('session picker open with a query');
              await page.keyboard.press('Escape');
              await page.waitForFunction(() => (document.querySelector('.session-picker') as HTMLElement).hidden);
              await check('session picker closed');
              assert.equal(await page.evaluate(() => (window as any).geometryFixture.inputs.length), inputsBefore, 'picker keys never reach the PTY');
              await page.evaluate(() => (window as any).geometryFixture.focus(true));
              await page.locator('[data-action="interrupt"]').first().click();
              await page.locator('#notice').waitFor({ state: 'visible' });
              assert.match(await page.locator('#notice-text').innerText(), /enviado/);
              await check('generic success notice shown');
              await attention();
              assert.equal(await page.locator('#notice').isVisible(), true, 'the floating notice and the popover coexist');
              await check('attention and generic notice coexist');
              await page.locator('#see-attention').click();
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              await page.locator('#dismiss-notice').click();
              await check('generic notice dismissed');
              const longError = 'Synthetic interrupt failure: ' + 'long/path-without-spaces/'.repeat(100);
              await page.evaluate(message => (window as any).geometryFixture.failInterrupt(message), longError);
              await page.locator('[data-action="interrupt"]').first().click();
              await page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('error'));
              assert.equal(await page.locator('#notice-text').textContent(), longError);
              assert.ok(await page.locator('#notice-text').evaluate(el => el.scrollHeight > el.clientHeight),
                'long error really wraps beyond the available notice height');
              await check('long wrapping error notice shown');
              await attention();
              assert.equal(await page.locator('#notice').isVisible(), true, 'the error stays visible beside the popover');
              await check('long error and attention coexist');
              await page.locator('#dismiss-notice').click();
              await check('error dismissed with attention retained');
              await page.locator('#session-alerts').click();
              if (await page.locator('#attention-banner').isHidden()) await page.locator('#session-alerts').click();
              await page.locator('#see-attention').click();
              await check('all messages dismissed');
              // Reconnect only the mock, retaining its fitted cols/rows. Hold
              // historical events to observe the real recovery notice, then
              // release replay and observe production clearing that notice.
              await page.evaluate(() => (window as any).geometryFixture.holdReplay(true));
              // The connection control lives in the closed narrow-window drawer.
              await page.evaluate(() => (document.querySelector('#connect') as HTMLButtonElement).click());
              await page.waitForFunction(() => document.querySelector('#notice-text')?.textContent?.startsWith('Conectado. Recuperando'));
              await page.locator('#notice').waitFor({ state: 'visible' });
              await check('history replay notice shown');
              await page.evaluate(() => (window as any).geometryFixture.holdReplay(false));
              await page.waitForFunction(() => (document.querySelector('#notice') as HTMLElement).hidden);
              await check('history replay completion hides notice');
              assert.equal(await page.locator('#attention-banner').isVisible(), false, 'historical output/BEL stays quiet');
              assert.equal(await page.locator('#connection-state').textContent(), 'Conectado', 'controlled error never disconnects');
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'long error does not widen page');
              assert.deepEqual(await page.evaluate(() => (window as any).geometryFixture.unexpected), []);
              assert.deepEqual(errors, []);
            } catch (error) { console.error(error); console.error(await page.evaluate(()=>({cursor:document.querySelector("#cursor")?.textContent,connection:document.querySelector("#connection-state")?.textContent,notice:document.querySelector("#notice-text")?.textContent,unexpected:(window as any).geometryFixture?.unexpected})),errors); throw error; }
            finally { await page.close(); }
          });
        }
        for (const viewport of [{ width: 1220, height: 800 }, { width: 760, height: 560 }]) {
          await t.test(`${viewport.width}x${viewport.height}: two panes, history pane, long names and picker choices keep both terminals`, async () => {
            const page = await browser.newPage({ viewport });
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
              await installMock(page);
              await page.goto(url);
              await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent === 'Conectado');
              await page.locator('#toggle-split').click();
              await page.waitForFunction(() => (window as any).geometryFixture.resizes.some((r: any) => r.id === 'background'));
              await settle(page);
              const rects = () => page.evaluate(() => [1, 2].map(n => { const r = document.querySelector(`.pane:nth-child(${n}) .terminal-host`)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
              const resizeCount = () => page.evaluate(() => (window as any).geometryFixture.resizes.length);
              const before = await rects(); const resizes = await resizeCount();
              assert.ok(before.every(r => r.width > 100 && r.height > 50), 'both panes laid out');
              assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.pane-heading')).map(h => h.getBoundingClientRect().height)), [32, 32], 'long names keep 32 px headings');
              const same = async (label: string) => {
                await settle(page);
                assert.deepEqual(await rects(), before, `${label}: both terminal hosts`);
                assert.equal(await resizeCount(), resizes, `${label}: no extra resize RPC`);
              };
              // (a) An alert and a blocked state in pane 2 do not move pane 1 (nor pane 2).
              await page.evaluate(() => { const f = (window as any).geometryFixture; f.focus(false); f.output('background bell\r\n\x07', 'background'); f.output('\x1b]7501;state=blocked\x07', 'background'); });
              await page.waitForFunction(() => !(document.querySelector('#session-alerts') as HTMLElement).hidden);
              await page.waitForFunction(() => document.querySelector('.pane:nth-child(2) .session-state')?.textContent === 'Solicita atención');
              await same('alert and blocked state in the second pane');
              await page.evaluate(() => (window as any).geometryFixture.focus(true));
              const choose = async (id: string) => {
                await page.locator('#session-1').click();
                await page.locator(`.pane:nth-child(2) .session-picker [role="option"][data-session-id="${id}"]`).click();
              };
              // (b, e) A closed session in pane 2 shows the read-only label; its host keeps its size.
              await choose('history');
              await page.locator('.pane:nth-child(2) .history-banner').waitFor({ state: 'visible' });
              await same('closed history session chosen in the picker');
              // (e) «Sin sesión» empties the pane; the host keeps its size.
              await choose('');
              await page.waitForFunction(() => document.querySelector('#session-1')?.getAttribute('data-session-id') === '');
              await same('Sin sesión chosen in the picker');
              await choose('background');
              await page.waitForFunction(() => document.querySelector('#session-1')?.getAttribute('data-session-id') === 'background');
              await same('live session chosen again');
              assert.deepEqual(errors, []);
            } finally { await page.close(); }
          });
        }
      } finally { await browser.close(); }
    });
  }
} finally { await server.close(); }

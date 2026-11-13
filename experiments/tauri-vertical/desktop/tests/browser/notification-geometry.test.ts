/** Real application + real xterm, synthetic Tauri boundary only; no native app,
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
  configFile: false, server: { host: '127.0.0.1', port: 0 },
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
    const events: any[] = [];
    const resizes: any[] = [];
    const badges: any[] = [];
    const unexpected: string[] = [];
    let focused = true, holdReplay = false, interruptError = '', evidence: any;
    const status = () => structuredClone({ pid: 123, generation: 'synthetic-geometry',
      normalTerminalVersion: 1, sessions: [session], lastSeq: events.length });
    Object.defineProperty(document, 'hasFocus', { value: () => focused });
    const output = (data: string) => events.push({ seq: events.length + 1,
      sessionId: session.id, kind: 'output', data: btoa(data) });
    w.geometryFixture = {
      resizes, badges, unexpected, output,
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
            session.cols = args.args.cols; session.rows = args.args.rows;
            return { ok: true, result: { cols: session.cols, rows: session.rows } };
          }
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
        for (const viewport of [{ width: 1220, height: 800 }, { width: 760, height: 640 }]) {
          await t.test(`${viewport.width}x${viewport.height}: attention, notices and replay never resize PTY`, async () => {
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
                assert.equal(await page.locator('#workbench-messages').evaluate(el => el.getBoundingClientRect().height), 50);
                assert.equal(await page.locator('#workbench-messages').getAttribute('data-active'), 'idle');
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
              const check = async (label: string) => {
                await settle(page);
                const after = await snapshot(page);
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
                assert.equal(await page.locator('#workbench-messages').getAttribute('data-active'), 'idle');
                assert.deepEqual(await page.evaluate(() => (window as any).geometryFixture.badges.filter((args: any) => args.value > 0)), [], 'no positive Dock writes');
              }
              // Each explicit protocol must still alert, recur after consumption,
              // and leave the fixed rail and PTY geometry unchanged.
              for (const data of ['\x07', '\x1b]9;explicit Codex notice\x07', '\x1b]777;notify;Codex;review needed\x1b\\']) {
                await page.evaluate(data => (window as any).geometryFixture.output(data), data);
                await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
                assert.equal(await page.locator('#session-alerts').isVisible(), true);
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
                await page.waitForFunction(() => !(document.querySelector('#attention-banner') as HTMLElement).hidden);
              };
              await attention();
              await settle(page);
              const shown = await snapshot(page);
              t.diagnostic(JSON.stringify({ viewport, label: 'foreground output/BEL attention shown', before, after: shown }));
              await page.evaluate(() => { (window as any).geometryFixture.focus(true); window.dispatchEvent(new Event('focus')); });
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              await page.locator('.workbench-heading').click();
              await check('window focus and blank header consume activity');
              assert.deepEqual(shown.bounds, before.bounds, 'attention shown: terminal host bounds');
              assert.equal(shown.resizeCount, before.resizeCount, 'attention shown: no extra resize RPC');
              assert.deepEqual([shown.cols, shown.rows], [before.cols, before.rows], 'attention shown: actual xterm cols/rows');
              await attention();
              await page.locator('#see-attention').click();
              await page.waitForFunction(() => (document.querySelector('#attention-banner') as HTMLElement).hidden);
              await check('mark seen hides attention');
              await page.evaluate(() => (window as any).geometryFixture.focus(true));
              await page.locator('[data-action="interrupt"]').first().click();
              await page.locator('#notice').waitFor({ state: 'visible' });
              assert.match(await page.locator('#notice-text').innerText(), /enviado/);
              await check('generic success notice shown');
              await attention();
              assert.equal(await page.locator('#workbench-messages').getAttribute('data-active'), 'attention', 'attention takes priority over generic notice');
              await check('attention and generic notice coexist');
              await page.locator('#see-attention').click();
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
              assert.equal(await page.locator('#workbench-messages').getAttribute('data-active'), 'notice', 'error takes priority over attention');
              await check('long error and attention coexist');
              await page.locator('#dismiss-notice').click();
              await check('error dismissed with attention retained');
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
            } catch (error) { console.error(error); throw error; }
            finally { await page.close(); }
          });
        }
      } finally { await browser.close(); }
    });
  }
} finally { await server.close(); }

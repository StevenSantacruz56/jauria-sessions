/** Real xterm 5.5 + Chrome/WebKit; no application, provider, or profile access.
 * Run: node --test tests/browser/terminal-anchor-overflow.test.ts
 * Historical helper only (served in memory, never written into the checkout):
 * TERMINAL_ANCHOR_BASELINE_REF=0c32 node --test tests/browser/terminal-anchor-overflow.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { chromium, webkit, type Page } from 'playwright';
import { createServer } from 'vite';

const baselineRef = process.env.TERMINAL_ANCHOR_BASELINE_REF;
const baseline = baselineRef ? execFileSync('git', [
  'show', `${baselineRef}:experiments/tauri-vertical/desktop/src/terminal-viewport.ts`,
], { encoding: 'utf8' }) : undefined;
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: baseline === undefined ? [] : [{
    name: 'historical-terminal-viewport-in-memory',
    enforce: 'pre',
    load(id) {
      if (id.split('?')[0].endsWith('/src/terminal-viewport.ts')) return baseline;
    },
  }],
});
await server.listen();
const url = server.resolvedUrls!.local[0] + 'tests/fixtures/terminal-scroll.html';
const run = (page: Page, expression: string) => page.evaluate(
  source => Function(`return (${source})(window.fixture)`)(), expression,
);
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function seed(page: Page, blocks: number) {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).fixture);
  await run(page, `async f => {
    f.resize(800, 350);
    // One logical line spanning thousands of rows. Each token is unique and
    // survives row-boundary changes, unlike an assertion on numeric viewportY.
    await f.write(Array.from({ length: ${blocks} }, (_, i) =>
      '[' + String(i).padStart(6, '0') + ']xxxxxxxx').join('') + '\\r\\n');
    await f.write(Array.from({ length: 200 }, (_, i) => 'tail-' + i + '\\r\\n').join(''));
    f.term.scrollToLine(f.term.buffer.active.baseY - 1200);
  }`);
  await settle(page);
  await run(page, 'f => f.term.scrollToLine(f.term.buffer.active.baseY - 1200)');
  await settle(page);
  const state = await run(page, 'f => f.state()');
  assert.equal(state.base, 8000, 'exercise the actual configured scrollback limit');
  assert.ok(state.y > 0 && state.y < state.base, 'reader is above the live output');
  assert.match(state.top, /\[\d{6}\]/, 'reader is inside the long wrapped line');
  return state;
}

try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: bounded wrapped-line anchor${baselineRef ? ` (helper ${baselineRef})` : ''}`, async t => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      try {
        for (const blocks of [42000, 50000]) {
          await t.test(`${blocks} blocks: shrink retains reading content without forcing row zero`, async () => {
            const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
            try {
              const before = await seed(page, blocks);
              const result = await run(page, `async f => {
                const token = f.state().top.match(/\\[\\d{6}\\]/)[0];
                f.resize(450, 350);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const b = f.term.buffer.active;
                const retained = Array.from({ length: b.length }, (_, i) =>
                  b.getLine(i).translateToString(false)).join('').includes(token);
                return { token, retained, after: f.state(), oldestIsWrapped: b.getLine(0).isWrapped };
              }`);
              t.diagnostic(JSON.stringify({ blocks, before, ...result }));
              assert.ok(result.after.cols < before.cols, 'fit really shrank the columns');
              assert.ok(result.oldestIsWrapped, 'bounded reflow trimmed the logical-line start');
              assert.ok(result.retained, `reading fragment ${result.token} survived trimming`);
              // xterm may choose a different retained row during overflow. The
              // regression is the helper overriding that choice with row zero.
              assert.ok(result.after.y > 0, 'retained reading fragment must not trigger scrollToTop');
              assert.ok(result.after.y < result.after.base, 'reader remains above live output');
              await run(page, 'f => f.resize(800, 350)');
              await settle(page);
              const expanded = await run(page, 'f => f.state()');
              t.diagnostic(JSON.stringify({ blocks, expanded }));
              assert.equal(expanded.cols, before.cols);
              assert.ok(expanded.y > 0, 'expansion must not force the oldest row');
              // WebKit can deliver a native scroll event after expansion that
              // follows the bottom. Re-establish a reader before testing no-op
              // fits; the regression here is the artificial jump to row zero.
              await run(page, 'f => f.term.scrollToLine(Math.floor(f.term.buffer.active.baseY * 0.75))');
              await settle(page);
              const beforeUnchanged = await run(page, 'f => f.state()');
              assert.ok(beforeUnchanged.y > 0 && beforeUnchanged.y < beforeUnchanged.base);
              await run(page, 'f => { for (let i = 0; i < 12; i++) f.resize(800, 350); }');
              await settle(page);
              const unchanged = await run(page, 'f => f.state()');
              assert.equal(unchanged.y, beforeUnchanged.y, 'unchanged fits do not move the reader');
              assert.equal(unchanged.top, beforeUnchanged.top, 'unchanged fits preserve the visible fragment');
            } finally { await page.close(); }
          });
        }
        await t.test('output/no-op fits preserve reading; concurrent keyboard/paste captures exact bytes', async () => {
          const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
          try {
            await seed(page, 50000);
            // Output causes real bounded-buffer trimming while browser input is
            // delivered through xterm's textarea and the fixture's OrderedInput.
            // First verify output alone: xterm intentionally follows user input.
            const outputOnly = await run(page, `async f => {
              const initial = f.state();
              const samples = [];
              for (let i = 0; i < 24; i++) {
                await f.write('background-' + i + '\\r\\n');
                f.resize(800, 350);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                samples.push(f.state());
              }
              return { initial, samples };
            }`);
            for (const sample of outputOnly.samples) {
              assert.ok(sample.y > 0 && sample.y < sample.base, 'output/fit must not jump to either end');
              assert.equal(sample.top, outputOnly.initial.top, 'bounded output preserves the reading fragment');
            }
            await page.locator('.xterm-helper-textarea').focus();
            const output = run(page, `async f => {
              const initial = f.state();
              const samples = [];
              for (let i = 0; i < 24; i++) {
                await f.write('continuous-' + i + '\\r\\n');
                f.resize(800, 350);
                samples.push(f.state());
                await new Promise(resolve => setTimeout(resolve, 5));
              }
              return { initial, samples };
            }`);
            const typed = 'reader-input-123';
            const paste = 'paste acción 🙂\n'.repeat(30);
            const input = (async () => {
              await page.keyboard.type(typed);
              await run(page, `f => f.term.paste(${JSON.stringify(paste)})`);
            })();
            const [observed] = await Promise.all([output, input]);
            await page.waitForFunction(expected => (window as any).fixture.received.join('') === expected,
              typed + paste.replace(/\n/g, '\r'));
            assert.equal(observed.samples.length, 24, 'output completed during input capture');
            assert.equal(await run(page, 'f => f.received.join("")'), typed + paste.replace(/\n/g, '\r'));
          } finally { await page.close(); }
        });
      } finally { await browser.close(); }
    });
  }
} finally { await server.close(); }

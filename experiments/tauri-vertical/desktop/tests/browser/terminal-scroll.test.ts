/** Real xterm DOM + wheel tests. Playwright WebKit is not Tauri WKWebView. */
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, configFile: false });
await server.listen();
const url = server.resolvedUrls!.local[0] + 'tests/fixtures/terminal-scroll.html';
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
      await page.goto(url); await page.waitForFunction(() => (window as any).fixture);
      const run = (fn: string) => page.evaluate(expression => Function(`return (${expression})(window.fixture)`)(), fn);
      const state = () => run('f => f.state()');
      // The viewport syncs on the engine's own frames; a loaded CI runner can take longer than a fixed
      // pause, so the scroll checks wait for the condition instead of sampling once.
      const until = async (holds: (s: any) => boolean, message: string) => {
        const deadline = Date.now() + 5000;
        for (;;) {
          const current = await state();
          if (holds(current)) return current;
          if (Date.now() > deadline) assert.fail(`${engine.name()}: ${message}: ${JSON.stringify({ scroll: current.scroll, y: current.y, base: current.base })}`);
          await page.waitForTimeout(50);
        }
      };
      // Reproduce the actual regression first: output parsed while unselected,
      // attach with no geometry change, wheel upwards over the terminal center.
      await run('async f => { f.host.remove(); await f.fill(); }');
      await page.waitForTimeout(100);
      await run('f => f.attach("first", false)'); await page.waitForTimeout(100);
      // The baseline only shows the bug this guards against. Whether an unsynced viewport stays at 0 is
      // the engine's timing, not the product: when the engine syncs it by itself (a loaded CI runner),
      // the baseline is noted and skipped; every assertion on the fixed path below still runs.
      const reproduced = (await state()).scroll === 0;
      const originalY = (await state()).y;
      await page.locator('.xterm').hover();
      // The engine can also sync between that sample and the wheel, so the baseline never fails the run:
      // it is reported either way, and the wheel is undone before the fixed path is checked.
      let inert = false;
      if (reproduced) {
        await page.mouse.wheel(0, -160); await page.waitForTimeout(100);
        inert = (await state()).y === originalY;
        if (!inert) { await run('f => f.term.scrollToBottom()'); await page.waitForTimeout(100); }
      }
      if (!inert) console.log(`${engine.name()}: baseline not reproduced (viewport synced by the engine); fixed path still checked`);
      await run('f => f.attach("first")'); await page.waitForTimeout(100);
      await until(s => s.scroll > 0, 'viewport syncs after attachment');
      await page.mouse.wheel(0, -160);
      await until(s => s.y < originalY, 'upward wheel works after attachment sync');
      const reading = await state();
      await run('f => f.write("incoming while reading\\r\\n")'); await page.waitForTimeout(100);
      assert.equal((await state()).top, reading.top, 'output does not pull reader to bottom');
      await run('f => f.resize(800, 350)'); await page.waitForTimeout(100);
      assert.equal((await state()).top, reading.top, 'height resize retains reading row');
      await run('f => f.term.scrollToLine(100)'); await page.waitForTimeout(50);
      // Pick a logical-line boundary to verify column reflow, not numeric ydisp.
      await run('f => { while(f.term.buffer.active.getLine(f.term.buffer.active.viewportY).isWrapped) f.term.scrollToLine(f.term.buffer.active.viewportY-1); }');
      const beforeWidth = await state();
      await run('f => f.resize(450, 350)'); await page.waitForTimeout(100);
      assert.equal((await state()).top.slice(0, 4), beforeWidth.top.slice(0, 4));
      await run('f => f.resize(800, 350)'); await page.waitForTimeout(100);
      assert.equal((await state()).top, beforeWidth.top, 'width round trip keeps logical line');
      await run('f => f.attach("second")'); await page.waitForTimeout(100);
      assert.equal((await state()).top, beforeWidth.top); await until(s => s.scroll > 0, 'viewport syncs after reparent');
      await page.locator('.xterm').hover(); const y = (await state()).y;
      await page.mouse.wheel(0, 100);
      await until(s => s.y > y, 'wheel down works after reparent');
      await run('f => f.term.scrollToBottom()');
      await run('f => f.write("following\\r\\n")'); await page.waitForTimeout(100);
      assert.equal((await state()).y, (await state()).base);
      // Preserve xterm alt-screen wheel routing instead of swallowing gestures.
      await run('f => f.write("\\x1b[?1049h")'); await page.waitForTimeout(100);
      await page.mouse.wheel(0, -100); await page.waitForTimeout(100);
      assert.ok((await run('f => f.received.join("")')).includes('\x1b[A'));
      await run('f => f.write("\\x1b[?1049l")');
      const baseline = await run('f => f.measureEcho(false)');
      const fixed = await run('f => f.measureEcho(true)');
      const median = (xs: number[]) => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
      assert.ok(baseline.exact && fixed.exact, 'typing/paste echo preserves exact bytes');
      assert.ok(median(fixed.latencies) < median(baseline.latencies) / 2);
      console.log(`${engine.name()}: scroll/resize/reparent/output/alt-wheel PASS; synthetic echo median ${median(baseline.latencies).toFixed(1)} -> ${median(fixed.latencies).toFixed(1)} ms`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }

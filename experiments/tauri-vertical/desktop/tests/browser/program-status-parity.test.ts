/**
 * The shared PTY vectors (runner/src/agent_signals.rs) against the xterm
 * installed in node_modules, running in Chromium and WebKit, through the
 * client's own handlers. A mismatch is a runner finding: never edit a vector.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const url = new URL('tests/fixtures/program-status-parity.html', server.resolvedUrls!.local[0]).href;
try {
  for (const engine of [chromium, webkit]) {
    await test(`${engine.name()}: shared vectors match the real xterm`, { timeout: 300000 }, async () => {
      const browser = await engine.launch(engine === chromium ? { channel: 'chrome' } : {});
      try {
        const page = await browser.newPage();
        const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(url);
        await page.waitForFunction(() => (window as any).parityReady === true);
        const failures = await page.evaluate(() => (window as any).parity());
        assert.deepEqual(failures, {});
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
} finally { await server.close(); }

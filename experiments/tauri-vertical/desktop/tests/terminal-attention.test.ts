import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { attachTerminalAttention } from '../src/terminal-attention.ts';
const require = createRequire(import.meta.url);
Object.assign(globalThis, { self: globalThis });
const { Terminal } = require('@xterm/xterm');
test('installed xterm public parser handles fragmented BEL/OSC notifications, rejects progress/text, disposes', async () => {
  const term = new Terminal(); let signals = 0;
  const subscription = attachTerminalAttention(term, () => signals++);
  const write = (s: string) => new Promise<void>(resolve => term.write(s, resolve));
  await write('waiting for permission? turn complete'); assert.equal(signals, 0);
  await write('\x07'); assert.equal(signals, 1);
  await write('\x1b]9;explicit'); assert.equal(signals, 1);
  await write(' notice\x07'); assert.equal(signals, 2); // OSC terminator is not a second BEL.
  await write('\x1b]777;notify;title;body\x1b\\'); assert.equal(signals, 3);
  await write('\x1b]9;4;1;75\x07\x1b]777;other;body\x07'); assert.equal(signals, 3);
  subscription.dispose(); await write('\x07\x1b]9;notice\x07'); assert.equal(signals, 3);
  term.dispose();
});

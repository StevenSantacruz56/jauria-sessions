import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { parseProgramStatus, ProgramStatusTracker } from '../src/program-status.ts';
import type { ProgramState } from '../src/program-status.ts';
const require = createRequire(import.meta.url);
Object.assign(globalThis, { self: globalThis });
const { Terminal } = require('@xterm/xterm');

test('parser accepts each root state and ignores other fields without decoding them', () => {
  for (const s of ['working', 'blocked', 'error', 'done', 'idle', 'clear'] as const) assert.equal(parseProgramStatus(`state=${s}`), s);
  assert.equal(parseProgramStatus('title=<script>:state=blocked:msg=aGk=:app=claude:progress=50:x-future=a=b=c'), 'blocked');
  assert.equal(parseProgramStatus('msg=not%base64!!:state=done:title='), 'done');
  assert.equal(parseProgramStatus('state=done:title=lobo 🐺 ñandú'), 'done');
  assert.equal(parseProgramStatus('STATUS=x:state=idle'), 'idle'); // unknown key, ignored
});

test('parser rejects missing, unknown, mis-cased or duplicate state', () => {
  for (const bad of ['title=x', 'state=', 'state=Working', 'state=WORKING', 'state= done', 'state=done ', 'state=approved',
    'state=done=x', 'State=done', 'STATE=done:state=done', 'state=done:state=done', 'state=working:state=done'])
    assert.equal(parseProgramStatus(bad), null, bad);
});

test('parser rejects child records carrying any id, even empty', () => {
  for (const bad of ['id=:state=done', 'state=done:id=', 'id=abc:state=blocked', 'state=error:ID=1', 'Id=2:state=idle'])
    assert.equal(parseProgramStatus(bad), null, bad);
});

test('parser rejects queries', () => {
  for (const bad of ['?', 'state=?', 'state=working:?', '?state=working', 'state=done:title=?', 'state=done:q?=1'])
    assert.equal(parseProgramStatus(bad), null, bad);
});

test('parser rejects control characters and unpaired surrogates', () => {
  for (const ch of ['\x00', '\x07', '\x1b', '\t', '\n', '\r', '\x7f', '\x85', '\x9b', '\ud800', '\udc00'])
    assert.equal(parseProgramStatus(`state=done:title=a${ch}b`), null, JSON.stringify(ch));
  assert.equal(parseProgramStatus('state=done\x1b\\'), null);
});

test('parser rejects malformed and empty fields', () => {
  for (const bad of ['', ':', 'state=done:', ':state=done', 'state=done::title=x', 'state=done:flag', '=x:state=done', 'state'])
    assert.equal(parseProgramStatus(bad), null, JSON.stringify(bad));
  assert.equal(parseProgramStatus(undefined as unknown as string), null);
  assert.equal(parseProgramStatus(42 as unknown as string), null);
});

test('parser enforces the 1024-byte UTF-8 budget, not just string length', () => {
  const head = 'state=done:title='; // 17 bytes
  assert.equal(parseProgramStatus(head + 'a'.repeat(1007)), 'done'); // exactly 1024
  assert.equal(parseProgramStatus(head + 'a'.repeat(1008)), null);
  assert.equal(parseProgramStatus(head + 'é'.repeat(503)), 'done'); // 1023 bytes, 520 code units
  assert.equal(parseProgramStatus(head + 'é'.repeat(504)), null); // 1025 bytes, 521 code units
  assert.equal(parseProgramStatus(head + '🐺'.repeat(252)), null); // 1025 bytes, 521 code units
  assert.equal(parseProgramStatus('x'.repeat(100_000)), null);
});

test('fragmented OSC 7501 is reassembled by xterm before reaching the parser', async () => {
  const term = new Terminal(); const seen: (ProgramState | null)[] = [];
  const handler = term.parser.registerOscHandler(7501, (data: string) => { seen.push(parseProgramStatus(data)); return true; });
  const write = (s: string) => new Promise<void>(resolve => term.write(s, resolve));
  await write('\x1b]7501;sta'); assert.deepEqual(seen, []);
  await write('te=block'); await write('ed:title=hi\x07'); assert.deepEqual(seen, ['blocked']);
  await write('\x1b]7501;id=1:state=done\x1b\\\x1b]7501;state=?\x07'); assert.deepEqual(seen, ['blocked', null, null]);
  handler.dispose(); term.dispose();
});

test('tracker raises attention only on entering alert or finishing work while unattended', () => {
  const t = new ProgramStatusTracker();
  const step = (state: ProgramState) => t.set('a', state, false);
  assert.deepEqual(step('working'), { changed: true, attention: false });
  assert.deepEqual(step('working'), { changed: false, attention: false });
  assert.deepEqual(step('blocked'), { changed: true, attention: true });
  assert.deepEqual(step('blocked'), { changed: false, attention: false });
  assert.deepEqual(step('error'), { changed: true, attention: false }); // alert to alert
  assert.deepEqual(step('working'), { changed: true, attention: false });
  assert.deepEqual(step('done'), { changed: true, attention: true });
  assert.deepEqual(step('done'), { changed: false, attention: false }); // no repeated alarm
  assert.deepEqual(step('idle'), { changed: true, attention: false });
  assert.deepEqual(step('done'), { changed: true, attention: false }); // idle -> done is not finished work
  assert.deepEqual(step('error'), { changed: true, attention: true });
  assert.deepEqual(step('done'), { changed: true, attention: true }); // done after error
  assert.equal(t.get('a'), 'done');

  const fresh = new ProgramStatusTracker();
  assert.deepEqual(fresh.set('b', 'blocked', false), { changed: true, attention: true });
  assert.deepEqual(fresh.set('c', 'error', false), { changed: true, attention: true });
  assert.deepEqual(fresh.set('d', 'done', false), { changed: true, attention: false });
  assert.equal(fresh.get('b'), 'blocked'); assert.equal(fresh.get('d'), 'done'); // ids are independent
});

test('attended sessions keep state for display but never alert', () => {
  const t = new ProgramStatusTracker();
  t.set('a', 'working', true);
  assert.deepEqual(t.set('a', 'blocked', true), { changed: true, attention: false });
  assert.equal(t.get('a'), 'blocked');
  assert.deepEqual(t.set('a', 'blocked', false), { changed: false, attention: false }); // unchanged, no late alarm
  t.set('a', 'working', true);
  assert.deepEqual(t.set('a', 'done', true), { changed: true, attention: false });
});

test('working to idle is a finished turn until viewed, even after a later idle report', () => {
  const t = new ProgramStatusTracker();
  t.set('a', 'working', false);
  const started = t.changedAt('a');
  assert.deepEqual(t.set('a', 'working', false), { changed: false, attention: false });
  assert.equal(t.changedAt('a'), started, 'repeated progress does not reset elapsed time');
  assert.deepEqual(t.set('a', 'idle', false), { changed: true, attention: true });
  assert.equal(t.get('a'), 'idle');
  assert.equal(t.display('a'), 'done');
  assert.equal(t.finishedUnseen('a'), true);
  t.set('a', 'done', false);
  t.set('a', 'idle', false);
  assert.equal(t.display('a'), 'done');
  assert.equal(t.markSeen('a'), true);
  assert.equal(t.display('a'), 'idle');
  assert.equal(t.markSeen('a'), false);
  t.set('a', 'done', false);
  assert.equal(t.display('a'), 'idle', 'a repeated done without new work is already seen');
});

test('blocked is a persistent reported state and new work clears a finished turn', () => {
  const t = new ProgramStatusTracker();
  t.set('a', 'working', false);
  assert.deepEqual(t.set('a', 'blocked', true), { changed: true, attention: false });
  assert.equal(t.display('a'), 'blocked', 'attended does not hide the state');
  assert.deepEqual(t.set('a', 'blocked', false), { changed: false, attention: false });
  t.set('a', 'done', false);
  assert.equal(t.display('a'), 'done');
  t.set('a', 'working', false);
  assert.equal(t.display('a'), 'working');
  assert.equal(t.finishedUnseen('a'), false);
});

test('tracker clear removes state; clear and reset are idempotent', () => {
  const t = new ProgramStatusTracker();
  t.set('a', 'blocked', false); t.set('b', 'working', false);
  assert.deepEqual(t.set('a', 'clear', false), { changed: true, attention: false });
  assert.equal(t.get('a'), null);
  assert.deepEqual(t.set('a', 'clear', false), { changed: false, attention: false });
  assert.deepEqual(t.set('a', 'blocked', false), { changed: true, attention: true }); // fresh after clear
  assert.equal(t.clear('a'), true); assert.equal(t.clear('a'), false);
  assert.equal(t.get('b'), 'working');
  t.reset(); assert.equal(t.get('b'), null); t.reset();
  assert.deepEqual(t.set('x', 'bogus' as ProgramState, false), { changed: false, attention: false });
  assert.equal(t.get('x'), null);
});

test('tracker is bounded and evicts the least recently reported id', () => {
  const t = new ProgramStatusTracker(3);
  for (const id of ['a', 'b', 'c', 'd']) t.set(id, 'working', false);
  assert.equal(t.get('a'), null);
  t.set('b', 'working', false); // repeat report refreshes recency
  t.set('e', 'idle', false);
  assert.equal(t.get('c'), null);
  assert.equal(t.get('b'), 'working'); assert.equal(t.get('d'), 'working'); assert.equal(t.get('e'), 'idle');

  const big = new ProgramStatusTracker();
  for (let i = 0; i < 600; i++) big.set(`s${i}`, 'working', false);
  assert.equal(big.get('s87'), null); assert.equal(big.get('s88'), 'working'); assert.equal(big.get('s599'), 'working');

  for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) assert.throws(() => new ProgramStatusTracker(bad), RangeError);
});

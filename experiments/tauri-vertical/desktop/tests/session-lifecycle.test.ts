/** Session lifecycle (1.4.0): categories, labels, recovery and the dismissed view metadata. Synthetic values only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CLOSED, category, categoryLabel, continuation, dismissedKey, dismissedLimit, interruptionDetail, isClosed, lifecycleIncident, lifecycleLabel, orderRecent, readDismissed, saveDismissed, withDismissed } from '../src/session-lifecycle.ts';

test('every runner state has one of four categories; unknown states are Sin confirmar', () => {
  const expected: Record<string, string> = {
    starting: 'open', running: 'open', needs_attention: 'unconfirmed', interrupted: 'interrupted', failed: 'interrupted', released: 'interrupted',
    exited: 'ended', stopped: 'ended', '': 'unconfirmed', future_status: 'unconfirmed', recuperando: 'unconfirmed', constructor: 'unconfirmed', __proto__: 'unconfirmed',
  };
  for (const [status, value] of Object.entries(expected)) assert.equal(category(status), value, status);
  // Dismissed or continued: an interrupted one is Terminada; nothing else changes.
  for (const status of ['interrupted', 'failed', 'released']) assert.equal(category(status, true), 'ended');
  for (const status of ['running', 'needs_attention', 'exited']) assert.equal(category(status, true), category(status));
});

test('labels: four words, «Abriendo» while it starts, and the reason of an interruption', () => {
  assert.deepEqual((['open', 'unconfirmed', 'interrupted', 'ended'] as const).map(categoryLabel), ['Abierta', 'Sin confirmar — ocupa plaza', 'Interrumpida', 'Terminada']);
  const labels: Record<string, string> = { starting: 'Abriendo', running: 'Abierta', exited: 'Terminada', stopped: 'Terminada', released: 'Interrumpida', failed: 'Interrumpida', interrupted: 'Interrumpida', needs_attention: 'Sin confirmar — ocupa plaza', odd: 'Sin confirmar — ocupa plaza' };
  for (const [status, label] of Object.entries(labels)) assert.equal(lifecycleLabel(status), label, status);
  assert.equal(interruptionDetail('interrupted'), 'El runner se reinició y el proceso ya no existe');
  assert.equal(interruptionDetail('failed'), 'No llegó a iniciarse');
  assert.match(interruptionDetail('released'), /plaza/);
  assert.equal(interruptionDetail('exited'), '');
});

test('closed states free the slot; lifecycle incidents exclude the person’s own Liberar plaza', () => {
  assert.deepEqual([...CLOSED], ['exited', 'stopped', 'failed', 'interrupted', 'released']);
  assert.throws(() => (CLOSED as string[]).push('x'));
  for (const status of ['starting', 'running', 'needs_attention', 'odd']) assert.equal(isClosed(status), false);
  assert.deepEqual(['needs_attention', 'failed', 'interrupted', 'odd', 'released', 'exited', 'stopped', 'running', 'starting'].filter(lifecycleIncident), ['needs_attention', 'failed', 'interrupted', 'odd']);
});

test('one recovery rule per provider (plan C.4)', () => {
  const caps = { nativeResume: true };
  const claude = { kind: 'claude', status: 'interrupted', pid: 42 };
  assert.equal(continuation(claude, caps).action, 'continue', 'Claude with a PID: continue (the runner checks the identity)');
  assert.equal(continuation(claude, caps, 'present').action, 'continue');
  assert.deepEqual(continuation(claude, caps, 'none'), { action: 'restart', note: 'No se registró la identidad de la conversación.' });
  assert.deepEqual(continuation({ kind: 'claude', status: 'interrupted' }, caps), { action: 'restart', note: 'No llegó a iniciarse.' }, 'no PID: never started');
  assert.equal(continuation({ ...claude, status: 'failed' }, caps).action, 'restart');
  assert.match(continuation(claude, { nativeResume: false }).note, /runner/);
  assert.equal(continuation(claude, { nativeResume: false }).action, 'restart', 'runner 1.3.x without native resume');
  assert.deepEqual(continuation({ kind: 'codex', status: 'interrupted', pid: 1 }, caps), { action: 'restart', note: 'Codex en terminal no permite continuar la conversación.' });
  assert.equal(continuation({ kind: 'codex', status: 'interrupted', transport: 'app-server', codex: { nativeThreadId: 't' } }, caps).action, 'continue', 'structured Codex with a thread');
  assert.equal(continuation({ kind: 'codex', status: 'interrupted', transport: 'app-server', codex: { nativeThreadId: null } }, caps).action, 'restart');
  assert.equal(continuation({ kind: 'terminal', status: 'interrupted', pid: 3 }, caps).action, 'restart');
  assert.equal(continuation({ kind: 'terminal', status: 'failed' }, caps).note, 'No llegó a iniciarse.');
});

test('most recent first: reverses the runner order without touching the input', () => {
  const input = Object.freeze(['a', 'b', 'c']);
  assert.deepEqual(orderRecent(input), ['c', 'b', 'a']);
  assert.deepEqual(input, ['a', 'b', 'c']);
  assert.deepEqual(orderRecent([]), []);
});

const memory = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; };

test('dismissed sessions: per profile key, schemaVersion 1, round trip and continuedAs', () => {
  assert.equal(dismissedKey('/profile'), 'jauria:session-dismissed:/profile');
  assert.equal(dismissedKey(null), null); assert.equal(dismissedKey('x'.repeat(4097)), null);
  const storage = memory();
  let value = withDismissed(new Map(), 'a'); value = withDismissed(value, 'b', 'b2'); value = withDismissed(value, 'a');
  saveDismissed(storage, '/profile', value);
  assert.deepEqual(JSON.parse(storage.data.get('jauria:session-dismissed:/profile')!), { schemaVersion: 1, sessions: [['b', 'b2'], ['a', null]] });
  assert.deepEqual([...readDismissed(storage, '/profile')], [['b', 'b2'], ['a', null]]);
  assert.equal(readDismissed(storage, '/other').size, 0, 'another profile sees nothing');
  saveDismissed(storage, null, value); assert.equal(storage.data.size, 1, 'no key without a profile');
});

test('dismissed sessions: bounded to the most recent entries and validated field by field', () => {
  let value = new Map<string, string | null>();
  for (let i = 0; i < dismissedLimit + 50; i++) value = withDismissed(value, `s${i}`);
  assert.equal(value.size, dismissedLimit);
  assert.equal(value.has('s0'), false); assert.equal(value.has(`s${dismissedLimit + 49}`), true);
  const storage = memory();
  const put = (raw: unknown) => storage.data.set('jauria:session-dismissed:/p', typeof raw === 'string' ? raw : JSON.stringify(raw));
  for (const raw of ['{', 'null', '[]', { schemaVersion: 2, sessions: [['a', null]] }, { schemaVersion: 1 }, { schemaVersion: 1, sessions: 'a' }]) { put(raw); assert.equal(readDismissed(storage, '/p').size, 0, JSON.stringify(raw)); }
  put({ schemaVersion: 1, sessions: [['ok', null], ['', null], [7, null], ['ctl\u0007', null], ['x'.repeat(257), null], ['n', 5], ['m', 'next'], ['short'], 'str', null] });
  assert.deepEqual([...readDismissed(storage, '/p')], [['ok', null], ['m', 'next']]);
  put({ schemaVersion: 1, sessions: Array.from({ length: dismissedLimit + 10 }, (_, i) => [`s${i}`, null]) });
  assert.equal(readDismissed(storage, '/p').size, dismissedLimit);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readDismissed(throwing, '/p').size, 0);
  assert.doesNotThrow(() => saveDismissed(throwing, '/p', value));
});

test('no other client source keeps its own list of closed runner states', async () => {
  const files = ['session-picker.ts', 'top-bar.ts', 'workspace.ts', 'main.ts', 'pulso-panel.ts', 'attention.ts', 'command-palette.ts', 'app-commands.ts', 'agent-list.ts'];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\[\s*'exited'\s*,\s*'stopped'/, `${file} duplicates the closed list`);
    assert.doesNotMatch(source, /\[\s*'exited'\s*,\s*'stopped'\s*,\s*'released'/, file);
    assert.doesNotMatch(source, /\['needs_attention',\s*'failed',\s*'interrupted'\]/, file);
  }
});

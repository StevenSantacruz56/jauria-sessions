import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DockBadge, dockUnreadCount } from '../src/dock-badge.ts';

const item = (id: string, overrides = {}) => ({ id, reason: 'private', keys: ['one', 'two'], unseen: true, stale: false, ...overrides });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('counts unique confirmed unseen sessions, independent of reason/request count', () => {
  assert.equal(dockUnreadCount([item('a'), item('a'), item('b'), item('c', { stale: true }), item('d', { unseen: false })]), 2);
  assert.equal(dockUnreadCount([]), 0);
});

test('startup clears, identical refreshes deduplicate, zero removes native badge', async () => {
  const calls: (number | undefined)[] = [];
  const badge = new DockBadge(async count => { calls.push(count); });
  badge.setCount(0); await tick();
  for (let i = 0; i < 1000; i++) badge.setCount(24);
  await tick();
  badge.setCount(0); await tick();
  assert.deepEqual(calls, [undefined, 24, undefined]);
});

test('serializes slow native writes and coalesces intermediate stale counts', async () => {
  const gate = deferred(); const calls: (number | undefined)[] = [];
  let active = 0, maximum = 0;
  const badge = new DockBadge(async count => {
    calls.push(count); maximum = Math.max(maximum, ++active);
    if (calls.length === 1) await gate.promise;
    active--;
  });
  badge.setCount(24); badge.setCount(7); badge.setCount(2); badge.setCount(0);
  assert.deepEqual(calls, [24]);
  gate.resolve(); await tick();
  assert.deepEqual(calls, [24, undefined]); assert.equal(maximum, 1);
});

test('failure does not hot-loop; latest clear follows failed in-flight update', async () => {
  const gate = deferred(); const calls: (number | undefined)[] = [];
  const badge = new DockBadge(async count => { calls.push(count); if (calls.length === 1) await gate.promise; });
  badge.setCount(24); badge.setCount(0); gate.reject(Error('native failure'));
  await tick(); assert.deepEqual(calls, [24, undefined]);
  const failed: (number | undefined)[] = [];
  const unavailable = new DockBadge(async count => { failed.push(count); throw Error('unavailable'); });
  unavailable.setCount(3); await tick();
  for (let i = 0; i < 1000; i++) unavailable.setCount(3);
  await tick(); assert.deepEqual(failed, [3]);
  unavailable.setCount(0); await tick(); assert.deepEqual(failed, [3, undefined]);
  await unavailable.dispose(); assert.deepEqual(failed, [3, undefined, undefined]);
});

test('disposal fences future counts and clears after stale in-flight success or failure', async () => {
  for (const fails of [false, true]) {
    const gate = deferred(); const calls: (number | undefined)[] = [];
    const badge = new DockBadge(async count => { calls.push(count); if (calls.length === 1) await gate.promise; });
    badge.setCount(24); badge.setCount(9);
    const done = badge.dispose(); badge.setCount(99);
    if (fails) gate.reject(Error('failure')); else gate.resolve();
    await done; await badge.dispose();
    assert.deepEqual(calls, [24, undefined]);
  }
});

test('a count arriving during a deduplicated drain is not lost', async () => {
  const gate = deferred(); const calls: (number | undefined)[] = [];
  const badge = new DockBadge(async count => { calls.push(count); if (calls.length === 2) await gate.promise; });
  badge.setCount(1); await tick();
  badge.setCount(2); badge.setCount(1); badge.setCount(2);
  gate.resolve();
  // Run after the drain, before its finally handler releases the worker.
  queueMicrotask(() => { badge.setCount(3); });
  await tick(); assert.deepEqual(calls, [1, 2, 3]);
});

test('viewing/marking seen clears unread without approving permissions or resolving incidents', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'jauria-dock-'));
  try {
    const output = join(temporary, 'attention.mjs');
    await build({ entryPoints: ['src/attention.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
    const { SessionAttention } = await import(pathToFileURL(output).href);
    const attention = new SessionAttention();
    const sessions = [{ id: 's', title: 'private', kind: 'codex', status: 'running', transport: 'app-server', codex: { generation: 1 } }];
    attention.list(sessions);
    let requests = 0;
    const poll = (count: number) => attention.poll(sessions, async (op: string) => {
      assert.equal(op, 'codex_state'); requests++;
      return { sessionId: 's', generation: 1, pendingRequestCount: count, requests: count ? [{ id: `p${count}`, generation: 1, status: 'pending' }] : [] };
    }, () => true);
    await poll(0); await poll(24); sessions[0].status = 'needs_attention';
    attention.signal('s', 'output');
    assert.equal(dockUnreadCount(attention.list(sessions)), 1);
    attention.see(attention.list(sessions));
    const remaining = attention.list(sessions);
    assert.equal(dockUnreadCount(remaining), 0);
    assert.match(remaining[0].reason, /24 permisos pendientes/);
    assert.equal(sessions[0].status, 'needs_attention'); assert.equal(requests, 2);
    attention.signal('s', 'bell'); assert.equal(dockUnreadCount(attention.list(sessions)), 1);
    attention.consumeActivity('s'); assert.equal(dockUnreadCount(attention.list(sessions)), 0);
    await poll(25); attention.invalidate(); assert.equal(dockUnreadCount(attention.list(sessions)), 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

// Exercise the attention-to-Dock boundary, rather than assuming an empty input.
test('raw native Codex redraw signals never increment Dock; explicit alert does and viewing clears it', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'jauria-dock-raw-'));
  try {
    const output = join(temporary, 'attention.mjs');
    await build({ entryPoints: ['src/attention.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
    const { SessionAttention } = await import(pathToFileURL(output).href);
    const attention = new SessionAttention();
    const sessions = [{ id: 'codex', title: 'Codex', kind: 'codex', status: 'running', transport: 'pty' }];
    const calls: (number | undefined)[] = [];
    const badge = new DockBadge(async count => { calls.push(count); });
    badge.setCount(dockUnreadCount(attention.list(sessions))); await tick();
    for (let i = 0; i < 500; i++) {
      attention.signal('codex', 'output');
      badge.setCount(dockUnreadCount(attention.list(sessions)));
    }
    await tick(); assert.deepEqual(calls, [undefined]);
    attention.signal('codex', 'bell');
    badge.setCount(dockUnreadCount(attention.list(sessions))); await tick();
    assert.deepEqual(calls, [undefined, 1]);
    attention.consumeActivity('codex');
    badge.setCount(dockUnreadCount(attention.list(sessions))); await tick();
    assert.deepEqual(calls, [undefined, 1, undefined]);
    await badge.dispose();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

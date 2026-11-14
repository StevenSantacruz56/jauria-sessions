import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const temporary = await mkdtemp(join(tmpdir(), 'jauria-attention-'));
const output = join(temporary, 'attention.mjs');
await build({ entryPoints: ['src/attention.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { SessionAttention } = await import(pathToFileURL(output).href);
const session = (id = 'claude', status = 'running', transport = 'pty', generation = 1) => ({ id, title: id, kind: 'claude', status, transport, cwd: null, rows: 24, cols: 80, codex: { generation } });
const summary = (id: string, count = 1, generation = 1, requestId = 'p1') => ({ sessionId: id, generation, pendingRequestCount: count, requests: count ? [{ id: requestId, generation, status: 'pending' }] : [] });
try {
  test('initial lifecycle is quiet, state changes recur, seen does not resolve custody', () => {
    const a = new SessionAttention(); const sessions = [session('claude', 'needs_attention')];
    assert.equal(a.list(sessions)[0].unseen, false);
    sessions[0].status = 'failed'; assert.equal(a.list(sessions)[0].unseen, true);
    a.see(a.list(sessions)); assert.equal(a.list(sessions)[0].unseen, false);
    sessions[0].status = 'running'; assert.deepEqual(a.list(sessions), []);
    sessions[0].status = 'failed'; assert.equal(a.list(sessions)[0].unseen, true);
    assert.equal(a.list([session('unknown', 'future')]).length, 1);
  });
  test('old seen failure plus background process end is two listed sessions but only one new alert', () => {
    const a=new SessionAttention();
    const sessions=[session('old-failure','failed'),session('recent-end')];
    const baseline=a.list(sessions);
    assert.equal(baseline.length,1);assert.equal(baseline[0].unseen,false);
    a.observeEnd('recent-end','running','stopped');sessions[1].status='stopped';
    const current=a.list(sessions);
    assert.equal(current.length,2);
    assert.equal(current.filter((item:{unseen:boolean;stale:boolean})=>item.unseen&&!item.stale).length,1);
    assert.match(current.find((item:{id:string})=>item.id==='recent-end').reason,/El proceso terminó/);
    a.see(current.filter((item:{id:string})=>item.id==='recent-end'));
    const seen=a.list(sessions);
    assert.equal(seen.length,1);assert.equal(seen[0].id,'old-failure');assert.equal(seen[0].unseen,false);
    assert.equal(sessions[0].status,'failed','viewing never repairs or releases a failed session');
    assert.equal(sessions[1].status,'stopped','acknowledgement never restarts a process');
    a.observeEnd('recent-end','running','stopped');
    assert.equal(a.list(sessions).length,1,'duplicate delivery must not recreate a consumed end alert');
  });
  test('primed running native Codex ignores repeated raw output without storing activity', () => {
    const a = new SessionAttention();
    const sessions = [{ ...session('codex'), kind: 'codex' }];
    assert.deepEqual(a.list(sessions), []);
    for (let i = 0; i < 500; i++) {
      a.signal('codex', 'output');
      assert.deepEqual(a.list(sessions), [], `redraw ${i} cannot become an alert`);
    }
    assert.equal(a.consumeActivity('codex'), false, 'ignored output leaves nothing to consume');
  });
  test('explicit signals coalesce per session; viewing consumes activity and allows recurrence', () => {
    const a = new SessionAttention(); const sessions = [session()]; a.list(sessions);
    for (let i = 0; i < 500; i++) {
      a.signal('claude', 'output'); a.signal('claude', 'bell'); a.signal('claude', 'notification');
    }
    const items = a.list(sessions); assert.equal(items.length, 1); assert.equal(items[0].keys.length, 2); assert.equal(items[0].unseen, true);
    assert.match(items[0].reason, /alerta/); assert.doesNotMatch(items[0].reason, /Salida nueva sin ver/); assert.doesNotMatch(items[0].reason, /permiso|turno/);
    a.see(items); assert.deepEqual(a.list(sessions), []);
    a.signal('claude', 'output'); assert.deepEqual(a.list(sessions), []);
    a.signal('claude', 'notification'); assert.equal(a.list(sessions)[0].unseen, true);
  });
  test('focus consumes only activity; custody and permissions cannot be cleared by viewing output', async () => {
    const a = new SessionAttention(); const sessions = [session('s', 'needs_attention', 'app-server')]; a.list(sessions);
    await a.poll(sessions, async () => summary('s'), () => true); a.list(sessions);
    a.signal('s', 'output'); a.signal('s', 'bell'); a.signal('s', 'notification'); assert.equal(a.list(sessions)[0].keys.length, 4);
    assert.equal(a.consumeActivity('s'), true);
    const remaining = a.list(sessions); assert.equal(remaining.length, 1); assert.equal(remaining[0].keys.length, 2);
    assert.match(remaining[0].reason, /custodia/); assert.match(remaining[0].reason, /permiso pendiente/);
    assert.equal(a.consumeActivity('s'), false);
  });
  test('only live-to-terminal process transition emits end; duplicates do not re-alert', () => {
    const a = new SessionAttention(); const sessions = [session()]; a.list(sessions);
    a.observeEnd('claude', 'running', 'exited'); sessions[0].status = 'exited';
    assert.match(a.list(sessions)[0].reason, /El proceso terminó/);
    a.see(a.list(sessions)); a.observeEnd('claude', 'running', 'exited'); assert.deepEqual(a.list(sessions), []);
    a.observeEnd('claude', 'running', 'interrupted'); assert.deepEqual(a.list(sessions), []);
  });
  test('all app-server sessions queried, baseline quiet, truncated counts honored, failures preserve', async () => {
    const a = new SessionAttention(); const sessions = [session('visible', 'running', 'app-server'), session('hidden', 'running', 'app-server'), session()]; a.list(sessions);
    const queried: string[] = [];
    await a.poll(sessions, async (_: string, args: {id:string}) => { queried.push(args.id); return summary(args.id); }, () => true);
    assert.deepEqual(queried.sort(), ['hidden', 'visible']); assert.equal(a.list(sessions).every((x: {unseen:boolean}) => !x.unseen), true);
    await a.poll(sessions, async (_: string, args: {id:string}) => summary(args.id, 400, 1, 'p2'), () => true);
    assert.equal(a.list(sessions)[0].unseen, true); assert.match(a.list(sessions)[0].reason, /400 permisos/);
    await a.poll(sessions, async () => { throw Error(); }, () => true);
    assert.equal(a.list(sessions).length, 2); assert.equal(a.list(sessions)[0].stale, true);
    a.see(a.list(sessions)); assert.equal(a.list(sessions).length, 2);
    await a.poll(sessions, async (_: string, args: {id:string}) => summary(args.id, 0), () => true); assert.deepEqual(a.list(sessions), []);
  });
  test('generation identity, malformed reads and reconnect fences cannot falsely clear permissions', async () => {
    const a = new SessionAttention(); const sessions = [session('s', 'running', 'app-server')]; a.list(sessions);
    await a.poll(sessions, async () => summary('s'), () => true); a.list(sessions);
    await a.poll(sessions, async () => summary('wrong', 0), () => true); assert.equal(a.list(sessions)[0].stale, true);
    await a.poll(sessions, async () => summary('s', 0), () => false); assert.equal(a.list(sessions).length, 1);
    sessions[0].codex.generation = 2; assert.match(a.list(sessions)[0].reason, /caducado/);
    await a.poll(sessions, async () => summary('s', 1, 2), () => true);
    assert.equal(a.list(sessions)[0].stale, false); assert.equal(a.list(sessions)[0].unseen, false);
    await a.poll(sessions, async () => ({...summary('s', 0, 2), pendingRequestCount: -1}), () => true); assert.equal(a.list(sessions).length, 1);
  });
  test('permission workers cap at two, skip finished history and fence queued reads', async () => {
    const a = new SessionAttention(); const sessions = [...Array.from({length:20}, (_,i) => session(`s${i}`, 'running', 'app-server')), session('history', 'exited', 'app-server')]; a.list(sessions);
    let inflight = 0, maximum = 0, calls = 0, current = true;
    await a.poll(sessions, async (_: string, args: {id:string}) => {
      calls++; inflight++; maximum = Math.max(maximum, inflight);
      await new Promise(r => setTimeout(r, 1)); inflight--;
      assert.notEqual(args.id, 'history'); return summary(args.id, 0);
    }, () => current);
    assert.equal(maximum, 2); assert.equal(calls, 20);
    calls = 0;
    await a.poll(sessions, async (_: string, args: {id:string}) => { calls++; current = false; return summary(args.id); }, () => current);
    assert.equal(calls, 1); assert.deepEqual(a.list(sessions), []);
  });
} finally { await rm(temporary, { recursive: true, force: true }); }

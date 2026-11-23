/** Runner 1.4 E attention source: agent → activity, mark_seen rules, native baseline, hasMore. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'jauria-attention-source-'));
const output = join(temporary, 'attention-source.mjs');
await build({ entryPoints: ['src/attention-source.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { RunnerAttentionSource, WindowAttentionSource, SessionAttention, parseAgent } = await import(pathToFileURL(output).href);
after(() => rm(temporary, { recursive: true, force: true }));

type Any = any;
const session = (id = 's1', status = 'running', extra: Any = {}) => ({ id, title: id, kind: 'claude', status, transport: 'pty', cwd: null, rows: 24, cols: 80, ...extra });
const agent = (over: Any = {}) => ({ epoch: 77, state: null, changedAt: 1000, stateFrame: null, turnOpen: false, turnStartedAt: null, turnEndedAt: null,
  lastTurnMs: null, turnInterrupted: false, alertSeq: 0, seenSeq: 0, finishedUnseen: false, pending: {}, ...over });
const status = (sessions: Any[], over: Any = {}) => ({ generation: 'g1', sessions, agentAttention: { hasMore: false, pendingSessions: 0, pendingAlerts: 0, durable: true, maxAgents: 128, ...over } });

function harness(options: Any = {}) {
  const calls: Any[] = [];
  const env = { canMark: true, consumed: 0 as number | null, attended: 's1', fail: false, respond: null as null | ((items: Any[]) => Any), later: [] as (() => void)[] };
  let changes = 0;
  const source = new RunnerAttentionSource(new SessionAttention(), {
    async request(op: string, args: Any) {
      calls.push(structuredClone(args));
      if (env.fail) throw new Error('offline');
      return env.respond ? env.respond(args.items) : { items: args.items.map((i: Any) => ({ id: i.id, agent: agent({ epoch: i.epoch, alertSeq: i.through, seenSeq: i.through }) })), durable: true };
    },
    canMark: () => env.canMark, consumedFrame: () => env.consumed, isAttended: (id: string) => id === env.attended,
    changed: () => { changes++; }, later: (run: () => void) => { env.later.push(run); },
    ...options,
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { source, calls, env, settle, changes: () => changes };
}

{
  test('agent maps to activity, indicator and duration; never working without state=working', () => {
    const { source } = harness();
    const now = 10 * 60_000 + 5000;
    source.ingestStatus(status([{ id: 's1', agent: agent({ state: 'working', turnOpen: true, turnStartedAt: 5000, changedAt: 9 * 60_000 }) },
      { id: 'idle', agent: agent({ state: 'idle', lastTurnMs: 125_000 }) },
      { id: 'quiet', agent: agent({ state: null, turnOpen: true }) },
      { id: 'blocked', agent: agent({ state: 'error', alertSeq: 1, pending: { needs: { seq: 1, frame: 3 } } }) },
      { id: 'codex', agent: agent({ state: null }) }]));
    source.paint([]);
    const a = (id: string) => source.activity(session(id), source.list([session(id)])[0], now);
    assert.deepEqual([a('s1').kind, a('s1').label, a('s1').detail], ['working', 'Trabajando', 'Desde hace 10 min']);
    assert.equal(source.since('s1'), 5000, 'duration anchors at the runner turn start, not the last state change');
    assert.deepEqual([a('idle').kind, a('idle').detail], ['idle', 'Último turno: 2 min']);
    assert.equal(a('quiet').kind, 'unreported', 'an open turn without state=working is not working');
    assert.equal(a('codex').kind, 'unreported');
    assert.deepEqual([a('blocked').kind, a('blocked').label], ['needs', 'Error del agente']);
    assert.equal(source.display('blocked'), 'error');
    assert.equal(source.display('quiet'), null);
  });

  test('finished stays visible (and counted) while the agent works again', () => {
    const { source } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ state: 'working', turnOpen: true, turnStartedAt: 0, alertSeq: 2, finishedUnseen: true, pending: { finished: { seq: 2, frame: 9 } } }) }]));
    source.paint([]);
    const [item] = source.list([session()]);
    assert.equal(item.unseen, true);
    assert.match(item.reason, /terminó su turno/);
    const activity = source.activity(session(), item, 60_000);
    assert.deepEqual([activity.kind, activity.label], ['finished', 'Turno terminado']);
    assert.match(activity.detail, /Trabaja de nuevo/);
    assert.equal(source.display('s1'), 'working', 'the heading word still says working');
  });

  test('a frame alert is marked only after its frame is consumed, attended, outside replay; through/epoch are the painted ones', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 3, seenSeq: 1, pending: { bell: { seq: 3, frame: 12 } } }) }]));
    env.consumed = 11; source.paint(['s1']); await settle();
    assert.deepEqual(calls, [], 'frame 12 not consumed yet');
    env.consumed = 12; env.canMark = false; source.paint(['s1']); await settle();
    assert.deepEqual(calls, [], 'replay / !liveReady / offline never marks');
    env.canMark = true; env.attended = 'other'; source.paint(['s1']); await settle();
    assert.deepEqual(calls, [], 'not attended');
    env.attended = 's1';
    // A newer record arrives after painting: the mark must use the painted one.
    source.paint(['s1']); await settle();
    assert.deepEqual(calls, [{ items: [{ id: 's1', epoch: 77, through: 3 }] }]);
    source.paint(['s1']); await settle();
    assert.equal(calls.length, 1, 'nothing new to mark: no second call');
  });

  test('an unconsumed frame caps through below that alert', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 5, pending: { notify: { seq: 2, frame: 4 }, finished: { seq: 5, frame: 20 } } }) }]));
    env.consumed = 10; source.paint(['s1']); await settle();
    assert.deepEqual(calls, [{ items: [{ id: 's1', epoch: 77, through: 4 }] }]);
  });

  test('frame:null (ended, permission, previous generation) only by explicit action, with the painted values', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', status: 'exited', agent: agent({ alertSeq: 2, pending: { ended: { seq: 2 }, needs: { seq: 1, frame: null } } }) }]));
    env.consumed = 999; source.paint(['s1']); await settle();
    assert.deepEqual(calls, []);
    source.ingest('s1', agent({ alertSeq: 4, pending: { ended: { seq: 2 }, needs: { seq: 1, frame: null }, bell: { seq: 4, frame: 50 } } }));
    source.select('s1', [session('s1', 'exited')]); await settle();
    assert.deepEqual(calls, [{ items: [{ id: 's1', epoch: 77, through: 2 }] }], 'through is the painted alertSeq, never the newer 4');
    assert.equal(source.list([session('s1', 'exited')]).length, 0, 'local seen holds while the runner confirms');
  });

  test('explicit marks wait for canMark (replay) instead of being dropped', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }]));
    source.paint([]); env.canMark = false;
    source.markAll([session()]); await settle();
    assert.deepEqual(calls, []);
    env.canMark = true; source.paint([]); await settle();
    assert.equal(calls.length, 1);
  });

  test('a new runner generation discards cursors and pending marks', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }]));
    source.paint([]); env.canMark = false; source.select('s1', [session()]);
    source.ingestStatus({ ...status([{ id: 's1', agent: agent({ epoch: 78, alertSeq: 1, pending: { ended: { seq: 1 } } }) }]), generation: 'g2' });
    env.canMark = true; source.paint([]); await settle();
    assert.deepEqual(calls, [], 'the old through is never sent');
  });

  test('rejected epoch resynchronises with the returned agent and never retries the old through', async () => {
    const { source, calls, env, settle, changes } = harness();
    env.respond = items => ({ items: items.map((i: Any) => ({ id: i.id, rejected: 'epoch', agent: agent({ epoch: 99, alertSeq: 1, pending: { ended: { seq: 1 } } }) })), durable: true });
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 4, pending: { ended: { seq: 4 } } }) }]));
    source.paint([]); source.select('s1', [session()]); await settle();
    assert.equal(calls.length, 1); assert.ok(changes() > 0);
    source.paint([]); await settle();
    assert.equal(calls.length, 1, 'no retry with the stale through');
    const [item] = source.list([session()]);
    assert.equal(item.unseen, true, 'the new incarnation alert is shown unseen');
    assert.ok(item.keys.some((k: string) => k.includes(':99:1')));
  });

  test('durable:false keeps the seen without a visible error', async () => {
    const { source, env, settle } = harness();
    env.respond = items => ({ items: items.map((i: Any) => ({ id: i.id, agent: agent({ alertSeq: i.through, seenSeq: i.through }) })), durable: false });
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }]));
    source.paint([]); source.select('s1', [session()]); await settle();
    assert.equal(source.volatileSeen, true);
    source.paint([]);
    assert.deepEqual(source.list([session()]), []);
  });

  test('more than 64 marks are batched 64 per call', async () => {
    const { source, calls, settle } = harness();
    const ids = Array.from({ length: 70 }, (_, i) => `s${i}`);
    source.ingestStatus(status(ids.map(id => ({ id, agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }))));
    source.paint([]); source.markAll(ids.map(id => session(id))); await settle(); await settle();
    assert.deepEqual(calls.map(c => c.items.length), [64, 6]);
  });

  test('a network failure keeps local seen and retries later', async () => {
    const { source, calls, env, settle } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }]));
    source.paint([]); env.fail = true; source.select('s1', [session()]); await settle();
    assert.equal(calls.length, 1); assert.deepEqual(source.list([session()]), [], 'still seen locally');
    env.fail = false; env.later.shift()!(); await settle();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  });

  test('native notices: alerts pending at connection are listed but not new; later sequences are; reconnect rebaselines', () => {
    const { source } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 2, pending: { finished: { seq: 2, frame: 1 } } }) }], { pendingSessions: 1, pendingAlerts: 1 }));
    source.paint([]);
    let items = source.list([session()]);
    assert.equal(items[0].unseen, true, 'counts for bell and Dock from the first render');
    assert.equal(source.nativeItems(items)[0].unseen, false, 'no macOS notice for what was already pending');
    source.ingest('s1', agent({ alertSeq: 3, pending: { finished: { seq: 2, frame: 1 }, bell: { seq: 3, frame: 2 } } }));
    source.paint([]); items = source.list([session()]);
    assert.equal(source.nativeItems(items)[0].unseen, true);
    source.reset();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 3, pending: { finished: { seq: 2, frame: 1 }, bell: { seq: 3, frame: 2 } } }) }]));
    source.paint([]);
    assert.equal(source.nativeItems(source.list([session()]))[0].unseen, false, 'reconnecting never repeats');
  });

  test('hasMore: totals from pendingSessions, the list is not presented as complete', () => {
    const { source } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }, { id: 's2' }],
      { hasMore: true, pendingSessions: 5, pendingAlerts: 9 }));
    source.paint([]);
    assert.equal(source.hiddenUnseen(), 4);
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { ended: { seq: 1 } } }) }], { hasMore: false, pendingSessions: 1 }));
    source.paint([]);
    assert.equal(source.hiddenUnseen(), 0);
  });

  test('pending.permission is "arrived and not seen", not a pending permission', () => {
    const { source } = harness();
    source.ingestStatus(status([{ id: 's1', agent: agent({ alertSeq: 1, pending: { permission: { seq: 1, requestId: 'r', generation: 1 } } }) }]));
    source.paint([]);
    const s = session('s1', 'running', { transport: 'app-server', codex: { generation: 2 } });
    const [item] = source.list([s]);
    assert.match(item.reason, /Solicitud de permiso sin ver · generación anterior, caducado/);
    assert.equal(source.activity(s, item).kind, 'notice', 'without codex_state it never claims a pending permission');
  });

  test('stale snapshots never lower sequences; parseAgent rejects malformed records', () => {
    const { source } = harness();
    source.ingest('s1', agent({ alertSeq: 3, seenSeq: 2, changedAt: 5 }));
    assert.equal(source.ingest('s1', agent({ alertSeq: 2, seenSeq: 2, changedAt: 6 })), false);
    assert.equal(parseAgent({ epoch: 0, alertSeq: 0, seenSeq: 0 }), undefined);
    assert.equal(parseAgent({ epoch: 1, alertSeq: 1, seenSeq: 2 }), undefined);
    assert.equal(parseAgent({ epoch: 1, alertSeq: 1, seenSeq: 0, state: 'thinking' }), undefined);
    assert.equal(parseAgent(null), null);
  });

  test('window source keeps the 1.3 behaviour: client parser, window-local seen', () => {
    const base = new SessionAttention();
    const w = new WindowAttentionSource(base);
    assert.equal(w.mode, 'window');
    w.list(w.sessions([session()]));
    assert.equal(w.program('s1', 'state=working', false), true);
    assert.equal(w.program('s1', 'state=done', false), true);
    const items = w.list(w.sessions([session()]));
    assert.equal(items[0].unseen, true);
    assert.equal(w.activity(w.sessions([session()])[0], items[0]).kind, 'finished');
    w.select('s1', w.sessions([session()]));
    assert.deepEqual(w.list(w.sessions([session()])), []);
    assert.equal(w.program('s1', 'title=x', false), false);
  });
}

/** Synthetic sessions, projects and storage only; never reads a user profile. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActivityKind } from '../src/session-activity.ts';

// Bundle like the other module tests: the sources use extensionless imports.
const temporary = await mkdtemp(join(tmpdir(), 'jauria-agent-list-'));
const entry = join(temporary, 'entry.ts');
await writeFile(entry, `export * from ${JSON.stringify(new URL('../src/agent-list.ts', import.meta.url).pathname)};\nexport { sessionActivity } from ${JSON.stringify(new URL('../src/session-activity.ts', import.meta.url).pathname)};\n`);
const output = join(temporary, 'agent-list.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { agentGroupingKey, agentIndicator, compactDuration, groupAgents, projectSessionIndex, readAgentGrouping, saveAgentGrouping, sortAgents, sessionActivity } = await import(pathToFileURL(output).href);
after(() => rm(temporary, { recursive: true, force: true }));

const session = (id: string, status = 'running') => ({ id, title: id, kind: 'claude', status, cwd: null, rows: 24, cols: 80 });

test('the spinner requires an explicit working report; an open process alone never spins', () => {
  const open = sessionActivity(session('open'), undefined, null);
  assert.equal(open.kind, 'unreported');
  assert.deepEqual(agentIndicator(open.kind), { shape: 'ring', tone: 'unreported' });
  const working = sessionActivity(session('busy'), undefined, 'working', 0, 120000);
  assert.deepEqual(agentIndicator(working.kind), { shape: 'spinner', tone: 'working' });
  for (const kind of ['needs', 'notice', 'finished', 'idle', 'unreported'] as ActivityKind[]) assert.notEqual(agentIndicator(kind).shape, 'spinner', kind);
});

test('indicator shapes do not depend on colour alone', () => {
  // Working, needs you, finished, waiting and no report each get a distinct shape.
  const shapes = (['working', 'needs', 'finished', 'idle', 'unreported'] as ActivityKind[]).map(kind => agentIndicator(kind).shape);
  assert.deepEqual(shapes, ['spinner', 'halo', 'check', 'dash', 'ring']);
  assert.equal(new Set(shapes).size, 5);
  assert.equal(agentIndicator('notice').shape, agentIndicator('needs').shape, 'a notice is action-needed too');
  // Every state keeps a textual label from sessionActivity for title/aria text.
  for (const program of ['working', 'idle', 'blocked', null] as const) assert.ok(sessionActivity(session('x'), undefined, program).label.length > 0);
});

test('agents sort by action, notice, unseen finish, working, waiting, no report, stably', () => {
  const kinds: Record<string, ActivityKind> = { a: 'unreported', b: 'working', c: 'finished', d: 'needs', e: 'idle', f: 'notice', g: 'working' };
  assert.deepEqual(sortAgents(Object.keys(kinds).map(id => session(id)), id => kinds[id]).map(s => s.id), ['d', 'f', 'c', 'b', 'g', 'e', 'a']);
});

test('main session wins over links, first project keeps a shared session, unknown projects are ignored', () => {
  const projects = [{ id: 'p1', title: 'Uno', mainSessionId: 'main1' }, { id: 'p2', title: 'Dos', mainSessionId: 'shared' }];
  const index = projectSessionIndex(projects, [
    { projectId: 'p2', sessionId: 'linked2' }, { projectId: 'p1', sessionId: 'shared' }, { projectId: 'p1', sessionId: 'linked1' },
    { projectId: 'p2', sessionId: 'linked1' }, { projectId: 'gone', sessionId: 'orphan' }, { sessionId: 'item-only' },
  ]);
  assert.deepEqual(Object.fromEntries(index), { main1: 'p1', shared: 'p2', linked1: 'p1', linked2: 'p2' });
});

test('project grouping keeps project order, sorts inside each group and ends with Sin proyecto', () => {
  const kinds: Record<string, ActivityKind> = { main1: 'working', linked1: 'needs', linked2: 'finished', loose: 'unreported', loose2: 'needs' };
  const projects = [{ id: 'p1', title: 'Uno', mainSessionId: 'main1' }, { id: 'p2', title: 'Dos', mainSessionId: null }, { id: 'p3', title: 'Vacío', mainSessionId: null }];
  const index = projectSessionIndex(projects, [{ projectId: 'p1', sessionId: 'linked1' }, { projectId: 'p2', sessionId: 'linked2' }]);
  const groups = groupAgents(['loose', 'main1', 'linked2', 'linked1', 'loose2'].map(id => session(id)), 'project', id => kinds[id], projects, index);
  assert.deepEqual(groups.map(g => [g.key, g.name, g.sessions.map(s => s.id)]), [
    ['project:p1', 'Uno', ['linked1', 'main1']], ['project:p2', 'Dos', ['linked2']], ['project:none', 'Sin proyecto', ['loose2', 'loose']],
  ]);
  assert.equal(groups.every(group => group.kind === null), true);
});

test('without Pulso data every agent is listed under Sin proyecto', () => {
  const groups = groupAgents([session('a'), session('b')], 'project', () => 'unreported');
  assert.deepEqual(groups.map(g => [g.name, g.sessions.length]), [['Sin proyecto', 2]]);
});

test('state grouping reuses the activity sections in their priority order', () => {
  const kinds: Record<string, ActivityKind> = { a: 'idle', b: 'working', c: 'needs', d: 'unreported', e: 'notice', f: 'finished' };
  const groups = groupAgents(Object.keys(kinds).map(id => session(id)), 'state', id => kinds[id]);
  assert.deepEqual(groups.map(g => [g.kind, g.name]), [
    ['needs', 'Necesitan tu acción'], ['notice', 'Avisos'], ['finished', 'Terminaron'], ['working', 'En curso'], ['idle', 'En espera'], ['unreported', 'Sin estado del agente'],
  ]);
});

test('durations are coarse and absent without an observed state change', () => {
  assert.equal(compactDuration(null, 1000), '');
  assert.equal(compactDuration(0, 59_000), '<1 min');
  assert.equal(compactDuration(0, 14 * 60_000), '14 min');
  assert.equal(compactDuration(0, 125 * 60_000), '2 h');
  assert.equal(compactDuration(10_000, 0), '<1 min');
});

test('grouping preference is per profile, versioned and defaults to Por proyecto', () => {
  const values = new Map<string, string>(); const writes: string[] = [];
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem(key: string, value: string) { values.set(key, value); writes.push(key); } };
  assert.equal(agentGroupingKey(null), null); assert.equal(agentGroupingKey(''), null);
  assert.equal(readAgentGrouping(storage, 'synthetic-a'), 'project');
  saveAgentGrouping(storage, 'synthetic-a', 'state'); saveAgentGrouping(storage, null, 'state');
  assert.deepEqual(writes, ['jauria:agent-grouping:synthetic-a']);
  assert.equal(readAgentGrouping(storage, 'synthetic-a'), 'state'); assert.equal(readAgentGrouping(storage, 'synthetic-b'), 'project');
  for (const value of ['{', '[]', '{"schemaVersion":2,"grouping":"state"}', '{"schemaVersion":1,"grouping":"folder"}']) {
    values.set('jauria:agent-grouping:synthetic-a', value); assert.equal(readAgentGrouping(storage, 'synthetic-a'), 'project', value);
  }
  const broken = { getItem() { throw Error('synthetic denied'); }, setItem() { throw Error('synthetic quota'); } };
  assert.equal(readAgentGrouping(broken, 'synthetic-a'), 'project'); assert.doesNotThrow(() => saveAgentGrouping(broken, 'synthetic-a', 'state'));
});

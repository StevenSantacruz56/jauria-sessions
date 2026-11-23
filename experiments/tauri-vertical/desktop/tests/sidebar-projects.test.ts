/** Synthetic Pulso boundary only; no runner, profile or SQLite. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SidebarProjects, projectProgressLabel } from '../src/sidebar-projects.ts';

function fixture() {
  const state = {
    revision: 7,
    projects: [{ id: 'p1', title: 'Uno', mainSessionId: 'main' }, { id: 'p2', title: 'Dos', mainSessionId: null }],
    items: [
      { projectId: 'p1', status: 'done' }, { projectId: 'p1', status: 'doing' }, { projectId: 'p1', status: 'todo' },
      { projectId: null, status: 'todo' }, { projectId: null, status: 'done' }, { projectId: null, status: 'waiting' },
    ],
    links: { p1: [{ projectId: 'p1', sessionId: 'linked' }], p2: [] } as Record<string, { projectId: string; sessionId: string }[]>,
  };
  const calls: { op: string; args: any }[] = [];
  const request = async (op: string, args: any) => {
    calls.push({ op, args });
    if (op === 'projects') return { projects: state.projects, revision: state.revision, totalCount: state.projects.length, hasMore: false };
    if (op === 'links') return { links: state.links[args.projectId] ?? [] };
    if (op === 'items') {
      if (args.expectedSnapshotRevision !== state.revision) throw Error('revision conflict');
      const rows = state.items.filter(item => item.projectId === args.projectId && (!args.status || item.status === args.status));
      return { items: rows.slice(0, args.limit), totalCount: rows.length };
    }
    throw Error(`unexpected ${op}`);
  };
  return { state, calls, request };
}

test('summarises projects, progress, project links and open Pendientes with existing reads only', async () => {
  const f = fixture(); const source = new SidebarProjects(f.request);
  assert.equal(await source.load(), true);
  assert.deepEqual(source.snapshot.projects, [
    { id: 'p1', title: 'Uno', mainSessionId: 'main', total: 3, done: 1 }, { id: 'p2', title: 'Dos', mainSessionId: null, total: 0, done: 0 },
  ]);
  assert.deepEqual(source.snapshot.links, [{ projectId: 'p1', sessionId: 'linked' }]);
  assert.equal(source.snapshot.pendingOpen, 2);
  assert.deepEqual([...new Set(f.calls.map(c => c.op))].sort(), ['items', 'links', 'projects']);
  assert.equal(f.calls.filter(c => c.op === 'items').every(c => c.args.limit === 1 && c.args.archived === false), true);
  assert.equal(projectProgressLabel(source.snapshot.projects[0]), '1/3');
});

test('an unchanged revision costs one projects read and keeps the snapshot', async () => {
  const f = fixture(); const source = new SidebarProjects(f.request);
  await source.load(); const before = source.snapshot; const count = f.calls.length;
  assert.equal(await source.load(), false);
  assert.equal(f.calls.length, count + 1); assert.equal(source.snapshot, before);
  f.state.revision = 8; f.state.items.push({ projectId: 'p1', status: 'done' });
  assert.equal(await source.load(), true); assert.equal(source.snapshot.projects[0].done, 2);
});

test('a failed read keeps the last snapshot and retries on the next trigger', async () => {
  const f = fixture(); let failLinks = false;
  const source = new SidebarProjects(async (op, args) => { if (failLinks && op === 'links') throw Error('synthetic failure'); return f.request(op, args); });
  await source.load(); const before = source.snapshot;
  f.state.revision = 9; f.state.items.push({ projectId: 'p1', status: 'done' }); failLinks = true;
  await assert.rejects(source.load());
  assert.equal(source.snapshot, before, 'no partial summary is published');
  failLinks = false;
  assert.equal(await source.load(), true); assert.equal(source.snapshot.revision, 9); assert.equal(source.snapshot.projects[0].done, 2);
});

test('reset fences an in-flight read; concurrent triggers coalesce', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const source = new SidebarProjects(async (op, args) => { if (op === 'links') await gate; return f.request(op, args); });
  const first = source.load(); const second = source.load(); assert.equal(first, second);
  source.reset(); release(); await first;
  assert.equal(source.snapshot.projects.length, 0, 'a read from a previous runner/profile is discarded');
});

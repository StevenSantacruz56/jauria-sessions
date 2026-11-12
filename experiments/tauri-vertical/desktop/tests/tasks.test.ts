import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasTaskWorkspace, taskStateLabel, taskStartBlock, validateDraft } from '../src/tasks.ts';
import type { Task } from '../src/tasks.ts';
const task: Task = { id: 'task-a', projectId: 'project-a', title: 'Cambio', objective: 'Objetivo', acceptanceCriteria: '', baseSha: 'abc123', branch: 'task/a', worktreePath: '/managed/a', state: 'ready', error: null };

test('old and unsupported runners disable task features without invented projects', () => {
  for (const status of [null, {}, { workspaceVersion: 0 }, { workspaceVersion: 2, projects: [], tasks: [] }, { workspaceVersion: 1, projects: [] }]) assert.equal(hasTaskWorkspace(status), false);
  assert.equal(hasTaskWorkspace({ workspaceVersion: 1, projects: [], tasks: [] }), true);
});
test('draft boundaries permit empty criteria, preserve text and reject whitespace-only required fields', () => {
  assert.equal(validateDraft('project-a', 'a'.repeat(120), 'b'.repeat(8000), 'c'.repeat(8000)), null);
  assert.equal(validateDraft('project-a', ' Título ', ' Objetivo\n', ''), null);
  for (const values of [['', 'Título', 'Objetivo', ''], ['p', ' ', 'Objetivo', ''], ['p', 'Título', '\n', ''], ['p', 'a'.repeat(121), 'b', ''], ['p', 'a', 'b'.repeat(8001), ''], ['p', 'a', 'b', 'c'.repeat(8001)]]) assert.ok(validateDraft(...values as [string, string, string, string]));
});
test('worktree readiness labels never imply model progress or completion', () => {
  assert.deepEqual(['draft', 'preparing', 'ready', 'needs_attention'].map(state => taskStateLabel(state as Task['state'])), ['Borrador', 'Preparando', 'Lista', 'Requiere atención']);
  for (const state of ['done', 'exited', 'constructor']) assert.equal(taskStateLabel(state as Task['state']), 'Estado desconocido');
});
test('capacity and one-writer guard apply only to explicit task starts', () => {
  assert.equal(taskStartBlock(task, []), null);
  assert.ok(taskStartBlock(task, [{ taskId: 'other', status: 'running' }, { taskId: null, status: 'starting' }]));
  for (const status of ['running', 'starting', 'needs_attention']) assert.ok(taskStartBlock(task, [{ taskId: task.id, status }]));
  assert.equal(taskStartBlock(task, [{ taskId: 'other', status: 'running' }, { taskId: task.id, status: 'exited' }]), null);
  assert.ok(taskStartBlock(task, [{taskId:'other',status:'needs_attention'},{taskId:'other2',status:'running'}]));
  assert.ok(taskStartBlock(task, [{taskId:'other',status:'unknown_future'},{taskId:'other2',status:'running'}]));
  assert.equal(taskStartBlock(task,[{taskId:'other',status:'failed'},{taskId:'other2',status:'interrupted'}]),null);
});
test('session exit does not complete or mutate a task, draft and attention cannot start', () => {
  const original = JSON.stringify(task);
  assert.equal(taskStartBlock(task, [{ taskId: task.id, status: 'stopped' }]), null);
  assert.equal(JSON.stringify(task), original);
  for (const state of ['draft', 'preparing', 'needs_attention'] as const) assert.ok(taskStartBlock({ ...task, state }, []));
});

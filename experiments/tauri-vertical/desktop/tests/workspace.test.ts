import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupSessions, isProviderSession, matchesSession, providerLabel, statusLabel } from '../src/workspace.ts';
import type { SessionFilter, WorkspaceSession } from '../src/workspace.ts';

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return { id: 'session-1', title: 'Revisión de sesión', kind: 'codex', status: 'running', cwd: null, rows: 24, cols: 80, ...overrides };
}

test('etiquetas describen la sesión; abierta no significa turno en progreso', () => {
  const labels = {
    starting: 'Abriendo', running: 'Abierta', exited: 'Cerrada', stopped: 'Detenida',
    released: 'Carpeta liberada', needs_attention: 'Requiere atención', failed: 'Falló',
    interrupted: 'Interrumpida', unknown: 'Estado desconocido',
  };
  for (const [status, label] of Object.entries(labels)) assert.equal(statusLabel(status), label);
  for (const status of ['future_status', '', 'done', 'constructor', '__proto__']) {
    assert.equal(statusLabel(status), 'Estado desconocido');
  }
});

test('proveedores reales se distinguen de fixtures, shell y probes', () => {
  for (const [kind, label] of Object.entries({ codex: 'Codex', claude: 'Claude Code', fixture: 'Fixture', shell: 'Shell', codex_probe: 'Prueba Codex', claude_probe: 'Prueba Claude Code' })) {
    assert.equal(providerLabel(kind), label);
    assert.equal(isProviderSession(session({ kind })), kind === 'codex' || kind === 'claude');
  }
  for (const kind of ['future_provider', '', 'constructor']) {
    assert.equal(providerLabel(kind), kind);
    assert.equal(isProviderSession(session({ kind })), false);
  }
});

test('matriz de filtros por estado observado, incluidos desconocidos', () => {
  const expected: Record<string, SessionFilter[]> = {
    starting: ['all', 'open'], running: ['all', 'open'],
    needs_attention: ['all', 'attention'], failed: ['all', 'attention'], interrupted: ['all', 'attention'],
    exited: ['all', 'closed'], stopped: ['all', 'closed'], released: ['all', 'closed'],
    unknown: ['all', 'attention'], future_status: ['all', 'attention'], done: ['all', 'attention'], '': ['all', 'attention'],
  };
  const filters: SessionFilter[] = ['all', 'open', 'attention', 'closed'];
  for (const [status, allowed] of Object.entries(expected)) {
    for (const filter of filters) assert.equal(matchesSession(session({ status }), filter, ''), allowed.includes(filter), `${status}/${filter}`);
  }
});

test('busca título, proveedor, cwd y workspace con espacios y Unicode normalizados', () => {
  const item = session({ title: 'Diseño CAFÉ 日本語 🙂', kind: 'claude', cwd: '/tmp/Ángela/Mi Proyecto', workspace: '/tmp/Área de trabajo' });
  for (const query of ['  DISEÑO  ', 'cafe\u0301', '日本語', '🙂', 'CLAUDE CODE', '/tmp/ángela', 'mi proyecto', '/TMP/ÁREA', '   ']) {
    assert.equal(matchesSession(item, 'all', query), true, query);
  }
  assert.equal(matchesSession(item, 'all', 'inexistente'), false);
  assert.equal(matchesSession(item, 'closed', 'diseño'), false);
  assert.equal(matchesSession(item, 'open', 'diseño'), true);
  assert.equal(matchesSession(session({ title: 'Cafe\u0301' }), 'all', 'CAFÉ'), true);
  assert.equal(matchesSession(session({ kind: 'codex_probe' }), 'all', 'PRUEBA CODEX'), true);
});

test('no busca IDs, PID, estado ni salida PTY, ni deriva tarea terminada', () => {
  const item = Object.freeze({ ...session({ id: 'secret-id', title: 'Sesión', pid: 987654 }), output: 'TAREA TERMINADA permission denied', taskDone: true, turnStatus: 'completed' });
  for (const query of ['secret-id', '987654', 'running', 'abierta', 'TAREA TERMINADA', 'permission denied', 'completed']) {
    assert.equal(matchesSession(item, 'all', query), false, query);
  }
  assert.equal(matchesSession(item, 'open', ''), true);
  assert.equal(matchesSession(item, 'attention', ''), false);
  assert.equal(matchesSession(item, 'closed', ''), false);
  assert.equal(statusLabel(item.status), 'Abierta');
  assert.equal(statusLabel('exited'), 'Cerrada');
});

test('workspace tiene prioridad sobre cwd; comparte grupo con cwd equivalente', () => {
  const items = [session({ id: 'a', cwd: '/repo/worktree', workspace: '/repo' }), session({ id: 'b', cwd: '/repo' }), session({ id: 'c', cwd: '/repo/worktree' })];
  const groups = groupSessions(items);
  assert.deepEqual(groups.map(({ key, path, name, sessions }) => ({ key, path, name, ids: sessions.map(s => s.id) })), [
    { key: '/repo', path: '/repo', name: 'repo', ids: ['a', 'b'] },
    { key: '/repo/worktree', path: '/repo/worktree', name: 'worktree', ids: ['c'] },
  ]);
});

test('rutas son strings: no canonicaliza aliases, mayúsculas ni trailing slash', () => {
  const paths = ['/tmp/alias/../Café///', '/tmp/Café', '/tmp/café', '/tmp/enlace', '/tmp/real', '/tmp/Cafe\u0301', '/'];
  const groups = groupSessions(paths.map((cwd, index) => session({ id: String(index), cwd })));
  assert.deepEqual(groups.map(g => g.key), paths);
  assert.deepEqual(groups.map(g => g.path), paths);
  assert.deepEqual(groups.map(g => g.name), ['Café', 'Café', 'café', 'enlace', 'real', 'Cafe\u0301', '/']);
  const alias = session({ cwd: paths[0] });
  assert.equal(matchesSession(alias, 'all', '/tmp/Café'), false);
  assert.equal(matchesSession(alias, 'all', '/tmp/alias/../CAFÉ///'), true);
});

test('sin carpeta agrupa null, ausente y vacío con fallback a cwd', () => {
  const items = [session({ id: 'a' }), session({ id: 'b', workspace: null }), session({ id: 'c', cwd: '', workspace: '' }), session({ id: 'd', cwd: '/repo', workspace: '' })];
  const groups = groupSessions(items);
  assert.deepEqual(groups[0], { key: '__unassigned__', path: null, name: 'Sin carpeta', sessions: items.slice(0, 3) });
  assert.equal(groups[1].key, '/repo');
  assert.equal(matchesSession(items[0], 'all', 'ausente'), false);
  assert.equal(matchesSession(items[0], 'all', ''), true);
});

test('diagnósticos comparten grupo sin confundirse con proveedores reales', () => {
  const kinds = ['codex_probe', 'codex', 'fixture', 'shell', 'claude_probe', 'claude', 'future_provider'];
  const items = kinds.map(kind => session({ id: kind, kind, cwd: '/repo/subdir', workspace: '/repo' }));
  const groups = groupSessions(items);
  assert.deepEqual(groups[0], { key: '__diagnostics__', path: null, name: 'Pruebas locales', sessions: [items[0], items[2], items[3], items[4]] });
  assert.deepEqual(groups[1].sessions, [items[1], items[5], items[6]]);
  assert.equal(matchesSession(items[0], 'all', '/repo/subdir'), true);
});

test('conserva orden de primera aparición y no modifica objetos ni arrays de entrada', () => {
  const items = Object.freeze([
    Object.freeze(session({ id: 'b1', cwd: '/b' })),
    Object.freeze(session({ id: 'a1', cwd: '/a' })),
    Object.freeze(session({ id: 'b2', cwd: '/b' })),
    Object.freeze(session({ id: 'fixture', kind: 'fixture' })),
  ]);
  const before = JSON.stringify(items);
  const groups = groupSessions(items);
  assert.deepEqual(groups.map(g => g.key), ['/b', '/a', '__diagnostics__']);
  assert.deepEqual(groups[0].sessions.map(s => s.id), ['b1', 'b2']);
  assert.equal(groups[0].sessions[0], items[0]);
  groups[0].sessions.reverse();
  groups.pop();
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(groupSessions(items)[0].sessions.map(s => s.id), ['b1', 'b2']);
  assert.deepEqual(groupSessions([]), []);
});

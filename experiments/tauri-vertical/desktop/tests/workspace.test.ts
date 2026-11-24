import assert from 'node:assert/strict';
import { test } from 'node:test';
import { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionFilter, WorkspaceSession } from '../src/workspace.ts';
// Bundle like the other module tests: workspace.ts imports session-lifecycle without extension.
const temporary = await mkdtemp(join(tmpdir(), 'jauria-workspace-'));
const output = join(temporary, 'workspace.mjs');
await build({ entryPoints: [new URL('../src/workspace.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { groupSessions, isProviderSession, matchesSession, providerLabel, statusLabel } = await import(pathToFileURL(output).href);
after(() => rm(temporary, { recursive: true, force: true }));

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return { id: 'session-1', title: 'Revisión de sesión', kind: 'codex', status: 'running', cwd: null, rows: 24, cols: 80, ...overrides };
}

test('etiquetas: cuatro categorías (1.4.0); abierta no significa turno en progreso', () => {
  const labels = {
    starting: 'Abriendo', running: 'Abierta', exited: 'Terminada', stopped: 'Terminada',
    released: 'Interrumpida', needs_attention: 'Sin confirmar — ocupa plaza', failed: 'Interrumpida',
    interrupted: 'Interrumpida', unknown: 'Sin confirmar — ocupa plaza',
  };
  for (const [status, label] of Object.entries(labels)) assert.equal(statusLabel(status), label);
  for (const status of ['future_status', '', 'done', 'constructor', '__proto__']) {
    assert.equal(statusLabel(status), 'Sin confirmar — ocupa plaza');
  }
});

test('proveedores reales se distinguen de fixtures, shell y probes', () => {
  for (const [kind, label] of Object.entries({ codex: 'Codex', claude: 'Claude Code', fixture: 'Fixture', shell: 'Shell', terminal: 'Terminal', codex_probe: 'Prueba Codex', claude_probe: 'Prueba Claude Code' })) {
    assert.equal(providerLabel(kind), label);
    assert.equal(isProviderSession(session({ kind })), kind === 'codex' || kind === 'claude');
  }
  for (const kind of ['future_provider', '', 'constructor']) {
    assert.equal(providerLabel(kind), kind);
    assert.equal(isProviderSession(session({ kind })), false);
  }
});

test('matriz de filtros por estado observado, incluidos desconocidos (1.4.0: Abiertas incluye Sin confirmar)', () => {
  const expected: Record<string, SessionFilter[]> = {
    starting: ['all', 'open', 'activity'], running: ['all', 'open', 'activity'],
    needs_attention: ['all', 'open', 'activity', 'attention'], failed: ['all', 'activity', 'attention'], interrupted: ['all', 'activity', 'attention'],
    exited: ['all', 'closed'], stopped: ['all', 'closed'], released: ['all', 'activity'],
    unknown: ['all', 'open', 'activity', 'attention'], future_status: ['all', 'open', 'activity', 'attention'], done: ['all', 'open', 'activity', 'attention'], '': ['all', 'open', 'activity', 'attention'],
  };
  const filters: SessionFilter[] = ['all', 'open', 'activity', 'attention', 'closed'];
  for (const [status, allowed] of Object.entries(expected)) {
    for (const filter of filters) assert.equal(matchesSession(session({ status }), filter, ''), allowed.includes(filter), `${status}/${filter}`);
  }
  // Dismissed or continued: an interrupted session is Terminada (Historial), nothing else.
  for (const status of ['interrupted', 'failed', 'released']) {
    for (const filter of filters) assert.equal(matchesSession(session({ status }), filter, '', true), filter === 'all' || filter === 'closed', `retired ${status}/${filter}`);
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
  assert.equal(statusLabel('exited'), 'Terminada');
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


test('terminal normal pertenece a su carpeta y al historial, sin confundirse con diagnóstico ni IA', () => {
  const terminal = session({ kind: 'terminal', title: 'Comandos locales', cwd: '/tmp/Mi carpeta á' });
  const diagnostic = session({ id: 'diagnostic', kind: 'shell', cwd: '/tmp/fixture' });
  const groups = groupSessions([terminal, diagnostic]);
  assert.equal(groups[0].key, terminal.cwd);
  assert.equal(groups[0].name, 'Mi carpeta á');
  assert.deepEqual(groups[0].sessions, [terminal]);
  assert.equal(groups[1].key, '__diagnostics__');
  assert.equal(isProviderSession(terminal), false);
  assert.equal(matchesSession(terminal, 'open', 'terminal'), true);
  assert.equal(matchesSession({ ...terminal, status: 'exited' }, 'closed', 'comandos'), true);
});

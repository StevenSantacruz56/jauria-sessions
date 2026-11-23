/** Command palette, shortcut registry and app commands: pure logic with synthetic data only. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'jauria-command-palette-'));
const entry = join(temporary, 'entry.ts');
const source = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).pathname);
await writeFile(entry, `export { paletteScore, paletteSections, resultsAnnouncement, foldText, bestIndex } from ${source('command-palette.ts')};\nexport * from ${source('shortcuts.ts')};\nexport * from ${source('app-commands.ts')};\n`);
const output = join(temporary, 'command-palette.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: output });
const m = await import(pathToFileURL(output).href);
after(() => rm(temporary, { recursive: true, force: true }));

const item = (id: string, group: string, label: string, extra: Record<string, unknown> = {}) => ({ id, group, label, run() {}, ...extra });
const key = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('matching ignores case and accents and accepts substrings and initials', () => {
  assert.equal(m.foldText('Configuración'), 'configuracion');
  assert.ok(m.paletteScore('configuracion', { label: 'Abrir Configuración' }) > 0, 'accents are ignored');
  assert.ok(m.paletteScore('CONFIG', { label: 'Abrir Configuración' }) > 0, 'case is ignored');
  assert.ok(m.paletteScore('ns', { label: 'Nueva sesión…' }) > 0, 'initials match');
  assert.equal(m.paletteScore('xyz', { label: 'Nueva sesión…' }), 0);
  assert.ok(m.paletteScore('nueva', { label: 'Nueva sesión…' }) > m.paletteScore('sesion', { label: 'Nueva sesión…' }), 'a label prefix beats a later word');
  assert.ok(m.paletteScore('sesion', { label: 'Nueva sesión…' }) > m.paletteScore('ion', { label: 'Nueva sesión…' }), 'a word start beats a substring');
  assert.ok(m.paletteScore('ctrl-c', { label: 'Interrumpir', keywords: 'ctrl-c cancelar' }) > 0, 'keywords are searched');
  assert.ok(m.paletteScore('plan integracion', { label: 'Plan sintético · Integración' }) > 0, 'every word may match separately');
});

test('sections keep the fixed group order and drop empty groups', () => {
  const items = [
    item('a1', 'actions', 'Nueva sesión…'), item('p1', 'projects', 'Pendientes'),
    item('s1', 'sessions', 'Shell'), item('n1', 'needs', 'Plan', { activity: { kind: 'needs', label: 'Permiso pendiente' } }),
  ];
  assert.deepEqual(m.paletteSections(items, '').map((s: any) => s.label), ['Te necesitan', 'Sesiones', 'Proyectos', 'Acciones']);
  assert.deepEqual(m.paletteSections(items, 'pend').map((s: any) => s.group), ['projects']);
  assert.equal(m.resultsAnnouncement(m.paletteSections(items, '')), '4 resultados');
  assert.equal(m.resultsAnnouncement(m.paletteSections(items, 'pend')), '1 resultado');
  assert.equal(m.resultsAnnouncement(m.paletteSections(items, 'zzz')), 'Sin resultados');
});

test('with a query, equal matches sort by state priority; without one, the given order stays', () => {
  const items = [
    item('idle', 'sessions', 'Agente A', { activity: { kind: 'idle', label: 'En espera' } }),
    item('working', 'sessions', 'Agente B', { activity: { kind: 'working', label: 'Trabajando' } }),
    item('finished', 'sessions', 'Agente C', { activity: { kind: 'finished', label: 'Turno terminado' } }),
  ];
  assert.deepEqual(m.paletteSections(items, '')[0].items.map((i: any) => i.id), ['idle', 'working', 'finished']);
  assert.deepEqual(m.paletteSections(items, 'agente')[0].items.map((i: any) => i.id), ['finished', 'working', 'idle']);
  // A better match wins over a higher priority.
  const better = [...items, item('exact', 'sessions', 'Zeta agente', { activity: { kind: 'unreported', label: 'Abierta' } })];
  assert.equal(m.paletteSections(better, 'zeta')[0].items[0].id, 'exact');
});

test('the initial active entry is the best enabled match, else the first entry', () => {
  const items = [item('s', 'sessions', 'Sesión viva', { detail: 'Integrar Pulso' }), item('p', 'projects', 'Integrar Pulso'), item('d', 'actions', 'Integrar todo', { disabledReason: 'No' })];
  assert.equal(m.bestIndex(items, 'integrar'), 1, 'a label match beats an earlier detail match; disabled entries are skipped');
  assert.equal(m.bestIndex(items, ''), 0);
  assert.equal(m.bestIndex([items[2]], 'integrar'), 0, 'a lone disabled entry is still active so its reason is read');
  assert.equal(m.bestIndex([], ''), -1);
});

test('groups are capped; the total keeps the real count', () => {
  const many = Array.from({ length: 30 }, (_, i) => item(`s${i}`, 'sessions', `Sesión ${i}`));
  const [section] = m.paletteSections(many, '');
  assert.equal(section.items.length, 12); assert.equal(section.total, 30);
});

test('shortcuts: existing Command-only chords and the platform palette chord', () => {
  assert.equal(m.matchShortcut(key('n', { metaKey: true }), true), 'new-session');
  assert.equal(m.matchShortcut(key('k', { metaKey: true }), true), 'search-sessions');
  assert.equal(m.matchShortcut(key('i', { metaKey: true }), true), 'inspector');
  assert.equal(m.matchShortcut(key(',', { metaKey: true }), true), 'settings');
  assert.equal(m.matchShortcut(key('P', { metaKey: true, shiftKey: true }), true), 'command-palette');
  assert.equal(m.matchShortcut(key('p', { metaKey: true, shiftKey: true }), true), 'command-palette');
  // Unchanged rules: any extra modifier lets the key through (Ctrl-N, ⌥⌘N, ⇧⌘N reach their target).
  for (const mods of [{ metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { metaKey: true, ctrlKey: true }, { ctrlKey: true }]) assert.equal(m.matchShortcut(key('n', mods), true), null);
  assert.equal(m.matchShortcut(key('p', { metaKey: true }), true), null, '⌘P is not the palette');
  assert.equal(m.matchShortcut(key('p', { ctrlKey: true, shiftKey: true }), true), null, 'Ctrl+Shift+P stays a terminal key on macOS');
  assert.equal(m.matchShortcut(key('P', { ctrlKey: true, shiftKey: true }), false), 'command-palette');
  assert.equal(m.matchShortcut(key('P', { metaKey: true, shiftKey: true, altKey: true }), true), null);
  assert.equal(m.shortcutHint('command-palette', true), '⌘⇧P'); assert.equal(m.shortcutHint('command-palette', false), 'Ctrl+Shift+P');
  assert.equal(m.shortcutAria('command-palette', true), 'Meta+Shift+P'); assert.equal(m.shortcutHint('new-session', true), '⌘N');
  assert.equal(m.isMacPlatform({ platform: 'MacIntel' }), true); assert.equal(m.isMacPlatform({ platform: 'Linux x86_64' }), false);
});

function context(overrides: Record<string, unknown> = {}, log: string[] = []) {
  const actions = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => log.push([String(name), ...args].join(':')) });
  return { connected: true, connecting: false, busy: false, replaying: false, occupied: 1, limit: 2, sessionCount: 2, split: false, planning: false,
    pulsoUnavailable: null, inspectorOpen: false, unseenAlerts: 0, needsTarget: null, grouping: 'project', filter: 'open', theme: 'system', renameSupported: true,
    focused: { id: 'live', title: 'Sesión viva', live: true, stopping: false, structured: false }, actions, ...overrides };
}
const command = (ctx: any, id: string) => m.appCommands(ctx).find((c: any) => c.id === id);

test('registry: availability carries the reason and mirrors the existing controls', () => {
  assert.equal(command(context(), 'new-session').unavailable(), null);
  assert.equal(command(context({ occupied: 2 }), 'new-session').unavailable(), 'Sin plazas libres (2 de 2)');
  assert.equal(command(context({ connected: false }), 'new-session').unavailable(), 'Sin conexión con el runner');
  assert.equal(command(context({ replaying: true }), 'new-session').unavailable(), 'Recuperando el historial');
  assert.equal(command(context({ focused: null }), 'stop').unavailable(), 'No hay sesión en el panel enfocado');
  assert.equal(command(context({ focused: { id: 'x', title: 'X', live: false, stopping: false, structured: false } }), 'stop').unavailable(), 'La sesión ya no está activa');
  assert.equal(command(context({ focused: { id: 'x', title: 'X', live: false, stopping: false, structured: false } }), 'rename').unavailable(), null, 'a closed session can be renamed');
  assert.equal(command(context({ renameSupported: false }), 'rename').unavailable(), 'El runner no permite cambiar nombres');
  assert.match(command(context({ focused: { id: 'x', title: 'X', live: true, stopping: false, structured: true } }), 'interrupt').unavailable(), /Codex/);
  assert.equal(command(context(), 'focus-other-pane').unavailable(), 'Solo con el panel dividido');
  assert.equal(command(context({ sessionCount: 1 }), 'split').unavailable(), 'Necesitas al menos dos sesiones');
  assert.equal(command(context({ planning: true }), 'split').unavailable(), 'Disponible en la vista de terminal');
  assert.equal(command(context({ pulsoUnavailable: 'Pulso sin conexión' }), 'pulso').unavailable(), 'Pulso sin conexión');
  assert.equal(command(context({ planning: true, pulsoUnavailable: 'Pulso sin conexión' }), 'pulso').unavailable(), null, 'leaving Pulso is always possible');
  assert.equal(command(context(), 'mark-seen').unavailable(), 'No hay avisos sin ver');
  assert.equal(command(context(), 'open-needs').unavailable(), 'Ninguna sesión te necesita');
  assert.equal(command(context(), 'theme-system').unavailable(), 'Es la apariencia actual');
  assert.equal(command(context(), 'theme-dark').unavailable(), null);
  assert.equal(command(context(), 'filter-open').unavailable(), 'Ya se muestran las abiertas');
});

test('registry: one entry per shortcut; process actions are confirmed, never immediate', () => {
  const commands = m.appCommands(context());
  for (const id of m.shortcutIds) assert.equal(commands.filter((c: any) => c.shortcut === id).length, 1, id);
  assert.equal(commands.find((c: any) => c.id === 'command-palette').palette, false, 'the palette does not list itself');
  assert.equal(command(context(), 'stop').confirmation, 'dialog');
  assert.equal(command(context(), 'interrupt').confirmation, 'control');
  assert.equal(command(context(), 'rename').confirmation, 'dialog');
  const log: string[] = [];
  const ctx = context({ needsTarget: { id: 'needy', title: 'Necesitada' }, split: true, planning: true }, log);
  for (const id of ['stop', 'interrupt', 'rename', 'open-needs', 'pulso', 'theme-dark', 'filter-closed']) command(ctx, id).run();
  assert.deepEqual(log, ['stop:live', 'interrupt:live', 'rename:live', 'openSession:needy', 'leavePulso', 'setTheme:dark', 'showFilter:closed']);
  assert.equal(command(ctx, 'split').label, 'Unificar en un panel');
  assert.equal(command(context(), 'split').label, 'Dividir el panel');
});

test('shortcut handler: runs only on keydown, skips unavailable commands and blocked states', () => {
  const runs: string[] = [];
  let unavailable: string | null = null; let blocked = false;
  const commands = () => [{ id: 'new-session', label: 'Nueva', shortcut: 'new-session', unavailable: () => unavailable, run: () => runs.push('new') }];
  const handle = m.createShortcutHandler({ commands, mac: true, blocked: () => blocked });
  const event = (type: string, k = 'n', mods = { metaKey: true }) => { const e: any = { type, ...key(k, mods), prevented: 0, stopped: 0 }; e.preventDefault = () => e.prevented++; e.stopPropagation = () => e.stopped++; return e; };
  const down = event('keydown');
  assert.equal(handle(down), true); assert.deepEqual(runs, ['new']); assert.equal(down.prevented, 1);
  assert.equal(handle(event('keyup')), true, 'keyup of the chord is swallowed'); assert.deepEqual(runs, ['new']);
  unavailable = 'Sin plazas libres'; assert.equal(handle(event('keydown')), true); assert.deepEqual(runs, ['new'], 'a disabled command does nothing');
  blocked = true; assert.equal(handle(event('keydown')), false, 'blocked shortcuts reach their target');
  assert.equal(handle(event('keydown', 'x')), false);
});

test('entries: sessions that need you first, open sessions with project or folder, boards with Pendientes, actions with hints', () => {
  const opened: string[] = [];
  const kinds: Record<string, string> = { a: 'unreported', b: 'needs', c: 'unreported', d: 'notice', e: 'working' };
  const entries = m.paletteEntries({
    sessions: [
      { id: 'a', title: 'Shell', kind: 'terminal', cwd: '/x/carpeta', live: true },
      { id: 'b', title: 'Permisos', kind: 'claude', cwd: '/x/b', live: true },
      { id: 'c', title: 'Cerrada', kind: 'codex', cwd: '/x/c', live: false },
      { id: 'd', title: 'Falló', kind: 'codex', cwd: null, live: false },
      { id: 'e', title: 'Trabaja', kind: 'claude', cwd: '/x/e', live: true },
    ],
    activityOf: (id: string) => ({ kind: kinds[id], label: `estado ${id}` }),
    projects: [{ id: 'p', title: 'Plan', mainSessionId: 'e', done: 1, total: 3 }], links: [], pendingOpen: 2, hasMoreProjects: true, pulsoBlocked: null,
    commands: m.appCommands(context()), mac: true,
    openSession: (id: string) => opened.push(`session:${id}`), openBoard: (id: string | null) => opened.push(`board:${id}`), openPulso: () => opened.push('pulso'),
  });
  const byGroup = (group: string) => entries.filter((e: any) => e.group === group).map((e: any) => e.id);
  assert.deepEqual(byGroup('needs'), ['session:b', 'session:d'], 'needs, then notices; a closed session that needs you is kept');
  assert.deepEqual(byGroup('sessions'), ['session:e', 'session:a'], 'open sessions by state priority; closed ones are left to Historial');
  assert.equal(entries.find((e: any) => e.id === 'session:e').detail, 'Plan', 'the Pulso project names the session');
  assert.equal(entries.find((e: any) => e.id === 'session:a').detail, 'carpeta', 'else its folder');
  assert.deepEqual(byGroup('projects'), ['board:p', 'board:', 'board-more']);
  assert.equal(entries.find((e: any) => e.id === 'board:p').detail, '1/3 hechas');
  assert.equal(entries.find((e: any) => e.id === 'board:').detail, '2 sin terminar');
  assert.equal(byGroup('actions').includes('action:command-palette'), false);
  assert.equal(entries.find((e: any) => e.id === 'action:new-session').hint, '⌘N');
  assert.equal(entries.find((e: any) => e.id === 'action:new-session').keyshortcuts, 'Meta+N');
  assert.equal(entries.find((e: any) => e.id === 'action:mark-seen').disabledReason, 'No hay avisos sin ver');
  for (const id of ['session:b', 'board:p', 'board:', 'board-more']) entries.find((e: any) => e.id === id).run();
  assert.deepEqual(opened, ['session:b', 'board:p', 'board:null', 'pulso']);
  const blocked = m.paletteEntries({ sessions: [], activityOf: () => ({ kind: 'unreported', label: '' }), projects: [], links: [], pendingOpen: null, hasMoreProjects: false,
    pulsoBlocked: 'Pulso sin conexión', commands: [], mac: false, openSession() {}, openBoard() {}, openPulso() {} });
  assert.deepEqual(blocked.map((e: any) => [e.id, e.disabledReason]), [['board:', 'Pulso sin conexión']], 'boards stay listed, disabled with the reason');
});

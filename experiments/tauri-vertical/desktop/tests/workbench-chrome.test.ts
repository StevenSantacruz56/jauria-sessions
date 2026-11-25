/** Session picker, top-bar tabs and alerts: pure models, synthetic sessions only. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundle like the other module tests: the sources use extensionless imports.
const temporary = await mkdtemp(join(tmpdir(), 'jauria-workbench-chrome-'));
const entry = join(temporary, 'entry.ts');
const src = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).pathname);
await writeFile(entry, [
  `export { sessionPickerOptions, filterPickerOptions, movePickerIndex, NEW_SESSION_OPTION, pickerGroupLabels } from ${src('session-picker.ts')};`,
  `export { sessionTabs } from ${src('top-bar.ts')};`,
  `export { alertRows, statusCounts, needsLabel, finishedLabel, workingLabel, quietLabel, alertAnnouncement, unseenKeys } from ${src('alerts-popover.ts')};`,
  `export { providerBadge } from ${src('agent-list.ts')};`,
].join('\n'));
const output = join(temporary, 'chrome.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: output, loader: { '.css': 'empty' } });
const m = await import(pathToFileURL(output).href);
after(() => rm(temporary, { recursive: true, force: true }));

const session = (id: string, title: string, status = 'running', kind = 'claude', cwd: string | null = `/synthetic/${id}`) => ({ id, title, kind, status, cwd });

test('picker options (1.4.0): Abiertas with Sin confirmar, continuable Interrumpidas, «Nueva sesión…»; never a Terminada; most recent first', () => {
  const sessions = [session('a', 'Plan', 'running', 'claude', '/x/uno'), session('b', 'Plan', 'running', 'codex', '/x/dos'), session('c', 'Codex', 'running', 'codex'), session('d', 'Vieja', 'exited'),
    session('e', 'Custodia', 'needs_attention'), session('f', 'Caída', 'interrupted'), session('g', 'Sin identidad', 'interrupted', 'codex'), session('h', 'Descartada', 'interrupted'), session('i', 'Liberada', 'released')];
  const rules = { retired: (id: string) => id === 'h', canContinue: (s: any) => s.kind === 'claude' };
  const options = m.sessionPickerOptions(sessions, 0, ['a', 'b'], true, rules);
  assert.deepEqual(options.map((o: any) => [o.id, o.group]), [['', 'none'], ['e', 'open'], ['c', 'open'], ['b', 'open'], ['a', 'open'], ['i', 'interrupted'], ['f', 'interrupted'], [m.NEW_SESSION_OPTION, 'new']]);
  assert.equal(m.pickerGroupLabels.interrupted, 'Interrumpidas · se pueden continuar');
  assert.match(options.find((o: any) => o.id === 'e').detail, /^Sin confirmar — ocupa plaza/);
  assert.equal(options.find((o: any) => o.id === 'a').label, 'Plan · Claude Code · uno');
  assert.equal(options.find((o: any) => o.id === 'c').label, 'Codex', 'a title equal to the provider is not repeated');
  assert.equal(options.find((o: any) => o.id === 'a').selected, true);
  assert.equal(options.find((o: any) => o.id === 'b').disabled, true, 'visible in the other pane');
  assert.equal(options.some((o: any) => o.id === 'd' || o.id === 'h' || o.id === 'g'), false, 'Terminadas and non-continuable Interrumpidas are not offered');
  // Without split, only pane 1 blocks a choice from pane 2.
  assert.equal(m.sessionPickerOptions(sessions, 0, ['a', 'b'], false).find((o: any) => o.id === 'b').disabled, false);
  assert.equal(m.sessionPickerOptions(sessions, 1, ['a', 'b'], false).find((o: any) => o.id === 'a').disabled, true);
  // Without rules, no Interrumpida is offered (nothing is known to continue).
  assert.equal(m.sessionPickerOptions(sessions, 0, [null, null], false).some((o: any) => o.group === 'interrupted'), false);
});

test('picker search folds case and accents, needs every word, hides the empty choice and keeps «Nueva sesión…»', () => {
  const options = m.sessionPickerOptions([session('a', 'Integración Pulso'), session('b', 'Migrar tokens', 'running', 'codex', '/repos/tokens')], 0, [null, null], false);
  const NEW = m.NEW_SESSION_OPTION;
  assert.deepEqual(m.filterPickerOptions(options, '').map((o: any) => o.id), ['', 'b', 'a', NEW]);
  assert.deepEqual(m.filterPickerOptions(options, 'INTEGRACION').map((o: any) => o.id), ['a', NEW]);
  assert.deepEqual(m.filterPickerOptions(options, 'tokens repos').map((o: any) => o.id), ['b', NEW], 'folder text matches too');
  assert.deepEqual(m.filterPickerOptions(options, 'pulso codex').map((o: any) => o.id), [NEW]);
});

test('arrow keys skip disabled options and wrap; no enabled option yields -1', () => {
  const opts = [{ disabled: false }, { disabled: true }, { disabled: false }, { disabled: false }];
  assert.equal(m.movePickerIndex(opts, 0, 'ArrowDown'), 2);
  assert.equal(m.movePickerIndex(opts, 3, 'ArrowDown'), 0);
  assert.equal(m.movePickerIndex(opts, 0, 'ArrowUp'), 3);
  assert.equal(m.movePickerIndex(opts, -1, 'ArrowDown'), 0);
  assert.equal(m.movePickerIndex(opts, 2, 'End'), 3);
  assert.equal(m.movePickerIndex(opts, 2, 'Home'), 0);
  assert.equal(m.movePickerIndex([{ disabled: true }], 0, 'ArrowDown'), -1);
});

test('top-bar tabs: open sessions in runner order, plus closed ones still shown in a pane', () => {
  const sessions = [session('a', 'Uno'), session('b', 'Dos', 'exited'), session('c', 'Tres', 'exited'), session('d', 'Cuatro', 'starting', 'terminal')];
  const tabs = m.sessionTabs(sessions, ['a', 'c'], 'a', (id: string) => id === 'a' ? { kind: 'working', label: 'Trabajando' } : undefined);
  assert.deepEqual(tabs.map((t: any) => t.id), ['a', 'c', 'd']);
  assert.deepEqual(tabs.map((t: any) => [t.current, t.shown]), [[true, true], [false, true], [false, false]]);
  assert.deepEqual([tabs[0].activity, tabs[0].label, tabs[2].activity], ['working', 'Trabajando', 'unreported']);
  assert.deepEqual(m.providerBadge('terminal'), { provider: 'terminal', letter: '$' });
  // 1.4.0: a tab never chooses a Terminada or an Interrumpida for a pane; Sin confirmar keeps its tab.
  const more = [...sessions, session('e', 'Caída', 'interrupted'), session('f', 'Custodia', 'needs_attention'), session('g', 'Vieja', 'stopped')];
  assert.deepEqual(m.sessionTabs(more, ['a', null], 'a', () => undefined).map((t: any) => t.id), ['a', 'd', 'f']);
  assert.deepEqual(m.sessionTabs(more, ['a', 'e'], 'a', () => undefined).map((t: any) => t.id), ['a', 'd', 'e', 'f'], 'what is on screen keeps its tab');
});

test('alerts keep the sidebar priority and unseen first; status bar counts halo and working shapes', () => {
  const kinds: Record<string, string> = { a: 'finished', b: 'needs', c: 'notice', d: 'needs' };
  const rows = m.alertRows([{ id: 'a', reason: 'El proceso terminó', unseen: true }, { id: 'b', reason: 'Permiso', unseen: false }, { id: 'c', reason: 'BEL', unseen: true }, { id: 'd', reason: 'Error', unseen: true }],
    (id: string) => `Sesión ${id}`, (id: string) => ({ kind: kinds[id], label: kinds[id] }));
  assert.deepEqual(rows.map((r: any) => r.id), ['d', 'b', 'c', 'a']);
  assert.deepEqual(m.statusCounts(['needs', 'notice', 'working', 'working', 'idle', 'finished', 'unreported']), { needs: 2, finished: 1, working: 2 });
  assert.equal(m.needsLabel(1), '1 te necesita'); assert.equal(m.needsLabel(3), '3 te necesitan'); assert.equal(m.workingLabel(2), '2 trabajando');
});

test('the live region announces only alerts that were not already unseen', () => {
  const row = (id: string, unseen = true, reason = 'BEL') => ({ id, title: `Sesión ${id}`, label: 'Aviso del terminal', reason, unseen, kind: 'notice' });
  assert.equal(m.alertAnnouncement(new Set(), [row('a')]), 'Nuevo aviso: Sesión a · Aviso del terminal.');
  const known = m.unseenKeys([row('a')]);
  assert.equal(m.alertAnnouncement(known, [row('a')]), null, 'an unchanged alert is not repeated');
  assert.equal(m.alertAnnouncement(known, [row('a', false), row('b', false)]), null, 'seen alerts are quiet');
  assert.match(m.alertAnnouncement(known, [row('a'), row('b'), row('c')]), /^2 avisos nuevos/);
  assert.equal(m.alertAnnouncement(known, [row('a', true, 'Otro motivo')]), 'Nuevo aviso: Sesión a · Aviso del terminal.', 'a new reason is new');
});

test('status bar agrees with the bell: finished turns count, «Sin avisos» only at zero alerts', () => {
  const cases: [string[], number, { needs: number; finished: number; working: number }, string | null][] = [
    [[], 0, { needs: 0, finished: 0, working: 0 }, 'Sin avisos'],
    [['working', 'idle'], 0, { needs: 0, finished: 0, working: 1 }, 'Sin avisos'],
    [['finished'], 1, { needs: 0, finished: 1, working: 0 }, null],
    [['finished', 'working'], 1, { needs: 0, finished: 1, working: 1 }, null],
    [['needs', 'notice', 'finished', 'working'], 3, { needs: 2, finished: 1, working: 1 }, null],
    [['notice'], 1, { needs: 1, finished: 0, working: 0 }, null],
    // An alert that no counter shows still keeps the bar from saying «Sin avisos».
    [['unreported'], 1, { needs: 0, finished: 0, working: 0 }, '1 aviso'],
  ];
  for (const [kinds, alerts, counts, quiet] of cases) {
    assert.deepEqual(m.statusCounts(kinds), counts, kinds.join());
    assert.equal(m.quietLabel(alerts, counts), quiet, kinds.join());
  }
  assert.equal(m.finishedLabel(1), '1 terminó'); assert.equal(m.finishedLabel(2), '2 terminaron');
  // H9: with the runner list capped, the bar names the sessions it cannot classify (bell and Dock count them).
  assert.equal(m.quietLabel(129, { needs: 0, finished: 128 }, 1), '1 sin listar');
  assert.equal(m.quietLabel(3, { needs: 1, finished: 2 }, 0), null);
});

test('a second identical alert with a new runner sequence is announced (H11)', () => {
  const row = (seq: number) => ({ id: 'a', title: 'Sesión a', label: 'Aviso del terminal', reason: 'La sesión emitió una alerta', unseen: true, kind: 'notice', unseenKeys: [`a:agent:bell:7:${seq}`] });
  const known = m.unseenKeys([row(1)]);
  assert.equal(m.alertAnnouncement(known, [row(1)]), null, 'the same alert is not repeated');
  assert.equal(m.alertAnnouncement(known, [row(2)]), 'Nuevo aviso: Sesión a · Aviso del terminal.', 'same text, new sequence: announced');
});

/** Sidebar layout and terminal font preferences: validation, persistence per
 * profile and the Proyectos/Agentes split. Synthetic in-memory storage only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampShare, clampWidth, defaultSidebarLayout, effectiveSidebarWidth, maxSidebarWidth, projectsMaxHeight, projectsMinHeight, agentsMinHeight,
  readSidebarLayout, saveSidebarLayout, separatorKey, sidebarLayoutKey, sidebarWidth, projectsShare, validSidebarLayout } from '../src/sidebar-layout.ts';
import { readTerminalFont, saveTerminalFont, terminalFontKey, terminalFontSize, validFontSize } from '../src/terminal-font.ts';

function storage() {
  const values = new Map<string, string>(); const writes: [string, string | null][] = [];
  return { values, writes, getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push([key, value]); },
    removeItem(key: string) { values.delete(key); writes.push([key, null]); } };
}

test('layout keys are per profile and persistence is off without one', () => {
  assert.equal(sidebarLayoutKey('synthetic'), 'jauria:sidebar-layout:synthetic');
  for (const profile of [null, '', 'x'.repeat(4097)]) {
    const s = storage(); saveSidebarLayout(s, profile, { ...defaultSidebarLayout, width: 300 });
    assert.deepEqual(s.writes, []); assert.deepEqual(readSidebarLayout(s, profile), defaultSidebarLayout);
  }
  const s = storage();
  saveSidebarLayout(s, 'a', { ...defaultSidebarLayout, width: 300 }); saveSidebarLayout(s, 'b', { ...defaultSidebarLayout, projectsShare: 60 });
  assert.equal(readSidebarLayout(s, 'a').width, 300); assert.equal(readSidebarLayout(s, 'a').projectsShare, 34);
  assert.equal(readSidebarLayout(s, 'b').projectsShare, 60); assert.equal(readSidebarLayout(s, 'b').width, 264);
});

test('saving stores a versioned record and removes it when everything is back to the default', () => {
  const s = storage();
  saveSidebarLayout(s, 'p', { projectsShare: 50, width: 320, projectsCollapsed: true, agentsCollapsed: false });
  assert.deepEqual(JSON.parse(s.values.get('jauria:sidebar-layout:p')!), { schemaVersion: 1, projectsShare: 50, width: 320, projectsCollapsed: true, agentsCollapsed: false });
  saveSidebarLayout(s, 'p', { ...defaultSidebarLayout });
  assert.equal(s.values.has('jauria:sidebar-layout:p'), false);
});

test('every field is validated on read; a corrupt value falls back on its own', () => {
  const s = storage(); const key = sidebarLayoutKey('p')!;
  for (const raw of ['{', 'null', '[]', '"x"', '{}', '{"schemaVersion":2,"width":300}', '{"width":300}']) {
    s.values.set(key, raw); assert.deepEqual(readSidebarLayout(s, 'p'), defaultSidebarLayout, raw);
  }
  for (const [field, bad] of [['width', 219], ['width', 421], ['width', 300.5], ['width', '300'], ['projectsShare', 14], ['projectsShare', 86], ['projectsShare', null]] as const) {
    const layout = validSidebarLayout({ schemaVersion: 1, width: 300, projectsShare: 50, [field]: bad });
    assert.equal(layout[field], defaultSidebarLayout[field], `${field}=${bad}`);
    assert.equal(layout[field === 'width' ? 'projectsShare' : 'width'], field === 'width' ? 50 : 300, 'the other field survives');
  }
  assert.equal(validSidebarLayout({ schemaVersion: 1, projectsCollapsed: 'yes' }).projectsCollapsed, false);
  // Both folded is never stored as such: Agentes opens.
  assert.deepEqual(validSidebarLayout({ schemaVersion: 1, projectsCollapsed: true, agentsCollapsed: true }), { ...defaultSidebarLayout, projectsCollapsed: true });
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(readSidebarLayout(throwing, 'p'), defaultSidebarLayout);
  saveSidebarLayout(throwing, 'p', { ...defaultSidebarLayout, width: 300 });
});

test('width: clamped to its range and to the window, the workbench keeps 440 px', () => {
  assert.deepEqual([clampWidth(100), clampWidth(500), clampWidth(300.4)], [220, 420, 300]);
  assert.equal(maxSidebarWidth(1220), 420); assert.equal(maxSidebarWidth(861), 420); assert.equal(maxSidebarWidth(760), 320);
  assert.equal(maxSidebarWidth(600), sidebarWidth.min);
  assert.equal(effectiveSidebarWidth(400, 800), 360);
  assert.equal(effectiveSidebarWidth(264, 1220), 264);
});

test('split: Proyectos gets its share, never below two rows and never leaving Agentes below its minimum', () => {
  const layout = { ...defaultSidebarLayout };
  assert.equal(projectsMaxHeight(608, layout), Math.round(600 * .34));
  // A small sidebar: Proyectos keeps its minimum.
  assert.equal(projectsMaxHeight(300, { ...layout, projectsShare: 15 }), projectsMinHeight);
  // A large share stops where Agentes would fall below its minimum.
  assert.equal(projectsMaxHeight(608, { ...layout, projectsShare: 85 }), 600 - agentsMinHeight);
  // Folding gives the other all the room.
  assert.equal(projectsMaxHeight(608, { ...layout, projectsCollapsed: true }), 0);
  assert.equal(projectsMaxHeight(608, { ...layout, agentsCollapsed: true }), 578);
  for (let available = 0; available < 1200; available += 37) for (const share of [15, 34, 85]) {
    const value = projectsMaxHeight(available, { ...layout, projectsShare: share });
    assert.ok(value >= Math.min(projectsMinHeight, Math.max(0, available - 8)) && value <= Math.max(projectsMinHeight, available), `${available}/${share}: ${value}`);
  }
  assert.deepEqual([clampShare(0), clampShare(99), clampShare(40.4)], [15, 85, 40]);
});

test('separator keys: arrows step, Home/End go to the ends, Enter restores', () => {
  const r = projectsShare;
  assert.equal(separatorKey('ArrowDown', 34, r, ['ArrowDown'], ['ArrowUp']), 39);
  assert.equal(separatorKey('ArrowUp', 17, r, ['ArrowDown'], ['ArrowUp']), 15);
  assert.equal(separatorKey('ArrowDown', 84, r, ['ArrowDown'], ['ArrowUp']), 85);
  assert.equal(separatorKey('Home', 50, r, [], []), 15); assert.equal(separatorKey('End', 50, r, [], []), 85);
  assert.equal(separatorKey('Enter', 50, r, [], []), 34); assert.equal(separatorKey('a', 50, r, [], []), null);
  assert.equal(separatorKey('ArrowRight', 264, sidebarWidth, ['ArrowRight'], ['ArrowLeft']), 272);
});

test('terminal font: per profile, 11–18 px, default 13 and nothing stored for it', () => {
  assert.equal(terminalFontKey('p'), 'jauria:terminal-font:p'); assert.equal(terminalFontKey(null), null);
  const s = storage();
  assert.equal(readTerminalFont(s, 'p'), terminalFontSize.default);
  saveTerminalFont(s, 'p', 16); assert.equal(s.values.get('jauria:terminal-font:p'), '{"schemaVersion":1,"size":16}');
  assert.equal(readTerminalFont(s, 'p'), 16); assert.equal(readTerminalFont(s, 'q'), 13);
  saveTerminalFont(s, 'p', 13); assert.equal(s.values.has('jauria:terminal-font:p'), false);
  for (const bad of [10, 19, 13.5, '14', null]) { saveTerminalFont(s, 'p', bad as number); assert.equal(s.values.has('jauria:terminal-font:p'), false); assert.equal(validFontSize(bad), 13); }
  for (const raw of ['{', '{"schemaVersion":1,"size":40}', '{"schemaVersion":2,"size":14}', '14']) { s.values.set('jauria:terminal-font:p', raw); assert.equal(readTerminalFont(s, 'p'), 13, raw); }
});

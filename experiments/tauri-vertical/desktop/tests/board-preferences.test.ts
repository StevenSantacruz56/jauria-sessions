/** Synthetic in-memory storage only; never reads a user profile. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { boardPreferenceKey, readLastBoard, saveLastBoard } from '../src/board-preferences.ts';
function fixture() {
  const values = new Map<string, string>(); const writes: { key: string; value: string }[] = [];
  return { values, writes, getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); } };
}
test('board keys use the exact profile namespace and disable persistence without a profile', () => {
  assert.equal(boardPreferenceKey('synthetic-a'), 'jauria-pulso:last-board:synthetic-a');
  for (const profile of [null, '', 'x'.repeat(4097)]) {
    assert.equal(boardPreferenceKey(profile), null); const storage = fixture(); saveLastBoard(storage, profile, 'p1');
    assert.equal(readLastBoard(storage, profile), null); assert.deepEqual(storage.writes, []);
  }
});
test('last-board persistence stores only versioned project identity or Pendientes null', () => {
  const storage = fixture(); saveLastBoard(storage, 'synthetic', 'p1');
  assert.deepEqual(storage.writes, [{ key: 'jauria-pulso:last-board:synthetic', value: JSON.stringify({ schemaVersion: 1, projectId: 'p1' }) }]);
  assert.equal(readLastBoard(storage, 'synthetic'), 'p1'); saveLastBoard(storage, 'synthetic', null);
  assert.equal(readLastBoard(storage, 'synthetic'), null); assert.deepEqual(JSON.parse(storage.writes[1].value), { schemaVersion: 1, projectId: null });
});
test('profiles never read or overwrite another profile board', () => {
  const storage = fixture(); saveLastBoard(storage, 'synthetic-a', 'p1'); saveLastBoard(storage, 'synthetic-b', 'p2');
  assert.equal(readLastBoard(storage, 'synthetic-a'), 'p1'); assert.equal(readLastBoard(storage, 'synthetic-b'), 'p2');
  saveLastBoard(storage, 'synthetic-a', null); assert.equal(readLastBoard(storage, 'synthetic-b'), 'p2');
});
test('missing, malformed and incompatible saved boards return Pendientes', () => {
  const storage = fixture(); const key = boardPreferenceKey('synthetic')!; assert.equal(readLastBoard(storage, 'synthetic'), null);
  for (const value of ['{', 'null', '[]', '"p1"', '{}', '{"schemaVersion":2,"projectId":"p1"}', '{"schemaVersion":1,"projectId":3}', '{"projectId":"p1"}']) {
    storage.values.set(key, value); assert.equal(readLastBoard(storage, 'synthetic'), null, value);
  }
});
test('invalid IDs cannot restore or overwrite a committed board', () => {
  for (const projectId of ['', '.', '..', '../p1', '/synthetic/project', 'p1 p2', 'p1\n', 'x'.repeat(81)]) {
    const storage = fixture(); saveLastBoard(storage, 'synthetic', 'safe'); saveLastBoard(storage, 'synthetic', projectId);
    assert.equal(readLastBoard(storage, 'synthetic'), 'safe', JSON.stringify(projectId));
    storage.values.set(boardPreferenceKey('synthetic')!, JSON.stringify({ schemaVersion: 1, projectId }));
    assert.equal(readLastBoard(storage, 'synthetic'), null, JSON.stringify(projectId));
  }
});
test('valid UUID and bounded identifiers round trip', () => {
  const storage = fixture();
  for (const projectId of ['synthetic-project_1.2', '12345678-1234-1234-1234-123456789abc', 'x'.repeat(80)]) {
    saveLastBoard(storage, 'synthetic', projectId); assert.equal(readLastBoard(storage, 'synthetic'), projectId);
  }
});
test('unavailable storage remains an optional preference', () => {
  const storage = { getItem() { throw Error('synthetic denied read'); }, setItem() { throw Error('synthetic quota'); } };
  assert.equal(readLastBoard(storage, 'synthetic'), null); assert.doesNotThrow(() => saveLastBoard(storage, 'synthetic', 'p1'));
});

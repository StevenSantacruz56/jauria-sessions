import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeAttention } from '../src/native-attention.ts';
const item = (key: string, overrides = {}) => ({ id: 's', reason: '', unseen: true, stale: false, keys: [key], ...overrides });
const tick = () => new Promise(r => setTimeout(r, 12));
test('default off; click-only permission; opt-in excludes backlog; new items group and deduplicate', async () => {
  let requests = 0, checks = 0, sends = 0, granted = false;
  const n = new NativeAttention({ granted: async () => { checks++; return granted; }, request: async () => { requests++; granted = true; return 'granted'; }, send: () => { sends++; } }, () => true, () => {}, 1);
  n.update([item('baseline')]); await tick(); assert.equal(checks, 0); assert.equal(requests, 0); assert.equal(sends, 0);
  await n.enableFromClick([item('baseline')]); n.update([item('baseline')]); await tick(); assert.equal(requests, 1); assert.equal(sends, 0);
  n.update([item('new')]); n.update([item('new')]); await tick(); assert.equal(sends, 1);
  n.update([item('new')]); await tick(); assert.equal(sends, 1);
  n.update([item('stale', {stale:true})]); await tick(); assert.equal(sends, 1);
  n.update([item('quiet', {unseen:false})]); await tick(); assert.equal(sends, 1);
  n.disable(); n.update([item('later')]); await tick(); assert.equal(sends, 1);
});
test('focus, acknowledgement, permission failure and disposal cancel delayed notification', async () => {
  let eligible = true, sends = 0;
  const n = new NativeAttention({ granted: async () => true, request: async () => { throw Error('must not prompt'); }, send: () => { sends++; } }, () => eligible, () => {}, 1);
  await n.enableFromClick([]);
  n.update([item('focused')]); eligible = false; await tick(); assert.equal(sends, 0);
  eligible = true; n.update([item('seen')]); n.update([item('seen', {unseen:false})]); await tick(); assert.equal(sends, 0);
  n.update([item('closed')]); n.disable(); await tick(); assert.equal(sends, 0);
  const failed = new NativeAttention({ granted: async () => false, request: async () => 'denied', send: () => { sends++; } }, () => true, () => {}, 1);
  await failed.enableFromClick([]); assert.equal(failed.enabled, false);
  failed.update([item('no-permission')]); await tick(); assert.equal(sends, 0);
});
test('native notices describe the category without including session details', async () => {
  const kinds: string[] = [];
  const n = new NativeAttention({ granted: async () => true, request: async () => 'granted', send: kind => { kinds.push(kind); } }, () => true, () => {}, 1);
  await n.enableFromClick([]);
  n.update([item('s:program:needs', {reason:'Sensitive project name'})]); await tick();
  n.update([item('s:program:done')]); await tick();
  n.update([item('s:signal:bell')]); await tick();
  assert.deepEqual(kinds, ['needs', 'finished', 'notice']);
});
test('runner agent keys map to the same three categories as window keys', async () => {
  const { noticeKind } = await import('../src/native-attention.ts');
  const kind = (k: string) => noticeKind([{ keys: [`session-1:agent:${k}:4503599627370495:3`] }]);
  assert.deepEqual(['needs', 'permission', 'finished', 'ended', 'bell', 'notify'].map(kind), ['needs', 'needs', 'finished', 'finished', 'notice', 'notice']);
  // The strongest category of a batch wins, as with window keys.
  assert.equal(noticeKind([{ keys: ['a:agent:bell:1:1'] }, { keys: ['b:agent:finished:1:2'] }]), 'finished');
  assert.equal(noticeKind([{ keys: ['a:agent:ended:1:1', 'a:agent:needs:1:2'] }]), 'needs');
  // A session id that merely contains a kind word does not change the category.
  assert.equal(noticeKind([{ keys: ['agent-needs-1:agent:bell:1:1'] }]), 'notice');
});
test('the notice copy is fixed per category: no title, path or terminal text can reach it', async () => {
  const { nativeNoticeContent } = await import('../src/native-attention.ts');
  const sent: unknown[] = [];
  const n = new NativeAttention({ granted: async () => true, request: async () => 'granted', send: kind => { sent.push(nativeNoticeContent(kind)); } }, () => true, () => {}, 1);
  await n.enableFromClick([]);
  n.update([item('s:agent:finished:7:1', { id: 's', reason: 'El agente terminó · /Users/private/secret-project · rm -rf' })]); await tick();
  assert.deepEqual(sent, [{ title: 'Jauría · Actividad finalizada', body: 'Abre Jauría y consulta Actividad.' }]);
  for (const k of ['needs', 'finished', 'notice'] as const) {
    const content = JSON.stringify(nativeNoticeContent(k));
    assert.doesNotMatch(content, /secret|\/Users|session|Claude|Codex/);
  }
});

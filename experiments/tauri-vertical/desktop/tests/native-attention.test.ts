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

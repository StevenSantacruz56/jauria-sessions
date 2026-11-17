import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'jauria-activity-'));
const output = join(temporary, 'activity.mjs');
await build({ entryPoints: ['src/session-activity.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { sessionActivity } = await import(pathToFileURL(output).href);
const session = { id: 's', title: 'Synthetic session', kind: 'claude', status: 'running', cwd: '/synthetic', rows: 24, cols: 80 };
const alert = (keys: string[], reason: string) => ({ id: 's', keys: keys.map(key => `s:${key}`), reason, unseen: true, stale: false });

try {
  test('a live PTY is unreported until the agent declares its state', () => {
    assert.deepEqual(sessionActivity(session, undefined, null), {
      kind: 'unreported', label: 'Abierta', detail: 'Progreso no informado',
    });
    assert.equal(sessionActivity(session, undefined, 'working').kind, 'working');
    assert.equal(sessionActivity(session, undefined, 'working', 0, 125_000).detail, 'Desde hace 2 min');
    assert.equal(sessionActivity(session, undefined, 'idle').kind, 'idle');
  });
  test('action, notice and completion remain distinct', () => {
    assert.equal(sessionActivity(session, alert(['signal:bell'], 'Campana'), 'blocked').kind, 'needs');
    assert.equal(sessionActivity(session, alert(['permissions:1:1:[]'], '1 permiso pendiente'), null).label, 'Permiso pendiente');
    assert.equal(sessionActivity(session, alert(['signal:bell'], 'Campana'), null).kind, 'notice');
    assert.equal(sessionActivity(session, alert(['program:done'], 'El agente terminó su turno'), 'idle').kind, 'finished');
    assert.equal(sessionActivity(session, alert(['signal:ended'], 'El proceso terminó'), null).label, 'Proceso terminó');
  });
} finally { await rm(temporary, { recursive: true, force: true }); }

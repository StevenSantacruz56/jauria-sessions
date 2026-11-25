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
const { sessionActivity, agentActivity, exitFailure, endReason } = await import(pathToFileURL(output).href);
const session = { id: 's', title: 'Synthetic session', kind: 'claude', status: 'running', cwd: '/synthetic', rows: 24, cols: 80 };
const alert = (keys: string[], reason: string) => ({ id: 's', keys: keys.map(key => `s:${key}`), reason, unseen: true, stale: false });

try {
  test('exit code: «Proceso falló (código N)» needs you; code 0 «terminó»; a stop is never a failure', () => {
    const ended = (status: string, detail: unknown) => ({ ...session, status, detail });
    assert.equal(endReason(ended('exited', { exitCode: 3, wait: 'ExitStatus { code: 3 }', history: {} })), 'Proceso falló (código 3)');
    assert.equal(endReason(ended('exited', { exitCode: 0 })), 'El proceso terminó');
    assert.equal(endReason(ended('exited', { waitResult: { exitCode: 2 } })), 'Proceso falló (código 2)');
    assert.equal(endReason(ended('failed', { reason: 'spawn PTY child: /private/secret' })), 'Proceso falló', 'only the code is shown, never the reason text');
    assert.deepEqual(exitFailure(ended('stopped', { exitCode: 143 })), { failed: false, code: 143 }, 'Terminar or shutdown');
    // A death by signal: portable_pty says code 1, which is not the process's own code.
    assert.equal(endReason(ended('exited', { exitCode: 1, signaled: true, wait: 'ExitStatus { code: 1, signal: Some("Killed") }' })), 'Proceso falló');
    assert.equal(endReason(ended('exited', { exitCode: 1, signaled: false })), 'Proceso falló (código 1)');
    assert.equal(exitFailure(ended('stopped', { exitCode: 1, signaled: true })).failed, false, 'Terminar by signal is no failure');
    assert.equal(exitFailure(ended('exited', {})).failed, false, 'unknown code: not a failure');
    const pending = { state: null, changedAt: null, turnStartedAt: null, lastTurnMs: null, turnInterrupted: false, pending: { ended: { seq: 1 } } };
    const failed = agentActivity(ended('exited', { exitCode: 1 }), { id: 's', keys: ['s:agent:ended:1:1'], reason: 'Proceso falló (código 1)', unseen: true, stale: false }, pending);
    assert.deepEqual([failed.kind, failed.label, failed.detail], ['needs', 'Proceso falló', 'Proceso falló (código 1)']);
    const clean = agentActivity(ended('exited', { exitCode: 0 }), undefined, pending);
    assert.deepEqual([clean.kind, clean.label], ['finished', 'Proceso terminó']);
    // Window mode (runner 1.3.x) reads the same field.
    assert.equal(sessionActivity(ended('exited', { exitCode: 9 }), alert(['signal:ended'], 'x'), null).kind, 'needs');
    assert.equal(sessionActivity(ended('exited', { exitCode: 0 }), alert(['signal:ended'], 'x'), null).kind, 'finished');
  });
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

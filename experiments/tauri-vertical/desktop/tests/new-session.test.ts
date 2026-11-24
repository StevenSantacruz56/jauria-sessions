/** «Nueva sesión» rules: capacity line, blocked reasons, recent folders and the Claude same-folder warning. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityText, claudeFolderConflict, folderLabel, isMissingFolderError, readRecentFolders, recentFoldersKey, rememberRecentFolder, startBlockedReason, type StartContext } from '../src/new-session.ts';

const ok: StartContext = { connected: true, connecting: false, replaying: false, busy: false, occupied: 3, limit: 8, folder: '/Users/s', folderMissing: false, provider: 'claude', tool: 'available', terminalSupported: true };
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data }; };

test('capacity line counts occupied and free slots', () => {
  assert.equal(capacityText(3, 8), '3 de 8 plazas ocupadas · 5 disponibles');
  assert.equal(capacityText(7, 8), '7 de 8 plazas ocupadas · 1 disponible');
  assert.equal(capacityText(9, 8), '9 de 8 plazas ocupadas · 0 disponibles');
});
test('Abrir sesión says exactly why it is blocked, in priority order', () => {
  assert.equal(startBlockedReason(ok), null);
  assert.deepEqual(startBlockedReason({ ...ok, connected: false }), { text: 'Sin conexión con el servicio de sesiones. Reconecta para abrir una sesión.', reconnect: true });
  assert.equal(startBlockedReason({ ...ok, connecting: true })?.text, 'Conectando con el servicio de sesiones…');
  assert.equal(startBlockedReason({ ...ok, occupied: 8 })?.text, 'No quedan plazas (8 de 8). Termina una sesión o cambia el límite en Configuración.');
  assert.equal(startBlockedReason({ ...ok, provider: 'codex', tool: 'missing' })?.text, 'Codex no está instalado. Elige otra herramienta o pulsa Comprobar otra vez.');
  assert.equal(startBlockedReason({ ...ok, provider: 'terminal', tool: 'missing' }), null, 'Terminal needs no CLI');
  assert.equal(startBlockedReason({ ...ok, provider: 'terminal', terminalSupported: false })?.text, 'Terminal necesita reiniciar el runner desde Diagnóstico.');
  assert.equal(startBlockedReason({ ...ok, folder: null })?.text, 'Elige una carpeta de trabajo.');
  assert.equal(startBlockedReason({ ...ok, folderMissing: true })?.text, 'Esta carpeta ya no existe. Elige otra carpeta.');
  assert.equal(startBlockedReason({ ...ok, tool: 'unknown' }), null, 'an unverified CLI is checked again when sending');
});
test('the runner errors for a missing folder are recognised', () => {
  assert.equal(isMissingFolderError('working directory is unavailable'), true);
  assert.equal(isMissingFolderError('working directory must be a directory'), true);
  assert.equal(isMissingFolderError('El límite es 8'), false);
});
test('recent folders: five per profile, newest first, validated when read', () => {
  const s = memory();
  for (const f of ['/a', '/b', '/c', '/d', '/e', '/f', '/b']) rememberRecentFolder(s, 'profile-a', f);
  assert.deepEqual(readRecentFolders(s, 'profile-a'), ['/b', '/f', '/e', '/d', '/c']);
  assert.deepEqual(readRecentFolders(s, 'profile-b'), [], 'other profiles are separate');
  assert.deepEqual(readRecentFolders(s, null), []); assert.equal(recentFoldersKey(null), null);
  s.setItem(recentFoldersKey('bad')!, JSON.stringify({ schemaVersion: 1, folders: ['relative', '/ok', 42, '/x\u0007', '/ok'] }));
  assert.deepEqual(readRecentFolders(s, 'bad'), ['/ok']);
  s.setItem(recentFoldersKey('old')!, '{broken'); assert.deepEqual(readRecentFolders(s, 'old'), []);
  s.setItem(recentFoldersKey('v2')!, JSON.stringify({ schemaVersion: 2, folders: ['/a'] })); assert.deepEqual(readRecentFolders(s, 'v2'), []);
  assert.deepEqual(rememberRecentFolder(s, 'profile-a', 'not-absolute'), ['/b', '/f', '/e', '/d', '/c']);
});
test('folder labels shorten the home folder', () => {
  assert.equal(folderLabel('/Users/s/app', '/Users/s'), '~/app');
  assert.equal(folderLabel('/Users/sx/app', '/Users/s'), '/Users/sx/app');
  assert.equal(folderLabel('/tmp', null), '/tmp');
});
test('Claude same-folder warning only for a live Claude Code session in that folder', () => {
  const sessions = [{ kind: 'claude', cwd: '/w', status: 'running' }, { kind: 'claude', cwd: '/old', status: 'exited' }, { kind: 'codex', cwd: '/c', status: 'running' }];
  assert.equal(claudeFolderConflict(sessions, 'claude', '/w'), true);
  assert.equal(claudeFolderConflict(sessions, 'codex', '/w'), false);
  assert.equal(claudeFolderConflict(sessions, 'claude', '/old'), false);
  assert.equal(claudeFolderConflict(sessions, 'claude', '/c'), false);
});

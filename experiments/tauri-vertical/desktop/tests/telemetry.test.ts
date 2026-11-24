/** «Uso y recursos»: formatting and the pure view model (quotas in plain
 * words, resources per session / runner / window / total, the status bar
 * total). The dialog itself runs in tests/browser/usage-resources.test.ts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatQuotaLine, formatResourceCpu, formatResourceRam, formatTelemetryAge, formatTelemetryBytes, formatTelemetryCpu, formatTelemetryPercent,
  formatTelemetryTime, formatTelemetryWindow, quotaView, resourceView, telemetrySummary, QUOTA_STALE_MS,
} from '../src/telemetry.ts';

const MiB = 1024 ** 2;

test('numbers: absent or invalid values are never shown as zero', () => {
  for (const invalid of [undefined, null, '', '42', -1, NaN, Infinity, {}, true]) {
    assert.equal(formatTelemetryPercent(invalid), 'No disponible');
    assert.equal(formatTelemetryCpu(invalid), 'No disponible');
    assert.equal(formatTelemetryBytes(invalid), 'No disponible');
  }
  assert.equal(formatTelemetryPercent(0), '0 %');
  assert.equal(formatTelemetryPercent(100), '100 %');
  assert.equal(formatTelemetryPercent(42.5), '42,5 %');
  assert.equal(formatTelemetryPercent(100.01), 'No disponible');
  assert.equal(formatTelemetryCpu(245.5), '245,5 %');
  assert.equal(formatTelemetryBytes(0), '0 MiB');
  assert.equal(formatTelemetryBytes(MiB), '1 MiB');
  assert.equal(formatTelemetryBytes(1.5 * 1024 ** 3), '1,5 GiB');
});

test('times: «25 nov, 11:23» in local time, seconds and milliseconds alike; ages are «hace …»', () => {
  for (const invalid of [undefined, null, '', 'not-a-date', NaN, {}, Infinity, -1, 1e20]) assert.equal(formatTelemetryTime(invalid), 'No informada');
  const local = new Date(2026, 10, 25, 11, 23).getTime();
  assert.equal(formatTelemetryTime(local), '25 nov, 11:23');
  assert.equal(formatTelemetryTime(local / 1000), '25 nov, 11:23');
  const now = local + 11 * 3600_000;
  assert.equal(formatTelemetryAge(local, now), 'hace 11 h');
  assert.equal(formatTelemetryAge(now - 30_000, now), 'hace un momento');
  assert.equal(formatTelemetryAge(now - 5 * 60_000, now), 'hace 5 min');
  assert.equal(formatTelemetryAge(now - 3 * 86400_000, now), 'hace 3 d');
  assert.equal(formatTelemetryAge(now + 60_000, now), 'hace un momento', 'a clock ahead is never a future age');
  assert.equal(formatTelemetryAge(null, now), 'sin fecha');
});

test('windows in plain words; no window the provider did not report', () => {
  assert.equal(formatTelemetryWindow({ windowDurationMins: 10080, limitId: 'codex' }, 'codex'), 'Semana');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 300, limitId: 'codex' }, 'codex'), '5 horas');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 300, limitId: 'claude', window: 'five_hour' }, 'claude'), '5 horas');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 60 }), '1 hora');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 1440 }), 'Día');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 2880 }), '2 días');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 45 }), '45 min');
  assert.equal(formatTelemetryWindow({ window: 'seven_day' }), 'Semana');
  assert.equal(formatTelemetryWindow({ window: 'secondary' }), 'Límite secundario');
  assert.equal(formatTelemetryWindow({ windowDurationMins: 10080, limitId: 'codex_mini' }, 'codex'), 'Semana (codex_mini)');
  assert.equal(formatTelemetryWindow({ label: 'Personalizada' }), 'Personalizada');
  assert.equal(formatTelemetryWindow(null), 'Límite sin nombre');
  const reset = new Date(2026, 10, 25, 11, 23).getTime() / 1000;
  assert.equal(formatQuotaLine({ windowDurationMins: 10080, limitId: 'codex', remainingPercent: 92, resetsAt: reset }, 'codex'), 'Semana: 92 % libre · se reinicia el 25 nov, 11:23');
  assert.equal(formatQuotaLine({ windowDurationMins: 300, remainingPercent: 40 }, 'codex'), '5 horas: 40 % libre');
  assert.equal(formatQuotaLine({ windowDurationMins: 300, remainingPercent: 140 }, 'codex'), '5 horas: sin dato');
});

test('quotas: current, stale (with its age) and no data in one line saying why and what to do', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const codex = { status: 'available', source: 'account/rateLimits/read', observedAt: seconds(now - 60_000),
    windows: [{ limitId: 'codex', window: 'secondary', windowDurationMins: 10080, remainingPercent: 92, resetsAt: seconds(now + 86400_000) }] };
  const current = quotaView('codex', codex, false, now);
  assert.equal(current.state, 'current');
  assert.ok(current.state !== 'none' && current.windows[0].line.startsWith('Semana: 92 % libre · se reinicia el '));
  assert.ok(current.state !== 'none' && current.age === 'hace 1 min');
  // Older than five minutes, transport stale, or a reset already passed: stale, never current.
  const old = { ...codex, observedAt: seconds(now - 11 * 3600_000) };
  const stale = quotaView('codex', old, false, now);
  assert.equal(stale.state, 'stale');
  assert.ok(stale.state !== 'none' && stale.age === 'hace 11 h');
  assert.equal(quotaView('codex', codex, true, now).state, 'stale');
  assert.equal(quotaView('codex', { ...codex, observedAt: seconds(now - QUOTA_STALE_MS - 1000) }, false, now).state, 'stale');
  assert.equal(quotaView('codex', { ...codex, windows: [{ ...codex.windows[0], resetsAt: seconds(now - 1000) }] }, false, now).state, 'stale');
  // Never consulted (the runner's initial cache), and provider failures.
  assert.deepEqual(quotaView('codex', { available: false, error: 'Pulsa actualizar para consultar' }, false, now), { state: 'none', line: 'Sin consultar. Pulsa Actualizar para ver tu cuota.' });
  assert.match((quotaView('codex', { status: 'unavailable', reasonCode: 'deadline_exceeded', windows: [] }, false, now) as any).line, /tardó demasiado/);
  assert.match((quotaView('codex', { status: 'unavailable', reasonCode: 'invalid_rpc_json', windows: [] }, false, now) as any).line, /No se pudo consultar/);
  // Claude: the quota arrives only from a Claude session open in Jauría.
  assert.deepEqual(quotaView('claude', { status: 'unavailable', reasonCode: 'missing', windows: [] }, false, now),
    { state: 'none', line: 'Sin dato. Se actualiza cuando hay una sesión de Claude abierta en Jauría.' });
  assert.deepEqual(quotaView('claude', { status: 'unavailable', reasonCode: 'stale', observedAt: seconds(now - 11 * 3600_000), windows: [] }, false, now),
    { state: 'none', line: 'Último dato hace 11 h, ya vencido. Se actualiza cuando hay una sesión de Claude abierta en Jauría.' });
  assert.equal(quotaView('claude', undefined, false, now).state, 'none');
  // No jargon in any line.
  for (const view of [current, stale, quotaView('claude', undefined, false, now)]) assert.doesNotMatch(JSON.stringify(view), /rateLimits|statusline|Fuente|RSS/);
});

const row = (pid: number, rss: number, cpu: number | null, extra: Record<string, unknown> = {}) =>
  ({ pid, available: true, rssBytes: rss * MiB, cpuPercent: cpu, cpuAvailable: cpu !== null, cpuUnavailableReason: cpu === null ? 'warming_up' : null, ...extra });

test('resources: one row per open session with its children, runner, window with its web engine, and the total', () => {
  const snapshot = { resources: {
    timestampUnixMs: Date.now(),
    processes: [
      row(10, 6, 0.2, { role: 'runner' }),
      row(11, 2, 0, { role: 'tool' }),
      row(20, 100, 12, { role: 'cli', sessionId: 's-claude' }),
      row(21, 50, 3, { role: 'tool', sessionId: 's-claude' }),
      row(30, 80, null, { role: 'cli', sessionId: 's-codex' }),
      { pid: 31, available: false, rssBytes: null, cpuPercent: null, sessionId: 's-codex' },
    ],
    discovery: { partial: false },
    app: { webEngine: 'included', discovery: { partial: false }, processes: [row(1, 107, 1.5, { role: 'app' }), row(2, 216, 4, { role: 'web' }), row(3, 29, 0.5, { role: 'web' })] },
  } };
  const titles: Record<string, string> = { 's-claude': 'Refactor del pago', 's-codex': 'Codex · pruebas' };
  const view = resourceView(snapshot, id => titles[id] ?? null);
  assert.deepEqual(view.sessions.map(s => [s.label, s.rss! / MiB, s.cpu, s.cpuPending, s.processes]), [
    ['Codex · pruebas', 80, null, true, 1],
    ['Refactor del pago', 150, 15, false, 2],
  ]);
  assert.deepEqual([view.runner!.rss! / MiB, view.runner!.cpu], [8, 0.2]);
  assert.deepEqual([view.window!.rss! / MiB, view.window!.cpu, view.window!.processes], [352, 6, 3]);
  assert.equal(view.webEngine, true);
  assert.equal(view.total!.rss! / MiB, 8 + 150 + 80 + 352);
  assert.equal(view.total!.cpu, 0.2 + 15 + 6);
  assert.equal(view.total!.cpuPending, true);
  assert.equal(formatResourceCpu(view.sessions[0]), 'midiendo…');
  assert.equal(formatResourceRam(view.sessions[1]), '150 MiB');
  assert.equal(view.missing, null);
  // The status bar shows the view's total, same definition.
  assert.equal(telemetrySummary(view, true), `Jauría · CPU ${formatTelemetryCpu(view.total!.cpu)} · RAM ${formatTelemetryBytes(view.total!.rss)}`);
  assert.equal(telemetrySummary(view, true), 'Jauría · CPU 21,2 % · RAM 590 MiB');
  assert.equal(telemetrySummary(null, true), 'Jauría · CPU — · RAM —');
  assert.equal(telemetrySummary(view, false), 'Recursos sin conexión');
  // Unknown session id: a neutral name, never a PID.
  assert.equal(resourceView(snapshot, () => null).sessions[0].label, 'Sesión');
});

test('resources: the web engine flag, what may be missing, and empty data', () => {
  const base = { processes: [row(10, 6, 0, { role: 'runner' })], app: { webEngine: 'not_attributable', processes: [row(1, 100, 1)] } };
  assert.equal(resourceView({ resources: base }, () => null).webEngine, false);
  assert.equal(resourceView({ resources: { ...base, discovery: { partial: true, reason: 'descendant_cap' } } }, () => null).missing,
    'Puede faltar algún proceso: una sesión tiene más de 128 procesos y solo se cuentan esos.');
  // A process that ended during the read is not missing: no warning.
  assert.equal(resourceView({ resources: { ...base, discovery: { partial: true, reason: 'descendant_changed_or_exited' } } }, () => null).missing, null);
  const empty = resourceView(null, () => null);
  assert.deepEqual([empty.sessions, empty.runner, empty.window, empty.total], [[], null, null, null]);
  assert.equal(formatResourceCpu(null), '—');
  assert.equal(formatResourceRam(null), '—');
});

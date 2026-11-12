import assert from 'node:assert/strict';
import { formatTelemetryBytes, formatTelemetryCpu, formatTelemetryPercent, formatTelemetryTime, formatTelemetryWindow } from '../src/telemetry.ts';

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
assert.equal(formatTelemetryBytes(1024 ** 2), '1 MiB');
assert.equal(formatTelemetryBytes(1.5 * 1024 ** 3), '1,5 GiB');
for (const invalid of [undefined, null, '', 'not-a-date', NaN, {}]) {
  assert.equal(formatTelemetryTime(invalid), 'No informada');
}
assert.notEqual(formatTelemetryTime('2026-11-11T22:30:00Z'), 'No informada');
assert.equal(formatTelemetryTime(1_794_436_200), formatTelemetryTime(1_794_436_200_000));
assert.equal(formatTelemetryTime(Infinity), 'No informada');
assert.equal(formatTelemetryTime(-1), 'No informada');
assert.equal(formatTelemetryTime(1e20), 'No informada');
assert.equal(formatTelemetryWindow({ windowDurationMins: 300, limitId: 'codex' }), '5 h · codex');
assert.equal(formatTelemetryWindow({ windowDurationMins: 10080 }), '7 d');
assert.equal(formatTelemetryWindow({ windowDurationMins: 45 }), '45 min');
assert.equal(formatTelemetryWindow({ window: 'secondary' }), 'Secundaria');
assert.equal(formatTelemetryWindow({ label: 'Personalizada' }), 'Personalizada');
assert.equal(formatTelemetryWindow(null), 'Ventana sin nombre');
console.log('Telemetry formatting passed: absent/invalid values, quota bounds, multicore CPU, binary RAM units and timestamps.');

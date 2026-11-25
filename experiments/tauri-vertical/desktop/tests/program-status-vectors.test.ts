/** Shared vectors (runner/src/agent_signals.rs) against the client parser and the installed xterm. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
Object.assign(globalThis, { self: globalThis });
const { Terminal } = require('@xterm/xterm');
const temporary = await mkdtemp(join(tmpdir(), 'jauria-parity-'));
const output = join(temporary, 'parity.mjs');
await build({ entryPoints: ['tests/fixtures/program-status-parity.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { checkVector } = await import(pathToFileURL(output).href);
const { parseProgramStatus } = await import('../src/program-status.ts');
after(() => rm(temporary, { recursive: true, force: true }));
const vectors = JSON.parse(readFileSync(new URL('./fixtures/program-status-vectors.json', import.meta.url), 'utf8'));

/** Byte payloads reach the client as the string xterm decodes (invalid UTF-8 dropped), never raw. */
async function xtermPayload(base64: string): Promise<string> {
  const term = new Terminal({ allowProposedApi: true });
  let payload = '';
  term.parser.registerOscHandler(7501, (data: string) => { payload = data; return true; });
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  await new Promise<void>(resolve => term.write(Uint8Array.from([0x1b, 0x5d, ...Buffer.from('7501;'), ...bytes, 0x07]), resolve));
  term.dispose();
  return payload;
}

test('shared payload vectors match parseProgramStatus', async () => {
  for (const vector of vectors.payloads) {
    const payload = typeof vector.payloadBase64 === 'string' ? await xtermPayload(vector.payloadBase64) : vector.payload;
    assert.equal(parseProgramStatus(payload), vector.expect, vector.name);
  }
});

test('shared stream vectors match the installed xterm and the client handlers (whole, every cut, byte by byte)', async () => {
  const failures: Record<string, string[]> = {};
  for (const vector of vectors.streams) {
    const problems = await checkVector(() => new Terminal({ allowProposedApi: true }), vector);
    if (problems.length) failures[vector.name] = problems;
  }
  assert.deepEqual(failures, {}, 'a mismatch is a runner finding: never edit the vector to match');
});

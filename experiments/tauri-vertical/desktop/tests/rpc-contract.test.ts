/**
 * Client side of the RPC contract table (tests/fixtures/rpc-contract.json).
 * The bridge (src-tauri rpc_contract_tests) and the runner (rpc_contract.rs,
 * pulso.rs) check that every entry is accepted; this file checks that the
 * table covers what the client actually sends: every literal operation in a
 * request call of src/*.ts is listed, and every key of its inline argument
 * object appears in some entry of that operation. Static and synthetic only.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

type Entry = { op: string; args: Record<string, unknown>; via?: string };
const contract = JSON.parse(await readFile(new URL('./fixtures/rpc-contract.json', import.meta.url), 'utf8')) as { runner: Entry[]; pulso: Entry[] };
const entries = [...contract.runner, ...contract.pulso];
const keysByOp = new Map<string, Set<string>>();
for (const e of entries) { const set = keysByOp.get(e.op) ?? new Set(); for (const k of Object.keys(e.args)) set.add(k); keysByOp.set(e.op, set); }

const srcDir = new URL('../src/', import.meta.url);
const files = (await readdir(srcDir)).filter(f => f.endsWith('.ts'));
const sources = new Map(await Promise.all(files.map(async f => [f, await readFile(new URL(f, srcDir), 'utf8')] as const)));

/** Balanced `{...}` starting at `start` (strings and template literals skipped). */
function objectLiteral(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { const close = text.indexOf(c, i + 1); if (close < 0) return null; i = close; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
/** Top-level keys of an object literal; spreads of inline literals or conditionals contribute their keys. */
function keys(literal: string): string[] {
  const body = literal.slice(1, -1); const parts: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"' || c === '`') { i = body.indexOf(c, i + 1); continue; }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(from, i)); from = i + 1; }
  }
  parts.push(body.slice(from));
  const result: string[] = [];
  for (const raw of parts.map(p => p.trim()).filter(Boolean)) {
    if (raw.startsWith('...')) {
      // ...(cond ? { a } : {}) or ...{ a: 1 }: keys of the inner literals; ...identifier is opaque.
      for (const inner of raw.matchAll(/\{([^{}]*)\}/g)) for (const part of inner[1].split(',')) { const k = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part); if (k) result.push(k[1]); }
      continue;
    }
    const k = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(raw); if (k) result.push(k[1]);
  }
  return result;
}

// request('op', …), request<T>('op', …), requestPulso('op', …), #request('op', …), rpc('op', …), write('op', …), page<T>('op', …)
const call = /(?:\b(?:request|requestPulso|rpc|write|page|confirm)|#request)\s*(?:<[^()]*?>)?\(\s*'([a-z_]+)'\s*(?:,\s*)?/g;
const found: { file: string; op: string; keys: string[] | null }[] = [];
for (const [file, text] of sources) {
  for (const match of text.matchAll(call)) {
    const at = match.index! + match[0].length;
    const literal = objectLiteral(text, at);
    found.push({ file, op: match[1], keys: literal ? keys(literal) : null });
  }
}

test('the scan finds the client calls (sanity)', () => {
  const ops = new Set(found.map(f => f.op));
  for (const op of ['status', 'set_settings', 'mark_seen', 'terminal_live', 'sidebar_summary', 'board', 'item_create', 'codex_interrupt']) assert.ok(ops.has(op), op);
  // The extractor itself, on the shapes the client uses.
  assert.deepEqual(keys("{ id, kind, title, rows: 24, cols: 80, ...(cwd ? { cwd } : {}) }"), ['id', 'kind', 'title', 'rows', 'cols', 'cwd']);
  assert.deepEqual(keys("{id:s.id,data:`x,${y}`,...p}"), ['id', 'data']);
  assert.deepEqual(keys("{ maxConcurrentSessions, pulsoAutoAccess }"), ['maxConcurrentSessions', 'pulsoAutoAccess']);
  // A key the table does not list would be reported.
  assert.equal(keysByOp.get('set_settings')!.has('force'), false);
});

test('every operation the client sends is in the contract table', () => {
  const missing = found.filter(f => !keysByOp.has(f.op)).map(f => `${f.file}: ${f.op}`);
  assert.deepEqual(missing, []);
});

test('every key of an inline argument object is in the table for that operation', () => {
  const extra: string[] = [];
  for (const f of found) for (const k of f.keys ?? []) if (!keysByOp.get(f.op)?.has(k)) extra.push(`${f.file}: ${f.op}.${k}`);
  assert.deepEqual(extra, []);
});

test('every table operation is still sent by the client', () => {
  const all = [...sources.values()].join('\n');
  const stale = [...keysByOp.keys()].filter(op => !all.includes(`'${op}'`));
  assert.deepEqual(stale, []);
});

const temporary = await mkdtemp(join(tmpdir(), 'jauria-rpc-contract-'));
after(() => rm(temporary, { recursive: true, force: true }));
test('set_settings: the payload the app builds for each settingsVersion is a table entry', async () => {
  const out = join(temporary, 'settings.mjs');
  await build({ entryPoints: [new URL('../src/settings-panel.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: out, loader: { '.css': 'empty' }, logLevel: 'silent' });
  const { settingsArgs } = await import(pathToFileURL(out).href);
  const table = contract.runner.filter(e => e.op === 'set_settings').map(e => JSON.stringify(e.args));
  assert.ok(table.includes(JSON.stringify(settingsArgs(1, 3, undefined))));
  assert.ok(table.includes(JSON.stringify(settingsArgs(1, 3, true))), 'settingsVersion 1 never sends pulsoAutoAccess');
  assert.ok(table.includes(JSON.stringify(settingsArgs(2, 3, true))));
  assert.ok(table.includes(JSON.stringify(settingsArgs(2, 8, false))));
  assert.ok(table.includes(JSON.stringify(settingsArgs(2, 3, undefined))), 'schema 1 settings on a v2 runner: only the limit');
});

/** Real review panel with a minimal DOM and workflow RPC mock. No WebKit,
 * layout, verification commands, native UI or providers are exercised.
 * Run: node --experimental-strip-types --test tests/review-panel-lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test, type TestContext } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import type { Task } from '../src/tasks.ts';

// Node does not load CSS. Leave the component's TypeScript and runtime intact.
const css = new URL('../src/review-panel.css', import.meta.url).href;
const hook = registerHooks({ load(url, context, next) {
  return url === css ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
let mountReviewPanel: typeof import('../src/review-panel.ts').mountReviewPanel;
try { ({ mountReviewPanel } = await import('../src/review-panel.ts')); }
finally { hook.deregister(); }

class Element {
  parent: Element | null = null; children: Element[] = [];
  dataset: Record<string, string> = {}; id = ''; className = ''; value = '';
  hidden = false; disabled = false; checked = false; type = ''; ownText = '';
  listeners = new Map<string, (() => void)[]>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get isConnected(): boolean { return this.tagName === 'body' || !!this.parent?.isConnected; }
  get textContent(): string { return this.ownText + this.children.map(n => n.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.ownText = value; }
  get options() { return this.children; }
  setAttribute(_name: string, _value: string) {}
  append(...nodes: Element[]) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes: Element[]) { for (const n of this.children) n.parent = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  contains(node: Element): boolean { return this === node || this.children.some(n => n.contains(node)); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(n => [n, ...n.querySelectorAll('*')]).filter(n =>
      selector === '*' || (selector.startsWith('#') ? n.id === selector.slice(1) :
        selector === '[data-review-focus]' ? n.dataset.reviewFocus !== undefined :
          selector === 'input[type=checkbox]' ? n.tagName === 'input' && n.type === 'checkbox' : n.tagName === selector));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  dispatch(name: string) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  focus() { documentMock.activeElement = this; }
}
class TextArea extends Element {}
class OptionElement extends Element {
  constructor(label: string, value: string) { super('option'); this.textContent = label; this.value = value; }
}
const documentMock = { activeElement: null as Element | null, createElement: (tag: string) => tag === 'textarea' ? new TextArea(tag) : new Element(tag) };
const task = (id: string): Task => ({ id, projectId: 'p', title: id, objective: 'Goal', acceptanceCriteria: '', baseSha: 'base', branch: `task/${id}`, worktreePath: `/fixture/${id}`, state: 'ready', error: null });
const workflow = { archived: false, artifacts: ['snap-a', 'snap-b'].map(id => ({ id, kind: 'snapshot', data: { snapshot: { fingerprint: id } } })) };

function fixture(t: TestContext, lookupOnSelect = false) {
  for (const [key, value] of Object.entries({ document: documentMock, HTMLElement: Element, HTMLTextAreaElement: TextArea, Option: OptionElement })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  documentMock.activeElement = null;
  const body = new Element('body'), host = new Element('div'), verificationHost = new Element('section');
  verificationHost.id = 'verification-panel-host'; body.append(host, verificationHost);
  const calls: { task: string | null; snapshot: string | null; connected: boolean }[] = [];
  const reads: string[] = [];
  let read = async (_id: string) => workflow;
  const request = (async (op: string, args: Record<string, unknown>) => {
    assert.equal(op, 'workflow', 'Lifecycle selection must not execute mutations');
    reads.push(String(args.id)); return read(String(args.id));
  }) as Parameters<typeof mountReviewPanel>[1];
  const panel = mountReviewPanel(host as unknown as HTMLElement, request, async () => assert.fail('No native confirmation expected'), {
    host: verificationHost as unknown as HTMLElement,
    select(selected, snapshot) {
      // The fixed parent captures this node once. A document lookup would be
      // null after renderContents removes it, including consecutive null selects.
      const target = lookupOnSelect ? body.querySelector('#verification-panel-host')! : verificationHost;
      target.hidden = false;
      calls.push({ task: selected?.id ?? null, snapshot, connected: verificationHost.isConnected });
    },
  });
  t.after(() => panel.dispose());
  return { panel, body, host, verificationHost, calls, reads, setRead: (fn: typeof read) => { read = fn; } };
}

test('cached verification host survives snapshot selection, repeated null, same task and another task', async t => {
  const f = fixture(t);
  f.panel.select(task('a')); await settle();
  assert.equal(f.body.querySelector('#verification-panel-host'), f.verificationHost);
  const selector = f.host.querySelectorAll('select').find(n => n.dataset.reviewFocus === 'snapshot');
  assert.ok(selector); selector.value = 'snap-b'; selector.dispatch('change');
  assert.equal(f.calls.at(-1)?.snapshot, 'snap-b');
  f.panel.select(null);
  assert.equal(f.verificationHost.isConnected, false);
  assert.equal(f.body.querySelector('#verification-panel-host'), null, 'Detachment must have real query semantics');
  f.panel.select(null); // Callback runs while the host is already detached.
  f.panel.select(task('a'));
  assert.equal(f.body.querySelector('#verification-panel-host'), f.verificationHost);
  assert.equal(f.calls.at(-1)?.snapshot, 'snap-b', 'Same-task snapshot selection survives detachment');
  f.panel.select(task('b')); await settle();
  assert.equal(f.body.querySelector('#verification-panel-host'), f.verificationHost);
  assert.equal(f.calls.at(-1)?.task, 'b'); assert.equal(f.calls.at(-1)?.snapshot, 'snap-a');
  f.panel.select(null); f.panel.select(null);
  assert.ok(f.calls.some(c => !c.connected), 'Exercise callback with a detached host, not only attached renders');
  assert.deepEqual(f.reads, ['a', 'b']);
  assert.equal(f.verificationHost.children.length, 0);
});

test('late workflow response after deselect cannot reattach a stale verification host', async t => {
  const f = fixture(t); f.panel.select(task('a')); await settle();
  let resolve!: (value: typeof workflow) => void;
  f.setRead(() => new Promise(yes => { resolve = yes; }));
  f.panel.select(task('b')); f.panel.select(null); f.panel.select(null);
  const calls = f.calls.length; resolve(workflow); await settle();
  assert.equal(f.calls.length, calls, 'Stale completion must not select verification for the old task');
  assert.equal(f.body.querySelector('#verification-panel-host'), null);
  f.panel.select(task('b'));
  assert.equal(f.body.querySelector('#verification-panel-host'), f.verificationHost);
  assert.equal(f.calls.at(-1)?.task, 'b');
  f.panel.select(null); f.panel.select(null);
});

test('negative control reproduces the old document-lookup callback failure after detachment', async t => {
  const f = fixture(t, true); f.panel.select(task('a')); await settle();
  f.panel.select(null);
  assert.equal(f.body.querySelector('#verification-panel-host'), null);
  assert.throws(() => f.panel.select(null), TypeError, 'The harness must expose the original null.hidden regression');
});

/** Unit tests of the real component with DOM/IPC/lifecycle mocks only.
 * No WebKit, layout, native dialog, process execution or provider is exercised.
 * Run from desktop: node --experimental-strip-types --test tests/*.test.ts
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { mountCodexConversation, type Rpc } from '../src/codex-conversation.ts';

type Data = Record<string, any>;
type Listener = (event: Data) => void;

// Only the DOM operations used by the component. No CSS, HTML parsing, browser
// event defaults, focus navigation or rendering are simulated. Unsafe HTML fails.
class MockElement {
  tagName: string; className = ''; parent: MockElement | null = null;
  children: MockElement[] = []; attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>(); ownText = '';
  hidden = false; disabled = false; value = ''; type = ''; rows = 0;
  maxLength = 0; tabIndex = 0; scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  selectionStart = 0; selectionEnd = 0;
  constructor(tag: string) { this.tagName = tag; }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.ownText = value; }
  set innerHTML(_value: string) { assert.fail('Provider content must never reach innerHTML'); }
  get isConnected(): boolean { return this.tagName === 'host' || !!this.parent?.isConnected; }
  classList = { toggle: (name: string, enabled: boolean) => {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    if (enabled) names.add(name); else names.delete(name);
    this.className = [...names].join(' ');
  } };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: MockElement[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: MockElement[]) { for (const child of this.children) child.parent = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  dispatch(name: string, fields: Data = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  focus() { mockDocument.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
}
const mockDocument = { createElement: (tag: string) => new MockElement(tag), activeElement: null as MockElement | null };
const walk = (node: MockElement): MockElement[] => [node, ...node.children.flatMap(walk)];
const settle = async () => { await nextImmediate(); };
function deferred<T = Data>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ready(id = 'a', extra: Data = {}): Data {
  return { sessionId: id, generation: 1, nativeThreadId: 'native-thread', connectionStatus: 'running', status: 'idle', turns: [], requests: [], ...extra };
}
const turn = (extra: Data = {}): Data => ({ turnId: 'turn', attemptId: 'attempt', generation: 1, nativeTurnId: 'native-turn', status: 'running', ...extra });
const permission = (extra: Data = {}): Data => ({ ...turn(), id: 'permission', method: 'item/commandExecution/requestApproval', status: 'pending', ...extra });
function identity(args: Data): Data {
  return { sessionId: args.id, turnId: args.turnId, attemptId: args.attemptId, generation: args.generation };
}
function fixture(t: TestContext) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: mockDocument });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); });
  let timerId = 0, seq = 0;
  const timers = new Map<number, () => void>();
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, delay: number) => { assert.equal(delay, 3000); timers.set(++timerId, fn); return timerId; });
  t.mock.method(globalThis, 'clearTimeout', (id: number) => { timers.delete(id); });
  const host = new MockElement('host');
  const calls: { op: string; args: Data; transport: 'request' | 'confirm' }[] = [];
  const f = {
    host, timers, calls, snapshot: ready(),
    read: (args: Data): unknown => ({ ...f.snapshot, sessionId: args.id }),
    command: (_args: Data): unknown => { throw new Error('Unexpected read-only command query'); },
    mutate: (_op: string, _args: Data): unknown => { throw new Error('Unexpected mutation'); },
    confirm: (_op: string, _args: Data): unknown => { throw new Error('Unexpected confirmation'); },
    view: null! as ReturnType<typeof mountCodexConversation>,
    nodes: (tag: string) => walk(host).filter(n => n.tagName === tag),
    byClass: (name: string) => walk(host).filter(n => n.className.split(/\s+/).includes(name)),
    button: (text: string) => { const b = f.nodes('button').find(n => n.textContent === text); assert.ok(b, `Missing button: ${text}`); return b; },
    input: () => { const input = f.nodes('textarea')[0]; assert.ok(input); return input; },
    draft: (text: string) => { f.input().value = text; f.input().dispatch('input'); },
    click: async (text: string) => { const b = f.button(text); assert.equal(b.disabled, false, `${text} must be enabled`); assert.equal(b.hidden, false);
      // Explicitly drive form submission; this mock has no browser default actions.
      if (b.type === 'submit') f.nodes('form')[0].dispatch('submit'); else b.dispatch('click');
      await settle(); },
    selected: async (id = 'a') => { f.view.select({ id, status: 'running' }); await settle(); },
    poll: async () => { assert.equal(timers.size, 1); const [id, callback] = [...timers][0]; timers.delete(id); callback(); await settle(); },
    sent: (op: string) => calls.filter(c => c.op === op),
    emit: (method: string, params: Data, kind = 'provider.data') => {
      const event = { seq: ++seq, sessionId: 'a', kind, data: JSON.stringify({ method, params, turnId: 'turn', attemptId: 'attempt', generation: 1 }) };
      f.view.applyEvent(event); return event;
    },
    mount: () => {
      const request = (async (op: string, args: Data) => { calls.push({ op, args, transport: 'request' }); return op === 'codex_state' ? f.read(args) : op === 'codex_command' ? f.command(args) : f.mutate(op, args); }) as Rpc;
      const confirm = (async (op: string, args: Data) => { calls.push({ op, args, transport: 'confirm' }); return f.confirm(op, args); }) as Rpc;
      f.view = mountCodexConversation(host as unknown as HTMLElement, request, confirm);
    }
  };
  f.mount(); t.after(() => f.view.dispose()); return f;
}

test('ordered provider replay before select: final replaces deltas; bounded history and purge stay partial', async t => {
  const f = fixture(t);
  f.emit('item/agentMessage/delta', { itemId: 'message', delta: 'hello ' }, 'provider');
  const duplicate = f.emit('item/agentMessage/delta', { itemId: 'message', delta: 'world' });
  f.view.applyEvent(duplicate);
  f.emit('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'hello world', status: 'completed' } });
  f.emit('item/agentMessage/delta', { itemId: 'message', delta: 'late delta' });
  assert.equal(f.calls.length, 0, 'Replay before selection performs no IPC');
  await f.selected();
  assert.equal(f.byClass('codex-conversation-entry').length, 1);
  assert.equal(f.nodes('pre')[0].textContent, 'hello world');
  f.emit('item/started', { item: { id: 'command', type: 'commandExecution', command: 'git status', cwd: '/fixture', status: 'inProgress' } });
  f.emit('item/commandExecution/outputDelta', { itemId: 'command', delta: 'working tree clean' });
  assert.match(f.nodes('pre')[1].textContent, /working tree clean/);
  f.emit('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'git status', cwd: '/fixture', aggregatedOutput: 'working tree clean', exitCode: 0, status: 'completed' } });
  assert.equal(f.nodes('pre')[1].textContent, 'git status\nDirectorio: /fixture\nworking tree clean\nCódigo de salida: 0');
  const markup = '<img src=x onerror=alert(1)> 中文 🙂';
  f.emit('item/completed', { item: { id: 'markup', type: 'agentMessage', text: markup } });
  assert.equal(f.nodes('pre')[2].textContent, markup);
  assert.equal(f.nodes('img').length, 0);
  for (let i = 0; i < 270; i++) f.emit('notice', { text: `notice ${i}` }, 'notice');
  assert.equal(f.byClass('codex-conversation-entry').length, 256);
  f.emit('item/completed', { item: { id: 'large', type: 'agentMessage', text: '🙂'.repeat(180000) } });
  assert.ok(Buffer.byteLength(f.byClass('codex-conversation-history')[0].textContent) <= 512 * 1024);
  assert.equal(f.byClass('codex-conversation-partial')[0].hidden, false);
  const purge = { ...duplicate, seq: 1000, kind: 'purged', data: '{}' };
  f.view.applyEvent(purge); f.view.applyEvent(duplicate);
  assert.equal(f.byClass('codex-conversation-entry').length, 0);
  assert.equal(f.byClass('codex-conversation-partial')[0].hidden, false);
  assert.match(f.byClass('codex-conversation-partial')[0].textContent, /eliminada/);
});

test('lost RPC: read-only command queries retain absent running submissions and observed uncertain drafts', async t => {
  const f = fixture(t); await f.selected(); f.draft('keep this prompt');
  f.mutate = () => { throw new Error('IPC reply lost'); };
  await f.click('Enviar');
  const original = structuredClone(f.sent('codex_turn')[0].args);
  for (const key of ['commandId', 'turnId', 'attemptId']) assert.match(original[key], /^[0-9a-f-]{36}$/);
  assert.equal(f.input().value, original.prompt);
  assert.deepEqual((f.view.saveDraft('a') as Data).pending, original);
  await f.poll(); await f.click('Actualizar estado');
  assert.equal(f.sent('codex_turn').length, 1, 'State refresh never replays a send');
  // Absent is not permission to send again while the original connection lives.
  f.command = args => {
    assert.deepEqual(args, original);
    return { observed: false, shouldSend: false, currentGeneration: 1, connectionStatus: 'running' };
  };
  await f.click('Consultar el mismo envío');
  await f.poll();
  await f.click('Consultar el mismo envío');
  assert.deepEqual((f.view.saveDraft('a') as Data).pending, original);
  assert.equal(f.input().value, original.prompt);
  assert.equal(f.button('Enviar').disabled, true);
  f.command = args => ({ observed: true, ...identity(args), shouldSend: false, commandState: 'uncertain', turnStatus: 'interrupted', nativeTurnId: null });
  await f.click('Consultar el mismo envío');
  assert.deepEqual(f.sent('codex_command').map(call => call.args), [original, original, original]);
  assert.ok(f.sent('codex_command').every(call => call.transport === 'request'));
  assert.equal(f.sent('codex_turn').length, 1, 'Consulting must never invoke the send RPC again');
  assert.equal(f.input().value, original.prompt);
  assert.equal((f.view.saveDraft('a') as Data).pending, null);
  assert.match(f.byClass('codex-conversation-feedback')[0].textContent, /sin entrega confirmada/);
});

test('queued_once clears only after durable acceptance; polling keeps composer identity, selection and newer text', async t => {
  const f = fixture(t); await f.selected(); f.draft('first prompt');
  const input = f.input(); input.focus(); input.setSelectionRange(2, 5);
  await f.poll(); assert.equal(f.input(), input); assert.equal(mockDocument.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  input.dispatch('keydown', { key: 'Enter' });
  input.dispatch('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  assert.equal(f.sent('codex_turn').length, 0);
  const accepted = deferred(); f.mutate = () => accepted.promise;
  input.dispatch('keydown', { key: 'Enter', metaKey: true }); await settle();
  assert.equal(input.value, 'first prompt', 'No clearing while IPC is unresolved');
  const args = f.sent('codex_turn')[0].args;
  accepted.resolve({ ...identity(args), shouldSend: false, delivery: 'queued_once' }); await settle();
  assert.equal(input.value, ''); assert.equal(f.sent('codex_turn').length, 1);
  const next = deferred(); f.mutate = () => next.promise; f.draft('second prompt');
  f.nodes('form')[0].dispatch('submit'); await settle(); f.draft('new draft during RPC');
  next.resolve({ ...identity(f.sent('codex_turn')[1].args), shouldSend: false, delivery: 'queued_once' }); await settle();
  assert.equal(input.value, 'new draft during RPC');
});

test('saveDraft/restoreDraft into a new mount preserves pending identity across parent reconnect without autosend', async t => {
  const f = fixture(t); await f.selected(); f.draft('survive reconnect');
  f.mutate = () => { throw new Error('disconnected'); }; await f.click('Enviar');
  const original = structuredClone(f.sent('codex_turn')[0].args), saved = f.view.saveDraft('a');
  f.view.select(null); const before = f.calls.length; await settle();
  assert.equal(f.calls.length, before); assert.equal(f.timers.size, 0);
  f.view.dispose(); f.mount(); f.view.restoreDraft('a', saved);
  assert.equal(f.calls.length, before, 'Restoring state performs no IPC');
  await f.selected(); await f.poll();
  assert.equal(f.input().value, original.prompt);
  assert.deepEqual((f.view.saveDraft('a') as Data).pending, original);
  assert.equal(f.sent('codex_turn').length, 1);
  f.command = args => ({ observed: true, ...identity(args), shouldSend: false, commandState: 'uncertain', turnStatus: 'interrupted', nativeTurnId: null });
  await f.click('Consultar el mismo envío');
  assert.deepEqual(f.sent('codex_command')[0].args, original);
  assert.equal(f.input().value, original.prompt);
  // Release an absent submission only with evidence the original connection
  // closed or changed generation; neither condition clears the user's text.
  for (const absent of [
    { currentGeneration: 1, connectionStatus: 'closed' },
    { currentGeneration: 2, connectionStatus: 'running' },
  ]) {
    f.view.dispose(); f.mount(); f.view.restoreDraft('a', saved);
    f.snapshot = ready('a', { generation: absent.currentGeneration });
    await f.selected();
    assert.deepEqual((f.view.saveDraft('a') as Data).pending, original);
    f.command = args => {
      assert.deepEqual(args, original);
      return { observed: false, shouldSend: false, ...absent };
    };
    await f.click('Consultar el mismo envío');
    assert.equal((f.view.saveDraft('a') as Data).pending, null);
    assert.equal(f.input().value, original.prompt);
    assert.equal(f.button('Consultar el mismo envío').hidden, true);
  }
  assert.equal(f.sent('codex_turn').length, 1, 'Reconnect and absent queries never resend');
  assert.equal(f.sent('codex_command').length, 3);
});

test('readiness false and starting/unbound connections block sends; resume requires historical native turns', async t => {
  const f = fixture(t); f.snapshot = ready('a', { connectionStatus: 'starting', nativeThreadId: null });
  await f.selected(); f.draft('not yet');
  for (const state of [
    { connectionStatus: 'starting', nativeThreadId: 'thread' },
    { connectionStatus: 'running', nativeThreadId: null },
    { connectionStatus: 'running', nativeThreadId: 'thread', acceptingTurns: false },
  ]) {
    f.snapshot = ready('a', state); await f.click('Actualizar estado');
    assert.equal(f.button('Enviar').disabled, true);
    f.input().dispatch('keydown', { key: 'Enter', ctrlKey: true }); await settle();
    f.nodes('form')[0].dispatch('submit'); await settle();
    assert.equal(f.sent('codex_turn').length, 0, 'Keyboard and form must obey connection/readiness gating');
  }
  for (const acceptingTurns of [undefined, true]) {
    f.snapshot = ready('a', { acceptingTurns }); await f.click('Actualizar estado');
    assert.equal(f.button('Enviar').disabled, false, 'Optional readiness permits sending unless explicitly false');
  }
  for (const hasNativeTurns of [undefined, false]) {
    f.snapshot = ready('a', { status: 'closed', hasNativeTurns, turns: [] }); await f.click('Actualizar estado');
    assert.equal(f.button('Continuar conversación').disabled, true);
  }
  f.snapshot = ready('a', { status: 'closed', hasNativeTurns: true, turns: [], hasMoreTurns: true });
  await f.click('Actualizar estado');
  f.mutate = (op, args) => { assert.equal(op, 'codex_resume'); assert.deepEqual(args, { id: 'a', generation: 1 }); return { shouldSend: false }; };
  await f.click('Continuar conversación');
  assert.equal(f.sent('codex_resume').length, 1); assert.equal(f.sent('codex_turn').length, 0);
  assert.equal(f.input().value, 'not yet');
});

test('permissions use only native confirm; Unicode/bidi metadata is ASCII display only and errors remain visible', async t => {
  const f = fixture(t), p = permission(); f.snapshot = ready('a', { status: 'running', turns: [turn()], requests: [p] });
  const payload = { params: { command: 'printf "café 中文 🙂\u202etxt"', cwd: '/fixture/á', reason: '<script>evil()</script>' } };
  const original = structuredClone(payload);
  await f.selected(); assert.equal(f.button('Aceptar comando…').disabled, true);
  f.mutate = (op, args) => { assert.equal(op, 'codex_request'); assert.deepEqual(args, { id: 'a', requestId: p.id }); return { ...p, sessionId: 'a', payload }; };
  await f.click('Ver comando');
  const shown = f.byClass('codex-conversation-permission')[0].children.find(n => n.tagName === 'pre')!.textContent;
  assert.match(shown, /\\u00e9/); assert.match(shown, /\\u202e/);
  assert.ok([...shown].every(c => c.charCodeAt(0) <= 127)); assert.deepEqual(payload, original);
  const readAfterDecision = deferred();
  f.confirm = (op, args) => {
    assert.equal(op, 'codex_permission'); assert.deepEqual(args, { id: 'a', requestId: p.id, generation: 1, decision: 'accept' });
    f.read = () => readAfterDecision.promise; throw new Error('Native approval refused: stale request');
  };
  await f.click('Aceptar comando…');
  assert.match(f.byClass('codex-conversation-error')[0].textContent, /Native approval refused/);
  assert.equal(f.sent('codex_permission').length, 1);
  assert.equal(f.sent('codex_permission')[0].transport, 'confirm');
  assert.deepEqual(payload, original, 'Display escaping must not mutate backend metadata');
  f.snapshot = ready('a', { requests: [permission({ id: 'unsupported', method: 'item/fileChange/requestApproval' })] });
  f.read = args => ({ ...f.snapshot, sessionId: args.id }); readAfterDecision.resolve(f.snapshot); await settle();
  assert.ok(!f.nodes('button').some(b => b.textContent === 'Aceptar comando…'));
  f.confirm = (_op, args) => { assert.equal(args.decision, 'deny'); return { shouldSend: false }; };
  await f.click('Denegar…');
  assert.ok(f.sent('codex_permission').every(c => c.transport === 'confirm'));
});

test('interrupt ACK records intent only; a running turn stays running until observed state changes', async t => {
  const f = fixture(t); f.snapshot = ready('a', { status: 'running', turns: [turn()] }); await f.selected();
  f.mutate = (op, args) => {
    assert.equal(op, 'codex_interrupt');
    assert.deepEqual(args, { id: 'a', turnId: 'turn', attemptId: 'attempt', generation: 1 });
    return { shouldSend: false, status: 'cancel_requested' };
  };
  await f.click('Cancelar turno');
  assert.equal(f.button('Cancelación solicitada').disabled, true);
  assert.match(f.byClass('codex-conversation-turns')[0].textContent, /En ejecución/);
  assert.doesNotMatch(f.byClass('codex-conversation-turns')[0].textContent, /finalizado/);
  await f.poll(); assert.equal(f.sent('codex_interrupt').length, 1);
  f.snapshot = ready('a', { status: 'interrupted', turns: [turn({ status: 'interrupted', outcome: 'uncertain' })], hasNativeTurns: true });
  await f.click('Actualizar estado');
  assert.match(f.byClass('codex-conversation-turns')[0].textContent, /Interrumpido/);
});

test('selection races keep state polling sequential; stale generations and disposed responses cannot repaint or reschedule', async t => {
  const f = fixture(t), old = deferred(); f.read = () => old.promise;
  f.view.select({ id: 'a', status: 'running' });
  assert.equal(f.sent('codex_state').length, 1); assert.equal(f.timers.size, 0);
  f.view.select({ id: 'b', status: 'running' });
  // Programmatic duplicate refresh also cannot start a concurrent read.
  f.button('Actualizar estado').dispatch('click'); await settle();
  assert.equal(f.sent('codex_state').length, 1);
  old.resolve(ready('a', { generation: 99, status: 'closed' })); await settle();
  assert.match(f.host.textContent, /Conexión sin confirmar/); assert.equal(f.timers.size, 1);
  f.read = args => ready(args.id, { generation: 2 }); await f.poll();
  assert.equal(f.sent('codex_state').at(-1)!.args.id, 'b');
  f.draft('preserve selection'); f.input().setSelectionRange(3, 8);
  f.read = args => ready(args.id, { generation: 1, status: 'closed' }); await f.poll();
  assert.equal(f.button('Continuar conversación').hidden, true, 'Lower generation ignored');
  assert.equal(f.input().value, 'preserve selection'); assert.equal(f.input().selectionStart, 3);
  const late = deferred(); f.read = () => late.promise;
  await f.poll(); assert.equal(f.timers.size, 0);
  f.view.select(null); const count = f.calls.length; f.view.dispose();
  late.resolve(ready('b')); await settle();
  f.view.select({ id: 'c', status: 'running' }); f.emit('notice', { text: 'late event' });
  assert.equal(f.calls.length, count); assert.equal(f.host.children.length, 0); assert.equal(f.timers.size, 0);
});

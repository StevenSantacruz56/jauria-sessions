/** Controlled installed-xterm source harness; NOT a WKWebView reproduction.
 * Run from desktop: node --experimental-strip-types tests/terminal-keyboard.test.ts
 * No Terminal.open(), browser, user profile, provider, or dependency modification.
 * Fake default insertion/replacement is explicit below, never claimed as native evidence.
 */
import assert from 'node:assert/strict';
import { attachTerminalKeyboard } from '../src/terminal-keyboard.ts';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(require.resolve('@xterm/xterm')));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
assert.equal(version, '5.5.0', 'Reassess these expectations when the installed version changes');
const temporary = await mkdtemp(join(tmpdir(), 'jauria-xterm-keyboard-'));
try {
  const output = join(temporary, 'installed-xterm.mjs');
  await build({
    stdin: { contents: "export { Terminal } from 'browser/Terminal'; export { CompositionHelper } from 'browser/input/CompositionHelper'; export { handlePasteEvent } from 'browser/Clipboard';", resolveDir: root },
    resolveExtensions: ['.ts', '.js', '.d.ts'],
    bundle: true, platform: 'node', format: 'esm', outfile: output,
    alias: { browser: join(root, 'src/browser'), common: join(root, 'src/common') },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const { Terminal, CompositionHelper, handlePasteEvent } = await import(pathToFileURL(output).href);
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const classes = { add() {}, remove() {} };
  // Only event propagation/default insertion is simulated. Keyboard listeners use
  // actual _bindKeys(); clipboard listeners call actual handlePasteEvent in the
  // same target/root order as _initClipboard, before attaching the public helper.
  class FakeTarget {
    parent: FakeTarget | undefined;
    classList = classes;
    style = {};
    value = '';
    textContent = '';
    listeners: { type: string; handler: any; capture: boolean }[] = [];
    focus() {}
    getBoundingClientRect() { return { width: 8, height: 16 }; }
    addEventListener(type: string, handler: any, options: any = false) {
      this.listeners.push({ type, handler, capture: typeof options === 'boolean' ? options : !!options.capture });
    }
    removeEventListener(type: string, handler: any, options: any = false) {
      const capture = typeof options === 'boolean' ? options : !!options.capture;
      this.listeners = this.listeners.filter(l => !(l.type === type && l.handler === handler && l.capture === capture));
    }
    dispatchEvent(ev: any) {
      ev.target = this;
      const path: FakeTarget[] = [];
      for (let target: FakeTarget | undefined = this; target; target = target.parent) path.push(target);
      for (const capture of [true, false]) {
        for (const target of capture ? [...path].reverse() : path) {
          ev.currentTarget = target;
          for (const listener of [...target.listeners]) {
            if (listener.type === ev.type && listener.capture === capture) listener.handler(ev);
          }
          if (ev.stopped) return !ev.defaultPrevented;
        }
      }
      return !ev.defaultPrevented;
    }
  }
  function event(type: string, key = '', keyCode = 0) {
    return { type, key, keyCode, charCode: type === 'keypress' ? key.charCodeAt(0) : 0,
      which: keyCode, isComposing: false, bubbles: true, altKey: false, ctrlKey: false, metaKey: false, shiftKey: /^[A-Z]$/.test(key),
      defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, getModifierState() { return false; } };
  }
  function fixture(screenReaderMode: boolean) {
    const terminal = new Terminal({ screenReaderMode });
    // Real constructor, core service, keyboard evaluation, cancellation and composition code.
    // Only unopened rendering/focus surfaces are supplied; no input method is replaced.
    terminal.element = new FakeTarget();
    terminal.textarea = new FakeTarget();
    terminal.textarea.parent = terminal.element;
    // Explicit macOS branch selection, not a claim about a real native engine.
    terminal.browser = { ...terminal.browser, isMac: true, isWindows: false };
    terminal.focus = () => {}; // _keyUp normally focuses the unopened DOM terminal.
    terminal._compositionHelper = new CompositionHelper(terminal.textarea,
      new FakeTarget(), terminal._bufferService,
      terminal.optionsService, terminal.coreService, { dimensions: { css: { cell: { width: 8, height: 16 } } } });
    terminal._bindKeys();
    // Match _initClipboard's wrappers; clipboard logic itself is imported from
    // the installed source, including stopPropagation and paste normalization.
    const pasteHandler = (ev: any) => handlePasteEvent(ev, terminal.textarea, terminal.coreService, terminal.optionsService);
    for (const target of [terminal.textarea, terminal.element]) {
      target.addEventListener('paste', pasteHandler);
      terminal.register({ dispose() { target.removeEventListener('paste', pasteHandler); } });
    }
    const dispatch = (ev: any) => terminal.textarea.dispatchEvent(ev);
    function input(data: string, extra: any = {}) {
      const ev = Object.assign(event('input'), { data, inputType: 'insertText', composed: true }, extra);
      dispatch(ev);
      return ev;
    }
    const frames: string[] = [];
    terminal.onData((data: string) => frames.push(data));
    function browserPaste(text: string) {
      const requestedFormats: string[] = [];
      const clipboardData = {
        metadata: { source: 'synthetic clipboard fixture', text },
        getData(format: string) { requestedFormats.push(format); return format === 'text/plain' ? text : ''; },
      };
      const ev = Object.assign(event('paste'), { clipboardData });
      dispatch(ev);
      const afterHandler = terminal.textarea.value;
      // Explicit imposed browser default, AFTER all event handlers. This is not
      // a native engine trace. StopPropagation alone does not cancel insertion.
      if (!ev.defaultPrevented) {
        terminal.textarea.value += text;
        input(text, { inputType: 'insertFromPaste' });
      }
      assert.deepEqual(requestedFormats, ['text/plain'], 'upstream reads clipboard once; root bubble handler is stopped');
      return { prevented: ev.defaultPrevented, stopped: ev.stopped, afterHandler, afterDefault: terminal.textarea.value };
    }
    function type(text: string) {
      const trace = [];
      for (const key of text) {
        const code = key.toUpperCase().charCodeAt(0);
        const down = event('keydown', key, code);
        dispatch(down);
        const press = event('keypress', key, code);
        if (!down.defaultPrevented) dispatch(press);
        // A deliberately minimal DOM default, conditional on actual preventDefault.
        if (!down.defaultPrevented && !press.defaultPrevented) {
          terminal.textarea.value += key;
          input(key);
        }
        dispatch(event('keyup', key, code));
        trace.push({ key, downPrevented: down.defaultPrevented, pressPrevented: press.defaultPrevented });
      }
      return trace;
    }
    async function replacement229(replacement: string) {
      const down = event('keydown', 'Unidentified', 229);
      dispatch(down);
      assert.equal(down.defaultPrevented, false);
      terminal.textarea.value = replacement; // imposed engine-independent replacement
      await tick(); // actual CompositionHelper timeout, not a reimplementation
      dispatch(event('keyup', 'Unidentified', 229));
    }
    return { terminal, frames, type, replacement229, dispatch, input, browserPaste };
  }
  for (const screenReaderMode of [true, false]) {
    const f = fixture(screenReaderMode);
    try {
      const trace = f.type('aa ');
      assert.equal(f.frames.join(''), 'aa '); // intentional repeats survive
      assert.equal(f.terminal.textarea.value, screenReaderMode ? 'aa ' : ' ');
      assert.ok(trace.slice(0, 2).every(e => e.downPrevented === !screenReaderMode));
      assert.equal(trace[2].downPrevented, false);
      // Appending under 229 emits only the delta, even with existing residue.
      const prior = f.terminal.textarea.value;
      await f.replacement229(prior + 'Z');
      assert.equal(f.frames.at(-1), 'Z');
      console.log(JSON.stringify({ case: 'lowercase-space-and-229-append', screenReaderMode, trace, frames: f.frames }));
    } finally { f.terminal.dispose(); }

    const upper = fixture(screenReaderMode);
    try {
      const trace = upper.type('AA ');
      assert.equal(upper.frames.join(''), 'AA ');
      // Critical limitation: uppercase uses keypress, whose cancel is NOT forced.
      assert.equal(upper.terminal.textarea.value, 'AA ');
      assert.equal(trace[0].downPrevented, false);
      assert.equal(trace[0].pressPrevented, false);
      assert.equal(trace[2].downPrevented, false);
      const residue = upper.terminal.textarea.value;
      const priorFrames = upper.frames.length;
      await upper.replacement229(residue + residue);
      assert.deepEqual(upper.frames.slice(priorFrames), [residue]);
      assert.equal(upper.frames.join(''), 'AA AA '); // imposed repeated DOM delta is emitted unchanged
      upper.terminal.textarea.value = residue; // isolate equal-length replacement case
      upper.frames.length = priorFrames;
      // Equal-length changed replacement exercises the actual whole-value branch.
      const replacement = residue.slice(0, -1) + 'B';
      const before = upper.frames.length;
      await upper.replacement229(replacement);
      assert.deepEqual(upper.frames.slice(before), [replacement]);
      assert.equal(Buffer.from(upper.frames.join('')).toString('hex'), Buffer.from('AA ' + replacement).toString('hex'));
      console.log(JSON.stringify({ case: 'uppercase-space-and-229-equal-length-replacement', screenReaderMode, residue, replacement, trace, frames: upper.frames, hex: Buffer.from(upper.frames.join('')).toString('hex') }));

      upper.frames.length = 0;
      upper.terminal.paste('AA AA\nAA AA\n');
      upper.terminal.paste('AA AA\nAA AA\n');
      assert.deepEqual(upper.frames, ['AA AA\rAA AA\r', 'AA AA\rAA AA\r']);
      assert.equal(upper.terminal.textarea.value, '');
      upper.frames.length = 0;
      upper.terminal._keyDown(event('keydown', 'Enter', 13));
      upper.terminal._keyDown(event('keydown', 'Enter', 13));
      assert.deepEqual(upper.frames, ['\r', '\r']);
    } finally { upper.terminal.dispose(); }
  }
  function integrated(beforeAttach?: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture(false);
    beforeAttach?.(f);
    // The production helper receives ONLY its four public members. Internals
    // remain confined to fixture construction and actual upstream bindings.
    const listenersBefore = [f.terminal.element.listeners.length, f.terminal.textarea.listeners.length];
    const subscriptions = { data: 0, key: 0 };
    const tracked = (subscribe: any, kind: 'data' | 'key') => (listener: any) => {
      subscriptions[kind]++;
      const subscription = subscribe(listener);
      let disposed = false;
      return { dispose() {
        if (disposed) return;
        disposed = true;
        subscriptions[kind]--;
        subscription.dispose();
      } };
    };
    const guard = attachTerminalKeyboard({ element: f.terminal.element, textarea: f.terminal.textarea,
      onData: tracked(f.terminal.onData, 'data'), onKey: tracked(f.terminal.onKey, 'key') });
    assert.deepEqual(subscriptions, { data: 1, key: 1 });
    return { ...f, guard, listenersBefore, subscriptions };
  }
  {
    const f = integrated();
    try {
      const trace = f.type('AA aa  AA');
      assert.equal(f.frames.join(''), 'AA aa  AA');
      assert.equal(f.terminal.textarea.value, '');
      assert.ok(trace.every(e => e.downPrevented || e.pressPrevented));
      const before = f.frames.length;
      await f.replacement229('Z');
      assert.deepEqual(f.frames.slice(before), ['Z']);
      // The real 229 timeout emits first; exact delivered-value cleanup follows.
      assert.equal(f.terminal.textarea.value, '');
      f.frames.length = 0;
      for (const key of ['c', 'v']) {
        const down = Object.assign(event('keydown', key, key.toUpperCase().charCodeAt(0)), { metaKey: true });
        f.dispatch(down);
        if (!down.defaultPrevented) {
          f.dispatch(Object.assign(event('keypress', key, key.charCodeAt(0)), { metaKey: true }));
        }
        assert.equal(down.defaultPrevented, false, `Cmd-${key} remains native`);
        f.dispatch(Object.assign(event('keyup', key, key.toUpperCase().charCodeAt(0)), { metaKey: true }));
      }
      assert.deepEqual(f.frames, []);
      for (let i = 0; i < 2; i++) f.terminal.paste('AA AA\néé\n');
      for (let i = 0; i < 2; i++) {
        f.dispatch(event('keydown', 'Enter', 13));
        f.dispatch(event('keyup', 'Enter', 13));
      }
      assert.deepEqual(f.frames, ['AA AA\réé\r', 'AA AA\réé\r', '\r', '\r']);
      console.log(JSON.stringify({ case: 'public-helper-keys-fresh229-and-repeats', trace, frames: f.frames }));
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      // Actual standalone 229 emission, without composition events or paste()
      // (the public paste method clears its own textarea synchronously).
      const payload = 'ÁÁ éé\nAA AA\n';
      await f.replacement229(payload);
      assert.deepEqual(f.frames, [payload]);
      assert.equal(f.terminal.textarea.value, '', 'exact delivered fallback value retired');
      await f.replacement229(payload);
      assert.deepEqual(f.frames, [payload, payload], 'identical intentional commits each delivered once');
      assert.equal(f.terminal.textarea.value, '');
      console.log(JSON.stringify({ case: 'standalone229-repeated-whole-value-cleanup', frames: f.frames,
        hex: Buffer.from(f.frames.join('')).toString('hex'), textarea: f.terminal.textarea.value }));
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.terminal.textarea.value = 'retained ';
      await f.replacement229('retained é');
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, 'retained é', 'partial delta cannot authorize whole-value cleanup');
      console.log('PASS standalone229 partial delta leaves nonmatching editing value intact');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const payload = 'AA AA\néé\n';
    const baseline = fixture(false);
    try {
      const trace = baseline.browserPaste(payload);
      assert.deepEqual(baseline.frames, ['AA AA\réé\r']);
      assert.deepEqual(trace, { prevented: false, stopped: true, afterHandler: '', afterDefault: payload });
      await tick();
      assert.equal(baseline.terminal.textarea.value, payload);
      assert.equal(baseline.frames.length, 1, 'default insertion adds residue without a second emission');
      console.log(JSON.stringify({ case: 'actual-clipboard-baseline-default-residue', trace, frames: baseline.frames }));
    } finally { baseline.terminal.dispose(); }
    const f = integrated();
    try {
      for (let i = 0; i < 2; i++) {
        const down = Object.assign(event('keydown', 'v', 86), { metaKey: true });
        f.dispatch(down);
        assert.equal(down.defaultPrevented, false, 'Cmd-V remains a native shortcut');
        const trace = f.browserPaste(payload);
        assert.deepEqual(trace, { prevented: true, stopped: true, afterHandler: '', afterDefault: '' });
        f.dispatch(Object.assign(event('keyup', 'v', 86), { metaKey: true }));
      }
      await tick();
      assert.deepEqual(f.frames, ['AA AA\réé\r', 'AA AA\réé\r']);
      assert.equal(f.terminal.textarea.value, '');
      console.log(JSON.stringify({ case: 'actual-clipboard-guarded-repeated-paste', frames: f.frames, textarea: f.terminal.textarea.value }));
      const missingClipboard = event('paste');
      f.terminal.textarea.value = 'uncommitted';
      f.dispatch(missingClipboard);
      assert.equal(missingClipboard.defaultPrevented, false, 'no clipboard delivery means no cancellation');
      assert.equal(f.terminal.textarea.value, 'uncommitted');
      f.terminal.options.disableStdin = true;
      const notDelivered = f.browserPaste(payload);
      assert.equal(notDelivered.prevented, false, 'disabled stdin produces no onData so default remains uncancelled');
      assert.deepEqual(f.frames, ['AA AA\réé\r', 'AA AA\réé\r']);
      assert.equal(f.terminal.textarea.value, payload);
      console.log('PASS clipboard prevention requires same-event delivery; missing clipboard and disabled stdin remain uncancelled');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  for (const nextEdit of ['input', 'beforeinput', 'keydown', 'value-change', 'compositionstart', 'dispose']) {
    const f = integrated();
    let subscription: { dispose(): void } | undefined;
    try {
      let observed = false;
      // Public observer registered AFTER helper: actual onData schedules cleanup
      // first, then the competing edit occurs before its timer. No timer or
      // private helper state is inspected or replaced.
      subscription = f.terminal.onData((value: string) => {
        if (observed || value !== 'é') return;
        observed = true;
        if (nextEdit === 'input') {
          // Same value, new uncommitted edit: equality alone must not erase it.
          f.input('é', { inputType: 'insertCompositionText', isComposing: true });
        } else if (nextEdit === 'beforeinput') {
          f.dispatch(Object.assign(event('beforeinput'), { data: 'é', inputType: 'insertCompositionText' }));
        } else if (nextEdit === 'keydown') {
          f.dispatch(event('keydown', 'Shift', 16)); // no value change or emission
        } else if (nextEdit === 'value-change') {
          f.terminal.textarea.value = 'uncommitted';
        } else if (nextEdit === 'compositionstart') {
          f.dispatch(event('compositionstart'));
        } else {
          f.guard.dispose();
        }
      });
      await f.replacement229('é');
      assert.equal(observed, true);
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, nextEdit === 'value-change' ? 'uncommitted' : 'é',
        `${nextEdit} must protect later/uncommitted state from stale cleanup`);
      console.log(`PASS standalone229 cleanup protects subsequent ${nextEdit}`);
    } finally { subscription?.dispose(); f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      // An actual parser-generated status response is not editing delivery,
      // even if the textarea happens to equal its entire onData value.
      const response = '\x1b[0n';
      f.terminal.textarea.value = response;
      await new Promise<void>(resolve => f.terminal.write('\x1b[5n', resolve));
      await tick();
      assert.deepEqual(f.frames, [response]);
      assert.equal(f.terminal.textarea.value, response, 'matching ESC response cannot clear textarea');
      console.log('PASS actual DSR parser ESC response cannot clear matching textarea');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      // Root capture -> real xterm target capture -> helper target bubble.
      f.terminal.textarea.value = 'é';
      f.input('é', { composed: false });
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, '', 'synchronously delivered native text cleared');
      f.terminal.textarea.value = 'uncommitted';
      f.input('uncommitted', { inputType: 'insertCompositionText', isComposing: true });
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, 'uncommitted', 'no emission means no erasure');
      f.terminal.textarea.value = 'composing';
      // Even an onData emission inside a composing input must not erase it.
      f.input('x', { composed: false, isComposing: true });
      assert.deepEqual(f.frames, ['é', 'x']);
      assert.equal(f.terminal.textarea.value, 'composing');
      console.log('PASS helper input lifecycle: delivered text cleared; uncommitted/composing text retained');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  async function updateComposition(f: ReturnType<typeof integrated>, text: string) {
    f.dispatch(Object.assign(event('compositionupdate'), { data: text }));
    f.terminal.textarea.value = text;
    f.input(text, { inputType: 'insertCompositionText', isComposing: true });
    await tick(); // actual upstream position-end timer
  }
  {
    const f = fixture(false);
    try {
      f.terminal.textarea.value = 'á';
      f.dispatch(event('keydown', 'Unidentified', 229));
      f.terminal.textarea.value = ''; // controlled shrink after real snapshot
      await tick();
      assert.deepEqual(f.frames, ['\x7f'], 'installed standalone229 shrink emits DEL');
      console.log('PASS installed standalone229 shrink emits DEL (controlled positive mechanism check)');
    } finally { f.terminal.dispose(); }
  }
  for (const interleave of ['229-input-b', '229-no-insertion', 'value-only']) {
    const f = integrated();
    let subscription: { dispose(): void } | undefined;
    try {
      let observed = false;
      subscription = f.terminal.onData((value: string) => {
        if (observed || value !== 'á') return;
        observed = true;
        // C1 has delivered through the production listener; C2 is still queued.
        // This public observer deterministically imposes the competing edit.
        if (interleave !== 'value-only') f.dispatch(event('keydown', 'Unidentified', 229));
        if (interleave !== '229-no-insertion') f.terminal.textarea.value = 'áb';
        if (interleave === '229-input-b') f.input('b', { composed: true });
      });
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'á');
      f.dispatch(event('compositionend'));
      await tick();
      assert.equal(observed, true);
      assert.deepEqual(f.frames, interleave === '229-input-b' ? ['á', 'b'] : ['á']);
      assert.ok(!f.frames.some(frame => frame.includes('\x7f')), 'no DEL after C1/new edit/C2');
      assert.equal(f.terminal.textarea.value, interleave === '229-no-insertion' ? 'á' : 'áb',
        'C2 must preserve editing state seen by the newer upstream timeout');
      console.log(JSON.stringify({ case: `composition-C1-new-edit-C2-${interleave}`, frames: f.frames,
        hex: Buffer.from(f.frames.join('')).toString('hex'), textarea: f.terminal.textarea.value }));
    } finally { subscription?.dispose(); f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    // Insert a test-only task between C1 and C2 using listener registration
    // order. The actual upstream empty finalizer runs first and emits nothing;
    // then an actual parser response advances onData before C2.
    const f = integrated(before => {
      const between = () => setTimeout(() => {
        before.terminal.textarea.value = '\x1b[0n';
        before.terminal._inputHandler.parse('\x1b[5n');
      }, 0);
      before.terminal.textarea.addEventListener('compositionend', between);
      before.terminal.register({ dispose() { before.terminal.textarea.removeEventListener('compositionend', between); } });
    });
    try {
      f.dispatch(event('compositionstart'));
      f.dispatch(event('compositionend'));
      await tick();
      assert.deepEqual(f.frames, ['\x1b[0n']);
      assert.equal(f.terminal.textarea.value, '\x1b[0n', 'ESC-only pending onData cannot authorize C2 cleanup');
      console.log('PASS pending composition ESC-only onData leaves textarea intact after C2');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'á');
      f.dispatch(event('compositionend'));
      f.input('á', { inputType: 'insertCompositionText' }); // final edit before C1
      await tick();
      assert.deepEqual(f.frames, ['á']);
      assert.equal(f.terminal.textarea.value, '', 'pre-C1 final input still permits delivered snapshot cleanup');
      console.log('PASS final input before C1 still clears delivered commit after C2');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.dispatch(event('compositionstart'));
      f.dispatch(Object.assign(event('keydown', 'Unidentified', 229), { isComposing: true }));
      await updateComposition(f, 'é');
      assert.deepEqual(f.frames, []);
      assert.equal(f.terminal.textarea.value, 'é');
      f.dispatch(event('compositionend'));
      f.input('é', { isComposing: false });
      assert.deepEqual(f.frames, [], 'commit still awaits the upstream timer');
      assert.equal(f.terminal.textarea.value, 'é', 'pending commit not truncated');
      await tick();
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, '', 'cleared after upstream commit');
      f.dispatch(event('keyup', 'Unidentified', 229));
      // Switching to a normal handled key finalizes upstream composition
      // immediately; the already scheduled commit must not send it twice.
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'á');
      const enter = event('keydown', 'Enter', 13);
      f.dispatch(enter);
      assert.equal(enter.defaultPrevented, true);
      assert.deepEqual(f.frames, ['é', 'á', '\r']);
      await tick();
      assert.deepEqual(f.frames, ['é', 'á', '\r']);
      assert.equal(f.terminal.textarea.value, '');
      console.log('PASS real composition commit and immediate Enter switch: exact UTF8, no truncation/duplicate');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'é');
      f.dispatch(event('compositionend'));
      // A new composition starts before either end timer. The real upstream
      // finalizer uses the old end position while the new start stays intact.
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'éß');
      assert.deepEqual(f.frames, ['é']);
      assert.equal(f.terminal.textarea.value, 'éß', 'stale cleanup cannot erase next composition');
      f.dispatch(event('compositionend'));
      await tick();
      assert.deepEqual(f.frames, ['é', 'ß']);
      assert.equal(f.terminal.textarea.value, '');
      console.log('PASS new composition generation retains uncommitted text and sends both commits exactly once');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.terminal.options.disableStdin = true;
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'é');
      f.dispatch(event('compositionend'));
      await tick();
      assert.deepEqual(f.frames, [], 'real CoreService suppresses onData when stdin disabled');
      assert.equal(f.terminal.textarea.value, 'é', 'no observed delivery means no cleanup');
      console.log('PASS composition cleanup requires actual onData emission advancement');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  {
    const f = integrated();
    try {
      f.dispatch(event('compositionstart'));
      await updateComposition(f, 'é');
      f.dispatch(event('compositionend'));
      f.guard.dispose();
      f.guard.dispose(); // disposal is idempotent
      assert.deepEqual([f.terminal.element.listeners.length, f.terminal.textarea.listeners.length], f.listenersBefore);
      assert.deepEqual(f.subscriptions, { data: 0, key: 0 });
      await tick();
      assert.deepEqual(f.frames, ['é'], 'upstream commit survives helper disposal');
      assert.equal(f.terminal.textarea.value, 'é', 'disposed timer cannot clear textarea');
      f.terminal.textarea.value = '';
      f.frames.length = 0;
      f.type('AA ');
      assert.equal(f.terminal.textarea.value, 'AA ', 'onKey disposal restores uncancelled baseline');
      f.terminal.textarea.value = 'x';
      f.input('x', { composed: false });
      assert.equal(f.terminal.textarea.value, 'x', 'input listener removed');
      console.log('PASS disposal removes listeners/onKey and cancels helper cleanup without cancelling upstream commit');
    } finally { f.guard.dispose(); f.terminal.dispose(); }
  }
  console.log('PASS installed xterm 5.5.0: real onData, preventDefault, residue, 229 delta/whole-value, repeated typing/paste/Enter. Controlled source evidence only; baseline false mode permits uppercase/space residue; public helper integration passes.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

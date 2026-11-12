import type { Terminal } from '@xterm/xterm';

/** Keep already-delivered text out of WebKit's hidden editing buffer.
 *
 * xterm 5.5 does not prevent every handled keypress's DOM default (uppercase
 * and spaces are examples). Its later 229 fallback can resend that residue.
 * This uses public events only: never deduplicate bytes or guess by timing.
 * Register after Terminal.open(), after xterm's composition listeners.
 */
export function attachTerminalKeyboard(terminal: Pick<Terminal, 'element' | 'textarea' | 'onData' | 'onKey'>) {
  const root = terminal.element;
  const textarea = terminal.textarea;
  if (!root || !textarea) return { dispose() {} };
  let disposed = false;
  let composing = false;
  let pendingCommit = false;
  let generation = 0;
  let editingVersion = 0;
  let emissions = 0;
  let commit: { generation: number; edit: number; value: string } | undefined;
  const beforeInput = new WeakMap<Event, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const data = terminal.onData(value => {
    emissions++;
    // Snapshot at delivery, not compositionend: a final native input may arrive
    // before xterm's deferred commit. A later edit must survive our cleanup.
    if (!disposed && pendingCommit && !composing && value && !value.startsWith('\x1b') &&
        textarea.value.endsWith(value)) {
      commit = { generation, edit: editingVersion, value: textarea.value };
    }
    // Some WebKit editing paths commit asynchronously through xterm's 229
    // fallback, without a compositionend or synchronous input emission.
    // Retire only the exact editing value just emitted, never a later edit.
    if (disposed || composing || pendingCommit || !value || value.startsWith('\x1b') || textarea.value !== value) return;
    const current = generation;
    const edit = editingVersion;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed && !composing && !pendingCommit && current === generation &&
          edit === editingVersion && textarea.value === value) textarea.value = '';
    }, 0);
    timers.add(timer);
  });
  const key = terminal.onKey(({ domEvent }) => {
    // onKey means xterm already handled the event. Preserve its bytes, but
    // prevent the browser from also inserting them into the hidden textarea.
    if (!domEvent.isComposing && domEvent.keyCode !== 229) domEvent.preventDefault();
  });
  const captureEdit = () => { editingVersion++; };
  const captureInput = (event: Event) => { editingVersion++; beforeInput.set(event, emissions); };
  const input = (event: Event) => {
    const before = beforeInput.get(event);
    if (!disposed && !composing && !pendingCommit && !(event as InputEvent).isComposing &&
        before !== undefined && emissions > before) textarea.value = '';
  };
  const capturePaste = (event: Event) => { editingVersion++; beforeInput.set(event, emissions); };
  const paste = (event: Event) => {
    // xterm's clipboard handler sends the paste and clears the textarea, but
    // does not cancel WebKit's default insertion. Do so only after delivery.
    const before = beforeInput.get(event);
    if (before !== undefined && emissions > before) event.preventDefault();
  };
  const start = () => { composing = true; pendingCommit = false; commit = undefined; generation++; };
  const end = () => {
    composing = false; pendingCommit = true;
    const current = ++generation;
    commit = undefined;
    // xterm's compositionend handler was registered first and schedules its
    // commit first. Do not clear while that commit or a new composition is pending.
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (disposed || composing || generation !== current) return;
      pendingCommit = false;
      if (commit?.generation === current && commit.edit === editingVersion &&
          textarea.value === commit.value) textarea.value = '';
      commit = undefined;
    }, 0);
    timers.add(timer);
  };
  root.addEventListener('input', captureInput, true);
  root.addEventListener('paste', capturePaste, true);
  root.addEventListener('keydown', captureEdit, true);
  root.addEventListener('beforeinput', captureEdit, true);
  textarea.addEventListener('input', input);
  textarea.addEventListener('paste', paste);
  textarea.addEventListener('compositionstart', start);
  textarea.addEventListener('compositionend', end);
  return {
    dispose() {
      if (disposed) return;
      disposed = true; generation++;
      data.dispose(); key.dispose();
      root.removeEventListener('input', captureInput, true);
      root.removeEventListener('paste', capturePaste, true);
      root.removeEventListener('keydown', captureEdit, true);
      root.removeEventListener('beforeinput', captureEdit, true);
      textarea.removeEventListener('input', input);
      textarea.removeEventListener('paste', paste);
      textarea.removeEventListener('compositionstart', start);
      textarea.removeEventListener('compositionend', end);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

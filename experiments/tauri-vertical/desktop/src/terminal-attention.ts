import type { Terminal } from '@xterm/xterm';
/** Explicit protocol only. Never inspect terminal text or claim turn semantics. */
export function attachTerminalAttention(term: Pick<Terminal, 'onBell' | 'parser'>, signal: () => void) {
  const handlers = [
    term.onBell(signal),
    term.parser.registerOscHandler(9, data => {
      // OSC 9;4 is progress, and other numeric subprotocols are not notifications.
      if (/^\d+;/.test(data)) return false;
      signal(); return true;
    }),
    term.parser.registerOscHandler(777, data => {
      if (!data.startsWith('notify;')) return false;
      signal(); return true;
    }),
  ];
  return { dispose() { handlers.forEach(h => h.dispose()); } };
}

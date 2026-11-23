/**
 * Shared parity harness: feeds the raw PTY bytes of a vector to a real xterm
 * Terminal and observes the client's own handlers (parseProgramStatus on OSC
 * 7501, attachTerminalAttention for BEL/OSC 9/777). Used by Node
 * (tests/program-status-vectors.test.ts) and by the browser
 * (tests/browser/program-status-parity.test.ts through program-status-parity.html).
 */
import { parseProgramStatus } from '../../src/program-status';
import { attachTerminalAttention } from '../../src/terminal-attention';

export type ParityEvent = { kind: 'state' | 'clear' | 'bell' | 'notify'; state?: string; at: number };
type TerminalLike = { onBell(listener: () => void): { dispose(): void }; parser: { registerOscHandler(id: number, cb: (data: string) => boolean): { dispose(): void } };
  write(data: Uint8Array, cb?: () => void): void; dispose(): void };

export function decode(base64: string): Uint8Array {
  const binary = atob(base64); return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/** `chunks` are the write boundaries; `at` is exact only when every chunk is one byte. */
export async function feed(create: () => TerminalLike, bytes: Uint8Array, chunks: number[]): Promise<ParityEvent[]> {
  const term = create();
  const events: ParityEvent[] = [];
  let at = -1, bell = false;
  // Registered before the client handlers so a BEL can be told from an OSC notification.
  const ring = term.onBell(() => { bell = true; });
  const attention = attachTerminalAttention(term as never, () => { events.push({ kind: bell ? 'bell' : 'notify', at }); bell = false; });
  const program = term.parser.registerOscHandler(7501, data => {
    const state = parseProgramStatus(data);
    if (state === 'clear') events.push({ kind: 'clear', at }); else if (state) events.push({ kind: 'state', state, at });
    return true;
  });
  let start = 0;
  for (const end of [...chunks, bytes.length]) {
    if (end <= start) continue;
    at = end - 1;
    const piece = bytes.slice(start, end);
    await new Promise<void>(resolve => term.write(piece, resolve));
    start = end;
  }
  ring.dispose(); attention.dispose(); program.dispose(); term.dispose();
  return events;
}

export const comparable = (events: readonly { kind: string; state?: string }[]) => events.map(e => e.kind === 'state' ? `state:${e.state}` : e.kind);

/** Whole input, every two-piece cut (inputs up to `maxCuts` bytes) and byte by byte. */
export async function checkVector(create: () => TerminalLike, vector: { name: string; input: string; expect: ParityEvent[] }, maxCuts = 256): Promise<string[]> {
  const bytes = decode(vector.input);
  const expected = vector.expect.map(e => ({ kind: e.kind, ...(e.state ? { state: e.state } : {}), at: e.at }));
  const problems: string[] = [];
  const byByte = await feed(create, bytes, Array.from({ length: bytes.length }, (_, i) => i + 1));
  if (JSON.stringify(byByte) !== JSON.stringify(expected)) problems.push(`byte by byte: xterm ${JSON.stringify(byByte)} ≠ fixture ${JSON.stringify(expected)}`);
  const whole = await feed(create, bytes, []);
  if (JSON.stringify(comparable(whole)) !== JSON.stringify(comparable(expected))) problems.push(`whole: xterm ${JSON.stringify(comparable(whole))}`);
  if (bytes.length <= maxCuts) for (let cut = 1; cut < bytes.length; cut++) {
    const split = await feed(create, bytes, [cut]);
    if (JSON.stringify(comparable(split)) !== JSON.stringify(comparable(expected))) { problems.push(`cut at ${cut}: xterm ${JSON.stringify(comparable(split))}`); break; }
  }
  return problems;
}

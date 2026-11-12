import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../../src/style.css';
import { preserveTerminalViewport, syncTerminalViewport } from '../../src/terminal-viewport';
import { attachTerminalKeyboard } from '../../src/terminal-keyboard';
import { OrderedInput } from '../../src/input';
import { InteractivePoll } from '../../src/interactive-poll';

const host = document.querySelector<HTMLDivElement>('.terminal-view')!;
const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, scrollback: 8000 });
const fit = new FitAddon(); term.loadAddon(fit); term.open(host); fit.fit();
attachTerminalKeyboard(term);
const received: string[] = [];
const queue = new OrderedInput(async data => { received.push(data); }, console.error);
term.onData(data => { void queue.enqueue(data); });
const write = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
const state = () => ({ y: term.buffer.active.viewportY, base: term.buffer.active.baseY,
  top: term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true),
  scroll: host.querySelector('.xterm-viewport')!.scrollTop,
  rows: term.rows, cols: term.cols });
Object.assign(window, { fixture: {
  term, host, state, write, received,
  fill: () => write(Array.from({ length: 200 }, (_, i) => `${String(i).padStart(4, '0')} ${'text '.repeat(22)}\r\n`).join('')),
  attach: (id: string, fixed = true) => { document.querySelector(`#${id} .terminal-host`)!.append(host); if (fixed) syncTerminalViewport(term); },
  resize: (width: number, height: number, fixed = true) => {
    const pane = host.closest<HTMLElement>('.pane')!;
    pane.style.width = `${width}px`; pane.style.height = `${height}px`;
    if (fixed) preserveTerminalViewport(term, () => fit.fit()); else fit.fit();
  },
  // Simulated backend echo: only the poller writes returned bytes to xterm.
  // Includes an idle interval before typing, matching the app's original wait.
  measureEcho: async (adaptive: boolean) => {
    const cadence = new InteractivePoll();
    let running = true; const pending: { data: string; at: number }[] = [];
    const latencies: number[] = []; const echoed: string[] = [];
    const input = new OrderedInput(async data => { pending.push({ data, at: performance.now() }); }, console.error);
    let wake!: () => void;
    const ready = new Promise<void>(r => wake = r);
    const loop = (async () => {
      while (running) {
        const page = pending.splice(0);
        if (page.length) {
          if (adaptive) cadence.activity();
          await write(page.map(p => p.data).join(''));
          for (const item of page) { latencies.push(performance.now() - item.at); echoed.push(item.data); }
        }
        wake();
        if (adaptive) await cadence.wait(true); else await new Promise(r => setTimeout(r, 150));
      }
    })();
    await ready;
    const typed = 'acción ABC abc 123\r'.repeat(4);
    for (const char of typed) {
      await new Promise(r => setTimeout(r, 8));
      if (adaptive) cadence.activity();
      void input.enqueue(char);
    }
    const paste = 'paste🙂'.repeat(6000);
    if (adaptive) cadence.activity();
    await input.enqueue(paste);
    const deadline = performance.now() + 10000;
    while (echoed.join('') !== typed + paste && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
    running = false; cadence.activity(); await loop;
    return { latencies, exact: echoed.join('') === typed + paste };
  },
} });

export function inputFrames(text: string, maxBytes = 16 * 1024): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length > 512 * 1024) throw new Error('El pegado supera 512 KiB; envía un fragmento menor.');
  const frames: string[] = []; let frame = ''; let size = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    if (bytes > maxBytes) throw new Error('El límite no admite un carácter completo.');
    if (size + bytes > maxBytes) { frames.push(frame); frame = ''; size = 0; }
    frame += character; size += bytes;
  }
  if (frame) frames.push(frame);
  return frames;
}

type InputJob = {
  frames?: string[];
  control?: () => Promise<unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** FIFO per terminal. After uncertain delivery, suspend instead of retrying. */
export class OrderedInput {
  private jobs: InputJob[] = [];
  private draining = false;
  private failed = false;
  private pendingBytes = 0;
  private send: (frame: string) => Promise<unknown>;
  private failedInput: (error: unknown) => void;
  constructor(send: (frame: string) => Promise<unknown>, failedInput: (error: unknown) => void) { this.send = send; this.failedInput = failedInput; }
  enqueue(text: string): Promise<void> {
    if (this.failed) return Promise.reject(new Error('Entrada suspendida: reconecta antes de continuar.'));
    const frames = inputFrames(text); const bytes = new TextEncoder().encode(text).length;
    if (this.pendingBytes + bytes > 1024 * 1024) return Promise.reject(new Error('Cola de entrada llena; espera antes de enviar más texto.'));
    this.pendingBytes += bytes;
    return this.append({ frames }).finally(() => { this.pendingBytes -= bytes; });
  }
  /** Native controls share the FIFO with typed and pasted input. Never retry. */
  control(send: () => Promise<unknown>): Promise<void> {
    if (this.failed) return Promise.reject(new Error('Entrada suspendida: reconecta antes de continuar.'));
    return this.append({ control: send });
  }
  private append(work: Pick<InputJob, 'frames' | 'control'>): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => this.jobs.push({ ...work, resolve, reject }));
    // Dispatch the first key immediately. Only coalesce backlog accumulated while
    // an earlier RPC was in flight; there is no debounce or speculative echo.
    void this.drain();
    return promise;
  }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    const encoder = new TextEncoder();
    let inFlight: InputJob[] = [];
    try {
      while (this.jobs.length) {
        const first = this.jobs[0];
        if (first.control) {
          this.jobs.shift(); inFlight = [first];
          await first.control(); first.resolve(); inFlight = [];
          continue;
        }
        let frame = ''; let bytes = 0;
        inFlight = [];
        while (this.jobs.length && this.jobs[0].frames) {
          const job = this.jobs[0];
          const next = job.frames![0] ?? '';
          const size = encoder.encode(next).length;
          if (bytes + size > 16384) break;
          frame += next; bytes += size;
          job.frames!.shift();
          if (!job.frames!.length) { this.jobs.shift(); inFlight.push(job); }
          // A partial paste remains at the front until all its frames are sent.
          if (bytes === 16384) break;
        }
        if (frame) await this.send(frame);
        for (const job of inFlight) job.resolve();
        inFlight = [];
      }
    } catch (error) {
      this.failed = true;
      for (const job of [...inFlight, ...this.jobs.splice(0)]) job.reject(error);
      this.failedInput(error);
    } finally { this.draining = false; }
  }
}

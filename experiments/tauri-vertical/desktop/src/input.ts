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

/** FIFO per terminal. After uncertain delivery, suspend instead of retrying. */
export class OrderedInput {
  private tail: Promise<void> = Promise.resolve();
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
    return this.append(async () => {
      for (const frame of frames) await this.send(frame);
    }).finally(() => { this.pendingBytes -= bytes; });
  }
  /** Native controls share the FIFO with typed and pasted input. Never retry. */
  control(send: () => Promise<unknown>): Promise<void> {
    if (this.failed) return Promise.reject(new Error('Entrada suspendida: reconecta antes de continuar.'));
    return this.append(async () => { await send(); });
  }
  private append(work: () => Promise<void>): Promise<void> {
    const job = this.tail.then(async () => {
      if (this.failed) throw new Error('Entrada suspendida tras un fallo anterior.');
      await work();
    });
    this.tail = job.catch(error => { if (!this.failed) { this.failed = true; this.failedInput(error); } });
    return job;
  }
}

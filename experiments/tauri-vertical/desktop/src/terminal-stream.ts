/** Native frame cursors are independent of the archive's global event sequence. */
export type TerminalHistory = {
  state: 'recording' | 'limited' | 'error' | 'complete' | 'incomplete' | 'unknown_tail';
  reason?: string;
  fromFrame?: number;
  durableFrame: number;
  lastFrame: number;
};
export type TerminalStream = { generation: string; history: TerminalHistory };
export type TerminalFrame = { index: number } & (
  { kind: 'output'; data: string } |
  { kind: 'resize'; data: { rows: number; cols: number } } |
  { kind: 'state'; data: { status: string; detail?: unknown } }
);
export type TerminalGap = { firstFrame: number; lastFrame: number };
export const terminalGapNotice = 'Vista desincronizada; falta un tramo de salida';

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
export function validateFrames(generation: string, frames: TerminalFrame[]): void {
  if (typeof generation !== 'string' || !generation || !Array.isArray(frames)) throw new Error('Invalid terminal stream');
  let previous = 0;
  for (const frame of frames) {
    if (!frame || !integer(frame.index, 1) || frame.index <= previous) throw new Error('Non-monotonic terminal frames');
    previous = frame.index;
    if (frame.kind === 'output') {
      if (typeof frame.data !== 'string' || frame.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Invalid terminal output');
    } else if (frame.kind === 'resize') {
      if (!frame.data || !integer(frame.data.rows, 1) || !integer(frame.data.cols, 1) || frame.data.rows > 1000 || frame.data.cols > 1000) throw new Error('Invalid terminal geometry');
    } else if (frame.kind === 'state') {
      if (!frame.data || typeof frame.data.status !== 'string') throw new Error('Invalid terminal state');
    } else throw new Error('Unknown terminal frame');
    if (frame.index === 1 && frame.kind !== 'resize') throw new Error('Terminal frame 1 must establish geometry');
  }
}
export function terminalFramesPayload(data: string, transport?: string): { generation: string; frames: TerminalFrame[] } | null {
  // Provider-controlled methods in app-server conversations never select a PTY parser.
  if (transport === 'app-server') return null;
  const value = JSON.parse(data);
  if (value?.method !== 'jauria/terminalFrames') return null;
  const params = value.params;
  if (!params) throw new Error('Missing terminal frames');
  validateFrames(params.generation, params.frames);
  return params;
}

/** Ring eviction is not evidence of archival loss while a saved/pending prefix
 * can still be read. Leave the canonical cursor untouched during backfill.
 */
export function deferTerminalGap(after: number, gap: TerminalGap | null, durableFrame: number, history: TerminalHistory, archiveAvailable: boolean): boolean {
  if (gap && (!integer(gap.firstFrame, 1) || !integer(gap.lastFrame, gap.firstFrame))) throw new Error('Invalid terminal gap');
  return !!gap && gap.lastFrame > after && archiveAvailable &&
    (gap.lastFrame <= durableFrame || history.state === 'recording');
}

/** One immutable generation and one high-water mark per session, no duplicate set.
 * Callers serialize consumption; acknowledgement follows the async parser callback.
 */
export class TerminalStreamCursor {
  readonly generation: string;
  lastFrame = 0;
  desynchronized = false;
  constructor(generation: string) {
    if (!generation) throw new Error('Missing terminal generation');
    this.generation = generation;
  }
  async consume(generation: string, frames: TerminalFrame[], consumer: {
    frame: (frame: TerminalFrame) => Promise<void>;
    // Must reset ANSI/parser state (terminal.reset), never inject provider input.
    gap: (notice: string) => Promise<void>;
  }, gap: TerminalGap | null = null): Promise<void> {
    if (generation !== this.generation) throw new Error('Terminal generation changed');
    validateFrames(generation, frames);
    if (gap && (!integer(gap.firstFrame, 1) || !integer(gap.lastFrame, gap.firstFrame))) throw new Error('Invalid terminal gap');
    const missingThrough = gap && gap.firstFrame <= this.lastFrame + 1 ? gap.lastFrame : 0;
    if (missingThrough > this.lastFrame) {
      await consumer.gap(terminalGapNotice);
      this.desynchronized = true;
      this.lastFrame = missingThrough;
    }
    for (const frame of frames) {
      if (frame.index <= this.lastFrame) continue;
      if (frame.index > this.lastFrame + 1) {
        await consumer.gap(terminalGapNotice);
        this.desynchronized = true;
      }
      await consumer.frame(frame);
      this.lastFrame = frame.index;
    }
  }
}

export function historyLabel(history?: TerminalHistory): string {
  if (!history) return '';
  return { recording: '', limited: 'Historial limitado', error: 'Error al guardar historial', complete: 'Historial completo', incomplete: 'Historial incompleto', unknown_tail: 'Historial sin confirmar' }[history.state];
}

export function historyReasonLabel(reason?: string): string {
  switch (reason) {
    case 'quota':
    case 'session_quota': return 'Cuota alcanzada';
    case 'io': return 'Almacenamiento no disponible';
    case 'queue_overflow': return 'El guardado no siguió el ritmo de la salida';
    case 'explicit_purge': return 'Historial eliminado';
    case 'reader_error': return 'Salida incompleta';
    case 'shutdown': return 'Guardado final sin confirmar';
    case 'metadata_limit': return 'Información de cierre incompleta';
    default: return 'No se pudo conservar toda la salida';
  }
}

export type HistoryRetention = { outputEncodedBytes: number; maxOutputEncodedBytes: number; eventRows: number; outputRowLimit?: number };
export function historyUsage(retention?: HistoryRetention): number {
  if (!retention) return 0;
  const ratio = (used: number, limit?: number) => Number.isFinite(used) && limit !== undefined && Number.isFinite(limit) && limit > 0 ? used / limit : 0;
  return Math.max(ratio(retention.outputEncodedBytes, retention.maxOutputEncodedBytes), ratio(retention.eventRows, retention.outputRowLimit));
}
/** Each threshold rearms only after its own hysteresis boundary is crossed. */
export class HistoryQuotaWarnings {
  private warned80 = false;
  private warned95 = false;
  sample(usage: number): 80 | 95 | null {
    if (usage < .75) this.warned80 = false;
    if (usage < .90) this.warned95 = false;
    if (usage >= .95 && !this.warned95) { this.warned80 = this.warned95 = true; return 95; }
    if (usage >= .80 && !this.warned80) { this.warned80 = true; return 80; }
    return null;
  }
}

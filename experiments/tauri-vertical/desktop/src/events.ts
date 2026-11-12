export type SequencedEvent = {seq:number;kind:string;data:string};
/** A purged range may bridge a gap only when the durable marker covers it. */
export function validateSequence(cursor:number,event:SequencedEvent): void {
  if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) throw new Error('Secuencia inválida del runner.');
  if (event.seq === cursor + 1 && event.kind !== 'purged') return;
  if (event.kind === 'purged') {
    const range=JSON.parse(event.data) as {firstSeq?:number;lastSeq?:number};
    if (Number.isSafeInteger(range.firstSeq) && Number.isSafeInteger(range.lastSeq) && range.firstSeq! > 0 && range.firstSeq! <= cursor + 1 && range.lastSeq === event.seq && range.lastSeq! >= range.firstSeq!) return;
  }
  throw new Error('Falta un tramo del historial; se necesita reconstruir la conexión.');
}

import type { IBuffer, Terminal } from '@xterm/xterm';

// A wide character at the right margin leaves a padding cell before wrapping.
// It is not part of the logical line's content offset.
function wrappedColumns(buffer: IBuffer, row: number, cols: number) {
  const last = buffer.getLine(row)?.getCell(cols - 1);
  return cols - (last?.getCode() === 0 && last.getWidth() === 1 &&
    buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2 ? 1 : 0);
}

/** Keep the logical line being read through xterm 5.5's resize/reflow. */
export function preserveTerminalViewport(term: Terminal, change: () => void) {
  const buffer = term.buffer.active;
  if (buffer.type !== 'normal' || buffer.viewportY === buffer.baseY) {
    change();
    return;
  }
  let start = buffer.viewportY;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let offset = 0;
  for (let row = start; row < buffer.viewportY; row++) offset += wrappedColumns(buffer, row, term.cols);
  // Mark the start, since reflow can delete continuation lines. This marker is
  // local to the synchronous geometry change, never retained across output.
  const marker = term.registerMarker(start - buffer.baseY - buffer.cursorY);
  try {
    change();
    if (marker && !marker.isDisposed) {
      let row = marker.line;
      while (buffer.getLine(row + 1)?.isWrapped) {
        const columns = wrappedColumns(buffer, row, term.cols);
        if (offset < columns) break;
        offset -= columns; row++;
      }
      term.scrollToLine(row);
    }
    // Reflow can trim the logical-line start while the fragment being read is
    // still retained. A disposed marker does not mean the reader chose row 0.
    // Keep xterm's post-resize position instead of forcing the oldest row.
  } finally {
    marker?.dispose();
  }
}

/** Reparenting resets DOM scrollTop without changing xterm's buffer position. */
export function syncTerminalViewport(term: Terminal) {
  const buffer = term.buffer.active;
  if (buffer.type !== 'normal' || buffer.baseY === 0) return;
  const line = buffer.viewportY;
  // A no-op scrollToLine does not ask xterm 5.5 to synchronize its viewport.
  // Use its public scroll path so its cached scroll state and DOM agree.
  term.scrollToLine(line === 0 ? 1 : line - 1);
  term.scrollToLine(line);
}

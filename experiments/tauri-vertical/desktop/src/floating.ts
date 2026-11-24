/**
 * One rule for every floating control (pane "…" menu, session picker, alerts
 * popover, Pulso card menu): only one is open at a time, a pointer press
 * outside closes it, Escape closes it and returns focus to its trigger, and
 * focus moving outside it (Tab, another control, another window) closes it. The outside press is taken
 * on `document` in the capture phase, before xterm or any other target sees
 * it, and is never cancelled: the same click still reaches what it hits, so a
 * click on a terminal closes the menu and focuses that terminal. Closing only
 * hides the control (absolute or fixed position): it never resizes a pane.
 */
export type Floating = {
  /** The open control and its trigger: presses inside either do not close it. */
  contains(node: Node): boolean;
  /** `restoreFocus` returns focus to the trigger (Escape); false for outside presses. */
  close(restoreFocus: boolean): void;
};

let current: Floating | null = null;
let installed = false;

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', event => {
    const open = current; if (!open) return;
    const target = event.target;
    if (target instanceof Node && open.contains(target)) return;
    release(open); open.close(false);
  }, true);
  // Focus moving outside (Tab, a programmatic focus, another control) closes it too.
  document.addEventListener('focusin', event => {
    const open = current; if (!open) return;
    const target = event.target;
    if (target instanceof Node && open.contains(target)) return;
    release(open); open.close(false);
  }, true);
  // Another app or window takes the focus.
  window.addEventListener('blur', () => { const open = current; if (open) { release(open); open.close(false); } });
}

/** Call when a floating control opens: the previous one (if any) closes first. */
export function claimFloating(floating: Floating): void {
  install();
  const previous = current;
  current = floating;
  if (previous && previous !== floating) previous.close(false);
}
/** Call when it closes, by any path. */
export function release(floating: Floating): void {
  if (current === floating) current = null;
}
export function openFloating(): Floating | null { return current; }


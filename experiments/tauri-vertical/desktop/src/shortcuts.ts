/**
 * Keyboard shortcuts and the command registry. One source for each command's
 * label, shortcut hint, availability (with the reason when it is unavailable)
 * and execution: the global shortcut handler and the command palette both use
 * it. Commands only call the app's existing functions; destructive or process
 * actions open their usual confirmation instead of acting.
 *
 * ⌘N, ⌘K and ⌘, use the Command key
 * only (any other modifier lets the key through to its target, e.g. the PTY).
 * The palette is ⌘⇧P on macOS and Ctrl+Shift+P elsewhere.
 */
export type ShortcutId = 'new-session' | 'search-sessions' | 'settings' | 'command-palette';

type ShortcutSpec = { key: string; shift: boolean; mac: string; other: string; aria: { mac: string; other: string }; platformPrimary: boolean };
const specs: Record<ShortcutId, ShortcutSpec> = {
  'new-session': { key: 'n', shift: false, mac: '⌘N', other: '⌘N', aria: { mac: 'Meta+N', other: 'Meta+N' }, platformPrimary: false },
  'search-sessions': { key: 'k', shift: false, mac: '⌘K', other: '⌘K', aria: { mac: 'Meta+K', other: 'Meta+K' }, platformPrimary: false },
  settings: { key: ',', shift: false, mac: '⌘,', other: '⌘,', aria: { mac: 'Meta+,', other: 'Meta+,' }, platformPrimary: false },
  // Only this one follows the platform's primary modifier; on macOS Ctrl+Shift+P stays a terminal key.
  'command-palette': { key: 'p', shift: true, mac: '⌘⇧P', other: 'Ctrl+Shift+P', aria: { mac: 'Meta+Shift+P', other: 'Control+Shift+P' }, platformPrimary: true },
};
export const shortcutIds = Object.keys(specs) as ShortcutId[];

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): boolean {
  return /Mac|iPhone|iPad/i.test(nav?.platform || nav?.userAgent || '');
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
/** The shortcut this key event triggers, or null. Never matches with Alt or a stray modifier. */
export function matchShortcut(event: KeyLike, mac: boolean): ShortcutId | null {
  if (event.altKey || typeof event.key !== 'string') return null;
  const key = event.key.toLowerCase();
  for (const id of shortcutIds) {
    const spec = specs[id];
    if (key !== spec.key || event.shiftKey !== spec.shift) continue;
    const primary = spec.platformPrimary && !mac ? event.ctrlKey && !event.metaKey : event.metaKey && !event.ctrlKey;
    if (primary) return id;
  }
  return null;
}

/** Visible hint («⌘⇧P») and the aria-keyshortcuts value («Meta+Shift+P»). */
export function shortcutHint(id: ShortcutId, mac: boolean): string { return mac ? specs[id].mac : specs[id].other; }
export function shortcutAria(id: ShortcutId, mac: boolean): string { return mac ? specs[id].aria.mac : specs[id].aria.other; }

/** How a command asks before acting. Commands that only navigate or toggle a view need nothing. */
export type CommandConfirmation = 'none' | 'dialog' | 'control';
export type AppCommand = {
  id: string;
  label: string;
  /** Extra search words (synonyms); never shown. */
  keywords?: string;
  shortcut?: ShortcutId;
  /** null when it can run now; otherwise the reason shown next to the disabled entry. */
  unavailable: () => string | null;
  run: () => void;
  /** 'dialog' opens the existing confirmation or form; 'control' focuses the existing control to press. */
  confirmation?: CommandConfirmation;
  /** Listed by the palette (the palette's own entry is not). Default true. */
  palette?: boolean;
};

export type ShortcutHandlerOptions = {
  commands: () => readonly AppCommand[];
  mac: boolean;
  /** True when this shortcut must be ignored now (a modal dialog is open, or the palette is open and it is not the palette's own key). */
  blocked: (id: ShortcutId) => boolean;
};

/** IME composition in progress (WebKit also reports keyCode 229): shortcuts never act on it. */
export const composingKey = (event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) => !!event.isComposing || event.keyCode === 229;

/**
 * Returns true when the event belongs to an app shortcut (so xterm must not
 * process it). Only a first keydown runs the command: keypress/keyup and
 * auto-repeated keydowns (a held chord) of the same shortcut are swallowed
 * without acting, so holding ⌘⇧P cannot open and then close the palette and
 * hand the following keys back to the PTY. During IME composition nothing
 * matches and nothing runs.
 */
export function createShortcutHandler(options: ShortcutHandlerOptions): (event: KeyboardEvent) => boolean {
  return event => {
    if (composingKey(event)) return false;
    const id = matchShortcut(event, options.mac);
    if (!id || options.blocked(id)) return false;
    if (event.type !== 'keydown') return true;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return true;
    const command = options.commands().find(entry => entry.shortcut === id);
    if (command && command.unavailable() === null) command.run();
    return true;
  };
}

/**
 * Window listeners. The palette chord is taken in the capture phase, before
 * any target (xterm's textarea, a Codex field, the session picker) sees it, so
 * it never reaches the PTY. The other shortcuts keep their previous rules:
 * ⌘, works everywhere; the rest are ignored while typing in a field, and
 * terminals receive them through xterm's custom key handler instead.
 */
export function installShortcutListeners(target: Window, handle: (event: KeyboardEvent) => boolean, mac: boolean): () => void {
  const capture = (event: KeyboardEvent) => { if (matchShortcut(event, mac) === 'command-palette') handle(event); };
  const bubble = (event: KeyboardEvent) => {
    if (event.key === ',' && handle(event)) return;
    if ((event.target as HTMLElement | null)?.closest?.('.terminal-view, input, textarea, select, [contenteditable]')) return;
    handle(event);
  };
  target.addEventListener('keydown', capture, true);
  target.addEventListener('keydown', bubble);
  return () => { target.removeEventListener('keydown', capture, true); target.removeEventListener('keydown', bubble); };
}

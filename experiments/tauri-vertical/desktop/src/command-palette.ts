import { paintAgentIndicator, providerBadge, agentRank } from './agent-list';
import type { ActivityKind } from './session-activity';

/**
 * Command palette (⌘⇧P): a modal <dialog> centred near the top, with a search
 * field (combobox) and a grouped listbox (APG pattern: aria-activedescendant,
 * named groups). It sits in the top layer, so opening it never changes the
 * terminal host's size and never emits a resize. Focus stays in its field
 * while it is open; every key typed there stops propagating, so nothing
 * reaches the PTY, a Codex field or a global shortcut. Escape, a click outside
 * or running an entry closes it and returns focus to the element focused
 * before (normally the terminal). Disabled entries stay listed with their
 * reason and do nothing.
 */
export type PaletteGroup = 'needs' | 'sessions' | 'projects' | 'phases' | 'actions';
export const paletteGroups: readonly PaletteGroup[] = ['needs', 'sessions', 'projects', 'phases', 'actions'];
export const paletteGroupLabels: Record<PaletteGroup, string> = { needs: 'Te necesitan', sessions: 'Sesiones', projects: 'Proyectos', phases: 'Fases', actions: 'Acciones' };
/** Rows shown per group; the list scrolls inside the dialog. Actions are few and all listed. */
export const paletteGroupLimit: Record<PaletteGroup, number> = { needs: 8, sessions: 12, projects: 12, phases: 12, actions: Infinity };

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text on the right (project, folder or reason). */
  detail?: string;
  keywords?: string;
  /** Visible shortcut hint, e.g. «⌘N». */
  hint?: string;
  /** Short accessible name for the shortcut (aria-keyshortcuts). */
  keyshortcuts?: string;
  /** null or undefined = enabled. */
  disabledReason?: string | null;
  /** State indicator for sessions; also orders equal matches. */
  activity?: { kind: ActivityKind; label: string };
  provider?: string;
  /** Initial tile for projects. */
  initial?: string;
  run: () => void;
};

export const foldText = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
const words = (value: string) => foldText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Simple fuzzy score, no dependency: case and accents are ignored.
 * 5 label starts with the query, 4 a label word starts with it, 3 the label
 * contains it, 2 the label initials start with it («ns» → «Nueva sesión»),
 * 1 every query word is in the label, detail or keywords. 0 = no match.
 */
export function paletteScore(query: string, item: Pick<PaletteItem, 'label' | 'detail' | 'keywords'>): number {
  const q = foldText(query).trim();
  if (!q) return 1;
  const label = foldText(item.label);
  if (label.startsWith(q)) return 5;
  const labelWords = words(item.label);
  if (labelWords.some(word => word.startsWith(q))) return 4;
  if (label.includes(q)) return 3;
  const compact = q.replace(/\s+/g, '');
  if (compact.length > 1 && labelWords.map(word => word[0]).join('').startsWith(compact)) return 2;
  const haystack = foldText(`${item.label} ${item.detail ?? ''} ${item.keywords ?? ''}`);
  const parts = q.split(/\s+/).filter(Boolean);
  return parts.every(part => haystack.includes(part)) ? 1 : 0;
}

export type PaletteSection = { group: PaletteGroup; label: string; items: PaletteItem[]; total: number };
/**
 * Groups in the fixed order (Te necesitan, Sesiones, Proyectos, Acciones);
 * empty groups are dropped. With a query, matches sort by score, then by
 * state priority (needs you first), then by their original order.
 */
export function paletteSections(items: readonly PaletteItem[], query: string, limits: Record<PaletteGroup, number> = paletteGroupLimit): PaletteSection[] {
  const searching = !!foldText(query).trim();
  return paletteGroups.map(group => {
    const ranked = items.map((item, index) => ({ item, index, score: item.group === group ? paletteScore(query, item) : 0 }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => searching ? b.score - a.score || stateRank(a.item) - stateRank(b.item) || a.index - b.index : a.index - b.index);
    return { group, label: paletteGroupLabels[group], items: ranked.slice(0, limits[group]).map(entry => entry.item), total: ranked.length };
  }).filter(section => section.items.length);
}
const stateRank = (item: PaletteItem) => item.activity ? agentRank(item.activity.kind) : 6;

export function resultsAnnouncement(sections: readonly PaletteSection[]): string {
  const count = sections.reduce((sum, section) => sum + section.items.length, 0);
  return count === 0 ? 'Sin resultados' : `${count} ${count === 1 ? 'resultado' : 'resultados'}`;
}

/**
 * Initial active entry: the best enabled match (the first enabled entry with
 * an empty query), so Enter runs what the query names even when an earlier
 * group matched it only by detail. A disabled entry is active only when
 * nothing else matches, so its reason is read.
 */
export function bestIndex(items: readonly PaletteItem[], query: string): number {
  let best = -1, bestScore = 0;
  items.forEach((item, index) => {
    if (item.disabledReason) return;
    const score = paletteScore(query, item);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best >= 0 ? best : items.length ? 0 : -1;
}

let palettes = 0;
export type CommandPaletteOptions = {
  items: () => PaletteItem[];
  /** False when it must not open now (another modal dialog is open). */
  canOpen: () => boolean;
  /** Close popovers, menus and pickers before opening. */
  beforeOpen?: () => void;
  onToggle?: (open: boolean) => void;
};

export class CommandPalette {
  readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly prefix = `command-palette-${++palettes}`;
  private shown: PaletteItem[] = [];
  private active = -1;
  private returnFocus: HTMLElement | null = null;
  private renderedKey = '';

  constructor(private readonly options: CommandPaletteOptions, host: HTMLElement = document.body) {
    this.dialog = document.createElement('dialog'); this.dialog.className = 'command-palette'; this.dialog.setAttribute('aria-label', 'Paleta de comandos');
    const field = document.createElement('div'); field.className = 'command-palette-field';
    field.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
    this.input = document.createElement('input'); this.input.type = 'text'; this.input.className = 'command-palette-search';
    this.input.setAttribute('role', 'combobox'); this.input.setAttribute('aria-autocomplete', 'list'); this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-label', 'Buscar sesiones, proyectos o acciones'); this.input.placeholder = 'Ir a una sesión, un proyecto o una acción';
    this.input.autocomplete = 'off'; this.input.spellcheck = false;
    const esc = document.createElement('kbd'); esc.textContent = 'esc'; esc.setAttribute('aria-hidden', 'true');
    field.append(this.input, esc);
    this.list = document.createElement('div'); this.list.className = 'command-palette-list'; this.list.id = `${this.prefix}-list`;
    this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', 'Resultados');
    this.input.setAttribute('aria-controls', this.list.id);
    this.status = document.createElement('p'); this.status.className = 'sr-only'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.dialog.append(field, this.list, this.status); host.append(this.dialog);

    this.input.addEventListener('input', () => this.render(true));
    this.input.addEventListener('keydown', event => this.key(event));
    // Nothing typed here may reach the terminal or a global shortcut.
    for (const type of ['keyup', 'keypress'] as const) this.input.addEventListener(type, event => event.stopPropagation());
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(true); });
    // A click on the backdrop targets the dialog itself (the content fills it).
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.close(true); });
    this.list.addEventListener('mousedown', event => event.preventDefault());
    this.list.addEventListener('mousemove', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (row && Number(row.dataset.index) !== this.active) this.setActive(Number(row.dataset.index));
    });
    this.list.addEventListener('click', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (row) this.execute(Number(row.dataset.index));
    });
  }

  get isOpen() { return this.dialog.open; }

  toggle() { if (this.isOpen) this.close(true); else this.open(); }

  open() {
    if (this.isOpen || !this.options.canOpen()) return false;
    this.options.beforeOpen?.();
    const previous = document.activeElement;
    this.returnFocus = previous instanceof HTMLElement && previous !== document.body ? previous : null;
    this.input.value = ''; this.renderedKey = '';
    this.dialog.showModal();
    this.render(true);
    this.input.focus({ preventScroll: true });
    this.options.onToggle?.(true);
    return true;
  }

  /** `restore` returns focus to the element focused before opening. */
  close(restore: boolean) {
    if (!this.isOpen) return;
    this.input.blur();
    this.dialog.close();
    // WebKit keeps the rest of the page inert until its style is recomputed,
    // and focus() on the terminal would be ignored until then.
    void document.body.offsetHeight;
    this.input.removeAttribute('aria-activedescendant');
    const target = this.returnFocus; this.returnFocus = null;
    if (restore && target?.isConnected) target.focus({ preventScroll: true });
    this.options.onToggle?.(false);
  }

  /** Re-render while open (sessions or availability changed); keeps the query and active entry. */
  refresh() { if (this.isOpen) this.render(false); }

  dispose() { this.close(false); this.dialog.remove(); }

  private execute(index: number) {
    const item = this.shown[index];
    if (!item) return;
    if (item.disabledReason) { this.setActive(index); this.status.textContent = `${item.label}: no disponible. ${item.disabledReason}.`; return; }
    // Close first so focus is back where it was (the terminal) before the
    // command opens a dialog that remembers and restores that focus.
    this.close(true);
    item.run();
  }

  private key(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    const keys = ['ArrowDown', 'ArrowUp'];
    if (keys.includes(event.key) || (['Home', 'End'].includes(event.key) && (!this.input.value || event.ctrlKey || event.metaKey))) {
      event.preventDefault(); this.move(event.key); return;
    }
    if (event.key === 'Enter') { event.preventDefault(); this.execute(this.active); return; }
    if (event.key === 'Escape') { event.preventDefault(); this.close(true); return; }
    // Tab stays in the field (the only tabbable control of this modal dialog).
    if (event.key === 'Tab') event.preventDefault();
  }

  /** Disabled entries are reachable (their reason is read) but never run. Wraps around. */
  private move(key: string) {
    const count = this.shown.length; if (!count) return;
    const next = key === 'Home' ? 0 : key === 'End' ? count - 1 : key === 'ArrowDown' ? (this.active + 1 + count) % count : (this.active - 1 + count) % count;
    this.setActive(this.active < 0 && key === 'ArrowUp' ? count - 1 : next);
  }

  private setActive(index: number) {
    this.active = index;
    for (const row of Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'))) {
      const on = Number(row.dataset.index) === index;
      row.classList.toggle('is-active', on); row.setAttribute('aria-selected', String(on));
    }
    const row = this.list.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!row) { this.input.removeAttribute('aria-activedescendant'); return; }
    this.input.setAttribute('aria-activedescendant', row.id);
    // Scroll the list only; never an ancestor of the terminal.
    const group = row.closest<HTMLElement>('[role="group"]');
    const top = index === this.firstIndexOf(group) && group ? group.offsetTop : row.offsetTop, bottom = row.offsetTop + row.offsetHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
  }

  private firstIndexOf(group: HTMLElement | null) { return Number(group?.querySelector<HTMLElement>('[role="option"]')?.dataset.index ?? -1); }

  private render(resetActive: boolean) {
    const previous = this.shown[this.active]?.id;
    const sections = paletteSections(this.options.items(), this.input.value);
    this.shown = sections.flatMap(section => section.items);
    // Periodic refreshes keep the rows mounted unless something visible changed.
    const key = JSON.stringify(sections.map(section => [section.group, section.items.map(item => [item.id, item.label, item.detail, item.disabledReason, item.hint, item.activity?.kind, item.activity?.label])]));
    if (key !== this.renderedKey || resetActive) this.paint(sections, key);
    this.status.textContent = resultsAnnouncement(sections);
    const kept = previous === undefined || resetActive ? -1 : this.shown.findIndex(item => item.id === previous);
    this.setActive(kept >= 0 ? kept : bestIndex(this.shown, this.input.value));
  }

  private paint(sections: readonly PaletteSection[], key: string) {
    this.renderedKey = key;
    this.list.replaceChildren();
    let index = 0;
    for (const section of sections) {
      const group = document.createElement('div'); group.setAttribute('role', 'group'); group.className = 'command-palette-group';
      const heading = document.createElement('div'); heading.className = 'command-palette-heading'; heading.id = `${this.prefix}-${section.group}`;
      heading.setAttribute('role', 'presentation'); heading.textContent = section.label;
      group.setAttribute('aria-labelledby', heading.id); group.dataset.group = section.group; group.append(heading);
      for (const item of section.items) group.append(this.row(item, index++));
      this.list.append(group);
    }
    if (!this.shown.length) {
      const empty = document.createElement('p'); empty.className = 'command-palette-empty'; empty.textContent = 'Nada coincide. Prueba con otro nombre.'; this.list.append(empty);
    }
  }

  private row(item: PaletteItem, index: number) {
    const row = document.createElement('div'); row.setAttribute('role', 'option'); row.className = 'command-palette-option';
    row.id = `${this.prefix}-option-${index}`; row.dataset.index = String(index); row.dataset.itemId = item.id;
    row.setAttribute('aria-selected', 'false'); row.setAttribute('aria-disabled', String(!!item.disabledReason));
    if (item.keyshortcuts) row.setAttribute('aria-keyshortcuts', item.keyshortcuts);
    const lead = document.createElement('span'); lead.className = 'command-palette-lead'; lead.setAttribute('aria-hidden', 'true');
    if (item.activity) {
      const indicator = document.createElement('span'); indicator.className = 'agent-indicator'; paintAgentIndicator(indicator, item.activity.kind, item.activity.label); lead.append(indicator);
    }
    if (item.provider) {
      const badge = document.createElement('span'); badge.className = 'provider-badge'; const provider = providerBadge(item.provider);
      badge.dataset.provider = provider.provider; badge.textContent = provider.letter; lead.append(badge);
    }
    if (item.initial) { const tile = document.createElement('span'); tile.className = 'project-initial'; tile.textContent = item.initial; lead.append(tile); }
    const name = document.createElement('span'); name.className = 'command-palette-name'; name.textContent = item.label;
    row.append(lead, name);
    const detailText = item.disabledReason ?? item.detail ?? '';
    if (detailText) {
      const detail = document.createElement('span'); detail.className = 'command-palette-detail'; detail.textContent = detailText;
      if (item.disabledReason) detail.dataset.reason = 'true';
      row.append(detail);
    }
    if (item.activity) { const state = document.createElement('span'); state.className = 'sr-only'; state.textContent = `, ${item.activity.label}`; name.append(state); }
    if (item.hint) { const hint = document.createElement('kbd'); hint.textContent = item.hint; hint.setAttribute('aria-hidden', 'true'); row.append(hint); }
    row.title = item.disabledReason ? `${item.label} · ${item.disabledReason}` : item.detail ? `${item.label} · ${item.detail}` : item.label;
    return row;
  }
}

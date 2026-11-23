import { providerLabel } from './workspace';

/**
 * Session picker for a pane: a button in the pane heading opens a search
 * field (combobox) and a listbox. It replaces the native <select>. Keys typed
 * into the field are handled here and never reach the terminal: focus sits in
 * an ordinary input outside xterm, and every handled key stops propagating.
 * The popup is absolutely positioned inside the pane, so opening or closing it
 * never changes the terminal host's size.
 */
export type PickerSession = { id: string; title: string; kind: string; status: string; cwd: string | null };
export type PickerOption = { id: string; label: string; detail: string; group: 'none' | 'open' | 'history'; disabled: boolean; selected: boolean; kind: string };

const closedStatuses = ['exited', 'stopped', 'failed', 'interrupted', 'released'];
export const pickerGroupLabels = { none: '', open: 'Abiertas', history: 'Historial' } as const;

/** Same names and disambiguation as the former native select; same grouping and disabling. */
export function sessionPickerOptions(sessions: readonly PickerSession[], paneIndex: number, paneIds: readonly (string | null)[], split: boolean): PickerOption[] {
  const own = paneIds[paneIndex] ?? null;
  const options: PickerOption[] = [{ id: '', label: 'Sin sesión', detail: 'Vaciar este panel', group: 'none', disabled: false, selected: own === null, kind: '' }];
  for (const history of [false, true]) {
    for (const s of sessions.filter(s => closedStatuses.includes(s.status) === history)) {
      const provider = providerLabel(s.kind);
      const name = s.title.trim().toLocaleLowerCase() === provider.toLocaleLowerCase() ? s.title : `${s.title} · ${provider}`;
      const duplicates = sessions.filter(other => other.title === s.title);
      const folder = s.cwd?.split('/').filter(Boolean).pop();
      const sameFolder = duplicates.filter(other => other.cwd?.split('/').filter(Boolean).pop() === folder).length > 1;
      const label = name + (duplicates.length > 1 ? ` · ${folder ?? s.id.slice(-8)}${folder && sameFolder ? ` (${s.id.slice(-8)})` : ''}` : '');
      // A session already shown in another visible pane cannot be chosen here.
      const disabled = paneIds.some((id, index) => index !== paneIndex && (split || index === 0) && id === s.id);
      options.push({ id: s.id, label, detail: s.cwd ?? '', group: history ? 'history' : 'open', disabled, selected: own === s.id, kind: s.kind });
    }
  }
  return options;
}

const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
/** Every word of the query must appear in the label or folder; accents and case are ignored. */
export function filterPickerOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...options];
  return options.filter(option => option.id && words.every(word => fold(`${option.label} ${option.detail}`).includes(word)));
}

/** Next enabled option index for ArrowUp/ArrowDown/Home/End; wraps around. -1 when none is enabled. */
export function movePickerIndex(options: readonly PickerOption[], current: number, key: string): number {
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1)!;
  const position = enabled.indexOf(current);
  if (key === 'ArrowDown') return position < 0 ? enabled[0] : enabled[(position + 1) % enabled.length];
  if (key === 'ArrowUp') return position < 0 ? enabled.at(-1)! : enabled[(position - 1 + enabled.length) % enabled.length];
  return current;
}

let pickers = 0;
export type SessionPickerOptions = {
  trigger: HTMLButtonElement;
  container: HTMLElement;
  label: string;
  options: () => PickerOption[];
  onSelect: (id: string | null) => void;
  /** Called after an Escape/Tab/outside close; `restore` asks to return focus to the terminal. */
  onClose: (restore: boolean) => void;
};

export class SessionPicker {
  readonly popup: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private readonly prefix = `session-picker-${++pickers}`;
  private shown: PickerOption[] = [];
  private active = -1;
  private renderedKey = '';
  private readonly outside = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!this.popup.contains(target) && !this.options.trigger.contains(target)) this.close(false);
  };

  constructor(private readonly options: SessionPickerOptions) {
    const { trigger, container, label } = options;
    this.popup = document.createElement('div'); this.popup.className = 'session-picker'; this.popup.hidden = true; this.popup.id = this.prefix;
    this.input = document.createElement('input'); this.input.type = 'text'; this.input.className = 'session-picker-search';
    this.input.setAttribute('role', 'combobox'); this.input.setAttribute('aria-autocomplete', 'list'); this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-label', `Buscar sesión · ${label}`); this.input.placeholder = 'Buscar sesión'; this.input.autocomplete = 'off'; this.input.spellcheck = false;
    this.list = document.createElement('div'); this.list.className = 'session-picker-list'; this.list.id = `${this.prefix}-list`;
    this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', label);
    this.input.setAttribute('aria-controls', this.list.id);
    this.popup.append(this.input, this.list); container.append(this.popup);
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', this.popup.id);
    trigger.addEventListener('click', () => { if (this.isOpen) this.close(true); else this.open(); });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this.open(); }
    });
    this.input.addEventListener('input', () => { this.renderedKey = ''; this.render(true); });
    this.input.addEventListener('keydown', event => this.key(event));
    // Typing in the field must not reach global shortcuts or the PTY.
    for (const type of ['keyup', 'keypress'] as const) this.input.addEventListener(type, event => event.stopPropagation());
    this.list.addEventListener('mousedown', event => event.preventDefault());
    this.list.addEventListener('click', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (!row || row.getAttribute('aria-disabled') === 'true') return;
      this.choose(row.dataset.sessionId ?? '');
    });
  }

  get isOpen() { return !this.popup.hidden; }

  open() {
    if (this.isOpen || this.options.trigger.disabled) return;
    this.input.value = ''; this.renderedKey = '';
    this.popup.hidden = false; this.options.trigger.setAttribute('aria-expanded', 'true');
    this.render(false);
    const selected = this.shown.findIndex(option => option.selected && !option.disabled);
    this.setActive(selected >= 0 ? selected : movePickerIndex(this.shown, -1, 'ArrowDown'));
    document.addEventListener('pointerdown', this.outside, true);
    this.input.focus({ preventScroll: true });
  }

  close(restore: boolean) {
    if (!this.isOpen) return;
    this.popup.hidden = true; this.options.trigger.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    document.removeEventListener('pointerdown', this.outside, true);
    this.options.onClose(restore);
  }

  /** Re-render while open when sessions or panes change; keeps the query and active row. */
  refresh() { if (this.isOpen) this.render(false); }

  dispose() { this.close(false); this.popup.remove(); }

  private choose(id: string) {
    this.popup.hidden = true; this.options.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outside, true);
    this.options.onSelect(id || null);
  }

  private key(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key) || (['Home', 'End'].includes(event.key) && (event.ctrlKey || event.metaKey))) {
      event.preventDefault(); this.setActive(movePickerIndex(this.shown, this.active, event.key)); return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = this.shown[this.active];
      if (option && !option.disabled) this.choose(option.id);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); this.close(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); this.close(true); }
  }

  private setActive(index: number) {
    this.active = index;
    for (const row of Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'))) row.classList.toggle('is-active', Number(row.dataset.index) === index);
    const row = this.list.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (row) {
      this.input.setAttribute('aria-activedescendant', row.id);
      // Scroll the list only; scrollIntoView could move clipped ancestors and the terminal.
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < this.list.scrollTop) this.list.scrollTop = top;
      else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
    }
    else this.input.removeAttribute('aria-activedescendant');
  }

  private render(resetActive: boolean) {
    const previous = this.shown[this.active]?.id;
    this.shown = filterPickerOptions(this.options.options(), this.input.value);
    const key = JSON.stringify(this.shown);
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.list.replaceChildren();
      let group: HTMLElement | null = null; let groupName = '';
      this.shown.forEach((option, index) => {
        if (option.group !== 'none' && option.group !== groupName) {
          groupName = option.group;
          group = document.createElement('div'); group.setAttribute('role', 'group');
          const heading = document.createElement('div'); heading.className = 'session-picker-group'; heading.id = `${this.prefix}-${groupName}`;
          heading.setAttribute('role', 'presentation'); heading.textContent = pickerGroupLabels[option.group];
          group.setAttribute('aria-labelledby', heading.id); group.append(heading); this.list.append(group);
        }
        const row = document.createElement('div'); row.setAttribute('role', 'option'); row.className = 'session-picker-option';
        row.id = `${this.prefix}-option-${index}`; row.dataset.index = String(index); row.dataset.sessionId = option.id;
        row.setAttribute('aria-selected', String(option.selected)); row.setAttribute('aria-disabled', String(option.disabled));
        if (option.disabled) row.title = 'Ya está visible en el otro panel';
        const badge = document.createElement('span'); badge.className = 'provider-badge'; badge.setAttribute('aria-hidden', 'true');
        const provider = option.kind === 'claude' || option.kind === 'codex' ? option.kind : 'terminal';
        badge.dataset.provider = provider; badge.textContent = option.id ? provider === 'claude' ? 'C' : provider === 'codex' ? 'X' : '$' : '–';
        const name = document.createElement('span'); name.className = 'session-picker-name'; name.textContent = option.label;
        const detail = document.createElement('span'); detail.className = 'session-picker-detail'; detail.textContent = option.disabled ? 'En el otro panel' : option.detail;
        row.append(badge, name, detail);
        (option.group === 'none' ? this.list : group ?? this.list).append(row);
      });
      if (!this.shown.length) {
        const empty = document.createElement('p'); empty.className = 'session-picker-empty'; empty.textContent = 'Ninguna sesión coincide.'; this.list.append(empty);
      }
    }
    const kept = previous === undefined ? -1 : this.shown.findIndex(option => option.id === previous && !option.disabled);
    this.setActive(!resetActive && kept >= 0 ? kept : movePickerIndex(this.shown, -1, 'ArrowDown'));
  }
}

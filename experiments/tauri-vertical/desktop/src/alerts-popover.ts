import { agentRank, paintAgentIndicator } from './agent-list';
import type { ActivityKind } from './session-activity';

/**
 * Avisos in the top bar: the bell opens this popover; the pane heading and the
 * status bar carry the same priority alert in fixed-height slots. The popover
 * floats over the workbench (absolute positioning), so opening it, marking alerts
 * seen or receiving a new one never changes the terminal's size.
 */
export type AlertRow = { id: string; title: string; label: string; reason: string; unseen: boolean; kind: ActivityKind; unseenKeys?: readonly string[] };
type AlertInput = { id: string; reason: string; unseen: boolean; unseenKeys?: readonly string[] };

/** Rows in the sidebar's priority order: action, notices, unseen finish, working, waiting, no report; unseen first. */
export function alertRows(alerts: readonly AlertInput[], titleOf: (id: string) => string | undefined, activityOf: (id: string) => { kind: ActivityKind; label: string } | undefined): AlertRow[] {
  return alerts.map((alert, index) => {
    const activity = activityOf(alert.id);
    return { index, row: { id: alert.id, title: titleOf(alert.id) ?? 'Sesión', label: activity?.label ?? 'Aviso', reason: alert.reason, unseen: alert.unseen, kind: activity?.kind ?? 'unreported', ...(alert.unseenKeys ? { unseenKeys: alert.unseenKeys } : {}) } };
  }).sort((a, b) => agentRank(a.row.kind) - agentRank(b.row.kind) || Number(b.row.unseen) - Number(a.row.unseen) || a.index - b.index).map(entry => entry.row);
}

/** Status-bar counters: halo shapes (needs + notices), unseen finishes (check) and explicit working reports. */
export function statusCounts(kinds: readonly ActivityKind[]) {
  return { needs: kinds.filter(kind => kind === 'needs' || kind === 'notice').length, finished: kinds.filter(kind => kind === 'finished').length, working: kinds.filter(kind => kind === 'working').length };
}
export const needsLabel = (count: number) => `${count} te ${count === 1 ? 'necesita' : 'necesitan'}`;
export const finishedLabel = (count: number) => `${count} ${count === 1 ? 'terminó' : 'terminaron'}`;
export const workingLabel = (count: number) => `${count} trabajando`;
/**
 * The quiet slot agrees with the bell: «Sin avisos» only when the bell is at zero.
 * Alerts that no counter shows (rare lifecycle causes) read «N avisos».
 */
export function quietLabel(alerts: number, counts: { needs: number; finished: number }, hidden = 0): string | null {
  if (alerts === 0) return 'Sin avisos';
  if (counts.needs + counts.finished === 0) return `${alerts} ${alerts === 1 ? 'aviso' : 'avisos'}`;
  // Runner hasMore: the bell and the Dock count sessions the counters cannot classify; say so here too.
  return hidden > 0 ? `${hidden} sin listar` : null;
}

/** Identity of an unseen alert: its keys (runner keys carry epoch and sequence), else session and reason. */
const rowKeys = (row: AlertRow) => row.unseenKeys?.length ? row.unseenKeys : [`${row.id}:${row.reason}`];
/** Text for the polite live region when unseen alerts appear; null when nothing new arrived. */
export function alertAnnouncement(previous: ReadonlySet<string>, rows: readonly AlertRow[]): string | null {
  const fresh = rows.filter(row => row.unseen && rowKeys(row).some(key => !previous.has(key)));
  if (!fresh.length) return null;
  const first = fresh[0];
  return fresh.length === 1 ? `Nuevo aviso: ${first.title} · ${first.label}.` : `${fresh.length} avisos nuevos. El primero: ${first.title} · ${first.label}.`;
}
export const unseenKeys = (rows: readonly AlertRow[]) => new Set(rows.filter(row => row.unseen).flatMap(rowKeys));

export type AlertsPopoverOptions = {
  button: HTMLButtonElement;
  panel: HTMLElement;
  list: HTMLElement;
  onOpenSession: (id: string) => void;
  /** Opening or closing changed; the owner re-renders (and hides the panel). */
  onToggle?: () => void;
};

import { claimFloating, release } from './floating';

export class AlertsPopover {
  private open = false;
  private renderedKey = '';
  /** Shared dismissal rule (floating.ts): only one floating control open at a time. */
  private readonly floating = { contains: (node: Node) => this.options.panel.contains(node) || this.options.button.contains(node), close: (restore: boolean) => this.close(restore) };
  private readonly outside = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!this.options.panel.contains(target) && !this.options.button.contains(target)) this.close(false);
  };
  private readonly escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.open) return;
    event.preventDefault(); event.stopPropagation(); this.close(true);
  };

  constructor(private readonly options: AlertsPopoverOptions) {
    options.button.setAttribute('aria-haspopup', 'dialog'); options.button.setAttribute('aria-expanded', 'false');
    options.button.setAttribute('aria-controls', options.panel.id);
    options.panel.addEventListener('keydown', this.escape);
    // Escape also closes it from the bell itself while expanded.
    options.button.addEventListener('keydown', this.escape);
    options.list.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-session-id]');
      if (button) { this.close(false); options.onOpenSession(button.dataset.sessionId!); }
    });
  }

  get isOpen() { return this.open; }
  toggle() { if (this.open) this.close(true); else this.show(); }
  show() {
    if (this.open) return;
    this.open = true; this.options.button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.outside, true);
    claimFloating(this.floating);
    this.options.onToggle?.();
  }
  /** The caller hides the panel on its next render; `focusButton` returns focus to the bell. */
  close(focusButton: boolean) {
    if (!this.open) return;
    this.open = false; this.options.button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outside, true);
    release(this.floating);
    if (focusButton && !this.options.button.hidden) this.options.button.focus({ preventScroll: true });
    this.options.onToggle?.();
  }

  /** Rows keep their buttons mounted while only metadata changes. `more`: runner alerts not listed (hasMore). */
  render(rows: readonly AlertRow[], more = 0) {
    const key = JSON.stringify([rows.map(row => row.id), more]);
    const list = this.options.list;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : undefined;
      list.replaceChildren();
      for (const row of rows) {
        const item = document.createElement('li'); item.className = 'alerts-row'; item.dataset.alertId = row.id;
        const indicator = document.createElement('span'); indicator.className = 'agent-indicator'; indicator.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span'); copy.className = 'alerts-row-copy';
        const title = document.createElement('span'); title.className = 'alerts-row-title';
        const reason = document.createElement('span'); reason.className = 'alerts-row-reason';
        copy.append(title, reason);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'quiet alerts-row-open'; open.dataset.sessionId = row.id; open.textContent = 'Abrir';
        item.append(indicator, copy, open); list.append(item);
      }
      if (more) {
        // Discreet and non-interactive: the list is not complete.
        const hint = document.createElement('li'); hint.className = 'alerts-more';
        hint.textContent = `y ${more} más sin listar`; hint.title = 'El runner tiene más sesiones con avisos de las que envió. Abrir y marcar vistas las de la lista deja sitio a las demás.';
        list.append(hint);
      }
      if (focused) list.querySelector<HTMLElement>(`button[data-session-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
    for (const row of rows) {
      const item = list.querySelector<HTMLElement>(`[data-alert-id="${CSS.escape(row.id)}"]`); if (!item) continue;
      item.dataset.unseen = String(row.unseen);
      paintAgentIndicator(item.querySelector<HTMLElement>('.agent-indicator')!, row.kind, row.label);
      const title = item.querySelector('.alerts-row-title')!; if (title.textContent !== row.title) title.textContent = row.title;
      const reason = `${row.unseen ? 'Sin ver' : 'Visto'} · ${row.label}${row.reason && row.reason !== row.label ? ` · ${row.reason}` : ''}`;
      const reasonNode = item.querySelector('.alerts-row-reason')!; if (reasonNode.textContent !== reason) reasonNode.textContent = reason;
      const open = item.querySelector<HTMLButtonElement>('button')!; const label = `Abrir sesión ${row.title}`;
      if (open.getAttribute('aria-label') !== label) open.setAttribute('aria-label', label);
    }
  }
}

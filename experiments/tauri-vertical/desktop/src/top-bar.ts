import { paintAgentIndicator, providerBadge } from './agent-list';
import type { ActivityKind } from './session-activity';

/**
 * Top bar (42 px): one raised tab per open session, in runner order. A tab
 * selects its session in the focused pane, like a sidebar row. Sessions shown
 * in a pane keep their tab even after they close, so the bar always names
 * what is on screen. Overflow scrolls horizontally inside the strip.
 */
export type TabSession = { id: string; title: string; kind: string; status: string };
export type SessionTab = { id: string; title: string; kind: string; activity: ActivityKind; label: string; current: boolean; shown: boolean };

const closedStatuses = ['exited', 'stopped', 'failed', 'interrupted', 'released'];

export function sessionTabs(sessions: readonly TabSession[], shownIds: readonly (string | null)[], currentId: string | null | undefined,
  activityOf: (id: string) => { kind: ActivityKind; label: string } | undefined): SessionTab[] {
  return sessions.filter(s => !closedStatuses.includes(s.status) || shownIds.includes(s.id)).map(s => {
    const activity = activityOf(s.id);
    return { id: s.id, title: s.title, kind: s.kind, activity: activity?.kind ?? 'unreported', label: activity?.label ?? '', current: s.id === currentId, shown: shownIds.includes(s.id) };
  });
}

/** Keyed: buttons stay mounted while metadata changes, so a click in progress is never lost. */
export function renderSessionTabs(host: HTMLElement, tabs: readonly SessionTab[], onSelect: (id: string) => void) {
  const existing = new Map(Array.from(host.querySelectorAll<HTMLButtonElement>('button.session-tab')).map(button => [button.dataset.sessionId!, button]));
  const order = tabs.map(tab => tab.id).join('\n');
  if (host.dataset.order !== order) {
    host.dataset.order = order;
    for (const [id, button] of existing) if (!tabs.some(tab => tab.id === id)) { button.remove(); existing.delete(id); }
    for (const tab of tabs) {
      let button = existing.get(tab.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'session-tab'; button.dataset.sessionId = tab.id;
        button.innerHTML = '<span class="provider-badge" aria-hidden="true"></span><span class="session-tab-title"></span><span class="agent-indicator" aria-hidden="true"></span><span class="sr-only session-tab-state"></span>';
        const id = tab.id; button.addEventListener('click', () => onSelect(id));
        existing.set(tab.id, button);
      }
      host.append(button);
    }
  }
  for (const tab of tabs) {
    const button = existing.get(tab.id)!;
    button.setAttribute('aria-current', String(tab.current));
    button.dataset.shown = String(tab.shown);
    const badge = button.querySelector<HTMLElement>('.provider-badge')!; const provider = providerBadge(tab.kind);
    if (badge.dataset.provider !== provider.provider) { badge.dataset.provider = provider.provider; badge.textContent = provider.letter; }
    const title = button.querySelector('.session-tab-title')!; if (title.textContent !== tab.title) title.textContent = tab.title;
    paintAgentIndicator(button.querySelector<HTMLElement>('.agent-indicator')!, tab.activity, tab.label);
    const state = button.querySelector('.session-tab-state')!; const text = tab.label ? `, ${tab.label}` : '';
    if (state.textContent !== text) state.textContent = text;
    const tooltip = tab.label ? `${tab.title} · ${tab.label}` : tab.title;
    if (button.title !== tooltip) button.title = tooltip;
  }
  const current = tabs.find(tab => tab.current);
  if (current && host.dataset.current !== current.id) {
    host.dataset.current = current.id;
    // Scroll only the strip: scrollIntoView could also scroll clipped ancestors
    // (overflow: hidden is still programmatically scrollable) and move the terminal.
    const button = existing.get(current.id);
    if (button) {
      if (button.offsetLeft < host.scrollLeft) host.scrollLeft = Math.max(0, button.offsetLeft - 8);
      else if (button.offsetLeft + button.offsetWidth > host.scrollLeft + host.clientWidth) host.scrollLeft = button.offsetLeft + button.offsetWidth - host.clientWidth + 8;
    }
  }
}

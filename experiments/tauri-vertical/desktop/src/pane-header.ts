import { paintAgentIndicator, providerBadge } from './agent-list';
import type { ActivityKind } from './session-activity';
import { icon } from './ui';

/**
 * One fixed 32 px heading per pane: provider, session name (opens the session
 * picker), folder, state label, Interrumpir and the "…" menu. Everything in it
 * is nowrap and clipped, so no state, alert or name change can alter the height
 * left to the terminal host below it (docs/SESSION_ALERTS.md).
 */
export function paneMarkup(index: number) {
  const chevron = '<svg class="icon pane-session-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  return `<div class="pane-heading"><span class="provider-badge pane-provider" aria-hidden="true">$</span>`
    + `<button id="session-${index}" type="button" class="pane-session-button" data-session-id="" aria-label="Sesión del panel ${index + 1}: sin sesión"><span class="pane-session-name">Elegir sesión</span>${chevron}</button>`
    + `<span class="session-directory">Sin carpeta de sesión</span>`
    + `<span class="pane-status"><span class="agent-indicator" aria-hidden="true"></span><span class="session-state">Sin sesión</span></span>`
    + `<span class="history-banner sr-only" hidden></span>`
    + `<button data-action="interrupt" data-label="Interrumpir" class="icon-button interrupt-button" aria-label="Interrumpir (Ctrl-C)" title="Interrumpir (Ctrl-C)">${icon('interrupt')}</button>`
    + `<details class="pane-menu"><summary aria-label="Acciones de la sesión" title="Acciones de la sesión">${icon('more')}</summary><div class="pane-menu-content">`
    + `<button data-action="rename" hidden>Cambiar nombre…</button>`
    + `<button data-action="stop" data-label="Terminar" class="danger stop-button" disabled>${icon('stop')}Terminar sesión…</button>`
    + `<button data-action="release" hidden>Liberar carpeta…</button>`
    + `<div class="fixture-controls" hidden><button data-action="shell">Shell de prueba</button><button data-action="ping">Ping</button><button data-action="size">Tamaño</button><button data-action="flood">Carga</button></div>`
    + `</div></details></div>`
    + `<div class="terminal-host"><div class="empty"><span>${icon('split')}</span><strong>Elige otra sesión</strong><p>Pulsa el nombre en la cabecera del panel para elegir una sesión y verla junto a la actual.</p></div></div>`;
}

export type PaneHeaderModel = {
  kind: string | null;
  title: string | null;
  cwd: string | null;
  state: string;
  stateKey: string;
  activity: ActivityKind | null;
  activityLabel: string;
  history: string;
  paneIndex: number;
};

const set = (el: Element, value: string) => { if (el.textContent !== value) el.textContent = value; };
const attr = (el: Element, name: string, value: string) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

export function paintPaneHeader(root: HTMLElement, model: PaneHeaderModel): void {
  const badge = root.querySelector<HTMLElement>('.pane-provider')!;
  const provider = model.kind ? providerBadge(model.kind) : { provider: 'terminal', letter: '–' };
  if (badge.dataset.provider !== provider.provider || badge.textContent !== provider.letter) { badge.dataset.provider = provider.provider; badge.textContent = provider.letter; }
  const trigger = root.querySelector<HTMLButtonElement>('.pane-session-button')!;
  set(trigger.querySelector('.pane-session-name')!, model.title ?? 'Elegir sesión');
  attr(trigger, 'aria-label', `Sesión del panel ${model.paneIndex + 1}: ${model.title ?? 'sin sesión'}`);
  attr(trigger, 'title', model.title ? `${model.title} · cambiar sesión` : 'Elegir sesión');
  const cwd = root.querySelector<HTMLElement>('.session-directory')!;
  set(cwd, model.cwd ?? 'Sin carpeta de sesión'); if (cwd.title !== (model.cwd ?? '')) cwd.title = model.cwd ?? '';
  const state = root.querySelector<HTMLElement>('.session-state')!;
  set(state, model.state); if (state.title !== model.state) state.title = model.state;
  if (state.dataset.state !== model.stateKey) state.dataset.state = model.stateKey;
  const status = root.querySelector<HTMLElement>('.pane-status')!;
  const tone = model.activity ? model.activity : 'none';
  if (status.dataset.activity !== tone) status.dataset.activity = tone;
  const indicator = status.querySelector<HTMLElement>('.agent-indicator')!;
  indicator.hidden = !model.activity;
  if (model.activity) paintAgentIndicator(indicator, model.activity, model.activityLabel);
  const history = root.querySelector<HTMLElement>('.history-banner')!;
  history.hidden = !model.history; set(history, model.history);
}

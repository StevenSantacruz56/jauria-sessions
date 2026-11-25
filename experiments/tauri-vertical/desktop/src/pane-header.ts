import { paintAgentIndicator, providerBadge } from './agent-list';
import type { ActivityKind } from './session-activity';
import { icon } from './ui';

/**
 * One fixed 32 px heading per pane: provider, session name (opens the session
 * picker), folder, state label, Cancelar (Ctrl-C) and the "…" menu. Everything in it
 * is nowrap and clipped, so no state, alert or name change can alter the height
 * left to the terminal host below it (docs/SESSION_ALERTS.md).
 */
export function paneMarkup(index: number) {
  const chevron = '<svg class="icon pane-session-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  return `<div class="pane-heading"><span class="provider-badge pane-provider" aria-hidden="true">$</span>`
    + `<button id="session-${index}" type="button" class="pane-session-button" data-session-id="" aria-label="Sesión del panel ${index + 1}: sin sesión"><span class="pane-session-name">Elegir sesión</span>${chevron}</button>`
    + `<span class="session-directory">Sin carpeta de sesión</span>`
    + `<span class="pane-status"><span class="agent-indicator" aria-hidden="true"></span><span class="session-state">Sin sesión</span></span>`
    + `<span class="history-banner" hidden><span class="history-long"></span><span class="history-short">Solo lectura</span></span>`
    + `<button type="button" data-action="close-pane" class="quiet pane-close" hidden aria-label="Quitar la sesión terminada de este panel" title="Quitar esta sesión del panel; sigue en Historial">Cerrar</button>`
    + `<button data-action="interrupt" data-label="Cancelar (Ctrl-C)" class="icon-button interrupt-button" aria-label="Cancelar (Ctrl-C)" aria-description="Cancela lo que está haciendo; la sesión sigue abierta" title="Cancelar (Ctrl-C) · Cancela lo que está haciendo; la sesión sigue abierta">${icon('interrupt')}</button>`
    + `<details class="pane-menu"><summary aria-label="Acciones de la sesión" title="Acciones de la sesión">${icon('more')}</summary><div class="pane-menu-content">`
    + `<div class="pane-menu-info"><span class="pane-menu-folder">Sin carpeta</span><span class="pane-menu-meta"></span></div>`
    + `<button data-action="copy-cwd">Copiar carpeta</button><button data-action="copy-id">Copiar identificador</button>`
    + `<button data-action="new-in-folder">Nueva sesión en esta carpeta…</button>`
    + `<button data-action="rename" hidden>Cambiar nombre…</button>`
    + `<button data-action="stop" data-label="Terminar" class="danger stop-button" disabled>${icon('stop')}Terminar sesión…</button>`
    + `<button data-action="release" hidden title="Jauría no puede confirmar que el proceso terminó; libera su plaza sin señalarlo">Liberar plaza…</button>`
    + `<p class="pane-menu-note" hidden></p><button data-action="purge" hidden>Eliminar salida guardada…</button><button data-action="compact" hidden>Compactar eventos antiguos…</button>`
    + `<div class="fixture-controls" hidden><button data-action="shell">Shell de prueba</button><button data-action="ping">Ping</button><button data-action="size">Tamaño</button><button data-action="flood">Carga</button></div>`
    + `</div></details></div>`
    // Recovery of an Interrumpida: floats over the terminal (absolute), never changes its size.
    + `<section class="pane-recovery" role="region" aria-label="Recuperar la sesión interrumpida" hidden><div class="pane-recovery-copy"><p class="pane-recovery-title">Sesión interrumpida</p><p class="pane-recovery-detail"></p><p class="pane-recovery-note"></p></div>`
    + `<div class="pane-recovery-actions"><button type="button" class="primary" data-recovery="primary">Continuar conversación</button><button type="button" class="secondary" data-recovery="output">Ver salida</button><button type="button" class="quiet" data-recovery="expand" hidden>Opciones…</button><button type="button" class="quiet" data-recovery="dismiss" title="La pasa a Terminadas; no borra nada">Descartar</button></div></section>`
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
  /** Menu details: provider, state and identifier (for support), and the local history note. */
  meta?: string;
  note?: string;
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
  // Visible, fixed-height label; below 760 px only «Solo lectura» shows (CSS).
  const folder = root.querySelector<HTMLElement>('.pane-menu-folder');
  if (folder) { set(folder, model.cwd ?? 'Sin carpeta'); if (folder.title !== (model.cwd ?? '')) folder.title = model.cwd ?? ''; }
  const meta = root.querySelector<HTMLElement>('.pane-menu-meta'); if (meta) set(meta, model.meta ?? '');
  const note = root.querySelector<HTMLElement>('.pane-menu-note'); if (note) { note.hidden = !model.note; set(note, model.note ?? ''); }
  const history = root.querySelector<HTMLElement>('.history-banner')!;
  history.hidden = !model.history; set(history.querySelector('.history-long')!, model.history);
  if (history.title !== model.history) history.title = model.history;
}

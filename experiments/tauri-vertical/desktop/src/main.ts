import { listen } from '@tauri-apps/api/event';
import { appVersion } from './app-version';
import { mountSettings, settingsArgs, type AppSettings } from './settings-panel';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { NativeAttention } from './native-attention';
import { attachTerminalAttention } from './terminal-attention';
import { SessionAttention } from './attention';
import { RunnerAttentionSource, WindowAttentionSource, turnEnded, type AttentionSource } from './attention-source';
import { DockBadge, dockUnreadCount } from './dock-badge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mountCodexConversation } from './codex-conversation';
import './codex-conversation.css';
import { validateSequence } from './events';
import { TerminalStreamCursor, isLocalHistoryLimit, historyUsage, deferTerminalGap, terminalFramesPayload, terminalGapNotice, historyLabel, historyReasonLabel, type TerminalStream, type TerminalFrame, type TerminalGap, type TerminalHistory } from './terminal-stream';
import { mountTelemetry, formatTelemetryCpu, formatTelemetryBytes } from './telemetry';
import './telemetry.css';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { OrderedInput } from './input';
import { InteractivePoll } from './interactive-poll';
import { attachTerminalKeyboard } from './terminal-keyboard';
import { preserveTerminalViewport, syncTerminalViewport } from './terminal-viewport';
import { terminalTheme, terminalTypography } from './terminal-theme';
import { shell, icon } from './ui';
import { paneMarkup, paintPaneHeader } from './pane-header';
import { SessionPicker, sessionPickerOptions } from './session-picker';
import { AlertsPopover, alertRows, alertAnnouncement, unseenKeys, statusCounts, needsLabel, finishedLabel, workingLabel, quietLabel } from './alerts-popover';
import { renderSessionTabs, sessionTabs } from './top-bar';
import { mountPulsoPanel } from './pulso-panel';
import { programStateLabel, type ProgramState } from './program-status';
import type { ActivityKind } from './session-activity';
import { paintAgentIndicator, providerBadge, compactDuration, groupAgents, projectSessionIndex, readAgentGrouping, saveAgentGrouping, type AgentGrouping } from './agent-list';
import { SidebarProjects, projectProgressLabel } from './sidebar-projects';
import { statusLabel, providerLabel, matchesSession, type SessionFilter } from './workspace';
import { CommandPalette, type PaletteItem } from './command-palette';
import { appCommands, newSessionUnavailable, paletteEntries, type AppCommandContext, type Theme } from './app-commands';
import { createShortcutHandler, installShortcutListeners, isMacPlatform, shortcutAria, shortcutHint } from './shortcuts';

type Session = { agent?: unknown; programState?:ProgramState|null; programFinishedUnseen?:boolean; terminalStream?: TerminalStream; detail?: {terminalStream?: TerminalStream; [key:string]:unknown}; transport?:string; codex?:{generation:number;status:string;nativeThreadId:string|null}; id: string; title: string; kind: string; cwd: string | null; workspace?: string | null; status: string; pid?: number; rows: number; cols: number };
type RunnerStatus = { agentAttentionVersion?: number; agentAttention?: object; settings?: AppSettings; settingsVersion?: number; pulsoVersion?:number; pulsoBoardVersion?:number; pulsoAvailable?:boolean; pulsoRevision?: number; pulsoRevisionVersion?: number; pulsoSummaryVersion?: number; pulsoBoardCardsVersion?: number; nativeResumeVersion?:number; sessionRenameVersion?: number; terminalStreamVersion?: number; nativePermissionsVersion?: number; runnerVersion?: string; claudeNativeConfigVersion?: number; normalTerminalVersion?: number; pid: number; generation: string; statusVersion?:number; sessions: Session[]; lastSeq: number; retention?:{outputEncodedBytes:number;eventRows:number;outputRowLimit?:number;maxOutputEncodedBytes:number;atCapacity:boolean} };
type Event = { seq: number; sessionId: string; kind: string; data: string };
type View = { catchup?: boolean; catchupThrough?: number; archivedOnly?: boolean; stream?: TerminalStreamCursor; streamReplay?: boolean; liveReplayThrough?: number; liveReady?: boolean; session: Session; term: Terminal; fit: FitAddon; host: HTMLDivElement; sentSize: string; lastAttemptSize: string; resizeBusy: boolean; resizeAgain: boolean; input: OrderedInput; disposal: () => void; chat?:ReturnType<typeof mountCodexConversation> };
type Pane = { root: HTMLElement; host: HTMLElement; trigger: HTMLButtonElement; picker: SessionPicker; id: string | null };

// Resolve the supplied mono font before xterm measures its cell geometry.
const terminalFontsReady = document.fonts ? Promise.all([
  document.fonts.load('500 13px "JetBrains Mono"'),
  document.fonts.load('700 13px "JetBrains Mono"'),
]).catch(() => { /* The declared system monospace fallback remains usable. */ }) : Promise.resolve();

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = shell;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const views = new Map<string, View>();
const attention = new SessionAttention();
const dockBadge = new DockBadge(count => getCurrentWindow().setBadgeCount(count));
let attentionAt = 0;
let attentionReading = false;
const codexDrafts=new Map<string,unknown>();
const panes: Pane[] = [];
let connected = false;
let profileDataDir: string | null = null;
let connecting = false;
let smoke = false;
let renderedSeq = 0;
let runner: RunnerStatus | null = null;
let loopVersion = 0;
let activeLoop: Promise<void> = Promise.resolve();
const interactivePoll = new InteractivePoll();
const backgroundNative = new Map<string, Promise<void>>();
const lastBackgroundNative = new Map<string, number>();
const nativeApplying = new Map<string, Promise<{more:boolean;changed:boolean}>>();
const nativeForegroundEpoch = new Map<string, number>();
let backgroundNativeError: unknown;
let lastEvidence = 0;
const streamMetrics = {pages:0,lastPageMs:0,lastParseMs:0,lastTransferMs:0,lastYieldMs:0,maxParseMs:0,maxYieldMs:0,visibility:'unknown',pageBytes:0};
let statusAt = 0;
let archiveUnavailable = false;
let archivePollAt = 0;
let archiveHasMore = false;
let busyAction = false;
let disposed = false;
let selectedDirectory: string | null = null;
let stageView: 'terminal' | 'pulso' = 'terminal';
let pulsoPanel: ReturnType<typeof mountPulsoPanel> | null = null;
let palette: CommandPalette | null = null;
let pulsoShown = false;
const resumeAttempts = new Map<string,string>();
// Historical terminal queries (DSR/DA/colors) must not become fresh input.
let replaying = false;
let replayThrough = 0;
let split = false;
let focusedPane = 0;
let filter: SessionFilter = 'open';
// Agentes: Abiertas uses 'open' (Por proyecto) or 'activity' (Por estado).
let grouping: AgentGrouping = 'project';
let groupingProfile: string | null | undefined;
const openFilter = (): SessionFilter => grouping === 'state' ? 'activity' : 'open';
let query = '';
let searchOpen = false;
let sidebarKey = '';
let projectListKey = '';
let sessionSetKey = '';
const programSeen = new Map<string, string>();
// Pulso summary for the sidebar. Never a timer: see sidebar-projects.ts.
const sidebarProjects = new SidebarProjects((op, args) => requestPulso(op, args), () => runner?.pulsoSummaryVersion === 1);
function pulsoReadable() { return connected && !connecting && runner?.pulsoVersion === 1 && !!runner.pulsoAvailable; }
/** Runner 1.4 (pulsoRevisionVersion): the confirmed Pulso revision from status; null with older runners. */
function statusPulsoRevision(): number | null {
  return runner?.pulsoRevisionVersion === 1 && typeof runner.pulsoRevision === 'number' ? runner.pulsoRevision : null;
}
// Revision a sidebar read was started for, and the earliest retry after a failed one.
let sidebarAsked: number | null = null;
let sidebarRetryAt = 0;
/**
 * With the status revision every trigger (each status, focus, visibility,
 * session set, board changes) reads only when the summary is not at that
 * revision yet, and only while the window is visible: a hidden window keeps
 * the change pending and visibilitychange reads it. Older runners: every
 * trigger reads, as in 1.3.x.
 */
function loadSidebarProjects() {
  if (disposed || !pulsoReadable()) return;
  const revision = statusPulsoRevision();
  if (revision !== null) {
    if (revision === sidebarProjects.snapshot.revision || revision === sidebarAsked) return;
    if (document.visibilityState !== 'visible' || Date.now() < sidebarRetryAt) return;
    sidebarAsked = revision;
  }
  void sidebarProjects.load().then(changed => { if (changed && !disposed) refresh(); }).catch(() => {
    // Keep the last summary; the next trigger (or status, after 5 s) retries.
    if (revision !== null && sidebarAsked === revision) { sidebarAsked = null; sidebarRetryAt = Date.now() + 5000; }
  });
}
let currentActivity = new Map<string, { kind: ActivityKind; label: string }>();
let announcedAlerts = new Set<string>();
let stopTarget: string | null = null;
let stopGeneration:number|null=null;
const stopping = new Set<string>();
// One source feeds every surface: the runner's `agent` (1.4 E) or the 1.3 window-local model.
const windowAttention = new WindowAttentionSource(attention);
const runnerAttention = new RunnerAttentionSource(attention, { request: (op, args) => request(op, args), isAttended: id => isAttended(id), changed: () => { if (!disposed) refresh(); },
  canMark: id => { const view = views.get(id); return connected && !connecting && !replaying && !!view && !streamReplaying(view); },
  consumedFrame: id => { const stream = views.get(id)?.stream; return stream && stream.generation === runner?.generation ? stream.lastFrame : null; } });
let source: AttentionSource = windowAttention;
let programRefresh:ReturnType<typeof setTimeout>|undefined;
function scheduleProgramRefresh(){if(programRefresh!==undefined)return;programRefresh=setTimeout(()=>{programRefresh=undefined;if(connected&&!disposed)refresh();},100);}
function programLabel(id:string){const state=source.display(id);return state?programStateLabel(state):'';}
function attentionSessions(): Session[] { return source.sessions([...views.values()].map(v => v.session)); }
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const newDialog = $<HTMLDialogElement>('#new-session-dialog');
const alertsPopover = new AlertsPopover({ button: $<HTMLButtonElement>('#session-alerts'), panel: $('#attention-banner'), list: $('#attention-list'),
  onOpenSession: id => { if (views.has(id)) selectSession(id); }, onToggle: () => queueMicrotask(() => { if (!disposed) refresh(); }) });
const stopDialog = $<HTMLDialogElement>('#stop-session-dialog');
let dialogReturn: HTMLElement | null = null;
let newDialogVersion = 0;
const nativeAttention = new NativeAttention({
  granted: isPermissionGranted, request: requestPermission,
  send: kind => sendNotification({ title: kind === 'needs' ? 'Jauría · Necesita tu atención' : kind === 'finished' ? 'Jauría · Actividad finalizada' : 'Jauría · Aviso de sesión', body: 'Abre Jauría y consulta Actividad.' }),
}, id => connected && !replaying && !isAttended(id), value => {
  text('#native-notification-status', value);
  text('#enable-native-notifications', nativeAttention.enabled ? 'Desactivar avisos de macOS' : 'Activar avisos de macOS…');
});
function activeView() { return panes[focusedPane]?.id ? views.get(panes[focusedPane].id!) : undefined; }
function text(selector: string, value: string) { $(selector).textContent = value; }
function closeSidebar() { $('.workspace-shell').classList.remove('sidebar-open'); $('#sidebar-scrim').hidden = true; $('#toggle-sidebar').setAttribute('aria-expanded', 'false'); }
function setInspector(open: boolean) { $('#inspector').hidden = !open; $('#workspace-body').classList.toggle('has-inspector', open); $('#toggle-inspector').setAttribute('aria-pressed', String(open)); }
function openNew(cwd: string | null = null) {
  if (busyAction || newDialog.open) return;
  const version = ++newDialogVersion;
  selectedDirectory = cwd;
  text('#selected-directory', cwd ?? 'Cargando carpeta personal…'); $('#selected-directory').title = cwd ?? '';
  $<HTMLInputElement>('#session-title').value = '';
  $('#new-session-error').hidden = true;
  dialogReturn = document.activeElement as HTMLElement;
  closeSidebar(); newDialog.showModal(); refresh();
  if (cwd === null) void invoke<string>('home_directory').then(directory => {
    if (version !== newDialogVersion || !newDialog.open || selectedDirectory !== null) return;
    setSessionDirectory(directory);
  }).catch(e => {
    if (version !== newDialogVersion || !newDialog.open || selectedDirectory !== null) return;
    text('#selected-directory', 'Elegir carpeta…');
    text('#new-session-error', message(e)); $('#new-session-error').hidden = false;
  });
}
function setSessionDirectory(directory: string) {
  selectedDirectory = directory; text('#selected-directory', directory); $('#selected-directory').title = directory; $('#new-session-error').hidden = true; refresh();
}
function closeNew() { if (busyAction) return; newDialog.close(); dialogReturn?.focus(); }
function selectSession(id: string) {
  source.select(id, attentionSessions());
  stageView = 'terminal';
  const target = panes[focusedPane];
  const other = panes.find(p => p !== target && p.id === id);
  if (other && split) { focusedPane = panes.indexOf(other); }
  else if (other) { assign(other, null); assign(target, id); }
  else assign(target, id);
  closeSidebar(); refresh(); focusView(activeView());
}
function setSplit(value: boolean) {
  // Unifying detaches or moves the second pane's terminal: keep the keyboard on the remaining one.
  const hadPaneFocus = !value && $('#panes').contains(document.activeElement);
  split = value;
  if (!split && focusedPane === 1) {
    const id = panes[1].id; assign(panes[1], null); if (id) assign(panes[0], id); focusedPane = 0;
  }
  if (!split) assign(panes[1], null);
  if (split && !panes[1].id) {
    const candidate = [...views.keys()].find(id => id !== panes[0].id);
    if (candidate) assign(panes[1], candidate);
  }
  refresh();
  for (const p of panes) if (p.id) scheduleResize(views.get(p.id)!);
  if (hadPaneFocus && !panes[0].root.contains(document.activeElement)) { if (activeView()) focusView(activeView()); else panes[0].trigger.focus(); }
}

for (let i = 0; i < 2; i++) {
  const root = document.createElement('article');
  root.className = 'pane';
  root.setAttribute('aria-label', `Panel de sesión ${i + 1}`);
  root.innerHTML = paneMarkup(i);
  $('#panes').append(root);
  const trigger = root.querySelector<HTMLButtonElement>('.pane-session-button')!;
  // The picker floats inside the pane (absolute), above the terminal host; it never resizes it.
  const picker = new SessionPicker({
    trigger, container: root, before: root.querySelector('.terminal-host'), label: `Sesión del panel ${i + 1}`,
    options: () => sessionPickerOptions([...views.values()].map(view => view.session), i, panes.map(p => p.id), split),
    onSelect: id => { focusedPane = i; if (id) selectSession(id); else { assign(pane, null); refresh(); trigger.focus(); } },
    onClose: restore => { if (!restore) return; const view = pane.id ? views.get(pane.id) : undefined; if (view && focusedPane === i) focusView(view); else trigger.focus(); },
  });
  const pane: Pane = { root, host: root.querySelector('.terminal-host')!, trigger, picker, id: null };
  panes.push(pane);
  root.addEventListener('pointerdown', () => { const consumed = pane.id ? source.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  root.addEventListener('focusin', () => { const consumed = pane.id ? source.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    if (button.dataset.action === 'rename') {
      button.addEventListener('click', () => {
        root.querySelectorAll('details').forEach(d => d.open = false);
        if (pane.id) openRename(pane.id);
      });
      return;
    }
    button.addEventListener('click', () => action(async () => {
      const op = button.dataset.action!;
      root.querySelectorAll('details').forEach(d => d.open = false);
      if (op === 'shell') { requireSessionCapacity(); await start(`shell-${crypto.randomUUID()}`, 'shell', `Shell ${i + 1}`, pane); return; }
      const view = pane.id ? views.get(pane.id) : null;
      if (!view) throw new Error('Selecciona una sesión primero.');
      const label = button.dataset.label ?? button.textContent?.trim() ?? op;
      if (op === 'stop') { openStopConfirmation(view); return; }
      if (op === 'release') {
        const released = await invoke<boolean>('release_session', { id: view.session.id });
        updateStatus(await request<RunnerStatus>('status', {}));
        notice(released ? 'Carpeta liberada por confirmación explícita. El historial se conserva; no se señaló ningún proceso.' : 'Liberación cancelada.');
        return;
      }
      if (!isLive(view.session)) throw new Error('La sesión ya no está activa. Crea una sesión nueva para continuar.');
      if (op === 'ping' || op === 'size' || op === 'flood') {
        if (view.session.kind !== 'fixture') throw new Error('Este control solo está disponible para fixtures.');
        await view.input.enqueue(`${op}\n`);
      } else if (op === 'interrupt') {
        const version = loopVersion;
        await view.input.control(async () => {
          if (!connected || version !== loopVersion || !isLive(view.session)) throw new Error('La conexión o la sesión cambió; Ctrl-C no se reenvía.');
          await request('interrupt', { id: view.session.id });
        });
      }
      else await request(op, { id: view.session.id });
      notice(`${label} enviado a ${view.session.title}.`);
      focusView(view);
    }));
  });
  new ResizeObserver(() => { if (pane.id) scheduleResize(views.get(pane.id)!); }).observe(pane.host);
}
/** Terminar sesión always asks first (pane menu and command palette). */
function openStopConfirmation(view: View) {
  stopTarget = view.session.id;stopGeneration=view.session.transport==='app-server'?view.session.codex?.generation??null:null;
  text('#stop-session-description', `${view.session.title} · ${providerLabel(view.session.kind)} · ${view.session.cwd ?? 'Sin carpeta'}`);
  stopDialog.showModal(); $<HTMLButtonElement>('#cancel-stop').focus();
}
function streamMetadata(session: Session) { return session.terminalStream ?? session.detail?.terminalStream; }
function streamReplaying(view?: View) { return !!view && (!!view.streamReplay || !!view.catchup || (runner?.terminalStreamVersion === 1 && view.session.terminalStream?.generation === runner.generation && !view.liveReady)); }
function historySuffix(view: View) {
  return view.catchup ? 'Recuperando salida guardada…' : view.stream?.desynchronized ? terminalGapNotice : isLocalHistoryLimit(streamMetadata(view.session)?.history) ? '' : historyLabel(streamMetadata(view.session)?.history);
}
/** The notice is a floating toast over the workbench (absolute), never part of the terminal's layout. */
function syncMessageRail() {
  const notice = $('#notice');
  const view = activeView();
  const history = view && streamMetadata(view.session)?.history;
  const persistent = view?.catchup ? `${view.session.title}: Recuperando salida guardada…` : view?.stream?.desynchronized ? `${view.session.title}: ${terminalGapNotice}`
    : history && !isLocalHistoryLimit(history) && ['limited','error','incomplete','unknown_tail'].includes(history.state) ? `${view!.session.title}: ${historyLabel(history)}${history.reason ? ` · ${historyReasonLabel(history.reason)}` : ''}`
    : archiveUnavailable ? 'Historial sin confirmar; la salida en vivo continúa.' : '';
  if (notice.hidden || notice.dataset.persistent === 'true') {
    text('#notice-text', persistent); notice.hidden = !persistent;
    notice.dataset.persistent = 'true'; notice.classList.toggle('error', !!persistent);
  }
}
function notice(message: string, error = false) { $('#notice').dataset.persistent = 'false'; text('#notice-text', message); $('#notice').hidden = false; $('#notice').classList.toggle('error', error); syncMessageRail(); }
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
async function request<T = unknown>(op: string, args: object): Promise<T> {
  const response = await invoke<{ ok: boolean; result: T; error?: string }>('runner_request', { op, args });
  if (!response.ok) throw new Error(response.error ?? 'El runner rechazó la operación.');
  return response.result;
}
function isLive(session: Session) { return ['running', 'starting'].includes(session.status); }
/** Proyectos: Pulso boards from the read-only sidebar summary; rows open the board. */
function renderProjectList(planning: boolean) {
  const summary = sidebarProjects.snapshot;
  const disabled = !connected || runner?.pulsoBoardVersion !== 1 || !runner?.pulsoAvailable;
  const current = planning && pulsoPanel ? pulsoPanel.currentBoard() ?? '' : null;
  const key = JSON.stringify([disabled, current, summary.projects.map(p => [p.id, p.title, p.done, p.total]), summary.pendingOpen, summary.hasMore, summary.revision === null]);
  if (key === projectListKey) return;
  projectListKey = key;
  const list = $('#sidebar-project-list');
  // Rebuilding must not drop keyboard focus (e.g. Enter on a row that opens its board).
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-board],[data-more]') : null;
  const focusKey = focused?.dataset.board ?? (focused?.dataset.more !== undefined ? 'more' : null);
  list.replaceChildren();
  const row = (board: string, name: string, initial: string, meta: string, label: string) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sidebar-row project-row'; button.dataset.board = board;
    button.disabled = disabled; button.setAttribute('aria-current', String(current === board)); button.setAttribute('aria-label', label); button.title = label;
    const badge = document.createElement('span'); badge.className = 'project-initial'; badge.setAttribute('aria-hidden', 'true'); badge.textContent = initial;
    const text = document.createElement('span'); text.className = 'sidebar-row-name'; text.textContent = name;
    const progress = document.createElement('span'); progress.className = 'sidebar-row-meta'; progress.setAttribute('aria-hidden', 'true'); progress.textContent = meta;
    button.append(badge, text, progress); list.append(button);
  };
  for (const project of summary.projects) {
    const progress = projectProgressLabel(project);
    row(project.id, project.title, Array.from(project.title.trim())[0]?.toLocaleUpperCase() ?? '·', progress,
      `Abrir tablero ${project.title}${progress ? `, ${project.done} de ${project.total} hechas` : ''}`);
  }
  const pending = summary.pendingOpen === null ? '' : String(summary.pendingOpen);
  row('', 'Pendientes', '·', pending, `Abrir tablero Pendientes${pending ? `, ${pending} sin terminar` : ''}`);
  if (summary.hasMore) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'sidebar-row project-more'; more.dataset.more = '';
    more.disabled = disabled; more.textContent = 'Más proyectos…'; more.title = 'Abrir Pulso para ver todos los proyectos'; list.append(more);
  }
  else if (disabled) { const hint = document.createElement('p'); hint.className = 'sidebar-hint'; hint.textContent = connected ? 'Pulso necesita el runner actualizado.' : 'Pulso sin conexión.'; list.append(hint); }
  if (focusKey !== null) (focusKey === 'more' ? list.querySelector<HTMLElement>('[data-more]') : Array.from(list.querySelectorAll<HTMLElement>('[data-board]')).find(n => n.dataset.board === focusKey))?.focus({ preventScroll: true });
}
function refresh() {
  const planning = stageView === 'pulso';
  $('#pulso-panel-host').hidden = !planning;
  $('#open-pulso').setAttribute('aria-pressed', String(planning));
  $<HTMLButtonElement>('#open-pulso').disabled = !connected || runner?.pulsoBoardVersion !== 1 || !runner?.pulsoAvailable;
  $('#open-pulso').title = runner?.pulsoBoardVersion !== 1 ? 'El tablero necesita el runner actualizado; tus sesiones se conservan' : runner?.pulsoAvailable ? 'Planes y pendientes en este Mac' : 'Pulso no disponible; sus datos se conservan';
  if (planning !== pulsoShown) { pulsoShown = planning; if (planning) pulsoPanel?.show(); else { pulsoPanel?.hide(); loadSidebarProjects(); } }
  renderProjectList(planning);

  if (!connected) text('#telemetry-summary','Recursos sin conexión');
  else if ($('#telemetry-summary').textContent === 'Recursos sin conexión') text('#telemetry-summary','CPU — · RAM —');
  text('#connection-state', connecting ? 'Conectando…' : connected ? 'Conectado' : 'Sin conexión');
  $('#connection-dot').dataset.state = connected ? 'running' : 'failed';
  text('#runner-state', runner ? `${connected ? 'Runner activo' : 'Runner sin confirmar'}${runner.runnerVersion ? ` · v${runner.runnerVersion}` : ''} · PID ${runner.pid} · ${runner.sessions.length} sesiones` : 'Runner: sin consultar');
  const capabilities=runner as RunnerStatus & {telemetryVersion?:number;codexVersion?:number;terminalSessionVersion?:number};
  $('#runner-upgrade').hidden = !connected || (capabilities?.telemetryVersion === 1 && capabilities?.codexVersion===1 && capabilities?.terminalSessionVersion===1 && runner?.normalTerminalVersion===1 && runner?.claudeNativeConfigVersion===1 && runner?.terminalStreamVersion===1 && runner?.nativePermissionsVersion===1 && runner?.settingsVersion===2 && runner?.sessionRenameVersion===1);
  $<HTMLButtonElement>('#restart-runner').disabled = !connected || busyAction;
  text('#cursor', `Eventos procesados: ${renderedSeq}`);
  const retained=runner?.retention;
  const usage = historyUsage(retained);
  const level = usage >= .95 ? 95 : usage >= .8 ? 80 : 0;
  const historyWarnings = [...views.values()].filter(view => !isLocalHistoryLimit(streamMetadata(view.session)?.history) && ['limited','error','incomplete','unknown_tail'].includes(streamMetadata(view.session)?.history.state ?? '')).length;
  text('#storage-usage',retained?`Historial: ${formatTelemetryBytes(retained.outputEncodedBytes)} codificados · ${retained.eventRows} eventos${retained.atCapacity?' · límite de guardado local alcanzado':level ? ` · uso ${level}%` : ''}${historyWarnings ? ` · ${historyWarnings} con historial limitado o sin guardar` : ''}. La cuota no representa espacio físico en disco.`:'Cuota de historial sin consultar.');
  $<HTMLButtonElement>('#connect').disabled = connecting || busyAction;
  const sessions = attentionSessions();
  const attended = activeView()?.session.id;
  // Viewing consumes transient activity even when no new focus event occurs
  // (for example, the currently focused process exits). Persistent causes stay.
  if (attended && isAttended(attended)) source.consumeActivity(attended);
  source.paint(attended ? [attended] : []);
  const alerts = source.list(sessions);
  // Runner hasMore: sessions with pending alerts that status did not list.
  const hidden = source.hiddenUnseen();
  const unread = alerts.filter(item => item.unseen && !item.stale && !isAttended(item.id));
  dockBadge.setCount(connected && !replaying ? dockUnreadCount(unread) + hidden : 0);
  const alertById = new Map(alerts.map(item => [item.id, item]));
  const activityById = new Map(sessions.map(s => [s.id, source.activity(s, alertById.get(s.id))]));
  currentActivity = activityById;
  const unseen = unread.length + hidden, total = alerts.length + hidden;
  const matches = (s: Session, f: SessionFilter, q: string) => f === 'attention'
    ? alertById.has(s.id) && matchesSession(s, 'all', q)
    : f === 'activity' ? (isLive(s) || alertById.has(s.id)) && matchesSession(s, 'all', q)
    : matchesSession(s, f, q);
  const count = (f: SessionFilter) => sessions.filter(s => matches(s, f, '')).length;
  $('#session-alerts').hidden = total === 0;
  const alertButton = $('#session-alerts');
  alertButton.dataset.total = String(total); alertButton.dataset.unread = String(unseen);
  const alertLabel = `Avisos: ${total} sesiones requieren atención; ${unseen} nuevas`;
  alertButton.setAttribute('aria-label', alertLabel);
  text('#session-alerts-count', String(unseen)); $('#session-alerts-count').hidden = unseen === 0;
  $('#session-alerts').title = `${alertLabel}. ${total - unseen} ya vistas o atendidas.\n` + alerts.map(a => `${views.get(a.id)?.session.title}: ${a.reason}`).join('\n') + (hidden ? `\ny ${hidden} más sin listar` : '');
  // Same priority as the sidebar: action, notices, unseen finish, working, waiting, no report.
  const rows = alertRows(alerts, id => views.get(id)?.session.title, id => activityById.get(id));
  const firstAlert = rows[0];
  if (!total && alertsPopover.isOpen) alertsPopover.close(document.activeElement instanceof HTMLElement && $('#attention-banner').contains(document.activeElement));
  // The popover floats over the workbench; showing or hiding it never resizes a pane.
  $('#attention-banner').hidden = !alertsPopover.isOpen || !total;
  $('#attention-banner').dataset.open = String(alertsPopover.isOpen && !!total);
  alertsPopover.render(rows, hidden);
  text('#attention-summary', total ? `${total} ${total === 1 ? 'aviso' : 'avisos'}; ${unseen} sin ver.` : 'Sin avisos nuevos.');
  $('#open-attention-session').dataset.sessionId = firstAlert?.id ?? '';
  $('#open-attention-session').setAttribute('aria-label', firstAlert ? `Abrir sesión ${firstAlert.title}` : 'Abrir sesión');
  $('#see-attention').hidden = unseen === 0;
  // Polite announcement of new unseen alerts; the live region is visually hidden.
  const announcement = connected && !replaying ? alertAnnouncement(announcedAlerts, rows) : null;
  announcedAlerts = unseenKeys(rows);
  if (announcement) text('#attention-announcer', announcement);
  // Status bar: fixed 28 px, one line. Counters keep their slot when they change.
  const counts = statusCounts(sessions.map(s => activityById.get(s.id)?.kind ?? 'unreported'));
  $('#status-needs').hidden = counts.needs === 0; text('#status-needs-text', needsLabel(counts.needs));
  // The button opens the session that needs you most: the priority alert when it is one, else the first such session.
  const needsKind = (id: string) => ['needs', 'notice'].includes(activityById.get(id)?.kind ?? '');
  const needsTarget = firstAlert && needsKind(firstAlert.id) ? sessions.find(s => s.id === firstAlert.id) : sessions.find(s => needsKind(s.id));
  $('#status-needs').dataset.sessionId = needsTarget?.id ?? '';
  $('#status-needs').title = needsTarget ? `Abrir ${needsTarget.title} · ${activityById.get(needsTarget.id)?.label ?? ''}` : '';
  $('#status-finished').hidden = counts.finished === 0; text('#status-finished-text', finishedLabel(counts.finished));
  $('#status-working').hidden = counts.working === 0; text('#status-working-text', workingLabel(counts.working));
  const quiet = quietLabel(total, counts);
  $('#status-quiet').hidden = quiet === null; text('#status-quiet', quiet ?? '');
  syncMessageRail();
  nativeAttention.update(source.nativeItems(alerts));
  document.title = unseen ? `(${unseen}) Avisos · Jauría` : 'Jauría';
  const open = count('open');
  const occupied=sessions.filter(s=>!['exited','stopped','failed','interrupted','released'].includes(s.status)).length;
  if (filter === 'attention' && count('attention') === 0) filter = openFilter();
  text('#capacity', `${occupied} de ${sessionLimit()} plazas`);
  $('#capacity').title = `${occupied} de ${sessionLimit()} plazas ocupadas`;
  text('#open-count', String(open)); text('#closed-count', String(count('closed')));
  text('#attention-count', `${total} ${total === 1 ? 'aviso' : 'avisos'}`);
  $('#attention-filter').hidden = count('attention') === 0;
  const tab = filter === 'activity' ? 'open' : filter;
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === tab)));
  const groupingButton = $('#agent-grouping');
  if (groupingButton.dataset.grouping !== grouping) {
    groupingButton.dataset.grouping = grouping;
    groupingButton.setAttribute('aria-pressed', String(grouping === 'state'));
    groupingButton.title = grouping === 'state' ? 'Agrupados por estado. Pulsa para agrupar por proyecto.' : 'Agrupados por proyecto. Pulsa para agrupar por estado.';
    groupingButton.innerHTML = icon(grouping === 'state' ? 'rows' : 'folder');
  }
  // Sidebar Pulso summary: reread when Pulso becomes readable or the session set changes.
  const nextSessionSet = `${pulsoReadable()}|${runner?.generation ?? ''}|${sessions.map(s => s.id).join(',')}`;
  if (nextSessionSet !== sessionSetKey) { sessionSetKey = nextSessionSet; loadSidebarProjects(); }
  // Older runners: an agent that reports done/idle has often just written to
  // Pulso through MCP. With pulsoRevisionVersion the status revision says so.
  if (turnEnded(programSeen, sessions, source) && statusPulsoRevision() === null) loadSidebarProjects();
  for (const id of ['create-both', 'create-1', 'create-2']) $<HTMLButtonElement>(`#${id}`).disabled = !connected || busyAction || connecting || replaying || occupied + (id === 'create-both' ? 2 : 1) > sessionLimit();
  $('#fixtures').hidden = !smoke;
  const newSessionBlocked = newSessionUnavailable({ connected, busy: busyAction, replaying, occupied, limit: sessionLimit() }) !== null;
  for (const id of ['new-session', 'welcome-create', 'tab-new-session']) $<HTMLButtonElement>(`#${id}`).disabled = newSessionBlocked;
  for (const id of ['choose-directory', 'use-home-directory']) $<HTMLButtonElement>(`#${id}`).disabled = busyAction || connecting;
  const terminalSupported = runner?.normalTerminalVersion === 1;
  $<HTMLInputElement>('input[name=provider][value=terminal]').disabled = !terminalSupported || busyAction;
  text('#new-terminal-status', connecting ? 'Conectando…' : !connected ? 'Sin conexión' : terminalSupported ? 'Shell zsh' : 'Requiere reiniciar runner');
  $<HTMLButtonElement>('#start-session').disabled = !selectedDirectory || !connected || connecting || busyAction || replaying || occupied >= sessionLimit() || (!document.querySelector<HTMLInputElement>('input[name=provider]:checked') || ($<HTMLInputElement>('input[name=provider]:checked').value === 'terminal' && !terminalSupported));
  for (const id of ['cancel-session', 'cancel-session-x']) $<HTMLButtonElement>(`#${id}`).disabled = busyAction;
  for (const pane of panes) {
    const index = panes.indexOf(pane);
    const view = pane.id ? views.get(pane.id) : null;
    pane.root.hidden = pane === panes[1] && !split;
    pane.root.classList.toggle('is-focused', index === focusedPane);
    pane.trigger.dataset.sessionId = pane.id ?? '';
    const activity = view && (isLive(view.session) || alertById.has(view.session.id)) ? activityById.get(view.session.id) : undefined;
    paintPaneHeader(pane.root, {
      paneIndex: index, kind: view?.session.kind ?? null, title: view?.session.title ?? null, cwd: view?.session.cwd ?? null,
      state: view ? (stopping.has(view.session.id) && isLive(view.session) ? 'Terminando…' : isLive(view.session) && programLabel(view.session.id) ? programLabel(view.session.id) : statusLabel(view.session.status)) + (historySuffix(view) ? ` · ${historySuffix(view)}` : '') : 'Sin sesión',
      stateKey: view && isLive(view.session) ? source.display(view.session.id) ?? 'unreported' : view?.session.status ?? '',
      activity: activity?.kind ?? null, activityLabel: activity?.label ?? '',
      history: !view || isLive(view.session) ? '' : ['exited', 'stopped', 'released'].includes(view.session.status) ? 'Historial · solo lectura' : `${statusLabel(view.session.status)} · entrada deshabilitada`,
    });
    pane.picker.refresh();
    (pane.root.querySelector('.fixture-controls') as HTMLElement).hidden = !smoke;
    if (view) view.term.options.disableStdin = view.session.transport==='app-server' || replaying || streamReplaying(view) || !connected || !isLive(view.session) || stopping.has(view.session.id);
    pane.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const kind = button.dataset.action!;
      if(view?.session.transport==='app-server' && kind==='interrupt'){button.hidden=true;return;}
      if(kind==='interrupt')button.hidden=false;
      if (kind === 'rename') {
        button.hidden = runner?.sessionRenameVersion !== 1;
        button.disabled = !view || !connected || connecting || busyAction || replaying; return;
      }
      if (kind === 'release') {
        button.hidden = view?.session.status !== 'needs_attention';
        button.disabled = !connected || connecting || busyAction || replaying; return;
      }
      button.disabled = !connected || connecting || busyAction || replaying || (kind === 'shell' && occupied >= sessionLimit()) || (kind !== 'shell' && (!view || !isLive(view.session) || stopping.has(view.session.id))) || (['ping', 'size', 'flood'].includes(kind) && view?.session.kind !== 'fixture');
    });
  }
  const focusedView = activeView();
  text('#terminal-size', focusedView?.session.transport === 'app-server' ? 'Conversación' : focusedView ? `${focusedView.term.cols} × ${focusedView.term.rows}` : '—');
  for(const view of views.values())view.chat?.select(connected && !replaying && stageView==='terminal' && panes.some((pane,index)=>pane.id===view.session.id && (index===0||split))?view.session:null);
  const hasVisibleSession = panes.some((pane, index) => !!pane.id && (index === 0 || split));
  $('#welcome').hidden = hasVisibleSession || stageView !== 'terminal';
  $('#panes').hidden = !hasVisibleSession || stageView !== 'terminal';
  $('#panes').dataset.split = String(split);
  $('#toggle-split').setAttribute('aria-pressed', String(split));
  $('#toggle-split').hidden = planning;
  $<HTMLButtonElement>('#toggle-split').disabled = sessions.length < 2 || planning;
  const current = activeView()?.session;
  // Top bar: session tabs in terminal views, Pulso board tabs while planning.
  $('#session-tabs').hidden = planning; $('#tab-new-session').hidden = planning; $('#pulso-tabs-host').hidden = !planning; $('#pulso-back-terminal').hidden = !planning;
  $('.workbench-header').dataset.view = planning ? 'pulso' : 'terminal';
  if (!planning) renderSessionTabs($('#session-tabs'), sessionTabs(sessions, panes.map((pane, index) => index === 0 || split ? pane.id : null), stageView === 'terminal' ? current?.id : null, id => activityById.get(id)), selectSession);
  text('#workspace-title', current?.title ?? 'Tu espacio de trabajo');
  text('#workspace-breadcrumb', current?.cwd?.split('/').filter(Boolean).pop() ?? (current ? providerLabel(current.kind) : 'Sesiones locales'));
  text('#inspector-provider', current ? providerLabel(current.kind) : '');
  text('#inspector-title', current?.title ?? 'Sin sesión seleccionada');
  text('#inspector-description', current ? 'El estado indica la disponibilidad del proceso; los permisos y las respuestas aparecen en la terminal.' : 'Selecciona una sesión para ver su carpeta y su estado.');
  $('#purge-history').hidden = !current || !['exited','stopped','failed','interrupted','released'].includes(current.status);
  $('#compact-history').hidden=$('#purge-history').hidden;
  const selectedHistory = current ? streamMetadata(current)?.history : undefined;
  const localHistory = $('#session-local-history');
  localHistory.hidden = !isLocalHistoryLimit(selectedHistory);
  localHistory.textContent = isLocalHistoryLimit(selectedHistory)
    ? `Historial local parcial. ${current && isLive(current) ? 'La sesión continúa normalmente. Se alcanzó el límite de guardado local; la salida nueva no se añade al historial de Jauría.' : 'Este límite solo afecta a la salida guardada por Jauría.'} No limita el uso ni afecta la cuota del proveedor.` : '';
  text('#inspector-state', current ? statusLabel(current.status) : '—');
  text('#inspector-cwd', current?.cwd ?? '—'); text('#inspector-id', current?.id ?? '—');
  $<HTMLButtonElement>('#copy-session-id').disabled = !current;
  $<HTMLButtonElement>('#new-in-folder').disabled = !current?.cwd || !connected || busyAction || occupied >= sessionLimit() || replaying;
  $('#workspace-breadcrumb').hidden = planning;
  if (planning) text('#workspace-title', 'Pulso');
  const visibleSessions = sessions.filter(s => matches(s, filter, query));
  const navigation = $('.workspace-navigation');
  navigation.dataset.sessionView = filter === 'activity' || filter === 'attention' ? 'priority' : 'projects';
  navigation.dataset.filter = filter;
  const kindOf = (id: string) => activityById.get(id)?.kind ?? 'unreported';
  const summary = sidebarProjects.snapshot;
  // Attention and Por estado reuse the activity sections; Abiertas/Historial
  // Por proyecto use the Pulso main session and project links known locally.
  const groups = filter === 'activity' || filter === 'attention'
    ? groupAgents(visibleSessions, 'state', kindOf)
    : groupAgents(visibleSessions, grouping, kindOf, summary.projects, projectSessionIndex(summary.projects, summary.links));
  $('#session-list').setAttribute('aria-label', filter === 'attention' ? 'Sesiones con avisos' : filter === 'activity' ? 'Agentes por estado' : filter === 'closed' ? (grouping === 'state' ? 'Historial por estado' : 'Historial por proyecto') : 'Agentes por proyecto');
  // Keep the button itself mounted while status, output metadata or attention
  // changes. Replacing it between pointer down and up loses the user's click.
  const key = JSON.stringify([filter, query, summary.linksTruncated, groups.map(group => [group.key, group.name, group.sessions.map(s => s.id)])]);
  if (sidebarKey !== key) {
    sidebarKey = key;
    const list = $('#session-list');
    const focusedSession = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('.session-item')?.dataset.sessionId ?? null : null;
    list.replaceChildren();
    for (const group of groups) {
      const section = document.createElement('section'); section.className = 'session-group';
      if (group.kind) section.dataset.activity = group.kind; else section.dataset.project = group.projectId ?? 'none';
      const heading = document.createElement('div'); heading.className = 'group-heading';
      if (group.kind) { const marker = document.createElement('span'); marker.className = 'activity-group-marker'; marker.dataset.activity = group.kind; marker.setAttribute('aria-hidden', 'true'); heading.append(marker); }
      const name = document.createElement('span'); name.textContent = group.name; heading.append(name);
      heading.title = group.projectId === null && !group.kind && summary.linksTruncated ? `${group.name} · Pulso devolvió los vínculos incompletos: puede haber sesiones vinculadas aquí.` : group.name;
      const count = document.createElement('span'); count.className = 'activity-group-count'; count.textContent = String(group.sessions.length); heading.append(count);
      section.setAttribute('aria-label', `${group.name}: ${group.sessions.length}`);
      section.append(heading);
      for (const s of group.sessions) {
        const button = document.createElement('button'); button.className = 'session-item'; button.dataset.sessionId = s.id;
        // One visual line. State text stays in the DOM for assistive technology;
        // the indicator shape and its title carry it visually.
        button.innerHTML = `<span class="provider-badge" aria-hidden="true"></span><span class="session-item-title"></span><span class="session-item-duration"></span><span class="session-item-state"><span class="agent-indicator" aria-hidden="true"></span><span class="session-item-state-label sr-only"></span></span><span class="session-item-meta sr-only"></span>`;
        button.addEventListener('click', () => selectSession(s.id)); section.append(button);
      }
      list.append(section);
    }
    if (!list.children.length) {
      const empty = document.createElement('p'); empty.className = 'list-empty';
      empty.textContent = query ? 'No hay sesiones que coincidan.' : filter === 'closed' ? 'Las sesiones cerradas aparecerán aquí.' : filter === 'attention' ? 'Sin avisos. Los agentes sin OSC 7501 no informan su progreso.' : filter === 'activity' ? 'Abre una sesión para ver su actividad. El progreso aparece cuando el agente lo informa.' : 'Inicia una sesión para verla aquí.'; list.append(empty);
    }
    if (focusedSession) Array.from(list.querySelectorAll<HTMLElement>('.session-item')).find(n => n.dataset.sessionId === focusedSession)?.focus({ preventScroll: true });
  }
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#session-list .session-item'))) {
    const s = sessionById.get(button.dataset.sessionId!)!;
    const alert = alertById.get(s.id);
    const activity = activityById.get(s.id)!;
    const selected = stageView === 'terminal' && s.id === current?.id;
    button.dataset.selected = String(selected);
    button.setAttribute('aria-current', String(selected));
    button.dataset.attention = String(!!alert); button.dataset.unseen = String(!!alert?.unseen);
    button.dataset.activity = activity.kind;
    const badge = button.querySelector<HTMLElement>('.provider-badge')!;
    const provider = providerBadge(s.kind);
    if (badge.dataset.provider !== provider.provider) { badge.dataset.provider = provider.provider; badge.textContent = provider.letter; }
    paintAgentIndicator(button.querySelector<HTMLElement>('.agent-indicator')!, activity.kind, activity.label);
    const title = button.querySelector('.session-item-title')!;
    if (title.textContent !== s.title) title.textContent = s.title;
    const duration = isLive(s) ? compactDuration(source.since(s.id)) : '';
    const time = button.querySelector('.session-item-duration')!;
    if (time.textContent !== duration) time.textContent = duration;
    const state = button.querySelector('.session-item-state-label')!;
    if (state.textContent !== activity.label) state.textContent = activity.label;
    const meta = `${providerLabel(s.kind)} · ${alert ? `${alert.unseen ? 'Sin ver · ' : 'Visto · '}${alert.reason}` : activity.detail}`;
    const description = button.querySelector('.session-item-meta')!;
    if (description.textContent !== meta) description.textContent = meta;
    const tooltip = `${s.title} · ${activity.label} · ${s.cwd ?? providerLabel(s.kind)}${alert ? ` · ${alert.reason}` : ''}`;
    if (button.title !== tooltip) button.title = tooltip;
  }
  if (planning) pulsoPanel?.syncLive();
  palette?.refresh();
}
function assign(pane: Pane, id: string | null) {
  if (pane.id === id) return;
  // One terminal host may belong to exactly one pane.
  if (id) for (const other of panes) if (other !== pane && other.id === id) assign(other, null);
  if (pane.id) views.get(pane.id)?.host.remove();
  pane.id = id;
  const empty = pane.host.querySelector<HTMLElement>('.empty'); if (empty) empty.hidden = !!id;
  if (id) { const view = views.get(id)!; pane.host.append(view.host); syncTerminalViewport(view.term); scheduleResize(view); }
}
function focusView(view:View|undefined|null){if(!view)return;if(view.session.transport==='app-server')view.host.querySelector<HTMLTextAreaElement>('textarea')?.focus();else view.term.focus();}
function configureConversation(view:View){
  view.host.dataset.transport=view.session.transport??'pty';
  if(view.session.transport!=='app-server' || view.chat)return;
  const inputVersion=loopVersion;
  const guarded=async<T>(op:string,args:Record<string,unknown>):Promise<T>=>{
    if(!connected || inputVersion!==loopVersion || replaying)throw new Error('La conexión cambió o está recuperando historial. No se reenvía el mensaje.');
    const result=await request<T>(op,args);
    if(inputVersion!==loopVersion)throw new Error('Entrega sin confirmar tras reconexión; consulta el mismo envío.');
    return result;
  };
  const chatHost=document.createElement('div');chatHost.className='codex-host';view.host.append(chatHost);
  view.chat=mountCodexConversation(chatHost,guarded,async<T>(op:string,args:Record<string,unknown>):Promise<T>=>{
    if(op!=='codex_permission' || !connected || inputVersion!==loopVersion || replaying)throw new Error('La conexión cambió; el permiso no se reenvía.');
    const response=await invoke<{ok:boolean;result:T;error?:string}>('confirm_codex_permission',{args});
    if(!response.ok)throw new Error(response.error??'No se pudo responder al permiso.');return response.result;
  });
  if(codexDrafts.has(view.session.id))view.chat.restoreDraft(view.session.id,codexDrafts.get(view.session.id));
}
function ensure(session: Session): View {
  const current = views.get(session.id);
  if (current?.archivedOnly) {
    session = {...session, detail:{...session.detail, terminalStream:session.detail?.terminalStream ?? session.terminalStream ?? streamMetadata(current.session)}};
    delete session.terminalStream;
  }
  if (current) { const metadata = streamMetadata(session); if (current.stream && metadata && current.stream.generation !== metadata.generation) throw new Error('Terminal generation changed'); if (current.session.status !== session.status) current.lastAttemptSize = ''; current.session = session; configureConversation(current); return current; }
  const host = document.createElement('div'); host.className = 'terminal-view';
  // Open in a real document element, including sessions not selected in a pane.
  host.style.visibility = 'hidden'; host.style.position = 'absolute'; host.style.width = '550px'; host.style.height = '340px';
  document.body.append(host);
  const term = new Terminal({ allowProposedApi: true, screenReaderMode: false, convertEol: false, scrollback: 8000, rows: session.rows || 24, cols: session.cols || 80, fontSize: 13, ...terminalTypography, cursorBlink: true, theme: terminalTheme });
  const fit = new FitAddon(); term.loadAddon(fit); if(session.transport!=='app-server')term.open(host);
  const keyboard = attachTerminalKeyboard(term);
  host.remove(); host.removeAttribute('style');
  term.attachCustomKeyEventHandler(event => !handleAppShortcut(event));
  const inputVersion = loopVersion;
  const input = new OrderedInput(async data => {
    if (stopping.has(session.id) || !isLive(views.get(session.id)!.session)) throw new Error('La sesión ya no está activa.');
    if (!connected || replaying || streamReplaying(views.get(session.id)) || inputVersion !== loopVersion) throw new Error('La conexión cambió; no se reenvía la entrada.');
    await request('input', { id: session.id, data });
  }, e => notice(`${message(e)} Entrada suspendida; reconecta antes de continuar.`, true));
  const subscription = term.onData(data => {
    if (!replaying && !streamReplaying(views.get(session.id)) && connected && !stopping.has(session.id) && isLive(views.get(session.id)!.session)) {
      try { interactivePoll.activity(); void input.enqueue(data).catch(e => notice(message(e), true)); }
      catch (e) { notice(message(e), true); }
    }
  });
  // With a runner that reports agent attention, the source ignores these (no duplicate alerts).
  const signal = () => { if (!replaying && !streamReplaying(views.get(session.id)) && connected && inputVersion === loopVersion && !isAttended(session.id)) source.signal(session.id); };
  const terminalAttention = attachTerminalAttention(term, signal);
  const programReport=term.parser.registerOscHandler(7501,data=>{
    if(replaying||streamReplaying(views.get(session.id))||!connected||inputVersion!==loopVersion||!isLive(views.get(session.id)?.session??session))return true;
    if(source.program(session.id,data,isAttended(session.id)))scheduleProgramRefresh();return true;
  });
  const view:View = { session, term, fit, host, input, sentSize: `${session.cols}x${session.rows}`, lastAttemptSize: '', resizeBusy: false, resizeAgain: false, disposal: () => { subscription.dispose(); keyboard.dispose(); terminalAttention.dispose();programReport.dispose();windowAttention.forget(session.id); } };
  term.options.disableStdin = replaying;
  views.set(session.id, view);configureConversation(view);
  return view;
}
function updateStatus(status: RunnerStatus) {
  if (runner && runner.generation !== status.generation) throw new Error('El runner cambió de generación. Pulsa Conectar / Reintentar para reconstruir desde cero.');
  runner = status;
  if ((source = status.agentAttentionVersion === 1 ? runnerAttention : windowAttention) === runnerAttention) runnerAttention.ingestStatus(status);
  for (const session of status.sessions) { const metadata = streamMetadata(session); const existing = views.get(session.id); if (existing?.stream && metadata && existing.stream.generation !== metadata.generation) throw new Error('Terminal generation changed'); const previous = views.get(session.id)?.session.status; if (!replaying && !streamReplaying(existing) && previous && session.transport !== 'app-server') source.observeEnd(session.id, previous, session.status); ensure(session);if(!isLive(session)){stopping.delete(session.id);windowAttention.forget(session.id);}}
  refresh();
  // Runner 1.4: Pulso changes arrive as a revision in status (sidebar and board).
  if (statusPulsoRevision() !== null) loadSidebarProjects();
  pulsoPanel?.statusChanged(statusPulsoRevision());
}
function scheduleResize(view: View) {
  if (!view || view.session.transport==='app-server' || resizeTimers.has(view.session.id)) return;
  resizeTimers.set(view.session.id, setTimeout(() => { resizeTimers.delete(view.session.id); resizeView(view); }, 80));
}
function resizeView(view: View) {
  if (!view || stageView !== 'terminal' || replaying || streamReplaying(view) || (streamMetadata(view.session) && !isLive(view.session)) || !connected || !view.host.isConnected || view.host.clientWidth < 20 || view.host.clientHeight < 20) return;
  if (view.resizeBusy) { view.resizeAgain = true; return; }
  const dimensions = view.fit.proposeDimensions();
  if (dimensions && (dimensions.cols !== view.term.cols || dimensions.rows !== view.term.rows)) {
    preserveTerminalViewport(view.term, () => view.fit.fit());
  }
  if (!isLive(view.session) || stopping.has(view.session.id)) return;
  const size = `${view.term.cols}x${view.term.rows}`;
  if (size === view.sentSize || size === view.lastAttemptSize || !['running', 'starting'].includes(view.session.status)) return;
  view.resizeBusy = true;
  view.lastAttemptSize = size;
  void request<{ cols: number; rows: number }>('resize', { id: view.session.id, rows: view.term.rows, cols: view.term.cols }).then(actual => { view.sentSize = `${actual.cols}x${actual.rows}`; }).catch(e => { view.lastAttemptSize = ''; notice(`No se pudo ajustar ${view.session.title}: ${message(e)}`, true); }).finally(() => {
    view.resizeBusy = false;
    refresh();
    if (view.resizeAgain) { view.resizeAgain = false; scheduleResize(view); }
  });
}
async function action(work: () => Promise<void>) {
  if (busyAction) return;
  busyAction = true; refresh();
  try { await work(); } catch (e) { notice(message(e), true); } finally { busyAction = false; refresh(); }
}
function occupiedSessions() { return [...views.values()].filter(v => !['exited','stopped','failed','interrupted','released'].includes(v.session.status)).length; }
function sessionLimit() { return runner?.settingsVersion === 1 || runner?.settingsVersion === 2 ? runner.settings?.maxConcurrentSessions ?? 2 : 2; }
function requireSessionCapacity() {
  if (occupiedSessions() >= sessionLimit()) throw new Error(`Se alcanzó el límite de ${sessionLimit()} sesiones simultáneas. Ajústalo en Configuración o termina una sesión.`);
}
async function start(id: string, kind: string, title: string, pane: Pane, cwd?: string) {
  requireSessionCapacity();
  const session = await request<Session>('start', { id, kind, title, rows: 24, cols: 80, ...(cwd ? { cwd } : {}) });
  presentSession(session, pane);
  notice(`${title}: inicio solicitado. Esperando salida y estado reales.`);
}
function presentSession(session: Session, pane: Pane) {
  stageView = 'terminal';
  const id = session.id;
  const view = ensure(session);
  const other = panes.find(p => p !== pane && p.id === id);
  if (other) assign(other, null);
  assign(pane, id); focusedPane = panes.indexOf(pane);
  if (focusedPane === 1) split = true;
  filter = openFilter(); refresh(); scheduleResize(view); focusView(view);
}
function lines(view: View) {
  const buffer = view.term.buffer.active;
  const output: string[] = [];
  // Keep meaningful trailing output, omitting unused viewport rows.
  let end = buffer.length - 1;
  while (end >= 0 && !buffer.getLine(end)?.translateToString(true)) end--;
  for (let i = Math.max(0, end - 11); i <= end; i++) output.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return output;
}
async function evidence(force = false) {
  if (!smoke || (!force && Date.now() - lastEvidence < 500)) return;
  lastEvidence = Date.now();
  await invoke('record_ui_evidence', { payload: { ready: true, streamMetrics:smoke?streamMetrics:undefined, renderedSeq, connection: connected ? 'connected' : 'disconnected', runnerPid: runner?.pid, generation: runner?.generation, sessions: [...views].map(([id, view]) => ({ id, rows: view.term.rows, cols: view.term.cols, status: view.session.status, lastLines: lines(view) })) } });
}
type TerminalArchivedOnly = { archivedOnly: true; sessionId: string; generation: string; agent?: unknown };
type TerminalLive = { archivedOnly?: false; generation: string; frames: TerminalFrame[]; gap: TerminalGap | null; firstFrame: number; lastFrame: number; durableFrame: number; hasMore: boolean; session: Session; history: TerminalHistory; agent?: unknown };
async function consumeNative(view: View, generation: string, frames: TerminalFrame[], historical: boolean, gap: TerminalGap | null = null) {
  const metadata = streamMetadata(view.session);
  if (metadata && metadata.generation !== generation) throw new Error('Terminal generation changed');
  view.stream ??= new TerminalStreamCursor(generation);
  view.streamReplay = historical;
  try {
    await view.stream.consume(generation, frames, {
      gap: async () => {
        view.term.reset();
        // Reset ANSI parser/modes as well as the visible buffer. No provider input.
        $('#notice').hidden = true; $('#notice').dataset.persistent = 'true';
      },
      frame: async frame => {
        if (frame.kind === 'output') {
          const bytes = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0));
          await new Promise<void>(resolve => view.term.write(bytes, resolve));
          if (!historical) interactivePoll.output();
        } else if (frame.kind === 'resize') {
          if (view.term.cols !== frame.data.cols || view.term.rows !== frame.data.rows) {
            preserveTerminalViewport(view.term, () => view.term.resize(frame.data.cols, frame.data.rows));
          }
        } else if (!historical) {
          source.observeEnd(view.session.id, view.session.status, frame.data.status);
          view.session.status = frame.data.status;
        }
      },
    }, gap);
  } finally { view.streamReplay = false; }
  if (view.catchup && view.stream.lastFrame >= view.catchupThrough!) {
    view.catchup = false; view.catchupThrough = undefined;
    refresh();
  }
}
async function pollNativeView(view: View, version: number, stale = () => false): Promise<{more:boolean;changed:boolean}> {
  const metadata = view.session.terminalStream;
  // Only status-owned current runtime sessions have an in-memory live ring.
  if (view.archivedOnly || !metadata || metadata.generation !== runner?.generation || view.session.transport === 'app-server') return {more:false,changed:false};
  const after = view.stream?.lastFrame ?? 0;
  const page = await request<TerminalLive | TerminalArchivedOnly>('terminal_live', { id:view.session.id, after, limit:64 });
  if (version !== loopVersion || disposed || !connected || stale()) return {more:false,changed:false};
  // Two requests may overlap when a stalled background session gains focus.
  // Only one response at a time may enter its xterm parser.
  const previous = nativeApplying.get(view.session.id);
  if (previous) await previous;
  if (version !== loopVersion || disposed || !connected || stale()) return {more:false,changed:false};
  const apply = async (): Promise<{more:boolean;changed:boolean}> => {
    if (page.generation !== metadata.generation) throw new Error('Terminal generation changed');
    if (page.archivedOnly === true) {
      if (page.sessionId !== view.session.id) throw new Error('Invalid archived terminal session');
      view.archivedOnly = true; view.liveReady = true;
      if (source === runnerAttention) runnerAttention.live(view.session.id, page, false, 0);
      ensure(view.session);
      if (runner) runner.sessions = runner.sessions.map(s => s.id === view.session.id ? view.session : s);
      return {more:false,changed:true};
    }
    if (page.session.id !== view.session.id ||
        (page.session.terminalStream && page.session.terminalStream.generation !== page.generation)) throw new Error('Terminal generation changed');
    if (![page.firstFrame, page.lastFrame, page.durableFrame].every(n => Number.isSafeInteger(n) && n >= 0) ||
        page.firstFrame < 1 || page.firstFrame > page.lastFrame + 1 || page.durableFrame > page.lastFrame ||
        typeof page.hasMore !== 'boolean' || !page.history ||
        page.frames.some(frame => frame.index > page.lastFrame) || (page.hasMore && page.frames.length === 0)) throw new Error('Invalid terminal snapshot');
    // PTY ids never restart. A late background snapshot cannot reopen a
    // session already marked closed by a newer status response.
    const session = !isLive(view.session) && isLive(page.session)
      ? {...page.session, status:view.session.status} : page.session;
    if (deferTerminalGap(after, page.gap, page.durableFrame, page.history, !archiveUnavailable)) {
      if (!view.catchup) { $('#notice').hidden = true; $('#notice').dataset.persistent = 'true'; }
      view.catchup = true;
      view.catchupThrough = page.gap!.lastFrame;
      ensure({...session, terminalStream:{generation:page.generation, history:page.history}});
      if (runner) runner.sessions = runner.sessions.map(s => s.id === view.session.id ? view.session : s);
      return {more:false,changed:true};
    }
    const wasReady = view.liveReady;
    const previousStatus = view.session.status;
    const previousHistory = JSON.stringify(metadata.history);
    if (!view.liveReady && view.liveReplayThrough === undefined) view.liveReplayThrough = page.lastFrame;
    const historical = !view.liveReady;
    const replayFrames = historical ? page.frames.filter(frame => frame.index <= view.liveReplayThrough!) : [];
    const liveFrames = historical ? page.frames.filter(frame => frame.index > view.liveReplayThrough!) : page.frames;
    if (historical) {
      await consumeNative(view, page.generation, replayFrames, true, page.gap);
      if ((view.stream?.lastFrame ?? 0) >= view.liveReplayThrough!) view.liveReady = true;
    }
    if (liveFrames.length || !historical) await consumeNative(view, page.generation, liveFrames, false, historical ? null : page.gap);
    if (version !== loopVersion) return {more:false,changed:false};
    if (!historical) source.observeEnd(view.session.id, view.session.status, session.status);
    // terminal_live carries the session's agent; an attended frame alert that became consumable repaints (and may mark seen).
    const agentChanged = source === runnerAttention && runnerAttention.live(view.session.id, page, isAttended(view.session.id), view.stream?.lastFrame ?? 0);
    ensure({ ...session, terminalStream:{ generation:page.generation, history:page.history } });
    if ((view.stream?.lastFrame ?? 0) >= (view.liveReplayThrough ?? 0)) view.liveReady = true;
    if (runner) runner.sessions = runner.sessions.map(s => s.id === view.session.id ? view.session : s);
    if (!isLive(view.session)) stopping.delete(view.session.id);
    const changed = agentChanged || wasReady !== view.liveReady || previousStatus !== view.session.status || previousHistory !== JSON.stringify(page.history) ||
      !!page.gap || page.frames.some(frame => frame.index > after && frame.kind !== 'output');
    if (!wasReady && view.liveReady) scheduleResize(view);
    return {more:page.hasMore,changed};
  };
  const applying = apply();
  nativeApplying.set(view.session.id, applying);
  try { return await applying; }
  finally { if (nativeApplying.get(view.session.id) === applying) nativeApplying.delete(view.session.id); }
}
async function pollNative(version: number): Promise<boolean> {
  let more = false;
  const focused = activeView()?.session.id;
  const foreground = focused ? views.get(focused) : undefined;
  if (foreground) {
    nativeForegroundEpoch.set(foreground.session.id, (nativeForegroundEpoch.get(foreground.session.id) ?? 0) + 1);
    const result = await pollNativeView(foreground, version);
    if (result.changed) refresh();
    more = result.more;
  }
  if (version !== loopVersion || disposed) return false;
  for (const view of views.values()) {
    const id = view.session.id;
    if (id === focused || backgroundNative.has(id)) continue;
    const visible = panes.some((pane, index) => pane.id === id && (index === 0 || split));
    const minimumInterval = visible ? 50 : 150;
    const now = performance.now();
    if (now - (lastBackgroundNative.get(id) ?? -Infinity) < minimumInterval) continue;
    lastBackgroundNative.set(id, now);
    const epoch = nativeForegroundEpoch.get(id) ?? 0;
    const stale = () => activeView()?.session.id === id || (nativeForegroundEpoch.get(id) ?? 0) !== epoch;
    const flight = pollNativeView(view, version, stale).then(result => {
      if (version !== loopVersion || disposed || !connected || stale()) return;
      if (result.changed) refresh();
      if (result.more) { lastBackgroundNative.delete(id); interactivePoll.wakeUp(); }
    }).catch(error => { if (version === loopVersion) { backgroundNativeError = error; interactivePoll.wakeUp(); } });
    backgroundNative.set(id, flight);
    void flight.finally(() => { if (backgroundNative.get(id) === flight) backgroundNative.delete(id); });
  }
  return more;
}
async function poll(version: number) {
  try {
    while (connected && version === loopVersion && !disposed) {
      if (backgroundNativeError) throw backgroundNativeError;
      if (Date.now() - statusAt > 1000) {
        let status: RunnerStatus | undefined;
        try { status = await request<RunnerStatus>('status', {}); }
        catch (e) { if (runner?.terminalStreamVersion !== 1) throw e; archiveUnavailable = true; }
        if (version !== loopVersion) return;
        if (status) updateStatus(status);
        statusAt = Date.now();
      }
      if (!replaying && !attentionReading && Date.now() - attentionAt >= 3000) {
        attentionReading = true; attentionAt = Date.now();
        const snapshot = [...views.values()].map(v => v.session);
        const readAttention = async (op: string, args: {id: string}) => {
          const generation = views.get(args.id)?.session.codex?.generation;
          const value = await request(op, args);
          if (views.get(args.id)?.session.codex?.generation !== generation) throw new Error('Attention generation changed');
          return value;
        };
        void attention.poll(snapshot, readAttention, () => connected && version === loopVersion && !disposed)
          .finally(() => { attentionReading = false; if (version === loopVersion && !disposed) refresh(); });
      }
      const polledNative = !replaying && runner?.terminalStreamVersion === 1;
      let nativeMore = polledNative ? await pollNative(version) : false;
      if (version !== loopVersion) return;
      const pageStarted=performance.now();
      let page: { events: Event[]; lastSeq: number; hasMore: boolean };
      // Live PTYs supply their own frames. During typing, avoid a synchronous
      // SQLite round trip per keystroke; replay and archive-dependent transports
      // retain immediate reads, as do gaps and an unfinished archive page.
      const archiveRequired = replaying || archiveHasMore || [...views.values()].some(view =>
        view.catchup || (isLive(view.session) && (view.session.transport === 'app-server' ||
          view.archivedOnly || view.session.terminalStream?.generation !== runner?.generation)));
      const readArchive = archiveRequired || !interactivePoll.isTyping(document.visibilityState === 'visible') ||
        performance.now() - archivePollAt >= 150;
      try {
        if (readArchive) {
          archivePollAt = performance.now();
          page = await request('events', { after:renderedSeq, limit:64 });
          archiveHasMore = page.hasMore;
          archiveUnavailable = false;
        } else page = {events:[], lastSeq:renderedSeq, hasMore:false};
      } catch (e) {
        if (runner?.terminalStreamVersion !== 1) throw e;
        archiveUnavailable = true;
        // Keep the DB cursor: if archives recover they still deduplicate by frame.
        // An unavailable archive must not indefinitely disable live/control.
        replaying = false;
        page = {events:[], lastSeq:renderedSeq, hasMore:false};
      }
      const transferred=performance.now();
      if (version !== loopVersion) return;
      let pageSeq = renderedSeq;
      let pendingWrites: Promise<void>[] = [];
      const historicalWrites = new Set<View>();
      const flushWrites = async () => {
        try { await Promise.all(pendingWrites); }
        finally { for (const view of historicalWrites) view.streamReplay = false; historicalWrites.clear(); pendingWrites = []; }
      };
      for (const event of page.events) {
        if (event.seq <= pageSeq) continue;
        if (replaying && event.seq > replayThrough) { await flushWrites(); replaying = false; }
        validateSequence(pageSeq,event);
        if(event.kind==='provider'){
          const payload = terminalFramesPayload(event.data, views.get(event.sessionId)?.session.transport);
          if (payload) {
            await flushWrites();
            const view = views.get(event.sessionId) ?? ensure({ id:event.sessionId, title:event.sessionId, kind:'unknown', cwd:null, status:'recuperando', rows:24, cols:80 });
            await consumeNative(view, payload.generation, payload.frames, true);
          } else views.get(event.sessionId)?.chat?.applyEvent(event);
        } else if (event.kind === 'output') {
          const view = views.get(event.sessionId) ?? ensure({ id: event.sessionId, title: event.sessionId, kind: 'unknown', cwd: null, status: 'recuperando', rows: 24, cols: 80 });
          if (event.seq <= replayThrough) { view.streamReplay = true; historicalWrites.add(view); }
          else if (!replaying) interactivePoll.output();
          const binary = atob(event.data);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          // Queue one bounded page so xterm can coalesce parser work. Awaiting
          // every small write individually incurs WebKit timer clamping.
          pendingWrites.push(new Promise<void>(resolve => view.term.write(bytes, resolve)));
        } else if (event.kind === 'purged') {
          views.get(event.sessionId)?.chat?.applyEvent(event);
          await flushWrites();
          const view=views.get(event.sessionId);
          if (view && view.session.transport!=='app-server') pendingWrites.push(new Promise<void>(resolve=>view.term.write('\r\n[Historial eliminado explícitamente; este tramo ya no está disponible.]\r\n',resolve)));
        } else if (event.kind === 'resize' || event.kind === 'state') {
          // Geometry/state is an ordering barrier for preceding output.
          await flushWrites();
          if (version !== loopVersion) return;
          // Preserve the historical terminal geometry during replay without sending ioctl.
          const data = JSON.parse(event.data) as Partial<Session>;
          let view = views.get(event.sessionId);
          const checkpoint = streamMetadata(data as Session);
          if (view && (view.stream || streamMetadata(view.session) || checkpoint)) {
            if (checkpoint && view.stream && checkpoint.generation !== view.stream.generation) throw new Error('Terminal generation changed');
            if (checkpoint && !streamMetadata(view.session)) view.session.detail = {...view.session.detail, terminalStream:checkpoint};
            pageSeq = event.seq; continue;
          }
          if (!view && typeof data.id === 'string' && typeof data.kind === 'string') {
            view = ensure(data as Session);
          }
          // PTY ids never restart. Structured conversations can reconnect under
          // a new generation: their historical states cannot retire today's one.
          if(view && event.kind==='state' && typeof data.status==='string'){
            if(view.session.transport==='app-server'){
              if(!replaying)view.session.status=data.status;
            }else if(!['running','starting'].includes(data.status)){if (!replaying) attention.observeEnd(event.sessionId, view.session.status, data.status); view.session.status=data.status;}
          }
          if (view && Number.isInteger(data.cols) && Number.isInteger(data.rows) && data.cols! >= 2 && data.rows! >= 2 && (data.cols !== view.term.cols || data.rows !== view.term.rows)) {
            preserveTerminalViewport(view.term, () => view.term.resize(data.cols!, data.rows!));
          }
          if (!replaying) refresh();
        }
        // Output is acknowledged only after xterm has parsed and painted its buffer.
        pageSeq = event.seq;
        if (replaying && pageSeq >= replayThrough) {
          // Flush old queries while responses are still suppressed, then allow
          // live queries/keyboard from the next event onward.
          await flushWrites();
          replaying = false;
          refresh();
          if ($('#notice-text').textContent?.startsWith('Conectado. Recuperando')) { $('#notice').hidden = true; syncMessageRail(); }
        }
      }
      await flushWrites();
      if (version !== loopVersion) return;
      // xterm callbacks confirm buffer consumption. Never await a display frame:
      // WebKit suspends requestAnimationFrame for an occluded desktop window.
      if (version !== loopVersion) return;
      renderedSeq = pageSeq;
      if (smoke) {
        streamMetrics.pages++;streamMetrics.lastTransferMs=transferred-pageStarted;streamMetrics.lastParseMs=performance.now()-transferred;
        streamMetrics.lastPageMs=performance.now()-pageStarted;streamMetrics.maxParseMs=Math.max(streamMetrics.maxParseMs,streamMetrics.lastParseMs);
        streamMetrics.visibility=document.visibilityState;streamMetrics.pageBytes=page.events.reduce((sum,event)=>sum+event.data.length,0);
      }
      if (replaying && pageSeq >= replayThrough) replaying = false;
      if (!polledNative && !replaying && runner?.terminalStreamVersion === 1) nativeMore = await pollNative(version);
      if (version !== loopVersion) return;
      if (!page.hasMore && page.events.length) for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
      // Status/state transitions refresh the shell above. Output only changes
      // xterm and the event counter; rebuilding chrome every 12ms adds latency.
      if (page.events.length) text('#cursor', `Eventos procesados: ${renderedSeq}`);
      await evidence();
      const yielding=performance.now();
      if (!page.hasMore && !nativeMore) await interactivePoll.wait(document.visibilityState === 'visible');
      else await new Promise(resolve => setTimeout(resolve, 0));
      if(smoke){streamMetrics.lastYieldMs=performance.now()-yielding;streamMetrics.maxYieldMs=Math.max(streamMetrics.maxYieldMs,streamMetrics.lastYieldMs);}
    }
  } catch (e) {
    if (version !== loopVersion) return;
    connected = false; attention.invalidate(); refresh(); notice(`Conexión interrumpida: ${message(e)} Reintenta para recuperar el historial.`, true);
    await evidence(true).catch(() => {});
  }
}
async function connect() {
  if (connecting) return;
  connecting = true; connected = false; loopVersion++; attention.invalidate(); attentionAt = 0; refresh();
  try {
    await terminalFontsReady;
    // Drain the old poll and all xterm callbacks before replacing buffers.
    await activeLoop;
    await Promise.allSettled([...nativeApplying.values()]);
    backgroundNative.clear(); lastBackgroundNative.clear(); nativeForegroundEpoch.clear();
    backgroundNativeError = undefined;
    const previousSelection = panes.map(p => p.id);
    for (const pane of panes) assign(pane, null);
    for (const view of views.values()) { if(view.chat)codexDrafts.set(view.session.id,view.chat.saveDraft(view.session.id)); view.chat?.dispose(); view.disposal(); view.term.dispose(); view.host.remove(); }
    views.clear();windowAttention.reset();runnerAttention.reset();source=windowAttention;if(programRefresh!==undefined){clearTimeout(programRefresh);programRefresh=undefined;} stopping.clear(); archiveUnavailable = false; archivePollAt = 0; archiveHasMore = false; announcedAlerts = new Set(); sidebarKey = ''; renderedSeq = 0; runner = null; statusAt = 0;
    const config = await invoke<{ dataDir: string; socket: string; status: RunnerStatus; smoke: boolean }>('connect_runner');
    smoke = config.smoke; connected = true;
    replayThrough = config.status.lastSeq;
    replaying = replayThrough > 0;
    profileDataDir = config.dataDir;
    if (groupingProfile !== profileDataDir) {
      groupingProfile = profileDataDir; sidebarProjects.reset(); sidebarAsked = null; sidebarRetryAt = 0; projectListKey = '';
      try { grouping = readAgentGrouping(localStorage, profileDataDir); } catch { grouping = 'project'; }
      if (filter === 'open' || filter === 'activity') filter = openFilter();
    }
    $('#layout').textContent = `Datos: ${config.dataDir}`;
    $('#layout').title = `Socket: ${config.socket}`;
    updateStatus(config.status);
    if (previousSelection.some(Boolean)) {
      for (const pane of panes) assign(pane, null);
      previousSelection.forEach((id, i) => { if (id && views.has(id)) assign(panes[i], id); });
    }
    if (!split) assign(panes[1], null);
    if (!panes.some(pane => pane.id) && views.size) {
      const preferred = [...views.values()].find(v => isLive(v.session)) ?? [...views.values()][0];
      assign(panes[0], preferred.session.id);
      if (!matchesSession(preferred.session, filter, query)) filter = isLive(preferred.session) ? openFilter() : matchesSession(preferred.session, 'attention', '') ? 'attention' : 'closed';
    }
    if (!split) assign(panes[1], null);
    $('#notice').hidden = replayThrough === 0; syncMessageRail();
    for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
    if (replaying) notice('Conectado. Recuperando historial…');
    const version = loopVersion;
    activeLoop = poll(version);
  } catch (e) { connected = false; notice(`No se pudo conectar: ${message(e)}`, true); }
  finally { connecting = false; refresh(); }
}
function workspaceContext() {
  const version = loopVersion; const generation = runner?.generation;
  return () => {
    if (version !== loopVersion || generation !== runner?.generation) throw new Error('La conexión cambió. Consulta el estado actual antes de continuar.');
  };
}
$('#choose-directory').addEventListener('click', () => action(async () => {
  const directory = await invoke<string | null>('select_directory');
  if (directory !== null) setSessionDirectory(directory);
}));
$('#use-home-directory').addEventListener('click', () => action(async () => {
  setSessionDirectory(await invoke<string>('home_directory'));
}));
newDialog.addEventListener('close', () => { newDialogVersion++; });
$('#new-session-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    try {
      if (!connected || !selectedDirectory) throw new Error('Selecciona una carpeta antes de iniciar.');
      const kind = document.querySelector<HTMLInputElement>('input[name=provider]:checked')?.value;
      if (!kind || !['codex', 'claude', 'terminal'].includes(kind)) throw new Error('Selecciona una herramienta para iniciar.');
      if (kind === 'terminal' && runner?.normalTerminalVersion !== 1) throw new Error('Reinicia el runner desde Diagnóstico para habilitar Terminal cuando no tengas sesiones en ejecución.');
      const title = $<HTMLInputElement>('#session-title').value.trim() || providerLabel(kind);
      await start(`${kind}-${crypto.randomUUID()}`, kind, title, panes[focusedPane], selectedDirectory);
      newDialog.close(); focusView(activeView());
    } catch (e) { text('#new-session-error', message(e)); $('#new-session-error').hidden = false; }
  });
});
document.querySelectorAll<HTMLInputElement>('input[name=provider]').forEach(input => input.addEventListener('change', refresh));
for (const id of ['new-session', 'welcome-create', 'tab-new-session']) $(`#${id}`).addEventListener('click', () => openNew());
// Vertical wheel scrolls the tab strip sideways; the strip hides its scrollbar.
$('#session-tabs').addEventListener('wheel', event => {
  const strip = $('#session-tabs');
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft += event.deltaY; event.preventDefault();
}, { passive: false });
$('#new-in-folder').addEventListener('click', () => openNew(activeView()?.session.cwd));
for (const id of ['cancel-session', 'cancel-session-x']) $(`#${id}`).addEventListener('click', closeNew);
newDialog.addEventListener('cancel', event => { if (busyAction) event.preventDefault(); });
$('#cancel-stop').addEventListener('click', () => { stopTarget = null; stopDialog.close(); focusView(activeView()); });
stopDialog.addEventListener('cancel', () => { stopTarget = null; focusView(activeView()); });
$('#confirm-stop').addEventListener('click', () => {
  const id = stopTarget; if (!id) return;
  const title = views.get(id)?.session.title ?? 'Sesión';
  const generation=stopGeneration;stopGeneration=null;
  stopTarget = null; stopDialog.close(); focusView(activeView());
  void action(async () => {
    stopping.add(id); refresh();
    notice(`${title}: terminando… Esperando confirmación del proceso.`);
    try { const result=await request<Session>('stop', { id,...(generation!==null?{generation}:{}) }); updateStatus(await request<RunnerStatus>('status', {})); notice(['exited','stopped','failed','interrupted','released'].includes(result.status)?`${title}: sesión detenida. El historial se conserva.`:`${title}: la detención requiere atención. La carpeta y su plaza siguen reservadas.`,result.status==='needs_attention'); }
    catch (e) { notice(`${message(e)} Reconecta para confirmar el estado antes de continuar.`, true); }
  });
});
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; syncMessageRail(); });
$('#toggle-split').addEventListener('click', () => setSplit(!split));
$('#toggle-inspector').addEventListener('click', () => setInspector($('#inspector').hidden));
$('#close-inspector').addEventListener('click', () => setInspector(false));
$('#toggle-sidebar').addEventListener('click', () => {
  const open = $('.workspace-shell').classList.toggle('sidebar-open'); $('#sidebar-scrim').hidden = !open;
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
});
$('#sidebar-scrim').addEventListener('click', closeSidebar);
$('#session-search').addEventListener('input', () => { query = $<HTMLInputElement>('#session-search').value; refresh(); });
function setSearchOpen(open: boolean) {
  searchOpen = open || !!query;
  $('#session-search-field').hidden = !searchOpen;
  $('#toggle-search').setAttribute('aria-expanded', String(searchOpen));
}
// Keep focus in the field on press so its blur handler does not reopen it on click.
$('#toggle-search').addEventListener('mousedown', event => event.preventDefault());
$('#toggle-search').addEventListener('click', () => {
  if (!searchOpen) { setSearchOpen(true); $<HTMLInputElement>('#session-search').focus(); return; }
  if (query) { $<HTMLInputElement>('#session-search').focus(); return; }
  setSearchOpen(false);
});
$('#session-search').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  const input = $<HTMLInputElement>('#session-search');
  if (input.value) { input.value = ''; query = ''; refresh(); }
  setSearchOpen(false); $('#toggle-search').focus();
});
$('#session-search').addEventListener('blur', () => { if (!query) setSearchOpen(false); });
window.addEventListener('focus', () => { loadSidebarProjects(); refresh(); });
window.addEventListener('blur', refresh);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadSidebarProjects(); refresh(); });
// close does not bubble; capture refreshes Dock/header after native focus restoration.
document.addEventListener('close', refresh, true);
function isAttended(id: string) { return !document.querySelector('dialog[open]') && document.visibilityState === 'visible' && document.hasFocus() && stageView === 'terminal' && activeView()?.session.id === id; }
function showAttention() {
  filter = 'attention'; query = ''; $<HTMLInputElement>('#session-search').value = ''; setSearchOpen(false);
  $('.workspace-navigation').scrollTop = 0;
  $('.workspace-shell').classList.add('sidebar-open'); $('#sidebar-scrim').hidden = false;
  $('#toggle-sidebar').setAttribute('aria-expanded', 'true'); refresh();
  const previousFocus = document.activeElement;
  $('#session-list').querySelector<HTMLButtonElement>('button')?.focus();
  // WebKit may ignore focus until the narrow-window drawer becomes visible.
  if (window.innerWidth <= 860) setTimeout(() => {
    if (filter === 'attention' && $('.workspace-shell').classList.contains('sidebar-open') &&
      (document.activeElement === previousFocus || document.activeElement === document.body)) $('#session-list').querySelector<HTMLButtonElement>('button')?.focus();
  }, 200);
}
$('#enable-native-notifications').addEventListener('click', async () => {
  if (nativeAttention.enabled) {
    nativeAttention.disable(); text('#enable-native-notifications', 'Activar avisos de macOS…'); text('#native-notification-status', 'Desactivadas. Los avisos dentro de Jauría siguen disponibles.'); return;
  }
  const button = $<HTMLButtonElement>('#enable-native-notifications'); button.disabled = true;
  await nativeAttention.enableFromClick(source.nativeItems(source.list(attentionSessions()))); button.disabled = false;
});
window.addEventListener('beforeunload', () => nativeAttention.disable(), { once: true });
window.addEventListener('beforeunload', () => { void dockBadge.dispose(); }, { once: true });
$('#session-alerts').addEventListener('click', () => {
  alertsPopover.toggle(); refresh();
  if (alertsPopover.isOpen) $<HTMLButtonElement>('#open-attention-session').focus({ preventScroll: true });
});
$('#attention-show-list').addEventListener('click', () => { alertsPopover.close(false); showAttention(); });
$('#status-needs').addEventListener('click', () => { const id = $('#status-needs').dataset.sessionId; if (id && views.has(id)) selectSession(id); });
$('#open-attention-session').addEventListener('click', () => { const id = $('#open-attention-session').dataset.sessionId; alertsPopover.close(false); if (id && views.has(id)) selectSession(id); });
/** Marking seen is presentation only; persistent causes stay. */
function markAlertsSeen() { source.markAll(attentionSessions()); refresh(); }
$('#see-attention').addEventListener('click', () => {
  markAlertsSeen();
  // Persistent causes keep the popover open on its next action.
  (!$('#attention-banner').hidden ? $('#open-attention-session') : $('#session-alerts').hidden ? $('#toggle-inspector') : $('#session-alerts')).focus();
});
function showFilter(value: 'open' | 'closed') { filter = value === 'open' ? openFilter() : value; $('.workspace-navigation').scrollTop = 0; refresh(); }
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.filter === 'attention') showAttention();
  else showFilter(button.dataset.filter as 'open' | 'closed');
}));
// Por proyecto / Por estado: a remembered per-profile view preference.
function toggleGrouping() {
  grouping = grouping === 'state' ? 'project' : 'state';
  try { saveAgentGrouping(localStorage, profileDataDir, grouping); } catch { /* Optional view preference. */ }
  if (filter === 'open' || filter === 'activity') filter = openFilter();
  $('.workspace-navigation').scrollTop = 0; refresh();
}
$('#agent-grouping').addEventListener('click', toggleGrouping);
$('#copy-session-id').addEventListener('click', () => { const id = activeView()?.session.id; if (id) void navigator.clipboard.writeText(id).catch(e => notice(message(e), true)); });
const theme = $<HTMLSelectElement>('#theme-select');
try { theme.value = localStorage.getItem('aw-theme') ?? 'system'; } catch { /* appearance is optional */ }
document.documentElement.dataset.theme = theme.value;
function applyTheme(value: string) {
  theme.value = value; document.documentElement.dataset.theme = value;
  try { localStorage.setItem('aw-theme', value); } catch { /* optional */ }
}
theme.addEventListener('change', () => applyTheme(theme.value));
async function requestPulso(op: string, args: Record<string, unknown>) {
  if (disposed || connecting || !connected || !runner?.pulsoAvailable || runner.pulsoVersion !== 1) throw new Error('Pulso no está disponible. Conecta un runner compatible.');
  const generation = runner.generation;
  const check = workspaceContext();
  const profile = profileDataDir;
  const response = await invoke<{ok:boolean;result:unknown;error?:string}>('pulso_request', {op,args});
  check();
  if (!runner || runner.generation !== generation || profile !== profileDataDir || disposed) throw new Error('La conexión cambió. Consulta el estado antes de continuar.');
  if (!response.ok) throw new Error(response.error ?? 'Pulso no confirmó la operación.');
  return response.result;
}
const settingsPanel = mountSettings({
  permissions: { request: requestPulso, sessions: () => [...views.values()].map(view => view.session), available: () => connected && !connecting && runner?.pulsoVersion === 1 && !!runner.pulsoAvailable },
  notificationControls: $('#enable-native-notifications').closest<HTMLElement>('.settings-section')!,
  hasAttention: () => !$('#attention-filter').hidden,
  canOpenAttention: () => !pulsoPanel || pulsoPanel.prepareNavigation(),
  onOpenAttention: showAttention,

  async read() {
    if (!connected || connecting) throw new Error('Runner sin conexión.');
    if (runner?.settingsVersion !== 1 && runner?.settingsVersion !== 2) return { schemaVersion: 1, maxConcurrentSessions: 2, maxSupportedSessions: 2,
      warning: 'Runner anterior: se conserva el límite de 2 sesiones. Actualiza el runner para ajustarlo.' };
    const check = workspaceContext();
    const result = await request<AppSettings>('get_settings', {}); check(); return result;
  },
  async save(maxConcurrentSessions, pulsoAutoAccess) {
    if (!connected || connecting || (runner?.settingsVersion !== 1 && runner?.settingsVersion !== 2)) throw new Error('El runner no permite editar la configuración.');
    const check = workspaceContext();
    const result = await request<AppSettings>('set_settings', settingsArgs(runner.settingsVersion, maxConcurrentSessions, pulsoAutoAccess)); check(); return result;
  },
  getTheme: () => theme.value, setTheme: applyTheme, version: appVersion,
  canEdit: () => connected && !connecting && (runner?.settingsVersion === 1 || runner?.settingsVersion === 2),
  onSaved(settings) { if (runner) runner.settings = settings; refresh(); },
});
function openPermissions(context: {projectId?: string; sessionId?: string}) {
  if(disposed || settingsPanel.isOpen || Array.from(document.querySelectorAll('dialog[open]')).some(dialog => !dialog.classList.contains('pulso-drawer')))return;
  settingsPanel.open('permissions',context);closeSidebar();refresh();
}
function openSettings() {
  if (disposed || document.querySelector('dialog[open]')) return;
  settingsPanel.open(); closeSidebar(); refresh();
}
$('#open-settings').addEventListener('click', openSettings);
// Native menu registration is optional in a browser; no permission is requested.
let unlistenSettings: (() => void) | undefined;
void listen('open-settings', openSettings).then(unlisten => {
  if (disposed) unlisten(); else unlistenSettings = unlisten;
}).catch(() => { /* Native events are unavailable in the browser harness. */ });
window.addEventListener('beforeunload', () => { settingsPanel.dispose(); unlistenSettings?.(); }, { once: true });
const renameDialog = $<HTMLDialogElement>('#rename-session-dialog');
const renameInput = $<HTMLInputElement>('#rename-session-input');
let renameTarget: string | null = null;
let renameReturn: HTMLElement | null = null;
let renameBusy = false;
function openRename(id: string) {
  if (disposed || busyAction || runner?.sessionRenameVersion !== 1 || document.querySelector('dialog[open]')) return;
  const session = views.get(id)?.session; if (!session) return;
  renameTarget = id; renameInput.value = session.title;
  $('#rename-session-error').hidden = true; renameInput.removeAttribute('aria-invalid');
  renameReturn = document.activeElement as HTMLElement | null;
  renameDialog.showModal(); renameInput.focus(); renameInput.select(); refresh();
}
function closeRename() { if (!renameBusy) renameDialog.close(); }
$('#cancel-rename').addEventListener('click', closeRename);
renameDialog.addEventListener('cancel', event => { if (renameBusy) event.preventDefault(); });
renameDialog.addEventListener('close', () => {
  if (renameDialog.open) return;
  renameTarget = null;
  if (renameReturn?.isConnected) renameReturn.focus(); else focusView(activeView());
  renameReturn = null; refresh();
});
$('#rename-session-form').addEventListener('submit', event => {
  event.preventDefault();
  if (renameBusy || !renameTarget || !connected || connecting || runner?.sessionRenameVersion !== 1) return;
  const id = renameTarget, title = renameInput.value.trim();
  if (!title || [...title].length > 120 || new TextEncoder().encode(title).length > 480 || /\p{Cc}/u.test(renameInput.value)) {
    text('#rename-session-error', 'Introduce un nombre de 1 a 120 caracteres Unicode, hasta 480 bytes y sin caracteres de control.');
    $('#rename-session-error').hidden = false; renameInput.setAttribute('aria-invalid', 'true'); renameInput.focus(); return;
  }
  renameBusy = true; busyAction = true; renameInput.disabled = true;
  renameDialog.setAttribute('aria-busy', 'true');
  for (const key of ['cancel-rename','save-rename']) $<HTMLButtonElement>(`#${key}`).disabled = true;
  $('#rename-session-error').hidden = true; renameInput.removeAttribute('aria-invalid'); refresh();
  const check = workspaceContext();
  void (async () => {
    let renamed = false;
    try {
      await request<Session>('rename_session', { id, title }); check();
      renamed = true;
      const status = await request<RunnerStatus>('status', {}); check();
      if (disposed) return;
      updateStatus(status); renameDialog.close();
    } catch (e) {
      if (!disposed) {
        text('#rename-session-error', `${renamed ? 'El nombre se guardó; no se pudo actualizar el estado. ' : ''}${message(e)} Reintenta guardar.`);
        $('#rename-session-error').hidden = false;
      }
    } finally {
      renameBusy = false; busyAction = false;
      if (!disposed) {
        renameInput.disabled = false; renameDialog.setAttribute('aria-busy', 'false');
        for (const key of ['cancel-rename','save-rename']) $<HTMLButtonElement>(`#${key}`).disabled = false;
        refresh();
      }
    }
  })();
});
/** ⌘K: reveal and focus the agent list's search field. */
function focusSessionSearch() {
  if (window.innerWidth <= 860) {
    $('.workspace-shell').classList.add('sidebar-open'); $('#sidebar-scrim').hidden = false;
    $('#toggle-sidebar').setAttribute('aria-expanded', 'true');
  }
  // WebKit ignores focus while CSS visibility is still transitioning.
  // Blur immediately; a guarded retry after the drawer settles never sends
  // intervening keystrokes to the CLI or steals a later deliberate focus.
  const search = $<HTMLInputElement>('#session-search');
  setSearchOpen(true);
  (document.activeElement as HTMLElement | null)?.blur();
  void getComputedStyle($('#sidebar')).visibility;
  search.focus();
  setTimeout(() => {
    if (!document.querySelector('dialog[open]') && stageView === 'terminal' && document.activeElement === document.body && (window.innerWidth > 860 || $('.workspace-shell').classList.contains('sidebar-open'))) search.focus();
  }, 200);
}
function focusOtherPane() {
  if (!split || stageView !== 'terminal') return;
  focusedPane = focusedPane === 0 ? 1 : 0; refresh();
  const pane = panes[focusedPane]; const view = pane.id ? views.get(pane.id) : undefined;
  if (view) focusView(view); else pane.trigger.focus();
}
/** Interrumpir sends Ctrl-C at once from its button; the palette only focuses that button. */
function focusInterruptControl(id: string) {
  const pane = panes.find((p, index) => p.id === id && (index === 0 || split)); if (!pane) return;
  const button = pane.root.querySelector<HTMLButtonElement>('[data-action="interrupt"]');
  if (!button || button.hidden || button.disabled) return;
  button.focus();
  notice(`${views.get(id)?.session.title ?? 'Sesión'}: pulsa Intro o Espacio en Interrumpir para enviar Ctrl-C.`);
}
/** In Pulso, a draft or a failed save keeps the board (same guard as «Terminal»). */
function pulsoNavigationAllowed() {
  if (stageView !== 'pulso' || !pulsoPanel || pulsoPanel.prepareNavigation()) return true;
  notice('Guarda o descarta el borrador de Pulso antes de salir del tablero.'); return false;
}
function pulsoUnavailable(): string | null {
  if (!connected) return 'Pulso sin conexión';
  if (runner?.pulsoBoardVersion !== 1) return 'Pulso necesita el runner actualizado';
  return runner.pulsoAvailable ? null : 'Pulso no disponible; sus datos se conservan';
}
const mac = isMacPlatform();
function commandContext(): AppCommandContext {
  const view = activeView();
  const needsId = $('#status-needs').dataset.sessionId;
  return {
    connected, connecting, busy: busyAction, replaying, occupied: occupiedSessions(), limit: sessionLimit(), sessionCount: views.size, split,
    planning: stageView === 'pulso', pulsoUnavailable: pulsoUnavailable(), pulsoDraft: pulsoPanel?.draftBlocked() ?? null, inspectorOpen: !$('#inspector').hidden,
    unseenAlerts: Number($('#session-alerts').dataset.unread ?? 0),
    needsTarget: needsId && views.has(needsId) ? { id: needsId, title: views.get(needsId)!.session.title } : null,
    grouping, filter: filter === 'closed' ? 'closed' : filter === 'open' || filter === 'activity' ? 'open' : 'other', theme: theme.value as Theme,
    renameSupported: runner?.sessionRenameVersion === 1,
    focused: view ? { id: view.session.id, title: view.session.title, live: isLive(view.session), stopping: stopping.has(view.session.id), structured: view.session.transport === 'app-server' } : null,
    actions: {
      togglePalette: () => palette?.toggle(), newSession: () => openNew(), searchSessions: focusSessionSearch, toggleSplit: () => setSplit(!split), focusOtherPane,
      showPulso, leavePulso, newProject: () => { if (!pulsoNavigationAllowed()) return; showPulso(); pulsoPanel?.newProject(); },
      openSettings, toggleInspector: () => setInspector($('#inspector').hidden), markAlertsSeen,
      openSession: id => { if (views.has(id) && pulsoNavigationAllowed()) selectSession(id); },
      toggleGrouping, showFilter, setTheme: applyTheme, rename: openRename, interrupt: focusInterruptControl,
      stop: id => { const target = views.get(id); if (target) openStopConfirmation(target); },
    },
  };
}
const commands = () => appCommands(commandContext());
const handleShortcut = createShortcutHandler({ commands, mac,
  blocked: id => palette?.isOpen ? id !== 'command-palette' : !!document.querySelector('dialog[open]') });
function handleAppShortcut(event: KeyboardEvent): boolean { return handleShortcut(event); }
installShortcutListeners(window, handleAppShortcut, mac);
/** Palette entries from data the client already holds (no Pulso read per key). */
function paletteItems(): PaletteItem[] {
  // The activity the last refresh painted: the palette agrees with the sidebar.
  const sessions = attentionSessions(), summary = sidebarProjects.snapshot;
  return paletteEntries({ sessions: sessions.map(s => ({ ...s, live: isLive(s) })), activityOf: id => currentActivity.get(id) ?? { kind: 'unreported', label: '' },
    projects: summary.projects, links: summary.links, pendingOpen: summary.pendingOpen, hasMoreProjects: summary.hasMore, pulsoBlocked: pulsoUnavailable(), pulsoDraft: pulsoPanel?.draftBlocked() ?? null,
    commands: commands(), mac, openSession: id => commandContext().actions.openSession(id), openBoard: openBoardFromNavigation,
    openPulso: () => { if (stageView !== 'pulso') showPulso(); }, phases: pulsoPanel?.loadedPhases() ?? null, openPhase: openPhaseFromNavigation });
}
palette = new CommandPalette({
  items: paletteItems,
  canOpen: () => !disposed && !document.querySelector('dialog[open]'),
  // Popovers, pickers and menus close first; none of them keeps focus under the palette.
  beforeOpen: () => {
    alertsPopover.close(false);
    for (const pane of panes) { pane.picker.close(false); pane.root.querySelectorAll('details').forEach(d => d.open = false); }
    pulsoPanel?.closeMenus();
    if (window.innerWidth <= 860) closeSidebar();
  },
  returnTarget: paletteReturnTarget,
  fallbackFocus: paletteFallbackFocus,
  onToggle: open => $('#open-command-palette').setAttribute('aria-expanded', String(open)),
});
/** A floating control that beforeOpen closes returns focus to its trigger; the overlay sidebar to the terminal. */
function paletteReturnTarget(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  for (const pane of panes) {
    if (pane.picker.popup.contains(active)) return pane.trigger;
    const menu = active.closest('.pane-menu');
    if (menu && pane.root.contains(menu)) return menu.querySelector<HTMLElement>('summary');
  }
  if ($('#attention-banner').contains(active)) return $('#session-alerts');
  const anchor = pulsoPanel?.menuAnchor(active); if (anchor) return anchor;
  if (window.innerWidth <= 860 && $('#sidebar').contains(active)) return null;
  return active;
}
/** Never leave focus on body: the focused pane's terminal, else the view's own entry point. */
function paletteFallbackFocus() {
  const view = activeView();
  if (stageView === 'terminal' && view) { focusView(view); if (document.activeElement !== document.body) return; }
  const candidates = stageView === 'pulso' ? ['#pulso-back-terminal', '#open-pulso'] : [`#session-${focusedPane}`, '#welcome-create', '#open-command-palette'];
  for (const selector of candidates) {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node || (node as HTMLButtonElement).disabled || !node.getClientRects().length) continue;
    node.focus({ preventScroll: true }); if (document.activeElement === node) return;
  }
}
$('#open-command-palette').setAttribute('aria-keyshortcuts', shortcutAria('command-palette', mac));
$('#open-command-palette').title = `Paleta de comandos (${shortcutHint('command-palette', mac)})`;
text('#open-command-palette-hint', shortcutHint('command-palette', mac));
// Keep the previous focus (normally the terminal) so closing returns to it.
$('#open-command-palette').addEventListener('mousedown', event => event.preventDefault());
$('#open-command-palette').addEventListener('click', () => palette?.open());
$('#connect').addEventListener('click', () => void connect());
$('#quit').addEventListener('click', () => void invoke('quit_ui').catch(e => notice(message(e), true)));
$('#create-1').addEventListener('click', () => action(() => start('fixture1', 'fixture', 'Fixture 1', panes[0])));
$('#create-2').addEventListener('click', () => action(() => start('fixture2', 'fixture', 'Fixture 2', panes[1])));
$('#create-both').addEventListener('click', () => action(async () => { await start('fixture1', 'fixture', 'Fixture 1', panes[0]); await start('fixture2', 'fixture', 'Fixture 2', panes[1]); }));
async function probeTools(explicit = false) {
  const button = $<HTMLButtonElement>('#probe'); button.disabled = true;
  try {
    const tools = await invoke<{ tool: string; available: boolean; path?: string; version?: string }[]>('probe_tools');
    text('#tools', tools.map(t => `${t.tool}: ${t.available ? t.version : 'No disponible'}${t.path ? `\n${t.path}` : ''}`).join('\n\n'));
    for (const kind of ['codex', 'claude']) {
      const tool = tools.find(t => t.tool === kind);
      const label = tool?.available ? 'CLI disponible' : 'CLI no disponible';
      text(`#welcome-${kind}`, `${providerLabel(kind)} · ${label}`); text(`#new-${kind}-status`, label);
    }
    if (explicit) { setInspector(true); $<HTMLDetailsElement>('#diagnostics').open = true; }
  } catch (e) {
    for (const kind of ['codex', 'claude']) { text(`#welcome-${kind}`, `${providerLabel(kind)} · CLI sin verificar`); text(`#new-${kind}-status`, 'CLI sin verificar'); }
    if (explicit) notice(message(e), true);
  } finally { button.disabled = false; }
}
$('#probe').addEventListener('click', () => void probeTools(true));
void probeTools();
pulsoPanel = mountPulsoPanel({
  host: $('#pulso-panel-host'),
  tabsHost: $('#pulso-tabs-host'),
  request: requestPulso,
  persistenceKey: () => profileDataDir,
  bindingCacheKey: () => `${loopVersion}:${runner?.generation??''}`,
  onOpenPermissions: openPermissions,
  sessions: () => [...views.values()].map(view => ({...view.session,programState:source.display(view.session.id)})),
  currentSession: () => activeView()?.session ?? null,
  openSession: id => { if (!views.has(id)) { notice('La sesión vinculada no está disponible en este perfil.'); return; } selectSession(id); },
  newSession: cwd => openNew(cwd ?? null),
  backToTerminal: () => leavePulso(),
  notice: text => notice(text),
  binding: async id => runner?.nativeResumeVersion === 1 ? request('native_binding', {id}) : {binding:null},
  onChange: () => { loadSidebarProjects(); if (!disposed) refresh(); },
  revisionFromStatus: () => statusPulsoRevision() !== null,
  cardFooters: () => runner?.pulsoBoardCardsVersion === 1,
  activityOf: id => currentActivity.get(id) ?? null,
  resumeSession: async sourceId => {
    if (runner?.nativeResumeVersion !== 1 || !connected) throw new Error('Este runner no permite reanudar conversaciones nativas.');
    const check=workspaceContext();
    const native=await request<{activeSessionId?:string|null}>('native_binding',{id:sourceId});check();
    if(native.activeSessionId){
      const active=views.get(native.activeSessionId);
      if(active&&isLive(active.session)){selectSession(active.session.id);return active.session.id;}
      throw new Error('La conversación ya tiene una sesión activa o sin verificar. Consulta su estado antes de reanudar.');
    }
    if(!resumeAttempts.has(sourceId)) requireSessionCapacity();
    const id=resumeAttempts.get(sourceId) ?? `claude-${crypto.randomUUID()}`; resumeAttempts.set(sourceId,id);
    const session=await request<Session>('resume_native',{id,sourceId,rows:24,cols:80});
    ensure(session); resumeAttempts.delete(sourceId); selectSession(session.id); return session.id;
  },
});
function showPulso() { stageView = 'pulso'; setInspector(false); closeSidebar(); refresh(); }
/** Same as the former «Volver a terminal»: a Pulso draft or failed save keeps the board. */
function leavePulso() {
  if (stageView !== 'pulso') return;
  if (pulsoPanel && !pulsoPanel.prepareNavigation()) { notice('Guarda o descarta el borrador de Pulso antes de volver a la terminal.'); return; }
  stageView = 'terminal'; refresh();
  for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
  if (activeView()) focusView(activeView()); else if (!$<HTMLButtonElement>('#welcome-create').disabled) $('#welcome-create').focus(); else $('#open-pulso').focus();
}
// The Pulso button toggles between the board and the terminal view.
$('#open-pulso').addEventListener('click', () => { if (stageView === 'pulso') leavePulso(); else showPulso(); });
$('#pulso-back-terminal').addEventListener('click', leavePulso);
$('#sidebar-project-list').addEventListener('click', event => {
  const more = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-more]');
  if (more && !more.disabled) { showPulso(); return; }
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-board]');
  if (!row || row.disabled || !pulsoPanel) return;
  // openBoard keeps Pulso's draft guards: a dirty or failed draft keeps the current board.
  showPulso();
  void pulsoPanel.openBoard(row.dataset.board === '' ? null : row.dataset.board!).finally(() => { if (!disposed) refresh(); });
});
/** Palette: openBoard keeps Pulso's draft guards; prepareNavigation also reports why the board stays. */
function openBoardFromNavigation(board: string | null) {
  if (!pulsoPanel || pulsoUnavailable() || !pulsoNavigationAllowed()) return;
  showPulso();
  void pulsoPanel.openBoard(board).finally(() => { if (!disposed) refresh(); });
}
/** Palette «Fases»: a phase of the loaded board opens its drawer; Pulso's draft guards apply. */
function openPhaseFromNavigation(id: string) {
  if (!pulsoPanel || pulsoUnavailable() || !pulsoNavigationAllowed()) return;
  showPulso();
  void pulsoPanel.openPhase(id).finally(() => { if (!disposed) refresh(); });
}
window.addEventListener('beforeunload', () => { disposed = true; loopVersion++; pulsoPanel?.dispose(); });
refresh();
// Connect is safe at launch: replay only. All start operations require visible controls.
void connect();

const disposeTelemetry = mountTelemetry($('#telemetry-host'), request, () => connected, (snapshot) => {
  const resources=snapshot.resources as {app?:{processes?:{cpuPercent?:number;rssBytes?:number}[]}} | undefined;
  const current=resources?.app?.processes?.[0];
  text('#telemetry-summary',`Interfaz · CPU ${current?.cpuPercent == null ? '—' : formatTelemetryCpu(current.cpuPercent)} · RAM ${current?.rssBytes == null ? '—' : formatTelemetryBytes(current.rssBytes)}`);
});
window.addEventListener('beforeunload', disposeTelemetry, { once: true });

let diagnosticPreviewId: string | null = null;
$('#preview-diagnostic').addEventListener('click', () => action(async () => {
  const preview=await invoke<{previewId:string;content:string}>('preview_diagnostic');
  diagnosticPreviewId=preview.previewId; text('#diagnostic-preview',preview.content); $('#diagnostic-preview').hidden=false;
  $<HTMLButtonElement>('#export-diagnostic').disabled=false;
  text('#diagnostic-export-state','Estos son los bytes que se guardarán. Excluye terminal, rutas, notas y credenciales.');
}));
$('#export-diagnostic').addEventListener('click', () => action(async () => {
  if (!diagnosticPreviewId) throw new Error('Previsualiza primero.');
  const saved=await invoke<boolean>('export_diagnostic',{previewId:diagnosticPreviewId});
  text('#diagnostic-export-state',saved?'Diagnóstico guardado.':'Exportación cancelada.');
}));

$('#purge-history').addEventListener('click',()=>action(async()=>{
  const id=activeView()?.session.id;if (!id) throw new Error('Selecciona un historial.');
  const response=await invoke<{ok:boolean;error?:string}>('confirm_history',{op:'purge_history',args:{id}});
  if (!response.ok) throw new Error(response.error??'No se pudo eliminar la salida.');
  await connect();notice('Salida eliminada explícitamente. Se conservan estados y archivos.');
}));

$('#restart-runner').addEventListener('click',()=>action(async()=>{
  if (await invoke<boolean>('restart_runner')) { await connect();notice('Runner reiniciado. Archivos e historial conservados.'); }
}));

$('#compact-history').addEventListener('click',()=>action(async()=>{
  const id=activeView()?.session.id;if (!id) throw new Error('Selecciona un historial.');
  const response=await invoke<{ok:boolean;error?:string}>('confirm_history',{op:'compact_history',args:{id}});
  if (!response.ok) throw new Error(response.error??'No se pudo compactar el historial.');
  await connect();notice('Eventos antiguos compactados explícitamente. Archivos y último estado conservados.');
}));

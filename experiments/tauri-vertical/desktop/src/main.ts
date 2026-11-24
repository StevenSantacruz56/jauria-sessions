import { listen } from '@tauri-apps/api/event';
import { appVersion } from './app-version';
import { mountSettings, settingsArgs, type AppSettings } from './settings-panel';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { NativeAttention, clickedNotice, nativeNoticeContent } from './native-attention';
import { attachTerminalAttention } from './terminal-attention';
import { SessionAttention } from './attention';
import { RunnerAttentionSource, WindowAttentionSource, turnEnded, type AttentionSource } from './attention-source';
import { DockBadge, dockUnreadCount } from './dock-badge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mountCodexConversation } from './codex-conversation';
import './codex-conversation.css';
import { validateSequence } from './events';
import { TerminalStreamCursor, isLocalHistoryLimit, historyUsage, deferTerminalGap, terminalFramesPayload, terminalGapNotice, historyLabel, historyReasonLabel, type TerminalStream, type TerminalFrame, type TerminalGap, type TerminalHistory } from './terminal-stream';
import { mountTelemetry, formatTelemetryBytes } from './telemetry';
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
import { NEW_SESSION_OPTION, SessionPicker, sessionPickerOptions } from './session-picker';
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
import { capacityText, claudeFolderConflict, folderLabel, isMissingFolderError, providerNames, readRecentFolders, rememberRecentFolder, startBlockedReason, type Provider, type ToolState } from './new-session';
import { createShortcutHandler, installShortcutListeners, isMacPlatform, shortcutAria, shortcutHint } from './shortcuts';
import { claimFloating, release as releaseFloating } from './floating';
import { clampShare, clampWidth, defaultSidebarLayout, effectiveSidebarWidth, maxSidebarWidth, projectsMaxHeight, projectsShare, readSidebarLayout, sameLayout, saveSidebarLayout, separatorKey, sidebarOverlayBelow, sidebarWidth, type SidebarLayout } from './sidebar-layout';
import { readTerminalFont, saveTerminalFont, terminalFontSize } from './terminal-font';
import { category, categoryLabel, continuation, interruptionDetail, isClosed, isLiveStatus, orderRecent, readDismissed, saveDismissed, withDismissed, readSeenIncidents, saveSeenIncidents, type DismissedSessions } from './session-lifecycle';

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
// «Nueva sesión» state: home folder, a folder the runner reported missing, CLI checks,
// the Pulso project fixed by «Nuevo proyecto», a link still to confirm and the in-flight open.
let homeDirectory: string | null = null;
let folderMissing = false;
const toolState: Record<'codex' | 'claude', ToolState> = { codex: 'checking', claude: 'checking' };
let lockedProject: { id: string; title: string } | null = null;
let pendingLink: { sessionId: string; projectId: string; title: string; requestId: string } | null = null;
let openingSession = false;
// CLI checks: sequence of the newest one and its promise (older replies are ignored).
let probeSeq = 0;
let probeInFlight: Promise<void> | null = null;
/** The dialog was opened with a tool already chosen (Empezar de nuevo aquí): a late CLI check does not switch it. */
let newDialogPreset = false;
let stageView: 'terminal' | 'pulso' | 'history' = 'terminal';
// Vista Historial (1.4.0): the Terminada being read in the stage; never a pane.
let historyId: string | null = null;
// «Descartar» and «continuada» (view metadata per profile): those Interrumpidas are Terminadas.
let dismissed: DismissedSessions = new Map();
const isRetired = (id: string) => dismissed.has(id);
attention.retired = isRetired;
// Runner 1.3.x (window mode): a Terminar the person confirmed is not «Proceso terminó» (the runner 1.4 does the same).
attention.stopRequested = id => stopping.has(id) || stopFlights.has(id);
// What native_binding said about a Claude session in this connection (identity present or not).
const bindingKnown = new Map<string, 'none' | 'present'>();
const bindingReads = new Set<string>();
// Recovery overlays the person folded with «Ver salida».
const recoveryFolded = new Set<string>();
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
// Last heading word per listed session (turnEnded prunes absent ids; cleared on every connection).
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
// A stop request still waiting for the runner's answer: one per session, even after «No se pudo confirmar».
const stopFlights = new Map<string, object>();
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
const finalStatus = isClosed;
// Terminar the person confirmed whose end the runner did not confirm (needs_attention or no answer in time).
const stopUncertain = new Set<string>();
const stopConfirmMs = 12000;
// Most recently used sessions: the last tie-break when a pane needs another session.
const lastUsed = new Map<string, number>(); let usedClock = 0;
const newDialog = $<HTMLDialogElement>('#new-session-dialog');
const alertsPopover = new AlertsPopover({ button: $<HTMLButtonElement>('#session-alerts'), panel: $('#attention-banner'), list: $('#attention-list'),
  onOpenSession: id => { if (views.has(id)) selectSession(id); }, onToggle: () => queueMicrotask(() => { if (!disposed) refresh(); }) });
const stopDialog = $<HTMLDialogElement>('#stop-session-dialog');
let dialogReturn: HTMLElement | null = null;
let newDialogVersion = 0;
/** Pulso «Nuevo proyecto» waiting for the session this dialog starts (cleared when the dialog closes). */
let projectSessionTarget: ((sessionId: string) => void) | null = null;
const nativeAttention = new NativeAttention({
  granted: isPermissionGranted, request: requestPermission,
  // `id` is opaque (random): the click handler maps it back to a session or the alerts list.
  send: (kind, id) => sendNotification({ ...nativeNoticeContent(kind), id }),
}, id => connected && !replaying && !isAttended(id), value => {
  text('#native-notification-status', value);
  text('#enable-native-notifications', nativeAttention.enabled ? 'Desactivar avisos de macOS' : 'Activar avisos de macOS…');
});
function activeView() { return panes[focusedPane]?.id ? views.get(panes[focusedPane].id!) : undefined; }
// Null-safe: the Configuración controls are moved into its dialog, which is removed on unload.
function text(selector: string, value: string) { const node = document.querySelector(selector); if (node) node.textContent = value; }
function closeSidebar() { $('.workspace-shell').classList.remove('sidebar-open'); $('#sidebar-scrim').hidden = true; $('#toggle-sidebar').setAttribute('aria-expanded', 'false'); }
/**
 * `preset` (Empezar de nuevo aquí, Nueva sesión en esta carpeta): folder, provider and name
 * already filled; the person confirms. `project` (Pulso «Nuevo proyecto»): fixed and shown
 * as «Proyecto: «Nombre» · sesión principal».
 */
function openNew(cwd: string | null = null, preset?: { kind: string; title: string }, project?: { id: string; title: string }) {
  if (busyAction || newDialog.open) return;
  const version = ++newDialogVersion;
  selectedDirectory = cwd ?? homeDirectory; folderMissing = false; pendingLink = null; lockedProject = project ?? null;
  $<HTMLInputElement>('#session-title').value = preset?.title ?? '';
  const provider = preset && ['codex', 'claude', 'terminal'].includes(preset.kind) ? document.querySelector<HTMLInputElement>(`input[name=provider][value=${preset.kind}]`) : null;
  if (provider) provider.checked = true; newDialogPreset = !!provider;
  for (const id of ['#new-session-error', '#folder-error', '#session-link-retry', '#session-project-error']) $(id).hidden = true;
  renderFolderOptions(); renderProjectField();
  dialogReturn = document.activeElement as HTMLElement;
  closeSidebar(); newDialog.showModal(); refresh();
  // A preset keeps its tool even if its CLI is missing (the reason says so); otherwise an available one.
  if (!provider) selectAvailableProvider();
  focusSelectedProvider();
  if (homeDirectory === null) void invoke<string>('home_directory').then(directory => {
    homeDirectory = directory;
    if (version !== newDialogVersion || !newDialog.open) return;
    if (selectedDirectory === null) selectedDirectory = directory;
    renderFolderOptions(); refresh();
  }).catch(e => {
    if (version !== newDialogVersion || !newDialog.open || selectedDirectory !== null) return;
    renderFolderOptions(); text('#folder-error', message(e)); $('#folder-error').hidden = false;
  });
}
function checkedProvider(): Provider | null { const value = document.querySelector<HTMLInputElement>('input[name=provider]:checked')?.value; return value === 'codex' || value === 'claude' || value === 'terminal' ? value : null; }
function selectAvailableProvider() {
  const usable = (value: string) => value === 'terminal' ? runner?.normalTerminalVersion === 1 : toolState[value as 'codex' | 'claude'] !== 'missing';
  const checked = checkedProvider(); if (checked && usable(checked)) return;
  const first = Array.from(document.querySelectorAll<HTMLInputElement>('input[name=provider]')).find(input => usable(input.value));
  if (first) { first.checked = true; refresh(); }
}
/** Keyboard starts on the selected tool (arrows move within the group). */
function focusSelectedProvider() {
  const target = document.querySelector<HTMLInputElement>('input[name=provider]:checked:not(:disabled)') ?? document.querySelector<HTMLInputElement>('input[name=provider]:not(:disabled)');
  (target ?? $<HTMLSelectElement>('#session-folder')).focus();
}
/** Mi carpeta personal first, the chosen folder if it is new, then «Recientes» (5 per profile). */
function renderFolderOptions() {
  const select = $<HTMLSelectElement>('#session-folder'); select.replaceChildren();
  const option = (value: string, label: string, parent: HTMLElement = select) => { const o = document.createElement('option'); o.value = value; o.textContent = label; o.title = value; parent.append(o); return o; };
  if (homeDirectory) option(homeDirectory, `Mi carpeta personal · ${homeDirectory}`);
  else option('', 'Cargando carpeta personal…').disabled = true;
  let recents: string[] = []; try { recents = readRecentFolders(localStorage, profileDataDir).filter(folder => folder !== homeDirectory); } catch { /* Optional view preference. */ }
  if (selectedDirectory && selectedDirectory !== homeDirectory && !recents.includes(selectedDirectory)) {
    const chosen = document.createElement('optgroup'); chosen.label = 'Carpeta elegida'; option(selectedDirectory, folderLabel(selectedDirectory, homeDirectory), chosen); select.append(chosen);
  }
  if (recents.length) { const group = document.createElement('optgroup'); group.label = 'Recientes'; for (const folder of recents) option(folder, folderLabel(folder, homeDirectory), group); select.append(group); }
  select.value = selectedDirectory ?? '';
}
/** Proyecto de Pulso (opcional): open projects from the sidebar summary; hidden without Pulso. */
function renderProjectField() {
  const field = $('#session-project-field'), select = $<HTMLSelectElement>('#session-project'), locked = $('#session-project-locked');
  if (lockedProject) {
    field.hidden = false; select.hidden = true; locked.hidden = false;
    locked.textContent = `Proyecto: «${lockedProject.title}» · sesión principal`; return;
  }
  select.hidden = false; locked.hidden = true; field.hidden = !pulsoReadable();
  const keep = select.value; select.replaceChildren();
  const none = document.createElement('option'); none.value = ''; none.textContent = 'Sin proyecto'; select.append(none);
  for (const project of sidebarProjects.snapshot.projects) { const o = document.createElement('option'); o.value = project.id; o.textContent = project.title; select.append(o); }
  select.value = newDialog.open && Array.from(select.options).some(o => o.value === keep) ? keep : '';
}
/** Nueva sesión: tool states, capacity, the exact reason «Abrir sesión» is blocked, and the Claude same-folder warning. */
function syncNewSessionDialog(occupied: number, sessions: Session[]) {
  const working = busyAction || openingSession;
  // While a session opens every field is locked: what is sent is exactly what is shown.
  $<HTMLButtonElement>('#choose-directory').disabled = working || connecting; $<HTMLSelectElement>('#session-folder').disabled = working;
  $<HTMLSelectElement>('#session-project').disabled = working; $<HTMLInputElement>('#session-title').disabled = working;
  const terminalSupported = runner?.normalTerminalVersion === 1;
  $<HTMLInputElement>('input[name=provider][value=terminal]').disabled = !terminalSupported || working;
  text('#new-terminal-status', connecting ? 'Conectando…' : !connected ? 'Sin conexión' : terminalSupported ? 'Shell zsh' : 'Requiere reiniciar runner');
  const toolLabel: Record<ToolState, string> = { available: 'CLI disponible', missing: 'CLI no instalada', unknown: 'CLI sin verificar', checking: 'Comprobando…' };
  for (const kind of ['codex', 'claude'] as const) {
    const input = $<HTMLInputElement>(`input[name=provider][value=${kind}]`);
    // A missing CLI cannot be chosen; a preset that names it stays selected so the reason is shown.
    input.disabled = (toolState[kind] === 'missing' && !input.checked) || working;
    text(`#new-${kind}-status`, toolLabel[toolState[kind]]);
  }
  const missing = (['codex', 'claude'] as const).filter(kind => toolState[kind] === 'missing');
  $('#provider-help').hidden = !missing.length;
  text('#provider-help-text', missing.length ? `${missing.map(kind => providerNames[kind]).join(' y ')} no ${missing.length > 1 ? 'están instalados' : 'está instalado'} en este Mac.` : '');
  $<HTMLButtonElement>('#recheck-tools').disabled = probeInFlight !== null;
  const provider = checkedProvider(), limit = sessionLimit();
  const reason = pendingLink || openingSession ? null : startBlockedReason({ connected, connecting, replaying, busy: busyAction, occupied, limit, folder: selectedDirectory, folderMissing, provider,
    tool: provider && provider !== 'terminal' ? toolState[provider] : 'available', terminalSupported });
  text('#session-capacity', capacityText(occupied, limit));
  $('#start-blocked').hidden = !reason; text('#start-blocked-text', reason?.text ?? ''); $('#reconnect-from-dialog').hidden = !reason?.reconnect;
  const startButton = $<HTMLButtonElement>('#start-session');
  startButton.hidden = !!pendingLink; startButton.disabled = !!reason || working;
  startButton.textContent = openingSession ? 'Abriendo sesión…' : 'Abrir sesión';
  startButton.setAttribute('aria-describedby', reason ? 'start-blocked-text' : 'session-capacity');
  $('#session-conflict').hidden = !claudeFolderConflict(sessions, provider, selectedDirectory);
  for (const id of ['cancel-session', 'cancel-session-x']) $<HTMLButtonElement>(`#${id}`).disabled = working;
}
function setSessionDirectory(directory: string) {
  selectedDirectory = directory; folderMissing = false; $('#folder-error').hidden = true; $('#new-session-error').hidden = true; renderFolderOptions(); refresh();
}
function closeNew() { if (busyAction) return; newDialog.close(); dialogReturn?.focus(); }
function lifecycleOf(session: Session) { return category(session.status, isRetired(session.id)); }
function continuationOf(session: Session) {
  return continuation(session, { nativeResume: runner?.nativeResumeVersion === 1 }, bindingKnown.get(session.id) ?? 'unknown');
}
/** Reads once per connection whether a closed Claude session has a registered identity (never starts anything). */
function learnBinding(session: Session) {
  if (session.kind !== 'claude' || session.transport === 'app-server' || !isClosed(session.status) || runner?.nativeResumeVersion !== 1) return;
  if (bindingKnown.has(session.id) || bindingReads.has(session.id) || !connected) return;
  const version = loopVersion; bindingReads.add(session.id);
  void request<{ binding?: unknown }>('native_binding', { id: session.id }).then(value => {
    if (version !== loopVersion || disposed) return;
    bindingKnown.set(session.id, value?.binding ? 'present' : 'none'); refresh();
  }).catch(() => { /* Unknown: the action stays offered and the runner has the last word. */ }).finally(() => bindingReads.delete(session.id));
}
/**
 * Sidebar, tabs, alerts, palette and Pulso open a session through here. A
 * Terminada opens the Historial view, never a pane (owner, 1.4.0), unless it
 * is already on screen (it ended there): then that pane takes focus.
 */
function selectSession(id: string) {
  const chosen = views.get(id)?.session; if (!chosen) return;
  const onScreen = panes.find((pane, index) => pane.id === id && (index === 0 || split));
  if (lifecycleOf(chosen) === 'ended' && !(onScreen && stageView === 'terminal')) { showHistory(id); return; }
  source.select(id, attentionSessions()); lastUsed.set(id, ++usedClock);
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
  // Dividir only brings an Abierta not shown in the other pane; with none, the pane stays empty (welcome).
  if (split && !panes[1].id) {
    const candidate = nextOpenSession([panes[0].id], false);
    if (candidate) assign(panes[1], candidate.id);
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
    options: () => sessionPickerOptions([...views.values()].map(view => view.session), i, panes.map(p => p.id), split,
      { retired: isRetired, canContinue: s => { const session = views.get(s.id)?.session; return !!session && continuationOf(session).action === 'continue'; } }),
    onSelect: id => {
      focusedPane = i;
      if (id === NEW_SESSION_OPTION) { trigger.focus({ preventScroll: true }); refresh(); openNew(); return; }
      if (id) selectSession(id); else { assign(pane, null); refresh(); trigger.focus(); }
    },
    onClose: restore => { if (!restore) return; const view = pane.id ? views.get(pane.id) : undefined; if (view && focusedPane === i) focusView(view); else trigger.focus(); },
  });
  const pane: Pane = { root, host: root.querySelector('.terminal-host')!, trigger, picker, id: null };
  panes.push(pane);
  root.addEventListener('pointerdown', () => { const consumed = pane.id ? source.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  root.addEventListener('focusin', () => { const consumed = pane.id ? source.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  const menu = root.querySelector<HTMLDetailsElement>('.pane-menu')!;
  const menuSummary = menu.querySelector<HTMLElement>('summary')!;
  // Shared dismissal rule (floating.ts): a press outside, Escape, Tab out or another floating control closes it.
  const menuFloating = { contains: (node: Node) => menu.contains(node), close: (restore: boolean) => { if (!menu.open) return; menu.open = false; if (restore) menuSummary.focus({ preventScroll: true }); } };
  // Claim on the opening click itself (the toggle event comes a task later), so a quick press elsewhere still closes it.
  menuSummary.addEventListener('click', () => { if (!menu.open) claimFloating(menuFloating); });
  menu.addEventListener('toggle', () => { if (menu.open) claimFloating(menuFloating); else releaseFloating(menuFloating); });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { event.preventDefault(); event.stopPropagation(); menuFloating.close(true); } });
  // Choosing an option closes the menu; a keyboard choice must not leave focus on the hidden option (body).
  const closeMenu = () => { const inside = menu.contains(document.activeElement); menu.open = false; if (inside) menuSummary.focus({ preventScroll: true }); };
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    const local = button.dataset.action!;
    if (['close-pane', 'copy-cwd', 'copy-id', 'new-in-folder', 'purge', 'compact'].includes(local)) {
      button.addEventListener('click', () => {
        closeMenu();
        const view = pane.id ? views.get(pane.id) : undefined; if (!view) return;
        if (local === 'close-pane') { leavePane(pane, view.session.id); return; }
        if (local === 'new-in-folder') { openNew(view.session.cwd); return; }
        if (local === 'copy-cwd' || local === 'copy-id') {
          const value = local === 'copy-cwd' ? view.session.cwd : view.session.id; if (!value) return;
          void navigator.clipboard.writeText(value).then(() => notice(local === 'copy-cwd' ? 'Carpeta copiada.' : 'Identificador copiado.'), e => notice(message(e), true));
          return;
        }
        historyAction(local === 'purge' ? 'purge_history' : 'compact_history', view.session.id);
      });
      return;
    }
    if (button.dataset.action === 'rename') {
      button.addEventListener('click', () => {
        closeMenu();
        if (pane.id) openRename(pane.id);
      });
      return;
    }
    button.addEventListener('click', () => action(async () => {
      const op = button.dataset.action!;
      closeMenu();
      if (op === 'shell') { requireSessionCapacity(); await start(`shell-${crypto.randomUUID()}`, 'shell', `Shell ${i + 1}`, pane); return; }
      const view = pane.id ? views.get(pane.id) : null;
      if (!view) throw new Error('Selecciona una sesión primero.');
      const label = button.dataset.label ?? button.textContent?.trim() ?? op;
      if (op === 'stop') { openStopConfirmation(view); return; }
      if (op === 'release') {
        const released = await invoke<boolean>('release_session', { id: view.session.id });
        updateStatus(await request<RunnerStatus>('status', {}));
        notice(released ? 'Plaza liberada por confirmación explícita. El historial se conserva; no se señaló ningún proceso.' : 'Liberación cancelada.');
        return;
      }
      if (!isLive(view.session)) throw new Error('Esta sesión terminó. Pulsa Continuar conversación o Empezar de nuevo aquí.');
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
      notice(op === 'interrupt' ? `Ctrl-C enviado a ${view.session.title}. La sesión sigue abierta.` : `${label} enviado a ${view.session.title}.`);
      focusView(view);
    }));
  });
  new ResizeObserver(() => { if (pane.id) scheduleResize(views.get(pane.id)!); }).observe(pane.host);
  root.querySelectorAll<HTMLButtonElement>('[data-recovery]').forEach(button => button.addEventListener('click', () => {
    const view = pane.id ? views.get(pane.id) : undefined; if (!view) return;
    const id = view.session.id;
    switch (button.dataset.recovery) {
      case 'primary': focusedPane = i; recoverHere(view.session, pane); return;
      case 'output': recoveryFolded.add(id); refresh(); root.querySelector<HTMLButtonElement>('[data-recovery="primary"]')?.focus({ preventScroll: true }); return;
      case 'expand': recoveryFolded.delete(id); refresh(); root.querySelector<HTMLButtonElement>('[data-recovery="primary"]')?.focus({ preventScroll: true }); return;
      case 'dismiss': focusedPane = i; dismissSession(id); return;
    }
  }));
}
/** The primary recovery action: continue the conversation, or a new session prefilled in the same pane. */
function recoverHere(session: Session, pane: Pane) {
  if (continuationOf(session).action === 'continue') { void action(async () => { await continueConversation(session.id, pane); }); return; }
  focusedPane = panes.indexOf(pane);
  openNew(session.cwd, { kind: session.kind, title: session.title });
}
/**
 * Continuar conversación (1.4.0): the one path for the pane, the Historial
 * view, the sidebar, the palette and Pulso. Checks the slot, puts the new
 * session in the same pane and marks the original as continued (Terminada).
 * Claude: `resume_native` (a new session, `--resume`, no text). Structured
 * Codex: `codex_resume` (same id). Nothing is pasted or sent to the PTY. The
 * new session inherits the original's Pulso project/phase links (notice).
 */
async function continueConversation(id: string, target?: Pane): Promise<string> {
  const original = views.get(id)?.session;
  if (!original) throw new Error('La sesión no está disponible en este perfil.');
  if (!connected || connecting) throw new Error('Sin conexión con el runner.');
  const pane = target ?? panes.find((p, index) => p.id === id && (index === 0 || split)) ?? panes[focusedPane];
  const check = workspaceContext();
  if (original.transport === 'app-server') {
    if (!isClosed(original.status)) { presentSession(original, pane); return id; }
    requireSessionCapacity();
    await request('codex_resume', { id, generation: original.codex?.generation }); check();
    updateStatus(await request<RunnerStatus>('status', {})); check();
    presentSession(views.get(id)!.session, pane);
    announce(`Continuando ${original.title}…`);
    return id;
  }
  if (original.kind !== 'claude') throw new Error('Esta sesión no permite continuar la conversación. Usa Empezar de nuevo aquí.');
  if (runner?.nativeResumeVersion !== 1) throw new Error('Este runner no permite continuar conversaciones. Reinícialo cuando no tengas trabajo en curso.');
  const native = await request<{ binding?: unknown; activeSessionId?: string | null }>('native_binding', { id }); check();
  bindingKnown.set(id, native.binding ? 'present' : 'none');
  if (native.activeSessionId) {
    const active = views.get(native.activeSessionId);
    if (active && isLive(active.session)) { presentSession(active.session, pane); if (dismissed.get(id) !== active.session.id) awaitConfirmation(id, active.session.id, original.title); return active.session.id; }
    throw new Error('La conversación ya tiene una sesión activa o sin confirmar. Revisa su estado antes de continuar.');
  }
  if (!native.binding) { refresh(); throw new Error('No se registró la identidad de esta conversación. Usa Empezar de nuevo aquí.'); }
  if (!resumeAttempts.has(id)) requireSessionCapacity();
  const next = resumeAttempts.get(id) ?? `claude-${crypto.randomUUID()}`; resumeAttempts.set(id, next);
  const session = await request<Session>('resume_native', { id: next, sourceId: id, rows: 24, cols: 80 }); check();
  // The attempt id is spent either way: a retry must be a new request, never the same (failed) row.
  resumeAttempts.delete(id);
  if (!isLive(session)) {
    ensure(session); refresh();
    throw new Error(`La continuación de ${original.title} no llegó a arrancar. La original sigue en Interrumpidas; reintenta o usa Empezar de nuevo aquí.`);
  }
  presentSession(session, pane);
  awaitConfirmation(id, session.id, original.title);
  announce(`Continuando ${original.title} en una sesión nueva…`);
  return session.id;
}
/*
 * A continuation counts only when it works (1.4.0): the original is marked
 * continued (it leaves Interrumpidas) and its Pulso links are inherited once
 * consecutive `status` reads see the new session `running` for at least
 * CONTINUATION_SETTLE_MS: two reads in quick succession are not enough, and
 * a read that omits the session restarts the wait. If it is seen closed,
 * Sin confirmar or failed before that, nothing is marked or linked and the
 * person is told; the original stays.
 */
const CONTINUATION_SETTLE_MS = 1000;
const pendingContinuations = new Map<string, { from: string; title: string; runningSince: number | null }>();
function awaitConfirmation(from: string, next: string, title: string) { pendingContinuations.set(next, { from, title, runningSince: null }); }
function confirmContinuations(status: RunnerStatus) {
  const now = performance.now();
  for (const [next, pending] of [...pendingContinuations]) {
    const session = status.sessions.find(s => s.id === next);
    if (!session) { pending.runningSince = null; continue; }
    if (session.status === 'running') {
      if (pending.runningSince === null) { pending.runningSince = now; continue; }
      if (now - pending.runningSince < CONTINUATION_SETTLE_MS) continue;
      pendingContinuations.delete(next); markContinued(pending.from, next); void inheritPulsoLinks(pending.from, next);
    } else if (session.status === 'starting') pending.runningSince = null;
    else {
      pendingContinuations.delete(next);
      notice(`La continuación de ${pending.title} terminó al arrancar. La original sigue en Interrumpidas; revisa su salida o usa Empezar de nuevo aquí.`, true);
    }
  }
}
function rememberDismissed(next: DismissedSessions) {
  dismissed = next;
  try { saveDismissed(localStorage, profileDataDir, dismissed); } catch { /* Optional view metadata: it holds for this window. */ }
}
function markContinued(id: string, successor: string) { if (dismissed.get(id) !== successor) rememberDismissed(withDismissed(dismissed, id, successor)); refresh(); }
/** Descartar: the Interrumpida becomes Terminada (Historial). View metadata only; nothing is deleted. */
function dismissSession(id: string, afterFocus?: () => void) {
  const session = views.get(id)?.session; if (!session || category(session.status) !== 'interrupted') return;
  rememberDismissed(withDismissed(dismissed, id));
  // Discarding is the person's decision about it: its alerts (runner ones included) are seen.
  source.select(id, attentionSessions());
  recoveryFolded.delete(id);
  const shown = panes.find((pane, index) => pane.id === id && (index === 0 || split));
  if (shown) leavePane(shown, id); else refresh();
  afterFocus?.();
  notice(`${session.title} pasó a Terminadas. Sigue en Historial; no se borró nada.`);
}
type PulsoSummary = { projects?: { id: string; title: string; mainSessionId: string | null }[]; hasMore?: boolean; links?: { projectId?: string | null; sessionId: string; via?: 'project' | 'item' }[]; linksTruncated?: boolean };
type PulsoBoard = { columns?: Record<string, { items?: { id: string; session?: { id: string } | null }[] }> };
/**
 * Owner decision (1.4.0): the continuation inherits the original's Pulso
 * links, with a visible notice. Only existing operations: `sidebar_summary`
 * finds the projects whose main session or links name the original; for a
 * phase link, the project `board` card footers say which phase. Each link is
 * written with the same request id Pulso uses for its own resume link, so
 * both are idempotent. A phase off the first board page cannot be found: the
 * notice says so. Nothing is pasted or sent to the session.
 */
async function inheritPulsoLinks(from: string, to: string) {
  if (!pulsoReadable()) return;
  try {
    if (runner?.pulsoSummaryVersion !== 1) { notice('Conversación continuada. Este runner no permite comprobar sus vínculos con Pulso; si la original estaba vinculada, vincula la nueva desde Pulso.'); return; }
    const summary = await requestPulso('sidebar_summary', {}) as PulsoSummary;
    const projects = new Map((summary.projects ?? []).map(project => [project.id, project.title]));
    const projectLinks = new Set<string>(), phaseProjects = new Set<string>();
    for (const project of summary.projects ?? []) if (project.mainSessionId === from) projectLinks.add(project.id);
    for (const link of summary.links ?? []) if (link.sessionId === from && link.projectId) (link.via === 'item' ? phaseProjects : projectLinks).add(link.projectId);
    // sidebar_summary lists the first projects only (hasMore) and may cut the links: say what was not checked.
    const partial = !!summary.hasMore || !!summary.linksTruncated;
    if (!projectLinks.size && !phaseProjects.size) {
      if (partial) notice('Conversación continuada. No se pudo comprobar el vínculo de Pulso en todos los proyectos; vincúlala a mano si hace falta.');
      return;
    }
    const linked: string[] = [], missing: string[] = [], failed: string[] = [];
    const name = (projectId: string) => `«${projects.get(projectId) ?? projectId}»`;
    const link = async (args: Record<string, string>, label: string) => {
      try { await requestPulso('link', args); return true; } catch { failed.push(label); return false; }
    };
    for (const projectId of projectLinks) if (await link({ projectId, sessionId: to, requestId: `resume-link-${to}-project-${projectId}` }, name(projectId))) linked.push(name(projectId));
    for (const projectId of phaseProjects) {
      let phases: { id: string }[] = [];
      try {
        const board = runner?.pulsoBoardCardsVersion === 1 ? await requestPulso('board', { projectId }) as PulsoBoard : null;
        phases = Object.values(board?.columns ?? {}).flatMap(column => column.items ?? []).filter(item => item.session?.id === from);
      } catch { /* Counted as not found below. */ }
      if (!phases.length) { missing.push(name(projectId)); continue; }
      let done = 0;
      for (const phase of phases) if (await link({ itemId: phase.id, sessionId: to, requestId: `resume-link-${to}-item-${phase.id}` }, `una fase de ${name(projectId)}`)) done++;
      if (done) linked.push(`${done === 1 ? 'una fase' : `${done} fases`} de ${name(projectId)}`);
    }
    loadSidebarProjects();
    const problems = failed.length || missing.length;
    notice([linked.length ? `Conversación continuada y vinculada en Pulso como la original: ${linked.join(', ')}.` : 'Conversación continuada.',
      failed.length ? `No se pudo vincular a ${failed.join(', ')}; hazlo desde Pulso.` : '',
      missing.length ? `No se encontró su fase en ${missing.join(', ')}; vincúlala desde Pulso.` : '',
      partial ? 'No se pudo comprobar el vínculo de Pulso en todos los proyectos; vincúlala a mano si hace falta.' : ''].filter(Boolean).join(' '), problems ? true : false);
  } catch (e) {
    notice(`La conversación continúa en la sesión nueva, pero no se pudo heredar su vínculo con Pulso: ${message(e)} Vincúlala desde Pulso.`, true);
  }
}
/** Terminar sesión always asks first (pane menu and command palette). */
function openStopConfirmation(view: View) {
  if (stopFlights.has(view.session.id)) return;
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
function syncNotice() {
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
/**
 * The floating notice (bottom right, absolute: never part of a terminal's layout).
 * - info: a short confirmation; leaves on its own after 5 s (later while the pointer or focus is on it).
 * - progress: announces a condition; the code that ends the condition hides it.
 * - error (`true`): stays until the person closes it (button or Escape) or the cause is resolved.
 * A new message replaces the previous one; messages never stack. Every text is
 * also announced by the polite live region of the notice; nothing takes focus.
 */
type NoticeKind = 'info' | 'progress' | 'error';
const noticeTransientMs = 5000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notice(message: string, kind: boolean | NoticeKind = false) {
  const level: NoticeKind = kind === true ? 'error' : kind === false ? 'info' : kind;
  const node = $('#notice'); node.dataset.persistent = 'false'; node.dataset.kind = level;
  text('#notice-text', message); node.hidden = false; node.classList.toggle('error', level === 'error');
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  noticeTimer = undefined;
  if (level === 'info') {
    const expire = () => {
      noticeTimer = undefined;
      if (node.hidden || node.dataset.kind !== 'info' || $('#notice-text').textContent !== message) return;
      if (node.matches(':hover') || node.contains(document.activeElement)) { noticeTimer = setTimeout(expire, 1500); return; }
      node.hidden = true; syncNotice();
    };
    noticeTimer = setTimeout(expire, noticeTransientMs);
  }
  syncNotice();
}
/**
 * Replay caught up, by whichever path: controls come back and its progress notice goes. The notice has
 * no timer of its own, so every exit from replay must pass through here or it stays on screen.
 */
function endReplay() {
  if (!replaying) return;
  replaying = false; refresh();
  if ($('#notice').dataset.kind === 'progress' && $('#notice-text').textContent?.startsWith('Conectado. Recuperando')) dismissNotice();
}
function dismissNotice() { if (noticeTimer !== undefined) clearTimeout(noticeTimer); noticeTimer = undefined; $('#notice').hidden = true; syncNotice(); }
/** Polite announcement without any visible element (session start, ending). */
function announce(value: string) { text('#app-announcer', value); }
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
async function request<T = unknown>(op: string, args: object): Promise<T> {
  const response = await invoke<{ ok: boolean; result: T; error?: string }>('runner_request', { op, args });
  if (!response.ok) throw new Error(response.error ?? 'El runner rechazó la operación.');
  return response.result;
}
function isLive(session: Session) { return isLiveStatus(session.status); }
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
  else if ($('#telemetry-summary').textContent === 'Recursos sin conexión') text('#telemetry-summary','Jauría · CPU — · RAM —');
  text('#connection-state', connecting ? 'Conectando…' : connected ? 'Conectado' : 'Sin conexión');
  $('#connection-dot').dataset.state = connected ? 'running' : 'failed';
  // Acerca de y diagnóstico (Configuración): the runner version next to the app's, and what to do when they differ.
  text('#runner-state', runner ? `Servicio de sesiones (runner): ${runner.runnerVersion ?? 'versión anterior a 1.1, sin número'}${connected ? '' : ' · sin conexión'} · ${runner.sessions.length} ${runner.sessions.length === 1 ? 'sesión' : 'sesiones'} en este perfil` : 'Servicio de sesiones (runner): sin conexión');
  const capabilities=runner as RunnerStatus & {telemetryVersion?:number;codexVersion?:number;terminalSessionVersion?:number};
  const olderCapabilities = !(capabilities?.telemetryVersion === 1 && capabilities?.codexVersion===1 && capabilities?.terminalSessionVersion===1 && runner?.normalTerminalVersion===1 && runner?.claudeNativeConfigVersion===1 && runner?.terminalStreamVersion===1 && runner?.nativePermissionsVersion===1 && runner?.settingsVersion===2 && runner?.sessionRenameVersion===1);
  const versionMismatch = !!runner && runner.runnerVersion !== appVersion;
  const upgrade = document.querySelector<HTMLElement>('#runner-upgrade'); if (upgrade) upgrade.hidden = !connected || (!versionMismatch && !olderCapabilities);
  text('#runner-upgrade', versionMismatch
    ? `Las versiones no coinciden: la app es ${appVersion} y el servicio de sesiones es ${runner?.runnerVersion ?? 'anterior'}. Tus sesiones siguen funcionando, pero las funciones nuevas necesitan reiniciarlo: termina el trabajo en curso y pulsa Reiniciar runner….`
    : 'El servicio de sesiones es de una versión anterior. Para activar las funciones nuevas, reinícialo cuando puedas detener todo el trabajo del perfil.');
  const restart = document.querySelector<HTMLButtonElement>('#restart-runner'); if (restart) restart.disabled = !connected || busyAction;
  if ($('#workbench').dataset.renderedSeq !== String(renderedSeq)) $('#workbench').dataset.renderedSeq = String(renderedSeq);
  const retained=runner?.retention;
  const usage = historyUsage(retained);
  const level = usage >= .95 ? 95 : usage >= .8 ? 80 : 0;
  const historyWarnings = [...views.values()].filter(view => !isLocalHistoryLimit(streamMetadata(view.session)?.history) && ['limited','error','incomplete','unknown_tail'].includes(streamMetadata(view.session)?.history.state ?? '')).length;
  text('#storage-usage',retained?`Historial guardado: ${formatTelemetryBytes(retained.outputEncodedBytes)} · ${retained.eventRows} eventos${retained.atCapacity?' · límite de guardado local alcanzado':level ? ` · uso ${level}%` : ''}${historyWarnings ? ` · ${historyWarnings} con historial limitado o sin guardar` : ''}. La cuota no representa espacio físico en disco.`:'Cuota de historial sin consultar.');
  $<HTMLButtonElement>('#connect').disabled = connecting || busyAction;
  const sessions = attentionSessions();
  // Every visible pane (both when split). Viewing consumes transient activity even when no new
  // focus event occurs (for example, a process on screen exits). Persistent causes stay.
  const attended = attendedSessions();
  for (const id of attended) source.consumeActivity(id);
  source.paint(attended);
  const alerts = source.list(sessions);
  // Runner hasMore: sessions with pending alerts that status did not list.
  const hidden = source.hiddenUnseen();
  const unread = alerts.filter(item => item.unseen && !item.stale && !isAttended(item.id));
  dockBadge.setCount(connected && !replaying ? dockUnreadCount(unread) + hidden : 0);
  const alertById = new Map(alerts.map(item => [item.id, item]));
  const activityById = new Map(sessions.map(s => [s.id, source.activity(s, alertById.get(s.id))]));
  currentActivity = activityById;
  const unseen = unread.length + hidden, total = alerts.length + hidden;
  // Abiertas (open/activity) never list an Interrumpida among the agents: it has its own section on top.
  const interruptedNow = (s: Session) => lifecycleOf(s) === 'interrupted';
  const matches = (s: Session, f: SessionFilter, q: string) => f === 'attention'
    ? alertById.has(s.id) && matchesSession(s, 'all', q)
    : f === 'activity' ? (isLive(s) || alertById.has(s.id) || lifecycleOf(s) === 'unconfirmed') && !interruptedNow(s) && matchesSession(s, 'all', q)
    : matchesSession(s, f, q, isRetired(s.id));
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
  if (!total && alertsPopover.isOpen) {
    // The bell is already hidden: focus inside the popover goes to the terminal or the palette button, never body.
    const inside = document.activeElement instanceof HTMLElement && $('#attention-banner').contains(document.activeElement);
    alertsPopover.close(false);
    if (inside) restoreWorkbenchFocus();
  }
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
  const quiet = quietLabel(total, counts, hidden);
  $('#status-quiet').hidden = quiet === null; text('#status-quiet', quiet ?? '');
  syncNotice();
  nativeAttention.update(source.nativeItems(alerts));
  document.title = unseen ? `(${unseen}) Avisos · Jauría` : 'Jauría';
  const open = count('open');
  const occupied=sessions.filter(s=>!isClosed(s.status)).length;
  if (filter === 'attention' && count('attention') === 0) filter = openFilter();
  text('#capacity', `${occupied} de ${sessionLimit()} plazas`);
  $('#capacity').title = `${occupied} de ${sessionLimit()} plazas ocupadas`;
  text('#open-count', String(open + sessions.filter(interruptedNow).length)); text('#closed-count', String(count('closed')));
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
  const newSessionBlocked = newSessionUnavailable({ connected, busy: busyAction, replaying, occupied, limit: sessionLimit() }) !== null;
  syncHistoryView(newSessionBlocked);
  const reading = stageView === 'history';
  for (const id of ['new-session', 'welcome-create', 'tab-new-session']) $<HTMLButtonElement>(`#${id}`).disabled = newSessionBlocked;
  syncNewSessionDialog(occupied, sessions);
  for (const pane of panes) {
    const index = panes.indexOf(pane);
    const view = pane.id ? views.get(pane.id) : null;
    pane.root.hidden = pane === panes[1] && !split;
    pane.root.classList.toggle('is-focused', index === focusedPane);
    pane.trigger.dataset.sessionId = pane.id ?? '';
    const activity = view && (isLive(view.session) || alertById.has(view.session.id)) ? activityById.get(view.session.id) : undefined;
    paintPaneHeader(pane.root, {
      paneIndex: index, kind: view?.session.kind ?? null, title: view?.session.title ?? null, cwd: view?.session.cwd ?? null,
      state: view ? (stopUncertain.has(view.session.id) && !finalStatus(view.session.status) ? 'No se pudo confirmar el cierre' : stopping.has(view.session.id) && isLive(view.session) ? 'Terminando…' : isLive(view.session) && programLabel(view.session.id) ? programLabel(view.session.id) : statusLabel(view.session.status)) + (historySuffix(view) ? ` · ${historySuffix(view)}` : '') : 'Sin sesión',
      stateKey: view && isLive(view.session) ? source.display(view.session.id) ?? 'unreported' : view?.session.status ?? '',
      activity: activity?.kind ?? null, activityLabel: activity?.label ?? '',
      history: !view || isLive(view.session) ? '' : category(view.session.status) === 'ended' ? 'Terminada · solo lectura' : 'Entrada deshabilitada',
      meta: view ? `${providerLabel(view.session.kind)} · ${statusLabel(view.session.status)}${view.session.transport === 'app-server' ? '' : ` · ${view.term.cols} × ${view.term.rows}`} · ${view.session.id}` : '',
      note: view && isLocalHistoryLimit(streamMetadata(view.session)?.history)
        ? `Historial local parcial. ${isLive(view.session) ? 'La sesión continúa normalmente. Se alcanzó el límite de guardado local; la salida nueva no se añade al historial de Jauría.' : 'Este límite solo afecta a la salida guardada por Jauría.'} No limita el uso ni afecta la cuota del proveedor.` : '',
    });
    pane.picker.refresh();
    paintRecovery(pane, view ?? null);
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
      if (kind === 'close-pane') { button.hidden = !view || isLive(view.session) || view.session.status === 'needs_attention'; button.disabled = false; return; }
      if (kind === 'copy-cwd') { button.disabled = !view?.session.cwd; return; }
      if (kind === 'copy-id') { button.disabled = !view; return; }
      if (kind === 'new-in-folder') { button.disabled = !view?.session.cwd || !connected || busyAction || occupied >= sessionLimit() || replaying; return; }
      if (kind === 'purge' || kind === 'compact') { button.hidden = !view || !finalStatus(view.session.status); button.disabled = !connected || busyAction || replaying; return; }
      button.disabled = !connected || connecting || busyAction || replaying || (kind === 'shell' && occupied >= sessionLimit()) || (kind !== 'shell' && (!view || !isLive(view.session) || stopping.has(view.session.id))) || (kind === 'stop' && !!view && stopFlights.has(view.session.id)) || (['ping', 'size', 'flood'].includes(kind) && view?.session.kind !== 'fixture');
    });
  }
  const focusedView = activeView();
  text('#terminal-size', focusedView?.session.transport === 'app-server' ? 'Conversación' : focusedView ? `${focusedView.term.cols} × ${focusedView.term.rows}` : '—');
  for(const view of views.values())view.chat?.select(connected && !replaying && ((stageView==='terminal' && panes.some((pane,index)=>pane.id===view.session.id && (index===0||split))) || (reading && historyId===view.session.id))?view.session:null);
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
  text('#workspace-title', reading ? `Historial · ${historyView()?.session.title ?? ''}` : current?.title ?? 'Tu espacio de trabajo');
  text('#workspace-breadcrumb', current?.cwd?.split('/').filter(Boolean).pop() ?? (current ? providerLabel(current.kind) : 'Sesiones locales'));
  $('#workspace-breadcrumb').hidden = planning;
  if (planning) text('#workspace-title', 'Pulso');
  // Most recent first everywhere (the runner lists oldest first and gives no dates).
  const visibleSessions = orderRecent(sessions.filter(s => matches(s, filter, query)));
  const abiertas = filter === 'open' || filter === 'activity';
  const interruptedRows = abiertas ? orderRecent(sessions.filter(s => interruptedNow(s) && matchesSession(s, 'all', query))) : [];
  const navigation = $('.workspace-navigation');
  navigation.dataset.sessionView = filter === 'activity' || filter === 'attention' ? 'priority' : 'projects';
  navigation.dataset.filter = filter;
  const kindOf = (id: string) => activityById.get(id)?.kind ?? 'unreported';
  const summary = sidebarProjects.snapshot;
  // Attention and Por estado reuse the activity sections; Abiertas/Historial
  // Por proyecto use the Pulso main session and project links known locally.
  // Historial por proyecto keeps plain recency inside each project (no priority: they all ended).
  const groups = filter === 'activity' || filter === 'attention'
    ? groupAgents(visibleSessions, 'state', kindOf)
    : groupAgents(visibleSessions, grouping, filter === 'closed' && grouping === 'project' ? () => 'unreported' : kindOf, summary.projects, projectSessionIndex(summary.projects, summary.links));
  $('#session-list').setAttribute('aria-label', filter === 'attention' ? 'Sesiones con avisos' : filter === 'activity' ? 'Agentes por estado' : filter === 'closed' ? (grouping === 'state' ? 'Historial por estado' : 'Historial por proyecto') : 'Agentes por proyecto');
  // Keep the button itself mounted while status, output metadata or attention
  // changes. Replacing it between pointer down and up loses the user's click.
  const key = JSON.stringify([filter, query, summary.linksTruncated, interruptedRows.map(s => s.id), groups.map(group => [group.key, group.name, group.sessions.map(s => s.id)])]);
  if (sidebarKey !== key) {
    sidebarKey = key;
    const list = $('#session-list');
    const focusedSession = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('.session-item')?.dataset.sessionId ?? null : null;
    list.replaceChildren();
    if (interruptedRows.length) list.append(interruptedSection(interruptedRows));
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
    const selected = (stageView === 'terminal' && s.id === current?.id) || (reading && s.id === historyId);
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
/**
 * The recovery overlay of an Interrumpida shown in a pane (plan C.4). It floats
 * over the terminal (absolute), so showing, folding or hiding it never changes
 * the terminal's size. «Ver salida» folds it to a bar; «Opciones…» unfolds it.
 */
function paintRecovery(pane: Pane, view: View | null) {
  const box = pane.root.querySelector<HTMLElement>('.pane-recovery')!;
  const session = view?.session;
  const show = !!session && lifecycleOf(session) === 'interrupted';
  if (box.hidden !== !show) box.hidden = !show;
  if (!show) return;
  learnBinding(session);
  const plan = continuationOf(session); const folded = recoveryFolded.has(session.id);
  const set = (selector: string, value: string) => { const node = box.querySelector(selector)!; if (node.textContent !== value) node.textContent = value; };
  if (box.dataset.folded !== String(folded)) box.dataset.folded = String(folded);
  set('.pane-recovery-title', `${session.title} · Interrumpida`);
  set('.pane-recovery-detail', `${interruptionDetail(session.status, session.detail)}. No puedes escribir en ella.`);
  set('.pane-recovery-note', plan.note);
  const primary = box.querySelector<HTMLButtonElement>('[data-recovery="primary"]')!;
  set('[data-recovery="primary"]', plan.action === 'continue' ? 'Continuar conversación' : 'Empezar de nuevo aquí');
  const help = plan.action === 'continue' ? `${plan.note} Nada se escribe en la sesión.` : 'Abre Nueva sesión con la misma carpeta, herramienta y nombre; tú confirmas.';
  if (primary.title !== help) primary.title = help;
  primary.disabled = !connected || connecting || busyAction || replaying;
  box.querySelector<HTMLButtonElement>('[data-recovery="output"]')!.hidden = folded;
  box.querySelector<HTMLButtonElement>('[data-recovery="expand"]')!.hidden = !folded;
  box.querySelector<HTMLButtonElement>('[data-recovery="dismiss"]')!.disabled = busyAction;
}
/** «Interrumpidas» inside Abiertas: rows open the session (with its recovery) and offer Descartar. */
function interruptedSection(rows: readonly Session[]) {
  const section = document.createElement('section'); section.className = 'session-group session-group-interrupted'; section.dataset.lifecycle = 'interrupted';
  const heading = document.createElement('div'); heading.className = 'group-heading';
  heading.title = 'Terminaron sin que lo pidieras: continúalas, empieza de nuevo o descártalas.';
  const marker = document.createElement('span'); marker.className = 'activity-group-marker'; marker.dataset.activity = 'needs'; marker.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span'); name.textContent = 'Interrumpidas';
  const count = document.createElement('span'); count.className = 'activity-group-count'; count.textContent = String(rows.length);
  heading.append(marker, name, count); section.append(heading);
  section.setAttribute('aria-label', `Interrumpidas: ${rows.length}`);
  for (const s of rows) {
    const row = document.createElement('div'); row.className = 'session-row';
    const button = document.createElement('button'); button.className = 'session-item'; button.dataset.sessionId = s.id;
    button.innerHTML = `<span class="provider-badge" aria-hidden="true"></span><span class="session-item-title"></span><span class="session-item-duration"></span><span class="session-item-state"><span class="agent-indicator" aria-hidden="true"></span><span class="session-item-state-label sr-only"></span></span><span class="session-item-meta sr-only"></span>`;
    button.addEventListener('click', () => selectSession(s.id));
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'quiet session-dismiss'; dismiss.dataset.sessionId = s.id;
    dismiss.textContent = 'Descartar'; dismiss.setAttribute('aria-label', `Descartar ${s.title}`); dismiss.title = 'La pasa a Terminadas; no borra nada';
    dismiss.addEventListener('click', () => dismissFromSidebar(s.id));
    row.append(button, dismiss); section.append(row);
  }
  return section;
}
/** After Descartar in the sidebar, focus stays in the list: the next row's Descartar, else the Abiertas tab. */
function dismissFromSidebar(id: string) {
  const ids = Array.from(document.querySelectorAll<HTMLElement>('#session-list .session-dismiss')).map(node => node.dataset.sessionId!);
  const position = ids.indexOf(id); const neighbour = ids[position + 1] ?? ids[position - 1];
  dismissSession(id, () => {
    const next = neighbour ? Array.from(document.querySelectorAll<HTMLElement>('#session-list .session-dismiss')).find(node => node.dataset.sessionId === neighbour) : null;
    (next ?? $('button[data-filter="open"]')).focus({ preventScroll: true });
  });
}
function focusView(view:View|undefined|null){if(!view)return;
  // An Interrumpida takes no input: its recovery action gets the keyboard instead of a dead terminal.
  const shown=panes.find((pane,index)=>pane.id===view.session.id&&(index===0||split));
  const recovery=shown?.root.querySelector<HTMLButtonElement>('.pane-recovery:not([hidden]) [data-recovery="primary"]');
  if(recovery&&!recovery.disabled){recovery.focus({preventScroll:true});return;}if(view.session.transport==='app-server')view.host.querySelector<HTMLTextAreaElement>('textarea')?.focus();else view.term.focus();}
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
  const term = new Terminal({ allowProposedApi: true, screenReaderMode: false, convertEol: false, scrollback: 8000, rows: session.rows || 24, cols: session.cols || 80, fontSize: terminalFont, ...terminalTypography, cursorBlink: true, theme: terminalTheme });
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
  confirmContinuations(status);
  if ((source = status.agentAttentionVersion === 1 ? runnerAttention : windowAttention) === runnerAttention) runnerAttention.ingestStatus(status);
  for (const session of status.sessions) { const metadata = streamMetadata(session); const existing = views.get(session.id); if (existing?.stream && metadata && existing.stream.generation !== metadata.generation) throw new Error('Terminal generation changed'); const previous = views.get(session.id)?.session.status; if (!replaying && !streamReplaying(existing) && previous && session.transport !== 'app-server') source.observeEnd(session.id, previous, session.status); ensure(session);if(!isLive(session)){stopping.delete(session.id);windowAttention.forget(session.id);}if(finalStatus(session.status))stopUncertain.delete(session.id);}
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
function occupiedSessions() { return [...views.values()].filter(v => !isClosed(v.session.status)).length; }
function sessionLimit() { return runner?.settingsVersion === 1 || runner?.settingsVersion === 2 ? runner.settings?.maxConcurrentSessions ?? 2 : 2; }
function requireSessionCapacity() {
  if (occupiedSessions() >= sessionLimit()) throw new Error(`Se alcanzó el límite de ${sessionLimit()} sesiones simultáneas. Ajústalo en Configuración o termina una sesión.`);
}
async function start(id: string, kind: string, title: string, pane: Pane, cwd?: string) {
  requireSessionCapacity();
  const session = await request<Session>('start', { id, kind, title, rows: 24, cols: 80, ...(cwd ? { cwd } : {}) });
  presentSession(session, pane);
  // The pane heading already says «Abriendo» until the runner reports it running: no floating notice.
  announce(`Abriendo ${title}…`);
  return session.id;
}
function presentSession(session: Session, pane: Pane) {
  stageView = 'terminal';
  const id = session.id;
  const view = ensure(session);
  const other = panes.find(p => p !== pane && p.id === id);
  if (other) assign(other, null);
  assign(pane, id); focusedPane = panes.indexOf(pane); lastUsed.set(id, ++usedClock);
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
        endReplay();
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
        if (replaying && event.seq > replayThrough) { await flushWrites(); endReplay(); }
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
          endReplay();
        }
      }
      await flushWrites();
      if (version !== loopVersion) return;
      // xterm callbacks confirm buffer consumption. Never await a display frame:
      // WebKit suspends requestAnimationFrame for an occluded desktop window.
      if (version !== loopVersion) return;
      renderedSeq = pageSeq;
      // Processed-event cursor for test harnesses only (no visible text since Información was retired).
      if (page.events.length) $('#workbench').dataset.renderedSeq = String(renderedSeq);
      if (smoke) {
        streamMetrics.pages++;streamMetrics.lastTransferMs=transferred-pageStarted;streamMetrics.lastParseMs=performance.now()-transferred;
        streamMetrics.lastPageMs=performance.now()-pageStarted;streamMetrics.maxParseMs=Math.max(streamMetrics.maxParseMs,streamMetrics.lastParseMs);
        streamMetrics.visibility=document.visibilityState;streamMetrics.pageBytes=page.events.reduce((sum,event)=>sum+event.data.length,0);
      }
      // A page can end on a stream checkpoint (which skips the per-event check) or bring nothing new.
      if (replaying && pageSeq >= replayThrough) endReplay();
      if (!polledNative && !replaying && runner?.terminalStreamVersion === 1) nativeMore = await pollNative(version);
      if (version !== loopVersion) return;
      if (!page.hasMore && page.events.length) for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
      // Status/state transitions refresh the shell above. Output only changes
      // xterm and the event counter; rebuilding chrome every 12ms adds latency.
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
    views.clear();windowAttention.reset();runnerAttention.reset();source=windowAttention;programSeen.clear();if(programRefresh!==undefined){clearTimeout(programRefresh);programRefresh=undefined;} stopping.clear(); stopFlights.clear(); stopUncertain.clear(); bindingKnown.clear(); bindingReads.clear(); archiveUnavailable = false; archivePollAt = 0; archiveHasMore = false; announcedAlerts = new Set(); sidebarKey = ''; renderedSeq = 0; runner = null; statusAt = 0;
    const config = await invoke<{ dataDir: string; socket: string; status: RunnerStatus; smoke: boolean }>('connect_runner');
    smoke = config.smoke; connected = true;
    replayThrough = config.status.lastSeq;
    replaying = replayThrough > 0;
    profileDataDir = config.dataDir;
    if (groupingProfile !== profileDataDir) {
      groupingProfile = profileDataDir; sidebarProjects.reset(); sidebarAsked = null; sidebarRetryAt = 0; projectListKey = '';
      try { grouping = readAgentGrouping(localStorage, profileDataDir); } catch { grouping = 'project'; }
      try { dismissed = readDismissed(localStorage, profileDataDir); } catch { dismissed = new Map(); }
      // Seen interruptions per profile: one that happened while Jauría was closed is a new alert.
      { const profile = profileDataDir; let seenIncidents: Map<string, string> | null = null; try { seenIncidents = readSeenIncidents(localStorage, profile); } catch { /* unreadable: quiet baseline */ }
        attention.restoreIncidents(seenIncidents, incidents => { try { saveSeenIncidents(localStorage, profile, incidents); } catch { /* holds for this window */ } }); }
      // Per-profile view preferences, applied before any terminal is fitted.
      try { layout = readSidebarLayout(localStorage, profileDataDir); } catch { layout = { ...defaultSidebarLayout }; }
      applySidebarLayout();
      let font: number = terminalFontSize.default; try { font = readTerminalFont(localStorage, profileDataDir); } catch { /* default */ }
      setTerminalFont(font, false);
      if (filter === 'open' || filter === 'activity') filter = openFilter();
    }
    updateStatus(config.status);
    if (previousSelection.some(Boolean)) {
      for (const pane of panes) assign(pane, null);
      previousSelection.forEach((id, i) => { if (id && views.has(id)) assign(panes[i], id); });
    }
    if (!split) assign(panes[1], null);
    // A pane opens with the first Abierta (as before 1.4.0), else the most recent Interrumpida (with its
    // recovery); never a Terminada: with neither, the welcome view.
    if (!panes.some(pane => pane.id) && views.size) {
      const sessions = [...views.values()].map(v => v.session);
      const preferred = sessions.find(s => isLive(s)) ?? orderRecent(sessions).find(s => lifecycleOf(s) === 'interrupted');
      if (preferred) { assign(panes[0], preferred.id); if (filter !== 'open' && filter !== 'activity') filter = openFilter(); }
    }
    if (!split) assign(panes[1], null);
    $('#notice').hidden = replayThrough === 0; syncNotice();
    for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
    if (replaying) notice('Conectado. Recuperando historial…', 'progress');
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
$('#session-folder').addEventListener('change', () => setSessionDirectory($<HTMLSelectElement>('#session-folder').value));
$('#session-project').addEventListener('change', () => { $('#session-project-error').hidden = true; });
$('#recheck-tools').addEventListener('click', () => void probeTools(true));
$('#reconnect-from-dialog').addEventListener('click', () => void connect());
newDialog.addEventListener('close', () => {
  newDialogVersion++; projectSessionTarget = null; lockedProject = null; pendingLink = null;
  // Escape or the close button: keyboard goes back to the control that opened the dialog.
  if (dialogReturn?.isConnected && (document.activeElement === document.body || newDialog.contains(document.activeElement))) dialogReturn.focus();
});
/** Pulso project chosen in the dialog: link the new session (same requestId on retries, so never twice). */
async function linkPendingSession(): Promise<boolean> {
  const link = pendingLink; if (!link) return true;
  try {
    await requestPulso('link', { projectId: link.projectId, sessionId: link.sessionId, requestId: link.requestId });
    pendingLink = null; $('#session-link-retry').hidden = true; loadSidebarProjects(); return true;
  } catch {
    text('#session-link-retry-text', `La sesión se abrió, pero no quedó vinculada a «${link.title}».`); $('#session-link-retry').hidden = false; refresh();
    $<HTMLButtonElement>('#retry-session-link').focus(); return false;
  }
}
$('#retry-session-link').addEventListener('click', () => action(async () => { if (await linkPendingSession()) { newDialog.close(); focusView(activeView()); } }));
$('#close-session-link').addEventListener('click', () => { pendingLink = null; closeNew(); });
$('#new-session-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pendingLink || openingSession || busyAction || $<HTMLButtonElement>('#start-session').disabled) return; // Enter only sends a valid form, once.
  const kind = checkedProvider(), folder = selectedDirectory;
  if (!kind || !folder) return;
  // Captured at the click: the fields are locked until the open ends.
  const projectId = lockedProject ? '' : $<HTMLSelectElement>('#session-project').value;
  const title = $<HTMLInputElement>('#session-title').value.trim() || providerLabel(kind);
  openingSession = true; for (const id of ['#new-session-error', '#session-project-error']) $(id).hidden = true; announce('Abriendo sesión…');
  void action(async () => {
    try {
      // The CLI may have been removed since the last check: confirm before starting (the newest check wins).
      if (kind !== 'terminal') { await probeTools(); while (probeInFlight) await probeInFlight; if (toolState[kind] === 'missing') { refresh(); return; } }
      // The chosen project must still be open (another window or an agent may have archived it): never open unlinked in silence.
      let project: { id: string; title: string } | null = null;
      if (projectId) {
        const current = await requestPulso('project', { id: projectId }).then((data: any) => data?.project as { id: string; title: string; archived?: boolean } | undefined).catch(() => undefined);
        if (!current || current.archived) {
          text('#session-project-error', 'Ese proyecto ya no está abierto; elige otro o Sin proyecto.'); $('#session-project-error').hidden = false;
          loadSidebarProjects(); $<HTMLSelectElement>('#session-project').value = ''; renderProjectField(); return;
        }
        project = { id: current.id, title: current.title };
      }
      let started: string;
      try { started = await start(`${kind}-${crypto.randomUUID()}`, kind, title, panes[focusedPane], folder); }
      catch (e) {
        if (isMissingFolderError(message(e))) { folderMissing = true; text('#folder-error', 'Esta carpeta ya no existe. Elige otra carpeta.'); $('#folder-error').hidden = false; $<HTMLSelectElement>('#session-folder').focus(); return; }
        throw e;
      }
      try { rememberRecentFolder(localStorage, profileDataDir, folder); } catch { /* Optional view preference. */ }
      // Opened from Pulso «Nuevo proyecto»: that project takes this session as its main one.
      const target = projectSessionTarget; projectSessionTarget = null; target?.(started);
      if (project) { pendingLink = { sessionId: started, projectId: project.id, title: project.title, requestId: `new-session-link-${started}-${project.id}` }; if (!await linkPendingSession()) return; }
      newDialog.close(); focusView(activeView());
    } catch (e) { text('#new-session-error', message(e)); $('#new-session-error').hidden = false; }
    finally { openingSession = false; }
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
    const flight = {}; stopping.add(id); stopFlights.set(id, flight); stopUncertain.delete(id); refresh();
    // The pane heading says «Terminando…»; no floating notice over the terminal.
    announce(`Terminando ${title}…`);
    const work = request<Session>('stop', { id,...(generation!==null?{generation}:{}) }).then(async result => { updateStatus(await request<RunnerStatus>('status', {})); return result; });
    // The barrier lasts until the runner answers this request, whatever the 12 s timer showed.
    void work.finally(() => { if (stopFlights.get(id) === flight) stopFlights.delete(id); if (!disposed) refresh(); }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), stopConfirmMs); });
    try {
      const result = await Promise.race([work, late]);
      if (result === null) {
        // Never «Terminando…» forever: say it could not be confirmed and keep listening for the answer.
        stopping.delete(id); stopUncertain.add(id); refresh();
        notice(`${title}: no se pudo confirmar el cierre. Pulsa Reconectar para ver su estado real; si el proceso ya no existe, usa Liberar plaza en el menú «…» del panel.`, true);
        void work.then(answer => { if (!disposed) stopConfirmed(id, title, answer); }).catch(() => {});
        return;
      }
      stopConfirmed(id, title, result);
    } catch (e) {
      // A refused stop leaves the session as it was: never «Terminando…» with the input disabled.
      stopping.delete(id); refresh();
      notice(`${message(e)} Reconecta para confirmar el estado antes de continuar.`, true);
    }
    finally { clearTimeout(timer); }
  });
});
/** The runner answered a Terminar the person confirmed. */
function stopConfirmed(id: string, title: string, result: Session) {
  if (finalStatus(result.status)) {
    stopUncertain.delete(id);
    for (const pane of panes) if (pane.id === id && (pane === panes[0] || split)) leavePane(pane, id);
    notice(`${title}: terminada. Está en Historial, en solo lectura.`);
  } else {
    stopping.delete(id); stopUncertain.add(id); refresh();
    notice(`${title}: no se pudo confirmar el cierre. La carpeta y su plaza siguen reservadas; comprueba los procesos y usa Liberar plaza en el menú «…» del panel.`, true);
  }
}
/**
 * Takes an ended session out of one pane: the next open session not shown in
 * the other pane, by priority (needs you → finished unseen → working → most
 * recently used), else nothing (the welcome view or the pane's empty state).
 * Keyboard focus goes to that terminal, else to Nueva sesión: never to body.
 */
/**
 * The next Abierta for a pane, never one in `exclude`. After Terminar
 * (`byPriority`): needs you → finished unseen → working → most recently used →
 * most recently created. Dividir: simply the most recently created.
 */
function nextOpenSession(exclude: readonly (string | null)[], byPriority = true): Session | undefined {
  const rank = (s: Session) => { const kind = currentActivity.get(s.id)?.kind; return kind === 'needs' || kind === 'notice' ? 0 : kind === 'finished' ? 1 : kind === 'working' ? 2 : 3; };
  const open = orderRecent([...views.values()].map(v => v.session)).filter(s => isLive(s) && !exclude.includes(s.id) && !stopping.has(s.id));
  if (!byPriority) return open[0];
  return open.sort((a, b) => rank(a) - rank(b) || (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))[0];
}
function leavePane(pane: Pane, id: string) {
  if (pane.id !== id) return;
  const index = panes.indexOf(pane);
  const shownElsewhere = panes.filter((other, i) => other !== pane && (i === 0 || split) && other.id).map(other => other.id);
  const next = nextOpenSession([id, ...shownElsewhere]);
  focusedPane = index;
  if (next) { selectSession(next.id); return; }
  assign(pane, null); refresh();
  // Inside Terminar's action Nueva sesión is still disabled: focus it once the action ends (never body).
  const place = () => {
    const welcome = $<HTMLButtonElement>('#welcome-create');
    if (!$('#welcome').hidden) (welcome.disabled ? $<HTMLButtonElement>('#open-command-palette') : welcome).focus();
    else pane.trigger.focus();
  };
  place(); setTimeout(() => { if (!disposed && pane.id === null && (document.activeElement === document.body || document.activeElement?.id === 'open-command-palette')) place(); });
}
/** Where focus was before it entered the notice (Tab or a click on its button). */
let beforeNotice: HTMLElement | null = null;
$('#notice').addEventListener('focusin', event => {
  const from = event.relatedTarget;
  if (from instanceof HTMLElement && !$('#notice').contains(from)) beforeNotice = from;
});
/**
 * Closing the notice by the person (button or Escape): focus inside it goes
 * back to where it came from, else to the bell when there are alerts, else to
 * the focused terminal or the palette button; never body. Closing a notice never marks an alert seen by itself.
 */
function closeNoticeByPerson() {
  const hadFocus = $('#notice').contains(document.activeElement);
  dismissNotice();
  if (!hadFocus) return;
  const back = beforeNotice; beforeNotice = null;
  if (back?.isConnected && back.getClientRects().length && !(back as HTMLButtonElement).disabled) { back.focus({ preventScroll: true }); if (document.activeElement === back) return; }
  // Focusing a terminal would consume its activity: with alerts pending, the bell takes focus instead.
  const bell = $<HTMLButtonElement>('#session-alerts');
  if (!bell.hidden) { bell.focus({ preventScroll: true }); return; }
  restoreWorkbenchFocus();
}
/** Where focus goes when the control that had it disappears: the focused terminal, else the palette button. */
function restoreWorkbenchFocus() { const view = activeView(); if (view && stageView === 'terminal') focusView(view); else $<HTMLButtonElement>('#open-command-palette').focus(); }
$('#dismiss-notice').addEventListener('click', closeNoticeByPerson);
$('#notice').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  closeNoticeByPerson();
});
$('#toggle-split').addEventListener('click', () => setSplit(!split));
$('#toggle-sidebar').addEventListener('click', () => {
  const open = $('.workspace-shell').classList.toggle('sidebar-open'); $('#sidebar-scrim').hidden = !open;
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
  // The drawer covers or uncovers the terminal: «attended» changes with it.
  refresh();
});
$('#sidebar-scrim').addEventListener('click', () => { closeSidebar(); refresh(); });
/*
 * Sidebar layout (1.4.0). Proyectos and Agentes scroll on their own; the split
 * sets how much Proyectos may take (it never grows past its content, never
 * below two rows, and Agentes keeps its own minimum); the width handle sets the
 * sidebar width. Both are remembered per profile (sidebar-layout.ts). The split
 * only moves the sidebar. The width changes the terminals, so a drag moves a
 * guide and applies the width once, on release: one `resize` per visible PTY.
 */
let layout: SidebarLayout = { ...defaultSidebarLayout };
const regions = $('#sidebar-regions'), splitHandle = $('#sidebar-split'), widthHandle = $('#sidebar-width-handle');
function applySidebarLayout() {
  const shell = $('.workspace-shell');
  const overlay = window.innerWidth <= sidebarOverlayBelow;
  const width = overlay ? sidebarWidth.default : effectiveSidebarWidth(layout.width, window.innerWidth);
  if (shell.style.getPropertyValue('--sidebar-width') !== `${width}px`) shell.style.setProperty('--sidebar-width', `${width}px`);
  for (const [section, collapsed] of [['projects', layout.projectsCollapsed], ['agents', layout.agentsCollapsed]] as const) {
    $(`#sidebar-${section}`).dataset.collapsed = String(collapsed);
    $(`#sidebar-${section}-heading button`).setAttribute('aria-expanded', String(!collapsed));
  }
  regions.dataset.agentsCollapsed = String(layout.agentsCollapsed);
  splitHandle.hidden = layout.projectsCollapsed || layout.agentsCollapsed;
  regions.style.setProperty('--projects-max', layout.agentsCollapsed || layout.projectsCollapsed ? 'none' : `${projectsMaxHeight(regions.clientHeight, layout)}px`);
  splitHandle.setAttribute('aria-valuenow', String(layout.projectsShare));
  splitHandle.setAttribute('aria-valuetext', `Proyectos ocupa hasta el ${layout.projectsShare} % de la barra lateral`);
  const max = maxSidebarWidth(window.innerWidth);
  widthHandle.setAttribute('aria-valuemax', String(Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, max))));
  widthHandle.setAttribute('aria-valuenow', String(layout.width));
  widthHandle.setAttribute('aria-valuetext', `${layout.width} px${width !== layout.width && !overlay ? ` (${width} px en esta ventana)` : ''}`);
}
function setSidebarLayout(next: Partial<SidebarLayout>, persist = true) {
  layout = { ...layout, ...next };
  if (layout.projectsCollapsed && layout.agentsCollapsed) layout = { ...layout, ...('projectsCollapsed' in next ? { agentsCollapsed: false } : { projectsCollapsed: false }) };
  if (persist) try { saveSidebarLayout(localStorage, profileDataDir, layout); } catch { /* Optional view preference. */ }
  applySidebarLayout();
}
function resetSidebar() { setSidebarLayout({ ...defaultSidebarLayout }); }
function toggleSection(section: 'projects' | 'agents') {
  setSidebarLayout(section === 'projects' ? { projectsCollapsed: !layout.projectsCollapsed } : { agentsCollapsed: !layout.agentsCollapsed });
}
$('#sidebar-projects-heading button').addEventListener('click', () => toggleSection('projects'));
$('#sidebar-agents-heading button').addEventListener('click', () => toggleSection('agents'));
new ResizeObserver(() => applySidebarLayout()).observe(regions);
window.addEventListener('resize', applySidebarLayout);
let resizing: { pointer: number; cancel: () => void } | null = null;
function startSeparatorDrag(event: PointerEvent, handle: HTMLElement, kind: 'split' | 'width') {
  if (event.button !== 0 || resizing) return;
  event.preventDefault(); handle.focus({ preventScroll: true });
  const shell = $('.workspace-shell'); const shellBox = shell.getBoundingClientRect();
  handle.setPointerCapture(event.pointerId); handle.dataset.dragging = 'true';
  shell.classList.add('is-resizing'); shell.dataset.resizing = kind;
  let guide: HTMLElement | null = null; let width = layout.width; const initialShare = layout.projectsShare;
  if (kind === 'width') {
    guide = document.createElement('div'); guide.className = 'sidebar-width-guide'; guide.setAttribute('aria-hidden', 'true');
    guide.style.left = `${$('#sidebar').getBoundingClientRect().right - shellBox.left}px`; shell.append(guide);
  }
  const move = (e: PointerEvent) => {
    if (kind === 'split') {
      const box = regions.getBoundingClientRect(); const room = Math.max(1, box.height - 8);
      // Live, not saved: the share is saved once on release; a cancel puts the initial one back.
      setSidebarLayout({ projectsShare: clampShare((e.clientY - box.top - 4) / room * 100) }, false);
    } else {
      width = clampWidth(Math.min(e.clientX - shellBox.left, maxSidebarWidth(window.innerWidth)));
      guide!.style.left = `${width}px`;
    }
  };
  const finish = (commit: boolean) => {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel);
    window.removeEventListener('keydown', escape, true);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    delete handle.dataset.dragging; shell.classList.remove('is-resizing'); delete shell.dataset.resizing; guide?.remove(); resizing = null;
    // The only width change of a drag: terminals refit once (one resize each).
    if (commit && kind === 'width' && width !== layout.width) setSidebarLayout({ width });
    if (kind === 'split') { if (commit) setSidebarLayout({}); else setSidebarLayout({ projectsShare: initialShare }, false); }
  };
  const up = () => finish(true); const cancel = () => finish(false);
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
  // Losing the capture without pointercancel (another window, a system gesture) also cancels: no drag stays stuck.
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel);
  window.addEventListener('keydown', escape, true);
  resizing = { pointer: event.pointerId, cancel };
}
splitHandle.addEventListener('pointerdown', event => startSeparatorDrag(event, splitHandle, 'split'));
widthHandle.addEventListener('pointerdown', event => startSeparatorDrag(event, widthHandle, 'width'));
splitHandle.addEventListener('dblclick', () => setSidebarLayout({ projectsShare: projectsShare.default }));
widthHandle.addEventListener('dblclick', () => setSidebarLayout({ width: sidebarWidth.default }));
splitHandle.addEventListener('keydown', event => {
  const value = separatorKey(event.key, layout.projectsShare, projectsShare, ['ArrowDown'], ['ArrowUp']);
  if (value === null) return; event.preventDefault(); setSidebarLayout({ projectsShare: value });
});
widthHandle.addEventListener('keydown', event => {
  const value = separatorKey(event.key, layout.width, { ...sidebarWidth, max: Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, maxSidebarWidth(window.innerWidth))) }, ['ArrowRight'], ['ArrowLeft']);
  if (value === null) return; event.preventDefault(); setSidebarLayout({ width: value });
});
/** Terminal font (per profile): applied to every xterm; the visible ones refit once. */
let terminalFont: number = terminalFontSize.default;
function setTerminalFont(size: number, persist = true) {
  terminalFont = size;
  if (persist) try { saveTerminalFont(localStorage, profileDataDir, size); } catch { /* Optional view preference. */ }
  for (const view of views.values()) {
    if (view.term.options.fontSize === size) continue;
    view.term.options.fontSize = size;
    if (view.host.isConnected) scheduleResize(view);
  }
}
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
/**
 * Whether something covers the terminal stage: any open <dialog> (palette,
 * Configuración, nueva sesión, renombrar, terminar, the Pulso drawer), the
 * focused pane's recovery card, session picker or "…" menu, or, in a
 * window of 860 px or less, the sidebar drawer with its scrim. The scrim only
 * displays in that layout, so its computed style is the breakpoint.
 */
function terminalCovered(pane = panes[focusedPane]): boolean {
  if (document.querySelector('dialog[open]')) return true;
  // The pane's own floating layers: its recovery card (not folded by «Ver salida»), its open
  // session picker or "…" menu. The alerts popover sits in the top bar and is not counted.
  if (pane) {
    // From the model, not the DOM: the first refresh after the status change has not painted the card yet.
    const shown = pane.id ? views.get(pane.id)?.session : undefined;
    if (shown && lifecycleOf(shown) === 'interrupted' && !recoveryFolded.has(shown.id)) return true;
    if (pane.picker.isOpen || pane.root.querySelector('.pane-menu[open]')) return true;
  }
  const scrim = $('#sidebar-scrim');
  return !scrim.hidden && $('.workspace-shell').classList.contains('sidebar-open') && getComputedStyle(scrim).display !== 'none';
}
/**
 * The one rule for «this session is being attended», used by both attention
 * sources (automatic seen, client parser), native notices and activity
 * consumption: visible document, focused window, terminal stage (not Pulso),
 * nothing covering it, and the session in a visible pane: the first, or the
 * second when the stage is split (both are on screen; 1.4.0 avisos-2).
 */
function visiblePane(id: string) { return panes.find((pane, index) => pane.id === id && (index === 0 || split)); }
function isAttended(id: string) {
  const pane = visiblePane(id);
  return !!pane && document.visibilityState === 'visible' && document.hasFocus() && stageView === 'terminal' && !terminalCovered(pane);
}
/** Sessions on screen now, for automatic seen and activity consumption. */
function attendedSessions(): string[] { return panes.flatMap((pane, index) => pane.id && (index === 0 || split) && isAttended(pane.id) ? [pane.id] : []); }
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
  // The click listener first: the plugin only tracks notices shown while it exists.
  await listenNoticeClicks();
  await nativeAttention.enableFromClick(source.nativeItems(source.list(attentionSessions()))); button.disabled = false;
});
/**
 * A click on a macOS notice (plugin `actionPerformed`, `tap`): bring Jauría to
 * the front and open that session, or the alerts list for a batch. Registered
 * once, when the person enables notices and before any is sent (the plugin
 * only reports clicks on notices shown while a listener exists).
 */
let noticeClicks: Promise<{ unregister(): Promise<void> } | null> | null = null;
function listenNoticeClicks() {
  return noticeClicks ??= onAction(event => {
    const target = nativeAttention.target(clickedNotice(event));
    if (!target || disposed) return;
    const win = getCurrentWindow();
    void win.unminimize().catch(() => {}).then(() => win.setFocus()).catch(() => {});
    if ('session' in target && views.has(target.session)) selectSession(target.session);
    else if (!alertsPopover.isOpen) { alertsPopover.show(); refresh(); }
  }).catch(() => null);
}
window.addEventListener('beforeunload', () => { nativeAttention.disable(); void noticeClicks?.then(listener => listener?.unregister()).catch(() => {}); }, { once: true });
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
  (!$('#attention-banner').hidden ? $('#open-attention-session') : $('#session-alerts').hidden ? $('#open-command-palette') : $('#session-alerts')).focus();
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
// Appearance: a local preference of this app (not per profile), applied at once.
const theme = { value: 'system' };
try { const saved = localStorage.getItem('aw-theme'); if (saved === 'light' || saved === 'dark' || saved === 'system') theme.value = saved; } catch { /* appearance is optional */ }
document.documentElement.dataset.theme = theme.value;
function applyTheme(value: string) {
  theme.value = ['light', 'dark'].includes(value) ? value : 'system'; document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem('aw-theme', theme.value); } catch { /* optional */ }
}
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
  notificationControls: $('#settings-notifications'),
  aboutControls: $('#settings-about-controls'),
  terminalFont: { ...terminalFontSize, get: () => terminalFont, set: size => setTerminalFont(size) },
  grouping: { get: () => grouping, set: value => { if (value !== grouping) toggleGrouping(); } },
  resetSidebar,

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
  async saveProviderSignals(enabled) {
    if (!connected || connecting) throw new Error('Sin conexión con el runner.');
    const check = workspaceContext();
    const result = await request<AppSettings>('set_provider_signals', { enabled }); check(); return result;
  },
  openNotificationSettings: () => invoke<void>('open_notification_settings'),
  getTheme: () => theme.value, setTheme: applyTheme, version: appVersion,
  canEdit: () => connected && !connecting && (runner?.settingsVersion === 1 || runner?.settingsVersion === 2),
  onSaved(settings) { if (runner) runner.settings = settings; refresh(); },
});
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
/** Cancelar (Ctrl-C) sends Ctrl-C at once from its button; the palette only focuses that button. */
function focusInterruptControl(id: string) {
  const pane = panes.find((p, index) => p.id === id && (index === 0 || split)); if (!pane) return;
  const button = pane.root.querySelector<HTMLButtonElement>('[data-action="interrupt"]');
  if (!button || button.hidden || button.disabled) return;
  button.focus();
  notice(`${views.get(id)?.session.title ?? 'Sesión'}: pulsa Intro o Espacio en Cancelar (Ctrl-C) para cancelar lo que está haciendo; la sesión sigue abierta.`);
}
/**
 * In Pulso, a draft or a failed save keeps the board (same guard as «Terminal»).
 * A pending Proyecto autosave is saved first and `next` repeats the navigation
 * once it succeeded (one gesture); a failed save stays with its error.
 */
function pulsoNavigationAllowed(next?: () => void) {
  if (stageView !== 'pulso' || !pulsoPanel) return true;
  if (next && pulsoPanel.saveThen(next)) return false;
  if (pulsoPanel.prepareNavigation()) return true;
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
    planning: stageView === 'pulso', pulsoUnavailable: pulsoUnavailable(), pulsoDraft: pulsoPanel?.draftBlocked() ?? null,
    unseenAlerts: Number($('#session-alerts').dataset.unread ?? 0),
    needsTarget: needsId && views.has(needsId) ? { id: needsId, title: views.get(needsId)!.session.title } : null,
    sidebarLayout: { isDefault: sameLayout(layout, defaultSidebarLayout), projectsCollapsed: layout.projectsCollapsed, agentsCollapsed: layout.agentsCollapsed }, smoke,
    grouping, filter: filter === 'closed' ? 'closed' : filter === 'open' || filter === 'activity' ? 'open' : 'other', theme: theme.value as Theme,
    renameSupported: runner?.sessionRenameVersion === 1,
    focused: view ? { id: view.session.id, title: view.session.title, live: isLive(view.session), stopping: stopping.has(view.session.id) || stopFlights.has(view.session.id), structured: view.session.transport === 'app-server' } : null,
    actions: {
      togglePalette: () => palette?.toggle(), newSession: () => openNew(), searchSessions: focusSessionSearch, toggleSplit: () => setSplit(!split), focusOtherPane,
      showPulso, leavePulso, newProject: function newProjectAction() { if (!pulsoNavigationAllowed(newProjectAction)) return; showPulso(); pulsoPanel?.newProject(); },
      openSettings, openUsage: openTelemetry, markAlertsSeen, resetSidebar, toggleSection, createFixtures: smoke ? createFixtures : undefined,
      openSession: function openSessionAction(id) { if (views.has(id) && pulsoNavigationAllowed(() => openSessionAction(id))) selectSession(id); },
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
  return paletteEntries({ sessions: orderRecent(sessions).map(s => ({ ...s, live: isLive(s), interrupted: lifecycleOf(s) === 'interrupted' })), activityOf: id => currentActivity.get(id) ?? { kind: 'unreported', label: '' },
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
  const candidates = stageView === 'pulso' ? ['#pulso-back-terminal', '#open-pulso'] : stageView === 'history' ? ['#history-back', '#open-command-palette'] : [`#session-${focusedPane}`, '#welcome-create', '#open-command-palette'];
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
/** Smoke profiles only (AW_VERTICAL_SMOKE=1): test fixtures from the command palette, never in the production interface. */
function createFixtures(which: 'both' | 1 | 2) {
  void action(async () => {
    if (which !== 2) await start('fixture1', 'fixture', 'Fixture 1', panes[0]);
    if (which !== 1) await start('fixture2', 'fixture', 'Fixture 2', panes[1]);
  });
}
/** CLI checks may overlap (startup, «Comprobar otra vez», sending): only the newest one is applied. */
function probeTools(explicit = false): Promise<void> {
  const seq = ++probeSeq;
  const run = probeToolsOnce(seq, explicit).finally(() => { if (seq === probeSeq) { probeInFlight = null; if (!disposed) refresh(); } });
  // Repaint after registering it (a microtask: the first check starts while the module is still loading).
  probeInFlight = run; queueMicrotask(() => { if (!disposed) refresh(); }); return run;
}
async function probeToolsOnce(seq: number, explicit: boolean) {
  const button = $<HTMLButtonElement>('#probe'); button.disabled = true;
  if (explicit) { for (const kind of ['codex', 'claude'] as const) toolState[kind] = 'checking'; refresh(); }
  try {
    const tools = await invoke<{ tool: string; available: boolean; path?: string; version?: string }[]>('probe_tools');
    if (seq !== probeSeq) return;
    // Versions only: paths stay out of the interface.
    text('#tools', ['claude', 'codex'].map(kind => { const tool = tools.find(t => t.tool === kind); return `${providerLabel(kind)}: ${tool?.available ? (tool.version ?? 'disponible').replace(/\s*\(.*\)\s*$/, '') : 'no encontrado'}`; }).join(' · '));
    for (const kind of ['codex', 'claude'] as const) {
      const tool = tools.find(t => t.tool === kind);
      toolState[kind] = tool?.available ? 'available' : 'missing';
      text(`#welcome-${kind}`, `${providerLabel(kind)} · ${tool?.available ? 'CLI disponible' : 'CLI no instalada'}`);
    }
  } catch (e) {
    if (seq !== probeSeq) return;
    for (const kind of ['codex', 'claude'] as const) { toolState[kind] = 'unknown'; text(`#welcome-${kind}`, `${providerLabel(kind)} · CLI sin verificar`); }
    text('#tools', `No se pudo comprobar: ${message(e)}`);
  } finally { if (seq === probeSeq) { button.disabled = false; if (!disposed && newDialog.open && !newDialogPreset && !openingSession) selectAvailableProvider(); } }
}
$('#probe').addEventListener('click', () => void probeTools(true));

void probeTools();
pulsoPanel = mountPulsoPanel({
  host: $('#pulso-panel-host'),
  tabsHost: $('#pulso-tabs-host'),
  request: requestPulso,
  persistenceKey: () => profileDataDir,
  bindingCacheKey: () => `${loopVersion}:${runner?.generation??''}`,
  // «Empezar una sesión nueva para este proyecto»: the usual Nueva sesión dialog; the session it starts is handed back once.
  startProjectSession: (started, project) => { openNew(null, undefined, project); if (!newDialog.open) return false; projectSessionTarget = started; return true; },
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
  // The common path (continueConversation): same slot check, pane, «continuada» mark and Pulso link inheritance.
  resumeSession: sourceId => continueConversation(sourceId),
  restartSession: id => { const session = views.get(id)?.session; if (session) openNew(session.cwd, { kind: session.kind, title: session.title }); },
});
function showPulso() { stageView = 'pulso'; closeSidebar(); refresh(); }
/*
 * Vista Historial (1.4.0, owner decision 1): a Terminada is read in the stage,
 * like Pulso, never in a working pane. Its terminal moves into the view at its
 * saved geometry (no fit, never a `resize`); going back puts the panes back as
 * they were, also without `resize`. The panes are covered, so no session is
 * attended (isAttended needs the terminal stage).
 */
let historySearch = { query: '', index: -1 };
// The pane that showed the read session (it ended on screen): it gets it back when the view leaves.
let historyReturn: { index: number; id: string } | null = null;
/** xterm keeps scrollback + rows lines: at that length older output was cut from the view (the runner keeps it). */
function historyTrimmed(view: View) { return view.term.buffer.active.length >= (view.term.options.scrollback ?? 1000) + view.term.rows; }
function showHistory(id: string) {
  const session = views.get(id)?.session; if (!session || !pulsoNavigationAllowed(() => showHistory(id))) return;
  source.select(id, attentionSessions());
  historyId = id; stageView = 'history'; historySearch = { query: '', index: -1 };
  $<HTMLInputElement>('#history-search').value = ''; text('#history-search-count', '');
  learnBinding(session);
  closeSidebar(); refresh();
  $('#history-back').focus({ preventScroll: true });
}
function leaveHistory() {
  if (stageView !== 'history') return;
  stageView = 'terminal'; historyId = null; $<HTMLDetailsElement>('#history-menu').open = false; refresh();
  for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
  const view = activeView();
  if (view) focusView(view); else if (!$<HTMLButtonElement>('#welcome-create').disabled) $('#welcome-create').focus(); else $('#open-command-palette').focus();
}
function historyView() { return stageView === 'history' && historyId ? views.get(historyId) : undefined; }
/** Mounts the read session in the view and paints its header and actions (called by refresh). */
function syncHistoryView(newSessionBlocked: boolean) {
  const host = $('#history-terminal');
  // A reconnect (purge, compact) rebuilds the views: keep the view until the session is known to be gone,
  // also when `status` no longer lists it. Focus inside the hidden view goes to a real control.
  const gone = stageView === 'history' && !connecting && (!historyView() || (!!runner && !runner.sessions.some(x => x.id === historyId)));
  if (gone) {
    const hadFocus = $('#history-view').contains(document.activeElement);
    stageView = 'terminal'; historyId = null;
    notice('Esa sesión ya no está en este perfil; se cerró su historial.');
    // At once on a control that is always visible, then (once the panes are shown) on the terminal.
    if (hadFocus) $('#open-command-palette').focus({ preventScroll: true });
    if (hadFocus) setTimeout(() => { if (disposed || stageView !== 'terminal') return; const active = activeView(); if (active) focusView(active); if (document.activeElement === document.body || !document.activeElement) ($<HTMLButtonElement>('#welcome-create').disabled || $('#welcome').hidden ? $('#open-command-palette') : $('#welcome-create')).focus(); });
  }
  const view = historyView();
  $('#history-view').hidden = !view;
  for (const child of Array.from(host.children)) if (child !== view?.host) child.remove();
  if (historyReturn && historyReturn.id !== view?.session.id) {
    const { index, id } = historyReturn; historyReturn = null;
    if (!panes[index].id && views.has(id) && (index === 0 || split)) assign(panes[index], id);
  }
  if (!view) return;
  const s = view.session;
  panes.forEach((pane, index) => { if (pane.id === s.id) { if (index === 0 || split) historyReturn = { index, id: s.id }; assign(pane, null); } });
  const trimmed = historyTrimmed(view) && s.transport !== 'app-server';
  $('#history-trimmed').hidden = !trimmed;
  if (trimmed) text('#history-trimmed', `Se muestran las últimas ${view.term.buffer.active.length.toLocaleString('es')} líneas guardadas en pantalla. La salida anterior sigue en el historial del runner, pero no entra en Buscar ni en Copiar salida.`);
  if (view.host.parentElement !== host) { host.append(view.host); syncTerminalViewport(view.term); }
  const badge = $('#history-provider'); const provider = providerBadge(s.kind);
  if (badge.dataset.provider !== provider.provider) { badge.dataset.provider = provider.provider; badge.textContent = provider.letter; }
  text('#history-title', s.title); text('#history-folder', s.cwd ?? 'Sin carpeta'); $('#history-folder').title = s.cwd ?? '';
  const successor = dismissed.get(s.id);
  const next = successor ? views.get(successor)?.session : undefined;
  text('#history-state', `${categoryLabel(lifecycleOf(s))} · solo lectura${successor ? ` · continuada en «${next?.title ?? 'otra sesión'}»` : isRetired(s.id) ? ' · descartada' : ''}`);
  const resume = $<HTMLButtonElement>('#history-continue');
  resume.hidden = continuationOf(s).action !== 'continue' || (!!next && !isClosed(next.status));
  resume.disabled = !connected || connecting || busyAction || replaying;
  resume.title = continuationOf(s).note;
  $<HTMLButtonElement>('#history-new').disabled = !s.cwd || newSessionBlocked;
  const structured = s.transport === 'app-server';
  for (const id of ['history-copy', 'history-search']) { const node = $<HTMLInputElement>(`#${id}`); node.disabled = structured; node.title = structured ? 'La conversación de Codex se lee en esta vista; no tiene salida de terminal' : node.id === 'history-copy' ? 'Copia toda la salida guardada al portapapeles' : ''; }
  for (const id of ['history-purge', 'history-compact']) $<HTMLButtonElement>(`#${id}`).disabled = !connected || busyAction || replaying;
}
/** Search in the saved output (case insensitive); Enter: next, Shift+Enter: previous. */
function findInHistory(backwards: boolean, restart = false) {
  const view = historyView(); if (!view) return;
  const query = $<HTMLInputElement>('#history-search').value.trim();
  if (!query) { view.term.clearSelection(); text('#history-search-count', ''); historySearch = { query: '', index: -1 }; return; }
  const needle = query.toLocaleLowerCase(); const buffer = view.term.buffer.active;
  const matches: { row: number; col: number }[] = [];
  for (let row = 0; row < buffer.length && matches.length < 1000; row++) {
    const line = buffer.getLine(row)?.translateToString(true).toLocaleLowerCase() ?? '';
    for (let at = line.indexOf(needle); at >= 0 && matches.length < 1000; at = line.indexOf(needle, at + needle.length)) matches.push({ row, col: at });
  }
  if (!matches.length) { view.term.clearSelection(); text('#history-search-count', historyTrimmed(view) ? 'Sin coincidencias en lo que se muestra' : 'Sin coincidencias'); historySearch = { query, index: -1 }; return; }
  const index = restart || historySearch.query !== query || historySearch.index < 0 ? (backwards ? matches.length - 1 : 0)
    : (historySearch.index + (backwards ? -1 : 1) + matches.length) % matches.length;
  historySearch = { query, index };
  const match = matches[index];
  view.term.select(match.col, match.row, query.length);
  view.term.scrollToLine(Math.max(0, match.row - Math.floor(view.term.rows / 2)));
  text('#history-search-count', `${index + 1} de ${matches.length}${matches.length >= 1000 ? '+' : ''}`);
}
/** The saved output as text: wrapped rows joined, trailing empty rows dropped. */
function historyText(view: View) {
  const buffer = view.term.buffer.active; const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row); if (!line) continue;
    const value = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += value; else lines.push(value);
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.join('\n');
}
$('#history-back').addEventListener('click', leaveHistory);
$('#history-search').addEventListener('input', () => findInHistory(false, true));
$('#history-search').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); findInHistory(event.shiftKey); }
  else if (event.key === 'Escape' && $<HTMLInputElement>('#history-search').value) { event.preventDefault(); event.stopPropagation(); $<HTMLInputElement>('#history-search').value = ''; findInHistory(false, true); }
});
$('#history-copy').addEventListener('click', () => {
  const view = historyView(); if (!view) return;
  const partial = historyTrimmed(view) ? ` (las últimas ${view.term.buffer.active.length.toLocaleString('es')} líneas que muestra la vista)` : '';
  void navigator.clipboard.writeText(historyText(view)).then(() => notice(`Salida copiada${partial}.`), e => notice(message(e), true));
});
$('#history-new').addEventListener('click', () => { const s = historyView()?.session; if (s?.cwd) openNew(s.cwd); });
$('#history-continue').addEventListener('click', () => { const s = historyView()?.session; if (s) void action(async () => { await continueConversation(s.id, panes[focusedPane]); }); });
{
  const menu = $<HTMLDetailsElement>('#history-menu'); const summary = menu.querySelector<HTMLElement>('summary')!;
  const floating = { contains: (node: Node) => menu.contains(node), close: (restore: boolean) => { if (!menu.open) return; menu.open = false; if (restore) summary.focus({ preventScroll: true }); } };
  summary.addEventListener('click', () => { if (!menu.open) claimFloating(floating); });
  menu.addEventListener('toggle', () => { if (menu.open) claimFloating(floating); else releaseFloating(floating); });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { event.preventDefault(); event.stopPropagation(); floating.close(true); } });
  for (const [id, op] of [['history-purge', 'purge_history'], ['history-compact', 'compact_history']] as const) $(`#${id}`).addEventListener('click', () => {
    const s = historyView()?.session; floating.close(true); if (s) historyAction(op, s.id);
  });
}
$('#history-view').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || $<HTMLDetailsElement>('#history-menu').open) return;
  event.preventDefault(); leaveHistory();
});
/** Same as the former «Volver a terminal»: a Pulso draft or failed save keeps the board. */
function leavePulso() {
  if (stageView !== 'pulso') return;
  if (pulsoPanel?.saveThen(leavePulso)) return;
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
  if (!pulsoPanel || pulsoUnavailable() || !pulsoNavigationAllowed(() => openBoardFromNavigation(board))) return;
  showPulso();
  void pulsoPanel.openBoard(board).finally(() => { if (!disposed) refresh(); });
}
/** Palette «Fases»: a phase of the loaded board opens its drawer; Pulso's draft guards apply. */
function openPhaseFromNavigation(id: string) {
  if (!pulsoPanel || pulsoUnavailable() || !pulsoNavigationAllowed(() => openPhaseFromNavigation(id))) return;
  showPulso();
  void pulsoPanel.openPhase(id).finally(() => { if (!disposed) refresh(); });
}
window.addEventListener('beforeunload', () => { disposed = true; loopVersion++; pulsoPanel?.dispose(); });
refresh();
// Connect is safe at launch: replay only. All start operations require visible controls.
void connect();

// «Uso y recursos»: its own dialog (sidebar footer row, status bar total, palette).
const telemetryPanel = mountTelemetry({
  request, isConnected: () => connected,
  sessionTitle: id => runner?.sessions.find(session => session.id === id)?.title ?? null,
  // The status bar total is hidden below 1050 px (style.css): no polling for it then.
  wantsSummary: () => !document.hidden && $('#telemetry-summary').getClientRects().length > 0,
  onSummary: summary => text('#telemetry-summary', summary),
  sessionOfPid: pid => runner?.sessions.find(session => session.pid === pid)?.id ?? null,
  // Below 860 px the sidebar is a drawer that closes on open: its row is then
  // hidden, so focus goes to the visible «Mostrar navegación» button instead.
  fallbackFocus: () => [$('#open-telemetry'), $('#toggle-sidebar'), $('#telemetry-summary')],
});
function openTelemetry(from?: HTMLElement) {
  if (disposed || document.querySelector('dialog[open]')) return;
  telemetryPanel.open(from); closeSidebar(); refresh();
}
$('#open-telemetry').addEventListener('click', () => openTelemetry($('#open-telemetry')));
$('#telemetry-summary').addEventListener('click', () => openTelemetry($('#telemetry-summary')));
window.addEventListener('beforeunload', () => telemetryPanel.dispose(), { once: true });

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

/** Pane menu, closed sessions: both ask for a native confirmation first. */
function historyAction(op: 'purge_history' | 'compact_history', id: string) {
  void action(async () => {
    const response = await invoke<{ok:boolean;error?:string}>('confirm_history', { op, args: { id } });
    if (!response.ok) throw new Error(response.error ?? (op === 'purge_history' ? 'No se pudo eliminar la salida.' : 'No se pudo compactar el historial.'));
    await connect();
    notice(op === 'purge_history' ? 'Salida guardada eliminada. Se conservan el estado y los archivos.' : 'Eventos antiguos compactados. Se conservan los archivos y el último estado.');
  });
}

$('#restart-runner').addEventListener('click',()=>action(async()=>{
  if (await invoke<boolean>('restart_runner')) { await connect();notice('Servicio de sesiones reiniciado. Archivos e historial conservados.'); }
}));


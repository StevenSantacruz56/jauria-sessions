import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { NativeAttention } from './native-attention';
import { attachTerminalAttention } from './terminal-attention';
import { SessionAttention } from './attention';
import { DockBadge, dockUnreadCount } from './dock-badge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mountCodexConversation } from './codex-conversation';
import './codex-conversation.css';
import { validateSequence } from './events';
import { mountVerificationPanel } from './verification-panel';
import { mountReviewPanel } from './review-panel';
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
import { hasTaskWorkspace, taskStateLabel, taskStartBlock, validateDraft, type Project, type Task, type WorkspaceData } from './tasks';
import { shell, paneMarkup, icon } from './ui';
import { statusLabel, providerLabel, groupSessions, matchesSession, type SessionFilter } from './workspace';

type Session = { transport?:string; codex?:{generation:number;status:string;nativeThreadId:string|null}; taskId?: string | null; id: string; title: string; kind: string; cwd: string | null; workspace?: string | null; status: string; pid?: number; rows: number; cols: number };
type RunnerStatus = WorkspaceData & { claudeNativeConfigVersion?: number; normalTerminalVersion?: number; pid: number; generation: string; statusVersion?:number; workspaceRevision?:string; workspaceNotModified?:boolean; sessions: Session[]; lastSeq: number; retention?:{outputEncodedBytes:number;eventRows:number;maxOutputEncodedBytes:number;atCapacity:boolean} };
type Event = { seq: number; sessionId: string; kind: string; data: string };
type View = { session: Session; term: Terminal; fit: FitAddon; host: HTMLDivElement; sentSize: string; lastAttemptSize: string; resizeBusy: boolean; resizeAgain: boolean; input: OrderedInput; disposal: () => void; chat?:ReturnType<typeof mountCodexConversation> };
type Pane = { root: HTMLElement; host: HTMLElement; select: HTMLSelectElement; state: HTMLElement; cwd: HTMLElement; size: HTMLElement; id: string | null };

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
const handoffContexts=new Map<string,string>();
const codexDrafts=new Map<string,unknown>();
const panes: Pane[] = [];
let reviewPanel: ReturnType<typeof mountReviewPanel> | null = null;
let connected = false;
let connecting = false;
let smoke = false;
let renderedSeq = 0;
let runner: RunnerStatus | null = null;
let loopVersion = 0;
let activeLoop: Promise<void> = Promise.resolve();
const interactivePoll = new InteractivePoll();
let lastEvidence = 0;
const streamMetrics = {pages:0,lastPageMs:0,lastParseMs:0,lastTransferMs:0,lastYieldMs:0,maxParseMs:0,maxYieldMs:0,visibility:'unknown',pageBytes:0};
let statusAt = 0;
let busyAction = false;
let disposed = false;
let selectedDirectory: string | null = null;
let selectedTaskId: string | null = null;
let taskScreen: 'terminal' | 'draft' | 'detail' = 'terminal';
let workspaceBusy = false;
const preparingTasks = new Set<string>();
const taskErrors = new Map<string, string>();
let projectNavKey = '';
let projectOptionsKey = '';
let taskSessionsKey = '';
let lastTaskDetailKey = '';
let savedDraftId: string | null = null;
let draftSubmission: { key: string; id: string } | null = null;
// Historical terminal queries (DSR/DA/colors) must not become fresh input.
let replaying = false;
let replayThrough = 0;
let split = false;
let focusedPane = 0;
let filter: SessionFilter = 'open';
let query = '';
let sidebarKey = '';
let selectKey = '';
let stopTarget: string | null = null;
let stopGeneration:number|null=null;
const stopping = new Set<string>();
const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const newDialog = $<HTMLDialogElement>('#new-session-dialog');
const stopDialog = $<HTMLDialogElement>('#stop-session-dialog');
let dialogReturn: HTMLElement | null = null;
let newDialogVersion = 0;
const nativeAttention = new NativeAttention({
  granted: isPermissionGranted, request: requestPermission,
  send: () => sendNotification({ title: 'Jauría · Avisos de sesión', body: 'Hay actividad o un estado que revisar. Abre Jauría y consulta Avisos.' }),
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
  attention.see(attention.list([...views.values()].map(v => v.session)).filter(item => item.id === id));
  taskScreen = 'terminal';
  const target = panes[focusedPane];
  const other = panes.find(p => p !== target && p.id === id);
  if (other && split) { focusedPane = panes.indexOf(other); }
  else if (other) { assign(other, null); assign(target, id); }
  else assign(target, id);
  closeSidebar(); refresh(); focusView(activeView());
}
function setSplit(value: boolean) {
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
}

for (let i = 0; i < 2; i++) {
  const root = document.createElement('article');
  root.className = 'pane';
  root.setAttribute('aria-label', `Panel de sesión ${i + 1}`);
  root.innerHTML = paneMarkup(i);
  $('#panes').append(root);
  const pane: Pane = { root, host: root.querySelector('.terminal-host')!, select: root.querySelector('select')!, cwd: root.querySelector('.session-directory')!, state: root.querySelector('.session-state')!, size: root.querySelector('.terminal-size')!, id: null };
  panes.push(pane);
  pane.select.addEventListener('change', () => { focusedPane = i; if (pane.select.value) selectSession(pane.select.value); else { assign(pane, null); refresh(); } });
  root.addEventListener('pointerdown', () => { const consumed = pane.id ? attention.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  root.addEventListener('focusin', () => { const consumed = pane.id ? attention.consumeActivity(pane.id) : false; if (focusedPane !== i || consumed) { focusedPane = i; refresh(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
    button.addEventListener('click', () => action(async () => {
      const op = button.dataset.action!;
      root.querySelectorAll('details').forEach(d => d.open = false);
      if (op === 'shell') { await start(`shell-${crypto.randomUUID()}`, 'shell', `Shell ${i + 1}`, pane); return; }
      const view = pane.id ? views.get(pane.id) : null;
      if (!view) throw new Error('Selecciona una sesión primero.');
      if (op === 'stop') {
        stopTarget = view.session.id;stopGeneration=view.session.transport==='app-server'?view.session.codex?.generation??null:null;
        text('#stop-session-description', `${view.session.title} · ${providerLabel(view.session.kind)} · ${view.session.cwd ?? 'Sin carpeta'}`);
        stopDialog.showModal(); $<HTMLButtonElement>('#cancel-stop').focus(); return;
      }
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
      notice(`${button.textContent} enviado a ${view.session.title}.`);
      focusView(view);
    }));
  });
  new ResizeObserver(() => { if (pane.id) scheduleResize(views.get(pane.id)!); }).observe(pane.host);
}
function notice(message: string, error = false) { text('#notice-text', message); $('#notice').hidden = false; $('#notice').classList.toggle('error', error); }
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
async function request<T = unknown>(op: string, args: object): Promise<T> {
  const response = await invoke<{ ok: boolean; result: T; error?: string }>('runner_request', { op, args });
  if (!response.ok) throw new Error(response.error ?? 'El runner rechazó la operación.');
  return response.result;
}
function isLive(session: Session) { return ['running', 'starting'].includes(session.status); }
function refresh() {
  const handoffContext=handoffContexts.get(activeView()?.session.id??'');
  $('#handoff-context').hidden=taskScreen!=='terminal' || !handoffContext;
  if(handoffContext && $<HTMLTextAreaElement>('#handoff-context-text').value!==handoffContext){$<HTMLTextAreaElement>('#handoff-context-text').value=handoffContext;text('#handoff-context-status','');}
  if (!connected) text('#telemetry-summary','Recursos sin conexión');
  text('#connection-state', connecting ? 'Conectando…' : connected ? 'Conectado' : 'Sin conexión');
  $('#connection-dot').dataset.state = connected ? 'running' : 'failed';
  text('#runner-state', runner ? `${connected ? 'Runner activo' : 'Runner sin confirmar'} · PID ${runner.pid} · ${runner.sessions.length} sesiones` : 'Runner: sin consultar');
  const capabilities=runner as RunnerStatus & {telemetryVersion?:number;verificationVersion?:number;recoveryVersion?:number;handoffVersion?:number;codexVersion?:number;terminalSessionVersion?:number;projectLifecycleVersion?:number};
  $('#runner-upgrade').hidden = !connected || (capabilities?.telemetryVersion === 1 && capabilities?.verificationVersion === 1 && capabilities?.recoveryVersion === 1 && capabilities?.handoffVersion===1 && capabilities?.codexVersion===1 && capabilities?.terminalSessionVersion===1 && capabilities?.projectLifecycleVersion===1 && runner?.normalTerminalVersion===1 && runner?.claudeNativeConfigVersion===1);
  $<HTMLButtonElement>('#restart-runner').disabled = !connected || busyAction;
  text('#cursor', `Eventos procesados: ${renderedSeq}`);
  const retained=runner?.retention;
  text('#storage-usage',retained?`Historial: ${formatTelemetryBytes(retained.outputEncodedBytes)} codificados · ${retained.eventRows} eventos${retained.atCapacity?' · cuota alcanzada':''}. La cuota no representa espacio físico en disco.`:'Cuota de historial sin consultar.');
  $<HTMLButtonElement>('#connect').disabled = connecting || busyAction;
  const sessions = [...views.values()].map(v => v.session);
  const alerts = attention.list(sessions);
  dockBadge.setCount(connected && !replaying ? dockUnreadCount(alerts) : 0);
  const alertById = new Map(alerts.map(item => [item.id, item]));
  const unseen = alerts.filter(item => item.unseen && !isAttended(item.id)).length;
  const matches = (s: Session, f: SessionFilter, q: string) => f === 'attention'
    ? alertById.has(s.id) && matchesSession(s, 'all', q) : matchesSession(s, f, q);
  const count = (f: SessionFilter) => sessions.filter(s => matches(s, f, '')).length;
  $('#session-alerts').hidden = alerts.length === 0;
  const confirmed = alerts.filter(item => !item.stale).length;
  text('#session-alerts', `Avisos · ${confirmed}${alerts.some(item => item.stale) ? ' + ?' : ''}${unseen ? ` · ${unseen} sin ver` : ''}`);
  $('#session-alerts').title = alerts.map(a => `${views.get(a.id)?.session.title}: ${a.reason}`).join('\n');
  $('#attention-banner').hidden = unseen === 0;
  text('#attention-summary', `${unseen} ${unseen === 1 ? 'sesión con avisos nuevos' : 'sesiones con avisos nuevos'}.${!connected || alerts.some(item => item.stale) ? ' Hay estados sin confirmar.' : ''}`);
  nativeAttention.update(alerts);
  document.title = alerts.length ? `(${alerts.length}) Avisos · Jauría` : 'Jauría';
  const open = count('open');
  const occupied=sessions.filter(s=>!['exited','stopped','failed','interrupted','released'].includes(s.status)).length;
  if (filter === 'attention' && count('attention') === 0) filter = 'open';
  text('#capacity', `${occupied} de 2 plazas ocupadas`);
  text('#open-count', String(open)); text('#closed-count', String(count('closed')));
  text('#attention-count', `${count('attention')} ${count('attention') === 1 ? 'sesión con avisos' : 'sesiones con avisos'}`);
  $('#attention-filter').hidden = count('attention') === 0;
  text('#session-total', `${open} abiertas · ${count('closed')} en historial${count('attention') ? ` · ${count('attention')} con avisos` : ''}`);
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  for (const id of ['create-both', 'create-1', 'create-2']) $<HTMLButtonElement>(`#${id}`).disabled = !connected || busyAction || connecting || replaying;
  $('#fixtures').hidden = !smoke;
  for (const id of ['new-session', 'welcome-create']) $<HTMLButtonElement>(`#${id}`).disabled = !connected || busyAction || replaying || occupied >= 2;
  for (const id of ['choose-directory', 'use-home-directory']) $<HTMLButtonElement>(`#${id}`).disabled = busyAction || connecting;
  const terminalSupported = runner?.normalTerminalVersion === 1;
  $<HTMLInputElement>('input[name=provider][value=terminal]').disabled = !terminalSupported || busyAction;
  text('#new-terminal-status', connecting ? 'Conectando…' : !connected ? 'Sin conexión' : terminalSupported ? 'Shell zsh' : 'Requiere reiniciar runner');
  $<HTMLButtonElement>('#start-session').disabled = !selectedDirectory || !connected || connecting || busyAction || replaying || occupied >= 2 || (!document.querySelector<HTMLInputElement>('input[name=provider]:checked') || ($<HTMLInputElement>('input[name=provider]:checked').value === 'terminal' && !terminalSupported));
  for (const id of ['cancel-session', 'cancel-session-x']) $<HTMLButtonElement>(`#${id}`).disabled = busyAction;
  const selectionKey = JSON.stringify(sessions.map(s => [s.id, s.title, s.kind, s.status]));
  if (selectKey !== selectionKey) {
    selectKey = selectionKey;
    for (const pane of panes) {
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Elegir sesión';
      pane.select.replaceChildren(blank);
      for (const s of sessions) {
        const option = document.createElement('option'); option.value = s.id;
        option.textContent = `${s.title} · ${providerLabel(s.kind)}`;
        pane.select.append(option);
      }
    }
  }
  for (const pane of panes) {
    pane.select.value = pane.id ?? '';
    for (const option of Array.from(pane.select.options)) option.disabled = !!option.value && panes.some(p => p !== pane && (split || p === panes[0]) && p.id === option.value);
    const view = pane.id ? views.get(pane.id) : null;
    pane.root.hidden = pane === panes[1] && !split;
    pane.root.classList.toggle('is-focused', panes.indexOf(pane) === focusedPane);
    pane.state.textContent = view ? (stopping.has(view.session.id) && isLive(view.session) ? 'Terminando…' : statusLabel(view.session.status)) : 'Sin sesión';
    pane.state.dataset.state = view?.session.status ?? '';
    pane.cwd.textContent = view?.session.cwd ?? 'Sin carpeta de sesión';
    pane.cwd.title = view?.session.cwd ?? '';
    pane.size.textContent = view?.session.transport==='app-server' ? 'Conversación' : view ? `${view.term.cols} × ${view.term.rows}` : '—';
    pane.root.querySelector('.pane-provider')!.innerHTML = icon(view?.session.kind === 'claude' ? 'spark' : 'terminal');
    const history = pane.root.querySelector<HTMLElement>('.history-banner')!;
    history.hidden = !view || isLive(view.session);
    history.textContent = view ? (['exited', 'stopped', 'released'].includes(view.session.status) ? 'Historial · Solo lectura' : `${statusLabel(view.session.status)} · Entrada deshabilitada`) : '';
    (pane.root.querySelector('.fixture-controls') as HTMLElement).hidden = !smoke;
    if (view) view.term.options.disableStdin = view.session.transport==='app-server' || replaying || !connected || !isLive(view.session) || stopping.has(view.session.id);
    pane.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const kind = button.dataset.action!;
      if(view?.session.transport==='app-server' && kind==='interrupt'){button.hidden=true;return;}
      if(kind==='interrupt')button.hidden=false;
      if (kind === 'release') {
        button.hidden = view?.session.status !== 'needs_attention';
        button.disabled = !connected || connecting || busyAction || replaying; return;
      }
      button.disabled = !connected || connecting || busyAction || replaying || (kind !== 'shell' && (!view || !isLive(view.session) || stopping.has(view.session.id))) || (['ping', 'size', 'flood'].includes(kind) && view?.session.kind !== 'fixture');
    });
  }
  for(const view of views.values())view.chat?.select(connected && !replaying && taskScreen==='terminal' && panes.some((pane,index)=>pane.id===view.session.id && (index===0||split))?view.session:null);
  const hasVisibleSession = panes.some((pane, index) => !!pane.id && (index === 0 || split));
  $('#welcome').hidden = hasVisibleSession || taskScreen !== 'terminal';
  $('#panes').hidden = !hasVisibleSession || taskScreen !== 'terminal';
  $('#panes').dataset.split = String(split);
  $('#toggle-split').setAttribute('aria-pressed', String(split));
  $<HTMLButtonElement>('#toggle-split').disabled = sessions.length < 2;
  const current = activeView()?.session;
  text('#workspace-title', current?.title ?? 'Tu espacio de trabajo');
  text('#workspace-breadcrumb', current?.cwd?.split('/').filter(Boolean).pop() ?? (current ? providerLabel(current.kind) : 'Sesiones locales'));
  text('#inspector-provider', current ? providerLabel(current.kind) : '');
  text('#inspector-title', current?.title ?? 'Sin sesión seleccionada');
  text('#inspector-description', current ? 'El estado indica la disponibilidad del proceso; los permisos y las respuestas aparecen en la terminal.' : 'Selecciona una sesión para ver su carpeta y su estado.');
  $('#purge-history').hidden = !current || !['exited','stopped','failed','interrupted','released'].includes(current.status);
  $('#compact-history').hidden=$('#purge-history').hidden;
  text('#inspector-state', current ? statusLabel(current.status) : '—');
  text('#inspector-cwd', current?.cwd ?? '—'); text('#inspector-id', current?.id ?? '—');
  $<HTMLButtonElement>('#copy-session-id').disabled = !current;
  $<HTMLButtonElement>('#new-in-folder').disabled = !current?.cwd || !connected || busyAction || occupied >= 2 || replaying;
  refreshTasks(sessions);
  const key = JSON.stringify([sessions, alerts, filter, query, taskScreen, current?.id]);
  if (sidebarKey !== key) {
    sidebarKey = key;
    const list = $('#session-list'); list.replaceChildren();
    for (const group of groupSessions(sessions.filter(s => matches(s, filter, query)))) {
      const section = document.createElement('section'); section.className = 'session-group';
      const heading = document.createElement('div'); heading.className = 'group-heading';
      heading.innerHTML = icon('folder'); const name = document.createElement('span'); name.textContent = group.name; heading.append(name); heading.title = group.path ?? group.name; section.append(heading);
      for (const s of group.sessions) {
        const button = document.createElement('button'); button.className = 'session-item'; button.dataset.selected = String(taskScreen === 'terminal' && s.id === current?.id); button.setAttribute('aria-current', taskScreen === 'terminal' && s.id === current?.id ? 'true' : 'false');
        button.innerHTML = `<span class="state-dot"></span><span class="session-item-copy"><span class="session-item-title"></span><span class="session-item-meta"></span></span>`;
        const alert = alertById.get(s.id);
        button.dataset.attention = String(!!alert); button.dataset.unseen = String(!!alert?.unseen);
        (button.querySelector('.state-dot') as HTMLElement).dataset.state = alert ? 'attention' : s.status;
        button.querySelector('.session-item-title')!.textContent = s.title;
        button.querySelector('.session-item-meta')!.textContent = `${providerLabel(s.kind)} · ${alert ? `${alert.unseen ? 'Sin ver · ' : 'Visto · '}${alert.reason}` : statusLabel(s.status)}`;
        button.title = `${s.title} · ${s.cwd ?? providerLabel(s.kind)}${alert ? ` · ${alert.reason}` : ''}`;
        button.addEventListener('click', () => selectSession(s.id)); section.append(button);
      }
      list.append(section);
    }
    if (!list.children.length) {
      const empty = document.createElement('p'); empty.className = 'list-empty';
      empty.textContent = query ? 'No hay sesiones que coincidan.' : filter === 'closed' ? 'Las sesiones cerradas aparecerán aquí.' : filter === 'attention' ? 'Sin avisos observados. Las terminales no tienen seguimiento de permisos.' : 'Inicia una sesión para verla aquí.'; list.append(empty);
    }
  }
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
  if (current) { if (current.session.status !== session.status) current.lastAttemptSize = ''; current.session = session; configureConversation(current); return current; }
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
    if (!connected || inputVersion !== loopVersion) throw new Error('La conexión cambió; no se reenvía la entrada.');
    await request('input', { id: session.id, data });
  }, e => notice(`${message(e)} Entrada suspendida; reconecta antes de continuar.`, true));
  const subscription = term.onData(data => {
    if (!replaying && connected && !stopping.has(session.id) && isLive(views.get(session.id)!.session)) {
      try { interactivePoll.activity(); void input.enqueue(data).catch(e => notice(message(e), true)); }
      catch (e) { notice(message(e), true); }
    }
  });
  const signal = () => { if (!replaying && connected && inputVersion === loopVersion && !isAttended(session.id)) attention.signal(session.id, 'bell'); };
  const terminalAttention = attachTerminalAttention(term, signal);
  const view:View = { session, term, fit, host, input, sentSize: `${session.cols}x${session.rows}`, lastAttemptSize: '', resizeBusy: false, resizeAgain: false, disposal: () => { subscription.dispose(); keyboard.dispose(); terminalAttention.dispose(); } };
  term.options.disableStdin = replaying;
  views.set(session.id, view);configureConversation(view);
  return view;
}
function updateStatus(status: RunnerStatus) {
  if (runner && runner.generation !== status.generation) throw new Error('El runner cambió de generación. Pulsa Conectar / Reintentar para reconstruir desde cero.');
  if (status.workspaceNotModified && runner && runner.generation === status.generation) status = { ...status, projects:runner.projects, tasks:runner.tasks };
  runner = status;
  for (const session of status.sessions) { const previous = views.get(session.id)?.session.status; if (!replaying && previous && session.transport !== 'app-server') attention.observeEnd(session.id, previous, session.status); ensure(session);if(!isLive(session))stopping.delete(session.id);}
  refresh();
}
function scheduleResize(view: View) {
  if (!view || view.session.transport==='app-server' || resizeTimers.has(view.session.id)) return;
  resizeTimers.set(view.session.id, setTimeout(() => { resizeTimers.delete(view.session.id); resizeView(view); }, 80));
}
function resizeView(view: View) {
  if (!view || replaying || !connected || !view.host.isConnected || view.host.clientWidth < 20 || view.host.clientHeight < 20) return;
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
  void request<{ cols: number; rows: number }>('resize', { id: view.session.id, rows: view.term.rows, cols: view.term.cols }).then(actual => { view.sentSize = `${actual.cols}x${actual.rows}`; }).catch(e => notice(`No se pudo ajustar ${view.session.title}: ${message(e)}`, true)).finally(() => {
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
async function start(id: string, kind: string, title: string, pane: Pane, cwd?: string) {
  const session = await request<Session>('start', { id, kind, title, rows: 24, cols: 80, ...(cwd ? { cwd } : {}) });
  presentSession(session, pane);
  notice(`${title}: inicio solicitado. Esperando salida y estado reales.`);
}
function presentSession(session: Session, pane: Pane) {
  taskScreen = 'terminal';
  const id = session.id;
  const view = ensure(session);
  const other = panes.find(p => p !== pane && p.id === id);
  if (other) assign(other, null);
  assign(pane, id); focusedPane = panes.indexOf(pane);
  if (focusedPane === 1) split = true;
  filter = 'open'; refresh(); scheduleResize(view); focusView(view);
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
async function poll(version: number) {
  try {
    while (connected && version === loopVersion && !disposed) {
      if (Date.now() - statusAt > 1000) { updateStatus(await request<RunnerStatus>('status', runner?.statusVersion === 2 ? {workspaceAfter:runner.workspaceRevision} : {})); statusAt = Date.now(); }
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
      const pageStarted=performance.now();
      const page = await request<{ events: Event[]; lastSeq: number; hasMore: boolean }>('events', { after: renderedSeq, limit: 64 });
      const transferred=performance.now();
      if (version !== loopVersion) return;
      let pageSeq = renderedSeq;
      let pendingWrites: Promise<void>[] = [];
      const flushWrites = async () => { await Promise.all(pendingWrites); pendingWrites = []; };
      for (const event of page.events) {
        if (event.seq <= pageSeq) continue;
        validateSequence(pageSeq,event);
        if(event.kind==='provider'){
          views.get(event.sessionId)?.chat?.applyEvent(event);
        } else if (event.kind === 'output') {
          const view = views.get(event.sessionId) ?? ensure({ id: event.sessionId, title: event.sessionId, kind: 'unknown', cwd: null, status: 'recuperando', rows: 24, cols: 80 });
          if (!replaying) interactivePoll.output();
          if (!replaying && views.get(event.sessionId)?.session.transport !== 'app-server' && !isAttended(event.sessionId)) attention.signal(event.sessionId, 'output');
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
          if ($('#notice-text').textContent?.startsWith('Conectado. Recuperando')) $('#notice').hidden = true;
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
      if (!page.hasMore && page.events.length) for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
      // Status/state transitions refresh the shell above. Output only changes
      // xterm and the event counter; rebuilding chrome every 12ms adds latency.
      if (page.events.length) text('#cursor', `Eventos procesados: ${renderedSeq}`);
      await evidence();
      const yielding=performance.now();
      if (!page.hasMore) await interactivePoll.wait(document.visibilityState === 'visible');
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
    const previousSelection = panes.map(p => p.id);
    for (const pane of panes) assign(pane, null);
    for (const view of views.values()) { if(view.chat)codexDrafts.set(view.session.id,view.chat.saveDraft(view.session.id)); view.chat?.dispose(); view.disposal(); view.term.dispose(); view.host.remove(); }
    views.clear(); stopping.clear(); selectKey = ''; sidebarKey = ''; renderedSeq = 0; runner = null; statusAt = 0;
    const config = await invoke<{ dataDir: string; socket: string; status: RunnerStatus; smoke: boolean }>('connect_runner');
    smoke = config.smoke; connected = true;
    replayThrough = config.status.lastSeq;
    replaying = replayThrough > 0;
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
      if (!matchesSession(preferred.session, filter, query)) filter = isLive(preferred.session) ? 'open' : matchesSession(preferred.session, 'attention', '') ? 'attention' : 'closed';
    }
    if (!split) assign(panes[1], null);
    $('#notice').hidden = replayThrough === 0;
    for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
    if (replaying) notice('Conectado. Recuperando historial…');
    const version = loopVersion;
    activeLoop = poll(version);
  } catch (e) { connected = false; notice(`No se pudo conectar: ${message(e)}`, true); }
  finally { connecting = false; refresh(); }
}
function taskData() {
  return hasTaskWorkspace(runner) ? { projects: runner!.projects!, tasks: runner!.tasks! } : { projects: [], tasks: [] };
}
function selectedTask() { return taskData().tasks.find(task => task.id === selectedTaskId); }
function returnToTerminal() {
  taskScreen = 'terminal'; refresh();
  for (const pane of panes) if (pane.id) scheduleResize(views.get(pane.id)!);
  if (activeView()) focusView(activeView());
  else if (panes.some(pane => pane.id)) panes[focusedPane].select.focus();
  else $('#welcome-create').focus();
}
function showTask(id: string) {
  const task = taskData().tasks.find(item => item.id === id);
  if (taskData().projects.find(project => project.id === task?.projectId)?.closed) { notice('Reabre el proyecto desde Proyectos cerrados para volver a sus tareas.'); return; }
  selectedTaskId = id; taskScreen = 'detail'; closeSidebar(); refresh(); $('#task-detail-title').focus();
}
function openTaskDraft() {
  if (!hasTaskWorkspace(runner) || workspaceBusy || !taskData().projects.some(project => !project.closed)) return;
  taskScreen = 'draft'; closeSidebar(); refresh();
  $<HTMLSelectElement>('#task-project').focus();
}
function refreshTasks(sessions: Session[]) {
  const supported = hasTaskWorkspace(runner);
  const { projects, tasks } = taskData();
  const openProjects = projects.filter(project => !project.closed);
  const closedProjects = projects.filter(project => project.closed);
  const lifecycleSupported = runner?.projectLifecycleVersion === 1;
  if (projects.find(project => project.id === selectedTask()?.projectId)?.closed) { selectedTaskId = null; taskScreen = 'terminal'; }
  const available = supported && connected && !connecting && !replaying;
  $('#workspace-upgrade').hidden = supported || !runner;
  text('#workspace-upgrade', 'Proyectos y tareas requieren un runner actualizado (workspace v1). Las sesiones siguen disponibles.');
  $<HTMLButtonElement>('#register-project').disabled = !available || workspaceBusy;
  $<HTMLButtonElement>('#new-task').disabled = !supported || workspaceBusy || openProjects.length === 0;
  const optionsKey = JSON.stringify(openProjects.map(project => [project.id, project.name, project.root]));
  if (supported && optionsKey !== projectOptionsKey) {
    projectOptionsKey = optionsKey;
    const select = $<HTMLSelectElement>('#task-project'); const previous = select.value;
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Elegir proyecto';
    select.replaceChildren(blank);
    for (const project of openProjects) {
      const option = document.createElement('option'); option.value = project.id; option.textContent = `${project.name} · ${project.root}`; select.append(option);
    }
    select.value = openProjects.some(project => project.id === previous) ? previous : openProjects.length === 1 ? openProjects[0].id : '';
  }
  const key = JSON.stringify([supported, available, lifecycleSupported, workspaceBusy, busyAction, projects, tasks, selectedTaskId, taskScreen]);
  if (key !== projectNavKey) {
    projectNavKey = key;
    const nav = $('#project-list'); nav.replaceChildren();
    if (supported && openProjects.length === 0) {
      const hint = document.createElement('p'); hint.className = 'workspace-hint'; hint.textContent = closedProjects.length ? 'No hay proyectos abiertos. Reabre uno abajo o registra otra carpeta.' : 'Registra una carpeta Git para crear tareas con su propio worktree.'; nav.append(hint);
    }
    for (const project of openProjects) {
      const group = document.createElement('section'); group.className = 'project-group';
      const heading = document.createElement('div'); heading.className = 'group-heading'; heading.innerHTML = icon('folder');
      const name = document.createElement('span'); name.textContent = project.name;
      const meta = document.createElement('small'); meta.textContent = `Al registrar: ${project.head.slice(0, 10)}`;
      heading.append(name);
      if (lifecycleSupported) {
        const close = document.createElement('button'); close.type = 'button'; close.className = 'quiet project-close'; close.textContent = 'Cerrar';
        close.dataset.projectId = project.id; close.setAttribute('aria-label', `Cerrar proyecto ${project.name}`); close.title = 'Ocultar proyecto conservando tareas, archivos e historial';
        close.disabled = !available || workspaceBusy || busyAction;
        close.addEventListener('click', () => { void setProjectClosed(project.id, true); }); heading.append(close);
      }
      heading.append(meta); heading.title = `${project.root}\n${project.commonDir}\nReferencia al registrar: ${project.branch ?? 'HEAD separado'} · ${project.head}`; group.append(heading);
      const projectTasks = tasks.filter(task => task.projectId === project.id);
      for (const task of projectTasks) {
        const button = document.createElement('button'); button.className = 'session-item task-item';
        const selected = taskScreen === 'detail' && task.id === selectedTaskId;
        button.dataset.selected = String(selected); button.setAttribute('aria-current', String(selected));
        const dot = document.createElement('span'); dot.className = 'state-dot'; dot.dataset.state = task.state;
        const copy = document.createElement('span'); copy.className = 'session-item-copy';
        const title = document.createElement('span'); title.className = 'session-item-title'; title.textContent = task.title;
        const state = document.createElement('span'); state.className = 'session-item-meta'; state.textContent = taskStateLabel(task.state);
        copy.append(title, state); button.append(dot, copy); button.title = task.title;
        button.addEventListener('click', () => showTask(task.id)); group.append(button);
      }
      if (!projectTasks.length) {
        const hint = document.createElement('p'); hint.className = 'workspace-hint'; hint.textContent = 'Sin tareas. Crea un borrador con Nueva tarea.'; group.append(hint);
      }
      nav.append(group);
    }
    $('#closed-projects').hidden = closedProjects.length === 0;
    text('#closed-projects-summary', `Proyectos cerrados (${closedProjects.length})`);
    const closedList = $('#closed-project-list'); closedList.replaceChildren();
    for (const project of closedProjects) {
      const row = document.createElement('div'); row.className = 'closed-project-row';
      const name = document.createElement('span'); name.textContent = project.name; name.title = project.root;
      const reopen = document.createElement('button'); reopen.type = 'button'; reopen.textContent = 'Reabrir'; reopen.className = 'quiet';
      reopen.setAttribute('aria-label', `Reabrir proyecto ${project.name}`); reopen.disabled = !available || !lifecycleSupported || workspaceBusy || busyAction;
      reopen.addEventListener('click', () => { void setProjectClosed(project.id, false); }); row.append(name, reopen); closedList.append(row);
    }
  }
  $('#task-panel').hidden = taskScreen === 'terminal';
  $('#task-form').hidden = taskScreen !== 'draft';
  const task = selectedTask();
  $('#task-detail').hidden = taskScreen !== 'detail' || !task;
  $('#show-task').hidden = !task || taskScreen !== 'terminal';
  $('#workspace-breadcrumb').hidden = taskScreen !== 'terminal';
  if (taskScreen !== 'terminal') {
    text('#workspace-title', taskScreen === 'draft' ? 'Nueva tarea' : task?.title ?? 'Tarea no disponible');
  }
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('#task-form input, #task-form textarea, #task-form select').forEach(field => field.disabled = workspaceBusy || !!savedDraftId || !supported);
  $<HTMLButtonElement>('#save-task').disabled = !available || workspaceBusy || openProjects.length === 0;
  text('#save-task', workspaceBusy && taskScreen === 'draft' ? 'Guardando…' : savedDraftId ? 'Consultar borrador guardado' : 'Guardar borrador');
  $('#review-panel-host').hidden=(runner as RunnerStatus & {workflowVersion?:number})?.workflowVersion!==1;
  reviewPanel?.select(taskScreen === 'detail' && (runner as RunnerStatus & {workflowVersion?:number})?.workflowVersion === 1 ? task ?? null : null);
  if (!task) return;
  const detailKey = JSON.stringify(task);
  if (detailKey !== lastTaskDetailKey) {
    lastTaskDetailKey = detailKey;
    text('#task-detail-title', task.title);
    text('#task-project-name', projects.find(project => project.id === task.projectId)?.name ?? task.projectId);
    text('#task-state', taskStateLabel(task.state));
    text('#task-branch-label', task.state === 'draft' ? 'Rama prevista' : 'Rama de tarea');
    text('#task-path-label', task.state === 'draft' ? 'Carpeta prevista' : 'Carpeta aislada');
    text('#task-base', task.baseSha ? task.baseSha.slice(0, 10) : 'Sin base registrada'); $('#task-base').title = task.baseSha;
    text('#task-branch', task.branch || 'Sin rama preparada');
    text('#task-worktree', task.worktreePath || 'Sin carpeta preparada');
    text('#task-detail-objective', task.objective);
    text('#task-detail-criteria', task.acceptanceCriteria || 'Sin criterios de aceptación.');
    text('#task-backend-error', task.error ?? ''); $('#task-backend-error').hidden = !task.error;
  }
  text('#task-action-error', taskErrors.get(task.id) ?? ''); $('#task-action-error').hidden = !taskErrors.has(task.id);
  const preparing = preparingTasks.has(task.id) || task.state === 'preparing';
  const prepare = $<HTMLButtonElement>('#prepare-task');
  prepare.hidden = task.state === 'ready'; prepare.disabled = !available || workspaceBusy || preparing || task.state === 'needs_attention';
  prepare.textContent = preparing ? 'Preparando worktree…' : task.state === 'needs_attention' ? 'Preparación bloqueada' : 'Preparar worktree';
  const revalidate=$<HTMLButtonElement>('#revalidate-task');
  revalidate.hidden=task.state!=='needs_attention' || (runner as RunnerStatus & {recoveryVersion?:number})?.recoveryVersion!==1;
  revalidate.disabled=!available || workspaceBusy || preparing || busyAction;
  const blocked = taskStartBlock(task, sessions);
  for (const kind of ['codex', 'claude']) {
    const button = $<HTMLButtonElement>(`#start-task-${kind}`);
    button.hidden = task.state !== 'ready'; button.disabled = !available || workspaceBusy || busyAction || !!blocked;
  }
  text('#task-action-hint', preparing ? 'Preparación solicitada; puede tardar unos segundos. No inicia un proveedor.' : task.state === 'ready' ? blocked ?? 'Iniciar abre la sesión del proveedor. Copia el objetivo cuando quieras; no se envía automáticamente.' : task.state === 'needs_attention' ? 'La preparación requiere atención. Los recursos parciales se conservan. Revisa la carpeta y la rama; Revalidar comprueba su identidad sin recrear ni limpiar archivos.' : 'Preparar crea una rama y un worktree aislado desde la base registrada.');
  const related = sessions.filter(session => session.taskId === task.id);
  const sessionKey = JSON.stringify([task.id, related.map(session => [session.id, session.title, session.status])]);
  if (sessionKey !== taskSessionsKey) {
    taskSessionsKey = sessionKey;
    const list = $('#task-sessions'); list.replaceChildren();
    for (const session of related) {
      const button = document.createElement('button'); button.textContent = `${session.title} · ${statusLabel(session.status)}`;
      button.addEventListener('click', () => selectSession(session.id)); list.append(button);
    }
    if (!related.length) { const hint = document.createElement('p'); hint.className = 'task-help'; hint.textContent = 'Todavía no hay sesiones para esta tarea.'; list.append(hint); }
  }
}
function workspaceContext() {
  const version = loopVersion; const generation = runner?.generation;
  return () => {
    if (version !== loopVersion || generation !== runner?.generation) throw new Error('La conexión cambió. Consulta el estado actual antes de continuar.');
  };
}
async function refreshWorkspace(check: () => void) {
  check(); const status = await request<RunnerStatus>('status', {}); check(); updateStatus(status);
}
// Task launch shares terminal creation, assignment and focus with standalone start.
// Only the explicit provider buttons call this; no objective is sent as PTY input.
export async function startTask(id: string, kind: 'codex' | 'claude') {
  if (!hasTaskWorkspace(runner) || !connected || connecting || replaying || workspaceBusy || busyAction) return;
  const task = taskData().tasks.find(item => item.id === id);
  if (!task) throw new Error('La tarea ya no está disponible.');
  const blocked = taskStartBlock(task, [...views.values()].map(view => view.session));
  if (blocked) throw new Error(blocked);
  const pane = panes[focusedPane]; const check = workspaceContext();
  const sessionId = `${kind}-${crypto.randomUUID()}`;
  workspaceBusy = true; taskErrors.delete(id); refresh();
  try {
    const session = await request<Session>('start_task', { id, sessionId, kind, rows: 24, cols: 80 }); check();
    presentSession(session, pane);
    notice(`${providerLabel(kind)}: sesión abierta. El objetivo no se ha enviado.`);
  } catch (e) {
    taskErrors.set(id, message(e)); notice(message(e), true);
  } finally {
    // A failed RPC may still persist task/session resources on the runner.
    try { await refreshWorkspace(check); } catch (e) {
      if (!taskErrors.has(id)) { taskErrors.set(id, message(e)); notice(`Consulta el estado antes de reintentar: ${message(e)}`, true); }
    }
    workspaceBusy = false; refresh();
  }
}
async function setProjectClosed(id: string, closed: boolean) {
  if (workspaceBusy || busyAction || !connected || connecting || replaying || runner?.projectLifecycleVersion !== 1) return;
  const check = workspaceContext(); workspaceBusy = true; $('#project-error').hidden = true; refresh();
  let confirmed = false;
  try {
    const project = await request<Project>(closed ? 'close_project' : 'reopen_project', { id }); check();
    confirmed = project.closed === closed;
    notice(closed ? 'Proyecto cerrado. Puedes reabrirlo en Proyectos cerrados; sus tareas, archivos e historial se conservan.' : 'Proyecto reabierto. Sus tareas vuelven a estar disponibles.');
  } catch (e) { text('#project-error', message(e)); $('#project-error').hidden = false; }
  finally {
    try { await refreshWorkspace(check); } catch (e) { confirmed = false; text('#project-error', `Consulta el estado antes de reintentar: ${message(e)}`); $('#project-error').hidden = false; }
    workspaceBusy = false; refresh();
    if (confirmed) {
      if (closed) $('#closed-projects-summary').focus();
      else document.querySelector<HTMLButtonElement>(`.project-close[data-project-id="${id}"]`)?.focus();
    }
  }
}
$('#register-project').addEventListener('click', async () => {
  if (workspaceBusy || !hasTaskWorkspace(runner) || !connected || connecting || replaying) return;
  const check = workspaceContext(); workspaceBusy = true; $('#project-error').hidden = true; refresh();
  try {
    const directory = await invoke<string | null>('select_directory'); check();
    if (directory === null) return;
    const project = await request<Project>('register_project', { id: `project-${crypto.randomUUID()}`, path: directory }); check();
    if (project.closed) notice('Este proyecto está cerrado. Reábrelo desde Proyectos cerrados.');
    await refreshWorkspace(check);
  } catch (e) { text('#project-error', message(e)); $('#project-error').hidden = false; try { await refreshWorkspace(check); } catch { /* preserve picker/registration error */ } }
  finally { workspaceBusy = false; refresh(); }
});
$('#new-task').addEventListener('click', openTaskDraft);
$('#cancel-task').addEventListener('click', returnToTerminal);
$('#back-terminal').addEventListener('click', returnToTerminal);
$('#show-task').addEventListener('click', () => { if (selectedTaskId) showTask(selectedTaskId); });
$('#task-form').addEventListener('submit', event => {
  event.preventDefault();
  if (workspaceBusy || !hasTaskWorkspace(runner) || !connected || connecting || replaying) return;
  const projectId = $<HTMLSelectElement>('#task-project').value;
  const title = $<HTMLInputElement>('#task-title').value;
  const objective = $<HTMLTextAreaElement>('#task-objective').value;
  const acceptanceCriteria = $<HTMLTextAreaElement>('#task-criteria').value;
  const error = validateDraft(projectId, title, objective, acceptanceCriteria);
  if (error) { text('#task-form-error', error); $('#task-form-error').hidden = false; return; }
  const check = workspaceContext(); workspaceBusy = true; refresh();
  void (async () => {
    try {
      if (!savedDraftId) {
        const payloadKey = JSON.stringify([projectId, title, objective, acceptanceCriteria]);
        if (!draftSubmission || draftSubmission.key !== payloadKey) draftSubmission = { key: payloadKey, id: `task-${crypto.randomUUID()}` };
        const task = await request<Task>('create_task', { id: draftSubmission.id, projectId, title, objective, acceptanceCriteria }); check(); savedDraftId = task.id;
      }
      await refreshWorkspace(check);
      const id = savedDraftId!;
      if (!taskData().tasks.some(task => task.id === id)) throw new Error('El borrador se guardó; vuelve a consultar su estado.');
      savedDraftId = null; draftSubmission = null;
      $<HTMLFormElement>('#task-form').reset(); $('#task-form-error').hidden = true;
      if (taskScreen === 'draft') showTask(id);
      notice('Borrador guardado. Puedes preparar el worktree cuando quieras.');
    } catch (e) {
      text('#task-form-error', `${savedDraftId ? 'El borrador ya se guardó. ' : ''}${message(e)}`); $('#task-form-error').hidden = false;
      try { await refreshWorkspace(check); } catch { /* keep all draft values and its error */ }
    }
    finally { workspaceBusy = false; refresh(); }
  })();
});
$('#prepare-task').addEventListener('click', () => {
  const task = selectedTask();
  if (!task || !hasTaskWorkspace(runner) || !connected || connecting || replaying || workspaceBusy || preparingTasks.has(task.id) || task.state !== 'draft') return;
  const id = task.id; const check = workspaceContext(); preparingTasks.add(id); taskErrors.delete(id); refresh();
  void (async () => {
    try { await request<Task>('prepare_task', { id }); check(); notice('Worktree preparado. Inicia un proveedor cuando quieras.'); }
    catch (e) { taskErrors.set(id, message(e)); }
    finally {
      // Partial preparation is persisted even when the RPC returns an error.
      try { await refreshWorkspace(check); } catch (e) { if (!taskErrors.has(id)) taskErrors.set(id, message(e)); }
      preparingTasks.delete(id); refresh();
    }
  })();
});
$('#revalidate-task').addEventListener('click', () => {
  const task=selectedTask();
  if (!task || task.state!=='needs_attention' || !connected || connecting || replaying || workspaceBusy || busyAction) return;
  const id=task.id; const check=workspaceContext(); workspaceBusy=true; taskErrors.delete(id); refresh();
  void (async () => {
    try {await request<Task>('revalidate_task',{id});check();notice('Carpeta validada. Los archivos y la rama se conservan.');}
    catch(e){taskErrors.set(id,message(e));}
    finally {try {await refreshWorkspace(check);} catch(e){if(!taskErrors.has(id))taskErrors.set(id,message(e));} workspaceBusy=false;refresh();}
  })();
});
for (const kind of ['codex', 'claude'] as const) $(`#start-task-${kind}`).addEventListener('click', () => {
  const id = selectedTaskId; if (id) void startTask(id, kind).catch(e => { taskErrors.set(id, message(e)); refresh(); });
});
$('#copy-task-objective').addEventListener('click', () => {
  const task = selectedTask(); if (task) void navigator.clipboard.writeText(task.objective).then(() => notice('Objetivo copiado.')).catch(e => notice(message(e), true));
});
$('#task-panel').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); returnToTerminal(); }
});

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
for (const id of ['new-session', 'welcome-create']) $(`#${id}`).addEventListener('click', () => openNew());
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
$('#dismiss-notice').addEventListener('click', () => $('#notice').hidden = true);
$('#toggle-split').addEventListener('click', () => setSplit(!split));
$('#toggle-inspector').addEventListener('click', () => setInspector($('#inspector').hidden));
$('#close-inspector').addEventListener('click', () => setInspector(false));
$('#open-diagnostics').addEventListener('click', () => { setInspector(true); $<HTMLDetailsElement>('#diagnostics').open = true; });
$('#toggle-sidebar').addEventListener('click', () => {
  const open = $('.workspace-shell').classList.toggle('sidebar-open'); $('#sidebar-scrim').hidden = !open;
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
});
$('#sidebar-scrim').addEventListener('click', closeSidebar);
$('#session-search').addEventListener('input', () => { query = $<HTMLInputElement>('#session-search').value; refresh(); });
window.addEventListener('focus', () => { const id = activeView()?.session.id; if (id && taskScreen === 'terminal' && attention.consumeActivity(id)) refresh(); });
function isAttended(id: string) { return document.visibilityState === 'visible' && document.hasFocus() && taskScreen === 'terminal' && activeView()?.session.id === id; }
function showAttention() {
  filter = 'attention'; query = ''; $<HTMLInputElement>('#session-search').value = '';
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
  await nativeAttention.enableFromClick(attention.list([...views.values()].map(v => v.session))); button.disabled = false;
});
window.addEventListener('beforeunload', () => nativeAttention.disable(), { once: true });
window.addEventListener('beforeunload', () => { void dockBadge.dispose(); }, { once: true });
$('#session-alerts').addEventListener('click', showAttention);
$('#review-attention').addEventListener('click', showAttention);
$('#see-attention').addEventListener('click', () => {
  attention.see(attention.list([...views.values()].map(v => v.session))); refresh(); ($('#session-alerts').hidden ? $('#toggle-inspector') : $('#session-alerts')).focus();
});
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.addEventListener('click', () => { if (button.dataset.filter === 'attention') showAttention(); else { filter = button.dataset.filter as SessionFilter; refresh(); } }));
$('#copy-session-id').addEventListener('click', () => { const id = activeView()?.session.id; if (id) void navigator.clipboard.writeText(id).catch(e => notice(message(e), true)); });
const theme = $<HTMLSelectElement>('#theme-select');
try { theme.value = localStorage.getItem('aw-theme') ?? 'system'; } catch { /* appearance is optional */ }
document.documentElement.dataset.theme = theme.value;
theme.addEventListener('change', () => { document.documentElement.dataset.theme = theme.value; try { localStorage.setItem('aw-theme', theme.value); } catch { /* optional */ } });
function handleAppShortcut(event: KeyboardEvent): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || newDialog.open || stopDialog.open) return false;
  const key = event.key.toLowerCase();
  if (!['n', 'k', 'i'].includes(key)) return false;
  if (event.type !== 'keydown') return true;
  event.preventDefault(); event.stopPropagation();
  if (key === 'n' && !$<HTMLButtonElement>('#new-session').disabled) openNew();
  if (key === 'k') {
    if (window.innerWidth <= 860) {
      $('.workspace-shell').classList.add('sidebar-open'); $('#sidebar-scrim').hidden = false;
      $('#toggle-sidebar').setAttribute('aria-expanded', 'true');
    }
    // WebKit ignores focus while CSS visibility is still transitioning.
    // Blur immediately; a guarded retry after the drawer settles never sends
    // intervening keystrokes to the CLI or steals a later deliberate focus.
    const search = $<HTMLInputElement>('#session-search');
    (document.activeElement as HTMLElement | null)?.blur();
    void getComputedStyle($('#sidebar')).visibility;
    search.focus();
    setTimeout(() => {
      if (!newDialog.open && !stopDialog.open && taskScreen !== 'draft' && document.activeElement === document.body && (window.innerWidth > 860 || $('.workspace-shell').classList.contains('sidebar-open'))) search.focus();
    }, 200);
  }
  if (key === 'i') setInspector($('#inspector').hidden);
  return true;
}
window.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).closest('.terminal-view, input, textarea, select, [contenteditable]')) return;
  handleAppShortcut(event);
});
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
window.addEventListener('beforeunload', () => { disposed = true; loopVersion++; });
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

const verificationHost=$('#verification-panel-host');
const verificationPanel=mountVerificationPanel(verificationHost,request,async<T>(op:string,args:Record<string,unknown>):Promise<T>=>{
  const response=await invoke<{ok:boolean;result:T;error?:string}>(op==='run_verification'?'confirm_verification':'confirm_workflow',op==='run_verification'?{args}:{op,args});
  if(!response.ok)throw new Error(response.error??'No se pudo completar la verificación.');return response.result;
},(id,runs)=>reviewPanel?.setVerifications(id,runs));
window.addEventListener('beforeunload',()=>verificationPanel.dispose(),{once:true});
reviewPanel = mountReviewPanel($('#review-panel-host'), request, async <T>(op: string, args: Record<string, unknown>): Promise<T> => {
  const response = await invoke<{ok:boolean;result:T;error?:string}>('confirm_workflow',{op,args});
  if (!response.ok) throw new Error(response.error ?? 'No se pudo registrar la decisión.');
  return response.result;
},{host:verificationHost,select:(task,snapshotId)=>{
  const supported=(runner as RunnerStatus & {verificationVersion?:number})?.verificationVersion===1;
  verificationHost.hidden=!supported;verificationPanel.select(supported?task:null,snapshotId);
}},{available:()=>(runner as RunnerStatus & {handoffVersion?:number;terminalSessionVersion?:number})?.handoffVersion===1 && (runner as RunnerStatus & {terminalSessionVersion?:number})?.terminalSessionVersion===1,opened:(data,context)=>{
  const session=data as Session;
  if(!session.id || !['codex','claude'].includes(session.kind))throw new Error('Sesión de destino inválida. Consulta el historial.');
  handoffContexts.set(session.id,context);presentSession(session,panes[focusedPane]);notice('Destino abierto. El contexto está listo para copiar; no se ha enviado.');
}});
$('#copy-handoff-context').addEventListener('click',()=>{
  const id=activeView()?.session.id;const context=id?handoffContexts.get(id):null;if(!context)return;
  void navigator.clipboard.writeText(context).then(()=>text('#handoff-context-status','Contexto copiado. Pégalo y envíalo cuando quieras.')).catch(()=>text('#handoff-context-status','No se pudo copiar. Puedes seleccionar el texto y copiarlo con el teclado.'));
});
window.addEventListener('beforeunload',()=>reviewPanel?.dispose(),{once:true});

$('#purge-history').addEventListener('click',()=>action(async()=>{
  const id=activeView()?.session.id;if (!id) throw new Error('Selecciona un historial.');
  const response=await invoke<{ok:boolean;error?:string}>('confirm_workflow',{op:'purge_history',args:{id}});
  if (!response.ok) throw new Error(response.error??'No se pudo eliminar la salida.');
  await connect();notice('Salida eliminada explícitamente. Se conservan estados, tarea y archivos.');
}));

$('#restart-runner').addEventListener('click',()=>action(async()=>{
  if (await invoke<boolean>('restart_runner')) { await connect();notice('Runner reiniciado. Archivos e historial conservados.'); }
}));

$('#compact-history').addEventListener('click',()=>action(async()=>{
  const id=activeView()?.session.id;if (!id) throw new Error('Selecciona un historial.');
  const response=await invoke<{ok:boolean;error?:string}>('confirm_workflow',{op:'compact_history',args:{id}});
  if (!response.ok) throw new Error(response.error??'No se pudo compactar el historial.');
  await connect();notice('Eventos antiguos compactados explícitamente. Archivos y último estado conservados.');
}));

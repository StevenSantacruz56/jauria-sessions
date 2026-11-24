import { claimFloating, release } from './floating';
import { isClosed } from './session-lifecycle';
import './pulso-panel.css';
import { readLastBoard,saveLastBoard } from './board-preferences';
import { programStateLabel, type ProgramState } from './program-status';
import { paintAgentIndicator, providerBadge } from './agent-list';
import type { ActivityKind } from './session-activity';

export type Session = { id: string; title: string; kind: string; cwd: string | null; status: string; programState?:ProgramState|null };
type Timestamp = number | string;
export type PulsoProject = { id: string; title: string; plan: string; mainSessionId: string | null; revision: number; archived: boolean; createdAt: Timestamp; updatedAt: Timestamp };
export type PulsoItem = { id: string; projectId: string | null; title: string; note: string; status: 'todo' | 'doing' | 'waiting' | 'done'; position: number; revision: number; archived: boolean; createdAt: Timestamp; updatedAt: Timestamp; updatedBy?: string; updatedSessionId?: string | null;
  /** Runner 1.4 board cards (pulsoBoardCardsVersion): footer data. */
  session?: { id: string; source: 'link' | 'checkpoint' } | null; checkpointCount?: number };
export type PulsoCheckpoint = { id: string; itemId: string; brief: string; nextAction: string; sessionId?: string | null; actor: string; createdAt: Timestamp; revision?:number };
type Link = { projectId?: string; itemId?: string; sessionId: string };
export type PulsoPanelOptions = {
  host: HTMLElement;
  /** Where the board tabs and the "+" for a new project live (the workbench top bar). Defaults to the panel. */
  tabsHost?: HTMLElement;
  request: (op: string, args: Record<string, unknown>) => Promise<any>;
  sessions: () => Session[];
  openSession: (id: string) => void;
  newSession: (cwd?: string) => void;
  currentSession: () => Session | null;
  notice: (text: string) => void;
  /**
   * «Empezar una sesión nueva para este proyecto»: open the Nueva sesión dialog.
   * Returns false if it could not open; `started` runs once if a session starts
   * from that dialog (never on cancel).
   */
  startProjectSession?: (started: (sessionId: string) => void) => boolean;
  persistenceKey?: () => string | null;
  bindingCacheKey?: () => string;
  /** Kept for compatibility; the top-bar tabs and sidebar return to the terminal. */
  backToTerminal?: () => void;
  binding?: (id: string) => Promise<{ binding: { provider: string; conversationId: string } | null; activeSessionId?:string|null }>;
  resumeSession?: (sourceId: string) => Promise<string|void>;
  /** Empezar de nuevo aquí: the new-session dialog prefilled with the session's folder, provider and name. */
  restartSession?: (id: string) => void;
  /** Board selection or saved data changed (read-only signal for the sidebar summary). */
  onChange?: () => void;
  /** Runner 1.4 (pulsoRevisionVersion): `statusChanged` replaces the 2 s revision timer. */
  revisionFromStatus?: () => boolean;
  /** Runner 1.4 (pulsoBoardCardsVersion): cards carry `session` and `checkpointCount`. */
  cardFooters?: () => boolean;
  /** Live activity of a session as the sidebar paints it; null when unknown. */
  activityOf?: (id: string) => { kind: ActivityKind; label: string } | null;
};
export type PulsoLoadedPhases = { board: string; phases: { id: string; title: string; status: PulsoItem['status']; statusLabel: string }[] };
type Page<T> = { rows: T[]; hasMore: boolean; cursor?: string | number };
const labels = { todo: 'Por hacer', doing: 'En curso', waiting: 'En espera', done: 'Hecho' };
export const isLivePulsoSession = (s: Session) => ['starting', 'running'].includes(s.status);
const time = (value: Timestamp) => { const n = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value); return Number.isFinite(n) ? n : 0; };
function checkpointOrder(a:PulsoCheckpoint,b:PulsoCheckpoint){return typeof a.revision==='number'&&typeof b.revision==='number'?a.revision-b.revision:time(a.createdAt)-time(b.createdAt);}
export function pulsoContinuation(project: PulsoProject | null, item: PulsoItem, checkpoints: PulsoCheckpoint[]): string {
  const latest = [...checkpoints].sort(checkpointOrder).at(-1);
  return [project && `Proyecto: ${project.title}`, project?.plan && `Plan completo:\n${project.plan}`,
    `${project ? 'Fase' : 'Pendiente'}: ${item.title}`, item.note && `Notas:\n${item.note}`,
    latest && `Último checkpoint:\n${latest.brief}`, latest && `Siguiente acción:\n${latest.nextAction}`,
    'Revisa este contexto antes de continuar.'].filter(Boolean).join('\n\n');
}

/** Parent owns bridge/capability checks and stage navigation. No terminal input API is accepted.
 * Pages use the opaque nextCursor when supplied; otherwise a numeric offset advanced by the returned batch length.
 * Failed mutations retain their exact payload and requestId until explicitly retried or released.
 */
export function mountPulsoPanel(options: PulsoPanelOptions): { show(): void; hide(): void; refresh(): Promise<void>; prepareNavigation(): boolean; saveThen(next: () => void): boolean; openBoard(projectId: string | null): Promise<void>; currentBoard(): string | null; newProject(): void; closeMenus(): void; menuAnchor(node: Node | null): HTMLElement | null; draftBlocked(): string | null;
  statusChanged(revision: number | null): void; syncLive(): void; loadedPhases(): PulsoLoadedPhases | null; openPhase(id: string): Promise<void>; dispose(): void } {
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
    const n = document.createElement(tag); n.textContent = text; n.className = cls; return n;
  }
  function button(text: string, action: () => unknown, cls = '') {
    const n = el('button', text, cls); n.type = 'button'; n.onclick = () => { void action(); }; return n;
  }
  function field(label: string, multiline = false, max = 1000) {
    const wrap = el('label', '', 'pulso-field'); wrap.append(el('span', label));
    const input = multiline ? el('textarea') : el('input'); input.maxLength = max;
    input.setAttribute('aria-label', label);
    wrap.append(input); return { wrap, input };
  }
  function select(label: string, values: [string, string][], value = '') {
    const wrap = el('label', '', 'pulso-field'); wrap.append(el('span', label)); const input = el('select');
    input.setAttribute('aria-label', label);
    for (const [id, title] of values) { const o = el('option', title); o.value = id; input.append(o); }
    input.value = values.some(([id]) => id === value) ? value : values[0]?.[0] ?? ''; wrap.append(input); return { wrap, input };
  }
  const root = el('section', '', 'pulso-panel'); root.hidden = true; root.setAttribute('aria-label', 'Pulso');
  // Board tabs live in the workbench top bar, with «Terminados» (archived
  // projects) and a labelled «Nuevo proyecto» (never a bare "+", which in the
  // terminal view opens a session).
  // One amber action per screen: the project's main-session action in the toolbar.
  const feedback = el('div', '', 'pulso-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const errors = el('div', '', 'pulso-error'); errors.hidden = true; errors.setAttribute('role', 'alert');
  const undoSlot = el('div', '', 'pulso-undo');
  const outline=el('nav','','pulso-tabs');outline.setAttribute('aria-label','Tableros de Pulso');
  const projectList=el('div','','pulso-project-tabs');
  const archiveTab=button('Terminados',()=>openArchive(),'pulso-tab pulso-tab-archive');archiveTab.title='Proyectos terminados';
  const addProject=button('',()=>newProject(),'quiet pulso-tab-new');
  addProject.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';addProject.append('Nuevo proyecto');
  outline.append(projectList,archiveTab,addProject);
  const toolbar=el('div','','pulso-board-toolbar');
  const board=el('div','','pulso-board');board.setAttribute('aria-label','Tablero de trabajo');
  const drawer=el('dialog','','pulso-drawer');drawer.setAttribute('aria-label','Detalle de Pulso');
  const drawerHeader=el('header','','pulso-drawer-header');const drawerTitle=el('h2','Detalle');
  const closeDetail=button('',()=>closeDrawer(),'quiet');closeDetail.setAttribute('aria-label','Cerrar detalle');closeDetail.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';drawerHeader.append(drawerTitle,closeDetail);
  const drawerMessages=el('div','','pulso-drawer-messages');
  const detail=el('section','','pulso-detail');detail.setAttribute('aria-label','Detalle de Pulso');drawer.append(drawerHeader,drawerMessages,detail);
  drawer.addEventListener('cancel',event=>{event.preventDefault();closeDrawer();});
  root.append(feedback,errors,undoSlot,toolbar,board,drawer);options.host.append(root);
  if(options.tabsHost)options.tabsHost.append(outline);else root.prepend(outline);
  const capture=el('form','','pulso-capture');const captureTitle=field('Nombre del proyecto',false,240);captureTitle.input.required=true;captureTitle.input.placeholder='Por ejemplo: lanzar mi aplicación';
  const originLabel=el('label','','pulso-check');const originCheck=el('input');originCheck.type='checkbox';originCheck.checked=true;
  const originText=el('span');originLabel.append(originCheck,originText);
  // A new session and the current one are alternative main sessions: checking one unchecks the other.
  const startLabel=el('label','','pulso-check');const startCheck=el('input');startCheck.type='checkbox';
  startLabel.append(startCheck,el('span','Empezar una sesión nueva para este proyecto'));startLabel.hidden=!options.startProjectSession;
  originCheck.addEventListener('change',()=>{if(originCheck.checked)startCheck.checked=false;});
  startCheck.addEventListener('change',()=>{if(startCheck.checked)originCheck.checked=false;});
  let captureOrigin: Session | null = null;
  function syncOrigin(){originLabel.hidden=!captureOrigin;originText.textContent=captureOrigin?`Usar «${captureOrigin.title}» como sesión principal`:'';}
  capture.append(captureTitle.wrap,originLabel,startLabel);const captureSave=el('button','Crear proyecto','primary');captureSave.type='submit';capture.append(captureSave,button('Cancelar',()=>{dirty=false;activeEditor=null;closeDrawer();},'quiet'));

  let disposed = false, visible = false, timer: ReturnType<typeof setTimeout> | undefined;
  let revision: unknown, refreshing: Promise<void> | null = null, refreshGeneration = 0, generation = 0, selectionEpoch = 0;
  let projects: Page<PulsoProject> = { rows: [], hasMore: false };
  let phases: Page<PulsoItem> = { rows: [], hasMore: false };
  let selectedProject: PulsoProject | null = null, selectedItem: PulsoItem | null = null;
  let checkpointHasMore=false, checkpointCursor=10;
  type ColumnPage=Page<PulsoItem>&{totalCount:number};
  const statuses=Object.keys(labels) as PulsoItem['status'][];
  const emptyColumns=()=>Object.fromEntries(statuses.map(status=>[status,{rows:[],hasMore:false,totalCount:0}])) as unknown as Record<PulsoItem['status'],ColumnPage>;
  let columns=emptyColumns(),boardRevision:unknown,boardScope:string|null|undefined;
  let boardProject:PulsoProject|null=null,navigating=false;
  let drawerRestore=false,dragging=false;let cancelActiveDrag:(()=>void)|null=null;
  type DrawerKind='item'|'project'|'sessions'|'create'|'archive';
  let drawerKind:DrawerKind|null=null;
  /** Proyecto drawer autosave: writes what is typed and resolves true once nothing is left unsaved. */
  let flushProject:(()=>Promise<boolean>)|null=null;
  /** Called after a failed write is released (`review` false) or its conflict reviewed (true). */
  let afterRelease:((review:boolean)=>void)|null=null;
  /** Add-phase openers of the rendered board, by column. */
  let addOpeners:Partial<Record<PulsoItem['status'],()=>void>>={};
  let intentionalCloses=0;let drawerFocus:HTMLElement|null=null;
  drawer.addEventListener('focusin',event=>{if(event.target instanceof HTMLElement)drawerFocus=event.target;});
  drawer.addEventListener('close',()=>{
    if(intentionalCloses>0){intentionalCloses--;return;}
    if(dirty||failed||busy){drawerRestore=true;queueMicrotask(()=>{if(available()&&!drawer.open&&drawerKind){const returnFocus=drawerFocus;openDrawer(drawerKind,drawerTitle.textContent??'Detalle');drawerRestore=false;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});}});}
    else{hideDrawer();drawerKind=null;selectedItem=null;activeEditor=null;freeze();}
  });
  const sessionSignature=()=>JSON.stringify(options.sessions().map(s=>[s.id,s.status,s.title]));
  let shownSessions='';let bindingContext='';
  let restoredProfile:string|null|undefined;let restoreBoardId:string|null=null;
  let projectLinks: Link[] = [], dirty = false, busy = false, activeEditor: HTMLElement | null = null;
  let detailRecordKey = '';
  let detailItemLinks: Link[] = [], detailItemCheckpoints: PulsoCheckpoint[] = [];
  let recoveryFocus: { id: string; region: 'board' | 'detail'; epoch: number; gen: number } | null = null;
  function clearRecoveryFocus(){recoveryFocus=null;document.removeEventListener('pointerdown',clearRecoveryFocus,true);document.removeEventListener('keydown',clearRecoveryFocus,true);}
  function holdRecoveryFocus(id:string,region:'board'|'detail'){
    clearRecoveryFocus();recoveryFocus={id,region,epoch:selectionEpoch,gen:generation};
    document.addEventListener('pointerdown',clearRecoveryFocus,true);document.addEventListener('keydown',clearRecoveryFocus,true);
  }
  let editBase: { revision: number } | null = null;
  type Mutation = { op: string; args: Record<string, unknown>; apply: (data: any) => void | Promise<void>; discard?: () => void };
  let failed: Mutation | null = null;
  const bindings = new Map<string, ReturnType<NonNullable<PulsoPanelOptions['binding']>>>();
  function preserveDetailRender(render: () => void) {
    if (!drawer.open) { render(); return; }
    const controls = () => Array.from(detail.querySelectorAll<HTMLElement>('button,input,select,textarea,summary'));
    const active = document.activeElement instanceof HTMLElement && detail.contains(document.activeElement) ? document.activeElement : null;
    const focusedRecovery = active?.closest<HTMLElement>('.pulso-recovery-action');
    if (focusedRecovery?.dataset.sessionId) holdRecoveryFocus(focusedRecovery.dataset.sessionId, 'detail');
    const key = active ? `${active.tagName}:${active.getAttribute('aria-label') ?? active.textContent?.trim() ?? ''}` : '';
    const matches = () => controls().filter(control => `${control.tagName}:${control.getAttribute('aria-label') ?? control.textContent?.trim() ?? ''}` === key);
    const focusIndex = active ? matches().indexOf(active) : -1;
    const openSections = new Set(Array.from(detail.querySelectorAll('details[open] summary')).map(summary => summary.textContent));
    const contextOpen = detail.querySelector<HTMLElement>('.pulso-context-composer')?.hidden === false;
    const scroll = detail.scrollTop;
    render();
    for (const section of Array.from(detail.querySelectorAll('details'))) section.open = openSections.has(section.querySelector('summary')?.textContent ?? '');
    if (contextOpen) { const composer = detail.querySelector<HTMLElement>('.pulso-context-composer'); if (composer) composer.hidden = false; }
    if (focusIndex >= 0) {
      const target = matches()[focusIndex];
      target?.focus({ preventScroll: true });
      if (target && focusedRecovery && document.activeElement===target) clearRecoveryFocus();
    }
    detail.scrollTop = scroll;
  }
  const available = () => visible && !disposed && !document.hidden;
  const say = (message: string) => { if (!disposed) feedback.textContent = message; };
  function freeze() {
    root.setAttribute('aria-busy', String(busy));
    for (const n of [root,outline].flatMap(scope=>Array.from(scope.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')))) {
      n.disabled = busy || (navigating&&(board.contains(n)||toolbar.contains(n))) || (!!failed && !errors.contains(n)) || (dirty && !!activeEditor && !activeEditor.contains(n) && !errors.contains(n));
    }
  }
  async function request(op: string, args: Record<string, unknown> = {}) {
    const data = await options.request(op, args);
    if (typeof data === 'string' || data?.error) throw new Error('La operación no se completó.');
    if (!data || typeof data !== 'object') throw new Error('Respuesta no válida.');
    return data;
  }
  function readError(retry: () => unknown) {
    if (disposed) return;
    errors.hidden = false; errors.replaceChildren(el('p', 'No se pudo consultar Pulso. Comprueba la conexión y que el runner admita Pulso.'), button('Reintentar consulta', retry));
  }
  async function mutate(m: Mutation) {
    if (busy || disposed) return;
    busy = true; failed = null; errors.hidden = true; freeze();
    try {
      const data = await request(m.op, m.args);
      if (disposed) return;
      await m.apply(data);
      if (disposed) return;
      say('Guardado.');notifyChange();
    } catch (error) {
      if (disposed) return;
      showFailure(m, error);
    } finally { busy = false; if (!disposed) freeze(); }
  }
  /** A write that was not confirmed: keep the draft and offer retry, inspection and release. */
  function showFailure(m: Mutation, error: unknown) {
    failed = m; errors.hidden = false;
    errors.replaceChildren(el('p', String(error).includes('Pulso local storage budget reached') ? 'Se alcanzó el espacio local reservado para nuevos cambios de Pulso. Los registros existentes y las terminales se conservan; consulta la guía de respaldo antes de continuar.' : 'No se confirmó el cambio. Tu borrador sigue aquí. Reintentar reutiliza la misma solicitud; si hay un conflicto, consulta la versión actual.'),
      button('Reintentar mismo cambio', () => mutate(m)),
      button('Consultar versión actual', () => inspectRevision(m)),
      button('Liberar borrador', () => {
        failed = null; errors.hidden = true;if(!drawer.open)renderLists();freeze();
        say('Borrador editable. El cambio anterior pudo guardarse; consulta la versión actual antes de volver a guardar.');afterRelease?.(false);
      }));
    // Autosave has no draft buttons: this is the way out when saving keeps failing.
    const discard = m.discard;
    if (discard) {
      const ask: HTMLButtonElement = button('Descartar mis cambios', () => {
        const box = el('div', '', 'pulso-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Descartar mis cambios');
        const yes = button('Sí, descartar', () => { if (failed !== m) return; failed = null; errors.hidden = true; dirty = false; activeEditor = null; discard(); freeze(); }, 'primary');
        box.append(el('span', 'Se perderá lo que no se guardó.'), yes, button('Cancelar', () => { box.replaceWith(ask); ask.focus({ preventScroll: true }); }, 'quiet'));
        ask.replaceWith(box); yes.focus({ preventScroll: true });
      });
      errors.append(ask);
    }
    freeze();
  }
  async function inspectRevision(m: Mutation) {
    if (busy || disposed) return;
    const epoch = selectionEpoch;
    try {
      const kind = m.op.startsWith('project_') || (m.op === 'link' && m.args.projectId) ? 'project' : 'item';
      const id = m.op === 'link' ? m.args.projectId ?? m.args.itemId : kind === 'project' ? m.args.id : m.args.itemId ?? m.args.id;
      const result = await request(kind, { id });
      if (disposed || epoch !== selectionEpoch || failed !== m) return;
      const record = result[kind];
      const remote = el('pre', [record.title, record.status && labels[record.status as PulsoItem['status']], record.plan ?? record.note,
        ...(result.checkpoints ?? []).map((c: PulsoCheckpoint) => `${c.brief}\n${c.nextAction}`)].filter(Boolean).join('\n\n'), 'pulso-prose');
      errors.append(el('h3', `Versión actual · revisión ${record.revision}`), remote);
      if(!drawer.open)errors.append(button('Actualizar tablero',async()=>{failed=null;errors.hidden=true;try{await reloadBoard();if(epoch===selectionEpoch&&boardScope===null)rememberBoard();}catch{readError(()=>refresh());}freeze();}));
      if (drawer.open && editBase && m.args.expectedRevision !== undefined) errors.append(button('Revisé los cambios; conservar mi borrador', () => {
        if (editBase) editBase.revision = record.revision;
        failed = null; errors.hidden = true; freeze(); say(afterRelease ? 'Se guardará tu versión sobre la actual.' : 'Revisión actualizada. Revisa tu borrador y guarda de nuevo cuando esté listo.');afterRelease?.(true);
      }));
    } catch { say('No se pudo consultar la versión actual. Reintenta cuando vuelva la conexión.'); }
  }
  const write = (op: string, args: Record<string, unknown>, apply: Mutation['apply']) => mutate({ op, args: { ...args, requestId: crypto.randomUUID() }, apply });
  async function page<T extends { id: string }>(op: string, key: string, args: Record<string, unknown>, previous?: Page<T>): Promise<Page<T>> {
    const data = await request(op, { ...args, limit: 50, ...(previous?.cursor !== undefined ? { cursor: previous.cursor } : {}) });
    if (!Array.isArray(data[key])) throw Error('Página no válida');
    const batch = data[key].slice(0, 50) as T[];
    const rows = [...new Map([...(previous?.rows ?? []), ...batch].map(row => [row.id, row])).values()];
    const cursor = data.nextCursor ?? (typeof previous?.cursor === 'number' ? previous.cursor : previous?.rows.length ?? 0) + batch.length;
    if (data.hasMore && (!batch.length || cursor === previous?.cursor)) throw Error('Cursor no válido');
    return { rows, hasMore: !!data.hasMore, cursor };
  }
  function openDrawer(kind:DrawerKind,title:string){drawerKind=kind;drawerTitle.textContent=title;drawerMessages.append(feedback,errors);if(!drawer.open&&available())drawer.showModal();}
  function hideDrawer(){if(drawer.open){intentionalCloses++;drawer.close();}root.insertBefore(feedback,toolbar);root.insertBefore(errors,toolbar);}
  function closeDrawer(){
    if(busy)return;
    // Proyecto saves by itself: closing first writes what is pending, then closes.
    if(dirty&&!failed&&drawerKind==='project'&&flushProject){const flush=flushProject;void flush().then(ok=>{if(ok&&!disposed&&drawerKind==='project'&&!dirty)closeDrawer();});return;}
    if(dirty||failed){say('Guarda los cambios o descarta el borrador antes de cerrar.');return;}
    hideDrawer();drawerKind=null;selectedItem=null;activeEditor=null;flushProject=null;afterRelease=null;
  }
  function newProject(){if(dirty||failed||busy)return;selectionEpoch++;navigating=false;selectedProject=boardProject;selectedItem=null;flushProject=null;afterRelease=null;detail.replaceChildren(capture);captureTitle.input.value='';startCheck.checked=false;captureOrigin=options.currentSession();originCheck.checked=true;syncOrigin();openDrawer('create','Nuevo proyecto');captureTitle.input.focus();}
  function renderLists() {
    const focus=document.activeElement instanceof HTMLElement?document.activeElement.dataset.focusKey:undefined;
    projectList.replaceChildren();
    const pendingTab=button('Pendientes',()=>choosePending(),'pulso-tab');pendingTab.setAttribute('aria-current',String(!selectedProject));projectList.append(pendingTab);
    // An archived project has no tab: it is reached from «Terminados».
    const visibleProjects=selectedProject&&!selectedProject.archived&&!projects.rows.some(p=>p.id===selectedProject!.id)?[...projects.rows,selectedProject]:projects.rows;
    for(const project of visibleProjects){const b=button(project.title,()=>chooseProject(project.id),'pulso-tab');b.dataset.focusKey=`project-${project.id}`;b.setAttribute('aria-current',String(selectedProject?.id===project.id));projectList.append(b);}
    if(projects.hasMore)projectList.append(button('Más proyectos',()=>loadMoreProjects(),'quiet'));
    archiveTab.setAttribute('aria-current',String(!!selectedProject?.archived));
    if(!dirty&&!failed&&!dragging)renderBoard();freeze();
    if(focus&&available())Array.from(outline.querySelectorAll<HTMLElement>('[data-focus-key]')).find(n=>n.dataset.focusKey===focus)?.focus({preventScroll:true});
  }
  function renderBoard(){
    const focusedRecovery=document.activeElement instanceof HTMLElement?document.activeElement.closest<HTMLElement>('.pulso-board-toolbar .pulso-recovery-action'):null;
    if(focusedRecovery?.dataset.sessionId)holdRecoveryFocus(focusedRecovery.dataset.sessionId,'board');
    const previousFocus=document.activeElement instanceof HTMLElement?document.activeElement.dataset.focusKey:undefined;
    const scrolls=new Map(Array.from(board.querySelectorAll<HTMLElement>('.pulso-cards')).map(n=>[n.dataset.status,n.scrollTop]));
    const sameBoard=board.dataset.projectId===(selectedProject?.id??'');
    const focus=sameBoard?previousFocus:undefined;
    const openAdds=new Set(sameBoard?Array.from(board.querySelectorAll<HTMLElement>('.pulso-column')).filter(n=>n.querySelector<HTMLFormElement>('.pulso-add-form')?.hidden===false).map(n=>n.dataset.state):[]);
    // One compact line: title, progress, Proyecto, Sesiones, Dar por terminado and the primary action.
    // An archived project is read-only: no add, move or edit; «Reabrir» brings it back.
    const readOnly=!!selectedProject?.archived;
    toolbar.replaceChildren();const title=el('h2',selectedProject?.title??'Pendientes','pulso-board-title');title.title=title.textContent??'';
    const total=statuses.reduce((n,status)=>n+columns[status].totalCount,0);const complete=columns.done.totalCount;
    const progress=el('p',total?`${complete} de ${total} ${selectedProject?'fases hechas':'pendientes hechos'}`:selectedProject?'Sin fases todavía':'Sin pendientes todavía','pulso-progress');
    progress.title=total?`${complete} de ${total} ${selectedProject?'fases':'pendientes'} en Hecho · ${selectedProject?'orden según el plan':'orden original'}`:`Añade ${selectedProject?'una fase':'un pendiente'} en la columna donde quieras empezar.`;
    toolbar.append(title);if(readOnly)toolbar.append(el('span','Terminado','pulso-archived-badge'));toolbar.append(progress);
    const project=selectedProject;
    if(project&&readOnly)toolbar.append(button('Reabrir',()=>reopenProject(project),'quiet'));
    else if(project){
      if(total>0&&complete===total){const finish:HTMLButtonElement=button('Dar por terminado',()=>confirmArchive(finish,project,true),'quiet pulso-finish-button');toolbar.append(finish);}
      toolbar.append(button('Proyecto',()=>openProjectDrawer(),'quiet pulso-plan-button'),button('Sesiones',()=>openSessionsDrawer(),'quiet pulso-plan-button'));
    }
    if(selectedProject?.mainSessionId&&readOnly){
      // Archived: look only. A live session is focused, an ended one opens its history; nothing resumes or links.
      const id=selectedProject.mainSessionId;if(options.sessions().some(s=>s.id===id)){const recovery=el('div','','pulso-project-recovery');recovery.append(button('Ver sesión principal',()=>openCardSession(id),'quiet'));toolbar.append(recovery);}
    }
    else if(selectedProject?.mainSessionId){const recovery=el('div','','pulso-project-recovery');recoveryAction(recovery,selectedProject.mainSessionId,'Abrir sesión principal','Continuar sesión principal');toolbar.append(recovery);}
    closeMoveMenu(false);board.replaceChildren();board.dataset.projectId=selectedProject?.id??'';addOpeners={};
    const noun=selectedProject?'fase':'pendiente';
    for(const status of statuses){
      const column=el('section','','pulso-column');column.dataset.state=status;column.setAttribute('aria-label',labels[status]);
      const h=el('header');h.append(el('h3',labels[status]),el('span',String(columns[status].totalCount),'pulso-count'));column.append(h);
      const cards=el('div','','pulso-cards');cards.dataset.status=status;
      for(const item of columns[status].rows)cards.append(itemCard(item,readOnly));
      if(!columns[status].rows.length)cards.append(el('p',status==='done'?'Lo que termines aparecerá aquí.':status==='waiting'?'Trabajo que necesita algo antes de seguir.':status==='doing'?`Pon aquí ${selectedProject?'la fase':'el pendiente'} en ${selectedProject?'la':'el'} que estás trabajando.`:'Captura el siguiente paso.','pulso-empty'));
      if(columns[status].hasMore)cards.append(button(`Ver más ${noun}s`,()=>loadMoreColumn(status),'quiet'));
      column.append(cards);
      // «Añadir fase» sits right under the last phase of every column, Hecho included.
      if(!readOnly){
        const add=el('form','','pulso-add-form');add.hidden=true;
        const title=field(selectedProject?'Título de la fase':'Título del pendiente',false,240);title.input.required=true;title.input.placeholder='Escribe un título';title.input.dataset.focusKey=`add-title-${status}`;
        const open=()=>{if(busy||dirty||failed)return;add.hidden=false;trigger.hidden=true;title.input.focus();};
        const trigger=button(selectedProject?'Añadir fase':'Añadir pendiente',open,'quiet pulso-add-trigger');
        trigger.dataset.focusKey=`add-${status}`;addOpeners[status]=open;
        const cancel=button('Cancelar',()=>{dirty=false;activeEditor=null;add.hidden=true;trigger.hidden=false;title.input.value='';freeze();},'quiet');
        add.append(title.wrap);submit(add,selectedProject?'Añadir fase':'Añadir pendiente',()=>write('item_create',{id:crypto.randomUUID(),projectId:selectedProject?.id??null,title:title.input.value.trim(),status},async()=>{dirty=false;activeEditor=null;await reloadBoard();}));add.append(cancel);
        if(openAdds.has(status)){add.hidden=false;trigger.hidden=true;}
        cards.append(trigger,add);
      }
      board.append(column);cards.scrollTop=scrolls.get(status)??0;
    }
    if(focus)Array.from(board.querySelectorAll<HTMLElement>('[data-focus-key]')).find(n=>n.dataset.focusKey===focus)?.focus({preventScroll:true});
  }
  function itemCard(item:PulsoItem,readOnly=false){
    const card=el('article','','pulso-card');card.dataset.itemId=item.id;card.dataset.state=item.status;
    if(readOnly){
      // Archived project: the phase is shown, not opened, moved or edited.
      const body=el('div','','pulso-card-open');body.append(el('span',item.title,'pulso-card-title'));if(item.note)body.append(el('span',item.note,'pulso-card-note'));card.append(body);
      if(options.cardFooters?.()){const foot=cardFoot(item);if(foot)card.append(foot);}
      return card;
    }
    const open=button('',()=>chooseItem(item),'pulso-card-open');open.dataset.focusKey=`item-${item.id}`;open.setAttribute('aria-label',`Abrir ${item.title}`);
    open.append(el('span',item.title,'pulso-card-title'));if(item.note)open.append(el('span',item.note,'pulso-card-note'));card.append(open);
    const controls=el('div','','pulso-card-controls');
    const handle=button('',()=>say(`Arrastra ${item.projectId?'esta fase':'este pendiente'} a otra columna o usa su menú «…» (Mover).`),'quiet pulso-card-handle');handle.setAttribute('aria-label',`Arrastrar ${item.title}`);handle.title='Arrastrar a otra columna';
    handle.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" stroke-linecap="round"/></svg>';
    handle.addEventListener('pointerdown',event=>startDrag(event,item,card,handle));
    // Keyboard alternative to dragging: a menu with the four columns (same move, undo and phase order).
    const menu=button('',()=>openMoveMenu(item,menu),'quiet pulso-card-menu');menu.setAttribute('aria-label',`Mover ${item.title}`);menu.title='Mover a otra columna';
    menu.setAttribute('aria-haspopup','menu');menu.setAttribute('aria-expanded','false');menu.dataset.focusKey=`move-${item.id}`;
    menu.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    controls.append(menu,handle);card.append(controls);
    if(options.cardFooters?.()){const foot=cardFoot(item);if(foot)card.append(foot);}
    return card;
  }
  /** Runner 1.4 footer: linked session (live state, never «working» without a declared state) and checkpoints. */
  function cardFoot(item:PulsoItem){
    const session=item.session&&typeof item.session.id==='string'?item.session:null;
    const count=typeof item.checkpointCount==='number'&&item.checkpointCount>0?Math.floor(item.checkpointCount):0;
    if(!session&&!count)return null;
    const foot=el('div','','pulso-card-foot');
    if(session){const slot=el('span','','pulso-card-session-slot');slot.dataset.sessionId=session.id;slot.dataset.source=session.source==='checkpoint'?'checkpoint':'link';slot.dataset.itemId=item.id;paintCardSession(slot);foot.append(slot);}
    // Compact count (flag + number) so the session name keeps the width; the words stay in the label and title.
    if(count){const label=`${count} ${count===1?'checkpoint':'checkpoints'}`;const tally=el('span','','pulso-card-checkpoints');tally.setAttribute('role','img');tally.setAttribute('aria-label',label);tally.title=label;
      tally.innerHTML='<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5V1.8M3 2h6l-1.4 2.2L9 6.4H3"/></svg>';tally.append(String(count));foot.append(tally);}
    return foot;
  }
  function fallbackActivity(s:Session):{kind:ActivityKind;label:string}{
    const state=isLivePulsoSession(s)?s.programState:null;
    if(state==='working')return{kind:'working',label:programStateLabel(state)};
    if(state==='blocked'||state==='error')return{kind:'needs',label:programStateLabel(state)};
    if(state==='done'||state==='idle')return{kind:'idle',label:programStateLabel(state)};
    return{kind:'unreported',label:isLivePulsoSession(s)?'Sin estado del agente':'Sesión finalizada'};
  }
  /** Idempotent: only changed text and attributes are written, so each status can call it. */
  function paintCardSession(slot:HTMLElement):boolean{
    const id=slot.dataset.sessionId!,fromCheckpoint=slot.dataset.source==='checkpoint';
    const s=options.sessions().find(x=>x.id===id);let created=false;
    if(!s){
      if(!slot.querySelector('.pulso-card-session-missing'))slot.replaceChildren(el('span','Sesión no disponible','pulso-card-session-missing'));
      const title=fromCheckpoint?'Sesión del último checkpoint: no está en la lista de este perfil':'La sesión vinculada no está en la lista de este perfil';
      if(slot.title!==title)slot.title=title;return false;
    }
    slot.removeAttribute('title');
    let control=slot.querySelector<HTMLButtonElement>('button.pulso-card-session');
    if(!control){
      control=button('',()=>openCardSession(id),'pulso-card-session');control.dataset.focusKey=`session-${slot.dataset.itemId}`;
      control.append(el('span','','agent-indicator'),el('span','','provider-badge'),el('span','','pulso-card-session-name'));
      for(const n of Array.from(control.querySelectorAll('.agent-indicator,.provider-badge')))n.setAttribute('aria-hidden','true');
      slot.replaceChildren(control);created=true;
    }
    const activity=options.activityOf?.(id)??fallbackActivity(s);
    paintAgentIndicator(control.querySelector<HTMLElement>('.agent-indicator')!,activity.kind,activity.label);
    const badge=control.querySelector<HTMLElement>('.provider-badge')!,provider=providerBadge(s.kind);
    if(badge.dataset.provider!==provider.provider){badge.dataset.provider=provider.provider;badge.textContent=provider.letter;}
    const name=control.querySelector<HTMLElement>('.pulso-card-session-name')!;if(name.textContent!==s.title)name.textContent=s.title;
    const live=isLivePulsoSession(s);
    const label=fromCheckpoint?`Sesión del último checkpoint: ${s.title} · ${activity.label}`:`Abrir sesión vinculada ${s.title} · ${activity.label}`;
    const title=`${fromCheckpoint?'Sesión del último checkpoint · ':''}${s.title} · ${activity.label} · ${live?'Enfocar sesión viva':'Ver historial'}`;
    if(control.getAttribute('aria-label')!==label)control.setAttribute('aria-label',label);
    if(control.title!==title)control.title=title;
    return created;
  }
  function syncCardFooters(){
    if(!options.cardFooters?.())return;let created=false;
    for(const slot of Array.from(board.querySelectorAll<HTMLElement>('.pulso-card-session-slot')))created=paintCardSession(slot)||created;
    if(created)freeze();
  }
  /** Same function as «Enfocar sesión viva» / «Ver historial»; a draft or pending write keeps the board. */
  function openCardSession(id:string){
    if(busy||dirty||failed||navigating||dragging){say('Guarda o descarta el borrador antes de abrir otra sesión.');return;}
    options.openSession(id);
  }
  let moveMenu:{node:HTMLElement;anchor:HTMLButtonElement;dispose:()=>void}|null=null;
  // Shared dismissal rule (floating.ts): opening the card menu closes any other floating control.
  const moveFloating={contains:(node:Node)=>!!moveMenu&&(moveMenu.node.contains(node)||moveMenu.anchor.contains(node)),close:(restore:boolean)=>closeMoveMenu(restore)};
  function closeMoveMenu(focusAnchor:boolean){
    const current=moveMenu;if(!current)return;moveMenu=null;release(moveFloating);current.dispose();current.node.remove();current.anchor.setAttribute('aria-expanded','false');
    if(focusAnchor&&current.anchor.isConnected)current.anchor.focus({preventScroll:true});
  }
  function openMoveMenu(item:PulsoItem,anchor:HTMLButtonElement){
    if(moveMenu){const same=moveMenu.anchor===anchor;closeMoveMenu(same);if(same)return;}
    if(busy||dirty||failed||!available())return;
    const node=el('div','','pulso-move-menu');node.setAttribute('role','menu');node.setAttribute('aria-label',`Mover ${item.title}`);
    const items=statuses.map(status=>{
      const entry=el('button',`Mover a ${labels[status]}`,'pulso-move-item');entry.type='button';entry.setAttribute('role','menuitem');entry.tabIndex=-1;entry.dataset.state=status;
      if(status===item.status){entry.setAttribute('aria-disabled','true');entry.title='Columna actual';entry.append(el('span',' · actual','pulso-move-current'));}
      entry.onclick=()=>{if(status===item.status)return;closeMoveMenu(false);anchor.focus({preventScroll:true});void moveCard(item,status);};
      node.append(entry);return entry;
    });
    const enabled=()=>items.filter(entry=>entry.getAttribute('aria-disabled')!=='true');
    node.addEventListener('keydown',event=>{
      const list=enabled();const index=list.indexOf(document.activeElement as HTMLButtonElement);
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=event.key==='ArrowDown'?(index+1)%list.length:(index-1+list.length)%list.length;list[next]?.focus();}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();(event.key==='Home'?list[0]:list.at(-1))?.focus();}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMoveMenu(true);}
      // Tab continues from the "…" button: focus it first, so the removed menu never leaves focus on body.
      else if(event.key==='Tab'){closeMoveMenu(true);}
    });
    // Fixed position escapes the scrolling column; it closes on scroll or resize.
    const rect=anchor.getBoundingClientRect();root.append(node);
    const height=node.offsetHeight,width=node.offsetWidth;
    const top=rect.bottom+4+height>innerHeight-8?Math.max(8,rect.top-4-height):rect.bottom+4;
    node.style.top=`${top}px`;node.style.left=`${Math.max(8,Math.min(innerWidth-width-8,rect.right-width))}px`;
    const outside=(event:PointerEvent)=>{if(!node.contains(event.target as Node)&&!anchor.contains(event.target as Node))closeMoveMenu(false);};
    const away=()=>closeMoveMenu(false);
    document.addEventListener('pointerdown',outside,true);board.addEventListener('scroll',away,true);addEventListener('resize',away);
    moveMenu={node,anchor,dispose:()=>{document.removeEventListener('pointerdown',outside,true);board.removeEventListener('scroll',away,true);removeEventListener('resize',away);}};
    claimFloating(moveFloating);anchor.setAttribute('aria-expanded','true');enabled()[0]?.focus({preventScroll:true});
  }
  function startDrag(event:PointerEvent,item:PulsoItem,card:HTMLElement,handle:HTMLElement){
    if(event.button!==0||busy||dirty||failed)return;event.preventDefault();dragging=true;handle.setPointerCapture(event.pointerId);let target:PulsoItem['status']|null=null;card.classList.add('is-dragging');
    const move=(e:PointerEvent)=>{for(const c of Array.from(board.querySelectorAll('.is-drop-target')))c.classList.remove('is-drop-target');const col=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('.pulso-column');target=(col?.dataset.state as PulsoItem['status'])??null;col?.classList.add('is-drop-target');};
    const finish=(e:PointerEvent)=>{cancelActiveDrag=null;document.removeEventListener('keydown',keyCancel);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',cancel);handle.removeEventListener('lostpointercapture',cancel);if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);card.classList.remove('is-dragging');for(const c of Array.from(board.querySelectorAll('.is-drop-target')))c.classList.remove('is-drop-target');dragging=false;if(target&&target!==item.status)void moveCard(item,target);else if(available()&&!dirty&&!failed)renderBoard();};
    const cancel=(e:PointerEvent)=>{target=null;finish(e);};const keyCancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();cancel(event);}};cancelActiveDrag=()=>cancel(event);document.addEventListener('keydown',keyCancel);handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',cancel);handle.addEventListener('lostpointercapture',cancel);
  }
  async function moveCard(item:PulsoItem,status:PulsoItem['status']){
    if(!available()||busy||dirty||failed||status===item.status)return;
    say(item.projectId?'Moviendo fase…':'Moviendo pendiente…');await write('item_update',{id:item.id,status,expectedRevision:item.revision},async data=>{setUndo(item.id,item.status,data.item.revision);await reloadBoard();});
  }
  async function readBoard(projectId:string|null,ifRevision?:unknown){
    const epoch=selectionEpoch,gen=generation;
    const current=()=>available()&&!dragging&&epoch===selectionEpoch&&gen===generation&&(selectedProject?.id??null)===projectId;
    const cachedRevision=boardScope===projectId?ifRevision:undefined;
    const data=await request('board',{projectId,...(cachedRevision!==undefined?{ifRevision:cachedRevision}:{})});
    if(!current()||(typeof boardRevision==='number'&&typeof data.revision==='number'&&data.revision<boardRevision))return false;
    if(data.unchanged)return false;
    const next=emptyColumns();
    await Promise.all(statuses.map(async status=>{
      const first=data.columns?.[status];if(!first||!Array.isArray(first.items))throw Error('Tablero no válido');
      let page:ColumnPage={rows:first.items,hasMore:!!first.hasMore,cursor:first.nextCursor,totalCount:first.totalCount};
      const retain=boardScope===projectId?columns[status].rows.length:0;
      // Re-fetch the expanded prefix against one revision, never mix old pages
      // with a fresh snapshot or collapse a reader's expanded column on polling.
      while(page.hasMore&&page.rows.length<retain){
        if(!current())return;
        const size=Math.min(50,retain-page.rows.length);
        const more=await request('items',{projectId,status,archived:false,limit:size,cursor:page.cursor,expectedSnapshotRevision:data.revision});
        if(!Array.isArray(more.items)||!more.items.length)throw Error('Página no válida');
        page={rows:[...page.rows,...more.items],hasMore:!!more.hasMore,cursor:more.nextCursor,totalCount:more.totalCount};
      }
      next[status]=page;
    }));
    if(!current()||(typeof boardRevision==='number'&&typeof data.revision==='number'&&data.revision<boardRevision))return false;
    columns=next;boardRevision=data.revision;boardScope=projectId;boardProject=selectedProject;return true;
  }
  async function reloadBoard(){if(!available())return;if(!await readBoard(selectedProject?.id??null))return;if(!failed)errors.hidden=true;phases={rows:statuses.flatMap(s=>columns[s].rows),hasMore:false};renderLists();}
  async function loadMoreColumn(status:PulsoItem['status']){
    if(busy||dirty||failed)return;busy=true;freeze();const epoch=selectionEpoch,gen=generation,rev=boardRevision;
    try{const next=await page<PulsoItem>('items','items',{projectId:selectedProject?.id??null,status,archived:false,expectedSnapshotRevision:rev},columns[status]);if(!available()||epoch!==selectionEpoch||gen!==generation||boardRevision!==rev)return;columns[status]={...next,totalCount:columns[status].totalCount};renderBoard();}
    catch{if(available()&&epoch===selectionEpoch&&gen===generation){readError(()=>refresh());say('El tablero cambió o no se pudo leer esta página. Actualiza para ver el tablero vigente.');}}finally{busy=false;freeze();}
  }
  async function loadMoreProjects(){if(busy||dirty||failed)return;busy=true;freeze();try{projects=await page<PulsoProject>('projects','projects',{archived:false},projects);renderLists();}catch{readError(()=>loadMoreProjects());}finally{busy=false;freeze();}}
  async function choosePending(){
    if(dirty||failed||busy)return;const epoch=++selectionEpoch;navigating=true;freeze();selectedProject=null;selectedItem=null;hideDrawer();drawerKind=null;
    try{await reloadBoard();if(epoch===selectionEpoch&&available())rememberBoard();}catch{if(epoch===selectionEpoch&&available()){selectedProject=boardProject;renderLists();readError(()=>choosePending());}}
    finally{if(epoch===selectionEpoch){navigating=false;freeze();}}
  }
  async function chooseProject(id: string, queryBindings = true) {
    if (!available()) return;
    if (dirty || failed) { say('Guarda tu borrador o pulsa «Descartar borrador» antes de cambiar de detalle.'); return; }
    const epoch = ++selectionEpoch; const gen = generation;navigating=true;freeze();say('Consultando proyecto…');
    try {
      const [data, links] = await Promise.all([request('project', { id }),request('links', { projectId: id })]);
      if (!available() || gen !== generation || epoch !== selectionEpoch || dirty || failed) return;
      selectedProject = data.project; selectedItem = null;projectLinks = links.links ?? [];
      await readBoard(id);if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed)return;hideDrawer();drawerKind=null;renderLists();if(!failed)errors.hidden=true;rememberBoard();say('');
    }catch{if(epoch===selectionEpoch&&available()){selectedProject=boardProject;renderLists();readError(()=>chooseProject(id));}}
    finally{if(epoch===selectionEpoch){navigating=false;freeze();}}
  }
  async function chooseItem(item: PulsoItem, queryBindings = true) {
    if (!available()) return;
    if (dirty || failed) { say('Guarda tu borrador o pulsa «Descartar borrador» antes de cambiar de detalle.'); return; }
    const epoch = ++selectionEpoch, gen = generation; say('Consultando fase…');
    try {
      const data = await request('item', { id: item.id });
      let project: PulsoProject | null = null;
      if (data.item.projectId) project = (await request('project', { id: data.item.projectId })).project;
      if (!available() || gen !== generation || epoch !== selectionEpoch || dirty || failed) return;
      selectedProject = project; selectedItem = data.item;
      // A project must have its own phase page, never a previous project's outline.
      if (project && phases.rows.some(i => i.projectId !== project!.id)) phases = { rows: [], hasMore: false };
      if (!project) phases = { rows: [], hasMore: false };
      renderLists(); checkpointHasMore=!!data.checkpointsHasMore;checkpointCursor=data.checkpointCursor??10;
      renderItem(data.item, data.links ?? [], data.checkpoints ?? [], queryBindings);openDrawer('item',item.projectId?'Detalle de la fase':'Detalle del pendiente'); say('');
    } catch { if (epoch === selectionEpoch) readError(() => chooseItem(item)); }
  }
  function watch(form: HTMLElement) {
    const changed = () => { dirty = true; activeEditor = form; freeze(); };
    form.addEventListener('input', changed); form.addEventListener('change', changed);
  }
  function discardButton() {
    return button('Descartar borrador', async () => {
      dirty = false; activeEditor = null; failed = null; errors.hidden = true;
      if (selectedItem) await chooseItem(selectedItem); else if (selectedProject) await chooseProject(selectedProject.id);
    }, 'quiet');
  }
  function submit(form: HTMLFormElement, text: string, action: () => unknown) {
    const b = el('button', text, 'primary'); b.type = 'submit';
    form.onsubmit = e => {
      e.preventDefault();
      for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[required],textarea[required]'))) {
        input.setCustomValidity(input.value.trim() ? '' : 'Escribe el contenido antes de guardar.');
        input.oninput = () => input.setCustomValidity('');
      }
      if (!busy && !failed && form.reportValidity()) void action();
    };
    form.append(b); watch(form); return b;
  }
  function sessionOptions() { return options.sessions().map(s => [s.id, `${s.title} · ${isLivePulsoSession(s) ? 'viva' : isClosed(s.status) ? 'historial local' : 'estado por comprobar'}`] as [string, string]); }
  function openProjectDrawer(){if(dirty||failed||busy||!selectedProject)return;selectedItem=null;renderProject(true);openDrawer('project','Proyecto');}
  function openSessionsDrawer(){if(dirty||failed||busy||!selectedProject)return;selectedItem=null;renderSessions();openDrawer('sessions','Sesiones');}
  /** Mirror a saved project into the selection and the tab row (the list never carries the plan). */
  function adoptProject(project: PulsoProject) {
    selectedProject = { ...selectedProject, ...project } as PulsoProject;
    projects = { ...projects, rows: projects.rows.map(row => row.id === project.id ? { ...row, title: project.title, revision: project.revision, mainSessionId: project.mainSessionId } : row) };
  }
  /**
   * Proyecto: name and plan save by themselves, like Configuración — after a
   * short pause, on leaving a field and before closing. A failed save keeps
   * the text and shows the usual retry/conflict options; nothing is discarded.
   */
  function renderProject(queryBindings: boolean) {
    const p = selectedProject!; detail.replaceChildren(); dirty = false; editBase = { revision: p.revision }; const base = editBase;
    activeEditor = null; detail.append(el('h2', p.title));
    const form = el('form', '', 'pulso-form pulso-autosave-form');
    form.append(el('p', 'Los cambios se aplican y se guardan al momento.', 'pulso-muted'));
    const title = field('Nombre del proyecto', false, 240); title.input.value = p.title; title.input.required = true;
    const plan = field('Plan (opcional) · hasta 32 000 caracteres', true, 32000); plan.input.value = p.plan ?? ''; (plan.input as HTMLTextAreaElement).rows = 10;
    plan.input.placeholder = 'Objetivo, alcance y pasos. Las fases del tablero siguen este orden.';
    const state = el('p', '', 'pulso-muted pulso-autosave-state'); state.setAttribute('aria-live', 'polite');
    form.append(title.wrap, plan.wrap, state); detail.append(form);
    let saved = { title: p.title, plan: p.plan ?? '' }, timer: ReturnType<typeof setTimeout> | undefined, inflight: Promise<void> | null = null;
    const pending = () => title.input.value.trim() !== saved.title || plan.input.value !== saved.plan;
    const current = () => flushProject === flush && !disposed;
    function clean() { dirty = false; activeEditor = null; freeze(); }
    async function save(): Promise<void> {
      if (timer !== undefined) clearTimeout(timer); timer = undefined;
      if (inflight) return inflight;
      if (!current() || failed || busy) return;
      const name = title.input.value.trim();
      if (!name) { state.textContent = 'Escribe un nombre para guardar.'; return; }
      if (!pending()) { clean(); return; }
      const args = { id: p.id, expectedRevision: base.revision, title: name, plan: plan.input.value, requestId: crypto.randomUUID() };
      const apply = async (data: any) => {
        base.revision = data.project.revision; saved = { title: args.title, plan: args.plan }; adoptProject(data.project);
        if (!current()) return;
        if (pending()) { state.textContent = 'Cambios sin guardar…'; timer = setTimeout(() => void save(), 600); }
        else { clean(); state.textContent = 'Guardado.'; }
        const heading = detail.querySelector('h2'); if (heading) heading.textContent = args.title;
        renderLists(); notifyChange();
      };
      state.textContent = 'Guardando…';
      inflight = (async () => {
        try { const data = await request('project_update', args); if (disposed) return; await apply(data); }
        catch (error) {
          if (disposed) return; state.textContent = 'No se guardó. Tu texto sigue aquí.';
          showFailure({ op: 'project_update', args, apply, discard: () => { if (drawerKind === 'project' && selectedProject?.id === p.id) { renderProject(false); say('Cambios descartados.'); } } }, error);
        }
        finally { inflight = null; }
      })();
      return inflight;
    }
    async function flush(): Promise<boolean> {
      for (let round = 0; round < 4; round++) {
        if (inflight) { await inflight; continue; }
        if (!current() || failed || !title.input.value.trim()) return false;
        if (!pending()) { clean(); return true; }
        await save();
      }
      return !dirty;
    }
    form.onsubmit = event => { event.preventDefault(); void save(); };
    form.addEventListener('input', () => {
      dirty = true; activeEditor = form; freeze(); state.textContent = 'Cambios sin guardar…';
      if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => void save(), 800);
    });
    form.addEventListener('change', () => { if (dirty) void save(); });
    // Released: the text waits for the next edit or close. Reviewed conflict: save it over the current version.
    flushProject = flush; afterRelease = review => {
      if (!current() || !pending()) return; dirty = true; activeEditor = form; freeze();
      if (review) void save(); else state.textContent = 'Sin guardar. Se guardará al seguir escribiendo o al cerrar.';
    };
    // Archive by hand, even with phases still open (Dar por terminado offers it when all are done).
    const archive = el('section', '', 'pulso-section');
    archive.append(el('h3', 'Archivar proyecto'), el('p', 'Sale de la barra lateral y de las pestañas, y queda en Terminados. Puedes reabrirlo cuando quieras.', 'pulso-muted'));
    const archiveButton: HTMLButtonElement = button('Archivar proyecto', () => confirmArchive(archiveButton, p, false), 'quiet');
    archive.append(archiveButton); detail.append(archive);
    detailRecordKey = JSON.stringify([p, projectLinks]); freeze();
  }
  /** Sesiones: main session (applied on change), linked sessions with their actions, and linking another. */
  function renderSessions() {
    const p = selectedProject!; detail.replaceChildren(); dirty = false; activeEditor = null; editBase = { revision: p.revision }; flushProject = null;
    detail.append(el('h2', p.title));
    const mainForm = el('div', '', 'pulso-form');
    const main = select('Sesión principal', [['', 'Sin sesión principal'], ...sessionOptions()], p.mainSessionId ?? '');
    if (p.mainSessionId && !options.sessions().some(s => s.id === p.mainSessionId)) {
      const o = el('option', `${p.mainSessionId} · historial local`); o.value = p.mainSessionId; main.input.append(o); main.input.value = p.mainSessionId;
    }
    main.input.addEventListener('change', () => {
      const value = main.input.value || null; if (value === (selectedProject?.mainSessionId ?? null)) return;
      void write('project_update', { id: p.id, expectedRevision: selectedProject!.revision, mainSessionId: value }, async data => {
        adoptProject(data.project); renderLists(); if (drawerKind === 'sessions') preserveDetailRender(() => renderSessions());
      });
    });
    mainForm.append(main.wrap, el('p', 'Se aplica al momento. La sesión principal no cambia sola cuando termina.', 'pulso-muted'));
    detail.append(mainForm);
    // A released failure shows the stored value again.
    afterRelease = () => { if (drawerKind === 'sessions' && selectedProject) preserveDetailRender(() => renderSessions()); };
    sessionsBlock(detail, [...new Set([p.mainSessionId, ...projectLinks.map(l => l.sessionId)].filter((id): id is string => !!id))], p.mainSessionId);
    linkBlock(detail, { projectId: p.id });
    detailRecordKey = JSON.stringify([p, projectLinks]); freeze();
  }
  /** Inline confirmation in place of `trigger`; Cancelar puts the button back with focus. */
  function confirmArchive(trigger: HTMLButtonElement, project: PulsoProject, finished: boolean) {
    // Proyecto drawer: write the pending name/plan first, then ask.
    if (dirty && !failed && drawerKind === 'project' && flushProject) { void flushProject().then(ok => { if (ok) confirmArchive(trigger, project, finished); }); return; }
    if (busy || dirty || failed || !trigger.isConnected) return;
    if (selectedProject?.id === project.id) project = selectedProject;
    const box = el('div', '', 'pulso-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', finished ? 'Dar por terminado' : 'Archivar proyecto');
    const back = () => { box.replaceWith(trigger); trigger.focus({ preventScroll: true }); };
    const accept = button(finished ? 'Sí, terminar' : 'Sí, archivar', () => archiveProject(project), 'primary');
    box.append(el('span', finished ? `¿Dar por terminado «${project.title}»? Pasará a Terminados.` : `¿Archivar «${project.title}»? Pasará a Terminados.`), accept, button('Cancelar', back, 'quiet'));
    box.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); } });
    trigger.replaceWith(box); accept.focus({ preventScroll: true }); freeze();
  }
  /** Newest known revision of a project (the tab list may be fresher than the selection). */
  function latestRevision(project: PulsoProject) { return Math.max(project.revision, projects.rows.find(row => row.id === project.id)?.revision ?? 0, selectedProject?.id === project.id ? selectedProject.revision : 0); }
  async function archiveProject(project: PulsoProject) {
    await write('project_update', { id: project.id, expectedRevision: latestRevision(project), archived: true }, async () => {
      // The board falls back to Pendientes; the project leaves the tabs and the sidebar summary.
      hideDrawer(); drawerKind = null; flushProject = null; afterRelease = null; selectedItem = null; selectionEpoch++; undoSlot.replaceChildren();
      dirty = false; activeEditor = null; selectedProject = null; projects = await page<PulsoProject>('projects', 'projects', { archived: false });
      await reloadBoard(); rememberBoard(); options.notice(`«${project.title}» está en Terminados.`);
    });
  }
  async function reopenProject(project: PulsoProject) {
    if (busy || dirty || failed) return;
    await write('project_update', { id: project.id, expectedRevision: latestRevision(project), archived: false }, async data => {
      hideDrawer(); drawerKind = null; projects = await page<PulsoProject>('projects', 'projects', { archived: false });
      if (selectedProject?.id === data.project.id) selectedProject = data.project;
      options.notice(`«${project.title}» vuelve a estar activo.`);
    });
    if (!failed && !disposed) await chooseProject(project.id);
  }
  /** Terminados: archived projects with their phase count; open read-only or reopen. */
  let archived: Page<PulsoProject> = { rows: [], hasMore: false };
  async function openArchive() {
    if (dirty || failed || busy || !available()) return;
    selectedItem = null; flushProject = null; afterRelease = null; const epoch = ++selectionEpoch;
    detail.replaceChildren(el('p', 'Consultando proyectos terminados…', 'pulso-muted')); openDrawer('archive', 'Proyectos terminados');
    try { archived = await page<PulsoProject>('projects', 'projects', { archived: true }); if (epoch === selectionEpoch && drawerKind === 'archive') await renderArchive(epoch); }
    catch { if (epoch === selectionEpoch && drawerKind === 'archive') detail.replaceChildren(el('p', 'No se pudieron consultar los proyectos terminados.', 'pulso-muted'), button('Reintentar consulta', () => { hideDrawer(); drawerKind = null; void openArchive(); })); }
  }
  async function renderArchive(epoch: number) {
    const list = el('ul', '', 'pulso-archive-list'); detail.replaceChildren(list);
    if (!archived.rows.length) detail.append(el('p', 'Todavía no hay proyectos terminados. Usa «Dar por terminado» cuando todas las fases estén en Hecho.', 'pulso-muted'));
    const counts: { row: PulsoProject; slot: HTMLElement }[] = [];
    for (const row of archived.rows) {
      const li = el('li', '', 'pulso-archive-row'); const info = el('div', '', 'pulso-archive-info');
      info.append(el('span', row.title, 'pulso-archive-title'));
      const meta = el('span', '', 'pulso-muted'); const date = time(row.updatedAt); meta.textContent = date ? `Terminado el ${new Date(date).toLocaleDateString('es')}` : 'Terminado';
      info.append(meta); li.append(info);
      li.append(button('Ver tablero', () => { if (busy) return; hideDrawer(); drawerKind = null; void chooseProject(row.id); }, 'quiet'), button('Reabrir', () => reopenProject(row), 'quiet'));
      list.append(li); counts.push({ row, slot: meta });
    }
    if (archived.hasMore) detail.append(button('Ver más proyectos', async () => {
      if (busy) return; try { archived = await page<PulsoProject>('projects', 'projects', { archived: true }, archived); if (epoch === selectionEpoch && drawerKind === 'archive') await renderArchive(epoch); } catch { say('No se pudo consultar la página siguiente.'); }
    }, 'quiet'));
    freeze();
    // Phase counts: a few board reads at a time; a failure only leaves the count out.
    for (let i = 0; i < counts.length; i += 4) {
      await Promise.all(counts.slice(i, i + 4).map(async ({ row, slot }) => {
        try {
          const data = await request('board', { projectId: row.id }); if (epoch !== selectionEpoch || drawerKind !== 'archive') return;
          const total = statuses.reduce((n, status) => n + (data.columns?.[status]?.totalCount ?? 0), 0), done = data.columns?.done?.totalCount ?? 0;
          slot.textContent = `${total ? `${done} de ${total} fases hechas` : 'Sin fases'} · ${slot.textContent}`;
        } catch { /* The count is optional. */ }
      }));
      if (epoch !== selectionEpoch || drawerKind !== 'archive') return;
    }
  }
  function renderItem(item: PulsoItem, links: Link[], checkpoints: PulsoCheckpoint[], queryBindings: boolean) {
    detail.replaceChildren(); dirty = false; activeEditor = null; editBase = { revision: item.revision }; const base = editBase; flushProject = null; afterRelease = null;
    if (selectedProject) detail.append(button(selectedProject.title, () => chooseProject(selectedProject!.id), 'quiet pulso-breadcrumb'));
    detail.append(el('h2', item.title));
    if(item.updatedBy){const session=options.sessions().find(s=>s.id===item.updatedSessionId);const actor=item.updatedBy==='ui'?'Jauria':session?.kind==='claude'?'Claude Code':session?.kind==='codex'?'Codex':'una sesión autorizada';detail.append(el('p',`Último cambio registrado por ${actor}.`,'pulso-muted'));}
    const form = el('form', '', 'pulso-form');
    const title = field(item.projectId ? 'Título de la fase' : 'Título del pendiente', false, 240); title.input.required = true; title.input.value = item.title;
    const note = field('Notas', true, 1000); note.input.value = item.note ?? '';
    const status = select('Estado', Object.entries(labels), item.status);
    form.append(title.wrap, status.wrap, note.wrap);
    submit(form, item.projectId ? 'Guardar fase' : 'Guardar pendiente', () => write('item_update', { id: item.id, expectedRevision: base.revision, title: title.input.value.trim(), note: note.input.value, status: status.input.value }, async data => {
      if (item.status !== data.item.status) setUndo(item.id, item.status, data.item.revision);
      dirty=false;await chooseItem(data.item);await reloadBoard();
    })); form.append(discardButton()); detail.append(form);
    const checkpoint = el('form', '', 'pulso-form'); checkpoint.append(el('h3', 'Registrar checkpoint'), el('p', 'Cada registro se añade al historial. Los anteriores se conservan.', 'pulso-muted'));
    const brief = field('Qué quedó listo · hasta 4 000 caracteres', true, 4000); brief.input.required = true;
    const next = field('Siguiente acción · hasta 1 000 caracteres', true, 1000); next.input.required = true;
    const session = select('Sesión del checkpoint', [['', 'Sin sesión'], ...sessionOptions()]);
    checkpoint.append(brief.wrap, next.wrap, session.wrap);
    submit(checkpoint, 'Registrar checkpoint', () => write('checkpoint_create', {
      id: crypto.randomUUID(), itemId: item.id, expectedRevision: base.revision, brief: brief.input.value.trim(), nextAction: next.input.value.trim(), ...(session.input.value ? { sessionId: session.input.value } : {}),
    }, async data => {dirty=false;await chooseItem(data.item);await reloadBoard();})); checkpoint.append(discardButton());const saveAdvance=el('details');saveAdvance.append(el('summary','Guardar avance'),checkpoint);detail.append(saveAdvance);
    const recover = el('section', '', 'pulso-section'); recover.append(el('h3', 'Continuar fase'));
    const recent=[...checkpoints].sort(checkpointOrder).at(-1);const recoveryId=recent?.sessionId??links[0]?.sessionId??selectedProject?.mainSessionId;
    if(recoveryId)recoveryAction(recover,recoveryId,'Abrir sesión de la fase','Continuar sesión de la fase');
    recover.append(el('p', 'Prepara el contexto, revísalo y cópialo. Tú decides dónde pegarlo.', 'pulso-muted'));
    const composer = el('div', '', 'pulso-context-composer'); composer.hidden = true;
    recover.append(button('Preparar contexto', () => { composer.hidden = false; }));
    const context = field('Contexto editable para continuar', true, 50000); context.input.value = pulsoContinuation(selectedProject, item, checkpoints);
    composer.append(context.wrap, button('Copiar contexto', () => copy(context.input.value)), discardButton()); watch(composer);
    const known = options.sessions(); const source = known.find(s => s.id === recoveryId);
    composer.append(button('Abrir nueva sesión', () => options.newSession(source?.cwd ?? undefined)), el('p', 'Abre una sesión vacía. El contexto no se envía automáticamente.', 'pulso-muted'));
    recover.append(composer); detail.insertBefore(recover,form);
    const latest=[...checkpoints].sort(checkpointOrder).at(-1);if(latest){const preview=el('section','','pulso-checkpoint-preview');preview.append(el('h3','Último avance'),el('p',latest.brief,'pulso-prose'),el('h4','Siguiente paso'),el('p',latest.nextAction,'pulso-prose'));detail.insertBefore(preview,recover);}
    sessionsBlock(detail, [...new Set([selectedProject?.mainSessionId, ...links.map(l => l.sessionId), ...checkpoints.map(c => c.sessionId)].filter((id): id is string => !!id))], null, recoveryId ?? null);
    const connections=el('details');connections.append(el('summary','Vincular otra sesión'));linkBlock(connections, { itemId: item.id });detail.append(connections);
    const history = el('section', '', 'pulso-section'); history.append(el('h3', 'Historial de checkpoints'));
    if (!checkpoints.length) history.append(el('p', 'Todavía no hay checkpoints. Registra uno antes de dejar esta fase.', 'pulso-muted'));
    const entries = el('ol', '', 'pulso-history');
    for (const c of [...checkpoints].sort((a,b)=>checkpointOrder(b,a))) {
      const li = el('li'); li.append(el('p', `${formatDate(c.createdAt)} · ${c.actor}`, 'pulso-muted'), el('p', c.brief, 'pulso-prose'), el('h4', 'Siguiente acción'), el('p', c.nextAction, 'pulso-prose')); entries.append(li);
    }
    history.append(entries);
    if(checkpointHasMore){const more=button('Ver puntos anteriores',async()=>{
      if(busy||disposed)return;busy=true;freeze();const epoch=selectionEpoch;
      try{const data=await request('checkpoint_history',{itemId:item.id,cursor:checkpointCursor,limit:10});if(disposed||epoch!==selectionEpoch)return;
        checkpointHasMore=!!data.hasMore;checkpointCursor=data.nextCursor??checkpointCursor+(data.checkpoints?.length??0);
        const all=[...checkpoints,...(data.checkpoints??[])];const unique=[...new Map(all.map((point:PulsoCheckpoint)=>[point.id,point])).values()];renderItem(item,links,unique,false);
      }catch{say('No se pudieron consultar los puntos anteriores. Los datos se conservan.');}finally{busy=false;if(!disposed)freeze();}
    });history.append(more);}
    detail.append(history);
    detailItemLinks = links; detailItemCheckpoints = checkpoints;
    detailRecordKey = JSON.stringify([item, links, checkpoints, selectedProject, checkpointHasMore]); freeze();
  }
  function setUndo(id: string, status: PulsoItem['status'], expectedRevision: number) {
    undoSlot.replaceChildren(el('span', 'Estado actualizado.'), button('Deshacer cambio de estado', () => write('item_update', { id, expectedRevision, status }, async data => {
      undoSlot.replaceChildren();dirty=false;if(drawerKind==='item'&&selectedItem?.id===id)await chooseItem(data.item);await reloadBoard();
    })));
  }
  function sessionsBlock(host: HTMLElement, ids: string[], recoveryId: string | null, rowRecoveryExcludeId?: string | null) {
    const section = el('section', '', 'pulso-section'); section.append(el('h3', 'Sesiones vinculadas'));
    if (recoveryId) recoveryAction(section, recoveryId, 'Abrir sesión principal', 'Continuar sesión principal', false);
    const actionAboveId = rowRecoveryExcludeId ?? recoveryId;
    if (!ids.length) section.append(el('p', 'Sin sesiones vinculadas.', 'pulso-muted'));
    const known = options.sessions();
    const titles = new Map(ids.map(id => [id, known.find(s => s.id === id)?.title ?? id]));
    const titleCounts = new Map<string, number>();
    for (const title of titles.values()) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    for (const id of ids) {
      const s = known.find(s => s.id === id); const row = el('div', '', 'pulso-session');
      const title = titles.get(id) ?? id;
      row.append(el('span', (titleCounts.get(title) ?? 0) > 1 ? `${title} · ${id.slice(-8)}` : title));
      const stateLabel=el('span','','pulso-muted');stateLabel.dataset.programSession=id;row.append(stateLabel);syncProgramLabels();
      if (s && isLivePulsoSession(s)) {
        if (id !== actionAboveId) row.append(button('Enfocar sesión viva', () => options.openSession(id)));
      }
      else if (s && !isClosed(s.status)) {
        row.append(el('span', 'Estado por comprobar', 'pulso-muted'));
        if (id !== actionAboveId) row.append(button('Inspeccionar sesión', () => options.openSession(id)));
      } else {
        row.append(el('span', 'Historial local · sesión finalizada o no disponible', 'pulso-muted'));
        if(s)row.append(button('Ver historial',()=>options.openSession(id)));
        if (rowRecoveryExcludeId !== undefined && id !== rowRecoveryExcludeId)
          recoveryAction(row, id, 'Abrir sesión vinculada', 'Continuar conversación', false);
      }
      section.append(row);
    }
    host.append(section);syncProgramLabels();
  }
  function syncProgramLabels(){
    const sessions=new Map(options.sessions().map(s=>[s.id,s]));
    for(const label of Array.from(detail.querySelectorAll<HTMLElement>('[data-program-session]'))){const state=sessions.get(label.dataset.programSession!)?.programState;label.textContent=state&&state!=='clear'?`${programStateLabel(state)} · informado por el programa`:'';}
  }
  /** Linking is an action, not a draft: choosing a session never blocks closing or navigation. */
  function linkBlock(host: HTMLElement, scope: { itemId: string } | { projectId: string }) {
    const section = el('form', '', 'pulso-form'); const s = select('Vincular otra sesión', [['', 'Seleccionar sesión'], ...sessionOptions()]); s.input.required = true;
    const go = el('button', 'Vincular sesión', 'primary'); go.type = 'submit';
    section.onsubmit = event => {
      event.preventDefault(); if (busy || failed || !s.input.value) { s.input.focus(); return; }
      void write('link', { ...scope, sessionId: s.input.value }, async () => {
        if ('itemId' in scope) { if (selectedItem) await chooseItem(selectedItem); return; }
        const links = await request('links', { projectId: scope.projectId }); projectLinks = links.links ?? [];
        if (drawerKind === 'sessions' && selectedProject?.id === scope.projectId) preserveDetailRender(() => renderSessions());
      });
    };
    section.append(s.wrap, go); host.append(section);
  }
  function bindingFor(id:string,retry=false){
    if(retry)bindings.delete(id);
    if(!bindings.has(id))bindings.set(id,Promise.resolve().then(()=>options.binding!(id)));
    return bindings.get(id)!;
  }
  async function resumeConversation(id:string){
    if(busy||dirty||failed||disposed)return;busy=true;freeze();
    const scope=selectedItem?{itemId:selectedItem.id}:selectedProject?{projectId:selectedProject.id}:null;let started=false;
    try{
      const next=await options.resumeSession!(id);started=true;bindings.delete(id);
      if(next&&scope)await request('link',{...scope,sessionId:next,requestId:`resume-link-${next}-${'itemId' in scope?'item':'project'}-${'itemId' in scope?scope.itemId:scope.projectId}`});
      // The common continuation shows its own notice (Pulso links inherited, or why not).
    }catch{
      if(started)options.notice('La sesión se abrió; no se confirmó el vínculo con el plan. Puedes vincularla manualmente.');
      else say('No se pudo continuar la conversación. Comprueba la conexión y la plaza libre y reintenta. El historial y el contexto guardado se conservan.');
    }finally{busy=false;if(!disposed)freeze();}
  }
  function recoveryAction(host:HTMLElement,id:string,liveLabel:string,resumeLabel:string,primary=true){
    const area=el('div','','pulso-recovery-action');host.append(area);area.dataset.sessionId=id;
    const region=host.classList.contains('pulso-project-recovery')?'board':'detail';
    const restoreRecoveryFocus=()=>{
      const pending=recoveryFocus;if(!pending||pending.id!==id||pending.region!==region)return;
      if(pending.epoch!==selectionEpoch||pending.gen!==generation){clearRecoveryFocus();return;}
      const target=area.querySelector<HTMLElement>('button')??area;
      if(target===area)area.tabIndex=-1;
      target.focus({preventScroll:true});if(document.activeElement===target)clearRecoveryFocus();
    };
    const session=options.sessions().find(s=>s.id===id);
    if(session&&isLivePulsoSession(session)){area.append(button(liveLabel,()=>options.openSession(id),primary?'primary':'quiet'));restoreRecoveryFocus();return;}
    if(session&&!isClosed(session.status)){
      area.append(button('Revisar estado de la sesión',()=>options.openSession(id),'quiet'));restoreRecoveryFocus();return;
    }
    if(!session||!options.binding||!options.resumeSession){area.append(el('span','Usa el historial local o el contexto guardado para continuar.','pulso-muted'));restoreRecoveryFocus();return;}
    async function check(retry=false){
      area.replaceChildren(el('span','Comprobando conversación guardada…','pulso-muted'));
      try{
        const data=await bindingFor(id,retry);
        // Read-only metadata may finish while this view is hidden. A detached
        // action is ignored; no session is ever started by a lookup or refresh.
        if(disposed||!area.isConnected||!root.contains(area))return;
        area.replaceChildren();
        const active=options.sessions().find(s=>s.id===data.activeSessionId&&isLivePulsoSession(s));
        if(active)area.append(button('Abrir conversación activa',()=>options.openSession(active.id),primary?'primary':'quiet'));
        else if(data.activeSessionId&&options.sessions().some(s=>s.id===data.activeSessionId&&!isClosed(s.status)))area.append(button('Revisar estado de la sesión',()=>options.openSession(data.activeSessionId!),'quiet'));
        else if(data.binding?.provider==='claude'&&data.binding.conversationId)area.append(button(resumeLabel,()=>resumeConversation(id),primary?'primary':'quiet'));
        else {
          // The board header has one line: it only names the action; the reason lives in its tooltip and in Sesiones.
          const why=session?.kind==='codex'?'Codex en terminal no permite continuar la conversación.':'La sesión principal no guardó una conversación que se pueda continuar. Abre su historial desde Sesiones o empieza de nuevo.';
          const note=el('span',region==='board'?'Sin conversación que continuar':why,'pulso-muted');if(region==='board')note.title=why;area.append(note);
          if(options.restartSession&&session?.cwd)area.append(button('Empezar de nuevo aquí',()=>options.restartSession!(id),'quiet'));
        }
        freeze();restoreRecoveryFocus();
      }catch{
        if(disposed||!area.isConnected||!root.contains(area))return;
        area.replaceChildren(el('span','No se pudo comprobar la conversación.','pulso-muted'),button('Reintentar comprobación',()=>check(true),'quiet'));freeze();restoreRecoveryFocus();
      }
    }
    void check();
  }
  function notifyChange(){try{options.onChange?.();}catch{/* Observers never block Pulso. */}}
  function rememberBoard(){notifyChange();restoreBoardId=null;try{saveLastBoard(localStorage,options.persistenceKey?.()??null,selectedProject?.id??null);}catch{/* Optional view metadata. */}}
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); if (!disposed) options.notice('Copiado. Pégalo cuando estés listo.'); }
    catch { say('No se pudo copiar. Selecciona el texto y cópialo manualmente.'); }
  }
  function formatDate(value: Timestamp) { const n = time(value); return n ? new Date(n).toLocaleString('es') : String(value); }
  capture.onsubmit = e => {
    e.preventDefault();if(busy||failed||!capture.reportValidity())return;const title=captureTitle.input.value.trim();if(!title)return;
    const id=crypto.randomUUID(),startSession=startCheck.checked&&!!options.startProjectSession;
    void (async()=>{
      let created=false;
      await write('project_create',{id,title,...(originCheck.checked&&captureOrigin&&!startSession?{mainSessionId:captureOrigin.id}:{})},async data=>{created=true;dirty=false;activeEditor=null;captureTitle.input.value='';startCheck.checked=false;projects=await page<PulsoProject>('projects','projects',{archived:false});await chooseProject(data.project.id);});
      if(!created||disposed||failed)return;
      // What comes next: the first phase, ready to type in Por hacer.
      if(selectedProject?.id===id)addOpeners.todo?.();
      if(startSession&&!options.startProjectSession!(sessionId=>void adoptMainSession(id,title,sessionId)))options.notice('No se pudo abrir Nueva sesión. Puedes elegir la sesión principal en Sesiones.');
    })();
  };
  /**
   * The session started for a new project becomes its main session. Runs after
   * the Nueva sesión dialog, usually with Pulso hidden: a direct write, re-read
   * once on a conflict; a failure is only a notice (Sesiones can set it).
   */
  async function adoptMainSession(projectId:string,title:string,sessionId:string){
    for(let attempt=0;attempt<2;attempt++){
      try{
        const current=(await request('project',{id:projectId})).project as PulsoProject;if(disposed)return;
        if(current.mainSessionId===sessionId)return;
        const data=await request('project_update',{id:projectId,expectedRevision:current.revision,mainSessionId:sessionId,requestId:crypto.randomUUID()});if(disposed)return;
        if(selectedProject?.id===projectId&&!dirty&&!failed)adoptProject(data.project);
        notifyChange();if(available()&&!dirty&&!failed&&!busy)renderLists();return;
      }catch{/* Re-read once: another writer may have moved the revision. */}
    }
    if(!disposed)options.notice(`La sesión se abrió, pero no quedó como principal de «${title}». Elígela en Sesiones.`);
  }
  watch(capture);
  async function refresh():Promise<void>{
    if(!available()||dragging||busy||navigating)return;if(refreshing)return refreshing;
    const gen=generation,epoch=selectionEpoch;
    refreshing=(async()=>{try{
      const ps=await page<PulsoProject>('projects','projects',{archived:false});
      if(!available()||gen!==generation||epoch!==selectionEpoch)return;
      projects={...ps,rows:ps.rows.map(p=>({...p,plan:''}))};
      if(dirty||failed){say('Tu borrador se conserva. Guarda o descarta antes de actualizar el detalle.');return;}
      let restoreFailed=false;
      if(restoreBoardId&&!selectedProject){
        const saved=restoreBoardId;restoreBoardId=null;
        try{const [data,links]=await Promise.all([request('project',{id:saved}),request('links',{projectId:saved})]);
          if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed)return;
          if(data.project&&!data.project.archived){selectedProject=data.project;projectLinks=links.links??[];}
          else rememberBoard();
        }catch{if(!available()||gen!==generation||epoch!==selectionEpoch)return;restoreBoardId=saved;restoreFailed=true;say('No se pudo consultar el último tablero. Tus pendientes siguen disponibles. Reintenta la consulta o elige un tablero.');}
      }
      // The selected project changed elsewhere (renamed, new main session, archived): read it once.
      let projectChanged=false;
      if(selectedProject){
        const row=projects.rows.find(r=>r.id===selectedProject!.id);
        if(row?row.revision!==selectedProject.revision:!projects.hasMore&&!selectedProject.archived){
          const data=await request('project',{id:selectedProject.id});
          if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed)return;
          if(data.project&&drawerKind!=='project'&&drawerKind!=='sessions'){selectedProject=data.project;projectChanged=true;}
        }
      }
      const changed=await readBoard(selectedProject?.id??null,boardRevision);
      if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed)return;
      const sessionKey=sessionSignature(),context=options.bindingCacheKey?.()??'';const sessionsChanged=shownSessions!==sessionKey||bindingContext!==context;if(sessionsChanged)bindings.clear();shownSessions=sessionKey;bindingContext=context;revision=boardRevision;if(changed)notifyChange();if(changed||sessionsChanged||projectChanged)renderLists();errors.hidden=!restoreFailed;if(restoreFailed)readError(()=>refresh());syncProgramLabels();
      if((changed||sessionsChanged)&&drawerKind==='item'&&selectedItem){
        if(changed){
          const data=await request('item',{id:selectedItem.id});
          const projectRow=projects.rows.find(p=>p.id===data.item.projectId);
          const project=data.item.projectId
            ? projectRow?.revision===selectedProject?.revision ? selectedProject : (await request('project',{id:data.item.projectId})).project
            : null;
          if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed||drawerKind!=='item')return;
          if(project?.archived){archivedElsewhere(project);return;}
          const freshCheckpoints=data.checkpoints??[];
          const freshIds=new Set(freshCheckpoints.map((point:PulsoCheckpoint)=>point.id));
          const checkpoints=[...freshCheckpoints,...detailItemCheckpoints.filter(point=>!freshIds.has(point.id))];
          const hasMore=checkpointHasMore&&!!data.checkpointsHasMore;
          const nextKey=JSON.stringify([data.item,data.links??[],checkpoints,project,hasMore]);
          if(nextKey!==detailRecordKey||sessionsChanged){
            selectedProject=project;selectedItem=data.item;checkpointHasMore=hasMore;checkpointCursor=Math.max(checkpointCursor,data.checkpointCursor??10,checkpoints.length);
            preserveDetailRender(()=>renderItem(data.item,data.links??[],checkpoints,false));
          }
        }else preserveDetailRender(()=>renderItem(selectedItem!,detailItemLinks,detailItemCheckpoints,false));
      }
      else if((changed||sessionsChanged)&&(drawerKind==='project'||drawerKind==='sessions')&&selectedProject){
        // Proyecto shows no sessions: only a data change repaints it.
        const kind=drawerKind,render=()=>kind==='project'?renderProject(false):renderSessions();
        if(changed){
          const [data,links]=await Promise.all([request('project',{id:selectedProject.id}),request('links',{projectId:selectedProject.id})]);
          if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed||drawerKind!==kind)return;
          if(data.project?.archived){archivedElsewhere(data.project);return;}
          const nextKey=JSON.stringify([data.project,links.links??[]]);
          if(nextKey!==detailRecordKey||(sessionsChanged&&kind==='sessions')){selectedProject=data.project;projectLinks=links.links??[];preserveDetailRender(render);}
        }else if(kind==='sessions')preserveDetailRender(render);
      }
    }catch{if(available()&&gen===generation&&!failed)readError(()=>refresh());}})().finally(()=>{refreshing=null;});return refreshing;
  }
  /** Another window or an agent archived the open project: no editable drawer stays on a read-only board. */
  function archivedElsewhere(project:PulsoProject){
    hideDrawer();drawerKind=null;selectedItem=null;flushProject=null;afterRelease=null;activeEditor=null;
    selectedProject=project;undoSlot.replaceChildren();renderLists();
    options.notice(`«${project.title}» se archivó desde otro sitio: está en Terminados, en solo lectura.`);
  }
  /** Send a pending Proyecto autosave now (closing, hiding the window). The request leaves synchronously. */
  function flushNow(){if(!disposed&&dirty&&!failed&&flushProject)void flushProject();}
  function stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule() {
    stop(); if (!available() || options.revisionFromStatus?.()) return;
    timer = setTimeout(async () => {
      if (!available()) return;
      try {
        syncProgramLabels();if(!busy&&!refreshing&&!dirty&&!failed&&!dragging&&!navigating){
          const data=await request('revision');
          if(available()&&(data.revision!==boardRevision||shownSessions!==sessionSignature()||bindingContext!==(options.bindingCacheKey?.()??'')))await refresh();
        }
      } catch { if (available() && !failed) readError(() => refresh()); }
      finally { schedule(); }
    }, 2000);
  }
  /**
   * Session set or connection changed while the board revision did not:
   * repaint cards, linked sessions and labels from what is loaded, without
   * reading Pulso (the 1.3.x timer did a full refresh for this).
   */
  function applySessionContext(){
    const sessionKey=sessionSignature(),context=options.bindingCacheKey?.()??'';
    if(shownSessions===sessionKey&&bindingContext===context)return;
    bindings.clear();shownSessions=sessionKey;bindingContext=context;renderLists();syncProgramLabels();
    if(drawerKind==='item'&&selectedItem)preserveDetailRender(()=>renderItem(selectedItem!,detailItemLinks,detailItemCheckpoints,false));
    else if(drawerKind==='sessions'&&selectedProject)preserveDetailRender(()=>renderSessions());
  }
  let lastAuto={key:'',at:0};
  /** Runner 1.4: called on every status. Reads Pulso only when its revision moved past the loaded board. */
  function statusChanged(revision:number|null){
    if(disposed)return;
    if(!options.revisionFromStatus?.()){if(timer===undefined&&available())schedule();return;}
    stop();if(!available())return;
    syncProgramLabels();syncCardFooters();
    if(busy||refreshing||dirty||failed||dragging||navigating)return;
    const context=options.bindingCacheKey?.()??'',sessionKey=sessionSignature();
    const revisionChanged=typeof revision==='number'&&(typeof boardRevision!=='number'||revision>boardRevision);
    const sessionsChanged=shownSessions!==sessionKey||bindingContext!==context;
    if(!revisionChanged&&!sessionsChanged)return;
    if(!revisionChanged){applySessionContext();return;}
    // A failing read is retried at most every 2 s, like the old timer.
    const key=`${revision}|${sessionKey}|${context}`;
    if(key===lastAuto.key&&Date.now()-lastAuto.at<2000)return;
    lastAuto={key,at:Date.now()};void refresh();
  }
  function visibility() { if (document.hidden) flushNow(); stop(); if (available()) { void refresh(); schedule(); } }
  document.addEventListener('visibilitychange', visibility); addEventListener('pagehide', flushNow);
  return {
    show(){if(disposed)return;const profile=options.persistenceKey?.()??null;if(restoredProfile!==profile){restoredProfile=profile;try{restoreBoardId=readLastBoard(localStorage,profile);}catch{restoreBoardId=null;}}syncOrigin();visible=true;root.hidden=false;freeze();if(drawerRestore&&drawerKind){openDrawer(drawerKind,drawerTitle.textContent??'Detalle');drawerRestore=false;}void refresh();schedule();},
    hide() {if(disposed)return;visible=false;closeMoveMenu(false);cancelActiveDrag?.();clearRecoveryFocus();if(navigating)selectedProject=boardProject;navigating=false;drawerRestore=drawer.open;hideDrawer();visible=false;root.hidden=true;generation++;selectionEpoch++;stop();freeze();},
    refresh,
    /** Sidebar entry: same guards as the tabs; a draft or failed save keeps the current board. */
    async openBoard(projectId){
      if(disposed||!visible)return;restoreBoardId=null;
      if(refreshing)await refreshing.catch(()=>{});
      if(disposed||!visible)return;
      if(projectId===null)await choosePending();else await chooseProject(projectId);
    },
    currentBoard(){return selectedProject?.id??null;},
    statusChanged,
    /** Live session state in card footers (no Pulso read). */
    syncLive(){if(available())syncCardFooters();},
    /** Command palette: phases of the project board already loaded; never reads. */
    loadedPhases(){
      // An archived (read-only) board offers no phases to open.
      if(disposed||typeof boardScope!=='string'||!boardProject||boardProject.id!==boardScope||boardProject.archived)return null;
      return{board:boardProject.title,phases:statuses.flatMap(status=>columns[status].rows.map(item=>({id:item.id,title:item.title,status:item.status,statusLabel:labels[item.status]})))};
    },
    /** Command palette: open a loaded phase's drawer with the usual draft guards. */
    async openPhase(id){
      if(disposed||!visible)return;
      if(refreshing)await refreshing.catch(()=>{});
      if(disposed||!visible)return;
      const item=statuses.flatMap(status=>columns[status].rows).find(row=>row.id===id);
      if(!item){say('Esa fase ya no está en el tablero cargado.');return;}
      await chooseItem(item);
    },
    /** Command palette: the same form as the "+" in the top bar (its own draft guards apply). */
    newProject(){if(!disposed&&visible)newProject();},
    /** Command palette: close the card "…" menu before opening over the board. */
    closeMenus(){closeMoveMenu(false);},
    /** Command palette: why the tabs, phases and "+" are not usable now (null = usable). Same state as freeze(). */
    draftBlocked(){if(disposed)return null;if(dirty&&!failed&&drawerKind==='project'&&flushProject)return null;if(dirty||failed)return'Guarda o descarta el borrador de Pulso';if(busy)return'Pulso está guardando un cambio';return null;},
    /** Command palette: the "…" button that owns the open move menu holding `node`, if any. */
    menuAnchor(node){return moveMenu&&node&&moveMenu.node.contains(node)?moveMenu.anchor:null;},
    prepareNavigation(){if(!visible)return true;if(busy||dirty||failed||navigating)return false;closeDrawer();drawerRestore=false;return true;},
    /**
     * A pending Proyecto autosave (no failure) does not block leaving: save it,
     * close the drawer and run `next`. True when it took over; a failed save
     * stays on the board with its error.
     */
    saveThen(next){
      if(!visible||disposed||!dirty||failed||busy||drawerKind!=='project'||!flushProject)return false;
      const flush=flushProject;say('Guardando el proyecto…');
      void flush().then(ok=>{
        if(disposed||!visible)return;
        if(!ok||dirty||failed){say('No se guardó el proyecto. Sigues en el tablero.');return;}
        hideDrawer();drawerKind=null;flushProject=null;afterRelease=null;activeEditor=null;drawerRestore=false;say('');next();
      });
      return true;
    },
    dispose() { if (disposed) return; flushNow(); removeEventListener('pagehide', flushNow); disposed = true; visible = false;closeMoveMenu(false);outline.remove();cancelActiveDrag?.();clearRecoveryFocus(); generation++; selectionEpoch++; stop(); document.removeEventListener('visibilitychange', visibility); failed = null;drawer.close();root.remove(); },
  };
}

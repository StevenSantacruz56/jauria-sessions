import './pulso-panel.css';
import { readLastBoard,saveLastBoard } from './board-preferences';

export type Session = { id: string; title: string; kind: string; cwd: string | null; status: string; programState?:string|null };
type Timestamp = number | string;
export type PulsoProject = { id: string; title: string; plan: string; mainSessionId: string | null; revision: number; archived: boolean; createdAt: Timestamp; updatedAt: Timestamp };
export type PulsoItem = { id: string; projectId: string | null; title: string; note: string; status: 'todo' | 'doing' | 'waiting' | 'done'; position: number; revision: number; archived: boolean; createdAt: Timestamp; updatedAt: Timestamp; updatedBy?: string; updatedSessionId?: string | null };
export type PulsoCheckpoint = { id: string; itemId: string; brief: string; nextAction: string; sessionId?: string | null; actor: string; createdAt: Timestamp; revision?:number };
type Link = { projectId?: string; itemId?: string; sessionId: string };
export type PulsoPanelOptions = {
  host: HTMLElement;
  request: (op: string, args: Record<string, unknown>) => Promise<any>;
  sessions: () => Session[];
  openSession: (id: string) => void;
  newSession: (cwd?: string) => void;
  currentSession: () => Session | null;
  notice: (text: string) => void;
  onOpenPermissions?: (context:{projectId?:string;sessionId?:string}) => void;
  persistenceKey?: () => string | null;
  bindingCacheKey?: () => string;
  backToTerminal?: () => void;
  binding?: (id: string) => Promise<{ binding: { provider: string; conversationId: string } | null; activeSessionId?:string|null }>;
  resumeSession?: (sourceId: string) => Promise<string|void>;
};
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
export function mountPulsoPanel(options: PulsoPanelOptions): { show(): void; hide(): void; refresh(): Promise<void>; prepareNavigation(): boolean; dispose(): void } {
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
  const header = el('header', '', 'pulso-header'); const heading = el('div');
  heading.append(el('h1', 'Pulso'), el('p', 'Tu trabajo, de una fase a la siguiente.', 'pulso-muted'));
  const headerActions=el('div','','pulso-header-actions');
  if(options.backToTerminal)headerActions.append(button('Volver a terminal',()=>options.backToTerminal!(),'quiet'));
  headerActions.append(button('Nuevo proyecto',()=>newProject(),'primary'),button('Actualizar',()=>refresh(),'quiet'));
  header.append(heading,headerActions);
  const feedback = el('div', '', 'pulso-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const errors = el('div', '', 'pulso-error'); errors.hidden = true; errors.setAttribute('role', 'alert');
  const undoSlot = el('div', '', 'pulso-undo');
  const outline=el('nav','','pulso-tabs');outline.setAttribute('aria-label','Tableros de Pulso');
  const projectList=el('div','','pulso-project-tabs');outline.append(projectList);
  const toolbar=el('div','','pulso-board-toolbar');
  const board=el('div','','pulso-board');board.setAttribute('aria-label','Tablero de trabajo');
  const drawer=el('dialog','','pulso-drawer');drawer.setAttribute('aria-label','Detalle de Pulso');
  const drawerHeader=el('header','','pulso-drawer-header');const drawerTitle=el('h2','Detalle');
  const closeDetail=button('',()=>closeDrawer(),'quiet');closeDetail.setAttribute('aria-label','Cerrar detalle');closeDetail.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';drawerHeader.append(drawerTitle,closeDetail);
  const drawerMessages=el('div','','pulso-drawer-messages');
  const detail=el('section','','pulso-detail');detail.setAttribute('aria-label','Detalle de Pulso');drawer.append(drawerHeader,drawerMessages,detail);
  drawer.addEventListener('cancel',event=>{event.preventDefault();closeDrawer();});
  root.append(header,outline,feedback,errors,undoSlot,toolbar,board,drawer);options.host.append(root);
  const capture=el('form','','pulso-capture');const captureTitle=field('Nombre del proyecto',false,240);captureTitle.input.required=true;captureTitle.input.placeholder='Por ejemplo: lanzar mi aplicación';
  const originLabel=el('label','','pulso-check');const originCheck=el('input');originCheck.type='checkbox';originCheck.checked=true;
  const originText=el('span');originLabel.append(originCheck,originText);
  function syncOrigin(){const session=options.currentSession();originLabel.hidden=!session;originText.textContent=session?`Usar «${session.title}» como sesión principal`:'';}
  capture.append(captureTitle.wrap,originLabel);const captureSave=el('button','Crear proyecto','primary');captureSave.type='submit';capture.append(captureSave,button('Cancelar',()=>{dirty=false;activeEditor=null;closeDrawer();},'quiet'));

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
  let drawerKind:'item'|'project'|'create'|null=null;
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
  let editBase: { revision: number } | null = null;
  type Mutation = { op: string; args: Record<string, unknown>; apply: (data: any) => void | Promise<void> };
  let failed: Mutation | null = null;
  const bindings = new Map<string, ReturnType<NonNullable<PulsoPanelOptions['binding']>>>();
  const available = () => visible && !disposed && !document.hidden;
  const say = (message: string) => { if (!disposed) feedback.textContent = message; };
  function freeze() {
    root.setAttribute('aria-busy', String(busy));
    for (const n of Array.from(root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea'))) {
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
      say('Guardado.');
    } catch (error) {
      if (disposed) return;
      failed = m; errors.hidden = false;
      errors.replaceChildren(el('p', String(error).includes('Pulso local storage budget reached') ? 'Se alcanzó el espacio local reservado para nuevos cambios de Pulso. Los registros existentes y las terminales se conservan; consulta la guía de respaldo antes de continuar.' : 'No se confirmó el cambio. Tu borrador sigue aquí. Reintentar reutiliza la misma solicitud; si hay un conflicto, consulta la versión actual.'),
        button('Reintentar mismo cambio', () => mutate(m)),
        button('Consultar versión actual', () => inspectRevision(m)),
        button('Liberar borrador', () => {
          failed = null; errors.hidden = true;if(!drawer.open)renderLists();freeze();
          say('Borrador editable. El cambio anterior pudo guardarse; consulta la versión actual antes de volver a guardar.');
        }));
    } finally { busy = false; if (!disposed) freeze(); }
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
        failed = null; errors.hidden = true; freeze(); say('Revisión actualizada. Revisa tu borrador y guarda de nuevo cuando esté listo.');
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
  function openDrawer(kind:'item'|'project'|'create',title:string){drawerKind=kind;drawerTitle.textContent=title;drawerMessages.append(feedback,errors);if(!drawer.open&&available())drawer.showModal();}
  function hideDrawer(){if(drawer.open){intentionalCloses++;drawer.close();}root.insertBefore(feedback,toolbar);root.insertBefore(errors,toolbar);}
  function closeDrawer(){if(busy)return;if(dirty||failed){say('Guarda los cambios o descarta el borrador antes de cerrar.');return;}hideDrawer();drawerKind=null;selectedItem=null;activeEditor=null;}
  function newProject(){if(dirty||failed||busy)return;selectionEpoch++;navigating=false;selectedProject=boardProject;selectedItem=null;detail.replaceChildren(capture);captureTitle.input.value='';syncOrigin();openDrawer('create','Nuevo proyecto');captureTitle.input.focus();}
  function renderLists() {
    const focus=document.activeElement instanceof HTMLElement?document.activeElement.dataset.focusKey:undefined;
    projectList.replaceChildren();
    const pendingTab=button('Pendientes',()=>choosePending(),'pulso-tab');pendingTab.setAttribute('aria-current',String(!selectedProject));projectList.append(pendingTab);
    const visibleProjects=selectedProject&&!projects.rows.some(p=>p.id===selectedProject!.id)?[...projects.rows,selectedProject]:projects.rows;
    for(const project of visibleProjects){const b=button(project.title,()=>chooseProject(project.id),'pulso-tab');b.dataset.focusKey=`project-${project.id}`;b.setAttribute('aria-current',String(selectedProject?.id===project.id));projectList.append(b);}
    if(projects.hasMore)projectList.append(button('Más proyectos',()=>loadMoreProjects(),'quiet'));
    if(!dirty&&!failed&&!dragging)renderBoard();freeze();
    if(focus&&available())Array.from(outline.querySelectorAll<HTMLElement>('[data-focus-key]')).find(n=>n.dataset.focusKey===focus)?.focus({preventScroll:true});
  }
  function renderBoard(){
    const focus=document.activeElement instanceof HTMLElement?document.activeElement.dataset.focusKey:undefined;
    const scrolls=new Map(Array.from(board.querySelectorAll<HTMLElement>('.pulso-cards')).map(n=>[n.dataset.status,n.scrollTop]));
    toolbar.replaceChildren();const name=el('div');name.append(el('h2',selectedProject?.title??'Pendientes'));
    const total=statuses.reduce((n,status)=>n+columns[status].totalCount,0);const complete=columns.done.totalCount;
    name.append(el('p',total?`${complete} de ${total} ${selectedProject?'fases':'pendientes'} en Hecho · ${selectedProject?'orden según el plan':'orden original'} · arrastra entre columnas`:'Añade una tarjeta en la columna donde quieras empezar.','pulso-progress'));toolbar.append(name);
    if(selectedProject?.mainSessionId){const recovery=el('div','','pulso-project-recovery');recoveryAction(recovery,selectedProject.mainSessionId,'Abrir sesión principal','Reanudar sesión principal');toolbar.append(recovery);}
    if(selectedProject)toolbar.append(button('Plan y sesiones',()=>{if(dirty||failed)return;selectedItem=null;renderProject(true);openDrawer('project','Plan y sesiones');},'quiet'));
    board.replaceChildren();
    for(const status of statuses){
      const column=el('section','','pulso-column');column.dataset.state=status;column.setAttribute('aria-label',labels[status]);
      const h=el('header');h.append(el('h3',labels[status]),el('span',String(columns[status].totalCount),'pulso-count'));column.append(h);
      const cards=el('div','','pulso-cards');cards.dataset.status=status;
      for(const item of columns[status].rows)cards.append(itemCard(item));
      if(!columns[status].rows.length)cards.append(el('p',status==='done'?'Lo que termines aparecerá aquí.':status==='waiting'?'Trabajo que necesita algo antes de seguir.':status==='doing'?'Pon aquí la fase en la que estás trabajando.':'Captura el siguiente paso.','pulso-empty'));
      if(columns[status].hasMore)cards.append(button('Ver más tarjetas',()=>loadMoreColumn(status),'quiet'));
      column.append(cards);
      if(status!=='done'){
        const add=el('form','','pulso-add-form');add.hidden=true;
        const title=field(selectedProject?'Título de la fase':'Título del pendiente',false,240);title.input.required=true;title.input.placeholder='Escribe un título';
        const trigger=button(selectedProject?'Añadir fase':'Añadir pendiente',()=>{if(busy||dirty||failed)return;add.hidden=false;trigger.hidden=true;title.input.focus();},'quiet pulso-add-trigger');
        const cancel=button('Cancelar',()=>{dirty=false;activeEditor=null;add.hidden=true;trigger.hidden=false;title.input.value='';freeze();},'quiet');
        add.append(title.wrap);submit(add,'Añadir tarjeta',()=>write('item_create',{id:crypto.randomUUID(),projectId:selectedProject?.id??null,title:title.input.value.trim(),status},async()=>{dirty=false;activeEditor=null;await reloadBoard();}));add.append(cancel);column.append(trigger,add);
      }
      board.append(column);cards.scrollTop=scrolls.get(status)??0;
    }
    if(focus)Array.from(board.querySelectorAll<HTMLElement>('[data-focus-key]')).find(n=>n.dataset.focusKey===focus)?.focus({preventScroll:true});
  }
  function itemCard(item:PulsoItem){
    const card=el('article','','pulso-card');card.dataset.itemId=item.id;card.dataset.state=item.status;
    const open=button('',()=>chooseItem(item),'pulso-card-open');open.dataset.focusKey=`item-${item.id}`;open.setAttribute('aria-label',`Abrir ${item.title}`);
    open.append(el('span',item.title,'pulso-card-title'));if(item.note)open.append(el('span',item.note,'pulso-card-note'));card.append(open);
    const footer=el('div','','pulso-card-footer');
    const move=select(`Mover ${item.title}`,Object.entries(labels),item.status);move.input.classList.add('pulso-card-move');move.input.onchange=()=>{void moveCard(item,move.input.value as PulsoItem['status']);};footer.append(move.input);
    const handle=button('',()=>say('Arrastra esta tarjeta a otra columna o utiliza el menú Mover.'),'quiet pulso-card-handle');handle.setAttribute('aria-label',`Arrastrar ${item.title}`);
    handle.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" stroke-linecap="round"/></svg>';
    handle.addEventListener('pointerdown',event=>startDrag(event,item,card,handle));footer.append(handle);card.append(footer);return card;
  }
  function startDrag(event:PointerEvent,item:PulsoItem,card:HTMLElement,handle:HTMLElement){
    if(event.button!==0||busy||dirty||failed)return;event.preventDefault();dragging=true;handle.setPointerCapture(event.pointerId);let target:PulsoItem['status']|null=null;card.classList.add('is-dragging');
    const move=(e:PointerEvent)=>{for(const c of Array.from(board.querySelectorAll('.is-drop-target')))c.classList.remove('is-drop-target');const col=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('.pulso-column');target=(col?.dataset.state as PulsoItem['status'])??null;col?.classList.add('is-drop-target');};
    const finish=(e:PointerEvent)=>{cancelActiveDrag=null;document.removeEventListener('keydown',keyCancel);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',cancel);handle.removeEventListener('lostpointercapture',cancel);if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);card.classList.remove('is-dragging');for(const c of Array.from(board.querySelectorAll('.is-drop-target')))c.classList.remove('is-drop-target');dragging=false;if(target&&target!==item.status)void moveCard(item,target);else if(available()&&!dirty&&!failed)renderBoard();};
    const cancel=(e:PointerEvent)=>{target=null;finish(e);};const keyCancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();cancel(event);}};cancelActiveDrag=()=>cancel(event);document.addEventListener('keydown',keyCancel);handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',cancel);handle.addEventListener('lostpointercapture',cancel);
  }
  async function moveCard(item:PulsoItem,status:PulsoItem['status']){
    if(!available()||busy||dirty||failed||status===item.status)return;
    say('Moviendo tarjeta…');await write('item_update',{id:item.id,status,expectedRevision:item.revision},async data=>{setUndo(item.id,item.status,data.item.revision);await reloadBoard();});
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
    catch{if(available()&&epoch===selectionEpoch&&gen===generation){readError(()=>refresh());say('El tablero cambió o no se pudo leer esta página. Actualiza para ver las tarjetas vigentes.');}}finally{busy=false;freeze();}
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
  function sessionOptions() { return options.sessions().map(s => [s.id, `${s.title} · ${isLivePulsoSession(s) ? 'viva' : ['exited', 'stopped', 'released', 'failed', 'interrupted'].includes(s.status) ? 'historial local' : 'estado por comprobar'}`] as [string, string]); }
  function renderProject(queryBindings: boolean) {
    const p = selectedProject!; detail.replaceChildren(); dirty = false; editBase = { revision: p.revision }; const base = editBase;
    activeEditor = null; detail.append(el('h2', p.title));
    const form = el('form', '', 'pulso-form');
    const title = field('Título del proyecto', false, 240); title.input.value = p.title; title.input.required = true;
    const planDetails = el('details'); planDetails.append(el('summary', 'Plan completo (opcional)'));
    const plan = field('Plan completo · hasta 32 000 caracteres', true, 32000); plan.input.value = p.plan ?? ''; planDetails.append(plan.wrap);
    const main = select('Sesión principal', [['', 'Sin sesión principal'], ...sessionOptions()], p.mainSessionId ?? '');
    if (p.mainSessionId && !options.sessions().some(s => s.id === p.mainSessionId)) {
      const o = el('option', `${p.mainSessionId} · historial local`); o.value = p.mainSessionId; main.input.append(o); main.input.value = p.mainSessionId;
    }
    form.append(title.wrap, planDetails, main.wrap);
    submit(form, 'Guardar proyecto', () => write('project_update', { id: p.id, expectedRevision: base.revision, title: title.input.value.trim(), plan: plan.input.value, mainSessionId: main.input.value || null }, async () => {
      dirty=false;await chooseProject(p.id);await refresh();
    })); form.append(discardButton()); detail.append(form);
    sessionsBlock(detail, [...new Set([p.mainSessionId, ...projectLinks.map(l => l.sessionId)].filter((id): id is string => !!id))], p.mainSessionId);
    linkBlock(detail, { projectId: p.id }); permissionsLink(detail,p.id);freeze();
  }
  function renderItem(item: PulsoItem, links: Link[], checkpoints: PulsoCheckpoint[], queryBindings: boolean) {
    detail.replaceChildren(); dirty = false; activeEditor = null; editBase = { revision: item.revision }; const base = editBase;
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
    const session = select('Sesión del checkpoint', [['', 'Sin sesión'], ...sessionOptions()], options.currentSession()?.id ?? '');
    checkpoint.append(brief.wrap, next.wrap, session.wrap);
    submit(checkpoint, 'Registrar checkpoint', () => write('checkpoint_create', {
      id: crypto.randomUUID(), itemId: item.id, expectedRevision: base.revision, brief: brief.input.value.trim(), nextAction: next.input.value.trim(), ...(session.input.value ? { sessionId: session.input.value } : {}),
    }, async data => {dirty=false;await chooseItem(data.item);await reloadBoard();})); checkpoint.append(discardButton());const saveAdvance=el('details');saveAdvance.append(el('summary','Guardar avance'),checkpoint);detail.append(saveAdvance);
    const recover = el('section', '', 'pulso-section'); recover.append(el('h3', 'Continuar fase'));
    const recent=[...checkpoints].sort(checkpointOrder).at(-1);const recoveryId=recent?.sessionId??links[0]?.sessionId??selectedProject?.mainSessionId;
    if(recoveryId)recoveryAction(recover,recoveryId,'Abrir sesión de la fase','Reanudar sesión de la fase');
    recover.append(el('p', 'Prepara el contexto, revísalo y cópialo. Tú decides dónde pegarlo.', 'pulso-muted'));
    const composer = el('div'); composer.hidden = true;
    recover.append(button('Preparar contexto', () => { composer.hidden = false; }));
    const context = field('Contexto editable para continuar', true, 50000); context.input.value = pulsoContinuation(selectedProject, item, checkpoints);
    composer.append(context.wrap, button('Copiar contexto', () => copy(context.input.value)), discardButton()); watch(composer);
    const known = options.sessions(); const source = known.find(s => s.id === recoveryId);
    composer.append(button('Abrir nueva sesión', () => options.newSession(source?.cwd ?? undefined)), el('p', 'Abre una sesión vacía. El contexto no se envía automáticamente.', 'pulso-muted'));
    recover.append(composer); detail.insertBefore(recover,form);
    const latest=[...checkpoints].sort(checkpointOrder).at(-1);if(latest){const preview=el('section','','pulso-checkpoint-preview');preview.append(el('h3','Último avance'),el('p',latest.brief,'pulso-prose'),el('h4','Siguiente paso'),el('p',latest.nextAction,'pulso-prose'));detail.insertBefore(preview,recover);}
    sessionsBlock(detail, [...new Set([selectedProject?.mainSessionId, ...links.map(l => l.sessionId), ...checkpoints.map(c => c.sessionId)].filter((id): id is string => !!id))], null);
    const connections=el('details');connections.append(el('summary','Vincular otra sesión'));linkBlock(connections, { itemId: item.id });detail.append(connections);permissionsLink(detail,item.projectId??undefined);
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
    detail.append(history); freeze();
  }
  function setUndo(id: string, status: PulsoItem['status'], expectedRevision: number) {
    undoSlot.replaceChildren(el('span', 'Estado actualizado.'), button('Deshacer cambio de estado', () => write('item_update', { id, expectedRevision, status }, async data => {
      undoSlot.replaceChildren();dirty=false;if(drawerKind==='item'&&selectedItem?.id===id)await chooseItem(data.item);await reloadBoard();
    })));
  }
  function sessionsBlock(host: HTMLElement, ids: string[], recoveryId: string | null) {
    const section = el('section', '', 'pulso-section'); section.append(el('h3', 'Sesiones vinculadas'));
    if (recoveryId) recoveryAction(section, recoveryId, 'Abrir sesión principal', 'Reanudar sesión principal', false);
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
      if (s && isLivePulsoSession(s)) row.append(button('Enfocar sesión viva', () => options.openSession(id)));
      else if (s && !['exited', 'stopped', 'released', 'failed', 'interrupted'].includes(s.status)) {
        row.append(el('span', 'Estado por comprobar', 'pulso-muted'), button('Inspeccionar sesión', () => options.openSession(id)));
      } else {
        row.append(el('span', 'Historial local · sesión finalizada o no disponible', 'pulso-muted'));
        if(s)row.append(button('Ver historial',()=>options.openSession(id)));
      }
      section.append(row);
    }
    host.append(section);syncProgramLabels();
  }
  function syncProgramLabels(){
    const sessions=new Map(options.sessions().map(s=>[s.id,s]));const text:Record<string,string>={working:'Trabajando',blocked:'Solicita atención',error:'Error informado',done:'Turno finalizado',idle:'En espera'};
    for(const label of Array.from(detail.querySelectorAll<HTMLElement>('[data-program-session]'))){const state=sessions.get(label.dataset.programSession!)?.programState;label.textContent=state&&text[state]?`${text[state]} · informado por el programa`:'';}
  }
  function linkBlock(host: HTMLElement, scope: { itemId: string } | { projectId: string }) {
    const section = el('form', '', 'pulso-form'); const s = select('Vincular una sesión existente', [['', 'Seleccionar sesión'], ...sessionOptions()]); s.input.required = true;
    section.append(s.wrap); submit(section, 'Vincular sesión', () => write('link', { ...scope, sessionId: s.input.value }, async () => {
      dirty = false; if (selectedItem) await chooseItem(selectedItem); else if (selectedProject) await chooseProject(selectedProject.id);
    })); section.append(discardButton()); host.append(section);
  }
  function permissionsLink(host:HTMLElement,projectId?:string){
    const section=el('section','','pulso-section');section.append(el('h3','Acceso de agentes'),el('p','En Configuración, elige la sesión y este proyecto, concede acceso y copia el comando a la sesión del agente. Cada acceso conserva su alcance.','pulso-muted'));
    section.append(button('Configurar permisos…',()=>{if(busy||dirty||failed)return;options.onOpenPermissions?.({...(projectId?{projectId}:{}),...(options.currentSession()?{sessionId:options.currentSession()!.id}:{})});},'quiet'));
    host.append(section);
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
      if(!disposed)options.notice('Conversación abierta con su identidad guardada.');
    }catch(error){
      if(started)options.notice('La sesión se abrió; no se confirmó el vínculo con el plan. Puedes vincularla manualmente.');
      else say(`No se pudo reanudar la sesión: ${error instanceof Error?error.message:String(error)}. El historial y el contexto guardado se conservan.`);
    }finally{busy=false;if(!disposed)freeze();}
  }
  function recoveryAction(host:HTMLElement,id:string,liveLabel:string,resumeLabel:string,primary=true){
    const area=el('div','','pulso-recovery-action');host.append(area);
    const session=options.sessions().find(s=>s.id===id);
    if(session&&isLivePulsoSession(session)){area.append(button(liveLabel,()=>options.openSession(id),primary?'primary':'quiet'));return;}
    if(session&&!['exited','stopped','released','failed','interrupted'].includes(session.status)){
      area.append(button('Revisar estado de la sesión',()=>options.openSession(id),'quiet'));return;
    }
    if(!session||!options.binding||!options.resumeSession){area.append(el('span','Usa el historial local o el contexto guardado para continuar.','pulso-muted'));return;}
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
        else if(data.activeSessionId&&options.sessions().some(s=>s.id===data.activeSessionId&&!['exited','stopped','released','failed','interrupted'].includes(s.status)))area.append(button('Revisar estado de la sesión',()=>options.openSession(data.activeSessionId!),'quiet'));
        else if(data.binding?.provider==='claude'&&data.binding.conversationId)area.append(button(resumeLabel,()=>resumeConversation(id),primary?'primary':'quiet'));
        else area.append(el('span',session?.kind==='codex'?'Codex: continúa con el historial local o el contexto de la fase.':'No hay una identidad de conversación registrada. Usa el historial o prepara el contexto.','pulso-muted'));
        freeze();
      }catch{
        if(disposed||!area.isConnected||!root.contains(area))return;
        area.replaceChildren(el('span','No se pudo comprobar la conversación.','pulso-muted'),button('Reintentar comprobación',()=>check(true),'quiet'));freeze();
      }
    }
    void check();
  }
  function rememberBoard(){restoreBoardId=null;try{saveLastBoard(localStorage,options.persistenceKey?.()??null,selectedProject?.id??null);}catch{/* Optional view metadata. */}}
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); if (!disposed) options.notice('Copiado. Pégalo cuando estés listo.'); }
    catch { say('No se pudo copiar. Selecciona el texto y cópialo manualmente.'); }
  }
  function formatDate(value: Timestamp) { const n = time(value); return n ? new Date(n).toLocaleString('es') : String(value); }
  capture.onsubmit = e => {
    e.preventDefault();if(busy||failed||!capture.reportValidity())return;const title=captureTitle.input.value.trim();if(!title)return;
    void write('project_create',{id:crypto.randomUUID(),title,...(originCheck.checked&&options.currentSession()?{mainSessionId:options.currentSession()!.id}:{})},async data=>{dirty=false;activeEditor=null;captureTitle.input.value='';projects=await page<PulsoProject>('projects','projects',{archived:false});await chooseProject(data.project.id);});
  };
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
      const changed=await readBoard(selectedProject?.id??null,boardRevision);
      if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed)return;
      const sessionKey=sessionSignature(),context=options.bindingCacheKey?.()??'';const sessionsChanged=shownSessions!==sessionKey||bindingContext!==context;if(sessionsChanged)bindings.clear();shownSessions=sessionKey;bindingContext=context;revision=boardRevision;if(changed||sessionsChanged)renderLists();errors.hidden=!restoreFailed;if(restoreFailed)readError(()=>refresh());syncProgramLabels();
      if((changed||sessionsChanged)&&drawerKind==='item'&&selectedItem)await chooseItem(selectedItem,false);
      else if((changed||sessionsChanged)&&drawerKind==='project'&&selectedProject){const data=await request('project',{id:selectedProject.id});if(!available()||gen!==generation||epoch!==selectionEpoch||dirty||failed||drawerKind!=='project')return;selectedProject=data.project;renderProject(false);}
    }catch{if(available()&&gen===generation&&!failed)readError(()=>refresh());}})().finally(()=>{refreshing=null;});return refreshing;
  }
  function stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule() {
    stop(); if (!available()) return;
    timer = setTimeout(async () => {
      if (!available()) return;
      try {
        syncProgramLabels();if(!busy&&!refreshing&&!dirty&&!failed&&!dragging&&!navigating){
          syncProgramLabels();const data=await request('revision');
          if(available()&&(data.revision!==boardRevision||shownSessions!==sessionSignature()||bindingContext!==(options.bindingCacheKey?.()??'')))await refresh();
        }
      } catch { if (available() && !failed) readError(() => refresh()); }
      finally { schedule(); }
    }, 2000);
  }
  function visibility() { stop(); if (available()) { void refresh(); schedule(); } }
  document.addEventListener('visibilitychange', visibility);
  return {
    show(){if(disposed)return;const profile=options.persistenceKey?.()??null;if(restoredProfile!==profile){restoredProfile=profile;try{restoreBoardId=readLastBoard(localStorage,profile);}catch{restoreBoardId=null;}}syncOrigin();visible=true;root.hidden=false;freeze();if(drawerRestore&&drawerKind){openDrawer(drawerKind,drawerTitle.textContent??'Detalle');drawerRestore=false;}void refresh();schedule();},
    hide() {if(disposed)return;visible=false;cancelActiveDrag?.();if(navigating)selectedProject=boardProject;navigating=false;drawerRestore=drawer.open;hideDrawer();visible=false;root.hidden=true;generation++;selectionEpoch++;stop();freeze();},
    refresh,
    prepareNavigation(){if(!visible)return true;if(busy||dirty||failed||navigating)return false;closeDrawer();drawerRestore=false;return true;},
    dispose() { if (disposed) return; disposed = true; visible = false;cancelActiveDrag?.(); generation++; selectionEpoch++; stop(); document.removeEventListener('visibilitychange', visibility); failed = null;drawer.close();root.remove(); },
  };
}

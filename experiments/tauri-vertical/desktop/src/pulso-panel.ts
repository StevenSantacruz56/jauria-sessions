import './pulso-panel.css';

export type Session = { id: string; title: string; kind: string; cwd: string | null; status: string };
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
export function mountPulsoPanel(options: PulsoPanelOptions): { show(): void; hide(): void; refresh(): Promise<void>; dispose(): void } {
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
  heading.append(el('h1', 'Pulso'), el('p', 'Planes, fases y un punto claro para continuar.', 'pulso-muted'));
  header.append(heading, button('Actualizar', () => refresh()));
  const feedback = el('div', '', 'pulso-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const errors = el('div', '', 'pulso-error'); errors.hidden = true; errors.setAttribute('role', 'alert');
  const undoSlot = el('div', '', 'pulso-undo');
  const layout = el('div', '', 'pulso-layout'); const outline = el('nav', '', 'pulso-outline'); outline.setAttribute('aria-label', 'Proyectos y pendientes');
  const capture = el('form', '', 'pulso-capture');
  const captureTitle = field('Captura rápida', false, 240); captureTitle.input.placeholder = '¿Qué sigue?'; captureTitle.input.required = true;
  const captureKind = select('Guardar como', [['item', 'Pendiente independiente'], ['project', 'Proyecto']]);
  const captureSave = el('button', 'Añadir', 'primary'); captureSave.type = 'submit';
  const originLabel=el('label','','pulso-check');
  const originCheck=el('input');originCheck.type='checkbox';originCheck.checked=true;
  const originText=el('span');originLabel.append(originCheck,originText);originLabel.hidden=true;
  function syncOrigin(){const session=options.currentSession();originLabel.hidden=captureKind.input.value!=='project'||!session;originText.textContent=session?`Usar «${session.title}» como sesión principal`:'';}
  captureKind.input.addEventListener('change',syncOrigin);
  const grantPreferences=new Map<string,{sessionId:string;remember:boolean}>();
  capture.append(captureTitle.wrap, captureKind.wrap, originLabel, captureSave);
  const projectList = el('div'); const standalone = el('div');
  outline.append(capture, el('h2', 'Proyectos'), projectList, el('h2', 'Pendientes independientes'), standalone);
  const detail = el('section', '', 'pulso-detail'); detail.setAttribute('aria-label', 'Detalle de Pulso');
  detail.append(el('h2', 'Elige un proyecto o una fase'), el('p', 'Captura un título para empezar. Después puedes añadir el plan y registrar checkpoints.', 'pulso-muted'));
  layout.append(outline, detail); root.append(header, feedback, errors, undoSlot, layout); options.host.append(root);
  let disposed = false, visible = false, timer: ReturnType<typeof setTimeout> | undefined;
  let revision: unknown, refreshing: Promise<void> | null = null, refreshGeneration = 0, generation = 0, selectionEpoch = 0;
  let projects: Page<PulsoProject> = { rows: [], hasMore: false }, pending: Page<PulsoItem> = { rows: [], hasMore: false };
  let phases: Page<PulsoItem> = { rows: [], hasMore: false };
  let selectedProject: PulsoProject | null = null, selectedItem: PulsoItem | null = null;
  let checkpointHasMore=false, checkpointCursor=10;
  const sessionSignature=()=>JSON.stringify(options.sessions().map(s=>[s.id,s.status,s.title]));
  let shownSessions='';
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
      n.disabled = busy || (!!failed && !errors.contains(n)) || (dirty && !!activeEditor && !activeEditor.contains(n) && !errors.contains(n));
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
          failed = null; errors.hidden = true; freeze();
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
      if (editBase && m.args.expectedRevision !== undefined) errors.append(button('Revisé los cambios; conservar mi borrador', () => {
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
  function renderLists() {
    const focused = document.activeElement instanceof HTMLElement && outline.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    projectList.replaceChildren(); standalone.replaceChildren();
    if (!projects.rows.length) projectList.append(el('p', 'Aún no hay proyectos. Crea uno con un título.', 'pulso-empty'));
    for (const project of projects.rows) {
      const b = button(project.title, () => chooseProject(project.id), 'pulso-row');
      b.dataset.focusKey = `project-${project.id}`;
      b.setAttribute('aria-current', String(selectedProject?.id === project.id)); projectList.append(b);
      if (selectedProject?.id === project.id) {
        const group = el('ol', '', 'pulso-phases');
        for (const item of [...phases.rows].sort((a, b) => a.position - b.position || time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id))) {
          const li = el('li'); li.append(itemButton(item)); group.append(li);
        }
        projectList.append(group);
        if (!phases.rows.length) projectList.append(el('p', 'Sin fases todavía.', 'pulso-empty'));
        if (phases.hasMore) projectList.append(button('Cargar más fases', () => loadMore('phases')));
      }
    }
    if (projects.hasMore) projectList.append(button('Cargar más proyectos', () => loadMore('projects')));
    const open = pending.rows.filter(i => i.status !== 'done');
    if (!open.length) standalone.append(el('p', 'Sin pendientes en esta página.', 'pulso-empty'));
    for (const item of open) standalone.append(itemButton(item));
    if (pending.hasMore) standalone.append(button('Cargar más pendientes', () => loadMore('pending')));
    freeze();
    if (focused && available()) Array.from(outline.querySelectorAll<HTMLElement>('[data-focus-key]')).find(n => n.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  function itemButton(item: PulsoItem) {
    const b = button('', () => chooseItem(item), 'pulso-row pulso-item');
    b.dataset.focusKey = `item-${item.id}`;
    b.setAttribute('aria-current', String(selectedItem?.id === item.id));
    const status = el('span', labels[item.status], 'pulso-state'); status.dataset.state = item.status;
    b.append(el('span', item.title), status); return b;
  }
  async function loadMore(target: 'projects' | 'pending' | 'phases') {
    if (busy || disposed) return;
    busy = true; freeze(); const epoch = selectionEpoch, gen = generation;
    try {
      const old = target === 'projects' ? projects : target === 'pending' ? pending : phases;
      const next = target === 'projects'
        ? await page<PulsoProject>('projects', 'projects', { archived: false }, old as Page<PulsoProject>)
        : await page<PulsoItem>('items', 'items', { projectId: target === 'pending' ? null : selectedProject?.id, archived: false }, old as Page<PulsoItem>);
      if (disposed || gen !== generation || epoch !== selectionEpoch) return;
      if (target === 'projects') projects = next as Page<PulsoProject>;
      else if (target === 'pending') pending = next as Page<PulsoItem>; else phases = next as Page<PulsoItem>;
      renderLists();
    } catch { readError(() => loadMore(target)); }
    finally { busy = false; if (!disposed) freeze(); }
  }
  async function chooseProject(id: string, queryBindings = true) {
    if (!available()) return;
    if (dirty || failed) { say('Guarda tu borrador o pulsa «Descartar borrador» antes de cambiar de detalle.'); return; }
    const epoch = ++selectionEpoch; const gen = generation; say('Consultando proyecto…');
    try {
      const [data, items, links] = await Promise.all([request('project', { id }), page<PulsoItem>('items', 'items', { projectId: id, archived: false }), request('links', { projectId: id })]);
      if (!available() || gen !== generation || epoch !== selectionEpoch || dirty || failed) return;
      selectedProject = data.project; selectedItem = null; phases = items; projectLinks = links.links ?? [];
      renderLists(); renderProject(queryBindings); say('');
    } catch { if (epoch === selectionEpoch) readError(() => chooseProject(id)); }
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
      renderItem(data.item, data.links ?? [], data.checkpoints ?? [], queryBindings); say('');
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
      dirty = false; await chooseProject(p.id); await refresh();
    })); form.append(discardButton()); detail.append(form);
    const add = el('form', '', 'pulso-form'); add.append(el('h3', 'Añadir fase'));
    const phase = field('Título de la fase', false, 240); phase.input.required = true; add.append(phase.wrap);
    submit(add, 'Añadir fase', () => write('item_create', { id: crypto.randomUUID(), projectId: p.id, title: phase.input.value.trim() }, async () => {
      dirty = false; await chooseProject(p.id);
    })); add.append(discardButton()); detail.append(add);
    sessionsBlock(detail, [...new Set([p.mainSessionId, ...projectLinks.map(l => l.sessionId)].filter((id): id is string => !!id))], queryBindings);
    linkBlock(detail, { projectId: p.id }); grantBlock(detail, p.id); freeze();
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
      dirty = false; await chooseItem(data.item); await refresh();
    })); form.append(discardButton()); detail.append(form);
    const checkpoint = el('form', '', 'pulso-form'); checkpoint.append(el('h3', 'Registrar checkpoint'), el('p', 'Cada registro se añade al historial. Los anteriores se conservan.', 'pulso-muted'));
    const brief = field('Qué quedó listo · hasta 4 000 caracteres', true, 4000); brief.input.required = true;
    const next = field('Siguiente acción · hasta 1 000 caracteres', true, 1000); next.input.required = true;
    const session = select('Sesión del checkpoint', [['', 'Sin sesión'], ...sessionOptions()], options.currentSession()?.id ?? '');
    checkpoint.append(brief.wrap, next.wrap, session.wrap);
    submit(checkpoint, 'Registrar checkpoint', () => write('checkpoint_create', {
      id: crypto.randomUUID(), itemId: item.id, expectedRevision: base.revision, brief: brief.input.value.trim(), nextAction: next.input.value.trim(), ...(session.input.value ? { sessionId: session.input.value } : {}),
    }, async data => { dirty = false; await chooseItem(data.item); })); checkpoint.append(discardButton()); detail.append(checkpoint);
    const recover = el('section', '', 'pulso-section'); recover.append(el('h3', 'Continuar fase'));
    recover.append(el('p', 'Prepara el contexto, revísalo y cópialo. Tú decides dónde pegarlo.', 'pulso-muted'));
    const composer = el('div'); composer.hidden = true;
    recover.append(button('Preparar contexto', () => { composer.hidden = false; }));
    const context = field('Contexto editable para continuar', true, 50000); context.input.value = pulsoContinuation(selectedProject, item, checkpoints);
    composer.append(context.wrap, button('Copiar contexto', () => copy(context.input.value)), discardButton()); watch(composer);
    const known = options.sessions(); const source = known.find(s => s.id === selectedProject?.mainSessionId) ?? known.find(s => links.some(l => l.sessionId === s.id));
    composer.append(button('Abrir nueva sesión', () => options.newSession(source?.cwd ?? undefined)), el('p', 'Abre una sesión vacía. El contexto no se envía automáticamente.', 'pulso-muted'));
    recover.append(composer); detail.append(recover);
    sessionsBlock(detail, [...new Set([selectedProject?.mainSessionId, ...links.map(l => l.sessionId), ...checkpoints.map(c => c.sessionId)].filter((id): id is string => !!id))], queryBindings);
    linkBlock(detail, { itemId: item.id }); grantBlock(detail, item.projectId ?? undefined);
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
      undoSlot.replaceChildren(); dirty = false; await chooseItem(data.item); await refresh();
    })));
  }
  function sessionsBlock(host: HTMLElement, ids: string[], queryBindings: boolean) {
    const section = el('section', '', 'pulso-section'); section.append(el('h3', 'Sesiones vinculadas'));
    if (!ids.length) section.append(el('p', 'Sin sesiones vinculadas.', 'pulso-muted'));
    for (const id of ids) {
      const s = options.sessions().find(s => s.id === id); const row = el('div', '', 'pulso-session');
      row.append(el('span', s?.title ?? id));
      if (s && isLivePulsoSession(s)) row.append(button('Enfocar sesión viva', () => options.openSession(id)));
      else if (s && !['exited', 'stopped', 'released', 'failed', 'interrupted'].includes(s.status)) {
        row.append(el('span', 'Estado por comprobar', 'pulso-muted'), button('Inspeccionar sesión', () => options.openSession(id)));
      } else {
        row.append(el('span', 'Historial local · sesión finalizada o no disponible', 'pulso-muted'));
        if(s)row.append(button('Ver historial',()=>options.openSession(id)));
        if (options.binding && options.resumeSession && available() && (queryBindings || bindings.has(id))) {
          // Cached per source; detail refreshes and revision polls never query bindings again.
          if (!bindings.has(id)) bindings.set(id, Promise.resolve().then(() => options.binding!(id)));
          void bindings.get(id)!.then(data => {
            if (disposed || !available() || !detail.contains(row) || data.binding?.provider !== 'claude' || !data.binding.conversationId) return;
            const active=options.sessions().find(session=>session.id===data.activeSessionId&&isLivePulsoSession(session));
            if(active){row.append(button('Volver a conversación reanudada',()=>options.openSession(active.id)));freeze();return;}
            row.append(button('Intentar reanudar conversación', async () => {
              if (busy || disposed) return;
              busy = true; freeze();
              const scope=selectedItem?{itemId:selectedItem.id}:selectedProject?{projectId:selectedProject.id}:null;let started=false;
              try { const next=await options.resumeSession!(id);started=true;
                if(next&&scope){bindings.delete(id);await request('link',{...scope,sessionId:next,requestId:`resume-link-${next}`});}
                if (!disposed) options.notice('Se solicitó reanudar la conversación.');
              } catch {if(started)options.notice('La sesión se abrió; no se confirmó el vínculo con el plan. Puedes vincularla desde Pulso.');else say('No se pudo reanudar la conversación. Puedes continuar con el contexto del checkpoint.');}
              finally { busy = false; if (!disposed) freeze(); }
            })); freeze();
          }).catch(() => { /* Missing/unavailable bindings retain history and checkpoints. */ });
        }
      }
      section.append(row);
    }
    host.append(section);
  }
  function linkBlock(host: HTMLElement, scope: { itemId: string } | { projectId: string }) {
    const section = el('form', '', 'pulso-form'); const s = select('Vincular una sesión existente', [['', 'Seleccionar sesión'], ...sessionOptions()]); s.input.required = true;
    section.append(s.wrap); submit(section, 'Vincular sesión', () => write('link', { ...scope, sessionId: s.input.value }, async () => {
      dirty = false; if (selectedItem) await chooseItem(selectedItem); else if (selectedProject) await chooseProject(selectedProject.id);
    })); section.append(discardButton()); host.append(section);
  }
  function grantBlock(host: HTMLElement, projectId?: string) {
    const section = el('section', '', 'pulso-section'); section.append(el('h3', 'Registro desde una sesión'), el('p', 'Permite a la sesión elegida registrar planes y checkpoints, actualizar fases y marcar Hecho. Compartirás el contexto del proyecto con esa sesión.', 'pulso-muted'));
    const preferenceKey=projectId??'bootstrap';const preference=grantPreferences.get(preferenceKey);
    const s = select('Sesión que recibirá permiso', [['', 'Seleccionar sesión'], ...sessionOptions().filter(([id]) => options.sessions().some(x => x.id === id && isLivePulsoSession(x)))], preference?.sessionId??'');
    section.append(s.wrap);
    const rememberLabel = el('label', '', 'pulso-check');
    const remember = el('input'); remember.type = 'checkbox'; remember.checked = preference?.remember??false;
    const rememberChoice=()=>grantPreferences.set(preferenceKey,{sessionId:s.input.value,remember:remember.checked});s.input.addEventListener('change',rememberChoice);remember.addEventListener('change',rememberChoice);
    rememberLabel.append(remember, el('span', 'Recordar para futuras sesiones de esta herramienta en esta carpeta'));
    section.append(rememberLabel);
    const result = el('div');
    const grant = button('Permitir registrar planes', async () => {
      if (!s.input.value || busy || disposed) { say('Selecciona una sesión viva para conceder el permiso.'); return; }
      const sessionId = s.input.value; busy = true; freeze();
      try {
        // The bridge owns secrets and authorization. Persist only an explicit opt-in.
        const data = await request('grant', { sessionId, ...(projectId ? { projectId } : {}), canCreateProjects: true, ...(remember.checked ? { remember: true } : {}) });
        if (disposed) return;
        // Never insert the opaque handle or any credential fields.
        result.replaceChildren(el('p', typeof data.guidance === 'string' ? data.guidance : 'Permiso concedido. Copia el comando y ejecútalo en la sesión elegida cuando estés listo.', 'pulso-muted'));
        const command = typeof data.command === 'string' ? data.command : '';
        // The parent's grant contract returns a handle-based command, never a token.
        // Ignore all other response fields (including the opaque handle).
        if (command) {
          const text = field('Comando de registro', true, 8000); text.input.value = command; text.input.readOnly = true;
          result.append(text.wrap, button('Copiar comando de registro', () => copy(command)));
        }

      } catch { say('No se confirmó el permiso. Consulta la conexión y vuelve a intentarlo explícitamente.'); }
      finally { busy = false; if (!disposed) freeze(); }
    });
    const revoke=button('Revocar permiso',async()=>{
      const sessionId=s.input.value;if(!sessionId||busy||disposed){say('Selecciona la sesión cuyo acceso quieres revocar.');return;}
      busy=true;freeze();try{await request('revoke',{sessionId});if(!disposed)result.replaceChildren(el('p','Permiso revocado.','pulso-muted'));}
      catch{say('No se pudo revocar el permiso. Reintenta la revocación.');}finally{busy=false;if(!disposed)freeze();}
    });
    const policies = el('div', '', 'pulso-policies'); policies.hidden = true;
    type Policy = { id: string; policy: { projectId?: string; canCreateProjects?: boolean; provider?: string; cwd?: string } };
    async function readPolicies() {
      const data = await request('policies');
      if (disposed || !detail.contains(section)) return;
      if (!Array.isArray(data.policies)) throw Error('Respuesta no válida');
      policies.replaceChildren(el('h4', 'Permisos recordados'));
      if (!data.policies.length) policies.append(el('p', 'No hay permisos recordados.', 'pulso-muted'));
      for (const entry of data.policies as Policy[]) {
        const row = el('div', '', 'pulso-policy');
        row.append(el('p', `${entry.policy.provider ?? 'Herramienta sin especificar'} · ${entry.policy.cwd ?? 'Carpeta sin especificar'}`, 'pulso-prose'),
          el('p', `${entry.policy.projectId ? `Proyecto: ${entry.policy.projectId}` : 'Sin proyecto específico'}${entry.policy.canCreateProjects ? ' · Puede crear proyectos' : ''} · Puede actualizar fases y marcar Hecho`, 'pulso-muted'),
          button('Revocar permiso recordado', () => managePolicy(entry.id)));
        policies.append(row);
      }
    }
    async function managePolicy(id?: string) {
      if (busy || disposed) return;
      busy = true; policies.hidden = false; freeze();
      try {
        if (id) await request('revoke_policy', { id });
        await readPolicies();
        if (!disposed && id) say('Permiso recordado revocado. Las futuras sesiones necesitarán autorización.');
      } catch {
        if (!disposed && detail.contains(section)) policies.replaceChildren(el('p', 'No se pudo actualizar la lista de permisos recordados. Reintenta la consulta; si intentaste revocar, comprueba si el permiso sigue en la lista.', 'pulso-muted'), button('Consultar permisos recordados', () => managePolicy()));
      } finally { busy = false; if (!disposed) freeze(); }
    }
    section.append(grant, revoke, result, button('Gestionar permisos recordados', () => managePolicy()), policies); host.append(section);
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); if (!disposed) options.notice('Copiado. Pégalo cuando estés listo.'); }
    catch { say('No se pudo copiar. Selecciona el texto y cópialo manualmente.'); }
  }
  function formatDate(value: Timestamp) { const n = time(value); return n ? new Date(n).toLocaleString('es') : String(value); }
  capture.onsubmit = e => {
    e.preventDefault(); if (busy || failed || !capture.reportValidity()) return;
    const title = captureTitle.input.value.trim(); if (!title) { captureTitle.input.setCustomValidity('Escribe un título.'); captureTitle.input.reportValidity(); return; }
    const project = captureKind.input.value === 'project';
    void write(project ? 'project_create' : 'item_create', { id: crypto.randomUUID(), title, ...(project&&originCheck.checked&&options.currentSession()?{mainSessionId:options.currentSession()!.id}:{}) }, async () => {
      captureTitle.input.value = ''; await refresh();
    });
  };
  captureTitle.input.addEventListener('input', () => captureTitle.input.setCustomValidity(''));
  async function refresh(): Promise<void> {
    if (!available()) return;
    if (refreshing) return refreshGeneration === generation ? refreshing : refreshing.then(() => refresh());
    const gen = generation, epoch = selectionEpoch; refreshGeneration = gen;
    refreshing = (async () => {
      try {
        const nextRevision = (await request('revision')).revision;
        const [ps, items] = await Promise.all([page<PulsoProject>('projects', 'projects', { archived: false }), page<PulsoItem>('items', 'items', { projectId: null, archived: false })]);
        if (disposed || !available() || gen !== generation) return;
        // List responses may contain plans; detail always comes from project{id}.
        projects = { ...ps, rows: ps.rows.map(p => ({ ...p, plan: '' })) }; pending = items; revision = nextRevision;
        shownSessions=sessionSignature(); renderLists(); if (!failed) errors.hidden = true;
        if (dirty || failed) { say('Lista actualizada. Tu borrador se conserva.'); return; }
        if (epoch !== selectionEpoch) return;
        if (selectedItem) await chooseItem(selectedItem, false); else if (selectedProject) await chooseProject(selectedProject.id, false);
        else say('');
      } catch { if (!disposed && available() && gen === generation && !failed) readError(() => refresh()); }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function stop() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule() {
    stop(); if (!available()) return;
    timer = setTimeout(async () => {
      if (!available()) return;
      try {
        if (!busy && !refreshing) {
          const data = await request('revision');
          if (available() && (data.revision !== revision || shownSessions !== sessionSignature())) await refresh();
        }
      } catch { if (available() && !failed) readError(() => refresh()); }
      finally { schedule(); }
    }, 2000);
  }
  function visibility() { stop(); if (available()) { void refresh(); schedule(); } }
  document.addEventListener('visibilitychange', visibility);
  return {
    show() { if (disposed) return; syncOrigin(); visible = true; root.hidden = false; void refresh(); schedule(); },
    hide() { if (disposed) return; visible = false; root.hidden = true; generation++; selectionEpoch++; stop(); },
    refresh,
    dispose() { if (disposed) return; disposed = true; visible = false; generation++; selectionEpoch++; stop(); document.removeEventListener('visibilitychange', visibility); failed = null; root.remove(); },
  };
}

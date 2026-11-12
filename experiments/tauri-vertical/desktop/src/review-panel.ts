import type { Task } from './tasks';
import './review-panel.css';

/** API runner/src/workflow.rs: workflow({id}) returns summaries without files/diff.
 * snapshot_task({id,artifactId}) captures; workflow_artifact({id,artifactId})
 * returns {id,kind,data} including persisted files/diff, also when archived.
 * The runner enforces stopped writers and fingerprints on mutations.
 * review_task and archive_task use ONLY the injected native confirm transport.
 * Parent owns host/init/select. This module never starts or writes to a session.
 * Snapshot detail: {createdAt,snapshot:{fingerprint,head,baseSha,files,diff,...}}.
 * Unknown file metadata stays plain text, pending runner/src/snapshots.rs alignment.
 */
type Rpc = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
type Data = Record<string, unknown>;
type Artifact = { id: string; kind: 'snapshot' | 'review' | 'handoff' | 'handoff_open' | 'purged'; data: Data };
type Workflow = { archived: boolean; artifacts: Artifact[] };
type State = {
  task: Task; workflow: Workflow | null; selected: string; details: Map<string, Data>;
  notes: string; handoffNotes: string; destination: string; stopped: boolean;
  packet: string; packetArtifactId:string; busy: boolean; error: string; message: string;
  retries: Map<string, Data>; open: Set<string>; verificationRuns:Data[]; verificationId:string;
};
const LIMIT = 120_000;
const obj = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
function text(v: unknown, limit = LIMIT): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  return s.length > limit ? `${s.slice(0, limit)}\n… Vista limitada a ${limit} caracteres; el original se conserva.` : s;
}
function date(v: unknown): string {
  const d = new Date(typeof v === 'number' ? v * 1000 : String(v ?? ''));
  return Number.isNaN(d.getTime()) ? 'Fecha no disponible' : d.toLocaleString('es');
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, content = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.textContent = content; e.className = cls; return e;
}
export function mountReviewPanel(host: HTMLElement, request: Rpc, confirm: Rpc, verification?:{host:HTMLElement;select:(task:Task|null,snapshotId:string|null)=>void},delivery?:{available:()=>boolean;opened:(session:Data,context:string)=>void}): { select(task: Task | null): void; setVerifications(taskId:string,runs:Data[]):void; dispose(): void } {
  const root = node('section', '', 'review-panel'); root.setAttribute('aria-label', 'Revisión y relevo'); host.append(root);
  const states = new Map<string, State>(); let current: State | null = null; let disposed = false;
  function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const e = node('button', label); e.type = 'button'; e.disabled = disabled; e.addEventListener('click', action); return e;
  }
  function field(label: string, control: HTMLElement): HTMLLabelElement {
    const e = node('label', '', 'review-panel-field'); e.append(node('span', label), control); return e;
  }
  function notes(s: State, key: 'notes' | 'handoffNotes'): HTMLTextAreaElement {
    const e = node('textarea'); e.dataset.reviewFocus=`notes-${key}`; e.rows = 3; e.maxLength = 8000; e.value = s[key]; e.disabled = s.busy;
    e.addEventListener('input', () => { s[key] = e.value; }); return e;
  }
  function disclosure(s: State, key: string, label: string, initially = false): HTMLDetailsElement {
    const e = node('details', '', 'review-panel-section'); e.open = s.open.has(key) || initially;
    e.append(node('summary', label)); e.addEventListener('toggle', () => { if (!e.isConnected) return; if (e.open) s.open.add(key); else s.open.delete(key); }); return e;
  }
  function repaint(s: State): void { if (!disposed && current === s) render(); }
  async function load(s: State): Promise<void> {
    const w = await request<Workflow>('workflow', { id: s.task.id });
    if (!w || typeof w.archived !== 'boolean' || !Array.isArray(w.artifacts)) throw new Error('Respuesta workflow inválida.');
    s.workflow = w; if (!s.selected) s.selected = w.artifacts.find(a => a.kind === 'snapshot')?.id ?? '';
  }
  async function run(s: State, message: string, action: () => Promise<void>): Promise<void> {
    if (disposed || s.busy) return;
    s.busy = true; s.error = ''; s.message = message; repaint(s);
    try { await action(); } catch (e) { s.message = ''; s.error = `${e instanceof Error ? e.message : text(e, 2000)} Puedes reintentar; se conservan tus notas.`; }
    finally { s.busy = false; repaint(s); }
  }
  async function mutate(s: State, op: string, fields: Data, native = false): Promise<{ result: Data; artifactId: string }> {
    const key = JSON.stringify([op, fields]); let args = s.retries.get(key);
    if (!args) {
      args = { id: s.task.id, ...fields };
      if (['snapshot_task', 'review_task', 'handoff_task'].includes(op)) args.artifactId = crypto.randomUUID();
      if (op==='open_handoff') {args.requestId=crypto.randomUUID();args.sessionId=`handoff-${crypto.randomUUID()}`;args.rows=24;args.cols=80;}
      s.retries.set(key, args);
    }
    const result = await (native ? confirm : request)<unknown>(op, args);
    if (result == null || result === false) { s.retries.delete(key); throw new Error('Operación cancelada o sin confirmación.'); }
    s.retries.delete(key); return { result: obj(result), artifactId: String(args.artifactId ?? '') };
  }
  function refresh(s: State): void { void run(s, 'Cargando historial…', async () => { await load(s); s.message = 'Historial actualizado. Árbol actual sin revalidar.'; }); }
  function render():void{
    const focused=document.activeElement instanceof HTMLElement && root.contains(document.activeElement)?document.activeElement:null;
    const key=focused?.dataset.reviewFocus;
    const selection=focused instanceof HTMLTextAreaElement ? [focused.selectionStart,focused.selectionEnd] as const : null;
    try{renderContents();}finally{
      const target=focused?.isConnected?focused:key?Array.from(root.querySelectorAll<HTMLElement>('[data-review-focus]')).find(node=>node.dataset.reviewFocus===key):null;
      if(target && root.contains(target)){target.focus({preventScroll:true});if(selection && target instanceof HTMLTextAreaElement)target.setSelectionRange(selection[0],selection[1]);}
    }
  }
  function renderContents(): void {
    verification?.select(current?.task??null,current?.selected||null);
    root.replaceChildren(); root.setAttribute('aria-busy', String(current?.busy ?? false));
    const s = current;
    if (!s) { root.append(node('p', 'Selecciona una tarea para capturar y revisar cambios.', 'review-panel-muted')); return; }
    const header = node('div', '', 'review-panel-actions');
    header.append(node('h3', 'Revisión y relevo'), button('Actualizar', () => refresh(s), s.busy)); root.append(header);
    root.append(node('p', s.workflow?.archived ? 'Tarea archivada · archivos y ramas conservados' : 'La aceptación de la tarea es una decisión humana.', 'review-panel-muted'));
    const status = node('p', s.error || s.message, s.error ? 'review-panel-error' : 'review-panel-muted'); status.setAttribute('role', s.error ? 'alert' : 'status'); root.append(status);
    if (!s.workflow) { if (!s.busy) root.append(button('Reintentar carga', () => refresh(s))); return; }
    const archived = s.workflow.archived;
    const stopped = node('input'); stopped.dataset.reviewFocus='stopped'; stopped.type = 'checkbox'; stopped.checked = s.stopped; stopped.disabled = s.busy || archived;
    stopped.addEventListener('change', () => { s.stopped = stopped.checked; render(); root.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus(); });
    root.append(field('He detenido los escritores de esta tarea. El runner comprobará las sesiones y los cambios.', stopped));
    const blocked = s.busy || archived || !s.stopped || s.task.state !== 'ready';
    root.append(button('Capturar cambios', () => { void run(s, 'Capturando cambios…', async () => {
      const response = await mutate(s, 'snapshot_task', {});
      if (!obj(response.result.snapshot).fingerprint) throw new Error('Snapshot sin fingerprint.');
      s.selected = response.artifactId; s.details.set(s.selected, response.result);
      s.message = 'Snapshot capturado. Revisa el diff antes de decidir.'; await load(s);
    }); }, blocked));
    if (s.task.state !== 'ready') root.append(node('p', 'Prepara el worktree antes de capturar o revisar.', 'review-panel-muted'));
    if (!s.stopped && !archived) root.append(node('p', 'Detén y resuelve las sesiones antes de capturar, revisar o preparar un relevo.', 'review-panel-muted'));
    const selector = node('select'); selector.disabled = s.busy; selector.append(new Option('Selecciona un snapshot', ''));
    for (const a of s.workflow.artifacts.filter(a => a.kind === 'snapshot')) selector.append(new Option(`${date(a.data.createdAt)} · ${text(obj(a.data.snapshot).fingerprint, 80)}`, a.id));
    // A captured detail may outlive the runner's bounded summary window.
    if (s.selected && !Array.from(selector.options).some(o => o.value === s.selected)) selector.append(new Option(`Snapshot seleccionado · ${s.selected}`, s.selected));
    selector.dataset.reviewFocus='snapshot'; selector.value = s.selected; selector.addEventListener('change', () => { s.selected = selector.value; render(); root.querySelector<HTMLSelectElement>('select')?.focus(); }); root.append(field('Snapshot del historial', selector));
    if (s.selected) {
      const detail = s.details.get(s.selected);
      const info = obj(detail?.snapshot ?? s.workflow.artifacts.find(a => a.id === s.selected)?.data.snapshot);
      root.append(node('pre', text({fingerprint:info.fingerprint,base:info.base,head:info.head,index:info.index_fingerprint,fileCount:info.file_count,ignoredFiles:info.ignored_files,verificationContext:info.verification_context,stability:info.stability,atomic:info.atomic}, 6000), 'review-panel-meta'));
      root.append(node('p', 'Historial ligado a este fingerprint. Vigencia actual sin revalidar.', 'review-panel-muted'));
      if (!detail) root.append(button('Cargar archivos y diff', () => { void run(s, 'Cargando snapshot…', async () => {
        const id = s.selected;
        const artifact = await request<Artifact>('workflow_artifact', { id: s.task.id, artifactId: id });
        if (artifact.id !== id || artifact.kind !== 'snapshot') throw new Error('El artefacto recibido no corresponde al snapshot seleccionado.');
        const data = artifact.data;
        if (!obj(data.snapshot).fingerprint) throw new Error('Detalle de snapshot inválido.');
        s.details.set(id, data); s.message = 'Detalle histórico cargado.';
      }); }, s.busy));
      else renderDetail(s, info);
    } else root.append(node('p', 'Captura cambios para crear un snapshot o selecciona uno del historial.', 'review-panel-muted'));
    if(verification)root.append(verification.host);
    const review = node('div', '', 'review-panel-section'); review.append(node('h4', 'Decisión humana'));
    review.append(node('p', 'Registra una decisión sobre el snapshot. El árbol se revalida al confirmar; registrar la decisión no ejecuta comandos.', 'review-panel-muted'));
    const result=node('select');result.dataset.reviewFocus='verification-result';result.append(new Option('Sin verificación registrada',''));
    for(const run of s.verificationRuns.filter(run=>run.snapshotId===s.selected && run.status==='completed' && run.verification==='verified' && run.outcome==='passed' && run.evidencePurged!==true)){
      result.append(new Option(`Terminó sin errores · ${date(run.updatedAt)} · ${String(run.runId).slice(0,8)}`,String(run.runId)));
    }
    if(!Array.from(result.options).some(option=>option.value===s.verificationId))s.verificationId='';
    result.value=s.verificationId;result.disabled=s.busy;result.addEventListener('change',()=>{s.verificationId=result.value;});
    review.append(field('Resultado que respalda esta decisión',result),field('Notas de revisión',notes(s,'notes')));
    const decisions = node('div', '', 'review-panel-actions');
    for (const [verdict, label] of [['accepted', 'Aceptar snapshot'], ['rejected', 'Rechazar snapshot']] as const) decisions.append(button(label, () => {
      void run(s, 'Esperando confirmación nativa…', async () => {
        await mutate(s, 'review_task', { snapshotId: s.selected, verdict, notes: s.notes, confirmed: true, ...(s.verificationId?{verificationId:s.verificationId}:{}) }, true);
        s.message = s.verificationId?'Decisión guardada con verificación vinculada.':'Decisión guardada sin verificación registrada.'; await load(s);
      });
    }, blocked || !s.selected));
    review.append(decisions); root.append(review);
    const handoff = disclosure(s, 'handoff', 'Relevo manual', !!s.packet);
    const destination = node('select'); destination.append(new Option('Codex', 'codex'), new Option('Claude', 'claude')); destination.value = s.destination; destination.disabled = s.busy;
    destination.addEventListener('change', () => { s.destination = destination.value; });
    handoff.append(field('Destino', destination), field('Notas para el relevo', notes(s, 'handoffNotes')));
    handoff.append(button('Preparar JSON', () => { void run(s, 'Preparando relevo…', async () => {
      const response = await mutate(s, 'handoff_task', { snapshotId: s.selected, destination: s.destination, notes: s.handoffNotes });
      const packet = { ...response.result }; delete packet.request;
      const json = JSON.stringify(packet, null, 2);
      if (json.length > LIMIT) throw new Error('Paquete demasiado grande para copiar. No se muestra un JSON incompleto.');
      s.packet = json; s.packetArtifactId=response.artifactId; s.message = 'Paquete listo para entregar manualmente.'; await load(s);
    }); }, blocked || !s.selected));
    if (s.packet) {
      const packet = node('textarea'); packet.rows = 8; packet.maxLength = LIMIT; packet.value = s.packet; packet.spellcheck = false; packet.disabled = s.busy;
      packet.addEventListener('input', () => { s.packet = packet.value; });
      handoff.append(field('JSON editable · revisa antes de copiar', packet));
      handoff.append(button('Copiar JSON', () => { void run(s, 'Copiando…', async () => {
        JSON.parse(s.packet); await navigator.clipboard.writeText(s.packet); s.message = 'JSON copiado. Pégalo manualmente en el destino.';
      }); }, s.busy));
    }
    if (s.packetArtifactId && delivery?.available()) handoff.append(button('Abrir una sesión de destino', () => {void run(s,'Comprobando el relevo y abriendo destino…',async()=>{
      const response=await mutate(s,'open_handoff',{artifactId:s.packetArtifactId});
      await load(s);
      if (response.result.phase!=='opened' || !obj(response.result.session).id) {
        s.message='Apertura sin confirmar. Consulta el historial de sesiones; no se envió contexto ni se repitió el inicio.';return;
      }
      s.message='Destino abierto. Copia el contexto y envíalo cuando quieras.';
      delivery.opened(obj(response.result.session),String(response.result.context??''));
    });},blocked));
    handoff.append(node('p', 'Abrir destino crea una sesión nueva con permisos propios y comprueba este snapshot. El contexto se copia y envía manualmente.', 'review-panel-muted')); root.append(handoff);
    const history = disclosure(s, 'history', 'Historial de decisiones y relevos');
    const entries = s.workflow.artifacts.filter(a => a.kind !== 'snapshot');
    if (!entries.length) history.append(node('p', 'Todavía no hay decisiones ni relevos guardados.', 'review-panel-muted'));
    for (const a of entries) {
      const label = a.kind === 'review' ? (a.data.verdict === 'accepted' ? 'Aceptación histórica' : a.data.verdict === 'rejected' ? 'Rechazo histórico' : 'Decisión histórica') : a.kind === 'purged' ? 'Evidencia eliminada' : a.kind==='handoff_open' ? (a.data.phase==='opened'?'Sesión de relevo abierta':'Apertura de relevo sin confirmar') : 'Relevo manual histórico';
      const entry = disclosure(s, a.id, `${label} · ${date(a.data.createdAt)}`);
      entry.append(node('pre', text({ ...a.data, request: undefined }), 'review-panel-output'), node('p', a.kind === 'purged' ? 'Evidencia eliminada explícitamente. No hay respaldo de revisión disponible.' : a.data.verification === 'passed' ? a.data.verificationEvidenceAvailable === false ? 'Historial con verificación vinculada cuya evidencia fue eliminada. Vigencia sin revalidar.' : 'Historial con verificación vinculada a este fingerprint. Vigencia actual sin revalidar.' : 'Historial ligado al fingerprint indicado. Vigencia sin revalidar. Sin verificación registrada.', 'review-panel-muted')); 
      if(a.kind==='handoff') entry.append(button('Cargar paquete de relevo',()=>{void run(s,'Cargando paquete…',async()=>{
        const value=await request<{kind:string;data:Data}>('workflow_artifact',{id:s.task.id,artifactId:a.id});
        if(value.kind!=='handoff')throw new Error('La evidencia de este relevo no está disponible.');
        const packet={...value.data};delete packet.request;s.packet=JSON.stringify(packet,null,2);s.packetArtifactId=a.id;s.open.add('handoff');s.message='Paquete histórico cargado. Su vigencia se comprobará al abrir destino.';
      });},s.busy));
      history.append(entry);
    }
    history.append(button('Eliminar evidencia guardada…', () => { void run(s, 'Esperando confirmación nativa…', async () => {
      await mutate(s,'purge_workflow',{confirmed:true},true);
      s.details.clear();s.selected='';s.packet='';s.packetArtifactId='';s.retries.clear();
      await load(s);s.message='Evidencia eliminada explícitamente. Se conservan archivos, ramas y sesiones; no es borrado seguro del disco o backups.';
    }); },s.busy || !s.workflow.artifacts.some(a=>a.kind!=='purged')));
    root.append(history);
    const archive = node('div', '', 'review-panel-section'); archive.append(node('p', 'Archivar conserva archivos, worktree, rama e historial.', 'review-panel-muted'));
    archive.append(button(archived ? 'Reabrir tarea' : 'Archivar tarea', () => { void run(s, archived ? 'Reabriendo…' : 'Esperando confirmación nativa…', async () => {
      await mutate(s, archived ? 'reopen_task' : 'archive_task', archived ? {} : { confirmed: true }, !archived);
      await load(s); s.message = archived ? 'Tarea reabierta explícitamente.' : 'Tarea archivada. Archivos y ramas conservados.';
    }); }, s.busy)); root.append(archive);
  }
  function renderDetail(s: State, info: Data): void {
    const files = disclosure(s, 'files', 'Archivos del snapshot');
    const list = Array.isArray(info.files) ? info.files : [];
    if (!list.length) files.append(node('p', 'Sin archivos listados en este snapshot.', 'review-panel-muted'));
    let remaining = LIMIT;
    for (const file of list.slice(0, 400)) {
      if (remaining <= 0) { files.append(node('p', 'Se alcanzó el límite de detalle de archivos de esta vista.', 'review-panel-muted')); break; }
      const data = obj(file); const row = node('details');
      const detail = text(file, Math.min(4000, remaining)); remaining -= detail.length;
      row.append(node('summary', text(typeof file === 'string' ? file : data.path ?? data.name ?? 'Archivo', 1000)), node('pre', detail, 'review-panel-output')); files.append(row);
    }
    if (list.length > 400) files.append(node('p', `Vista limitada a 400 de ${list.length} archivos.`, 'review-panel-muted'));
    const diff = disclosure(s, 'diff', 'Diff contra la base capturada');
    diff.append(node('pre', text(info.diff ?? 'Diff no disponible en este snapshot.'), 'review-panel-output')); root.append(files, diff);
    const local=disclosure(s,'local-diff','Cambios locales · HEAD → carpeta');
    local.append(node('p',`${Array.isArray(info.local_files)?info.local_files.length:'—'} archivos con cambios.`, 'review-panel-muted'),node('pre',text(info.local_diff || (Array.isArray(info.local_files) && info.local_files.length ? 'Vista omitida por límite de previsualización; las identidades están en el snapshot.' : info.local_diff === '' ? 'Sin cambios locales.' : 'Esta captura histórica no incluye la vista local.')),'review-panel-output'));
    const committed=disclosure(s,'head-diff','Commits · base → HEAD');
    committed.append(node('p',`${Array.isArray(info.head_files)?info.head_files.length:'—'} archivos con cambios.`, 'review-panel-muted'),node('pre',text(info.head_diff || (Array.isArray(info.head_files) && info.head_files.length ? 'Vista omitida por límite de previsualización; las identidades están en el snapshot.' : info.head_diff === '' ? 'Sin cambios desde la base.' : 'Esta captura histórica no incluye la vista de commits.')),'review-panel-output'));
    root.append(local,committed);
    for(const [key,label] of [['staged','Preparados para commit · HEAD → índice'],['unstaged','Sin preparar · índice → carpeta']] as const){
      const section=disclosure(s,`${key}-diff`,label);
      const changes=info[`${key}_files`];const preview=info[`${key}_diff`];
      section.append(node('p',`${Array.isArray(changes)?changes.length:'—'} archivos con cambios.`,'review-panel-muted'),node('pre',text(preview || (Array.isArray(changes) && changes.length ? 'Previsualización omitida por límite; las identidades se conservan.' : preview === '' ? 'Sin cambios en esta comparación.' : 'Vista no disponible en esta captura histórica.')),'review-panel-output'));
      root.append(section);
    }
  }
  render();
  return {
    select(task) {
      if (disposed) return;
      if (!task) { current = null; render(); return; }
      const existing = states.get(task.id);
      if (existing && current === existing) {
        const changed = existing.task.state !== task.state;
        existing.task = task; if (changed) render(); return;
      }
      if (existing) { current = existing; existing.task = task; render(); if (!existing.workflow && !existing.busy) refresh(existing); return; }
      const s: State = { task, workflow: null, selected: '', details: new Map(), notes: '', handoffNotes: '', destination: 'codex', stopped: false, packet: '', packetArtifactId:'', busy: false, error: '', message: '', retries: new Map(), open: new Set(), verificationRuns:[],verificationId:'' };
      states.set(task.id, s); current = s; refresh(s);
    },
    setVerifications(taskId,runs){
      const s=states.get(taskId);if(!s || JSON.stringify(s.verificationRuns)===JSON.stringify(runs))return;
      s.verificationRuns=runs;if(current===s)render();
    },
    dispose() { disposed = true; current = null; states.clear(); root.remove(); },
  };
}

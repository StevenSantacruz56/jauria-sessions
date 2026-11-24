/** Parent owns ordered replay before cursor ACK, purge markers, visibility, CSS
 * import and native confirmation. No shell/process controls or task acceptance. */
export type Rpc = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
export type CodexSession = { id: string; status: string };
export type CodexEvent = { seq: number; sessionId: string; kind: string; data: string };
type Data = Record<string, unknown>;
type Turn = {nativeTurnId?:string|null; turnId: string; attemptId: string; generation: number; status: string; outcome?: unknown };
type Permission = Turn & { id: string; method: string };
type Summary = {acceptingTurns?:boolean;connectionStatus?:string;connectionDetail?:Data; sessionId: string; generation: number; nativeThreadId: string | null; status: string; turns: Turn[]; requests: Permission[]; hasNativeTurns?:boolean;hasMoreTurns?: boolean; hasMoreRequests?: boolean; hasMore?: boolean };
type Submission = { id: string; commandId: string; turnId: string; attemptId: string; generation: number; prompt: string };
type Entry = { key: string; title: string; body: string; final: boolean; command?: string; cwd?: string; exitCode?: number };
type State = {
  id: string; draft: string; summary: Summary | null; online: boolean; error: string; message: string;
  pending: Submission | null; busy: boolean; stopIntent: string; resumeIntent: boolean;
  seq: number; entries: Map<string, Entry>; bytes: number; partial: boolean; purged: boolean;
  details: Map<string, Data>; requestErrors: Map<string, string>;
};
const MAX_BYTES = 512 * 1024, MAX_ITEMS = 256;
const encoder = new TextEncoder();
const obj = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const statesAllowed = new Set(['idle', 'running', 'cancel_requested', 'interrupted', 'closed']);
const labels: Record<string, string> = { idle: 'Disponible', running: 'En ejecución', cancel_requested: 'Cancelación solicitada', interrupted: 'Interrumpido', closed: 'Cerrado', completed: 'Turno finalizado', failed: 'Falló', inProgress: 'En ejecución', success: 'Terminó sin errores', uncertain: 'Resultado incierto' };
const label = (v: unknown): string => labels[str(v)] || str(v) || 'Sin estado observado';
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.textContent = text; e.className = cls; return e;
}
function clipped(text: string, max: number): string {
  if (encoder.encode(text).length <= max) return text;
  let lo = 0, hi = Math.min(text.length, max);
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (encoder.encode(text.slice(0, mid)).length <= max) lo = mid; else hi = mid - 1; }
  if (lo && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  return text.slice(0, lo);
}
function validTurn(v: unknown): v is Turn {
  const t = obj(v); return !!str(t.turnId) && !!str(t.attemptId) && Number.isSafeInteger(t.generation) && Number(t.generation) > 0 && !!str(t.status);
}
function summary(v: unknown, id: string): Summary {
  const s = obj(v);
  if (s.sessionId !== id || !Number.isSafeInteger(s.generation) || Number(s.generation) < 1 || !statesAllowed.has(str(s.status)) || !Array.isArray(s.turns) || !s.turns.every(validTurn) || !Array.isArray(s.requests) || !s.requests.every(r => validTurn(r) && !!str(obj(r).id) && !!str(obj(r).method))) throw new Error('Estado Codex inválido.');
  return s as Summary;
}
export function mountCodexConversation(host: HTMLElement, request: Rpc, confirm: Rpc): {
  select(session: CodexSession | null): void; applyEvent(event: CodexEvent): void; saveDraft(id:string):unknown;restoreDraft(id:string,value:unknown):void; dispose(): void;
} {
  const root = el('section', '', 'codex-conversation'); root.setAttribute('aria-label', 'Conversación Codex'); root.hidden = true;
  const header = el('header', '', 'codex-conversation-toolbar');
  const connection = el('p', 'Sin conexión confirmada', 'codex-conversation-muted'); connection.setAttribute('role', 'status');
  const feedback = el('p', '', 'codex-conversation-feedback'); feedback.setAttribute('role', 'status');
  const partial = el('p', '', 'codex-conversation-partial');
  const permissions = el('section', '', 'codex-conversation-permissions'); permissions.setAttribute('aria-label', 'Permisos pendientes');
  const turns = el('section', '', 'codex-conversation-turns'); turns.setAttribute('aria-label', 'Estado de los turnos');
  const history = el('div', '', 'codex-conversation-history'); history.setAttribute('role', 'log'); history.setAttribute('aria-live', 'off'); history.tabIndex = 0;
  const empty = el('p', 'Escribe un mensaje para iniciar un turno en esta conversación.', 'codex-conversation-muted');
  const form = el('form', '', 'codex-conversation-composer');
  const field = el('label', 'Mensaje para Codex'), input = el('textarea'); input.rows = 3; input.maxLength = 120000; field.append(input);
  const actions = el('div', '', 'codex-conversation-toolbar');
  const hint = el('p', 'Enter: nueva línea · ⌘/Ctrl + Enter: enviar. La aceptación de la tarea se registra en Revisión.', 'codex-conversation-muted');
  const cache = new Map<string, State>(); let current: State | null = null, disposed = false, reading = false, epoch = 0, composing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turnSignature = '', permissionSignature = '';
  const entryNodes = new Map<string, { root: HTMLElement; title: HTMLElement; body: HTMLElement }>();
  function button(text: string, action: () => void): HTMLButtonElement {
    const b = el('button', text); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  const refreshButton = button('Actualizar estado', () => { void refresh(); });
  const stopButton = button('Cancelar turno', () => { if (current) void stop(current); });
  const resumeButton = button('Continuar conversación', () => { if (current) void resume(current); });
  const retryButton = button('Consultar el mismo envío', () => { if (current?.pending) void submit(current, current.pending); });
  const sendButton = el('button', 'Enviar', 'primary'); sendButton.type = 'submit';
  header.append(el('h3', 'Codex'), connection, refreshButton, stopButton, resumeButton);
  actions.append(sendButton, retryButton); form.append(field, actions, hint);
  root.append(header, feedback, partial, permissions, turns, history, form); host.append(root);
  function state(id: string): State {
    let s = cache.get(id);
    if (!s) { s = { id, draft: '', summary: null, online: false, error: '', message: '', pending: null, busy: false, stopIntent: '', resumeIntent: false, seq: -1, entries: new Map(), bytes: 0, partial: false, purged: false, details: new Map(), requestErrors: new Map() }; cache.set(id, s); }
    return s;
  }
  const active = (s: State): boolean => !disposed && current === s;
  function stopTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule(): void {
    stopTimer(); if (disposed || !current || reading) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 3000);
  }
  function accept(s: State): void {
    const p = s.pending;
    const turn=p?s.summary?.turns.find(t=>t.turnId===p.turnId && t.attemptId===p.attemptId && t.generation===p.generation):null;
    if(p && turn){
      const uncertain=turn.status==='interrupted' || (turn.status==='failed' && !turn.nativeTurnId);
      if(!uncertain && s.draft===p.prompt){s.draft='';if(active(s))input.value='';}
      s.pending=null;s.message=uncertain?'Intento registrado sin entrega confirmada. Se conserva el texto; revisa la actividad antes de continuar.':'Envío registrado por el runner. Consulta el estado real del turno.';
    }
  }
  async function refresh(): Promise<void> {
    stopTimer(); const s = current, token = epoch;
    if (!s || disposed || reading) return;
    reading = true; paint();
    try {
      const value = summary(await request<unknown>('codex_state', { id: s.id }), s.id);
      if (!active(s) || token !== epoch) return;
      if (s.summary && value.generation < s.summary.generation) return;
      const changed = value.generation !== s.summary?.generation;
      s.summary = value; s.online = true; s.error = '';
      if (changed) { s.details.clear(); s.stopIntent = ''; s.resumeIntent = false; }
      if (s.pending) s.message = 'Envío aún sin confirmar. Se conserva el borrador; consulta el mismo envío explícitamente si es necesario.';
      if (value.status !== 'closed' && value.status !== 'interrupted') s.resumeIntent = false;
      const liveIds = new Set(value.requests.map(r => r.id));
      for (const id of s.details.keys()) if (!liveIds.has(id)) s.details.delete(id);
      for (const id of s.requestErrors.keys()) if (!liveIds.has(id)) s.requestErrors.delete(id);
      accept(s);
    } catch { if (active(s) && token === epoch) { s.online = false; s.error = 'Sin conexión confirmada con el runner. Se conserva el borrador; no se reenvía ningún mensaje.'; } }
    finally { reading = false; if (!disposed) { paint(); schedule(); } }
  }
  function entry(s: State, value: Entry): void {
    value.key = clipped(value.key, 2048);
    const old = s.entries.get(value.key);
    if (old) s.bytes -= encoder.encode(JSON.stringify(old)).length;
    const original = JSON.stringify(value);
    value.title = clipped(value.title, 2048); value.body = clipped(value.body, MAX_BYTES - 32768);
    if (value.command) value.command = clipped(value.command, 8192);
    if (value.cwd) value.cwd = clipped(value.cwd, 4096);
    if (JSON.stringify(value) !== original) s.partial = true;
    s.entries.set(value.key, value); s.bytes += encoder.encode(JSON.stringify(value)).length;
    while (s.entries.size > MAX_ITEMS || s.bytes > MAX_BYTES) {
      const first = s.entries.keys().next().value as string;
      s.bytes -= encoder.encode(JSON.stringify(s.entries.get(first))).length; s.entries.delete(first); s.partial = true;
    }
  }
  function append(s: State, key: string, title: string, delta: string): void {
    const old = s.entries.get(key); if (old?.final) return;
    entry(s, { ...old, key, title: old?.title ?? title, body: (old?.body ?? '') + delta, final: false });
  }
  function paint(): void {
    const s = current; if (!s || disposed) return;
    const v = s.summary;
    const liveState=v?.turns.find(t=>t.generation===v.generation && ['running','cancel_requested'].includes(t.status));
    const connectionLabel=v?.connectionStatus==='starting'?'Preparando Codex…':v?.connectionStatus==='needs_attention'?'Requiere atención':v?.status==='running' && liveState && !liveState.nativeTurnId?'Turno solicitado':v?label(v.status):'Estado pendiente';
    connection.textContent = `${s.online ? 'Runner conectado' : 'Conexión sin confirmar'} · ${connectionLabel}`;
    feedback.textContent = s.error || s.message; feedback.classList.toggle('codex-conversation-error', !!s.error); feedback.hidden = !feedback.textContent;
    partial.hidden = !s.purged && !s.partial && !v?.hasMoreTurns && !v?.hasMoreRequests;
    partial.textContent = s.purged ? 'Actividad eliminada. Se muestra únicamente la actividad posterior.' : 'Mostrando actividad reciente. Hay contenido anterior fuera de esta vista.';
    refreshButton.disabled = reading;
    const live = v?.turns.find(t => t.generation === v.generation && ['running', 'cancel_requested'].includes(t.status));
    stopButton.hidden=!live;
    stopButton.disabled = !s.online || s.busy || !live || live.status === 'cancel_requested' || s.stopIntent === live.turnId;
    stopButton.textContent = live && (live.status === 'cancel_requested' || s.stopIntent === live.turnId) ? 'Cancelación solicitada' : 'Cancelar turno';
    resumeButton.hidden = !v || !['closed', 'interrupted'].includes(v.status);
    resumeButton.disabled = !s.online || s.busy || !!s.pending || s.resumeIntent || !v?.hasNativeTurns || v.connectionStatus==='needs_attention';
    sendButton.disabled = !s.online || s.busy || !!s.pending || v?.status !== 'idle' || v?.acceptingTurns===false || !v?.nativeThreadId || (v?.connectionStatus!==undefined && v.connectionStatus!=='running') || !s.draft.trim();
    retryButton.hidden = !s.pending; retryButton.disabled = !s.online || s.busy;
    // Never replace or rewrite the composer during polling: preserve focus/IME.
    const ts = JSON.stringify(v?.turns ?? []);
    if (ts !== turnSignature) { turnSignature = ts; turns.replaceChildren(); for (const t of v?.turns ?? []) turns.append(el('p', `Turno ${t.turnId} · ${t.status==='running' && !t.nativeTurnId?'Turno solicitado':label(t.status)}${t.outcome ? ` · ${label(t.outcome)}` : ''}`, 'codex-conversation-muted')); }
    const ps = JSON.stringify([v?.generation, v?.requests, [...s.details], [...s.requestErrors], s.busy, s.online]);
    if (ps !== permissionSignature) { permissionSignature = ps; renderPermissions(s); }
    const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 48;
    for (const [key, nodes] of entryNodes) if (!s.entries.has(key)) { nodes.root.remove(); entryNodes.delete(key); }
    for (const e of s.entries.values()) {
      let nodes = entryNodes.get(e.key);
      if (!nodes) { const row = el('article', '', 'codex-conversation-entry'), title = el('h4'), body = el('pre'); body.tabIndex = 0; row.append(title, body); nodes = { root: row, title, body }; entryNodes.set(e.key, nodes); history.append(row); }
      nodes.root.classList.toggle('codex-conversation-command', e.command !== undefined);
      if (nodes.title.textContent !== e.title) nodes.title.textContent = e.title;
      const body = [e.command, e.cwd ? `Directorio: ${e.cwd}` : '', e.body, e.exitCode !== undefined ? `Código de salida: ${e.exitCode}` : ''].filter(Boolean).join('\n');
      if (nodes.body.textContent !== body) nodes.body.textContent = body;
    }
    empty.hidden = s.entries.size > 0; if (!empty.isConnected) history.append(empty);
    if (nearBottom) history.scrollTop = history.scrollHeight;
  }
  function renderPermissions(s: State): void {
    permissions.replaceChildren(); permissions.hidden = !s.summary?.requests.length;
    for (const r of s.summary?.requests ?? []) {
      const row = el('article', '', 'codex-conversation-permission'); row.append(el('h4', 'Codex solicita permiso'), el('p', `${r.method} · Turno ${r.turnId}`));
      const d = s.details.get(r.id), supported = r.method === 'item/commandExecution/requestApproval';
      if (!supported) row.append(el('p', 'Este tipo de solicitud solo admite denegación en esta aplicación.'));
      if (d) { const detail = el('pre', (JSON.stringify(d.payload, null, 2) ?? 'Sin metadatos').replace(/[^\x20-\x7e\n\r\t]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`)); detail.tabIndex = 0; row.append(detail); }
      const load = button(d ? 'Actualizar comando' : 'Ver comando', () => { void details(s, r); }); load.disabled = s.busy || !s.online; row.append(load);
      for (const decision of ['accept', 'deny'] as const) {
        const b = button(decision === 'accept' ? 'Aceptar comando…' : 'Denegar…', () => { void permission(s, r, decision); });
        b.disabled = !s.online || s.busy || r.status !== 'pending' || r.generation !== s.summary?.generation || (decision === 'accept' && (!supported || !d || d.status !== 'pending'));
        if (decision !== 'accept' || supported) row.append(b);
      }
      const error = s.requestErrors.get(r.id); if (error) row.append(el('p', error, 'codex-conversation-error')); permissions.append(row);
    }
  }
  async function details(s: State, r: Permission): Promise<void> {
    if (!active(s) || s.busy || !s.online) return;
    const token = epoch; s.busy = true; paint();
    try {
      const d = obj(await request<unknown>('codex_request', { id: s.id, requestId: r.id }));
      if (!active(s) || token !== epoch || s.summary?.generation !== r.generation) return;
      if (d.id !== r.id || d.sessionId !== s.id || d.generation !== r.generation || d.turnId !== r.turnId || d.attemptId !== r.attemptId || d.method !== r.method || d.status !== 'pending') throw new Error();
      s.details.set(r.id, { payload: d.payload, status: d.status }); s.requestErrors.delete(r.id);
    } catch { if (active(s) && token === epoch) s.requestErrors.set(r.id, 'No se pudo validar el permiso. Actualiza el estado antes de decidir.'); }
    finally { s.busy = false; if (active(s)) paint(); }
  }
  async function permission(s: State, r: Permission, decision: 'accept' | 'deny'): Promise<void> {
    if (!active(s) || s.busy || !s.online || r.status !== 'pending' || !s.summary?.requests.some(live => live.id === r.id && live.turnId === r.turnId && live.attemptId === r.attemptId && live.status === 'pending') || s.summary?.generation !== r.generation || (decision === 'accept' && (r.method !== 'item/commandExecution/requestApproval' || !s.details.has(r.id)))) return;
    s.busy = true; const generation = r.generation; paint();
    try {
      const result = await confirm<unknown>('codex_permission', { id: s.id, requestId: r.id, generation, decision });
      if (disposed || s.summary?.generation !== generation) return;
      s.message = result === null || result === false ? 'Confirmación cancelada. Consulta el estado del permiso.' : decision === 'deny' && r.method !== 'item/commandExecution/requestApproval' ? 'Denegación solicitada para un permiso no compatible. Esperando estado del runner.' : 'Respuesta registrada. Esperando el estado del proveedor.'; s.details.delete(r.id);
    } catch(error) { if (!disposed && s.summary?.generation === generation) { s.online = false; s.error = `${error instanceof Error?error.message:'Respuesta del permiso sin confirmar.'} Actualiza el estado; no se repetirá automáticamente.`; } }
    finally { s.busy = false; if (active(s)) { paint(); void refresh(); } }
  }
  async function submit(s: State, prior?: Submission): Promise<void> {
    if (!active(s) || s.busy || !s.online || !s.summary || (!prior && (s.pending || s.summary.status !== 'idle' || s.summary.acceptingTurns===false || !s.summary.nativeThreadId || (s.summary.connectionStatus!==undefined && s.summary.connectionStatus!=='running') || !s.draft.trim()))) return;
    const p = prior ?? { id: s.id, commandId: crypto.randomUUID(), turnId: crypto.randomUUID(), attemptId: crypto.randomUUID(), generation: s.summary.generation, prompt: s.draft };
    s.pending = p; s.busy = true; s.error = ''; s.message = prior ? 'Consultando el mismo envío, sin crear otro intento…' : 'Enviando al runner…'; paint();
    try {
      const result = obj(await request<unknown>(prior?'codex_command':'codex_turn', { ...p }));
      if (disposed || s.pending !== p) return;
      if(prior && result.observed===false){
        const closed=typeof result.connectionStatus==='string' && ['closed','stopped','exited','failed','interrupted','released'].includes(result.connectionStatus);
        const changed=typeof result.currentGeneration==='number' && result.currentGeneration!==p.generation;
        if(closed || changed){s.pending=null;s.message='No hay registro de este envío en el perfil actual y la conexión original está cerrada o cambió. El texto se conserva.';}
        else{s.message='Sin registro confirmado en este perfil. Consulta otra vez o detén la conexión antes de descartar el envío. No se enviará al consultar.';}
        return;
      }
      if (result.sessionId !== s.id || result.turnId !== p.turnId || result.attemptId !== p.attemptId || result.generation !== p.generation || typeof result.shouldSend !== 'boolean') throw new Error();
      const uncertain=result.commandState==='uncertain' || result.turnStatus==='interrupted' || (result.turnStatus==='failed' && !result.nativeTurnId);
      if (!uncertain && s.draft === p.prompt) { s.draft = ''; if (active(s)) input.value = ''; }
      s.pending = null; s.message = uncertain?'Intento registrado sin entrega confirmada. Se conserva el texto; revisa la actividad antes de continuar.':'Envío registrado por el runner. Esperando estado del turno.';
    } catch { if (!disposed && s.pending === p) { s.online = false; s.error = 'Resultado del envío desconocido. Borrador e identificadores conservados. Actualiza el estado o consulta explícitamente el mismo envío; no crees otro intento.'; } }
    finally { s.busy = false; if (active(s)) { paint(); void refresh(); } }
  }
  async function stop(s: State): Promise<void> {
    const v = s.summary, t = v?.turns.find(t => t.generation === v.generation && t.status === 'running');
    if (!active(s) || !s.online || s.busy || !v || !t || s.stopIntent === t.turnId) return;
    s.busy = true; s.stopIntent = t.turnId; paint();
    try { await request('codex_interrupt', { id: s.id, turnId: t.turnId, attemptId: t.attemptId, generation: t.generation }); if (!disposed && s.summary?.generation === t.generation) s.message = 'Cancelación solicitada. El acuse solo registra la intención; esperando estado del turno.'; }
    catch { if (!disposed && s.summary?.generation === t.generation) { s.online = false; s.error = 'Respuesta de interrupción desconocida. Actualiza el estado; el proceso no se considera detenido.'; s.stopIntent = ''; } }
    finally { s.busy = false; if (active(s)) { paint(); void refresh(); } }
  }
  async function resume(s: State): Promise<void> {
    const v = s.summary;
    if (!active(s) || !s.online || s.busy || !v || !['closed', 'interrupted'].includes(v.status) || s.pending || s.resumeIntent || !v.hasNativeTurns || v.connectionStatus==='needs_attention') return;
    s.busy = true; s.resumeIntent = true; paint();
    try { await request('codex_resume', { id: s.id, generation: v.generation }); if (!disposed && s.summary?.generation === v.generation) s.message = 'Continuación solicitada. Esperando estado; no se ha enviado el borrador.'; }
    catch { if (!disposed && s.summary?.generation === v.generation) { s.online = false; s.error = 'Respuesta de reanudación desconocida. Actualiza el estado antes de volver a solicitarla.'; s.resumeIntent = false; } }
    finally { s.busy = false; if (active(s)) { paint(); void refresh(); } }
  }
  input.addEventListener('input', () => { if (current) { current.draft = input.value; paint(); } });
  input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && !composing && e.keyCode !== 229) { e.preventDefault(); if (current) void submit(current); } });
  form.addEventListener('submit', e => { e.preventDefault(); if (current && !composing) void submit(current); });
  return {
    saveDraft(id){const s=cache.get(id);return s?{draft:s.draft,pending:s.pending?{...s.pending}:null}:null;},
    restoreDraft(id,value){const v=obj(value);const s=state(id);if(typeof v.draft==='string')s.draft=v.draft.slice(0,120000);const p=obj(v.pending);if(p.id===id && ['commandId','turnId','attemptId','prompt'].every(k=>typeof p[k]==='string') && Number.isSafeInteger(p.generation) && Number(p.generation)>0)s.pending=p as unknown as Submission;},
    select(session) {
      if (disposed || session?.id === current?.id) return;
      stopTimer(); epoch++; current = session ? state(session.id) : null; root.hidden = !current; composing = false;
      entryNodes.clear(); history.replaceChildren(); turns.replaceChildren(); permissions.replaceChildren(); turnSignature = ''; permissionSignature = '';
      if (!current) { input.value = ''; return; }
      input.value = current.draft; current.online = false; paint(); if (!reading) void refresh();
    },
    applyEvent(event) {
      if (disposed || !Number.isSafeInteger(event.seq) || !event.sessionId) return;
      const s = state(event.sessionId);
      // Parent feed is globally ordered; high-water mark survives eviction/purge.
      if (event.seq <= s.seq) return; s.seq = event.seq;
      if (event.kind === 'purged' || event.kind.endsWith('.purged')) { s.entries.clear(); s.bytes = 0; s.details.clear(); s.purged = true; s.partial = true; }
      else if (event.kind === 'provider' || event.kind === 'provider.data' || event.kind === 'userPrompt' || event.kind === 'notice') {
        let envelope: Data;
        try { envelope = obj(JSON.parse(event.data)); } catch { s.partial = true; if (active(s)) paint(); return; }
        const method = str(envelope.method) || event.kind, params = obj(envelope.params ?? envelope);
        const item = obj(params.item), turn = obj(params.turn);
        const local = `${envelope.generation ?? ''}:${str(envelope.turnId)}:${str(envelope.attemptId)}`;
        const nativeId = str(item.id) || str(params.itemId), key = `item:${local}:${nativeId}`;
        if (method === 'userPrompt' || method === 'notice') entry(s, { key: `${method}:${method === 'notice' || local === '::' ? event.seq : local}`, title: method === 'userPrompt' ? 'Tú' : 'Aviso del runner', body: str(params.text), final: true });
        else if (nativeId && /\/(?:delta|outputDelta|textDelta|summaryTextDelta)$/.test(method)) append(s, key, method.includes('commandExecution') ? 'Salida del comando' : 'Codex', str(params.delta));
        else if (nativeId && (method === 'item/started' || method === 'item/completed')) {
          const old = s.entries.get(key), isCommand = item.type === 'commandExecution';
          const content = isCommand ? item.aggregatedOutput : item.text;
          const body = typeof content === 'string' ? content : old?.body ?? '';
          if (old?.final && method === 'item/started') return;
          entry(s, { key, title: `${isCommand ? 'Comando' : 'Codex'} · ${label(item.status || (method === 'item/completed' ? 'completed' : 'running'))}`, body, final: method === 'item/completed', ...(isCommand ? { command: str(item.command) || old?.command, cwd: str(item.cwd) || old?.cwd, exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined } : {}) });
        } else if (method.startsWith('turn/') && turn.id) entry(s, { key: `turn:${local}:${str(turn.id)}`, title: 'Estado nativo del turno', body: label(turn.status), final: method === 'turn/completed' });
        else if (method === 'error') entry(s, { key: `error:${event.seq}`, title: 'Error del proveedor', body: str(obj(params.error).message) || str(params.message) || 'Error sin detalle de texto.', final: true });
      }
      if (active(s)) paint();
    },
    dispose() { if (disposed) return; disposed = true; epoch++; stopTimer(); current = null; cache.clear(); entryNodes.clear(); root.remove(); }
  };
}

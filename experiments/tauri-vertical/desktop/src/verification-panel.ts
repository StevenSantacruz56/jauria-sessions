import type { Task } from './tasks';
import './verification-panel.css';

type Rpc = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
type Data = Record<string, unknown>;
type Attempt = { requestId: string; snapshotId: string; argv: string[]; runId?: string };
type State = {
  task: Task; snapshotId: string | null; executable: string; arguments: string;
  runs: Data[]; loaded: boolean; selected: string; details: Map<string, Data>;
  open: boolean; exact: boolean; checked: Set<string>; attempt: Attempt | null;
  error: string; message: string;
};
const LIMIT = 120_000;
const ACTIVE = new Set(['pending', 'prepared', 'running', 'cancel_requested']);
const TERMINAL = new Set(['passed', 'failed', 'timeout', 'cancelled', 'mutated', 'not_executed', 'released', 'purged', 'output_limit']);
const LABELS: Record<string, string> = {
  pending: 'Pendiente', prepared: 'Preparado', running: 'En ejecución',
  cancel_requested: 'Cancelación solicitada', passed: 'Terminó sin errores', failed: 'Falló',
  timeout: 'Tiempo agotado', cancelled: 'Cancelado', mutated: 'Árbol modificado',
  needs_attention: 'Requiere atención', uncertain: 'Resultado incierto',
  not_executed: 'No ejecutado', released: 'Liberado manualmente', purged: 'Resultados purgados',
  output_limit: 'Límite de salida alcanzado',
};
const obj = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
function bounded(v: unknown, limit = LIMIT): string {
  const value = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  const suffix = '\n… Vista truncada explícitamente; el resto no se muestra aquí.';
  return value.length > limit ? value.slice(0, limit - suffix.length) + suffix : value;
}
function status(run: Data): string {
  if (run.evidencePurged === true) return 'purged';
  const state = str(run.status) || str(run.state);
  return state === 'completed' ? str(run.outcome) || 'uncertain' : state || 'uncertain';
}
const terminal = (run: Data): boolean => TERMINAL.has(status(run));
const live = (run: Data): boolean => ACTIVE.has(status(run)) || ['uncertain', 'needs_attention'].includes(status(run));
function argv(s: State): string[] {
  // Empty textarea means no arguments. Other blank lines are literal empty args.
  const args = [s.executable, ...(s.arguments === '' ? [] : s.arguments.split('\n'))];
  if (!args[0].startsWith('/')) throw new Error('El ejecutable debe tener una ruta absoluta, por ejemplo /usr/bin/git.');
  if (args.length > 128) throw new Error('Se admiten hasta 128 elementos, incluido el ejecutable.');
  if (args.some(v => v.includes('\0'))) throw new Error('El ejecutable y los argumentos no pueden contener NUL.');
  if (args[0].includes('\n') || args[0].includes('\r')) throw new Error('El ejecutable no admite saltos de línea.');
  if (args.reduce((n, v) => n + new TextEncoder().encode(v).length + 1, 0) > 16 * 1024)
    throw new Error('argv supera 16 KiB UTF-8, incluidos los terminadores.');
  return args;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.textContent = text; e.className = cls; return e;
}

/** Only injected native confirm owns prepare/approval/begin and execution.
 * Read RPCs never authorize execution; flexible records follow verification.rs
 * status/outcome/verification, while allowing the parent's state-based adapter.
 * No logs, clipboard, environment access or external draft persistence.
 */
export function mountVerificationPanel(host: HTMLElement, request: Rpc, confirm: Rpc, onRuns?: (taskId:string,runs:Data[])=>void): {
  select(task: Task | null, snapshotId: string | null): void; dispose(): void;
} {
  const root = node('section', '', 'verification-panel'); root.setAttribute('aria-label', 'Verificación de comandos'); host.append(root);
  const states = new Map<string, State>();
  let current: State | null = null;
  let disposed = false, reading = false, mutating = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function visible(): boolean {
    return !disposed && root.isConnected && !document.hidden && root.getClientRects().length > 0
      && !root.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(root).visibility !== 'hidden';
  }
  function stopTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule(): void {
    stopTimer();
    if (!current || !visible() || !(current.runs.some(live) || current.attempt) || reading || mutating) return;
    timer = setTimeout(() => { timer = undefined; if (current && visible()) void refresh(current); }, 3000);
  }
  function button(label: string, key: string, action: () => void, disabled = false): HTMLButtonElement {
    const e = node('button', label); e.type = 'button'; e.disabled = disabled; e.dataset.focus = key;
    e.addEventListener('click', action); return e;
  }
  function repaint(s: State): void { if (current === s && !disposed) render(); }
  function reconcile(s: State, run: Data): void {
    const attempt = s.attempt;
    if (attempt && (run.requestId === attempt.requestId || (attempt.runId && run.runId === attempt.runId))) {
      attempt.runId = str(run.runId) || attempt.runId;
      if (terminal(run)) s.attempt = null;
    }
  }
  function validRun(value: unknown, s: State, id?: string): Data {
    const run = obj(value);
    if (!str(run.runId) || (id && run.runId !== id) || (!str(run.status) && !str(run.state)) || (run.id != null && run.id !== s.task.id))
      throw new Error('Respuesta de verificación inválida. Actualiza o reintenta el mismo intento.');
    return run;
  }
  function notifyRuns(s:State):void{
    onRuns?.(s.task.id,s.runs.map(run=>Object.fromEntries(['id','runId','snapshotId','status','outcome','verification','createdAt','updatedAt','evidencePurged','definitionHash','beforeFingerprint','afterFingerprint'].map(key=>[key,run[key]]))));
  }
  function accept(s: State, value: unknown): Data {
    const run = validRun(value, s);
    const old = s.runs.findIndex(r => r.runId === run.runId);
    if (old >= 0) s.runs[old] = run; else s.runs.unshift(run);
    s.runs = s.runs.slice(0, 16); s.details.set(str(run.runId), run); reconcile(s, run); notifyRuns(s); return run;
  }
  async function refresh(s: State): Promise<void> {
    if (disposed || reading || mutating || current !== s) return;
    stopTimer(); reading = true; s.error = ''; repaint(s);
    try {
      const response = obj(await request<unknown>('verifications', { id: s.task.id }));
      if (!Array.isArray(response.runs)) throw new Error('Historial de verificaciones inválido.');
      s.runs = response.runs.slice(0, 16).map(v => validRun(v, s)); s.loaded = true; notifyRuns(s);
      for (const r of s.runs) {
        reconcile(s, r);
        if (r.evidencePurged === true) s.details.delete(str(r.runId));
      }
      if (s.open && s.selected && current === s && !disposed) {
        const summary = s.runs.find(r => r.runId === s.selected);
        const cached = s.details.get(s.selected);
        if (summary && (!cached || !terminal(summary) || status(summary) !== status(cached))) {
          const id = s.selected;
          const detail = validRun(await request<unknown>('verification', { id: s.task.id, runId: id }), s, id);
          s.details.set(id, detail); reconcile(s, detail);
        }
      }
    } catch (error) { s.error = bounded(error instanceof Error ? error.message : 'No se pudo consultar el runner.', 2000); }
    finally {
      reading = false;
      if (!disposed) {
        if (current) repaint(current);
        // Switching tasks during an in-flight read must still load the new task.
        if (current && current !== s && !current.loaded && visible()) void refresh(current); else schedule();
      }
    }
  }
  async function mutate(s: State, action: () => Promise<void>): Promise<void> {
    if (disposed || reading || mutating) return;
    stopTimer(); mutating = true; s.error = ''; s.message = 'Esperando respuesta…'; repaint(s);
    let responded = false;
    try { await action(); responded = true; }
    catch (error) {
      s.message = '';
      s.error = bounded(error instanceof Error ? error.message : 'No se recibió respuesta del runner.', 2000)
        + (s.attempt ? ' Se conserva el requestId; reintentar no crea otro intento.' : ' Actualiza el historial antes de reintentar.');
    } finally {
      mutating = false;
      if (!disposed) {
        if (current) repaint(current);
        if (current && visible() && (responded || (current !== s && !current.loaded))) void refresh(current); else schedule();
      }
    }
  }
  function run(s: State): void {
    void mutate(s, async () => {
      if (!s.snapshotId) throw new Error('Selecciona un snapshot antes de verificar.');
      if (!s.attempt) s.attempt = { requestId: crypto.randomUUID(), snapshotId: s.snapshotId, argv: argv(s) };
      const attempt = s.attempt;
      const result = await confirm<unknown>('run_verification', {
        id: s.task.id, requestId: attempt.requestId, snapshotId: attempt.snapshotId, argv: [...attempt.argv],
      });
      if (result === null || result === false) { s.attempt = null; s.message = 'Confirmación cancelada explícitamente.'; return; }
      const returned = obj(result);
      if (returned.requestId != null && returned.requestId !== attempt.requestId) throw new Error('La respuesta no corresponde al requestId enviado.');
      const record = accept(s, result); attempt.runId = str(record.runId);
      s.selected = str(record.runId); s.open = true;
      s.message = 'Respuesta registrada para este comando y snapshot.';
    });
  }
  function render(): void {
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusKey = focused?.dataset.focus;
    const editable = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? focused : null;
    const selection = editable ? [editable.selectionStart, editable.selectionEnd, editable.scrollTop] : null;
    const scrolls = Array.from(root.querySelectorAll<HTMLElement>('[data-scroll]')).map(e => [e.dataset.scroll, e.scrollTop] as const);
    root.replaceChildren();
    const s = current; root.setAttribute('aria-busy', String(reading || mutating));
    if (!s) { root.append(node('p', 'Selecciona una tarea para ver sus verificaciones.', 'verification-panel-muted')); return; }
    const locked = reading || mutating;
    const header = node('div', '', 'verification-panel-toolbar');
    header.append(node('h4', 'Verificación'), button(reading ? 'Actualizando…' : 'Actualizar', 'refresh', () => { void refresh(s); }, locked));
    root.append(header, node('p', 'Cada resultado verifica un comando concreto. No sustituye la revisión humana.', 'verification-panel-muted'));
    if (!s.loaded && !reading) root.append(node('p', 'Historial aún no disponible. Actualiza para consultarlo.', 'verification-panel-muted'));
    if (s.loaded && !s.runs.some(r => r.snapshotId === s.snapshotId && r.evidencePurged !== true))
      root.append(node('p', 'Sin verificación registrada para este snapshot.', 'verification-panel-empty'));
    if (!s.snapshotId) root.append(node('p', 'Selecciona o captura un snapshot para ejecutar.', 'verification-panel-muted'));
    const executable = node('input'); executable.type = 'text'; executable.value = s.executable; executable.dataset.focus = 'executable';
    const argumentsInput = node('textarea'); argumentsInput.rows = 3; argumentsInput.value = s.arguments; argumentsInput.dataset.focus = 'arguments';
    for (const control of [executable, argumentsInput]) {
      control.spellcheck = false; control.autocomplete = 'off'; control.setAttribute('autocapitalize', 'off'); control.disabled = mutating;
    }
    const field = (text: string, control: HTMLElement): HTMLLabelElement => {
      const label = node('label', '', 'verification-panel-field'); label.append(node('span', text), control); return label;
    };
    root.append(field('Ejecutable', executable), field('Argumentos, uno por línea', argumentsInput));
    root.append(node('p', 'Cada salto de línea separa argumentos; los espacios y comillas se conservan literalmente. Campo vacío: sin argumentos. Las líneas vacías, incluida la final, representan argumentos vacíos. No se admiten saltos de línea dentro de un argumento en este formulario.', 'verification-panel-muted'));
    root.append(node('p', 'Ruta absoluta · hasta 128 elementos · máximo 16 KiB UTF-8 · sin NUL. No se interpreta un shell.', 'verification-panel-muted'));
    const exact = node('details', '', 'verification-panel-exact'); exact.open = s.exact;
    const exactSummary = node('summary', 'Argumentos exactos'); exactSummary.dataset.focus = 'exact';
    const preview = node('pre', '', 'verification-panel-output');
    exact.append(exactSummary, preview); exact.addEventListener('toggle', () => { if (exact.isConnected) s.exact = exact.open; }); root.append(exact);
    root.append(node('pre', bounded(`cwd previsto: ${s.task.worktreePath}`, 5000), 'verification-panel-meta'));
    root.append(node('p', 'La confirmación nativa muestra argv y cwd exactos. Los argumentos pueden contener secretos.', 'verification-panel-muted'));
    const validation = node('p', '', 'verification-panel-validation'); validation.setAttribute('role', 'status');
    const execute = button('', 'execute', () => run(s));
    const validate = (): void => {
      let error = '';
      try { preview.textContent = bounded(argv(s)); } catch (e) { error = (e as Error).message; preview.textContent = 'Corrige el comando para ver argv exacto.'; }
      validation.textContent = error; execute.textContent = s.attempt ? 'Reintentar el mismo intento' : 'Verificar comando…';
      execute.disabled = locked || !!error || !s.snapshotId || s.task.state !== 'ready' || s.runs.some(live);
    };
    executable.addEventListener('input', () => { if (s.executable !== executable.value) { s.executable = executable.value; s.attempt = null; } validate(); });
    argumentsInput.addEventListener('input', () => { if (s.arguments !== argumentsInput.value) { s.arguments = argumentsInput.value; s.attempt = null; } validate(); });
    validate(); root.append(validation, execute);
    if (s.attempt) root.append(node('p', `Intento conservado: ${s.attempt.requestId}. Un fallo de comunicación no crea otro intento.`, 'verification-panel-meta'));
    if (s.task.state !== 'ready') root.append(node('p', 'Prepara el worktree antes de ejecutar.', 'verification-panel-muted'));
    const message = node('p', s.error || s.message, s.error ? 'verification-panel-error' : 'verification-panel-muted');
    message.setAttribute('role', s.error ? 'alert' : 'status'); root.append(message);
    if (s.runs.length) {
      const history = node('div', '', 'verification-panel-history'); history.append(node('h5', 'Últimos intentos · hasta 16'));
      for (const summary of s.runs) {
        const id = str(summary.runId), state = status(summary);
        const row = node('div', '', 'verification-panel-run');
        const sameSnapshot = !!s.snapshotId && summary.snapshotId === s.snapshotId;
        const passed = state === 'passed' && sameSnapshot && summary.verification === 'verified';
        row.append(node('span', `${LABELS[state] ?? 'Estado desconocido'} · ${state}`, `verification-panel-status${passed ? ' verification-panel-passed' : ''}`));
        if (str(summary.outcome) && summary.outcome !== state) {
          const outcome = str(summary.outcome);
          row.append(node('span', `Resultado: ${LABELS[outcome] ?? outcome} · ${outcome}`, 'verification-panel-muted'));
        }
        const stamp = summary.createdAt;
        const time = new Date(typeof stamp === 'number' ? stamp * 1000 : str(stamp));
        row.append(node('span', Number.isNaN(time.getTime()) ? 'Fecha no disponible' : time.toLocaleString('es'), 'verification-panel-muted'));
        row.append(node('p', bounded(`Intento ${id}\nSnapshot ${str(summary.snapshotId) || 'no disponible'} · ${sameSnapshot ? 'seleccionado' : 'otro snapshot'}`, 2000), 'verification-panel-meta'));
        const cached = s.details.get(id);
        if (cached?.argv) row.append(node('pre', bounded(JSON.stringify(cached.argv), 3000), 'verification-panel-meta'));
        const controls = node('div', '', 'verification-panel-toolbar');
        controls.append(button(s.selected === id && s.open ? 'Ocultar detalle' : 'Ver comando y resultado', `detail-${id}`, () => {
          s.open = !(s.selected === id && s.open); s.selected = id; repaint(s); if (s.open) void refresh(s);
        }, locked));
        if (ACTIVE.has(state)) controls.append(button('Solicitar cancelación', `cancel-${id}`, () => {
          void mutate(s, async () => {
            accept(s, await request<unknown>('cancel_verification', { id: s.task.id, runId: id }));
            s.message = 'Cancelación solicitada al handle administrado por el runner.';
          });
        }, locked || state === 'cancel_requested'));
        row.append(controls);
        if (state === 'needs_attention') {
          const checkLabel = node('label', '', 'verification-panel-check');
          const check = node('input'); check.type = 'checkbox'; check.checked = s.checked.has(id); check.disabled = locked; check.dataset.focus = `check-${id}`;
          const release = button('Liberar bloqueo…', `release-${id}`, () => {
            void mutate(s, async () => {
              if (!s.checked.has(id)) return;
              const result = await confirm<unknown>('release_verification', { id: s.task.id, runId: id, confirmed: true });
              if (result === null || result === false) { s.message = 'Liberación cancelada.'; return; }
              accept(s, result); s.checked.delete(id); s.message = 'Bloqueo liberado manualmente; esto no verifica el comando.';
            });
          }, locked || !check.checked);
          check.addEventListener('change', () => { if (check.checked) s.checked.add(id); else s.checked.delete(id); release.disabled = locked || !check.checked; });
          checkLabel.append(check, node('span', 'Comprobé por fuera que los procesos terminaron'));
          row.append(checkLabel, node('p', 'Liberar no envía señales a PID conocidos ni ejecuta procesos.', 'verification-panel-muted'), release);
        }
        if (s.selected === id && s.open) {
          if (cached) {
            const { approvalNonce: _nonce, approvalNonceHash: _hash, ...safe } = cached;
            const output = node('pre', bounded(safe), 'verification-panel-output'); output.tabIndex = 0;
            output.dataset.focus = `output-${id}`; output.dataset.scroll = id; output.setAttribute('aria-label', 'Configuración y resultado JSON del comando'); row.append(output);
          } else row.append(node('p', reading ? 'Cargando comando y resultado…' : 'Detalle no disponible. Actualiza para reintentar.', 'verification-panel-muted'));
        }
        history.append(row);
      }
      root.append(history);
    }
    const purgeable = s.runs.some(r => terminal(r) && status(r) !== 'purged' && str(r.outcome) !== 'uncertain');
    root.append(button('Purgar resultados terminales…', 'purge', () => {
      void mutate(s, async () => {
        const result = await confirm<unknown>('purge_verifications', { id: s.task.id, confirmed: true });
        if (result === null || result === false) { s.message = 'Purga cancelada.'; return; }
        if (typeof obj(result).purgedRuns !== 'number') throw new Error('Respuesta de purga inválida. Actualiza el historial.');
        s.details.clear(); s.loaded = false; s.runs = [];
        s.message = 'Resultados terminales purgados; IDs y fingerprints conservados. No es borrado seguro.';
      });
    }, locked || !purgeable));
    root.append(node('p', 'La purga elimina sólo resultados terminales elegibles. Conserva IDs y fingerprints; no es borrado seguro.', 'verification-panel-muted'));
    for (const [key, top] of scrolls) {
      const e = Array.from(root.querySelectorAll<HTMLElement>('[data-scroll]')).find(e => e.dataset.scroll === key); if (e) e.scrollTop = top;
    }
    if (focusKey) {
      const target = Array.from(root.querySelectorAll<HTMLElement>('[data-focus]')).find(e => e.dataset.focus === focusKey);
      target?.focus({ preventScroll: true });
      if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && selection && selection[0] !== null && selection[1] !== null) {
        if (target instanceof HTMLTextAreaElement || target.type === 'text') target.setSelectionRange(selection[0], selection[1]);
        target.scrollTop = selection[2] ?? 0;
      }
    }
  }
  const onVisibility = (): void => { schedule(); };
  document.addEventListener('visibilitychange', onVisibility);
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(onVisibility); observer?.observe(root);
  render();
  return {
    select(task, snapshotId) {
      if (disposed) return;
      if (!task) { stopTimer(); current = null; render(); return; }
      let s = states.get(task.id);
      if (!s) {
        s = { task, snapshotId, executable: '/usr/bin/git', arguments: 'diff\n--check', runs: [], loaded: false,
          selected: '', details: new Map(), open: false, exact: false, checked: new Set(), attempt: null, error: '', message: '' };
        states.set(task.id, s);
      }
      if (current === s && s.snapshotId === snapshotId && s.task.state === task.state && s.task.worktreePath === task.worktreePath) { s.task = task; return; }
      const changed = current !== s;
      if (s.snapshotId !== snapshotId || s.task.worktreePath !== task.worktreePath) s.attempt = null;
      s.task = task; s.snapshotId = snapshotId; current = s; render();
      if (changed && !reading && !mutating) void refresh(s); else schedule();
    },
    dispose() {
      disposed = true; stopTimer(); observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility);
      current = null; states.clear(); root.remove();
    },
  };
}

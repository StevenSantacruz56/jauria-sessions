// «Uso y recursos»: a dialog of its own (like Configuración), opened from the
// sidebar footer row and the command palette. Quotas first, then what Jauría
// uses on this Mac, per open session, runner, window and in total. The status
// bar shows the same total (telemetrySummary). How the values are measured
// (sampler, sources) belongs to the diagnostic, not to this view.
type RecordValue = Record<string, unknown>;
export type TelemetrySnapshot = { resources?: unknown; quotas?: RecordValue; quotasRefreshing?: boolean };
type Request = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
const POLL_MS = 3000;
export const QUOTA_STALE_MS = 5 * 60_000;
const RESOURCE_STALE_MS = 15_000;
const DASH = '—';

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function timestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    // Quotas use epoch seconds; the process sampler uses epoch milliseconds.
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? ms : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const decimal = (n: number) => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(n);
export function formatTelemetryPercent(value: unknown): string {
  const n = number(value);
  return n !== null && n <= 100 ? `${decimal(n)} %` : 'No disponible';
}
export function formatTelemetryCpu(value: unknown): string {
  const n = number(value);
  return n === null ? 'No disponible' : `${decimal(n)} %`;
}
export function formatTelemetryBytes(value: unknown): string {
  const n = number(value);
  if (n === null) return 'No disponible';
  const unit = n >= 1024 ** 3 ? 'GiB' : 'MiB';
  return `${decimal(n / (unit === 'GiB' ? 1024 ** 3 : 1024 ** 2))} ${unit}`;
}
/** «25 nov, 11:23» in local time; 'No informada' for absent/invalid values. */
export function formatTelemetryTime(value: unknown): string {
  const time = timestamp(value);
  if (time === null) return 'No informada';
  const parts = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(time);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month').replace('.', '')}, ${part('hour')}:${part('minute')}`;
}
/** «hace 11 h»: how old an observation is, never a future time. */
export function formatTelemetryAge(value: unknown, now = Date.now()): string {
  const time = timestamp(value);
  if (time === null) return 'sin fecha';
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 48 * 60) return `hace ${Math.floor(minutes / 60)} h`;
  return `hace ${Math.floor(minutes / 1440)} d`;
}
const PROVIDER_LIMIT: Record<string, string> = { claude: 'claude', codex: 'codex' };
/**
 * Plain window names from what the provider reports: «5 horas», «Semana»…
 * A limit other than the provider's main one keeps its id in parentheses;
 * nothing is invented when the provider reports no duration.
 */
export function formatTelemetryWindow(raw: unknown, provider?: string): string {
  const window = record(raw);
  if (string(window.label)) return string(window.label)!;
  const minutes = number(window.windowDurationMins);
  let name: string;
  if (minutes !== null && minutes > 0) {
    if (minutes === 10080) name = 'Semana';
    else if (minutes === 1440) name = 'Día';
    else if (minutes % 1440 === 0) name = `${minutes / 1440} días`;
    else if (minutes % 60 === 0) name = minutes === 60 ? '1 hora' : `${minutes / 60} horas`;
    else name = `${minutes} min`;
  } else {
    name = window.window === 'five_hour' ? '5 horas' : window.window === 'seven_day' ? 'Semana'
      : window.window === 'primary' ? 'Límite principal' : window.window === 'secondary' ? 'Límite secundario' : 'Límite sin nombre';
  }
  const id = string(window.limitId);
  const main = provider ? PROVIDER_LIMIT[provider] : undefined;
  return id && id !== main && !Object.values(PROVIDER_LIMIT).includes(id) ? `${name} (${id})` : name;
}
/** «Semana: 92 % libre · se reinicia el 25 nov, 11:23». */
export function formatQuotaLine(raw: unknown, provider?: string): string {
  const window = record(raw);
  const amount = number(window.remainingPercent);
  const value = amount !== null && amount <= 100 ? `${formatTelemetryPercent(amount)} libre` : 'sin dato';
  const reset = timestamp(window.resetsAt);
  return `${formatTelemetryWindow(window, provider)}: ${value}${reset === null ? '' : ` · se reinicia el ${formatTelemetryTime(reset)}`}`;
}

export type QuotaView =
  | { state: 'current' | 'stale'; observedAt: number | null; age: string; windows: { line: string; remaining: number | null }[] }
  | { state: 'none'; line: string };
const CLAUDE_HINT = 'Se actualiza cuando hay una sesión de Claude abierta en Jauría.';
/** One provider's quota in plain words. `staleTransport`: the runner did not answer recently. */
export function quotaView(provider: 'claude' | 'codex', raw: unknown, staleTransport: boolean, now = Date.now()): QuotaView {
  const data = record(raw);
  const observed = timestamp(data.observedAt);
  const available = data.status === 'available' || (data.status === undefined && data.available === true);
  const windows = list(data.windows).map(record);
  if (!available || !windows.length) {
    const code = string(data.reasonCode);
    if (provider === 'claude') {
      if ((code === 'stale' || code === 'expired') && observed !== null) return { state: 'none', line: `Último dato ${formatTelemetryAge(observed, now)}, ya vencido. ${CLAUDE_HINT}` };
      if (code === 'invalid_cache') return { state: 'none', line: `No se pudo leer el último dato guardado. ${CLAUDE_HINT}` };
      return { state: 'none', line: `Sin dato. ${CLAUDE_HINT}` };
    }
    const reason: Record<string, string> = {
      no_observed_windows: 'Codex no informó límites vigentes. Pulsa Actualizar más tarde.',
      deadline_exceeded: 'La consulta tardó demasiado. Pulsa Actualizar para reintentar.',
      rpc_error: 'Codex rechazó la consulta. Comprueba que tu sesión de Codex sigue iniciada.',
      spawn_failed: 'No se pudo abrir Codex en este Mac para consultar.',
      home_unavailable: 'No se pudo abrir Codex en este Mac para consultar.',
    };
    if (available) return { state: 'none', line: 'Codex no informó límites vigentes. Pulsa Actualizar más tarde.' };
    if (!code) return { state: 'none', line: 'Sin consultar. Pulsa Actualizar para ver tu cuota.' };
    return { state: 'none', line: reason[code] ?? 'No se pudo consultar. Pulsa Actualizar para reintentar.' };
  }
  const resetPassed = windows.some(w => { const reset = timestamp(w.resetsAt); return reset !== null && reset <= now; });
  const stale = staleTransport || data.stale === true || observed === null || now - observed > QUOTA_STALE_MS || resetPassed;
  return {
    state: stale ? 'stale' : 'current', observedAt: observed, age: formatTelemetryAge(observed, now),
    windows: windows.map(w => { const r = number(w.remainingPercent); return { line: formatQuotaLine(w, provider), remaining: r !== null && r <= 100 ? r : null }; }),
  };
}

/** `unmeasured`: processes listed but not measured (exited or unreadable); their CPU/RAM are not in the sums. */
export type ResourceLine = { key: string; label: string; cpu: number | null; cpuPending: boolean; rss: number | null; processes: number; unmeasured: number };
export type ResourceView = {
  sessions: ResourceLine[]; runner: ResourceLine | null; window: ResourceLine | null; total: ResourceLine | null;
  /** Older runner (no `sessionId`): session processes without a per-session split. */
  unattributed: ResourceLine | null;
  /** Processes macOS attributes to Jauría that are not the window (e.g. a job a session left behind). */
  others: ResourceLine | null;
  legacy: boolean;
  /** The window's web engine is counted (at least one helper attributed by macOS). */
  webEngine: boolean;
  /** Why it is not, in plain words; null when counted or no window data. */
  webEngineNote: string | null;
  missing: string | null; observedAt: number | null;
};
const WEB_ENGINE_NOTE: Record<string, string> = {
  not_attributable: 'La interfaz no incluye el motor web de la ventana: macOS no permite atribuírselo a Jauría cuando no se abre desde el Finder.',
  none_found: 'La interfaz no incluye el motor web de la ventana: no se encontraron sus procesos en esta lectura.',
};
// Only limits that mean «a process of Jauría may be missing» are told; a
// process that ended during the read is gone, not missing.
const MISSING: Record<string, string> = {
  inventory_incomplete: 'Puede faltar algún proceso: macOS no dejó leer uno de los tuyos.',
  pid_cap: 'Puede faltar algún proceso: hay demasiados procesos en el equipo para revisarlos todos.',
  descendant_cap: 'Puede faltar algún proceso: una sesión tiene más de 128 procesos y solo se cuentan esos.',
  depth_cap: 'Puede faltar algún proceso: hay cadenas de procesos de más de 32 niveles.',
  deadline: 'Puede faltar algún proceso: la lectura tardó demasiado. Se reintenta en 3 s.',
  inventory_unavailable: 'No se pudo listar los procesos del equipo. Se reintenta en 3 s.',
};
/** A group of rows; a row that could not be measured stays counted in `unmeasured`, never dropped silently. */
function sum(label: string, key: string, rows: RecordValue[]): ResourceLine | null {
  if (!rows.length) return null;
  const read = rows.filter(r => r.available !== false && number(r.rssBytes) !== null);
  const cpu = read.map(r => r.cpuAvailable === false ? null : number(r.cpuPercent));
  const known = cpu.filter((c): c is number => c !== null);
  return { key, label, rss: read.length ? read.reduce((t, r) => t + number(r.rssBytes)!, 0) : null, cpu: known.length ? known.reduce((t, c) => t + c, 0) : null,
    cpuPending: known.length < cpu.length, processes: read.length, unmeasured: rows.length - read.length };
}
/**
 * Rows of the view from one telemetry snapshot. A process belongs to the
 * session the runner attributed it to (`sessionId`), else to the runner; the
 * window rows come from the bridge (`resources.app`). Sessions the client does
 * not know as open are listed under the title the runner has or «Sesión».
 * An older runner sends `role: cli` without `sessionId`: a CLI is matched to
 * its session by PID (`sessionOfPid`) and its descendants, which that runner
 * cannot split, go to one «sin desglose» row instead of the Runner's.
 */
export function resourceView(snapshot: TelemetrySnapshot | null, sessionTitle: (id: string) => string | null,
  sessionOfPid: (pid: number) => string | null = () => null): ResourceView {
  const data = record(snapshot?.resources);
  const app = record(data.app);
  const rows = list(data.processes).map(record);
  const legacy = rows.some(r => r.role === 'cli' && !string(r.sessionId));
  const bySession = new Map<string, RecordValue[]>();
  const runnerRows: RecordValue[] = [], unattributedRows: RecordValue[] = [];
  for (const row of rows) {
    const pid = number(row.pid);
    const id = string(row.sessionId) ?? (legacy && row.role === 'cli' ? (pid !== null ? sessionOfPid(pid) : null) ?? `pid:${pid ?? '?'}` : null);
    if (id) bySession.set(id, [...(bySession.get(id) ?? []), row]);
    else if (legacy && row.role !== 'runner') unattributedRows.push(row);
    else runnerRows.push(row);
  }
  const sessions = [...bySession].map(([id, group]) => sum((id.startsWith('pid:') ? null : sessionTitle(id)) ?? 'Sesión', `session:${id}`, group))
    .filter((r): r is ResourceLine => r !== null).sort((a, b) => a.label.localeCompare(b.label, 'es'));
  const appRows = list(app.processes).map(record);
  const otherRows = appRows.filter(r => r.role === 'other');
  const windowRows = appRows.filter(r => r.role !== 'other');
  const runner = sum('Runner (servicio de sesiones)', 'runner', runnerRows);
  const window = sum('Interfaz (ventana)', 'window', windowRows);
  const others = sum('Otros procesos de Jauría', 'others', otherRows);
  const unattributed = sum('Procesos de las sesiones (sin desglose)', 'unattributed', unattributedRows);
  const all = [...rows, ...appRows];
  const total = sum('Total de Jauría', 'total', all);
  if (total && total.unmeasured) total.label = 'Total de Jauría (parcial)';
  const reason = [record(data.discovery), record(app.discovery)].map(d => d.partial === true ? string(d.reason) : null).find(r => r && MISSING[r]) ?? null;
  const engine = string(app.webEngine);
  return { sessions, runner, window, total, unattributed, others, legacy, webEngine: engine === 'included',
    webEngineNote: window && engine !== 'included' ? WEB_ENGINE_NOTE[engine ?? ''] ?? 'La interfaz no incluye el motor web de la ventana: no se pudo atribuir a Jauría.' : null,
    missing: reason ? MISSING[reason] : null, observedAt: timestamp(data.timestampUnixMs ?? data.observedAt) };
}
export function formatResourceCpu(line: ResourceLine | null): string {
  if (!line || line.cpu === null) return line?.cpuPending ? 'midiendo…' : line?.unmeasured ? 'sin dato' : DASH;
  return formatTelemetryCpu(line.cpu);
}
export function formatResourceRam(line: ResourceLine | null): string {
  return line?.rss == null ? line?.unmeasured ? 'sin dato' : DASH : formatTelemetryBytes(line.rss);
}
/** Status bar text: the view's «Total de Jauría», same definition (and «parcial» when it is). */
export function telemetrySummary(view: ResourceView | null, connected: boolean): string {
  if (!connected) return 'Recursos sin conexión';
  const total = view?.total ?? null;
  return `Jauría · CPU ${total?.cpu == null ? DASH : formatTelemetryCpu(total.cpu)} · RAM ${formatResourceRam(total)}${total?.unmeasured ? ' (parcial)' : ''}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type Options = {
  request: Request;
  isConnected: () => boolean;
  /** Title of a session the client knows (open sessions); null otherwise. */
  sessionTitle: (id: string) => string | null;
  /** Session id of a CLI PID, for older runners that do not send `sessionId`. */
  sessionOfPid?: (pid: number) => string | null;
  /** Resources are polled while the view is open or while this returns true (the status bar is visible). */
  wantsSummary: () => boolean;
  onSummary?: (text: string) => void;
  /** Focus targets, in order, when the element that opened the view is gone or hidden (the palette, the closed sidebar drawer). */
  fallbackFocus?: () => (HTMLElement | null)[];
};
/** Focusable now: in the document, laid out and not hidden (a closed drawer is `visibility: hidden`). */
function canFocus(node: HTMLElement | null): node is HTMLElement {
  return !!node && node.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]');
}

/**
 * Cached quotas only: providers are queried only when «Actualizar» is pressed.
 * Resources are polled every 3 s while the view is open or the status bar
 * needs them; nothing is requested otherwise.
 */
export function mountTelemetry(options: Options): { open: (from?: HTMLElement | null) => void; close: () => void; dispose: () => void; readonly isOpen: boolean } {
  let disposed = false, inFlight = false, refreshQueued = false, awaitingRefresh = false, sawRefreshing = false, pollError = false;
  let refreshStarted = 0, receivedAt = 0, refreshError = '';
  let snapshot: TelemetrySnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let opener: HTMLElement | null = null;

  const dialog = element('dialog', 'session-dialog telemetry-dialog');
  dialog.id = 'telemetry-dialog';
  const title = element('h2', '', 'Uso y recursos'); title.id = 'telemetry-title'; title.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', title.id);
  const heading = element('header', 'dialog-heading');
  const headingCopy = element('div');
  headingCopy.append(title, element('p', '', 'Cuánto te queda de Claude Code y Codex, y lo que usa Jauría en este Mac.'));
  heading.append(headingCopy);
  const content = element('div', 'telemetry-content');
  const quotaSection = element('section', 'telemetry-section telemetry-quotas');
  quotaSection.setAttribute('aria-labelledby', 'telemetry-quotas-title');
  const quotaHead = element('div', 'telemetry-section-head');
  const quotaTitle = element('h3', '', 'Cuotas'); quotaTitle.id = 'telemetry-quotas-title';
  const refresh = element('button', 'secondary telemetry-refresh', 'Actualizar');
  refresh.type = 'button';
  refresh.title = 'Consulta tu cuota de Codex ahora. La de Claude Code llega sola desde sus sesiones.';
  quotaHead.append(quotaTitle, refresh);
  const quotas = element('div', 'telemetry-providers');
  quotaSection.append(quotaHead, quotas);
  const resourceSection = element('section', 'telemetry-section telemetry-resources');
  resourceSection.setAttribute('aria-labelledby', 'telemetry-resources-title');
  const resourceHead = element('div', 'telemetry-section-head');
  resourceHead.append(Object.assign(element('h3', '', 'Recursos de Jauría'), { id: 'telemetry-resources-title' }));
  const table = element('table', 'telemetry-table');
  const caption = element('caption', 'sr-only', 'Uso de CPU y memoria por sesión abierta, runner, interfaz y total');
  const thead = element('thead');
  const headRow = element('tr');
  const th = (text: string, hint?: string) => { const cell = element('th', '', text); cell.scope = 'col'; if (hint) cell.title = hint; return cell; };
  headRow.append(th('Proceso'), th('CPU', '100 % equivale a un núcleo completo; con varios núcleos puede pasar de 100 %.'), th('RAM', 'Memoria en uso de cada proceso, sumada.'));
  thead.append(headRow);
  const tbody = element('tbody');
  const tfoot = element('tfoot');
  table.append(caption, thead, tbody, tfoot);
  const notes = element('div', 'telemetry-notes');
  resourceSection.append(resourceHead, table, notes);
  content.append(quotaSection, resourceSection);
  const footer = element('footer', 'dialog-footer telemetry-footer');
  const status = element('p', 'telemetry-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const closeButton = element('button', 'quiet', 'Cerrar'); closeButton.type = 'button';
  footer.append(status, closeButton);
  dialog.append(heading, content, footer);
  document.body.append(dialog);

  const isOpen = () => !disposed && dialog.open;
  const now = () => Date.now();

  function renderQuota(name: string, provider: 'claude' | 'codex', raw: unknown, staleTransport: boolean): HTMLElement {
    const view = quotaView(provider, raw, staleTransport, now());
    const section = element('section', 'telemetry-provider');
    section.dataset.provider = provider;
    section.dataset.state = view.state;
    if (view.state === 'none') {
      const line = element('p', 'telemetry-provider-line');
      line.append(element('strong', '', `${name}: `), document.createTextNode(view.line));
      section.append(line);
      return section;
    }
    const head = element('div', 'telemetry-provider-head');
    head.append(element('h4', '', name));
    const badge = element('span', `telemetry-badge${view.state === 'stale' ? ' telemetry-warning' : ''}`,
      view.state === 'stale' ? `Dato vencido · ${view.age}` : `Actualizado ${view.age}`);
    if (view.observedAt !== null) badge.title = `Leído el ${formatTelemetryTime(view.observedAt)}`;
    head.append(badge);
    section.append(head);
    for (const window of view.windows) {
      const row = element('div', 'telemetry-window');
      row.append(element('p', 'telemetry-window-line', window.line));
      if (window.remaining !== null) {
        const meter = element('meter', 'telemetry-meter');
        meter.min = 0; meter.max = 100; meter.low = 10; meter.high = 25; meter.optimum = 100; meter.value = window.remaining;
        meter.setAttribute('aria-label', `${name}, ${window.line}${view.state === 'stale' ? '. Dato vencido' : ''}`);
        row.append(meter);
      }
      section.append(row);
    }
    if (view.state === 'stale') section.append(element('p', 'telemetry-note', provider === 'claude'
      ? 'Puede haber cambiado. Se actualiza cuando hay una sesión de Claude abierta en Jauría.'
      : 'Puede haber cambiado. Pulsa Actualizar para volver a consultar.'));
    return section;
  }

  function resourceRow(line: ResourceLine, cls = '') {
    const row = element('tr', cls);
    row.dataset.key = line.key;
    const name = element('th', 'telemetry-name', line.label); name.scope = 'row';
    if (line.processes > 1) name.title = `${line.processes} procesos`;
    row.append(name, element('td', 'telemetry-value', formatResourceCpu(line)), element('td', 'telemetry-value', formatResourceRam(line)));
    return row;
  }

  function renderResources(staleTransport: boolean) {
    const view = resourceView(snapshot, options.sessionTitle, options.sessionOfPid);
    const observedStale = view.observedAt !== null && now() - view.observedAt > RESOURCE_STALE_MS;
    const stale = staleTransport || observedStale;
    table.dataset.stale = String(stale);
    const rows: HTMLElement[] = [];
    const blank = (key: string, label: string): ResourceLine => ({ key, label, cpu: null, cpuPending: false, rss: null, processes: 0, unmeasured: 0 });
    // An older runner cannot tell; never claim there are no sessions then.
    if (!view.sessions.length && !view.unattributed && !view.legacy) {
      const empty = element('tr', 'telemetry-empty'); const cell = element('td', '', 'Ninguna sesión abierta.'); cell.colSpan = 3; empty.append(cell); rows.push(empty);
    }
    for (const line of view.sessions) rows.push(resourceRow(line, 'telemetry-session'));
    if (view.unattributed) rows.push(resourceRow(view.unattributed, 'telemetry-session'));
    rows.push(resourceRow(view.runner ?? blank('runner', 'Runner (servicio de sesiones)')));
    rows.push(resourceRow(view.window ?? blank('window', 'Interfaz (ventana)')));
    if (view.others) {
      const other = resourceRow(view.others);
      other.querySelector('th')!.title = 'Procesos que macOS atribuye a Jauría y ya no cuelgan de una sesión, por ejemplo un trabajo que una sesión dejó en marcha al terminar.';
      rows.push(other);
    }
    tbody.replaceChildren(...rows);
    tfoot.replaceChildren(resourceRow(view.total ?? blank('total', 'Total de Jauría'), 'telemetry-total'));
    const lines: HTMLElement[] = [];
    if (!snapshot) lines.push(element('p', 'telemetry-note', options.isConnected() ? 'Midiendo…' : 'Sin conexión con el runner.'));
    else if (stale) lines.push(element('p', 'telemetry-note telemetry-warning', `Cifras de ${formatTelemetryAge(receivedAt || view.observedAt, now())}; se reintenta cada 3 s.`));
    if (view.total?.unmeasured) {
      const n = view.total.unmeasured;
      lines.push(element('p', 'telemetry-note telemetry-warning', `El total no incluye ${n === 1 ? '1 proceso que no se pudo medir' : `${n} procesos que no se pudieron medir`} (pudo terminar durante la lectura).`));
    }
    if (view.legacy) lines.push(element('p', 'telemetry-note', 'El runner es de una versión anterior: los procesos que lanzan las sesiones se suman sin desglose por sesión.'));
    if (snapshot && view.webEngineNote) lines.push(element('p', 'telemetry-note', view.webEngineNote));
    if (view.missing) lines.push(element('p', 'telemetry-note telemetry-warning', view.missing));
    notes.replaceChildren(...lines);
  }

  function render() {
    if (disposed) return;
    const connected = options.isConnected();
    const stale = !connected || pollError || (receivedAt > 0 && now() - receivedAt > RESOURCE_STALE_MS);
    options.onSummary?.(telemetrySummary(snapshot && !stale ? resourceView(snapshot, options.sessionTitle, options.sessionOfPid) : null, connected));
    if (!isOpen()) return;
    const refreshing = awaitingRefresh || snapshot?.quotasRefreshing === true;
    refresh.disabled = !connected || refreshQueued || refreshing;
    refresh.textContent = refreshing ? 'Consultando…' : 'Actualizar';
    const message = !connected ? 'Sin conexión con el runner.' : refreshError || (pollError ? 'No se pudo leer el uso; se reintenta.' : refreshing ? 'Consultando la cuota de Codex…' : '');
    if (status.textContent !== message) status.textContent = message;
    quotas.replaceChildren(renderQuota('Claude Code', 'claude', snapshot?.quotas?.claude, stale), renderQuota('Codex', 'codex', snapshot?.quotas?.codex, stale));
    renderResources(stale);
  }

  const wanted = () => isOpen() || options.wantsSummary();
  async function poll() {
    timer = undefined;
    if (disposed || inFlight) return;
    if (!options.isConnected() || !wanted()) { render(); schedule(); return; }
    inFlight = true;
    try {
      if (refreshQueued) {
        refreshQueued = false;
        try {
          await options.request<unknown>('refresh_quotas', {});
        } catch {
          refreshError = 'No se pudo pedir la cuota. Vuelve a intentarlo.';
          return;
        }
        if (disposed) return;
        awaitingRefresh = true; refreshStarted = now(); sawRefreshing = false;
      }
      const next = await options.request<TelemetrySnapshot>('telemetry', {});
      if (disposed) return;
      snapshot = { ...next, quotas: next.quotas ?? snapshot?.quotas };
      receivedAt = now();
      pollError = false;
      if (next.quotasRefreshing) sawRefreshing = true;
      if (awaitingRefresh && !next.quotasRefreshing && (sawRefreshing || next.quotasRefreshing === false)) awaitingRefresh = false;
      if (awaitingRefresh && now() - refreshStarted > 120_000) {
        awaitingRefresh = false;
        refreshError = 'La consulta no terminó. Puedes volver a intentarlo.';
      }
    } catch {
      if (disposed) return;
      pollError = true;
    } finally {
      inFlight = false;
      if (!disposed) { render(); schedule(); }
    }
  }
  function schedule() {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => { void poll(); }, refreshQueued ? 0 : POLL_MS);
  }
  function pollNow() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (!inFlight) void poll();
  }
  function onRefresh() {
    if (disposed || refresh.disabled || !options.isConnected()) return;
    refreshError = '';
    refreshQueued = true;
    render();
    pollNow();
  }
  function restoreFocus() {
    const target = [opener, ...(options.fallbackFocus?.() ?? [])].find(canFocus) ?? null;
    opener = null;
    target?.focus();
  }
  function close() {
    if (!isOpen()) return;
    dialog.close();
  }
  refresh.addEventListener('click', onRefresh);
  closeButton.addEventListener('click', close);
  // Escape closes natively; every close path returns focus to the opener.
  dialog.addEventListener('close', () => { if (!disposed) { restoreFocus(); render(); } });
  render();
  void poll();
  return {
    get isOpen() { return isOpen(); },
    open(from?: HTMLElement | null) {
      if (disposed || dialog.open) return;
      // WebKit does not focus a clicked button: the caller names it.
      opener = from ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      dialog.showModal(); title.focus();
      render();
      pollNow();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      refresh.removeEventListener('click', onRefresh);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}

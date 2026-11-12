// Integration: import './telemetry.css' beside the app stylesheet; retain the
// disposer returned by mountTelemetry and call it before replacing the host.
type RecordValue = Record<string, unknown>;
type Snapshot = { resources?: unknown; quotas?: RecordValue; quotasRefreshing?: boolean };
type Request = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
const POLL_MS = 3000;
const QUOTA_STALE_MS = 5 * 60_000;
const RESOURCE_STALE_MS = 15_000;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
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
export function formatTelemetryPercent(value: unknown): string {
  const n = number(value);
  return n !== null && n <= 100 ? `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(n)} %` : 'No disponible';
}
export function formatTelemetryCpu(value: unknown): string {
  const n = number(value);
  return n === null ? 'No disponible' : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(n)} %`;
}
export function formatTelemetryBytes(value: unknown): string {
  const n = number(value);
  if (n === null) return 'No disponible';
  const unit = n >= 1024 ** 3 ? 'GiB' : 'MiB';
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(n / (unit === 'GiB' ? 1024 ** 3 : 1024 ** 2))} ${unit}`;
}
export function formatTelemetryTime(value: unknown): string {
  const time = timestamp(value);
  return time === null ? 'No informada' : new Intl.DateTimeFormat('es', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time);
}
export function formatTelemetryWindow(raw: unknown): string {
  const window = record(raw);
  if (string(window.label)) return string(window.label)!;
  const minutes = number(window.windowDurationMins);
  const duration = minutes !== null && minutes > 0
    ? minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
    : window.window === 'primary' ? 'Principal' : window.window === 'secondary' ? 'Secundaria' : 'Ventana sin nombre';
  return string(window.limitId) ? `${duration} · ${string(window.limitId)}` : duration;
}
function quotaReason(data: RecordValue): string {
  if (string(data.error)) return string(data.error)!;
  const reason = string(data.reason);
  if (string(data.reasonCode) && reason) return reason;
  if (reason?.includes('no_documented_standalone_quota_read')) return 'Claude no ofrece una consulta de cuota independiente de una sesión.';
  if (reason === 'no_observed_windows') return 'No hay ventanas vigentes informadas. Vuelve a actualizar.';
  if (reason === 'deadline_exceeded') return 'La consulta agotó el tiempo. Vuelve a actualizar.';
  return reason ? 'El proveedor no pudo informar su cuota. Vuelve a actualizar.' : 'Pulsa Actualizar cuotas para consultar.';
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function metadata(parent: HTMLElement, label: string, value: unknown, date = false) {
  const row = element('p', 'telemetry-meta');
  row.append(element('span', '', `${label}: `));
  const content = date ? formatTelemetryTime(value) : string(value) ?? 'No informada';
  const node = date ? element('time', '', content) : element('span', '', content);
  if (node instanceof HTMLTimeElement && timestamp(value) !== null) node.dateTime = new Date(timestamp(value)!).toISOString();
  row.append(node);
  parent.append(row);
}

/** Cached quotas only; this component never starts provider queries on mount. */
export function mountTelemetry(host: HTMLElement, request: Request, isConnected: () => boolean, onSnapshot?: (value: Snapshot) => void): () => void {
  let disposed = false;
  let inFlight = false;
  let refreshQueued = false;
  let awaitingRefresh = false;
  let refreshStarted = 0;
  let sawRefreshing = false;
  let snapshot: Snapshot | null = null;
  let receivedAt = 0;
  let pollError = false;
  let refreshError = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const root = element('section', 'telemetry');
  root.setAttribute('aria-label', 'Telemetría');
  const heading = element('div', 'telemetry-heading');
  heading.append(element('h2', '', 'Uso y recursos'));
  const refresh = element('button', 'telemetry-refresh', 'Actualizar cuotas');
  refresh.type = 'button';
  refresh.title = 'Consultar las cuotas de Claude y Codex en segundo plano';
  const status = element('p', 'telemetry-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const quotas = element('div', 'telemetry-quotas');
  const resources = element('div', 'telemetry-resources');
  heading.append(refresh);
  root.append(heading, status, quotas, resources);
  host.append(root);

  function renderQuota(provider: string, raw: unknown, staleTransport: boolean): HTMLElement {
    const data = record(raw);
    const section = element('section', 'telemetry-provider');
    const title = element('div', 'telemetry-row');
    title.append(element('h3', '', provider));
    const observed = timestamp(data.observedAt);
    const windows = Array.isArray(data.windows) ? data.windows : [];
    const resetPassed = windows.some(rawWindow => {
      const reset = timestamp(record(rawWindow).resetsAt);
      return reset !== null && reset <= Date.now();
    });
    const stale = staleTransport || data.stale === true || observed === null || Date.now() - observed > QUOTA_STALE_MS || resetPassed;
    const available = data.status === 'available' || (data.status === undefined && data.available === true);
    section.dataset.stale = String(stale);
    section.title = 'Cuota restante de la última lectura. Desactualizada tras 5 min, un reinicio de ventana o un fallo de telemetría.';
    title.append(element('span', `telemetry-state${stale && available ? ' telemetry-warning' : ''}`, available ? stale ? 'Desactualizado' : 'Actualizado' : 'No disponible'));
    section.append(title);
    if (available && windows.length) {
      for (const rawWindow of windows) {
        const window = record(rawWindow);
        const row = element('div', 'telemetry-window');
        const label = formatTelemetryWindow(window);
        const amount = number(window.remainingPercent);
        const valid = amount !== null && amount <= 100;
        const line = element('div', 'telemetry-row');
        line.append(element('span', 'telemetry-window-label', label), element('span', 'telemetry-value', valid ? `${formatTelemetryPercent(amount)} libre` : 'No disponible'));
        row.append(line);
        if (valid) {
          const meter = element('meter', 'telemetry-meter');
          meter.min = 0; meter.max = 100; meter.low = 10; meter.high = 25; meter.optimum = 100; meter.value = amount;
          meter.setAttribute('aria-label', `${provider}, ${label}: cuota restante${stale ? ', dato desactualizado' : ''}`);
          meter.textContent = formatTelemetryPercent(amount);
          row.append(meter);
        }
        metadata(row, 'Reinicio', window.resetsAt, true);
        section.append(row);
      }
    } else {
      section.append(element('p', 'telemetry-note', available ? 'El proveedor no informó ventanas de cuota.' : quotaReason(data)));
    }
    if (available && string(data.error)) section.append(element('p', 'telemetry-note telemetry-warning', string(data.error)!));
    metadata(section, 'Fuente', data.source);
    metadata(section, 'Observado', data.observedAt, true);
    return section;
  }

  function renderResources(staleTransport: boolean) {
    resources.replaceChildren(element('h3', '', 'Recursos locales'));
    const data = record(snapshot?.resources);
    const observed = timestamp(data.timestampUnixMs ?? data.observedAt);
    const stale = staleTransport || data.stale === true || (observed !== null && Date.now() - observed > RESOURCE_STALE_MS);
    resources.dataset.stale = String(stale);
    if (stale) resources.append(element('p', 'telemetry-note telemetry-warning', 'Recursos desactualizados'));
    const processes = Array.isArray(data.processes) ? data.processes : [];
    const app = record(data.app);
    const appRows = Array.isArray(app.processes) ? app.processes : Object.keys(app).length ? [app] : [];
    if (!snapshot || (!processes.length && !appRows.length)) {
      resources.append(element('p', 'telemetry-note', string(data.error) ?? 'Recursos no disponibles. Se reintenta cada 3 s.'));
    }
    function processRow(raw: unknown, fallback: string) {
      const process = record(raw);
      const row = element('div', 'telemetry-resource-line');
      const role = string(process.role)?.toLowerCase();
      const name = role === 'app' || role === 'gui' || role === 'interface' ? 'Interfaz' : role === 'runner' ? 'Runner' : fallback;
      const title = string(process.title);
      row.append(element('span', 'telemetry-session-name', title && title !== name ? `${name} · ${title}` : name), element('span', 'telemetry-value', resourceValue(process)));
      const rowTime = timestamp(process.timestampUnixMs);
      if (process.stale === true || (rowTime !== null && Date.now() - rowTime > RESOURCE_STALE_MS)) {
        row.append(element('span', 'telemetry-note telemetry-warning', 'Muestra desactualizada'));
      }
      resources.append(row);
    }
    if (appRows.length) {
      appRows.forEach((appRow,index)=>processRow(appRow,index===0?'Interfaz':`Interfaz · PID ${number(record(appRow).pid)??'—'}`));
    } else {
      const row = element('div', 'telemetry-resource-line');
      row.append(element('span', '', 'Interfaz'), element('span', 'telemetry-value', 'No disponible'));
      resources.append(row);
    }
    processes.forEach((raw, index) => {
      const process = record(raw);
      const pid = number(process.pid);
      // Runner integration supplies its own PID first, then current owned CLIs.
      processRow(raw, process.role === 'runner' || (process.role === undefined && index === 0) ? 'Runner' : process.role === 'tool' ? `Herramienta PID ${pid ?? 'no informado'}` : `CLI PID ${pid ?? 'no informado'}`);
    });
    resources.append(element('p', 'telemetry-note', 'Procesos observados: interfaz, runner, CLI y sus hijos. Excluye servicios reparentados, incluido WebKit no atribuible; no es un total garantizado de Jauria.'));
    resources.append(element('p', 'telemetry-note', 'CPU: 100 % = un núcleo; puede superarlo. Primera muestra: pendiente. RAM: RSS residente; puede contar memoria compartida más de una vez.'));
    if (record(data.discovery).partial===true || record(app.discovery).partial===true) resources.append(element('p','telemetry-note telemetry-warning','Inventario parcial; pueden faltar procesos.'));
    metadata(resources, 'Fuente', data.source);
    metadata(resources, 'Observado', data.timestampUnixMs ?? data.observedAt, true);
  }

  function resourceValue(data: RecordValue): string {
    if (data.available === false) return 'No disponible';
    const cpu = data.cpuAvailable === false ? null : number(data.cpuPercent);
    const cpuLabel = cpu === null ? data.cpuUnavailableReason === 'warming_up' ? 'pendiente' : 'no disponible' : formatTelemetryCpu(cpu);
    return `CPU ${cpuLabel} · RAM ${formatTelemetryBytes(data.rssBytes)}`;
  }

  function render() {
    if (disposed) return;
    const connected = isConnected();
    const stale = !connected || pollError || (receivedAt > 0 && Date.now() - receivedAt > RESOURCE_STALE_MS);
    refresh.disabled = !connected || inFlight || awaitingRefresh || refreshQueued || snapshot?.quotasRefreshing === true;
    refresh.textContent = awaitingRefresh || snapshot?.quotasRefreshing ? 'Consultando cuotas…' : 'Actualizar cuotas';
    const message = !connected ? 'Runner sin conexión' : refreshError || (pollError ? 'Telemetría no disponible; reintentando.' : awaitingRefresh || snapshot?.quotasRefreshing ? 'Consulta en segundo plano.' : !snapshot ? 'Consultando recursos…' : '');
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message;
    quotas.replaceChildren(renderQuota('Claude Code', snapshot?.quotas?.claude, stale), renderQuota('Codex', snapshot?.quotas?.codex, stale));
    renderResources(stale);
  }

  async function poll() {
    if (disposed || inFlight) return;
    if (!isConnected()) { render(); schedule(); return; }
    inFlight = true;
    try {
      if (refreshQueued) {
        refreshQueued = false;
        try {
          await request<unknown>('refresh_quotas', {});
        } catch {
          refreshError = 'No se pudo actualizar las cuotas. Vuelve a intentarlo.';
          return;
        }
        if (disposed) return;
        awaitingRefresh = true;
        refreshStarted = Date.now();
        sawRefreshing = false;
      }
      const next = await request<Snapshot>('telemetry', {});
      if (disposed) return;
      snapshot = { ...next, quotas: next.quotas ?? snapshot?.quotas };
      onSnapshot?.(snapshot);
      receivedAt = Date.now();
      pollError = false;
      if (next.quotasRefreshing) sawRefreshing = true;
      if (awaitingRefresh && !next.quotasRefreshing && (sawRefreshing || next.quotasRefreshing === false)) awaitingRefresh = false;
      if (awaitingRefresh && Date.now() - refreshStarted > 120_000) {
        awaitingRefresh = false;
        refreshError = 'Consulta sin confirmar. Puedes volver a actualizar.';
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
    if (!disposed) timer = setTimeout(() => { void poll(); }, refreshQueued ? 0 : POLL_MS);
  }
  function onRefresh() {
    if (disposed || refresh.disabled || !isConnected()) return;
    refreshError = '';
    refreshQueued = true;
    if (timer !== undefined) clearTimeout(timer);
    render();
    if (!inFlight) void poll();
  }
  refresh.addEventListener('click', onRefresh);
  render();
  void poll();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    refresh.removeEventListener('click', onRefresh);
    root.remove();
  };
}

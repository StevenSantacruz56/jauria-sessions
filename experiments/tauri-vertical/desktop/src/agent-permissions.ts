export type PermissionSession = { id: string; title: string; kind: string; cwd: string | null; status: string };
export type PermissionsOptions = {
  request: (op: string, args: Record<string, unknown>) => Promise<any>;
  sessions: () => PermissionSession[];
  available: () => boolean;
};
export type PermissionsContext = { projectId?: string; sessionId?: string };
type Policy = { id: string; policy: { provider?: string; cwd?: string; projectId?: string; canCreateProjects?: boolean } };
let instance = 0;
const ownProjectsScope = '__own_projects__';

/** Global management surface. Authorization remains bound by the runner to the
 * selected project (or own-project bootstrap), provider and canonical cwd.
 * The parent supplies a profile-bound request callback; no credentials are kept here.
 */
export function mountAgentPermissions(host: HTMLElement, options: PermissionsOptions, onBusyChange = () => {}) {
  const prefix = `agent-permissions-${++instance}`;
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  }
  function button(text: string, action: () => void) {
    const node = el('button', text, 'secondary'); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  function select(label: string, name: string) {
    const row = el('div', '', 'settings-dialog-row'); const title = el('label', label);
    const input = el('select'); input.id = `${prefix}-${name}`; title.htmlFor = input.id;
    row.append(title, input); host.append(row); return input;
  }
  function option(value: string, title: string) { const node = el('option', title); node.value = value; return node; }
  const heading = el('h3', 'Permisos de agentes'); heading.tabIndex = -1; heading.id = prefix;
  host.setAttribute('aria-labelledby', prefix);
  host.append(heading, el('p', 'Elige una sesión y un proyecto, o permite crear proyectos propios. Conceder muestra un comando que tú copias y ejecutas en esa sesión. Claude y Codex conservan sus permisos nativos.', 'settings-dialog-help'));
  const session = select('Sesión que recibirá permiso', 'session');
  const scope = select('Alcance del permiso', 'scope');
  const rememberLabel = el('label', '', 'settings-permissions-check');
  const remember = el('input'); remember.type = 'checkbox';
  rememberLabel.append(remember, el('span', 'Recordar para futuras sesiones de esta herramienta en esta carpeta'));
  const status = el('p', '', 'settings-dialog-help'); status.setAttribute('role', 'status');
  const result = el('div', '', 'settings-permissions-result');
  const actions = el('div', '', 'settings-permissions-actions');
  const grant = button('Conceder acceso y ver comando', () => { void write('grant'); });
  const revoke = button('Revocar permiso de la sesión', () => { void write('revoke'); });
  const retry = button('Actualizar permisos y proyectos', () => { void read(); });
  const more = button('Más proyectos', () => { void readMoreProjects(); }); more.hidden = true;
  actions.append(grant, revoke, retry, more);
  const policies = el('div');
  host.append(rememberLabel, el('p', 'Recordar es opcional y se guarda al conceder. Abajo solo aparecen permisos recordados.', 'settings-dialog-help'), actions, status, result, policies);
  let active = false, disposed = false, writing = false, reading = false, generation = 0;
  let connectionInterrupted = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let projects: { id: string; title: string }[] = [], saved: Policy[] = [], loaded = false;
  let hasMoreProjects = false, projectCursor = 0;
  const live = () => options.sessions().filter(s => ['claude', 'codex'].includes(s.kind) && ['starting', 'running'].includes(s.status));
  const validScope = (value: string) => value === ownProjectsScope || projects.some(project => project.id === value);
  const valid = (token: number) => !disposed && active && token === generation && options.available();
  const focusedAction = () => document.activeElement instanceof HTMLButtonElement && host.contains(document.activeElement) ? document.activeElement : null;
  function restoreAction(focused: HTMLButtonElement | null, preferred: HTMLElement) {
    if (!focused || !active || disposed) return;
    const current = document.activeElement;
    if (current !== focused && current instanceof HTMLElement && host.contains(current)) return;
    const usable = (node: HTMLElement) => node.isConnected && !node.hidden && !(node instanceof HTMLButtonElement && node.disabled);
    const target = usable(preferred) ? preferred : usable(focused) ? focused : heading;
    target.focus({ preventScroll: true });
  }
  function sync() {
    const unavailable = !options.available();
    host.setAttribute('aria-busy', String(reading || writing));
    for (const control of Array.from(host.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select'))) control.disabled = writing || reading || unavailable;
    grant.disabled ||= !loaded || !live().some(s => s.id === session.value) || !validScope(scope.value);
    revoke.disabled ||= !live().some(s => s.id === session.value);
    more.hidden = !hasMoreProjects;
    if (unavailable) {
      connectionInterrupted = true;
      status.textContent = 'Conexión temporalmente no disponible. El comando mostrado se conserva; espera a reconectar.';
    } else if (connectionInterrupted) {
      connectionInterrupted = false;
      status.textContent = result.querySelector('textarea')
        ? 'Conexión restablecida. El comando anterior sigue visible; comprueba la sesión antes de usarlo.'
        : 'Conexión restablecida. Pulsa Actualizar permisos y proyectos para comprobar el estado.';
    }
    onBusyChange();
  }
  let sessionSignature = '';
  function refreshSessions() {
    const value = session.value; const rows = live();
    const signature = JSON.stringify(rows.map(({ id, title, kind, cwd, status }) => [id, title, kind, cwd, status]));
    if (signature === sessionSignature) { sync(); return; }
    sessionSignature = signature;
    session.replaceChildren(option('', 'Seleccionar sesión'), ...rows.map(s => option(s.id, `${s.title} · ${s.kind} · ${s.cwd ?? 'Carpeta sin especificar'}`)));
    session.value = rows.some(s => s.id === value) ? value : '';
    sync();
  }
  function renderPolicies() {
    const title = el('h4', 'Permisos recordados'); title.tabIndex = -1;
    policies.replaceChildren(title);
    if (!saved.length) policies.append(el('p', 'No hay permisos recordados.', 'settings-dialog-help'));
    for (const entry of saved) {
      const p = entry.policy; const row = el('div', '', 'settings-permissions-policy');
      row.append(el('p', `${p.provider ?? 'Herramienta sin especificar'} · ${p.cwd ?? 'Carpeta sin especificar'}`, 'settings-dialog-help'),
        el('p', p.projectId ? `Proyecto: ${projects.find(project => project.id === p.projectId)?.title ?? p.projectId}` : 'Sin proyecto asignado', 'settings-dialog-help'),
        el('p', p.canCreateProjects ? 'Puede crear proyectos propios.' : 'No puede crear proyectos propios.', 'settings-dialog-help'),
        button('Revocar permiso recordado', () => { void write('revoke_policy', entry.id); }));
      policies.append(row);
    }
  }
  function projectPage(list: any, cursor: number) {
    if (!Array.isArray(list?.projects) || list.projects.length > 50
      || list.projects.some((entry: any) => typeof entry?.id !== 'string' || typeof entry.title !== 'string')) throw Error();
    const rows = list.projects as { id: string; title: string }[];
    const hasMore = list.hasMore === true;
    const next = list.nextCursor ?? cursor + rows.length;
    if (hasMore && (!rows.length || !Number.isInteger(next) || next <= cursor)) throw Error();
    return { rows, hasMore, next };
  }
  function renderScopes(selected: string) {
    const placeholder = option('', 'Elegir alcance'); placeholder.disabled = true;
    scope.replaceChildren(placeholder, option(ownProjectsScope, 'Crear proyectos propios'), ...projects.map(p => option(p.id, p.title)));
    loaded = validScope(selected);
    if (selected && !loaded) {
      const unknown = option(selected, `Proyecto no disponible: ${selected}`); unknown.disabled = true; scope.prepend(unknown);
      status.textContent = hasMoreProjects
        ? 'El proyecto solicitado no está entre los proyectos cargados. Pulsa Más proyectos para buscarlo o elige otro alcance antes de conceder permiso.'
        : 'El proyecto solicitado no está disponible en la lista. Elige otro alcance antes de conceder permiso.';
    } else if (!selected) {
      status.textContent = 'Elige un proyecto o la opción de crear proyectos propios antes de conceder acceso.';
    } else status.textContent = hasMoreProjects
      ? `Se muestran ${projects.length} proyectos. Pulsa Más proyectos para cargar hasta 50 más.`
      : `Se muestran todos los proyectos disponibles (${projects.length}).`;
    scope.value = selected;
  }
  async function read(context?: PermissionsContext) {
    if (!active || disposed || writing || reading || !options.available()) { sync(); return; }
    const focused = focusedAction();
    const token = ++generation; reading = true; status.textContent = 'Consultando permisos y proyectos…'; sync();
    try {
      const [p, list] = await Promise.all([options.request('policies', {}), options.request('projects', { limit: 50, cursor: 0, archived: false })]);
      if (!valid(token)) return;
      if (!Array.isArray(p?.policies)) throw Error();
      const page = projectPage(list, 0);
      saved = p.policies.filter((entry: any) => typeof entry?.id === 'string' && entry.policy && typeof entry.policy === 'object');
      projects = [...new Map(page.rows.map(p => [p.id, p])).values()];
      hasMoreProjects = page.hasMore; projectCursor = page.next;
      renderScopes(context?.projectId ?? scope.value);
      renderPolicies();
    } catch {
      if (valid(token)) { loaded = false; status.textContent = 'No se pudieron consultar los permisos y proyectos. Reintenta la consulta.'; }
    } finally { if (!disposed && token === generation) { reading = false; sync(); restoreAction(focused, scope); } }
  }
  async function readMoreProjects() {
    if (!active || disposed || writing || reading || !hasMoreProjects || !options.available()) return;
    const focused = focusedAction();
    const token = ++generation, cursor = projectCursor, selected = scope.value;
    reading = true; status.textContent = 'Consultando más proyectos…'; sync();
    try {
      const list = await options.request('projects', { limit: 50, cursor, archived: false });
      if (!valid(token)) return;
      const page = projectPage(list, cursor);
      projects = [...new Map([...projects, ...page.rows].map(p => [p.id, p])).values()];
      hasMoreProjects = page.hasMore; projectCursor = page.next;
      renderScopes(selected); renderPolicies();
    } catch {
      if (valid(token)) status.textContent = 'No se pudieron cargar más proyectos. El alcance elegido se conserva. Pulsa Más proyectos para reintentar.';
    } finally { if (!disposed && token === generation) { reading = false; sync(); restoreAction(focused, more.hidden ? scope : more); } }
  }
  async function write(op: 'grant' | 'revoke' | 'revoke_policy', id?: string) {
    if (!active || disposed || writing || reading || !options.available()) return;
    if (op !== 'revoke_policy' && !live().some(s => s.id === session.value)) { refreshSessions(); return; }
    if (op === 'grant' && (!loaded || !validScope(scope.value))) return;
    const focused = focusedAction();
    const token = ++generation; writing = true; result.replaceChildren(); status.textContent = 'Aplicando permiso…'; sync();
    const args = op === 'revoke_policy' ? { id } : op === 'revoke' ? { sessionId: session.value } : {
      sessionId: session.value, ...(scope.value === ownProjectsScope ? {} : { projectId: scope.value }), canCreateProjects: scope.value === ownProjectsScope, ...(remember.checked ? { remember: true } : {}),
    };
    let completed = false, hasCommand = false;
    try {
      const data = await options.request(op, args);
      if (!valid(token)) return;
      completed = true;
      if (op === 'grant') {
        remember.checked = false;
        status.textContent = 'Permiso concedido. Copia el comando y ejecútalo en la sesión elegida cuando estés listo.';
        // Only the bridge's safe command string is displayable. Never render
        // response objects, opaque handles, tokens, guidance or raw RPC errors.
        if (typeof data?.command === 'string' && data.command) {
          hasCommand = true;
          const label = el('label', 'Comando de registro'); const command = el('textarea');
          command.id = `${prefix}-command`; label.htmlFor = command.id; command.readOnly = true; command.value = data.command;
          result.append(label, command, button('Copiar comando de registro', () => {
            void navigator.clipboard.writeText(command.value).then(() => { if (valid(token)) status.textContent = 'Copiado. Pégalo en la sesión elegida cuando estés listo.'; }, () => { if (valid(token)) status.textContent = 'No se pudo copiar. Selecciona y copia el comando de registro.'; });
          }));
        } else status.textContent = 'Permiso concedido, pero el runner no devolvió un comando de registro. Consulta los permisos antes de volver a intentarlo.';
      } else status.textContent = op === 'revoke' ? 'Permiso de la sesión revocado.' : 'Permiso recordado revocado. Las futuras sesiones necesitarán autorización.';
      if (op !== 'revoke') {
        const response = await options.request('policies', {});
        if (!valid(token)) return;
        if (!Array.isArray(response?.policies)) throw Error();
        saved = response.policies.filter((entry: any) => typeof entry?.id === 'string' && entry.policy && typeof entry.policy === 'object'); renderPolicies();
      }
    } catch {
      if (valid(token)) status.textContent = completed
        ? (op === 'grant'
          ? hasCommand
            ? 'Permiso concedido. No se pudo actualizar la lista de permisos recordados. Copia el comando para usarlo; pulsa Actualizar permisos y proyectos para consultar la lista sin volver a conceder el permiso.'
            : 'Permiso concedido, pero no se recibió un comando ni se pudo actualizar la lista. Consulta los permisos antes de volver a intentarlo.'
          : 'Permiso recordado revocado. No se pudo actualizar la lista. Pulsa Actualizar permisos y proyectos para consultarla.')
        : 'No se pudo confirmar la operación. Consulta la lista antes de volver a intentarlo.';
    }
    finally {
      if (!disposed && token === generation) {
        writing = false; sync();
        const preferred = op === 'grant' ? result.querySelector<HTMLElement>('button') ?? grant
          : op === 'revoke_policy' ? policies.querySelector<HTMLElement>('.settings-permissions-policy button') ?? policies.querySelector<HTMLElement>('h4') ?? heading
          : revoke;
        restoreAction(focused, preferred);
      }
    }
  }
  session.addEventListener('change', () => { remember.checked = false; result.replaceChildren(); refreshSessions(); });
  scope.addEventListener('change', () => { loaded = validScope(scope.value); remember.checked = false; result.replaceChildren(); sync(); });
  return {
    get isBusy() { return writing; },
    open(context?: PermissionsContext) {
      if (disposed) return;
      if (active) { if (context) heading.focus(); return; }
      active = true; connectionInterrupted = false; loaded = false; remember.checked = false; saved = []; projects = []; hasMoreProjects = false; projectCursor = 0;
      sessionSignature = ''; session.replaceChildren(option('', 'Seleccionar sesión'));
      result.replaceChildren(); policies.replaceChildren(); scope.replaceChildren(option('', 'Elegir alcance'));
      refreshSessions();
      timer = setInterval(refreshSessions, 1000); void read(context);
    },
    focus() { heading.focus(); heading.scrollIntoView({ block: 'start' }); },
    close() {
      if (writing) return;
      active = false; ++generation; reading = false; clearInterval(timer); result.replaceChildren(); remember.checked = false;
    },
    dispose() { disposed = true; active = false; ++generation; clearInterval(timer); host.replaceChildren(); },
  };
}

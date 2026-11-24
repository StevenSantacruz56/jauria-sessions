import './settings-panel.css';
import { mountAgentPermissions, type PermissionsOptions, type PermissionsContext } from './agent-permissions';

export type AppSettings = {
  schemaVersion: number;
  maxConcurrentSessions: number;
  maxSupportedSessions: number;
  pulsoAutoAccess?: boolean;
  warning?: string | null;
};
export type Grouping = 'project' | 'state';

type Options = {
  permissions?: PermissionsOptions;
  /** Moved into «Avisos», keeping IDs and listeners (the macOS notifications control). */
  notificationControls?: HTMLElement;
  /** Moved into «Acerca de y diagnóstico», keeping IDs and listeners (versions, restart, CLI check, diagnostic). */
  aboutControls?: HTMLElement;
  read: () => Promise<AppSettings>;
  save: (limit: number, pulsoAutoAccess?: boolean) => Promise<AppSettings>;
  getTheme: () => string;
  setTheme: (theme: string) => void;
  /** Terminal font size, per profile, applied at once (one resize per terminal). */
  terminalFont?: { get: () => number; set: (size: number) => void; min: number; max: number; default: number };
  /** Agentes grouping, per profile (the same preference as the sidebar button). */
  grouping?: { get: () => Grouping; set: (value: Grouping) => void };
  /** Restore the sidebar width, the Proyectos/Agentes split and unfold both sections. */
  resetSidebar?: () => void;
  version: string;
  canEdit: () => boolean;
  onSaved: (settings: AppSettings) => void;
};

/**
 * `set_settings` arguments as the runner's settingsVersion expects them: 2 adds
 * `pulsoAutoAccess` (always a boolean when present), 1 takes only the limit.
 * tests/rpc-contract.test.ts checks this against the shared contract table.
 */
export function settingsArgs(settingsVersion: 1 | 2, maxConcurrentSessions: number, pulsoAutoAccess?: boolean): { maxConcurrentSessions: number; pulsoAutoAccess?: boolean } {
  return settingsVersion === 2 && typeof pulsoAutoAccess === 'boolean' ? { maxConcurrentSessions, pulsoAutoAccess } : { maxConcurrentSessions };
}

let instance = 0;
const themes = ['system', 'light', 'dark'];
const themeValue = (value: string) => themes.includes(value) ? value : 'system';
const themeLabel: Record<string, string> = { system: 'Sistema', light: 'Clara', dark: 'Oscura' };
const sessionsLabel = (n: number) => `${n} ${n === 1 ? 'sesión' : 'sesiones'}`;

function checked(settings: AppSettings): AppSettings {
  if (!settings || !Number.isInteger(settings.schemaVersion) || settings.schemaVersion < 1
    || !Number.isInteger(settings.maxSupportedSessions) || settings.maxSupportedSessions < 1
    || !Number.isInteger(settings.maxConcurrentSessions) || settings.maxConcurrentSessions < 1
    || settings.maxConcurrentSessions > Math.min(8, settings.maxSupportedSessions)
    || (settings.schemaVersion >= 2 && typeof settings.pulsoAutoAccess !== 'boolean')) {
    throw new Error('El runner devolvió una configuración no válida. Reintenta la consulta.');
  }
  return settings;
}

/**
 * Configuración. One saving model: every option applies as soon as it changes
 * and the footer confirms it («Guardado…»); there is no Guardar button and no
 * unsaved state. Appearance, terminal font, grouping and the sidebar layout are
 * local view preferences. The session limit and automatic Pulso access are
 * runner settings: a change is sent at once (both keys, as settingsVersion
 * expects), changes made while one is in flight are sent once after it, and a
 * failure puts the control back on the runner's value and says so. Manual
 * Pulso access keeps its explicit buttons. The parent owns persistence,
 * capability detection and applying themes; mounting and opening never save.
 */
export function mountSettings(options: Options): {
  open: (section?: 'permissions', context?: PermissionsContext) => void;
  close: () => void;
  dispose: () => void;
  readonly isOpen: boolean;
} {
  const prefix = `jauria-settings-${++instance}`;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
    const el = document.createElement(tag); el.textContent = text; el.className = cls; return el;
  }
  const dialog = node('dialog', '', 'session-dialog settings-dialog');
  const form = node('form'); form.noValidate = true;
  const heading = node('header', '', 'dialog-heading');
  const content = node('div', '', 'settings-dialog-content');
  const title = node('h2', 'Configuración'); title.id = `${prefix}-title`; title.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', title.id);
  const headingCopy = node('div');
  headingCopy.append(title, node('p', 'Los cambios se aplican y se guardan al momento.'));
  heading.append(headingCopy);
  const section = (name: string, key: string) => {
    const el = node('section', '', `settings-dialog-section settings-${key}`);
    const h = node('h3', name); h.id = `${prefix}-${key}`; el.setAttribute('aria-labelledby', h.id); el.append(h); return el;
  };
  // Row: label and one line saying what changing it does, the control on the right.
  const row = (label: HTMLElement, help: HTMLElement | null, control: HTMLElement) => {
    const wrap = node('div', '', 'settings-dialog-row'); const copy = node('div', '', 'settings-row-copy');
    copy.append(label); if (help) copy.append(help); wrap.append(copy, control); return wrap;
  };
  const help = (text: string, cls = 'settings-row-help') => node('p', text, cls);
  const labelled = (control: HTMLElement & { id: string }, text: string, key: string, describedBy?: HTMLElement) => {
    control.id = `${prefix}-${key}`; const label = node('label', text); label.htmlFor = control.id;
    if (describedBy) { describedBy.id = `${control.id}-help`; control.setAttribute('aria-describedby', describedBy.id); }
    return label;
  };
  const select = (entries: [string, string][]) => { const el = node('select'); for (const [value, text] of entries) { const o = node('option', text); o.value = value; el.append(o); } return el; };

  // Apariencia
  const appearance = section('Apariencia', 'appearance');
  const theme = select([['system', 'Sistema'], ['light', 'Clara'], ['dark', 'Oscura']]);
  const themeHelp = help('Colores de la ventana. «Sistema» sigue a macOS.');
  appearance.append(row(labelled(theme, 'Tema de colores', 'theme', themeHelp), themeHelp, theme));
  let font: HTMLSelectElement | null = null, fontHelp: HTMLElement | null = null;
  if (options.terminalFont) {
    const f = options.terminalFont;
    font = select(Array.from({ length: f.max - f.min + 1 }, (_, i) => { const size = f.min + i; return [String(size), `${size} px`] as [string, string]; }));
    fontHelp = help('', 'settings-row-help settings-wrap');
    appearance.append(row(labelled(font, 'Tamaño de letra del terminal', 'font', fontHelp), fontHelp, font));
  }

  // Barra lateral
  let sidebar: HTMLElement | null = null, grouping: HTMLSelectElement | null = null;
  if (options.grouping || options.resetSidebar) {
    sidebar = section('Barra lateral', 'sidebar');
    if (options.grouping) {
      grouping = select([['project', 'Por proyecto'], ['state', 'Por estado']]);
      const groupingHelp = help('Cómo se ordena la lista de Agentes. También cambia con el botón de su cabecera.');
      sidebar.append(row(labelled(grouping, 'Agrupar agentes', 'grouping', groupingHelp), groupingHelp, grouping));
    }
    if (options.resetSidebar) {
      const reset = node('button', 'Restablecer', 'secondary'); reset.type = 'button';
      const resetHelp = help('Ancho de 264 px, reparto inicial entre Proyectos y Agentes y las dos secciones desplegadas.');
      reset.id = `${prefix}-reset-sidebar`; resetHelp.id = `${reset.id}-help`; reset.setAttribute('aria-describedby', resetHelp.id);
      const label = node('span', 'Tamaño y secciones', 'settings-row-label');
      reset.setAttribute('aria-label', 'Restablecer tamaño y secciones de la barra lateral');
      reset.addEventListener('click', () => { options.resetSidebar?.(); status.textContent = 'Barra lateral restablecida.'; });
      sidebar.append(row(label, resetHelp, reset));
    }
  }

  // Sesiones
  const sessions = section('Sesiones', 'sessions');
  const limit = node('select');
  const range = help('Consultando el límite…');
  const limitLabel = labelled(limit, 'Máximo de sesiones simultáneas', 'limit', range);
  sessions.append(row(limitLabel, range, limit),
    help('Al llegar al máximo no puedes abrir otra sesión hasta terminar una. Bajarlo no cierra las sesiones abiertas. Una misma carpeta de Git admite un solo agente que escriba a la vez.', 'settings-dialog-help'),
    help('Cerrar la ventana no detiene las sesiones: siguen en marcha y las encuentras al volver. Para detener una, usa Terminar sesión en el menú «…» de su panel.', 'settings-dialog-help settings-close-hint'));
  const compatibility = help('Este runner no permite cambiar el máximo (se mantiene en 2). Para cambiarlo, reinícialo desde Acerca de y diagnóstico cuando no tengas trabajo en curso.', 'settings-dialog-help settings-unavailable');
  compatibility.hidden = true; sessions.append(compatibility);

  // Pulso y agentes
  const pulso = section('Pulso y agentes', 'pulso');
  const pulsoRow = node('label', '', 'settings-pulso-switch');
  const pulsoToggle = node('input'); pulsoToggle.type = 'checkbox'; pulsoToggle.id = `${prefix}-pulso-auto`;
  pulsoRow.append(node('span', 'Acceso automático a Pulso'), pulsoToggle);
  const pulsoState = help('', 'settings-row-help settings-pulso-state');
  // Permission warning: it may be clearer than before, never say less.
  const pulsoScope = help('Si está activado, cada sesión nueva de Claude Code o Codex que abras desde Jauría puede leer y editar todos tus proyectos de Pulso (plan, fases y checkpoints) y crear proyectos nuevos. No ve las tarjetas de Pendientes. Lo que lea puede llegar al proveedor de ese agente.', 'settings-dialog-help settings-pulso-scope');
  const pulsoHow = help('Cada sesión recibe un permiso privado que se retira solo al terminar. No cambia lo que Claude Code o Codex pueden hacer con archivos, comandos o red, y no afecta a agentes que inicies fuera de Jauría. Al desactivarlo, se corta al momento el acceso automático de todas las sesiones, también de las abiertas; los accesos que des a mano abajo siguen hasta que los quites.', 'settings-dialog-help');
  pulsoState.id = `${pulsoToggle.id}-state`; pulsoScope.id = `${pulsoToggle.id}-scope`;
  pulsoToggle.setAttribute('aria-describedby', `${pulsoState.id} ${pulsoScope.id}`);
  const pulsoCompatibility = help('Este runner no ofrece el acceso automático a Pulso. Reinícialo desde Acerca de y diagnóstico cuando no tengas trabajo en curso.', 'settings-dialog-help settings-unavailable');
  pulsoCompatibility.hidden = true;
  pulso.append(pulsoRow, pulsoState, pulsoScope, pulsoHow, pulsoCompatibility);
  const permissionsDetails = node('details', '', 'settings-permissions-details');
  const permissionsSummary = node('summary', 'Dar o quitar acceso a una sesión ya abierta');
  const permissionsIntro = help('Sirve para una sesión de Claude Code o Codex que empezó sin acceso (por ejemplo, antes de activar el acceso automático o de actualizar Jauría), o para limitar una sesión a un solo proyecto. Eliges la sesión y qué puede hacer; Jauría te da unas instrucciones para pegar en esa conversación.', 'settings-dialog-help');
  const permissionsHost = node('section', '', 'settings-permissions');
  permissionsDetails.append(permissionsSummary, permissionsHost);
  if (options.permissions) {
    const manual = node('div', '', 'settings-manual');
    manual.append(permissionsIntro, permissionsDetails);
    pulso.append(manual);
  }

  // Avisos
  const notices = section('Avisos', 'notices');
  notices.append(help('Jauría avisa cuando un agente pide tu atención, termina un turno o su proceso termina. La salida normal del terminal no avisa. Dentro de la app los avisos están siempre: la campana, la barra de estado y el número sobre el icono del Dock. Ver un aviso no lo resuelve.', 'settings-dialog-help'));
  if (options.notificationControls) {
    for (const button of Array.from(options.notificationControls.querySelectorAll('button'))) button.type = 'button';
    notices.append(options.notificationControls);
  }

  // Acerca de y diagnóstico
  const about = section('Acerca de y diagnóstico', 'about');
  about.append(help(`Jauría ${options.version}`, 'settings-dialog-help settings-app-version'));
  if (options.aboutControls) {
    for (const button of Array.from(options.aboutControls.querySelectorAll('button'))) button.type = 'button';
    options.aboutControls.hidden = false;
    about.append(options.aboutControls);
  }

  const warning = node('p', '', 'settings-dialog-warning'); warning.setAttribute('role', 'status'); warning.hidden = true;
  const error = node('p', '', 'form-error'); error.id = `${prefix}-error`; error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = node('button', 'Reintentar consulta', 'secondary'); retry.type = 'button'; retry.hidden = true;
  const status = node('p', '', 'settings-dialog-status'); status.setAttribute('role', 'status');
  const footer = node('footer', '', 'dialog-footer');
  const messages = node('div', '', 'settings-dialog-messages');
  const closeButton = node('button', 'Cerrar', 'quiet'); closeButton.type = 'button';
  messages.append(error, retry, status);
  footer.append(messages, closeButton);
  sessions.append(warning);
  content.append(appearance); if (sidebar) content.append(sidebar);
  content.append(sessions, pulso, notices, about);
  form.append(heading, content, footer);
  dialog.append(form); document.body.append(dialog);

  let disposed = false, loading = false, saving = false, loaded = false, readFailed = false;
  let current: AppSettings | null = null;
  // Values the person chose and that are not confirmed yet (sent once the in-flight save ends).
  let wantedLimit: number | null = null, wantedPulso: boolean | null = null;
  // One sequence number per choice: the queue follows the latest intention, never a value comparison.
  let limitSeq = 0, pulsoSeq = 0;
  let opener: HTMLElement | null = null;
  let underlyingDialog: HTMLDialogElement | null = null;
  let generation = 0, intentionalCloses = 0;
  const permissions = options.permissions ? mountAgentPermissions(permissionsHost, options.permissions, sync) : null;
  permissionsDetails.addEventListener('toggle', () => {
    if (!dialog.open || !permissions) return;
    if (permissionsDetails.open) permissions.open();
    else permissions.close();
  });

  function showError(message: string): void { error.textContent = message; error.hidden = !message; }
  function paintLocal(): void {
    if (font && options.terminalFont) {
      const size = options.terminalFont.get(); font.value = String(size);
      fontHelp!.textContent = `Letra de ${size} px en todos los terminales (inicial: ${options.terminalFont.default} px). Al cambiarla, cada terminal se reajusta una vez.`;
    }
    if (grouping && options.grouping) grouping.value = options.grouping.get();
  }
  function paintRunner(): void {
    const max = current ? Math.min(8, current.maxSupportedSessions) : 0;
    if (limit.options.length !== max) limit.replaceChildren(...Array.from({ length: max }, (_, i) => { const o = node('option', sessionsLabel(i + 1)); o.value = String(i + 1); return o; }));
    const shownLimit = wantedLimit ?? current?.maxConcurrentSessions ?? null;
    if (shownLimit !== null) limit.value = String(shownLimit);
    range.textContent = current
      ? `Hasta ${sessionsLabel(current.maxConcurrentSessions)} a la vez, sumando Codex, Claude Code y Terminal.`
      : readFailed ? 'No se pudo consultar el límite.' : 'Consultando el límite…';
    const auto = wantedPulso ?? current?.pulsoAutoAccess ?? false;
    pulsoToggle.checked = auto;
    pulsoState.textContent = current?.schemaVersion === 2 ? (current.pulsoAutoAccess ? 'Activado: las sesiones nuevas reciben acceso.' : 'Desactivado: ninguna sesión lo recibe de forma automática.') : '';
    warning.textContent = current?.warning ?? ''; warning.hidden = !current?.warning;
  }
  function sync(): void {
    const editable = options.canEdit();
    const inFlight = loading || saving;
    dialog.setAttribute('aria-busy', String(loading || saving || !!permissions?.isBusy));
    // Controls stay enabled while a save is in flight (changes queue); only a read or a lost runner disables them.
    limit.disabled = loading || !loaded || !editable;
    pulsoToggle.disabled = loading || !loaded || !editable || current?.schemaVersion !== 2;
    compatibility.hidden = editable || !loaded;
    pulsoCompatibility.hidden = !loaded || (editable && current?.schemaVersion === 2);
    closeButton.disabled = inFlight || !!permissions?.isBusy;
    closeButton.textContent = saving ? 'Guardando…' : 'Cerrar';
    retry.disabled = loading; retry.hidden = !readFailed;
    paintRunner();
  }
  function accept(settings: AppSettings): void { current = settings; loaded = true; }
  async function read(): Promise<void> {
    if (disposed || loading || saving || !dialog.open) return;
    const token = ++generation;
    loading = true; showError(''); status.textContent = 'Consultando la configuración…'; sync();
    try {
      const result = await options.read();
      if (disposed || token !== generation) return;
      accept(checked(result)); readFailed = false; status.textContent = '';
    } catch {
      if (disposed || token !== generation) return;
      readFailed = true;
      showError('No se pudo leer la configuración del runner. La apariencia y la barra lateral siguen disponibles; reintenta la consulta.');
      status.textContent = '';
    } finally {
      if (!disposed && token === generation) { loading = false; sync(); }
    }
  }
  /** Sends the wanted values; anything chosen meanwhile goes in one more call afterwards. */
  async function flush(): Promise<void> {
    if (disposed || saving || loading || !current || !options.canEdit()) return;
    const base = current;
    const limitValue = wantedLimit ?? base.maxConcurrentSessions;
    const pulsoValue = base.schemaVersion === 2 ? (wantedPulso ?? base.pulsoAutoAccess) : undefined;
    if (limitValue === base.maxConcurrentSessions && (pulsoValue === undefined || pulsoValue === base.pulsoAutoAccess)) { wantedLimit = null; wantedPulso = null; sync(); return; }
    const sentLimit = limitSeq, sentPulso = pulsoSeq;
    const token = ++generation;
    saving = true; showError(''); status.textContent = 'Guardando…'; sync();
    let saved: AppSettings | null = null;
    try {
      saved = checked(await options.save(limitValue, pulsoValue));
      if (disposed || token !== generation) return;
      // The response is authoritative (including a changed server cap).
      accept(saved);
      if (limitSeq === sentLimit) wantedLimit = null;
      if (pulsoSeq === sentPulso) wantedPulso = null;
      options.onSaved(saved);
      if (disposed || token !== generation) return;
      status.textContent = `Guardado: ${sessionsLabel(saved.maxConcurrentSessions)} a la vez${saved.schemaVersion === 2 ? `; acceso automático a Pulso ${saved.pulsoAutoAccess ? 'activado' : 'desactivado'}` : ''}.`;
    } catch {
      if (disposed || token !== generation) return;
      // Only what this call sent goes back to the runner value; a change chosen
      // meanwhile stays wanted and is sent by the call that follows.
      if (limitSeq === sentLimit) wantedLimit = null;
      if (pulsoSeq === sentPulso) wantedPulso = null;
      showError(`No se pudo guardar. Sigue el valor anterior: ${sessionsLabel(base.maxConcurrentSessions)} a la vez${base.schemaVersion === 2 ? `, acceso automático ${base.pulsoAutoAccess ? 'activado' : 'desactivado'}` : ''}. Vuelve a elegir para reintentar.`);
      status.textContent = '';
    } finally {
      if (!disposed && token === generation) {
        saving = false; sync();
        if (wantedLimit !== null || wantedPulso !== null) void flush();
      }
    }
  }
  function restoreFocus(): void {
    if (opener?.isConnected) opener.focus();
    else if (underlyingDialog?.isConnected && underlyingDialog.open) {
      // Pulso polling may replace the opener while Settings is stacked above it.
      const focusable = Array.from(underlyingDialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
      )).find(node => !node.closest('[hidden],[inert]') && node.getClientRects().length > 0);
      if (focusable) focusable.focus();
      else { underlyingDialog.tabIndex = -1; underlyingDialog.focus(); }
    }
    opener = null; underlyingDialog = null;
  }
  function close(): void {
    if (disposed || saving || loading || permissions?.isBusy || !dialog.open) return;
    permissions?.close(); ++intentionalCloses; dialog.close(); restoreFocus();
  }
  theme.addEventListener('change', () => {
    const value = themeValue(theme.value); options.setTheme(value);
    status.textContent = `Tema de colores: ${themeLabel[value]}.`;
  });
  font?.addEventListener('change', () => {
    const f = options.terminalFont!; const size = Number(font!.value);
    if (!Number.isInteger(size) || size < f.min || size > f.max) { paintLocal(); return; }
    f.set(size); paintLocal(); status.textContent = `Letra del terminal: ${size} px.`;
  });
  grouping?.addEventListener('change', () => {
    const value: Grouping = grouping!.value === 'state' ? 'state' : 'project';
    options.grouping!.set(value); paintLocal(); status.textContent = `Agentes agrupados ${value === 'state' ? 'por estado' : 'por proyecto'}.`;
  });
  limit.addEventListener('change', () => {
    const value = Number(limit.value);
    if (!current || !Number.isInteger(value) || value < 1 || value > Math.min(8, current.maxSupportedSessions)) { paintRunner(); return; }
    wantedLimit = value; limitSeq++; void flush(); sync();
  });
  pulsoToggle.addEventListener('change', () => {
    if (current?.schemaVersion !== 2) { paintRunner(); return; }
    wantedPulso = pulsoToggle.checked; pulsoSeq++; void flush(); sync();
  });
  form.addEventListener('submit', event => event.preventDefault());
  retry.addEventListener('click', () => { void read(); });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    // Let the browser finish Escape's focus steps before the close handler.
    // Closing synchronously inside cancel can lose restored focus in WebKit.
    if (saving || loading || permissions?.isBusy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (intentionalCloses) { --intentionalCloses; return; }
    if (disposed || dialog.open) return;
    // A native close watcher can bypass cancel; preserve in-flight writes.
    if (saving || loading || permissions?.isBusy) { dialog.showModal(); return; }
    permissions?.close(); restoreFocus();
  });
  sync();
  return {
    get isOpen() { return !disposed && dialog.open; },
    open(section, context) {
      if (disposed) return;
      if (dialog.open) { if (section === 'permissions') { permissionsDetails.open = true; permissions?.focus(); } return; }
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      underlyingDialog = opener?.closest<HTMLDialogElement>('dialog[open]')
        ?? Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1) ?? null;
      theme.value = themeValue(options.getTheme()); paintLocal(); status.textContent = '';
      if (section === 'permissions') permissionsDetails.open = true;
      dialog.showModal(); title.focus(); void read();
      if (permissionsDetails.open) permissions?.open(context);
      if (section === 'permissions') permissions?.focus();
    },
    close,
    dispose() {
      if (disposed) return;
      disposed = true; ++generation; permissions?.dispose();
      if (dialog.open) dialog.close();
      dialog.remove(); restoreFocus();
    },
  };
}

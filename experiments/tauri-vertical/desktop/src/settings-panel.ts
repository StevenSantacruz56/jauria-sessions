import './settings-panel.css';
import { mountAgentPermissions, type PermissionsOptions, type PermissionsContext } from './agent-permissions';

export type AppSettings = {
  schemaVersion: number;
  maxConcurrentSessions: number;
  maxSupportedSessions: number;
  pulsoAutoAccess?: boolean;
  warning?: string | null;
};

type Options = {
  permissions?: PermissionsOptions;
  notificationControls?: HTMLElement;
  onOpenAttention?: () => void;
  canOpenAttention?: () => boolean;
  hasAttention?: () => boolean;
  read: () => Promise<AppSettings>;
  save: (limit: number, pulsoAutoAccess?: boolean) => Promise<AppSettings>;
  getTheme: () => string;
  setTheme: (theme: string) => void;
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

/** The parent owns persistence, runner capability detection and applying themes.
 * Mounting and opening only construct UI and read settings; neither saves.
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
  headingCopy.append(title, node('p', 'Apariencia, sesiones y acceso automático a Pulso: pulsa Guardar. Los permisos manuales y avisos se aplican al momento.'));
  heading.append(headingCopy);
  const general = node('section', '', 'settings-dialog-section');
  const generalTitle = node('h3', 'General'); generalTitle.id = `${prefix}-general`;
  general.setAttribute('aria-labelledby', generalTitle.id);
  // Compact rows: label and one line of help on the left, the control on the right;
  // longer explanations stay behind «Más detalles».
  const row = (label: HTMLElement, help: HTMLElement | null, control: HTMLElement) => {
    const wrap = node('div', '', 'settings-dialog-row'); const copy = node('div', '', 'settings-row-copy');
    copy.append(label); if (help) copy.append(help); wrap.append(copy, control); return wrap;
  };
  const more = (...content: HTMLElement[]) => { const details = node('details', '', 'settings-more'); details.append(node('summary', 'Más detalles'), ...content); return details; };
  const themeLabel = node('label', 'Apariencia');
  const theme = node('select'); theme.id = `${prefix}-theme`; themeLabel.htmlFor = theme.id;
  for (const [value, label] of [['system', 'Sistema'], ['light', 'Clara'], ['dark', 'Oscura']]) {
    const option = node('option', label); option.value = value; theme.append(option);
  }
  const themeHelp = node('p', 'Sistema, clara u oscura. Se aplica al pulsar Guardar.', 'settings-row-help');
  general.append(generalTitle, row(themeLabel, themeHelp, theme));
  const sessions = node('section', '', 'settings-dialog-section');
  const sessionsTitle = node('h3', 'Sesiones'); sessionsTitle.id = `${prefix}-sessions`;
  sessions.setAttribute('aria-labelledby', sessionsTitle.id);
  const limitLabel = node('label', 'Máximo de sesiones simultáneas');
  const limit = node('input'); limit.type = 'number'; limit.min = '1'; limit.max = '8'; limit.step = '1';
  limit.id = `${prefix}-limit`; limitLabel.htmlFor = limit.id;
  // No optimistic default: the runner supplies the actual persisted limit.
  const range = node('p', 'Consultando el límite del runner…', 'settings-row-help');
  range.id = `${prefix}-range`; limit.setAttribute('aria-describedby', range.id);
  const explanation = node('p', 'El límite suma Codex, Claude Code y Terminal. Reducirlo no cierra sesiones existentes; un mismo worktree sigue admitiendo un solo escritor.', 'settings-dialog-help');
  const compatibility = node('p', 'Este runner no permite ajustar el límite. Puedes guardar la apariencia; para cambiar el máximo, actualiza el runner.', 'settings-dialog-help');
  compatibility.hidden = true;
  sessions.append(sessionsTitle, row(limitLabel, range, limit), compatibility, more(explanation));
  const pulso = node('section', '', 'settings-dialog-section settings-pulso');
  const pulsoTitle = node('h3', 'Pulso para agentes'); pulsoTitle.id = `${prefix}-pulso`;
  pulso.setAttribute('aria-labelledby', pulsoTitle.id);
  const pulsoRow = node('label', '', 'settings-pulso-switch');
  const pulsoCopy = node('span', 'Acceso automático a Pulso');
  const pulsoToggle = node('input'); pulsoToggle.type = 'checkbox'; pulsoToggle.id = `${prefix}-pulso-auto`;
  pulsoRow.append(pulsoCopy, pulsoToggle);
  const pulsoHelp = node('p', 'Claude Code y Codex iniciados desde Jauría pueden leer y editar los proyectos de Pulso, y crear proyectos nuevos. Cada sesión usa una credencial privada que se revoca al terminar. No afecta a agentes iniciados fuera de Jauría.', 'settings-dialog-help');
  const pulsoCompatibility = node('p', 'Actualiza el runner para activar el acceso automático a Pulso.', 'settings-dialog-help');
  pulsoCompatibility.hidden = true;
  pulso.append(pulsoTitle, pulsoRow, pulsoHelp, pulsoCompatibility);
  const warning = node('p', '', 'settings-dialog-warning'); warning.setAttribute('role', 'status'); warning.hidden = true;
  const error = node('p', '', 'form-error'); error.id = `${prefix}-error`; error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = node('button', 'Reintentar consulta', 'secondary'); retry.type = 'button'; retry.hidden = true;
  const status = node('p', '', 'settings-dialog-status'); status.setAttribute('role', 'status');
  const footer = node('footer', '', 'dialog-footer');
  const messages = node('div', '', 'settings-dialog-messages');
  const closeButton = node('button', 'Cerrar', 'quiet'); closeButton.type = 'button';
  const saveButton = node('button', 'Guardar', 'primary'); saveButton.type = 'submit';
  messages.append(error, retry, status, node('span', `Jauría ${options.version}`, 'settings-dialog-version'));
  // Visible unsaved-changes mark next to Guardar; the status line also announces it.
  const dirtyMark = node('span', 'Sin guardar', 'settings-dirty'); dirtyMark.hidden = true;
  footer.append(messages, dirtyMark, closeButton, saveButton);
  const permissionsDetails = node('details', '', 'settings-dialog-section settings-permissions-details');
  const permissionsSummary = node('summary', 'Acceso manual para sesiones existentes');
  const permissionsHost = node('section', '', 'settings-permissions');
  permissionsDetails.append(permissionsSummary, permissionsHost);
  const notices = node('section', '', 'settings-dialog-section');
  let refreshAttention = () => {};
  notices.append(node('h3', 'Avisos'));
  // Move the original controls, preserving IDs, state and listeners.
  if (options.notificationControls) {
    for (const button of Array.from(options.notificationControls.querySelectorAll('button'))) button.type = 'button';
    notices.append(options.notificationControls);
  }
  if (options.onOpenAttention) {
    const attention = node('button', 'Ver sesiones que necesitan atención', 'secondary'); attention.type = 'button';
    const attentionEmpty = node('p', 'No hay sesiones que necesiten atención.', 'settings-dialog-help');
    const syncAttention = () => {
      const hasAttention = options.hasAttention?.() ?? true;
      attention.disabled = busy || !!permissions?.isBusy || !hasAttention;
      attentionEmpty.hidden = hasAttention;
    };
    attention.addEventListener('click', () => {
      if (busy || permissions?.isBusy) return;
      if (options.hasAttention && !options.hasAttention()) { refreshAttention(); return; }
      if (options.canOpenAttention && !options.canOpenAttention()) {
        status.textContent = 'Guarda o descarta el borrador de Pulso antes de abrir los avisos.';
        return;
      }
      close(); options.onOpenAttention?.();
    });
    notices.append(attention, attentionEmpty);
    refreshAttention = syncAttention;
  }
  content.append(general, sessions, pulso);
  if (options.permissions) content.append(permissionsDetails);
  if (options.notificationControls || options.onOpenAttention) content.append(notices);
  content.append(warning);
  form.append(heading, content, footer);
  dialog.append(form); document.body.append(dialog);

  let disposed = false, busy = false, loaded = false, readFailed = false;
  let limitDirty = false, themeDirty = false, pulsoDirty = false;
  const pendingLabel = () => limitDirty || themeDirty || pulsoDirty ? 'Cambios sin guardar. Pulsa Guardar para aplicarlos.' : '';
  let current: AppSettings | null = null;
  let opener: HTMLElement | null = null;
  let underlyingDialog: HTMLDialogElement | null = null;
  let generation = 0, intentionalCloses = 0;
  const permissions = options.permissions ? mountAgentPermissions(permissionsHost, options.permissions, sync) : null;
  permissionsDetails.addEventListener('toggle', () => {
    if (!dialog.open || !permissions) return;
    if (permissionsDetails.open) permissions.open();
    else permissions.close();
  });

  function showError(message: string, invalid = false): void {
    error.textContent = message; error.hidden = !message;
    limit.setAttribute('aria-invalid', String(invalid));
    limit.setAttribute('aria-describedby', `${range.id}${invalid ? ` ${error.id}` : ''}`);
  }
  function sync(): void {
    const editable = options.canEdit();
    const blocked = busy || !!permissions?.isBusy;
    dialog.setAttribute('aria-busy', String(blocked));
    theme.disabled = busy;
    limit.disabled = busy || !loaded || !editable;
    pulsoToggle.disabled = busy || !loaded || !editable || current?.schemaVersion !== 2;
    pulsoCompatibility.hidden = current?.schemaVersion === 2;
    closeButton.disabled = blocked;
    closeButton.textContent = limitDirty || themeDirty || pulsoDirty ? 'Cerrar y conservar borrador' : 'Cerrar';
    dirtyMark.hidden = !(limitDirty || themeDirty || pulsoDirty);
    saveButton.disabled = blocked || (editable && !loaded);
    saveButton.textContent = busy && !readFailed ? 'Esperando…' : 'Guardar';
    retry.disabled = busy; retry.hidden = !readFailed;
    compatibility.hidden = editable;
    refreshAttention();
  }
  function accept(settings: AppSettings): void {
    current = settings; loaded = true;
    limit.max = String(Math.min(8, settings.maxSupportedSessions));
    range.textContent = `De 1 a ${limit.max} sesiones simultáneas, entre todos los proveedores.`;
    if (!limitDirty) limit.value = String(settings.maxConcurrentSessions);
    if (!pulsoDirty) pulsoToggle.checked = settings.pulsoAutoAccess ?? false;
    warning.textContent = settings.warning ?? ''; warning.hidden = !settings.warning;
  }
  async function read(): Promise<void> {
    if (disposed || busy || !dialog.open) return;
    const token = ++generation;
    busy = true; showError(''); status.textContent = 'Consultando configuración…'; sync();
    try {
      const result = await options.read();
      if (disposed || token !== generation) return;
      accept(checked(result)); readFailed = false;
      status.textContent = pendingLabel();
    } catch {
      if (disposed || token !== generation) return;
      readFailed = true;
      showError('No se pudo leer la configuración. Reintenta la consulta; tus cambios se conservan.');
      status.textContent = '';
    } finally {
      if (!disposed && token === generation) { busy = false; sync(); }
    }
  }
  async function save(): Promise<void> {
    if (disposed || busy || permissions?.isBusy || !dialog.open) return;
    const editable = options.canEdit();
    if (editable && (!loaded || !current)) return;
    const value = Number(limit.value);
    if (editable && (!limit.value.trim() || !Number.isInteger(value) || value < 1 || value > Number(limit.max))) {
      showError(`Introduce un número entero entre 1 y ${limit.max}.`, true); limit.focus(); return;
    }
    const selectedTheme = themeValue(theme.value);
    const token = ++generation;
    busy = true; showError(''); status.textContent = 'Guardando configuración…'; sync();
    let saved: AppSettings | null = null;
    try {
      if (editable) {
        const result = await options.save(value, current?.schemaVersion === 2 ? pulsoToggle.checked : undefined);
        if (disposed || token !== generation) return;
        saved = checked(result);
        // A successful response is authoritative, including a changed server cap.
        limitDirty = false; pulsoDirty = false; accept(saved);
      }
      if (disposed || token !== generation) return;
      options.setTheme(selectedTheme);
      if (disposed || token !== generation) return;
      themeDirty = false;
      if (saved) options.onSaved(saved);
      if (disposed || token !== generation) return;
      status.textContent = editable ? 'Configuración guardada.' : 'Apariencia guardada.';
    } catch {
      if (disposed || token !== generation) return;
      showError(saved
        ? 'El límite se guardó, pero no se pudo completar la actualización de la interfaz. Reintenta guardar.'
        : 'No se pudo guardar la configuración. Tus cambios se conservan; reintenta guardar.');
      status.textContent = '';
    } finally {
      if (!disposed && token === generation) { busy = false; sync(); }
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
    if (disposed || busy || permissions?.isBusy || !dialog.open) return;
    permissions?.close(); ++intentionalCloses; dialog.close(); restoreFocus();
  }
  theme.addEventListener('change', () => { if (!busy) { themeDirty = true; status.textContent = pendingLabel(); sync(); } });
  limit.addEventListener('input', () => { if (!busy) { limitDirty = true; showError(''); status.textContent = pendingLabel(); sync(); } });
  pulsoToggle.addEventListener('change', () => { if (!busy) { pulsoDirty = true; status.textContent = pendingLabel(); sync(); } });
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });
  retry.addEventListener('click', () => { void read(); });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    // Let the browser finish Escape's focus steps before the close handler.
    // Closing synchronously inside cancel can lose restored focus in WebKit.
    if (busy || permissions?.isBusy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (intentionalCloses) { --intentionalCloses; return; }
    if (disposed || dialog.open) return;
    // A native close watcher can bypass cancel; preserve in-flight writes.
    if (busy || permissions?.isBusy) { dialog.showModal(); return; }
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
      if (!themeDirty) theme.value = themeValue(options.getTheme());
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

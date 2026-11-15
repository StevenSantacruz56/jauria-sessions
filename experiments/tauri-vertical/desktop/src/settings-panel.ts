import './settings-panel.css';
import { mountAgentPermissions, type PermissionsOptions, type PermissionsContext } from './agent-permissions';

export type AppSettings = {
  schemaVersion: number;
  maxConcurrentSessions: number;
  maxSupportedSessions: number;
  warning?: string | null;
};

type Options = {
  permissions?: PermissionsOptions;
  notificationControls?: HTMLElement;
  onOpenAttention?: () => void;
  hasAttention?: () => boolean;
  read: () => Promise<AppSettings>;
  save: (limit: number) => Promise<AppSettings>;
  getTheme: () => string;
  setTheme: (theme: string) => void;
  version: string;
  canEdit: () => boolean;
  onSaved: (settings: AppSettings) => void;
};

let instance = 0;
const themes = ['system', 'light', 'dark'];
const themeValue = (value: string) => themes.includes(value) ? value : 'system';

function checked(settings: AppSettings): AppSettings {
  if (!settings || !Number.isInteger(settings.schemaVersion) || settings.schemaVersion < 1
    || !Number.isInteger(settings.maxSupportedSessions) || settings.maxSupportedSessions < 1
    || !Number.isInteger(settings.maxConcurrentSessions) || settings.maxConcurrentSessions < 1
    || settings.maxConcurrentSessions > Math.min(8, settings.maxSupportedSessions)) {
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
  const title = node('h2', 'Configuración'); title.id = `${prefix}-title`; title.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', title.id);
  heading.append(title);
  const general = node('section', '', 'settings-dialog-section');
  const generalTitle = node('h3', 'General'); generalTitle.id = `${prefix}-general`;
  general.setAttribute('aria-labelledby', generalTitle.id);
  const appearance = node('div', '', 'settings-dialog-row');
  const themeLabel = node('label', 'Apariencia');
  const theme = node('select'); theme.id = `${prefix}-theme`; themeLabel.htmlFor = theme.id;
  for (const [value, label] of [['system', 'Sistema'], ['light', 'Clara'], ['dark', 'Oscura']]) {
    const option = node('option', label); option.value = value; theme.append(option);
  }
  appearance.append(themeLabel, theme);
  general.append(generalTitle, appearance);
  const sessions = node('section', '', 'settings-dialog-section');
  const sessionsTitle = node('h3', 'Sesiones'); sessionsTitle.id = `${prefix}-sessions`;
  sessions.setAttribute('aria-labelledby', sessionsTitle.id);
  const limitRow = node('div', '', 'settings-dialog-row');
  const limitLabel = node('label', 'Máximo de sesiones simultáneas');
  const limit = node('input'); limit.type = 'number'; limit.min = '1'; limit.max = '8'; limit.step = '1';
  limit.id = `${prefix}-limit`; limitLabel.htmlFor = limit.id;
  // No optimistic default: the runner supplies the actual persisted limit.
  limitRow.append(limitLabel, limit);
  const range = node('p', 'Consultando el límite del runner…', 'settings-dialog-help');
  range.id = `${prefix}-range`; limit.setAttribute('aria-describedby', range.id);
  const explanation = node('p', 'El límite incluye todos los proveedores combinados: Codex, Claude Code y Terminal. El valor predeterminado del runner es 2. Reducirlo no cierra las sesiones existentes. Los escritores simultáneos en el mismo worktree siguen bloqueados.', 'settings-dialog-help');
  const compatibility = node('p', 'Este runner no permite ajustar el límite. Puedes guardar la apariencia; para cambiar el máximo, actualiza el runner.', 'settings-dialog-help');
  compatibility.hidden = true;
  sessions.append(sessionsTitle, limitRow, range, explanation, compatibility);
  const info = node('section', '', 'settings-dialog-section');
  const infoTitle = node('h3', 'Información'); infoTitle.id = `${prefix}-info`;
  info.setAttribute('aria-labelledby', infoTitle.id);
  info.append(infoTitle,
    node('p', 'Los proveedores conservan sus permisos y confirmaciones nativos guardados. Jauría los respeta.', 'settings-dialog-help'),
    node('p', `Jauría ${options.version}`, 'settings-dialog-version'));
  const warning = node('p', '', 'settings-dialog-warning'); warning.setAttribute('role', 'status'); warning.hidden = true;
  const error = node('p', '', 'form-error'); error.id = `${prefix}-error`; error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = node('button', 'Reintentar consulta', 'secondary'); retry.type = 'button'; retry.hidden = true;
  const status = node('p', '', 'settings-dialog-status'); status.setAttribute('role', 'status');
  const footer = node('footer', '', 'dialog-footer');
  const closeButton = node('button', 'Cerrar', 'quiet'); closeButton.type = 'button';
  const saveButton = node('button', 'Guardar', 'primary'); saveButton.type = 'submit';
  footer.append(closeButton, saveButton);
  const permissionsHost = node('section', '', 'settings-dialog-section settings-permissions');
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
      close(); options.onOpenAttention?.();
    });
    notices.append(attention, attentionEmpty);
    refreshAttention = syncAttention;
  }
  form.append(heading, general, sessions);
  if (options.permissions) form.append(permissionsHost);
  if (options.notificationControls || options.onOpenAttention) form.append(notices);
  form.append(info, warning, error, retry, status, footer);
  dialog.append(form); document.body.append(dialog);

  let disposed = false, busy = false, loaded = false, readFailed = false;
  let limitDirty = false, themeDirty = false;
  let current: AppSettings | null = null;
  let opener: HTMLElement | null = null;
  let underlyingDialog: HTMLDialogElement | null = null;
  let generation = 0, intentionalCloses = 0;
  const permissions = options.permissions ? mountAgentPermissions(permissionsHost, options.permissions, sync) : null;

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
    closeButton.disabled = blocked;
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
      status.textContent = '';
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
        const result = await options.save(value);
        if (disposed || token !== generation) return;
        saved = checked(result);
        // A successful response is authoritative, including a changed server cap.
        limitDirty = false; accept(saved);
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
  theme.addEventListener('change', () => { if (!busy) { themeDirty = true; status.textContent = ''; } });
  limit.addEventListener('input', () => { if (!busy) { limitDirty = true; showError(''); status.textContent = ''; } });
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
      if (dialog.open) { if (section === 'permissions') permissions?.focus(); return; }
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      underlyingDialog = opener?.closest<HTMLDialogElement>('dialog[open]')
        ?? Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1) ?? null;
      if (!themeDirty) theme.value = themeValue(options.getTheme());
      dialog.showModal(); title.focus(); void read(); permissions?.open(context);
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

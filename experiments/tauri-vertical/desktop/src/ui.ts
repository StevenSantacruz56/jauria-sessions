import { appVersion } from './app-version';
// Workbench direction: native macOS conventions from the user's Conductor,
// Nimbalyst and Claude Squad references. Operate mode; real session data only.
export type IconName = 'rows' | 'bell' | 'layers' | 'plus' | 'search' | 'folder' | 'terminal' | 'spark' | 'split' | 'info' | 'sidebar' | 'close' | 'more' | 'stop' | 'interrupt' | 'chevron' | 'settings' | 'refresh' | 'copy' | 'clock' | 'arrow' | 'gauge';
const paths: Record<IconName, string> = {
  rows: '<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="5" cy="6" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="5" cy="18" r="1.6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  layers: '<path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  spark: '<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  interrupt: '<path d="M8 5v14M16 5v14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.3 8a7 7 0 0 1 11.8-3L20 8M4 16l2.9 3A7 7 0 0 0 18.7 16"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 3.5-4.5"/>',
};
export function icon(name: IconName) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export const shell = `
  <div class="workspace-shell">
    <button id="sidebar-scrim" class="sidebar-scrim" aria-label="Cerrar navegación" hidden></button>
    <aside id="sidebar" class="sidebar" aria-label="Proyectos y agentes">
      <div class="brand"><span class="brand-lockup"><img class="brand-logo brand-light" src="/brand/jauria-logo-horizontal-transparente.svg" alt="Jauría"><img class="brand-logo brand-dark" src="/brand/jauria-logo-horizontal-oscuro.svg" alt="Jauría"></span><span class="brand-actions"><button id="toggle-search" class="icon-button" aria-label="Buscar sesiones" aria-keyshortcuts="Meta+K" aria-expanded="false" aria-controls="session-search-field" title="Buscar sesiones (⌘K)">${icon('search')}</button><button id="new-session" class="icon-button" aria-label="Nueva sesión" aria-keyshortcuts="Meta+N" title="Nueva sesión (⌘N)">${icon('plus')}</button></span></div>
      <label id="session-search-field" class="search-field" hidden>${icon('search')}<input id="session-search" type="search" placeholder="Buscar sesiones" aria-label="Buscar sesiones"><kbd>⌘K</kbd></label>
      <div id="sidebar-regions" class="sidebar-regions">
      <section id="sidebar-projects" class="sidebar-section sidebar-projects" aria-labelledby="sidebar-projects-heading" data-collapsed="false"><div class="sidebar-section-heading"><h2 id="sidebar-projects-heading"><button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="sidebar-project-list" title="Plegar o desplegar Proyectos">${icon('chevron')}<span>Proyectos</span></button></h2><span class="sidebar-section-tools"><span id="projects-count" class="sidebar-section-count"></span><button id="open-pulso" class="icon-button" aria-label="Abrir Pulso" aria-pressed="false" title="Abrir Pulso">${icon('layers')}</button></span></div><nav id="sidebar-project-list" class="sidebar-project-list" aria-label="Tableros de Pulso"></nav></section>
      <div id="sidebar-split" class="sidebar-split" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="sidebar-projects" aria-label="Reparto entre Proyectos y Agentes" aria-valuemin="15" aria-valuemax="85" aria-valuenow="34" aria-valuetext="Proyectos ocupa hasta el 34 % de la barra lateral" title="Arrastra para repartir el espacio entre Proyectos y Agentes. Doble clic o Intro: reparto inicial."></div>
      <section id="sidebar-agents" class="sidebar-section sidebar-agents" aria-labelledby="sidebar-agents-heading" data-collapsed="false">
        <div class="sidebar-section-heading"><h2 id="sidebar-agents-heading"><button type="button" class="sidebar-section-toggle" aria-expanded="true" aria-controls="sidebar-agents-body" title="Plegar o desplegar Agentes">${icon('chevron')}<span>Agentes</span></button></h2><span class="sidebar-section-tools"><span id="capacity" class="capacity">Límite según el runner</span><button id="agent-grouping" class="icon-button" data-grouping="" aria-label="Agrupar por estado" aria-pressed="false" title="Agrupados por proyecto. Pulsa para agrupar por estado.">${icon('folder')}</button></span></div>
        <div id="sidebar-agents-body" class="sidebar-agents-body">
        <div class="agent-controls"><div class="session-filters" role="group" aria-label="Filtrar sesiones"><button data-filter="open" aria-pressed="true">Abiertas <span id="open-count">0</span></button><button data-filter="closed" aria-pressed="false">Historial <span id="closed-count">0</span></button></div></div>
        <button id="attention-filter" class="attention-filter quiet" data-filter="attention" aria-pressed="false" hidden><span class="state-dot"></span><span id="attention-count">Requieren atención</span>${icon('chevron')}</button>
        <div class="workspace-navigation"><nav id="session-list" class="session-list" aria-label="Agentes por proyecto"></nav></div>
        </div>
      </section>
      </div>
      <div class="sidebar-footer"><button id="open-telemetry" type="button" class="sidebar-row" aria-haspopup="dialog" title="Cuotas de Claude Code y Codex, y lo que usa Jauría en este Mac">${icon('gauge')}<span class="sidebar-row-name">Uso y recursos</span></button><button id="open-settings" class="sidebar-row" aria-keyshortcuts="Meta+,">${icon('settings')}<span class="sidebar-row-name">Configuración</span><kbd>⌘,</kbd></button></div>
      <div id="sidebar-width-handle" class="sidebar-width-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="sidebar" aria-label="Ancho de la barra lateral" aria-valuemin="220" aria-valuemax="420" aria-valuenow="264" aria-valuetext="264 px" title="Arrastra para cambiar el ancho. Doble clic o Intro: 264 px."></div>
    </aside>
    <main id="workbench" class="workbench">
      <header class="workbench-header top-bar">
        <button id="toggle-sidebar" class="icon-button" aria-label="Mostrar navegación" aria-expanded="false">${icon('sidebar')}</button>
        <div class="workbench-heading sr-only"><p id="workspace-breadcrumb">Tu espacio de trabajo</p><h1 id="workspace-title">Sesiones</h1></div>
        <button id="pulso-back-terminal" class="quiet top-back" hidden title="Volver a la vista de terminal">${icon('terminal')}<span>Terminal</span></button>
        <nav id="session-tabs" class="top-tabs" aria-label="Sesiones abiertas"></nav>
        <button id="tab-new-session" class="icon-button top-add" aria-label="Nueva sesión" aria-keyshortcuts="Meta+N" title="Nueva sesión (⌘N)">${icon('plus')}</button>
        <div id="pulso-tabs-host" class="top-pulso-tabs" hidden></div>
        <span class="top-spacer"></span>
        <div class="workbench-actions"><button id="open-command-palette" class="quiet palette-trigger" aria-label="Paleta de comandos" aria-haspopup="dialog" aria-expanded="false" title="Paleta de comandos">${icon('search')}<kbd id="open-command-palette-hint" aria-hidden="true"></kbd></button><button id="toggle-split" class="quiet" aria-pressed="false" title="Mostrar dos sesiones">${icon('split')}<span>Dividir</span></button><button id="session-alerts" class="icon-button" aria-label="Avisos" hidden>${icon('bell')}<span class="sr-only">Avisos</span><span id="session-alerts-count" class="session-alerts-count" aria-hidden="true" hidden></span></button></div>
        <section id="attention-banner" class="alerts-popover" role="dialog" aria-label="Avisos de sesiones" hidden><div class="alerts-popover-head"><h2>Avisos</h2><p id="attention-summary"></p></div><ul id="attention-list" class="alerts-list" aria-label="Sesiones con avisos"></ul><div class="alerts-popover-actions"><button id="attention-show-list" class="quiet">Ver en la lista</button><button id="see-attention" class="quiet" title="No cambia el estado de la sesión ni responde permisos">Marcar vistos</button><button id="open-attention-session" class="secondary">Abrir sesión</button></div></section>
        <p id="attention-announcer" class="sr-only" role="status" aria-live="polite"></p><p id="app-announcer" class="sr-only" role="status" aria-live="polite"></p>
      </header>
      <div id="workspace-body" class="workspace-body">
        <section id="stage" class="stage" aria-label="Área de trabajo">
          <section id="pulso-panel-host" class="pulso-panel-host" aria-label="Pulso" hidden></section>
          <section id="history-view" class="history-view" aria-labelledby="history-title" hidden>
            <header class="history-head"><span id="history-provider" class="provider-badge" aria-hidden="true">$</span><h2 id="history-title" class="history-title">Historial</h2><span id="history-folder" class="history-folder"></span><span id="history-state" class="history-state"></span></header>
            <div class="history-actions" role="toolbar" aria-label="Acciones del historial">
              <button id="history-back" type="button" class="quiet" title="Vuelve a los paneles de trabajo (Escape)">${icon('terminal')}<span>Volver a las sesiones</span></button>
              <span class="history-actions-spacer"></span>
              <label class="history-search search-field">${icon('search')}<input id="history-search" type="search" placeholder="Buscar en la salida" aria-label="Buscar en la salida" aria-describedby="history-search-count" autocomplete="off" spellcheck="false"></label><span id="history-search-count" class="history-search-count" role="status" aria-live="polite"></span>
              <button id="history-copy" type="button" class="quiet" title="Copia toda la salida guardada al portapapeles">${icon('copy')}<span>Copiar salida</span></button>
              <button id="history-new" type="button" class="secondary" title="Abre el diálogo Nueva sesión con esta carpeta">Nueva sesión en esta carpeta</button>
              <button id="history-continue" type="button" class="secondary" hidden>Continuar conversación</button>
              <details id="history-menu" class="pane-menu history-menu"><summary aria-label="Más acciones del historial" title="Más acciones del historial">${icon('more')}</summary><div class="pane-menu-content"><button id="history-purge" type="button">Borrar salida guardada…</button><button id="history-compact" type="button">Compactar eventos…</button></div></details>
            </div>
            <p id="history-trimmed" class="history-trimmed" role="note" hidden></p>
            <div id="history-terminal" class="history-terminal" aria-label="Salida guardada, solo lectura"></div>
          </section>
          <section id="welcome" class="welcome"><div class="welcome-symbol"><img class="welcome-mascot" src="/brand/jauria-mascota-simbolo.svg" alt="" width="88" height="77"></div><h2>Tu próxima sesión empieza aquí.</h2><p>Elige una carpeta y abre Codex, Claude Code o una terminal.<br>Vuelve a tus sesiones cuando lo necesites.</p><button id="welcome-create" class="primary">${icon('plus')}Nueva sesión</button><div class="provider-availability"><span id="welcome-codex">Codex · comprobando CLI</span><span id="welcome-claude">Claude Code · comprobando CLI</span></div><div id="close-window-hint" class="welcome-note">${icon('info')}Cerrar la ventana no detiene las sesiones: siguen en marcha hasta que uses Terminar sesión en el menú «…» del panel.</div></section>
          <section id="panes" class="terminal-panes" aria-label="Sesiones abiertas" hidden></section>
        </section>
        <div id="notice" class="notice" hidden><span class="notice-symbol">${icon('info')}</span><p id="notice-text" role="status" aria-live="polite" tabindex="0"></p><button id="dismiss-notice" class="icon-button" aria-label="Cerrar aviso">${icon('close')}</button></div>
      </div>
      <footer class="workbench-footer status-bar" aria-label="Estado">
        <button id="status-needs" type="button" class="status-item status-needs" hidden><span class="agent-indicator" data-shape="halo" data-tone="attention" aria-hidden="true"></span><span id="status-needs-text"></span></button>
        <span id="status-finished" class="status-item status-finished" hidden><span class="agent-indicator" data-shape="check" data-tone="ready" aria-hidden="true"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3 5 8.7l4.5-5.2"/></svg></span><span id="status-finished-text"></span></span>
        <span id="status-working" class="status-item status-working" hidden><span class="agent-indicator" data-shape="spinner" data-tone="working" aria-hidden="true"></span><span id="status-working-text"></span></span>
        <span id="status-quiet" class="status-item status-quiet">Sin avisos</span>
        <span class="status-spacer"></span>
        <span class="status-item status-connection"><span id="connection-dot" class="state-dot"></span><span id="connection-state" role="status">Conectando…</span><button id="connect" class="icon-button" aria-label="Reconectar" title="Reconectar">${icon('refresh')}</button></span>
        <span id="terminal-size" class="status-item terminal-size" title="Columnas × filas del terminal del panel enfocado">—</span>
        <button id="telemetry-summary" type="button" class="status-item" aria-haspopup="dialog" title="Total de Jauría: sesiones abiertas, runner e interfaz. Pulsa para ver el detalle en Uso y recursos.">Jauría · CPU — · RAM —</button>
      </footer>
    </main>
  </div>
  <div id="settings-templates" hidden>
    <div id="settings-notifications" class="settings-notifications"><div class="settings-dialog-row"><div class="settings-row-copy"><span class="settings-row-label">Avisos de macOS</span><p id="native-notification-status" class="settings-row-help settings-wrap" role="status">Desactivados. Se piden cada vez que abres Jauría.</p></div><button id="enable-native-notifications" type="button" class="secondary">Activar avisos de macOS…</button></div><p class="settings-dialog-help">Solo mientras Jauría está abierta y sin sonido. El aviso no incluye nombres, rutas ni texto del terminal, y un clic en él no abre la sesión. macOS no le dice a Jauría si los muestra: si no los ves, revisa Ajustes del Sistema → Notificaciones → Jauría.</p></div>
    <div id="settings-about-controls" class="settings-about-controls">
      <p id="runner-state" class="settings-dialog-help">Servicio de sesiones (runner): sin consultar</p>
      <p id="runner-upgrade" class="settings-dialog-warning" hidden></p>
      <div class="settings-dialog-row"><div class="settings-row-copy"><span class="settings-row-label">Reiniciar el servicio de sesiones</span><p class="settings-row-help settings-wrap">Termina todas las sesiones abiertas de este perfil y lo vuelve a arrancar con esta versión de Jauría. Archivos e historial se conservan. Úsalo solo sin trabajo en curso; macOS pide confirmación.</p></div><button id="restart-runner" type="button" class="secondary">Reiniciar runner…</button></div>
      <div class="settings-dialog-row"><div class="settings-row-copy"><span class="settings-row-label">Claude Code y Codex</span><p id="tools" class="settings-row-help settings-wrap">Sin comprobar.</p></div><button id="probe" type="button" class="secondary">Comprobar</button></div>
      <div class="settings-dialog-row"><div class="settings-row-copy"><span class="settings-row-label">Diagnóstico</span><p class="settings-row-help settings-wrap">Resumen técnico para pedir ayuda: versiones y recuentos, sin texto de terminales, rutas, notas ni credenciales. Revísalo antes de guardarlo.</p></div><button id="preview-diagnostic" type="button" class="secondary">Previsualizar diagnóstico</button></div>
      <pre id="diagnostic-preview" class="settings-diagnostic-preview" hidden></pre>
      <div class="settings-diagnostic-actions"><button id="export-diagnostic" type="button" class="secondary" disabled>Guardar diagnóstico…</button><p id="diagnostic-export-state" class="settings-dialog-help" role="status"></p></div>
      <p id="storage-usage" class="settings-dialog-help"></p>
    </div>
  </div>
  <dialog id="new-session-dialog" class="session-dialog new-session-dialog" aria-labelledby="new-session-title" aria-describedby="new-session-subtitle"><form id="new-session-form" novalidate><header class="dialog-heading"><div><h2 id="new-session-title">Nueva sesión</h2><p id="new-session-subtitle">Elige una herramienta y una carpeta para empezar.</p></div><button id="cancel-session-x" type="button" class="icon-button" aria-label="Cerrar">${icon('close')}</button></header><fieldset class="provider-picker"><legend>Herramienta</legend><label><input type="radio" name="provider" value="codex" checked><span class="provider-option"><span class="provider-badge" data-provider="codex" aria-hidden="true"></span><strong>Codex</strong><small id="new-codex-status">Comprobando…</small></span></label><label><input type="radio" name="provider" value="claude"><span class="provider-option"><span class="provider-badge" data-provider="claude" aria-hidden="true"></span><strong>Claude Code</strong><small id="new-claude-status">Comprobando…</small></span></label><label><input type="radio" name="provider" value="terminal"><span class="provider-option"><span class="provider-badge" data-provider="terminal" aria-hidden="true"></span><strong>Terminal</strong><small id="new-terminal-status">Shell zsh</small></span></label></fieldset><div id="provider-help" class="field-help" hidden><span id="provider-help-text"></span><button id="recheck-tools" type="button" class="secondary">Comprobar otra vez</button></div><div class="form-field"><label for="session-folder">Carpeta de trabajo</label><div class="folder-row"><select id="session-folder"></select><button id="choose-directory" type="button" class="secondary">${icon('folder')}<span>Elegir otra carpeta…</span></button></div><p id="folder-error" class="field-error" hidden></p></div><div class="form-field" id="session-project-field" hidden><label for="session-project">Proyecto de Pulso <span>(opcional)</span></label><select id="session-project"><option value="">Sin proyecto</option></select><p id="session-project-locked" class="field-locked" hidden></p></div><div class="form-field"><label for="session-title">Nombre de la sesión <span>(opcional)</span></label><input id="session-title" maxlength="120" placeholder="Por ejemplo, planear el lanzamiento" autocomplete="off"></div><p id="session-conflict" class="field-warning" hidden>Ya hay otra sesión de Claude Code en esta carpeta. Ambas podrían modificar los mismos archivos.</p><p id="new-session-error" class="form-error" role="alert" hidden></p><div id="session-link-retry" class="form-error link-retry" role="alert" hidden><span id="session-link-retry-text"></span><button id="retry-session-link" type="button" class="secondary">Reintentar vínculo</button><button id="close-session-link" type="button" class="secondary">Cerrar</button></div><footer class="dialog-footer new-session-footer"><p id="session-capacity" class="session-capacity"></p><p id="start-blocked" class="start-blocked" hidden><span id="start-blocked-text"></span><button id="reconnect-from-dialog" type="button" class="secondary" hidden>Reconectar</button></p><div class="dialog-actions"><button id="cancel-session" type="button" class="secondary">Cancelar</button><button id="start-session" class="primary" type="submit">Abrir sesión</button></div></footer></form></dialog>
  <dialog id="rename-session-dialog" class="session-dialog" aria-labelledby="rename-session-title"><form id="rename-session-form" novalidate><header class="dialog-heading"><h2 id="rename-session-title">Cambiar nombre</h2></header><div class="form-field"><label for="rename-session-input">Nombre de la sesión</label><input id="rename-session-input" autocomplete="off" aria-describedby="rename-session-help"><p id="rename-session-help">Hasta 120 caracteres Unicode y 480 bytes. No cambia el proveedor ni envía comandos.</p></div><p id="rename-session-error" class="form-error" role="alert" hidden></p><footer class="dialog-footer"><button id="cancel-rename" type="button" class="quiet">Cerrar</button><button id="save-rename" type="submit" class="primary">Guardar nombre</button></footer></form></dialog>
  <dialog id="stop-session-dialog" class="session-dialog stop-dialog" aria-labelledby="stop-session-title" aria-describedby="stop-session-description stop-session-effects"><div class="dialog-heading"><div><h2 id="stop-session-title">¿Terminar esta sesión?</h2><p id="stop-session-description"></p></div></div><div id="stop-session-effects"><p><strong>Terminar sesión</strong> detiene el proceso del proveedor. El historial y los archivos se conservan; los cambios no se revierten.</p><p><strong>Cancelar (Ctrl-C)</strong> cancela lo que está haciendo; la sesión sigue abierta.</p><p>Cerrar la ventana deja la sesión en ejecución.</p></div><footer class="dialog-footer"><button id="cancel-stop" class="quiet" autofocus>Cancelar</button><button id="confirm-stop" class="danger-button">Terminar sesión</button></footer></dialog>
`;

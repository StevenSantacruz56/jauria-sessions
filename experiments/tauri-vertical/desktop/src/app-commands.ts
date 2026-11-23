import { shortcutAria, shortcutHint, type AppCommand } from './shortcuts';
import { projectSessionIndex, sortAgents, type AgentProject, type AgentProjectLink } from './agent-list';
import { projectProgressLabel } from './sidebar-projects';
import { providerLabel } from './workspace';
import type { PaletteItem } from './command-palette';
import type { ActivityKind } from './session-activity';

/**
 * The workbench commands, in palette order. Each one calls a function main.ts
 * already uses for its button or menu; availability mirrors that control's
 * disabled state and says why. Terminar, Interrumpir and Cambiar nombre never
 * act directly: they open the confirmation dialog, focus the pane's existing
 * Interrumpir control, or open the rename form. No command sends or pastes
 * text into a terminal, and none grants Pulso access.
 */
export type Theme = 'system' | 'light' | 'dark';
export type FocusedSession = { id: string; title: string; live: boolean; stopping: boolean; structured: boolean };
export type AppCommandContext = {
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  replaying: boolean;
  occupied: number;
  limit: number;
  sessionCount: number;
  split: boolean;
  planning: boolean;
  /** null when Pulso can be opened; otherwise why not. */
  pulsoUnavailable: string | null;
  /** Why Pulso cannot change board, open a phase or create a project now (a draft, a failed save or a save in flight), as its own controls show. */
  pulsoDraft: string | null;
  inspectorOpen: boolean;
  unseenAlerts: number;
  needsTarget: { id: string; title: string } | null;
  grouping: 'project' | 'state';
  filter: 'open' | 'closed' | 'other';
  theme: Theme;
  renameSupported: boolean;
  focused: FocusedSession | null;
  actions: {
    togglePalette(): void;
    newSession(): void;
    searchSessions(): void;
    toggleSplit(): void;
    focusOtherPane(): void;
    showPulso(): void;
    leavePulso(): void;
    newProject(): void;
    openSettings(): void;
    toggleInspector(): void;
    markAlertsSeen(): void;
    openSession(id: string): void;
    toggleGrouping(): void;
    showFilter(filter: 'open' | 'closed'): void;
    setTheme(theme: Theme): void;
    rename(id: string): void;
    interrupt(id: string): void;
    stop(id: string): void;
  };
};

const themeLabels: Record<Theme, string> = { system: 'Sistema', light: 'Clara', dark: 'Oscura' };

/** Same rule as the «Nueva sesión» buttons (sidebar, top bar, welcome). */
export function newSessionUnavailable(c: Pick<AppCommandContext, 'connected' | 'busy' | 'replaying' | 'occupied' | 'limit'>): string | null {
  if (!c.connected) return 'Sin conexión con el runner';
  if (c.replaying) return 'Recuperando el historial';
  if (c.busy) return 'Hay una operación en curso';
  if (c.occupied >= c.limit) return `Sin plazas libres (${c.occupied} de ${c.limit})`;
  return null;
}

/** Shared by the controls that act on the focused pane's session (pane heading and menu). */
function sessionControl(c: AppCommandContext, needsLive: boolean): string | null {
  if (!c.focused) return 'No hay sesión en el panel enfocado';
  if (!c.connected || c.connecting) return 'Sin conexión con el runner';
  if (c.replaying) return 'Recuperando el historial';
  if (c.busy) return 'Hay una operación en curso';
  if (needsLive && !c.focused.live) return 'La sesión ya no está activa';
  if (needsLive && c.focused.stopping) return 'La sesión se está terminando';
  return null;
}

export function appCommands(c: AppCommandContext): AppCommand[] {
  const a = c.actions;
  const focused = c.focused;
  const theme = (value: Theme): AppCommand => ({
    id: `theme-${value}`, label: `Apariencia: ${themeLabels[value]}`, keywords: 'tema modo claro oscuro sistema color',
    unavailable: () => c.theme === value ? 'Es la apariencia actual' : null, run: () => a.setTheme(value),
  });
  return [
    { id: 'command-palette', label: 'Paleta de comandos', shortcut: 'command-palette', palette: false, unavailable: () => null, run: a.togglePalette },
    { id: 'new-session', label: 'Nueva sesión…', keywords: 'abrir crear codex claude terminal', shortcut: 'new-session', confirmation: 'dialog',
      unavailable: () => newSessionUnavailable(c), run: a.newSession },
    { id: 'open-needs', label: c.needsTarget ? `Abrir la sesión que más te necesita: ${c.needsTarget.title}` : 'Abrir la sesión que más te necesita', keywords: 'aviso atención prioridad',
      unavailable: () => c.needsTarget ? null : 'Ninguna sesión te necesita', run: () => { if (c.needsTarget) a.openSession(c.needsTarget.id); } },
    { id: 'mark-seen', label: 'Marcar avisos como vistos', keywords: 'avisos campana leídos',
      unavailable: () => c.unseenAlerts > 0 ? null : 'No hay avisos sin ver', run: a.markAlertsSeen },
    { id: 'split', label: c.split ? 'Unificar en un panel' : 'Dividir el panel', keywords: 'dos paneles vista',
      unavailable: () => c.planning ? 'Disponible en la vista de terminal' : c.sessionCount < 2 ? 'Necesitas al menos dos sesiones' : null, run: a.toggleSplit },
    { id: 'focus-other-pane', label: 'Enfocar el otro panel', keywords: 'cambiar panel',
      unavailable: () => c.planning ? 'Disponible en la vista de terminal' : !c.split ? 'Solo con el panel dividido' : null, run: a.focusOtherPane },
    { id: 'pulso', label: c.planning ? 'Volver a la terminal' : 'Ir a Pulso', keywords: 'tablero planificación terminal',
      unavailable: () => c.planning ? c.pulsoDraft : c.pulsoUnavailable, run: () => c.planning ? a.leavePulso() : a.showPulso() },
    { id: 'new-project', label: 'Nuevo proyecto de Pulso…', keywords: 'crear tablero', confirmation: 'dialog',
      unavailable: () => c.pulsoUnavailable ?? c.pulsoDraft, run: a.newProject },
    { id: 'search-sessions', label: 'Buscar en la lista de agentes', keywords: 'filtrar barra lateral', shortcut: 'search-sessions',
      unavailable: () => null, run: a.searchSessions },
    { id: 'grouping', label: c.grouping === 'state' ? 'Agrupar agentes por proyecto' : 'Agrupar agentes por estado', keywords: 'agentes lista orden',
      unavailable: () => null, run: a.toggleGrouping },
    { id: 'filter-open', label: 'Mostrar sesiones abiertas', keywords: 'abiertas lista agentes',
      unavailable: () => c.filter === 'open' ? 'Ya se muestran las abiertas' : null, run: () => a.showFilter('open') },
    { id: 'filter-closed', label: 'Mostrar historial de sesiones', keywords: 'historial cerradas lista',
      unavailable: () => c.filter === 'closed' ? 'Ya se muestra el historial' : null, run: () => a.showFilter('closed') },
    { id: 'inspector', label: c.inspectorOpen ? 'Ocultar Información' : 'Mostrar Información', keywords: 'inspector detalles diagnóstico', shortcut: 'inspector',
      unavailable: () => null, run: a.toggleInspector },
    { id: 'settings', label: 'Abrir Configuración', keywords: 'ajustes preferencias límite plazas permisos', shortcut: 'settings', confirmation: 'dialog',
      unavailable: () => null, run: a.openSettings },
    theme('system'), theme('light'), theme('dark'),
    { id: 'rename', label: focused ? `Cambiar nombre de ${focused.title}…` : 'Cambiar nombre de la sesión…', keywords: 'renombrar título', confirmation: 'dialog',
      unavailable: () => !c.renameSupported ? 'El runner no permite cambiar nombres' : sessionControl(c, false), run: () => { if (focused) a.rename(focused.id); } },
    { id: 'interrupt', label: focused ? `Interrumpir ${focused.title} (Ctrl-C)…` : 'Interrumpir la sesión (Ctrl-C)…', keywords: 'ctrl-c cancelar parar', confirmation: 'control',
      unavailable: () => focused?.structured ? 'Las conversaciones de Codex se detienen desde su panel' : sessionControl(c, true), run: () => { if (focused) a.interrupt(focused.id); } },
    { id: 'stop', label: focused ? `Terminar ${focused.title}…` : 'Terminar la sesión…', keywords: 'detener cerrar matar proceso', confirmation: 'dialog',
      unavailable: () => sessionControl(c, true), run: () => { if (focused) a.stop(focused.id); } },
  ];
}

export type PaletteSession = { id: string; title: string; kind: string; cwd: string | null; live: boolean };
export type PaletteSources = {
  sessions: readonly PaletteSession[];
  activityOf: (id: string) => { kind: ActivityKind; label: string };
  /** The sidebar's Pulso summary, already loaded: no read happens here. */
  projects: readonly (AgentProject & { done: number | null; total: number | null })[];
  links: readonly AgentProjectLink[];
  pendingOpen: number | null;
  hasMoreProjects: boolean;
  /** null when Pulso can be opened; otherwise why boards are disabled. */
  pulsoBlocked: string | null;
  /** Draft guard of the board (see AppCommandContext.pulsoDraft); boards and phases show it. */
  pulsoDraft?: string | null;
  commands: readonly AppCommand[];
  mac: boolean;
  openSession: (id: string) => void;
  openBoard: (projectId: string | null) => void;
  openPulso: () => void;
  /** Phases of the Pulso board already loaded (none until one is open): no read happens here. */
  phases?: { board: string; phases: readonly { id: string; title: string; statusLabel: string }[] } | null;
  openPhase?: (id: string) => void;
};

/**
 * Palette entries. Te necesitan: sessions whose activity is «needs» or «notice»
 * (open or not), in the sidebar's priority. Sesiones: the other open sessions
 * with their state and Pulso project (else their folder). Proyectos: the
 * boards of the sidebar summary, Pendientes and «Más proyectos…». Fases: the
 * phases of the project board already loaded in Pulso. Acciones:
 * the registry, with the shortcut hint and the unavailability reason.
 */
export function paletteEntries(src: PaletteSources): PaletteItem[] {
  const navigation = src.pulsoBlocked ?? src.pulsoDraft ?? null;
  const projectOf = projectSessionIndex(src.projects, src.links);
  const projectTitle = new Map(src.projects.map(project => [project.id, project.title]));
  const items: PaletteItem[] = [];
  for (const s of sortAgents(src.sessions, id => src.activityOf(id).kind)) {
    const activity = src.activityOf(s.id);
    const needs = activity.kind === 'needs' || activity.kind === 'notice';
    if (!needs && !s.live) continue;
    const place = projectTitle.get(projectOf.get(s.id) ?? '') ?? s.cwd?.split('/').filter(Boolean).pop() ?? providerLabel(s.kind);
    items.push({ id: `session:${s.id}`, group: needs ? 'needs' : 'sessions', label: s.title, detail: needs ? `${activity.label} · ${place}` : place,
      keywords: `${providerLabel(s.kind)} ${s.cwd ?? ''} ${activity.label}`, activity: { kind: activity.kind, label: activity.label }, provider: s.kind,
      run: () => src.openSession(s.id) });
  }
  for (const project of src.projects) {
    const progress = projectProgressLabel(project);
    items.push({ id: `board:${project.id}`, group: 'projects', label: project.title, detail: progress ? `${progress} hechas` : 'Tablero de Pulso',
      initial: Array.from(project.title.trim())[0]?.toLocaleUpperCase() ?? '·', keywords: 'pulso tablero proyecto', disabledReason: navigation, run: () => src.openBoard(project.id) });
  }
  items.push({ id: 'board:', group: 'projects', label: 'Pendientes', detail: src.pendingOpen === null ? 'Tablero de Pulso' : `${src.pendingOpen} sin terminar`,
    initial: '·', keywords: 'pulso tablero tareas sueltas', disabledReason: navigation, run: () => src.openBoard(null) });
  if (src.hasMoreProjects) items.push({ id: 'board-more', group: 'projects', label: 'Más proyectos…', detail: 'Abrir Pulso', keywords: 'pulso', disabledReason: src.pulsoBlocked, run: src.openPulso });
  if (src.phases && src.openPhase) for (const phase of src.phases.phases) {
    const open = src.openPhase;
    items.push({ id: `phase:${phase.id}`, group: 'phases', label: phase.title, detail: `${phase.statusLabel} · ${src.phases.board}`,
      keywords: 'pulso fase tarjeta', disabledReason: navigation, run: () => open(phase.id) });
  }
  for (const command of src.commands) {
    if (command.palette === false) continue;
    items.push({ id: `action:${command.id}`, group: 'actions', label: command.label, keywords: command.keywords, disabledReason: command.unavailable(),
      hint: command.shortcut ? shortcutHint(command.shortcut, src.mac) : undefined, keyshortcuts: command.shortcut ? shortcutAria(command.shortcut, src.mac) : undefined, run: command.run });
  }
  return items;
}

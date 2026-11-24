/**
 * Sidebar layout preferences: how much of the sidebar Proyectos may take, the
 * sidebar width and which sections are folded. View metadata only, stored per
 * profile in the same local storage as the other view preferences (agent
 * grouping, last Pulso board). Every field is validated on read: a missing,
 * corrupt or out-of-range value falls back to its default on its own.
 */
export type SidebarLayout = { projectsShare: number; width: number; projectsCollapsed: boolean; agentsCollapsed: boolean };

export const sidebarWidth = { min: 220, max: 420, default: 264, step: 8 } as const;
/** Share of the regions' height that Proyectos may take (it never grows past its content). */
export const projectsShare = { min: 15, max: 85, default: 34, step: 5 } as const;
/** Section heading (30 px) + two 30 px rows + the list padding: Proyectos never gets less while open. */
export const projectsMinHeight = 98;
/** Heading, Abiertas/Historial and two rows: Agentes never gets less while open. */
export const agentsMinHeight = 156;
/** The width handle is hidden and the drawer keeps 264 px at or below this window width. */
export const sidebarOverlayBelow = 860;
/** Room the workbench keeps next to the sidebar when the window is narrow. */
export const workbenchMinWidth = 440;

export const defaultSidebarLayout: SidebarLayout = { projectsShare: projectsShare.default, width: sidebarWidth.default, projectsCollapsed: false, agentsCollapsed: false };

export function sidebarLayoutKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria:sidebar-layout:${profile}` : null;
}
const integerIn = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

export function validSidebarLayout(value: unknown): SidebarLayout {
  const raw = value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 1 ? value as Record<string, unknown> : {};
  const layout: SidebarLayout = {
    projectsShare: integerIn(raw.projectsShare, projectsShare.min, projectsShare.max) ? raw.projectsShare : projectsShare.default,
    width: integerIn(raw.width, sidebarWidth.min, sidebarWidth.max) ? raw.width : sidebarWidth.default,
    projectsCollapsed: raw.projectsCollapsed === true,
    agentsCollapsed: raw.agentsCollapsed === true,
  };
  // Both folded leaves an empty sidebar: keep Agentes open.
  if (layout.projectsCollapsed && layout.agentsCollapsed) layout.agentsCollapsed = false;
  return layout;
}
export function readSidebarLayout(storage: Pick<Storage, 'getItem'>, profile: string | null): SidebarLayout {
  const key = sidebarLayoutKey(profile); if (!key) return { ...defaultSidebarLayout };
  try { return validSidebarLayout(JSON.parse(storage.getItem(key) ?? 'null')); } catch { return { ...defaultSidebarLayout }; }
}
export function saveSidebarLayout(storage: Pick<Storage, 'setItem' | 'removeItem'>, profile: string | null, layout: SidebarLayout): void {
  const key = sidebarLayoutKey(profile); if (!key) return;
  const valid = validSidebarLayout({ schemaVersion: 1, ...layout });
  try {
    if (sameLayout(valid, defaultSidebarLayout)) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ schemaVersion: 1, ...valid }));
  } catch { /* Optional view preference. */ }
}
export function sameLayout(a: SidebarLayout, b: SidebarLayout): boolean {
  return a.projectsShare === b.projectsShare && a.width === b.width && a.projectsCollapsed === b.projectsCollapsed && a.agentsCollapsed === b.agentsCollapsed;
}

/** Widest sidebar the window allows: the workbench keeps at least 440 px. */
export function maxSidebarWidth(windowWidth: number): number {
  return Math.max(sidebarWidth.min, Math.min(sidebarWidth.max, Math.floor(windowWidth - workbenchMinWidth)));
}
/** Width actually applied: the preference, clamped to the window. */
export function effectiveSidebarWidth(width: number, windowWidth: number): number {
  return Math.min(Math.max(width, sidebarWidth.min), maxSidebarWidth(windowWidth));
}
export function clampWidth(width: number): number {
  return Math.round(Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, width)));
}
export function clampShare(share: number): number {
  return Math.round(Math.min(projectsShare.max, Math.max(projectsShare.min, share)));
}

/**
 * Most height Proyectos may take inside the regions (the area between the
 * search field and the footer): its share, but never below its own minimum
 * nor so much that Agentes falls below its minimum. Folding one section gives
 * the other all the room.
 */
export function projectsMaxHeight(available: number, layout: SidebarLayout, separator = 8, agentsHeading = 30): number {
  if (layout.projectsCollapsed) return 0;
  if (layout.agentsCollapsed) return Math.max(0, available - agentsHeading);
  const room = Math.max(0, available - separator);
  const wanted = Math.round(room * layout.projectsShare / 100);
  const ceiling = Math.max(projectsMinHeight, room - agentsMinHeight);
  return Math.max(Math.min(wanted, ceiling), Math.min(projectsMinHeight, room));
}

/** Arrow, Home/End and Enter handling shared by both separators; null when the key is not theirs. */
export function separatorKey(key: string, value: number, range: { min: number; max: number; default: number; step: number }, increase: string[], decrease: string[]): number | null {
  if (increase.includes(key)) return Math.min(range.max, value + range.step);
  if (decrease.includes(key)) return Math.max(range.min, value - range.step);
  if (key === 'Home') return range.min;
  if (key === 'End') return range.max;
  if (key === 'Enter') return range.default;
  return null;
}

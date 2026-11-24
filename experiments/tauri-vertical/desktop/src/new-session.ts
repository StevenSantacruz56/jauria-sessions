/**
 * «Nueva sesión» (1.4.0): pure rules for the dialog — capacity line, why
 * «Abrir sesión» is blocked, recent folders per profile and the Claude Code
 * same-folder warning. main.ts owns the DOM and the runner calls.
 */
export type ToolState = 'available' | 'missing' | 'unknown' | 'checking';
export type Provider = 'codex' | 'claude' | 'terminal';
export const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude Code', terminal: 'Terminal' };

/** «3 de 8 plazas ocupadas · 5 disponibles». */
export function capacityText(occupied: number, limit: number): string {
  const free = Math.max(0, limit - occupied);
  return `${occupied} de ${limit} plazas ocupadas · ${free} ${free === 1 ? 'disponible' : 'disponibles'}`;
}

export type StartContext = {
  connected: boolean; connecting: boolean; replaying: boolean; busy: boolean;
  occupied: number; limit: number; folder: string | null; folderMissing: boolean;
  provider: Provider | null; tool: ToolState; terminalSupported: boolean;
};
/** Why «Abrir sesión» is disabled, in the words shown beside it; `reconnect` adds that action. Null = can open. */
export function startBlockedReason(c: StartContext): { text: string; reconnect?: boolean } | null {
  if (c.connecting) return { text: 'Conectando con el servicio de sesiones…' };
  if (!c.connected) return { text: 'Sin conexión con el servicio de sesiones. Reconecta para abrir una sesión.', reconnect: true };
  if (c.replaying) return { text: 'Recuperando el historial…' };
  if (c.occupied >= c.limit) return { text: `No quedan plazas (${c.occupied} de ${c.limit}). Termina una sesión o cambia el límite en Configuración.` };
  if (!c.provider) return { text: 'Elige una herramienta.' };
  if (c.provider === 'terminal' && !c.terminalSupported) return { text: 'Terminal necesita reiniciar el runner desde Diagnóstico.' };
  if (c.provider !== 'terminal' && c.tool === 'missing') return { text: `${providerNames[c.provider]} no está instalado. Elige otra herramienta o pulsa Comprobar otra vez.` };
  if (!c.folder) return { text: 'Elige una carpeta de trabajo.' };
  if (c.folderMissing) return { text: 'Esta carpeta ya no existe. Elige otra carpeta.' };
  if (c.busy) return { text: 'Hay una operación en curso.' };
  return null;
}

/** The runner refuses a folder that disappeared with these technical messages. */
export function isMissingFolderError(message: string): boolean {
  return /working directory is unavailable|working directory must be a directory/.test(message);
}

/** Warning, not a block: another live Claude Code session already works in this folder. */
export function claudeFolderConflict(sessions: { kind: string; cwd: string | null; status: string }[], provider: Provider | null, folder: string | null): boolean {
  return provider === 'claude' && !!folder && sessions.some(s => s.kind === 'claude' && s.cwd === folder && ['starting', 'running'].includes(s.status));
}

const RECENT_LIMIT = 5;
/** View metadata per profile (like the last Pulso board): absolute folder paths only, never sent to the runner or the diagnostic. */
export function recentFoldersKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria-new-session:recent-folders:${profile}` : null;
}
const validFolder = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
export function readRecentFolders(storage: Pick<Storage, 'getItem'>, profile: string | null): string[] {
  const key = recentFoldersKey(profile); if (!key) return [];
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (value?.schemaVersion !== 1 || !Array.isArray(value.folders)) return [];
    return [...new Set(value.folders.filter(validFolder) as string[])].slice(0, RECENT_LIMIT);
  } catch { return []; }
}
export function rememberRecentFolder(storage: Pick<Storage, 'getItem' | 'setItem'>, profile: string | null, folder: string): string[] {
  const key = recentFoldersKey(profile); if (!key || !validFolder(folder)) return readRecentFolders(storage, profile);
  const folders = [folder, ...readRecentFolders(storage, profile).filter(f => f !== folder)].slice(0, RECENT_LIMIT);
  try { storage.setItem(key, JSON.stringify({ schemaVersion: 1, folders })); } catch { /* Optional view preference. */ }
  return folders;
}
/** «~/proyectos/app» for folders inside the home folder; the full path otherwise. */
export function folderLabel(folder: string, home: string | null): string {
  return home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder;
}

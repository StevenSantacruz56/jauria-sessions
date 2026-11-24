/**
 * Terminal font size, per profile, in the same local storage as the other view
 * preferences. Changing it is an action of the person: each visible terminal
 * is refitted once (one `resize` of its PTY). Codex conversations do not use
 * xterm and are not affected. A missing or invalid value is the default.
 */
export const terminalFontSize = { min: 11, max: 18, default: 13 } as const;

export function terminalFontKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria:terminal-font:${profile}` : null;
}
export function validFontSize(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= terminalFontSize.min && (value as number) <= terminalFontSize.max ? value as number : terminalFontSize.default;
}
export function readTerminalFont(storage: Pick<Storage, 'getItem'>, profile: string | null): number {
  const key = terminalFontKey(profile); if (!key) return terminalFontSize.default;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value?.schemaVersion === 1 ? validFontSize(value.size) : terminalFontSize.default;
  } catch { return terminalFontSize.default; }
}
export function saveTerminalFont(storage: Pick<Storage, 'setItem' | 'removeItem'>, profile: string | null, size: number): void {
  const key = terminalFontKey(profile); if (!key || validFontSize(size) !== size) return;
  try {
    if (size === terminalFontSize.default) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ schemaVersion: 1, size }));
  } catch { /* Optional view preference. */ }
}

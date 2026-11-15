/** View metadata only: no transcript, command, credential or provider policy. */
export function boardPreferenceKey(profile: string | null): string | null {
  return profile && profile.length <= 4096 ? `jauria-pulso:last-board:${profile}` : null;
}
export function readLastBoard(storage: Pick<Storage, 'getItem'>, profile: string | null): string | null {
  const key = boardPreferenceKey(profile); if (!key) return null;
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value?.schemaVersion === 1 && typeof value.projectId === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value.projectId)
      && value.projectId !== '.' && value.projectId !== '..' ? value.projectId : null;
  } catch { return null; }
}
export function saveLastBoard(storage: Pick<Storage, 'setItem'>, profile: string | null, projectId: string | null): void {
  const key = boardPreferenceKey(profile); if (!key) return;
  if (projectId !== null && (!/^[A-Za-z0-9_.-]{1,80}$/.test(projectId) || projectId === '.' || projectId === '..')) return;
  try { storage.setItem(key, JSON.stringify({ schemaVersion: 1, projectId })); } catch { /* Optional view preference. */ }
}

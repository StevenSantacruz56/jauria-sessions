export type Project = { closed?: boolean; id: string; name: string; root: string; commonDir: string; head: string; branch: string | null };
export type Task = { id: string; projectId: string; title: string; objective: string; acceptanceCriteria: string; baseSha: string; branch: string; worktreePath: string; state: 'draft' | 'preparing' | 'ready' | 'needs_attention'; error: string | null };
export type WorkspaceData = { projectLifecycleVersion?: number; workspaceVersion?: number; projects?: Project[]; tasks?: Task[] };
export function hasTaskWorkspace(data: WorkspaceData | null): boolean {
  return data?.workspaceVersion === 1 && Array.isArray(data.projects) && Array.isArray(data.tasks);
}
export function taskStateLabel(state: Task['state']): string {
  switch (state) {
    case 'draft': return 'Borrador';
    case 'preparing': return 'Preparando';
    case 'ready': return 'Lista';
    case 'needs_attention': return 'Requiere atención';
    default: return 'Estado desconocido';
  }
}
export function validateDraft(projectId: string, title: string, objective: string, criteria: string): string | null {
  if (!projectId) return 'Selecciona un proyecto registrado.';
  if (!title.trim() || title.length > 120) return 'Escribe un título de 1 a 120 caracteres.';
  if (!objective.trim() || objective.length > 8000) return 'Escribe un objetivo de 1 a 8000 caracteres.';
  if (criteria.length > 8000) return 'Los criterios admiten hasta 8000 caracteres.';
  return null;
}
export function taskStartBlock(task: Task, sessions: readonly { taskId?: string | null; status: string }[]): string | null {
  if (task.state !== 'ready') return 'Prepara el worktree antes de iniciar un proveedor.';
  if (sessions.some(s => s.taskId === task.id && ['running', 'starting', 'needs_attention'].includes(s.status))) return 'Esta tarea ya tiene una sesión abierta o pendiente de atención. Vuelve a su terminal.';
  if (sessions.filter(s => !['exited','stopped','failed','interrupted','released'].includes(s.status)).length >= 2) return 'Las dos plazas están ocupadas, incluidas las sesiones inciertas. Detén o resuelve una para iniciar; puedes guardar y preparar otras tareas.';
  return null;
}

import type PMPlugin from '../main'
import type { Project, Task } from '../types'

/**
 * Flip a task's flagged/impediment marker and persist it via the store
 * (updateTask stamps the activity log; the serializer omits false).
 *
 * Deliberately fires no UI refresh: callers already hold the host's
 * onRefresh (TaskContextMenu pattern) and call it after this resolves —
 * an undo call site does the same with the refresh it captured.
 */
export async function toggleTaskFlag(plugin: PMPlugin, project: Project, task: Task): Promise<void> {
  await plugin.store.updateTask(project, task.id, { flagged: !task.flagged })
}

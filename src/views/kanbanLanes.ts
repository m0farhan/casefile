import { BUCKETS, type SeverityConfig, type Task } from '../types'

export type KanbanLaneGroup = 'none' | 'epic' | 'assignee' | 'severity' | 'bucket'

export const LANE_GROUPS: { id: KanbanLaneGroup; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'epic', label: 'Epic' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'severity', label: 'Severity' },
  { id: 'bucket', label: 'Bucket' }
]

// A data.json lane setting persisted before the priority→severity swap (kanbanLane:
// 'priority') fails this guard and degrades to 'none' — never a crash.
export function isLaneGroup(value: unknown): value is KanbanLaneGroup {
  return LANE_GROUPS.some((g) => g.id === value)
}

export interface KanbanLane {
  key: string
  label: string
  tasks: Task[]
}

/**
 * Partition the board's tasks into swimlanes. Pure — the epic lookup comes in
 * as an accessor so KanbanView can wire findEpicAncestor without this module
 * needing a Project. Empty lanes are dropped (except the single 'none' lane).
 */
export function computeLanes(
  tasks: Task[],
  groupBy: KanbanLaneGroup,
  opts: { epicOf: (taskId: string) => Task | null; severities: SeverityConfig[] }
): KanbanLane[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', tasks }]

  const byKey = new Map<string, KanbanLane>()
  const add = (key: string, label: string, task: Task): void => {
    let lane = byKey.get(key)
    if (!lane) {
      lane = { key, label, tasks: [] }
      byKey.set(key, lane)
    }
    lane.tasks.push(task)
  }

  switch (groupBy) {
    case 'epic': {
      for (const t of tasks) {
        const epic = opts.epicOf(t.id)
        if (epic) add(epic.id, epic.key ? `${epic.key} · ${epic.title}` : epic.title, t)
        else add('', 'No epic', t)
      }
      // First-appearance order (tree order), catch-all lane last.
      return [...withoutKey(byKey, ''), ...keptLane(byKey, '')]
    }
    case 'assignee': {
      for (const t of tasks) {
        const who = t.assignees[0] ?? ''
        add(who, who || 'Unassigned', t)
      }
      const named = withoutKey(byKey, '').sort((a, b) => a.label.localeCompare(b.label))
      return [...named, ...keptLane(byKey, '')]
    }
    case 'severity': {
      for (const t of tasks) {
        if (!t.severity) {
          add('', 'No severity', t)
          continue
        }
        const cfg = opts.severities.find((s) => s.id === t.severity)
        add(t.severity, cfg?.label ?? t.severity, t)
      }
      // Catalog order first; unknown severities trail in first-appearance order, No severity last.
      const catalogIds = opts.severities.map((s) => s.id)
      const inCatalog = catalogIds.flatMap((id) => keptLane(byKey, id))
      const extras = [...byKey.values()].filter((l) => l.key !== '' && !catalogIds.includes(l.key))
      return [...inCatalog, ...extras, ...keptLane(byKey, '')]
    }
    case 'bucket': {
      for (const t of tasks) {
        const cfg = BUCKETS.find((b) => b.id === t.bucket)
        add(t.bucket, cfg?.label ?? t.bucket, t)
      }
      // BUCKETS already lists 'none' ("No bucket") last.
      return BUCKETS.flatMap((b) => keptLane(byKey, b.id))
    }
  }
}

function keptLane(byKey: Map<string, KanbanLane>, key: string): KanbanLane[] {
  const lane = byKey.get(key)
  return lane ? [lane] : []
}

function withoutKey(byKey: Map<string, KanbanLane>, key: string): KanbanLane[] {
  return [...byKey.values()].filter((l) => l.key !== key)
}

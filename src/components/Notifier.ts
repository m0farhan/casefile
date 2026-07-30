import { Notice } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, StatusConfig, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { isTerminalStatus } from '../utils'
import { Temporal, today, parsePlainDate } from '../dates'
import { slaState } from '../soc/sla'

// 5min (was hourly): SLA breaches need tight cadence; loads are projectCache-backed.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

export class Notifier {
  private intervalId: number | null = null
  private notifiedIds = new Set<string>() // prevent repeat notifications within session

  constructor(private plugin: PMPlugin) {}

  start(): void {
    void this.check()
    this.intervalId = window.setInterval(() => {
      void this.check()
    }, CHECK_INTERVAL_MS)
    this.plugin.registerInterval(this.intervalId)
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  async check(): Promise<void> {
    if (!this.plugin.settings.notificationsEnabled) return

    const leadDays = this.plugin.settings.notificationLeadDays
    const now = today()
    const threshold = now.add({ days: leadDays })

    let projects: Project[]
    try {
      projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    } catch {
      return
    }

    for (const project of projects) {
      const statuses = this.plugin.store.configFor(project).statuses
      const flat = flattenTasks(project.tasks)
      for (const { task } of flat) {
        const due = parsePlainDate(task.due)
        if (!due) continue
        if (isTerminalStatus(task.status, statuses)) continue

        const cmpToToday = Temporal.PlainDate.compare(due, now)
        const isOverdue = cmpToToday < 0
        const isDueSoon = cmpToToday >= 0 && Temporal.PlainDate.compare(due, threshold) <= 0

        const notifKey = `${task.id}-${task.due}`

        if (isOverdue && !this.notifiedIds.has(notifKey + '-overdue')) {
          this.notifiedIds.add(notifKey + '-overdue')
          const daysAgo = now.since(due, { largestUnit: 'days' }).days
          new Notice(`⚠️ Overdue: "${task.title}" in ${project.title} was due ${daysAgo}d ago`, 8000)
        } else if (isDueSoon && !this.notifiedIds.has(notifKey + '-soon')) {
          this.notifiedIds.add(notifKey + '-soon')
          const daysLeft = due.since(now, { largestUnit: 'days' }).days
          const msg =
            daysLeft === 0
              ? `📅 Due today: "${task.title}" in ${project.title}`
              : `📅 Due in ${daysLeft}d: "${task.title}" in ${project.title}`
          new Notice(msg, 6000)
        }
      }

      // Breach pass: due-date notices are date-keyed and skip undated tasks, so
      // SLA breaches (time-keyed, incidents only) get their own walk.
      for (const { task } of flat) {
        await this.checkSlaBreach(project, task, statuses)
      }
    }
  }

  /**
   * Notify + audit-log a new SLA breach on an open incident. A resolution
   * breach applies while unresolved; a response breach while unresponded —
   * slaState's phase/done fields already encode both. Dedupe: session Set
   * first (added BEFORE the await so a slow save can't double-fire), then the
   * task's own activity log for cross-session silence.
   */
  private async checkSlaBreach(project: Project, task: Task, statuses: StatusConfig[]): Promise<void> {
    if (task.issueType !== 'incident' || task.archived) return
    if (isTerminalStatus(task.status, statuses)) return
    const state = slaState(task, this.plugin.settings.slaPolicies, Date.now())
    if (!state || !state.breached || state.done) return

    const sessionKey = `${task.id}-${state.phase}-breach`
    if (this.notifiedIds.has(sessionKey)) return
    this.notifiedIds.add(sessionKey)

    const logged = 'breached-' + state.phase
    if (task.activity.some((a) => a.field === 'sla' && a.to === logged)) return

    const phaseLabel = state.phase === 'response' ? 'Response' : 'Resolution'
    const ref = task.key ? `${task.key} ${task.title}` : task.title
    new Notice(`${phaseLabel} target breached: ${ref}`, 8000)
    await this.plugin.store.appendActivity(project, task.id, {
      at: new Date().toISOString(),
      field: 'sla',
      from: state.phase,
      to: logged
    })
  }
}

import { Notice } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, StatusConfig, Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'
import { archiveNow, dueForAutoArchive } from '../store/ArchiveOps'
import { isTerminalStatus } from '../utils'
import { Temporal, today, parsePlainDate } from '../dates'
import { slaAnchor, slaState } from '../soc/sla'

// 5min (was hourly): SLA breaches need tight cadence; loads are projectCache-backed.
const CHECK_INTERVAL_MS = 5 * 60 * 1000

export class Notifier {
  private intervalId: number | null = null
  private notifiedIds = new Set<string>() // prevent repeat notifications within session
  /** One sweep at a time: a pass can outlive the 5-minute interval on a big vault. */
  private sweeping = false

  constructor(private plugin: PMPlugin) {}

  start(): void {
    // The launch pass waits for layout. start() is called from onload(), and at
    // that point Obsidian has not finished indexing the vault: loadAllProjects
    // came back with ZERO projects, so the launch run of both the notification
    // pass and the archive sweep walked an empty list and silently did nothing
    // (PS-07). Every later tick was fine, which is what made it invisible — the
    // sweep looked like it had run and found nothing to do.
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.tick()
    })
    this.intervalId = window.setInterval(() => {
      void this.tick()
    }, CHECK_INTERVAL_MS)
    this.plugin.registerInterval(this.intervalId)
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * One pass of everything on the clock. The archive sweep is deliberately NOT
   * inside check(): check() returns early when notifications are off, and
   * whether an analyst wants toast messages has nothing to do with whether
   * they asked for closed cases to file themselves away.
   */
  private async tick(): Promise<void> {
    // Independent passes: whether the analyst gets toast messages has nothing
    // to do with whether closed cases file themselves away, so a throw in one
    // must not skip the other.
    try {
      await this.check()
    } catch (e) {
      console.error('Casefile: notification pass failed', e)
    }
    await this.sweepArchive()
  }

  /**
   * Move closed cases into Archive/ once they are old enough.
   *
   * OFF unless the analyst sets a window (0 = off), because this moves their
   * files. Top-level cases only: archiving a parent carries its subtree, so a
   * case whose subtree still holds open work is held back rather than dragging
   * it in. Every move is an activity entry, which is also what stops the timer
   * ever taking the same case twice — see dueForAutoArchive.
   *
   * ponytail: no per-pass cap. The first pass after enabling this can move a
   * lot of cases at once; add a cap if that ever visibly stalls.
   */
  async sweepArchive(): Promise<void> {
    const days = this.plugin.settings.autoArchiveDays
    if (!Number.isFinite(days) || days <= 0) return
    if (this.sweeping) return
    this.sweeping = true
    try {
      let projects: Project[]
      try {
        projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
      } catch {
        return
      }
      const now = archiveNow()
      let moved = 0
      let failed = 0
      for (const project of projects) {
        const statuses = this.plugin.store.configFor(project).statuses
        // Top-level only, and a parent waits while any descendant is still open.
        for (const task of [...project.tasks]) {
          if (!dueForAutoArchive(task, statuses, days, now)) continue
          const subtreeOpen = flattenTasks([task]).some(
            (f) => f.task.id !== task.id && !isTerminalStatus(f.task.status, statuses)
          )
          if (subtreeOpen) continue
          // Guarded per case. The sweep is the unguarded half of the split
          // tick, so one case whose file cannot be renamed — open elsewhere, a
          // name collision in Archive/, a permission — used to abort the whole
          // pass and every case after it, silently, for as long as that case
          // stayed due.
          try {
            await this.plugin.store.archiveTask(project, task.id, 'auto')
            moved++
          } catch (e) {
            console.error(`Casefile: could not auto-archive ${task.title}`, e)
            failed++
          }
        }
      }
      if (failed) {
        new Notice(
          `Casefile could not archive ${failed} case${failed === 1 ? '' : 's'}. ` +
            'They stay on the board; the console has the reason for each.',
          8000
        )
      }
      if (moved) {
        new Notice(
          `Casefile archived ${moved} closed case${moved === 1 ? '' : 's'} (${days}d). ` +
            'Each one has an "archived" entry in its timeline; unarchive from the case menu.',
          8000
        )
        this.plugin.refreshProjectViews()
      }
    } finally {
      this.sweeping = false
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

    const overdueMsgs: string[] = []
    const soonMsgs: string[] = []
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
          overdueMsgs.push(`⚠️ Overdue: "${task.title}" in ${project.title} was due ${daysAgo}d ago`)
        } else if (isDueSoon && !this.notifiedIds.has(notifKey + '-soon')) {
          this.notifiedIds.add(notifKey + '-soon')
          const daysLeft = due.since(now, { largestUnit: 'days' }).days
          const msg =
            daysLeft === 0
              ? `📅 Due today: "${task.title}" in ${project.title}`
              : `📅 Due in ${daysLeft}d: "${task.title}" in ${project.title}`
          soonMsgs.push(msg)
        }
      }

      // Breach pass: due-date notices are date-keyed and skip undated tasks, so
      // SLA breaches (time-keyed, incidents only) get their own walk.
      for (const { task } of flat) {
        await this.checkSlaBreach(project, task, statuses)
      }
    }

    // One summary instead of a toast storm (OB-4): installing into a vault
    // with many overdue tasks used to stack N eight-second notices per launch.
    if (overdueMsgs.length + soonMsgs.length > 3) {
      new Notice(`${overdueMsgs.length} overdue, ${soonMsgs.length} due soon — open the board`, 8000)
    } else {
      for (const m of overdueMsgs) new Notice(m, 8000)
      for (const m of soonMsgs) new Notice(m, 6000)
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
    // Logged at the deadline itself, not at the moment Obsidian noticed —
    // the walk runs every 5 minutes and only while the vault is open (SD-07).
    await this.plugin.store.appendActivity(project, task.id, {
      at: new Date(state.deadline).toISOString(),
      field: 'sla',
      // The log is append-only: an entry that cannot say which clock produced
      // its deadline can never be corrected. `to` is left untouched — the
      // dedupe above matches on it.
      from: slaAnchor(task).from === 'created' ? `${state.phase} (from case creation)` : state.phase,
      to: logged
    })
  }
}

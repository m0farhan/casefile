import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { today } from '../dates'
import { DEFAULT_SETTINGS, DEFAULT_STATUSES, makeProject, makeTask, type Task } from '../types'
import { Notifier } from './Notifier'

const h = vi.hoisted(() => ({ notices: [] as string[] }))

// The stub's Notice records nothing; this one records every message shown.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Notice: class {
    constructor(message: string) {
      h.notices.push(message)
    }
    hide(): void {}
  }
}))

type Entry = Task['activity'][number]

function setup(tasks: Task[], notificationsEnabled = true, failOnCall = 0) {
  const project = makeProject('SOC', 'SOC/SOC.md')
  project.tasks = tasks
  let calls = 0
  const appendActivity = vi.fn<(p: unknown, id: string, entry: Entry) => Promise<void>>(async (_p, id, entry) => {
    if (++calls === failOnCall) throw new Error('save failed')
    tasks.find((t) => t.id === id)?.activity.push(entry)
  })
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, notificationsEnabled },
    store: {
      loadAllProjects: async () => [project],
      configFor: () => ({ statuses: DEFAULT_STATUSES }),
      appendActivity
    }
  } as unknown as PMPlugin
  return { notifier: new Notifier(plugin), appendActivity }
}

/** An open sev1 incident detected in 2020: its 60-minute response target is long gone. */
const breached = (n: number) =>
  makeTask({
    key: `SOC-${n}`,
    title: `case ${n}`,
    issueType: 'incident',
    severity: 'sev1',
    status: 'todo',
    detectedAt: '2020-01-01T00:00:00.000Z'
  })

beforeEach(() => {
  h.notices.length = 0
})

describe('Notifier.check', () => {
  it('logs a breach with notifications off, and shows nothing', async () => {
    const { notifier, appendActivity } = setup([breached(1)], false)
    await notifier.check()
    expect(appendActivity).toHaveBeenCalledTimes(1)
    expect(appendActivity.mock.calls[0][2]).toMatchObject({ field: 'sla', to: 'breached-response' })
    expect(h.notices).toEqual([])
  })

  it('folds a breach storm into one summary, and still logs every case', async () => {
    const { notifier, appendActivity } = setup([1, 2, 3, 4, 5, 6].map(breached))
    await notifier.check()
    expect(h.notices).toEqual(['6 targets breached, 0 overdue, 0 due soon — open the board'])
    expect(appendActivity).toHaveBeenCalledTimes(6)
  })

  it('shows a few breaches one by one', async () => {
    const { notifier } = setup([breached(1), breached(2)])
    await notifier.check()
    expect(h.notices).toEqual(['Response target breached: SOC-1 case 1', 'Response target breached: SOC-2 case 2'])
  })

  it('still shows every breach it marked when an activity save throws', async () => {
    const { notifier } = setup([1, 2, 3, 4].map(breached), true, 3)
    await expect(notifier.check()).rejects.toThrow('save failed')
    expect(h.notices).toEqual([1, 2, 3].map((n) => `Response target breached: SOC-${n} case ${n}`))
  })

  it('raises no due-date notice for an archived task, open or not', async () => {
    const due = today().subtract({ days: 10 }).toString()
    const { notifier } = setup([makeTask({ title: 'Filed away', status: 'todo', due, archived: true })])
    await notifier.check()
    expect(h.notices).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { applySubtaskChecked, renderSubtasksPanel } from './SubtasksPanel'
import type PMPlugin from '../main'
import type { Project, StatusConfig } from '../types'
import { makeTask } from '../types'
import { today } from '../dates'
import { guardVerdictOnClose } from '../soc/verdictGuard'

vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(): this {
        return this
      }
    }
  }
})
vi.mock('../soc/verdictGuard', () => ({ guardVerdictOnClose: vi.fn<() => Promise<null>>() }))

const statuses: StatusConfig[] = [
  { id: 'todo', label: 'To do', color: '', icon: '', complete: false },
  { id: 'doing', label: 'Doing', color: '', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '', icon: '', complete: true }
]

describe('applySubtaskChecked', () => {
  it('checking stamps completed with the current date alongside status and progress', () => {
    const sub = makeTask({ type: 'subtask', status: 'doing' })
    applySubtaskChecked(sub, true, statuses)
    expect(sub.status).toBe('done')
    expect(sub.progress).toBe(100)
    // The regression: status/progress moved but completed stayed '' forever.
    expect(sub.completed).toBe(today().toString())
  })

  it('unchecking clears the completion stamp and restores the default status', () => {
    const sub = makeTask({ type: 'subtask', status: 'done', progress: 100, completed: today().toString() })
    applySubtaskChecked(sub, false, statuses)
    expect(sub.status).toBe('todo')
    expect(sub.progress).toBe(0)
    expect(sub.completed).toBe('')
  })
})

describe('renderSubtasksPanel', () => {
  it('ticking an incident subtask asks for its verdict; Cancel leaves it open and unticked', async () => {
    const sub = makeTask({ title: 'Contain host', type: 'subtask', issueType: 'incident', status: 'todo' })
    const task = makeTask({ subtasks: [sub] })
    const onChange = vi.fn<() => void>()
    vi.mocked(guardVerdictOnClose).mockResolvedValueOnce(null)
    const root = FakeEl.root()
    const project = {} as Project
    renderSubtasksPanel(root as unknown as HTMLElement, task, {} as PMPlugin, statuses, {
      project,
      onOpen: () => {},
      onChange
    })
    const cb = root.find('input.pm-subtask-checkbox')
    cb.checked = true
    cb.dispatchEvent(fakeEvent('change'))
    await vi.waitFor(() => expect(cb.checked).toBe(false))
    expect(guardVerdictOnClose).toHaveBeenCalledWith({}, project, sub, 'done')
    expect(sub.status).toBe('todo')
    expect(sub.completed).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a verdict picked in the prompt is recorded with the close', async () => {
    const sub = makeTask({ title: 'Contain host', type: 'subtask', issueType: 'incident', status: 'todo' })
    const onChange = vi.fn<() => void>()
    vi.mocked(guardVerdictOnClose).mockResolvedValueOnce({ verdict: 'true-positive' })
    const root = FakeEl.root()
    renderSubtasksPanel(root as unknown as HTMLElement, makeTask({ subtasks: [sub] }), {} as PMPlugin, statuses, {
      project: {} as Project,
      onOpen: () => {},
      onChange
    })
    const cb = root.find('input.pm-subtask-checkbox')
    cb.checked = true
    cb.dispatchEvent(fakeEvent('change'))
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(sub.status).toBe('done')
    expect(sub.verdict).toBe('true-positive')
  })
})

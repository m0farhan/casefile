import { describe, expect, it } from 'vitest'
import { applySubtaskChecked } from './SubtasksPanel'
import type { StatusConfig } from '../types'
import { makeTask } from '../types'
import { today } from '../dates'

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

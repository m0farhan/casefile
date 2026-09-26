import { describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { diffTaskPatch, renderActivitySection } from './TaskDetailView'
import { makeTask } from '../types'
import type { Task } from '../types'

// The aliased obsidian stub carries no view/modal base classes; this module's
// import chain (ModalFactory, TaskModal, …) only needs them to exist for
// `extends`, so bare stand-ins suffice.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  // Constructible AND callable stand-in (plain function, not class syntax).
  function Stub(): void {}
  // Proxy so ANY base class the chain extends (ItemView, Modal, SuggestModal,
  // AbstractInputSuggest, …) resolves to a bare stand-in instead of undefined.
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      // 'then' must stay absent or the awaited factory result looks thenable.
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

const clone = (t: Task): Task => JSON.parse(JSON.stringify(t)) as Task

describe('diffTaskPatch', () => {
  it('sends only the fields the panel changed', () => {
    const snapshot = makeTask({ status: 'todo', description: 'before' })
    const working = clone(snapshot)
    working.description = 'after'
    const patch = diffTaskPatch(snapshot, working)
    expect(patch).toEqual({ description: 'after' })
  })

  it('never carries an untouched field, so a stale clone cannot revert edits made elsewhere', () => {
    // The board moved the live task to 'done' AFTER the panel cloned it: the
    // panel's working copy is stale at 'todo'. The old whole-clone patch sent
    // status:'todo' and reverted the board's edit; the diff must not.
    const snapshot = makeTask({ status: 'todo' })
    const working = clone(snapshot)
    working.description = 'typed in the panel'
    const patch = diffTaskPatch(snapshot, working)
    expect('status' in patch).toBe(false)
    expect('subtasks' in patch).toBe(false)
    expect('activity' in patch).toBe(false)
  })

  it('detects nested changes: subtasks and time logs', () => {
    const snapshot = makeTask({})
    const working = clone(snapshot)
    working.subtasks.push(makeTask({ title: 'child', type: 'subtask' }))
    working.timeLogs = [{ date: '2026-09-14', hours: 1, note: '' }]
    const patch = diffTaskPatch(snapshot, working)
    expect(Object.keys(patch).sort()).toEqual(['subtasks', 'timeLogs'])
  })

  it('a field cleared to undefined still lands in the patch', () => {
    const snapshot = makeTask({ timeEstimate: 4 })
    const working = clone(snapshot)
    working.timeEstimate = undefined
    const patch = diffTaskPatch(snapshot, working)
    expect('timeEstimate' in patch).toBe(true)
    expect(patch.timeEstimate).toBeUndefined()
  })

  it('identical clones diff to an empty patch (autosave becomes a no-op)', () => {
    const snapshot = makeTask({})
    expect(diffTaskPatch(snapshot, clone(snapshot))).toEqual({})
  })
})

describe('renderActivitySection', () => {
  const task = makeTask({
    activity: [{ at: '2026-09-26T10:00:00.000Z', field: 'iocs', from: '', to: 'http://evil.example/login' }]
  })
  const mount = (collapsed = true) => {
    const root = FakeEl.root()
    const state = { collapsed }
    renderActivitySection(root as unknown as HTMLElement, task, state)
    return { root, state, header: root.find('.pm-activity-header'), list: root.find('.pm-activity-list') }
  }

  it('prints an indicator defanged, as it shows everywhere else', () => {
    const text = mount().list.textContent
    expect(text).toContain('hxxp://evil[.]example/login')
    expect(text).not.toContain('http://evil.example')
  })

  it('the header is the one button: Enter or Space opens and closes the log', () => {
    const { header, list, state } = mount()
    const toggle = header.find('.pm-collapse-toggle')
    expect(header.getAttribute('role')).toBe('button')
    expect(header.getAttribute('tabindex')).toBe('0')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    // One tab stop: the triangle inside is only a picture of the state.
    expect(toggle.hasAttribute('tabindex')).toBe(false)
    expect(toggle.getAttribute('aria-hidden')).toBe('true')

    const enter = fakeEvent('keydown', { key: 'Enter' })
    header.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(enter.propagationStopped).toBe(true)
    expect(state.collapsed).toBe(false)
    expect(list.hidden).toBe(false)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    header.dispatchEvent(fakeEvent('keydown', { key: ' ' }))
    expect(list.hidden).toBe(true)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('a triangle click toggles once, and Shift+Enter is left to the modal save', () => {
    const { header, list } = mount()
    header.find('.pm-collapse-toggle').click()
    expect(list.hidden).toBe(false)
    const shiftEnter = fakeEvent('keydown', { key: 'Enter', shiftKey: true })
    header.dispatchEvent(shiftEnter)
    expect(shiftEnter.propagationStopped).toBe(false)
    expect(list.hidden).toBe(false)
  })
})

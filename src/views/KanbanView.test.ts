import { describe, expect, it, vi } from 'vitest'
import { laneCreatePatch } from './KanbanView'

// vi.mock hoists above the imports. KanbanView's import chain pulls the whole
// console in; the pure helper under test needs none of it, so the view-layer
// siblings (and the stub-less Menu export) become bare stand-ins.
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Menu: vi.fn<() => void>()
}))
vi.mock('../ui/ModalFactory', () => ({ openTaskModal: vi.fn<() => void>() }))
vi.mock('../ui/TaskContextMenu', () => ({ buildTaskContextMenu: vi.fn<() => void>() }))
vi.mock('../ui/composites/KanbanColumn', () => ({ KanbanColumn: vi.fn<() => void>() }))
vi.mock('../ui/composites/KanbanCard', () => ({ setKanbanSocConfig: vi.fn<() => void>() }))
vi.mock('../soc/verdictGuard', () => ({ guardVerdictOnClose: vi.fn<() => void>() }))
vi.mock('../ui/motion', () => ({
  captureRects: vi.fn<() => void>(),
  markEnter: vi.fn<() => void>(),
  motionOK: (): boolean => false,
  playFlip: vi.fn<() => void>()
}))

// The board's inline create routes its makeTask overrides through this patch:
// before the fix no lane field was set, so a card created inside the 'High'
// severity lane (or a bucket lane) materialized in a different lane.
describe('laneCreatePatch', () => {
  it('sets the severity of a card created in a severity lane', () => {
    expect(laneCreatePatch('severity', 'sev1')).toEqual({ severity: 'sev1' })
  })

  it('leaves severity unset in the no-severity lane', () => {
    expect(laneCreatePatch('severity', '')).toEqual({})
  })

  it('sets the bucket of a card created in a bucket lane', () => {
    expect(laneCreatePatch('bucket', 'this-week')).toEqual({ bucket: 'this-week' })
  })

  it('keeps the default bucket in the no-bucket lane', () => {
    expect(laneCreatePatch('bucket', 'none')).toEqual({ bucket: 'none' })
  })

  it('assigns the lane assignee in an assignee lane', () => {
    expect(laneCreatePatch('assignee', '[[People/Jane Doe]]')).toEqual({ assignees: ['[[People/Jane Doe]]'] })
  })

  it('leaves assignees empty in the unassigned lane', () => {
    expect(laneCreatePatch('assignee', '')).toEqual({})
  })

  it('refuses the create affordance in a real epic lane (no faked parentage)', () => {
    expect(laneCreatePatch('epic', 'task-123')).toBeNull()
  })

  it('allows create in the no-epic lane', () => {
    expect(laneCreatePatch('epic', '')).toEqual({})
  })

  it('adds nothing when the board has no lanes', () => {
    expect(laneCreatePatch('none', 'all')).toEqual({})
  })
})

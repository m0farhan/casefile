import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../test/fakeDom'
import type PMPlugin from '../main'
import {
  DEFAULT_ALERT_CATEGORIES,
  DEFAULT_ISSUE_TYPES,
  DEFAULT_SEVERITIES,
  DEFAULT_STATUSES,
  makeTask,
  type Project,
  type Task
} from '../types'
import { renderMultiSelect, renderSelectControl } from '../ui/composites/properties'
import { renderTaskFormFields } from './TaskFormFields'

// The controls are recorded, not drawn: each test reads the options a row
// handed its control and calls the control's callbacks itself.
vi.mock('../ui/composites/properties', () => ({
  renderSelectControl: vi.fn<() => void>(),
  renderDateControl: vi.fn<() => void>(),
  renderMultiSelect: vi.fn<() => void>(),
  renderAddProperty: vi.fn<() => void>()
}))
vi.mock('../ui/FormField', async () => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    renderPropRow: (_grid: unknown, label: string, build: () => unknown) => {
      build()
      return new FakeEl('div', { attr: { 'data-label': label } })
    }
  }
})
vi.stubGlobal('createDiv', (info?: string) => new FakeEl('div', info))

function render(task: Task, onChange?: () => void, rerender = () => {}, boardType = 'soc'): void {
  const project = { tasks: [task], teamMembers: ['alice'], customFields: [] } as unknown as Project
  const plugin = {
    store: {
      configFor: () => ({
        statuses: DEFAULT_STATUSES,
        issueTypes: DEFAULT_ISSUE_TYPES,
        severities: DEFAULT_SEVERITIES,
        verdicts: [],
        boardType
      })
    },
    settings: { globalTeamMembers: [], showTagColors: false, alertCategories: DEFAULT_ALERT_CATEGORIES }
  } as unknown as PMPlugin
  renderTaskFormFields(FakeEl.root() as unknown as HTMLElement, {
    task,
    project,
    plugin,
    parentId: null,
    setParentId: () => {},
    rerender,
    shownExtras: new Set(['depends']),
    onChange
  })
}

type MultiOpts = Parameters<typeof renderMultiSelect>[0]
const multi = (addLabel: string): MultiOpts => {
  const call = vi.mocked(renderMultiSelect).mock.calls.find(([o]) => o.addLabel === addLabel)
  if (!call) throw new Error(`no ${addLabel} control`)
  return call[0]
}

beforeEach(() => {
  vi.mocked(renderMultiSelect).mockClear()
  vi.mocked(renderSelectControl).mockClear()
})

describe('renderTaskFormFields', () => {
  it('a severity id missing from the list shows as itself, not as unset', () => {
    render(makeTask({ severity: 'sev0' }))
    const severity = vi.mocked(renderSelectControl).mock.calls.find(([o]) => o.options[0]?.label === 'None')
    expect(severity?.[0].placeholder).toBe('sev0')
  })

  it('Assignees, Tags and Depends on report every change, so the side panel can save it', () => {
    const onChange = vi.fn<() => void>()
    const task = makeTask({ title: 'Case' })
    render(task, onChange)
    multi('Assign').add('alice')
    multi('Assign').create?.('bob')
    multi('Assign').remove('alice')
    multi('Add tags').add('phishing')
    multi('Add tags').remove('phishing')
    multi('Add dependency').add('other-id')
    multi('Add dependency').remove('other-id')
    expect(task.assignees).toEqual(['bob'])
    expect(onChange).toHaveBeenCalledTimes(7)
  })
})

describe('Alert kind', () => {
  type SelectOpts = Parameters<typeof renderSelectControl>[0]
  const kindControl = (): SelectOpts | undefined =>
    vi.mocked(renderSelectControl).mock.calls.find(([o]) => o.options.some((it) => it.id === 'phishing'))?.[0]
  const HAND_MADE = '77 - SOC138 - Detected Suspicious Xls File'

  it('says a kind only derived from the title is derived, and records the one the analyst picks', () => {
    const rerender = vi.fn<() => void>()
    const task = makeTask({ title: HAND_MADE, issueType: 'incident', tags: ['soc138'] })
    render(task, undefined, rerender)
    const control = kindControl()
    expect(control?.value).toBeNull()
    expect(control?.placeholder).toBe('Suspicious file (derived from title)')
    expect(control?.options[0]).toEqual({ id: '', label: 'None' })
    expect(control?.options.find((o) => o.id === 'suspicious-file')).toMatchObject({ icon: 'file-warning' })
    control?.onChange('suspicious-file')
    expect(task.tags).toEqual(['soc138', 'suspicious-file'])
    expect(rerender).toHaveBeenCalledOnce()
  })

  it('shows a recorded kind as chosen; picking another replaces it, and None clears it', () => {
    const task = makeTask({ title: HAND_MADE, issueType: 'incident', tags: ['macro', 'day-shift'] })
    render(task)
    const control = kindControl()
    expect(control?.value).toBe('suspicious-file')
    control?.onChange('malware')
    expect(task.tags).toEqual(['day-shift', 'malware'])
    control?.onChange('')
    expect(task.tags).toEqual(['day-shift'])
  })

  it('is offered only for an incident on a case board', () => {
    render(makeTask({ title: HAND_MADE, issueType: 'task' }))
    expect(kindControl()).toBeUndefined()
    render(makeTask({ title: HAND_MADE, issueType: 'incident' }), undefined, undefined, 'plain')
    expect(kindControl()).toBeUndefined()
  })
})

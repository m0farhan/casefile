import { describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import type PMPlugin from '../main'
import { makeTask, type CustomFieldDef, type Project } from '../types'
import { renderChipList } from '../ui/FormField'
import { renderCustomFieldInput } from './CustomFieldInputs'

// The chip list is recorded, not drawn; the tests call its callbacks.
vi.mock('../ui/FormField', () => ({ renderChipList: vi.fn<() => void>() }))
vi.stubGlobal('createDiv', (info?: string) => new FakeEl('div', info))

const project = { teamMembers: [] } as unknown as Project
const plugin = { settings: { globalTeamMembers: [] } } as unknown as PMPlugin

describe('renderCustomFieldInput', () => {
  it('a cleared number field records nothing, not NaN', () => {
    const cf: CustomFieldDef = { id: 'cf1', name: 'Hosts', type: 'number' }
    const task = makeTask({ customFields: { cf1: 4 } })
    const input = (renderCustomFieldInput(cf, task, project, plugin) as unknown as FakeEl).find('input')
    input.value = '' // what a number input reads once cleared, or holding text it rejects
    input.dispatchEvent(fakeEvent('change'))
    expect('cf1' in task.customFields).toBe(false)
    input.value = '12.5'
    input.dispatchEvent(fakeEvent('change'))
    expect(task.customFields.cf1).toBe(12.5)
  })

  it('a multiselect reports a removed value, since no input event carries it', () => {
    const cf: CustomFieldDef = { id: 'cf2', name: 'Systems', type: 'multiselect', options: ['a', 'b'] }
    const task = makeTask({ customFields: { cf2: ['a', 'b'] } })
    const onChange = vi.fn<() => void>()
    renderCustomFieldInput(cf, task, project, plugin, onChange)
    vi.mocked(renderChipList).mock.calls[0][2].onRemove('a')
    expect(task.customFields.cf2).toEqual(['b'])
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('a recorded select value no longer among the options shows as itself, not as unset', () => {
    const cf: CustomFieldDef = { id: 'cf3', name: 'Tier', type: 'select', options: ['Tier 1', 'T2'] }
    const task = makeTask({ customFields: { cf3: 'T1' } })
    const sel = (renderCustomFieldInput(cf, task, project, plugin) as unknown as FakeEl).find('select')
    const shown = sel.children.filter((o) => o.selected)
    expect(shown.map((o) => [o.value, o.textContent])).toEqual([['T1', 'T1 (not an option)']])
    expect(task.customFields.cf3).toBe('T1')
  })
})

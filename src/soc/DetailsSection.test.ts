import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { makeTask } from '../types'
import { parseDetailLines, renderDetailsSection } from './DetailsSection'

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }))

vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    Notice: class {
      constructor(message: string) {
        notices.push(message)
      }
      hide(): void {}
    },
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(text: string): this {
        this.extraSettingsEl.setAttr('aria-label', text)
        return this
      }
    }
  }
})

beforeEach(() => {
  notices.length = 0
})

describe('parseDetailLines', () => {
  it('reads a pasted markdown table, its divider and markup left out', () => {
    const table = [
      '| User | **anita.garcia** |',
      '| --- | :---: |',
      '| Workstation | **corp-wks-102** |',
      '| IP | `10.0.1.135` |'
    ].join('\n')
    expect(parseDetailLines(table)).toEqual({
      rows: [
        { field: 'User', value: 'anita.garcia' },
        { field: 'Workstation', value: 'corp-wks-102' },
        { field: 'IP', value: '10.0.1.135' }
      ],
      unread: 0
    })
  })

  it('reads "Field: value" and tab pairs, and keeps a drive letter or a URL whole', () => {
    const text = [
      '- User: anita.garcia',
      'File path: C:\\Users\\anita\\x.exe',
      'URL: https://promptcraft.online/a',
      'Host\tcorp-wks-102',
      'Details:',
      'just prose'
    ].join('\n')
    expect(parseDetailLines(text)).toEqual({
      rows: [
        { field: 'User', value: 'anita.garcia' },
        { field: 'File path', value: 'C:\\Users\\anita\\x.exe' },
        { field: 'URL', value: 'https://promptcraft.online/a' },
        { field: 'Host', value: 'corp-wks-102' }
      ],
      unread: 2
    })
  })

  it('keeps a pipe that belongs to the value, in a "Field: value" or a tab pair', () => {
    const text = 'Command line: powershell -c "gci | select name"\nParent process\tcmd.exe /c a | b'
    expect(parseDetailLines(text)).toEqual({
      rows: [
        { field: 'Command line', value: 'powershell -c "gci | select name"' },
        { field: 'Parent process', value: 'cmd.exe /c a | b' }
      ],
      unread: 0
    })
    // A table row without its outer pipes still reads as one.
    expect(parseDetailLines('User | anita.garcia').rows).toEqual([{ field: 'User', value: 'anita.garcia' }])
  })

  it('skips a Field | Value header row', () => {
    expect(parseDetailLines('| Field | Value |\n|---|---|\n| User | x |').rows).toEqual([{ field: 'User', value: 'x' }])
  })
})

function mount(details = [{ field: 'User', value: 'anita.garcia' }]) {
  const root = FakeEl.root()
  const task = makeTask({ details: details.map((d) => ({ ...d })) })
  const onChange = vi.fn<() => void>()
  renderDetailsSection(root as unknown as HTMLElement, task, { onChange })
  const add = root.find('.pm-details-add')
  const [field, value] = add.findAll('input')
  return { root, task, onChange, field, value, addBtn: add.find('button') }
}

describe('renderDetailsSection', () => {
  it('adds a row from the add line, on Add or on Enter in the value', () => {
    const { root, task, onChange, field, value, addBtn } = mount()
    field.value = ' Workstation '
    value.value = 'corp-wks-102'
    addBtn.click()
    field.value = 'IP'
    value.value = '10.0.1.135'
    value.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(task.details).toEqual([
      { field: 'User', value: 'anita.garcia' },
      { field: 'Workstation', value: 'corp-wks-102' },
      { field: 'IP', value: '10.0.1.135' }
    ])
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(root.find('.pm-modal-section-title').textContent).toBe('Details (3)')
    expect(field.value).toBe('')
  })

  it("leaves Shift+Enter to the dialog's save", () => {
    const { task, field, value } = mount()
    field.value = 'IP'
    value.value = '10.0.1.135'
    const shiftEnter = fakeEvent('keydown', { key: 'Enter', shiftKey: true })
    value.dispatchEvent(shiftEnter)
    expect(shiftEnter.propagationStopped).toBe(false)
    expect(task.details).toHaveLength(1)
  })

  it('adds nothing without both a field and a value', () => {
    const { task, onChange, field, value, addBtn } = mount()
    value.value = 'orphan'
    addBtn.click()
    field.value = 'User'
    value.value = '  '
    addBtn.click()
    expect(task.details).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('edits a value in place; emptying it removes the row and the key with the last one', () => {
    const { root, task, onChange } = mount()
    const valueInput = () => root.find('.pm-details-rows').findAll('input')[1]
    valueInput().value = 'a.garcia'
    valueInput().dispatchEvent(fakeEvent('change'))
    expect(task.details).toEqual([{ field: 'User', value: 'a.garcia' }])
    valueInput().value = ''
    valueInput().dispatchEvent(fakeEvent('change'))
    expect(task.details).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('an emptied field name is put back rather than saved blank', () => {
    const { root, task, onChange } = mount()
    const fieldInput = root.find('.pm-details-rows').findAll('input')[0]
    fieldInput.value = ''
    fieldInput.dispatchEvent(fakeEvent('change'))
    expect(fieldInput.value).toBe('User')
    expect(task.details).toEqual([{ field: 'User', value: 'anita.garcia' }])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a pasted table becomes rows at once, saying what it skipped', () => {
    const { task, value } = mount()
    const text = '| User | anita.garcia |\n| Workstation | corp-wks-102 |\nnot a pair'
    const paste = fakeEvent('paste', { clipboardData: { getData: () => text } })
    value.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    expect(task.details).toEqual([
      { field: 'User', value: 'anita.garcia' },
      { field: 'Workstation', value: 'corp-wks-102' }
    ])
    expect(notices).toEqual(['Added 1 detail · 1 already recorded · 1 line not read as "Field: value"'])
  })

  it('a single pasted line pastes into the box as usual', () => {
    const { task, value } = mount()
    const paste = fakeEvent('paste', { clipboardData: { getData: () => 'corp-wks-102' } })
    value.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)
    expect(task.details).toHaveLength(1)
  })
})

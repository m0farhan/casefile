import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../../../test/fakeDom'
import { today } from '../../../dates'
import { renderDateControl } from './DateControl'

// The popover as the control sees it: a content element, and a close that
// reports back the way outside clicks, Escape and Enter all do.
const popovers: { contentEl: FakeEl; close: () => void }[] = []
vi.mock('../../primitives/Popover', async () => {
  const { FakeEl } = await import('../../../../test/fakeDom')
  return {
    Popover: class {
      contentEl = new FakeEl()
      isOpen = false
      constructor(private opts: { onClose?: () => void }) {
        popovers.push(this)
      }
      open(): void {
        this.isOpen = true
      }
      close(): void {
        this.isOpen = false
        this.opts.onClose?.()
      }
    }
  }
})

function open(value: string) {
  const container = FakeEl.root()
  const onChange = vi.fn<(v: string) => void>()
  renderDateControl({ container: container as unknown as HTMLElement, value, onChange })
  container.find('button').click()
  const pop = popovers[popovers.length - 1]
  return { pop, field: pop.contentEl.find('input'), onChange }
}

beforeEach(() => {
  popovers.length = 0
})

describe('renderDateControl', () => {
  it('opening and closing on a stored date-and-time changes nothing', () => {
    const { pop, field, onChange } = open('2026-09-26T17:00')
    // The picker shows the day the trigger shows, not a blank.
    expect(field.value).toBe('2026-09-26')
    pop.close()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a half-typed date left behind is an edit in progress, not a clear', () => {
    const { pop, field, onChange } = open('2026-09-26')
    field.value = '' // what the input reads with a segment emptied
    pop.close()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a whole new date commits', () => {
    const { pop, field, onChange } = open('2026-09-26T17:00')
    field.value = '2026-10-01'
    pop.close()
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-10-01')
  })

  it('Clear and Today always commit', () => {
    const a = open('2026-09-26T17:00')
    a.pop.contentEl
      .findAll('button')
      .find((b) => b.textContent === 'Clear')
      ?.click()
    expect(a.onChange).toHaveBeenCalledExactlyOnceWith('')
    const b = open('')
    b.pop.contentEl
      .findAll('button')
      .find((x) => x.textContent === 'Today')
      ?.click()
    expect(b.onChange).toHaveBeenCalledExactlyOnceWith(today().toString())
  })
})

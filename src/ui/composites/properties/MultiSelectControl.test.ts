import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../../../test/fakeDom'
import { renderMultiSelect } from './MultiSelectControl'

// The popover as the control sees it: a content element to fill.
const popovers: { contentEl: FakeEl }[] = []
vi.mock('../../primitives/Popover', async () => {
  const { FakeEl } = await import('../../../../test/fakeDom')
  return {
    Popover: class {
      contentEl = new FakeEl()
      isOpen = false
      constructor() {
        popovers.push(this)
      }
      open(): void {
        this.isOpen = true
      }
      close(): void {
        this.isOpen = false
      }
    }
  }
})

function open(create?: (label: string) => void) {
  const container = FakeEl.root()
  const selected: string[] = []
  renderMultiSelect({
    container: container as unknown as HTMLElement,
    selected: () => selected,
    options: () => ['alpha', 'beta', 'gamma'].map((id) => ({ id, label: id })),
    add: (id) => selected.push(id),
    remove: (id) => selected.splice(selected.indexOf(id), 1),
    addLabel: 'Add tag',
    search: !!create,
    create
  })
  container.find('button').click()
  const { contentEl } = popovers[popovers.length - 1]
  return { contentEl, selected, rows: () => contentEl.findAll('.pm-pop-item') }
}

beforeEach(() => {
  popovers.length = 0
  // The Create row's 'plus' goes through isIconName, which probes with Obsidian's global createSpan.
  vi.stubGlobal('createSpan', () => new FakeEl('span'))
})

describe('renderMultiSelect keyboard focus', () => {
  it('says it takes several values', () => {
    const { contentEl } = open()
    expect(contentEl.find('.pm-pop-list').getAttribute('aria-multiselectable')).toBe('true')
  })

  it('keeps focus on the picked row, so the arrows still step from it', () => {
    const { contentEl, selected, rows } = open()
    const beta = rows()[1]
    beta.focus()
    beta.click()
    expect(selected).toEqual(['beta'])
    // The list was redrawn: focus is on the new row in the same place, not left
    // on the detached one (which in a browser means on the document body).
    const now = rows()[1]
    expect(now).not.toBe(beta)
    expect(contentEl.ownerDocument.activeElement).toBe(now)
    expect(now.getAttribute('aria-selected')).toBe('true')
  })

  it('puts focus back in the search field after Create', () => {
    const created: string[] = []
    const { contentEl, rows } = open((label) => created.push(label))
    const search = contentEl.find('input')
    search.value = 'delta'
    search.dispatchEvent(fakeEvent('input'))
    const createRow = rows()[rows().length - 1]
    createRow.focus()
    createRow.click()
    expect(created).toEqual(['delta'])
    expect(contentEl.ownerDocument.activeElement).toBe(search)
  })
})

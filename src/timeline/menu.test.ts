import { describe, expect, it, vi } from 'vitest'
import { FakeEl } from '../../test/fakeDom'
import { timelineLinkAt } from './menu'

// menu.ts pulls in the live-preview and reading modules; their Obsidian base
// classes only need to exist (TaskDetailView.test idiom).
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  function Stub(): void {}
  return new Proxy(real, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string]
      if (typeof prop !== 'string' || prop === 'then') return undefined
      return Stub
    },
    has: () => true
  })
})

function line(...cls: string[]) {
  const root = FakeEl.root()
  const ln = root.createDiv({ cls })
  return { root, ln }
}

describe('timelineLinkAt', () => {
  it('finds a bare URL inside a timeline line', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const url = ln.createSpan({ cls: ['cm-url', 'cm-underline'], text: 'http://lawson-rowe-review.com/' })
    expect(timelineLinkAt(url as unknown as EventTarget)).toBe(url)
  })

  it('leaves links outside a timeline to Obsidian', () => {
    const { ln } = line('cm-line')
    const url = ln.createSpan({ cls: 'cm-url', text: 'https://example.com' })
    expect(timelineLinkAt(url as unknown as EventTarget)).toBeNull()
  })

  it('ignores plain text in a timeline, and targets that are not elements', () => {
    const { ln } = line('cm-line', 'cf-ntl-line')
    const word = ln.createSpan({ text: 'the user browsed' })
    expect(timelineLinkAt(word as unknown as EventTarget)).toBeNull()
    expect(timelineLinkAt(null)).toBeNull()
    expect(timelineLinkAt({} as EventTarget)).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { makeInlineEdit } from './inlineEdit'

/**
 * An input that behaves like a browser's on the one point that matters: a date
 * input holds only a bare YYYY-MM-DD, and silently turns anything else into ''
 * (Chromium does this to '2026-09-26T17:00').
 */
function field(type: 'text' | 'date') {
  const listeners = new Map<string, (e: unknown) => void>()
  let current = ''
  const input = {
    get value(): string {
      return current
    },
    set value(v: string) {
      current = type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : v
    },
    // A browser sets badInput when a date segment is half-typed; the value then reads ''.
    validity: { badInput: false },
    addEventListener: (name: string, fn: (e: unknown) => void) => listeners.set(name, fn),
    replaceWith: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
    select: vi.fn<() => void>()
  }
  const container = {
    createEl: (_tag: string, info: { value: string }) => {
      input.value = info.value
      return input
    }
  }
  const fire = (name: string, e: unknown = {}) => listeners.get(name)?.(e)
  return { input, container: container as unknown as HTMLElement, fire }
}

const display = { replaceWith: vi.fn<() => void>() } as unknown as HTMLElement

describe('makeInlineEdit', () => {
  it('leaving a date the picker could not show saves nothing, instead of erasing it', () => {
    const { container, fire } = field('date')
    const onSave = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve())
    makeInlineEdit({ container, display, inputType: 'date', value: '2026-09-26T17:00', onSave })
    fire('blur')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a date picked in the input is saved', () => {
    const { input, container, fire } = field('date')
    const onSave = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve())
    makeInlineEdit({ container, display, inputType: 'date', value: '2026-09-26', onSave })
    input.value = '2026-10-01'
    fire('blur')
    expect(onSave).toHaveBeenCalledWith('2026-10-01')
  })

  it('a half-typed date left behind keeps the old date instead of erasing it', () => {
    const { input, container, fire } = field('date')
    const onSave = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve())
    makeInlineEdit({ container, display, inputType: 'date', value: '2026-09-26', onSave })
    // One Backspace in a segment: the input reads '' but is not empty.
    input.value = ''
    input.validity.badInput = true
    fire('blur')
    expect(onSave).not.toHaveBeenCalled()
    expect(input.replaceWith).toHaveBeenCalledWith(display)
  })

  it('clearing the date in the input still saves the clear', () => {
    const { input, container, fire } = field('date')
    const onSave = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve())
    makeInlineEdit({ container, display, inputType: 'date', value: '2026-09-26', onSave })
    input.value = ''
    fire('blur')
    expect(onSave).toHaveBeenCalledWith('')
  })
})

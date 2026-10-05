import { describe, expect, it } from 'vitest'
import type { Editor } from 'obsidian'
import { defangInPlace } from './defangMenu'

/** Just the two Editor calls defangInPlace makes. */
function editorWith(selection: string): { editor: Editor; text: () => string } {
  let text = selection
  const editor = {
    getSelection: () => text,
    replaceSelection: (next: string) => {
      text = next
    }
  } as unknown as Editor
  return { editor, text: () => text }
}

describe('defangInPlace', () => {
  it('rewrites the selection itself, adding nothing around it', () => {
    const { editor, text } = editorWith('Beacon to 192.168.0.1 and https://evil.test/a')
    defangInPlace(editor)
    expect(text()).toBe('Beacon to 192[.]168[.]0[.]1 and hxxps://evil[.]test/a')
  })

  it('leaves an already-defanged selection as it is', () => {
    const { editor, text } = editorWith('192[.]168[.]0[.]1')
    defangInPlace(editor)
    expect(text()).toBe('192[.]168[.]0[.]1')
  })
})

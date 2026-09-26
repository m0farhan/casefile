import { beforeEach, describe, expect, it, vi } from 'vitest'
import type PMPlugin from '../main'
import { DEFAULT_STATUSES, DEFAULT_VERDICTS, makeTask, type BoardType, type Project } from '../types'
import { guardVerdictOnClose } from './verdictGuard'

const h = vi.hoisted(() => ({ opened: 0, texts: [] as string[] }))

// A Modal that records what it would show. Every element the prompt builds is
// the same recording stand-in, so the heading and hint can be read back.
vi.mock('obsidian', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const el = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return undefined
          return (_tag?: unknown, opts?: { text?: string }) => {
            if (opts?.text) h.texts.push(opts.text)
            return el()
          }
        }
      }
    )
  class Modal {
    contentEl = el()
    modalEl = el()
    open(): void {
      h.opened++
      ;(this as unknown as { onOpen(): void }).onOpen()
    }
    close(): void {}
  }
  return { ...real, Modal }
})

function plugin(boardType: BoardType): PMPlugin {
  const config = { boardType, statuses: DEFAULT_STATUSES, verdicts: DEFAULT_VERDICTS }
  return { app: {}, store: { configFor: () => config } } as unknown as PMPlugin
}

const project = {} as Project
const incident = makeTask({ issueType: 'incident' })

beforeEach(() => {
  h.opened = 0
  h.texts.length = 0
})

describe('guardVerdictOnClose', () => {
  it('lets a plain board close an incident with nothing to ask and nothing to write', async () => {
    const result = guardVerdictOnClose(plugin('plain'), project, incident, 'done')
    // The prompt would open synchronously inside the call.
    expect(h.opened).toBe(0)
    await expect(result).resolves.toEqual({})
  })

  it('still prompts on a case board', () => {
    void guardVerdictOnClose(plugin('case'), project, incident, 'done')
    expect(h.opened).toBe(1)
    expect(h.texts[0]).toBe('Verdict for this incident?')
  })

  it('says how many incidents one bulk answer covers', () => {
    void guardVerdictOnClose(plugin('case'), project, incident, 'done', 3)
    expect(h.texts[0]).toBe('Verdict for these 3 incidents?')
    expect(h.texts[1]).toBe(
      'The verdict you pick is recorded on each selected incident that has none. Pick one, or close them all without.'
    )
  })
})

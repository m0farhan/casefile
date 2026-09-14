import { describe, expect, it } from 'vitest'
import { makeProject, makeTask, type Ioc } from '../types'
import { sharedIndicatorLinks } from '../modals/LinksPanel'
import { hydrateTaskFromFile } from './YamlHydrator'
import { parseFrontmatter } from './YamlParser'
import { serializeTask } from './YamlSerializer'

const project = makeProject('Test', 'Projects/Test.md')

function roundTrip(md: string) {
  const { frontmatter, body } = parseFrontmatter(md)
  if (!frontmatter) throw new Error('frontmatter missing')
  return hydrateTaskFromFile(frontmatter, body, 'Projects/Tasks/Test/task.md')
}

describe('links round-trip', () => {
  it('serializes links and hydrates them back intact', () => {
    const links = [
      { type: 'blocks' as const, taskId: 'other-1' },
      { type: 'relates-to' as const, taskId: 'other-2' },
      { type: 'duplicates' as const, taskId: 'other-3' }
    ]
    const md = serializeTask(makeTask({ id: 't1', links }), project, null)
    expect(md).toContain('links:')
    expect(roundTrip(md).task.links).toEqual(links)
  })

  it('a task without links emits no key and hydrates to absent', () => {
    const md = serializeTask(makeTask({ id: 't2' }), project, null)
    expect(md).not.toContain('links')
    expect(roundTrip(md).task.links).toBeUndefined()

    // Empty array (every link removed) round-trips the same way.
    const mdEmpty = serializeTask(makeTask({ id: 't3', links: [] }), project, null)
    expect(mdEmpty).not.toContain('links')
    expect(roundTrip(mdEmpty).task.links).toBeUndefined()
  })

  it('drops malformed entries silently and keeps the well-formed ones', () => {
    const md = [
      '---',
      'pm-task: true',
      'id: t4',
      'title: X',
      'links:',
      '  - type: blocks',
      '    taskId: good-1',
      '  - type: nonsense',
      '    taskId: bad-type',
      '  - taskId: no-type',
      '  - type: relates-to',
      '  - not-an-object',
      '---',
      ''
    ].join('\n')
    const { task } = roundTrip(md)
    expect(task.links).toEqual([{ type: 'blocks', taskId: 'good-1' }])
    // links is an owned key: raw garbage must not survive via extraFrontmatter.
    expect(task.extraFrontmatter?.links).toBeUndefined()
  })
})

describe('sharedIndicatorLinks', () => {
  const ip = (value: string): Ioc => ({ type: 'ip', value })
  const domain = (value: string): Ioc => ({ type: 'domain', value })

  it('counts distinct shared values case-insensitively, most shared first', () => {
    const me = makeTask({ id: 'me', iocs: [ip('1.2.3.4'), domain('Evil.example')] })
    const one = makeTask({ id: 'one', iocs: [ip('1.2.3.4')] })
    const two = makeTask({ id: 'two', iocs: [domain('evil.EXAMPLE'), ip('1.2.3.4')] })
    const unrelated = makeTask({ id: 'unrelated', iocs: [ip('9.9.9.9')] })
    const out = sharedIndicatorLinks(me, [me, one, two, unrelated])
    expect(out.map((o) => [o.task.id, o.shared])).toEqual([
      ['two', 2],
      ['one', 1]
    ])
  })

  it('returns nothing when the task has no indicators, and never counts itself', () => {
    const bare = makeTask({ id: 'bare' })
    const other = makeTask({ id: 'other', iocs: [ip('1.1.1.1')] })
    expect(sharedIndicatorLinks(bare, [bare, other])).toEqual([])
    const solo = makeTask({ id: 'solo', iocs: [ip('1.1.1.1')] })
    expect(sharedIndicatorLinks(solo, [solo])).toEqual([])
  })

  it('duplicate values on either side count once', () => {
    const me = makeTask({ id: 'me', iocs: [ip('1.2.3.4'), ip('1.2.3.4')] })
    const other = makeTask({ id: 'o', iocs: [ip('1.2.3.4'), ip('1.2.3.4')] })
    expect(sharedIndicatorLinks(me, [me, other])).toEqual([{ task: other, shared: 1 }])
  })
})

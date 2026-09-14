import { describe, expect, it } from 'vitest'
import { makeProject, makeTask } from '../types'
import { hydrateTaskFromFile } from './YamlHydrator'
import { parseFrontmatter } from './YamlParser'
import { serializeTask } from './YamlSerializer'

const project = makeProject('Test', 'Projects/Test.md')

function roundTrip(md: string) {
  const { frontmatter, body } = parseFrontmatter(md)
  if (!frontmatter) throw new Error('frontmatter missing')
  return hydrateTaskFromFile(frontmatter, body, 'Projects/Tasks/Test/task.md')
}

describe('flagged round-trip', () => {
  it('a flagged task serializes flagged: true and hydrates back flagged', () => {
    const md = serializeTask(makeTask({ id: 't1', flagged: true }), project, null)
    expect(md).toContain('flagged: true')
    expect(roundTrip(md).task.flagged).toBe(true)
  })

  it('an unflagged task emits no flagged key and hydrates to false', () => {
    const md = serializeTask(makeTask({ id: 't2' }), project, null)
    expect(md).not.toContain('flagged')
    expect(roundTrip(md).task.flagged).toBe(false)

    // false written explicitly (a toggle-off patch) round-trips the same way.
    const mdFalse = serializeTask(makeTask({ id: 't3', flagged: false }), project, null)
    expect(mdFalse).not.toContain('flagged')
    expect(roundTrip(mdFalse).task.flagged).toBe(false)
  })

  it('anything not literally true in frontmatter hydrates to false, never captured as extra', () => {
    const md = ['---', 'pm-task: true', 'id: t4', 'title: X', 'flagged: yes', '---', ''].join('\n')
    const { task } = roundTrip(md)
    expect(task.flagged).toBe(false)
    // flagged is an owned key: a stray value must not survive via extraFrontmatter.
    expect(task.extraFrontmatter?.flagged).toBeUndefined()
  })
})

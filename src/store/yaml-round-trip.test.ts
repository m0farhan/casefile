import { describe, expect, it } from 'vitest'
import { makeProject, makeTask, type Project, type SavedView, type Task } from '../types'
import { hydrateProjectFromFrontmatter, hydrateTaskFromFile } from './YamlHydrator'
import { parseFrontmatter } from './YamlParser'
import { serializeProject, serializeTask, taskFilePath } from './YamlSerializer'

function roundTripTask(
  t: Task,
  project: Project = makeProject('Test', 'Projects/Test.md'),
  parent: Task | null = null
) {
  const md = serializeTask(t, project, parent)
  const { frontmatter, body } = parseFrontmatter(md)
  if (!frontmatter) throw new Error('frontmatter missing')
  return hydrateTaskFromFile(frontmatter, body, 'Projects/Tasks/Test/task.md')
}

function roundTripProject(p: Project) {
  const md = serializeProject(p)
  const { frontmatter, body } = parseFrontmatter(md)
  if (!frontmatter) throw new Error('frontmatter missing')
  return {
    project: hydrateProjectFromFrontmatter(frontmatter, body, p.filePath, 'Test'),
    frontmatter
  }
}

describe('task round-trip', () => {
  it('preserves core scheduling and metadata fields', () => {
    const original = makeTask({
      id: 'task-1',
      title: 'Design API',
      description: 'Draft the endpoints.',
      status: 'in-progress',
      priority: 'high',
      start: '2026-04-01',
      due: '2026-04-10',
      progress: 50,
      assignees: ['Alice', 'Bob'],
      tags: ['api', 'design'],
      dependencies: ['dep-1']
    })
    const { task, subtaskIds, parentId } = roundTripTask(original)

    expect(task.id).toBe(original.id)
    expect(task.title).toBe(original.title)
    expect(task.description).toBe(original.description)
    expect(task.status).toBe(original.status)
    expect(task.priority).toBe(original.priority)
    expect(task.start).toBe(original.start)
    expect(task.due).toBe(original.due)
    expect(task.progress).toBe(original.progress)
    expect(task.assignees).toEqual(original.assignees)
    expect(task.tags).toEqual(original.tags)
    expect(task.dependencies).toEqual(original.dependencies)
    expect(subtaskIds).toEqual([])
    expect(parentId).toBeNull()
  })

  it('records subtaskIds and parentId when present', () => {
    const child = makeTask({ id: 'child-1' })
    const parent = makeTask({ id: 'parent-1', subtasks: [child] })
    const project = makeProject('Test', 'Projects/Test.md')

    const top = roundTripTask(parent, project, null)
    expect(top.subtaskIds).toEqual(['child-1'])
    expect(top.parentId).toBeNull()

    const nested = roundTripTask(child, project, parent)
    expect(nested.subtaskIds).toEqual([])
    expect(nested.parentId).toBe('parent-1')
  })

  it('preserves recurrence, timeEstimate, and timeLogs', () => {
    const original = makeTask({
      id: 'task-2',
      recurrence: { interval: 'weekly', every: 2 },
      timeEstimate: 8,
      timeLogs: [
        { date: '2026-04-01', hours: 2, note: 'setup' },
        { date: '2026-04-02', hours: 3.5, note: 'review' }
      ]
    })
    const { task } = roundTripTask(original)
    expect(task.recurrence).toEqual(original.recurrence)
    expect(task.timeEstimate).toBe(8)
    expect(task.timeLogs).toEqual(original.timeLogs)
  })

  it('preserves a milestone type and empty start', () => {
    const original = makeTask({ id: 'm-1', type: 'milestone', start: '', due: '2026-05-01' })
    const { task } = roundTripTask(original)
    expect(task.type).toBe('milestone')
    expect(task.start).toBe('')
    expect(task.due).toBe('2026-05-01')
  })

  it('preserves custom field values', () => {
    const original = makeTask({
      id: 'task-3',
      customFields: { impact: 'high', score: 42 }
    })
    const { task } = roundTripTask(original)
    expect(task.customFields).toEqual({ impact: 'high', score: 42 })
  })

  it('subtask wikilinks derive from sub.filePath, falling back to the exact-title filename', () => {
    const project = makeProject('P', 'Projects/P.md')
    // Pre-existing legacy-slug file kept in place: the link must follow the file, not the title.
    const legacySub = makeTask({ id: 'sub-legacy', title: 'Legacy', filePath: 'Projects/Tasks/P/legacy-12345678.md' })
    const newSub = makeTask({ id: 'sub-new', title: 'Fresh One' }) // no filePath yet
    const parent = makeTask({ id: 'parent', subtasks: [legacySub, newSub] })
    const md = serializeTask(parent, project, null)
    expect(md).toContain('[[legacy-12345678|Legacy]]')
    expect(md).toContain('[[Fresh One|Fresh One]]')
  })

  it('drops auto-generated Parent wiki-link and Subtasks section from the description', () => {
    const child = makeTask({ id: 'child' })
    const parent = makeTask({ id: 'parent-x', description: 'User-written note.', subtasks: [child] })
    const { task } = roundTripTask(parent)
    expect(task.description).toBe('User-written note.')
  })

  it('defaults missing fields to safe values', () => {
    const frontmatter: Record<string, unknown> = { id: 't-x' }
    const { task } = hydrateTaskFromFile(frontmatter, '', 'path.md')
    expect(task.title).toBe('Untitled')
    expect(task.status).toBe('todo')
    expect(task.priority).toBe('medium')
    expect(task.progress).toBe(0)
    expect(task.assignees).toEqual([])
    expect(task.dependencies).toEqual([])
    expect(task.customFields).toEqual({})
  })
})

describe('project round-trip', () => {
  it('preserves core project fields', () => {
    const p = makeProject('My Project', 'Projects/MyProject.md')
    p.description = 'A great project.'
    p.color = '#ff0000'
    p.icon = '\u{1F680}'
    p.teamMembers = ['Alice', 'Bob']

    const { project } = roundTripProject(p)
    expect(project.title).toBe('My Project')
    expect(project.description).toBe('A great project.')
    expect(project.color).toBe('#ff0000')
    expect(project.icon).toBe('\u{1F680}')
    expect(project.teamMembers).toEqual(['Alice', 'Bob'])
  })

  it('preserves saved views with filter, sortKey, and sortDir', () => {
    const p = makeProject('P', 'Projects/P.md')
    const view: SavedView = {
      id: 'v1',
      name: 'High priority',
      filter: {
        text: 'api',
        statuses: ['in-progress'],
        priorities: ['high', 'critical'],
        severities: ['sev2'],
        verdicts: [],
        assignees: ['Alice'],
        tags: ['design'],
        dueDateFilter: 'overdue',
        showArchived: false
      },
      sortKey: 'due',
      sortDir: 'desc'
    }
    p.savedViews = [view]

    const { project } = roundTripProject(p)
    expect(project.savedViews).toEqual([view])
  })

  it('records taskIds in the frontmatter', () => {
    const p = makeProject('P', 'Projects/P.md')
    p.tasks = [makeTask({ id: 't-1' }), makeTask({ id: 't-2' })]
    const { frontmatter } = roundTripProject(p)
    expect(frontmatter.taskIds).toEqual(['t-1', 't-2'])
  })

  it('dedups taskIds and body links when project.tasks has the same task twice', () => {
    const p = makeProject('P', 'Projects/P.md')
    const task = makeTask({ id: 't-dup', title: 'Dup', filePath: 'Projects/Tasks/P/dup-tdup.md' })
    p.tasks = [task, task]
    const md = serializeProject(p)
    const { frontmatter } = parseFrontmatter(md)
    if (!frontmatter) throw new Error('frontmatter missing')
    expect(frontmatter.taskIds).toEqual(['t-dup'])
    const bulletCount = md.split('\n').filter((l) => l.startsWith('- [ ] [[dup-tdup|')).length
    expect(bulletCount).toBe(1)
  })

  it('taskFilePath keeps the exact title: invalid chars -> "-", trailing dots/spaces trimmed, 60-char cap', () => {
    expect(taskFilePath('Bug Fix', 'Projects/Tasks/P')).toBe('Projects/Tasks/P/Bug Fix.md')
    // Filesystem-invalid characters are replaced with '-'.
    expect(taskFilePath('A/B:C', 'Projects/Tasks/P')).toBe('Projects/Tasks/P/A-B-C.md')
    // Wikilink-hostile characters (#^[]|) are replaced too, so links always resolve.
    expect(taskFilePath('Alert [P1] #7 | triage', 'Projects/Tasks/P')).toBe(
      'Projects/Tasks/P/Alert -P1- -7 - triage.md'
    )
    // Trailing dots/spaces are trimmed (invalid filename endings on Windows).
    expect(taskFilePath('Ends with dots...', 'Projects/Tasks/P')).toBe('Projects/Tasks/P/Ends with dots.md')
    // Long titles are capped at 60 characters.
    expect(taskFilePath('x'.repeat(70), 'Projects/Tasks/P')).toBe(`Projects/Tasks/P/${'x'.repeat(60)}.md`)
  })

  it('falls back to the file basename when title is missing', () => {
    const project = hydrateProjectFromFrontmatter({}, '', 'Projects/Fallback.md', 'Fallback')
    expect(project.title).toBe('Fallback')
    expect(project.id).toBe('Fallback')
  })
})

// On the metadataCache fast path the store passes Obsidian's live frontmatter
// object straight into these hydrators, so the result must not share container
// references with the input or an in-place edit would corrupt the cache.
describe('hydration does not alias the source frontmatter', () => {
  it('copies task array and object containers', () => {
    const fm: Record<string, unknown> = {
      id: 't1',
      title: 'Task',
      assignees: ['Alice'],
      tags: ['api'],
      dependencies: ['dep-1'],
      customFields: { sprint: 'S1' },
      recurrence: { interval: 'weekly', every: 1 },
      timeLogs: [{ date: '2026-04-01', hours: 2, note: 'init' }]
    }

    const { task } = hydrateTaskFromFile(fm, '', 'Projects/Tasks/P/task.md')
    const logs = task.timeLogs
    if (!logs) throw new Error('timeLogs missing')
    const srcLogs = fm.timeLogs as { hours: number }[]

    expect(task.assignees).not.toBe(fm.assignees)
    expect(task.tags).not.toBe(fm.tags)
    expect(task.dependencies).not.toBe(fm.dependencies)
    expect(task.customFields).not.toBe(fm.customFields)
    expect(task.recurrence).not.toBe(fm.recurrence)
    expect(logs).not.toBe(fm.timeLogs)
    expect(logs[0]).not.toBe(srcLogs[0])

    task.assignees.push('Bob')
    task.tags.push('design')
    task.dependencies.push('dep-2')
    task.customFields.priority = 'high'
    logs[0].hours = 99

    expect(fm.assignees).toEqual(['Alice'])
    expect(fm.tags).toEqual(['api'])
    expect(fm.dependencies).toEqual(['dep-1'])
    expect(fm.customFields).toEqual({ sprint: 'S1' })
    expect(srcLogs[0].hours).toBe(2)
  })

  it('copies project array containers', () => {
    const fm: Record<string, unknown> = {
      id: 'p1',
      title: 'Project',
      customFields: [{ id: 'cf1', name: 'Sprint', type: 'text' }],
      teamMembers: ['Alice']
    }

    const project = hydrateProjectFromFrontmatter(fm, '', 'Projects/P.md', 'P')

    expect(project.customFields).not.toBe(fm.customFields)
    expect(project.teamMembers).not.toBe(fm.teamMembers)

    project.customFields.push({ id: 'cf2', name: 'Points', type: 'number' })
    project.teamMembers.push('Bob')

    expect((fm.customFields as unknown[]).length).toBe(1)
    expect(fm.teamMembers).toEqual(['Alice'])
  })
})

describe('Casefile field round-trips', () => {
  it('preserves every Jira/SOC field through serialize -> hydrate', () => {
    const original = makeTask({
      id: 'gs-1',
      key: 'SOC-12',
      issueType: 'incident',
      severity: 'sev2',
      verdict: 'true-positive',
      bucket: 'this-week',
      detectedAt: '2026-07-30T08:15:00.000Z',
      respondedAt: '2026-07-30T08:40:00.000Z',
      containedAt: '2026-07-30T10:00:00.000Z',
      resolvedAt: '2026-07-30T12:30:00.000Z',
      iocs: [
        { type: 'ip', value: '45.33.12.8', note: 'C2 beacon' },
        { type: 'hash', value: 'd41d8cd98f00b204e9800998ecf8427e' } // no note: the omitted-key case
      ],
      attack: ['T1566.001', 'T1078'],
      activity: [{ at: '2026-07-30T08:40:00.000Z', field: 'status', from: 'todo', to: 'in-progress' }]
    })
    const { task } = roundTripTask(original)

    expect(task.key).toBe('SOC-12')
    expect(task.issueType).toBe('incident')
    expect(task.severity).toBe('sev2')
    expect(task.verdict).toBe('true-positive')
    expect(task.bucket).toBe('this-week')
    expect(task.detectedAt).toBe(original.detectedAt)
    expect(task.respondedAt).toBe(original.respondedAt)
    expect(task.containedAt).toBe(original.containedAt)
    expect(task.resolvedAt).toBe(original.resolvedAt)
    expect(task.iocs).toEqual(original.iocs)
    expect(task.iocs[1]).not.toHaveProperty('note') // never `note: undefined` in YAML
    expect(task.attack).toEqual(original.attack)
    expect(task.activity).toEqual(original.activity)
  })

  it('omits default-valued new fields from frontmatter (diff-clean untouched files)', () => {
    const plain = makeTask({ id: 'plain-1' })
    const project = makeProject('Test', 'Projects/Test.md')
    const md = serializeTask(plain, project, null)
    for (const absent of [
      'key:',
      'issueType:',
      'bucket:',
      'severity:',
      'verdict:',
      'detectedAt:',
      'respondedAt:',
      'containedAt:',
      'resolvedAt:',
      'iocs:',
      'attack:',
      'activity:'
    ]) {
      expect(md).not.toContain(absent)
    }
  })

  it('hydrates legacy frontmatter (no new keys) to defaults', () => {
    const legacy = makeTask({ id: 'legacy-1', title: 'Old task' })
    const project = makeProject('Test', 'Projects/Test.md')
    const md = serializeTask(legacy, project, null)
    const { frontmatter, body } = parseFrontmatter(md)
    if (!frontmatter) throw new Error('frontmatter missing')
    const { task } = hydrateTaskFromFile(frontmatter, body, 'Projects/Tasks/Test/t.md')

    expect(task.key).toBe('')
    expect(task.issueType).toBe('task')
    expect(task.bucket).toBe('none')
    expect(task.severity).toBe('')
    expect(task.verdict).toBe('')
    expect(task.iocs).toEqual([])
    expect(task.attack).toEqual([])
    expect(task.activity).toEqual([])
  })

  it('drops malformed iocs/activity entries instead of crashing', () => {
    const fm: Record<string, unknown> = {
      id: 't1',
      title: 'T',
      iocs: [{ type: 'nope', value: 'x' }, { type: 'ip' }, { type: 'ip', value: '1.2.3.4' }, 'garbage'],
      activity: [{ at: '2026-01-01T00:00:00Z', field: 'status', from: 'a', to: 'b' }, { field: 'x' }, 42]
    }
    const { task } = hydrateTaskFromFile(fm, '', 'Projects/Tasks/Test/t.md')
    expect(task.iocs).toEqual([{ type: 'ip', value: '1.2.3.4' }])
    expect(task.activity).toEqual([{ at: '2026-01-01T00:00:00Z', field: 'status', from: 'a', to: 'b' }])
    expect(task.bucket).toBe('none')
  })

  it('round-trips project keyPrefix/nextKeySeq, omitting them while keys are disabled', () => {
    const off = makeProject('NoKeys', 'Projects/NoKeys.md')
    const { frontmatter: fmOff } = roundTripProject(off)
    expect(fmOff).not.toHaveProperty('keyPrefix')
    expect(fmOff).not.toHaveProperty('nextKeySeq')

    const on = makeProject('Keyed', 'Projects/Keyed.md')
    on.keyPrefix = 'SOC'
    on.nextKeySeq = 7
    const { project } = roundTripProject(on)
    expect(project.keyPrefix).toBe('SOC')
    expect(project.nextKeySeq).toBe(7)
  })
})

describe('comments section round-trip', () => {
  it('round-trips comments alongside a subtasks section (strip-hazard case)', () => {
    const child = makeTask({ id: 'c1', title: 'Child' })
    const original = makeTask({
      id: 'cmt-1',
      description: 'Investigating the beacon.',
      comments: [
        { at: '2026-07-30 14:32', text: 'Confirmed C2 beacon to 45.33[.]12.8' },
        { at: '2026-07-30 15:10', text: 'Multi-line\nsecond line' }
      ],
      subtasks: [child]
    })
    const project = makeProject('Test', 'Projects/Test.md')
    const md = serializeTask(original, project, null)

    // Section order on disk: description, comments, link, subtasks.
    expect(md.indexOf('## Comments')).toBeGreaterThan(md.indexOf('Investigating'))
    expect(md.indexOf('Project: [[')).toBeGreaterThan(md.indexOf('## Comments'))
    expect(md.indexOf('## Subtasks')).toBeGreaterThan(md.indexOf('Project: [['))

    const { frontmatter, body } = parseFrontmatter(md)
    if (!frontmatter) throw new Error('frontmatter missing')
    const { task } = hydrateTaskFromFile(frontmatter, body, 'Projects/Tasks/Test/t.md')
    expect(task.description).toBe('Investigating the beacon.')
    expect(task.comments).toEqual(original.comments)
  })

  it('preserves foreign lines inside the comments section verbatim', () => {
    const body = [
      'Desc line.',
      '',
      '## Comments',
      '',
      '> **2026-07-30 14:32** — Real entry',
      'A hand-written stray line',
      '',
      'Project: [[Test|Test]]'
    ].join('\n')
    const { task } = hydrateTaskFromFile({ id: 'x' }, body, 'p.md')
    expect(task.comments).toEqual([
      { at: '2026-07-30 14:32', text: 'Real entry' },
      { at: '', text: 'A hand-written stray line' }
    ])
    expect(task.description).toBe('Desc line.')

    const md = serializeTask(task, makeProject('Test', 'Projects/Test.md'), null)
    expect(md).toContain('> **2026-07-30 14:32** — Real entry')
    expect(md).toContain('A hand-written stray line')
  })

  it('a task without comments emits no section', () => {
    const md = serializeTask(makeTask({ id: 'n1' }), makeProject('T', 'Projects/T.md'), null)
    expect(md).not.toContain('## Comments')
  })
})

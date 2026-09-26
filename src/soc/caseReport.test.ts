import { afterEach, describe, expect, it, vi } from 'vitest'
import { TFile, type App } from 'obsidian'
import type PMPlugin from '../main'
import { FakeVault } from '../../test/fakeVault'
import {
  DEFAULT_SETTINGS,
  DEFAULT_SEVERITIES,
  DEFAULT_STATUSES,
  DEFAULT_VERDICTS,
  makeProject,
  makeTask,
  type SlaPolicy,
  type Task
} from '../types'
import { buildHandover } from './handover'
import {
  composeCaseReport,
  copyCaseReport,
  generateCaseReport,
  inertLine,
  writeCaseReportNote,
  type CaseReportContext
} from './caseReport'

const POLICIES: Record<string, SlaPolicy> = {
  sev1: { responseMins: 60, resolutionMins: 240 }
}
const NOW = Date.parse('2026-07-30T12:00:00.000Z')

function ctxFor(tasks: Task[]): CaseReportContext {
  const project = makeProject('Cases', 'Cases/Cases.md')
  project.tasks = tasks
  return {
    project,
    statuses: DEFAULT_STATUSES,
    severities: DEFAULT_SEVERITIES,
    verdicts: DEFAULT_VERDICTS,
    ownedAssets: [],
    slaPolicies: POLICIES,
    now: NOW
  }
}

describe('composeCaseReport', () => {
  it('renders every section from a fully recorded case', () => {
    const linked = makeTask({ key: 'SOC-3', title: 'Earlier phishing wave' })
    const task = makeTask({
      key: 'SOC-12',
      title: 'Phishing email reported',
      issueType: 'incident',
      status: 'in-progress',
      severity: 'sev1',
      verdict: 'true-positive',
      bucket: 'today',
      flagged: true,
      detectedAt: '2026-07-30T08:00:00.000Z',
      respondedAt: '2026-07-30T08:30:00.000Z',
      containedAt: '2026-07-30T09:00:00.000Z',
      resolvedAt: '2026-07-30T10:00:00.000Z',
      iocs: [
        { type: 'url', value: 'http://evil.example.com/login', note: 'credential form' },
        { type: 'ip', value: '203.0.113.7' }
      ],
      comments: [{ at: '2026-07-30 08:15', text: 'Confirmed with the user.' }],
      description: 'User reported a suspicious email.',
      links: [
        { type: 'blocks', taskId: linked.id },
        { type: 'relates-to', taskId: 'no-such-id' }
      ]
    })
    const md = composeCaseReport(task, ctxFor([task, linked]))

    expect(md).toContain('# SOC-12 Phishing email reported')
    expect(md).toContain('Status In Progress · severity Critical · verdict True Positive · bucket Today · flagged')
    expect(md).toContain('- Detected: 2026-07-30 08:00 UTC')
    expect(md).toContain('- Responded: 2026-07-30 08:30 UTC')
    expect(md).toContain('- Contained: 2026-07-30 09:00 UTC')
    expect(md).toContain('- Resolved: 2026-07-30 10:00 UTC')
    // Responded 30m into a 60m target; resolved 2h into a 4h target.
    expect(md).toContain('- Response: met (30m inside target)')
    expect(md).toContain('- Resolution: met (2h 00m inside target)')
    expect(md).toContain('| url | `hxxp://evil[.]example[.]com/login` | credential form |')
    expect(md).toContain('| ip | `203[.]0[.]113[.]7` |  |')
    expect(md).toContain('- Blocks: SOC-3 Earlier phishing wave')
    expect(md).toContain('- Relates to: missing case')
    expect(md).toContain('- 2026-07-30 08:15 — Confirmed with the user.')
    // The journal is wall-clock time next to a UTC timeline, and says so.
    expect(md).toContain('## Investigation journal\n\nEntry times are the local clock of the device')
    expect(md).toContain('## Description\n\nUser reported a suspicious email.')
    expect(md).toContain('Generated from case data on 2026-07-30 (UTC).')
    expect(md).not.toMatch(/undefined|null/)
  })

  it('defangs every indicator value — the real value never appears', () => {
    const task = makeTask({
      iocs: [
        { type: 'url', value: 'http://evil.example.com/login' },
        { type: 'ip', value: '203.0.113.7' },
        { type: 'email', value: 'crook@bad.example.org' }
      ]
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).not.toContain('evil.example.com')
    expect(md).not.toContain('203.0.113.7')
    expect(md).not.toContain('crook@bad.example.org')
    expect(md).toContain('crook[at]bad[.]example[.]org')
  })

  it('says not recorded / none recorded everywhere on an empty case', () => {
    const md = composeCaseReport(makeTask({ title: 'Loose end' }), ctxFor([]))
    expect(md).toContain('# Loose end')
    expect(md).toContain('Status To Do · severity none recorded · verdict none recorded')
    expect(md).not.toContain('· bucket')
    expect(md).not.toContain('· flagged')
    // Five phase lines now: Occurred joins the four lifecycle stamps.
    expect(md.match(/: not recorded/g)).toHaveLength(5)
    expect(md).toContain('No target set.')
    expect(md).toContain('## Indicators\n\nNone recorded.')
    expect(md).not.toContain('## Linked cases')
    expect(md).toContain('No journal entries.')
    expect(md).not.toContain('local clock')
    expect(md).toContain('## Description\n\nNone recorded.')
    expect(md).not.toMatch(/undefined|null/)
  })

  it('says why an incident with a target has no clock, instead of "No target set."', () => {
    const noStamps = makeTask({ issueType: 'incident', severity: 'sev1', createdAt: '' })
    const md = composeCaseReport(noStamps, ctxFor([noStamps]))
    expect(md).toContain('Target set — no clock: neither detection nor creation time is recorded.')
    expect(md).not.toContain('No target set.')

    const garbled = makeTask({ issueType: 'incident', severity: 'sev1', detectedAt: 'last Tuesday' })
    expect(composeCaseReport(garbled, ctxFor([garbled]))).toContain(
      'Target set — no clock: the detection time is not a readable date.'
    )
  })

  it('reports an unreadable resolved or responded time as not computable, never met or NaN', () => {
    for (const resolvedAt of ['unknown', '30/07/2026 09:00']) {
      const task = makeTask({
        issueType: 'incident',
        severity: 'sev1',
        detectedAt: '2026-07-30T08:00:00.000Z',
        resolvedAt
      })
      const md = composeCaseReport(task, ctxFor([task]))
      expect(md).toContain('Target set — not computable: the resolved time is not a readable date.')
      expect(md).not.toContain('NaN')
      expect(md).not.toContain('met (')
    }
    const task = makeTask({
      issueType: 'incident',
      severity: 'sev1',
      detectedAt: '2026-07-30T11:45:00.000Z',
      respondedAt: 'soon'
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).toContain('- Response: not computable — the responded time is not a readable date')
    expect(md).not.toContain('response time not recorded')
  })

  it('reports a stamp before the clock anchor as not computable, never met by more than the target', () => {
    const task = makeTask({
      issueType: 'incident',
      severity: 'sev1',
      status: 'done',
      detectedAt: '2026-07-30T10:00:00.000Z',
      respondedAt: '2026-07-30T08:00:00.000Z',
      resolvedAt: '2026-07-30T09:00:00.000Z'
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).toContain("the resolved time is before the clock's anchor")
    expect(md).not.toContain('inside target')
    expect(md).not.toContain('readable date')

    const open = makeTask({
      issueType: 'incident',
      severity: 'sev1',
      detectedAt: '2026-07-30T10:00:00.000Z',
      respondedAt: '2026-07-30T08:00:00.000Z'
    })
    const openMd = composeCaseReport(open, ctxFor([open]))
    expect(openMd).toContain("- Response: not computable — the responded time is before the clock's anchor")
    expect(openMd).not.toContain('inside target')
  })

  it('treats a policy with a blank (0) target as no target, not as a breach at creation', () => {
    const task = makeTask({ issueType: 'incident', severity: 'sev1', detectedAt: '2026-07-30T11:59:59.000Z' })
    const md = composeCaseReport(task, {
      ...ctxFor([task]),
      slaPolicies: { sev1: { responseMins: 0, resolutionMins: 240 } }
    })
    expect(md).toContain('No target set.')
    expect(md).not.toContain('breached')
  })

  it('keeps a defanged indicator exact inside a code span, UNC backslashes included', () => {
    const task = makeTask({
      iocs: [
        { type: 'url', value: '\\\\fileserver\\share' },
        { type: 'url', value: 'http://evil.example/__init__.py' },
        { type: 'url', value: 'https://evil.example/![a](https://3232235777/px)' }
      ]
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).toContain('| url | `[\\\\]fileserver\\share` |')
    expect(md).toContain('`hxxp://evil[.]example/__init__[.]py`')
    // The embedded image sits inside the code span, so it is text, not a fetch.
    expect(md).toMatch(/\| `[^`]*!\[a\]\(https:\/\/3232235777\/px\)[^`]*` \|/)
  })
  it('reports still-running targets on an open incident', () => {
    const task = makeTask({
      issueType: 'incident',
      severity: 'sev1',
      detectedAt: '2026-07-30T11:45:00.000Z' // 15m before NOW
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).toContain('- Response: still running (45m left)')
    expect(md).toContain('- Resolution: still running (3h 45m left)')
  })

  it('reports breaches with overshoot on a late incident', () => {
    const task = makeTask({
      issueType: 'incident',
      severity: 'sev1',
      detectedAt: '2026-07-30T06:00:00.000Z', // response due 07:00, resolution due 10:00
      respondedAt: '2026-07-30T08:00:00.000Z'
    })
    const md = composeCaseReport(task, ctxFor([task]))
    expect(md).toContain('- Response: breached (+1h 00m past target)')
    expect(md).toContain('- Resolution: breached (+2h 00m past target)')
  })

  it('omits the links section when links is absent and resolves nothing to missing case', () => {
    const noLinks = makeTask({ title: 'A' })
    expect(composeCaseReport(noLinks, ctxFor([noLinks]))).not.toContain('## Linked cases')
    const empty = makeTask({ title: 'B', links: [] })
    expect(composeCaseReport(empty, ctxFor([empty]))).not.toContain('## Linked cases')
  })
})

/** True when `token` occurs behind an even run of backslashes, so markdown reads it live. */
function live(md: string, token: string): boolean {
  for (let i = md.indexOf(token); i !== -1; i = md.indexOf(token, i + 1)) {
    let n = 0
    while (md[i - 1 - n] === '\\') n++
    if (n % 2 === 0) return true
  }
  return false
}

describe('sender-controlled titles', () => {
  const hostile = 'Invoice <img src=https://evil.example/t.png> ![[private]] ![a](https://evil.example/i.png)'

  it('are written inert into the case report and the handover', () => {
    const other = makeTask({ key: 'SOC-3', title: hostile })
    const task = makeTask({
      key: 'SOC-9',
      title: hostile,
      issueType: 'incident',
      severity: 'sev1',
      iocs: [{ type: 'url', value: 'http://evil.example/x', note: 'from <img src=https://evil.example/n.png>' }],
      links: [{ type: 'relates-to', taskId: other.id }],
      activity: [{ at: '2026-07-30T11:00:00.000Z', field: 'status', from: 'todo', to: 'in-progress' }]
    })
    const project = makeProject('Cases', 'Cases/Cases.md')
    project.tasks = [task, other]
    const outputs = [
      composeCaseReport(task, ctxFor([task, other])),
      buildHandover([project], { ...DEFAULT_SETTINGS, slaPolicies: POLICIES }, '2026-07-30T12:00:00.000Z')
    ]
    for (const md of outputs) {
      expect(md).toContain('SOC-9 Invoice')
      expect(live(md, '<img')).toBe(false)
      expect(live(md, '![')).toBe(false)
      expect(live(md, '[[')).toBe(false)
    }
    expect(outputs[0]).toContain('- Relates to: SOC-3 Invoice \\<img')
  })

  it('cannot cancel the escape with a backslash of its own', () => {
    for (const title of ['\\<img src=x>', '\\\\<img src=x>', 'a\\![[b]]', '`$=dv.el("p", 1)`']) {
      const line = inertLine(title)
      expect(live(line, '<')).toBe(false)
      expect(live(line, '![')).toBe(false)
      expect(live(line, '[[')).toBe(false)
      expect(live(line, '`')).toBe(false)
    }
    // Ordinary subjects are left as they are.
    expect(inertLine('[EXTERNAL] Re: Q3 invoice #42 (urgent)')).toBe('[EXTERNAL] Re: Q3 invoice #42 (urgent)')
    expect(inertLine('C:\\Users\\bob')).toBe('C:\\Users\\bob')
  })
})

describe('writeCaseReportNote', () => {
  it('creates the report beside the case file and suffixes instead of overwriting', async () => {
    const vault = new FakeVault()
    await vault.create('Cases/Tasks/Phish.md', 'case body')
    const app = { vault } as unknown as App
    const task = makeTask({ title: 'Phish', filePath: 'Cases/Tasks/Phish.md' })

    expect(await writeCaseReportNote(app, task, 'first')).toBe('Cases/Tasks/Phish — report.md')
    expect(await writeCaseReportNote(app, task, 'second')).toBe('Cases/Tasks/Phish — report (2).md')
    expect(await writeCaseReportNote(app, task, 'third')).toBe('Cases/Tasks/Phish — report (3).md')
    const first = vault.getAbstractFileByPath('Cases/Tasks/Phish — report.md')
    expect(first).not.toBeNull()
  })

  it('returns null for a task with no file yet', async () => {
    const app = { vault: new FakeVault() } as unknown as App
    expect(await writeCaseReportNote(app, makeTask(), 'md')).toBeNull()
  })
})

describe('copyCaseReport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Fake plugin whose loadTaskBody hydrates the description, like the real store does from disk. */
  function fakePlugin(vault: FakeVault, notices: string[], boardType: 'case' | 'plain' = 'case'): PMPlugin {
    return {
      app: { vault, workspace: { openLinkText: async () => {} } },
      settings: { slaPolicies: POLICIES },
      store: {
        loadTaskBody: async (t: Task) => {
          t.description = 'Loaded from disk.'
        },
        configFor: () => ({
          boardType,
          statuses: DEFAULT_STATUSES,
          severities: DEFAULT_SEVERITIES,
          verdicts: DEFAULT_VERDICTS
        })
      },
      showNotice: (m: string) => notices.push(m)
    } as unknown as PMPlugin
  }

  it('copies exactly what generateCaseReport writes, via the shared loaded-compose step', async () => {
    const vault = new FakeVault()
    await vault.create('Cases/Tasks/Phish.md', 'case body')
    vault.resetCounts()
    const task = makeTask({ key: 'SOC-1', title: 'Phish', filePath: 'Cases/Tasks/Phish.md' })
    const project = makeProject('Cases', 'Cases/Cases.md')
    project.tasks = [task]
    const notices: string[] = []
    const plugin = fakePlugin(vault, notices)

    const copied: string[] = []
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async (s: string) => {
          copied.push(s)
        }
      }
    })

    await copyCaseReport(plugin, project, task)

    // Composed from the freshly loaded body, and the vault was never touched.
    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain('# SOC-1 Phish')
    expect(copied[0]).toContain('Loaded from disk.')
    expect(vault.createCount.size).toBe(0)
    expect(vault.modifyCount.size).toBe(0)
    expect(notices).toEqual(['Case report copied'])

    // Refactor safety: the write path produces the identical report.
    await generateCaseReport(plugin, project, task)
    const file = vault.getAbstractFileByPath('Cases/Tasks/Phish — report.md')
    if (!(file instanceof TFile)) throw new Error('report note was not created')
    expect(await vault.cachedRead(file)).toBe(copied[0])
  })

  it('refuses a plain board with the sentence saying why, and writes nothing', async () => {
    const vault = new FakeVault()
    await vault.create('Goals/Tasks/Ship it.md', 'body')
    vault.resetCounts()
    const task = makeTask({ title: 'Ship it', filePath: 'Goals/Tasks/Ship it.md' })
    const project = makeProject('Goals', 'Goals/Goals.md')
    project.tasks = [task]
    const notices: string[] = []
    const plugin = fakePlugin(vault, notices, 'plain')
    const writeText = vi.fn<(s: string) => Promise<void>>()
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await generateCaseReport(plugin, project, task)
    await copyCaseReport(plugin, project, task)

    const why = 'Goals is a plain board — case reports are for case boards.'
    expect(notices).toEqual([why, why])
    expect(vault.createCount.size).toBe(0)
    expect(writeText).not.toHaveBeenCalled()
  })
})

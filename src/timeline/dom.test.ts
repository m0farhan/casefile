import { setIcon } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import {
  CLS,
  headerShape,
  kindClass,
  kindLabel,
  linkIcon,
  renderAddEvent,
  renderGap,
  renderHeader,
  renderNode,
  renderSpawn,
  renderStepNode,
  renderUntimedChip
} from './dom'
import { findTimelines, type TimelineGap, type TimelineSummary } from './parse'

vi.mock('obsidian', () => ({ setIcon: vi.fn<() => void>() }))

const root = (): HTMLElement => FakeEl.root() as unknown as HTMLElement
const fake = (el: HTMLElement): FakeEl => el as unknown as FakeEl
const iconOf = (el: HTMLElement): string | undefined =>
  vi.mocked(setIcon).mock.calls.find(([target]) => target === el)?.[1]

const SPEC_NOTE = [
  '## Findings:',
  '%% timeline %%',
  '- On 3 May 2025, 11:04 the user was observed using Microsoft Edge',
  '- At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (fake check).',
  '    - Following the navigation, the webpage hosted a script',
  '- At 11:06:12, Execution: the user opened Run (Win+R) and pasted `powershell -w h` (T1204.004)',
  '- At 11:06:15, Download: the payload was fetched from https://promptcraft.online/a.ps1',
  '    - Source: EDR process tree',
  '- At 11:31, Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.',
  '- Response: the SOC isolated corp-wks-102 from the network.'
]

/** The steps and chain samples from the styles spec. */
const STEPS = [
  '## Alert story',
  '%% timeline steps %%',
  '- 21:34 Alert fired: Potential Recon Activity Via Nltest.EXE',
  '- On host: DESKTOP1.domain.local',
  '- User context: domain\\user1',
  '- Process launch: nltest.exe',
  '- Command executed: nltest /domain_trusts',
  '- Artifact path: C:\\Users\\user1\\Downloads\\',
  '- Details',
  '    - Alert ID: SEC-2023-0704-0001',
  '    - Time: 2023-07-04 21:34 UTC',
  '    - Host: DESKTOP1.domain.local',
  '      192.168.56.95'
]
const CHAIN = [
  '## Process chain',
  '%% timeline chain %%',
  '- Initial process: cmd.exe',
  '    - Terminal process: nltest.exe',
  '        - User context: domain\\user1',
  '            - Execution: nltest /domain_trusts'
]

const gap = (over: Partial<TimelineGap>): TimelineGap => ({
  label: '+32 s',
  long: false,
  outOfOrder: false,
  approx: false,
  dayChange: null,
  tooltip: 'Derived from 11:05:40 → 11:06:12',
  ...over
})

beforeEach(() => vi.mocked(setIcon).mockClear())

describe('kindLabel', () => {
  it('names every kind in sentence case', () => {
    expect(kindLabel('observed')).toBe('Observed')
    expect(kindLabel('web')).toBe('Web')
    expect(kindLabel('execution')).toBe('Execution')
    expect(kindLabel('file')).toBe('File / download')
    expect(kindLabel('email')).toBe('Email')
    expect(kindLabel('user')).toBe('User')
    expect(kindLabel('host')).toBe('Host')
    expect(kindLabel('detection')).toBe('Detection')
    expect(kindLabel('response')).toBe('Response')
  })

  it('gives each kind its colour class', () => {
    expect(kindClass('detection')).toBe('cf-ntl-k-detection')
  })
})

describe('renderNode', () => {
  it('fills an explicit kind and names it', () => {
    const node = renderNode(root(), 'execution', true, false)
    expect(fake(node).classes).toEqual(new Set([CLS.node, 'cf-ntl-k-execution', CLS.nodeExplicit]))
    expect(node.getAttribute('aria-label')).toBe('Execution event')
    expect(node.getAttribute('role')).toBe('img')
    expect(iconOf(node)).toBe('terminal')
  })

  it('says a kind read off the text is derived, and leaves it outlined', () => {
    const node = renderNode(root(), 'web', false, false)
    expect(fake(node).hasClass(CLS.nodeExplicit)).toBe(false)
    expect(node.getAttribute('aria-label')).toBe('Web event, kind derived from the text')
    expect(iconOf(node)).toBe('globe')
  })

  it('draws an observed event as a ring with no icon', () => {
    const node = renderNode(root(), 'observed', false, false)
    expect(node.getAttribute('aria-label')).toBe('Observed event')
    expect(iconOf(node)).toBeUndefined()
  })

  it('marks a key event', () => {
    const node = renderNode(root(), 'detection', true, true)
    expect(fake(node).hasClass(CLS.nodeKey)).toBe(true)
    expect(node.getAttribute('aria-label')).toBe('Detection event, key event')
    expect(iconOf(node)).toBe('siren')
  })

  it('uses the agreed icon for every kind', () => {
    const icons = (['file', 'email', 'user', 'host', 'response'] as const).map((k) =>
      iconOf(renderNode(root(), k, true, false))
    )
    expect(icons).toEqual(['file', 'mail', 'user', 'monitor', 'shield-check'])
    expect(kindClass('user')).toBe('cf-ntl-k-user')
    expect(renderNode(root(), 'host', true, false).getAttribute('aria-label')).toBe('Host event')
  })
})

describe('renderGap', () => {
  it('draws a short gap as a pill with the derivation as its tooltip', () => {
    const band = fake(renderGap(root(), gap({})))
    expect(band.hasClass(CLS.band)).toBe(true)
    expect(band.find(`.${CLS.gapChip}`).getText()).toBe('+32 s')
    expect(band.getAttribute('title')).toBe('Derived from 11:05:40 → 11:06:12')
  })

  it('breaks the rail for a long gap and says how long', () => {
    const band = fake(renderGap(root(), gap({ label: '25 min later', long: true })))
    expect(band.hasClass(CLS.bandLong)).toBe(true)
    expect(band.find(`.${CLS.breakMark}`).getAttribute('aria-hidden')).toBe('true')
    expect(band.find(`.${CLS.longLabel}`).getText()).toBe('25 min later')
  })

  it('flags an event earlier than the one above, with no number', () => {
    const band = fake(renderGap(root(), gap({ label: 'earlier than the event above', outOfOrder: true })))
    expect(band.hasClass(CLS.bandBack)).toBe(true)
    const chip = band.find(`.${CLS.gapChip}`)
    expect(chip.getText()).toBe('earlier than the event above')
    expect(iconOf(chip.find(`.${CLS.chipIcon}`) as unknown as HTMLElement)).toBe('arrow-up')
  })

  it('opens a day band on a date change, labelled derived', () => {
    const band = fake(renderGap(root(), gap({ label: '13 h later', long: true, dayChange: { y: 2025, m: 5, d: 4 } })))
    expect(band.hasClass(CLS.bandDay)).toBe(true)
    expect(band.find(`.${CLS.dayDate}`).getText()).toBe('4 May 2025')
    expect(band.getText()).toBe('4 May 2025 · 13 h later Derived')
    expect(band.find(`.${CLS.derived}`).getText()).toBe('Derived')
  })
})

describe('renderHeader', () => {
  const summary = findTimelines(SPEC_NOTE)[0].summary

  it('sums the timeline up, marking the span derived', () => {
    const header = fake(renderHeader(root(), summary, {}))
    expect(header.find(`.${CLS.title}`).getText()).toBe('Timeline')
    const meta = header.find(`.${CLS.meta}`)
    expect(meta.getText()).toBe('6 events · 3 May 2025 · 11:04 → 11:31 · 27 min span Derived · 1 without a time')
    expect(meta.find(`.${CLS.derived}`).getText()).toBe('Derived')
    expect(iconOf(header.find(`.${CLS.headerIcon}`) as unknown as HTMLElement)).toBe('git-commit-vertical')
  })

  it('counts live indicators, and offers Defang only when it can act', () => {
    const quiet = fake(renderHeader(root(), summary, {}))
    expect(quiet.find(`.${CLS.live}`).getText()).toBe('1 live indicator')
    expect(quiet.findAll(`.${CLS.defang}`)).toHaveLength(0)

    const onDefang = vi.fn<() => void>()
    const header = fake(renderHeader(root(), summary, { onDefang }))
    header.find(`.${CLS.defang}`).click()
    expect(onDefang).toHaveBeenCalledOnce()
    expect(header.find(`.${CLS.live}`).getText()).toBe('1 live indicator · Defang')
  })

  it('leaves out what the summary does not have', () => {
    const bare: TimelineSummary = {
      count: 1,
      date: null,
      dateText: null,
      first: null,
      last: null,
      span: null,
      untimed: 1,
      live: 0
    }
    const header = fake(renderHeader(root(), bare, {}))
    expect(header.find(`.${CLS.meta}`).getText()).toBe('1 event · 1 without a time')
    expect(header.findAll(`.${CLS.live}`)).toHaveLength(0)
    expect(header.findAll(`.${CLS.derived}`)).toHaveLength(0)
  })

  it('shows one time once and pluralises live indicators', () => {
    const one: TimelineSummary = {
      count: 2,
      date: null,
      dateText: null,
      first: '11:04',
      last: '11:04',
      span: null,
      untimed: 0,
      live: 2
    }
    const header = fake(renderHeader(root(), one, {}))
    expect(header.find(`.${CLS.meta}`).getText()).toBe('2 events · 11:04')
    expect(header.find(`.${CLS.live}`).getText()).toBe('2 live indicators')
  })

  it('opens the timeline menu from its button', () => {
    const onMenu = vi.fn<(e: MouseEvent) => void>()
    const header = fake(renderHeader(root(), summary, { onMenu }))
    const button = header.find(`.${CLS.menu}`)
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('aria-label')).toBe('Timeline menu')
    expect(iconOf(button as unknown as HTMLElement)).toBe('more-horizontal')
    const click = fakeEvent('click')
    button.dispatchEvent(click)
    expect(onMenu).toHaveBeenCalledWith(click)
  })

  it('has no menu button without a menu', () => {
    expect(fake(renderHeader(root(), summary, {})).findAll(`.${CLS.menu}`)).toHaveLength(0)
  })
})

describe('renderUntimedChip', () => {
  it('says the time was not recorded, and why when a token was not read', () => {
    const chip = fake(renderUntimedChip(root()))
    expect(chip.getText()).toBe('Time not recorded')
    expect(chip.hasAttribute('title')).toBe(false)
    const unread = fake(renderUntimedChip(root(), '03/05/2025'))
    expect(unread.getAttribute('title')).toBe('Not read as a time: 03/05/2025')
  })
})

describe('renderAddEvent', () => {
  it('is a button that adds an event by click, Enter or Space', () => {
    const onClick = vi.fn<() => void>()
    const row = fake(renderAddEvent(root(), onClick))
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('tabindex')).toBe('0')
    expect(row.getText()).toBe('Add event')
    row.click()
    const enter = fakeEvent('keydown', { key: 'Enter' })
    row.dispatchEvent(enter)
    row.dispatchEvent(fakeEvent('keydown', { key: ' ' }))
    row.dispatchEvent(fakeEvent('keydown', { key: 'a' }))
    expect(onClick).toHaveBeenCalledTimes(3)
    expect(enter.defaultPrevented).toBe(true)
  })

  it('names what it adds in each style', () => {
    expect(fake(renderAddEvent(root(), () => {}, 'Add step')).getText()).toBe('Add step')
  })
})

describe('renderHeader for steps and chains', () => {
  it('heads a steps list with its own icon and title, and counts the steps', () => {
    const block = findTimelines(STEPS)[0]
    const header = fake(renderHeader(root(), block.summary, {}, headerShape(block)))
    expect(header.find(`.${CLS.title}`).getText()).toBe('Steps')
    expect(iconOf(header.find(`.${CLS.headerIcon}`) as unknown as HTMLElement)).toBe('list-ordered')
    // The Details bullet is no step: it holds the facts below.
    expect(header.find(`.${CLS.meta}`).getText()).toBe('6 steps · details below')
  })

  it('says nothing of details when a steps list has none, and counts one step as one', () => {
    const one = findTimelines(['%% timeline steps %%', '- Alert fired: x'])[0]
    expect(
      fake(renderHeader(root(), one.summary, {}, headerShape(one)))
        .find(`.${CLS.meta}`)
        .getText()
    ).toBe('1 step')
  })

  it('heads a chain with its links and spawns', () => {
    const block = findTimelines(CHAIN)[0]
    const header = fake(renderHeader(root(), block.summary, {}, headerShape(block)))
    expect(header.find(`.${CLS.title}`).getText()).toBe('Process chain')
    expect(iconOf(header.find(`.${CLS.headerIcon}`) as unknown as HTMLElement)).toBe('git-fork')
    expect(header.find(`.${CLS.meta}`).getText()).toBe('4 links · 3 spawns')
    const lone = findTimelines(['%% timeline chain %%', '- Initial process: cmd.exe'])[0]
    expect(
      fake(renderHeader(root(), lone.summary, {}, headerShape(lone)))
        .find(`.${CLS.meta}`)
        .getText()
    ).toBe('1 link')
    const two = findTimelines(['%% timeline chain %%', '- a', '    - b'])[0]
    expect(
      fake(renderHeader(root(), two.summary, {}, headerShape(two)))
        .find(`.${CLS.meta}`)
        .getText()
    ).toBe('2 links · 1 spawn')
  })

  it('keeps the live pill, Defang and the menu in every style', () => {
    const block = findTimelines(['%% timeline chain %%', '- Fetched: https://promptcraft.online/a.ps1'])[0]
    const onDefang = vi.fn<() => void>()
    const onMenu = vi.fn<(e: MouseEvent) => void>()
    const header = fake(renderHeader(root(), block.summary, { onDefang, onMenu }, headerShape(block)))
    expect(header.find(`.${CLS.live}`).getText()).toBe('1 live indicator · Defang')
    header.find(`.${CLS.defang}`).click()
    expect(onDefang).toHaveBeenCalledOnce()
    expect(header.findAll(`.${CLS.menu}`)).toHaveLength(1)
  })

  it('reads an events timeline as before', () => {
    expect(headerShape(findTimelines(SPEC_NOTE)[0])).toEqual({ style: 'events' })
    const block = findTimelines(SPEC_NOTE)[0]
    const header = fake(renderHeader(root(), block.summary, {}, headerShape(block)))
    expect(header.find(`.${CLS.title}`).getText()).toBe('Timeline')
    expect(header.find(`.${CLS.meta}`).getText()).toContain('6 events · 3 May 2025')
  })
})

describe('renderStepNode', () => {
  it('numbers a step on the rail in place of its bullet', () => {
    const node = fake(renderStepNode(root(), 3))
    expect(node.classes).toEqual(new Set([CLS.node, CLS.stepNode]))
    expect(node.getText()).toBe('3')
  })
})

describe('linkIcon', () => {
  const links = findTimelines(CHAIN)[0].links
  it('draws a run program as the root terminal or a child activity, a user as a person', () => {
    expect(links.map(linkIcon)).toEqual(['terminal', 'activity', 'user', 'activity'])
  })

  it('names other values by their shape, and anything else with a dot', () => {
    const icons = (values: string[]) =>
      findTimelines(['%% timeline chain %%', ...values.map((v) => `- Link: ${v}`)])[0].links.map(linkIcon)
    expect(icons(['https://evil.example/x', '10.0.0.5', 'C:\\Users\\a\\Downloads\\', 'just a note', 'cmd'])).toEqual([
      'globe',
      'globe',
      'file',
      'circle-dot',
      'circle-dot'
    ])
  })

  it('draws a host as a monitor', () => {
    const links = findTimelines(['%% timeline chain %%', '- On host: WS01.corp.local'])[0].links
    expect(links.map(linkIcon)).toEqual(['monitor'])
  })
})

describe('renderSpawn', () => {
  it("draws the connector to a link's child, with nothing to type", () => {
    const spawn = fake(renderSpawn(root()))
    expect(spawn.hasClass(CLS.spawn)).toBe(true)
    expect(spawn.getText()).toBe('Spawns')
    expect(iconOf(spawn.find(`.${CLS.chipIcon}`) as unknown as HTMLElement)).toBe('arrow-down')
    expect(spawn.find(`.${CLS.chipIcon}`).getAttribute('aria-hidden')).toBe('true')
  })
})

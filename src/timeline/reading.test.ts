import {
  MarkdownView,
  setIcon,
  type MarkdownPostProcessorContext,
  type MarkdownSectionInformation,
  type Plugin
} from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { copyDefanged } from '../ui/defangMenu'
import { CLS } from './dom'
import { findTimelines } from './parse'
import {
  decorateTimelineSections,
  headPieces,
  redrawOnTimelineChange,
  sectionTimeline,
  splitIndicators
} from './reading'

vi.mock('obsidian', () => ({
  setIcon: vi.fn<() => void>(),
  MarkdownView: class {
    file = null
  }
}))
vi.mock('../ui/defangMenu', () => ({ copyDefanged: vi.fn<(text: string) => void>() }))

/** Observers on the fake DOM; a test hands them nodes the way a browser reports Obsidian adding them. */
class FakeObserver {
  static made: FakeObserver[] = []
  target: FakeEl | null = null
  options: MutationObserverInit = {}
  constructor(readonly fn: (records: { addedNodes: FakeEl[] }[]) => void) {
    FakeObserver.made.push(this)
  }
  observe(target: FakeEl, options: MutationObserverInit): void {
    this.target = target
    this.options = options
  }
  disconnect(): void {
    this.target = null
  }
}
vi.stubGlobal('MutationObserver', FakeObserver)
const added = (node: FakeEl) => {
  for (const o of FakeObserver.made) {
    const watched = o.target && (o.options.subtree ? o.target.contains(node) : node.parent === o.target)
    if (watched && o.options.childList) o.fn([{ addedNodes: [node] }])
  }
}

// What the renderer uses of the DOM beyond FakeEl: child nodes and their
// type, a text node's parent, inserting before a node, prepend, and
// querySelectorAll. FakeEl keeps text nodes among its children already.
type Insertable = FakeEl | string
const asNode = (n: Insertable): FakeEl => {
  if (typeof n !== 'string') return n
  const text = new FakeEl('#text')
  text.data = n
  return text
}
Object.defineProperties(FakeEl.prototype, {
  childNodes: {
    get(this: FakeEl) {
      return this.children
    }
  },
  nodeType: {
    get(this: FakeEl) {
      return this.tagName === '#TEXT' ? 3 : 1
    }
  },
  parentElement: {
    get(this: FakeEl) {
      return this.parent
    }
  }
})
Object.assign(FakeEl.prototype, {
  after(this: FakeEl, ...nodes: Insertable[]) {
    const parent = this.parent
    if (!parent) return
    nodes
      .map(asNode)
      .reverse()
      .forEach((n) => {
        n.remove()
        n.parent = parent
        parent.children.splice(parent.children.indexOf(this) + 1, 0, n)
      })
  },
  append(this: FakeEl, ...nodes: Insertable[]) {
    for (const n of nodes) this.appendChild(asNode(n))
  },
  replaceWith(this: FakeEl, ...nodes: Insertable[]) {
    const parent = this.parent
    if (!parent) return
    const news = nodes.map(asNode)
    for (const n of news) n.remove()
    for (const n of news) n.parent = parent
    parent.children.splice(parent.children.indexOf(this), 1, ...news)
    this.parent = null
  },
  cloneNode(this: FakeEl) {
    const copy = new FakeEl(this.tagName)
    for (const c of this.classes) copy.addClass(c)
    for (const [k, v] of this.attrs) copy.setAttr(k, v)
    return copy
  },
  before(this: FakeEl, ...nodes: Insertable[]) {
    const parent = this.parent
    if (!parent) return
    for (const n of nodes.map(asNode)) {
      n.remove()
      n.parent = parent
      parent.children.splice(parent.children.indexOf(this), 0, n)
    }
  },
  prepend(this: FakeEl, ...nodes: Insertable[]) {
    nodes
      .map(asNode)
      .reverse()
      .forEach((n) => {
        n.remove()
        n.parent = this
        this.children.unshift(n)
      })
  },
  querySelectorAll(this: FakeEl, selector: string) {
    return this.findAll(selector)
  }
})

const NOTE = [
  '## Findings:',
  '%% timeline %%',
  '- On 3 May 2025, 11:04 the user was observed using Microsoft Edge',
  '- At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (fake check).',
  '    - Following the navigation, the webpage hosted a script',
  '- At 11:06:12, Execution: the user opened Run (Win+R) and pasted `powershell -w h` (T1204.004)',
  '- At 11:06:15, Download: the payload was fetched from https://promptcraft.online/a.ps1',
  '    - Source: EDR process tree',
  '- At 11:31, Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.',
  '- Response: the SOC isolated corp-wks-102 from the network.',
  '',
  'After the list.'
]

/** One rendered list item as Obsidian's reading view draws it: a bullet span, then the inline content. */
function li(parent: FakeEl, ...content: (string | ((li: FakeEl) => void))[]): FakeEl {
  const item = parent.createEl('li')
  item.createSpan({ cls: 'list-bullet' })
  for (const c of content) {
    if (typeof c === 'string') item.appendText(c)
    else c(item)
  }
  return item
}

const nested =
  (...texts: string[]) =>
  (item: FakeEl) => {
    const ul = item.createEl('ul')
    for (const t of texts) li(ul, t)
  }

/** Note text, not UI text: kept out of the sentence-case lint's sight. */
const COMMAND = 'powershell -w h'
const PAYLOAD = 'https://evil.example/payload'
const EMBEDDED = `payload at ${PAYLOAD} `

/** The list section of NOTE as rendered. */
function renderedList(): FakeEl {
  const el = FakeEl.root()
  const ul = el.createEl('ul', { cls: 'has-list-bullet' })
  li(ul, 'On 3 May 2025, 11:04 the user was observed using Microsoft Edge')
  li(
    ul,
    'At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (fake check).',
    nested('Following the navigation, the webpage hosted a script')
  )
  li(
    ul,
    'At 11:06:12, Execution: the user opened Run (Win+R) and pasted ',
    (item) => item.createEl('code', { text: COMMAND }),
    ' (T1204.004)'
  )
  li(
    ul,
    'At 11:06:15, Download: the payload was fetched from ',
    (item) =>
      item.createEl('a', {
        cls: 'external-link',
        text: 'https://promptcraft.online/a.ps1',
        attr: {
          href: 'https://promptcraft.online/a.ps1',
          target: '_blank',
          'aria-label': 'https://promptcraft.online/a.ps1'
        }
      }),
    nested('Source: EDR process tree')
  )
  li(ul, 'At 11:31, Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.')
  li(ul, 'Response: the SOC isolated corp-wks-102 from the network.')
  return el
}

const ctxFor = (info: MarkdownSectionInformation | null, sourcePath = 'Case.md'): MarkdownPostProcessorContext =>
  ({ getSectionInfo: () => info, sourcePath }) as unknown as MarkdownPostProcessorContext

const listInfo = (text = NOTE.join('\n')): MarkdownSectionInformation => ({ text, lineStart: 2, lineEnd: 9 })

function decorate(el: FakeEl, info: MarkdownSectionInformation | null = listInfo(), sourcePath?: string): FakeEl {
  decorateTimelineSections(el as unknown as HTMLElement, ctxFor(info, sourcePath))
  return el
}

const items = (el: FakeEl): FakeEl[] => el.find('ul').children.filter((c) => c.tagName === 'LI')
const plainText = (el: FakeEl): string => el.getText()

beforeEach(() => {
  vi.mocked(copyDefanged).mockClear()
  FakeObserver.made = []
})

describe('sectionTimeline', () => {
  it('finds the timeline whose list starts in the section, marker above it', () => {
    const found = sectionTimeline(NOTE.join('\n'), 2, 9)
    expect(found?.block.markerLine).toBe(1)
    expect(found?.lines[2]).toBe(NOTE[2])
  })

  it('finds it when the marker line is part of the section', () => {
    expect(sectionTimeline(NOTE.join('\n'), 1, 9)?.block.firstLine).toBe(2)
  })

  it('reads CRLF text by the same lines', () => {
    expect(sectionTimeline(NOTE.join('\r\n'), 2, 9)?.lines[2]).toBe(NOTE[2])
  })

  it('finds a timeline of every style', () => {
    expect(sectionTimeline('%% timeline steps %%\n- a', 1, 1)?.block.style).toBe('steps')
    expect(sectionTimeline('%% timeline chain %%\n- a', 1, 1)?.block.style).toBe('chain')
  })

  it('has nothing for a section that holds no timeline list', () => {
    expect(sectionTimeline(NOTE.join('\n'), 11, 11)).toBeNull()
    expect(sectionTimeline('- a plain list\n- of bullets', 0, 1)).toBeNull()
    // A marker with no list under it has nothing to draw in Reading view.
    expect(sectionTimeline('%% timeline %%\n\nText', 0, 0)).toBeNull()
  })
})

describe('headPieces', () => {
  const head = (bullet: string) => {
    const lines = ['%% timeline %%', bullet]
    const event = findTimelines(lines)[0].events[0]
    return headPieces(event, lines[1])
  }

  it('splits the lead word, the time with its seconds, and the comma', () => {
    expect(head('- At 11:05:40, the user was observed')).toEqual([
      { text: 'At', cls: CLS.lead, sec: null },
      { text: ' ', cls: null, sec: null },
      { text: '11:05:40', cls: CLS.time, sec: { from: 5, to: 8 } },
      { text: ',', cls: CLS.lead, sec: null }
    ])
  })

  it('splits a written kind into the word and its colon', () => {
    expect(head('- At 11:06:12, Execution: the user opened Run')).toEqual([
      { text: 'At', cls: CLS.lead, sec: null },
      { text: ' ', cls: null, sec: null },
      { text: '11:06:12', cls: CLS.time, sec: { from: 5, to: 8 } },
      { text: ', ', cls: CLS.lead, sec: null },
      { text: 'Execution', cls: CLS.tag, sec: null },
      { text: ':', cls: CLS.colon, sec: null }
    ])
  })

  it('keeps a date, a range and a zone in the chip as written', () => {
    expect(head('- On 3 May 2025, 11:04 the user')[2]).toEqual({ text: '3 May 2025, 11:04', cls: CLS.time, sec: null })
    expect(head('- 11:06–11:08 UTC, the user')[0]).toEqual({ text: '11:06–11:08 UTC', cls: CLS.time, sec: null })
  })

  it('marks an approximate time', () => {
    expect(head('- ~11:04 the user')).toEqual([
      { text: '~', cls: CLS.lead, sec: null },
      { text: '11:04', cls: `${CLS.time} ${CLS.approx}`, sec: null }
    ])
  })

  it('splits the kind of an untimed event, and nothing of plain prose', () => {
    expect(head('- Response: the SOC isolated the host')).toEqual([
      { text: 'Response', cls: CLS.tag, sec: null },
      { text: ':', cls: CLS.colon, sec: null }
    ])
    expect(head('- the user did a thing')).toEqual([])
  })
})

describe('splitIndicators', () => {
  it('defangs a live indicator into a chip', () => {
    expect(splitIndicators('visiting https://evil.test/a now')).toEqual([
      { text: 'visiting ', cls: null },
      { text: 'hxxps://evil[.]test/a', cls: CLS.ioc, type: 'url', live: true },
      { text: ' now', cls: null }
    ])
  })

  it('chips an indicator already defanged as written', () => {
    expect(splitIndicators('from promptcraft[.]online.')).toEqual([
      { text: 'from ', cls: null },
      { text: 'promptcraft[.]online', cls: CLS.ioc, type: 'domain', live: false },
      { text: '.', cls: null }
    ])
  })

  it('pills an ATT&CK technique', () => {
    expect(splitIndicators(' (T1204.004)')).toEqual([
      { text: ' (', cls: null },
      { text: 'T1204.004', cls: CLS.att },
      { text: ')', cls: null }
    ])
  })

  it('leaves prose alone', () => {
    expect(splitIndicators('the user opened Run')).toEqual([{ text: 'the user opened Run', cls: null }])
  })
})

describe('decorateTimelineSections', () => {
  it('leaves the list as plain bullets without section info', () => {
    const el = decorate(renderedList(), null)
    expect(el.findAll(`.${CLS.header}`)).toHaveLength(0)
    expect(el.find('ul').hasClass(CLS.list)).toBe(false)
  })

  it('leaves a section that is not a timeline untouched', () => {
    const el = decorate(renderedList(), {
      text: NOTE.join('\n').replace('%% timeline %%', ''),
      lineStart: 2,
      lineEnd: 9
    })
    expect(el.findAll(`.${CLS.header}`)).toHaveLength(0)
    expect(el.findAll(`.${CLS.item}`)).toHaveLength(0)
  })

  it('leaves the list alone when its items do not match the events', () => {
    const el = renderedList()
    items(el)[5].remove()
    decorate(el)
    expect(el.findAll(`.${CLS.item}`)).toHaveLength(0)
  })

  it('puts the header above the list and decorates every event', () => {
    const el = decorate(renderedList())
    expect(el.children[0].hasClass(CLS.header)).toBe(true)
    expect(el.children[0].find(`.${CLS.meta}`).getText()).toContain('6 events')
    expect(el.find('ul').hasClass(CLS.list)).toBe(true)
    const [first, second, third, , fifth, sixth] = items(el)
    expect([...first.classes]).toEqual([CLS.item, 'cf-ntl-k-observed'])
    expect([...third.classes]).toEqual([CLS.item, 'cf-ntl-k-execution', CLS.explicit, CLS.gap])
    expect(fifth.hasClass(CLS.gapLong)).toBe(true)
    expect(sixth.hasClass('cf-ntl-k-response')).toBe(true)
    // Band first, then the node, then the text: the order a screen reader meets them.
    expect(first.children[0].hasClass(CLS.node)).toBe(true)
    expect(second.children[0].find(`.${CLS.gapChip}`).getText()).toBe('+1 min')
    expect(second.children[1].hasClass(CLS.node)).toBe(true)
    expect(fifth.find(`.${CLS.longLabel}`).getText()).toBe('25 min later')
  })

  it('wraps the leading time, keeping the rendered text as it was', () => {
    const el = decorate(renderedList())
    const second = items(el)[1]
    const time = second.find(`.${CLS.time}`)
    expect(time.getText()).toBe('11:05:40')
    expect(time.find(`.${CLS.sec}`).getText()).toBe(':40')
    expect(second.find(`.${CLS.lead}`).getText()).toBe('At')
    const third = items(el)[2]
    expect(third.find(`.${CLS.tag}`).getText()).toBe('Execution')
    expect(third.find(`.${CLS.colon}`).getText()).toBe(':')
    const text = (item: FakeEl) =>
      item.children
        .filter((c) => !c.hasClass(CLS.node) && !c.hasClass(CLS.band) && c.tagName !== 'UL')
        .map(plainText)
        .join('')
    expect(text(second)).toBe('At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (fake check).')
    expect(text(third)).toBe(
      'At 11:06:12, Execution: the user opened Run (Win+R) and pasted powershell -w h (T1204.004)'
    )
  })

  it('chips indicators, shows live ones defanged, and pills ATT&CK ids', () => {
    const el = decorate(renderedList())
    const [, second, third, fourth] = items(el)
    expect(second.find(`.${CLS.ioc}`).getText()).toBe('hxxps://eemmbryequo[.]shop/')
    expect(third.find(`.${CLS.att}`).getText()).toBe('T1204.004')
    expect(third.find('code').getText()).toBe(COMMAND)
    const link = fourth.find('a')
    expect(link.find(`.${CLS.ioc}`).getText()).toBe('hxxps://promptcraft[.]online/a[.]ps1')
    expect(link.getAttribute('aria-label')).toBe('hxxps://promptcraft[.]online/a[.]ps1')
  })

  it('neutralises a link: a click copies it defanged and never opens it', () => {
    const el = decorate(renderedList())
    const link = items(el)[3].find('a')
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.hasAttribute('target')).toBe(false)
    expect(link.hasClass(CLS.link)).toBe(true)
    const click = fakeEvent('click')
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(copyDefanged).toHaveBeenCalledWith('https://promptcraft.online/a.ps1')
    link.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(copyDefanged).toHaveBeenCalledTimes(2)
  })

  it('leaves an internal link working', () => {
    const el = renderedList()
    items(el)[0].createEl('a', { cls: 'internal-link', text: 'Case 12', attr: { href: 'Case 12' } })
    decorate(el)
    expect(items(el)[0].find('a').getAttribute('href')).toBe('Case 12')
  })

  it('marks details and the Source footer', () => {
    const el = decorate(renderedList())
    const [, second, , fourth] = items(el)
    expect(second.find('li').hasClass(CLS.detail)).toBe(true)
    const source = fourth.find('li')
    expect(source.hasClass(CLS.source)).toBe(true)
    expect(source.children[0].hasClass(CLS.sourceIcon)).toBe(true)
  })

  it('shows "time not recorded" where an untimed event would have its time', () => {
    const el = decorate(renderedList())
    const sixth = items(el)[5]
    const content = sixth.children.filter((c) => !c.hasClass(CLS.node) && !c.hasClass('list-bullet'))
    expect(content[0].hasClass(CLS.untimed)).toBe(true)
    expect(content[1].hasClass(CLS.tag)).toBe(true)
  })

  it('skips the time wrap when the rendered text does not start as written', () => {
    const el = renderedList()
    const second = items(el)[1]
    second.children[1].data = 'At 11:05, rendered differently'
    decorate(el)
    expect(second.findAll(`.${CLS.time}`)).toHaveLength(0)
    expect(second.hasClass(CLS.item)).toBe(true)
  })

  it('finds the text inside a loose list paragraph', () => {
    const el = FakeEl.root()
    const ul = el.createEl('ul')
    const item = ul.createEl('li')
    item.createEl('p', { text: 'At 11:05:40, the user' })
    const text = ['%% timeline %%', '- At 11:05:40, the user'].join('\n')
    decorate(el, { text, lineStart: 1, lineEnd: 1 })
    expect(item.find(`.${CLS.time}`).getText()).toBe('11:05:40')
  })

  it('decorates a section only once', () => {
    const el = decorate(decorate(renderedList()))
    expect(el.findAll(`.${CLS.header}`)).toHaveLength(1)
    expect(items(el)[0].findAll(`.${CLS.node}`)).toHaveLength(1)
  })

  // Obsidian's section for this note, as its renderer draws it: an unindented
  // line continues the bullet above, so the list holds one item more than the
  // timeline, each marked with its line in the section.
  const LAZY = ['%% timeline %%', '- At 11:04 the user', 'opened the page', '- At 11:05 next']
  function lazyList(): FakeEl {
    const el = FakeEl.root()
    const ul = el.createEl('ul', { cls: 'has-list-bullet' })
    li(ul, 'At 11:04 the user\nopened the page').setAttr('data-line', '0')
    li(ul, 'At 11:05 next').setAttr('data-line', '2')
    return el
  }

  it('draws the timeline of a list Markdown runs on past it, the rest as a plain list below', () => {
    const el = decorate(lazyList(), { text: LAZY.join('\n'), lineStart: 1, lineEnd: 3 })
    expect(el.children[0].hasClass(CLS.header)).toBe(true)
    const [timeline, rest] = el.children.slice(1)
    expect(timeline.hasClass(CLS.list)).toBe(true)
    expect(timeline.children.map((c) => c.hasClass(CLS.item))).toEqual([true])
    expect(timeline.find(`.${CLS.time}`).getText()).toBe('11:04')
    expect(rest.tagName).toBe('UL')
    expect(rest.hasClass(CLS.list)).toBe(false)
    expect(rest.hasClass('has-list-bullet')).toBe(true)
    expect(rest.children.map((c) => [c.hasClass(CLS.item), c.getText()])).toEqual([[false, 'At 11:05 next']])
  })

  it('leaves the list alone when an item is not on the line of its event', () => {
    // A one-space bullet is a detail to the parser and a new item to Markdown.
    const text = ['%% timeline %%', '- At 11:04 a', ' - b', '- At 11:05 c'].join('\n')
    const el = FakeEl.root()
    const ul = el.createEl('ul')
    for (const [n, t] of ['At 11:04 a', 'b', 'At 11:05 c'].entries()) li(ul, t).setAttr('data-line', String(n))
    decorate(el, { text, lineStart: 1, lineEnd: 3 })
    expect(el.findAll(`.${CLS.item}`)).toHaveLength(0)
    expect(el.findAll(`.${CLS.header}`)).toHaveLength(0)
  })

  it('swaps an iframe in a card for an inert link that copies its page defanged', () => {
    const el = renderedList()
    items(el)[0].createEl('iframe', { attr: { src: 'https://evil.example/x' } })
    decorate(el)
    const first = items(el)[0]
    expect(first.findAll('iframe')).toHaveLength(0)
    const link = first.find(`a.${CLS.link}`)
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.getText()).toBe('hxxps://evil[.]example/x')
    link.dispatchEvent(fakeEvent('click'))
    expect(copyDefanged).toHaveBeenCalledWith('https://evil.example/x')
  })

  it('disarms an embedded note Obsidian loads into a card afterwards', () => {
    const el = decorate(renderedList())
    // Obsidian fills ![[Alert 4521]] after the post-processors ran.
    const embed = items(el)[0].createSpan({ cls: 'internal-embed' })
    const content = new FakeEl('div', 'markdown-embed-content')
    const p = content.createDiv('markdown-preview-view').createEl('p', { text: EMBEDDED })
    p.createEl('a', { cls: 'external-link', text: PAYLOAD, attr: { href: PAYLOAD, target: '_blank' } })
    p.createEl('a', { cls: 'internal-link', text: 'Case 12', attr: { href: 'Case 12' } })
    embed.appendChild(content)
    added(content)
    expect(p.children[0].data).toBe('payload at hxxps://evil[.]example/payload ')
    const [link, internal] = p.findAll('a')
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.hasClass(CLS.link)).toBe(true)
    expect(link.getText()).toBe('hxxps://evil[.]example/payload')
    link.dispatchEvent(fakeEvent('click'))
    expect(copyDefanged).toHaveBeenCalledWith(PAYLOAD)
    expect(internal.getAttribute('href')).toBe('Case 12')
  })

  it('disarms an iframe and a bare text added to a card later', () => {
    const el = decorate(renderedList())
    const first = items(el)[0]
    const frame = first.createEl('iframe', { attr: { src: 'https://evil.example/frame' } })
    added(frame)
    expect(first.findAll('iframe')).toHaveLength(0)
    expect(first.find(`a.${CLS.link}`).getText()).toBe('hxxps://evil[.]example/frame')
    first.appendText(' then https://evil.example/b')
    added(first.children[first.children.length - 1])
    expect(first.children[first.children.length - 1].data).toBe(' then hxxps://evil[.]example/b')
  })
})

describe('redrawOnTimelineChange', () => {
  const PLAIN = NOTE.filter((l) => l !== '%% timeline %%')
  // What Reading view drew is remembered per note for the session, so each test has a note of its own.
  let notes = 0
  let file = { path: '' }
  beforeEach(() => {
    file = { path: `Case ${++notes}.md` }
  })
  const drawn = (el: FakeEl, info?: MarkdownSectionInformation) => decorate(el, info, file.path)
  /** A Markdown view of the note at path, and the calls to redraw its Reading half. */
  const view = (path = file.path) => {
    const rerender = vi.fn<(full?: boolean) => void>()
    const v = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      file: { path },
      previewMode: { rerender }
    })
    redraws.set(v, rerender.mock.calls)
    return v
  }
  const redraws = new Map<MarkdownView, unknown[][]>()
  const rerendered = (v: MarkdownView) => redraws.get(v)

  /** A plugin whose workspace holds these views; the returned call fires an event the way Obsidian would. */
  function watch(...views: MarkdownView[]) {
    const handlers = new Map<string, (f: typeof file, data: string) => void>()
    const on = (name: string, fn: (f: typeof file, data: string) => void) => {
      handlers.set(name, fn)
      return {}
    }
    const plugin = {
      app: {
        workspace: {
          on,
          getLeavesOfType: (type: string) => (type === 'markdown' ? views.map((v) => ({ view: v })) : [])
        },
        metadataCache: { on }
      },
      registerEvent: vi.fn<() => void>()
    }
    redrawOnTimelineChange(plugin as unknown as Plugin)
    return (name: 'quick-preview' | 'changed', data: string[]) => handlers.get(name)?.(file, data.join('\n'))
  }

  it('redraws Reading view when a marker is added above a list it drew plain', () => {
    const shown = view()
    const other = view('Other.md')
    const fire = watch(shown, other)
    drawn(renderedList(), { text: PLAIN.join('\n'), lineStart: 1, lineEnd: 8 })
    fire('quick-preview', NOTE)
    expect(rerendered(shown)).toEqual([[true]])
    expect(rerendered(other)).toEqual([])
    // Once redrawn, an edit that keeps the timelines as they are does not redraw again.
    fire('quick-preview', [...NOTE.slice(0, 2), '- On 3 May 2025, 11:04 the user saw Edge', ...NOTE.slice(3)])
    expect(rerendered(shown)).toHaveLength(1)
  })

  it('redraws it when the marker above a drawn timeline is removed', () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList())
    fire('quick-preview', PLAIN)
    expect(rerendered(shown)).toEqual([[true]])
  })

  it('redraws it when two blank lines part the marker from its list', () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList())
    fire('quick-preview', [...NOTE.slice(0, 2), '', '', ...NOTE.slice(2)])
    expect(rerendered(shown)).toEqual([[true]])
  })

  it('redraws it for a change made outside the editor', () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList())
    fire('changed', PLAIN)
    expect(rerendered(shown)).toEqual([[true]])
  })

  it('redraws it for a change made outside the editor that Obsidian drew in part first', () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList(), { text: PLAIN.join('\n'), lineStart: 1, lineEnd: 8 })
    // The view reloads the note before the metadata cache reports it, and
    // redraws only the section that is new: the marker's empty paragraph.
    drawn(FakeEl.root(), { text: NOTE.join('\n'), lineStart: 1, lineEnd: 1 })
    fire('changed', NOTE)
    expect(rerendered(shown)).toEqual([[true]])
  })

  it("redraws it when the marker's style changes, the list as it was", () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList())
    fire(
      'quick-preview',
      NOTE.map((l) => (l === '%% timeline %%' ? '%% timeline steps %%' : l))
    )
    expect(rerendered(shown)).toEqual([[true]])
  })

  it('leaves it alone while an event is edited', () => {
    const shown = view()
    const fire = watch(shown)
    drawn(renderedList())
    fire(
      'quick-preview',
      NOTE.map((l) => l.replace('Microsoft Edge', 'Edge'))
    )
    expect(rerendered(shown)).toEqual([])
  })
})

const iconOf = (el: FakeEl): string | undefined =>
  vi.mocked(setIcon).mock.calls.find(([target]) => (target as unknown) === el)?.[1]
const onLine = (item: FakeEl, n: number): FakeEl => {
  item.setAttr('data-line', String(n))
  return item
}

/** The steps sample from the styles spec, and its list section as Obsidian renders it. */
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
const stepsInfo = (text = STEPS): MarkdownSectionInformation => ({ text: text.join('\n'), lineStart: 2, lineEnd: 12 })

function renderedSteps(): FakeEl {
  const el = FakeEl.root()
  const ul = el.createEl('ul', { cls: 'has-list-bullet' })
  STEPS.slice(2, 8).forEach((t, n) => onLine(li(ul, t.slice(2)), n))
  const details = li(ul, 'Details', (item) => {
    const facts = item.createEl('ul')
    onLine(li(facts, 'Alert ID: SEC-2023-0704-0001'), 7)
    onLine(li(facts, 'Time: 2023-07-04 21:34 UTC'), 8)
    const host = li(facts, 'Host: DESKTOP1.domain.local', (h) => {
      h.createEl('br')
      h.appendText('192.168.56.95')
    })
    onLine(host, 9)
  })
  onLine(details, 6)
  return el
}

/** The steps section drawn: its header, the steps list and the facts list below it. */
function drawnSteps() {
  const el = decorate(renderedSteps(), stepsInfo())
  const [header, list, factsList] = el.children
  return { header, list, factsList, steps: (list?.children ?? []).filter((c) => c.tagName === 'LI') }
}

describe('decorateTimelineSections: steps', () => {
  it('heads the list as steps, and counts the steps above the details', () => {
    const { header, list, steps } = drawnSteps()
    expect(header.find(`.${CLS.title}`).getText()).toBe('Steps')
    expect(header.find(`.${CLS.meta}`).getText()).toBe('6 steps · details below')
    expect([list.hasClass(CLS.list), list.hasClass(CLS.steps)]).toEqual([true, true])
    expect(steps).toHaveLength(6)
  })

  it('numbers each step, then draws its label and time over its value', () => {
    const { steps } = drawnSteps()
    expect(
      steps.map((s) => [s.hasClass(CLS.step), s.children[0].hasClass(CLS.stepNode), s.children[0].getText()])
    ).toEqual([1, 2, 3, 4, 5, 6].map((n) => [true, true, String(n)]))
    const head = steps[0].find(`.${CLS.head}`)
    expect(head.find(`.${CLS.label}`).getText()).toBe('Alert fired')
    expect(head.find(`.${CLS.time}`).getText()).toBe('21:34')
    // Label first, then the chip, as the mockup has it.
    expect(head.children.map((c) => c.getText())).toEqual(['Alert fired', '21:34'])
    const value = steps[0].find(`.${CLS.value}`)
    expect([value.getText(), value.hasClass(CLS.mono)]).toEqual(['Potential Recon Activity Via Nltest.EXE', false])
    // No time written, no chip.
    expect(steps[1].find(`.${CLS.head}`).findAll(`.${CLS.time}`)).toHaveLength(0)
  })

  it('sets a value in monospace when its shape names it', () => {
    const { steps } = drawnSteps()
    const value = (i: number) => steps[i].find(`.${CLS.value}`)
    expect([value(2).getText(), value(2).hasClass(CLS.mono)]).toEqual(['domain\\user1', true])
    expect(value(4).hasClass(CLS.mono)).toBe(true)
    // A program's file name is no host: shown as written, as Defang leaves it.
    expect([value(3).getText(), value(3).hasClass(CLS.mono)]).toEqual(['nltest.exe', true])
  })

  it('moves the details out of the steps into a grid of facts below them', () => {
    const { factsList } = drawnSteps()
    expect(factsList.tagName).toBe('UL')
    expect([factsList.hasClass(CLS.factsList), factsList.hasClass(CLS.list)]).toEqual([true, false])
    const details = factsList.find('li')
    expect(details.hasClass(CLS.facts)).toBe(true)
    expect(details.find(`.${CLS.factsTitle}`).getText()).toBe('Details')
    const facts = details.findAll(`li.${CLS.fact}`)
    expect(facts.map((f) => [f.find(`.${CLS.factKey}`).getText(), f.find(`.${CLS.value}`).getText()])).toEqual([
      ['Alert ID', 'SEC-2023-0704-0001'],
      ['Time', '2023-07-04 21:34 UTC'],
      // An internal host reaches no one outside: shown as written, as Defang timeline leaves it.
      ['Host', 'DESKTOP1.domain.local']
    ])
    // A fact's value is an identifier: monospace.
    expect(facts.map((f) => f.find(`.${CLS.value}`).hasClass(CLS.mono))).toEqual([true, true, true])
    // The plain line under Host is more of its value, on a line of its own.
    expect(facts[2].find(`.${CLS.factMore}`).getText()).toBe('192[.]168[.]56[.]95')
    expect(facts[2].findAll('br')).toHaveLength(0)
  })

  it('matches facts to their items in order when Obsidian does not mark their lines', () => {
    // A plain first line is more of the Details bullet's own text, not an item of its own.
    const lines = [
      '%% timeline steps %%',
      '- a: x',
      '- Details',
      '    seen in the console',
      '    - Host: x',
      '    - User: y'
    ]
    const e = FakeEl.root()
    const ul = e.createEl('ul')
    li(ul, 'a: x')
    li(ul, 'Details\nseen in the console', nested('Host: x', 'User: y'))
    decorate(e, { text: lines.join('\n'), lineStart: 1, lineEnd: 5 })
    const facts = e.findAll(`li.${CLS.fact}`)
    expect(facts.map((f) => f.find(`.${CLS.factKey}`).getText())).toEqual(['Host', 'User'])
  })

  it('reads a step with no label as all value', () => {
    const lines = ['%% timeline steps %%', '- the analyst closed the alert']
    const e = FakeEl.root()
    li(e.createEl('ul'), 'the analyst closed the alert')
    decorate(e, { text: lines.join('\n'), lineStart: 1, lineEnd: 1 })
    const step = e.find(`li.${CLS.step}`)
    expect(step.findAll(`.${CLS.head}`)).toHaveLength(0)
    expect(step.find(`.${CLS.value}`).getText()).toBe('the analyst closed the alert')
  })

  it('shows indicators defanged as plain text, never as chips, and disarms links', () => {
    const lines = ['%% timeline steps %%', '- Fetched: https://promptcraft.online/a.ps1 from', '- Next: x']
    const e = FakeEl.root()
    const ul = e.createEl('ul')
    li(ul, 'Fetched: ', (item) =>
      item.createEl('a', { cls: 'external-link', text: PAYLOAD, attr: { href: PAYLOAD } })
    ).appendText(' from')
    li(ul, 'Next: x')
    decorate(e, { text: lines.join('\n'), lineStart: 1, lineEnd: 2 })
    const step = e.find(`li.${CLS.step}`)
    expect(step.findAll(`.${CLS.ioc}`)).toHaveLength(0)
    expect(step.find(`.${CLS.value}`).getText()).toBe('hxxps://evil[.]example/payload from')
    expect(step.find('a').hasAttribute('href')).toBe(false)
    step.find('a').dispatchEvent(fakeEvent('click'))
    expect(copyDefanged).toHaveBeenCalledWith(PAYLOAD)
  })

  it('leaves the rendered text alone where it does not start as written', () => {
    const e = renderedSteps()
    e.find('ul').children[0].children[1].data = 'Alert fired at 21:34: rendered differently'
    decorate(e, stepsInfo())
    const first = e.find(`li.${CLS.step}`)
    expect(first.findAll(`.${CLS.head}`)).toHaveLength(0)
    expect(first.children[0].getText()).toBe('1')
  })
})

/** The chain sample from the styles spec, and its section as Obsidian renders the nested list. */
const CHAIN = [
  '## Process chain',
  '%% timeline chain %%',
  '- Initial process: cmd.exe',
  '    - Terminal process: nltest.exe',
  '        - User context: domain\\user1',
  '            - Execution: nltest /domain_trusts'
]
const chainInfo = (): MarkdownSectionInformation => ({ text: CHAIN.join('\n'), lineStart: 2, lineEnd: 5 })

function renderedChain(lines = [0, 1, 2, 3]): FakeEl {
  const el = FakeEl.root()
  let parent = el.createEl('ul', { cls: 'has-list-bullet' })
  CHAIN.slice(2).forEach((t, n) => {
    const item = onLine(li(parent, t.trim().slice(2)), lines[n])
    parent = item.createEl('ul')
  })
  return el
}

function drawnChain() {
  const el = decorate(renderedChain(), chainInfo())
  return { el, all: el.findAll('li') }
}

describe('decorateTimelineSections: process chain', () => {
  it('heads the list as a process chain, counting links and spawns', () => {
    const { el } = drawnChain()
    const header = el.children[0]
    expect(header.find(`.${CLS.title}`).getText()).toBe('Process chain')
    expect(header.find(`.${CLS.meta}`).getText()).toBe('4 links · 3 spawns')
    // cmd.exe and nltest.exe are programs, not live indicators.
    expect(header.findAll(`.${CLS.defang}`)).toHaveLength(0)
    const list = el.children[1]
    expect([list.hasClass(CLS.list), list.hasClass(CLS.chain)]).toEqual([true, true])
  })

  it('draws every link as a card, the root apart from the children it spawned', () => {
    const { all } = drawnChain()
    expect(all.map((l) => [l.hasClass(CLS.root), l.hasClass(CLS.child)])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [false, true]
    ])
    // A child's connector comes first, then its card; the links it spawned stay under it, outside the card.
    expect(all[0].children[0].hasClass(CLS.card)).toBe(true)
    expect(all.slice(1).map((l) => [l.children[0].getText(), l.children[1].hasClass(CLS.card)])).toEqual([
      ['Spawns', true],
      ['Spawns', true],
      ['Spawns', true]
    ])
    expect(all[0].find(`.${CLS.card}`).findAll('li')).toHaveLength(0)
    expect(all[1].parent?.parent).toBe(all[0])
  })

  it('puts the label and role over the value, which is monospace after its icon', () => {
    const { all } = drawnChain()
    const card = all[0].children[0]
    const head = card.find(`.${CLS.head}`)
    expect([head.find(`.${CLS.label}`).getText(), head.find(`.${CLS.role}`).getText()]).toEqual([
      'Initial process',
      'Root process'
    ])
    const value = card.find(`.${CLS.value}`)
    // A program's file name is no host: Defang leaves it, and the header does not count it.
    expect([value.getText(), value.hasClass(CLS.mono)]).toEqual(['cmd.exe', true])
    expect(all[1].find(`.${CLS.value}`).getText()).toBe('nltest.exe')
    expect(iconOf(value.find(`.${CLS.valueIcon}`))).toBe('terminal')
    expect(all.map((l) => iconOf(l.find(`.${CLS.valueIcon}`)))).toEqual(['terminal', 'activity', 'user', 'activity'])
    expect(all[3].find(`.${CLS.role}`).getText()).toBe('Spawned child')
  })

  it('disarms a link in a card, which copies it defanged and never opens it', () => {
    const lines = ['%% timeline chain %%', `- Fetched: ${PAYLOAD}`]
    const e = FakeEl.root()
    li(e.createEl('ul'), 'Fetched: ', (item) =>
      item.createEl('a', { cls: 'external-link', text: PAYLOAD, attr: { href: PAYLOAD } })
    )
    decorate(e, { text: lines.join('\n'), lineStart: 1, lineEnd: 1 })
    const link = e.find(`.${CLS.card}`).find('a')
    expect([link.hasAttribute('href'), link.hasClass(CLS.link), link.getText()]).toEqual([
      false,
      true,
      'hxxps://evil[.]example/payload'
    ])
    link.dispatchEvent(fakeEvent('click'))
    expect(copyDefanged).toHaveBeenCalledWith(PAYLOAD)
  })

  it('leaves the list alone when its nesting is not the chain the note reads', () => {
    // A link Markdown nests where the parser does not: the lines disagree.
    const e = decorate(renderedChain([0, 1, 3, 2]), chainInfo())
    expect(e.findAll(`.${CLS.header}`)).toHaveLength(0)
    expect(e.findAll(`.${CLS.card}`)).toHaveLength(0)
  })
})

describe('decorateTimelineSections: User and Host kinds', () => {
  it('colours a user or host event by its kind', () => {
    const lines = ['%% timeline %%', '- 21:34 Host: DESKTOP1', '- 21:35 the account VANTARA\\maya.chen was disabled']
    const e = FakeEl.root()
    const ul = e.createEl('ul')
    li(ul, '21:34 Host: DESKTOP1')
    li(ul, '21:35 the account VANTARA\\maya.chen was disabled')
    decorate(e, { text: lines.join('\n'), lineStart: 1, lineEnd: 2 })
    const [host, user] = e.findAll(`li.${CLS.item}`)
    expect([host.hasClass('cf-ntl-k-host'), host.find(`.${CLS.tag}`).getText()]).toEqual([true, 'Host'])
    expect(user.hasClass('cf-ntl-k-user')).toBe(true)
  })
})

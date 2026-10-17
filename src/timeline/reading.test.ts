import { MarkdownView, type MarkdownPostProcessorContext, type MarkdownSectionInformation, type Plugin } from 'obsidian'
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

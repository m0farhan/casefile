import { type App, Notice, parseLinktext } from 'obsidian'
import { opensInApp } from './attachments'
import { defangIoc } from './ioc'

/**
 * Hostile-content discipline for case text (descriptions are verbatim alert
 * pastes; journals quote attacker artefacts). Two rules, both display-only —
 * nothing on disk changes:
 *  - text that could load anything remote is shown as source, decided BEFORE
 *    rendering, because an <img src> fetches the moment it is created, so a
 *    post-DOM pass is too late (ST-3);
 *  - external links are never opened from a case view — a click copies the
 *    URL defanged instead, file:// included (ST-1, ST-2).
 *
 * The first rule used to be a list of shapes to cut out, and lists are what
 * get bypassed: nested brackets in alt text, an entity in the scheme, a
 * definition on the next line or inside a quote, a quoted `>` inside a tag,
 * `image-set()`, `<style>@import`. Nothing is cut any more. When a tag opener
 * or a non-wiki image is left outside code, the whole text is fenced
 * verbatim: every byte kept, none of it rendered, and no parse of the syntax
 * to get wrong. The price is that a description holding raw HTML or a
 * `![](…)` image shows as source. `![[embeds]]`, which the plugin writes
 * itself, are unaffected.
 */
export function scrubRemoteEmbeds(md: string): string {
  return CAN_LOAD.test(outsideCode(md)) ? fenceVerbatim(md) : md
}

/** Anything that could fetch under SOME parse: a tag opener, or an image that is not a `![[vault embed]]`. */
const CAN_LOAD = /<[a-z!/?]|!\[(?!\[)/i

/**
 * `text` as one code block. The fence is longer than any backtick run inside,
 * so nothing inside can close it, and a code block renders none of it — in
 * the plugin, in reading view, in an exported file.
 */
export function fenceVerbatim(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

/**
 * The text with its code taken out, so markup quoted inside code does not
 * fence a whole note: an analyst's `Name <a@b.com>`, the phishing report's
 * fenced HTML source, a paste quarantineMarkup already fenced. Only code that
 * the renderer cannot read any other way comes out. The first doubt stops the
 * removal and everything from there stays in, so a mistake here only ever
 * fences more.
 *
 * A fence comes out when it opens at the left margin with nothing after its
 * backticks (an info string can hand the block to another plugin's renderer)
 * at the start of a block, and closes on a line of backticks alone. Doubts:
 * any other run of three backticks or tildes, which could be a fence opening
 * or closing somewhere this scan does not see; a `$$` or `%%` anywhere on a
 * line, since either can open a block that swallows a fence line, even one
 * opened mid-line in an earlier paragraph; front matter, which can too; and an
 * unclosed fence. Line endings are read the way Obsidian's parser reads them, lone
 * `\r` included.
 */
// ponytail: fences more than a full parser would — a fence straight after a
// paragraph line, a table or emphasis near quoted markup. A full CommonMark
// parser here would fence less, and is exactly the parser differential this
// avoids: Obsidian's reading view is an older, non-CommonMark remark.
function outsideCode(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  if (/^---[ \t]*$/.test(lines[0])) return md
  const kept: string[] = []
  let para: string[] = []
  let fence = '' // the open fence's backtick run
  let fenceAt = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      if (!line.includes(fence)) continue
      if (!/^ {0,3}`+[ \t]*$/.test(line)) return [...kept, ...lines.slice(fenceAt)].join('\n')
      fence = ''
    } else if (/^[ \t]*$/.test(line)) {
      kept.push(inlineCode(para), '')
      para = []
    } else if (para.length === 0 && /^`{3,}[ \t]*$/.test(line)) {
      fence = line.trimEnd()
      fenceAt = i
    } else if (/`{3}|~{3}|\$\$|%%/.test(line)) {
      return [...kept, ...para, ...lines.slice(i)].join('\n')
    } else {
      para.push(line)
    }
  }
  if (fence) return [...kept, ...lines.slice(fenceAt)].join('\n')
  kept.push(inlineCode(para))
  return kept.join('\n')
}

/**
 * One paragraph with its certain inline code spans replaced by a space. An
 * opener is certain when nothing that starts before it can take it: nothing
 * greedy in front of it in the paragraph (emphasis, a link or wikilink,
 * strikethrough by one tilde or two, highlight, math, a comment — Obsidian's reading view scans
 * each of those for its closer without knowing about code), not glued to a
 * word a bare-URL linker could take, and closed on its own line, since a span
 * left open can pair across lines. A table splits its cells before it reads
 * code, so a table is left whole. Any doubt leaves the whole paragraph in.
 */
function inlineCode(lines: string[]): string {
  const p = lines.join('\n')
  if (lines.some((l) => /^[ \t|:-]+$/.test(l) && l.includes('|') && l.includes('-'))) return p
  let out = ''
  let from = 0
  let eol = -1
  for (let i = p.indexOf('`'); i !== -1; i = p.indexOf('`', from)) {
    if (/[*_[$~]|==|%%/.test(p.slice(from, i))) return p
    let k = i - 1
    while (k >= 0 && '("\''.includes(p[k])) k--
    if (k >= 0 && !/\s/.test(p[k])) return p
    let open = i
    while (p[open] === '`') open++
    if (eol < open) {
      eol = p.indexOf('\n', open)
      if (eol === -1) eol = p.length
    }
    let close = -1
    for (let j = p.indexOf('`', open); close === -1 && j !== -1 && j < eol;) {
      let end = j
      while (p[end] === '`') end++
      if (end - j === open - i) close = j
      else j = p.indexOf('`', end)
    }
    if (close === -1) return p
    out += `${p.slice(from, i)} `
    from = close + open - i
  }
  return out + p.slice(from)
}

/**
 * Capture-phase so Obsidian's own anchor and embed handling never sees the
 * click. With `app`, vault links and embeds are guarded too: a file Obsidian
 * cannot show itself (see opensInApp) would go to the system's default app,
 * so its path is copied instead. The generic file embed a dropped attachment
 * renders as is not an `<a>`, and opens on click, which is why embeds count.
 * Unresolved links and files Obsidian displays pass through untouched.
 */
export function neutralizeExternalLinks(el: HTMLElement, app?: App, sourcePath = ''): void {
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest?.('a') as HTMLAnchorElement | null
    if (a && !a.classList.contains('internal-link')) {
      e.preventDefault()
      e.stopPropagation()
      const href = a.getAttribute('href') ?? a.href ?? ''
      void navigator.clipboard.writeText(defangIoc(href, 'url'))
      new Notice('Link copied defanged — case notes never open links')
      return
    }
    const ref = target?.closest?.('a.internal-link, .internal-embed')
    if (!app || !ref) return
    const linktext = ref.getAttribute('data-href') || ref.getAttribute('href') || ref.getAttribute('src') || ''
    const file = app.metadataCache.getFirstLinkpathDest(parseLinktext(linktext).path, sourcePath)
    if (!file || opensInApp(file.extension)) return
    e.preventDefault()
    e.stopPropagation()
    void navigator.clipboard.writeText(file.path)
    new Notice(
      `Path copied — .${file.extension} files are not opened from a case; Obsidian would hand them to the system's default app.`
    )
  }
  el.addEventListener('click', handler, true)
  el.addEventListener('auxclick', handler, true)
}

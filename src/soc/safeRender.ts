import { Notice } from 'obsidian'
import { defangIoc } from './ioc'

/**
 * Hostile-content discipline for case text (descriptions are verbatim alert
 * pastes; journals quote attacker artefacts). Two rules, both display-only —
 * nothing on disk changes:
 *  - remote embeds are scrubbed from the markdown BEFORE rendering, because
 *    an <img src> fetches the moment it is created, so a post-DOM pass is
 *    too late (ST-3);
 *  - external links are never opened from a case view — a click copies the
 *    URL defanged instead, file:// included (ST-1, ST-2).
 */
export function scrubRemoteEmbeds(md: string): string {
  return (
    md
      .replace(/!\[([^\]]*)\]\(\s*<?((?:https?|ftp):[^)>\s]*)>?[^)]*\)/gi, (_m, _alt: string, url: string) => {
        return `[remote image not loaded: ${defangIoc(url, 'url')}]`
      })
      // Reference-style images resolve through a definition line, which the
      // inline form above never sees: `![logo][r]` plus `[r]: https://…`.
      .replace(/^[ \t]{0,3}\[[^\]]+\]:[ \t]*<?((?:https?|ftp):[^\s>]+)>?.*$/gim, (_m, url: string) => {
        return `[reference not loaded: ${defangIoc(url, 'url')}]`
      })
      // Tags that exist to load something, whatever their attributes say.
      .replace(
        /<\/?(img|image|picture|source|iframe|frame|video|audio|embed|object|link|track|svg|use|base|meta|input)\b[^>]*>/gi,
        ''
      )
      // And then the general rule, because the list above is a list and lists
      // are what get bypassed. ANY remaining tag that names a remote resource
      // goes, whatever the element is: it was `<div style="background-image:
      // url(…)">` and `<table background="…">` that walked past the old list,
      // and neither is an element anyone would think to enumerate.
      .replace(/<[a-z][^>]*>/gi, (tag) => (REMOTE_REFERENCE.test(tag) ? '' : tag))
  )
}

/**
 * A tag that reaches for something remote — by URL attribute, by CSS url(), or
 * by a protocol-relative reference that inherits whatever scheme it is opened
 * under. Matched against the tag text, so it does not care which element it is.
 */
const REMOTE_REFERENCE =
  /(?:\b(?:src|srcset|href|background|poster|data|action|formaction|xlink:href|cite|longdesc|manifest)\s*=\s*["']?\s*|url\s*\(\s*["']?\s*)(?:(?:https?|ftp):)?\/\//i

/** Capture-phase so Obsidian's own anchor handling never sees the click. */
export function neutralizeExternalLinks(el: HTMLElement): void {
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest?.('a') as HTMLAnchorElement | null
    if (!a || a.classList.contains('internal-link')) return
    e.preventDefault()
    e.stopPropagation()
    const href = a.getAttribute('href') ?? a.href ?? ''
    void navigator.clipboard.writeText(defangIoc(href, 'url'))
    new Notice('Link copied defanged — case notes never open links')
  }
  el.addEventListener('click', handler, true)
  el.addEventListener('auxclick', handler, true)
}

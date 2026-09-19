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
  return md
    .replace(/!\[([^\]]*)\]\(\s*<?((?:https?|ftp):[^)>\s]*)>?[^)]*\)/gi, (_m, _alt: string, url: string) => {
      return `[remote image not loaded: ${defangIoc(url, 'url')}]`
    })
    .replace(/<\/?(img|picture|source|iframe|frame|video|audio|embed|object|link)\b[^>]*>/gi, '')
}

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

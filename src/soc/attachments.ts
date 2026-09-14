/**
 * Pure parser: collects vault attachment references from markdown texts.
 * An attachment is an embed/link target that names a real FILE (has an
 * extension) — bare note wikilinks and external http(s) URLs are not
 * vault evidence and are excluded.
 */

/** Image extensions that get the 'image' icon in the evidence section. */
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

/** File extension of a ref (lowercase, no dot), or '' when it has none. */
export function refExtension(ref: string): string {
  const ext = ref.match(/\.([A-Za-z0-9]{1,10})$/)?.[1] ?? ''
  // Digits-only tails ("Report v2.1") are versions, not file extensions.
  return /[A-Za-z]/.test(ext) ? ext.toLowerCase() : ''
}

// Wikilink alternative first so ![[embed]] never parses as a markdown image.
const REF_PATTERN = /!?\[\[([^[\]\n]+)\]\]|!\[[^\]\n]*\]\(([^()\n]+)\)/g

/**
 * Extract attachment refs from markdown: ![[name.png]], [[file.pdf]] and
 * local ![alt](path) images. Strips |alias and #subpath parts; dedups
 * preserving first-seen order.
 */
export function extractAttachmentRefs(texts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const text of texts) {
    for (const m of text.matchAll(REF_PATTERN)) {
      let ref: string
      if (m[1] !== undefined) {
        // [[target#subpath|alias]] → target (either part order)
        ref = m[1].split('|')[0].split('#')[0].trim()
      } else {
        let path = m[2].trim()
        if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1)
        else path = path.split(/\s+/)[0] // drop a `"title"` part
        if (/^https?:\/\//i.test(path)) continue // external link, not vault evidence
        try {
          path = decodeURIComponent(path) // Obsidian encodes spaces as %20 in md paths
        } catch {
          // malformed escape — keep the raw path
        }
        ref = path.split('#')[0].trim()
      }
      if (!refExtension(ref)) continue // bare note link, not a file
      if (!seen.has(ref)) {
        seen.add(ref)
        out.push(ref)
      }
    }
  }
  return out
}

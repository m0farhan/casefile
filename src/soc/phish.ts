import { type Attachment, hashBytes, parseEml, withoutLeadingBlankLines } from './eml'
import { md5 } from './md5'
import { type HeaderAnalysis, analyseHeaders, formatHeaderReport, quoteUntrusted } from './emailHeaders'
import {
  defangIoc,
  detectIocType,
  extractIocsFromText,
  formatIocLine,
  iocKey,
  stripProseTail,
  visibleName
} from './ioc'
import { decodePercentEscapes } from './toolbox'
import { type PdfFacts, readPdf } from './pdf'
import {
  EXECUTABLE_NAME,
  type OfficeFacts,
  SCRIPT_CARRIER_NAME,
  SHORTCUT_NAME,
  entryNote,
  readZipDocument
} from './ooxml'
import { type CfbFacts, cfbNote, readCfb } from './cfb'
import { markupCensus, rtfCensus } from './markup'
import { drawableType, previewKind } from './preview'
import type { Ioc } from '../types'

/**
 * The phishing-specific reading of a mail, on top of the MIME parse.
 *
 * Same standing rule as the header reader: this module states facts and never
 * reaches a verdict. A link that unwraps to a different domain is reported as
 * unwrapping to a different domain. A .docm attachment is reported as a
 * macro-capable type. Neither is called malicious, because whether it is
 * malicious is the analyst's call and their name goes on it.
 *
 * Nothing here resolves, fetches or expands a link over the network. Every
 * unwrap is a pure string operation on a URL that was already in the mail.
 */

/** One link found in the mail, and what it turns out to point at. */
export interface LinkFinding {
  /** Exactly as written in the mail. */
  raw: string
  /** After unwrapping any gateway rewrites, percent-escapes decoded. */
  target: string
  /** The gateway that had rewritten it, when one had. */
  wrappedBy: string
  /** Host of `target`, lowercased. */
  host: string
  /**
   * The derived domain — `login.paypa1.co.uk` gives `paypa1.co.uk`: the host's
   * last two labels, or three under a two-label suffix. No public suffix list
   * is consulted, so under a hosting platform (pages.dev, github.io) it names
   * the platform, not the site's owner, and it is printed as "derived".
   */
  apexDomain: string
  /** Stated facts about the host — never a score. */
  flags: string[]
  /** Text the link was shown as, when that text is itself a URL that disagrees. */
  shownAs: string
  /**
   * The attached message whose text carries it, named as Attachment.origin
   * names it; absent for the outer message's own text. Sender text: escape it
   * with visibleName to show it.
   */
  origin?: string
}

/**
 * Gateways are matched on the HOST, never on a substring of the URL.
 *
 * Substring matching handed the attacker the label: a link to
 * `https://evil.test/?x=safelinks.protection.outlook.com&url=https://paypal.test`
 * was reported as "unwrapped from Microsoft Safe Links → paypal.test", so the
 * analysis named a brand domain as the destination of a link that goes
 * nowhere near it. The host is the only part of a URL the attacker does not
 * control on the defender's behalf.
 */
const GATEWAYS: { name: string; host: RegExp; path?: RegExp; extract(url: string): string }[] = [
  {
    name: 'Microsoft Safe Links',
    host: /(^|\.)safelinks\.protection\.outlook\.com$/i,
    extract: (url) => new URL(url).searchParams.get('url') ?? ''
  },
  {
    name: 'Google redirect',
    // Bounded. `google\.[a-z.]+$` let the suffix swallow a whole attacker
    // domain — google.evil.com matched — so a link the victim's browser sends
    // to evil.com was reported as unwrapping to whatever the attacker put in
    // the q parameter. A gateway match must be a match on the gateway.
    host: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/i,
    path: /^\/url/i,
    extract: (url) => {
      const params = new URL(url).searchParams
      return params.get('q') ?? params.get('url') ?? ''
    }
  },
  {
    name: 'Barracuda LinkProtect',
    host: /(^|\.)linkprotect\.cudasvc\.com$/i,
    extract: (url) => new URL(url).searchParams.get('a') ?? ''
  },
  {
    name: 'Proofpoint URL Defense',
    host: /(^|\.)urldefense(\.proofpoint)?\.com$/i,
    extract: (url) => {
      // v3: …/v3/__<real url>__;<base64 of replaced chars>!!…
      // indexOf, not /\/v3\/__(.+?)__;/: that lazy scan restarted at every
      // `/v3/__` and ran to the end each time, so one long link of them froze
      // the analyser for seconds. Only the leftmost start can match, because a
      // later start needs a later `__;`. Not quite the old regex: this also
      // reads across U+2028 and U+2029, which an href can carry.
      const at = url.indexOf('/v3/__')
      const end = at < 0 ? -1 : url.indexOf('__;', at + 7)
      if (end > 0) return decodePercentEscapes(url.slice(at + 6, end))
      // v2: …/v2/url?u=<url with _ for / and - for %>&d=…
      const v2 = new URL(url).searchParams.get('u')
      return v2 ? decodePercentEscapes(v2.replace(/_/g, '/').replace(/-/g, '%')) : ''
    }
  },
  {
    name: 'Mimecast',
    host: /(^|\.)protect(-[a-z0-9]+)?\.mimecast\.com$/i,
    extract: () => '' // the target is an opaque id; there is nothing to unwrap
  }
]

/**
 * Follow gateway rewrites back to the address the sender actually wrote.
 *
 * Bounded, because a wrapped link can be wrapped again (a forwarded mail that
 * passed through two gateways) and a malformed one can be built to nest
 * forever.
 */
export function unwrapUrl(url: string): { target: string; wrappedBy: string } {
  let current = url
  let wrappedBy = ''
  for (let i = 0; i < 5; i++) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      break
    }
    const host = parsed.hostname.toLowerCase()
    const gateway = GATEWAYS.find((g) => g.host.test(host) && (!g.path || g.path.test(parsed.pathname)))
    if (!gateway) break
    let next = ''
    try {
      next = gateway.extract(current)
    } catch {
      next = ''
    }
    if (!next) {
      // Recognised the wrapper but could not read a target out of it. Say which
      // wrapper it was rather than silently handing back the wrapper's own URL.
      wrappedBy = wrappedBy || gateway.name
      break
    }
    wrappedBy = wrappedBy || gateway.name
    // NOT decoded again here. searchParams.get() has already percent-decoded
    // its value, so a second pass turns `https://evil.test/?u=https%3A%2F%2Fpaypal.test`
    // into a different URL from the one the gateway actually redirects to, and
    // the row then names a host the victim never reaches. The two shapes that
    // genuinely need decoding do it in their own extract().
    current = next
  }
  return { target: current, wrappedBy }
}

/** Characters that render alike. Folded before comparing a host to a brand. */
const CONFUSABLES: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  а: 'a',
  с: 'c',
  е: 'e',
  о: 'o',
  р: 'p',
  ѕ: 's',
  х: 'x',
  і: 'i',
  ӏ: 'l',
  ο: 'o',
  ρ: 'p',
  ε: 'e',
  α: 'a',
  ν: 'v'
}

/** Fold a host to its confusable skeleton, so `paypa1` and `pаypal` meet `paypal`. */
export function skeleton(host: string): string {
  return [...host.toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join('')
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+/gi
/** Every HTML attribute that can carry a URL a click or a load will follow. */
const ATTR_RE = /\b(?:href|src|action|background|poster|formaction|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/gi
const CSS_URL_RE = /url\(\s*["']?([^)"']+)/gi
const SRCSET_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
/**
 * Anchors, with every scan BOUNDED and every tag body stopped at the next tag.
 *
 * The unbounded lazy form was quadratic: a body of anchors with no closing
 * tag made the regex engine restart the tail scan from every one of them, and
 * fifty thousand of them froze the UI thread for tens of seconds. Bounding
 * alone did not end it. `[^>]` ran on past the next `<`, so each unclosed
 * `<a href=x ` walked 2,000 characters for every `href` in reach, and a
 * shorter bare value was retried one character at a time: 100 KB of them
 * still took 18 seconds. Stopping at `<` and taking the bare value whole
 * (a shorter one reaches the same `>`, so it cannot match where the whole one
 * failed) brings every hostile shape down to milliseconds.
 *
 * An anchor with `<` or `>` inside a quoted attribute is not read for its
 * text, so it gets no "shown as" fact. That is an absence the report states,
 * never a fabricated match, and its href is still listed by ATTR_RE.
 */
const ANCHOR_RE =
  /<a\b[^<>]{0,2000}?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)(?![^\s"'>=`]))[^<>]{0,2000}?>([\s\S]{0,2000}?)<\/a>/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  sol: '/',
  commat: '@',
  colon: ':',
  period: '.',
  lpar: '(',
  rpar: ')',
  tab: '\t',
  newline: '\n',
  num: '#'
}

/**
 * Decode HTML character references.
 *
 * A browser decodes these before it follows the link, so a reader that only
 * knows `&amp;` sees a different URL from the one the victim visits — and an
 * href written entirely in `&#x2F;` and `&#64;` was dropped as "not a URL"
 * altogether, which reported a phishing mail as containing no links at all.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,10});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Remove an element AND its contents, by scanning rather than matching.
 *
 * indexOf, not a regex: a lazy `[\s\S]{0,N}?` over a multi-megabyte body with
 * many unterminated opens is the quadratic freeze ANCHOR_RE already carries a
 * comment about. Scanning is linear and obviously bounded. An unterminated
 * element swallows the rest of the document, which is the safe direction —
 * everything after an unclosed `<script` really is inside it.
 */
function dropElement(html: string, tag: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const start = findTagStart(html, lower, tag, i)
    if (start < 0) return out + html.slice(i)
    out += html.slice(i, start)
    const closeAt = findTagStart(html, lower, `/${tag}`, start + 1)
    if (closeAt < 0) return out
    i = endOfTag(html, closeAt)
  }
}

/** A tag name ends at `>`, at `/`, at whitespace, or at the end of the input. */
function nameEnds(ch: string): boolean {
  return ch === '' || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

/**
 * Index just past the tag opening at `lt`, with quoted attribute values
 * skipped — `<img alt="a > b">` ends at the LAST `>`, not the one inside the
 * quotes. Returns html.length for a tag that never closes.
 */
function endOfTag(html: string, lt: number): number {
  let quote = ''
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i] ?? ''
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i + 1
    }
  }
  return -1
}

/**
 * Remove every tag, quoted attribute values respected.
 *
 * The regex this replaces (`<[^>]{0,2000}>`) ended a tag at the first `>` it
 * saw, so `<img alt="<script>">` left a stray `">` sitting in the analyst's
 * text as if the sender had written it.
 *
 * A `<` with no `>` after it is left as the text it almost certainly is; only
 * dropElement swallows on an unterminated open, and only because everything
 * after an unclosed `<script` really is inside it.
 *
 * `between` stands in for each tag removed. The link scan passes a space, so
 * the text of two table cells is never read as one URL.
 */
function stripTags(html: string, between = ''): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) return out + html.slice(i)
    const end = endOfTag(html, lt)
    if (end < 0) return out + html.slice(i)
    out += html.slice(i, lt) + between
    i = end
  }
  return out
}

/**
 * The next REAL start of `<tag` at or after `from`, or -1.
 *
 * Two bugs lived in the plain indexOf this replaces, and both silently emptied
 * the analyst's text pane rather than failing loudly:
 *  - no name boundary, so dropping `head` also dropped every `<header>` and
 *    everything inside it. Ordinary marketing mail has one, and the lure is
 *    usually in it.
 *  - no quote awareness, so `<img alt="<script>">` looked like a script open
 *    and swallowed the document to the next real `</script`.
 * Scanning tag by tag fixes both: a match only counts where a tag can actually
 * begin, and everything between `<` and its unquoted `>` is skipped wholesale.
 */
function findTagStart(html: string, lower: string, tag: string, from: number): number {
  let i = from
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) return -1
    if (lower.startsWith(tag, lt + 1) && nameEnds(lower[lt + 1 + tag.length] ?? '')) return lt
    const end = endOfTag(html, lt)
    if (end < 0) return -1
    i = end
  }
  return -1
}

/**
 * Remove HTML comments.
 *
 * Its own pass because `<[^>]*>` gets this wrong: a comment containing `>`
 * closes early and the rest of it leaks into the text as if the victim had
 * read it. Outlook generates `<!--[if mso]>…<![endif]-->` on almost every
 * message it sends, so this is the common case, not an edge one.
 */
function dropComments(html: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const start = html.indexOf('<!--', i)
    if (start < 0) return out + html.slice(i)
    out += html.slice(i, start)
    const end = html.indexOf('-->', start + 4)
    if (end < 0) return out
    i = end + 3
  }
}

/**
 * Elements whose end means a line ended, so the text reads as it was laid out.
 * A tag body stops at the next `<` for the same reason ANCHOR_RE's does. A tag
 * these miss still loses its markup in stripTags; only its line break is lost.
 */
const BLOCK_TAGS =
  /<\s*\/?\s*(?:p|div|tr|li|ul|ol|table|thead|tbody|h[1-6]|blockquote|section|article|header|footer|td|th|pre)\b[^<>]{0,1000}>/gi
const LINE_BREAKS = /<\s*(?:br|hr)\b[^<>]{0,1000}>/gi

/**
 * The words the victim read, pulled out of the HTML body.
 *
 * NOT a render and not a parse. Nothing is handed to a DOM, nothing is
 * fetched, no stylesheet is applied and no script exists — the same inert
 * string treatment every other part of this module gives hostile markup, just
 * made legible. Most phishing is HTML-only, and the one question a lure turns
 * on is what it asks the user to do; reading that out of markup is the least
 * legible thing on a screen that renders everything else well.
 *
 * The order is the opposite of extractLinks on purpose. That decodes entities
 * FIRST so an href written in `&#x2F;` is still found. This strips first and
 * decodes last, because `&lt;click here&gt;` is text the victim SAW: decoding
 * it before the strip would turn it into a tag and delete it.
 *
 * Deliberately says nothing about whether any of this text was styled
 * invisible. Preheader text is legitimate and on nearly every marketing-shaped
 * mail, so a hidden-text flag would fire constantly — and it would be a
 * verdict wearing a fact's clothes, which is the thing this module refuses.
 */
export function htmlToText(html: string): string {
  // A break marker the document cannot contain: the source's own newlines are
  // layout, not content — a renderer collapses them to a space — so the breaks
  // WE insert at block boundaries have to be distinguishable from them after
  // the collapse. Any that somehow survive decoding are dropped first.
  const BREAK = '\u0001'
  let text = html.split(BREAK).join('')
  text = dropElement(text, 'script')
  text = dropElement(text, 'style')
  text = dropElement(text, 'noscript')
  text = dropElement(text, 'head')
  text = dropComments(text)
  text = text.replace(LINE_BREAKS, BREAK)
  text = text.replace(BLOCK_TAGS, BREAK)
  text = stripTags(text)
  text = decodeEntities(text)
  // Everything a renderer treats as whitespace collapses to one space —
  // including the source's newlines and indentation.
  text = text.replace(/[\s\u200b-\u200d]+/g, ' ')
  // Then the marked boundaries become the only real line breaks. split/join
  // rather than a regex: a control character inside one is a lint error, and
  // this reads better anyway — an empty block contributes no line.
  return text
    .split(BREAK)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
}

/** Tabs and newlines inside a URL are stripped by the parser, so strip them here too. */
function normaliseUrl(value: string): string {
  return decodeEntities(value)
    .replace(/[\t\r\n]/g, '')
    .trim()
}

/**
 * A value past its leading control bytes and spaces, for TESTING its shape
 * only. The URL parser strips that run, so `\u0001javascript:` is followed as
 * javascript:. What is shown and listed stays as written: the control byte is
 * the tell. \p{Cc} is wider than what the parser strips (DEL and C1 too), which
 * only lets such a value be listed; its scheme still comes from the parser.
 */
const stripLead = (value: string): string => value.replace(/^[\s\p{Cc}]+/u, '')

/**
 * Suffixes under which the site's own name is the THIRD label from the right,
 * beyond the rule in suffixLabels.
 *
 * ponytail: a short hand-written rule and list, not the public suffix list —
 * that is a 15k-entry file that would have to ship and be kept current, and
 * this is a heuristic feeding a stated fact, not a gate. Names the ceiling: a
 * host under a hosting platform (pages.dev, github.io) or a multi-label suffix
 * the rule does not cover gets the platform or the suffix as its derived
 * domain, which is why that line says "derived" and the Links section says
 * what it is; and a brand entry written as a domain under such a suffix is
 * compared against the suffix's label, which can state a name match that is
 * not one. The upgrade path is the public suffix list.
 */
const TWO_LABEL_SUFFIXES = new Set(['me.uk', 'id.au', 'govt.nz'])

/**
 * Second labels that make a two-letter country code a two-label suffix:
 * co.uk, com.au, co.id, com.vn, ne.jp, gob.mx and the like, in one line.
 */
const GENERIC_SECOND_LEVEL = new Set([
  'com',
  'co',
  'net',
  'org',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'go',
  'mil',
  'gob',
  'gouv',
  'ltd',
  'plc',
  'sch',
  'nic'
])

/** How many labels on the right are suffix, not the site's own name: 1, or 2 under a two-label suffix. */
function suffixLabels(parts: string[]): number {
  if (parts.length < 3) return 1
  const [second, tld] = parts.slice(-2)
  const twoLabel =
    TWO_LABEL_SUFFIXES.has(`${second}.${tld}`) || (/^[a-z]{2}$/.test(tld) && GENERIC_SECOND_LEVEL.has(second))
  return twoLabel ? 2 : 1
}

/**
 * The derived domain: `login.paypa1.co.uk` → `paypa1.co.uk`. Derived from the
 * labels alone, never checked against the public suffix list.
 */
export function apexDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length < 2) return parts.join('.')
  return parts.slice(-(suffixLabels(parts) + 1)).join('.')
}

/** The registrable-ish label: `login.paypa1.co.uk` → `paypa1`. */
function brandLabel(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length < 2) return parts[0] ?? ''
  return parts[parts.length - suffixLabels(parts) - 1]
}

/**
 * Stated facts about a host. `brands` is the analyst's own list of names worth
 * impersonating — empty by default, because a shipped brand list would be this
 * plugin deciding whose customers matter.
 *
 * `rawHost` is the authority exactly as it appeared in the mail, BEFORE the
 * URL parser normalised it. It matters: `new URL()` punycodes a Unicode host,
 * so by the time the parsed host arrives the confusable characters are already
 * gone and folding it could never match anything. Both spellings are folded.
 */
export function hostFacts(host: string, brands: string[], rawHost = ''): string[] {
  const facts: string[] = []
  const subject = (host || rawHost).replace(/\.$/, '')
  if (!subject) return facts
  if (host.endsWith('.') || rawHost.endsWith('.')) {
    facts.push('trailing dot on the host — the same site, written so it does not match a block list')
  }
  if (subject.split('.').some((label) => /^xn--/i.test(label))) {
    facts.push('punycode host — the name shown in a client may not be the name here')
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(subject)) facts.push('link points at a bare IP address, not a name')
  const labels = [brandLabel(subject), rawHost ? brandLabel(rawHost) : ''].filter(Boolean)
  const said = new Set<string>()
  for (const entry of brands) {
    // An entry may be a bare name (`paypal`) or a known-good domain
    // (`paypal.test`). Only a domain entry lets this tell the real site from
    // the same name on another TLD — with bare names alone there is nothing
    // to compare against, so that fact stays unsaid rather than firing on
    // every genuine mail from the brand.
    const isDomain = entry.includes('.')
    const brand = isDomain ? brandLabel(entry) : entry.toLowerCase()
    const target = skeleton(brand)
    if (!target) continue
    const knownGood = isDomain && (subject === entry.toLowerCase() || subject.endsWith(`.${entry.toLowerCase()}`))
    if (knownGood) continue
    for (const label of labels) {
      const folded = skeleton(label)
      let fact = ''
      if (label === brand) {
        if (!isDomain) continue
        fact = `the name "${brand}" on ${subject}, which is not ${entry} or a subdomain of it`
      } else if (folded === target) {
        fact = `reads as "${brand}" once look-alike characters are folded`
      } else if (editDistanceAtMostOne(folded, target)) {
        fact = `one character away from "${brand}"`
      }
      if (fact && !said.has(fact)) {
        said.add(fact)
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Cap on links carried into the report, so one mail cannot render forever. */
const MAX_LINKS = 500

/**
 * Every link in the mail: bare ones in the text AND in the HTML, plus every
 * URL-bearing attribute, CSS `url()` and `srcset` candidate. `limit` is how
 * many of them are read for their facts; the rest are counted.
 */
export function extractLinks(
  text: string,
  html: string,
  brands: string[],
  limit = MAX_LINKS
): { links: LinkFinding[]; dropped: number } {
  const raws = new Set<string>()
  const add = (value: string): void => {
    const url = normaliseUrl(value)
    // Any scheme, not just http(s): a mail whose only link is `data:` or
    // `javascript:` used to report "None found.", which reads as a clean mail.
    // Tested past a leading control run, which the URL parser strips: an href
    // of `&#1;javascript:` is followed as javascript: and was dropped here.
    // The value is kept as written, so the `<U+0001>` still shows.
    if (/^[a-z][a-z0-9+.-]{1,15}:/i.test(stripLead(url))) raws.add(url)
  }
  // Bare URLs in BOTH bodies. The HTML is scanned with its tags stripped, so a
  // URL sitting in visible text or in a <meta refresh> content= is not missed.
  // That scan is the ONLY one that can turn anchor TEXT into a candidate, so
  // what it contributed is remembered: a decoy label is dropped below, but
  // only when no other scan found the same URL as a real destination.
  //
  // Stripped first and decoded last, as htmlToText does, through the linear
  // quote-aware stripTags. Decoding first turned `&lt;` into a tag opener that
  // swallowed the visible URL after it, and `<[^>]{0,2000}>` cost seconds per
  // megabyte of `<`. Each tag still becomes a space, as it did under that
  // regex: glued, `https://a.test/x</td><td>more` read as a URL the mail does
  // not hold.
  //
  // ponytail: a space for every tag, inline ones too, so a URL split by `<b>`
  // is read up to the tag, as it always was. Gluing across inline tags and
  // breaking at block tags is the upgrade if a real lure needs it.
  //
  // A URL found in prose loses the punctuation the sentence put after it —
  // `“https://x.test/a”.` is a link to https://x.test/a, and the curly quote
  // Outlook types went into the link, the indicator and the case. Only here
  // and at the decoy comparison below: add() also carries attribute values,
  // and a `)` or `.` at the end of an href is part of where the click goes.
  for (const m of text.matchAll(URL_RE)) add(stripProseTail(m[0]))
  const fromVisibleText = new Set<string>()
  for (const m of decodeEntities(stripTags(html, ' ')).matchAll(URL_RE)) {
    const url = stripProseTail(m[0])
    const before = raws.size
    add(url)
    if (raws.size > before) fromVisibleText.add(normaliseUrl(url))
  }
  // Every URL an attribute carries is somewhere a click or a load goes, so a
  // decoy label equal to one of them is never dropped, whether or not the
  // anchor scan managed to read that anchor.
  const inAttributes = new Set<string>()
  for (const m of html.matchAll(ATTR_RE)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    add(value)
    inAttributes.add(normaliseUrl(value))
  }
  for (const m of html.matchAll(CSS_URL_RE)) add(m[1])
  for (const m of html.matchAll(SRCSET_RE)) {
    for (const candidate of (m[1] ?? m[2] ?? '').split(',')) add(candidate.trim().split(/\s+/)[0] ?? '')
  }

  // Anchor text that is itself a URL is compared against where the link goes.
  // Keyed on the NORMALISED href so an entity-encoded or unquoted attribute
  // still lines up with the row it belongs to.
  const shown = new Map<string, string>()
  const hrefs = new Set<string>()
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = normaliseUrl(m[1] ?? m[2] ?? m[3] ?? '')
    if (href) hrefs.add(href)
    const label = normaliseUrl(
      decodeEntities(m[4] ?? '')
        .replace(/<[^<>]{0,500}>/g, '')
        .trim()
    )
    if (href && /^https?:\/\//i.test(label)) shown.set(href, label)
  }
  // The text of an anchor is what the victim is SHOWN, not anywhere they can
  // go, so the decoy is dropped from the destination list. Only when NOTHING
  // else found it: the same string can be a decoy in one anchor and the real
  // link in the plain-text part — the URL a mail tells you to type by hand is
  // genuinely clickable in a plain-text client, and deleting it took the
  // actual phishing destination out of the links, the indicators and the case.
  // Compared as the visible-text scan recorded it, prose tail stripped, or a
  // decoy written `https://paypal.test/login.` came back as a destination.
  for (const label of shown.values()) {
    const seen = stripProseTail(label)
    if (!hrefs.has(seen) && !inAttributes.has(seen) && fromVisibleText.has(seen)) raws.delete(seen)
  }

  const all = [...raws]
  const kept = all.slice(0, Math.max(0, limit))
  const out: LinkFinding[] = []
  for (const raw of kept) {
    const { target, wrappedBy } = unwrapUrl(raw)
    let scheme = (/^([a-z][a-z0-9+.-]{1,15}):/i.exec(target)?.[1] ?? '').toLowerCase()
    // The authority as WRITTEN, before the parser punycodes or lowercases it,
    // read past the leading control run the parser strips.
    const rawHost = (
      /^[a-z][a-z0-9+.-]{1,15}:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(stripLead(target))?.[1] ?? ''
    ).toLowerCase()
    let host = ''
    let userinfo = ''
    try {
      const parsed = new URL(target)
      // The parser's own answer, not the pattern's: it strips a leading
      // control byte or space and every tab or newline, so `%01javascript:`
      // and `java%09script:` are javascript: links the pattern could not see.
      // A prefix it does not strip (DEL, NBSP) throws, and gets no scheme.
      scheme = parsed.protocol.slice(0, -1)
      host = parsed.hostname.toLowerCase()
      userinfo = parsed.username
    } catch {
      host = ''
    }
    const flags = hostFacts(host, brands, rawHost)
    if (userinfo) {
      flags.push(`text before the @ is a username, not the site — this link goes to ${host || 'an unreadable host'}`)
    }
    if (scheme && !['http', 'https'].includes(scheme)) {
      flags.push(
        scheme === 'data'
          ? 'data: URL — the page is carried inside the link itself, so there is no host to look up'
          : `${scheme}: link, not a web address`
      )
    }
    const label = shown.get(raw) ?? ''
    let labelHost = ''
    try {
      labelHost = label ? new URL(label).hostname.toLowerCase() : ''
    } catch {
      labelHost = ''
    }
    if (labelHost && labelHost !== host) {
      flags.push(`shown as a link to ${labelHost}, points at ${host || 'an unreadable host'}`)
    }
    out.push({ raw, target, wrappedBy, host, apexDomain: apexDomain(host), flags, shownAs: label })
  }
  return { links: out, dropped: all.length - kept.length }
}

const MACRO_CAPABLE = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|xls|doc|ppt)$/i
const ARCHIVE = /\.(zip|rar|7z|tar|gz|cab|ace|arj)$/i
// Its own fact: a disk image is neither a program nor a script, and calling
// it one was false. It is a container Windows opens with one double-click,
// and nothing here reads inside it.
const DISK_IMAGE = /\.(iso|img|vhdx?)$/i

/**
 * Said about an archive from its name alone. readAttachment drops it once the
 * ZIP reader has listed the entries, because the card would then say the
 * contents are not visible directly above the list of them.
 */
export const ARCHIVE_FACT = 'archive — its contents are not visible from here'

/** Said about a disk image from its name alone. */
export const DISK_IMAGE_FACT = 'disk image — the files inside it are not listed here'

/**
 * What DISK_IMAGE_FACT becomes once the ZIP reader has listed entries. Not
 * dropped, as ARCHIVE_FACT is: a ZIP at byte 0 fits in an ISO's unused first
 * 32 KB, and the file system a double-click mounts is still unread. So the
 * sentence scopes the list to the ZIP directory and keeps the caveat.
 */
export const DISK_IMAGE_AS_ZIP_FACT =
  'named as a disk image, but the bytes begin as a ZIP — the entries listed are the ZIP directory’s; a disk image file system in the same bytes is not read here'

/** Said about a part from its own headers; the Inline images heading already says it for that block. */
const INLINE_FACT = 'marked inline or given a Content-ID by its own headers'

/** Stated facts about an attachment. No scoring, no "malicious". */
export function attachmentFacts(attachment: Attachment): string[] {
  const facts: string[] = []
  const name = attachment.filename
  // The same three name lists the ZIP reader flags entries by, so a .vbe or a
  // .url says the same thing at the top level as inside an archive. A
  // shortcut, a help file or a console file is not a program, and is not
  // called one.
  if (EXECUTABLE_NAME.test(name)) facts.push('executable or script file type')
  if (SCRIPT_CARRIER_NAME.test(name)) facts.push('file type that can carry script')
  if (SHORTCUT_NAME.test(name)) facts.push('shortcut-style file type — it names another location or program to open')
  if (MACRO_CAPABLE.test(name)) facts.push('file type that can carry macros')
  if (ARCHIVE.test(name)) facts.push(ARCHIVE_FACT)
  if (DISK_IMAGE.test(name)) facts.push(DISK_IMAGE_FACT)
  // `invoice.pdf.exe` reads as a PDF in a client that hides the last extension.
  // Only what the name shows is said: Windows hides only registered
  // extensions, and `Invoice.pdf.pdf` or `scan.jpg.jpeg`, which scanners write,
  // name the same type twice, so "reads as pdf but is not" was false there.
  const doubled = /\.(pdf|doc|docx|xls|xlsx|jpg|png|txt|htm|html)\.([a-z0-9]{2,4})$/i.exec(name)
  // ponytail: jpeg/jpg and html/htm are the only alias pairs among these types.
  const kind = (ext: string): string =>
    ext
      .toLowerCase()
      .replace(/^jpeg$/, 'jpg')
      .replace(/^html$/, 'htm')
  if (doubled && kind(doubled[1]) !== kind(doubled[2])) {
    const [first, last] = [doubled[1].toLowerCase(), doubled[2].toLowerCase()]
    facts.push(
      `double extension — the name ends .${first}.${last}; with the last extension hidden it reads as .${first}`
    )
  }
  if (/[‪-‮⁦-⁩]/.test(name)) facts.push('contains a bidirectional override character')
  // Only what the part's own headers say. Nothing here checks that the body
  // actually refers to it, so "referenced by the body" was a claim no one made.
  if (attachment.inline) facts.push(INLINE_FACT)
  return facts
}

/** What an attachment turns out to be, beyond what it claims. */
export interface AttachmentReport {
  filename: string
  contentType: string
  size: number
  /** Hex, or '' when the part could not be decoded — never the empty-file hash. */
  sha256: string
  sha1: string
  /** Broken as a security hash; still the key a lot of the lookup world uses. */
  md5: string
  /** What the first bytes say it is, independent of name and declared type. */
  sniffed: string
  /**
   * The bytes are the file as it travelled, so its size and hashes are the
   * sender's. False when they were rebuilt from the part's text as read (see
   * REBUILT_FACT). True for a part that could not be decoded: it has no hashes
   * to qualify.
   */
  exact: boolean
  /**
   * The attached message this part was found inside, as Attachment.origin
   * names it; absent for the outer message's own parts. Sender text: escape
   * it with visibleName to show it.
   */
  origin?: string
  facts: string[]
  /**
   * Defanged indicators a text scan found INSIDE the file's bytes, kept
   * separate from the mail's own. A value a structure reader found (a /URI, a
   * relationship target) is shown with the structure instead, not again here.
   */
  inside: string[]
  /**
   * The decoded bytes, for the preview pane. In memory only — nothing on this
   * path writes them to disk, and formatPhishReport never emits them.
   */
  bytes: Uint8Array
  /** What a PDF's own bytes say it does and carries — present only when the bytes ARE a PDF. */
  pdf?: PdfStructure
  /** What a ZIP container lists and links to — present only when the bytes ARE a ZIP. */
  office?: OfficeStructure
  /** What a legacy OLE compound file's directory lists — present only when the bytes ARE one. */
  ole?: CfbFacts
}

/**
 * A file inside an archive, as its own bytes describe it. The bytes are not
 * kept: a report holding every inner file would hold up to 32 MB per archive
 * for a hash already taken.
 */
export interface InnerFileReport {
  /** The entry name as written. Attacker text: escape it with visibleName wherever it is shown. */
  name: string
  /** From its first bytes, or '' when they match no signature this recognises. */
  sniffed: string
  /** Where those bytes disagree with the entry's own name, or ''. */
  mismatch: string
  /** Hex, or '' when it was not read whole — a hash of part of a file is not that file's hash. */
  sha256: string
}

/** One picture lifted out of a document, with what its own bytes say it is and a hash of them. */
export interface EmbeddedImage {
  /** Where in the file it came from — a PDF byte offset, or a ZIP entry name. */
  where: string
  bytes: Uint8Array
  /** From the picture's magic bytes, never from the PDF filter name or the entry's extension. */
  sniffed: string
  sha256: string
}

export type PdfStructure = Omit<PdfFacts, 'images'> & { images: EmbeddedImage[] }
export type OfficeStructure = Omit<OfficeFacts, 'images' | 'files'> & {
  images: EmbeddedImage[]
  files: InnerFileReport[]
}

/**
 * The text of a message attached to this one — usually the reported phish —
 * kept apart from the outer message's, so the phisher's sentence is never
 * printed as the reporter's own.
 */
export interface ForwardedReport {
  /** Which attached message, as Attachment.origin names it. Sender text: escape it with visibleName to show it. */
  origin: string
  text: string
  htmlSource: string
  /** As PhishReport.htmlText: the words out of its HTML, derived. */
  htmlText: string
}

/** Everything the analyser knows about one message. */
export interface PhishReport {
  headers: HeaderAnalysis
  /** The outer message's plain-text body. The HTML body is deliberately NOT carried into the UI as markup. */
  text: string
  htmlSource: string
  /**
   * The words out of the HTML body — what the victim actually read. Empty when
   * the mail had no HTML part. Derived, never a substitute for htmlSource.
   */
  htmlText: string
  /** The bodies of attached messages, outer before inner. Their links are in `links`, each with its origin. */
  forwarded: ForwardedReport[]
  links: LinkFinding[]
  /** Links beyond the render cap, counted rather than silently dropped. */
  droppedLinks: number
  attachments: AttachmentReport[]
  /**
   * Parts marked inline by their own headers whose bytes are a drawable
   * picture. Kept apart because a signature logo among four real attachments
   * makes the list read as heavier than the mail actually is. Anything else
   * marked inline — a PDF, an archive, a part that would not decode — is an
   * attachment, because that is how Apple Mail and Gmail send attachments.
   */
  inlineImages: AttachmentReport[]
  /** Look-alike facts about the SENDER's domain, same folding the links get. */
  senderFacts: string[]
  /**
   * Defanged indicators, built from the PARSED message.
   *
   * Not from the raw paste: the raw text of a base64 body is base64, so
   * scanning it found indicators that are not in the mail and missed every
   * one that is — including, on a quoted-printable body, the phishing URL
   * itself, because a soft line break had cut it in half.
   */
  indicators: string[]
  notes: string[]
}

/**
 * What the first bytes say the file is, whatever it is named or declared.
 *
 * ponytail: a short table of the signatures that actually turn up on reported
 * mail, not a libmagic port. It answers one question — does the content agree
 * with the label — and an unrecognised file returns '' rather than a guess, so
 * the most contentMismatch can say about it is that it matches none of these.
 *
 * No label for a format this does not draw may contain "JPEG" or "image" by
 * accident of wording: drawableType keys on a leading "JPEG", and EXT_EXPECTS
 * reads /JPEG/ as the promise a .jpg makes. JPEG 2000 is a different format,
 * so it is named JP2 and J2K here.
 */
const SIGNATURES: { magic: number[]; label: string }[] = [
  { magic: [0x4d, 0x5a], label: 'Windows executable (MZ)' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: 'Linux executable (ELF)' },
  { magic: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  // Those eight bytes say compound file and nothing more: a password-protected
  // .xlsx, an .msi and the vbaProject.bin inside every .docm begin the same
  // way, and "legacy Office document" was false about all three.
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: 'OLE compound file' },
  { magic: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP archive or modern Office document' },
  { magic: [0x50, 0x4b, 0x05, 0x06], label: 'empty ZIP archive' },
  { magic: [0x52, 0x61, 0x72, 0x21], label: 'RAR archive' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7-Zip archive' },
  { magic: [0x1f, 0x8b], label: 'gzip archive' },
  { magic: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { magic: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
  { magic: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
  { magic: [0x7b, 0x5c, 0x72, 0x74, 0x66], label: 'RTF document' },
  { magic: [0x23, 0x21], label: 'script with a shebang' },
  // The whole fixed header of each: a shortcut named Invoice.pdf, a OneNote
  // file hiding a script behind its "click to view" button, and a cabinet are
  // all lures that said nothing at all while they matched no row.
  {
    magic: [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46],
    label: 'Windows shortcut (LNK)'
  },
  {
    magic: [0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3],
    label: 'OneNote document'
  },
  { magic: [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0], label: 'Microsoft cabinet (CAB)' },
  { magic: [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20], label: 'JP2 image' },
  { magic: [0xff, 0x4f, 0xff, 0x51], label: 'J2K image codestream' }
]

export function sniffType(bytes: Uint8Array): string {
  for (const signature of SIGNATURES) {
    if (signature.magic.every((byte, i) => bytes[i] === byte)) return signature.label
  }
  return ''
}

const EXT_EXPECTS: { ext: RegExp; label: RegExp }[] = [
  { ext: /\.pdf$/i, label: /PDF/ },
  { ext: /\.(docx|xlsx|pptx|zip|jar|apk)$/i, label: /ZIP/ },
  { ext: /\.(doc|xls|ppt|msg|dot|xlt|pot)$/i, label: /OLE/ },
  // The macro-capable OOXML types are ZIPs, and they are exactly the ones
  // attachmentFacts already calls out — so a .docm that is really a PE was
  // flagged as macro-capable and NOT flagged as mislabelled.
  { ext: /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam)$/i, label: /ZIP/ },
  { ext: /\.(jpg|jpeg|jfif)$/i, label: /JPEG/ },
  { ext: /\.png$/i, label: /PNG/ },
  { ext: /\.gif$/i, label: /GIF/ },
  { ext: /\.rtf$/i, label: /RTF/ },
  { ext: /\.(rar)$/i, label: /RAR/ },
  { ext: /\.7z$/i, label: /7-Zip/ },
  { ext: /\.gz$/i, label: /gzip/ },
  { ext: /\.lnk$/i, label: /LNK/ },
  { ext: /\.one$/i, label: /OneNote/ },
  { ext: /\.cab$/i, label: /cabinet/ }
]

/**
 * One fact when the bytes disagree with the name or the declared type.
 *
 * The caller passes bytes it actually has: for an empty file there are no
 * first bytes to talk about, and it does not ask.
 */
export function contentMismatch(filename: string, contentType: string, sniffed: string): string {
  const expectation = EXT_EXPECTS.find((e) => e.ext.test(filename))
  // The extension is exactly what EXT_EXPECTS matched, so it carries no sender text past its own letters.
  const ext = filename.slice(filename.lastIndexOf('.'))
  if (!sniffed) {
    // Unrecognised is a fact too, under a name or a type that promises a
    // format. An HTA, an ISO (its signature sits 32 KB in) or anything newer
    // than this table, renamed Invoice.pdf, matched no row and so drew no
    // remark at all — the silence a renamed payload is built to get.
    if (expectation) return `named ${ext} but its first bytes match no file signature this recognises`
    if (/pdf$/i.test(contentType)) {
      return `declared ${contentType} but its first bytes match no file signature this recognises`
    }
    return ''
  }
  if (expectation && !expectation.label.test(sniffed)) {
    return `named ${ext} but the bytes begin as ${sniffed}`
  }
  if (/pdf$/i.test(contentType) && !/PDF/.test(sniffed)) {
    return `declared ${contentType} but the bytes begin as ${sniffed}`
  }
  if (/^image\//i.test(contentType) && !/image/i.test(sniffed)) {
    return `declared ${contentType} but the bytes begin as ${sniffed}`
  }
  return ''
}

/** Bytes read as text for indicators, from each end of a larger file. Capped: this is a scan, not a load. */
const STRINGS_CAP = 1_000_000

/**
 * What one message's attachments may inflate between them, for pictures and
 * the files inside archives. Each container has its own 32 MB ceiling, and a
 * mail under 1 MB carrying twenty of them held 640 MB.
 */
const MESSAGE_MEDIA_BUDGET = 64_000_000

/**
 * The header block of a raw message: everything before the first blank line.
 * Blank lines ahead of the first header are skipped as parseEml skips them, or
 * one stray Enter before a paste made the block empty and every header
 * indicator — the sender, the originating IP — dropped out of the list.
 */
function headerBlockOf(raw: string): string {
  const text = withoutLeadingBlankLines(raw)
  // search, not split: split walks a 40 MB paste to cut every blank line in
  // it, only for the first piece to be kept.
  const end = text.search(/\n\s*\n/)
  return end < 0 ? text : text.slice(0, end)
}

export async function analysePhishing(raw: string, owned: string[], brands: string[]): Promise<PhishReport> {
  const eml = parseEml(raw)
  const headers = analyseHeaders(raw)
  // Each attached message's text is read for links on its own, so every link
  // says which body it came from, and all of them share the one cap.
  const outer = extractLinks(eml.text, eml.html, brands)
  const links = [...outer.links]
  let dropped = outer.dropped
  const forwarded: ForwardedReport[] = []
  for (const f of eml.forwarded) {
    const found = extractLinks(f.text, f.html, brands, MAX_LINKS - links.length)
    for (const link of found.links) links.push({ ...link, origin: f.origin })
    dropped += found.dropped
    forwarded.push({ origin: f.origin, text: f.text, htmlSource: f.html, htmlText: htmlToText(f.html) })
  }
  const notes = [...eml.notes]
  if (dropped > 0) notes.push(`${dropped} further links are in this message and are not listed.`)

  // One part at a time, all drawing on one budget for what the archive reader
  // inflates. Read together, each archive spent its own 32 MB at once, and
  // which one ran the budget dry was down to timing, so no note could say
  // truthfully which attachments had used it. In order, "read before this
  // one" is simply what happened.
  const media = { left: MESSAGE_MEDIA_BUDGET }
  const everyPart: AttachmentReport[] = []
  for (const a of eml.attachments) everyPart.push(await readAttachment(a, owned, media))
  // Split by POSITION, not by filename. everyPart is in the order of
  // eml.attachments, so index i is the same part; a Set of filenames put both
  // `image001.png` parts on whichever side the first one landed, and a message
  // with a real attachment named like its own inline logo is a message that
  // hid one.
  //
  // And on the bytes as well as the flag. Gmail gives ordinary attachments a
  // Content-ID and Apple Mail sends a PDF as `inline; filename=`, so the flag
  // alone filed a PDF lure under inline images, whose report block is a name
  // and a hash. Only a part whose own bytes are a picture this draws is an
  // inline image; anything else is read as the attachment it is. A part whose
  // own disposition says attachment is one, Content-ID or not: a QR code
  // sent from Gmail was filed as an inline image, and the report said
  // "Attachments: None."
  const isInline = eml.attachments.map(
    (a, i) =>
      a.inline && !a.attached && previewKind(a.contentType, a.filename, everyPart[i].sniffed, a.bytes) === 'image'
  )
  const attachments = everyPart.filter((_, i) => !isInline[i])
  const inlineImages = everyPart.filter((_, i) => isInline[i])

  // The sender's own domain gets the folding the link hosts get. Five of the
  // shipped classifications are impersonation of one kind or another, and the
  // domain being impersonated is usually in the From line, not in a link.
  // The address as written, from the header reader, not a re-parse of the
  // decoded From: decoding an encoded word first let `=?utf-8?q?=22?=` build
  // a second address out of a comment, and the look-alike check ran on the
  // domain the sender wanted checked rather than the one they sent from.
  const senderAddress = headers.fromAddress
  const at = senderAddress.lastIndexOf('@')
  const senderHost = at < 0 ? '' : senderAddress.slice(at + 1).toLowerCase()
  const senderFacts = senderHost ? hostFacts(senderHost, brands, senderHost) : []

  const report: PhishReport = {
    headers,
    text: eml.text,
    htmlSource: eml.html,
    htmlText: htmlToText(eml.html),
    forwarded,
    links,
    droppedLinks: dropped,
    attachments,
    inlineImages,
    senderFacts,
    indicators: [],
    notes: dedupe(notes)
  }
  // The case's own list, less its notes: the Indicators tab and the copy
  // button show exactly the values a case opened from here carries. Built
  // twice with its own dedupe, the case dropped a bit.ly link the tab listed
  // because it compared lower-cased paths.
  report.indicators = [
    ...new Set(caseIocs(report, raw).map((ioc) => formatIocLine({ type: ioc.type, value: ioc.value }, owned)))
  ]
  return report
}

/**
 * The indicators a case opened from this analysis carries, typed, each value
 * once by iocKey — hosts, addresses and hashes without regard to case, a URL
 * as written, because its path is case-sensitive.
 *
 * The one collector: analysePhishing derives the Indicators tab from it, so a
 * lure can no longer be on screen and missing from the case — and task.iocs
 * is what cross-case search reads. Unlike that list, each value found inside
 * an attachment or an attached message says where, because in a case the
 * note outlives the analysis that knew it. When a value turns up twice, the
 * first place it was found keeps it, and takes the second place's note if it
 * had none of its own.
 *
 * The headers, the plain text and the words out of the HTML are scanned, not
 * the HTML source: most phishing is HTML-only, and the reply-to address a
 * lure asks for was in what the victim read and in no indicator. Every URL
 * is cut out of that HTML text first. A clickable one is already a link, and
 * the text of an anchor is only what the victim was shown — scanned, a decoy
 * `https://www.paypal.com/signin` came back as a domain the mail never sends
 * anyone to.
 */
export function caseIocs(report: PhishReport, raw: string): Ioc[] {
  const byKey = new Map<string, Ioc>()
  const add = (ioc: Ioc): void => {
    const key = iocKey(ioc)
    const prev = byKey.get(key)
    if (!prev) byKey.set(key, ioc)
    else if (!prev.note && ioc.note) prev.note = ioc.note
  }
  const scan = (text: string, htmlText: string): Ioc[] =>
    extractIocsFromText(`${text}\n${htmlText.replace(URL_RE, ' ')}`, [])
  for (const ioc of scan(`${headerBlockOf(raw)}\n${report.text}`, report.htmlText)) add(ioc)
  for (const f of report.forwarded) {
    for (const ioc of scan(f.text, f.htmlText)) add({ ...ioc, note: `in the body of ${visibleName(f.origin)}` })
  }
  for (const link of report.links) {
    if (!link.target) continue
    const note = [
      link.origin ? `in the body of ${visibleName(link.origin)}` : '',
      link.wrappedBy ? `unwrapped from ${link.wrappedBy}` : ''
    ]
      .filter(Boolean)
      .join(', ')
    add({ type: 'url', value: link.target, ...(note ? { note } : {}) })
  }
  for (const part of [...report.attachments, ...report.inlineImages]) for (const ioc of partIocs(part)) add(ioc)
  return [...byKey.values()]
}

/**
 * A part as a case note names it, with the attached message it came out of.
 * eml gives every nameless part the filename below; a nameless attached
 * message is called what its own parts' origin calls it, so its headers and
 * its payload name the same message.
 */
function partLabel(part: AttachmentReport): string {
  const nameless = part.filename === '(no filename given)' && /^message\/rfc822$/i.test(part.contentType)
  const own = nameless ? 'an attached message' : visibleName(part.filename)
  return part.origin ? `${own} inside ${visibleName(part.origin)}` : own
}

/**
 * What one part adds to the indicators: its own hash, the headers of a
 * forwarded message, the values the structure readers found in it, and the
 * hashes of the files inside it. Each carries the note a case keeps, with the
 * sender's names escaped for display.
 *
 * A forwarded message's headers are parsed structure, like a /URI, not a scan
 * of arbitrary bytes: they hold the phisher's own From and originating IP,
 * which a case opened from the reporter's mail otherwise never carried.
 */
function partIocs(part: AttachmentReport): Ioc[] {
  const name = partLabel(part)
  // A hash of bytes rebuilt from text says so where it outlives the analysis:
  // pasted into a sandbox as the file's own, it matches no file anyone sent.
  // The files inside such a part were read out of the same rebuilt bytes.
  const hashed = `hashed here${part.exact ? '' : ' from its text as read; may not match the file as sent'}`
  const out: Ioc[] = []
  if (part.sha256) out.push({ type: 'hash', value: part.sha256, note: `${name} (${hashed})` })
  if (part.sha256 && /^message\/rfc822$/i.test(part.contentType)) {
    for (const ioc of extractIocsFromText(headerBlockOf(utf8Text(part.bytes.subarray(0, STRINGS_CAP))), [])) {
      out.push({ ...ioc, note: `in the headers of ${name}` })
    }
  }
  for (const ioc of structureIocValues(part.pdf, part.office)) out.push({ ...ioc, note: `inside ${name}` })
  for (const file of part.office?.files ?? []) {
    if (file.sha256) {
      out.push({ type: 'hash', value: file.sha256, note: `${visibleName(file.name)} inside ${name} (${hashed})` })
    }
  }
  return out
}

/**
 * A fenced block whose backtick run is longer than anything inside it, so the
 * content cannot close its own fence and escape into the note that renders it.
 */
function fenced(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text.replace(/\r\n?/g, '\n')}\n${fence}`
}

/** Notes repeat once per malformed part; a 4MB mail produced 120,000 identical lines. */
function dedupe(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= 40) {
      out.push('Further parser notes are not listed.')
      break
    }
  }
  return out
}

/**
 * Said about a part whose bytes are not the ones that travelled. A 7bit or
 * 8bit part, and a quoted-printable one with a hard line break or a raw
 * non-ASCII character, came through the reader's line normalisation or its
 * UTF-8 decoding, so the bytes were rebuilt from its text. Whether the file as
 * sent used CRLF is not known here, so the sentence says "may", never "does".
 */
export const REBUILT_FACT =
  "this part's bytes were rebuilt here from its text as read (line breaks as LF), so its size and hashes may not match the file as sent"

async function readAttachment(a: Attachment, owned: string[], media: { left: number }): Promise<AttachmentReport> {
  const facts = attachmentFacts(a)
  const origin = a.origin ? { origin: a.origin } : {}
  if (a.undecodable) {
    // Nothing was read, so nothing is claimed. Hashing zero bytes would print
    // the SHA-256 of the empty string under "computed here from the bytes in
    // the file", and that digest reads as a clean result in any sandbox for a
    // payload no one has looked at.
    return {
      filename: a.filename,
      contentType: a.contentType,
      size: 0,
      sha256: '',
      sha1: '',
      md5: '',
      sniffed: '',
      exact: true,
      ...origin,
      facts: [...facts, 'this part could not be decoded, so its size, hashes and type are not recorded'],
      inside: [],
      bytes: new Uint8Array()
    }
  }
  const sniffed = sniffType(a.bytes)
  // An empty file has no first bytes to compare with its name.
  const mismatch = a.bytes.length ? contentMismatch(a.filename, a.contentType, sniffed) : ''
  const { pdf, office, ole, failed } = await readStructure(a.bytes, sniffed, media)
  // The name said the contents could not be seen, and the ZIP reader has just listed them.
  const named = office?.entries.length
    ? facts.flatMap((f) => (f === ARCHIVE_FACT ? [] : f === DISK_IMAGE_FACT ? [DISK_IMAGE_AS_ZIP_FACT] : [f]))
    : facts

  // Indicators carried INSIDE the file's bytes, kept as their own list and
  // never merged into the mail's own links: where an indicator was found is
  // half of what it means, and an analyst told "this URL was in the message"
  // when it was really inside a spreadsheet has been told something untrue.
  // A value a structure reader found is already on the card beside where it
  // was found — a /URI, a relationship target — so it is not printed again.
  //
  // A shortcut's strings are read by their own counts and scanned one per
  // line, with their bytes blanked from the plain scan: read as text, each
  // count ran on into the string before it, and `…/view.hta` followed by an
  // icon path of 33 characters read as `…/view.hta!%SystemRoot%`.
  const shortcut = sniffed === 'Windows shortcut (LNK)' ? lnkStrings(a.bytes) : null
  const scan = scanText(shortcut ? shortcut.blanked : a.bytes)
  const structural = new Set(structureIocValues(pdf, office).map((ioc) => ioc.value.toLowerCase()))
  // A /URI literal string with an escape in it reads, raw, as the front of
  // its URL and a tail after the escape: `(https://ev\151l.com/a)` gave
  // `hxxps://ev` and `151l[.]com`, values the file does not hold. The reader
  // has decoded it and it is on the card, so it is blanked here. Unescaped
  // strings scan exactly as they decode, and the filter below drops those.
  const utf8 = pdf
    ? scan.utf8.replace(/\/URI\s*\((?:[^()\\]|\\[\s\S])*\)/g, (m) => (m.includes('\\') ? ' ' : m))
    : scan.utf8
  const found = extractIocsFromText(`${utf8}\n${scan.utf16}${shortcut ? `\n${shortcut.text}` : ''}`, []).filter(
    (ioc) => !structural.has(ioc.value.toLowerCase())
  )
  const inside = found.slice(0, 100).map((ioc) => formatIocLine(ioc, owned))
  const count = (n: number): string => n.toLocaleString('en-US')
  // Scoped to the scan that skipped the bytes. A structure reader reads the
  // file on its own, and what it found in those bytes is listed beside this.
  const reader = pdf ? 'PDF' : office ? 'ZIP' : ole ? 'compound-file' : ''
  const scanFacts = [
    ...(scan.between
      ? [
          `the text scan for indicators, script names and RTF markers read the first ${count(scan.head)} and the last ${count(scan.tail)} bytes; it did not read the ${count(scan.between)} bytes between` +
            (reader
              ? `; the ${reader} structure reader read this file separately, and its lines are listed separately`
              : '')
        ]
      : []),
    // The list stops at 100, and says so, so the hundredth line is not read as the last.
    ...(found.length > inside.length
      ? [`${count(found.length - inside.length)} further indicators found inside the file are not listed`]
      : [])
  ]
  // Counted over the same windows, whenever the file is read as text — not
  // only when it is named .html: a smuggling page arrives as .htm, .hta,
  // .shtml or .svg alike, and the sender picks the name.
  const census = previewKind(a.contentType, a.filename, sniffed, a.bytes) === 'text' ? markupCensus(scan.utf8) : null
  // An RTF's \object and DDEAUTO, over the same windows. Past the preview's
  // 20,000 characters an Equation Editor object was stated nowhere. Gated on
  // the bytes beginning `{\rt`, not on the sniff (Word also opens `{\rt0`) or
  // on the preview (an RTF carrying \bin data does not preview as text).
  const rtf =
    a.bytes[0] === 0x7b && a.bytes[1] === 0x5c && a.bytes[2] === 0x72 && a.bytes[3] === 0x74
      ? rtfCensus(scan.utf8)
      : null

  return {
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    sha256: await hashBytes(a.bytes),
    sha1: await hashBytes(a.bytes, 'SHA-1'),
    md5: md5(a.bytes),
    sniffed,
    exact: a.exact,
    ...origin,
    facts: [
      ...(mismatch ? [mismatch] : []),
      ...named,
      ...(failed ? [failed] : []),
      ...scanFacts,
      ...(census ? [census] : []),
      ...(rtf ? [rtf] : []),
      ...(a.exact ? [] : [REBUILT_FACT])
    ],
    inside,
    bytes: a.bytes,
    ...(pdf ? { pdf } : {}),
    ...(office ? { office } : {}),
    ...(ole ? { ole } : {})
  }
}

/** Past this many, a list says how many more there are instead of printing them. */
export const STRUCTURE_LIST_CAP = 50

/**
 * How many entries were READ from a directory — which is not how many it
 * declares. A listing that stopped early, or a directory that was never found,
 * would otherwise be reported as the archive's whole contents; the reader's own
 * note says why the list is short.
 */
export function entriesRead(n: number, directory = 'the ZIP directory'): string {
  return `${n} entr${n === 1 ? 'y' : 'ies'} read from ${directory}`
}

/** Sniffed types that hold other files or objects: the archives, a compound file, a PDF. */
const CONTAINER = /ZIP|RAR|7-Zip|gzip|cabinet|OLE|PDF/

/** One row per entry with something to say about it. The name is raw, for matching; escape it with visibleName to show it. */
export interface FlaggedEntry {
  name: string
  why: string[]
}

/**
 * The ZIP entries worth a line: what the name says, and whether the entry is
 * encrypted, in one row each. The report and the card print the same rows
 * under the same cap, so a ZIP of 4,096 encrypted .exe files is 51 lines, not
 * 8,192, and an archive with only its payload encrypted still says which one.
 */
export function flaggedEntries(office: Pick<OfficeStructure, 'entries'>): FlaggedEntry[] {
  return office.entries.flatMap((e) => {
    const why = [entryNote(e.name) ?? '', e.encrypted ? 'encrypted, so its contents cannot be read here' : ''].filter(
      Boolean
    )
    return why.length ? [{ name: e.name, why }] : []
  })
}

/** The compound-file entries worth a line, with the kind the directory records for each (storage, stream or root). */
export function flaggedOleEntries(ole: CfbFacts): (FlaggedEntry & { type: string })[] {
  return ole.entries.flatMap((e) => {
    const note = cfbNote(e.name)
    return note ? [{ name: e.name, type: e.type, why: [note] }] : []
  })
}

/**
 * What is known about one file inside an archive, in this tool's own words —
 * the part after its name, shared by the report and the card. A mismatch
 * already names what the bytes begin as, so it stands in for that clause.
 */
export function innerFileFacts(file: InnerFileReport): string {
  return [
    file.mismatch || (file.sniffed ? `bytes begin as ${file.sniffed}` : ''),
    file.sha256 ? `SHA-256 ${file.sha256} (computed here)` : 'not read whole, so not hashed here',
    // Only the attachment itself goes through a structure reader, so an
    // archive, compound file or PDF inside it is typed and hashed, never
    // opened. Silence there would read as nothing inside.
    CONTAINER.test(file.sniffed) && !file.sniffed.startsWith('empty') ? 'its own contents are not listed here' : ''
  ]
    .filter(Boolean)
    .join('; ')
}

/**
 * The structure readers' findings as report lines. Every value written by the
 * sender — a URI, an entry name, a relationship target or type — is quoted as
 * untrusted and escaped with visibleName, so a right-to-left override or a
 * newline in it cannot reorder or add to the lines around it; the ones that
 * can be followed are defanged first.
 */
export function structureLines(a: AttachmentReport): string[] {
  const lines: string[] = []
  const capped = <T>(list: T[], each: (item: T) => string, noun: string): void => {
    for (const item of list.slice(0, STRUCTURE_LIST_CAP)) lines.push(each(item))
    if (list.length > STRUCTURE_LIST_CAP) {
      lines.push(`  - ${list.length - STRUCTURE_LIST_CAP} further ${noun} are not listed`)
    }
  }
  const shown = (value: string): string => quoteUntrusted(visibleName(value))
  if (a.pdf) {
    const { pdf } = a
    lines.push(`  - PDF ${pdf.version || 'version not recorded'}${pdf.encrypted ? ', /Encrypt present' : ''}`)
    if (pdf.markers.length) {
      lines.push(`  - PDF names found: ${pdf.markers.map((m) => `${m.name} ×${m.count}`).join(', ')}`)
    }
    capped(pdf.uris, (uri) => `  - PDF link (/URI): ${shown(defangIoc(uri, 'url'))}`, 'PDF links')
    capped(pdf.images, imageLine, 'PDF images')
    for (const note of pdf.notes) lines.push(`  - PDF reader: ${quoteUntrusted(note)}`)
  }
  if (a.office) {
    const { office } = a
    if (office.entries.length) lines.push(`  - ${entriesRead(office.entries.length)}`)
    capped(flaggedEntries(office), (f) => `  - entry ${shown(f.name)}: ${f.why.join('; ')}`, 'flagged entries')
    capped(
      office.externalTargets,
      (t) =>
        `  - external target: ${shown(defangIoc(t.target, 'url'))} — relationship type ${shown(relationshipType(t.type))}, declared in ${shown(t.from)}`,
      'external targets'
    )
    capped(office.files, (f) => `  - inner file ${shown(f.name)}: ${innerFileFacts(f)}`, 'inner files')
    capped(office.images, imageLine, 'pictures')
    for (const note of office.notes) lines.push(`  - ZIP reader: ${quoteUntrusted(note)}`)
  }
  if (a.ole) {
    const { ole } = a
    const directory = 'the compound-file directory'
    if (ole.entries.length) lines.push(`  - ${entriesRead(ole.entries.length, directory)}`)
    capped(
      flaggedOleEntries(ole),
      (f) => `  - ${directory} lists ${f.type} ${shown(f.name)}: ${f.why.join('; ')}`,
      'flagged entries'
    )
    for (const note of ole.notes) lines.push(`  - OLE reader: ${quoteUntrusted(note)}`)
  }
  return lines
}

/**
 * Whether an embedded stream's own bytes are a picture: one this draws, or a
 * JPEG 2000 image it names but does not draw. A /DCTDecode stream or an entry
 * named photo.jpg whose bytes are a program is not one, and calling it an
 * embedded picture was false. The card uses the same rule for its wording.
 */
export function isPicture(sniffed: string): boolean {
  return Boolean(drawableType(sniffed)) || /^J(P2|2K) /.test(sniffed)
}

function imageLine(image: EmbeddedImage): string {
  const noun = isPicture(image.sniffed) ? 'embedded picture' : 'embedded stream'
  return `  - ${noun} ${quoteUntrusted(visibleName(image.where))}: ${image.sniffed || 'type not recognised'}, ${image.bytes.length} bytes, SHA-256 ${image.sha256} (computed here)`
}

/** The last segment of a relationship Type URI — `attachedTemplate`, `oleObject`, `hyperlink` — which is the part that says what it is for. */
export function relationshipType(type: string): string {
  return type.split('/').filter(Boolean).pop() || 'not recorded'
}

/**
 * The structure readers, chosen by what the bytes are — never by the filename
 * or the declared type, which the sender writes.
 *
 * The readers are built not to throw, but one that did would take the whole
 * analysis with it, so a failure here becomes a stated fact about this file
 * rather than a report that never arrives.
 */
async function readStructure(
  bytes: Uint8Array,
  sniffed: string,
  media: { left: number }
): Promise<{ pdf?: PdfStructure; office?: OfficeStructure; ole?: CfbFacts; failed?: string }> {
  const identify = (list: { where: string; bytes: Uint8Array }[]): Promise<EmbeddedImage[]> =>
    Promise.all(list.map(async (i) => ({ ...i, sniffed: sniffType(i.bytes), sha256: await hashBytes(i.bytes) })))
  // Acrobat opens a PDF whose header sits after a prefix — a space, a BOM, a
  // stub — and readPdf reads it there too, but the sniff wants %PDF at byte 0,
  // so such a file never reached the reader and its /OpenAction and hex /URI
  // went unread with no note. Only a real header inside the window readPdf
  // itself searches counts: a text file with `endobj … %%EOF` in it is not a PDF.
  // A prefix another signature recognises counts too — an MZ, JPEG or GIF
  // stub in front is what a polyglot is — except a ZIP or compound file,
  // which have readers of their own.
  const pdfHeader =
    sniffed !== 'PDF' && !/ZIP|OLE/.test(sniffed) && /%PDF-\d\.\d/.test(String.fromCharCode(...bytes.subarray(0, 1040)))
  try {
    if (sniffed === 'PDF' || pdfHeader) {
      const facts = readPdf(bytes)
      if (!facts || (pdfHeader && !facts.version)) return {}
      // PDF pictures draw on the message's budget as the ZIP reader's do.
      // Each PDF holds up to 12 MiB of them, so twenty PDFs held 240 MB
      // between them, every byte hashed and drawn on each render. Charged
      // before identify(), so what is not kept is not hashed either. In order,
      // and stopping at the first that does not fit, so "read before them" is
      // what happened. "Image stream", not "picture": these are not sniffed
      // yet, and a /DCTDecode stream is not always a picture.
      const kept: typeof facts.images = []
      for (const image of facts.images) {
        if (image.bytes.length > media.left) break
        media.left -= image.bytes.length
        kept.push(image)
      }
      const cut = facts.images.length - kept.length
      const notes = cut
        ? [
            ...facts.notes,
            `${cut} image stream${cut === 1 ? ' was' : 's were'} extracted and not kept: this message's budget for pictures and inner files was used up by what was read before ${cut === 1 ? 'it, so it is' : 'them, so they are'} not hashed or drawn — unread, not absent.`
          ]
        : facts.notes
      const images = await identify(kept.map((i) => ({ where: `byte ${i.offset} (${i.filter})`, bytes: i.bytes })))
      return { pdf: { ...facts, notes, images } }
    }
    if (/ZIP/.test(sniffed)) {
      const facts = await readZipDocument(bytes, media)
      if (!facts) return {}
      const images = await identify(facts.images.map((i) => ({ where: i.name, bytes: i.bytes })))
      // Typed and hashed, then let go: the report keeps what each file is, not
      // the file. The first bytes decide the type even when the file was not
      // read whole — they are still its first bytes — but only a whole file
      // gets a hash.
      const files = await Promise.all(
        facts.files.map(async (f): Promise<InnerFileReport> => {
          const kind = sniffType(f.head)
          return {
            name: f.name,
            sniffed: kind,
            mismatch: f.head.length ? contentMismatch(f.name, '', kind) : '',
            sha256: f.bytes ? await hashBytes(f.bytes) : ''
          }
        })
      )
      return { office: { ...facts, images, files } }
    }
    // A legacy .doc, .xls or .msg: its directory names the macro storage and
    // any embedded package, which the 512-byte header on the card never shows.
    if (/OLE/.test(sniffed)) {
      const facts = readCfb(bytes)
      return facts ? { ole: facts } : {}
    }
    return {}
  } catch {
    // Named for the reader that ran: a PDF behind a JPEG stub is read by the
    // PDF reader, and there is no JPEG structure reader to have stopped.
    const reader = pdfHeader ? 'PDF' : sniffed || 'PDF'
    return { failed: `the ${reader} structure reader stopped on this file, so its contents are not listed` }
  }
}

/**
 * Indicators the structure readers found, typed and not yet formatted. They
 * matter most where the plain text scan is blind: a relationship target in an
 * Office file lives in a COMPRESSED part, and a PDF link written in escapes or
 * hex cannot be found by searching the bytes as text. They are also the lure
 * itself, so they join the message's indicator list and the case, and not
 * only the attachment's card.
 *
 * A template or a PDF link written as a UNC or file:// path names a remote
 * host too — the WebDAV form `\\host@SSL\DavWWWRoot\t.dotm` fetches from it,
 * and so does a PDF link to a share — but the prose scan knows only http(s)
 * and a short list of TLDs, so the host is read off the front of the path.
 * The forms read are `\\host\…`, `file://host/…`, and a file URL with an
 * empty authority followed by a UNC path: `file:///\\host\…` (how Office
 * writes a template on a share), `file:////host/…` and `file://///host/…`.
 * Only a dotted name counts: `\\.\pipe\x`, a single-label `\\fileserver` and
 * `file:///C:/` name nothing to look up. `file:///opt.local/x` is a local path,
 * not a host, and `file://user@host/` is not read, so a username is never
 * listed as a domain.
 *
 * ponytail: the long form `\\?\UNC\host\…` and a `file:` URL with one slash
 * are left to the card, which shows every target as written; add them here if
 * one turns up in a real template.
 */
function structureIocValues(pdf: PdfStructure | undefined, office: OfficeStructure | undefined): Ioc[] {
  const extra = [...(pdf?.uris ?? []), ...(office?.externalTargets.map((t) => t.target) ?? [])]
  const out = extra.length ? extractIocsFromText(extra.join('\n'), []) : []
  for (const target of extra) {
    const m = /^(?:\\\\([^\\/@:]+)|file:\/\/(?:[\\/]{2,})?([^\\/@:]+)(?=[\\/:]|$))/i.exec(target)
    const host = m?.[1] ?? m?.[2]
    if (host && /^[\w-]+(?:\.[\w-]+)+$/.test(host)) out.push({ type: detectIocType(host), value: host })
  }
  return out
}

/**
 * The text an indicator scan reads out of a file: all of it up to twice
 * STRINGS_CAP, otherwise the first and the last STRINGS_CAP bytes. An HTML
 * smuggling page puts a megabyte of base64 first and the script that uses it
 * last, so a scan of the head alone never saw the script.
 *
 * A window's inner edge is moved back to a space or control byte, which ends
 * every URL, host and hash the scan looks for: cut anywhere else, half a URL
 * or two thirds of a SHA-256 is a value the file does not contain. `head` and
 * `tail` are the bytes actually read, and `between` the bytes that were not.
 *
 * ponytail: a window with no space or control byte in it at all — a megabyte
 * of one base64 line — is trimmed to nothing, and the fact's own numbers then
 * say that none of it was read. Holding the cut token back instead of the
 * whole window is the upgrade if a real file needs it.
 */
function scanText(bytes: Uint8Array): { utf8: string; utf16: string; head: number; tail: number; between: number } {
  if (bytes.length <= 2 * STRINGS_CAP) {
    return { utf8: utf8Text(bytes), utf16: utf16Runs(bytes, false, false), head: bytes.length, tail: 0, between: 0 }
  }
  let headEnd = STRINGS_CAP
  while (headEnd > 0 && bytes[headEnd - 1] > 0x20) headEnd--
  let tailStart = bytes.length - STRINGS_CAP
  while (tailStart < bytes.length && bytes[tailStart] > 0x20) tailStart++
  const head = bytes.subarray(0, headEnd)
  const tail = bytes.subarray(tailStart)
  return {
    utf8: `${utf8Text(head)}\n${utf8Text(tail)}`,
    utf16: `${utf16Runs(head, false, true)}\n${utf16Runs(tail, true, false)}`,
    head: head.length,
    tail: tail.length,
    between: tailStart - headEnd
  }
}

/**
 * A shortcut's StringData (MS-SHLLINK 2.4), read by its own counts: the name,
 * relative path, working directory, arguments and icon location, one per line,
 * plus the file with those bytes zero-filled for the plain scan.
 *
 * The strings carry no terminator, only a count in front of each, and a count
 * from 32 to 126 is a printable character. Read as text, the arguments' URL
 * ran into the icon path's count and the path after it, and a count of 68
 * ('D') glued a URL to the working directory so it was never found at all.
 *
 * Every read is bounded by the file's length. A layout that does not parse to
 * the end of the strings its flags declare returns null, and the caller scans
 * the file as it did before. Only StringData is read this way; the ID list,
 * LinkInfo and ExtraData stay with the plain scan.
 */
function lnkStrings(bytes: Uint8Array): { text: string; blanked: Uint8Array } | null {
  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8)
  const flags = bytes[0x14]
  const unicode = (flags & 0x80) !== 0
  let at = 0x4c
  if (flags & 0x01) at += 2 + u16(at) // HasLinkTargetIDList: a u16 size, then the list
  if (flags & 0x02) at += u16(at) + u16(at + 2) * 0x10000 // HasLinkInfo: a u32 size that counts itself
  const from = at
  const strings: string[] = []
  // HasName, HasRelativePath, HasWorkingDir, HasArguments, HasIconLocation, in that order.
  for (let bit = 0x04; bit <= 0x40; bit <<= 1) {
    if (!(flags & bit)) continue
    if (at + 2 > bytes.length) return null
    const length = u16(at) * (unicode ? 2 : 1)
    at += 2
    if (at + length > bytes.length) return null
    strings.push(new TextDecoder(unicode ? 'utf-16le' : 'latin1').decode(bytes.subarray(at, at + length)))
    at += length
  }
  const blanked = bytes.slice()
  blanked.fill(0, from, at)
  return { text: strings.join('\n'), blanked }
}

function utf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

/**
 * Runs of UTF-16LE text, one per line: a printable ASCII byte then a zero, six
 * characters or more. A shortcut's command line, a .msg body and OneNote text
 * are stored this way, and read as UTF-8 they are nothing — `h\0t\0t\0p\0`
 * never matches a URL. Stepping one byte past anything else, not two, is what
 * finds a run that starts at an odd offset, as a shortcut's arguments often do.
 * A run that touches a cut window edge is dropped, because the rest of it is
 * outside the window.
 *
 * ponytail: printable ASCII only, which is every URL, host and path the scan
 * looks for. A run in another script is not read; a full UTF-16 decode of each
 * run is the upgrade if an indicator ever hides in one.
 */
function utf16Runs(bytes: Uint8Array, cutStart: boolean, cutEnd: boolean): string {
  const runs: string[] = []
  let run = ''
  let start = 0
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i]
    if (byte >= 0x20 && byte <= 0x7e && bytes[i + 1] === 0) {
      if (!run) start = i
      run += String.fromCharCode(byte)
      i += 2
      continue
    }
    // Ended by a control character — a NUL, a line break, both bytes of the
    // code unit — the run is whole. Ended by anything else, a letter outside
    // ASCII or bytes that are not text, its last word may carry on past what
    // was read: `https://ex.test/pa` read off the front of `https://ex.test/paтh`
    // is a URL the file does not hold, so the run is cut back to its last space.
    // The high byte counts: `Д` is 14 04 and `č` is 0D 01, letters whose low
    // byte alone looked like a control, and ended a URL mid-word as if whole.
    if (!(byte < 0x20 && bytes[i + 1] === 0)) run = run.slice(0, run.lastIndexOf(' ') + 1)
    if (run.length >= 6 && !(cutStart && start < 2)) runs.push(run)
    run = ''
    i++
  }
  if (run.length >= 6 && !cutEnd && !(cutStart && start < 2)) runs.push(run)
  return runs.join('\n')
}

/**
 * The Links section's own words, shared by the report and the Links tab so the
 * two cannot drift apart.
 *
 * Scoped to the message text, because that is all extractLinks reads: a mail
 * whose only lure is a PDF /URI said "Links: None found." above an Attachments
 * section listing it. The pointer to Attachments is there whenever there are
 * attachments, whatever the readers found, because a note that appears only
 * sometimes reads as "none" when it is missing.
 */
export function linksSection(report: Pick<PhishReport, 'links' | 'attachments'>): {
  heading: string
  none: string
  notes: string[]
} {
  return {
    heading: 'Links in the message text',
    none: 'None found in the message text.',
    notes: [
      ...(report.links.some(showsDerivedDomain)
        ? [
            'Derived domain = the host’s last two labels, or three under a two-label suffix; no public suffix list is consulted, so under a hosting platform (pages.dev, github.io) it names the platform, not the site’s owner.'
          ]
        : []),
      ...(report.attachments.length
        ? ['Anything found inside an attachment is listed with that attachment, under Attachments.']
        : [])
    ]
  }
}

/** A link row prints its derived domain only when it says something the host does not. */
export function showsDerivedDomain(link: LinkFinding): boolean {
  return Boolean(link.apexDomain) && link.apexDomain !== link.host
}

/**
 * The whole analysis as markdown, for the clipboard or a case description.
 *
 * Every sender-controlled value goes through quoteUntrusted, because this text
 * is written into a note Obsidian renders: a filename of `![[x]]` would embed
 * a note into the case and an `<img>` in a subject would fire a request the
 * moment it was opened.
 */
export function formatPhishReport(report: PhishReport): string {
  const lines = [formatHeaderReport(report.headers), '']
  if (report.senderFacts.length) {
    lines.push('### Sender domain', '')
    for (const fact of report.senderFacts) lines.push(`- ${quoteUntrusted(fact)}`)
    lines.push('')
  }
  const section = linksSection(report)
  lines.push(`### ${section.heading}`, '')
  if (report.links.length) {
    for (const link of report.links) {
      const wrapped = link.wrappedBy ? ` (unwrapped from ${link.wrappedBy})` : ''
      lines.push(`- ${quoteUntrusted(defangIoc(link.target, 'url'))}${wrapped}`)
      if (link.origin) lines.push(`  - in the body of ${quoteUntrusted(visibleName(link.origin))}`)
      if (showsDerivedDomain(link)) {
        lines.push(`  - derived domain ${quoteUntrusted(defangIoc(link.apexDomain, 'domain'))}`)
      }
      for (const flag of link.flags) lines.push(`  - ${quoteUntrusted(flag)}`)
    }
    if (report.droppedLinks > 0) lines.push(`- ${report.droppedLinks} further links are not listed.`)
  } else {
    lines.push(section.none)
  }
  for (const note of section.notes) lines.push('', note)
  // A part found inside an attached message says which one, or the phisher's
  // payload reads as something the reporter sent.
  const inside = (a: AttachmentReport): string => (a.origin ? ` inside ${quoteUntrusted(visibleName(a.origin))}` : '')
  lines.push('', '### Attachments', '')
  if (report.attachments.length) {
    for (const a of report.attachments) {
      const size = a.sha256 ? `${a.size} bytes` : 'size not recorded'
      lines.push(`- ${quoteUntrusted(visibleName(a.filename))}${inside(a)} — ${quoteUntrusted(a.contentType)}, ${size}`)
      lines.push(`  - SHA-256 ${a.sha256 || 'not recorded'}${a.sha256 ? ' (computed here)' : ''}`)
      lines.push(`  - SHA-1 ${a.sha1 || 'not recorded'}${a.sha1 ? ' (computed here)' : ''}`)
      lines.push(`  - MD5 ${a.md5 || 'not recorded'}${a.md5 ? ' (computed here)' : ''}`)
      if (a.sniffed) lines.push(`  - bytes begin as ${a.sniffed}`)
      for (const fact of a.facts) lines.push(`  - ${quoteUntrusted(fact)}`)
      for (const found of a.inside) lines.push(`  - found inside the file: ${quoteUntrusted(found)}`)
      lines.push(...structureLines(a))
    }
  } else {
    lines.push('None.')
  }
  if (report.inlineImages.length) {
    lines.push('', '### Inline images — marked inline or given a Content-ID by their own headers', '')
    // What the card shows, less the SHA-1, the MD5 and the one fact the
    // heading already states: a PDF named as a picture, or a beacon URL in a
    // picture's bytes, reached the card and neither the report nor the case.
    for (const a of report.inlineImages) {
      lines.push(
        `- ${quoteUntrusted(visibleName(a.filename))}${inside(a)} — ${quoteUntrusted(a.contentType)}, ${a.size} bytes`
      )
      if (a.sha256) lines.push(`  - SHA-256 ${a.sha256} (computed here)`)
      if (a.sniffed) lines.push(`  - bytes begin as ${a.sniffed}`)
      for (const fact of a.facts) if (fact !== INLINE_FACT) lines.push(`  - ${quoteUntrusted(fact)}`)
      for (const found of a.inside) lines.push(`  - found inside the file: ${quoteUntrusted(found)}`)
    }
  }

  // The message itself. The screen told the analyst the copied report carried
  // the rest of a truncated body, and it carried none of it — the body reached
  // no section at all, so a case created from the analysis held an analysis of
  // a mail whose text was nowhere. Fenced with a backtick run longer than
  // anything inside it, so hostile markdown cannot close its own block, and
  // nothing inside a fence autolinks.
  //
  // An attached message's text is its own block under its own name. Joined
  // to the outer text, the phisher's sentence read as the reporter's.
  const body = (b: { text: string; htmlText: string; htmlSource: string }): string[] => {
    const blocks = [
      ['Plain text:', b.text],
      ['Text extracted from the HTML, not rendered:', b.htmlText],
      ['HTML source, not rendered:', b.htmlSource]
    ].flatMap(([label, text]) => (text.trim() ? [label, '', fenced(text.trim()), ''] : []))
    return blocks.length ? blocks : ['Not recorded.', '']
  }
  lines.push('', '### Message body', '', ...body(report))
  for (const f of report.forwarded) {
    lines.push(`Text of the attached message ${quoteUntrusted(visibleName(f.origin))}:`, '', ...body(f))
  }
  // Every block above ends on a blank line; the next heading brings its own.
  lines.pop()

  lines.push('', '### Indicators', '')
  if (report.indicators.length) for (const i of report.indicators) lines.push(`- ${quoteUntrusted(i)}`)
  else lines.push('None found.')
  if (report.notes.length) {
    lines.push('', '### Parser notes', '')
    for (const note of report.notes) lines.push(`- ${quoteUntrusted(note)}`)
  }
  return lines.join('\n')
}

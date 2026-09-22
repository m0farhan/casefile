import { type Attachment, hashBytes, parseEml } from './eml'
import { type HeaderAnalysis, addressOf, analyseHeaders, formatHeaderReport, quoteUntrusted } from './emailHeaders'
import { defangIoc, extractIocsFromText, formatIocLine } from './ioc'
import { decodePercentEscapes } from './toolbox'

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
  /** Stated facts about the host — never a score. */
  flags: string[]
  /** Text the link was shown as, when that text is itself a URL that disagrees. */
  shownAs: string
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
      const v3 = /\/v3\/__(.+?)__;/.exec(url)
      if (v3) return decodePercentEscapes(v3[1])
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
 * Anchors, with every scan BOUNDED.
 *
 * The unbounded lazy form was quadratic: a body of anchors with no closing
 * tag made the regex engine restart the tail scan from every one of them, and
 * fifty thousand of them froze the UI thread for tens of seconds. Bounding it
 * fails toward "the anchor text was not compared", which is an absence the
 * report states — never a fabricated match.
 */
const ANCHOR_RE =
  /<a\b[^>]{0,2000}?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))[^>]{0,2000}?>([\s\S]{0,2000}?)<\/a>/gi

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
  const open = `<${tag}`
  const close = `</${tag}`
  let out = ''
  let i = 0
  for (;;) {
    const start = lower.indexOf(open, i)
    if (start < 0) return out + html.slice(i)
    out += html.slice(i, start)
    const closeAt = lower.indexOf(close, start + open.length)
    if (closeAt < 0) return out
    const gt = html.indexOf('>', closeAt)
    if (gt < 0) return out
    i = gt + 1
  }
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

/** Elements whose end means a line ended, so the text reads as it was laid out. */
const BLOCK_TAGS =
  /<\s*\/?\s*(?:p|div|tr|li|ul|ol|table|thead|tbody|h[1-6]|blockquote|section|article|header|footer|td|th|pre)\b[^>]{0,1000}>/gi
const LINE_BREAKS = /<\s*(?:br|hr)\b[^>]{0,1000}>/gi

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
  text = text.replace(/<[^>]{0,2000}>/g, '')
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
 * Suffixes under which the registrable name is the THIRD label from the right.
 *
 * ponytail: a short hand-written list, not the public suffix list — that is a
 * 15k-entry file that would have to ship and be kept current, and this is a
 * heuristic feeding a stated fact, not a gate. Names the ceiling: a look-alike
 * under a multi-label suffix not on this list is compared against the wrong
 * label and simply gets no fact, which is an absence, not a wrong answer.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'gov.uk',
  'ac.uk',
  'net.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'gov.au',
  'edu.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'co.za',
  'org.za',
  'net.za',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'com.br',
  'com.mx',
  'com.ar',
  'com.sg',
  'com.hk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.in',
  'net.in',
  'org.in',
  'com.tr',
  'com.tw',
  'co.il',
  'com.pl',
  'com.ua'
])

/** The registrable-ish label: `login.paypa1.co.uk` → `paypa1`. */
function brandLabel(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (parts.length < 2) return parts[0] ?? ''
  const lastTwo = parts.slice(-2).join('.')
  if (parts.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) return parts[parts.length - 3]
  return parts[parts.length - 2]
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
 * URL-bearing attribute, CSS `url()` and `srcset` candidate.
 */
export function extractLinks(text: string, html: string, brands: string[]): { links: LinkFinding[]; dropped: number } {
  const raws = new Set<string>()
  const add = (value: string): void => {
    const url = normaliseUrl(value)
    // Any scheme, not just http(s): a mail whose only link is `data:` or
    // `javascript:` used to report "None found.", which reads as a clean mail.
    if (/^[a-z][a-z0-9+.-]{1,15}:/i.test(url)) raws.add(url)
  }
  // Bare URLs in BOTH bodies. The HTML is scanned with its tags stripped, so a
  // URL sitting in visible text or in a <meta refresh> content= is not missed.
  // That scan is the ONLY one that can turn anchor TEXT into a candidate, so
  // what it contributed is remembered: a decoy label is dropped below, but
  // only when no other scan found the same URL as a real destination.
  for (const m of text.matchAll(URL_RE)) add(m[0])
  const fromVisibleText = new Set<string>()
  for (const m of decodeEntities(html)
    .replace(/<[^>]{0,2000}>/g, ' ')
    .matchAll(URL_RE)) {
    const before = raws.size
    add(m[0])
    if (raws.size > before) fromVisibleText.add(normaliseUrl(m[0]))
  }
  for (const m of html.matchAll(ATTR_RE)) add(m[1] ?? m[2] ?? m[3] ?? '')
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
        .replace(/<[^>]{0,500}>/g, '')
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
  for (const label of shown.values()) {
    if (!hrefs.has(label) && fromVisibleText.has(label)) raws.delete(label)
  }

  const all = [...raws]
  const kept = all.slice(0, MAX_LINKS)
  const out: LinkFinding[] = []
  for (const raw of kept) {
    const { target, wrappedBy } = unwrapUrl(raw)
    const scheme = (/^([a-z][a-z0-9+.-]{1,15}):/i.exec(target)?.[1] ?? '').toLowerCase()
    // The authority as WRITTEN, before the parser punycodes or lowercases it.
    const rawHost = (/^[a-z][a-z0-9+.-]{1,15}:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(target)?.[1] ?? '').toLowerCase()
    let host = ''
    let userinfo = ''
    try {
      const parsed = new URL(target)
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
    out.push({ raw, target, wrappedBy, host, flags, shownAs: label })
  }
  return { links: out, dropped: all.length - kept.length }
}

const MACRO_CAPABLE = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|xls|doc|ppt)$/i
const EXECUTABLE = /\.(exe|scr|com|pif|bat|cmd|ps1|vbs|js|jse|wsf|wsh|hta|msi|dll|lnk|jar|apk|iso|img)$/i
const ARCHIVE = /\.(zip|rar|7z|tar|gz|cab|ace|arj)$/i

/** Stated facts about an attachment. No scoring, no "malicious". */
export function attachmentFacts(attachment: Attachment): string[] {
  const facts: string[] = []
  const name = attachment.filename
  if (EXECUTABLE.test(name)) facts.push('executable or script file type')
  if (MACRO_CAPABLE.test(name)) facts.push('file type that can carry macros')
  if (ARCHIVE.test(name)) facts.push('archive — its contents are not visible from here')
  // `invoice.pdf.exe` reads as a PDF in a client that hides known extensions.
  const doubled = /\.(pdf|doc|docx|xls|xlsx|jpg|png|txt|htm|html)\.[a-z0-9]{2,4}$/i.exec(name)
  if (doubled) facts.push(`double extension — reads as ${doubled[1].toLowerCase()} but is not`)
  if (/[‪-‮⁦-⁩]/.test(name)) facts.push('contains a bidirectional override character')
  if (attachment.inline) facts.push('referenced inline by the message body')
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
  /** What the first bytes say it is, independent of name and declared type. */
  sniffed: string
  facts: string[]
  /** Defanged indicators found INSIDE the file's bytes, kept separate from the mail's own. */
  inside: string[]
  /**
   * The decoded bytes, for the preview pane. In memory only — nothing on this
   * path writes them to disk, and formatPhishReport never emits them.
   */
  bytes: Uint8Array
}

/** Everything the analyser knows about one message. */
export interface PhishReport {
  headers: HeaderAnalysis
  /** Plain-text body. The HTML body is deliberately NOT carried into the UI as markup. */
  text: string
  htmlSource: string
  /**
   * The words out of the HTML body — what the victim actually read. Empty when
   * the mail had no HTML part. Derived, never a substitute for htmlSource.
   */
  htmlText: string
  links: LinkFinding[]
  /** Links beyond the render cap, counted rather than silently dropped. */
  droppedLinks: number
  attachments: AttachmentReport[]
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
 * with the label — and an unrecognised file returns '' so the report says
 * nothing rather than guessing.
 */
const SIGNATURES: { magic: number[]; label: string }[] = [
  { magic: [0x4d, 0x5a], label: 'Windows executable (MZ)' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: 'Linux executable (ELF)' },
  { magic: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: 'legacy Office document (OLE)' },
  { magic: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP archive or modern Office document' },
  { magic: [0x50, 0x4b, 0x05, 0x06], label: 'empty ZIP archive' },
  { magic: [0x52, 0x61, 0x72, 0x21], label: 'RAR archive' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7-Zip archive' },
  { magic: [0x1f, 0x8b], label: 'gzip archive' },
  { magic: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { magic: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
  { magic: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
  { magic: [0x7b, 0x5c, 0x72, 0x74, 0x66], label: 'RTF document' },
  { magic: [0x23, 0x21], label: 'script with a shebang' }
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
  { ext: /\.(jpg|jpeg)$/i, label: /JPEG/ },
  { ext: /\.png$/i, label: /PNG/ },
  { ext: /\.gif$/i, label: /GIF/ },
  { ext: /\.rtf$/i, label: /RTF/ },
  { ext: /\.(rar)$/i, label: /RAR/ },
  { ext: /\.7z$/i, label: /7-Zip/ },
  { ext: /\.gz$/i, label: /gzip/ }
]

/** One fact when the bytes disagree with the name or the declared type. */
export function contentMismatch(filename: string, contentType: string, sniffed: string): string {
  if (!sniffed) return ''
  const expectation = EXT_EXPECTS.find((e) => e.ext.test(filename))
  if (expectation && !expectation.label.test(sniffed)) {
    return `named ${filename.slice(filename.lastIndexOf('.'))} but the bytes begin as ${sniffed}`
  }
  if (/pdf$/i.test(contentType) && !/PDF/.test(sniffed)) {
    return `declared ${contentType} but the bytes begin as ${sniffed}`
  }
  if (/^image\//i.test(contentType) && !/image/i.test(sniffed)) {
    return `declared ${contentType} but the bytes begin as ${sniffed}`
  }
  return ''
}

/** Bytes read as text for indicator extraction. Capped: this is a scan, not a load. */
const STRINGS_CAP = 1_000_000

export async function analysePhishing(raw: string, owned: string[], brands: string[]): Promise<PhishReport> {
  const eml = parseEml(raw)
  const headers = analyseHeaders(raw, owned)
  const { links, dropped } = extractLinks(eml.text, eml.html, brands)
  const notes = [...eml.notes]
  if (dropped > 0) notes.push(`${dropped} further links are in this message and are not listed.`)

  const attachments = await Promise.all(eml.attachments.map((a) => readAttachment(a, owned)))

  // The sender's own domain gets the folding the link hosts get. Five of the
  // shipped classifications are impersonation of one kind or another, and the
  // domain being impersonated is usually in the From line, not in a link.
  // Through addressOf, not a hand-rolled lastIndexOf('@'). The hardened reader
  // strips quoted display names and RFC 5322 comments; slicing the raw value
  // read the LAST @ in the line, so a comment or a display name carrying an
  // address decided which domain got the look-alike check — the exact evasion
  // 2.32.0 closed for the Observations panel and left open here.
  const fromValue = headers.identities.find((i) => i.label === 'From')?.value ?? ''
  const senderAddress = addressOf(fromValue)
  const at = senderAddress.lastIndexOf('@')
  const senderHost = at < 0 ? '' : senderAddress.slice(at + 1).toLowerCase()
  const senderFacts = senderHost ? hostFacts(senderHost, brands, senderHost) : []

  // Built once, from what was actually parsed, and used by both the copy
  // button and the case — one source, so the two can never disagree.
  const seen = new Set<string>()
  const indicators: string[] = []
  const push = (line: string): void => {
    if (line && !seen.has(line)) {
      seen.add(line)
      indicators.push(line)
    }
  }
  const headerBlock = raw.split(/\n\s*\n/)[0] ?? ''
  for (const ioc of extractIocsFromText(`${headerBlock}\n${eml.text}`, [])) push(formatIocLine(ioc, owned))
  for (const link of links) {
    if (link.target) push(formatIocLine({ type: 'url', value: link.target }, owned))
  }
  for (const attachment of attachments) {
    if (attachment.sha256) push(formatIocLine({ type: 'hash', value: attachment.sha256 }, owned))
  }

  return {
    headers,
    text: eml.text,
    htmlSource: eml.html,
    htmlText: htmlToText(eml.html),
    links,
    droppedLinks: dropped,
    attachments,
    senderFacts,
    indicators,
    notes: dedupe(notes)
  }
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

async function readAttachment(a: Attachment, owned: string[]): Promise<AttachmentReport> {
  const facts = attachmentFacts(a)
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
      sniffed: '',
      facts: [...facts, 'this part could not be decoded, so its size, hashes and type are not recorded'],
      inside: [],
      bytes: new Uint8Array()
    }
  }
  const sniffed = sniffType(a.bytes)
  const mismatch = contentMismatch(a.filename, a.contentType, sniffed)
  // A part that was not transfer-encoded reached us through the reader's line
  // normalisation, so its bytes are the message's text, not the file as sent.
  // base64 and quoted-printable are ASCII on the wire and round-trip exactly;
  // these do not, and a hash that will not match the sender's copy has to say
  // so rather than be quoted at a sandbox as if it would.
  const wireExact = a.exact
  return {
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    sha256: await hashBytes(a.bytes),
    sha1: await hashBytes(a.bytes, 'SHA-1'),
    sniffed,
    facts: [
      ...(mismatch ? [mismatch] : []),
      ...facts,
      ...(wireExact
        ? []
        : ['this part carried no transfer encoding, so the hashes are of the decoded text, not of the bytes as sent'])
    ],
    inside: stringsInside(a.bytes, owned),
    bytes: a.bytes
  }
}

/**
 * Indicators carried INSIDE an attachment's bytes.
 *
 * Kept as its own list and never merged into the mail's own links: where an
 * indicator was found is half of what it means, and an analyst reading "this
 * URL was in the message" when it was really inside a spreadsheet has been
 * told something untrue.
 */
function stringsInside(bytes: Uint8Array, owned: string[]): string[] {
  if (!bytes.length) return []
  const slice = bytes.length > STRINGS_CAP ? bytes.subarray(0, STRINGS_CAP) : bytes
  let text = ''
  try {
    text = new TextDecoder('utf-8').decode(slice)
  } catch {
    return []
  }
  return extractIocsFromText(text, [])
    .slice(0, 100)
    .map((ioc) => formatIocLine(ioc, owned))
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
  lines.push('### Links', '')
  if (report.links.length) {
    for (const link of report.links) {
      const wrapped = link.wrappedBy ? ` (unwrapped from ${link.wrappedBy})` : ''
      lines.push(`- ${quoteUntrusted(defangIoc(link.target, 'url'))}${wrapped}`)
      for (const flag of link.flags) lines.push(`  - ${quoteUntrusted(flag)}`)
    }
    if (report.droppedLinks > 0) lines.push(`- ${report.droppedLinks} further links are not listed.`)
  } else {
    lines.push('None found.')
  }
  lines.push('', '### Attachments', '')
  if (report.attachments.length) {
    for (const a of report.attachments) {
      const size = a.sha256 ? `${a.size} bytes` : 'size not recorded'
      lines.push(`- ${quoteUntrusted(a.filename)} — ${quoteUntrusted(a.contentType)}, ${size}`)
      lines.push(`  - SHA-256 ${a.sha256 || 'not recorded'}${a.sha256 ? ' (computed here)' : ''}`)
      lines.push(`  - SHA-1 ${a.sha1 || 'not recorded'}${a.sha1 ? ' (computed here)' : ''}`)
      if (a.sniffed) lines.push(`  - bytes begin as ${a.sniffed}`)
      for (const fact of a.facts) lines.push(`  - ${quoteUntrusted(fact)}`)
      for (const found of a.inside) lines.push(`  - found inside the file: ${quoteUntrusted(found)}`)
    }
  } else {
    lines.push('None.')
  }
  // The message itself. The screen told the analyst the copied report carried
  // the rest of a truncated body, and it carried none of it — the body reached
  // no section at all, so a case created from the analysis held an analysis of
  // a mail whose text was nowhere. Fenced with a backtick run longer than
  // anything inside it, so hostile markdown cannot close its own block, and
  // nothing inside a fence autolinks.
  lines.push('', '### Message body', '')
  if (report.text.trim() || report.htmlSource.trim()) {
    if (report.text.trim()) lines.push('Plain text:', '', fenced(report.text.trim()), '')
    if (report.htmlText.trim()) {
      lines.push('Text extracted from the HTML, not rendered:', '', fenced(report.htmlText.trim()), '')
    }
    if (report.htmlSource.trim()) lines.push('HTML source, not rendered:', '', fenced(report.htmlSource.trim()))
  } else {
    lines.push('Not recorded.')
  }

  lines.push('', '### Indicators', '')
  if (report.indicators.length) for (const i of report.indicators) lines.push(`- ${quoteUntrusted(i)}`)
  else lines.push('None found.')
  if (report.notes.length) {
    lines.push('', '### Parser notes', '')
    for (const note of report.notes) lines.push(`- ${quoteUntrusted(note)}`)
  }
  return lines.join('\n')
}

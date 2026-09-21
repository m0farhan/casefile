import { type Attachment, hashBytes, parseEml } from './eml'
import { type HeaderAnalysis, analyseHeaders, formatHeaderReport } from './emailHeaders'
import { defangIoc } from './ioc'
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

const GATEWAYS: { name: string; test: RegExp; extract(url: string): string }[] = [
  {
    name: 'Microsoft Safe Links',
    test: /safelinks\.protection\.outlook\.com/i,
    extract: (url) => new URL(url).searchParams.get('url') ?? ''
  },
  {
    name: 'Google redirect',
    test: /\/\/(www\.)?google\.[a-z.]+\/url/i,
    extract: (url) => {
      const params = new URL(url).searchParams
      return params.get('q') ?? params.get('url') ?? ''
    }
  },
  {
    name: 'Barracuda LinkProtect',
    test: /linkprotect\.cudasvc\.com/i,
    extract: (url) => new URL(url).searchParams.get('a') ?? ''
  },
  {
    name: 'Proofpoint URL Defense',
    test: /urldefense\.(com|proofpoint\.com)/i,
    extract: (url) => {
      // v3: …/v3/__<real url>__;<base64 of replaced chars>!!…
      const v3 = /\/v3\/__(.+?)__;/.exec(url)
      if (v3) return v3[1]
      // v2: …/v2/url?u=<url with _ for / and - for %>&d=…
      const v2 = new URL(url).searchParams.get('u')
      return v2 ? v2.replace(/_/g, '/').replace(/-/g, '%') : ''
    }
  },
  {
    name: 'Mimecast',
    test: /protect(-[a-z0-9]+)?\.mimecast\.com/i,
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
    const gateway = GATEWAYS.find((g) => g.test.test(current))
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
    current = decodePercentEscapes(next)
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

/** The registrable-ish label: `login.paypa1.test` → `paypa1`. */
function brandLabel(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? '')
}

/**
 * Stated facts about a host. `brands` is the analyst's own list of names worth
 * impersonating — empty by default, because a shipped brand list would be this
 * plugin deciding whose customers matter.
 */
export function hostFacts(host: string, brands: string[]): string[] {
  const facts: string[] = []
  if (!host) return facts
  if (/^xn--/i.test(host) || host.split('.').some((l) => /^xn--/i.test(l))) {
    facts.push('punycode host — the name shown in a client may not be the name here')
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) facts.push('link points at a bare IP address, not a name')
  const label = brandLabel(host)
  const folded = skeleton(label)
  for (const brand of brands) {
    const target = skeleton(brand.toLowerCase())
    if (!target || label === brand.toLowerCase()) continue
    if (folded === target) facts.push(`reads as "${brand}" once look-alike characters are folded`)
    else if (editDistanceAtMostOne(folded, target)) facts.push(`one character away from "${brand}"`)
  }
  return facts
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi
const HREF_RE = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi

/** Every link in the mail: bare ones in the text, and the href/src in the HTML source. */
export function extractLinks(text: string, html: string, brands: string[]): LinkFinding[] {
  const raws = new Set<string>()
  for (const m of text.matchAll(URL_RE)) raws.add(m[0])
  for (const m of html.matchAll(HREF_RE)) {
    const value = m[1].replace(/&amp;/gi, '&').trim()
    if (/^https?:\/\//i.test(value)) raws.add(value)
  }
  // Anchor text that is itself a URL: `<a href="http://evil">http://paypal.test</a>`
  // is the oldest display trick there is, so the two are compared.
  const shown = new Map<string, string>()
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]*>/g, '').trim()
    if (/^https?:\/\//i.test(label)) shown.set(m[1].replace(/&amp;/gi, '&').trim(), label)
  }

  const out: LinkFinding[] = []
  for (const raw of raws) {
    const { target, wrappedBy } = unwrapUrl(raw)
    let host = ''
    try {
      host = new URL(target).hostname.toLowerCase()
    } catch {
      host = ''
    }
    const flags = hostFacts(host, brands)
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
  return out
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

/** Everything the analyser knows about one message. */
export interface PhishReport {
  headers: HeaderAnalysis
  /** Plain-text body. The HTML body is deliberately NOT carried into the UI as markup. */
  text: string
  htmlSource: string
  links: LinkFinding[]
  attachments: { filename: string; contentType: string; size: number; sha256: string; facts: string[] }[]
  notes: string[]
}

/**
 * Read one message end to end: headers, body, links, attachments.
 *
 * Async only because attachments are hashed — every hash is computed HERE, so
 * a hash printed next to a file is one this machine worked out from the bytes,
 * never one a tool reported. Nothing is fetched.
 */
export async function analysePhishing(raw: string, owned: string[], brands: string[]): Promise<PhishReport> {
  const eml = parseEml(raw)
  const headers = analyseHeaders(raw, owned)
  const links = extractLinks(eml.text, eml.html, brands)
  const attachments = await Promise.all(
    eml.attachments.map(async (a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      sha256: await hashBytes(a.bytes),
      facts: attachmentFacts(a)
    }))
  )
  return { headers, text: eml.text, htmlSource: eml.html, links, attachments, notes: eml.notes }
}

/** The whole analysis as markdown, for the clipboard or a case description. */
export function formatPhishReport(report: PhishReport): string {
  const lines = [formatHeaderReport(report.headers), '', '### Links', '']
  if (report.links.length) {
    for (const link of report.links) {
      const wrapped = link.wrappedBy ? ` (unwrapped from ${link.wrappedBy})` : ''
      lines.push(`- ${defangIoc(link.target, 'url')}${wrapped}`)
      for (const flag of link.flags) lines.push(`  - ${flag}`)
    }
  } else {
    lines.push('None found.')
  }
  lines.push('', '### Attachments', '')
  if (report.attachments.length) {
    for (const a of report.attachments) {
      lines.push(`- ${a.filename} — ${a.contentType}, ${a.size} bytes`)
      lines.push(`  - SHA-256 ${a.sha256} (computed here)`)
      for (const fact of a.facts) lines.push(`  - ${fact}`)
    }
  } else {
    lines.push('None.')
  }
  if (report.notes.length) {
    lines.push('', '### Parser notes', '')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}

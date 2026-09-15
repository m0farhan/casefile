import type { IocType } from '../types'
import { refangIoc } from './ioc'

/**
 * Live IOC reputation checks: pure request builders + response parsers, no
 * obsidian / network imports — vitest-covered; IocSection performs the actual
 * HTTP via Obsidian's requestUrl and renders the results.
 *
 * Provider coverage follows what each API actually supports:
 *  - VirusTotal: ip, domain, hash, url — and email via its DOMAIN (VT has no
 *    email-address object; the queried domain is surfaced honestly in the UI).
 *  - AbuseIPDB: ip only (the API has no domain or hash endpoints).
 *  - abuse.ch (one shared auth key): MalwareBazaar for hashes, URLhaus for
 *    urls and domains, ThreatFox for ips — one platform per type keeps the
 *    chip row tidy. Absent from a listing is 'unknown', never 'clean'.
 * Requests fire only on explicit analyst action, never automatically.
 */

export type RepProvider = 'virustotal' | 'abuseipdb' | 'malwarebazaar' | 'urlhaus' | 'threatfox'
export type RepVerdict = 'malicious' | 'suspicious' | 'clean' | 'unknown'

export interface RepKeys {
  virustotal?: string
  abuseipdb?: string
  abusech?: string
}

export interface RepRequest {
  provider: RepProvider
  /** What is actually queried (differs from the IOC for email → its domain). */
  queried: string
  url: string
  /** Absent = GET (the VT/AbuseIPDB shape); abuse.ch lookups POST a body. */
  method?: 'POST'
  body?: string
  headers: Record<string, string>
  /** Vendor page for the analyst to pivot into. */
  link: string
}

export interface RepOutcome {
  verdict: RepVerdict
  /** Short human summary: "9/94 vendors flag malicious", "rate limited…". */
  summary: string
  /**
   * Vendor page resolved from the RESPONSE, when the request can't name it
   * (MalwareBazaar's sample page needs the sha256, URLhaus's url page its id).
   * Overrides RepRequest.link via spread order in the caller.
   */
  link?: string
}

export const PROVIDER_LABELS: Record<RepProvider, string> = {
  virustotal: 'VirusTotal',
  abuseipdb: 'AbuseIPDB',
  malwarebazaar: 'MalwareBazaar',
  urlhaus: 'URLhaus',
  threatfox: 'ThreatFox'
}

/** The one abuse.ch platform covering this IOC type (email: none). */
function abuseChProvider(type: IocType): RepProvider | null {
  if (type === 'hash') return 'malwarebazaar'
  if (type === 'url' || type === 'domain') return 'urlhaus'
  if (type === 'ip') return 'threatfox'
  return null
}

/** RFC 4648 base64url without padding — VirusTotal's URL identifier. */
export function vtUrlId(url: string): string {
  const bytes = new TextEncoder().encode(url)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const VT_API = 'https://www.virustotal.com/api/v3'
const VT_GUI = 'https://www.virustotal.com/gui'

function vtRequest(kind: string, id: string, guiKind: string, guiId: string, key: string, queried: string): RepRequest {
  return {
    provider: 'virustotal',
    queried,
    url: `${VT_API}/${kind}/${encodeURIComponent(id)}`,
    headers: { 'x-apikey': key },
    link: `${VT_GUI}/${guiKind}/${encodeURIComponent(guiId)}`
  }
}

/**
 * Build the provider requests applicable to one IOC. Values refang first
 * (idempotent on real values) so a defanged value pasted straight into the
 * row still queries correctly. Providers without a configured key are simply
 * absent from the result.
 */
export function buildRequests(type: IocType, value: string, keys: RepKeys): RepRequest[] {
  const real = refangIoc(value)
  const out: RepRequest[] = []
  const vt = keys.virustotal?.trim()
  const ab = keys.abuseipdb?.trim()
  const ac = keys.abusech?.trim()

  if (vt) {
    if (type === 'ip') out.push(vtRequest('ip_addresses', real, 'ip-address', real, vt, real))
    else if (type === 'domain') out.push(vtRequest('domains', real, 'domain', real, vt, real))
    else if (type === 'hash') out.push(vtRequest('files', real, 'file', real, vt, real))
    else if (type === 'url') {
      const id = vtUrlId(real)
      out.push(vtRequest('urls', id, 'url', id, vt, real))
    } else if (type === 'email') {
      const domain = real.split('@').pop() ?? ''
      if (domain.includes('.')) out.push(vtRequest('domains', domain, 'domain', domain, vt, domain))
    }
  }

  if (ab && type === 'ip') {
    out.push({
      provider: 'abuseipdb',
      queried: real,
      url: `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(real)}&maxAgeInDays=90`,
      headers: { Key: ab, Accept: 'application/json' },
      link: `https://www.abuseipdb.com/check/${encodeURIComponent(real)}`
    })
  }

  if (ac) {
    const form = { 'Auth-Key': ac, 'Content-Type': 'application/x-www-form-urlencoded' }
    if (type === 'hash') {
      // Sample-page link comes from the response (needs the sha256; the query
      // may be an md5/sha1) — '' until parseReputation supplies it.
      out.push({
        provider: 'malwarebazaar',
        queried: real,
        url: 'https://mb-api.abuse.ch/api/v1/',
        method: 'POST',
        body: `query=get_info&hash=${encodeURIComponent(real)}`,
        headers: form,
        link: ''
      })
    } else if (type === 'url') {
      // Url-page link needs the URLhaus id from the response — '' until then.
      out.push({
        provider: 'urlhaus',
        queried: real,
        url: 'https://urlhaus-api.abuse.ch/v1/url/',
        method: 'POST',
        body: `url=${encodeURIComponent(real)}`,
        headers: form,
        link: ''
      })
    } else if (type === 'domain') {
      out.push({
        provider: 'urlhaus',
        queried: real,
        url: 'https://urlhaus-api.abuse.ch/v1/host/',
        method: 'POST',
        body: `host=${encodeURIComponent(real)}`,
        headers: form,
        link: `https://urlhaus.abuse.ch/host/${encodeURIComponent(real)}/`
      })
    } else if (type === 'ip') {
      out.push({
        provider: 'threatfox',
        queried: real,
        url: 'https://threatfox-api.abuse.ch/api/v1/',
        method: 'POST',
        body: JSON.stringify({ query: 'search_ioc', search_term: real }),
        headers: { 'Auth-Key': ac, 'Content-Type': 'application/json' },
        link: `https://threatfox.abuse.ch/browse.php?search=${encodeURIComponent(`ioc:${real}`)}`
      })
    }
  }

  return out
}

/**
 * Providers that DO cover this IOC type but have no key configured — the UI
 * names them explicitly so a missing key never reads as a provider verdict
 * (or as the provider having been consulted at all).
 */
export function skippedProviders(type: IocType, keys: RepKeys): RepProvider[] {
  const out: RepProvider[] = []
  if (!keys.virustotal?.trim()) out.push('virustotal')
  if (!keys.abuseipdb?.trim() && type === 'ip') out.push('abuseipdb')
  if (!keys.abusech?.trim()) {
    const ac = abuseChProvider(type)
    if (ac) out.push(ac)
  }
  return out
}

function httpOutcome(provider: RepProvider, status: number): RepOutcome | null {
  if (status === 200) return null
  if (status === 401 || status === 403) return { verdict: 'unknown', summary: 'key rejected' }
  if (status === 429) return { verdict: 'unknown', summary: 'rate limited — retry shortly' }
  if (status === 404) {
    return {
      verdict: 'unknown',
      summary: provider === 'virustotal' ? 'not found in VirusTotal' : 'not found'
    }
  }
  return { verdict: 'unknown', summary: `request failed (HTTP ${status})` }
}

/**
 * abuse.ch signals not-listed inside a 200 body, per platform vocabulary.
 * Not listed is 'unknown' — abuse.ch only records malware, so absence is
 * never evidence of a clean indicator.
 */
const ABUSECH_NOT_LISTED = new Set(['no_result', 'no_results', 'hash_not_found'])

function parseAbuseCh(provider: RepProvider, body: Record<string, unknown>): RepOutcome {
  const qs = typeof body.query_status === 'string' ? body.query_status : ''
  if (ABUSECH_NOT_LISTED.has(qs)) {
    return { verdict: 'unknown', summary: `not listed in ${PROVIDER_LABELS[provider]}` }
  }
  if (qs !== 'ok') return { verdict: 'unknown', summary: 'unreadable response' }

  if (provider === 'urlhaus') {
    // Two response shapes: /v1/url/ carries url_status/threat/id at top level;
    // /v1/host/ carries url_count (its link was set at request time).
    if (typeof body.url_status === 'string' || typeof body.threat === 'string') {
      const parts = [body.threat, body.url_status].filter((s): s is string => typeof s === 'string' && s !== '')
      const out: RepOutcome = { verdict: 'malicious', summary: parts.join(' · ') || 'listed as malicious' }
      if (typeof body.id === 'string' && body.id) out.link = `https://urlhaus.abuse.ch/url/${body.id}/`
      return out
    }
    const count = typeof body.url_count === 'number' || typeof body.url_count === 'string' ? String(body.url_count) : ''
    return {
      verdict: 'malicious',
      summary: count ? `${count} malicious URL${count === '1' ? '' : 's'} known` : 'host listed'
    }
  }

  // MalwareBazaar and ThreatFox both answer with a data array of listings.
  const first: unknown = Array.isArray(body.data) ? body.data[0] : undefined
  if (!first || typeof first !== 'object') return { verdict: 'unknown', summary: 'unreadable response' }
  const entry = first as Record<string, unknown>
  if (provider === 'malwarebazaar') {
    const sig = typeof entry.signature === 'string' ? entry.signature : ''
    const sha = typeof entry.sha256_hash === 'string' ? entry.sha256_hash : ''
    const out: RepOutcome = { verdict: 'malicious', summary: sig || 'known malware sample' }
    if (sha) out.link = `https://bazaar.abuse.ch/sample/${sha}/`
    return out
  }
  const malware = typeof entry.malware_printable === 'string' ? entry.malware_printable : ''
  return { verdict: 'malicious', summary: malware || 'listed as malicious' }
}

/** Interpret one provider response. Malformed bodies degrade to unknown, never throw. */
export function parseReputation(provider: RepProvider, status: number, bodyText: string): RepOutcome {
  const early = httpOutcome(provider, status)
  if (early) return early

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { verdict: 'unknown', summary: 'unreadable response' }
  }
  if (provider === 'malwarebazaar' || provider === 'urlhaus' || provider === 'threatfox') {
    if (!body || typeof body !== 'object') return { verdict: 'unknown', summary: 'unreadable response' }
    return parseAbuseCh(provider, body as Record<string, unknown>)
  }
  const data = (body as { data?: Record<string, unknown> }).data
  if (!data || typeof data !== 'object') return { verdict: 'unknown', summary: 'unreadable response' }

  if (provider === 'virustotal') {
    const attrs = data.attributes as { last_analysis_stats?: Record<string, number> } | undefined
    const stats = attrs?.last_analysis_stats
    if (!stats) return { verdict: 'unknown', summary: 'no analysis available' }
    const malicious = stats.malicious ?? 0
    const suspicious = stats.suspicious ?? 0
    const total = malicious + suspicious + (stats.harmless ?? 0) + (stats.undetected ?? 0)
    if (total === 0) return { verdict: 'unknown', summary: 'no analysis available' }
    if (malicious > 0) return { verdict: 'malicious', summary: `${malicious}/${total} vendors flag malicious` }
    if (suspicious > 0) return { verdict: 'suspicious', summary: `${suspicious}/${total} vendors flag suspicious` }
    return { verdict: 'clean', summary: `0/${total} vendors flag it` }
  }

  const score = typeof data.abuseConfidenceScore === 'number' ? data.abuseConfidenceScore : null
  if (score === null) return { verdict: 'unknown', summary: 'unreadable response' }
  const reports = typeof data.totalReports === 'number' ? data.totalReports : 0
  const detail = `${score}% confidence · ${reports} report${reports === 1 ? '' : 's'}`
  if (score >= 75) return { verdict: 'malicious', summary: detail }
  if (score >= 25) return { verdict: 'suspicious', summary: detail }
  return { verdict: 'clean', summary: reports === 0 ? 'no reports' : detail }
}

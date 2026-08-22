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
 * Requests fire only on explicit analyst action, never automatically.
 */

export type RepProvider = 'virustotal' | 'abuseipdb'
export type RepVerdict = 'malicious' | 'suspicious' | 'clean' | 'unknown'

export interface RepRequest {
  provider: RepProvider
  /** What is actually queried (differs from the IOC for email → its domain). */
  queried: string
  url: string
  headers: Record<string, string>
  /** Vendor page for the analyst to pivot into. */
  link: string
}

export interface RepOutcome {
  verdict: RepVerdict
  /** Short human summary: "9/94 vendors flag malicious", "rate limited…". */
  summary: string
}

export const PROVIDER_LABELS: Record<RepProvider, string> = {
  virustotal: 'VirusTotal',
  abuseipdb: 'AbuseIPDB'
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
export function buildRequests(
  type: IocType,
  value: string,
  keys: { virustotal?: string; abuseipdb?: string }
): RepRequest[] {
  const real = refangIoc(value)
  const out: RepRequest[] = []
  const vt = keys.virustotal?.trim()
  const ab = keys.abuseipdb?.trim()

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

  return out
}

/**
 * Providers that DO cover this IOC type but have no key configured — the UI
 * names them explicitly so a missing key never reads as a provider verdict
 * (or as the provider having been consulted at all).
 */
export function skippedProviders(type: IocType, keys: { virustotal?: string; abuseipdb?: string }): RepProvider[] {
  const out: RepProvider[] = []
  if (!keys.virustotal?.trim()) out.push('virustotal')
  if (!keys.abuseipdb?.trim() && type === 'ip') out.push('abuseipdb')
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

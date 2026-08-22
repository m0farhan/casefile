import { describe, expect, it } from 'vitest'
import { buildRequests, parseReputation, skippedProviders, vtUrlId } from './reputation'

const KEYS = { virustotal: 'vt-key', abuseipdb: 'ab-key' }

describe('buildRequests', () => {
  it('sends an IP to both providers', () => {
    const reqs = buildRequests('ip', '103.80.134.63', KEYS)
    expect(reqs.map((r) => r.provider)).toEqual(['virustotal', 'abuseipdb'])
    expect(reqs[0].url).toBe('https://www.virustotal.com/api/v3/ip_addresses/103.80.134.63')
    expect(reqs[0].headers).toEqual({ 'x-apikey': 'vt-key' })
    expect(reqs[1].url).toContain('ipAddress=103.80.134.63')
    expect(reqs[1].headers.Key).toBe('ab-key')
    expect(reqs[1].link).toBe('https://www.abuseipdb.com/check/103.80.134.63')
  })

  it('refangs defanged values before querying', () => {
    const reqs = buildRequests('ip', '103[.]80[.]134[.]63', KEYS)
    expect(reqs[0].url).toContain('103.80.134.63')
    expect(reqs[1].url).toContain('ipAddress=103.80.134.63')
  })

  it('sends domain and hash to VirusTotal only', () => {
    expect(buildRequests('domain', 'coffeeshooop.com', KEYS).map((r) => r.provider)).toEqual(['virustotal'])
    const hash = buildRequests('hash', 'cd903ad2211cf7d166646d75e57fb866', KEYS)
    expect(hash.map((r) => r.provider)).toEqual(['virustotal'])
    expect(hash[0].url).toContain('/files/cd903ad2211cf7d166646d75e57fb866')
  })

  it('encodes URLs with the VirusTotal base64url id', () => {
    const [req] = buildRequests('url', 'https://free-coffee.zip/a?b=1', KEYS)
    const id = vtUrlId('https://free-coffee.zip/a?b=1')
    expect(id).not.toMatch(/[+/=]/)
    expect(req.url).toBe(`https://www.virustotal.com/api/v3/urls/${id}`)
  })

  it('queries the domain of an email and says so', () => {
    const [req] = buildRequests('email', 'free[at]coffeeshooop[.]com', KEYS)
    expect(req.url).toBe('https://www.virustotal.com/api/v3/domains/coffeeshooop.com')
    expect(req.queried).toBe('coffeeshooop.com')
  })

  it('omits providers without a key, and yields nothing with no keys', () => {
    expect(buildRequests('ip', '1.2.3.4', { virustotal: 'vt-key' }).map((r) => r.provider)).toEqual(['virustotal'])
    expect(buildRequests('ip', '1.2.3.4', { abuseipdb: 'ab-key' }).map((r) => r.provider)).toEqual(['abuseipdb'])
    expect(buildRequests('ip', '1.2.3.4', {})).toEqual([])
    expect(buildRequests('domain', 'x.com', { abuseipdb: 'ab-key' })).toEqual([])
  })
})

describe('parseReputation - VirusTotal', () => {
  const vtBody = (stats: Record<string, number>) =>
    JSON.stringify({ data: { attributes: { last_analysis_stats: stats } } })

  it('flags malicious with the vendor ratio', () => {
    const out = parseReputation(
      'virustotal',
      200,
      vtBody({ malicious: 9, suspicious: 0, harmless: 60, undetected: 25 })
    )
    expect(out).toEqual({ verdict: 'malicious', summary: '9/94 vendors flag malicious' })
  })

  it('flags suspicious when nothing is outright malicious', () => {
    const out = parseReputation(
      'virustotal',
      200,
      vtBody({ malicious: 0, suspicious: 3, harmless: 70, undetected: 20 })
    )
    expect(out).toEqual({ verdict: 'suspicious', summary: '3/93 vendors flag suspicious' })
  })

  it('reads clean when vendors analyzed and none flagged', () => {
    const out = parseReputation(
      'virustotal',
      200,
      vtBody({ malicious: 0, suspicious: 0, harmless: 70, undetected: 20 })
    )
    expect(out).toEqual({ verdict: 'clean', summary: '0/90 vendors flag it' })
  })

  it('degrades honestly on 404, 401, 429 and junk bodies', () => {
    expect(parseReputation('virustotal', 404, '')).toEqual({
      verdict: 'unknown',
      summary: 'not found in VirusTotal'
    })
    expect(parseReputation('virustotal', 401, '')).toEqual({ verdict: 'unknown', summary: 'key rejected' })
    expect(parseReputation('virustotal', 429, '').summary).toContain('rate limited')
    expect(parseReputation('virustotal', 200, 'not json').verdict).toBe('unknown')
    expect(parseReputation('virustotal', 200, '{}').verdict).toBe('unknown')
  })
})

describe('parseReputation - AbuseIPDB', () => {
  const abBody = (score: number, reports: number) =>
    JSON.stringify({ data: { abuseConfidenceScore: score, totalReports: reports } })

  it('maps confidence bands to verdicts', () => {
    expect(parseReputation('abuseipdb', 200, abBody(97, 23))).toEqual({
      verdict: 'malicious',
      summary: '97% confidence · 23 reports'
    })
    expect(parseReputation('abuseipdb', 200, abBody(40, 2)).verdict).toBe('suspicious')
    expect(parseReputation('abuseipdb', 200, abBody(0, 0))).toEqual({ verdict: 'clean', summary: 'no reports' })
    expect(parseReputation('abuseipdb', 200, abBody(10, 1))).toEqual({
      verdict: 'clean',
      summary: '10% confidence · 1 report'
    })
  })

  it('degrades honestly on errors', () => {
    expect(parseReputation('abuseipdb', 429, '').summary).toContain('rate limited')
    expect(parseReputation('abuseipdb', 200, '{"data":{}}').verdict).toBe('unknown')
  })
})

describe('skippedProviders', () => {
  it('names the keyless provider an ip would have used', () => {
    expect(skippedProviders('ip', { virustotal: 'vt-key' })).toEqual(['abuseipdb'])
    expect(skippedProviders('ip', { abuseipdb: 'ab-key' })).toEqual(['virustotal'])
    expect(skippedProviders('ip', {})).toEqual(['virustotal', 'abuseipdb'])
  })

  it('never blames a provider that does not cover the type', () => {
    expect(skippedProviders('domain', { virustotal: 'vt-key' })).toEqual([])
    expect(skippedProviders('hash', { virustotal: 'vt-key' })).toEqual([])
    expect(skippedProviders('hash', {})).toEqual(['virustotal'])
  })
})

import { describe, expect, it } from 'vitest'
import { buildRequests, parseReputation, skippedProviders, vtUrlId } from './reputation'

const KEYS = { virustotal: 'vt-key', abuseipdb: 'ab-key' }

describe('buildRequests', () => {
  it('sends an IP to both providers', () => {
    const reqs = buildRequests('ip', '103.80.134.63', KEYS, [])
    expect(reqs.map((r) => r.provider)).toEqual(['virustotal', 'abuseipdb'])
    expect(reqs[0].url).toBe('https://www.virustotal.com/api/v3/ip_addresses/103.80.134.63')
    expect(reqs[0].headers).toEqual({ 'x-apikey': 'vt-key' })
    expect(reqs[1].url).toContain('ipAddress=103.80.134.63')
    expect(reqs[1].headers.Key).toBe('ab-key')
    expect(reqs[1].link).toBe('https://www.abuseipdb.com/check/103.80.134.63')
  })

  it('refangs defanged values before querying', () => {
    const reqs = buildRequests('ip', '103[.]80[.]134[.]63', KEYS, [])
    expect(reqs[0].url).toContain('103.80.134.63')
    expect(reqs[1].url).toContain('ipAddress=103.80.134.63')
  })

  it('sends domain and hash to VirusTotal only', () => {
    expect(buildRequests('domain', 'coffeeshooop.com', KEYS, []).map((r) => r.provider)).toEqual(['virustotal'])
    const hash = buildRequests('hash', 'cd903ad2211cf7d166646d75e57fb866', KEYS, [])
    expect(hash.map((r) => r.provider)).toEqual(['virustotal'])
    expect(hash[0].url).toContain('/files/cd903ad2211cf7d166646d75e57fb866')
  })

  it('encodes URLs with the VirusTotal base64url id', () => {
    const [req] = buildRequests('url', 'https://free-coffee.zip/a?b=1', KEYS, [])
    const id = vtUrlId('https://free-coffee.zip/a?b=1')
    expect(id).not.toMatch(/[+/=]/)
    expect(req.url).toBe(`https://www.virustotal.com/api/v3/urls/${id}`)
  })

  it('queries the domain of an email and says so', () => {
    const [req] = buildRequests('email', 'free[at]coffeeshooop[.]com', KEYS, [])
    expect(req.url).toBe('https://www.virustotal.com/api/v3/domains/coffeeshooop.com')
    expect(req.queried).toBe('coffeeshooop.com')
  })

  it('omits providers without a key, and yields nothing with no keys', () => {
    expect(buildRequests('ip', '1.2.3.4', { virustotal: 'vt-key' }, []).map((r) => r.provider)).toEqual(['virustotal'])
    expect(buildRequests('ip', '1.2.3.4', { abuseipdb: 'ab-key' }, []).map((r) => r.provider)).toEqual(['abuseipdb'])
    expect(buildRequests('ip', '1.2.3.4', {}, [])).toEqual([])
    expect(buildRequests('domain', 'x.com', { abuseipdb: 'ab-key' }, [])).toEqual([])
  })
})

describe('buildRequests - abuse.ch', () => {
  const AC = { abusech: 'ac-key' }

  it('sends a hash to MalwareBazaar as a form POST', () => {
    const [req] = buildRequests('hash', 'cd903ad2211cf7d166646d75e57fb866', AC, [])
    expect(req.provider).toBe('malwarebazaar')
    expect(req.url).toBe('https://mb-api.abuse.ch/api/v1/')
    expect(req.method).toBe('POST')
    expect(req.body).toBe('query=get_info&hash=cd903ad2211cf7d166646d75e57fb866')
    expect(req.headers).toEqual({ 'Auth-Key': 'ac-key', 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(req.link).toBe('') // sample page needs the response sha256
  })

  it('sends a url to URLhaus with the value form-encoded', () => {
    const [req] = buildRequests('url', 'https://free-coffee.zip/a?b=1', AC, [])
    expect(req.provider).toBe('urlhaus')
    expect(req.url).toBe('https://urlhaus-api.abuse.ch/v1/url/')
    expect(req.body).toBe(`url=${encodeURIComponent('https://free-coffee.zip/a?b=1')}`)
    expect(req.link).toBe('') // url page needs the response id
  })

  it('sends a domain to the URLhaus host endpoint, refanged', () => {
    const [req] = buildRequests('domain', 'coffeeshooop[.]com', AC, [])
    expect(req.provider).toBe('urlhaus')
    expect(req.url).toBe('https://urlhaus-api.abuse.ch/v1/host/')
    expect(req.body).toBe('host=coffeeshooop.com')
    expect(req.link).toBe('https://urlhaus.abuse.ch/host/coffeeshooop.com/')
  })

  it('sends an ip to ThreatFox as JSON, alongside the other providers', () => {
    const reqs = buildRequests('ip', '103.80.134.63', { ...KEYS, ...AC }, [])
    expect(reqs.map((r) => r.provider)).toEqual(['virustotal', 'abuseipdb', 'threatfox'])
    const tf = reqs[2]
    expect(tf.url).toBe('https://threatfox-api.abuse.ch/api/v1/')
    expect(tf.method).toBe('POST')
    expect(JSON.parse(tf.body ?? '')).toEqual({ query: 'search_ioc', search_term: '103.80.134.63' })
    expect(tf.headers).toEqual({ 'Auth-Key': 'ac-key', 'Content-Type': 'application/json' })
    expect(tf.link).toBe('https://threatfox.abuse.ch/browse.php?search=ioc%3A103.80.134.63')
  })

  it('sends nothing to abuse.ch for an email', () => {
    expect(buildRequests('email', 'free@coffeeshooop.com', AC, [])).toEqual([])
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

  it('reads unknown, never clean, when no vendor confirmed harmless', () => {
    const out = parseReputation('virustotal', 200, vtBody({ malicious: 0, suspicious: 0, harmless: 0, undetected: 70 }))
    expect(out).toEqual({ verdict: 'unknown', summary: '0/70 flagged · none confirmed harmless' })
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

  it('marks the failures worth asking again, and only those', () => {
    // Check all re-sends rows whose lookup got no answer. A rate limit or a
    // server error can clear by itself; 'not found' and 'key rejected' are
    // answers, and asking again would only spend quota.
    expect(parseReputation('virustotal', 429, '').transient).toBe(true)
    expect(parseReputation('abuseipdb', 503, '').transient).toBe(true)
    expect(parseReputation('urlhaus', 500, '').transient).toBe(true)
    expect(parseReputation('virustotal', 401, '').transient).toBeUndefined()
    expect(parseReputation('virustotal', 404, '').transient).toBeUndefined()
    expect(parseReputation('virustotal', 400, '').transient).toBeUndefined()
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
    expect(parseReputation('abuseipdb', 200, abBody(0, 0))).toEqual({ verdict: 'unknown', summary: 'no reports' })
    // Reported, scoring low: that is not a clearance.
    expect(parseReputation('abuseipdb', 200, abBody(10, 1))).toEqual({
      verdict: 'unknown',
      summary: '10% confidence · 1 report · below suspicion threshold'
    })
    expect(parseReputation('abuseipdb', 200, abBody(24, 20)).verdict).toBe('unknown')
  })

  it('reads clean only when AbuseIPDB whitelists the address', () => {
    const body = (score: number) =>
      JSON.stringify({ data: { abuseConfidenceScore: score, totalReports: 3, isWhitelisted: true } })
    expect(parseReputation('abuseipdb', 200, body(0))).toEqual({
      verdict: 'clean',
      summary: 'whitelisted · 0% confidence · 3 reports'
    })
    // A high score never turns green, whitelisted or not.
    expect(parseReputation('abuseipdb', 200, body(80)).verdict).toBe('malicious')
  })

  it('degrades honestly on errors', () => {
    expect(parseReputation('abuseipdb', 429, '').summary).toContain('rate limited')
    expect(parseReputation('abuseipdb', 200, '{"data":{}}').verdict).toBe('unknown')
  })
})

describe('parseReputation - abuse.ch', () => {
  it('reads a MalwareBazaar listing as malicious, named by its signature', () => {
    const body = JSON.stringify({
      query_status: 'ok',
      data: [{ signature: 'AgentTesla', sha256_hash: 'a'.repeat(64) }]
    })
    expect(parseReputation('malwarebazaar', 200, body)).toEqual({
      verdict: 'malicious',
      summary: 'AgentTesla',
      link: `https://bazaar.abuse.ch/sample/${'a'.repeat(64)}/`
    })
  })

  it('reads a URLhaus url listing with its status and threat, linked by id', () => {
    const body = JSON.stringify({ query_status: 'ok', id: '105821', url_status: 'online', threat: 'malware_download' })
    expect(parseReputation('urlhaus', 200, body)).toEqual({
      verdict: 'malicious',
      summary: 'malware_download · online',
      link: 'https://urlhaus.abuse.ch/url/105821/'
    })
  })

  it('reads a URLhaus host listing by its malicious-URL count', () => {
    const out = parseReputation('urlhaus', 200, JSON.stringify({ query_status: 'ok', url_count: 53 }))
    expect(out).toEqual({ verdict: 'malicious', summary: '53 malicious URLs known' })
  })

  it('reads a ThreatFox listing as malicious, named by its malware', () => {
    const body = JSON.stringify({ query_status: 'ok', data: [{ malware_printable: 'Cobalt Strike' }] })
    expect(parseReputation('threatfox', 200, body)).toEqual({ verdict: 'malicious', summary: 'Cobalt Strike' })
  })

  it('treats not-listed as unknown, never clean', () => {
    expect(parseReputation('malwarebazaar', 200, '{"query_status":"hash_not_found"}')).toEqual({
      verdict: 'unknown',
      summary: 'not listed in MalwareBazaar'
    })
    expect(parseReputation('urlhaus', 200, '{"query_status":"no_results"}')).toEqual({
      verdict: 'unknown',
      summary: 'not listed in URLhaus'
    })
    expect(parseReputation('threatfox', 200, '{"query_status":"no_result"}')).toEqual({
      verdict: 'unknown',
      summary: 'not listed in ThreatFox'
    })
  })

  it('degrades honestly on auth, rate-limit and junk responses', () => {
    expect(parseReputation('malwarebazaar', 401, '')).toEqual({ verdict: 'unknown', summary: 'key rejected' })
    expect(parseReputation('threatfox', 429, '').summary).toContain('rate limited')
    expect(parseReputation('urlhaus', 200, 'not json').verdict).toBe('unknown')
    expect(parseReputation('threatfox', 200, '{"query_status":"ok","data":"error"}').verdict).toBe('unknown')
    expect(parseReputation('malwarebazaar', 200, '{"query_status":"illegal_hash"}')).toEqual({
      verdict: 'unknown',
      summary: 'answered "illegal_hash"'
    })
  })

  it('names a status it read, and calls only a real non-answer unreadable', () => {
    expect(parseReputation('urlhaus', 200, '{"query_status":"invalid_host"}').summary).toBe('answered "invalid_host"')
    expect(parseReputation('urlhaus', 200, '{}').summary).toBe('unreadable response')
    expect(parseReputation('threatfox', 200, '{"query_status":"<b>\\u202e x"}').summary).toBe('unreadable response')
  })
})

describe('skippedProviders', () => {
  it('names the keyless providers an ip would have used', () => {
    expect(skippedProviders('ip', { virustotal: 'vt-key', abusech: 'ac-key' })).toEqual(['abuseipdb'])
    expect(skippedProviders('ip', { abuseipdb: 'ab-key' })).toEqual(['virustotal', 'threatfox'])
    expect(skippedProviders('ip', {})).toEqual(['virustotal', 'abuseipdb', 'threatfox'])
  })

  it('names the one abuse.ch platform covering each type', () => {
    expect(skippedProviders('hash', { virustotal: 'vt-key' })).toEqual(['malwarebazaar'])
    expect(skippedProviders('domain', { virustotal: 'vt-key' })).toEqual(['urlhaus'])
    expect(skippedProviders('url', { virustotal: 'vt-key' })).toEqual(['urlhaus'])
    expect(skippedProviders('hash', { virustotal: 'vt-key', abusech: 'ac-key' })).toEqual([])
    expect(skippedProviders('hash', {})).toEqual(['virustotal', 'malwarebazaar'])
  })

  it('never blames a provider that does not cover the type', () => {
    expect(skippedProviders('email', { abusech: 'ac-key' })).toEqual(['virustotal'])
    expect(skippedProviders('email', {})).toEqual(['virustotal'])
  })
})

describe('the asset boundary is the one outbound gate (ST-4)', () => {
  it('builds no request at all for the org own estate', () => {
    // Keys are set and the provider covers the type: the only reason nothing
    // is sent is the boundary. Checked before any URL or header is assembled.
    expect(buildRequests('ip', '10.0.0.5', KEYS, [])).toEqual([])
    expect(buildRequests('ip', '192.168.1.20', KEYS, [])).toEqual([])
    expect(buildRequests('domain', 'mail.corp.example', KEYS, ['corp.example'])).toEqual([])
    expect(buildRequests('url', 'https://intranet.corp.example/x', KEYS, ['corp.example'])).toEqual([])
    expect(buildRequests('email', 'bob@corp.example', KEYS, ['corp.example'])).toEqual([])
  })

  it('still sends adversary infrastructure, so the gate is not a blanket off switch', () => {
    expect(buildRequests('ip', '103.80.134.63', KEYS, ['corp.example']).length).toBeGreaterThan(0)
    expect(buildRequests('domain', 'evilcorp.example', KEYS, ['corp.example']).length).toBeGreaterThan(0)
  })

  it('is judged on the value, so re-typing a row cannot walk an address out', () => {
    // The row says "domain" but the value is an internal address.
    expect(buildRequests('domain', '10.0.0.5', KEYS, [])).toEqual([])
  })

  it('sends nothing for a UNC path, a local path or a bracketed address', () => {
    const all = { ...KEYS, abusech: 'ac-key' }
    const owned = ['corp.example']
    for (const v of [
      '\\\\10.0.0.5\\c$\\evil.exe',
      '\\\\dc01.corp.example\\share',
      '[\\\\]dc01[.]corp[.]example\\share\\a.txt',
      'C:\\Users\\jdoe',
      '<john@corp.example>',
      'dc01\\c$\\evil.exe'
    ]) {
      expect(buildRequests('domain', v, all, owned)).toEqual([])
      expect(buildRequests('email', v, all, owned)).toEqual([])
    }
    // Hashes and full URLs still go out.
    expect(buildRequests('hash', 'cd903ad2211cf7d166646d75e57fb866', all, owned).length).toBe(2)
    expect(buildRequests('url', 'https://evil.test/a\\b?c=<d>', all, owned).length).toBe(2)
  })

  it('sends no backslash value the shape gate passed on its reduced host', () => {
    // The gate read files.example.net and contoso.com, then the requests went
    // out carrying the share, the file name and the user.
    const all = { ...KEYS, abusech: 'ac-key' }
    for (const v of [
      '\\\\files.example.net\\Finance\\Q3 payroll.xlsx',
      'contoso.com\\jürgen',
      'dc01.corp.example\\c$\\résumé.exe'
    ]) {
      expect(buildRequests('domain', v, all, [])).toEqual([])
    }
  })

  it('keeps the own IDN domain in, however it is spelled', () => {
    expect(buildRequests('url', 'https://mail.bücher.example/login', KEYS, ['bücher.example'])).toEqual([])
    expect(buildRequests('domain', 'mail\u3002corp.example', KEYS, ['corp.example'])).toEqual([])
  })
})

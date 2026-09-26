import { describe, expect, it } from 'vitest'
import {
  VT_PACE_MS,
  activityValue,
  assetRule,
  defangIoc,
  detectIocType,
  extractIocsFromText,
  formatIocLine,
  hasIocShape,
  iocKey,
  iocSightings,
  parseIocPaste,
  refangIoc,
  sightingsIndex,
  stripProseTail,
  unmatchableAssetRules,
  visibleName,
  vtWaitMs
} from './ioc'
import { makeTask, type Ioc, type Task } from '../types'
import { flattenTasks } from '../store/TaskTreeOps'

describe('defangIoc — a defanged string must not lie about where it goes', () => {
  it('brackets unicode label separators, not just the ASCII dot', () => {
    // Chromium resolves this host as paypal.com.evil.co. Bracketing only the
    // ASCII dot marked the decoy and left the real apex looking untouched.
    expect(defangIoc('https://paypal\u3002com.evil\u3002co/', 'url')).toBe('hxxps://paypal[.]com[.]evil[.]co/')
    expect(defangIoc('evil\uFF0Eco', 'domain')).toBe('evil[.]co')
    expect(defangIoc('evil\uFF61co', 'domain')).toBe('evil[.]co')
  })

  it('strips direction-changing controls that reorder what the reader sees', () => {
    expect(defangIoc('evil\u202Emoc.liame\u202Cco', 'domain')).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u061C]/)
  })

  it('neutralises schemes that execute rather than name a place', () => {
    expect(defangIoc('javascript:fetch("//evil.co/")', 'url')).toBe('javascript[:]fetch("//evil[.]co/")')
    expect(defangIoc('data:text/html,<b>x</b>', 'url')).toBe('data[:]text/html,<b>x</b>')
    expect(defangIoc('file:///etc/passwd', 'url')).toBe('file[:]///etc/passwd')
  })

  it('leaves ordinary values defanged exactly as before', () => {
    expect(defangIoc('https://evil.co/path', 'url')).toBe('hxxps://evil[.]co/path')
    expect(defangIoc('ftp://evil.co/f', 'url')).toBe('ftp[:]//evil[.]co/f')
    expect(defangIoc('a@evil.co', 'email')).toBe('a[at]evil[.]co')
    // A host:port is not a scheme, and an IPv6 literal only looks like one.
    expect(defangIoc('evil.co:8080', 'domain')).toBe('evil[.]co:8080')
    expect(defangIoc('fe80::1', 'ip')).toBe('fe80::1')
    expect(defangIoc('fe80::1', 'domain')).toBe('fe80::1')
  })

  it('breaks every other scheme, not only a list of known-dangerous ones', () => {
    // The handlers remote templates, linked OLE objects and PDF links use.
    // Each one is live when copied into Run or a browser.
    const cases: [string, string][] = [
      ['ms-msdt:/id PCWDiagnostic /skip force', 'ms-msdt[:]/id PCWDiagnostic /skip force'],
      [
        'search-ms:query=invoice&crumb=location:\\\\attacker\\s',
        'search-ms[:]query=invoice&crumb=location:\\\\attacker\\s'
      ],
      ['ms-word:ofe|u|\\\\attacker\\s\\a.docx', 'ms-word[:]ofe|u|\\\\attacker\\s\\a[.]docx'],
      ['mhtml:\\\\attacker\\x.mht!x-usc:y', 'mhtml[:]\\\\attacker\\x[.]mht!x-usc:y']
    ]
    for (const [real, shown] of cases) {
      expect(defangIoc(real, 'url')).toBe(shown)
      expect(refangIoc(shown)).toBe(real)
    }
    // Judged on the value, so a row re-typed as an IP is still broken.
    expect(defangIoc('javascript:alert(1)', 'ip')).toBe('javascript[:]alert(1)')
  })

  it('judges a row typed as a hash on its value too', () => {
    // The type select and hand-edited frontmatter can put any value on a hash row.
    expect(defangIoc('javascript:alert(1)', 'hash')).toBe('javascript[:]alert(1)')
    expect(defangIoc('http://evil.example.com/x', 'hash')).toBe('hxxp://evil[.]example[.]com/x')
    expect(defangIoc('\\\\attacker\\s', 'hash')).toBe('[\\\\]attacker\\s')
    // A real hash has nothing to neutralise.
    for (const h of [
      'd41d8cd98f00b204e9800998ecf8427e',
      'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
      '96:s4Ud1Lj96tHHlZDrwciQmA+4uy1I0G4HYuL8N3TzS8QsO:e4Uk2HHlZDrwciQmA+4uy1I0G4HYuL8N3TzS8Q',
      'T1F0E0D0C0B0A09080706050403020100F0E0D0C0B0A09080706050403020100F0E0D0C0B0A0'
    ]) {
      expect(defangIoc(h, 'hash')).toBe(h)
    }
  })

  it('breaks an ftp colon, since a dotless ftp host has no dot to break', () => {
    expect(defangIoc('ftp://files/x', 'url')).toBe('ftp[:]//files/x')
    expect(defangIoc('ftp://3232235521/x', 'url')).toBe('ftp[:]//3232235521/x')
    expect(refangIoc(defangIoc('ftp://files/x', 'url'))).toBe('ftp://files/x')
  })

  it('sees the scheme past a control byte or a tab, as the URL parser does', () => {
    // A Safe Links wrapper around %01javascript%3A unwraps to this, and the
    // browser still runs it as javascript:.
    expect(defangIoc('\u0001javascript:alert(document.domain)', 'url')).toBe(
      '\u0001javascript[:]alert(document[.]domain)'
    )
    expect(defangIoc('\u000edata:text/html,<script>x</script>', 'url')).toBe(
      '\u000edata[:]text/html,<script>x</script>'
    )
    expect(defangIoc('\u0001http://intranet/login', 'url')).toBe('\u0001hxxp://intranet/login')
    expect(defangIoc('java\tscript:alert(1)', 'url')).toBe('java\tscript[:]alert(1)')
    expect(defangIoc('\u0001\\\\attacker\\s', 'url')).toBe('\u0001[\\\\]attacker\\s')
    // Not every colon is a scheme.
    expect(defangIoc('fe80::1', 'url')).toBe('fe80::1')
    expect(defangIoc('evil.com:8080', 'domain')).toBe('evil[.]com:8080')
  })

  it('brackets a UNC prefix, so a dotless host is not left live', () => {
    // \\fileserver\share has no dot to break, and opening it sends the
    // analyst's NTLM hash to whoever answers.
    expect(defangIoc('\\\\fileserver\\share', 'url')).toBe('[\\\\]fileserver\\share')
    expect(defangIoc('\\\\attacker\\share\\t.dotm', 'url')).toBe('[\\\\]attacker\\share\\t[.]dotm')
    expect(refangIoc(defangIoc('\\\\attacker\\share\\t.dotm', 'url'))).toBe('\\\\attacker\\share\\t.dotm')
  })
})

describe('visibleName — an attacker-written name cannot rewrite the line it is printed in', () => {
  it('turns bidi, zero-width, line-breaking and control characters into visible escapes', () => {
    expect(visibleName('word/x\u202Eexe.xml')).toBe('word/x<U+202E>exe.xml')
    expect(visibleName('a.xml\n1,024 bytes\tDeflate')).toBe('a.xml<U+000A>1,024 bytes<U+0009>Deflate')
    expect(visibleName('\u0000\u007F\u0085\u061C\u200B\u200F\u2028\u2029\u2066\u2069\uFEFF')).toBe(
      '<U+0000><U+007F><U+0085><U+061C><U+200B><U+200F><U+2028><U+2029><U+2066><U+2069><U+FEFF>'
    )
    // A tag character is invisible too, and outside the BMP.
    expect(visibleName('x\u{E0041}')).toBe('x<U+E0041>')
  })

  it('leaves ordinary names, in any script, exactly as written', () => {
    expect(visibleName('word/media/image1.png')).toBe('word/media/image1.png')
    expect(visibleName('счёт 2026 — 請求書.pdf')).toBe('счёт 2026 — 請求書.pdf')
  })
})

describe('refangIoc', () => {
  it('undoes the standard defang forms', () => {
    expect(refangIoc('hxxp://evil[.]example[.]com/payload')).toBe('http://evil.example.com/payload')
    expect(refangIoc('hxxps://evil[.]com')).toBe('https://evil.com')
    expect(refangIoc('192[.]168(.)1[.]50')).toBe('192.168.1.50')
    expect(refangIoc('bad[at]evil[.]com')).toBe('bad@evil.com')
    expect(refangIoc('bad(at)evil(.)com')).toBe('bad@evil.com')
    expect(refangIoc('bad[@]evil[.]com')).toBe('bad@evil.com')
    expect(refangIoc('hxxp[:]//x[.]io')).toBe('http://x.io')
  })

  it('is idempotent on already-real values', () => {
    expect(refangIoc('http://evil.example.com')).toBe('http://evil.example.com')
    expect(refangIoc('d41d8cd98f00b204e9800998ecf8427e')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('round-trips defangIoc output', () => {
    expect(refangIoc(defangIoc('http://evil.example.com/a', 'url'))).toBe('http://evil.example.com/a')
    expect(refangIoc(defangIoc('bad@evil.com', 'email'))).toBe('bad@evil.com')
    expect(refangIoc(defangIoc('10.0.0.1', 'ip'))).toBe('10.0.0.1')
  })
})

describe('detectIocType', () => {
  it('classifies hashes by hex length', () => {
    expect(detectIocType('d41d8cd98f00b204e9800998ecf8427e')).toBe('hash')
    expect(detectIocType('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe('hash')
    expect(detectIocType('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe('hash')
  })

  it('classifies urls, ips, emails, domains', () => {
    expect(detectIocType('https://evil.example.com/x')).toBe('url')
    expect(detectIocType('192.168.1.50')).toBe('ip')
    expect(detectIocType('2001:db8::1')).toBe('ip')
    expect(detectIocType('bad@evil.com')).toBe('email')
    expect(detectIocType('evil.example.com')).toBe('domain')
  })
})

describe('parseIocPaste', () => {
  it('splits, refangs, and classifies a messy report paste (defanged urls, hashes, blank lines)', () => {
    const text = [
      'hxxp://evil[.]example[.]com/payload, 192[.]168(.)1[.]50',
      '',
      '  d41d8cd98f00b204e9800998ecf8427e',
      'bad[at]evil[.]com evil[.]example[.]com'
    ].join('\n')
    expect(parseIocPaste(text, [])).toEqual([
      { type: 'url', value: 'http://evil.example.com/payload' },
      { type: 'ip', value: '192.168.1.50' },
      { type: 'hash', value: 'd41d8cd98f00b204e9800998ecf8427e' },
      { type: 'email', value: 'bad@evil.com' },
      { type: 'domain', value: 'evil.example.com' }
    ])
  })

  it('skips values already on the task, case-insensitively, even when stored defanged', () => {
    const existing = ['http://evil.example.com/payload', 'D41d8cd98f00b204e9800998ecf8427e', '192[.]168[.]1[.]50']
    const text = 'hxxp://evil[.]example[.]com/payload d41d8cd98f00b204e9800998ecf8427e 192.168.1.50 new-evil.com'
    expect(parseIocPaste(text, existing)).toEqual([{ type: 'domain', value: 'new-evil.com' }])
  })

  it('dedups repeats within one paste', () => {
    expect(parseIocPaste('10.0.0.1 10[.]0[.]0[.]1, 10.0.0.1', [])).toEqual([{ type: 'ip', value: '10.0.0.1' }])
  })

  it('returns nothing for blank or separator-only input', () => {
    expect(parseIocPaste('', [])).toEqual([])
    expect(parseIocPaste('  \n\n , ,\t', [])).toEqual([])
  })

  it('refangs [dot], (dot) and [://], the forms CyberChef and vendor reports use', () => {
    expect(parseIocPaste('evil[dot]com hxxps[://]evil[.]com', [])).toEqual([
      { type: 'domain', value: 'evil.com' },
      { type: 'url', value: 'https://evil.com' }
    ])
    expect(parseIocPaste('EVIL(DOT)COM', [])).toEqual([{ type: 'domain', value: 'EVIL.COM' }])
    expect(refangIoc('john(dot)smith(at)corp(dot)com')).toBe('john.smith@corp.com')
    // Only between label characters: a real path keeps its value.
    expect(parseIocPaste('https://en.wikipedia.org/wiki/Foo_(dot)', [])).toEqual([
      { type: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(dot)' }
    ])
  })
})

describe('formatIocLine', () => {
  it('formats type: defangedValue, appending the note only when present', () => {
    expect(formatIocLine({ type: 'ip', value: '203.0.113.1' }, [])).toBe('ip: 203[.]0[.]113[.]1')
    expect(formatIocLine({ type: 'url', value: 'http://evil.example.com/a', note: 'beacon callback' }, [])).toBe(
      'url: hxxp://evil[.]example[.]com/a — beacon callback'
    )
    expect(formatIocLine({ type: 'hash', value: 'd41d8cd98f00b204e9800998ecf8427e' }, [])).toBe(
      'hash: d41d8cd98f00b204e9800998ecf8427e'
    )
  })

  it('marks an own asset wherever an indicator leaves the plugin', () => {
    // A private range needs no configuration; a listed domain comes from settings.
    expect(formatIocLine({ type: 'ip', value: '10.0.0.1' }, [])).toBe('ip: 10[.]0[.]0[.]1 (own asset)')
    expect(formatIocLine({ type: 'domain', value: 'mail.corp.example' }, ['corp.example'])).toBe(
      'domain: mail[.]corp[.]example (own asset)'
    )
    expect(formatIocLine({ type: 'domain', value: 'evilcorp.example' }, ['corp.example'])).toBe(
      'domain: evilcorp[.]example'
    )
  })
})

describe('extractIocsFromText', () => {
  const note = [
    'Rule: SOC166 - Javascript Code Detected in Requested URL',
    'Hostname: WebServer1002',
    'Destination IP Address: 172.16.17.17',
    'Source IP Address: 112.85.42.13',
    'Requested URL: https://172.16.17.17/search/?q=<$script>javascript:$alert(1)</script>',
    'Traffic was observed from 112[.]85[.]42[.]13 and reported multiple times.',
    'Payload hash: d41d8cd98f00b204e9800998ecf8427e.',
    'C2 host evil-cdn[.]top, sender phish[at]bad-mail[.]ru, and see letsdefend.io docs.'
  ].join('\n')

  it('pulls typed indicators out of alert prose, defanged or real, in order', () => {
    const got = extractIocsFromText(note, [])
    const values = got.map((i) => i.value)
    expect(values).toContain('172.16.17.17')
    expect(values).toContain('112.85.42.13')
    expect(values.some((v) => v.startsWith('https://172.16.17.17/search/'))).toBe(true)
    expect(values).toContain('d41d8cd98f00b204e9800998ecf8427e')
    expect(values).toContain('evil-cdn.top')
    expect(values).toContain('phish@bad-mail.ru')
    expect(values).toContain('letsdefend.io')
    const types = Object.fromEntries(got.map((i) => [i.value, i.type]))
    expect(types['112.85.42.13']).toBe('ip')
    expect(types['d41d8cd98f00b204e9800998ecf8427e']).toBe('hash')
    expect(types['evil-cdn.top']).toBe('domain')
    expect(types['phish@bad-mail.ru']).toBe('email')
  })

  it('dedups against existing rows and within the note (defanged == real)', () => {
    const got = extractIocsFromText(note, ['112.85.42.13'])
    expect(got.filter((i) => i.value === '112.85.42.13')).toHaveLength(0)
    const all = extractIocsFromText(note, [])
    expect(all.filter((i) => i.value === '112.85.42.13')).toHaveLength(1)
  })

  it('does not turn ordinary prose into indicators', () => {
    const got = extractIocsFromText('Reviewed app.js and config.yaml; verdict recorded. Version 300.1.2.3 invalid.', [])
    expect(got).toEqual([])
  })

  it('rejects impossible IPs and trims trailing punctuation', () => {
    expect(extractIocsFromText('bad ip 999.1.1.1 here', []).filter((i) => i.type === 'ip')).toEqual([])
    expect(extractIocsFromText('contact evil[.]com.', []).map((i) => i.value)).toEqual(['evil.com'])
  })
  it('ends a URL at a brace, a backslash or a control character', () => {
    // Without the stop, an RTF template ran on into the control words after it
    // and NUL padding became part of the value: URLs that exist nowhere.
    const urls = (text: string) =>
      extractIocsFromText(text, [])
        .filter((i) => i.type === 'url')
        .map((i) => i.value)
    const rtf = '{\\*\\template http://evil.example/t.dotm}{\\object\\objemb{\\*\\objclass Equation.3}}'
    expect(urls(rtf)).toEqual(['http://evil.example/t.dotm'])
    expect(urls('https://evil.example/a\\b')).toEqual(['https://evil.example/a'])
    expect(urls('see https://evil.example/a\u0000\u0000\u0000tail')).toEqual(['https://evil.example/a'])
  })

  it('ends a URL at a closing typographic quote and at U+FFFD', () => {
    const urls = (text: string) =>
      extractIocsFromText(text, [])
        .filter((i) => i.type === 'url')
        .map((i) => i.value)
    // Word and Outlook autocorrect quotes; a block-list entry ending in ” matches nothing.
    expect(urls('Please sign in at “https://login.evil-portal.com/verify” today.')).toEqual([
      'https://login.evil-portal.com/verify'
    ])
    expect(urls('«https://a.evil.test/x»')).toEqual(['https://a.evil.test/x'])
    expect(urls('‘https://b.evil.test/y’.')).toEqual(['https://b.evil.test/y'])
    // FF FE after a link in a binary decodes to two replacement characters.
    expect(urls('garbage http://evil.example.com/stage\uFFFD\uFFFDAB')).toEqual(['http://evil.example.com/stage'])
  })

  it('keeps two URLs that differ only in case, since a path is case-sensitive', () => {
    const values = extractIocsFromText('https://bit.ly/3XkQ and later https://bit.ly/3xKq', []).map((i) => i.value)
    expect(values).toContain('https://bit.ly/3XkQ')
    expect(values).toContain('https://bit.ly/3xKq')
    // Hashes and hosts still fold case, against the case and within the scan.
    expect(extractIocsFromText('D41D8CD98F00B204E9800998ECF8427E', ['d41d8cd98f00b204e9800998ecf8427e'])).toEqual([])
    expect(extractIocsFromText('EVIL.com and evil.COM', []).map((i) => i.value)).toEqual(['EVIL.com'])
  })

  it('reads the [dot], (dot) and [://] defang forms', () => {
    const got = extractIocsFromText('see evil[dot]com and hxxps[://]bad[.]net/x, phish[at]bad[dot]ru', []).map(
      (i) => i.value
    )
    expect(got).toContain('evil.com')
    expect(got).toContain('https://bad.net/x')
    expect(got).toContain('phish@bad.ru')
    // A (.) or (dot) inside a URL is part of the host, not the end of the URL:
    // the value used to be the fragment 'https://x(' that exists nowhere.
    const urls = extractIocsFromText('hxxps://x[dot]net/a hxxps://y(dot)org/b hxxps://z(.)io/c', [])
      .filter((i) => i.type === 'url')
      .map((i) => i.value)
    expect(urls).toEqual(['https://x.net/a', 'https://y.org/b', 'https://z.io/c'])
  })
})

describe('extractIocsFromText — hostile text cannot freeze the scan', () => {
  // Each of these took seconds to minutes: an unanchored `\b[\w-]+` restarted
  // at every hyphen or dot of a run and rescanned to its end. Bounds are loose
  // so a loaded machine does not flake; the fixed scan takes tens of ms.
  const MB = 1024 * 1024
  const base64url = 'QmFzZTY0-dXJs_YWxwaGFiZXQ-'
  const shapes: [string, string][] = [
    ["'a-' × 80,000", 'a-'.repeat(80_000)],
    ['2 MB of a-', 'a-'.repeat(MB)],
    ['2 MB of a.', 'a.'.repeat(MB)],
    ['2 MB of base64url', base64url.repeat(Math.ceil((2 * MB) / base64url.length))],
    ['a URL, 1 MB of dots, a letter', `https://x.example.com/${'.'.repeat(MB)}a`]
  ]
  for (const [name, text] of shapes) {
    it(`scans ${name} in linear time`, () => {
      const start = performance.now()
      extractIocsFromText(text, [])
      expect(performance.now() - start).toBeLessThan(1500)
    })
  }

  it('still lists an over-long token whole, never a tail of it', () => {
    // Bounding the repetitions instead would have listed a 63-character suffix
    // that appears nowhere in the text as a host.
    const host = `${'x-'.repeat(40)}y.com`
    expect(extractIocsFromText(host, []).map((i) => i.value)).toEqual([host])
    expect(extractIocsFromText(`--${host}`, []).map((i) => i.value)).toEqual([host])
  })

  it('does not list an address glued to the one before it as an email (documented)', () => {
    const got = extractIocsFromText('a@b.com+x@c.com', [])
    expect(got.filter((i) => i.type === 'email').map((i) => i.value)).toEqual(['a@b.com'])
    // Its domain is still listed.
    expect(got.map((i) => i.value)).toContain('c.com')
  })
})

describe('vtWaitMs', () => {
  it('first VirusTotal call is immediate', () => {
    expect(vtWaitMs([], 123_456)).toBe(0)
  })

  it('waits the remainder of the pace window since the last VT start', () => {
    expect(vtWaitMs([10_000], 10_000)).toBe(VT_PACE_MS)
    expect(vtWaitMs([10_000], 20_000)).toBe(VT_PACE_MS - 10_000)
    expect(vtWaitMs([10_000], 10_000 + VT_PACE_MS)).toBe(0)
    expect(vtWaitMs([10_000], 100_000)).toBe(0)
  })

  it('paces from the most recent of several prior starts', () => {
    expect(vtWaitMs([1_000, 20_000, 10_000], 21_000)).toBe(VT_PACE_MS - 1_000)
  })
})

describe('iocSightings', () => {
  const caseWith = (id: string, key: string, iocs: Ioc[], subtasks = []) =>
    makeTask({ id, key, title: `Case ${key}`, iocs, subtasks })

  const tasks = [
    caseWith('t1', 'SOC282', [{ type: 'ip', value: '112.85.42.13' }]),
    caseWith('t2', 'SOC281', [{ type: 'domain', value: 'EVIL.example.com' }]),
    makeTask({
      id: 'parent',
      key: 'SOC280',
      title: 'Parent',
      iocs: [],
      subtasks: [caseWith('t3', 'SOC283', [{ type: 'ip', value: '112[.]85[.]42[.]13' }])]
    }),
    caseWith('t4', 'SOC284', [])
  ]

  it('matches across defanged and real forms, flattening subtasks', () => {
    const hits = iocSightings('112[.]85[.]42[.]13', tasks, '', [])
    expect(hits.map((h) => h.key)).toEqual(['SOC282', 'SOC283'])
    expect(hits[0]).toEqual({ taskId: 't1', key: 'SOC282', title: 'Case SOC282' })
    // real query form finds the defanged stored value too
    expect(iocSightings('112.85.42.13', tasks, '', []).map((h) => h.taskId)).toEqual(['t1', 't3'])
  })

  it('compares case-insensitively', () => {
    expect(iocSightings('evil.EXAMPLE.com', tasks, '', []).map((h) => h.key)).toEqual(['SOC281'])
  })

  it('excludes the asking case itself', () => {
    expect(iocSightings('112.85.42.13', tasks, 't1', []).map((h) => h.taskId)).toEqual(['t3'])
  })

  it('returns nothing on no match or a blank value', () => {
    expect(iocSightings('203.0.113.9', tasks, '', [])).toEqual([])
    expect(iocSightings('   ', tasks, '', [])).toEqual([])
  })
})

describe('sightingsIndex — one board walk per render, not one per row', () => {
  // The per-row walk iocSightings used to do, kept here as the reference.
  const walk = (value: string, board: Task[], exclude: string, owned: string[]) => {
    const needle = refangIoc(value).toLowerCase()
    if (!needle || assetRule(needle, owned)) return []
    return flattenTasks(board)
      .map(({ task }) => task)
      .filter((t) => t.id !== exclude && t.iocs.some((i) => refangIoc(i.value).toLowerCase() === needle))
      .map((t) => ({ taskId: t.id, key: t.key, title: t.title }))
  }

  it('answers exactly what the per-row walk answered', () => {
    const board = [
      makeTask({ id: 'a', key: 'SOC1', title: 'A', iocs: [{ type: 'ip', value: '203.0.113.9' }] }),
      makeTask({
        id: 'b',
        key: 'SOC2',
        title: 'B',
        // Held twice, once defanged: still one sighting.
        iocs: [
          { type: 'ip', value: '203[.]0[.]113[.]9' },
          { type: 'ip', value: '203.0.113.9' },
          { type: 'domain', value: 'Mail.Corp.Example' }
        ],
        subtasks: [makeTask({ id: 'c', key: 'SOC3', title: 'C', iocs: [{ type: 'domain', value: 'EVIL.test' }] })]
      }),
      makeTask({ id: 'd', key: 'SOC4', title: 'D', iocs: [{ type: 'domain', value: 'evil[.]test' }] })
    ]
    const owned = ['corp.example']
    for (const exclude of ['', 'a', 'c']) {
      const lookup = sightingsIndex(board, exclude, owned)
      for (const v of [
        '203.0.113.9',
        '203[.]0[.]113[.]9',
        'evil.TEST',
        'mail.corp.example',
        '10.0.0.1',
        '',
        'x.test'
      ]) {
        expect(lookup(v)).toEqual(walk(v, board, exclude, owned))
      }
    }
    // The asset is on the board, and is still never a sighting.
    expect(sightingsIndex(board, '', owned)('mail.corp.example')).toEqual([])
  })

  it('looks up 5,000 rows against a 5,000-indicator board in well under a render', () => {
    const board = Array.from({ length: 50 }, (_, c) =>
      makeTask({
        id: `t${c}`,
        key: `SOC${c}`,
        title: `Case ${c}`,
        iocs: Array.from({ length: 100 }, (_, i) => ({
          type: 'domain' as const,
          value: `h${c * 100 + i}[.]evil[.]test`
        }))
      })
    )
    const rows = Array.from({ length: 5000 }, (_, i) => `h${i * 3}.evil.test`)
    const start = performance.now()
    const lookup = sightingsIndex(board, 't0', [])
    const hits = rows.filter((v) => lookup(v).length > 0).length
    expect(performance.now() - start).toBeLessThan(200)
    expect(hits).toBeGreaterThan(0)
  })
})

describe('activityValue — an activity row never prints a live indicator', () => {
  it('defangs indicator values and leaves every other field as recorded', () => {
    expect(activityValue('iocs', 'http://evil.example/login')).toBe('hxxp://evil[.]example/login')
    expect(activityValue('iocs', 'bad@evil.example')).toBe('bad[at]evil[.]example')
    expect(activityValue('iocs', '')).toBe('')
    expect(activityValue('title', 'http://evil.example/login')).toBe('http://evil.example/login')
  })
})

describe('iocKey — the one dedupe key', () => {
  it('folds case everywhere except a URL, whose path is case-sensitive', () => {
    expect(iocKey({ type: 'url', value: 'https://bit.ly/3XkQ' })).not.toBe(
      iocKey({ type: 'url', value: 'https://bit.ly/3xKq' })
    )
    expect(iocKey({ type: 'hash', value: 'D41D8CD98F00B204E9800998ECF8427E' })).toBe(
      iocKey({ type: 'hash', value: 'd41d8cd98f00b204e9800998ecf8427e' })
    )
    expect(iocKey({ type: 'domain', value: 'EVIL.test' })).toBe(iocKey({ type: 'domain', value: 'evil.test' }))
    expect(iocKey({ type: 'domain', value: 'evil.test' })).not.toBe(iocKey({ type: 'email', value: 'evil.test' }))
  })
})

describe('stripProseTail', () => {
  it('drops the sentence punctuation after an indicator, ASCII or typographic', () => {
    expect(stripProseTail('https://x.test/verify”.')).toBe('https://x.test/verify')
    expect(stripProseTail('https://x.test/a»')).toBe('https://x.test/a')
    expect(stripProseTail('evil.test);')).toBe('evil.test')
    expect(stripProseTail('https://x.test/a')).toBe('https://x.test/a')
    expect(stripProseTail('.,;')).toBe('')
  })

  it('takes linear time on a long punctuation run', () => {
    const s = `https://x.test/${'.'.repeat(1_000_000)}a`
    const start = performance.now()
    expect(stripProseTail(s)).toBe(s)
    expect(stripProseTail(`${s}${'.'.repeat(1_000_000)}`)).toBe(s)
    expect(performance.now() - start).toBeLessThan(1500)
  })
})

describe('assetRule — the boundary that decides what is never sent', () => {
  it('covers private, loopback and link-local without any configuration', () => {
    for (const v of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1']) {
      expect(assetRule(v, [])?.builtIn).toBe(true)
    }
    // Public addresses are not ours just because nobody listed them.
    expect(assetRule('203.0.113.10', [])).toBeNull()
    expect(assetRule('8.8.8.8', [])).toBeNull()
  })

  it('attributes a listed rule to the analyst and a built-in range to Responder', () => {
    expect(assetRule('mail.corp.example', ['corp.example'])).toEqual({ rule: 'corp.example', builtIn: false })
    expect(assetRule('10.0.0.1', ['corp.example'])?.builtIn).toBe(true)
  })

  it('matches on a label boundary, so a lookalike domain is not ours', () => {
    expect(assetRule('corp.example', ['corp.example'])).not.toBeNull()
    expect(assetRule('mail.corp.example', ['*.corp.example'])).not.toBeNull()
    expect(assetRule('evilcorp.example', ['corp.example'])).toBeNull()
    expect(assetRule('corp.example.attacker.test', ['corp.example'])).toBeNull()
  })

  it('never lets a domain rule suffix-match an IP literal', () => {
    // The half-typed entry "10" used to own 203.0.113.10 through endsWith.
    expect(assetRule('203.0.113.10', ['10'])).toBeNull()
    expect(assetRule('203.0.113.10', ['198.51.100'])).toBeNull()
  })

  it('reads a CIDR by arithmetic, and refuses one it cannot parse', () => {
    expect(assetRule('198.51.100.7', ['198.51.100.0/24'])).not.toBeNull()
    expect(assetRule('198.51.101.7', ['198.51.100.0/24'])).toBeNull()
    // '10.0.0.0/' must not mask nothing and swallow every address.
    expect(assetRule('203.0.113.10', ['10.0.0.0/'])).toBeNull()
    expect(assetRule('203.0.113.10', ['10.0.0.0/33'])).toBeNull()
  })

  it('judges a URL by its host, even one the URL parser rejects', () => {
    expect(assetRule('https://mail.corp.example/login', ['corp.example'])).not.toBeNull()
    expect(assetRule('http://10.0.0.5:99999/a', [])?.builtIn).toBe(true)
    expect(assetRule('user@corp.example', ['corp.example'])).not.toBeNull()
  })

  it('treats every spelling of one IPv6 address as that address', () => {
    expect(assetRule('::1', [])?.rule).toBe('IPv6 loopback ::1')
    expect(assetRule('0:0:0:0:0:0:0:1', [])?.rule).toBe('IPv6 loopback ::1')
    expect(assetRule('fe80::1', [])?.rule).toContain('link-local')
    expect(assetRule('fc00::1', [])?.rule).toContain('unique-local')
    // An IPv4-mapped internal address is judged on the IPv4 side.
    expect(assetRule('::ffff:10.0.0.5', [])?.rule).toBe('10.0.0.0/8')
    expect(assetRule('2001:0db8:0:0:0:0:0:5', ['2001:db8::5'])).not.toBeNull()
    // Not every colon is an address: a clock and a MAC must not match.
    expect(assetRule('12:34:56', [])).toBeNull()
    expect(assetRule('08:00:27:12:34:56', [])).toBeNull()
  })

  it('names every listed entry it cannot match, so nothing reads as cover', () => {
    expect(
      unmatchableAssetRules([
        '*.corp.example',
        '2001:db8::/32',
        '10.0.0.0/8',
        '#internal',
        'corp.example/8',
        '198.51.100.0-198.51.100.255',
        'corp.example',
        '10.0.0.0/33'
      ])
    ).toEqual(['2001:db8::/32', '#internal', 'corp.example/8', '198.51.100.0-198.51.100.255', '10.0.0.0/33'])
  })
})

describe('hasIocShape — the paste gate', () => {
  it('keeps the shapes an analyst actually pastes', () => {
    for (const v of [
      'evil.com/payload.exe',
      'evil[.]com/payload.exe',
      'coffeeshooop.com/inv.php?id=2',
      '1.2.3.4:8080',
      'victim.gov.ie',
      'evil.com.',
      '::ffff:10.0.0.5',
      'd41d8cd98f00b204e9800998ecf8427e'
    ]) {
      expect(hasIocShape(v)).toBe(true)
    }
  })

  it('drops the alert labels that used to become domain rows (SD-06)', () => {
    for (const v of ['SHA256:', 'Sender', 'Host', '2026-09-20', '12:34:56', '08:00:27:12:34:56', 'v1.2.3']) {
      expect(hasIocShape(v)).toBe(false)
    }
    // An impossible octet is not an address, and odd-length hex is not a hash.
    expect(hasIocShape('300.1.2.3')).toBe(false)
    expect(hasIocShape('d41d8cd98f00b204e9800998ecf8427')).toBe(false)
  })
})

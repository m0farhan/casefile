import { describe, expect, it } from 'vitest'
import {
  VT_PACE_MS,
  defangIoc,
  detectIocType,
  extractIocsFromText,
  formatIocLine,
  iocSightings,
  parseIocPaste,
  refangIoc,
  vtWaitMs
} from './ioc'
import { makeTask, type Ioc } from '../types'

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
})

describe('formatIocLine', () => {
  it('formats type: defangedValue, appending the note only when present', () => {
    expect(formatIocLine({ type: 'ip', value: '10.0.0.1' })).toBe('ip: 10[.]0[.]0[.]1')
    expect(formatIocLine({ type: 'url', value: 'http://evil.example.com/a', note: 'beacon callback' })).toBe(
      'url: hxxp://evil[.]example[.]com/a — beacon callback'
    )
    expect(formatIocLine({ type: 'hash', value: 'd41d8cd98f00b204e9800998ecf8427e' })).toBe(
      'hash: d41d8cd98f00b204e9800998ecf8427e'
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
    const hits = iocSightings('112[.]85[.]42[.]13', tasks, '')
    expect(hits.map((h) => h.key)).toEqual(['SOC282', 'SOC283'])
    expect(hits[0]).toEqual({ taskId: 't1', key: 'SOC282', title: 'Case SOC282' })
    // real query form finds the defanged stored value too
    expect(iocSightings('112.85.42.13', tasks, '').map((h) => h.taskId)).toEqual(['t1', 't3'])
  })

  it('compares case-insensitively', () => {
    expect(iocSightings('evil.EXAMPLE.com', tasks, '').map((h) => h.key)).toEqual(['SOC281'])
  })

  it('excludes the asking case itself', () => {
    expect(iocSightings('112.85.42.13', tasks, 't1').map((h) => h.taskId)).toEqual(['t3'])
  })

  it('returns nothing on no match or a blank value', () => {
    expect(iocSightings('10.9.9.9', tasks, '')).toEqual([])
    expect(iocSightings('   ', tasks, '')).toEqual([])
  })
})

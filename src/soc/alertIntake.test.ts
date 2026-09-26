import { describe, expect, it } from 'vitest'
import { parseAlertPaste } from './alertIntake'
import { assetRule } from './ioc'
import type { SeverityConfig } from '../types'

const SEVERITIES: SeverityConfig[] = [
  { id: 'sev1', label: 'Critical', color: '', icon: '' },
  { id: 'sev2', label: 'High', color: '', icon: '' },
  { id: 'sev3', label: 'Medium', color: '', icon: '' },
  { id: 'sev4', label: 'Low', color: '', icon: '' }
]
const CFG = { severities: SEVERITIES }

// The real LetsDefend SOC282 shape (typed from the monitoring screenshots).
const SOC282 = [
  'EventID : 257',
  'Event Time : 2024-05-13T09:22:00+03:00',
  'Rule : SOC282 - Phishing Alert - Deceptive Mail Detected',
  'Level : Security Analyst',
  'Severity : Medium',
  'SMTP Address : 103.80.134.63',
  'Source Address : ellie@letsdefend.io',
  'Destination Address : mark@letsdefend.io',
  'E-mail Subject : Free coffee voucher',
  'Device Action : Allowed'
].join('\n')

describe('parseAlertPaste', () => {
  it('parses the SOC282 phishing alert shape', () => {
    const result = parseAlertPaste(SOC282, CFG)
    expect(result.title).toBe('SOC282 - Phishing Alert - Deceptive Mail Detected')
    expect(result.severityId).toBe('sev3')
    // SD-03: the alert's own Event Time is when it HAPPENED. It lands on
    // occurredAt; the SLA anchor stays empty because no key named a detection.
    // Same format the lifecycle Now buttons write: Date.toISOString (UTC).
    expect(result.occurredAt).toBe('2024-05-13T06:22:00.000Z')
    expect(result.detectedAt).toBe('')
    expect(result.description).toBe(SOC282)
    const values = result.iocs.map((i) => i.value)
    expect(values).toContain('103.80.134.63')
    expect(values).toContain('ellie@letsdefend.io')
    expect(values).toContain('mark@letsdefend.io')
    expect(result.iocs.find((i) => i.value === '103.80.134.63')?.type).toBe('ip')
  })

  it('maps severity labels case-insensitively and leaves unknown labels empty', () => {
    expect(parseAlertPaste('Severity : critical', CFG).severityId).toBe('sev1')
    expect(parseAlertPaste('severity : HIGH', CFG).severityId).toBe('sev2')
    expect(parseAlertPaste('Severity : Catastrophic', CFG).severityId).toBe('')
    expect(parseAlertPaste('Rule : X', CFG).severityId).toBe('')
  })

  it('accepts Date.parse-able time forms on the alternate event-time keys', () => {
    expect(parseAlertPaste('Date : Mon, 13 May 2024 06:22:00 GMT', CFG).occurredAt).toBe('2024-05-13T06:22:00.000Z')
    expect(parseAlertPaste('Time : 2024-01-02T03:04:05Z', CFG).occurredAt).toBe('2024-01-02T03:04:05.000Z')
  })

  it('leaves occurredAt empty when the time line is unparseable or absent', () => {
    expect(parseAlertPaste('Event Time : around lunchtime', CFG).occurredAt).toBe('')
    expect(parseAlertPaste('Rule : X', CFG).occurredAt).toBe('')
  })

  it('fills the SLA anchor only from a key that names the detection', () => {
    expect(parseAlertPaste('Alert Time : 2024-05-13T06:22:00Z', CFG).detectedAt).toBe('2024-05-13T06:22:00.000Z')
    expect(parseAlertPaste('Detection Time : 2024-05-13T06:22:00Z', CFG).detectedAt).toBe('2024-05-13T06:22:00.000Z')
    // An event time is never copied across: one named time fills one field.
    expect(parseAlertPaste('Event Time : 2024-05-13T06:22:00Z', CFG).detectedAt).toBe('')
    expect(parseAlertPaste('Alert Time : 2024-05-13T06:22:00Z', CFG).occurredAt).toBe('')
  })

  it('refuses a count as a timestamp, so a bare number cannot anchor the SLA', () => {
    // Date.parse('3') is 2001-03-01 and Date.parse('257') is year 257 — V8's
    // legacy fallback. An EDR's `Detected : 3` must not fabricate a stamp.
    expect(parseAlertPaste('Detected : 3', CFG).detectedAt).toBe('')
    expect(parseAlertPaste('Detected : 257', CFG).detectedAt).toBe('')
    expect(parseAlertPaste('Time : 2024', CFG).occurredAt).toBe('')
    expect(parseAlertPaste('Detected : 2024-05-13T06:22:00Z', CFG).detectedAt).toBe('2024-05-13T06:22:00.000Z')
  })

  it('skips a key with nothing after its colon, trailing space or not', () => {
    // `Rule : ` used to record an empty Rule, so the case got an empty title.
    const r = parseAlertPaste('Rule : \nSeverity : High', CFG)
    expect(r.title).toBe('Rule :')
    expect(r.severityId).toBe('sev2')
    expect(parseAlertPaste('Rule :\nSeverity : High', CFG).title).toBe('Rule :')
  })

  it('reads a paste with a long run of whitespace at once, not in seconds', () => {
    // The key/value regex this replaced took 4 s on 3,000 spaces, on every keystroke.
    const paste = ['Rule : SOC138', 'Severity : High', ' '.repeat(3000), '\u00a0'.repeat(3000), 'Time : x'].join('\n')
    const start = performance.now()
    const r = parseAlertPaste(paste, CFG)
    expect(performance.now() - start).toBeLessThan(100)
    expect(r.title).toBe('SOC138')
    expect(r.severityId).toBe('sev2')
  })

  it('splits a line at its first colon only', () => {
    expect(parseAlertPaste('Rule : Detected at 12:00:01 on WS-042', CFG).title).toBe('Detected at 12:00:01 on WS-042')
  })

  it('falls back to the first non-empty line when there is no Rule line', () => {
    const result = parseAlertPaste('\nSuspicious login detected\nUser : bob', CFG)
    expect(result.title).toBe('Suspicious login detected')
  })

  it('caps the title at the task filename limit (60 chars)', () => {
    const result = parseAlertPaste('A'.repeat(80), CFG)
    expect(result.title).toBe('A'.repeat(60))
    expect(parseAlertPaste(`Rule : ${'B'.repeat(80)}`, CFG).title).toBe('B'.repeat(60))
  })

  it('never cuts an emoji in half at the cap', () => {
    // A lone surrogate is stored on disk as U+FFFD, so the note is never found again.
    expect(parseAlertPaste(`Rule : ${'y'.repeat(59)}\u{1F512} account locked`, CFG).title).toBe('y'.repeat(59))
    expect(parseAlertPaste(`${'z'.repeat(59)}\u{1F512} account locked`, CFG).title).toBe('z'.repeat(59))
    // An emoji that fits whole is kept whole.
    expect(parseAlertPaste(`Rule : ${'y'.repeat(58)}\u{1F512} x`, CFG).title).toBe(`${'y'.repeat(58)}\u{1F512}`)
  })

  it('extracts defanged and real indicators from the whole paste', () => {
    const text = 'C2 at hxxp://evil[.]example[.]com/gate and 45[.]77[.]1[.]9, hash d41d8cd98f00b204e9800998ecf8427e'
    const values = parseAlertPaste(text, CFG).iocs.map((i) => i.value)
    expect(values).toContain('http://evil.example.com/gate')
    expect(values).toContain('45.77.1.9')
    expect(values).toContain('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('returns all-empty fields for an empty paste', () => {
    expect(parseAlertPaste('', CFG)).toEqual({
      title: '',
      severityId: '',
      occurredAt: '',
      detectedAt: '',
      description: '',
      iocs: []
    })
  })
})

describe('parseAlertPaste, markdown-formatted alerts', () => {
  // Every alert in a real vault arrives already formatted, pasted from a
  // console or a ticket. Before the emphasis strip the key came out as `**rule`
  // and the title, the severity and the event time were all lost.
  const BOLD = [
    '## Alert',
    '',
    '**EventID :** `77`',
    '',
    '**Event Time :** `2024-05-13T09:22:00+03:00`',
    '',
    '**Rule :** `SOC138 - Detected Suspicious Xls File`',
    '',
    '**Severity :** `Medium`',
    ''
  ].join('\n')

  it('reads a bolded, backticked alert the way it reads a plain one', () => {
    const r = parseAlertPaste(BOLD, CFG)
    expect(r.title).toBe('SOC138 - Detected Suspicious Xls File')
    expect(r.severityId).toBe('sev3')
    expect(r.occurredAt).toBe('2024-05-13T06:22:00.000Z')
  })

  it('reads the other emphasis shape, where the colon sits outside the bold', () => {
    expect(parseAlertPaste('**Rule** : `SOC167 - LS Command Detected`', CFG).title).toBe('SOC167 - LS Command Detected')
  })

  it('leaves underscores alone, because they live inside real values', () => {
    expect(parseAlertPaste('**Rule :** host_01 beaconing', CFG).title).toBe('host_01 beaconing')
  })

  // The SOC138 alert from a user's case, whose Indicators section was empty.
  const SOC138 = [
    'Event Time : 2021-03-13T20:20:58+03:00',
    'Rule : SOC138 - Detected Suspicious Xls File',
    'Source Address : 172.16.17.56',
    'File Name : ORDER SHEET & SPEC.xlsm',
    'File Hash : 7ccf88c0bbe3b29bf19d877c4596a8d4'
  ]

  it('records the MD5 file hash of the SOC138 alert, pasted plain or as a list', () => {
    for (const paste of [SOC138, SOC138.map((l) => `- ${l}`)]) {
      const iocs = parseAlertPaste(paste.join('\n'), CFG).iocs
      expect(iocs.find((i) => i.value === '7ccf88c0bbe3b29bf19d877c4596a8d4')?.type).toBe('hash')
      // The private source address is recorded too, as one of your own assets,
      // so it is never searched or sent anywhere.
      expect(iocs.map((i) => i.value)).toContain('172.16.17.56')
      expect(assetRule('172.16.17.56', [])?.builtIn).toBe(true)
    }
  })

  it('reads the header of an alert pasted as a list', () => {
    // A `- ` bullet used to stay on the key, so the Rule and the Event Time
    // were missed and the title became the first line, bullet and all.
    const r = parseAlertPaste(SOC138.map((l) => `- ${l}`).join('\n'), CFG)
    expect(r.title).toBe('SOC138 - Detected Suspicious Xls File')
    expect(r.occurredAt).toBe('2021-03-13T17:20:58.000Z')
    expect(parseAlertPaste('+ **Rule :** `SOC138`\n• Severity : High', CFG)).toMatchObject({
      title: 'SOC138',
      severityId: 'sev2'
    })
  })
})

describe('a pasted alert that quotes a message', () => {
  it('fences markup so it cannot load anything, wherever the note is opened', () => {
    const paste = ['Rule : Reported phish', 'Body :', '<img src="https://evil.example/pixel?id=42">'].join('\n')
    const out = parseAlertPaste(paste, CFG).description
    expect(out.startsWith('```')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
    // Verbatim: fencing keeps every byte, it does not sanitise.
    expect(out).toContain('<img src="https://evil.example/pixel?id=42">')
  })

  it('opens a longer fence than any backtick run inside the paste', () => {
    const paste = '<b>x</b>\n```\ncode\n```'
    const out = parseAlertPaste(paste, CFG).description
    expect(out.startsWith('````')).toBe(true)
  })

  it.each([
    ['a markdown image', 'Rule : Reported phish\nBody : ![](https://evil.example/beacon.png?id=42)'],
    ['a reference-style image', 'Rule : Reported phish\n![logo][r]\n\n[r]: https://evil.example/r.png'],
    ['an embed', 'Rule : Reported phish\nBody : ![[Secret note]]'],
    ['a dataviewjs block', 'Rule : Reported phish\n```dataviewjs\ndv.el("b", "x")\n```'],
    ['a tilde fence', 'Rule : Reported phish\n~~~\ncode\n~~~'],
    ['an inline Dataview query', 'Rule : Reported phish\nBody : `$= dv.el("b", "x")`']
  ])('fences a paste holding %s', (_name, paste) => {
    const out = parseAlertPaste(paste, CFG).description
    const fence = out.slice(0, out.indexOf('\n'))
    expect(fence).toMatch(/^`{3,}$/)
    expect(out).toBe(`${fence}\n${paste}\n${fence}`)
  })

  it('fences a code block inside the paste with a longer fence it cannot close', () => {
    const out = parseAlertPaste('Rule : x\n```dataviewjs\ncode\n```', CFG).description
    expect(out.startsWith('````\n')).toBe(true)
    expect(out.endsWith('\n````')).toBe(true)
  })

  it('leaves a dollar sign that is not a Dataview query as prose', () => {
    expect(parseAlertPaste('Rule : Invoice fraud\nCost : $=5', CFG).description).toBe(
      'Rule : Invoice fraud\nCost : $=5'
    )
  })

  it('leaves an ordinary alert as prose, so its emphasis still renders', () => {
    const paste = ['Rule : SOC138 - Detected Suspicious Xls File', 'Severity : Medium'].join('\n')
    const out = parseAlertPaste(paste, CFG).description
    expect(out).toBe(paste)
  })
})

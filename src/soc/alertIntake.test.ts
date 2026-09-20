import { describe, expect, it } from 'vitest'
import { parseAlertPaste } from './alertIntake'
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

  it('falls back to the first non-empty line when there is no Rule line', () => {
    const result = parseAlertPaste('\nSuspicious login detected\nUser : bob', CFG)
    expect(result.title).toBe('Suspicious login detected')
  })

  it('caps the title at the task filename limit (60 chars)', () => {
    const result = parseAlertPaste('A'.repeat(80), CFG)
    expect(result.title).toBe('A'.repeat(60))
    expect(parseAlertPaste(`Rule : ${'B'.repeat(80)}`, CFG).title).toBe('B'.repeat(60))
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

import { describe, expect, it } from 'vitest'
import { defangIoc, detectIocType, formatIocLine, parseIocPaste, refangIoc } from './ioc'

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

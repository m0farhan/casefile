import { describe, expect, it } from 'vitest'
import { markupCensus } from './markup'

const TAIL =
  ' — counted as text in any letter case wherever they appear, not parsed; other spellings and split or encoded ' +
  'forms are not counted'

describe('markupCensus', () => {
  it('names the smuggling chain that sits after a large base64 blob', () => {
    // The layout a smuggling page uses: the payload first, the script after it.
    const page =
      '<html><body><script>var b="' +
      'QUJD'.repeat(50_000) +
      '";var d=atob(b);var u=URL.createObjectURL(new Blob([d]));' +
      'var a=document.createElement("a");a.href=u;a.download="Invoice.zip";a.click();' +
      'window.location="https://login-evil.test/done"</script></body></html>'
    expect(markupCensus(page)).toBe(
      'script and markup names found: <script ×1, atob( ×1, new Blob ×1, createObjectURL ×1, .download ×1, ' +
        `window.location ×1${TAIL}`
    )
  })

  it('says nothing when no name appears', () => {
    expect(markupCensus('')).toBeNull()
    expect(markupCensus('<html><body><p>Your invoice is attached.</p></body></html>')).toBeNull()
  })

  it('ignores letter case and lists in its own order, not the order of appearance', () => {
    expect(markupCensus('<IFRAME src=x></IFRAME><FORM><input TYPE="PASSWORD"></FORM><SCRIPT>')).toBe(
      `script and markup names found: <script ×1, <form ×1, type="password" ×1, <iframe ×1${TAIL}`
    )
  })

  it('counts a name inside another name, because it does appear there', () => {
    // A consuming match would take window.location and never see location.href.
    expect(markupCensus('window.location.href = x; window.location.replace(y)')).toBe(
      `script and markup names found: window.location ×2, location.href ×1, location.replace ×1${TAIL}`
    )
  })

  it('stops counting at 999 and says it is a lower bound', () => {
    expect(markupCensus('eval('.repeat(1500) + 'unescape(')).toBe(
      `script and markup names found: eval( ×999+, unescape( ×1${TAIL}`
    )
  })

  it('does not count the names split or spelled another way', () => {
    // What the line admits it cannot see must really be missed, not half-counted.
    expect(markupCensus('var f = window["at" + "ob"]; \\x61tob(1); type=\'password\'')).toBeNull()
  })

  it('stays linear on hostile text built from near-misses', () => {
    // 16MB of prefixes that almost match; a backtracking pattern would crawl here.
    expect(
      markupCensus('<'.repeat(4_000_000) + 'locatio'.repeat(1_000_000) + 'window.locatio'.repeat(500_000))
    ).toBeNull()
    expect(markupCensus('<scrip'.repeat(1_000_000) + '<script')).toBe(
      `script and markup names found: <script ×1${TAIL}`
    )
  })
})

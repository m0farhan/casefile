import { describe, expect, it } from 'vitest'
import { markupCensus, rtfCensus } from './markup'

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

const RTF_TAIL =
  ' — counted as text wherever they appear, not parsed: control words in lower case as RTF writes them, DDEAUTO ' +
  'in any letter case; other spellings and escaped, split or encoded forms are not counted'

describe('rtfCensus', () => {
  it('names the embedded object that sits past the preview, and the class the file declares', () => {
    // The Equation Editor lure's layout: padding first, so the preview's first
    // 20,000 characters show only padding, then the object.
    const rtf =
      '{\\rtf1\\ansi ' +
      'Please see the attached remittance. '.repeat(800) +
      '{\\object\\objemb\\objupdate{\\*\\objclass Equation.3}{\\*\\objdata 0105000002000000' +
      '0'.repeat(4000) +
      '}}}'
    expect(rtf.indexOf('\\object')).toBeGreaterThan(20_000)
    expect(rtfCensus(rtf)).toBe(
      `RTF object and DDEAUTO markers found: \\object ×1, \\objdata ×1, \\objupdate ×1, \\objemb ×1; the first ` +
        `\\objclass reads Equation.3${RTF_TAIL}`
    )
  })

  it('says nothing about RTF with none of the markers', () => {
    expect(rtfCensus('')).toBeNull()
    expect(rtfCensus('{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\\pard Invoice attached.\\par}')).toBeNull()
  })

  it('counts a control word only as RTF spells it, delimited and in lower case', () => {
    // \objdataxyz is another word to an RTF reader, and \OBJDATA is not RTF.
    expect(rtfCensus('{\\objdataxyz 01}{\\OBJDATA 01}{\\ObjData 01}{\\objectX}')).toBeNull()
    expect(rtfCensus('{\\objdata01}{\\objlink\\objautlink}')).toBe(
      `RTF object and DDEAUTO markers found: \\objdata ×1, \\objlink ×1, \\objautlink ×1${RTF_TAIL}`
    )
  })

  it('counts DDEAUTO in field text, in any letter case', () => {
    // DDE is not a control word; the lure writes it as the field's instruction.
    expect(
      rtfCensus(
        '{\\field{\\*\\fldinst DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc"}}{\\*\\fldinst ddeauto x}'
      )
    ).toBe(`RTF object and DDEAUTO markers found: DDEAUTO ×2${RTF_TAIL}`)
  })

  it('shows only a class-name-shaped \\objclass value, and says when it does not', () => {
    const withheld = 'the first \\objclass is not followed by a short plain class name, so its value is not shown here'
    expect(rtfCensus('{\\*\\objclass http://evil.test/x}')).toBe(
      `RTF object and DDEAUTO markers found: ${withheld}${RTF_TAIL}`
    )
    // Past 64 characters it is not shown in part either: a prefix is a value the file does not hold.
    expect(rtfCensus(`{\\*\\objclass ${'A'.repeat(65)}}`)).toBe(
      `RTF object and DDEAUTO markers found: ${withheld}${RTF_TAIL}`
    )
    expect(rtfCensus(`{\\*\\objclass ${'A'.repeat(64)}}`)).toBe(
      `RTF object and DDEAUTO markers found: the first \\objclass reads ${'A'.repeat(64)}${RTF_TAIL}`
    )
    // Only the first is read, even when a later one would read cleanly.
    expect(rtfCensus('{\\*\\objclass }{\\*\\objclass Package}')).toBe(
      `RTF object and DDEAUTO markers found: ${withheld}${RTF_TAIL}`
    )
  })

  it('stops counting at 999 and says it is a lower bound', () => {
    expect(rtfCensus('{\\objdata 00}'.repeat(1500))).toBe(
      `RTF object and DDEAUTO markers found: \\objdata ×999+${RTF_TAIL}`
    )
  })

  it('stays linear on hostile text built from near-misses', () => {
    // 16MB of prefixes that almost match, and one \objclass followed by millions of blanks.
    expect(rtfCensus('\\obj'.repeat(1_000_000) + '\\objdat'.repeat(1_000_000) + 'ddeaut'.repeat(500_000))).toBeNull()
    expect(rtfCensus(`\\objclass${' '.repeat(4_000_000)}:`)).toBe(
      `RTF object and DDEAUTO markers found: the first \\objclass is not followed by a short plain class name, so ` +
        `its value is not shown here${RTF_TAIL}`
    )
  })
})

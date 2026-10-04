import { describe, expect, it } from 'vitest'
import { deflateRaw, zip } from '../../test/zip'
import { analysePhishing, caseIocs, formatPhishReport } from './phish'

const enc = new TextEncoder()

/** A mail carrying one .docx whose settings rels name `target` as its External attachedTemplate. */
async function templateMail(target: string): Promise<string> {
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="${target}" TargetMode="External"/>` +
    '</Relationships>'
  const relsBytes = enc.encode(rels)
  const docx = zip([
    { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
    // Deflated, as in any real .docx, so no raw byte scan can find the target.
    { name: 'word/_rels/settings.xml.rels', data: await deflateRaw(relsBytes), method: 8, size: relsBytes.length }
  ])
  let binary = ''
  for (const b of docx) binary += String.fromCharCode(b)
  return [
    'From: a@sender.test',
    'To: b@corp.test',
    'Subject: files',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'see attached',
    '--B',
    'Content-Type: application/octet-stream; name="Template.docx"',
    'Content-Disposition: attachment; filename="Template.docx"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(binary),
    '--B--',
    ''
  ].join('\n')
}

describe('a U+E000 an Office file writes', () => {
  it('cannot pose as a reader gap to hide its remote template from the case', async () => {
    for (const target of ['https://evil-template.test/t.dotm&#xE000;', 'https://evil-template.test/t.dotm']) {
      const mail = await templateMail(target)
      const report = await analysePhishing(mail, [], [])
      expect(caseIocs(report, mail)).toContainEqual(
        expect.objectContaining({ type: 'url', value: 'https://evil-template.test/t.dotm' })
      )
      // The reader cut nothing here, so the report must not say it did.
      expect(formatPhishReport(report)).not.toContain('[…]')
    }
  })
})

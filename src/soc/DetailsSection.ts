import { Notice } from 'obsidian'
import type { CaseDetail, Task } from '../types'
import { IconButton } from '../ui/primitives/IconButton'
import { BARE_DOMAIN_TLDS, hasIocShape, ipv6, refangIoc } from './ioc'
import { safeAsync } from '../utils'

/** Offered as the field is typed (a native datalist); any other name is kept as typed. */
export const DETAIL_FIELDS = [
  'User',
  'Workstation',
  'Host',
  'IP',
  'Email',
  'Department',
  'Process',
  'Parent process',
  'Command line',
  'File path',
  'Hash',
  'URL',
  'Domain',
  'Registry key',
  'Message-ID',
  'Subject',
  'Sender',
  'Recipient',
  'Hostname'
]

/** Programs a command line starts with: shells, LOLBins and the tools an intrusion runs. */
const PROGRAM =
  /^(?:powershell|pwsh|cmd|mshta|rundll32|regsvr32|certutil|wscript|cscript|bitsadmin|vssadmin|schtasks|wmic|net1?|whoami|nltest|reg|sc|msiexec|bcdedit|wevtutil|taskkill|forfiles|installutil|regasm|msbuild|odbcconf|at|bash|sh|zsh|curl|wget|python3?|perl|nc|ncat|iex|invoke-expression|start-process|ssh|scp|nslookup|ping|tasklist|netstat|ipconfig|systeminfo|psexec|procdump|mimikatz|rclone|adfind)$/i
const EXE = /\.(?:exe|bat|cmd|ps1|vbs|hta|msi|scr)$/i
const FILE_NAME =
  /^[^\s\\/:]+\.(?:exe|dll|sys|ps1|psm1|bat|cmd|vbs|vbe|js|jse|wsf|hta|scr|lnk|msi|iso|img|vhdx?|zip|rar|7z|gz|tgz|docx?|docm|xlsx?|xlsm|xlsb|pptx?|pptm|pdf|one|rtf|html?|svg|jar|apk|dmg|pkg|sh|py|tmp|dat|bin|plist)$/i
const PATH = /^(?:[a-z]:[\\/]|%\w+%[\\/]|\$env:\w+[\\/]|\\\\[^\s\\]|~?\/[^\s/])/i
const REGISTRY = /^(?:HK(?:LM|CU|U|CR|CC)|HKEY_[A-Z_]+):?\\/i
/** An address whose domain ends in a word, so lodash@4.17.21 and root@10.0.0.5 are not one. */
const EMAIL = /^[\p{L}\p{N}_.+'-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}[\p{L}\p{N}-]*$/iu
const HASH = /^[0-9a-f]{32,128}$/i
/** Folder names that make a relative path (Windows\Temp), never a DOMAIN\user. */
const FOLDERS = new Set(
  'windows system32 syswow64 appdata roaming local locallow temp programdata users tasks drivers config prefetch startup downloads desktop documents'.split(
    ' '
  )
)
/** A bare host is a domain only on a TLD that is one (a user name like anita.garcia is not). */
const DETAIL_TLDS = new Set([
  ...BARE_DOMAIN_TLDS,
  ...'gov edu mil int ly ai us ca au jp br es nl eu ch se pl ie dk fi pt cz ro hu gr tr ua kr tw hk sg th vn ph za ke mx ar cl app dev shop icu sbs click link store cfd bond lol cloud page tv vip win today space website tech host fun buzz rest monster'.split(
    ' '
  )
])
/** The kinds whose shape never ends in prose punctuation: a trailing comma or full stop is the sentence's. */
const INDICATOR_KINDS = new Set(['IP', 'Domain', 'Email', 'URL', 'Hash'])

function ipv4OK(v: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v) && v.split('.').every((o) => Number(o) <= 255)
}

/** An IP as written in logs: v4 with a port or a /prefix, v6 bracketed with a port, a %zone, a /prefix, ::ffff:a.b.c.d. */
function isIp(v: string): boolean {
  const v4 = /^([\d.]+)(?::(\d{1,5})|\/(\d{1,2}))?$/.exec(v)
  if (v4 && ipv4OK(v4[1]) && (v4[3] === undefined || Number(v4[3]) <= 32)) return true
  const v6 = /^\[?([0-9a-f:.]+)(?:%[\w.-]+)?\]?(?::\d{1,5})?(?:\/(\d{1,3}))?$/i.exec(v)
  return !!v6 && v6[1].includes(':') && ipv6(v6[1]) !== null && (v6[2] === undefined || Number(v6[2]) <= 128)
}

function isDomain(host: string, defanged: boolean): boolean {
  const h = host
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '')
    .toLowerCase()
  // An address is never a bare domain, with or without a full stop after it.
  if (!h.includes('.') || h.includes('@') || !hasIocShape(h) || ipv4OK(h)) return false
  return defanged || DETAIL_TLDS.has(h.slice(h.lastIndexOf('.') + 1))
}

/**
 * A token that reads as a program's argument: a flag (-x, --x, /c), a quoted
 * or $/%/{ token, or one carrying a path, a URL, '=' or a pipe. An arrow, a
 * lone dash, a clock time or an ip:port is prose about a program, not an argument.
 */
function isArgument(t: string): boolean {
  if (/^(?:-+>?|=>|[–—])$/.test(t) || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(t) || isIp(t)) return false
  return /^(?:--?[\w?-]|\/[\w?]|["'$%{])/.test(t) || /^[a-z]:\\|:\/\/|[\\=|]/i.test(t)
}

/**
 * A value as an analyst copies it, without what came with it: zero-width
 * characters, one quote mark, one list marker or task box, backticks or bold
 * around the whole value, and quotes or brackets that wrap all of it and
 * nothing else. What is the value's own stays: the quotes of
 * "C:\x.exe" /c "y", a trailing ' .' or '..', the stars of a crontab line.
 */
function unwrapValue(text: string): string {
  let v = text.replace(/^[\u200b-\u200d\u2060\ufeff\s]+|[\u200b-\u200d\u2060\ufeff\s]+$/g, '')
  v = v.replace(/^>\s+/, '')
  // A list marker only before a value, not the first star of "* * * * *".
  const marker = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(v)
  if (marker && !/^[-*+]\s/.test(v.slice(marker[0].length))) v = v.slice(marker[0].length)
  for (let pass = 0; pass < 2; pass++) {
    const code = /^`([^`]+)`$/.exec(v) ?? /^\*\*([^*]+)\*\*$/.exec(v)
    const quoted = /^(["'])(.*)\1$/.exec(v)
    const bracketed = /^[([](.*)[)\]]$/.exec(v)
    if (code) v = code[1].trim()
    else if (quoted && !quoted[2].includes(quoted[1])) v = quoted[2].trim()
    else if (bracketed && !/[()[\]]/.test(bracketed[1]) && '(['.indexOf(v[0]) === ')]'.indexOf(v[v.length - 1])) {
      v = bracketed[1].trim()
    } else break
  }
  return v
}

/**
 * The value as it is kept, and the field its shape names (null when it does
 * not say). The value is what was pasted; only an indicator (IP, Domain,
 * Email, URL, Hash) loses the markup it came wrapped in, or the full stop of
 * the sentence it was copied from. Zero-width characters inside stay: an
 * obfuscated pay\u200bpal.com is evidence.
 */
function readValue(text: string): { value: string; field: string | null } {
  const raw = text.replace(/^[\u200b-\u200d\u2060\ufeff\s]+|[\u200b-\u200d\u2060\ufeff\s]+$/g, '')
  const asIs = kindOf(raw)
  if (asIs) return { value: raw, field: asIs }
  let bare = unwrapValue(raw)
  if (!kindOf(bare)) bare = unwrapValue(bare.replace(/([\w"'`)\]>])[.,;:]$/, '$1'))
  const kind = kindOf(bare)
  return { value: kind && INDICATOR_KINDS.has(kind) ? bare : raw, field: kind }
}

/** The value as it is kept: see readValue. */
export function cleanDetailValue(text: string): string {
  return readValue(text).value
}

/**
 * The field a value names by its own shape, defanged or not: Email (a display
 * name, mailto: or <address> allowed), Message-ID, IP, URL (with or without a
 * scheme), Domain, Hash, File path, Registry key, User (DOMAIN\user), Command
 * line (a program and an argument). Null when the value does not say, and the
 * analyst names it.
 */
export function detectDetailField(text: string): string | null {
  return readValue(text).field
}

function kindOf(v: string): string | null {
  if (!v || /[\r\n]/.test(v)) return null
  if (v.endsWith('>') && v.includes('<')) {
    const named = /^(?:"[^"]*"|'[^']*'|[^<>"@:]*[^<>"@:\s])\s*<([^\s<>@]+@[^\s<>]+)>$/.exec(v)
    if (named && EMAIL.test(refangIoc(named[1]))) return 'Email'
    const bracketed = /^<([^\s<>@]+)@([^\s<>]+)>$/.exec(v)
    if (bracketed) {
      // A Message-ID's left side is machine-made: = $ % #, a long number, a hex run with digits,
      // an Exchange id (BN6PR11MB1234…), dotted parts with digits. A person's is not.
      const local = bracketed[1]
      const machine =
        /[=$%#]/.test(local) ||
        /\d{8,}/.test(local) ||
        (/[0-9a-f]{12,}/i.test(local) && /\d/.test(local)) ||
        /[A-Z]{2,}\d+[A-Z]{2,}/.test(local) ||
        (/\d/.test(local) && local.split('.').length >= 3)
      return !machine && EMAIL.test(`${local}@${bracketed[2]}`) ? 'Email' : 'Message-ID'
    }
  }
  const hash = /^(?:md5|sha-?(?:1|224|256|384|512))\s*[:=]\s*(\S+)$/i.exec(v)?.[1] ?? v
  if (HASH.test(hash) && hash.length % 2 === 0) return 'Hash'
  if (REGISTRY.test(v)) return 'Registry key'
  if (/^(?:NT AUTHORITY|NT SERVICE|Window Manager|Font Driver Host)\\[\w .$-]+$/i.test(v)) return 'User'
  if (/\s/.test(v)) {
    const [first, ...rest] = v.match(/"[^"]*"|\S+/g) ?? []
    const program = (first ?? '').replace(/^"|"$/g, '')
    const name = program.slice(Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/')) + 1)
    const runs = EXE.test(program) || PROGRAM.test(name.replace(/\.exe$/i, ''))
    if (runs && rest.some(isArgument)) return 'Command line'
    // An unquoted program under a path with spaces, then its arguments.
    const exe = /\.(?:exe|bat|cmd|ps1|vbs|hta|msi|scr)\s/i.exec(v)
    const after = exe ? v.slice(exe.index + exe[0].length).split(/\s+/) : []
    if (PATH.test(v) && after.some(isArgument)) return 'Command line'
    return PATH.test(v) ? 'File path' : null
  }
  const real = refangIoc(v.replace(/^mailto:/i, ''))
  if (/^(?:https?|ftps?|sftp|smb|ldaps?|wss?):\/\/\S+$/i.test(real)) return 'URL'
  const last = real.split('\\').pop() ?? ''
  if (PATH.test(v) || FILE_NAME.test(real) || (real.includes('\\') && FILE_NAME.test(last))) return 'File path'
  const account = /^([\w.-]+)\\([\w.$-]+)$/.exec(v)
  if (account) {
    if (FOLDERS.has(account[1].toLowerCase()) || FOLDERS.has(account[2].toLowerCase())) return 'File path'
    // BUILTIN\Administrators is a group, not a user.
    return /^builtin$/i.test(account[1]) ? null : 'User'
  }
  if (isIp(real)) return 'IP'
  if (EMAIL.test(real)) return 'Email'
  const defanged = real !== v
  const url = /^([^/?#]+)([/?#]\S*)$/.exec(real)
  if (url && (ipv4OK(url[1].replace(/:\d{1,5}$/, '')) || isDomain(url[1], defanged))) return 'URL'
  return isDomain(real, defanged) ? 'Domain' : null
}

/** Reply and forward marks: an email subject's, never a field name. */
const REPLY_MARK = /^(?:re|fwd?|aw|sv|tr|wg|antw|vs|rv|ynt)$/i
const NAME_LIKE = /^\p{L}[\p{L}\p{N} ._()#/&'’,+-]{0,39}$/u

/** `**x**`, `__x__` and `` `x` `` around a whole cell are markup, not the value. */
function unwrap(s: string): string {
  return s
    .trim()
    .replace(/^`([^`]+)`$|^\*\*((?:(?!\*\*).)+)\*\*$/, (_, code?: string, bold?: string) => code ?? bold ?? '')
    .trim()
}

/**
 * Rows from pasted text, one per line: a markdown table row (`| User | anita |`),
 * a tab-separated pair, or `Field: value` (colon then a space, so `C:\` and
 * `https://` stay whole). A table's divider row and a `Field | Value` header
 * are skipped. A name splits a line when it is a known one (DETAIL_FIELDS or
 * `names`) or, unless `knownOnly`, reads as a name; a subject's RE: does not.
 * A bare value on its own line is named `bareField` when given, else by its
 * kind (detectDetailField). `unread` counts the lines left over.
 */
export function parseDetailLines(
  text: string,
  opts: { bareField?: string; names?: Iterable<string>; knownOnly?: boolean } = {}
): { rows: CaseDetail[]; unread: number } {
  const bareField = opts.bareField ?? ''
  const names = new Set([...DETAIL_FIELDS, ...(opts.names ?? [])].map((n) => n.toLowerCase()))
  const known = (name: string) => names.has(name.toLowerCase())
  // Under a name typed for bare values, or for one line into the field box, only a known name splits a line.
  const strict = !!opts.knownOnly || !!bareField
  const splits = (name: string) => known(name) || (!strict && NAME_LIKE.test(name) && !REPLY_MARK.test(name))
  const rows: CaseDetail[] = []
  let unread = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let field = ''
    let value = ''
    const tab = line.indexOf('\t')
    const colon = line.indexOf(': ')
    const left = colon > 0 ? unwrap(line.slice(0, colon).replace(/^[-*+]\s+/, '')) : ''
    const after = colon > 0 ? line.slice(colon + 2) : ''
    // A table cell's escaped pipe (\|) is its own, as Obsidian writes one.
    const cells = line
      .replace(/\\\|/g, '\ue000')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => unwrap(c.replace(/\ue000/g, '|')))
    // A table row starts with a pipe; anywhere else a pipe is the value's own
    // (`cmd | find`, whoami /all | more), so tab and ": " pairs are tried first.
    const table = line.startsWith('|') ? !strict || known(cells[0] ?? '') : false
    const bareCells = tab < 0 && colon <= 0 && line.includes('|') && !detectDetailField(line) && splits(cells[0] ?? '')
    if (line.startsWith('|') && cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    if (table || bareCells) {
      field = cells[0] ?? ''
      value = cells.slice(1).filter(Boolean).join(' | ')
    } else if (tab >= 0 && (!strict || known(unwrap(line.slice(0, tab))))) {
      field = unwrap(line.slice(0, tab))
      value = unwrap(line.slice(tab + 1))
    } else if (
      colon > 0 &&
      splits(left) &&
      // A colon in a command line (cmd /c echo done: ok) is the command's own; a
      // name before a value (Reg key: HKLM\...) still names it.
      (known(left) || !detectDetailField(line) || (detectDetailField(after) !== null && !detectDetailField(left)))
    ) {
      field = left
      value = unwrap(after)
    } else {
      // A bare value on its own line takes the name typed for it, or its kind's, or is left unread.
      const read = readValue(line)
      value = read.value
      field = bareField || (read.field ?? '')
    }
    if (field && value.toLowerCase() === 'value') continue
    if (field && value) rows.push({ field, value })
    else unread++
  }
  return { rows, unread }
}

let datalistSeq = 0

/**
 * The case's Details: who and what the incident touches, as field/value rows.
 * Edits the task clone in place and calls onChange, like the indicator table.
 */
export function renderDetailsSection(container: HTMLElement, task: Task, opts: { onChange: () => void }): void {
  const section = container.createDiv('pm-modal-section pm-details-section')
  const header = section.createDiv('pm-modal-section-header')
  const title = header.createEl('h4', { cls: 'pm-modal-section-title' })
  // One list per section: the modal and the side panel can both be open.
  const listId = `pm-detail-fields-${++datalistSeq}`
  const datalist = section.createEl('datalist', { attr: { id: listId } })
  for (const f of DETAIL_FIELDS) datalist.createEl('option', { value: f })
  const rowsEl = section.createDiv('pm-details-rows')

  const details = (): CaseDetail[] => (task.details ??= [])
  const fieldInput = (parent: HTMLElement, placeholder: string): HTMLInputElement =>
    parent.createEl('input', {
      type: 'text',
      cls: 'pm-prop-text pm-details-field',
      attr: { placeholder, list: listId, 'aria-label': 'Detail field', spellcheck: 'false' }
    })
  const valueInput = (parent: HTMLElement, placeholder: string): HTMLInputElement =>
    parent.createEl('input', {
      type: 'text',
      cls: 'pm-prop-text pm-details-value',
      attr: { placeholder, 'aria-label': 'Detail value', spellcheck: 'false' }
    })

  const changed = () => {
    // An emptied list leaves the key out of the file (links idiom).
    if (task.details && !task.details.length) delete task.details
    renderRows()
    opts.onChange()
  }

  // By identity: a row already gone (indexOf -1) must not take the last one with it.
  const remove = (d: CaseDetail) => {
    const at = task.details?.indexOf(d) ?? -1
    if (at < 0) return
    task.details?.splice(at, 1)
    changed()
  }

  const renderRows = () => {
    const list = task.details ?? []
    title.setText(`Details (${list.length})`)
    rowsEl.empty()
    for (const d of list) {
      const row = rowsEl.createDiv('pm-details-row')
      const field = fieldInput(row, 'Field')
      field.value = d.field
      field.addEventListener('change', () => {
        const v = field.value.trim()
        // A row needs a name: an emptied one keeps the last.
        if (!v) field.value = d.field
        else if (v !== d.field) {
          d.field = v
          opts.onChange()
        }
      })
      const value = valueInput(row, 'Value')
      value.value = d.value
      value.addEventListener('change', () => {
        const v = value.value.trim()
        if (v === d.value) return
        if (v) {
          d.value = v
          opts.onChange()
          return
        }
        // Emptying a value removes its row; the activity log keeps what it was.
        remove(d)
      })
      const copyBtn = new IconButton(row).setIcon('copy').setTooltip('Copy value')
      copyBtn.onClick(
        safeAsync(async () => {
          await navigator.clipboard.writeText(d.value)
          copyBtn.setIcon('check')
          window.setTimeout(() => copyBtn.setIcon('copy'), 700)
        })
      )
      new IconButton(row)
        .setIcon('x')
        .setTooltip('Remove detail')
        .onClick(() => remove(d))
    }
  }

  const addRow = section.createDiv('pm-details-row pm-details-add')
  const newField = fieldInput(addRow, 'Field, e.g. User')
  const newValue = valueInput(addRow, 'Value')
  const addBtn = addRow.createEl('button', { cls: 'pm-soc-btn', text: 'Add' })
  // The field name the add line wrote itself from the value: the next value
  // may change it. A name the analyst typed is theirs and stays.
  let namedFor = ''
  newField.addEventListener('input', () => (namedFor = ''))
  // An IME or a dictation starting in a self-filled name replaces it too.
  const dropSelfName = () => {
    if (namedFor && newField.value === namedFor) newField.value = namedFor = ''
  }
  newField.addEventListener('compositionstart', dropSelfName)
  // Typing into a name the add line wrote replaces it, rather than joining onto it.
  newField.addEventListener('beforeinput', (e) => {
    if (!namedFor || newField.value !== namedFor || e.inputType !== 'insertText' || !e.data) return
    e.preventDefault()
    newField.value = e.data
    namedFor = ''
  })
  const fieldFree = () => !newField.value.trim() || newField.value === namedFor
  // A self-filled name follows the value's kind; it is blanked only for a fresh paste
  // that has none, not when the analyst adds words to a value already named.
  const nameFrom = (value: string, fresh = false) => {
    if (!fieldFree()) return
    const kind = detectDetailField(value)
    if (kind || fresh) newField.value = namedFor = kind ?? ''
  }
  newValue.addEventListener('change', () => nameFrom(newValue.value))
  // A paste lands in the value box as pasted; the field is named from what is there after.
  newValue.addEventListener('input', (e) => {
    const how = e.inputType
    if (how !== 'insertFromPaste' && how !== 'insertFromDrop') return
    const read = readValue(newValue.value)
    // Only an indicator sheds the markup it came in (a list marker, backticks, quotes), in sight before Add.
    if (read.field && read.value !== newValue.value.trim()) newValue.value = read.value
    nameFrom(newValue.value, true)
  })
  const commitAdd = () => {
    nameFrom(newValue.value)
    const field = newField.value.trim()
    const value = newValue.value.trim()
    if (!field || !value) {
      ;(field ? newValue : newField).focus()
      return
    }
    details().push({ field, value })
    newField.value = newValue.value = namedFor = ''
    changed()
    newField.focus()
  }
  addBtn.addEventListener('click', commitAdd)
  /**
   * One line pasted into the empty field box. A value that cannot be a name
   * (an IP, an address, a URL, a hash, a path, a command; any kind but a bare
   * domain like event.id) goes to the value box, named; a "Known field: value"
   * line fills both; a subject or log line goes to the value box unnamed.
   * Anything else is the name being pasted. The value box keeps its own paste.
   */
  const pasteOne = (input: HTMLInputElement, text: string, e: ClipboardEvent) => {
    if (input !== newField) return
    // A paste over a self-filled name replaces it.
    dropSelfName()
    if (newField.value.trim() || newValue.value.trim()) return
    const read = readValue(text)
    const used = details().map((d) => d.field)
    // A pair only when the line is not itself a value (a bare value would come back named by its kind).
    const pair = read.field ? undefined : parseDetailLines(text, { names: used, knownOnly: true }).rows[0]
    const valueKind = read.field && (read.field !== 'Domain' || refangIoc(read.value) !== read.value)
    if (pair) {
      newField.value = pair.field
      newValue.value = pair.value
      namedFor = ''
    } else if (valueKind) {
      newValue.value = read.value
      newField.value = namedFor = read.field ?? ''
    } else if (/:\s|\t/.test(text.trim())) {
      newValue.value = text.trim()
      newField.value = namedFor = ''
    } else return
    e.preventDefault()
    newValue.focus()
  }

  for (const input of [newField, newValue]) {
    input.addEventListener('keydown', (e) => {
      // A modified Enter is the dialog's (Shift+Enter saves).
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      // Stops the modal's own Enter handling (Shift+Enter saves; this is not that).
      e.stopPropagation()
      if (input === newField && !newValue.value.trim()) newValue.focus()
      else commitAdd()
    })
    // Several lines pasted at once (a copied table, "User: x" lines) become
    // rows in one go; a single line pastes into the box as usual.
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? ''
      if (!/\r?\n/.test(text.trim())) {
        pasteOne(input, text.trim(), e)
        return
      }
      e.preventDefault()
      // A name typed for them names the bare values pasted under it.
      const typed = fieldFree() ? '' : newField.value.trim()
      const { rows, unread } = parseDetailLines(text, { bareField: typed, names: details().map((d) => d.field) })
      const have = new Set((task.details ?? []).map((d) => `${d.field}\u0000${d.value}`))
      const fresh = rows.filter((r) => !have.has(`${r.field}\u0000${r.value}`))
      const parts: string[] = []
      if (fresh.length) parts.push(`Added ${fresh.length} detail${fresh.length === 1 ? '' : 's'}`)
      if (rows.length > fresh.length) parts.push(`${rows.length - fresh.length} already recorded`)
      if (unread) parts.push(`${unread} line${unread === 1 ? '' : 's'} not read as "Field: value"`)
      if (parts.length) new Notice(parts.join(' · '))
      if (!fresh.length) return
      details().push(...fresh)
      // The typed name is used up; a value waiting in the box stays for its own Add.
      if (typed) newField.value = namedFor = ''
      changed()
    })
  }

  renderRows()
}

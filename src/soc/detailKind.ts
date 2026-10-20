import { BARE_DOMAIN_TLDS, hasIocShape, ipv6, refangIoc } from './ioc'

/**
 * What a detail value is by its own shape (an IP, a path, a command line…),
 * pure so the note timeline can read it too. DetailsSection re-exports it.
 */

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
/** A workstation or server on an internal name (DESKTOP1.domain.local), never a public domain. */
const INTERNAL_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:local|localdomain|lan|internal|intranet|corp|home\.arpa)(?::\d{1,5})?$/i
/** The kinds whose shape never ends in prose punctuation: a trailing comma or full stop is the sentence's. */
const INDICATOR_KINDS = new Set(['IP', 'Domain', 'Hostname', 'Email', 'URL', 'Hash'])

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
export function readValue(text: string): { value: string; field: string | null } {
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
 * scheme), Domain, Hostname (an internal name), Hash, File path, Registry key, User (DOMAIN\user), Command
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
  if (INTERNAL_HOST.test(real)) return 'Hostname'
  return isDomain(real, defanged) ? 'Domain' : null
}

/** A field name as an analyst writes one before ': '. */
export const NAME_LIKE = /^\p{L}[\p{L}\p{N} ._()#/&'’,+-]{0,39}$/u

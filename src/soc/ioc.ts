import type { Ioc, IocType } from '../types'

export const IOC_TYPE_LABELS: Record<IocType, string> = {
  ip: 'IP',
  domain: 'Domain',
  hash: 'Hash',
  url: 'URL',
  email: 'Email'
}

export const IOC_TYPE_ICONS: Record<IocType, string> = {
  ip: 'network',
  domain: 'globe',
  hash: 'hash',
  url: 'link',
  email: 'mail'
}

/**
 * Defang an IOC for display so it is never click- or copy-hazardous:
 * http→hxxp, dots→[.], @→[at]. The stored value stays real; only rendering
 * defangs. Hashes pass through untouched (nothing to neutralize).
 */
export function defangIoc(value: string, type: IocType): string {
  if (type === 'hash') return value
  let out = value.replace(/^(\s*)https?/i, (m) => m.replace(/http/i, (h) => (h === 'HTTP' ? 'HXXP' : 'hxxp')))
  out = out.replace(/\./g, '[.]')
  if (type === 'email' || type === 'url') out = out.replace(/@/g, '[at]')
  return out
}

/**
 * Undo the common defang forms so pasted report indicators are stored real:
 * hxxp→http, [.]/(.)→., [at]/(at)/[@]→@, [:]→:. Inverse of defangIoc plus
 * the variants seen in vendor reports. Idempotent on already-real values.
 */
// ponytail: covers the defang forms in real CTI reports; extend the map if a new one shows up
export function refangIoc(value: string): string {
  return value
    .trim()
    .replace(/^hxxp/i, (h) => (h === 'HXXP' ? 'HTTP' : 'http'))
    .replace(/[[(]\.[\])]/g, '.')
    .replace(/[[(]at[\])]/gi, '@')
    .replace(/\[@\]/g, '@')
    .replace(/\[:\]/g, ':')
}

/** One display line per indicator: 'type: defangedValue — note' (note only when present). */
export function formatIocLine(ioc: Ioc): string {
  const line = `${ioc.type}: ${defangIoc(ioc.value, ioc.type)}`
  return ioc.note ? `${line} — ${ioc.note}` : line
}

/**
 * Turn a pasted blob into new indicator rows: split on whitespace/commas,
 * refang and classify each token, drop anything already on the task
 * (case-insensitive over refanged values — stored values may predate
 * refang-on-intake) and repeats within the paste itself.
 */
export function parseIocPaste(text: string, existingValues: string[]): Ioc[] {
  const seen = new Set(existingValues.map((v) => refangIoc(v).toLowerCase()))
  const out: Ioc[] = []
  for (const token of text.split(/[\s,]+/)) {
    const value = refangIoc(token)
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: detectIocType(value), value })
  }
  return out
}

/** Classify a (refanged) indicator: hex hash, IP literal, scheme://=url, @=email, else domain. */
export function detectIocType(value: string): IocType {
  const v = value.trim()
  if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(v)) return 'hash'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return 'url'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return 'ip'
  if (v.includes(':') && /^[0-9a-f:]+$/i.test(v)) return 'ip'
  if (v.includes('@')) return 'email'
  return 'domain'
}

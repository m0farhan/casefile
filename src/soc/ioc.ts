import type { IocType } from '../types'

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

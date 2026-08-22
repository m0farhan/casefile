import { setIcon, setTooltip } from 'obsidian'
import type { IssueTypeConfig } from '../../types'
import { isIconName, safeAsync } from '../../utils'

/** Jira-style issue-type square: 16px rounded square filled with the type color, white glyph
 * (Lucide id or emoji) centered, type label as tooltip. `size: 'sm'` renders the 12px variant. */
export function renderIssueTypeIcon(
  el: HTMLElement,
  cfg: IssueTypeConfig | undefined,
  opts?: { size?: 'md' | 'sm' }
): void {
  if (!cfg) return
  const icon = el.createSpan({ cls: 'pm-issuetype-icon' })
  if (opts?.size === 'sm') icon.addClass('pm-issuetype-icon--sm')
  icon.setCssProps({ '--pm-issuetype-color': cfg.color })
  if (cfg.icon && isIconName(cfg.icon)) setIcon(icon, cfg.icon)
  else icon.setText(cfg.icon)
  setTooltip(icon, cfg.label)
}

/** Monospace issue-key chip ("SOC-12"). With `copy`, clicking copies the key and flashes a tick.
 * With `plain`, renders as borderless subtle text instead of the boxed chip. */
export function renderKeyChip(el: HTMLElement, key: string, opts?: { copy?: boolean; plain?: boolean }): void {
  const chip = el.createSpan({ cls: 'pm-key-chip', text: key })
  if (opts?.plain) chip.addClass('pm-key-chip--plain')
  if (!opts?.copy) return
  chip.addClass('pm-key-chip--copy')
  setTooltip(chip, 'Copy issue key')
  chip.addEventListener(
    'click',
    safeAsync(async (e: MouseEvent) => {
      e.stopPropagation()
      await navigator.clipboard.writeText(key)
      chip.setText('✓')
      window.setTimeout(() => chip.setText(key), 700)
    })
  )
}

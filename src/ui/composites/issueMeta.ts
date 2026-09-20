import { setIcon, setTooltip } from 'obsidian'
import type { AlertCategoryConfig, IssueTypeConfig } from '../../types'
import { categoryForTags } from '../../soc/alertCategory'
import { isIconName, safeAsync } from '../../utils'

/** Colored issue-type glyph (Lucide id or emoji) with the type label as tooltip.
 * Deliberately the quiet tinted glyph, not Jira's filled square — Farhan
 * prefers the dark look (2026-08-22); revisit only if he asks. `size` kept
 * for callers that pass it. */
export function renderIssueTypeIcon(
  el: HTMLElement,
  cfg: IssueTypeConfig | undefined,
  opts?: {
    size?: 'md' | 'sm'
    /** The case's own tags and the configured catalog. On an INCIDENT whose tags
     *  name a category, the category's glyph replaces the issue-type siren —
     *  every incident carries the same siren, so it says nothing on a SOC board.
     *  No matching tag keeps the siren: the kind of alert is then not recorded,
     *  and a glyph guessed from the title would be a claim about meaning. */
    alert?: { tags: readonly string[]; categories: readonly AlertCategoryConfig[] }
  }
): void {
  if (!cfg) return
  // Incident-only, the same gate the SLA chip uses: a story tagged `macro`
  // must not turn into a file-warning glyph.
  const category =
    cfg.id === 'incident' && opts?.alert ? categoryForTags(opts.alert.tags, opts.alert.categories) : undefined
  const shown = category ?? cfg
  const icon = el.createSpan({ cls: 'pm-issuetype-icon' })
  if (opts?.size === 'sm') icon.addClass('pm-issuetype-icon--sm')
  icon.setCssStyles({ color: shown.color })
  if (shown.icon && isIconName(shown.icon)) setIcon(icon, shown.icon)
  else icon.setText(shown.icon)
  setTooltip(icon, category ? `${cfg.label} · ${category.label}` : cfg.label)
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

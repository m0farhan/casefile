import { setIcon, setTooltip } from 'obsidian'
import type { AlertCategoryConfig, IssueTypeConfig } from '../../types'
import { type AlertKind, alertKindOf } from '../../soc/alertCategory'
import { isIconName, safeAsync } from '../../utils'

/** A case's own tags and title, and the configured kinds. */
export interface AlertKindInput {
  tags: readonly string[]
  title: string
  categories: readonly AlertCategoryConfig[]
}

/**
 * ponytail: module-level mirror of settings.deriveAlertKind, set by main.ts at
 * load and by the settings toggle. The board card has no plugin to read it
 * from (KanbanView hands it the setSocConfig bridge instead), and one flag
 * read by every icon is what keeps the card, row, panel and dialog agreeing.
 */
let deriveKinds = true

export function setAlertKindDerivation(on: boolean): void {
  deriveKinds = on
}

/** The kind the issue icon shows: recorded by a tag, else derived from the title while derivation is on. */
export function shownAlertKind(alert: AlertKindInput): AlertKind | undefined {
  return alertKindOf(alert.tags, alert.title, alert.categories, deriveKinds)
}

/** Colored issue-type glyph (Lucide id or emoji) with the type label as tooltip.
 * Deliberately the quiet tinted glyph, not Jira's filled square — Farhan
 * prefers the dark look (2026-08-22); revisit only if he asks. `size` kept
 * for callers that pass it. Returns the glyph, or nothing for an unknown type. */
export function renderIssueTypeIcon(
  el: HTMLElement,
  cfg: IssueTypeConfig | undefined,
  opts?: {
    size?: 'md' | 'sm'
    /** On an INCIDENT, the kind's glyph replaces the issue-type siren — every
     *  incident carries the same siren, so it says nothing on a SOC board. A
     *  kind the tags record draws as normal. One only derived from the title
     *  draws muted and outlined, and its tooltip names the word, so a reading
     *  of the title is never shown as a fact the analyst recorded. */
    alert?: AlertKindInput
  }
): HTMLElement | undefined {
  if (!cfg) return undefined
  // Incident-only, the same gate the SLA chip uses: a story tagged `macro`
  // must not turn into a file-warning glyph.
  const kind = cfg.id === 'incident' && opts?.alert ? shownAlertKind(opts.alert) : undefined
  const shown = kind?.category ?? cfg
  const icon = el.createSpan({ cls: 'pm-issuetype-icon' })
  if (opts?.size === 'sm') icon.addClass('pm-issuetype-icon--sm')
  icon.setCssStyles({ color: shown.color })
  if (shown.icon && isIconName(shown.icon)) setIcon(icon, shown.icon)
  else icon.setText(shown.icon)
  if (kind?.derivedFrom !== undefined) {
    icon.addClass('pm-issuetype-icon--derived')
    setTooltip(
      icon,
      `${cfg.label} · ${kind.category.label}, derived from the title word "${kind.derivedFrom}" — not recorded ` +
        'on the case. Set the alert kind to record it.'
    )
  } else {
    setTooltip(icon, kind ? `${cfg.label} · ${kind.category.label}` : cfg.label)
  }
  return icon
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

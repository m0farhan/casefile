import { Chip } from '../primitives/Chip'

export type DueUrgency = 'normal' | 'near' | 'overdue'

/**
 * Due-date chip; orange when the date is near, red and bold when overdue. The
 * caller formats the label.
 *
 * Colour, not fill. A filled red date used to sit beside a filled red SLA chip
 * on the same card and the two competed — on a case whose clock has already
 * breached, the date is the lesser fact. One filled red per card now, and it
 * is the one with a countdown in it.
 */
export function renderDueChip(parent: HTMLElement, label: string, urgency: DueUrgency, size: 'md' | 'sm' = 'md'): Chip {
  const chip = new Chip(parent).setLabel(label).setSize(size)
  if (urgency === 'near') {
    chip.setColor('var(--color-orange)')
  } else if (urgency === 'overdue') {
    chip.setColor('var(--color-red)').setStrong()
  }
  return chip
}

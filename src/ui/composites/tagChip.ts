import { stringToColor } from '../../utils'
import { Chip } from '../primitives/Chip'

export function renderTagChip(parent: HTMLElement, tag: string, colored: boolean, size: 'md' | 'sm' = 'md'): Chip {
  const chip = new Chip(parent).setLabel(tag).setVariant('outline').setTag().setSize(size)
  if (colored) chip.setDot(true).setColor(stringToColor(tag))
  return chip
}

import { stringToColor } from '../../utils'
import { Chip } from '../primitives/Chip'

export interface TagChipOptions {
  size?: 'md' | 'sm'
  /** No border, no box: a dot and a muted word. The board card's tags are the
   *  least important thing on it and were costing a bordered pill each. */
  plain?: boolean
}

export function renderTagChip(parent: HTMLElement, tag: string, colored: boolean, opts: TagChipOptions = {}): Chip {
  const chip = new Chip(parent)
    .setLabel(tag)
    .setVariant(opts.plain ? 'plain' : 'outline')
    .setTag()
    .setSize(opts.size ?? 'md')
  if (colored) chip.setDot(true).setColor(stringToColor(tag))
  return chip
}

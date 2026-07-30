import type PMPlugin from '../main'

/**
 * Minimal motion helpers — no dependencies. Every effect respects both the
 * OS reduced-motion preference and the plugin's "Reduce animations" setting
 * (CSS-side rules are additionally guarded; these helpers just skip work).
 */
export function motionOK(plugin: PMPlugin): boolean {
  if (plugin.settings.reduceAnimations) return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export type RectMap = Map<string, DOMRect>

/** Snapshot the rects of all [data-task-id] elements under root matching selector. */
export function captureRects(root: HTMLElement, selector: string): RectMap {
  const m: RectMap = new Map()
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset.taskId
    if (id) m.set(id, el.getBoundingClientRect())
  }
  return m
}

/**
 * FLIP across a wholesale re-render: call AFTER the new DOM is in place with
 * the rects captured BEFORE. Elements that moved are inverted to their old
 * position and played to rest at 200ms ease-out. New elements are left alone.
 */
export function playFlip(root: HTMLElement, selector: string, first: RectMap): void {
  const moved: HTMLElement[] = []
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset.taskId
    const a = id ? first.get(id) : undefined
    if (!a) continue
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    el.setCssStyles({ transform: `translate(${dx}px, ${dy}px)`, transition: 'none' })
    moved.push(el)
  }
  if (!moved.length) return
  // Double rAF: first frame paints the inverted position, second plays it.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      for (const el of moved) {
        el.setCssStyles({ transition: 'transform 200ms ease-out', transform: '' })
        el.addEventListener(
          'transitionend',
          () => {
            el.setCssStyles({ transition: '' })
          },
          { once: true }
        )
      }
    })
  })
}

/**
 * Tag elements that were absent before a user-initiated refresh with the
 * enter animation class. `beforeIds` = the data-task-ids present pre-render.
 */
export function markEnter(root: HTMLElement, selector: string, beforeIds: Set<string>): void {
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset.taskId
    if (id && !beforeIds.has(id)) el.addClass('gs-enter')
  }
}

import type { EntityId } from '../../core/entity/types'

/** Where on a card its boxes and blocks are, in the card's own px (the layout it was drawn at, before any transform). */
export interface CardAnchors {
  refs: { ref: EntityId; x: number; y: number; w: number; h: number; label: string; value: string }[]
  regions: { block: EntityId; x: number; y: number; w: number; h: number; title: string }[]
}

/** Read a laid-out card's anchors. Offsets, not client rects: the card's own transform does not move them. */
export function measureCard(card: HTMLElement): CardAnchors {
  // Offsets are from the card's padding edge; the card's own px (what its matrix maps) start at its border edge.
  const bx = card.clientLeft, by = card.clientTop
  const at = (el: HTMLElement) => {
    let x = bx, y = by
    let e: HTMLElement | null = el
    while (e && e !== card) {
      x += e.offsetLeft
      y += e.offsetTop
      e = e.offsetParent as HTMLElement | null
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight }
  }
  const refs: CardAnchors['refs'] = []
  for (const el of card.querySelectorAll<HTMLElement>('[data-ref]')) if (el.dataset.ref) refs.push({ ref: el.dataset.ref, ...at(el), label: el.dataset.label ?? '', value: el.dataset.value ?? '' })
  const regions: CardAnchors['regions'] = []
  for (const el of card.querySelectorAll<HTMLElement>('[data-block]')) if (el.dataset.block) regions.push({ block: el.dataset.block, ...at(el), title: el.dataset.title ?? '' })
  return { refs, regions }
}

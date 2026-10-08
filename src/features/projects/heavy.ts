import type { Openable } from './openable'

/**
 * Projects big enough to push a browser tab to its limits, flagged on their card before they are opened. Measured on
 * the WildChat atlas (2.09 million entities and relationships): the tab holds about 1.5 GB once it is open, and
 * drawing all of it in Unigraph peaks at 3.3 GB of Chrome's 4.4 GB — a tab with a little more in it is stopped. The explorer holds such a
 * view back (`memoryGates` in core/graph/budget.ts); the card says so first.
 */
export const HEAVY_ITEMS = 1_000_000
/** Heap per entity or relationship once a project is open, from the same measurement. */
const OPEN_BYTES = 700

/** What the card warns, when the project is that big; undefined otherwise (or when its size is unknown). */
export function heavyWarning(o: Pick<Openable, 'counts'>): { label: string; detail: string } | undefined {
  const items = o.counts ? o.counts.entities + o.counts.relationships : 0
  if (items < HEAVY_ITEMS) return undefined
  const gb = Math.max(0.5, Math.round((items * OPEN_BYTES) / 1e9 * 2) / 2)
  return {
    label: 'Pushes this browser to its limits',
    detail: `${(items / 1e6).toFixed(1)} million entities and relationships: about ${gb} GB of memory once open, on a desktop browser with room to spare. In Unigraph keep a scene's filter on — clearing it asks before drawing everything, which can close the tab. Close other heavy tabs first; not for phones.`,
  }
}

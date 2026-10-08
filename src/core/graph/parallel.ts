/**
 * Parallel-edge bookkeeping shared by the 2D renderer and the SVG writer, so
 * a multi-edge curves the same way on screen and on paper.
 */
export const DEFAULT_EDGE_CURVATURE = 0.25

export interface ParallelInfo {
  /** Symmetric index within the bundle: … -1, 0, 1 … (0 = straight when the bundle has odd size). */
  index: number
  /** Bundle size. */
  count: number
}

/**
 * Index edges sharing an unordered endpoint pair; singletons are omitted. Renderers apply curvature relative to an
 * edge's own direction, so an edge drawn from the higher-sorted end gets its index negated: a pair in opposite
 * directions then bends to opposite sides of the line instead of onto the same one.
 */
export function indexParallelEdges(edges: { id: string; source: { id: string }; target: { id: string } }[]): Map<string, ParallelInfo> {
  const groups = new Map<string, { id: string; flip: boolean }[]>()
  for (const e of edges) {
    const a = e.source.id
    const b = e.target.id
    if (a === b) continue
    const key = a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a])
    const g = groups.get(key)
    const entry = { id: e.id, flip: a > b }
    if (g) g.push(entry)
    else groups.set(key, [entry])
  }
  const out = new Map<string, ParallelInfo>()
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    const offset = (ids.length - 1) / 2
    ids.forEach(({ id, flip }, i) => out.set(id, { index: (i - offset) * (flip ? -1 : 1), count: ids.length }))
  }
  return out
}

/** Curvature for a bundle member; alternates sides and spreads with bundle size. Undefined = straight. */
export function curvatureFor(info: ParallelInfo | undefined, base = DEFAULT_EDGE_CURVATURE): number | undefined {
  if (!info || info.index === 0) return undefined
  return info.index * base * (info.count > 3 ? 0.7 : 1)
}

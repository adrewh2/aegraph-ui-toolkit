import type { EntityId } from '../entity/types'
import type { GraphSlice } from './filter'
import { computeLayout, DEFAULT_LAYOUT_PARAMS, engineOf, finishLayout, mulberry32, pinnedPositions, resolvePositions, type LayoutAlgorithm, type LayoutEngine, type LayoutParams, type Positions, type ResolvedPositions } from './layouts'

/**
 * Layout engines that are not built in — ELK, WebCola, ngraph, the spectral
 * embedding — live in their own chunks and are imported the first time a
 * layout asks for them, from the layout worker. The main bundle never carries
 * them; a workspace that never picks one never downloads one.
 */
export interface EngineInput {
  slice: GraphSlice
  params: LayoutParams
  /** Held positions to refine from, when the engine can. */
  previous?: Positions
  /** Nodes the engine must leave where `previous` has them. */
  fixed: Set<EntityId>
  rnd: () => number
}
export type EngineFn = (algorithm: LayoutAlgorithm, input: EngineInput) => Promise<Positions> | Positions

const loaders: Record<LayoutEngine, () => Promise<{ default: EngineFn }>> = {
  elk: () => import('./engines/elk'),
  cola: () => import('./engines/cola'),
  ngraph: () => import('./engines/ngraph'),
  spectral: () => import('./engines/spectral'),
}
const loaded = new Map<LayoutEngine, Promise<EngineFn>>()
export function loadEngine(engine: LayoutEngine): Promise<EngineFn> {
  let p = loaded.get(engine)
  if (!p) {
    p = loaders[engine]().then((m) => m.default)
    p.catch(() => loaded.delete(engine))
    loaded.set(engine, p)
  }
  return p
}

/** `computeLayout` for every algorithm, engines included. */
export async function computeLayoutAsync(algorithm: LayoutAlgorithm, slice: GraphSlice, params: LayoutParams, previous?: Positions, pinned?: Iterable<EntityId>): Promise<Positions> {
  const engine = engineOf(algorithm)
  if (!engine) return computeLayout(algorithm, slice, params, previous, pinned)
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...params }
  const fixed = pinnedPositions(slice, previous, pinned)
  const fixedSet = new Set(Object.keys(fixed))
  const run = await loadEngine(engine)
  const out = await run(algorithm, { slice, params: p, previous, fixed: fixedSet, rnd: mulberry32(p.seed) })
  return finishLayout(slice, out, p, fixed, fixedSet)
}

/** `resolvePositions` for every algorithm: only the nodes `saved` lacks are laid out, beside the held ones. */
export async function resolvePositionsAsync(slice: GraphSlice, saved: Positions | undefined, fallback: LayoutAlgorithm, params: LayoutParams): Promise<ResolvedPositions> {
  if (!engineOf(fallback)) return resolvePositions(slice, saved, fallback, params)
  if (!saved) return { positions: await computeLayoutAsync(fallback, slice, params), unplaced: 0 }
  const missing = slice.nodes.filter((n) => !saved[n.id])
  if (!missing.length) return resolvePositions(slice, saved, fallback, params)
  // Lay out the missing nodes among themselves, then let the synchronous resolver place that cloud beside the held one.
  const ids = new Set(missing.map((m) => m.id))
  const sub: GraphSlice = { ...slice, nodes: missing, edges: slice.edges.filter((e) => ids.has(e.source.id) && ids.has(e.target.id)) }
  const extra = await computeLayoutAsync(fallback, sub, params)
  const r = resolvePositions(slice, { ...saved, ...extra }, 'grid', params)
  return { positions: r.positions, unplaced: missing.length }
}

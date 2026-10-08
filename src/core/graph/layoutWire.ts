import type { AnyEntity, EntityId, Relationship } from '../entity/types'
import type { GraphSlice } from './filter'
import type { Positions } from './layouts'
import { edgeWeight } from './paths'

/**
 * What crosses to the layout worker and back, as columns: a slice as ids,
 * types and edge ends in typed arrays, positions as ids and one Float64
 * array — not an object per node, which structured clone copies one at a
 * time on both sides (a million nodes was seconds each way). The worker
 * rebuilds the objects the layouts read; the page rebuilds its positions.
 * The buffers are transferred, not copied (`transferables`).
 */
export interface SliceWire {
  ids: EntityId[]
  types: string[]
  /** Degree within the slice, aligned with `ids`. */
  degree: Float64Array
  edgeIds: EntityId[]
  edgeTypes: string[]
  /** Edge ends as indices into `ids`. */
  src: Uint32Array
  dst: Uint32Array
  directed: Uint8Array
  /** The edge weight already looked up (the layouts read it from `data.weight`). */
  weight: Float64Array
  truncated: number
  candidates: number
}

export interface PositionsWire {
  ids: EntityId[]
  /** x, y, z per id. */
  xyz: Float64Array
}

export function packSlice(slice: GraphSlice, weightField?: string): SliceWire {
  const n = slice.nodes.length
  const ids = new Array<EntityId>(n)
  const types = new Array<string>(n)
  const degree = new Float64Array(n)
  const index = new Map<EntityId, number>()
  for (let i = 0; i < n; i++) {
    const e = slice.nodes[i]
    ids[i] = e.id
    types[i] = e.type
    degree[i] = slice.degree.get(e.id) ?? 0
    index.set(e.id, i)
  }
  // One pass, each end looked up once: at 800k nodes and 2M edges a filter first and a lookup after was twice the
  // Map work on the page's thread, before the worker could start.
  const cap = slice.edges.length
  const edgeIds: EntityId[] = []
  const edgeTypes: string[] = []
  const src = new Uint32Array(cap)
  const dst = new Uint32Array(cap)
  const directed = new Uint8Array(cap)
  const weight = new Float64Array(cap)
  let m = 0
  for (const e of slice.edges) {
    const a = index.get(e.source.id)
    if (a === undefined) continue
    const b = index.get(e.target.id)
    if (b === undefined) continue
    edgeIds.push(e.id)
    edgeTypes.push(e.type)
    src[m] = a
    dst[m] = b
    directed[m] = e.directed ? 1 : 0
    weight[m++] = edgeWeight(e, weightField)
  }
  // Trimmed to the edges kept (a copy only when some were dropped): the buffers are transferred whole.
  const trim = <T extends Uint32Array | Uint8Array | Float64Array>(a: T): T => (m === cap ? a : (a.slice(0, m) as T))
  return { ids, types, degree, edgeIds, edgeTypes, src: trim(src), dst: trim(dst), directed: trim(directed), weight: trim(weight), truncated: slice.truncated, candidates: slice.candidates }
}

/** The slice as the layouts read it — ids, types, endpoints, degrees, the weight at `data.weight` — without the entities' data and metadata. */
export function unpackSlice(w: SliceWire): GraphSlice {
  const nodes = new Array<AnyEntity>(w.ids.length)
  const degree = new Map<EntityId, number>()
  for (let i = 0; i < w.ids.length; i++) {
    nodes[i] = { id: w.ids[i], type: w.types[i] } as AnyEntity
    degree.set(w.ids[i], w.degree[i])
  }
  const edges = new Array<Relationship>(w.edgeIds.length)
  for (let i = 0; i < w.edgeIds.length; i++) edges[i] = { id: w.edgeIds[i], type: w.edgeTypes[i], source: { id: w.ids[w.src[i]] }, target: { id: w.ids[w.dst[i]] }, directed: w.directed[i] === 1, data: { weight: w.weight[i] } } as unknown as Relationship
  return { nodes, edges, degree, truncated: w.truncated, candidates: w.candidates }
}

export function packPositions(p: Positions | undefined): PositionsWire | undefined {
  if (!p) return undefined
  const ids: EntityId[] = []
  for (const id in p) ids.push(id)
  const xyz = new Float64Array(ids.length * 3)
  for (let i = 0; i < ids.length; i++) {
    const q = p[ids[i]]
    xyz[i * 3] = q.x
    xyz[i * 3 + 1] = q.y
    xyz[i * 3 + 2] = q.z ?? NaN
  }
  return { ids, xyz }
}

export function unpackPositions(w: PositionsWire | undefined): Positions | undefined {
  if (!w) return undefined
  const out: Positions = {}
  for (let i = 0; i < w.ids.length; i++) {
    const z = w.xyz[i * 3 + 2]
    out[w.ids[i]] = Number.isNaN(z) ? { x: w.xyz[i * 3], y: w.xyz[i * 3 + 1] } : { x: w.xyz[i * 3], y: w.xyz[i * 3 + 1], z }
  }
  return out
}

/** The buffers a message carries, for `postMessage`'s transfer list. */
export function transferables(w: { slice?: SliceWire; positions?: PositionsWire; previous?: PositionsWire; saved?: PositionsWire }): ArrayBufferLike[] {
  const out: ArrayBufferLike[] = []
  if (w.slice) out.push(w.slice.degree.buffer, w.slice.src.buffer, w.slice.dst.buffer, w.slice.directed.buffer, w.slice.weight.buffer)
  for (const p of [w.positions, w.previous, w.saved]) if (p) out.push(p.xyz.buffer)
  return out
}

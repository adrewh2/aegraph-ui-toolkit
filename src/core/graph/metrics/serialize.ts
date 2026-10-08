import type { Relationship } from '../../entity/types'
import type { GraphSlice } from '../filter'
import { edgeWeight } from '../paths'
import type { SerialGraph } from './types'

/**
 * Order-insensitive fingerprint of a slice, for result invalidation: the node ids, and for each edge its id with
 * its ends and direction — a relationship reversed, redirected or made undirected under the same id changes every
 * directed metric, so it changes the key. Weights and types are not in it: the weight field is an option the cache
 * compares on its own, and a type edit changes no metric.
 */
export function sliceKey(slice: Pick<GraphSlice, 'nodes' | 'edges'>): string {
  // Each id hashed on its own (FNV-1a) and the hashes folded with a commutative sum, so the key is independent of
  // iteration order without sorting — a sort of a million ids was most of the cost of this fingerprint.
  const fnv = (s: string, seed: number) => {
    let h = seed
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h
  }
  // Two independent 32-bit sums, so a collision needs two hashes to agree.
  let a = 0
  let b = 0
  const fold = (h: number) => {
    a = (a + h) >>> 0
    b = (b + Math.imul(h, 0x9e3779b1)) >>> 0
  }
  for (const n of slice.nodes) fold(fnv(n.id, 0x811c9dc5))
  for (const e of slice.edges) {
    let h = fnv(e.id, 0x811c9dc5)
    h = fnv(e.source.id, h ^ 0x2c)
    h = fnv(e.target.id, h ^ 0x2c)
    fold(fnv(e.directed ? '1' : '0', h ^ 0x2c) ^ 0x5bd1e995)
  }
  return `${slice.nodes.length}:${slice.edges.length}:${a.toString(16)}${b.toString(16)}`
}

export function serializeSlice(slice: Pick<GraphSlice, 'nodes' | 'edges'>, weightField?: string): SerialGraph {
  const ids = slice.nodes.map((n) => n.id)
  const index = new Map<string, number>()
  ids.forEach((id, i) => index.set(id, i))
  const edges: Relationship[] = []
  for (const e of slice.edges) if (index.has(e.source.id) && index.has(e.target.id)) edges.push(e)
  const src = new Uint32Array(edges.length)
  const dst = new Uint32Array(edges.length)
  const directed = new Uint8Array(edges.length)
  const weight = weightField ? new Float64Array(edges.length) : undefined
  edges.forEach((e, i) => {
    src[i] = index.get(e.source.id)!
    dst[i] = index.get(e.target.id)!
    directed[i] = e.directed ? 1 : 0
    if (weight) weight[i] = edgeWeight(e, weightField)
  })
  return { ids, src, dst, directed, weight }
}

export function transferablesOf(g: SerialGraph): ArrayBuffer[] {
  const out = [g.src.buffer, g.dst.buffer, g.directed.buffer]
  if (g.weight) out.push(g.weight.buffer)
  return out as ArrayBuffer[]
}

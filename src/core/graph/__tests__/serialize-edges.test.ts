import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity, Relationship } from '../../entity/types'
import { clearMetricsCache, getCachedMetrics, putCachedMetrics } from '../metrics/cache'
import { computeMetrics } from '../metrics/compute'
import { serializeSlice, sliceKey, transferablesOf } from '../metrics/serialize'

/**
 * The slice fingerprint and the serial graph at their edges: an empty
 * slice, one node, nodes and edges in another order, an edge added or
 * removed, an edge reversed or redirected under the same id, a relationship
 * whose type or weight changed under the same id, ids with unicode or the
 * separator characters, a hundred thousand nodes hashed twice; the serial
 * graph dropping edges to nodes outside the slice, its direction flags,
 * weights from a field (bad values read as 1), and its transferables.
 */
const node = (id: string) => createEntity({ id, type: 'note' })
const rel = (id: string, a: string, b: string, over: Partial<Relationship> = {}) => ({ ...createRelationship({ id, type: 'r', source: a, target: b }), ...over }) as Relationship
const slice = (nodes: AnyEntity[], edges: Relationship[]) => ({ nodes, edges })

describe('sliceKey edges', () => {
  it('names the counts and a hash; nothing, one node, and the same sets in another order agree', () => {
    expect(sliceKey(slice([], []))).toMatch(/^0:0:[0-9a-f]+$/)
    expect(sliceKey(slice([node('a')], []))).toMatch(/^1:0:[0-9a-f]+$/)
    const ab = rel('ab', 'a', 'b'), bc = rel('bc', 'b', 'c')
    const k = sliceKey(slice([node('a'), node('b'), node('c')], [ab, bc]))
    expect(sliceKey(slice([node('c'), node('a'), node('b')], [bc, ab]))).toBe(k)
    expect(sliceKey(slice([node('a'), node('b'), node('c')], [bc]))).not.toBe(k)
    expect(sliceKey(slice([node('a'), node('b')], [ab, bc]))).not.toBe(k)
    expect(sliceKey(slice([node('a'), node('b'), node('c')], [ab, bc, rel('ca', 'c', 'a')]))).not.toBe(k)
  })

  it('changes when an edge is reversed, redirected or flips between directed and undirected under the same id — the metrics cache must not answer from before', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const before = slice(nodes, [rel('e', 'a', 'b')])
    const reversed = slice(nodes, [rel('e', 'b', 'a')])
    const redirected = slice(nodes, [rel('e', 'a', 'c')])
    const undirected = slice(nodes, [rel('e', 'a', 'b', { directed: false })])
    const keys = [before, reversed, redirected, undirected].map(sliceKey)
    expect(new Set(keys).size).toBe(4)
    clearMetricsCache()
    const opts = { metrics: ['inDegree' as const] }
    putCachedMetrics(computeMetrics(serializeSlice(before), opts, {}, sliceKey(before)))
    expect(getCachedMetrics(sliceKey(before), opts)?.columns.inDegree?.[1]).toBe(1)
    expect(getCachedMetrics(sliceKey(reversed), opts)).toBeUndefined()
    clearMetricsCache()
  })

  it('does not see a relationship type or a weight that changed under the same id — that is what the weightField option and the store version are for', () => {
    const nodes = [node('a'), node('b')]
    const k = sliceKey(slice(nodes, [rel('e', 'a', 'b', { data: { weight: 1 } })]))
    expect(sliceKey(slice(nodes, [rel('e', 'a', 'b', { data: { weight: 5 } })]))).toBe(k)
    expect(sliceKey(slice(nodes, [rel('e', 'a', 'b', { type: 'other' })]))).toBe(k)
  })

  // Real work on real volumes: what it costs is the machine's business, so the harness is given room and the
  // assertions below say what actually has to hold. A bare timeout here would only ever measure the load.
  it('tells ids apart around the separators and across unicode, and hashes a hundred thousand nodes the same twice, quickly', () => {
    expect(sliceKey(slice([node('a|'), node('b')], []))).not.toBe(sliceKey(slice([node('a'), node('|b')], [])))
    expect(sliceKey(slice([node('a,b')], []))).not.toBe(sliceKey(slice([node('a'), node('b')], [])))
    expect(sliceKey(slice([node('ab')], []))).not.toBe(sliceKey(slice([node('a'), node('b')], [])))
    expect(sliceKey(slice([node('a,')], []))).not.toBe(sliceKey(slice([node('a')], [])))
    expect(sliceKey(slice([node('🎉')], []))).not.toBe(sliceKey(slice([node('é')], [])))
    expect(sliceKey(slice([node('🎉')], []))).toBe(sliceKey(slice([node('🎉')], [])))
    // A node id and an edge id do not swap sides.
    expect(sliceKey(slice([node('x')], [rel('y', 'x', 'x')]))).not.toBe(sliceKey(slice([node('y')], [rel('x', 'y', 'y')])))
    const big = Array.from({ length: 100_000 }, (_, i) => node(`n${(i * 7919) % 100_000}`))
    const edges = Array.from({ length: 100_000 }, (_, i) => rel(`e${i}`, `n${i}`, `n${(i + 1) % 100_000}`))
    const t = performance.now()
    const k1 = sliceKey(slice(big, edges))
    const k2 = sliceKey(slice([...big].reverse(), [...edges].reverse()))
    // Alone this is ~300 ms for both; the bound is loose because a loaded machine stretches it several-fold.
    // Two hashes of a hundred thousand nodes. The bound is here to catch an accidental quadratic, not to time
    // the machine: on a laptop running several sessions this has been seen at eleven seconds and still linear.
    expect(performance.now() - t).toBeLessThan(30_000)
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^100000:100000:/)
  }, 30_000)
})

describe('serializeSlice edges', () => {
  it('indexes nodes in slice order, drops edges to nodes outside the slice, flags direction, reads weights with bad values as 1, and offers its buffers', () => {
    const nodes = [node('b'), node('a'), node('c')]
    const edges = [rel('ab', 'a', 'b', { data: { weight: 2.5 } }), rel('bc', 'b', 'c', { directed: false, data: { weight: '3' } }), rel('cx', 'c', 'x'), rel('cc', 'c', 'c', { data: { weight: -1 } }), rel('ca', 'c', 'a', { data: { weight: 'lots' } })]
    const g = serializeSlice(slice(nodes, edges), 'data.weight')
    expect(g.ids).toEqual(['b', 'a', 'c'])
    expect([...g.src]).toEqual([1, 0, 2, 2])
    expect([...g.dst]).toEqual([0, 2, 2, 1])
    expect([...g.directed]).toEqual([1, 0, 1, 1])
    expect([...g.weight!]).toEqual([2.5, 3, 1, 1])
    expect(transferablesOf(g)).toHaveLength(4)
    const plain = serializeSlice(slice(nodes, edges))
    expect(plain.weight).toBeUndefined()
    expect(transferablesOf(plain)).toHaveLength(3)
    const empty = serializeSlice(slice([], []))
    expect(empty.ids).toEqual([])
    expect(empty.src.length).toBe(0)
    // Metrics over the serial graph agree with the slice: c has two in-edges (bc undirected counts, cc the loop).
    const m = computeMetrics(g, { metrics: ['degree'] })
    expect(m.ids).toEqual(['b', 'a', 'c'])
    expect(Object.keys(m.columns)).toEqual(['degree'])
  })
})

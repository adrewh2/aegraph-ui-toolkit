import { describe, expect, it } from 'vitest'
import type { AnyEntity, Relationship } from '../../entity/types'
import type { GraphSlice } from '../filter'
import { computeLayout, multilevelWire } from '../layouts'
import { packSlice, unpackPositions } from '../layoutWire'

/**
 * The multilevel layout's fast path in the layout worker: from the columns straight to a column of positions, the
 * same picture as the object path, pinned nodes kept, no z in 2D, and the object path when overlap removal is on.
 */
function cliqueSlice(k: number, size: number): GraphSlice {
  const nodes: AnyEntity[] = []
  const edges: Relationship[] = []
  const degree = new Map<string, number>()
  for (let i = 0; i < k * size; i++) {
    nodes.push({ id: `n${i}`, type: 't' } as AnyEntity)
    degree.set(`n${i}`, 0)
  }
  const edge = (a: number, b: number) => edges.push({ id: `e${edges.length}`, type: 'r', source: { id: `n${a}` }, target: { id: `n${b}` }, directed: false, data: {} } as unknown as Relationship)
  for (let c = 0; c < k; c++) {
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) edge(c * size + a, c * size + b)
    edge(c * size, ((c + 1) % k) * size + 1)
  }
  // A self-loop, which both paths drop.
  edge(3, 3)
  return { nodes, edges, degree, truncated: 0, candidates: nodes.length }
}

describe('multilevelWire', () => {
  it('draws what the object path draws, in 3D and in 2D', () => {
    const s = cliqueSlice(5, 9)
    for (const dimensions of [3, 2] as const) {
      const viaObjects = computeLayout('multilevel', s, { dimensions } as never)
      const wire = multilevelWire(packSlice(s), { dimensions } as never)!
      expect(wire.ids).toHaveLength(45)
      const viaWire = unpackPositions(wire)!
      for (const id in viaObjects) {
        expect(viaWire[id].x).toBeCloseTo(viaObjects[id].x, 3)
        expect(viaWire[id].y).toBeCloseTo(viaObjects[id].y, 3)
        if (dimensions === 3) expect(viaWire[id].z).toBeCloseTo(viaObjects[id].z!, 3)
        else expect(viaWire[id].z).toBeUndefined()
      }
    }
  })

  it('keeps pinned nodes where they were, and leaves overlap removal in 2D to the object path', () => {
    const s = cliqueSlice(4, 6)
    const previous = { ids: ['n2', 'n7'], xyz: Float64Array.of(500, -500, 25, 1, 2, 3) }
    const out = unpackPositions(multilevelWire(packSlice(s), { dimensions: 3 } as never, previous, ['n2']))!
    expect(out.n2).toEqual({ x: 500, y: -500, z: 25 })
    // n7 has a previous position but is not pinned: it is laid out.
    expect(out.n7).not.toEqual({ x: 1, y: 2, z: 3 })
    expect(multilevelWire(packSlice(s), { dimensions: 2, noverlap: true } as never)).toBeUndefined()
    expect(multilevelWire(packSlice(s), { dimensions: 3, noverlap: true } as never)).toBeDefined()
  })
})

import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { breakdown, DEFAULT_VIEW_BUDGET, drawCost, estimateEdges, estimateNodes, exceedsBudget, heapRoom, memoryBudget, memoryGates, readHeap, shouldGate, suggestTrim, UNMEASURED_BUDGET, viewLoad } from '../budget'
import { applyFilter, emptyFilter } from '../filter'
import '../types'

/** 30 segments, 5 topics; every segment is similar-to 4 others (dense) and on-topic with one topic (sparse). */
function fixture() {
  const s = new EntityStore()
  const segs = Array.from({ length: 30 }, (_, i) => createEntity({ id: `s${i}`, type: 'segment', label: `Segment ${i}` }))
  const topics = Array.from({ length: 5 }, (_, i) => createEntity({ id: `t${i}`, type: 'topic', label: `Topic ${i}` }))
  const rels = []
  for (let i = 0; i < 30; i++) {
    for (let k = 1; k <= 4; k++) rels.push(createRelationship({ id: `sim${i}-${k}`, type: 'similar-to', source: `s${i}`, target: `s${(i + k) % 30}` }))
    rels.push(createRelationship({ id: `top${i}`, type: 'on-topic', source: `s${i}`, target: `t${i % 5}` }))
  }
  s.upsertMany([...segs, ...topics, ...rels])
  return { s, r: new TypeRegistry(s) }
}

describe('view budget', () => {
  const { s, r } = fixture()
  const slice = applyFilter(s, r, emptyFilter())

  it('measures the load from the candidates and edges, and gates only past the budget or the accepted size', () => {
    const load = viewLoad(slice)
    expect(load).toEqual({ nodes: 35, edges: 150 })
    expect(exceedsBudget(load, DEFAULT_VIEW_BUDGET)).toBe(false)
    const small = { nodes: 30, edges: 100 }
    expect(shouldGate(load, small, undefined)).toBe(true)
    expect(shouldGate(load, small, { nodes: 35, edges: 150 })).toBe(false)
    expect(shouldGate(load, small, { nodes: 33, edges: 140 })).toBe(false) // within a tenth
    expect(shouldGate(load, small, { nodes: 20, edges: 60 })).toBe(true)
    // The cap is part of the picture: a capped view is a small view.
    const capped = applyFilter(s, r, { ...emptyFilter(), maxNodes: 10 })
    expect(viewLoad(capped).nodes).toBe(10)
  })

  it('breaks the slice down by type and estimates exactly from the (relationship, source, target) triples', () => {
    const b = breakdown(slice)
    expect(b.nodeTypes).toEqual([
      { type: 'segment', count: 30 },
      { type: 'topic', count: 5 },
    ])
    expect(b.relTypes).toEqual([
      { type: 'similar-to', count: 120 },
      { type: 'on-topic', count: 30 },
    ])
    const all = new Set(['segment', 'topic'])
    expect(estimateEdges(b, all, new Set(['similar-to', 'on-topic']))).toBe(150)
    expect(estimateEdges(b, all, new Set(['on-topic']))).toBe(30)
    // Dropping the topics takes their edges with them, whatever relationship types are kept.
    expect(estimateEdges(b, new Set(['segment']), new Set(['similar-to', 'on-topic']))).toBe(120)
    expect(estimateNodes(b, new Set(['segment']))).toBe(30)
  })

  it('suggests dropping the most numerous relationship types until the edges fit, never all of them', () => {
    const b = breakdown(slice)
    const t = suggestTrim(b, { nodes: 100, edges: 100 })
    expect([...t.relTypes]).toEqual(['on-topic'])
    expect(t.nodeTypes.size).toBe(2)
    expect(t.maxNodes).toBe(100)
    expect([...suggestTrim(b, { nodes: 100, edges: 10 }).relTypes]).toEqual(['on-topic'])
    expect([...suggestTrim(b, { nodes: 100, edges: 1000 }).relTypes]).toEqual(['similar-to', 'on-topic'])
  })
})

describe('the tab’s memory', () => {
  const GB = 1e9
  // The WildChat atlas, measured: 2.0 GB in use once the cleared filter's slice is built, a 4.4 GB limit.
  const atlas = { used: 2.0 * GB, limit: 4.4 * GB }
  const everything = { nodes: 1_000_492, edges: 1_085_768 }

  it('holds back a million-node view the tab cannot spare the memory for, and lets a scene through', () => {
    expect(drawCost(everything)).toBeGreaterThan(heapRoom(atlas))
    expect(memoryGates(everything, atlas)).toBe(true)
    expect(memoryGates({ nodes: 4_167, edges: 15_670 }, atlas)).toBe(false)
  })

  it('never holds back a small view, even on a page already past the ceiling', () => {
    expect(memoryGates({ nodes: 40_000, edges: 150_000 }, { used: 4.3 * GB, limit: 4.4 * GB })).toBe(false)
  })

  it('a view the user accepted on this page stays drawn; one twice the size asks again', () => {
    expect(memoryGates(everything, atlas, everything)).toBe(false)
    expect(memoryGates({ nodes: 2_000_000, edges: 2_200_000 }, atlas, everything)).toBe(true)
  })

  it('suggests a trim that fits, and without a reading falls back to a fixed budget', () => {
    const b = memoryBudget(atlas)
    expect(drawCost({ nodes: b.nodes, edges: b.edges })).toBeLessThanOrEqual(heapRoom(atlas) + 1)
    expect(memoryBudget(undefined)).toEqual(UNMEASURED_BUDGET)
    expect(memoryGates(everything, undefined)).toBe(true)
    expect(memoryGates({ nodes: 400_000, edges: 1_000_000 }, undefined)).toBe(false)
  })

  it('reads Chrome’s heap when it reports one, and nothing otherwise', () => {
    const perf = globalThis.performance as Performance & { memory?: unknown }
    const had = Object.getOwnPropertyDescriptor(perf, 'memory')
    Object.defineProperty(perf, 'memory', { value: { usedJSHeapSize: 1e9, jsHeapSizeLimit: 4e9 }, configurable: true })
    expect(readHeap()).toEqual({ used: 1e9, limit: 4e9 })
    Object.defineProperty(perf, 'memory', { value: undefined, configurable: true })
    expect(readHeap()).toBeUndefined()
    if (had) Object.defineProperty(perf, 'memory', had)
    else delete (perf as { memory?: unknown }).memory
  })
})

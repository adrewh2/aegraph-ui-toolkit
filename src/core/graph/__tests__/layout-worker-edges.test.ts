import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { computeLayoutAsync, loadEngine, resolvePositionsAsync } from '../layoutEngines'
import { computeLayout, DEFAULT_LAYOUT_PARAMS, LAYOUTS, resolvePositions, type Positions } from '../layouts'
import { leanSlice, runLayoutInWorker } from '../runLayoutInWorker'
import { packPositions, packSlice, unpackPositions, unpackSlice } from '../layoutWire'
import type { LayoutRequest, LayoutResponse } from '../layout.worker'
import '../types'

/**
 * The layout worker path at its edges: what the runner posts (a lean
 * slice, the weight field redirected, the job passed through), how it
 * settles on a result, an error message, a worker failure, an abort
 * before the reply, an abort signal already fired, and a worker that
 * answers twice; the engine loader handing out one promise; every engine
 * on no nodes and on one; pins and overlap removal after an engine; and
 * resolving with an engine when nothing, some or everything is held.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 't', label: 'A', data: { big: 'x'.repeat(100) } }),
    createEntity({ id: 'b', type: 'u', label: 'B' }),
    createEntity({ id: 'c', type: 't', label: 'C' }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b', data: { w: 4 } }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c', directed: false }),
  ])
  const r = new TypeRegistry(s)
  return { s, slice: applyFilter(s, r, emptyFilter()) }
}

/** A worker the test drives by hand: what was posted, and a handle to answer or fail. */
function fakeWorker() {
  const posted: LayoutRequest[] = []
  let current: FakeWorker | undefined
  class FakeWorker {
    onmessage: ((ev: { data: LayoutResponse }) => void) | null = null
    onerror: ((e: { message?: string }) => void) | null = null
    terminated = 0
    constructor() {
      current = this
    }
    postMessage(req: LayoutRequest) {
      posted.push(req)
    }
    terminate() {
      this.terminated++
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return { posted, answer: (r: LayoutResponse) => current!.onmessage!({ data: r }), fail: (message?: string) => current!.onerror!({ message }), worker: () => current! }
}

describe('runLayoutInWorker', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts a lean slice with the weight looked up and the field redirected, passes the job through, and settles on the reply', async () => {
    const { slice } = fixture()
    const fw = fakeWorker()
    const previous: Positions = { a: { x: 1, y: 2 } }
    const p = runLayoutInWorker(slice, { op: 'compute', algorithm: 'force', params: { ...DEFAULT_LAYOUT_PARAMS, weightField: 'data.w' }, previous, pinned: ['a'] })
    const req = fw.posted[0]
    expect(req.type).toBe('run')
    expect(req.algorithm).toBe('force')
    expect(req.params.weightField).toBe('data.weight')
    // The slice crosses as columns — ids, types, degrees, edge ends as indices, the weight looked up — no data, no label, no meta.
    expect(req.slice.ids).toEqual(['a', 'b', 'c'])
    expect(req.slice.types).toEqual(['t', 'u', 't'])
    expect([...req.slice.degree]).toEqual(['a', 'b', 'c'].map((id) => slice.degree.get(id)))
    expect(req.slice.edgeIds).toEqual(['ab', 'bc'])
    expect([...req.slice.src]).toEqual([0, 1])
    expect([...req.slice.dst]).toEqual([1, 2])
    expect([...req.slice.weight]).toEqual([4, 1])
    expect([...req.slice.directed]).toEqual([1, 0])
    expect(req).toMatchObject({ op: 'compute', previous: packPositions(previous), pinned: ['a'] })
    fw.answer({ type: 'result', positions: packPositions({ a: { x: 1, y: 2 } })!, unplaced: 0 })
    await expect(p).resolves.toEqual({ positions: { a: { x: 1, y: 2 } }, unplaced: 0 })
    expect(fw.worker().terminated).toBe(1)
    // Without a weight field the redirect is off and every weight is 1.
    const q = runLayoutInWorker(slice, { op: 'resolve', algorithm: 'spectral', params: DEFAULT_LAYOUT_PARAMS, saved: {} })
    expect(fw.posted[1].params.weightField).toBeUndefined()
    expect([...fw.posted[1].slice.weight]).toEqual([1, 1])
    expect(fw.posted[1]).toMatchObject({ op: 'resolve', saved: { ids: [] } })
    fw.answer({ type: 'result', positions: packPositions({})!, unplaced: 3 })
    await expect(q).resolves.toEqual({ positions: {}, unplaced: 3 })
    expect(leanSlice(slice).nodes[0]).toEqual({ id: 'a', type: 't' })
    // The worker's side of the wire reads back what the layouts need, and positions survive the round trip with or without z.
    const lean = unpackSlice(packSlice(slice, 'data.w'))
    expect(lean.edges.map((e) => [e.id, e.source.id, e.target.id, e.directed, e.data.weight])).toEqual([['ab', 'a', 'b', true, 4], ['bc', 'b', 'c', false, 1]])
    expect(lean.degree).toEqual(slice.degree)
    expect(unpackPositions(packPositions({ a: { x: 1, y: 2 }, b: { x: 3, y: 4, z: 5 } }))).toEqual({ a: { x: 1, y: 2 }, b: { x: 3, y: 4, z: 5 } })
    expect(unpackPositions(undefined)).toBeUndefined()
  })

  it('rejects with the engine’s own message, with the worker’s failure or a default, and on abort — terminating each time', async () => {
    const { slice } = fixture()
    const fw = fakeWorker()
    const job = { op: 'compute' as const, algorithm: 'elk-layered' as const, params: DEFAULT_LAYOUT_PARAMS }
    const refused = runLayoutInWorker(slice, job)
    fw.answer({ type: 'error', message: 'Layered (ELK) lays out up to 3,000 nodes; this view has 3,001.' })
    await expect(refused).rejects.toThrow('up to 3,000 nodes')
    expect(fw.worker().terminated).toBe(1)
    const crashed = runLayoutInWorker(slice, job)
    fw.fail('boom')
    await expect(crashed).rejects.toThrow('boom')
    const silent = runLayoutInWorker(slice, job)
    fw.fail(undefined)
    await expect(silent).rejects.toThrow('The layout worker failed.')
    const ac = new AbortController()
    const aborted = runLayoutInWorker(slice, job, ac.signal)
    ac.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError', message: 'Layout cancelled.' })
    expect(fw.worker().terminated).toBe(1)
    // A reply after the abort changes nothing; a second reply after a result changes nothing.
    fw.answer({ type: 'result', positions: packPositions({ a: { x: 0, y: 0 } })!, unplaced: 0 })
    await expect(aborted).rejects.toThrow()
    const twice = runLayoutInWorker(slice, job)
    fw.answer({ type: 'result', positions: packPositions({ a: { x: 5, y: 5 } })!, unplaced: 0 })
    fw.answer({ type: 'error', message: 'late' })
    await expect(twice).resolves.toMatchObject({ positions: { a: { x: 5, y: 5 } } })
  })

  it('rejects at once when the signal was already aborted, without posting a job', async () => {
    const { slice } = fixture()
    const fw = fakeWorker()
    const ac = new AbortController()
    ac.abort()
    const p = runLayoutInWorker(slice, { op: 'compute', algorithm: 'ngraph', params: DEFAULT_LAYOUT_PARAMS }, ac.signal)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(fw.posted).toHaveLength(0)
  })
})

describe('engines through computeLayoutAsync', () => {
  const engines = LAYOUTS.filter((l) => l.engine)

  it('hands out one promise per engine and places nothing for no nodes and one finite point for one', async () => {
    expect(loadEngine('spectral')).toBe(loadEngine('spectral'))
    expect(loadEngine('spectral')).not.toBe(loadEngine('ngraph'))
    const { slice } = fixture()
    const none = { ...slice, nodes: [], edges: [] }
    const one = { ...slice, nodes: [slice.nodes[0]], edges: [] }
    for (const l of engines) {
      for (const dims of l.dims) {
        expect(await computeLayoutAsync(l.id, none, { ...DEFAULT_LAYOUT_PARAMS, dimensions: dims, iterations: 10 }), l.id).toEqual({})
        const p = await computeLayoutAsync(l.id, one, { ...DEFAULT_LAYOUT_PARAMS, dimensions: dims, iterations: 10 })
        expect(Object.keys(p), l.id).toEqual(['a'])
        expect(Number.isFinite(p.a.x) && Number.isFinite(p.a.y), `${l.id} ${dims}D`).toBe(true)
      }
    }
  }, 60000)

  it('keeps a pinned node through an engine and through overlap removal, and only for a node in the slice', async () => {
    const { slice } = fixture()
    const previous = { a: { x: 700, y: 700 }, zz: { x: 1, y: 1 } }
    const out = await computeLayoutAsync('spectral', slice, { ...DEFAULT_LAYOUT_PARAMS, noverlap: true }, previous, ['a', 'zz'])
    expect(out.a).toEqual({ x: 700, y: 700 })
    expect(out).not.toHaveProperty('zz')
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c'])
    // Built-ins take the synchronous path unchanged.
    expect(await computeLayoutAsync('grid', slice, DEFAULT_LAYOUT_PARAMS)).toEqual(computeLayout('grid', slice, DEFAULT_LAYOUT_PARAMS))
  })

  it('resolves with an engine: everything held is a plain resolve, nothing held is a full run, some held lays out the rest beside them', async () => {
    const { slice } = fixture()
    const all = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 0 } }
    expect(await resolvePositionsAsync(slice, all, 'spectral', DEFAULT_LAYOUT_PARAMS)).toEqual(resolvePositions(slice, all, 'spectral', DEFAULT_LAYOUT_PARAMS))
    const full = await resolvePositionsAsync(slice, undefined, 'spectral', DEFAULT_LAYOUT_PARAMS)
    expect(full.unplaced).toBe(0)
    expect(Object.keys(full.positions).sort()).toEqual(['a', 'b', 'c'])
    const some = await resolvePositionsAsync(slice, { a: { x: 0, y: 0 } }, 'ngraph', { ...DEFAULT_LAYOUT_PARAMS, iterations: 20 })
    expect(some.unplaced).toBe(2)
    expect(some.positions.a).toEqual({ x: 0, y: 0 })
    expect(some.positions.b.x).toBeGreaterThan(0) // to the right of the held cloud
    expect(some.positions.c.x).toBeGreaterThan(0)
    expect(await resolvePositionsAsync(slice, { a: { x: 0, y: 0 } }, 'grid', DEFAULT_LAYOUT_PARAMS)).toEqual(resolvePositions(slice, { a: { x: 0, y: 0 } }, 'grid', DEFAULT_LAYOUT_PARAMS))
  }, 30000)
})

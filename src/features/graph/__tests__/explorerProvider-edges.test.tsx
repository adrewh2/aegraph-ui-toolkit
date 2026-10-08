import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import type { LayoutRequest, LayoutResponse } from '../../../core/graph/layout.worker'
import { packPositions } from '../../../core/graph/layoutWire'
import { layoutAlgorithmOf } from '../../../core/graph/layouts'
import '../../../core/resources/types'
import '../../../core/graph/types'
import '../../../core/graph/scene'
import { ExplorerProvider, useExplorer, type ExplorerContextValue, type ExplorerState } from '../explorerState'
import { PositionStore } from '../positionStore'

/**
 * The explorer provider at its edges, mounted for real (react-dom on a
 * container of a few fields — there is no DOM here): positions held for
 * nodes not in the view, an empty view, the per-dimension cache and a
 * dims switch; a run on the main thread keeping pins through a recompute;
 * a run with nothing to place; the worker path — a second run cancelling
 * the first, a node dragged meanwhile, a failed engine, a cancel, the
 * unmount; and selection ops on an empty selection.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const g = globalThis as Record<string, unknown>
g.window = globalThis
g.HTMLIFrameElement = class {}
g.document = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }

function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 't', label: 'A', tags: ['x'] }),
    createEntity({ id: 'b', type: 'u', label: 'B' }),
    createEntity({ id: 'c', type: 't', label: 'C', tags: ['x', 'y'] }),
    createEntity({ id: 'd', type: 'u', label: 'D' }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c' }),
  ])
  return s
}

const container = () => {
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {} }
  return { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, addEventListener() {}, removeEventListener() {} } as unknown as Element
}

/** The provider mounted around a component that hands out the context; `seed` is the state before the first render. */
async function mount(store: EntityStore, seed?: (s: ExplorerState) => ExplorerState) {
  let ctx: ExplorerContextValue | undefined
  function Capture() {
    ctx = useExplorer()
    return null
  }
  const root: Root = createRoot(container())
  await act(async () => {
    root.render(
      <EntityStoreContext.Provider value={store}>
        <ExplorerProvider seed={seed}>
          <Capture />
        </ExplorerProvider>
      </EntityStoreContext.Provider>,
    )
  })
  return {
    get: () => ctx!,
    dispatch: (a: Parameters<ExplorerContextValue['dispatch']>[0]) => act(() => ctx!.dispatch(a)),
    unmount: () => act(() => root.unmount()),
  }
}

/** Every worker the provider makes, in order; each answered or failed by hand. */
function fakeWorkers() {
  const all: FakeWorker[] = []
  class FakeWorker {
    onmessage: ((ev: { data: LayoutResponse }) => void) | null = null
    onerror: ((e: { message?: string }) => void) | null = null
    request?: LayoutRequest
    terminated = 0
    constructor() {
      all.push(this)
    }
    postMessage(req: LayoutRequest) {
      this.request = req
    }
    terminate() {
      this.terminated++
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  // The provider's own dispatch follows the reply a tick later: the act waits for it.
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { all, answer: (i: number, r: LayoutResponse) => act(async () => (all[i].onmessage!({ data: r }), settle())), fail: (i: number, message?: string) => act(async () => (all[i].onerror!({ message }), settle())) }
}

const ids = (p: Record<string, unknown> | PositionStore) => (p instanceof PositionStore ? [...p.entries()].map(([id]) => id) : Object.keys(p)).sort()

describe('explorer provider edges', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('positionsFor: held positions for nodes not in the view are left out, the rest placed beside the held ones; an empty view is nothing, not pending; the cache is per dims and per state', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'grid', positions: PositionStore.from({ a: { x: 1, y: 2 }, ghost: { x: 9, y: 9 } }) }))
    const r2 = h.get().positionsFor(2)
    expect(ids(r2.positions)).toEqual(['a', 'b', 'c', 'd'])
    expect(r2.positions.a).toEqual({ x: 1, y: 2 })
    expect(r2.unplaced).toBe(3)
    expect(r2.pending).toBeFalsy()
    for (const id of ['b', 'c', 'd']) expect(r2.positions[id].x).toBeGreaterThan(1)
    // The same object until the state changes; another dims is another entry.
    expect(h.get().positionsFor(2)).toBe(r2)
    const r3 = h.get().positionsFor(3)
    expect(r3).not.toBe(r2)
    expect(r3.positions.a).toEqual({ x: 1, y: 2 }) // a 2D position read in 3D: no z, and none invented
    await h.dispatch({ type: 'moveNode', id: 'a', position: { x: 5, y: 5 } })
    expect(h.get().positionsFor(2)).not.toBe(r2)
    expect(h.get().positionsFor(2).positions.a).toEqual({ x: 5, y: 5 })
    expect(h.get().state.positions.get('ghost')).toEqual({ x: 9, y: 9 }) // still held, for when it comes back into view
    await h.unmount()

    const e = await mount(new EntityStore())
    expect(e.get().positionsFor(2)).toEqual({ positions: {}, unplaced: 0 })
    expect(e.get().positionsFor(3).pending).toBeFalsy()
    await e.unmount()
  })

  it('runLayout on the main thread: pinned nodes stay put through a recompute under any algorithm, the others are placed, and nothing to place is a no-op', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'force', positions: PositionStore.from({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } }), pinned: ['a'] }))
    await act(() => h.get().runLayout(2))
    let p = h.get().state.positions
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd'])
    expect(p.get('a')).toEqual({ x: 10, y: 20 })
    expect(h.get().state.layoutDirty).toBe(true)
    expect(h.get().state.layoutJob).toBeUndefined()
    // A circle layout with a pin: the pinned node keeps its place, the others are on the circle.
    await h.dispatch({ type: 'setAlgorithm', algorithm: 'circular' })
    await act(() => h.get().runLayout(2))
    p = h.get().state.positions
    expect(p.get('a')).toEqual({ x: 10, y: 20 })
    expect(p.get('b')).not.toEqual({ x: 30, y: 40 })
    // Everything held and only the missing wanted: no job, no change (the same object).
    await act(() => h.get().runLayout(2, 'missing'))
    expect(h.get().state.positions).toBe(p)
    await h.unmount()
    // No nodes at all: no job either.
    const e = await mount(new EntityStore(), (s) => ({ ...s, algorithm: 'elk-layered' }))
    await act(() => e.get().runLayout(2))
    expect(e.get().state.layoutJob).toBeUndefined()
    expect(e.get().state.positions.size).toBe(0)
    await e.unmount()
  })

  it('placeNodes, transformNodes and a loaded hand-made layout select Custom positions; a Run then places only what has none', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'grid', positions: PositionStore.from({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } }) }))
    await act(async () => void h.get().transformNodes(['a'], { translate: { dx: 5, dy: 0 } }))
    expect(h.get().state.algorithm).toBe('custom')
    expect(h.get().state.positions.get('a')).toEqual({ x: 15, y: 20 })
    await act(() => h.get().runLayout(2))
    // Custom positions: the moved node and the held one stay; the two without a position are put beside them.
    expect(h.get().state.positions.get('a')).toEqual({ x: 15, y: 20 })
    expect(h.get().state.positions.get('b')).toEqual({ x: 30, y: 40 })
    expect(ids(h.get().state.positions)).toEqual(['a', 'b', 'c', 'd'])
    await h.dispatch({ type: 'loadLayout', id: 'l1', positions: { a: { x: 1, y: 1 } }, algorithm: layoutAlgorithmOf({ algorithm: 'manual' }) })
    expect(h.get().state.algorithm).toBe('custom')
    expect(layoutAlgorithmOf({ algorithm: 'grid' })).toBe('grid')
    expect(layoutAlgorithmOf({ algorithm: 'multilevel', rule: { kind: 'placement' } })).toBe('custom')
    expect(layoutAlgorithmOf({})).toBeUndefined()
    await h.unmount()
  })

  it('runLayout under a placement rule: an algorithm change or a Run places only what the placement left; recompute forgets the rule and lays everything out', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'grid', positions: PositionStore.from({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } }), layoutRule: { kind: 'placement', selector: { ids: ['a', 'b'] }, spec: { arrangement: 'scatter', x: 'data.x', y: 'data.y', region: { of: 'viewport' } } } }))
    await h.dispatch({ type: 'setAlgorithm', algorithm: 'circular' })
    await act(() => h.get().runLayout(2))
    let p = h.get().state.positions
    // The placed nodes stay; the two the placement did not cover are laid out beside them.
    expect(p.get('a')).toEqual({ x: 10, y: 20 })
    expect(p.get('b')).toEqual({ x: 30, y: 40 })
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd'])
    expect(h.get().state.layoutRule?.kind).toBe('placement')
    // Nothing missing any more: a further Run under the rule changes nothing.
    await act(() => h.get().runLayout(2))
    expect(h.get().state.positions).toBe(p)
    // Recompute: the rule goes and the circle takes every node.
    await act(() => h.get().runLayout(2, 'recompute'))
    p = h.get().state.positions
    expect(h.get().state.layoutRule).toBeUndefined()
    expect(p.get('a')).not.toEqual({ x: 10, y: 20 })
    await h.unmount()
  })

  it('runLayout in the worker: a second run cancels the first (its answer never lands), a node dragged meanwhile keeps its place even where the job moved it, and the notice comes down once', async () => {
    const fw = fakeWorkers()
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'elk-layered', positions: PositionStore.from({ a: { x: 1, y: 1 } }) }))
    expect(h.get().positionsFor(2).pending).toBe(true)
    let first: Promise<void>
    await act(async () => void (first = h.get().runLayout(2)))
    expect(h.get().state.layoutJob).toMatchObject({ nodes: 4 })
    expect(fw.all.length).toBe(1)
    expect(fw.all[0].request).toMatchObject({ op: 'compute', algorithm: 'elk-layered', pinned: [] })
    let second: Promise<void>
    await act(async () => void (second = h.get().runLayout(2, 'missing')))
    expect(fw.all[0].terminated).toBe(1)
    expect(fw.all.length).toBe(2)
    expect(fw.all[1].request).toMatchObject({ op: 'resolve', saved: packPositions({ a: { x: 1, y: 1 } }) })
    await expect(first!).resolves.toBeUndefined()
    expect(h.get().state.layoutJob).toMatchObject({ nodes: 3 }) // the second job's notice
    // A late answer from the first worker is ignored (it was terminated); the user drags a node while the second runs.
    await fw.answer(0, { type: 'result', positions: packPositions({ a: { x: 99, y: 99 }, b: { x: 99, y: 99 } })!, unplaced: 0 })
    expect(h.get().state.positions.asObject()).toEqual({ a: { x: 1, y: 1 } })
    await h.dispatch({ type: 'moveNode', id: 'b', position: { x: 7, y: 7 } })
    // The job's answer covers b too: what the user set while it ran is newer and wins; the rest is the job's.
    await fw.answer(1, { type: 'result', positions: packPositions({ b: { x: 50, y: 50 }, c: { x: 3, y: 3 }, d: { x: 4, y: 4 } })!, unplaced: 2 })
    await second!
    expect(h.get().state.positions.asObject()).toEqual({ a: { x: 1, y: 1 }, b: { x: 7, y: 7 }, c: { x: 3, y: 3 }, d: { x: 4, y: 4 } })
    expect(h.get().state.layoutJob).toBeUndefined()
    expect(h.get().state.layoutDirty).toBe(true)
    expect(h.get().positionsFor(2).pending).toBeFalsy()
    await h.unmount()
  })

  it('runLayout in the worker: an engine that refuses leaves the seed picture with the reason, and the caller sees the same message; the next run clears it', async () => {
    const fw = fakeWorkers()
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'elk-layered' }))
    let run: Promise<string | void>
    await act(async () => void (run = h.get().runLayout(2).catch((e: Error) => e.message)))
    await fw.answer(0, { type: 'error', message: 'Layered (ELK) lays out up to 3,000 nodes; this view has 3,001.' })
    expect(await run!).toContain('up to 3,000 nodes')
    expect(h.get().state.layoutError).toContain('up to 3,000 nodes')
    expect(h.get().state.layoutJob).toBeUndefined()
    expect(h.get().state.positions.asObject()).toEqual({})
    expect(h.get().positionsFor(2).pending).toBe(true) // the page does not retry while the error stands
    // A crash of the worker itself, with no message, reads the same way.
    await act(async () => void (run = h.get().runLayout(2).catch((e: Error) => e.message)))
    expect(h.get().state.layoutError).toBeUndefined()
    await fw.fail(1, undefined)
    expect(await run!).toBe('The layout worker failed.')
    expect(h.get().state.layoutError).toBe('The layout worker failed.')
    await h.unmount()
  })

  it('cancelLayout drops the missing nodes on a grid and ends the notice; a cancel with nothing running is nothing; unmounting terminates the job', async () => {
    const fw = fakeWorkers()
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'elk-layered', positions: PositionStore.from({ a: { x: 1, y: 1 } }) }))
    await act(() => h.get().cancelLayout(2))
    expect(h.get().state.positions.asObject()).toEqual({ a: { x: 1, y: 1 } })
    let run: Promise<void>
    await act(async () => void (run = h.get().runLayout(2)))
    await act(() => h.get().cancelLayout(2))
    expect(fw.all[0].terminated).toBe(1)
    await expect(run!).resolves.toBeUndefined()
    const p = h.get().state.positions
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd'])
    expect(p.get('a')).toEqual({ x: 1, y: 1 })
    expect(h.get().state.layoutJob).toBeUndefined()
    expect(h.get().state.layoutDirty).toBe(true)
    expect(h.get().positionsFor(2).pending).toBeFalsy()
    // A run left going when the explorer unmounts is terminated, and its late answer is nothing.
    await h.dispatch({ type: 'setPositions', positions: {}, dirty: false })
    await act(async () => void (run = h.get().runLayout(2)))
    expect(fw.all.length).toBe(2)
    await h.unmount()
    expect(fw.all[1].terminated).toBe(1)
    await expect(run!).resolves.toBeUndefined()
  })

  it('a saved layout with no positions (an algorithm to run, as the demos open on) is kept and laid out once, not loaded over and over', async () => {
    const store = fixture()
    store.upsertMany([createEntity({ id: 'layout:opening', type: 'layout', label: 'Opening', data: { positions: {}, algorithm: 'grid', dimensions: 3 } })])
    let renders = 0
    let ctx: ExplorerContextValue | undefined
    function Capture() {
      // A loop never ends on its own: past a bound, the render throws and the test fails instead of hanging.
      if (++renders > 50) throw new Error('render loop')
      ctx = useExplorer()
      return null
    }
    const root: Root = createRoot(container(), { onUncaughtError: () => {} })
    await act(async () => {
      root.render(
        <EntityStoreContext.Provider value={store}>
          <ExplorerProvider seed={(s) => ({ ...s, algorithm: 'grid', layoutId: 'layout:opening' })}>
            <Capture />
          </ExplorerProvider>
        </EntityStoreContext.Provider>,
      )
    })
    // Loading its empty set left the store empty, which ran the load again: a render loop, each pass recomputing
    // the layout on the main thread (Force (Unigraph) on the system map demo in 3D: two frames a second).
    expect(renders).toBeLessThan(10)
    expect(ctx!.state.layoutId).toBe('layout:opening')
    expect(ids(ctx!.positionsFor(3).positions)).toEqual(['a', 'b', 'c', 'd'])
    await act(() => root.unmount())
  })

  it('selectOp on an empty selection: all, invert (= all), neighbours and byType (nothing), byTag and an unknown op (unchanged); ids the view lacks are pruned', async () => {
    const h = await mount(fixture())
    const run = async (op: Parameters<ExplorerContextValue['selectOp']>[0]) => {
      let out: string[] = []
      await act(() => void (out = h.get().selectOp(op)))
      return out
    }
    expect(await run({ op: 'neighbours', hops: 2 })).toEqual([])
    expect(await run({ op: 'byType' })).toEqual([])
    expect(await run({ op: 'byTag' })).toEqual([])
    expect(await run({ op: 'bogus' } as never)).toEqual([])
    expect(h.get().state.selectedIds).toEqual([])
    expect(await run({ op: 'invert' })).toEqual(['a', 'b', 'c', 'd'])
    expect(h.get().state.selectedIds).toEqual(['a', 'b', 'c', 'd'])
    expect(h.get().primary).toBe('d')
    expect(await run({ op: 'invert' })).toEqual([])
    expect(await run({ op: 'all' })).toEqual(['a', 'b', 'c', 'd'])
    expect(await run({ op: 'none' })).toEqual([])
    // From one node: its neighbours keep it first (the primary stays), byType and byTag widen to the view.
    await h.dispatch({ type: 'select', ids: ['c'], mode: 'replace' })
    expect(await run({ op: 'neighbours' })).toEqual(['c', 'b'])
    await h.dispatch({ type: 'select', ids: ['c'], mode: 'replace' })
    expect(await run({ op: 'byType' })).toEqual(['a', 'c'])
    await h.dispatch({ type: 'select', ids: ['c'], mode: 'replace' })
    expect(await run({ op: 'byTag' })).toEqual(['a', 'c'])
    // A selection naming a node the view does not have is pruned on the next slice.
    await h.dispatch({ type: 'select', ids: ['c', 'nope'], mode: 'replace' })
    await h.dispatch({ type: 'patchFilter', patch: { types: ['t'] } })
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(h.get().state.selectedIds).toEqual(['c'])
    await h.unmount()
  })
})

describe('moving nodes by hand over a layout nobody held', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('moves the dragged node and leaves every other node where it was drawn', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'force' }))
    // Laid out as it was drawn: shown, but nothing held.
    const shown = h.get().positionsFor(2).positions
    expect(h.get().state.positions.size).toBe(0)
    await h.dispatch({ type: 'moveNodes', positions: { a: { x: 500, y: 500 } }, dims: 2 })
    const after = h.get().positionsFor(2).positions
    expect(after.a).toEqual({ x: 500, y: 500 })
    // The rest are held where they were shown, so no layout places them again somewhere else.
    for (const id of ['b', 'c', 'd']) expect(after[id]).toEqual(shown[id])
    expect(ids(h.get().state.positions)).toEqual(['a', 'b', 'c', 'd'])
    expect(h.get().state.layoutDirty).toBe(true)
    await h.unmount()
  })

  it('leaves a layout landing and a live hand-back alone — they are the whole picture already', async () => {
    const h = await mount(fixture(), (s) => ({ ...s, algorithm: 'force' }))
    h.get().positionsFor(2)
    await h.dispatch({ type: 'moveNodes', positions: { a: { x: 1, y: 1 } }, dirty: true })
    expect(ids(h.get().state.positions)).toEqual(['a'])
    await h.dispatch({ type: 'moveNodes', positions: { b: { x: 2, y: 2 } }, from: 'physics' })
    expect(ids(h.get().state.positions)).toEqual(['a', 'b'])
    await h.unmount()
  })
})

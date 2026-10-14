import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultState, initialState, reducer } from '../explorerState'

describe('explorer reducer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('selects with modes, pins, moves groups and switches tools', () => {
    let s = initialState()
    s = reducer(s, { type: 'select', ids: ['a', 'b'] })
    expect(s.selectedIds).toEqual(['a', 'b'])
    s = reducer(s, { type: 'select', ids: ['a'], mode: 'toggle' })
    expect(s.selectedIds).toEqual(['b'])
    s = reducer(s, { type: 'selectEdge', id: 'r1' })
    expect(s.selectedIds).toEqual([])
    expect(s.selectedEdgeId).toBe('r1')
    s = reducer(s, { type: 'select', ids: ['c'] })
    expect(s.selectedEdgeId).toBeUndefined()
    s = reducer(s, { type: 'pin', ids: ['c', 'c'], on: true })
    expect(s.pinned).toEqual(['c'])
    s = reducer(s, { type: 'moveNodes', positions: { c: { x: 1, y: 2 }, d: { x: 3, y: 4 } } })
    expect(s.positions.get('d')).toEqual({ x: 3, y: 4 })
    expect(s.layoutDirty).toBe(true)
    s = reducer(s, { type: 'setPathFrom', id: 'c' })
    s = reducer(s, { type: 'setTool', tool: 'path' })
    expect(s.pathFrom).toBeUndefined()
    s = reducer(s, { type: 'setHops', hops: 99 })
    expect(s.hops).toBe(6)
    s = reducer(s, { type: 'loadLayout', id: 'L', positions: {}, pinned: ['z'] })
    expect(s.pinned).toEqual(['z'])
    s = reducer(s, { type: 'unloadLayout' })
    expect(s.pinned).toEqual(['z'])
  })

  it('migrates a persisted single selectedId', () => {
    const mem: Record<string, string> = { 'aegraph:explorer:v1': JSON.stringify({ selectedId: 'old', filter: { types: ['t'] }, rendering: { mode: 'tag' } }) }
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v) })
    const s = initialState()
    expect(s.selectedIds).toEqual(['old'])
    expect(s.filter.types).toEqual(['t'])
    expect(s.filter.exclude).toEqual([])
    expect(s.rendering.precedence).toBe('tag')
    expect(s.pinned).toEqual([])
  })
})

describe('explorer sessions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('seeds a new session from the last-used state without its selection or gate answer', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    store.set('aegraph:explorer:v1', JSON.stringify({ filter: { types: ['person'] }, selectedIds: ['a', 'b'], pinned: ['a'], hops: 2, acceptedLoad: { nodes: 50000, edges: 90000 } }))
    // The plain page continues where it left off.
    const plain = initialState()
    expect(plain.selectedIds).toEqual(['a', 'b'])
    expect(plain.acceptedLoad).toEqual({ nodes: 50000, edges: 90000 })
    // A new tab takes the filter and settings, but starts unselected and is asked about a large graph again.
    const fresh = initialState('tab1')
    expect(fresh.filter.types).toEqual(['person'])
    expect(fresh.hops).toBe(2)
    expect(fresh.selectedIds).toEqual([])
    expect(fresh.acceptedLoad).toBeUndefined()
    // Once the tab has state of its own, it continues from that.
    store.set('aegraph:explorer:v1:tab1', JSON.stringify({ selectedIds: ['c'], acceptedLoad: { nodes: 1, edges: 1 } }))
    const again = initialState('tab1')
    expect(again.selectedIds).toEqual(['c'])
    expect(again.acceptedLoad).toEqual({ nodes: 1, edges: 1 })
  })

  it('defaultState is the explorer with nothing carried over — what `?fresh=1` starts a tab from', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    store.set('aegraph:explorer:v1', JSON.stringify({ filter: { types: ['person'] }, filterId: 'filter:people', projectId: 'project:other', sceneId: 'scene:x', algorithm: 'grid', hops: 2 }))
    expect(initialState('tab1').filter.types).toEqual(['person'])
    const d = defaultState()
    expect(d.filter.types ?? []).toEqual([])
    expect(d.filterId).toBeUndefined()
    expect(d.projectId).toBeUndefined()
    expect(d.sceneId).toBeUndefined()
    expect(d.algorithm).toBe('unigraph-force')
    expect(d.hops).toBe(0)
    expect(d.positions.size).toBe(0)
    expect(d.physics).toBe(false)
  })

  it('a live simulation asked for in the address stays pending through a layout load, until physics is switched', () => {
    // `?physics=1` on a scene: the seed marks it pending; loading the scene's layout turns physics off as it always has,
    // but positions keep resolving as the simulation's until the switch is thrown — on or off.
    const pending = { ...defaultState(), livePending: true }
    const loaded = reducer(pending, { type: 'loadLayout', id: 'layout:x', positions: {} })
    expect(loaded.physics).toBe(false)
    expect(loaded.livePending).toBe(true)
    expect(reducer(loaded, { type: 'setPhysics', on: true })).toMatchObject({ physics: true, livePending: false })
    expect(reducer(loaded, { type: 'setPhysics', on: false })).toMatchObject({ physics: false, livePending: false })
  })

  it('a simulation switched on over a placed picture starts warm, and only that run', () => {
    const on = reducer(defaultState(), { type: 'setPhysics', on: true, warm: true })
    expect(on).toMatchObject({ physics: true, physicsWarm: true })
    // Switched off, or on again without the picture being placed, it is a run from scratch.
    expect(reducer(on, { type: 'setPhysics', on: false }).physicsWarm).toBe(false)
    expect(reducer(on, { type: 'setPhysics', on: true }).physicsWarm).toBe(false)
    expect(reducer(defaultState(), { type: 'setPhysics', on: false, warm: true }).physicsWarm).toBe(false)
  })

  it('the switch is a standing choice: a scene, a loaded layout or a Recompute keeps a live simulation on', () => {
    const on = reducer(defaultState(), { type: 'setPhysics', on: true })
    // A layout loaded under it (a scene's) keeps it running, and the run over the loaded picture starts warm.
    const loaded = reducer(on, { type: 'loadLayout', id: 'layout:x', positions: { a: { x: 1, y: 2 } } })
    expect(loaded).toMatchObject({ physics: true, physicsWarm: true, layoutId: 'layout:x' })
    expect(reducer(on, { type: 'recompute' }).physics).toBe(true)
    // Another algorithm the engine runs live keeps it; one it cannot run live turns it off, and a layout of one does too.
    expect(reducer(on, { type: 'setAlgorithm', algorithm: 'unigraph-force' }).physics).toBe(true)
    expect(reducer(on, { type: 'setAlgorithm', algorithm: 'grid' }).physics).toBe(false)
    expect(reducer(on, { type: 'loadLayout', id: 'layout:g', positions: {}, algorithm: 'grid' }).physics).toBe(false)
    // Off stays off: a scene does not switch it on.
    expect(reducer(defaultState(), { type: 'loadLayout', id: 'layout:x', positions: {} }).physics).toBe(false)
  })

  it('a hand-back or a pull read for positions that were replaced since does not land over the new ones', () => {
    const scene = reducer(defaultState(), { type: 'loadLayout', id: 'layout:s', positions: { a: { x: 1, y: 1 } } })
    // The simulation's hand-back for the picture before the scene: dropped; for the scene's own positions: taken.
    const stale = reducer(scene, { type: 'movePacked', ids: ['a'], xyz: new Float32Array([9, 9, 0]), dims: 2, from: 'physics', store: scene.positions.id - 1 })
    expect(stale.positions.get('a')).toEqual({ x: 1, y: 1 })
    const own = reducer(scene, { type: 'movePacked', ids: ['a'], xyz: new Float32Array([2, 2, 0]), dims: 2, from: 'physics', store: scene.positions.id })
    expect(own.positions.get('a')).toEqual({ x: 2, y: 2 })
    // A saved layout's positions pulled for another layout, or once positions are held, change nothing.
    expect(reducer(scene, { type: 'setPositions', positions: { a: { x: 7, y: 7 } }, dirty: false, forLayout: 'layout:old' })).toBe(scene)
    expect(reducer(scene, { type: 'setPositions', positions: { a: { x: 7, y: 7 } }, dirty: false, forLayout: 'layout:s' })).toBe(scene)
    const empty = { ...scene, positions: defaultState().positions }
    expect(reducer(empty, { type: 'setPositions', positions: { a: { x: 7, y: 7 } }, dirty: false, forLayout: 'layout:s' }).positions.get('a')).toEqual({ x: 7, y: 7 })
  })
})

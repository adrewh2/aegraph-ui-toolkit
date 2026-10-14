import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_NODES, emptyFilter } from '../../../core/graph/filter'
import { DEFAULT_RENDERING } from '../../../core/graph/rendering'
import type { MetricsResult } from '../../../core/graph/metrics/types'
import { initialState, reducer } from '../explorerState'
import { PositionStore } from '../positionStore'

/**
 * The explorer reducer at its edges: what marks a filter, layout, style or
 * analysis dirty and what saving or loading one resets; positions merged,
 * replaced, held and dropped; pins through loads and unloads; the layout
 * job's error surviving the right actions and not the wrong ones; the
 * metrics job's stages; the view budget's floor and the accepted load;
 * a project change clearing what is about it; selection identity; and
 * the clamps.
 */
const s0 = () => initialState()
const result = (over: Partial<MetricsResult> = {}): MetricsResult => ({ computedAt: 't', sliceKey: 'k', options: { metrics: ['degree'] }, ids: [], columns: {}, summary: { nodes: 0, edges: 0, density: 0, averageDegree: 0, components: 0, giantComponent: 0, warnings: [], durations: {} }, ...over } as MetricsResult)

describe('explorer reducer edges', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks a filter dirty only when a saved one is loaded, resets on load, clear and save, and accepts a bigger cap as the view it already chose', () => {
    let s = s0()
    s = reducer(s, { type: 'patchFilter', patch: { types: ['a'] } })
    expect(s.filterDirty).toBe(false) // nothing to be dirty against
    s = reducer(s, { type: 'loadFilter', id: 'F', filter: { ...emptyFilter(), types: ['b'] } })
    expect(s).toMatchObject({ filterId: 'F', filterDirty: false, filter: { types: ['b'] } })
    s = reducer(s, { type: 'patchFilter', patch: { text: 'x' } })
    expect(s.filterDirty).toBe(true)
    s = reducer(s, { type: 'markFilterSaved', id: 'F2' })
    expect(s).toMatchObject({ filterId: 'F2', filterDirty: false })
    s = reducer(s, { type: 'setFilter', filter: emptyFilter() })
    expect(s.filterDirty).toBe(true)
    s = reducer(s, { type: 'clearFilter' })
    expect(s).toMatchObject({ filterId: undefined, filterDirty: false, filter: emptyFilter() })
    // Raising the cap is asking to see more: accepted as it comes; lowering it, or the same, is not.
    expect(reducer(s, { type: 'patchFilter', patch: { maxNodes: DEFAULT_MAX_NODES + 1 } }).pendingAccept).toBe(true)
    expect(reducer(s, { type: 'patchFilter', patch: { maxNodes: DEFAULT_MAX_NODES } }).pendingAccept).toBeUndefined()
    expect(reducer(s, { type: 'patchFilter', patch: { maxNodes: 10 } }).pendingAccept).toBeUndefined()
  })

  it('merges moves, replaces on set with the dirtiness as told, and holds pins and the rule through a loaded layout but drops positions on unload', () => {
    let s = s0()
    s = reducer(s, { type: 'moveNode', id: 'a', position: { x: 1, y: 1 } })
    s = reducer(s, { type: 'moveNodes', positions: { b: { x: 2, y: 2 } } })
    expect(Object.keys(s.positions.asObject())).toEqual(['a', 'b'])
    expect(s.layoutDirty).toBe(true)
    s = reducer(s, { type: 'setPositions', positions: { c: { x: 3, y: 3 } } })
    expect(Object.keys(s.positions.asObject())).toEqual(['c']) // replaced, not merged
    expect(s.layoutDirty).toBe(true) // unsaid: as it was
    s = reducer(s, { type: 'setPositions', positions: {}, dirty: false })
    expect(s.layoutDirty).toBe(false)
    s = reducer(s, { type: 'pin', ids: ['p'], on: true })
    s = reducer(s, { type: 'setLayoutRule', rule: { kind: 'placement', spec: { arrangement: 'grid', region: { of: 'viewport', anchor: 'center' } }, selector: {} } as never })
    s = reducer(s, { type: 'loadLayout', id: 'L', positions: { d: { x: 4, y: 4 } }, algorithm: 'grid' })
    expect(s).toMatchObject({ layoutId: 'L', layoutDirty: false, algorithm: 'grid', physics: false, pinned: ['p'], layoutRule: undefined, placementOverlay: undefined })
    expect(Object.keys(s.positions.asObject())).toEqual(['d'])
    const token = s.recomputeToken
    s = reducer(s, { type: 'moveNode', id: 'd', position: { x: 5, y: 5 } })
    expect(s.layoutDirty).toBe(true)
    s = reducer(s, { type: 'markLayoutSaved', id: 'L2' })
    expect(s).toMatchObject({ layoutId: 'L2', layoutDirty: false })
    s = reducer(s, { type: 'unloadLayout' })
    expect(s).toMatchObject({ layoutId: undefined, layoutDirty: false, positions: {}, pinned: ['p'], recomputeToken: token + 1 })
    // Changing the algorithm or its parameters keeps the held positions and the loaded layout: only a run changes them.
    s = reducer(s, { type: 'loadLayout', id: 'L3', positions: { e: { x: 1, y: 1 } }, pinned: [] })
    s = reducer(s, { type: 'setAlgorithm', algorithm: 'circular' })
    s = reducer(s, { type: 'patchParams', patch: { spacing: 3 } })
    expect(s).toMatchObject({ layoutId: 'L3', layoutDirty: false, pinned: [], params: { spacing: 3, seed: 1 } })
    expect(Object.keys(s.positions.asObject())).toEqual(['e'])
    const r = reducer(s, { type: 'recompute' })
    expect(r.recomputeToken).toBe(s.recomputeToken + 1)
    expect(r.positions).toBe(s.positions) // the run that follows replaces them
  })

  it('keeps a layout error until a run starts or a picture lands, and reports the job while it runs', () => {
    let s = s0()
    s = reducer(s, { type: 'layoutStarted', nodes: 5 })
    expect(s.layoutJob?.nodes).toBe(5)
    s = reducer(s, { type: 'layoutFailed', message: 'ELK refused' })
    expect(s).toMatchObject({ layoutJob: undefined, layoutError: 'ELK refused' })
    // Things that are not a new picture leave the error: a selection, a parameter, a filter.
    s = reducer(s, { type: 'select', ids: ['a'] })
    s = reducer(s, { type: 'patchParams', patch: { spacing: 2 } })
    s = reducer(s, { type: 'patchFilter', patch: { text: 'x' } })
    expect(s.layoutError).toBe('ELK refused')
    // A new picture — positions from a run on the main thread, or a saved layout — clears it, as a new job does.
    expect(reducer(s, { type: 'setPositions', positions: { a: { x: 0, y: 0 } }, dirty: true }).layoutError).toBeUndefined()
    expect(reducer(s, { type: 'loadLayout', id: 'L', positions: {} }).layoutError).toBeUndefined()
    expect(reducer(s, { type: 'layoutStarted', nodes: 1 }).layoutError).toBeUndefined()
    s = reducer(s, { type: 'clearLayoutError' })
    expect(s.layoutError).toBeUndefined()
    expect(reducer(s, { type: 'clearLayoutError' })).toBe(s)
    expect(reducer(s, { type: 'layoutFinished' }).layoutJob).toBeUndefined()
  })

  it('runs the metrics job through its stages, keeps the last result on a failure, and ties a loaded analysis to what came after', () => {
    let s = s0()
    expect(reducer(s, { type: 'metricsProgress', stage: 'pagerank', done: 1, total: 2 })).toBe(s) // no job: nothing to report on
    s = reducer(s, { type: 'metricsStarted' })
    expect(s.metricsJob).toMatchObject({ stage: 'build', done: 0, total: 1 })
    s = reducer(s, { type: 'metricsProgress', stage: 'pagerank', done: 1, total: 2 })
    expect(s.metricsJob).toMatchObject({ stage: 'pagerank', done: 1, total: 2 })
    s = reducer(s, { type: 'metricsDone', result: result({ options: { metrics: ['pagerank'] } }) })
    expect(s).toMatchObject({ metricsJob: undefined, analysisDirty: false, analysisOptions: { metrics: ['pagerank'] } })
    s = reducer(s, { type: 'metricsStarted' })
    s = reducer(s, { type: 'metricsFailed', message: 'boom' })
    expect(s.metrics?.options.metrics).toEqual(['pagerank']) // the last result stays
    expect(s.metricsError).toBe('boom')
    s = reducer(s, { type: 'metricsStarted' })
    expect(s.metricsError).toBeUndefined()
    s = reducer(s, { type: 'metricsCancelled' })
    expect(s.metricsJob).toBeUndefined()
    s = reducer(s, { type: 'loadAnalysis', id: 'A', result: result({ sliceKey: 'saved' }) })
    expect(s).toMatchObject({ analysisId: 'A', analysisDirty: false, metrics: { sliceKey: 'saved' } })
    s = reducer(s, { type: 'metricsDone', result: result({ sliceKey: 'fresh' }) })
    expect(s.analysisDirty).toBe(true) // a run over a loaded analysis makes it dirty
    s = reducer(s, { type: 'markAnalysisSaved', id: 'A2' })
    expect(s).toMatchObject({ analysisId: 'A2', analysisDirty: false })
    s = reducer(s, { type: 'clearMetrics' })
    expect(s).toMatchObject({ metrics: undefined, analysisId: undefined, analysisDirty: false, metricsError: undefined })
    expect(reducer(s, { type: 'setAnalysisAuto', on: false })).toBe(s)
    expect(reducer(s, { type: 'setAnalysisAuto', on: true }).analysisAuto).toBe(true)
  })

  it('floors the view budget, records an accepted load or a pending one, and revokes', () => {
    let s = s0()
    s = reducer(s, { type: 'setViewBudget', budget: { nodes: 5, edges: 250.7 } })
    expect(s.viewBudget).toEqual({ nodes: 100, edges: 250 })
    s = reducer(s, { type: 'acceptLoad' })
    expect(s.pendingAccept).toBe(true)
    expect(s.acceptedLoad).toBeUndefined()
    s = reducer(s, { type: 'acceptLoad', load: { nodes: 4000, edges: 1 } })
    expect(s).toMatchObject({ pendingAccept: false, acceptedLoad: { nodes: 4000, edges: 1 } })
    s = reducer(s, { type: 'revokeLoad' })
    expect(s).toMatchObject({ pendingAccept: false, acceptedLoad: undefined })
  })

  it('clears what is about the old project on a project change and nothing else, and is the same state for the same project', () => {
    let s = s0()
    s = reducer(s, { type: 'select', ids: ['a'] })
    s = reducer(s, { type: 'setPathFrom', id: 'a' })
    s = reducer(s, { type: 'moveNode', id: 'a', position: { x: 1, y: 1 } })
    s = reducer(s, { type: 'loadFilter', id: 'F', filter: emptyFilter() })
    expect(reducer(s, { type: 'loadProject', id: undefined })).toBe(s)
    const p = reducer(s, { type: 'loadProject', id: 'P' })
    expect(p).toMatchObject({ projectId: 'P', selectedIds: [], pathFrom: undefined, path: undefined, selectedEdgeId: undefined, filterId: 'F' })
    expect(p.positions).toBe(s.positions) // held positions travel; nodes not in the project simply are not drawn
    expect(reducer(p, { type: 'loadProject', id: 'P' })).toBe(p)
    expect(reducer(p, { type: 'loadProject', id: undefined }).projectId).toBeUndefined()
  })

  it('returns the same state when nothing changes, clears an edge pick on a node pick and the reverse, and clamps hops', () => {
    let s = s0()
    expect(reducer(s, { type: 'select', ids: [] })).toBe(s)
    s = reducer(s, { type: 'select', ids: ['a', 'b'] })
    expect(reducer(s, { type: 'select', ids: ['a', 'b'] })).toBe(s)
    expect(reducer(s, { type: 'select', ids: ['b', 'a'] })).not.toBe(s) // order is the selection's: the last is primary
    expect(reducer(s, { type: 'hover', id: undefined })).toBe(s)
    expect(reducer(s, { type: 'setTool', tool: 'pan' })).toBe(s)
    expect(reducer(s, { type: 'setLegend', on: s.showLegend })).toBe(s)
    expect(reducer(s, { type: 'showPlacementOverlay', on: s.showPlacementOverlay })).toBe(s)
    s = reducer(s, { type: 'selectEdge', id: 'e' })
    expect(s).toMatchObject({ selectedEdgeId: 'e', selectedIds: [] })
    expect(reducer(s, { type: 'selectEdge', id: 'e' })).toBe(s)
    s = reducer(s, { type: 'selectEdge', id: undefined })
    expect(s.selectedEdgeId).toBeUndefined()
    s = reducer(s, { type: 'selectEdge', id: 'e' })
    s = reducer(s, { type: 'select', ids: [], mode: 'replace' })
    expect(s.selectedEdgeId).toBeUndefined() // an empty node pick still clears the edge
    for (const [hops, want] of [[-3, 0], [2.9, 2], [NaN, 0], [7, 6]] as const) expect(reducer(s, { type: 'setHops', hops }).hops).toBe(want)
    expect(reducer(s, { type: 'setPinned', ids: ['a', 'a', 'b'] }).pinned).toEqual(['a', 'b'])
    expect(reducer(reducer(s, { type: 'setPinned', ids: ['a'] }), { type: 'pin', ids: ['zz'], on: false }).pinned).toEqual(['a'])
    s = reducer(s, { type: 'setPath', path: { from: 'a', to: 'b', nodes: ['a', 'b'], edges: [] } as never })
    expect(s.pathFrom).toBeUndefined()
    expect(reducer(s, { type: 'toggleEdges' }).showEdges).toBe(!s.showEdges)
  })

  it('marks a style dirty only over a loaded one, and a saved scene is only an id', () => {
    let s = s0()
    s = reducer(s, { type: 'setRule', scope: 'nodes', by: 'types', key: 'paper', patch: { sizeScale: 2 } })
    expect(s.renderingDirty).toBe(false)
    s = reducer(s, { type: 'loadRendering', id: 'R', rendering: DEFAULT_RENDERING })
    s = reducer(s, { type: 'patchRendering', patch: { edgeLabels: true } })
    expect(s).toMatchObject({ renderingId: 'R', renderingDirty: true, rendering: { edgeLabels: true } })
    s = reducer(s, { type: 'markRenderingSaved', id: 'R' })
    expect(s.renderingDirty).toBe(false)
    s = reducer(s, { type: 'setScene', id: 'S' })
    s = reducer(s, { type: 'clearRendering' })
    expect(s).toMatchObject({ renderingId: undefined, renderingDirty: false, rendering: DEFAULT_RENDERING, sceneId: 'S' }) // the scene id is not touched by its parts
  })
})

describe('the default layout', () => {
  const mem = new Map<string, string>()
  afterEach(() => vi.unstubAllGlobals())
  it('is Force (Unigraph); a saved state still on ForceAtlas2 moves over once, and a later choice of it stays', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
    expect(initialState().algorithm).toBe('unigraph-force')
    mem.set('aegraph:explorer:v1', JSON.stringify({ algorithm: 'force' }))
    expect(initialState().algorithm).toBe('unigraph-force')
    // The move is written back: the next load reads Force (Unigraph).
    expect(JSON.parse(mem.get('aegraph:explorer:v1')!).algorithm).toBe('unigraph-force')
    expect(initialState().algorithm).toBe('unigraph-force')
    // Chosen again after the move: it sticks.
    mem.set('aegraph:explorer:v1', JSON.stringify({ algorithm: 'force' }))
    expect(initialState().algorithm).toBe('force')
  })
})

describe('a restore', () => {
  it('lands its positions with the end of the restore, in one step, held as unsaved', () => {
    const s = { ...initialState(), restoring: 2 }
    const r = reducer(s, { type: 'restored', positions: PositionStore.fromPacked({ ids: ['a', 'b'], xyz: new Float32Array([1, 2, 0, 3, 4, 0]), dims: 2 }) })
    expect(r.restoring).toBeUndefined()
    expect(r.positions.size).toBe(2)
    expect(r.layoutDirty).toBe(true)
    // Nothing to restore: the view just stops waiting.
    expect(reducer(s, { type: 'restored' }).restoring).toBeUndefined()
    expect(reducer(s, { type: 'restored' }).positions.size).toBe(0)
  })
})

describe('the pointer tools', () => {
  it('read a saved tool as the hand, the box or the path — an old `select`, from before the box tool, is the hand', async () => {
    const { explorerTool } = await import('../explorerTool')
    expect(explorerTool('select')).toBe('pan')
    expect(explorerTool(undefined)).toBe('pan')
    expect(explorerTool('box')).toBe('box')
    expect(explorerTool('path')).toBe('path')
    const s = s0()
    expect(reducer(s, { type: 'setTool', tool: 'box' }).tool).toBe('box')
    expect(reducer({ ...s, tool: 'path', pathFrom: 'a' }, { type: 'setTool', tool: 'box' })).toMatchObject({ tool: 'box', pathFrom: undefined })
  })
})

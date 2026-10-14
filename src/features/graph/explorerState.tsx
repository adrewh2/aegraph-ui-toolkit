import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react'
import { measure } from '../../lib/measure'
import { useEntityStore, useOntologyVersion, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityStore, StoreEvent } from '../../core/entity/store'
import { getEntityType } from '../../core/entity/schema'
import { SCHEMA_TYPE } from '../../core/entity/categories'
import { useDatasetVersion } from '../scripts/snapshot'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { applyFilter, emptyFilter, filterComputedRefs, type FilterContext, type FilterSpec, type GraphSlice, DEFAULT_MAX_NODES } from '../../core/graph/filter'
import { canRunLive, computeLayout, DEFAULT_LAYOUT_PARAMS, isHeavyLayout, layoutTooBig, removeOverlap as removeOverlapLayout, resolvePositions, type Dimensions, type LayoutAlgorithm, type LayoutParams, type Positions } from '../../core/graph/layouts'
import { type LayoutJob, runLayoutInWorker } from '../../core/graph/runLayoutInWorker'
import { explorerTool } from './explorerTool'
import { DEFAULT_VIEW_BUDGET, memoryBudget, memoryGates, readHeap, shouldGate, viewLoad, type GateReason, type HeapReading, type ViewBudget, type ViewLoad } from '../../core/graph/budget'
import { DEFAULT_METRICS, indexOf as metricIndexOf, serializeSlice, sliceKey as sliceKeyOf, type MetricsOptions, type MetricsResult } from '../../core/graph/metrics'
import { runMetricsInWorker } from '../../core/graph/metrics/runInWorker'
import { shortestPath, type PathOptions } from '../../core/graph/paths'
import { place, transform, type Frame, type LayoutRule, type PlaceResult, type PlacementSpec, type Rect, type TransformOp } from '../../core/graph/placement'
import { describePipeline, type Pipeline } from '../../core/graph/pipeline'
import { isProject, projectBreadcrumb, projectMembers, projectOverlay } from '../../core/graph/project'
import { DEFAULT_RENDERING, legendFor, typeColorFor, resolveEdgeStyle, resolveNodeStyles, setRule, styleContext, toRenderingSpec, type EdgeRule, type EdgeStyle, type Legend, type NodeRule, type NodeStyle, type RenderingSpec } from '../../core/graph/rendering'
import { applySelect, pruneSelection, selectionOp, type SelectionOp, type SelectMode } from '../../core/graph/selection'
import { resolveSelector, type Selector, type SelectorResult } from '../../core/graph/selector'
import type { LayoutData, Position } from '../../core/graph/types'
import { DegreeIndex, makeValueContext, type ValueContext } from '../../core/graph/values'
import type { PathState } from './explorerHandle'
import { slidesViewOf, type SlidesView } from '../../core/graph/scene'
import { edgeColor } from './style'
import { POSITIONS_KEY, readHeldPositionsPacked, readHeldPositionsSync, saveHeldPositions } from './heldPositions'
import { PHYSICS_TAG, PositionStore } from './positionStore'
import { useViewActive } from '../workstation/paneContext'

/**
 * Explorer state shared by the 2D and 3D views. Filter and layout are
 * independent axes: loading a saved filter changes what's in view, loading a
 * saved layout changes where things are — either can change without the
 * other. Positions are *held* (not derived) so drags and force runs stick,
 * and nodes that enter the view get placed by the current algorithm.
 */

export interface ExplorerState {
  filter: FilterSpec
  /** Saved filter currently loaded, if any. */
  filterId?: EntityId
  filterDirty: boolean
  algorithm: LayoutAlgorithm
  params: Omit<LayoutParams, 'dimensions'>
  /** Saved layout currently loaded, if any. */
  layoutId?: EntityId
  layoutDirty: boolean
  /** Held positions (may include nodes not currently visible). */
  /** The session's working layout. A scene or saved layout is the committed copy; this is what a drag changes. */
  positions: PositionStore
  /** Held positions of a big view are being read back from IndexedDB (this many): no layout starts meanwhile. */
  restoring?: number
  /** Ask the renderer to recompute positions from `algorithm` on next slice. */
  recomputeToken: number
  /** Display rules — the third axis. */
  rendering: RenderingSpec
  renderingId?: EntityId
  renderingDirty: boolean
  /** Saved scene (filter + layout + style) currently loaded, if any. */
  sceneId?: EntityId
  /** Ordered selection; the last id is the primary node the inspector shows. */
  selectedIds: EntityId[]
  /** A relationship picked on the canvas (edge click). */
  selectedEdgeId?: EntityId
  hoveredId?: EntityId
  /** Nodes held in place by force layouts / live physics. */
  pinned: EntityId[]
  tool: 'pan' | 'box' | 'path'
  pathOptions: PathOptions
  /** First endpoint clicked in path mode. */
  pathFrom?: EntityId
  path?: PathState
  /** Highlight this many hops around the selection (0 = direct neighbours only). */
  hops: number
  labels: 'auto' | 'all' | 'none'
  showEdges: boolean
  /**
   * The live simulation is switched on (Physics in the toolbar, Keep running in the Layout tab). A standing choice,
   * remembered with the tab: it cools and rests, and stays on so that a drag, a scene, a loaded layout or new data
   * warms it again — only the switch, or an algorithm the engine cannot run live, turns it off.
   */
  physics: boolean
  /**
   * The address asked for the live simulation (`?physics=1`) and it has not been switched on yet: until it is, positions
   * resolve as the simulation's (no layout on the main thread for a picture it is about to replace). Set by the tab's
   * seed, cleared by `setPhysics`; never persisted.
   */
  livePending?: boolean
  /**
   * The simulation was switched on over a picture whose every node is already placed (a scene opened with its saved
   * positions): it starts cool and only settles them, instead of flinging a finished picture apart and re-forming it.
   * Set by `setPhysics` with `warm`, by a layout loaded under a running simulation and by a restore; never persisted.
   */
  physicsWarm?: boolean
  /** Last computed metrics (never persisted to localStorage; may be stale for the current slice). */
  metrics?: MetricsResult
  metricsJob?: { stage: string; done: number; total: number; startedAt: number }
  metricsError?: string
  /** A layout being computed off the main thread (big force layouts); the view shows seed positions meanwhile. */
  layoutJob?: { nodes: number; startedAt: number }
  /** Why the last layout run gave no positions (an engine refused or failed); cleared by the next run. */
  layoutError?: string
  /** Saved analysis currently loaded, if any. */
  analysisId?: EntityId
  analysisDirty: boolean
  /** Re-run the analysis whenever the view changes. */
  analysisAuto: boolean
  /** What the auto/next run computes. */
  analysisOptions: MetricsOptions
  showLegend: boolean
  /** The slide layer over the 3D view: whether it is drawn, which decks (all when absent), the slide in front. */
  slides: SlidesView
  /** Whether camera moves (to a picked row, a fit, a tool's viewport) glide or jump. */
  animateCamera: boolean
  /** Loaded project: the Dataset stage is its members (else the whole workspace). */
  projectId?: EntityId
  /** How the held positions were derived, when they came from a placement; can be re-derived. */
  layoutRule?: LayoutRule
  /** Region/cells/axes of the last placement, for the 2D overlay (not persisted). */
  placementOverlay?: { region: Rect; cells?: PlaceResult['cells']; axes: PlaceResult['axes'] }
  showPlacementOverlay: boolean
  /** How much the explorer draws without asking; a bigger view is gated (see `core/graph/budget`). */
  viewBudget: ViewBudget
  /** The last over-budget view the user chose to draw anyway; a like-sized one is not asked about again. */
  acceptedLoad?: ViewLoad
  /** The same, accepted on this page — never saved: past what memory allows, only a choice made since the last load counts (`memoryGates`). */
  memoryAccepted?: ViewLoad
  /** Accept the view as it comes out of the filter change just dispatched (not persisted). */
  pendingAccept?: boolean
}

type Action =
  | { type: 'setFilter'; filter: FilterSpec }
  | { type: 'patchFilter'; patch: Partial<FilterSpec> }
  | { type: 'loadFilter'; id: EntityId; filter: FilterSpec }
  | { type: 'clearFilter' }
  | { type: 'markFilterSaved'; id: EntityId }
  | { type: 'setAlgorithm'; algorithm: LayoutAlgorithm }
  | { type: 'patchParams'; patch: Partial<Omit<LayoutParams, 'dimensions'>> }
  | { type: 'setPositions'; positions: Positions; dirty?: boolean; forLayout?: EntityId }
  | { type: 'restored'; positions?: PositionStore }
  | { type: 'moveNode'; id: EntityId; position: Position }
  | { type: 'moveNodes'; positions: Positions; dirty?: boolean; from?: 'physics'; /** The view the move was made in: whose positions on screen are held first (see `dispatchHeld`). */ dims?: Dimensions }
  /** Many nodes in the packed form (`PositionStore.movedPacked`): a live simulation's hand-back. */
  | { type: 'movePacked'; ids: readonly EntityId[]; xyz: Float32Array | Float64Array; dims: 2 | 3; from?: 'physics'; store?: number }
  | { type: 'loadLayout'; id: EntityId; positions: Positions; algorithm?: LayoutAlgorithm; pinned?: EntityId[]; rule?: LayoutRule }
  | { type: 'unloadLayout' }
  | { type: 'markLayoutSaved'; id: EntityId }
  | { type: 'recompute' }
  | { type: 'setRendering'; rendering: RenderingSpec }
  | { type: 'patchRendering'; patch: Partial<RenderingSpec> }
  | { type: 'setRule'; scope: 'nodes' | 'edges'; by: 'types' | 'tags'; key: string; patch: NodeRule | EdgeRule | null }
  | { type: 'loadRendering'; id: EntityId; rendering: RenderingSpec }
  | { type: 'clearRendering' }
  | { type: 'markRenderingSaved'; id: EntityId }
  | { type: 'setScene'; id?: EntityId }
  | { type: 'select'; ids: EntityId[]; mode?: SelectMode }
  | { type: 'selectEdge'; id?: EntityId }
  | { type: 'hover'; id?: EntityId }
  | { type: 'setPinned'; ids: EntityId[] }
  | { type: 'pin'; ids: EntityId[]; on: boolean }
  | { type: 'setTool'; tool: 'pan' | 'box' | 'path' }
  | { type: 'setPathOptions'; patch: Partial<PathOptions> }
  | { type: 'setPathFrom'; id?: EntityId }
  | { type: 'setPath'; path?: PathState }
  | { type: 'setHops'; hops: number }
  | { type: 'metricsStarted' }
  | { type: 'metricsProgress'; stage: string; done: number; total: number }
  | { type: 'metricsDone'; result: MetricsResult }
  | { type: 'metricsFailed'; message: string }
  | { type: 'metricsCancelled' }
  | { type: 'layoutStarted'; nodes: number }
  | { type: 'layoutFinished' }
  | { type: 'layoutFailed'; message: string }
  | { type: 'clearLayoutError' }
  | { type: 'setViewBudget'; budget: ViewBudget }
  /** Without `load`: accept whatever the next slice turns out to be (a gate applying its filter). */
  | { type: 'acceptLoad'; load?: ViewLoad }
  | { type: 'revokeLoad' }
  | { type: 'clearMetrics' }
  | { type: 'loadAnalysis'; id: EntityId; result: MetricsResult }
  | { type: 'markAnalysisSaved'; id: EntityId }
  | { type: 'setLegend'; on: boolean }
  | { type: 'setSlides'; patch: Partial<SlidesView> }
  | { type: 'setAnimateCamera'; on: boolean }
  | { type: 'setAnalysisAuto'; on: boolean }
  | { type: 'setAnalysisOptions'; options: MetricsOptions }
  | { type: 'loadProject'; id?: EntityId }
  | { type: 'setLayoutRule'; rule?: LayoutRule }
  | { type: 'setPlacementOverlay'; overlay?: ExplorerState['placementOverlay'] }
  | { type: 'showPlacementOverlay'; on: boolean }
  | { type: 'setLabels'; labels: ExplorerState['labels'] }
  | { type: 'toggleEdges' }
  | { type: 'setPhysics'; on: boolean; warm?: boolean }

const STORAGE_KEY = 'aegraph:explorer:v1'
const EMPTY_IDS = new Set<EntityId>()
/** Held positions live in their own key so a page reload (or a Vite HMR remount) doesn't throw away an unsaved position layout. */
/** How long the held positions wait after the last move before they are written. */
const SAVE_DEBOUNCE_MS = 800
/** …and the longest they wait while a live simulation keeps moving them (it would otherwise write on every hand-back). */
const LIVE_SAVE_MS = 10_000

/**
 * A session is one explorer tab: its own filter, layout, selection and held
 * positions, kept under its own keys. Without one (the plain page) the
 * unscoped keys are used; a new session starts from whatever the unscoped
 * keys hold — the last-used filter, layout and style, so a fresh tab does
 * not open empty — but not the last tab's selection, nor its answer to the
 * large-graph gate: a new tab is asked again before it draws a huge graph.
 */
const scoped = (key: string, session: string | undefined) => (session ? `${key}:${session}` : key)
function readScoped(key: string, session: string | undefined): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(scoped(key, session)) ?? (session ? localStorage.getItem(key) : null)
}

/** Held positions from storage, or a note that IndexedDB holds them (a big view): the provider then reads them. */
function restoreHeldPositions(layoutId: EntityId | undefined, layoutDirty: boolean | undefined, session?: string): { positions: PositionStore; restoring?: number } {
  // A clean saved layout reloads from its entity; only unsaved (dirty or ad-hoc) positions come from storage.
  if (layoutId && !layoutDirty) return { positions: PositionStore.empty() }
  const r = readHeldPositionsSync(readScoped(POSITIONS_KEY, session))
  if (!r) return { positions: PositionStore.empty() }
  if ('pending' in r) return { positions: PositionStore.empty(), restoring: r.pending }
  return { positions: PositionStore.from(r.positions) }
}

/** The explorer's defaults: no filter, project, style, layout or scene — what a first tab starts from, and `?fresh=1`. */
export function defaultState(): ExplorerState {
  return {
    filter: emptyFilter(),
    filterDirty: false,
    // Unigraph's own force model: live on the GPU, any size, and at least as good as ForceAtlas2 on most graphs.
    algorithm: 'unigraph-force',
    params: { spacing: DEFAULT_LAYOUT_PARAMS.spacing, iterations: DEFAULT_LAYOUT_PARAMS.iterations, direction: 'TB', seed: 1 },
    layoutDirty: false,
    positions: PositionStore.empty(),
    recomputeToken: 1,
    rendering: DEFAULT_RENDERING,
    renderingDirty: false,
    selectedIds: [],
    pinned: [],
    tool: 'pan',
    pathOptions: { directed: false, weighted: false },
    hops: 0,
    labels: 'auto',
    showEdges: true,
    physics: false,
    analysisDirty: false,
    analysisAuto: false,
    analysisOptions: { metrics: DEFAULT_METRICS },
    showLegend: true,
    slides: { show: true },
    animateCamera: true,
    showPlacementOverlay: false,
    viewBudget: DEFAULT_VIEW_BUDGET,
  }
}

export function initialState(session?: string): ExplorerState {
  const base = defaultState()
  try {
    const raw = readScoped(STORAGE_KEY, session)
    if (raw) {
      // A session with nothing of its own yet is seeded from the last-used state: a template, not a continuation.
      const seeded = !!session && localStorage.getItem(scoped(STORAGE_KEY, session)) === null
      const saved = JSON.parse(raw) as Partial<ExplorerState> & { selectedId?: EntityId }
      const { selectedId, ...rest } = saved
      // ForceAtlas2 (`force`) was the default before Force (Unigraph): a saved state still on it moves over once — it
      // was most likely never chosen — and after that a choice of ForceAtlas2 stays.
      const moved = `${scoped(STORAGE_KEY, session)}:unigraph-default`
      try {
        if (rest.algorithm === 'force' && !localStorage.getItem(moved)) {
          rest.algorithm = 'unigraph-force'
          // Written back now: the next load must not read ForceAtlas2 again with the move already marked done.
          localStorage.setItem(scoped(STORAGE_KEY, session), JSON.stringify({ ...saved, algorithm: 'unigraph-force' }))
        }
        localStorage.setItem(moved, '1')
      } catch {
        /* no storage: the saved choice stands */
      }
      return {
        ...base,
        ...rest,
        filter: { ...emptyFilter(), ...(saved.filter ?? {}) },
        rendering: toRenderingSpec(saved.rendering),
        slides: slidesViewOf(saved.slides) ?? base.slides,
        selectedIds: seeded ? [] : Array.isArray(saved.selectedIds) ? saved.selectedIds : selectedId ? [selectedId] : [],
        selectedEdgeId: undefined,
        pinned: Array.isArray(saved.pinned) ? saved.pinned : [],
        pathOptions: { ...base.pathOptions, ...(saved.pathOptions ?? {}) },
        tool: explorerTool(saved.tool),
        path: undefined,
        pathFrom: undefined,
        ...restoreHeldPositions(rest.layoutId, rest.layoutDirty, session),
        // The switch is remembered: a tab left with the simulation on comes back with it on, starting warm over the
        // positions it held (a run from scratch would throw the picture apart and re-form it).
        physics: !!saved.physics && canRunLive(rest.algorithm ?? base.algorithm),
        physicsWarm: !!saved.physics,
        hoveredId: undefined,
        metrics: undefined,
        metricsJob: undefined,
        metricsError: undefined,
        layoutJob: undefined,
        layoutError: undefined,
        analysisOptions: saved.analysisOptions?.metrics ? saved.analysisOptions : base.analysisOptions,
        placementOverlay: undefined,
        showPlacementOverlay: false,
        viewBudget: { ...DEFAULT_VIEW_BUDGET, ...(saved.viewBudget ?? {}) },
        acceptedLoad: seeded ? undefined : saved.acceptedLoad,
        pendingAccept: false,
      }
    }
  } catch {
    /* ignore */
  }
  return base
}

export function reducer(s: ExplorerState, a: Action): ExplorerState {
  switch (a.type) {
    case 'setFilter':
      return { ...s, filter: a.filter, filterDirty: !!s.filterId }
    case 'patchFilter': {
      // Raising the node cap is asking to see more of a view already chosen: the bigger view is accepted as it comes,
      // rather than gated as if it were a new picture.
      const showMore = typeof a.patch.maxNodes === 'number' && a.patch.maxNodes > (s.filter.maxNodes ?? DEFAULT_MAX_NODES)
      return { ...s, filter: { ...s.filter, ...a.patch }, filterDirty: !!s.filterId, ...(showMore ? { pendingAccept: true } : {}) }
    }
    case 'loadFilter':
      return { ...s, filter: a.filter, filterId: a.id, filterDirty: false }
    case 'clearFilter':
      return { ...s, filter: emptyFilter(), filterId: undefined, filterDirty: false }
    case 'markFilterSaved':
      return { ...s, filterId: a.id, filterDirty: false }
    case 'setAlgorithm':
      // The switch is a standing choice: it stays on for an algorithm the engine runs live, and only that.
      return { ...s, algorithm: a.algorithm, physics: s.physics && canRunLive(a.algorithm) }
    case 'patchParams':
      return { ...s, params: { ...s.params, ...a.patch } }
    case 'setPositions':
      // A saved layout's positions pulled from its entity (`forLayout`) are for that layout while nothing is held yet:
      // read from the state of a render before, they landed after a scene loaded its own and put the tab's previous
      // layout back over it.
      if (a.forLayout !== undefined && (s.layoutId !== a.forLayout || s.positions.size > 0)) return s
      // A picture landed (a run on the main thread, a placement): whatever refused before no longer applies.
      return { ...s, positions: PositionStore.replace(a.positions), layoutDirty: a.dirty ?? s.layoutDirty, layoutError: undefined }
    case 'restored':
      // The restore's positions, when there were any, land with it: one render, held as they were (unsaved).
      if (a.positions && a.positions.size) return { ...s, restoring: undefined, positions: a.positions, layoutDirty: true, layoutError: undefined }
      return s.restoring === undefined ? s : { ...s, restoring: undefined }
    case 'moveNode':
      return { ...s, positions: s.positions.movedOne(a.id, a.position), layoutDirty: true }
    case 'moveNodes':
      // A layout landing passes `dirty`, and clears whatever refused before; a drag only marks the layout unsaved.
      return { ...s, positions: s.positions.moved(a.positions, a.from), layoutDirty: a.dirty ?? true, ...(a.dirty === undefined ? {} : { layoutError: undefined }) }
    case 'movePacked':
      // A hand-back read for a set of positions (`store`, its id) that has since been replaced — a scene, a loaded
      // layout — is the old picture's: written over the new one it put the run's last picture back over the scene.
      if (a.store !== undefined && a.store !== s.positions.id) return s
      return { ...s, positions: s.positions.movedPacked(a, a.from), layoutDirty: true }
    case 'loadLayout': {
      // A loaded layout (a scene, a saved layout) under a running simulation keeps it running: the renderer starts it
      // again over the picture that was loaded, warm, so it settles that picture rather than re-forming it.
      const live = s.physics && canRunLive(a.algorithm ?? s.algorithm)
      return { ...s, positions: PositionStore.replace(a.positions), layoutId: a.id, layoutDirty: false, physics: live, physicsWarm: live || s.physicsWarm, algorithm: a.algorithm ?? s.algorithm, ...(a.pinned ? { pinned: a.pinned } : {}), layoutRule: a.rule, placementOverlay: undefined, layoutError: undefined }
    }
    case 'unloadLayout':
      return { ...s, layoutId: undefined, layoutDirty: false, positions: PositionStore.empty(), recomputeToken: s.recomputeToken + 1, layoutRule: undefined, placementOverlay: undefined }
    case 'markLayoutSaved':
      return { ...s, layoutId: a.id, layoutDirty: false }
    case 'recompute':
      return { ...s, recomputeToken: s.recomputeToken + 1, physics: s.physics && canRunLive(s.algorithm), layoutRule: undefined, placementOverlay: undefined }
    case 'setRendering':
      return { ...s, rendering: a.rendering, renderingDirty: !!s.renderingId }
    case 'patchRendering':
      return { ...s, rendering: { ...s.rendering, ...a.patch }, renderingDirty: !!s.renderingId }
    case 'setRule':
      return { ...s, rendering: setRule(s.rendering, a.scope, a.by, a.key, a.patch), renderingDirty: !!s.renderingId }
    case 'loadRendering':
      return { ...s, rendering: a.rendering, renderingId: a.id, renderingDirty: false }
    case 'clearRendering':
      return { ...s, rendering: DEFAULT_RENDERING, renderingId: undefined, renderingDirty: false }
    case 'markRenderingSaved':
      return { ...s, renderingId: a.id, renderingDirty: false }
    case 'setScene':
      return { ...s, sceneId: a.id }
    case 'select': {
      const selectedIds = applySelect(s.selectedIds, a.ids, a.mode ?? 'replace')
      // The same selection again (a repeat click, a tool re-stating it) is not a change.
      if (!s.selectedEdgeId && (selectedIds === s.selectedIds || (selectedIds.length === s.selectedIds.length && selectedIds.every((id, i) => id === s.selectedIds[i])))) return s
      return { ...s, selectedIds, selectedEdgeId: undefined }
    }
    case 'selectEdge':
      return s.selectedEdgeId === a.id ? s : { ...s, selectedEdgeId: a.id, ...(a.id ? { selectedIds: [] } : {}) }
    case 'hover':
      return s.hoveredId === a.id ? s : { ...s, hoveredId: a.id }
    case 'setPinned':
      return { ...s, pinned: [...new Set(a.ids)] }
    case 'pin': {
      const set = new Set(s.pinned)
      for (const id of a.ids) if (a.on) set.add(id)
      else set.delete(id)
      return { ...s, pinned: [...set] }
    }
    case 'setTool':
      return s.tool === explorerTool(a.tool) ? s : { ...s, tool: explorerTool(a.tool), pathFrom: undefined }
    case 'setPathOptions':
      return { ...s, pathOptions: { ...s.pathOptions, ...a.patch } }
    case 'setPathFrom':
      return { ...s, pathFrom: a.id }
    case 'setPath':
      return { ...s, path: a.path, pathFrom: undefined }
    case 'setHops':
      return { ...s, hops: Math.max(0, Math.min(6, a.hops | 0)) }
    case 'metricsStarted':
      return { ...s, metricsJob: { stage: 'build', done: 0, total: 1, startedAt: Date.now() }, metricsError: undefined }
    case 'metricsProgress':
      return s.metricsJob ? { ...s, metricsJob: { ...s.metricsJob, stage: a.stage, done: a.done, total: a.total } } : s
    case 'metricsDone':
      return { ...s, metrics: a.result, metricsJob: undefined, metricsError: undefined, analysisDirty: !!s.analysisId, analysisOptions: a.result.options }
    case 'metricsFailed':
      return { ...s, metricsJob: undefined, metricsError: a.message }
    case 'metricsCancelled':
      return { ...s, metricsJob: undefined }
    case 'layoutStarted':
      return { ...s, layoutJob: { nodes: a.nodes, startedAt: Date.now() }, layoutError: undefined }
    case 'layoutFinished':
      return { ...s, layoutJob: undefined }
    case 'layoutFailed':
      return { ...s, layoutJob: undefined, layoutError: a.message }
    case 'clearLayoutError':
      return s.layoutError ? { ...s, layoutError: undefined } : s
    case 'setViewBudget':
      return { ...s, viewBudget: { nodes: Math.max(100, a.budget.nodes | 0), edges: Math.max(100, a.budget.edges | 0) } }
    case 'acceptLoad':
      return a.load ? { ...s, acceptedLoad: a.load, memoryAccepted: a.load, pendingAccept: false } : { ...s, pendingAccept: true }
    case 'revokeLoad':
      return { ...s, acceptedLoad: undefined, memoryAccepted: undefined, pendingAccept: false }
    case 'clearMetrics':
      return { ...s, metrics: undefined, metricsJob: undefined, metricsError: undefined, analysisId: undefined, analysisDirty: false }
    case 'loadAnalysis':
      return { ...s, metrics: a.result, analysisId: a.id, analysisDirty: false, metricsJob: undefined, metricsError: undefined }
    case 'markAnalysisSaved':
      return { ...s, analysisId: a.id, analysisDirty: false }
    case 'setLegend':
      return s.showLegend === a.on ? s : { ...s, showLegend: a.on }
    case 'setSlides': {
      const next = { ...s.slides, ...a.patch }
      // `decks: undefined` in a patch means all of them again, `focus: undefined` none in front.
      if ('decks' in a.patch && a.patch.decks === undefined) delete next.decks
      if ('focus' in a.patch && a.patch.focus === undefined) delete next.focus
      for (const k of ['story', 'spatial', 'final'] as const) if (k in a.patch && a.patch[k] === undefined) delete next[k]
      return { ...s, slides: next }
    }
    case 'setAnimateCamera':
      return s.animateCamera === a.on ? s : { ...s, animateCamera: a.on }
    case 'setAnalysisAuto':
      return s.analysisAuto === a.on ? s : { ...s, analysisAuto: a.on }
    case 'setAnalysisOptions':
      return { ...s, analysisOptions: a.options }
    case 'loadProject':
      return s.projectId === a.id ? s : { ...s, projectId: a.id, selectedIds: [], path: undefined, pathFrom: undefined, selectedEdgeId: undefined }
    case 'setLayoutRule':
      return { ...s, layoutRule: a.rule, ...(a.rule ? {} : { placementOverlay: undefined }) }
    case 'setPlacementOverlay':
      return { ...s, placementOverlay: a.overlay }
    case 'showPlacementOverlay':
      return s.showPlacementOverlay === a.on ? s : { ...s, showPlacementOverlay: a.on }
    case 'setLabels':
      return { ...s, labels: a.labels }
    case 'toggleEdges':
      return { ...s, showEdges: !s.showEdges }
    case 'setPhysics':
      return { ...s, physics: a.on, livePending: false, physicsWarm: a.on && !!a.warm }
  }
}

/** A renderer's own runner for the algorithms it steps itself (the GPU view's force simulation). */
export interface NativeLayout {
  handles: (algorithm: LayoutAlgorithm) => boolean
  run: (algorithm: LayoutAlgorithm, params: LayoutParams, previous: Positions | undefined, signal: AbortSignal) => Promise<Positions>
}

export interface ExplorerContextValue {
  state: ExplorerState
  dispatch: (a: Action) => void
  /** Set by the mounted renderer for the algorithms it runs itself; cleared when it unmounts. */
  nativeLayout: MutableRefObject<NativeLayout | null>
  /** The filtered graph for the current store version. */
  slice: GraphSlice
  /** What the slice asks of the renderer, and whether it is held back for the user to trim first. */
  load: ViewLoad
  gated: boolean
  /** Why it is gated: the budget, or this tab's memory (`memoryGates`); undefined when it is not. */
  gateReason?: GateReason
  /** The tab's heap when the slice was made (Chrome only), and the budget the gate trims to: memory's when memory gates. */
  heap?: HeapReading
  drawBudget: ViewBudget
  /**
   * Positions for every node in the slice, for the given dimensionality. `pending` means a heavy layout is still
   * to be computed (a big force layout runs in a worker — `runLayout`): the nodes without a held position sit at
   * seed positions until it lands.
   */
  positionsFor: (dims: Dimensions) => { positions: Positions; unplaced: number; pending?: boolean }
  /**
   * Where this session's held positions are kept (localStorage, or IndexedDB past `LOCAL_CAP`). The view writes
   * there itself while a live simulation runs — straight from the engine's arrays, without the round trip through
   * this state — so a picture of a million nodes can be saved while it moves. See `saveHeldPositionsPacked`.
   */
  positionsStorageKey: string
  /**
   * Compute positions with the current algorithm and hold them — every node, or with `missing` only the nodes
   * without a held position (kept beside the others). Resolves once they are held: big force layouts run in a worker.
   */
  runLayout: (dims: Dimensions, scope?: 'all' | 'missing' | 'recompute') => Promise<void>
  /** Stop the layout in the worker; the nodes it was placing go on a grid so a picture appears at once (a smaller view, or Lay out again, from there). */
  cancelLayout: (dims: Dimensions) => void
  /** Push overlapping nodes apart in place (2D). */
  removeOverlap: () => void
  nodeById: Map<EntityId, AnyEntity>
  /** Resolved display style for every node and edge in the slice. */
  /** `typeColor`: the colour the picture gives a type (`typeColorFor`), for the lists beside it — the filter's types. */
  styles: { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle>; legend: Legend | null; typeColor: (type: string) => string }
  /** Fingerprint of the current slice, for metrics staleness. */
  sliceKey: string
  metricsStale: boolean
  metricIndex: Map<EntityId, number> | undefined
  /** Run metrics for the current slice in a worker (cancels any previous run). */
  runMetrics: (options: MetricsOptions) => Promise<MetricsResult>
  cancelMetrics: () => void
  /** Last selected node id. */
  primary: EntityId | undefined
  selectedSet: Set<EntityId>
  pinnedSet: Set<EntityId>
  /** Replace the selection with the result of a set operation over the visible graph. */
  selectOp: (op: SelectionOp) => EntityId[]
  /** Shortest path in the current slice with the current path options; also shown in the view. */
  computePath: (from: EntityId, to: EntityId) => PathState | null
  /** Values (typed degrees, metrics, project overlay, selection) for the current view. */
  values: ValueContext
  /** Loaded project members, when the Dataset stage is a project. */
  members: Set<EntityId> | undefined
  dataset: { source: 'workspace' | 'project'; label: string; breadcrumb: { id?: EntityId; label: string }[]; nodes: number; edges: number }
  resolve: (sel: Selector) => SelectorResult
  /** Arrange nodes from values in a region of the given frame; holds the result and remembers the rule. */
  placeNodes: (selector: Selector, spec: PlacementSpec, frame: Frame) => PlaceResult
  transformNodes: (ids: EntityId[], op: TransformOp) => Positions
  /** Re-run the remembered placement rule against current values. */
  rederiveLayout: (frame: Frame) => PlaceResult | null
  pipeline: Pipeline
}

const Ctx = createContext<ExplorerContextValue | null>(null)

/** What the engine draws without asking: it is built for these sizes, so the gate and the default node cap step aside. */
export const GPU_VIEW_BUDGET: ViewBudget = { nodes: 2_000_000, edges: 10_000_000 }
export const GPU_MAX_NODES = 2_000_000

/** The ids a slice shows — nodes and edges — as sets, made once per slice the first time a write asks. */
const sliceIds = new WeakMap<GraphSlice, { nodes: Set<EntityId>; edges: Set<EntityId> }>()
function idsOf(slice: GraphSlice) {
  let s = sliceIds.get(slice)
  if (!s) sliceIds.set(slice, (s = { nodes: new Set(slice.nodes.map((n) => n.id)), edges: new Set(slice.edges.map((e) => e.id)) }))
  return s
}
const onlySets = new WeakMap<string[], Set<EntityId>>()
const onlyOf = (only: string[]) => onlySets.get(only) ?? onlySets.set(only, new Set(only)).get(only)!

/**
 * Whether a store event can change what a view shows: an entity in it, or one its filter could let in; a
 * relationship touching one of its nodes; a removal of something in it. What the filter rules out at a glance — not in
 * its `only` list, not one of its types, a definition or a project's bookkeeping — cannot; anything it cannot rule
 * out (text, tags, predicates) counts. Answered for every write, so it is a few set lookups per entity written.
 */
export function affectsSlice(ev: StoreEvent, spec: FilterSpec, slice: GraphSlice | undefined): boolean {
  switch (ev.type) {
    case 'batch':
      return ev.events.some((e) => affectsSlice(e, spec, slice))
    case 'reset':
    case 'scope':
      return true
    case 'remove':
      if (!slice) return true
      return ev.ids.some((id) => idsOf(slice).nodes.has(id) || idsOf(slice).edges.has(id))
    case 'upsert': {
      if (ev.volatile) return false
      if (!slice) return true
      const ids = idsOf(slice)
      const only = spec.only?.length ? onlyOf(spec.only) : undefined
      const types = spec.types?.length ? spec.types : undefined
      for (const e of ev.entities) {
        if (ids.nodes.has(e.id) || ids.edges.has(e.id)) return true
        if (e.type === SCHEMA_TYPE) continue
        const cat = getEntityType(e.type)?.category
        if (cat === 'project' || cat === 'schema') continue
        if (e.kind === 'relationship') {
          if (ids.nodes.has(e.source.id) || ids.nodes.has(e.target.id)) return true
          continue
        }
        if (only && !only.has(e.id)) continue
        if (types && !types.includes(e.type)) continue
        return true
      }
      return false
    }
    default:
      return false
  }
}

/**
 * A counter of the writes that can change the view (`affectsSlice`), for the slice to key on — and only while the
 * view is on screen: hidden, the writes are noted and the view catches up once when it is shown again. On the WildChat
 * atlas each chat turn's record re-filtered the scene — a query over a million entities, half a second — whether or
 * not Unigraph was the page in front, for a conversation the scene does not show.
 */
function useSliceVersion(store: EntityStore, spec: FilterSpec, slice: MutableRefObject<GraphSlice | undefined>, shown: boolean): number {
  const [version, setVersion] = useState(0)
  const live = useRef({ spec, shown, missed: false })
  useEffect(() => {
    live.current.spec = spec
    live.current.shown = shown
    if (shown && live.current.missed) {
      live.current.missed = false
      setVersion((v) => v + 1)
    }
  }, [spec, shown])
  useEffect(
    () =>
      store.subscribe((ev) => {
        const l = live.current
        if (!affectsSlice(ev, l.spec, slice.current)) return
        if (l.shown) setVersion((v) => v + 1)
        else l.missed = true
      }),
    [store, slice],
  )
  return version
}

/** A counter of the store's tag-colour changes (its `tags` events), for what draws tags in their colours. */
const tagColourVersions = new WeakMap<EntityStore, { v: number }>()
function tagColourVersion(store: EntityStore): number {
  let t = tagColourVersions.get(store)
  if (!t) {
    const tracker = { v: 0 }
    tagColourVersions.set(store, (t = tracker))
    const touches = (ev: StoreEvent): boolean => ev.type === 'tags' || ev.type === 'reset' || (ev.type === 'batch' && ev.events.some(touches))
    store.subscribe((ev) => {
      if (touches(ev)) tracker.v++
    })
  }
  return t.v
}
function useTagColourVersion(store: EntityStore): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => tagColourVersion(store),
    () => tagColourVersion(store),
  )
}

/** `value` while the view is shown; the value it last had on screen while it is hidden — so what keys on it waits. */
function useWhileShown<T>(value: T, shown: boolean): T {
  const [kept, setKept] = useState(value)
  // Derived state, set during render (React's pattern for it): shown again, it takes the current value at once.
  if (shown && kept !== value) setKept(value)
  return shown ? value : kept
}

export function ExplorerProvider({
  children,
  session,
  seed,
}: {
  children: ReactNode
  /** This explorer tab's own persisted state (see `scoped`). */
  session?: string
  /**
   * Applied to the restored state once, before the first render: what the address asked for (`?only=`, `&fresh=1`)
   * takes effect before the first slice is built, so no layout starts on the last-used filter only to be thrown away.
   */
  seed?: (s: ExplorerState) => ExplorerState
}) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  // The slice and the degree index read the whole dataset: only data changes recompute them, not a row being opened elsewhere.
  // What the graph is made of, not what has been saved about it: writing an analysis, a layout, a style or a scene
  // leaves the slice — and so the positions, the seeds and the engine's buffers — exactly as they were.
  // And only while the view is on screen: a Unigraph tab kept behind another page (or another pane's tab in front)
  // holds its slice as it was and catches up once when it is shown again. Following the writes while hidden, it
  // re-filtered the WildChat atlas (a query over a million entities, half a second) for every chat turn's record,
  // on whatever page the chat was being had.
  const viewShown = useViewActive()
  const dataVersion = useWhileShown(useDatasetVersion(store), viewShown)
  const ontology = useOntologyVersion(store)
  const registry = useTypeRegistry()
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const s = initialState(session)
    return seed ? seed(s) : s
  })
  // The rendered state, for async work that outlives the closure it started in.
  const latest = useRef(state)
  latest.current = state

  // Persist the cheap, user-intent parts of the state (positions go to their own key below; never the path).
  useEffect(() => {
    const { filter, filterId, filterDirty, algorithm, params, layoutId, layoutDirty, rendering, renderingId, renderingDirty, sceneId, labels, showEdges, selectedIds, pinned, tool, pathOptions, hops, analysisId, analysisDirty, analysisAuto, analysisOptions, showLegend, slides, animateCamera, projectId, layoutRule, showPlacementOverlay, viewBudget, acceptedLoad, physics } = state
    try {
      const json = JSON.stringify({ filter, filterId, filterDirty, algorithm, params, layoutId, layoutDirty, rendering, renderingId, renderingDirty, sceneId, labels, showEdges, selectedIds: selectedIds.slice(0, 500), pinned, tool, pathOptions, hops, analysisId, analysisDirty, analysisAuto, analysisOptions, showLegend, slides, animateCamera, projectId, layoutRule, showPlacementOverlay, viewBudget, acceptedLoad, physics })
      localStorage.setItem(scoped(STORAGE_KEY, session), json)
      // The unscoped key is what a new session starts from: the last-used state, whichever tab it was in.
      if (session) localStorage.setItem(STORAGE_KEY, json)
    } catch {
      /* ignore */
    }
  }, [state, session])

  /** A live simulation is moving the nodes: the engine holds the picture and hands it over every few seconds. */
  const livePhysics = state.physics && canRunLive(state.algorithm)
  const positionsStorageKey = scoped(POSITIONS_KEY, session)
  // Held positions are persisted separately, debounced, so dragging never serialises per frame; big sets go to
  // IndexedDB (see heldPositions.ts). Nothing is written while the restore of a big set is still on its way.
  // A live simulation hands new positions over for as long as it runs, and packing half a million of them is
  // tens of milliseconds of main thread each time, so while one is running the write is not debounced but
  // throttled — every LIVE_SAVE_MS. Switching the simulation off runs this effect again with the ordinary delay, so
  // the picture it settled on is written at once. A write still waiting when the page is hidden or left (a reload,
  // the tab closed, a dev server reloading it) is made then, not dropped with its timer.
  const lastSaved = useRef(0)
  // The write still waiting when the view goes (a Unigraph page or tab is let go the moment it is behind — see
  // `unloadsBehind`) is made then: the effect's cleanup drops the timer on every change, which is right while a drag
  // goes on and wrong once, at the end.
  const pendingSave = useRef<(() => void) | null>(null)
  useEffect(() => () => pendingSave.current?.(), [])
  /** What was written last (the held set's id and version): switching the simulation on or off is not a change. */
  const savedVersion = useRef<{ id: number; version: number } | null>(null)
  useEffect(() => {
    if (state.restoring !== undefined) return
    // While a live simulation runs the renderer writes its positions itself, straight from the engine's arrays
    // (GpuGraph › keep, the same key): packing the held set here as well was a third of a second at a million, for
    // a copy of what was being written anyway. Nor is an older write left to be made when the view goes, over theirs.
    if (livePhysics || (savedVersion.current && savedVersion.current.id === state.positions.id && savedVersion.current.version === state.positions.version)) {
      pendingSave.current = null
      return
    }
    const wait = livePhysics ? Math.max(SAVE_DEBOUNCE_MS, LIVE_SAVE_MS - (Date.now() - lastSaved.current)) : SAVE_DEBOUNCE_MS
    let due = true
    const save = () => {
      if (!due) return
      due = false
      clearTimeout(t)
      lastSaved.current = Date.now()
      savedVersion.current = { id: state.positions.id, version: state.positions.version }
      void saveHeldPositions(scoped(POSITIONS_KEY, session), state.positions).catch(() => undefined)
    }
    const t = setTimeout(save, wait)
    pendingSave.current = save
    const onHide = () => {
      if (document.visibilityState === 'hidden') save()
    }
    const page = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined
    page?.addEventListener('pagehide', save)
    page?.document?.addEventListener('visibilitychange', onHide)
    return () => {
      clearTimeout(t)
      page?.removeEventListener('pagehide', save)
      page?.document?.removeEventListener('visibilitychange', onHide)
    }
  }, [state.positions, state.restoring, session, livePhysics])
  // The asynchronous half of the restore: a big view's positions from IndexedDB, held as they were (unsaved).
  useEffect(() => {
    if (state.restoring === undefined) return
    let cancelled = false
    const t0 = performance.now()
    // Started at boot (main.tsx › prefetchHeldPositions) when the address or a pane named this session: then it is
    // done by now, and this is a hand-over.
    readHeldPositionsPacked(scoped(POSITIONS_KEY, session))
      .then((packed) => {
        if (cancelled) return
        measure('gx:restore-read', { start: t0, detail: { nodes: packed?.count ?? 0 } })
        const t1 = performance.now()
        const positions = packed ? PositionStore.fromPacked(packed) : undefined
        measure('gx:restore-hold', { start: t1, detail: { nodes: positions?.size ?? 0 } })
        dispatch({ type: 'restored', positions })
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'restored' })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // ── Dataset stage: the workspace, or a loaded project's members ──
  const project = useMemo(() => {
    const e = state.projectId ? store.get(state.projectId) : undefined
    return isProject(e) ? e : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.projectId, store, version])
  useEffect(() => {
    if (state.projectId && !project) dispatch({ type: 'loadProject', id: undefined })
  }, [state.projectId, project])
  const members = useMemo(() => (project ? projectMembers(project) : undefined), [project])
  const overlay = useMemo(() => (project ? projectOverlay(project) : undefined), [project])
  const datasetDegrees = useMemo(() => new DegreeIndex(() => (members ? store.relationships().filter((r) => members.has(r.id)) : store.relationships())), [store, members, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const filterCtx = useMemo<FilterContext | undefined>(() => {
    const refs = filterComputedRefs(state.filter)
    if (!refs.structural && !members && !overlay) return undefined
    return { members, values: makeValueContext({ scope: 'dataset', store, degrees: datasetDegrees, overlay }) }
  }, [state.filter, members, overlay, store, datasetDegrees])
  // The default cap (twenty thousand nodes, from the days of sigma) gives way to the engine's; a cap the user set stays.
  const effectiveFilter = useMemo(() => (state.filter.maxNodes === undefined || state.filter.maxNodes === DEFAULT_MAX_NODES ? { ...state.filter, maxNodes: GPU_MAX_NODES } : state.filter), [state.filter])
  // The registry is a new object after every data write — saving a scene included — and having the slice follow its
  // identity meant re-filtering ten thousand nodes, rebuilding the engine's buffers and re-seeding the waiting cloud
  // each time a tool wrote something beside the picture. The slice reads the registry for categories, so it follows
  // the ontology's version instead, and the latest registry through a ref.
  const registryRef = useRef(registry)
  registryRef.current = registry
  // Not on every data write: on the writes that can change this view (`useSliceVersion`), and not while it is hidden.
  const sliceSeen = useRef<GraphSlice | undefined>(undefined)
  const sliceVersion = useSliceVersion(store, effectiveFilter, sliceSeen, viewShown)
  const slice = useMemo(() => {
    const t0 = performance.now()
    const s = applyFilter(store, registryRef.current, effectiveFilter, filterCtx)
    measure('gx:filter', { start: t0, detail: { nodes: s.nodes.length, edges: s.edges.length } })
    return s
  }, [store, ontology, effectiveFilter, filterCtx, sliceVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    sliceSeen.current = slice
  }, [slice])
  const dataset = useMemo(() => {
    const crumbs = projectBreadcrumb(store, project?.id)
    let nodes = 0
    let edges = 0
    if (members) {
      for (const id of members) {
        const e = store.get(id)
        if (e?.kind === 'relationship') edges++
        else if (e) nodes++
      }
    } else {
      nodes = store.entityCount()
      edges = store.relationshipCount()
    }
    return { source: project ? ('project' as const) : ('workspace' as const), label: crumbs[crumbs.length - 1].label, breadcrumb: crumbs, nodes, edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, project, members, version])
  const load = useMemo(() => viewLoad(slice), [slice])
  const budget = { nodes: Math.max(state.viewBudget.nodes, GPU_VIEW_BUDGET.nodes), edges: Math.max(state.viewBudget.edges, GPU_VIEW_BUDGET.edges) }
  // Read once per slice: the heap with this slice built is what a draw would add to.
  const heap = useMemo(() => readHeap(), [slice]) // eslint-disable-line react-hooks/exhaustive-deps
  const overBudget = shouldGate(load, budget, state.acceptedLoad)
  const memoryShort = memoryGates(load, heap, state.memoryAccepted)
  const gated = !state.pendingAccept && (overBudget || memoryShort)
  const gateReason: GateReason | undefined = !gated ? undefined : memoryShort ? 'memory' : 'budget'
  const drawBudget = useMemo<ViewBudget>(() => {
    if (!memoryShort) return budget
    const m = memoryBudget(heap)
    return { nodes: Math.min(budget.nodes, m.nodes), edges: Math.min(budget.edges, m.edges) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShort, heap, budget.nodes, budget.edges])
  useEffect(() => {
    if (state.pendingAccept) dispatch({ type: 'acceptLoad', load })
  }, [state.pendingAccept, load])
  const nodeById = useMemo(() => new Map(slice.nodes.map((n) => [n.id, n])), [slice])
  const selectedSet = useMemo(() => new Set(state.selectedIds), [state.selectedIds])
  const pinnedSet = useMemo(() => new Set(state.pinned), [state.pinned])
  const primary = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : undefined

  // Selection and path only ever refer to visible nodes; prune when the slice changes.
  useEffect(() => {
    const visible = new Set(nodeById.keys())
    const pruned = pruneSelection(state.selectedIds, visible)
    if (pruned !== state.selectedIds) dispatch({ type: 'select', ids: pruned, mode: 'replace' })
    if (state.pathFrom && !visible.has(state.pathFrom)) dispatch({ type: 'setPathFrom', id: undefined })
    if (state.path && state.path.nodes.some((id) => !visible.has(id))) dispatch({ type: 'setPath', path: undefined })
    if (state.selectedEdgeId && !slice.edges.some((e) => e.id === state.selectedEdgeId)) dispatch({ type: 'selectEdge', id: undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeById])

  // If a saved layout is loaded but its positions aren't in memory (fresh page load), pull them from the entity.
  useEffect(() => {
    if (state.layoutId && state.positions.size === 0) {
      const e = store.get(state.layoutId)
      const positions = (e?.data as LayoutData | undefined)?.positions
      // A layout saved with no positions has nothing to pull: loading its empty set would leave the store empty,
      // run this effect again and dispatch again — a render loop for as long as anything else re-renders.
      if (positions && Object.keys(positions).length) dispatch({ type: 'setPositions', positions, dirty: false, forLayout: state.layoutId })
      else if (!positions) dispatch({ type: 'unloadLayout' })
    }
  }, [state.layoutId, state.positions, store, version])

  // Resolved positions are cached per dimension count until any input changes: the renderers ask for
  // them from more than one effect, and a force layout over thousands of nodes costs seconds each time.
  // While a live simulation runs, the picture is the engine's and it hands its positions over every few seconds;
  // resolving the whole view again over each hand-back copied every position for a picture the renderer was
  // already drawing — a third of a second at half a million nodes, every few seconds. So while one is running the
  // cache follows what the simulation did *not* move (`quietVersion`: a drag, a placement, a loaded layout), and
  // the id says when another layout has replaced the set altogether.
  const cacheVersion = livePhysics ? state.positions.quietVersion : state.positions.version
  const positionsCache = useMemo(() => new Map<Dimensions, { positions: Positions; unplaced: number; pending?: boolean }>(), [slice, state.positions.id, cacheVersion, livePhysics, state.algorithm, state.params])
  /**
   * Where a node sat while it waited for the worker, per dimension count. The seed cloud is thrown away the moment
   * the layout lands, but until then it is what the user is looking at: recomputing it — which every filter, style
   * or metrics change would do, since they all rebuild the cache — scattered the same nodes to new random spots
   * each time, and the picture jumped back to a fresh cube on every tool call. A node keeps the seed it was given.
   */
  const seeds = useRef(new Map<Dimensions, Map<EntityId, Position>>())
  /**
   * The last resolve per dimension count, and what it was made from. Switching the simulation on or off rebuilds
   * the cache (it follows another version while one runs) without a node having moved: resolving a million again,
   * then syncing the engine with the result, was a second's freeze at the switch. When nothing it depends on has
   * changed — the slice, the positions (id and version), the algorithm, the parameters — and it placed every node,
   * it stands.
   */
  const lastResolved = useRef(new Map<Dimensions, { r: { positions: Positions; unplaced: number; pending?: boolean }; slice: typeof slice; id: number; version: number; algorithm: LayoutAlgorithm; params: typeof state.params }>())
  const positionsFor = useCallback(
    (dims: Dimensions) => {
      const hit = positionsCache.get(dims)
      if (hit) return hit
      const prev = lastResolved.current.get(dims)
      if (prev && prev.slice === slice && prev.id === state.positions.id && prev.version === state.positions.version && prev.algorithm === state.algorithm && prev.params === state.params && prev.r.unplaced === 0 && !prev.r.pending) {
        positionsCache.set(dims, prev.r)
        return prev.r
      }
      const params: LayoutParams = { ...state.params, dimensions: dims }
      const held = state.positions.size ? state.positions : undefined
      // A heavy layout never runs here, on the main thread: the missing nodes get seed positions and `pending`
      // tells the page to hand the real work to the worker (which then holds the result, ending the pending state).
      let missing = slice.nodes.length
      if (held) {
        missing = 0
        for (const n of slice.nodes) if (!held.get(n.id)) missing++
      }
      const heavy = isHeavyLayout(state.algorithm, missing, params)
      // A live simulation is the layout. The engine is moving these nodes and hands its positions over every couple
      // of seconds; a layout computed here would be thrown away by the next hand-back — and, since every hand-back
      // invalidates this cache, computed again on the one after: Force (Unigraph) stepped on the CPU, in render,
      // over and over, which starved the simulation it was fighting (240 iterations a second down to 19). The nodes
      // it has not placed yet go on a grid beside the picture and the simulation takes them from there.
      const live = (state.physics || !!state.livePending) && canRunLive(state.algorithm)
      const t0 = performance.now()
      // The seed cloud is thrown away when the worker lands, so it is never de-overlapped: on thousands of nodes
      // noverlap over random positions is seconds on the main thread, spent on a picture nobody keeps.
      // With nothing placed yet (a first open), the simulation starts from a cloud it pulls into shape, not from a grid:
      // the grid is for nodes joining a picture that is already there.
      const cloud = live && !held
      const r: { positions: Positions; unplaced: number; pending?: boolean } = resolvePositions(slice, held, cloud ? 'random' : live ? 'grid' : heavy ? 'random' : state.algorithm, (heavy && !live) || cloud ? { ...params, noverlap: false } : params)
      if ((heavy && !live) || cloud) {
        // Pending only for the worker; a live simulation takes the cloud as it is.
        if (!cloud) r.pending = true
        // Seeds are remembered, and reused: the cloud stands still between calls instead of re-scattering.
        const kept = seeds.current.get(dims) ?? seeds.current.set(dims, new Map()).get(dims)!
        if (kept.size > 400_000) kept.clear()
        for (const n of slice.nodes) {
          if (held?.get(n.id)) continue
          const was = kept.get(n.id)
          if (was) r.positions[n.id] = was
          else if (r.positions[n.id]) kept.set(n.id, r.positions[n.id])
        }
      }
      measure('gx:layout', { start: t0, detail: { nodes: slice.nodes.length, unplaced: r.unplaced, algorithm: live ? 'live' : heavy ? 'seed' : state.algorithm } })
      positionsCache.set(dims, r)
      lastResolved.current.set(dims, { r, slice, id: state.positions.id, version: state.positions.version, algorithm: state.algorithm, params: state.params })
      return r
    },
    [positionsCache, slice, state.positions, state.algorithm, state.params, state.physics, state.livePending],
  )

  /**
   * Moving some nodes by hand (a drag, `graph_positions`, a transform or a placement) moves those nodes — and no
   * others. With no layout held (a graph laid out as it was drawn, nothing saved or dragged yet) the positions on
   * screen live only in `positionsFor`'s cache; a move that held just the dragged node left every other node
   * unplaced, and the next render laid them all out again around it: the whole graph jumped somewhere else the
   * moment a node was let go. So before such a move, what is shown is held — the nodes the held positions lack,
   * from the view the move was made in — and the move lands on top of it. A layout landing (`dirty`) or a live
   * simulation's hand-back (`from`) is the whole picture already and goes straight through.
   */
  const shownRef = useRef(positionsCache)
  shownRef.current = positionsCache
  const sliceRef = useRef(slice)
  sliceRef.current = slice
  const dispatchHeld = useCallback((a: Action) => {
    if (a.type === 'moveNodes' && a.dirty === undefined && a.from === undefined) {
      const held = latest.current.positions
      const cache = shownRef.current
      const shown = (a.dims !== undefined ? cache.get(a.dims) : undefined) ?? cache.values().next().value
      if (shown && !shown.pending) {
        const base: Positions = {}
        let missing = 0
        for (const n of sliceRef.current.nodes)
          if (!held.get(n.id) && !a.positions[n.id] && shown.positions[n.id]) {
            base[n.id] = shown.positions[n.id]
            missing++
          }
        if (missing) dispatch({ type: 'moveNodes', positions: base, dirty: true })
      }
    }
    dispatch(a)
  }, [])

  // A mounted renderer may run some algorithms itself — the GPU view steps Force (Unigraph) on the GPU — by setting
  // this: `runLayout` hands those to it instead of the worker, and holds what it returns like any other layout.
  const nativeLayout = useRef<NativeLayout | null>(null)
  // One layout job at a time; a newer request, or leaving the page, cancels the running one.
  const layoutAbort = useRef<AbortController | null>(null)
  const runLayout = useCallback(
    async (dims: Dimensions, scope: 'all' | 'missing' | 'recompute' = 'all') => {
      const params: LayoutParams = { ...state.params, dimensions: dims }
      const held = state.positions.size ? state.positions : undefined
      // A placement in force — every tree where it stands — is a fixed arrangement: an algorithm change, an automatic
      // switch or a Run lays out only the nodes it did not place, over the held ones. Recompute clears the rule first
      // (the reducer does), so an explicit "lay it all out again" still does.
      if (scope === 'all' && held && (state.layoutRule?.kind === 'placement' || state.algorithm === 'custom')) scope = 'missing'
      if (scope === 'recompute') {
        dispatch({ type: 'setLayoutRule', rule: undefined })
        scope = 'all'
      }
      // Force layouts refine the held positions; the others only read them for pinned nodes.
      const previous = state.algorithm === 'force' ? held : state.pinned.length ? held : undefined
      const job = scope === 'missing' && held ? { op: 'resolve' as const, saved: held } : { op: 'compute' as const, previous, pinned: state.pinned }
      let count = slice.nodes.length
      if (job.op === 'resolve') {
        count = 0
        for (const n of slice.nodes) if (!held!.get(n.id)) count++
      }
      // Nothing to place: no job, no notice — a stray call here would otherwise flash "Laying out 0 nodes".
      if (count === 0) return
      const running = layoutAbort.current
      if (running) {
        running.abort()
        layoutAbort.current = null
        // The aborted job never reports (its `finally` sees another controller): its notice goes here, or a run on the
        // main thread below would leave "Laying out N nodes" up for a job that no longer exists.
        dispatch({ type: 'layoutFinished' })
      }
      // A layout past its size limit would run for minutes: the view gets one that scales instead — Force (Unigraph)
      // where the renderer steps it on the GPU, Multilevel otherwise — and the page runs that (a Run and the tools
      // refuse it before this; this is the view that grew, or a scene or a session that named it).
      if (layoutTooBig(state.algorithm, count)) {
        dispatch({ type: 'setAlgorithm', algorithm: nativeLayout.current?.handles('unigraph-force') ? 'unigraph-force' : 'multilevel' })
        return
      }
      if (!isHeavyLayout(state.algorithm, count, params) && !nativeLayout.current?.handles(state.algorithm)) {
        const fresh = job.op === 'resolve' ? resolvePositions(slice, job.saved, state.algorithm, params).positions : computeLayout(state.algorithm, slice, params, job.previous?.asObject(), job.pinned)
        dispatch({ type: 'moveNodes', positions: fresh, dirty: true })
        return
      }
      const ac = new AbortController()
      layoutAbort.current = ac
      dispatch({ type: 'layoutStarted', nodes: count })
      try {
        const t0 = performance.now()
        const native = nativeLayout.current
        // What the job started from: positions set while it ran are newer than its result and win when it lands.
        const startedAt = latest.current.positions.version
        // The worker and the native layouts want plain positions; the held store is materialised only here, off the
        // drag path, and only for a job heavy enough to leave the main thread.
        const wire: LayoutJob = job.op === 'resolve' ? { op: 'resolve', saved: job.saved.asObject(), algorithm: state.algorithm, params } : { op: 'compute', previous: job.previous?.asObject(), pinned: job.pinned, algorithm: state.algorithm, params }
        const { positions } = native && native.handles(state.algorithm) ? { positions: await native.run(state.algorithm, params, wire.op === 'compute' ? wire.previous : wire.saved, ac.signal) } : await runLayoutInWorker(slice, wire, ac.signal)
        measure('gx:layout-worker', { start: t0, detail: { nodes: count, algorithm: state.algorithm, native: !!(native && native.handles(state.algorithm)) } })
        // Over the positions as they are now: a node the user placed, transformed or dragged while the job ran — its
        // held position is not the one the job started from — keeps that; the job places the rest. A layout that
        // lands seconds after "every tree where it stands" must not put its ball back over the map.
        const now = latest.current.positions
        // The simulation's own hand-backs are not somebody's decision to keep: only what the person (or a
        // placement, or another layout) moved outranks this result.
        const since = now.movedSince(startedAt, { ignore: PHYSICS_TAG })
        // Nothing moved meanwhile, or the store can no longer say what did (a very long job): the result stands.
        const theirs = since && since.length ? new Set(since) : undefined
        const merged: Positions = {}
        for (const id in positions) if (!theirs?.has(id)) merged[id] = positions[id]
        dispatch({ type: 'moveNodes', positions: merged, dirty: true })
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // The view keeps its seed positions; the page says why, and a tool caller gets the same message.
        dispatch({ type: 'layoutFailed', message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        if (layoutAbort.current === ac) {
          layoutAbort.current = null
          dispatch({ type: 'layoutFinished' })
        }
      }
    },
    [slice, state.positions, state.algorithm, state.params, state.pinned, state.layoutRule],
  )
  useEffect(() => () => layoutAbort.current?.abort(), [])
  const cancelLayout = useCallback(
    (dims: Dimensions) => {
      const ac = layoutAbort.current
      if (!ac) return
      layoutAbort.current = null
      ac.abort()
      // The nodes still without a position are dropped on a grid (cheap, on the main thread) so the stage has a picture
      // and nothing asks for the layout again; the positions count as unsaved.
      const held = state.positions
      const missing = slice.nodes.filter((n) => !held.get(n.id))
      const fresh = missing.length ? computeLayout('grid', { ...slice, nodes: missing, edges: [] }, { ...state.params, dimensions: dims }) : {}
      dispatch({ type: 'moveNodes', positions: fresh, dirty: true })
      dispatch({ type: 'layoutFinished' })
    },
    [slice, state.positions, state.params],
  )

  const removeOverlap = useCallback(() => {
    const params: LayoutParams = { ...state.params, dimensions: 2 }
    const current = resolvePositions(slice, state.positions.size ? state.positions : undefined, state.algorithm, params).positions
    const spread = removeOverlapLayout(slice, current, params, undefined, pinnedSet)
    dispatch({ type: 'moveNodes', positions: spread, dirty: true })
  }, [slice, state.positions, state.algorithm, state.params, pinnedSet])

  const selectOp = useCallback(
    (op: SelectionOp) => {
      const ids = selectionOp(state.selectedIds, slice, op)
      dispatch({ type: 'select', ids, mode: 'replace' })
      return ids
    },
    [state.selectedIds, slice],
  )

  const pathRef = useRef(state.pathOptions)
  pathRef.current = state.pathOptions
  const computePath = useCallback(
    (from: EntityId, to: EntityId) => {
      const o = pathRef.current
      const r = shortestPath(slice, from, to, o)
      const path = r ? { ...r, from, to, directed: !!o.directed, weighted: !!o.weighted } : undefined
      dispatch({ type: 'setPath', path })
      return path ?? null
    },
    [slice],
  )

  // ── Metrics ───────────────────────────────────────────────────────────
  const sliceKey = useMemo(() => sliceKeyOf(slice), [slice])
  const metricsStale = !!state.metrics && state.metrics.sliceKey !== sliceKey
  const metricIndex = useMemo(() => (state.metrics ? metricIndexOf(state.metrics) : undefined), [state.metrics])
  const abortRef = useRef<AbortController | null>(null)
  const cancelMetrics = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    dispatch({ type: 'metricsCancelled' })
  }, [])
  const runMetrics = useCallback(
    async (options: MetricsOptions) => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      dispatch({ type: 'metricsStarted' })
      try {
        const result = await runMetricsInWorker(serializeSlice(slice, options.weightField), options, sliceKey, (stage, done, total) => dispatch({ type: 'metricsProgress', stage, done, total }), ac.signal)
        if (abortRef.current === ac) abortRef.current = null
        dispatch({ type: 'metricsDone', result })
        return result
      } catch (err) {
        if ((err as Error).name !== 'AbortError') dispatch({ type: 'metricsFailed', message: err instanceof Error ? err.message : String(err) })
        throw err
      }
    },
    [slice, sliceKey],
  )
  useEffect(() => () => abortRef.current?.abort(), [])

  // ── Values for this view: typed degrees, metrics, project overlay, selection ──
  const viewDegrees = useMemo(() => new DegreeIndex(() => slice.edges), [slice])
  const values = useMemo(
    () => makeValueContext({ scope: 'view', store, slice, degrees: viewDegrees, metrics: state.metrics, metricIndex, selected: selectedSet, pinned: pinnedSet, overlay }),
    [store, slice, viewDegrees, state.metrics, metricIndex, selectedSet, pinnedSet, overlay],
  )
  const resolve = useCallback((sel: Selector) => resolveSelector(sel, { store, registry, slice, values, selected: selectedSet, members }), [store, registry, slice, values, selectedSet, members])

  const placeNodes = useCallback(
    (selector: Selector, spec: PlacementSpec, frame: Frame) => {
      const { nodes } = resolve(selector)
      const result = place(nodes, spec, values, frame, state.positions.asObject())
      // A placement is the layout from here on: the Layout tab reads Custom positions, and no run recomputes it.
      dispatch({ type: 'setAlgorithm', algorithm: 'custom' })
      dispatchHeld({ type: 'moveNodes', positions: result.positions })
      dispatch({ type: 'setLayoutRule', rule: { kind: 'placement', selector, spec } })
      dispatch({ type: 'setPlacementOverlay', overlay: { region: result.region, cells: result.cells, axes: result.axes } })
      return result
    },
    [resolve, values, state.positions, dispatchHeld],
  )
  const transformNodes = useCallback(
    (ids: EntityId[], op: TransformOp) => {
      const moved = transform(ids, state.positions.asObject(), op)
      if (Object.keys(moved).length) {
        dispatch({ type: 'setAlgorithm', algorithm: 'custom' })
        dispatchHeld({ type: 'moveNodes', positions: moved })
      }
      return moved
    },
    [state.positions, dispatchHeld],
  )
  const rederiveLayout = useCallback((frame: Frame) => (state.layoutRule ? placeNodes(state.layoutRule.selector, state.layoutRule.spec, frame) : null), [state.layoutRule, placeNodes])

  // ── Auto analysis: re-run when the view changes and something reads metrics ──
  const lastRunMs = useRef(0)
  const failedKey = useRef<string | undefined>(undefined)

  const rendering = state.rendering
  // Styles read the selection only when a rule names `selected` (or `pinned`); otherwise a click must not re-derive
  // every node's style — at tens of thousands of nodes that is the difference between a camera that moves at once
  // and one that waits half a second.
  const styleReadsSelection = useMemo(() => /"(selected|pinned)"/.test(JSON.stringify(rendering)), [rendering])
  const styleValues = useMemo(
    () => (styleReadsSelection ? values : makeValueContext({ scope: 'view', store, slice, degrees: viewDegrees, metrics: state.metrics, metricIndex, selected: EMPTY_IDS, pinned: EMPTY_IDS, overlay })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [styleReadsSelection, styleReadsSelection ? values : null, store, slice, viewDegrees, state.metrics, metricIndex, overlay],
  )
  // Keyed like the slice: on the ontology's version and the tags' colours, the registry read through its ref — the
  // registry is a new object after every data write, and restyling (and rebuilding the engine's buffers) for a chat's
  // record written elsewhere was a fifth of a second on the atlas, on whatever page the chat was.
  const tagColours = useTagColourVersion(store)
  const styles = useMemo(() => {
    const t0 = performance.now()
    const ctx = styleContext(registryRef.current, slice.nodes, slice.degree, rendering, { edges: slice.edges, metrics: state.metrics, metricIndex, values: styleValues, tagColor: (t) => store.getTagInfo(t).color })
    const nodes = resolveNodeStyles(slice.nodes, rendering, ctx)
    const edges = new Map<EntityId, EdgeStyle>()
    for (const e of slice.edges) edges.set(e.id, resolveEdgeStyle(e, rendering, edgeColor, ctx))
    const legend = legendFor(rendering, ctx, slice.nodes)
    measure('gx:style', { start: t0, detail: { nodes: slice.nodes.length, edges: slice.edges.length } })
    return { nodes, edges, legend, typeColor: (type: string) => typeColorFor(rendering, ctx, type) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontology, tagColours, store, slice, rendering, state.metrics, metricIndex, styleValues])

  const pipeline = useMemo(
    () =>
      describePipeline({
        dataset: { source: dataset.source, label: dataset.label, nodes: dataset.nodes, edges: dataset.edges, breadcrumb: dataset.breadcrumb.map((b) => b.label) },
        filter: state.filter,
        view: { nodes: slice.nodes.length, edges: slice.edges.length },
        layout: { algorithm: state.algorithm, positions: state.positions.size, rule: state.layoutRule, layoutId: state.layoutId, dirty: state.layoutDirty },
        rendering,
        analysis: { metrics: state.metrics, stale: metricsStale, running: !!state.metricsJob, auto: state.analysisAuto },
      }),
    [dataset, state.filter, slice, state.algorithm, state.positions, state.layoutRule, state.layoutId, state.layoutDirty, rendering, state.metrics, metricsStale, state.metricsJob, state.analysisAuto],
  )

  // Auto analysis waits while the explorer is behind another page or tab: a kept explorer over a big view would
  // otherwise run Louvain in a worker for a picture nobody is looking at.
  const viewActive = useViewActive()
  useEffect(() => {
    if (!state.analysisAuto || !metricsStale || state.metricsJob || !slice.nodes.length || !viewActive) return
    if (failedKey.current === sliceKey) return
    if (lastRunMs.current > 2000 && slice.nodes.length >= 5000) return
    const t = setTimeout(() => {
      const t0 = performance.now()
      runMetrics(state.analysisOptions)
        .then(() => (lastRunMs.current = performance.now() - t0))
        .catch(() => (failedKey.current = sliceKey))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.analysisAuto, metricsStale, sliceKey, state.metricsJob, state.analysisOptions, viewActive])

  const value = useMemo<ExplorerContextValue>(
    () => ({ state, dispatch: dispatchHeld, nativeLayout, slice, load, gated, gateReason, heap, drawBudget, positionsFor, positionsStorageKey, runLayout, cancelLayout, removeOverlap, nodeById, styles, sliceKey, metricsStale, metricIndex, runMetrics, cancelMetrics, primary, selectedSet, pinnedSet, selectOp, computePath, values, members, dataset, resolve, placeNodes, transformNodes, rederiveLayout, pipeline }),
    [state, slice, load, gated, gateReason, heap, drawBudget, positionsFor, positionsStorageKey, runLayout, cancelLayout, removeOverlap, nodeById, styles, sliceKey, metricsStale, metricIndex, runMetrics, cancelMetrics, primary, selectedSet, pinnedSet, selectOp, computePath, values, members, dataset, resolve, placeNodes, transformNodes, rederiveLayout, pipeline],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useExplorer(): ExplorerContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useExplorer must be used inside <ExplorerProvider>')
  return v
}

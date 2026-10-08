import type { SceneView, SlidesView } from '../../core/graph/scene'
import type { EntityId } from '../../core/entity/types'
import type { FilterSpec, GraphSlice } from '../../core/graph/filter'
import type { GateReason, ViewBudget, ViewLoad } from '../../core/graph/budget'
import type { Dimensions, LayoutAlgorithm, LayoutParams, Positions } from '../../core/graph/layouts'
import type { MetricsOptions, MetricsResult, MetricsSummary } from '../../core/graph/metrics/types'
import type { PathOptions, PathResult } from '../../core/graph/paths'
import type { Frame, LayoutRule, PlaceResult, PlacementSpec, TransformOp } from '../../core/graph/placement'
import type { Pipeline } from '../../core/graph/pipeline'
import type { EdgeRule, EdgeStyle, NodeRule, NodeStyle, RenderingSpec } from '../../core/graph/rendering'
import type { SelectionOp, SelectMode } from '../../core/graph/selection'
import type { Selector, SelectorResult } from '../../core/graph/selector'
import type { ValueContext } from '../../core/graph/values'
import type { CameraState, CameraTarget, Viewport } from './view'

/**
 * What an open graph explorer exposes to the assistant tools. The explorer's
 * state lives in a React context; each mounted shell registers a handle so
 * tools (in-app or over the Claude Code bridge) can read and drive it the way
 * the panels do. Several explorers can be mounted at once (workstation panes);
 * the one the user last interacted with is the active one.
 */
export interface PathState extends PathResult {
  from: EntityId
  to: EntityId
  directed: boolean
  weighted: boolean
}

/** The explorer's side panels, one open at a time, each behind a button top left of the toolbar. */
export type ExplorerSidePanel = 'filter' | 'layout' | 'style' | 'stats' | 'selection'
export const EXPLORER_SIDE_PANELS: readonly ExplorerSidePanel[] = ['filter', 'layout', 'style', 'stats', 'selection']

export interface ExplorerHandle {
  dims: Dimensions
  /** Which renderer draws: sigma (2d), force-graph (3d), or the GPU engine flat (gpu) or in three dimensions (gpu3d). */
  renderer?: '2d' | '3d'
  getState: () => {
    filter: FilterSpec
    filterId?: EntityId
    filterDirty: boolean
    algorithm: LayoutAlgorithm
    params: Omit<LayoutParams, 'dimensions'>
    layoutId?: EntityId
    layoutDirty: boolean
    positions: Positions
    rendering: RenderingSpec
    renderingId?: EntityId
    renderingDirty: boolean
    /** Primary selected node (last selected). */
    selectedId?: EntityId
    selectedIds: EntityId[]
    selectedEdgeId?: EntityId
    pinned: EntityId[]
    tool: 'select' | 'path'
    pathOptions: PathOptions
    path?: PathState
    hops: number
    labels: 'auto' | 'all' | 'none'
    showEdges: boolean
    physics: boolean
    metricsSummary?: MetricsSummary
    metricsStale: boolean
    metricsRunning: boolean
    /** A big force layout still computing in a worker (the view shows seed positions until it lands). */
    layoutRunning: boolean
    /** Why the last layout run gave no positions, if it refused or failed. */
    layoutError?: string
    analysisId?: EntityId
    analysisDirty: boolean
    analysisAuto: boolean
    analysisOptions: MetricsOptions
    showLegend: boolean
    /** The slide layer over the 3D view. */
    slides: SlidesView
    projectId?: EntityId
    layoutRule?: LayoutRule
    showPlacementOverlay: boolean
    viewBudget: ViewBudget
    acceptedLoad?: ViewLoad
    memoryAccepted?: ViewLoad
    /** The scene loaded last, if any (its parts may have changed since). */
    sceneId?: EntityId
  }
  /** What the current slice asks of the renderer (nodes and edges it would draw). */
  getLoad: () => ViewLoad
  /** Whether the large-graph gate is showing instead of the canvas. */
  isGated: () => boolean
  /** Why it is: the view budget, or this tab's memory (`memoryGates`). */
  gateReason: () => GateReason | undefined
  acceptLoad: (load: ViewLoad) => void
  setViewBudget: (budget: ViewBudget) => void
  /** Dataset stage: workspace or loaded project. */
  getDataset: () => { source: 'workspace' | 'project'; label: string; breadcrumb: { id?: EntityId; label: string }[]; nodes: number; edges: number }
  getPipeline: () => Pipeline
  /** The dataset's totals before the filter, by node type and relationship type (`datasetTotals`) — the y of the filter panel's "x of y". */
  getTotals: () => { types: Map<string, number>; rels: Map<string, number> }
  getValueContext: () => ValueContext
  resolve: (sel: Selector) => SelectorResult
  /** Current viewport in graph coordinates (null before the renderer is ready). */
  getViewport: () => Viewport | null
  getCamera: () => CameraState | null
  setCamera: (target: CameraTarget, ms?: number) => void
  fitTo: (ids: Iterable<EntityId>, opts?: { padding?: number; ms?: number }) => void
  /** Slide the camera by a fraction of the view (x right, y up) — the arrow keys' move. */
  panBy: (fx: number, fy: number) => void
  /** Zoom about the view's centre by `factor` (>1 closer) — Q and E. */
  zoomBy: (factor: number) => void
  /** 3D: turn the camera around the point it looks at, in radians (yaw right, pitch up) — W A S D. */
  orbitBy: (yaw: number, pitch: number) => void
  /** Frame for placement: the viewport (or the bbox when the renderer isn't ready) and the bbox of held positions. */
  getFrame: () => Frame
  /** Hold positions for nodes (stops physics). `merge` keeps the others; else replaces the whole map. */
  setPositions: (positions: Positions, opts?: { merge?: boolean }) => void
  place: (selector: Selector, spec: PlacementSpec) => PlaceResult
  transformPositions: (ids: EntityId[], op: TransformOp) => Positions
  rederiveLayout: () => PlaceResult | null
  setLayoutRule: (rule?: LayoutRule) => void
  setPlacementOverlay: (on: boolean) => void
  setAnalysisAuto: (on: boolean) => void
  loadProject: (id?: EntityId) => void
  getSlice: () => GraphSlice
  /** Resolved styles for the current slice. */
  getStyles: () => { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> }
  /** Positions for every visible node in the explorer's dimensionality. */
  getPositions: () => Positions
  /** PNG of the canvas, or null when the renderer isn't ready. */
  snapshot: (opts?: { width?: number; height?: number; background?: string }) => Promise<Blob | null>
  getMetrics: () => MetricsResult | undefined
  runMetrics: (options: MetricsOptions) => Promise<MetricsResult>
  cancelMetrics: () => void
  loadAnalysis: (id: EntityId, result: MetricsResult) => void
  markAnalysisSaved: (id: EntityId) => void
  clearMetrics: () => void
  setLegend: (on: boolean) => void
  /** Show or hide the slide layer, pick its decks (`decks: undefined` = all), bring a slide to the front (`focus`). */
  setSlides: (patch: Partial<SlidesView>) => void
  /** 3D: turn the camera square on to a slide hanging over the picture; false when the slide is not hung there (2D, hidden, another deck). */
  faceSlide?: (id: EntityId, ms?: number) => boolean
  setFilter: (filter: FilterSpec) => void
  loadFilter: (id: EntityId, filter: FilterSpec) => void
  clearFilter: () => void
  markFilterSaved: (id: EntityId) => void
  setAlgorithm: (algorithm: LayoutAlgorithm) => void
  patchParams: (patch: Partial<Omit<LayoutParams, 'dimensions'>>) => void
  loadLayout: (id: EntityId, positions: Positions, algorithm?: LayoutAlgorithm, pinned?: EntityId[], rule?: LayoutRule) => void
  unloadLayout: () => void
  markLayoutSaved: (id: EntityId) => void
  /** Recompute positions with the current algorithm and hold them; resolves once they are held (big force layouts run in a worker). */
  /** Lay the picture out again; `recompute` forgets a placement rule first and lays everything out (a Run under a rule places only what it left). */
  runLayout: (scope?: 'all' | 'recompute') => Promise<void>
  removeOverlap: () => void
  setRendering: (rendering: RenderingSpec) => void
  patchRendering: (patch: Partial<RenderingSpec>) => void
  setRule: (scope: 'nodes' | 'edges', by: 'types' | 'tags', key: string, patch: NodeRule | EdgeRule | null) => void
  loadRendering: (id: EntityId, rendering: RenderingSpec) => void
  clearRendering: () => void
  markRenderingSaved: (id: EntityId) => void
  /** Select one node (or clear with undefined). */
  select: (id?: EntityId) => void
  setSelection: (ids: EntityId[], mode?: SelectMode) => void
  selectOp: (op: SelectionOp) => EntityId[]
  selectEdge: (id?: EntityId) => void
  setPinned: (ids: EntityId[]) => void
  setTool: (tool: 'select' | 'path') => void
  setPathOptions: (patch: Partial<PathOptions>) => void
  computePath: (from: EntityId, to: EntityId) => PathState | null
  clearPath: () => void
  setHops: (hops: number) => void
  setLabels: (labels: 'auto' | 'all' | 'none') => void
  setShowEdges: (on: boolean) => void
  setPhysics: (on: boolean) => void
  fit: () => void
  /** Full view: the side panel closed so the picture has the width and the app sidebar folded to its rail; the same button brings both back. */
  setFullView?: (on: boolean) => void
  isFullView?: () => boolean
  /** The side panel: which one is open (Filter, Layout, Style, Stats, Selection — the toolbar's buttons), or none. */
  setPanel?: (panel: ExplorerSidePanel | null) => void
  getPanel?: () => ExplorerSidePanel | null
  /** The scene the view now stands for (after a save), or none. */
  setScene?: (id?: EntityId) => void
  /** The view and the UI as they stand (camera, toggles, selection, panels) and a small picture, for a scene being saved. */
  captureView?: () => Promise<{ view: SceneView; preview?: string; stats: { nodes: number; edges: number } }>
  /** What the detail pane shows, in words — for the assistant's app context. */
  describeDetail?: () => string
  /** Show another renderer in place: the picture, panels and pane stay; only the canvas changes. */
  switchMode: (mode: '2d' | '3d') => void
}

// One registry per page, survives Vite HMR re-evaluating this module (which would otherwise strand mounted explorers).
interface Registry {
  handles: ExplorerHandle[]
  listeners: Set<() => void>
}
const g = globalThis as unknown as { __aegraphExplorers?: Registry }
const reg: Registry = (g.__aegraphExplorers ??= { handles: [], listeners: new Set() })
const handles = reg.handles
const listeners = reg.listeners
const notify = () => listeners.forEach((l) => l())

/** Register a mounted explorer as the active one; returns the unregister function. */
export function registerExplorerHandle(h: ExplorerHandle): () => void {
  handles.push(h)
  notify()
  return () => {
    const i = handles.indexOf(h)
    if (i >= 0) handles.splice(i, 1)
    notify()
  }
}

/** Mark a handle as the one the user is interacting with. */
export function touchExplorerHandle(h: ExplorerHandle) {
  const i = handles.indexOf(h)
  if (i < 0 || i === handles.length - 1) return
  handles.splice(i, 1)
  handles.push(h)
  notify()
}

/** Back-compat shim: `setExplorerHandle(null)` clears everything (tests). */
export function setExplorerHandle(h: ExplorerHandle | null) {
  handles.length = 0
  if (h) handles.push(h)
  notify()
}

export const getExplorerHandle = (): ExplorerHandle | null => handles[handles.length - 1] ?? null

/** Resolve with the active handle once an explorer (in `dims`, if given) mounts, or null after `timeoutMs`. */
export function waitForExplorer(dims?: Dimensions, timeoutMs = 5000): Promise<ExplorerHandle | null> {
  const ok = (h: ExplorerHandle | null): h is ExplorerHandle => !!h && (dims === undefined || h.dims === dims)
  const current = getExplorerHandle()
  if (ok(current)) return Promise.resolve(current)
  return new Promise((resolve) => {
    const done = (h: ExplorerHandle | null) => {
      listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => {
      const h = getExplorerHandle()
      if (ok(h)) done(h)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    listeners.add(check)
  })
}

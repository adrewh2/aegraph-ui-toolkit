import { BarChart3, Box, Download, Filter, LayoutGrid, ListTree, MousePointer2, Palette, PanelRightOpen, Pause, Play, Spline, Square, Table2, Waypoints } from 'lucide-react'
import { readGraphSetup, readPick } from '../../app/openIn'
import { applyGraphSetup } from '../analysis/materialize'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chunk, preloaded, registerPreload } from '../../app/preload'
import { flushSync } from 'react-dom'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { isSidebarRail, setSidebarRail } from '../../components/Sidebar/rail'
import { useToast } from '../../components/ui/useToast'
import { EntityTable } from '../resources/EntityTable'
import { type FieldDef } from '../../core/entity/schema'
import { createEntity, displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { hashColor } from '../../lib/format'
import type { EntityStore } from '../../core/entity/store'
import { datasetTotals, DEFAULT_MAX_NODES, describeFilter, toFilterSpec } from '../../core/graph/filter'
import { bounds, canRunLive, layoutAlgorithmOf, layoutInfo, type Dimensions, type Positions } from '../../core/graph/layouts'
import type { Frame, LayoutRule } from '../../core/graph/placement'
import { describeRendering, toRenderingSpec, type RenderingData } from '../../core/graph/rendering'
import { describeAnalysis, fromAnalysisData, toAnalysisData } from '../../core/graph/metrics'
import { GRAPH_TYPES, type AnalysisData, type FilterData, type LayoutData } from '../../core/graph/types'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { diagramFromEntities, writeDiagram, type DiagramFormat } from '../../core/diagrams'
import { createDiagram } from '../diagrams/diagrams'
import { downloadText } from '../../lib/download'
import { DetailPane, type DetailTabs } from '../resources/DetailPane'

/** A table of the pane opened from the filter panel: every entity of a type, of a relationship type, or with a tag. */
export interface TableView {
  key: string
  kind: 'type' | 'rel' | 'tag'
  value: string
}

const DETAIL_TABS_KEY = 'aegraph:explorer:detail-tabs'
const DETAIL_MIN_KEY = 'aegraph:explorer:detail-min'
/** Which side panel is open (or none) — remembered across reloads like the detail pane's fold. */
const PANEL_KEY = 'aegraph:explorer:panel'
const PANELS: readonly { key: ExplorerSidePanel; label?: string; icon: typeof Filter; title: string }[] = [
  { key: 'filter', label: 'Filter', icon: Filter, title: 'Filter: what is in view — types, relationships, tags, a neighbourhood, a script' },
  { key: 'layout', label: 'Layout', icon: LayoutGrid, title: 'Layout: the algorithm, its parameters, held positions' },
  { key: 'style', label: 'Style', icon: Palette, title: 'Style: colours, sizes, shapes, edges and labels' },
  { key: 'stats', icon: BarChart3, title: 'Statistics and metrics' },
  { key: 'selection', icon: MousePointer2, title: 'Selection and path tools' },
]
const isPanel = (v: unknown): v is ExplorerSidePanel => PANELS.some((p) => p.key === v)
/** How long an explorer stays rendered while its page or tab is out of sight. */
const DORMANT_AFTER_MS = 60_000
const labelOf = (store: EntityStore, id: EntityId) => {
  const e = store.get(id)
  return e ? displayLabel(e) : id
}
/** Columns of the pane's nodes table: what tells nodes apart at a glance; the inspector has the rest. */
const NODE_ROW_FIELDS: FieldDef[] = [
  { key: 'type', label: 'Type', kind: 'text', width: 110 },
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 220 },
  { key: 'tags', label: 'Tags', kind: 'tags', editable: true, width: 180 },
  { key: 'meta.updatedAt', label: 'Updated', kind: 'datetime', width: 120 },
]
/** Columns of the pane's edges table: the link as source → type → target, each end with its type. */
const EDGE_ROW_FIELDS: FieldDef[] = [
  { key: 'source', label: 'Source', kind: 'ref', width: 200, withType: true },
  { key: 'type', label: 'Type', kind: 'text', width: 120, plain: true },
  { key: 'target', label: 'Target', kind: 'ref', width: 200, withType: true },
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 140 },
  { key: 'tags', label: 'Tags', kind: 'tags', editable: true, width: 160 },
]
import type { PathOptions } from '../../core/graph/paths'
import { ExplorerProvider, defaultState, reducer, useExplorer, type ExplorerState } from './explorerState'
import { explorerTool } from './explorerTool'
import { registerExplorerHandle, touchExplorerHandle, type ExplorerHandle, type ExplorerSidePanel } from './explorerHandle'
import { usePaneHost, useViewActive } from '../workstation/paneContext'
import { FilterPanel } from './FilterPanel'
import type { GraphViewHandle, Viewport } from './view'
// The view, on demand — and ahead of a refresh's arrival, behind the boot screen, when the address names it
// (`/unigraph/*`), so the picture follows the boot screen with no veil between.
const gpuChunk = chunk(() => import('../gpugraph/GpuGraph'))
registerPreload((p) => p === '/unigraph' || p.startsWith('/unigraph/'), () => [gpuChunk])
const GpuGraph = preloaded(gpuChunk, (m) => m.GpuGraph)
/** The view's dimensions, by its address segment: the engine's flat camera or its orbit camera. */
export type ExplorerMode = '2d' | '3d'
/** The mode an address or a scene names, the old tab names read as the engine's (`sceneDimensions`). */
const explorerMode = sceneDimensions
import { LargeGraphGate } from './LargeGraphGate'
import { LayoutPanel } from './LayoutPanel'
import { isGraphSceneType, type SceneCamera, type SceneData, type ScenePart, type SceneView, sceneDimensions, slidesViewOf } from '../../core/graph/scene'
import { isImageUrl } from '../../core/graph/thumbnail'
import { previewKey, readPreview, writePreview } from './previewCache'
import { previewDataUrl, PREVIEW_HEIGHT, PREVIEW_WIDTH } from './snapshot'
import { PartHeader } from './SavedPicker'
import { downloadBlob, downloadFiles, exportView, VIEW_EXPORT_LABELS, type ViewExportFormat } from './exportView'
import { Legend } from './Legend'
import { PipelineBar, type DatasetBarRequest } from './PipelineBar'
import { SceneSave } from './SceneSave'
import { DeleteDialog } from './GraphMenu'
import { CameraKeysHint, GraphNav, PathStatus } from './GraphNav'
import { useCameraKeys, useExplorerShortcuts } from './useExplorerShortcuts'
import { SelectionPanel } from './SelectionPanel'
import { StatsPanel } from './StatsPanel'
import { StylePanel } from './StylePanel'
import './GraphExplorer.css'
import { Select } from '../../components/ui/Select'

/** The rule a map's rows arrive with (`graphHref(…, geo)`): every one where it is on Earth, the shape kept. */
const GEO_RULE: LayoutRule = { kind: 'placement', selector: { scope: 'view' }, spec: { arrangement: 'geo', region: { of: 'viewport' } } }

/**
 * `/unigraph/2d` and `/unigraph/3d` — the same state, the engine's flat or orbit camera. `/unigraph` (the sidebar's
 * link) is the 2D view too: the address is corrected in place rather than by a redirect element, so a page kept
 * mounted behind another (KeptPages) is the same page when it comes back, not a fresh one. The old addresses
 * (`/graph/…`) are redirected here by the router, their query kept.
 */
export function GraphExplorer() {
  const { mode } = useParams()
  // In a pane host each tab is its own explorer session: its address carries a `session` that scopes its saved state.
  // The plain page (no pane) uses the unscoped state, as before.
  const [search, setSearch] = useSearchParams()
  const paneHost = usePaneHost()
  const session = search.get('session') ?? undefined
  useEffect(() => {
    if (!paneHost || session) return
    const next = new URLSearchParams(search)
    next.set('session', Math.random().toString(36).slice(2, 10))
    setSearch(next, { replace: true })
  }, [paneHost, session, search, setSearch])
  // `?only=<pick>` (`&fresh=1`: over an empty filter) goes into the state before the first render — see ExplorerShell,
  // which then only consumes the params. `?fresh=1` alone starts the tab from the explorer's defaults rather than the
  // last-used tab's filter, project, style and layout: the whole open project, unfiltered (the front door's view). Applied as an effect instead, the tab would first build (and start laying
  // out) the last-used filter's slice, and only then narrow to the pick.
  const onlyKey = search.get('only')
  const fresh = !!search.get('fresh')
  // `?scene=<id>` the same way, for the part that decides what the first slice is: the scene's filter, project and style
  // go into the state before the first render (the effect below loads the rest of it — layout, view, camera — as it
  // always has). Loaded by the effect alone, a tab opened on a scene first filtered, styled and seeded positions for
  // everything the last-used filter kept — on a fresh tab, the whole project: a million entities and a million
  // relationships, built and thrown away five seconds later, most of a 4 GB peak, for a scene of four thousand nodes.
  const sceneKey = search.get('scene')
  // `?physics=1`: the live simulation is the layout from the first frame. Switched on only by the effect in
  // ExplorerShell (400 ms after the view is up), the first resolve of positions took the tab's layout as asked for —
  // Force (Unigraph), 400 iterations in 3D on the main thread: 2.4 s frozen on the first visit's system map, for
  // positions the simulation replaced at once. With no scene the simulation is on from the start; a scene still loads
  // with physics off and is switched on after it (the picture that was saved is the one that comes alive), and until
  // then `livePending` keeps positions resolving as the simulation's.
  const physicsParam = search.get('physics')
  const liveWanted = physicsParam !== null && physicsParam !== '0' && physicsParam !== 'false'
  const liveFromStart = !sceneKey && liveWanted
  const store = useEntityStore()
  const seed = useMemo(() => {
    const base = seedFor()
    if (!liveWanted) return base
    return (s0: ExplorerState): ExplorerState => {
      const s = base ? base(s0) : s0
      if (!canRunLive(s.algorithm)) return s
      return liveFromStart ? reducer(s, { type: 'setPhysics', on: true }) : { ...s, livePending: true }
    }
    // The seed is read once, by the reducer's initialiser; a later param is the effect's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function seedFor(): ((s: ExplorerState) => ExplorerState) | undefined {
    const pick = onlyKey ? readPick(onlyKey) : undefined
    const scene = sceneKey ? store.get(sceneKey) : undefined
    const d = scene && isGraphSceneType(scene.type) ? (scene.data as SceneData) : undefined
    if (!pick && !d) return fresh ? () => defaultState() : undefined
    return (s0: ExplorerState): ExplorerState => {
      let s = s0
      if (d) {
        const f = d.filterId ? store.get(d.filterId) : undefined
        const r = d.renderingId ? store.get(d.renderingId) : undefined
        s = f ? reducer(s, { type: 'loadFilter', id: f.id, filter: toFilterSpec(f.data as FilterData) }) : reducer(s, { type: 'clearFilter' })
        s = reducer(s, { type: 'loadProject', id: d.projectId && store.get(d.projectId) ? d.projectId : undefined })
        if (r) s = reducer(s, { type: 'loadRendering', id: r.id, rendering: toRenderingSpec(r.data as RenderingData) })
        // The layout too — positions, algorithm, parameters — so the first resolve finds the scene's saved positions
        // rather than laying out the slice on the main thread before the effect below loads them (2.4 s on the
        // 373-node system map; the effect then loads the same layout again, which changes nothing).
        const l = d.layoutId ? store.get(d.layoutId) : undefined
        if (l && l.type === GRAPH_TYPES.layout) {
          const ld = l.data as LayoutData
          s = reducer(s, { type: 'loadLayout', id: l.id, positions: ld.positions ?? {}, algorithm: layoutAlgorithmOf(ld), pinned: ld.pinned, rule: ld.rule })
        }
        if (d.algorithm && layoutInfo(d.algorithm)) s = reducer(s, { type: 'setAlgorithm', algorithm: d.algorithm })
        if (d.params) s = reducer(s, { type: 'patchParams', patch: d.params })
      }
      if (!pick) return s
      const cleared = fresh ? reducer(s, { type: 'clearFilter' }) : s
      const picked = reducer(reducer(cleared, { type: 'patchFilter', patch: { only: pick.ids, script: pick.script, roots: [] } }), { type: 'select', ids: [], mode: 'replace' })
      // A map's rows come with the geographic placement as the rule in force, so no layout runs over them first; the
      // shell places them (rederive) once the slice holds them.
      return pick.geo ? reducer(reducer(picked, { type: 'setAlgorithm', algorithm: 'custom' }), { type: 'setLayoutRule', rule: GEO_RULE }) : picked
    }
  }
  const navigate = useNavigate()
  const known = mode === undefined || explorerMode(mode) !== undefined
  const home = '/unigraph/2d'
  useEffect(() => {
    if (mode === undefined) navigate(home, { replace: true })
  }, [mode, navigate, home])
  if (!known) return <Navigate to={home} replace />
  // Wait for the session before the state loads: mounted without one, the provider would take the plain page's
  // state (selection, gate answer and all) and carry it into the new tab, since the reducer initialises only once.
  if (paneHost && !session) return null
  return (
    <ExplorerProvider session={session} seed={seed}>
      <ExplorerShell session={session} />
    </ExplorerProvider>
  )
}

function ExplorerShell({ session }: { session?: string }) {
  const { mode } = useParams()
  const renderer: ExplorerMode = explorerMode(mode) ?? '2d'
  const dims: Dimensions = renderer === '3d' ? 3 : 2
  const navigate = useNavigate()
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const { state, dispatch, slice, sliceKey, load, gated, gateReason, runLayout, cancelLayout, removeOverlap, selectOp, computePath, primary, selectedSet, runMetrics, cancelMetrics, metricsStale, positionsFor, styles, values, dataset, resolve, placeNodes, transformNodes, rederiveLayout, pipeline, members } = useExplorer()
  const viewRef = useRef<GraphViewHandle>(null)
  // Whether this explorer is on screen (a kept page or a background tab is not): background work waits on it.
  const viewActive = useViewActive()
  // `?physics=1` (or 0), read once at mount: consuming the parameter changes the address, and an effect that watched it
  // would cancel its own timer on the way out. Held in a ref so the layout effects — which run before the switch is
  // thrown — already know a live simulation is coming and leave the positions to it.
  const wantedPhysics = useRef<boolean | null>(null)
  const [search0] = useSearchParams()
  if (wantedPhysics.current === null && search0.get('physics') !== null) wantedPhysics.current = search0.get('physics') !== '0' && search0.get('physics') !== 'false'
  /** A live simulation is placing the nodes: asked for in the address, or already running under a layout that runs live. */
  const liveLayout = () => wantedPhysics.current === true || (state.physics && canRunLive(state.algorithm))
  // `?scene=<id>` is loaded by an effect further down, after the ones that place nodes. Until it lands, the view still
  // holds whatever it had — the whole project, on a fresh tab — and laying that out would start a worker over tens of
  // thousands of nodes that the scene is about to replace with its own filter and its own saved positions. So nothing
  // is computed while a scene is on its way; the flag is state, not a ref, so the effects run again once it is in.
  const [scenePending, setScenePending] = useState(() => search0.get('scene') !== null)
  // The side panel: one of Filter, Layout, Style, Stats, Selection, opened by its button in the toolbar and closed by the
  // same button (or by Full view). Closed to begin with — the picture first — and remembered across reloads.
  const [panel, setPanelState] = useState<ExplorerSidePanel | null>(() => {
    const v = localStorage.getItem(PANEL_KEY)
    return isPanel(v) ? v : null
  })
  const panelRef = useRef(panel)
  panelRef.current = panel
  // The panel Full view folded away, so leaving full view brings the same one back.
  const lastPanel = useRef<ExplorerSidePanel>(panel ?? 'filter')
  const inspector = useResizableWidth({ storageKey: 'aegraph:explorer:inspector-width', initial: 360, min: 280, max: 800, edge: 'start' })
  // The detail pane's tabs: the selection first, then whatever was opened from inside a detail view. Remembered in this
  // browser per explorer session — a new tab starts with none, the way it starts unselected.
  const detailTabsKey = session ? `${DETAIL_TABS_KEY}:${session}` : DETAIL_TABS_KEY
  const [detailTabState, setDetailTabState] = useState<DetailTabs>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(detailTabsKey) ?? 'null') as DetailTabs | null
      return saved && Array.isArray(saved.pinned) ? { pinned: saved.pinned.filter((id) => store.has(id)), active: 'selection' } : { pinned: [], active: 'selection' }
    } catch {
      return { pinned: [], active: 'selection' }
    }
  })
  // Tables opened from the filter panel — every entity of a type, of a relationship type, with a tag — as closable tabs of the pane.
  const [tableViews, setTableViews] = useState<TableView[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${detailTabsKey}:views`) ?? '[]') as TableView[]
      return Array.isArray(saved) ? saved.filter((v) => v && typeof v.value === 'string' && (v.kind === 'type' || v.kind === 'rel' || v.kind === 'tag')) : []
    } catch {
      return []
    }
  })
  const detailTabs = {
    tabs: detailTabState,
    set: (next: DetailTabs) => {
      setDetailTabState(next)
      try {
        localStorage.setItem(detailTabsKey, JSON.stringify({ pinned: next.pinned, active: 'selection' }))
      } catch {
        /* ignore */
      }
    },
  }
  const openTableView = (view: Omit<TableView, 'key'>) => {
    const key = `${view.kind}:${view.value}`
    setTableViews((vs) => {
      const next = vs.some((v) => v.key === key) ? vs : [...vs, { ...view, key }]
      try {
        localStorage.setItem(`${detailTabsKey}:views`, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
    setDetailMinimized(false)
    detailTabs.set({ ...detailTabs.tabs, active: `view:${key}` })
  }
  const closeTableView = (key: string) => {
    setTableViews((vs) => {
      const next = vs.filter((v) => v.key !== key)
      try {
        localStorage.setItem(`${detailTabsKey}:views`, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
    if (detailTabs.tabs.active === `view:${key}`) detailTabs.set({ ...detailTabs.tabs, active: 'lead' })
  }
  // The pane folds to a strip rather than closing: it only goes away when it has no tabs. A new selection unfolds it.
  const [detailMin, setDetailMin] = useState(() => localStorage.getItem(DETAIL_MIN_KEY) === '1')
  // Maximized, the panel has the row to itself and the stage waits behind it (it re-measures when it comes back).
  const [detailMax, setDetailMax] = useState(false)
  const setDetailMinimized = (v: boolean) => {
    setDetailMin(v)
    try {
      localStorage.setItem(DETAIL_MIN_KEY, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  const [sideWidth, setSideWidth] = useState(() => {
    const v = Number(localStorage.getItem('aegraph:explorer:side-width'))
    return v >= 200 && v <= 640 ? v : 300
  })
  const sideRef = useRef<HTMLElement>(null)
  // Opening a panel is leaving full view: the app's sidebar unfolds when full view was what folded it, so a sidebar the
  // user had already folded stays folded. The stage holds its picture still either way (the resize rule in Graph2D and
  // the GPU engine); only Full view refits.
  const railFoldedByFullView = useRef(false)
  const openPanel = (next: ExplorerSidePanel | null) => {
    if (panelRef.current) lastPanel.current = panelRef.current
    setPanelState(next)
    try {
      localStorage.setItem(PANEL_KEY, next ?? 'none')
    } catch {
      /* ignore */
    }
    if (next && railFoldedByFullView.current) {
      railFoldedByFullView.current = false
      setSidebarRail(false)
    }
  }
  const togglePanel = (p: ExplorerSidePanel) => openPanel(panelRef.current === p ? null : p)
  // Full view: the side panel closes and the picture takes its width; the same button brings the panel back. The app's
  // sidebar folds to its rail with it. The details panel and the assistant are not touched: they are the user's to open
  // and close. The camera refits so nothing is off-screen.
  const setFullView = (on: boolean) => {
    if (on) {
      openPanel(null)
      railFoldedByFullView.current = !isSidebarRail()
      setSidebarRail(true)
    } else openPanel(lastPanel.current)
    setTimeout(() => viewRef.current?.fit(), 50)
  }
  // The renderers size themselves on window resize; the stage also changes size on its own — the detail panel opening or
  // being dragged, a pane split moved, a hidden tab shown again — so a stage resize is announced the same way.
  const stageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false)
      window.dispatchEvent(new Event('resize'))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const startSideResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const left = sideRef.current?.getBoundingClientRect().left ?? 0
    const move = (ev: PointerEvent) => setSideWidth(Math.max(200, Math.min(640, ev.clientX - left)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('gx-resizing')
      setSideWidth((w) => (localStorage.setItem('aegraph:explorer:side-width', String(w)), w))
    }
    document.body.classList.add('gx-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [diagramMenu, setDiagramMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  /** ⌫ on a selection asks first, the same dialog the right-click menu's Delete uses. */
  const [deleting, setDeleting] = useState<{ ids: EntityId[]; what: 'node' | 'relationship' } | null>(null)
  const requestDelete = useCallback((ids: EntityId[]) => setDeleting({ ids, what: 'node' }), [])
  useExplorerShortcuts(viewRef, requestDelete)
  useCameraKeys(viewRef)
  const [datasetRequest, setDatasetRequest] = useState<DatasetBarRequest>({})

  // The current view as a diagram: types become clusters, relationships become labelled edges.
  const viewAsDiagram = (format: DiagramFormat, save: boolean) => {
    const name = state.filterId ? displayLabel(store.get(state.filterId)!) : describeFilter(state.filter)
    const d = diagramFromEntities(slice.nodes, slice.edges, registry, { name: 'view' })
    const src = writeDiagram(d, format)
    if (save) {
      const e = createDiagram(store, { label: `View: ${name}`, source: src, format, tags: ['from-graph-view'], source_: 'export:graph' })
      toast('Saved as a diagram')
      navigate(`/diagrams/${e.id}`)
    } else downloadText(`view.${format === 'dot' ? 'dot' : 'mmd'}`, src, 'text/plain')
  }

  const exportViewAs = async (format: ViewExportFormat) => {
    try {
      const name = state.filterId ? displayLabel(store.get(state.filterId)!).replace(/[^\w.-]+/g, '-') : 'graph-view'
      const r = await exportView(format, { slice, positions: drawnPositions(), styles, registry, rendering: state.rendering, labels: state.labels, snapshot: (o) => viewRef.current?.snapshot(o) ?? Promise.resolve(null), name })
      if (r instanceof Blob) downloadBlob(`${name}.png`, r)
      else downloadFiles(r)
      toast(`Exported ${VIEW_EXPORT_LABELS[format]}`)
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // First paint / explicit reset: compute positions once so they're held. A page or tab behind another (kept
  // mounted) waits: two explorers over the same big view would otherwise each run a layout worker for nothing.
  const lastToken = useRef(0)
  useEffect(() => {
    if (state.restoring !== undefined) return
    // The first run after mount: positions that were held (restored from storage, or a saved layout) are the
    // picture — nothing is recomputed over them; nodes without one are placed by the effect below. Only an explicit
    // Recompute (a new token) or a view with nothing held runs the algorithm here.
    const first = lastToken.current === 0
    const held = state.positions.size
    if (first && held > 0) lastToken.current = state.recomputeToken
    const needs = lastToken.current !== state.recomputeToken || (held === 0 && !state.layoutId)
    // A gated view is not drawn, so its layout can wait for the trim.
    // A live simulation is the layout: a one-shot run beside it would fight it for the same positions, so the seed
    // cloud is left for the simulation to work on (this is how a view opened with `?physics=1` starts).
    if (needs && slice.nodes.length && !gated && viewActive && !scenePending && !liveLayout()) {
      lastToken.current = state.recomputeToken
      void runLayout(dims)
    }
    // Keyed on what is in the view, not on the slice object: the store changing under a running layout (a script's
    // last run, an entity opened, a write from a tool) rebuilds the slice with the same nodes, and restarting the
    // worker for that — with no positions held until it finishes — kept a big layout from ever finishing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.recomputeToken, sliceKey, state.layoutId, gated, viewActive, state.restoring, scenePending])

  // Nodes waiting for a position and no layout under way — held positions with too many missing for the main
  // thread, or none at all after an aborted run (a remount mid-layout): the worker places them. Never a veil with
  // nothing behind it. A view behind another waits until it is in front.
  // A layout that refused or failed is not retried here — the veil says why and offers the button; a new run clears the error.
  useEffect(() => {
    if (!gated && viewActive && !scenePending && state.restoring === undefined && positionsFor(dims).pending && !state.layoutJob && !state.layoutError && !liveLayout()) void runLayout(dims, state.positions.size ? 'missing' : 'all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsFor, dims, gated, state.layoutJob, state.layoutError, viewActive, state.restoring, state.physics, state.algorithm, scenePending])

  // A saved analysis was loaded last time but its columns aren't in memory (fresh page): pull them from the entity.
  useEffect(() => {
    if (state.analysisId && !state.metrics) {
      const e = store.get(state.analysisId)
      if (e && e.type === GRAPH_TYPES.analysis) dispatch({ type: 'loadAnalysis', id: e.id, result: fromAnalysisData(e.data as AnalysisData) })
      else dispatch({ type: 'clearMetrics' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.analysisId])

  // Switching 2D↔3D keeps every held position: a layout is the same layout in both views (3D reads z, or 0). Only an empty view gets computed.
  const lastDims = useRef(dims)
  useEffect(() => {
    if (lastDims.current !== dims) {
      lastDims.current = dims
      if (state.positions.size === 0 && slice.nodes.length) void runLayout(dims)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims])

  // `/unigraph/2d?scene=<id>` opens straight onto a saved scene (workstation tabs and links use this). The param is consumed once loaded.
  const [search, setSearch] = useSearchParams()
  // 2D ↔ 3D is the same route element with another `mode`: keep the search (the pane's `session` above all), so only
  // the canvas changes — the panels, the pane and the picture stay put. Dropping the session would remount everything.
  // The rectangle in view is handed to the other renderer, which frames the same one first: the picture stays where it is.
  const handoff = useRef<Viewport | undefined>(undefined)
  const switchMode = (m: ExplorerMode) => {
    if (m === renderer) return
    handoff.current = viewRef.current?.getViewport() ?? undefined
    const q = search.toString()
    navigate({ pathname: `/unigraph/${m}`, search: q ? `?${q}` : '' })
  }
  useEffect(() => {
    // The mounted renderer took the rectangle at mount; a later remount of the same one must not reuse it.
    handoff.current = undefined
  }, [renderer])
  const sceneParam = search.get('scene')
  useEffect(() => {
    if (!sceneParam) {
      setScenePending(false)
      return
    }
    const e = store.get(sceneParam)
    if (e && isGraphSceneType(e.type)) loadScene(e)
    setScenePending(false)
    setSearch(
      (p) => {
        p.delete('scene')
        return p
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneParam])

  // `?filter=<id>`, `?layout=<id>`, `?style=<id>`, `?analysis=<id>`: one saved part loaded into the current picture (the
  // Entities table and the inspector link here). Consumed once loaded, like `?scene=`.
  const partParam = (['filter', 'layout', 'style', 'analysis'] as const).map((k) => [k, search.get(k)] as const).find(([, v]) => v)
  const partKey = partParam?.[0]
  const partId = partParam?.[1]
  useEffect(() => {
    if (!partKey || !partId) return
    const e = store.get(partId)
    if (e) {
      if (partKey === 'filter' && e.type === GRAPH_TYPES.filter) loadFilterEntity(e)
      else if (partKey === 'layout' && e.type === GRAPH_TYPES.layout) loadLayoutEntity(e)
      else if (partKey === 'style' && e.type === GRAPH_TYPES.rendering) loadRenderingEntity(e)
      else if (partKey === 'analysis' && e.type === GRAPH_TYPES.analysis) dispatch({ type: 'loadAnalysis', id: e.id, result: fromAnalysisData(e.data as AnalysisData) })
      else toast(`${displayLabel(e)} is not a saved ${partKey}`)
    }
    setSearch(
      (p) => {
        p.delete(partKey)
        return p
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partKey, partId])

  // `?physics=1` (or 0): start — or stop — the live simulation once the view is up. A scene loads with physics off,
  // since a running simulation would move the picture away from the one that was saved; a tab that wants the picture
  // alive (a demo's opening view) says so in its address. Applied after the scene, and only where a layout can run live.
  // `?fresh=1` without a pick was the seed's (GraphExplorer) and is spent here too, so a reload keeps what was done
  // since: in the same change of address, as two would each start from the address as it was and put the other back.
  useEffect(() => {
    const on = wantedPhysics.current
    const spentFresh = search0.get('fresh') !== null && !search0.get('only')
    if (on === null && !spentFresh) return
    const timers: ReturnType<typeof setTimeout>[] = []
    // After the scene's own dispatches, and once the renderer has the picture: the simulation starts from what is drawn.
    if (on !== null)
      timers.push(
        setTimeout(() => {
          // The ref stays `true` until the switch is thrown, so nothing starts a one-shot layout in the meantime; `false`
          // (an address that asked for the simulation off) is spent here.
          if (!on) wantedPhysics.current = null
          // Over a picture whose every node is already placed (a scene with its saved positions), the simulation starts
          // warm — cool enough to settle it rather than re-form it — and the camera stays where the picture opened.
          const { state: st, slice: sl } = live.current
          const placed = sl.nodes.length > 0 && sl.nodes.every((n) => st.positions.get(n.id))
          dispatch({ type: 'setPhysics', on, warm: on && placed })
          // A simulation from scratch moves the picture away from the fit it opened on — it draws in, then spreads.
          // Framed again as it takes shape, so a view that opens alive is looked at, not hunted for.
          if (on && !placed) for (const ms of [1600, 4600, 8600]) timers.push(setTimeout(() => viewRef.current?.fit(), ms))
        }, 400),
      )
    setSearch(
      (p) => {
        p.delete('physics')
        if (spentFresh) p.delete('fresh')
        return p
      },
      { replace: true },
    )
    return () => {
      for (const t of timers) clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `/unigraph/2d?sel=a,b,c` selects those nodes and frames them (plots and lists link here). Consumed once applied;
  // nodes the filter hides are simply not selected.
  const selParam = search.get('sel')
  useEffect(() => {
    if (!selParam) return
    const ids = selParam.split(',').map((x) => x.trim()).filter(Boolean)
    dispatch({ type: 'select', ids, mode: 'replace' })
    setTimeout(() => viewRef.current?.fitTo(ids, { padding: 0.35 }), 400)
    setSearch(
      (p) => {
        p.delete('sel')
        return p
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selParam])

  // `/unigraph/2d?only=<key>` restricts the view to a table's rows (a pick handed over by `graphHref`); with `&fresh=1`
  // (“open in new graph”) the rest of the filter is cleared too, so the tab shows just those entities. Consumed once applied.
  const onlyParam = search.get('only')
  const freshParam = search.get('fresh')
  /** A geographic pick waits for the slice to hold its nodes, then places them where they are and frames them. */
  const geoPending = useRef(false)
  useEffect(() => {
    if (!geoPending.current || !slice.nodes.length) return
    geoPending.current = false
    live.current.rederiveLayout(frameNow())
    setTimeout(() => viewRef.current?.fit(), 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliceKey])
  useEffect(() => {
    if (!onlyParam) return
    const pick = readPick(onlyParam)
    if (pick) {
      // Already in the state when the pick came with the address (GraphExplorer seeds it); a pick arriving later
      // — a link into a mounted tab — is applied here.
      if (state.filter.only !== pick.ids) {
        if (freshParam) dispatch({ type: 'clearFilter' })
        dispatch({ type: 'patchFilter', patch: { only: pick.ids, script: pick.script, roots: [] } })
        dispatch({ type: 'select', ids: [], mode: 'replace' })
        if (pick.geo) {
          dispatch({ type: 'setAlgorithm', algorithm: 'custom' })
          dispatch({ type: 'setLayoutRule', rule: GEO_RULE })
        }
      }
      if (pick.geo) geoPending.current = true
      else setTimeout(() => viewRef.current?.fit(), 500)
    }
    setSearch(
      (p) => {
        p.delete('only')
        p.delete('fresh')
        return p
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyParam])

  const selected = state.selectedEdgeId ? store.get(state.selectedEdgeId) : primary ? store.get(primary) : undefined
  // Picking something new is a reason to see it: the folded pane opens again, and the selection tab comes to the
  // front — unless the pick was made in one of the pane's own tables, which stays where the pointer is. With nothing
  // selected the pane shows the Nodes table under the name of the selection tab, so a pick made there names the
  // table it was made in, or the selection would cover it.
  const lastSelected = useRef(selected?.id)
  const pickedInTable = useRef<'lead:nodes' | 'lead:edges' | null>(null)
  useEffect(() => {
    if (selected?.id && selected.id !== lastSelected.current) {
      setDetailMinimized(false)
      const table = pickedInTable.current
      const onLead = detailTabs.tabs.active === 'lead' || detailTabs.tabs.active.startsWith('lead:')
      if (!table && onLead) detailTabs.set({ ...detailTabs.tabs, active: 'selection' })
      else if (table && !onLead && !detailTabs.tabs.active.startsWith('view:')) detailTabs.set({ ...detailTabs.tabs, active: table })
    }
    pickedInTable.current = null
    lastSelected.current = selected?.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])
  /**
   * Bring nodes into view without changing the zoom when they fit at it — the camera flies to their centre; when they
   * would not fit it zooms out to frame them, generously, and when they would be a dot — the view many times wider
   * than a neighbourhood around them — it zooms in to that neighbourhood, so a pick on a big graph shows the node,
   * not a pixel. (3D frames them.) The renderer chooses the flight's time from its length. While physics runs the
   * nodes are where the renderer has moved them, not where they were held.
   */
  const goTo = (ids: EntityId[]) => {
    const inView = ids.filter((id) => slice.nodes.some((n) => n.id === id))
    if (!inView.length) return
    const pos = (state.physics && viewRef.current?.getLivePositions()) || positionsFor(dims).positions
    if (dims === 3) {
      // Slide the camera so the picked nodes' centre is what it looks at, keeping its distance; frame them only
      // when they are spread wider than that distance covers.
      const cam = viewRef.current?.getCamera()
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (const id of inView) {
        const p = pos[id] as { x: number; y: number; z?: number } | undefined
        if (!p) continue
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); minZ = Math.min(minZ, p.z ?? 0); maxZ = Math.max(maxZ, p.z ?? 0)
      }
      if (!Number.isFinite(minX)) return
      const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
      if (cam?.kind === '3d') {
        const dist = Math.hypot(cam.position.x - cam.lookAt.x, cam.position.y - cam.lookAt.y, cam.position.z - cam.lookAt.z)
        const spread = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
        if (spread < dist * 0.8) {
          const d = { x: c.x - cam.lookAt.x, y: c.y - cam.lookAt.y, z: c.z - cam.lookAt.z }
          viewRef.current?.setCamera({ position: { x: cam.position.x + d.x, y: cam.position.y + d.y, z: cam.position.z + d.z }, lookAt: c }, 400)
          return
        }
      }
      return viewRef.current?.fitTo(inView, { padding: 0.5 })
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id of inView) {
      const p = pos[id]
      if (!p) continue
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    if (!Number.isFinite(minX)) return
    const vp = viewRef.current?.getViewport()
    const fits = vp && maxX - minX <= (vp.maxX - vp.minX) * 0.8 && maxY - minY <= (vp.maxY - vp.minY) * 0.8
    if (!fits) return viewRef.current?.fitTo(inView, { padding: 1 })
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    // A neighbourhood: a dozen typical node spacings (the picture's area shared out among its nodes) around the box.
    const b = bounds(pos)
    const spacing = Math.sqrt(Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY)) / Math.max(1, slice.nodes.length))
    const window = Math.max(maxX - minX, maxY - minY) + spacing * 12
    const cam = viewRef.current?.getCamera()
    const width = vp.maxX - vp.minX
    // Both renderers' `ratio` grows with the width in view, so scaling it by the widths gives the zoom that shows the window.
    if (cam && cam.kind === '2d' && width > window * 4) viewRef.current?.setCamera({ center, ratio: cam.ratio * (window / width) })
    else viewRef.current?.setCamera({ center })
  }
  /** A double-click in the pane's tables: the entity as a tab of its own, in front; the selection is not touched. */
  const openAsTab = (e: AnyEntity) => detailTabs.set({ pinned: detailTabs.tabs.pinned.includes(e.id) ? detailTabs.tabs.pinned : [...detailTabs.tabs.pinned, e.id], active: e.id })
  /** The pane's first tab: every node in view as a table, to look at and pick from — a click selects a row at once and flies the camera to it (the selection tab follows); a double-click opens the entity as a tab of its own. */
  const nodesTable = (entities: AnyEntity[] = slice.nodes, storageKey = 'aegraph:explorer:nodes') => (
    <div className="dp-pane__lead">
      <EntityTable
        entities={entities}
        fields={NODE_ROW_FIELDS}
        selected={selectedSet}
        onSelectedChange={(next) => {
          pickedInTable.current = 'lead:nodes'
          const ids = [...next]
          dispatch({ type: 'select', ids, mode: 'replace' })
          goTo(ids)
        }}
        onOpen={openAsTab}
        onDelete={() => {}}
        readOnly
        storageKey={storageKey}
        emptyMessage="Nothing in view."
      />
    </div>
  )
  /** The pane's second tab: every edge in view, read-only likewise; picking a row selects that edge and frames its two ends; double-click opens it as a tab. */
  const edgesTable = (entities: AnyEntity[] = slice.edges, storageKey = 'aegraph:explorer:edges') => (
    <div className="dp-pane__lead">
      <EntityTable
        entities={entities}
        fields={EDGE_ROW_FIELDS}
        selected={state.selectedEdgeId ? new Set([state.selectedEdgeId]) : new Set()}
        onSelectedChange={(next) => {
          pickedInTable.current = 'lead:edges'
          const id = [...next].pop()
          dispatch({ type: 'selectEdge', id })
          const edge = id ? entities.find((r) => r.id === id) : undefined
          if (edge && isRelationship(edge)) goTo([edge.source.id, edge.target.id])
        }}
        onOpen={openAsTab}
        onDelete={() => {}}
        readOnly
        storageKey={storageKey}
        emptyMessage="No edges in view."
      />
    </div>
  )
  /** A table view's rows: every entity of the type / relationship type / with the tag in the dataset, not only what is drawn. */
  const tableViewRows = (v: TableView): AnyEntity[] => (v.kind === 'type' ? store.ofType(v.value).filter((e) => !isRelationship(e)) : v.kind === 'rel' ? store.ofType(v.value).filter(isRelationship) : store.query({ kind: 'entity', tags: [v.value] }))
  const tableViewTitle = (v: TableView) => (v.kind === 'type' ? (registry.get(v.value).pluralLabel ?? registry.get(v.value).label) : v.kind === 'rel' ? v.value : `#${v.value}`)
  // The Physics switch: a dynamic layout the engine runs live (the Layout tab's Keep running is the same switch).
  const physicsOk = canRunLive(state.algorithm)

  /**
   * The positions as drawn: the held ones, and — while physics runs or a drag is under way — what the renderer has
   * moved them to since. A save, an export or a tool read while the simulation runs gets the picture on screen, and
   * the held state is brought up to date with it so a later load starts from exactly there.
   */
  const drawnPositions = (): Positions => {
    if (!state.physics) return positionsFor(dims).positions
    const live = viewRef.current?.getLivePositions()
    if (!live) return positionsFor(dims).positions
    dispatch({ type: 'moveNodes', positions: live, dirty: true })
    return { ...state.positions.asObject(), ...live }
  }
  // Expose the explorer to the assistant tools while this page is mounted.
  const live = useRef({ state, slice, load, gated, gateReason, runLayout, removeOverlap, selectOp, computePath, runMetrics, cancelMetrics, metricsStale, positionsFor, drawnPositions, styles, values, dataset, resolve, placeNodes, transformNodes, rederiveLayout, pipeline, members })
  live.current = { state, slice, load, gated, gateReason, runLayout, removeOverlap, selectOp, computePath, runMetrics, cancelMetrics, metricsStale, positionsFor, drawnPositions, styles, values, dataset, resolve, placeNodes, transformNodes, rederiveLayout, pipeline, members }
  /** Placement frame: the visible rectangle when the renderer is up, else the bbox of everything held. */
  const frameNow = (): Frame => {
    const b = bounds(live.current.positionsFor(dims).positions)
    const bbox = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }
    const vp = viewRef.current?.getViewport()
    return { viewport: vp && vp.maxX > vp.minX ? vp : bbox, bbox }
  }
  const handleRef = useRef<ExplorerHandle | null>(null)
  // `captureView` is defined below the handle (it reads the save helpers); the handle reaches it through this ref.
  const captureRef = useRef<() => Promise<{ view: SceneView; preview?: string; stats: { nodes: number; edges: number } }>>(() => Promise.resolve({ view: {}, stats: { nodes: 0, edges: 0 } }))
  const detailRef = useRef({ tabs: detailTabState, min: detailMin })
  detailRef.current = { tabs: detailTabState, min: detailMin }
  useEffect(() => {
    const handle: ExplorerHandle = {
      dims,
      describeDetail: () => {
        const { tabs, min } = detailRef.current
        if (min) return 'folded'
        const pinned = tabs.pinned.length ? ` · pinned tabs: ${tabs.pinned.map((id) => `${labelOf(store, id)} (id=${id})`).join(', ')}` : ''
        const active = tabs.active === 'lead' || tabs.active === 'lead:nodes' ? 'the Nodes table (every node in view)' : tabs.active === 'lead:edges' ? 'the Edges table (every edge in view)' : tabs.active === 'selection' ? 'the selection' : `${labelOf(store, tabs.active)} (id=${tabs.active})`
        return `showing ${active}${pinned}`
      },
      getState: () => {
        const st = live.current.state
        // The handle hands out plain positions: a tool reads them as an object, and the held store materialises
        // one (cached until the next move) rather than every reader learning the store.
        return { ...st, positions: st.positions.asObject(), selectedId: st.selectedIds.length ? st.selectedIds[st.selectedIds.length - 1] : undefined, metricsSummary: st.metrics?.summary, metricsStale: live.current.metricsStale, metricsRunning: !!st.metricsJob, layoutRunning: !!st.layoutJob }
      },
      getSlice: () => live.current.slice,
      getLoad: () => live.current.load,
      isGated: () => live.current.gated,
      gateReason: () => live.current.gateReason,
      acceptLoad: (load) => dispatch({ type: 'acceptLoad', load }),
      setViewBudget: (budget) => dispatch({ type: 'setViewBudget', budget }),
      getStyles: () => live.current.styles,
      getPositions: () => live.current.drawnPositions(),
      snapshot: async (opts) => (await viewRef.current?.snapshot(opts)) ?? null,
      getDataset: () => live.current.dataset,
      getPipeline: () => live.current.pipeline,
      getTotals: () => datasetTotals(store, registry, live.current.members),
      getValueContext: () => live.current.values,
      resolve: (sel) => live.current.resolve(sel),
      getViewport: () => viewRef.current?.getViewport() ?? null,
      getCamera: () => viewRef.current?.getCamera() ?? null,
      setCamera: (target, ms) => viewRef.current?.setCamera(target, ms),
      fitTo: (ids, opts) => viewRef.current?.fitTo(ids, opts),
      panBy: (fx, fy) => viewRef.current?.panBy(fx, fy, { fraction: true }),
      zoomBy: (factor) => viewRef.current?.zoomBy(factor),
      orbitBy: (yaw, pitch) => viewRef.current?.orbitBy(yaw, pitch),
      getFrame: frameNow,
      setPositions: (positions, opts) => {
        // Positions set outright are the layout now: the Layout tab reads Custom positions, and no run recomputes them.
        dispatch({ type: 'setAlgorithm', algorithm: 'custom' })
        if (opts?.merge === false) dispatch({ type: 'setPositions', positions, dirty: true })
        else dispatch({ type: 'moveNodes', positions })
      },
      place: (selector, spec) => live.current.placeNodes(selector, spec, frameNow()),
      transformPositions: (ids, op) => live.current.transformNodes(ids, op),
      rederiveLayout: () => live.current.rederiveLayout(frameNow()),
      setLayoutRule: (rule) => dispatch({ type: 'setLayoutRule', rule }),
      setPlacementOverlay: (on) => dispatch({ type: 'showPlacementOverlay', on }),
      setAnalysisAuto: (on) => dispatch({ type: 'setAnalysisAuto', on }),
      loadProject: (id) => dispatch({ type: 'loadProject', id }),
      getMetrics: () => live.current.state.metrics,
      runMetrics: (options) => live.current.runMetrics(options),
      cancelMetrics: () => live.current.cancelMetrics(),
      loadAnalysis: (id, result) => dispatch({ type: 'loadAnalysis', id, result }),
      markAnalysisSaved: (id) => dispatch({ type: 'markAnalysisSaved', id }),
      clearMetrics: () => dispatch({ type: 'clearMetrics' }),
      setLegend: (on) => dispatch({ type: 'setLegend', on }),
      setSlides: (patch) => flushSync(() => dispatch({ type: 'setSlides', patch })),
      faceSlide: (id, ms) => viewRef.current?.faceSlide?.(id, ms) ?? false,
      setFilter: (filter) => dispatch({ type: 'setFilter', filter }),
      loadFilter: (id, filter) => dispatch({ type: 'loadFilter', id, filter }),
      clearFilter: () => dispatch({ type: 'clearFilter' }),
      markFilterSaved: (id) => dispatch({ type: 'markFilterSaved', id }),
      // Rendered before returning: a tool sets these and calls runLayout in the same tick, and runLayout must see
      // what was just set — the graph_layout tool used to compute the algorithm it had just replaced.
      setAlgorithm: (algorithm) => flushSync(() => dispatch({ type: 'setAlgorithm', algorithm })),
      patchParams: (patch) => flushSync(() => dispatch({ type: 'patchParams', patch })),
      loadLayout: (id, positions, algorithm, pinned, rule) => dispatch({ type: 'loadLayout', id, positions, algorithm, pinned, rule }),
      unloadLayout: () => flushSync(() => dispatch({ type: 'unloadLayout' })),
      markLayoutSaved: (id) => dispatch({ type: 'markLayoutSaved', id }),
      runLayout: (scope) => live.current.runLayout(dims, scope),
      switchMode,
      renderer,
      removeOverlap: () => live.current.removeOverlap(),
      setRendering: (rendering) => dispatch({ type: 'setRendering', rendering }),
      patchRendering: (patch) => dispatch({ type: 'patchRendering', patch }),
      setRule: (scope, by, key, patch) => dispatch({ type: 'setRule', scope, by, key, patch }),
      loadRendering: (id, rendering) => dispatch({ type: 'loadRendering', id, rendering }),
      clearRendering: () => dispatch({ type: 'clearRendering' }),
      markRenderingSaved: (id) => dispatch({ type: 'markRenderingSaved', id }),
      select: (id) => dispatch({ type: 'select', ids: id ? [id] : [], mode: 'replace' }),
      setSelection: (ids, mode) => dispatch({ type: 'select', ids, mode }),
      selectOp: (op) => live.current.selectOp(op),
      selectEdge: (id) => dispatch({ type: 'selectEdge', id }),
      setPinned: (ids) => flushSync(() => dispatch({ type: 'setPinned', ids })),
      setTool: (tool) => dispatch({ type: 'setTool', tool }),
      setPathOptions: (patch) => dispatch({ type: 'setPathOptions', patch }),
      computePath: (from, to) => live.current.computePath(from, to),
      clearPath: () => dispatch({ type: 'setPath', path: undefined }),
      setHops: (hops) => dispatch({ type: 'setHops', hops }),
      setLabels: (labels) => dispatch({ type: 'setLabels', labels }),
      setShowEdges: (on) => {
        if (live.current.state.showEdges !== on) dispatch({ type: 'toggleEdges' })
      },
      setPhysics: (on) => dispatch({ type: 'setPhysics', on }),
      fit: () => viewRef.current?.fit(),
      setFullView,
      isFullView: () => panelRef.current === null,
      setPanel: openPanel,
      getPanel: () => panelRef.current,
      setScene: (id) => dispatch({ type: 'setScene', id }),
      captureView: () => captureRef.current(),
    }
    handleRef.current = handle
    return registerExplorerHandle(handle)
  }, [dims, dispatch])
  // `/unigraph/2d?setup=<key>` — a finding or a tool opened this tab with a filter, style, layout and selection of its own
  // (see graphSetupHref). Applied through the tab's own handle once it is registered; consumed once applied.
  const setupParam = search.get('setup')
  useEffect(() => {
    if (!setupParam) return
    const setup = readGraphSetup(setupParam)
    setSearch(
      (p) => {
        p.delete('setup')
        return p
      },
      { replace: true },
    )
    if (!setup) return
    const h = handleRef.current
    if (h) void applyGraphSetup(h, setup).catch((e) => toast(e instanceof Error ? e.message : String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupParam])

  const touch = () => handleRef.current && touchExplorerHandle(handleRef.current)
  // Coming to the front — the page, or the workstation tab — makes this the explorer tools talk to.
  useEffect(() => {
    if (viewActive) touch()
  }, [viewActive]) // eslint-disable-line react-hooks/exhaustive-deps
  // A page or tab left behind keeps its explorer state — filter, positions, selection, camera — but not its
  // renderer: after a minute out of sight the canvas (two WebGL contexts, a force worker) is let go, and comes
  // back on return from the same state, so a dozen kept graphs do not hold a dozen GPU contexts.
  const [dormant, setDormant] = useState(false)
  useEffect(() => {
    if (viewActive) {
      setDormant(false)
      return
    }
    const t = setTimeout(() => setDormant(true), DORMANT_AFTER_MS)
    return () => clearTimeout(t)
  }, [viewActive])

  // ── Saved filters ─────────────────────────────────────────────────────
  const saveFilter = (name: string, existing?: AnyEntity): EntityId => {
    const data: FilterData = { ...state.filter }
    if (existing) {
      store.update(existing.id, { label: name, data })
      dispatch({ type: 'markFilterSaved', id: existing.id })
      return existing.id
    }
    const e = createEntity<FilterData>({ type: GRAPH_TYPES.filter, label: name, data, tags: [], meta: { source: 'user' } })
    store.upsert(e)
    dispatch({ type: 'markFilterSaved', id: e.id })
    return e.id
  }

  // ── Saved layouts ─────────────────────────────────────────────────────
  const saveLayout = (name: string, existing?: AnyEntity): EntityId => {
    // Everything currently held (visible or not), merged over what the saved layout already knew,
    // so reloading the layout reproduces exactly what the user has been looking at across filters.
    const prev = (existing?.data as LayoutData | undefined)?.positions ?? {}
    const positions = { ...prev, ...state.positions.asObject(), ...(state.physics ? viewRef.current?.getLivePositions() : undefined) }
    const data: LayoutData = { positions, algorithm: state.algorithm, dimensions: dims, pinned: state.pinned, ...(state.layoutRule ? { rule: state.layoutRule } : {}) }
    if (existing) {
      store.update(existing.id, { label: name, data })
      dispatch({ type: 'markLayoutSaved', id: existing.id })
      return existing.id
    }
    const e = createEntity<LayoutData>({ type: GRAPH_TYPES.layout, label: name, data, tags: [], meta: { source: 'user' } })
    store.upsert(e)
    dispatch({ type: 'markLayoutSaved', id: e.id })
    return e.id
  }

  // ── Saved styles ──────────────────────────────────────────────────────
  const saveRendering = (name: string, existing?: AnyEntity): EntityId => {
    const data: RenderingData = { ...state.rendering }
    if (existing) {
      store.update(existing.id, { label: name, data })
      dispatch({ type: 'markRenderingSaved', id: existing.id })
      return existing.id
    }
    const e = createEntity<RenderingData>({ type: GRAPH_TYPES.rendering, label: name, data, tags: [], meta: { source: 'user' } })
    store.upsert(e)
    dispatch({ type: 'markRenderingSaved', id: e.id })
    return e.id
  }

  // ── Saved analyses ────────────────────────────────────────────────────
  const saveAnalysis = (name: string, existing?: AnyEntity): EntityId | undefined => {
    if (!state.metrics) return undefined
    const data = toAnalysisData(state.metrics, { filterId: state.filterId, filter: state.filter })
    if (existing) {
      store.update(existing.id, { label: name, data })
      dispatch({ type: 'markAnalysisSaved', id: existing.id })
      return existing.id
    }
    const e = createEntity<AnalysisData>({ type: GRAPH_TYPES.analysis, label: name, data, tags: [], meta: { source: 'user' } })
    store.upsert(e)
    dispatch({ type: 'markAnalysisSaved', id: e.id })
    return e.id
  }

  // ── Scenes: filter + layout + style (+ analysis), in 2D or 3D ─────────
  const loadFilterEntity = (e: AnyEntity) => dispatch({ type: 'loadFilter', id: e.id, filter: toFilterSpec(e.data as FilterData) })
  const loadLayoutEntity = (e: AnyEntity) => {
    const d = e.data as LayoutData
    dispatch({ type: 'loadLayout', id: e.id, positions: d.positions ?? {}, algorithm: layoutAlgorithmOf(d), pinned: d.pinned, rule: d.rule })
  }
  const loadRenderingEntity = (e: AnyEntity) => dispatch({ type: 'loadRendering', id: e.id, rendering: toRenderingSpec(e.data as RenderingData) })
  const loadScene = (scene: AnyEntity) => {
    const d = scene.data as SceneData
    const f = d.filterId ? store.get(d.filterId) : undefined
    const l = d.layoutId ? store.get(d.layoutId) : undefined
    const r = d.renderingId ? store.get(d.renderingId) : undefined
    const a = d.analysisId ? store.get(d.analysisId) : undefined
    if (f) loadFilterEntity(f)
    else dispatch({ type: 'clearFilter' })
    if (l) loadLayoutEntity(l)
    else dispatch({ type: 'unloadLayout' })
    if (r) loadRenderingEntity(r)
    else dispatch({ type: 'clearRendering' })
    if (a && a.type === GRAPH_TYPES.analysis) dispatch({ type: 'loadAnalysis', id: a.id, result: fromAnalysisData(a.data as AnalysisData) })
    else if (d.analysisId) dispatch({ type: 'clearMetrics' })
    if (d.algorithm && layoutInfo(d.algorithm)) dispatch({ type: 'setAlgorithm', algorithm: d.algorithm })
    if (d.params) dispatch({ type: 'patchParams', patch: d.params })
    dispatch({ type: 'loadProject', id: d.projectId && store.get(d.projectId) ? d.projectId : undefined })
    dispatch({ type: 'setAnalysisAuto', on: !!d.analysis?.auto })
    if (d.analysis?.options?.metrics) dispatch({ type: 'setAnalysisOptions', options: d.analysis.options })
    dispatch({ type: 'setScene', id: scene.id })
    // The view and the UI as they were saved. Physics stays off: a running simulation would move the picture away from
    // the one saved; `graph_layout {physics: true}` or the button starts it again from these positions.
    const v = d.view
    if (v) {
      if (v.labels) dispatch({ type: 'setLabels', labels: v.labels })
      if (v.showEdges !== undefined && v.showEdges !== live.current.state.showEdges) dispatch({ type: 'toggleEdges' })
      if (v.showLegend !== undefined) dispatch({ type: 'setLegend', on: v.showLegend })
      // The slides a scene shows over the same graph: a scene per deck switches the deck, never the picture under it.
      const slides = slidesViewOf(v.slides)
      dispatch({ type: 'setSlides', patch: slides ? { show: slides.show, decks: slides.decks, focus: slides.focus, parts: slides.parts ?? true, story: slides.story, spatial: slides.spatial, final: slides.final } : { show: true, decks: undefined, focus: undefined, parts: true, story: undefined, spatial: undefined, final: undefined } })
      if (typeof v.hops === 'number') dispatch({ type: 'setHops', hops: v.hops })
      if (v.pathOptions) dispatch({ type: 'setPathOptions', patch: v.pathOptions as Partial<PathOptions> })
      dispatch({ type: 'setTool', tool: explorerTool(v.tool) })
      dispatch({ type: 'select', ids: (v.selectedIds ?? []).filter((id) => store.has(id)), mode: 'replace' })
      dispatch({ type: 'selectEdge', id: v.selectedEdgeId && store.has(v.selectedEdgeId) ? v.selectedEdgeId : undefined })
      if (v.panel !== undefined) openPanel(v.panel)
      if (v.sideWidth && v.sideWidth >= 200 && v.sideWidth <= 640) setSideWidth(v.sideWidth)
      if (v.detail) {
        setDetailMinimized(v.detail.minimized)
        setDetailMax(v.detail.maximized)
        detailTabs.set({ pinned: v.detail.pinned.filter((id) => store.has(id)), active: v.detail.active || 'selection' })
        if (v.detail.width) inspector.setWidth(v.detail.width)
      }
      // The camera: the renderer takes it as the first camera of the picture (a renderer the scene's mode mounts anew
      // included), so nothing is drawn framed otherwise first; on a picture that does not change it is set outright.
      if (v.camera) {
        const cam = v.camera
        setSceneCamera({ camera: cam, token: Date.now() })
        requestAnimationFrame(() => viewRef.current?.setCamera(cam.kind === '2d' ? { center: cam.center, ratio: cam.ratio, angle: cam.angle } : { position: cam.position, lookAt: cam.lookAt }, 0))
      }
    }
    // A scene saved in the app always carries the camera it was saved with; one composed elsewhere — the headless
    // engine's `graph_scene`, a generated dataset — may not, and the renderer would otherwise keep the camera it
    // already had and open the picture off the corner of the canvas. Framed as its positions land (see `fitScene`).
    if (!d.view?.camera) setFitScene(Date.now())
    const missing = [d.filterId && !f && 'filter', d.layoutId && !l && 'layout', d.renderingId && !r && 'style', d.analysisId && !a && 'analysis'].filter(Boolean)
    toast(missing.length ? `Scene loaded; its ${missing.join(', ')} no longer exists` : `Scene “${displayLabel(scene)}” loaded`)
    // The scene names its dimensions (older ones the renderer they were saved on, read as the engine's).
    const wanted: ExplorerMode = explorerMode(d.mode) ?? explorerMode(d.renderer) ?? '2d'
    if (wanted !== renderer) switchMode(wanted)
  }
  // A scene's camera on its way to the renderer (see loadScene); forgotten after the renderer has had its chance, so
  // a later picture (a filter edited) frames itself as usual.
  const [sceneCamera, setSceneCamera] = useState<{ camera: SceneCamera; token: number } | undefined>(undefined)
  /**
   * A scene with no camera of its own, framed as it lands. The picture arrives in stages — the slice, then the
   * positions, then the engine's first frames — and a single fit at any one moment catches the wrong one, so the
   * view is framed on each beat for the couple of seconds a layout takes to settle.
   */
  const [fitScene, setFitScene] = useState(0)
  useEffect(() => {
    if (!fitScene) return
    const timers = [0, 350, 900, 1800, 2800].map((ms) => setTimeout(() => viewRef.current?.fit(), ms))
    return () => timers.forEach(clearTimeout)
  }, [fitScene])
  useEffect(() => {
    if (!sceneCamera) return
    const t = setTimeout(() => setSceneCamera(undefined), 2000)
    return () => clearTimeout(t)
  }, [sceneCamera])
  /**
   * The picture of a scene that arrived without one. A scene saved here carries
   * its own (`data.preview`); one from a bundle, a generator or the headless
   * engine does not, and its card would otherwise be drawn from the layout's
   * numbers — flat, top-down, no camera and no style. Once the view has
   * settled on the scene, the engine's own frame is kept in the preview cache,
   * which belongs to this browser rather than to the project: opening a scene
   * is not a change to it.
   */
  const capturedScene = useRef('')
  useEffect(() => {
    const id = state.sceneId
    const scene = id ? store.get(id) : undefined
    if (!scene) return
    const key = previewKey(scene.id, scene.meta.updatedAt)
    if (capturedScene.current === key) return
    if (isImageUrl((scene.data as { preview?: unknown }).preview)) return
    let live = true
    // After the beats a scene takes to land (see `fitScene`): the picture at rest, not mid-layout.
    const t = setTimeout(() => {
      void (async () => {
        if (!live || (await readPreview(key))) return
        const blob = await viewRef.current?.snapshot({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }).catch(() => null)
        if (!live || !blob) return
        await writePreview(key, await previewDataUrl(blob, PREVIEW_WIDTH, PREVIEW_HEIGHT))
        capturedScene.current = key
      })()
    }, 3200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [state.sceneId, store])
  const savePart = (part: ScenePart, name: string, existing?: AnyEntity): EntityId | undefined => (part === 'filter' ? saveFilter(name, existing) : part === 'layout' ? saveLayout(name, existing) : part === 'rendering' ? saveRendering(name, existing) : saveAnalysis(name, existing))
  /** The view and the UI as they stand, and a small picture of the view, for a scene being saved. */
  const captureView = async (): Promise<{ view: SceneView; preview?: string; stats: { nodes: number; edges: number } }> => {
    const st = live.current.state
    const cam = viewRef.current?.getCamera()
    const camera: SceneCamera | undefined = !cam ? undefined : cam.kind === '2d' ? { kind: '2d', x: cam.x, y: cam.y, ratio: cam.ratio, angle: cam.angle, center: cam.center } : { kind: '3d', position: cam.position, lookAt: cam.lookAt }
    const view: SceneView = {
      camera,
      labels: st.labels,
      showEdges: st.showEdges,
      showLegend: st.showLegend,
      slides: st.slides,
      physics: st.physics,
      hops: st.hops,
      tool: st.tool,
      pathOptions: st.pathOptions as unknown as Record<string, unknown>,
      selectedIds: st.selectedIds,
      selectedEdgeId: st.selectedEdgeId,
      panel: panelRef.current,
      sideWidth,
      detail: { minimized: detailRef.current.min, maximized: detailMax, active: detailRef.current.tabs.active, pinned: detailRef.current.tabs.pinned, width: inspector.width },
    }
    let preview: string | undefined
    try {
      const blob = await viewRef.current?.snapshot({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT })
      if (blob) preview = await previewDataUrl(blob, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    } catch {
      /* a renderer that cannot draw offscreen leaves the card to its icon */
    }
    return { view, preview, stats: { nodes: live.current.slice.nodes.length, edges: live.current.slice.edges.length } }
  }
  captureRef.current = captureView

  return (
    <div className="gx" onPointerDownCapture={touch} onFocusCapture={touch}>
      <div className="gx-top">
        <div className="gx-tabs">
          <button className={`gx-tab ${renderer === '2d' ? 'is-active' : ''}`} onClick={() => switchMode('2d')}>
            <Square size={13} /> 2D
          </button>
          <button className={`gx-tab ${renderer === '3d' ? 'is-active' : ''}`} onClick={() => switchMode('3d')}>
            <Box size={13} /> 3D
          </button>
        </div>
        <span className="gx-sep" />
        <div className="gx-tabs gx-panels" role="group" aria-label="Side panel">
          {PANELS.map(({ key, label, icon: Icon, title }) => (
            <button key={key} className={`gx-tab ${panel === key ? 'is-active' : ''}`} aria-pressed={panel === key} title={`${title}${panel === key ? ' — click again to close' : ''}`} onClick={() => togglePanel(key)}>
              <Icon size={13} />
              {label}
              {key === 'stats' && state.metricsJob && <span className="count">…</span>}
              {key === 'selection' && state.selectedIds.length > 0 && <span className="count">{state.selectedIds.length}</span>}
            </button>
          ))}
        </div>
        <span className="gx-sep" />
        <SceneSave
          renderer={dims === 3 ? '3d' : '2d'}
          mode={renderer}
          sceneId={state.sceneId}
          projectId={state.projectId}
          analysis={{ auto: state.analysisAuto, options: state.analysisOptions }}
          parts={{
            filter: { id: state.filterId, dirty: state.filterDirty, summary: describeFilter(state.filter) },
            layout: { id: state.layoutId, dirty: state.layoutDirty, summary: `${layoutInfo(state.algorithm).label} · ${state.positions.size.toLocaleString()} positions` },
            rendering: { id: state.renderingId, dirty: state.renderingDirty, summary: describeRendering(state.rendering) },
            analysis: { id: state.analysisId, dirty: state.analysisDirty, summary: state.metrics ? `${describeAnalysis(state.metrics)}${metricsStale ? ' · stale' : ''}` : 'No metrics computed', absent: !state.metrics },
          }}
          savePart={savePart}
          captureView={captureView}
          onLoad={loadScene}
          onUnload={() => dispatch({ type: 'setScene', id: undefined })}
          onSaved={(id) => dispatch({ type: 'setScene', id })}
        />
        <PipelineBar request={datasetRequest} exportProvenance={() => ({ filterId: state.filterDirty ? undefined : state.filterId, layoutId: state.layoutDirty ? undefined : state.layoutId, renderingId: state.renderingDirty ? undefined : state.renderingId, analysisId: state.analysisDirty ? undefined : state.analysisId })} />
        <span className="spacer" />
        {physicsOk && (
          <button className={`btn btn--sm ${state.physics ? 'btn--primary' : ''}`} onClick={() => dispatch({ type: 'setPhysics', on: !state.physics })} title="Live force simulation">
            {state.physics ? <Pause size={13} /> : <Play size={13} />} Physics
          </button>
        )}
        <Select className="gx-select" value={state.labels} onChange={(e) => dispatch({ type: 'setLabels', labels: e.target.value as typeof state.labels })} title="Labels">
          <option value="auto">Labels: auto</option>
          <option value="all">Labels: all</option>
          <option value="none">Labels: none</option>
        </Select>
        <button className={`btn btn--sm btn--icon ${state.showEdges ? '' : 'btn--ghost'}`} title={state.showEdges ? 'Hide the edges' : 'Show the edges'} aria-pressed={state.showEdges} onClick={() => dispatch({ type: 'toggleEdges' })}>
          <Spline size={13} style={{ opacity: state.showEdges ? 1 : 0.4 }} />
        </button>
        <button className={`btn btn--sm btn--icon ${state.showLegend ? '' : 'btn--ghost'}`} title={state.showLegend ? 'Hide the legend' : 'Show the legend'} aria-pressed={state.showLegend} onClick={() => dispatch({ type: 'setLegend', on: !state.showLegend })}>
          <ListTree size={13} style={{ opacity: state.showLegend ? 1 : 0.4 }} />
        </button>
        <button className="btn btn--sm btn--icon" title="Export this view: picture, graph data, or diagram" disabled={slice.nodes.length === 0} onClick={(e) => setDiagramMenu(diagramMenu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
          <Download size={13} />
        </button>
        {diagramMenu && (
          <Menu
            x={diagramMenu.x}
            y={diagramMenu.y}
            anchor={diagramMenu.anchor}
            onClose={() => setDiagramMenu(null)}
            items={[
              { kind: 'label', label: `Diagram of ${slice.nodes.length.toLocaleString()} nodes · ${slice.edges.length.toLocaleString()} edges` },
              ...(slice.nodes.length > 2000 ? [{ kind: 'label' as const, label: 'Large — rendering may be slow' }] : []),
              { kind: 'item', label: 'Save as Graphviz diagram', onSelect: () => viewAsDiagram('dot', true) },
              { kind: 'item', label: 'Save as Mermaid diagram', onSelect: () => viewAsDiagram('mermaid', true) },
              { kind: 'sep' },
              { kind: 'item', label: 'Download .dot', onSelect: () => viewAsDiagram('dot', false) },
              { kind: 'item', label: 'Download .mmd', onSelect: () => viewAsDiagram('mermaid', false) },
              { kind: 'sep' },
              { kind: 'label', label: 'Picture' },
              { kind: 'item', label: 'Download PNG (2×)', onSelect: () => exportViewAs('png') },
              { kind: 'item', label: 'Download SVG', onSelect: () => exportViewAs('svg') },
              { kind: 'sep' },
              { kind: 'label', label: 'Graph data (with positions & colours)' },
              ...(['gexf', 'graphml', 'cyjs', 'nodes_edges_csv', 'json'] as const).map((f) => ({ kind: 'item' as const, label: `Download ${VIEW_EXPORT_LABELS[f]}`, onSelect: () => exportViewAs(f) })),
              { kind: 'sep' },
              { kind: 'label', label: 'Iterate' },
              { kind: 'item', label: 'Export view as a project…', onSelect: () => setDatasetRequest((r) => ({ ...r, exportAt: Date.now() })) },
              { kind: 'item', label: 'Use a project as the dataset…', onSelect: () => setDatasetRequest((r) => ({ ...r, datasetMenuAt: { x: diagramMenu.x, y: diagramMenu.y, at: Date.now() } })) },
            ] satisfies MenuItem[]}
          />
        )}
      </div>

      <div className={`gx-body${detailMax && !detailMin ? ' is-detail-max' : ''}`}>
        {panel && (
          <aside className="gx-side" ref={sideRef} style={{ width: sideWidth }} aria-label={PANELS.find((p) => p.key === panel)?.title}>
            <div className="gx-side__body">
              {/* A part's saved state heads its panel: what is loaded, whether it was edited, Load / Save / Save as…. (The Stats panel saves an analysis from its own bar.) */}
              {panel === 'filter' && (
                <PartHeader type={GRAPH_TYPES.filter} noun="filter" icon={Filter} activeId={state.filterId} dirty={state.filterDirty} summary={describeFilter(state.filter)} onLoad={loadFilterEntity} onSave={saveFilter} onClear={() => dispatch({ type: 'clearFilter' })} clearLabel="Clear filter (show everything)" />
              )}
              {panel === 'layout' && (
                <PartHeader type={GRAPH_TYPES.layout} noun="layout" icon={LayoutGrid} activeId={state.layoutId} dirty={state.layoutDirty} summary={`${layoutInfo(state.algorithm).label} · ${state.positions.size.toLocaleString()} positions held`} onLoad={loadLayoutEntity} onSave={saveLayout} onClear={() => dispatch({ type: 'unloadLayout' })} clearLabel="Unload layout (recompute)" />
              )}
              {panel === 'style' && (
                <PartHeader type={GRAPH_TYPES.rendering} noun="style" icon={Palette} activeId={state.renderingId} dirty={state.renderingDirty} summary={describeRendering(state.rendering)} onLoad={loadRenderingEntity} onSave={saveRendering} onClear={() => dispatch({ type: 'clearRendering' })} clearLabel="Reset to default style" />
              )}
              {panel === 'filter' ? <FilterPanel onOpenTable={openTableView} /> : panel === 'layout' ? <LayoutPanel dims={dims} /> : panel === 'style' ? <StylePanel /> : panel === 'stats' ? <StatsPanel /> : <SelectionPanel />}
            </div>
            <div className="gx-side__resize" onPointerDown={startSideResize} onDoubleClick={() => (setSideWidth(300), localStorage.setItem('aegraph:explorer:side-width', '300'))} title="Drag to resize · double-click to reset" />
          </aside>
        )}

        <div className="gx-stage" ref={stageRef}>
          {gated ? <LargeGraphGate /> : dormant ? null : (
            <Suspense fallback={<div className="gx-stage__veil" role="status">Loading the view…</div>}>
              <GpuGraph key="gpu" ref={viewRef} dims={dims} initialViewport={handoff.current} initialCamera={sceneCamera} />
            </Suspense>
          )}
          {/* How big the picture is — everything the filter left, not just what is on screen — over the scene's own
              top-left corner, where the eye starts, rather than among the toolbar's buttons. */}
          {!gated && (slice.nodes.length > 0 || slice.truncated > 0) && (
            <div className="gx-stats gx-stage__stats">
              {slice.nodes.length.toLocaleString()} nodes · {slice.edges.length.toLocaleString()} edges
              {slice.truncated > 0 && (
                <button
                  className="badge badge--warn gx-stats__trim"
                  title={`The filter matches ${slice.candidates.toLocaleString()} nodes but the view draws at most ${(state.filter.maxNodes ?? DEFAULT_MAX_NODES).toLocaleString()} (Max nodes, under Filter › Structure), keeping the best-connected. The other ${slice.truncated.toLocaleString()} are left out of the picture, the tables and the layout — the filter itself still matches them. Raise Max nodes or narrow the filter; click to open the setting.`}
                  onClick={() => openPanel('filter')}
                >
                  {slice.truncated.toLocaleString()} more not drawn
                </button>
              )}
            </div>
          )}
          {/* While a layout runs over nodes that have no positions yet, the canvas holds a seed cloud — not a picture, so it
              is veiled with the notice rather than shown as one. A layout refining held positions only gets the badge. */}
          {!gated && slice.nodes.length > 0 && positionsFor(dims).pending ? (
            <div className="gx-stage__veil" role="status" aria-live="polite">
              {state.restoring !== undefined ? (
                <div className="gx-busy gx-busy--center">
                  <span className="spinner" /> Restoring {state.restoring.toLocaleString()} held positions…
                </div>
              ) : state.layoutJob ? (
                <div className="gx-busy gx-busy--center">
                  <span className="spinner" /> Laying out {state.layoutJob.nodes.toLocaleString()} nodes…
                  <span className="gx-busy__note">The picture appears when the layout is done.</span>
                  <button className="btn btn--sm" title="Stop the layout; the nodes go on a grid so you can narrow the view or try another layout" onClick={() => cancelLayout(dims)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="gx-busy gx-busy--center">
                  {positionsFor(dims).unplaced.toLocaleString()} nodes have no position yet.
                  {/* An engine that refused or failed says why; otherwise the run was interrupted. */}
                  <span className="gx-busy__note">{state.layoutError ?? 'The layout did not run to the end (the page reloaded, or it was stopped).'}</span>
                  <button className="btn btn--sm btn--primary" onClick={() => void runLayout(dims, state.positions.size ? 'missing' : 'all')}>
                    Lay out
                  </button>
                </div>
              )}
            </div>
          ) : state.layoutJob ? (
            <div className="gx-busy" role="status">
              <span className="spinner" /> Laying out {state.layoutJob.nodes.toLocaleString()} nodes…
              <button className="btn btn--sm btn--ghost" title="Stop the layout and keep the positions as they are" onClick={() => cancelLayout(dims)}>
                Cancel
              </button>
            </div>
          ) : state.layoutError ? (
            // The picture is intact (every node still has its position); the run that would have replaced it refused or failed.
            <div className="gx-busy gx-busy--error" role="alert">
              <span>{state.layoutError}</span>
              <button className="gx-busy__x" aria-label="Dismiss" title="Dismiss" onClick={() => dispatch({ type: 'clearLayoutError' })}>
                ×
              </button>
            </div>
          ) : null}
          {slice.nodes.length === 0 && (
            <div className="gx-empty">
              <p>Nothing to show.</p>
              <p className="muted">{store.entityCount() === 0 ? 'Load a dataset from Build → Datasets.' : 'The current filter matches no entities — clear it or loosen it.'}</p>
            </div>
          )}
          {!gated && <Legend />}
          {/* The view's own controls live on the picture, bottom right: pointer/path tool, zoom, fit, full view. */}
          {!gated && <GraphNav viewRef={viewRef} fullView={panel === null} onFullView={setFullView} />}
          {!gated && <PathStatus />}
          {!gated && <CameraKeysHint dims={dims} />}
          <DeleteDialog target={deleting} onDone={() => setDeleting(null)} />
        </div>
        {/* The detail panel splits the row like the Entities page's: the stage gives it room (the renderer re-measures), rather than the panel covering the picture. */}
        {detailMin && (
          <div className="gx-inspector gx-inspector--min" role="button" tabIndex={0} title="Show the details" onClick={() => setDetailMinimized(false)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setDetailMinimized(false)}>
            <button className="ws-tabs__btn" aria-label="Show the details" onClick={(e) => (e.stopPropagation(), setDetailMinimized(false))}>
              <PanelRightOpen size={14} />
            </button>
            <span className="gx-inspector__strip-title">
              Details · {(selected ? 1 : 0) + detailTabs.tabs.pinned.filter((id) => id !== selected?.id).length}
            </span>
          </div>
        )}
        {!detailMin && (
          <>
            <div className="pane-gutter gx-inspector__gutter" onPointerDown={inspector.onPointerDown} onDoubleClick={inspector.reset} title="Drag to resize · double-click to reset" />
            <div className="gx-inspector" style={{ width: inspector.width }}>
              <DetailPane
                selectedId={selected?.id ?? null}
                leads={[
                  { key: 'nodes', title: 'Nodes', icon: <Table2 size={12} />, render: () => nodesTable() },
                  { key: 'edges', title: 'Edges', icon: <Waypoints size={12} />, render: () => edgesTable() },
                ]}
                views={tableViews.map((v) => ({
                  key: v.key,
                  title: tableViewTitle(v),
                  icon: <span className="dp-tab__dot" style={{ background: v.kind === 'tag' ? (store.getTagInfo(v.value).color ?? hashColor(v.value)) : v.kind === 'type' ? (registry.get(v.value).color ?? hashColor(v.value)) : hashColor(v.value) }} />,
                  render: () => (v.kind === 'rel' ? edgesTable(tableViewRows(v), `aegraph:explorer:view:${v.kind}`) : nodesTable(tableViewRows(v), `aegraph:explorer:view:${v.kind}`)),
                  onClose: () => closeTableView(v.key),
                }))}
                tabs={detailTabs.tabs}
                onTabs={(next) => detailTabs.set(next)}
                onDeselect={() => (state.selectedEdgeId ? dispatch({ type: 'selectEdge', id: undefined }) : dispatch({ type: 'select', ids: [], mode: 'replace' }))}
                onMinimize={() => (setDetailMax(false), setDetailMinimized(true))}
                onMaximize={() => setDetailMax((v) => !v)}
                maximized={detailMax}
                // A tab is a bookmark: clicking it brings its entity into view — a node is panned to at the current zoom, a relationship framed with both ends.
                onActivate={(id) => {
                  if (slice.nodes.some((n) => n.id === id)) return goTo([id])
                  const edge = slice.edges.find((r) => r.id === id)
                  if (edge) goTo([edge.source.id, edge.target.id])
                }}
                // Anything opened from inside a detail view — a node in the graph included — opens as another tab; the
                // selection, and the tab that follows it, stay as they are.
                onDelete={(ids) => {
                  store.remove(ids)
                  dispatch({ type: 'select', ids, mode: 'remove' })
                  dispatch({ type: 'selectEdge', id: undefined })
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

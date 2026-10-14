import { BitSet } from '../../../core/packed/bitset'
import { packColor, packedToHex } from '../../../core/packed/color'
import { SpatialGrid } from '../../../core/packed/grid'
import { PackedGraph } from '../../../core/packed/graph'
import { IdRegistry, TypeTable } from '../../../core/packed/ids'
import { extent, type Dims } from '../../../core/packed/layout'
import { DirtyBlocks } from './dirty'
import { Camera } from './camera'
import { OrbitCamera } from './camera3'
import { LabelLayer } from './labels'
import { lodFor, spacingPx, type LodSettings, type Regime } from './lod'
import { ortho2d, project } from './mat4'
import { E_DIRECTED, E_FILTERED, E_HIDDEN, E_HOVERED, E_PATH, E_SELECTED, N_AROUND, N_FILTERED, N_HIDDEN, N_HOVERED, N_LABEL, N_PATH, N_PINNED, N_SELECTED, N_SHAPE_MASK, N_SHAPE_SHIFT, SHAPE_CODES, E_CURVE_MASK, packEdgeCurvature, packEdgeWidth, type FrameParams, type Renderer, type ShapeName } from './types'
import { WebGL2Renderer } from './webgl2'
import { PackedWorker } from './workerClient'
import { GpuPhysics, physicsKernels } from './physics'
import { coolingSteps, decayFor, DEFAULT_PHYSICS, packingSpacing, type PhysicsParams } from '../../../core/packed/physics'
import type { WebGPURenderer } from './webgpu'
import { measure } from '../../../lib/measure'

/**
 * The GPU graph engine. It owns the graph (packed, integer-indexed), the
 * view state (positions, colours, flags in typed arrays), the cameras, the
 * spatial index and the selection bitsets, and keeps a renderer's copy of
 * the arrays current by uploading only the ranges that changed. React
 * never sees a frame: the engine renders on demand (when something is
 * dirty or a camera animation runs) and tells listeners about selection,
 * hover and drags through events. Every operation on the pointer path —
 * hover, drag, marquee — is allocation-free and proportional to what it
 * touches, never to the graph.
 *
 * Two dimensions or three is a property of the engine, not two engines:
 * positions are x, y, z; the 2D camera projects orthographically and picks
 * through a spatial grid, the orbit camera projects with perspective and
 * picks through the GPU id pass; the shaders, buffers, LOD, selection and
 * labels are the same.
 *
 * The full graph may hold a million nodes; the cost of a frame follows the
 * viewport (LOD, labels) and the cost of an interaction follows the
 * interaction (a drag uploads one node, a selection change uploads the
 * flags of the nodes whose selection changed).
 */

export type Backend = 'webgpu' | 'webgl2'
export type SelectMode = 'replace' | 'add' | 'toggle' | 'remove'

export interface NodeSpec {
  type?: string
  x?: number
  y?: number
  z?: number
  /** Nominal radius in px at a comfortable zoom (see `lod.ts`). */
  size?: number
  /** CSS colour. */
  color?: string
  /** Packed colour, when the caller already has one. */
  packed?: number
  label?: string
  /** Whether a label may be drawn for it (the view's label mode still applies). */
  labelOk?: boolean
  /** The outline the node is drawn with (default circle). */
  shape?: ShapeName
  visible?: boolean
  pinned?: boolean
}
export interface EdgeSpec {
  type?: string
  directed?: boolean
  color?: string
  packed?: number
  width?: number
  /** How far the edge bends (a parallel edge's share of the bundle; 0 or absent: straight). */
  curvature?: number
  /** What the edge's label says when edge labels are shown (its type, usually). */
  label?: string
  visible?: boolean
}

export interface FrameStats {
  frameMs: number
  /** Mean over the last 60 frames. */
  meanMs: number
  fps: number
  drawCalls: number
  nodesInView: number
  regime: Regime
  labels: number
  frames: number
}

/** Where the live physics stands. */
export interface PhysicsState {
  on: boolean
  /** Where it runs: on the GPU (WebGPU compute), in the worker (WebGL2), or nowhere. */
  mode: 'gpu' | 'worker' | null
  alpha: number
  cooled: boolean
  iterations: number
  /** Iterations per frame at the moment (adapted to the GPU time). */
  perFrame: number
  /** GPU milliseconds per iteration (NaN when unmeasured). */
  msPerIteration: number
  nodes: number
  edges: number
}


export interface EngineEvents {
  /** The selection changed by an interaction (click, marquee, keyboard); the bitset is the engine's. */
  select: (info: { source: 'click' | 'marquee' | 'api' | 'neighbors' }) => void
  hover: (node: number) => void
  /** An edge was clicked (-1: cleared). */
  edgeSelect: (edge: number) => void
  /** A drag ended, these nodes moved. */
  dragEnd: (nodes: Uint32Array) => void
  /** Right click: what is under the pointer, in screen coordinates. */
  contextmenu: (info: { x: number; y: number; node: number; edge: number }) => void
  /** A click on a node in a mode the view owns (path tool). */
  nodeClick: (info: { node: number; shift: boolean; meta: boolean }) => void
  /** The camera moved (every frame it does). */
  camera: () => void
  /** The canvas has a (new) real size: what needed a measured camera — a first fit — can be done now. */
  resize: (width: number, height: number) => void
  frame: (stats: FrameStats) => void
  /** The physics started, cooled or stopped. */
  physics: (state: PhysicsState) => void
  ready: (backend: Backend) => void
  error: (message: string) => void
}

/**
 * The colours the engine draws with that are not the data's: the ground, the labels and their halo, the rings of the
 * selected, hovered and path nodes, and the colour of a node or edge given none. These are Paper's; a view sets its
 * theme's with `setColors` (`engineTheme.ts › engineColors`) and again when the theme changes. CSS colour strings.
 */
export interface EngineColors {
  background: string
  label: string
  labelHalo: string
  edgeLabel: string
  select: string
  hover: string
  path: string
  node: string
  edge: string
}
export const PAPER_ENGINE_COLORS: Readonly<EngineColors> = {
  background: '#faf9f6',
  label: '#1f1e1b',
  labelHalo: 'rgba(255,255,255,0.9)',
  edgeLabel: '#6b6a66',
  select: '#1f1e1b',
  hover: '#9a3412',
  path: '#9a3412',
  node: '#7c7a74',
  edge: '#b5b2aa',
}
const AROUND_MAX_SELECTED = 20_000
/**
 * Physics iterations per frame at most, however cheap they are. While the run is hot (alpha above
 * `PHYSICS_WATCH_ALPHA`) the picture moves a lot per iteration and should be watchable: four a frame. Past that the
 * moves are small and a run of 1,500 iterations is mostly this tail, so it takes what the GPU budget allows, up to
 * `PHYSICS_MAX_PER_FRAME_COOL` — at four a frame the tail alone was five seconds on a small graph.
 */
const PHYSICS_MAX_PER_FRAME = 4
const PHYSICS_MAX_PER_FRAME_COOL = 24
const PHYSICS_WATCH_ALPHA = 0.5
/** The worker's live run (no WebGPU): iterations × (nodes + edges) it may spend cooling — about five seconds. */
const WORKER_FORCE_WORK = 8e6
/**
 * A big graph needs more iterations to unfold than a small one: a 90,000-node grid is still folded at 1,500
 * (stress 0.61) and comes out at 4,600 (0.38, crossings a tenth). With the default cooling, a GPU run gets
 * √(nodes / AUTO_COOL_FROM) times the default iterations, up to `AUTO_COOL_MAX` times, and never more than fit
 * `AUTO_COOL_SECONDS` at the rate the calibration measured. A cooling someone set is theirs.
 */
const AUTO_COOL_FROM = 20_000
const AUTO_COOL_MAX = 3
const AUTO_COOL_SECONDS = 8
const HOVER_AROUND_MAX_DEGREE = 2_000
/** In 3D, what is in view is estimated from at most this many projected nodes. */
const VIEW_SAMPLE = 40_000
/** How long a 3D count of what is on screen stands while the camera does not move (see `countInViewNow`). */
const VIEW_COUNT_MS = 250

// What changed since the last upload, per array: blocks, sent as a few runs (`dirty.ts`).
const range = () => new DirtyBlocks()
const mark = (r: DirtyBlocks, i: number) => r.mark(i)
const markAll = (r: DirtyBlocks, n: number) => r.markAll(n)

export class GraphEngine {
  dims: Dims = 2
  /**
   * How the 3D camera answers the mouse: `orbit` (the default) turns it around the point it looks at, pans, and the
   * wheel closes on that point; `fly` turns the view about the eye and the wheel moves the eye forward and back —
   * through the graph and past it. The keys follow the same switch (`useCameraKeys`). 2D ignores it.
   */
  controls: 'orbit' | 'fly' = 'orbit'
  /**
   * Things drawn over the picture that take clicks of their own — the slide layer's cards. A press on one picks no
   * node (it may still orbit or pan), a still click on one is its click, a double-click its double-click; the
   * topmost overlay that `hit`s is asked first.
   */
  overlays: EngineOverlay[] = []
  /** The overlay under a point of the view, if any. */
  overlayAt(x: number, y: number): EngineOverlay | null {
    for (let k = this.overlays.length - 1; k >= 0; k--) if (this.overlays[k].hit(x, y)) return this.overlays[k]
    return null
  }
  graph = new PackedGraph()
  ids = new IdRegistry()
  edgeIds = new IdRegistry()
  nodeTypes = new TypeTable()
  edgeTypes = new TypeTable()
  /** x, y, z, radius — four floats per node. */
  posr = new Float32Array(1024 * 4)
  nodeColor = new Uint32Array(1024)
  nodeFlags = new Uint32Array(1024)
  labels: (string | undefined)[] = []
  edgeLabels: (string | undefined)[] = []
  /** Draw the edges' labels (close in, and always on a selected or hovered edge). */
  showEdgeLabels = false
  private edgeSeen = new BitSet(0)
  /** Makes a label for a node that has none stored (generated graphs). */
  labelFallback: ((i: number) => string) | null = null
  /** source, target, colour, flags|width — four u32 per edge. */
  edgeData = new Uint32Array(4096 * 4)
  selected = new BitSet(1024)
  /** Nodes the current filter leaves in (the complement is drawn nowhere). */
  filtered = new BitSet(1024)
  private around = new BitSet(1024)
  /** How many links out from the selection stay lit (`setHighlightHops`); a hover lights its first ring only. */
  private highlightHops = 1
  private hoverAround = new BitSet(1024)
  private pathNodes = new BitSet(1024)
  pinned = new BitSet(1024)
  hovered = -1
  hoveredEdge = -1
  selectedEdge = -1
  pathEdges: number[] = []
  camera = new Camera()
  camera3 = new OrbitCamera()
  grid = new SpatialGrid()
  private gridStale = true
  renderer: Renderer | null = null
  backend: Backend | null = null
  labelLayer: LabelLayer | null = null
  worker = new PackedWorker()
  container: HTMLElement | null = null
  private dpr = 1
  /** What changed since the last upload. */
  private dirtyPos = range()
  private dirtyColor = range()
  private dirtyFlags = range()
  private dirtyEdges = range()
  private needRender = true
  private labelsDirty = true
  private raf = 0
  private batch = 0
  private lastFocus = false
  private listeners: Partial<Record<keyof EngineEvents, Set<(...a: never[]) => void>>> = {}
  private frameTimes = new Float32Array(60)
  private frameIndex = 0
  private frames = 0
  private lastFrameAt = 0
  stats: FrameStats = { frameMs: 0, meanMs: 0, fps: 0, drawCalls: 0, nodesInView: 0, regime: 0, labels: 0, frames: 0 }
  // ── Live physics ──
  physicsParams: PhysicsParams = { ...DEFAULT_PHYSICS }
  private gpuPhysics: GpuPhysics | null = null
  private physicsMode: 'gpu' | 'worker' | null = null
  private physicsPerFrame = 1
  /** GPU milliseconds per iteration with the GPU to itself (the calibration), 0 until measured. */
  private physicsMsPerIteration = 0
  private physicsCalibrating = false
  private physicsFrames = 0
  /** Set while a stop waits for the last copy: no more steps. */
  private physicsStopping = false
  /** Asked to start before there was a renderer: starts when one is ready, with what was asked. */
  private physicsPending = false
  private physicsPendingParams: Partial<PhysicsParams> = {}
  private physicsCooledSaid = false
  private physicsWorkerBusy = false
  private physicsWorkerIterations = 0
  private physicsWorkerAlpha = 1
  /** Which run this is: a worker batch asked for by an earlier run lands in none (a restart over a new picture). */
  private physicsRun = 0
  private heldWords = new Uint32Array(0)
  /** Milliseconds of GPU physics per frame the loop aims for; the iterations per frame follow the measured cost. */
  physicsBudgetMs = 12
  lod: LodSettings = lodFor(Infinity, 0)
  /** Label mode the view chose: auto follows the LOD; all/none override. */
  labelMode: 'auto' | 'all' | 'none' = 'auto'
  showEdges = true
  nodeSizeFactor = 1
  /** The colours in use (`setColors`); `background` and the rest below are the same, packed for the GPU. */
  colors: EngineColors = { ...PAPER_ENGINE_COLORS }
  background = packColor(PAPER_ENGINE_COLORS.background)
  /** Clear to nothing rather than the background: the picture composes over what is behind the canvas (a map). */
  private transparent = false
  private selectColor = packColor(PAPER_ENGINE_COLORS.select)
  private hoverColor = packColor(PAPER_ENGINE_COLORS.hover)
  private pathColor = packColor(PAPER_ENGINE_COLORS.path)
  private defaultNodeColor = packColor(PAPER_ENGINE_COLORS.node)
  private defaultEdgeColor = packColor(PAPER_ENGINE_COLORS.edge)
  private vp = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  private viewProj = new Float32Array(16)
  private ndc = new Float32Array(3)
  private scratch = new Uint32Array(4096)
  private focusIds = new Uint32Array(1024)
  private inViewScratch = new Uint32Array(8192)
  /** Nodes being dragged: excluded from picking until the drop rebuilds the grid. */
  dragging: BitSet | null = null
  private resizeObserver: ResizeObserver | null = null
  private canvases: HTMLCanvasElement[] = []
  /** The next label pass follows a resize: what is showing stays, whatever its age. */
  private labelsKeep = false
  /** Where the container was on the screen at the last resize (viewport px), so the picture can hold still across the next. */
  private lastRect = { left: 0, top: 0, width: 0, height: 0 }
  private wantedBackend: Backend | 'auto' = 'auto'
  private spacing = Infinity
  private cameraMoved = false

  // ── Events ──
  on<K extends keyof EngineEvents>(name: K, fn: EngineEvents[K]): () => void {
    const set = (this.listeners[name] ??= new Set())
    set.add(fn as (...a: never[]) => void)
    return () => set.delete(fn as (...a: never[]) => void)
  }
  emit<K extends keyof EngineEvents>(name: K, ...args: Parameters<EngineEvents[K]>) {
    const set = this.listeners[name]
    if (!set) return
    for (const fn of set) (fn as (...a: unknown[]) => void)(...args)
  }

  // ── Mounting ──
  /** Create the canvases in `container` and a renderer (WebGPU when available, else WebGL2). */
  attach(container: HTMLElement, opts: { backend?: Backend | 'auto'; transparent?: boolean } = {}) {
    this.container = container
    this.wantedBackend = opts.backend ?? 'auto'
    this.transparent = !!opts.transparent
    const canvas = document.createElement('canvas')
    canvas.className = 'gg-gl'
    const labels = document.createElement('canvas')
    labels.className = 'gg-labels'
    container.appendChild(canvas)
    container.appendChild(labels)
    this.canvases = [canvas, labels]
    this.labelLayer = new LabelLayer(labels)
    this.paintLabelsWith(this.colors)
    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(container)
    this.onResize()
    void this.createRenderer(canvas)
  }

  /**
   * Draw with these colours from the next frame (a theme change). The ground, the rings and the labels are read per
   * frame — no buffer is touched, the frame and the label pass are drawn once more. Nodes and edges already given the
   * default colour keep it; the views give every node and edge its own (`compile.ts`), so the defaults are for what is
   * added after.
   */
  setColors(c: Partial<EngineColors>) {
    const next = { ...this.colors, ...c }
    this.colors = next
    this.background = packColor(next.background)
    this.selectColor = packColor(next.select)
    this.hoverColor = packColor(next.hover)
    this.pathColor = packColor(next.path)
    this.defaultNodeColor = packColor(next.node)
    this.defaultEdgeColor = packColor(next.edge)
    if (this.labelLayer) {
      this.paintLabelsWith(next)
      // The labels showing stay where they are and as they are faded: only their colour changes.
      this.labelsDirty = true
      this.labelsKeep = true
    }
    this.requestRender()
  }
  private paintLabelsWith(c: EngineColors) {
    if (!this.labelLayer) return
    this.labelLayer.color = c.label
    this.labelLayer.halo = c.labelHalo
    this.labelLayer.edgeColor = c.edgeLabel
  }

  private async createRenderer(canvas: HTMLCanvasElement) {
    const want = this.wantedBackend
    let r: Renderer | null = null
    if (want !== 'webgl2' && 'gpu' in navigator) {
      try {
        const { WebGPURenderer } = await import('./webgpu')
        const webgpu = await WebGPURenderer.create(canvas, { transparent: this.transparent })
        // The physics kernels compile in the background now, so a run started later does not wait on them.
        physicsKernels(webgpu.compute.device)
        r = webgpu
      } catch (err) {
        if (want === 'webgpu') {
          this.emit('error', `WebGPU: ${err instanceof Error ? err.message : String(err)}`)
          return
        }
        r = null
      }
    }
    if (!r) {
      try {
        r = new WebGL2Renderer(canvas, { transparent: this.transparent })
      } catch (err) {
        this.emit('error', `WebGL2: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    if (!this.container) {
      r.destroy()
      return
    }
    this.renderer = r
    this.backend = r.kind
    r.resize(this.camera.width, this.camera.height, this.dpr)
    r.allocate(this.nodeCapacity, this.edgeCapacity)
    // Everything the engine holds goes up at once.
    markAll(this.dirtyPos, this.graph.nodeCount)
    markAll(this.dirtyColor, this.graph.nodeCount)
    markAll(this.dirtyFlags, this.nodeCapacity)
    markAll(this.dirtyEdges, this.graph.edgeCount)
    this.emit('ready', r.kind)
    if (this.physicsPending) this.startPhysics(this.physicsPendingParams)
    this.requestRender()
  }

  private onResize() {
    const c = this.container
    if (!c) return
    // A view put behind another — a workstation tab, a page kept mounted behind the one on screen — is hidden, and a
    // hidden element measures nothing. Taking that zero for a size would shrink the canvases and their buffers to a
    // pixel, which throws the drawn picture away; coming back would then have to size everything up again and redraw
    // from nothing, which is the blink the user sees on the way in. The size of a view that is not on the screen
    // says nothing about it, so nothing is done with it: the picture is left exactly as it was last drawn, and the
    // resize that follows the view being shown again is the same size it already has — no buffer touched, the
    // picture already there.
    if (c.clientWidth === 0 || c.clientHeight === 0) return
    const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight)
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.camera.width = w
    this.camera.height = h
    // The picture holds still on the screen when the view changes size or place around it — the details panel or the
    // assistant opening beside it, the sidebar folding, a pane gutter dragged. Both cameras look at a centre, so a
    // wider view alone would slide everything by half the difference; instead the picture moves by what the centre
    // moved on the screen (the container's edge plus half its growth), in the same frame as the new size, and only
    // the strip a panel took is lost: the flat camera by panning, the orbit camera by keeping its projection (see
    // `holdOnResize`). Nothing is done from or to a collapsed (hidden) view: its size says nothing.
    // The container's place is read to the whole px the browser paints it at: mid-transition it sits at fractions
    // of a px, and a shift by the fraction would move the picture by what the paint then rounds away — a wobble.
    // For the same reason the canvases are given their size in whole px rather than the container's 100%.
    const rect = c.getBoundingClientRect()
    const r = { left: Math.round(rect.left), top: Math.round(rect.top) }
    for (const el of this.canvases) {
      el.style.width = `${w}px`
      el.style.height = `${h}px`
    }
    const was = this.lastRect
    const holding = was.width > 0 && was.height > 0 && c.clientWidth > 0 && c.clientHeight > 0
    // What the centre moved on the screen (the cameras look at the centre) and what the corner moved (the picture's
    // movement across the canvas, which the label grid follows).
    const dx = holding ? r.left - was.left + (c.clientWidth - was.width) / 2 : 0
    const dy = holding ? r.top - was.top + (c.clientHeight - was.height) / 2 : 0
    if (holding) {
      this.camera3.holdOnResize(w, h, -dx, -dy)
      this.labelLayer?.shiftOrigin(was.left - r.left, was.top - r.top)
    } else {
      this.camera3.width = w
      this.camera3.height = h
    }
    if (dx !== 0 || dy !== 0) {
      this.camera.shiftBy(-dx, -dy)
      this.cameraMoved = true
      this.emit('camera')
    }
    this.lastRect = { left: r.left, top: r.top, width: c.clientWidth, height: c.clientHeight }
    this.renderer?.resize(w, h, this.dpr)
    this.labelLayer?.resize(w, h, this.dpr)
    this.labelsDirty = true
    if (this.refitOnResize && w > 1 && h > 1) {
      const o = this.refitOnResize
      this.refitOnResize = null
      this.fit(o)
    }
    // Drawn now, in the same layout step, not at the next animation frame: CSS sizes the canvases to the container,
    // and sizing the buffers clears them, so a frame painted in between shows them empty or the last picture
    // stretched to the new box — the flicker and squeeze of a panel being dragged. The observer fires after layout
    // and before paint; a draw here is what the paint shows.
    this.labelsKeep = true
    this.emit('resize', w, h)
    if (this.renderer && !this.paused) this.renderNow()
    else this.requestRender()
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.gpuPhysics?.destroy()
    this.gpuPhysics = null
    this.physicsMode = null
    this.resizeObserver?.disconnect()
    this.renderer?.destroy()
    this.renderer = null
    this.worker.terminate()
    if (this.container) {
      for (const c of Array.from(this.container.querySelectorAll('canvas.gg-gl, canvas.gg-labels'))) c.remove()
    }
    this.container = null
    this.listeners = {}
  }

  /** Switch between the flat and the orbit camera; the data stays. */
  setDims(dims: Dims) {
    if (this.dims === dims) return
    this.dims = dims
    this.gridStale = true
    this.labelsDirty = true
    this.fit()
  }

  // ── Capacity ──
  get nodeCapacity(): number {
    return this.nodeColor.length
  }
  get edgeCapacity(): number {
    return this.edgeData.length >>> 2
  }
  private ensureNodes(n: number) {
    if (n <= this.nodeCapacity) return
    let cap = this.nodeCapacity
    while (cap < n) cap *= 2
    const posr = new Float32Array(cap * 4)
    posr.set(this.posr)
    this.posr = posr
    const color = new Uint32Array(cap)
    color.set(this.nodeColor)
    this.nodeColor = color
    const flags = new Uint32Array(cap).fill(N_HIDDEN)
    flags.set(this.nodeFlags)
    this.nodeFlags = flags
    for (const b of [this.selected, this.filtered, this.around, this.hoverAround, this.pathNodes, this.pinned]) b.resize(cap)
    this.graph.ensureNodeCapacity(cap)
    if (this.renderer) {
      this.renderer.allocate(cap, this.edgeCapacity)
      markAll(this.dirtyPos, this.graph.nodeCount)
      markAll(this.dirtyColor, this.graph.nodeCount)
      markAll(this.dirtyFlags, cap)
      markAll(this.dirtyEdges, this.graph.edgeCount)
    }
  }
  private ensureEdges(n: number) {
    if (n <= this.edgeCapacity) return
    let cap = this.edgeCapacity
    while (cap < n) cap *= 2
    const data = new Uint32Array(cap * 4)
    data.set(this.edgeData)
    this.edgeData = data
    this.graph.ensureEdgeCapacity(cap)
    if (this.renderer) {
      this.renderer.allocate(this.nodeCapacity, cap)
      markAll(this.dirtyPos, this.graph.nodeCount)
      markAll(this.dirtyColor, this.graph.nodeCount)
      markAll(this.dirtyFlags, this.nodeCapacity)
      markAll(this.dirtyEdges, this.graph.edgeCount)
    }
  }

  // ── Batching: several mutations, one commit ──
  beginUpdate() {
    this.batch++
  }
  endUpdate() {
    if (--this.batch <= 0) {
      this.batch = 0
      this.commit()
    }
  }
  /** Fold the delta into the CSR when it is worth it, refresh what depends on the data, draw. */
  commit() {
    this.graph.compactIfNeeded()
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }

  // ── Nodes ──
  /** Put a node (new or existing) by id; returns its index. */
  setNode(id: string, spec: NodeSpec): number {
    const i = this.ids.intern(id)
    this.ensureNodes(i + 1)
    const fresh = !this.graph.hasNode(i)
    this.graph.setNode(i, spec.type !== undefined ? this.nodeTypes.code(spec.type) : fresh ? 0 : this.graph.nodeType[i])
    const p = i * 4
    if (fresh) {
      this.posr[p] = spec.x ?? 0
      this.posr[p + 1] = spec.y ?? 0
      this.posr[p + 2] = spec.z ?? 0
      this.posr[p + 3] = spec.size ?? 4
      this.nodeColor[i] = spec.packed ?? (spec.color ? packColor(spec.color) : this.defaultNodeColor)
      this.nodeFlags[i] = (spec.visible === false ? N_HIDDEN | N_FILTERED : 0) | (spec.labelOk === false ? 0 : N_LABEL) | ((SHAPE_CODES[spec.shape ?? 'circle'] ?? 0) << N_SHAPE_SHIFT)
      this.selected.clear(i)
      this.filtered.put(i, spec.visible !== false)
      this.pinned.clear(i)
      this.labels[i] = spec.label
      mark(this.dirtyPos, i)
      mark(this.dirtyColor, i)
      mark(this.dirtyFlags, i)
    } else {
      if (spec.x !== undefined || spec.y !== undefined || spec.z !== undefined || spec.size !== undefined) {
        if (spec.x !== undefined) this.posr[p] = spec.x
        if (spec.y !== undefined) this.posr[p + 1] = spec.y
        if (spec.z !== undefined) this.posr[p + 2] = spec.z
        if (spec.size !== undefined) this.posr[p + 3] = spec.size
        mark(this.dirtyPos, i)
      }
      const color = spec.packed ?? (spec.color ? packColor(spec.color) : undefined)
      if (color !== undefined && color !== this.nodeColor[i]) {
        this.nodeColor[i] = color
        mark(this.dirtyColor, i)
      }
      if (spec.label !== undefined) this.labels[i] = spec.label
      let f = this.nodeFlags[i]
      if (spec.labelOk !== undefined) f = spec.labelOk ? f | N_LABEL : f & ~N_LABEL
      if (spec.shape !== undefined) f = (f & ~N_SHAPE_MASK) | ((SHAPE_CODES[spec.shape] ?? 0) << N_SHAPE_SHIFT)
      if (spec.visible !== undefined) {
        this.filtered.put(i, spec.visible)
        f = spec.visible ? f & ~(N_HIDDEN | N_FILTERED) : f | N_HIDDEN | N_FILTERED
      }
      if (f !== this.nodeFlags[i]) {
        this.nodeFlags[i] = f
        mark(this.dirtyFlags, i)
      }
    }
    if (spec.pinned !== undefined) this.setPinnedOne(i, spec.pinned)
    if (!this.batch) this.commit()
    return i
  }
  removeNode(i: number) {
    if (!this.graph.hasNode(i)) return
    this.graph.forEachIncident(i, (e) => this.removeEdge(e))
    this.graph.removeNode(i)
    const id = this.ids.id(i)
    if (id !== undefined) this.ids.remove(id)
    this.nodeFlags[i] = N_HIDDEN
    this.selected.clear(i)
    this.filtered.clear(i)
    this.pinned.clear(i)
    this.labels[i] = undefined
    mark(this.dirtyFlags, i)
    if (!this.batch) this.commit()
  }
  /** Whether node `i` is drawn: alive and not filtered out. */
  isShown(i: number): boolean {
    return i >= 0 && i < this.graph.nodeCount && this.graph.nodeAlive.has(i) && this.filtered.has(i)
  }
  nodeIndex(id: string): number {
    return this.ids.index(id)
  }
  nodeId(i: number): string | undefined {
    return this.ids.id(i)
  }
  labelOf(i: number): string {
    return this.labels[i] ?? this.labelFallback?.(i) ?? this.ids.id(i) ?? String(i)
  }

  // ── Edges ──
  addEdge(id: string | undefined, source: number, target: number, spec: EdgeSpec = {}): number {
    const e = this.graph.addEdge(source, target, spec.type !== undefined ? this.edgeTypes.code(spec.type) : 0, spec.directed)
    this.ensureEdges(e + 1)
    if (id !== undefined) this.edgeIds.assign(id, e)
    this.writeEdge(e, source, target, spec)
    if (!this.batch) this.commit()
    return e
  }
  private writeEdge(e: number, source: number, target: number, spec: EdgeSpec) {
    this.edgeLabels[e] = spec.label
    const d = e * 4
    this.edgeData[d] = source
    this.edgeData[d + 1] = target
    this.edgeData[d + 2] = spec.packed ?? (spec.color ? packColor(spec.color) : this.defaultEdgeColor)
    this.edgeData[d + 3] = ((spec.directed ? E_DIRECTED : 0) | (spec.visible === false ? E_HIDDEN | E_FILTERED : 0) | packEdgeWidth(spec.width ?? 1) | packEdgeCurvature(spec.curvature ?? 0)) >>> 0
    mark(this.dirtyEdges, e)
  }
  setEdgeStyle(e: number, spec: EdgeSpec) {
    if (!this.graph.hasEdge(e)) return
    const d = e * 4
    let f = this.edgeData[d + 3]
    if (spec.color !== undefined || spec.packed !== undefined) this.edgeData[d + 2] = spec.packed ?? packColor(spec.color!)
    if (spec.width !== undefined) f = (f & 0xffff) | packEdgeWidth(spec.width)
    if (spec.curvature !== undefined) f = (f & ~E_CURVE_MASK) | packEdgeCurvature(spec.curvature)
    if (spec.label !== undefined) this.edgeLabels[e] = spec.label
    if (spec.directed !== undefined) f = spec.directed ? f | E_DIRECTED : f & ~E_DIRECTED
    if (spec.visible !== undefined) f = spec.visible ? f & ~(E_HIDDEN | E_FILTERED) : f | E_HIDDEN | E_FILTERED
    this.edgeData[d + 3] = f >>> 0
    mark(this.dirtyEdges, e)
    if (!this.batch) this.commit()
  }
  removeEdge(e: number) {
    if (!this.graph.hasEdge(e)) return
    this.graph.removeEdge(e)
    const id = this.edgeIds.id(e)
    if (id !== undefined) this.edgeIds.remove(id)
    this.edgeData[e * 4 + 3] |= E_HIDDEN
    if (this.selectedEdge === e) this.selectedEdge = -1
    mark(this.dirtyEdges, e)
    if (!this.batch) this.commit()
  }
  edgeIndex(id: string): number {
    const k = this.edgeIds.index(id)
    return k >= 0 && this.graph.hasEdge(k) ? k : -1
  }
  edgeId(e: number): string | undefined {
    return this.edgeIds.id(e)
  }
  /** Drop every edge and start edge indices from 0 (a slice rebuild). */
  clearEdges() {
    this.graph.clearEdges()
    this.edgeIds.clear()
    this.edgeData.fill(0)
    this.edgeLabels.length = 0
    this.selectedEdge = -1
    this.hoveredEdge = -1
    this.pathEdges = []
    markAll(this.dirtyEdges, this.edgeCapacity)
    if (!this.batch) this.commit()
  }

  /** Throw the graph away (capacities kept). */
  clear() {
    this.graph.clear()
    this.ids.clear()
    this.edgeIds.clear()
    this.labels.length = 0
    this.labelFallback = null
    this.nodeFlags.fill(N_HIDDEN)
    this.edgeData.fill(0)
    for (const b of [this.selected, this.filtered, this.around, this.hoverAround, this.pathNodes, this.pinned]) b.clearAll()
    this.hovered = -1
    this.hoveredEdge = -1
    this.selectedEdge = -1
    this.pathEdges = []
    this.labelLayer?.reset()
    markAll(this.dirtyFlags, this.nodeCapacity)
    markAll(this.dirtyEdges, this.edgeCapacity)
    this.commit()
  }

  /**
   * Replace everything with whole arrays (a generated graph, a worker's reply): the arrays become the engine's,
   * nothing is walked twice. Colours per type come from `typeColors` (packed), sizes from `sizes` or a default.
   */
  loadPacked(g: { ids?: string[]; idPrefix?: string; labels?: string[]; nodeType: Uint16Array; edgeSource: Uint32Array; edgeTarget: Uint32Array; edgeType: Uint16Array; positions: Float32Array; nodeTypes: string[]; edgeTypes: string[]; directed?: boolean }, style: { typeColors?: number[]; edgeTypeColors?: number[]; size?: (i: number, degree: number) => number } = {}) {
    const N = g.nodeType.length, E = g.edgeSource.length
    this.graph = PackedGraph.fromArrays({ nodeType: g.nodeType, edgeSource: g.edgeSource, edgeTarget: g.edgeTarget, edgeType: g.edgeType, directed: g.directed })
    this.ids.clear()
    this.edgeIds.clear()
    if (g.ids) for (let i = 0; i < N; i++) this.ids.intern(g.ids[i])
    else this.ids.setVirtual(g.idPrefix ?? 'n', N)
    this.nodeTypes = new TypeTable()
    for (const t of g.nodeTypes) this.nodeTypes.code(t)
    this.edgeTypes = new TypeTable()
    for (const t of g.edgeTypes) this.edgeTypes.code(t)
    let cap = 1024
    while (cap < N) cap *= 2
    let ecap = 4096
    while (ecap < E) ecap *= 2
    this.posr = new Float32Array(cap * 4)
    this.nodeColor = new Uint32Array(cap)
    this.nodeFlags = new Uint32Array(cap).fill(N_HIDDEN)
    // Labels stay lazy: `<type> <index>` is made when a label is drawn, not a million times up front.
    this.labels = g.labels ? g.labels.slice() : []
    this.labelFallback = g.labels ? null : (i) => `${this.nodeTypes.name(this.graph.nodeType[i])} ${i}`
    this.edgeData = new Uint32Array(ecap * 4)
    for (const b of [this.selected, this.filtered, this.around, this.hoverAround, this.pathNodes, this.pinned]) {
      b.resize(cap)
      b.clearAll()
    }
    const degree = this.graph.degree
    const colors = style.typeColors
    for (let i = 0; i < N; i++) {
      const p = i * 4
      this.posr[p] = g.positions[i * 3]
      this.posr[p + 1] = g.positions[i * 3 + 1]
      this.posr[p + 2] = g.positions[i * 3 + 2]
      this.posr[p + 3] = style.size ? style.size(i, degree[i]) : 2 + Math.min(10, Math.sqrt(degree[i]))
      this.nodeColor[i] = colors ? colors[g.nodeType[i] % colors.length] : this.defaultNodeColor
      this.nodeFlags[i] = N_LABEL
      this.filtered.set(i)
    }
    const ecolors = style.edgeTypeColors
    const dirFlag = g.directed ? E_DIRECTED : 0
    const w = packEdgeWidth(1)
    for (let e = 0; e < E; e++) {
      const d = e * 4
      this.edgeData[d] = g.edgeSource[e]
      this.edgeData[d + 1] = g.edgeTarget[e]
      this.edgeData[d + 2] = ecolors ? ecolors[g.edgeType[e] % ecolors.length] : this.defaultEdgeColor
      this.edgeData[d + 3] = (dirFlag | w) >>> 0
    }
    this.hovered = -1
    this.hoveredEdge = -1
    this.selectedEdge = -1
    this.pathEdges = []
    this.labelLayer?.reset()
    this.graph.ensureNodeCapacity(cap)
    this.graph.ensureEdgeCapacity(ecap)
    this.renderer?.allocate(cap, ecap)
    markAll(this.dirtyPos, N)
    markAll(this.dirtyColor, N)
    markAll(this.dirtyFlags, cap)
    markAll(this.dirtyEdges, E)
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }

  // ── Positions ──
  setPosition(i: number, x: number, y: number, z = this.posr[i * 4 + 2]) {
    const p = i * 4
    this.posr[p] = x
    this.posr[p + 1] = y
    this.posr[p + 2] = z
    mark(this.dirtyPos, i)
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }
  /**
   * Move nodes by a world delta — a drag: proportional to the nodes moved. The spatial grid is left as it is (the
   * nodes in flight are excluded from picking) and rebuilt once, by the `commit` on drop — not per frame.
   */
  moveBy(nodes: Uint32Array | number[], count: number, dx: number, dy: number, dz = 0) {
    if (this.physicsMode) this.reheatPhysics(0.3)
    for (let k = 0; k < count; k++) {
      const i = nodes[k]
      const p = i * 4
      this.posr[p] += dx
      this.posr[p + 1] += dy
      this.posr[p + 2] += dz
      mark(this.dirtyPos, i)
    }
    this.labelsDirty = true
    this.requestRender()
  }
  /** Replace every position from an x, y, z interleaved array (a layout landing). */
  setAllPositions(xyz: Float32Array) {
    const N = Math.min(this.graph.nodeCount, Math.floor(xyz.length / 3))
    for (let i = 0; i < N; i++) {
      this.posr[i * 4] = xyz[i * 3]
      this.posr[i * 4 + 1] = xyz[i * 3 + 1]
      this.posr[i * 4 + 2] = xyz[i * 3 + 2]
    }
    markAll(this.dirtyPos, N)
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }
  /** Positions x, y, z interleaved (a copy, for the worker). */
  positionsXYZ(): Float32Array {
    const N = this.graph.nodeCount
    const out = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      out[i * 3] = this.posr[i * 4]
      out[i * 3 + 1] = this.posr[i * 4 + 1]
      out[i * 3 + 2] = this.posr[i * 4 + 2]
    }
    return out
  }
  x(i: number): number {
    return this.posr[i * 4]
  }
  y(i: number): number {
    return this.posr[i * 4 + 1]
  }
  z(i: number): number {
    return this.posr[i * 4 + 2]
  }

  private rebuildGrid() {
    const t0 = performance.now()
    // Hidden nodes are not indexed: they cannot be picked, framed or labelled. The grid reads posr itself (stride 4).
    this.grid.build(this.posr, this.graph.nodeCount, this.visibleSet(), 4, 4)
    this.gridStale = false
    measure('gg:grid', { start: t0, detail: { nodes: this.grid.count } })
  }
  private visibleScratch = new BitSet(1024)
  /** Alive AND not filtered out. */
  private visibleSet(): BitSet {
    if (this.visibleScratch.size !== this.nodeCapacity) this.visibleScratch = new BitSet(this.nodeCapacity)
    return this.graph.nodeAlive.and(this.filtered, this.visibleScratch)
  }
  /** The spatial index, rebuilt if positions changed since. */
  gridNow(): SpatialGrid {
    if (this.gridStale) this.rebuildGrid()
    return this.grid
  }

  // ── Projection ──
  /** The current world → clip matrix (after `updateCamera`). */
  private updateCamera() {
    if (this.dims === 3) {
      this.camera3.update()
      this.viewProj.set(this.camera3.viewProj)
    } else {
      const c = this.camera
      ortho2d(this.viewProj, c.x, c.y, c.scale, c.width, c.height)
    }
  }
  /** Screen px of node `i` (false when behind the camera). */
  projectNode(i: number, out: { x: number; y: number }): boolean {
    if (this.dims === 3) return this.camera3.project(this.posr[i * 4], this.posr[i * 4 + 1], this.posr[i * 4 + 2], out) > 0
    out.x = this.camera.screenX(this.posr[i * 4])
    out.y = this.camera.screenY(this.posr[i * 4 + 1])
    return true
  }
  /** Depth (clip w) of a node in 3D, or 1 in 2D. */
  depthOf(i: number): number {
    if (this.dims !== 3) return 1
    return project(this.viewProj, this.posr[i * 4], this.posr[i * 4 + 1], this.posr[i * 4 + 2], this.ndc)
  }
  private sizeK(): number {
    // Sizes follow the space nodes have: nominal (the style's px) from ~24px of spacing up, shrinking when crowded.
    const k = Math.min(1, Math.max(0.15, this.spacing / 24)) * this.nodeSizeFactor
    return this.dims === 3 ? k * this.camera3.distance : k
  }
  /** The radius a node is drawn with, in CSS px. */
  radiusPx(i: number): number {
    const r = (this.posr[i * 4 + 3] * this.sizeK()) / this.depthOf(i)
    return Math.min(this.lod.nodeMaxPx, Math.max(this.lod.nodeMinPx, r))
  }

  // ── Picking ──
  /** The node under a screen point, or -1: synchronous in 2D (the grid); in 3D, the last GPU pick at the pointer. */
  pick(sx: number, sy: number): number {
    if (this.dims === 3) return this.hovered
    const grid = this.gridNow()
    const cam = this.camera
    const wx = cam.worldX(sx), wy = cam.worldY(sy)
    const reach = (this.lod.nodeMaxPx + 4) / cam.scale
    const drag = this.dragging
    return grid.nearest(this.posr, wx, wy, reach, (i) => Math.max(this.radiusPx(i), 4) / cam.scale, drag ? (i) => !drag.has(i) : undefined)
  }
  /** The node under a screen point: the grid in 2D, the GPU id pass in 3D. */
  pickAsync(sx: number, sy: number): Promise<number> {
    if (this.dims !== 3) return Promise.resolve(this.pick(sx, sy))
    if (!this.renderer) return Promise.resolve(-1)
    this.updateCamera()
    return this.renderer.pickNode(this.frameParams(), sx, sy)
  }
  /** The edge under a screen point (async on WebGPU). */
  pickEdge(sx: number, sy: number): Promise<number> {
    if (!this.renderer || !this.showEdges) return Promise.resolve(-1)
    this.updateCamera()
    return this.renderer.pickEdge(this.frameParams(), sx, sy)
  }
  private pt = { x: 0, y: 0 }
  private pt2 = { x: 0, y: 0 }
  /** Nodes whose centre is in a screen rectangle: the grid in 2D; in 3D every visible node is projected. */
  nodesInScreenRect(x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
    if (this.dims === 3) {
      this.updateCamera()
      const vis = this.visibleSet()
      const N = this.graph.nodeCount
      const pt = this.pt
      for (let i = 0; i < N; i++) {
        if (!vis.has(i)) continue
        if (!this.projectNode(i, pt)) continue
        if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) fn(i)
      }
      return
    }
    const cam = this.camera
    this.gridNow().forEachInRect(this.posr, cam.worldX(minX), cam.worldY(maxY), cam.worldX(maxX), cam.worldY(minY), fn)
  }

  // ── Selection ──
  /** Change the selection; flags are updated only for the nodes whose membership changed. */
  setSelection(indices: ArrayLike<number>, mode: SelectMode = 'replace', source: 'click' | 'marquee' | 'api' | 'neighbors' = 'api') {
    const sel = this.selected
    if (mode === 'replace') {
      sel.forEach((i) => this.flagOff(i, N_SELECTED))
      sel.clearAll()
      for (let k = 0; k < indices.length; k++) sel.set(indices[k])
    } else {
      if (mode === 'add') for (let k = 0; k < indices.length; k++) sel.set(indices[k])
      else if (mode === 'remove') for (let k = 0; k < indices.length; k++) sel.clear(indices[k])
      else for (let k = 0; k < indices.length; k++) sel.toggle(indices[k])
      for (let k = 0; k < indices.length; k++) if (!sel.has(indices[k])) this.flagOff(indices[k], N_SELECTED)
    }
    this.afterSelectionChange()
    this.emit('select', { source })
  }
  /**
   * How far the selection's highlight reaches: the nodes within `hops` links of it stay lit while the rest dims (1–6;
   * the explorer's Highlight setting, `graph_selection_action {highlight_hops}`). Recomputed now if something is
   * selected; a hover keeps to its first ring, since it moves with the pointer.
   */
  setHighlightHops(hops: number) {
    const h = Math.max(1, Math.min(6, Math.round(hops) || 1))
    if (h === this.highlightHops) return
    this.highlightHops = h
    if (!this.selected.isEmpty()) this.afterSelectionChange()
  }

  setSelectionBits(bits: BitSet, source: 'click' | 'marquee' | 'api' | 'neighbors' = 'api') {
    this.selected.forEach((i) => this.flagOff(i, N_SELECTED))
    this.selected.copyFrom(bits)
    this.afterSelectionChange()
    this.emit('select', { source })
  }
  selectAll(source: 'api' = 'api') {
    this.setSelectionBits(this.visibleSet(), source)
  }
  clearSelection(source: 'click' | 'api' = 'api') {
    if (this.selected.isEmpty() && this.selectedEdge < 0) return
    this.selected.forEach((i) => this.flagOff(i, N_SELECTED))
    this.selected.clearAll()
    this.setSelectedEdge(-1)
    this.afterSelectionChange()
    this.emit('select', { source })
  }
  selectNeighbors(i: number, mode: SelectMode = 'add') {
    let n = 0
    this.graph.forEachIncident(i, (_e, o) => {
      if (n < this.scratch.length) this.scratch[n++] = o
    })
    if (n === this.scratch.length) {
      // A hub with more neighbours than the scratch: fall back to a bitset walk.
      const bits = new BitSet(this.nodeCapacity)
      this.graph.forEachIncident(i, (_e, o) => bits.set(o))
      bits.set(i)
      if (mode === 'replace') this.setSelectionBits(bits, 'neighbors')
      else this.setSelectionBits(bits.or(this.selected, bits), 'neighbors')
      return
    }
    if (n < this.scratch.length) this.scratch[n++] = i
    this.setSelection(this.scratch.subarray(0, n), mode, 'neighbors')
  }
  selectedCount(): number {
    return this.selected.count()
  }
  /** Selected indices (allocates). */
  selectedIndices(): Uint32Array {
    return this.selected.toArray()
  }
  private flagOff(i: number, bit: number) {
    if (this.nodeFlags[i] & bit) {
      this.nodeFlags[i] &= ~bit
      mark(this.dirtyFlags, i)
    }
  }
  private flagOn(i: number, bit: number) {
    if (!(this.nodeFlags[i] & bit)) {
      this.nodeFlags[i] |= bit
      mark(this.dirtyFlags, i)
    }
  }
  private afterSelectionChange() {
    const sel = this.selected
    // Selected nodes not in the picture are dropped silently: selection is over visible nodes.
    sel.and(this.visibleSet())
    sel.forEach((i) => this.flagOn(i, N_SELECTED))
    // The neighbourhood, when the selection is small enough for it to mean something.
    this.around.forEach((i) => this.flagOff(i, N_AROUND))
    this.around.clearAll()
    const count = sel.count()
    if (count > 0 && count <= AROUND_MAX_SELECTED) {
      this.graph.neighborhood(sel, this.around)
      this.around.andNot(sel)
      // Further rings breadth-first: each hop walks only the ring the last one added, so n hops cost the edges of what
      // they reach, not n passes over the graph.
      if (this.highlightHops > 1) {
        let ring = this.around.clone()
        const next = new BitSet(this.around.size)
        for (let h = 1; h < this.highlightHops && !ring.isEmpty(); h++) {
          next.clearAll()
          this.graph.neighborhood(ring, next)
          next.andNot(sel)
          next.andNot(this.around)
          this.around.or(next)
          ring = next.clone()
        }
      }
      this.around.forEach((i) => this.flagOn(i, N_AROUND))
    }
    this.hoverAround.forEach((i) => this.flagOn(i, N_AROUND))
    this.labelsDirty = true
    this.requestRender()
  }
  /** Something is in focus when a selection, hover or path sets some nodes apart from the rest. */
  private inFocus(): boolean {
    if (this.hovered >= 0 || this.pathNodes.first() >= 0 || this.selectedEdge >= 0 || this.hoveredEdge >= 0) return true
    const n = this.selected.count()
    return n > 0 && n < this.visibleCount()
  }

  setSelectedEdge(e: number) {
    if (this.selectedEdge === e) return
    if (this.selectedEdge >= 0) {
      this.edgeData[this.selectedEdge * 4 + 3] &= ~E_SELECTED
      mark(this.dirtyEdges, this.selectedEdge)
    }
    this.selectedEdge = e
    if (e >= 0) {
      this.edgeData[e * 4 + 3] |= E_SELECTED
      mark(this.dirtyEdges, e)
    }
    this.requestRender()
  }
  setHoveredEdge(e: number) {
    if (this.hoveredEdge === e) return
    if (this.hoveredEdge >= 0) {
      this.edgeData[this.hoveredEdge * 4 + 3] &= ~E_HOVERED
      mark(this.dirtyEdges, this.hoveredEdge)
    }
    this.hoveredEdge = e
    if (e >= 0) {
      this.edgeData[e * 4 + 3] |= E_HOVERED
      mark(this.dirtyEdges, e)
    }
    this.requestRender()
  }

  // ── Hover ──
  setHover(i: number) {
    if (i === this.hovered) return
    if (this.hovered >= 0) this.flagOff(this.hovered, N_HOVERED)
    this.hoverAround.forEach((j) => {
      if (!this.around.has(j)) this.flagOff(j, N_AROUND)
    })
    this.hoverAround.clearAll()
    this.hovered = i
    if (i >= 0) {
      this.flagOn(i, N_HOVERED)
      if (this.graph.degree[i] <= HOVER_AROUND_MAX_DEGREE) {
        this.graph.forEachIncident(i, (_e, o) => this.hoverAround.set(o))
        this.hoverAround.forEach((j) => this.flagOn(j, N_AROUND))
      }
    }
    this.labelsDirty = true
    this.requestRender()
    this.emit('hover', i)
  }

  // ── Pins, path, filter ──
  private setPinnedOne(i: number, on: boolean) {
    this.pinned.put(i, on)
    if (on) this.flagOn(i, N_PINNED)
    else this.flagOff(i, N_PINNED)
  }
  setPinned(indices: ArrayLike<number>) {
    this.pinned.forEach((i) => this.flagOff(i, N_PINNED))
    this.pinned.clearAll()
    for (let k = 0; k < indices.length; k++) this.setPinnedOne(indices[k], true)
    this.requestRender()
  }
  setPath(nodes: ArrayLike<number>, edges: ArrayLike<number>) {
    this.pathNodes.forEach((i) => this.flagOff(i, N_PATH))
    this.pathNodes.clearAll()
    for (const e of this.pathEdges) {
      this.edgeData[e * 4 + 3] &= ~E_PATH
      mark(this.dirtyEdges, e)
    }
    this.pathEdges = []
    for (let k = 0; k < nodes.length; k++) {
      this.pathNodes.set(nodes[k])
      this.flagOn(nodes[k], N_PATH)
    }
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k]
      if (e < 0 || !this.graph.hasEdge(e)) continue
      this.pathEdges.push(e)
      this.edgeData[e * 4 + 3] |= E_PATH
      mark(this.dirtyEdges, e)
    }
    this.labelsDirty = true
    this.requestRender()
  }
  /** Show only the nodes in `keep` (every alive node when null). Edges follow their ends through the shaders. */
  setFilter(keep: BitSet | null) {
    const N = this.graph.nodeCount
    for (let i = 0; i < N; i++) {
      if (!this.graph.nodeAlive.has(i)) continue
      const on = keep ? keep.has(i) : true
      if (on !== this.filtered.has(i)) {
        this.filtered.put(i, on)
        this.nodeFlags[i] = on ? this.nodeFlags[i] & ~(N_HIDDEN | N_FILTERED) : this.nodeFlags[i] | N_HIDDEN | N_FILTERED
        mark(this.dirtyFlags, i)
      }
    }
    this.gridStale = true
    this.afterSelectionChange()
  }
  /** Keep the nodes of these types (codes), or all when the set is empty. */
  filterTypes(types: Set<number> | null, minDegree = 0, maxDegree = Infinity) {
    if (!types && minDegree <= 0 && maxDegree === Infinity) return this.setFilter(null)
    const keep = new BitSet(this.nodeCapacity)
    const N = this.graph.nodeCount
    for (let i = 0; i < N; i++) {
      if (types && !types.has(this.graph.nodeType[i])) continue
      const d = this.graph.degree[i]
      if (d < minDegree || d > maxDegree) continue
      keep.set(i)
    }
    this.setFilter(keep)
  }
  visibleCount(): number {
    return this.visibleSet().count()
  }
  /** Show/hide edges of a relationship type code (or all with -1). */
  setEdgesVisible(type: number, on: boolean) {
    const E = this.graph.edgeCount
    for (let e = 0; e < E; e++) {
      if (!this.graph.hasEdge(e)) continue
      if (type >= 0 && this.graph.edgeType[e] !== type) continue
      const d = e * 4 + 3
      const f = on ? this.edgeData[d] & ~(E_HIDDEN | E_FILTERED) : this.edgeData[d] | E_HIDDEN | E_FILTERED
      if (f !== this.edgeData[d]) {
        this.edgeData[d] = f >>> 0
        mark(this.dirtyEdges, e)
      }
    }
    this.requestRender()
  }

  // ── Camera ──
  /** The box around the visible nodes. */
  extent() {
    return extent(this.posr, this.graph.nodeCount, this.visibleSet(), 4)
  }
  /**
   * Whether any shown node is inside the view — what decides if a changed picture (a filter narrowed or widened) can
   * keep the camera it has, or must be framed because nothing of it would be on screen. In 2D the nodes themselves,
   * stopping at the first; in 3D the picture's extent against the view's footprint, which is what a tilt allows.
   */
  anyInView(): boolean {
    const v = this.viewport()
    if (this.dims === 3) {
      const e = this.extent()
      return !!e && e.maxX >= v.minX && e.minX <= v.maxX && e.maxY >= v.minY && e.minY <= v.maxY
    }
    const vis = this.visibleSet()
    const p = this.posr
    for (let i = 0; i < this.graph.nodeCount; i++) {
      if (!vis.has(i)) continue
      const x = p[i * 4], y = p[i * 4 + 1]
      if (x >= v.minX && x <= v.maxX && y >= v.minY && y <= v.maxY) return true
    }
    return false
  }
  /** A fit asked for while the container had no size yet (a pane still laying out) is done again at the first real size. */
  private refitOnResize: { padding?: number } | null = null
  /**
   * What a 3D fit frames besides — or instead of — the nodes, asked at the fit: the slide layer answers with its slides
   * and the body of the web under them (`replace`: that box alone, so a few straggling nodes do not push the slides
   * off the top of the view), or null.
   */
  fitExtra: (() => { box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }; replace?: boolean } | null) | null = null
  /** Where the last 3D fit put the camera (target and distance), for telling a fitted view from one somebody placed. */
  private lastFit: { tx: number; ty: number; tz: number; distance: number } | null = null
  /** Whether the 3D camera is at — or flying to — where the last fit put it: a view nobody has placed since. */
  atLastFit(): boolean {
    const f = this.lastFit
    if (!f || this.dims !== 3) return false
    const d = this.camera3.destination()
    const tol = Math.max(1e-6, f.distance * 1e-4)
    return Math.abs(d.tx - f.tx) <= tol && Math.abs(d.ty - f.ty) <= tol && Math.abs(d.tz - f.tz) <= tol && Math.abs(d.distance - f.distance) <= tol
  }
  fit(opts: { padding?: number; ms?: number } = {}) {
    const nodes = this.extent()
    if (!nodes) return
    const extra = this.dims === 3 && this.fitExtra ? this.fitExtra() : null
    const x = extra?.box
    const box = !x ? nodes : extra.replace ? { ...nodes, ...x } : { ...nodes, minX: Math.min(nodes.minX, x.minX), minY: Math.min(nodes.minY, x.minY), minZ: Math.min(nodes.minZ, x.minZ), maxX: Math.max(nodes.maxX, x.maxX), maxY: Math.max(nodes.maxY, x.maxY), maxZ: Math.max(nodes.maxZ, x.maxZ) }
    this.refitOnResize = this.camera.width <= 1 || this.camera.height <= 1 ? { padding: opts.padding } : null
    // A picture of one node — or of every node on one spot — spans nothing, and a fit of it would zoom in forever: it
    // gets a window thirty radii across, so the node sits in the middle with room around it. A radius is the style's
    // size in px; it stands in for world units here only because a point has no other scale. A picture with any span
    // is framed as it is: nodes keep their pixel size at every zoom, so a tighter frame never piles them up. Applied
    // always, the window held any picture narrower than thirty of its biggest radii at that width — a 3D map sized by
    // degree, whose hubs are drawn large, opened at the same distance whatever its extent, small in the middle.
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ)
    const minSpan = span > 1e-6 ? 0 : Math.max(1, box.maxR || 4) * 30
    const grow = (lo: number, hi: number): [number, number] => (hi - lo >= minSpan ? [lo, hi] : [(lo + hi) / 2 - minSpan / 2, (lo + hi) / 2 + minSpan / 2])
    const [minX, maxX] = grow(box.minX, box.maxX)
    const [minY, maxY] = grow(box.minY, box.maxY)
    if (this.dims === 3) {
      const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, cz = (box.minZ + box.maxZ) / 2
      // The largest extent, not the box diagonal: a flat cloud seen from above fills the view like a disc does.
      const r = Math.max(maxX - minX, maxY - minY, box.maxZ - box.minZ) * 0.55
      this.camera3.fitSphere(cx, cy, cz, r * (1 + (opts.padding ?? 0.08)), opts.ms ?? 0)
      this.lastFit = this.camera3.destination()
      if (!(opts.ms! > 0)) this.camera3.fitDistance = this.camera3.distance
    } else {
      this.camera.fitBox(minX, minY, maxX, maxY, { padding: opts.padding ?? 0.08, ms: opts.ms ?? 0 })
      if (!(opts.ms! > 0)) this.camera.fitScale = this.camera.scale
    }
    this.cameraChanged()
  }
  fitTo(indices: ArrayLike<number>, opts: { padding?: number; ms?: number } = {}) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      if (!this.graph.hasNode(i) || !this.filtered.has(i)) continue
      const x = this.posr[i * 4], y = this.posr[i * 4 + 1], z = this.posr[i * 4 + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    if (!Number.isFinite(minX)) return
    // 2D flies on the zoom-and-pan path, its length setting the time unless `ms` is given; 3D dollies over `ms`.
    const ms = opts.ms
    if (this.dims === 3) {
      const r = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2, this.camera3.fitDistance * 0.02)
      this.camera3.fitSphere((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, r * (1 + (opts.padding ?? 0.3)), ms ?? 300)
    } else {
      // A single node: a comfortable window around it rather than an infinite zoom.
      const pad = Math.max(40 / this.camera.scale, (maxX - minX) * (opts.padding ?? 0.3), (maxY - minY) * (opts.padding ?? 0.3))
      this.camera.fitBox(minX - pad, minY - pad, maxX + pad, maxY + pad, { padding: 0, ms })
    }
    this.cameraChanged()
  }
  /** The visible rectangle in world units (2D), or the rectangle facing the camera at the target's depth (3D). */
  viewport(): { minX: number; minY: number; maxX: number; maxY: number; z?: number; tilted?: boolean } {
    if (this.dims === 3) {
      const c = this.camera3
      const h = (c.distance * c.height) / c.focalPx
      const w = (h * c.width) / c.height
      return { minX: c.tx - w / 2, maxX: c.tx + w / 2, minY: c.ty - h / 2, maxY: c.ty + h / 2, z: c.tz, tilted: Math.abs(c.pitch) > 0.01 || Math.abs(c.yaw) > 0.01 }
    }
    return this.camera.viewport({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  }
  /** The view calls this after any camera change it made (pan, zoom, orbit) so labels follow. */
  cameraChanged() {
    this.cameraMoved = true
    this.emit('camera')
    this.requestRender()
  }

  // ── Frame ──
  /** A view behind another page or tab draws and simulates nothing; what it missed is drawn on return. */
  private paused = false
  setPaused(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    if (paused) {
      if (this.raf) cancelAnimationFrame(this.raf)
      this.raf = 0
      this.needRender = true
    } else this.requestRender()
  }
  requestRender() {
    this.needRender = true
    if (this.raf || !this.container || this.paused) return
    this.raf = requestAnimationFrame(this.frame)
  }
  private frame = (now: number) => {
    this.raf = 0
    if (this.paused) return
    const animating = this.dims === 3 ? this.camera3.tick(now) : this.camera.tick(now)
    if (animating) {
      this.cameraMoved = true
      this.emit('camera')
    }
    const simulating = this.physicsMode !== null && this.physicsTick()
    if (this.needRender || animating || simulating) this.renderNow(now)
    if (animating || this.needRender || simulating) this.raf = requestAnimationFrame(this.frame)
  }

  private frameParams(): FrameParams {
    const cam = this.camera
    return {
      width: cam.width,
      height: cam.height,
      dpr: this.dpr,
      viewProj: this.viewProj,
      ortho: this.dims !== 3,
      sizeK: this.sizeK(),
      nodeMinPx: this.lod.nodeMinPx,
      nodeMaxPx: this.lod.nodeMaxPx,
      lod: this.lod.regime,
      edgeWidthPx: this.lod.edgeWidthPx,
      edgeAlpha: this.lod.edgeAlpha,
      edgeStride: this.lod.edgeStride,
      focus: this.inFocus(),
      fadeAlpha: 0.18,
      edgeFadeAlpha: 0.12,
      arrows: this.lod.arrows,
      background: this.background,
      selectColor: this.selectColor,
      hoverColor: this.hoverColor,
      pathColor: this.pathColor,
      nodeCount: this.graph.nodeCount,
      edgeCount: this.showEdges ? this.graph.edgeCount : 0,
    }
  }

  /** How many visible nodes are on screen: exact from the grid in 2D; in 3D a projected sample, scaled up. */
  /**
   * How many nodes are on screen, at most every VIEW_COUNT_MS while the camera holds still. In 3D the count is a
   * projection of forty thousand nodes, and it is only the input to the LOD regime and the figure in the HUD:
   * measured on a live simulation over 820,000 nodes it was an eighth of the main thread, every frame, to refine
   * an estimate that changes slowly. A camera move recounts at once — that is when it really changes.
   */
  private countInViewNow(now: number): number {
    if (this.dims !== 3) return this.countInView()
    if (this.cameraMoved || !this.inViewAt || now - this.inViewAt >= VIEW_COUNT_MS) {
      this.inViewCount = this.countInView()
      this.inViewAt = now
    }
    return this.inViewCount
  }
  private inViewCount = 0
  private inViewAt = 0

  private countInView(): number {
    if (this.dims !== 3) {
      this.camera.viewport(this.vp)
      return this.grid.countInRect(this.vp.minX, this.vp.minY, this.vp.maxX, this.vp.maxY)
    }
    const N = this.graph.nodeCount
    const vis = this.visibleSet()
    const total = this.grid.count
    if (!total) return 0
    const step = Math.max(1, Math.ceil(N / VIEW_SAMPLE))
    let sampled = 0, inside = 0
    const pt = this.pt
    const W = this.camera3.width, H = this.camera3.height
    for (let i = 0; i < N; i += step) {
      if (!vis.has(i)) continue
      sampled++
      if (this.projectNode(i, pt) && pt.x >= 0 && pt.x <= W && pt.y >= 0 && pt.y <= H) inside++
    }
    return sampled ? Math.round((inside / sampled) * total) : 0
  }

  /** Upload what changed, choose the LOD for this camera, draw, and redraw labels when they are stale. */
  renderNow(now = performance.now()) {
    this.needRender = false
    const r = this.renderer
    const t0 = performance.now()
    // While the physics runs the picture changes every frame: the grid is rebuilt when an interaction asks for
    // it (`gridNow`) and when the run stops, not every twelfth frame for a count that is only an estimate anyway.
    if (this.gridStale && (!this.physicsMode || !this.grid.count)) this.rebuildGrid()
    this.updateCamera()
    const inView = this.countInViewNow(now)
    this.spacing = spacingPx(this.camera.width, this.camera.height, inView)
    const edgesInView = this.grid.count ? Math.round((inView / this.grid.count) * this.graph.edgeCount) : 0
    const lod = lodFor(this.spacing, edgesInView, this.lod.regime)
    if (lod.regime !== this.lod.regime) this.labelsDirty = true
    this.lod = lod
    const focus = this.inFocus()
    if (focus !== this.lastFocus) {
      this.lastFocus = focus
      this.labelsDirty = true
    }
    if (r) {
      const N = this.graph.nodeCount
      const na = { posr: this.posr, color: this.nodeColor, flags: this.nodeFlags }
      this.dirtyPos.flush(N, (a, b) => r.uploadNodes(na, a, b, { posr: true }))
      this.dirtyColor.flush(N, (a, b) => r.uploadNodes(na, a, b, { color: true }))
      this.dirtyFlags.flush(this.nodeCapacity, (a, b) => r.uploadNodes(na, a, b, { flags: true }))
      this.dirtyEdges.flush(this.edgeCapacity, (a, b) => r.uploadEdges({ data: this.edgeData }, a, b))
      r.render(this.frameParams())
    }
    // Labels: on every camera frame in the close regimes (they move with the picture), else only when stale.
    const mode = this.labelMode === 'none' ? 'none' : this.labelMode === 'all' ? (lod.regime === 0 ? 'focus' : 'all') : lod.labels
    if (this.labelLayer && (this.labelsDirty || this.cameraMoved)) {
      this.drawLabels(mode)
      this.labelsDirty = false
    }
    this.cameraMoved = false
    const ms = performance.now() - t0
    this.frameTimes[this.frameIndex++ % 60] = ms
    this.frames++
    let sum = 0
    const n = Math.min(60, this.frames)
    for (let k = 0; k < n; k++) sum += this.frameTimes[k]
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 0
    this.lastFrameAt = now
    this.stats = { frameMs: ms, meanMs: sum / n, fps: dt > 0 ? Math.min(240, 1000 / dt) : 0, drawCalls: r?.drawCalls ?? 0, nodesInView: inView, regime: lod.regime, labels: this.labelLayer?.drawn ?? 0, frames: this.frames }
    this.emit('frame', this.stats)
  }

  private drawLabels(mode: 'none' | 'focus' | 'some' | 'all') {
    const layer = this.labelLayer!
    if (mode === 'none') {
      layer.clear()
      return
    }
    // Focus: hovered, path, then the selection (capped: a select-all is not a million labels).
    let nf = 0
    const focus = this.focusIds
    if (this.hovered >= 0) focus[nf++] = this.hovered
    const pushBits = (b: BitSet, cap: number) => {
      const words = b.words
      for (let wi = 0; wi < words.length && nf < cap; wi++) {
        let v = words[wi]
        while (v && nf < cap) {
          const t = v & -v
          focus[nf++] = (wi << 5) + (31 - Math.clz32(t))
          v ^= t
        }
      }
    }
    pushBits(this.pathNodes, 200)
    pushBits(this.selected, Math.min(focus.length, 400))
    if (this.selectedCount() <= 60) pushBits(this.around, Math.min(focus.length, 500))
    const degree = this.graph.degree
    const W = this.camera.width, H = this.camera.height
    let inViewCount = 0
    layer.draw(
      {
        labels: this.labels,
        labelFallback: this.labelFallback,
        nodeFlags: this.nodeFlags,
        project: (i, out) => this.projectNode(i, out),
        width: W,
        height: H,
        radiusPx: (i) => this.radiusPx(i),
        candidates: (out, max) => {
          // Everything in view, hubs first, cut to `max`. In 3D a sample of the visible nodes is projected.
          let n = 0
          let scratch = this.inViewScratch
          const push = (i: number) => {
            if (n === scratch.length) {
              const bigger = new Uint32Array(scratch.length * 2)
              bigger.set(scratch)
              this.inViewScratch = scratch = bigger
            }
            scratch[n++] = i
          }
          if (this.dims === 3) {
            const N = this.graph.nodeCount
            const vis = this.visibleSet()
            const step = Math.max(1, Math.ceil(N / VIEW_SAMPLE))
            const pt = this.pt
            for (let i = 0; i < N; i += step) {
              if (!vis.has(i)) continue
              if (this.projectNode(i, pt) && pt.x >= 0 && pt.x <= W && pt.y >= 0 && pt.y <= H) push(i)
            }
          } else {
            // While the physics runs the grid is left stale (see renderNow): its cells are a frame or so behind
            // the positions, which is fine for choosing candidates and saves a rebuild per frame.
            const grid = this.physicsMode ? this.grid : this.gridNow()
            const vp = this.vp
            grid.forEachInRect(this.posr, vp.minX, vp.minY, vp.maxX, vp.maxY, push)
          }
          // Hubs first, and the same order whatever the grid's cell order: which label wins a patch of screen then
          // does not change from frame to frame while nodes move (a drag, the physics), so labels do not flicker.
          const view = scratch.subarray(0, n)
          view.sort((a, b) => degree[b] - degree[a] || a - b)
          const k = Math.min(n, max)
          out.set(view.subarray(0, k))
          inViewCount = k
          return k
        },
        edges: this.showEdgeLabels ? (visit) => this.forEachEdgeLabel(inViewCount, visit) : undefined,
      },
      this.dpr,
      mode,
      focus,
      nf,
      undefined,
      undefined,
      this.labelsKeep,
    )
    this.labelsKeep = false
  }

  /**
   * The edges among the first `n` label candidates (the nodes in view, hubs first, in `inViewScratch`): each once,
   * lit ones first, with its ends on screen and its bend. Walks the incident edges of the nodes in view, so the cost
   * follows the picture, never the graph.
   */
  private forEachEdgeLabel(n: number, visit: (text: string, ax: number, ay: number, bx: number, by: number, curvature: number, lit: boolean) => void) {
    const scratch = this.inViewScratch
    const seen = this.edgeSeen
    if (seen.size < this.edgeCapacity) seen.resize(this.edgeCapacity)
    seen.clearAll()
    const a = this.pt, b = this.pt2
    const edgeData = this.edgeData
    const lits: number[] = []
    const emit = (e: number) => {
      const text = this.edgeLabels[e] ?? this.edgeTypes.name(this.graph.edgeType[e])
      if (!text) return
      const s = edgeData[e * 4], t = edgeData[e * 4 + 1]
      if (!this.projectNode(s, a) || !this.projectNode(t, b)) return
      const f = edgeData[e * 4 + 3]
      visit(text, a.x, a.y, b.x, b.y, ((f << 16) >> 24) / 64, (f & (E_SELECTED | E_HOVERED | E_PATH)) !== 0)
    }
    for (let k = 0; k < n; k++) {
      const i = scratch[k]
      this.graph.forEachIncident(i, (e, other) => {
        if (seen.has(e)) return
        seen.set(e)
        const f = edgeData[e * 4 + 3]
        if (f & E_HIDDEN || this.nodeFlags[other] & N_HIDDEN) return
        if (f & (E_SELECTED | E_HOVERED | E_PATH)) lits.push(e)
        else emit(e)
      })
    }
    for (const e of lits) emit(e)
  }

  /** A PNG of the canvas as drawn now. */
  /**
   * The view as an image: graph and labels composed on one canvas.
   *
   * `maxWidth` scales it down (a retina canvas is 3,200 px wide, and nothing reading this needs that), and a
   * picture of a graph — thousands of small dots on a flat ground — costs a fifth as many bytes as JPEG as it does
   * as PNG with no loss that matters. A caller that wants the pixels exactly asks for `format: 'png'`.
   */
  async snapshot(opts: { maxWidth?: number; format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<Blob | null> {
    const r = this.renderer
    if (!r || !this.labelLayer) return null
    this.renderNow()
    const scale = opts.maxWidth ? Math.min(1, opts.maxWidth / r.canvas.width) : 1
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(r.canvas.width * scale))
    out.height = Math.max(1, Math.round(r.canvas.height * scale))
    const ctx = out.getContext('2d')!
    if (opts.format === 'jpeg') {
      // JPEG has no transparency: the ground the graph is drawn on has to be painted first.
      ctx.fillStyle = packedToHex(this.background)
      ctx.fillRect(0, 0, out.width, out.height)
    }
    if (scale !== 1) ctx.scale(scale, scale)
    ctx.drawImage(r.canvas, 0, 0)
    ctx.drawImage(this.labelLayer.canvas, 0, 0)
    // What is drawn over the picture in the page (the slide layer) draws itself into the picture too.
    for (const o of this.overlays) o.draw?.(ctx, this.dpr)
    const type = opts.format === 'png' ? 'image/png' : 'image/jpeg'
    return new Promise((resolve) => out.toBlob((b) => resolve(b), type, opts.quality ?? 0.82))
  }

  // ── Live physics ──
  /**
   * The symmetric adjacency of the alive edges as CSR, for the simulation: the graph's own CSR once it is exact
   * (a compaction is one counting sort, no closures) — copies, since the worker path transfers them.
   */
  private physicsCsr(): { offsets: Uint32Array; neighbors: Uint32Array } {
    const g = this.graph
    const N = g.nodeCount
    if (!g.csrIsExact()) g.compact()
    return { offsets: g.offsets.slice(0, N + 1), neighbors: g.neighbors.slice(0, g.offsets[N]) }
  }
  /** The link length at which the defaults pack the nodes into the ball (disc) they occupy now: its radius is the 90th percentile of the distances from the centroid over a sample. */
  private packingLinkLength(): number {
    const N = this.graph.nodeCount
    const posr = this.posr
    const step = Math.max(1, Math.floor(N / 4096))
    let cx = 0, cy = 0, cz = 0, n = 0
    for (let i = 0; i < N; i += step) {
      if (!this.graph.nodeAlive.has(i) || this.nodeFlags[i] & N_HIDDEN) continue
      cx += posr[i * 4]
      cy += posr[i * 4 + 1]
      cz += posr[i * 4 + 2]
      n++
    }
    if (n < 2) return 0
    cx /= n
    cy /= n
    cz /= n
    const r: number[] = []
    for (let i = 0; i < N; i += step) {
      if (!this.graph.nodeAlive.has(i) || this.nodeFlags[i] & N_HIDDEN) continue
      const dx = posr[i * 4] - cx, dy = posr[i * 4 + 1] - cy, dz = this.dims === 3 ? posr[i * 4 + 2] - cz : 0
      r.push(Math.sqrt(dx * dx + dy * dy + dz * dz))
    }
    r.sort((a, b) => a - b)
    const radius = r[Math.floor(r.length * 0.9)]
    if (!(radius > 0)) return 0
    const alive = this.graph.aliveNodes()
    const volume = this.dims === 3 ? (4 / 3) * Math.PI * radius ** 3 : Math.PI * radius * radius
    return Math.pow(volume / Math.max(1, alive), 1 / this.dims) / packingSpacing(this.physicsParams, this.dims)
  }
  /** Pinned ∪ dragging as bitset words; returns whether they changed since last asked. */
  private refreshHeld(): boolean {
    const words = Math.max(1, Math.ceil(this.graph.nodeCount / 32))
    const next = new Uint32Array(words)
    const pin = this.pinned.words
    for (let w = 0; w < Math.min(words, pin.length); w++) next[w] = pin[w]
    const drag = this.dragging?.words
    if (drag) for (let w = 0; w < Math.min(words, drag.length); w++) next[w] |= drag[w]
    let same = next.length === this.heldWords.length
    if (same) for (let w = 0; w < words; w++) if (next[w] !== this.heldWords[w]) { same = false; break }
    if (same) return false
    this.heldWords = next
    return true
  }
  physicsState(): PhysicsState {
    const gp = this.gpuPhysics
    return {
      on: this.physicsMode !== null,
      mode: this.physicsMode,
      alpha: this.physicsMode === 'gpu' ? gp?.alpha ?? this.physicsParams.alpha : this.physicsWorkerAlpha,
      cooled: this.physicsMode === 'gpu' ? gp?.cooled ?? false : this.physicsWorkerAlpha < this.physicsParams.alphaMin,
      iterations: this.physicsMode === 'gpu' ? gp?.iterations ?? 0 : this.physicsWorkerIterations,
      perFrame: this.physicsMode === 'gpu' && gp ? Math.min(this.physicsPerFrame, gp.alpha > PHYSICS_WATCH_ALPHA ? PHYSICS_MAX_PER_FRAME : PHYSICS_MAX_PER_FRAME_COOL) : this.physicsPerFrame,
      msPerIteration: this.physicsMode === 'gpu' ? this.physicsMsPerIteration || NaN : NaN,
      nodes: this.graph.nodeCount,
      edges: this.graph.edgeCount,
    }
  }
  /**
   * Start the live simulation over the whole graph: on the GPU when the backend is WebGPU (positions step in
   * place, a few dispatches per frame), else in the worker (positions come back per batch). Returns where it runs.
   */
  startPhysics(params: Partial<PhysicsParams> = {}): 'gpu' | 'worker' | null {
    this.stopPhysicsNow()
    const run = ++this.physicsRun
    // A start is a fresh run: the defaults, then what was asked (`setPhysicsParams` adjusts a running one).
    this.physicsParams = { ...DEFAULT_PHYSICS, ...params, dims: this.dims }
    const N = this.graph.nodeCount
    if (!N) return null
    const { offsets, neighbors } = this.physicsCsr()
    // Unless asked for a length, the picture keeps its extent: the rest length is the spacing the nodes would
    // have spread evenly over the ball they occupy now, over the 1.5 link distances the defaults pack at (the
    // other forces are in units of it).
    if (params.linkDistance === undefined) {
      const L = this.packingLinkLength()
      if (L > 0) this.physicsParams.linkDistance = L
    }
    this.refreshHeld()
    this.physicsFrames = 0
    this.physicsCooledSaid = false
    this.physicsPerFrame = 1
    this.physicsMsPerIteration = 0
    const r = this.renderer
    if (!r) {
      // The backend is still being made: the run starts when it is there (on the GPU if that is WebGPU).
      this.physicsPending = true
      this.physicsPendingParams = params
      this.physicsMode = 'gpu'
      this.emit('physics', this.physicsState())
      return 'gpu'
    }
    this.physicsPending = false
    if (r.kind === 'webgpu') {
      const target = (r as WebGPURenderer).compute
      try {
        const gp = new GpuPhysics(target, this.physicsParams)
        gp.onError = (message) => {
          if (this.gpuPhysics !== gp) return
          this.emit('error', `Physics: ${message}`)
          this.stopPhysicsNow()
          this.emit('physics', this.physicsState())
        }
        gp.load(N, offsets, neighbors, this.heldWords)
        this.gpuPhysics = gp
        this.physicsMode = 'gpu'
      } catch (err) {
        this.emit('error', `Physics: ${err instanceof Error ? err.message : String(err)}`)
        this.gpuPhysics = null
        this.physicsMode = null
        return null
      }
    } else {
      // In the worker every iteration is CPU time: a run cools within the same budget of work as the CPU layout
      // (`core/graph/layouts.ts`), faster on a big graph, so it settles in seconds rather than minutes.
      const budget = Math.max(30, Math.floor(WORKER_FORCE_WORK / Math.max(1, N + this.graph.edgeCount)))
      if (coolingSteps(this.physicsParams) > budget) this.physicsParams.alphaDecay = decayFor(this.physicsParams, budget)
      const positions = this.positionsXYZ()
      const state = new Uint8Array(N)
      for (let i = 0; i < N; i++) state[i] = (this.graph.nodeAlive.has(i) && !(this.nodeFlags[i] & N_HIDDEN) ? 1 : 0) | (this.heldWords[i >> 5] & (1 << (i & 31)) ? 2 : 0)
      this.physicsWorkerAlpha = this.physicsParams.alpha
      this.physicsWorkerIterations = 0
      this.physicsWorkerBusy = true
      void this.worker
        .call({ op: 'physicsStart', nodeCount: N, offsets, neighbors, positions, state, params: this.physicsParams }, [offsets.buffer, neighbors.buffer, positions.buffer, state.buffer])
        .then(() => {
          if (run !== this.physicsRun) return
          this.physicsWorkerBusy = false
          this.pumpWorkerPhysics()
        })
        .catch(() => (this.physicsMode = null))
      this.physicsMode = 'worker'
    }
    this.emit('physics', this.physicsState())
    this.requestRender()
    return this.physicsMode
  }
  /** More iterations for a big graph, as many as fit the time (see `AUTO_COOL_FROM`); only at the default cooling. */
  private autoCooling(gp: GpuPhysics) {
    const p = this.physicsParams
    if (p.alphaDecay !== DEFAULT_PHYSICS.alphaDecay) return
    const base = coolingSteps(p)
    const want = Math.round(base * Math.min(AUTO_COOL_MAX, Math.max(1, Math.sqrt(this.graph.nodeCount / AUTO_COOL_FROM))))
    // Frames: the hot part at four a frame, the rest at what the budget allows (up to the cool cap), sixty a second.
    const hot = Math.ceil(Math.log(PHYSICS_WATCH_ALPHA / p.alpha) / Math.log(1 - p.alphaDecay))
    const tail = Math.min(PHYSICS_MAX_PER_FRAME_COOL, this.physicsPerFrame)
    const fit = hot + Math.max(0, AUTO_COOL_SECONDS * 60 - hot / PHYSICS_MAX_PER_FRAME) * tail
    const steps = Math.min(want, Math.floor(fit))
    if (steps <= base) return
    const decay = decayFor(p, steps)
    this.physicsParams = { ...p, alphaDecay: decay }
    gp.params = { ...gp.params, alphaDecay: decay }
  }
  /**
   * Whether the CPU copy of the positions — what `pick` searches — may be behind the picture: a live run on the GPU
   * that has not settled, whose positions come back every dozen frames.
   */
  positionsLag(): boolean {
    return this.physicsMode === 'gpu' && !!this.gpuPhysics && !this.gpuPhysics.cooled
  }
  /** No steps while set: a press waits for a read-back of the picture as it stands (`freshPositions`). */
  private physicsPaused = false
  /** Hold the run still and bring the CPU copy up to date with what is drawn; the run goes on when it lands. */
  async freshPositions(): Promise<void> {
    if (!this.positionsLag()) return
    this.physicsPaused = true
    try {
      await this.physicsLastRead
      await this.readbackPhysics()
      this.gridStale = true
    } finally {
      this.physicsPaused = false
      this.requestRender()
    }
  }
  /** Warm the run back up — a drag, a change of parameters. */
  reheatPhysics(alpha = this.physicsParams.alpha) {
    if (this.physicsMode === 'gpu') this.gpuPhysics?.reheat(alpha)
    else if (this.physicsMode === 'worker') this.physicsWorkerAlpha = Math.max(this.physicsWorkerAlpha, alpha)
    this.physicsCooledSaid = false
    this.requestRender()
  }
  /** Change parameters mid-run (and reheat). */
  setPhysicsParams(params: Partial<PhysicsParams>) {
    this.physicsParams = { ...this.physicsParams, ...params }
    if (this.gpuPhysics) this.gpuPhysics.params = { ...this.gpuPhysics.params, ...params }
    if (this.physicsMode === 'worker') void this.worker.call({ op: 'physicsParams', params: this.physicsParams })
    this.reheatPhysics()
  }
  /** Stop; the positions the simulation reached are the engine's (read back from the GPU first). */
  async stopPhysics(): Promise<void> {
    const gp = this.gpuPhysics
    if (this.physicsMode === 'gpu' && gp) {
      // No more steps from here; a copy in flight lands first, then one more with the last positions.
      this.physicsStopping = true
      await this.physicsLastRead
      await this.readbackPhysics()
      // A run started while this one was being read back is the newer one, and stays.
      if (this.gpuPhysics !== gp) return
    }
    this.stopPhysicsNow()
    this.emit('physics', this.physicsState())
  }
  private stopPhysicsNow() {
    if (this.physicsMode === 'worker') void this.worker.call({ op: 'physicsStop' })
    this.gpuPhysics?.destroy()
    this.gpuPhysics = null
    this.physicsMode = null
    this.physicsStopping = false
    this.physicsPending = false
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }
  /** One frame of simulation; true while there is more to do. */
  private physicsTick(): boolean {
    if (this.refreshHeld()) {
      if (this.gpuPhysics) this.gpuPhysics.setHeld(this.heldWords)
      else if (this.physicsMode === 'worker') void this.worker.call({ op: 'physicsHeld', held: this.heldWords.slice() })
    }
    if (this.physicsMode === 'gpu' && this.gpuPhysics) {
      const gp = this.gpuPhysics
      if (gp.cooled) {
        if (!this.physicsCooledSaid) {
          this.physicsCooledSaid = true
          void this.readbackPhysics().then(() => this.emit('physics', this.physicsState()))
        }
        return false
      }
      if (this.physicsStopping) return false
      // Still compiling (physicsKernels): the frame loop keeps asking until they are there.
      if (this.physicsPaused || !gp.ready) return true
      // The calibration (the GPU to itself) sets how many iterations fit the budget; the frame's own timestamps
      // count the draw the pass shares the GPU with, so they are reported, not planned with.
      if (this.physicsCalibrating) return true
      if (!(this.physicsMsPerIteration > 0)) {
        this.physicsCalibrating = true
        void gp.calibrate(4).then((ms) => {
          if (this.gpuPhysics !== gp) return
          this.physicsMsPerIteration = Number.isFinite(ms) && ms > 0 ? ms : 1
          // As many as the budget allows, but no more than a few: a small graph's run is cheap enough to finish in
          // twenty frames, which reads as a jump cut — four a frame is still a second and a half to settle.
          this.physicsPerFrame = Math.max(1, Math.round(this.physicsBudgetMs / this.physicsMsPerIteration))
          this.autoCooling(gp)
        }).finally(() => {
          this.physicsCalibrating = false
          this.requestRender()
        })
        return true
      }
      gp.step(Math.min(this.physicsPerFrame, gp.alpha > PHYSICS_WATCH_ALPHA ? PHYSICS_MAX_PER_FRAME : PHYSICS_MAX_PER_FRAME_COOL))
      this.physicsFrames++
      // The whole CPU copy follows every twelfth frame (the grid, picking, label candidates, positions handed on).
      // Labels are drawn from it and must glide with the dots — a copy every twelfth frame made them hop — so while
      // they are on screen the positions of the ones showing come back every frame on their own: a few kilobytes,
      // where a whole copy was eight megabytes and more at half a million nodes. Edge labels sit between two
      // endpoints the gather does not follow, so with them on the whole copy stays on every frame.
      const labelled = this.labelMode !== 'none' && (this.lod.labels !== 'none' || (this.labelLayer?.drawn ?? 0) > 0)
      if (labelled && this.showEdgeLabels) void this.readbackPhysics()
      else if (this.physicsFrames % 12 === 0) void this.readbackPhysics()
      else if (labelled) void this.gatherLabelPositions()
      return true
    }
    if (this.physicsMode === 'worker') {
      if (this.physicsWorkerAlpha < this.physicsParams.alphaMin) {
        if (!this.physicsCooledSaid) {
          this.physicsCooledSaid = true
          this.emit('physics', this.physicsState())
        }
        return false
      }
      this.pumpWorkerPhysics()
      return true
    }
    return false
  }
  /**
   * The worker steps on its own clock: each batch is asked for as soon as the last lands, whatever the frame
   * rate (a slow draw must not throttle the simulation), and the frame shows whatever positions are newest.
   */
  private pumpWorkerPhysics() {
    if (this.physicsWorkerBusy || this.physicsMode !== 'worker' || this.physicsWorkerAlpha < this.physicsParams.alphaMin) return
    this.physicsWorkerBusy = true
    const run = this.physicsRun
    void this.worker
      .call<{ positions: Float32Array; alpha: number; iterations: number }>({ op: 'physicsStep', iterations: 2, alpha: this.physicsWorkerAlpha })
      .then((r) => {
        // A batch of a run since stopped (or started again over a new picture) is that run's: its positions and its
        // temperature would overwrite the new run's.
        if (this.physicsMode !== 'worker' || run !== this.physicsRun) return
        this.physicsWorkerAlpha = r.alpha
        this.physicsWorkerIterations += r.iterations
        this.setAllPositionsExceptHeld(r.positions)
        this.requestRender()
      })
      .catch(() => {})
      .finally(() => {
        if (run !== this.physicsRun) return
        this.physicsWorkerBusy = false
        this.pumpWorkerPhysics()
      })
  }
  /** The GPU's positions into the engine's arrays — the held nodes keep the engine's (a drag is newer). */
  /** Copies in flight (at most two: the staging buffers). */
  private physicsReads = 0
  private physicsLastRead: Promise<void> | null = null
  private readScratch = new Float32Array(0)
  private readbackPhysics(): Promise<void> {
    const gp = this.gpuPhysics
    if (!gp || this.physicsReads >= 2) return this.physicsLastRead ?? Promise.resolve()
    const run = async () => {
      const N = this.graph.nodeCount
      if (this.readScratch.length < N * 4) this.readScratch = new Float32Array(this.nodeCapacity * 4)
      const tmp = this.readScratch
      let ok = false
      try {
        ok = await gp.readback(tmp)
      } catch {
        // The simulation was destroyed under the copy (a stop, a reload): nothing to take.
        return
      }
      if (!ok || this.gpuPhysics !== gp) return
      // One copy, then the held nodes (pinned, dragged — the engine's is newer) put back: a bitset walk, not a
      // test per node.
      const held = this.heldWords
      const posr = this.posr
      const words = Math.min(held.length, (N + 31) >> 5)
      let saved = this.heldScratch
      let ns = 0
      for (let w = 0; w < words; w++) {
        let v = held[w]
        while (v) {
          const t = v & -v
          const i = (w << 5) + (31 - Math.clz32(t))
          v ^= t
          if (ns + 4 > saved.length) {
            const bigger = new Float32Array(Math.max(64, saved.length * 2))
            bigger.set(saved)
            this.heldScratch = saved = bigger
          }
          saved[ns++] = i
          saved[ns++] = posr[i * 4]
          saved[ns++] = posr[i * 4 + 1]
          saved[ns++] = posr[i * 4 + 2]
        }
      }
      posr.set(tmp.subarray(0, N * 4))
      for (let k = 0; k < ns; k += 4) {
        const i = saved[k]
        posr[i * 4] = saved[k + 1]
        posr[i * 4 + 1] = saved[k + 2]
        posr[i * 4 + 2] = saved[k + 3]
      }
      // Already on the GPU: no upload. The grid and labels follow.
      this.gridStale = true
      this.labelsDirty = true
      this.requestRender()
    }
    this.physicsReads++
    const p = run().finally(() => this.physicsReads--)
    this.physicsLastRead = p
    return p
  }
  private heldScratch = new Float32Array(64)
  /** The positions of the labels showing, from the GPU (see `physicsTick`). */
  private gatherLabelPositions() {
    const gp = this.gpuPhysics
    const shown = this.labelLayer?.showing()
    if (!gp || !shown || !shown.length) return
    const held = this.heldWords
    void gp
      .gather(shown, this.posr, (i) => (held[i >> 5] & (1 << (i & 31))) !== 0)
      .then((ok) => {
        if (!ok || this.gpuPhysics !== gp) return
        this.labelsDirty = true
        this.requestRender()
      })
      .catch(() => {})
  }
  private setAllPositionsExceptHeld(xyz: Float32Array) {
    const N = Math.min(this.graph.nodeCount, Math.floor(xyz.length / 3))
    const held = this.heldWords
    for (let i = 0; i < N; i++) {
      if (held[i >> 5] & (1 << (i & 31))) continue
      this.posr[i * 4] = xyz[i * 3]
      this.posr[i * 4 + 1] = xyz[i * 3 + 1]
      this.posr[i * 4 + 2] = xyz[i * 3 + 2]
    }
    markAll(this.dirtyPos, N)
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
  }

  // ── Worker-backed operations ──
  private edgesCopy() {
    const E = this.graph.edgeCount
    return { edgeSource: this.graph.edgeSource.slice(0, E), edgeTarget: this.graph.edgeTarget.slice(0, E), alive: this.graph.nodeAlive.words.slice() }
  }
  /** Lay the visible graph out in the worker (in the engine's dimensions); positions land when it is done. */
  async layout(algorithm: 'coarse' | 'grid' | 'random' | 'circle', opts: { spacing?: number; seed?: number } = {}): Promise<{ ms: number; communities?: number }> {
    const N = this.graph.nodeCount
    const positions = this.positionsXYZ()
    const pinned = this.pinned.isEmpty() ? undefined : this.pinned.toArray()
    const r = await this.worker.call<{ positions: Float32Array; count?: number }>({ op: 'layout', algorithm, dims: this.dims, nodeCount: N, nodeType: this.graph.nodeType.slice(0, N), ...this.edgesCopy(), positions, pinned, spacing: opts.spacing, seed: opts.seed }, [positions.buffer])
    this.setAllPositions(r.positions)
    return { ms: r.ms, communities: r.count }
  }
  /** Relax a subset (the selection by default) with local forces in the worker. */
  async relax(subset?: Uint32Array, opts: { iterations?: number; spacing?: number } = {}): Promise<{ ms: number; nodes: number }> {
    const sub = subset ?? this.selected.toArray()
    if (sub.length < 2) return { ms: 0, nodes: sub.length }
    const positions = this.positionsXYZ()
    const pinned = this.pinned.isEmpty() ? undefined : this.pinned.toArray()
    const r = await this.worker.call<{ positions: Float32Array; subset: Uint32Array }>({ op: 'localForce', dims: this.dims, nodeCount: this.graph.nodeCount, ...this.edgesCopy(), positions, subset: sub, pinned, iterations: opts.iterations, spacing: opts.spacing }, [positions.buffer, sub.buffer])
    for (let k = 0; k < r.subset.length; k++) {
      const i = r.subset[k]
      this.posr[i * 4] = r.positions[i * 3]
      this.posr[i * 4 + 1] = r.positions[i * 3 + 1]
      this.posr[i * 4 + 2] = r.positions[i * 3 + 2]
      mark(this.dirtyPos, i)
    }
    this.gridStale = true
    this.labelsDirty = true
    this.requestRender()
    return { ms: r.ms, nodes: r.subset.length }
  }
}

/** Something over the picture that takes its own clicks (see `GraphEngine.overlays`); x, y in view px. */
export interface EngineOverlay {
  hit(x: number, y: number): boolean
  click(x: number, y: number, keys: { shift: boolean; meta: boolean }): void
  double?(x: number, y: number): void
  /** Paint itself into a snapshot of the view: `ctx` is in the canvas's device px (`dpr` per CSS px), the picture already drawn. */
  draw?(ctx: CanvasRenderingContext2D, dpr: number): void
}

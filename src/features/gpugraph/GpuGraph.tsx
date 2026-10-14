import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { EntityId } from '../../core/entity/types'
import { bigViewLayout, DEFAULT_UNIGRAPH_FORCE, type LayoutAlgorithm, type LayoutParams, type Positions } from '../../core/graph/layouts'
import { BitSet } from '../../core/packed/bitset'
import { onThemeChange } from '../../app/theme'
import { cameraSaver, loadCamera } from '../graph/cameraMemory'
import { getCameraControls, useCameraControls } from '../graph/cameraControls'
import { useExplorer } from '../graph/explorerState'
import { saveHeldPositionsPacked } from '../graph/heldPositions'
import { PHYSICS_TAG } from '../graph/positionStore'
import { sameExtent, useInitialCamera, type CameraState, type CameraTarget, type GraphViewHandle, type GraphViewProps, type Viewport } from '../graph/view'
import { GraphMenu, type GraphMenuTarget } from '../graph/GraphMenu'
import { PlacementOverlay, type OverlayCamera } from '../graph/PlacementOverlay'
import type { SlidesView } from '../../core/graph/scene'
import { Slides } from './Slides'
import { useViewActive } from '../workstation/paneContext'
import { runBenchmark, loadPreset, type BenchResult } from './bench'
import { compileSlice, indicesOf, syncPositions } from './compile'
import { GraphEngine, type FrameStats, type PhysicsState } from './engine/engine'
import { Interaction } from './engine/interaction'
import { BENCH_PRESETS } from '../../core/packed/generate'
import { previewDataUrl, PREVIEW_HEIGHT, PREVIEW_WIDTH } from '../graph/snapshot'
import { registerGpuGraph, type GpuGraphHandle } from './gpuGraphHandle'
import { GpuHud } from './GpuHud'
import { engineColors } from './engineTheme'
import './GpuGraph.css'
import { measure } from '../../lib/measure'

/**
 * The GPU renderer of the explorer: the same slice, positions, styles and
 * selection as the sigma and force-graph views, drawn by `GraphEngine` in
 * two dimensions (`/unigraph/2d`) or three (`/unigraph/3d`). Beside the
 * explorer's picture it can show a generated benchmark graph, which never
 * touches the entity system.
 */
export type GpuSource = 'explorer' | 'benchmark'

/** Past this many nodes waiting for a force layout, the GPU view switches the explorer to a layout made for the size. */
const SWITCH_LAYOUT_FROM = 2_000
/** Nodes waiting past which Force (Unigraph) on the CPU (no WebGPU) gives way to Multilevel for a view with nothing held. */
const SWITCH_CPU_FORCE_FROM = 50_000

export const GpuGraph = forwardRef<GraphViewHandle, GraphViewProps & { dims: 2 | 3 }>(function GpuGraph({ initialViewport, initialCamera, dims }, ref) {
  const handoff = useRef(initialViewport)
  const takeInitialCamera = useInitialCamera(initialCamera)
  const { state, dispatch, slice, positionsFor, positionsStorageKey, styles, selectedSet, pinnedSet, computePath, sliceKey, runLayout, nativeLayout } = useExplorer()
  // Orbit or fly: the mouse follows the switch at once (the keys read it themselves, `useCameraKeys`).
  const controls = useCameraControls()
  useEffect(() => {
    if (engineRef.current) engineRef.current.controls = controls
  }, [controls])
  const viewActive = useViewActive()
  // The same, always current: the live simulation's hand-back reads it from inside an interval.
  const viewActiveRef = useRef(viewActive)
  viewActiveRef.current = viewActive
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GraphEngine | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const [menu, setMenu] = useState<GraphMenuTarget | null>(null)
  const [source, setSource] = useState<GpuSource>('explorer')
  const sourceRef = useRef<GpuSource>('explorer')
  sourceRef.current = source
  const [stats, setStats] = useState<FrameStats | null>(null)
  /** The running simulation's hand-back, while one is running: called once when the view goes behind. */
  const handBackRef = useRef<(() => EntityId[]) | null>(null)
  /** The ids and the float buffer a live run's positions are written to storage from; rebuilt when the graph changes. */
  const packRef = useRef<{ ids: string[]; xyz: Float32Array; at: number } | null>(null)
  /** Where a running simulation last read the held positions: what moved since is somebody else's and the engine follows it. */
  const runFrom = useRef(0)
  /** Whether the ids beside the numbers in storage are this graph's (see `saveHeldPositionsPacked`). */
  const wroteIds = useRef(false)
  const [physics, setPhysics] = useState<PhysicsState | null>(null)
  const [backend, setBackend] = useState<string>('')
  // The placement overlay (a region, heatmap cells, axis ticks in graph coordinates) follows the flat camera; it is
  // a 2D picture, so the orbit camera does not carry it.
  const [overlayCamera, setOverlayCamera] = useState<OverlayCamera | null>(null)
  // The engine once it is attached, for the slide layer (which follows its frames); the ref stays the source of truth.
  const [attached, setAttached] = useState<GraphEngine | null>(null)
  /** Turns the camera to a slide; set by the slide layer while it is mounted. */
  const faceSlide = useRef<((id: EntityId, ms?: number) => boolean) | null>(null)
  const [error, setError] = useState<string>('')
  const [bench, setBench] = useState<{ running: string; result?: BenchResult; loaded?: string }>({ running: '' })
  const live = useRef({ state, slice, computePath })
  live.current = { state, slice, computePath }
  const viewKey = `${sliceKey}|${state.algorithm}|${state.layoutId ?? ''}`
  const viewKeyRef = useRef(viewKey)
  viewKeyRef.current = viewKey
  /** The view without its slice: a filter changes the slice, not the view — the camera stays (see `restoreCamera`). */
  const frameKey = `${state.algorithm}|${state.layoutId ?? ''}`
  const frameKeyRef = useRef(frameKey)
  frameKeyRef.current = frameKey
  const framedFor = useRef('')
  const restoredFor = useRef('')
  // The canvas is hidden until the first picture has its camera (see restoreCamera).
  const [revealed, setRevealed] = useState(false)
  const revealedRef = useRef(false)

  // ── Engine (once) ──
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const engine = new GraphEngine()
    engine.controls = getCameraControls()
    engine.dims = dims
    engineRef.current = engine
    // A new engine starts from nothing: its first picture gets its camera and is shown when it is drawn — even when
    // this is React's development re-run of the effect, whose first engine was destroyed before it drew a frame.
    restoredFor.current = ''
    framedFor.current = ''
    revealedRef.current = false
    engine.setColors(engineColors(host))
    const params = new URLSearchParams(location.search)
    const want = params.get('gpu')
    engine.attach(host, { backend: want === 'webgl2' || want === 'webgpu' ? want : 'auto' })
    const interaction = new Interaction(engine, host)
    interactionRef.current = interaction
    interaction.tool = live.current.state.tool
    const saver = cameraSaver('gpu', () => ({ key: `${viewKeyRef.current}|${engine.dims}`, camera: cameraState(engine, engine.viewport()) }))
    const offs = [
      // A theme change redraws the ground, the rings and the labels in its colours: one frame, no buffer.
      onThemeChange(() => engine.setColors(engineColors(host))),
      engine.on('ready', (b) => {
        setBackend(b)
        setAttached(engine)
        setOverlayCamera({
          toViewport: (x, y) => ({ x: engine.camera.screenX(x), y: engine.camera.screenY(y) }),
          onChange: (cb) => engine.on('camera', cb),
        })
      }),
      engine.on('error', (m) => setError(m)),
      engine.on('frame', (s) => {
        // The HUD reads the stats at most ~4 times a second: the engine never waits for React.
        if (s.frames % 15 === 0) {
          setStats({ ...s })
          if (engine.physicsState().on) setPhysics(engine.physicsState())
        }
      }),
      engine.on('physics', (st) => setPhysics(st)),
      engine.on('camera', () => saver.bump()),
      engine.on('resize', () => restoreRef.current()),
      engine.on('select', ({ source }) => {
        if (sourceRef.current !== 'explorer') return
        // The explorer's own state written back into the engine (syncUi) comes round as an 'api' select: reporting
        // it would dispatch the empty node selection that goes with a selected edge, and the reducer would then
        // drop the edge. Only what the user did on the canvas is reported.
        if (source === 'api') return
        const ids: EntityId[] = []
        engine.selected.forEach((i) => {
          const id = engine.nodeId(i)
          if (id !== undefined) ids.push(id)
        })
        dispatch({ type: 'select', ids, mode: 'replace' })
        const st = live.current.state
        if (st.path) dispatch({ type: 'setPath', path: undefined })
        if (st.pathFrom) dispatch({ type: 'setPathFrom', id: undefined })
        if (engine.selectedEdge < 0 && st.selectedEdgeId) dispatch({ type: 'selectEdge', id: undefined })
      }),
      engine.on('edgeSelect', (e) => {
        if (sourceRef.current !== 'explorer') return
        dispatch({ type: 'selectEdge', id: e >= 0 ? engine.edgeId(e) : undefined })
      }),
      engine.on('hover', (i) => {
        if (sourceRef.current !== 'explorer') return
        dispatch({ type: 'hover', id: i >= 0 ? engine.nodeId(i) : undefined })
      }),
      engine.on('dragEnd', (nodes) => {
        if (sourceRef.current !== 'explorer') return
        const out: Positions = {}
        for (let k = 0; k < nodes.length; k++) {
          const id = engine.nodeId(nodes[k])
          if (id !== undefined) out[id] = posOf(engine, nodes[k])
        }
        dispatch({ type: 'moveNodes', positions: out, dims: engine.dims })
        // While the simulation runs, a node put somewhere by hand stays there: it is pinned (unpin to release it),
        // else the springs would pull it back to where it was the moment the next drag reheats the run.
        if (engine.physicsState().on) dispatch({ type: 'pin', ids: Object.keys(out), on: true })
      }),
      engine.on('nodeClick', ({ node }) => {
        const id = engine.nodeId(node)
        if (id === undefined || sourceRef.current !== 'explorer') return
        const st = live.current.state
        if (st.pathFrom && st.pathFrom !== id) live.current.computePath(st.pathFrom, id)
        else dispatch({ type: 'setPathFrom', id })
      }),
      engine.on('contextmenu', ({ x, y, node, edge }) => {
        if (sourceRef.current !== 'explorer') return
        setMenu({ x, y, node: node >= 0 ? engine.nodeId(node) : undefined, edge: edge >= 0 ? engine.edgeId(edge) : undefined })
      }),
    ]
    const handle: GpuGraphHandle = {
      engine,
      getSource: () => sourceRef.current,
      loadBenchmark: async (preset) => {
        const name = typeof preset === 'string' ? preset : `${preset.nodes}/${preset.edges}`
        setBench((b) => ({ ...b, running: `Loading ${name}…` }))
        try {
          sourceRef.current = 'benchmark'
          setSource('benchmark')
          const r = await loadPreset(engine, preset)
          handle.lastGenerated = r.graph
          setBench((b) => ({ ...b, running: '', loaded: name }))
          return { generateMs: r.generateMs, loadMs: r.loadMs, firstFrameMs: r.firstFrameMs }
        } catch (err) {
          setBench((b) => ({ ...b, running: '' }))
          throw err
        }
      },
      runBenchmark: async (preset) => {
        sourceRef.current = 'benchmark'
        setSource('benchmark')
        const result = await runBenchmark(engine, preset, (s) => setBench((b) => ({ ...b, running: s ? `Benchmark: ${s}…` : '' })))
        handle.lastBenchmark = result
        setBench({ running: '', result, loaded: result.preset })
        return result
      },
      showExplorer: () => {
        sourceRef.current = 'explorer'
        setSource('explorer')
        setBench({ running: '' })
        engine.clear()
        restoredFor.current = ''
    framedFor.current = ''
        rebuild.current?.()
      },
      snapshot: async () => {
        // The engine's own frame — the canvas and the label layer over it, the same camera, projection and colours —
        // scaled to the card. Taken here, not drawn from the layout's numbers, so the card is the picture the scene opens as.
        const blob = await engine.snapshot({ maxWidth: PREVIEW_WIDTH * 2, format: 'jpeg' })
        return blob ? previewDataUrl(blob, PREVIEW_WIDTH, PREVIEW_HEIGHT) : null
      },
    }
    const unregister = registerGpuGraph(handle)
    return () => {
      // The view is going (let go behind another page or tab): what a running simulation reached since its last write
      // is written now, from the engine's arrays, before they go with it.
      finalKeep.current?.()
      unregister()
      offs.forEach((off) => off())
      saver.flush()
      interaction.destroy()
      engine.destroy()
      engineRef.current = null
      setAttached(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Behind another page or tab: no frames, no physics steps, until it is in front again. A live simulation hands
  // the positions it reached over once on the way behind — after that nothing is moving, so there is nothing to
  // hand back until the view is in front again (on a graph of hundreds of thousands of nodes a hand-back is a
  // walk of every node, a store write and a re-render: a second of work every couple of seconds, spent for
  // nothing, in a page the person has left).
  useEffect(() => {
    engineRef.current?.setPaused(!viewActive)
    if (!viewActive) handBackRef.current?.()
  }, [viewActive])

  // 2D ↔ 3D on the same engine: the picture stays, the camera changes.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || engine.dims === dims) return
    engine.setDims(dims)
    restoredFor.current = ''
    framedFor.current = ''
    rebuild.current?.()
  }, [dims])

  // ── The slice → the engine ──
  const rebuild = useRef<() => void>(null)
  // The engine's resize listener (registered once) reaches the current restore through this ref.
  const restoreRef = useRef<() => void>(() => {})
  rebuild.current = () => {
    const engine = engineRef.current
    if (!engine || sourceRef.current !== 'explorer') return
    const { positions } = positionsFor(dims)
    // A running simulation owns the positions of the nodes it already holds: a write to the project must not put the
    // picture back to wherever the run was last read from. What has just arrived is placed as usual.
    compileSlice(engine, slice, styles, positions, { showEdges: state.showEdges, curvedEdges: state.rendering.curvedEdges, pinned: pinnedSet, keepPositions: engine.physicsState().on })
    packRef.current = null
    wroteIds.current = false
    // A running simulation holds the old graph's adjacency: it starts over on the new one.
    if (engine.physicsState().on) engine.startPhysics(live.current.state.physics ? liveForceParams(live.current.state.params, engine.dims) : forceParams(live.current.state.params, engine.dims))
    syncUi()
    restoreCamera()
  }
  /**
   * The first camera of a picture: the fit, and over it a remembered camera (or a scene's) that still frames it.
   * Needs the picture's extent and a measured canvas — on arrival the container may not be laid out yet, and the
   * positions may still be on their way — so it is tried from the rebuild, from the positions effect and at every
   * resize until it can be done, and the canvas is shown only once it has been: no frame is drawn framed one way and
   * then jumped to another. The fit anchors node sizes and the LOD; a remembered camera is put back over it — only
   * one that still frames this picture: the same extent in 2D, and in 3D a distance within reason of the fit's and a
   * target inside the picture. A camera remembered for a different picture (a pick of one entity out of a scene, a
   * layout that moved everything) would leave the view far out or off to one side.
   */
  // Whether the camera is where this component last put it. `markCamera` records a programmatic move; anything else
  // — a drag, a wheel, graph_viewport — leaves the camera somewhere else, and that is the user's business.
  const placedCamera = useRef<string | null>(null)
  const cameraKey = (e: GraphEngine) => (e.dims === 3 ? `3:${e.camera3.distance.toFixed(1)}:${e.camera3.tx.toFixed(1)}:${e.camera3.ty.toFixed(1)}:${e.camera3.tz.toFixed(1)}` : `2:${e.camera.x.toFixed(1)}:${e.camera.y.toFixed(1)}:${e.camera.scale.toFixed(4)}`)
  const markCamera = (e: GraphEngine) => {
    // After the flight, not before it: the camera is animated, so the key it settles at is the one to remember.
    window.setTimeout(() => {
      if (engineRef.current === e) placedCamera.current = cameraKey(e)
    }, 400)
  }
  const cameraMoved = { get current() { const e = engineRef.current; return !!e && placedCamera.current !== null && cameraKey(e) !== placedCamera.current } }

  const restoreCamera = () => {
    const engine = engineRef.current
    if (!engine || sourceRef.current !== 'explorer') return
    const key = `${viewKeyRef.current}|${engine.dims}`
    if (restoredFor.current === key) return
    if (engine.camera.width <= 1 || engine.camera.height <= 1) return
    const now = engine.extent()
    // Nodes on their way (a layout pending, positions restoring): the picture is not this one yet.
    if (!now && engine.graph.nodeCount > 0) return
    restoredFor.current = key
    // The same view with another slice — a filter narrowed or widened, a type ticked off — keeps the camera the user
    // has: framing it again threw them back out to the whole picture at every change. Only when nothing of the new
    // picture would be on screen (a filter down to things elsewhere) is it framed, so the view is never left empty.
    const frame = `${frameKeyRef.current}|${engine.dims}`
    // Framed means a picture was: an empty one (the moment before the nodes arrive) frames nothing.
    if (now && framedFor.current === frame && engine.anyInView()) {
      handoff.current = undefined
      if (!revealedRef.current) {
        revealedRef.current = true
        setRevealed(true)
      }
      return
    }
    const from = handoff.current
    handoff.current = undefined
    const saved = loadCamera('gpu', key)
    const dims = engine.dims
    if (now) {
      engine.fit({ padding: 0.08 })
      // A scene being loaded names its camera: that one, over the fit, before anything is drawn.
      const scene = takeInitialCamera()
      if (scene?.kind === '3d' && dims === 3) engine.camera3.animateTo({ tx: scene.lookAt.x, ty: scene.lookAt.y, tz: scene.lookAt.z, ...orbitFrom(scene.position, scene.lookAt), canonical: true }, 0)
      else if (scene?.kind === '2d' && dims === 2) engine.camera.animateTo(scene.center.x, scene.center.y, engine.camera.fitScale / scene.ratio, 0)
      else if (dims === 3) {
        // What the fit framed is the picture: with slides hung over the graph that is their box too, so a camera
        // remembered facing a slide high above the nodes, or close in on one, still frames it.
        const extra = engine.fitExtra?.()
        const box = extra ? { ...now, minX: Math.min(now.minX, extra.box.minX), minY: Math.min(now.minY, extra.box.minY), minZ: Math.min(now.minZ, extra.box.minZ), maxX: Math.max(now.maxX, extra.box.maxX), maxY: Math.max(now.maxY, extra.box.maxY), maxZ: Math.max(now.maxZ, extra.box.maxZ) } : now
        if (saved?.kind === '3d' && camera3Frames(saved, box, engine.camera3.distance, extra ? 0.06 : 0.25)) engine.camera3.animateTo({ tx: saved.lookAt.x, ty: saved.lookAt.y, tz: saved.lookAt.z, ...orbitFrom(saved.position, saved.lookAt), canonical: true }, 0)
      } else if (from && viewportFrames(from, now)) engine.camera.fitBox(from.minX, from.minY, from.maxX, from.maxY, { padding: 0 })
      else if (saved?.kind === '2d' && saved.viewport && saved.extent && sameExtent(saved.extent, now)) engine.camera.fitBox(saved.viewport.minX, saved.viewport.minY, saved.viewport.maxX, saved.viewport.maxY, { padding: 0 })
      engine.cameraChanged()
      markCamera(engine)
      framedFor.current = frame
    }
    // Shown after the next frame is drawn with this camera — the paint that follows shows that frame.
    if (!revealedRef.current) {
      revealedRef.current = true
      const off = engine.on('frame', () => {
        off()
        setRevealed(true)
      })
      engine.requestRender()
    }
  }
  restoreRef.current = restoreCamera
  useEffect(() => {
    rebuild.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, styles, state.showEdges, state.rendering.curvedEdges])

  // ── Positions ──
  /** The last write of a running simulation's positions, for the view's unmount (set while one runs). */
  const finalKeep = useRef<(() => void) | null>(null)
  const wasPending = useRef(false)
  // A big picture whose nodes wait for a force layout would wait minutes (ForceAtlas2 over tens of thousands of nodes
  // in the explorer's worker). This renderer is for such sizes, so it switches the explorer's algorithm to the one
  // made for them (`bigViewLayout`: Force (Unigraph) on WebGPU, Multilevel without) and runs it — held and saveable
  // like any other; the choice shows in the Layout tab, where any other algorithm can be picked afterwards. It waits
  // for the backend to be known: the engine attaches asynchronously, and the positions can land first.
  const switchTo = useRef<LayoutAlgorithm | null>(null)
  const waitingFor = useRef(0)
  const lastSynced = useRef<Positions | null>(null)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || sourceRef.current !== 'explorer') return
    const { positions, pending } = positionsFor(dims)
    // While the simulation runs the engine's positions are the newest: syncing the held ones over them would snap
    // the whole picture back at every drop. The run hands its positions back when it settles or stops. What somebody
    // else moved while it ran — a drag, a placement, a tool setting positions — is newer still, and only that goes in.
    // The same positions object as last time — the cache rebuilt around it, the simulation switched on or off with
    // nothing moved — is already the engine's: comparing a million again was a quarter of a second at the switch.
    if (!engine.physicsState().on) {
      if (positions !== lastSynced.current) syncPositions(engine, positions)
      lastSynced.current = positions
    } else {
      const held = live.current.state.positions
      const theirs = held.movedSince(runFrom.current, { ignore: PHYSICS_TAG })
      if (theirs?.length) {
        const patch: Positions = {}
        for (const id of theirs) {
          const p = held.get(id)
          if (p) patch[id] = p
        }
        syncPositions(engine, patch)
        runFrom.current = held.version
      }
    }
    restoreCamera()
    const landed = wasPending.current && !pending
    wasPending.current = !!pending
    // A layout landing frames the picture — but only while the camera is still the one the view arrived with. Once
    // it has been moved, by hand or by a tool, a second layout must not throw the user back out to the whole graph:
    // several tool calls in a row were re-fitting between each of them.
    if (landed && !cameraMoved.current) {
      engine.fit({ padding: 0.08, ms: 300 })
      markCamera(engine)
    }
    // `pending` means the seed cloud is showing: every node without a held position is waiting for the worker.
    waitingFor.current = pending ? slice.nodes.length - live.current.state.positions.size : 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsFor])
  useEffect(() => {
    if (!backend || sourceRef.current !== 'explorer') return
    const st = live.current.state
    // A big view with nothing held gets the big-view layout: Force (Unigraph) on WebGPU, Multilevel without it — from
    // ForceAtlas2 past a few thousand nodes, and from Force (Unigraph) itself on WebGL2 past tens of thousands, where
    // its CPU run is cut to a few dozen iterations and Multilevel draws a better picture in less time.
    const big = bigViewLayout(backend === 'webgpu')
    const from = st.algorithm === 'force' ? SWITCH_LAYOUT_FROM : st.algorithm === 'unigraph-force' ? SWITCH_CPU_FORCE_FROM : Infinity
    if (waitingFor.current > from && st.algorithm !== big && st.restoring === undefined && !switchTo.current) {
      switchTo.current = big
      dispatch({ type: 'setAlgorithm', algorithm: switchTo.current })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsFor, backend])
  useEffect(() => {
    if (switchTo.current && state.algorithm === switchTo.current) {
      switchTo.current = null
      void runLayout(dims)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.algorithm])

  // ── Selection, pins, path → flags ──
  const syncUi = () => {
    const engine = engineRef.current
    if (!engine || sourceRef.current !== 'explorer') return
    const st = live.current.state
    engine.setHighlightHops(st.hops)
    engine.setSelectionBits(bitsOf(engine, selectedSet))
    engine.setPinned(indicesOf(engine, pinnedSet))
    engine.setSelectedEdge(st.selectedEdgeId ? engine.edgeIndex(st.selectedEdgeId) : -1)
    if (st.path) engine.setPath(indicesOf(engine, st.path.nodes), Array.from(st.path.edges, (id) => engine.edgeIndex(id)))
    else engine.setPath([], [])
  }
  useEffect(() => {
    syncUi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSet, pinnedSet, state.path, state.selectedEdgeId, state.hops])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.labelMode = state.labels
    engine.showEdgeLabels = state.rendering.edgeLabels
    engine.commit()
  }, [state.labels, state.rendering.edgeLabels])
  useEffect(() => {
    if (interactionRef.current) interactionRef.current.tool = state.tool
    if (hostRef.current) hostRef.current.style.cursor = state.tool === 'path' ? 'crosshair' : ''
  }, [state.tool])

  // Physics: the live simulation over the whole picture — on the GPU when the backend is WebGPU (positions step in
  // place, a few dispatches per frame, a million nodes), else in the worker. The explorer holds the positions it
  // reaches: when the run settles and when it is switched off, so they are saveable and the other renderers agree.
  // What the explorer set while the run was on is newer than the simulation and stays: a placement ("every tree
  // where it stands"), a transform, a loaded layout, a dragged node — each replaces the position objects it moved,
  // so a node whose held position is not the one the run started from keeps it, and the engine is brought to it.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !state.physics || sourceRef.current !== 'explorer') return
    // Where the last hand-back read the held positions. A node the person moved (or a layout placed) since then
    // keeps that position, not the simulation's: the store lists what has changed, minus the simulation's own
    // hand-backs, which are tagged so they are recognised however many versions the dispatches take (a reducer
    // runs twice under StrictMode, and a drag can land between reading and dispatching). When it cannot say, the
    // simulation's positions stand — a node dragged during a run is pinned where it was dropped anyway.
    runFrom.current = live.current.state.positions.version
    // Packed (ids and a column of coordinates), so a million nodes are handed over without a million-key object.
    // Returns the nodes the explorer holds over the run's.
    const handBack = (): EntityId[] => {
      const t0 = performance.now()
      const held = live.current.state.positions
      const since = held.movedSince(runFrom.current, { ignore: PHYSICS_TAG })
      const theirs = since && since.length ? new Set(since) : undefined
      const g = engine.graph
      const three = engine.dims === 3
      const ids: EntityId[] = []
      const xyz = new Float32Array(g.nodeCount * 3)
      for (let i = 0; i < g.nodeCount; i++) {
        if (!g.nodeAlive.has(i)) continue
        const id = engine.nodeId(i)
        if (id === undefined || theirs?.has(id)) continue
        const k = ids.length * 3
        xyz[k] = engine.x(i)
        xyz[k + 1] = engine.y(i)
        if (three) xyz[k + 2] = engine.z(i)
        ids.push(id)
      }
      runFrom.current = held.version
      dispatch({ type: 'movePacked', ids, xyz, dims: engine.dims, from: PHYSICS_TAG })
      // What the hand-back costs, for the cadence above to be set from measurement rather than taste.
      measure('gx:handback', { start: t0, detail: { nodes: g.nodeCount } })
      return theirs ? [...theirs] : []
    }
    // Switched on over a finished picture (`physicsWarm`), the run starts cool: it settles what is there instead of
    // flinging it apart at full heat and re-forming it, which is what a first visit used to see.
    const mode = engine.startPhysics({ ...liveForceParams(live.current.state.params, engine.dims), ...(live.current.state.physicsWarm ? { alpha: WARM_ALPHA } : {}) })
    if (!mode) {
      dispatch({ type: 'setPhysics', on: false })
      return
    }
    // Settled: the positions it came to rest on are held and written, once — nothing moves until it is warmed again.
    const off = engine.on('physics', (st) => {
      if (st.on && st.cooled) {
        handBack()
        keep()
      }
    })
    // While it moves it has to be saveable and survive a reload, so what it reached is written every few seconds.
    handBackRef.current = handBack
    // What the run reaches is written to storage straight from the engine's arrays — the ids once, then a fill of a
    // float per coordinate — so a picture of a million nodes is saved while it moves for about the cost of a frame.
    // The session's own positions are not touched while it runs: the picture, a save, an export and a tool read all
    // take them from the engine, and a hand-back at the boundaries (behind, stopped, asked for) keeps them true.
    const keep = () => {
      const t0 = performance.now()
      const g = engine.graph
      let pack = packRef.current
      const sameIds = !!pack && pack.at === g.nodeCount
      if (!pack || pack.at !== g.nodeCount) {
        const ids: string[] = []
        for (let i = 0; i < g.nodeCount; i++) {
          if (!g.nodeAlive.has(i)) continue
          const id = engine.nodeId(i)
          if (id !== undefined) ids.push(id)
        }
        pack = packRef.current = { ids, xyz: new Float32Array(ids.length * 3), at: g.nodeCount }
      }
      const { ids, xyz } = pack
      let k = 0
      for (let i = 0; i < g.nodeCount && k < ids.length; i++) {
        if (!g.nodeAlive.has(i)) continue
        xyz[k * 3] = engine.x(i)
        xyz[k * 3 + 1] = engine.y(i)
        xyz[k * 3 + 2] = engine.dims === 3 ? engine.z(i) : 0
        k++
      }
      void saveHeldPositionsPacked(positionsStorageKey, { ids, xyz, dims: engine.dims, count: ids.length }, sameIds && wroteIds.current).catch(() => undefined)
      wroteIds.current = true
      measure('gx:keeppositions', { start: t0, detail: { nodes: ids.length } })
      return performance.now() - t0
    }
    finalKeep.current = () => {
      if (engine.physicsState().on) keep()
    }
    // Paced by what it costs, so it never has more than KEEP_SHARE of the main thread: a second apart on anything
    // ordinary, further on a graph of a million or a machine that needs it.
    let beat = 0
    const tick = () => {
      let next = KEEP_MAX_MS
      // Behind: the engine is paused, and what it reached was handed over and written on the way there.
      if (viewActiveRef.current && engine.physicsState().on && !engine.physicsState().cooled) next = Math.min(KEEP_MAX_MS, Math.max(KEEP_MIN_MS, keep() / KEEP_SHARE))
      beat = window.setTimeout(tick, next)
    }
    beat = window.setTimeout(tick, KEEP_MIN_MS)
    return () => {
      off()
      clearTimeout(beat)
      finalKeep.current = null
      handBackRef.current = null
      // Stopped: the positions the explorer kept over the run's are pushed into the engine, so the picture is theirs.
      void engine.stopPhysics().then(() => {
        const theirs = handBack()
        if (!theirs.length) return
        const held = live.current.state.positions
        const push: Positions = {}
        for (const id of theirs) {
          const p = held.get(id)
          if (p) push[id] = p
        }
        syncPositions(engine, push)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.physics])

  // The Layout tab's Force (Unigraph) knobs reach a running simulation at once — a picture tuned by eye.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !engine.physicsState().on) return
    engine.setPhysicsParams(state.physics ? liveForceParams(state.params, engine.dims) : forceParams(state.params, engine.dims))
  }, [state.params.unigraph])

  /**
   * The Physics switch and a Force (Unigraph) *Run* are the same simulation on the same engine: the switch leaves it
   * on (it cools and rests, and a drag or a change warms it again), a Run borrows it for a cooling run it can hand a
   * layout back from, and stops it at the end. So a Run must give it back — otherwise the switch was left reading on
   * over a simulation that had been stopped under it, and a drag no longer warmed anything. It comes back already at
   * rest (`alpha` 0): the Run has just settled the picture, and a fresh start would shake it all over again.
   */
  const resumeLivePhysics = useCallback(() => {
    const engine = engineRef.current
    if (!engine || !live.current.state.physics || engine.physicsState().on) return
    engine.startPhysics({ ...liveForceParams(live.current.state.params, engine.dims), alpha: 0 })
  }, [])

  // Force (Unigraph) as a layout run: Run in the Layout tab (or graph_layout) steps the simulation here, on the GPU
  // when there is one, from the picture as it stands — or from a multilevel seed when nodes have no position — until
  // it cools or the iterations are spent; the explorer then holds the settled positions like any other layout.
  useEffect(() => {
    nativeLayout.current = {
      handles: (algorithm) => algorithm === 'unigraph-force',
      run: async (_algorithm, params, previous, signal) => {
        const engine = engineRef.current
        if (!engine || sourceRef.current !== 'explorer') throw new Error('The GPU view is not showing the explorer’s picture.')
        const placed = previous ? Object.keys(previous).length : 0
        if (placed < engine.graph.aliveNodes()) await engine.layout('coarse', { seed: params.seed })
        if (signal.aborted) throw Object.assign(new Error('Layout cancelled.'), { name: 'AbortError' })
        const mode = engine.startPhysics(forceParams(params, engine.dims))
        if (!mode) throw new Error('No simulation backend: neither WebGPU nor a worker is available.')
        const cap = Math.max(50, params.iterations)
        return new Promise<Positions>((resolve, reject) => {
          let done = false
          const collect = () => {
            const out: Positions = {}
            const g = engine.graph
            for (let i = 0; i < g.nodeCount; i++) {
              if (!g.nodeAlive.has(i)) continue
              const id = engine.nodeId(i)
              if (id !== undefined) out[id] = posOf(engine, i)
            }
            return out
          }
          const off = engine.on('physics', (st) => {
            if (done) return
            // Stopped under the run — the Physics switch, a tool, a reload: the positions it reached (read back before
            // the stop is announced) are the layout. A run that waited for a cooling that could no longer come held
            // the explorer's "laying out" state open for good.
            if (!st.on) {
              done = true
              off()
              signal.removeEventListener('abort', onAbort)
              resolve(collect())
              resumeLivePhysics()
              return
            }
            if (!(st.cooled || st.iterations >= cap)) return
            done = true
            off()
            signal.removeEventListener('abort', onAbort)
            void engine.stopPhysics().then(() => {
              resolve(collect())
              resumeLivePhysics()
            })
          })
          const onAbort = () => {
            if (done) return
            done = true
            off()
            void engine.stopPhysics().then(resumeLivePhysics)
            reject(Object.assign(new Error('Layout cancelled.'), { name: 'AbortError' }))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
    return () => {
      nativeLayout.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeLivePhysics])

  // ── The view handle for the explorer ──
  // Camera moves glide or jump by the explorer's setting; a move asked for with a duration keeps it only when animating.
  // Camera moves glide or jump by the explorer's setting; `undefined` stays itself, so a 2D flight's length can set its time.
  const moveMs = (ms: number | undefined) => (live.current.state.animateCamera ? ms : 0)
  useImperativeHandle(ref, () => ({
    fit: () => engineRef.current?.fit({ padding: 0.08, ms: moveMs(300) }),
    faceSlide: (id, ms) => faceSlide.current?.(id, ms) ?? false,
    zoomIn: () => zoomBy(engineRef.current, 1.5, moveMs(200) ?? 200),
    zoomOut: () => zoomBy(engineRef.current, 1 / 1.5, moveMs(200) ?? 200),
    getViewport: () => engineRef.current?.viewport() ?? null,
    getCamera: (): CameraState | null => (engineRef.current ? cameraState(engineRef.current, engineRef.current.viewport()) : null),
    // 2D flies on the zoom-and-pan path, its length setting the time unless `ms` is given; 3D orbits over `ms` (300 by default).
    setCamera: (target: CameraTarget, ms) => {
      const e = engineRef.current
      if (!e) return
      ms = moveMs(ms)
      if ('position' in target) {
        if (e.dims !== 3) return
        const look = target.lookAt ?? { x: e.camera3.tx, y: e.camera3.ty, z: e.camera3.tz }
        e.camera3.animateTo({ tx: look.x, ty: look.y, tz: look.z, ...orbitFrom(target.position, look), canonical: true }, ms ?? 300)
      } else {
        if (e.dims === 3) {
          e.camera3.animateTo({ ...(target.center ? { tx: target.center.x, ty: target.center.y, canonical: true } : {}), ...(target.ratio !== undefined ? { distance: e.camera3.fitDistance * target.ratio } : {}) }, ms ?? 300)
        } else {
          const cam = e.camera
          cam.animateTo(target.center?.x ?? cam.x, target.center?.y ?? cam.y, target.ratio !== undefined ? cam.fitScale / target.ratio : cam.scale, ms)
        }
      }
      e.cameraChanged()
    },
    fitTo: (ids, opts) => {
      const e = engineRef.current
      if (e) e.fitTo(indicesOf(e, ids), { ...opts, ms: moveMs(opts?.ms) })
    },
    // The camera goes right and up, so the picture slides left and down: a pan drags the picture, hence the signs.
    panBy: (dx, dy, opts) => {
      const e = engineRef.current
      if (!e) return
      const cam = e.dims === 3 ? e.camera3 : e.camera
      const px = opts?.fraction ? dx * cam.width : dx
      const py = opts?.fraction ? dy * cam.height : dy
      if (e.dims === 3) e.camera3.pan(-px, py)
      else e.camera.panBy(-px, py)
      e.cameraChanged()
    },
    zoomBy: (factor) => {
      const e = engineRef.current
      if (!e || !(factor > 0)) return
      if (e.dims === 3) e.camera3.dolly(1 / factor)
      else e.camera.zoomAt(factor, e.camera.width / 2, e.camera.height / 2)
      e.cameraChanged()
    },
    orbitBy: (yaw, pitch) => {
      const e = engineRef.current
      if (!e || e.dims !== 3) return
      e.camera3.orbit(yaw, pitch)
      e.cameraChanged()
    },
    flyBy: (forward, right, up) => {
      const e = engineRef.current
      if (!e || e.dims !== 3) return
      const k = e.camera3.fitDistance
      e.camera3.fly(forward * k, right * k, up * k)
      e.cameraChanged()
    },
    lookBy: (yaw, pitch) => {
      const e = engineRef.current
      if (!e || e.dims !== 3) return
      e.camera3.look(yaw, pitch)
      e.cameraChanged()
    },
    getLivePositions: () => {
      const e = engineRef.current
      const out: Positions = {}
      if (!e) return out
      const g = e.graph
      for (let i = 0; i < g.nodeCount; i++) {
        if (!g.nodeAlive.has(i)) continue
        const id = e.nodeId(i)
        if (id !== undefined) out[id] = e.dims === 3 ? { x: e.x(i), y: e.y(i), z: e.z(i) } : { x: e.x(i), y: e.y(i) }
      }
      return out
    },
    snapshot: async (opts) => {
      const e = engineRef.current
      if (!e) return null
      const blob = await e.snapshot()
      if (!blob || !opts?.width) return blob
      return snapshotBlobResized(blob, opts.width, opts.height)
    },
  }))

  const runBench = (preset: string) => {
    const h = handleOf(engineRef.current)
    if (h) void h.runBenchmark(preset).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const loadBench = (preset: string) => {
    const h = handleOf(engineRef.current)
    if (h) void h.loadBenchmark(preset).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const setSlides = useCallback((patch: Partial<SlidesView>) => dispatch({ type: 'setSlides', patch }), [dispatch])
  const selectIds = useCallback((ids: EntityId[], mode: 'replace' | 'add') => dispatch({ type: 'select', ids, mode }), [dispatch])

  return (
    <div className="gx-canvas gg">
      <div ref={hostRef} className="gg-host" style={revealed ? undefined : { visibility: 'hidden' }} />
      {dims === 2 && state.showPlacementOverlay && state.placementOverlay && <PlacementOverlay camera={overlayCamera} overlay={state.placementOverlay} />}
      {dims === 3 && source === 'explorer' && (
        <Slides engine={attached} view={state.slides} selectedIds={state.selectedIds} setSlides={setSlides} select={selectIds} faceRef={faceSlide} />
      )}
      <GpuHud
        backend={backend}
        error={error}
        stats={stats}
        source={source}
        bench={bench}
        presets={Object.keys(BENCH_PRESETS)}
        onLoad={loadBench}
        onRun={runBench}
        onExplorer={() => handleOf(engineRef.current)?.showExplorer()}
        physics={physics}
        onPhysics={(on) => {
          const engine = engineRef.current
          if (!engine) return
          if (on) engine.startPhysics({ dims: engine.dims, alphaTarget: LIVE_ALPHA_TARGET })
          else void engine.stopPhysics()
          setPhysics(engine.physicsState())
        }}
        onLayout={(alg) => {
          const engine = engineRef.current
          if (!engine) return
          void engine.layout(alg, { seed: 1 }).then(() => {
            engine.fit({ padding: 0.08, ms: 300 })
            if (sourceRef.current !== 'explorer') return
            // Held by the explorer, so the layout is saveable and the other renderers show it too.
            const out: Positions = {}
            const g = engine.graph
            for (let i = 0; i < g.nodeCount; i++) {
              if (!g.nodeAlive.has(i)) continue
              const id = engine.nodeId(i)
              if (id !== undefined) out[id] = posOf(engine, i)
            }
            dispatch({ type: 'setPhysics', on: false })
            dispatch({ type: 'moveNodes', positions: out })
          })
        }}
      />
      <GraphMenu
        menu={menu}
        onClose={() => setMenu(null)}
        fit={() => engineRef.current?.fit({ padding: 0.08, ms: 300 })}
        // The engine's adjacency answers without an object per edge, whatever the graph's size.
        neighborsOf={(id) => {
          const engine = engineRef.current
          const i = engine ? engine.nodeIndex(id) : -1
          if (!engine || i < 0) return []
          const out: EntityId[] = []
          engine.graph.forEachIncident(i, (_e, o) => {
            const other = engine.nodeId(o)
            if (other !== undefined) out.push(other)
          })
          return out
        }}
      />
    </div>
  )
})

/** The simulation's parameters from the explorer's layout parameters (the Layout tab's Force (Unigraph) knobs). */
const forceParams = (params: Pick<LayoutParams, 'unigraph'>, dims: 2 | 3) => ({ ...DEFAULT_UNIGRAPH_FORCE, ...(params.unigraph ?? {}), dims })
/**
 * The live simulation cools like a Run — its temperature decays to `alphaMin` and the picture comes to rest — but the
 * switch stays on: a drag, a parameter change or a change to the graph warms it back up and it settles again. It
 * used to settle on a temperature floor instead (an `alphaTarget` above zero), which kept every node trembling for
 * as long as the switch was on: the grid's far field is an approximation, and a floor turns its error into motion.
 */
const LIVE_ALPHA_TARGET = 0
/** Where a run starts over a picture whose nodes are all placed already: enough to settle it, not to re-form it. */
const WARM_ALPHA = 0.04
/**
 * How often a live run writes what it has reached to storage. It never cools now, so it cannot wait for that, and
 * it is the only reason the run's positions leave the engine at all while it runs: the picture is the engine's, and
 * a save, an export and a tool read take the positions from it too (`drawnPositions`). The write is a fill of a
 * float buffer the ids are already laid out for, so it costs about a frame even at a million nodes.
 *
 * It is not scheduled by a rule about sizes but by the measurement itself: each write times itself and the next is
 * far enough off that it has had no more than this share of the main thread. A second is the shortest wait (there
 * is nothing to gain from more often) and ten the longest — the most a reload in the middle of a run can lose.
 */
const KEEP_SHARE = 0.025
const KEEP_MIN_MS = 1000
const KEEP_MAX_MS = 10_000
const liveForceParams = (params: Pick<LayoutParams, 'unigraph'>, dims: 2 | 3) => ({ ...forceParams(params, dims), alphaTarget: LIVE_ALPHA_TARGET })

const posOf = (e: GraphEngine, i: number) => (e.dims === 3 ? { x: e.x(i), y: e.y(i), z: e.z(i) } : { x: e.x(i), y: e.y(i) })

function zoomBy(e: GraphEngine | null, factor: number, ms: number) {
  if (!e) return
  if (e.dims === 3) {
    // Flying, a zoom step is a step forward (or back), glided: the eye moves, the distance to the target does not.
    if (e.controls === 'fly') {
      const c = e.camera3
      const { forward } = c.axes()
      const step = c.fitDistance * 0.25 * (factor >= 1 ? 1 : -1)
      c.animateTo({ tx: c.tx + forward[0] * step, ty: c.ty + forward[1] * step, tz: c.tz + forward[2] * step }, ms)
    } else e.camera3.animateTo({ distance: e.camera3.distance / factor }, ms)
  }
  else e.camera.animateTo(e.camera.x, e.camera.y, e.camera.scale * factor, ms)
  e.cameraChanged()
}

/** The camera as the explorer's tools describe one: the 2D kind with sigma-like ratio, or the 3D kind with position and lookAt. */
function cameraState(e: GraphEngine, viewport: Viewport): CameraState {
  if (e.dims === 3) {
    const c = e.camera3
    const [x, y, z] = c.eye
    return { kind: '3d', position: { x, y, z }, lookAt: { x: c.tx, y: c.ty, z: c.tz } }
  }
  const cam = e.camera
  return { kind: '2d', x: cam.x, y: cam.y, ratio: cam.fitScale / cam.scale, angle: 0, center: { x: cam.x, y: cam.y }, viewport, extent: e.extent() ?? undefined }
}

/** Orbit parameters (distance, yaw, pitch) that put the eye at `position` looking at `lookAt`. */
function orbitFrom(position: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }) {
  const dx = position.x - lookAt.x, dy = position.y - lookAt.y, dz = position.z - lookAt.z
  const distance = Math.hypot(dx, dy, dz) || 1
  return { distance, yaw: Math.atan2(dx, dz), pitch: Math.asin(Math.max(-1, Math.min(1, dy / distance))) }
}

function handleOf(engine: GraphEngine | null): GpuGraphHandle | null {
  const reg = (globalThis as unknown as { __aegraphGpuGraphs?: { handles: GpuGraphHandle[] } }).__aegraphGpuGraphs
  return reg?.handles.find((h) => h.engine === engine) ?? null
}

function bitsOf(engine: GraphEngine, ids: Set<EntityId>): BitSet {
  const bits = new BitSet(engine.nodeCapacity)
  for (const id of ids) {
    const i = engine.nodeIndex(id)
    if (i >= 0) bits.set(i)
  }
  return bits
}

type Box = { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number }
/** Whether a rectangle in view still frames the picture: the picture inside it (with a margin), and not lost in it — at least a twentieth of its width or height. */
function viewportFrames(vp: Viewport, box: Box): boolean {
  const w = vp.maxX - vp.minX, h = vp.maxY - vp.minY
  if (!(w > 0 && h > 0)) return false
  const mx = w * 0.5, my = h * 0.5
  const inside = box.minX >= vp.minX - mx && box.maxX <= vp.maxX + mx && box.minY >= vp.minY - my && box.maxY <= vp.maxY + my
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY)
  return inside && span >= Math.min(w, h) * 0.05
}
/** Whether a remembered orbit camera still frames the picture: its target within the box (grown by half) and its distance within a quarter and four times the fit's. */
function camera3Frames(saved: { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }, box: Box, fitDistance: number, nearest = 0.25): boolean {
  const gx = (box.maxX - box.minX) * 0.5 + 1, gy = (box.maxY - box.minY) * 0.5 + 1, gz = (box.maxZ - box.minZ) * 0.5 + 1
  const t = saved.lookAt
  if (t.x < box.minX - gx || t.x > box.maxX + gx || t.y < box.minY - gy || t.y > box.maxY + gy || t.z < box.minZ - gz || t.z > box.maxZ + gz) return false
  const d = Math.hypot(saved.position.x - t.x, saved.position.y - t.y, saved.position.z - t.z)
  return d >= fitDistance * nearest && d <= fitDistance * 4
}


async function snapshotBlobResized(blob: Blob, width: number, height?: number): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob)
  const h = height ?? Math.round((bmp.height / bmp.width) * width)
  const c = document.createElement('canvas')
  c.width = width
  c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, width, h)
  // The decoded frame is the size of the canvas; let it go now rather than whenever the collector gets to it.
  bmp.close()
  return new Promise((r) => c.toBlob((b) => r(b), 'image/png'))
}

import { BENCH_PRESETS, type GeneratedGraph, type GenerateSpec } from '../../core/packed/generate'
import { packColor } from '../../core/packed/color'
import type { GraphEngine } from './engine/engine'
import { mulberry32 } from '../../core/packed/random'

/**
 * The benchmark harness: load a generated graph of a given size into the
 * engine and measure what the performance budgets name — load, first
 * frame, camera frames while panning and zooming, pointer picking,
 * selection changes, a drag, a marquee, a filter, a layout — each as a
 * number in milliseconds (percentiles where a distribution matters). The
 * same suite runs from the panel, from the `gpu_graph` tool and from the
 * headless driver, so a regression shows up as a number, not an
 * impression.
 */
export interface BenchResult {
  preset: string
  nodes: number
  edges: number
  backend: string
  generateMs: number
  loadMs: number
  firstFrameMs: number
  /** Frame times over 90 frames of pan+zoom, ms. */
  frame: { p50: number; p95: number; max: number; mean: number }
  /** Node picking at 300 random screen points, ms per pick. */
  pick: { mean: number; max: number }
  selectAllMs: number
  clearSelectionMs: number
  selectOneMs: number
  /** Selecting a hub's neighbourhood, ms, and its degree. */
  selectNeighbors: { ms: number; degree: number }
  /** A 60-frame drag of one node, ms per frame. */
  drag: { p50: number; p95: number }
  /** A 60-frame drag of 1,000 selected nodes, ms per frame. */
  dragMany: { p50: number; p95: number }
  marqueeMs: number
  marqueeHits: number
  filterMs: number
  layoutMs: number
  /** The live physics: iterations run over the whole graph, and the time per iteration (GPU timestamps when there are any, else wall clock). */
  physics?: { mode: string; iterations: number; msPerIteration: number; totalMs: number }
  gridMs: number
  labelsDrawn: number
  totalMs: number
}

const TYPE_COLORS = ['#4f77c2', '#c2733f', '#5c9e5c', '#b0508f', '#9c8b2f', '#6a6a6a'].map((c) => packColor(c))
const EDGE_COLORS = ['#c8cad0', '#e0c9b5', '#c9d8c9', '#d8c9d5'].map((c) => packColor(c))

const pct = (a: number[], p: number) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]
}
const stats = (a: number[]) => ({ p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? Math.max(...a) : 0, mean: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0 })
const round = (v: number) => Math.round(v * 100) / 100

/** Generate in the worker and load into the engine; returns the timings and the graph. */
export async function loadPreset(engine: GraphEngine, preset: string | GenerateSpec): Promise<{ generateMs: number; loadMs: number; firstFrameMs: number; graph: GeneratedGraph }> {
  const spec = typeof preset === 'string' ? BENCH_PRESETS[preset] : preset
  if (!spec) throw new Error(`Unknown preset "${preset}"; one of ${Object.keys(BENCH_PRESETS).join(', ')}`)
  const t0 = performance.now()
  const g = await engine.worker.call<GeneratedGraph>({ op: 'generate', spec: { seed: 1, ...spec } })
  const t1 = performance.now()
  engine.loadPacked(g, { typeColors: TYPE_COLORS, edgeTypeColors: EDGE_COLORS })
  engine.fit()
  const t2 = performance.now()
  engine.renderNow()
  const t3 = performance.now()
  return { generateMs: round(t1 - t0), loadMs: round(t2 - t1), firstFrameMs: round(t3 - t2), graph: g }
}

/** Wait a frame so the GPU queue drains and timings are not one big stall. */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

export async function runBenchmark(engine: GraphEngine, preset: string | GenerateSpec, onStage?: (stage: string) => void): Promise<BenchResult> {
  const T0 = performance.now()
  const stage = (s: string) => onStage?.(s)
  stage('generate')
  const load = await loadPreset(engine, preset)
  const N = engine.graph.nodeCount, E = engine.graph.edgeCount
  const cam = engine.camera
  const rand = mulberry32(7)
  await nextFrame()

  // Camera: 45 frames panning across, 45 frames zooming in and out, each frame rendered synchronously.
  stage('camera')
  const frames: number[] = []
  const fitScale = cam.scale, fx = cam.x, fy = cam.y
  for (let k = 0; k < 45; k++) {
    cam.panBy(6, 3)
    const t = performance.now()
    engine.renderNow()
    frames.push(performance.now() - t)
  }
  for (let k = 0; k < 45; k++) {
    cam.zoomAt(k < 22 ? 1.12 : 1 / 1.12, cam.width / 2, cam.height / 2)
    const t = performance.now()
    engine.renderNow()
    frames.push(performance.now() - t)
  }
  cam.animateTo(fx, fy, fitScale, 0)
  engine.renderNow()
  await nextFrame()

  // Picking: random screen points.
  stage('pick')
  const picks: number[] = []
  for (let k = 0; k < 300; k++) {
    const x = rand() * cam.width, y = rand() * cam.height
    const t = performance.now()
    engine.pick(x, y)
    picks.push(performance.now() - t)
  }

  // Selection.
  stage('select')
  let t = performance.now()
  engine.selectAll()
  engine.renderNow()
  const selectAllMs = performance.now() - t
  t = performance.now()
  engine.clearSelection()
  engine.renderNow()
  const clearSelectionMs = performance.now() - t
  t = performance.now()
  engine.setSelection([Math.floor(N / 2)])
  engine.renderNow()
  const selectOneMs = performance.now() - t
  let hub = 0
  for (let i = 1; i < N; i++) if (engine.graph.degree[i] > engine.graph.degree[hub]) hub = i
  t = performance.now()
  engine.selectNeighbors(hub, 'replace')
  engine.renderNow()
  const selectNeighborsMs = performance.now() - t
  engine.clearSelection()
  await nextFrame()

  // Drag one node, then a thousand.
  stage('drag')
  const one = new Uint32Array([hub])
  const dragOne: number[] = []
  for (let k = 0; k < 60; k++) {
    const tt = performance.now()
    engine.moveBy(one, 1, 2 / cam.scale, 1 / cam.scale)
    engine.renderNow()
    dragOne.push(performance.now() - tt)
  }
  engine.commit()
  const many = new Uint32Array(1000)
  for (let k = 0; k < 1000; k++) many[k] = (k * 97) % N
  const dragMany: number[] = []
  for (let k = 0; k < 60; k++) {
    const tt = performance.now()
    engine.moveBy(many, 1000, 2 / cam.scale, -1 / cam.scale)
    engine.renderNow()
    dragMany.push(performance.now() - tt)
  }
  t = performance.now()
  engine.commit()
  engine.gridNow()
  const gridMs = performance.now() - t
  await nextFrame()

  // Marquee over the middle third of the view.
  stage('marquee')
  t = performance.now()
  let hits = 0
  engine.nodesInScreenRect(cam.width / 3, cam.height / 3, (cam.width * 2) / 3, (cam.height * 2) / 3, () => hits++)
  const marqueeMs = performance.now() - t

  // Filter: one node type, then everything back.
  stage('filter')
  t = performance.now()
  engine.filterTypes(new Set([0]))
  engine.renderNow()
  const filterMs = performance.now() - t
  engine.filterTypes(null)
  engine.renderNow()
  await nextFrame()

  // Layout in the worker.
  stage('layout')
  const lay = await engine.layout('coarse', { seed: 1 })
  engine.fit()
  engine.renderNow()

  // Live physics: 60 iterations over the whole graph, timed.
  stage('physics')
  let physics: BenchResult['physics']
  const mode = engine.startPhysics()
  if (mode) {
    const tp = performance.now()
    const target = engine.physicsState().iterations + 60
    // The engine's own frame loop steps and draws; this just waits for the iterations.
    while (engine.physicsState().iterations < target && performance.now() - tp < 60_000) await nextFrame()
    const st = engine.physicsState()
    const totalPhysics = performance.now() - tp
    await engine.stopPhysics()
    physics = { mode, iterations: st.iterations, msPerIteration: round(Number.isFinite(st.msPerIteration) ? st.msPerIteration : totalPhysics / Math.max(1, st.iterations)), totalMs: round(totalPhysics) }
    engine.fit()
    engine.renderNow()
  }
  const totalMs = performance.now() - T0
  stage('')
  const fr = stats(frames)
  const pk = stats(picks)
  const d1 = stats(dragOne)
  const dm = stats(dragMany)
  return {
    preset: typeof preset === 'string' ? preset : `${preset.nodes}/${preset.edges}`,
    nodes: N,
    edges: E,
    backend: engine.backend ?? 'none',
    generateMs: load.generateMs,
    loadMs: load.loadMs,
    firstFrameMs: load.firstFrameMs,
    frame: { p50: round(fr.p50), p95: round(fr.p95), max: round(fr.max), mean: round(fr.mean) },
    pick: { mean: round(pk.mean * 1000) / 1000, max: round(pk.max) },
    selectAllMs: round(selectAllMs),
    clearSelectionMs: round(clearSelectionMs),
    selectOneMs: round(selectOneMs),
    selectNeighbors: { ms: round(selectNeighborsMs), degree: engine.graph.degree[hub] },
    drag: { p50: round(d1.p50), p95: round(d1.p95) },
    dragMany: { p50: round(dm.p50), p95: round(dm.p95) },
    marqueeMs: round(marqueeMs),
    marqueeHits: hits,
    filterMs: round(filterMs),
    layoutMs: round(lay.ms),
    physics,
    gridMs: round(gridMs),
    labelsDrawn: engine.stats.labels,
    totalMs: round(totalMs),
  }
}

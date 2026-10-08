import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { BENCH_PRESETS } from '../../core/packed/generate'
import { getGpuGraph, waitForGpuGraph, type GpuGraphHandle } from '../gpugraph/gpuGraphHandle'
import { getExplorerHandle } from '../graph/explorerHandle'
import { blobToBase64, json } from './toolkit'
import type { AppHost } from './tools'

/**
 * The GPU renderer of the graph explorer as a tool. The explorer's own
 * tools (`graph_*`) keep working on the GPU tab — filter, layout, style,
 * selection, camera all go through the shared explorer state — and this
 * one reaches what only the engine has: its backend and frame statistics,
 * the generated benchmark graphs (which never touch the entity system), the
 * suite that measures the performance budgets, the engine's own O(V+E)
 * layouts, and selection, filter, camera and moves by integer index for
 * graphs too big for id lists.
 */
export function createGpuGraphTools(host: AppHost) {
  const { navigate } = host

  const open = async (dims?: 2 | 3): Promise<GpuGraphHandle> => {
    const current = getGpuGraph()
    if (current && (dims === undefined || current.engine.dims === dims)) return current
    const explorer = getExplorerHandle()
    const want = dims === 3 ? '3d' : '2d'
    // An open explorer switches its canvas in place; otherwise the Unigraph page opens.
    if (explorer) explorer.switchMode(want)
    else navigate(`/unigraph/${dims === 3 ? '3d' : '2d'}`)
    const h = await waitForGpuGraph()
    if (!h) throw new Error('The GPU graph did not open. Navigate to /unigraph in the app and try again.')
    if (dims !== undefined && h.engine.dims !== dims) h.engine.setDims(dims)
    return h
  }
  const describe = (h: GpuGraphHandle) => {
    const e = h.engine
    const st = e.stats
    const cam = e.dims === 3 ? { kind: '3d', target: { x: e.camera3.tx, y: e.camera3.ty, z: e.camera3.tz }, distance: e.camera3.distance, yaw: e.camera3.yaw, pitch: e.camera3.pitch } : { kind: '2d', center: { x: e.camera.x, y: e.camera.y }, scale: e.camera.scale, ratio: e.camera.fitScale / e.camera.scale, viewport: e.viewport() }
    return {
      backend: e.backend ?? 'starting',
      dims: e.dims,
      source: h.getSource(),
      nodes: e.graph.aliveNodes(),
      edges: e.graph.aliveEdges(),
      visible: e.visibleCount(),
      selected: e.selectedCount(),
      hovered: e.hovered >= 0 ? { index: e.hovered, id: e.nodeId(e.hovered), label: e.labelOf(e.hovered) } : undefined,
      selectedEdge: e.selectedEdge >= 0 ? { index: e.selectedEdge, id: e.edgeId(e.selectedEdge) } : undefined,
      camera: cam,
      lod: { regime: st.regime, nodesInView: st.nodesInView, labels: st.labels },
      frame: { meanMs: Math.round(st.meanMs * 100) / 100, lastMs: Math.round(st.frameMs * 100) / 100, drawCalls: st.drawCalls, frames: st.frames },
      nodeTypes: e.nodeTypes.names,
      edgeTypes: e.edgeTypes.names,
      benchmark: h.lastBenchmark ? { preset: h.lastBenchmark.preset, frameP95: h.lastBenchmark.frame.p95 } : undefined,
      physics: e.physicsState().on ? e.physicsState() : undefined,
    }
  }
  /** Ids (entity ids, or `n<i>` on a generated graph) and indices → indices, dropping what is unknown. */
  const resolve = (h: GpuGraphHandle, ids?: string[], indices?: number[]) => {
    const out: number[] = []
    for (const id of ids ?? []) {
      const i = h.engine.nodeIndex(id)
      if (i >= 0) out.push(i)
    }
    for (const i of indices ?? []) if (h.engine.graph.hasNode(i)) out.push(i)
    return out
  }
  const presetOf = (preset?: string, nodes?: number, edges?: number) => {
    if (nodes) return { nodes, edges: edges ?? Math.round(nodes * 2.5) }
    const p = preset ?? '200k'
    if (!BENCH_PRESETS[p]) throw new Error(`Unknown preset "${p}"; one of ${Object.keys(BENCH_PRESETS).join(', ')}, or give nodes and edges.`)
    return p
  }

  const gpuGraph = betaTool({
    name: 'gpu_graph',
    description:
      "Unigraph — the graph explorer (/unigraph/2d and /unigraph/3d): its picture drawn by a WebGPU (or WebGL2) engine built for hundreds of thousands of nodes, in two or three dimensions. The explorer's tools (graph_filter, graph_layout, graph_style, graph_select, graph_viewport, graph_state…) work on it as on the other tabs. This tool reaches the engine itself. Actions: open (show it; `dims` 2 or 3), state (backend, counts, selection, camera, LOD regime, frame times), load (a generated benchmark graph — `preset` 10k, 50k, 100k, 200k, 500k, 1m, or `nodes` and `edges` — shown in place of the explorer's picture; it never enters the entity system), benchmark (load a preset and run the suite: load, camera frames p50/p95, picking, selection, drag, marquee, filter, layout — returns the numbers in ms), explorer (back to the explorer's picture), select (`ids` or `indices`, `mode` replace/add/toggle/remove; `all`; `clear`; `neighbors_of` an id), filter (`types` to keep, `min_degree`, `max_degree`; `reset`), camera (`fit`; `fit_selection`; `center` x,y; `ratio` 1 = fitted, smaller = closer; in 3D `position` and `look_at`), move (`ids`/`indices` by `dx`,`dy`,`dz` in world units — a drag; on the explorer's picture the positions are held like a hand drag), layout (`algorithm` coarse — communities by label propagation placed multilevel —, grid, circle, random; or relax: local forces over the selection), physics (the live force simulation over the whole graph — on the GPU as WebGPU compute, stepping the positions in place, a million nodes at a few milliseconds an iteration; in the worker without WebGPU: `on` true/false; `params` repulsion, link_distance, link_strength, gravity, damping, alpha_decay; `iterations` to run that many now and wait; `reheat` to warm a settled run; returns where it runs, alpha, iterations done and GPU ms per iteration), snapshot (a picture of the view — scaled to 1,200 px as JPEG by default, `full` for the canvas as PNG).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'state', 'load', 'benchmark', 'explorer', 'select', 'filter', 'camera', 'move', 'layout', 'physics', 'snapshot'] },
        full: { type: 'boolean', description: 'snapshot: the canvas at full size as PNG (default: scaled to max_width as JPEG, a fifth of the bytes)' },
        max_width: { type: 'integer', minimum: 320, maximum: 4096, description: 'snapshot: widest the image may be (default 1200)' },
        dims: { type: 'number', enum: [2, 3], description: 'open/load/benchmark: two or three dimensions (default: as it is, else 2)' },
        preset: { type: 'string', enum: Object.keys(BENCH_PRESETS), description: 'load/benchmark: a generated graph of this size (default 200k)' },
        nodes: { type: 'number', description: 'load/benchmark: a custom size instead of a preset' },
        edges: { type: 'number', description: 'load/benchmark: with `nodes` (default 2.5 × nodes)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'select/move: node ids (entity ids, or n<i> on a generated graph)' },
        indices: { type: 'array', items: { type: 'number' }, description: 'select/move: node indices' },
        mode: { type: 'string', enum: ['replace', 'add', 'toggle', 'remove'], description: 'select: how the ids combine with the selection (default replace)' },
        all: { type: 'boolean', description: 'select: every visible node' },
        clear: { type: 'boolean', description: 'select: nothing' },
        neighbors_of: { type: 'string', description: 'select: a node id whose neighbourhood is selected (with the node)' },
        types: { type: 'array', items: { type: 'string' }, description: 'filter: keep only these node types' },
        min_degree: { type: 'number' },
        max_degree: { type: 'number' },
        reset: { type: 'boolean', description: 'filter: show everything' },
        fit: { type: 'boolean', description: 'camera: frame the whole picture' },
        fit_selection: { type: 'boolean', description: 'camera: frame the selection' },
        center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false },
        ratio: { type: 'number', description: 'camera: zoom as a ratio of the fitted view (0.5 = twice as close)' },
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false, description: 'camera (3D): the eye' },
        look_at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false, description: 'camera (3D): the target' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        dz: { type: 'number' },
        algorithm: { type: 'string', enum: ['coarse', 'grid', 'circle', 'random', 'relax'], description: 'layout: which (default coarse)' },
        on: { type: 'boolean', description: 'physics: start (true) or stop (false); omitted with iterations: run them on the current or a fresh run' },
        iterations: { type: 'integer', minimum: 1, maximum: 5000, description: 'physics: step this many iterations, waiting for them (the frame loop runs them)' },
        reheat: { type: 'boolean', description: 'physics: warm a settled run back up' },
        params: { type: 'object', description: 'physics: repulsion (dimensionless, default 0.2), link_distance (default: the spacing that packs the nodes into the ball they occupy now, so the picture keeps its extent), link_strength (default 1), gravity (default 0.1; against the repulsion it sets the density — less of it, a looser picture), damping, alpha_decay (default 0.0045: about 1,500 iterations to cool), max_step (in link distances), link_jitter (default 0.3: each link’s rest length differs by up to this share, by a hash of its ends), spring_jitter (default 0.7: each link’s strength differs by up to this share — what keeps a hub’s thousands of leaves from packing in rings; 0 for identical springs)', properties: { repulsion: { type: 'number' }, link_distance: { type: 'number' }, link_strength: { type: 'number' }, gravity: { type: 'number' }, damping: { type: 'number' }, alpha_decay: { type: 'number' }, max_step: { type: 'number' }, link_jitter: { type: 'number' }, spring_jitter: { type: 'number' } }, additionalProperties: false },
        spacing: { type: 'number', description: 'layout: distance between neighbouring nodes in world units' },
        ms: { type: 'number', description: 'camera: animation length (default 300)' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, dims, preset, nodes, edges, ids, indices, mode, all, clear, neighbors_of, types, min_degree, max_degree, reset, fit, fit_selection, center, ratio, position, look_at, dx, dy, dz, algorithm, spacing, ms, on, iterations, reheat, params, full, max_width }) => {
      const d = dims === 3 ? 3 : dims === 2 ? 2 : undefined
      if (action === 'open') return json(describe(await open(d)))
      const h = action === 'state' ? getGpuGraph() : await open(d)
      if (!h) return json({ open: false, note: 'The GPU graph is not on screen; call gpu_graph open.' })
      const e = h.engine
      switch (action) {
        case 'state':
          return json(describe(h))
        case 'load': {
          const timings = await h.loadBenchmark(presetOf(preset, nodes, edges))
          return json({ ...timings, ...describe(h) })
        }
        case 'benchmark': {
          const r = await h.runBenchmark(presetOf(preset, nodes, edges))
          return json(r)
        }
        case 'explorer':
          h.showExplorer()
          return json({ source: 'explorer' })
        case 'select': {
          if (clear) e.clearSelection()
          else if (all) e.selectAll()
          else if (neighbors_of) {
            const i = e.nodeIndex(neighbors_of)
            if (i < 0) throw new Error(`No node "${neighbors_of}" in the GPU graph.`)
            e.selectNeighbors(i, mode ?? 'replace')
          } else e.setSelection(resolve(h, ids, indices), mode ?? 'replace')
          const sel = e.selectedIndices()
          return json({ selected: sel.length, sample: Array.from(sel.subarray(0, 12), (i) => ({ index: i, id: e.nodeId(i), label: e.labelOf(i) })) })
        }
        case 'filter': {
          if (reset) e.filterTypes(null)
          else {
            let codes: Set<number> | null = null
            if (types?.length) {
              codes = new Set()
              for (const t of types) {
                const c = e.nodeTypes.lookup(t)
                if (c < 0) throw new Error(`No node type "${t}" in the GPU graph; the types are ${e.nodeTypes.names.join(', ')}.`)
                codes.add(c)
              }
            }
            e.filterTypes(codes, min_degree ?? 0, max_degree ?? Infinity)
          }
          return json({ visible: e.visibleCount(), nodes: e.graph.aliveNodes() })
        }
        case 'camera': {
          const t = ms ?? 300
          if (fit) e.fit({ padding: 0.08, ms: t })
          else if (fit_selection) e.fitTo(e.selectedIndices(), { ms: t })
          else if (e.dims === 3) {
            if (position || look_at) {
              const [ex, ey, ez] = e.camera3.eye
              const look = { x: look_at?.x ?? e.camera3.tx, y: look_at?.y ?? e.camera3.ty, z: look_at?.z ?? e.camera3.tz }
              const eye = { x: position?.x ?? ex, y: position?.y ?? ey, z: position?.z ?? ez }
              const ddx = eye.x - look.x, ddy = eye.y - look.y, ddz = eye.z - look.z
              const distance = Math.hypot(ddx, ddy, ddz) || 1
              e.camera3.animateTo({ tx: look.x, ty: look.y, tz: look.z, distance, yaw: Math.atan2(ddx, ddz), pitch: Math.asin(Math.max(-1, Math.min(1, ddy / distance))), canonical: true }, t)
            } else e.camera3.animateTo({ ...(center ? { tx: center.x, ty: center.y, canonical: true } : {}), ...(ratio !== undefined ? { distance: e.camera3.fitDistance * ratio } : {}) }, t)
            e.cameraChanged()
          } else {
            const c = e.camera
            c.animateTo(center?.x ?? c.x, center?.y ?? c.y, ratio !== undefined ? c.fitScale / ratio : c.scale, t)
            e.cameraChanged()
          }
          return json(describe(h).camera)
        }
        case 'move': {
          const idx = Uint32Array.from(resolve(h, ids, indices))
          if (!idx.length) throw new Error('move: give ids or indices of nodes in the GPU graph.')
          e.moveBy(idx, idx.length, dx ?? 0, dy ?? 0, dz ?? 0)
          e.commit()
          e.emit('dragEnd', idx)
          return json({ moved: idx.length, sample: Array.from(idx.subarray(0, 5), (i) => ({ id: e.nodeId(i), x: e.x(i), y: e.y(i), z: e.z(i) })) })
        }
        case 'layout': {
          if (algorithm === 'relax') {
            const r = await e.relax(undefined, { spacing })
            return json(r)
          }
          const r = await e.layout(algorithm ?? 'coarse', { spacing, seed: 1 })
          e.fit({ padding: 0.08, ms: 300 })
          return json(r)
        }
        case 'physics': {
          const p = params ? { ...(params.repulsion !== undefined ? { repulsion: params.repulsion } : {}), ...(params.link_distance !== undefined ? { linkDistance: params.link_distance } : {}), ...(params.link_strength !== undefined ? { linkStrength: params.link_strength } : {}), ...(params.gravity !== undefined ? { gravity: params.gravity } : {}), ...(params.damping !== undefined ? { damping: params.damping } : {}), ...(params.alpha_decay !== undefined ? { alphaDecay: params.alpha_decay } : {}), ...(params.max_step !== undefined ? { maxStep: params.max_step } : {}), ...(params.link_jitter !== undefined ? { linkJitter: params.link_jitter } : {}), ...(params.spring_jitter !== undefined ? { springJitter: params.spring_jitter } : {}) } : {}
          if (on === false) {
            await e.stopPhysics()
            return json({ physics: e.physicsState() })
          }
          if (!e.physicsState().on) {
            const started = e.startPhysics(p)
            if (!started) throw new Error('Physics could not start (no nodes, or no renderer yet).')
          } else if (Object.keys(p).length) e.setPhysicsParams(p)
          if (reheat) e.reheatPhysics()
          if (iterations) {
            const t0 = performance.now()
            const target = e.physicsState().iterations + iterations
            while (e.physicsState().iterations < target && !e.physicsState().cooled && performance.now() - t0 < 60_000) await new Promise((r) => requestAnimationFrame(() => r(null)))
            return json({ physics: e.physicsState(), waitedMs: Math.round(performance.now() - t0) })
          }
          return json({ physics: e.physicsState() })
        }
        case 'snapshot': {
          // A 3,200-pixel retina PNG of a graph is half a megabyte to read and says nothing a 1,200-pixel JPEG does
          // not; `full: true` asks for the canvas as it is.
          const wide = full === true
          const blob = await e.snapshot(wide ? { format: 'png' } : { maxWidth: max_width ?? 1200, format: 'jpeg', quality: 0.82 })
          if (!blob) throw new Error('The GPU renderer is not ready (no backend yet).')
          const b64 = await blobToBase64(blob)
          return [{ type: 'text' as const, text: json({ bytes: blob.size, ...describe(h) }) }, { type: 'image' as const, source: { type: 'base64' as const, media_type: (wide ? 'image/png' : 'image/jpeg') as 'image/png' | 'image/jpeg', data: b64 } }]
        }
      }
      throw new Error(`Unknown action ${String(action)}`)
    },
  })

  return [gpuGraph]
}

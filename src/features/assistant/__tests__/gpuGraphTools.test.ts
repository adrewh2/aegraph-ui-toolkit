import { afterEach, describe, expect, it } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { EntityStore } from '../../../core/entity/store'
import { GraphEngine } from '../../gpugraph/engine/engine'
import { registerGpuGraph, type GpuGraphHandle } from '../../gpugraph/gpuGraphHandle'
import { generateGraph } from '../../../core/packed/generate'
import { createGpuGraphTools } from '../gpuGraphTools'
import type { AppHost } from '../tools'

/** A headless engine registered as the mounted GPU graph: the tool drives it exactly as it would the page's. */
function setup() {
  const store = new EntityStore()
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createGpuGraphTools(host)
  const engine = new GraphEngine()
  engine.camera.width = 800
  engine.camera.height = 600
  engine.camera3.width = 800
  engine.camera3.height = 600
  const g = generateGraph({ nodes: 500, edges: 1200, seed: 4 })
  let source: 'explorer' | 'benchmark' = 'explorer'
  engine.loadPacked(g)
  engine.fit()
  const handle: GpuGraphHandle = {
    engine,
    // No canvas in a test: the view has nothing to photograph, which is what a headless save sees too.
    snapshot: async () => null,
    getSource: () => source,
    loadBenchmark: async () => {
      source = 'benchmark'
      return { generateMs: 1, loadMs: 2, firstFrameMs: 3 }
    },
    runBenchmark: async () => {
      throw new Error('not in tests')
    },
    showExplorer: () => {
      source = 'explorer'
    },
  }
  const unregister = registerGpuGraph(handle)
  const run = (name: string) => {
    const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
    if (!t) throw new Error(`no tool ${name}`)
    return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  }
  return { engine, navigated, run, unregister }
}

describe('gpu_graph', () => {
  let cleanup: () => void = () => {}
  afterEach(() => cleanup())

  it('reports the engine state and selects by id, index and neighbourhood', async () => {
    const { engine, run, unregister } = setup()
    cleanup = unregister
    const st = await run('gpu_graph')({ action: 'state' })
    expect(st.nodes).toBe(500)
    expect(st.edges).toBe(1200)
    expect(st.dims).toBe(2)
    expect(st.camera.kind).toBe('2d')
    expect(st.nodeTypes).toContain('person')
    const sel = await run('gpu_graph')({ action: 'select', ids: ['n1', 'n2', 'nope'], indices: [7] })
    expect(sel.selected).toBe(3)
    expect(sel.sample.map((s: { id: string }) => s.id)).toEqual(['n1', 'n2', 'n7'])
    const nb = await run('gpu_graph')({ action: 'select', neighbors_of: 'n0' })
    expect(nb.selected).toBe(engine.graph.degree[0] + 1)
    const all = await run('gpu_graph')({ action: 'select', all: true })
    expect(all.selected).toBe(500)
    const none = await run('gpu_graph')({ action: 'select', clear: true })
    expect(none.selected).toBe(0)
  })

  it('physics takes the link variations: link_jitter and spring_jitter reach the simulation', async () => {
    const { engine, run, unregister } = setup()
    cleanup = unregister
    await run('gpu_graph')({ action: 'physics', params: { link_jitter: 0.1, spring_jitter: 0 } })
    const p = (engine as unknown as { physicsParams: { linkJitter: number; springJitter: number } }).physicsParams
    expect(p.linkJitter).toBe(0.1)
    expect(p.springJitter).toBe(0)
    await run('gpu_graph')({ action: 'physics', on: false })
  })

  it('filters by type and degree, moves nodes, and frames the camera', async () => {
    const { engine, run, unregister } = setup()
    cleanup = unregister
    const f = await run('gpu_graph')({ action: 'filter', types: ['person'] })
    expect(f.visible).toBeLessThan(500)
    expect(f.visible).toBeGreaterThan(0)
    await expect(run('gpu_graph')({ action: 'filter', types: ['dragon'] })).rejects.toThrow(/No node type/)
    const r = await run('gpu_graph')({ action: 'filter', reset: true })
    expect(r.visible).toBe(500)
    const x0 = engine.x(3)
    const mv = await run('gpu_graph')({ action: 'move', ids: ['n3'], dx: 10, dy: -5 })
    expect(mv.moved).toBe(1)
    expect(engine.x(3)).toBeCloseTo(x0 + 10)
    const cam = await run('gpu_graph')({ action: 'camera', ratio: 0.5, ms: 0 })
    expect(cam.ratio).toBeCloseTo(0.5)
    const fit = await run('gpu_graph')({ action: 'camera', fit: true, ms: 0 })
    expect(fit.ratio).toBeCloseTo(1)
  })

  it('loads a benchmark graph and goes back to the explorer', async () => {
    const { run, unregister } = setup()
    cleanup = unregister
    const l = await run('gpu_graph')({ action: 'load', preset: '10k' })
    expect(l.source).toBe('benchmark')
    expect(l.generateMs).toBe(1)
    await expect(run('gpu_graph')({ action: 'load', preset: '9k' })).rejects.toThrow()
    const back = await run('gpu_graph')({ action: 'explorer' })
    expect(back.source).toBe('explorer')
  })

  it('says so when no GPU graph is mounted', async () => {
    const { run, unregister } = setup()
    unregister()
    const st = await run('gpu_graph')({ action: 'state' })
    expect(st.open).toBe(false)
  })
})

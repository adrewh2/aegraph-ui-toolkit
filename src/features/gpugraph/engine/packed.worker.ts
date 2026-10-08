import { BitSet } from '../../../core/packed/bitset'
import { generateGraph, type GenerateSpec } from '../../../core/packed/generate'
import { PackedGraph } from '../../../core/packed/graph'
import { labelPropagation, layoutCircle, layoutCoarse, layoutGrid, layoutRandom, localForce, type Dims } from '../../../core/packed/layout'
import { PhysicsSim, type PhysicsParams } from '../../../core/packed/physics'

/**
 * The GPU graph's worker: everything that is O(V + E) or worse and not a
 * frame — generating a benchmark graph, the multilevel layout, a local force
 * run, communities. The main thread sends packed arrays (copies; the graph
 * is small in bytes even at 500k edges) and gets packed arrays back, moved,
 * not copied. One request at a time per worker; the client queues.
 */

export type WorkerRequest =
  | { id: number; op: 'generate'; spec: GenerateSpec }
  | { id: number; op: 'layout'; algorithm: 'coarse' | 'grid' | 'random' | 'circle'; dims?: Dims; nodeCount: number; nodeType: Uint16Array; edgeSource: Uint32Array; edgeTarget: Uint32Array; alive: Uint32Array; positions: Float32Array; pinned?: Uint32Array; spacing?: number; seed?: number }
  | { id: number; op: 'localForce'; dims?: Dims; nodeCount: number; edgeSource: Uint32Array; edgeTarget: Uint32Array; alive: Uint32Array; positions: Float32Array; subset: Uint32Array; pinned?: Uint32Array; iterations?: number; spacing?: number }
  | { id: number; op: 'communities'; nodeCount: number; edgeSource: Uint32Array; edgeTarget: Uint32Array; alive: Uint32Array; iterations?: number }
  // The live physics when the backend has no compute: the worker keeps the simulation between steps.
  | { id: number; op: 'physicsStart'; nodeCount: number; offsets: Uint32Array; neighbors: Uint32Array; positions: Float32Array; state: Uint8Array; params: PhysicsParams }
  | { id: number; op: 'physicsStep'; iterations: number; alpha: number }
  | { id: number; op: 'physicsHeld'; held: Uint32Array }
  | { id: number; op: 'physicsParams'; params: PhysicsParams }
  | { id: number; op: 'physicsStop' }

export type WorkerResponse = { id: number; ok: true; result: unknown; ms: number } | { id: number; ok: false; error: string }

function graphFrom(nodeCount: number, edgeSource: Uint32Array, edgeTarget: Uint32Array, aliveWords: Uint32Array): PackedGraph {
  const nodeType = new Uint16Array(nodeCount)
  const g = PackedGraph.fromArrays({ nodeType, edgeSource, edgeTarget, edgeType: new Uint16Array(edgeSource.length) })
  g.nodeAlive.words.set(aliveWords.subarray(0, g.nodeAlive.words.length))
  return g
}
const bitsFrom = (indices: Uint32Array | undefined, size: number) => (indices ? BitSet.from(indices, size) : undefined)
let sim: PhysicsSim | null = null

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data
  const t0 = performance.now()
  try {
    let result: unknown
    let transfer: Transferable[] = []
    switch (m.op) {
      case 'generate': {
        const g = generateGraph(m.spec)
        result = g
        transfer = [g.nodeType.buffer, g.edgeSource.buffer, g.edgeTarget.buffer, g.edgeType.buffer, g.positions.buffer, g.community.buffer]
        break
      }
      case 'layout': {
        const positions = m.positions
        if (m.algorithm === 'coarse') {
          const g = graphFrom(m.nodeCount, m.edgeSource, m.edgeTarget, m.alive)
          const comm = layoutCoarse(g, positions, { spacing: m.spacing, seed: m.seed, dims: m.dims }, bitsFrom(m.pinned, m.nodeCount))
          result = { positions, communities: comm.labels, count: comm.communities }
          transfer = [positions.buffer, comm.labels.buffer]
        } else {
          const spacing = m.spacing ?? 12
          if (m.algorithm === 'grid') layoutGrid(m.nodeCount, positions, spacing, m.dims)
          else if (m.algorithm === 'circle') layoutCircle(m.nodeCount, positions, spacing, m.dims)
          else layoutRandom(m.nodeCount, positions, spacing * Math.sqrt(m.nodeCount), m.seed, m.dims)
          result = { positions }
          transfer = [positions.buffer]
        }
        break
      }
      case 'localForce': {
        const g = graphFrom(m.nodeCount, m.edgeSource, m.edgeTarget, m.alive)
        localForce(g, m.positions, m.subset, { dims: m.dims, iterations: m.iterations, spacing: m.spacing, pinned: bitsFrom(m.pinned, m.nodeCount) })
        result = { positions: m.positions, subset: m.subset }
        transfer = [m.positions.buffer, m.subset.buffer]
        break
      }
      case 'communities': {
        const g = graphFrom(m.nodeCount, m.edgeSource, m.edgeTarget, m.alive)
        const c = labelPropagation(g, m.iterations ?? 6)
        result = { labels: c.labels, count: c.communities }
        transfer = [c.labels.buffer]
        break
      }
      case 'physicsStart': {
        sim = new PhysicsSim(m.nodeCount, m.offsets, m.neighbors, m.positions, m.params)
        sim.state.set(m.state)
        result = { started: true }
        break
      }
      case 'physicsStep': {
        if (!sim) throw new Error('No simulation.')
        sim.alpha = Math.max(sim.alpha, m.alpha)
        const done = sim.step(m.iterations)
        const positions = sim.positions.slice()
        result = { positions, alpha: sim.alpha, iterations: done }
        transfer = [positions.buffer]
        break
      }
      case 'physicsHeld': {
        if (sim) for (let i = 0; i < sim.nodeCount; i++) sim.state[i] = (sim.state[i] & 1) | (m.held[i >> 5] & (1 << (i & 31)) ? 2 : 0)
        result = { ok: true }
        break
      }
      case 'physicsParams': {
        if (sim) sim.params = m.params
        result = { ok: true }
        break
      }
      case 'physicsStop': {
        sim = null
        result = { ok: true }
        break
      }
    }
    const reply: WorkerResponse = { id: m.id, ok: true, result, ms: performance.now() - t0 }
    ;(self as unknown as Worker).postMessage(reply, transfer)
  } catch (err) {
    const reply: WorkerResponse = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }
    ;(self as unknown as Worker).postMessage(reply)
  }
}

import createLayout from 'ngraph.forcelayout'
import createGraph from 'ngraph.graph'
import { BASE, random, type Positions } from '../layouts'
import type { EngineFn } from '../layoutEngines'

/**
 * ngraph.forcelayout: springs plus n-body repulsion over a Barnes–Hut tree,
 * in 2 or 3 dimensions. Stepped a fixed number of times from held or random
 * positions; pinned nodes are pinned in the simulation too.
 */
const run: EngineFn = (_algorithm, { slice, params, previous, fixed, rnd }) => {
  const g = createGraph()
  const ids = new Set(slice.nodes.map((n) => n.id))
  for (const n of slice.nodes) g.addNode(n.id)
  for (const e of slice.edges) if (e.source.id !== e.target.id && ids.has(e.source.id) && ids.has(e.target.id)) g.addLink(e.source.id, e.target.id)
  const dims = params.dimensions
  const spring = BASE * 1.5 * params.spacing
  const layout = createLayout(g, { dimensions: dims, springLength: spring, springCoefficient: 0.8, gravity: -1.2 * spring, theta: 0.8, dragCoefficient: 0.02, timeStep: 20 })
  const seed = previous ?? random(slice, params, rnd)
  for (const n of slice.nodes) {
    const p = seed[n.id]
    if (p) {
      if (dims === 3) layout.setNodePosition(n.id, p.x, p.y, p.z ?? 0)
      else layout.setNodePosition(n.id, p.x, p.y)
    }
    if (fixed.has(n.id)) layout.pinNode(g.getNode(n.id)!, true)
  }
  const steps = Math.max(20, Math.min(2000, params.iterations))
  for (let i = 0; i < steps; i++) if (layout.step()) break
  const out: Positions = {}
  for (const n of slice.nodes) {
    const p = layout.getNodePosition(n.id)
    out[n.id] = dims === 3 ? { x: p.x, y: p.y, z: p.z ?? 0 } : { x: p.x, y: p.y }
  }
  return out
}
export default run

import { Layout, Layout3D, Link3D, Node3D } from 'webcola'
import { BASE, random, type Positions } from '../layouts'
import type { EngineFn } from '../layoutEngines'

/**
 * WebCola: constraint-based stress majorization with overlap avoidance in 2D,
 * and its 3D sibling. Both step a fixed number of iterations here (no
 * animation loop) and hand back positions. Seeded from held positions so a
 * re-run refines rather than reshuffles.
 */
const run: EngineFn = (_algorithm, { slice, params, previous, fixed, rnd }) => {
  // Strictly positive: WebCola's linkDistance(0) reads as the getter and the chain breaks; a zero spacing is a tight picture, not none.
  const ideal = Math.max(1, BASE * 2.5 * params.spacing)
  const iterations = Math.max(20, Math.min(400, params.iterations))
  const index = new Map(slice.nodes.map((n, i) => [n.id, i]))
  const seed = previous ?? random(slice, params, rnd)
  const links = slice.edges.filter((e) => e.source.id !== e.target.id && index.has(e.source.id) && index.has(e.target.id))
  const out: Positions = {}
  if (params.dimensions === 3) {
    const nodes = slice.nodes.map((n) => {
      const p = seed[n.id]
      const v = new Node3D(p?.x ?? (rnd() - 0.5) * 100, p?.y ?? (rnd() - 0.5) * 100, p?.z ?? (rnd() - 0.5) * 100)
      v.fixed = fixed.has(n.id)
      return v
    })
    const l3 = links.map((e) => new Link3D(index.get(e.source.id)!, index.get(e.target.id)!))
    const layout = new Layout3D(nodes, l3, ideal)
    layout.useJaccardLinkLengths = links.length < 20000
    layout.start(iterations)
    slice.nodes.forEach((n, i) => (out[n.id] = { x: layout.result[0][i], y: layout.result[1][i], z: layout.result[2][i] }))
    return out
  }
  const size = BASE * 0.5 * params.spacing
  const nodes = slice.nodes.map((n) => {
    const p = seed[n.id]
    return { x: p?.x ?? (rnd() - 0.5) * 100, y: p?.y ?? (rnd() - 0.5) * 100, width: size, height: size, fixed: fixed.has(n.id) ? 1 : 0 }
  })
  const layout = new Layout()
    .nodes(nodes)
    .links(links.map((e) => ({ source: index.get(e.source.id)!, target: index.get(e.target.id)! })))
    .linkDistance(ideal)
    .avoidOverlaps(true)
    .handleDisconnected(true)
  if (links.length < 20000) layout.jaccardLinkLengths(ideal, 0.7)
  // Unconstrained, then with user constraints (none), then with overlap constraints, then snap — WebCola's phases.
  layout.start(Math.round(iterations * 0.4), Math.round(iterations * 0.1), Math.round(iterations * 0.5), 0, false, false)
  slice.nodes.forEach((n, i) => (out[n.id] = { x: nodes[i].x, y: nodes[i].y }))
  return out
}
export default run

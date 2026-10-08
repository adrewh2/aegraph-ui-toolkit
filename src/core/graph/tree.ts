import type { AnyEntity, EntityId } from '../entity/types'
import type { GraphSlice } from './filter'
import type { LayoutParams, Positions } from './layouts'

/**
 * Hierarchy from any graph, and the two layouts that draw one: a radial tree
 * in 2D and a cone tree in 3D.
 *
 * A dense graph has no tree in it, but it always has a *spanning* tree, and
 * that is what makes branches legible: pick roots, walk breadth-first, and
 * every node gets one parent. Edges that do not fit the tree are ignored for
 * placement (they are still drawn) — the same bargain ELK's tree layouts make,
 * except this one is O(V+E) with typed arrays and no download, so it holds for
 * a hundred thousand nodes.
 *
 * Everything here is deterministic: the same slice gives the same picture.
 */

export type TreeFollow = 'out' | 'in' | 'any' | 'auto'

export interface Hierarchy {
  nodes: readonly AnyEntity[]
  /** Node index → its parent's index, or -1 for a root. */
  parent: Int32Array
  depth: Int32Array
  /** Children in CSR form: `items[start[i] … start[i] + count[i])`. */
  start: Int32Array
  count: Int32Array
  items: Int32Array
  /** Root indices, in placement order. */
  roots: number[]
  /** Breadth-first order: a parent always comes before its children. */
  order: Int32Array
  /** Leaves under each node (itself when it is a leaf), for sizing. */
  leaves: Int32Array
  /** Edges of the slice the tree could not use — the cross-links that made the mesh. */
  extra: number
  maxDepth: number
}

/**
 * A spanning forest of the slice.
 *
 * `follow` reads the edges as parent → child (`out`), child → parent (`in`),
 * or either way (`any`). Roots are the ids given, else every node nothing
 * points at (a real hierarchy starts there), else the best-connected node of
 * each component — so a cyclic or undirected graph still yields a forest.
 */
export function hierarchyOf(slice: GraphSlice, opts: { follow?: TreeFollow; roots?: Iterable<EntityId> } = {}): Hierarchy {
  // `auto` is what a caller who does not know the data wants: the same edges read both ways, and the deeper, less
  // ragged tree wins — segments pointing at their cluster and clusters at their region make a hierarchy only when
  // it is read against the arrows. A mesh that is a hierarchy neither way ends up as a plain spanning tree.
  if ((opts.follow ?? 'auto') === 'auto') {
    // All three readings, cheap enough to try: the one that gathers the graph under the fewest roots and hangs it
    // deepest wins. Directed readings carry a small bonus, so a real hierarchy is drawn the way its arrows point;
    // a graph whose arrows say nothing — members all pointing at their container, and nothing pointing on — falls
    // to the undirected reading, which is the difference between a field of two-node stars and a tree.
    const readings = [hierarchyOf(slice, { ...opts, follow: 'out' }), hierarchyOf(slice, { ...opts, follow: 'in' }), hierarchyOf(slice, { ...opts, follow: 'any' })]
    const weights = [1.05, 1.05, 1]
    let best = readings[0]
    let bestScore = -1
    readings.forEach((h, i) => {
      const s = score(h) * weights[i]
      if (s > bestScore) {
        bestScore = s
        best = h
      }
    })
    return best
  }
  const follow = opts.follow ?? 'out'
  const nodes = slice.nodes
  const n = nodes.length
  const index = new Map<EntityId, number>()
  for (let i = 0; i < n; i++) index.set(nodes[i].id, i)

  // ── Adjacency, CSR, one pass to count and one to fill ──
  const deg = new Int32Array(n)
  // Where a walk in this direction can start: nothing points at it going `out`, it points at nothing going `in`.
  const upstream = new Int32Array(n)
  const edges: number[] = []
  for (const e of slice.edges) {
    const a = index.get(e.source.id)
    const b = index.get(e.target.id)
    if (a === undefined || b === undefined || a === b) continue
    edges.push(a, b)
    upstream[follow === 'in' ? a : b]++
    if (follow === 'out') deg[a]++
    else if (follow === 'in') deg[b]++
    else {
      deg[a]++
      deg[b]++
    }
  }
  const start = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i]
  const adj = new Int32Array(start[n])
  const fill = start.slice(0, n)
  for (let k = 0; k < edges.length; k += 2) {
    const a = edges[k]
    const b = edges[k + 1]
    if (follow === 'out') adj[fill[a]++] = b
    else if (follow === 'in') adj[fill[b]++] = a
    else {
      adj[fill[a]++] = b
      adj[fill[b]++] = a
    }
  }

  // ── Roots ──
  const parent = new Int32Array(n).fill(-2) // -2: not visited yet
  const depth = new Int32Array(n)
  const order = new Int32Array(n)
  const roots: number[] = []
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  let seen = 0
  const enqueue = (i: number, from: number) => {
    parent[i] = from
    depth[i] = from < 0 ? 0 : depth[from] + 1
    queue[tail++] = i
    order[seen++] = i
  }
  const sweep = () => {
    while (head < tail) {
      const i = queue[head++]
      for (let k = start[i]; k < start[i + 1]; k++) {
        const j = adj[k]
        if (parent[j] === -2) enqueue(j, i)
      }
    }
  }
  const given: number[] = []
  for (const id of opts.roots ?? []) {
    const i = index.get(id)
    if (i !== undefined && parent[i] === -2) given.push(i)
  }
  for (const i of given) {
    if (parent[i] !== -2) continue
    roots.push(i)
    enqueue(i, -1)
    sweep()
  }
  // Sources first — the nodes a hierarchy hangs from — biggest subtree first, so the picture leads with the main branch.
  if (follow !== 'any') {
    const sources: number[] = []
    for (let i = 0; i < n; i++) if (parent[i] === -2 && upstream[i] === 0) sources.push(i)
    sources.sort((a, b) => start[b + 1] - start[b] - (start[a + 1] - start[a]) || a - b)
    for (const i of sources) {
      if (parent[i] !== -2) continue
      roots.push(i)
      enqueue(i, -1)
      sweep()
    }
  }
  // Whatever is left is cyclic, or undirected: each remaining component hangs from its best-connected node.
  if (seen < n) {
    const rest: number[] = []
    for (let i = 0; i < n; i++) if (parent[i] === -2) rest.push(i)
    rest.sort((a, b) => start[b + 1] - start[b] - (start[a + 1] - start[a]) || a - b)
    for (const i of rest) {
      if (parent[i] !== -2) continue
      roots.push(i)
      enqueue(i, -1)
      sweep()
    }
  }

  // ── Children, in CSR ──
  const count = new Int32Array(n)
  for (let i = 0; i < n; i++) if (parent[i] >= 0) count[parent[i]]++
  const cStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) cStart[i + 1] = cStart[i] + count[i]
  const items = new Int32Array(cStart[n])
  const cFill = cStart.slice(0, n)
  // Breadth-first order keeps siblings together and the arrays deterministic.
  for (let k = 0; k < n; k++) {
    const i = order[k]
    const p = parent[i]
    if (p >= 0) items[cFill[p]++] = i
  }

  // ── Leaves under each node, bottom-up along the breadth-first order ──
  const leaves = new Int32Array(n)
  let maxDepth = 0
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k]
    if (count[i] === 0) leaves[i] = 1
    if (depth[i] > maxDepth) maxDepth = depth[i]
    const p = parent[i]
    if (p >= 0) leaves[p] += leaves[i]
  }

  let extra = 0
  for (let k = 0; k < edges.length; k += 2) {
    const a = edges[k]
    const b = edges[k + 1]
    if (parent[b] !== a && parent[a] !== b) extra++
  }
  return { nodes, parent, depth, start: cStart, count, items, roots, order, leaves, extra, maxDepth }
}

/** How much of a hierarchy a reading found: how much of the graph hangs below a root, then how deep it hangs. */
function score(h: Hierarchy): number {
  const n = h.nodes.length
  if (!n || h.maxDepth < 1) return 0
  return (1 - h.roots.length / n) * 10000 + h.maxDepth * 100
}

/** Subtrees sorted so the biggest branch is drawn first — the eye finds the trunk. */
function sortedChildren(h: Hierarchy, i: number): number[] {
  const out: number[] = []
  for (let k = h.start[i]; k < h.start[i] + h.count[i]; k++) out.push(h.items[k])
  out.sort((a, b) => h.leaves[b] - h.leaves[a] || a - b)
  return out
}

/** Where a 2D forest's roots go: one at the origin, several on a spiral wide enough for their own discs. */
function rootSpots(h: Hierarchy, radius: Float64Array, gap: number): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = []
  if (h.roots.length <= 1) return h.roots.map(() => ({ x: 0, y: 0 }))
  const golden = Math.PI * (3 - Math.sqrt(5))
  let r = 0
  for (let k = 0; k < h.roots.length; k++) {
    const rad = radius[h.roots[k]]
    r += k === 0 ? 0 : rad + gap
    const a = k * golden
    spots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    r += rad * 0.35
  }
  return spots
}

const BASE = 60

/**
 * A cone tree in 3D: each node's children ride a circle around its own axis,
 * one level further down, the circle wide enough for their subtrees. Branches
 * read as cones nested in cones — what a force layout of the same graph shows
 * as a ball of wool.
 *
 * Depth runs down −y and the cones open across x/z, so the renderer's own
 * camera — level with the scene, looking along z — sees the tree from the
 * side, branching downwards, rather than end-on as a set of rings.
 */
export function coneTree(slice: GraphSlice, p: LayoutParams, follow?: TreeFollow, rootIds?: Iterable<EntityId>): Positions {
  const h = hierarchyOf(slice, { follow, roots: rootIds })
  const n = h.nodes.length
  const out: Positions = {}
  if (!n) return out
  const spacing = Math.max(0.1, p.spacing)
  const node = BASE * 0.35 * spacing
  const gap = node * 1.6

  // Bottom-up: the radius of each node's cone, and how far its subtree spreads.
  const ring = new Float64Array(n) // the innermost ring the children sit on
  const outer = new Float64Array(n) // where the outermost ring lands
  const rings = new Int32Array(n)
  const spread = new Float64Array(n) // how wide the whole subtree is, for packing
  for (let k = n - 1; k >= 0; k--) {
    const i = h.order[k]
    if (h.count[i] === 0) {
      spread[i] = node
      continue
    }
    let widest = 0
    let sum = 0
    for (let c = h.start[i]; c < h.start[i] + h.count[i]; c++) {
      const j = h.items[c]
      sum += 2 * spread[j] + gap
      if (spread[j] > widest) widest = spread[j]
    }
    // One child sits straight under its parent rather than orbiting a hair away from it. Many children fill rings
    // rather than one vast circle — a thousand of them on a single ring would make a pancake a kilometre wide and
    // hide the depth that the branches are drawn to show.
    if (h.count[i] === 1) {
      ring[i] = 0
      spread[i] = spread[h.items[h.start[i]]]
      continue
    }
    ring[i] = Math.max(node, baseRadius(sum, widest + gap))
    // The cone's real width is where its outermost ring lands, not where its first one does: a fan of three
    // thousand leaves fills twenty rings, and sizing it by the first would have every level overlap the next.
    const plan = ringPlan(sortedChildren(h, i), ring[i], gap, spread, 0)
    outer[i] = plan.outer
    rings[i] = plan.rings
    spread[i] = plan.outer
  }

  // Each cone is as tall as it is wide: a step proportional to the parent's own spread, not one global level, so a
  // fan of thousands does not flatten the tree it hangs from. `ranksep` scales the lot.
  const step = (i: number) => Math.max(BASE * 1.25 * spacing, outer[i] * 0.55) * (p.ranksep ?? 1.5)

  const golden = Math.PI * (3 - Math.sqrt(5))
  const stack: number[] = []
  // A forest is drawn as one tree: the roots are the children of a point above them, so hundreds of little trees
  // become branches of a single structure instead of a field of saplings on a plane.
  if (h.roots.length === 1) {
    out[h.nodes[h.roots[0]].id] = { x: 0, y: 0, z: 0 }
    stack.push(h.roots[0])
  } else {
    const roots = [...h.roots].sort((a, b) => spread[b] - spread[a] || a - b)
    let sum = 0
    let widest = 0
    for (const r of roots) {
      sum += 2 * spread[r] + gap
      if (spread[r] > widest) widest = spread[r]
    }
    const base = Math.max(node, baseRadius(sum, widest + gap))
    const plan = ringPlan(roots, base, gap, spread, 0)
    const drop = Math.max(BASE * 1.25 * spacing, plan.outer * 0.55) * (p.ranksep ?? 1.5)
    for (let x = 0; x < roots.length; x++) {
      const y = -drop * (1 + (plan.rings > 1 ? (plan.ring[x] / Math.max(1, plan.rings - 1)) * 0.6 : 0))
      out[h.nodes[roots[x]].id] = { x: Math.cos(plan.angle[x]) * plan.radius[x], y, z: Math.sin(plan.angle[x]) * plan.radius[x] }
      stack.push(roots[x])
    }
  }
  while (stack.length) {
    const i = stack.pop()!
    const at = out[h.nodes[i].id]
    const kids = sortedChildren(h, i)
    if (!kids.length) continue
    const drop = step(i)
    if (kids.length === 1) {
      const j = kids[0]
      out[h.nodes[j].id] = { x: at.x, y: at.y - drop, z: at.z ?? 0 }
      stack.push(j)
      continue
    }
    const plan = ringPlan(kids, ring[i], gap, spread, h.depth[i] * golden)
    for (let x = 0; x < kids.length; x++) {
      const j = kids[x]
      // Rings further out hang a little lower: the fan becomes the surface of a cone rather than a flat disc.
      const y = at.y - drop * (1 + (plan.rings > 1 ? (plan.ring[x] / Math.max(1, plan.rings - 1)) * 0.6 : 0))
      out[h.nodes[j].id] = { x: at.x + Math.cos(plan.angle[x]) * plan.radius[x], y, z: (at.z ?? 0) + Math.sin(plan.angle[x]) * plan.radius[x] }
      stack.push(j)
    }
  }
  return out
}

/**
 * How a node's children sit around its axis: one ring while they fit, concentric rings when there are more, each
 * ring's share of the angle proportional to the subtree it carries. The plan is computed once in the sizing pass
 * and again when placing, so a cone's drawn width is exactly the width it was sized for.
 */
interface RingPlan {
  /** Ring radius per child, and the angle it sits at. */
  radius: Float64Array
  angle: Float64Array
  /** Which ring each child landed on: rings below the first drop a little, so a wide fan is a cone, not a disc. */
  ring: Int32Array
  /** The furthest any child sits from the axis — the cone's real radius. */
  outer: number
  rings: number
}

function ringPlan(kids: number[], base: number, gap: number, spread: Float64Array, phase: number): RingPlan {
  const m = kids.length
  const radius = new Float64Array(m)
  const angle = new Float64Array(m)
  const ring = new Int32Array(m)
  let outer = 0
  let k = 0
  let ringNo = 0
  while (k < m) {
    const r = base * (ringNo === 0 ? 1 : 1 + ringNo * 0.55)
    let fit = 0
    let used = 0
    while (k + fit < m) {
      const need = 2 * spread[kids[k + fit]] + gap
      if (fit > 0 && used + need > 2 * Math.PI * r) break
      used += need
      fit++
    }
    let a = phase + ringNo * 0.6
    for (let x = 0; x < fit; x++) {
      const j = kids[k + x]
      const share = (2 * spread[j] + gap) / Math.max(used, 1e-9)
      radius[k + x] = r
      angle[k + x] = a + share * Math.PI
      ring[k + x] = ringNo
      a += share * 2 * Math.PI
    }
    if (r + spread[kids[k]] > outer) outer = r + spread[kids[k]]
    k += fit
    ringNo++
  }
  return { radius, angle, ring, outer, rings: ringNo }
}

/** The radius of the innermost ring: enough for the children that fit on one, never wider than packing them needs. */
function baseRadius(sum: number, widest: number): number {
  const single = sum / (2 * Math.PI)
  const packed = Math.sqrt((sum * widest) / Math.PI) * 0.75
  return Math.max(widest / 2, Math.min(single, Math.max(packed, widest)))
}

/**
 * The same hierarchy in 2D: depth as rings out from the root, each subtree
 * holding a wedge as wide as its share of the leaves.
 */
export function radialTree(slice: GraphSlice, p: LayoutParams, follow?: TreeFollow, rootIds?: Iterable<EntityId>): Positions {
  const h = hierarchyOf(slice, { follow, roots: rootIds })
  const n = h.nodes.length
  const out: Positions = {}
  if (!n) return out
  const spacing = Math.max(0.1, p.spacing)
  const ring = BASE * 1.1 * spacing
  // A ring has to hold every leaf at that depth; the widest one sets the scale for all of them.
  const perDepth = new Int32Array(h.maxDepth + 1)
  for (let i = 0; i < n; i++) if (h.count[i] === 0) perDepth[h.depth[i]]++
  let widest = 1
  for (let d = 0; d <= h.maxDepth; d++) if (perDepth[d] > widest) widest = perDepth[d]
  const radiusAt = (d: number) => ring * d * Math.max(1, Math.min(4, (widest * BASE * 0.25 * spacing) / Math.max(1, ring * Math.max(1, h.maxDepth))))

  // Each root gets a disc of its own; the discs are packed the way the cones are.
  const spread = new Float64Array(n)
  for (const r of h.roots) spread[r] = radiusAt(h.maxDepth) * Math.min(1, Math.max(0.2, h.leaves[r] / Math.max(1, n)))
  const spots = rootSpots(h, spread, ring)
  const from = new Float64Array(n)
  const to = new Float64Array(n)
  const stack: number[] = []
  h.roots.forEach((root, k) => {
    out[h.nodes[root].id] = { x: spots[k].x, y: spots[k].y }
    from[root] = 0
    to[root] = Math.PI * 2
    stack.push(root)
  })
  while (stack.length) {
    const i = stack.pop()!
    const kids = sortedChildren(h, i)
    if (!kids.length) continue
    const spotIndex = h.roots.indexOf(i)
    const origin = spotIndex >= 0 ? spots[spotIndex] : spots[0] ?? { x: 0, y: 0 }
    const centre = h.parent[i] < 0 ? origin : rootOf(h, i, spots)
    const total = Math.max(1, h.leaves[i])
    let a = from[i]
    for (const j of kids) {
      const share = ((to[i] - from[i]) * Math.max(1, h.leaves[j])) / total
      from[j] = a
      to[j] = a + share
      const mid = a + share / 2
      const r = radiusAt(h.depth[j])
      out[h.nodes[j].id] = { x: centre.x + Math.cos(mid) * r, y: centre.y + Math.sin(mid) * r }
      a += share
      stack.push(j)
    }
  }
  return out
}

/** The spot the node's own root sits at (rings are drawn around it). */
function rootOf(h: Hierarchy, i: number, spots: { x: number; y: number }[]): { x: number; y: number } {
  let cur = i
  while (h.parent[cur] >= 0) cur = h.parent[cur]
  const k = h.roots.indexOf(cur)
  return spots[k] ?? { x: 0, y: 0 }
}

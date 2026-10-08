import type { BitSet } from './bitset'
import type { PackedGraph } from './graph'
import { fibonacciBall, sunflower, type Dims } from './layout'
import { louvainHierarchy, type Hierarchy, type HierarchyOptions, type WeightedGraph } from './louvain'
import { mulberry32 } from './random'

/**
 * The multilevel communities layout: communities within communities, drawn as
 * balls within balls (discs within discs in 2D).
 *
 * 1. **Hierarchy** — Louvain over the CSR (`louvain.ts`): level 0 is the
 *    graph, each level above folds the communities of the one below into
 *    single nodes, until a top level of at most a few hundred connected nodes.
 * 2. **Radii, bottom up** — a node is a ball of `spacing` across; a community
 *    is a ball holding its members' volume at a packing fraction.
 * 3. **Top level** — the connected core (the top nodes with edges between
 *    them) is relaxed as below with a weak pull to the origin; the rest —
 *    components with no edge to the core, and one ball for every isolated
 *    node — goes into one ball of its own beside the core.
 * 4. **Down the levels** — each node starts inside its parent's ball (a
 *    Fibonacci lattice, the biggest and best-connected in the middle, moved
 *    towards the side where its outside neighbours are) and rounds of
 *    relaxation settle it: collisions, springs along the level's weighted
 *    edges, a pull to the parent's centre and a wall at the parent's radius,
 *    so a community never spills into its neighbour. Coarse levels, which are
 *    small, get many rounds; the finest, the whole graph, a handful — the
 *    budget follows the work.
 *
 * Collisions are between siblings only — the walls keep everyone else away —
 * and each level is renumbered so a parent's children are one run in memory:
 * a run of a few nodes checks its pairs, a longer one builds a small dense
 * grid of cells a typical node across (each pair once: the rest of the own
 * cell, then a half shell of rows), and a node much bigger than typical is
 * checked against its run. Nothing is O(n²), nothing is allocated per node,
 * and the scratch is reused across levels. Positions are x, y, z per node, as
 * everywhere in `core/packed`; z is 0 in two dimensions. Deterministic for a
 * seed. 800,000 nodes and 2,000,000 edges in 3D: ~3.4 s in Node on a loaded
 * laptop (Louvain 1.3 s, the finest level 1 s), against ~1.2 s for
 * `layoutCoarse`, whose label propagation merges such a graph into one blob.
 */

export interface MultilevelOptions extends Pick<HierarchyOptions, 'resolution' | 'topMax' | 'edgeWeight'> {
  /** Distance between neighbouring nodes, in world units (default 12). */
  spacing?: number
  dims?: Dims
  seed?: number
  /** A hierarchy already computed for this graph (the layout then costs only the placement). */
  hierarchy?: Hierarchy
  /** Rounds of relaxation at the finest level (default 3); coarser levels get more, within a budget. */
  finest?: number
}

export interface MultilevelResult {
  hierarchy: Hierarchy
  /** Each node's finest community (level 1), dense 0..K-1. */
  labels: Uint32Array
  communities: number
}

/** Packing fraction of balls in a ball (discs in a disc): how much room a community leaves around its members. */
const PACK: Record<Dims, number> = { 2: 0.62, 3: 0.52 }
/** A big node is checked against all its siblings when its parent has at most this many children (else only the big ones). */
const SIBLINGS_MAX = 4000
/** Up to this many typical nodes in a run, collisions check every pair rather than build a grid. */
const SMALL_RUN = 24

export function layoutMultilevel(g: PackedGraph, positions: Float32Array, opts: MultilevelOptions = {}, pinned?: BitSet): MultilevelResult {
  const dims: Dims = opts.dims ?? 2
  const spacing = opts.spacing ?? 12
  const seed = opts.seed ?? 1
  const finest = opts.finest ?? 3
  const h = opts.hierarchy ?? louvainHierarchy(g, { resolution: opts.resolution, topMax: opts.topMax, edgeWeight: opts.edgeWeight, seed })
  const { levels, parent } = h
  const L = levels.length - 1
  const rand = mulberry32(seed)
  const vol = (r: number) => (dims === 3 ? r * r * r : r * r)

  // ── Radii, bottom up ──
  const radius: Float32Array[] = [new Float32Array(levels[0].n).fill(spacing / 2)]
  for (let l = 0; l < L; l++) {
    const below = radius[l]
    const up = parent[l]
    const P = levels[l + 1].n
    const sum = new Float64Array(P)
    const kids = new Uint32Array(P)
    const big = new Float32Array(P)
    for (let i = 0; i < below.length; i++) {
      const r = below[i]
      sum[up[i]] += vol(r)
      kids[up[i]]++
      if (r > big[up[i]]) big[up[i]] = r
    }
    const out = new Float32Array(P)
    // One child: the same ball. Otherwise the volume at the packing fraction, never less than the biggest child.
    for (let c = 0; c < P; c++) out[c] = kids[c] <= 1 ? big[c] : Math.max(big[c], dims === 3 ? Math.cbrt(sum[c] / PACK[3]) : Math.sqrt(sum[c] / PACK[2]))
    radius.push(out)
  }

  // ── Top level: the connected core relaxed, the rest in a ball beside it ──
  const top = levels[L]
  const topRad = radius[L]
  let pos = new Float32Array(top.n * 3)
  {
    const slot = new Int32Array(top.n).fill(-1)
    const core: number[] = []
    const rest: number[] = []
    for (let i = 0; i < top.n; i++) {
      if (top.offsets[i + 1] > top.offsets[i]) {
        slot[i] = core.length
        core.push(i)
      } else rest.push(i)
    }
    let coreR = 0
    if (core.length) {
      const sub = subgraph(top, Uint32Array.from(core), slot)
      const subRad = Float32Array.from(core, (i) => topRad[i])
      const subPos = new Float32Array(core.length * 3)
      const order = sortedRun(Uint32Array.from({ length: sub.n }, (_, i) => i), sub, subRad)
      let total = 0
      for (let s = 0; s < sub.n; s++) total += vol(subRad[s])
      const outer = dims === 3 ? Math.cbrt(total / 0.3) : Math.sqrt(total / 0.4)
      for (let k = 0; k < order.length; k++) place(order[k], k, order.length, outer, 0, 0, 0, subPos, dims)
      relax(sub, subPos, subRad, null, null, null, Uint32Array.of(0, sub.n), rounds(sub, 40, 150), dims, spacing, rand)
      // Centred on its volume, so the ball of the rest sits just clear of it.
      let mx = 0, my = 0, mz = 0, mw = 0
      for (let s = 0; s < sub.n; s++) {
        const w = vol(subRad[s])
        mx += subPos[s * 3] * w
        my += subPos[s * 3 + 1] * w
        mz += subPos[s * 3 + 2] * w
        mw += w
      }
      for (let s = 0; s < sub.n; s++) {
        const i = core[s]
        pos[i * 3] = subPos[s * 3] - mx / mw
        pos[i * 3 + 1] = subPos[s * 3 + 1] - my / mw
        pos[i * 3 + 2] = dims === 3 ? subPos[s * 3 + 2] - mz / mw : 0
        coreR = Math.max(coreR, Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) + topRad[i])
      }
    }
    if (rest.length) {
      // The rest — components with no edge to the core, the ball of isolated nodes — packed into one ball of their
      // own beside the core, as a community's members are in theirs: spread around it they would set the picture's
      // extent, and a fitted camera would show the core as a dot.
      const run = sortedRun(Uint32Array.from(rest), top, topRad)
      const slotR = new Int32Array(top.n).fill(-1)
      for (let s = 0; s < run.length; s++) slotR[run[s]] = s
      const sub = subgraph(top, run, slotR)
      const subRad = Float32Array.from(run, (i) => topRad[i])
      let total = 0
      for (let s = 0; s < sub.n; s++) total += vol(subRad[s])
      const R = run.length === 1 ? subRad[0] : Math.max(subRad[0], dims === 3 ? Math.cbrt(total / PACK[3]) : Math.sqrt(total / PACK[2]))
      const centre = Float32Array.of(coreR > 0 ? coreR + R + spacing * 2 : 0, 0, 0)
      const subPos = new Float32Array(sub.n * 3)
      for (let s = 0; s < sub.n; s++) place(s, s, sub.n, sub.n === 1 ? 0 : R - subRad[s], centre[0], 0, 0, subPos, dims)
      relax(sub, subPos, subRad, new Uint32Array(sub.n), centre, Float32Array.of(R), Uint32Array.of(0, sub.n), rounds(sub, 10, 60), dims, spacing, rand)
      for (let s = 0; s < sub.n; s++) {
        const i = run[s]
        pos[i * 3] = subPos[s * 3]
        pos[i * 3 + 1] = subPos[s * 3 + 1]
        pos[i * 3 + 2] = subPos[s * 3 + 2]
      }
    }
  }

  // ── Down the levels ──
  for (let l = L - 1; l >= 0; l--) {
    const G = levels[l]
    const up = parent[l]
    const ppos = pos
    const prad = radius[l + 1]
    // Children grouped by parent (a counting sort), each run sorted biggest and best-connected first — and the level
    // renumbered in that order, so siblings are neighbours in memory as they are in space: the relaxation then reads
    // a few kilobytes per community instead of the whole level at random.
    const P = levels[l + 1].n
    const start = new Uint32Array(P + 1)
    for (let i = 0; i < G.n; i++) start[up[i] + 1]++
    for (let c = 0; c < P; c++) start[c + 1] += start[c]
    const fill = start.slice(0, P)
    const members = new Uint32Array(G.n)
    for (let i = 0; i < G.n; i++) members[fill[up[i]]++] = i
    for (let c = 0; c < P; c++) if (start[c + 1] - start[c] > 1) sortedRun(members.subarray(start[c], start[c + 1]), G, radius[l])
    const Gs = renumber(G, members)
    const rad = Float32Array.from(members, (i) => radius[l][i])
    const ups = Uint32Array.from(members, (i) => up[i])
    const next = new Float32Array(G.n * 3)
    for (let c = 0; c < P; c++) {
      const m = start[c + 1] - start[c]
      const cx = ppos[c * 3], cy = ppos[c * 3 + 1], cz = ppos[c * 3 + 2]
      for (let k = 0; k < m; k++) {
        const s = start[c] + k
        place(s, k, m, m === 1 ? 0 : prad[c] - rad[s], cx, cy, cz, next, dims)
      }
    }
    // Moved towards outside neighbours: the direction to them, as far as the node's outside share of its edges.
    const { offsets, targets, weights } = Gs
    for (let s = 0; s < G.n; s++) {
      const c = ups[s]
      const cx = ppos[c * 3], cy = ppos[c * 3 + 1], cz = ppos[c * 3 + 2]
      let vx = 0, vy = 0, vz = 0, ext = 0, all = 0
      for (let k = offsets[s], end = offsets[s + 1]; k < end; k++) {
        const w = weights[k]
        all += w
        const d = ups[targets[k]]
        if (d === c) continue
        ext += w
        vx += (ppos[d * 3] - cx) * w
        vy += (ppos[d * 3 + 1] - cy) * w
        vz += (ppos[d * 3 + 2] - cz) * w
      }
      const jitter = rad[s] * 0.2
      next[s * 3] += (rand() - 0.5) * jitter
      next[s * 3 + 1] += (rand() - 0.5) * jitter
      if (dims === 3) next[s * 3 + 2] += (rand() - 0.5) * jitter
      const len = Math.hypot(vx, vy, vz)
      if (len > 0 && all > 0) {
        const reach = (Math.max(0, prad[c] - rad[s]) * 0.6 * ext) / all / len
        next[s * 3] += vx * reach
        next[s * 3 + 1] += vy * reach
        if (dims === 3) next[s * 3 + 2] += vz * reach
      }
      contain(next, s, rad[s], ppos, c, prad[c])
    }
    const n = l === 0 ? rounds(Gs, finest, Math.max(finest, 12)) : rounds(Gs, 3, 40)
    relax(Gs, next, rad, ups, ppos, prad, start, n, dims, spacing, rand)
    // Back to the level's own numbering, which the level below reads its parents by.
    pos = new Float32Array(G.n * 3)
    for (let s = 0; s < G.n; s++) {
      const i = members[s]
      pos[i * 3] = next[s * 3]
      pos[i * 3 + 1] = next[s * 3 + 1]
      pos[i * 3 + 2] = next[s * 3 + 2]
    }
  }

  for (let i = 0; i < levels[0].n; i++) {
    if (pinned?.has(i)) continue
    positions[i * 3] = pos[i * 3]
    positions[i * 3 + 1] = pos[i * 3 + 1]
    positions[i * 3 + 2] = dims === 3 ? pos[i * 3 + 2] : 0
  }
  const labels = L >= 1 ? parent[0] : new Uint32Array(levels[0].n)
  return { hierarchy: h, labels, communities: L >= 1 ? levels[1].n : 1 }
}

/** Rounds for a level: a work budget over its size, at least `min`, at most `max`. */
function rounds(G: WeightedGraph, min: number, max: number): number {
  // ~20 candidate pairs per node from the grid plus the springs; a budget of 6e6 of those per level. The placement
  // inside the parent does most of the work: past a few rounds the picture hardly changes (measured at 200k).
  const work = G.n * 20 + G.targets.length / 2
  return Math.max(min, Math.min(max, Math.round(6e6 / Math.max(1, work))))
}

/** Sort a run of node indices biggest first, then best-connected (level 0: hubs first). Returns the run. */
function sortedRun(run: Uint32Array, G: WeightedGraph, rad: Float32Array): Uint32Array {
  const s = G.strength
  return run.sort((a, b) => rad[b] - rad[a] || s[b] - s[a] || a - b)
}

/** The k-th of m children on the lattice of a parent of radius R centred at (cx, cy, cz). */
function place(i: number, k: number, m: number, R: number, cx: number, cy: number, cz: number, out: Float32Array, dims: Dims) {
  if (dims === 3) fibonacciBall(k, m, R * 0.85, out, i)
  else sunflower(k, m, R * 0.85, out, i)
  out[i * 3] += cx
  out[i * 3 + 1] += cy
  out[i * 3 + 2] = dims === 3 ? out[i * 3 + 2] + cz : 0
}

/** Keep node i (radius r) inside its parent's ball: at most R − r from the centre. */
function contain(pos: Float32Array, i: number, r: number, ppos: Float32Array, c: number, R: number) {
  const cx = ppos[c * 3], cy = ppos[c * 3 + 1], cz = ppos[c * 3 + 2]
  const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz
  const d2 = dx * dx + dy * dy + dz * dz
  const lim = Math.max(0, R - r)
  if (d2 <= lim * lim) return
  const f = lim / Math.sqrt(d2)
  pos[i * 3] = cx + dx * f
  pos[i * 3 + 1] = cy + dy * f
  pos[i * 3 + 2] = cz + dz * f
}

/** The level restricted to `nodes` (every edge of theirs inside the set), renumbered 0..k-1 by `slot`. */
function subgraph(G: WeightedGraph, nodes: Uint32Array, slot: Int32Array): WeightedGraph {
  const k = nodes.length
  const offsets = new Uint32Array(k + 1)
  for (let s = 0; s < k; s++) offsets[s + 1] = offsets[s] + (G.offsets[nodes[s] + 1] - G.offsets[nodes[s]])
  const targets = new Uint32Array(offsets[k])
  const weights = new Float32Array(offsets[k])
  const strength = new Float64Array(k)
  const size = new Uint32Array(k)
  for (let s = 0; s < k; s++) {
    const i = nodes[s]
    let p = offsets[s]
    for (let e = G.offsets[i]; e < G.offsets[i + 1]; e++) {
      targets[p] = slot[G.targets[e]]
      weights[p++] = G.weights[e]
    }
    strength[s] = G.strength[i]
    size[s] = G.size[i]
  }
  return { n: k, offsets, targets, weights, strength, size }
}

/** The whole level renumbered: node `order[s]` becomes s. */
function renumber(G: WeightedGraph, order: Uint32Array): WeightedGraph {
  const slot = new Int32Array(G.n)
  for (let s = 0; s < order.length; s++) slot[order[s]] = s
  return subgraph(G, order, slot)
}

// Scratch shared across levels and calls: a layout of 800k nodes should not allocate its grids once per community.
let cellStart = new Uint32Array(1)
let cellOf = new Uint32Array(1)
let items = new Uint32Array(1)
let dxs = new Float32Array(1)

/**
 * Rounds of relaxation over one level, Jacobi style (every force from the same positions, then one move each). The
 * level is numbered so that each parent's children are one run, `start[c]..start[c + 1]` (the top level's core is
 * one run with no parent):
 * - collisions: two siblings closer than the sum of their radii push apart, the lighter (smaller volume) moving more.
 *   Only siblings — the parent's wall keeps everyone else away. Typical nodes (radius up to the 90th percentile)
 *   meet in a dense grid over their run, cells one typical diameter across, each pair once (the rest of the own
 *   cell, then a half shell of rows); a bigger node is checked against the whole run;
 * - springs along the level's edges, towards touching, `weight / min(strength)` strong and biased so hubs move less;
 * - a pull to the parent's centre (to the origin at the top) and, after the move, the wall at the parent's radius.
 * The springs and the pull cool linearly; a move is capped at the node's radius.
 */
function relax(G: WeightedGraph, pos: Float32Array, rad: Float32Array, up: Uint32Array | null, ppos: Float32Array | null, prad: Float32Array | null, start: Uint32Array, iterations: number, dims: Dims, spacing: number, rand: () => number) {
  const n = G.n
  if (n < 2 || iterations <= 0) return
  const { offsets, targets, weights } = G
  const is3 = dims === 3
  const groups = start.length - 1
  let maxRun = 0
  for (let c = 0; c < groups; c++) maxRun = Math.max(maxRun, start[c + 1] - start[c])
  if (dxs.length < n * 3) dxs = new Float32Array(n * 3)
  if (cellOf.length < maxRun) cellOf = new Uint32Array(maxRun)
  if (items.length < maxRun) items = new Uint32Array(maxRun)
  const maxCells = 8 * maxRun + 8
  if (cellStart.length < maxCells + 1) cellStart = new Uint32Array(maxCells + 1)
  const dx = dxs
  // Mass is volume; a node's outside strength sets its springs.
  const mass = new Float32Array(n)
  const ext = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    mass[i] = is3 ? rad[i] ** 3 : rad[i] ** 2
    let s = 0
    for (let k = offsets[i], end = offsets[i + 1]; k < end; k++) s += weights[k]
    ext[i] = s
  }
  // Typical: the 90th percentile of a sample of radii.
  const sample = new Float32Array(Math.min(n, 2048))
  for (let s = 0; s < sample.length; s++) sample[s] = rad[Math.floor((s * n) / sample.length)]
  sample.sort()
  const rCap = Math.max(spacing / 2, sample[Math.floor(sample.length * 0.9)])

  /** Push i and j apart if they overlap, the lighter one moving more. */
  const collide = (i: number, j: number) => {
    const D = rad[i] + rad[j]
    let ex = pos[j * 3] - pos[i * 3], ey = pos[j * 3 + 1] - pos[i * 3 + 1], ez = pos[j * 3 + 2] - pos[i * 3 + 2]
    let d2 = ex * ex + ey * ey + ez * ez
    if (d2 >= D * D) return
    if (d2 < 1e-9) {
      ex = (rand() - 0.5) * 1e-3
      ey = (rand() - 0.5) * 1e-3
      ez = is3 ? (rand() - 0.5) * 1e-3 : 0
      d2 = ex * ex + ey * ey + ez * ez
    }
    const d = Math.sqrt(d2)
    const push = ((D - d) / d) * 0.5
    const mi = mass[i], mj = mass[j]
    const si = (mj / (mi + mj)) * push, sj = (mi / (mi + mj)) * push
    dx[i * 3] -= ex * si
    dx[i * 3 + 1] -= ey * si
    dx[i * 3 + 2] -= ez * si
    dx[j * 3] += ex * sj
    dx[j * 3 + 1] += ey * sj
    dx[j * 3 + 2] += ez * sj
  }
  /**
   * Node i against the typical nodes `items[from..to)` — the grid's hot loop, kept in one function so a cell's run is
   * one call. Typical nodes are within a factor of the cap of each other, so the push is split by mass as above, the
   * whole of i's share gathered in locals and written once.
   */
  const collideRun = (i: number, from: number, to: number) => {
    const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2], ri = rad[i], mi = mass[i]
    let fx = 0, fy = 0, fz = 0
    for (let t = from; t < to; t++) {
      const j = items[t]
      const D = ri + rad[j]
      const ex = pos[j * 3] - xi
      if (ex > D || ex < -D) continue
      const ey = pos[j * 3 + 1] - yi
      if (ey > D || ey < -D) continue
      const ez = pos[j * 3 + 2] - zi
      const d2 = ex * ex + ey * ey + ez * ez
      if (d2 >= D * D) continue
      if (d2 < 1e-9) {
        collide(i, j)
        continue
      }
      const d = Math.sqrt(d2)
      const push = ((D - d) / d) * 0.5
      const mj = mass[j]
      const si = (mj / (mi + mj)) * push, sj = (mi / (mi + mj)) * push
      fx -= ex * si
      fy -= ey * si
      fz -= ez * si
      dx[j * 3] += ex * sj
      dx[j * 3 + 1] += ey * sj
      dx[j * 3 + 2] += ez * sj
    }
    dx[i * 3] += fx
    dx[i * 3 + 1] += fy
    dx[i * 3 + 2] += fz
  }

  for (let it = 0; it < iterations; it++) {
    const alpha = 1 - it / iterations
    dx.fill(0, 0, n * 3)
    // ── Collisions, run by run ──
    for (let c = 0; c < groups; c++) {
      const b = start[c], e = start[c + 1]
      if (e - b < 2) continue
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      let small = 0
      for (let i = b; i < e; i++) {
        if (rad[i] > rCap) {
          // A big node: against the whole run (the big ones after it, every typical one) — or, in a run too long for
          // that, against the other big ones, which a run sorted biggest first holds at its start.
          if (e - b <= SIBLINGS_MAX) {
            for (let j = b; j < e; j++) if (j !== i && (rad[j] <= rCap || j > i)) collide(i, j)
          } else for (let j = i + 1; j < e && rad[j] > rCap; j++) collide(i, j)
          continue
        }
        small++
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      if (small < 2) continue
      if (small <= SMALL_RUN) {
        // A few nodes: every pair, cheaper than a grid.
        let q = 0
        for (let i = b; i < e; i++) if (rad[i] <= rCap) items[q++] = i
        for (let t = 0; t < q - 1; t++) collideRun(items[t], t + 1, q)
        continue
      }
      // A dense grid over the run's typical nodes, cells a diameter across — wider when the run is sparse, so the
      // grid never has more than ~8 cells a node.
      let cell = 2 * rCap
      let cols = Math.floor((maxX - minX) / cell) + 1, rows = Math.floor((maxY - minY) / cell) + 1, layers = is3 ? Math.floor((maxZ - minZ) / cell) + 1 : 1
      const budget = 8 * small
      if (cols * rows * layers > budget) {
        cell *= is3 ? Math.cbrt((cols * rows * layers) / budget) : Math.sqrt((cols * rows) / budget)
        cell *= 1.0001
        cols = Math.floor((maxX - minX) / cell) + 1
        rows = Math.floor((maxY - minY) / cell) + 1
        layers = is3 ? Math.floor((maxZ - minZ) / cell) + 1 : 1
      }
      const cells = cols * rows * layers
      const inv = 1 / cell
      cellStart.fill(0, 0, cells + 1)
      for (let i = b; i < e; i++) {
        if (rad[i] > rCap) continue
        const k = ((is3 ? ((pos[i * 3 + 2] - minZ) * inv) | 0 : 0) * rows + (((pos[i * 3 + 1] - minY) * inv) | 0)) * cols + (((pos[i * 3] - minX) * inv) | 0)
        cellOf[i - b] = k
        cellStart[k + 1]++
      }
      for (let k = 0; k < cells; k++) cellStart[k + 1] += cellStart[k]
      for (let i = e - 1; i >= b; i--) if (rad[i] <= rCap) items[--cellStart[cellOf[i - b] + 1]] = i
      // Each cell's end was walked down to its start, one slot to the right: shift back.
      cellStart.copyWithin(0, 1, cells + 1)
      cellStart[cells] = small
      const plane = cols * rows
      for (let q = 0; q < small; q++) {
        const i = items[q]
        const k = cellOf[i - b]
        const gx = k % cols, gy = ((k / cols) | 0) % rows, gz = (k / plane) | 0
        // The rest of its own cell, and the next cell along the row.
        const ownEnd = cellStart[gx + 1 < cols ? k + 2 : k + 1]
        collideRun(i, q + 1, ownEnd)
        const x0 = gx > 0 ? gx - 1 : 0, x1 = gx + 1 < cols ? gx + 1 : gx
        // The next row, three cells wide.
        if (gy + 1 < rows) {
          const base = (gz * rows + gy + 1) * cols
          collideRun(i, cellStart[base + x0], cellStart[base + x1 + 1])
        }
        // The next layer: three rows of three.
        if (is3 && gz + 1 < layers) {
          for (let yy = gy > 0 ? gy - 1 : 0, y1 = gy + 1 < rows ? gy + 1 : gy; yy <= y1; yy++) {
            const base = ((gz + 1) * rows + yy) * cols
            collideRun(i, cellStart[base + x0], cellStart[base + x1 + 1])
          }
        }
      }
    }
    // ── Springs, each edge once (from its lower end) ──
    for (let i = 0; i < n; i++) {
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2]
      for (let k = offsets[i], end = offsets[i + 1]; k < end; k++) {
        const j = targets[k]
        if (j < i) continue
        const ex = pos[j * 3] - xi, ey = pos[j * 3 + 1] - yi, ez = pos[j * 3 + 2] - zi
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
        const rest = rad[i] + rad[j]
        if (d <= rest) continue
        const pull = ((d - rest) / d) * alpha * 0.5 * (weights[k] / Math.max(1e-9, Math.min(ext[i], ext[j])))
        const bias = ext[j] / (ext[i] + ext[j])
        dx[i * 3] += ex * pull * bias
        dx[i * 3 + 1] += ey * pull * bias
        dx[i * 3 + 2] += ez * pull * bias
        dx[j * 3] -= ex * pull * (1 - bias)
        dx[j * 3 + 1] -= ey * pull * (1 - bias)
        dx[j * 3 + 2] -= ez * pull * (1 - bias)
      }
    }
    // ── Move: the pull to the centre, a capped step, the wall ──
    const g = up ? 0.04 : 0.01
    for (let i = 0; i < n; i++) {
      let cx = 0, cy = 0, cz = 0
      if (up) {
        const c = up[i]
        cx = ppos![c * 3]
        cy = ppos![c * 3 + 1]
        cz = ppos![c * 3 + 2]
      }
      let mx = dx[i * 3] + (cx - pos[i * 3]) * g * alpha
      let my = dx[i * 3 + 1] + (cy - pos[i * 3 + 1]) * g * alpha
      let mz = is3 ? dx[i * 3 + 2] + (cz - pos[i * 3 + 2]) * g * alpha : 0
      const m2 = mx * mx + my * my + mz * mz
      const cap = rad[i]
      if (m2 > cap * cap) {
        const f = cap / Math.sqrt(m2)
        mx *= f
        my *= f
        mz *= f
      }
      pos[i * 3] += mx
      pos[i * 3 + 1] += my
      pos[i * 3 + 2] = is3 ? pos[i * 3 + 2] + mz : 0
      if (up) contain(pos, i, rad[i], ppos!, up[i], prad![up[i]])
    }
  }
}

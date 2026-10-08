import type { Dims } from './layout'

/**
 * The force model behind the GPU graph's live physics: one algorithm, written
 * twice — here in TypeScript (the worker, and the oracle the GPU kernels are
 * tested against) and in WGSL (`engine/physics.wgsl.ts`). Per iteration, for
 * every node that takes part (alive, not hidden):
 *
 *   repulsion   every other node pushes with the dimension's Coulomb law —
 *               strength / d² in three dimensions, strength / d in two — so
 *               a uniform ball has the same field inside as gravity to the
 *               centre and the two cancel: gravity fixes the density, the
 *               springs arrange nodes within it, and a graph of any size
 *               packs at the link length instead of ballooning. (A cutoff
 *               would be cheaper; tried, it locks nodes onto the grid's
 *               lines, because which cells count then depends on the cell a
 *               node is in.) Summed through a grid pyramid: the finest grid
 *               holds each cell's count and centroid; each coarser level
 *               sums eight children. A node reads the 3×3×3 cells around it
 *               at the finest level exactly. The rest — at each coarser
 *               level the ring between that level's 3×3×3 block and the
 *               finer one; a coarse cell fully outside the finer block
 *               counts as one centroid, one straddling it contributes its
 *               children that lie outside — is summed once per finest cell
 *               at the cell's centre, with its Jacobian, and every node
 *               blends the expansions of the nearest cell centres at its own
 *               position. Every cell of the world is counted exactly once;
 *               the work is O(N + cells); nothing is O(N²).
 *   springs     each edge pulls its ends toward `linkDistance`, weighted by
 *               1/√min(degree) so hubs do not fold everything onto them.
 *   gravity     a weak pull to the origin keeps components together.
 *
 * Integration is d3-style: velocity with damping, a displacement scaled by
 * `alpha`, which decays toward `alphaTarget` — a run cools and stops on its
 * own; a drag reheats it. Held nodes (pinned, dragged) are read, never
 * moved. The finest grid is 64³ in three dimensions and 256² in two, over a
 * box the positions fit; cell sums are fixed-point integers so the GPU can
 * accumulate them atomically.
 */

export interface PhysicsParams {
  /** Repulsion, dimensionless: the push between two nodes a link distance apart, in link distances (the strength is repulsion·linkDistance^dims). */
  repulsion: number
  /** Rest length of a link. */
  linkDistance: number
  /** Spring strength, 0–1. */
  linkStrength: number
  /** Pull toward the origin per unit of distance; against the repulsion it sets the density (see `packingSpacing`). */
  gravity: number
  /** Velocity kept per iteration, 0–1. */
  damping: number
  /** Where alpha starts; a step multiplies the displacement by it. */
  alpha: number
  alphaMin: number
  alphaDecay: number
  alphaTarget: number
  /** Cap on a node's move per iteration, in link distances. */
  maxStep: number
  /** How far down the repulsion is softened (d² + ε², ε this many link distances): below it two nodes push apart less and less. */
  softening: number
  /**
   * Each link's rest length varies by up to this share of `linkDistance`, by a hash of its two ends (`linkRest`).
   * A hub with thousands of leaves pulled them all to one length, and they packed like a crystal — rings of evenly
   * spaced dots, rows inside them; with lengths that differ a little, a cluster settles as a cloud.
   */
  linkJitter: number
  /**
   * Each link's strength varies by up to this share, by another hash of its two ends (`linkSpring`). A hub's
   * thousands of leaves spread far past the rest length, held by their springs against each other's push — a trap,
   * the same for all of them, and identical points in one trap settle in shells: rings of evenly spaced dots. A leaf
   * on a softer spring settles further out, so springs that differ break the shells and the cluster thins toward its edge.
   */
  springJitter: number
  dims: Dims
}

/**
 * The defaults, chosen by measurement (layout-quality benchmark, 2026-09-29: stress, neighbourhood preservation,
 * crossings and overlap on planted communities, grids, trees, scale-free and two real graphs, against ForceAtlas2):
 * springs at full strength and a weak gravity let a structure unfold (a grid comes out a grid — stress 0.02 where
 * 0.35 / 0.25 left it crumpled at 0.33), a softening of a tenth of a link keeps nodes from settling on each other
 * (overlap 0–5% from 7–30%), and a cooling of 0.0045 runs about 1,500 iterations — the old 0.02 froze after 342,
 * before a big graph had untangled; the GPU does 1,500 at 200,000 nodes in a couple of seconds.
 */
export const DEFAULT_PHYSICS: PhysicsParams = { repulsion: 0.2, linkDistance: 12, linkStrength: 1, gravity: 0.1, damping: 0.6, alpha: 1, alphaMin: 0.001, alphaDecay: 0.0045, alphaTarget: 0, maxStep: 3, softening: 0.1, linkJitter: 0.3, springJitter: 0.7, dims: 3 }

/**
 * How far apart, in link distances, the nodes of a settled picture sit: the density is where gravity balances the
 * repulsion (a uniform ball's field grows with the radius like gravity does), so the spacing goes as
 * (repulsion / gravity)^(1/dims) — 1.5 link distances at repulsion 0.2 and gravity 0.25, measured. What the engine
 * divides a picture's spacing by to choose a link distance that keeps the picture's extent.
 */
export function packingSpacing(p: Pick<PhysicsParams, 'repulsion' | 'gravity'>, dims: Dims): number {
  const ratio = (Math.max(1e-6, p.repulsion) / 0.2) * (0.25 / Math.max(1e-6, p.gravity))
  return 1.5 * ratio ** (1 / dims)
}

/** How many iterations a run takes to cool from `alpha` to `alphaMin` at `alphaDecay` (toward a target of 0). */
export const coolingSteps = (p: Pick<PhysicsParams, 'alpha' | 'alphaMin' | 'alphaDecay'>) => (p.alphaDecay > 0 && p.alphaDecay < 1 ? Math.ceil(Math.log(p.alphaMin / p.alpha) / Math.log(1 - p.alphaDecay)) : Infinity)

/** The decay that cools from `alpha` to `alphaMin` in `steps` iterations. */
export const decayFor = (p: Pick<PhysicsParams, 'alpha' | 'alphaMin'>, steps: number) => 1 - (p.alphaMin / p.alpha) ** (1 / Math.max(1, steps))

/** The grid: the finest level's side and the pyramid above it. */
export const GRID_SIDE_3D = 64
export const GRID_SIDE_2D = 256
/**
 * The grid moves every iteration: shifted by up to this many finest cells on each axis, by a hash of the iteration
 * (`gridShift`, the same on the CPU and the GPU). Every approximation here is anchored to the grid — a node sees the
 * nodes of the cells around it as their centroids, and each coarser ring as its cells' — so a grid that stood still
 * printed itself on a dense cluster: nodes settled in rows and columns (nearest neighbours along an axis 39% of the
 * time at 200,000 nodes, where directions at random give 22%), and a finer grid only moved the pattern to a coarser
 * level. Moved each iteration, the errors land somewhere else every time and average out.
 */
export const SHIFT_CELLS = 4

/** The grid's shift for iteration `it` as a fraction of its reach (`shiftReach`), each axis in [-1, 1). */
export function gridShift(it: number): [number, number, number] {
  return [jitter(it, 0) * 2, jitter(it, 1) * 2, jitter(it, 2) * 2]
}

/** How many finest cells the grid may move: SHIFT_CELLS, but never more than an eighth of a small grid's side. */
export const shiftReach = (side: number) => Math.min(SHIFT_CELLS, side / 8)

/**
 * The grid moved by `shift` (fractions of its reach): the box grows by the reach (half / (1 − 2·reach/side)) so every
 * node is still inside, and its centre moves by the shift. Positions are read relative to the centre everywhere
 * (`accumulate`, `repulsionAt`, the springs); gravity pulls to the origin, which does not move.
 */
export function shiftedGrid(g: GridSpec, shift: [number, number, number]): GridSpec {
  const reach = shiftReach(g.side)
  const half = g.half / (1 - (2 * reach) / g.side)
  const cell = (2 * half) / g.side
  return { ...g, half, cell, cx: shift[0] * reach * cell, cy: shift[1] * reach * cell, cz: g.dims === 3 ? shift[2] * reach * cell : 0 }
}

/** Positions are scaled to the box and accumulated as integers at this many steps per unit. */
export const FIXED = 1024
/** The repulsion is softened at short range (d² + ε² in place of d²), ε this many link distances: overlapping nodes part gently instead of exploding. */
export const SOFTENING = 0.5

export interface GridSpec {
  dims: Dims
  /** Cells per axis at level 0 (z is 1 in two dimensions). */
  side: number
  levels: number
  /** The world box: centre and half-extent (a cube). */
  cx: number
  cy: number
  cz: number
  half: number
  /** Level-0 cell size. */
  cell: number
  /** Where each level's cells start in the accumulator arrays, and its side. */
  levelStart: Uint32Array
  levelSide: Uint32Array
  cells: number
}

/** The finest side for this many nodes: about two nodes per cell, a power of two, up to the cap — a small graph does not pay for a million cells. */
export function gridSide(dims: Dims, nodeCount: number): number {
  const cap = dims === 3 ? GRID_SIDE_3D : GRID_SIDE_2D
  if (!Number.isFinite(nodeCount)) return cap
  const want = dims === 3 ? Math.cbrt(nodeCount * 2) : Math.sqrt(nodeCount * 2)
  let side = 4
  while (side < want && side < cap) side *= 2
  return side
}

/** The grid that holds these positions (alive and taking part): a cube about the origin, with a margin so a step cannot leave it. */
export function gridFor(positions: Float32Array, active: (i: number) => boolean, nodeCount: number, dims: Dims, linkDistance: number): GridSpec {
  let m = 0
  for (let i = 0; i < nodeCount; i++) {
    if (!active(i)) continue
    const x = Math.abs(positions[i * 3]), y = Math.abs(positions[i * 3 + 1]), z = dims === 3 ? Math.abs(positions[i * 3 + 2]) : 0
    // A coordinate that is not a number must not set the box: one NaN or ∞ there and every node's force is NaN next.
    if (x > m && x < Infinity) m = x
    if (y > m && y < Infinity) m = y
    if (z > m && z < Infinity) m = z
  }
  return gridAround(m, dims, linkDistance, nodeCount)
}

export function gridAround(halfExtent: number, dims: Dims, linkDistance: number, nodeCount = Infinity): GridSpec {
  const cx = 0, cy = 0, cz = 0
  const side = gridSide(dims, nodeCount)
  const levels = Math.log2(side) + 1
  const half = Math.max(halfExtent * 1.05, linkDistance * 4)
  const levelStart = new Uint32Array(levels)
  const levelSide = new Uint32Array(levels)
  let at = 0
  for (let l = 0, s = side; l < levels; l++, s >>= 1) {
    levelStart[l] = at
    levelSide[l] = s
    at += dims === 3 ? s * s * s : s * s
  }
  return { dims, side, levels, cx, cy, cz: dims === 3 ? cz : 0, half, cell: (2 * half) / side, levelStart, levelSide, cells: at }
}

/** The index of a cell at a level. */
export const cellIndex = (g: GridSpec, l: number, x: number, y: number, z: number) => g.levelStart[l] + (g.dims === 3 ? (z * g.levelSide[l] + y) * g.levelSide[l] + x : y * g.levelSide[l] + x)

/**
 * The cell sums: count, and the fixed-point sums of the scaled positions
 * (x, y, z in [-FIXED, FIXED] over the box). One Int32Array with four
 * words per cell, every level after the other.
 */
export function accumulate(g: GridSpec, positions: Float32Array, active: (i: number) => boolean, nodeCount: number, cells: Int32Array) {
  cells.fill(0)
  const scale = FIXED / g.half
  const cellScale = g.side / (2 * g.half)
  for (let i = 0; i < nodeCount; i++) {
    if (!active(i)) continue
    const x = positions[i * 3] - g.cx, y = positions[i * 3 + 1] - g.cy, z = g.dims === 3 ? positions[i * 3 + 2] - g.cz : 0
    const c = cellOf(g, x, y, z, cellScale) * 4
    cells[c]++
    cells[c + 1] += Math.round(x * scale)
    cells[c + 2] += Math.round(y * scale)
    cells[c + 3] += Math.round(z * scale)
  }
  // The pyramid: each parent the sum of its children.
  for (let l = 1; l < g.levels; l++) {
    const s = g.levelSide[l], fs = g.levelSide[l - 1]
    const zs = g.dims === 3 ? s : 1
    for (let z = 0; z < zs; z++)
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const p = cellIndex(g, l, x, y, z) * 4
          let n = 0, sx = 0, sy = 0, sz = 0
          const zc = g.dims === 3 ? 2 : 1
          for (let dz = 0; dz < zc; dz++)
            for (let dy = 0; dy < 2; dy++)
              for (let dx = 0; dx < 2; dx++) {
                const cx = x * 2 + dx, cy = y * 2 + dy, cz = z * 2 + dz
                if (cx >= fs || cy >= fs || (g.dims === 3 && cz >= fs)) continue
                const c = cellIndex(g, l - 1, cx, cy, cz) * 4
                n += cells[c]
                sx += cells[c + 1]
                sy += cells[c + 2]
                sz += cells[c + 3]
              }
          cells[p] = n
          cells[p + 1] = sx
          cells[p + 2] = sy
          cells[p + 3] = sz
        }
  }
}

/**
 * How many of its cell-mates a node is pushed by, one by one. The cells' centroids stand in for the nodes of the
 * cells around a node, and of its own cell for all the others, so nodes that share a cell did not push each other
 * apart: a dense cluster, hundreds of nodes a cell, settled wherever the springs put it — at one radius around a hub
 * (rings), or along the rays from it (spokes). Each node now takes its own cell's nodes one by one: all of them up
 * to this many, else this many in a row from a place hashed from the node and the iteration, the sum scaled by
 * how many there are (so it is right on average; the samples change every iteration).
 */
export const NEAR_SAMPLES = 16

/** Each finest cell's nodes, in a row: where a cell's run starts in `pos` (cells + 1 entries) and their positions (relative to the box centre), from `sortCells`. */
export interface CellMembers {
  start: Int32Array
  pos: Float64Array
}

/** Sort the nodes that take part by finest cell (a counting sort over the counts `accumulate` left), keeping their positions. */
export function sortCells(g: GridSpec, positions: Float32Array, active: (i: number) => boolean, nodeCount: number, cells: Int32Array, into?: CellMembers): CellMembers {
  const n0 = g.levelSide[0] ** g.dims
  const start = into && into.start.length === n0 + 1 ? into.start : new Int32Array(n0 + 1)
  const pos = into && into.pos.length >= nodeCount * 3 ? into.pos : new Float64Array(nodeCount * 3)
  let run = 0
  for (let c = 0; c < n0; c++) {
    start[c] = run
    run += cells[c * 4]
  }
  start[n0] = run
  const cursor = start.slice(0, n0)
  const cellScale = g.side / (2 * g.half)
  for (let i = 0; i < nodeCount; i++) {
    if (!active(i)) continue
    const x = positions[i * 3] - g.cx, y = positions[i * 3 + 1] - g.cy, z = g.dims === 3 ? positions[i * 3 + 2] - g.cz : 0
    const c = cellOf(g, x, y, z, cellScale)
    if (!(c >= 0 && c < n0)) continue
    const k = cursor[c]++ * 3
    pos[k] = x
    pos[k + 1] = y
    pos[k + 2] = z
  }
  return { start, pos }
}

/** The level-0 cell of a position relative to the box centre. */
export function cellOf(g: GridSpec, x: number, y: number, z: number, cellScale: number): number {
  const s = g.side
  const cx = Math.min(s - 1, Math.max(0, Math.floor((x + g.half) * cellScale)))
  const cy = Math.min(s - 1, Math.max(0, Math.floor((y + g.half) * cellScale)))
  const cz = g.dims === 3 ? Math.min(s - 1, Math.max(0, Math.floor((z + g.half) * cellScale))) : 0
  return cellIndex(g, 0, cx, cy, cz)
}

/**
 * The far field of one finest cell: the coarser levels' ring, summed at the
 * cell's centre — the force there and its Jacobian (symmetric), so a node in
 * the cell evaluates F(p) ≈ F(q) + J·(p − q): a first-order local expansion.
 * The ring keeps every far cell at least one finest cell away, so the
 * expansion is close; the near field is exact per node (`repulsionAt`).
 * Every cell of the world is counted exactly once between the two.
 *
 * Nine numbers into out[at..]: Fx Fy Fz Jxx Jyy Jzz Jxy Jxz Jyz, unscaled
 * by the strength.
 */
export const FAR_WORDS = 9

/**
 * The level whose cells carry the far field. A node walks the rings below
 * it itself (56 samples a level, scattered reads), a cell's expansion costs
 * about 340 coherent ones: the cheapest of levels 0–2 by that count — the
 * finest for a million nodes, coarser for a small graph, never coarser than
 * 2 (the expansion loses accuracy with distance from its centre).
 */
export function farLevelFor(g: GridSpec, nodeCount: number): number {
  let best = 0, bestCost = Infinity
  for (let l = 0; l <= Math.min(2, g.levels - 1); l++) {
    const s = g.levelSide[l]
    const cells = g.dims === 3 ? s * s * s : s * s
    const cost = cells * 340 + nodeCount * 56 * l * 2
    if (cost < bestCost) {
      bestCost = cost
      best = l
    }
  }
  return best
}

/** The rings of the pyramid from level `from` up, seen from (qx, qy, qz) in level-(from−1) cell coordinates (fx0, fy0, fz0): every cell beyond the 3×3×3 block of level from−1, once. */
function walkRings(g: GridSpec, from: number, fx0: number, fy0: number, fz0: number, sample: (l: number, cx: number, cy: number, cz: number) => void) {
  const three = g.dims === 3
  const zr = three ? 1 : 0
  for (let l = from; l < g.levels; l++) {
    const cx = fx0 >> 1, cy = fy0 >> 1, cz = fz0 >> 1
    for (let dz = -zr; dz <= zr; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = cx + dx, py = cy + dy, pz = cz + dz
          // The parent's children in fine coordinates: [px*2, px*2+1]; the fine block: [fx0-1, fx0+1].
          const overlapX = px * 2 + 1 >= fx0 - 1 && px * 2 <= fx0 + 1
          const overlapY = py * 2 + 1 >= fy0 - 1 && py * 2 <= fy0 + 1
          const overlapZ = !three || (pz * 2 + 1 >= fz0 - 1 && pz * 2 <= fz0 + 1)
          if (!(overlapX && overlapY && overlapZ)) sample(l, px, py, pz)
          else {
            const zc = three ? 2 : 1
            for (let kz = 0; kz < zc; kz++)
              for (let ky = 0; ky < 2; ky++)
                for (let kx = 0; kx < 2; kx++) {
                  const ax = px * 2 + kx, ay = py * 2 + ky, az = pz * 2 + kz
                  const inside = ax >= fx0 - 1 && ax <= fx0 + 1 && ay >= fy0 - 1 && ay <= fy0 + 1 && (!three || (az >= fz0 - 1 && az <= fz0 + 1))
                  if (!inside) sample(l - 1, ax, ay, az)
                }
          }
        }
    fx0 = cx
    fy0 = cy
    fz0 = cz
  }
}

export function farFieldAt(g: GridSpec, cells: Int32Array, eps2: number, level: number, c0x: number, c0y: number, c0z: number, out: Float32Array | Float64Array, at: number) {
  const three = g.dims === 3
  const invScale = g.half / FIXED
  const cell = g.cell * 2 ** level
  const qx = -g.half + (c0x + 0.5) * cell, qy = -g.half + (c0y + 0.5) * cell, qz = three ? -g.half + (c0z + 0.5) * cell : 0
  let fx = 0, fy = 0, fz = 0, jxx = 0, jyy = 0, jzz = 0, jxy = 0, jxz = 0, jyz = 0
  const sample = (l: number, cx: number, cy: number, cz: number) => {
    const s = g.levelSide[l]
    if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three && cz >= s)) return
    const c = cellIndex(g, l, cx, cy, cz) * 4
    const n = cells[c]
    if (n === 0) return
    const dx = qx - (cells[c + 1] * invScale) / n, dy = qy - (cells[c + 2] * invScale) / n, dz = three ? qz - (cells[c + 3] * invScale) / n : 0
    const d2 = dx * dx + dy * dy + dz * dz + eps2
    // Three dimensions: n·d/|d|³, Jacobian n(I/|d|³ − 3ddᵀ/|d|⁵); two: n·d/|d|², Jacobian n(I/|d|² − 2ddᵀ/|d|⁴) — |d|² softened.
    const inv = three ? n / (d2 * Math.sqrt(d2)) : n / d2
    fx += dx * inv
    fy += dy * inv
    fz += dz * inv
    const k = ((three ? 3 : 2) * inv) / d2
    jxx += inv - k * dx * dx
    jyy += inv - k * dy * dy
    jzz += inv - k * dz * dz
    jxy -= k * dx * dy
    jxz -= k * dx * dz
    jyz -= k * dy * dz
  }
  walkRings(g, level + 1, c0x, c0y, c0z, sample)
  out[at] = fx
  out[at + 1] = fy
  out[at + 2] = fz
  out[at + 3] = jxx
  out[at + 4] = jyy
  out[at + 5] = jzz
  out[at + 6] = jxy
  out[at + 7] = jxz
  out[at + 8] = jyz
}

/** The far fields of the cells of one level, computed once per step for the cells that ask. */
export class FarField {
  readonly values: Float32Array
  readonly level: number
  private readonly done: Uint8Array
  private g: GridSpec
  private cells: Int32Array
  constructor(g: GridSpec, cells: Int32Array, level = 0) {
    this.g = g
    this.cells = cells
    this.level = level
    const s = g.levelSide[level]
    const n = g.dims === 3 ? s * s * s : s * s
    this.values = new Float32Array(n * FAR_WORDS)
    this.done = new Uint8Array(n)
  }
  /** Forget every cell: the next step, same grid shape, new sums. */
  reset(g: GridSpec, cells: Int32Array, level: number): FarField {
    if (g.side !== this.g.side || g.dims !== this.g.dims || level !== this.level) return new FarField(g, cells, level)
    this.g = g
    this.cells = cells
    this.done.fill(0)
    return this
  }
  /** The offset into `values` of this cell's expansion (cell coordinates at the field's level). */
  at(cx: number, cy: number, cz: number, eps2: number): number {
    const s = this.g.levelSide[this.level]
    const c = this.g.dims === 3 ? (cz * s + cy) * s + cx : cy * s + cx
    if (!this.done[c]) {
      farFieldAt(this.g, this.cells, eps2, this.level, cx, cy, cz, this.values, c * FAR_WORDS)
      this.done[c] = 1
    }
    return c * FAR_WORDS
  }
}

/**
 * The repulsion on one node, into out[0..2]: the 3×3×3 finest cells around
 * it exactly (its own cell without itself), the rings up to the far field's
 * level as point sums, the rest through the far field's expansions.
 */
export function repulsionAt(g: GridSpec, cells: Int32Array, far: FarField, eps2: number, x: number, y: number, z: number, out: Float64Array, strength: number, near?: { members: CellMembers; node: number; seed: number }) {
  let fx = 0, fy = 0, fz = 0
  const three = g.dims === 3
  const invScale = g.half / FIXED
  const cellScale = g.side / (2 * g.half)
  const c0x = Math.min(g.side - 1, Math.max(0, Math.floor((x + g.half) * cellScale)))
  const c0y = Math.min(g.side - 1, Math.max(0, Math.floor((y + g.half) * cellScale)))
  const c0z = three ? Math.min(g.side - 1, Math.max(0, Math.floor((z + g.half) * cellScale))) : 0
  const sample = (l: number, cx: number, cy: number, cz: number, own: boolean) => {
    const s = g.levelSide[l]
    if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three && cz >= s)) return
    const c = cellIndex(g, l, cx, cy, cz) * 4
    let n = cells[c]
    if (n === 0) return
    // The node's own cell, one by one (see NEAR_SAMPLES); itself is among them, at no distance, and adds nothing.
    if (own && near) {
      const s0 = near.members.start[c / 4], P = near.members.pos
      const take = Math.min(n, NEAR_SAMPLES), w = n / take
      const o = n > take ? Math.min(n - 1, Math.floor((jitter(near.node, near.seed) + 0.5) * n)) : 0
      for (let k = 0; k < take; k++) {
        const m = (s0 + ((o + k) % n)) * 3
        const ddx = x - P[m], ddy = y - P[m + 1], ddz = three ? z - P[m + 2] : 0
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz + eps2
        const f = (three ? 1 / (d2 * Math.sqrt(d2)) : 1 / d2) * w
        fx += ddx * f
        fy += ddy * f
        fz += ddz * f
      }
      return
    }
    let mx = cells[c + 1] * invScale, my = cells[c + 2] * invScale, mz = cells[c + 3] * invScale
    if (own) {
      n -= 1
      if (n <= 0) return
      mx -= x
      my -= y
      mz -= z
    }
    const ddx = x - mx / n, ddy = y - my / n, ddz = three ? z - mz / n : 0
    const d2 = ddx * ddx + ddy * ddy + ddz * ddz + eps2
    const f = three ? n / (d2 * Math.sqrt(d2)) : n / d2
    fx += ddx * f
    fy += ddy * f
    fz += ddz * f
  }
  const zr = three ? 1 : 0
  for (let dz = -zr; dz <= zr; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sample(0, c0x + dx, c0y + dy, c0z + dz, dx === 0 && dy === 0 && dz === 0)
  // The rings the far field does not hold, as point sums at the node.
  const L = far.level
  if (L > 0) {
    const stop = { ...g, levels: L + 1 }
    walkRings(stop, 1, c0x, c0y, c0z, (l, cx, cy, cz) => sample(l, cx, cy, cz, false))
  }
  // The far field: the expansions of the nearest cell centres at its level (four, eight in three dimensions),
  // each carried to the node, blended by the node's position between them — continuous across cell
  // boundaries, so nothing settles on the grid's lines.
  const v = far.values
  const cell = g.cell * 2 ** L
  const side = g.levelSide[L]
  const fx_ = (x + g.half) / cell - 0.5, fy_ = (y + g.half) / cell - 0.5, fz_ = three ? (z + g.half) / cell - 0.5 : 0
  const bx = Math.floor(fx_), by = Math.floor(fy_), bz = three ? Math.floor(fz_) : 0
  const tx = fx_ - bx, ty = fy_ - by, tz = three ? fz_ - bz : 0
  const zc = three ? 2 : 1
  for (let kz = 0; kz < zc; kz++)
    for (let ky = 0; ky < 2; ky++)
      for (let kx = 0; kx < 2; kx++) {
        const w = (kx ? tx : 1 - tx) * (ky ? ty : 1 - ty) * (three ? (kz ? tz : 1 - tz) : 1)
        if (w === 0) continue
        const cx = Math.min(side - 1, Math.max(0, bx + kx)), cy = Math.min(side - 1, Math.max(0, by + ky)), cz = three ? Math.min(side - 1, Math.max(0, bz + kz)) : 0
        const a = far.at(cx, cy, cz, eps2)
        const ox = x - (-g.half + (cx + 0.5) * cell), oy = y - (-g.half + (cy + 0.5) * cell), oz = three ? z - (-g.half + (cz + 0.5) * cell) : 0
        fx += w * (v[a] + v[a + 3] * ox + v[a + 6] * oy + v[a + 7] * oz)
        fy += w * (v[a + 1] + v[a + 6] * ox + v[a + 4] * oy + v[a + 8] * oz)
        if (three) fz += w * (v[a + 2] + v[a + 7] * ox + v[a + 8] * oy + v[a + 5] * oz)
      }
  out[0] = fx * strength
  out[1] = fy * strength
  out[2] = fz * strength
}

/** A small deterministic offset in [-0.5, 0.5) for node `i`, axis `k` — where a node with no valid position restarts. */
export function jitter(i: number, k: number): number {
  let h = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  return h / 4294967296 - 0.5
}

/**
 * Where a node starts sampling its cell-mates this iteration (NEAR_SAMPLES) is hashed with this seed: from the bits of
 * the iteration's grid shift as the GPU gets them (float32), so both agree.
 */
export function nearSeed(shift: [number, number, number]): number {
  const u = new Uint32Array(new Float32Array([shift[0], shift[1]]).buffer)
  return (u[0] ^ u[1] ^ 0x5bd1e995) >>> 0
}

/** A link's rest length: `linkDistance` times 1 ± up to `linkJitter`, the same for either end and on the GPU. */
export function linkRest(p: Pick<PhysicsParams, 'linkDistance' | 'linkJitter'>, i: number, j: number): number {
  const a = Math.min(i, j), b = Math.max(i, j)
  return p.linkDistance * (1 + (p.linkJitter ?? 0) * 2 * jitter(a, b))
}

/** A link's strength factor: 1 ± up to `springJitter`, the same for either end and on the GPU. */
export function linkSpring(p: Pick<PhysicsParams, 'springJitter'>, i: number, j: number): number {
  const a = Math.min(i, j), b = Math.max(i, j)
  return 1 + (p.springJitter ?? 0) * 2 * jitter(b, a)
}

/** The state of a simulation on the CPU: what the worker keeps between steps. */
export class PhysicsSim {
  readonly nodeCount: number
  readonly offsets: Uint32Array
  readonly neighbors: Uint32Array
  positions: Float32Array
  readonly velocity: Float32Array
  /** Per node: bit 0 takes part (alive, shown), bit 1 held (pinned or dragged). */
  readonly state: Uint8Array
  params: PhysicsParams
  alpha: number
  /** Iterations run so far: what the grid's shift is hashed from (`gridShift`). */
  iterations = 0
  grid: GridSpec | null = null
  private cells: Int32Array | null = null
  private far: FarField | null = null
  private members: CellMembers | undefined
  private force = new Float64Array(3)

  constructor(nodeCount: number, offsets: Uint32Array, neighbors: Uint32Array, positions: Float32Array, params: PhysicsParams) {
    this.nodeCount = nodeCount
    this.offsets = offsets
    this.neighbors = neighbors
    this.positions = positions
    this.velocity = new Float32Array(nodeCount * 3)
    this.state = new Uint8Array(nodeCount).fill(1)
    this.params = params
    this.alpha = params.alpha
  }

  /** Whether the run has cooled to a stop. */
  get cooled(): boolean {
    return this.alpha < this.params.alphaMin
  }

  reheat(alpha = this.params.alpha) {
    this.alpha = Math.max(this.alpha, alpha)
  }

  /** Run up to `iterations` iterations (fewer once cooled); returns how many ran. */
  step(iterations = 1): number {
    const p = this.params
    const N = this.nodeCount
    const pos = this.positions
    const vel = this.velocity
    const st = this.state
    const three = p.dims === 3
    const active = (i: number) => (st[i] & 1) !== 0
    let done = 0
    for (let it = 0; it < iterations; it++) {
      if (this.cooled) break
      done++
      const shift = gridShift(this.iterations++)
      const g = shiftedGrid(gridFor(pos, active, N, p.dims, p.linkDistance), shift)
      this.grid = g
      if (!this.cells || this.cells.length < g.cells * 4) this.cells = new Int32Array(g.cells * 4)
      accumulate(g, pos, active, N, this.cells)
      const cells = this.cells
      const near = { members: (this.members = sortCells(g, pos, active, N, cells, this.members)), node: 0, seed: nearSeed(shift) }
      const farLevel = farLevelFor(g, N)
      const far = (this.far = this.far ? this.far.reset(g, cells, farLevel) : new FarField(g, cells, farLevel))
      const f = this.force
      const maxStep = p.maxStep * p.linkDistance
      const strength = p.repulsion * p.linkDistance ** p.dims
      const eps2 = ((p.softening ?? SOFTENING) * p.linkDistance) ** 2
      for (let i = 0; i < N; i++) {
        if (!active(i) || st[i] & 2) continue
        // A node that is somewhere impossible (NaN or ∞, from a caller or a bad step) starts again near the centre,
        // still: it would otherwise be skipped by the grid and never come back.
        if (!(Number.isFinite(pos[i * 3]) && Number.isFinite(pos[i * 3 + 1]) && (!three || Number.isFinite(pos[i * 3 + 2])))) {
          pos[i * 3] = jitter(i, 0) * p.linkDistance
          pos[i * 3 + 1] = jitter(i, 1) * p.linkDistance
          pos[i * 3 + 2] = three ? jitter(i, 2) * p.linkDistance : 0
          vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0
          continue
        }
        const x = pos[i * 3] - g.cx, y = pos[i * 3 + 1] - g.cy, z = three ? pos[i * 3 + 2] - g.cz : 0
        near.node = i
        repulsionAt(g, cells, far, eps2, x, y, z, f, strength, near)
        let fx = f[0], fy = f[1], fz = f[2]
        // Springs.
        const deg = this.offsets[i + 1] - this.offsets[i]
        for (let k = this.offsets[i]; k < this.offsets[i + 1]; k++) {
          const j = this.neighbors[k]
          if (!active(j)) continue
          const dx = pos[j * 3] - g.cx - x, dy = pos[j * 3 + 1] - g.cy - y, dz = three ? pos[j * 3 + 2] - g.cz - z : 0
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6
          const degJ = this.offsets[j + 1] - this.offsets[j]
          const w = (p.linkStrength * linkSpring(p, i, j)) / Math.sqrt(Math.min(deg, degJ))
          const k2 = ((d - linkRest(p, i, j)) * w) / d
          fx += dx * k2
          fy += dy * k2
          fz += dz * k2
        }
        // Gravity toward the origin (not the box centre).
        fx -= (x + g.cx) * p.gravity
        fy -= (y + g.cy) * p.gravity
        if (three) fz -= (z + g.cz) * p.gravity
        let vx = (vel[i * 3] + fx) * p.damping, vy = (vel[i * 3 + 1] + fy) * p.damping, vz = three ? (vel[i * 3 + 2] + fz) * p.damping : 0
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
        // A force that is not a number moves nothing, and is forgotten: a node stays where it was rather than
        // carrying NaN into the next step's box, where it would reach every node.
        if (!Number.isFinite(speed)) {
          vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0
          continue
        }
        if (speed > maxStep) {
          const s = maxStep / speed
          vx *= s
          vy *= s
          vz *= s
        }
        vel[i * 3] = vx
        vel[i * 3 + 1] = vy
        vel[i * 3 + 2] = vz
        pos[i * 3] += vx * this.alpha
        pos[i * 3 + 1] += vy * this.alpha
        if (three) pos[i * 3 + 2] += vz * this.alpha
      }
      this.alpha += (p.alphaTarget - this.alpha) * p.alphaDecay
    }
    return done
  }
}

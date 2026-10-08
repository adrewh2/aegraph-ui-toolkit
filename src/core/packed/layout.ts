import type { BitSet } from './bitset'
import type { PackedGraph } from './graph'
import { mulberry32 } from './random'

/**
 * Layouts over packed positions (x, y, z interleaved in one Float32Array;
 * z stays 0 in two dimensions), each
 * O(V + E) or bounded to a subset: a picture for two hundred thousand nodes
 * has to exist in milliseconds, not after a force run. `coarse` is the
 * multilevel one — communities by label propagation, communities on a
 * spiral, members in a disc around their centre with the hubs inside —
 * and `localForce` refines a subset (a selection, a neighbourhood) with a
 * real force model, grid-accelerated, without touching the rest.
 */

/** The k-th of n points on a Vogel (sunflower) spiral filling a disc of `radius`, written to out[at*3..] (z = 0). */
export function sunflower(k: number, n: number, radius: number, out: Float32Array, at: number) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const r = radius * Math.sqrt((k + 0.5) / Math.max(1, n))
  const a = k * golden
  out[at * 3] = r * Math.cos(a)
  out[at * 3 + 1] = r * Math.sin(a)
  out[at * 3 + 2] = 0
}

/** The k-th of n points filling a ball of `radius` evenly (a Fibonacci lattice in radius and direction). */
export function fibonacciBall(k: number, n: number, radius: number, out: Float32Array, at: number) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const r = radius * Math.cbrt((k + 0.5) / Math.max(1, n))
  const y = 1 - (2 * (k + 0.5)) / Math.max(1, n)
  const ring = Math.sqrt(Math.max(0, 1 - y * y))
  const a = k * golden
  out[at * 3] = r * ring * Math.cos(a)
  out[at * 3 + 1] = r * y
  out[at * 3 + 2] = r * ring * Math.sin(a)
}

export type Dims = 2 | 3

export function layoutRandom(count: number, positions: Float32Array, spread: number, seed = 1, dims: Dims = 2) {
  const rand = mulberry32(seed)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rand() - 0.5) * spread
    positions[i * 3 + 1] = (rand() - 0.5) * spread
    positions[i * 3 + 2] = dims === 3 ? (rand() - 0.5) * spread : 0
  }
}

/** A square grid, or in three dimensions a cube. */
export function layoutGrid(count: number, positions: Float32Array, spacing: number, dims: Dims = 2) {
  if (dims === 3) {
    const side = Math.max(1, Math.ceil(Math.cbrt(count)))
    const o = ((side - 1) * spacing) / 2
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (i % side) * spacing - o
      positions[i * 3 + 1] = (Math.floor(i / side) % side) * spacing - o
      positions[i * 3 + 2] = Math.floor(i / (side * side)) * spacing - o
    }
    return
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const ox = ((cols - 1) * spacing) / 2
  const oy = ((Math.ceil(count / cols) - 1) * spacing) / 2
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (i % cols) * spacing - ox
    positions[i * 3 + 1] = Math.floor(i / cols) * spacing - oy
    positions[i * 3 + 2] = 0
  }
}

/** A circle, or in three dimensions a sphere shell. */
export function layoutCircle(count: number, positions: Float32Array, spacing: number, dims: Dims = 2) {
  if (dims === 3) {
    const r = Math.max(spacing, Math.sqrt((count * spacing * spacing) / (4 * Math.PI)))
    for (let i = 0; i < count; i++) {
      fibonacciBall(i, count, 1, positions, i)
      // On the shell, not in the ball: normalise the direction.
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
      const len = Math.hypot(x, y, z) || 1
      positions[i * 3] = (x / len) * r
      positions[i * 3 + 1] = (y / len) * r
      positions[i * 3 + 2] = (z / len) * r
    }
    return
  }
  const r = Math.max(spacing, (count * spacing) / (2 * Math.PI))
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count)) * Math.PI * 2
    positions[i * 3] = r * Math.cos(a)
    positions[i * 3 + 1] = r * Math.sin(a)
    positions[i * 3 + 2] = 0
  }
}

/**
 * Communities by asynchronous label propagation over the CSR: each pass gives every node the label most of its
 * neighbours carry. Returns dense labels 0..K-1 (K in `.communities`). Scratch arrays only; no per-node objects.
 */
export function labelPropagation(g: PackedGraph, iterations = 6, seed = 1): { labels: Uint32Array; communities: number } {
  const N = g.nodeCount
  const label = new Uint32Array(N)
  for (let i = 0; i < N; i++) label[i] = i
  const count = new Uint32Array(N)
  const touched = new Uint32Array(N)
  const order = new Uint32Array(N)
  for (let i = 0; i < N; i++) order[i] = i
  const rand = mulberry32(seed)
  for (let it = 0; it < iterations; it++) {
    // A shuffled order each pass keeps the propagation from marching in index order.
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = order[i]
      order[i] = order[j]
      order[j] = t
    }
    let changed = 0
    // Straight over the CSR when it is the whole adjacency (no closure per node); through the walk otherwise.
    const exact = g.csrIsExact()
    const offsets = g.offsets, neighbors = g.neighbors
    for (let oi = 0; oi < N; oi++) {
      const i = order[oi]
      if (!g.nodeAlive.has(i)) continue
      let nt = 0
      let best = label[i]
      let bestCount = 0
      if (exact) {
        for (let k = offsets[i], end = offsets[i + 1]; k < end; k++) {
          const l = label[neighbors[k]]
          if (count[l] === 0) touched[nt++] = l
          const c = ++count[l]
          if (c > bestCount || (c === bestCount && l < best)) {
            bestCount = c
            best = l
          }
        }
      } else {
        g.forEachIncident(i, (_e, other) => {
          const l = label[other]
          if (count[l] === 0) touched[nt++] = l
          const c = ++count[l]
          if (c > bestCount || (c === bestCount && l < best)) {
            bestCount = c
            best = l
          }
        })
      }
      for (let k = 0; k < nt; k++) count[touched[k]] = 0
      if (best !== label[i]) {
        label[i] = best
        changed++
      }
    }
    if (changed === 0) break
  }
  // Renumber to dense codes, biggest community first; the isolated nodes (no edges, so their own label each) share
  // one community at the end, so a layout groups them instead of scattering singletons everywhere.
  const size = new Uint32Array(N)
  let isolated = 0
  for (let i = 0; i < N; i++) {
    if (!g.nodeAlive.has(i)) continue
    if (g.degree[i] === 0) isolated++
    else size[label[i]]++
  }
  const roots: number[] = []
  for (let i = 0; i < N; i++) if (size[i]) roots.push(i)
  roots.sort((a, b) => size[b] - size[a])
  const dense = new Uint32Array(N)
  for (let k = 0; k < roots.length; k++) dense[roots[k]] = k
  const out = new Uint32Array(N)
  const last = roots.length
  for (let i = 0; i < N; i++) out[i] = g.degree[i] === 0 ? last : dense[label[i]]
  return { labels: out, communities: roots.length + (isolated ? 1 : 0) }
}

export interface CoarseOptions {
  /** Known communities; computed by label propagation when absent. */
  communities?: { labels: Uint32Array; communities: number }
  /** Distance between neighbouring nodes inside a community, in world units (default 12). */
  spacing?: number
  seed?: number
  dims?: Dims
}

/**
 * Multilevel placement: each community is a disc whose radius follows its size; the discs sit on a sunflower spiral
 * (big ones first, near the centre); inside a disc the members sit on their own spiral by degree, hubs in the middle,
 * with a little jitter so runs of equal degree do not form rings. Everything O(V + E); pinned nodes keep their place.
 */
export function layoutCoarse(g: PackedGraph, positions: Float32Array, opts: CoarseOptions = {}, pinned?: BitSet): { labels: Uint32Array; communities: number } {
  const N = g.nodeCount
  const spacing = opts.spacing ?? 12
  const comm = opts.communities ?? labelPropagation(g, 6, opts.seed ?? 1)
  const K = comm.communities
  const labels = comm.labels
  const sizes = new Uint32Array(K)
  for (let i = 0; i < N; i++) if (g.nodeAlive.has(i)) sizes[labels[i]]++
  // Members of each community, hubs first: a counting sort by community, then a sort of each run by degree.
  const start = new Uint32Array(K + 1)
  for (let c = 0; c < K; c++) start[c + 1] = start[c] + sizes[c]
  const fill = new Uint32Array(K)
  const members = new Uint32Array(N)
  for (let i = 0; i < N; i++) {
    if (!g.nodeAlive.has(i)) continue
    const c = labels[i]
    members[start[c] + fill[c]++] = i
  }
  const degree = g.degree
  for (let c = 0; c < K; c++) {
    const run = members.subarray(start[c], start[c + 1])
    if (run.length > 1) run.sort((a, b) => degree[b] - degree[a])
  }
  const dims = opts.dims ?? 2
  // Disc radii: a sunflower of n points at `spacing` apart needs radius ≈ spacing·√n/1.8 (a ball: ∛n).
  const radii = new Float32Array(K)
  let sumArea = 0
  for (let c = 0; c < K; c++) {
    radii[c] = (dims === 3 ? Math.max(spacing, spacing * Math.cbrt(sizes[c]) * 0.8) : Math.max(spacing, (spacing * Math.sqrt(sizes[c])) / 1.8)) + spacing
    sumArea += dims === 3 ? radii[c] ** 3 : radii[c] * radii[c]
  }
  // Discs on a spiral (balls in a ball) of a radius that leaves them room, at ~45% packing.
  const outer = dims === 3 ? Math.cbrt(sumArea / 0.45) : Math.sqrt(sumArea / 0.45)
  const centre = new Float32Array(3)
  const rand = mulberry32(opts.seed ?? 1)
  const jitter = spacing * 0.5
  for (let c = 0; c < K; c++) {
    if (dims === 3) fibonacciBall(c, K, outer, centre, 0)
    else sunflower(c, K, outer, centre, 0)
    const cx = centre[0], cy = centre[1], cz = centre[2]
    const n = sizes[c]
    const r = radii[c] - spacing
    for (let k = 0; k < n; k++) {
      const i = members[start[c] + k]
      if (pinned?.has(i)) continue
      if (dims === 3) fibonacciBall(k, n, r, positions, i)
      else sunflower(k, n, r, positions, i)
      positions[i * 3] += cx + (rand() - 0.5) * jitter
      positions[i * 3 + 1] += cy + (rand() - 0.5) * jitter
      positions[i * 3 + 2] += dims === 3 ? cz + (rand() - 0.5) * jitter : 0
    }
  }
  return comm
}

export interface LocalForceOptions {
  dims?: Dims
  iterations?: number
  /** Ideal edge length in world units (default 30). */
  spacing?: number
  /** Nodes that do not move. */
  pinned?: BitSet
  seed?: number
}

/**
 * Fruchterman–Reingold over `subset` only: repulsion among the subset through a uniform grid (cells of one
 * repulsion radius, so each node looks at its neighbours' cells), attraction along edges with both ends in the
 * subset, a cooling step. The rest of the graph is untouched, so a selection or a neighbourhood can be relaxed
 * in place. Meant for subsets up to some tens of thousands; the cost is iterations × (subset + its edges).
 */
export function localForce(g: PackedGraph, positions: Float32Array, subset: Uint32Array, opts: LocalForceOptions = {}) {
  const n = subset.length
  if (n < 2) return
  const dims = opts.dims ?? 2
  const iterations = opts.iterations ?? 60
  const k = opts.spacing ?? 30
  const pinned = opts.pinned
  const slot = new Int32Array(g.nodeCount).fill(-1)
  for (let s = 0; s < n; s++) slot[subset[s]] = s
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n), dx = new Float32Array(n), dy = new Float32Array(n), dz = new Float32Array(n)
  const rand = mulberry32(opts.seed ?? 1)
  for (let s = 0; s < n; s++) {
    const i = subset[s]
    px[s] = positions[i * 3]
    py[s] = positions[i * 3 + 1]
    pz[s] = dims === 3 ? positions[i * 3 + 2] : 0
    // Two nodes on the same spot would never separate: nudge.
    if (!pinned?.has(i)) {
      px[s] += (rand() - 0.5) * 1e-3
      py[s] += (rand() - 0.5) * 1e-3
      if (dims === 3) pz[s] += (rand() - 0.5) * 1e-3
    }
  }
  const cutoff = k * 3
  const cell = cutoff
  // Grid scratch, rebuilt each iteration (counting sort, O(n)); in three dimensions the grid has layers.
  let cellStart = new Uint32Array(1)
  const items = new Uint32Array(n)
  const cellOfNode = new Uint32Array(n)
  let temperature = k * Math.sqrt(n) * 0.1
  const cool = temperature / (iterations + 1)
  const maxSide = dims === 3 ? 128 : 2048
  for (let it = 0; it < iterations; it++) {
    dx.fill(0)
    dy.fill(0)
    dz.fill(0)
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let s = 0; s < n; s++) {
      if (px[s] < minX) minX = px[s]
      if (px[s] > maxX) maxX = px[s]
      if (py[s] < minY) minY = py[s]
      if (py[s] > maxY) maxY = py[s]
      if (pz[s] < minZ) minZ = pz[s]
      if (pz[s] > maxZ) maxZ = pz[s]
    }
    const cols = Math.min(maxSide, Math.floor((maxX - minX) / cell) + 1)
    const rows = Math.min(maxSide, Math.floor((maxY - minY) / cell) + 1)
    const layers = dims === 3 ? Math.min(maxSide, Math.floor((maxZ - minZ) / cell) + 1) : 1
    const cw = Math.max((maxX - minX) / cols, cell), ch = Math.max((maxY - minY) / rows, cell), cd = Math.max((maxZ - minZ) / layers, cell)
    const cells = cols * rows * layers
    if (cellStart.length < cells + 1) cellStart = new Uint32Array(cells + 1)
    else cellStart.fill(0, 0, cells + 1)
    for (let s = 0; s < n; s++) {
      const cx = Math.min(cols - 1, Math.floor((px[s] - minX) / cw)), cy = Math.min(rows - 1, Math.floor((py[s] - minY) / ch)), cz = Math.min(layers - 1, Math.floor((pz[s] - minZ) / cd))
      const c = (cz * rows + cy) * cols + cx
      cellOfNode[s] = c
      cellStart[c + 1]++
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c]
    const fill = new Uint32Array(cells)
    for (let s = 0; s < n; s++) {
      const c = cellOfNode[s]
      items[cellStart[c] + fill[c]++] = s
    }
    // Repulsion: k² / d, over the neighbouring cells.
    const k2 = k * k
    const cutoff2 = cutoff * cutoff
    for (let s = 0; s < n; s++) {
      const c = cellOfNode[s]
      const cx = c % cols, cy = Math.floor(c / cols) % rows, cz = Math.floor(c / (cols * rows))
      for (let oz = dims === 3 ? -1 : 0; oz <= (dims === 3 ? 1 : 0); oz++) {
        const zz = cz + oz
        if (zz < 0 || zz >= layers) continue
        for (let oy = -1; oy <= 1; oy++) {
          const yy = cy + oy
          if (yy < 0 || yy >= rows) continue
          for (let ox = -1; ox <= 1; ox++) {
            const xx = cx + ox
            if (xx < 0 || xx >= cols) continue
            const cc = (zz * rows + yy) * cols + xx
            const end = cellStart[cc + 1]
            for (let q = cellStart[cc]; q < end; q++) {
              const t = items[q]
              if (t === s) continue
              let ddx = px[s] - px[t], ddy = py[s] - py[t], ddz = pz[s] - pz[t]
              let d2 = ddx * ddx + ddy * ddy + ddz * ddz
              if (d2 > cutoff2) continue
              if (d2 < 1e-6) {
                ddx = rand() - 0.5
                ddy = rand() - 0.5
                ddz = dims === 3 ? rand() - 0.5 : 0
                d2 = ddx * ddx + ddy * ddy + ddz * ddz
              }
              const f = k2 / d2
              dx[s] += ddx * f
              dy[s] += ddy * f
              dz[s] += ddz * f
            }
          }
        }
      }
    }
    // Attraction: d² / k along edges inside the subset.
    for (let s = 0; s < n; s++) {
      const i = subset[s]
      g.forEachIncident(i, (_e, other) => {
        const t = slot[other]
        if (t < 0 || t <= s) return
        const ddx = px[t] - px[s], ddy = py[t] - py[s], ddz = pz[t] - pz[s]
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
        if (d < 1e-6) return
        const f = d / k
        const fx = ddx * f, fy = ddy * f, fz = ddz * f
        dx[s] += fx
        dy[s] += fy
        dz[s] += fz
        dx[t] -= fx
        dy[t] -= fy
        dz[t] -= fz
      })
    }
    for (let s = 0; s < n; s++) {
      if (pinned?.has(subset[s])) continue
      const d = Math.sqrt(dx[s] * dx[s] + dy[s] * dy[s] + dz[s] * dz[s])
      if (d < 1e-9) continue
      const step = Math.min(d, temperature) / d
      px[s] += dx[s] * step
      py[s] += dy[s] * step
      if (dims === 3) pz[s] += dz[s] * step
    }
    temperature = Math.max(cool, temperature - cool)
  }
  for (let s = 0; s < n; s++) {
    const i = subset[s]
    if (pinned?.has(i)) continue
    positions[i * 3] = px[s]
    positions[i * 3 + 1] = py[s]
    positions[i * 3 + 2] = dims === 3 ? pz[s] : positions[i * 3 + 2]
  }
}

/** The box around the positions of `count` nodes (alive ones when a set is given), or null. */
export function extent(positions: Float32Array, count: number, alive?: BitSet | null, stride = 3): { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number; maxR: number } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  // With a fourth float per node (the engine's x, y, z, r) the largest radius comes along: a fit of one node wants it.
  let maxR = 0
  for (let i = 0; i < count; i++) {
    if (alive && !alive.has(i)) continue
    const x = positions[i * stride], y = positions[i * stride + 1], z = positions[i * stride + 2]
    if (stride >= 4 && positions[i * stride + 3] > maxR) maxR = positions[i * stride + 3]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY, minZ, maxZ, maxR } : null
}

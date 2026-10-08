import { BASE, type Positions } from '../layouts'
import type { EngineFn } from '../layoutEngines'

/**
 * Spectral layout: coordinates from the leading non-trivial eigenvectors of
 * the normalised adjacency (the smallest of the normalised Laplacian). Nodes
 * that share many neighbours land together; bridges show as gaps.
 * Deterministic, no dependencies. Everything outside the largest connected
 * component is placed on a ring around it.
 */
const run: EngineFn = (_algorithm, { slice, params }) => {
  const dims = params.dimensions
  const n = slice.nodes.length
  const index = new Map(slice.nodes.map((v, i) => [v.id, i]))
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const e of slice.edges) {
    const a = index.get(e.source.id)
    const b = index.get(e.target.id)
    if (a === undefined || b === undefined || a === b) continue
    adj[a].push(b)
    adj[b].push(a)
  }
  const deg = adj.map((l) => l.length)
  // Connected components: the largest gets the spectrum, the rest ring it.
  const comp = new Int32Array(n).fill(-1)
  let comps = 0
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue
    const stack = [s]
    comp[s] = comps
    while (stack.length) {
      const v = stack.pop()!
      for (const w of adj[v]) {
        if (comp[w] < 0) {
          comp[w] = comps
          stack.push(w)
        }
      }
    }
    comps++
  }
  const sizes = new Array<number>(comps).fill(0)
  for (let i = 0; i < n; i++) sizes[comp[i]]++
  let main = 0
  for (let c = 1; c < comps; c++) if (sizes[c] > sizes[main]) main = c
  const members: number[] = []
  for (let i = 0; i < n; i++) if (comp[i] === main) members.push(i)
  const m = members.length
  const local = new Int32Array(n).fill(-1)
  members.forEach((v, i) => (local[v] = i))

  // Power iteration on the normalised adjacency D^-1/2 (A + I) D^-1/2 — the self-weight keeps bipartite structure
  // from oscillating — deflating the trivial eigenvector sqrt(d) and each vector found before it.
  const k = dims === 3 ? 3 : 2
  const invSqrt = members.map((v) => 1 / Math.sqrt(deg[v] + 1))
  const trivial = normalise(members.map((v) => Math.sqrt(deg[v] + 1)))
  const vectors: number[][] = []
  const mul = (x: number[]) => {
    const y = new Array<number>(m).fill(0)
    for (let i = 0; i < m; i++) {
      const v = members[i]
      let acc = x[i] * invSqrt[i] * invSqrt[i]
      for (const w of adj[v]) acc += x[local[w]] * invSqrt[local[w]] * invSqrt[i]
      y[i] = acc
    }
    return y
  }
  let seed = 1
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5
  // A leading eigenvector can localise on a dense corner of the graph — a few large entries, the rest near zero —
  // and say nothing about where everything else goes. A few more are computed than the picture needs, and the
  // ones that spread the graph best (the 90th percentile of |entry| closest to the largest) are used, in order.
  const extra = 3
  for (let c = 0; c < k + extra && m > c + 1; c++) {
    let x = normalise(Array.from({ length: m }, rnd))
    for (let it = 0; it < 300; it++) {
      let y = mul(x)
      y = orthogonalise(y, trivial)
      for (const u of vectors) y = orthogonalise(y, u)
      const next = normalise(y)
      let diff = 0
      for (let i = 0; i < m; i++) diff += Math.abs(next[i] - x[i])
      x = next
      if (diff < 1e-6) break
    }
    vectors.push(x)
  }
  const span = Math.sqrt(Math.max(m, 4)) * BASE * params.spacing
  const chosen = vectors
    .map((v, i) => ({ v, i, s: spreadOf(v) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map((c) => c.v)
  const scaled = chosen.map((v) => spread(v, span))
  const out: Positions = {}
  members.forEach((v, i) => {
    out[slice.nodes[v].id] = { x: scaled[0]?.[i] ?? 0, y: scaled[1]?.[i] ?? 0, ...(dims === 3 ? { z: scaled[2]?.[i] ?? 0 } : {}) }
  })
  const rest: number[] = []
  for (let i = 0; i < n; i++) if (comp[i] !== main) rest.push(i)
  rest.sort((a, b) => comp[a] - comp[b])
  const r = span * 1.6
  rest.forEach((v, i) => {
    const t = (i / Math.max(1, rest.length)) * Math.PI * 2
    out[slice.nodes[v].id] = { x: Math.cos(t) * r, y: Math.sin(t) * r, ...(dims === 3 ? { z: 0 } : {}) }
  })
  return out
}

/** How well a vector spreads its entries: the 90th percentile of |entry| over the largest (1 = flat, 0 = one spike). */
export function spreadOf(v: number[]): number {
  const m = v.length
  if (!m) return 0
  const abs = v.map(Math.abs).sort((a, b) => a - b)
  return abs[Math.min(m - 1, Math.floor(0.9 * m))] / (abs[m - 1] || 1e-9)
}

/**
 * Coordinates from an eigenvector, filling ±`span`. A vector that spreads the graph is used as it is (scaled by
 * its largest entry). One that localises — a few entries far out, everything else piled near zero, the usual
 * case on a large graph with a dense core — would put nine nodes in ten into one dot; for those the ranks take
 * over, spread as a normal distribution so the bulk fills the picture and the outliers stay outermost. The two
 * are blended by how far the 90th percentile sits from the maximum, so the switch is gradual, deterministic and
 * order-preserving either way.
 */
export function spread(v: number[], span: number): number[] {
  const m = v.length
  if (!m) return []
  let max = 1e-9
  for (const t of v) max = Math.max(max, Math.abs(t))
  // The ranked share: 1 when the 90th percentile sits at zero (one spike), 0 once it reaches a quarter of the
  // maximum (a spread vector), linear between.
  const w = Math.min(1, Math.max(0, 1 - spreadOf(v) / 0.25))
  const linear = v.map((t) => (t / max) * span)
  if (w === 0) return linear
  const order = v.map((_, i) => i).sort((a, b) => v[a] - v[b] || a - b)
  const ranked = new Array<number>(m)
  order.forEach((i, r) => (ranked[i] = Math.max(-1, Math.min(1, probit((r + 0.5) / m) / 3)) * span))
  return linear.map((t, i) => (1 - w) * t + w * ranked[i])
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function normalise(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((a, t) => a + t * t, 0)) || 1
  return v.map((t) => t / len)
}
function orthogonalise(v: number[], u: number[]): number[] {
  let dot = 0
  for (let i = 0; i < v.length; i++) dot += v[i] * u[i]
  return v.map((t, i) => t - dot * u[i])
}
export default run

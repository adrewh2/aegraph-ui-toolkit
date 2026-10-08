import { gaussian, mulberry32 } from './random'
import { sunflower } from './layout'

/**
 * A synthetic graph straight into packed arrays — the benchmark's data.
 * Communities of Zipf-like sizes, most edges inside a community and a share
 * across, hubs from a mild preferential bias; six node types and four
 * relationship types so styling has something to colour. Ids are virtual
 * (`n<index>`): a million nodes cost no strings. Positions come with
 * it (communities on a sunflower spiral, members in a disc around the centre)
 * so the picture is readable at once without any force run. Deterministic in
 * the seed. 200k nodes / 500k edges takes well under a second in a worker.
 */
export interface GeneratedGraph {
  /** Ids are virtual: `n<index>`; a label is `<type> <index>`. No strings are materialised. */
  idPrefix: string
  nodeType: Uint16Array
  edgeSource: Uint32Array
  edgeTarget: Uint32Array
  edgeType: Uint16Array
  positions: Float32Array
  community: Uint32Array
  nodeTypes: string[]
  edgeTypes: string[]
  communities: number
}

export interface GenerateSpec {
  nodes: number
  edges: number
  seed?: number
  /** How many communities; default ~√N/2, at least 4. */
  communities?: number
  /** Share of edges that stay inside their community (default 0.85). */
  cohesion?: number
}

export const NODE_TYPE_NAMES = ['person', 'organisation', 'work', 'place', 'topic', 'event']
export const EDGE_TYPE_NAMES = ['knows', 'member_of', 'cites', 'located_in']
/** How common each node type is. */
const NODE_TYPE_WEIGHTS = [0.4, 0.15, 0.25, 0.08, 0.08, 0.04]

export function generateGraph(spec: GenerateSpec): GeneratedGraph {
  const N = Math.max(1, spec.nodes | 0)
  const E = Math.max(0, spec.edges | 0)
  const rand = mulberry32(spec.seed ?? 1)
  const K = Math.max(4, Math.min(N, spec.communities ?? Math.round(Math.sqrt(N) / 2)))
  const cohesion = spec.cohesion ?? 0.85

  // Community sizes: Zipf-ish weights, every community at least one node.
  const weights = new Float64Array(K)
  let sum = 0
  for (let k = 0; k < K; k++) sum += weights[k] = 1 / Math.pow(k + 1, 0.7)
  const sizes = new Uint32Array(K)
  let assigned = 0
  for (let k = 0; k < K; k++) assigned += sizes[k] = Math.max(1, Math.floor((weights[k] / sum) * N))
  // Rounding leaves a few nodes over or short: give them to the biggest communities, one each.
  let k = 0
  while (assigned < N) {
    sizes[k % K]++
    assigned++
    k++
  }
  while (assigned > N) {
    const j = k % K
    if (sizes[j] > 1) {
      sizes[j]--
      assigned--
    }
    k++
  }
  const start = new Uint32Array(K + 1)
  for (let c = 0; c < K; c++) start[c + 1] = start[c] + sizes[c]

  const community = new Uint32Array(N)
  const nodeType = new Uint16Array(N)
  const cum = NODE_TYPE_WEIGHTS.map(((s) => (w) => (s += w))(0))
  for (let c = 0; c < K; c++) {
    for (let i = start[c]; i < start[c + 1]; i++) {
      community[i] = c
      const u = rand()
      let t = 0
      while (t < cum.length - 1 && u > cum[t]) t++
      nodeType[i] = t
    }
  }

  // Positions: communities on a sunflower spiral spaced by their radius, members in a Gaussian disc; z is a
  // Gaussian of the same spread so the 3D view sees a ball where the 2D view sees a disc.
  const positions = new Float32Array(N * 3)
  const centres = new Float32Array(K * 3)
  const radii = new Float32Array(K)
  let maxR = 0
  for (let c = 0; c < K; c++) maxR = Math.max(maxR, (radii[c] = Math.sqrt(sizes[c]) * 6))
  const spread = maxR * 2.2 * Math.sqrt(K) * 0.8
  for (let c = 0; c < K; c++) {
    sunflower(c, K, spread, centres, c)
  }
  for (let c = 0; c < K; c++) {
    const cx = centres[c * 3], cy = centres[c * 3 + 1], r = radii[c]
    for (let i = start[c]; i < start[c + 1]; i++) {
      positions[i * 3] = cx + gaussian(rand) * r * 0.8
      positions[i * 3 + 1] = cy + gaussian(rand) * r * 0.8
      positions[i * 3 + 2] = gaussian(rand) * r * 0.8
    }
  }

  // Edges: pick a community by size, an endpoint with a hub bias (min of two uniforms), the other inside or outside.
  const edgeSource = new Uint32Array(E)
  const edgeTarget = new Uint32Array(E)
  const edgeType = new Uint16Array(E)
  const pickIn = (c: number) => start[c] + Math.floor(Math.min(rand(), rand()) * sizes[c])
  let e = 0
  let guard = 0
  while (e < E && guard < E * 4) {
    guard++
    const c = Math.floor(Math.pow(rand(), 1.3) * K)
    const s = pickIn(c)
    let t: number
    if (rand() < cohesion || K === 1) t = pickIn(c)
    else t = pickIn(Math.floor(rand() * K))
    if (s === t) continue
    edgeSource[e] = s
    edgeTarget[e] = t
    const st = nodeType[s], tt = nodeType[t]
    edgeType[e] = st === 0 && tt === 0 ? 0 : tt === 1 ? 1 : st === 2 || tt === 2 ? 2 : tt === 3 ? 3 : Math.floor(rand() * EDGE_TYPE_NAMES.length)
    e++
  }
  return {
    idPrefix: 'n',
    nodeType,
    edgeSource: e === E ? edgeSource : edgeSource.slice(0, e),
    edgeTarget: e === E ? edgeTarget : edgeTarget.slice(0, e),
    edgeType: e === E ? edgeType : edgeType.slice(0, e),
    positions,
    community,
    nodeTypes: NODE_TYPE_NAMES.slice(),
    edgeTypes: EDGE_TYPE_NAMES.slice(),
    communities: K,
  }
}

/** The benchmark presets: the sizes the harness measures at. */
export const BENCH_PRESETS: Record<string, GenerateSpec> = {
  '10k': { nodes: 10_000, edges: 25_000 },
  '50k': { nodes: 50_000, edges: 125_000 },
  '100k': { nodes: 100_000, edges: 250_000 },
  '200k': { nodes: 200_000, edges: 500_000 },
  '500k': { nodes: 500_000, edges: 1_250_000 },
  '1m': { nodes: 1_000_000, edges: 2_500_000 },
}

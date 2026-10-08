import dagre from '@dagrejs/dagre'
import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimNode } from 'd3-force-3d'
import Graph from 'graphology'
import circlepackLayout from 'graphology-layout/circlepack'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import noverlap from 'graphology-layout-noverlap'
import type { EntityId } from '../entity/types'
import { BitSet } from '../packed/bitset'
import { PackedGraph } from '../packed/graph'
import { layoutCoarse } from '../packed/layout'
import { layoutMultilevel } from '../packed/multilevel'
import { coolingSteps, decayFor, DEFAULT_PHYSICS, PhysicsSim, type PhysicsParams } from '../packed/physics'
import type { GraphSlice } from './filter'
import type { PositionsWire, SliceWire } from './layoutWire'
import { edgeWeight } from './paths'
import { coneTree, radialTree, type TreeFollow } from './tree'
import type { Position } from './types'

/**
 * Layout algorithms. Every algorithm is a pure function from a graph slice to
 * a position map, so results can be saved as `layout` entities and reused
 * with any filter. Force layouts are seeded from previous positions when
 * available, so re-running refines rather than reshuffles.
 */

export type Positions = Record<EntityId, Position>

export type Dimensions = 2 | 3

export type LayoutAlgorithm =
  | 'force'
  | 'circular'
  | 'radial-by-type'
  | 'concentric-by-degree'
  | 'clusters-by-type'
  | 'circlepack'
  | 'grid'
  | 'layered'
  | 'tree'
  | 'sphere'
  | 'random'
  // Not an algorithm: positions set rather than computed — a placement, positions set by hand or by a tool, a layout
  // loaded from such. Selected by those actions, so the Layout tab says what the picture is; nothing recomputes it.
  | 'custom'
  // The packed multilevel layout (`core/packed/layout.ts`): communities by label propagation, placed as discs or balls.
  | 'multilevel'
  // Unigraph's force model (`core/packed/physics.ts`): live on the GPU tabs, the same model on the CPU elsewhere.
  | 'unigraph-force'
  // Engines loaded on demand (see layoutEngines.ts): never in the main bundle, always run in the layout worker.
  | 'elk-layered'
  | 'elk-stress'
  | 'elk-mrtree'
  | 'elk-radial'
  | 'cola'
  | 'ngraph'
  | 'spectral'

/** A layout engine fetched the first time it is used: a separate chunk, run in the worker. */
export type LayoutEngine = 'elk' | 'cola' | 'ngraph' | 'spectral'

/** The tunable part of Unigraph's force model (the rest — alpha, its floor, the step cap — is the run's own). */
export type UnigraphForceParams = Pick<PhysicsParams, 'repulsion' | 'linkDistance' | 'linkStrength' | 'gravity' | 'damping' | 'alphaDecay'>
export const DEFAULT_UNIGRAPH_FORCE: UnigraphForceParams = { repulsion: DEFAULT_PHYSICS.repulsion, linkDistance: DEFAULT_PHYSICS.linkDistance, linkStrength: DEFAULT_PHYSICS.linkStrength, gravity: DEFAULT_PHYSICS.gravity, damping: DEFAULT_PHYSICS.damping, alphaDecay: DEFAULT_PHYSICS.alphaDecay }

export interface LayoutParams {
  dimensions: Dimensions
  /** Global distance multiplier. */
  spacing: number
  /** Force iterations (force only). */
  iterations: number
  /** Layered direction (layered only). */
  direction: 'TB' | 'LR'
  seed: number
  // ── Optional, all defaulted by DEFAULT_LAYOUT_PARAMS ──
  /** Push overlapping nodes apart after the layout (2D). */
  noverlap?: boolean
  noverlapMargin?: number
  /** ForceAtlas2 (2D) / centring strength (3D). */
  gravity?: number
  /** ForceAtlas2 repulsion scale, multiplied by spacing. */
  scalingRatio?: number
  /** ForceAtlas2: 0 ignores weights, 1 is linear. */
  edgeWeightInfluence?: number
  /** Relationship attribute path holding edge weights, e.g. `data.weight`. */
  weightField?: string
  linLogMode?: boolean
  strongGravity?: boolean
  /** Force (Unigraph): the force model's own knobs, live-tunable while the simulation runs on a GPU tab. */
  unigraph?: UnigraphForceParams
  /** Layered: rank / node separation multipliers. */
  ranksep?: number
  nodesep?: number
  /** Radial / concentric / tree: the node at the origin, or the tree's root. */
  centerId?: EntityId
  /** Tree: read the edges as parent → child (`out`), child → parent (`in`), either way — a spanning tree (`any`) — or `auto`, the reading that finds the deepest hierarchy. */
  treeFollow?: TreeFollow
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  dimensions: 2,
  spacing: 1,
  iterations: 300,
  direction: 'TB',
  seed: 1,
  noverlap: false,
  noverlapMargin: 4,
  unigraph: DEFAULT_UNIGRAPH_FORCE,
  gravity: 1,
  scalingRatio: 10,
  edgeWeightInfluence: 0,
  linLogMode: false,
  strongGravity: false,
  ranksep: 1.5,
  nodesep: 1,
}

export interface LayoutInfo {
  id: LayoutAlgorithm
  label: string
  description: string
  /** Which dimensions it's meaningful in. */
  dims: Dimensions[]
  /** Nodes beyond which it gets slow enough to warn. */
  softLimit: number
  /** Provided by an engine fetched on demand; such layouts always compute in the worker (`computeLayoutAsync`). */
  engine?: LayoutEngine
  /**
   * A simulation rather than a one-off computation. `live`: the engine runs it itself, so it can be left running
   * (the Physics switch), reacting to drags and pins; `batch`: a simulation too, but stepped in the worker for the
   * iterations given. Absent: static.
   */
  dynamic?: 'live' | 'batch'
  /** Which parameter groups the layout reads, for the panel. */
  uses?: ('iterations' | 'direction' | 'spacing' | 'unigraph')[]
  /**
   * Past this many nodes the layout does not run at all: measured (a benchmark kept outside the repo, timing), it
   * would take minutes — a stall in all but name, the view a seed cloud under "Laying out…" until it lands. The
   * dropdown greys it out, `graph_layout` refuses it, and a view that grows past it gets another layout. Unset: it
   * scales (linear, or budgeted like Force (Unigraph) on the CPU).
   */
  maxNodes?: number
}

export const LAYOUTS: LayoutInfo[] = [
  { id: 'custom', label: 'Custom positions', description: 'Positions set rather than computed: a placement (every tree where it stands, a grid by year), positions set by hand or by a tool, a layout loaded from such. Nothing moves them; a node that enters the view without one is put on a grid beside the picture. Choose an algorithm and Recompute to lay it all out again.', dims: [2, 3], softLimit: 1000000 },
  { id: 'unigraph-force', label: 'Force (Unigraph)', description: 'Unigraph’s own force model: repulsion summed through a cell pyramid (nothing O(n²)), springs at a link distance weighted against hubs, a weak gravity that sets the density; d3-style cooling. It runs live on the GPU — a million nodes at a few milliseconds an iteration — and the parameters below apply while it runs (in the worker on the CPU without WebGPU). A run takes about 1,500 iterations to cool (more for a big graph on the GPU); on the CPU a big graph gets fewer, cooling faster to fit, and Iterations is the least it gets. Run holds the settled positions.', dims: [2, 3], softLimit: 1000000, uses: ['iterations', 'unigraph'], dynamic: 'live' },
  { id: 'force', label: 'Force-directed', description: 'Physics simulation: linked nodes attract, all nodes repel. ForceAtlas2 in 2D, d3-force in 3D, stepped in the background for the iterations given.', dims: [2, 3], softLimit: 8000, maxNodes: 25000, dynamic: 'batch' },
  { id: 'radial-by-type', label: 'Radial by type', description: 'One ring per type, largest type innermost. In 3D, rings stack along z.', dims: [2, 3], softLimit: 50000 },
  { id: 'clusters-by-type', label: 'Clusters by type', description: 'Each type in its own compact cluster, clusters arranged in a grid.', dims: [2, 3], softLimit: 50000 },
  { id: 'circlepack', label: 'Circle pack', description: 'Nested circles: one bubble per type, nodes packed inside by degree.', dims: [2], softLimit: 50000 },
  { id: 'concentric-by-degree', label: 'Concentric by degree', description: 'Hubs in the middle, leaves on the outside.', dims: [2, 3], softLimit: 50000 },
  { id: 'layered', label: 'Layered (hierarchy)', description: 'Sugiyama-style layering along relationship direction. Best for trees and DAGs.', dims: [2], softLimit: 200, maxNodes: 300 },
  { id: 'circular', label: 'Circular', description: 'Everything on one circle, grouped by type.', dims: [2, 3], softLimit: 50000 },
  { id: 'grid', label: 'Grid', description: 'A plain grid, grouped by type. Never overlaps.', dims: [2, 3], softLimit: 100000 },
  { id: 'tree', label: 'Tree (branches)', description: 'Branches, not a mesh: a spanning tree of the view drawn as rings out from each root in 2D, and as nested cones — children on a circle around their parent, one level further down — in 3D, seen side-on so the branching shows. Edges that are not part of the tree are ignored for placement, so a dense graph still reads as a hierarchy; pair it with a backbone in the filter to draw only the structural edges. O(V+E), no simulation.', dims: [2, 3], softLimit: 200000, uses: ['spacing', 'direction'] },
  { id: 'sphere', label: 'Sphere', description: 'Evenly spread over a sphere (Fibonacci lattice). 3D only.', dims: [3], softLimit: 50000 },
  { id: 'random', label: 'Random', description: 'Uniform noise — a starting point for force layouts.', dims: [2, 3], softLimit: 100000 },
  { id: 'multilevel', label: 'Multilevel (communities)', description: 'Communities within communities, drawn as balls within balls (discs in 2D): a Louvain hierarchy, its top level laid out whole, then each level placed inside its parent and settled — collisions on a grid, springs along the edges, a wall at the parent’s edge — with components and isolated nodes in one ball beside the rest. Linear per level, no O(n²) anywhere: 800,000 nodes in a few seconds. A relationship weight field, when set, weighs the communities. The choice for a big view without WebGPU.', dims: [2, 3], softLimit: 2000000, uses: ['spacing'] },
  { id: 'elk-layered', label: 'Layered (ELK)', description: 'Eclipse Layout Kernel’s Sugiyama layering: fewer crossings and straighter edges than the plain layered layout, at a cost. Loads on first use.', dims: [2], softLimit: 700, maxNodes: 1300, engine: 'elk', uses: ['direction', 'spacing'] },
  { id: 'elk-stress', label: 'Stress (ELK)', description: 'Stress majorization: graph distances become screen distances, so structure reads at a glance. Loads on first use.', dims: [2], softLimit: 200, maxNodes: 400, engine: 'elk', uses: ['spacing'] },
  { id: 'elk-mrtree', label: 'Tree (ELK)', description: 'A tidy tree drawing for hierarchies; non-tree edges are ignored for placement. Loads on first use.', dims: [2], softLimit: 500, maxNodes: 700, engine: 'elk', uses: ['direction', 'spacing'] },
  { id: 'elk-radial', label: 'Radial (ELK)', description: 'Concentric rings out from the best-connected node along a spanning tree, subtrees in wedges; other components ring a shared centre. Loads on first use.', dims: [2], softLimit: 4000, maxNodes: 6000, engine: 'elk', uses: ['spacing'] },
  { id: 'cola', label: 'Constraint (WebCola)', description: 'Constraint-based stress layout with overlap avoidance; symmetric, readable pictures in 2D and 3D. Loads on first use.', dims: [2, 3], softLimit: 500, maxNodes: 1200, engine: 'cola', uses: ['iterations', 'spacing'] },
  { id: 'ngraph', label: 'Force (ngraph)', description: 'n-body spring layout with a Barnes–Hut tree in 2D or 3D; a fast alternative to ForceAtlas2/d3 for big graphs. Loads on first use.', dims: [2, 3], softLimit: 8000, maxNodes: 20000, engine: 'ngraph', uses: ['iterations', 'spacing'] },
  { id: 'spectral', label: 'Spectral', description: 'Positions from the graph Laplacian’s eigenvectors: clusters and bridges show as geometry, deterministically; a vector that piles the graph into one dot is spread by rank instead. No download.', dims: [2, 3], softLimit: 32000, maxNodes: 80000, engine: 'spectral', uses: ['spacing'] },
]

export const layoutInfo = (id: LayoutAlgorithm) => LAYOUTS.find((l) => l.id === id)!
/**
 * The algorithm a saved layout selects when it loads: the one it names when that is a layout of ours; **custom** for
 * one that came from a placement (it carries the rule) or was written by hand or by a tool (`manual`, or nothing
 * recognisable) — the picture is its positions, and the Layout tab should say so rather than name an algorithm that
 * would draw something else.
 */
export function layoutAlgorithmOf(d: { algorithm?: string; rule?: { kind: string } | undefined }): LayoutAlgorithm | undefined {
  if (d.rule?.kind === 'placement') return 'custom'
  if (d.algorithm && LAYOUTS.some((l) => l.id === d.algorithm)) return d.algorithm as LayoutAlgorithm
  return d.algorithm ? 'custom' : undefined
}
/**
 * Why a layout cannot lay out this many nodes (its `maxNodes`), or undefined when it can. What the dropdown shows
 * beside a greyed-out layout, what `graph_layout` says, and what the explorer checks before a run.
 */
export function layoutTooBig(algorithm: LayoutAlgorithm, nodes: number): string | undefined {
  const info = layoutInfo(algorithm)
  if (info.maxNodes === undefined || nodes <= info.maxNodes) return undefined
  return `${info.label} lays out at most ${info.maxNodes.toLocaleString()} nodes — past that it takes minutes — and this view has ${nodes.toLocaleString()}. Force (Unigraph) or Multilevel lay out any size.`
}

/** A dynamic layout is a simulation that can be kept running somewhere; the rest are static. */
export const isDynamicLayout = (id: LayoutAlgorithm) => !!layoutInfo(id).dynamic
/** Whether the layout can be kept running live on this renderer (the GPU renderer's two views count as one). */
export const canRunLive = (id: LayoutAlgorithm) => layoutInfo(id).dynamic === 'live'

/**
 * The slice as a packed graph (dense indices in slice order): what the packed layouts read. With `weights`, each
 * packed edge's weight (the relationship's `weightField`, 1 without one) is pushed there, by packed edge index.
 */
function packedSlice(slice: GraphSlice, weights?: { field?: string; out: number[] }): PackedGraph {
  const N = slice.nodes.length
  const index = new Map<EntityId, number>()
  for (let i = 0; i < N; i++) index.set(slice.nodes[i].id, i)
  const src: number[] = []
  const dst: number[] = []
  for (const e of slice.edges) {
    const a = index.get(e.source.id), b = index.get(e.target.id)
    if (a === undefined || b === undefined || a === b) continue
    src.push(a)
    dst.push(b)
    weights?.out.push(edgeWeight(e, weights.field))
  }
  return PackedGraph.fromArrays({ nodeType: new Uint16Array(N), edgeSource: Uint32Array.from(src), edgeTarget: Uint32Array.from(dst), edgeType: new Uint16Array(src.length) })
}
const unpackPositions = (slice: GraphSlice, xyz: Float32Array, dims: Dimensions): Positions => {
  const out: Positions = {}
  for (let i = 0; i < slice.nodes.length; i++) out[slice.nodes[i].id] = dims === 3 ? { x: xyz[i * 3], y: xyz[i * 3 + 1], z: xyz[i * 3 + 2] } : { x: xyz[i * 3], y: xyz[i * 3 + 1] }
  return out
}

/**
 * The multilevel communities layout over the slice (`core/packed/multilevel.ts`: a Louvain hierarchy, drawn as balls
 * within balls), back to positions by id. Relationship weights count when a weight field is set.
 */
function multilevel(slice: GraphSlice, p: LayoutParams): Positions {
  const weights = p.weightField ? { field: p.weightField, out: [] as number[] } : undefined
  const g = packedSlice(slice, weights)
  const xyz = new Float32Array(slice.nodes.length * 3)
  layoutMultilevel(g, xyz, { spacing: BASE * 0.5 * p.spacing, seed: p.seed, dims: p.dimensions === 3 ? 3 : 2, edgeWeight: weights && Float32Array.from(weights.out) })
  return unpackPositions(slice, xyz, p.dimensions)
}

/**
 * The multilevel layout straight from the worker's columns (`layoutWire.ts`): the wire already holds edge ends as
 * indices, so the packed graph is built from them and the positions go back as a column — no object per node, no
 * lookup by id. At 800,000 nodes the objects cost more than the layout: rebuilding the slice, indexing it back by id
 * and writing a position object per node took longer than the hierarchy and the placement together. Pinned nodes
 * with a previous position keep it, as `finishLayout` would do. Undefined when the object path is needed (overlap
 * removal in 2D reads positions by id).
 */
export function multilevelWire(w: SliceWire, params: LayoutParams, previous?: PositionsWire, pinned?: EntityId[]): PositionsWire | undefined {
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...params, spacing: Math.max(0, params.spacing ?? DEFAULT_LAYOUT_PARAMS.spacing) }
  const dims: Dimensions = p.dimensions === 3 ? 3 : 2
  if (p.noverlap && dims === 2) return undefined
  const n = w.ids.length
  const g = PackedGraph.fromArrays({ nodeType: new Uint16Array(n), edgeSource: w.src, edgeTarget: w.dst, edgeType: new Uint16Array(w.src.length) })
  const xyz = new Float32Array(n * 3)
  let fixed: BitSet | undefined
  if (pinned?.length && previous) {
    // Only the pinned ids are looked up: an index of them, then one pass over the previous positions.
    const want = new Set(pinned)
    const at = new Map<EntityId, number>()
    for (let i = 0; i < n; i++) if (want.has(w.ids[i])) at.set(w.ids[i], i)
    for (let k = 0; k < previous.ids.length; k++) {
      const i = at.get(previous.ids[k])
      if (i === undefined) continue
      fixed ??= new BitSet(n)
      fixed.set(i)
      xyz[i * 3] = previous.xyz[k * 3]
      xyz[i * 3 + 1] = previous.xyz[k * 3 + 1]
      xyz[i * 3 + 2] = dims === 3 ? previous.xyz[k * 3 + 2] || 0 : 0
    }
  }
  layoutMultilevel(g, xyz, { spacing: BASE * 0.5 * p.spacing, seed: p.seed, dims, edgeWeight: p.weightField ? Float32Array.from(w.weight) : undefined }, fixed)
  const out = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = xyz[i * 3]
    out[i * 3 + 1] = xyz[i * 3 + 1]
    // A 2D position has no z (NaN on the wire), as `packPositions` writes it.
    out[i * 3 + 2] = dims === 3 ? xyz[i * 3 + 2] : NaN
  }
  return { ids: w.ids, xyz: out }
}

/**
 * Unigraph's force model on the CPU (the same model the GPU tabs step live): seeded from the previous positions
 * where there are any, else from the multilevel layout, then run until it cools — about 1,500 iterations at the
 * defaults. On the CPU that is affordable up to a budget of work (`CPU_FORCE_WORK`, iterations × (nodes + edges),
 * about five seconds — 0.6 µs per node or edge per iteration, measured): past it the run gets fewer iterations (never under 20, nor under `iterations` when it was raised above the default), and cools faster to fit them,
 * so it always ends settled rather than cut off hot.
 */
const CPU_FORCE_WORK = 8e6
function unigraphForce(slice: GraphSlice, p: LayoutParams, previous?: Positions): Positions {
  const N = slice.nodes.length
  const dims: 2 | 3 = p.dimensions === 3 ? 3 : 2
  const g = packedSlice(slice)
  const xyz = new Float32Array(N * 3)
  const seeded = previous && slice.nodes.every((n) => previous[n.id])
  if (seeded) {
    for (let i = 0; i < N; i++) {
      const q = previous![slice.nodes[i].id]
      xyz[i * 3] = q.x
      xyz[i * 3 + 1] = q.y
      xyz[i * 3 + 2] = dims === 3 ? (q.z ?? 0) : 0
    }
  } else layoutCoarse(g, xyz, { spacing: BASE * 0.5 * p.spacing, seed: p.seed, dims })
  const params: PhysicsParams = { ...DEFAULT_PHYSICS, ...DEFAULT_UNIGRAPH_FORCE, ...(p.unigraph ?? {}), dims }
  // The work budget decides on a big graph — 300 iterations at 800,000 nodes would be minutes — unless Iterations was
  // raised on purpose; a small graph runs until it cools.
  const byWork = Math.floor(CPU_FORCE_WORK / Math.max(1, N + slice.edges.length))
  const budget = Math.max(20, byWork, p.iterations > DEFAULT_LAYOUT_PARAMS.iterations ? p.iterations : 0)
  if (coolingSteps(params) > budget) params.alphaDecay = decayFor(params, budget)
  const sim = new PhysicsSim(N, g.offsets, g.neighbors, xyz, params)
  sim.step(budget)
  return unpackPositions(slice, sim.positions, p.dimensions)
}
/** The engine behind an algorithm, if it is not built in. */
export const engineOf = (id: LayoutAlgorithm): LayoutEngine | undefined => LAYOUTS.find((l) => l.id === id)?.engine

export const BASE = 40 // base unit distance between nodes

/**
 * Place every node in the slice. `previous` seeds force layouts (refine, not
 * reshuffle) and supplies the positions of `pinned` nodes, which every
 * algorithm leaves where they were.
 */
export function computeLayout(algorithm: LayoutAlgorithm, slice: GraphSlice, params: LayoutParams, previous?: Positions, pinned?: Iterable<EntityId>): Positions {
  // Spacing is a distance multiplier: below zero it turns the force layouts inside out (NaN); it reads as none.
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...params, spacing: Math.max(0, params.spacing ?? DEFAULT_LAYOUT_PARAMS.spacing) }
  const rnd = mulberry32(p.seed)
  const fixed = pinnedPositions(slice, previous, pinned)
  const fixedSet = new Set(Object.keys(fixed))
  let out: Positions
  switch (algorithm) {
    case 'force':
      out = p.dimensions === 3 ? force3d(slice, p, previous, rnd, fixedSet) : force2d(slice, p, previous, rnd, fixedSet)
      break
    case 'circular':
      out = circular(slice, p)
      break
    case 'radial-by-type':
      out = radialByType(slice, p)
      break
    case 'concentric-by-degree':
      out = concentricByDegree(slice, p)
      break
    case 'clusters-by-type':
      out = clustersByType(slice, p)
      break
    case 'circlepack':
      out = circlepack(slice, p, rnd)
      break
    case 'grid':
      out = grid(slice, p)
      break
    case 'layered':
      out = layered(slice, p)
      break
    case 'tree':
      // `direction` says which way the hierarchy runs: TB reads the edges as parent → child, LR the other way.
      out = (p.dimensions === 3 ? coneTree : radialTree)(slice, p, p.treeFollow ?? 'auto', p.centerId ? [p.centerId] : undefined)
      break
    case 'sphere':
      out = p.dimensions === 3 ? sphere(slice, p) : circular(slice, p)
      break
    case 'random':
      out = random(slice, p, rnd)
      break
    case 'custom':
      // Held positions are the layout; this is only reached for nodes that have none (see `resolvePositions`).
      out = grid(slice, p)
      break
    case 'multilevel':
      out = multilevel(slice, p)
      break
    case 'unigraph-force':
      out = unigraphForce(slice, p, previous)
      break
    default:
      // An engine layout has no synchronous form: it runs through `computeLayoutAsync` in the worker. A caller that
      // reaches here (a quick fill of a few nodes) gets a grid rather than a download.
      out = grid(slice, p)
  }
  return finishLayout(slice, out, p, fixed, fixedSet)
}

/** What every layout ends with: pinned nodes back where they were, then overlap removal when asked for (2D). */
export function finishLayout(slice: GraphSlice, out: Positions, p: LayoutParams, fixed: Positions, fixedSet: Set<EntityId>): Positions {
  for (const id in fixed) if (id in out) out[id] = { ...fixed[id] }
  if (p.noverlap && p.dimensions === 2) out = removeOverlap(slice, out, p, undefined, fixedSet)
  return out
}

/** The positions of pinned nodes, which every layout leaves where they were. */
export function pinnedPositions(slice: GraphSlice, previous: Positions | undefined, pinned: Iterable<EntityId> | undefined): Positions {
  const fixed: Positions = {}
  if (pinned && previous) for (const id of pinned) if (previous[id] && slice.degree.has(id)) fixed[id] = previous[id]
  return fixed
}

/** Overlap removal works cell by cell on a 20×20 grid and records every colliding pair; past this many nodes in one cell the pairs run into millions per iteration (and past 5,800 the collision set overflows). */
export const NOVERLAP_CELL_LIMIT = 1000
const NOVERLAP_GRID = 20

/** The most nodes any one cell of the overlap grid would hold. */
export function densestCell(positions: Positions, ids: Iterable<EntityId>, grid = NOVERLAP_GRID): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const pts: { x: number; y: number }[] = []
  for (const id of ids) {
    const p = positions[id]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    pts.push(p)
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (pts.length < 2) return pts.length
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const counts = new Uint32Array(grid * grid)
  let max = 0
  for (const p of pts) {
    const cx = Math.min(grid - 1, Math.floor(((p.x - minX) / w) * grid))
    const cy = Math.min(grid - 1, Math.floor(((p.y - minY) / h) * grid))
    const c = ++counts[cy * grid + cx]
    if (c > max) max = c
  }
  return max
}

/**
 * Push overlapping nodes apart (2D) without moving pinned ones. Sizes default to a degree-based radius. A picture
 * that piles more than `NOVERLAP_CELL_LIMIT` nodes into one grid cell (a spectral layout's central blob, every node
 * at the origin) is returned as it is: the removal would take tens of seconds and then overflow.
 */
export function removeOverlap(slice: GraphSlice, positions: Positions, params: LayoutParams, sizes?: Map<EntityId, number>, pinned?: Set<EntityId>): Positions {
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...params }
  if (densestCell(positions, slice.nodes.map((n) => n.id)) > NOVERLAP_CELL_LIMIT) return positions
  const g = new Graph({ type: 'undirected' })
  for (const n of slice.nodes) {
    const pos = positions[n.id]
    if (!pos) continue
    g.addNode(n.id, { x: pos.x, y: pos.y, size: sizes?.get(n.id) ?? 2 + Math.log1p(slice.degree.get(n.id) ?? 0) * 2 })
  }
  if (g.order < 2) return positions
  noverlap.assign(g, { maxIterations: 120, settings: { margin: (p.noverlapMargin ?? 4) * p.spacing, ratio: 1, expansion: 1.1, gridSize: NOVERLAP_GRID, speed: 3 } })
  const out: Positions = { ...positions }
  g.forEachNode((id, a) => {
    if (pinned?.has(id)) return
    out[id] = { ...positions[id], x: a.x as number, y: a.y as number }
  })
  return out
}

// ── Static layouts ─────────────────────────────────────────────────────

function sortedByType(slice: GraphSlice) {
  return [...slice.nodes].sort((a, b) => a.type.localeCompare(b.type) || (a.label ?? a.id).localeCompare(b.label ?? b.id))
}

function groupByType(slice: GraphSlice) {
  const groups = new Map<string, typeof slice.nodes>()
  for (const n of slice.nodes) groups.set(n.type, [...(groups.get(n.type) ?? []), n])
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}

function circular(slice: GraphSlice, p: LayoutParams): Positions {
  const nodes = sortedByType(slice)
  const r = Math.max(BASE, (nodes.length * BASE * p.spacing) / (2 * Math.PI))
  const out: Positions = {}
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2
    out[n.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r, ...(p.dimensions === 3 ? { z: 0 } : {}) }
  })
  return out
}

function radialByType(slice: GraphSlice, p: LayoutParams): Positions {
  const out: Positions = {}
  let r = 0
  let ring = 0
  const centre = p.centerId && slice.nodes.some((n) => n.id === p.centerId) ? p.centerId : undefined
  if (centre) out[centre] = { x: 0, y: 0, ...(p.dimensions === 3 ? { z: 0 } : {}) }
  for (const [, group] of groupByType(slice)) {
    const list = centre ? group.filter((n) => n.id !== centre) : group
    if (list.length === 0) continue
    // Ring radius grows so nodes on it stay ~BASE apart.
    const needed = (list.length * BASE * p.spacing) / (2 * Math.PI)
    r = Math.max(r + BASE * 2 * p.spacing, needed)
    const z = p.dimensions === 3 ? ring * BASE * 2 * p.spacing : undefined
    list.forEach((n, i) => {
      const a = (i / list.length) * Math.PI * 2
      out[n.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r, ...(z !== undefined ? { z } : {}) }
    })
    ring++
  }
  return out
}

function concentricByDegree(slice: GraphSlice, p: LayoutParams): Positions {
  const nodes = [...slice.nodes].sort((a, b) => (slice.degree.get(b.id) ?? 0) - (slice.degree.get(a.id) ?? 0))
  // An explicit centre node goes first, i.e. into the single-slot innermost ring.
  if (p.centerId) {
    const i = nodes.findIndex((n) => n.id === p.centerId)
    if (i > 0) nodes.unshift(...nodes.splice(i, 1))
  }
  const out: Positions = {}
  let i = 0
  let ring = 0
  let r = 0
  while (i < nodes.length) {
    // At zero spacing the ring never grows and its capacity is 0/0: every ring then takes at least one node, so the loop ends.
    const capacity = ring === 0 ? 1 : Math.floor((2 * Math.PI * r) / (BASE * p.spacing))
    const count = Math.max(1, Math.min(Number.isFinite(capacity) ? capacity : 1, nodes.length - i))
    for (let k = 0; k < count; k++, i++) {
      const a = (k / count) * Math.PI * 2
      out[nodes[i].id] = { x: Math.cos(a) * r, y: Math.sin(a) * r, ...(p.dimensions === 3 ? { z: ring * BASE * p.spacing * 0.5 } : {}) }
    }
    ring++
    r += BASE * 1.5 * p.spacing
  }
  return out
}

function grid(slice: GraphSlice, p: LayoutParams): Positions {
  const nodes = sortedByType(slice)
  const out: Positions = {}
  if (p.dimensions === 3) {
    const side = Math.ceil(Math.cbrt(nodes.length))
    nodes.forEach((n, i) => {
      out[n.id] = { x: (i % side) * BASE * p.spacing, y: (Math.floor(i / side) % side) * BASE * p.spacing, z: Math.floor(i / (side * side)) * BASE * p.spacing }
    })
    return out
  }
  const cols = Math.ceil(Math.sqrt(nodes.length))
  nodes.forEach((n, i) => {
    out[n.id] = { x: (i % cols) * BASE * p.spacing, y: Math.floor(i / cols) * BASE * p.spacing }
  })
  return out
}

function clustersByType(slice: GraphSlice, p: LayoutParams): Positions {
  const groups = groupByType(slice)
  const out: Positions = {}
  // Each cluster is a small grid; clusters tile a macro grid sized by the biggest cluster.
  const cellSide = Math.ceil(Math.sqrt(Math.max(1, groups[0]?.[1].length ?? 1)))
  const cellSize = (cellSide + 2) * BASE * p.spacing
  const macroCols = Math.ceil(Math.sqrt(groups.length))
  groups.forEach(([, list], g) => {
    const cols = Math.ceil(Math.sqrt(list.length))
    const ox = (g % macroCols) * cellSize
    const oy = Math.floor(g / macroCols) * cellSize
    const oz = p.dimensions === 3 ? (g % 3) * cellSize * 0.5 : undefined
    list.forEach((n, i) => {
      out[n.id] = { x: ox + (i % cols) * BASE * p.spacing, y: oy + Math.floor(i / cols) * BASE * p.spacing, ...(oz !== undefined ? { z: oz } : {}) }
    })
  })
  return out
}

function sphere(slice: GraphSlice, p: LayoutParams): Positions {
  const nodes = sortedByType(slice)
  const n = nodes.length
  const r = Math.max(BASE * 2, Math.sqrt(n) * BASE * 0.6 * p.spacing)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: Positions = {}
  nodes.forEach((node, i) => {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * i
    out[node.id] = { x: Math.cos(theta) * radius * r, y: y * r, z: Math.sin(theta) * radius * r }
  })
  return out
}

export function random(slice: GraphSlice, p: LayoutParams, rnd: () => number): Positions {
  const span = Math.sqrt(slice.nodes.length) * BASE * p.spacing
  const out: Positions = {}
  for (const n of slice.nodes) out[n.id] = { x: (rnd() - 0.5) * span, y: (rnd() - 0.5) * span, ...(p.dimensions === 3 ? { z: (rnd() - 0.5) * span } : {}) }
  return out
}

function circlepack(slice: GraphSlice, p: LayoutParams, rnd: () => number): Positions {
  const g = new Graph({ type: 'undirected' })
  for (const n of slice.nodes) g.addNode(n.id, { type: n.type, size: 1 + Math.log1p(slice.degree.get(n.id) ?? 0) })
  const pos = circlepackLayout(g, { hierarchyAttributes: ['type'], scale: (BASE * p.spacing) / 3, rng: rnd })
  const out: Positions = {}
  for (const n of slice.nodes) out[n.id] = { x: pos[n.id]?.x ?? 0, y: pos[n.id]?.y ?? 0 }
  return out
}

function layered(slice: GraphSlice, p: LayoutParams): Positions {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: p.direction, nodesep: BASE * (p.nodesep ?? 1) * p.spacing, ranksep: BASE * (p.ranksep ?? 1.5) * p.spacing, edgesep: 10 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of slice.nodes) g.setNode(n.id, { width: BASE * 0.6, height: BASE * 0.6 })
  for (const e of slice.edges) if (e.source.id !== e.target.id) g.setEdge(e.source.id, e.target.id, {}, e.id)
  dagre.layout(g)
  const out: Positions = {}
  for (const n of slice.nodes) {
    const v = g.node(n.id)
    out[n.id] = { x: v?.x ?? 0, y: v?.y ?? 0 }
  }
  return out
}

// ── Force layouts ──────────────────────────────────────────────────────

/** ForceAtlas2 settings shared by the one-shot layout and the live worker. */
export function fa2Settings(g: Graph, p: LayoutParams) {
  const d = { ...DEFAULT_LAYOUT_PARAMS, ...p }
  return {
    ...forceAtlas2.inferSettings(g),
    // ForceAtlas2 refuses a negative ratio; a spacing below zero reads as none.
    scalingRatio: Math.max(0, (d.scalingRatio ?? 10) * d.spacing),
    gravity: d.gravity ?? 1,
    linLogMode: !!d.linLogMode,
    strongGravityMode: !!d.strongGravity,
    edgeWeightInfluence: d.weightField ? d.edgeWeightInfluence || 1 : (d.edgeWeightInfluence ?? 0),
    barnesHutOptimize: g.order > 500,
    adjustSizes: false,
  }
}

function force2d(slice: GraphSlice, p: LayoutParams, previous: Positions | undefined, rnd: () => number, fixed: Set<EntityId>): Positions {
  const g = new Graph({ multi: true, type: 'mixed' })
  const seed = previous ?? random(slice, p, rnd)
  for (const n of slice.nodes) {
    const s = seed[n.id] ?? { x: (rnd() - 0.5) * 100, y: (rnd() - 0.5) * 100 }
    g.addNode(n.id, { x: s.x, y: s.y, size: 1 + Math.log1p(slice.degree.get(n.id) ?? 0), fixed: fixed.has(n.id) })
  }
  for (const e of slice.edges) if (e.source.id !== e.target.id) g.addEdgeWithKey(e.id, e.source.id, e.target.id, { weight: edgeWeight(e, p.weightField) })
  const iterations = Math.max(20, Math.round(p.iterations * (slice.nodes.length > 2000 ? 0.5 : 1)))
  forceAtlas2.assign(g, { iterations, settings: fa2Settings(g, p), getEdgeWeight: 'weight' })
  const out: Positions = {}
  g.forEachNode((id, a) => (out[id] = { x: a.x as number, y: a.y as number }))
  return out
}

interface FNode extends SimNode {
  id: EntityId
}

function force3d(slice: GraphSlice, p: LayoutParams, previous: Positions | undefined, rnd: () => number, fixed: Set<EntityId>): Positions {
  const seed = previous ?? random(slice, { ...p, dimensions: 3 }, rnd)
  const nodes: FNode[] = slice.nodes.map((n) => {
    const s = seed[n.id]
    const node: FNode = { id: n.id, x: s?.x ?? (rnd() - 0.5) * 100, y: s?.y ?? (rnd() - 0.5) * 100, z: s?.z ?? (rnd() - 0.5) * 100 }
    if (fixed.has(n.id)) {
      node.fx = node.x
      node.fy = node.y
      node.fz = node.z
    }
    return node
  })
  const links = slice.edges.filter((e) => e.source.id !== e.target.id).map((e) => ({ source: e.source.id, target: e.target.id, weight: edgeWeight(e, p.weightField) }))
  const weighted = !!p.weightField
  const sim = forceSimulation<FNode>(nodes, 3)
    .force(
      'link',
      forceLink<FNode, { source: string; target: string; weight: number }>(links)
        .id((d) => d.id)
        .distance((l) => (weighted ? (BASE * p.spacing) / Math.max(0.25, Math.min(4, l.weight)) : BASE * p.spacing)),
    )
    .force('charge', forceManyBody<FNode>().strength(-BASE * 2 * p.spacing))
    .force('center', forceCenter<FNode>(0, 0, 0).strength(Math.max(0.05, Math.min(1, p.gravity ?? 1))))
    .alphaDecay(0.03)
    .stop()
  const ticks = Math.max(20, Math.round(p.iterations * (slice.nodes.length > 2000 ? 0.4 : 1)))
  sim.tick(ticks)
  const out: Positions = {}
  for (const n of nodes) out[n.id] = { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 }
  return out
}

// ── Composition ────────────────────────────────────────────────────────

export interface ResolvedPositions {
  positions: Positions
  /** Visible nodes the saved layout didn't place; they were given fallback positions. */
  unplaced: number
}

/** Above this many nodes a force layout stalls the page for longer than a blink: it runs off the main thread (see `runLayoutInWorker`). */
export const HEAVY_LAYOUT_NODES = 800
/** Node counts past which a built-in layout goes to the worker; the rest are linear and instant at any size. */
/**
 * The layout a big view with no positions gets in Unigraph: its own force model on the GPU when the renderer is
 * WebGPU — a multilevel seed, then the simulation, a million nodes at a few milliseconds an iteration — and the
 * multilevel layout without WebGPU, where the same model would step in the worker on the CPU for minutes. Never
 * ForceAtlas2 (`force`), which is the default for small views and takes minutes over tens of thousands of nodes.
 */
export const bigViewLayout = (webgpu: boolean): LayoutAlgorithm => (webgpu ? 'unigraph-force' : 'multilevel')

const HEAVY_AT: Partial<Record<LayoutAlgorithm, number>> = {
  force: HEAVY_LAYOUT_NODES,
  // Linear, but a million nodes is still a second or two: past this it goes to the worker.
  multilevel: 20000,
  // Hundreds of iterations of the force model on the CPU: the worker from a few hundred nodes up.
  'unigraph-force': 500,
  // dagre's crossing minimisation is the slow part: a few hundred nodes with many edges already takes seconds.
  layered: 300,
  circlepack: 20000,
}
/**
 * Whether laying out this many nodes with the algorithm would stall the page — or needs an engine only the worker
 * loads. With `params`, overlap removal counts too: it is iterative and, from a few hundred nodes up, the slow part
 * of an otherwise instant layout (seconds at six thousand), so a 2D layout that avoids overlaps goes to the worker
 * past `HEAVY_LAYOUT_NODES` whatever the algorithm.
 */
export function isHeavyLayout(algorithm: LayoutAlgorithm, nodes: number, params?: Pick<LayoutParams, 'noverlap' | 'dimensions'>): boolean {
  if (nodes <= 0) return false
  if (engineOf(algorithm)) return true
  if (params?.noverlap && params.dimensions !== 3 && nodes >= HEAVY_LAYOUT_NODES) return true
  const at = HEAVY_AT[algorithm]
  return at !== undefined && nodes >= at
}

/**
 * Where held positions are read from: the plain object most callers have, or anything that can answer `get` —
 * the explorer's working layout is a Map behind a version counter, and materialising it to ask about one node
 * would cost the whole set on every drag.
 */
export interface PositionSource {
  get(id: EntityId): Position | undefined
  readonly size: number
}
const sourceOf = (saved: Positions | PositionSource): PositionSource =>
  typeof (saved as PositionSource).get === 'function' ? (saved as PositionSource) : { get: (id) => (saved as Positions)[id], size: Object.keys(saved as Positions).length }

/**
 * Combine a saved layout with the current slice. Nodes the layout doesn't
 * know are placed by `fallback`, offset just outside the placed nodes'
 * bounding circle so they read as "new" rather than overlapping.
 */
export function resolvePositions(slice: GraphSlice, saved: Positions | PositionSource | undefined, fallback: LayoutAlgorithm, params: LayoutParams): ResolvedPositions {
  if (!saved) return { positions: computeLayout(fallback, slice, params), unplaced: 0 }
  const held = sourceOf(saved)
  const positions: Positions = {}
  const missing: typeof slice.nodes = []
  let maxR = 0
  for (const n of slice.nodes) {
    const s = held.get(n.id)
    if (s) {
      positions[n.id] = { ...s }
      maxR = Math.max(maxR, Math.hypot(s.x, s.y, s.z ?? 0))
    } else missing.push(n)
  }
  if (missing.length === 0) return { positions, unplaced: 0 }
  const ids = new Set(missing.map((m) => m.id))
  const sub: GraphSlice = { ...slice, nodes: missing, edges: slice.edges.filter((e) => ids.has(e.source.id) && ids.has(e.target.id)) }
  const extra = computeLayout(fallback === 'layered' || fallback === 'circlepack' || engineOf(fallback) ? 'grid' : fallback, sub, params)
  // Shift the extras to the right of the existing cloud.
  let minX = Infinity
  for (const id in extra) minX = Math.min(minX, extra[id].x)
  const dx = maxR + BASE * 2 * params.spacing - (Number.isFinite(minX) ? minX : 0)
  for (const id in extra) positions[id] = { ...extra[id], x: extra[id].x + dx }
  return { positions, unplaced: missing.length }
}

/** Bounding box, for fitting cameras. */
export function bounds(positions: Positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const id in positions) {
    const p = positions[id]
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    minZ = Math.min(minZ, p.z ?? 0); maxZ = Math.max(maxZ, p.z ?? 0)
  }
  return Number.isFinite(minX) ? { minX, minY, minZ, maxX, maxY, maxZ } : { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

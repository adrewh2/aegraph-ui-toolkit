import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import { BASE, type Positions } from '../layouts'
import type { EngineFn } from '../layoutEngines'

/**
 * Eclipse Layout Kernel (elkjs): layered (Sugiyama), stress, mrtree and
 * radial. The engine itself (1.4 MB of compiled Java) runs in a worker of its
 * own, started from the layout worker the first time an ELK layout is asked
 * for; this module is only the small API in front of it. Positions come back
 * as the top-left of each node box; the centre is what the explorer holds.
 */
const ALGORITHMS: Record<string, string> = {
  'elk-layered': 'layered',
  'elk-stress': 'stress',
  'elk-mrtree': 'mrtree',
  'elk-radial': 'radial',
}

/**
 * In a browser (the layout worker) the engine gets a nested worker of its own. Where there is no `Worker` — tests
 * in Node — the bundled build runs in-thread instead; browsers never fetch that chunk.
 */
let elkInstance: Promise<InstanceType<typeof ELK>> | undefined
const getElk = () =>
  (elkInstance ??=
    typeof Worker === 'function'
      ? Promise.resolve(new ELK({ workerFactory: () => new Worker(elkWorkerUrl) }))
      : import('elkjs/lib/elk.bundled.js').then((m) => new m.default() as unknown as InstanceType<typeof ELK>))

/**
 * Past these the compiled engine either runs for minutes (stress) or overflows its stack (layered on a dense graph:
 * "Maximum call stack size exceeded" at 5,000 nodes / 50,000 edges). Refusing with a sentence beats dying in a worker.
 */
const CEILINGS: Record<string, { nodes: number; edges: number }> = {
  layered: { nodes: 3000, edges: 20000 },
  stress: { nodes: 3000, edges: 20000 },
  mrtree: { nodes: 8000, edges: 40000 },
  radial: { nodes: 8000, edges: 40000 },
}

const run: EngineFn = async (algorithm, { slice, params, fixed, previous }) => {
  const alg = ALGORITHMS[algorithm] ?? 'layered'
  const ceiling = CEILINGS[alg]
  if (ceiling && (slice.nodes.length > ceiling.nodes || slice.edges.length > ceiling.edges)) {
    throw new Error(`ELK ${alg} handles up to ${ceiling.nodes.toLocaleString()} nodes and ${ceiling.edges.toLocaleString()} edges; this view has ${slice.nodes.length.toLocaleString()} and ${slice.edges.length.toLocaleString()}. Narrow the filter, or use force, ngraph or spectral for a graph this size.`)
  }
  const size = BASE * 0.6 * params.spacing
  const gap = BASE * params.spacing
  const layoutOptions: Record<string, string> = {
    'elk.algorithm': alg,
    'elk.spacing.nodeNode': String(gap),
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  }
  if (alg === 'layered') {
    layoutOptions['elk.direction'] = params.direction === 'LR' ? 'RIGHT' : 'DOWN'
    layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers'] = String(gap * 1.5 * (params.ranksep ?? 1))
    layoutOptions['elk.spacing.nodeNode'] = String(gap * (params.nodesep ?? 1))
    layoutOptions['elk.layered.crossingMinimization.strategy'] = 'LAYER_SWEEP'
    // Disconnected pieces side by side rather than stacked into one column.
    layoutOptions['elk.separateConnectedComponents'] = 'true'
  } else if (alg === 'mrtree') {
    layoutOptions['elk.direction'] = params.direction === 'LR' ? 'RIGHT' : 'DOWN'
  } else if (alg === 'stress') {
    layoutOptions['elk.stress.desiredEdgeLength'] = String(gap * 2)
    layoutOptions['elk.stress.epsilon'] = '0.001'
  } else if (alg === 'radial') {
    layoutOptions['elk.radial.radius'] = String(gap * 2)
  }
  const ids = new Set(slice.nodes.map((n) => n.id))
  const children: ElkNode[] = slice.nodes.map((n) => {
    const p = previous?.[n.id]
    return { id: n.id, width: size, height: size, ...(p && fixed.has(n.id) ? { x: p.x - size / 2, y: -p.y - size / 2 } : {}) }
  })
  // ELK wants each edge once; parallel and reversed pairs only add cost, and self-loops mean nothing to it.
  const seen = new Set<string>()
  let edges: ElkExtendedEdge[] = []
  for (const e of slice.edges) {
    const a = e.source.id
    const b = e.target.id
    if (a === b || !ids.has(a) || !ids.has(b)) continue
    const key = e.directed ? `${a}\t${b}` : [a, b].sort().join('\t')
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: e.id, sources: [a], targets: [b] })
  }
  // Radial walks the graph as one tree: it recurses without end on a cycle ("Maximum call stack size exceeded" on
  // any real graph) and collapses a forest onto a line. It gets a spanning forest, each tree hanging from its
  // best-connected node, and when there is more than one tree they hang from a root of their own at the centre.
  // Nodes with no edge at all are placed on a ring around the picture afterwards: ELK radial spends seconds on a
  // star of thousands of leaves and says nothing about them that a ring does not.
  let isolated: string[] = []
  if (alg === 'radial') {
    edges = spanningForest(slice.nodes.map((n) => n.id), edges)
    const linked = new Set(edges.flatMap((e) => [e.sources[0], e.targets[0]]))
    isolated = slice.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id)
    const child = new Set(edges.map((e) => e.targets[0]))
    const roots = slice.nodes.filter((n) => linked.has(n.id) && !child.has(n.id))
    if (roots.length > 1) {
      children.push({ id: FOREST_ROOT, width: size, height: size })
      for (const r of roots) edges.push({ id: `${FOREST_ROOT}:${r.id}`, sources: [FOREST_ROOT], targets: [r.id] })
    }
  }
  const out: Positions = {}
  const skip = new Set(isolated)
  const laid = children.filter((c) => !skip.has(c.id))
  if (laid.length) {
    const root: ElkNode = { id: 'root', layoutOptions, children: laid, edges }
    const done = await (await getElk()).layout(root)
    // ELK's y grows downward; the explorer's grows upward, and a hierarchy should hang from the top.
    for (const c of done.children ?? []) if (c.id !== FOREST_ROOT) out[c.id] = { x: (c.x ?? 0) + size / 2, y: -((c.y ?? 0) + size / 2) }
  }
  if (isolated.length) {
    // A ring just outside the laid-out picture (or around the origin when there is none), evenly spaced.
    let cx = 0, cy = 0, r = 0
    const placed = Object.values(out)
    if (placed.length) {
      const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y)
      cx = (Math.min(...xs) + Math.max(...xs)) / 2
      cy = (Math.min(...ys) + Math.max(...ys)) / 2
      r = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + gap * 2
    }
    r = Math.max(r, (isolated.length * gap) / (2 * Math.PI), gap)
    isolated.forEach((id, i) => {
      const t = (i / isolated.length) * Math.PI * 2
      out[id] = { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r }
    })
  }
  return out
}

const FOREST_ROOT = '\u0000elk-forest-root'
/** A breadth-first spanning forest over `edges` (as undirected), each tree rooted at the highest-degree node left. */
export function spanningForest(ids: string[], edges: ElkExtendedEdge[]): ElkExtendedEdge[] {
  const adj = new Map<string, ElkExtendedEdge[]>()
  for (const id of ids) adj.set(id, [])
  for (const e of edges) {
    adj.get(e.sources[0])?.push(e)
    adj.get(e.targets[0])?.push(e)
  }
  const order = [...ids].sort((a, b) => adj.get(b)!.length - adj.get(a)!.length)
  const seen = new Set<string>()
  const out: ElkExtendedEdge[] = []
  for (const root of order) {
    if (seen.has(root)) continue
    seen.add(root)
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]
      for (const e of adj.get(v)!) {
        const w = e.sources[0] === v ? e.targets[0] : e.sources[0]
        if (seen.has(w)) continue
        seen.add(w)
        // Always parent → child, so the tree hangs from the root whichever way the relationship pointed.
        out.push({ id: e.id, sources: [v], targets: [w] })
        queue.push(w)
      }
    }
  }
  return out
}

export default run

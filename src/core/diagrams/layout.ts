import { emptyGeometry, straightRoute, type DiagramGeometry, type NodeGeom } from './geometry'
import type { ParsedDiagram } from './model'

/**
 * A renderer-free layout for a parsed diagram, used when a writer needs
 * positions (Excalidraw) and nothing has rendered the source: nodes are
 * layered along the flow direction (longest path from the sources), each
 * group gets its own band across the flow so its frame never overlaps
 * another's, and edges run straight between box borders. Deterministic.
 */
export interface AutoLayoutOptions {
  /** Flow direction, DOT-style; Mermaid's `direction` is accepted too. */
  rankdir?: 'LR' | 'TB' | 'RL' | 'BT' | 'TD' | string
  nodeWidth?: (label: string) => number
  nodeHeight?: (label: string) => number
  /** Gap between layers along the flow / between nodes across it. */
  rankGap?: number
  nodeGap?: number
  /** Padding inside a group frame. */
  framePad?: number
}

const lineCount = (label: string) => Math.max(1, label.split('\n').length)
const longestLine = (label: string) => Math.max(...label.split('\n').map((l) => l.length), 1)

export function autoLayout(d: ParsedDiagram, opts: AutoLayoutOptions = {}): DiagramGeometry {
  const dir = (opts.rankdir ?? d.attrs.rankdir ?? d.attrs.direction ?? 'TB').toUpperCase()
  const horizontal = dir === 'LR' || dir === 'RL'
  const widthOf = opts.nodeWidth ?? ((label: string) => Math.max(96, longestLine(label) * 7.5 + 32))
  const heightOf = opts.nodeHeight ?? ((label: string) => Math.max(44, lineCount(label) * 20 + 20))
  const rankGap = opts.rankGap ?? 90
  const nodeGap = opts.nodeGap ?? 28
  const framePad = opts.framePad ?? 24
  const frameTitle = 28

  // Ranks by longest path over a DAG (back edges found by DFS are ignored).
  const ids = d.nodes.map((n) => n.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const out = ids.map(() => [] as number[])
  const groupIds = d.groups.map((g) => g.id)
  const groupIndex = (i: number) => (d.nodes[i].group ? groupIds.indexOf(d.nodes[i].group!) : -1)
  for (const e of d.edges) {
    const s = index.get(e.source)
    const t = index.get(e.target)
    if (s === undefined || t === undefined || s === t) continue
    // Groups are declared in flow order; an edge back into an earlier group (an "export creates project" loop) must not drag its target downstream.
    const gs = groupIndex(s)
    const gt = groupIndex(t)
    if (gs >= 0 && gt >= 0 && gt < gs) continue
    if (e.attrs.constraint === 'false') continue
    out[s].push(t)
  }
  const state = new Uint8Array(ids.length) // 0 new, 1 on stack, 2 done
  const order: number[] = []
  const dfs = (u: number) => {
    state[u] = 1
    for (const v of out[u]) if (state[v] === 0) dfs(v)
    state[u] = 2
    order.push(u)
  }
  for (let i = 0; i < ids.length; i++) if (state[i] === 0) dfs(i)
  const topo = order.reverse()
  const rank = new Int32Array(ids.length)
  const done = new Uint8Array(ids.length)
  for (const u of topo) {
    done[u] = 1
    for (const v of out[u]) if (!done[v]) rank[v] = Math.max(rank[v], rank[u] + 1)
  }

  // Bands: one per group (declaration order), then the ungrouped nodes.
  const bandOf = (i: number) => {
    const g = d.nodes[i].group
    const k = g ? groupIds.indexOf(g) : -1
    return k >= 0 ? k : groupIds.length
  }
  const bands = new Map<number, number[]>()
  d.nodes.forEach((_, i) => bands.set(bandOf(i), [...(bands.get(bandOf(i)) ?? []), i]))

  // Layer extents along the flow: widest node in each rank.
  const along = (i: number) => (horizontal ? widthOf(d.nodes[i].label) : heightOf(d.nodes[i].label))
  const across = (i: number) => (horizontal ? heightOf(d.nodes[i].label) : widthOf(d.nodes[i].label))
  const maxRank = ids.length ? Math.max(...Array.from(rank)) : 0
  const layerSize: number[] = []
  for (let r = 0; r <= maxRank; r++) layerSize[r] = Math.max(0, ...ids.map((_, i) => (rank[i] === r ? along(i) : 0)))
  const layerStart: number[] = []
  let acc = 40
  for (let r = 0; r <= maxRank; r++) {
    layerStart[r] = acc
    acc += layerSize[r] + rankGap
  }
  const flowExtent = acc - rankGap + 40

  const g = emptyGeometry()
  let bandStart = 40
  for (const [band, members] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    const isGroup = band < groupIds.length
    const inner = bandStart + (isGroup ? framePad + frameTitle : 0)
    // Within the band, nodes of the same rank stack across the flow.
    const perRank = new Map<number, number[]>()
    for (const i of members) perRank.set(rank[i], [...(perRank.get(rank[i]) ?? []), i])
    let bandExtent = 0
    for (const [r, list] of perRank) {
      let cursor = inner
      for (const i of list) {
        const w = widthOf(d.nodes[i].label)
        const h = heightOf(d.nodes[i].label)
        const flowCentre = layerStart[r] + layerSize[r] / 2
        const acrossCentre = cursor + across(i) / 2
        g.nodes[d.nodes[i].id] = { x: horizontal ? flowCentre : acrossCentre, y: horizontal ? acrossCentre : flowCentre, width: w, height: h, shape: d.nodes[i].shape, fill: d.nodes[i].attrs.fillcolor, stroke: d.nodes[i].attrs.color, color: d.nodes[i].attrs.fontcolor, dashed: /dashed|dotted/.test(d.nodes[i].attrs.style ?? '') }
        cursor += across(i) + nodeGap
      }
      bandExtent = Math.max(bandExtent, cursor - nodeGap - inner)
    }
    if (isGroup) {
      const grp = d.groups[band]
      const ranks = [...perRank.keys()]
      const flowMin = Math.min(...ranks.map((r) => layerStart[r])) - framePad
      const flowMax = Math.max(...ranks.map((r) => layerStart[r] + layerSize[r])) + framePad
      const acrossMin = bandStart
      const acrossMax = inner + bandExtent + framePad
      g.groups[grp.id] = horizontal
        ? { x: flowMin, y: acrossMin, width: flowMax - flowMin, height: acrossMax - acrossMin, stroke: grp.attrs.color ?? '#9ca3af', label: { x: flowMin + 10, y: acrossMin + 18 } }
        : { x: acrossMin, y: flowMin, width: acrossMax - acrossMin, height: flowMax - flowMin, stroke: grp.attrs.color ?? '#9ca3af', label: { x: acrossMin + 10, y: flowMin + 18 } }
      bandStart = acrossMax + nodeGap * 1.5
    } else bandStart = inner + bandExtent + nodeGap * 1.5
  }
  const acrossExtent = bandStart + 40

  for (const e of d.edges) {
    const a = g.nodes[e.source]
    const b = g.nodes[e.target]
    if (!a || !b) continue
    g.edges[e.id] = { points: straightRoute(a, b), curve: 'line', stroke: e.attrs.color, dashed: e.style === 'dotted' || e.style === 'dashed' || /dashed|dotted/.test(e.attrs.style ?? ''), arrowEnd: e.directed, label: e.label ? mid(a, b) : undefined }
  }
  g.width = horizontal ? flowExtent : acrossExtent
  g.height = horizontal ? acrossExtent : flowExtent
  return g
}

const mid = (a: NodeGeom, b: NodeGeom) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

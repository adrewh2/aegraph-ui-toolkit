import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel } from '../core/entity/entity'
import type { EntityId } from '../core/entity/types'
import { FIELD_OPS } from '../core/graph/fields'
import { applyFilter, describeFilter, type FilterSpec, type GraphSlice } from '../core/graph/filter'
import { computeLayout, DEFAULT_LAYOUT_PARAMS, LAYOUTS, type LayoutAlgorithm } from '../core/graph/layouts'
import { hierarchyOf } from '../core/graph/tree'
import { computeMetrics, DEFAULT_METRICS, METRIC_IDS, metricInfo, serializeSlice, topK, writeMetricsToEntities, createAnalysisEntity, type NodeMetricId } from '../core/graph/metrics'
import { json } from '../features/assistant/toolkit'
import type { HeadlessEngine } from './engine'

/**
 * The graph, computed rather than drawn.
 *
 * In the tab these questions are asked of the explorer — a filter changes
 * what a canvas shows, a layout moves nodes on it, metrics colour them.
 * Headless there is no canvas, so the same three computations answer in
 * numbers: what the filter selects, what the structure is worth, where a
 * layout would put things. The filter and layout vocabularies are the
 * explorer's own (`core/graph`), so a scene built here and one built in the
 * app come from the same code.
 */

export const FILTER_PROPS = {
  types: { type: 'array', items: { type: 'string' }, description: 'Entity types to include; empty = all' },
  relationship_types: { type: 'array', items: { type: 'string' } },
  tags: { type: 'array', items: { type: 'string' }, description: 'Keep only nodes carrying any (tag_mode all: every one) of these' },
  tag_mode: { type: 'string', enum: ['any', 'all'] },
  exclude_tags: { type: 'array', items: { type: 'string' } },
  text: { type: 'string', description: 'Full-text match on label/description/data' },
  min_degree: { type: 'integer', minimum: 0 },
  hide_isolated: { type: 'boolean' },
  roots: { type: 'array', items: { type: 'string' }, description: 'Entity ids to centre on' },
  depth: { type: 'integer', minimum: 1, description: 'Hops from the roots (default 1)' },
  direction: { type: 'string', enum: ['out', 'in', 'both'] },
  max_nodes: { type: 'integer', minimum: 1 },
  max_degree: { type: 'integer', minimum: 0 },
  k_core: { type: 'integer', minimum: 0, description: 'Keep only the k-core; 0 = off' },
  backbone: { type: 'string', enum: ['disparity', 'simmelian', 'spanning'], description: 'Keep only the edges that carry the structure: disparity (Serrano et al., needs weights), simmelian (each node\'s most embedded edges), spanning (the maximum spanning forest)' },
  backbone_alpha: { type: 'number', minimum: 0.001, maximum: 0.9 },
  backbone_k: { type: 'integer', minimum: 1, maximum: 20 },
  weight_field: { type: 'string', description: 'Where an edge\'s weight lives, e.g. data.score' },
  component_min: { type: 'integer', minimum: 0 },
  giant_only: { type: 'boolean' },
  only: { type: 'array', items: { type: 'string' }, description: 'Keep only these entity ids' },
  exclude: { type: 'array', items: { type: 'string' } },
  fields: {
    type: 'array',
    description: 'Attribute conditions, all of which must hold, e.g. {path:"data.year", op:"gte", value:1900}',
    items: { type: 'object', properties: { path: { type: 'string' }, op: { type: 'string', enum: FIELD_OPS.map((o) => o.id) }, value: {} }, required: ['path', 'op'], additionalProperties: false },
  },
} as const

export type FilterInput = {
  types?: string[]
  relationship_types?: string[]
  tags?: string[]
  tag_mode?: string
  exclude_tags?: string[]
  text?: string
  min_degree?: number
  hide_isolated?: boolean
  roots?: string[]
  depth?: number
  direction?: string
  max_nodes?: number
  max_degree?: number
  k_core?: number
  backbone?: string
  backbone_alpha?: number
  backbone_k?: number
  weight_field?: string
  component_min?: number
  giant_only?: boolean
  only?: string[]
  exclude?: string[]
  fields?: { path: string; op: string; value?: unknown }[]
}

export const specFrom = (i: FilterInput): FilterSpec => ({
  types: i.types,
  relationshipTypes: i.relationship_types,
  tags: i.tags,
  tagMode: i.tag_mode as FilterSpec['tagMode'],
  excludeTags: i.exclude_tags,
  text: i.text,
  minDegree: i.min_degree,
  hideIsolated: i.hide_isolated,
  roots: i.roots,
  depth: i.depth,
  direction: i.direction as FilterSpec['direction'],
  maxNodes: i.max_nodes,
  maxDegree: i.max_degree,
  kCore: i.k_core,
  backbone: i.backbone as FilterSpec['backbone'],
  backboneAlpha: i.backbone_alpha,
  backboneK: i.backbone_k,
  weightField: i.weight_field,
  componentMin: i.component_min,
  giantOnly: i.giant_only,
  only: i.only,
  exclude: i.exclude,
  fields: i.fields as FilterSpec['fields'],
})

const countBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, number>()
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1)
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 25))
}

/** The tree the tree layout drew: how many roots it hung the slice under, how deep it got, and what it could not use. */
function hierarchy(slice: GraphSlice, follow: 'out' | 'in' | 'any' | 'auto' | undefined) {
  const h = hierarchyOf(slice, { follow: follow ?? 'auto' })
  let maxDepth = 0
  for (const d of h.depth) if (d > maxDepth) maxDepth = d
  const perDepth = new Array<number>(maxDepth + 1).fill(0)
  for (const d of h.depth) perDepth[d]++
  return { roots: h.roots.length, maxDepth, nodesPerDepth: perDepth.slice(0, 12), crossLinks: h.extra }
}

export function createHeadlessGraphTools(engine: HeadlessEngine) {
  const sliceOf = (input: FilterInput): { spec: FilterSpec; slice: GraphSlice } => {
    const spec = specFrom(input)
    return { spec, slice: applyFilter(engine.store, engine.registry(), spec) }
  }
  const top = (slice: GraphSlice, n: number) =>
    [...slice.degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id, degree]) => {
        const e = engine.store.get(id)
        return { id, label: e ? displayLabel(e) : id, type: e?.type ?? '?', degree }
      })

  const graphSlice = betaTool({
    name: 'graph_slice',
    description: 'What a filter selects from the workspace, without drawing it: node and edge counts, the breakdown by entity and relationship type, connected components, and the highest-degree nodes. The filter vocabulary is the graph explorer\'s own, so what this reports is exactly what the app would show. Use it to size a view before laying it out or analysing it.',
    inputSchema: { type: 'object', properties: { ...FILTER_PROPS, top: { type: 'integer', minimum: 0, maximum: 100, description: 'How many highest-degree nodes to list (default 10)' } }, additionalProperties: false } as const,
    run: (input) => {
      const { spec, slice } = sliceOf(input as FilterInput)
      const degrees = [...slice.degree.values()]
      return json({
        filter: describeFilter(spec),
        nodes: slice.nodes.length,
        edges: slice.edges.length,
        candidates: slice.candidates,
        truncated: slice.truncated || undefined,
        components: slice.components,
        isolated: degrees.filter((d) => d === 0).length,
        meanDegree: slice.nodes.length ? Math.round((degrees.reduce((a, b) => a + b, 0) / slice.nodes.length) * 100) / 100 : 0,
        types: countBy(slice.nodes, (n) => n.type),
        relationshipTypes: countBy(slice.edges, (e) => e.type),
        top: top(slice, (input as { top?: number }).top ?? 10),
      })
    },
  })

  const graphMetrics = betaTool({
    name: 'graph_metrics',
    description: `Run graph analytics over what a filter selects: ${METRIC_IDS.join(', ')}. Returns each metric's range and its top nodes, plus community sizes. With write: true the values are written onto the entities (data.<metric>), so filters, tables and plots can use them afterwards; with save: a label, the whole result is kept as an analysis entity. This is the same computation the app runs in its worker — heavy metrics (betweenness, closeness) sample above a few thousand nodes.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPS,
        metrics: { type: 'array', items: { type: 'string', enum: METRIC_IDS }, description: `Which metrics to compute (default: ${DEFAULT_METRICS.join(', ')})` },
        directed: { type: 'boolean', description: 'Honour relationship direction (default true)' },
        top: { type: 'integer', minimum: 0, maximum: 50, description: 'Top nodes per metric (default 5)' },
        write: { type: 'boolean', description: 'Write the values onto the entities as data.<metric>' },
        save: { type: 'string', description: 'Keep the whole result as an analysis entity with this label' },
      },
      additionalProperties: false,
    } as const,
    run: (input) => {
      const i = input as FilterInput & { metrics?: NodeMetricId[]; directed?: boolean; top?: number; write?: boolean; save?: string }
      const { spec, slice } = sliceOf(i)
      if (!slice.nodes.length) throw new Error(`That filter selects nothing (${describeFilter(spec)}). graph_slice shows what the workspace holds.`)
      const metrics = i.metrics?.length ? i.metrics : DEFAULT_METRICS
      const started = Date.now()
      const result = computeMetrics(serializeSlice(slice, i.weight_field), { metrics, weightField: i.weight_field, directed: i.directed ?? true })
      const label = (id: EntityId) => {
        const e = engine.store.get(id)
        return e ? displayLabel(e) : id
      }
      const columns: Record<string, unknown> = {}
      for (const m of metrics) {
        const col = result.columns[m]
        if (!col) continue
        const info = metricInfo(m)
        let min = Infinity
        let max = -Infinity
        let sum = 0
        for (const v of col) {
          if (v < min) min = v
          if (v > max) max = v
          sum += v
        }
        columns[m] = info.categorical
          ? { distinct: new Set(col).size, max }
          : {
              min: Math.round(min * 1e4) / 1e4,
              max: Math.round(max * 1e4) / 1e4,
              mean: Math.round((sum / col.length) * 1e4) / 1e4,
              top: topK(result, m, i.top ?? 5).map((t) => ({ id: t.id, label: label(t.id), value: Math.round(t.value * 1e4) / 1e4 })),
            }
      }
      const written = i.write ? writeMetricsToEntities(engine.store, result, metrics) : 0
      const analysis = i.save ? createAnalysisEntity(engine.store, i.save, result, { filter: spec }) : undefined
      return json({
        filter: describeFilter(spec),
        nodes: slice.nodes.length,
        edges: slice.edges.length,
        ms: Date.now() - started,
        warnings: result.summary.warnings?.length ? result.summary.warnings : undefined,
        communities: result.communities ? { count: result.communities.count, largest: result.communities.sizes.slice(0, 10) } : undefined,
        metrics: columns,
        written: written || undefined,
        analysis: analysis ? { id: analysis.id } : undefined,
      })
    },
  })

  const graphLayout = betaTool({
    name: 'graph_layout',
    description: `Lay out what a filter selects and report the result — the engine computes positions with no canvas to draw them on. ${LAYOUTS.map((l) => `${l.id} (${l.dims.join('/')}D)`).join(', ')}. Useful headless for checking that a layout reads as a structure before anyone opens it: a tree reports the hierarchy it found (roots, depth, the cross-links it could not draw), and every layout reports its extent. With write: true the positions are stored on the entities (data.x/y/z) so the app opens the view exactly as computed here.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPS,
        algorithm: { type: 'string', enum: LAYOUTS.map((l) => l.id), description: 'Which layout to compute' },
        dimensions: { type: 'integer', enum: [2, 3] },
        spacing: { type: 'number', minimum: 0, maximum: 10 },
        iterations: { type: 'integer', minimum: 1, maximum: 2000 },
        seed: { type: 'integer' },
        center_id: { type: 'string', description: 'Radial / concentric / tree: the node at the origin' },
        tree_follow: { type: 'string', enum: ['out', 'in', 'any', 'auto'], description: 'Tree: read edges as parent → child (out), child → parent (in), either way (any), or auto — the reading that finds the deepest hierarchy' },
        write: { type: 'boolean', description: 'Store the positions on the entities as data.x/y/z' },
      },
      required: ['algorithm'],
      additionalProperties: false,
    } as const,
    run: (input) => {
      const i = input as FilterInput & { algorithm: LayoutAlgorithm; dimensions?: 2 | 3; spacing?: number; iterations?: number; seed?: number; center_id?: string; tree_follow?: 'out' | 'in' | 'any' | 'auto'; write?: boolean }
      const { spec, slice } = sliceOf(i)
      if (!slice.nodes.length) throw new Error(`That filter selects nothing (${describeFilter(spec)}).`)
      const info = LAYOUTS.find((l) => l.id === i.algorithm)!
      const dimensions = (i.dimensions ?? (info.dims.includes(2) ? 2 : 3)) as 2 | 3
      if (!info.dims.includes(dimensions)) throw new Error(`The ${i.algorithm} layout is ${info.dims.join('/')}D only.`)
      const started = Date.now()
      const positions = computeLayout(i.algorithm, slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions, spacing: i.spacing ?? DEFAULT_LAYOUT_PARAMS.spacing, iterations: i.iterations ?? DEFAULT_LAYOUT_PARAMS.iterations, seed: i.seed ?? DEFAULT_LAYOUT_PARAMS.seed, centerId: i.center_id, treeFollow: i.tree_follow })
      const ms = Date.now() - started
      // How the picture would read: its extent, and whether the nodes fill it or pile up in the middle.
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      let n = 0
      for (const id of Object.keys(positions)) {
        const p = positions[id]
        if (!p) continue
        n++
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
        const z = p.z ?? 0
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      let written = 0
      if (i.write) {
        const placed = slice.nodes.filter((e) => positions[e.id]).map((e) => ({ ...e, data: { ...e.data, x: positions[e.id].x, y: positions[e.id].y, ...(dimensions === 3 ? { z: positions[e.id].z ?? 0 } : {}) } }))
        engine.store.upsertMany(placed)
        written = placed.length
      }
      const round = (v: number) => Math.round(v * 10) / 10
      return json({
        filter: describeFilter(spec),
        algorithm: i.algorithm,
        dimensions,
        nodes: slice.nodes.length,
        edges: slice.edges.length,
        positioned: n,
        ms,
        extent: { x: [round(minX), round(maxX)], y: [round(minY), round(maxY)], ...(dimensions === 3 ? { z: [round(minZ), round(maxZ)] } : {}) },
        // What a hierarchy layout is actually drawing. One depth under hundreds of roots is the "petri dish": a
        // mesh spread on a plane rather than a tree, and the reading (`tree_follow`) or the filter is what to change.
        hierarchy: i.algorithm === 'tree' ? hierarchy(slice, i.tree_follow) : undefined,
        written: written || undefined,
      })
    },
  })

  return [graphSlice, graphMetrics, graphLayout]
}

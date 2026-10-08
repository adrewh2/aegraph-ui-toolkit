import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { createEntity, displayLabel, parseTags } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { isRelationship, type AnyEntity } from '../../core/entity/types'
import { FIELD_OPS, type FieldPredicate } from '../../core/graph/fields'
import { drawCost, heapRoom, memoryGates, readHeap, shouldGate, viewLoad } from '../../core/graph/budget'
import { DEFAULT_MAX_NODES, applyFilter, describeFilter, emptyFilter, toFilterSpec, type FilterSpec } from '../../core/graph/filter'
import { DEFAULT_UNIGRAPH_FORCE, LAYOUTS, layoutAlgorithmOf, layoutInfo, layoutTooBig, type LayoutParams, type Positions } from '../../core/graph/layouts'
import { findGraphFormat, GRAPH_FORMATS } from '../../core/exchange/graph/graphFormats'

/** What an RDF import asks a server for: the serialisations the importer reads, best first. */
const RDF_ACCEPT = 'application/n-triples, text/turtle;q=0.9, application/n-quads;q=0.8, application/trig;q=0.7, text/plain;q=0.5'
import { applyGraphPlan, inferGraphMapping, planGraphImport, type GraphMappingSpec } from '../../core/exchange/graph/mapping'
import { svgFromView } from '../../core/exchange/graph/svg'
import { diagramFromEntities, writeDiagram } from '../../core/diagrams'
import { createDiagram } from '../diagrams/diagrams'
import { downloadBlob, downloadFiles } from '../graph/exportView'
import { entitiesToDocument } from '../../core/exchange/subset'
import { bboxOf, describePlacement, type LayoutRule, type PlacementSpec, type Region, type TransformOp } from '../../core/graph/placement'
import { buildProject, isProject, projectMembers, projectOverlay } from '../../core/graph/project'
import { describeSelector } from '../../core/graph/selector'
import { SELECTOR_SCHEMA, VALUE_REF_HELP, selectorFrom } from './schemas'
import { isValidValueRef, listValueRefs, makeValueContext, refIsStateful, refUsesMetrics, valueOf } from '../../core/graph/values'
import { GPU_MAX_NODES, GPU_VIEW_BUDGET } from '../graph/explorerState'
import { serialize } from '../../core/exchange/export'
import { loadParsed, parseFile } from '../../core/exchange/import'
import { columnStats, createAnalysisEntity, DEFAULT_METRICS, fromAnalysisData, METRIC_IDS, metricInfo, topK, writeMetricsToEntities, type NodeMetricId } from '../../core/graph/metrics'
import { PALETTES } from '../../core/graph/palettes'
import { DEFAULT_RENDERING, describeRendering, normEdgeRule, normNodeRule, setRule as setRenderingRule, toRenderingSpec, type RenderingData, type RenderingSpec } from '../../core/graph/rendering'
import { applyStyleChannels, SHAPE_IDS, type StyleChannelInput } from '../../core/graph/styleChannels'
import { GRAPH_TYPES, type AnalysisData, type FilterData, type LayoutData } from '../../core/graph/types'
import { GRAPH_SCENE_TYPES, graphSceneTypeFor } from '../../core/graph/scene'
import { applySelect } from '../../core/graph/selection'
import { flyCamera, lookCamera } from '../../core/graph/flyCamera'
import { getCameraControls, setCameraControls } from '../graph/cameraControls'
import { getExplorerHandle, waitForExplorer, type ExplorerHandle } from '../graph/explorerHandle'
import { applyStyleScript } from '../scripts/styles'
import { applyLayoutScript } from '../scripts/layouts'
import { blobToBase64, brief, fetchHandedUrl, json, requireEntity, summarize } from './toolkit'
import type { AppHost } from './tools'
import { runFilterScript, type FilterRun } from '../scripts/filters'

/**
 * The graph explorer: state, filter, layout, style, save, metrics, export/import, queries, positions, viewport, pipeline projects, selection, paths.
 */

const LAYOUT_IDS = LAYOUTS.map((l) => l.id)

const RECT_SCHEMA = { type: 'object', properties: { min_x: { type: 'number' }, min_y: { type: 'number' }, max_x: { type: 'number' }, max_y: { type: 'number' } }, required: ['min_x', 'min_y', 'max_x', 'max_y'], additionalProperties: false } as const

const PLACEMENT_SCHEMA = {
  type: 'object',
  properties: {
    arrangement: { type: 'string', enum: ['grid', 'scatter', 'circle', 'line', 'stack', 'geo'], description: 'grid: rows/cols (order by `order`); scatter: x/y(/z) from values, add bins for a heatmap grid; circle: around the region centre (x → angle, y → radius); line: x only; stack: columns per category of x; geo: every node where it is on Earth (Web Mercator of y = latitude, default data.lat, and x = longitude, default data.lng), north up, the shape kept' },
    x: { type: 'string', description: 'ValueRef for the x axis (stack: the category)' },
    y: { type: 'string', description: 'ValueRef for the y axis' },
    z: { type: 'string', description: 'ValueRef for z (3D)' },
    bins: { type: 'object', properties: { x: { type: 'integer', minimum: 1, maximum: 60 }, y: { type: 'integer', minimum: 1, maximum: 60 } }, additionalProperties: false, description: 'Snap into cells; nodes sharing a cell are packed on a spiral' },
    scale: { type: 'string', enum: ['linear', 'log', 'rank'], description: 'How values map to the axis; rank spreads evenly regardless of distribution' },
    order: { type: 'string', description: 'ValueRef to order nodes by (grid, circle)' },
    desc: { type: 'boolean' },
    cols: { type: 'integer', minimum: 1, description: 'grid columns (default ~sqrt(n))' },
    spacing: { type: 'number', description: 'grid/stack cell size in graph units (default: fill the region)' },
    jitter: { type: 'string', enum: ['spiral', 'none'] },
    aspect: { type: 'string', enum: ['free', 'equal'], description: 'scatter: free (default) stretches each axis to fill the region; equal keeps one scale for both, fitted and centred — for axes in the same unit' },
    geo: { type: 'boolean', description: 'scatter: x is longitude and y latitude — equal scale with a degree east shortened by cos(latitude), so the picture keeps the map\'s shape. On by default when the refs are lng/lon × lat; false to draw degree for degree' },
    region: {
      type: 'object',
      properties: {
        of: { type: 'string', enum: ['viewport', 'bbox', 'rect'], description: 'viewport (default): what is on screen; bbox: all held positions; rect: explicit' },
        rect: RECT_SCHEMA,
        anchor: { type: 'string', enum: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] },
        fraction: { type: 'number', minimum: 0.05, maximum: 1, description: 'Size as a fraction of the base (default 1)' },
        width: { type: 'number', description: 'Absolute size in graph units (with height)' },
        height: { type: 'number' },
        margin: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  required: ['arrangement'],
  additionalProperties: false,
} as const

const TRANSFORM_SCHEMA = {
  type: 'object',
  properties: {
    translate: { type: 'object', properties: { dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' } }, additionalProperties: false },
    scale: { type: 'number', description: 'Uniform scale about the group centroid (or `about`)' },
    rotate: { type: 'number', description: 'Degrees, xy plane' },
    about: { type: 'string', enum: ['centroid', 'origin'] },
    align: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center-x', 'center-y'], description: 'Move the group so its edge meets `to` (default: the viewport)' },
    distribute: { type: 'string', enum: ['x', 'y'], description: 'Equal gaps along an axis' },
    to: RECT_SCHEMA,
  },
  additionalProperties: false,
} as const

/** Selection-free summary of the explorer for context and the graph tools. */
function describeExplorer(h: ExplorerHandle) {
  const st = h.getState()
  const slice = h.getSlice()
  return {
    mode: h.renderer ?? (h.dims === 3 ? ('3d' as const) : ('2d' as const)),
    filter: describeFilter(st.filter),
    layout: `${layoutInfo(st.algorithm).label} · ${Object.keys(st.positions).length} positions held`,
    style: describeRendering(st.rendering),
    nodes: slice.nodes.length,
    edges: slice.edges.length,
    selectedId: st.selectedId,
    selected: st.selectedIds.length,
    metrics: st.metricsSummary ? `${Object.keys(h.getMetrics()?.columns ?? {}).join(', ')}${st.metricsStale ? ' (stale)' : ''}` : undefined,
  }
}


export function createGraphTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)
  /** The open Unigraph, or open it (2D unless asked otherwise) and wait for it to mount. `gpu`/`gpu3d` are the old names of its views. */
  async function explorer(mode?: '2d' | '3d' | 'gpu' | 'gpu3d'): Promise<ExplorerHandle> {
    const current = getExplorerHandle()
    const rendererOf = (h: ExplorerHandle) => h.renderer ?? (h.dims === 3 ? '3d' : '2d')
    const want: '2d' | '3d' = mode === '3d' || mode === 'gpu3d' ? '3d' : mode ? '2d' : current ? rendererOf(current) : '2d'
    if (current && rendererOf(current) === want) return current
    // An open Unigraph switches its own canvas (keeping its tab and state); otherwise the page is opened.
    if (current) current.switchMode(want)
    else host.navigate(`/unigraph/${want}`)
    const h = await waitForExplorer(want === '3d' ? 3 : 2)
    if (!h) throw new Error('Unigraph did not open. Navigate to /unigraph/2d in the app and try again.')
    return h
  }

  /** Filter context matching the explorer's: a loaded project's members and value overlay, with degree refs counted over the dataset stage. */
  const filterCtxFor = (h: ExplorerHandle) => {
    const p = h.getState().projectId ? store.get(h.getState().projectId!) : undefined
    const project = isProject(p) ? p : undefined
    const members = project ? projectMembers(project) : undefined
    return { members, values: makeValueContext({ scope: 'dataset', store, overlay: project ? projectOverlay(project) : undefined }) }
  }
  /** A filter as a reply shows it: long id lists (roots, exclusions) cut to a few with a count, never hundreds of ids. */
  const compactSpec = (spec: FilterSpec) => {
    const cut = (ids: string[] | undefined) => (ids && ids.length > 8 ? [...ids.slice(0, 5), `… +${ids.length - 5} more (${ids.length} in all)`] : ids)
    return { ...spec, ...(spec.roots ? { roots: cut(spec.roots) } : {}), ...(spec.exclude ? { exclude: cut(spec.exclude) } : {}), ...(spec.include ? { include: cut(spec.include) } : {}) }
  }
  const savedOf = (type: string | readonly string[]) => store.query({ type: typeof type === 'string' ? [type] : [...type] }).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)).map((e) => ({ id: e.id, label: displayLabel(e), updatedAt: e.meta.updatedAt, ...(typeof type !== 'string' ? { type: e.type } : {}) }))

  // ── Graph explorer ────────────────────────────────────────────────────

  /** Sections of the full `graph_state` reply that a brief call can ask for by name. */
  const BRIEF_EXTRAS = ['filterSpec', 'params', 'rendering', 'pinned', 'path', 'pathOptions', 'analysis', 'pipeline', 'layoutRule', 'viewport', 'valueRefs', 'saved', 'algorithms', 'metricIds', 'palettes', 'selected', 'components', 'labels', 'showEdges', 'hops', 'legend', 'tool'] as const

  const graphState = betaTool({
    name: 'graph_state',
    description:
      'What the graph explorer is showing: the active filter, layout algorithm, display style, selection, node/edge counts (`nodesByType` in view beside `projectNodesByType` in the whole project — the "x of y" of the filter panel), and the saved filters, layouts and styles that can be loaded. Opens the 2D explorer if none is open. Prefer `brief: true` — the essentials in a few hundred bytes — and add the full sections you need with `include` (e.g. ["rendering", "valueRefs"]); without either, the whole picture comes back (style rules, palettes, algorithms, every value ref, every saved item), which is tens of KB.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'boolean', description: 'Only the essentials: mode, descriptions, counts, ids of the loaded parts, selection, dataset, load/gate, physics and layout status, saved-item counts' },
        include: { type: 'array', items: { type: 'string', enum: BRIEF_EXTRAS }, description: 'Sections of the full reply to add to a brief one' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ brief: wantBrief, include }) => {
      const h = await explorer()
      const st = h.getState()
      const slice = h.getSlice()
      const byType = new Map<string, number>()
      for (const n of slice.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
      const full = {
        ...describeExplorer(h),
        filterSpec: compactSpec(st.filter),
        filterId: st.filterId,
        filterDirty: st.filterDirty,
        algorithm: st.algorithm,
        params: st.params,
        layoutId: st.layoutId,
        layoutDirty: st.layoutDirty,
        /** A big force layout still being computed in a worker; the view shows seed positions until it lands. */
        layoutRunning: st.layoutRunning,
        /** Why the last layout run gave no positions (an engine refused or failed). */
        layoutError: st.layoutError,
        /** What the view asks of the renderer and whether the large-graph gate is holding it back. */
        load: { ...h.getLoad(), budget: st.viewBudget, gated: h.isGated(), ...(h.gateReason() ? { reason: h.gateReason() } : {}) },
        rendering: st.rendering,
        renderingId: st.renderingId,
        renderingDirty: st.renderingDirty,
        labels: st.labels,
        showEdges: st.showEdges,
        physics: st.physics,
        selection: { count: st.selectedIds.length, primary: st.selectedId, ids: st.selectedIds.slice(-50), labels: st.selectedIds.slice(-50).map((id) => brief(store, id)) },
        selectedEdge: st.selectedEdgeId ? summarize(store.get(st.selectedEdgeId)!) : undefined,
        pinned: st.pinned,
        tool: st.tool,
        pathOptions: st.pathOptions,
        path: st.path ? { from: st.path.from, to: st.path.to, length: st.path.length, weight: st.path.weight, nodes: st.path.nodes.map((id) => brief(store, id)), edges: st.path.edges } : undefined,
        hops: st.hops,
        components: slice.components,
        metrics: st.metricsSummary ? { summary: st.metricsSummary, columns: Object.keys(h.getMetrics()?.columns ?? {}), stale: st.metricsStale, running: st.metricsRunning, analysisId: st.analysisId } : undefined,
        analysis: { auto: st.analysisAuto, options: st.analysisOptions, stale: st.metricsStale, computed: Object.keys(h.getMetrics()?.columns ?? {}) },
        dataset: { ...h.getDataset(), projectId: st.projectId, breadcrumb: h.getDataset().breadcrumb.map((b) => b.label) },
        pipeline: h.getPipeline(),
        layoutRule: st.layoutRule ? { ...st.layoutRule, description: describePlacement(st.layoutRule.spec) } : undefined,
        viewport: h.getViewport(),
        valueRefs: listValueRefs(h.getValueContext()).filter((r) => r.available).slice(0, 80).map((r) => `${r.ref}${r.kind === 'categorical' ? ' (categorical)' : ''}`),
        legend: st.showLegend,
        truncated: slice.truncated,
        nodesByType: Object.fromEntries(byType),
        /** Each node type's total in the project before the filter: with `nodesByType`, the filter panel's "x of y". */
        projectNodesByType: Object.fromEntries(h.getTotals().types),
        selected: st.selectedId && store.get(st.selectedId) ? summarize(store.get(st.selectedId)!) : undefined,
        saved: { filters: savedOf(GRAPH_TYPES.filter), layouts: savedOf(GRAPH_TYPES.layout), styles: savedOf(GRAPH_TYPES.rendering), analyses: savedOf(GRAPH_TYPES.analysis), projects: savedOf(GRAPH_TYPES.project), scenes: savedOf(GRAPH_SCENE_TYPES) },
        algorithms: LAYOUTS.map((l) => ({ id: l.id, label: l.label, dims: l.dims })),
        metricIds: METRIC_IDS,
        palettes: PALETTES.map((p) => ({ id: p.id, kind: p.kind })),
      }
      if (!wantBrief && !include?.length) return json(full)
      // The brief reply: what a next call needs to be well-formed, and nothing an agent can look up when it wants it.
      const short: Record<string, unknown> = {
        ...describeExplorer(h),
        filterId: st.filterId,
        layoutId: st.layoutId,
        renderingId: st.renderingId,
        sceneId: st.sceneId,
        algorithm: st.algorithm,
        physics: st.physics,
        layoutRunning: st.layoutRunning,
        layoutError: st.layoutError,
        load: full.load,
        selection: { count: st.selectedIds.length, primary: st.selectedId, labels: st.selectedIds.slice(-10).map((id) => brief(store, id)) },
        selectedEdge: full.selectedEdge,
        dataset: full.dataset,
        nodesByType: full.nodesByType,
        truncated: slice.truncated,
        metrics: st.metricsSummary ? { columns: full.analysis.computed, stale: st.metricsStale, running: st.metricsRunning } : undefined,
        savedCounts: Object.fromEntries(Object.entries(full.saved).map(([k, v]) => [k, v.length])),
        hint: 'Pass include: [...] for any of ' + BRIEF_EXTRAS.join(', ') + '.',
      }
      for (const k of include ?? []) if (k in full) short[k] = (full as Record<string, unknown>)[k]
      return json(short)
    },
  })

  const graphFilter = betaTool({
    name: 'graph_filter',
    description:
      'Change what the graph explorer shows. Fields patch the current filter (arrays replace the field; pass [] to lift a constraint); set `replace` to start from an empty filter, `clear` to show everything, or `filter_id` to load a saved filter. Roots + depth restrict the view to a neighbourhood. `script` runs a saved script as a filter: the view keeps just the entities it returns (`only`) and remembers the script, so the same call runs it again; `only: []` lifts it. Returns the resulting node/edge counts. A view is gated — the page shows a breakdown by type instead of the canvas until it is trimmed or accepted — when it is past what the engine draws without asking (2,000,000 nodes / 10,000,000 edges, or a higher `view_budget`), or when drawing it would take more memory than this tab can spare (the result says `reason: "memory"` and how much: a million-node view of a big project, such as the WildChat atlas with its filter cleared, closes the tab). Trim with `types` / `relationship_types` / `max_nodes`. `accept_large: true` draws it anyway; past memory that may crash the tab and lose unsaved work, so only when the user asks for it after being told.',
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: 'Entity types to include; empty = all' },
        relationship_types: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keep only nodes carrying any (tag_mode all: every one) of these' },
        tag_mode: { type: 'string', enum: ['any', 'all'] },
        exclude_tags: { type: 'array', items: { type: 'string' }, description: 'Drop nodes carrying any of these tags' },
        text: { type: 'string', description: 'Full-text match on label/description/data' },
        min_degree: { type: 'integer', minimum: 0 },
        hide_isolated: { type: 'boolean' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Entity ids to centre on' },
        roots_match: {
          type: 'object',
          description: 'Centre on every entity matching this instead of listing ids: "the segments tagged topic:philosophy and everything around them" is {roots_match: {types: [\'segment\'], tags: [\'topic:philosophy\']}, depth: 1}. Any of the types, any of the tags (all with tag_mode "all"), text anywhere in the entity; resolved over the Dataset stage.',
          properties: { types: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, tag_mode: { type: 'string', enum: ['any', 'all'] }, text: { type: 'string' } },
          additionalProperties: false,
        },
        depth: { type: 'integer', minimum: 1, description: 'Hops from the roots (default 1)' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Which way to expand from the roots (default both)' },
        max_nodes: { type: 'integer', minimum: 1 },
        max_degree: { type: 'integer', minimum: 0, description: 'Degree ceiling; 0 = off' },
        k_core: { type: 'integer', minimum: 0, description: 'Keep only the k-core; 0 = off' },
        backbone: { type: 'string', enum: ['disparity', 'simmelian', 'spanning', 'off'], description: 'Keep only the edges that carry the structure — what makes a similarity mesh readable. `disparity`: Serrano et al.\'s multiscale backbone, each edge kept where it is a bigger share of a node\'s strength than chance would give at `backbone_alpha` (needs weights, see `weight_field`). `simmelian`: each node keeps its `backbone_k` most embedded edges (the endpoints\' neighbourhoods overlap most) — the one to use on an unweighted nearest-neighbour graph. `spanning`: the maximum spanning forest, one connected skeleton with no cycles, which the tree layout draws exactly. Use a backbone on a *mesh* — similarity, co-occurrence, correlation; containment relationships (in-cluster, nested-in…) are already a hierarchy and want the relationship-type filter, not a backbone. `off` lifts it.' },
        backbone_alpha: { type: 'number', minimum: 0.001, maximum: 0.9, description: 'disparity: significance, 0.01 (severe) … 0.5 (gentle). Default 0.05' },
        backbone_k: { type: 'integer', minimum: 1, maximum: 20, description: 'simmelian: edges kept per node. Default 3' },
        weight_field: { type: 'string', description: 'Where an edge\'s weight lives, e.g. data.score; absent, every edge weighs 1' },
        component_min: { type: 'integer', minimum: 0, description: 'Drop components smaller than this' },
        giant_only: { type: 'boolean', description: 'Keep only the largest connected component' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Entity ids to hide; [] unhides all' },
        include: { type: 'array', items: { type: 'string' }, description: 'Entity ids to bring into the view whatever the other criteria say (linked entities added by hand); [] removes them all' },
        only: { type: 'array', items: { type: 'string' }, description: 'Keep only these entity ids (the other criteria still apply on top); [] lifts the restriction — and the filter script with it' },
        script: { type: 'string', description: 'A saved script to run as the filter (see the script tool): what it returns — a collection, a list of ids, a table with an id column — becomes `only`, and the script becomes a filter script (script:filter) if it has no kind yet' },
        fields: {
          type: 'array',
          description: 'Attribute conditions, all of which must hold, e.g. {path:"data.year", op:"gte", value:1900} or {path:"degree.in:cites", op:"gt", value:3}. path is a ValueRef (data.<key>, meta.updatedAt, label, type, tags, degree[.in|.out][:relType]). metric.* is NOT allowed here — a filter runs before the analysis; export a project and filter its data.<metric> instead.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, op: { type: 'string', enum: FIELD_OPS.map((o) => o.id) }, value: { description: 'Scalar; [lo, hi] for between; list for in; omitted for exists' } },
            required: ['path', 'op'],
            additionalProperties: false,
          },
        },
        replace: { type: 'boolean', description: 'Start from an empty filter instead of patching the current one' },
        clear: { type: 'boolean', description: 'Show everything' },
        filter_id: { type: 'string', description: 'Saved filter entity to load' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'], description: 'Which view of Unigraph (default: the open one, else 2d): flat (2d) or in three dimensions (3d); gpu and gpu3d are their old names' },
        accept_large: { type: 'boolean', description: 'Draw the resulting view even when it is gated (the gate is skipped). Past memory (reason "memory") this may crash the tab: only when the user asks after being told.' },
        view_budget: { type: 'object', properties: { nodes: { type: 'integer', minimum: 100 }, edges: { type: 'integer', minimum: 100 } }, additionalProperties: false, description: 'How many nodes / edges the explorer draws without asking' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ types, relationship_types, tags, tag_mode, exclude_tags, text, min_degree, hide_isolated, roots, roots_match, depth, direction, max_nodes, max_degree, k_core, backbone, backbone_alpha, backbone_k, weight_field, component_min, giant_only, exclude, include, only, script, fields, replace, clear, filter_id, mode, accept_large, view_budget }) => {
      const h = await explorer(mode)
      let scriptRun: FilterRun | undefined
      if (script) {
        scriptRun = await runFilterScript(store, registry(), script)
        if (scriptRun.error) throw new Error(`The filter script failed: ${scriptRun.error}`)
        only = scriptRun.ids
      }
      if (view_budget) h.setViewBudget({ ...h.getState().viewBudget, ...view_budget })
      let matchedRoots: number | undefined
      if (roots_match) {
        const { members } = filterCtxFor(h)
        const anyTags = roots_match.tag_mode !== 'all' && roots_match.tags?.length ? roots_match.tags : undefined
        const found = store.query({
          kind: 'entity',
          type: roots_match.types?.length ? roots_match.types : undefined,
          tags: roots_match.tag_mode === 'all' ? roots_match.tags : undefined,
          text: roots_match.text?.trim() || undefined,
          predicate: (e) => !e.type.startsWith('schema:') && (!members || members.has(e.id)) && (!anyTags || anyTags.some((t) => e.tags.includes(t))),
        })
        if (!found.length) throw new Error('roots_match matched nothing: check the types and tags with list_entity_types / list_tags.')
        roots = [...new Set([...(roots ?? []), ...found.map((e) => e.id)])]
        matchedRoots = found.length
      }
      let next: FilterSpec
      let loaded: string | undefined
      if (clear) {
        h.clearFilter()
        next = emptyFilter()
      } else if (filter_id) {
        const e = requireEntity(store, filter_id)
        if (e.type !== GRAPH_TYPES.filter) throw new Error(`Entity ${filter_id} is a ${e.type}, not a saved filter.`)
        next = toFilterSpec(e.data as FilterData)
        h.loadFilter(e.id, next)
        loaded = displayLabel(e)
      } else {
        for (const id of roots ?? []) requireEntity(store, id)
        const patch: FilterSpec = {}
        if (types) patch.types = types
        if (relationship_types) patch.relationshipTypes = relationship_types
        if (tags) patch.tags = tags
        if (tag_mode) patch.tagMode = tag_mode
        if (exclude_tags) patch.excludeTags = exclude_tags
        if (text !== undefined) patch.text = text
        if (min_degree !== undefined) patch.minDegree = min_degree
        if (hide_isolated !== undefined) patch.hideIsolated = hide_isolated
        if (roots) patch.roots = roots
        if (depth !== undefined) patch.depth = depth
        if (direction) patch.direction = direction
        if (max_nodes !== undefined) patch.maxNodes = max_nodes
        if (max_degree !== undefined) patch.maxDegree = max_degree
        if (k_core !== undefined) patch.kCore = k_core
        if (backbone !== undefined) patch.backbone = backbone === 'off' ? undefined : (backbone as FilterSpec['backbone'])
        if (backbone_alpha !== undefined) patch.backboneAlpha = backbone_alpha
        if (backbone_k !== undefined) patch.backboneK = backbone_k
        if (weight_field !== undefined) patch.weightField = weight_field || undefined
        if (component_min !== undefined) patch.componentMin = component_min
        if (giant_only !== undefined) patch.giantOnly = giant_only
        if (exclude) patch.exclude = exclude
        if (include) patch.include = include
        if (only) {
          patch.only = only
          patch.script = only.length ? script : undefined
          if (only.length) patch.roots = []
        }
        if (fields) {
          for (const f of fields) {
            if (!isValidValueRef(f.path)) throw new Error(`Unknown field path "${f.path}". ${VALUE_REF_HELP}`)
            if (refIsStateful(f.path)) throw new Error(`"${f.path}" cannot be used in a filter (it would change the view it depends on). Use graph_selection instead.`)
            if (refUsesMetrics(f.path)) throw new Error(`"${f.path}" cannot be used in a filter: the filter runs before the analysis. Run graph_metrics, graph_project {action:'export'}, load the project, then filter on data.${f.path.slice(7)}.`)
          }
          patch.fields = fields as FieldPredicate[]
        }
        if (!Object.keys(patch).length && !replace && !accept_large && !view_budget) throw new Error('Nothing to change: pass filter fields, replace, clear, filter_id, accept_large or view_budget.')
        next = { ...(replace ? emptyFilter() : h.getState().filter), ...patch }
        h.setFilter(next)
      }
      // The same cap the explorer applies: its engine draws up to GPU_MAX_NODES when the filter's own Max nodes is
      // unset or the old default, so the counts reported here are the picture's, not a 20,000-node slice of it.
      const effective = next.maxNodes === undefined || next.maxNodes === DEFAULT_MAX_NODES ? { ...next, maxNodes: GPU_MAX_NODES } : next
      const slice = applyFilter(store, registry(), effective, filterCtxFor(h))
      const load = viewLoad(slice)
      // The explorer's own rule: the engine's budget (or a higher one the user set), and this tab's memory.
      const set = h.getState().viewBudget
      const budget = { nodes: Math.max(set.nodes, GPU_VIEW_BUDGET.nodes), edges: Math.max(set.edges, GPU_VIEW_BUDGET.edges) }
      const heap = readHeap()
      const memoryShort = memoryGates(load, heap, h.getState().memoryAccepted)
      if (accept_large) h.acceptLoad(load)
      const gated = !accept_large && (shouldGate(load, budget, h.getState().acceptedLoad) || memoryShort)
      const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`
      const gateNote = memoryShort
        ? `Too large for this tab's memory: drawing it needs about ${gb(drawCost(load))}${heap ? ` and the tab can spare about ${gb(heapRoom(heap))} (${gb(heap.used)} of ${gb(heap.limit)} in use)` : ''}; drawn, the browser would likely stop the tab. The canvas shows the large-graph gate. Trim with types / relationship_types / max_nodes. accept_large: true draws it anyway and may crash the tab — only if the user asks for it after being told.`
        : `Over the view budget (${budget.nodes} nodes / ${budget.edges} edges): the canvas shows the large-graph gate instead. Trim with relationship_types / max_nodes, or pass accept_large: true.`
      return json({ filter: describeFilter(next), loaded, ...(matchedRoots !== undefined ? { matchedRoots } : {}), ...(scriptRun ? { script: { id: scriptRun.script, returned: scriptRun.ids.length, ms: scriptRun.ms } } : {}), spec: compactSpec(next), nodes: slice.nodes.length, edges: slice.edges.length, truncated: slice.truncated, candidates: slice.candidates, components: slice.components, ...(gated ? { gated: true, reason: memoryShort ? 'memory' : 'budget', note: gateNote } : accept_large && memoryShort ? { warning: `Drawn past what this tab's memory can spare (about ${gb(drawCost(load))} needed): the tab may close.` } : {}), ...(slice.skipped?.length ? { skipped: slice.skipped, note: 'Skipped predicates cannot run in a filter.' } : {}) })
    },
  })

  const graphLayout = betaTool({
    name: 'graph_layout',
    description:
      'Arrange the graph: pick a layout algorithm and parameters (positions are recomputed), switch between 2D and 3D, load a saved layout by id, run a layout script (`script`: code that returns layout(positions), saved as the script\'s layout), unload it, pin/unpin nodes, or push overlapping nodes apart. `custom` is not an algorithm but what the explorer selects when positions were set rather than computed (graph_positions place / set / transform, a loaded hand-made layout): nothing recomputes them, a run places only nodes without a position; pick an algorithm with recompute: true to lay everything out again. Built in: unigraph-force (the default: Unigraph’s own force model, live on the GPU, any size), force (ForceAtlas2 2D / d3-force 3D), multilevel, tree, radial-by-type, clusters-by-type, concentric-by-degree, circlepack (2D), layered (2D only), circular, grid, sphere (3D only), random. Engines fetched on first use and run in the layout worker: elk-layered, elk-stress, elk-mrtree, elk-radial (2D, Eclipse Layout Kernel), cola (2D/3D constraint stress, WebCola), ngraph (2D/3D n-body force), spectral (2D/3D, Laplacian eigenvectors, no download). Some do not scale and are refused past a size where they would run for minutes (measured): layered 300 nodes, elk-stress 400, elk-mrtree 700, cola 1,200, elk-layered 1,300, elk-radial 6,000, ngraph 20,000, force 25,000, spectral 80,000 — use unigraph-force or multilevel for bigger views.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: LAYOUT_IDS },
        spacing: { type: 'number', minimum: 0.1, description: 'Distance multiplier (default 1)' },
        iterations: { type: 'integer', minimum: 1, description: 'Force iterations (force only)' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: 'Layered direction' },
        seed: { type: 'integer' },
        gravity: { type: 'number', minimum: 0, description: 'Force: pull toward the centre (default 1)' },
        scaling_ratio: { type: 'number', minimum: 0.1, description: 'Force 2D: repulsion (default 10)' },
        lin_log: { type: 'boolean', description: 'Force 2D: LinLog mode' },
        strong_gravity: { type: 'boolean', description: 'Force 2D' },
        weight_field: { type: 'string', description: 'Relationship attribute path holding edge weights, e.g. data.weight — read by the force layouts and by multilevel (a heavy edge holds its communities together); empty string clears' },
        edge_weight_influence: { type: 'number', minimum: 0, description: 'Force 2D: 0 ignores weights, 1 linear' },
        unigraph: {
          type: 'object',
          description: 'Force (Unigraph): the force model’s knobs — live on a GPU tab while the simulation runs (Run, or physics), the next Run elsewhere. Omitted keys keep their value.',
          properties: {
            link_distance: { type: 'number', minimum: 1, description: 'Rest length of a link, world units (default 12)' },
            link_strength: { type: 'number', minimum: 0, maximum: 1, description: 'Spring strength (default 1)' },
            repulsion: { type: 'number', minimum: 0, description: 'Push between two nodes a link distance apart, in link distances (default 0.2)' },
            gravity: { type: 'number', minimum: 0, description: 'Pull to the centre; against the repulsion it sets the density (default 0.1)' },
            damping: { type: 'number', minimum: 0, maximum: 1, description: 'Velocity kept per iteration (default 0.6)' },
            cooling: { type: 'number', minimum: 0.0005, maximum: 0.5, description: 'Alpha decay per iteration — how fast a run settles (default 0.0045, about 1,500 iterations; a CPU run on a big graph cools faster to fit its budget)' },
          },
          additionalProperties: false,
        },
        ranksep: { type: 'number', minimum: 0.1, description: 'Layered: rank separation multiplier' },
        nodesep: { type: 'number', minimum: 0.1, description: 'Layered: node separation multiplier' },
        tree_follow: { type: 'string', enum: ['auto', 'out', 'in', 'any'], description: 'Tree layout: which way the hierarchy runs — `out` reads an edge as parent → child, `in` as child → parent, `any` ignores direction (a spanning tree). Default `auto`: whichever reading finds the deeper hierarchy.' },
        center_id: { type: 'string', description: 'Radial/concentric: node placed at the origin; empty string clears' },
        noverlap: { type: 'boolean', description: 'Remove overlap after every layout run (2D)' },
        remove_overlap: { type: 'boolean', description: 'Push overlapping nodes apart now, keeping the arrangement' },
        pin: { type: 'array', items: { type: 'string' }, description: 'Node ids to pin in place' },
        unpin: { type: 'array', items: { type: 'string' } },
        unpin_all: { type: 'boolean' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
        layout_id: { type: 'string', description: 'Saved layout entity to load' },
        script: { type: 'string', description: 'A layout script (a script entity returning layout(positions) — or scene(positions)): run it now and hold what it returns as the view\'s positions. Saved as the script\'s layout (one per script, updated on each run), which a graph scene keeps and layout_id reloads without running.' },
        unload: { type: 'boolean', description: 'Forget the loaded layout / held positions and recompute' },
        rederive: { type: 'boolean', description: 'Re-run the remembered placement rule (from graph_positions place) against current values' },
        clear_rule: { type: 'boolean', description: 'Forget the placement rule (positions stay)' },
        overlay: { type: 'boolean', description: 'Show the placement guide (region outline, cell grid and axis ticks) in 2D. Off by default; only turn it on when the user asks for it.' },
        physics: { type: 'boolean', description: 'Run the live force simulation (with the force layout; on the GPU tab over any layout — the whole picture, on the GPU)' },
        recompute: { type: 'boolean', description: 'Recompute positions (default: yes when algorithm or params change). While a placement rule is in force (graph_positions place — every tree where it stands), an algorithm or parameter change lays out only the nodes the placement did not cover; recompute: true forgets the rule and lays everything out again' },
        fit: { type: 'boolean', description: 'Fit the view afterwards (default true)' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ algorithm, spacing, iterations, direction, seed, gravity, scaling_ratio, lin_log, strong_gravity, weight_field, edge_weight_influence, unigraph, ranksep, nodesep, tree_follow, center_id, noverlap, remove_overlap, pin, unpin, unpin_all, mode, layout_id, script, unload, rederive, clear_rule, overlay, physics, recompute, fit }) => {
      const h = await explorer(mode)
      const notes: string[] = []
      let loaded: string | undefined
      let scripted: { id: string; label: string; placed: number; updated: boolean; logs: string[]; ms: number } | undefined
      if (layout_id) {
        const e = requireEntity(store, layout_id)
        if (e.type !== GRAPH_TYPES.layout) throw new Error(`Entity ${layout_id} is a ${e.type}, not a saved layout.`)
        const d = e.data as LayoutData
        h.loadLayout(e.id, d.positions ?? {}, layoutAlgorithmOf(d), d.pinned, d.rule)
        loaded = displayLabel(e)
        if (d.dimensions && d.dimensions !== h.dims) notes.push(`This layout was saved in ${d.dimensions}D; the explorer is in ${h.dims}D.`)
      }
      if (script) {
        const applied = await applyLayoutScript(store, registry(), script, { dimensions: h.dims })
        h.loadLayout(applied.layout.id, applied.positions, 'custom')
        loaded = displayLabel(applied.layout)
        scripted = { id: applied.layout.id, label: loaded, placed: Object.keys(applied.positions).length, updated: applied.updated, logs: applied.logs, ms: applied.ms }
        if (applied.dimensions !== h.dims) notes.push(`The script placed nodes in ${applied.dimensions}D; the explorer is in ${h.dims}D.`)
      }
      if (unload) h.unloadLayout()
      if (clear_rule) h.setLayoutRule(undefined)
      if (overlay !== undefined) h.setPlacementOverlay(overlay)
      let rederived: { placed: number; unplaced: number } | undefined
      if (rederive) {
        if (!h.getState().layoutRule) throw new Error('No placement rule to re-derive; use graph_positions {action:"place"} first.')
        const r = h.rederiveLayout()
        if (r) rederived = { placed: Object.keys(r.positions).length - r.unplaced.length, unplaced: r.unplaced.length }
      }
      let changed = false
      if (algorithm) {
        const info = layoutInfo(algorithm)
        if (!info.dims.includes(h.dims)) throw new Error(`${info.label} is ${info.dims.join('D/')}D only; switch mode first.`)
        // A layout past its size limit would run for minutes: refused, as the dropdown greys it out.
        const refused = layoutTooBig(algorithm, h.getSlice().nodes.length)
        if (refused) throw new Error(refused)
        h.setAlgorithm(algorithm)
        changed = true
      }
      const params: Partial<Omit<LayoutParams, 'dimensions'>> = {}
      if (spacing !== undefined) params.spacing = spacing
      if (iterations !== undefined) params.iterations = iterations
      if (direction !== undefined) params.direction = direction
      if (seed !== undefined) params.seed = seed
      if (gravity !== undefined) params.gravity = gravity
      if (scaling_ratio !== undefined) params.scalingRatio = scaling_ratio
      if (lin_log !== undefined) params.linLogMode = lin_log
      if (strong_gravity !== undefined) params.strongGravity = strong_gravity
      if (weight_field !== undefined) params.weightField = weight_field || undefined
      if (edge_weight_influence !== undefined) params.edgeWeightInfluence = edge_weight_influence
      if (unigraph) {
        const u = { ...DEFAULT_UNIGRAPH_FORCE, ...(h.getState().params.unigraph ?? {}) }
        if (unigraph.link_distance !== undefined) u.linkDistance = unigraph.link_distance
        if (unigraph.link_strength !== undefined) u.linkStrength = unigraph.link_strength
        if (unigraph.repulsion !== undefined) u.repulsion = unigraph.repulsion
        if (unigraph.gravity !== undefined) u.gravity = unigraph.gravity
        if (unigraph.damping !== undefined) u.damping = unigraph.damping
        if (unigraph.cooling !== undefined) u.alphaDecay = unigraph.cooling
        params.unigraph = u
      }
      if (ranksep !== undefined) params.ranksep = ranksep
      if (nodesep !== undefined) params.nodesep = nodesep
      if (tree_follow !== undefined) params.treeFollow = tree_follow as LayoutParams['treeFollow']
      if (center_id !== undefined) {
        if (center_id) requireEntity(store, center_id)
        params.centerId = center_id || undefined
      }
      if (noverlap !== undefined) params.noverlap = noverlap
      if (Object.keys(params).length) {
        h.patchParams(params)
        changed = true
      }
      let pinned = h.getState().pinned
      if (unpin_all) pinned = []
      if (unpin?.length) pinned = pinned.filter((id) => !unpin.includes(id))
      if (pin?.length) {
        for (const id of pin) requireEntity(store, id)
        pinned = [...new Set([...pinned, ...pin])]
      }
      if (unpin_all || unpin?.length || pin?.length) h.setPinned(pinned)
      // A heavy layout can take a minute in the worker; the reply must not — the bridge answers one call at a time,
      // and a call past the client's timeout blocks every call behind it. Wait a bounded time, then report it running.
      let stillRunning = false
      // Physics off comes first: a live simulation running under a Force (Unigraph) recompute would be stopped by the
      // switch after the run started, and the run — which waits for the simulation to cool — would never land.
      if (physics === false) h.setPhysics(false)
      if (recompute ?? (changed && !layout_id)) {
        // A placement in force is a fixed arrangement: an algorithm or parameter change lays out only the nodes it did
        // not place. An explicit recompute means all of it — the rule goes first, as the Layout tab's Recompute does.
        const done = h.runLayout(recompute ? 'recompute' : undefined).then(() => true)
        const wait = new Promise<boolean>((r) => setTimeout(() => r(false), 15000))
        stillRunning = !(await Promise.race([done, wait]))
        notes.push(stillRunning ? 'The layout is still computing in the worker; the view shows seed positions until it lands. graph_state {brief:true} reports layoutRunning.' : '')
        if (!stillRunning) notes.pop()
      }
      if (remove_overlap) {
        if (h.dims !== 2) throw new Error('Overlap removal is 2D only.')
        // Let a recompute settle before spreading the result.
        await new Promise((r) => setTimeout(r, recompute || changed ? 60 : 0))
        h.removeOverlap()
      }
      if (physics === true) h.setPhysics(true)
      if (fit !== false) setTimeout(() => h.fit(), 350)
      const st = h.getState()
      return json({ mode: h.renderer ?? (h.dims === 3 ? '3d' : '2d'), algorithm: algorithm ?? st.algorithm, params: { ...st.params, ...params }, loaded, ...(scripted ? { scripted } : {}), recomputed: !!(recompute ?? (changed && !layout_id)), layoutRunning: stillRunning, overlapRemoved: !!remove_overlap, rederived, rule: st.layoutRule ? describePlacement(st.layoutRule.spec) : undefined, pinned, physics: physics ?? st.physics, notes })
    },
  })

  const graphStyle = betaTool({
    name: 'graph_style',
    description:
      'Change how the graph looks (Gephi-style appearance). Every visual channel — node color, size, opacity, shape; edge color, width, opacity — is driven by a constant, a ranking (numeric attribute → range or palette) or a partition (categorical attribute → palette colors / shapes), set for all nodes/edges or overridden per type or tag via `channels`. Attributes: degree (dir both/in/out), a data field, a computed metric (run graph_metrics first; "community" is the Louvain community), the type, the first tag, or any ValueRef ({kind:"value", ref}) — including a dataset\'s column, ref "dataset:<id>.<column>", read on each node its row matches (by the dataset\'s id column, else its type column): colour by a table of counts per type is {scope:"nodes", by:"all", channel:"color", mode:"ranking", attr:{kind:"value", ref:"dataset:<id>.count"}, palette:"viridis"}. `rules` is the quick form for constant overrides per type/tag (color, size multiplier, shape, opacity, visible, label; edges: color, width, opacity, visible, arrow); `remove: true` drops a rule. Also precedence, labels, edge visibility, edge labels, curved edges, the legend; or load a saved style by id, run a style script (`script`) whose code decides every node\'s look, or reset to default.',
    inputSchema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['nodes', 'edges'] },
              by: { type: 'string', enum: ['all', 'types', 'tags'], description: '"all" sets the default for every node/edge; "types"/"tags" override for one type or tag (needs key)' },
              key: { type: 'string', description: 'Type name or tag when by is types/tags' },
              channel: { type: 'string', enum: ['color', 'size', 'opacity', 'shape', 'width'], description: 'size/shape are node channels; width is an edge channel' },
              mode: { type: 'string', enum: ['constant', 'ranking', 'partition', 'inherit'], description: '"inherit" removes an override so the type/tag follows the default again' },
              value: { description: 'Constant: a CSS color, a number (size px / opacity 0–1 / width px), or a shape' },
              attr: {
                type: 'object',
                properties: { kind: { type: 'string', enum: ['degree', 'field', 'metric', 'type', 'tag', 'directed', 'value'] }, key: { type: 'string', description: 'field name/path or metric id' }, dir: { type: 'string', enum: ['both', 'in', 'out'] }, prefix: { type: 'string', description: 'tag prefix' }, ref: { type: 'string', description: 'kind "value": any ValueRef — data.<key>, meta.updatedAt, degree.in:cites, metric.pagerank, dataset:<dataset id>.<column> (a dataset\'s column on each node its row matches), …' } },
                required: ['kind'],
                additionalProperties: false,
              },
              palette: { type: 'string', enum: PALETTES.map((p) => p.id) },
              min: { type: 'number', description: 'Ranking of a number channel: output range start' },
              max: { type: 'number' },
              log: { type: 'boolean' },
              domain: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Manual input [min, max]; omit for auto' },
              max_categories: { type: 'integer', minimum: 2, maximum: 40 },
              colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Partition: explicit color per category value' },
              shapes: { type: 'object', additionalProperties: { type: 'string', enum: SHAPE_IDS }, description: 'Shape partition: explicit shape per category value' },
            },
            required: ['scope', 'by', 'channel', 'mode'],
            additionalProperties: false,
          },
        },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['nodes', 'edges'] },
              by: { type: 'string', enum: ['types', 'tags'] },
              key: { type: 'string', description: 'The type name or tag' },
              remove: { type: 'boolean' },
              color: { type: 'string', description: 'CSS color, e.g. #f97316' },
              size: { type: 'number', description: 'Nodes: multiplier on the mapped size' },
              shape: { type: 'string', enum: SHAPE_IDS },
              opacity: { type: 'number', minimum: 0, maximum: 1 },
              visible: { type: 'boolean' },
              label: { type: 'boolean', description: 'Nodes: may show a label' },
              width: { type: 'number', description: 'Edges: line width' },
              arrow: { type: 'boolean', description: 'Edges: draw a direction arrow' },
            },
            required: ['scope', 'by', 'key'],
            additionalProperties: false,
          },
        },
        precedence: { type: 'string', enum: ['type', 'tag'], description: 'Which wins when a node matches both a type rule and a tag rule' },
        edge_labels: { type: 'boolean' },
        curved_edges: { type: 'boolean' },
        legend: { type: 'boolean', description: 'Show or hide the legend overlay' },
        labels: { type: 'string', enum: ['auto', 'all', 'none'] },
        show_edges: { type: 'boolean' },
        rendering_id: { type: 'string', description: 'Saved style (rendering entity) to load' },
        script: { type: 'string', description: 'A style script (a script entity returning style(nodes, …)): run it now and apply what it returns — colours, sizes, shapes per entity computed by code, e.g. from metrics the script computes with ds.compute — as the view\'s style. The result is saved as the script\'s rendering (one per script, updated on each run), so it reloads without running. Other arguments then apply on top.' },
        reset: { type: 'boolean', description: 'Back to the default style' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      additionalProperties: false,
    } as const,
    run: async ({ channels, rules, precedence, edge_labels, curved_edges, legend, labels, show_edges, rendering_id, script, reset, mode }) => {
      const h = await explorer(mode)
      let spec: RenderingSpec = h.getState().rendering
      let loaded: string | undefined
      let scripted: { id: string; label: string; nodes: number; edges: number; updated: boolean; logs: string[]; ms: number } | undefined
      if (reset) {
        h.clearRendering()
        spec = DEFAULT_RENDERING
      }
      if (script) {
        const applied = await applyStyleScript(store, registry(), script, { base: spec })
        spec = applied.spec
        h.loadRendering(applied.rendering.id, spec)
        loaded = displayLabel(applied.rendering)
        scripted = { id: applied.rendering.id, label: loaded, nodes: Object.keys(applied.output.overlay.nodes ?? {}).length, edges: Object.keys(applied.output.overlay.edges ?? {}).length, updated: applied.updated, logs: applied.logs, ms: applied.ms }
      }
      if (rendering_id) {
        const e = requireEntity(store, rendering_id)
        if (e.type !== GRAPH_TYPES.rendering) throw new Error(`Entity ${rendering_id} is a ${e.type}, not a saved style.`)
        spec = toRenderingSpec(e.data as RenderingData)
        h.loadRendering(e.id, spec)
        loaded = displayLabel(e)
      }
      for (const r of rules ?? []) {
        const { scope, by, key, remove, ...style } = r
        const raw = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined))
        const patch = remove ? null : scope === 'nodes' ? normNodeRule(raw) : normEdgeRule(raw)
        if (patch && !Object.keys(patch).length) throw new Error(`Rule for ${scope}/${by}/${key} sets nothing. Give at least one property or remove: true.`)
        h.setRule(scope, by, key, patch)
        spec = setRenderingRule(spec, scope, by, key, patch)
      }
      // The channel vocabulary and its checks live in core (`applyStyleChannels`), so the headless engine composes a
      // style exactly as this does; the explorer only has to mirror each change into the live view.
      const computed = h.getMetrics()?.columns ?? {}
      const applied = applyStyleChannels(spec, (channels ?? []) as StyleChannelInput[], { metrics: Object.keys(computed), computeHint: (m) => `call graph_metrics first (metrics: ["${m}"]).` })
      spec = applied.spec
      for (const ch of applied.changes) if (ch.by !== 'all') h.setRule(ch.scope, ch.by, ch.key!, ch.patch)
      const patch: Partial<RenderingSpec> = {}
      if (precedence) patch.precedence = precedence
      if (channels?.some((c) => c.by === 'all')) {
        patch.nodes = spec.nodes
        patch.edges = spec.edges
      }
      if (edge_labels !== undefined) patch.edgeLabels = edge_labels
      if (curved_edges !== undefined) patch.curvedEdges = curved_edges
      if (Object.keys(patch).length) {
        h.patchRendering(patch)
        spec = { ...spec, ...patch }
      }
      if (labels) h.setLabels(labels)
      if (show_edges !== undefined) h.setShowEdges(show_edges)
      if (legend !== undefined) h.setLegend(legend)
      return json({ style: describeRendering(spec), loaded, ...(scripted ? { scripted } : {}), precedence: spec.precedence, defaults: { nodes: spec.nodes.default, edges: spec.edges.default }, edgeLabels: spec.edgeLabels, curvedEdges: spec.curvedEdges, rules: { nodes: { types: spec.nodes.types, tags: spec.nodes.tags }, edges: { types: spec.edges.types, tags: spec.edges.tags } }, ...(spec.overlay ? { overlay: { nodes: Object.keys(spec.overlay.nodes ?? {}).length, edges: Object.keys(spec.overlay.edges ?? {}).length, legend: spec.overlay.legend?.title, source: spec.overlay.source } } : {}), labels: labels ?? h.getState().labels, showEdges: show_edges ?? h.getState().showEdges, legend: legend ?? h.getState().showLegend })
    },
  })

  const graphSave = betaTool({
    name: 'graph_save',
    description: 'Save the explorer\'s current filter, layout (held positions), style, or analysis (computed metrics) as a named entity so it can be reloaded with graph_filter / graph_layout / graph_style / graph_metrics — or the whole view as a scene (kind "scene": filter + layout + style, the analysis when metrics are computed, the exact renderer, the dataset and the analysis settings, plus everything about the view and the UI — camera, labels, edges, legend, selection, tools, which panels are open — and a small picture of the view; unsaved parts are saved with it; loading puts all of it back, physics off), an entity of the page\'s subtype — scene:unigraph on Unigraph, scene:explorer on the Graph Explorer — listed on the Scenes page and opened with display {show} or /graph/2d?scene=<id>. This is what the toolbar\'s Save and Save as… do; the scene menu beside them (and display {show}) loads one. With `update: true` the currently loaded one is overwritten instead of creating a new entity (for a scene: the scene the view was loaded from, as Save does).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['filter', 'layout', 'style', 'analysis', 'scene'] },
        name: { type: 'string', description: 'Required unless update is true' },
        update: { type: 'boolean', description: 'Overwrite the loaded saved item' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind'],
      additionalProperties: false,
    } as const,
    run: async ({ kind, name, update, tags }) => {
      const h = await explorer()
      const st = h.getState()
      if (kind === 'scene') {
        // A scene references saved parts; save any unsaved/dirty part first, named after the scene.
        const loaded = update ? (st.sceneId ? store.get(st.sceneId) : undefined) : undefined
        if (update && !loaded) throw new Error('No scene is loaded to update; give a name to save a new one.')
        const label0 = name?.trim() || (loaded ? displayLabel(loaded) : '')
        if (!label0) throw new Error('Give the scene a name.')
        const part = async (k: 'filter' | 'layout' | 'style') => {
          const id = k === 'filter' ? st.filterId : k === 'layout' ? st.layoutId : st.renderingId
          const dirty = k === 'filter' ? st.filterDirty : k === 'layout' ? st.layoutDirty : st.renderingDirty
          // A clean loaded part is shared; a dirty one becomes a new part named after this scene, so the scene the
          // old part belongs to keeps it (the loaded part may also have been deleted since — same answer).
          const existing = id ? store.get(id) : undefined
          if (id && !dirty && existing) return id
          const r = JSON.parse(String(await (graphSave as unknown as { run: (i: unknown) => Promise<string> }).run({ kind: k, name: `${label0} · ${k}` })))
          return r.id as string
        }
        // The analysis rides along when metrics are computed; the view and a small picture come from the explorer itself.
        const m = h.getMetrics()
        let analysisId: string | undefined
        if (m && st.analysisId && !st.analysisDirty && store.get(st.analysisId)) analysisId = st.analysisId
        else if (m) {
          const a = createAnalysisEntity(store, `${label0} · analysis`, m, { filterId: st.filterId, filter: st.filter, source: 'assistant' })
          h.markAnalysisSaved(a.id)
          analysisId = a.id
        }
        const captured = h.captureView ? await h.captureView() : undefined
        const data = { renderer: h.dims === 3 ? '3d' : '2d', mode: h.renderer ?? (h.dims === 3 ? '3d' : '2d'), filterId: await part('filter'), layoutId: await part('layout'), renderingId: await part('style'), analysisId, algorithm: st.algorithm, params: st.params, projectId: st.projectId, analysis: { auto: st.analysisAuto, options: st.analysisOptions }, ...(captured ? { view: captured.view, preview: captured.preview, stats: captured.stats } : {}) }
        // Unigraph's subtype — on a new scene and on one saved before it (the bare `scene`, the explorer's) alike.
        const type = graphSceneTypeFor()
        const e = loaded ? store.update(loaded.id, { label: label0, type, data, ...(tags ? { tags: parseTags(tags) } : {}) }) : createEntity({ type, label: label0, data, tags, meta: { source: 'assistant' } })
        if (!loaded) store.upsert(e)
        h.setScene?.(e.id)
        return json({ ...summarize(e), kind, type, updated: !!loaded, view: !!captured, preview: !!captured?.preview })
      }
      const type = kind === 'filter' ? GRAPH_TYPES.filter : kind === 'layout' ? GRAPH_TYPES.layout : kind === 'analysis' ? GRAPH_TYPES.analysis : GRAPH_TYPES.rendering
      const loadedId = kind === 'filter' ? st.filterId : kind === 'layout' ? st.layoutId : kind === 'analysis' ? st.analysisId : st.renderingId
      const existing = update ? (loadedId ? store.get(loadedId) : undefined) : undefined
      if (update && !existing) throw new Error(`No saved ${kind} is loaded to update; give a name to save a new one.`)
      const label = name?.trim() || (existing ? displayLabel(existing) : '')
      if (!label) throw new Error('Give the saved item a name.')
      let data: Record<string, unknown>
      if (kind === 'analysis') {
        const m = h.getMetrics()
        if (!m) throw new Error('No metrics have been computed; call graph_metrics first.')
        const e = createAnalysisEntity(store, label, m, { filterId: st.filterId, filter: st.filter, source: 'assistant' })
        if (existing) {
          store.remove(e.id)
          const upd = store.update(existing.id, { label, data: e.data, ...(tags ? { tags: parseTags(tags) } : {}) })
          h.markAnalysisSaved(upd.id)
          return json({ ...summarize(upd), kind, updated: true })
        }
        h.markAnalysisSaved(e.id)
        return json({ ...summarize(e), kind, updated: false })
      }
      if (kind === 'filter') data = { ...st.filter } satisfies FilterData
      else if (kind === 'layout') {
        const prev = (existing?.data as LayoutData | undefined)?.positions ?? {}
        // What is drawn, physics included: `getPositions` reads the live picture while the simulation runs.
        data = { positions: { ...prev, ...st.positions, ...h.getPositions() }, algorithm: st.algorithm, dimensions: h.dims, pinned: st.pinned, ...(st.layoutRule ? { rule: st.layoutRule } : {}) } satisfies LayoutData
      } else data = { ...st.rendering } satisfies RenderingData
      let e: AnyEntity
      if (existing) e = store.update(existing.id, { label, data, ...(tags ? { tags: parseTags(tags) } : {}) })
      else {
        e = createEntity({ type, label, data, tags, meta: { source: 'assistant' } })
        store.upsert(e)
      }
      if (kind === 'filter') h.markFilterSaved(e.id)
      else if (kind === 'layout') h.markLayoutSaved(e.id)
      else h.markRenderingSaved(e.id)
      return json({ ...summarize(e), kind, updated: !!existing, ...(kind === 'layout' ? { positions: Object.keys((data as LayoutData).positions).length } : {}) })
    },
  })

  const graphMetrics = betaTool({
    name: 'graph_metrics',
    description:
      'Compute network statistics for the current graph view (Gephi Statistics / Cytoscape NetworkAnalyzer): degree variants, PageRank, betweenness, closeness, eigenvector, HITS, clustering coefficient, connected components, Louvain communities, plus density, diameter and average path length. Runs off the main thread; betweenness/closeness are sampled above 3,000 nodes. Results feed graph_style channels (ranking by a metric, partition by community) and can be written onto entities or saved as an analysis. Pass `analysis_id` to load a saved analysis instead of computing.',
    inputSchema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: { type: 'string', enum: METRIC_IDS }, description: `Default: ${DEFAULT_METRICS.join(', ')}` },
        weight_field: { type: 'string', description: 'Relationship attribute path for weights, e.g. data.weight' },
        directed: { type: 'boolean', description: 'Honour direction for in/out-degree, PageRank, HITS (default true)' },
        write_to_entities: { type: 'boolean', description: 'Copy the values into each node\'s data.<prefix><metric>' },
        prefix: { type: 'string' },
        save_as: { type: 'string', description: 'Save the result as a named analysis entity' },
        analysis_id: { type: 'string', description: 'Load this saved analysis instead of computing' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, description: 'Top nodes to list per metric (default 10)' },
        auto: { type: 'boolean', description: 'Re-run these metrics automatically whenever the view changes' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      additionalProperties: false,
    } as const,
    run: async ({ metrics, weight_field, directed, write_to_entities, prefix, save_as, analysis_id, top_k, auto, mode }) => {
      const h = await explorer(mode)
      if (auto !== undefined) h.setAnalysisAuto(auto)
      let result
      let loaded: string | undefined
      if (analysis_id) {
        const e = requireEntity(store, analysis_id)
        if (e.type !== GRAPH_TYPES.analysis) throw new Error(`Entity ${analysis_id} is a ${e.type}, not an analysis.`)
        result = fromAnalysisData(e.data as AnalysisData)
        h.loadAnalysis(e.id, result)
        loaded = displayLabel(e)
      } else {
        const slice = h.getSlice()
        if (!slice.nodes.length) throw new Error('The view is empty; nothing to analyse.')
        const wanted = metrics?.length ? metrics : DEFAULT_METRICS
        result = await h.runMetrics({ metrics: wanted, weightField: weight_field || undefined, directed })
      }
      const k = top_k ?? 10
      const per: Record<string, unknown> = {}
      for (const [id, col] of Object.entries(result.columns)) {
        if (!col) continue
        const info = metricInfo(id as NodeMetricId)
        const stats = columnStats(col)
        per[id] = info.categorical ? { groups: new Set(Array.from(col)).size } : { ...stats, top: topK(result, id as NodeMetricId, k).map((t) => ({ ...brief(store, t.id), value: Math.round(t.value * 1e6) / 1e6 })) }
      }
      let wrote: number | undefined
      if (write_to_entities) wrote = writeMetricsToEntities(store, result, undefined, prefix ?? '')
      let saved
      if (save_as) {
        const e = createAnalysisEntity(store, save_as, result, { filterId: h.getState().filterId, filter: h.getState().filter, source: 'assistant' })
        h.markAnalysisSaved(e.id)
        saved = summarize(e)
      }
      const slice = h.getSlice()
      return json({
        loaded,
        stale: result.sliceKey !== '' && slice.nodes.length !== result.ids.length ? true : undefined,
        summary: result.summary,
        cached: result.cached || undefined,
        reused: result.reused,
        metrics: per,
        communities: result.communities ? { count: result.communities.count, largest: result.communities.sizes.slice(0, 10) } : undefined,
        wrote,
        saved,
        hint: 'Colour or size the view with graph_style channels, e.g. {scope:"nodes", by:"all", channel:"size", mode:"ranking", attr:{kind:"metric", key:"pagerank"}} or {channel:"color", mode:"partition", attr:{kind:"metric", key:"community"}}.',
      })
    },
  })

  const INLINE_TEXT_LIMIT = 1_000_000
  const INLINE_PNG_LIMIT = 1_500_000

  const graphExport = betaTool({
    name: 'graph_export',
    description:
      'Export the current graph view (or the whole workspace) as a picture or interchange file: png (returned as an image so you can see it), svg, gexf (Gephi), graphml, cyjs (Cytoscape), nodes_edges_csv (Gephi two-file CSV), or json (aegraph document). View exports carry held positions and resolved colours/sizes. Small results come back inline; large ones (or `download: true`) are saved through the browser instead. Or as a diagram: dot (Graphviz) or mermaid — types become clusters, relationships labelled edges, node ids kept, so a diagram that was exported to the dataset round-trips with the same ids; `save_as` keeps it as a diagram entity too',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'svg', 'gexf', 'graphml', 'cyjs', 'nodes_edges_csv', 'json', 'dot', 'mermaid'] },
        scope: { type: 'string', enum: ['view', 'workspace'], description: 'Default view; png/svg are view-only' },
        save_as: { type: 'string', description: 'dot/mermaid: also keep the result as a diagram entity with this label' },
        download: { type: 'boolean', description: 'Save via the browser instead of returning inline' },
        width: { type: 'integer', minimum: 64, maximum: 4096, description: 'png/svg pixel width' },
        height: { type: 'integer', minimum: 64, maximum: 4096 },
        background: { type: 'string', description: 'CSS colour or "transparent"' },
        labels: { type: 'string', enum: ['auto', 'all', 'none'], description: 'svg: node labels' },
        edge_labels: { type: 'boolean', description: 'svg: draw relationship types on edges' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['format'],
      additionalProperties: false,
    } as const,
    run: async ({ format, scope, download, width, height, background, labels, edge_labels, mode, save_as }) => {
      const sc = scope ?? 'view'
      if (sc === 'workspace' && (format === 'png' || format === 'svg')) throw new Error('png/svg export the view; use scope "view".')
      let nodes: AnyEntity[]
      let edges: import('../../core/entity/types').Relationship[]
      let positions: import('../../core/graph/layouts').Positions | undefined
      let styles: ReturnType<ExplorerHandle['getStyles']> | undefined
      let h: ExplorerHandle | undefined
      if (sc === 'view') {
        h = await explorer(mode)
        const slice = h.getSlice()
        nodes = slice.nodes
        edges = slice.edges
        positions = h.getPositions()
        styles = h.getStyles()
      } else {
        const reg = registry()
        nodes = store.all().filter((e) => !isRelationship(e) && !['project', 'schema'].includes(reg.categoryOf(e.type)))
        const ids = new Set(nodes.map((n) => n.id))
        edges = store.relationships().filter((r) => ids.has(r.source.id) && ids.has(r.target.id))
        const layouts = store.ofType(GRAPH_TYPES.layout).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
        positions = (layouts[0]?.data as LayoutData | undefined)?.positions
      }
      const name = sc === 'view' ? 'graph-view' : 'workspace'
      const base = { format, scope: sc, nodes: nodes.length, edges: edges.length }
      if (format === 'png') {
        const blob = await h!.snapshot({ width, height, background })
        if (!blob) throw new Error('The renderer could not produce a snapshot (is the graph page visible?).')
        if (download || blob.size > INLINE_PNG_LIMIT) {
          downloadBlob(`${name}.png`, blob)
          return json({ ...base, bytes: blob.size, delivered: 'download', filename: `${name}.png`, note: download ? undefined : 'Too large to return inline; saved through the browser instead.' })
        }
        const b64 = await blobToBase64(blob)
        return [{ type: 'text' as const, text: json({ ...base, bytes: blob.size, delivered: 'inline' }) }, { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: b64 } }]
      }
      let files: { name: string; text: string; mime: string }[]
      if (format === 'svg') {
        const st = h!.getState()
        files = [{ name: `${name}.svg`, text: svgFromView({ nodes, edges }, positions ?? {}, styles!, { width, height, background, labels: labels ?? st.labels, edgeLabels: edge_labels ?? st.rendering.edgeLabels, curvedEdges: st.rendering.curvedEdges }), mime: 'image/svg+xml' }]
      } else if (format === 'json') {
        let text = ''
        for (const chunk of serialize({ entities: [...nodes, ...edges], tags: [] }, 'json')) text += chunk
        files = [{ name: `${name}.ae.json`, text, mime: 'application/json' }]
      } else if (format === 'dot' || format === 'mermaid') {
        // The same picture the explorer's "Save the view as a diagram" makes: clusters by type, labelled edges, ids kept.
        const text = writeDiagram(diagramFromEntities(nodes, edges, registry(), { name }), format)
        files = [{ name: `${name}.${format === 'dot' ? 'dot' : 'mmd'}`, text, mime: 'text/plain' }]
        if (save_as?.trim()) {
          const d = createDiagram(store, { label: save_as.trim(), source: text, format, tags: ['from-graph-view'], source_: 'export:graph' })
          return [{ type: 'text' as const, text: json({ ...base, bytes: text.length, delivered: 'inline', files: files.map((f) => f.name), saved: { id: d.id, label: d.label } }) }, { type: 'text' as const, text: `--- ${files[0].name} ---\n${text}` }]
        }
      } else {
        files = await GRAPH_FORMATS.find((f) => f.id === format)!.write({ nodes, edges, positions, styles, registry: registry(), name })
      }
      const bytes = files.reduce((n, f) => n + f.text.length, 0)
      if (download || bytes > INLINE_TEXT_LIMIT) {
        downloadFiles(files)
        return json({ ...base, bytes, delivered: 'download', files: files.map((f) => f.name), note: download ? undefined : 'Too large to return inline; saved through the browser instead.' })
      }
      return [{ type: 'text' as const, text: json({ ...base, bytes, delivered: 'inline', files: files.map((f) => f.name) }) }, ...files.map((f) => ({ type: 'text' as const, text: `--- ${f.name} ---\n${f.text}` }))]
    },
  })

  const importGraph = betaTool({
    name: 'import_graph',
    description:
      'Import a graph from text or a URL: gexf, graphml, cyjs, nodes_edges_csv (pass the edges file as edges_text), rdf (N-Triples / Turtle / N-Quads / TriG — DBpedia, Wikidata, any linked data: subjects become entities under their compact IRI such as dbr:Berlin, rdf:type picks the type, rdfs:label/comment the label and description, other literals become data, dct:subject categories become tags, IRI-valued predicates become relationships; wiki-link plumbing is skipped), parquet (Apache Parquet: a table of points — one row a node: id, label/title, x, y, color, size, other columns as attributes — and optionally a links table given as `edges_url`, with source/target columns; how Cosmograph and data tools ship large graphs; Snappy or uncompressed; `parquet.columns` leaves out heavy columns such as abstracts, `parquet.limit` reads the first rows), node_link_json (d3’s and NetworkX’s { nodes, links }: a node is its id, else its name, else its place in the list; a link’s ends are ids, names or indices; other fields become attributes — a `group` to colour by), or json (aegraph document; a `.json` that holds nodes and links is read as node_link_json). `url` fetches the file (same origin or CORS: /datasets/x.nt, https://dbpedia.org/data/Berlin.ntriples, a SPARQL CONSTRUCT URL — Wikidata’s https://query.wikidata.org/sparql?query=…, DBpedia’s — which is asked for N-Triples or Turtle, since endpoints such as Wikidata’s ignore `format=` for CONSTRUCT). Nodes become entities (type from an attribute or fixed), edges become relationships, positions become a saved layout. Ids are deterministic per `name` (RDF: the IRIs themselves) so re-importing updates. Merge only; use dry_run to preview. Inline text over 2 MB: drop the file on the Datasets page instead. A fetched file is read up to 128 MB, and a graph of more than 1,000,000 nodes or 2,000,000 edges is refused. A node id that names an entity the import did not make updates it only with mapping.reuse_existing_ids (its type is kept); otherwise the node gets an id of its own.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['gexf', 'graphml', 'cyjs', 'nodes_edges_csv', 'rdf', 'parquet', 'node_link_json', 'json'], description: 'Optional with `url` when the extension or the file says it. node_link_json: { nodes, links } as d3 and NetworkX write it — a `.json` holding that is read so without asking' },
        text: { type: 'string', description: 'File contents (nodes.csv for nodes_edges_csv)' },
        url: { type: 'string', description: 'Fetch the file from here instead of `text`' },
        rdf: {
          type: 'object',
          description: 'RDF only',
          properties: {
            lang: { type: 'string', description: 'Language for labels and text (default en)' },
            stubs: { type: 'boolean', description: 'Add things only referred to, with just a label (default true)' },
            skip_predicates: { type: 'array', items: { type: 'string' }, description: 'Compact or full predicate IRIs to leave out, beyond the wiki plumbing' },
            max_tags: { type: 'number' },
          },
          additionalProperties: false,
        },
        edges_text: { type: 'string', description: 'edges.csv contents for nodes_edges_csv' },
        edges_url: { type: 'string', description: 'The links/edges file for a two-file format, fetched like `url`: edges.csv for nodes_edges_csv, the links .parquet for parquet' },
        parquet: {
          type: 'object',
          description: 'Parquet only',
          properties: {
            columns: { type: 'array', items: { type: 'string' }, description: 'Only these point columns (id, label and position columns always come); leave out what is heavy and not needed' },
            limit: { type: 'integer', minimum: 1, description: 'Read only the first this many points' },
            id_column: { type: 'string', description: 'The node id column (default: id, node, key or name)' },
            label_column: { type: 'string', description: 'The label column (default: label, title or name)' },
            source_column: { type: 'string', description: 'The links file\'s source column (default: source, src, from)' },
            target_column: { type: 'string', description: 'The links file\'s target column (default: target, tgt, to, dst)' },
            rescale: { type: 'boolean', description: 'Fit x/y to a spread that suits the number of points, centred (default true: data tools write positions in their own units — Cosmograph\'s run 0–12); false keeps them as written' },
          },
          additionalProperties: false,
        },
        name: { type: 'string', description: 'Source name; seeds the import key' },
        mapping: {
          type: 'object',
          properties: {
            label_attr: { type: 'string' },
            type_attr: { type: 'string' },
            fixed_type: { type: 'string' },
            tags_attr: { type: 'string' },
            edge_type_attr: { type: 'string' },
            fixed_edge_type: { type: 'string' },
            directed: { type: 'string', enum: ['file', 'directed', 'undirected'] },
            import_layout: { type: 'boolean' },
            import_colors: { type: 'boolean' },
            reuse_existing_ids: { type: 'boolean', description: 'A node id that names an existing entity updates it (default false; never a type definition, graph object or diagram, and its type is kept)' },
            description_attr: { type: 'string' },
            id_mode: { type: 'string', enum: ['keyed', 'verbatim'], description: 'keyed: ids are gi-<key>-n-<node>; verbatim: node ids as they are (default for RDF)' },
          },
          additionalProperties: false,
        },
        tags: { type: 'array', items: { type: 'string' } },
        dry_run: { type: 'boolean', description: 'Report what would be written without writing' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ format: formatIn, text: textIn, url, edges_text: edgesTextIn, edges_url, name, rdf, parquet, mapping, tags, dry_run }) => {
      let text = textIn ?? ''
      let edges_text = edgesTextIn
      let format = formatIn
      let bytes: ArrayBuffer | undefined
      let edgeBytes: ArrayBuffer | undefined
      // A fetched file is read within the graph file bounds (`GRAPH_FILE_LIMITS`), whatever the server says it sends.
      const { readGraphResponse, readGraphText } = await import('../../core/exchange/graph/limits')
      if (url) {
        // RDF is asked for as RDF: a SPARQL endpoint answers a CONSTRUCT in whatever its default is unless the request
        // says — Wikidata's is RDF/XML, whatever `format=` says — and N-Triples or Turtle is what the importer reads.
        const wantsRdf = format === 'rdf' || /\/sparql\b/i.test(url)
        const res = await fetchHandedUrl(host, url, 'Importing a graph', wantsRdf ? { accept: RDF_ACCEPT } : undefined)
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
        const fname = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '')
        name ??= fname.replace(/\.[^.]+$/, '') || undefined
        const ct = res.headers.get('content-type') ?? ''
        const byExt = findGraphFormat(fname)?.id ?? (/\.json$/i.test(fname) ? 'json' : /\.csv$/i.test(fname) && edges_url ? 'nodes_edges_csv' : undefined)
        // Parquet is bytes: read it so when it is named so, or when nothing names the format and the bytes say PAR1.
        if (format === 'parquet' || (!format && (byExt === 'parquet' || /parquet/.test(ct) || (!byExt && /octet-stream/.test(ct))))) {
          bytes = await readGraphResponse(res, fname || 'The file')
          const { isParquet } = await import('../../core/exchange/graph/parquet')
          if (!format && isParquet(bytes)) format = 'parquet'
          else if (!format) text = new TextDecoder().decode(bytes)
        } else text = await readGraphText(res, fname || 'The file')
        if (!format) format = byExt ?? (/n-triples|turtle|n-quads|trig|n3/.test(ct) ? 'rdf' : /json/.test(ct) ? 'json' : undefined)
      } else if (textIn === undefined) throw new Error(format === 'parquet' ? 'Parquet is imported from a `url` (or dropped on the Datasets page), not as text.' : 'Pass `text` or `url`.')
      if (edges_url) {
        if (format !== 'parquet' && format !== 'nodes_edges_csv') throw new Error('edges_url is for a two-file format: parquet or nodes_edges_csv.')
        const res = await fetchHandedUrl(host, edges_url, 'Importing a graph')
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${edges_url}`)
        if (format === 'parquet') edgeBytes = await readGraphResponse(res, 'The edges file')
        else edges_text = await readGraphText(res, 'The edges file')
      }
      if (!format) throw new Error('Pass `format`: the URL did not say.')
      if (!url && text.length + (edges_text?.length ?? 0) > 2_000_000) throw new Error('That is over 2 MB; drop the file on the Datasets page instead.')
      // `.json` is aegraph's own document unless it holds a node-link graph (d3, NetworkX, vega-datasets’ miserables).
      if (format === 'json') {
        const { isNodeLink } = await import('../../core/exchange/graph/nodeLink')
        try {
          if (isNodeLink(JSON.parse(text))) format = 'node_link_json'
        } catch {
          /* not JSON at all: the document path below says so */
        }
      }
      if (format === 'json') {
        const file = new File([text], `${name ?? 'import'}.ae.json`, { type: 'application/json' })
        const parsed = await parseFile(file, {})
        if (dry_run) return json({ dryRun: true, entities: parsed.entities.length, skipped: parsed.skipped })
        await loadParsed(parsed, store, { mode: 'merge' })
        return json({ imported: parsed.entities.length, skipped: parsed.skipped })
      }
      if (format === 'parquet' && !bytes) throw new Error('Parquet is imported from a `url` (or dropped on the Datasets page), not as text.')
      const f = GRAPH_FORMATS.find((x) => x.id === format)!
      const files = format === 'nodes_edges_csv' ? [{ name: 'nodes.csv', text }, ...(edges_text ? [{ name: 'edges.csv', text: edges_text }] : [])] : [{ name: `${name ?? 'import'}.${f.extensions[0] ?? 'json'}`, text }]
      const parsed = format === 'parquet' ? await (async () => {
            const m = await import('../../core/exchange/graph/parquet')
            return m.parseParquetGraph(bytes!, edgeBytes, { columns: parquet?.columns, limit: parquet?.limit, idColumn: parquet?.id_column, labelColumn: parquet?.label_column, sourceColumn: parquet?.source_column, targetColumn: parquet?.target_column, rescale: parquet?.rescale })
          })() : format === 'rdf' ? await (async () => {
            const m = await import('../../core/exchange/graph/rdf')
            return m.parseRdf(text, { format: url ? m.rdfFormatFor(url.split('?')[0]) : undefined, lang: rdf?.lang, stubs: rdf?.stubs, skipPredicates: rdf?.skip_predicates, maxTags: rdf?.max_tags })
          })() : await f.parse(files)
      const inferred = inferGraphMapping(parsed, name ?? files[0].name)
      const m: GraphMappingSpec = {
        ...inferred,
        ...(mapping?.label_attr !== undefined ? { labelAttr: mapping.label_attr || undefined } : {}),
        ...(mapping?.type_attr !== undefined ? { typeBy: mapping.type_attr ? 'attr' : 'fixed', typeAttr: mapping.type_attr || undefined } : {}),
        ...(mapping?.fixed_type ? { fixedType: mapping.fixed_type, ...(mapping.type_attr === undefined && !inferred.typeAttr ? { typeBy: 'fixed' as const } : {}) } : {}),
        ...(mapping?.tags_attr !== undefined ? { tagsAttr: mapping.tags_attr || undefined } : {}),
        ...(mapping?.edge_type_attr !== undefined ? { edgeTypeBy: mapping.edge_type_attr ? 'attr' : 'fixed', edgeTypeAttr: mapping.edge_type_attr || undefined } : {}),
        ...(mapping?.fixed_edge_type ? { fixedEdgeType: mapping.fixed_edge_type } : {}),
        ...(mapping?.directed ? { directed: mapping.directed } : {}),
        ...(mapping?.import_layout !== undefined ? { importLayout: mapping.import_layout } : {}),
        ...(mapping?.import_colors !== undefined ? { importColors: mapping.import_colors } : {}),
        ...(mapping?.reuse_existing_ids !== undefined ? { reuseExistingIds: mapping.reuse_existing_ids } : {}),
        ...(mapping?.description_attr !== undefined ? { descriptionAttr: mapping.description_attr || undefined } : {}),
        ...(mapping?.id_mode ? { idMode: mapping.id_mode } : {}),
        tags: parseTags(tags ?? []),
      }
      const plan = planGraphImport(store, parsed, m, `import:${format}`)
      const summary = { format, importKey: m.importKey, idMode: m.idMode ?? 'keyed', nodes: parsed.nodes.length, edges: parsed.edges.length, mapping: { labelAttr: m.labelAttr, descriptionAttr: m.descriptionAttr, typeBy: m.typeBy, typeAttr: m.typeAttr, fixedType: m.fixedType, tagsAttr: m.tagsAttr, edgeTypeBy: m.edgeTypeBy, edgeTypeAttr: m.edgeTypeAttr, directed: m.directed }, attributeKeys: parsed.attributeKeys, created: plan.created, updated: plan.updated, reused: plan.reused, relationships: plan.relationships.length, skippedEdges: plan.skippedEdges, layout: plan.layout ? summarize(plan.layout) : undefined, warnings: plan.warnings.slice(0, 10) }
      if (dry_run) return json({ dryRun: true, ...summary, sample: plan.entities.slice(0, 5).map(summarize) })
      applyGraphPlan(store, plan)
      return json({ ...summary, note: plan.layout ? 'Positions saved as a layout entity; load it with graph_layout {layout_id}.' : undefined })
    },
  })

  const graphQuery = betaTool({
    name: 'graph_query',
    description:
      'Look at nodes as a table: select them (types, tags, text, predicates on any ValueRef, roots+depth, the current selection, or explicit ids — in the view or the whole dataset), sort by a value, and read values off them. Use it to check what a placement or style will use before applying it.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_SCHEMA,
        values: { type: 'array', items: { type: 'string' }, description: `ValueRefs to read per row. ${VALUE_REF_HELP}` },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows to return (default 50)' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['selector'],
      additionalProperties: false,
    } as const,
    run: async ({ selector, values, limit, mode }) => {
      const h = await explorer(mode)
      for (const v of values ?? []) if (!isValidValueRef(v)) throw new Error(`Unknown value ref "${v}". ${VALUE_REF_HELP}`)
      const r = h.resolve(selectorFrom(selector))
      const ctx = h.getValueContext()
      const cap = limit ?? 50
      const missing: Record<string, number> = {}
      const rows = r.nodes.slice(0, cap).map((n) => {
        const out: Record<string, unknown> = {}
        for (const v of values ?? []) {
          const val = valueOf(n, v, ctx)
          if (val === undefined) missing[v] = (missing[v] ?? 0) + 1
          out[v] = val
        }
        return { ...brief(store, n.id), ...(values?.length ? { values: out } : {}) }
      })
      return json({ selector: describeSelector(selectorFrom(selector)), count: r.total, truncated: Math.max(0, r.total - cap), rows, ...(Object.keys(missing).length ? { missing } : {}), ...(r.skipped.length ? { skipped: r.skipped, note: 'metric.* predicates need computed metrics (graph_metrics).' } : {}), ...(r.outsideView ? { outsideView: r.outsideView, hint: 'More nodes match in the dataset but are filtered out of the view; pass selector.scope "dataset" or loosen the filter.' } : {}) })
    },
  })

  const graphPositions = betaTool({
    name: 'graph_positions',
    description:
      'Read or set node positions directly (a position layout). get: positions + bbox + viewport for a selector. set: explicit {id: {x,y,z?}} positions. place: arrange the selected nodes from values in a region of the view — grid (optionally ordered), scatter x/y(/z) by ValueRefs with optional bins (a heatmap grid: nodes sharing a cell are packed on a small spiral), circle, line, or stack by a category. Geographic ("where they are", "fixed positions on the map"): {arrangement:"geo"} — every located node where it stands (Web Mercator of data.lat / data.lng), north up, the shape kept; fine for hundreds of thousands. transform: translate/scale/rotate/align/distribute a group. Regions are anchored to the current viewport by default ("top-left of what I see"). Positions are held like drags (layoutDirty); graph_save {kind:"layout"} persists them, and a placement is remembered as a rule that graph_layout {rederive:true} can re-run. The same positions show in 2D and 3D.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'place', 'transform'] },
        selector: SELECTOR_SCHEMA,
        ids: { type: 'array', items: { type: 'string' }, description: 'Shorthand for selector.ids' },
        positions: { type: 'object', description: 'set: {id: {x, y, z?}}', additionalProperties: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
        spec: PLACEMENT_SCHEMA,
        transform: TRANSFORM_SCHEMA,
        fit: { type: 'boolean', description: 'Zoom to the affected nodes afterwards (default true for place/transform)' },
        save_as: { type: 'string', description: 'Also save the held positions as a named layout' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, selector, ids, positions, spec, transform, fit, save_as, mode }) => {
      const h = await explorer(mode)
      const sel = selectorFrom({ ...(selector ?? {}), ...(ids ? { ids } : {}) })
      const doFit = (targets: string[]) => {
        if (fit ?? action !== 'get') setTimeout(() => h.fitTo(targets), 350)
      }
      // The explorer applies a move on its next render, so the state read here is still the one from before the action:
      // what the action just produced (`fresh`, and the rule a placement set) goes over it, or a layout saved in the same
      // call would hold the positions the user just replaced — and loading it would put them back.
      const saveLayout = (fresh: Positions, rule?: LayoutRule) => {
        if (!save_as) return undefined
        const st = h.getState()
        const layoutRule = rule ?? st.layoutRule
        const e = createEntity({ type: GRAPH_TYPES.layout, label: save_as, data: { positions: { ...st.positions, ...h.getPositions(), ...fresh }, algorithm: st.algorithm, dimensions: h.dims, pinned: st.pinned, ...(layoutRule ? { rule: layoutRule } : {}) } satisfies LayoutData, tags: [], meta: { source: 'assistant' } })
        store.upsert(e)
        h.markLayoutSaved(e.id)
        return summarize(e)
      }
      if (action === 'get') {
        const r = h.resolve(sel)
        const pos = h.getPositions()
        const targets = r.nodes.map((n) => n.id)
        const out: Record<string, unknown> = {}
        for (const id of targets.slice(0, 500)) if (pos[id]) out[id] = pos[id]
        return json({ count: targets.length, truncated: Math.max(0, targets.length - 500), positions: out, bbox: bboxOf(targets, pos), viewport: h.getViewport(), dims: h.dims })
      }
      if (action === 'set') {
        if (!positions || !Object.keys(positions).length) throw new Error('set needs positions: {id: {x, y, z?}}.')
        for (const id of Object.keys(positions)) requireEntity(store, id)
        h.setPositions(positions as Positions)
        doFit(Object.keys(positions))
        return json({ moved: Object.keys(positions).length, saved: saveLayout(positions as Positions) })
      }
      if (action === 'place') {
        if (!spec) throw new Error('place needs spec.')
        for (const ref of [spec.x, spec.y, spec.z, spec.order]) if (ref && !isValidValueRef(ref)) throw new Error(`Unknown value ref "${ref}". ${VALUE_REF_HELP}`)
        const computed = h.getMetrics()?.columns ?? {}
        for (const ref of [spec.x, spec.y, spec.z, spec.order]) if (ref && refUsesMetrics(ref) && !(ref.slice(7) in computed)) throw new Error(`Metric "${ref.slice(7)}" has not been computed; call graph_metrics first.`)
        const region: Region = { of: spec.region?.of ?? 'viewport', rect: spec.region?.rect ? { minX: spec.region.rect.min_x, minY: spec.region.rect.min_y, maxX: spec.region.rect.max_x, maxY: spec.region.rect.max_y } : undefined, anchor: spec.region?.anchor, size: spec.region?.fraction !== undefined ? { fraction: spec.region.fraction } : spec.region?.width !== undefined && spec.region?.height !== undefined ? { w: spec.region.width, h: spec.region.height } : undefined, margin: spec.region?.margin }
        const ps: PlacementSpec = { arrangement: spec.arrangement, x: spec.x, y: spec.y, z: spec.z, bins: spec.bins, scale: spec.scale, order: spec.order, desc: spec.desc, cols: spec.cols, spacing: spec.spacing, jitter: spec.jitter, aspect: spec.aspect, geo: spec.geo, region }
        const vp = h.getViewport()
        const r = h.place(sel, ps)
        const placed = Object.keys(r.positions).filter((id) => !r.unplaced.includes(id))
        if (!placed.length && !r.unplaced.length) throw new Error(`The selector matched nothing in the view (${describeSelector(sel)}). Try selector.scope "dataset" or loosen the filter.`)
        doFit([...placed, ...r.unplaced])
        return json({
          placed: placed.length,
          unplaced: r.unplaced.length,
          ...(r.unplaced.length ? { unplacedNote: 'Nodes without a value on an axis were parked just left of the region.' } : {}),
          region: r.region,
          axes: r.axes,
          cells: r.cells?.filter((c) => c.count).slice(0, 200).map((c) => ({ x: c.x, y: c.y, count: c.count, ...(c.label ? { label: c.label } : {}) })),
          rule: describePlacement(ps),
          ...(vp?.tilted ? { note: 'The 3D camera is tilted; "viewport" regions are approximate. Use graph_viewport {action:"set"} to look straight down first.' } : {}),
          saved: saveLayout(r.positions, { kind: 'placement', selector: sel, spec: ps }),
        })
      }
      if (action === 'transform') {
        if (!transform) throw new Error('transform needs transform: {translate | scale | rotate | align | distribute}.')
        const r = h.resolve(sel)
        const targets = r.nodes.map((n) => n.id)
        if (!targets.length) throw new Error(`The selector matched nothing in the view (${describeSelector(sel)}).`)
        const op: TransformOp = { translate: transform.translate, scale: transform.scale, rotate: transform.rotate, about: transform.about, align: transform.align, distribute: transform.distribute, to: transform.to ? { minX: transform.to.min_x, minY: transform.to.min_y, maxX: transform.to.max_x, maxY: transform.to.max_y } : transform.align ? (h.getViewport() ?? undefined) : undefined }
        const moved = h.transformPositions(targets, op)
        doFit(targets)
        return json({ moved: Object.keys(moved).length, bbox: bboxOf(Object.keys(moved), moved), saved: saveLayout(moved) })
      }
      throw new Error(`Unknown action ${action}`)
    },
  })

  const graphViewport = betaTool({
    name: 'graph_viewport',
    description: 'The visible rectangle in graph coordinates and the camera. get: read them. fit: zoom to a selector / ids (or everything). set: move the camera (2D: center/ratio/angle; 3D: position + look-at). pan: slide the camera by `by` {x, y} in widths and heights of the view (x right, y up; 0.25 is a quarter of the view) — what the arrow keys do, in 2D over the plane and in 3D in the plane facing the camera, the zoom and the angle kept. zoom: `factor` about the centre of the view (2 is twice as close, 0.5 twice as far) — what Q and E do. orbit (3D): turn the camera around the point it looks at by `yaw` (degrees, positive to the right) and `pitch` (degrees, positive up over the top) — what W A S D do while orbiting. The 3D camera has two sets of controls, one switch for every view (bottom right of the picture, left of the key hint; `controls` sets it, and every answer says which is on): `orbit` (the default — the keys and mouse turn the camera around the point it looks at, and zoom closes on it) and `fly` (they move the camera itself — W/S forward and back, A/D sideways, Q/E down and up, arrows and a drag look around — through the graph and past it). Whichever is on, fly (3D): move the camera and the point it looks at together by `move` {forward, right, up}, in shares of the graph\'s size (1 is its whole extent; negative backward, left, down) — what W A S D and Q/E do while flying; look (3D): turn the view about the camera by `yaw` (degrees, positive to the right) and `pitch` (degrees, positive up), the camera staying put — what the arrows do while flying. `panel` opens one of the side panels (filter, layout, style, stats, selection — the toolbar\'s buttons top left) or closes it with "none"; `full` is Full view: the panel closed and the app sidebar folded to its rail (the picture alone, as the full-view button does), or both brought back. A 2D move flies the zoom-and-pan path the app uses (pulling back over a long pan, settling in at the end), taking 320–900 ms by its length unless `ms` says otherwise; the result is read once the flight has landed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'fit', 'set', 'pan', 'zoom', 'orbit', 'fly', 'look'] },
        controls: { type: 'string', enum: ['orbit', 'fly'], description: 'Switch the 3D camera controls for the keys and the mouse, as the Orbit / Fly switch bottom right does: orbit (default) turns around the point the camera looks at; fly moves the camera itself. Remembered in this browser.' },
        move: { type: 'object', description: 'fly: how far, in shares of the graph\'s size — forward along the line of sight, right (level), up (vertical); negative for back, left, down', properties: { forward: { type: 'number', minimum: -50, maximum: 50 }, right: { type: 'number', minimum: -50, maximum: 50 }, up: { type: 'number', minimum: -50, maximum: 50 } }, additionalProperties: false },
        factor: { type: 'number', exclusiveMinimum: 0, maximum: 1000, description: 'zoom: how much closer (>1) or further (<1)' },
        yaw: { type: 'number', minimum: -360, maximum: 360, description: 'orbit: degrees around, positive to the right; look: degrees to turn the view, positive to the right' },
        pitch: { type: 'number', minimum: -180, maximum: 180, description: 'orbit: degrees up (positive) or down, stopping short of straight over or under; look: degrees to tilt the view up (positive) or down' },
        by: { type: 'object', description: 'pan: how far, in fractions of the view (x right, y up; negative for left and down)', properties: { x: { type: 'number', minimum: -20, maximum: 20 }, y: { type: 'number', minimum: -20, maximum: 20 } }, additionalProperties: false },
        selector: SELECTOR_SCHEMA,
        ids: { type: 'array', items: { type: 'string' } },
        padding: { type: 'number', minimum: 0, maximum: 2, description: 'fit: extra room around the nodes (fraction, default 0.15)' },
        ms: { type: 'number', minimum: 0, maximum: 5000, description: 'fit / set: how long the camera takes, in milliseconds; 0 jumps. Omitted, the distance decides (2D: 320–900 ms; 3D: 300–400 ms).' },
        camera: {
          type: 'object',
          properties: {
            center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
            ratio: { type: 'number', description: '2D zoom: graph units per pixel-ish; smaller = closer' },
            angle: { type: 'number' },
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false },
            look_at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false },
          },
          additionalProperties: false,
        },
        panel: { type: 'string', enum: ['filter', 'layout', 'style', 'stats', 'selection', 'none'], description: 'Open this side panel beside the picture (one is open at a time; the same as clicking its button top left of the toolbar), or "none" to close whichever is open (clicking the open one\'s button again). Opening a panel unfolds the app sidebar if Full view was what folded it. The picture holds still; nothing refits.' },
        full: { type: 'boolean', description: 'Full view: true closes the side panel and folds the app sidebar to its rail so the picture has the width; false opens the panel that was open before (Filter, to begin with) and unfolds the sidebar if full view was what folded it. The details panel and the assistant are left as they are. The camera refits either way.' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      additionalProperties: false,
    } as const,
    run: async ({ action, selector, ids, padding, camera, panel, full, mode, ms, by, factor, yaw, pitch, controls, move }) => {
      const h = await explorer(mode)
      const act = action ?? 'get'
      if (controls !== undefined) setCameraControls(controls)
      // The longest flight the renderers take when `ms` is theirs to choose, plus a frame: the answer is where it landed.
      const landed = () => new Promise((r) => setTimeout(r, (ms ?? 900) + 50))
      if (panel !== undefined) {
        if (!h.setPanel) throw new Error('This explorer has no side panel.')
        h.setPanel(panel === 'none' ? null : panel)
        await new Promise((r) => setTimeout(r, 400))
      }
      if (full !== undefined) {
        if (!h.setFullView) throw new Error('This explorer has no side panel to fold.')
        h.setFullView(full)
        await new Promise((r) => setTimeout(r, 400))
      }
      if (act === 'fit') {
        const targets = selector || ids ? h.resolve(selectorFrom({ ...(selector ?? {}), ...(ids ? { ids } : {}) })).nodes.map((n) => n.id) : h.getSlice().nodes.map((n) => n.id)
        if (!targets.length) throw new Error('Nothing to fit.')
        h.fitTo(targets, { padding, ...(ms !== undefined ? { ms } : {}) })
        await landed()
        return json({ fitted: targets.length, viewport: h.getViewport(), camera: h.getCamera() })
      }
      if (act === 'pan') {
        if (!by || (!by.x && !by.y)) throw new Error('pan needs by {x, y}: fractions of the view, x right and y up.')
        h.panBy(by.x ?? 0, by.y ?? 0)
        await new Promise((r) => setTimeout(r, 50))
      }
      if (act === 'zoom') {
        if (!factor) throw new Error('zoom needs factor: 2 is twice as close, 0.5 twice as far.')
        h.zoomBy(factor)
        await new Promise((r) => setTimeout(r, 50))
      }
      if (act === 'orbit') {
        if (h.dims !== 3) throw new Error('orbit turns the 3D camera; this view is 2D (open /unigraph/3d, or mode "3d").')
        if (!yaw && !pitch) throw new Error('orbit needs yaw and/or pitch, in degrees.')
        h.orbitBy(((yaw ?? 0) * Math.PI) / 180, ((pitch ?? 0) * Math.PI) / 180)
        await new Promise((r) => setTimeout(r, 50))
      }
      if (act === 'fly' || act === 'look') {
        if (h.dims !== 3) throw new Error(`${act} moves the 3D camera; this view is 2D (open /unigraph/3d, or mode "3d").`)
        const cam = h.getCamera()
        if (cam?.kind !== '3d') throw new Error('The 3D camera is not ready yet.')
        let next: { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }
        if (act === 'fly') {
          if (!move || (!move.forward && !move.right && !move.up)) throw new Error('fly needs move {forward, right, up}: shares of the graph\'s size.')
          const size = graphExtent(h.getPositions())
          next = flyCamera(cam.position, cam.lookAt, (move.forward ?? 0) * size, (move.right ?? 0) * size, (move.up ?? 0) * size)
        } else {
          if (!yaw && !pitch) throw new Error('look needs yaw and/or pitch, in degrees.')
          next = lookCamera(cam.position, cam.lookAt, ((yaw ?? 0) * Math.PI) / 180, ((pitch ?? 0) * Math.PI) / 180)
        }
        h.setCamera(next, ms ?? 0)
        await new Promise((r) => setTimeout(r, (ms ?? 0) + 50))
      }
      if (act === 'set') {
        if (!camera) throw new Error('set needs camera.')
        if (h.dims === 3) {
          if (!camera.position) throw new Error('3D camera needs position (and optionally look_at).')
          h.setCamera({ position: camera.position, lookAt: camera.look_at }, ms)
        } else h.setCamera({ center: camera.center, ratio: camera.ratio, angle: camera.angle }, ms)
        await landed()
      }
      const vp = h.getViewport()
      return json({ dims: h.dims, controls: getCameraControls(), viewport: vp, camera: h.getCamera(), bbox: bboxOf(h.getSlice().nodes.map((n) => n.id), h.getPositions()), panel: h.getPanel?.() ?? null, full: h.isFullView?.() ?? false })
    },
  })

  const graphProject = betaTool({
    name: 'graph_project',
    description:
      'Projects make iteration explicit. export: turn the current view (and its analysis values, when up to date) into a project entity. load: make a project the Dataset stage — its analysis values then read as data.<metric>, so you can filter and lay out by them (the only way a filter can use analysis results). unload: back to the whole workspace. list/get: saved projects and their provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'load', 'unload', 'list', 'get'] },
        name: { type: 'string', description: 'export: the project name' },
        id: { type: 'string', description: 'load/get: project id' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, name, id, tags, mode }) => {
      if (action === 'list') return json({ projects: store.ofType(GRAPH_TYPES.project).filter(isProject).map((p) => ({ ...summarize(p), ...p.data.summary, parentProjectId: p.data.parentProjectId })) })
      if (action === 'get') {
        const e = requireEntity(store, id ?? '')
        if (!isProject(e)) throw new Error(`Entity ${id} is a ${e.type}, not a project.`)
        return json({ ...summarize(e), ...e.data.summary, members: e.data.members.length, parentProjectId: e.data.parentProjectId, filterId: e.data.filterId, layoutId: e.data.layoutId, renderingId: e.data.renderingId, analysisId: e.data.analysisId, valueKeys: e.data.values ? [...new Set(Object.values(e.data.values).flatMap((r) => Object.keys(r)))] : [] })
      }
      const h = await explorer(mode)
      if (action === 'unload') {
        h.loadProject(undefined)
        return json({ dataset: 'workspace' })
      }
      if (action === 'load') {
        const e = requireEntity(store, id ?? '')
        if (!isProject(e)) throw new Error(`Entity ${id} is a ${e.type}, not a project.`)
        h.loadProject(e.id)
        return json({ loaded: summarize(e), members: e.data.members.length, valueKeys: e.data.values ? [...new Set(Object.values(e.data.values).flatMap((r) => Object.keys(r)))].map((k) => `data.${k}`) : [], note: 'The Dataset stage is now this project; filters, layouts and analyses apply within it.' })
      }
      // export
      if (!name?.trim()) throw new Error('export needs a name.')
      const st = h.getState()
      const slice = h.getSlice()
      if (!slice.nodes.length) throw new Error('The view is empty; nothing to export.')
      const fresh = st.metricsSummary && !st.metricsStale ? h.getMetrics() : undefined
      const p = buildProject(name.trim(), slice, fresh, { parentProjectId: st.projectId, filterId: st.filterDirty ? undefined : st.filterId, layoutId: st.layoutDirty ? undefined : st.layoutId, renderingId: st.renderingDirty ? undefined : st.renderingId, analysisId: st.analysisId }, 'assistant')
      if (tags?.length) p.tags = parseTags(tags)
      store.upsert(p)
      return json({ ...summarize(p), ...p.data.summary, includedAnalysis: !!fresh, ...(st.metricsSummary && st.metricsStale ? { note: 'The analysis was stale for this view and was not included; run graph_metrics first to export values.' } : {}), next: `graph_project {action:'load', id:'${p.id}'} then filter on data.<metric>.` })
    },
  })

  const graphSelection = betaTool({
    name: 'graph_selection',
    description:
      'Read or change the graph explorer\'s selection (an ordered set of visible nodes; the last is the primary one shown in the inspector). Actions: get, set/add/remove/toggle (with ids), clear, all, invert, neighbours (grow by `hops`), by_type / by_tag (every visible node sharing a type/tag with the selection).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'add', 'remove', 'toggle', 'clear', 'all', 'invert', 'neighbours', 'by_type', 'by_tag'] },
        ids: { type: 'array', items: { type: 'string' } },
        hops: { type: 'integer', minimum: 1, description: 'For neighbours (default 1)' },
        direction: { type: 'string', enum: ['out', 'in', 'both'] },
        fit: { type: 'boolean', description: 'Fit the view afterwards' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, ids, hops, direction, fit, mode }) => {
      const h = await explorer(mode)
      const visible = new Set(h.getSlice().nodes.map((n) => n.id))
      let outside: string[] = []
      // The explorer applies dispatches on its next render, so report the result we computed rather than re-reading state.
      let sel = h.getState().selectedIds
      if (action === 'set' || action === 'add' || action === 'remove' || action === 'toggle') {
        if (!ids?.length && action !== 'set') throw new Error(`Provide ids for ${action}.`)
        for (const id of ids ?? []) requireEntity(store, id)
        outside = (ids ?? []).filter((id) => !visible.has(id))
        const inView = (ids ?? []).filter((id) => visible.has(id))
        const m = action === 'set' ? 'replace' : action
        h.setSelection(inView, m)
        sel = applySelect(sel, inView, m)
      } else if (action === 'clear') {
        h.setSelection([], 'replace')
        sel = []
      } else if (action === 'all') sel = h.selectOp({ op: 'all' })
      else if (action === 'invert') sel = h.selectOp({ op: 'invert' })
      else if (action === 'neighbours') sel = h.selectOp({ op: 'neighbours', hops: hops ?? 1, direction })
      else if (action === 'by_type') sel = h.selectOp({ op: 'byType' })
      else if (action === 'by_tag') sel = h.selectOp({ op: 'byTag' })
      if (fit) setTimeout(() => h.fit(), 350)
      return json({
        count: sel.length,
        primary: sel[sel.length - 1],
        ids: sel.slice(0, 100),
        labels: sel.slice(0, 100).map((id) => brief(store, id)),
        truncated: Math.max(0, sel.length - 100),
        ...(outside.length ? { note: `${outside.length} id(s) are not in the current view and were ignored: ${outside.slice(0, 5).join(', ')}` } : {}),
      })
    },
  })

  const graphSelectionAction = betaTool({
    name: 'graph_selection_action',
    description:
      'Act on nodes (the current selection unless `ids` is given): tag / untag (bulk), hide / unhide (filter exclude list; unhide with no ids restores all), pin / unpin (hold in place during force layouts), focus (restrict the view to their neighbourhood), delete (asks the user to confirm), export (returns an aegraph document of the nodes and the relationships among them), highlight_hops (how far the selection’s highlight reaches: nodes within `hops` links of the selected ones stay lit while the rest dims, 1–6; the Selection panel’s Highlight).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tag', 'untag', 'hide', 'unhide', 'pin', 'unpin', 'focus', 'delete', 'export', 'highlight_hops'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Defaults to the current selection' },
        tags: { type: 'array', items: { type: 'string' }, description: 'For tag / untag' },
        depth: { type: 'integer', minimum: 1, description: 'For focus (default 1)' },
        hops: { type: 'integer', minimum: 1, maximum: 6, description: 'For highlight_hops' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, ids, tags, depth, hops, mode }) => {
      const h = await explorer(mode)
      const st = h.getState()
      if (action === 'highlight_hops') {
        h.setHops(hops ?? 1)
        return json({ action, hops: hops ?? 1 })
      }
      const targets = ids?.length ? ids : st.selectedIds
      if (action === 'unhide') {
        const exclude = ids?.length ? (st.filter.exclude ?? []).filter((id) => !ids.includes(id)) : []
        h.setFilter({ ...st.filter, exclude })
        return json({ action, hidden: exclude.length })
      }
      if (!targets.length) throw new Error('Nothing is selected; pass ids or select nodes first (graph_selection).')
      for (const id of targets) requireEntity(store, id)
      switch (action) {
        case 'tag':
        case 'untag': {
          const clean = parseTags(tags ?? [])
          if (!clean.length) throw new Error('Provide tags.')
          let n = 0
          store.transaction(() => {
            for (const id of targets) {
              const e = store.get(id)!
              const next = action === 'tag' ? parseTags([...e.tags, ...clean]) : e.tags.filter((t) => !clean.includes(t))
              if (next.length !== e.tags.length) {
                store.update(id, { tags: next })
                n++
              }
            }
          })
          return json({ action, affected: n, tags: clean })
        }
        case 'hide': {
          const exclude = [...new Set([...(st.filter.exclude ?? []), ...targets])]
          h.setFilter({ ...st.filter, exclude })
          h.setSelection(targets, 'remove')
          return json({ action, affected: targets.length, hidden: exclude.length })
        }
        case 'pin':
        case 'unpin': {
          const set = new Set(st.pinned)
          for (const id of targets) if (action === 'pin') set.add(id)
          else set.delete(id)
          h.setPinned([...set])
          return json({ action, affected: targets.length, pinned: set.size })
        }
        case 'focus': {
          const filter = { ...st.filter, roots: targets, depth: depth ?? (st.filter.roots?.length ? st.filter.depth : 1) }
          h.setFilter(filter)
          const slice = applyFilter(store, registry(), filter)
          setTimeout(() => h.fit(), 350)
          return json({ action, filter: describeFilter(filter), nodes: slice.nodes.length, edges: slice.edges.length })
        }
        case 'delete': {
          const ok = await host.confirm(`Delete ${targets.length} node${targets.length === 1 ? '' : 's'} from the graph? Attached relationships go too.`, { yes: 'Delete', danger: true })
          if (!ok) return 'The user declined. Nothing was deleted.'
          store.remove(targets)
          h.setSelection(targets, 'remove')
          return json({ action, deleted: targets.length })
        }
        case 'export': {
          const rows = targets.map((id) => store.get(id)!).slice(0, 500)
          const doc = entitiesToDocument(store, rows)
          for (const e of doc.entities) if (typeof e.data.content === 'string' && e.data.content.length > 2000) e.data = { ...e.data, content: e.data.content.slice(0, 2000) + '…' }
          return json({ action, entities: doc.entities.length, ...(targets.length > 500 ? { note: 'Capped at 500 nodes; use the selection bar\'s download for more.' } : {}), document: doc })
        }
      }
      throw new Error(`Unknown action ${action}`)
    },
  })

  const graphPath = betaTool({
    name: 'graph_path',
    description: 'Shortest path between two nodes in the current graph view (bidirectional BFS, or Dijkstra on an edge weight field), highlighted on the canvas. Direction is ignored unless `directed` is true.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        directed: { type: 'boolean', description: 'Follow relationship direction (default false)' },
        weighted: { type: 'boolean', description: 'Minimise total weight instead of hops' },
        weight_field: { type: 'string', description: 'Relationship attribute path, default data.weight' },
        select: { type: 'boolean', description: 'Also add the path nodes to the selection' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    } as const,
    run: async ({ from, to, directed, weighted, weight_field, select, mode }) => {
      const h = await explorer(mode)
      requireEntity(store, from)
      requireEntity(store, to)
      const visible = new Set(h.getSlice().nodes.map((n) => n.id))
      if (!visible.has(from) || !visible.has(to)) throw new Error('Both endpoints must be in the current view; loosen the filter or use graph_filter with roots.')
      h.setPathOptions({ directed: !!directed, weighted: !!weighted, weightField: weight_field || undefined })
      const path = h.computePath(from, to)
      if (!path) return json({ found: false, from: brief(store, from), to: brief(store, to), directed: !!directed, note: 'No path within the current view.' })
      if (select) h.setSelection(path.nodes, 'add')
      setTimeout(() => h.fit(), 350)
      return json({ found: true, length: path.length, weight: path.weight, nodes: path.nodes.map((id) => brief(store, id)), edges: path.edges.map((id) => summarize(store.get(id)!)), directed: !!directed, weighted: !!weighted })
    },
  })

  const graphSelect = betaTool({
    name: 'graph_select',
    description: 'Select a node in the graph explorer (opens its inspector), optionally focusing the view on its neighbourhood, and fit the view. Pass no id to clear the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        focus: { type: 'boolean', description: 'Restrict the filter to this node\'s neighbourhood' },
        depth: { type: 'integer', minimum: 1, description: 'Hops when focusing (default 1)' },
        mode: { type: 'string', enum: ['2d', '3d', 'gpu', 'gpu3d'] },
      },
      additionalProperties: false,
    } as const,
    run: async ({ id, focus, depth, mode }) => {
      const h = await explorer(mode)
      if (!id) {
        h.select(undefined)
        return json({ selected: null })
      }
      h.setTool('select')
      const e = requireEntity(store, id)
      if (isRelationship(e)) throw new Error('Relationships are edges, not selectable nodes.')
      let filter = h.getState().filter
      if (focus) {
        filter = { ...filter, roots: [id], depth: depth ?? (filter.roots?.length ? filter.depth : 1) }
        h.setFilter(filter)
      }
      const slice = applyFilter(store, registry(), filter)
      const inView = slice.nodes.some((n) => n.id === id)
      h.select(id)
      setTimeout(() => h.fit(), 350)
      return json({ selected: summarize(e), inView, degree: slice.degree.get(id) ?? 0, ...(focus ? { filter: describeFilter(filter), nodes: slice.nodes.length, edges: slice.edges.length } : {}), ...(inView ? {} : { note: 'The node is outside the current filter; use graph_filter (or focus: true) to bring it into view.' }) })
    },
  })

  return [graphState, graphFilter, graphLayout, graphStyle, graphSave, graphSelect, graphMetrics, graphQuery, graphPositions, graphViewport, graphProject, graphExport, importGraph, graphSelection, graphSelectionAction, graphPath]
}

/** The graph's size for the fly controls' units: its largest extent over x, y and z (1 for an empty or one-point graph). */
function graphExtent(positions: Positions): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const p of Object.values(positions)) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
    const z = p.z ?? 0
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  const e = Math.max(x1 - x0, y1 - y0, z1 - z0)
  return Number.isFinite(e) && e > 0 ? e : 1
}

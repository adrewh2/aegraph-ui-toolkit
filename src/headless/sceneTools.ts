import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { createEntity, displayLabel, quoteLabel, parseTags } from '../core/entity/entity'
import type { AnyEntity, EntityId } from '../core/entity/types'
import { applyFilter, describeFilter, type FilterSpec } from '../core/graph/filter'
import { computeLayout, DEFAULT_LAYOUT_PARAMS, LAYOUTS, layoutTooBig, type LayoutAlgorithm, type Positions } from '../core/graph/layouts'
import { computeMetrics, createAnalysisEntity, METRIC_IDS, serializeSlice, type MetricsResult, type NodeMetricId } from '../core/graph/metrics'
import { PALETTES } from '../core/graph/palettes'
import { buildProject } from '../core/graph/project'
import { DEFAULT_RENDERING, describeRendering, toRenderingSpec, type RenderingData, type RenderingSpec } from '../core/graph/rendering'
import { applyStyleChannels, SHAPE_IDS, type StyleChannelInput } from '../core/graph/styleChannels'
import '../core/slides/slides'
import { graphSceneTypeFor, GRAPH_SCENE_TYPES, type SceneCamera, type SceneData, type SceneView } from '../core/graph/scene'
import { graphScenePreview } from '../core/graph/thumbnail'
import { GRAPH_TYPES, type FilterData, type LayoutData } from '../core/graph/types'
import { json, summarize } from '../features/assistant/toolkit'
import { FILTER_PROPS, specFrom, type FilterInput } from './graphTools'
import type { HeadlessEngine } from './engine'

/**
 * Scenes, composed rather than captured.
 *
 * A Unigraph scene is *data + filter + layout + style*, plus the metadata
 * that puts the screen back as it was: the camera, what is labelled, which
 * panels were open. In a tab the explorer holds all of that and `graph_save`
 * takes a copy; headless there is nothing to copy from, so a scene is
 * written from a description — the same four parts, each saved as its own
 * entity exactly as the explorer saves them, and one scene entity binding
 * them. Loading it in the app gives the picture this described, because the
 * app reads the same four entities.
 *
 * The data stage is the workspace or the open project by default; naming a
 * `data_project` (an exported view — a graph `project` entity) pins the
 * scene to that slice and its metric values, which is how an analysed view
 * becomes the input of the next one.
 */

const CHANNEL_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['nodes', 'edges'] },
    by: { type: 'string', enum: ['all', 'types', 'tags'], description: '"all" sets the default for every node/edge; "types"/"tags" override for one type or tag (needs key)' },
    key: { type: 'string', description: 'Type name or tag when by is types/tags' },
    channel: { type: 'string', enum: ['color', 'size', 'opacity', 'shape', 'width'], description: 'size/shape are node channels; width is an edge channel' },
    mode: { type: 'string', enum: ['constant', 'ranking', 'partition', 'inherit'] },
    value: { description: 'Constant: a CSS colour, a number (size px / opacity 0–1 / width px), or a shape' },
    attr: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['degree', 'field', 'metric', 'type', 'tag', 'directed', 'value'] }, key: { type: 'string', description: 'field name/path, or a metric id' }, dir: { type: 'string', enum: ['both', 'in', 'out'] }, prefix: { type: 'string', description: 'tag prefix, e.g. "service:" — the namespace becomes the partition' }, ref: { type: 'string', description: 'kind "value": any ValueRef — data.<key>, meta.updatedAt, degree.in:cites, metric.pagerank' } },
      additionalProperties: false,
    },
    palette: { type: 'string', enum: PALETTES.map((p) => p.id) },
    colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Colour partition: explicit colour per category value' },
    shapes: { type: 'object', additionalProperties: { type: 'string', enum: SHAPE_IDS }, description: 'Shape partition: explicit shape per category value' },
    domain: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    log: { type: 'boolean' },
    min: { type: 'number' },
    max: { type: 'number' },
    max_categories: { type: 'integer', minimum: 2, maximum: 40 },
  },
  required: ['scope', 'by', 'channel', 'mode'],
  additionalProperties: false,
} as const

const CAMERA_SCHEMA = {
  type: 'object',
  description: 'Where the camera is when the scene opens. 2D: centre and ratio (1 = fit, smaller is closer). 3D: the eye position and what it looks at. Omit it and the view fits the graph on landing.',
  properties: {
    kind: { type: 'string', enum: ['2d', '3d'] },
    center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false },
    ratio: { type: 'number', description: '2D zoom' },
    angle: { type: 'number', description: '2D rotation, radians' },
    position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false },
    lookAt: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false },
  },
  additionalProperties: false,
} as const

const VIEW_SCHEMA = {
  type: 'object',
  description: 'The screen around the picture, restored with the scene: the camera, labels, edges, the legend, the side panel, the neighbourhood depth of a selection.',
  properties: {
    camera: CAMERA_SCHEMA,
    labels: { type: 'string', enum: ['auto', 'all', 'none'] },
    show_edges: { type: 'boolean' },
    show_legend: { type: 'boolean' },
    hops: { type: 'integer', minimum: 0, maximum: 5, description: 'Hops highlighted around a selection' },
    panel: { type: 'string', enum: ['filter', 'layout', 'style', 'stats', 'selection', 'none'], description: 'Which side panel is open (default none)' },
    selected: { type: 'array', items: { type: 'string' }, description: 'Entity ids selected when the scene opens' },
    slides: {
      type: 'object',
      description: 'The slide layer of the 3D view: whether the decks\' slides hang over the graph, which decks (all when absent), the slide in front. A scene per deck over one shared layout switches decks without moving the graph.',
      properties: {
        show: { type: 'boolean' },
        decks: { type: 'array', items: { type: 'string' }, description: 'Deck ids to show' },
        focus: { type: 'string', description: 'A slide id to bring to the front' },
        parts: { type: 'boolean', description: 'Composed slides\' blocks hung as plates beneath them (default true)' },
        story: { type: 'boolean', description: 'The story layer: each deck\'s outline as a directed row of beats (default on when there are stories)' },
        spatial: { type: 'boolean', description: 'The blueprints: each composed slide\'s frame and the rectangles of its regions (default on when there are stories)' },
        final: { type: 'boolean', description: 'The finished slides (default true)' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

type ViewInput = {
  camera?: { kind?: '2d' | '3d'; center?: { x: number; y: number }; ratio?: number; angle?: number; position?: { x: number; y: number; z: number }; lookAt?: { x: number; y: number; z: number } }
  labels?: 'auto' | 'all' | 'none'
  show_edges?: boolean
  show_legend?: boolean
  hops?: number
  panel?: 'filter' | 'layout' | 'style' | 'stats' | 'selection' | 'none'
  selected?: EntityId[]
  slides?: { show?: boolean; decks?: EntityId[]; focus?: EntityId; parts?: boolean; story?: boolean; spatial?: boolean; final?: boolean }
}

/**
 * Where to stand in three dimensions when nothing was asked for: looking at
 * the middle of what was laid out, far enough back for all of it, three
 * quarters on so depth reads as depth. The orbit camera is absolute — a
 * position and a point — so it means the same whenever the scene is opened.
 *
 * There is deliberately no such default in two dimensions: that camera's
 * zoom is a *ratio* of the renderer's own fit, which is only known once the
 * picture is on the canvas, so a number computed here would be measured
 * against the wrong picture. A scene with no camera is framed by the app
 * when its positions land (see GraphExplorer's loadScene).
 */
function fittedCamera(positions: Positions): SceneCamera {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const id of Object.keys(positions)) {
    const p = positions[id]
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    const z = p.z ?? 0
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) return { kind: '3d', position: { x: 0, y: 0, z: 1200 }, lookAt: { x: 0, y: 0, z: 0 } }
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2)
  // Three quarters on: far enough for the whole cloud, off-axis so depth reads as depth.
  return { kind: '3d', position: { x: centre.x + radius * 0.9, y: centre.y + radius * 0.75, z: centre.z + radius * 1.8 }, lookAt: centre }
}

const cameraFrom = (c: ViewInput['camera'], dims: 2 | 3): SceneCamera | undefined => {
  if (!c) return undefined
  const kind = c.kind ?? (dims === 3 ? '3d' : '2d')
  if (kind === '3d') return { kind: '3d', position: c.position ?? { x: 0, y: 0, z: 1200 }, lookAt: c.lookAt ?? { x: 0, y: 0, z: 0 } }
  const center = c.center ?? { x: 0, y: 0 }
  return { kind: '2d', x: center.x, y: center.y, ratio: c.ratio ?? 1, angle: c.angle ?? 0, center }
}

const viewFrom = (v: ViewInput | undefined, dims: 2 | 3, positions: Positions): SceneView => {
  // 2D keeps the app's own framing unless the caller asked for a camera; 3D gets one, its numbers being absolute.
  const camera = cameraFrom(v?.camera, dims) ?? (dims === 3 ? fittedCamera(positions) : undefined)
  const view: SceneView = {
    ...(camera ? { camera } : {}),
    ...(v?.labels ? { labels: v.labels } : {}),
    ...(v?.show_edges !== undefined ? { showEdges: v.show_edges } : {}),
    ...(v?.show_legend !== undefined ? { showLegend: v.show_legend } : {}),
    ...(v?.hops !== undefined ? { hops: v.hops } : {}),
    ...(v?.panel ? { panel: v.panel === 'none' ? null : v.panel } : {}),
    ...(v?.selected?.length ? { selectedIds: v.selected } : {}),
    ...(v?.slides ? { slides: { show: v.slides.show !== false, ...(v.slides.decks ? { decks: v.slides.decks } : {}), ...(v.slides.focus ? { focus: v.slides.focus } : {}), ...(v.slides.parts !== undefined ? { parts: v.slides.parts } : {}), ...(v.slides.story !== undefined ? { story: v.slides.story } : {}), ...(v.slides.spatial !== undefined ? { spatial: v.slides.spatial } : {}), ...(v.slides.final !== undefined ? { final: v.slides.final } : {}) } } : {}),
    // A saved simulation loads off, as it does in the app: physics would move the picture away from the saved one.
    physics: false,
  }
  return view
}

export function createSceneTools(engine: HeadlessEngine) {
  const store = engine.store

  const scene = betaTool({
    name: 'graph_scene',
    description:
      'Compose and save a Unigraph scene with no canvas: data + filter + layout + style, plus the view metadata (camera, labels, edges, legend, panel, selection). Each part is saved as its own entity — a `filter`, a `layout` holding the computed positions, a `rendering` (the style), an `analysis` when metrics are asked for — and the scene entity binds them, so opening it in the app (`/unigraph/2d?scene=<id>`, the Scenes page, or display {show}) gives exactly this picture. Reuse parts across scenes by passing filter_id / layout_id / style_id instead of a description. Actions: save (create, or update with id), list, get (the scene with its parts described), delete. This is the headless counterpart of the explorer\'s graph_save {kind:"scene"}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'get', 'delete'] },
        id: { type: 'string', description: 'get / delete, or save to update an existing scene' },
        name: { type: 'string', description: 'save: the scene name (required for a new one)' },
        tags: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        dimensions: { type: 'integer', enum: [2, 3], description: 'Which Unigraph the scene opens in: flat (2) or three dimensions (3). Default 2.' },
        filter: { type: 'object', description: 'What is in the view — the graph explorer\'s own filter vocabulary.', properties: FILTER_PROPS, additionalProperties: false },
        filter_id: { type: 'string', description: 'Use this saved filter instead of describing one' },
        layout: {
          type: 'object',
          description: 'How the nodes are placed. The positions are computed here and saved with the scene, so the app draws them without recomputing.',
          properties: {
            algorithm: { type: 'string', enum: LAYOUTS.map((l) => l.id) },
            spacing: { type: 'number', minimum: 0, maximum: 10 },
            iterations: { type: 'integer', minimum: 1, maximum: 2000 },
            seed: { type: 'integer' },
            center_id: { type: 'string' },
            tree_follow: { type: 'string', enum: ['out', 'in', 'any', 'auto'] },
            direction: { type: 'string', enum: ['TB', 'LR'], description: 'layered: which way the hierarchy runs' },
          },
          required: ['algorithm'],
          additionalProperties: false,
        },
        layout_id: { type: 'string', description: 'Use this saved layout (its positions) instead of computing one' },
        style: {
          type: 'object',
          description: 'How it looks: channels as in graph_style (node colour/size/opacity/shape, edge colour/width/opacity — constant, ranking or partition, for everything or per type/tag), plus the spec-level switches.',
          properties: {
            channels: { type: 'array', items: CHANNEL_SCHEMA },
            precedence: { type: 'string', enum: ['type', 'tag'], description: 'Which rule set wins when an element matches both' },
            edge_labels: { type: 'boolean' },
            curved_edges: { type: 'boolean' },
            base_style_id: { type: 'string', description: 'Start from this saved style rather than the default' },
          },
          additionalProperties: false,
        },
        style_id: { type: 'string', description: 'Use this saved style as it is' },
        metrics: { type: 'array', items: { type: 'string', enum: METRIC_IDS }, description: 'Compute these for the scene and save them as its analysis, so a style can rank or partition by metric.* and the app opens with the numbers already there' },
        metrics_auto: { type: 'boolean', description: 'Re-run those metrics whenever the view changes (default false)' },
        data_project: { type: 'string', description: 'A graph `project` entity (an exported view) as the scene\'s data stage; omit for the workspace / the open project' },
        export_data: { type: 'string', description: 'Export the filtered slice (with any computed metric values) as a new graph project of this name, and make it the scene\'s data stage' },
        view: VIEW_SCHEMA,
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async (input) => {
      const i = input as {
        action: 'save' | 'list' | 'get' | 'delete'
        id?: string
        name?: string
        tags?: string[]
        description?: string
        dimensions?: 2 | 3
        filter?: FilterInput
        filter_id?: string
        layout?: { algorithm: LayoutAlgorithm; spacing?: number; iterations?: number; seed?: number; center_id?: string; tree_follow?: 'out' | 'in' | 'any' | 'auto'; direction?: 'TB' | 'LR' }
        layout_id?: string
        style?: { channels?: StyleChannelInput[]; precedence?: 'type' | 'tag'; edge_labels?: boolean; curved_edges?: boolean; base_style_id?: string }
        style_id?: string
        metrics?: NodeMetricId[]
        metrics_auto?: boolean
        data_project?: string
        export_data?: string
        view?: ViewInput
      }
      const scenes = () => GRAPH_SCENE_TYPES.flatMap((t) => store.ofType(t))

      if (i.action === 'list') {
        return json({
          scenes: scenes().map((e) => {
            const d = e.data as SceneData
            return { id: e.id, label: displayLabel(e), renderer: d.renderer, nodes: d.stats?.nodes, edges: d.stats?.edges, algorithm: d.algorithm, parts: { filter: d.filterId, layout: d.layoutId, style: d.renderingId, analysis: d.analysisId, data: d.projectId }, updatedAt: e.meta.updatedAt }
          }),
        })
      }
      if (i.action === 'get' || i.action === 'delete') {
        const e = i.id ? store.get(i.id) : undefined
        if (!e || !(GRAPH_SCENE_TYPES as readonly string[]).includes(e.type)) throw new Error(`No scene with id ${i.id}. graph_scene {action:"list"} lists them.`)
        const d = e.data as SceneData
        if (i.action === 'delete') {
          if (!(await engine.host().confirm(`Delete the scene ${quoteLabel(displayLabel(e))}?`, { yes: 'Delete', danger: true }))) return json({ deleted: false })
          store.remove([e.id])
          return json({ deleted: true, id: e.id })
        }
        const filter = d.filterId ? store.get(d.filterId) : undefined
        const layout = d.layoutId ? store.get(d.layoutId) : undefined
        const style = d.renderingId ? store.get(d.renderingId) : undefined
        return json({
          ...summarize(e),
          renderer: d.renderer,
          algorithm: d.algorithm,
          stats: d.stats,
          data: d.projectId,
          analysis: d.analysisId,
          view: d.view,
          filter: filter ? { id: filter.id, label: displayLabel(filter), describes: describeFilter(filter.data as FilterSpec) } : undefined,
          layout: layout ? { id: layout.id, label: displayLabel(layout), positions: Object.keys((layout.data as LayoutData).positions ?? {}).length, algorithm: (layout.data as LayoutData).algorithm, dimensions: (layout.data as LayoutData).dimensions } : undefined,
          style: style ? { id: style.id, label: displayLabel(style), describes: describeRendering(toRenderingSpec(style.data as RenderingData)) } : undefined,
        })
      }

      // ── save ──────────────────────────────────────────────────────────
      const existing = i.id ? store.get(i.id) : undefined
      if (i.id && !existing) throw new Error(`No scene with id ${i.id}.`)
      const label = i.name?.trim() || (existing ? displayLabel(existing) : '')
      if (!label) throw new Error('Give the scene a name.')
      const dims = (i.dimensions ?? ((existing?.data as SceneData | undefined)?.renderer === '3d' ? 3 : 2)) as 2 | 3

      // The filter: a saved one, or one described here and saved as the scene's own.
      let filterSpec: FilterSpec
      let filterId: EntityId | undefined
      if (i.filter_id) {
        const e = store.get(i.filter_id)
        if (!e || e.type !== GRAPH_TYPES.filter) throw new Error(`${i.filter_id} is not a saved filter.`)
        filterSpec = e.data as FilterSpec
        filterId = e.id
      } else {
        filterSpec = specFrom(i.filter ?? {})
        const part = createEntity({ type: GRAPH_TYPES.filter, label: `${label} · filter`, data: { ...filterSpec } as FilterData, meta: { source: 'headless' } })
        store.upsert(part)
        filterId = part.id
      }
      const slice = applyFilter(store, engine.registry(), filterSpec)
      if (!slice.nodes.length) throw new Error(`That filter selects nothing (${describeFilter(filterSpec)}). graph_slice shows what the workspace holds.`)

      // Metrics, when asked for: the analysis the scene carries, and what a style may rank or partition by.
      let metrics: MetricsResult | undefined
      let analysisId: EntityId | undefined
      const wanted = i.metrics?.length ? i.metrics : undefined
      if (wanted) {
        metrics = computeMetrics(serializeSlice(slice, filterSpec.weightField), { metrics: wanted, weightField: filterSpec.weightField, directed: true })
        analysisId = createAnalysisEntity(store, `${label} · analysis`, metrics, { filterId, filter: filterSpec, source: 'headless' }).id
      }

      // The layout: saved positions, or computed here and saved as the scene's own.
      let positions: Positions
      let layoutId: EntityId | undefined
      let algorithm: LayoutAlgorithm | undefined
      if (i.layout_id) {
        const e = store.get(i.layout_id)
        if (!e || e.type !== GRAPH_TYPES.layout) throw new Error(`${i.layout_id} is not a saved layout.`)
        positions = (e.data as LayoutData).positions ?? {}
        algorithm = (e.data as LayoutData).algorithm as LayoutAlgorithm | undefined
        layoutId = e.id
      } else {
        const l = i.layout ?? { algorithm: 'unigraph-force' as LayoutAlgorithm }
        const info = LAYOUTS.find((x) => x.id === l.algorithm)
        if (!info) throw new Error(`Unknown layout ${l.algorithm}. Layouts: ${LAYOUTS.map((x) => x.id).join(', ')}.`)
        if (!info.dims.includes(dims)) throw new Error(`The ${l.algorithm} layout is ${info.dims.join('/')}D only; this scene is ${dims}D.`)
        const refused = layoutTooBig(l.algorithm, slice.nodes.length)
        if (refused) throw new Error(refused)
        algorithm = l.algorithm
        positions = computeLayout(l.algorithm, slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: dims, spacing: l.spacing ?? DEFAULT_LAYOUT_PARAMS.spacing, iterations: l.iterations ?? DEFAULT_LAYOUT_PARAMS.iterations, seed: l.seed ?? DEFAULT_LAYOUT_PARAMS.seed, direction: l.direction ?? DEFAULT_LAYOUT_PARAMS.direction, centerId: l.center_id, treeFollow: l.tree_follow })
        const part = createEntity({ type: GRAPH_TYPES.layout, label: `${label} · layout`, data: { positions, algorithm, dimensions: dims } as LayoutData, meta: { source: 'headless' } })
        store.upsert(part)
        layoutId = part.id
      }

      // The style: a saved one as it is, or channels applied to the default (or to a named base).
      let renderingId: EntityId | undefined
      let spec: RenderingSpec = DEFAULT_RENDERING
      if (i.style_id) {
        const e = store.get(i.style_id)
        if (!e || e.type !== GRAPH_TYPES.rendering) throw new Error(`${i.style_id} is not a saved style.`)
        spec = toRenderingSpec(e.data as RenderingData)
        renderingId = e.id
      } else {
        if (i.style?.base_style_id) {
          const base = store.get(i.style.base_style_id)
          if (!base || base.type !== GRAPH_TYPES.rendering) throw new Error(`${i.style.base_style_id} is not a saved style.`)
          spec = toRenderingSpec(base.data as RenderingData)
        }
        // A style may rank or partition by a metric *this scene computes* — those values ride along in its analysis,
        // and a scene that computes none has no metric.* to colour by, whatever the workspace holds elsewhere.
        spec = applyStyleChannels(spec, i.style?.channels ?? [], { metrics: wanted ?? [], computeHint: (m) => `add it to this scene's metrics: ["${m}"].` }).spec
        if (i.style?.precedence) spec = { ...spec, precedence: i.style.precedence }
        if (i.style?.edge_labels !== undefined) spec = { ...spec, edgeLabels: i.style.edge_labels }
        if (i.style?.curved_edges !== undefined) spec = { ...spec, curvedEdges: i.style.curved_edges }
        const part = createEntity({ type: GRAPH_TYPES.rendering, label: `${label} · style`, data: { ...spec } as RenderingData, meta: { source: 'headless' } })
        store.upsert(part)
        renderingId = part.id
      }

      // The data stage: an existing exported view, or one exported from this slice (metric values included).
      let projectId: EntityId | undefined = i.data_project
      if (i.data_project && !store.get(i.data_project)) throw new Error(`No entity with id ${i.data_project}.`)
      if (i.export_data) {
        const project = buildProject(i.export_data, slice, metrics, { filterId, layoutId, renderingId, analysisId }, 'headless')
        store.upsert(project)
        projectId = project.id
      }

      const data: SceneData = {
        renderer: dims === 3 ? '3d' : '2d',
        mode: dims === 3 ? '3d' : '2d',
        filterId,
        layoutId,
        renderingId,
        analysisId,
        algorithm,
        projectId,
        ...(wanted ? { analysis: { auto: !!i.metrics_auto, options: { metrics: wanted } } } : {}),
        view: viewFrom(i.view, dims, positions),
        stats: { nodes: slice.nodes.length, edges: slice.edges.length },
        // No canvas to capture here: the card's picture is drawn from the slice and its positions.
        preview: graphScenePreview(slice.nodes, slice.edges, positions),
      }
      const type = graphSceneTypeFor()
      let e: AnyEntity
      if (existing) e = store.update(existing.id, { label, type, description: i.description ?? existing.description, data, ...(i.tags ? { tags: parseTags(i.tags) } : {}) })
      else {
        e = createEntity({ type, label, description: i.description, data, tags: i.tags, meta: { source: 'headless' } })
        store.upsert(e)
      }
      return json({
        ...summarize(e),
        updated: !!existing,
        renderer: data.renderer,
        open: `/unigraph/${dims === 3 ? '3d' : '2d'}?scene=${e.id}`,
        stats: data.stats,
        filter: describeFilter(filterSpec),
        layout: { id: layoutId, algorithm, positions: Object.keys(positions).length, dimensions: dims },
        style: { id: renderingId, describes: describeRendering(spec) },
        analysis: analysisId ? { id: analysisId, metrics: wanted } : undefined,
        data: projectId,
        view: data.view,
      })
    },
  })

  return [scene]
}

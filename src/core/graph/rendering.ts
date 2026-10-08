import type { TypeRegistry } from '../entity/typeRegistry'
import type { AnyEntity, EntityData, Relationship } from '../entity/types'
import { hashColor } from '../../lib/format'
import { dataAt, getPath } from './fields'
import { describeValueRef, isCategoricalRef, isPlainRef, isValidValueRef, refUsesMetrics, valueOf, type ValueContext, type ValueRef } from './values'
import { METRICS, type MetricsResult, type NodeMetricId } from './metrics/types'
import { categoricalColor, isPaletteId, MISSING_COLOR, PALETTES, paletteColor, type PaletteId } from './palettes'
import { categories, domainOf, normalizer, type Categories, type Domain } from './scales'
import { isCssColor } from '../../lib/cssColor'

/**
 * Display rules for graph views — the third orthogonal axis next to filters
 * and layouts. Modelled on Gephi's Appearance panel: every visual channel
 * (node colour, size, opacity, shape; edge colour, width, opacity) is driven
 * by a *constant*, a *ranking* (a numeric attribute mapped onto a range or a
 * palette) or a *partition* (a categorical attribute mapped onto palette
 * colours or shapes). Channels are set for all nodes/edges and can be
 * overridden per type or per tag. A spec is plain data (saved as a
 * `rendering` entity) and is resolved per node/edge into a concrete style
 * that both the 2D and 3D renderers consume.
 */

export type NodeShape = 'circle' | 'square' | 'diamond' | 'triangle'

export interface NodeStyle {
  color: string
  /** Final size in px (2D) / relative units (3D). */
  size: number
  shape: NodeShape
  opacity: number
  visible: boolean
  /** Whether this node may show a label at all (the view's label mode still applies). */
  label: boolean
}

export interface EdgeStyle {
  color: string
  width: number
  opacity: number
  visible: boolean
  /** Draw a direction arrow when the relationship is directed. */
  arrow: boolean
}

// ── Attributes: what a mapping reads ───────────────────────────────────

/** Something measurable on a node. `value` takes any ValueRef (degree.in:cites, meta.updatedAt, metric.pagerank, …). */
export type NodeAttr =
  | { kind: 'degree'; dir?: 'both' | 'in' | 'out' }
  | { kind: 'field'; key: string }
  | { kind: 'metric'; key: NodeMetricId }
  | { kind: 'type' }
  | { kind: 'tag'; prefix?: string }
  | { kind: 'value'; ref: ValueRef }

/** Something measurable on an edge. */
export type EdgeAttr = { kind: 'field'; key: string } | { kind: 'type' } | { kind: 'tag'; prefix?: string } | { kind: 'directed' }

export type Attr = NodeAttr | EdgeAttr

export const isCategoricalAttr = (a: Attr): boolean => a.kind === 'type' || a.kind === 'tag' || a.kind === 'directed' || (a.kind === 'metric' && !!METRICS.find((m) => m.id === a.key)?.categorical) || (a.kind === 'value' && isCategoricalRef(a.ref))

/** Does a channel read this iteration's analysis? */
export const attrUsesMetrics = (a: Attr | undefined): boolean => !!a && (a.kind === 'metric' || (a.kind === 'value' && refUsesMetrics(a.ref)))

export function attrLabel(a: Attr): string {
  switch (a.kind) {
    case 'degree':
      return a.dir === 'in' ? 'in-degree' : a.dir === 'out' ? 'out-degree' : 'degree'
    case 'field':
      return a.key
    case 'metric':
      return METRICS.find((m) => m.id === a.key)?.label.toLowerCase() ?? a.key
    case 'type':
      return 'type'
    case 'tag':
      return a.prefix ? `tag ${a.prefix}…` : 'first tag'
    case 'directed':
      return 'directed'
    case 'value':
      return describeValueRef(a.ref)
  }
}

export const attrKey = (a: Attr): string => (a.kind === 'field' || a.kind === 'metric' ? `${a.kind}:${a.key}` : a.kind === 'degree' ? `degree:${a.dir ?? 'both'}` : a.kind === 'tag' ? `tag:${a.prefix ?? ''}` : a.kind === 'value' ? `value:${a.ref}` : a.kind)

// ── Channels: how a visual property is driven ──────────────────────────

export interface Ranking {
  mode: 'ranking'
  attr: Attr
  domain?: Domain
  log?: boolean
}

export type ColorChannel = { mode: 'constant'; value?: string } | (Ranking & { palette: PaletteId }) | { mode: 'partition'; attr: Attr; palette: PaletteId; maxCategories?: number; colors?: Record<string, string> }

export type NumberChannel = { mode: 'constant'; value: number } | (Ranking & { min: number; max: number })

export type ShapeChannel = { mode: 'constant'; value: NodeShape } | { mode: 'partition'; attr: Attr; shapes?: Record<string, NodeShape> }

export type Channel = ColorChannel | NumberChannel | ShapeChannel

/** Per-scope appearance: any channel left unset is inherited from the scope below (type/tag → all). */
export interface NodeAppearance {
  color?: ColorChannel
  size?: NumberChannel
  /** Multiplier applied after the size channel — “make these 1.3× bigger” without redefining the mapping. */
  sizeScale?: number
  opacity?: NumberChannel
  shape?: ShapeChannel
  visible?: boolean
  label?: boolean
}

export interface EdgeAppearance {
  color?: ColorChannel
  width?: NumberChannel
  widthScale?: number
  opacity?: NumberChannel
  visible?: boolean
  arrow?: boolean
}

export type NodeRule = NodeAppearance
export type EdgeRule = EdgeAppearance

export interface NodeDefaults extends NodeAppearance {
  color: ColorChannel
  size: NumberChannel
  opacity: NumberChannel
  shape: ShapeChannel
  visible: boolean
  label: boolean
}
export interface EdgeDefaults extends EdgeAppearance {
  color: ColorChannel
  width: NumberChannel
  opacity: NumberChannel
  visible: boolean
  arrow: boolean
}

export interface RenderingSpec {
  /** Which rule set wins when an element matches both a type rule and a tag rule. */
  precedence: 'type' | 'tag'
  nodes: { default: NodeDefaults; types: Record<string, NodeAppearance>; tags: Record<string, NodeAppearance> }
  edges: { default: EdgeDefaults; types: Record<string, EdgeAppearance>; tags: Record<string, EdgeAppearance> }
  /** Draw relationship type/label along edges (2D). */
  edgeLabels: boolean
  /** Curve parallel edges so multi-edges stay distinguishable. */
  curvedEdges: boolean
  /** Styles a script computed, applied last, by id. */
  overlay?: StyleOverlay
}

/** A node's style as a script sets it: any of the resolved fields, the rest left as the rules give them. */
export type NodeStyleOverride = Partial<NodeStyle>
export type EdgeStyleOverride = Partial<EdgeStyle>

/**
 * What a style script returns, kept on the rendering so the picture is
 * reproducible without the script running: styles per node and edge id
 * (applied after the defaults and the type/tag rules), a legend for what
 * the colours mean, and where it came from. Saved with the rendering
 * entity; `graph_style {script}` or the Scripts page runs it again.
 */
export interface StyleOverlay {
  nodes?: Record<string, NodeStyleOverride>
  edges?: Record<string, EdgeStyleOverride>
  legend?: { title: string; items: { label: string; color: string; shape?: NodeShape }[] } | { title: string; palette: PaletteId; domain: [number, number]; log?: boolean }
  source?: { scriptId: string; label?: string; ranAt: string }
}

/** What a `rendering` entity may hold: the current spec, or any older shape (`colorBy`, `sizing`, plain rule values); `toRenderingSpec` migrates. */
export interface RenderingData extends EntityData {
  precedence?: RenderingSpec['precedence']
  nodes?: Record<string, unknown>
  edges?: Record<string, unknown>
  sizing?: Record<string, unknown>
  edgeLabels?: boolean
  curvedEdges?: boolean
  mode?: 'type' | 'tag'
}

export const NODE_SHAPES: { id: NodeShape; label: string; three: string }[] = [
  { id: 'circle', label: 'Circle / sphere', three: 'sphere' },
  { id: 'square', label: 'Square / cube', three: 'box' },
  { id: 'diamond', label: 'Diamond / octahedron', three: 'octahedron' },
  { id: 'triangle', label: 'Triangle / cone', three: 'cone' },
]

export const DEFAULT_RENDERING: RenderingSpec = {
  precedence: 'type',
  nodes: {
    default: { color: { mode: 'constant' }, size: { mode: 'ranking', attr: { kind: 'degree' }, min: 3, max: 14, log: true }, opacity: { mode: 'constant', value: 1 }, shape: { mode: 'constant', value: 'circle' }, visible: true, label: true },
    types: {},
    tags: {},
  },
  edges: {
    default: { color: { mode: 'constant' }, width: { mode: 'constant', value: 1 }, opacity: { mode: 'constant', value: 0.6 }, visible: true, arrow: true },
    types: {},
    tags: {},
  },
  edgeLabels: false,
  curvedEdges: true,
}

// ── Normalisation / migration ──────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isShape = (v: unknown): v is NodeShape => v === 'circle' || v === 'square' || v === 'diamond' || v === 'triangle'
const paletteOr = (v: unknown, fallback: PaletteId): PaletteId => (isPaletteId(v) ? v : fallback)

function normAttr(v: unknown, scope: 'nodes' | 'edges'): Attr | undefined {
  if (!isObj(v) || typeof v.kind !== 'string') return undefined
  switch (v.kind) {
    case 'degree':
      return scope === 'nodes' ? { kind: 'degree', ...(v.dir === 'in' || v.dir === 'out' ? { dir: v.dir } : {}) } : undefined
    case 'field':
      return typeof v.key === 'string' && v.key ? { kind: 'field', key: v.key } : undefined
    case 'metric':
      return scope === 'nodes' && typeof v.key === 'string' ? { kind: 'metric', key: v.key as NodeMetricId } : undefined
    case 'type':
      return { kind: 'type' }
    case 'tag':
      return { kind: 'tag', ...(typeof v.prefix === 'string' && v.prefix ? { prefix: v.prefix } : {}) }
    case 'directed':
      return scope === 'edges' ? { kind: 'directed' } : undefined
    case 'value':
      return typeof v.ref === 'string' && v.ref && (scope === 'edges' ? isPlainRef(v.ref) : isValidValueRef(v.ref)) ? { kind: 'value', ref: v.ref } : undefined
    default:
      return undefined
  }
}

/** A partition's own colours, the ones that are colours (`lib/cssColor`). */
function cssColors(v: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, c] of Object.entries(v)) if (isCssColor(c)) out[k] = c.trim()
  return out
}

/**
 * A colour channel as stored, from a tool or a script: every colour in it checked (`lib/cssColor`). They come from
 * scenes, saved styles, a bundle's screen state, `graph_style` and scripts, and reach `style` in the legend, the
 * filter's dots and the panels — `url(https://…)` would be fetched on sight. A constant that is not a colour is
 * "each type its own colour"; a string that is not one is no channel.
 */
function normColor(v: unknown, scope: 'nodes' | 'edges'): ColorChannel | undefined {
  if (typeof v === 'string') return isCssColor(v) ? { mode: 'constant', value: v.trim() } : undefined
  if (!isObj(v)) return undefined
  if (v.mode === 'constant') return { mode: 'constant', ...(isCssColor(v.value) ? { value: v.value.trim() } : {}) }
  const attr = normAttr(v.attr, scope)
  if (!attr) return undefined
  if (v.mode === 'ranking') return { mode: 'ranking', attr, palette: paletteOr(v.palette, 'viridis'), ...(Array.isArray(v.domain) || v.domain === 'auto' ? { domain: v.domain as Domain } : {}), ...(v.log ? { log: true } : {}) }
  if (v.mode === 'partition') return { mode: 'partition', attr, palette: paletteOr(v.palette, 'tableau10'), ...(typeof v.maxCategories === 'number' ? { maxCategories: v.maxCategories } : {}), ...(isObj(v.colors) ? { colors: cssColors(v.colors) } : {}) }
  return undefined
}

function normNumber(v: unknown, scope: 'nodes' | 'edges', fallbackRange: [number, number]): NumberChannel | undefined {
  if (typeof v === 'number') return { mode: 'constant', value: v }
  if (!isObj(v)) return undefined
  if (v.mode === 'constant' && typeof v.value === 'number') return { mode: 'constant', value: v.value }
  if (v.mode === 'ranking') {
    const attr = normAttr(v.attr, scope)
    if (!attr) return undefined
    return { mode: 'ranking', attr, min: typeof v.min === 'number' ? v.min : fallbackRange[0], max: typeof v.max === 'number' ? v.max : fallbackRange[1], ...(Array.isArray(v.domain) || v.domain === 'auto' ? { domain: v.domain as Domain } : {}), ...(v.log ? { log: true } : {}) }
  }
  return undefined
}

function normShape(v: unknown): ShapeChannel | undefined {
  if (isShape(v)) return { mode: 'constant', value: v }
  if (!isObj(v)) return undefined
  if (v.mode === 'constant' && isShape(v.value)) return { mode: 'constant', value: v.value }
  if (v.mode === 'partition') {
    const attr = normAttr(v.attr, 'nodes')
    if (!attr) return undefined
    return { mode: 'partition', attr, ...(isObj(v.shapes) ? { shapes: v.shapes as Record<string, NodeShape> } : {}) }
  }
  return undefined
}

/** A node rule from the current or the legacy shape (`{ color, size: multiplier, shape, opacity, visible, label, isVisible }`). */
export function normNodeRule(r: unknown): NodeAppearance {
  if (!isObj(r)) return {}
  const out: NodeAppearance = {}
  const color = normColor(r.color, 'nodes')
  if (color) out.color = color
  // Legacy `size` was a multiplier; the current shape is a channel with an explicit `sizeScale`.
  if (typeof r.size === 'number') out.sizeScale = r.size
  else {
    const size = normNumber(r.size, 'nodes', [3, 14])
    if (size) out.size = size
  }
  if (typeof r.sizeScale === 'number') out.sizeScale = r.sizeScale
  const opacity = normNumber(r.opacity, 'nodes', [0.2, 1])
  if (opacity) out.opacity = opacity
  const shape = normShape(r.shape)
  if (shape) out.shape = shape
  const visible = r.visible ?? r.isVisible
  if (typeof visible === 'boolean') out.visible = visible
  if (typeof r.label === 'boolean') out.label = r.label
  return out
}

export function normEdgeRule(r: unknown): EdgeAppearance {
  if (!isObj(r)) return {}
  const out: EdgeAppearance = {}
  const color = normColor(r.color, 'edges')
  if (color) out.color = color
  if (typeof r.width === 'number') out.width = { mode: 'constant', value: r.width }
  else {
    const width = normNumber(r.width, 'edges', [0.5, 4])
    if (width) out.width = width
  }
  if (typeof r.widthScale === 'number') out.widthScale = r.widthScale
  const opacity = normNumber(r.opacity, 'edges', [0.1, 1])
  if (opacity) out.opacity = opacity
  const visible = r.visible ?? r.isVisible
  if (typeof visible === 'boolean') out.visible = visible
  if (typeof r.arrow === 'boolean') out.arrow = r.arrow
  return out
}

/** Legacy `colorBy` → colour channel. */
function legacyColorBy(cb: Record<string, unknown> | undefined, scope: 'nodes' | 'edges'): ColorChannel | undefined {
  if (!cb || typeof cb.source !== 'string' || cb.source === 'rules') return undefined
  const key = typeof cb.key === 'string' ? cb.key : undefined
  let attr: Attr | undefined
  if (cb.source === 'type') attr = { kind: 'type' }
  else if (cb.source === 'tag') attr = { kind: 'tag', ...(key ? { prefix: key } : {}) }
  else if (cb.source === 'field' && key) attr = { kind: 'field', key }
  else if (cb.source === 'metric' && key && scope === 'nodes') attr = { kind: 'metric', key: key as NodeMetricId }
  else if (cb.source === 'community' && scope === 'nodes') attr = { kind: 'metric', key: 'community' }
  if (!attr) return undefined
  const categorical = cb.scale === 'categorical' || isCategoricalAttr(attr)
  if (categorical) return { mode: 'partition', attr, palette: paletteOr(cb.palette, 'tableau10'), ...(typeof cb.maxCategories === 'number' ? { maxCategories: cb.maxCategories } : {}) }
  return { mode: 'ranking', attr, palette: paletteOr(cb.palette, 'viridis'), ...(Array.isArray(cb.domain) ? { domain: cb.domain as Domain } : {}), ...(cb.log ? { log: true } : {}) }
}

/** Accepts anything stored in a `rendering` entity — the current spec or any older shape — and fills gaps. */
export function toRenderingSpec(data: Partial<RenderingData> | Partial<RenderingSpec> | undefined): RenderingSpec {
  const d = (data ?? {}) as Record<string, unknown>
  const nodesIn = isObj(d.nodes) ? d.nodes : {}
  const edgesIn = isObj(d.edges) ? d.edges : {}
  const nd = isObj(nodesIn.default) ? nodesIn.default : {}
  const ed = isObj(edgesIn.default) ? edgesIn.default : {}
  const rules = <T>(v: unknown, norm: (r: unknown) => T): Record<string, T> => {
    const out: Record<string, T> = {}
    if (isObj(v)) for (const [k, r] of Object.entries(v)) out[k] = norm(r)
    return out
  }

  // Node defaults: current channels, else legacy colorBy / sizing / plain values.
  const ndRule = normNodeRule(nd)
  const sizing = isObj(d.sizing) ? d.sizing : undefined
  let size: NumberChannel | undefined = ndRule.size
  if (!size && sizing) {
    const min = typeof sizing.min === 'number' ? sizing.min : 3
    const max = typeof sizing.max === 'number' ? sizing.max : 14
    const log = !!sizing.log
    if (sizing.by === 'uniform') size = { mode: 'constant', value: min + (max - min) * 0.35 }
    else if (sizing.by === 'field' && typeof sizing.field === 'string') size = { mode: 'ranking', attr: { kind: 'field', key: sizing.field }, min, max, log }
    else if (sizing.by === 'metric' && typeof sizing.metric === 'string') size = { mode: 'ranking', attr: { kind: 'metric', key: sizing.metric as NodeMetricId }, min, max, log }
    else size = { mode: 'ranking', attr: { kind: 'degree' }, min, max, log: true }
  }
  const nodeColor = legacyColorBy(isObj(nodesIn.colorBy) ? nodesIn.colorBy : undefined, 'nodes') ?? ndRule.color ?? DEFAULT_RENDERING.nodes.default.color
  const nodeDefault: NodeDefaults = {
    color: nodeColor,
    size: size ?? DEFAULT_RENDERING.nodes.default.size,
    ...(ndRule.sizeScale && ndRule.sizeScale !== 1 ? { sizeScale: ndRule.sizeScale } : {}),
    opacity: ndRule.opacity ?? DEFAULT_RENDERING.nodes.default.opacity,
    shape: ndRule.shape ?? DEFAULT_RENDERING.nodes.default.shape,
    visible: ndRule.visible ?? true,
    label: ndRule.label ?? true,
  }

  // Edge defaults: current channels, else legacy colorBy / widthBy.
  const edRule = normEdgeRule(ed)
  const widthBy = isObj(edgesIn.widthBy) ? edgesIn.widthBy : undefined
  let width: NumberChannel | undefined = edRule.width
  if (widthBy && widthBy.source === 'field' && typeof widthBy.key === 'string') {
    width = { mode: 'ranking', attr: { kind: 'field', key: widthBy.key }, min: typeof widthBy.min === 'number' ? widthBy.min : 0.5, max: typeof widthBy.max === 'number' ? widthBy.max : 4, ...(widthBy.log ? { log: true } : {}) }
  }
  const edgeDefault: EdgeDefaults = {
    color: legacyColorBy(isObj(edgesIn.colorBy) ? edgesIn.colorBy : undefined, 'edges') ?? edRule.color ?? DEFAULT_RENDERING.edges.default.color,
    width: width ?? DEFAULT_RENDERING.edges.default.width,
    ...(edRule.widthScale && edRule.widthScale !== 1 ? { widthScale: edRule.widthScale } : {}),
    opacity: edRule.opacity ?? DEFAULT_RENDERING.edges.default.opacity,
    visible: edRule.visible ?? true,
    arrow: edRule.arrow ?? true,
  }

  return {
    precedence: d.precedence === 'tag' || d.mode === 'tag' ? 'tag' : 'type',
    nodes: { default: nodeDefault, types: rules(nodesIn.types, normNodeRule), tags: rules(nodesIn.tags, normNodeRule) },
    edges: { default: edgeDefault, types: rules(edgesIn.types, normEdgeRule), tags: rules(edgesIn.tags, normEdgeRule) },
    edgeLabels: typeof d.edgeLabels === 'boolean' ? d.edgeLabels : DEFAULT_RENDERING.edgeLabels,
    curvedEdges: typeof d.curvedEdges === 'boolean' ? d.curvedEdges : DEFAULT_RENDERING.curvedEdges,
    ...(isObj(d.overlay) ? { overlay: normOverlay(d.overlay) } : {}),
  }
}

/** A colour string a renderer can draw (a hex, rgb()/hsl(), or a name) — and nothing that could break out of a style. */
const isColor = isCssColor
const clamped = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined)

/** One node's override as a script gave it: only the fields that make sense, each checked. */
export function normNodeOverride(v: unknown): NodeStyleOverride | undefined {
  if (!isObj(v)) return undefined
  const o: NodeStyleOverride = {}
  if (isColor(v.color)) o.color = v.color.trim()
  const size = clamped(v.size, 0.5, 200)
  if (size !== undefined) o.size = size
  if (isShape(v.shape)) o.shape = v.shape
  const opacity = clamped(v.opacity, 0, 1)
  if (opacity !== undefined) o.opacity = opacity
  if (typeof v.visible === 'boolean') o.visible = v.visible
  if (typeof v.label === 'boolean') o.label = v.label
  return Object.keys(o).length ? o : undefined
}
export function normEdgeOverride(v: unknown): EdgeStyleOverride | undefined {
  if (!isObj(v)) return undefined
  const o: EdgeStyleOverride = {}
  if (isColor(v.color)) o.color = v.color.trim()
  const width = clamped(v.width, 0.1, 40)
  if (width !== undefined) o.width = width
  const opacity = clamped(v.opacity, 0, 1)
  if (opacity !== undefined) o.opacity = opacity
  if (typeof v.visible === 'boolean') o.visible = v.visible
  if (typeof v.arrow === 'boolean') o.arrow = v.arrow
  return Object.keys(o).length ? o : undefined
}

/** A stored or returned overlay, checked field by field; undefined when nothing in it holds. */
export function normOverlay(v: unknown): StyleOverlay | undefined {
  if (!isObj(v)) return undefined
  const out: StyleOverlay = {}
  if (isObj(v.nodes)) {
    const nodes: Record<string, NodeStyleOverride> = {}
    for (const [id, st] of Object.entries(v.nodes)) {
      const o = normNodeOverride(st)
      if (o) nodes[id] = o
    }
    if (Object.keys(nodes).length) out.nodes = nodes
  }
  if (isObj(v.edges)) {
    const edges: Record<string, EdgeStyleOverride> = {}
    for (const [id, st] of Object.entries(v.edges)) {
      const o = normEdgeOverride(st)
      if (o) edges[id] = o
    }
    if (Object.keys(edges).length) out.edges = edges
  }
  if (isObj(v.legend) && typeof v.legend.title === 'string') {
    const l = v.legend
    const title = v.legend.title
    if (Array.isArray(l.items)) {
      const items = l.items.filter((it): it is Record<string, unknown> => isObj(it) && typeof it.label === 'string' && isColor(it.color)).map((it) => ({ label: it.label as string, color: (it.color as string).trim(), ...(isShape(it.shape) ? { shape: it.shape } : {}) }))
      if (items.length) out.legend = { title, items: items.slice(0, 40) }
    } else if (isPaletteId(l.palette) && Array.isArray(l.domain) && l.domain.length === 2 && l.domain.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      out.legend = { title, palette: l.palette, domain: [l.domain[0] as number, l.domain[1] as number], ...(l.log ? { log: true } : {}) }
    }
  }
  if (isObj(v.source) && typeof v.source.scriptId === 'string') out.source = { scriptId: v.source.scriptId, ...(typeof v.source.label === 'string' ? { label: v.source.label } : {}), ranAt: typeof v.source.ranAt === 'string' ? v.source.ranAt : new Date().toISOString() }
  return Object.keys(out).length ? out : undefined
}

export const isDefaultRendering = (s: RenderingSpec) => describeRendering(s) === 'Default style'

const describeChannel = (c: Channel | undefined): string | undefined => (!c || c.mode === 'constant' ? undefined : `${c.mode === 'ranking' ? 'by' : 'by'} ${attrLabel(c.attr)}`)

export function describeRendering(s: RenderingSpec): string {
  const parts: string[] = []
  const nd = s.nodes.default
  const ed = s.edges.default
  const c = describeChannel(nd.color)
  if (c) parts.push(`colour ${c}`)
  const sz = describeChannel(nd.size)
  if (sz && !(nd.size.mode === 'ranking' && nd.size.attr.kind === 'degree' && !nd.size.attr.dir)) parts.push(`size ${sz}`)
  if (nd.size.mode === 'constant') parts.push('uniform size')
  const op = describeChannel(nd.opacity)
  if (op) parts.push(`opacity ${op}`)
  const sh = describeChannel(nd.shape)
  if (sh) parts.push(`shape ${sh}`)
  const nt = Object.keys(s.nodes.types).length
  const ng = Object.keys(s.nodes.tags).length
  const et = Object.keys(s.edges.types).length
  const eg = Object.keys(s.edges.tags).length
  if (nt) parts.push(`${nt} node type rule${nt > 1 ? 's' : ''}`)
  if (ng) parts.push(`${ng} node tag rule${ng > 1 ? 's' : ''}`)
  const ec = describeChannel(ed.color)
  if (ec) parts.push(`edge colour ${ec}`)
  const ew = describeChannel(ed.width)
  if (ew) parts.push(`edge width ${ew}`)
  const eo = describeChannel(ed.opacity)
  if (eo) parts.push(`edge opacity ${eo}`)
  if (et) parts.push(`${et} edge type rule${et > 1 ? 's' : ''}`)
  if (eg) parts.push(`${eg} edge tag rule${eg > 1 ? 's' : ''}`)
  if (s.edgeLabels) parts.push('edge labels')
  const on = Object.keys(s.overlay?.nodes ?? {}).length
  const oe = Object.keys(s.overlay?.edges ?? {}).length
  if (on || oe) parts.push(`scripted: ${[on ? `${on} node${on > 1 ? 's' : ''}` : '', oe ? `${oe} edge${oe > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}${s.overlay?.source?.label ? ` (${s.overlay.source.label})` : ''}`)
  return parts.length ? parts.join(' · ') : 'Default style'
}

// ── Resolution ─────────────────────────────────────────────────────────

export interface StyleExtras {
  edges?: Relationship[]
  metrics?: MetricsResult
  metricIndex?: Map<string, number>
  /** Value context for `value` attributes and typed degrees. */
  values?: ValueContext
  /** A tag's own colour (the store's tag info), so colouring by tag matches the tag chips everywhere else. */
  tagColor?: (tag: string) => string | undefined
}

export type NumericScale = { kind: 'numeric'; norm: (v: number) => number; domain: [number, number]; log: boolean }
export type CategoricalScale = { kind: 'categorical'; cats: Categories }
export type Scale = NumericScale | CategoricalScale

export interface StyleContext {
  registry: TypeRegistry
  degree: Map<string, number>
  inDegree?: Map<string, number>
  outDegree?: Map<string, number>
  metrics?: MetricsResult
  metricIndex?: Map<string, number>
  values?: ValueContext
  tagColor?: (tag: string) => string | undefined
  /** One scale per (scope, channel) that carries a mapping, over the elements that scope covers. */
  scales: Map<string, Scale>
}

type ScopeKey = 'default' | `type:${string}` | `tag:${string}`
const scaleKey = (scope: ScopeKey, channel: string) => `${scope}|${channel}`

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)

/** Read the raw value an attribute refers to on a node. */
export function nodeAttrValue(node: AnyEntity, attr: Attr, ctx: Pick<StyleContext, 'metrics' | 'metricIndex' | 'degree' | 'inDegree' | 'outDegree' | 'values'>): number | string | undefined {
  switch (attr.kind) {
    case 'value':
      return ctx.values ? valueOf(node, attr.ref, ctx.values) : isPlainRef(attr.ref) ? plainValue(node, attr.ref) : undefined
    case 'degree':
      return (attr.dir === 'in' ? ctx.inDegree : attr.dir === 'out' ? ctx.outDegree : ctx.degree)?.get(node.id) ?? 0
    case 'field': {
      // A dotted key reaches into nested data (`address.city`); the plain key wins when it is a field itself.
      const v = dataAt(node.data, attr.key)
      return typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : undefined
    }
    case 'metric': {
      if (!ctx.metrics || !ctx.metricIndex) return undefined
      const i = ctx.metricIndex.get(node.id)
      const col = ctx.metrics.columns[attr.key]
      return i === undefined || !col ? undefined : col[i]
    }
    case 'type':
      return node.type
    case 'tag':
      return attr.prefix ? node.tags.find((t) => t.startsWith(attr.prefix!)) : node.tags[0]
    case 'directed':
      return undefined
  }
}

function plainValue(e: AnyEntity, ref: string): number | string | undefined {
  const v = getPath(e, ref)
  return typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.join(', ') : undefined
}

export function edgeAttrValue(edge: Relationship, attr: Attr): number | string | undefined {
  switch (attr.kind) {
    case 'value':
      return plainValue(edge, attr.ref)
    case 'field': {
      const v = dataAt(edge.data, attr.key)
      return typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : undefined
    }
    case 'type':
      return edge.type
    case 'tag':
      return attr.prefix ? edge.tags.find((t) => t.startsWith(attr.prefix!)) : edge.tags[0]
    case 'directed':
      return edge.directed ? 'directed' : 'undirected'
    default:
      return undefined
  }
}

function buildScale(values: (number | string | undefined)[], channel: Channel): Scale | undefined {
  if (channel.mode === 'ranking') {
    const d = domainOf(values.map(num), channel.domain, !!channel.log)
    return { kind: 'numeric', norm: normalizer(d, !!channel.log), domain: d, log: !!channel.log }
  }
  if (channel.mode === 'partition') return { kind: 'categorical', cats: categories(values, 'maxCategories' in channel && channel.maxCategories ? channel.maxCategories : 12) }
  return undefined
}

export function styleContext(registry: TypeRegistry, nodes: AnyEntity[], degree: Map<string, number>, spec: RenderingSpec, extras: StyleExtras = {}): StyleContext {
  const ctx: StyleContext = { registry, degree, metrics: extras.metrics, metricIndex: extras.metricIndex, values: extras.values, tagColor: extras.tagColor, scales: new Map() }
  if (extras.metrics && !extras.metricIndex) {
    const idx = new Map<string, number>()
    extras.metrics.ids.forEach((id, i) => idx.set(id, i))
    ctx.metricIndex = idx
  }
  const edges = extras.edges ?? []

  // Directed degrees only when some channel asks for them.
  const wantsDir = (a: NodeAppearance) => [a.color, a.size, a.opacity, a.shape].some((c) => c && c.mode !== 'constant' && c.attr.kind === 'degree' && !!c.attr.dir)
  if (wantsDir(spec.nodes.default) || Object.values(spec.nodes.types).some(wantsDir) || Object.values(spec.nodes.tags).some(wantsDir)) {
    ctx.inDegree = new Map()
    ctx.outDegree = new Map()
    for (const e of edges) {
      ctx.outDegree.set(e.source.id, (ctx.outDegree.get(e.source.id) ?? 0) + 1)
      ctx.inDegree.set(e.target.id, (ctx.inDegree.get(e.target.id) ?? 0) + 1)
    }
  }

  // Node scales per scope × channel.
  const nodeScopes: [ScopeKey, NodeAppearance, () => AnyEntity[]][] = [['default', spec.nodes.default, () => nodes]]
  for (const [t, a] of Object.entries(spec.nodes.types)) nodeScopes.push([`type:${t}`, a, () => nodes.filter((n) => n.type === t)])
  for (const [t, a] of Object.entries(spec.nodes.tags)) nodeScopes.push([`tag:${t}`, a, () => nodes.filter((n) => n.tags.includes(t))])
  for (const [scope, a, members] of nodeScopes) {
    let set: AnyEntity[] | undefined
    for (const ch of ['color', 'size', 'opacity', 'shape'] as const) {
      const c = a[ch] as Channel | undefined
      if (!c || c.mode === 'constant') continue
      set ??= members()
      const scale = buildScale(set.map((n) => nodeAttrValue(n, c.attr, ctx)), c)
      if (scale) ctx.scales.set(scaleKey(scope, ch), scale)
    }
  }

  // Edge scales.
  const edgeScopes: [ScopeKey, EdgeAppearance, () => Relationship[]][] = [['default', spec.edges.default, () => edges]]
  for (const [t, a] of Object.entries(spec.edges.types)) edgeScopes.push([`type:${t}`, a, () => edges.filter((e) => e.type === t)])
  for (const [t, a] of Object.entries(spec.edges.tags)) edgeScopes.push([`tag:${t}`, a, () => edges.filter((e) => e.tags.includes(t))])
  for (const [scope, a, members] of edgeScopes) {
    let set: Relationship[] | undefined
    for (const ch of ['color', 'width', 'opacity'] as const) {
      const c = a[ch] as Channel | undefined
      if (!c || c.mode === 'constant') continue
      set ??= members()
      const scale = buildScale(set.map((e) => edgeAttrValue(e, c.attr)), c)
      if (scale) ctx.scales.set(scaleKey(scope, ch), scale)
    }
  }
  return ctx
}

/** Which scope supplies each channel for an element, in precedence order; visibility ANDs across everything matched. */
function pick<A extends { visible?: boolean }>(spec: RenderingSpec['precedence'], defaults: A, typeKey: string | undefined, typeRule: A | undefined, tagRules: [string, A][]): { get: <K extends keyof A>(k: K) => { value: A[K]; scope: ScopeKey }; visible: boolean } {
  // Later entries win.
  const order: [ScopeKey, A][] = [['default', defaults]]
  const tags: [ScopeKey, A][] = tagRules.map(([t, r]) => [`tag:${t}`, r])
  const type: [ScopeKey, A][] = typeRule && typeKey ? [[`type:${typeKey}`, typeRule]] : []
  if (spec === 'type') order.push(...tags, ...type)
  else order.push(...type, ...tags)
  let visible = true
  for (const [, r] of order) if (r.visible === false) visible = false
  return {
    visible,
    get: (k) => {
      for (let i = order.length - 1; i >= 0; i--) {
        const v = order[i][1][k]
        if (v !== undefined) return { value: v, scope: order[i][0] }
      }
      return { value: defaults[k], scope: 'default' }
    },
  }
}

/** Partitioned by tag, a value is a tag and wears the tag's own colour — the one its chip has in every list — unless the style names one. */
function partitionColor(ch: Extract<ColorChannel, { mode: 'partition' }>, scale: CategoricalScale, key: string, tagColor?: (tag: string) => string | undefined): string {
  if (ch.colors?.[key]) return ch.colors[key]
  if (ch.attr.kind === 'tag') return tagColor?.(key) || hashColor(key)
  // Past the legend's room the palette cycles: a value still gets a colour (shared with others), only "none" is grey.
  const i = scale.cats.rank.get(key)
  return i === undefined ? MISSING_COLOR : categoricalColor(ch.palette, i)
}

function mappedColor(ch: ColorChannel, scale: Scale | undefined, raw: number | string | undefined, tagColor?: (tag: string) => string | undefined): string | undefined {
  if (ch.mode === 'constant') return ch.value
  if (!scale) return MISSING_COLOR
  if (ch.mode === 'partition') {
    if (scale.kind !== 'categorical') return MISSING_COLOR
    if (raw === undefined || raw === null || raw === '') return MISSING_COLOR
    return partitionColor(ch, scale, String(raw), tagColor)
  }
  if (scale.kind !== 'numeric') return MISSING_COLOR
  const t = scale.norm(num(raw))
  return Number.isNaN(t) ? MISSING_COLOR : paletteColor(ch.palette, t)
}

function mappedNumber(ch: NumberChannel, scale: Scale | undefined, raw: number | string | undefined): number {
  if (ch.mode === 'constant') return ch.value
  if (!scale || scale.kind !== 'numeric') return ch.min
  const t = scale.norm(num(raw))
  return ch.min + (ch.max - ch.min) * (Number.isNaN(t) ? 0 : Math.max(0, Math.min(1, t)))
}

function mappedShape(ch: ShapeChannel, scale: Scale | undefined, raw: number | string | undefined): NodeShape {
  if (ch.mode === 'constant') return ch.value
  if (raw === undefined || raw === null || raw === '' || !scale || scale.kind !== 'categorical') return 'circle'
  const key = String(raw)
  if (ch.shapes?.[key]) return ch.shapes[key]
  const i = scale.cats.index.get(key)
  return i === undefined ? 'circle' : NODE_SHAPES[i % NODE_SHAPES.length].id
}

export function resolveNodeStyle(node: AnyEntity, spec: RenderingSpec, ctx: StyleContext): NodeStyle {
  const p = pick<NodeAppearance>(
    spec.precedence,
    spec.nodes.default,
    node.type,
    spec.nodes.types[node.type],
    node.tags.flatMap((t) => (spec.nodes.tags[t] ? [[t, spec.nodes.tags[t]] as [string, NodeAppearance]] : [])),
  )
  const value = (ch: Channel) => (ch.mode === 'constant' ? undefined : nodeAttrValue(node, ch.attr, ctx))

  const color = p.get('color')
  const cch = color.value as ColorChannel
  // Colour precedence: channel (constant or mapped) → entity's own data.color → type colour → hash.
  const own = typeof node.data.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(node.data.color) ? node.data.color : undefined
  const resolvedColor = mappedColor(cch, ctx.scales.get(scaleKey(color.scope, 'color')), value(cch), ctx.tagColor) ?? own ?? ctx.registry.colorOf(node.type)

  const size = p.get('size')
  const sch = size.value as NumberChannel
  const base = mappedNumber(sch, ctx.scales.get(scaleKey(size.scope, 'size')), value(sch))
  const scale = (p.get('sizeScale').value as number | undefined) ?? 1

  const op = p.get('opacity')
  const och = op.value as NumberChannel
  const opacity = Math.max(0, Math.min(1, mappedNumber(och, ctx.scales.get(scaleKey(op.scope, 'opacity')), value(och))))

  const sh = p.get('shape')
  const shch = sh.value as ShapeChannel
  const shape = mappedShape(shch, ctx.scales.get(scaleKey(sh.scope, 'shape')), value(shch))

  const st: NodeStyle = { color: resolvedColor, size: base * scale, shape, opacity, visible: p.visible, label: (p.get('label').value as boolean | undefined) !== false }
  const over = spec.overlay?.nodes?.[node.id]
  return over ? { ...st, ...over } : st
}

/**
 * Every node's style, sharing one resolved object per **style class**: what
 * `resolveNodeStyle` reads off a node is its type, the tags a rule names,
 * its own `data.color` and the value of every mapped channel — so nodes
 * alike in those get the same style, resolved once. A view of hundreds of
 * thousands of nodes of a few types resolves a few dozen styles instead of
 * one per node; a continuous mapping (a metric) still resolves per value.
 * The styles are shared and must be read, never written.
 */
export function resolveNodeStyles(nodes: Iterable<AnyEntity>, spec: RenderingSpec, ctx: StyleContext): Map<string, NodeStyle> {
  const out = new Map<string, NodeStyle>()
  const ruled = new Set(Object.keys(spec.nodes.tags))
  const mapped: Exclude<Channel, { mode: 'constant' }>[] = []
  for (const a of [spec.nodes.default, ...Object.values(spec.nodes.types), ...Object.values(spec.nodes.tags)]) {
    for (const ch of [a.color, a.size, a.opacity, a.shape]) if (ch && ch.mode !== 'constant' && !mapped.some((m) => m === ch)) mapped.push(ch)
  }
  const cache = new Map<string, NodeStyle>()
  const over = spec.overlay?.nodes
  for (const n of nodes) {
    // A scripted node is its own class: resolved on its own, never shared.
    if (over?.[n.id]) {
      out.set(n.id, resolveNodeStyle(n, spec, ctx))
      continue
    }
    let key = n.type
    if (ruled.size) for (const t of n.tags) if (ruled.has(t)) key += `\u0001${t}`
    if (typeof n.data.color === 'string') key += `\u0002${n.data.color}`
    for (const ch of mapped) key += `\u0003${String(nodeAttrValue(n, ch.attr, ctx))}`
    let st = cache.get(key)
    if (!st) {
      st = resolveNodeStyle(n, spec, ctx)
      cache.set(key, st)
    }
    out.set(n.id, st)
  }
  return out
}

export function resolveEdgeStyle(edge: Relationship, spec: RenderingSpec, defaultColor: (type: string) => string, ctx?: Pick<StyleContext, 'scales' | 'tagColor'>): EdgeStyle {
  const p = pick<EdgeAppearance>(
    spec.precedence,
    spec.edges.default,
    edge.type,
    spec.edges.types[edge.type],
    edge.tags.flatMap((t) => (spec.edges.tags[t] ? [[t, spec.edges.tags[t]] as [string, EdgeAppearance]] : [])),
  )
  const scales = ctx?.scales ?? new Map<string, Scale>()
  const value = (ch: Channel) => (ch.mode === 'constant' ? undefined : edgeAttrValue(edge, ch.attr))

  const color = p.get('color')
  const cch = color.value as ColorChannel
  const resolvedColor = mappedColor(cch, scales.get(scaleKey(color.scope, 'color')), value(cch), ctx?.tagColor) ?? defaultColor(edge.type)

  const w = p.get('width')
  const wch = w.value as NumberChannel
  const width = mappedNumber(wch, scales.get(scaleKey(w.scope, 'width')), value(wch)) * ((p.get('widthScale').value as number | undefined) ?? 1)

  const op = p.get('opacity')
  const och = op.value as NumberChannel
  const opacity = Math.max(0, Math.min(1, mappedNumber(och, scales.get(scaleKey(op.scope, 'opacity')), value(och))))

  const st: EdgeStyle = { color: resolvedColor, width, opacity, visible: p.visible, arrow: (p.get('arrow').value as boolean | undefined) !== false }
  const over = spec.overlay?.edges?.[edge.id]
  return over ? { ...st, ...over } : st
}

/**
 * The colour the picture gives the nodes of a type, for anything that shows a type beside the picture — the legend,
 * the filter's type list — so they all say what the canvas draws. A per-type constant colour first (it wins on the
 * canvas under type precedence), then the default channel: one colour for everything, or the type's place in a
 * colour-by-type palette. When the colour follows something else (a tag, a metric, a field), a type has no single
 * colour on the canvas and this is the type's own; so it is for a type the view does not hold at the moment.
 */
export function typeColorFor(spec: RenderingSpec, ctx: StyleContext, type: string): string {
  const rule = spec.nodes.types[type]?.color
  if (rule?.mode === 'constant' && rule.value) return rule.value
  const ch = spec.nodes.default.color
  // A constant with no value is "each type its own colour".
  if (ch.mode === 'constant' && ch.value) return ch.value
  if (ch.mode === 'partition' && ch.attr.kind === 'type') {
    const sc = ctx.scales.get(scaleKey('default', 'color'))
    if (ch.colors?.[type]) return ch.colors[type]
    if (sc?.kind === 'categorical' && sc.cats.rank.has(type)) return partitionColor(ch, sc, type, ctx.tagColor)
  }
  return ctx.registry.colorOf(type)
}

// ── Legend ─────────────────────────────────────────────────────────────

export type Legend =
  | { kind: 'gradient'; title: string; palette: PaletteId; domain: [number, number]; log: boolean; scripted?: boolean }
  | {
      kind: 'categories'
      title: string
      /** A script's legend: its own title and items, no counts, not a colour-by choice. */
      scripted?: boolean
      /** The palette the overflow cycles through; absent when the swatches are the types' own colours. */
      palette?: PaletteId
      items: { key: string; label: string; color: string; count: number }[]
      /** Nodes whose value fell past the legend's room, and how many distinct values did — they are still coloured, cycling the palette. */
      overflow: number
      more: number
      /** Past this many values the palette's colours come round again (a partition by a field or a metric, not by tag or type). */
      repeatsFrom?: number
      /** Nodes in view with no value for the attribute (no tag in the namespace, no such field): drawn in the missing colour. */
      missing: number
    }

/**
 * How many rows a legend lists before the rest are counted as "N more". The list scrolls, so it is not the room on
 * screen that limits it — every type, every genus of a city's trees — only a tag namespace of thousands of values.
 */
export const LEGEND_ROWS = 500

/** What the node colouring means: the global colour mapping, else one swatch per visible type. */
export function legendFor(spec: RenderingSpec, ctx: StyleContext, nodes: AnyEntity[]): Legend | null {
  // A script that coloured the nodes says what its colours mean.
  const ol = spec.overlay?.legend
  if (ol && 'items' in ol) return { kind: 'categories', title: ol.title, scripted: true, items: ol.items.map((it, i) => ({ key: `${i}:${it.label}`, label: it.label, color: it.color, count: 0 })), overflow: 0, more: 0, missing: 0 }
  if (ol && 'palette' in ol) return { kind: 'gradient', title: ol.title, scripted: true, palette: ol.palette, domain: ol.domain, log: !!ol.log }
  const ch = spec.nodes.default.color
  const sc = ctx.scales.get(scaleKey('default', 'color'))
  if (ch.mode === 'ranking' && sc?.kind === 'numeric') return { kind: 'gradient', title: capital(attrLabel(ch.attr)), palette: ch.palette, domain: sc.domain, log: sc.log }
  if (ch.mode === 'partition' && sc?.kind === 'categorical') {
    // Every value, most frequent first — not only the palette's first twelve: the list scrolls. Past the palette the
    // colours cycle (`partitionColor` by rank), which the legend says; by tag every value has a colour of its own.
    const all = [...sc.cats.counts.entries()].sort((a, b) => b[1] - a[1])
    const listed = all.slice(0, LEGEND_ROWS)
    const items = listed.map(([key]) => {
      // Partitioning by type: the colour every other list of types shows too (a type's own constant rule still wins on the canvas).
      const override = ch.attr.kind === 'type' && spec.precedence === 'type' ? typeColorFor(spec, ctx, key) : undefined
      // A namespaced tag reads without its namespace: the legend's title already says which. The prefix comes with or without its colon.
      const prefix = ch.attr.kind === 'tag' && ch.attr.prefix ? (ch.attr.prefix.endsWith(':') ? ch.attr.prefix : `${ch.attr.prefix}:`) : undefined
      return {
        key,
        label: ch.attr.kind === 'type' ? ctx.registry.get(key).label : ch.attr.kind === 'metric' && ch.attr.key === 'community' ? `Community ${key}` : prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
        color: override ?? partitionColor(ch, sc, key, ctx.tagColor),
        count: sc.cats.counts.get(key) ?? 0,
      }
    })
    let missing = 0
    for (const n of nodes) {
      const v = nodeAttrValue(n, ch.attr, ctx)
      if (v === undefined || v === null || v === '') missing++
    }
    // By tag every value has a colour of its own, so nothing past the legend's room "repeats".
    // Colours come round again only where the palette gives them: not by tag (a tag's own colour), nor by type when the
    // types' own colours win (`precedence: 'type'`, the colour every other list of types shows).
    const ownColours = ch.attr.kind === 'tag' || (ch.attr.kind === 'type' && spec.precedence === 'type')
    const cycles = !ownColours && !ch.colors && all.length > sc.cats.keys.length
    return {
      kind: 'categories',
      title: capital(attrLabel(ch.attr)),
      palette: ch.attr.kind === 'tag' ? undefined : ch.palette,
      items,
      overflow: all.slice(LEGEND_ROWS).reduce((n, [, c]) => n + c, 0),
      more: Math.max(0, all.length - LEGEND_ROWS),
      missing,
      ...(cycles ? { repeatsFrom: sc.cats.keys.length } : {}),
    }
  }
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LEGEND_ROWS)
    .map(([type, count]) => {
      const rule = spec.nodes.types[type]?.color
      const color = (rule?.mode === 'constant' ? rule.value : undefined) ?? (ch.mode === 'constant' ? ch.value : undefined) ?? ctx.registry.colorOf(type)
      return { key: type, label: ctx.registry.get(type).label, color, count }
    })
  const sortedCounts = [...counts.values()].sort((a, b) => b - a)
  // Every type: each has its own colour, and each row is the switch that hides or shows it.
  return items.length ? { kind: 'categories', title: 'Type', items, overflow: sortedCounts.slice(LEGEND_ROWS).reduce((a, b) => a + b, 0), more: Math.max(0, counts.size - LEGEND_ROWS), missing: 0 } : null
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ── Editing helpers ────────────────────────────────────────────────────

/** Set (or clear, when `patch` is null) one rule; `undefined` values in the patch unset those channels. Returns a new spec. */
export function setRule(spec: RenderingSpec, scope: 'nodes' | 'edges', by: 'types' | 'tags', key: string, patch: NodeRule | EdgeRule | null): RenderingSpec {
  const rules = { ...spec[scope][by] } as Record<string, NodeRule | EdgeRule>
  if (patch === null) delete rules[key]
  else {
    const next = { ...(rules[key] ?? {}), ...patch } as Record<string, unknown>
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    if (Object.keys(next).length === 0) delete rules[key]
    else rules[key] = next as NodeRule
  }
  return { ...spec, [scope]: { ...spec[scope], [by]: rules } }
}

/** Set a channel on the defaults. */
export function setDefault(spec: RenderingSpec, scope: 'nodes', patch: Partial<NodeDefaults>): RenderingSpec
export function setDefault(spec: RenderingSpec, scope: 'edges', patch: Partial<EdgeDefaults>): RenderingSpec
export function setDefault(spec: RenderingSpec, scope: 'nodes' | 'edges', patch: Partial<NodeDefaults> | Partial<EdgeDefaults>): RenderingSpec {
  const next = { ...spec[scope].default, ...patch } as Record<string, unknown>
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  return { ...spec, [scope]: { ...spec[scope], default: next } } as RenderingSpec
}

/** The palette kind a colour channel needs. */
export const paletteKindFor = (ch: ColorChannel): 'sequential' | 'diverging' | 'categorical' => (ch.mode === 'partition' ? 'categorical' : ch.mode === 'ranking' ? (PALETTES.find((p) => p.id === ch.palette)?.kind === 'diverging' ? 'diverging' : 'sequential') : 'sequential')

/** Apply alpha to a css color for canvases that don't take opacity separately. */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const m6 = /^#([0-9a-f]{6})$/i.exec(color)
  if (m6) {
    const n = parseInt(m6[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  const hsl = /^hsl\((\d+)\s+(\d+)%\s+(\d+)%\)$/.exec(color)
  if (hsl) return `hsl(${hsl[1]} ${hsl[2]}% ${hsl[3]}% / ${alpha})`
  return color
}

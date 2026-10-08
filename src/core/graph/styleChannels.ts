import { isPaletteId, PALETTES } from './palettes'
import { METRIC_IDS, type NodeMetricId } from './metrics'
import { attrLabel, isCategoricalAttr, setDefault, setRule, type Attr, type Channel, type EdgeRule, type NodeDefaults, type NodeRule, type NodeShape, type RenderingSpec } from './rendering'
import { isValidValueRef, parseValueRef, refUsesMetrics } from './values'

/**
 * A style as a caller describes it: one entry per visual channel — node
 * colour, size, opacity, shape; edge colour, width, opacity — each a
 * constant, a ranking over a numeric attribute, or a partition over a
 * categorical one, set for every node/edge or overridden for one type or
 * tag. This is Gephi's appearance panel as data, and the form both hosts
 * take it in: the explorer's `graph_style` in a tab, and the headless
 * engine composing a scene with no canvas. The rules it produces are the
 * rendering spec a `rendering` entity holds.
 */

export interface StyleChannelInput {
  scope: 'nodes' | 'edges'
  /** `all` sets the default for every node/edge; `types`/`tags` override for one type or tag (which `key` names). */
  by: 'all' | 'types' | 'tags'
  key?: string
  channel: 'color' | 'size' | 'opacity' | 'shape' | 'width'
  mode: 'constant' | 'ranking' | 'partition' | 'inherit'
  /** constant: a CSS colour, a number (size px / opacity 0–1 / width px), or a shape. */
  value?: unknown
  attr?: { kind: string; key?: string; dir?: string; prefix?: string; ref?: string }
  palette?: string
  colors?: Record<string, string>
  shapes?: Record<string, string>
  domain?: [number, number]
  log?: boolean
  min?: number
  max?: number
  max_categories?: number
}

/** One channel applied: what to set, where. A host with a live view mirrors these into it; the spec already has them. */
export interface StyleChannelChange {
  scope: 'nodes' | 'edges'
  by: 'all' | 'types' | 'tags'
  key?: string
  channel: StyleChannelInput['channel']
  /** The rule patch for a type/tag override (`by` is not `all`); `null` for "inherit", which removes the override. */
  patch: NodeRule | EdgeRule | null
}

export interface StyleChannelContext {
  /**
   * Metrics that are available to style by, as a set of metric ids. A
   * ranking or partition over `metric.pagerank` needs the numbers to exist:
   * in a tab that is what `graph_metrics` computed, headless it is what the
   * scene's analysis holds. Undefined means "do not check" (the caller
   * knows the values arrive with the view).
   */
  metrics?: Iterable<string>
  /** How this host says "compute the metrics": the explorer's `call graph_metrics first`, the engine's own wording. */
  computeHint?: (metric: string) => string
}

export const SHAPE_IDS: NodeShape[] = ['circle', 'square', 'diamond', 'triangle']
const hint = (ctx: StyleChannelContext, metric: string) => ctx.computeHint?.(metric) ?? `compute it first (metrics: ["${metric}"]).`
export const VALUE_REF_HINT = 'A ValueRef is data.<key>, meta.updatedAt, label, type, tags, degree[.in|.out][:relType], metric.<id> or dataset:<dataset id>.<column>.'

/** The channel a scope currently uses, so a ranking can keep the range it had. */
export function currentChannel(spec: RenderingSpec, scope: 'nodes' | 'edges', by: 'all' | 'types' | 'tags', key: string | undefined, channel: string): Channel | undefined {
  const rules = spec[scope] as unknown as { default: Record<string, unknown>; types: Record<string, Record<string, unknown>>; tags: Record<string, Record<string, unknown>> }
  const over = by !== 'all' && key ? rules[by][key]?.[channel] : undefined
  return (over ?? rules.default[channel]) as Channel | undefined
}

/** One channel → the `Channel` it describes, with every way of getting it wrong reported as a sentence. */
export function toChannel(spec: RenderingSpec, c: StyleChannelInput, ctx: StyleChannelContext = {}): Channel | undefined {
  const computed = ctx.metrics ? new Set(ctx.metrics) : undefined
  if (c.scope !== 'nodes' && c.scope !== 'edges') throw new Error(`channel: scope must be "nodes" or "edges" (got ${JSON.stringify(c.scope)}); by "all" | "types" | "tags"; channel; mode.`)
  const isNode = c.scope === 'nodes'
  if ((c.channel === 'size' || c.channel === 'shape') && !isNode) throw new Error(`"${c.channel}" is a node channel.`)
  if (c.channel === 'width' && isNode) throw new Error('"width" is an edge channel.')
  if (c.by !== 'all' && !c.key) throw new Error(`channel with by "${c.by}" needs key (the ${c.by === 'types' ? 'type' : 'tag'}).`)
  if (c.mode === 'inherit') {
    if (c.by === 'all') throw new Error('"inherit" only applies to a type or tag override.')
    return undefined
  }
  if (c.mode === 'constant') {
    if (c.channel === 'color') {
      if (c.value !== undefined && typeof c.value !== 'string') throw new Error('color constant needs a CSS color string.')
      return { mode: 'constant', ...(typeof c.value === 'string' ? { value: c.value } : {}) }
    }
    if (c.channel === 'shape') {
      if (!SHAPE_IDS.includes(c.value as NodeShape)) throw new Error(`shape constant needs one of ${SHAPE_IDS.join(', ')}.`)
      return { mode: 'constant', value: c.value as NodeShape }
    }
    if (typeof c.value !== 'number') throw new Error(`${c.channel} constant needs a number.`)
    return { mode: 'constant', value: c.value }
  }
  if (!c.attr) throw new Error(`${c.mode} needs attr.`)
  const a = c.attr
  if ((a.kind === 'field' || a.kind === 'metric') && !a.key) throw new Error(`attr "${a.kind}" needs key.`)
  if (a.kind === 'value') {
    if (!a.ref || !isValidValueRef(a.ref)) throw new Error(`attr "value" needs a valid ref (got "${a.ref ?? ''}"). ${VALUE_REF_HINT}`)
    if (!isNode && parseValueRef(a.ref) && !['data', 'meta', 'label', 'type', 'id', 'tags'].includes(parseValueRef(a.ref)!.kind)) throw new Error('Edges only support data/meta/label/type refs.')
    if (computed && refUsesMetrics(a.ref) && !computed.has(a.ref.slice(7))) throw new Error(`Metric "${a.ref.slice(7)}" has not been computed for this view; ${hint(ctx, a.ref.slice(7))}`)
  }
  if (a.kind === 'metric') {
    if (!isNode) throw new Error('Metrics are node attributes.')
    if (!METRIC_IDS.includes(a.key as NodeMetricId)) throw new Error(`Unknown metric "${a.key}". Metrics: ${METRIC_IDS.join(', ')}.`)
    if (computed && !computed.has(a.key!)) throw new Error(`Metric "${a.key}" has not been computed for this view; ${hint(ctx, a.key!)}`)
  }
  if (a.kind === 'degree' && !isNode) throw new Error('Degree is a node attribute.')
  if (a.kind === 'directed' && isNode) throw new Error('"directed" is an edge attribute.')
  const attr = (a.kind === 'value' ? { kind: 'value', ref: a.ref! } : a.kind === 'field' ? { kind: 'field', key: a.key! } : a.kind === 'metric' ? { kind: 'metric', key: a.key as NodeMetricId } : a.kind === 'degree' ? { kind: 'degree', ...(a.dir && a.dir !== 'both' ? { dir: a.dir } : {}) } : a.kind === 'tag' ? { kind: 'tag', ...(a.prefix ? { prefix: a.prefix } : {}) } : { kind: a.kind }) as Attr
  if (c.mode === 'partition') {
    if (c.channel !== 'color' && c.channel !== 'shape') throw new Error(`partition applies to color or shape, not ${c.channel}. Use ranking.`)
    if (c.channel === 'shape') return { mode: 'partition', attr, ...(c.shapes ? { shapes: c.shapes as Record<string, NodeShape> } : {}) }
    const palette = isPaletteId(c.palette) && PALETTES.find((p) => p.id === c.palette)?.kind === 'categorical' ? c.palette : 'tableau10'
    return { mode: 'partition', attr, palette, ...(c.max_categories ? { maxCategories: c.max_categories } : {}), ...(c.colors ? { colors: c.colors } : {}) }
  }
  if (isCategoricalAttr(attr)) throw new Error(`"${attrLabel(attr)}" is categorical; use partition (color/shape) rather than ranking.`)
  if (c.channel === 'shape') throw new Error('shape takes constant or partition, not ranking.')
  const common = { attr, ...(c.domain ? { domain: [c.domain[0], c.domain[1]] as [number, number] } : {}), ...(c.log ? { log: true } : {}) }
  if (c.channel === 'color') {
    const kind = PALETTES.find((p) => p.id === c.palette)?.kind
    return { mode: 'ranking', ...common, palette: isPaletteId(c.palette) && (kind === 'sequential' || kind === 'diverging') ? c.palette : 'viridis' }
  }
  const cur = currentChannel(spec, c.scope, c.by, c.key, c.channel)
  const prev = cur && cur.mode === 'ranking' && 'min' in cur ? cur : undefined
  const dflt = c.channel === 'size' ? [3, 14] : c.channel === 'width' ? [0.5, 4] : [0.2, 1]
  return { mode: 'ranking', ...common, min: c.min ?? prev?.min ?? dflt[0], max: c.max ?? prev?.max ?? dflt[1] }
}

/** Every channel applied to a rendering spec, in order: the new spec, and the changes a live view should mirror. */
export function applyStyleChannels(spec: RenderingSpec, channels: readonly StyleChannelInput[], ctx: StyleChannelContext = {}): { spec: RenderingSpec; changes: StyleChannelChange[] } {
  const changes: StyleChannelChange[] = []
  let next = spec
  for (const c of channels) {
    const channel = toChannel(next, c, ctx)
    if (c.by === 'all') {
      next = setDefault(next, c.scope as 'nodes', { [c.channel]: channel } as Partial<NodeDefaults>)
      changes.push({ scope: c.scope, by: 'all', channel: c.channel, patch: { [c.channel]: channel } as NodeRule })
    } else {
      const patch = { [c.channel]: channel } as NodeRule | EdgeRule
      next = setRule(next, c.scope, c.by, c.key!, patch)
      changes.push({ scope: c.scope, by: c.by, key: c.key, channel: c.channel, patch })
    }
  }
  return { spec: next, changes }
}

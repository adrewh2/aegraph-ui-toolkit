import { columnLabel, datasetsIn, inferColumnKind } from '../datasets/dataset'
import { datasetValue, keyColumnOf, parseDatasetRef } from '../datasets/join'
import type { EntityStore } from '../entity/store'
import type { AnyEntity, EntityId, Relationship } from '../entity/types'
import { coerce, dataAt, ISO, sampleDataKeys } from './fields'
import type { GraphSlice } from './filter'
import { METRICS, metricInfo, type MetricsResult, type NodeMetricId } from './metrics/types'

/**
 * A ValueRef names one value on a node in a way that works everywhere —
 * filter predicates, appearance channels, placement axes, sorting, queries:
 *
 *   data.<key>                       any data field
 *   meta.updatedAt|createdAt|accessedAt   as epoch milliseconds
 *   label · type · id · tags
 *   metric.<id>                      a computed metric column (pagerank, community, …)
 *   degree · degree.in · degree.out  links in the current scope
 *   degree[.in|.out]:<relType>       links of one relationship type, e.g. degree.in:cites
 *   selected · pinned                1 or 0
 *   dataset:<id>.<column>            a dataset's column, on the entity its row matches (`core/datasets/join.ts`):
 *                                    by the dataset's id column, else its type column, else its first column
 */
export type ValueRef = string

export type ParsedRef =
  | { kind: 'data'; key: string }
  | { kind: 'meta'; key: 'updatedAt' | 'createdAt' | 'accessedAt' }
  | { kind: 'label' }
  | { kind: 'type' }
  | { kind: 'id' }
  | { kind: 'tags' }
  | { kind: 'metric'; id: NodeMetricId }
  | { kind: 'degree'; dir: 'both' | 'in' | 'out'; relType?: string }
  | { kind: 'selected' }
  | { kind: 'pinned' }
  | { kind: 'dataset'; dataset: EntityId; column: string }

const parseCache = new Map<string, ParsedRef | null>()

export function parseValueRef(ref: string): ParsedRef | undefined {
  const cached = parseCache.get(ref)
  if (cached !== undefined) return cached ?? undefined
  const p = parse(ref)
  parseCache.set(ref, p ?? null)
  return p
}

function parse(ref: string): ParsedRef | undefined {
  const s = ref.trim()
  if (!s) return undefined
  if (s.startsWith('data.')) return s.length > 5 ? { kind: 'data', key: s.slice(5) } : undefined
  if (s.startsWith('meta.')) {
    const key = s.slice(5)
    return key === 'updatedAt' || key === 'createdAt' || key === 'accessedAt' ? { kind: 'meta', key } : undefined
  }
  if (s === 'label' || s === 'type' || s === 'id' || s === 'tags' || s === 'selected' || s === 'pinned') return { kind: s }
  if (s.startsWith('metric.')) {
    const id = s.slice(7) as NodeMetricId
    return METRICS.some((m) => m.id === id) ? { kind: 'metric', id } : undefined
  }
  const m = /^degree(?:\.(in|out))?(?::(.+))?$/.exec(s)
  if (m) return { kind: 'degree', dir: (m[1] as 'in' | 'out' | undefined) ?? 'both', relType: m[2] }
  const d = parseDatasetRef(s)
  if (d) return { kind: 'dataset', ...d }
  return undefined
}

/** Refs `getPath` can answer with no context. */
export const isPlainRef = (ref: ValueRef): boolean => {
  const p = parseValueRef(ref)
  return !!p && (p.kind === 'data' || p.kind === 'meta' || p.kind === 'label' || p.kind === 'type' || p.kind === 'id' || p.kind === 'tags')
}
export const refUsesMetrics = (ref: ValueRef): boolean => parseValueRef(ref)?.kind === 'metric'
export const refIsStateful = (ref: ValueRef): boolean => {
  const k = parseValueRef(ref)?.kind
  return k === 'selected' || k === 'pinned'
}
export const isCategoricalRef = (ref: ValueRef): boolean => {
  const p = parseValueRef(ref)
  if (!p) return false
  return p.kind === 'type' || p.kind === 'label' || p.kind === 'id' || p.kind === 'tags' || (p.kind === 'metric' && !!metricInfo(p.id).categorical)
}

/**
 * Per-(direction, relationship type) degree counts, built lazily one O(E)
 * pass at a time and cached, so asking for `degree.in:cites` never costs
 * more than a single sweep of the edges — and nothing is built until asked.
 */
export class DegreeIndex {
  private cache = new Map<string, Map<EntityId, number>>()
  private readonly edges: () => Relationship[]
  constructor(edges: () => Relationship[]) {
    this.edges = edges
  }
  get(id: EntityId, dir: 'both' | 'in' | 'out' = 'both', relType?: string): number {
    return this.table(dir, relType).get(id) ?? 0
  }
  table(dir: 'both' | 'in' | 'out', relType?: string): Map<EntityId, number> {
    const key = `${dir}:${relType ?? ''}`
    let t = this.cache.get(key)
    if (!t) {
      t = new Map()
      for (const e of this.edges()) {
        if (relType !== undefined && e.type !== relType) continue
        if (dir === 'both' || dir === 'out' || !e.directed) t.set(e.source.id, (t.get(e.source.id) ?? 0) + 1)
        if (dir === 'both' || dir === 'in' || !e.directed) t.set(e.target.id, (t.get(e.target.id) ?? 0) + 1)
      }
      this.cache.set(key, t)
    }
    return t
  }
}

export interface ValueContext {
  /** Bound `valueOf` for callers that can't import this module (fields.ts). Filled by makeValueContext. */
  resolve?: (node: AnyEntity, ref: ValueRef) => number | string | undefined
  /** Where structural values (degree) are counted: the visible slice or the whole dataset. */
  scope: 'view' | 'dataset'
  store?: EntityStore
  slice?: Pick<GraphSlice, 'nodes' | 'edges' | 'degree'>
  degrees: DegreeIndex
  metrics?: MetricsResult
  metricIndex?: Map<EntityId, number>
  selected?: Set<EntityId>
  pinned?: Set<EntityId>
  /** Virtual data fields (a loaded project's exported metrics), read as `data.<key>` when the node itself lacks the key. */
  overlay?: Map<EntityId, Record<string, number>>
}

export function makeValueContext(o: Omit<ValueContext, 'degrees'> & { degrees?: DegreeIndex }): ValueContext {
  const degrees = o.degrees ?? new DegreeIndex(() => (o.scope === 'dataset' && o.store ? o.store.relationships() : (o.slice?.edges ?? [])))
  let metricIndex = o.metricIndex
  if (o.metrics && !metricIndex) {
    metricIndex = new Map()
    o.metrics.ids.forEach((id, i) => metricIndex!.set(id, i))
  }
  const ctx: ValueContext = { ...o, degrees, metricIndex }
  ctx.resolve = (node, ref) => valueOf(node, ref, ctx)
  return ctx
}

export function valueOf(node: AnyEntity, ref: ValueRef | ParsedRef, ctx: ValueContext): number | string | undefined {
  const p = typeof ref === 'string' ? parseValueRef(ref) : ref
  if (!p) return undefined
  switch (p.kind) {
    case 'data': {
      const v = dataAt(node.data, p.key) ?? ctx.overlay?.get(node.id)?.[p.key]
      return typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.join(', ') : undefined
    }
    case 'meta': {
      const v = node.meta[p.key]
      if (!v) return undefined
      const t = Date.parse(v)
      return Number.isNaN(t) ? undefined : t
    }
    case 'label':
      return node.label?.trim() || node.id
    case 'type':
      return node.type
    case 'id':
      return node.id
    case 'tags':
      return node.tags.length ? node.tags.join(', ') : undefined
    case 'metric': {
      if (!ctx.metrics || !ctx.metricIndex) return undefined
      const i = ctx.metricIndex.get(node.id)
      const col = ctx.metrics.columns[p.id]
      return i === undefined || !col ? undefined : col[i]
    }
    case 'degree':
      if (p.dir === 'both' && p.relType === undefined && ctx.scope === 'view' && ctx.slice) return ctx.slice.degree.get(node.id) ?? 0
      return ctx.degrees.get(node.id, p.dir, p.relType)
    case 'selected':
      return ctx.selected?.has(node.id) ? 1 : 0
    case 'pinned':
      return ctx.pinned?.has(node.id) ? 1 : 0
    case 'dataset':
      return ctx.store ? datasetValue(ctx.store, p.dataset, p.column, node) : undefined
  }
}

/** Numeric view of a value: numbers as-is, numeric strings and ISO dates coerced, else NaN. */
export function numericOf(node: AnyEntity, ref: ValueRef | ParsedRef, ctx: ValueContext): number {
  const v = valueOf(node, ref, ctx)
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const [n] = coerce(v, 0)
    if (typeof n === 'number') return n
    if (ISO.test(v)) {
      const t = Date.parse(v)
      return Number.isNaN(t) ? NaN : t
    }
    return NaN
  }
  return NaN
}

export function describeValueRef(ref: ValueRef): string {
  const p = parseValueRef(ref)
  if (!p) return ref
  switch (p.kind) {
    case 'data':
      return p.key
    case 'meta':
      return p.key === 'updatedAt' ? 'last edited' : p.key === 'createdAt' ? 'created' : 'last opened'
    case 'metric':
      return metricInfo(p.id).label
    case 'degree': {
      const d = p.dir === 'in' ? 'in-degree' : p.dir === 'out' ? 'out-degree' : 'degree'
      return p.relType ? `${d} via ${p.relType}` : d
    }
    case 'dataset':
      return p.column
    default:
      return p.kind
  }
}

export interface ValueRefInfo {
  ref: ValueRef
  label: string
  group: 'Data' | 'Meta' | 'Structure' | 'Metrics' | 'Selection' | 'Datasets'
  kind: 'numeric' | 'categorical' | 'unknown'
  /** False for metrics that have not been computed yet. */
  available: boolean
}

/** Everything a picker can offer for the nodes at hand. */
export function listValueRefs(ctx: ValueContext, nodes?: AnyEntity[], sample = 500): ValueRefInfo[] {
  const pool = nodes ?? ctx.slice?.nodes ?? []
  const out: ValueRefInfo[] = []
  const numericKeys = new Set<string>()
  for (let i = 0; i < Math.min(sample, pool.length); i++) for (const [k, v] of Object.entries(pool[i].data)) if (typeof v === 'number') numericKeys.add(k)
  for (const k of sampleDataKeys(pool, sample)) {
    if (k.startsWith('data.')) out.push({ ref: k, label: k.slice(5), group: 'Data', kind: numericKeys.has(k.slice(5)) ? 'numeric' : 'categorical', available: true })
  }
  if (ctx.overlay) {
    const keys = new Set<string>()
    let i = 0
    for (const row of ctx.overlay.values()) {
      for (const k of Object.keys(row)) keys.add(k)
      if (++i > sample) break
    }
    for (const k of keys) if (!out.some((o) => o.ref === `data.${k}`)) out.push({ ref: `data.${k}`, label: `${k} (project)`, group: 'Data', kind: 'numeric', available: true })
  }
  out.push({ ref: 'meta.updatedAt', label: 'last edited', group: 'Meta', kind: 'numeric', available: true }, { ref: 'meta.createdAt', label: 'created', group: 'Meta', kind: 'numeric', available: true }, { ref: 'type', label: 'type', group: 'Meta', kind: 'categorical', available: true }, { ref: 'tags', label: 'tags', group: 'Meta', kind: 'categorical', available: true })
  out.push({ ref: 'degree', label: 'degree', group: 'Structure', kind: 'numeric', available: true }, { ref: 'degree.in', label: 'in-degree', group: 'Structure', kind: 'numeric', available: true }, { ref: 'degree.out', label: 'out-degree', group: 'Structure', kind: 'numeric', available: true })
  const relTypes = new Set<string>()
  const edges = ctx.scope === 'dataset' && ctx.store ? ctx.store.relationships() : (ctx.slice?.edges ?? [])
  for (const e of edges) relTypes.add(e.type)
  for (const t of [...relTypes].sort()) out.push({ ref: `degree.in:${t}`, label: `in-degree via ${t}`, group: 'Structure', kind: 'numeric', available: true }, { ref: `degree.out:${t}`, label: `out-degree via ${t}`, group: 'Structure', kind: 'numeric', available: true })
  for (const m of METRICS) out.push({ ref: `metric.${m.id}`, label: m.label, group: 'Metrics', kind: m.categorical ? 'categorical' : 'numeric', available: !!ctx.metrics?.columns[m.id] })
  out.push({ ref: 'selected', label: 'selected', group: 'Selection', kind: 'numeric', available: true }, { ref: 'pinned', label: 'pinned', group: 'Selection', kind: 'numeric', available: true })
  // A dataset keyed by entity id or by type lends each of its other columns to the entities its rows match.
  if (ctx.store) {
    for (const d of datasetsIn(ctx.store)) {
      const key = keyColumnOf(d.data)
      if (!key || key.match === 'any') continue
      d.data.columns.forEach((c, i) => {
        if (i === key.index) return
        out.push({ ref: `dataset:${d.id}.${c.key}`, label: `${columnLabel(c)} (${d.label || 'dataset'}${key.match === 'type' ? ', by type' : ''})`, group: 'Datasets', kind: (c.kind ?? inferColumnKind(d.data, i)) === 'number' ? 'numeric' : 'categorical', available: true })
      })
    }
  }
  return out
}

/** Plain paths `getPath` understands are also valid refs; anything else must parse. */
export const isValidValueRef = (ref: string) => !!parseValueRef(ref) || /^(data|meta)\./.test(ref) || ref === 'description'

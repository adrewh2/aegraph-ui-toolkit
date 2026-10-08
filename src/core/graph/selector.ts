import type { EntityStore } from '../entity/store'
import type { TypeRegistry } from '../entity/typeRegistry'
import type { AnyEntity, EntityId } from '../entity/types'
import { hopsFrom, type Direction } from './algorithms'
import { datasetGraph } from './dataset'
import { matchPredicate, sortWithBlanksLast, type FieldPredicate } from './fields'
import type { GraphSlice } from './filter'
import { numericOf, valueOf, type ValueContext, type ValueRef } from './values'

/**
 * A Selector names a set of nodes the way a person would: "the documents",
 * "what I've selected", "nodes tagged x with more than 3 citations", "two
 * hops around these ids" — in the current view by default, or across the
 * whole dataset. Every tool that acts on nodes accepts one.
 */
export interface Selector {
  ids?: EntityId[]
  /** The explorer's current selection. */
  selection?: boolean
  types?: string[]
  tags?: string[]
  tagMode?: 'any' | 'all'
  text?: string
  /** Predicates on any ValueRef (all must hold). */
  fields?: FieldPredicate[]
  roots?: EntityId[]
  depth?: number
  direction?: Direction
  /** Default `view`: only nodes the filter currently shows. */
  scope?: 'view' | 'dataset'
  sort?: ValueRef
  desc?: boolean
  limit?: number
}

export interface SelectorContext {
  store: EntityStore
  registry: TypeRegistry
  slice: GraphSlice
  values: ValueContext
  selected?: Set<EntityId>
  /** Loaded project members (the Dataset stage), if any. */
  members?: Set<EntityId>
}

export interface SelectorResult {
  nodes: AnyEntity[]
  /** Matches before `limit`. */
  total: number
  /** Predicates that could not be evaluated (treated as passing). */
  skipped: FieldPredicate[]
  /** Under view scope: how many dataset matches the filter hides (hint to widen the scope or the filter). */
  outsideView: number
}

export function resolveSelector(sel: Selector, ctx: SelectorContext): SelectorResult {
  const scope = sel.scope ?? 'view'
  const base = scope === 'view' ? ctx.slice.nodes : datasetGraph(ctx.store, ctx.registry, ctx.members).nodes
  const baseIds = new Set(base.map((n) => n.id))
  const wanted = sel.ids ? new Set(sel.ids) : undefined
  const selection = sel.selection ? (ctx.selected ?? new Set<EntityId>()) : undefined
  const types = sel.types?.length ? new Set(sel.types) : undefined
  const tags = sel.tags?.length ? sel.tags : undefined
  const text = sel.text?.trim().toLowerCase() || undefined
  const skipped: FieldPredicate[] = []
  const fields = (sel.fields ?? []).filter((p) => {
    if (!p.path) return false
    const computed = !/^(data|meta)\./.test(p.path) && !['label', 'type', 'id', 'tags', 'description'].includes(p.path)
    if (computed && p.path.startsWith('metric.') && !ctx.values.metrics) {
      skipped.push(p)
      return false
    }
    return true
  })

  const matches = (n: AnyEntity) => {
    if (wanted && !wanted.has(n.id)) return false
    if (selection && !selection.has(n.id)) return false
    if (types && !types.has(n.type)) return false
    if (tags && !(sel.tagMode === 'all' ? tags.every((t) => n.tags.includes(t)) : tags.some((t) => n.tags.includes(t)))) return false
    if (text && !`${n.label ?? ''}\n${n.description ?? ''}\n${n.id}`.toLowerCase().includes(text) && !JSON.stringify(n.data).toLowerCase().includes(text)) return false
    for (const p of fields) if (!matchPredicate(n, p, ctx.values)) return false
    return true
  }

  let nodes = base.filter(matches)
  if (sel.roots?.length) {
    const edges = scope === 'view' ? ctx.slice.edges : datasetGraph(ctx.store, ctx.registry, ctx.members).edges
    const keep = hopsFrom(sel.roots, baseIds, edges, sel.depth ?? 1, sel.direction ?? 'both')
    nodes = nodes.filter((n) => keep.has(n.id))
  }
  let outsideView = 0
  if (scope === 'view') {
    // Count dataset matches the filter hides, so a tool can say "12 more exist but are filtered out".
    // (Not "when the counts differ": a project of three members and a view of three other nodes are not the same set.)
    const all = datasetGraph(ctx.store, ctx.registry, ctx.members).nodes
    for (const n of all) if (!baseIds.has(n.id) && matches(n)) outsideView++
  }
  if (sel.sort) {
    const ref = sel.sort
    const numeric = nodes.every((n) => {
      const v = valueOf(n, ref, ctx.values)
      return v === undefined || typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
    })
    const keyed = nodes.map((n) => ({ n, k: numeric ? numericOf(n, ref, ctx.values) : (valueOf(n, ref, ctx.values) ?? '') }))
    nodes = sortWithBlanksLast(keyed, !!sel.desc).map((k) => k.n)
  }
  const total = nodes.length
  if (sel.limit && sel.limit > 0) nodes = nodes.slice(0, sel.limit)
  return { nodes, total, skipped, outsideView }
}

export function describeSelector(sel: Selector): string {
  const parts: string[] = []
  if (sel.selection) parts.push('selection')
  if (sel.ids?.length) parts.push(`${sel.ids.length} ids`)
  if (sel.types?.length) parts.push(sel.types.join('/'))
  if (sel.tags?.length) parts.push(`#${sel.tags.join(sel.tagMode === 'all' ? ' & #' : ' #')}`)
  if (sel.text) parts.push(`“${sel.text}”`)
  for (const p of sel.fields ?? []) parts.push(`${p.path} ${p.op} ${p.value === undefined ? '' : JSON.stringify(p.value)}`.trim())
  if (sel.roots?.length) parts.push(`${sel.depth ?? 1} hops from ${sel.roots.length}`)
  if (sel.scope === 'dataset') parts.push('in dataset')
  if (sel.sort) parts.push(`by ${sel.sort}${sel.desc ? ' desc' : ''}`)
  if (sel.limit) parts.push(`top ${sel.limit}`)
  return parts.length ? parts.join(' · ') : 'everything in view'
}

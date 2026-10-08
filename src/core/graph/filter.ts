import type { EntityStore } from '../entity/store'
import type { TypeRegistry } from '../entity/typeRegistry'
import type { AnyEntity, EntityId, Relationship } from '../entity/types'
import { connectedComponents, degreesOf, kCore, type Direction } from './algorithms'
import { backboneEdges, type BackboneMode } from './backbone'
import { describePredicate, matchPredicate, type FieldPredicate } from './fields'
import type { FilterData } from './types'
import { isPlainRef, refIsStateful, refUsesMetrics, type ValueContext } from './values'

export interface FilterContext {
  /** Dataset-stage values for computed predicate paths (degree…) and project overlays. */
  values?: ValueContext
  /** The Dataset stage is a loaded project: only these entity ids exist. */
  members?: Set<EntityId>
}

export interface FilterSpec {
  types?: string[]
  relationshipTypes?: string[]
  /** Keep only nodes carrying any (or all) of these tags. */
  tags?: string[]
  tagMode?: 'any' | 'all'
  /** Drop nodes carrying any of these tags — the unchecked rows of the tag checklist. */
  excludeTags?: string[]
  /** Keep only relationships carrying any of these tags — `tags` is about nodes, this is about the edges between them. */
  edgeTags?: string[]
  text?: string
  minDegree?: number
  hideIsolated?: boolean
  roots?: EntityId[]
  depth?: number
  maxNodes?: number
  /** Degree ceiling within the slice; 0 = off. */
  maxDegree?: number
  /** Keep only the k-core; 0 = off. */
  kCore?: number
  /**
   * Thin the edges to the ones that carry the structure before anything is drawn (see `core/graph/backbone.ts`):
   * `disparity` (Serrano et al., significance `backboneAlpha`), `simmelian` (each node's `backboneK` most embedded
   * edges) or `spanning` (the maximum spanning forest). Off when absent.
   */
  backbone?: BackboneMode
  /** disparity: the significance level, 0.01 (severe) … 0.5 (gentle). Default 0.05. */
  backboneAlpha?: number
  /** simmelian: edges kept per node. Default 3. */
  backboneK?: number
  /** Where an edge's weight lives, e.g. `data.score`; absent, every edge weighs 1. */
  weightField?: string
  /** Drop connected components smaller than this; 0/1 = off. */
  componentMin?: number
  /** Keep only the largest component. */
  giantOnly?: boolean
  /** Nodes hidden by hand. */
  exclude?: EntityId[]
  /** Nodes brought in by hand — linked entities added from the view — kept whatever the checklists and the neighbourhood say. */
  include?: EntityId[]
  /** Keep only these nodes — a list handed over from a table (its rows), a selection opened in a new graph, or what a filter script returned. Relationships in the list are drawn when both ends are. */
  only?: EntityId[]
  /** The filter script `only` came from (a `script` entity of kind filter): the panel names it and can run it again; cleared with `only`. */
  script?: EntityId
  /** Attribute predicates, all of which must hold. */
  fields?: FieldPredicate[]
  /** Which way the neighbourhood expands from the roots. */
  direction?: Direction
}

/** The cap is a safety net, not a budget: the view budget (LargeGraphGate) is what asks before a big draw. */
export const DEFAULT_MAX_NODES = 20000

export const emptyFilter = (): FilterSpec => ({
  types: [],
  relationshipTypes: [],
  edgeTags: [],
  tags: [],
  tagMode: 'any',
  excludeTags: [],
  text: '',
  minDegree: 0,
  hideIsolated: false,
  roots: [],
  depth: 1,
  maxNodes: DEFAULT_MAX_NODES,
  maxDegree: 0,
  kCore: 0,
  componentMin: 0,
  giantOnly: false,
  exclude: [],
  include: [],
  fields: [],
  direction: 'both',
})

export interface GraphSlice {
  nodes: AnyEntity[]
  edges: Relationship[]
  /** Degree within the slice. */
  degree: Map<EntityId, number>
  /** Nodes dropped by the cap. */
  truncated: number
  /** Total candidates before the cap. */
  candidates: number
  /** Connected components in the slice (after structural pruning). */
  components?: number
  /** Predicates that could not be evaluated (no metrics yet, or a stateful ref) and were treated as passing. */
  skipped?: FieldPredicate[]
}

/** Predicates a filter can't evaluate: metric refs (analysis comes after the filter), selection/pin refs (they'd oscillate), and structural refs without a context. */
export function splitPredicates(fields: FieldPredicate[] | undefined, ctx?: FilterContext): { usable: FieldPredicate[]; skipped: FieldPredicate[] } {
  const usable: FieldPredicate[] = []
  const skipped: FieldPredicate[] = []
  for (const p of fields ?? []) {
    if (!p.path) continue
    // Metric refs are never evaluated in a filter: a filter can't read this iteration's analysis (export a project instead).
    if (refIsStateful(p.path) || refUsesMetrics(p.path)) skipped.push(p)
    else if (isPlainRef(p.path) || /^(data|meta)\./.test(p.path) || p.path === 'description') usable.push(p)
    else if (!ctx?.values) skipped.push(p)
    else usable.push(p)
  }
  return { usable, skipped }
}

/** Value refs a filter needs beyond plain fields. */
export function filterComputedRefs(spec: FilterSpec): { metrics: string[]; structural: boolean } {
  const metrics: string[] = []
  let structural = false
  for (const p of spec.fields ?? []) {
    if (!p.path || isPlainRef(p.path) || /^(data|meta)\./.test(p.path)) continue
    if (refUsesMetrics(p.path)) metrics.push(p.path.slice(7))
    else if (p.path.startsWith('degree')) structural = true
  }
  return { metrics, structural }
}

/** Up to this many `only` ids, the candidates are those ids looked up; past it, the query and a filter. */
const ONLY_FROM_IDS = 200_000

/** Categories that never show up as graph nodes (schema definitions, presentation state). */
export const HIDDEN_CATEGORIES: ReadonlySet<string> = new Set(['schema', 'project'])

/**
 * The dataset's totals before any filter — the "y" of the filter panel's "x of y": entities by type (those that can
 * be nodes) and relationships by type. The store is scoped to the open project, so without `members` its cached
 * tallies answer; with them (the explorer's Dataset stage narrowed to a sub-project) one pass over the members does.
 */
export function datasetTotals(store: EntityStore, registry: TypeRegistry, members?: ReadonlySet<EntityId>): { types: Map<string, number>; rels: Map<string, number> } {
  const types = new Map<string, number>()
  const rels = new Map<string, number>()
  if (members) {
    for (const id of members) {
      const e = store.get(id)
      if (!e) continue
      if (e.kind === 'relationship') rels.set(e.type, (rels.get(e.type) ?? 0) + 1)
      else if (!HIDDEN_CATEGORIES.has(registry.categoryOf(e.type))) types.set(e.type, (types.get(e.type) ?? 0) + 1)
    }
    return { types, rels }
  }
  const c = store.countByTypeAndKind()
  for (const [t, n] of c.entities) if (!HIDDEN_CATEGORIES.has(registry.categoryOf(t))) types.set(t, n)
  for (const [t, n] of c.relationships) rels.set(t, n)
  return { types, rels }
}

/**
 * Evaluate a filter against the store. Order matters: text/type/tag/field
 * predicates and the exclude list narrow the node set, roots+depth restrict
 * to a neighbourhood, then edges are kept only when both endpoints survive,
 * then degree band / k-core / components prune, then the cap.
 */
export function applyFilter(store: EntityStore, registry: TypeRegistry, spec: FilterSpec, ctx?: FilterContext): GraphSlice {
  const types = spec.types?.length ? new Set(spec.types) : undefined
  const relTypes = spec.relationshipTypes?.length ? new Set(spec.relationshipTypes) : undefined
  const edgeTags = spec.edgeTags?.length ? new Set(spec.edgeTags) : undefined
  const tags = spec.tags?.length ? spec.tags : undefined
  const excludeTags = spec.excludeTags?.length ? new Set(spec.excludeTags) : undefined
  const text = spec.text?.trim() || undefined
  const excluded = spec.exclude?.length ? new Set(spec.exclude) : undefined
  const only = spec.only?.length ? new Set(spec.only) : undefined
  const { usable, skipped } = splitPredicates(spec.fields, ctx)
  const fields = usable.length ? usable : undefined
  const values = ctx?.values
  const members = ctx?.members

  // 1. Candidate nodes. A view of just these (`only` — a scene's nodes, a script's result) starts from them rather
  // than from every entity of the types asked (the atlas's scene is four thousand of a million: a query of the whole
  // project for each filter pass). Same test (`matches` is the query's own), same order (the query's: by type in the
  // order asked, then the store's).
  const query = { kind: 'entity' as const, text, type: types ? [...types] : undefined }
  let nodes: AnyEntity[]
  if (only && only.size <= ONLY_FROM_IDS) {
    const typeRank = query.type ? new Map(query.type.map((t, i) => [t, i])) : undefined
    const picked: { e: AnyEntity; rank: number; h: number }[] = []
    for (const id of only) {
      const e = store.get(id)
      if (e && store.matches(e, query)) picked.push({ e, rank: typeRank?.get(e.type) ?? 0, h: store.handleOf(id) ?? 0 })
    }
    picked.sort((a, b) => a.rank - b.rank || a.h - b.h)
    nodes = picked.map((p) => p.e)
  } else nodes = store.query(query)
  nodes = nodes.filter((e) => !HIDDEN_CATEGORIES.has(registry.categoryOf(e.type)))
  if (members) nodes = nodes.filter((e) => members.has(e.id))
  if (only) nodes = nodes.filter((e) => only.has(e.id))
  if (tags) nodes = nodes.filter((e) => (spec.tagMode === 'all' ? tags.every((t) => e.tags.includes(t)) : tags.some((t) => e.tags.includes(t))))
  if (excludeTags) nodes = nodes.filter((e) => !e.tags.some((t) => excludeTags.has(t)))
  if (fields) nodes = nodes.filter((e) => fields.every((p) => matchPredicate(e, p, values)))
  if (excluded) nodes = nodes.filter((e) => !excluded.has(e.id))

  // 2. Neighbourhood restriction.
  if (spec.roots?.length) {
    const allowed = new Set(nodes.map((n) => n.id))
    const keep = new Set<EntityId>()
    const direction = spec.direction ?? 'both'
    let frontier = spec.roots.filter((id) => store.has(id) && !excluded?.has(id))
    frontier.forEach((id) => keep.add(id))
    for (let d = 0; d < (spec.depth ?? 1); d++) {
      const next: EntityId[] = []
      for (const id of frontier) {
        for (const r of store.relationshipsOf(id)) {
          if (relTypes && !relTypes.has(r.type)) continue
          // Undirected relationships are traversable either way regardless of the requested direction.
          if (direction !== 'both' && r.directed && (direction === 'out' ? r.source.id !== id : r.target.id !== id)) continue
          const other = r.source.id === id ? r.target.id : r.source.id
          if (!keep.has(other) && allowed.has(other)) {
            keep.add(other)
            next.push(other)
          }
        }
      }
      frontier = next
    }
    // A root is the centre of the neighbourhood, not an exception to the checklists: one the type, tag or text
    // filters leave out stays out (its neighbours still come along), so unticking a type always hides that type.
    nodes = nodes.filter((n) => keep.has(n.id))
  }

  // 2b. Hand-picked additions: linked entities brought in from the view. They skip the checklists and the
  // neighbourhood (that is the point of adding them), but not the hidden list, the dataset, or the structural pruning below.
  if (spec.include?.length) {
    const have = new Set(nodes.map((n) => n.id))
    for (const id of spec.include) {
      if (have.has(id) || excluded?.has(id) || (members && !members.has(id))) continue
      const e = store.get(id)
      if (!e || e.kind !== 'entity' || HIDDEN_CATEGORIES.has(registry.categoryOf(e.type))) continue
      nodes.push(e)
      have.add(id)
    }
  }

  // 3. Edges between surviving nodes.
  let ids = new Set(nodes.map((n) => n.id))
  let edges = collectEdges(store, ids, relTypes, edgeTags)
  if (members) edges = edges.filter((e) => members.has(e.id))
  let degree = degreesOf(edges)
  const prune = (keep: Set<EntityId>) => {
    nodes = nodes.filter((n) => keep.has(n.id))
    ids = keep.size === nodes.length ? keep : new Set(nodes.map((n) => n.id))
    edges = edges.filter((r) => ids.has(r.source.id) && ids.has(r.target.id))
    degree = degreesOf(edges)
  }

  // 4. Backbone: the structural edges only, before degrees are judged — a node that keeps nothing is isolated,
  // which is what `hideIsolated` is for.
  if (spec.backbone) {
    edges = backboneEdges(edges, { mode: spec.backbone, alpha: spec.backboneAlpha, k: spec.backboneK, weightField: spec.weightField })
    degree = degreesOf(edges)
  }

  // 5. Degree band / isolation.
  const minDeg = Math.max(spec.minDegree ?? 0, spec.hideIsolated ? 1 : 0)
  const maxDeg = spec.maxDegree ?? 0
  if (minDeg > 0 || maxDeg > 0) {
    prune(new Set(nodes.filter((n) => (degree.get(n.id) ?? 0) >= minDeg && (maxDeg <= 0 || (degree.get(n.id) ?? 0) <= maxDeg)).map((n) => n.id)))
  }

  // 6. k-core.
  if ((spec.kCore ?? 0) > 0) prune(kCore(ids, edges, spec.kCore!))

  // 7. Components.
  let components: number | undefined
  if (spec.giantOnly || (spec.componentMin ?? 0) > 1) {
    const comps = connectedComponents(ids, edges)
    const kept = spec.giantOnly ? comps.slice(0, 1) : comps.filter((c) => c.length >= (spec.componentMin ?? 0))
    components = kept.length
    prune(new Set(kept.flat()))
  }

  // 8. Cap, keeping the best-connected nodes.
  const candidates = nodes.length
  const cap = spec.maxNodes ?? DEFAULT_MAX_NODES
  let truncated = 0
  if (nodes.length > cap) {
    truncated = candidates - cap
    prune(new Set([...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, cap).map((n) => n.id)))
  }

  return { nodes, edges, degree, truncated, candidates, ...(components !== undefined ? { components } : {}), ...(skipped.length ? { skipped } : {}) }
}

function collectEdges(store: EntityStore, ids: Set<EntityId>, relTypes?: Set<string>, edgeTags?: Set<string>): Relationship[] {
  // Iterate the smaller side: if the node set is small, walk relationshipsOf; else scan all relationships.
  const out: Relationship[] = []
  const seen = new Set<EntityId>()
  if (ids.size * 4 < store.relationshipCount()) {
    for (const id of ids) {
      for (const r of store.relationshipsOf(id, 'out')) {
        if (seen.has(r.id)) continue
        if (relTypes && !relTypes.has(r.type)) continue
        if (edgeTags && !r.tags.some((t) => edgeTags.has(t))) continue
        if (ids.has(r.target.id)) {
          seen.add(r.id)
          out.push(r)
        }
      }
    }
  } else {
    for (const r of store.relationships()) {
      if (relTypes && !relTypes.has(r.type)) continue
      if (edgeTags && !r.tags.some((t) => edgeTags.has(t))) continue
      if (ids.has(r.source.id) && ids.has(r.target.id)) out.push(r)
    }
  }
  return out
}

/** Human summary for pickers and toolbars. */
export function describeFilter(spec: FilterSpec): string {
  const parts: string[] = []
  if (spec.types?.length) parts.push(`${spec.types.length} type${spec.types.length > 1 ? 's' : ''}`)
  if (spec.relationshipTypes?.length) parts.push(`${spec.relationshipTypes.length} rel. type${spec.relationshipTypes.length > 1 ? 's' : ''}`)
  if (spec.tags?.length) parts.push(`tags: ${spec.tags.join(spec.tagMode === 'all' ? ' & ' : ', ')}`)
  if (spec.excludeTags?.length) parts.push(`not tagged ${spec.excludeTags.join(', ')}`)
  if (spec.edgeTags?.length) parts.push(`links tagged ${spec.edgeTags.join(', ')}`)
  if (spec.text?.trim()) parts.push(`“${spec.text.trim()}”`)
  for (const p of spec.fields ?? []) if (p.path) parts.push(describePredicate(p))
  if (spec.roots?.length) parts.push(`${spec.depth ?? 1} hop${(spec.depth ?? 1) > 1 ? 's' : ''}${spec.direction === 'out' ? ' out' : spec.direction === 'in' ? ' in' : ''} from ${spec.roots.length}`)
  if ((spec.minDegree ?? 0) > 0) parts.push(`degree ≥ ${spec.minDegree}`)
  if ((spec.maxDegree ?? 0) > 0) parts.push(`degree ≤ ${spec.maxDegree}`)
  if (spec.hideIsolated) parts.push('no isolated')
  if (spec.backbone) parts.push(spec.backbone === 'disparity' ? `disparity backbone α=${spec.backboneAlpha ?? 0.05}` : spec.backbone === 'simmelian' ? `simmelian backbone k=${spec.backboneK ?? 3}` : 'spanning backbone')
  if ((spec.kCore ?? 0) > 0) parts.push(`${spec.kCore}-core`)
  if (spec.giantOnly) parts.push('giant component')
  else if ((spec.componentMin ?? 0) > 1) parts.push(`components ≥ ${spec.componentMin}`)
  if (spec.exclude?.length) parts.push(`${spec.exclude.length} hidden`)
  if (spec.include?.length) parts.push(`${spec.include.length} added`)
  if (spec.only?.length) parts.push(`just ${spec.only.length}${spec.script ? ' by script' : ''}`)
  return parts.length ? parts.join(' · ') : 'Everything'
}

export const isEmptyFilter = (spec: FilterSpec) => describeFilter(spec) === 'Everything'

/** Normalise whatever is stored in a filter entity into a full spec. */
export function toFilterSpec(data: Partial<FilterData> | undefined): FilterSpec {
  return { ...emptyFilter(), ...(data ?? {}) }
}

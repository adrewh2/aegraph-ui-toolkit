import { BarChart3, FolderKanban, Filter, LayoutGrid, LayoutTemplate, Palette, Shapes, SlidersHorizontal } from 'lucide-react'
import { SCHEMA_TYPE } from '../entity/categories'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { AnyEntity, EntityData, EntityId } from '../entity/types'
import type { FieldPredicate } from './fields'
import type { LayoutRule } from './placement'
import type { FilterSpec } from './filter'
import type { MetricsOptions, MetricsSummary } from './metrics/types'

/**
 * Graph-category types: presentation state stored as entities. A layout or a
 * rendering config is a *collection* — it refers to many other entities by
 * id but is itself one addressable, taggable, exportable thing.
 */

export const GRAPH_TYPES = {
  layout: 'layout',
  rendering: 'rendering',
  view: 'view',
  filter: 'filter',
  workstation: 'workstation',
  analysis: 'analysis',
  project: 'project',
} as const

/**
 * A project is an exported view: the members of a filtered slice, the
 * analysis values computed for them, and where it came from. Loading a
 * project makes it the Dataset stage of the next iteration, so analysis
 * results become data you can filter and lay out by.
 */
export interface ProjectData extends EntityData {
  /** Node and relationship ids in the exported view. */
  members: EntityId[]
  /** Materialised metric columns keyed by node id, exposed as `data.<metric>` while the project is loaded. */
  values?: Record<EntityId, Record<string, number>>
  parentProjectId?: EntityId
  filterId?: EntityId
  layoutId?: EntityId
  renderingId?: EntityId
  analysisId?: EntityId
  summary?: { nodes: number; edges: number; metrics: string[] }
}

/** Computed metrics for a slice, stored columnar (JSON-safe) so they reload without recomputation. */
export interface AnalysisData extends EntityData {
  computedAt: string
  sliceKey: string
  filterId?: EntityId
  filter?: FilterSpec
  options: MetricsOptions
  ids: EntityId[]
  columns: Record<string, number[]>
  summary: MetricsSummary
  communities?: { count: number; sizes: number[] }
}

export interface Position {
  x: number
  y: number
  z?: number
}

export interface LayoutData extends EntityData {
  /** Positions keyed by entity id. Missing ids simply aren't placed. */
  positions: Record<EntityId, Position>
  /** Optional per-entity sizes. */
  sizes?: Record<EntityId, number>
  /** How the positions were produced: 'manual', 'radial', 'force', an algorithm name, … */
  algorithm?: string
  dimensions?: 2 | 3
  /** Nodes held in place by force layouts. */
  pinned?: EntityId[]
  /** How the positions were derived, when they came from a placement; lets the layout be recomputed from data. */
  rule?: LayoutRule
  /** The layout script these positions came from (algorithm `script`); running it again updates this layout. */
  source?: { scriptId: EntityId; label?: string; ranAt: string }
}

export type { RenderingData, RenderingSpec, NodeRule, EdgeRule } from './rendering'

/** What's in scope for a graph view. Saved independently of layouts; the two compose freely. */
export interface FilterData extends EntityData {
  /** Entity types to include. Empty = all. */
  types?: string[]
  /** Relationship types to include. Empty = all. */
  relationshipTypes?: string[]
  /** Tags an entity must carry (any / all). Empty = no constraint. */
  tags?: string[]
  tagMode?: 'any' | 'all'
  /** Full-text match on label/description/data. */
  text?: string
  /** Only entities with at least this many relationships (in the filtered graph). */
  minDegree?: number
  /** Drop isolated nodes after edge filtering. */
  hideIsolated?: boolean
  /** Restrict to the neighbourhood of these roots, up to `depth` hops. */
  roots?: EntityId[]
  depth?: number
  /** Hard cap; the view truncates (highest degree first) beyond this. */
  maxNodes?: number
  maxDegree?: number
  kCore?: number
  componentMin?: number
  giantOnly?: boolean
  exclude?: EntityId[]
  /** Nodes brought in by hand, kept whatever the other criteria say. */
  include?: EntityId[]
  /** Keep only these: a table's rows, a selection opened in a new graph, or what a filter script returned. */
  only?: EntityId[]
  /** The filter script `only` came from, so a saved filter can run it again. */
  script?: EntityId
  fields?: FieldPredicate[]
  direction?: 'out' | 'in' | 'both'
}

export interface ViewData extends EntityData {
  /** Which layout and rendering to use, by entity id. */
  layoutId?: EntityId
  renderingId?: EntityId
  /** Which entities are in scope: explicit ids, or a query. */
  members?: EntityId[]
  query?: { types?: string[]; tags?: string[]; text?: string }
  renderer?: 'force-2d' | 'force-3d' | 'table' | 'tree'
}

const memberCount = (_value: unknown, e: AnyEntity) => {
  const d = e.data
  if (d.positions && typeof d.positions === 'object') return String(Object.keys(d.positions as object).length)
  if (Array.isArray(d.members)) return String(d.members.length)
  if (d.nodes && typeof d.nodes === 'object') {
    const n = d.nodes as { types?: object; tags?: object }
    const ed = (d.edges ?? {}) as { types?: object; tags?: object }
    return String(Object.keys(n.types ?? {}).length + Object.keys(n.tags ?? {}).length + Object.keys(ed.types ?? {}).length + Object.keys(ed.tags ?? {}).length)
  }
  return ''
}

export const layoutType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.layout,
  label: 'Layout',
  pluralLabel: 'Layouts',
  category: 'project',
  icon: LayoutGrid,
  color: '#0ea5e9',
  description: 'Positions (and optionally sizes) for a set of entities. The same entities can have many layouts.',
  fields: [
    { key: 'data.algorithm', label: 'Algorithm', kind: 'text', editable: true, width: 120 },
    { key: 'data.dimensions', label: 'Dims', kind: 'number', width: 60 },
    { key: 'data.positions', label: 'Placed', kind: 'json', width: 80, format: memberCount },
  ],
})

export const renderingType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.rendering,
  label: 'Rendering',
  pluralLabel: 'Rendering configs',
  category: 'project',
  icon: Palette,
  color: '#a855f7',
  description: 'Colors, visibility, sizes and shapes keyed by type or tag — the legend of a graph view.',
  fields: [
    { key: 'data.precedence', label: 'Precedence', kind: 'text', editable: true, width: 100 },
    { key: 'data.nodes', label: 'Rules', kind: 'json', width: 80, format: memberCount },
    { key: 'data.sizing', label: 'Sizing', kind: 'json', width: 120, format: (v) => (v && typeof v === 'object' ? String((v as { by?: string }).by ?? '') : '') },
  ],
})

export const viewType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.view,
  label: 'View',
  pluralLabel: 'Views',
  category: 'project',
  icon: SlidersHorizontal,
  color: '#14b8a6',
  description: 'A saved arrangement: which entities, which layout, which rendering, which renderer.',
  fields: [
    { key: 'data.renderer', label: 'Renderer', kind: 'text', editable: true, width: 100 },
    { key: 'data.layoutId', label: 'Layout', kind: 'ref', width: 160 },
    { key: 'data.renderingId', label: 'Rendering', kind: 'ref', width: 160 },
    { key: 'data.members', label: 'Members', kind: 'json', width: 80, format: memberCount },
  ],
})

export const filterType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.filter,
  label: 'Filter',
  pluralLabel: 'Filters',
  category: 'project',
  icon: Filter,
  color: '#f97316',
  description: 'A saved scope for graph views: which types, relationship types, tags, text, and neighbourhood are in view.',
  fields: [
    { key: 'data.types', label: 'Types', kind: 'json', width: 160, format: (v) => (Array.isArray(v) && v.length ? `${v.length} types` : 'all') },
    { key: 'data.relationshipTypes', label: 'Rel. types', kind: 'json', width: 100, format: (v) => (Array.isArray(v) && v.length ? `${v.length}` : 'all') },
    { key: 'data.tags', label: 'Tags', kind: 'tags', width: 160 },
    { key: 'data.text', label: 'Text', kind: 'text', editable: true, width: 140 },
    { key: 'data.maxNodes', label: 'Max nodes', kind: 'number', editable: true, width: 90 },
  ],
})

export const workstationType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.workstation,
  label: 'Workstation',
  pluralLabel: 'Workstations',
  category: 'project',
  icon: LayoutTemplate,
  color: '#6366f1',
  description: 'A saved arrangement of split panes and the view tabs in each — the workspace itself as information.',
  fields: [{ key: 'data.root', label: 'Panes', kind: 'json', width: 80, format: (v) => String(countPanes(v)) }],
})

function countPanes(n: unknown): number {
  if (!n || typeof n !== 'object') return 0
  const node = n as { kind?: string; children?: unknown[] }
  if (node.kind === 'pane') return 1
  return (node.children ?? []).reduce<number>((s, c) => s + countPanes(c), 0)
}

/** The ontology's own type: a definition that gives a type its label, category, parent, and color. */
export const schemaTypeDef: EntityTypeDef = defineEntityType({
  type: SCHEMA_TYPE,
  label: 'Type definition',
  pluralLabel: 'Type definitions',
  category: 'schema',
  icon: Shapes,
  color: '#64748b',
  description: 'Describes an entity type so vocabulary travels with the data.',
  fields: [
    { key: 'data.name', label: 'Type', kind: 'text', required: true, width: 140 },
    { key: 'data.category', label: 'Category', kind: 'text', editable: true, width: 100 },
    { key: 'data.parent', label: 'Parent', kind: 'text', editable: true, width: 120 },
    { key: 'data.color', label: 'Color', kind: 'color', editable: true, width: 110 },
  ],
})

export const analysisType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.analysis,
  label: 'Analysis',
  pluralLabel: 'Analyses',
  category: 'project',
  icon: BarChart3,
  color: '#e11d48',
  description: 'Computed metrics for a graph view — centrality, communities, components — keyed by entity id.',
  fields: [
    { key: 'data.computedAt', label: 'Computed', kind: 'date', width: 140 },
    { key: 'data.ids', label: 'Nodes', kind: 'json', width: 80, format: (v) => (Array.isArray(v) ? String(v.length) : '') },
    { key: 'data.columns', label: 'Metrics', kind: 'json', width: 220, format: (v) => Object.keys((v as object) ?? {}).join(', ') },
    { key: 'data.summary', label: 'Modularity', kind: 'json', width: 90, format: (v) => (typeof (v as { modularity?: number })?.modularity === 'number' ? (v as { modularity: number }).modularity.toFixed(3) : '') },
  ],
})

export const projectType: EntityTypeDef = defineEntityType({
  type: GRAPH_TYPES.project,
  label: 'Project',
  pluralLabel: 'Projects',
  category: 'project',
  icon: FolderKanban,
  color: '#0f766e',
  description: 'A named scope over the Library: the entities marked with it and the views built on them. The pipeline\'s exported views are projects too, with an explicit member list and their analysis values, loadable as the dataset of the next iteration.',
  fields: [
    { key: 'data.members', label: 'Members', kind: 'json', width: 80, format: (v) => (Array.isArray(v) ? String(v.length) : '') },
    { key: 'data.summary', label: 'Metrics', kind: 'json', width: 200, format: (v) => ((v as { metrics?: string[] })?.metrics ?? []).join(', ') },
    { key: 'data.parentProjectId', label: 'Parent', kind: 'ref', width: 160 },
    { key: 'data.filterId', label: 'Filter', kind: 'ref', width: 140 },
  ],
})

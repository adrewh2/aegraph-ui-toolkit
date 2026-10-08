import { FIELD_OPS, type FieldPredicate } from '../../core/graph/fields'
import type { Selector } from '../../core/graph/selector'

/** JSON-schema fragments and converters shared by every tool that names values or nodes. */
export const VALUE_REF_HELP = 'ValueRefs: data.<key> · meta.updatedAt|createdAt|accessedAt (epoch ms) · label · type · id · tags · metric.<id> · degree · degree.in · degree.out · degree[.in|.out]:<relationshipType> (e.g. degree.in:cites) · selected · pinned · dataset:<dataset id>.<column> (a dataset\'s column on the entity its row matches — by the dataset\'s id column, else its type column — so a table of counts per type colours each entity by its type\'s count).'

export const FIELD_PREDICATE_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string', description: 'A ValueRef' }, op: { type: 'string', enum: FIELD_OPS.map((o) => o.id) }, value: { description: 'Scalar; [lo, hi] for between; list for in; omitted for exists' } },
  required: ['path', 'op'],
  additionalProperties: false,
} as const

/** How tools name a set of nodes. */
export const SELECTOR_SCHEMA = {
  type: 'object',
  description: 'Which nodes: any combination of ids, the current selection, types, tags, text, predicates on ValueRefs, roots+depth; in the view (default) or the whole dataset; optionally sorted/limited.',
  properties: {
    ids: { type: 'array', items: { type: 'string' } },
    selection: { type: 'boolean', description: 'The explorer\'s current selection' },
    types: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    tag_mode: { type: 'string', enum: ['any', 'all'] },
    text: { type: 'string' },
    fields: { type: 'array', items: FIELD_PREDICATE_SCHEMA },
    roots: { type: 'array', items: { type: 'string' } },
    depth: { type: 'integer', minimum: 1 },
    direction: { type: 'string', enum: ['out', 'in', 'both'] },
    scope: { type: 'string', enum: ['view', 'dataset'], description: 'view (default): only nodes the filter shows; dataset: everything in the Dataset stage' },
    sort: { type: 'string', description: 'ValueRef to sort by' },
    desc: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
} as const

export const selectorFrom = (s: { ids?: string[]; selection?: boolean; types?: string[]; tags?: string[]; tag_mode?: 'any' | 'all'; text?: string; fields?: readonly { path: string; op: string; value?: unknown }[]; roots?: string[]; depth?: number; direction?: 'out' | 'in' | 'both'; scope?: 'view' | 'dataset'; sort?: string; desc?: boolean; limit?: number }): Selector => ({
  ids: s.ids,
  selection: s.selection,
  types: s.types,
  tags: s.tags,
  tagMode: s.tag_mode,
  text: s.text,
  fields: s.fields as FieldPredicate[] | undefined,
  roots: s.roots,
  depth: s.depth,
  direction: s.direction,
  scope: s.scope,
  sort: s.sort,
  desc: s.desc,
  limit: s.limit,
})


/**
 * A dataset from entities: the rows are the entities, the columns their
 * fields — what the Entities table shows, kept as a table of values. The
 * way to say "put all the trees into a dataset" without a script in
 * between (a script's sandbox is handed the whole dataset, which a city's
 * worth of entities is too much for; this reads the store directly).
 *
 * Columns, by default: `id`, `label`, `type`, `tags`, `description` (when
 * any row has one), then every property the rows' types declare — hidden
 * ones included, since a table wants the coordinates a map hides — in the
 * order the types come. Given `columns` (field keys or `data.x` paths)
 * instead, just those. A cell is the field's value as it is; a column's
 * kind follows the property's. A column may also be a computed ValueRef —
 * `degree`, `degree.in:cites`, `metric.pagerank`, `dataset:<id>.<column>` —
 * read through the value context the caller passes.
 *
 * Or counted: `datasetCountsFromEntities` makes one row per value of a
 * ValueRef (a type, a tag, a data field) with how many entities carry it —
 * "entity types and how many of each" as a table.
 */
import { displayLabel } from '../entity/entity'
import { getField, type FieldDef, type FieldKind } from '../entity/schema'
import type { TypeRegistry } from '../entity/typeRegistry'
import type { AnyEntity } from '../entity/types'
import { describeValueRef, isPlainRef, parseValueRef, valueOf, type ValueContext, type ValueRef } from '../graph/values'
import { datasetEntity, inferColumnKind, type ColumnKind, type DatasetColumn, type DatasetData, type DatasetEntity, type DatasetInit, type DatasetSource } from './dataset'

/** A column kind for a property's kind: what the grid can read and edit; the rest is text or JSON. */
export function columnKindOf(kind: FieldKind | undefined): ColumnKind | undefined {
  switch (kind) {
    case 'text':
    case 'longtext':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'url':
    case 'json':
      return kind === 'longtext' ? 'text' : kind
    case 'image':
    case 'color':
      return 'text'
    case 'tags':
      return 'json'
    default:
      return undefined
  }
}

/** The columns a set of entities gets: the top fields, then the types' declared properties in order of the types' first appearance. */
export function columnsForEntities(registry: TypeRegistry, entities: AnyEntity[], keys?: string[]): { columns: DatasetColumn[]; paths: string[] } {
  const paths: string[] = []
  const columns: DatasetColumn[] = []
  const taken = new Set<string>()
  const add = (path: string, label: string | undefined, kind: ColumnKind | undefined, description?: string) => {
    if (paths.includes(path)) return
    // A column's key is the path's last segment (`dbh`, not `data.dbh`), unless that is taken — then the path.
    const short = path.split('.').pop()!
    const key = taken.has(short) ? path : short
    taken.add(key)
    paths.push(path)
    columns.push({ key, ...(label && label !== key ? { label } : {}), ...(kind ? { kind } : {}), ...(description ? { description } : {}) })
  }
  if (keys?.length) {
    const fieldsByPath = new Map<string, FieldDef>()
    for (const t of new Set(entities.map((e) => e.type))) for (const f of registry.fieldsFor(t)) fieldsByPath.set(f.key, f)
    for (const k of keys) {
      const f = fieldsByPath.get(k)
      if (!f && isComputedRef(k)) {
        // A computed value (degree, a metric, a dataset's column) keyed as one word: degree.in:cites → degree_in_cites.
        const key = k.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
        if (paths.includes(k)) continue
        taken.add(key)
        paths.push(k)
        columns.push({ key, label: describeValueRef(k) })
        continue
      }
      add(k, f?.label, columnKindOf(f?.kind) ?? (k === 'tags' ? 'json' : undefined), f?.description)
    }
    return { columns, paths }
  }
  add('id', 'Id', 'text')
  add('label', 'Label', 'text')
  add('type', 'Type', 'text')
  add('tags', 'Tags', 'json')
  if (entities.some((e) => e.description)) add('description', 'Description', 'text')
  for (const t of new Set(entities.map((e) => e.type))) {
    for (const f of registry.fieldsFor(t)) {
      if (!f.key.startsWith('data.') || f.kind === 'ref-type') continue
      add(f.key, f.label, columnKindOf(f.kind), f.description)
    }
  }
  return { columns, paths }
}

/** A ValueRef that is not a field on the entity itself: degree, a metric, a dataset's column. */
const isComputedRef = (k: string) => !!parseValueRef(k) && !isPlainRef(k)

/** The dataset's data for entities: one row each, cells by column path (a computed ValueRef read through `values`). */
export function datasetDataFromEntities(registry: TypeRegistry, entities: AnyEntity[], opts: { columns?: string[]; source?: DatasetSource; values?: ValueContext } = {}): DatasetData {
  const { columns, paths } = columnsForEntities(registry, entities, opts.columns)
  const computed = paths.map((p) => isComputedRef(p))
  if (computed.some(Boolean) && !opts.values) throw new Error(`${paths.filter((_, i) => computed[i]).join(', ')} need a value context.`)
  const rows = new Array<unknown[]>(entities.length)
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    const row = new Array<unknown>(paths.length)
    for (let c = 0; c < paths.length; c++) {
      const p = paths[c]
      const v = computed[c] ? valueOf(e, p, opts.values!) : p === 'label' ? displayLabel(e) : getField(e, p)
      row[c] = v === undefined ? null : v
    }
    rows[i] = row
  }
  // A column whose property declares no kind gets one read off a sample of the values, so the page does not scan a
  // city's worth of rows per column to find out.
  const sample = rows.length > 2000 ? rows.slice(0, 2000) : rows
  for (let c = 0; c < columns.length; c++) if (!columns[c].kind) columns[c] = { ...columns[c], kind: inferColumnKind({ columns, rows: sample }, c) }
  return { columns, rows, ...(opts.source ? { source: opts.source } : {}) }
}

/** A dataset entity from entities. */
export function datasetFromEntities(registry: TypeRegistry, entities: AnyEntity[], init: DatasetInit & { columns?: string[]; values?: ValueContext }): DatasetEntity {
  const source: DatasetSource = init.source ?? { kind: 'entities', at: new Date().toISOString(), count: entities.length }
  const { columns, values, ...rest } = init
  return datasetEntity(datasetDataFromEntities(registry, entities, { columns, source, values }), { ...rest, source })
}

/**
 * How many entities carry each value of `groupBy`: one row per value, most first. The first column is named for what
 * was counted — `type` (with the type's `label` beside it), `tag` (each tag of an entity counts once), or the field —
 * so a dataset of counts per type is keyed by type, and `dataset:<id>.count` reads each entity's type's count.
 */
export function datasetCountsFromEntities(registry: TypeRegistry, entities: AnyEntity[], groupBy: ValueRef, values: ValueContext): DatasetData {
  const p = parseValueRef(groupBy)
  if (!p) throw new Error(`Cannot group by "${groupBy}": not a ValueRef.`)
  const counts = new Map<string, number>()
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  let missing = 0
  for (const e of entities) {
    if (p.kind === 'tags') {
      if (!e.tags.length) missing++
      for (const t of new Set(e.tags)) bump(t)
      continue
    }
    const v = valueOf(e, p, values)
    if (v === undefined || v === '') missing++
    else bump(String(v))
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (p.kind === 'type')
    return { columns: [{ key: 'type', label: 'Type', kind: 'text' }, { key: 'label', label: 'Label', kind: 'text' }, { key: 'count', label: 'Count', kind: 'number' }], rows: rows.map(([t, n]) => [t, registry.get(t).label, n]) }
  const key = p.kind === 'tags' ? 'tag' : p.kind === 'data' ? p.key.replace(/[^A-Za-z0-9]+/g, '_') : groupBy.replace(/[^A-Za-z0-9]+/g, '_')
  const out: DatasetData = { columns: [{ key, label: p.kind === 'tags' ? 'Tag' : describeValueRef(groupBy) }, { key: 'count', label: 'Count', kind: 'number' }], rows: rows.map(([k, n]) => [k, n]) }
  out.columns[0] = { ...out.columns[0], kind: inferColumnKind(out, 0) }
  if (missing) out.rows.push([null, missing])
  return out
}

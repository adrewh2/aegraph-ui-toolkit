/**
 * A dataset read against entities. Two directions, one rule for matching:
 *
 * - **A column on an entity** — the ValueRef `dataset:<id>.<column>`: the
 *   value in that column of the row that matches the entity. So a table of
 *   counts per type colours every node by its type's count, and a table of
 *   scores per entity sizes each node by its score, in Unigraph, a chart or
 *   a filter, with nothing copied onto the entities.
 * - **The rows as entities** — what a chart drawn from a dataset plots: one
 *   row each, its cells as `data.<column>`, so every axis, colour and group
 *   is a ValueRef as it is over entities.
 *
 * A row matches an entity by the dataset's **key column**: a column keyed
 * `id` holds entity ids; else one keyed `type` holds entity types (a table
 * per type); else the first column, matched against the entity's id, then
 * its type, then its label.
 *
 * Indexes are built once per dataset version (an edit is a new entity
 * object) and held weakly, so a colour channel over many nodes costs one
 * map lookup each.
 */
import { displayLabel } from '../entity/entity'
import type { EntityStore } from '../entity/store'
import type { AnyEntity, Entity, EntityId } from '../entity/types'
import type { ValueRefInfo } from '../graph/values'
import { columnLabel, inferColumnKind, isDataset, type DatasetData, type DatasetEntity } from './dataset'

export const DATASET_REF_PREFIX = 'dataset:'

/** `dataset:<id>.<column>` — the ref reading a dataset's column on the entity its row matches. */
export const datasetRef = (datasetId: EntityId, column: string) => `${DATASET_REF_PREFIX}${datasetId}.${column}`

/** The dataset id and column of a `dataset:<id>.<column>` ref (ids hold no dot; a column key may). */
export function parseDatasetRef(ref: string): { dataset: EntityId; column: string } | undefined {
  const m = /^dataset:([^.\s]+)\.(.+)$/.exec(ref.trim())
  return m ? { dataset: m[1], column: m[2] } : undefined
}

export type KeyMatch = 'id' | 'type' | 'any'

/** Which column rows are matched by, and against what on the entity. */
export function keyColumnOf(data: DatasetData): { index: number; match: KeyMatch } | undefined {
  if (!data.columns.length) return undefined
  const id = data.columns.findIndex((c) => c.key === 'id')
  if (id >= 0) return { index: id, match: 'id' }
  const type = data.columns.findIndex((c) => c.key === 'type')
  if (type >= 0) return { index: type, match: 'type' }
  return { index: 0, match: 'any' }
}

/** A column by key, else by label (case aside), else -1. */
export function columnIndexOf(data: DatasetData, column: string): number {
  const byKey = data.columns.findIndex((c) => c.key === column)
  if (byKey >= 0) return byKey
  const lower = column.toLowerCase()
  return data.columns.findIndex((c) => columnLabel(c).toLowerCase() === lower)
}

interface Index {
  match: KeyMatch
  rows: Map<string, number>
  columns: Map<string, number>
}
const indexes = new WeakMap<DatasetEntity, Index | null>()

function indexOf(e: DatasetEntity): Index | null {
  let ix = indexes.get(e)
  if (ix !== undefined) return ix
  const key = keyColumnOf(e.data)
  if (!key) ix = null
  else {
    const rows = new Map<string, number>()
    e.data.rows.forEach((r, i) => {
      const v = r[key.index]
      // The first row with a key wins, as a lookup table reads.
      if (v !== null && v !== undefined && v !== '' && !rows.has(String(v))) rows.set(String(v), i)
    })
    ix = { match: key.match, rows, columns: new Map() }
  }
  indexes.set(e, ix)
  return ix
}

/** The row of `e` that matches `node`, by the key column. */
export function matchRow(e: DatasetEntity, node: AnyEntity): number | undefined {
  const ix = indexOf(e)
  if (!ix) return undefined
  if (ix.match === 'id') return ix.rows.get(node.id)
  if (ix.match === 'type') return ix.rows.get(node.type)
  return ix.rows.get(node.id) ?? ix.rows.get(node.type) ?? ix.rows.get(displayLabel(node))
}

/** A cell as a value a scale can read: numbers and text as they are, true/false as text, nothing for empty or structured cells. */
function scalar(v: unknown): number | string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v === '' ? undefined : v
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.join(', ') : undefined
  return undefined
}

/** The dataset a ref names, if the store holds it. */
export function datasetOf(store: Pick<EntityStore, 'get'>, id: EntityId): DatasetEntity | undefined {
  const e = store.get(id)
  return isDataset(e) ? e : undefined
}

/** `dataset:<id>.<column>` read on one entity: the cell of the matching row, or undefined. */
export function datasetValue(store: Pick<EntityStore, 'get'>, datasetId: EntityId, column: string, node: AnyEntity): number | string | undefined {
  const e = datasetOf(store, datasetId)
  if (!e) return undefined
  const ix = indexOf(e)
  if (!ix) return undefined
  let c = ix.columns.get(column)
  if (c === undefined) {
    c = columnIndexOf(e.data, column)
    ix.columns.set(column, c)
  }
  if (c < 0) return undefined
  const r = matchRow(e, node)
  return r === undefined ? undefined : scalar(e.data.rows[r][c])
}

/**
 * The rows of a dataset as entities, for a chart: `id` from the id column (else `<dataset>#<row>`), `label` from a
 * label or name column (else the first text column), `type` from the type column (else `row`), and every cell as
 * `data.<column key>`.
 */
export function datasetRowEntities(e: DatasetEntity): Entity[] {
  const { columns, rows } = e.data
  const at = (key: string) => columns.findIndex((c) => c.key === key)
  const id = at('id')
  const type = at('type')
  let label = at('label')
  if (label < 0) label = at('name')
  if (label < 0) label = columns.findIndex((_, i) => rows.some((r) => typeof r[i] === 'string'))
  const now = e.meta.updatedAt
  return rows.map((r, i) => {
    const data: Record<string, unknown> = {}
    columns.forEach((c, j) => (data[c.key] = r[j]))
    const text = (j: number) => (j >= 0 && r[j] !== null && r[j] !== undefined && r[j] !== '' ? String(r[j]) : undefined)
    return { kind: 'entity', id: text(id) ?? `${e.id}#${i}`, type: text(type) ?? 'row', label: text(label) ?? `Row ${i + 1}`, tags: [], data, meta: { createdAt: now, updatedAt: now } } satisfies Entity
  })
}

/** What a chart's pickers offer over a dataset's rows: its columns, each as the ref `rowRef` would make of it. */
export function datasetColumnRefs(data: DatasetData): ValueRefInfo[] {
  return data.columns.map((c, i) => ({ ref: rowRef(data, c.key)!, label: columnLabel(c), group: 'Data', kind: (c.kind ?? inferColumnKind(data, i)) === 'number' ? 'numeric' : 'categorical', available: true }))
}

/**
 * A chart's ref over a dataset's rows: a column named bare (`count`, or its label) reads that cell; `label`, `type`,
 * `id` and full refs (`data.count`) are left as they are.
 */
export function rowRef(data: DatasetData, ref: string | undefined): string | undefined {
  if (!ref || ref === 'label' || ref === 'type' || ref === 'id' || ref.includes('.')) return ref
  const c = columnIndexOf(data, ref)
  return c >= 0 ? `data.${data.columns[c].key}` : ref
}

import { Table2 } from 'lucide-react'
import { createEntity, displayLabel } from '../entity/entity'
import { defineEntityType, kindOfValue, parsePropertyValue, type EntityTypeDef, type FieldKind } from '../entity/schema'
import type { EntityStore } from '../entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityData, type EntityId } from '../entity/types'
import { CsvParser, csvEscape, restoreCell } from '../exchange/formats'

/**
 * Datasets: a table of values kept as one entity — what an analytics
 * script returns with `table(columns, rows)` and what a chart reads. Two
 * dimensions: `columns` name and describe the columns, `rows` are the
 * cells, row by row, in the columns' order. The flow is Scene → Script →
 * Dataset → Chart, and the dataset is the hand-off between the two halves:
 * a script scene (or the whole project) goes in, a script computes, the
 * table it returns is kept here — editable by hand on the Datasets page —
 * and the charts read it.
 *
 * Every function that changes a dataset is pure: it takes `DatasetData`
 * and returns a new one, so the page, the tool and the tests share the one
 * set of edits and the store sees one write per edit.
 */

export const DATASET_TYPE = 'dataset'

export type ColumnKind = Extract<FieldKind, 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'url' | 'json'>

export interface DatasetColumn {
  /** Unique within the dataset; what a chart or a script names a column by. */
  key: string
  /** The header; the key when absent. */
  label?: string
  /** How cells are read and edited; inferred from the values when absent. */
  kind?: ColumnKind
  description?: string
}

/**
 * Where a dataset's rows came from. A script dataset is rewritten when its script runs again; an entities dataset
 * remembers what it was made from (a selector's description) and how many rows that was.
 */
export type DatasetSource =
  | { kind: 'script'; scriptId: EntityId; ranAt: string; sceneId?: EntityId }
  | { kind: 'csv'; filename?: string; importedAt: string }
  | { kind: 'hand' }
  | { kind: 'entities'; at: string; count: number; selector?: string }
  /** A file read whole — attached to a chat or handed to the tool: its name, what it was read as, and for a workbook the sheet. */
  | { kind: 'file'; filename: string; format: DatasetFileFormat; sheet?: string; importedAt: string }

/** The files a dataset is read from: delimited text (with its separator), an Excel workbook, a Parquet file. */
export type DatasetFileFormat = 'csv' | 'tsv' | 'txt' | 'xlsx' | 'parquet'

export interface DatasetData extends EntityData {
  columns: DatasetColumn[]
  /** The cells: `rows[r][c]` is the value of column `columns[c]` in row `r`. Numbers, strings, booleans, null, or JSON. */
  rows: unknown[][]
  source?: DatasetSource
}

export type DatasetEntity = Entity<DatasetData>

/**
 * What a dataset was read from is its **subtype** — a child type of `dataset` in the ontology (`parent: 'dataset'`),
 * the way a script's kind is: a CSV (`dataset:csv`, a .csv file or CSV text), a TSV (`dataset:tsv`), delimited text
 * (`dataset:text`, a .txt read as a table), a sheet of an Excel workbook (`dataset:excel`) or a Parquet file
 * (`dataset:parquet`). A dataset a script returned, one made from entities or one typed by hand is a plain `dataset`.
 * Every list of datasets is the whole family (`DATASET_FAMILY`, `datasetsIn`) — never `ofType('dataset')` alone.
 */
export type DatasetSubtype = 'csv' | 'tsv' | 'text' | 'excel' | 'parquet'
export const DATASET_SUBTYPES: { id: DatasetSubtype; type: string; label: string; hint: string }[] = [
  { id: 'csv', type: 'dataset:csv', label: 'CSV', hint: 'Read from comma-separated values — a .csv file, or CSV text' },
  { id: 'tsv', type: 'dataset:tsv', label: 'TSV', hint: 'Read from a tab-separated .tsv file' },
  { id: 'text', type: 'dataset:text', label: 'Text', hint: 'Read from a .txt file as a table, with the separator it was given' },
  { id: 'excel', type: 'dataset:excel', label: 'Excel', hint: 'One sheet of an Excel workbook (.xlsx)' },
  { id: 'parquet', type: 'dataset:parquet', label: 'Parquet', hint: 'Read from a Parquet file' },
]
/** The type keys a dataset may carry: the root and its subtypes. */
export const DATASET_FAMILY: string[] = [DATASET_TYPE, ...DATASET_SUBTYPES.map((s) => s.type)]
export const isDatasetType = (type: string): boolean => DATASET_FAMILY.includes(type)
/** The kind a dataset's type says, or undefined for a plain `dataset`. */
export const datasetKindOf = (type: string): DatasetSubtype | undefined => DATASET_SUBTYPES.find((s) => s.type === type)?.id
const FILE_KIND: Record<DatasetFileFormat, DatasetSubtype> = { csv: 'csv', tsv: 'tsv', txt: 'text', xlsx: 'excel', parquet: 'parquet' }
/** The type a dataset from this source has: its file's kind, `dataset:csv` for CSV text, else plain `dataset`. */
export function datasetTypeOf(source: DatasetSource | undefined): string {
  const kind = source?.kind === 'file' ? FILE_KIND[source.format] : source?.kind === 'csv' ? 'csv' : undefined
  return DATASET_SUBTYPES.find((s) => s.id === kind)?.type ?? DATASET_TYPE
}

export const isDataset = (e: AnyEntity | undefined): e is DatasetEntity => !!e && !isRelationship(e) && isDatasetType(e.type) && Array.isArray((e.data as DatasetData).columns) && Array.isArray((e.data as DatasetData).rows)

export const datasetType: EntityTypeDef = defineEntityType({
  type: DATASET_TYPE,
  label: 'Dataset',
  pluralLabel: 'Datasets',
  category: 'project',
  icon: Table2,
  color: '#0d9488',
  description: 'A table of values: columns and rows, kept as one entity. What an analytics script returns as a table, edited on the Datasets page, read by charts.',
  fields: [
    { key: 'data.columns', label: 'Columns', kind: 'json', width: 80, format: (v) => (Array.isArray(v) ? String(v.length) : '') },
    { key: 'data.rows', label: 'Rows', kind: 'json', width: 80, format: (v) => (Array.isArray(v) ? v.length.toLocaleString('en-US') : '') },
    { key: 'data.source.kind', label: 'From', kind: 'text', width: 80, description: 'script (a script returned it), csv (pasted), file (a CSV, TSV, text, Excel or Parquet file read whole — attached to a chat, say), entities (the rows are entities, their fields the columns), hand (typed in)' },
    { key: 'data.source.filename', label: 'File', kind: 'text', width: 140, hidden: true },
    { key: 'data.source.scriptId', label: 'Script', kind: 'ref', width: 160, hidden: true },
    { key: 'data.source.ranAt', label: 'Ran', kind: 'datetime', width: 140, hidden: true },
  ],
})

/** The subtypes, defined under `dataset` so they inherit its columns and read as "Dataset · Excel" in tables. */
export const datasetSubtypeDefs: EntityTypeDef[] = DATASET_SUBTYPES.map((s) =>
  defineEntityType({
    type: s.type,
    parent: DATASET_TYPE,
    label: `${s.label} dataset`,
    pluralLabel: `${s.label} datasets`,
    category: 'project',
    icon: Table2,
    color: datasetType.color,
    description: `A dataset ${s.hint.charAt(0).toLowerCase()}${s.hint.slice(1)}.`,
    fields: [],
  }),
)

// ── Making one ────────────────────────────────────────────────────────

/** Keys that name an object's machinery: a header that reads as one is kept as its label, under another key. */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * A column key from a header: trimmed, lowercased, spaces to underscores; `col_<n>` for an empty one. A header is data
 * (a file's first line), and a key that names an object's machinery — `constructor`, `prototype` — becomes
 * `constructor_col`, so a row read as a record (`datasetRecords`) never writes through a prototype.
 */
export function columnKey(header: string, index: number): string {
  const k = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (RESERVED_KEYS.has(k)) return `${k}_col`
  return k || `col_${index + 1}`
}

/** Columns from headers: keys made unique (`name`, `name_2`, …), the header kept as the label when it differs. */
export function columnsFromHeaders(headers: string[]): DatasetColumn[] {
  const seen = new Map<string, number>()
  return headers.map((h, i) => {
    const base = columnKey(h, i)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const key = n === 1 ? base : `${base}_${n}`
    const label = h.trim()
    return label && label !== key ? { key, label } : { key }
  })
}

/** Every row padded or cut to the columns' width, so `rows[r][c]` is always the cell of column `c`. */
export function squareRows(rows: unknown[][], width: number): unknown[][] {
  return rows.map((r) => {
    const row = Array.isArray(r) ? r.slice(0, width) : []
    while (row.length < width) row.push(null)
    return row
  })
}

export interface DatasetInit {
  label: string
  description?: string
  source?: DatasetSource
  /** An earlier dataset this one replaces: its id, label, description, tags and creation time are kept. */
  existing?: AnyEntity
  id?: EntityId
}

/** A dataset entity from a table: headers become columns, rows are squared to them. */
export function datasetFromTable(headers: string[], rows: unknown[][], init: DatasetInit): DatasetEntity {
  const columns = columnsFromHeaders(headers)
  const data: DatasetData = { columns, rows: squareRows(rows, columns.length), ...(init.source ? { source: init.source } : {}) }
  return datasetEntity(data, init)
}

/** A dataset entity around ready data (an edit of an existing one keeps everything but the data). */
export function datasetEntity(data: DatasetData, init: DatasetInit): DatasetEntity {
  const prev = init.existing && isDataset(init.existing) ? init.existing : undefined
  if (prev) {
    return { ...prev, label: init.label || prev.label, description: init.description ?? prev.description, data: { ...data, source: data.source ?? prev.data.source }, meta: { ...prev.meta, updatedAt: new Date().toISOString() } }
  }
  return createEntity<DatasetData>({ id: init.id, type: datasetTypeOf(data.source), label: init.label, description: init.description, tags: [], data: { source: { kind: 'hand' }, ...data }, meta: { source: data.source?.kind === 'script' ? 'script' : 'user' } })
}

/** An empty dataset: three text columns and one blank row, ready to type into. */
export function emptyDataset(label = 'New dataset'): DatasetEntity {
  return datasetEntity({ columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], rows: [[null, null, null]], source: { kind: 'hand' } }, { label })
}

/**
 * The dataset a script's table becomes. A saved script's table updates the
 * dataset it made before (found by the script id and, when the script
 * returns several tables, the label), so a rerun refreshes the rows and
 * keeps the name, description and tags a person gave it.
 */
export function datasetFromScript(store: Pick<EntityStore, 'ofType'>, script: { id: EntityId; label: string }, table: { columns: string[]; rows: unknown[][] }, opts: { label?: string; sceneId?: EntityId } = {}): DatasetEntity {
  const existing = datasetsIn(store).find((e) => e.data.source?.kind === 'script' && e.data.source.scriptId === script.id && (!opts.label || displayLabel(e) === opts.label))
  const source: DatasetSource = { kind: 'script', scriptId: script.id, ranAt: new Date().toISOString(), ...(opts.sceneId ? { sceneId: opts.sceneId } : {}) }
  return datasetFromTable(table.columns, table.rows, { label: existing ? displayLabel(existing) : (opts.label ?? script.label), source, existing })
}

/** Every dataset in the scope. */
export const datasetsIn = (store: Pick<EntityStore, 'ofType'>): DatasetEntity[] => DATASET_FAMILY.flatMap((t) => store.ofType(t)).filter(isDataset)

// ── Reading one ───────────────────────────────────────────────────────

export const columnLabel = (c: DatasetColumn) => c.label ?? c.key

/**
 * The kind a column's values suggest when it declares none: number when
 * every present value is a number, and so on; text otherwise. `sample`
 * bounds the values looked at — the page passes one so a 700k-row table
 * is not read whole after every edit; a mixed column past the sample
 * reads as its kind's text, which the editor shows as typed anyway.
 */
export function inferColumnKind(data: DatasetData, col: number, sample = Infinity): ColumnKind {
  const declared = data.columns[col]?.kind
  if (declared) return declared
  let kind: ColumnKind | undefined
  let seen = 0
  for (const row of data.rows) {
    const v = row[col]
    if (v === null || v === undefined || v === '') continue
    if (++seen > sample) break
    const k = kindOfValue(v)
    const ck: ColumnKind = k === 'number' || k === 'boolean' || k === 'date' || k === 'datetime' || k === 'url' ? k : k === 'json' ? 'json' : 'text'
    if (kind === undefined) kind = ck
    else if (kind !== ck) return ck === 'json' || kind === 'json' ? 'json' : 'text'
  }
  return kind ?? 'text'
}

/** "12 rows × 3 columns", with where it came from. */
export function describeDataset(data: DatasetData, scriptLabel?: string): string {
  const shape = `${data.rows.length.toLocaleString('en-US')} row${data.rows.length === 1 ? '' : 's'} × ${data.columns.length} column${data.columns.length === 1 ? '' : 's'}`
  const s = data.source
  const from = s?.kind === 'script' ? `by ${scriptLabel ?? 'a script'}` : s?.kind === 'csv' ? (s.filename ? `from ${s.filename}` : 'from CSV') : s?.kind === 'entities' ? `from ${s.selector ?? 'entities'}` : s?.kind === 'file' ? `from ${s.filename}${s.sheet ? ` › ${s.sheet}` : ''}` : ''
  return from ? `${shape} · ${from}` : shape
}

/** One cell as text, the way the grid shows it and the editor opens it. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** What typed text means in a column of a kind: numbers, booleans, JSON read; an empty cell is null. */
export function parseCell(text: string, kind: ColumnKind | undefined): unknown {
  if (text.trim() === '') return null
  const v = parsePropertyValue(text, kind === 'json' ? undefined : kind)
  return v === undefined ? null : v
}

/** The rows as objects keyed by column — what a chart or a script reads. */
export function datasetRecords(data: DatasetData): Record<string, unknown>[] {
  return data.rows.map((row) => Object.fromEntries(data.columns.map((c, i) => [c.key, row[i]])))
}

// ── Editing one (pure) ────────────────────────────────────────────────

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.trunc(n)))

export function setCell(data: DatasetData, row: number, col: number, value: unknown): DatasetData {
  if (row < 0 || row >= data.rows.length || col < 0 || col >= data.columns.length) return data
  const rows = data.rows.slice()
  const r = rows[row].slice()
  r[col] = value
  rows[row] = r
  return { ...data, rows }
}

/** A row of `values` (padded to the width) at `at`, or at the end. */
export function insertRow(data: DatasetData, at?: number, values: unknown[] = []): DatasetData {
  const i = at === undefined ? data.rows.length : clamp(at, data.rows.length)
  const rows = data.rows.slice()
  rows.splice(i, 0, squareRows([values], data.columns.length)[0])
  return { ...data, rows }
}

export function deleteRows(data: DatasetData, indices: number[]): DatasetData {
  const gone = new Set(indices)
  return { ...data, rows: data.rows.filter((_, i) => !gone.has(i)) }
}

/** The next spreadsheet-style key not yet in the table: a…z, then aa, ab… — what a column added by hand or by a paste is called. */
export function nextColumnKey(data: DatasetData): string {
  const taken = new Set(data.columns.map((c) => c.key))
  for (let n = 1; ; n++) {
    let key = ''
    for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) key = String.fromCharCode(97 + ((i - 1) % 26)) + key
    if (!taken.has(key)) return key
  }
}

/** `count` blank columns at `at` (or the end), named by the next letters, in one pass over the rows. */
export function insertColumns(data: DatasetData, count: number, at?: number): DatasetData {
  if (count <= 0) return data
  const i = at === undefined ? data.columns.length : clamp(at, data.columns.length)
  const columns = data.columns.slice()
  for (let n = 0; n < count; n++) columns.splice(i + n, 0, { key: nextColumnKey({ columns, rows: [] }) })
  const blanks = new Array<unknown>(count).fill(null)
  const rows = data.rows.map((r) => [...r.slice(0, i), ...blanks, ...r.slice(i)])
  return { ...data, columns, rows }
}

/** A column at `at` (or the end): every row gets `fill` there. The key is made unique among the columns; without one it is the next letter. */
export function insertColumn(data: DatasetData, column: Partial<DatasetColumn> & { key?: string }, at?: number, fill: unknown = null): DatasetData {
  const i = at === undefined ? data.columns.length : clamp(at, data.columns.length)
  const taken = new Set(data.columns.map((c) => c.key))
  const named = column.key ?? column.label
  const base = named ? columnKey(named, i) : nextColumnKey(data)
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
  const col: DatasetColumn = { ...column, key }
  if (col.label === col.key) delete col.label
  const columns = data.columns.slice()
  columns.splice(i, 0, col)
  const rows = data.rows.map((r) => {
    const row = r.slice()
    row.splice(i, 0, fill)
    return row
  })
  return { ...data, columns, rows }
}

export function deleteColumn(data: DatasetData, col: number): DatasetData {
  if (col < 0 || col >= data.columns.length) return data
  return { ...data, columns: data.columns.filter((_, i) => i !== col), rows: data.rows.map((r) => r.filter((_, i) => i !== col)) }
}

/** A column's label, kind or description changed; the key stays, so what names the column keeps working. */
export function updateColumn(data: DatasetData, col: number, patch: Partial<Omit<DatasetColumn, 'key'>>): DatasetData {
  if (col < 0 || col >= data.columns.length) return data
  const columns = data.columns.slice()
  const next: DatasetColumn = { ...columns[col], ...patch }
  for (const k of ['label', 'kind', 'description'] as const) if (next[k] === undefined || next[k] === '') delete next[k]
  columns[col] = next
  return { ...data, columns }
}

export function moveColumn(data: DatasetData, from: number, to: number): DatasetData {
  const n = data.columns.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return data
  const move = <T>(arr: T[]) => {
    const a = arr.slice()
    const [x] = a.splice(from, 1)
    a.splice(to, 0, x)
    return a
  }
  return { ...data, columns: move(data.columns), rows: data.rows.map(move) }
}

/** The rows in the order of one column — numbers before strings, blanks last whichever way; a stable sort, so ties keep their order. */
export function sortRows(data: DatasetData, col: number, dir: 'asc' | 'desc' = 'asc'): DatasetData {
  if (col < 0 || col >= data.columns.length) return data
  const rank = (v: unknown) => (v === null || v === undefined || v === '' ? 2 : typeof v === 'number' ? 0 : 1)
  const rows = data.rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const va = a.r[col]
      const vb = b.r[col]
      const ra = rank(va)
      const rb = rank(vb)
      // Blanks stay at the bottom either way; numbers and strings swap sides with the direction.
      if (ra === 2 || rb === 2) return ra - rb
      if (ra !== rb) return dir === 'asc' ? ra - rb : rb - ra
      let c = 0
      if (ra === 0) c = (va as number) - (vb as number)
      else if (ra === 1) c = cellText(va).localeCompare(cellText(vb), undefined, { numeric: true })
      if (c === 0) return a.i - b.i
      return dir === 'asc' ? c : -c
    })
    .map((x) => x.r)
  return { ...data, rows }
}

// ── CSV in and out ────────────────────────────────────────────────────

/** A dataset's data from CSV text: the first line is the header; numbers, booleans and JSON are read, everything else is text. */
export function datasetFromCsv(text: string): DatasetData {
  const p = new CsvParser()
  const raw: string[][] = []
  p.push(text, (r) => raw.push(r))
  p.end((r) => raw.push(r))
  const lines = raw.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
  const header = lines.shift() ?? []
  const columns = columnsFromHeaders(header)
  const rows = squareRows(
    lines.map((r) => r.map((s) => parseCell(restoreCell(s), undefined))),
    columns.length,
  )
  return { columns, rows }
}

/** CSV with the column labels as the header; cells the way the grid shows them. */
export function datasetToCsv(data: DatasetData): string {
  // Defused (`defuseCell`): a CSV is opened in a spreadsheet, where a cell starting `=` is a formula.
  const line = (cells: string[]) => cells.map(csvEscape).join(',')
  return [line(data.columns.map(columnLabel)), ...data.rows.map((r) => line(r.map(cellText)))].join('\n') + '\n'
}

// ── Editing many cells at once ────────────────────────────────────────
// The grid's bulk edits — a pasted block, a cleared range, a fill — land as one write: one new outer array,
// one new inner array per row touched, the rest shared.

export interface CellPatch {
  r: number
  c: number
  value: unknown
}

/** Many cells in one write; out-of-range patches are ignored. */
export function setCells(data: DatasetData, patches: CellPatch[]): DatasetData {
  if (!patches.length) return data
  const rows = data.rows.slice()
  const copied = new Set<number>()
  let changed = false
  for (const p of patches) {
    if (p.r < 0 || p.r >= rows.length || p.c < 0 || p.c >= data.columns.length) continue
    if (!copied.has(p.r)) {
      rows[p.r] = rows[p.r].slice()
      copied.add(p.r)
    }
    if (rows[p.r][p.c] !== p.value) changed = true
    rows[p.r][p.c] = p.value
  }
  return changed ? { ...data, rows } : data
}

/** A rectangle of cells, both corners included, in row/column indices. */
export interface CellRange {
  r0: number
  c0: number
  r1: number
  c1: number
}

/** The range with its corners in order (top-left, bottom-right), clipped to the table. */
export function normalizeRange(range: CellRange, data: Pick<DatasetData, 'rows' | 'columns'>): CellRange {
  const rows = Math.max(0, data.rows.length - 1)
  const cols = Math.max(0, data.columns.length - 1)
  const cl = (n: number, max: number) => Math.max(0, Math.min(max, Math.trunc(n)))
  return { r0: cl(Math.min(range.r0, range.r1), rows), r1: cl(Math.max(range.r0, range.r1), rows), c0: cl(Math.min(range.c0, range.c1), cols), c1: cl(Math.max(range.c0, range.c1), cols) }
}

/** Every cell of the range set to null (Delete over a selection). */
export function clearRange(data: DatasetData, range: CellRange): DatasetData {
  const g = normalizeRange(range, data)
  const patches: CellPatch[] = []
  for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) if (data.rows[r][c] !== null && data.rows[r][c] !== undefined) patches.push({ r, c, value: null })
  return setCells(data, patches)
}

/** The range as text for the clipboard: tab-separated cells, one line per row, the way spreadsheets exchange blocks. */
export function rangeToTsv(data: DatasetData, range: CellRange): string {
  const g = normalizeRange(range, data)
  const lines: string[] = []
  for (let r = g.r0; r <= g.r1; r++) {
    const cells: string[] = []
    for (let c = g.c0; c <= g.c1; c++) cells.push(cellText(data.rows[r][c]).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/**
 * A block of text from the clipboard as cells: tab-separated when any line
 * holds a tab (what a spreadsheet copies), else CSV when it reads as rows
 * of the same width (quoted commas included), else one column of lines. A
 * trailing newline adds no row.
 */
export function parseClipboardBlock(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n')
  const lines = t.endsWith('\n') ? t.slice(0, -1).split('\n') : t.split('\n')
  if (!lines.length) return []
  if (lines.some((l) => l.includes('\t'))) return lines.map((l) => l.split('\t'))
  if (t.includes(',')) {
    const p = new CsvParser()
    const out: string[][] = []
    p.push(t.endsWith('\n') ? t : t + '\n', (r) => out.push(r))
    p.end((r) => out.push(r))
    if (out.length && out[0].length > 1 && out.every((r) => r.length === out[0].length)) return out
  }
  return lines.map((l) => [l])
}

/**
 * A block pasted at a cell: it lands with its top-left corner there, rows and
 * columns added to make room; a single value pasted over a range fills the
 * range (the spreadsheet rule). Values are read by the column's kind.
 */
export function pasteBlock(data: DatasetData, block: string[][], at: { r: number; c: number }, over?: CellRange): { data: DatasetData; rows: number; cols: number } {
  if (!block.length) return { data, rows: 0, cols: 0 }
  let next = data
  const single = block.length === 1 && block[0].length === 1
  const target = single && over ? normalizeRange(over, data) : undefined
  const height = target ? target.r1 - target.r0 + 1 : block.length
  const width = target ? target.c1 - target.c0 + 1 : Math.max(...block.map((l) => l.length))
  const r0 = target ? target.r0 : at.r
  const c0 = target ? target.c0 : at.c
  while (next.rows.length < r0 + height) next = insertRow(next)
  while (next.columns.length < c0 + width) next = insertColumn(next, {})
  // A column with a declared kind reads its way; one without reads as typed: numbers, booleans and JSON as such.
  const kinds = next.columns.map((col) => col.kind)
  const patches: CellPatch[] = []
  for (let i = 0; i < height; i++) {
    const line = single ? block[0] : (block[i] ?? [])
    for (let j = 0; j < width; j++) {
      const text = single ? line[0] : line[j]
      if (text === undefined) continue
      patches.push({ r: r0 + i, c: c0 + j, value: parseCell(text, kinds[c0 + j]) })
    }
  }
  return { data: setCells(next, patches), rows: height, cols: width }
}

/** Fill down (or right): the first row (column) of the range copied into the rest of it. */
export function fillRange(data: DatasetData, range: CellRange, dir: 'down' | 'right'): DatasetData {
  const g = normalizeRange(range, data)
  const patches: CellPatch[] = []
  if (dir === 'down') {
    for (let r = g.r0 + 1; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) patches.push({ r, c, value: data.rows[g.r0][c] })
  } else {
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0 + 1; c <= g.c1; c++) patches.push({ r, c, value: data.rows[r][g.c0] })
  }
  return setCells(data, patches)
}

/** `count` blank rows at `at` (or the end). */
export function insertRows(data: DatasetData, count: number, at?: number): DatasetData {
  if (count <= 0) return data
  const i = at === undefined ? data.rows.length : clamp(at, data.rows.length)
  const rows = data.rows.slice()
  const blank: unknown[][] = []
  for (let k = 0; k < count; k++) blank.push(new Array<unknown>(data.columns.length).fill(null))
  rows.splice(i, 0, ...blank)
  return { ...data, rows }
}

export function deleteColumns(data: DatasetData, indices: number[]): DatasetData {
  const gone = new Set(indices.filter((i) => i >= 0 && i < data.columns.length))
  if (!gone.size || gone.size >= data.columns.length) return data
  return { ...data, columns: data.columns.filter((_, i) => !gone.has(i)), rows: data.rows.map((r) => r.filter((_, i) => !gone.has(i))) }
}

/** The far edge of the block of filled cells from a cell in a direction — ⌘+arrow in a spreadsheet: the next blank, or the next filled cell past blanks, or the edge. */
export function blockEdge(data: DatasetData, from: { r: number; c: number }, dr: number, dc: number): { r: number; c: number } {
  const filled = (r: number, c: number) => {
    const v = data.rows[r]?.[c]
    return v !== null && v !== undefined && v !== ''
  }
  const inside = (r: number, c: number) => r >= 0 && r < data.rows.length && c >= 0 && c < data.columns.length
  let { r, c } = from
  if (!inside(r + dr, c + dc)) return from
  if (filled(r, c) && filled(r + dr, c + dc)) {
    // Through the block to its last filled cell.
    while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
      r += dr
      c += dc
    }
    return { r, c }
  }
  // Past the blanks to the next filled cell, or the edge.
  r += dr
  c += dc
  while (inside(r + dr, c + dc) && !filled(r, c)) {
    r += dr
    c += dc
  }
  return { r, c }
}

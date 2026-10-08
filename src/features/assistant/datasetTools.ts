import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import {
  cellText,
  columnLabel,
  datasetFromScript,
  datasetEntity,
  datasetFromTable,
  datasetRecords,
  datasetsIn,
  deleteColumn,
  deleteRows,
  describeDataset,
  inferColumnKind,
  insertColumn,
  insertRow,
  isDataset,
  moveColumn,
  parseCell,
  setCell,
  sortRows,
  updateColumn,
  type ColumnKind,
  type DatasetData,
  type DatasetEntity,
} from '../../core/datasets/dataset'
import { displayLabel, quoteLabel } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { outputsOf } from '../../scripting/outputs'
import { getDatasetHandle, waitForDatasetPage } from '../analytics/datasetHandle'
import { runScript } from '../scripts/runner'
import { isScript } from '../scripts/script'
import { SELECTOR_SCHEMA, selectorFrom } from './schemas'
import { json, openMade } from './toolkit'
import { describeSelector, resolveSelector } from '../../core/graph/selector'
import { makeValueContext } from '../../core/graph/values'
import { datasetCountsFromEntities, datasetFromEntities } from '../../core/datasets/fromEntities'
import { bytesOfDataUrl, normalizeDelimiter, readDatasetFile, readDelimited } from '../../core/datasets/files'
import type { AppHost } from './tools'

/**
 * Datasets for the assistant: the tables that analytics scripts return,
 * kept as `dataset` entities and edited on the Datasets page. The same
 * edits the page makes — a cell, rows, columns, a sort — and the two ways
 * a dataset is filled: a saved script run again, or CSV text.
 */
export function createDatasetTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  const require = (id: string | undefined): DatasetEntity => {
    // The page writes a run of edits a moment after the last one; a tool reading or writing the entity sees them first.
    const h = getDatasetHandle()
    if (id && h && h.getState().datasetId === id) h.flush()
    const e = id ? store.get(id) : undefined
    if (!isDataset(e)) throw new Error(`No dataset with id ${id}. Use dataset {action:"list"}.`)
    return e
  }
  const scriptOf = (e: DatasetEntity) => (e.data.source?.kind === 'script' ? store.get(e.data.source.scriptId) : undefined)
  const brief = (e: DatasetEntity) => {
    const script = scriptOf(e)
    return { id: e.id, type: e.type, label: displayLabel(e), description: e.description, rows: e.data.rows.length, columns: e.data.columns.map((c, i) => ({ key: c.key, label: columnLabel(c), kind: c.kind ?? inferColumnKind(e.data, i), ...(c.description ? { description: c.description } : {}) })), source: e.data.source, ...(script ? { script: { id: script.id, label: displayLabel(script) } } : {}), summary: describeDataset(e.data, script ? displayLabel(script) : undefined), url: `/analytics/datasets?id=${encodeURIComponent(e.id)}` }
  }
  const write = (e: DatasetEntity, data: DatasetData) => {
    store.update(e.id, { data })
    return require(e.id)
  }
  const colIndex = (e: DatasetEntity, column: string | number | undefined, what: string): number => {
    if (column === undefined) throw new Error(`${what} needs a column (its key, label or index).`)
    const i = typeof column === 'number' ? column : e.data.columns.findIndex((c) => c.key === column || columnLabel(c) === column)
    if (i < 0 || i >= e.data.columns.length) throw new Error(`No column ${JSON.stringify(column)} in ${displayLabel(e)}: ${e.data.columns.map((c) => c.key).join(', ')}.`)
    return i
  }
  // What the Datasets page's own New dataset / Keep as a dataset do: the table made is the one shown.
  const pageOf = (e: DatasetEntity) => `/analytics/datasets?id=${encodeURIComponent(e.id)}`
  const show = (e: DatasetEntity) => ({ opened: openMade(host, e.id, pageOf(e)) })

  const dataset = betaTool({
    name: 'dataset',
    description:
      'Datasets: tables kept as entities (type "dataset", or a subtype saying what it was read from — dataset:csv, dataset:tsv, dataset:text, dataset:excel, dataset:parquet — which every list includes; columns and rows), edited on the Datasets page (/analytics/datasets?id=…, a tab of Analytics) and the step between a script and a chart — the flow is scene → script → dataset → chart. Actions: list (every dataset, whatever its subtype: id, type, label, shape, source); get (one dataset with its columns and rows — `limit` caps how many, default 200, `offset` pages; `records: true` returns rows as objects keyed by column); create (name, columns as strings, rows as arrays — or `csv`: delimited text, comma-separated unless `delimiter` names another separator (tab, semicolon, pipe, whitespace, or any other string), the first line the header unless `header: false` — or `file`: a whole file as a data: URL with its `filename`, read by its extension as the chat reads an attached file: .csv, .tsv, .txt (give `delimiter`), .xlsx (one dataset per sheet with cells, or only `sheet`), .parquet; up to 50 MB, 200,000 rows, 500 columns, 5 million cells); from_script (run a saved script by id and keep the table it returns; the same script refreshes the same dataset on every run); from_entities (the rows are entities — a selector over the whole dataset by default: types, tags, text, field predicates — and the columns their fields; "put all the trees into a dataset" is {action:"from_entities", selector:{types:["tree"]}}; no script, so any number of entities; `columns` may add computed values such as degree; `group_by` counts instead — {action:"from_entities", group_by:"type"} is every type in the project with how many entities it has); set (cells: [{row, col, value}] — value as text is read by the column\'s kind, so "3" is a number in a number column); add_rows (rows as arrays, at an index or the end); delete_rows (indices); add_column (label, kind, at, fill); update_column (label, kind, description — the key does not change); move_column; delete_column; sort (column, dir); rename (name, description); open (show it on the Datasets page — create, from_script and from_entities open what they made unless `open: false`); delete. Row and column indices are 0-based; a column is named by key, label or index.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'from_script', 'from_entities', 'set', 'add_rows', 'delete_rows', 'add_column', 'update_column', 'move_column', 'delete_column', 'sort', 'rename', 'open', 'delete'] },
        id: { type: 'string', description: 'The dataset (every action but list, create, from_script and from_entities)' },
        name: { type: 'string', description: 'create/rename/from_script/from_entities: the dataset\'s name (from_script: defaults to the script\'s; from_entities: to the selector\'s description)' },
        description: { type: 'string', description: 'create/rename/update_column: what it holds' },
        columns: { type: 'array', items: { type: 'string' }, description: 'create: the headers, in order. from_entities: the columns to keep — fields (id, label, type, tags, description, data.<key>, meta.<key>) or computed values (degree, degree.in:cites, metric.pagerank, dataset:<id>.<column>); default every field the rows\' types declare' },
        group_by: { type: 'string', description: 'from_entities: count instead of listing — one row per value of this ValueRef with how many entities carry it, most first: "type" (columns type, label, count — "entity types and their counts"), "tags" (tag, count; each tag counts once per entity), or a field such as data.genus' },
        selector: SELECTOR_SCHEMA,
        rows: { type: 'array', items: { type: 'array', items: {} }, description: 'create/add_rows: rows as arrays in the columns\' order' },
        csv: { type: 'string', description: 'create: delimited text — CSV by default, header first — instead of columns and rows' },
        delimiter: { type: 'string', description: 'create with csv (or a .txt file): the separator — "comma" (default), "tab", "semicolon", "pipe", "whitespace" (runs of spaces and tabs), or the character(s) themselves; a one-character separator honours quoted fields' },
        header: { type: 'boolean', description: 'create with csv or file: whether the first row names the columns (default true); false letters them a, b, c…' },
        file: { type: 'string', description: 'create: a whole file as a data: URL (data:<type>;base64,…) — CSV, TSV, text, Excel .xlsx or Parquet — with `filename` saying which' },
        filename: { type: 'string', description: 'create with file: the file\'s name; its extension says how it is read (.csv, .tsv, .txt, .xlsx, .parquet, or .csv.gz) and the dataset is named after it unless `name` is given' },
        sheet: { type: 'string', description: 'create with an .xlsx file: only this sheet (by name) — every sheet with cells otherwise, one dataset each' },
        script: { type: 'string', description: 'from_script: the saved script to run (its first table output is kept)' },
        cells: { type: 'array', items: { type: 'object', properties: { row: { type: 'number' }, col: {}, value: {} }, required: ['row', 'col'], additionalProperties: false }, description: 'set: the cells to write — row index, column (key, label or index), value (omit or null to clear)' },
        indices: { type: 'array', items: { type: 'number' }, description: 'delete_rows: the rows to remove' },
        at: { type: 'number', description: 'add_rows/add_column: the index to insert at (default: the end)' },
        column: { description: 'update_column/move_column/delete_column/sort: the column, by key, label or index' },
        to: { type: 'number', description: 'move_column: the index to move it to' },
        label: { type: 'string', description: 'add_column/update_column: the header' },
        kind: { type: 'string', enum: ['text', 'number', 'boolean', 'date', 'datetime', 'url', 'json'], description: 'add_column/update_column: how the cells read; omit on update_column with `infer: true` to drop a declared kind' },
        infer: { type: 'boolean', description: 'update_column: true drops the declared kind, so it is read from the values again' },
        fill: { description: 'add_column: the value every row gets (default null)' },
        dir: { type: 'string', enum: ['asc', 'desc'], description: 'sort: the direction (default asc)' },
        offset: { type: 'number', description: 'get: the first row to return (default 0)' },
        records: { type: 'boolean', description: 'get: rows as objects keyed by column key instead of arrays' },
        limit: { type: 'number', description: 'get: how many rows to return (default 200)' },
        open: { type: 'boolean', description: 'create/from_script/from_entities: show the dataset on the Datasets page afterwards (default true); false to make it quietly, e.g. one of several' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, id, name, description, columns, group_by, selector, rows, csv, delimiter, header, file, filename, sheet, script, cells, indices, at, column, to, label, kind, infer, fill, dir, offset, records, limit, open }) => {
      if (action === 'from_entities') {
        const sel = selectorFrom({ scope: 'dataset', ...(selector ?? {}) })
        const reg = registry()
        const values = makeValueContext({ scope: 'dataset', store })
        const r = resolveSelector(sel, { store, registry: reg, slice: { nodes: [], edges: [], degree: new Map(), truncated: 0, candidates: 0 }, values })
        if (!r.nodes.length) throw new Error(`No entities match ${describeSelector(sel)}.`)
        const what = describeSelector(sel)
        const source = { kind: 'entities' as const, at: new Date().toISOString(), count: r.nodes.length, selector: group_by ? `${what}, counted by ${group_by}` : what }
        const e = group_by
          ? datasetEntity({ ...datasetCountsFromEntities(reg, r.nodes, group_by, values), source }, { label: name || `${what} by ${group_by}`, description, source })
          : datasetFromEntities(reg, r.nodes, { label: name || what, description, columns: columns?.length ? columns : undefined, values, source })
        store.upsert(e)
        return json({ created: true, ...brief(require(e.id)), ...(open !== false ? show(e) : { hint: 'dataset {action:"open", id} shows it on the Datasets page.' }) })
      }
      if (action === 'list') return json({ datasets: datasetsIn(store).map(brief) })
      if (action === 'get') {
        const e = require(id)
        const start = Math.max(0, offset ?? 0)
        const n = Math.max(0, limit ?? 200)
        const slice = e.data.rows.slice(start, start + n)
        return json({ ...brief(e), offset: start, returned: slice.length, rows: records ? datasetRecords({ ...e.data, rows: slice }) : slice })
      }
      if (action === 'create' && file) {
        // A whole file, read as the chat reads one attached to a message — the same reader, the same bounds.
        if (!filename) throw new Error('create with file needs filename — its extension says how the file is read (.csv, .tsv, .txt, .xlsx, .parquet).')
        const bytes = bytesOfDataUrl(file)
        const read = await readDatasetFile({ name: filename, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }, { delimiter, header, sheet })
        const made = read.map((r) => datasetEntity({ ...r.data, source: r.source }, { label: name ? (read.length > 1 ? `${name} · ${r.source.sheet}` : name) : r.label, description }))
        store.transaction(() => made.forEach((e) => store.upsert(e)))
        return json({ created: made.length, datasets: made.map((e) => brief(require(e.id))), ...(open !== false ? show(made[0]) : {}) })
      }
      if (action === 'create') {
        if (!name) throw new Error('create needs a name.')
        let e: DatasetEntity
        if (csv) {
          const source = { kind: 'csv' as const, importedAt: new Date().toISOString() }
          const data = await readDelimited(csv, { delimiter: normalizeDelimiter(delimiter), header: header ?? true }, 'The CSV')
          e = datasetEntity({ ...data, source }, { label: name, description })
        } else {
          if (!columns?.length) throw new Error('create needs columns (or csv).')
          e = datasetFromTable(columns, (rows ?? []) as unknown[][], { label: name, description, source: { kind: 'hand' } })
        }
        store.upsert(e)
        return json({ created: true, ...brief(require(e.id)), ...(open !== false ? show(e) : {}) })
      }
      if (action === 'from_script') {
        const s = script ? store.get(script) : undefined
        if (!isScript(s)) throw new Error(`No script with id ${script}. Use script {action:"list"}; save one with script {action:"save"} first.`)
        const r = await runScript(store, registry(), s.data.code, { scriptId: s.id, language: s.data.language })
        if (r.error) return json({ error: r.error.message, logs: r.logs })
        const table = outputsOf(r.value).find((o) => o.kind === 'table')
        if (!table || table.kind !== 'table') throw new Error(`${displayLabel(s)} returned no table. Return table(columns, rows) — or a collection of entities — from the script.`)
        const e = datasetFromScript(store, { id: s.id, label: displayLabel(s) }, table, { label: name })
        const updated = store.has(e.id)
        store.upsert(e)
        return json({ [updated ? 'updated' : 'created']: true, ...brief(require(e.id)), ...(open !== false ? show(e) : {}), hint: 'The page\'s Rerun script does the same refresh.' })
      }
      const e = require(id)
      if (action === 'open') {
        const opened = pageOf(e)
        host.navigate(opened)
        const h = getDatasetHandle()?.getState().datasetId === e.id ? getDatasetHandle() : await waitForDatasetPage(1500)
        return json({ opened, onScreen: !!h, ...brief(e) })
      }
      if (action === 'delete') {
        if (!(await host.confirm(`Delete a dataset of ${e.data.rows.length} rows, ${quoteLabel(displayLabel(e))}?`, { yes: 'Delete', danger: true }))) return json({ deleted: false, cancelled: true })
        store.remove(e.id)
        return json({ deleted: true, id: e.id })
      }
      if (action === 'rename') {
        if (!name && description === undefined) throw new Error('rename needs a name or a description.')
        store.update(e.id, { ...(name ? { label: name } : {}), ...(description !== undefined ? { description: description || undefined } : {}) })
        return json(brief(require(e.id)))
      }
      if (action === 'set') {
        if (!cells?.length) throw new Error('set needs cells.')
        let data = e.data
        for (const cell of cells) {
          const c = colIndex(e, cell.col as string | number, 'set')
          if (cell.row < 0 || cell.row >= data.rows.length) throw new Error(`Row ${cell.row} is out of range (${data.rows.length} rows). add_rows adds rows.`)
          const k = data.columns[c].kind ?? inferColumnKind(data, c)
          const v = cell.value === undefined || cell.value === null ? null : typeof cell.value === 'string' ? parseCell(cell.value, k) : cell.value
          data = setCell(data, cell.row, c, v)
        }
        return json({ set: cells.length, ...brief(write(e, data)) })
      }
      if (action === 'add_rows') {
        if (!rows?.length) throw new Error('add_rows needs rows.')
        let data = e.data
        const list = rows as unknown[][]
        for (let i = 0; i < list.length; i++) data = insertRow(data, at === undefined ? undefined : at + i, list[i].map((v, c) => (typeof v === 'string' ? parseCell(v, data.columns[c]?.kind ?? inferColumnKind(data, c)) : v)))
        return json({ added: list.length, ...brief(write(e, data)) })
      }
      if (action === 'delete_rows') {
        if (!indices?.length) throw new Error('delete_rows needs indices.')
        return json({ deleted: indices.length, ...brief(write(e, deleteRows(e.data, indices))) })
      }
      if (action === 'add_column') {
        if (!label) throw new Error('add_column needs a label.')
        const data = insertColumn(e.data, { label, ...(kind ? { kind: kind as ColumnKind } : {}), ...(description ? { description } : {}) }, at, fill ?? null)
        return json({ added: data.columns[at ?? data.columns.length - 1].key, ...brief(write(e, data)) })
      }
      if (action === 'update_column') {
        const c = colIndex(e, column as string | number, 'update_column')
        const data = updateColumn(e.data, c, { ...(label !== undefined ? { label } : {}), ...(kind ? { kind: kind as ColumnKind } : infer ? { kind: undefined } : {}), ...(description !== undefined ? { description } : {}) })
        return json(brief(write(e, data)))
      }
      if (action === 'move_column') {
        const c = colIndex(e, column as string | number, 'move_column')
        if (to === undefined) throw new Error('move_column needs to.')
        return json(brief(write(e, moveColumn(e.data, c, to))))
      }
      if (action === 'delete_column') {
        const c = colIndex(e, column as string | number, 'delete_column')
        if (e.data.columns.length < 2) throw new Error('A dataset keeps at least one column.')
        return json(brief(write(e, deleteColumn(e.data, c))))
      }
      if (action === 'sort') {
        const c = colIndex(e, column as string | number, 'sort')
        const data = sortRows(e.data, c, dir === 'desc' ? 'desc' : 'asc')
        return json({ sortedBy: e.data.columns[c].key, dir: dir ?? 'asc', head: data.rows.slice(0, 5).map((r) => r.map(cellText)), ...brief(write(e, data)) })
      }
      throw new Error(`Unknown action ${action as string}`)
    },
  })

  return [dataset]
}

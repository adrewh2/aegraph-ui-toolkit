import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { getEntityType } from '../../entity/schema'
import {
  cellText,
  columnsFromHeaders,
  DATASET_TYPE,
  datasetFromCsv,
  datasetFromScript,
  datasetFromTable,
  datasetRecords,
  datasetToCsv,
  deleteColumn,
  deleteRows,
  describeDataset,
  emptyDataset,
  inferColumnKind,
  insertColumn,
  insertRow,
  isDataset,
  moveColumn,
  parseCell,
  setCell,
  sortRows,
  updateColumn,
  type DatasetData,
} from '../dataset'

/**
 * The dataset: the entity a table becomes, its columns from headers, the
 * pure edits the page and the tool share, what a script's rerun does to
 * the dataset it made, and CSV both ways.
 */
const table = (): DatasetData => ({ columns: [{ key: 'name' }, { key: 'n', label: 'Count' }], rows: [['a', 1], ['b', 2], ['c', null]] })

describe('the dataset type', () => {
  it('is registered as a project type with its shape', () => {
    const def = getEntityType(DATASET_TYPE)
    expect(def?.category).toBe('project')
    expect(def?.fields.map((f) => f.key)).toContain('data.rows')
  })

  it('makes an entity from headers and rows, keys made unique and the header kept as the label', () => {
    const e = datasetFromTable(['Name', 'Count', 'count', ''], [['a', 1, 2, 3], ['b']], { label: 'T' })
    expect(isDataset(e)).toBe(true)
    expect(e.type).toBe(DATASET_TYPE)
    expect(e.data.columns).toEqual([{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count' }, { key: 'count_2', label: 'count' }, { key: 'col_4' }])
    // Rows are squared to the columns: short ones padded with null.
    expect(e.data.rows).toEqual([['a', 1, 2, 3], ['b', null, null, null]])
    expect(e.data.source).toEqual({ kind: 'hand' })
    expect(e.meta.source).toBe('user')
  })

  it('columnsFromHeaders leaves the label out when it equals the key', () => {
    expect(columnsFromHeaders(['id', 'x'])).toEqual([{ key: 'id' }, { key: 'x' }])
  })

  it('an empty dataset has something to type into', () => {
    const e = emptyDataset()
    expect(e.data.columns.length).toBe(3)
    expect(e.data.rows).toEqual([[null, null, null]])
  })
})

describe('reading', () => {
  it('infers a column kind from its values, text on a mix', () => {
    const d: DatasetData = { columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd', kind: 'text' }], rows: [[1, 'x', true, 5], [2, 3, null, 6], [null, null, false, 7]] }
    expect(inferColumnKind(d, 0)).toBe('number')
    expect(inferColumnKind(d, 1)).toBe('text')
    expect(inferColumnKind(d, 2)).toBe('boolean')
    expect(inferColumnKind(d, 3)).toBe('text')
  })

  it('describes shape and origin', () => {
    expect(describeDataset(table())).toBe('3 rows × 2 columns')
    expect(describeDataset({ ...table(), source: { kind: 'script', scriptId: 's', ranAt: 't' } }, 'Degrees')).toBe('3 rows × 2 columns · by Degrees')
    expect(describeDataset({ columns: [{ key: 'a' }], rows: [[1]], source: { kind: 'csv', filename: 'x.csv', importedAt: 't' } })).toBe('1 row × 1 column · from x.csv')
  })

  it('cells as text and back', () => {
    expect(cellText(null)).toBe('')
    expect(cellText(1.5)).toBe('1.5')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(parseCell('', 'number')).toBeNull()
    expect(parseCell('3', undefined)).toBe(3)
    expect(parseCell('3', 'text')).toBe('3')
    expect(parseCell('true', undefined)).toBe(true)
    expect(parseCell('[1,2]', 'json')).toEqual([1, 2])
  })

  it('records key the cells by column', () => {
    expect(datasetRecords(table())).toEqual([{ name: 'a', n: 1 }, { name: 'b', n: 2 }, { name: 'c', n: null }])
  })
})

describe('editing (pure)', () => {
  it('sets a cell without touching the rest', () => {
    const d = table()
    const n = setCell(d, 1, 1, 20)
    expect(n.rows[1]).toEqual(['b', 20])
    expect(n.rows[0]).toBe(d.rows[0])
    expect(d.rows[1][1]).toBe(2)
    expect(setCell(d, 9, 0, 1)).toBe(d)
  })

  it('inserts and deletes rows', () => {
    const d = insertRow(table(), 1, ['z'])
    expect(d.rows).toEqual([['a', 1], ['z', null], ['b', 2], ['c', null]])
    expect(insertRow(table()).rows[3]).toEqual([null, null])
    expect(deleteRows(d, [0, 2]).rows).toEqual([['z', null], ['c', null]])
  })

  it('inserts, renames, moves and deletes columns, keeping keys unique and every row square', () => {
    let d = insertColumn(table(), { label: 'Name' }, 0, 'x')
    expect(d.columns[0]).toEqual({ key: 'name_2', label: 'Name' })
    expect(d.rows[0]).toEqual(['x', 'a', 1])
    d = updateColumn(d, 0, { label: 'First', kind: 'text' })
    expect(d.columns[0]).toEqual({ key: 'name_2', label: 'First', kind: 'text' })
    d = updateColumn(d, 0, { kind: undefined })
    expect(d.columns[0].kind).toBeUndefined()
    d = moveColumn(d, 0, 2)
    expect(d.columns.map((c) => c.key)).toEqual(['name', 'n', 'name_2'])
    expect(d.rows[0]).toEqual(['a', 1, 'x'])
    d = deleteColumn(d, 1)
    expect(d.columns.map((c) => c.key)).toEqual(['name', 'name_2'])
    expect(d.rows[1]).toEqual(['b', 'x'])
  })

  it('sorts by a column, numbers first, nulls last, stably', () => {
    const d: DatasetData = { columns: [{ key: 'v' }, { key: 'i' }], rows: [['b', 1], [null, 2], [3, 3], ['a', 4], [1, 5], ['b', 6]] }
    expect(sortRows(d, 0).rows.map((r) => r[1])).toEqual([5, 3, 4, 1, 6, 2])
    expect(sortRows(d, 0, 'desc').rows.map((r) => r[1])).toEqual([1, 6, 4, 3, 5, 2])
  })
})

describe('a script dataset', () => {
  it('is made once per script and refreshed by a rerun, keeping the name a person gave it', () => {
    const store = new EntityStore()
    const script = { id: 'script-1', label: 'Degrees' }
    const first = datasetFromScript(store, script, { columns: ['id', 'degree'], rows: [['a', 3]] })
    expect(first.label).toBe('Degrees')
    expect(first.data.source).toMatchObject({ kind: 'script', scriptId: 'script-1' })
    expect(first.meta.source).toBe('script')
    store.upsert(first)
    store.update(first.id, { label: 'Node degrees', description: 'by hand' })
    const again = datasetFromScript(store, script, { columns: ['id', 'degree'], rows: [['a', 4], ['b', 1]] })
    expect(again.id).toBe(first.id)
    expect(again.label).toBe('Node degrees')
    expect(again.description).toBe('by hand')
    expect(again.data.rows).toEqual([['a', 4], ['b', 1]])
    // A different table from the same script, named, is another dataset.
    const other = datasetFromScript(store, script, { columns: ['x'], rows: [] }, { label: 'Other' })
    expect(other.id).not.toBe(first.id)
  })
})

describe('CSV', () => {
  it('reads a header and typed cells, and writes labels and cells back', () => {
    const d = datasetFromCsv('Name,Count,Flag\n"a, b",1,true\nc,,false\n')
    expect(d.columns).toEqual([{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count' }, { key: 'flag', label: 'Flag' }])
    expect(d.rows).toEqual([['a, b', 1, true], ['c', null, false]])
    expect(datasetToCsv(d)).toBe('Name,Count,Flag\n"a, b",1,true\nc,,false\n')
  })
})

describe('dataset kinds', () => {
  it('a dataset read from a file or CSV is a subtype of dataset, and every list takes the whole family', async () => {
    const { EntityStore } = await import('../../entity/store')
    const { getEntityType } = await import('../../entity/schema')
    const { DATASET_FAMILY, datasetEntity, datasetKindOf, datasetTypeOf, datasetsIn, emptyDataset, isDataset, isDatasetType } = await import('../dataset')
    const at = '2026-09-28T00:00:00Z'
    const file = (format: 'csv' | 'tsv' | 'txt' | 'xlsx' | 'parquet') => ({ kind: 'file' as const, filename: `f.${format}`, format, importedAt: at })
    expect(datasetTypeOf(file('csv'))).toBe('dataset:csv')
    expect(datasetTypeOf(file('tsv'))).toBe('dataset:tsv')
    expect(datasetTypeOf(file('txt'))).toBe('dataset:text')
    expect(datasetTypeOf(file('xlsx'))).toBe('dataset:excel')
    expect(datasetTypeOf(file('parquet'))).toBe('dataset:parquet')
    expect(datasetTypeOf({ kind: 'csv', importedAt: at })).toBe('dataset:csv')
    expect(datasetTypeOf({ kind: 'hand' })).toBe('dataset')
    expect(datasetTypeOf({ kind: 'script', scriptId: 's', ranAt: at })).toBe('dataset')
    // Each subtype is in the ontology under `dataset`, so tables, the inspector and scripts' `types` treat it as one.
    for (const t of DATASET_FAMILY.slice(1)) {
      expect(getEntityType(t)?.parent).toBe('dataset')
      expect(isDatasetType(t)).toBe(true)
    }
    expect(datasetKindOf('dataset:excel')).toBe('excel')
    expect(datasetKindOf('dataset')).toBeUndefined()

    const sheet = datasetEntity({ columns: [{ key: 'a' }], rows: [[1]], source: file('xlsx') }, { label: 'Book · Sheet1' })
    const typed = emptyDataset('Typed')
    expect(sheet.type).toBe('dataset:excel')
    expect(typed.type).toBe('dataset')
    expect(isDataset(sheet)).toBe(true)
    // An edit keeps the kind: the table changed, not what it was read from.
    const edited = datasetEntity({ ...sheet.data, rows: [[2]] }, { label: 'Book · Sheet1', existing: sheet })
    expect(edited.type).toBe('dataset:excel')
    const store = new EntityStore()
    store.upsertMany([sheet, typed])
    expect(datasetsIn(store).map((e) => e.id).sort()).toEqual([sheet.id, typed.id].sort())
  })
})

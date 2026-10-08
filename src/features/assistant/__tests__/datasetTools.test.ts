import { describe, expect, it, vi } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { DATASET_TYPE, isDataset } from '../../../core/datasets/dataset'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createDatasetTools } from '../datasetTools'
import type { AppHost } from '../tools'

/**
 * The dataset tool: making one from columns and rows or CSV, reading it
 * back, the edits (cells read by kind, rows, columns, a sort), a saved
 * script's table kept and refreshed as the same dataset, and the errors
 * a caller can fix.
 */
vi.mock('../../scripts/runner', () => ({
  runScript: async (_store: unknown, _registry: unknown, code: string) => {
    if (code.includes('NOTABLE')) return { value: 'just text', logs: [], ms: { load: 0, run: 1, snapshot: 0 } }
    if (code.includes('THROW')) return { value: undefined, logs: [], error: { message: 'boom' }, ms: { load: 0, run: 1, snapshot: 0 } }
    const n = code.includes('TWO') ? 2 : 1
    return { value: { table: { columns: ['id', 'degree'], rows: Array.from({ length: n }, (_, i) => [`n${i}`, i + 1]) } }, logs: [], ms: { load: 0, run: 1, snapshot: 0 } }
  },
}))

function setup() {
  const store = new EntityStore()
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createDatasetTools(host)
  const t = tools.find((x) => x.name === 'dataset') as BetaRunnableTool
  const run = async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  return { store, navigated, run }
}

describe('dataset tool', () => {
  it('creates from columns and rows, lists, reads back paged and as records', async () => {
    const { store, run } = setup()
    const made = await run({ action: 'create', name: 'Sizes', columns: ['Name', 'Size'], rows: [['a', 1], ['b', 2], ['c', 3]] })
    expect(made.created).toBe(true)
    expect(made.columns).toEqual([{ key: 'name', label: 'Name', kind: 'text' }, { key: 'size', label: 'Size', kind: 'number' }])
    expect(store.ofType(DATASET_TYPE)).toHaveLength(1)
    const list = await run({ action: 'list' })
    expect(list.datasets[0]).toMatchObject({ label: 'Sizes', rows: 3, summary: '3 rows × 2 columns' })
    const page = await run({ action: 'get', id: made.id, offset: 1, limit: 1 })
    expect(page.rows).toEqual([['b', 2]])
    expect(page.returned).toBe(1)
    const recs = await run({ action: 'get', id: made.id, records: true })
    expect(recs.rows).toEqual([{ name: 'a', size: 1 }, { name: 'b', size: 2 }, { name: 'c', size: 3 }])
  })

  it('creates from CSV', async () => {
    const { run } = setup()
    const made = await run({ action: 'create', name: 'From CSV', csv: 'x,y\n1,2\n3,4\n' })
    expect(made.rows).toBe(2)
    expect(made.source.kind).toBe('csv')
    expect(made.type).toBe('dataset:csv') // what it was read from is its subtype
    const got = await run({ action: 'get', id: made.id })
    expect(got.rows).toEqual([[1, 2], [3, 4]])
  })

  it('creates from delimited text with another separator, and with no header row', async () => {
    const { run } = setup()
    const semi = await run({ action: 'create', name: 'Semi', csv: 'a;b\n"1;5";2\n', delimiter: 'semicolon', open: false })
    expect((await run({ action: 'get', id: semi.id })).rows).toEqual([['1;5', 2]])
    const bare = await run({ action: 'create', name: 'Bare', csv: '1\t2\n3\t4\n', delimiter: '\t', header: false, open: false })
    expect(bare.columns.map((c: { key: string }) => c.key)).toEqual(['a', 'b'])
    expect(bare.rows).toBe(2)
    await expect(run({ action: 'create', name: 'X', csv: 'a\n1', delimiter: '"' })).rejects.toThrow(/quote or a line break/)
  })

  it('creates from a whole file as a data: URL — named after it, read by its extension, bounded like an attachment', async () => {
    const { store, navigated, run } = setup()
    const tsv = `data:text/tab-separated-values;base64,${Buffer.from('city\tpop\nOslo\t709037\n').toString('base64')}`
    const made = await run({ action: 'create', file: tsv, filename: 'cities.tsv' })
    expect(made.created).toBe(1)
    expect(made.datasets[0]).toMatchObject({ label: 'cities', rows: 1, source: { kind: 'file', filename: 'cities.tsv', format: 'tsv' }, summary: '1 row × 2 columns · from cities.tsv' })
    expect(navigated).toEqual([`/analytics/datasets?id=${encodeURIComponent(made.datasets[0].id)}`])
    const txt = `data:text/plain,${encodeURIComponent('x|y\n1|2\n')}`
    const piped = await run({ action: 'create', file: txt, filename: 'log.txt', delimiter: '|', name: 'Log', open: false })
    const e = store.get(piped.datasets[0].id)
    expect(isDataset(e) && [e.label, e.data.rows]).toEqual(['Log', [[1, 2]]])
    expect([made.datasets[0].type, e?.type]).toEqual(['dataset:tsv', 'dataset:text'])
    // Listed with every other dataset, whatever its subtype.
    const listed = (await run({ action: 'list' })).datasets.map((d: { id: string; type: string }) => d.type).sort()
    expect(listed).toEqual(['dataset:text', 'dataset:tsv'])
    await expect(run({ action: 'create', file: tsv })).rejects.toThrow(/needs filename/)
    await expect(run({ action: 'create', file: 'https://example.com/a.csv', filename: 'a.csv' })).rejects.toThrow(/must be a data: URL/)
    await expect(run({ action: 'create', file: tsv, filename: 'paper.pdf' })).rejects.toThrow(/not a file a dataset is read from/)
  })

  it('edits: cells read by the column kind, rows, columns, a sort', async () => {
    const { store, run } = setup()
    const { id } = await run({ action: 'create', name: 'T', columns: ['name', 'n'], rows: [['a', 3], ['b', 1]] })
    await run({ action: 'set', id, cells: [{ row: 0, col: 'n', value: '10' }, { row: 1, col: 1, value: null }] })
    let e = store.get(id)
    expect(isDataset(e) && e.data.rows).toEqual([['a', 10], ['b', null]])
    await run({ action: 'add_rows', id, rows: [['c', '7']] })
    await run({ action: 'add_column', id, label: 'Flag', kind: 'boolean', fill: false })
    e = store.get(id)
    expect(isDataset(e) && e.data.columns.map((c) => c.key)).toEqual(['name', 'n', 'flag'])
    expect(isDataset(e) && e.data.rows[2]).toEqual(['c', 7, false])
    await run({ action: 'update_column', id, column: 'flag', label: 'Kept', description: 'whether to keep it' })
    await run({ action: 'move_column', id, column: 'Kept', to: 0 })
    e = store.get(id)
    expect(isDataset(e) && e.data.columns[0]).toEqual({ key: 'flag', label: 'Kept', kind: 'boolean', description: 'whether to keep it' })
    const sorted = await run({ action: 'sort', id, column: 'n', dir: 'desc' })
    expect(sorted.head.map((r: string[]) => r[1])).toEqual(['a', 'c', 'b'])
    await run({ action: 'delete_rows', id, indices: [2] })
    await run({ action: 'delete_column', id, column: 0 })
    e = store.get(id)
    expect(isDataset(e) && e.data.rows).toEqual([['a', 10], ['c', 7]])
    await run({ action: 'rename', id, name: 'Sizes', description: 'by hand' })
    expect(store.get(id)?.label).toBe('Sizes')
  })

  it('keeps a saved script\'s table as its dataset and refreshes the same one on the next run', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: 'script-1', type: 'script', label: 'Degrees', data: { code: 'return table(...)', language: 'js' } }))
    const first = await run({ action: 'from_script', script: 'script-1' })
    expect(first.created).toBe(true)
    expect(first.label).toBe('Degrees')
    expect(first.script).toEqual({ id: 'script-1', label: 'Degrees' })
    expect(first.rows).toBe(1)
    store.update('script-1', { data: { code: 'TWO', language: 'js' } })
    const again = await run({ action: 'from_script', script: 'script-1' })
    expect(again.updated).toBe(true)
    expect(again.id).toBe(first.id)
    expect(again.rows).toBe(2)
    expect(store.ofType(DATASET_TYPE)).toHaveLength(1)
  })

  it('says when a script has no table, and when a column or row is not there', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: 's2', type: 'script', label: 'Text', data: { code: 'NOTABLE', language: 'js' } }))
    await expect(run({ action: 'from_script', script: 's2' })).rejects.toThrow(/returned no table/)
    store.upsert(createEntity({ id: 's3', type: 'script', label: 'Broken', data: { code: 'THROW', language: 'js' } }))
    expect(await run({ action: 'from_script', script: 's3' })).toMatchObject({ error: 'boom' })
    await expect(run({ action: 'from_script', script: 'nope' })).rejects.toThrow(/No script/)
    const { id } = await run({ action: 'create', name: 'T', columns: ['a'], rows: [[1]] })
    await expect(run({ action: 'set', id, cells: [{ row: 0, col: 'zz', value: 1 }] })).rejects.toThrow(/No column "zz"/)
    await expect(run({ action: 'set', id, cells: [{ row: 5, col: 'a', value: 1 }] })).rejects.toThrow(/out of range/)
    await expect(run({ action: 'delete_column', id, column: 'a' })).rejects.toThrow(/at least one column/)
    await expect(run({ action: 'get', id: 'missing' })).rejects.toThrow(/No dataset/)
  })

  it('opens what it makes, unless told not to', async () => {
    const { navigated, run } = setup()
    const made = await run({ action: 'create', name: 'Random', columns: ['x'], rows: [[1]] })
    expect(made.opened).toBe(`/analytics/datasets?id=${made.id}`)
    expect(navigated).toEqual([made.opened])
    const quiet = await run({ action: 'create', name: 'Quiet', csv: 'x\n1\n', open: false })
    expect(quiet.opened).toBeUndefined()
    expect(navigated).toHaveLength(1)
  })

  it('opens the page and deletes with confirmation', async () => {
    const { store, navigated, run } = setup()
    const { id } = await run({ action: 'create', name: 'T', columns: ['a'], open: false })
    const opened = await run({ action: 'open', id })
    expect(navigated).toEqual([`/analytics/datasets?id=${id}`])
    expect(opened.onScreen).toBe(false)
    const gone = await run({ action: 'delete', id })
    expect(gone.deleted).toBe(true)
    expect(store.has(id)).toBe(false)
  })
})

describe('dataset tool › from_entities', () => {
  it('makes a dataset of the entities a selector names, over the whole dataset, with their fields as columns', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: 'type:tree', type: 'schema:type', label: 'Tree', data: { name: 'tree', properties: [{ key: 'dbh', label: 'Trunk diameter (cm)', kind: 'number' }] } }))
    for (let i = 0; i < 5; i++) store.upsert(createEntity({ id: `tree:${i}`, type: 'tree', label: `Tree ${i}`, tags: [i % 2 ? 'genus:acer' : 'genus:quercus'], data: { dbh: 10 * i } }))
    store.upsert(createEntity({ id: 'p1', type: 'person', label: 'Someone' }))
    const made = await run({ action: 'from_entities', selector: { types: ['tree'] }, name: 'All the trees' })
    expect(made.created).toBe(true)
    expect(made.rows).toBe(5)
    expect(made.columns.map((c: { key: string }) => c.key)).toEqual(['id', 'label', 'type', 'tags', 'dbh'])
    expect(made.columns.find((c: { key: string }) => c.key === 'dbh')).toMatchObject({ label: 'Trunk diameter (cm)', kind: 'number' })
    const got = await run({ action: 'get', id: made.id, records: true, limit: 2 })
    expect(got.rows[0]).toEqual({ id: 'tree:0', label: 'Tree 0', type: 'tree', tags: ['genus:quercus'], dbh: 0 })
    const e = store.get(made.id)
    expect(isDataset(e) && e.data.source).toMatchObject({ kind: 'entities', count: 5, selector: expect.stringContaining('tree') })
    // A tag narrows it; chosen columns are kept in order; a selector matching nothing is an error a caller can fix.
    const oaks = await run({ action: 'from_entities', selector: { types: ['tree'], tags: ['genus:quercus'] }, columns: ['label', 'data.dbh'] })
    expect(oaks.rows).toBe(3)
    expect(oaks.columns.map((c: { key: string }) => c.key)).toEqual(['label', 'dbh'])
    await expect(run({ action: 'from_entities', selector: { types: ['rock'] } })).rejects.toThrow(/No entities match/)
  })
})

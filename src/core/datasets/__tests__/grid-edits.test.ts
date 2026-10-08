import { describe, expect, it } from 'vitest'
import { blockEdge, clearRange, deleteColumns, fillRange, insertColumn, insertColumns, insertRows, nextColumnKey, normalizeRange, parseClipboardBlock, pasteBlock, rangeToTsv, setCells, type DatasetData } from '../dataset'
import { cellDiff, EditHistory } from '../../../features/analytics/grid/history'

/**
 * The grid's bulk edits: many cells in one write with the untouched rows
 * shared, a range cleared, filled, copied as tab-separated text, a pasted
 * block that grows the table or fills a range, the clipboard read three
 * ways, ⌘+arrow's block edge — and the undo that puts each of them back.
 */
const table = (): DatasetData => ({
  columns: [{ key: 'a' }, { key: 'b', kind: 'number' }, { key: 'c' }],
  rows: [
    ['x', 1, null],
    ['y', 2, 'q'],
    [null, null, null],
    ['z', 3, 'r'],
  ],
})

describe('setCells', () => {
  it('writes many cells in one pass and shares the rows it did not touch', () => {
    const d = table()
    const n = setCells(d, [
      { r: 0, c: 0, value: 'X' },
      { r: 0, c: 2, value: 'new' },
      { r: 3, c: 1, value: 30 },
    ])
    expect(n.rows[0]).toEqual(['X', 1, 'new'])
    expect(n.rows[3]).toEqual(['z', 30, 'r'])
    expect(n.rows[1]).toBe(d.rows[1])
    expect(n.rows[2]).toBe(d.rows[2])
    expect(d.rows[0]).toEqual(['x', 1, null])
  })
  it('is the same data when nothing changes, and ignores cells off the table', () => {
    const d = table()
    expect(setCells(d, [{ r: 0, c: 0, value: 'x' }])).toBe(d)
    expect(setCells(d, [{ r: 9, c: 0, value: 'x' }, { r: 0, c: 9, value: 'x' }])).toBe(d)
  })
})

describe('ranges', () => {
  it('normalizes corners and clips to the table', () => {
    expect(normalizeRange({ r0: 3, c0: 2, r1: 1, c1: 0 }, table())).toEqual({ r0: 1, c0: 0, r1: 3, c1: 2 })
    expect(normalizeRange({ r0: -5, c0: 0, r1: 99, c1: 99 }, table())).toEqual({ r0: 0, c0: 0, r1: 3, c1: 2 })
  })
  it('clears a range to nulls, copies one as TSV, fills down and right', () => {
    const d = table()
    expect(clearRange(d, { r0: 0, c0: 0, r1: 1, c1: 1 }).rows.slice(0, 2)).toEqual([[null, null, null], [null, null, 'q']])
    expect(rangeToTsv(d, { r0: 0, c0: 0, r1: 1, c1: 2 })).toBe('x\t1\t\ny\t2\tq')
    expect(fillRange(d, { r0: 0, c0: 0, r1: 3, c1: 1 }, 'down').rows.map((r) => r.slice(0, 2))).toEqual([['x', 1], ['x', 1], ['x', 1], ['x', 1]])
    expect(fillRange(d, { r0: 1, c0: 0, r1: 1, c1: 2 }, 'right').rows[1]).toEqual(['y', 'y', 'y'])
  })
  it('a tab or a newline inside a cell does not break the block', () => {
    const d = setCells(table(), [{ r: 0, c: 0, value: 'a\tb\nc' }])
    expect(rangeToTsv(d, { r0: 0, c0: 0, r1: 0, c1: 1 })).toBe('a b c\t1')
  })
})

describe('the clipboard', () => {
  it('reads tab-separated blocks, CSV that parses to rows of one width, and plain lines', () => {
    expect(parseClipboardBlock('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseClipboardBlock('a,b\nc,"d,e"\n')).toEqual([['a', 'b'], ['c', 'd,e']])
    expect(parseClipboardBlock('one\ntwo')).toEqual([['one'], ['two']])
    expect(parseClipboardBlock('a, b\nc\n')).toEqual([['a, b'], ['c']])
    expect(parseClipboardBlock('')).toEqual([['']])
  })
  it('pastes a block at a cell, growing rows and columns to fit, reading values by the column', () => {
    const r = pasteBlock(table(), [['7', 'true'], ['8', 'false'], ['9', 'x']], { r: 2, c: 1 })
    expect(r.rows).toBe(3)
    expect(r.cols).toBe(2)
    expect(r.data.rows.length).toBe(5)
    expect(r.data.rows[2]).toEqual([null, 7, true])
    expect(r.data.rows[4]).toEqual([null, 9, 'x'])
    const wide = pasteBlock(table(), [['1', '2', '3', '4']], { r: 0, c: 1 })
    expect(wide.data.columns.length).toBe(5)
    expect(wide.data.rows[0]).toEqual(['x', 1, 2, 3, 4])
    expect(wide.data.rows[1].length).toBe(5)
  })
  it('a single value pasted over a selection fills the selection', () => {
    const r = pasteBlock(table(), [['0']], { r: 0, c: 1 }, { r0: 0, c0: 1, r1: 3, c1: 1 })
    expect(r.data.rows.map((x) => x[1])).toEqual([0, 0, 0, 0])
    expect(r.rows).toBe(4)
  })
})

describe('rows and columns', () => {
  it('inserts several blank rows and deletes several columns, never the last', () => {
    const d = insertRows(table(), 2, 1)
    expect(d.rows.length).toBe(6)
    expect(d.rows[1]).toEqual([null, null, null])
    expect(d.rows[3]).toEqual(['y', 2, 'q'])
    expect(deleteColumns(table(), [0, 2]).columns.map((c) => c.key)).toEqual(['b'])
    const t = table()
    expect(deleteColumns(t, [0, 1, 2])).toBe(t)
  })
  it('a column added without a name takes the next letter, as does one a paste grows the table by', () => {
    expect(nextColumnKey(table())).toBe('d')
    expect(insertColumn(table(), {}).columns.map((c) => c.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(insertColumn(table(), {}, 0).columns.map((c) => c.key)).toEqual(['d', 'a', 'b', 'c'])
    expect(insertColumn(table(), { label: 'Total' }).columns.at(-1)).toEqual({ key: 'total', label: 'Total' })
    expect(pasteBlock(table(), [['1', '2', '3', '4']], { r: 0, c: 1 }).data.columns.map((c) => c.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
    const z: DatasetData = { columns: Array.from({ length: 26 }, (_, i) => ({ key: String.fromCharCode(97 + i) })), rows: [] }
    expect(nextColumnKey(z)).toBe('aa')
    expect(nextColumnKey({ columns: [{ key: 'a' }, { key: 'c' }], rows: [] })).toBe('b')
    const three = insertColumns(table(), 3, 1)
    expect(three.columns.map((c) => c.key)).toEqual(['a', 'd', 'e', 'f', 'b', 'c'])
    expect(three.rows[1]).toEqual(['y', null, null, null, 2, 'q'])
    const t = table()
    expect(insertColumns(t, 0)).toBe(t)
  })
})

describe('the block edge (⌘+arrow)', () => {
  it('goes to the end of the filled block, past blanks to the next filled cell, or to the edge', () => {
    const d = table()
    expect(blockEdge(d, { r: 0, c: 0 }, 1, 0)).toEqual({ r: 1, c: 0 })
    expect(blockEdge(d, { r: 1, c: 0 }, 1, 0)).toEqual({ r: 3, c: 0 })
    expect(blockEdge(d, { r: 3, c: 0 }, 1, 0)).toEqual({ r: 3, c: 0 })
    expect(blockEdge(d, { r: 0, c: 0 }, 0, 1)).toEqual({ r: 0, c: 1 })
    expect(blockEdge(d, { r: 0, c: 1 }, 0, 1)).toEqual({ r: 0, c: 2 })
  })
})

describe('undo and redo', () => {
  it('puts cell edits back through patches and shape edits back whole', () => {
    const h = new EditHistory()
    const d0 = table()
    const d1 = setCells(d0, [{ r: 0, c: 0, value: 'X' }, { r: 1, c: 2, value: null }])
    h.push({ kind: 'cells', ...cellDiff(d0, d1) })
    const d2 = insertRows(d1, 1, 0)
    h.push({ kind: 'shape', before: d1, after: d2 })
    expect(h.canUndo).toBe(true)
    const u1 = h.undo(d2)!
    expect(u1).toBe(d1)
    const u2 = h.undo(u1)!
    expect(u2.rows[0]).toEqual(['x', 1, null])
    expect(u2.rows[1]).toEqual(['y', 2, 'q'])
    expect(h.canUndo).toBe(false)
    const r1 = h.redo(u2)!
    expect(r1.rows[0][0]).toBe('X')
    expect(r1.rows[1][2]).toBe(null)
    expect(h.redo(r1)).toBe(d2)
    expect(h.canRedo).toBe(false)
  })
  it('a new edit after an undo drops the redo line', () => {
    const h = new EditHistory()
    const d0 = table()
    const d1 = setCells(d0, [{ r: 0, c: 0, value: 'X' }])
    h.push({ kind: 'cells', ...cellDiff(d0, d1) })
    h.undo(d1)
    h.push({ kind: 'cells', ...cellDiff(d0, setCells(d0, [{ r: 0, c: 0, value: 'Y' }])) })
    expect(h.canRedo).toBe(false)
  })
})

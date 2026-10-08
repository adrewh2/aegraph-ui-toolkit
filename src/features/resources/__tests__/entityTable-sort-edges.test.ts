import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import type { FieldDef } from '../../../core/entity/schema'
import { EntityStore } from '../../../core/entity/store'
import type { AnyEntity } from '../../../core/entity/types'
import '../../../core/resources/types'
import { sortRows } from '../EntityTable'

/**
 * The table's sort at its edges: missing values in either direction, a
 * text column holding numbers and words, ties, a sort key the rows or
 * the columns no longer have, dates and numbers that do not parse,
 * booleans, references sorted by what the cell shows, tags, and the
 * point past which string sorts leave the collator.
 */
const store = new EntityStore()
const row = (id: string, data: Record<string, unknown> = {}, more: Partial<AnyEntity> = {}) => createEntity({ id, type: 'note', label: id, data, ...more }) as AnyEntity
const ids = (rows: AnyEntity[]) => rows.map((r) => r.id)
const num: FieldDef = { key: 'data.n', label: 'N', kind: 'number' }
const txt: FieldDef = { key: 'data.t', label: 'T', kind: 'text' }
const date: FieldDef = { key: 'data.d', label: 'D', kind: 'date' }

describe('table sort edges', () => {
  it('sinks missing values to the bottom whichever way the column is sorted — null, undefined and the empty string alike; 0 and negatives are values', () => {
    const rows = [row('a', { n: 0 }), row('b'), row('c', { n: -5 }), row('d', { n: null }), row('e', { n: 3 }), row('f', { n: '' })]
    expect(ids(sortRows(rows, 'data.n', num, 'asc', store))).toEqual(['c', 'a', 'e', 'b', 'd', 'f'])
    expect(ids(sortRows(rows, 'data.n', num, 'desc', store))).toEqual(['e', 'a', 'c', 'b', 'd', 'f'])
    const words = [row('a', { t: '' }), row('b', { t: 'beta' }), row('c'), row('d', { t: 'alpha' })]
    expect(ids(sortRows(words, 'data.t', txt, 'asc', store))).toEqual(['d', 'b', 'a', 'c'])
    expect(ids(sortRows(words, 'data.t', txt, 'desc', store))).toEqual(['b', 'd', 'a', 'c'])
  })

  it('orders a text column holding numbers and words as a reader would: numerically among numbers, then the words, case ignored', () => {
    const rows = [row('a', { t: 'Beta' }), row('b', { t: 10 }), row('c', { t: '9' }), row('d', { t: 2 }), row('e', { t: 'alpha' }), row('f', { t: 'a10' }), row('g', { t: 'a9' })]
    expect(ids(sortRows(rows, 'data.t', txt, 'asc', store))).toEqual(['d', 'c', 'b', 'g', 'f', 'e', 'a'])
    expect(ids(sortRows(rows, 'data.t', txt, 'desc', store))).toEqual(['a', 'e', 'f', 'g', 'b', 'c', 'd'])
  })

  it('keeps ties in the order the rows came, ascending and descending, and leaves the order alone under a key nothing has', () => {
    const rows = [row('x1', { n: 1 }), row('y2', { n: 2 }), row('x2', { n: 1 }), row('y1', { n: 2 }), row('x3', { n: 1 })]
    expect(ids(sortRows(rows, 'data.n', num, 'asc', store))).toEqual(['x1', 'x2', 'x3', 'y2', 'y1'])
    expect(ids(sortRows(rows, 'data.n', num, 'desc', store))).toEqual(['y2', 'y1', 'x1', 'x2', 'x3'])
    expect(ids(sortRows(rows, 'data.gone', undefined, 'asc', store))).toEqual(ids(rows))
    expect(ids(sortRows(rows, 'data.gone', undefined, 'desc', store))).toEqual(ids(rows))
    expect(sortRows([], 'data.n', num, 'asc', store)).toEqual([])
  })

  it('a remembered sort on a column the table no longer has still sorts by the raw value as text, and never throws', () => {
    const rows = [row('a', { n: 10 }), row('b', { n: 9 }), row('c', { n: { deep: true } }), row('d', { n: [2, 1] })]
    // No column definition: the value's text under the numeric collator, which ranks punctuation before digits — so "[object Object]" leads, then "2,1", 9, 10.
    expect(ids(sortRows(rows, 'data.n', undefined, 'asc', store))).toEqual(['c', 'd', 'b', 'a'])
    expect(ids(sortRows(rows, 'label', undefined, 'desc', store))).toEqual(['d', 'c', 'b', 'a'])
  })

  it('a date or number that does not parse sinks with the missing rather than scrambling the rest', () => {
    const dates = [row('a', { d: '2024-01-03' }), row('b', { d: 'garbage' }), row('c', { d: '2024-01-01' }), row('d', { d: '2024-01-02' }), row('e', { d: 'yesterday' }), row('f')]
    expect(ids(sortRows(dates, 'data.d', date, 'asc', store))).toEqual(['c', 'd', 'a', 'b', 'e', 'f'])
    expect(ids(sortRows(dates, 'data.d', date, 'desc', store))).toEqual(['a', 'd', 'c', 'b', 'e', 'f'])
    const nums = [row('a', { n: '3' }), row('b', { n: 'many' }), row('c', { n: 1 }), row('d', { n: '2e0' }), row('e', { n: NaN }), row('f', { n: true })]
    // Numeric strings count, and a boolean reads as 0/1 (Number); words and NaN are no value.
    expect(ids(sortRows(nums, 'data.n', num, 'asc', store))).toEqual(['c', 'f', 'd', 'a', 'b', 'e'])
  })

  it('booleans sort false before true, availability likewise; references and reference types by the label the cell shows, a dangling one at the bottom; tags by their text', () => {
    const bool: FieldDef = { key: 'data.b', label: 'B', kind: 'boolean' }
    const rows = [row('a', { b: true }), row('b', { b: false }), row('c'), row('d', { b: true })]
    expect(ids(sortRows(rows, 'data.b', bool, 'asc', store))).toEqual(['b', 'a', 'd', 'c'])
    expect(ids(sortRows(rows, 'data.b', bool, 'desc', store))).toEqual(['a', 'd', 'b', 'c'])
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'z', type: 'note', label: 'Apple' }),
      createEntity({ id: 'a', type: 'document', label: 'Zebra' }),
      createEntity({ id: 'type:document', type: 'schema:type', label: 'Paper', data: { name: 'document' } }),
    ])
    const rels = [
      createRelationship({ id: 'r1', type: 'r', source: 'a', target: 'z' }),
      createRelationship({ id: 'r2', type: 'r', source: 'z', target: 'a' }),
      createRelationship({ id: 'r3', type: 'r', source: 'nobody', target: 'a' }),
    ] as AnyEntity[]
    const ref: FieldDef = { key: 'source', label: 'Source', kind: 'ref' }
    // By label: z is "Apple", a is "Zebra" — the ids would say the opposite.
    expect(ids(sortRows(rels, 'source', ref, 'asc', s))).toEqual(['r2', 'r1', 'r3'])
    const refType: FieldDef = { key: 'source.type', label: 'Source type', kind: 'ref-type' }
    // Types by their schema label: "Note" (humanised) before "Paper" (the schema entity's label for document).
    expect(ids(sortRows(rels, 'source.type', refType, 'asc', s))).toEqual(['r2', 'r1', 'r3'])
    const tags: FieldDef = { key: 'tags', label: 'Tags', kind: 'tags' }
    const tagged = [row('a', {}, { tags: ['zeta'] }), row('b', {}, { tags: [] }), row('c', {}, { tags: ['alpha', 'zeta'] }), row('d', {}, { tags: ['Beta'] })]
    expect(ids(sortRows(tagged, 'tags', tags, 'asc', store))).toEqual(['c', 'd', 'a', 'b'])
  })

  it('past fifty thousand rows a text sort leaves the collator for code units — a10 then before a9 — and stays quick', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row(`r${i}`, { t: `a${(i * 7919) % n}` }))
    const small = sortRows(many(50_000), 'data.t', txt, 'asc', store)
    const firstTen = (rows: AnyEntity[]) => rows.slice(0, 10).map((r) => r.data.t)
    expect(firstTen(small)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
    const t0 = performance.now()
    const big = sortRows(many(50_001), 'data.t', txt, 'asc', store)
    const ms = performance.now() - t0
    expect(firstTen(big)).toEqual(['a0', 'a1', 'a10', 'a100', 'a1000', 'a10000', 'a10001', 'a10002', 'a10003', 'a10004'])
    expect(big.length).toBe(50_001)
    expect(ms).toBeLessThan(5000)
    // A number column at that size is numeric whatever the count.
    const nums = sortRows(Array.from({ length: 60_000 }, (_, i) => row(`n${i}`, { n: (i * 7919) % 60_000 })), 'data.n', num, 'desc', store)
    expect(nums.slice(0, 3).map((r) => r.data.n)).toEqual([59_999, 59_998, 59_997])
  })
})

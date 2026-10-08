import { describe, expect, it } from 'vitest'
import { parseAtlas, type AtlasFile } from '../atlas'
import { parseChatGpt } from '../chatgpt'
import { CSV_COLUMNS, CSV_MAX_FIELDS, CsvParser, CsvTooWideError, csvRowToEntity } from '../formats'

/** Imports read files someone else wrote: a field count, a tree's shape and a date are all the file's to choose. */
describe('the CSV parser', () => {
  it('counts a row past maxFields without keeping its fields, refusing it where it ends, and refuses fields past maxCells at once', () => {
    const rows: string[][] = []
    expect(() => new CsvParser(',', { maxFields: 3 }).push('a,b,c,d\n', (r) => rows.push(r))).toThrow(CsvTooWideError)
    const p = new CsvParser(',', { maxCells: 5 })
    expect(() => p.push('a,b\nc,d\ne,f\n', (r) => rows.push(r))).toThrow(/more than 5 fields in all/)
    // A line of nothing but commas stops at the default, long before it is millions of empty strings.
    const t = performance.now()
    expect(() => new CsvParser().push(','.repeat(5_000_000) + '\n', () => {})).toThrow(new RegExp(`has 5,000,001 fields \\(at most ${CSV_MAX_FIELDS.toLocaleString('en-US')}\\)`))
    expect(performance.now() - t).toBeLessThan(2_000)
  })

  it('finds the columns of a header once, not once per row and column', () => {
    const header = [...Array.from({ length: 5_000 }, (_, i) => `x${i}`), ...CSV_COLUMNS]
    const row = header.map((h) => (h === 'id' ? 'e1' : h === 'label' ? 'One' : ''))
    const t = performance.now()
    for (let i = 0; i < 20_000; i++) csvRowToEntity(header, row)
    expect(performance.now() - t).toBeLessThan(3_000)
    expect(csvRowToEntity(header, row)).toMatchObject({ id: 'e1', label: 'One', kind: 'entity' })
    // The first of a repeated column, as indexOf found it.
    expect(csvRowToEntity(['id', 'label', 'label'], ['a', 'first', 'second'])?.label).toBe('first')
  })
})

describe('the ChatGPT export', () => {
  it('ends the first-child walk on a cycle instead of looping for ever', () => {
    let reads = 0
    const node = (child: string, parent?: string) => ({
      parent,
      get children() {
        if (++reads > 100_000) throw new Error('still walking')
        return [child]
      },
    })
    const { conversations } = parseChatGpt([{ title: 't', mapping: { a: node('b'), b: node('a', 'a') } }])
    expect(conversations).toHaveLength(1)
    expect(reads).toBeLessThan(10)
  })

  it('reads a time no calendar reaches as no time, and an id the mapping does not own as no node', () => {
    const data = [{ title: 'ok', create_time: 1e300, update_time: -1e300, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['hi'] }, create_time: 1e300 } } }, current_node: 'a' }]
    const { conversations } = parseChatGpt(data)
    expect(conversations[0].messages.map((m) => m.content)).toEqual(['hi'])
    expect(conversations[0].messages[0].at).toBeUndefined()
    const odd = parseChatGpt(JSON.parse('[{"title":"t","current_node":"constructor","mapping":{"a":{"children":["toString"]}}}]'))
    expect(odd.conversations[0].messages).toEqual([])
  })
})

describe('the atlas', () => {
  it('falls back to the import time for a time no calendar reaches, and to entity for a type that is not its own name', () => {
    const file = { kind: 'aegraph-atlas', data: { graph: { nodes: [{ id: 'n1', type: 'constructor', userData: { created: 1e300 } }, { id: 'n2', type: {} as unknown as string }], edges: [] }, metadata: { name: 'A' } } } as unknown as AtlasFile
    const parsed = parseAtlas(file)
    const [n1, n2] = parsed.entities
    expect(typeof n1.meta.createdAt).toBe('string')
    expect(n1.type).toBe('constructor')
    expect(n2.type).toBe('entity')
    expect(parsed.entities.every((e) => typeof e.type === 'string')).toBe(true)
  })
})

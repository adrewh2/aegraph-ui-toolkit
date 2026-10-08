import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { serialize } from '../export'
import { CSV_COLUMNS, CsvParser, csvEscape, csvRowToEntity, detectFormat, entityToCsvRow, normalizeEntity, normalizeTagInfo } from '../formats'

/**
 * The exchange formats at their edges: what normalizeEntity makes of a
 * record with only an id or only a label, numbers where strings go, a
 * declared kind against inferred ends, tags in every spelling, data that
 * is not an object, meta partly given or not an object at all, refs with
 * and without selectors, `directed` in every spelling, the legacy type
 * category; tag infos; the CSV row reader with missing, extra and broken
 * columns; the incremental CSV parser on blank lines, line endings, quotes
 * in and out of place and chunk boundaries inside an escape; the format
 * sniffer; and what each text serializer round-trips, including the
 * fields that do not survive CSV.
 */
const parse = (text: string, chunk = text.length) => {
  const p = new CsvParser()
  const rows: string[][] = []
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk), (r) => rows.push(r))
  p.end((r) => rows.push(r))
  return rows
}

describe('normalizeEntity', () => {
  it('takes the least: an id alone, a label alone with a fallback id, numbers as strings, and nothing else', () => {
    const a = normalizeEntity({ id: 'only' })!
    expect(a).toMatchObject({ id: 'only', kind: 'entity', type: 'entity', tags: [], data: {} })
    expect(a).not.toHaveProperty('label')
    expect(a.meta.createdAt).toBe(a.meta.updatedAt)
    expect(Object.keys(a.meta).sort()).toEqual(['createdAt', 'updatedAt'])
    expect(normalizeEntity({ id: 42, type: 7, label: 3.5, description: true })).toMatchObject({ id: '42', type: '7', label: '3.5', description: 'true' })
    expect(normalizeEntity({ id: '' }, 'fb')?.id).toBe('fb')
    expect(normalizeEntity({ id: null }, 'fb')?.id).toBe('fb')
    expect(normalizeEntity({})).toBeUndefined()
    expect(normalizeEntity(null, 'fb')).toBeUndefined()
    expect(normalizeEntity([1, 2], 'fb')?.id).toBe('fb') // an array is an object with nothing usable, but the fallback carries it
    expect(normalizeEntity({ id: 'x', name: 'N', title: 'T', label: 'L' })?.label).toBe('L')
    expect(normalizeEntity({ id: 'x', name: 'N', title: 'T' })?.label).toBe('T')
    expect(normalizeEntity({ id: 'x', name: 'N' })?.label).toBe('N')
  })

  it('reads tags as an array, a list split on commas or semicolons, trimmed and deduplicated, and anything else as none', () => {
    expect(normalizeEntity({ id: 'x', tags: ['a', ' a ', 'b', 3, ''] })?.tags).toEqual(['a', 'b', '3'])
    expect(normalizeEntity({ id: 'x', tags: 'a, b;c ;; a' })?.tags).toEqual(['a', 'b', 'c'])
    expect(normalizeEntity({ id: 'x', tags: '' })?.tags).toEqual([])
    expect(normalizeEntity({ id: 'x', tags: { a: 1 } })?.tags).toEqual([])
    expect(normalizeEntity({ id: 'x', tags: 5 })?.tags).toEqual([])
  })

  it('keeps data only when it is a plain object, and reads meta from `meta` first, flat columns second, defaulting the times', () => {
    expect(normalizeEntity({ id: 'x', data: [1] })?.data).toEqual({})
    expect(normalizeEntity({ id: 'x', data: 'str' })?.data).toEqual({})
    expect(normalizeEntity({ id: 'x', data: null })?.data).toEqual({})
    expect(normalizeEntity({ id: 'x', data: { nested: { deep: [1] }, n: 1 } })?.data).toEqual({ nested: { deep: [1] }, n: 1 })
    const m = normalizeEntity({ id: 'x', meta: { createdAt: 'c', accessedAt: 'a', projects: ['p', 1, null], extra: 1 }, updated_at: 'u', created_by: 'me', origin: 'web' })!
    expect(m.meta).toEqual({ createdAt: 'c', updatedAt: 'u', accessedAt: 'a', createdBy: 'me', source: 'web', projects: ['p'] })
    const flat = normalizeEntity({ id: 'x', created_at: 'c', meta: 'not an object' })!
    expect(flat.meta).toEqual({ createdAt: 'c', updatedAt: 'c' })
    expect(normalizeEntity({ id: 'x', meta: { updatedAt: 'u' } })!.meta.updatedAt).toBe('u')
    expect(normalizeEntity({ id: 'x', meta: { projects: 'p' } })!.meta).not.toHaveProperty('projects')
    // A type definition from before the rename: category `graph` reads as `project`; other types are left alone.
    expect(normalizeEntity({ id: 't', type: 'schema:type', data: { category: 'graph', name: 'x' } })?.data).toEqual({ category: 'project', name: 'x' })
    expect(normalizeEntity({ id: 't', type: 'note', data: { category: 'graph' } })?.data).toEqual({ category: 'graph' })
  })

  it('makes a relationship from two ends however they are spelled, honours a declared kind, and drops a relationship missing an end', () => {
    const r = normalizeEntity({ id: 'r', source: 'a', target: 'b' })!
    expect(r).toMatchObject({ kind: 'relationship', type: 'entity', source: { id: 'a' }, target: { id: 'b' }, directed: true })
    expect(normalizeEntity({ id: 'r', source: { id: 'a', selector: 'bad' }, target: { id: 'b', selector: { kind: 'fragment', value: 'f' } } })).toMatchObject({
      source: { id: 'a' },
      target: { id: 'b', selector: { kind: 'fragment', value: 'f' } },
    })
    expect((normalizeEntity({ id: 'r', source: { id: 'a', selector: 'bad' }, target: 'b' }) as { source: object }).source).not.toHaveProperty('selector')
    expect(normalizeEntity({ id: 'r', kind: 'relationship', source: 'a' })).toBeUndefined()
    expect(normalizeEntity({ id: 'r', kind: 'relationship', source: {}, target: 'b' })).toBeUndefined()
    expect(normalizeEntity({ id: 'r', kind: 'relationship', source: { id: '' }, target: 'b' })).toBeUndefined()
    expect(normalizeEntity({ id: 'r', kind: 'relationship' })).toBeUndefined()
    // One end alone makes an entity, and the stray end is not kept.
    const half = normalizeEntity({ id: 'h', source: 'a' })!
    expect(half.kind).toBe('entity')
    expect(half).not.toHaveProperty('source')
    // A record that says it is an entity stays one even with fields called source and target.
    const said = normalizeEntity({ id: 'e', kind: 'entity', source: 'web', target: 'print' })!
    expect(said.kind).toBe('entity')
    expect(said).not.toHaveProperty('source')
    // An unknown kind is an entity.
    expect(normalizeEntity({ id: 'k', kind: 'thing' })?.kind).toBe('entity')
  })

  it('reads `directed` as a boolean, with the strings "false" and "0" meaning undirected', () => {
    const d = (directed: unknown) => (normalizeEntity({ id: 'r', source: 'a', target: 'b', directed }) as { directed: boolean }).directed
    expect(d(undefined)).toBe(true)
    expect(d(null)).toBe(false)
    expect(d(false)).toBe(false)
    expect(d(0)).toBe(false)
    expect(d(1)).toBe(true)
    expect(d('true')).toBe(true)
    expect(d('false')).toBe(false)
    expect(d('0')).toBe(false)
    expect(d('')).toBe(false)
    expect(d(' No ')).toBe(false)
    expect(d('yes')).toBe(true)
  })

  it('reads a tag info from `tag` or `$tag`, keeping only a non-empty colour and description', () => {
    expect(normalizeTagInfo({ $tag: 'x', color: '#fff', description: 'd' })).toEqual({ tag: 'x', color: '#fff', description: 'd' })
    expect(normalizeTagInfo({ tag: 'x', color: '', description: null })).toEqual({ tag: 'x' })
    expect(normalizeTagInfo({ tag: 7 })).toEqual({ tag: '7' })
    expect(normalizeTagInfo({ color: '#fff' })).toBeUndefined()
    expect(normalizeTagInfo('x')).toBeUndefined()
  })
})

describe('CSV rows', () => {
  const header: string[] = [...CSV_COLUMNS]
  it('reads a row with missing trailing columns, a header missing columns, extra columns, and broken JSON as nothing', () => {
    const short = csvRowToEntity(header, ['a', '', 'note', 'A'])!
    expect(short).toMatchObject({ id: 'a', kind: 'entity', type: 'note', label: 'A', tags: [], data: {} })
    expect(short).not.toHaveProperty('source')
    expect(csvRowToEntity(['id', 'label'], ['b', 'B', 'ignored'])).toMatchObject({ id: 'b', label: 'B', type: 'entity' })
    expect(csvRowToEntity(['label'], ['no id'])).toBeUndefined()
    expect(csvRowToEntity(header, [])).toBeUndefined()
    const row = entityToCsvRow(createEntity({ id: 'c', data: { k: 1 } }))
    row[header.indexOf('data')] = '{not json'
    expect(csvRowToEntity(header, row)?.data).toEqual({})
    const rel = entityToCsvRow(createRelationship({ id: 'r', source: { id: 'a', selector: { kind: 'text', exact: 'q' } }, target: 'b' }))
    rel[header.indexOf('source_selector')] = 'nope'
    const back = csvRowToEntity(header, rel) as { source: object; target: object }
    expect(back.source).toEqual({ id: 'a' })
    expect(back.target).toEqual({ id: 'b' })
  })

  it('infers a relationship from both ids, not one, and reads `directed` from its column with the empty cell meaning directed', () => {
    const at = (k: string, v: string) => {
      const r = Array(header.length).fill('')
      r[header.indexOf('id')] = 'r'
      r[header.indexOf('source_id')] = 'a'
      r[header.indexOf('target_id')] = 'b'
      r[header.indexOf(k)] = v
      return r
    }
    expect(csvRowToEntity(header, at('directed', ''))).toMatchObject({ kind: 'relationship', directed: true })
    expect(csvRowToEntity(header, at('directed', 'false'))).toMatchObject({ directed: false })
    expect(csvRowToEntity(header, at('directed', 'FALSE'))).toMatchObject({ directed: false }) // anything but `true`
    expect(csvRowToEntity(header, at('directed', 'true'))).toMatchObject({ directed: true })
    expect(csvRowToEntity(header, at('kind', 'entity'))).toMatchObject({ kind: 'entity' })
    const one = at('target_id', '')
    expect(csvRowToEntity(header, one)).toMatchObject({ kind: 'entity' })
    expect(csvRowToEntity(header, at('tags', 'a;b, c'))?.tags).toEqual(['a', 'b', 'c'])
  })

  it('escapes only what needs it and writes empty cells for what is absent', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape('')).toBe('')
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('x\r\ny')).toBe('"x\r\ny"')
    const row = entityToCsvRow(createEntity({ id: 'e', type: 't' }))
    expect(row).toHaveLength(CSV_COLUMNS.length)
    expect(row.filter((c) => c === '')).toHaveLength(CSV_COLUMNS.length - 5) // id, kind, type, created_at, updated_at are set
  })
})

describe('the incremental CSV parser', () => {
  it('skips blank lines but not a line of empty cells, takes every line ending, and emits a last row without one', () => {
    expect(parse('a,b\n\n\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parse('a,b\r\nc,d\rE,f')).toEqual([['a', 'b'], ['c', 'd'], ['E', 'f']])
    expect(parse(',\n')).toEqual([['', '']])
    expect(parse('x')).toEqual([['x']])
    expect(parse('')).toEqual([])
    expect(parse('\n\n')).toEqual([])
    expect(parse('a,\n')).toEqual([['a', '']])
    expect(parse(',a\n')).toEqual([['', 'a']])
  })

  it('reads quotes in place, doubled quotes, an empty quoted cell, newlines inside quotes, and a quote out of place as a character', () => {
    expect(parse('"a,b","c""d",""\n')).toEqual([['a,b', 'c"d', '']])
    expect(parse('"line\nbreak",x\n')).toEqual([['line\nbreak', 'x']])
    expect(parse('"crlf\r\nin",x\r\n')).toEqual([['crlf\r\nin', 'x']])
    expect(parse('a"b,c\n')).toEqual([['a"b', 'c']]) // a quote after text is literal
    expect(parse('"a"b,c\n')).toEqual([['ab', 'c']]) // text after a closing quote is appended
    expect(parse('"unterminated,x')).toEqual([['unterminated,x']]) // end() flushes what it has
  })

  it('keeps its state across chunk boundaries inside an escape, a CRLF, and a quoted cell', () => {
    const text = '"a""b",c\r\n"d\ne",f\r\n'
    const whole = parse(text)
    expect(whole).toEqual([['a"b', 'c'], ['d\ne', 'f']])
    for (let n = 1; n < text.length; n++) expect(parse(text, n)).toEqual(whole)
  })
})

describe('detectFormat', () => {
  it('sniffs every spelling, case-insensitively, with gzip on everything but the pack, and nothing for the rest', () => {
    expect(detectFormat('X.NDJSON')).toEqual({ format: 'jsonl', gzip: false })
    expect(detectFormat('x.ae.csv.GZ')).toEqual({ format: 'csv', gzip: true })
    expect(detectFormat('x.aeb')).toEqual({ format: 'pack', gzip: false })
    expect(detectFormat('x.aeb.gz')).toEqual({ format: 'pack', gzip: false })
    expect(detectFormat('x.jsonl.gz')).toEqual({ format: 'jsonl', gzip: true })
    expect(detectFormat('x.txt')).toBeUndefined()
    expect(detectFormat('x.gz')).toBeUndefined()
    expect(detectFormat('json')).toBeUndefined()
    expect(detectFormat('.json')).toEqual({ format: 'json', gzip: false })
  })
})

describe('what the text formats carry back', () => {
  const entities = [
    createEntity({ id: 'e', type: 'note', label: 'E', description: 'd', tags: ['t'], data: { n: 1, s: 'x,y', o: { k: [1] } }, meta: { accessedAt: 'a', createdBy: 'me', source: 'web', projects: ['p'] } }),
    createRelationship({ id: 'r', type: 'cites', source: { id: 'e', selector: { kind: 'text', exact: 'q', prefix: 'p' } }, target: { id: 'e', selector: { kind: 'region', x: 0, y: 0, width: 1, height: 1 } }, directed: false }),
    createEntity({ id: 'empty' }),
  ]
  const jsonl = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l))

  it('jsonl and json carry everything, tag infos included; a jsonl without tags has no tag line; the pack is not text', () => {
    const lines = jsonl([...serialize({ entities, tags: [{ tag: 't', color: '#123' }] }, 'jsonl')].join(''))
    expect(lines).toHaveLength(5)
    expect(lines[1]).toEqual({ $tag: 't', color: '#123' })
    expect(lines.slice(2).map((l) => normalizeEntity(l))).toEqual(entities)
    expect(jsonl([...serialize({ entities: [] }, 'jsonl')].join(''))).toHaveLength(1)
    const doc = JSON.parse([...serialize({ entities, tags: [{ tag: 't' }], project: { id: 'p' } as never, state: { x: 1 } as never }, 'json')].join(''))
    expect(Object.keys(doc)).toEqual(['$schema', 'exportedAt', 'project', 'state', 'tags', 'entities'])
    expect(doc.entities.map((e: unknown) => normalizeEntity(e))).toEqual(entities)
    expect(normalizeTagInfo(doc.tags[0])).toEqual({ tag: 't' })
    expect(() => [...serialize({ entities }, 'pack')]).toThrow(/binary/)
  })

  it('csv carries fields, tags, both selectors, directed and the flat meta, but not the projects an entity is marked with', () => {
    const rows = parse([...serialize({ entities }, 'csv')].join(''))
    expect(rows[0]).toEqual([...CSV_COLUMNS])
    const back = rows.slice(1).map((r) => csvRowToEntity(rows[0], r))
    expect(back[1]).toEqual(entities[1])
    expect(back[2]).toEqual(entities[2])
    const { meta, ...rest } = entities[0]
    expect(back[0]).toEqual({ ...rest, meta: { ...meta, projects: undefined } }) // marks do not survive: there is no column for them
    expect(back[0]!.meta).not.toHaveProperty('projects')
  })
})

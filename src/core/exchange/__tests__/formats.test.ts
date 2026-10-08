import { describe, expect, it } from 'vitest'
import { generateAcademicGraph } from '../generate'
import { serialize } from '../export'
import { normalizeEntity, CsvParser, csvRowToEntity, csvEscape, entityToCsvRow } from '../formats'

describe('the generator', () => {
  it('is deterministic for a given seed', () => {
    const a = generateAcademicGraph({ target: 3000, seed: 1 })
    const b = generateAcademicGraph({ target: 3000, seed: 1 })
    expect(a.entities.map((e) => e.id)).toEqual(b.entities.map((e) => e.id))
    expect(JSON.stringify(a.entities.slice(0, 50))).toBe(JSON.stringify(b.entities.slice(0, 50)))
    const c = generateAcademicGraph({ target: 3000, seed: 2 })
    const firstPerson = (r: typeof a) => r.entities.find((e) => e.id.includes('-p-'))!.label
    expect(firstPerson(c)).not.toBe(firstPerson(a))
  })
})

describe('serialization round-trips', () => {
  const { entities } = generateAcademicGraph({ target: 2000, seed: 3 })

  it('jsonl', () => {
    const text = [...serialize({ entities, tags: [{ tag: 'x', color: '#fff' }] }, 'jsonl')].join('')
    const lines = text.trim().split('\n')
    expect(lines[0]).toContain('"$schema":"aegraph/v1"')
    expect(JSON.parse(lines[1])).toEqual({ $tag: 'x', color: '#fff' })
    const back = lines.slice(2).map((l) => normalizeEntity(JSON.parse(l))!)
    expect(back).toEqual(entities)
  })

  it('json (compact and pretty)', () => {
    for (const pretty of [false, true]) {
      const doc = JSON.parse([...serialize({ entities }, 'json', pretty)].join(''))
      expect(doc.$schema).toBe('aegraph/v1')
      expect(doc.entities).toEqual(entities)
    }
  })

  it('csv, including quoted fields spanning chunks', () => {
    const text = [...serialize({ entities }, 'csv')].join('')
    const parser = new CsvParser()
    const rows: string[][] = []
    // Feed in awkward chunk sizes to exercise the incremental parser.
    for (let i = 0; i < text.length; i += 777) parser.push(text.slice(i, i + 777), (r) => rows.push(r))
    parser.end((r) => rows.push(r))
    const header = rows[0]
    const back = rows.slice(1).map((r) => csvRowToEntity(header, r)!)
    expect(back.length).toBe(entities.length)
    expect(back).toEqual(entities)
  })

  it('csv escaping handles quotes, commas, newlines', () => {
    const tricky = normalizeEntity({ id: 't', label: 'a "quoted", line\nbreak', data: { k: 'v,"w"' } })!
    const line = entityToCsvRow(tricky).map(csvEscape).join(',')
    const parser = new CsvParser()
    const rows: string[][] = []
    parser.push(line + '\n', (r) => rows.push(r))
    expect(rows[0][3]).toBe('a "quoted", line\nbreak')
    expect(JSON.parse(rows[0][16])).toEqual({ k: 'v,"w"' })
  })

  it('normalizeEntity is lenient with foreign records', () => {
    expect(normalizeEntity({ id: '1', title: 'T', tags: 'a; b' })).toMatchObject({ kind: 'entity', type: 'entity', label: 'T', tags: ['a', 'b'] })
    expect(normalizeEntity({ id: 'r', source: 'a', target: { id: 'b', selector: { kind: 'range', start: 0, end: 1 } } })).toMatchObject({
      kind: 'relationship',
      directed: true,
      target: { id: 'b', selector: { kind: 'range', start: 0, end: 1 } },
    })
    expect(normalizeEntity({ label: 'no id' }, 'fallback')?.id).toBe('fallback')
    expect(normalizeEntity('nope')).toBeUndefined()
  })
})

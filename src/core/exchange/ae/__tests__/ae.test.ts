import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectFormat, FORMATS, normalizeEntity } from '../../formats'
import schema from '../aegraph-v1.schema.json'
import example from '../example.ae.json?raw'
import { AE_SCHEMA_PATH, emptyAe, isAeDocument, validateAe } from '../validate'

const doc = () => JSON.parse(example) as Record<string, unknown> & { entities: Record<string, unknown>[] }

describe('.ae — the aegraph document', () => {
  it('the example validates and describes itself', () => {
    const r = validateAe(doc())
    expect(r.issues).toEqual([])
    expect(r).toMatchObject({ ok: true, entities: 6, relationships: 3, unresolved: [], duplicates: [] })
  })

  it('the loader takes every example entity as-is (no coercion needed)', () => {
    for (const raw of doc().entities) {
      const e = normalizeEntity(raw)!
      expect(e.id).toBe(raw.id)
      expect(e.kind).toBe(raw.kind ?? 'entity')
      expect(e.type).toBe(raw.type)
      expect(e.tags).toEqual(raw.tags)
      expect(e.data).toEqual(raw.data)
      expect(e.meta.createdAt).toBe((raw.meta as { createdAt: string }).createdAt)
    }
  })

  it('.ae.json is the JSON document format (bare .ae too), gzip included, and what exports are named', () => {
    expect(detectFormat('notes.ae.json')).toEqual({ format: 'json', gzip: false })
    expect(detectFormat('notes.ae.json.gz')).toEqual({ format: 'json', gzip: true })
    expect(detectFormat('notes.ae')).toEqual({ format: 'json', gzip: false })
    expect(detectFormat('notes.ae.jsonl')).toEqual({ format: 'jsonl', gzip: false })
    expect(detectFormat('notes.json')).toEqual({ format: 'json', gzip: false })
    expect(FORMATS.json.extension).toBe('.ae.json')
    expect(isAeDocument(doc())).toBe(true)
    expect(isAeDocument({ entities: [] })).toBe(false)
    expect(validateAe(emptyAe()).ok).toBe(true)
  })

  it('reports what is wrong, where', () => {
    const d = doc()
    d.$schema = 'aegraph/v2'
    d.entities[1].tags = 'reading'
    delete (d.entities[3].meta as Record<string, unknown>).updatedAt
    d.entities[6].target = { id: 'w3c-semantic-web', selector: { kind: 'text', start: 1 } }
    d.entities.push({ id: 'dangling', kind: 'relationship', type: 'x', tags: [], data: {}, source: { id: 'nowhere' }, target: { id: 'ann-1' }, meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } })
    d.entities.push({ ...d.entities[2] })
    const r = validateAe(d)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.path)).toEqual(['/$schema', '/entities/1/tags', '/entities/3/meta/updatedAt', '/entities/6/target/selector/exact', '/entities/6/target/selector/start'])
    expect(r.unresolved).toEqual(['nowhere'])
    expect(r.duplicates).toEqual(['doc-notes'])
  })

  it('type definitions are checked: id, name, category, property kinds', () => {
    const d = emptyAe()
    d.entities.push({ id: 'type:claim', kind: 'entity', type: 'schema:type', tags: [], data: { name: 'claims', category: 'facts', properties: [{ key: 'x', kind: 'blob' }] }, meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } })
    const r = validateAe(d)
    expect(r.issues.map((i) => i.path)).toEqual(['/entities/0/id', '/entities/0/data/category', '/entities/0/data/properties/0/kind'])
  })

  it('a type definition may declare itself relationship vocabulary, and nothing else', () => {
    // The app writes this: an importer declaring `performed-by` is declaring a relationship type, which has no
    // instances of its own and would otherwise read as an unused entity type. The format has to know it too.
    const meta = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
    const def = (data: Record<string, unknown>) => ({ id: `type:${data.name}`, kind: 'entity' as const, type: 'schema:type', tags: [], data, meta })
    const ok = emptyAe()
    ok.entities.push(def({ name: 'performed-by', kind: 'relationship', label: 'performed by' }))
    expect(validateAe(ok).issues).toEqual([])
    const wrong = emptyAe()
    wrong.entities.push(def({ name: 'performed-by', kind: 'edge' }))
    expect(validateAe(wrong).issues.map((i) => i.path)).toEqual(['/entities/0/data/kind'])
  })

  it('the served copies of the schema and example are the ones in source', () => {
    const pub = (f: string) => readFileSync(resolve(__dirname, '../../../../../public/spec', f), 'utf8')
    expect(JSON.parse(pub('aegraph-v1.schema.json'))).toEqual(schema)
    expect(pub('example.ae.json')).toBe(example)
    expect(AE_SCHEMA_PATH).toBe('/spec/aegraph-v1.schema.json')
  })

  it('the code validator and the JSON Schema agree on what is required', () => {
    const defs = schema.$defs as Record<string, { required?: string[] }>
    expect(schema.required).toEqual(['$schema', 'entities'])
    expect(defs.entityBase.required).toEqual(['id', 'type', 'tags', 'data', 'meta'])
    expect(defs.meta.required).toEqual(['createdAt', 'updatedAt'])
    // Every field a type definition can carry is in the schema: the app reads them all, so a producer needs them all.
    const std = (defs.schemaTypeData as unknown as { properties: Record<string, unknown> }).properties
    expect(Object.keys(std).sort()).toEqual(['category', 'color', 'kind', 'name', 'parent', 'pluralLabel', 'properties', 'table'])
    expect((std.kind as { const: string }).const).toBe('relationship')
    // Every selector kind the validator knows is in the schema, with the same required keys.
    const kinds = (defs.selector as unknown as { oneOf: { properties: { kind: { const: string } }; required: string[] }[] }).oneOf
    expect(kinds.map((k) => [k.properties.kind.const, k.required.filter((r) => r !== 'kind')])).toEqual([
      ['text', ['exact']],
      ['range', ['start', 'end']],
      ['region', ['x', 'y', 'width', 'height']],
      ['time', ['start']],
      ['geo', ['lat', 'lng']],
      ['fragment', ['value']],
    ])
  })
})

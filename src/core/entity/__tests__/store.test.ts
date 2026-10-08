import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship, parseTags, patchEntity } from '../entity'
import { refToUri, uriToRef } from '../ids'
import { defineEntityType, fieldPatch, getField, validateEntity } from '../schema'
import { EntityStore } from '../store'

const make = () => {
  const store = new EntityStore()
  const a = createEntity({ id: 'a', type: 'note', label: 'A', tags: ['x', 'y'] })
  const b = createEntity({ id: 'b', type: 'note', label: 'B', tags: ['y'] })
  const c = createEntity({ id: 'c', type: 'webpage', label: 'C', data: { url: 'https://example.com' } })
  const ab = createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' })
  const bc = createRelationship({ id: 'bc', type: 'annotates', source: 'b', target: { id: 'c', selector: { kind: 'text', exact: 'hi' } } })
  store.upsertMany([a, b, c, ab, bc])
  return store
}

describe('EntityStore', () => {
  it('indexes by type and tag', () => {
    const s = make()
    expect(s.ofType('note').map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(s.withTag('y').map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(s.countByType().get('webpage')).toBe(1)
  })

  it('queries by kind, type, tags, and text', () => {
    const s = make()
    expect(s.query({ kind: 'relationship' }).length).toBe(2)
    expect(s.query({ type: 'note', tags: ['x'] }).map((e) => e.id)).toEqual(['a'])
    expect(s.query({ text: 'example.com' }).map((e) => e.id)).toEqual(['c'])
    expect(s.query({ text: 'ANNOT' }).map((e) => e.id)).toEqual(['bc'])
  })

  it('traverses relationships in both directions', () => {
    const s = make()
    expect(s.relationshipsOf('b', 'out').map((r) => r.id)).toEqual(['bc'])
    expect(s.relationshipsOf('b', 'in').map((r) => r.id)).toEqual(['ab'])
    expect(s.neighbors('b').map((n) => n.entity.id).sort()).toEqual(['a', 'c'])
  })

  it('cascades relationship removal', () => {
    const s = make()
    s.remove('b')
    expect(s.has('b')).toBe(false)
    expect(s.has('ab')).toBe(false)
    expect(s.has('bc')).toBe(false)
    expect(s.size()).toBe(2)
    expect(s.danglingRelationships()).toEqual([])
  })

  it('re-indexes on update', () => {
    const s = make()
    s.update('a', { type: 'todo', tags: ['z'] })
    expect(s.ofType('note').map((e) => e.id)).toEqual(['b'])
    expect(s.ofType('todo').map((e) => e.id)).toEqual(['a'])
    expect(s.withTag('x')).toEqual([])
    expect(s.tagUsage('z')).toBe(1)
  })

  it('keeps list order stable when an entity is touched or edited in place', () => {
    const s = make()
    s.touch('a')
    s.update('a', { label: 'A2' })
    expect(s.ofType('note').map((e) => e.id)).toEqual(['a', 'b'])
    expect(s.withTag('y').map((e) => e.id)).toEqual(['a', 'b'])
    s.update('a', { tags: ['y', 'z'] })
    expect(s.withTag('y').map((e) => e.id)).toEqual(['a', 'b'])
    expect(s.withTag('x')).toEqual([])
    expect(s.withTag('z').map((e) => e.id)).toEqual(['a'])
  })

  it('renames and deletes tags across entities', () => {
    const s = make()
    s.setTagInfo('y', { color: '#fff' })
    s.renameTag('y', 'why')
    expect(s.withTag('y')).toEqual([])
    expect(s.withTag('why').length).toBe(2)
    expect(s.getTagInfo('why').color).toBe('#fff')
    s.deleteTag('why')
    expect(s.tags()).toEqual(['x'])
  })

  it('round-trips through the exchange document', () => {
    const s = make()
    s.setTagInfo('x', { description: 'ex' })
    const doc = s.toDocument()
    const t = new EntityStore()
    t.loadDocument(JSON.parse(JSON.stringify(doc)))
    expect(t.size()).toBe(5)
    expect(t.getTagInfo('x').description).toBe('ex')
    expect(t.relationshipsOf('c', 'in')[0].target.selector).toEqual({ kind: 'text', exact: 'hi' })
  })

  it('notifies subscribers and bumps version', () => {
    const s = make()
    const v = s.version
    const events: string[] = []
    s.subscribe((e) => events.push(e.type))
    s.upsert(createEntity({ id: 'd' }))
    s.remove('d')
    expect(events).toEqual(['upsert', 'remove'])
    expect(s.version).toBe(v + 2)
  })
})

describe('entity helpers', () => {
  it('patchEntity bumps updatedAt and dedupes tags', () => {
    const e = createEntity({ tags: ['a'] })
    const p = patchEntity(e, { tags: ['a', 'a', ' b '] })
    expect(p.tags).toEqual(['a', 'b'])
    expect(p.meta.updatedAt >= e.meta.updatedAt).toBe(true)
  })

  it('parseTags accepts arrays, JSON, and CSV', () => {
    expect(parseTags(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseTags('["a","b"]')).toEqual(['a', 'b'])
    expect(parseTags('a, b,,c')).toEqual(['a', 'b', 'c'])
    expect(parseTags(null)).toEqual([])
  })

  it('ref URIs round-trip with selectors', () => {
    const r = { id: 'abc', selector: { kind: 'range' as const, start: 1, end: 5 } }
    expect(uriToRef(refToUri(r))).toEqual(r)
    expect(uriToRef('aegraph:xyz')).toEqual({ id: 'xyz' })
    expect(uriToRef('http://nope')).toBeUndefined()
  })
})

describe('schema', () => {
  it('reads and patches dotted fields', () => {
    const e = createEntity({ data: { a: { b: 1 } } })
    expect(getField(e, 'data.a.b')).toBe(1)
    const patch = fieldPatch(e, 'data.a.c', 2)
    expect(patch.data).toEqual({ a: { b: 1, c: 2 } })
    expect(e.data).toEqual({ a: { b: 1 } }) // original untouched
    expect(fieldPatch(e, 'label', 'L')).toEqual({ label: 'L' })
  })

  it('validates required fields and custom rules', () => {
    defineEntityType({
      type: 'thing',
      label: 'Thing',
      pluralLabel: 'Things',
      fields: [{ key: 'data.url', label: 'URL', kind: 'url', required: true }],
      validate: (e) => (e.label === 'bad' ? [{ entityId: e.id, message: 'bad label', severity: 'warning' }] : []),
    })
    expect(validateEntity(createEntity({ type: 'thing' }))).toHaveLength(1)
    expect(validateEntity(createEntity({ type: 'thing', label: 'bad', data: { url: 'x' } }))[0].message).toBe('bad label')
    expect(validateEntity(createEntity({ type: 'unknown-type' }))).toEqual([])
  })
})

describe('inferFieldsFromEntities', () => {
  it('reads keys, kinds, and small value sets from existing entities', async () => {
    const { inferFieldsFromEntities } = await import('../schema')
    const rows = Array.from({ length: 10 }, (_, i) => createEntity({ type: 'incident', label: `I${i}`, data: { code: `INC-${i}`, severity: ['S1', 'S2', 'S3'][i % 3], startedAt: '2026-07-01T10:00:00Z', duration_min: i * 3, resolved: i % 2 === 0, notes: 'x'.repeat(200) } }))
    const fields = inferFieldsFromEntities(rows)
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
    expect(byKey['data.code'].kind).toBe('text')
    expect(byKey['data.code'].options).toBeUndefined()
    expect(byKey['data.severity'].options?.map((o) => o.value)).toEqual(['S1', 'S2', 'S3'])
    expect(byKey['data.startedAt'].kind).toBe('datetime')
    expect(byKey['data.duration_min'].kind).toBe('number')
    expect(byKey['data.resolved'].kind).toBe('boolean')
    expect(byKey['data.notes'].kind).toBe('longtext')
    expect(byKey['data.duration_min'].label).toBe('Duration min')
  })
})

describe('data version', () => {
  it('bumps for data writes and removals, not for bookkeeping writes', () => {
    const store = new EntityStore()
    const v0 = store.dataVersion
    store.upsert(createEntity({ id: 'a', type: 'thing', label: 'A' }))
    expect(store.dataVersion).toBe(v0 + 1)
    const before = store.dataVersion
    const vBefore = store.version
    store.touch('a')
    store.update('a', { data: { lastRun: { at: 'now' } } }, { volatile: true })
    expect(store.version).toBe(vBefore + 2) // views still hear about it
    expect(store.dataVersion).toBe(before) // derived caches do not
    store.update('a', { label: 'B' })
    expect(store.dataVersion).toBe(before + 1)
    store.transaction(() => {
      store.touch('a')
      store.touch('a')
    })
    expect(store.dataVersion).toBe(before + 1)
    store.remove('a')
    expect(store.dataVersion).toBe(before + 2)
  })
})

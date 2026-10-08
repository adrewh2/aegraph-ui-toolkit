import { describe, expect, it } from 'vitest'
import { schemaTypeId } from '../../../core/entity/categories'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../../core/entity/typeRegistry'
import { schemaReference, schemaReferenceJson } from '../reference'
// Registering the built-in types is a side effect of importing their modules, as in the app.
import '../../../core/resources/types'
import '../../maps/maps'

function fixture() {
  const store = new EntityStore()
  for (let i = 0; i < 4; i++) store.upsert(createEntity({ id: `p${i}`, type: 'person', label: `P${i}`, data: { born: 1980 + i, ...(i < 2 ? { email: `p${i}@x` } : {}) } }))
  for (let i = 0; i < 2; i++) store.upsert(createEntity({ id: `o${i}`, type: 'organization', label: `O${i}` }))
  store.upsert(createEntity({ id: 'e0', type: 'engineer', label: 'E0', data: { born: 1990, language: 'ts' } }))
  // worksAt: every person one organisation, organisations several people → N:1
  for (let i = 0; i < 4; i++) store.upsert(createRelationship({ id: `w${i}`, type: 'worksAt', source: `p${i}`, target: `o${i % 2}` }))
  store.upsert(createRelationship({ id: 'w4', type: 'worksAt', source: 'e0', target: 'o0' }))
  // knows: a chain plus a fan → N:M
  store.upsert(createRelationship({ id: 'k1', type: 'knows', source: 'p0', target: 'p1' }))
  store.upsert(createRelationship({ id: 'k2', type: 'knows', source: 'p0', target: 'p2' }))
  store.upsert(createRelationship({ id: 'k3', type: 'knows', source: 'p3', target: 'p2' }))
  // ceo: one each way → 1:1
  store.upsert(createRelationship({ id: 'c0', type: 'ceo', source: 'p0', target: 'o0' }))
  store.upsert(createRelationship({ id: 'c1', type: 'ceo', source: 'p1', target: 'o1' }))
  // Declared: person has born (number) and email; engineer is a subtype adding language.
  store.upsert(schemaTypeEntity('person', { label: 'Person', category: 'knowledge', color: '#abc', description: 'A human', properties: [{ key: 'born', kind: 'number', description: 'Year of birth' }, { key: 'email', kind: 'text' }, { key: 'nickname', kind: 'text' }] }))
  store.upsert(schemaTypeEntity('engineer', { label: 'Engineer', category: 'knowledge', parent: 'person', properties: [{ key: 'language', kind: 'text', required: true }] }))
  // A defined type with no instances at all.
  store.upsert(schemaTypeEntity('place', { label: 'Place', category: 'knowledge', properties: [{ key: 'lat', kind: 'number' }] }))
  return { store, registry: new TypeRegistry(store) }
}

describe('schemaReference', () => {
  it('lists every known type, with or without entities, with declared, inherited and observed properties', () => {
    const { store, registry } = fixture()
    const ref = schemaReference(store, registry)
    const names = ref.types.map((t) => t.type)
    expect(names).toEqual(expect.arrayContaining(['person', 'organization', 'engineer', 'place', 'document', 'map']))
    expect(names).not.toContain('schema:type')
    expect(names).not.toContain('worksAt')
    const place = ref.types.find((t) => t.type === 'place')!
    expect(place.count).toBe(0)
    expect(place.properties.map((p) => p.key)).toEqual(['lat'])
    const person = ref.types.find((t) => t.type === 'person')!
    expect(person.count).toBe(4)
    expect(person.description).toBe('A human')
    expect(person.children).toEqual(['engineer'])
    const byKey = Object.fromEntries(person.properties.map((p) => [p.key, p]))
    expect(byKey.born).toMatchObject({ kind: 'number', description: 'Year of birth', declaredOn: 'person', count: 4 })
    expect(byKey.email).toMatchObject({ declaredOn: 'person', count: 2 })
    expect(byKey.nickname).toMatchObject({ declaredOn: 'person', count: 0 })
    const eng = ref.types.find((t) => t.type === 'engineer')!
    expect(eng.parent).toBe('person')
    const ek = Object.fromEntries(eng.properties.map((p) => [p.key, p]))
    expect(ek.language).toMatchObject({ declaredOn: 'engineer', required: true, count: 1 })
    expect(ek.born).toMatchObject({ declaredOn: 'person', count: 1 }) // inherited
    // The map type is registered in code and has no entities: still listed, in its category.
    const map = ref.types.find((t) => t.type === 'map')!
    expect(map.count).toBe(0)
    expect(ref.byCategory.find((g) => g.category === 'resource')!.types.map((t) => t.type)).toContain('map')
  })

  it('observes properties nobody declared', () => {
    const { store, registry } = fixture()
    store.upsert(createEntity({ id: 'o9', type: 'organization', label: 'O9', data: { founded: 1999 } }))
    const ref = schemaReference(store, new TypeRegistry(store))
    const org = ref.types.find((t) => t.type === 'organization')!
    expect(org.properties).toEqual([{ key: 'founded', label: 'founded', count: 1 }])
    void registry
  })

  it('enumerates the type pairs of each relationship type with observed cardinality', () => {
    const { store, registry } = fixture()
    const ref = schemaReference(store, registry)
    const rel = (r: string) => ref.relationships.find((x) => x.rel === r)!
    const works = rel('worksAt')
    expect(works.count).toBe(5)
    expect(works.pairs.map((p) => [p.source, p.target, p.cardinality, p.count])).toEqual([
      ['person', 'organization', 'N:1', 4],
      ['engineer', 'organization', '1:1', 1], // one engineer, one organisation: nothing in the data says otherwise
    ])
    const pp = works.pairs[0]
    expect(pp).toMatchObject({ sources: 4, targets: 2, maxOut: 1, maxIn: 2, directed: true })
    expect(rel('knows').pairs[0]).toMatchObject({ source: 'person', target: 'person', cardinality: 'N:M', maxOut: 2, maxIn: 2, count: 3 })
    expect(rel('ceo').pairs[0]).toMatchObject({ cardinality: '1:1', maxOut: 1, maxIn: 1, count: 2 })
    expect(ref.totals).toMatchObject({ relationshipTypes: 3, pairs: 4, entities: 7, relationships: 10 })
  })

  it('writes a portable JSON document', () => {
    const { store, registry } = fixture()
    const doc = schemaReferenceJson(schemaReference(store, registry))
    expect(doc.$schema).toBe('aegraph/schema-reference/v1')
    const person = doc.types.find((t) => t.type === 'person')!
    expect(person).toMatchObject({ label: 'Person', category: 'knowledge', color: '#abc', instances: 4 })
    expect(person.properties.find((p) => p.key === 'born')).toMatchObject({ kind: 'number', declaredOn: 'person', onEntities: 4 })
    const works = doc.relationships.find((r) => r.type === 'worksAt')!
    expect(works.pairs[0]).toMatchObject({ source: 'person', target: 'organization', cardinality: 'N:1', maxTargetsPerSource: 1, maxSourcesPerTarget: 2 })
    expect(store.get(schemaTypeId('person'))).toBeDefined()
  })
})

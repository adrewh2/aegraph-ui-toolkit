import { describe, expect, it } from 'vitest'
import { createConstraint } from '../../../core/constraints/constraint'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../../core/entity/typeRegistry'
import { createProject } from '../../../core/projects/project'
import { matchesWords, typeProfile } from '../profile'
import { schemaReference, schemaReferenceJson } from '../reference'
import { tagMatrix } from '../tagStats'
import '../../../core/resources/types'
import '../../../core/graph/types'

/**
 * The Ontology page's data at its edges: a type nobody has and a type
 * nobody declared; a subtype chain three deep and a cycle in parents; a
 * property seen but not declared and one declared but never used; value
 * kinds, ranges, top values and the distinct cap of a profile; relations
 * per instance, undirected links, an end that is itself a relationship;
 * cardinality on one pair against many; counts under a project scope;
 * namespaced tags; duplicate labels; constraints watching a type; the
 * empty store.
 */
const T = '2026-01-01T00:00:00Z'
function fixture() {
  const store = new EntityStore()
  store.upsertMany([
    schemaTypeEntity('animal', { label: 'Animal', category: 'knowledge', properties: [{ key: 'legs', kind: 'number' }, { key: 'unused', kind: 'text' }] }),
    schemaTypeEntity('mammal', { label: 'Mammal', category: 'knowledge', parent: 'animal', properties: [{ key: 'fur', kind: 'boolean' }] }),
    schemaTypeEntity('dog', { label: 'Dog', category: 'knowledge', parent: 'mammal', properties: [{ key: 'breed', kind: 'text', options: ['lab', 'pug'] }] }),
    // A cycle: each the other's parent.
    schemaTypeEntity('yin', { label: 'Yin', category: 'knowledge', parent: 'yang', properties: [{ key: 'a', kind: 'text' }] }),
    schemaTypeEntity('yang', { label: 'Yang', category: 'knowledge', parent: 'yin', properties: [{ key: 'b', kind: 'text' }] }),
    schemaTypeEntity('ghost', { label: 'Ghost', category: 'knowledge' }),
  ])
  store.upsertMany([
    createEntity({ id: 'd1', type: 'dog', label: 'Rex', tags: ['breed:lab', 'good', 'kind:pet'], data: { legs: 4, fur: true, breed: 'lab', seen: '2024-05-01', note: 'x'.repeat(100), nil: null, list: [1], obj: { k: 1 } }, meta: { createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z' } }),
    createEntity({ id: 'd2', type: 'dog', label: 'Rex', tags: ['breed:pug'], data: { legs: 3, fur: false, breed: 'pug', seen: '2024-03-01T10:00:00Z', undef: undefined }, meta: { createdAt: '2023-01-01T00:00:00Z', updatedAt: '2024-07-01T00:00:00Z' } }),
    createEntity({ id: 'd3', type: 'dog', label: 'Fido', tags: [], data: { legs: 'four' }, meta: { createdAt: T, updatedAt: T } }),
    createEntity({ id: 'p1', type: 'person', label: 'Ann' }),
    createEntity({ id: 'p2', type: 'person', label: 'Bob' }),
    createEntity({ id: 'u1', type: 'unicorn', label: 'Uni', data: { horns: 1 } }),
    createRelationship({ id: 'o1', type: 'owns', source: 'p1', target: 'd1' }),
    createRelationship({ id: 'o2', type: 'owns', source: 'p1', target: 'd2' }),
    createRelationship({ id: 'o3', type: 'owns', source: 'p2', target: 'd2' }),
    createRelationship({ id: 'f1', type: 'friends', source: 'd1', target: 'd2', directed: false }),
    createRelationship({ id: 'f2', type: 'friends', source: 'd3', target: 'd1', directed: false }),
    // A relationship about a relationship: its target is `o1` itself.
    createRelationship({ id: 'meta1', type: 'about', source: 'd3', target: 'o1' }),
    createRelationship({ id: 'dangling', type: 'owns', source: 'p2', target: 'nowhere' }),
  ])
  return { store, registry: new TypeRegistry(store) }
}

describe('type profiles', () => {
  it('a type nobody has profiles to zeros; an inferred type with no definition has no declared properties; the empty store gives an empty reference', () => {
    const { store, registry } = fixture()
    const ghost = typeProfile(store, registry, 'ghost')
    expect(ghost).toMatchObject({ instances: 0, properties: [], declaredUnused: [], relations: [], tags: [], recent: [], duplicateLabels: 0, created: {}, updated: {} })
    expect(ghost.def.origin).toBe('schema')
    const uni = typeProfile(store, registry, 'unicorn')
    expect(uni.def.origin).toBe('inferred')
    expect(uni.instances).toBe(1)
    expect(uni.properties.map((p) => [p.key, p.declared, p.count])).toEqual([['horns', undefined, 1]])
    const nothing = typeProfile(store, registry, 'never-seen')
    expect(nothing.instances).toBe(0)
    const empty = new EntityStore()
    const ref = schemaReference(empty, new TypeRegistry(empty))
    expect(ref.totals).toMatchObject({ withInstances: 0, entities: 0, relationships: 0, pairs: 0 })
    expect(ref.types.length).toBeGreaterThan(0) // the built-in vocabulary is still there
    expect(ref.relationships.every((r) => r.count === 0)).toBe(true)
  })

  it('a chain three deep inherits every ancestor’s properties; a declared property nobody uses is listed; one seen but not declared is undeclared; a parent cycle ends', () => {
    const { store, registry } = fixture()
    const dog = typeProfile(store, registry, 'dog')
    expect(dog.parent?.type).toBe('mammal')
    expect(typeProfile(store, registry, 'mammal').parent?.type).toBe('animal')
    expect(typeProfile(store, registry, 'animal').children.map((c) => c.type)).toEqual(['mammal'])
    const declared = dog.properties.filter((p) => p.declared).map((p) => p.key).sort()
    expect(declared).toEqual(['breed', 'fur', 'legs'])
    expect(dog.properties.find((p) => p.key === 'breed')?.declared).toMatchObject({ kind: 'text', options: ['lab', 'pug'] })
    expect(dog.declaredUnused).toEqual(['unused'])
    expect(dog.properties.filter((p) => !p.declared).map((p) => p.key)).toEqual(['seen', 'list', 'nil', 'note', 'obj'])
    // The reference agrees, and says where each was declared.
    const ref = schemaReference(store, registry)
    const dogRef = ref.types.find((t) => t.type === 'dog')!
    // Declared first, then by how many entities carry them, then by key.
    expect(dogRef.properties.filter((p) => p.declaredOn).map((p) => [p.key, p.declaredOn, p.count])).toEqual([['legs', 'animal', 3], ['breed', 'dog', 2], ['fur', 'mammal', 2], ['unused', 'animal', 0]])
    expect(dogRef.children).toEqual([])
    expect(ref.types.find((t) => t.type === 'animal')!.children).toEqual(['mammal'])
    // yin ↔ yang: each sees the other's property once, and the walk stops.
    const yin = ref.types.find((t) => t.type === 'yin')!
    expect(yin.properties.map((p) => [p.key, p.declaredOn])).toEqual([['a', 'yin'], ['b', 'yang']])
    expect(typeProfile(store, registry, 'yin').properties).toEqual([])
    expect(typeProfile(store, registry, 'yang').parent?.type).toBe('yin')
  })

  it('value kinds, ranges, dates, mean lengths, top values, undefined skipped, null and objects counted; duplicate labels; tags with namespaces; recent by update', () => {
    const { store, registry } = fixture()
    const dog = typeProfile(store, registry, 'dog', { recent: 2 })
    const by = Object.fromEntries(dog.properties.map((p) => [p.key, p]))
    expect(by.legs).toMatchObject({ count: 3, coverage: 1, kinds: { number: 2, string: 1 }, distinct: 3, min: 3, max: 4, meanLength: 4 })
    expect(by.legs.top).toEqual([{ value: '4', count: 1 }, { value: '3', count: 1 }, { value: 'four', count: 1 }])
    expect(by.fur).toMatchObject({ count: 2, kinds: { boolean: 2 }, distinct: 2 })
    expect(by.seen).toMatchObject({ kinds: { date: 2 }, dateMin: '2024-03-01T10:00:00Z', dateMax: '2024-05-01' })
    expect(by.note).toMatchObject({ meanLength: 100 })
    expect(by.note.sample).toBe('x'.repeat(77) + '…')
    expect(by.nil).toMatchObject({ count: 1, kinds: { null: 1 }, distinct: 0 })
    expect(by.obj).toMatchObject({ kinds: { object: 1 }, sample: '{"k":1}' })
    expect(by.list).toMatchObject({ kinds: { array: 1 } })
    expect(by.undef).toBeUndefined()
    expect(dog.duplicateLabels).toBe(1)
    expect(dog.tags).toEqual([{ tag: 'breed:lab', count: 1 }, { tag: 'breed:pug', count: 1 }, { tag: 'good', count: 1 }, { tag: 'kind:pet', count: 1 }])
    expect(dog.recent.map((e) => e.id)).toEqual(['d3', 'd2']) // by last update, newest first
    expect(dog.created).toEqual({ first: '2023-01-01T00:00:00Z', last: T })
    expect(dog.updated.last).toBe(T)
    // The distinct cap: 2,001 values of one key stop counting at 2,000 and say so.
    const big = new EntityStore()
    big.upsertMany(Array.from({ length: 2001 }, (_, i) => createEntity({ id: `b${i}`, type: 'bead', data: { n: i } })))
    const bead = typeProfile(big, new TypeRegistry(big), 'bead')
    expect(bead.properties[0]).toMatchObject({ distinct: 2000, distinctCapped: true, min: 0, max: 2000 })
    expect(bead.ms).toBeLessThan(500)
  })

  it('relations: per instance and at most, undirected as both, a relationship as the other end, a dangling end left out; constraints watching a type by name or every type', () => {
    const { store, registry } = fixture()
    const dog = typeProfile(store, registry, 'dog')
    expect(dog.relations.map((r) => [r.rel, r.other, r.direction, r.count, r.instances, r.maxPerInstance, r.directed])).toEqual([
      ['friends', 'dog', 'both', 4, 3, 2, false], // two undirected links, seen from both ends
      ['owns', 'person', 'in', 3, 2, 2, true],
      ['about', '(owns)', 'out', 1, 1, 1, true],
    ])
    expect(dog.relations[1].perInstance).toBe(1.5)
    const person = typeProfile(store, registry, 'person')
    expect(person.relations.map((r) => [r.rel, r.other, r.direction, r.count])).toEqual([['owns', 'dog', 'out', 3]]) // the link to nowhere is not counted
    expect(dog.constraints).toBe(0)
    store.upsertMany([createConstraint({ label: 'all', rule: { required: ['label'] } }), createConstraint({ label: 'dogs', applies: { types: ['dog'] }, rule: { required: ['data.legs'] } }), createConstraint({ label: 'cats', applies: { types: ['cat'] }, rule: {} }), createConstraint({ label: 'off', applies: { types: ['dog'] }, rule: {}, enabled: false })])
    expect(typeProfile(store, registry, 'dog').constraints).toBe(2)
    expect(typeProfile(store, registry, 'person').constraints).toBe(1)
    expect(matchesWords('owns person', 'per own')).toBe(true)
    expect(matchesWords('owns person', 'cat')).toBe(false)
    expect(matchesWords('anything', '   ')).toBe(true)
  })

  it('the reference: cardinality on one pair vs many, an end that is a relationship as “(owns)”, a dangling relationship skipped, a declared relationship type with no pairs, and the JSON shape', () => {
    const { store, registry } = fixture()
    const ref = schemaReference(store, registry)
    const owns = ref.relationships.find((r) => r.rel === 'owns')!
    expect(owns.count).toBe(3)
    expect(owns.pairs).toEqual([{ source: 'person', target: 'dog', count: 3, directed: true, sources: 2, targets: 2, maxOut: 2, maxIn: 2, cardinality: 'N:M' }])
    const friends = ref.relationships.find((r) => r.rel === 'friends')!
    expect(friends.pairs[0]).toMatchObject({ source: 'dog', target: 'dog', count: 2, directed: false, cardinality: '1:1' }) // d1 is a source once and a target once: no end sees two
    const about = ref.relationships.find((r) => r.rel === 'about')!
    expect(about.pairs).toEqual([{ source: 'dog', target: '(owns)', count: 1, directed: true, sources: 1, targets: 1, maxOut: 1, maxIn: 1, cardinality: '1:1' }])
    expect(ref.totals.relationships).toBe(6) // the dangling one is not counted
    expect(ref.totals.pairs).toBe(3)
    const json = schemaReferenceJson(ref)
    expect(json.$schema).toBe('aegraph/schema-reference/v1')
    expect(json.relationships.find((r) => r.type === 'about')!.pairs[0]).toMatchObject({ target: '(owns)', maxTargetsPerSource: 1, maxSourcesPerTarget: 1 })
    expect(json.types.find((t) => t.type === 'dog')!.properties.find((p) => p.key === 'seen')).toEqual({ key: 'seen', observed: true, onEntities: 2 })
  })

  it('counts under a project scope: the profile and the reference see only the scope’s entities and relationships; the tag matrix splits namespaces', () => {
    const { store, registry } = fixture()
    store.upsert(createProject({ id: 'proj', label: 'P' }))
    store.mark(['d1', 'p1'], 'proj')
    store.setScope('proj')
    const scoped = new TypeRegistry(store)
    const dog = typeProfile(store, scoped, 'dog')
    expect(dog.instances).toBe(1)
    expect(dog.tags.map((t) => t.tag)).toEqual(['breed:lab', 'good', 'kind:pet'])
    expect(dog.relations.map((r) => [r.rel, r.other, r.count])).toEqual([['owns', 'person', 1]]) // the friendships lead outside the scope and are not shown
    const ref = schemaReference(store, scoped)
    expect(ref.totals.entities).toBe(2)
    expect(ref.types.find((t) => t.type === 'dog')!.count).toBe(1)
    store.setScope(null)
    const m = tagMatrix(store, registry)
    const keys = m.keys.map((k) => k.key).sort()
    expect(keys).toEqual(expect.arrayContaining(['breed', 'kind', 'good']))
    expect([...m.keys.find((k) => k.key === 'breed')!.values].sort()).toEqual(['lab', 'pug'])
    expect(m.keys.find((k) => k.key === 'good')!.values).toEqual([])
  })
})

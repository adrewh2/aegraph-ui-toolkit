import { describe, expect, it } from 'vitest'
import { schemaTypeId } from '../categories'
import { createEntity } from '../entity'
import { EntityStore } from '../store'
import { applyTypeDraft, checkTypeDraft, inheritedProperties, planTypeDraft, typeDraft, typeSlug } from '../typeEdit'
import { schemaTypeEntity, TypeRegistry } from '../typeRegistry'

/** A person type with two properties, a subtype of it, and a few entities carrying values. */
function fixture() {
  const store = new EntityStore()
  store.upsertMany([
    schemaTypeEntity('person', { label: 'Person', category: 'knowledge', properties: [{ key: 'born', kind: 'text' }, { key: 'nick' }] }),
    schemaTypeEntity('architect', { label: 'Architect', category: 'knowledge', parent: 'person', properties: [{ key: 'firm' }] }),
    createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: '1815', nick: 'A' } }),
    createEntity({ id: 'p2', type: 'person', label: 'Bo', data: { born: 'long ago' } }),
    createEntity({ id: 'a1', type: 'architect', label: 'Zaha', data: { born: '1950', firm: 'ZHA' } }),
  ])
  return { store, registry: () => new TypeRegistry(store) }
}

describe('a type as a draft', () => {
  it('reads an existing type into a draft, and inherits what the parent chain defines', () => {
    const { store, registry } = fixture()
    const d = typeDraft(store, registry(), 'architect')
    expect(d).toMatchObject({ name: 'architect', label: 'Architect', category: 'knowledge', parent: 'person' })
    expect(d.properties.map((p) => [p.key, p.was])).toEqual([['firm', 'firm']])
    expect(inheritedProperties(registry(), 'architect', 'person').map((p) => [p.key, p.from])).toEqual([['born', 'person'], ['nick', 'person']])
    expect(typeDraft(store, registry())).toMatchObject({ name: '', properties: [] })
    expect(typeSlug(' Research paper ')).toBe('research-paper')
  })

  it('checks names, loops and property keys', () => {
    const { store, registry } = fixture()
    const r = registry()
    const at = (issues: { at: string }[]) => issues.map((i) => i.at)
    expect(at(checkTypeDraft({ name: '', label: '', pluralLabel: '', category: 'knowledge', properties: [] }, r, { isNew: true, store }))).toEqual(['name', 'label'])
    expect(at(checkTypeDraft({ name: 'person', label: 'P', pluralLabel: '', category: 'knowledge', properties: [] }, r, { isNew: true, store }))).toEqual(['name'])
    // person → architect → person would be a loop.
    expect(at(checkTypeDraft({ ...typeDraft(store, r, 'person'), parent: 'architect' }, r, { isNew: false, store }))).toEqual(['parent'])
    expect(at(checkTypeDraft({ name: 'x', label: 'X', pluralLabel: 'Xs', category: 'knowledge', properties: [{ key: 'a' }, { key: 'a' }, { key: ' ' }] }, r, { isNew: true, store }))).toEqual(['property:1', 'property:2'])
  })
})

describe('saving a draft', () => {
  it('renames a property on every entity of the type and its subtypes, converting what a new kind can read', () => {
    const { store, registry } = fixture()
    const d = typeDraft(store, registry(), 'person')
    d.properties = [{ key: 'birth_year', was: 'born', kind: 'number', label: 'Born' }]
    const plan = planTypeDraft(store, registry(), d)
    expect(plan.entities).toBe(3)
    expect(plan.renamed).toEqual([{ from: 'born', to: 'birth_year', values: 3 }])
    // "long ago" is not a number: kept as it is, and counted.
    expect(plan.converted).toEqual([{ key: 'birth_year', kind: 'number', values: 2, kept: 1 }])
    expect(plan.removed).toEqual([{ key: 'nick', values: 1 }])
    applyTypeDraft(store, registry(), d)
    expect(store.get('p1')!.data).toEqual({ birth_year: 1815, nick: 'A' })
    expect(store.get('p2')!.data).toEqual({ birth_year: 'long ago' })
    expect(store.get('a1')!.data).toEqual({ birth_year: 1950, firm: 'ZHA' })
    // The definition says so, and the dropped property is gone from it (its values stay on the entities).
    expect(new TypeRegistry(store).propertiesOf('person')).toEqual([{ key: 'birth_year', kind: 'number', label: 'Born' }])
  })

  it('defines a new type with its properties, and takes a cleared parent or colour off the definition', () => {
    const { store, registry } = fixture()
    const { entity } = applyTypeDraft(store, registry(), { name: 'city', label: 'City', pluralLabel: 'Cities', category: 'knowledge', parent: 'person', color: '#123456', properties: [{ key: 'population', kind: 'number', required: true }, { key: 'kind', options: ['capital', 'town'] }] })
    expect(entity.id).toBe(schemaTypeId('city'))
    const r = new TypeRegistry(store)
    expect(r.get('city')).toMatchObject({ label: 'City', pluralLabel: 'Cities', parent: 'person', color: '#123456' })
    expect(r.propertiesOf('city')).toEqual([{ key: 'population', kind: 'number', required: true }, { key: 'kind', options: ['capital', 'town'] }])
    applyTypeDraft(store, r, { ...typeDraft(store, r, 'city'), parent: undefined, color: undefined })
    const again = new TypeRegistry(store).get('city')
    expect(again.parent).toBeUndefined()
    expect(store.get(schemaTypeId('city'))!.data.color).toBeUndefined()
  })

  it('reads yes-or-no words as true/false and leaves anything else as it is', () => {
    const store = new EntityStore()
    store.upsertMany([schemaTypeEntity('task', { label: 'Task', category: 'knowledge', properties: [{ key: 'done' }] }), createEntity({ id: 't1', type: 'task', data: { done: 'yes' } }), createEntity({ id: 't2', type: 'task', data: { done: 'maybe' } })])
    const r = new TypeRegistry(store)
    const d = typeDraft(store, r, 'task')
    d.properties = [{ key: 'done', was: 'done', kind: 'boolean' }]
    expect(planTypeDraft(store, r, d).converted).toEqual([{ key: 'done', kind: 'boolean', values: 1, kept: 1 }])
    applyTypeDraft(store, r, d)
    expect(store.get('t1')!.data.done).toBe(true)
    expect(store.get('t2')!.data.done).toBe('maybe')
  })
})

describe('a type’s colour is a colour', () => {
  const evil = ['url(https://evil.example/x)', 'red;background:url(https://evil.example/x)', 'red"><img src=x onerror=alert(1)>', 'expression(alert(1))']

  it('the registry reads one from data only when it is one — it reaches style wherever the type is drawn', () => {
    for (const color of evil) {
      const store = new EntityStore()
      store.upsert(schemaTypeEntity('thing', { label: 'Thing', category: 'knowledge', color }))
      const r = new TypeRegistry(store)
      expect(r.get('thing').color, color).toBeUndefined()
      expect(r.colorOf('thing'), color).toMatch(/^(#|hsl|rgb)/)
      expect(typeDraft(store, r, 'thing').color, color).toBeUndefined()
    }
    const store = new EntityStore()
    store.upsert(schemaTypeEntity('thing', { label: 'Thing', category: 'knowledge', color: ' #4f46e5 ' }))
    expect(new TypeRegistry(store).colorOf('thing')).toBe('#4f46e5')
  })

  it('a draft — the New type dialog, the Edit view, define_entity_type — with something else is refused, and nothing is written', () => {
    const { store, registry } = fixture()
    for (const color of evil) {
      const draft = { ...typeDraft(store, registry(), 'person'), color }
      expect(checkTypeDraft(draft, registry(), { isNew: false, store }).map((i) => i.at), color).toEqual(['color'])
      applyTypeDraft(store, registry(), draft)
      expect((store.get(schemaTypeId('person'))!.data as { color?: string }).color, color).toBeUndefined()
    }
    expect(checkTypeDraft({ ...typeDraft(store, registry(), 'person'), color: 'rgb(10, 20, 30)' }, registry(), { isNew: false, store })).toEqual([])
  })
})

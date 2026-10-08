import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { buildVocabulary, lexicalRank, terms } from '../vocabulary'

const make = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 's1', type: 'service', label: 'Orders', tags: ['topology', 'tier:app'] }),
    createEntity({ id: 's2', type: 'service', label: 'Payments', tags: ['topology'] }),
    createEntity({ id: 'd1', type: 'document', label: 'Architecture decision record', tags: ['adr'] }),
    createEntity({ id: 'p1', type: 'person', label: 'Ada' }),
  ])
  store.setTagInfo('topology', { description: 'Part of the system architecture diagram' })
  return store
}

describe('vocabulary', () => {
  it('lists the types and tags in use with counts, most first', () => {
    const store = make()
    const v = buildVocabulary(store, new TypeRegistry(store))
    expect(v.types.map((t) => [t.name, t.count])).toEqual([
      ['service', 2],
      ['document', 1],
      ['person', 1],
    ])
    expect(v.types[0].label).toBe('Service')
    expect(v.tags.map((t) => [t.tag, t.count])).toEqual([
      ['topology', 2],
      ['tier:app', 1],
      ['adr', 1],
    ])
    expect(v.tags[0].description).toContain('architecture')
  })

  it('splits a phrase into stemmed content words', () => {
    expect(terms('open everything about the architecture and services')).toEqual(['architecture', 'service'])
  })

  it('ranks by word overlap: names, then descriptions', () => {
    const store = make()
    const r = lexicalRank('architecture', buildVocabulary(store, new TypeRegistry(store)))
    expect(r.method).toBe('lexical')
    expect(r.types).toEqual([])
    expect(r.tags[0].key).toBe('topology')
    expect(r.tags[0].score).toBeCloseTo(0.8)
    const s = lexicalRank('services', buildVocabulary(store, new TypeRegistry(store)))
    expect(s.types[0]).toEqual({ key: 'service', score: 1 })
  })
})

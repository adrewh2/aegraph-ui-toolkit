import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { splitTag, tagMatrix } from '../tagStats'

function setup() {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['tier:app', 'lang:python', 'topology'] }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', tags: ['tier:data', 'topology'] }),
    createEntity({ id: 'p3', type: 'person', label: 'Grace', tags: [] }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes', tags: ['tier:app', 'url:https://x.y/z'] }),
    createRelationship({ id: 'r1', type: 'wrote', source: { id: 'p1' }, target: { id: 'w1' }, tags: ['topology'] }),
  ])
  return { store, registry: new TypeRegistry(store) }
}

describe('tag matrix', () => {
  it('splits key:value tags at the first colon and leaves plain tags whole', () => {
    expect(splitTag('tier:app')).toEqual({ key: 'tier', value: 'app' })
    expect(splitTag('url:https://x.y/z')).toEqual({ key: 'url', value: 'https://x.y/z' })
    expect(splitTag('topology')).toEqual({ key: 'topology' })
    expect(splitTag(':odd')).toEqual({ key: ':odd' })
  })

  it('counts types, keys, values and their crossings; relationships only on request', () => {
    const { store, registry } = setup()
    const m = tagMatrix(store, registry)
    expect(m.types.map((t) => [t.type, t.count, t.untagged])).toEqual([
      ['person', 3, 1],
      ['paper', 1, 0],
    ])
    const tier = m.keys.find((k) => k.key === 'tier')!
    expect(tier.count).toBe(3)
    expect(tier.faceted).toBe(true)
    expect(tier.values).toEqual(['app', 'data'])
    expect(m.keys.find((k) => k.key === 'topology')!.faceted).toBe(false)
    expect(m.byKey.get('person')!.get('tier')).toBe(2)
    expect(m.byTag.get('person')!.get('tier:app')).toBe(1)
    expect(m.byTag.get('paper')!.get('tier:app')).toBe(1)
    // Both facets on the same entity: tier and topology travel together on p1 and p2.
    expect(m.cooccur.get('tier')!.get('topology')).toBe(2)
    expect(m.cooccur.get('tier')!.get('tier')).toBe(3)
    expect(m.totals).toEqual({ entities: 4, tagged: 3, tags: 5, keys: 4 })

    const withLinks = tagMatrix(store, registry, { relationships: true })
    const link = withLinks.types.find((t) => t.kind === 'relationship')!
    expect(link.type).toBe('(wrote)')
    expect(withLinks.byKey.get('(wrote)')!.get('topology')).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../core/entity/entity'
import { EntityStore } from '../../core/entity/store'
import { relatedHref, relatedItems, relatedLabel, relatedTo } from '../openIn'

describe('related entities', () => {
  const store = new EntityStore()
  for (const id of ['theme', 'a', 'b', 'c', 'lonely']) store.upsert(createEntity({ id, type: 'x', label: id }))
  store.upsert(createRelationship({ id: 'r1', type: 'co-occurs', source: { id: 'theme' }, target: { id: 'a' } }))
  store.upsert(createRelationship({ id: 'r2', type: 'co-occurs', source: { id: 'b' }, target: { id: 'theme' } }))
  store.upsert(createRelationship({ id: 'r3', type: 'co-occurs', source: { id: 'a' }, target: { id: 'c' } }))

  it('collects one hop: the links and what is on the other end, never the seed', () => {
    expect(relatedTo(store, ['theme'])).toEqual({ entities: ['a', 'b'], relationships: ['r1', 'r2'] })
    // Multi-select: the union, minus the seeds themselves.
    expect(relatedTo(store, ['theme', 'a'])).toEqual({ entities: ['b', 'c'], relationships: ['r1', 'r2', 'r3'] })
    expect(relatedTo(store, ['lonely'])).toEqual({ entities: [], relationships: [] })
  })

  it('opens selected relationships with their sources and targets', () => {
    expect(relatedTo(store, ['r1', 'r3'])).toEqual({ entities: ['theme', 'a', 'c'], relationships: ['r1', 'r3'] })
    expect(relatedLabel(store, ['r1', 'r3'])).toBe('2 relationships with their sources and targets')
    expect(relatedLabel(store, ['r1'])).toBe('theme → a (co-occurs) with its source and target')
  })

  it('links to the mixed Entities table with a pick and a readable label', () => {
    const href = relatedHref(store, ['theme'])
    expect(href).toMatch(/^\/entities\?category=all&pick=/)
    const items = relatedItems(store, ['theme'], () => {})
    expect(items[0]).toMatchObject({ kind: 'item', label: 'Related entities (2 · 2 links)', disabled: false })
    expect(relatedItems(store, ['lonely'], () => {})[0]).toMatchObject({ disabled: true })
  })
})

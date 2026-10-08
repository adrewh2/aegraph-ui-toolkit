import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { layoutSchema, schemaNetwork, searchTriples } from '../schema'

function setup() {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: 1815 } }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912, died: 1954 } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes', data: { year: 1843 } }),
    createEntity({ id: 'w2', type: 'paper', label: 'Computable numbers', data: { year: 1936 } }),
    createEntity({ id: 'c1', type: 'concept', label: 'Computation' }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
    createRelationship({ id: 'r2', type: 'wrote', source: 'p2', target: 'w2' }),
    createRelationship({ id: 'r3', type: 'about', source: 'w2', target: 'c1' }),
    createRelationship({ id: 'r4', type: 'cites', source: 'w2', target: 'w1' }),
    createRelationship({ id: 'r5', type: 'knows', source: 'p1', target: 'p2', directed: false }),
    createRelationship({ id: 'r6', type: 'wrote', source: 'p2', target: 'ghost' }),
  ])
  return { store, net: schemaNetwork(store, new TypeRegistry(store)) }
}

describe('schema network', () => {
  it('counts type-to-type triples, ignoring instances, and reports the dangling ones', () => {
    const { net } = setup()
    expect(net.totals).toMatchObject({ entities: 5, relationships: 6, types: 3, predicates: 4, triples: 4, danglingRelationships: 1 })
    expect(net.triples[0]).toMatchObject({ source: 'person', rel: 'wrote', target: 'paper', count: 2, directed: true })
    expect(net.triples.find((t) => t.rel === 'knows')).toMatchObject({ source: 'person', target: 'person', directed: false })
    const paper = net.types.find((t) => t.type === 'paper')!
    expect(paper.count).toBe(2)
    expect(paper.degree).toBe(4) // wrote ×2 in, about out, cites (both ends are papers: counted once)
    expect(paper.properties).toEqual([{ key: 'year', count: 2 }])
    expect(net.links.find((l) => l.a === 'paper' && l.b === 'person')?.count).toBe(2)
    expect(net.predicates.map((p) => p.rel)).toEqual(['wrote', 'about', 'cites', 'knows'])
  })

  it('searches triples by type, relationship and "a → b" phrases', () => {
    const { net } = setup()
    expect(searchTriples(net, 'paper').map((t) => t.rel)).toEqual(['wrote', 'about', 'cites'])
    expect(searchTriples(net, 'person → paper').map((t) => t.rel)).toEqual(['wrote'])
    expect(searchTriples(net, 'cites')).toHaveLength(1)
    expect(searchTriples(net, 'nothing')).toHaveLength(0)
  })

  it('lays the types out inside the box', () => {
    const { net } = setup()
    const pos = layoutSchema(net, 600, 400, 100)
    expect(pos.size).toBe(3)
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(40)
      expect(p.x).toBeLessThanOrEqual(560)
      expect(p.y).toBeGreaterThanOrEqual(40)
      expect(p.y).toBeLessThanOrEqual(360)
    }
  })
})

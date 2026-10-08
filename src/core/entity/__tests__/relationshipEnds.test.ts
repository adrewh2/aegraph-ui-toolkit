import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'

/**
 * Each entity's relationships by end are kept as one id, a short array, or a set for a hub — not a set for every
 * end, which was most of the indexing time when a million-relationship Library loads. The answers do not change:
 * the same relationships, in the order they were made, through removals, re-pointing and hubs of any size.
 */
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const rel = (id: string, s: string, t: string) => createRelationship({ id, type: 'links', source: s, target: t })

describe('relationships by end', () => {
  it('keeps them in the order made, through one, a few and a hub past 64, and back down', () => {
    const s = new EntityStore()
    s.upsertMany([createEntity({ id: 'hub', type: 'thing' }), ...Array.from({ length: 100 }, (_, i) => createEntity({ id: `n${i}`, type: 'thing' }))])
    s.upsertMany(Array.from({ length: 100 }, (_, i) => rel(`r${i}`, `n${i}`, 'hub')))
    expect(ids(s.relationshipsOf('hub', 'in'))).toEqual(Array.from({ length: 100 }, (_, i) => `r${i}`))
    expect(ids(s.relationshipsOf('n5'))).toEqual(['r5'])
    s.remove(Array.from({ length: 98 }, (_, i) => `r${i}`))
    expect(ids(s.relationshipsOf('hub'))).toEqual(['r98', 'r99'])
    s.remove(['r98'])
    expect(ids(s.relationshipsOf('hub'))).toEqual(['r99'])
    s.remove(['r99'])
    expect(s.relationshipsOf('hub')).toEqual([])
  })

  it('follows a relationship moved to another end, a self-loop, and ends not in the store', () => {
    const s = new EntityStore()
    s.upsertMany([createEntity({ id: 'a', type: 'thing' }), createEntity({ id: 'b', type: 'thing' }), createEntity({ id: 'c', type: 'thing' })])
    s.upsertMany([rel('ab', 'a', 'b'), rel('ac', 'a', 'c'), rel('aa', 'a', 'a'), rel('ax', 'a', 'missing')])
    expect(ids(s.relationshipsOf('a', 'out'))).toEqual(['ab', 'ac', 'aa', 'ax'])
    expect(ids(s.relationshipsOf('a', 'in'))).toEqual(['aa'])
    expect(ids(s.relationshipsOf('a'))).toEqual(['ab', 'ac', 'aa', 'ax'])
    expect(ids(s.relationshipsOf('missing', 'in'))).toEqual(['ax'])
    s.upsert({ ...(s.get('ab') as ReturnType<typeof rel>), target: { id: 'c' } })
    expect(ids(s.relationshipsOf('b'))).toEqual([])
    expect(ids(s.relationshipsOf('c', 'in'))).toEqual(['ac', 'ab'])
    expect(s.neighbors('a', 'out').map((n) => n.entity.id)).toEqual(['c', 'c', 'a'])
  })
})

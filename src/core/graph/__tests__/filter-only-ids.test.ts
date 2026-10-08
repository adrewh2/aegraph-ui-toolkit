import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import '../types'

/**
 * A view of just some entities (`only` — a scene's nodes) starts from those ids, not from a query of every entity of
 * the types asked: the same nodes, in the same order, as the query and a filter would give — types in the order asked,
 * then the store's; text, scope and hidden categories applied alike.
 */
function store() {
  const s = new EntityStore()
  s.upsertMany(Array.from({ length: 60 }, (_, i) => createEntity({ id: `e${i}`, type: ['paper', 'person', 'note'][i % 3], label: i % 4 ? `Thing ${i}` : `Graph ${i}` })))
  s.upsert(createEntity({ id: 'def', type: 'schema:type', label: 'A type', data: { name: 'paper' } }))
  return s
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const viaQuery = (s: EntityStore, types: string[] | undefined, text: string | undefined, only: string[]) =>
  ids(s.query({ kind: 'entity', type: types, text }).filter((e) => only.includes(e.id) && e.type !== 'schema:type'))

describe('a view of just these entities', () => {
  it('gives the query’s nodes in the query’s order', () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const only = ['e40', 'e3', 'e17', 'e2', 'e58', 'e9', 'def', 'nope']
    for (const types of [undefined, ['note', 'paper'], ['person']])
      for (const text of [undefined, 'graph']) {
        const slice = applyFilter(s, reg, { ...emptyFilter(), only, ...(types ? { types } : {}), ...(text ? { text } : {}) })
        expect(ids(slice.nodes)).toEqual(viaQuery(s, types, text, only))
      }
  })
})

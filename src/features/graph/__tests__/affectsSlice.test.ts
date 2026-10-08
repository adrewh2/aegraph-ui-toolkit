import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { emptyFilter, type GraphSlice } from '../../../core/graph/filter'
import type { AnyEntity } from '../../../core/entity/types'
import '../../../core/graph/types'
import { affectsSlice } from '../explorerState'

/**
 * A view re-filters only for a write that can change it. It must never miss one: an entity in it, one its filter could
 * let in, a relationship touching its nodes, a removal of something in it — and anything the filter cannot rule out.
 */
const a = createEntity({ id: 'a', type: 'segment', label: 'A' })
const b = createEntity({ id: 'b', type: 'segment', label: 'B' })
const ab = createRelationship({ id: 'ab', type: 'in', source: 'a', target: 'b' })
const slice = { nodes: [a, b], edges: [ab], degree: new Map(), truncated: 0, candidates: 2 } as unknown as GraphSlice
const up = (...entities: AnyEntity[]) => ({ type: 'upsert' as const, entities })

describe('which writes can change a view', () => {
  it('a conversation elsewhere does not change a view of segments; one of its own types does', () => {
    const spec = { ...emptyFilter(), types: ['segment', 'cluster'] }
    expect(affectsSlice(up(createEntity({ id: 'chat', type: 'conversation', label: 'A chat' })), spec, slice)).toBe(false)
    expect(affectsSlice(up(createEntity({ id: 'c', type: 'cluster', label: 'New cluster' })), spec, slice)).toBe(true)
  })

  it('a view of just some ids: others do not change it; an edit to one in it, or a link to one, does', () => {
    const spec = { ...emptyFilter(), only: ['a', 'b'] }
    expect(affectsSlice(up(createEntity({ id: 'x', type: 'segment', label: 'X' })), spec, slice)).toBe(false)
    expect(affectsSlice(up({ ...a, label: 'A renamed' }), spec, slice)).toBe(true)
    expect(affectsSlice(up(createRelationship({ id: 'bx', type: 'in', source: 'b', target: 'x' })), spec, slice)).toBe(true)
    expect(affectsSlice(up(createRelationship({ id: 'xy', type: 'in', source: 'x', target: 'y' })), spec, slice)).toBe(false)
  })

  it('a filter it cannot read at a glance counts every new entity; removals count when they are in the view', () => {
    expect(affectsSlice(up(createEntity({ id: 'chat', type: 'conversation', label: 'A chat' })), { ...emptyFilter(), text: 'chat' }, slice)).toBe(true)
    expect(affectsSlice({ type: 'remove', ids: ['zzz'] }, emptyFilter(), slice)).toBe(false)
    expect(affectsSlice({ type: 'remove', ids: ['ab'] }, emptyFilter(), slice)).toBe(true)
    expect(affectsSlice({ type: 'upsert', entities: [a], volatile: true }, emptyFilter(), slice)).toBe(false)
    expect(affectsSlice({ type: 'batch', events: [{ type: 'tags' }, { type: 'reset' }] }, emptyFilter(), slice)).toBe(true)
  })
})

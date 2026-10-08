import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, datasetTotals } from '../filter'
import '../types'

/** The filter panel's "y": the dataset's totals before any filter, whatever the filter leaves in view. */
describe('datasetTotals', () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'paper', label: 'One' }),
    createEntity({ id: 'p2', type: 'paper', label: 'Two' }),
    createEntity({ id: 'a1', type: 'person', label: 'Ada' }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'a1', target: 'p1', directed: true }),
    createRelationship({ id: 'r2', type: 'wrote', source: 'a1', target: 'p2', directed: true }),
  ])
  const registry = new TypeRegistry(store)

  it('counts the whole dataset by node type and relationship type, not what the filter keeps', () => {
    const t = datasetTotals(store, registry)
    expect(t.types.get('paper')).toBe(2)
    expect(t.types.get('person')).toBe(1)
    expect(t.rels.get('wrote')).toBe(2)
    // A type unticked: 0 in view, still 2 of the total.
    const slice = applyFilter(store, registry, { types: ['person'] })
    expect(slice.nodes.filter((n) => n.type === 'paper')).toHaveLength(0)
    expect(datasetTotals(store, registry).types.get('paper')).toBe(2)
  })

  it('counts only the members when the dataset is a sub-project', () => {
    const t = datasetTotals(store, registry, new Set(['p1', 'a1', 'r1']))
    expect(t.types.get('paper')).toBe(1)
    expect(t.types.get('person')).toBe(1)
    expect(t.rels.get('wrote')).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { buildPlot } from '../../graph/plot'
import { listValueRefs, makeValueContext, parseValueRef, valueOf } from '../../graph/values'
import { nodeAttrValue } from '../../graph/rendering'
import { toChannel } from '../../graph/styleChannels'
import { DEFAULT_RENDERING } from '../../graph/rendering'
import { plotContextFor } from '../../../features/plots/plotContext'
import { datasetFromTable } from '../dataset'
import { datasetCountsFromEntities, datasetFromEntities } from '../fromEntities'
import { datasetRef, datasetRowEntities, parseDatasetRef, rowRef } from '../join'

/**
 * A dataset read against entities: `dataset:<id>.<column>` on the entity a row matches (by id, by type, or by the
 * first column), a dataset's rows as a chart's rows, and a table of counts made from entities — the three steps of
 * "count the entities, chart the counts, colour the graph by them".
 */
const ents = (store: EntityStore) => store.all().filter((e) => e.type === 'person' || e.type === 'org')

function fixture() {
  const store = new EntityStore()
  for (let i = 0; i < 3; i++) store.upsert(createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}` }))
  store.upsert(createEntity({ id: 'o1', type: 'org', label: 'Acme' }))
  const registry = new TypeRegistry(store)
  return { store, registry, values: makeValueContext({ scope: 'dataset', store }) }
}

describe('dataset refs', () => {
  it('parse: the id has no dot, the column may', () => {
    expect(parseDatasetRef('dataset:abc-1.count')).toEqual({ dataset: 'abc-1', column: 'count' })
    expect(parseDatasetRef('dataset:abc.data.x')).toEqual({ dataset: 'abc', column: 'data.x' })
    expect(parseDatasetRef('dataset:abc')).toBeUndefined()
    expect(parseValueRef(datasetRef('d1', 'count'))).toEqual({ kind: 'dataset', dataset: 'd1', column: 'count' })
  })

  it('reads a per-type table on every entity of the type, and a per-entity table on its entity', () => {
    const { store, registry, values } = fixture()
    const byType = datasetFromTable(['type', 'count'], [['person', 3], ['org', 1]], { label: 'Counts' })
    store.upsert(byType)
    expect(valueOf(store.require('p1'), `dataset:${byType.id}.count`, values)).toBe(3)
    expect(valueOf(store.require('o1'), `dataset:${byType.id}.Count`, values)).toBe(1) // by label too
    const byId = datasetFromEntities(registry, [store.require('p0'), store.require('o1')], { label: 'Some', columns: ['id', 'label'] })
    store.upsert(byId)
    expect(valueOf(store.require('o1'), `dataset:${byId.id}.label`, values)).toBe('Acme')
    expect(valueOf(store.require('p2'), `dataset:${byId.id}.label`, values)).toBeUndefined()
    // Unknown dataset or column: nothing, not a throw.
    expect(valueOf(store.require('p1'), 'dataset:nope.count', values)).toBeUndefined()
    expect(valueOf(store.require('p1'), `dataset:${byType.id}.nope`, values)).toBeUndefined()
  })

  it('follows an edit of the dataset (a new version is indexed afresh)', () => {
    const { store, values } = fixture()
    const d = datasetFromTable(['type', 'count'], [['person', 3]], { label: 'Counts' })
    store.upsert(d)
    expect(valueOf(store.require('p0'), `dataset:${d.id}.count`, values)).toBe(3)
    store.update(d.id, { data: { ...d.data, rows: [['person', 7]] } })
    expect(valueOf(store.require('p0'), `dataset:${d.id}.count`, values)).toBe(7)
  })

  it('offers a keyed dataset\'s columns in the value pickers, and a style channel accepts and reads them', () => {
    const { store, values } = fixture()
    const d = datasetFromTable(['type', 'count'], [['person', 3], ['org', 1]], { label: 'Counts' })
    store.upsert(d)
    const refs = listValueRefs(values, ents(store))
    expect(refs).toContainEqual(expect.objectContaining({ ref: `dataset:${d.id}.count`, group: 'Datasets', kind: 'numeric' }))
    expect(refs.some((r) => r.ref === `dataset:${d.id}.type`)).toBe(false) // the key column is not a value
    const ch = toChannel(DEFAULT_RENDERING, { scope: 'nodes', by: 'all', channel: 'color', mode: 'ranking', attr: { kind: 'value', ref: `dataset:${d.id}.count` }, palette: 'viridis' })
    if (!ch || ch.mode !== 'ranking') throw new Error('expected a ranking channel')
    expect(nodeAttrValue(store.require('p0'), ch.attr, { degree: new Map(), values })).toBe(3)
  })
})

describe('a dataset as a chart\'s rows', () => {
  it('rows become entities: id, label and type from columns of those names, every cell as data', () => {
    const d = datasetFromTable(['type', 'label', 'count'], [['person', 'Person', 3], ['org', 'Organisation', 1]], { label: 'Counts' })
    const rows = datasetRowEntities(d)
    expect(rows.map((r) => [r.id, r.type, r.label, r.data.count])).toEqual([
      [`${d.id}#0`, 'person', 'Person', 3],
      [`${d.id}#1`, 'org', 'Organisation', 1],
    ])
    expect(rowRef(d.data, 'count')).toBe('data.count')
    expect(rowRef(d.data, 'Count')).toBe('data.count')
    expect(rowRef(d.data, 'type')).toBe('type')
    expect(rowRef(d.data, 'data.count')).toBe('data.count')
  })

  it('a bar per row, the columns named bare', () => {
    const { store, registry } = fixture()
    const d = datasetFromTable(['type', 'count'], [['person', 3], ['org', 1]], { label: 'Counts' })
    store.upsert(d)
    const b = buildPlot({ dataset: d.id, traces: [{ kind: 'bar', x: 'type', y: 'count' }] }, plotContextFor(store, registry))
    expect(b.stats.rows).toBe(2)
    const t = b.data[0] as { x: unknown[]; y: unknown[] }
    expect(t.x).toEqual(['person', 'org'])
    expect(t.y).toEqual([3, 1])
    expect(() => buildPlot({ dataset: 'missing', traces: [{ kind: 'bar', x: 'type' }] }, plotContextFor(store, registry))).toThrow(/No dataset/)
  })
})

describe('counting entities into a dataset', () => {
  it('by type: type, label, count — most first — keyed so the counts read back on the entities', () => {
    const { store, registry, values } = fixture()
    const data = datasetCountsFromEntities(registry, ents(store), 'type', values)
    expect(data.columns.map((c) => c.key)).toEqual(['type', 'label', 'count'])
    expect(data.rows.map((r) => [r[0], r[2]])).toEqual([['person', 3], ['org', 1]])
    const d = datasetFromTable(['type', 'label', 'count'], data.rows, { label: 'Counts' })
    store.upsert(d)
    expect(valueOf(store.require('p2'), `dataset:${d.id}.count`, values)).toBe(3)
  })

  it('by tag, each tag once per entity, and a row for the untagged', () => {
    const { store, registry, values } = fixture()
    store.update('p0', { tags: ['a', 'b'] })
    store.update('p1', { tags: ['a', 'a'] })
    const data = datasetCountsFromEntities(registry, ents(store), 'tags', values)
    expect(data.columns.map((c) => c.key)).toEqual(['tag', 'count'])
    expect(data.rows).toEqual([['a', 2], ['b', 1], [null, 2]])
  })

  it('a computed column: degree beside the fields', () => {
    const { store, registry, values } = fixture()
    const d = datasetFromEntities(registry, ents(store), { label: 'Degrees', columns: ['id', 'label', 'degree'], values })
    expect(d.data.columns.map((c) => c.key)).toEqual(['id', 'label', 'degree'])
    expect(d.data.rows[0][2]).toBe(0)
    expect(() => datasetFromEntities(registry, ents(store), { label: 'x', columns: ['degree'] })).toThrow(/value context/)
  })
})

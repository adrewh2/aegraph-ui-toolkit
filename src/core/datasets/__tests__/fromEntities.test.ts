import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { isDataset } from '../dataset'
import { columnsForEntities, datasetFromEntities } from '../fromEntities'

/**
 * A dataset from entities: the rows are the entities, the columns the top
 * fields and the properties their types declare (hidden ones too), with
 * kinds from the properties; or just the fields asked for.
 */
function trees() {
  const store = new EntityStore()
  store.upsert(createEntity({ id: 'type:location', type: 'schema:type', label: 'Location', data: { name: 'location', properties: [{ key: 'lat', label: 'Latitude', kind: 'number', hidden: true }, { key: 'lng', label: 'Longitude', kind: 'number', hidden: true }] } }))
  store.upsert(createEntity({ id: 'type:tree', type: 'schema:type', label: 'Tree', data: { name: 'tree', parent: 'location', properties: [{ key: 'common', label: 'Common name', kind: 'text' }, { key: 'dbh', label: 'Trunk diameter (cm)', kind: 'number', description: 'At breast height' }, { key: 'planted', label: 'Planted' }] } }))
  store.upsert(createEntity({ id: 'tree:1', type: 'tree', label: 'Oak · 1 Elm St', tags: ['genus:quercus'], data: { lat: 43.7, lng: -79.4, common: 'Oak', dbh: 40, planted: '2001-05-01' } }))
  store.upsert(createEntity({ id: 'tree:2', type: 'tree', label: 'Maple · 2 Elm St', tags: ['genus:acer'], description: 'A big one', data: { lat: 43.71, lng: -79.41, common: 'Maple', planted: '1999-03-02' } }))
  return { store, registry: new TypeRegistry(store), rows: [store.get('tree:1')!, store.get('tree:2')!] }
}

describe('datasetFromEntities', () => {
  it('makes the top fields and every declared property a column, kinds from the properties, hidden coordinates included', () => {
    const { registry, rows } = trees()
    const e = datasetFromEntities(registry, rows, { label: 'Trees' })
    expect(isDataset(e)).toBe(true)
    const keys = e.data.columns.map((c) => c.key)
    expect(keys.slice(0, 5)).toEqual(['id', 'label', 'type', 'tags', 'description'])
    expect(keys).toContain('common')
    expect(keys).toContain('dbh')
    expect(keys).toContain('lat')
    expect(keys).toContain('lng')
    const dbh = e.data.columns.find((c) => c.key === 'dbh')!
    expect(dbh).toEqual({ key: 'dbh', label: 'Trunk diameter (cm)', kind: 'number', description: 'At breast height' })
    // A property declared without a kind is text to the registry, and so here.
    expect(e.data.columns.find((c) => c.key === 'planted')!.kind).toBe('text')
    expect(e.data.rows).toHaveLength(2)
    const row = Object.fromEntries(keys.map((k, i) => [k, e.data.rows[0][i]]))
    expect(row).toMatchObject({ id: 'tree:1', label: 'Oak · 1 Elm St', type: 'tree', tags: ['genus:quercus'], description: null, common: 'Oak', dbh: 40, lat: 43.7 })
    expect(Object.fromEntries(keys.map((k, i) => [k, e.data.rows[1][i]])).dbh).toBeNull()
    expect(e.data.source).toMatchObject({ kind: 'entities', count: 2 })
  })

  it('keeps just the fields asked for, keyed by their last segment, the path when that is taken', () => {
    const { registry, rows } = trees()
    const { columns, paths } = columnsForEntities(registry, rows, ['label', 'data.dbh', 'data.common', 'meta.createdAt', 'data.label'])
    expect(paths).toEqual(['label', 'data.dbh', 'data.common', 'meta.createdAt', 'data.label'])
    expect(columns.map((c) => c.key)).toEqual(['label', 'dbh', 'common', 'createdAt', 'data.label'])
    expect(columns[1]).toMatchObject({ label: 'Trunk diameter (cm)', kind: 'number' })
    const e = datasetFromEntities(registry, rows, { label: 'Sizes', columns: ['label', 'data.dbh', 'meta.createdAt'] })
    expect(e.data.rows.map((r) => r.slice(0, 2))).toEqual([['Oak · 1 Elm St', 40], ['Maple · 2 Elm St', null]])
    // A column no type declares gets its kind read off the values.
    expect(e.data.columns[2].key).toBe('createdAt')
    expect(e.data.columns[2].kind).toMatch(/^date/)
  })
})

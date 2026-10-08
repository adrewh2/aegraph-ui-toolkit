import { describe, expect, it } from 'vitest'
import { SCHEMA_TYPE, schemaTypeId } from '../categories'
import { createEntity, createRelationship } from '../entity'
import { defineEntityType } from '../schema'
import { EntityStore } from '../store'
import { applyLayout, schemaTypeEntity, TypeRegistry } from '../typeRegistry'

defineEntityType({ type: 'reg-webpage', label: 'Webpage', pluralLabel: 'Webpages', category: 'resource', fields: [] })

describe('TypeRegistry', () => {
  it('colorOf: a declared colour wins, the rest are spread, and nothing moves between loads', () => {
    const build = () =>
      new TypeRegistry(
        (() => {
          const s = new EntityStore()
          s.upsertMany([
            createEntity({ id: 't1', type: 'tree' }),
            createEntity({ id: 's1', type: 'species' }),
            createEntity({ id: 'g1', type: 'genus' }),
            createEntity({ id: 'w1', type: 'ward' }),
            createEntity({ id: 'm1', type: 'municipality' }),
            createEntity({ id: 'n1', type: 'neighbourhood' }),
            schemaTypeEntity('tree', { color: '#16a34a' }),
          ])
          return s
        })(),
      )
    const r = build()
    // What a type says it is, is what it is.
    expect(r.colorOf('tree')).toBe('#16a34a')
    // The rest get their own, and no two of them are the same.
    const rest = ['species', 'genus', 'ward', 'municipality', 'neighbourhood']
    const colors = rest.map((t) => r.colorOf(t))
    expect(new Set(colors).size).toBe(rest.length)
    // Nor the same hue, which is what made a legend of four pale blues.
    const hue = (c: string) => Number(/^hsl\((\d+)/.exec(c)![1])
    expect(new Set(colors.map(hue)).size).toBe(rest.length)
    // The same ontology gives the same colours however many times it is loaded, and whatever order it is asked in.
    const again = build()
    for (const t of [...rest].reverse()) expect(again.colorOf(t)).toBe(r.colorOf(t))
    // A type the registry never saw still gets one rather than nothing.
    expect(r.colorOf('unheard-of')).toMatch(/^hsl\(/)
  })

  it('categorises code, schema, and inferred types', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'w', type: 'reg-webpage' }),
      createEntity({ id: 'p', type: 'philosopher' }),
      createEntity({ id: 'l', type: 'my-layout' }),
      schemaTypeEntity('my-layout', { label: 'My layout', category: 'project' }),
      // A definition saved before the category was renamed reads as project.
      schemaTypeEntity('old-view', { label: 'Old view', category: 'graph' }),
      schemaTypeEntity('philosopher', { parent: 'person', color: '#abc' }),
    ])
    const r = new TypeRegistry(s)
    expect(r.get('reg-webpage')).toMatchObject({ category: 'resource', origin: 'code', count: 1 })
    expect(r.get('philosopher')).toMatchObject({ category: 'knowledge', origin: 'schema', parent: 'person', color: '#abc', count: 1 })
    expect(r.get('old-view').category).toBe('project')
    expect(r.get('my-layout')).toMatchObject({ category: 'project', origin: 'schema', label: 'My layout', count: 1 })
    expect(r.get('never-seen')).toMatchObject({ category: 'knowledge', origin: 'inferred', count: 0 })
    expect(r.categoryOf(SCHEMA_TYPE)).toBe('schema')
  })

  it('keeps relationship vocabulary out of entity facets', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'a', type: 'person' }),
      createEntity({ id: 'b', type: 'person' }),
      createRelationship({ id: 'r', type: 'influenced', source: 'a', target: 'b' }),
    ])
    const r = new TypeRegistry(s)
    expect(r.inCategory('knowledge').map((t) => t.type)).toEqual(['person'])
    expect(r.relationshipTypes().map((t) => t.type)).toEqual(['influenced'])
    expect(r.get('influenced')).toMatchObject({ kind: 'relationship', count: 0, relationshipCount: 1 })
    expect(r.countInCategory('knowledge')).toBe(2)
  })

  it('builds a parent tree', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: '1', type: 'poet' }),
      createEntity({ id: '2', type: 'poet' }),
      createEntity({ id: '3', type: 'field' }),
      schemaTypeEntity('person', { label: 'Person' }),
      schemaTypeEntity('poet', { parent: 'person' }),
    ])
    const tree = new TypeRegistry(s).tree('knowledge')
    expect(tree.map((n) => [n.type.type, n.children.map((c) => c.type)])).toEqual([
      ['field', []],
      ['person', ['poet']],
    ])
  })

  it('schemaTypeEntity updates in place and keeps the id stable', () => {
    const a = schemaTypeEntity('thing', { color: '#111', description: 'first' })
    const b = schemaTypeEntity('thing', { parent: 'object' }, a)
    expect(b.id).toBe(schemaTypeId('thing'))
    expect(b.data).toMatchObject({ name: 'thing', color: '#111', parent: 'object' })
    expect(b.description).toBe('first')
    expect(b.type).toBe(SCHEMA_TYPE)
  })
})

describe('data-defined properties', () => {
  it('become fields of the type, its subtypes, and columns; values are read like typed text', async () => {
    const { EntityStore } = await import('../store')
    const { TypeRegistry, withProperty, withoutProperty } = await import('../typeRegistry')
    const { createEntity } = await import('../entity')
    const { kindOfValue, parsePropertyValue, propertyKey } = await import('../schema')
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'p1', type: 'person', data: { born: 1815 } }))
    store.upsert(withProperty(store, 'person', { key: 'born', kind: 'number' }))
    store.upsert(withProperty(store, 'person', { key: 'nickname' }))
    store.upsert(withProperty(store, 'architect', { key: 'style' }))
    store.upsert({ ...store.get('type:architect')!, data: { ...store.get('type:architect')!.data, parent: 'person' } })
    const reg = new TypeRegistry(store)
    expect(reg.propertiesOf('person').map((p) => p.key)).toEqual(['born', 'nickname'])
    expect(reg.fieldsFor('person').map((f) => f.key)).toContain('data.born')
    expect(reg.fieldsFor('person').find((f) => f.key === 'data.born')?.kind).toBe('number')
    expect(reg.fieldsFor('architect').map((f) => f.key)).toEqual(expect.arrayContaining(['data.style', 'data.born']))
    store.upsert(withoutProperty(store, 'person', 'nickname')!)
    expect(new TypeRegistry(store).propertiesOf('person').map((p) => p.key)).toEqual(['born'])
    expect(parsePropertyValue('42')).toBe(42)
    expect(parsePropertyValue('true')).toBe(true)
    expect(parsePropertyValue('[1, 2]')).toEqual([1, 2])
    expect(parsePropertyValue('hello world')).toBe('hello world')
    expect(parsePropertyValue('42', 'text')).toBe('42')
    expect(kindOfValue('https://x.y')).toBe('url')
    expect(kindOfValue(3)).toBe('number')
    expect(propertyKey('  release year ')).toBe('release_year')
  })
})

describe('coerceToKind', () => {
  it('fits values to a kind or refuses', async () => {
    const { coerceToKind, kindOfValue } = await import('../schema')
    expect(coerceToKind('42', 'number')).toBe(42)
    expect(coerceToKind('abc', 'number')).toBeUndefined()
    expect(coerceToKind('yes', 'boolean')).toBe(true)
    expect(coerceToKind('2026-09-12', 'date')).toBe('2026-09-12')
    expect(coerceToKind('2026-09-12T10:00:00Z', 'date')).toBe('2026-09-12')
    expect(coerceToKind('not a date', 'date')).toBeUndefined()
    expect(coerceToKind('2026-09-12T10:00:00.000Z', 'datetime')).toBe('2026-09-12T10:00:00.000Z')
    expect(coerceToKind('[1,2]', 'json')).toEqual([1, 2])
    expect(coerceToKind(7, 'text')).toBe('7')
    expect(coerceToKind('42', undefined)).toBe(42)
    expect(kindOfValue('2026-09-12')).toBe('date')
    expect(kindOfValue('2026-09-12T10:00:00Z')).toBe('datetime')
  })
})

describe('table layouts', () => {
  it('a type definition lays out its columns, and a subtype inherits it', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'type:location', type: 'schema:type', label: 'Location', data: { name: 'location', properties: [{ key: 'at', kind: 'datetime' }, { key: 'until', kind: 'datetime' }], table: { columns: ['data.at', 'data.until'], hidden: ['meta.createdAt'], sort: { key: 'data.at', dir: 'asc' } } } }))
    store.upsert(createEntity({ id: 'type:sight', type: 'schema:type', label: 'Sight', data: { name: 'sight', parent: 'location' } }))
    store.upsert(createEntity({ id: 'type:beach', type: 'schema:type', label: 'Beach', data: { name: 'beach', parent: 'location', table: { columns: ['tags'] } } }))
    const reg = new TypeRegistry(store)
    const keys = reg.fieldsFor('sight').map((f) => f.key)
    // The label stays first; then the layout's columns; the rest as they were.
    expect(keys.slice(0, 3)).toEqual(['label', 'data.at', 'data.until'])
    expect(reg.fieldsFor('sight').find((f) => f.key === 'data.until')?.hidden).toBeFalsy()
    expect(reg.fieldsFor('sight').find((f) => f.key === 'meta.createdAt')?.hidden).toBe(true)
    expect(reg.tableOf('sight')?.sort).toEqual({ key: 'data.at', dir: 'asc' })
    // A subtype with its own layout uses that instead of the parent's.
    expect(reg.fieldsFor('beach').map((f) => f.key).slice(0, 2)).toEqual(['label', 'tags'])
    expect(reg.tableOf('beach')).toEqual({ columns: ['tags'] })
    expect(reg.rootOf('sight')).toBe('location')
    expect(reg.ancestry('sight')).toEqual(['sight', 'location'])
    expect(reg.tableOf('person')).toBeUndefined()
  })

  it('applyLayout keeps the identity column first even when the layout names another first', () => {
    const fields = [
      { key: 'label', label: 'Label', kind: 'text' as const },
      { key: 'type', label: 'Type', kind: 'text' as const },
      { key: 'data.x', label: 'X', kind: 'text' as const, hidden: true },
    ]
    expect(applyLayout(fields, { columns: ['data.x', 'label'] }).map((f) => `${f.key}${f.hidden ? '-' : ''}`)).toEqual(['label', 'data.x', 'type'])
    expect(applyLayout(fields, undefined)).toBe(fields)
  })
})

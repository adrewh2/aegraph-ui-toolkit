import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import { EntityStore } from '../../../entity/store'
import { buildBundle, importBundle } from '../../../projects/bundle'
import { createProject } from '../../../projects/project'
import '../../../resources/types'
import '../../../graph/types'
import { emptyAe, isAeDocument, validateAe } from '../validate'

/**
 * The validator at its edges: documents that are not objects, no or a
 * wrong $schema, entities that is not a list, an entity missing each
 * required key or holding the wrong kind of value, duplicate ids (reported,
 * not an error), relationships without ends, to themselves, to nowhere,
 * with the wrong kind; tags of every wrong shape; dates that are not ISO;
 * the document's own keys; type definitions whose id and name disagree;
 * selectors of every kind at their bounds; fifty thousand entities in
 * well under a second. Then the bundle: a `project` naming nothing or
 * a non-project, a bare list, junk entries skipped, older and newer
 * copies, marks from another project travelling with an entity, the
 * closure following ids in data but not into projects or huge arrays.
 */
const T = '2026-01-01T00:00:00Z'
const meta = { createdAt: T, updatedAt: T }
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'entity', type: 'note', tags: [], data: {}, meta, ...over })
const rel = (id: string, source: string, target: string, over: Record<string, unknown> = {}) => ({ id, kind: 'relationship', type: 'r', tags: [], data: {}, meta, source: { id: source }, target: { id: target }, ...over })
const docOf = (entities: unknown[], over: Record<string, unknown> = {}) => ({ $schema: 'aegraph/v1', entities, ...over })
const paths = (d: unknown) => validateAe(d).issues.map((i) => i.path)

describe('validateAe edges', () => {
  it('a document that is not an object, has no or the wrong $schema, or whose entities is not a list, stops with the reason; counts stay zero', () => {
    for (const junk of [null, undefined, [], 'x', 42]) expect(validateAe(junk), String(junk)).toEqual({ ok: false, issues: [{ path: '', message: 'the document must be a JSON object' }], entities: 0, relationships: 0, unresolved: [], duplicates: [] })
    expect(paths({ entities: [] })).toEqual(['/$schema'])
    expect(paths({ $schema: 'aegraph/v2', entities: [] })).toEqual(['/$schema'])
    expect(paths({ $schema: 'aegraph/v1' })).toEqual(['/entities'])
    expect(paths({ $schema: 'aegraph/v1', entities: {} })).toEqual(['/entities'])
    expect(paths({ entities: 'no' })).toEqual(['/$schema', '/entities'])
    expect(validateAe(docOf([]))).toMatchObject({ ok: true, entities: 0, relationships: 0 })
    expect(validateAe(emptyAe()).ok).toBe(true)
    expect(isAeDocument(docOf([]))).toBe(true)
    expect(isAeDocument({ $schema: 'aegraph/v1', entities: null })).toBe(false)
    expect(isAeDocument([])).toBe(false)
  })

  it('an entity missing each required key, or holding the wrong kind of value, is named by its pointer; an empty id or type is missing; duplicates are reported but not an error', () => {
    expect(paths(docOf([null, 'x', 7]))).toEqual(['/entities/0', '/entities/1', '/entities/2'])
    expect(paths(docOf([{}]))).toEqual(['/entities/0/id', '/entities/0/type', '/entities/0/tags', '/entities/0/data', '/entities/0/meta'])
    expect(paths(docOf([ent('', { type: '' })]))).toEqual(['/entities/0/id', '/entities/0/type'])
    expect(paths(docOf([ent('a', { label: 1, description: [], tags: 'x', data: [], meta: 'm' })]))).toEqual(['/entities/0/label', '/entities/0/description', '/entities/0/tags', '/entities/0/data', '/entities/0/meta'])
    expect(paths(docOf([ent('a', { kind: 'thing' })]))).toEqual(['/entities/0/kind'])
    expect(paths(docOf([ent('a', { kind: undefined })]))).toEqual([])
    const dup = validateAe(docOf([ent('a'), ent('a'), ent('b'), ent('a')]))
    expect(dup.ok).toBe(true)
    expect(dup.duplicates).toEqual(['a'])
    expect(dup.entities).toBe(4)
  })

  it('tags of every wrong shape, dates that are not ISO (a date alone is), meta strings and lists, and references by shape', () => {
    expect(paths(docOf([ent('a', { tags: [1, '', 'ok', 'ok'] })]))).toEqual(['/entities/0/tags/0', '/entities/0/tags/1', '/entities/0/tags'])
    expect(paths(docOf([ent('a', { meta: { createdAt: 'yesterday', updatedAt: 1_700_000_000_000 } })]))).toEqual(['/entities/0/meta/createdAt', '/entities/0/meta/updatedAt'])
    expect(paths(docOf([ent('a', { meta: { createdAt: '2024-05-01', updatedAt: '2024-05-01T10:00:00+02:00', accessedAt: 'x', createdBy: 7, source: [], projects: ['p', 1], derivedFrom: 'not-a-ref' } })]))).toEqual(['/entities/0/meta/accessedAt', '/entities/0/meta/createdBy', '/entities/0/meta/source', '/entities/0/meta/derivedFrom', '/entities/0/meta/projects'])
    expect(paths(docOf([ent('a', { meta: { ...meta, derivedFrom: { id: 'b', extra: 1 } } })]))).toEqual(['/entities/0/meta/derivedFrom/extra'])
    expect(validateAe(docOf([ent('a', { meta: { ...meta, derivedFrom: { id: 'gone' } } })])).unresolved).toEqual(['gone'])
  })

  it('relationships: no ends, one end, an end to itself, an end to nowhere, the wrong kind, a non-boolean direction; an entity with a source is a relationship', () => {
    expect(paths(docOf([{ ...ent('r'), kind: 'relationship' }]))).toEqual(['/entities/0/source', '/entities/0/target'])
    expect(paths(docOf([rel('r', 'a', 'b', { target: undefined })]))).toEqual(['/entities/0/target'])
    const self = validateAe(docOf([ent('a'), rel('r', 'a', 'a')]))
    expect(self).toMatchObject({ ok: true, entities: 1, relationships: 1, unresolved: [] })
    const nowhere = validateAe(docOf([rel('r', 'x', 'y')]))
    expect(nowhere.ok).toBe(true)
    expect(nowhere.unresolved).toEqual(['x', 'y'])
    expect(paths(docOf([rel('r', 'a', 'b', { kind: 'entity' })]))).toEqual(['/entities/0/kind'])
    expect(paths(docOf([rel('r', 'a', 'b', { kind: undefined, directed: 'yes' })]))).toEqual(['/entities/0/kind', '/entities/0/directed'])
    expect(paths(docOf([rel('r', 'a', 'b', { source: 'a' })]))).toEqual(['/entities/0/source'])
    expect(paths(docOf([rel('r', 'a', 'b', { source: { id: 'a', weight: 2 } })]))).toEqual(['/entities/0/source/weight'])
  })

  it('the document’s own keys: exportedAt, tags entries and unknown keys, project as a non-string, state as a non-object or with unknown keys', () => {
    expect(paths(docOf([], { exportedAt: 'soon' }))).toEqual(['/exportedAt'])
    expect(paths(docOf([], { tags: {} }))).toEqual(['/tags'])
    expect(paths(docOf([], { tags: [{ tag: '' }, { tag: 'a', colour: '#fff' }, 'b', { tag: 'c', color: '#fff', description: 'd' }] }))).toEqual(['/tags/0', '/tags/1/colour', '/tags/2'])
    expect(paths(docOf([], { project: 7 }))).toEqual(['/project'])
    expect(paths(docOf([], { project: 'nobody' }))).toEqual([]) // naming an entity the file lacks is not the validator's business
    expect(paths(docOf([], { state: [] }))).toEqual(['/state'])
    expect(paths(docOf([], { state: { route: '/x', ui: {}, theme: 'dark' } }))).toEqual(['/state/theme'])
  })

  it('type definitions: an id without the prefix, a name that disagrees with the id, no name, junk category and property shapes; selectors of each kind at their bounds', () => {
    const typeDef = (id: string, data: Record<string, unknown>) => ent(id, { type: 'schema:type', data })
    expect(paths(docOf([typeDef('type:a', { name: 'b' })]))).toEqual(['/entities/0/id'])
    expect(paths(docOf([typeDef('type:a', {})]))).toEqual(['/entities/0/data/name'])
    expect(paths(docOf([typeDef('a', { name: 'a' })]))).toEqual(['/entities/0/id'])
    expect(paths(docOf([typeDef('type:a', { name: 'a', category: 'graph', parent: 1, color: 2, pluralLabel: 3, properties: 'x' })]))).toEqual(['/entities/0/data/parent', '/entities/0/data/color', '/entities/0/data/pluralLabel', '/entities/0/data/properties'])
    expect(paths(docOf([typeDef('type:a', { name: 'a', properties: [{}, { key: 'k', kind: 'blob', options: [1], required: 'yes', extra: true }] })]))).toEqual(['/entities/0/data/properties/0', '/entities/0/data/properties/1/extra', '/entities/0/data/properties/1/kind', '/entities/0/data/properties/1/options', '/entities/0/data/properties/1/required'])
    const withSel = (selector: unknown) => docOf([rel('r', 'a', 'b', { target: { id: 'b', selector } })])
    expect(paths(withSel({ kind: 'nope' }))).toEqual(['/entities/0/target/selector'])
    expect(paths(withSel({ kind: 'geo', lat: 91, lng: -181, radius: 'far', at: 'never' }))).toEqual(['/entities/0/target/selector/radius', '/entities/0/target/selector/lat', '/entities/0/target/selector/lng', '/entities/0/target/selector/at'])
    expect(paths(withSel({ kind: 'geo', lat: 90, lng: 180 }))).toEqual([])
    expect(paths(withSel({ kind: 'time', start: 0, region: { x: 0, y: 0, width: 1 } }))).toEqual(['/entities/0/target/selector/region'])
    expect(paths(withSel({ kind: 'range', start: 1, end: '2', extra: 1 }))).toEqual(['/entities/0/target/selector/extra', '/entities/0/target/selector/end'])
    expect(paths(withSel({ kind: 'fragment', value: 3 }))).toEqual(['/entities/0/target/selector/value'])
    expect(paths(withSel({ kind: 'text', exact: 'x', prefix: 1 }))).toEqual(['/entities/0/target/selector/prefix'])
  })

  it('fifty thousand entities and relationships validate in well under a second, with the counts right', () => {
    const entities: unknown[] = []
    for (let i = 0; i < 25_000; i++) entities.push(ent(`n${i}`, { tags: ['a', 'b'], data: { i } }))
    for (let i = 1; i < 25_000; i++) entities.push(rel(`r${i}`, `n${i - 1}`, `n${i}`))
    const t0 = performance.now()
    const r = validateAe(docOf(entities))
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(r).toMatchObject({ ok: true, entities: 25_000, relationships: 24_999, unresolved: [], duplicates: [] })
  })
})

describe('bundle edges', () => {
  beforeEach(() => {
    const mem: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
  })

  it('a project key naming nothing or a non-project gets a new project named after the file; a bare list too; junk entries and tags are skipped and counted', () => {
    const store = new EntityStore()
    // The loader is lenient: an object without an id gets `import-<index>`; only non-objects are skipped.
    const r = importBundle(store, { entities: [ent('a'), null, { id: '' }, 'x', ent('b')], tags: [{ tag: 'a', color: '#123' }, { colour: 1 }, 'z'], project: 'nobody' }, { name: 'File' })
    expect(r).toMatchObject({ created: 4, updated: 0, upToDate: 0, skipped: 2 })
    expect(store.has('import-2')).toBe(true)
    expect(r.project.label).toBe('File')
    expect(store.projectsOf('a')).toEqual([r.project.id])
    expect(store.getTagInfo('a')).toMatchObject({ color: '#123' })
    const r2 = importBundle(store, { entities: [ent('c')], project: 'a' })
    expect(r2.project.label).toBe('Imported project')
    expect(r2.project.id).not.toBe('a')
    const r3 = importBundle(store, [ent('d')])
    expect(r3.created).toBe(2)
    expect(() => importBundle(store, {})).toThrow(/Not an aegraph document/)
    expect(() => importBundle(store, 'nope')).toThrow(/Not an aegraph document/)
  })

  it('an older copy is up to date and stays the Library’s; a newer copy of the project’s own updates; a project entity older than the store’s stays; marks from another project are dropped', () => {
    const src = new EntityStore()
    src.upsertMany([createEntity({ id: 'a', type: 'note', label: 'A' }), createEntity({ id: 'b', type: 'note', label: 'B' }), createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' })])
    src.upsertMany([createProject({ id: 'p1', label: 'One' }), createProject({ id: 'p2', label: 'Two' })])
    src.mark(['a', 'b'], 'p1')
    src.mark(['a'], 'p2')
    const bundle = JSON.parse(JSON.stringify(buildBundle(src, 'p1', { withState: false })))
    expect(bundle.state).toBeUndefined()
    expect(bundle.entities.map((e: { id: string }) => e.id).sort()).toEqual(['a', 'ab', 'b', 'p1'])
    expect(validateAe(bundle).ok).toBe(true)
    const dst = new EntityStore()
    dst.upsert(createEntity({ id: 'a', type: 'note', label: 'A newer', meta: { updatedAt: '2999-01-01T00:00:00Z' } }))
    const r = importBundle(dst, bundle)
    expect(r).toMatchObject({ created: 3, updated: 0, upToDate: 1 })
    expect(dst.get('a')!.label).toBe('A newer')
    // `a` was the Library's before the file came: not taken into the file's project, and no mark for p2 from a file.
    expect(dst.projectsOf('a')).toEqual([])
    expect(dst.projectsOf('b')).toEqual(['p1'])
    expect(dst.has('p2')).toBe(false)
    expect([...dst.scopeOf('p1')].sort()).toEqual(['ab', 'b'])
    // A newer copy of b updates it; an older project entity does not overwrite the store's.
    const again = JSON.parse(JSON.stringify(bundle))
    again.entities.find((e: { id: string }) => e.id === 'b').label = 'B2'
    again.entities.find((e: { id: string }) => e.id === 'b').meta.updatedAt = '2999-01-01T00:00:00Z'
    again.entities.find((e: { id: string }) => e.id === 'p1').label = 'Old name'
    again.entities.find((e: { id: string }) => e.id === 'p1').meta.updatedAt = '2000-01-01T00:00:00Z'
    const r2 = importBundle(dst, again)
    expect(r2).toMatchObject({ created: 0, updated: 1, upToDate: 2 })
    expect(dst.get('b')!.label).toBe('B2')
    expect(dst.get('p1')!.label).toBe('One')
  })

  it('the closure follows ids in data, not into projects, arrays past five thousand, or beyond depth six; relationships among the closure come along', () => {
    const store = new EntityStore()
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'far-away' } } } } } } }
    store.upsertMany([
      createEntity({ id: 'home', type: 'scene', data: { layoutId: 'layout-1', other: 'proj', big: Array.from({ length: 5001 }, () => 'huge-ref'), ...deep } }),
      createEntity({ id: 'layout-1', type: 'layout', data: { positions: {} } }),
      createEntity({ id: 'huge-ref', type: 'note' }),
      createEntity({ id: 'far-away', type: 'note' }),
      createEntity({ id: 'sh', type: 'note' }),
      createEntity({ id: 'out', type: 'note' }),
      createRelationship({ id: 'home-layout', type: 'r', source: 'home', target: 'layout-1' }),
      createRelationship({ id: 'home-out', type: 'r', source: 'home', target: 'out' }),
      createProject({ id: 'proj', label: 'P' }),
    ])
    store.mark(['home'], 'proj')
    const ids = buildBundle(store, 'proj', { withState: false }).entities.map((e) => e.id).sort()
    expect(ids).toEqual(['home', 'home-layout', 'layout-1', 'proj'])
    expect(ids).not.toContain('huge-ref')
    expect(ids).not.toContain('far-away')
    expect(ids).not.toContain('sh') // an id shorter than four characters is never followed
    expect(ids).not.toContain('out') // a relationship to something outside brings nothing in
  })
})

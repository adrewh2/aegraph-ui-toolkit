import { afterEach, describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../../core/entity/typeRegistry'
import { createProject } from '../../../core/projects/project'
import { Sandbox } from '../../../scripting/sandbox'
import { getLatestAnalysis, setLatestAnalysis, type LatestAnalysis } from '../../analysis/latest'
import { buildSnapshot, snapshotProvider } from '../snapshot'
import '../../../core/graph/types'
import '../script'

/**
 * What a script sees as `ds`, at the edges: an empty store, an entity with
 * nothing optional, meta flattened beside a data key of the same name, a
 * relationship with a missing end or an end outside the dataset, a
 * self-loop and parallel relationships, a project scope, unicode ids, a
 * Date / undefined / NaN / deep object in data, the string stub and the
 * per-entity budget, metrics only when the run matches the dataset, the
 * key moving only with material changes, thousands of entities in bounds —
 * and the prelude's ds helpers answering over the snapshot in the sandbox.
 */
const fixture = () => {
  const store = new EntityStore()
  return { store, registry: new TypeRegistry(store) }
}
const T = { createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }

describe('snapshot edges', () => {
  afterEach(() => setLatestAnalysis(null))

  it('an empty store is an empty Library snapshot with a key and no metrics', async () => {
    const { store, registry } = fixture()
    const { key, snapshot } = buildSnapshot(store, registry)
    // The ontology holds the types declared in code even when no entity uses them; nothing else.
    expect(snapshot).toEqual({ scope: { label: 'Library' }, entities: [], relationships: [], ontology: expect.any(Array), tags: [] })
    expect(snapshot.ontology!.every((t) => t.count === 0 && t.kind === 'entity')).toBe(true)
    expect(key).toBe('library:0:')
    expect(JSON.parse(await snapshotProvider(store, registry)().json())).toEqual(snapshot)
  })

  it('the snapshot carries the project state: the open project, the ontology with declared properties and counts, the tags with colours', () => {
    const { store } = fixture()
    store.upsertMany([
      createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['reviewed'], data: { born: 1815 } }),
      createEntity({ id: 'w1', type: 'paper', label: 'Notes', tags: ['reviewed', 'draft'] }),
      createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
    ])
    store.upsert(schemaTypeEntity('person', { label: 'Person', description: 'A human', properties: [{ key: 'born', kind: 'number', description: 'Year of birth' }] }))
    store.setTagInfo('reviewed', { color: '#0f0' })
    const project = createProject({ id: 'proj', label: 'Papers', description: 'scratch' })
    store.upsert(project)
    store.mark(['p1', 'w1'], 'proj')
    store.setScope('proj')
    const { snapshot } = buildSnapshot(store, new TypeRegistry(store))
    expect(snapshot.project).toMatchObject({ id: 'proj', label: 'Papers', description: 'scratch', includes: [] })
    expect(snapshot.ontology!.map((t) => [t.type, t.kind, t.count])).toEqual([['paper', 'entity', 1], ['person', 'entity', 1], ['wrote', 'relationship', 1]])
    expect(snapshot.ontology!.find((t) => t.type === 'person')).toMatchObject({ label: 'Person', description: 'A human', properties: [{ key: 'born', kind: 'number', description: 'Year of birth' }] })
    expect(snapshot.tags).toEqual([{ tag: 'reviewed', count: 2, color: '#0f0' }, { tag: 'draft', count: 1 }])
  })

  it('an entity with nothing optional reads as its id, no description, empty tags; meta dates sit beside a data key of the same name', () => {
    const { store, registry } = fixture()
    store.upsert(createEntity({ id: 'bare', type: 'note', meta: T }))
    store.upsert(createEntity({ id: 'blank', type: 'note', label: '   ', description: '', meta: T }))
    store.upsert(createEntity({ id: 'clash', type: 'note', label: 'Clash', data: { createdAt: 'from data', updatedAt: 7, label: 'inner', id: 'inner-id' }, meta: T }))
    const { entities } = buildSnapshot(store, registry).snapshot
    expect(entities.find((e) => e.id === 'bare')).toEqual({ id: 'bare', type: 'note', label: 'bare', tags: [], data: {}, ...T })
    const blank = entities.find((e) => e.id === 'blank')!
    expect(blank.label).toBe('blank')
    expect(blank).not.toHaveProperty('description')
    const clash = entities.find((e) => e.id === 'clash')!
    expect(clash.createdAt).toBe(T.createdAt)
    expect(clash.data).toEqual({ createdAt: 'from data', updatedAt: 7, label: 'inner', id: 'inner-id' })
    expect(clash.label).toBe('Clash')
    // Only the two dates are flattened; the source stays out of a script's sight.
    expect(clash).not.toHaveProperty('source')
  })

  it('drops a relationship whose end is missing or is a schema/project entity, keeps a self-loop and parallel ones, and honours the project scope', () => {
    const { store, registry } = fixture()
    store.upsertMany([createEntity({ id: 'a', type: 'note' }), createEntity({ id: 'b', type: 'note' }), createEntity({ id: 'type:note', type: 'schema:type', data: { name: 'note' } })])
    store.upsertMany([
      createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'ab2', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'aa', type: 'r', source: 'a', target: 'a' }),
      createRelationship({ id: 'ax', type: 'r', source: 'a', target: 'nope' }),
      createRelationship({ id: 'at', type: 'r', source: 'a', target: 'type:note' }),
    ])
    const { snapshot } = buildSnapshot(store, registry)
    expect(snapshot.entities.map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(snapshot.relationships.map((r) => r.id).sort()).toEqual(['aa', 'ab', 'ab2'])
    expect(snapshot.relationships.find((r) => r.id === 'aa')).toEqual({ id: 'aa', type: 'r', source: 'a', target: 'a', directed: true, data: {} })
    // A project scope: only its members, and the scope says so.
    store.upsert(createEntity({ id: 'project:p', type: 'project', label: 'P' }))
    store.upsert(createEntity({ id: 'c', type: 'note', meta: { projects: ['project:p'] } }))
    store.setScope('project:p')
    const scoped = buildSnapshot(store, registry)
    expect(scoped.snapshot.scope).toEqual({ label: 'P', projectId: 'project:p' })
    expect(scoped.snapshot.entities.map((e) => e.id)).toEqual(['c'])
    expect(scoped.snapshot.relationships).toEqual([])
    expect(scoped.key).toMatch(/^project:p:\d+:$/)
    store.setScope(null)
    expect(buildSnapshot(store, registry).snapshot.entities.length).toBe(3)
  })

  it('carries unicode ids, turns a Date into text, drops undefined and nulls NaN on the way through JSON; slims strings only six levels deep, the budget catches the rest', () => {
    const { store, registry } = fixture()
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: 'z'.repeat(5000) } } } } } } } }
    store.upsert(createEntity({ id: '🎉/é', type: 'note', label: 'Fête', data: { when: new Date(Date.UTC(2026, 0, 1)), nothing: undefined, nan: NaN, inf: Infinity, nested: { a: [1, { b: null }] }, longer: 'x'.repeat(1001), exact: 'y'.repeat(1000), deep } }))
    const { snapshot } = buildSnapshot(store, registry)
    const e = JSON.parse(JSON.stringify(snapshot)).entities[0]
    expect(e.id).toBe('🎉/é')
    expect(e.data.when).toBe('2026-01-01T00:00:00.000Z')
    expect(e.data).not.toHaveProperty('nothing')
    expect(e.data.nan).toBeNull()
    expect(e.data.inf).toBeNull()
    expect(e.data.nested).toEqual({ a: [1, { b: null }] })
    expect(e.data.exact).toBe('y'.repeat(1000))
    expect(e.data.longer).toBe('x'.repeat(200) + '… [cut: 1,001 chars in all]')
    // Eight levels down the string is not cut, so the whole key goes over budget and is omitted with its size.
    expect(e.data.deep).toMatchObject({ $omitted: true, kind: 'object' })
    expect(e.data.deep.bytes).toBeGreaterThan(5000)
    // The snapshot object itself is untouched where nothing was slimmed: the same data reference.
    const raw = store.get('🎉/é')!
    expect(snapshot.entities[0].data.nested).toBe(raw.data.nested)
    expect(snapshot.entities[0].data.when).toBe(raw.data.when)
  })

  it('over budget, the largest values go first and everything that fits stays; counts beside them survive', () => {
    const { store, registry } = fixture()
    const messages = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, content: `message ${i}` }))
    store.upsert(createEntity({ id: 'conv', type: 'conversation', data: { messages, messageCount: 300, tags: Array.from({ length: 50 }, (_, i) => `t${i}`), title: 'A chat' } }))
    const d = buildSnapshot(store, registry).snapshot.entities[0].data
    expect(d.messages).toMatchObject({ $omitted: true, kind: 'array', items: 300 })
    expect((d.messages as { bytes: number }).bytes).toBe(JSON.stringify(messages).length)
    expect(d.messageCount).toBe(300)
    expect(d.title).toBe('A chat')
    expect(Array.isArray(d.tags)).toBe(true)
    expect(JSON.stringify(d).length).toBeLessThan(4_000 + 200)
    // A single value is never partly kept: one huge string is stubbed (LONG), a huge array is dropped whole (BUDGET).
    store.upsert(createEntity({ id: 'one', type: 'note', data: { body: 'q'.repeat(50_000) } }))
    expect(buildSnapshot(store, registry).snapshot.entities.find((e) => e.id === 'one')!.data.body).toBe('q'.repeat(200) + '… [cut: 50,000 chars in all]')
  })

  it('takes metrics only from a run over this many nodes, dropping NaN cells; the key follows the run', () => {
    const { store, registry } = fixture()
    store.upsertMany([createEntity({ id: 'a', type: 'note' }), createEntity({ id: 'b', type: 'note' })])
    const run = (nodes: number, key: string): LatestAnalysis => ({ report: { computedAt: '', key, scope: 'dataset', nodes, edges: 0, runs: [] } as unknown as LatestAnalysis['report'], metrics: { computedAt: '', sliceKey: '', options: {}, ids: ['a', 'b'], columns: { pagerank: new Float64Array([0.25, NaN]), degree: undefined }, summary: {} } as unknown as LatestAnalysis['metrics'] })
    setLatestAnalysis(run(2, 'k1'))
    const s1 = buildSnapshot(store, registry)
    expect(s1.snapshot.metrics).toEqual({ pagerank: { a: 0.25 } })
    expect(s1.key).toBe(`library:${store.dataVersion}:k1`)
    setLatestAnalysis(run(3, 'k2'))
    const s2 = buildSnapshot(store, registry)
    expect(s2.snapshot).not.toHaveProperty('metrics')
    expect(s2.key).toBe(`library:${store.dataVersion}:k2`)
    expect(getLatestAnalysis()?.report.key).toBe('k2')
  })

  it('the key moves with material writes only, and the provider serialises lazily to the same snapshot', async () => {
    const { store, registry } = fixture()
    store.upsert(createEntity({ id: 'a', type: 'note', label: 'A' }))
    const provider = snapshotProvider(store, registry)
    const k0 = provider().key
    store.get('a')
    store.setScope(null)
    store.setTagInfo('x', { color: '#000' })
    expect(provider().key).toBe(k0)
    store.upsert({ ...store.get('a')!, label: 'A (bookkeeping)' }, { volatile: true })
    expect(provider().key).toBe(k0)
    // A style, a layout, a script — project-category entities a snapshot never holds — leave the key alone.
    store.upsert(createEntity({ id: 'style-1', type: 'rendering', label: 'Style', data: { precedence: 'type' } }))
    store.upsert(createEntity({ id: 'script-1', type: 'script', label: 'S', data: { code: 'return 1' } }))
    store.update('script-1', { type: 'script:style' })
    expect(provider().key).toBe(k0)
    store.upsert({ ...store.get('a')!, label: 'A2' })
    const k1 = provider().key
    expect(k1).not.toBe(k0)
    store.remove('a')
    expect(provider().key).not.toBe(k1)
    store.upsert(createEntity({ id: 'b', type: 'note' }))
    const p = provider()
    const text = await p.json()
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(buildSnapshot(store, registry).snapshot)))
    expect(await p.json()).toBe(text) // built again on demand, the same
  })

  it('five thousand entities with data snapshot within bounds', () => {
    const { store, registry } = fixture()
    const n = 5000
    store.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `e${i}`, type: i % 2 ? 'note' : 'topic', label: `E ${i}`, tags: ['t'], data: { i, text: 'lorem ipsum '.repeat(20), list: [i, i + 1] } })))
    store.upsertMany(Array.from({ length: n - 1 }, (_, i) => createRelationship({ id: `r${i}`, type: 'next', source: `e${i}`, target: `e${i + 1}` })))
    const t = performance.now()
    const { snapshot } = buildSnapshot(store, registry)
    const json = JSON.stringify(snapshot)
    const ms = performance.now() - t
    expect(snapshot.entities.length).toBe(n)
    expect(snapshot.relationships.length).toBe(n - 1)
    expect(ms).toBeLessThan(3000)
    expect(json.length).toBeLessThan(n * 600)
  })

  it('the prelude’s ds helpers answer over the snapshot: byType, in/out/degree with a self-loop and parallels, neighbors, metric, get by unicode id', async () => {
    const { store, registry } = fixture()
    store.upsertMany([createEntity({ id: 'a', type: 'note' }), createEntity({ id: 'b', type: 'note' }), createEntity({ id: 'ç', type: 'topic', tags: ['x'] })])
    store.upsertMany([
      createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'ab2', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'aa', type: 's', source: 'a', target: 'a' }),
      createRelationship({ id: 'ca', type: 'r', source: 'ç', target: 'a' }),
    ])
    setLatestAnalysis({ report: { computedAt: '', key: 'k', scope: 'dataset', nodes: 3, edges: 4, runs: [] } as unknown as LatestAnalysis['report'], metrics: { computedAt: '', sliceKey: '', options: {}, ids: ['a', 'b', 'ç'], columns: { pagerank: new Float64Array([0.5, 0.3, 0.2]) }, summary: {} } as unknown as LatestAnalysis['metrics'] })
    const { snapshot } = buildSnapshot(store, registry)
    const sb = new Sandbox()
    await sb.load('k', JSON.stringify(snapshot))
    const r = await sb.run(`
      return {
        types: ds.types().sort(), notes: ds.byType('note').length.toString() + '/' + ds.byType('note', 'topic', 'nope').length,
        outA: ds.out('a').map((r) => r.id), inA: ds.in('a').map((r) => r.id), degA: ds.degree('a'), degAr: ds.degree('a', 'r'),
        nbA: ds.neighbors('a').map((e) => e.id), nbB: ds.neighbors('b', 'r').map((e) => e.id),
        pr: ds.metric('pagerank', 'ç'), none: ds.metric('nope', 'a'), got: ds.get('ç').tags, tagged: ds.tagged('x').length, count: ds.count(), missing: ds.get('zz'), scope: ds.scope.label,
      }`)
    if (r.error) throw new Error(r.error.message)
    // A self-loop is an out and an in: it counts twice in the degree and lists the node among its own neighbours twice.
    // `undefined` comes back from the sandbox as null: the result crosses as JSON.
    expect(r.value).toEqual({ types: ['note', 'topic'], notes: '2/3', outA: ['ab', 'ab2', 'aa'], inA: ['aa', 'ca'], degA: 5, degAr: 3, nbA: ['b', 'b', 'a', 'a', 'ç'], nbB: ['a', 'a'], pr: 0.2, none: null, got: ['x'], tagged: 1, count: 3, missing: null, scope: 'Library' })
  })

  it('narrowed to types, the snapshot holds those and their subtypes, the relationships between them, and says so', () => {
    // What a project of hundreds of thousands of entities needs if a script is to run over it at all: the genera
    // of a city's trees without its trees.
    const { store } = fixture()
    store.upsert(schemaTypeEntity('tree', { label: 'Tree', parent: 'location' }))
    store.upsert(schemaTypeEntity('maple', { label: 'Maple', parent: 'tree' }))
    store.upsert(schemaTypeEntity('genus', { label: 'Genus' }))
    store.upsertMany([
      createEntity({ id: 't1', type: 'tree', label: 'A tree' }),
      createEntity({ id: 't2', type: 'maple', label: 'A maple' }),
      createEntity({ id: 'g1', type: 'genus', label: 'Acer' }),
      createEntity({ id: 'w1', type: 'ward', label: 'Ward 1' }),
      createRelationship({ id: 'r1', type: 'of-genus', source: 't1', target: 'g1' }),
      createRelationship({ id: 'r2', type: 'in-ward', source: 't1', target: 'w1' }),
    ])
    // The registry reads the types the store holds, so it is made after them.
    const registry = new TypeRegistry(store)
    const whole = buildSnapshot(store, registry)
    expect(whole.snapshot.entities.map((e) => e.id).sort()).toEqual(['g1', 't1', 't2', 'w1'])
    const narrow = buildSnapshot(store, registry, ['tree', 'genus'])
    // A subtype comes with its parent; a type left out is gone, and so is the relationship that reached it.
    expect(narrow.snapshot.entities.map((e) => e.id).sort()).toEqual(['g1', 't1', 't2'])
    expect(narrow.snapshot.relationships.map((r) => r.id)).toEqual(['r1'])
    expect(narrow.snapshot.scope).toEqual({ label: 'Library', types: ['genus', 'tree'] })
    // The key says what it is: the same dataset read two ways is two snapshots, and the order asked in does not matter.
    expect(narrow.key).not.toBe(whole.key)
    expect(buildSnapshot(store, registry, ['genus', 'tree']).key).toBe(narrow.key)
    // A type nothing matches is an empty dataset, not the whole project.
    expect(buildSnapshot(store, registry, ['nope']).snapshot.entities).toEqual([])
  })
})

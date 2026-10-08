import { describe, expect, it } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createMoreTools } from '../moreTools'
import type { AppHost } from '../tools'

function setup() {
  const store = new EntityStore()
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createMoreTools(host)
  const run = (name: string) => {
    const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
    if (!t) throw new Error(`no tool ${name}`)
    return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  }
  return { store, navigated, run }
}

describe('library tools', () => {
  it('inspect opens the entity in its table on a tab', async () => {
    const { store, navigated, run } = setup()
    const page = createEntity({ id: 'w1', type: 'webpage', label: 'W3C', data: { url: 'https://www.w3.org/' } })
    const person = createEntity({ id: 'p1', type: 'person', label: 'Ada' })
    store.upsertMany([page, person])
    await run('inspect')({ id: 'w1', tab: 'annotations' })
    await run('inspect')({ id: 'p1' })
    expect(navigated).toEqual(['/entities?category=resource&type=webpage&sel=w1&tab=annotations', '/entities?category=knowledge&type=person&sel=p1'])
  })

  it('annotates a webpage with a plain note without capturing', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: 'w1', type: 'webpage', label: 'W3C', data: { url: 'https://www.w3.org/' } }))
    const r = await run('annotate_webpage')({ id: 'w1', comment: 'home page', tags: 'ref' })
    const a = store.get(r.id)!
    expect(a.type).toBe('annotation')
    expect(a.tags).toEqual(['ref'])
    expect(store.relationshipsOf('w1').length).toBe(1)
    expect(r.selector).toBeUndefined()
  })

  it('creates, rewrites, converts, and exports diagrams', async () => {
    const { store, run } = setup()
    const c = await run('create_diagram')({ label: 'Flow', source: 'digraph { a -> b [label="knows"]; b -> c }' })
    expect(c.format).toBe('dot')
    expect(c.nodes).toBe(3)
    const conv = await run('write_diagram')({ id: c.id, convert_to: 'mermaid' })
    expect(conv.format).toBe('mermaid')
    expect(String(store.get(c.id)!.data.source)).toMatch(/flowchart|graph/)
    const dry = await run('diagram_to_dataset')({ id: c.id, dry_run: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.entities).toBe(3)
    const before = store.size()
    const done = await run('diagram_to_dataset')({ id: c.id })
    expect(done.entities).toBe(3)
    expect(store.size()).toBeGreaterThan(before)
    expect(store.get(c.id)!.data.lastImport).toBeTruthy()
  })

  it('defines types and updates tags', async () => {
    const { store, run } = setup()
    const t = await run('define_entity_type')({ name: 'architect', parent: 'person', color: '#123456' })
    expect(t.label).toBe('Architect')
    expect(t.category).toBe('knowledge')
    expect(store.get('type:architect')).toBeTruthy()
    store.upsert(createEntity({ id: 'n1', type: 'note', label: 'n', tags: ['todo'] }))
    const u = await run('update_tag')({ tag: 'todo', rename_to: 'later', color: '#abcdef' })
    expect(u.tag).toBe('later')
    expect(store.get('n1')!.tags).toEqual(['later'])
    expect(u.color).toBe('#abcdef')
  })

  it('define_entity_type edits a type as its editor does: plural, required, a rename that moves values, a kind that converts them', async () => {
    const { store, run } = setup()
    await run('define_entity_type')({ name: 'city', plural_label: 'Cities', properties: [{ key: 'pop', kind: 'text', required: true }, { key: 'nick' }] })
    store.upsertMany([createEntity({ id: 'c1', type: 'city', label: 'Oslo', data: { pop: '709000' } }), createEntity({ id: 'c2', type: 'city', label: 'Nowhere', data: { pop: 'unknown' } })])
    const t = await run('define_entity_type')({ name: 'city', rename_properties: [{ from: 'pop', to: 'population' }], properties: [{ key: 'population', kind: 'number' }], remove_properties: ['nick'] })
    expect(t.plural_label).toBe('Cities')
    expect(t.properties).toEqual([{ key: 'population', kind: 'number', required: true }])
    expect(t.changed).toEqual({ renamed: [{ from: 'pop', to: 'population', values: 2 }], converted: [{ key: 'population', kind: 'number', values: 1, kept: 1 }] })
    expect(store.get('c1')!.data).toEqual({ population: 709000 })
    expect(store.get('c2')!.data).toEqual({ population: 'unknown' })
    await expect(run('define_entity_type')({ name: 'city', rename_properties: [{ from: 'nope', to: 'x' }] })).rejects.toThrow(/no property nope/)
    // A loop is refused, not written.
    await run('define_entity_type')({ name: 'town', parent: 'city' })
    await expect(run('define_entity_type')({ name: 'city', parent: 'town' })).rejects.toThrow(/loop/)
  })

  it('table_layout lays out a type and a map, and reads back what is in force', async () => {
    const { store, run } = setup()
    const t = await run('table_layout')({ type: 'location', columns: ['data.at', 'data.until'], sort: { key: 'data.at' } })
    expect(t.table).toEqual({ columns: ['data.at', 'data.until'], sort: { key: 'data.at', dir: 'asc' } })
    expect(t.columns.slice(0, 3).map((c: { key: string }) => c.key)).toEqual(['label', 'data.at', 'data.until'])
    await run('define_entity_type')({ name: 'sight', parent: 'location' })
    const sub = await run('table_layout')({ type: 'sight' })
    expect(sub.own).toBeNull()
    expect(sub.table?.sort).toEqual({ key: 'data.at', dir: 'asc' })
    // Adding hidden keeps the columns and sort already set.
    const more = await run('table_layout')({ type: 'location', hidden: ['meta.createdAt'] })
    expect(more.table).toEqual({ columns: ['data.at', 'data.until'], sort: { key: 'data.at', dir: 'asc' }, hidden: ['meta.createdAt'] })
    const cleared = await run('table_layout')({ type: 'location', clear: true })
    expect(cleared.table).toBeNull()
    store.upsert(createEntity({ id: 'm1', type: 'map', label: 'Trip', data: { center: { lat: 0, lng: 0 }, zoom: 3, layer: 'streets' } }))
    const m = await run('table_layout')({ map_id: 'm1', types: ['location', 'path'], sort: { key: 'data.at', dir: 'asc' } })
    expect(m.table).toEqual({ types: ['location', 'path'], sort: { key: 'data.at', dir: 'asc' } })
    expect((store.get('m1')!.data as { table: unknown }).table).toEqual(m.table)
    await expect(run('table_layout')({})).rejects.toThrow(/type name or a map_id/)
  })
})

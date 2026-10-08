import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { PROJECT_UI_KEYS, restoreActiveProject, switchProject } from '../active'
import { packDocument, unpackDocument } from '../../exchange/pack/pack'
import { buildBundle, importBundle, projectClosure } from '../bundle'
import { createProject, deleteProject, forkProject, listProjects, projectCounts, scopeCounts, wouldCycle } from '../project'

const make = () => {
  const store = new EntityStore()
  const a = createEntity({ id: 'a', type: 'note', label: 'A', tags: ['x'] })
  const b = createEntity({ id: 'b', type: 'note', label: 'B', tags: ['y'] })
  const c = createEntity({ id: 'c', type: 'person', label: 'C' })
  const ab = createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' })
  const bc = createRelationship({ id: 'bc', type: 'related', source: 'b', target: 'c' })
  const typeDef = createEntity({ id: 'type:person', type: 'schema:type', label: 'Person', data: { name: 'person', category: 'knowledge' } })
  store.upsertMany([a, b, c, ab, bc, typeDef])
  const p = createProject({ id: 'p1', label: 'One' })
  store.upsert(p)
  return { store, p }
}

beforeEach(() => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
})

describe('project section tabs', () => {
  it('restores each project’s Unigraph session instead of sharing its filters with another project', () => {
    const { store, p } = make()
    const other = createProject({ id: 'p2', label: 'Two' })
    store.upsert(other)
    switchProject(store, p.id)
    const first = JSON.stringify({ ws: { session: 'first' } })
    const second = JSON.stringify({ ws: { session: 'second' } })
    localStorage.setItem('aegraph:unigraph:v1', first)
    switchProject(store, other.id)
    expect(localStorage.getItem('aegraph:unigraph:v1')).toBeNull()
    localStorage.setItem('aegraph:unigraph:v1', second)
    switchProject(store, p.id)
    expect(localStorage.getItem('aegraph:unigraph:v1')).toBe(first)
    switchProject(store, other.id)
    expect(localStorage.getItem('aegraph:unigraph:v1')).toBe(second)
  })

  it('includes every page’s pane host in project state', async () => {
    const { HOSTS } = await import('../../../features/workstation/hosts')
    for (const host of Object.values(HOSTS)) expect(PROJECT_UI_KEYS).toContain(host.key)
  })
})

describe('project marks and scope', () => {
  it('marks entities and the relationships among them', () => {
    const { store, p } = make()
    expect(store.mark(['a', 'b'], p.id)).toBe(3)
    expect([...store.markedWith(p.id)].sort()).toEqual(['a', 'ab', 'b'])
    expect(store.projectsOf('a')).toEqual([p.id])
    // c and bc stay out: bc reaches outside the project.
    expect(store.projectsOf('bc')).toEqual([])
  })

  it('scopes list reads but not lookups by id', () => {
    const { store, p } = make()
    store.mark(['a', 'b'], p.id)
    store.setScope(p.id)
    expect(store.all().map((e) => e.id).sort()).toEqual(['a', 'ab', 'b', 'type:person'])
    expect(store.ofType('person')).toEqual([])
    expect(store.get('c')?.id).toBe('c')
    expect(store.entityCount()).toBe(3)
    expect(store.relationshipCount()).toBe(1)
    expect(store.relationshipsOf('b').map((r) => r.id)).toEqual(['ab'])
    expect(store.tags()).toEqual(['x', 'y'])
    expect(store.query({ text: 'c' }).map((e) => e.id)).not.toContain('c')
    expect(store.library.entityCount()).toBe(5)
    store.setScope(null)
    expect(store.ofType('person').length).toBe(1)
  })

  it('shows a project the type definitions it holds, uses, or that belong to no project — not those of another project', () => {
    const { store, p } = make()
    const demo = createProject({ id: 'demo', label: 'Demo' })
    store.upsert(demo)
    // A demo's vocabulary, marked with the demo (as a bundle import does), tagged like the rest of it.
    const incident = createEntity({ id: 'type:incident', type: 'schema:type', label: 'Incident', tags: ['demo'], data: { name: 'incident', category: 'knowledge' }, meta: { projects: ['demo'] } })
    const alert = createEntity({ id: 'type:alert', type: 'schema:type', label: 'Alert', tags: ['demo'], data: { name: 'alert', category: 'knowledge' }, meta: { projects: ['demo'] } })
    store.upsertMany([incident, alert])
    store.mark(['a'], p.id)
    store.setScope(p.id)
    // Fresh project: its own entity, the Library-wide definition (type:person is in no project) — no demo types, no demo tag.
    expect(store.all().map((e) => e.id).sort()).toEqual(['a', 'type:person'])
    expect(store.tags()).toEqual(['x'])
    // Using a demo type brings its definition along; the other stays out.
    store.upsert(createEntity({ id: 'i1', type: 'incident', label: 'Outage' }))
    expect(store.ofType('schema:type').map((e) => e.id).sort()).toEqual(['type:incident', 'type:person'])
    // A definition made inside the project is the project's.
    store.upsert(createEntity({ id: 'type:task', type: 'schema:type', label: 'Task', data: { name: 'task', category: 'knowledge' } }))
    expect(store.projectsOf('type:task')).toEqual([p.id])
    expect(store.ofType('schema:type').map((e) => e.id).sort()).toEqual(['type:incident', 'type:person', 'type:task'])
    store.setScope('demo')
    expect(store.ofType('schema:type').map((e) => e.id).sort()).toEqual(['type:alert', 'type:incident', 'type:person'])
  })

  it('marks what is created while a project is active, but never projects themselves', () => {
    const { store, p } = make()
    store.setScope(p.id)
    store.upsert(createEntity({ id: 'd', type: 'note' }))
    expect(store.projectsOf('d')).toEqual([p.id])
    const p2 = createProject({ id: 'p2', label: 'Two' })
    store.upsert(p2)
    expect(store.projectsOf('p2')).toEqual([])
    expect(listProjects(store).map((x) => x.id).sort()).toEqual(['p1', 'p2'])
  })

  it('keeps marks through writes that do not mention them, and unmarks explicitly', () => {
    const { store, p } = make()
    store.mark(['a'], p.id)
    store.update('a', { label: 'A2' })
    expect(store.projectsOf('a')).toEqual([p.id])
    store.upsert({ ...store.get('a')!, meta: { ...store.get('a')!.meta, projects: undefined } })
    expect(store.projectsOf('a')).toEqual([p.id])
    store.unmark(['a'], p.id)
    expect(store.projectsOf('a')).toEqual([])
    expect(store.markedWith(p.id).size).toBe(0)
  })

  it('includes other projects transitively and rejects cycles', () => {
    const { store, p } = make()
    const p2 = createProject({ id: 'p2', label: 'Two', includes: [p.id] })
    store.upsert(p2)
    store.mark(['a'], p.id)
    store.mark(['c'], p2.id)
    expect([...store.scopeOf('p2')].sort()).toEqual(['a', 'c'])
    expect(projectCounts(store, 'p2').entities).toBe(2)
    expect(wouldCycle(store, p.id, 'p2')).toBe(true)
    expect(wouldCycle(store, 'p2', p.id)).toBe(false)
  })

  it('deletes a project without its entities, or with the exclusive ones', () => {
    const { store, p } = make()
    const p2 = createProject({ id: 'p2', label: 'Two' })
    store.upsert(p2)
    store.mark(['a', 'b'], p.id)
    store.mark(['b'], p2.id)
    expect(deleteProject(store, p.id, { exclusive: true })).toEqual({ unmarked: 1, deleted: 2 })
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(true)
    expect(store.projectsOf('b')).toEqual(['p2'])
    expect(store.has('p1')).toBe(false)
  })
})

describe('switching', () => {
  it('swaps the UI state and remembers the active project', () => {
    const { store, p } = make()
    localStorage.setItem('aegraph:workstation:v1', 'library-ws')
    expect(switchProject(store, p.id)).toBe(true)
    expect(store.scope).toBe(p.id)
    expect(localStorage.getItem('aegraph:workstation:v1')).toBeNull()
    localStorage.setItem('aegraph:workstation:v1', 'project-ws')
    switchProject(store, null)
    expect(localStorage.getItem('aegraph:workstation:v1')).toBe('library-ws')
    switchProject(store, p.id)
    expect(localStorage.getItem('aegraph:workstation:v1')).toBe('project-ws')
    expect(switchProject(store, 'nope')).toBe(false)
    const again = new EntityStore()
    again.upsert(p)
    restoreActiveProject(again)
    expect(again.scope).toBe(p.id)
  })
})

describe('bundles', () => {
  it('exports the closure and re-imports it as the same project', () => {
    const { store, p } = make()
    store.mark(['a', 'b'], p.id)
    const scene = createEntity({ id: 'scene', type: 'scene', data: { layoutId: 'layout' }, meta: { projects: [p.id] } })
    const layout = createEntity({ id: 'layout', type: 'layout', data: { positions: {} } })
    store.upsertMany([scene, layout])
    switchProject(store, p.id)
    localStorage.setItem('aegraph:workstation:v1', 'ws')
    const doc = buildBundle(store, p.id, { route: '/workstation' })
    const ids = doc.entities.map((e) => e.id).sort()
    // a, b, ab, the scene and the layout it references, the project; not c/bc.
    expect(ids).toEqual(['a', 'ab', 'b', 'layout', 'p1', 'scene'])
    expect(doc.project).toBe('p1')
    expect(doc.state?.ui?.['aegraph:workstation:v1']).toBe('ws')
    expect(doc.entities.find((e) => e.id === 'p1')?.data.summary).toMatchObject({ entities: 3 })

    const other = new EntityStore()
    const report = importBundle(other, JSON.parse(JSON.stringify(doc)))
    expect(report.project.id).toBe('p1')
    expect(report.created).toBe(6)
    expect(report.route).toBe('/workstation')
    expect([...other.scopeOf('p1')].sort()).toEqual(['a', 'ab', 'b', 'layout', 'scene'])
    // Importing again changes nothing.
    const again = importBundle(other, JSON.parse(JSON.stringify(doc)))
    expect(again.upToDate).toBe(5)
    expect(again.created).toBe(0)
  })

  it('follows references by their keys, never a string in content that happens to be an id — and counts what it reaches outside', () => {
    const { store, p } = make()
    store.mark(['a'], p.id)
    // Entities of another, private project: a conversation, a slide deck and its parts, a diagram.
    const secret = createEntity({ id: 'private-conversation', type: 'conversation', label: 'Private', data: { messages: [] }, meta: { projects: ['other'] } })
    const deck = createEntity({ id: 'deck-1', type: 'deck', data: {}, meta: { projects: ['other'] } })
    const compose = createEntity({ id: 'compose-1', type: 'block', data: { children: ['block-2'], items: [{ ref: 'item-ref', label: 'private-conversation', value: 'private-conversation' }] }, meta: { projects: ['other'] } })
    const block2 = createEntity({ id: 'block-2', type: 'block', data: {} })
    const itemRef = createEntity({ id: 'item-ref', type: 'note', data: {} })
    const diagram = createEntity({ id: 'diagram-1', type: 'diagram', data: {} })
    const filter = createEntity({ id: 'filter-1', type: 'filter', data: {} })
    store.upsertMany([secret, deck, compose, block2, itemRef, diagram, filter])
    // In the project: a dataset whose cells, a note's property and a description name the conversation's id, and
    // presentation entities that reference by key.
    const dataset = createEntity({ id: 'ds', type: 'dataset', data: { columns: [{ key: 'id' }], rows: [['private-conversation'], [{ id: 'private-conversation' }]], text: 'private-conversation', note: 'private-conversation', nested: { deep: 'private-conversation' } }, meta: { projects: [p.id] } })
    const slide = createEntity({ id: 'slide', type: 'slide', data: { deck: 'deck-1', compose: 'compose-1' }, meta: { projects: [p.id] } })
    const projection = createEntity({ id: 'proj', type: 'projection', data: { source: { diagramId: 'diagram-1', format: 'dot' } }, meta: { projects: [p.id] } })
    const scene = createEntity({ id: 'sc', type: 'scene', data: { filterId: 'filter-1' }, meta: { projects: [p.id] } })
    store.upsertMany([dataset, slide, projection, scene])
    const { entities, outside } = projectClosure(store, p.id)
    const ids = entities.map((e) => e.id)
    expect(ids).not.toContain('private-conversation')
    for (const id of ['deck-1', 'compose-1', 'block-2', 'item-ref', 'diagram-1', 'filter-1']) expect(ids, id).toContain(id)
    expect(outside).toBe(6)
  })

  it('carries the assistant’s chats and memory in a saved bundle, and leaves them out when asked', () => {
    const { store, p } = make()
    store.mark(['a'], p.id)
    const chat = createEntity({ id: 'assistant-chat:1', type: 'conversation', tags: ['assistant:chat'], data: {}, meta: { source: 'assistant', projects: [p.id] } })
    const memory = createEntity({ id: 'mem', type: 'document', tags: ['assistant:memory'], data: {}, meta: { source: 'assistant', projects: [p.id] } })
    const imported = createEntity({ id: 'chatgpt-1', type: 'conversation', data: {}, meta: { source: 'import', projects: [p.id] } })
    store.upsertMany([chat, memory, imported])
    expect(projectClosure(store, p.id).entities.map((e) => e.id)).toEqual(expect.arrayContaining(['assistant-chat:1', 'mem', 'chatgpt-1']))
    const without = projectClosure(store, p.id, { assistant: false }).entities.map((e) => e.id)
    expect(without).not.toContain('assistant-chat:1')
    expect(without).not.toContain('mem')
    expect(without).toContain('chatgpt-1')
  })

  it('takes a pack’s entities as they are — no copy for what the bundle already marks, its own project the only mark — and reads the same as the normalising path', () => {
    const { store, p } = make()
    store.mark(['a', 'b'], p.id)
    const doc = buildBundle(store, p.id)
    // The pack round trip hands back entities in the app's shape, some marked with the project, one marked elsewhere, one unmarked.
    const packed = unpackDocument(packDocument(doc))
    const stranger = createEntity({ id: 'q', type: 'note', label: 'Q', meta: { projects: ['other'] } })
    const loose = createEntity({ id: 'l', type: 'note', label: 'L' })
    const entities = [...packed.entities, stranger, loose]
    const fast = new EntityStore()
    const r1 = importBundle(fast, { entities, tags: packed.tags, project: packed.project }, { normalized: true })
    const slow = new EntityStore()
    const r2 = importBundle(slow, JSON.parse(JSON.stringify({ entities, tags: packed.tags, project: packed.project })))
    expect(r1.created).toBe(r2.created)
    expect(r1.created).toBe(entities.length)
    const marks = (s: EntityStore) => s.library.all().map((e) => [e.id, e.meta.projects ?? []] as const).sort()
    expect(marks(fast)).toEqual(marks(slow))
    // A file marks into its own project only: the mark for `other` is dropped.
    expect(fast.projectsOf('q')).toEqual(['p1'])
    expect(fast.projectsOf('l')).toEqual(['p1'])
    expect(fast.projectsOf('p1')).toEqual([])
    // Already marked with the project: the very object from the pack is what the store holds.
    const a = entities.find((e) => e.id === 'a')!
    expect(fast.get('a')).toBe(a)
    expect(fast.get('q')).not.toBe(stranger)
    // A second import of the same file: everything up to date, nothing rewritten.
    const again = importBundle(fast, { entities, tags: packed.tags, project: packed.project }, { normalized: true })
    expect(again.upToDate).toBe(entities.length - 1)
    expect(again.created).toBe(0)
  })

  it('makes a project out of a plain document', () => {
    const store = new EntityStore()
    const report = importBundle(store, { entities: [{ id: 'x', type: 'note', label: 'X' }] }, { name: 'From file' })
    expect(report.project.label).toBe('From file')
    expect(store.projectsOf('x')).toEqual([report.project.id])
  })
})

describe('scoped counts', () => {
  it('counts types only inside the scope', () => {
    const { store, p } = make()
    store.mark(['a'], p.id)
    store.setScope(p.id)
    const { entities, relationships } = store.countByTypeAndKind()
    expect(entities.get('note')).toBe(1)
    expect(entities.get('person')).toBeUndefined()
    expect(relationships.size).toBe(0)
    expect(store.countByType().get('note')).toBe(1)
  })
})

describe('reloading', () => {
  it('does not mark what a reload puts back while a project is open', () => {
    const { store, p } = make()
    store.setScope(p.id)
    const everything = store.library.all()
    store.transaction(() => {
      store.clear()
      store.upsertMany(everything)
    })
    expect(store.scope).toBeNull()
    expect(store.projectsOf('c')).toEqual([])
    restoreActiveProject(store)
  })
})

describe('Library-wide writes under a scope', () => {
  it('deleting cascades to relationships outside the project, and tags rename everywhere', () => {
    const { store, p } = make()
    store.mark(['b'], p.id)
    store.setScope(p.id)
    store.remove('b')
    expect(store.library.all().some((e) => e.id === 'ab' || e.id === 'bc')).toBe(false)
    store.renameTag('x', 'z')
    expect(store.get('a')?.tags).toEqual(['z'])
    store.deleteTag('z')
    expect(store.get('a')?.tags).toEqual([])
  })
})

describe('store.library', () => {
  it('reads everything while a project is open, without disturbing the scoped caches', () => {
    const { store, p } = make()
    store.mark(['a'], p.id)
    store.setScope(p.id)
    expect(store.all().map((e) => e.id).sort()).toEqual(['a', 'type:person'])
    expect(store.library.all().length).toBe(7)
    expect(store.all().map((e) => e.id).sort()).toEqual(['a', 'type:person'])
    expect(store.library.ofType('person').length).toBe(1)
    expect(store.ofType('person').length).toBe(0)
    expect(store.library.tags()).toEqual(['x', 'y'])
    expect(store.tags()).toEqual(['x'])
    expect(store.library.relationshipsOf('b').length).toBe(2)
    expect(store.relationshipsOf('b').length).toBe(0)
    expect(store.library.countByTypeAndKind().entities.get('note')).toBe(2)
    expect(store.countByTypeAndKind().entities.get('note')).toBe(1)
  })
})

describe('save as new project', () => {
  it('forks a project: same members by reference, same includes and home, its own identity', () => {
    const { store, p } = make()
    store.mark(['a', 'b'], p.id)
    const inc = createProject({ id: 'p0', label: 'Base' })
    store.upsert(inc)
    store.mark(['c'], inc.id)
    store.update(p.id, { data: { ...p.data, includes: ['p0'], home: { route: '/workstation' } } })
    const r = forkProject(store, p.id, { label: 'One copy' })
    // a, ab, b — and bc, which now joins b to c in the included project.
    expect(r.marked).toBe(4)
    expect(r.project.label).toBe('One copy')
    expect(r.project.data.includes).toEqual(['p0'])
    expect(r.project.data.home).toEqual({ route: '/workstation' })
    expect(r.project.data.source).toBe(`fork:${p.id}`)
    expect(store.projectsOf('a').sort()).toEqual([p.id, r.project.id].sort())
    expect(store.projectsOf('ab')).toContain(r.project.id)
    expect([...store.scopeOf(r.project.id)].sort()).toEqual(['a', 'ab', 'b', 'bc', 'c'])
    expect(store.projectsOf(r.project.id)).toEqual([])
    // Editing one member is seen from both — one entity, two marks.
    store.update('a', { label: 'A2' })
    store.setScope(r.project.id)
    expect(store.get('a')?.label).toBe('A2')
    expect(listProjects(store).map((x) => x.label).sort()).toEqual(['Base', 'One', 'One copy'])
  })

  it('saves the Library as a project, leaving projects and type definitions out', () => {
    const { store, p } = make()
    const r = forkProject(store, null, { label: 'Snapshot' })
    expect(r.marked).toBe(5)
    expect([...store.markedWith(r.project.id)].sort()).toEqual(['a', 'ab', 'b', 'bc', 'c'])
    expect(store.projectsOf(p.id)).toEqual([])
    expect(store.projectsOf('type:person')).toEqual([])
    expect(r.project.data.source).toBe('fork:library')
  })

  it('reviews a scope: counts by type and kind, and tags', () => {
    const { store, p } = make()
    store.mark(['a', 'b'], p.id)
    expect(scopeCounts(store, p.id)).toEqual({ entities: 2, relationships: 1, byType: { note: 2 }, byRelationshipType: { references: 1 }, tags: [['x', 1], ['y', 1]] })
    const lib = scopeCounts(store, null)
    expect(lib.entities).toBe(3)
    expect(lib.relationships).toBe(2)
    expect(lib.byType).toEqual({ note: 2, person: 1 })
    expect(projectCounts(store, p.id).entities).toBe(2)
  })
})

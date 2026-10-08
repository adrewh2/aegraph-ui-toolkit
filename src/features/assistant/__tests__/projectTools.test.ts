import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { isProjectEntity, listProjects } from '../../../core/projects/project'
import { createAppTools, type AppHost } from '../tools'

/**
 * The project membership tools over the fake host: open, add, remove,
 * update, delete (with the confirmation answered both ways), template and
 * publish. What they write — marks, project data, template entities — is
 * checked on the store, not just in the replies.
 */

function host(store: EntityStore, answer = true): AppHost & { navigated: string[]; confirmations: string[] } {
  const navigated: string[] = []
  const confirmations: string[] = []
  return { store, navigated, confirmations, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/entities' }), confirm: async (m) => (confirmations.push(m), answer) }
}

const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => {
    const r = await t.run(t.parse(input))
    return typeof r === 'string' ? r : JSON.stringify(r)
  }
}
const parse = async (p: Promise<string>) => JSON.parse(await p)

function seed(store: EntityStore) {
  store.upsertMany([
    createEntity({ id: 'a', type: 'note', label: 'Alpha', tags: ['keep'] }),
    createEntity({ id: 'b', type: 'note', label: 'Beta' }),
    createEntity({ id: 'c', type: 'person', label: 'Cy', tags: ['keep'] }),
    createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' }),
    createRelationship({ id: 'ac', type: 'knows', source: 'a', target: 'c' }),
  ])
}

describe('project tools', () => {
  let mem: Record<string, string>
  beforeEach(() => {
    mem = {}
    const fake = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]), key: () => null, length: 0 }
    vi.stubGlobal('localStorage', fake)
    vi.stubGlobal('sessionStorage', { ...fake })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists the user’s projects apart from the demos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ demos: [{ id: 'bahamas-tour', title: 'Bahamas', description: '', bundleUrl: '/demos/bahamas-tour/bundle.ae.json.gz' }] }))))
    const store = new EntityStore()
    const tools = createAppTools(host(store))
    const mine = await parse(tool(tools, 'project_create')({ label: 'Thesis', open: false }))
    store.upsertMany([
      { ...createEntity({ id: 'project:trees', type: 'project', label: 'Trees' }), data: { demo: '/demos/trees/bundle.aeb' } },
      createEntity({ id: 'aurora', type: 'project', label: 'Aurora', data: { source: 'demo:aurora' } }),
      // Opened before the mark was written: known by the demo id in its project id.
      createEntity({ id: 'project:bahamas-tour', type: 'project', label: 'Bahamas', data: { source: 'import:bahamas-tour' } }),
    ])
    const listed = await parse(tool(tools, 'project_list')({}))
    const demo = Object.fromEntries((listed.projects as { id: string; demo: boolean }[]).map((p) => [p.id, p.demo]))
    expect(demo).toEqual({ [mine.created.id]: false, 'project:trees': true, aurora: true, 'project:bahamas-tour': true })
  })

  it('opens a project, adds by id and by query, updates it, removes, and goes back to the Library', async () => {
    const store = new EntityStore()
    seed(store)
    const h = host(store)
    const tools = createAppTools(h)
    const created = await parse(tool(tools, 'project_create')({ label: 'Thesis', open: false }))
    const pid = created.created.id as string
    expect(store.scope).toBeNull()

    const opened = await parse(tool(tools, 'project_open')({ id: pid, route: '/workstation' }))
    expect(opened).toMatchObject({ active: pid, label: 'Thesis', route: '/workstation' })
    expect(store.scope).toBe(pid)
    await expect(tool(tools, 'project_open')({ id: 'nope' })).rejects.toThrow()

    // By id: the entity and, once both ends are members, the relationship between them.
    const one = await parse(tool(tools, 'project_add')({ ids: ['a'] }))
    expect(one).toMatchObject({ project: pid, requested: 1, added: 1, entities: 1, relationships: 0 })
    const two = await parse(tool(tools, 'project_add')({ ids: ['b'] }))
    expect(two).toMatchObject({ entities: 2, relationships: 1 })
    expect(store.projectsOf('ab')).toEqual([pid])
    // By query over the Library (the tag reaches c, which is outside the project so far), while another project is open.
    const byTag = await parse(tool(tools, 'project_add')({ query: { tags: ['keep'] } }))
    expect(byTag.requested).toBe(2)
    // c, and the relationship a–c that now has both ends inside.
    expect(byTag.added).toBe(2)
    expect(byTag).toMatchObject({ entities: 3, relationships: 2 })
    // The same entity can be in two projects; adding again is a no-op.
    expect((await parse(tool(tools, 'project_add')({ ids: ['a'] }))).added).toBe(0)

    const updated = await parse(tool(tools, 'project_update')({ label: 'Thesis 2', description: 'the second draft', home_route: '/graph/2d' }))
    expect(updated.updated).toMatchObject({ id: pid, label: 'Thesis 2', description: 'the second draft', home: { route: '/graph/2d' }, entities: 3 })
    expect(store.get(pid)!.label).toBe('Thesis 2')
    // Includes are checked: a project cannot include itself or an unknown one.
    await expect(tool(tools, 'project_update')({ includes: [pid] })).rejects.toThrow(/cycle/)
    await expect(tool(tools, 'project_update')({ includes: ['nope'] })).rejects.toThrow()
    const other = await parse(tool(tools, 'project_create')({ label: 'Reading group', open: false }))
    const inc = await parse(tool(tools, 'project_update')({ includes: [other.created.id] }))
    expect(inc.updated.includes).toEqual([other.created.id])
    await expect(tool(tools, 'project_update')({ id: other.created.id, includes: [pid] })).rejects.toThrow(/cycle/)

    // Remove by query over the project: the person goes, the notes stay; the Library keeps everything.
    const removed = await parse(tool(tools, 'project_remove')({ query: { type: 'person' } }))
    expect(removed).toMatchObject({ project: pid, removed: 1, entities: 2 })
    expect(store.get('c')).toBeDefined()
    expect(store.projectsOf('c')).toEqual([])
    expect((await parse(tool(tools, 'project_remove')({ ids: ['zzz'] }))).removed).toBe(0)

    const back = await parse(tool(tools, 'project_open')({}))
    expect(back).toMatchObject({ active: null, label: 'Library' })
    expect(store.scope).toBeNull()
    // With nothing open and no id, membership tools say so.
    await expect(tool(tools, 'project_add')({ ids: ['a'] })).rejects.toThrow(/No project is open/)
    const named = await parse(tool(tools, 'project_remove')({ project: pid, ids: ['b'] }))
    expect(named).toMatchObject({ removed: 1, entities: 1 })
  })

  it('deletes a project only when the user confirms, keeping or dropping its exclusive entities as asked', async () => {
    const store = new EntityStore()
    seed(store)
    const declining = host(store, false)
    const refusing = createAppTools(declining)
    const p1 = (await parse(tool(refusing, 'project_create')({ label: 'Gone', open: true }))).created.id as string
    await tool(refusing, 'project_add')({ ids: ['a', 'b'] })
    expect(store.scope).toBe(p1)
    expect(await tool(refusing, 'project_delete')({ id: p1 })).toMatch(/declined/)
    expect(declining.confirmations[0]).toMatch(/Delete project “Gone” \(its entities stay in the Library\)/)
    expect(isProjectEntity(store.get(p1))).toBe(true)
    expect(store.projectsOf('a')).toEqual([p1])

    // Confirmed, entities kept: the marks go, the entities stay, the open project falls back to the Library.
    const agreeing = host(store)
    const tools = createAppTools(agreeing)
    const r = await parse(tool(tools, 'project_delete')({ id: p1 }))
    expect(r).toMatchObject({ project: p1, unmarked: 3, deleted: 0 })
    expect(store.get(p1)).toBeUndefined()
    expect(store.get('a')).toBeDefined()
    expect(store.projectsOf('a')).toEqual([])
    expect(store.scope).toBeNull()

    // Exclusive entities: only those in no other project are deleted with it.
    const p2 = (await parse(tool(tools, 'project_create')({ label: 'Two', open: false }))).created.id as string
    const p3 = (await parse(tool(tools, 'project_create')({ label: 'Three', open: false }))).created.id as string
    await tool(tools, 'project_add')({ project: p2, ids: ['a', 'b'] })
    await tool(tools, 'project_add')({ project: p3, ids: ['a'] })
    const ex = await parse(tool(tools, 'project_delete')({ id: p2, exclusive_entities: true }))
    expect(agreeing.confirmations.at(-1)).toMatch(/and its 2 exclusive entities/)
    expect(ex.deleted).toBe(2)
    expect(store.get('a')).toBeDefined()
    expect(store.get('b')).toBeUndefined()
    expect(store.get('ab')).toBeUndefined()
    expect(listProjects(store).map((p) => p.id)).toEqual([p3])
    await expect(tool(tools, 'project_delete')({ id: 'nope' })).rejects.toThrow()
  })

  it('applies a template document into a new project, adopting loose entities of its types', async () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 's1', type: 'segment', label: 'S1' }), createEntity({ id: 's2', type: 'segment', label: 'S2' }), createEntity({ id: 'n', type: 'note', label: 'N' })])
    const h = host(store)
    const tools = createAppTools(h)
    const listed = await parse(tool(tools, 'project_template')({ action: 'list' }))
    expect(listed.templates.map((t: { id: string }) => t.id)).toContain('conversation-atlas')
    const doc = {
      $schema: 'aegraph/v1',
      exportedAt: '2026-09-16T00:00:00.000Z',
      template: { id: 't', label: 'T', description: 'a test template', requires: ['segment', 'topic'], adopts: ['segment'], home: '/analytics' },
      entities: [
        createEntity({ id: 'tpl:t:chart-a', type: 'plot', label: 'A', data: { spec: { selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'data.created', bin: 'month' }] } } }),
        createEntity({ id: 'tpl:t:filter-s', type: 'filter', label: 'S · filter', data: { types: ['segment'] } }),
        createEntity({ id: 'tpl:t:scene-s', type: 'scene', label: 'S', data: { renderer: '2d', filterId: 'tpl:t:filter-s' } }),
      ],
    }
    const r = await parse(tool(tools, 'project_template')({ action: 'apply', text: JSON.stringify(doc), new_project: true }))
    expect(r.template).toBe('t')
    expect(r.project.label).toBe('T')
    expect(r.created).toBe(3)
    expect(r.adopted).toBe(2)
    expect(r.missing).toEqual(['topic'])
    expect(r.now).toMatchObject({ charts: 1, scenes: 1 })
    const pid = r.project.id as string
    expect(store.scope).toBe(pid)
    expect(store.projectsOf('s1')).toEqual([pid])
    expect(store.projectsOf('n')).toEqual([])
    // Ids are prefixed with the project, so applying again updates instead of duplicating.
    const again = await parse(tool(tools, 'project_template')({ action: 'apply', text: JSON.stringify(doc), project: pid, open: false }))
    expect(again).toMatchObject({ created: 0, updated: 3 })
    expect(store.library.ofType('plot').length).toBe(1)
    await expect(tool(tools, 'project_template')({ action: 'apply', text: JSON.stringify({ entities: [] }) })).rejects.toThrow(/template/)
  })

  it('publishes the open project as one HTML page and hands the file to the browser', async () => {
    const store = new EntityStore()
    seed(store)
    const h = host(store)
    const tools = createAppTools(h)
    const pid = (await parse(tool(tools, 'project_create')({ label: 'Pub', open: true }))).created.id as string
    await tool(tools, 'project_add')({ ids: ['a', 'b', 'c'] })
    const saved: { name: string; size: number }[] = []
    const anchor = { href: '', download: '', click: () => saved.push({ name: anchor.download, size: -1 }), remove: () => {} }
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: () => {} } })
    vi.stubGlobal('URL', { ...URL, createObjectURL: (b: Blob) => ((saved.length = 0), `blob:${b.size}`), revokeObjectURL: () => {} })
    const r = await parse(tool(tools, 'project_publish')({ skip_charts: true }))
    expect(r.project).toBe(pid)
    expect(r.filename).toMatch(/^pub.*\.html$/i)
    expect(r.entities).toBe(3)
    expect(saved).toEqual([{ name: r.filename, size: -1 }])
    await expect(tool(tools, 'project_publish')({ id: 'nope' })).rejects.toThrow()
  })

  it('tags and untags entities in bulk, by ids and by query', async () => {
    const store = new EntityStore()
    seed(store)
    const tools = createAppTools(host(store))
    const r = await parse(tool(tools, 'tag_entities')({ query: { type: 'note' }, add: ['reviewed', 'tier:core'] }))
    expect(r).toMatchObject({ matched: 2, changed: 2, added: ['reviewed', 'tier:core'] })
    expect(store.get('a')!.tags).toEqual(['keep', 'reviewed', 'tier:core'])
    expect(store.get('b')!.tags).toEqual(['reviewed', 'tier:core'])
    expect(store.get('c')!.tags).toEqual(['keep'])
    // Already there: nothing changes; a removal by tag query reaches every carrier.
    expect((await parse(tool(tools, 'tag_entities')({ ids: ['a'], add: ['reviewed'] }))).changed).toBe(0)
    const off = await parse(tool(tools, 'tag_entities')({ query: { tag: 'keep' }, remove: ['keep'] }))
    expect(off).toMatchObject({ matched: 2, changed: 2, removed: ['keep'] })
    expect(store.get('a')!.tags).toEqual(['reviewed', 'tier:core'])
    expect(store.get('c')!.tags).toEqual([])
    await expect(tool(tools, 'tag_entities')({ ids: ['a'] })).rejects.toThrow(/tags to add or remove/)
    await expect(tool(tools, 'tag_entities')({ query: { type: 'nothing' }, add: ['x'] })).rejects.toThrow(/No entities matched/)
  })
})

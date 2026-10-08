import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { isRelationship } from '../../../core/entity/types'
import { ANALYTICS_ROUTES, RESOURCE_ROUTES, sidebarCounts } from '../counts'
import { chatEntityId } from '../../../features/assistant/chatIds'
import '../../../core/resources/types'
import '../../../core/graph/types'

/**
 * What the sidebar shows beside its rows: a count per route — the resources,
 * and what Analytics keeps (scenes, scripts, datasets, charts) — and each
 * group's total, only where there is something to count, read through the
 * store's index rather than by building lists, and narrowed by the open
 * project, since that is what the page it opens will show. Also that
 * `countOfType` agrees with `ofType().length` everywhere it is asked.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    ...Array.from({ length: 4 }, (_, i) => createEntity({ id: `d${i}`, type: 'document', label: `Doc ${i}` })),
    ...Array.from({ length: 2 }, (_, i) => createEntity({ id: `i${i}`, type: 'image' })),
    createEntity({ id: 'm0', type: 'map' }),
    createEntity({ id: 'n0', type: 'note' }),
    // What Analytics keeps: a chart, a script and one of its subtypes, a dataset and one of its subtypes, and two kinds of scene.
    createEntity({ id: 'p0', type: 'plot' }),
    createEntity({ id: 's0', type: 'script' }),
    createEntity({ id: 's1', type: 'script:filter' }),
    createEntity({ id: 'ds0', type: 'dataset' }),
    createEntity({ id: 'ds1', type: 'dataset:excel', data: { columns: [], rows: [] } }),
    createEntity({ id: 'sc0', type: 'projection' }),
    createEntity({ id: 'sc1', type: 'scene:unigraph' }),
    createRelationship({ id: 'r0', type: 'references', source: 'd0', target: 'd1' }),
  ])
  return s
}

describe('sidebar counts', () => {
  it('counts each resource route, leaves the empty ones out, and totals the group', () => {
    const s = fixture()
    const c = sidebarCounts(s)
    expect(c.byRoute).toEqual({ '/entities': 15, '/documents': 4, '/images': 2, '/maps': 1, '/analytics/charts': 1, '/analytics/scripts': 2, '/analytics/datasets': 2, '/scenes': 2 })
    expect(c.resources).toBe(7)
    // Scripts and datasets count their subtypes and scenes their whole family, the way the pages list them.
    expect(c.analytics).toBe(7)
    expect(Object.keys(c.byRoute)).not.toContain('/videos') // nothing there: nothing shown
    expect(sidebarCounts(new EntityStore())).toEqual({ byRoute: {}, resources: 0, analytics: 0 })
    // Every route names types the app defines, and no type is counted under two routes.
    const types = [...Object.values(RESOURCE_ROUTES), ...Object.values(ANALYTICS_ROUTES)].flat()
    expect(new Set(types).size).toBe(types.length)
  })

  it('follows the open project, because that is what the page will show', () => {
    const s = fixture()
    s.upsert(createEntity({ id: 'project:p', type: 'project', label: 'P' }))
    s.upsert({ ...s.get('d0')!, meta: { ...s.get('d0')!.meta, projects: ['project:p'] } })
    s.upsert({ ...s.get('m0')!, meta: { ...s.get('m0')!.meta, projects: ['project:p'] } })
    s.setScope('project:p')
    expect(sidebarCounts(s)).toEqual({ byRoute: { '/entities': s.all().filter((e) => !isRelationship(e)).length, '/documents': 1, '/maps': 1 }, resources: 2, analytics: 0 })
    s.setScope(null)
    expect(sidebarCounts(s).resources).toBe(7)
  })

  it('moves with the data too: a scene saved, a script given a kind, a chart deleted', () => {
    const s = fixture()
    expect(sidebarCounts(s).byRoute['/scenes']).toBe(2)
    s.upsert(createEntity({ id: 'sc2', type: 'scene:script' }))
    expect(sidebarCounts(s).byRoute['/scenes']).toBe(3)
    // A script given a kind changes type; it is still a script.
    s.upsert({ ...s.get('s0')!, type: 'script:layout' })
    expect(sidebarCounts(s).byRoute['/analytics/scripts']).toBe(2)
    s.remove('p0')
    expect(sidebarCounts(s).byRoute['/analytics/charts']).toBeUndefined()
    expect(sidebarCounts(s).analytics).toBe(7)
  })

  it('moves with the data: a new resource, a retyped one, a removal', () => {
    const s = fixture()
    s.upsert(createEntity({ id: 'v0', type: 'video' }))
    expect(sidebarCounts(s).byRoute['/videos']).toBe(1)
    s.upsert({ ...s.get('v0')!, type: 'audio' })
    expect(sidebarCounts(s).byRoute['/videos']).toBeUndefined()
    expect(sidebarCounts(s).byRoute['/audio']).toBe(1)
    s.remove('v0')
    expect(sidebarCounts(s).byRoute['/audio']).toBeUndefined()
    s.remove(['d0', 'd1', 'd2', 'd3'])
    expect(sidebarCounts(s).byRoute['/documents']).toBeUndefined()
    expect(sidebarCounts(s).resources).toBe(3)
  })
})

describe('the Entities and Chats rows', () => {
  it('Entities is the open project’s entities, relationships aside, as the store keeps the count', () => {
    const s = fixture()
    expect(sidebarCounts(s).byRoute['/entities']).toBe(s.all().filter((e) => !isRelationship(e)).length)
    s.upsert(createEntity({ id: 'n1', type: 'note' }))
    s.upsert(createRelationship({ id: 'r1', type: 'references', source: 'd0', target: 'n1' }))
    expect(sidebarCounts(s).byRoute['/entities']).toBe(16)
    s.remove(['d0', 'd1', 'd2', 'd3', 'i0', 'i1', 'm0', 'n0', 'n1', 'p0', 's0', 's1', 'ds0', 'ds1', 'sc0', 'sc1'])
    expect(sidebarCounts(s).byRoute['/entities']).toBeUndefined()
  })

  it('Chats is the open project’s conversations and its open chats not yet recorded — each once; all of them in the Library', () => {
    const s = fixture()
    expect(sidebarCounts(s).byRoute['/chats']).toBeUndefined()
    // Two imported conversations and one chat of the assistant's, recorded; it is also open, with a new one beside it.
    s.upsertMany([
      createEntity({ id: 'c0', type: 'conversation', label: 'Imported' }),
      createEntity({ id: 'c1', type: 'conversation', label: 'Imported too' }),
      createEntity({ id: chatEntityId('open-1'), type: 'conversation', label: 'Recorded' }),
    ])
    expect(sidebarCounts(s).byRoute['/chats']).toBe(3)
    expect(sidebarCounts(s, 'open-1\t\nopen-2\t').byRoute['/chats']).toBe(4)
    // A project open: its own conversations, and its own open chats not yet recorded.
    s.upsert(createEntity({ id: 'project:p', type: 'project', label: 'P' }))
    s.upsert(createEntity({ id: 'c-in-p', type: 'conversation', label: 'In P', meta: { projects: ['project:p'] } }))
    s.setScope('project:p')
    expect(sidebarCounts(s, 'open-1\t\nopen-2\t').byRoute['/chats']).toBe(1)
    expect(sidebarCounts(s, 'open-1\t\nopen-2\tproject:p\nopen-3\tproject:q').byRoute['/chats']).toBe(2)
  })
})

describe('countOfType', () => {
  it('agrees with ofType().length, scoped and not, and answers nothing for a type nobody has', () => {
    const s = fixture()
    for (const t of ['document', 'image', 'map', 'note', 'references', 'nobody-has-this']) expect(s.countOfType(t), t).toBe(s.ofType(t).length)
    expect(s.countOfType('nobody-has-this')).toBe(0)
    expect(s.countOfType('')).toBe(0)
    s.upsert(createEntity({ id: 'project:p', type: 'project' }))
    s.upsert({ ...s.get('d0')!, meta: { ...s.get('d0')!.meta, projects: ['project:p'] } })
    s.setScope('project:p')
    for (const t of ['document', 'image', 'map']) expect(s.countOfType(t), t).toBe(s.ofType(t).length)
    // The Library view ignores the scope, as its other reads do.
    expect(s.library.countOfType('document')).toBe(4)
    expect(s.library.countOfType('nobody')).toBe(0)
    s.setScope(null)
    expect(s.countByType().get('document')).toBe(4)
  })

  it('counts a hundred thousand entities without building them, and stays right as the scope narrows', () => {
    const s = new EntityStore()
    const n = 100_000
    s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `e${i}`, type: i % 4 ? 'document' : 'image' })))
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) s.countOfType('document')
    const counting = performance.now() - t0
    expect(s.countOfType('document')).toBe(75_000)
    expect(s.countOfType('image')).toBe(25_000)
    const t1 = performance.now()
    const listed = s.ofType('document').length
    const listing = performance.now() - t1
    expect(listed).toBe(75_000)
    // Two hundred counts cost less than one listing — that is the point of the index.
    expect(counting, `${counting.toFixed(1)} ms for 200 counts vs ${listing.toFixed(1)} ms for one list`).toBeLessThan(Math.max(listing, 1) * 2)
    expect(s.countByType()).toEqual(new Map([['document', 75_000], ['image', 25_000]]))
    expect(s.countByType()).toBe(s.countByType()) // kept for the version, not recounted per caller
  })
})

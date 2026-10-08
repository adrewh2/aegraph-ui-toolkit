import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore, MAX_INCLUDED_PROJECTS } from '../../entity/store'
import { getActiveProjectId, PROJECT_UI_KEYS, readStashedUiState, restoreActiveProject, stashUiState, switchProject } from '../active'
import { BundleDeclined, importBundle, importBundleAsync, previewBundle } from '../bundle'
import { createProject, includedProjects, wouldCycle } from '../project'
import { applyTemplate, type TemplateDocument } from '../template'

/**
 * A bundle is a file from anyone: what it may change in the reader's Library, and what it may not. The file's own
 * project and its entities are its to write — a demo or a pipeline's output opened again updates in place — and
 * nothing else is: not another project, not an entity of the reader's, not a Library-wide definition unless agreed.
 */
const T = '2024-01-01T00:00:00.000Z'
const LATER = '2025-01-01T00:00:00.000Z'
const FUTURE = '9999-01-01T00:00:00.000Z'
const raw = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, tags: [], data: {}, meta: { createdAt: T, updatedAt: T }, ...extra })

/** A Library with one project of the reader's ('mine', holding 'diary'), a loose note and a type definition. */
function library() {
  const store = new EntityStore()
  store.upsert(createProject({ id: 'mine', label: 'Mine' }))
  store.upsert(createEntity({ id: 'diary', type: 'note', label: 'diary', data: { secret: 1 }, meta: { projects: ['mine'], createdAt: T, updatedAt: T } }))
  store.upsert(createEntity({ id: 'loose', type: 'note', label: 'loose', meta: { createdAt: T, updatedAt: T } }))
  store.upsert(createEntity({ id: 'type:note', type: 'schema:type', label: 'Note', data: { name: 'note', color: '#000' } }))
  store.setTagInfo('red', { color: '#f00' })
  return store
}

beforeEach(() => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = String(v)), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
})

describe('what a bundle may change', () => {
  it('leaves the reader’s entities, projects and definitions alone, plants nothing in their projects, and counts what it left', () => {
    const store = library()
    const evil = {
      $schema: 'aegraph/v1',
      project: 'evil',
      tags: [{ tag: 'red', color: '#0f0' }],
      entities: [
        raw('evil', 'project', { data: { includes: ['mine'] } }),
        raw('diary', 'note', { label: 'pwned', meta: { createdAt: T, updatedAt: FUTURE } }),
        raw('loose', 'note', { label: 'pwned', meta: { createdAt: T, updatedAt: FUTURE } }),
        raw('mine', 'project', { label: 'Renamed', meta: { createdAt: T, updatedAt: FUTURE } }),
        raw('other', 'project', { label: 'A project of its own' }),
        raw('planted', 'note', { meta: { createdAt: T, updatedAt: T, projects: ['mine', 'other'] } }),
        raw('type:note', 'schema:type', { label: 'Note', data: { name: 'note', color: '#f00' }, meta: { createdAt: T, updatedAt: FUTURE } }),
      ],
    }
    const r = importBundle(store, evil, { name: 'evil' })
    expect(store.get('diary')!.label).toBe('diary')
    expect(store.get('loose')!.label).toBe('loose')
    expect(store.projectsOf('loose')).toEqual([])
    expect(store.get('mine')!.label).toBe('Mine')
    expect(store.has('other')).toBe(false)
    expect(store.projectsOf('planted')).toEqual(['evil'])
    expect([...store.scopeOf('mine')]).toEqual(['diary'])
    expect(store.get('type:note')!.data.color).toBe('#000')
    expect(store.getTagInfo('red').color).toBe('#f00')
    // Its includes are not taken: the reader's project does not become part of the file's.
    expect(store.get('evil')!.data.includes).toBeUndefined()
    expect([...store.scopeOf('evil')]).toEqual(['planted'])
    expect(r.conflicts).toEqual({ entities: 2, projects: 2, types: 1, tags: 1 })
    expect(r.created).toBe(2)
  })

  it('replaces a different type definition and tag colour only when the caller agreed', () => {
    const store = library()
    const doc = { $schema: 'aegraph/v1', project: 'p', tags: [{ tag: 'red', color: '#0f0' }], entities: [raw('p', 'project'), raw('type:note', 'schema:type', { label: 'Note', data: { name: 'note', color: '#f00' } })] }
    const r = importBundle(store, doc, { replaceTypes: true })
    expect(r.conflicts.types).toBe(0)
    expect(store.get('type:note')!.data.color).toBe('#f00')
    expect(store.getTagInfo('red').color).toBe('#0f0')
    // The same definition again is nothing to ask about.
    expect(previewBundle(store, doc).conflicts).toMatchObject({ types: 0, tags: 0 })
  })

  it('updates its own entities in place when opened again with newer ones, keeping the projects the reader added them to', () => {
    const store = library()
    const v1 = { $schema: 'aegraph/v1', project: 'demo', entities: [raw('demo', 'project', { label: 'Demo' }), raw('d1', 'note', { label: 'one', meta: { createdAt: T, updatedAt: T, projects: ['demo'] } })] }
    importBundle(store, v1)
    store.mark(['d1'], 'mine')
    const v2 = { ...v1, entities: [raw('demo', 'project', { label: 'Demo 2', meta: { createdAt: T, updatedAt: LATER } }), raw('d1', 'note', { label: 'one, revised', meta: { createdAt: T, updatedAt: LATER, projects: ['demo'] } })] }
    const preview = previewBundle(store, v2)
    expect(preview).toMatchObject({ project: { id: 'demo', exists: true }, updated: 1, updates: ['d1'], created: 0 })
    const r = importBundle(store, v2)
    expect(r).toMatchObject({ created: 0, updated: 1, upToDate: 0 })
    expect(store.get('d1')!.label).toBe('one, revised')
    expect(store.projectsOf('d1').sort()).toEqual(['demo', 'mine'])
    expect(store.get('demo')!.label).toBe('Demo 2')
    // Opened a third time, the same file: nothing to do.
    expect(importBundle(store, v2)).toMatchObject({ created: 0, updated: 0, upToDate: 1 })
  })

  it('keeps an existing project’s own includes when the file updates it', () => {
    const store = library()
    store.upsert({ ...createProject({ id: 'demo', label: 'Demo', includes: ['mine'] }), meta: { createdAt: T, updatedAt: T } })
    importBundle(store, { $schema: 'aegraph/v1', project: 'demo', entities: [raw('demo', 'project', { label: 'Demo 2', data: { includes: ['loose'] }, meta: { createdAt: T, updatedAt: LATER } })] })
    expect(store.get('demo')!.label).toBe('Demo 2')
    expect(store.get('demo')!.data.includes).toEqual(['mine'])
  })

  it('brings dates after now back to now', () => {
    const store = new EntityStore()
    importBundle(store, { $schema: 'aegraph/v1', project: 'p', entities: [raw('p', 'project'), raw('n', 'note', { meta: { createdAt: FUTURE, updatedAt: FUTURE } })] })
    const now = new Date().toISOString()
    expect(store.get('n')!.meta.updatedAt <= now).toBe(true)
    expect(store.get('n')!.meta.createdAt <= now).toBe(true)
    expect(store.get('p')!.meta.updatedAt <= now).toBe(true)
  })

  it('does not take an id the Library holds as something else, or one with quotes, for its project', () => {
    const store = library()
    const r = importBundle(store, { $schema: 'aegraph/v1', project: 'loose', entities: [raw('loose', 'project', { label: 'Taken' }), raw('n', 'note', { meta: { createdAt: T, updatedAt: T, projects: ['loose'] } })] })
    expect(store.get('loose')!.type).toBe('note')
    expect(r.project.id).not.toBe('loose')
    expect(r.project.label).toBe('Taken')
    expect(store.projectsOf('n')).toEqual([r.project.id])
    const quoted = 'P","id":"victim'
    const q = importBundle(store, { $schema: 'aegraph/v1', project: quoted, entities: [raw(quoted, 'project')] }, { name: 'Quoted' })
    expect(q.project.id).not.toBe(quoted)
    expect(store.has(quoted)).toBe(false)
  })

  it('asks before writing when the caller wants to, and writes nothing on a no', async () => {
    const store = library()
    const doc = { $schema: 'aegraph/v1', project: 'p', entities: [raw('p', 'project'), raw('n', 'note'), raw('type:note', 'schema:type', { label: 'Note', data: { name: 'note', color: '#f00' } })] }
    let seen: unknown
    await expect(importBundleAsync(store, doc, { confirm: (p) => ((seen = p), false) })).rejects.toBeInstanceOf(BundleDeclined)
    expect(seen).toMatchObject({ project: { id: 'p', exists: false }, created: 2, types: ['type:note'], conflicts: { types: 1 } })
    expect(store.has('p')).toBe(false)
    expect(store.has('n')).toBe(false)
    const r = await importBundleAsync(store, doc, { confirm: () => true })
    expect(r.created).toBe(2)
    expect(store.get('type:note')!.data.color).toBe('#f00')
  })
})

describe('includes from outside', () => {
  it('a chain of fifty thousand includes neither throws nor walks past its bounds', () => {
    const store = new EntityStore()
    const N = 50_000
    store.upsertMany(Array.from({ length: N }, (_, i) => createProject({ id: `p${i}`, label: `p${i}`, includes: i + 1 < N ? [`p${i + 1}`] : undefined })))
    store.upsert(createEntity({ id: 'deep-note', type: 'note', meta: { projects: [`p${N - 1}`] } }))
    store.upsert(createEntity({ id: 'near-note', type: 'note', meta: { projects: ['p3'] } }))
    expect([...store.scopeOf('p0')]).toEqual(['near-note'])
    expect(includedProjects(store, 'p0').size).toBeLessThanOrEqual(MAX_INCLUDED_PROJECTS)
    store.setScope('p0')
    expect(store.all().map((e) => e.id)).toContain('near-note')
    // What cannot be followed to its end is not shown to come back: refused as a cycle.
    expect(wouldCycle(store, 'p0', 'p1')).toBe(true)
    expect(wouldCycle(store, 'p0', `p${N - 1}`)).toBe(false)
  })

  it('a project that cannot be read leaves the Library open, and is not the one the next load opens', () => {
    const store = new EntityStore()
    store.upsert(createProject({ id: 'broken', label: 'Broken' }))
    const spy = vi.spyOn(store, 'scopeOf').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(switchProject(store, 'broken')).toBe(false)
    expect(store.scope).toBeNull()
    expect(getActiveProjectId()).toBeNull()
    localStorage.setItem('aegraph:project', 'broken')
    restoreActiveProject(store)
    expect(store.scope).toBeNull()
    expect(getActiveProjectId()).toBeNull()
    spy.mockRestore()
    warn.mockRestore()
  })
})

describe('UI state from a file', () => {
  it('keeps only the pages’ own keys, as strings, within the cap, and a project named `library` is not the Library', () => {
    localStorage.setItem('aegraph:ui:library', JSON.stringify({ 'aegraph:explorer:v1': 'mine' }))
    importBundle(new EntityStore(), { $schema: 'aegraph/v1', project: 'library', entities: [raw('library', 'project')], state: { ui: { 'aegraph:explorer:v1': 'theirs', 'aegraph:scripts:v1': 5, junk: 'x'.repeat(1000) } } })
    expect(readStashedUiState(null)).toEqual({ 'aegraph:explorer:v1': 'mine' })
    expect(readStashedUiState('library')).toEqual({ 'aegraph:explorer:v1': 'theirs' })
    stashUiState('big', { 'aegraph:workstation:v1': 'w', 'aegraph:explorer:positions:v1': 'x'.repeat(3_000_000) } as Record<string, string>)
    expect(readStashedUiState('big')).toEqual({ 'aegraph:workstation:v1': 'w' })
    expect(PROJECT_UI_KEYS).toContain('aegraph:explorer:positions:v1')
  })

  it('moves a project’s state from where it was kept before', () => {
    localStorage.setItem('aegraph:ui:p1', JSON.stringify({ 'aegraph:workstation:v1': 'old' }))
    expect(readStashedUiState('p1')).toEqual({ 'aegraph:workstation:v1': 'old' })
    expect(localStorage.getItem('aegraph:ui:p1')).toBeNull()
    expect(readStashedUiState('p1')).toEqual({ 'aegraph:workstation:v1': 'old' })
  })
})

describe('a template over a project id', () => {
  const tpl = (): TemplateDocument => ({ $schema: 'aegraph/v1', exportedAt: T, template: { id: 't', label: 'T' }, entities: [createEntity({ id: 'tpl:t:chart', type: 'plot', label: 'Chart', data: { note: 'see tpl:t:chart', 'tpl:t:chart': 1 } })] })

  it('rewrites ids inside strings and keys, never the JSON text', () => {
    const store = new EntityStore()
    store.upsert(createProject({ id: 'p:1', label: 'P' }))
    applyTemplate(store, tpl(), 'p:1')
    const chart = store.get('p:1:tpl:t:chart')!
    expect(chart.data).toEqual({ note: 'see p:1:tpl:t:chart', 'p:1:tpl:t:chart': 1 })
  })

  it('refuses a project id with quotes or control characters', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'victim', type: 'note', label: 'my note' }))
    const pid = 'P","id":"victim","label":"overwritten","zz":"'
    store.upsert(createProject({ id: pid, label: 'p' }))
    expect(() => applyTemplate(store, tpl(), pid)).toThrow(/quotes or control characters/)
    expect(store.get('victim')!.label).toBe('my note')
  })
})

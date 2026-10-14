import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createProject, demoBundlePath, isDemoProject } from '../../../core/projects/project'
import { openBundleText } from '../projectActions'

/**
 * The Projects dialog's first tab lists the person's own projects and the
 * second the demos, so a demo has to be known once it is in the Library: a
 * project opened from a demo bundle says so (`data.demo`, the bundle's path),
 * and one opened before that was written is still known by what it carries.
 */
afterEach(() => vi.unstubAllGlobals())

describe('which URLs are demo bundles', () => {
  it('the demos and the shipped datasets on this site are; a file, the machine’s own bundles and other sites are not', () => {
    const here = 'https://aegraph.dev'
    expect(demoBundlePath('/demos/bahamas-tour/bundle.ae.json.gz', here)).toBe('/demos/bahamas-tour/bundle.ae.json.gz')
    expect(demoBundlePath('https://aegraph.dev/datasets/china-tour.ae.json', here)).toBe('/datasets/china-tour.ae.json')
    expect(demoBundlePath('/__local/demos/atlas', here)).toBeUndefined()
    expect(demoBundlePath('https://elsewhere.example/demos/x/bundle.aeb', here)).toBeUndefined()
    expect(demoBundlePath('import', here)).toBeUndefined()
    // With no page (the headless engine), only a path is this site's.
    expect(demoBundlePath('/demos/x/bundle.aeb', undefined)).toBe('/demos/x/bundle.aeb')
    expect(demoBundlePath('https://elsewhere.example/demos/x/bundle.aeb', undefined)).toBeUndefined()
  })
})

describe('which projects are demos', () => {
  it('knows one by its mark, by what the bundle says of itself, or by the demo id in its project id', () => {
    const mine = createProject({ id: 'p-mine', label: 'Thesis' })
    expect(isDemoProject(mine)).toBe(false)
    expect(isDemoProject({ ...mine, data: { ...mine.data, demo: '/demos/x/bundle.aeb' } })).toBe(true)
    expect(isDemoProject(createProject({ id: 'aurora', label: 'Aurora', source: 'demo:aurora' }))).toBe(true)
    const legacy = createProject({ id: 'project:bahamas-tour', label: 'Bahamas', source: 'import:bahamas-tour' })
    expect(isDemoProject(legacy)).toBe(false)
    expect(isDemoProject(legacy, new Set(['bahamas-tour']))).toBe(true)
    // A project of one's own whose id merely looks like one is not taken for a demo that does not exist.
    expect(isDemoProject(createProject({ id: 'project:notes', label: 'Notes' }), new Set(['bahamas-tour']))).toBe(false)
  })
})

describe('opening a demo marks its project', () => {
  const mem: Record<string, string> = {}
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
  })
  const bundle = (updatedAt: string) => {
    const project = createProject({ id: 'project:trees', label: 'Trees', source: 'import:trees' })
    project.meta.updatedAt = updatedAt
    const tree = createEntity({ id: 'tree-1', type: 'note', label: 'Oak' })
    return JSON.stringify({ $schema: 'aegraph/v1', project: project.id, entities: [project, tree] })
  }

  it('by the path it came from, leaving updatedAt alone so a newer build of the demo still updates it', async () => {
    const store = new EntityStore()
    const r = await openBundleText(store, bundle('2026-01-01T00:00:00.000Z'), 'trees', '/demos/trees/bundle.ae.json')
    expect(r.project.data.demo).toBe('/demos/trees/bundle.ae.json')
    const p = store.get('project:trees')!
    expect(p.data.demo).toBe('/demos/trees/bundle.ae.json')
    expect(p.meta.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    await openBundleText(store, bundle('2026-02-01T00:00:00.000Z'), 'trees', '/demos/trees/bundle.ae.json')
    expect(store.get('project:trees')!.meta.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(store.get('project:trees')!.data.demo).toBe('/demos/trees/bundle.ae.json')
  })

  it('and a bundle from a file is the person’s own', async () => {
    const store = new EntityStore()
    const r = await openBundleText(store, bundle('2026-01-01T00:00:00.000Z'), 'trees')
    expect(r.project.data.demo).toBeUndefined()
    expect(isDemoProject(store.get('project:trees') as never)).toBe(false)
  })
})

describe('opening a newer version of the project already open', () => {
  const mem: Record<string, string> = {}
  beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k]
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
  })
  const WS = 'aegraph:workstation:v1'
  const bundle = (updatedAt: string, label: string, ws?: string) => {
    const project = createProject({ id: 'project:story', label: 'Story', source: 'import:story' })
    project.meta.updatedAt = updatedAt
    const scene = createEntity({ id: 'scene-1', type: 'note', label })
    scene.meta.updatedAt = updatedAt
    return JSON.stringify({ $schema: 'aegraph/v1', project: project.id, ...(ws ? { state: { ui: { [WS]: ws } } } : {}), entities: [project, scene] })
  }

  it('takes the file’s screen when the file changed the project, and keeps the reader’s when it changed nothing or carries none', async () => {
    const store = new EntityStore()
    await openBundleText(store, bundle('2026-01-01T00:00:00.000Z', 'Old', 'ws-v1'), 'story', '/demos/story/bundle.ae.json')
    expect(store.scope).toBe('project:story')
    expect(localStorage.getItem(WS)).toBe('ws-v1')
    // The reader arranges the screen; opening the same version again changes nothing and keeps it.
    localStorage.setItem(WS, 'mine')
    const same = await openBundleText(store, bundle('2026-01-01T00:00:00.000Z', 'Old', 'ws-v1'), 'story', '/demos/story/bundle.ae.json')
    expect(same.created + same.updated).toBe(0)
    expect(localStorage.getItem(WS)).toBe('mine')
    // A newer build of it, over the project open now: its data and its screen — the tabs kept from before held copies
    // of the old scenes' parts and would have gone on drawing them.
    const newer = await openBundleText(store, bundle('2026-02-01T00:00:00.000Z', 'New', 'ws-v2'), 'story', '/demos/story/bundle.ae.json')
    expect(newer.updated).toBeGreaterThan(0)
    expect(store.get('scene-1')?.label).toBe('New')
    expect(localStorage.getItem(WS)).toBe('ws-v2')
    // A newer one with no screen of its own leaves the screen alone rather than bring back an older stash.
    localStorage.setItem(WS, 'mine again')
    await openBundleText(store, bundle('2026-03-01T00:00:00.000Z', 'Newer'), 'story', '/demos/story/bundle.ae.json')
    expect(store.get('scene-1')?.label).toBe('Newer')
    expect(localStorage.getItem(WS)).toBe('mine again')
  })
})

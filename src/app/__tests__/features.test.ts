import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../core/entity/entity'
import { EntityStore } from '../../core/entity/store'
import { featureOfPath, featureOn, featuresOff, FEATURE_NAMES, parseFeaturesOff, pathOff } from '../features'

/**
 * Per-deployment feature flags (`app/features.ts`). The module reads `AEGRAPH_FEATURES_OFF` once, when it loads — in
 * the browser bundle a constant `vite.config.ts` bakes in, here the environment — so a test that turns features off
 * stubs the variable, resets the module registry and imports what it checks afresh.
 */

const ALL_OFF = 'maps,globe,videos,audio'

/** The modules under test, loaded as a build with `off` set would load them. */
async function withFeaturesOff(off: string) {
  vi.stubEnv('AEGRAPH_FEATURES_OFF', off)
  vi.resetModules()
  return {
    features: await import('../features'),
    nav: await import('../../components/Sidebar/nav'),
    counts: await import('../../components/Sidebar/counts'),
    docs: await import('../../features/docs/pages'),
    routes: await import('../routes'),
    hosts: await import('../../features/workstation/hosts'),
    model: await import('../../features/workstation/model'),
    suggestions: await import('../../features/assistant/suggestions'),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the flags', () => {
  it('reads a comma-separated list, any case, and sets aside names it does not know', () => {
    expect(parseFeaturesOff(' Maps, audio ,typo,,maps ')).toEqual({ off: ['maps', 'audio'], unknown: ['typo'] })
    expect(parseFeaturesOff(undefined)).toEqual({ off: [], unknown: [] })
    expect(parseFeaturesOff('')).toEqual({ off: [], unknown: [] })
  })

  it('unset, everything is on (the default build)', () => {
    expect(FEATURE_NAMES).toEqual(['maps', 'globe', 'videos', 'audio'])
    for (const f of FEATURE_NAMES) expect(featureOn(f)).toBe(true)
    expect(featuresOff()).toEqual([])
    expect(pathOff('/maps/x?view=globe')).toBeUndefined()
  })

  it('knows which feature a path belongs to — the globe is the Maps page in globe mode', () => {
    expect(featureOfPath('/maps')).toBe('maps')
    expect(featureOfPath('/maps/all')).toBe('maps')
    expect(featureOfPath('/maps/m1?view=globe')).toBe('globe')
    expect(featureOfPath('/maps/m1?list=0&view=globe')).toBe('globe')
    expect(featureOfPath('/videos/v1?t=3')).toBe('videos')
    expect(featureOfPath('/music/a')).toBe('audio')
    expect(featureOfPath('/mapsfoo')).toBeUndefined()
    expect(featureOfPath('/documents')).toBeUndefined()
  })

  it('the globe lives in Maps: Maps off takes the globe with it', async () => {
    const { features } = await withFeaturesOff('maps')
    expect(features.featureOn('globe')).toBe(false)
    expect(features.featuresOff()).toEqual(['maps', 'globe'])
    expect(features.pathOff('/maps/x?view=globe')).toBe('maps')
  })

})

describe('a deployment with maps, globe, videos and audio turned off', () => {
  it('takes their rows out of the sidebar, its counts, the panes and the presets', async () => {
    const { nav, counts, hosts, model } = await withFeaturesOff(ALL_OFF)
    const resources = nav.primaryNav.find((i) => i.label === 'Resources')!.children!.map((c) => c.label)
    expect(resources).toEqual(['Documents', 'Diagrams', 'Images'])
    expect(Object.keys(counts.RESOURCE_ROUTES)).toEqual(['/documents', '/diagrams', '/images'])
    const store = new EntityStore()
    store.upsert(createEntity({ type: 'map', label: 'm', data: { center: { lat: 0, lng: 0 }, zoom: 2 } }))
    store.upsert(createEntity({ type: 'document', label: 'd', data: { content: '', extension: 'md' } }))
    expect(counts.sidebarCounts(store).resources).toBe(1)
    expect(hosts.HOST_NAMES).not.toContain('maps')
    expect(hosts.hostForPath('/maps/x')).toBeUndefined()
    expect(model.VIEWS.map((v) => v.id)).not.toEqual(expect.arrayContaining(['maps']))
    expect(model.VIEWS.some((v) => ['maps', 'videos', 'audio'].includes(v.id))).toBe(false)
    expect(model.PRESETS.map((p) => p.id)).not.toContain('media')
  })

  it('hides the Maps docs page and the map showcases, and browses their entities in the Entities table', async () => {
    const { docs, routes, suggestions } = await withFeaturesOff(ALL_OFF)
    expect(docs.docPage('maps')).toBeUndefined()
    expect(docs.DOC_PAGES.some((p) => p.id === 'maps')).toBe(false)
    expect(docs.docPage('resources')).toBeDefined()
    expect(suggestions.SHOWCASES.some((s) => s.feature)).toBe(false)
    const { TypeRegistry } = await import('../../core/entity/typeRegistry')
    await import('../../core/resources/types')
    const registry = new TypeRegistry(new EntityStore())
    const href = (type: string, data: Record<string, unknown> = {}) => routes.entityHref(createEntity({ id: 'e', type, label: 'e', data }), registry)
    expect(href('map')).toMatch(/^\/entities\?.*sel=e$/)
    expect(href('video', { videoId: 'abc' })).toMatch(/^\/entities\?.*sel=e$/)
    expect(href('audio', { spotifyId: 'abc' })).toMatch(/^\/entities\?.*sel=e$/)
    expect(href('document', { extension: 'md' })).toBe('/documents/e')
  })

})

describe('a user’s own switches', () => {
  it('turn a feature off for this browser on the next load, say so, and never turn on what the deployment turned off', async () => {
    const mem: Record<string, string> = { 'aegraph:account:settings': JSON.stringify({ featuresOff: ['videos', 'maps', 'nonsense'] }) }
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    vi.resetModules()
    const f = await import('../features')
    expect(f.featureOn('videos')).toBe(false)
    expect(f.featureOn('maps')).toBe(false)
    // The globe lives in Maps: off with it, though the user never named it.
    expect(f.featureOn('globe')).toBe(false)
    expect(f.featureOn('audio')).toBe(true)
    expect(f.deploymentOff('videos')).toBe(false)
    expect(f.loadedUserFeaturesOff()).toEqual(['maps', 'videos'])
    expect(f.turnedOff('videos')).toMatch(/in your settings/)
    expect(f.pathOff('/videos/abc')).toBe('videos')
    expect(f.userFeaturesOff('not json')).toEqual([])
    vi.unstubAllGlobals()
    vi.resetModules()
  })
})

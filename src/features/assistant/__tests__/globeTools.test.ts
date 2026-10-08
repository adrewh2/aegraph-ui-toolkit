import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import type { AnyEntity } from '../../../core/entity/types'
import '../../../core/resources/types'
import { registerGlobeHandle, type GlobeHandle } from '../../globe/globeHandle'
import { createMap, isGeo, isMap } from '../../maps/maps'
import { createGlobeTools } from '../globeTools'
import { withInputChecks } from '../validate'
import type { AppHost } from '../tools'

/**
 * The globe tools: globe_load writes locations, paths and areas into the
 * store (on a new or an existing map, tagged, with their source) and
 * opens the Maps page in globe mode; globe opens, reads and drives the
 * page through its handle — a fake one here, recording what it was told.
 */
function setup() {
  const store = new EntityStore()
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createGlobeTools(host).map(withInputChecks)
  const run = (name: string) => {
    const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
    if (!t) throw new Error(`no tool ${name}`)
    return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  }
  return { store, navigated, run }
}

/** A Maps page on screen: every call recorded, the state as the page would answer it. */
function fakeGlobe() {
  const calls: string[] = []
  let mode: 'globe' | '2d' = '2d'
  let layer: GlobeHandle['getState'] extends () => { layer: infer L } ? L : never = 'streets'
  let selectedId: string | undefined
  let window: { from: string; to: string } | undefined
  let playhead: string | undefined
  let playing = false
  const h: GlobeHandle = {
    getState: () => ({ mode, layer, selectedId, playhead, playing, window, entities: 3, points: 2, arcs: 1, polygons: 0, selection: {}, camera: { lat: 10, lng: 20, altitude: 1.2 } }),
    setMode: (m) => ((mode = m), calls.push(`mode:${m}`)),
    setLayer: (l) => ((layer = l), calls.push(`layer:${l}`)),
    setWindow: (w) => ((window = w), calls.push(`window:${w ? `${w.from}..${w.to}` : 'none'}`)),
    flyTo: (lat, lng, altitude, ms) => calls.push(`fly:${lat},${lng},${altitude ?? '-'},${ms ?? '-'}`),
    fit: () => calls.push('fit'),
    select: (id) => ((selectedId = id), calls.push(`select:${id ?? 'none'}`)),
    setPlayhead: (iso) => ((playhead = iso), calls.push(`playhead:${iso ?? 'none'}`)),
    play: (on) => ((playing = on), calls.push(`play:${on}`)),
    spin: (on) => calls.push(`spin:${on}`),
  }
  return { h, calls }
}

describe('globe_load', () => {
  it('writes places, journeys and areas on a new map, tagged and sourced, and opens the globe on it', async () => {
    const { store, navigated, run } = setup()
    const r = await run('globe_load')({
      label: 'A trip',
      map: 'Trip map',
      tags: 'trip, 2025',
      source: 'flight log',
      locations: [{ label: 'Paris', lat: 48.86, lng: 2.35, at: '2025-05-01T08:00:00Z', tags: 'city', url: 'https://example.com/paris' }],
      paths: [{ label: 'CDG → JFK', points: [[2.55, 49.01], [-73.78, 40.64]], at: '2025-05-02T10:00:00Z', until: '2025-05-02T18:00:00Z' }],
      areas: [{ label: 'Île de la Cité', ring: [[2.34, 48.85], [2.35, 48.85], [2.35, 48.86], [2.34, 48.85]] }],
      go: false,
    })
    expect(r).toMatchObject({ created: 3, label: 'A trip', opened: false, entities: 3, locations: 1, paths: 1, areas: 1 })
    expect(r.map.label).toBe('Trip map')
    expect(r.href).toBe(`/maps/${encodeURIComponent(r.map.id)}?view=globe`)
    expect(navigated).toEqual([])
    const map = store.get(r.map.id)
    expect(isMap(map)).toBe(true)
    // The map is centred on the first place; everything loaded is on it, carries the common tags and the source.
    expect(isMap(map) && map.data.center).toEqual({ lat: 48.86, lng: 2.35 })
    const made: AnyEntity[] = r.ids.map((id: string) => store.get(id)!)
    expect(made.every((e) => isGeo(e) && (e.data as { mapId?: string }).mapId === r.map.id)).toBe(true)
    expect(made.every((e) => e.tags.includes('trip') && e.tags.includes('2025'))).toBe(true)
    expect(made.every((e) => e.meta.source === 'import:flight log')).toBe(true)
    const paris = made.find((e) => e.label === 'Paris')!
    expect(paris.tags).toContain('city')
    expect(paris.data).toMatchObject({ lat: 48.86, lng: 2.35, at: '2025-05-01T08:00:00Z' })
    const leg = made.find((e) => e.type === 'path')!
    expect(leg.data).toMatchObject({ at: '2025-05-02T10:00:00Z', until: '2025-05-02T18:00:00Z' })
  })

  it('loads onto an existing map, opens the globe when one is on screen, and refuses an empty load or a non-map', async () => {
    const { store, navigated, run } = setup()
    const map = createMap(store, { label: 'Mine' })
    const { h, calls } = fakeGlobe()
    const off = registerGlobeHandle(h, true)
    try {
      const r = await run('globe_load')({ label: 'Two', map_id: map.id, locations: [{ label: 'A', lat: 1, lng: 2 }, { label: 'B', lat: 3, lng: 4 }] })
      expect(r).toMatchObject({ created: 2, opened: true, map: { id: map.id, label: 'Mine' } })
      expect(navigated).toEqual([`/maps/${encodeURIComponent(map.id)}?view=globe`])
      expect(calls).toContain('mode:globe')
      expect(store.get(r.ids[0])?.meta.source).toBe('import:assistant')
    } finally {
      off()
    }
    await expect(run('globe_load')({ label: 'Nothing' })).rejects.toThrow(/locations, paths or areas/)
    store.upsert({ ...map, id: 'not-a-map', type: 'note', data: {} })
    await expect(run('globe_load')({ label: 'X', map_id: 'not-a-map', locations: [{ label: 'A', lat: 1, lng: 2 }] })).rejects.toThrow(/not a map/)
  })
})

describe('globe', () => {
  let off: (() => void) | undefined
  afterEach(() => off?.())

  it('opens the Maps page in globe mode, with a time window, and describes what is drawn', async () => {
    const { store, navigated, run } = setup()
    const map = createMap(store, { label: 'M' })
    await run('globe_load')({ label: 'L', map_id: map.id, locations: [{ label: 'A', lat: 1, lng: 2, at: '2024-01-01T00:00:00Z' }, { label: 'B', lat: 3, lng: 4, at: '2024-06-01T00:00:00Z' }], go: false })
    const { h, calls } = fakeGlobe()
    off = registerGlobeHandle(h, true)
    const r = await run('globe')({ action: 'open', map_id: map.id, from: '2024-03-01T00:00:00Z', to: '2024-12-31T00:00:00Z' })
    expect(r).toMatchObject({ href: `/maps/${encodeURIComponent(map.id)}?view=globe`, opened: true, entities: 1, locations: 1 })
    expect(navigated).toEqual([r.href])
    expect(calls).toEqual(['mode:globe', 'window:2024-03-01T00:00:00Z..2024-12-31T00:00:00Z'])
    // Without navigating: the description alone.
    const quiet = await run('globe')({ action: 'open', go: false })
    expect(quiet).toMatchObject({ href: '/maps/all?view=globe', opened: false, entities: 2 })
    expect(navigated).toHaveLength(1)
    await expect(run('globe')({ action: 'open', map_id: 'nope' })).rejects.toThrow(/nope/)
  })

  it('drives the page through its handle: state, mode, fly, fit, select, layer, window, time, spin', async () => {
    const { store, run } = setup()
    await expect(run('globe')({ action: 'state' })).rejects.toThrow(/not open/)
    const { h, calls } = fakeGlobe()
    off = registerGlobeHandle(h, true)
    expect((await run('globe')({ action: 'state' })).camera).toEqual({ lat: 10, lng: 20, altitude: 1.2 })
    expect(await run('globe')({ action: 'mode', mode: 'globe' })).toEqual({ mode: 'globe' })
    expect(await run('globe')({ action: 'fly', lat: 51.5, lng: -0.1, altitude: 0.3 })).toEqual({ ok: true, lat: 51.5, lng: -0.1, altitude: 0.3 })
    expect((await run('globe')({ action: 'fly', lat: 1, lng: 2 })).altitude).toBe(1.2)
    await expect(run('globe')({ action: 'fly', lat: 1 })).rejects.toThrow(/lat and lng/)
    expect(await run('globe')({ action: 'fit' })).toEqual({ ok: true })
    const map = createMap(store, { label: 'M' })
    expect(await run('globe')({ action: 'select', id: map.id })).toEqual({ selected: map.id })
    expect(await run('globe')({ action: 'select' })).toEqual({ selected: null })
    await expect(run('globe')({ action: 'select', id: 'ghost' })).rejects.toThrow(/ghost/)
    expect(await run('globe')({ action: 'layer', layer: 'night' })).toEqual({ layer: 'night' })
    await expect(run('globe')({ action: 'layer' })).rejects.toThrow(/needs a layer/)
    expect(await run('globe')({ action: 'window', from: '2024-01-01T00:00:00Z' })).toMatchObject({ window: { from: '2024-01-01T00:00:00Z' } })
    expect(await run('globe')({ action: 'window' })).toEqual({ window: null })
    expect(await run('globe')({ action: 'time', at: '2024-02-01T00:00:00Z' })).toEqual({ playhead: '2024-02-01T00:00:00Z', playing: false })
    expect(await run('globe')({ action: 'time', play: true })).toEqual({ playhead: null, playing: true })
    expect(await run('globe')({ action: 'time' })).toEqual({ playhead: null, playing: false })
    expect(await run('globe')({ action: 'spin', on: true })).toEqual({ spin: true })
    expect(calls).toEqual([
      'mode:globe',
      'fly:51.5,-0.1,0.3,900',
      'fly:1,2,-,900',
      'fit',
      `select:${map.id}`,
      'select:none',
      'layer:night',
      expect.stringMatching(/^window:2024-01-01T00:00:00Z\.\./),
      'window:none',
      'playhead:2024-02-01T00:00:00Z',
      'play:true',
      'playhead:none',
      'spin:true',
    ])
    // `time` without `play` leaves playing as it was: the last call turned it on.
    const state = await run('globe')({ action: 'state' })
    expect(state).toMatchObject({ mode: 'globe', layer: 'night', playing: true })
    expect(state.playhead).toBeUndefined()
  })
})

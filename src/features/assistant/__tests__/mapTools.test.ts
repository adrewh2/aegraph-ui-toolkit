import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import type { Relationship } from '../../../core/entity/types'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { annotationsOf } from '../../documents/documents'
import { geoOf, isGeo, isMap } from '../../maps/maps'
import { wikiPreviewOf } from '../../maps/wikipedia'
import { createAppTools, type AppHost } from '../tools'

/**
 * The map tools over the fake host, with the network stubbed: Nominatim for
 * geocoding, Wikipedia for enrichment. What they write — map, location,
 * path and area entities, the geo selector on a pinned note, the preview
 * on an enriched place — is checked on the store as well as in the replies.
 */

function host(store: EntityStore): AppHost & { navigated: string[] } {
  const navigated: string[] = []
  return { store, navigated, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/maps' }), confirm: async () => true }
}
const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
}

const EIFFEL = { lat: 48.8584, lng: 2.2945 }
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

/** Nominatim answers one place; Wikipedia answers a search, a pages lookup with coordinates, and an extract. */
function stubNetwork() {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('nominatim.openstreetmap.org/search')) {
      const q = new URL(url).searchParams.get('q') ?? ''
      return /eiffel/i.test(q) ? reply([{ display_name: 'Tour Eiffel, Paris, France', lat: String(EIFFEL.lat), lon: String(EIFFEL.lng), type: 'tourism' }]) : reply([])
    }
    if (url.includes('wikipedia.org/w/api.php')) {
      const p = new URL(url).searchParams
      if (p.get('list') === 'search') return reply({ query: { search: [{ title: 'Eiffel Tower' }, { title: 'Eiffel (crater)' }] } })
      if (p.get('prop')?.startsWith('pageimages')) return reply({ query: { pages: { '1': { title: 'Eiffel Tower', coordinates: [{ lat: EIFFEL.lat, lon: EIFFEL.lng }], thumbnail: { source: 'https://upload.wikimedia.org/eiffel-320.jpg', width: 320, height: 240 } }, '2': { title: 'Eiffel (crater)', coordinates: [{ lat: -20, lon: 100 }] } } } })
      if (p.get('prop') === 'extracts') return reply({ query: { pages: { '1': { title: 'Eiffel Tower', extract: 'The Eiffel Tower is a wrought-iron lattice tower in Paris.' } } } })
    }
    return reply({ error: `unexpected ${url}` }, 500)
  })
  return calls
}

describe('map tools', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates a map and puts a location, a path, an area and a pinned note on it, then reports them as map_state', async () => {
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    const calls = stubNetwork()

    // A map centred on coordinates needs no network; one centred on a name is geocoded.
    const m = await tool(tools, 'create_map')({ label: 'Paris trip', center: '48.8566, 2.3522', zoom: 13, layer: 'terrain', open: true })
    expect(m.center).toEqual({ lat: 48.8566, lng: 2.3522 })
    expect(m.zoom).toBe(13)
    expect(isMap(store.get(m.id))).toBe(true)
    expect(store.get(m.id)!.data.layer).toBe('terrain')
    expect(h.navigated).toEqual([`/maps/${m.id}`])
    expect(calls).toEqual([])
    const named = await tool(tools, 'create_map')({ label: 'By name', center: 'Eiffel Tower' })
    expect(named.center).toEqual(EIFFEL)
    expect(named.zoom).toBe(12)
    expect(calls.length).toBe(1)
    await expect(tool(tools, 'create_map')({ label: 'Nowhere', center: 'Atlantis' })).rejects.toThrow(/Nowhere found/)

    // A location by coordinates, with a time and tags, on the map.
    const loc = await tool(tools, 'add_location')({ map_id: m.id, label: 'Hotel', where: '48.8600, 2.3400', at: '2026-05-01T18:00:00Z', tags: 'stay, paris', description: 'three nights' })
    expect(loc).toMatchObject({ lat: 48.86, lng: 2.34, onMap: m.id })
    const hotel = store.get(loc.id)!
    expect(isGeo(hotel)).toBe(true)
    expect(hotel.type).toBe('location')
    expect(hotel.tags).toEqual(['stay', 'paris'])
    expect(hotel.description).toBe('three nights')
    expect(hotel.data).toMatchObject({ lat: 48.86, lng: 2.34, mapId: m.id, at: '2026-05-01T18:00:00Z', source: 'manual' })
    // By name: geocoded (the cache answers the second lookup), the address kept, the label defaulting to it.
    const tower = await tool(tools, 'add_location')({ map_id: m.id, where: 'Eiffel Tower' })
    expect(tower).toMatchObject({ lat: EIFFEL.lat, lng: EIFFEL.lng, address: 'Tour Eiffel, Paris, France', onMap: m.id })
    expect(store.get(tower.id)!.label).toBe('Tour Eiffel, Paris, France')
    expect(store.get(tower.id)!.data.source).toBe('geocode')
    // From a Google Maps link: the coordinates in the link, the link kept as the url.
    const link = await tool(tools, 'add_location')({ label: 'Louvre', where: 'https://www.google.com/maps/place/Louvre/@48.8606,2.3376,17z' })
    expect(link).toMatchObject({ lat: 48.8606, lng: 2.3376 })
    expect(link.onMap).toBeUndefined()
    expect(store.get(link.id)!.data.url).toMatch(/^https:\/\/www\.google\.com\/maps/)
    // Not a map: refused.
    await expect(tool(tools, 'add_location')({ map_id: loc.id, where: '1, 1' })).rejects.toThrow(/not a map/)

    // A path from "lat, lng" pairs and an area from GeoJSON-order pairs; length and area are computed.
    const path = await tool(tools, 'add_path')({ map_id: m.id, label: 'Walk', points: '48.8600, 2.3400; 48.8584, 2.2945', at: '2026-05-02T09:00:00Z', until: '2026-05-02T11:00:00Z' })
    expect(path).toMatchObject({ points: 2, onMap: m.id })
    expect(path.lengthM).toBeGreaterThan(3000)
    expect(path.lengthM).toBeLessThan(4000)
    const walk = store.get(path.id)!
    expect(walk.type).toBe('path')
    expect(walk.data.geometry).toEqual({ type: 'LineString', coordinates: [[2.34, 48.86], [2.2945, 48.8584]] })
    expect(walk.data).toMatchObject({ at: '2026-05-02T09:00:00Z', until: '2026-05-02T11:00:00Z', source: 'assistant' })
    await expect(tool(tools, 'add_path')({ label: 'Dot', points: '48.86, 2.34' })).rejects.toThrow(/two points/)
    await expect(tool(tools, 'add_path')({ label: 'Bad', points: 'somewhere; 1, 2' })).rejects.toThrow(/Not a "lat, lng" pair/)
    const area = await tool(tools, 'add_area')({ map_id: m.id, label: 'Block', points: [[2.34, 48.86], [2.35, 48.86], [2.35, 48.87], [2.34, 48.87]] })
    expect(area).toMatchObject({ points: 4, onMap: m.id })
    // A 0.01° × 0.01° block at this latitude: roughly 0.73 km × 1.11 km.
    expect(area.areaM2).toBeGreaterThan(700_000)
    expect(area.areaM2).toBeLessThan(900_000)
    const block = store.get(area.id)!
    expect(block.type).toBe('area')
    expect((block.data.geometry as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5)
    await expect(tool(tools, 'add_area')({ label: 'Line', points: [[0, 0], [1, 1]] })).rejects.toThrow(/three points/)

    // A pinned note: an annotation on the map with a geo selector carrying the point, radius and time.
    const note = await tool(tools, 'annotate_map')({ map_id: m.id, comment: 'Meet here', where: '48.8584, 2.2945', radius: 150.4, at: '2026-05-02T10:00:00Z', tags: 'meeting' })
    expect(note).toMatchObject({ lat: EIFFEL.lat, lng: EIFFEL.lng, at: '2026-05-02T10:00:00Z' })
    const notes = annotationsOf(store, m.id)
    expect(notes).toHaveLength(1)
    expect(notes[0].annotation.id).toBe(note.id)
    expect(notes[0].annotation.data.comment).toBe('Meet here')
    expect(notes[0].annotation.tags).toEqual(['meeting'])
    expect(notes[0].selector).toEqual({ kind: 'geo', lat: EIFFEL.lat, lng: EIFFEL.lng, radius: 150, at: '2026-05-02T10:00:00Z' })
    const rel = store.get(notes[0].relationshipId) as Relationship
    expect(rel.type).toBe('annotates')
    expect(rel.target.id).toBe(m.id)
    await expect(tool(tools, 'annotate_map')({ map_id: loc.id, comment: 'x', where: '1, 1' })).rejects.toThrow(/not a map/)

    // The map's state: everything on it, in one reply.
    const st = await tool(tools, 'map_state')({ map_id: m.id })
    expect(st).toMatchObject({ id: m.id, label: 'Paris trip', center: { lat: 48.8566, lng: 2.3522 }, zoom: 13, layer: 'terrain' })
    expect(st.features.map((f: { type: string; label: string }) => [f.type, f.label]).sort()).toEqual([
      ['area', 'Block'],
      ['location', 'Hotel'],
      ['location', 'Tour Eiffel, Paris, France'],
      ['path', 'Walk'],
    ])
    expect(st.features.find((f: { id: string }) => f.id === path.id)).toMatchObject({ lengthM: path.lengthM, at: '2026-05-02T09:00:00Z' })
    expect(st.notes).toEqual([{ id: note.id, comment: 'Meet here', lat: EIFFEL.lat, lng: EIFFEL.lng, radius: 150, at: '2026-05-02T10:00:00Z', until: undefined, tags: ['meeting'] }])
    expect(geoOf(store, store.get(m.id) as never)).toHaveLength(4)
    await expect(tool(tools, 'map_state')({ map_id: loc.id })).rejects.toThrow(/not a map/)
  })

  it('enriches a location with a Wikipedia preview, skipping ones already enriched', async () => {
    const store = new EntityStore()
    const tools = createAppTools(host(store))
    const calls = stubNetwork()
    const m = await tool(tools, 'create_map')({ label: 'Paris' })
    const tower = await tool(tools, 'add_location')({ map_id: m.id, label: 'Eiffel Tower', where: `${EIFFEL.lat}, ${EIFFEL.lng}` })
    const r = await tool(tools, 'enrich_location')({ id: tower.id })
    expect(r).toMatchObject({ enriched: 1, of: 1 })
    expect(r.items[0]).toMatchObject({ id: tower.id, found: true, title: 'Eiffel Tower', image: true })
    const preview = wikiPreviewOf(store.get(tower.id) as never)!
    expect(preview).toMatchObject({ title: 'Eiffel Tower', extract: 'The Eiffel Tower is a wrought-iron lattice tower in Paris.', image: 'https://upload.wikimedia.org/eiffel-320.jpg', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', source: 'wikipedia', lang: 'en' })
    const requests = calls.filter((u) => u.includes('wikipedia.org')).length
    expect(requests).toBeGreaterThanOrEqual(3)
    // Already enriched: nothing is fetched again; by map: the same place, still skipped.
    await tool(tools, 'enrich_location')({ id: tower.id })
    expect(calls.filter((u) => u.includes('wikipedia.org')).length).toBe(requests)
    const byMap = await tool(tools, 'enrich_location')({ map_id: m.id })
    expect(byMap).toMatchObject({ enriched: 1, of: 1 })
    expect(calls.filter((u) => u.includes('wikipedia.org')).length).toBe(requests)
    // map_state shows the preview's title and that it has a picture.
    const st = await tool(tools, 'map_state')({ map_id: m.id })
    expect(st.features[0].preview).toEqual({ title: 'Eiffel Tower', image: true })
    await expect(tool(tools, 'enrich_location')({})).rejects.toThrow(/needs an id or a map_id/)
    await expect(tool(tools, 'enrich_location')({ id: m.id })).rejects.toThrow(/not a location, path or area/)
  }, 20000)

  it('imports GeoJSON and KML onto a map, and exports the map back as either', async () => {
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    stubNetwork()
    const m = await tool(tools, 'create_map')({ label: 'Trip', center: '48.8566, 2.3522', open: false })
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'Louvre', description: 'Museum' }, geometry: { type: 'Point', coordinates: [2.3376, 48.8606] } },
        { type: 'Feature', properties: { name: 'Walk' }, geometry: { type: 'LineString', coordinates: [[2.3376, 48.8606], [2.2945, 48.8584]] } },
        { type: 'Feature', properties: { name: 'Île de la Cité' }, geometry: { type: 'Polygon', coordinates: [[[2.34, 48.855], [2.352, 48.855], [2.352, 48.852], [2.34, 48.852], [2.34, 48.855]]] } },
      ],
    })
    const r = await tool(tools, 'map_import')({ map_id: m.id, text: geojson, tags: ['imported'] })
    expect(r).toMatchObject({ map: m.id, added: 3, locations: 1, paths: 1, areas: 1 })
    const louvre = store.get(r.ids[0])!
    expect(louvre).toMatchObject({ type: 'location', label: 'Louvre', description: 'Museum', tags: ['imported'] })
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Sights</name><Placemark><name>Eiffel Tower</name><Point><coordinates>2.2945,48.8584,0</coordinates></Point></Placemark></Document></kml>`
    const k = await tool(tools, 'map_import')({ map_id: m.id, text: kml })
    expect(k).toMatchObject({ name: 'Sights', added: 1, locations: 1 })
    const state = await tool(tools, 'map_state')({ map_id: m.id })
    expect(state.features.map((f: { label: string }) => f.label).sort()).toEqual(['Eiffel Tower', 'Louvre', 'Walk', 'Île de la Cité'])
    // As files: what the page's Export downloads.
    const t = tools.find((x) => x.name === 'map_state') as BetaRunnableTool
    const out = JSON.parse(String(await t.run(t.parse({ map_id: m.id, format: 'geojson' }))))
    expect(out.type).toBe('FeatureCollection')
    expect(out.features).toHaveLength(4)
    const asKml = String(await t.run(t.parse({ map_id: m.id, format: 'kml' })))
    expect(asKml).toContain('<kml')
    expect(asKml).toContain('Eiffel Tower')
    await expect(tool(tools, 'map_import')({ map_id: m.id, text: '{"type":"FeatureCollection","features":[]}' })).rejects.toThrow(/No features/)
    await expect(tool(tools, 'map_import')({ map_id: m.id })).rejects.toThrow(/text.*url/)
  })
})

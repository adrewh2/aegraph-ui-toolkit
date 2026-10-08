import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { describeSelector } from '../../../core/entity/ids'
import { allGeo, annotateMap, createArea, createLocation, createMap, createPath, createPlace, distanceM, geoAnnotationsOf, geoOf, importFeatures, inWindow, mapsShowing, migrateGeo, parseGeoJson, parseGoogleMapsUrl, parseKml, placesOf, placesToGeoJson, placesToKml, removeFromMap, showOnMap, simplifyCoords, timeSpanOf, type GeoEntity } from '../maps'

describe('Google Maps links', () => {
  it('reads the common shapes', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2922926,17z/data=!3m1!4b1!4m6!3m5!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0!8m2!3d48.8583701!4d2.2944813')).toMatchObject({ lat: 48.8583701, lng: 2.2944813, label: 'Eiffel Tower' })
    expect(parseGoogleMapsUrl('https://www.google.com/maps/@40.7128,-74.006,12z')).toMatchObject({ lat: 40.7128, lng: -74.006, zoom: 12 })
    expect(parseGoogleMapsUrl('https://www.google.com/maps?q=51.5007,-0.1246')).toMatchObject({ lat: 51.5007, lng: -0.1246 })
    expect(parseGoogleMapsUrl('https://maps.google.com/maps/search/35.6762,139.6503')).toMatchObject({ lat: 35.6762, lng: 139.6503 })
    expect(parseGoogleMapsUrl('geo:-33.8688,151.2093')).toMatchObject({ lat: -33.8688, lng: 151.2093 })
    expect(parseGoogleMapsUrl('48.85, 2.29')).toMatchObject({ lat: 48.85, lng: 2.29 })
    expect(parseGoogleMapsUrl('https://maps.app.goo.gl/abc123')).toBeNull()
    expect(parseGoogleMapsUrl('hello')).toBeNull()
    expect(parseGoogleMapsUrl('200, 300')).toBeNull()
  })
})

const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Trip</name>
<Placemark><name>Camp</name><description>Night one</description><TimeStamp><when>2026-07-04T18:00:00Z</when></TimeStamp><Point><coordinates>-121.5,45.3,0</coordinates></Point></Placemark>
<Placemark><name>Route</name><TimeSpan><begin>2026-07-05T08:00:00Z</begin><end>2026-07-05T12:00:00Z</end></TimeSpan><LineString><coordinates>-121.5,45.3,0 -121.4,45.35,0 -121.3,45.4,0</coordinates></LineString></Placemark>
<Placemark><name>Lake</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-121.0,45.0,0 -121.0,45.1,0 -120.9,45.1,0 -120.9,45.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`

describe('KML and GeoJSON', () => {
  it('reads placemarks with times and geometry', () => {
    const { name, features } = parseKml(kml)
    expect(name).toBe('Trip')
    expect(features.map((f) => f.label)).toEqual(['Camp', 'Route', 'Lake'])
    expect(features[0]).toMatchObject({ lat: 45.3, lng: -121.5, description: 'Night one', at: '2026-07-04T18:00:00Z' })
    expect(features[1]).toMatchObject({ at: '2026-07-05T08:00:00Z', until: '2026-07-05T12:00:00Z' })
    expect(features[1].geometry?.type).toBe('LineString')
    expect(features[2].geometry?.type).toBe('Polygon')
    expect(features[2].lat).toBeCloseTo(45.05)
  })
  it('reads GeoJSON and round-trips through the writers', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Trip' })
    const { features } = parseKml(kml)
    for (const f of features) showOnMap(store, map, createPlace(store, { label: f.label, lat: f.lat, lng: f.lng, geometry: f.geometry, at: f.at, until: f.until, description: f.description, source: 'kml' }))
    const note = annotateMap(store, map, { lat: 45.31, lng: -121.49, radius: 150, at: '2026-07-04T20:00:00Z' }, 'Saw the meteor shower', ['sky'])
    const places = placesOf(store, map)
    expect(places).toHaveLength(3)
    const gj = parseGeoJson(placesToGeoJson(places, geoAnnotationsOf(store, map.id)))
    expect(gj.features.map((f) => f.label)).toEqual(['Camp', 'Route', 'Lake', 'Saw the meteor shower'])
    expect(gj.features[3].at).toBe('2026-07-04T20:00:00Z')
    const back = parseKml(placesToKml('Trip', places, geoAnnotationsOf(store, map.id)))
    expect(back.features).toHaveLength(4)
    expect(back.features[1].geometry?.type).toBe('LineString')
    expect(note.data.annotationType).toBe('note')
    expect(describeSelector(geoAnnotationsOf(store, map.id)[0].geo)).toMatch(/45\.31000, -121\.49000 ±150 m @/)
  })
})

describe('time and distance', () => {
  it('spans dated things and filters by window', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'M' })
    const a = createPlace(store, { label: 'A', lat: 0, lng: 0, at: '2026-01-01T00:00:00Z' })
    const b = createPlace(store, { label: 'B', lat: 0, lng: 1 })
    showOnMap(store, map, a)
    showOnMap(store, map, b)
    annotateMap(store, map, { lat: 0, lng: 0.5, at: '2026-02-01T00:00:00Z', until: '2026-03-01T00:00:00Z' }, 'later', [])
    const span = timeSpanOf(placesOf(store, map), geoAnnotationsOf(store, map.id))!
    expect(new Date(span.min).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(new Date(span.max).toISOString()).toBe('2026-03-01T00:00:00.000Z')
    const from = Date.parse('2026-01-15T00:00:00Z')
    const to = Date.parse('2026-02-15T00:00:00Z')
    expect(inWindow(a.data.at, undefined, from, to)).toBe(false)
    expect(inWindow(undefined, undefined, from, to)).toBe(true)
    expect(inWindow('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', from, to)).toBe(true)
    expect(Math.round(distanceM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) / 1000)).toBe(111)
  })
})

describe('locations, paths and areas', () => {
  it('creates the three kinds with a representative point, computed size, and a mapId', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Town' })
    const loc = createLocation(store, { label: 'Station', lat: 51.5, lng: -0.12, mapId: map.id })
    const path = createPath(store, { label: 'Walk', coordinates: [[-0.12, 51.5], [-0.11, 51.5], [-0.11, 51.51]], mapId: map.id })
    const area = createArea(store, { label: 'Park', ring: [[-0.1, 51.5], [-0.09, 51.5], [-0.09, 51.51], [-0.1, 51.51]] })
    expect([loc.type, path.type, area.type]).toEqual(['location', 'path', 'area'])
    expect(path.data.geometry?.type).toBe('LineString')
    expect(path.data.lat).toBe(51.5)
    expect(path.data.lengthM).toBeGreaterThan(1500)
    expect(path.data.lengthM).toBeLessThan(2000)
    expect(area.data.geometry?.type).toBe('Polygon')
    expect((area.data.geometry as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5) // closed
    expect(area.data.lat).toBeCloseTo(51.505)
    expect(area.data.areaM2).toBeGreaterThan(700_000)
    expect(area.data.areaM2).toBeLessThan(800_000)
    expect(geoOf(store, map).map((e) => e.label)).toEqual(['Station', 'Walk'])
    expect(allGeo(store)).toHaveLength(3)
    showOnMap(store, map, store.get(area.id) as GeoEntity)
    expect(geoOf(store, map)).toHaveLength(3)
    removeFromMap(store, map, path.id)
    expect(geoOf(store, map).map((e) => e.label)).toEqual(['Station', 'Park'])
    expect(mapsShowing(store, path.id)).toEqual([])
    expect(() => createPath(store, { label: 'x', coordinates: [[0, 0]] })).toThrow(/two points/)
  })

  it('imports lines and polygons as paths and areas', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Trip' })
    const added = importFeatures(store, map, parseKml(kml).features, 'kml')
    expect(added.map((e) => e.type)).toEqual(['location', 'path', 'area'])
    expect(added.every((e) => e.data.mapId === map.id)).toBe(true)
  })

  it('migrates old places and the shows relationship to the new types and mapId', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Old' })
    // As the old app wrote them: by hand or by an import, before the upgrade shipped.
    const old = { createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' }
    store.upsertMany([
      createEntity({ id: 'p1', type: 'place', label: 'Point', data: { lat: 1, lng: 2 }, meta: { ...old, source: 'user' } }),
      createEntity({ id: 'p2', type: 'place', label: 'Line', data: { lat: 1, lng: 2, geometry: { type: 'LineString', coordinates: [[2, 1], [3, 1]] } }, meta: { ...old, source: 'import:kml' } }),
      createRelationship({ id: `${map.id}-shows-p1`, type: 'shows', source: map.id, target: 'p1', meta: old }),
    ])
    expect(migrateGeo(store)).toBe(2)
    expect(store.get('p1')).toMatchObject({ type: 'location', data: { mapId: map.id } })
    expect(store.get('p2')).toMatchObject({ type: 'path' })
    expect((store.get('p2')!.data as { lengthM: number }).lengthM).toBeGreaterThan(100_000)
    expect(store.relationships().filter((r) => r.type === 'shows')).toHaveLength(0)
    expect(migrateGeo(store)).toBe(0)
  })

  it('leaves a shows relationship that does not start at a map: the word is anyone\'s', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'slice:arch', type: 'diagram', label: 'Architecture' }),
      createEntity({ id: 'mod:app', type: 'module', label: 'app' }),
      createRelationship({ id: 'rel:slice:arch|shows|mod:app', type: 'shows', source: 'slice:arch', target: 'mod:app' }),
    ])
    // The system map demo lost its 543 diagram → entity links this way the first time Maps opened.
    expect(migrateGeo(store)).toBe(0)
    expect(store.get('rel:slice:arch|shows|mod:app')).toBeDefined()
  })

  it('leaves a place of anyone else’s: a gazetteer’s, or one made since the upgrade', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Mine' })
    const old = { createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' }
    store.upsertMany([
      createEntity({ id: 'wd', type: 'place', data: { lat: 48.85, lng: 2.35 }, meta: { ...old, source: 'wikidata' } }),
      createEntity({ id: 'today', type: 'place', data: { lat: 1, lng: 2 }, meta: { source: 'user' } }),
      createRelationship({ id: 'my-link', type: 'shows', source: map.id, target: 'today' }),
    ])
    expect(migrateGeo(store)).toBe(0)
    expect(store.get('wd')?.type).toBe('place')
    expect(store.get('today')?.type).toBe('place')
    expect(store.get('my-link')).toBeDefined()
  })

  it('thins a lasso', () => {
    const pts: [number, number][] = Array.from({ length: 100 }, (_, i) => [Math.cos((i / 100) * Math.PI * 2), Math.sin((i / 100) * Math.PI * 2)])
    const thin = simplifyCoords(pts, 0.05)
    expect(thin.length).toBeGreaterThan(8)
    expect(thin.length).toBeLessThan(40)
    expect(thin[0]).toEqual(pts[0])
  })
})

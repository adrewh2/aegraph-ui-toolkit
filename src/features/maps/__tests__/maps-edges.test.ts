import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { boundsOf, createArea, createLocation, createMap, createPath, distanceM, formatArea, formatDistance, importFeatures, inWindow, parseGeoJson, parseGoogleMapsUrl, parseKml, pathLengthM, ringAreaM2, simplifyCoords, timeSpanOf } from '../maps'

/**
 * The maps data at its edges: Google links of every shape and the ones
 * that give nothing; coordinates at the poles and across the
 * antimeridian; a KML with no placemarks, a folder, a MultiGeometry, a
 * bare LinearRing, CDATA, a span with no end, junk coordinates; GeoJSON
 * of mixed geometries, a feature without properties or geometry, a bare
 * geometry, invalid JSON, the property aliases; a path of one point and
 * an area that does not close; the time filter with open-ended windows
 * and undated things; distances and areas at their thresholds.
 */
describe('Google Maps links at their edges', () => {
  const p = parseGoogleMapsUrl
  it('reads every parameter and path shape, prefers the data blob, takes the poles and the antimeridian, and gives nothing for names, short links, junk and out-of-range coordinates', () => {
    expect(p('https://www.google.com/maps?ll=1.5,2.5&z=3')).toEqual({ lat: 1.5, lng: 2.5, label: undefined })
    expect(p('https://www.google.com/maps/dir/?api=1&destination=-12.5,130.9')).toMatchObject({ lat: -12.5, lng: 130.9 })
    expect(p('https://maps.google.com/?center=10,20&query=30,40')).toMatchObject({ lat: 30, lng: 40 }) // query comes before center in the order tried
    expect(p('https://www.google.com/maps/place/Big+Ben/@51.5007,-0.1246,17z/')).toEqual({ lat: 51.5007, lng: -0.1246, label: 'Big Ben', zoom: 17 })
    expect(p('https://www.google.com/maps/place/Caf%C3%A9+%26+Bar/@1,2,3a,75y')).toEqual({ lat: 1, lng: 2, label: 'Café & Bar', zoom: undefined }) // a street-view suffix is not a zoom
    expect(p('https://www.google.com/maps/place/Somewhere/data=!4m5!3m4!1s0x0:0x0!8m2!3d-45.5!4d170.5?entry=ttu')).toMatchObject({ lat: -45.5, lng: 170.5, label: 'Somewhere' })
    expect(p('https://example.org/?q=48.85,2.29')).toMatchObject({ lat: 48.85, lng: 2.29 }) // any host: the shape is what counts
    expect(p('https://www.google.com/maps/place/Just+A+Name')).toBeNull()
    expect(p('https://www.google.com/maps?q=Eiffel+Tower')).toBeNull()
    expect(p('https://maps.app.goo.gl/x1y2')).toBeNull()
    expect(p('')).toBeNull()
    expect(p('   ')).toBeNull()
    expect(p('geo:90,180')).toEqual({ lat: 90, lng: 180 })
    expect(p('geo:-90,-180?z=5')).toEqual({ lat: -90, lng: -180 })
    expect(p('geo:90.0001,0')).toBeNull()
    expect(p('0,180.0001')).toBeNull()
    expect(p('-90,180')).toEqual({ lat: -90, lng: 180 })
    expect(p('48.85,2.29')).toEqual({ lat: 48.85, lng: 2.29 })
    expect(p('100,5')).toBeNull() // three digits of latitude is not a bare pair
    expect(p('https://www.google.com/maps/@91,0,5z')).toBeNull()
    expect(p('GEO:1,2')).toBeNull()
  })
})

describe('KML at its edges', () => {
  it('no placemarks is an empty list with the document name; placemarks inside folders and MultiGeometries are found (the point wins); a bare LinearRing polygon; CDATA and entities; a span with no end; junk coordinates', () => {
    expect(parseKml('<kml><Document><name>Empty</name></Document></kml>')).toEqual({ name: 'Empty', features: [] })
    expect(parseKml('<kml><Document></Document></kml>')).toEqual({ name: undefined, features: [] })
    expect(() => parseKml('<html>no</html>')).toThrow(/Not a readable KML/)
    expect(() => parseKml('')).toThrow(/Not a readable KML/)
    const kml = `<kml><Document><name>Trip &amp; Co</name><Folder><name>F</name><Folder>
      <Placemark><name><![CDATA[A <b>bold</b> & name]]></name><description><![CDATA[<p>html</p>]]></description>
        <MultiGeometry><LineString><coordinates>1,2 3,4</coordinates></LineString><Point><coordinates>10,20,30</coordinates></Point></MultiGeometry></Placemark>
      <Placemark><Polygon><LinearRing><coordinates>
        0,0
        0,2
        2,2
        2,0
        0,0
      </coordinates></LinearRing></Polygon><TimeSpan><begin>2026-01-01T00:00:00Z</begin></TimeSpan></Placemark>
      <Placemark><name>Junk</name><Point><coordinates>abc</coordinates></Point></Placemark>
      <Placemark><name>Half</name><Point><coordinates>5</coordinates></Point></Placemark>
      <Placemark><name>No geometry</name><address>Somewhere &lt;here&gt;</address></Placemark>
      <Placemark><name>Line of one</name><LineString><coordinates>7,8</coordinates></LineString></Placemark>
    </Folder></Folder></Document></kml>`
    const { name, features } = parseKml(kml)
    expect(name).toBe('Trip & Co')
    expect(features.map((f) => [f.label, f.lng, f.lat, f.geometry?.type ?? 'point'])).toEqual([
      ['A <b>bold</b> & name', 10, 20, 'point'],
      ['Placemark', 1, 1, 'Polygon'],
      ['Line of one', 7, 8, 'LineString'],
    ])
    expect(features[0].description).toBe('<p>html</p>')
    expect(features[1]).toMatchObject({ at: '2026-01-01T00:00:00Z', until: undefined })
    expect(features[1].geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] })
    expect(features[2].geometry).toEqual({ type: 'LineString', coordinates: [[7, 8]] })
    // A placemark with attributes on its tag, and a name that is only whitespace.
    expect(parseKml('<kml><Placemark id="x"><name>   </name><Point><coordinates>1,2</coordinates></Point></Placemark></kml>').features[0].label).toBe('Placemark')
  })
})

describe('GeoJSON at its edges', () => {
  it('mixed geometries keep points, lines and polygons and skip the rest; no properties, no geometry, a bare geometry, numeric names, empty coordinates, the time aliases; invalid JSON throws', () => {
    const fc = {
      type: 'FeatureCollection',
      name: 'Mixed',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: null },
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[1, 2]] }, properties: { name: 'multi' } },
        { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [] }, properties: { name: 'gc' } },
        { type: 'Feature', geometry: null, properties: { name: 'nothing' } },
        { type: 'Feature', properties: { name: 'no key' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { name: 'empty line' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[5, 6]] }, properties: { name: 7, time: '2026-02-02T00:00:00Z', end: '2026-02-03T00:00:00Z', address: 'x' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'empty polygon' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] }, properties: { title: 'T', timestamp: '2026-03-03T00:00:00Z', at: 9 } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [180, -90] }, properties: { name: '' } },
      ],
    }
    const { name, features } = parseGeoJson(JSON.stringify(fc))
    expect(name).toBe('Mixed')
    expect(features.map((f) => [f.label, f.lng, f.lat, f.geometry?.type ?? 'point', f.at, f.until, f.address])).toEqual([
      ['Feature 1', 1, 2, 'point', undefined, undefined, undefined],
      ['7', 5, 6, 'LineString', '2026-02-02T00:00:00Z', '2026-02-03T00:00:00Z', 'x'],
      ['T', 1, 1, 'Polygon', '2026-03-03T00:00:00Z', undefined, undefined], // the closing point is not counted twice
      ['', 180, -90, 'point', undefined, undefined, undefined],
    ])
    expect(parseGeoJson({ type: 'Point', coordinates: [3, 4] }).features).toEqual([{ label: 'Feature 1', lng: 3, lat: 4, description: undefined, at: undefined, until: undefined, address: undefined }])
    expect(parseGeoJson({ type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] } }).features[0].label).toBe('Feature 1')
    expect(parseGeoJson({ type: 'FeatureCollection', features: [] })).toEqual({ name: undefined, features: [] })
    expect(() => parseGeoJson('{not json')).toThrow(SyntaxError)
    expect(() => parseGeoJson({ type: 'FeatureCollection' })).toThrow() // features missing: not a collection
  })
})

describe('shapes, windows and measures', () => {
  it('a path of one point is refused, a repeated point counts, an area closes itself and refuses a triangle of two; imported features of every kind land', () => {
    const store = new EntityStore()
    expect(() => createPath(store, { label: 'p', coordinates: [[1, 2], [NaN, 3]] })).toThrow(/two points/)
    const flat = createPath(store, { label: 'p', coordinates: [[1, 2], [1, 2]] })
    expect(flat.data.lengthM).toBe(0)
    const open = createArea(store, { label: 'a', ring: [[0, 0], [0, 0.001], [0.001, 0.001]] })
    expect(open.data.geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [0, 0.001], [0.001, 0.001], [0, 0]]] })
    const closed = createArea(store, { label: 'a', ring: [[0, 0], [0, 0.001], [0.001, 0.001], [0, 0]] })
    expect(closed.data.areaM2).toBe(open.data.areaM2)
    expect(open.data.areaM2).toBeGreaterThan(6000) // half of a 111 m square
    expect(open.data.areaM2).toBeLessThan(6300)
    expect(() => createArea(store, { label: 'a', ring: [[0, 0], [1, 1], [0, 0]] })).toThrow(/three points/)
    const map = createMap(store, { label: 'M' })
    const added = importFeatures(store, map, parseGeoJson({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0]] }, properties: {} }] }).features, 'test')
    expect(added.map((e) => e.type)).toEqual(['location']) // a one-point line cannot be a path: it lands as a location
    expect(createLocation(store, { label: 'pole', lat: 90, lng: 180 }).data).toMatchObject({ lat: 90, lng: 180 })
  })

  it('the time window: undated things always show, open-ended windows take everything dated, a span overlapping the window shows, an inverted span may not; the span of a set ignores junk dates', () => {
    const t = (s: string) => Date.parse(s)
    expect(inWindow(undefined, undefined, 0, 1)).toBe(true)
    expect(inWindow(undefined, '2026-01-01', 0, 1)).toBe(true) // until without at is undated
    expect(inWindow('2026-06-01', undefined, -Infinity, Infinity)).toBe(true)
    expect(inWindow('2026-06-01', undefined, t('2026-06-01'), t('2026-06-01'))).toBe(true)
    expect(inWindow('2026-06-01', undefined, t('2026-06-02'), t('2026-06-03'))).toBe(false)
    expect(inWindow('2026-06-01', '2026-06-10', t('2026-06-05'), t('2026-06-06'))).toBe(true)
    expect(inWindow('2026-06-01', '2026-06-10', t('2026-06-10'), t('2026-06-20'))).toBe(true)
    expect(inWindow('2026-06-10', '2026-06-01', t('2026-06-05'), t('2026-06-06'))).toBe(false) // an inverted span: its end is before the window
    expect(inWindow('junk', undefined, 0, 1)).toBe(false) // NaN compares false: a thing with an unreadable date never shows
    const place = (at?: string, until?: string) => ({ data: { at, until } }) as never
    expect(timeSpanOf([], [])).toBeNull()
    expect(timeSpanOf([place('junk'), place()], [])).toBeNull()
    expect(timeSpanOf([place('2026-01-01', 'junk'), place('2025-01-01')], [])).toEqual({ min: t('2025-01-01'), max: t('2026-01-01') })
  })

  it('distances at the poles and across the antimeridian, lengths and areas, their formats at the thresholds, bounds across the antimeridian, and simplification of a straight line', () => {
    expect(Math.round(distanceM({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }) / 1000)).toBe(20015)
    expect(distanceM({ lat: 45, lng: 10 }, { lat: 45, lng: 10 })).toBe(0)
    expect(Math.round(distanceM({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 }) / 1000)).toBe(111) // one degree across the line, not 359
    expect(pathLengthM([])).toBe(0)
    expect(pathLengthM([[0, 0]])).toBe(0)
    expect(Math.round(pathLengthM([[0, 0], [1, 0], [0, 0]]) / 1000)).toBe(222) // a degree at the equator is 111.2 km, out and back
    expect(ringAreaM2([[0, 0], [1, 1]])).toBe(0)
    expect(Math.round(ringAreaM2([[0, 0], [0, 1], [1, 1], [1, 0]]) / 1e6)).toBe(12364)
    expect(ringAreaM2([[0, 0], [0, 1], [1, 1], [1, 0]])).toBe(ringAreaM2([[0, 0], [1, 0], [1, 1], [0, 1]])) // either winding
    expect([formatDistance(0), formatDistance(999.4), formatDistance(999.6), formatDistance(1000), formatDistance(9999), formatDistance(10000), formatDistance(123456)]).toEqual(['0 m', '999 m', '1000 m', '1.0 km', '10.0 km', '10 km', '123 km'])
    expect([formatArea(0), formatArea(9999), formatArea(10000), formatArea(999_999), formatArea(1e6), formatArea(1e7)]).toEqual(['0 m²', '9999 m²', '1.0 ha', '100.0 ha', '1.0 km²', '10 km²'])
    expect(boundsOf([])).toBeNull()
    expect(boundsOf([{ lat: 1, lng: 179 }, { lat: -1, lng: -179 }])).toEqual([[-1, -179], [1, 179]]) // naive: the box spans the world rather than the line
    const straight: [number, number][] = Array.from({ length: 50 }, (_, i) => [i, i * 2])
    expect(simplifyCoords(straight, 0.001)).toEqual([[0, 0], [49, 98]])
    expect(simplifyCoords(straight, 0)).toBe(straight)
    expect(simplifyCoords([[0, 0], [1, 1]], 5)).toEqual([[0, 0], [1, 1]])
    expect(simplifyCoords([[0, 0], [5, 5], [0, 0]], 1)).toEqual([[0, 0], [5, 5], [0, 0]]) // a spike out and back is kept
  })
})

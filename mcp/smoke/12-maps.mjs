/**
 * Use case 3, "Map what happened where", end to end over the bridge with
 * no network: a map by coordinates; a location with a time, one from a
 * Google Maps link; a path travelled over a span and an area; a pinned
 * note; the map's state; a location linked to a person and that
 * neighbourhood in the graph; the map page with its pins, path and area
 * drawn. Geocoding and Wikipedia are live services and are not exercised
 * here (see mapTools.test.ts, where they are stubbed). Needs GL=1 (sigma).
 * No declared starting state (b35), and not because it does not need
 * one: put to the dirt test at wake-up 149 it failed — and then failed
 * the same way on a clean profile, with identical numbers. So its last
 * check is broken for a reason that has nothing to do with what any
 * other step leaves behind, and declaring a state would only have hidden
 * that. The note's pin now folds into the cluster with the places and
 * the shapes, so `notes === 1` cannot hold: see b38. Until that check
 * reads what it means, there is nothing to declare here.
 *   GL=1 node mcp/drive.mjs mcp/smoke/12-maps.mjs
 * or `npm run smoke:maps`.
 */
import { check, counted, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  const m = await call('create_map', { label: 'Smoke: Paris, May 2026', center: '48.8566, 2.3522', zoom: 13, open: false })
  check('a map is created at the given centre', m.center?.lat === 48.8566 && m.center?.lng === 2.3522 && m.zoom === 13, JSON.stringify(m))

  // Places: one with a time, one from a Google Maps link (no lookup either way).
  const hotel = await call('add_location', { map_id: m.id, label: 'Hotel', where: '48.8600, 2.3400', at: '2026-05-01T18:00:00Z', until: '2026-05-04T10:00:00Z', tags: 'stay' })
  const louvre = await call('add_location', { map_id: m.id, label: 'Louvre', where: 'https://www.google.com/maps/place/Louvre/@48.8606,2.3376,17z', at: '2026-05-02T14:00:00Z' })
  check('locations land on the map with their times', hotel.onMap === m.id && louvre.onMap === m.id && louvre.lat === 48.8606 && louvre.lng === 2.3376, `${hotel.id}, ${louvre.id}`)
  const walk = await call('add_path', { map_id: m.id, label: 'Walk to the Louvre', points: '48.8600, 2.3400; 48.8606, 2.3376', at: '2026-05-02T13:30:00Z', until: '2026-05-02T14:00:00Z' })
  const quarter = await call('add_area', { map_id: m.id, label: 'The quarter', points: [[2.33, 48.855], [2.345, 48.855], [2.345, 48.865], [2.33, 48.865]] })
  check('a path and an area are measured', walk.points === 2 && walk.lengthM > 100 && walk.lengthM < 400 && quarter.points === 4 && quarter.areaM2 > 1_000_000, `${walk.lengthM} m, ${quarter.areaM2} m²`)
  const note = await call('annotate_map', { map_id: m.id, comment: 'Met Ada here', where: '48.8606, 2.3376', radius: 80, at: '2026-05-02T15:00:00Z', tags: 'meeting' })
  check('a note is pinned with a radius and a time', !!note.id && note.at === '2026-05-02T15:00:00Z', JSON.stringify(note))

  const st = await call('map_state', { map_id: m.id })
  check('map_state lists every feature and note with its shape and time', st.features.length === 4 && st.features.find((f) => f.id === walk.id)?.geometry?.type === 'LineString' && st.features.find((f) => f.id === quarter.id)?.geometry?.type === 'Polygon' && st.features.find((f) => f.id === hotel.id)?.until === '2026-05-04T10:00:00Z' && st.notes.length === 1 && st.notes[0].radius === 80, `${st.features.length} features, ${st.notes.length} note(s)`)

  // Locations are knowledge: link one to a person and look at that neighbourhood in the graph.
  const ada = await call('create_entity', { type: 'person', label: 'Ada (smoke)' })
  await call('create_relationship', { source_id: ada.id, target_id: louvre.id, type: 'visited' })
  await call('open', { page: '/unigraph/2d' })
  await sleep(1500)
  const g = await call('graph_filter', { replace: true, roots: [louvre.id], depth: 1 })
  const rows = await call('graph_query', { selector: {}, values: ['type', 'degree'] })
  check('the location\'s neighbourhood in the graph holds the person and nothing else', g.nodes === 2 && g.edges === 1 && rows.rows.some((r) => r.id === ada.id) && rows.rows.every((r) => r.id === ada.id || r.id === louvre.id), `${g.nodes} nodes: ${rows.rows.map((r) => r.values.type).join(', ')}`)

  // The map page: pins for the places, a numbered pin for the note, the path and the area drawn.
  await call('open', { id: m.id })
  await sleep(2500)
  // Paths and areas carry a pin at their first point / centroid as well, and everything here sits within a few hundred
  // metres, so at this zoom the pins fold into one cluster whose count spans the two places and up to the two shapes.
  const dom = await evaluate(`JSON.stringify({ url: location.pathname, places: document.querySelectorAll('.geo-pin--place').length, clustered: [...document.querySelectorAll('.geo-cluster__count')].map((c) => Number(c.textContent)).reduce((a, b) => a + b, 0), notes: document.querySelectorAll('.geo-pin--note').length, shapes: document.querySelectorAll('path.leaflet-interactive').length, tiles: !!document.querySelector('.leaflet-container') })`).then(JSON.parse)
  check('the map page opens on the map with its pins (or their cluster), note, path and area', dom.url === `/maps/${m.id}` && dom.tiles && dom.places + dom.clustered >= 2 && dom.places + dom.clustered <= 4 && dom.notes === 1 && dom.shapes >= 2, JSON.stringify(dom))

  // Tidy.
  const mine = [note.id, hotel.id, louvre.id, walk.id, quarter.id, ada.id, m.id]
  await call('delete_entities', { ids: mine })
  await tidied(evaluate, mine, wasHolding)
}

import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import type { EntityId } from '../../core/entity/types'
import { globeScene, type GlobeSelection } from '../globe/globeData'
import { getGlobeHandle } from '../globe/globeHandle'
import { createArea, createLocation, createMap, createPath, isMap, type GeoEntity } from '../maps/maps'
import { json, requireEntity } from './toolkit'
import type { AppHost } from './tools'

/**
 * The globe — the Maps page's 3D tab — as tools. `globe` opens it on a
 * set (ids, a map, tags, a time window), reads what it shows, moves the
 * camera, selects, plays through time. `globe_load` is the one call for
 * "put this journey on the globe": it writes the places and legs into the
 * entity system (ES) as location and path entities — dated, tagged, on a
 * map of their own when asked — and opens the globe on exactly them. The
 * data itself comes from the caller (an export, a scrape, a search), not
 * from the app.
 */

export function createGlobeTools(host: AppHost) {
  const { store, navigate } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  /** The Maps page in globe mode: on one map, or on everything. */
  const hrefFor = (sel: { map_id?: string }) => `/maps/${sel.map_id ? encodeURIComponent(sel.map_id) : 'all'}?view=globe`
  const waitForGlobe = async (ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const h = getGlobeHandle()
      if (h) return h
      await new Promise((r) => setTimeout(r, 100))
    }
    return undefined
  }
  const describe = (sel: GlobeSelection) => {
    const sc = globeScene(store, registry(), sel)
    return { entities: sc.entities.length, locations: sc.points.length, paths: sc.entities.filter((e) => e.type === 'path').length, arcs: sc.arcs.length, areas: sc.polygons.length, range: sc.range, center: sc.center }
  }

  const globe = betaTool({
    name: 'globe',
    description:
      'The Maps page in globe mode: Earth in 3D with every location, path and area in the entity system drawn on it — points, great-circle arcs, filled areas — coloured by tag or type; the flat 2D map and the globe share one page, selection, layer and timeline. Actions: open (show the globe: on one map with `map_id`, else everything with a place; `from`/`to` set the time window; `go` navigates, default true), mode (`mode`: 2d or globe, switching in place), state (what is drawn, the selection, the layer, the window, the time range), fly (`lat`, `lng`, `altitude` in globe radii — 0.3 a region, 1 a continent, 2.5 the Earth), fit (frame everything), select (`id`), layer (`layer`: satellite, streets, terrain, night), window (`from`/`to` ISO, or neither to lift it), time (`at` ISO to show that moment, `play` true/false to run through the window, omit both to show the whole window), spin (`on`). To put new data on it, use globe_load.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'mode', 'state', 'fly', 'fit', 'select', 'layer', 'window', 'time', 'spin'] },
        map_id: { type: 'string', description: 'open: only what is on this map' },
        mode: { type: 'string', enum: ['2d', 'globe'], description: 'mode: which stage is in front' },
        from: { type: 'string', description: 'open/window: the time window starts here (ISO)' },
        to: { type: 'string', description: 'open/window: …and ends here (ISO)' },
        go: { type: 'boolean', description: 'open: navigate to the globe (default true)' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        altitude: { type: 'number' },
        id: { type: 'string', description: 'select: the entity' },
        layer: { type: 'string', enum: ['satellite', 'streets', 'terrain', 'night'] },
        at: { type: 'string', description: 'time: ISO moment to show' },
        play: { type: 'boolean' },
        on: { type: 'boolean', description: 'spin: turn the globe slowly' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, map_id, mode, from, to, go, lat, lng, altitude, id, layer, at, play, on }) => {
      if (action === 'open') {
        if (map_id) {
          const m = requireEntity(store, map_id)
          if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
        }
        const href = hrefFor({ map_id })
        if (go !== false) navigate(href)
        const h = go !== false ? await waitForGlobe() : undefined
        if (h) {
          h.setMode('globe')
          if (from || to) h.setWindow({ from: from ?? '1970-01-01T00:00:00Z', to: to ?? new Date().toISOString() })
        }
        return json({ href, opened: !!h, ...describe({ mapId: map_id, from, to }) })
      }
      const h = getGlobeHandle()
      if (!h) throw new Error('The Maps page is not open. Call globe {action:"open"} first.')
      switch (action) {
        case 'state':
          return json(h.getState())
        case 'mode':
          if (!mode) throw new Error('mode needs a mode.')
          h.setMode(mode)
          return json({ mode })
        case 'window':
          h.setWindow(from || to ? { from: from ?? '1970-01-01T00:00:00Z', to: to ?? new Date().toISOString() } : undefined)
          return json({ window: from || to ? { from, to } : null })
        case 'fly':
          if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('fly needs lat and lng.')
          h.flyTo(lat, lng, altitude, 900)
          return json({ ok: true, lat, lng, altitude: altitude ?? 1.2 })
        case 'fit':
          h.fit()
          return json({ ok: true })
        case 'select':
          if (id) requireEntity(store, id)
          h.select(id)
          return json({ selected: id ?? null })
        case 'layer':
          if (!layer) throw new Error('layer needs a layer.')
          h.setLayer(layer)
          return json({ layer })
        case 'time':
          if (play !== undefined) h.play(play)
          if (at !== undefined || play === undefined) h.setPlayhead(at)
          return json({ playhead: at ?? null, playing: !!play })
        case 'spin':
          h.spin(!!on)
          return json({ spin: !!on })
      }
      throw new Error(`Unknown action ${action}`)
    },
  })

  const globeLoad = betaTool({
    name: 'globe_load',
    description:
      'Put a set of places and journeys on the globe in one call: the data goes into the entity system as location and path entities (with times, tags, descriptions and source links), on a new map (`map`) or an existing one (`map_id`) — without either, on no map, among everything — and the Maps page opens on that map in globe mode. Give `locations` (named points) and/or `paths` (journeys: two or more points in order, e.g. a flight from origin to destination, with `at`/`until`). Tags apply to everything loaded; `map` names a new map to hold them (or `map_id` an existing one). The tool does not fetch data — bring the coordinates from the export, page or search you have; a flight is a two-point path with the departure time as `at` and the arrival as `until`. Returns the ids created and what is now drawn.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A name for the set — the globe tab and the pick (e.g. "N628TS flights, 2025")' },
        map: { type: 'string', description: 'Create a map with this name to hold everything loaded' },
        map_id: { type: 'string', description: 'Or put everything on this existing map' },
        tags: { type: 'string', description: 'Comma-separated tags for everything loaded' },
        source: { type: 'string', description: 'Where the data came from, recorded on each entity (a site, a file, a dataset)' },
        locations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, at: { type: 'string' }, until: { type: 'string' }, description: { type: 'string' }, tags: { type: 'string' }, url: { type: 'string' }, address: { type: 'string' } },
            required: ['label', 'lat', 'lng'],
            additionalProperties: false,
          },
        },
        paths: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, minItems: 2, description: '[[lng, lat], …] in order (GeoJSON order)' },
              at: { type: 'string', description: 'ISO start (departure)' },
              until: { type: 'string', description: 'ISO end (arrival)' },
              description: { type: 'string' },
              tags: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['label', 'points'],
            additionalProperties: false,
          },
        },
        areas: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, ring: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, minItems: 3, description: '[[lng, lat], …] around the area' }, description: { type: 'string' }, tags: { type: 'string' } },
            required: ['label', 'ring'],
            additionalProperties: false,
          },
        },
        go: { type: 'boolean', description: 'Open the globe afterwards (default true)' },
      },
      required: ['label'],
      additionalProperties: false,
    } as const,
    run: async ({ label, map, map_id, tags, source, locations, paths, areas, go }) => {
      if (!locations?.length && !paths?.length && !areas?.length) throw new Error('Give locations, paths or areas to load.')
      const common = parseTags(tags ?? '')
      // maps.ts records data.source as given and meta.source as `import:<source>` for anything but manual/drawn.
      const src = source ?? 'assistant'
      let mapId: EntityId | undefined
      const created: GeoEntity[] = []
      store.transaction(() => {
        if (map_id) {
          const m = requireEntity(store, map_id)
          if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
          mapId = m.id
        } else if (map) {
          const first = locations?.[0] ?? (paths?.[0] ? { lat: paths[0].points[0][1], lng: paths[0].points[0][0] } : undefined)
          mapId = createMap(store, { label: map, center: first ? { lat: first.lat, lng: first.lng } : undefined, tags: common, source }).id
        }
        for (const l of locations ?? []) created.push(createLocation(store, { label: l.label, lat: l.lat, lng: l.lng, at: l.at, until: l.until, description: l.description, tags: [...common, ...parseTags(l.tags ?? '')], url: l.url, address: l.address, mapId, source: src }))
        for (const p of paths ?? []) created.push(createPath(store, { label: p.label, coordinates: p.points as [number, number][], at: p.at, until: p.until, description: p.description, tags: [...common, ...parseTags(p.tags ?? '')], url: p.url, mapId, source: src }))
        for (const a of areas ?? []) created.push(createArea(store, { label: a.label, ring: a.ring as [number, number][], description: a.description, tags: [...common, ...parseTags(a.tags ?? '')], mapId, source: src }))
      })
      const ids = created.map((e) => e.id)
      const href = hrefFor({ map_id: mapId })
      if (go !== false) navigate(href)
      const h = go !== false ? await waitForGlobe() : undefined
      if (h) {
        h.setMode('globe')
        setTimeout(() => h.fit(), 600)
      }
      return json({ created: ids.length, ids: ids.slice(0, 200), map: mapId ? { id: mapId, label: displayLabel(store.get(mapId)!) } : null, href, opened: !!h, ...describe({ ids }), label })
    },
  })

  return [globe, globeLoad]
}

import { Hexagon, Map as MapIcon, MapPin, Route } from 'lucide-react'
import { createEntity } from '../../core/entity/entity'
import { defineEntityType, type EntityTypeDef } from '../../core/entity/schema'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityData, type EntityId, type Relationship, type Selector } from '../../core/entity/types'
import { externalServicesAllowed, requireExternalServices } from '../account/settings'
import { annotationsOf, createAnnotation, type TargetAnnotation } from '../../core/resources/annotations'
import { madeBeforeUpgrades } from '../../core/resources/legacy'

/**
 * Maps and what is on them. A map is a resource: a saved view (centre,
 * zoom, base layer). What it shows are knowledge entities of three kinds —
 * a **location** (a point), a **path** (a line) and an **area** (a
 * polygon) — each with a representative `lat`/`lng`, so any of them can be
 * linked to anything else, and a `mapId` naming the map it belongs to
 * (absent: on no map in particular; the Maps home shows all of them at
 * once). Annotations on a map carry a `geo` selector — a point, optionally
 * at a time — so a note can say "here, then".
 */

export const MAP_TYPE = 'map'
export const LOCATION_TYPE = 'location'
export const PATH_TYPE = 'path'
export const AREA_TYPE = 'area'
export const GEO_TYPES = [LOCATION_TYPE, PATH_TYPE, AREA_TYPE] as const
export type GeoType = (typeof GEO_TYPES)[number]
/** The old name of `location`, and the old map → place relationship; both migrate on load. */
export const LEGACY_PLACE_TYPE = 'place'
export const LEGACY_SHOWS = 'shows'

export type BaseLayer = 'streets' | 'satellite' | 'terrain'
/** How a map draws its locations: `points` — every one a dot on the engine's canvas, however many; `bubbles` — a pin each, piling into counted bubbles where they crowd. */
export type PinMode = 'points' | 'bubbles'
/** Without a choice on the map, a map of this many locations or more draws points; fewer draws pins. */
export const POINTS_FROM = 2000
export const pinModeFor = (choice: PinMode | undefined, locations: number): PinMode => choice ?? (locations >= POINTS_FROM ? 'points' : 'bubbles')

export interface LatLng {
  lat: number
  lng: number
}

export interface MapData extends EntityData {
  center: LatLng
  zoom: number
  layer: BaseLayer
  /** How locations are drawn (see PinMode); unset: points from POINTS_FROM locations up, pins below. */
  pins?: PinMode
  /** Where it came from, when imported (a KML file name, a Google Maps link…). */
  source?: string
  /**
   * How the map page's table opens: `types` — the kinds (`location`, `path`, `area`) or types shown by default on
   * the All tab (the rest are there to tick back in); `sort` — the order rows come in; `columns` / `hidden` — the
   * All tab's columns, on top of the types' own layouts. Set by an importer or the `table_layout` tool.
   */
  table?: { types?: string[]; sort?: { key: string; dir: 'asc' | 'desc' }; columns?: string[]; hidden?: string[] }
}

export type Geometry = { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] } | { type: 'Polygon'; coordinates: [number, number][][] }

export interface GeoData extends EntityData {
  /** A representative point: the location itself, a path's start, an area's centroid. */
  lat: number
  lng: number
  /** The shape, for paths (LineString) and areas (Polygon), GeoJSON style ([lng, lat] pairs). Locations may carry a Point. */
  geometry?: Geometry
  /** The map this belongs to. Absent: on no particular map. */
  mapId?: EntityId
  address?: string
  /** When it matters: a visit, an event, a journey. */
  at?: string
  until?: string
  /** Where the record came from: `google-maps`, `kml`, `geojson`, `geocode`, `manual`, `drawn`. */
  source?: string
  /** The original link, when there was one. */
  url?: string
}
/** @deprecated the old name; a location's data. */
export type PlaceData = GeoData

export type MapEntity = Entity<MapData>
export type GeoEntity = Entity<GeoData>
/** @deprecated the old name of GeoEntity. */
export type PlaceEntity = GeoEntity

const hasPoint = (e: AnyEntity | undefined) => !!e && !isRelationship(e) && typeof e.data.lat === 'number' && typeof e.data.lng === 'number'
export const isMap = (e: AnyEntity | undefined): e is MapEntity => !!e && !isRelationship(e) && e.type === MAP_TYPE && !!(e.data as MapData).center
export const isLocation = (e: AnyEntity | undefined): e is GeoEntity => hasPoint(e) && e!.type === LOCATION_TYPE
export const isPath = (e: AnyEntity | undefined): e is GeoEntity => hasPoint(e) && e!.type === PATH_TYPE
export const isArea = (e: AnyEntity | undefined): e is GeoEntity => hasPoint(e) && e!.type === AREA_TYPE
/** A location, path or area. */
export const isGeo = (e: AnyEntity | undefined): e is GeoEntity => hasPoint(e) && (GEO_TYPES as readonly string[]).includes(e!.type)

/**
 * Which geographic kind a type is, subtypes included: a `flight` whose
 * definition says `parent: 'path'` is a path here, an `airport` under
 * `location` a location. Read off the store's own type definitions
 * (`schema:type` entities), so it needs no registry; the chain is
 * followed a few steps and cached per store version.
 */
const kindCache = new WeakMap<EntityStore, { version: number; kinds: Map<string, GeoType | null> }>()
export function geoKindOf(store: EntityStore, type: string): GeoType | undefined {
  if ((GEO_TYPES as readonly string[]).includes(type)) return type as GeoType
  let c = kindCache.get(store)
  if (!c || c.version !== store.version) kindCache.set(store, (c = { version: store.version, kinds: new Map() }))
  const hit = c.kinds.get(type)
  if (hit !== undefined) return hit ?? undefined
  let cur: string | undefined = type
  let kind: GeoType | null = null
  for (let i = 0; i < 8 && cur; i++) {
    const def = store.get(`type:${cur}`)
    const parent = def && typeof def.data.parent === 'string' ? (def.data.parent as string) : undefined
    if (parent && (GEO_TYPES as readonly string[]).includes(parent)) {
      kind = parent as GeoType
      break
    }
    cur = parent
  }
  c.kinds.set(type, kind)
  return kind ?? undefined
}
/** `isGeo` that also accepts subtypes of location, path and area defined in the store. */
export const isGeoIn = (store: EntityStore, e: AnyEntity | undefined): e is GeoEntity => hasPoint(e) && !!geoKindOf(store, e!.type)
/** @deprecated use isLocation / isGeo. */
export const isPlace = isLocation

export const mapType: EntityTypeDef = defineEntityType({
  type: MAP_TYPE,
  category: 'resource',
  label: 'Map',
  pluralLabel: 'Maps',
  icon: MapIcon,
  color: '#0e7490',
  description: 'A map: a saved view over places, with notes pinned to points — optionally at a time. OpenStreetMap tiles; imports Google Maps links, KML (Google Earth) and GeoJSON.',
  fields: [
    { key: 'data.layer', label: 'Layer', kind: 'text', editable: true, width: 90, options: [{ value: 'streets', label: 'Streets' }, { value: 'satellite', label: 'Satellite' }, { value: 'terrain', label: 'Terrain' }] },
    { key: 'data.zoom', label: 'Zoom', kind: 'number', width: 70 },
    { key: 'data.center', label: 'Centre', kind: 'json', width: 160, format: (v) => (v && typeof v === 'object' ? `${(v as LatLng).lat.toFixed(4)}, ${(v as LatLng).lng.toFixed(4)}` : '') },
    { key: 'data.source', label: 'Source', kind: 'text', width: 140, hidden: true },
  ],
})

const GEO_FIELDS = [
  { key: 'data.mapId', label: 'Map', kind: 'ref', width: 160 },
  { key: 'data.at', label: 'When', kind: 'datetime', editable: true, width: 150 },
  { key: 'data.until', label: 'Until', kind: 'datetime', editable: true, width: 150, hidden: true },
  { key: 'data.url', label: 'Link', kind: 'url', editable: true, width: 200, hidden: true },
  { key: 'data.source', label: 'Source', kind: 'text', width: 120, hidden: true },
] as const

export const locationType: EntityTypeDef = defineEntityType({
  type: LOCATION_TYPE,
  category: 'knowledge',
  label: 'Location',
  pluralLabel: 'Locations',
  icon: MapPin,
  color: '#e76f51',
  description: 'A point on Earth: latitude, longitude, an address, and optionally when it mattered. Belongs to a map, or to none.',
  fields: [
    { key: 'data.lat', label: 'Latitude', kind: 'number', editable: true, required: true, width: 110 },
    { key: 'data.lng', label: 'Longitude', kind: 'number', editable: true, required: true, width: 110 },
    { key: 'data.address', label: 'Address', kind: 'text', editable: true, width: 260 },
    ...GEO_FIELDS,
  ],
})

export const pathType: EntityTypeDef = defineEntityType({
  type: PATH_TYPE,
  category: 'knowledge',
  label: 'Path',
  pluralLabel: 'Paths',
  icon: Route,
  color: '#2a6f97',
  description: 'A line on Earth — a route, a journey, a border — as an ordered list of points, and optionally when it was travelled. Drawn on a map or imported from KML / GeoJSON.',
  fields: [
    { key: 'data.geometry', label: 'Points', kind: 'json', width: 90, format: (v) => (v && typeof v === 'object' && 'coordinates' in (v as object) ? String((v as { coordinates: unknown[] }).coordinates.length) : '') },
    { key: 'data.lengthM', label: 'Length', kind: 'number', width: 100, format: (v) => (typeof v === 'number' ? formatDistance(v) : '') },
    ...GEO_FIELDS,
  ],
})

export const areaType: EntityTypeDef = defineEntityType({
  type: AREA_TYPE,
  category: 'knowledge',
  label: 'Area',
  pluralLabel: 'Areas',
  icon: Hexagon,
  color: '#7b4fa3',
  description: 'A region on Earth — a polygon: a site, a district, a zone — and optionally when it mattered. Drawn with the lasso on a map or imported from KML / GeoJSON.',
  fields: [
    { key: 'data.geometry', label: 'Points', kind: 'json', width: 90, format: (v) => (v && typeof v === 'object' && 'coordinates' in (v as object) ? String(((v as { coordinates: unknown[][] }).coordinates[0] ?? []).length) : '') },
    { key: 'data.areaM2', label: 'Area', kind: 'number', width: 100, format: (v) => (typeof v === 'number' ? formatArea(v) : '') },
    ...GEO_FIELDS,
  ],
})
/** @deprecated the old name. */
export const placeType = locationType

// ── Creation ──────────────────────────────────────────────────────────

export function createMap(store: EntityStore, init: { label?: string; center?: LatLng; zoom?: number; layer?: BaseLayer; pins?: PinMode; tags?: string[]; source?: string }): MapEntity {
  const e = createEntity<MapData>({
    type: MAP_TYPE,
    label: init.label?.trim() || 'Untitled map',
    tags: init.tags,
    data: { center: init.center ?? { lat: 20, lng: 0 }, zoom: init.zoom ?? (init.center ? 12 : 2), layer: init.layer ?? 'streets', ...(init.pins ? { pins: init.pins } : {}), ...(init.source ? { source: init.source } : {}) },
    meta: { source: 'user', accessedAt: new Date().toISOString() },
  })
  store.upsert(e)
  return e
}

export interface GeoInit {
  label?: string
  address?: string
  at?: string
  until?: string
  tags?: string[]
  source?: string
  url?: string
  description?: string
  id?: EntityId
  /** The map it belongs to. */
  mapId?: EntityId
}

function geoEntity(store: EntityStore, type: GeoType, point: LatLng, geometry: Geometry | undefined, init: GeoInit, extra: Partial<GeoData> = {}): GeoEntity {
  const data: GeoData = { lat: round(point.lat), lng: round(point.lng), ...extra }
  if (geometry) data.geometry = geometry
  if (init.mapId) data.mapId = init.mapId
  if (init.address) data.address = init.address
  if (init.at) data.at = init.at
  if (init.until) data.until = init.until
  if (init.url) data.url = init.url
  data.source = init.source ?? 'manual'
  const e = createEntity<GeoData>({ id: init.id, type, label: init.label?.trim() || init.address || `${data.lat}, ${data.lng}`, description: init.description, tags: init.tags, data, meta: { source: init.source && init.source !== 'manual' && init.source !== 'drawn' ? `import:${init.source}` : 'user' } })
  store.upsert(e)
  return e
}

export function createLocation(store: EntityStore, init: GeoInit & { lat: number; lng: number; geometry?: Geometry }): GeoEntity {
  return geoEntity(store, LOCATION_TYPE, init, init.geometry, init)
}
/** @deprecated use createLocation (a Point), createPath or createArea. */
export const createPlace = createLocation

/** A path from its points ([lng, lat] pairs, at least two). */
export function createPath(store: EntityStore, init: GeoInit & { coordinates: [number, number][] }): GeoEntity {
  const cs = cleanCoords(init.coordinates)
  if (cs.length < 2) throw new Error('A path needs at least two points.')
  return geoEntity(store, PATH_TYPE, { lat: cs[0][1], lng: cs[0][0] }, { type: 'LineString', coordinates: cs }, { ...init, label: init.label?.trim() || 'Path' }, { lengthM: Math.round(pathLengthM(cs)) })
}

/** An area from its outer ring ([lng, lat] pairs, at least three; closed automatically). */
export function createArea(store: EntityStore, init: GeoInit & { ring: [number, number][] }): GeoEntity {
  const ring = closeRing(cleanCoords(init.ring))
  if (ring.length < 4) throw new Error('An area needs at least three points.')
  const c = centroid(ring.slice(0, -1))
  return geoEntity(store, AREA_TYPE, { lat: c[1], lng: c[0] }, { type: 'Polygon', coordinates: [ring] }, { ...init, label: init.label?.trim() || 'Area' }, { areaM2: Math.round(ringAreaM2(ring)) })
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const cleanCoords = (cs: [number, number][]) => cs.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [round(c[0]), round(c[1])] as [number, number])
const closeRing = (cs: [number, number][]) => (cs.length && (cs[0][0] !== cs[cs.length - 1][0] || cs[0][1] !== cs[cs.length - 1][1]) ? [...cs, cs[0]] : cs)

/** Put something on a map (its `mapId`). */
export function showOnMap(store: EntityStore, map: MapEntity, e: GeoEntity) {
  if (e.data.mapId === map.id) return
  store.update(e.id, { data: { ...e.data, mapId: map.id } })
}

/** Take something off a map: it stays in the workspace, on no map. */
export function removeFromMap(store: EntityStore, map: MapEntity, id: EntityId) {
  const e = store.get(id)
  if (!isGeo(e) || e.data.mapId !== map.id) return
  const data = { ...e.data }
  delete data.mapId
  store.update(id, { data })
}

/** Everything on a map: its locations, paths and areas. Kept per map with the `allGeo` it was filtered from. */
export function geoOf(store: EntityStore, map: MapEntity): GeoEntity[] {
  const all = allGeo(store)
  let byMap = geoOfCache.get(all)
  if (!byMap) geoOfCache.set(all, (byMap = new Map()))
  let out = byMap.get(map.id)
  if (!out) {
    out = []
    const id = map.id
    for (let i = 0; i < all.length; i++) if (all[i].data.mapId === id) out.push(all[i])
    byMap.set(id, out)
  }
  return out
}
const geoOfCache = new WeakMap<GeoEntity[], Map<EntityId, GeoEntity[]>>()
/** @deprecated use geoOf. */
export const placesOf = geoOf

/** The map something belongs to (a list, for callers that showed things on several maps). */
export function mapsShowing(store: EntityStore, id: EntityId): MapEntity[] {
  const e = store.get(id)
  const m = isGeo(e) && e.data.mapId ? store.get(e.data.mapId) : undefined
  return isMap(m) ? [m] : []
}

/** What a pin's hover card shows: pictures from the thing itself and what it links to, a paragraph when it has none of its own, and a line of facts. */
export interface GeoPreview {
  images: string[]
  /** A fetched summary (Wikipedia), shown when the entity has no description of its own. */
  extract?: string
  /** How many entities link to it, images aside. */
  links: number
}

const isImageUrl = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('data:image/') || /^https?:\/\//.test(v))
/** Pictures an entity carries: its own image (uploads, RDF depictions), a page's screenshot, a video's poster, an annotation's still. */
function imagesOf(e: AnyEntity): string[] {
  if (isRelationship(e)) return []
  const d = e.data as Record<string, unknown>
  const out: string[] = []
  for (const k of ['src', 'imageUrl', 'image', 'thumbnailUrl', 'thumbnail', 'depiction', 'screenshotUrl']) if (isImageUrl(d[k])) out.push(d[k] as string)
  return out
}

/** The hover card's content for a location, path or area: up to `max` pictures, its own first, then its neighbours'. */
export function geoPreview(store: EntityStore, e: GeoEntity, max = 3): GeoPreview {
  // A fetched preview (`data.preview`, see wikipedia.ts) leads: its photo is the one chosen for this place.
  const fetched = e.data.preview && typeof e.data.preview === 'object' ? (e.data.preview as { image?: string; extract?: string }) : undefined
  const images = [...(isImageUrl(fetched?.image) ? [fetched!.image!] : []), ...imagesOf(e)]
  let links = 0
  for (const { entity } of store.neighbors(e.id)) {
    if (isMap(entity)) continue
    const own = imagesOf(entity)
    if (own.length) images.push(own[0])
    else links++
  }
  return { images: [...new Set(images)].slice(0, max), extract: fetched?.extract, links }
}

export const allMaps = (store: EntityStore): MapEntity[] => store.ofType(MAP_TYPE).filter(isMap)
/**
 * Every location, path and area in the workspace — and every entity of a subtype of those — with a point, on a
 * map or not. Computed once per data version and scope and handed to every caller (the picker's counts, the
 * workbench, the table, the pins): a city's worth of trees is walked once when it changes, not once per component
 * per render. The kind is decided per type, the point checked per entity — nothing else is read.
 */
export function allGeo(store: EntityStore): GeoEntity[] {
  let c = allGeoCache.get(store)
  if (c && c.dataVersion === store.dataVersion && c.scope === store.scope) return c.list
  const list: GeoEntity[] = []
  // The three kinds first, then their subtypes by name — the order the table shows before a sort.
  const types = [...GEO_TYPES, ...store.types().filter((t) => !(GEO_TYPES as readonly string[]).includes(t) && geoKindOf(store, t))]
  for (const t of types) {
    const ofType = store.ofType(t)
    for (let i = 0; i < ofType.length; i++) {
      const e = ofType[i]
      if (hasPoint(e)) list.push(e as GeoEntity)
    }
  }
  // The same entities as last time — a write elsewhere in the store (an autosave's commit, a note) moved the
  // version, not the pins — keep the array: everything downstream (the table's sort, the pin index, the timeline)
  // keys on its identity, and a city's worth of it is not to be redone for a commit.
  if (c && c.scope === store.scope && sameList(c.list, list)) {
    c.dataVersion = store.dataVersion
    return c.list
  }
  allGeoCache.set(store, { dataVersion: store.dataVersion, scope: store.scope, list })
  return list
}
const sameList = (a: GeoEntity[], b: GeoEntity[]) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const allGeoCache = new WeakMap<EntityStore, { dataVersion: number; scope: EntityId | null; list: GeoEntity[] }>()
export const allLocations = (store: EntityStore): GeoEntity[] => store.ofType(LOCATION_TYPE).filter(isLocation)
/** @deprecated use allGeo. */
export const allPlaces = allGeo

/** The points of a shape as {lat, lng}, for fitting and hit-testing. */
export function pointsOf(e: GeoEntity): LatLng[] {
  const g = e.data.geometry
  if (g?.type === 'LineString') return g.coordinates.map(([lng, lat]) => ({ lat, lng }))
  if (g?.type === 'Polygon') return (g.coordinates[0] ?? []).map(([lng, lat]) => ({ lat, lng }))
  return [{ lat: e.data.lat, lng: e.data.lng }]
}

/**
 * A `place` as the old app made it (`createPlace` before locations): a point
 * (`lat`/`lng` numbers), made by hand (`user`) or by an import (`import:…`),
 * before the upgrade shipped. `place` is an ordinary word — a gazetteer, a
 * knowledge graph — and a place of anyone else's is left alone.
 */
export const isLegacyPlace = (e: AnyEntity): boolean =>
  !isRelationship(e) && e.type === LEGACY_PLACE_TYPE && typeof e.data.lat === 'number' && typeof e.data.lng === 'number' && (e.meta?.source === 'user' || !!e.meta?.source?.startsWith('import:')) && madeBeforeUpgrades(e)

/** The old map → place link: `shows`, from a map, under the id `showOnMap` gave it (`<map>-shows-<place>`), made before the upgrade. */
const isLegacyShows = (store: EntityStore, r: Relationship): boolean => r.type === LEGACY_SHOWS && r.id === `${r.source.id}-shows-${r.target.id}` && isMap(store.get(r.source.id)) && madeBeforeUpgrades(r)

/**
 * Upgrades for data written before locations, paths and areas: `place`
 * entities become locations (paths and areas when they carried a line or a
 * polygon), and the old map → place `shows` relationship becomes `mapId`.
 * Only what the old app wrote is touched (`isLegacyPlace`, `isLegacyShows`):
 * `shows` is an ordinary word, and a project may use it for anything (a
 * diagram shows the things in it) — those are not a map's, and they stay.
 * Idempotent; returns how many entities changed.
 */
export function migrateGeo(store: EntityStore): number {
  let changed = 0
  const legacy = store.library.ofType(LEGACY_PLACE_TYPE).filter(isLegacyPlace)
  const rels = store.library.relationships().filter((r) => isLegacyShows(store, r))
  if (!legacy.length && !rels.length) return 0
  store.transaction(() => {
    const mapOf = new Map<EntityId, EntityId>()
    for (const r of rels) mapOf.set(r.target.id, r.source.id)
    for (const e of legacy) {
      if (isRelationship(e)) continue
      const g = e.data.geometry as Geometry | undefined
      const type: GeoType = g?.type === 'LineString' ? PATH_TYPE : g?.type === 'Polygon' ? AREA_TYPE : LOCATION_TYPE
      const data = { ...e.data } as GeoData
      const mapId = mapOf.get(e.id)
      if (mapId) data.mapId = mapId
      if (type === PATH_TYPE && g?.type === 'LineString') data.lengthM = Math.round(pathLengthM(g.coordinates))
      if (type === AREA_TYPE && g?.type === 'Polygon') data.areaM2 = Math.round(ringAreaM2(g.coordinates[0]))
      store.update(e.id, { type, data })
      changed++
    }
    for (const [id, mapId] of mapOf) {
      const e = store.get(id)
      if (isGeo(e) && e.data.mapId !== mapId) {
        store.update(id, { data: { ...e.data, mapId } })
        changed++
      }
    }
    if (rels.length) store.remove(rels.map((r) => r.id), { cascade: false })
  })
  return changed
}

// ── Annotations pinned to the map ─────────────────────────────────────

export interface GeoAnnotation extends TargetAnnotation {
  geo: Extract<Selector, { kind: 'geo' }>
}

/** Notes pinned on the map itself (a `geo` selector), in time order (undated last). */
export function geoAnnotationsOf(store: EntityStore, mapId: EntityId): GeoAnnotation[] {
  return annotationsOf(store, mapId)
    .filter((a): a is GeoAnnotation => a.selector?.kind === 'geo')
    .map((a) => ({ ...a, geo: a.selector as GeoAnnotation['geo'] }))
    .sort((a, b) => (a.geo.at ?? '￿').localeCompare(b.geo.at ?? '￿'))
}

export function annotateMap(store: EntityStore, map: MapEntity, geo: Omit<GeoAnnotation['geo'], 'kind'>, comment: string, tags: string[] = [], source = 'user') {
  const selector: Selector = { kind: 'geo', lat: round(geo.lat), lng: round(geo.lng), ...(geo.radius ? { radius: Math.round(geo.radius) } : {}), ...(geo.at ? { at: geo.at } : {}), ...(geo.until ? { until: geo.until } : {}) }
  return createAnnotation(store, map.id, selector, { comment, tags, annotationType: 'note', source, data: { pageUrl: googleMapsUrl(geo) } })
}

/** Move a pinned note. */
export function moveGeoAnnotation(store: EntityStore, a: GeoAnnotation, to: LatLng) {
  const r = store.get(a.relationshipId)
  if (!r || !isRelationship(r)) return
  store.update<Relationship>(r.id, { target: { id: r.target.id, selector: { ...a.geo, lat: round(to.lat), lng: round(to.lng) } } })
}

// ── Time ──────────────────────────────────────────────────────────────

/** Everything on a map that carries a time, so a timeline can span it. */
export function timeSpanOf(places: PlaceEntity[], notes: GeoAnnotation[]): { min: number; max: number } | null {
  // A loop, not Math.min(...ts): a hundred thousand dated flights would overflow the call stack as arguments — and
  // no array per place either; most of a city's worth of trees carry no date at all.
  let min = Infinity
  let max = -Infinity
  const take = (t: string | undefined) => {
    if (!t) return
    const v = Date.parse(t)
    if (!Number.isFinite(v)) return
    if (v < min) min = v
    if (v > max) max = v
  }
  for (let i = 0; i < places.length; i++) {
    const d = places[i].data
    take(d.at)
    take(d.until)
  }
  for (const n of notes) {
    take(n.geo.at)
    take(n.geo.until)
  }
  return min <= max ? { min, max } : null
}

/** Whether something dated falls inside [from, to]; undated things always show. */
export function inWindow(at: string | undefined, until: string | undefined, from: number, to: number): boolean {
  if (!at) return true
  const a = Date.parse(at)
  const b = until ? Date.parse(until) : a
  return b >= from && a <= to
}

// ── Links ─────────────────────────────────────────────────────────────

export const googleMapsUrl = (p: LatLng) => `https://www.google.com/maps?q=${p.lat},${p.lng}`
export const googleEarthUrl = (p: LatLng) => `https://earth.google.com/web/@${p.lat},${p.lng},0a,1000d,35y,0h,0t,0r`
export const osmUrl = (p: LatLng, zoom = 16) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=${zoom}/${p.lat}/${p.lng}`

/**
 * Coordinates from a Google Maps link. Handles `…/maps/place/<name>/@lat,lng,zoom`,
 * `…/maps?q=lat,lng`, `…/maps/@lat,lng`, `…/maps/search/lat,lng`, `geo:lat,lng`,
 * `!3dlat!4dlng` data blobs, and a bare `lat, lng`. Short `maps.app.goo.gl` links
 * need resolving first (the browser can't follow them), so they return null.
 */
export function parseGoogleMapsUrl(input: string): { lat: number; lng: number; label?: string; zoom?: number } | null {
  const s = input.trim()
  if (!s) return null
  const bare = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s)
  if (bare) return valid({ lat: Number(bare[1]), lng: Number(bare[2]) })
  const geo = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s)
  if (geo) return valid({ lat: Number(geo[1]), lng: Number(geo[2]) })
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  const label = /\/maps\/place\/([^/@]+)/.exec(url.pathname)?.[1]
  const name = label ? decodeURIComponent(label.replace(/\+/g, ' ')) : undefined
  // The most precise position is the `!3d<lat>!4d<lng>` pair in the data blob.
  const d = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url.pathname + url.search)
  if (d) return valid({ lat: Number(d[1]), lng: Number(d[2]), label: name })
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(url.pathname)
  if (at) return valid({ lat: Number(at[1]), lng: Number(at[2]), label: name, zoom: at[3] ? Number(at[3]) : undefined })
  for (const key of ['q', 'query', 'll', 'destination', 'center']) {
    const v = url.searchParams.get(key)
    const m = v && /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(v)
    if (m) return valid({ lat: Number(m[1]), lng: Number(m[2]), label: name })
  }
  const search = /\/maps\/search\/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(url.pathname)
  if (search) return valid({ lat: Number(search[1]), lng: Number(search[2]) })
  return null
}

const valid = <T extends LatLng>(p: T): T | null => (Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 ? p : null)

// ── Files: KML (Google Earth) and GeoJSON ─────────────────────────────

export interface ParsedFeature {
  label: string
  lat: number
  lng: number
  geometry?: Geometry
  description?: string
  at?: string
  until?: string
  address?: string
}

/**
 * Placemarks from a KML document (Google Earth / My Maps export): points,
 * paths, polygons, with names, descriptions and TimeStamp / TimeSpan.
 * A small tolerant scan rather than a DOM parse, so it runs anywhere.
 */
export function parseKml(xml: string): { name?: string; features: ParsedFeature[] } {
  if (!/<kml[\s>]|<Placemark[\s>]/i.test(xml)) throw new Error('Not a readable KML file.')
  const tag = (block: string, name: string): string | undefined => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
    if (!m) return undefined
    return unescapeXml(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim() || undefined
  }
  const coords = (s: string | undefined): [number, number][] =>
    (s ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.split(',').map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => [c[0], c[1]] as [number, number])
  const features: ParsedFeature[] = []
  for (const m of xml.matchAll(/<Placemark(?:\s[^>]*)?>([\s\S]*?)<\/Placemark>/gi)) {
    const pm = m[1]
    const name = tag(pm, 'name') ?? 'Placemark'
    const description = tag(pm, 'description')
    const address = tag(pm, 'address')
    const stamp = /<TimeStamp[\s\S]*?<\/TimeStamp>/i.exec(pm)?.[0]
    const span = /<TimeSpan[\s\S]*?<\/TimeSpan>/i.exec(pm)?.[0]
    const at = (stamp && tag(stamp, 'when')) ?? (span && tag(span, 'begin')) ?? undefined
    const until = span ? tag(span, 'end') : undefined
    const point = /<Point[\s\S]*?<\/Point>/i.exec(pm)?.[0]
    const line = /<LineString[\s\S]*?<\/LineString>/i.exec(pm)?.[0]
    const poly = /<Polygon[\s\S]*?<\/Polygon>/i.exec(pm)?.[0]
    if (point) {
      const c = coords(tag(point, 'coordinates'))[0]
      if (c) features.push({ label: name, lng: c[0], lat: c[1], description, address, at, until })
    } else if (line) {
      const cs = coords(tag(line, 'coordinates'))
      if (cs.length) features.push({ label: name, lng: cs[0][0], lat: cs[0][1], geometry: { type: 'LineString', coordinates: cs }, description, address, at, until })
    } else if (poly) {
      const outer = /<outerBoundaryIs[\s\S]*?<\/outerBoundaryIs>/i.exec(poly)?.[0] ?? poly
      const cs = coords(tag(outer, 'coordinates'))
      if (cs.length) {
        const c = centroid(cs)
        features.push({ label: name, lng: c[0], lat: c[1], geometry: { type: 'Polygon', coordinates: [cs] }, description, address, at, until })
      }
    }
  }
  // The document's own name: what comes before the first placemark (or the whole document when there is none).
  const docBlock = /<Document(?:\s[^>]*)?>([\s\S]*?)(?:<Placemark|<\/Document>)/i.exec(xml)?.[1] ?? ''
  return { name: tag(docBlock, 'name'), features }
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Features from GeoJSON (a FeatureCollection, a Feature, or a bare geometry). */
export function parseGeoJson(src: string | object): { name?: string; features: ParsedFeature[] } {
  const j = (typeof src === 'string' ? JSON.parse(src) : src) as Record<string, unknown>
  const list: Record<string, unknown>[] = j.type === 'FeatureCollection' ? (j.features as Record<string, unknown>[]) : j.type === 'Feature' ? [j] : [{ type: 'Feature', geometry: j, properties: {} }]
  const features: ParsedFeature[] = []
  list.forEach((f, i) => {
    const g = f.geometry as Geometry | undefined
    const props = (f.properties ?? {}) as Record<string, unknown>
    if (!g) return
    const label = String(props.name ?? props.title ?? props.label ?? `Feature ${i + 1}`)
    const description = typeof props.description === 'string' ? props.description : undefined
    const at = typeof props.at === 'string' ? props.at : typeof props.time === 'string' ? props.time : typeof props.timestamp === 'string' ? props.timestamp : undefined
    const until = typeof props.until === 'string' ? props.until : typeof props.end === 'string' ? props.end : undefined
    const address = typeof props.address === 'string' ? props.address : undefined
    if (g.type === 'Point') features.push({ label, lng: g.coordinates[0], lat: g.coordinates[1], description, at, until, address })
    else if (g.type === 'LineString' && g.coordinates.length) features.push({ label, lng: g.coordinates[0][0], lat: g.coordinates[0][1], geometry: g, description, at, until, address })
    else if (g.type === 'Polygon' && g.coordinates[0]?.length) {
      const c = centroid(g.coordinates[0])
      features.push({ label, lng: c[0], lat: c[1], geometry: g, description, at, until, address })
    }
  })
  return { name: typeof j.name === 'string' ? j.name : undefined, features }
}

function centroid(cs: [number, number][]): [number, number] {
  // A closed ring repeats its first point; counting it twice would pull the centre toward it.
  if (cs.length > 1 && cs[0][0] === cs[cs.length - 1][0] && cs[0][1] === cs[cs.length - 1][1]) cs = cs.slice(0, -1)
  const n = cs.length || 1
  return [cs.reduce((s, c) => s + c[0], 0) / n, cs.reduce((s, c) => s + c[1], 0) / n]
}

export function placesToGeoJson(places: PlaceEntity[], notes: GeoAnnotation[] = []): string {
  const features = [
    ...places.map((p) => ({ type: 'Feature', id: p.id, geometry: p.data.geometry ?? { type: 'Point', coordinates: [p.data.lng, p.data.lat] }, properties: { name: p.label, description: p.description, address: p.data.address, at: p.data.at, until: p.data.until, tags: p.tags, url: p.data.url } })),
    ...notes.map((n) => ({ type: 'Feature', id: n.annotation.id, geometry: { type: 'Point', coordinates: [n.geo.lng, n.geo.lat] }, properties: { name: n.annotation.label, description: n.annotation.data.comment, at: n.geo.at, until: n.geo.until, radius: n.geo.radius, tags: n.annotation.tags, kind: 'annotation' } })),
  ]
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2)
}

const xml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function placesToKml(name: string, places: PlaceEntity[], notes: GeoAnnotation[] = []): string {
  const pm = (label: string, description: string | undefined, geometry: Geometry, at?: string, until?: string) => {
    const when = at && until ? `<TimeSpan><begin>${xml(at)}</begin><end>${xml(until)}</end></TimeSpan>` : at ? `<TimeStamp><when>${xml(at)}</when></TimeStamp>` : ''
    const geom =
      geometry.type === 'Point'
        ? `<Point><coordinates>${geometry.coordinates[0]},${geometry.coordinates[1]},0</coordinates></Point>`
        : geometry.type === 'LineString'
          ? `<LineString><coordinates>${geometry.coordinates.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString>`
          : `<Polygon><outerBoundaryIs><LinearRing><coordinates>${geometry.coordinates[0].map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
    return `<Placemark><name>${xml(label)}</name>${description ? `<description>${xml(description)}</description>` : ''}${when}${geom}</Placemark>`
  }
  const body = [
    ...places.map((p) => pm(p.label ?? 'Place', p.description ?? p.data.address, p.data.geometry ?? { type: 'Point', coordinates: [p.data.lng, p.data.lat] }, p.data.at, p.data.until)),
    ...notes.map((n) => pm(n.annotation.label ?? 'Note', n.annotation.data.comment, { type: 'Point', coordinates: [n.geo.lng, n.geo.lat] }, n.geo.at, n.geo.until)),
  ].join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>\n${body}\n</Document></kml>`
}

/** Import parsed features into the store — locations, paths and areas by their geometry — on a map. */
export function importFeatures(store: EntityStore, map: MapEntity, features: ParsedFeature[], source: string, tags: string[] = []): GeoEntity[] {
  return store.transaction(() =>
    features.map((f) => {
      const init: GeoInit = { label: f.label, address: f.address, at: f.at, until: f.until, description: f.description, source, tags, mapId: map.id }
      // A line of one point or a ring of two is not a shape; it lands as a location rather than failing the file.
      try {
        if (f.geometry?.type === 'LineString') return createPath(store, { ...init, coordinates: f.geometry.coordinates })
        if (f.geometry?.type === 'Polygon') return createArea(store, { ...init, ring: f.geometry.coordinates[0] })
      } catch {
        /* fall through to a point */
      }
      return createLocation(store, { ...init, lat: f.lat, lng: f.lng })
    }),
  )
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const formatDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`)
export const formatArea = (m2: number) => (m2 >= 1e6 ? `${(m2 / 1e6).toFixed(m2 >= 1e7 ? 0 : 1)} km²` : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(1)} ha` : `${Math.round(m2)} m²`)

/** Length along a line of [lng, lat] points, in metres. */
export function pathLengthM(cs: [number, number][]): number {
  let m = 0
  for (let i = 1; i < cs.length; i++) m += distanceM({ lat: cs[i - 1][1], lng: cs[i - 1][0] }, { lat: cs[i][1], lng: cs[i][0] })
  return m
}

/** Area of a ring of [lng, lat] points, in square metres (spherical excess approximation; fine below continental scale). */
export function ringAreaM2(ring: [number, number][]): number {
  if (ring.length < 3) return 0
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i]
    const [lng2, lat2] = ring[(i + 1) % ring.length]
    sum += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)))
  }
  return Math.abs((sum * R * R) / 2)
}

/**
 * Fewer points along a drawn stroke (Douglas–Peucker on lat/lng, tolerance
 * in degrees): a lasso yields hundreds of samples, a few dozen describe it.
 */
export function simplifyCoords(cs: [number, number][], tolerance: number): [number, number][] {
  if (cs.length <= 2 || tolerance <= 0) return cs
  const sqTol = tolerance * tolerance
  const keep = new Array<boolean>(cs.length).fill(false)
  keep[0] = keep[cs.length - 1] = true
  const stack: [number, number][] = [[0, cs.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = sqSegDist(cs[i], cs[a], cs[b])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > sqTol && idx > 0) {
      keep[idx] = true
      stack.push([a, idx], [idx, b])
    }
  }
  return cs.filter((_, i) => keep[i])
}
function sqSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  let [x, y] = a
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/** Bounds around everything on a map. */
export function boundsOf(points: LatLng[]): [[number, number], [number, number]] | null {
  if (!points.length) return null
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  return [
    [lats.reduce((a, b) => Math.min(a, b), Infinity), lngs.reduce((a, b) => Math.min(a, b), Infinity)],
    [lats.reduce((a, b) => Math.max(a, b), -Infinity), lngs.reduce((a, b) => Math.max(a, b), -Infinity)],
  ]
}

/** Nominatim (OpenStreetMap) geocoding — free, fair-use: one request per keystroke pause, results cached. */
const geocodeCache = new Map<string, GeocodeHit[]>()
export interface GeocodeHit {
  label: string
  lat: number
  lng: number
  kind?: string
}
export async function geocode(query: string, limit = 6): Promise<GeocodeHit[]> {
  const q = query.trim()
  if (!q) return []
  const cached = geocodeCache.get(q)
  if (cached) return cached
  requireExternalServices('Place search')
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`)
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string; type?: string }[]
  const hits = rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon), kind: r.type }))
  geocodeCache.set(q, hits)
  return hits
}

export async function reverseGeocode(p: LatLng): Promise<string | undefined> {
  if (!externalServicesAllowed()) return undefined
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return undefined
    const j = (await res.json()) as { display_name?: string }
    return j.display_name
  } catch {
    return undefined
  }
}

export const MAP_ACCEPT = '.kml,.kmz,.geojson,.json,application/vnd.google-earth.kml+xml,application/geo+json,application/json'

/** Read a KML / GeoJSON file (KMZ is a zip — not handled here; ask for the KML inside). */
export async function parseMapFile(file: File): Promise<{ name?: string; features: ParsedFeature[]; source: string }> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'kmz') throw new Error('KMZ is a zip archive — unzip it and import the doc.kml inside.')
  const text = await file.text()
  if (ext === 'kml' || /^\s*<\?xml|<kml/i.test(text)) return { ...parseKml(text), source: 'kml' }
  return { ...parseGeoJson(text), source: 'geojson' }
}



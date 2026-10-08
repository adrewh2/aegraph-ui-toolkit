import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { geoKindOf, isGeoIn, type GeoEntity } from '../maps/maps'

/**
 * What the globe draws, read straight from the entity system (ES): every
 * location, path and area in scope — or the ones on one map, or a picked
 * set — turned into points, arcs and polygons with a colour, a label and
 * the time they belong to. Pure, so the view and the tool share it.
 */

export interface GlobePoint {
  id: EntityId
  lat: number
  lng: number
  label: string
  color: string
  at?: string
  /** Radius in degrees; a small dot unless the entity says otherwise. */
  size: number
}

export interface GlobeArc {
  id: EntityId
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  label: string
  color: string
  at?: string
  until?: string
  /** Which leg of a multi-point path this is (0 for two-point paths). */
  leg: number
  legs: number
}

export interface GlobePolygon {
  id: EntityId
  /** GeoJSON polygon rings, [lng, lat]. */
  coordinates: [number, number][][]
  label: string
  color: string
}

export interface GlobeScene {
  points: GlobePoint[]
  arcs: GlobeArc[]
  polygons: GlobePolygon[]
  /** The entities the scene came from, for the table and the selection. */
  entities: GeoEntity[]
  /** Time range of everything dated, when anything is. */
  range?: { from: string; to: string }
  /** A centre worth starting on: the mean of the points. */
  center?: { lat: number; lng: number }
}

export interface GlobeSelection {
  /** Only these ids (a pick); everything geographic in scope otherwise. */
  ids?: EntityId[]
  /** Only what belongs to this map. */
  mapId?: EntityId
  /** Only entities carrying any of these tags. */
  tags?: string[]
  /** Only dated entities inside this window (ISO). */
  from?: string
  to?: string
}

/** Colour: the entity's first tag with a colour, else its type's colour, else a stable hash of the type. */
export function colorFor(store: EntityStore, registry: TypeRegistry, e: AnyEntity): string {
  for (const t of e.tags) {
    const c = store.getTagInfo(t).color
    if (c) return c
  }
  return registry.colorOf(e.type)
}

export function globeScene(store: EntityStore, registry: TypeRegistry, sel: GlobeSelection = {}): GlobeScene {
  const wanted = sel.ids ? new Set(sel.ids) : undefined
  const tags = sel.tags?.length ? new Set(sel.tags) : undefined
  const from = sel.from ? Date.parse(sel.from) : undefined
  const to = sel.to ? Date.parse(sel.to) : undefined
  const inWindow = (e: GeoEntity) => {
    if (from === undefined && to === undefined) return true
    const at = e.data.at ? Date.parse(e.data.at) : NaN
    const until = e.data.until ? Date.parse(e.data.until) : at
    if (Number.isNaN(at)) return false
    if (from !== undefined && until < from) return false
    if (to !== undefined && at > to) return false
    return true
  }
  const entities = (wanted ? [...wanted].map((id) => store.get(id)) : store.all())
    .filter((e): e is GeoEntity => isGeoIn(store, e))
    .filter((e) => !sel.mapId || e.data.mapId === sel.mapId)
    .filter((e) => !tags || e.tags.some((t) => tags.has(t)))
    .filter(inWindow)

  const points: GlobePoint[] = []
  const arcs: GlobeArc[] = []
  const polygons: GlobePolygon[] = []
  let minAt = Infinity
  let maxAt = -Infinity
  let sumLat = 0
  let sumLng = 0
  let n = 0
  const dated = (e: GeoEntity) => {
    for (const k of ['at', 'until'] as const) {
      const v = e.data[k]
      if (!v) continue
      const t = Date.parse(v)
      if (Number.isNaN(t)) continue
      if (t < minAt) minAt = t
      if (t > maxAt) maxAt = t
    }
  }
  for (const e of entities) {
    const color = colorFor(store, registry, e)
    const label = displayLabel(e)
    const g = e.data.geometry
    dated(e)
    const kind = geoKindOf(store, e.type) ?? 'location'
    if (kind === 'location' || !g) {
      points.push({ id: e.id, lat: e.data.lat, lng: e.data.lng, label, color, at: e.data.at, size: 0.55 })
      sumLat += e.data.lat
      sumLng += e.data.lng
      n++
      continue
    }
    if (kind === 'path' && g.type === 'LineString') {
      const cs = g.coordinates
      for (let i = 0; i + 1 < cs.length; i++) {
        arcs.push({ id: e.id, startLng: cs[i][0], startLat: cs[i][1], endLng: cs[i + 1][0], endLat: cs[i + 1][1], label, color, at: e.data.at, until: e.data.until, leg: i, legs: cs.length - 1 })
      }
      for (const c of cs) {
        sumLat += c[1]
        sumLng += c[0]
        n++
      }
      continue
    }
    if (kind === 'area' && g.type === 'Polygon') {
      polygons.push({ id: e.id, coordinates: g.coordinates, label, color })
      sumLat += e.data.lat
      sumLng += e.data.lng
      n++
    }
  }
  return {
    points,
    arcs,
    polygons,
    entities,
    ...(Number.isFinite(minAt) ? { range: { from: new Date(minAt).toISOString(), to: new Date(maxAt).toISOString() } } : {}),
    ...(n ? { center: { lat: sumLat / n, lng: sumLng / n } } : {}),
  }
}

import { useMemo } from 'react'
import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import { useExternalServices } from '../account/settings'
import { geoOf, type GeoEntity, type MapEntity } from './maps'
import { mapThumb, THUMB_H, THUMB_W, type MapThumb as Thumb } from './mapCard'

/** The casing under lines and dots: the page's surface, white on Paper (a style, since an SVG attribute takes no variable). */
const CASING = { stroke: 'var(--surface)' }

/**
 * A map's card picture (`mapThumb`): the view fitted to what is on the map,
 * its base tiles when third-party services are on, and every location, path
 * and area in the colour the map draws it. Kept per map for as long as the
 * features are the same array (`geoOf` hands back the same one until the
 * data changes), so a re-render of the index costs nothing.
 */
export function MapThumb({ map, store }: { map: MapEntity; store: EntityStore }) {
  const external = useExternalServices()
  const features = geoOf(store, map)
  const thumb = useMemo(() => thumbFor(store, map, features, external), [store, map, features, external])
  const many = thumb.paths.length > 0 && thumb.shown > 300
  return (
    <svg className="mi__map" viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${thumb.total} on this map`}>
      {/* The drawn base layers take the theme's tile filter, as the map itself does (maps.css › .geo-tiles). */}
      <g className={map.data.layer === 'satellite' ? undefined : 'geo-tiles'}>
        {thumb.tiles.map((t) => (
          // A hair of overlap, so the seams between scaled tiles don't show as lines.
          <image key={t.url + t.x} href={t.url} x={t.x} y={t.y} width={t.size + 0.5} height={t.size + 0.5} />
        ))}
      </g>
      {thumb.areas.map((a) => (
        <path key={`a${a.color}`} d={a.d} fill={a.color} fillOpacity={0.22} stroke={a.color} strokeWidth={1.2} strokeLinejoin="round" />
      ))}
      {!many && thumb.paths.map((p) => <path key={`pc${p.color}`} d={p.d} fill="none" style={CASING} strokeOpacity={0.85} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />)}
      {thumb.paths.map((p) => (
        <path key={`p${p.color}`} d={p.d} fill="none" stroke={p.color} strokeOpacity={many ? 0.45 : 0.95} strokeWidth={many ? 0.8 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {thumb.dotSize >= 6 && thumb.dots.map((d) => <path key={`dc${d.color}`} d={d.d} style={CASING} strokeWidth={thumb.dotSize + 2.4} strokeLinecap="round" />)}
      {thumb.dots.map((d) => (
        <path key={`d${d.color}`} d={d.d} stroke={d.color} strokeOpacity={thumb.dotSize < 3 ? 0.8 : 1} strokeWidth={thumb.dotSize} strokeLinecap="round" />
      ))}
    </svg>
  )
}

// One picture per map: the features array outlives edits to the map entity itself (a rename, a saved view), so a
// key per version would keep every version's picture for as long as the pins stay the same.
const cache = new WeakMap<GeoEntity[], Map<EntityId, { key: string; t: Thumb }>>()
function thumbFor(store: EntityStore, map: MapEntity, features: GeoEntity[], external: boolean): Thumb {
  let byMap = cache.get(features)
  if (!byMap) cache.set(features, (byMap = new Map()))
  const key = `${map.meta.updatedAt}:${external}`
  const hit = byMap.get(map.id)
  let t = hit?.key === key ? hit.t : undefined
  if (!t) {
    const colorOf = (tags: string[]) => {
      for (let i = 0; i < tags.length; i++) {
        const c = store.tagColor(tags[i])
        if (c) return c
      }
      return undefined
    }
    byMap.set(map.id, { key, t: (t = mapThumb(map, features, colorOf, { tiles: external })) })
  }
  return t
}

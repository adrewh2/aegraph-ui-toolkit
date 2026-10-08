import type { Object3D, Raycaster } from 'three'
import type { EntityId } from '../../core/entity/types'
import type { GlobePolygon } from './globeData'

/**
 * Picking on the globe, by hand. globe.gl's own pointer interaction casts
 * a ray through the whole scene every 50 ms — every tile the engine holds
 * (hidden levels included), the atmosphere shell, every polygon's cap and
 * wall, triangle by triangle: ten to twenty milliseconds a tick with the
 * pointer anywhere on the stage, before a single feature of ours. It is
 * switched off, and the stage asks these instead: a ray meets the sphere
 * (two multiplications), an area is found by a point-in-polygon test on
 * its own ring, and the few points and arcs of a small scene are tested
 * as the meshes globe.gl made for them — nothing else is looked at.
 */

export const GLOBE_R = 100

/** Where a ray first meets the sphere of this radius about the origin, as a latitude and longitude, or null. */
export function rayToLatLng(ray: Raycaster, radius = GLOBE_R): { lat: number; lng: number } | null {
  const o = ray.ray.origin
  const d = ray.ray.direction
  const b = o.dot(d)
  const disc = b * b - (o.lengthSq() - radius * radius)
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  if (t < 0) return null
  const x = o.x + d.x * t
  const y = o.y + d.y * t
  const z = o.z + d.z * t
  // three-globe's frame: x = r sinφ cosθ, y = r cosφ, z = r sinφ sinθ, with φ = 90° − lat and θ = 90° − lng.
  const lat = 90 - (Math.acos(y / Math.hypot(x, y, z)) * 180) / Math.PI
  let lng = 90 - (Math.atan2(z, x) * 180) / Math.PI
  if (lng > 180) lng -= 360
  if (lng <= -180) lng += 360
  return { lat, lng }
}

/** Whether a ray meets the globe at all. */
export const hitsGlobe = (ray: Raycaster): boolean => {
  const o = ray.ray.origin
  const b = o.dot(ray.ray.direction)
  return b * b - (o.lengthSq() - GLOBE_R * GLOBE_R) >= 0
}

/** Whether a point lies inside a ring of `[lng, lat]` vertices (even-odd rule). */
export function inRing(lng: number, lat: number, ring: readonly [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The polygon under a point: inside its outer ring and none of its holes; the last one drawn wins, as on the globe. */
export function polygonAt(polygons: readonly GlobePolygon[], lat: number, lng: number): GlobePolygon | undefined {
  for (let p = polygons.length - 1; p >= 0; p--) {
    const rings = polygons[p].coordinates
    if (!rings.length || !inRing(lng, lat, rings[0])) continue
    let inHole = false
    for (let h = 1; h < rings.length && !inHole; h++) inHole = inRing(lng, lat, rings[h])
    if (!inHole) return polygons[p]
  }
  return undefined
}

type Tagged = Object3D & { __globeObjType?: string; __data?: { id?: EntityId } }

/**
 * The point or arc of a small scene under a ray: the meshes globe.gl built for `pointsData` and `arcsData`, and
 * nothing else in the scene. On the near side of the globe only.
 */
export function pickLayerObject(scene: Object3D, ray: Raycaster): EntityId | undefined {
  const objs: Object3D[] = []
  scene.traverse((o) => {
    const t = (o as Tagged).__globeObjType
    if ((t === 'point' || t === 'arc') && (o as Tagged).__data) objs.push(o)
  })
  if (!objs.length) return undefined
  const eye = ray.ray.origin
  for (const h of ray.intersectObjects(objs, true)) {
    if (h.point.dot(eye) <= GLOBE_R * GLOBE_R) continue
    let o: Object3D | null = h.object
    while (o && !(o as Tagged).__data) o = o.parent
    const id = (o as Tagged | null)?.__data?.id
    if (id !== undefined) return id
  }
  return undefined
}

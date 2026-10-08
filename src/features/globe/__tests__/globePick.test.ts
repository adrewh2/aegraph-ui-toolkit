import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { GlobePolygon } from '../globeData'
import { GLOBE_R, hitsGlobe, inRing, polygonAt, rayToLatLng } from '../globePick'

/** three-globe's polar → cartesian, the frame the globe draws in. */
const xyz = (lat: number, lng: number, r = GLOBE_R) => {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((90 - lng) * Math.PI) / 180
  return new Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}
/** A ray from a camera above `at` (at this altitude, in radii) straight down at the surface point. */
const rayDownAt = (lat: number, lng: number, altitude = 1) => {
  const from = xyz(lat, lng, GLOBE_R * (1 + altitude))
  const ray = new Raycaster()
  ray.set(from, xyz(lat, lng).sub(from).normalize())
  return ray
}

describe('rayToLatLng', () => {
  it('reads back the point a ray was aimed at, on the near side', () => {
    for (const [lat, lng] of [
      [0, 0],
      [43.7, -79.4],
      [-33.9, 151.2],
      [64.1, -21.9],
      [10, 179.5],
    ]) {
      const at = rayToLatLng(rayDownAt(lat, lng))!
      expect(at.lat).toBeCloseTo(lat, 5)
      expect(at.lng).toBeCloseTo(lng, 5)
    }
  })
  it('is null for a ray that misses the sphere, and for one pointing away', () => {
    const ray = new Raycaster()
    ray.set(new Vector3(0, 0, 300), new Vector3(1, 0, 0))
    expect(rayToLatLng(ray)).toBeNull()
    expect(hitsGlobe(ray)).toBe(false)
    ray.set(new Vector3(0, 0, 300), new Vector3(0, 0, 1))
    expect(rayToLatLng(ray)).toBeNull()
    expect(hitsGlobe(rayDownAt(1, 2))).toBe(true)
  })
  it('agrees with a camera looking at the globe', () => {
    const cam = new PerspectiveCamera(50, 1, 0.1, 1000)
    cam.position.copy(xyz(43.7, -79.4, 150))
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld()
    const ray = new Raycaster()
    ray.setFromCamera(new Vector2(0, 0), cam)
    const at = rayToLatLng(ray)!
    expect(at.lat).toBeCloseTo(43.7, 4)
    expect(at.lng).toBeCloseTo(-79.4, 4)
  })
})

describe('polygons', () => {
  const square = (id: string, lng0: number, lat0: number, size: number, holes: [number, number][][] = []): GlobePolygon => ({
    id,
    label: id,
    color: '#000',
    coordinates: [
      [
        [lng0, lat0],
        [lng0 + size, lat0],
        [lng0 + size, lat0 + size],
        [lng0, lat0 + size],
        [lng0, lat0],
      ],
      ...holes,
    ],
  })
  it('inRing: inside, outside, and a vertex-grazing edge case', () => {
    const ring = square('a', 0, 0, 10).coordinates[0]
    expect(inRing(5, 5, ring)).toBe(true)
    expect(inRing(15, 5, ring)).toBe(false)
    expect(inRing(-1, -1, ring)).toBe(false)
  })
  it('polygonAt: the last drawn wins where they overlap; a hole is outside', () => {
    const a = square('a', 0, 0, 10)
    const b = square('b', 5, 5, 10)
    const ringed = square('r', 20, 20, 10, [
      [
        [23, 23],
        [27, 23],
        [27, 27],
        [23, 27],
        [23, 23],
      ],
    ])
    const polys = [a, b, ringed]
    expect(polygonAt(polys, 2, 2)?.id).toBe('a')
    expect(polygonAt(polys, 7, 7)?.id).toBe('b')
    expect(polygonAt(polys, 12, 12)?.id).toBe('b')
    expect(polygonAt(polys, 21, 21)?.id).toBe('r')
    expect(polygonAt(polys, 25, 25)).toBeUndefined()
    expect(polygonAt(polys, 50, 50)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { BASE_ZOOM, mercX, mercY } from '../pinIndex'
import { bezier, cameraFor, fixedPointOfZoom } from '../pointMath'

/** The point layer's arithmetic: the camera on a Leaflet view, and the zoom animation's fixed point and easing. */
describe('pointLayer', () => {
  it('eases like CSS cubic-bezier(0, 0, 0.25, 1): from 0 to 1, monotone, fast out of the gate', () => {
    const ease = bezier(0, 0, 0.25, 1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    let last = 0
    for (let t = 0.05; t <= 1; t += 0.05) {
      const v = ease(t)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
    expect(ease(0.5)).toBeGreaterThan(0.5)
    // A linear curve is the identity.
    expect(bezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 6)
  })

  it('puts the camera on a view: the centre in world units about the origin, the scale by zoom, y up', () => {
    const origin = { x: mercX(-79.4, BASE_ZOOM), y: mercY(43.7, BASE_ZOOM) }
    const at = cameraFor({ lat: 43.7, lng: -79.4 }, BASE_ZOOM, origin)
    expect(at).toEqual({ x: 0, y: 0, scale: 1 })
    const north = cameraFor({ lat: 43.71, lng: -79.4 }, 15, origin)
    expect(north.y).toBeGreaterThan(0)
    expect(north.scale).toBeCloseTo(1 / 16, 9)
    const east = cameraFor({ lat: 43.7, lng: -79.39 }, 15, origin)
    expect(east.x).toBeGreaterThan(0)
  })

  it('finds the point a zoom animation scales about: scaling about it puts the target centre at the screen centre', () => {
    const size = { x: 640, y: 480 }
    for (const [target, k] of [
      [{ x: 400, y: 300 }, 2],
      [{ x: 100, y: 50 }, 0.5],
      [{ x: 320, y: 240 }, 4],
    ] as const) {
      const f = fixedPointOfZoom(size, target, k)
      const landed = { x: f.x + (target.x - f.x) * k, y: f.y + (target.y - f.y) * k }
      expect(landed.x).toBeCloseTo(size.x / 2, 6)
      expect(landed.y).toBeCloseTo(size.y / 2, 6)
    }
    // Zooming about the centre itself leaves the centre where it is.
    expect(fixedPointOfZoom(size, { x: 320, y: 240 }, 2)).toEqual({ x: 320, y: 240 })
  })
})

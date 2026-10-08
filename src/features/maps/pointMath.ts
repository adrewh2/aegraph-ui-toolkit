/**
 * The point layer's arithmetic, apart from Leaflet and the engine so it can be tested plainly: the easing Leaflet's
 * zoom animation uses, the engine's camera for a map view, and the screen point a zoom animation scales about.
 */
import { BASE_ZOOM, mercX, mercY } from './pinIndex'

/** The unit cubic Bézier easing as CSS defines it, solved for t by Newton's method. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-6) break
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    return sampleY(t)
  }
}

/** The engine's camera for a Leaflet view — a centre and a zoom (fractional through an animation) — about a world origin. */
export function cameraFor(center: { lat: number; lng: number }, zoom: number, origin: { x: number; y: number }): { x: number; y: number; scale: number } {
  return { x: mercX(center.lng, BASE_ZOOM) - origin.x, y: origin.y - mercY(center.lat, BASE_ZOOM), scale: 2 ** (zoom - BASE_ZOOM) }
}

/**
 * Leaflet's zoom animation scales its panes by k about one screen point that stays put; given where the target
 * centre is on screen now and the scale factor, that point is the one which, scaled about itself, puts the target
 * centre at the screen's centre when k is reached.
 */
export function fixedPointOfZoom(size: { x: number; y: number }, targetOnScreen: { x: number; y: number }, k: number): { x: number; y: number } {
  return { x: (size.x / 2 - targetOnScreen.x * k) / (1 - k), y: (size.y / 2 - targetOnScreen.y * k) / (1 - k) }
}


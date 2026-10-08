/**
 * How a 2D camera travels from one view to another: the "smooth and efficient zooming and panning" path of
 * van Wijk & Nuij (2003), the motion behind d3's `interpolateZoom`. A straight pan at a fixed zoom across several
 * screens is a blur in which nothing can be followed; this path pulls back as it travels so the origin and the
 * destination share the screen mid-way, and settles in again at the end — the eye keeps both in view the whole way.
 * A short hop barely rises; a long one arcs high. Shared by the sigma view and the GPU engine so a click in the Nodes
 * table looks the same on every renderer.
 *
 * A view is a centre and the width of the world it shows (`w`), all in one unit — graph coordinates for sigma, world
 * units for the engine. Zoom is `w`: halving it zooms in twice.
 */
export interface ZoomView {
  x: number
  y: number
  /** The width of the world that is visible: the zoom, in the centre's units. */
  w: number
}

export interface ZoomPath {
  /** The view at `t` ∈ [0, 1] (unclamped `t` is clamped). */
  at: (t: number) => ZoomView
  /** The perceptual length of the path in screen widths — what its duration is proportional to. */
  length: number
}

/** How high the path arcs relative to how far it travels: van Wijk's ρ, √2 being the value they found people prefer. */
const RHO = Math.SQRT2
const RHO2 = RHO * RHO
const RHO4 = RHO2 * RHO2
const EPS = 1e-9

const cosh = (x: number) => (Math.exp(x) + Math.exp(-x)) / 2
const sinh = (x: number) => (Math.exp(x) - Math.exp(-x)) / 2
const tanh = (x: number) => {
  const e = Math.exp(2 * x)
  return (e - 1) / (e + 1)
}

/** The path from one view to another. Degenerate inputs (a non-positive or non-finite width) fall back to a straight cut. */
export function zoomPath(from: ZoomView, to: ZoomView): ZoomPath {
  const w0 = from.w > 0 && Number.isFinite(from.w) ? from.w : 1
  const w1 = to.w > 0 && Number.isFinite(to.w) ? to.w : w0
  const dx = to.x - from.x, dy = to.y - from.y
  const d2 = dx * dx + dy * dy
  if (!Number.isFinite(d2)) return { at: (t) => (t < 1 ? { ...from, w: w0 } : { ...to, w: w1 }), length: 0 }
  // Straight in or out over one spot: a pure zoom, exponential in w so it feels even.
  if (d2 < EPS * EPS * Math.max(1, w0 * w0)) {
    const S = Math.abs(Math.log(w1 / w0)) / RHO
    return {
      at: (t) => {
        const k = Math.max(0, Math.min(1, t))
        return { x: from.x + k * dx, y: from.y + k * dy, w: w0 * Math.exp(Math.log(w1 / w0) * k) }
      },
      length: S,
    }
  }
  const d1 = Math.sqrt(d2)
  const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1)
  const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const S = (r1 - r0) / RHO
  const coshr0 = cosh(r0), sinhr0 = sinh(r0)
  return {
    at: (t) => {
      const k = Math.max(0, Math.min(1, t))
      if (k >= 1) return { x: to.x, y: to.y, w: w1 }
      const s = k * S
      const u = (w0 / (RHO2 * d1)) * (coshr0 * tanh(RHO * s + r0) - sinhr0)
      return { x: from.x + u * dx, y: from.y + u * dy, w: (w0 * coshr0) / cosh(RHO * s + r0) }
    },
    length: Math.abs(S),
  }
}

/**
 * How long the path takes: proportional to its length (a screen-width hop is about 700 ms), never shorter than a beat
 * or longer than a breath, so a neighbour is a flick and the far side of the graph is a glide, not a wait. (When the
 * system asks for reduced motion the engine's cameras cut instead of flying — `lib/motion.ts`.)
 */
export function zoomDuration(path: ZoomPath, opts: { min?: number; max?: number; perUnit?: number } = {}): number {
  const ms = path.length * (opts.perUnit ?? 560)
  return Math.round(Math.max(opts.min ?? 320, Math.min(opts.max ?? 900, ms)))
}

/** Cubic ease in and out: the camera leaves gently and arrives gently, the path itself keeping the speed even between. */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

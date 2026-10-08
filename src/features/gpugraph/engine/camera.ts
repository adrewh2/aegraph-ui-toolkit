/**
 * The camera: a centre in world units and a scale (CSS px per world unit).
 * Pan and zoom mutate three numbers; screen ↔ world conversions write into
 * caller-owned scratch, so pointer handling allocates nothing. An animated
 * move follows the zoom-and-pan path of `graph/cameraPath.ts` — pulling back
 * over a long pan so both ends stay in sight, exponential in the zoom so it
 * feels even — one step each frame the engine asks for one.
 */
import { easeInOutCubic, zoomDuration, zoomPath, type ZoomPath } from '../../graph/cameraPath'
import { prefersReducedMotion } from '../../../lib/motion'

export class Camera {
  x = 0
  y = 0
  scale = 1
  width = 1
  height = 1
  minScale = 1e-4
  maxScale = 1e4
  /** The scale at which the whole graph fits: node sizes and LOD are relative to it. */
  fitScale = 1
  private target: { x: number; y: number; scale: number; from: { x: number; y: number; scale: number }; path: ZoomPath; start: number; ms: number } | null = null

  worldX(sx: number): number {
    return (sx - this.width / 2) / this.scale + this.x
  }
  worldY(sy: number): number {
    return (this.height / 2 - sy) / this.scale + this.y
  }
  screenX(wx: number): number {
    return (wx - this.x) * this.scale + this.width / 2
  }
  screenY(wy: number): number {
    return this.height / 2 - (wy - this.y) * this.scale
  }

  /** Zoom by `factor` keeping the world point under screen (sx, sy) where it is. */
  zoomAt(factor: number, sx: number, sy: number) {
    const wx = this.worldX(sx), wy = this.worldY(sy)
    this.setScale(this.scale * factor)
    this.x = wx - (sx - this.width / 2) / this.scale
    this.y = wy - (this.height / 2 - sy) / this.scale
    this.target = null
  }
  setScale(s: number) {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, s))
  }
  /** Pan by a screen delta (CSS px). */
  panBy(dx: number, dy: number) {
    this.x -= dx / this.scale
    this.y += dy / this.scale
    this.target = null
  }
  /**
   * Slide the picture by a screen delta without ending a move in flight: the view changed size or place around it,
   * and both where the camera is and where it is going move by the same amount, so what is on screen stays put.
   */
  shiftBy(dxPx: number, dyPx: number) {
    const t = this.target
    if (t) {
      t.x -= dxPx / t.scale
      t.y += dyPx / t.scale
      t.from.x -= dxPx / t.from.scale
      t.from.y += dyPx / t.from.scale
      t.path = this.pathTo(t.from, t)
    }
    this.x -= dxPx / this.scale
    this.y += dyPx / this.scale
  }
  /** The flight between two camera states, in world units — the zoom being the width of world in view. */
  private pathTo(from: { x: number; y: number; scale: number }, to: { x: number; y: number; scale: number }): ZoomPath {
    return zoomPath({ x: from.x, y: from.y, w: this.width / from.scale }, { x: to.x, y: to.y, w: this.width / to.scale })
  }

  /** The visible rectangle in world units. */
  viewport(out: { minX: number; minY: number; maxX: number; maxY: number }) {
    out.minX = this.worldX(0)
    out.maxX = this.worldX(this.width)
    out.minY = this.worldY(this.height)
    out.maxY = this.worldY(0)
    return out
  }

  /**
   * Move so a world box fills the view with `padding` (a fraction of the box) around it: at once (`ms` 0, the
   * default), over `ms`, or — `ms` given as `undefined` explicitly — over a time the path's length decides.
   */
  fitBox(minX: number, minY: number, maxX: number, maxY: number, opts: { padding?: number; ms?: number } = {}) {
    const pad = opts.padding ?? 0.1
    const w = Math.max(maxX - minX, 1e-3) * (1 + pad * 2)
    const h = Math.max(maxY - minY, 1e-3) * (1 + pad * 2)
    const scale = Math.min(this.width / w, this.height / h)
    this.animateTo((minX + maxX) / 2, (minY + maxY) / 2, scale, 'ms' in opts ? opts.ms : 0)
  }

  /**
   * Fly to a centre and scale. `ms` sets the duration; 0 cuts straight there; `undefined` lets the path's length
   * decide (a neighbour is a flick, the far side of the picture a glide, never longer than a breath). When the system
   * asks for reduced motion every flight is a cut.
   */
  animateTo(x: number, y: number, scale: number, ms: number | undefined) {
    scale = Math.min(this.maxScale, Math.max(this.minScale, scale))
    if ((ms !== undefined && ms <= 0) || prefersReducedMotion()) {
      this.x = x
      this.y = y
      this.scale = scale
      this.target = null
      return
    }
    // The path runs in world units, the zoom being the width of world in view.
    const from = { x: this.x, y: this.y, scale: this.scale }
    const path = this.pathTo(from, { x, y, scale })
    // `start` is set by the first tick: the glide begins when the first frame runs, whatever the call cost.
    this.target = { x, y, scale, from, path, start: 0, ms: ms ?? zoomDuration(path) }
  }
  /** Advance an animation; returns whether one is still running (so the caller keeps rendering). */
  tick(now: number): boolean {
    const t = this.target
    if (!t) return false
    if (!t.start) t.start = now
    const k = Math.min(1, (now - t.start) / t.ms)
    if (k >= 1) {
      this.x = t.x
      this.y = t.y
      this.scale = t.scale
      this.target = null
      return false
    }
    const v = t.path.at(easeInOutCubic(k))
    this.x = v.x
    this.y = v.y
    this.scale = this.width / v.w
    return true
  }
  get animating(): boolean {
    return this.target !== null
  }
  stop() {
    this.target = null
  }
}

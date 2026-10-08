import { lookAt, multiply, perspective, project, type Mat4 } from './mat4'
import { prefersReducedMotion } from '../../../lib/motion'

/**
 * The 3D camera: an orbit around a target — yaw, pitch, distance, a
 * vertical field of view. The orbit controls move it around the target
 * (`orbit`, `pan`, `dolly`); the fly controls move it from the eye (`fly`,
 * `look`) — the same state either way, so switching keeps the view. Produces one view-projection matrix per frame
 * (the shaders take nothing else) and projects world points to screen px
 * for labels, marquees and drag deltas without allocating.
 *
 * The projection is canonical — the field of view over the view's height,
 * centred — until the view changes size around a picture that must not
 * move (`holdOnResize`): then the focal length in px and the principal
 * point are kept, and the new view is a crop or an extension of the old
 * one, exact at every depth. A framing command (a fit, a camera set with
 * `canonical`) brings the projection back to the canonical one.
 */
export class OrbitCamera {
  tx = 0
  ty = 0
  tz = 0
  distance = 1000
  yaw = 0.6
  pitch = 0.5
  fov = (50 * Math.PI) / 180
  width = 1
  height = 1
  near = 0.1
  far = 1e7
  /** The distance at which the whole graph fits: sizes and LOD are relative to it. */
  fitDistance = 1000
  /** The focal length in px kept through resizes; 0 means the canonical one, from `fov` and the height. */
  focal = 0
  /** Where the picture's centre sits, in px from the view's centre (right and down positive). */
  offsetX = 0
  offsetY = 0
  readonly viewProj: Mat4 = new Float32Array(16)
  readonly view: Mat4 = new Float32Array(16)
  private proj: Mat4 = new Float32Array(16)
  private tmp = new Float32Array(3)
  private target: { tx: number; ty: number; tz: number; distance: number; yaw: number; pitch: number; canonical: boolean; from: number[]; start: number; ms: number } | null = null

  get eye(): [number, number, number] {
    const cp = Math.cos(this.pitch)
    return [this.tx + this.distance * cp * Math.sin(this.yaw), this.ty + this.distance * Math.sin(this.pitch), this.tz + this.distance * cp * Math.cos(this.yaw)]
  }
  /** The focal length in px: screen px per world unit at unit depth (and per world unit at the target, over `distance`). */
  get focalPx(): number {
    return this.focal || this.canonicalFocal()
  }
  private canonicalFocal(): number {
    return this.height / (2 * Math.tan(this.fov / 2))
  }

  update() {
    const [ex, ey, ez] = this.eye
    lookAt(this.view, ex, ey, ez, this.tx, this.ty, this.tz, 0, 1, 0)
    this.near = Math.max(0.01, this.distance * 0.001)
    this.far = this.distance * 100 + 1000
    // The field of view the focal length gives over this height; the principal point moves the picture in clip
    // space by a constant (the term in z over w = −z), so every depth shifts by the same px.
    perspective(this.proj, 2 * Math.atan(this.height / (2 * this.focalPx)), this.width / this.height, this.near, this.far)
    this.proj[8] = (-2 * this.offsetX) / this.width
    this.proj[9] = (2 * this.offsetY) / this.height
    multiply(this.viewProj, this.proj, this.view)
  }

  /** Screen px of a world point (after `update`); returns the clip w (depth; ≤ 0 is behind the camera). */
  project(x: number, y: number, z: number, out: { x: number; y: number }): number {
    const w = project(this.viewProj, x, y, z, this.tmp)
    out.x = (this.tmp[0] * 0.5 + 0.5) * this.width
    out.y = (0.5 - this.tmp[1] * 0.5) * this.height
    return w
  }

  /** Move a world point by a screen delta, staying at its depth (the plane facing the camera through it). */
  dragDelta(dxPx: number, dyPx: number, depthW: number, out: { x: number; y: number; z: number }) {
    const k = depthW / this.focalPx
    // Camera right and up vectors from the view matrix rows.
    const v = this.view
    out.x = (v[0] * dxPx - v[1] * dyPx) * k
    out.y = (v[4] * dxPx - v[5] * dyPx) * k
    out.z = (v[8] * dxPx - v[9] * dyPx) * k
  }

  orbit(dYaw: number, dPitch: number) {
    this.yaw += dYaw
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dPitch))
    this.target = null
  }
  /** Pan the target in the view plane by a screen delta. */
  pan(dxPx: number, dyPx: number) {
    const k = this.distance / this.focalPx
    const v = this.view
    this.tx -= (v[0] * dxPx - v[1] * dyPx) * k
    this.ty -= (v[4] * dxPx - v[5] * dyPx) * k
    this.tz -= (v[8] * dxPx - v[9] * dyPx) * k
    this.target = null
  }
  dolly(factor: number) {
    this.distance = Math.max(0.01, this.distance * factor)
    this.target = null
  }
  /** The world offset, in the plane facing the camera through the target, of a screen point from where the target is drawn. */
  private offsetAt(sx: number, sy: number): [number, number, number] {
    const at = { x: 0, y: 0 }
    this.project(this.tx, this.ty, this.tz, at)
    const dx = sx - at.x, dy = sy - at.y
    const k = this.distance / this.focalPx
    const v = this.view
    return [(v[0] * dx - v[1] * dy) * k, (v[4] * dx - v[5] * dy) * k, (v[8] * dx - v[9] * dy) * k]
  }
  /**
   * Dolly about a screen point, as the flat camera zooms about the pointer: the distance changes by `factor` and the
   * target slides toward the point under (sx, sy) by the same share, so what is under the pointer — at the target's
   * depth exactly, nearby depths nearly — stays under it. `dolly` alone closes on the target wherever the pointer is.
   */
  dollyAt(factor: number, sx: number, sy: number) {
    const next = Math.max(0.01, this.distance * factor)
    const f = next / this.distance
    const [ox, oy, oz] = this.offsetAt(sx, sy)
    this.tx += ox * (1 - f)
    this.ty += oy * (1 - f)
    this.tz += oz * (1 - f)
    this.distance = next
    this.target = null
  }

  // ── Fly controls ─────────────────────────────────────────────────────
  // The same camera, driven from the eye instead of the target: `fly` moves the eye and the point it looks at
  // together (so it goes through the graph and past it, never slowing), `look` turns the view about the eye.

  /** The direction the camera looks, and its right, as unit vectors (the right stays level). */
  axes(): { forward: [number, number, number]; right: [number, number, number] } {
    const cp = Math.cos(this.pitch)
    return { forward: [-cp * Math.sin(this.yaw), -Math.sin(this.pitch), -cp * Math.cos(this.yaw)], right: [Math.cos(this.yaw), 0, -Math.sin(this.yaw)] }
  }
  /** Move the eye (and the point it looks at) by world units: along the line of sight, to the right, and up. */
  fly(forward: number, right: number, up: number) {
    const { forward: f, right: r } = this.axes()
    this.tx += f[0] * forward + r[0] * right
    this.ty += f[1] * forward + up
    this.tz += f[2] * forward + r[2] * right
    this.target = null
  }
  /**
   * Fly toward a screen point: the eye and the point it looks at move `amount` world units along the ray through
   * (sx, sy) — straight ahead at the centre, toward what the pointer is over anywhere else — the direction of view
   * unchanged. Negative flies back along the same ray.
   */
  flyToward(amount: number, sx: number, sy: number) {
    const [ox, oy, oz] = this.offsetAt(sx, sy)
    const { forward: f } = this.axes()
    // The ray: forward to the target's plane, plus the pointer's offset in it.
    const rx = f[0] * this.distance + ox, ry = f[1] * this.distance + oy, rz = f[2] * this.distance + oz
    const len = Math.hypot(rx, ry, rz) || 1
    this.tx += (rx / len) * amount
    this.ty += (ry / len) * amount
    this.tz += (rz / len) * amount
    this.target = null
  }
  /** Turn the view about the eye: `dYaw` to the right, `dPitch` up, in radians. The eye stays where it is. */
  look(dYaw: number, dPitch: number) {
    const [ex, ey, ez] = this.eye
    this.yaw -= dYaw
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dPitch))
    const cp = Math.cos(this.pitch)
    this.tx = ex - this.distance * cp * Math.sin(this.yaw)
    this.ty = ey - this.distance * Math.sin(this.pitch)
    this.tz = ez - this.distance * cp * Math.cos(this.yaw)
    this.target = null
  }
  /**
   * Take a new view size holding the picture still: the camera does not move; the focal length stays what it was
   * (a taller view sees more, at the same scale) and the principal point slides by (dxPx, dyPx), where the picture
   * is to move on the view. Exact at every depth — the new view is the old one cropped or extended. A move in
   * flight keeps its destination (a fit's centring included) and carries the slide in its starting point.
   */
  holdOnResize(width: number, height: number, dxPx: number, dyPx: number) {
    if (!this.focal && height !== this.height) this.focal = this.canonicalFocal()
    this.width = width
    this.height = height
    this.offsetX += dxPx
    this.offsetY += dyPx
    const t = this.target
    if (t) {
      t.from[6] += dxPx
      t.from[7] += dyPx
    }
  }

  /** Frame a sphere: the canonical projection, the sphere at the centre. */
  fitSphere(cx: number, cy: number, cz: number, radius: number, ms = 0) {
    const r = Math.max(radius, 1e-3)
    const d = (r / Math.sin(this.fov / 2)) * 1.05 * Math.max(1, this.height / this.width)
    this.animateTo({ tx: cx, ty: cy, tz: cz, distance: d, canonical: true }, ms)
  }
  /**
   * Move the camera; `canonical` also brings the projection back to the centred one over `fov` (a framing, not a
   * nudge). Over `ms`, or at once when it is 0 or the system asks for reduced motion.
   */
  animateTo(t: { tx?: number; ty?: number; tz?: number; distance?: number; yaw?: number; pitch?: number; canonical?: boolean }, ms: number) {
    const next = { tx: t.tx ?? this.tx, ty: t.ty ?? this.ty, tz: t.tz ?? this.tz, distance: t.distance ?? this.distance, yaw: t.yaw ?? this.yaw, pitch: t.pitch ?? this.pitch, canonical: !!t.canonical }
    if (ms <= 0 || prefersReducedMotion()) {
      Object.assign(this, next)
      if (next.canonical) this.resetProjection()
      this.target = null
      return
    }
    // `start` is set by the first tick: the glide begins when the first frame runs, whatever the call cost.
    this.target = { ...next, from: [this.tx, this.ty, this.tz, this.distance, this.yaw, this.pitch, this.offsetX, this.offsetY, this.focalPx], start: 0, ms }
  }
  private resetProjection() {
    this.focal = 0
    this.offsetX = 0
    this.offsetY = 0
  }
  tick(now: number): boolean {
    const t = this.target
    if (!t) return false
    if (!t.start) t.start = now
    const k = Math.min(1, (now - t.start) / t.ms)
    const e = 1 - Math.pow(1 - k, 3)
    const f = t.from
    this.tx = f[0] + (t.tx - f[0]) * e
    this.ty = f[1] + (t.ty - f[1]) * e
    this.tz = f[2] + (t.tz - f[2]) * e
    this.distance = f[3] * Math.pow(t.distance / f[3], e)
    this.yaw = f[4] + (t.yaw - f[4]) * e
    this.pitch = f[5] + (t.pitch - f[5]) * e
    if (t.canonical) {
      this.offsetX = f[6] * (1 - e)
      this.offsetY = f[7] * (1 - e)
      this.focal = f[8] * Math.pow(this.canonicalFocal() / f[8], e)
    }
    if (k >= 1) {
      if (t.canonical) this.resetProjection()
      this.target = null
      return false
    }
    return true
  }
  /** Where the camera is going — the end of a flight in progress — or where it is. */
  destination(): { tx: number; ty: number; tz: number; distance: number } {
    const t = this.target
    return t ? { tx: t.tx, ty: t.ty, tz: t.tz, distance: t.distance } : { tx: this.tx, ty: this.ty, tz: this.tz, distance: this.distance }
  }
  get animating(): boolean {
    return this.target !== null
  }
  stop() {
    this.target = null
  }
}

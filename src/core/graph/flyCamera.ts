/**
 * The fly controls' two moves over a 3D camera given as an eye and the point it looks at — what the tools read and
 * set (`graph_viewport`), in a tab or headless: `flyCamera` moves both together (along the line of sight, to the
 * right, and up the world's vertical), `lookCamera` turns the line of sight about the eye (right, and up, stopping
 * short of straight up or down). The engine's own camera does the same for the keys and the mouse
 * (`OrbitCamera.fly` / `look`).
 */
export type Vec3 = { x: number; y: number; z: number }

const MAX_PITCH = 1.5

function lineOfSight(eye: Vec3, at: Vec3): { f: Vec3; d: number } {
  const dx = at.x - eye.x, dy = at.y - eye.y, dz = at.z - eye.z
  const d = Math.hypot(dx, dy, dz) || 1
  return { f: { x: dx / d, y: dy / d, z: dz / d }, d }
}

/** Move the camera by world units: `forward` along the line of sight, `right` level to its right, `up` vertically. */
export function flyCamera(position: Vec3, lookAt: Vec3, forward: number, right: number, up: number): { position: Vec3; lookAt: Vec3 } {
  const { f } = lineOfSight(position, lookAt)
  // Level right: the line of sight crossed with the vertical, normalised (straight up or down has none, so no strafe).
  const rl = Math.hypot(f.x, f.z)
  const r = rl > 1e-9 ? { x: -f.z / rl, y: 0, z: f.x / rl } : { x: 0, y: 0, z: 0 }
  const move = { x: f.x * forward + r.x * right, y: f.y * forward + up, z: f.z * forward + r.z * right }
  return { position: { x: position.x + move.x, y: position.y + move.y, z: position.z + move.z }, lookAt: { x: lookAt.x + move.x, y: lookAt.y + move.y, z: lookAt.z + move.z } }
}

/** Turn the line of sight about the eye by `yaw` radians to the right and `pitch` radians up; the eye stays put. */
export function lookCamera(position: Vec3, lookAt: Vec3, yaw: number, pitch: number): { position: Vec3; lookAt: Vec3 } {
  const { f, d } = lineOfSight(position, lookAt)
  const heading = Math.atan2(f.x, f.z) - yaw
  const elevation = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.asin(Math.max(-1, Math.min(1, f.y))) + pitch))
  const ce = Math.cos(elevation)
  return { position: { ...position }, lookAt: { x: position.x + ce * Math.sin(heading) * d, y: position.y + Math.sin(elevation) * d, z: position.z + ce * Math.cos(heading) * d } }
}

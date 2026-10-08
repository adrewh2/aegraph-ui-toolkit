import { describe, expect, it } from 'vitest'
import { OrbitCamera } from '../engine/camera3'
import { flyCamera, lookCamera } from '../../../core/graph/flyCamera'

/** A camera looking at the origin down −z from the fit distance of a graph about 400 units across. */
function camera() {
  const c = new OrbitCamera()
  c.width = 800
  c.height = 600
  c.fitDistance = 1000
  c.distance = 1000
  c.yaw = 0
  c.pitch = 0
  c.update()
  return c
}
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('orbit controls (the default)', () => {
  it('zoom closes on the point the camera looks at, proportionally, and never passes it', () => {
    const c = camera()
    for (let i = 0; i < 400; i++) c.dolly(0.9)
    expect(c.eye[2]).toBeGreaterThan(0)
    expect([c.tx, c.ty, c.tz]).toEqual([0, 0, 0])
  })
})

describe('fly controls', () => {
  it('fly moves the eye and the point it looks at together, through the graph and past it', () => {
    const c = camera()
    c.fly(2500, 0, 0)
    // From z = 1000 looking down −z: now at z = −1500, still looking the same way, the distance to the target kept.
    close(c.eye, [0, 0, -1500])
    expect(c.distance).toBe(1000)
    expect(c.tz).toBeCloseTo(-2500)
  })

  it('right is level and to the right of the line of sight; up is the world’s vertical', () => {
    const c = camera()
    c.pitch = 0.4
    c.fly(0, 100, 50)
    // Looking down −z (tilted), right is +x and level; up raises y.
    expect(c.tx).toBeCloseTo(100)
    expect(c.ty).toBeCloseTo(50)
    expect(c.tz).toBeCloseTo(0)
  })

  it('look turns the view about the eye: the eye stays put, right turns toward the right, up tilts up', () => {
    const c = camera()
    const eye = [...c.eye]
    c.look(0.3, 0)
    close(c.eye, eye)
    expect(c.tx).toBeGreaterThan(0) // turned toward +x, the camera's right
    c.look(0, 0.2)
    close(c.eye, eye)
    expect(c.ty).toBeGreaterThan(0) // tilted up
  })

  it('half a turn faces back the way the camera came', () => {
    const c = camera()
    c.fly(2500, 0, 0)
    c.look(Math.PI, 0)
    const f = c.axes().forward
    close(f, [0, 0, 1])
  })

  it('the tools’ flyCamera / lookCamera make the same moves as the engine’s camera', () => {
    const c = camera()
    c.yaw = 0.7
    c.pitch = 0.3
    c.update()
    const [ex, ey, ez] = c.eye
    const tool = flyCamera({ x: ex, y: ey, z: ez }, { x: c.tx, y: c.ty, z: c.tz }, 120, -40, 15)
    c.fly(120, -40, 15)
    close([tool.lookAt.x, tool.lookAt.y, tool.lookAt.z], [c.tx, c.ty, c.tz], 4)
    const [fx, fy, fz] = c.eye
    const turned = lookCamera({ x: fx, y: fy, z: fz }, { x: c.tx, y: c.ty, z: c.tz }, 0.25, -0.1)
    c.look(0.25, -0.1)
    close([turned.lookAt.x, turned.lookAt.y, turned.lookAt.z], [c.tx, c.ty, c.tz], 4)
    close([turned.position.x, turned.position.y, turned.position.z], c.eye, 4)
  })
})

describe('the wheel zooms about the pointer, as in 2D', () => {
  /** The world point on the target's plane that is drawn at screen (sx, sy): the target moved by the pointer's offset. */
  const under = (c: OrbitCamera, sx: number, sy: number): [number, number, number] => {
    const at = { x: 0, y: 0 }
    c.project(c.tx, c.ty, c.tz, at)
    const k = c.distance / c.focalPx
    const v = c.view
    const dx = sx - at.x, dy = sy - at.y
    return [c.tx + (v[0] * dx - v[1] * dy) * k, c.ty + (v[4] * dx - v[5] * dy) * k, c.tz + (v[8] * dx - v[9] * dy) * k]
  }
  const drawnAt = (c: OrbitCamera, p: [number, number, number]) => {
    const out = { x: 0, y: 0 }
    c.project(p[0], p[1], p[2], out)
    return [out.x, out.y]
  }

  it('orbiting: dollyAt keeps the point under the pointer under it, in and out, at any angle', () => {
    for (const [yaw, pitch] of [[0, 0], [0.7, 0.4], [-1.2, -0.3]]) {
      const c = camera()
      c.yaw = yaw
      c.pitch = pitch
      c.update()
      const p = under(c, 620, 170)
      close(drawnAt(c, p), [620, 170], 3)
      c.dollyAt(0.5, 620, 170)
      c.update()
      close(drawnAt(c, p), [620, 170], 3)
      expect(c.distance).toBeCloseTo(500, 6)
      c.dollyAt(3, 620, 170)
      c.update()
      close(drawnAt(c, p), [620, 170], 3)
    }
    // At the centre of the view it is the plain dolly: the target stays.
    const c = camera()
    const at = { x: 0, y: 0 }
    c.project(0, 0, 0, at)
    c.dollyAt(0.5, at.x, at.y)
    close([c.tx, c.ty, c.tz], [0, 0, 0])
  })

  it('flying: flyToward moves along the ray through the pointer, so what it points at stays where it is drawn', () => {
    const c = camera()
    c.yaw = 0.5
    c.pitch = 0.2
    c.update()
    const p = under(c, 200, 450)
    c.flyToward(300, 200, 450)
    c.update()
    close(drawnAt(c, p), [200, 450], 3)
    // Nearer: the eye closed on it by the amount flown.
    const d = (e: number[]) => Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2])
    const before = camera()
    before.yaw = 0.5
    before.pitch = 0.2
    before.update()
    expect(d(before.eye) - d(c.eye)).toBeCloseTo(300, 3)
  })
})

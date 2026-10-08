import { describe, expect, it } from 'vitest'
import { easeInOutCubic, zoomDuration, zoomPath } from '../cameraPath'

describe('zoomPath', () => {
  it('starts where it starts and ends where it ends', () => {
    const p = zoomPath({ x: 0, y: 0, w: 100 }, { x: 500, y: -200, w: 40 })
    expect(p.at(0)).toEqual({ x: 0, y: 0, w: 100 })
    expect(p.at(1)).toEqual({ x: 500, y: -200, w: 40 })
    expect(p.at(-1)).toEqual(p.at(0))
    expect(p.at(2)).toEqual(p.at(1))
  })

  it('pulls back mid-way on a long pan at a fixed zoom, and never past what shows both ends', () => {
    // Five screens to the right at the same zoom: the camera rises so both ends fit, then settles back in.
    const p = zoomPath({ x: 0, y: 0, w: 100 }, { x: 500, y: 0, w: 100 })
    const mid = p.at(0.5)
    expect(mid.w).toBeGreaterThan(100)
    expect(mid.x).toBeCloseTo(250, 6)
    expect(mid.y).toBe(0)
    // Monotone in x, and w rises then falls.
    let lastX = -1, lastW = 0, rising = true
    for (let i = 0; i <= 20; i++) {
      const v = p.at(i / 20)
      expect(v.x).toBeGreaterThanOrEqual(lastX)
      if (rising && v.w < lastW) rising = false
      if (!rising) expect(v.w).toBeLessThanOrEqual(lastW + 1e-9)
      lastX = v.x
      lastW = v.w
    }
    expect(rising).toBe(false)
    expect(p.length).toBeGreaterThan(1)
  })

  it('barely rises on a short hop', () => {
    const p = zoomPath({ x: 0, y: 0, w: 100 }, { x: 10, y: 0, w: 100 })
    expect(p.at(0.5).w).toBeGreaterThan(100)
    expect(p.at(0.5).w).toBeLessThan(102)
    expect(p.length).toBeLessThan(0.2)
  })

  it('zooms in place exponentially, so each frame changes the zoom by the same factor', () => {
    const p = zoomPath({ x: 3, y: 4, w: 400 }, { x: 3, y: 4, w: 25 })
    expect(p.at(0.5)).toEqual({ x: 3, y: 4, w: 100 })
    expect(p.at(0.25).w).toBeCloseTo(200, 9)
    expect(p.length).toBeGreaterThan(0)
  })

  it('cuts straight over when a width is unusable', () => {
    const p = zoomPath({ x: 0, y: 0, w: 0 }, { x: 10, y: 10, w: NaN })
    expect(p.at(1)).toEqual({ x: 10, y: 10, w: 1 })
    expect(Number.isFinite(p.at(0.5).x)).toBe(true)
  })
})

describe('zoomDuration', () => {
  it('is a beat for a neighbour and a bounded glide for the far side', () => {
    const near = zoomPath({ x: 0, y: 0, w: 100 }, { x: 5, y: 0, w: 100 })
    const screen = zoomPath({ x: 0, y: 0, w: 100 }, { x: 100, y: 0, w: 100 })
    const far = zoomPath({ x: 0, y: 0, w: 100 }, { x: 100_000, y: 0, w: 100 })
    expect(zoomDuration(near)).toBe(320)
    expect(zoomDuration(screen)).toBeGreaterThan(600)
    expect(zoomDuration(screen)).toBeLessThan(800)
    expect(zoomDuration(far)).toBe(900)
    expect(zoomDuration(far, { max: 500 })).toBe(500)
  })
})

describe('easeInOutCubic', () => {
  it('is symmetric and pinned at both ends', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75), 12)
  })
})

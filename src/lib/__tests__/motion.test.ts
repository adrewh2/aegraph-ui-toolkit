import { afterEach, describe, expect, it, vi } from 'vitest'
import { prefersReducedMotion, resetMotionQuery, scrollBehavior } from '../motion'

describe('reduced motion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMotionQuery()
  })

  it('is off where there is no matchMedia (Node, the headless engine)', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehavior()).toBe('smooth')
  })

  it('follows the system setting, read at each move', () => {
    const mq = { matches: true }
    const matchMedia = vi.fn(() => mq)
    vi.stubGlobal('matchMedia', matchMedia)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehavior()).toBe('auto')
    mq.matches = false
    expect(prefersReducedMotion()).toBe(false)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(matchMedia).toHaveBeenCalledTimes(1)
  })

  it('a camera asked for less motion cuts straight to the view', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { Camera } = await import('../../features/gpugraph/engine/camera')
    const cam = new Camera()
    cam.width = 800
    cam.height = 600
    cam.animateTo(100, 50, 2, undefined)
    expect(cam.animating).toBe(false)
    expect([cam.x, cam.y]).toEqual([100, 50])
  })

  it('and glides otherwise', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { Camera } = await import('../../features/gpugraph/engine/camera')
    const cam = new Camera()
    cam.width = 800
    cam.height = 600
    cam.animateTo(100, 50, 2, undefined)
    expect(cam.animating).toBe(true)
  })
})

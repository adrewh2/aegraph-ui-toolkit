import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraState } from '../view'
import { BG, deepen, fade, FOCUS, parseRgb } from '../focus'

/**
 * Focus colours at their edges — every colour form the renderers see
 * (six and three digit hex, rgb/rgba, hsl with spaces or commas, hues
 * past 360, no saturation), the ones they do not, and the fades and
 * deepenings at 0, 1 and in between — then the camera memory: keyed by
 * picture and renderer, junk in storage, a storage that refuses, and the
 * debounced saver.
 */
const hex = (rgb: [number, number, number] | null) => rgb && `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`

describe('focus colours', () => {
  it('parses hex long and short in any case, rgb and rgba, hsl with commas or spaces, hues past 360 and grey, and refuses the rest', () => {
    expect(parseRgb('#1f1e1b')).toEqual([0x1f, 0x1e, 0x1b])
    expect(parseRgb('#ABC')).toEqual([0xaa, 0xbb, 0xcc])
    expect(parseRgb('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseRgb('rgba(255,0,128,0.5)')).toEqual([255, 0, 128])
    expect(hex(parseRgb('hsl(0 100% 50%)'))).toBe('#ff0000')
    expect(hex(parseRgb('hsl(120, 100%, 25%)'))).toBe('#008000')
    expect(hex(parseRgb('hsla(240 100% 50% / 0.5)'))).toBe('#0000ff')
    expect(hex(parseRgb('hsl(360 100% 50%)'))).toBe('#ff0000')
    expect(hex(parseRgb('hsl(480 100% 50%)'))).toBe('#00ff00') // wraps to 120
    expect(hex(parseRgb('hsl(0 0% 50%)'))).toBe('#808080')
    expect(hex(parseRgb('hsl(211 55% 78%)'))).toBe('#a8c6e6')
    expect(hex(parseRgb('hsl(0 100% 100%)'))).toBe('#ffffff')
    expect(hex(parseRgb('hsl(0 100% 0%)'))).toBe('#000000')
    for (const bad of ['#12345678', '#12', 'red', '', 'rgb(1 2 3)', '#ggg', ' #fff', 'hsl(10)']) expect(parseRgb(bad), bad).toBeNull()
  })

  it('fades toward the page background — none at keep 1, all at keep 0 — from any form, a grey for what it cannot read, the same string each time', () => {
    expect(fade('#1f1e1b', 1)).toBe('#1f1e1b')
    expect(fade('#1f1e1b', 0)).toBe(`#${BG.map((c) => c.toString(16)).join('')}`)
    expect(fade('#000000', 0.5)).toBe('#7d7d7b') // halves round up
    expect(fade('hsl(0 100% 50%)', 0.5)).toBe('#fd7d7b')
    expect(fade('rgb(0, 0, 0)', 0.5)).toBe(fade('#000', 0.5))
    expect(fade('nonsense', 1)).toBe('#999999')
    expect(fade('nonsense', 0)).toBe('#faf9f6')
    expect(fade('#000000', 0.5)).toBe(fade('#000000', 0.5))
  })

  it('deepens toward the ink — none at 0, the ink itself at 1 — and the ink is the focus colour', () => {
    expect(deepen('#ffffff', 0)).toBe('#ffffff')
    expect(deepen('#ffffff', 1)).toBe(FOCUS)
    expect(deepen('#ffffff', 0.5)).toBe('#8f8f8d')
    expect(deepen('#a8c6e6', 0.35)).toBe(deepen('hsl(211 55% 78%)', 0.35))
    expect(deepen('junk', 1)).toBe(FOCUS)
  })
})

/** A localStorage of one object, or one that refuses every write. */
function storage(initial: Record<string, string> = {}, refuse = false) {
  const m = new Map(Object.entries(initial))
  const s = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (refuse) throw new Error('QuotaExceededError')
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  }
  vi.stubGlobal('localStorage', s)
  return s
}
const cam2 = (x: number): CameraState => ({ kind: '2d', x, y: 0, ratio: 1, angle: 0, center: { x, y: 0 } })
const cam3: CameraState = { kind: '3d', position: { x: 1, y: 2, z: 3 }, lookAt: { x: 0, y: 0, z: 0 } }

describe('camera memory', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('remembers one camera per renderer for the picture it saw, hands it back for that key only, and writes it through', async () => {
    const s = storage()
    const { loadCamera, saveCamera } = await import('../cameraMemory')
    expect(loadCamera('2d', 'k1')).toBeUndefined()
    saveCamera('2d', 'k1', cam2(1))
    saveCamera('3d', 'k1', cam3)
    expect(loadCamera('2d', 'k1')).toEqual(cam2(1))
    expect(loadCamera('3d', 'k1')).toEqual(cam3)
    expect(loadCamera('2d', 'k2')).toBeUndefined()
    saveCamera('2d', 'k2', cam2(2))
    expect(loadCamera('2d', 'k1')).toBeUndefined() // one picture per renderer: the newer key replaced the older
    expect(loadCamera('3d', 'k1')).toEqual(cam3)
    expect(JSON.parse(s.dump()['aegraph:explorer:camera'])).toEqual({ '2d': { key: 'k2', camera: cam2(2) }, '3d': { key: 'k1', camera: cam3 } })
  })

  it('starts from what storage holds, from nothing when it holds junk, and keeps working in memory when storage refuses', async () => {
    storage({ 'aegraph:explorer:camera': JSON.stringify({ '2d': { key: 'k', camera: cam2(5) } }) })
    const a = await import('../cameraMemory')
    expect(a.loadCamera('2d', 'k')).toEqual(cam2(5))
    expect(a.loadCamera('3d', 'k')).toBeUndefined()
    vi.resetModules()
    storage({ 'aegraph:explorer:camera': '{not json' })
    const b = await import('../cameraMemory')
    expect(b.loadCamera('2d', 'k')).toBeUndefined()
    vi.resetModules()
    storage({}, true)
    const c = await import('../cameraMemory')
    expect(() => c.saveCamera('2d', 'k', cam2(1))).not.toThrow()
    expect(c.loadCamera('2d', 'k')).toEqual(cam2(1))
  })

  it('the saver writes once, 250 ms after the last bump; flush writes now and cancels the pending write; a null camera is not written', async () => {
    vi.useFakeTimers()
    storage()
    const { cameraSaver, loadCamera } = await import('../cameraMemory')
    let camera: CameraState | null = cam2(1)
    let reads = 0
    const saver = cameraSaver('2d', () => (reads++, { key: 'k', camera }))
    saver.bump()
    saver.bump()
    vi.advanceTimersByTime(249)
    expect(reads).toBe(0)
    vi.advanceTimersByTime(1)
    expect(reads).toBe(1)
    expect(loadCamera('2d', 'k')).toEqual(cam2(1))
    camera = cam2(2)
    saver.bump()
    saver.flush()
    expect(loadCamera('2d', 'k')).toEqual(cam2(2))
    vi.advanceTimersByTime(300)
    expect(reads).toBe(2)
    camera = null
    saver.flush()
    expect(loadCamera('2d', 'k')).toEqual(cam2(2))
    expect(reads).toBe(3)
  })
})

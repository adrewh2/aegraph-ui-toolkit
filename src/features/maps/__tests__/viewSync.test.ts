import { describe, expect, it } from 'vitest'
import { altitudeForView, zoomForAltitude } from '../viewSync'

describe('viewSync', () => {
  it('altitude and zoom are inverses of each other at any latitude and height (within the clamps)', () => {
    for (const lat of [0, 43.7, -33.9, 64]) for (const h of [500, 748, 1200]) for (const z of [5, 8, 12, 15, 16]) {
      expect(zoomForAltitude(altitudeForView(z, lat, h), lat, h)).toBeCloseTo(z, 6)
    }
  })
  it('a city view: zoom 12 over Toronto is a few thousandths of a radius; the whole Earth is far', () => {
    const a = altitudeForView(12, 43.7, 748)
    expect(a).toBeGreaterThan(0.002)
    expect(a).toBeLessThan(0.006)
    expect(altitudeForView(1, 0, 748)).toBe(2.5)
    expect(zoomForAltitude(2.5, 0, 748)).toBeGreaterThanOrEqual(1)
  })
  it('clamps to the globe floor and the flat map ceiling', () => {
    expect(altitudeForView(22, 45, 748)).toBe(2.5e-5)
    expect(zoomForAltitude(1e-7, 45, 748)).toBe(19)
  })
})

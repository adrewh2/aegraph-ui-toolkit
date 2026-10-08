import { describe, expect, it } from 'vitest'
import { categoricalColor, isPaletteId, PALETTES, paletteColor, paletteGradient } from '../palettes'
import { categories, domainOf, normalizer } from '../scales'

describe('palettes', () => {
  it('has valid stops and interpolates between them', () => {
    for (const p of PALETTES) {
      expect(p.stops.length).toBeGreaterThanOrEqual(8)
      for (const s of p.stops) expect(s).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(paletteColor('viridis', 0)).toBe('#440154')
    expect(paletteColor('viridis', 1)).toBe('#fde725')
    expect(paletteColor('viridis', -5)).toBe('#440154')
    expect(paletteColor('greys', 0.5)).toMatch(/^#[0-9a-f]{6}$/)
    expect(paletteColor('viridis', NaN)).toBe('#c9c6bf')
    expect(categoricalColor('tableau10', 0)).toBe('#4e79a7')
    expect(categoricalColor('tableau10', 10)).toBe('#4e79a7')
    expect(isPaletteId('nope')).toBe(false)
    expect(paletteGradient('tableau10')).toContain('linear-gradient')
  })
})

describe('scales', () => {
  it('derives domains and normalises linearly or logarithmically', () => {
    expect(domainOf([3, 1, NaN, 9], 'auto')).toEqual([1, 9])
    expect(domainOf([], 'auto')).toEqual([0, 1])
    expect(domainOf([0, 5, 50], 'auto', true)[0]).toBe(5)
    expect(domainOf([1, 2], [0, 10])).toEqual([0, 10])
    const lin = normalizer([0, 10])
    expect(lin(5)).toBe(0.5)
    expect(lin(50)).toBe(1)
    expect(lin(NaN)).toBeNaN()
    const log = normalizer([1, 100], true)
    expect(log(10)).toBeCloseTo(0.5)
    expect(log(0)).toBeNaN()
    expect(normalizer([4, 4])(4)).toBe(0.5)
  })
  it('buckets categories by frequency with overflow', () => {
    const c = categories(['a', 'b', 'a', 'c', 'c', 'c', undefined, ''], 2)
    expect(c.keys).toEqual(['c', 'a'])
    expect(c.overflow).toBe(1)
    expect(c.index.get('a')).toBe(1)
    expect(categories([3, 3, 1]).keys).toEqual(['3', '1'])
  })
})

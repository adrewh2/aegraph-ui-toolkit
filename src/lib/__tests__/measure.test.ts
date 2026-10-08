import { describe, expect, it } from 'vitest'
import { measure } from '../measure'

describe('measure', () => {
  it('keeps the recent measures of a name, not every one', () => {
    for (let i = 0; i < 1200; i++) measure('t:often', { start: performance.now() })
    measure('t:rare', { start: performance.now() })
    const often = performance.getEntriesByName('t:often', 'measure').length
    expect(often).toBeGreaterThan(0)
    expect(often).toBeLessThanOrEqual(500)
    expect(performance.getEntriesByName('t:rare', 'measure')).toHaveLength(1)
  })
})

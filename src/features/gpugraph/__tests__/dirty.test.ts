import { describe, expect, it } from 'vitest'
import { DIRTY_BLOCK, DirtyBlocks } from '../engine/dirty'

const runs = (d: DirtyBlocks, limit = Infinity) => {
  const out: [number, number][] = []
  d.flush(limit, (a, b) => out.push([a, b]))
  return out
}

describe('DirtyBlocks', () => {
  it('sends two changes far apart as two small runs, not the span between them', () => {
    const d = new DirtyBlocks()
    d.mark(5)
    d.mark(900_000)
    const r = runs(d)
    expect(r).toHaveLength(2)
    const bytes = r.reduce((n, [a, b]) => n + b - a, 0)
    expect(bytes).toBeLessThanOrEqual(2 * DIRTY_BLOCK)
    expect(r[0][0]).toBeLessThanOrEqual(5)
    expect(r[1][1]).toBeGreaterThan(900_000)
    expect(d.any).toBe(false)
  })

  it('covers every marked index, joins near blocks, and clips to the limit', () => {
    const d = new DirtyBlocks()
    const marked = [0, 10, DIRTY_BLOCK * 2 + 3, DIRTY_BLOCK * 50, DIRTY_BLOCK * 50 + 7]
    for (const i of marked) d.mark(i)
    const r = runs(d)
    expect(r).toHaveLength(2)
    for (const i of marked) expect(r.some(([a, b]) => i >= a && i < b)).toBe(true)
    d.mark(3)
    d.mark(100)
    expect(runs(d, 50)).toEqual([[3, 50]])
  })

  it('sends the span whole past the run budget, and markAll as one run', () => {
    const d = new DirtyBlocks()
    for (let k = 0; k < 200; k++) d.mark(k * DIRTY_BLOCK * 10)
    expect(runs(d)).toEqual([[0, 199 * DIRTY_BLOCK * 10 + 1]])
    d.mark(DIRTY_BLOCK * 40)
    d.markAll(10)
    expect(runs(d)).toEqual([[0, DIRTY_BLOCK * 40 + 1]])
    expect(runs(d)).toEqual([])
  })
})

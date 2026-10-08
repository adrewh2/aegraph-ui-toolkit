import { beforeEach, describe, expect, it } from 'vitest'
import { canGoBack, canGoForward, getTrail, jumpTo, record, resetTrail, step } from '../trail'

describe('trail', () => {
  beforeEach(() => resetTrail())

  it('records visits, steps back and forward, and drops the future on a new visit', () => {
    record('/entities')
    record('/entities?category=knowledge&type=theme')
    record('/entities?category=all&pick=abc')
    record('/entities?category=all&pick=abc') // same place twice is one entry
    expect(getTrail().entries.map((e) => e.path)).toHaveLength(3)
    expect(canGoBack()).toBe(true)
    expect(canGoForward()).toBe(false)
    expect(step(-1)).toBe('/entities?category=knowledge&type=theme')
    record('/entities?category=knowledge&type=theme') // the navigation the step caused: not a new entry
    expect(getTrail().index).toBe(1)
    expect(canGoForward()).toBe(true)
    expect(step(1)).toBe('/entities?category=all&pick=abc')
    record('/entities?category=all&pick=abc')
    expect(step(1)).toBeNull()
    expect(step(-1)).toBeTruthy()
    record('/entities?category=knowledge&type=theme')
    record('/scenes?plot=x') // new place from the middle: the pick entry ahead is gone
    expect(getTrail().entries.map((e) => e.path)).toEqual(['/entities', '/entities?category=knowledge&type=theme', '/scenes?plot=x'])
    expect(jumpTo(0)).toBe('/entities')
    record('/entities')
    expect(getTrail().index).toBe(0)
  })

  it('a replace rewrites the current crumb instead of adding one', () => {
    record('/graph/2d?sel=a')
    record('/graph/2d', 'replace') // the explorer consumed ?sel=
    expect(getTrail().entries.map((e) => e.path)).toEqual(['/graph/2d'])
    record('/entities')
    record('/entities?category=resource&type=conversation', 'replace') // a pane host restoring its tab on mount
    expect(getTrail().entries.map((e) => e.path)).toEqual(['/graph/2d', '/entities?category=resource&type=conversation'])
    expect(getTrail().index).toBe(1)
  })
})

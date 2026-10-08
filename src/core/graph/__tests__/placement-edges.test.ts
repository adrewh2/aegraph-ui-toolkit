import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { describePlacement, looksGeographic, place, resolveRegion, transform, type Anchor, type Frame } from '../placement'
import { makeValueContext } from '../values'
import '../types'

/**
 * Placement's edges: every anchor, degenerate bases, a single node, order
 * with blanks, scatters whose values are all equal or unfit for a log
 * scale, rank ties, empty cells, jitter off, stacks with an overflow
 * column and with blanks, circles on a value, and every transform.
 */
const frame: Frame = { viewport: { minX: 0, minY: 0, maxX: 1000, maxY: 500 }, bbox: { minX: -100, minY: -100, maxX: 100, maxY: 100 } }

function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', label: 'A', data: { year: 2001, score: 3, same: 5, cat: 'p' } }),
    createEntity({ id: 'b', type: 'paper', label: 'B', data: { year: 2002, score: 0, same: 5, cat: 'q' } }),
    createEntity({ id: 'c', type: 'paper', label: 'C', data: { year: 2002, score: -1, same: 5, cat: 'r' } }),
    createEntity({ id: 'd', type: 'note', label: 'D', data: { year: 2004, same: 5, cat: 's' } }),
    createEntity({ id: 'e', type: 'note', label: 'E', data: {} }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'view', store: s, slice })
  const nodes = (...ids: string[]) => ids.map((id) => s.get(id)!)
  return { s, values, nodes }
}
const R = { of: 'rect' as const, rect: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }

describe('placement edges', () => {
  it('resolves every anchor, y up, with a margin taken before the size', () => {
    const want: Record<Anchor, [number, number]> = {
      'top-left': [0, 400],
      top: [450, 400],
      'top-right': [900, 400],
      left: [0, 200],
      center: [450, 200],
      right: [900, 200],
      'bottom-left': [0, 0],
      bottom: [450, 0],
      'bottom-right': [900, 0],
    }
    for (const [anchor, [x, y]] of Object.entries(want) as [Anchor, [number, number]][]) expect(resolveRegion({ of: 'viewport', anchor, size: { w: 100, h: 100 } }, frame), anchor).toEqual({ minX: x, minY: y, maxX: x + 100, maxY: y + 100 })
    // A margin insets the base first; a fraction is of the inset base.
    expect(resolveRegion({ of: 'viewport', anchor: 'top-left', margin: 50, size: { fraction: 0.5 } }, frame)).toEqual({ minX: 50, minY: 250, maxX: 500, maxY: 450 })
    // A degenerate base (one held position, or none) becomes a 400-unit box so a placement has room.
    const dot: Frame = { ...frame, bbox: { minX: 7, minY: 7, maxX: 7, maxY: 7 } }
    expect(resolveRegion({ of: 'bbox' }, dot)).toEqual({ minX: -193, minY: -193, maxX: 207, maxY: 207 })
    // No rect given for `rect`: the viewport stands in.
    expect(resolveRegion({ of: 'rect' }, frame)).toEqual(frame.viewport)
  })

  it('grids a single node at the centre, honours cols and spacing, and orders with blanks last both ways', () => {
    const { values, nodes } = fixture()
    const one = place(nodes('a'), { arrangement: 'grid', region: R }, values, frame)
    expect(one.positions.a).toEqual({ x: 50, y: 50 })
    expect(one.cells).toHaveLength(1)
    const spaced = place(nodes('a', 'b', 'c'), { arrangement: 'grid', cols: 3, spacing: 10, region: R }, values, frame)
    expect(spaced.positions.a).toEqual({ x: 5, y: 95 })
    expect(spaced.positions.c).toEqual({ x: 25, y: 95 })
    expect(spaced.region).toEqual({ minX: 0, minY: 90, maxX: 30, maxY: 100 })
    // Ordered by score: c (-1), b (0), a (3), then e with no score — and descending a, b, c, e: the blank stays last.
    const asc = place(nodes('a', 'b', 'c', 'e'), { arrangement: 'grid', cols: 4, order: 'data.score', region: R }, values, frame)
    const col = (r: typeof asc, id: string) => Math.round((r.positions[id].x - 12.5) / 25)
    expect(['c', 'b', 'a', 'e'].map((id) => col(asc, id))).toEqual([0, 1, 2, 3])
    const desc = place(nodes('a', 'b', 'c', 'e'), { arrangement: 'grid', cols: 4, order: 'data.score', desc: true, region: R }, values, frame)
    expect(['a', 'b', 'c', 'e'].map((id) => col(desc, id))).toEqual([0, 1, 2, 3])
    // A z held before is carried; nothing else invents one.
    const kept = place(nodes('a', 'b'), { arrangement: 'grid', region: R }, values, frame, { a: { x: 0, y: 0, z: 9 } })
    expect(kept.positions.a.z).toBe(9)
    expect(kept.positions.b.z).toBeUndefined()
    expect(place([], { arrangement: 'grid', region: R }, values, frame)).toMatchObject({ positions: {}, unplaced: [] })
  })

  it('scatters values that are all equal to the middle, parks what a log scale cannot take, and ranks ties together', () => {
    const { values, nodes } = fixture()
    const flat = place(nodes('a', 'b', 'c'), { arrangement: 'scatter', x: 'data.same', y: 'data.same', region: R }, values, frame)
    expect(flat.unplaced).toEqual([])
    for (const id of ['a', 'b', 'c']) expect(flat.positions[id]).toEqual({ x: 50, y: 50 })
    // Log scale: zero and negative values have no place on it and are parked, left of the region.
    const log = place(nodes('a', 'b', 'c'), { arrangement: 'scatter', x: 'data.score', scale: 'log', region: R }, values, frame)
    expect(log.unplaced.sort()).toEqual(['b', 'c'])
    expect(log.positions.b.x).toBeLessThan(0)
    expect(log.positions.c.y).toBeLessThan(log.positions.b.y)
    expect(log.axes.x?.missing).toBe(2)
    // Rank: b and c share the year 2002 and land at the same x, between a and d.
    const rank = place(nodes('a', 'b', 'c', 'd'), { arrangement: 'scatter', x: 'data.year', scale: 'rank', region: R }, values, frame)
    expect(rank.positions.b.x).toBe(rank.positions.c.x)
    expect(rank.positions.a.x).toBeLessThan(rank.positions.b.x)
    expect(rank.positions.b.x).toBeLessThan(rank.positions.d.x)
    expect(rank.axes.x?.ticks.map((t) => t.label)).toEqual(['0%', '25%', '50%', '75%', '100%'])
    // A node with no value on either axis is parked and counted as missing.
    const holes = place(nodes('a', 'e'), { arrangement: 'scatter', x: 'data.year', y: 'data.score', region: R }, values, frame)
    expect(holes.unplaced).toEqual(['e'])
    expect(holes.axes.x?.missing).toBe(1)
    expect(holes.axes.y?.missing).toBe(1)
  })

  it('bins into cells including empty ones, spreads cell-mates on a spiral unless jitter is off, and lines along one axis', () => {
    const { values, nodes } = fixture()
    const binned = place(nodes('a', 'b', 'c', 'd'), { arrangement: 'scatter', x: 'data.year', bins: { x: 4 }, region: R }, values, frame)
    expect(binned.cells).toHaveLength(4)
    expect(binned.cells!.map((c) => c.count)).toEqual([1, 2, 0, 1])
    expect(binned.axes.x?.kind).toBe('binned')
    expect(binned.axes.x?.ticks).toHaveLength(5)
    // b and c share a cell: apart on the spiral, together with jitter off.
    expect(binned.positions.b).not.toEqual(binned.positions.c)
    const still = place(nodes('a', 'b', 'c', 'd'), { arrangement: 'scatter', x: 'data.year', bins: { x: 4 }, jitter: 'none', region: R }, values, frame)
    expect(still.positions.b).toEqual(still.positions.c)
    expect(still.positions.b.x).toBe(37.5)
    // A line ignores y: the middle of the region, with cell-mates spread around it only when jitter is on.
    const line = place(nodes('a', 'b', 'c', 'd'), { arrangement: 'line', x: 'data.year', y: 'data.score', bins: { x: 2 }, jitter: 'none', region: R }, values, frame)
    expect(new Set(Object.values(line.positions).map((p) => Math.round(p.y)))).toEqual(new Set([50]))
    expect(line.axes.y).toBeUndefined()
    expect(line.cells).toHaveLength(2)
    const jittered = place(nodes('a', 'b', 'c', 'd'), { arrangement: 'line', x: 'data.year', bins: { x: 2 }, region: R }, values, frame)
    for (const p of Object.values(jittered.positions)) expect(Math.abs(p.y - 50)).toBeLessThanOrEqual(0.42 * 50)
    // Deterministic.
    expect(place(nodes('a', 'b', 'c', 'd'), { arrangement: 'scatter', x: 'data.year', bins: { x: 4 }, region: R }, values, frame)).toEqual(binned)
  })

  it('stacks by a category with an overflow column past the bin count, parks nodes with no category, and can drop them', () => {
    const { values, nodes } = fixture()
    const all = nodes('a', 'b', 'c', 'd', 'e')
    const stack = place(all, { arrangement: 'stack', x: 'data.cat', region: R }, values, frame)
    expect(stack.axes.x?.categories).toEqual(['p', 'q', 'r', 's'])
    expect(stack.unplaced).toEqual(['e'])
    expect(stack.cells?.map((c) => c.count)).toEqual([1, 1, 1, 1])
    // More categories than bins: the rest fold into "other", and a node with no value goes there too.
    const folded = place(all, { arrangement: 'stack', x: 'data.cat', bins: { x: 2 }, region: R }, values, frame)
    expect(folded.axes.x?.categories).toEqual(['p', 'q', 'other'])
    expect(folded.unplaced).toEqual([])
    expect(folded.cells?.map((c) => c.count)).toEqual([1, 1, 3])
    // Piles grow upward from the bottom of the region.
    const pile = place(nodes('a', 'b', 'c'), { arrangement: 'stack', x: 'type', spacing: 200, region: R }, values, frame)
    expect(pile.positions.a.x).toBe(pile.positions.b.x)
    expect(pile.positions.b.y).toBeGreaterThan(pile.positions.a.y)
  })

  it('circles by a value for the angle and another for the radius', () => {
    const { values, nodes } = fixture()
    const ring = place(nodes('a', 'b', 'c', 'd', 'e'), { arrangement: 'circle', x: 'data.year', region: R }, values, frame)
    expect(ring.unplaced).toEqual(['e'])
    expect(Math.hypot(ring.positions.a.x - 50, ring.positions.a.y - 50)).toBeCloseTo(50)
    expect(ring.positions.a).toMatchObject({ x: 100, y: 50 }) // the smallest year at angle 0
    expect(ring.positions.b).toEqual(ring.positions.c) // the same year, the same angle
    const dial = place(nodes('a', 'd'), { arrangement: 'circle', x: 'data.year', y: 'data.year', region: R }, values, frame)
    expect(Math.hypot(dial.positions.a.x - 50, dial.positions.a.y - 50)).toBeCloseTo(12.5) // the smallest radius is a quarter
    expect(Math.hypot(dial.positions.d.x - 50, dial.positions.d.y - 50)).toBeCloseTo(50)
  })

  it('places geographically: north up, east right, the shape kept whatever the region, the unlocated parked', () => {
    const s = new EntityStore()
    // Four places: a square 1° of longitude by 1° of latitude at 45°N, and one with no coordinates.
    s.upsertMany([
      createEntity({ id: 'sw', type: 'location', label: 'SW', data: { lat: 45, lng: -80 } }),
      createEntity({ id: 'se', type: 'location', label: 'SE', data: { lat: 45, lng: -79 } }),
      createEntity({ id: 'nw', type: 'location', label: 'NW', data: { lat: 46, lng: -80 } }),
      createEntity({ id: 'ne', type: 'location', label: 'NE', data: { lat: 46, lng: -79 } }),
      createEntity({ id: 'x', type: 'location', label: 'X', data: {} }),
    ])
    const registry = new TypeRegistry(s)
    const slice = applyFilter(s, registry, emptyFilter())
    const values = makeValueContext({ scope: 'view', store: s, slice })
    const all = ['sw', 'se', 'nw', 'ne', 'x'].map((id) => s.get(id)!)
    const r = place(all, { arrangement: 'geo', region: { of: 'viewport' } }, values, frame)
    const p = r.positions
    expect(r.unplaced).toEqual(['x'])
    expect(p.nw.y).toBeGreaterThan(p.sw.y)
    expect(p.se.x).toBeGreaterThan(p.sw.x)
    expect(p.ne.x).toBeCloseTo(p.se.x, 6)
    expect(p.nw.y).toBeCloseTo(p.ne.y, 6)
    // Mercator: a degree of latitude at 45° is taller than a degree of longitude — and the picture is not stretched
    // to the region's 2:1 shape, so that ratio survives.
    const w = p.se.x - p.sw.x
    const h = p.nw.y - p.sw.y
    expect(h / w).toBeGreaterThan(1.3)
    expect(h / w).toBeLessThan(1.6)
    // Fitted to the region, centred: the taller side fills the height.
    expect(h).toBeCloseTo(500, 6)
    expect((p.sw.x + p.se.x) / 2).toBeCloseTo(500, 6)
    expect(r.axes.x?.domain).toEqual([-80, -79])
    // Another region, the same shape.
    const r2 = place(all, { arrangement: 'geo', region: { of: 'rect', rect: { minX: 0, minY: 0, maxX: 100, maxY: 100 } } }, values, frame)
    expect((r2.positions.nw.y - r2.positions.sw.y) / (r2.positions.se.x - r2.positions.sw.x)).toBeCloseTo(h / w, 6)
  })

  it('transforms about a point, aligns every edge, distributes on y, and leaves ids without a position out', () => {
    const pos = { a: { x: 0, y: 0, z: 1 }, b: { x: 10, y: 0 }, c: { x: 20, y: 10 } }
    expect(transform(['a', 'zz'], pos, { translate: { dx: 1, dy: 2, dz: 3 } })).toEqual({ a: { x: 1, y: 2, z: 4 } })
    expect(transform(['b'], pos, { translate: { dz: 3 } }).b.z).toBe(3)
    const about = transform(['a', 'b'], pos, { scale: { sx: 2 }, about: { x: 10, y: 0 } })
    expect(about.a).toMatchObject({ x: -10, y: 0 })
    expect(about.b).toMatchObject({ x: 10, y: 0 })
    const spun = transform(['b', 'c'], pos, { rotate: 180, about: { x: 0, y: 0 } })
    expect(spun.b.x).toBeCloseTo(-10)
    expect(spun.c.y).toBeCloseTo(-10)
    const to = { minX: 100, minY: 100, maxX: 200, maxY: 200 }
    expect(transform(['a', 'b', 'c'], pos, { align: 'right', to }).c.x).toBe(200)
    expect(transform(['a', 'b', 'c'], pos, { align: 'top', to }).c.y).toBe(200)
    expect(transform(['a', 'b', 'c'], pos, { align: 'bottom', to }).a.y).toBe(100)
    expect(transform(['a', 'b', 'c'], pos, { align: 'center-x', to }).b.x).toBe(150)
    expect(transform(['a', 'b', 'c'], pos, { align: 'center-y', to }).a.y).toBe(145)
    // Align without a target is a no-op; distribute needs three.
    expect(transform(['a', 'b', 'c'], pos, { align: 'left' })).toEqual(pos)
    expect(transform(['a', 'b'], pos, { distribute: 'x' })).toEqual({ a: pos.a, b: pos.b })
    const spread = transform(['a', 'b', 'c'], { a: { x: 0, y: 0 }, b: { x: 0, y: 1 }, c: { x: 0, y: 30 } }, { distribute: 'y' })
    expect(spread.b.y).toBe(15)
    expect(transform([], pos, { scale: 2 })).toEqual({})
  })
})

describe('a map keeps its shape', () => {
  /** Toronto, roughly: 43 km east–west, 21 km north–south; a degree east here is cos(43.7°) ≈ 0.72 of a degree north. */
  function toronto() {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'w', type: 'tree', label: 'West', data: { lng: -79.64, lat: 43.7 } }),
      createEntity({ id: 'e', type: 'tree', label: 'East', data: { lng: -79.11, lat: 43.7 } }),
      createEntity({ id: 's', type: 'tree', label: 'South', data: { lng: -79.38, lat: 43.58 } }),
      createEntity({ id: 'n', type: 'tree', label: 'North', data: { lng: -79.38, lat: 43.86 } }),
    ])
    const registry = new TypeRegistry(s)
    const slice = applyFilter(s, registry, emptyFilter())
    const values = makeValueContext({ scope: 'view', store: s, slice })
    return { s, values, nodes: ['w', 'e', 's', 'n'].map((id) => s.get(id)!) }
  }
  const tall = { of: 'rect' as const, rect: { minX: 0, minY: 0, maxX: 100, maxY: 300 } }

  it('lng × lat is geographic by default: one scale for both axes, longitude shortened by cos(latitude), north up, centred in the region', () => {
    const { values, nodes } = toronto()
    const r = place(nodes, { arrangement: 'scatter', x: 'data.lng', y: 'data.lat', jitter: 'none', region: tall }, values, frame)
    const p = r.positions
    const width = p.e.x - p.w.x
    const height = p.n.y - p.s.y
    // 0.53° of longitude × cos(43.72°) ≈ 0.383 "degree units" across against 0.28° up: the city is wider than tall, whatever the region's shape.
    expect(width / height).toBeCloseTo((0.53 * Math.cos((43.72 * Math.PI) / 180)) / 0.28, 1)
    expect(p.n.y).toBeGreaterThan(p.s.y) // north up
    expect(width).toBeLessThanOrEqual(100.0001) // fitted inside the tall region's width…
    expect((p.w.x + p.e.x) / 2).toBeCloseTo(50, 5) // …and centred in it, both ways
    expect((p.s.y + p.n.y) / 2).toBeCloseTo(150, 5)
    expect(r.axes.x?.ticks.every((t) => t.at >= 0 && t.at <= 100)).toBe(true)
    expect(describePlacement({ arrangement: 'scatter', x: 'data.lng', y: 'data.lat', region: tall })).toContain('map shape')
  })

  it('without geo the axes fill the region and the shape follows the region — the tilt the map had; equal keeps the ratio degree for degree', () => {
    const { values, nodes } = toronto()
    const free = place(nodes, { arrangement: 'scatter', x: 'data.lng', y: 'data.lat', geo: false, jitter: 'none', region: tall }, values, frame).positions
    expect(free.e.x - free.w.x).toBeCloseTo(100, 5)
    expect(free.n.y - free.s.y).toBeCloseTo(300, 5) // a wide city drawn three times taller than wide
    const equal = place(nodes, { arrangement: 'scatter', x: 'data.lng', y: 'data.lat', geo: false, aspect: 'equal', jitter: 'none', region: tall }, values, frame).positions
    expect((equal.e.x - equal.w.x) / (equal.n.y - equal.s.y)).toBeCloseTo(0.53 / 0.28, 3)
    expect(describePlacement({ arrangement: 'scatter', x: 'data.lng', y: 'data.lat', geo: false, aspect: 'equal', region: tall })).toContain('equal scale')
  })

  it('recognises the usual names for the two coordinates, and nothing else', () => {
    expect(looksGeographic('data.lng', 'data.lat')).toBe(true)
    expect(looksGeographic('data.longitude', 'data.latitude')).toBe(true)
    expect(looksGeographic('data.lon', 'data.lat')).toBe(true)
    expect(looksGeographic('data.lat', 'data.lng')).toBe(false) // swapped: not a map
    expect(looksGeographic('data.year', 'data.score')).toBe(false)
    expect(looksGeographic(undefined, 'data.lat')).toBe(false)
  })
})

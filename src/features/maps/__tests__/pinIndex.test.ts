import { describe, expect, it } from 'vitest'
import type { GeoEntity } from '../maps'
import { BASE_ZOOM, CLUSTER_PX, cellOf, cellsAt, featureIndex, mercX, mercY, morton, pinIndex } from '../pinIndex'

const loc = (id: string, lat: number, lng: number, tags: string[] = []): GeoEntity => ({ id, type: 'location', label: id, tags, data: { lat, lng }, meta: { createdAt: '', updatedAt: '' } }) as unknown as GeoEntity
const path = (id: string): GeoEntity => ({ id, type: 'path', label: id, tags: [], data: { lat: 43.7, lng: -79.4, geometry: { type: 'LineString', coordinates: [[-79.4, 43.7], [-79.3, 43.8]] } }, meta: { createdAt: '', updatedAt: '' } }) as unknown as GeoEntity

/** A few thousand points scattered over a city, plus two at one spot and a shape. */
function city(n: number) {
  const out: GeoEntity[] = []
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < n; i++) out.push(loc(`t${i}`, 43.6 + rnd() * 0.25, -79.6 + rnd() * 0.5, [i % 3 ? 'genus:acer' : 'genus:quercus']))
  out.push(loc('twin-a', 43.65, -79.4), loc('twin-b', 43.65, -79.4), path('ward'))
  return out
}

describe('pinIndex', () => {
  it('reads every point once: coordinates, shapes apart, a colour per point from the tags, an id index on demand', () => {
    const features = city(2000)
    const ix = pinIndex(features, (tags) => (tags[0] === 'genus:acer' ? '#a' : tags[0] === 'genus:quercus' ? '#q' : undefined), '#x')
    expect(ix.order.length).toBe(2002)
    expect(ix.shapes.length).toBe(1)
    expect(Number.isNaN(ix.coords[2 * ix.shapes[0]])).toBe(true)
    expect([...ix.palette].sort()).toEqual(['#a', '#q', '#x'])
    expect(ix.palette[ix.colorIdx[0]]).toBe('#q')
    expect(ix.palette[ix.colorIdx[1]]).toBe('#a')
    expect(ix.palette[ix.colorIdx[features.findIndex((f) => f.id === 'twin-a')]]).toBe('#x')
    // The same list gives the same index; a different colouring rebuilds the palette on it.
    expect(pinIndex(features, ix.colorOf, '#x')).toBe(ix)
    const again = pinIndex(features, () => '#one', '#x')
    expect(again).toBe(ix)
    expect(again.palette).toEqual(['#one'])
    expect(featureIndex(ix, features, 'twin-b')).toBe(2001)
    expect(featureIndex(ix, features, 'nope')).toBe(-1)
  })

  it('orders the points so that a zoom’s cells are runs: each point in one cell, centroids and members in their cell', () => {
    const features = city(3000)
    const ix = pinIndex(features, undefined, '#x')
    // Every point once, in the order; the prefix sums match the projection.
    expect([...ix.order].sort((a, b) => a - b)).toEqual([...Array(3002).keys()])
    for (const zoom of [8, 12, 16, BASE_ZOOM]) {
      const cells = cellsAt(ix, zoom)
      const seen = new Set<number>()
      const keys = new Set<string>()
      for (const cell of cells) {
        expect(cell.end).toBeGreaterThan(cell.start)
        // No cell twice (a run is the whole cell), the centroid inside it, and so is every member.
        expect(keys.has(`${cell.col},${cell.row}`)).toBe(false)
        keys.add(`${cell.col},${cell.row}`)
        expect(Math.floor(cell.x / CLUSTER_PX)).toBe(cell.col)
        expect(Math.floor(cell.y / CLUSTER_PX)).toBe(cell.row)
        for (let k = cell.start; k < cell.end; k++) {
          const f = ix.order[k]
          expect(seen.has(f)).toBe(false)
          seen.add(f)
          expect(Math.floor(mercX(ix.coords[2 * f + 1], zoom) / CLUSTER_PX)).toBe(cell.col)
          expect(Math.floor(mercY(ix.coords[2 * f], zoom) / CLUSTER_PX)).toBe(cell.row)
          expect(cellOf(ix, zoom, f)).toEqual([cell.col, cell.row])
        }
      }
      expect(seen.size).toBe(ix.order.length)
    }
    // Two points at one spot share a cell at every zoom; at a city-wide zoom most points share cells, at a street
    // zoom nearly none do; a box keeps only the cells inside it.
    const a = features.findIndex((f) => f.id === 'twin-a')
    const b = features.findIndex((f) => f.id === 'twin-b')
    expect(cellOf(ix, 19, a)).toEqual(cellOf(ix, 19, b))
    expect(cellsAt(ix, 8).length).toBeLessThan(50)
    expect(cellsAt(ix, 19).length).toBeGreaterThan(2500)
    expect(cellOf(ix, 12, ix.shapes[0])).toBeNull()
    const all = cellsAt(ix, 14)
    const box = { minX: mercX(-79.4, 14), maxX: mercX(-79.3, 14), minY: mercY(43.8, 14), maxY: mercY(43.7, 14) }
    const inside = cellsAt(ix, 14, box)
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.length).toBeLessThan(all.length)
    for (const c of inside) expect(c.x >= box.minX && c.x <= box.maxX && c.y >= box.minY && c.y <= box.maxY).toBe(true)
  })

  it('keeps the order right across the whole world (the radix sort’s four passes cover a 44-bit code)', () => {
    const wide = [loc('w1', 60, -150), loc('w2', -30, 120), loc('w3', 60.000001, -150.000001), loc('w4', 0, 0), loc('w5', -80, 179)]
    const ix = pinIndex(wide, undefined, '#x')
    const cells = cellsAt(ix, 18)
    expect(cells.length).toBe(4)
    for (const c of cells) for (let k = c.start; k < c.end; k++) expect(cellOf(ix, 18, ix.order[k])).toEqual([c.col, c.row])
  })

  it('interleaves the bits of a 22-bit column and row exactly — the masks agree with a walk over the bit positions', () => {
    const slow = (col: number, row: number) => {
      let code = 0
      let bit = 1
      for (let b = 0; b < 22; b++) {
        if (col & (1 << b)) code += bit
        bit *= 2
        if (row & (1 << b)) code += bit
        bit *= 2
      }
      return code
    }
    let seed = 11
    const rnd = () => (seed = (seed * 16807) % 2147483647)
    const cases: [number, number][] = [[0, 0], [1, 0], [0, 1], [0x3fffff, 0x3fffff], [0xffff, 0x10000], [0x10000, 0xffff], [0x3fffff, 0]]
    for (let i = 0; i < 2000; i++) cases.push([rnd() & 0x3fffff, rnd() & 0x3fffff])
    for (const [c, r] of cases) expect(morton(c, r)).toBe(slow(c, r))
    expect(morton(0x3fffff, 0x3fffff)).toBe(2 ** 44 - 1)
  })
})

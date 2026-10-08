import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { createArea, createLocation, createMap, createPath, geoOf } from '../maps'
import { GEO_COLORS, mapThumb, THUMB_H, THUMB_W } from '../mapCard'

const none = () => undefined
/** Every x,y a path string visits. */
const pts = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])

describe('a map card', () => {
  it('is fitted to what is on the map, not to where the map was left', () => {
    const store = new EntityStore()
    // Left looking at the whole world; its places are in one city.
    const map = createMap(store, { label: 'Paris', center: { lat: 0, lng: 0 }, zoom: 2, layer: 'streets' })
    createLocation(store, { label: 'Louvre', lat: 48.8606, lng: 2.3376, mapId: map.id })
    createLocation(store, { label: 'Eiffel', lat: 48.8584, lng: 2.2945, mapId: map.id })
    createLocation(store, { label: 'Sacré-Cœur', lat: 48.8867, lng: 2.3431, mapId: map.id })
    const t = mapThumb(map, geoOf(store, map), none)
    const all = t.dots.flatMap((d) => pts(d.d))
    expect(all).toHaveLength(3)
    // Every place inside the card, and spread across it rather than a speck in the middle.
    for (const [x, y] of all) expect(x >= 0 && x <= THUMB_W && y >= 0 && y <= THUMB_H).toBe(true)
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
    expect(Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * (THUMB_W / THUMB_H))).toBeGreaterThan(THUMB_W * 0.5)
    // The tiles are Paris's, at a city's zoom, and cover the card.
    expect(t.tiles.length).toBeGreaterThan(0)
    const z = Number(/org\/(\d+)\//.exec(t.tiles[0].url)![1])
    expect(z).toBeGreaterThanOrEqual(11)
    expect(Math.min(...t.tiles.map((x) => x.x))).toBeLessThanOrEqual(0)
    expect(Math.max(...t.tiles.map((x) => x.x + x.size))).toBeGreaterThanOrEqual(THUMB_W)
  })

  it('draws each kind in the colour the map gives it', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'Trip', center: { lat: 45, lng: -121 }, zoom: 9, layer: 'terrain' })
    store.setTagInfo('camp', { color: '#123456' })
    createLocation(store, { label: 'Camp', lat: 45.3, lng: -121.5, mapId: map.id, tags: ['camp'] })
    createLocation(store, { label: 'Trailhead', lat: 45.2, lng: -121.2, mapId: map.id })
    createPath(store, { label: 'Route', coordinates: [[-121.5, 45.3], [-121.4, 45.35], [-121.3, 45.4]], mapId: map.id })
    createArea(store, { label: 'Lake', ring: [[-121.0, 45.0], [-121.0, 45.1], [-120.9, 45.1], [-120.9, 45.0]], mapId: map.id })
    const colorOf = (tags: string[]) => (tags.includes('camp') ? store.tagColor('camp') : undefined)
    const t = mapThumb(map, geoOf(store, map), colorOf)
    expect(t.dots.map((d) => d.color).sort()).toEqual(['#123456', GEO_COLORS.location].sort())
    expect(t.paths).toEqual([expect.objectContaining({ color: GEO_COLORS.path })])
    expect(t.areas).toEqual([expect.objectContaining({ color: GEO_COLORS.area })])
    expect(t.areas[0].d.endsWith('Z')).toBe(true)
    expect(t.tiles[0].url).toContain('opentopomap')
  })

  it('leaves the tiles out when third-party services are off, and keeps the marks', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'x', center: { lat: 0, lng: 0 }, zoom: 3, layer: 'satellite' })
    createLocation(store, { label: 'a', lat: 10, lng: 10, mapId: map.id })
    const t = mapThumb(map, geoOf(store, map), none, { tiles: false })
    expect(t.tiles).toEqual([])
    expect(t.dots).toHaveLength(1)
  })

  it('shows an empty map where the map looks', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'empty', center: { lat: 51.5, lng: -0.12 }, zoom: 12, layer: 'streets' })
    const t = mapThumb(map, [], none)
    expect(t.total).toBe(0)
    expect(t.tiles.every((x) => x.url.includes('/11/') || x.url.includes('/12/'))).toBe(true)
  })

  it('keeps a city of points to a budget, and a stray point does not shrink the picture', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'trees', center: { lat: 43.7, lng: -79.4 }, zoom: 11, layer: 'streets' })
    for (let i = 0; i < 20000; i++) createLocation(store, { label: `t${i}`, lat: 43.6 + ((i * 7919) % 1000) / 5000, lng: -79.6 + ((i * 104729) % 1000) / 2500, mapId: map.id })
    // One tree mistyped at 0,0.
    createLocation(store, { label: 'stray', lat: 0, lng: 0, mapId: map.id })
    const t = mapThumb(map, geoOf(store, map), none)
    const all = t.dots.flatMap((d) => d.d.split('M').length - 1).reduce((a, b) => a + b, 0)
    expect(all).toBeLessThanOrEqual(4000)
    expect(t.total).toBe(20001)
    expect(Number(/org\/(\d+)\//.exec(t.tiles[0].url)![1])).toBeGreaterThanOrEqual(9)
  })

  it('draws a route across the antimeridian the short way', () => {
    const store = new EntityStore()
    const map = createMap(store, { label: 'pacific', center: { lat: 0, lng: 180 }, zoom: 3, layer: 'streets' })
    createPath(store, { label: 'hop', coordinates: [[170, -10], [179, -12], [-179, -14], [-170, -16]], mapId: map.id })
    const t = mapThumb(map, geoOf(store, map), none)
    const xs = pts(t.paths[0].d).map((p) => p[0])
    // Each step a short hop, not a jump across the whole card.
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThan(THUMB_W / 2)
  })
})

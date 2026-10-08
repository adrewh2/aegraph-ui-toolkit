import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { annotateAudio, assignLanes, isActiveAt, normalizeRange, parseSpotify, rangeLabel, retimeAnnotation, spotifyUri, timeAnnotationsOf, type AudioEntity } from '../audio'

describe('parseSpotify', () => {
  it('accepts every link shape', () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT'
    for (const s of [
      `https://open.spotify.com/track/${id}`,
      `https://open.spotify.com/track/${id}?si=abc&nd=1`,
      `https://open.spotify.com/intl-de/track/${id}`,
      `https://open.spotify.com/embed/track/${id}`,
      `spotify:track:${id}`,
      `  https://open.spotify.com/track/${id}  `,
    ])
      expect(parseSpotify(s), s).toEqual({ kind: 'track', id })
    expect(parseSpotify('https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX')).toEqual({ kind: 'album', id: '1ATL5GLyefJaxhQzSPVrLX' })
    expect(parseSpotify('https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5')?.kind).toBe('episode')
  })
  it('rejects other things', () => {
    expect(parseSpotify('https://www.youtube.com/watch?v=abc')).toBeUndefined()
    expect(parseSpotify('https://open.spotify.com/track/short')).toBeUndefined()
    expect(parseSpotify('nonsense')).toBeUndefined()
  })
  it('builds uris', () => {
    expect(spotifyUri('track', 'x'.repeat(22))).toBe(`spotify:track:${'x'.repeat(22)}`)
  })
})

describe('ranges', () => {
  it('normalises order, precision, and collapse', () => {
    expect(normalizeRange({ start: 10.26, end: 5.11 })).toEqual({ start: 5.1, end: 10.3 })
    expect(normalizeRange({ start: -3 })).toEqual({ start: 0 })
    expect(normalizeRange({ start: 10, end: 10.05 })).toEqual({ start: 10 })
    expect(normalizeRange({ start: 100, end: 500 }, 200)).toEqual({ start: 100, end: 200 })
    expect(rangeLabel({ start: 61, end: 125 })).toBe('1:01–2:05')
    expect(rangeLabel({ start: 61 })).toBe('1:01')
  })

  it('packs overlapping spans into lanes', () => {
    const mk = (id: string, start: number, end?: number) => ({ annotation: { id } as never, relationshipId: 'r' + id, time: { kind: 'time' as const, start, end }, selector: undefined }) as never
    const lanes = assignLanes([mk('a', 0, 10), mk('b', 5, 15), mk('c', 12, 20), mk('d', 30)] as never)
    expect(lanes.map((l) => l.lane)).toEqual([0, 1, 0, 0])
  })

  it('creates, orders, activates, and retimes annotations', () => {
    const store = new EntityStore()
    const audio = createEntity({ id: 'm', type: 'audio', label: 'T', data: { url: 'u', provider: 'spotify', spotifyType: 'track', spotifyId: 'x'.repeat(22), uri: 'spotify:track:x', duration: 200 } }) as AudioEntity
    store.upsert(audio)
    annotateAudio(store, audio, { start: 90, end: 120 }, 'bridge')
    annotateAudio(store, audio, { start: 30 }, 'intro')
    const list = timeAnnotationsOf(store, 'm')
    expect(list.map((a) => a.time.start)).toEqual([30, 90])
    expect(list[0].annotation.label).toBe('intro')
    expect(isActiveAt(list[0], 31)).toBe(true)
    expect(isActiveAt(list[0], 40)).toBe(false)
    expect(isActiveAt(list[1], 100)).toBe(true)
    retimeAnnotation(store, list[1], { start: 80, end: 400 }, 200)
    expect(timeAnnotationsOf(store, 'm')[1].time).toEqual({ kind: 'time', start: 80, end: 200 })
  })
})

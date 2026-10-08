import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { clock } from '../../../core/entity/ids'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { annotateVideo, extractStartTime, extractYouTubeId, isActiveAt, normalizeFrameBox, otherAnnotationsOf, parseClock, timeAnnotationsOf, type VideoEntity } from '../videos'
import { createAnnotation } from '../../../core/resources/annotations'

const vid = (s: EntityStore): VideoEntity => {
  const v = createEntity({ type: 'video', label: 'Talk', data: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk' } }) as VideoEntity
  s.upsert(v)
  return v
}

describe('youtube urls', () => {
  it('extracts ids from every common form', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
      'https://youtu.be/dQw4w9WgXcQ?t=10',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ])
      expect(extractYouTubeId(u), u).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeId('https://vimeo.com/123')).toBeUndefined()
    expect(extractYouTubeId('not a url')).toBeUndefined()
  })

  it('extracts start times', () => {
    expect(extractStartTime('https://youtu.be/x?t=90')).toBe(90)
    expect(extractStartTime('https://www.youtube.com/watch?v=x&t=1m30s')).toBe(90)
    expect(extractStartTime('https://www.youtube.com/watch?v=x&t=1h2m3s')).toBe(3723)
    expect(extractStartTime('https://www.youtube.com/watch?v=x')).toBeUndefined()
  })
})

describe('time helpers', () => {
  it('clock and parseClock round-trip', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(95)).toBe('1:35')
    expect(clock(3723)).toBe('1:02:03')
    expect(parseClock('1:35')).toBe(95)
    expect(parseClock('1:02:03')).toBe(3723)
    expect(parseClock('90')).toBe(90)
    expect(parseClock('1m30s')).toBe(90)
    expect(parseClock('2h')).toBe(7200)
    expect(parseClock('abc')).toBeUndefined()
    expect(parseClock('')).toBeUndefined()
  })

  it('normalizeFrameBox clamps to the unit square', () => {
    expect(normalizeFrameBox({ x: 0.5, y: 0.5, width: -0.2, height: 0.7 })).toEqual({ x: 0.3, y: 0.5, width: 0.2, height: 0.5 })
    expect(normalizeFrameBox({ x: 0.1, y: 0.1, width: 0.001, height: 0.1 })).toBeNull()
    expect(normalizeFrameBox({ x: 1.2, y: 1.2, width: 0.5, height: 0.5 })).toBeNull()
  })
})

describe('video annotations', () => {
  it('stores time selectors, sorted, with optional end and region', () => {
    const s = new EntityStore()
    const v = vid(s)
    annotateVideo(s, v, { start: 200.26 }, 'later')
    annotateVideo(s, v, { start: 10, end: 20 }, 'span')
    annotateVideo(s, v, { start: 5, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }, 'box')
    annotateVideo(s, v, { start: 30, end: 20 }, 'bad end') // end before start → dropped
    const list = timeAnnotationsOf(s, v.id)
    expect(list.map((a) => a.time)).toEqual([
      { kind: 'time', start: 5, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
      { kind: 'time', start: 10, end: 20 },
      { kind: 'time', start: 30 },
      { kind: 'time', start: 200.3 },
    ])
    expect(list[0].annotation.data.annotationType).toBe('image')
    expect(list[1].annotation.data.annotationType).toBe('note')
    expect(list[1].annotation.data.pageUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk&t=10s')
    expect(list[3].annotation.label).toBe('later')
    createAnnotation(s, v.id, undefined, { comment: 'whole', annotationType: 'note' })
    expect(otherAnnotationsOf(s, v.id)).toHaveLength(1)
    expect(timeAnnotationsOf(s, v.id)).toHaveLength(4)
  })

  it('isActiveAt uses the span, or a tolerance for moments', () => {
    const s = new EntityStore()
    const v = vid(s)
    annotateVideo(s, v, { start: 10, end: 20 }, 'span')
    annotateVideo(s, v, { start: 50 }, 'moment')
    const [span, moment] = timeAnnotationsOf(s, v.id)
    expect(isActiveAt(span, 15)).toBe(true)
    expect(isActiveAt(span, 9.9)).toBe(true)
    expect(isActiveAt(span, 21)).toBe(false)
    expect(isActiveAt(moment, 51)).toBe(true)
    expect(isActiveAt(moment, 52)).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryPreviewStore, onPreviewCached, previewKey, readPreview, usePreviewStore, writePreview } from '../previewCache'

/** The pictures this browser has drawn for scenes that arrived without one. */
describe('the scene preview cache', () => {
  beforeEach(() => usePreviewStore(memoryPreviewStore(300)))

  it('keys a picture to the scene and the moment it changed, so an edited scene never shows the old picture', async () => {
    const before = previewKey('scene:1', '2026-09-26T10:00:00.000Z')
    const after = previewKey('scene:1', '2026-09-26T11:00:00.000Z')
    expect(before).not.toBe(after)
    await writePreview(before, 'data:image/jpeg;base64,AAAA')
    expect(await readPreview(before)).toBe('data:image/jpeg;base64,AAAA')
    expect(await readPreview(after)).toBeNull()
    expect(await readPreview(previewKey('scene:2', '2026-09-26T10:00:00.000Z'))).toBeNull()
  })

  it('tells the cards when a picture lands, so one drawn as a sketch becomes the real one', async () => {
    let told = 0
    const off = onPreviewCached(() => told++)
    await writePreview(previewKey('scene:3', 'x'), 'data:image/jpeg;base64,BBBB')
    expect(told).toBe(1)
    off()
    await writePreview(previewKey('scene:4', 'x'), 'data:image/jpeg;base64,CCCC')
    expect(told).toBe(1)
  })

  it('keeps the newest and forgets the oldest rather than growing without end', async () => {
    usePreviewStore(memoryPreviewStore(10))
    for (let i = 0; i < 14; i++) await writePreview(previewKey('s', `2026-09-26T${String(i).padStart(4, '0')}`), 'data:image/jpeg;base64,DD')
    expect(await readPreview(previewKey('s', '2026-09-26T0000'))).toBeNull()
    expect(await readPreview(previewKey('s', '2026-09-26T0013'))).toBe('data:image/jpeg;base64,DD')
  })

  describe('in IndexedDB', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      usePreviewStore(memoryPreviewStore(300))
    })

    it('opens one connection for the page, not one per read', async () => {
      // Just enough of IndexedDB for a read: `open` answers with a database whose every `get` finds nothing.
      let opens = 0
      const later = <T extends { onsuccess?: (() => void) | null }>(req: T) => (setTimeout(() => req.onsuccess?.()), req)
      const conn = { transaction: () => ({ objectStore: () => ({ get: () => later({ result: undefined, onsuccess: null as (() => void) | null }) }) }) }
      vi.stubGlobal('indexedDB', {
        open: () => {
          opens++
          return later({ result: conn, onsuccess: null as (() => void) | null })
        },
      })
      usePreviewStore(null)
      await Promise.all(Array.from({ length: 12 }, (_, i) => readPreview(previewKey(`scene:${i}`, 'x'))))
      expect(await readPreview(previewKey('scene:again', 'x'))).toBeNull()
      expect(opens).toBe(1)
    })
  })
})

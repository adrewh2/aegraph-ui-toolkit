import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { setPlayback, setPlayerHandle } from '../../videos/playback'
import { timeAnnotationsOf } from '../../videos/videos'
import { createMediaTools } from '../mediaTools'
import { withInputChecks } from '../validate'
import type { AppHost } from '../tools'

/**
 * capture_video_frame over a fake player: no player is an error, a
 * declined capture is an error, a still becomes an annotation at the
 * playhead with the picture attached and comes back as an image block;
 * `time` seeks and pauses first.
 */
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function setup() {
  const store = new EntityStore()
  const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
  const t = withInputChecks(createMediaTools(host).find((x) => x.name === 'capture_video_frame') as BetaRunnableTool)
  const run = async (input: unknown) => t.run(t.parse(input)) as Promise<{ type: string; text?: string; source?: { media_type: string; data: string } }[]>
  const video = createEntity({ type: 'video', label: 'Talk', data: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk' } })
  store.upsert(video)
  return { store, run, video }
}

describe('capture_video_frame', () => {
  afterEach(() => {
    setPlayback(null)
    setPlayerHandle(null)
    vi.useRealTimers()
  })

  it('needs an open player, and a capture that succeeds', async () => {
    const { run, video } = setup()
    await expect(run({})).rejects.toThrow(/No video is open/)
    setPlayback({ videoId: video.id, currentTime: 12, playing: true })
    setPlayerHandle({ seek: () => {}, play: () => {}, pause: () => {}, capture: async () => undefined })
    await expect(run({})).rejects.toThrow(/could not be captured/)
  })

  it('saves the still as an annotation at the playhead and returns the picture', async () => {
    const { store, run, video } = setup()
    setPlayback({ videoId: video.id, currentTime: 12.5, playing: true })
    const calls: string[] = []
    setPlayerHandle({ seek: (t) => calls.push(`seek:${t}`), play: () => calls.push('play'), pause: () => calls.push('pause'), capture: async () => ({ dataUrl: PNG, width: 640, height: 360 }) })
    const blocks = await run({ comment: 'the slide', tags: ['slide'] })
    expect(calls).toEqual([])
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
    expect(blocks[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' })
    const head = JSON.parse(blocks[0].text!)
    expect(head).toMatchObject({ type: 'annotation', time: 12.5, still: { width: 640, height: 360 } })
    const [va] = timeAnnotationsOf(store, video.id)
    expect(va).toBeDefined()
    expect(va.time.start).toBe(12.5)
    const a = va.annotation
    expect(a.id).toBe(head.id)
    expect(a.tags).toContain('slide')
    expect(a.data).toMatchObject({ comment: 'the slide', imageUrl: PNG, imageWidth: 640, imageHeight: 360 })
    expect(a.meta.source).toBe('assistant')
  })

  it('seeks and pauses first when a time is given, and marks the still at that time', async () => {
    const { run, video } = setup()
    vi.useFakeTimers()
    setPlayback({ videoId: video.id, currentTime: 3, playing: true })
    const calls: string[] = []
    setPlayerHandle({ seek: (t) => calls.push(`seek:${t}`), play: () => calls.push('play'), pause: () => calls.push('pause'), capture: async () => ({ dataUrl: PNG, width: 16, height: 9 }) })
    const pending = run({ time: 42 })
    await vi.advanceTimersByTimeAsync(1000)
    const blocks = await pending
    expect(calls).toEqual(['seek:42', 'pause'])
    expect(JSON.parse(blocks[0].text!)).toMatchObject({ time: 42 })
  })
})

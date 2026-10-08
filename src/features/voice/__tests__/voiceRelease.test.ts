import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Listener, ListenerHandlers } from '../listeners'

/**
 * A listener that fails for good (a rejected key, a denied microphone) is let go, not just forgotten: the
 * transcription listener holds the microphone's stream and an AudioContext, which would stay open — and keep
 * hearing — under the next one voice starts.
 */
describe('voice controller', () => {
  afterEach(() => {
    vi.doUnmock('../listeners')
    vi.resetModules()
  })

  it('stops a listener that reports a fatal error', async () => {
    const made: { h: ListenerHandlers; l: Listener & { stop: ReturnType<typeof vi.fn> } }[] = []
    const create = (h: ListenerHandlers) => {
      const l = { start: vi.fn(), stop: vi.fn(), mute: vi.fn(), unmute: vi.fn() }
      made.push({ h, l })
      return l
    }
    vi.resetModules()
    vi.doMock('../listeners', () => ({
      recognitionCtor: () => class {},
      canCapture: () => true,
      createWebSpeechListener: create,
      createOpenAiListener: (_s: unknown, h: ListenerHandlers) => create(h),
    }))
    const { voice } = await import('../voice')
    voice.start()
    expect(made).toHaveLength(1)
    made[0].h.onError('OpenAI rejected the key for transcription.', true)
    expect(made[0].l.stop).toHaveBeenCalledTimes(1)
    expect(voice.getState()).toMatchObject({ enabled: false, status: 'error' })
    // On again: a new listener, and the old one is not the one left running.
    voice.start()
    expect(made).toHaveLength(2)
    voice.stop()
    expect(made[1].l.stop).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { bestBrowserVoice, chunkForSpeech, fetchOpenAiSpeech, playStreamed } from '../speakers'
import type { OpenAiAccess } from '../access'
import type { VoiceSettings } from '../settings'

const v = (name: string, lang = 'en-US', extra: Partial<{ default: boolean }> = {}) => ({ name, lang, ...extra })

describe('bestBrowserVoice', () => {
  it('prefers premium and enhanced voices over the default, and never a novelty one', () => {
    const voices = [v('Samantha', 'en-US', { default: true }), v('Zarvox'), v('Ava (Premium)'), v('Samantha (Enhanced)'), v('Bells'), v('Thomas', 'fr-FR')]
    expect(bestBrowserVoice(voices, 'en-US')?.name).toBe('Ava (Premium)')
    expect(bestBrowserVoice(voices.filter((x) => !/Premium/.test(x.name)), 'en-US')?.name).toBe('Samantha (Enhanced)')
  })
  it("takes Chrome's Google voice over a compact default, and the language's own variant over another", () => {
    expect(bestBrowserVoice([v('Samantha', 'en-US', { default: true }), v('Google US English')], 'en-US')?.name).toBe('Google US English')
    expect(bestBrowserVoice([v('Daniel', 'en-GB'), v('Samantha', 'en-US')], 'en-GB')?.name).toBe('Daniel')
    expect(bestBrowserVoice([v('Daniel', 'en-GB')], 'en-US')?.name).toBe('Daniel')
  })
  it('is undefined when nothing speaks the language', () => {
    expect(bestBrowserVoice([v('Thomas', 'fr-FR'), v('Zarvox')], 'en-US')).toBeUndefined()
  })
})

describe('chunkForSpeech', () => {
  it('groups sentences up to the size, never splitting one', () => {
    const chunks = chunkForSpeech('One is short. Two is also short. Three is a somewhat longer sentence than the others. Four.', 40)
    expect(chunks).toEqual(['One is short. Two is also short.', 'Three is a somewhat longer sentence than the others.', 'Four.'])
  })
})

describe('fetchOpenAiSpeech', () => {
  const settings: VoiceSettings = { listener: 'browser', openaiSttModel: 'gpt-4o-mini-transcribe', speaker: 'openai', browserVoice: '', openaiKey: 'sk-test', openaiVoice: 'nova', pauseMs: 2000 }
  const key: OpenAiAccess = { kind: 'key', key: 'sk-test' }
  it('posts the text with the key and returns the audio', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-4o-mini-tts', voice: 'nova', input: 'Hello.', response_format: 'mp3' })
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200 })
    })
    const blob = await fetchOpenAiSpeech('Hello.', settings, key, new AbortController().signal, fetchFn as unknown as typeof fetch)
    expect(blob.size).toBe(3)
  })
  it('explains a rejected key and a failed request', async () => {
    const bad = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
    await expect(fetchOpenAiSpeech('x', settings, key, new AbortController().signal, bad(401, '{}'))).rejects.toThrow(/rejected the key for speech/)
    await expect(fetchOpenAiSpeech('x', settings, key, new AbortController().signal, bad(429, '{"error":{"message":"slow down"}}'))).rejects.toThrow(/429.*slow down/)
  })
  it('speaks through the dev server locally', async () => {
    const local: OpenAiAccess = { kind: 'local' }
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/openai\/v1\/audio\/speech$/)
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      return new Response(new Blob([new Uint8Array(2)]), { status: 200 })
    })
    expect((await fetchOpenAiSpeech('Hi.', settings, local, new AbortController().signal, fetchFn as unknown as typeof fetch)).size).toBe(2)
  })
})

describe('playStreamed', () => {
  it('lets the MediaSource go when playback fails, as when it ends', async () => {
    const revoked: string[] = []
    let sourceOpen: (() => void) | null = null
    class FakeMediaSource {
      readyState = 'open'
      addEventListener(_: string, f: () => void) {
        sourceOpen = f
      }
      addSourceBuffer() {
        const listeners: (() => void)[] = []
        return { appendBuffer: () => queueMicrotask(() => listeners.splice(0).forEach((f) => f())), addEventListener: (_: string, f: () => void) => listeners.push(f) }
      }
      endOfStream() {}
    }
    const paused = vi.fn()
    class FakeAudio {
      src: string
      onplaying = null
      onended = null
      onerror = null
      constructor(src: string) {
        this.src = src
      }
      pause = paused
      load() {}
      removeAttribute() {}
      play = () => Promise.reject(new Error('NotAllowedError: play() needs a gesture'))
    }
    vi.stubGlobal('MediaSource', FakeMediaSource)
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:voice-1', revokeObjectURL: (u: string) => void revoked.push(u) })
    try {
      const p = playStreamed(new Response(new Uint8Array([1, 2, 3])), new AbortController().signal)
      sourceOpen!()
      await expect(p).rejects.toThrow(/gesture/)
      expect(revoked).toEqual(['blob:voice-1'])
      expect(paused).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

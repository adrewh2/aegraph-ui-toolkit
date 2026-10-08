import { describe, expect, it, vi } from 'vitest'
import { concatFrames, encodeWav, rms, transcribeOpenAi, VoiceActivity } from '../capture'
import type { OpenAiAccess } from '../access'
import type { VoiceSettings } from '../settings'

describe('VoiceActivity', () => {
  const FRAME = 128
  /** Feed `n` frames at a loudness; the events that came out. */
  const run = (vad: VoiceActivity, level: number, n: number) => Array.from({ length: n }, () => vad.feed(level, FRAME)).filter(Boolean)

  it('starts on sustained sound and ends after the pause of silence', () => {
    const vad = new VoiceActivity({ pauseMs: 1000 })
    expect(run(vad, 0.003, 10)).toEqual([]) // room tone
    expect(run(vad, 0.2, 1)).toEqual([]) // one loud frame is a click
    expect(run(vad, 0.2, 1)).toEqual(['start'])
    expect(vad.isSpeaking).toBe(true)
    expect(run(vad, 0.15, 10)).toEqual([])
    expect(run(vad, 0.003, 7)).toEqual([]) // 896 ms quiet: not yet
    expect(run(vad, 0.003, 1)).toEqual(['end'])
    expect(vad.isSpeaking).toBe(false)
  })

  it('drops a blip shorter than speech', () => {
    const vad = new VoiceActivity({ pauseMs: 500 })
    run(vad, 0.003, 5)
    expect(run(vad, 0.3, 2)).toEqual(['start']) // 256 ms of sound: a door, not a word
    expect(run(vad, 0.003, 4)).toEqual(['drop'])
  })

  it('raises the threshold in a noisy room and never during speech', () => {
    const vad = new VoiceActivity({ pauseMs: 500 })
    const quiet = vad.threshold
    run(vad, 0.02, 200) // a fan
    expect(vad.threshold).toBeGreaterThan(quiet)
    expect(run(vad, 0.02, 5)).toEqual([]) // the fan is not speech
    run(vad, 0.5, 2)
    const during = vad.threshold
    run(vad, 0.5, 20)
    expect(vad.threshold).toBe(during)
  })

  it('sends an utterance that goes on past the maximum, and the talking after it starts the next', () => {
    const vad = new VoiceActivity({ pauseMs: 500, maxSpeechMs: 2000 })
    run(vad, 0.2, 2)
    expect(run(vad, 0.2, 20)).toEqual(['end', 'start'])
  })
})

describe('encodeWav', () => {
  it('writes a 16-bit mono header and clamps samples', () => {
    const blob = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16000)
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + 5 * 2)
  })
  it('joins frames and measures loudness', () => {
    const a = new Float32Array([0.5, 0.5])
    const b = new Float32Array([-0.5, -0.5])
    expect([...concatFrames([a, b])]).toEqual([0.5, 0.5, -0.5, -0.5])
    expect(rms(concatFrames([a, b]))).toBeCloseTo(0.5)
    expect(rms(new Float32Array())).toBe(0)
  })
})

describe('transcribeOpenAi', () => {
  const settings: VoiceSettings = { listener: 'openai', openaiSttModel: 'gpt-4o-mini-transcribe', speaker: 'browser', browserVoice: '', openaiKey: 'sk-test', openaiVoice: 'nova', pauseMs: 2000 }
  const key: OpenAiAccess = { kind: 'key', key: 'sk-test' }
  it('posts the clip as multipart with the model, language and vocabulary hint', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
      const form = init?.body as FormData
      expect(form.get('model')).toBe('gpt-4o-mini-transcribe')
      expect(form.get('language')).toBe('en')
      expect(form.get('prompt')).toBe('Aegraph, Ada Lovelace')
      expect((form.get('file') as File).name).toBe('speech.wav')
      return new Response(JSON.stringify({ text: '  Filter the graph to Ada Lovelace. ' }), { status: 200 })
    })
    const text = await transcribeOpenAi(encodeWav(new Float32Array(160), 16000), settings, key, { hint: 'Aegraph, Ada Lovelace', language: 'en', fetchFn: fetchFn as unknown as typeof fetch })
    expect(text).toBe('Filter the graph to Ada Lovelace.')
  })
  it('explains a rejected key', async () => {
    const bad = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    await expect(transcribeOpenAi(new Blob(), settings, key, { fetchFn: bad })).rejects.toThrow(/rejected the key/)
  })
  it('goes through the dev server locally, with no key of its own, and explains its refusals', async () => {
    const local: OpenAiAccess = { kind: 'local' }
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/openai\/v1\/audio\/transcriptions$/)
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      return new Response(JSON.stringify({ text: 'hi' }), { status: 200 })
    })
    expect(await transcribeOpenAi(new Blob(), settings, local, { fetchFn: fetchFn as unknown as typeof fetch })).toBe('hi')
    const status = (n: number) => (async () => new Response('{}', { status: n })) as unknown as typeof fetch
    await expect(transcribeOpenAi(new Blob(), settings, local, { fetchFn: status(401) })).rejects.toThrow(/key in \.env\.local/)
    await expect(transcribeOpenAi(new Blob(), settings, local, { fetchFn: status(403) })).rejects.toThrow(/refused/)
    await expect(transcribeOpenAi(new Blob(), settings, local, { fetchFn: status(503) })).rejects.toThrow(/not set up/)
  })
})

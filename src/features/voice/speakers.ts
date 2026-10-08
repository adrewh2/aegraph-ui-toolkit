import { externalServicesAllowed } from '../account/settings'
import { explainFailure, openAiAccess, openAiRequest, type OpenAiAccess } from './access'
import { OPENAI_TTS_MODEL, type VoiceSettings } from './settings'

/**
 * The speakers: something that reads a piece of prose aloud and can be cut
 * off. The browser one uses speechSynthesis with the best voice installed
 * (the default is usually the worst one) — and with Third-party services off
 * only a voice on the device (`localService`), since a network voice sends the
 * text it reads to its provider; the OpenAI one fetches neural
 * speech chunk by chunk and plays it as it arrives.
 */

export interface Speaker {
  /** Read `text`; `onStart` fires when sound begins. Resolves when done or cancelled; rejects when it could not speak at all. */
  speak(text: string, onStart?: () => void): Promise<void>
  cancel(): void
  /** Start synthesising `text` now so a later `speak(text)` begins at once. Optional. */
  prefetch?(text: string): void
}

// ── Browser ──────────────────────────────────────────────────────────

/** macOS ships these novelty and legacy voices; none of them should read a reply. */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|rocko|grandma|grandpa|shelley|sandy|flo|eddy|reed|eloquence)\b/i

/** The best voice for a language among those installed: premium and neural voices first, the default last. */
export function bestBrowserVoice<V extends { name: string; lang: string; default?: boolean; localService?: boolean }>(voices: readonly V[], lang: string): V | undefined {
  const base = lang.toLowerCase().split('-')[0]
  const score = (v: V) => {
    const n = v.name
    const l = v.lang.toLowerCase().replace('_', '-')
    let s = 0
    if (l === lang.toLowerCase()) s += 10
    else if (l.startsWith(base)) s += 5
    else return -1
    if (NOVELTY.test(n)) return -1
    if (/premium/i.test(n)) s += 40
    if (/enhanced/i.test(n)) s += 30
    if (/siri/i.test(n)) s += 35
    if (/natural|neural/i.test(n)) s += 25 // Edge's online voices
    if (/^google /i.test(n)) s += 20 // Chrome's own, network-based
    if (/microsoft .* online/i.test(n)) s += 20
    if (/compact/i.test(n)) s -= 20
    if (v.default) s += 1
    return s
  }
  let best: V | undefined
  let bestScore = -1
  for (const v of voices) {
    const s = score(v)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  return best
}

/** The list of voices, which Chrome fills in asynchronously the first time. */
export function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      resolve(speechSynthesis.getVoices())
    }
    speechSynthesis.addEventListener('voiceschanged', done)
    setTimeout(done, 1500)
  })
}

const lang = () => (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US')

/** Sentences grouped into chunks of about `max` characters — one utterance / one request each. */
export function chunkForSpeech(text: string, max = 350): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur)
      cur = s
    } else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

/** What the browser speaker says with Third-party services off and no voice on the device. */
export const OFFLINE_SPEAKING = 'This browser has no voice on the device — only ones that send the text they read to their provider — and Third-party services is off in your account settings.'

export function createBrowserSpeaker(settings: () => VoiceSettings): Speaker {
  let active = 0
  return {
    async speak(text, onStart) {
      const s = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
      if (!s) throw new Error('This browser cannot speak (no speechSynthesis).')
      const gen = ++active
      const voices = await browserVoices()
      if (gen !== active) return
      // A voice that is not on the device (Chrome's Google voices, Edge's online ones) sends the text it reads to its
      // provider: with Third-party services off only the device's own voices read.
      const usable = externalServicesAllowed() ? voices : voices.filter((v) => v.localService)
      if (!usable.length && voices.length) throw new Error(OFFLINE_SPEAKING)
      const wanted = settings().browserVoice
      const voice = (wanted && usable.find((v) => v.name === wanted)) || bestBrowserVoice(usable, lang()) || (externalServicesAllowed() ? undefined : usable[0])
      // Chrome cuts long utterances off after ~15 s; one utterance per sentence keeps it talking.
      const chunks = text.match(/[^.!?\n]+[.!?]*\s*/g)?.map((c) => c.trim()).filter(Boolean) ?? [text]
      await new Promise<void>((resolve) => {
        let left = chunks.length
        let started = false
        const finish = () => {
          if (--left === 0) resolve()
        }
        for (const chunk of chunks) {
          const u = new SpeechSynthesisUtterance(chunk)
          u.lang = voice?.lang ?? lang()
          if (voice) u.voice = voice
          u.rate = 1
          u.onstart = () => {
            if (!started) {
              started = true
              onStart?.()
            }
          }
          u.onend = finish
          u.onerror = finish
          s.speak(u)
        }
      })
    },
    cancel() {
      active++
      if (typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel()
    },
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────

/** One request to the speech endpoint; the response streams mp3 bytes as they are synthesised. */
export async function requestOpenAiSpeech(text: string, settings: VoiceSettings, access: OpenAiAccess, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Response> {
  const { url, headers } = await openAiRequest(access, 'v1/audio/speech')
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: settings.openaiVoice, input: text, response_format: 'mp3' }),
    signal,
  })
  if (!res.ok) throw await explainFailure(res, access, 'speech')
  return res
}

/** The whole clip as a blob. */
export async function fetchOpenAiSpeech(text: string, settings: VoiceSettings, access: OpenAiAccess, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Blob> {
  return (await requestOpenAiSpeech(text, settings, access, signal, fetchFn)).blob()
}

/** Whether the browser can play mp3 as it arrives (Media Source Extensions with an mp3 buffer). */
export const canStreamMp3 = () => typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported('audio/mpeg')

/**
 * Play a streaming mp3 response as it arrives: the bytes are appended to a MediaSource buffer and playback
 * starts on the first ones, so speech begins within a few hundred milliseconds of the request rather than
 * after the whole clip is synthesised. Resolves when playback ends (or the signal aborts).
 */
export function playStreamed(res: Response, signal: AbortSignal, onStart?: () => void, hold?: (a: HTMLAudioElement | null) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ms = new MediaSource()
    const a = new Audio(URL.createObjectURL(ms))
    hold?.(a)
    let started = false
    let finished = false
    // Cut off, finished or failed: the element must stop, not just be forgotten — a forgotten one plays on under the
    // next — and the MediaSource's URL goes, or the source and every byte appended to it stay reachable through it.
    const release = () => {
      if (finished) return false
      finished = true
      a.pause()
      const src = a.src
      a.removeAttribute('src')
      a.load()
      hold?.(null)
      URL.revokeObjectURL(src)
      return true
    }
    const done = () => {
      if (release()) resolve()
    }
    const fail = (err: unknown) => {
      if (release()) reject(err)
    }
    a.onplaying = () => {
      if (!started) {
        started = true
        onStart?.()
      }
    }
    a.onended = done
    a.onerror = () => fail(new Error('The audio could not be played.'))
    signal.addEventListener('abort', done, { once: true })
    ms.addEventListener('sourceopen', () => {
      void (async () => {
        const sb = ms.addSourceBuffer('audio/mpeg')
        const reader = res.body?.getReader()
        if (!reader) throw new Error('No audio in the response.')
        const appended = () => new Promise<void>((r) => sb.addEventListener('updateend', () => r(), { once: true }))
        let playing = false
        for (;;) {
          const { value, done: end } = await reader.read()
          if (signal.aborted) return
          if (end) break
          sb.appendBuffer(value)
          await appended()
          if (!playing) {
            playing = true
            a.play().catch(fail)
          }
        }
        if (ms.readyState === 'open') ms.endOfStream()
        if (!playing) done() // nothing came back
      })().catch(fail)
    })
  })
}

/**
 * Neural speech from OpenAI: the text goes in sentence groups, each fetched while the previous one plays, so a
 * long reply starts within a second or two rather than after the whole thing is synthesised.
 */
export function createOpenAiSpeaker(settings: () => VoiceSettings): Speaker {
  let abort: AbortController | null = null
  let audio: HTMLAudioElement | null = null
  /** A request started ahead of its `speak`, so consecutive sentences play back to back. */
  let ahead: { text: string; ac: AbortController; res: Promise<Response> } | null = null
  const request = (text: string) => {
    const s = settings()
    const access = openAiAccess()
    if (!access) throw new Error('No way to reach OpenAI for voice — add a key in the assistant settings.')
    const ac = new AbortController()
    const res = requestOpenAiSpeech(text, s, access, ac.signal)
    res.catch(() => {})
    return { text, ac, res }
  }
  return {
    prefetch(text) {
      if (ahead?.text === text) return
      ahead?.ac.abort()
      ahead = null
      try {
        ahead = request(text)
      } catch {
        /* no access: speak() will say so */
      }
    },
    async speak(text, onStart) {
      const s = settings()
      const access = openAiAccess()
      if (!access) throw new Error('No way to reach OpenAI for voice — add a key in the assistant settings.')
      this.cancel()
      if (canStreamMp3()) {
        // One request, played as it streams in — the one started by `prefetch` when it is this text.
        const pending = ahead?.text === text ? ahead : request(text)
        ahead = null
        abort = pending.ac
        const res = await pending.res
        if (pending.ac.signal.aborted) return
        await playStreamed(res, pending.ac.signal, onStart, (a) => (audio = a))
        return
      }
      const ac = new AbortController()
      abort = ac
      const chunks = chunkForSpeech(text)
      // No MSE: sentence groups as whole clips, the fetch for chunk i+1 in flight while chunk i plays.
      const clip = (i: number) => {
        const p = fetchOpenAiSpeech(chunks[i], s, access, ac.signal)
        p.catch(() => {}) // a cancelled prefetch nobody awaits is not an unhandled rejection
        return p
      }
      let next = clip(0)
      let started = false
      for (let i = 0; i < chunks.length; i++) {
        const blob = await next
        if (ac.signal.aborted) return
        if (i + 1 < chunks.length) next = clip(i + 1)
        const url = URL.createObjectURL(blob)
        try {
          await new Promise<void>((resolve, reject) => {
            const a = new Audio(url)
            audio = a
            a.onplaying = () => {
              if (!started) {
                started = true
                onStart?.()
              }
            }
            a.onended = () => resolve()
            a.onerror = () => reject(new Error('The audio could not be played.'))
            ac.signal.addEventListener('abort', () => resolve(), { once: true })
            a.play().catch(reject)
          })
        } finally {
          URL.revokeObjectURL(url)
          audio = null
        }
        if (ac.signal.aborted) return
      }
    },
    cancel() {
      // Stop the sound first, then the stream feeding it.
      if (audio) {
        audio.pause()
        audio = null
      }
      abort?.abort()
      abort = null
    },
  }
}

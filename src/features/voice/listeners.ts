import { externalServicesAllowed } from '../account/settings'
import { openAiAccess } from './access'
import { concatFrames, encodeWav, rms, transcribeOpenAi, VoiceActivity } from './capture'
import { fixTranscript } from './speech'
import type { VoiceSettings } from './settings'

/**
 * The listeners: something that turns the microphone into phrases. The
 * browser one is SpeechRecognition (Chrome, Safari) — free, streams words
 * as they come, finalises at every breath, hears names poorly; the audio
 * goes to Google's or Apple's servers unless the browser recognises on the
 * device, so with Third-party services off it runs only on the device. The OpenAI
 * one records each utterance as PCM, ends it when the room is quiet for
 * the dictation pause, and sends the clip to gpt-4o-mini-transcribe with
 * the app's vocabulary as a hint — one command, transcribed whole.
 */

export interface ListenerHandlers {
  /** Words recognised so far in the phrase being spoken. */
  onInterim(text: string): void
  /** A recognised phrase. `complete` when the listener itself waited out the pause — send the command now. */
  onFinal(text: string, complete: boolean): void
  /** Microphone loudness (0–1) and whether an utterance is being captured / transcribed — for the pill. */
  onActivity?(level: number, phase: 'quiet' | 'capturing' | 'transcribing'): void
  /** `fatal` means stop trying (no microphone, no permission, a bad key). */
  onError(message: string, fatal: boolean): void
  /** The listener ended on its own (the browser's session limit); the controller restarts it. */
  onEnd(): void
}

export interface Listener {
  start(): void
  stop(): void
  /** Ignore the microphone for a while (the app is speaking) without closing it; unmute picks up at once. Optional: without it the controller stops and restarts. */
  mute?(): void
  unmute?(): void
}

/** The subset of the Web Speech API the browser listener uses; the DOM lib does not ship these types. */
interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string; message?: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => Recognition

export function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const canCapture = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined'

const lang = () => (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US')

/** Recognition errors that mean "stop trying": no microphone, or the user said no. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'])

/**
 * Whether this browser can recognise speech on the device, without sending the audio anywhere: Chrome's
 * `processLocally` with the language model installed (`SpeechRecognition.available`). Anything else — Chrome's
 * default, Safari's — streams the microphone to Google's or Apple's servers.
 */
export async function onDeviceRecognition(Ctor: RecognitionCtor, language: string): Promise<boolean> {
  const available = (Ctor as unknown as { available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string> }).available
  if (typeof available !== 'function' || !('processLocally' in (Ctor.prototype as object))) return false
  try {
    return (await available.call(Ctor, { langs: [language], processLocally: true })) === 'available'
  } catch {
    return false
  }
}

/** What the browser listener says with Third-party services off and no recogniser on the device. */
export const OFFLINE_LISTENING =
  'The browser’s speech recognition sends your voice to Google or Apple, and Third-party services is off in your account settings. Turn it on, or listen with OpenAI transcription (in the assistant’s voice settings).'

export function createWebSpeechListener(h: ListenerHandlers): Listener {
  let rec: Recognition | null = null
  // Bumped by every start and stop, so an on-device check that answers late does not start a session nobody wants.
  let generation = 0
  const begin = (Ctor: RecognitionCtor, onDevice: boolean) => {
    // Started again without a stop in between: let the old session go and unhook it, or one voice would be
    // reported twice — once by each recogniser still wired to these handlers.
    const prev = rec
    rec = null
    if (prev) {
      prev.onresult = null
      prev.onend = null
      prev.onerror = null
      prev.abort()
    }
    const r = new Ctor()
    rec = r
    r.continuous = true
    r.interimResults = true
    r.lang = lang()
    if (onDevice) (r as Recognition & { processLocally?: boolean }).processLocally = true
    r.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]
        const text = res[0].transcript.trim()
        if (!text) continue
        if (res.isFinal) h.onFinal(fixTranscript(text), false)
        else interim += (interim ? ' ' : '') + text
      }
      if (interim) h.onInterim(interim)
    }
    r.onerror = (ev) => {
      if (FATAL.has(ev.error)) {
        rec = null
        h.onError(ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ? 'Microphone access was denied. Allow it for this site and turn voice on again.' : ev.error === 'audio-capture' ? 'No microphone was found.' : `Speech recognition failed: ${ev.error}`, true)
        return
      }
      // 'no-speech', 'aborted', 'network': the browser ends recognition; onend has it restarted.
      if (ev.error === 'network') h.onError('Speech recognition needs a network connection in this browser.', false)
    }
    r.onend = () => {
      if (rec !== r) return // stopped by us
      rec = null
      h.onEnd()
    }
    try {
      r.start()
    } catch {
      rec = null
      h.onEnd() // already started, or not allowed to start here: the controller tries again shortly
    }
  }
  return {
    start() {
      const gen = ++generation
      const Ctor = recognitionCtor()
      if (!Ctor) {
        h.onError('This browser cannot listen (no SpeechRecognition). Chrome and Safari can.', true)
        return
      }
      if (externalServicesAllowed()) return begin(Ctor, false)
      // Offline: the recogniser may only run on the device, and never falls back to the provider's servers.
      void onDeviceRecognition(Ctor, lang()).then((onDevice) => {
        if (gen !== generation) return
        if (onDevice) begin(Ctor, true)
        else h.onError(OFFLINE_LISTENING, true)
      })
    },
    stop() {
      generation++
      const r = rec
      rec = null
      r?.abort()
    },
  }
}

/** Vocabulary the transcriber should expect, on top of the app's own words. */
export type HintProvider = () => string

/** What the transcriber should expect: the product's name (spelled out — it is not "a graph") and the app's words. */
const APP_WORDS = 'Aegraph (spelled A-e-g-r-a-p-h, said "ay-graph"), the Aegraph assistant. Unigraph, entities, entity, ontology, Workstation, Scenes, Insights, Analytics, Datasets, Library, project, tags, relationships, annotations, diagram, globe, map, claim, plot, scene, layout, filter.'

export function createOpenAiListener(settings: () => VoiceSettings, h: ListenerHandlers, hint?: HintProvider): Listener {
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let node: ScriptProcessorNode | null = null
  let stopped = false
  let muted = false
  let inflight = 0
  let onUnmute: (() => void) | null = null
  const SAMPLE_RATE = 16_000
  const FRAME = 2048 // 128 ms at 16 kHz
  const PRE_ROLL = 4 // frames kept before the onset, so the first syllable is in the clip
  return {
    start() {
      stopped = false
      if (!openAiAccess()) {
        h.onError('No way to reach OpenAI for transcription — add a key in the assistant settings.', true)
        return
      }
      if (!canCapture()) {
        h.onError('This browser cannot capture the microphone.', true)
        return
      }
      void (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        } catch (err) {
          const name = err instanceof Error ? err.name : ''
          h.onError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was denied. Allow it for this site and turn voice on again.' : name === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not be opened: ${err instanceof Error ? err.message : String(err)}`, true)
          return
        }
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
        const rate = ctx.sampleRate // the browser may not honour 16 kHz; the WAV header says what it gave
        const source = ctx.createMediaStreamSource(stream)
        // ScriptProcessor is deprecated but universal; a frame at a time is all the detector needs.
        node = ctx.createScriptProcessor(FRAME, 1, 1)
        const vad = new VoiceActivity({ pauseMs: settings().pauseMs })
        const recent: Float32Array[] = []
        let clip: Float32Array[] | null = null
        const frameMs = (FRAME / rate) * 1000
        onUnmute = () => {
          // Whatever was heard while muted was the speaker: start clean.
          vad.reset()
          clip = null
          recent.length = 0
        }
        node.onaudioprocess = (ev) => {
          if (muted) return
          const frame = new Float32Array(ev.inputBuffer.getChannelData(0))
          const level = rms(frame)
          const event = vad.feed(level, frameMs)
          if (clip) clip.push(frame)
          else {
            recent.push(frame)
            if (recent.length > PRE_ROLL) recent.shift()
          }
          if (event === 'start') clip = [...recent, ...(clip ?? [])]
          h.onActivity?.(Math.min(1, level * 8), clip ? 'capturing' : inflight ? 'transcribing' : 'quiet')
          if (event === 'end' || event === 'drop') {
            const frames = clip ?? []
            clip = null
            recent.length = 0
            if (event === 'end') void transcribe(concatFrames(frames), rate)
          }
        }
        source.connect(node)
        node.connect(ctx.destination) // Chrome only runs the processor when it is wired to an output
        h.onActivity?.(0, 'quiet')
      })()

      const transcribe = async (samples: Float32Array, rate: number) => {
        inflight++
        h.onActivity?.(0, 'transcribing')
        try {
          const access = openAiAccess()
          if (!access) throw new Error('No way to reach OpenAI for transcription — add a key in the assistant settings.')
          const text = fixTranscript(await transcribeOpenAi(encodeWav(samples, rate), settings(), access, { hint: `${APP_WORDS} ${hint?.() ?? ''}`.trim(), language: lang().split('-')[0] }))
          if (!stopped && text) h.onFinal(text, true)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!stopped) h.onError(msg, /rejected|refused|not set up|No way to reach/.test(msg))
        } finally {
          inflight--
          if (!stopped) h.onActivity?.(0, inflight ? 'transcribing' : 'quiet')
        }
      }
    },
    mute() {
      muted = true
    },
    unmute() {
      if (!muted) return
      muted = false
      onUnmute?.()
    },
    stop() {
      stopped = true
      node?.disconnect()
      node = null
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      void ctx?.close()
      ctx = null
    },
  }
}

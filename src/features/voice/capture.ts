import { explainFailure, openAiRequest, type OpenAiAccess } from './access'
import { OPENAI_STT_MODELS, type VoiceSettings } from './settings'

/**
 * The pieces of the transcription listener that need no microphone: a
 * voice-activity detector over frame loudness, the WAV encoder for the
 * clip, and the request to OpenAI's transcription endpoint.
 */

/** Root mean square of a frame of samples in [-1, 1]. */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

export interface VadOptions {
  /** Silence after speech that ends the utterance, in ms. */
  pauseMs: number
  /** Loudness the room has to beat, whatever the floor. */
  minThreshold?: number
  /** Speech is this many times louder than the noise floor. */
  ratio?: number
  /** Loud frames in a row before speech counts as started (rejects clicks). */
  onsetFrames?: number
  /** Utterances shorter than this are noise, in ms. */
  minSpeechMs?: number
  /** An utterance longer than this is sent as it is, in ms. */
  maxSpeechMs?: number
}

export type VadEvent = 'start' | 'end' | 'drop' | null

/**
 * Speech / silence from a stream of frame loudness values. The noise floor adapts — down at once, up slowly —
 * so a quiet room and a fan both work; `feed` returns what changed: speech started, the utterance ended (send
 * it), or it was too short to be speech (drop it).
 */
export class VoiceActivity {
  private floor = 0.01
  private loudRun = 0
  private speaking = false
  private silentMs = 0
  private speechMs = 0
  private readonly o: Required<VadOptions>

  constructor(options: VadOptions) {
    this.o = { minThreshold: 0.012, ratio: 3.5, onsetFrames: 2, minSpeechMs: 400, maxSpeechMs: 10 * 60_000, ...options }
  }

  get isSpeaking() {
    return this.speaking
  }

  /** Forget any utterance in progress (the floor is kept). */
  reset() {
    this.speaking = false
    this.loudRun = 0
    this.silentMs = 0
    this.speechMs = 0
  }

  /** The loudness a frame must beat to count as speech right now. */
  get threshold() {
    return Math.max(this.o.minThreshold, this.floor * this.o.ratio)
  }

  feed(level: number, frameMs: number): VadEvent {
    // Track the floor: follow quiet at once, creep up through sustained noise (but never during speech).
    if (level < this.floor) this.floor = level
    else if (!this.speaking) this.floor += (level - this.floor) * 0.02
    const loud = level > this.threshold
    if (!this.speaking) {
      this.loudRun = loud ? this.loudRun + 1 : 0
      if (this.loudRun >= this.o.onsetFrames) {
        this.speaking = true
        this.silentMs = 0
        this.speechMs = frameMs * this.loudRun
        return 'start'
      }
      return null
    }
    this.speechMs += frameMs
    this.silentMs = loud ? 0 : this.silentMs + frameMs
    if (this.silentMs >= this.o.pauseMs || this.speechMs >= this.o.maxSpeechMs) {
      const spoken = this.speechMs - this.silentMs
      this.speaking = false
      this.loudRun = 0
      return spoken >= this.o.minSpeechMs ? 'end' : 'drop'
    }
    return null
  }
}

/** 16-bit mono PCM WAV from float samples. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** Join frames into one buffer. */
export function concatFrames(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

/** The clip, transcribed. `hint` is vocabulary the model should expect (names, the app's words). */
export async function transcribeOpenAi(clip: Blob, settings: VoiceSettings, access: OpenAiAccess, { hint, language, signal, fetchFn = fetch }: { hint?: string; language?: string; signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<string> {
  const form = new FormData()
  form.append('file', clip, 'speech.wav')
  form.append('model', (OPENAI_STT_MODELS as readonly string[]).includes(settings.openaiSttModel) ? settings.openaiSttModel : OPENAI_STT_MODELS[0])
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  if (hint) form.append('prompt', hint.slice(0, 800))
  const { url, headers } = await openAiRequest(access, 'v1/audio/transcriptions')
  const res = await fetchFn(url, { method: 'POST', headers, body: form, signal })
  if (!res.ok) throw await explainFailure(res, access, 'transcription')
  const { text } = (await res.json()) as { text?: string }
  return (text ?? '').trim()
}

import { useSyncExternalStore } from 'react'

/**
 * Voice settings, kept in localStorage: who listens (the browser's own
 * recogniser, or OpenAI transcription of each command), who speaks (the
 * browser's best voice, or OpenAI's neural voices), the OpenAI key both use
 * — stored here only — and how long a silence ends a dictated command.
 */

export type VoiceEngine = 'browser' | 'openai'
/** `auto`: OpenAI whenever it is reachable (a key here, or locally the dev server's), else the browser. */
export type VoiceEngineSetting = VoiceEngine | 'auto'

/** The voices gpt-4o-mini-tts speaks in. */
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
/** Transcription models, cheapest first: mini is $0.003 a minute and hears well; the full one for hard audio. */
export const OPENAI_STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'] as const

/** How long the microphone waits after the last word before the command is sent. */
export const PAUSE_OPTIONS = [
  { ms: 700, label: '0.7 s — snappy' },
  { ms: 1000, label: '1 s — quick (default)' },
  { ms: 1500, label: '1.5 s' },
  { ms: 2500, label: '2.5 s — room to think' },
  { ms: 5000, label: '5 s — long dictation' },
] as const

export interface VoiceSettings {
  /** Who turns speech into text. */
  listener: VoiceEngineSetting
  openaiSttModel: (typeof OPENAI_STT_MODELS)[number]
  /** Who reads replies. */
  speaker: VoiceEngineSetting
  /** A browser voice by name; empty picks the best available for the language. */
  browserVoice: string
  openaiKey: string
  openaiVoice: (typeof OPENAI_VOICES)[number]
  /** Silence that ends a dictated command, in ms. */
  pauseMs: number
}

const KEY = 'aegraph:voice:settings'
const DEFAULTS: VoiceSettings = { listener: 'auto', openaiSttModel: 'gpt-4o-mini-transcribe', speaker: 'auto', browserVoice: '', openaiKey: '', openaiVoice: 'nova', pauseMs: 1000 }

let current = load()
const listeners = new Set<() => void>()

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<VoiceSettings> & { engine?: VoiceEngine }
    return {
      listener: p.listener === 'openai' || p.listener === 'browser' ? p.listener : 'auto',
      openaiSttModel: (OPENAI_STT_MODELS as readonly string[]).includes(p.openaiSttModel ?? '') ? (p.openaiSttModel as VoiceSettings['openaiSttModel']) : DEFAULTS.openaiSttModel,
      speaker: (p.speaker ?? p.engine) === 'openai' || (p.speaker ?? p.engine) === 'browser' ? ((p.speaker ?? p.engine) as VoiceEngine) : 'auto',
      browserVoice: typeof p.browserVoice === 'string' ? p.browserVoice : '',
      openaiKey: typeof p.openaiKey === 'string' ? p.openaiKey : '',
      openaiVoice: (OPENAI_VOICES as readonly string[]).includes(p.openaiVoice ?? '') ? (p.openaiVoice as VoiceSettings['openaiVoice']) : DEFAULTS.openaiVoice,
      pauseMs: typeof p.pauseMs === 'number' && p.pauseMs >= 500 && p.pauseMs <= 15000 ? p.pauseMs : DEFAULTS.pauseMs,
    }
  } catch {
    return DEFAULTS
  }
}

export const getVoiceSettings = () => current

export function setVoiceSettings(patch: Partial<VoiceSettings>) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    getVoiceSettings,
    getVoiceSettings,
  )
}

import { useSyncExternalStore } from 'react'
import { resolveEngine } from './access'
import { canCapture, createOpenAiListener, createWebSpeechListener, recognitionCtor, type HintProvider, type Listener } from './listeners'
import { getVoiceSettings } from './settings'
import { createBrowserSpeaker, createOpenAiSpeaker, type Speaker } from './speakers'
import { endsCommand, isEcho, matchOption, speechText } from './speech'

/**
 * Voice control: the microphone and the speaker, as one observable
 * controller. It listens through a Listener (the browser's own recogniser,
 * or OpenAI transcription of each utterance — `listeners.ts`), speaks
 * through a Speaker (`speakers.ts`), and knows nothing about the assistant:
 * `assistantVoice.ts` wires what is heard to a chat turn and what the
 * assistant answers back to the speaker.
 *
 * Listening is continuous while enabled: the listener is restarted when
 * the browser ends it after a silence, and paused while the app is
 * speaking so it does not hear itself. The browser recogniser finalises a
 * phrase at every short pause, so a command is dictated into a draft that
 * grows until the user stops talking for `pauseMs` (a setting) or ends it
 * with "send it"; the draft survives the browser restarting recognition
 * underneath it. The transcription listener waits out the pause itself
 * and delivers the whole command at once. The finished command goes to
 * `onHeard`. While a question is armed (`expectAnswer`) each phrase is
 * matched against the question's options at once — answers are short.
 */

export type VoiceStatus = 'off' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceQuestion {
  kind: 'confirm' | 'choice'
  message: string
  options: string[]
}

export interface VoiceState {
  /** The browser can listen (SpeechRecognition exists). */
  canListen: boolean
  /** The browser can speak (speechSynthesis exists). */
  canSpeak: boolean
  /** Voice control is on: listening, or thinking / speaking on the way back to listening. */
  enabled: boolean
  status: VoiceStatus
  /** The command being dictated (what has been recognised so far, interim words included), or the last one sent. */
  heard: string
  /** Whether `heard` is a finished command (sent), rather than dictation in progress. */
  heardFinal: boolean
  /** Microphone loudness 0–1 and what the transcription listener is doing (the browser recogniser stays 'quiet'). */
  level: number
  phase: 'quiet' | 'capturing' | 'transcribing'
  /** The last thing spoken aloud (as spoken, not as written). */
  said: string
  error?: string
  /** The question the next phrase answers, when one is waiting. */
  question: VoiceQuestion | null
}

const ENABLED_KEY = 'aegraph:voice:on'

function synth(): SpeechSynthesis | null {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
}

export class VoiceController {
  private state: VoiceState
  private listeners = new Set<() => void>()
  private listener: Listener | null = null
  /** Set while a `stop()` is ours, so the listener ending does not restart it. */
  private wantListening = false
  private hint: HintProvider | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** The finalised parts of the command being dictated. */
  private draft: string[] = []
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** Identifies the utterance in progress; a different token means it was cut off. */
  private speaking: object | null = null
  private browserSpeaker: Speaker = createBrowserSpeaker(getVoiceSettings)
  private openaiSpeaker: Speaker = createOpenAiSpeaker(getVoiceSettings)
  private answer: ((answer: string | boolean | null | undefined) => void) | null = null
  private heardListeners = new Set<(text: string) => void>()

  constructor() {
    this.state = { canListen: !!recognitionCtor() || canCapture(), canSpeak: !!synth() || typeof Audio !== 'undefined', enabled: false, status: 'off', heard: '', heardFinal: false, level: 0, phase: 'quiet', said: '', question: null }
  }

  // ── Observable ───────────────────────────────────────────────────────

  getState = () => this.state
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  /** Every finished phrase the microphone hears that is not the answer to an armed question. */
  onHeard(f: (text: string) => void) {
    this.heardListeners.add(f)
    return () => {
      this.heardListeners.delete(f)
    }
  }

  /** Vocabulary for the transcriber (names on screen); set by whoever knows the app. */
  setHint(f: HintProvider | null) {
    this.hint = f
  }

  /** Whether voice was on when the tab was last used — the caller decides whether to resume it. */
  wasEnabled(): boolean {
    try {
      return localStorage.getItem(ENABLED_KEY) === '1'
    } catch {
      return false
    }
  }

  // ── Listening ────────────────────────────────────────────────────────

  /**
   * Turn listening on. `remember: false` (the voice tool's, after asking) keeps it for this page only: the next load does
   * not come up listening because a tool once turned the microphone on — only the user's own switch is remembered.
   */
  start(opts: { remember?: boolean } = {}) {
    if (this.state.enabled) return
    if (!this.state.canListen) {
      this.set({ error: 'This browser cannot listen (no speech recognition and no microphone capture). Chrome and Safari can.', status: 'error' })
      return
    }
    if (opts.remember !== false) this.remember(true)
    this.set({ enabled: true, error: undefined, status: 'listening', heard: '', heardFinal: false })
    this.listen()
  }

  stop() {
    this.remember(false)
    this.wantListening = false
    this.clearRestart()
    this.clearDraft()
    this.listener?.stop()
    this.listener = null
    this.muted = null
    this.hush()
    this.resolveQuestion(undefined)
    this.set({ enabled: false, status: 'off', question: null, heard: '', heardFinal: false, level: 0, phase: 'quiet' })
  }

  toggle() {
    if (this.state.enabled) this.stop()
    else this.start()
  }

  /** Something is being worked on for the last phrase; the status says so until `idle()`. */
  busy() {
    if (this.state.enabled && this.state.status !== 'speaking') this.set({ status: 'thinking' })
  }

  idle() {
    if (this.state.enabled && this.state.status === 'thinking') this.set({ status: 'listening' })
  }

  private remember(on: boolean) {
    try {
      localStorage.setItem(ENABLED_KEY, on ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  private listen() {
    if (!this.state.enabled || this.listener || this.speaking) return
    const handlers = {
      onInterim: (text: string) => {
        // Still talking: the command is not over, whatever the timer thought.
        this.armSilence()
        this.set({ heard: [...this.draft, text].join(' '), heardFinal: false })
      },
      onFinal: (text: string, complete: boolean) => this.finalPhrase(text, complete),
      onActivity: (level: number, phase: VoiceState['phase']) => {
        if (level !== this.state.level || phase !== this.state.phase) this.set({ level, phase })
      },
      onError: (message: string, fatal: boolean) => {
        if (!fatal) {
          this.set({ error: message })
          return
        }
        this.wantListening = false
        this.listener = null
        if (this.muted === listener) this.muted = null
        // Let it go: the transcription listener that failed still holds the microphone and its audio graph.
        listener.stop()
        this.remember(false)
        this.set({ enabled: false, status: 'error', error: message, level: 0, phase: 'quiet' })
      },
      onEnd: () => {
        this.listener = null
        if (this.wantListening && this.state.enabled && !this.speaking) this.scheduleRestart()
      },
    }
    const listener = resolveEngine(getVoiceSettings().listener) === 'openai' ? createOpenAiListener(getVoiceSettings, handlers, () => this.hint?.() ?? '') : createWebSpeechListener(handlers)
    this.listener = listener
    this.wantListening = true
    listener.start()
  }

  private scheduleRestart(ms = 250) {
    this.clearRestart()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.listen()
    }, ms)
  }

  private clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  /** A listener kept open but muted while the app speaks (the transcription listener can; the browser's cannot). */
  private muted: Listener | null = null

  /**
   * Stops hearing without turning voice off — around speaking, so the speaker is not heard as the user. A listener
   * that can mute stays open (no microphone re-open, no gap); one that cannot is stopped and restarted after.
   */
  private pause() {
    this.clearRestart()
    if (!this.listener) return
    if (this.listener.mute) {
      this.listener.mute()
      this.muted = this.listener
    } else {
      this.wantListening = false
      const l = this.listener
      this.listener = null
      l.stop()
    }
    if (this.state.level || this.state.phase !== 'quiet') this.set({ level: 0, phase: 'quiet' })
  }

  private resume() {
    if (!this.state.enabled) return
    if (this.muted && this.muted === this.listener) {
      this.muted = null
      this.listener.unmute?.()
      return
    }
    this.muted = null
    if (!this.listener) this.scheduleRestart(150)
  }

  /** A finished command as if the microphone had heard it — for scripted checks and tests. Voice need not be on. */
  hear(text: string) {
    this.heard(text)
  }

  /**
   * A phrase the listener finalised. An answer to a waiting question goes straight through; otherwise it joins
   * the draft, which is sent when the user ends it ("send it"), stops talking for the pause, or — `complete` —
   * when the listener already waited the pause out itself.
   */
  private finalPhrase(text: string, complete = false) {
    if (this.state.question && this.answer) {
      this.heard(text)
      return
    }
    const { body, ends } = endsCommand(text)
    if (body) this.draft.push(body)
    if (ends || complete) {
      this.sendDraft()
      return
    }
    this.set({ heard: this.draft.join(' '), heardFinal: false })
    this.armSilence()
  }

  private armSilence() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      this.sendDraft()
    }, getVoiceSettings().pauseMs)
  }

  private sendDraft() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    const text = this.draft.join(' ').trim()
    this.draft = []
    if (text) this.heard(text)
  }

  private clearDraft() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    this.draft = []
  }

  private heard(text: string) {
    // The speaker heard through the microphone is not the user — but an answer to a question repeats the option the
    // question just read out, so nothing is dropped while one is waiting (the option matching is strict anyway).
    if (!this.state.question && isEcho(text, this.saidRecently.filter((r) => Date.now() - r.at < 90_000).map((r) => r.text))) return
    this.set({ heard: text, heardFinal: true, error: undefined })
    const q = this.state.question
    if (q && this.answer) {
      const m = matchOption(text, q.options, q.kind)
      if (m === undefined) {
        // Not an answer: say what would be, and keep waiting.
        void this.speak(q.kind === 'confirm' ? 'Say yes or no, or choose in the assistant.' : `Say one of: ${q.options.join(', ')}. Or choose in the assistant.`)
        return
      }
      this.resolveQuestion(m)
      return
    }
    this.heardListeners.forEach((f) => f(text))
  }

  // ── Speaking ─────────────────────────────────────────────────────────

  /**
   * Say something now: whatever is being said or waiting to be said is dropped first. Markdown is flattened for
   * the ear and long text is cut at a sentence; the microphone is muted while it plays. Resolves when it has been
   * said (or cut off).
   */
  speak(text: string, opts: { markdown?: boolean; max?: number } = {}): Promise<void> {
    this.hush()
    return this.say(text, opts)
  }

  /**
   * Say something after whatever is already being said — replies stream in sentence by sentence, and a question
   * waits for the reply before it. Resolves when this text has been said (or the queue was cut off).
   */
  say(text: string, { markdown = false, max = 1200 }: { markdown?: boolean; max?: number } = {}): Promise<void> {
    const plain = speechText(text, { markdown, max })
    if (!plain || !this.state.canSpeak) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.queue.push({ text: plain, resolve })
      // The next sentence is synthesised while this one plays, so they run on without a gap.
      if (this.queue.length === 2 && this.speaking) this.currentSpeaker().prefetch?.(plain)
      void this.drain()
    })
  }

  /** What is waiting to be said, in order; the head is being said. */
  private queue: { text: string; resolve: () => void }[] = []
  /** Everything said lately (for telling the microphone's own echo from the user). */
  private saidRecently: { text: string; at: number }[] = []

  private currentSpeaker(): Speaker {
    return resolveEngine(getVoiceSettings().speaker) === 'openai' ? this.openaiSpeaker : this.browserSpeaker
  }

  private async drain() {
    if (this.speaking) return
    const token = {}
    this.speaking = token
    this.pause()
    if (this.state.enabled) this.set({ status: 'speaking' })
    try {
      while (this.queue.length && this.speaking === token) {
        const item = this.queue[0]
        this.set({ said: item.text })
        const engine = resolveEngine(getVoiceSettings().speaker)
        const speaker = engine === 'openai' ? this.openaiSpeaker : this.browserSpeaker
        if (this.queue[1]) speaker.prefetch?.(this.queue[1].text)
        try {
          await speaker.speak(item.text)
        } catch (err) {
          if (this.speaking !== token) break
          if (engine === 'openai') {
            this.set({ error: `${err instanceof Error ? err.message : String(err)} Using the browser voice.` })
            await this.browserSpeaker.speak(item.text).catch(() => {})
          }
        }
        if (this.speaking !== token) break
        this.saidRecently.push({ text: item.text, at: Date.now() })
        if (this.saidRecently.length > 12) this.saidRecently.shift()
        if (this.queue[0] === item) this.queue.shift()
        item.resolve()
      }
    } finally {
      if (this.speaking === token) {
        this.speaking = null
        if (this.state.enabled && this.state.status === 'speaking') this.set({ status: 'listening' })
        this.resume()
      }
    }
  }

  /** Stop talking now and forget what was waiting. The microphone comes back if voice is on. */
  hush() {
    const was = this.speaking
    this.speaking = null
    const dropped = this.queue.splice(0)
    this.browserSpeaker.cancel()
    this.openaiSpeaker.cancel()
    dropped.forEach((d) => d.resolve())
    if (was) {
      if (this.state.enabled && this.state.status === 'speaking') this.set({ status: 'listening' })
      this.resume()
    }
  }

  // ── Questions ────────────────────────────────────────────────────────

  /**
   * Put a question to the user by voice and wait for the answer: the next phrase is matched against the options
   * (or yes/no for a confirmation). Resolves with the chosen option (a boolean for confirmations), null when the
   * user declines, and undefined when the question is withdrawn — answered on screen, replaced, or voice turned off.
   */
  expectAnswer(question: VoiceQuestion, spoken: string): Promise<string | boolean | null | undefined> {
    this.resolveQuestion(undefined)
    this.set({ question })
    return new Promise((resolve) => {
      this.answer = resolve
      // After whatever is being said — a reply still streaming out is finished first.
      void this.say(spoken)
    })
  }

  /** The question was answered on screen: stop waiting for it. */
  withdraw() {
    this.resolveQuestion(undefined)
  }

  private resolveQuestion(answer: string | boolean | null | undefined) {
    const f = this.answer
    this.answer = null
    if (this.state.question) this.set({ question: null })
    f?.(answer)
  }
}

/** One per tab. */
export const voice = new VoiceController()

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.getState, voice.getState)
}

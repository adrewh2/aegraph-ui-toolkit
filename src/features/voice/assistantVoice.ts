import { loadChats } from '../assistant/instance'
import type { AssistantSession, SessionEvent } from '../assistant/session'
import { bridge } from '../bridge/bridge'
import { speakableSoFar } from './speech'
import { voice } from './voice'

/**
 * Voice ↔ assistant. What the microphone hears becomes a chat turn (the
 * panel need not be open); what the turn answers is read back; a question
 * the assistant puts — a confirmation, or ask_user's options — is spoken,
 * the panel is opened so the options are on screen, and the answer is
 * taken from either place. Questions from tools run over the bridge (a
 * chat answered by Claude Code, or Claude Code driving the tab from a
 * terminal) are spoken the same way; those show as a dialog.
 *
 * A few phrases are for the app itself, not the assistant: "stop" cuts the
 * speaker and the turn, "stop listening" turns voice off, "open / close the
 * assistant", "new chat".
 */

const openPanel = (open: boolean) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open } }))
}

/** Speak a question with its options; the closing phrase tells the user where the buttons are. */
export function spokenQuestion(kind: 'confirm' | 'choice', message: string, options: string[], where = 'in the assistant'): string {
  if (kind === 'confirm') return `${message} Say yes or no, or choose ${where}.`
  const list = options.length <= 5 ? options.map((o, i) => `${i + 1}: ${o}`).join('. ') : `${options.length} options`
  return `${message} ${list}. Choose ${where}, or say one.`
}

/** The built-in phrases; true when one was handled. */
export function localCommand(text: string, session: AssistantSession | null): boolean {
  const t = text.toLowerCase().replace(/[^\w' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^(stop|be quiet|quiet|hush|shut up|enough|cancel that|stop talking)$/.test(t)) {
    voice.hush()
    session?.stop()
    return true
  }
  if (/^(stop listening|voice off|turn (off )?voice( off)?|turn off (the )?(mic|microphone)|go to sleep)$/.test(t)) {
    voice.stop()
    return true
  }
  if (/^(open|show) (the )?(assistant|chat|panel)$/.test(t)) {
    openPanel(true)
    return true
  }
  if (/^(close|hide) (the )?(assistant|chat|panel)$/.test(t)) {
    openPanel(false)
    return true
  }
  if (/^(new chat|start (a )?new chat|start over|clear (the )?chat)$/.test(t)) {
    // A new tab, in front; voice follows it.
    void loadChats().then((c) => c.create())
    void voice.speak('New chat.')
    return true
  }
  return false
}

let installed = false
/** What to undo on a hot update, so the new module's wiring is the only one. */
const teardown: (() => void)[] = []

/** Wire the voice controller to the assistant and the bridge. Idempotent; runs once per tab. */
export function installAssistantVoice() {
  if (installed) return
  installed = true

  let session: AssistantSession | null = null
  let askingId: string | number | null = null
  /** How much of each streaming reply has been handed to the speaker, and whether anything was this turn. */
  const spoken = new Map<string, number>()
  let saidThisTurn = false

  const onSessionEvent = (ev: SessionEvent) => {
    if (!session) return
    const s = session
    if (ev.type === 'reply') {
      // Read the reply as it streams: each complete sentence goes to the speaker the moment it is there.
      if (!voice.getState().enabled) return
      const from = spoken.get(ev.id) ?? 0
      const { chunk, upTo } = speakableSoFar(ev.text, from, ev.done)
      if (upTo > from) spoken.set(ev.id, upTo)
      if (chunk) {
        saidThisTurn = true
        void voice.say(chunk, { markdown: true })
      }
      if (ev.done) spoken.delete(ev.id)
      return
    }
    if (ev.type === 'turn') {
      voice.idle()
      const said = saidThisTurn
      saidThisTurn = false
      spoken.clear()
      if (!voice.getState().enabled) return
      if (ev.error) void voice.say(`Something went wrong: ${ev.error}`)
      else if (!said) void voice.say('Done.')
      return
    }
    if (ev.type === 'answered') {
      if (askingId === ev.id) {
        askingId = null
        voice.withdraw()
      }
      return
    }
    if (ev.type === 'question') {
      if (!voice.getState().enabled) return
      openPanel(true)
      askingId = ev.id
      void voice.expectAnswer({ kind: ev.kind, message: ev.message, options: ev.options }, spokenQuestion(ev.kind, ev.message, ev.options)).then((a) => {
        if (askingId !== ev.id || a === undefined) return // answered on screen, or voice went off
        askingId = null
        if (ev.kind === 'confirm') s.answer(ev.id, a === true)
        else s.answerQuestion(ev.id, typeof a === 'string' ? a : null)
      })
    }
  }

  // Voice follows the chat in front: its events are the ones spoken, and phrases go to it.
  let offSession: (() => void) | null = null
  const attach = (s: AssistantSession) => {
    if (session === s) return s
    offSession?.()
    session = s
    spoken.clear()
    offSession = s.onEvent(onSessionEvent)
    return s
  }
  teardown.push(() => offSession?.())
  const follow = () =>
    loadChats().then((c) => {
      teardown.push(c.subscribe(() => attach(c.active())))
      return attach(c.active())
    })
  let following: Promise<AssistantSession> | null = null
  const current = () => (following ??= follow())

  // The chats load when voice turns on (so their questions can be spoken) or when the first phrase arrives.
  teardown.push(
    voice.subscribe(() => {
      const st = voice.getState()
      if (st.enabled && !session) void current()
    }),
  )

  teardown.push(voice.onHeard((text) => {
    if (localCommand(text, session)) return
    saidThisTurn = false
    voice.busy()
    void current()
      .then(() => session!.sendWhenIdle(text))
      .catch(() => voice.idle())
  }))

  // Questions from tools run over the bridge: spoken like the session's, answered in the dialog or by voice.
  let bridgeAsked: number | null = null
  teardown.push(bridge.subscribe(() => {
    if (!voice.getState().enabled) return
    const st = bridge.getState()
    const pending = st.confirm ? { id: st.confirm.id, kind: 'confirm' as const, message: st.confirm.message, options: st.confirm.kind === 'permission' ? ['Allow', 'Cancel'] : [st.confirm.yes || 'Yes', 'Cancel'] } : st.question ? { id: st.question.id, kind: 'choice' as const, message: st.question.message, options: st.question.options } : null
    if (!pending) {
      if (bridgeAsked !== null) {
        bridgeAsked = null
        if (askingId !== null && typeof askingId === 'number') {
          askingId = null
          voice.withdraw()
        }
      }
      return
    }
    if (bridgeAsked === pending.id) return
    bridgeAsked = pending.id
    askingId = pending.id
    void voice.expectAnswer({ kind: pending.kind, message: pending.message, options: pending.options }, spokenQuestion(pending.kind, pending.message, pending.options, 'on screen')).then((a) => {
      if (askingId !== pending.id || a === undefined) return
      askingId = null
      if (pending.kind === 'confirm') bridge.answer(pending.id, a === true)
      else bridge.answerQuestion(pending.id, typeof a === 'string' ? a : null)
    })
  }))
}

if (import.meta.hot) import.meta.hot.dispose(() => teardown.splice(0).forEach((f) => f()))

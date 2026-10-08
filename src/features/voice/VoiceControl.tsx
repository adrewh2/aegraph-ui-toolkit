import { Loader2, Mic, MicOff, Square, Volume2, X } from 'lucide-react'
import { useEffect } from 'react'
import { provideAppHost } from '../assistant/instance'
import { useAppHost } from '../assistant/useAppHost'
import { installAssistantVoice } from './assistantVoice'
import { useVoice, voice } from './voice'
import './VoiceControl.css'

/**
 * Always mounted: keeps the assistant reachable without its panel (the
 * app host is registered here), wires voice to the chat, owns the ⌘⇧U
 * shortcut, and shows the voice pill while voice is on — what is being
 * heard, thought about or said, with the mic and a stop button.
 */
export function VoiceControl() {
  const host = useAppHost()
  const state = useVoice()
  useEffect(() => {
    provideAppHost(host)
    // The transcriber hears the names on screen better when told to expect them.
    voice.setHint(() => {
      const c = host.getContext()
      return [c.project?.label, c.document?.label, c.image?.label, c.video?.label, c.audio?.label, ...(c.graph?.selected?.map((x) => x.label) ?? [])].filter(Boolean).join(', ')
    })
    return () => voice.setHint(null)
  }, [host])

  useEffect(() => {
    installAssistantVoice()
    // In development the controller is reachable from the console (`__aegraph.voice.hear('…')`) for scripted checks.
    if (import.meta.env.DEV) ((window as unknown as { __aegraph?: Record<string, unknown> }).__aegraph ??= {}).voice = voice
    // Voice left on last time comes back on; the microphone permission is remembered by the browser.
    if (voice.wasEnabled() && voice.getState().canListen) voice.start()
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        voice.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!state.enabled && state.status !== 'error') return null

  const capturing = state.status === 'listening' && state.phase !== 'quiet'
  const label = state.status === 'error' ? state.error : state.status === 'speaking' ? state.said : state.status === 'thinking' ? (state.heard ? `“${state.heard}”` : 'Thinking…') : capturing ? (state.phase === 'capturing' ? 'Recording — keep talking; a pause sends it' : 'Transcribing…') : state.heard ? state.heard : state.question ? 'Your answer?' : 'Listening…'

  return (
    <div className={`voice voice--${state.status}`} role="status" aria-live="polite">
      <button className="voice__mic" title={state.enabled ? 'Voice is on — click to turn off (⌘⇧U)' : 'Turn voice on (⌘⇧U)'} onClick={() => voice.toggle()}>
        {state.status === 'error' ? <MicOff size={15} /> : state.status === 'thinking' || state.phase === 'transcribing' ? <Loader2 size={15} className="voice__spin" /> : state.status === 'speaking' ? <Volume2 size={15} /> : <Mic size={15} />}
        {state.phase === 'capturing' && <span className="voice__level" style={{ transform: `scale(${1 + state.level * 0.6})` }} />}
      </button>
      <div className="voice__body">
        <div className="voice__state">{state.status === 'error' ? 'Voice' : state.status === 'speaking' ? 'Speaking' : state.status === 'thinking' ? 'Thinking' : state.question ? 'Waiting for your answer' : capturing ? (state.phase === 'capturing' ? 'Dictating' : 'Transcribing') : state.heard && !state.heardFinal ? 'Dictating — pause, or say “send it”' : 'Listening'}</div>
        <div className={`voice__text ${state.status === 'listening' && !state.heardFinal && state.heard ? 'is-interim' : ''}`}>{label}</div>
        {state.error && state.status !== 'error' && <div className="voice__error">{state.error}</div>}
      </div>
      {state.status === 'speaking' && (
        <button className="btn btn--sm btn--icon btn--ghost" title="Stop speaking" onClick={() => voice.hush()}>
          <Square size={12} />
        </button>
      )}
      <button className="btn btn--sm btn--icon btn--ghost" title="Turn voice off" onClick={() => voice.stop()}>
        <X size={13} />
      </button>
    </div>
  )
}

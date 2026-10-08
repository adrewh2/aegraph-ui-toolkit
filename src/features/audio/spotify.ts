import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { requireExternalServices } from '../account/settings'
import { EMBED_SANDBOX } from '../videos/youtube'

/**
 * The Spotify player as a plain embed: a sandboxed frame on open.spotify.com, driven by the messages the embed itself
 * speaks (`{ command: 'play' | 'pause' | 'resume' | 'toggle' | 'seek', timestamp }`; it answers with `ready`,
 * `playback_update` — position and duration in ms — and `playback_started`). Spotify's iFrame API — a script from
 * open.spotify.com run in the app's own origin — is not used: the Content-Security-Policy refuses it, and allowing it
 * would give a third party's script the page that holds the keys and the workspace. The frame is another origin, so
 * it reaches none of that. Between updates the hook interpolates so the playhead moves smoothly.
 */

export const SPOTIFY_EMBED_ORIGIN = 'https://open.spotify.com'
const URI = /^spotify:(track|album|playlist|episode|show|artist):([0-9A-Za-z]{22})$/

/** The embed's address for a `spotify:<kind>:<id>` URI from data — only a well-formed one, so the data cannot steer the frame elsewhere. */
export function spotifyEmbedSrc(uri: string): string {
  const m = URI.exec(uri)
  if (!m) throw new Error('Not a Spotify URI this player can open.')
  return `${SPOTIFY_EMBED_ORIGIN}/embed/${m[1]}/${m[2]}`
}

/** The player's frame. Throws with Third-party services off, before anything is made. */
export function createSpotifyFrame(uri: string, height: number): HTMLIFrameElement {
  requireExternalServices('The Spotify player')
  const f = document.createElement('iframe')
  f.src = spotifyEmbedSrc(uri)
  f.title = 'Spotify player'
  f.setAttribute('sandbox', EMBED_SANDBOX)
  f.allow = 'autoplay; encrypted-media; clipboard-write; fullscreen; picture-in-picture'
  f.style.cssText = `width:100%;height:${Math.round(height)}px;border:0;display:block;border-radius:12px`
  return f
}

export interface PlayerState {
  ready: boolean
  error: string | null
  playing: boolean
  currentTime: number
  duration: number
}

export interface PlayerControls {
  seek: (seconds: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
}

/** Mounts a Spotify embed into `container` and keeps playback state in React. */
export function useSpotifyPlayer(container: RefObject<HTMLDivElement | null>, uri: string, height: number, start?: number): PlayerState & PlayerControls {
  const send = useRef<(msg: { command: string; timestamp?: number }) => void>(() => {})
  const last = useRef<{ position: number; at: number; playing: boolean }>({ position: (start ?? 0) * 1000, at: performance.now(), playing: false })
  const seekedToStart = useRef(!start)
  const [state, setState] = useState<PlayerState>({ ready: false, error: null, playing: false, currentTime: start ?? 0, duration: 0 })

  useEffect(() => {
    const el = container.current
    if (!el) return
    let frame: HTMLIFrameElement
    try {
      frame = createSpotifyFrame(uri, height)
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }))
      return
    }
    el.appendChild(frame)
    send.current = (msg) => frame.contentWindow?.postMessage(msg, SPOTIFY_EMBED_ORIGIN)
    const onMessage = (e: MessageEvent) => {
      // Only the frame this hook made, from Spotify's origin; anything else on the page's message bus is not ours.
      if (e.source !== frame.contentWindow || e.origin !== SPOTIFY_EMBED_ORIGIN) return
      const m = e.data as { type?: unknown; payload?: { isPaused?: unknown; duration?: unknown; position?: unknown } } | null
      if (!m || typeof m !== 'object') return
      if (m.type === 'ready') setState((s) => ({ ...s, ready: true }))
      else if (m.type === 'playback_update' && m.payload && typeof m.payload === 'object') {
        const position = typeof m.payload.position === 'number' ? m.payload.position : last.current.position
        const duration = typeof m.payload.duration === 'number' ? m.payload.duration : 0
        const playing = m.payload.isPaused === false
        last.current = { position, at: performance.now(), playing }
        // Honour a ?t= start once playback is possible.
        if (!seekedToStart.current && start) {
          seekedToStart.current = true
          send.current({ command: 'seek', timestamp: start })
        }
        setState((s) => ({ ...s, ready: true, playing, currentTime: position / 1000, duration: duration ? duration / 1000 : s.duration }))
      }
    }
    window.addEventListener('message', onMessage)
    // Interpolate between updates so the playhead doesn't stutter.
    const timer = setInterval(() => {
      const l = last.current
      if (!l.playing) return
      const t = (l.position + (performance.now() - l.at)) / 1000
      setState((s) => (Math.abs(t - s.currentTime) < 0.05 ? s : { ...s, currentTime: s.duration ? Math.min(t, s.duration) : t }))
    }, 200)
    return () => {
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
      send.current = () => {}
      frame.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, height])

  const seek = useCallback((seconds: number) => {
    const t = Math.max(0, seconds)
    send.current({ command: 'seek', timestamp: t })
    last.current = { ...last.current, position: t * 1000, at: performance.now() }
    setState((s) => ({ ...s, currentTime: t }))
  }, [])
  const play = useCallback(() => send.current({ command: last.current.position > 0 ? 'resume' : 'play' }), [])
  const pause = useCallback(() => send.current({ command: 'pause' }), [])
  const toggle = useCallback(() => send.current({ command: 'toggle' }), [])

  return { ...state, seek, play, pause, toggle }
}

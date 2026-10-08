import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { requireExternalServices } from '../account/settings'

/**
 * The YouTube player as a plain embed: a sandboxed frame on youtube-nocookie.com, driven by the messages the embed
 * itself speaks (`listening`, then `command` with a function name; it answers with `onReady`, `infoDelivery`,
 * `onStateChange`, `onError`). The IFrame Player API — a script from youtube.com run in the app's own origin — is
 * not used: the Content-Security-Policy refuses it, and allowing it would give a third party's script the page that
 * holds the keys and the workspace. The frame is another origin, so it reaches none of that.
 */

/** Where the player is framed from: YouTube's no-cookie host, which sets no cookie until the video is played. */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com'
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/

/** The embed's address for a video id from data — only a well-formed id, so the data cannot steer the frame elsewhere. */
export function youtubeEmbedSrc(videoId: string, start?: number): string {
  if (!VIDEO_ID.test(videoId)) throw new Error('Invalid video id.')
  const origin = location.origin
  const params = new URLSearchParams({ enablejsapi: '1', controls: '0', rel: '0', playsinline: '1', origin, widget_referrer: origin })
  if (start && start > 0) params.set('start', String(Math.floor(start)))
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}?${params}`
}

/**
 * The sandbox a media embed gets: its own scripts in its own origin (`allow-same-origin` keeps the provider's origin,
 * not ours — the frame is another site), fullscreen, and links that open in a tab of their own. No top navigation,
 * no forms, no modals.
 */
export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox'

/** The player's frame. Throws with Third-party services off, before anything is made. */
export function createYouTubeFrame(videoId: string, start?: number): HTMLIFrameElement {
  requireExternalServices('The YouTube player')
  const f = document.createElement('iframe')
  f.src = youtubeEmbedSrc(videoId, start)
  f.title = 'YouTube video player'
  f.setAttribute('sandbox', EMBED_SANDBOX)
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'
  // The embed refuses to play without knowing which site it is on; the origin is all it is told.
  f.referrerPolicy = 'strict-origin-when-cross-origin'
  f.style.cssText = 'width:100%;height:100%;border:0;display:block'
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

const ERRORS: Record<number, string> = {
  2: 'Invalid video id.',
  5: 'This video cannot be played in an embedded player.',
  100: 'The video was not found (removed or private).',
  101: 'The owner does not allow this video to be embedded.',
  150: 'The owner does not allow this video to be embedded.',
}

/** Mounts a player into `container` and keeps playback state in React. */
export function useYouTubePlayer(container: RefObject<HTMLDivElement | null>, videoId: string, start?: number): PlayerState & PlayerControls {
  const send = useRef<(func: string, args?: unknown[]) => void>(() => {})
  const playerState = useRef(-1)
  const last = useRef<{ time: number; at: number; playing: boolean }>({ time: start ?? 0, at: performance.now(), playing: false })
  const [state, setState] = useState<PlayerState>({ ready: false, error: null, playing: false, currentTime: start ?? 0, duration: 0 })

  useEffect(() => {
    const el = container.current
    if (!el) return
    let frame: HTMLIFrameElement
    try {
      frame = createYouTubeFrame(videoId, start)
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }))
      return
    }
    el.appendChild(frame)
    let ready = false
    const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), YOUTUBE_EMBED_ORIGIN)
    send.current = (func, args = []) => post({ event: 'command', func, args })
    const onMessage = (e: MessageEvent) => {
      // Only the frame this hook made, from YouTube's origin; anything else on the page's message bus is not ours.
      if (e.source !== frame.contentWindow || e.origin !== YOUTUBE_EMBED_ORIGIN) return
      let m: { event?: string; info?: unknown }
      try {
        m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      } catch {
        return
      }
      if (!m || typeof m !== 'object') return
      if (m.event === 'onReady') {
        ready = true
        setState((s) => ({ ...s, ready: true }))
      } else if (m.event === 'onError') {
        const code = Number(m.info)
        setState((s) => ({ ...s, error: ERRORS[code] ?? `Player error ${code}` }))
      } else if (m.event === 'onStateChange' && typeof m.info === 'number') {
        playerState.current = m.info
        last.current = { ...last.current, at: performance.now(), playing: m.info === 1 }
        setState((s) => ({ ...s, playing: m.info === 1 }))
      } else if ((m.event === 'infoDelivery' || m.event === 'initialDelivery') && m.info && typeof m.info === 'object') {
        const info = m.info as { currentTime?: unknown; duration?: unknown; playerState?: unknown }
        if (typeof info.playerState === 'number') playerState.current = info.playerState
        const playing = playerState.current === 1
        const time = typeof info.currentTime === 'number' ? info.currentTime : undefined
        if (time !== undefined || typeof info.playerState === 'number') last.current = { time: time ?? last.current.time, at: performance.now(), playing }
        setState((s) => {
          const duration = typeof info.duration === 'number' && info.duration > 0 ? info.duration : s.duration
          const currentTime = time ?? s.currentTime
          return Math.abs(currentTime - s.currentTime) < 0.05 && duration === s.duration && playing === s.playing ? s : { ...s, currentTime, duration, playing }
        })
      }
    }
    window.addEventListener('message', onMessage)
    // The embed answers once it has heard `listening`, which it ignores until its own script has run: say it on load
    // and every quarter second until it is ready (for ten seconds).
    const listen = () => post({ event: 'listening' })
    frame.addEventListener('load', listen)
    let tries = 0
    const hello = setInterval(() => (ready || ++tries > 40 ? clearInterval(hello) : listen()), 250)
    // Between the embed's reports the playhead moves on by the clock, so it does not stutter.
    const tick = setInterval(() => {
      const l = last.current
      if (!l.playing) return
      const t = l.time + (performance.now() - l.at) / 1000
      setState((s) => (Math.abs(t - s.currentTime) < 0.05 ? s : { ...s, currentTime: s.duration ? Math.min(t, s.duration) : t }))
    }, 250)
    return () => {
      clearInterval(hello)
      clearInterval(tick)
      window.removeEventListener('message', onMessage)
      send.current = () => {}
      frame.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  const seek = useCallback((seconds: number) => {
    const t = Math.max(0, seconds)
    send.current('seekTo', [t, true])
    last.current = { ...last.current, time: t, at: performance.now() }
    setState((s) => ({ ...s, currentTime: t }))
  }, [])
  const play = useCallback(() => send.current('playVideo'), [])
  const pause = useCallback(() => send.current('pauseVideo'), [])
  const toggle = useCallback(() => send.current(playerState.current === 1 ? 'pauseVideo' : 'playVideo'), [])

  return { ...state, seek, play, pause, toggle }
}

/**
 * Where the Spotify player is, for anything outside the audio page that
 * wants to know (the assistant's app context). Null when no audio page is open.
 */
export interface AudioPlayback {
  audioId: string
  currentTime: number
  playing: boolean
  /** Seconds, once the embed has reported it. */
  duration?: number
}

let current: AudioPlayback | null = null
export const setAudioPlayback = (p: AudioPlayback | null) => {
  current = p
}
export const getAudioPlayback = () => current

/** Controls the open audio page registers so tools can seek and play/pause. */
export interface AudioPlayerHandle {
  seek: (seconds: number) => void
  play: () => void
  pause: () => void
}
let handle: AudioPlayerHandle | null = null
export const setAudioPlayerHandle = (h: AudioPlayerHandle | null) => {
  handle = h
}
export const getAudioPlayerHandle = () => handle

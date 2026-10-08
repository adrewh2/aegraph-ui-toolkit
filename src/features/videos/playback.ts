/**
 * Where playback currently is, for anything outside the player that wants
 * to know (the assistant's app context). Null when no video page is open.
 */
export interface Playback {
  videoId: string
  currentTime: number
  playing: boolean
  duration?: number
}

let current: Playback | null = null
export const setPlayback = (p: Playback | null) => {
  current = p
}
export const getPlayback = () => current

/** Player hooks the open video page registers so tools can capture frames, seek, and play/pause. */
export interface PlayerHandle {
  seek: (seconds: number) => void
  play: () => void
  pause: () => void
  /** Grab a still of the current frame (may prompt for tab capture). */
  capture: () => Promise<{ dataUrl: string; width: number; height: number } | undefined>
}
let handle: PlayerHandle | null = null
export const setPlayerHandle = (h: PlayerHandle | null) => {
  handle = h
}
export const getPlayerHandle = () => handle

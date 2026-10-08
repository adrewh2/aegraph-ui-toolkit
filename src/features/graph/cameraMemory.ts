import type { CameraState } from './view'

/**
 * Where the camera was, per renderer, for the picture it was looking at —
 * so switching 2D ↔ 3D, opening another page, or reloading brings you back
 * to the same view instead of a fresh fit. Keyed by what is on screen
 * (slice + algorithm + saved layout): a different graph gets a fresh fit.
 */
const KEY = 'aegraph:explorer:camera'
type Saved = Record<'2d' | '3d' | 'gpu', { key: string; camera: CameraState } | undefined>

let mem: Saved | null = null
const load = (): Saved => {
  if (mem) return mem
  try {
    mem = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { '2d': undefined, '3d': undefined, gpu: undefined }
  } catch {
    mem = { '2d': undefined, '3d': undefined, gpu: undefined }
  }
  return mem!
}

export function saveCamera(kind: '2d' | '3d' | 'gpu', key: string, camera: CameraState) {
  const s = load()
  s[kind] = { key, camera }
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** The remembered camera for this exact picture, if any. */
export function loadCamera(kind: '2d' | '3d' | 'gpu', key: string): CameraState | undefined {
  const s = load()[kind]
  return s && s.key === key ? s.camera : undefined
}

/** Debounce saves from continuous camera events. */
export function cameraSaver(kind: '2d' | '3d' | 'gpu', read: () => { key: string; camera: CameraState | null }) {
  let t: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    const { key, camera } = read()
    if (camera) saveCamera(kind, key, camera)
  }
  return {
    bump: () => {
      clearTimeout(t)
      t = setTimeout(flush, 250)
    },
    flush: () => {
      clearTimeout(t)
      flush()
    },
  }
}

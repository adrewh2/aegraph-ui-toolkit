import { useSyncExternalStore } from 'react'

/**
 * How the 3D camera answers the keys and the mouse, one switch for every Unigraph view: `orbit` (the default) turns
 * it around the point it looks at — W A S D orbit, Q/E zoom toward that point, arrows slide, a drag orbits — and
 * `fly` moves it from the eye — W/S forward and back, A/D sideways, Q/E down and up, arrows turn the view, a drag
 * looks around, the wheel moves forward — so it goes through the graph and past it. The choice is remembered in
 * this browser. The switch is at the left of the key hint, bottom right of the picture (`GraphNav.tsx`);
 * `graph_viewport` sets it with `controls`.
 */
export type CameraControls = 'orbit' | 'fly'

const KEY = 'aegraph:unigraph:controls'
let current: CameraControls = read()
const listeners = new Set<() => void>()

function read(): CameraControls {
  try {
    return localStorage.getItem(KEY) === 'fly' ? 'fly' : 'orbit'
  } catch {
    return 'orbit'
  }
}

export const getCameraControls = () => current

export function setCameraControls(next: CameraControls) {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private mode: the choice lasts as long as the page */
  }
  listeners.forEach((l) => l())
}

export function useCameraControls(): CameraControls {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => current,
    () => current,
  )
}

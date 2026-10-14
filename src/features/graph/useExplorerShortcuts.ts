import { keyIsElsewhere } from '../../lib/keys'
import { useEffect, type RefObject } from 'react'
import { useViewActiveRef } from '../workstation/paneContext'
import { useExplorer } from './explorerState'
import type { GraphViewHandle } from './view'
import { useSelectionActions } from './useSelectionActions'
import { getCameraControls } from './cameraControls'

/**
 * The explorer's keyboard: Esc clears (the path, then the armed path, then
 * the selection), F fits, ⌘A selects all, I inverts, N adds neighbours, P
 * pins, H hides, V switches between the select tool (drag a box) and the hand, ⌫ asks to delete. Only while this explorer is the one in
 * front, and never from a field or a dialog. The same actions the right-click
 * menu offers, so nothing is reachable by key alone.
 *
 * The camera keys are `useCameraKeys` below, for as long as they are held:
 * orbiting (the default) arrows slide, Q/E zoom, W A S D orbit in 3D;
 * flying (3D, the switch in `cameraControls.ts`) W A S D move, Q/E go down
 * and up, arrows turn the view — the moves `graph_viewport` makes with
 * `pan`, `zoom`, `orbit`, `fly` and `look`.
 */
/** How fast a held key moves the camera, per second: arrows a share of the view, Q/E a zoom factor, WASD radians of orbit. Shift multiplies each. */
const PAN_SPEED = 0.6
const ZOOM_SPEED = 2.5
const ORBIT_SPEED = 1.2
/** Flying: how far a second takes the camera, as a share of the distance the whole graph fits at; and how fast it turns, in radians. */
const FLY_SPEED = 0.4
const LOOK_SPEED = 1.1
const FAST = 3
/** By physical key (`code`), so Shift and the keyboard layout leave them where they are. */
const PAN_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
const ZOOM_KEYS: Record<string, number> = { KeyQ: 1, KeyE: -1 }
const ORBIT_KEYS: Record<string, [number, number]> = { KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, 1], KeyS: [0, -1] }
/** Flying: W/S forward and back, A/D left and right, Q/E down and up; the arrows turn the view (right, up). */
const FLY_KEYS: Record<string, [number, number, number]> = { KeyW: [1, 0, 0], KeyS: [-1, 0, 0], KeyA: [0, -1, 0], KeyD: [0, 1, 0], KeyQ: [0, 0, -1], KeyE: [0, 0, 1] }
const LOOK_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
const isCameraKey = (code: string) => code in PAN_KEYS || code in ZOOM_KEYS || code in ORBIT_KEYS


export function useExplorerShortcuts(viewRef: RefObject<GraphViewHandle | null>, requestDelete: (ids: string[]) => void) {
  const { state, dispatch } = useExplorer()
  const a = useSelectionActions()
  const viewActive = useViewActiveRef()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      if (keyIsElsewhere(e)) return
      const meta = e.metaKey || e.ctrlKey
      switch (e.key) {
        case 'Escape':
          if (state.path) dispatch({ type: 'setPath', path: undefined })
          else if (state.pathFrom) dispatch({ type: 'setPathFrom', id: undefined })
          else if (state.selectedIds.length || state.selectedEdgeId) a.clear()
          else return
          break
        case 'f':
        case 'F':
          if (meta) return
          viewRef.current?.fit()
          break
        case 'a':
        case 'A':
          if (!meta) return
          a.selectAll()
          break
        case 'i':
        case 'I':
          if (meta) return
          a.invert()
          break
        case 'n':
        case 'N':
          if (meta || !a.count) return
          a.neighbours(1)
          break
        case 'p':
        case 'P':
          if (meta || !a.count) return
          a.pin(a.ids, !a.allPinned)
          break
        case 'h':
        case 'H':
          if (meta || !a.count) return
          a.hide(a.ids)
          break
        case 'v':
        case 'V':
          // The select tool and back to the hand (H is Hide; Space held is the hand for as long as it is held).
          if (meta) return
          dispatch({ type: 'setTool', tool: state.tool === 'box' ? 'pan' : 'box' })
          break
        case 'Delete':
        case 'Backspace':
          if (!a.count) return
          requestDelete(a.ids)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a, state.path, state.pathFrom, state.selectedIds.length, state.selectedEdgeId, state.tool, dispatch, viewRef, viewActive, requestDelete])
}

/**
 * The camera keys. Orbiting (the default): the arrows slide the camera, Q zooms in and E out, and in 3D W A S D turn
 * it around the point it looks at (A/D left and right, W/S over the top and from below). Flying (3D): W/S move it
 * forward and back, A/D left and right, Q/E down and up — through the graph and past it — and the arrows turn the
 * view about the eye. The camera glides while a key is held: one frame
 * loop runs while any is down, each frame moving by the time since the last, so a slow frame does not slow the
 * glide; keys combine (a diagonal, a zoom while turning); it stops on release, on a blur, and when the view leaves
 * the front. In 2D, W A S D are left alone.
 */
export function useCameraKeys(viewRef: RefObject<GraphViewHandle | null>) {
  const viewActive = useViewActiveRef()
  useEffect(() => {
    const held = new Set<string>()
    let fast = false
    let raf = 0
    let last = 0
    const stop = () => {
      held.clear()
      cancelAnimationFrame(raf)
      raf = 0
    }
    const frame = (now: number) => {
      const view = viewRef.current
      if (!held.size || !viewActive.current || !view) return stop()
      const dt = Math.min(0.05, (now - last) / 1000) * (fast ? FAST : 1)
      last = now
      // Flying (3D only — in 2D the keys keep their orbit meaning): the same keys move the eye and turn the view.
      if (getCameraControls() === 'fly' && view.getCamera()?.kind === '3d' && view.flyBy && view.lookBy) {
        let fw = 0, rt = 0, up = 0, ly = 0, lp = 0
        for (const k of held) {
          if (k in FLY_KEYS) {
            fw += FLY_KEYS[k][0]
            rt += FLY_KEYS[k][1]
            up += FLY_KEYS[k][2]
          } else if (k in LOOK_KEYS) {
            ly += LOOK_KEYS[k][0]
            lp += LOOK_KEYS[k][1]
          }
        }
        const m = Math.hypot(fw, rt, up)
        if (m) view.flyBy((fw / m) * FLY_SPEED * dt, (rt / m) * FLY_SPEED * dt, (up / m) * FLY_SPEED * dt)
        if (ly || lp) view.lookBy(ly * LOOK_SPEED * dt, lp * LOOK_SPEED * dt)
        raf = requestAnimationFrame(frame)
        return
      }
      let px = 0, py = 0, zoom = 0, yaw = 0, pitch = 0
      for (const k of held) {
        if (k in PAN_KEYS) {
          px += PAN_KEYS[k][0]
          py += PAN_KEYS[k][1]
        } else if (k in ZOOM_KEYS) zoom += ZOOM_KEYS[k]
        else if (k in ORBIT_KEYS) {
          yaw += ORBIT_KEYS[k][0]
          pitch += ORBIT_KEYS[k][1]
        }
      }
      const len = Math.hypot(px, py)
      if (len) view.panBy((px / len) * PAN_SPEED * dt, (py / len) * PAN_SPEED * dt, { fraction: true })
      if (zoom) view.zoomBy(Math.pow(ZOOM_SPEED, zoom * dt))
      if (yaw || pitch) view.orbitBy(yaw * ORBIT_SPEED * dt, pitch * ORBIT_SPEED * dt)
      raf = requestAnimationFrame(frame)
    }
    const down = (e: KeyboardEvent) => {
      if (!isCameraKey(e.code) || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (!viewActive.current || keyIsElsewhere(e)) return
      e.preventDefault() // the page would scroll
      fast = e.shiftKey
      held.add(e.code)
      if (!raf) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') fast = false
      held.delete(e.code)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', stop)
      stop()
    }
  }, [viewRef, viewActive])
}

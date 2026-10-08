import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { keyIsElsewhere } from '../../lib/keys'
import { useViewActiveRef } from '../workstation/paneContext'

/** Share of the view crossed per second while a pan key is held; zoom factor per second; Shift's multiple. */
const PAN_SPEED = 0.6
const ZOOM_SPEED = 2.5
const FAST = 3
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 6

const PAN_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const ZOOM_KEYS: Record<string, number> = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1 }

/**
 * The diagram preview's keys: the arrow keys pan the picture, + and − zoom about the middle of the view (as
 * Unigraph's camera keys zoom), Shift makes both fast. The picture glides while a key is held — one frame loop runs while any is down,
 * each frame moving by the time since the last — keys combine, and it stops on release, a blur, or when the view
 * leaves the front. A key typed into the source, a field or a menu is theirs. Panning scrolls the preview; zooming
 * sets the zoom and scrolls so the point in the middle stays there.
 */
export function usePreviewKeys(previewRef: RefObject<HTMLDivElement | null>, zoom: number, setZoom: (z: number) => void, enabled: boolean) {
  const viewActive = useViewActiveRef()
  const zoomRef = useRef(zoom)
  useLayoutEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  // The point (in unzoomed picture units) to keep in the middle after a zoom this frame set.
  const anchor = useRef<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = previewRef.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = a.x * zoom - el.clientWidth / 2
    el.scrollTop = a.y * zoom - el.clientHeight / 2
  }, [zoom, previewRef])

  useEffect(() => {
    if (!enabled) return
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
      const el = previewRef.current
      if (!held.size || !viewActive.current || !el) return stop()
      const dt = Math.min(0.05, (now - last) / 1000) * (fast ? FAST : 1)
      last = now
      let px = 0
      let py = 0
      let z = 0
      for (const k of held) {
        if (k in PAN_KEYS) {
          px += PAN_KEYS[k][0]
          py += PAN_KEYS[k][1]
        } else if (k in ZOOM_KEYS) z += ZOOM_KEYS[k]
      }
      const len = Math.hypot(px, py)
      if (len) el.scrollBy((px / len) * PAN_SPEED * dt * el.clientWidth, (py / len) * PAN_SPEED * dt * el.clientHeight)
      if (z) {
        const cur = zoomRef.current
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cur * Math.pow(ZOOM_SPEED, z * dt)))
        if (next !== cur) {
          anchor.current = { x: (el.scrollLeft + el.clientWidth / 2) / cur, y: (el.scrollTop + el.clientHeight / 2) / cur }
          zoomRef.current = next
          setZoom(next)
        }
      }
      raf = requestAnimationFrame(frame)
    }
    const down = (e: KeyboardEvent) => {
      if (!(e.code in PAN_KEYS || e.code in ZOOM_KEYS) || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (!viewActive.current || keyIsElsewhere(e)) return
      e.preventDefault()
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
  }, [enabled, previewRef, setZoom, viewActive])
}

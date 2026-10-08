import { Pause, Play, SkipBack, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapWorkbench } from './MapWorkbench'
import { Select } from '../../components/ui/Select'

/**
 * The strip under the map: when things carry times, a histogram of when
 * they happen, the window the map is filtered to (drag its edges or its
 * body; drag on empty track to set a new one), and a playhead that walks
 * through the window (play, speed) so a journey unfolds. Works the same
 * over the 2D canvas and the globe; the workbench holds the state.
 */

const BINS = 120
const SPEEDS = [0.5, 1, 2, 5, 10]

export function MapTimeline({ wb }: { wb: MapWorkbench }) {
  const { span, window: w, setWindow, playhead, setPlayhead, playing, setPlaying, speed, setSpeed, places } = wb
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ kind: 'from' | 'to' | 'body' | 'new' | 'head'; x0: number; from: number; to: number } | null>(null)

  // The track spans the data plus a margin so a window can reach past its ends.
  const track = useMemo(() => {
    if (!span) return null
    const lo0 = Math.min(span.min, w?.from ?? span.min)
    const hi0 = Math.max(span.max, w?.to ?? span.max)
    const margin = Math.max(3_600_000, (hi0 - lo0) * 0.06)
    return { lo: lo0 - margin, hi: hi0 + margin }
  }, [span, w])
  const bins = useMemo(() => {
    if (!track) return []
    const out = new Array<number>(BINS).fill(0)
    const width = (track.hi - track.lo) / BINS
    for (const p of places) {
      if (!p.data.at) continue
      const a = Date.parse(p.data.at)
      const u = p.data.until ? Date.parse(p.data.until) : a
      if (Number.isNaN(a)) continue
      const i0 = Math.max(0, Math.floor((a - track.lo) / width))
      const i1 = Math.min(BINS - 1, Math.floor((Math.max(a, u) - track.lo) / width))
      for (let i = i0; i <= i1; i++) out[i]++
    }
    const max = Math.max(1, ...out)
    return out.map((n) => n / max)
  }, [places, track])

  const toX = useCallback((t: number) => (track ? ((t - track.lo) / (track.hi - track.lo)) * 100 : 0), [track])
  const toT = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el || !track) return 0
      const r = el.getBoundingClientRect()
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      return track.lo + f * (track.hi - track.lo)
    },
    [track],
  )

  const from = w?.from ?? span?.min ?? 0
  const to = w?.to ?? span?.max ?? 0

  const onDown = (kind: 'from' | 'to' | 'body' | 'head') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setDrag({ kind, x0: e.clientX, from, to })
    if (kind === 'head') setPlaying(false)
  }
  const onTrackDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = toT(e.clientX)
    // A click on the track moves the playhead there; a drag draws a new window.
    setPlaying(false)
    setPlayhead(t)
    setDrag({ kind: 'new', x0: e.clientX, from: t, to: t })
  }
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const t = toT(e.clientX)
      if (drag.kind === 'head') return setPlayhead(t)
      if (drag.kind === 'new') {
        if (Math.abs(e.clientX - drag.x0) < 4) return
        const a = toT(drag.x0)
        setWindow({ from: Math.min(a, t), to: Math.max(a, t) })
        return
      }
      const dt = t - toT(drag.x0)
      if (drag.kind === 'from') setWindow({ from: Math.min(drag.from + dt, drag.to - 60_000), to: drag.to })
      else if (drag.kind === 'to') setWindow({ from: drag.from, to: Math.max(drag.to + dt, drag.from + 60_000) })
      else setWindow({ from: drag.from + dt, to: drag.to + dt })
    }
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, toT, setWindow, setPlayhead])

  if (!span || !track) return null
  const fmt = (t: number) => {
    const d = new Date(t)
    const days = (track.hi - track.lo) / 86_400_000
    return days > 400 ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : days > 3 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const ticks = 6
  const fitted = w && w.from === span.min && w.to === span.max

  return (
    <div className="tl">
      <div className="tl__controls">
        <button className="btn btn--sm btn--icon" onClick={() => (setPlaying(false), setPlayhead(w?.from ?? span.min))} title="Back to the start">
          <SkipBack size={13} />
        </button>
        <button className="btn btn--sm btn--icon btn--primary" onClick={() => setPlaying(!playing)} title={playing ? 'Pause' : 'Play through the window'}>
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <Select className="input tl__speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </Select>
        <span className="tl__now mono">{playhead === undefined ? 'all of the window' : new Date(playhead).toLocaleString()}</span>
        {playhead !== undefined && (
          <button className="btn btn--sm btn--ghost btn--icon" onClick={() => (setPlaying(false), setPlayhead(undefined))} title="Show the whole window again">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="tl__track" ref={trackRef} onPointerDown={onTrackDown}>
        <div className="tl__bins">
          {bins.map((h, i) => (
            <i key={i} style={{ height: `${Math.max(2, h * 100)}%` }} />
          ))}
        </div>
        <div className="tl__window" style={{ left: `${toX(from)}%`, width: `${Math.max(0.3, toX(to) - toX(from))}%` }} onPointerDown={onDown('body')} title={`${new Date(from).toLocaleString()} – ${new Date(to).toLocaleString()} · drag to move`}>
          <span className="tl__edge tl__edge--from" onPointerDown={onDown('from')} />
          <span className="tl__edge tl__edge--to" onPointerDown={onDown('to')} />
        </div>
        {playhead !== undefined && (
          <div className="tl__head" style={{ left: `${toX(playhead)}%` }} onPointerDown={onDown('head')}>
            <span className="tl__head-label">{fmt(playhead)}</span>
          </div>
        )}
        <div className="tl__ticks">
          {Array.from({ length: ticks + 1 }, (_, i) => {
            const t = track.lo + ((track.hi - track.lo) * i) / ticks
            return (
              <span key={i} style={{ left: `${(i / ticks) * 100}%` }}>
                {fmt(t)}
              </span>
            )
          })}
        </div>
      </div>
      <div className="tl__side">
        <span className="muted tl__range">
          {new Date(from).toLocaleDateString()} – {new Date(to).toLocaleDateString()}
        </span>
        <button className="btn btn--sm btn--ghost" disabled={!!fitted} onClick={() => setWindow({ from: span.min, to: span.max })} title="Set the window to the span of the data">
          Fit
        </button>
        {w && (
          <button className="btn btn--sm btn--ghost" onClick={() => (setWindow(null), setPlayhead(undefined), setPlaying(false))} title="Lift the time filter">
            All time
          </button>
        )}
      </div>
    </div>
  )
}

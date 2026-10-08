import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { EntityId } from '../../core/entity/types'
import { assignLanes, clock, type AudioAnnotation, type TimeRange } from './audio'

/**
 * A scrubbable timeline with annotation spans stacked in lanes, a draggable
 * pending range (in/out points), and resize handles on the selected span.
 *
 * All positions are fractions of the duration; the component never knows
 * about the player beyond `current` and `onSeek`.
 */

export interface RangeTimelineProps {
  duration: number
  current: number
  annotations: AudioAnnotation[]
  selected: EntityId | null
  pending: TimeRange | null
  colorOf: (a: AudioAnnotation) => string
  onSeek: (t: number) => void
  onPick: (a: AudioAnnotation) => void
  onPendingChange: (r: TimeRange | null) => void
  onRetime: (a: AudioAnnotation, r: TimeRange) => void
  /** Optional accent for the pending range. */
  pendingColor?: string
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pending-start' | 'pending-end' | 'pending-move'; origin: TimeRange; grabAt: number }
  | { kind: 'ann-start' | 'ann-end' | 'ann-move'; a: AudioAnnotation; origin: TimeRange; grabAt: number }

const LANE_H = 16
const SCRUB_H = 22
const MIN_LEN = 0.2

export function RangeTimeline({ duration, current, annotations, selected, pending, colorOf, onSeek, onPick, onPendingChange, onRetime, pendingColor = '#1db954' }: RangeTimelineProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  /** Live value while dragging an annotation, so the store isn't written on every pointer move. */
  const [liveAnn, setLiveAnn] = useState<{ id: EntityId; r: TimeRange } | null>(null)

  const lanes = useMemo(() => assignLanes(annotations, 0.5), [annotations])
  const laneCount = Math.max(1, lanes.reduce((m, l) => Math.max(m, l.lane + 1), 0))
  const pct = (s: number) => (duration ? Math.max(0, Math.min(100, (s / duration) * 100)) : 0)
  const toTime = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration))
  }

  const rangeOf = (a: AudioAnnotation): TimeRange => (liveAnn?.id === a.annotation.id ? liveAnn.r : { start: a.time.start, end: a.time.end })

  // ── Pointer handling ──────────────────────────────────────────────────
  const begin = (e: ReactPointerEvent, d: Drag) => {
    if (e.button !== 0 || !duration) return
    e.stopPropagation()
    e.preventDefault()
    setDrag(d)
    try {
      ref.current?.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic */
    }
    if (d.kind === 'scrub') onSeek(toTime(e.clientX))
  }

  const onMove = (e: ReactPointerEvent) => {
    const t = toTime(e.clientX)
    setHoverT(t)
    if (!drag) return
    if (drag.kind === 'scrub') return onSeek(t)
    const delta = t - drag.grabAt
    const o = drag.origin
    const next = (kind: string): TimeRange => {
      if (kind.endsWith('start')) return { start: Math.min(t, (o.end ?? duration) - MIN_LEN), end: o.end }
      if (kind.endsWith('end')) return { start: o.start, end: Math.max(t, o.start + MIN_LEN) }
      const len = (o.end ?? o.start) - o.start
      const start = Math.max(0, Math.min(duration - len, o.start + delta))
      return { start, end: o.end != null ? start + len : undefined }
    }
    if ('a' in drag) setLiveAnn({ id: drag.a.annotation.id, r: next(drag.kind) })
    else onPendingChange(next(drag.kind))
  }

  const onUp = () => {
    if (drag && 'a' in drag && liveAnn) onRetime(drag.a, liveAnn.r)
    setLiveAnn(null)
    setDrag(null)
  }

  // Keyboard nudging on handles: ←/→ 0.5s, shift for 5s.
  const nudge = (e: ReactKeyboardEvent, apply: (d: number) => void) => {
    const step = e.shiftKey ? 5 : 0.5
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    apply(e.key === 'ArrowLeft' ? -step : step)
  }

  const height = SCRUB_H + laneCount * LANE_H + 6

  return (
    <div
      ref={ref}
      className={`mt ${drag ? 'is-dragging' : ''}`}
      style={{ height }}
      role="group"
      aria-label="Timeline"
      onPointerDown={(e) => begin(e, { kind: 'scrub' })}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => !drag && setHoverT(null)}
    >
      {/* Scrub bar */}
      <div className="mt__track" />
      <div className="mt__progress" style={{ width: `${pct(current)}%` }} />
      {hoverT != null && !drag && (
        <div className="mt__hover" style={{ left: `${pct(hoverT)}%` }}>
          <span>{clock(hoverT)}</span>
        </div>
      )}

      {/* Annotation lanes */}
      {lanes.map(({ lane, a }) => {
        const r = rangeOf(a)
        const color = colorOf(a)
        const isSel = selected === a.annotation.id
        const top = SCRUB_H + lane * LANE_H + 2
        const n = annotations.indexOf(a) + 1
        const title = `${n} · ${r.end != null ? `${clock(r.start)}–${clock(r.end)}` : clock(r.start)}: ${a.annotation.data.comment ?? ''}`
        if (r.end == null) {
          return (
            <button
              key={a.annotation.id}
              className={`mt__point ${isSel ? 'is-selected' : ''}`}
              style={{ left: `${pct(r.start)}%`, top, background: color }}
              title={title}
              onPointerDown={(e) => (isSel ? begin(e, { kind: 'ann-move', a, origin: r, grabAt: toTime(e.clientX) }) : (e.stopPropagation(), e.preventDefault()))}
              onClick={(e) => (e.stopPropagation(), onPick(a))}
            >
              {n}
            </button>
          )
        }
        return (
          <div
            key={a.annotation.id}
            className={`mt__span ${isSel ? 'is-selected' : ''}`}
            style={{ left: `${pct(r.start)}%`, width: `${pct(r.end) - pct(r.start)}%`, top, background: color }}
            title={title}
            onPointerDown={(e) => (isSel ? begin(e, { kind: 'ann-move', a, origin: r, grabAt: toTime(e.clientX) }) : (e.stopPropagation(), e.preventDefault()))}
            onClick={(e) => (e.stopPropagation(), onPick(a))}
          >
            <span className="mt__span-n">{n}</span>
            {isSel && (
              <>
                <span
                  className="mt__handle mt__handle--l"
                  role="slider"
                  tabIndex={0}
                  aria-label="Start"
                  aria-valuenow={Math.round(r.start)}
                  onPointerDown={(e) => begin(e, { kind: 'ann-start', a, origin: r, grabAt: toTime(e.clientX) })}
                  onKeyDown={(e) => nudge(e, (d) => onRetime(a, { start: Math.max(0, r.start + d), end: r.end }))}
                />
                <span
                  className="mt__handle mt__handle--r"
                  role="slider"
                  tabIndex={0}
                  aria-label="End"
                  aria-valuenow={Math.round(r.end)}
                  onPointerDown={(e) => begin(e, { kind: 'ann-end', a, origin: r, grabAt: toTime(e.clientX) })}
                  onKeyDown={(e) => nudge(e, (d) => onRetime(a, { start: r.start, end: Math.min(duration, (r.end ?? r.start) + d) }))}
                />
              </>
            )}
          </div>
        )
      })}

      {/* Pending range (in/out points) */}
      {pending && (
        <div
          className="mt__pending"
          style={{ left: `${pct(pending.start)}%`, width: pending.end != null ? `${pct(pending.end) - pct(pending.start)}%` : 2, borderColor: pendingColor, background: `${pendingColor}22` }}
          onPointerDown={(e) => begin(e, { kind: 'pending-move', origin: pending, grabAt: toTime(e.clientX) })}
        >
          <span className="mt__pending-chip" style={{ background: pendingColor }}>
            {pending.end != null ? `${clock(pending.start)}–${clock(pending.end)}` : clock(pending.start)}
          </span>
          <span
            className="mt__handle mt__handle--l"
            style={{ background: pendingColor }}
            role="slider"
            tabIndex={0}
            aria-label="Range start"
            aria-valuenow={Math.round(pending.start)}
            onPointerDown={(e) => begin(e, { kind: 'pending-start', origin: pending, grabAt: toTime(e.clientX) })}
            onKeyDown={(e) => nudge(e, (d) => onPendingChange({ start: Math.max(0, pending.start + d), end: pending.end }))}
          />
          {pending.end != null && (
            <span
              className="mt__handle mt__handle--r"
              style={{ background: pendingColor }}
              role="slider"
              tabIndex={0}
              aria-label="Range end"
              aria-valuenow={Math.round(pending.end)}
              onPointerDown={(e) => begin(e, { kind: 'pending-end', origin: pending, grabAt: toTime(e.clientX) })}
              onKeyDown={(e) => nudge(e, (d) => onPendingChange({ start: pending.start, end: Math.min(duration, pending.end! + d) }))}
            />
          )}
        </div>
      )}

      <div className="mt__playhead" style={{ left: `${pct(current)}%` }} />
    </div>
  )
}

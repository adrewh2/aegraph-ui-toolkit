import { Pause, Play, RotateCcw, RotateCw, SquareDashed, StickyNote } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { clock } from '../../core/entity/ids'
import { RangeTimeline } from '../audio/RangeTimeline'
import type { TimeRange } from '../audio/audio'
import { isActiveAt, normalizeFrameBox, timeAnnotationsOf, type FrameBox, type VideoAnnotation, type VideoEntity } from './videos'
import { useYouTubePlayer } from './youtube'
import './videos.css'

const DEFAULT_COLOR = '#f59e0b'

export interface VideoPick {
  start: number
  end?: number
  region?: FrameBox
}

/**
 * The video page's tools, as a picker: the real YouTube player, transport,
 * the annotation timeline with a draggable in/out range, "Note at" for a
 * moment, and "Draw box" to mark a region of the frame at the playhead.
 * Reports the pick; the caller creates the annotation.
 */
export function VideoPicker({ video, value, disabled, onChange }: { video: VideoEntity; value: VideoPick | null; disabled?: boolean; onChange: (p: VideoPick | null) => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const host = useRef<HTMLDivElement>(null)
  const player = useYouTubePlayer(host, video.data.videoId, value?.start)
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<FrameBox | null>(null)
  const overlay = useRef<SVGSVGElement>(null)

  const t = player.currentTime
  const duration = player.duration || video.data.duration || 0
  const annotations = useMemo(() => timeAnnotationsOf(store, video.id), [store, video.id])
  const active = annotations.filter((a) => isActiveAt(a, t))
  const colorOf = useCallback((a: VideoAnnotation) => a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) ?? DEFAULT_COLOR, [store])

  const pending: TimeRange | null = value ? { start: value.start, end: value.end } : null
  const setPending = (r: TimeRange | null) => onChange(r ? { start: r.start, end: r.end, region: value?.region } : null)
  const noteHere = () => {
    player.pause()
    onChange({ start: t })
  }
  const markIn = () => onChange({ start: t, end: value?.end != null && value.end > t ? value.end : undefined, region: value?.region })
  const markOut = () => onChange(value && value.start < t ? { ...value, end: t } : { start: Math.max(0, t - 10), end: t })

  // Drawing on the frame (fractions of width/height).
  const toFrame = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing || e.button !== 0) return
    player.pause()
    const p = toFrame(e)
    setDraft({ x: p.x, y: p.y, width: 0, height: 0 })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic pointer */
    }
  }
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft) return
    const p = toFrame(e)
    setDraft({ ...draft, width: p.x - draft.x, height: p.y - draft.y })
  }
  const onUp = () => {
    if (!draft) return
    const box = normalizeFrameBox(draft)
    setDraft(null)
    if (box) {
      setDrawing(false)
      onChange({ start: t, region: box })
    }
  }

  return (
    <div className={`vpk ${disabled ? 'is-disabled' : ''}`}>
      <div className="vpk__bar">
        <button className="tb__btn" title={player.playing ? 'Pause' : 'Play'} disabled={!player.ready} onClick={player.toggle}>
          {player.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="tb__btn" title="Back 5s" disabled={!player.ready} onClick={() => player.seek(t - 5)}>
          <RotateCcw size={13} />
        </button>
        <button className="tb__btn" title="Forward 5s" disabled={!player.ready} onClick={() => player.seek(t + 5)}>
          <RotateCw size={13} />
        </button>
        <span className="vp__clock">
          {clock(t)} <span className="faint">/ {duration ? clock(duration) : '–:––'}</span>
        </span>
        <span className="tb__sep" />
        <button className="btn btn--sm" onClick={noteHere} title="Annotate this moment">
          <StickyNote size={13} /> Note at {clock(t)}
        </button>
        <button className={`btn btn--sm ${value && value.end == null && !value.region ? 'is-on' : ''}`} onClick={markIn} title="Set the range start at the playhead">
          In
        </button>
        <button className="btn btn--sm" onClick={markOut} title="Set the range end at the playhead">
          Out
        </button>
        <button
          className={`btn btn--sm ${drawing ? 'is-on' : ''}`}
          onClick={() => {
            const next = !drawing
            setDrawing(next)
            if (next) player.pause()
          }}
          title="Draw a box on the frame at this moment"
        >
          <SquareDashed size={13} /> Draw box
        </button>
        <span className="spacer" />
        <span className="muted vpk__status">{drawing ? 'drag on the video' : active.length ? `${active.length} annotation${active.length === 1 ? '' : 's'} here` : ''}</span>
      </div>
      <div className="vpk__stage">
        <div className={`vp__frame vpk__frame ${drawing ? 'is-drawing' : ''}`}>
          <div ref={host} className="vp__player" />
          {player.error && <div className="vp__error">{player.error}</div>}
          {!player.ready && !player.error && <div className="vp__loading muted">Loading player…</div>}
          <svg ref={overlay} className="vp__overlay" viewBox="0 0 1 1" preserveAspectRatio="none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDraft(null)}>
            {active
              .filter((a) => a.time.region)
              .map((a) => {
                const b = a.time.region!
                return <rect key={a.annotation.id} x={b.x} y={b.y} width={b.width} height={b.height} fill={colorOf(a)} fillOpacity={0.1} stroke={colorOf(a)} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              })}
            {value?.region && Math.abs(t - value.start) < 1.5 && <rect x={value.region.x} y={value.region.y} width={value.region.width} height={value.region.height} fill={DEFAULT_COLOR} fillOpacity={0.18} stroke={DEFAULT_COLOR} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
            {draft && draft.width !== 0 && draft.height !== 0 && (
              <rect x={Math.min(draft.x, draft.x + draft.width)} y={Math.min(draft.y, draft.y + draft.height)} width={Math.abs(draft.width)} height={Math.abs(draft.height)} fill={DEFAULT_COLOR} fillOpacity={0.15} stroke={DEFAULT_COLOR} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        </div>
      </div>
      <div className="vpk__timeline">
        <RangeTimeline duration={duration} current={t} annotations={annotations} selected={null} pending={pending} colorOf={colorOf} onSeek={player.seek} onPick={(a) => player.seek(a.time.start)} onPendingChange={setPending} onRetime={() => {}} pendingColor={DEFAULT_COLOR} />
      </div>
    </div>
  )
}

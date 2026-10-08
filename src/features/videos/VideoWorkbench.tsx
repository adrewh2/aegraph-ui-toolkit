import { Camera, ExternalLink, Pause, Play, RotateCcw, RotateCw, SquareDashed, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useViewActiveRef } from '../workstation/paneContext'
import { DataImage } from '../../components/RemoteImage'
import { cssImageUrl, useImageGate } from '../../components/imageGate'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { captureSupported, FrameCapturer, stillOf, type Still } from './capture'
import { setPlayback, setPlayerHandle } from './playback'
import { clock, isActiveAt, normalizeFrameBox, otherAnnotationsOf, timeAnnotationsOf, youtubeUrl, type FrameBox, type VideoAnnotation, type VideoEntity } from './videos'
import { useYouTubePlayer } from './youtube'
import './videos.css'

const STILLS_KEY = 'aegraph:videos:stills'
const DEFAULT_COLOR = '#f59e0b'

export interface PendingTime {
  start: number
  end?: number
  region?: FrameBox
  /** A still of the frame, captured when the annotation was started. */
  still?: Still
}

export interface WorkbenchOptions {
  onAnnotate: (t: PendingTime) => void
  /** A frame captured without a comment. */
  onCaptured: (t: number, still: Still) => void
  initialTime?: number
  /** Selects this annotation when it changes (e.g. one that was just created). */
  selectId?: EntityId | null
}

/**
 * Everything the video page and the Library's video tab share: the player,
 * frame stills, drawing on the frame, and the current selection. Both
 * render the pieces below from this state.
 */
export function useVideoWorkbench(video: VideoEntity, { onAnnotate, onCaptured, initialTime, selectId = null }: WorkbenchOptions) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const host = useRef<HTMLDivElement>(null)
  const player = useYouTubePlayer(host, video.data.videoId, initialTime)
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<{ at: number; box: FrameBox } | null>(null)
  const [selected, setSelected] = useState<EntityId | null>(null)

  // ── Frame stills ─────────────────────────────────────────────────────
  const frame = useRef<HTMLDivElement>(null)
  const capturer = useRef<FrameCapturer | null>(null)
  const [saveStills, setSaveStillsState] = useState(() => captureSupported() && read(STILLS_KEY) !== '0')
  const [capturing, setCapturing] = useState(false)
  const [preview, setPreview] = useState<{ still: Still; region?: FrameBox; title: string } | null>(null)
  const setSaveStills = (v: boolean) => (setSaveStillsState(v), write(STILLS_KEY, v ? '1' : '0'))
  useEffect(() => () => capturer.current?.stop(), [])

  /** Pause, hide our overlays, and grab the frame. Returns nothing (with a toast) when capture is refused. */
  const captureFrame = async (): Promise<Still | undefined> => {
    if (!frame.current) return undefined
    player.pause()
    capturer.current ??= new FrameCapturer()
    setCapturing(true)
    try {
      return await capturer.current.capture(frame.current)
    } catch (err) {
      toast(err instanceof DOMException && err.name === 'NotAllowedError' ? 'Frame not saved — tab capture was declined.' : `Frame not saved: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    } finally {
      setCapturing(false)
    }
  }

  const [seenSelectId, setSeenSelectId] = useState(selectId)
  if (selectId !== seenSelectId) {
    setSeenSelectId(selectId)
    if (selectId) setSelected(selectId)
  }

  const timed = timeAnnotationsOf(store, video.id)
  const others = otherAnnotationsOf(store, video.id)
  const t = player.currentTime
  const duration = player.duration || video.data.duration || 0
  const active = useMemo(() => timed.filter((a) => isActiveAt(a, t)), [timed, t])
  const colorOf = (a: VideoAnnotation) => a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) ?? DEFAULT_COLOR

  // Let the assistant know where playback is, and how to seek/capture.
  useEffect(() => {
    setPlayback({ videoId: video.id, currentTime: t, playing: player.playing, duration: duration || undefined })
    return () => setPlayback(null)
  }, [video.id, t, player.playing, duration])
  useEffect(() => {
    setPlayerHandle({ seek: player.seek, play: player.play, pause: player.pause, capture: captureFrame })
    return () => setPlayerHandle(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.seek, player.play, player.pause])

  // Space toggles playback when focus isn't in a field.
  const viewActive = useViewActiveRef()
  const { toggle } = player
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      if (e.key === ' ' && !(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  // Remember the duration on the entity once the player reports it.
  useEffect(() => {
    if (player.duration && Math.round(player.duration) !== video.data.duration) store.update(video.id, { data: { ...video.data, duration: Math.round(player.duration) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.duration])

  const jumpTo = (a: VideoAnnotation) => {
    setSelected(a.annotation.id)
    player.seek(a.time.start)
    if (a.time.region) player.pause()
  }

  // ── Drawing on the frame ─────────────────────────────────────────────
  const overlay = useRef<SVGSVGElement>(null)
  const toFrame = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing || e.button !== 0) return
    player.pause()
    const p = toFrame(e)
    setDraft({ at: t, box: { x: p.x, y: p.y, width: 0, height: 0 } })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic pointer */
    }
  }
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft) return
    const p = toFrame(e)
    setDraft({ ...draft, box: { ...draft.box, width: p.x - draft.box.x, height: p.y - draft.box.y } })
  }
  const onUp = async () => {
    if (!draft) return
    const box = normalizeFrameBox(draft.box)
    setDraft(null)
    if (box) {
      setDrawing(false)
      const still = saveStills ? await captureFrame() : undefined
      onAnnotate({ start: draft.at, region: box, still })
    }
  }
  const noteHere = async () => {
    const at = t
    player.pause()
    const still = saveStills ? await captureFrame() : undefined
    onAnnotate({ start: at, still })
  }
  const snap = async () => {
    const at = t
    const still = await captureFrame()
    if (still) onCaptured(at, still)
  }

  return {
    store,
    video,
    player,
    host,
    frame,
    overlay,
    t,
    duration,
    timed,
    others,
    active,
    colorOf,
    drawing,
    setDrawing,
    draft,
    setDraft,
    selected,
    setSelected,
    capturing,
    saveStills,
    setSaveStills,
    preview,
    setPreview,
    jumpTo,
    onDown,
    onMove,
    onUp,
    noteHere,
    snap,
  }
}

export type VideoWorkbench = ReturnType<typeof useVideoWorkbench>

/** Play/seek/clock and the annotation actions. */
export function VideoToolbar({ wb, compact = false }: { wb: VideoWorkbench; compact?: boolean }) {
  const { player, t, duration, drawing, setDrawing, capturing, saveStills, setSaveStills, noteHere, snap } = wb
  return (
    <div className="tb" role="toolbar" aria-label="Playback">
      <button className="tb__btn" title={player.playing ? 'Pause (space)' : 'Play (space)'} disabled={!player.ready} onClick={player.toggle}>
        {player.playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button className="tb__btn" title="Back 5s" disabled={!player.ready} onClick={() => player.seek(t - 5)}>
        <RotateCcw size={14} />
      </button>
      <button className="tb__btn" title="Forward 5s" disabled={!player.ready} onClick={() => player.seek(t + 5)}>
        <RotateCw size={14} />
      </button>
      <span className="vp__clock" title="Current time / duration">
        {clock(t)} <span className="faint">/ {duration ? clock(duration) : '–:––'}</span>
      </span>
      <span className="tb__sep" />
      <button className="btn btn--sm" disabled={!player.ready || capturing} onClick={noteHere} title="Annotate this moment">
        <StickyNote size={13} /> {compact ? 'Note' : `Note at ${clock(t)}`}
      </button>
      <button
        className={`btn btn--sm ${drawing ? 'is-on' : ''}`}
        disabled={!player.ready}
        onClick={() => {
          const next = !drawing
          setDrawing(next)
          if (next) player.pause()
        }}
        title="Draw a box on the frame at this moment"
      >
        <SquareDashed size={13} /> Draw box
      </button>
      {captureSupported() && (
        <>
          <button className="btn btn--sm" disabled={!player.ready || capturing} onClick={snap} title="Save a still of this frame (asks to share this tab the first time)">
            <Camera size={13} /> {capturing ? 'Capturing…' : compact ? 'Capture' : 'Capture frame'}
          </button>
          <label className="vp__stills-toggle muted" title="Also save a still of the frame with every note or box">
            <input type="checkbox" checked={saveStills} onChange={(e) => setSaveStills(e.target.checked)} /> stills
          </label>
        </>
      )}
    </div>
  )
}

/** The frame (player + drawn regions), the timeline, and what's annotated at this moment. */
export function VideoStage({ wb }: { wb: VideoWorkbench }) {
  const { player, host, frame, overlay, t, duration, timed, active, colorOf, drawing, draft, setDraft, selected, setSelected, capturing, jumpTo, onDown, onMove, onUp } = wb
  return (
    <>
      <div ref={frame} className={`vp__frame ${drawing ? 'is-drawing' : ''} ${capturing ? 'is-capturing' : ''}`}>
        <div ref={host} className="vp__player" />
        {player.error && <div className="vp__error">{player.error}</div>}
        {!player.ready && !player.error && <div className="vp__loading muted">Loading player…</div>}
        <svg ref={overlay} className="vp__overlay" viewBox="0 0 1 1" preserveAspectRatio="none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDraft(null)}>
          {active
            .filter((a) => a.time.region)
            .map((a) => {
              const b = a.time.region!
              const color = colorOf(a)
              const n = timed.indexOf(a) + 1
              const sel = selected === a.annotation.id
              return (
                <g key={a.annotation.id} className="vp__box" onClick={() => setSelected(a.annotation.id)}>
                  <rect x={b.x} y={b.y} width={b.width} height={b.height} fill={color} fillOpacity={sel ? 0.22 : 0.1} stroke={color} strokeWidth={sel ? 3 : 2} vectorEffect="non-scaling-stroke">
                    <title>{`${n} · ${a.annotation.data.comment ?? ''}`}</title>
                  </rect>
                </g>
              )
            })}
          {draft && draft.box.width !== 0 && draft.box.height !== 0 && (
            <rect
              x={Math.min(draft.box.x, draft.box.x + draft.box.width)}
              y={Math.min(draft.box.y, draft.box.y + draft.box.height)}
              width={Math.abs(draft.box.width)}
              height={Math.abs(draft.box.height)}
              fill={DEFAULT_COLOR}
              fillOpacity={0.15}
              stroke={DEFAULT_COLOR}
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Number badges live outside the SVG so they keep a fixed pixel size. */}
        <div className="vp__labels">
          {active
            .filter((a) => a.time.region)
            .map((a) => (
              <span key={a.annotation.id} className="vp__box-label" style={{ left: `${a.time.region!.x * 100}%`, top: `${a.time.region!.y * 100}%`, background: colorOf(a) }}>
                {timed.indexOf(a) + 1}
              </span>
            ))}
        </div>
      </div>

      <Timeline duration={duration} current={t} annotations={timed} selected={selected} onSeek={player.seek} onPick={jumpTo} colorOf={colorOf} />

      {active.length > 0 && (
        <div className="vp__now">
          {active.map((a) => (
            <button key={a.annotation.id} className={`vp__now-item ${selected === a.annotation.id ? 'is-selected' : ''}`} style={{ borderLeftColor: colorOf(a) }} onClick={() => setSelected(a.annotation.id)}>
              <span className="vp__chip">{clock(a.time.start)}</span>
              {a.time.region && <SquareDashed size={12} className="faint" />}
              <span className="vp__now-text">{String(a.annotation.data.comment || a.annotation.label || '')}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** The list of annotations: timed ones first (jump on click, still thumbnails), then whole-video notes. */
export function VideoAnnotationList({ wb, onInspect, onDelete }: { wb: VideoWorkbench; onInspect: (id: EntityId) => void; onDelete: (id: EntityId) => void }) {
  const { store, timed, others, active, colorOf, selected, jumpTo, setPreview } = wb
  return (
    <div className="anns__body">
      {timed.length === 0 && others.length === 0 && (
        <div className="anns__empty muted">
          Play the video and press <strong>Note at …</strong> to annotate a moment, or <strong>Draw box</strong> to mark part of the frame. Each becomes an annotation entity linked with a <code>time</code> selector.
        </div>
      )}
      {timed.map((a, i) => {
        const color = colorOf(a)
        const isSel = selected === a.annotation.id
        const isNow = active.includes(a)
        return (
          <div key={a.annotation.id} className={`ann vp__ann ${isSel ? 'is-selected' : ''} ${isNow ? 'is-now' : ''}`} style={{ borderLeftColor: color }} onClick={() => jumpTo(a)}>
            <div className="vp__ann-row">
              <span className="ip__ann-num" style={{ background: color }}>
                {i + 1}
              </span>
              <span className="vp__chip" title="Jump to this moment">
                {clock(a.time.start)}
                {a.time.end != null ? `–${clock(a.time.end)}` : ''}
              </span>
              {a.time.region && (
                <span className="badge" title={`Region ${Math.round(a.time.region.width * 100)}×${Math.round(a.time.region.height * 100)}% of the frame`}>
                  <SquareDashed size={11} /> region
                </span>
              )}
            </div>
            {(() => {
              const still = stillOf(a.annotation)
              return still ? (
                <button
                  className="vp__still"
                  title="View the saved frame"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPreview({ still, region: a.time.region, title: `${clock(a.time.start)} · ${a.annotation.data.comment || 'Still'}` })
                  }}
                >
                  <StillThumb still={still} region={a.time.region} />
                </button>
              ) : null
            })()}
            {a.annotation.data.comment ? <div className="ann__comment">{String(a.annotation.data.comment)}</div> : <div className="faint">No comment</div>}
            <div className="ann__meta">
              {a.annotation.tags.map((x) => (
                <TagChip key={x} tag={x} color={store.getTagInfo(x).color} />
              ))}
              <span className="muted" title={new Date(a.annotation.meta.createdAt).toLocaleString()}>
                {formatDate(a.annotation.meta.createdAt)}
              </span>
              <span className="spacer" />
              <button className="btn btn--sm btn--ghost" onClick={(e) => (e.stopPropagation(), onInspect(a.annotation.id))}>
                Details
              </button>
              <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={(e) => (e.stopPropagation(), onDelete(a.annotation.id))} title="Delete annotation">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )
      })}
      {others.length > 0 && <div className="ip__ann-section muted">Whole video</div>}
      {others.map((a) => (
        <div key={a.annotation.id} className="ann" style={{ borderLeftColor: a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) }}>
          {a.annotation.data.comment && <div className="ann__comment">{String(a.annotation.data.comment)}</div>}
          <div className="ann__meta">
            {a.annotation.tags.map((x) => (
              <TagChip key={x} tag={x} color={store.getTagInfo(x).color} />
            ))}
            <span className="muted">{formatDate(a.annotation.meta.createdAt)}</span>
            <span className="spacer" />
            <button className="btn btn--sm btn--ghost" onClick={() => onInspect(a.annotation.id)}>
              Details
            </button>
            <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={() => onDelete(a.annotation.id)} title="Delete annotation">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The saved frame at full size, with its region if it had one. */
export function StillPreviewDialog({ wb }: { wb: VideoWorkbench }) {
  const { preview, setPreview } = wb
  if (!preview) return null
  return (
    <Dialog open wide title={preview.title} onClose={() => setPreview(null)}>
      <div className="vp__preview">
        <DataImage src={preview.still.dataUrl} alt="" />
        {preview.region && (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none">
            <rect x={preview.region.x} y={preview.region.y} width={preview.region.width} height={preview.region.height} fill="#f59e0b" fillOpacity={0.12} stroke="#f59e0b" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {preview.still.width}×{preview.still.height} · saved with the annotation
        {preview.region ? ` · region ${Math.round(preview.region.width * 100)}×${Math.round(preview.region.height * 100)}% of the frame` : ''}
      </div>
    </Dialog>
  )
}

export function VideoMeta({ video }: { video: VideoEntity }) {
  return (
    <div className="vp__meta muted">
      <a href={youtubeUrl(video.data.videoId)} target="_blank" rel="noreferrer noopener">
        <ExternalLink size={12} /> Watch on YouTube
      </a>
      {video.data.channel && <span>· {video.data.channel}</span>}
      {video.data.publishedAt && <span>· published {formatDate(video.data.publishedAt)}</span>}
    </div>
  )
}

/** Cropped to the region when there is one, else the whole frame, at thumbnail size. */
function StillThumb({ still, region, size = 120 }: { still: Still; region?: FrameBox; size?: number }) {
  // A still is data (a bundle can carry any address in it): drawn only where `useImageGate` would show it.
  const gate = useImageGate(still.dataUrl)
  const r = region ?? { x: 0, y: 0, width: 1, height: 1 }
  const bw = r.width * still.width
  const bh = r.height * still.height
  const k = Math.min(size / bw, (size * 0.6) / bh)
  return (
    <span
      className="ip__crop vp__still-img"
      style={{
        width: Math.max(12, bw * k),
        height: Math.max(12, bh * k),
        backgroundImage: gate?.status === 'show' ? cssImageUrl(gate.src) : undefined,
        backgroundSize: `${still.width * k}px ${still.height * k}px`,
        backgroundPosition: `-${r.x * still.width * k}px -${r.y * still.height * k}px`,
      }}
    />
  )
}

function Timeline({
  duration,
  current,
  annotations,
  selected,
  onSeek,
  onPick,
  colorOf,
}: {
  duration: number
  current: number
  annotations: VideoAnnotation[]
  selected: EntityId | null
  onSeek: (t: number) => void
  onPick: (a: VideoAnnotation) => void
  colorOf: (a: VideoAnnotation) => string
}) {
  const pct = (s: number) => (duration ? `${Math.max(0, Math.min(100, (s / duration) * 100))}%` : '0%')
  return (
    <div
      className="vp__timeline"
      role="slider"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(current)}
      onClick={(e) => {
        if (!duration) return
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(((e.clientX - r.left) / r.width) * duration)
      }}
    >
      <div className="vp__track" />
      <div className="vp__progress" style={{ width: pct(current) }} />
      {annotations.map((a, i) => {
        const color = colorOf(a)
        const isSel = selected === a.annotation.id
        return a.time.end != null ? (
          <button
            key={a.annotation.id}
            className={`vp__span ${isSel ? 'is-selected' : ''}`}
            style={{ left: pct(a.time.start), width: `calc(${pct(a.time.end)} - ${pct(a.time.start)})`, background: color }}
            title={`${i + 1} · ${clock(a.time.start)}–${clock(a.time.end)}: ${a.annotation.data.comment ?? ''}`}
            onClick={(e) => (e.stopPropagation(), onPick(a))}
          />
        ) : (
          <button
            key={a.annotation.id}
            className={`vp__marker ${isSel ? 'is-selected' : ''} ${a.time.region ? 'vp__marker--region' : ''}`}
            style={{ left: pct(a.time.start), background: color }}
            title={`${i + 1} · ${clock(a.time.start)}: ${a.annotation.data.comment ?? ''}`}
            onClick={(e) => (e.stopPropagation(), onPick(a))}
          >
            {i + 1}
          </button>
        )
      })}
      <div className="vp__playhead" style={{ left: pct(current) }} />
    </div>
  )
}

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}

import { ChevronRight, ExternalLink, Highlighter, Info, MoreHorizontal, Pause, Play, Plus, Repeat, RotateCcw, RotateCw, Sparkles, StickyNote, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useViewActiveRef } from '../workstation/paneContext'
import { useNavigate } from 'react-router-dom'
import { Popover } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { Inspector } from '../resources/Inspector'
import { TagEditor } from '../resources/TagEditor'
import { clock, embedHeight, isActiveAt, isTimed, otherAnnotationsOf, rangeLabel, retimeAnnotation, timeAnnotationsOf, type AudioAnnotation, type AudioEntity, type TimeRange } from './audio'
import { setAudioPlayback, setAudioPlayerHandle } from './playback'
import { RangeTimeline } from './RangeTimeline'
import { useSpotifyPlayer } from './spotify'
import { httpUrl } from '../../core/resources/types'

type Panel = 'annotations' | 'info' | null
const PANEL_KEY = 'aegraph:audio:panel'
const DEFAULT_COLOR = '#1db954'

interface Props {
  audio: AudioEntity
  onAnnotate: (r: TimeRange) => void
  onAnnotateWhole: () => void
  onMenu: (x: number, y: number) => void
  onDelete: (id: EntityId) => void
  focusTitle: number
  selectId: EntityId | null
  initialTime?: number
}

export function AudioPage({ audio, onAnnotate, onAnnotateWhole, onMenu, onDelete, focusTitle, selectId, initialTime }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const host = useRef<HTMLDivElement>(null)
  const timed = isTimed(audio.data.spotifyType)
  const player = useSpotifyPlayer(host, audio.data.uri, embedHeight(audio.data.spotifyType), initialTime)
  const [panel, setPanelState] = useState<Panel>(() => {
    const v = read(PANEL_KEY)
    return v === 'info' ? 'info' : v === 'none' ? null : 'annotations'
  })
  const [selected, setSelected] = useState<EntityId | null>(null)
  const [inspectId, setInspectId] = useState<EntityId | null>(null)
  const [pending, setPending] = useState<TimeRange | null>(null)
  const [loop, setLoop] = useState(false)
  /** Auto-pause here (range preview). */
  const [stopAt, setStopAt] = useState<number | null>(null)
  const setPanel = (p: Panel) => (setPanelState(p), write(PANEL_KEY, p ?? 'none'))

  const [seenSelectId, setSeenSelectId] = useState(selectId)
  if (selectId !== seenSelectId) {
    setSeenSelectId(selectId)
    if (selectId) {
      // A new annotation was just created from the pending range; it now lives on the timeline.
      setSelected(selectId)
      setPending(null)
      setStopAt(null)
    }
  }

  const annotations = timeAnnotationsOf(store, audio.id)
  const others = otherAnnotationsOf(store, audio.id)
  const inspected = inspectId ? store.get(inspectId) : audio
  const t = player.currentTime
  // Spotify only reports duration once playback starts; until then use a provisional length so the timeline is usable.
  const knownDuration = player.duration || audio.data.duration || 0
  const duration = knownDuration || (timed ? Math.max(240, ...annotations.map((a) => (a.time.end ?? a.time.start) + 30)) : 0)
  const estimated = !knownDuration
  const active = useMemo(() => annotations.filter((a) => isActiveAt(a, t)), [annotations, t])
  const selectedAnn = annotations.find((a) => a.annotation.id === selected)
  const colorOf = (a: AudioAnnotation) => a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) ?? DEFAULT_COLOR

  // Let the assistant know where playback is, and how to seek and play/pause.
  useEffect(() => {
    setAudioPlayback({ audioId: audio.id, currentTime: t, playing: player.playing, duration: knownDuration || undefined })
    return () => setAudioPlayback(null)
  }, [audio.id, t, player.playing, knownDuration])
  useEffect(() => {
    setAudioPlayerHandle({ seek: player.seek, play: player.play, pause: player.pause })
    return () => setAudioPlayerHandle(null)
  }, [player.seek, player.play, player.pause])

  // Remember the duration on the entity once the player reports it.
  useEffect(() => {
    if (player.duration && Math.round(player.duration) !== audio.data.duration) store.update(audio.id, { data: { ...audio.data, duration: Math.round(player.duration) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.duration])

  // Loop the selected range / pending range, and honour a preview stop point.
  useEffect(() => {
    if (!player.playing) return
    const range = loop ? (pending?.end != null ? pending : selectedAnn?.time.end != null ? selectedAnn.time : null) : null
    if (range && range.end != null && t >= range.end) player.seek(range.start)
    else if (stopAt != null && t >= stopAt) {
      player.pause()
      setStopAt(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, player.playing, loop, pending, selectedAnn, stopAt])

  const jumpTo = (a: AudioAnnotation) => {
    setSelected(a.annotation.id)
    player.seek(a.time.start)
  }
  const preview = (r: TimeRange) => {
    player.seek(r.start)
    if (r.end != null) setStopAt(r.end)
    player.play()
  }
  const markIn = () => setPending((p) => ({ start: t, end: p?.end != null && p.end > t ? p.end : undefined }))
  const markOut = () => setPending((p) => (p && p.start < t ? { start: p.start, end: t } : { start: Math.max(0, t - 10), end: t }))

  // Keyboard: space play/pause, I/O in/out, ←/→ seek, L loop, Enter annotate pending, Esc clear.
  const viewActive = useViewActiveRef()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (document.querySelector('.dialog-backdrop')) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          player.toggle()
          break
        case 'i':
        case 'I':
          if (timed) markIn()
          break
        case 'o':
        case 'O':
          if (timed) markOut()
          break
        case 'ArrowLeft':
          e.preventDefault()
          player.seek(t - (e.shiftKey ? 30 : 5))
          break
        case 'ArrowRight':
          e.preventDefault()
          player.seek(t + (e.shiftKey ? 30 : 5))
          break
        case 'l':
        case 'L':
          setLoop((v) => !v)
          break
        case 'Enter':
          if (pending) {
            e.preventDefault()
            onAnnotate(pending)
          }
          break
        case 'Escape':
          setPending(null)
          setSelected(null)
          setStopAt(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, pending, timed, onAnnotate])

  return (
    <div className="dp mp">
      <header className="dp__top">
        <nav className="dp__crumbs" aria-label="Breadcrumb">
          <button className="dp__crumb" onClick={() => navigate('/audio')}>
            Audio
          </button>
          <span className="dp__crumb-wrap">
            <ChevronRight size={13} className="faint" />
            <TitleInput audio={audio} focus={focusTitle} />
          </span>
          <button className="btn btn--sm btn--icon btn--ghost" title="More" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            <MoreHorizontal size={14} />
          </button>
        </nav>
        <div className="dp__top-right">
          <Tags audio={audio} />
          <button className={`btn btn--sm ${panel === 'annotations' ? 'is-on' : ''}`} title="Annotations" onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>
            <Highlighter size={14} />
            {annotations.length + others.length > 0 && <span className="count">{annotations.length + others.length}</span>}
          </button>
          <button className={`btn btn--sm btn--icon ${panel === 'info' ? 'is-on' : ''}`} title="Entity details" onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            <Info size={14} />
          </button>
          <button className="btn btn--sm" title="Open the assistant (⌘J)" onClick={() => window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))}>
            <Sparkles size={14} /> Assistant
          </button>
        </div>
      </header>

      <div className="dp__toolbar">
        <div className="tb" role="toolbar" aria-label="Playback">
          <button className="tb__btn" title={player.playing ? 'Pause (space)' : 'Play (space)'} disabled={!player.ready} onClick={player.toggle}>
            {player.playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button className="tb__btn" title="Back 5s (←)" disabled={!player.ready} onClick={() => player.seek(t - 5)}>
            <RotateCcw size={14} />
          </button>
          <button className="tb__btn" title="Forward 5s (→)" disabled={!player.ready} onClick={() => player.seek(t + 5)}>
            <RotateCw size={14} />
          </button>
          <span className="vp__clock" title={estimated ? 'Duration is provisional until playback starts' : 'Current time / duration'}>
            {clock(t)} <span className="faint">/ {duration ? `${estimated ? '~' : ''}${clock(duration)}` : '–:––'}</span>
          </span>
          {timed && (
            <>
              <span className="tb__sep" />
              <button className="btn btn--sm" onClick={() => (player.pause(), onAnnotate({ start: t }))} title="Annotate this moment">
                <StickyNote size={13} /> Note at {clock(t)}
              </button>
              <button className={`btn btn--sm ${pending && pending.end == null ? 'is-on' : ''}`} onClick={markIn} title="Set the range start at the playhead (I)">
                <span className="mp__io">I</span> In
              </button>
              <button className="btn btn--sm" onClick={markOut} title="Set the range end at the playhead (O)">
                <span className="mp__io">O</span> Out
              </button>
              <button className={`btn btn--sm btn--icon ${loop ? 'is-on' : ''}`} disabled={!(pending?.end != null || selectedAnn?.time.end != null)} onClick={() => setLoop((v) => !v)} title="Loop the range (L)">
                <Repeat size={13} />
              </button>
            </>
          )}
        </div>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {audio.data.artist ? `${audio.data.artist} · ` : ''}
          {!timed ? 'collection — annotate as a whole' : active.length ? `${active.length} annotation${active.length === 1 ? '' : 's'} here` : 'Spotify'}
        </span>
        <span className="dp__edited muted" title={new Date(audio.meta.updatedAt).toLocaleString()}>
          Edited {formatDate(audio.meta.updatedAt)}
        </span>
      </div>

      <div className="dp__body">
        <main className="dp__main mp__main">
          <div className="mp__stage">
            <div className="mp__player-wrap" style={{ minHeight: embedHeight(audio.data.spotifyType) }}>
              <div ref={host} className="mp__player" />
              {player.error && <div className="vp__error">{player.error}</div>}
              {!player.ready && !player.error && <div className="vp__loading muted">Loading Spotify…</div>}
            </div>

            {timed && (
              <>
                <RangeTimeline
                  duration={duration}
                  current={t}
                  annotations={annotations}
                  selected={selected}
                  pending={pending}
                  colorOf={colorOf}
                  onSeek={player.seek}
                  onPick={jumpTo}
                  onPendingChange={setPending}
                  onRetime={(a, r) => retimeAnnotation(store, a, r, knownDuration || undefined)}
                />

                {pending ? (
                  <div className="mp__range">
                    <span className="mp__range-dot" />
                    <strong>{pending.end != null ? 'Range' : 'Moment'}</strong>
                    <span className="vp__chip">{rangeLabel(pending)}</span>
                    {pending.end != null && <span className="muted">{(pending.end - pending.start).toFixed(1)}s</span>}
                    <span className="muted mp__range-hint">{pending.end == null ? 'press O at the end point, or drag the handle' : 'drag the handles or edges to adjust'}</span>
                    <span className="spacer" />
                    <button className="btn btn--sm" onClick={() => preview(pending)} title="Play from the start; stops at the end">
                      <Play size={12} /> Preview
                    </button>
                    <button className="btn btn--sm btn--primary" onClick={() => onAnnotate(pending)} title="Annotate (Enter)">
                      <Highlighter size={12} /> Annotate {pending.end != null ? 'range' : 'moment'}
                    </button>
                    <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setPending(null)} title="Clear (Esc)">
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="mp__hint muted">
                    Press <kbd className="kbd">I</kbd> and <kbd className="kbd">O</kbd> while listening to mark a range, or <kbd className="kbd">space</kbd> to play/pause. Select an annotation to drag its edges.
                  </div>
                )}

                {active.length > 0 && (
                  <div className="vp__now">
                    {active.map((a) => (
                      <button key={a.annotation.id} className={`vp__now-item ${selected === a.annotation.id ? 'is-selected' : ''}`} style={{ borderLeftColor: colorOf(a) }} onClick={() => setSelected(a.annotation.id)}>
                        <span className="vp__chip">{rangeLabel(a.time)}</span>
                        <span className="vp__now-text">{String(a.annotation.data.comment || a.annotation.label || '')}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="vp__meta muted">
              {httpUrl(audio.data.url) && (
                <a href={httpUrl(audio.data.url)} target="_blank" rel="noreferrer noopener">
                  <ExternalLink size={12} /> Open in Spotify
                </a>
              )}
              {audio.data.artist && <span>· {audio.data.artist}</span>}
              <span>· {audio.data.spotifyType}</span>
              {!player.error && player.ready && !player.duration && <span>· press play in the embed to start</span>}
            </div>
          </div>
        </main>

        {panel && (
          <aside className="dp__panel">
            {panel === 'info' && inspected ? (
              <Inspector
                entityId={inspected.id}
                onClose={() => (inspectId ? setInspectId(null) : setPanel(null))}
                onOpen={(id) => {
                  const e = store.get(id)
                  if (e?.type === 'audio') navigate(`/audio/${id}`)
                  else if (e) setInspectId(id)
                }}
                onDelete={(ids) => onDelete(ids[0])}
              />
            ) : (
              <div className="anns">
                <div className="anns__head">
                  <Highlighter size={15} />
                  <h3>Annotations</h3>
                  <span className="count">{annotations.length + others.length}</span>
                  <span className="spacer" />
                  <button className="btn btn--sm btn--ghost" onClick={onAnnotateWhole} title="Annotate the whole item">
                    <Plus size={13} /> Note
                  </button>
                  <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setPanel(null)} title="Close">
                    <X size={14} />
                  </button>
                </div>
                <div className="anns__body">
                  {annotations.length === 0 && others.length === 0 && (
                    <div className="anns__empty muted">
                      {timed ? (
                        <>
                          Play and press <strong>I</strong> then <strong>O</strong> to mark a range, or <strong>Note at …</strong> for a single moment. Each becomes an annotation entity linked with a <code>time</code> selector.
                        </>
                      ) : (
                        <>Albums and playlists don't have one timeline; annotate them as a whole, or add individual tracks.</>
                      )}
                    </div>
                  )}
                  {annotations.map((a, i) => {
                    const color = colorOf(a)
                    const isSel = selected === a.annotation.id
                    const isNow = active.includes(a)
                    return (
                      <div key={a.annotation.id} className={`ann vp__ann ${isSel ? 'is-selected' : ''} ${isNow ? 'is-now' : ''}`} style={{ borderLeftColor: color }} onClick={() => jumpTo(a)}>
                        <div className="vp__ann-row">
                          <span className="ip__ann-num" style={{ background: color }}>
                            {i + 1}
                          </span>
                          <span className="vp__chip" title="Jump here">
                            {rangeLabel(a.time)}
                          </span>
                          {a.time.end != null && <span className="badge">{(a.time.end - a.time.start).toFixed(0)}s</span>}
                          <span className="spacer" />
                          {a.time.end != null && (
                            <button className="btn btn--sm btn--icon btn--ghost" title="Play this range" onClick={(e) => (e.stopPropagation(), setSelected(a.annotation.id), preview(a.time))}>
                              <Play size={12} />
                            </button>
                          )}
                        </div>
                        {a.annotation.data.comment ? <div className="ann__comment">{String(a.annotation.data.comment)}</div> : <div className="faint">No comment</div>}
                        <div className="ann__meta">
                          {a.annotation.tags.map((x) => (
                            <TagChip key={x} tag={x} color={store.getTagInfo(x).color} />
                          ))}
                          <span className="muted" title={new Date(a.annotation.meta.createdAt).toLocaleString()}>
                            {formatDate(a.annotation.meta.createdAt)}
                          </span>
                          <span className="spacer" />
                          <button className="btn btn--sm btn--ghost" onClick={(e) => (e.stopPropagation(), setInspectId(a.annotation.id), setPanel('info'))}>
                            Details
                          </button>
                          <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={(e) => (e.stopPropagation(), onDelete(a.annotation.id))} title="Delete annotation">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {others.length > 0 && <div className="ip__ann-section muted">Whole {audio.data.spotifyType}</div>}
                  {others.map((a) => (
                    <div key={a.annotation.id} className="ann" style={{ borderLeftColor: a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) }}>
                      {a.annotation.data.comment && <div className="ann__comment">{String(a.annotation.data.comment)}</div>}
                      <div className="ann__meta">
                        {a.annotation.tags.map((x) => (
                          <TagChip key={x} tag={x} color={store.getTagInfo(x).color} />
                        ))}
                        <span className="muted">{formatDate(a.annotation.meta.createdAt)}</span>
                        <span className="spacer" />
                        <button className="btn btn--sm btn--ghost" onClick={() => (setInspectId(a.annotation.id), setPanel('info'))}>
                          Details
                        </button>
                        <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={() => onDelete(a.annotation.id)} title="Delete annotation">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function TitleInput({ audio, focus }: { audio: AudioEntity; focus: number }) {
  const store = useEntityStore()
  const [title, setTitle] = useState(audio.label ?? '')
  const [seen, setSeen] = useState(audio.label)
  if (audio.label !== seen) {
    setSeen(audio.label)
    setTitle(audio.label ?? '')
  }
  const commit = () => {
    const next = title.trim()
    if (next && next !== audio.label) store.update(audio.id, { label: next })
    else setTitle(audio.label ?? '')
  }
  return (
    <input
      className="ip__title"
      value={title}
      placeholder="Untitled"
      size={Math.max(8, Math.min(70, title.length + 2))}
      autoFocus={focus > 0}
      onFocus={(e) => focus > 0 && e.currentTarget.select()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTitle(audio.label ?? '')
          e.currentTarget.blur()
        }
      }}
      title="Rename"
    />
  )
}

function Tags({ audio }: { audio: AudioEntity }) {
  const store = useEntityStore()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className="dp__tags" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Edit tags">
        {audio.tags.length === 0 && <span className="faint">Add tags</span>}
        {audio.tags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {audio.tags.length > 4 && <span className="badge">+{audio.tags.length - 4}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300}>
          <TagEditor value={audio.tags} onChange={(tags) => store.update(audio.id, { tags })} onDone={() => setAnchor(null)} />
        </Popover>
      )}
    </>
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

import { ExternalLink, PenLine, Trash2 } from 'lucide-react'
import { useMemo, useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { createAnnotation } from '../../core/resources/annotations'
import { attachStill, type Still } from './capture'
import { VideoPage, type PendingTime } from './VideoPage'
import { VideosIndex } from './VideosIndex'
import { allVideos, annotateVideo, clock, extractStartTime, importYouTube, isVideo, parseClock, youtubeUrl, type VideoEntity } from './videos'
import '../documents/DocumentsView.css'
import '../images/images.css'
import './videos.css'
import { openInItems } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'

/** `/videos` lists YouTube videos; `/videos/:id` plays one and annotates moments. `?t=90` starts at a time. */
export function VideosView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const { id } = useParams()
  const [params] = useSearchParams()

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)
  const [addDialog, setAddDialog] = useState(false)

  // `/videos/new`: the list with the add dialog open.
  useEffect(() => {
    if (id !== 'new') return
    navigate('/videos', { replace: true })
    setAddDialog(true)
  }, [id, navigate])
  const [pendingTime, setPendingTime] = useState<PendingTime | null>(null)
  const [wholeNote, setWholeNote] = useState(false)
  const [selectId, setSelectId] = useState<EntityId | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const videos = useMemo(() => allVideos(store), [store, version])
  const active = id ? store.get(id) : undefined
  const video: VideoEntity | undefined = isVideo(active) ? active : undefined
  const missing = !!id && !video
  const startAt = params.get('t') ? parseClock(params.get('t')!) : undefined

  const confirmDelete = () => {
    if (!pendingDelete) return
    const t = store.get(pendingDelete)
    store.remove(pendingDelete)
    toast(`Deleted ${t ? displayLabel(t) : 'item'}`)
    setPendingDelete(null)
    if (video && video.id === pendingDelete) navigate('/videos')
  }

  const contextItems = (v: VideoEntity): MenuItem[] => [
    { kind: 'item', label: 'Open', onSelect: () => navigate(`/videos/${v.id}`) },
    { kind: 'item', label: 'Rename', icon: PenLine, onSelect: () => (navigate(`/videos/${v.id}`), setFocusTitle((n) => n + 1)) },
    { kind: 'item', label: 'Watch on YouTube', icon: ExternalLink, onSelect: () => window.open(youtubeUrl(v.data.videoId), '_blank', 'noopener') },
    ...openInItems(v, navigate, undefined, { store, open: openTab }),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete', icon: Trash2, danger: true, onSelect: () => setPendingDelete(v.id) },
  ]

  let body
  if (missing) {
    body = (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Video not found</h2>
          <p className="muted">It may have been deleted, or the link is from another Library.</p>
          <button className="btn" onClick={() => navigate('/videos')}>
            Back to videos
          </button>
        </div>
      </div>
    )
  } else if (!video) {
    body = <VideosIndex videos={videos} onAdd={() => setAddDialog(true)} contextItems={contextItems} />
  } else {
    body = (
      <VideoPage
        key={video.id}
        video={video}
        focusTitle={focusTitle}
        selectId={selectId}
        initialTime={startAt}
        onAnnotate={setPendingTime}
        onCaptured={(t, still) => {
          const a = annotateVideo(store, video, { start: t }, '', ['still'])
          attachStill(store, a.id, still)
          setSelectId(a.id)
          toast(`Saved a still at ${clock(t)}`)
        }}
        onAnnotateWhole={() => setWholeNote(true)}
        onMenu={(x, y) => setMenu({ x, y, items: contextItems(video) })}
        onDelete={(aid) => setPendingDelete(aid)}
      />
    )
  }

  return (
    <>
      {body}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {addDialog && (
        <VideoAddDialog
          onClose={() => setAddDialog(false)}
          onSubmit={async (url) => {
            try {
              const { entity, existed, metadata } = await importYouTube(store, url)
              setAddDialog(false)
              toast(existed ? 'Already in the Library' : metadata ? `Added ${displayLabel(entity)}` : 'Added without metadata (oEmbed unavailable)')
              const t = extractStartTime(url)
              navigate(`/videos/${entity.id}${t ? `?t=${t}` : ''}`)
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {video && pendingTime && (
        <VideoTimeDialog
          initial={pendingTime}
          onClose={() => setPendingTime(null)}
          onSubmit={(time, comment, tags) => {
            const a = annotateVideo(store, video, time, comment, tags)
            if (pendingTime.still) attachStill(store, a.id, pendingTime.still)
            setPendingTime(null)
            setSelectId(a.id)
            toast(pendingTime.still ? 'Annotation created with a still' : 'Annotation created')
          }}
        />
      )}

      {video && wholeNote && (
        <VideoTimeDialog
          onClose={() => setWholeNote(false)}
          onSubmit={(_t, comment, tags) => {
            createAnnotation(store, video.id, undefined, { comment, tags, annotationType: 'note', data: { pageUrl: youtubeUrl(video.data.videoId) } })
            setWholeNote(false)
            toast('Annotation created')
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete && store.get(pendingDelete)?.type === 'video' ? 'Delete this video?' : 'Delete this annotation?'}
        message={pendingDelete ? `“${displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity))}” and any relationships attached will be removed. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

export function VideoAddDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!url.trim()) return
    setBusy(true)
    await onSubmit(url)
    setBusy(false)
  }
  return (
    <Dialog
      open
      title="Add a YouTube video"
      description="Any watch, share, shorts, or embed link. Title and channel come from YouTube's public oEmbed endpoint; a ?t= start time is honoured."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>YouTube URL</label>
        <input className="input" autoFocus type="url" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Dialog>
  )
}

export function VideoTimeDialog({ initial, onClose, onSubmit }: { initial?: PendingTime; onClose: () => void; onSubmit: (time: PendingTime, comment: string, tags: string[]) => void }) {
  const [start, setStart] = useState(initial ? clock(initial.start) : '')
  const [end, setEnd] = useState(initial?.end != null ? clock(initial.end) : '')
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const timed = !!initial
  const submit = () => {
    if (!timed) return onSubmit({ start: 0 }, comment, parseTags(tags))
    const s = parseClock(start)
    if (s == null) return setError('Start time should look like 1:23 or 83')
    const e = end.trim() ? parseClock(end) : undefined
    if (end.trim() && e == null) return setError('End time should look like 1:23 or 83')
    if (e != null && e <= s) return setError('End must be after start')
    onSubmit({ start: s, end: e, region: initial?.region }, comment, parseTags(tags))
  }
  return (
    <Dialog
      open
      title={initial?.region ? 'Annotate region at a moment' : timed ? 'Annotate a moment' : 'Annotate video'}
      description={
        initial?.region
          ? 'Stored as an annotation with a time selector plus a region of the frame (fractions of width and height), so it survives the player being resized.'
          : timed
            ? 'Stored as an annotation with a time selector. Add an end time to cover a span.'
            : 'A note about the whole video, linked without a selector.'
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            Create
          </button>
        </>
      }
    >
      {initial?.still && <StillPreview still={initial.still} region={initial.region} />}
      {timed && (
        <div className="vp__time-fields">
          <div className="field">
            <label>Start</label>
            <input className="input mono" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field">
            <label>End (optional)</label>
            <input className="input mono" placeholder="—" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          {initial?.region && (
            <div className="field">
              <label>Region</label>
              <span className="muted" style={{ fontSize: 12, lineHeight: '32px' }}>
                {Math.round(initial.region.width * 100)}×{Math.round(initial.region.height * 100)}% of the frame
              </span>
            </div>
          )}
        </div>
      )}
      <div className="field">
        <label>Comment</label>
        <textarea
          className="input"
          autoFocus
          value={comment}
          placeholder={timed ? 'What happens here?' : 'What do you want to say about this video?'}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="field">
        <label>Tags (comma separated)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="quote, key-point" />
      </div>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  )
}

function StillPreview({ still, region }: { still: Still; region?: PendingTime['region'] }) {
  return (
    <div className="vp__preview vp__preview--dialog">
      <img src={still.dataUrl} alt="" />
      {region && (
        <svg viewBox="0 0 1 1" preserveAspectRatio="none">
          <rect x={region.x} y={region.y} width={region.width} height={region.height} fill="#f59e0b" fillOpacity={0.12} stroke="#f59e0b" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  )
}

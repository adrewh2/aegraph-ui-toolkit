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
import { allAudio, annotateAudio, importSpotify, isAudio, parseClock, rangeLabel, type AudioEntity, type TimeRange } from './audio'
import { AudioIndex } from './AudioIndex'
import { AudioPage } from './AudioPage'
import { RangeEditor } from './RangeEditor'
import '../documents/DocumentsView.css'
import '../images/images.css'
import '../videos/videos.css'
import './audio.css'
import { openInItems } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'
import { httpUrl } from '../../core/resources/types'

/** `/audio` lists Spotify items; `/audio/:id` plays one and annotates moments and ranges. `?t=90` starts at a time. */
export function AudioView() {
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

  // `/audio/new`: the list with the add dialog open.
  useEffect(() => {
    if (id !== 'new') return
    navigate('/audio', { replace: true })
    setAddDialog(true)
  }, [id, navigate])
  const [pendingRange, setPendingRange] = useState<TimeRange | null>(null)
  const [wholeNote, setWholeNote] = useState(false)
  const [selectId, setSelectId] = useState<EntityId | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)
  const [playhead, setPlayhead] = useState<number | undefined>(undefined)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => allAudio(store), [store, version])
  const active = id ? store.get(id) : undefined
  const audio: AudioEntity | undefined = isAudio(active) ? active : undefined
  const missing = !!id && !audio
  const startAt = params.get('t') ? parseClock(params.get('t')!) : undefined

  const confirmDelete = () => {
    if (!pendingDelete) return
    const t = store.get(pendingDelete)
    store.remove(pendingDelete)
    toast(`Deleted ${t ? displayLabel(t) : 'item'}`)
    setPendingDelete(null)
    if (audio && audio.id === pendingDelete) navigate('/audio')
  }

  const contextItems = (m: AudioEntity): MenuItem[] => [
    { kind: 'item', label: 'Open', onSelect: () => navigate(`/audio/${m.id}`) },
    { kind: 'item', label: 'Rename', icon: PenLine, onSelect: () => (navigate(`/audio/${m.id}`), setFocusTitle((n) => n + 1)) },
    ...(httpUrl(m.data.url) ? [{ kind: 'item' as const, label: 'Open in Spotify', icon: ExternalLink, onSelect: () => window.open(httpUrl(m.data.url), '_blank', 'noopener') }] : []),
    ...openInItems(m, navigate, undefined, { store, open: openTab }),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete', icon: Trash2, danger: true, onSelect: () => setPendingDelete(m.id) },
  ]

  let body
  if (missing) {
    body = (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Not found</h2>
          <p className="muted">It may have been deleted, or the link is from another Library.</p>
          <button className="btn" onClick={() => navigate('/audio')}>
            Back to audio
          </button>
        </div>
      </div>
    )
  } else if (!audio) {
    body = <AudioIndex items={items} onAdd={() => setAddDialog(true)} contextItems={contextItems} />
  } else {
    body = (
      <AudioPage
        key={audio.id}
        audio={audio}
        focusTitle={focusTitle}
        selectId={selectId}
        initialTime={startAt}
        onAnnotate={(r) => {
          setPlayhead(r.start)
          setPendingRange(r)
        }}
        onAnnotateWhole={() => setWholeNote(true)}
        onMenu={(x, y) => setMenu({ x, y, items: contextItems(audio) })}
        onDelete={(aid) => setPendingDelete(aid)}
      />
    )
  }

  return (
    <>
      {body}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {addDialog && (
        <AudioAddDialog
          onClose={() => setAddDialog(false)}
          onSubmit={async (url) => {
            try {
              const { entity, existed, metadata } = await importSpotify(store, url)
              setAddDialog(false)
              toast(existed ? 'Already in the Library' : metadata ? `Added ${displayLabel(entity)}` : 'Added without metadata (oEmbed unavailable)')
              navigate(`/audio/${entity.id}`)
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {audio && pendingRange && (
        <RangeDialog
          initial={pendingRange}
          duration={audio.data.duration ?? Math.max(240, (pendingRange.end ?? pendingRange.start) + 30)}
          playhead={playhead}
          onClose={() => setPendingRange(null)}
          onSubmit={(range, comment, tags) => {
            const a = annotateAudio(store, audio, range, comment, tags)
            setPendingRange(null)
            setSelectId(a.id)
            toast(range.end != null ? `Annotated ${rangeLabel(range)}` : 'Annotation created')
          }}
        />
      )}

      {audio && wholeNote && (
        <RangeDialog
          onClose={() => setWholeNote(false)}
          onSubmit={(_r, comment, tags) => {
            createAnnotation(store, audio.id, undefined, { comment, tags, annotationType: 'note', data: { pageUrl: audio.data.url } })
            setWholeNote(false)
            toast('Annotation created')
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete && store.get(pendingDelete)?.type === 'audio' ? 'Delete this item?' : 'Delete this annotation?'}
        message={pendingDelete ? `“${displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity))}” and any relationships attached will be removed. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

export function AudioAddDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string) => Promise<void> }) {
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
      title="Add from Spotify"
      description="A track, album, playlist, or podcast episode — any open.spotify.com link or spotify: URI. Title and artwork come from Spotify's public oEmbed endpoint. Playback uses Spotify's embed; without a logged-in Spotify session it plays 30-second previews."
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
        <label>Spotify link</label>
        <input className="input" autoFocus placeholder="https://open.spotify.com/track/…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Dialog>
  )
}

function RangeDialog({ initial, duration = 0, playhead, onClose, onSubmit }: { initial?: TimeRange; duration?: number; playhead?: number; onClose: () => void; onSubmit: (range: TimeRange, comment: string, tags: string[]) => void }) {
  const [range, setRange] = useState<TimeRange>(initial ?? { start: 0 })
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const timed = !!initial
  const submit = () => onSubmit(timed ? range : { start: 0 }, comment, parseTags(tags))
  return (
    <Dialog
      open
      title={!timed ? 'Annotate the whole item' : range.end != null ? `Annotate ${rangeLabel(range)}` : `Annotate ${rangeLabel(range)}`}
      description={timed ? 'Stored as an annotation with a time selector — a moment, or a start–end range. Adjust the range here or drag it on the timeline later.' : 'A note about the whole item, linked without a selector.'}
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
      {timed && <RangeEditor value={range} duration={duration} playhead={playhead} onChange={setRange} />}
      <div className="field">
        <label>Comment</label>
        <textarea
          className="input"
          autoFocus
          value={comment}
          placeholder={timed ? 'What happens here?' : 'What do you want to say about this?'}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="field">
        <label>Tags (comma separated)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="chorus, sample, lyric" />
      </div>
    </Dialog>
  )
}

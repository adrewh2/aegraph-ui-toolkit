import { ChevronRight, Highlighter, Info, MoreHorizontal, Plus, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityStore } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { Inspector } from '../resources/Inspector'
import { TagEditor } from '../resources/TagEditor'
import type { Still } from './capture'
import { StillPreviewDialog, useVideoWorkbench, VideoAnnotationList, VideoMeta, VideoStage, VideoToolbar, type PendingTime } from './VideoWorkbench'
import type { VideoEntity } from './videos'

export type { PendingTime } from './VideoWorkbench'

type Panel = 'annotations' | 'info' | null
const PANEL_KEY = 'aegraph:videos:panel'

interface Props {
  video: VideoEntity
  onAnnotate: (t: PendingTime) => void
  /** A frame captured without a comment. */
  onCaptured: (t: number, still: Still) => void
  onAnnotateWhole: () => void
  onMenu: (x: number, y: number) => void
  onDelete: (id: EntityId) => void
  focusTitle: number
  selectId: EntityId | null
  initialTime?: number
}

export function VideoPage({ video, onAnnotate, onCaptured, onAnnotateWhole, onMenu, onDelete, focusTitle, selectId, initialTime }: Props) {
  const store = useEntityStore()
  const navigate = useNavigate()
  const wb = useVideoWorkbench(video, { onAnnotate, onCaptured, initialTime, selectId })
  const { timed, others, active, drawing } = wb
  const [panel, setPanelState] = useState<Panel>(() => {
    const v = read(PANEL_KEY)
    return v === 'info' ? 'info' : v === 'none' ? null : 'annotations'
  })
  const [inspectId, setInspectId] = useState<EntityId | null>(null)
  const setPanel = (p: Panel) => (setPanelState(p), write(PANEL_KEY, p ?? 'none'))
  const inspected = inspectId ? store.get(inspectId) : video

  return (
    <div className="dp vp">
      <header className="dp__top">
        <nav className="dp__crumbs" aria-label="Breadcrumb">
          <button className="dp__crumb" onClick={() => navigate('/videos')}>
            Videos
          </button>
          <span className="dp__crumb-wrap">
            <ChevronRight size={13} className="faint" />
            <TitleInput video={video} focus={focusTitle} />
          </span>
          <button className="btn btn--sm btn--icon btn--ghost" title="More" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            <MoreHorizontal size={14} />
          </button>
        </nav>
        <div className="dp__top-right">
          <Tags video={video} />
          <button className={`btn btn--sm ${panel === 'annotations' ? 'is-on' : ''}`} title="Annotations" onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>
            <Highlighter size={14} />
            {timed.length + others.length > 0 && <span className="count">{timed.length + others.length}</span>}
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
        <VideoToolbar wb={wb} />
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {video.data.channel ? `${video.data.channel} · ` : ''}
          {drawing ? 'drag on the video to mark a region' : active.length ? `${active.length} annotation${active.length === 1 ? '' : 's'} at this moment` : 'YouTube'}
        </span>
        <span className="dp__edited muted" title={new Date(video.meta.updatedAt).toLocaleString()}>
          Edited {formatDate(video.meta.updatedAt)}
        </span>
      </div>

      <div className="dp__body">
        <main className="dp__main vp__main">
          <div className="vp__stage">
            <VideoStage wb={wb} />
            <VideoMeta video={video} />
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
                  if (e?.type === 'video') navigate(`/videos/${id}`)
                  else if (e) setInspectId(id)
                }}
                onDelete={(ids) => onDelete(ids[0])}
              />
            ) : (
              <div className="anns">
                <div className="anns__head">
                  <Highlighter size={15} />
                  <h3>Annotations</h3>
                  <span className="count">{timed.length + others.length}</span>
                  <span className="spacer" />
                  <button className="btn btn--sm btn--ghost" onClick={onAnnotateWhole} title="Annotate the whole video">
                    <Plus size={13} /> Note
                  </button>
                  <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setPanel(null)} title="Close">
                    <X size={14} />
                  </button>
                </div>
                <VideoAnnotationList wb={wb} onInspect={(id) => (setInspectId(id), setPanel('info'))} onDelete={onDelete} />
              </div>
            )}
          </aside>
        )}
      </div>

      <StillPreviewDialog wb={wb} />
    </div>
  )
}

function TitleInput({ video, focus }: { video: VideoEntity; focus: number }) {
  const store = useEntityStore()
  const [title, setTitle] = useState(video.label ?? '')
  const [seen, setSeen] = useState(video.label)
  if (video.label !== seen) {
    setSeen(video.label)
    setTitle(video.label ?? '')
  }
  const commit = () => {
    const next = title.trim()
    if (next && next !== video.label) store.update(video.id, { label: next })
    else setTitle(video.label ?? '')
  }
  return (
    <input
      className="ip__title"
      value={title}
      placeholder="Untitled video"
      size={Math.max(8, Math.min(70, title.length + 2))}
      autoFocus={focus > 0}
      onFocus={(e) => focus > 0 && e.currentTarget.select()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTitle(video.label ?? '')
          e.currentTarget.blur()
        }
      }}
      title="Rename"
    />
  )
}

function Tags({ video }: { video: VideoEntity }) {
  const store = useEntityStore()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className="dp__tags" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Edit tags">
        {video.tags.length === 0 && <span className="faint">Add tags</span>}
        {video.tags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {video.tags.length > 4 && <span className="badge">+{video.tags.length - 4}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300}>
          <TagEditor value={video.tags} onChange={(tags) => store.update(video.id, { tags })} onDone={() => setAnchor(null)} />
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

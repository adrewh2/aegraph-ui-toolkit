import { Highlighter, Plus } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { createAnnotation } from '../../core/resources/annotations'
import { attachStill } from './capture'
import { StillPreviewDialog, useVideoWorkbench, VideoAnnotationList, VideoMeta, VideoStage, VideoToolbar, type PendingTime } from './VideoWorkbench'
import { annotateVideo, clock, youtubeUrl, type VideoEntity } from './videos'
import { VideoTimeDialog } from './VideosView'
// The workbench's toolbar and annotation cards are styled by the pages' shared sheets.
import '../documents/DocumentsView.css'
import '../images/images.css'
import './videos.css'

/**
 * The video page's workbench in the inspector: player, timeline, notes at a
 * moment, boxes on the frame, frame stills, and the annotation list — with
 * the same dialogs and persistence as the page.
 */
export default function VideoEmbed({ video, onOpen }: { video: VideoEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const [pendingTime, setPendingTime] = useState<PendingTime | null>(null)
  const [wholeNote, setWholeNote] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)
  const [selectId, setSelectId] = useState<EntityId | null>(null)

  const wb = useVideoWorkbench(video, {
    onAnnotate: setPendingTime,
    onCaptured: (t, still) => {
      const a = annotateVideo(store, video, { start: t }, '', ['still'])
      attachStill(store, a.id, still)
      setSelectId(a.id)
      toast(`Saved a still at ${clock(t)}`)
    },
    selectId,
  })
  const { timed, others, active, drawing } = wb

  return (
    <div className="ve ve--full">
      <div className="ve__toolbar">
        <VideoToolbar wb={wb} compact />
        <span className="muted ve__status">{drawing ? 'drag on the video to mark a region' : active.length ? `${active.length} at this moment` : ''}</span>
      </div>
      <div className="ve__stage">
        <VideoStage wb={wb} />
        <VideoMeta video={video} />
      </div>
      <div className="ve__anns">
        <div className="anns__head">
          <Highlighter size={15} />
          <h3>Annotations</h3>
          <span className="count">{timed.length + others.length}</span>
          <span className="spacer" />
          <button className="btn btn--sm btn--ghost" onClick={() => setWholeNote(true)} title="Annotate the whole video">
            <Plus size={13} /> Note
          </button>
        </div>
        <VideoAnnotationList wb={wb} onInspect={onOpen} onDelete={(id) => setPendingDelete(id)} />
      </div>

      <StillPreviewDialog wb={wb} />

      {pendingTime && (
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
      {wholeNote && (
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
        title="Delete this annotation?"
        message={pendingDelete ? `“${displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity))}” will be removed. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) store.remove(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

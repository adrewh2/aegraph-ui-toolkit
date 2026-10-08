import { ArrowUpRight, Clock, Highlighter, MapPin, StickyNote, TextQuote } from 'lucide-react'
import { DataImage } from '../../components/RemoteImage'
import { useNavigate } from 'react-router-dom'
import { entityHref } from '../../app/routes'
import { TagChip } from '../../components/ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { clock } from '../../core/entity/ids'
import { isRelationship, type AnyEntity, type Entity, type EntityId, type Selector } from '../../core/entity/types'
import { annotationsOf } from '../../core/resources/annotations'
import { RELATIONSHIP_TYPES, RESOURCE_TYPES, type AnnotationData } from '../../core/resources/types'
import { formatDate } from '../../lib/format'
import { Crop } from '../images/Crop'
import { isImage } from '../images/images'
import { stillOf } from '../videos/capture'
import { isVideo, thumbnailUrl } from '../videos/videos'
import './AnnotationsTab.css'

/**
 * The inspector's Annotations tab. For a resource: everything annotating it,
 * each row drawn for its selector — the cropped region of an image, a still
 * or thumbnail with the time span for video/audio, the quoted passage for
 * text, a plain note otherwise. For an annotation: the same row, for what it
 * annotates. Rows open the target where the annotation lives.
 */
export function AnnotationsTab({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  if (!isRelationship(entity) && entity.type === RESOURCE_TYPES.annotation) {
    const rels = store.relationshipsOf(entity.id, 'out').filter((r) => r.type === RELATIONSHIP_TYPES.annotates)
    if (!rels.length) return <div className="insp__empty">This annotation isn't attached to anything.</div>
    return (
      <div className="antab">
        <div className="antab__head">Annotates</div>
        {rels.map((r) => {
          const target = store.get(r.target.id)
          return target ? <AnnotationRow key={r.id} annotation={entity as Entity<AnnotationData>} target={target} selector={r.target.selector} showTarget onInspect={onOpen} /> : null
        })}
      </div>
    )
  }
  const anns = annotationsOf(store, entity.id)
  if (!anns.length) return <div className="insp__empty">No annotations yet. Right-click the row and choose Annotate…</div>
  return (
    <div className="antab">
      {anns.map((a) => (
        <AnnotationRow key={a.relationshipId} annotation={a.annotation} target={entity} selector={a.selector} onInspect={onOpen} />
      ))}
    </div>
  )
}

function AnnotationRow({ annotation, target, selector, showTarget, onInspect }: { annotation: Entity<AnnotationData>; target: AnyEntity; selector?: Selector; showTarget?: boolean; onInspect: (id: EntityId) => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const comment = annotation.data.comment?.trim()
  const still = stillOf(annotation)
  const open = () => navigate(entityHref(target, registry))

  // Visual + primary line, by selector kind.
  let visual: React.ReactNode
  let primary: React.ReactNode
  if (selector?.kind === 'region' && isImage(target)) {
    visual = <Crop image={target} box={selector} size={44} />
    primary = (
      <span className="antab__where">
        Region {Math.round(selector.width)}×{Math.round(selector.height)} at {Math.round(selector.x)},{Math.round(selector.y)}
      </span>
    )
  } else if (selector?.kind === 'region' && still) {
    // Region on a captured still (webpages): the still is the reference frame, region in its pixels.
    visual = (
      <span className="antab__thumb">
        <DataImage src={still.dataUrl} compact alt="" />
        <span className="antab__frame" style={{ left: `${(selector.x / still.width) * 100}%`, top: `${(selector.y / still.height) * 100}%`, width: `${(selector.width / still.width) * 100}%`, height: `${(selector.height / still.height) * 100}%` }} />
      </span>
    )
    primary = (
      <span className="antab__where">
        Region {Math.round(selector.width)}×{Math.round(selector.height)} of a {still.width}×{still.height} capture
      </span>
    )
  } else if (selector?.kind === 'geo') {
    visual = (
      <span className="antab__glyph">
        <MapPin size={15} />
      </span>
    )
    primary = (
      <span className="antab__where">
        {selector.lat.toFixed(4)}, {selector.lng.toFixed(4)}
        {selector.radius ? ` ±${selector.radius} m` : ''}
        {selector.at ? ` · ${new Date(selector.at).toLocaleString()}${selector.until ? ` – ${new Date(selector.until).toLocaleString()}` : ''}` : ''}
      </span>
    )
  } else if (selector?.kind === 'time') {
    const span = `${clock(selector.start)}${selector.end != null ? ` – ${clock(selector.end)}` : ''}`
    if (still) {
      visual = (
        <span className="antab__thumb">
          <DataImage src={still.dataUrl} compact alt="" />
          {selector.region && <span className="antab__frame" style={{ left: `${selector.region.x * 100}%`, top: `${selector.region.y * 100}%`, width: `${selector.region.width * 100}%`, height: `${selector.region.height * 100}%` }} />}
        </span>
      )
    } else if (isVideo(target)) {
      visual = (
        <span className="antab__thumb">
          <DataImage src={target.data.thumbnailUrl || thumbnailUrl(target.data.videoId)} providers compact alt="" />
          {selector.region && <span className="antab__frame" style={{ left: `${selector.region.x * 100}%`, top: `${selector.region.y * 100}%`, width: `${selector.region.width * 100}%`, height: `${selector.region.height * 100}%` }} />}
        </span>
      )
    } else visual = <span className="antab__glyph"><Clock size={15} /></span>
    primary = (
      <span className="antab__where">
        <Clock size={11} /> {span}
        {selector.region ? ' · region' : ''}
      </span>
    )
  } else if (selector?.kind === 'text' || annotation.data.selectedText) {
    const exact = selector?.kind === 'text' ? selector.exact : annotation.data.selectedText!
    visual = <span className="antab__glyph antab__glyph--quote"><TextQuote size={15} /></span>
    primary = <span className="antab__quote">“{exact.length > 140 ? exact.slice(0, 140) + '…' : exact}”</span>
  } else {
    visual = still ? (
      <span className="antab__thumb">
        <DataImage src={still.dataUrl} compact alt="" />
      </span>
    ) : (
      <span className="antab__glyph"><StickyNote size={15} /></span>
    )
    primary = <span className="antab__where muted">{still ? `Capture · ${still.width}×${still.height}` : `Whole ${registry.get(target.type).label.toLowerCase()}`}</span>
  }

  return (
    <div className="antab__row" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()} title={`Open ${displayLabel(target)}`}>
      {visual}
      <div className="antab__main">
        {showTarget && (
          <div className="antab__target">
            <span className="badge">{registry.get(target.type).label}</span> {displayLabel(target)}
          </div>
        )}
        {primary}
        {comment && <div className="antab__comment">{comment}</div>}
        <div className="antab__meta">
          <span className="antab__tags">
            {annotation.tags.slice(0, 3).map((t) => (
              <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
            ))}
          </span>
          <span className="faint">{formatDate(annotation.meta.updatedAt)}</span>
          <button
            className="antab__inspect"
            title="Inspect the annotation entity"
            onClick={(e) => {
              e.stopPropagation()
              onInspect(annotation.id)
            }}
          >
            <Highlighter size={11} /> details
          </button>
          <ArrowUpRight size={12} className="antab__go" />
        </div>
      </div>
    </div>
  )
}

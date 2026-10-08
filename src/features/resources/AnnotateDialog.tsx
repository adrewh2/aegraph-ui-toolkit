import { Clock, Highlighter, Image as ImageIcon, StickyNote, TextQuote, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { EntityPicker } from '../../components/ui/EntityPicker'
import { createEntity, displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { clock } from '../../core/entity/ids'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { createAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type AnnotationData } from '../../core/resources/types'
import { annotateAudio, isAudio, type TimeRange } from '../audio/audio'
import { AudioPicker } from '../audio/AudioPicker'
import { annotateDocument, contentOf, extOf, isDocument, isFolder, isPdf, quoteContext } from '../documents/documents'
import { RichReader } from '../documents/editor/RichReader'
import { ImageAnnotator } from '../images/ImageAnnotator'
import { annotateImage, isImage, regionAnnotationsOf, type Box } from '../images/images'
import { annotateVideo, isVideo } from '../videos/videos'
import { VideoPicker, type VideoPick } from '../videos/VideoPicker'
import './AnnotateDialog.css'
import { featureOn } from '../../app/features'

/**
 * New annotation, from anywhere. Pick the target, and the dialog turns into
 * the right tool for it: select a passage of a document, draw a box on an
 * image, mark a time range of a video or audio track, quote a webpage, or
 * just leave a note on anything else. One fixed-size stage, so switching
 * targets never resizes the dialog.
 */

type Quote = { exact: string; prefix?: string; suffix?: string }
type Kind = 'document' | 'pdf' | 'image' | 'video' | 'audio' | 'webpage' | 'note' | 'none'

const kindOf = (e: AnyEntity | undefined): Kind => {
  if (!e) return 'none'
  if (isDocument(e)) return isFolder(e) ? 'note' : isPdf(e) ? 'pdf' : 'document'
  if (isImage(e)) return 'image'
  // With the player's feature turned off (`app/features.ts`) there is no moment to mark: a note on the whole thing.
  if (isVideo(e)) return featureOn('videos') ? 'video' : 'note'
  if (isAudio(e)) return featureOn('audio') ? 'audio' : 'note'
  if (e.type === RESOURCE_TYPES.webpage) return 'webpage'
  return 'note'
}

export function AnnotateDialog({ targetId, onClose, onCreated }: { targetId?: EntityId; onClose: () => void; onCreated: (ann: AnyEntity) => void }) {
  const store = useEntityStore()
  const [target, setTarget] = useState<EntityId | undefined>(targetId)
  const [comment, setComment] = useState('')
  const [label, setLabel] = useState('')
  const [tags, setTags] = useState('')
  // Per-kind selection, tied to the target it was made on: a new target starts with a fresh selection.
  type Sel = { target?: EntityId; quote: Quote | null; box: Box | null; range: TimeRange | null; pick: VideoPick | null; whole: boolean }
  const fresh = (t?: EntityId): Sel => ({ target: t, quote: null, box: null, range: null, pick: null, whole: false })
  const [sel, setSel] = useState<Sel>(() => fresh(targetId))
  if (sel.target !== target) setSel(fresh(target))
  const { quote, box, range, pick, whole } = sel
  const setQuote = (quote: Quote | null) => setSel((s) => ({ ...s, quote }))
  const setBox = (box: Box | null) => setSel((s) => ({ ...s, box }))
  const setRange = (range: TimeRange | null) => setSel((s) => ({ ...s, range }))
  const setPick = (pick: VideoPick | null) => setSel((s) => ({ ...s, pick }))
  const setWhole = (whole: boolean) => setSel((s) => ({ ...s, whole }))
  const commentRef = useRef<HTMLTextAreaElement>(null)

  const entity = target ? store.get(target) : undefined
  const kind = kindOf(entity)

  const hasSelection = kind === 'document' || kind === 'webpage' ? !!quote : kind === 'image' ? !!box : kind === 'video' ? !!pick : kind === 'audio' ? !!range : false
  const canSubmit = !!comment.trim() || hasSelection
  const parsedTags = () => parseTags(tags)

  const submit = () => {
    if (!canSubmit) return
    const text = comment.trim()
    const lbl = label.trim() || undefined
    let ann: AnyEntity
    if (!entity) {
      ann = createEntity<AnnotationData>({ type: RESOURCE_TYPES.annotation, label: lbl ?? (text.slice(0, 60) || 'Annotation'), tags: parsedTags(), data: { annotationType: 'note', comment: text }, meta: { source: 'user' } })
      store.upsert(ann)
    } else if (kind === 'document' && isDocument(entity) && quote && !whole) {
      ann = annotateDocument(store, entity, quote, text, parsedTags())
    } else if (kind === 'image' && isImage(entity) && box && !whole) {
      ann = annotateImage(store, entity, box, text, parsedTags())
    } else if (kind === 'video' && isVideo(entity) && pick && !whole) {
      ann = annotateVideo(store, entity, pick, text, parsedTags())
    } else if (kind === 'audio' && isAudio(entity) && range && !whole) {
      ann = annotateAudio(store, entity, range, text, parsedTags())
    } else if (kind === 'webpage' && quote && !whole) {
      ann = createAnnotation(store, entity.id, { kind: 'text', exact: quote.exact }, { comment: text, tags: parsedTags(), label: lbl, annotationType: 'text', data: { selectedText: quote.exact, pageUrl: typeof entity.data.url === 'string' ? entity.data.url : undefined } })
    } else {
      ann = createAnnotation(store, entity.id, undefined, { comment: text, tags: parsedTags(), label: lbl, annotationType: 'note', data: { pageUrl: typeof entity.data.url === 'string' ? entity.data.url : undefined } })
    }
    if (lbl && ann.label !== lbl) ann = store.update(ann.id, { label: lbl })
    onCreated(ann)
  }

  const stageTitle =
    kind === 'document' ? 'Select the passage this is about' : kind === 'image' ? 'Draw a box on the image' : kind === 'video' ? 'Mark a moment or a span' : kind === 'audio' ? 'Mark a moment or a range' : kind === 'webpage' ? 'Quote the passage (optional)' : kind === 'pdf' ? 'PDF' : kind === 'note' ? 'Note' : 'No target'

  return (
    <Dialog
      open
      wide
      title="New annotation"
      description="Layer a comment onto something. The link is stored as an “annotates” relationship; where you point at a part of the target, that part is stored as a selector."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Target</label>
        <EntityPicker value={target} onChange={setTarget} placeholder="Choose what to annotate…" autoFocus={!target} />
      </div>

      <div className={`and__stage and__stage--${kind}`}>
        <div className="and__stage-head">
          <span className="and__stage-title">
            {kind === 'document' || kind === 'webpage' ? <TextQuote size={13} /> : kind === 'image' ? <ImageIcon size={13} /> : kind === 'video' || kind === 'audio' ? <Clock size={13} /> : <StickyNote size={13} />}
            {stageTitle}
          </span>
          {hasSelection && !whole && (
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setQuote(null)
                setBox(null)
                setRange(null)
                setPick(null)
              }}
            >
              <X size={12} /> Clear
            </button>
          )}
          {(kind === 'document' || kind === 'image' || kind === 'video' || kind === 'audio') && (
            <label className="and__whole" title="Annotate the whole thing instead of a part">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> whole {kind === 'document' ? 'document' : kind}
            </label>
          )}
        </div>
        <div className="and__stage-body">
          {kind === 'none' && <p className="muted and__hint">Pick a target above. The dialog adapts to what you choose: select text in a document, draw on an image, mark time in a video or audio track.</p>}
          {kind === 'note' && entity && (
            <p className="muted and__hint">
              A note on <strong>{displayLabel(entity)}</strong> ({entity.type}). Nothing to point at inside it — the comment applies to the whole entity.
            </p>
          )}
          {kind === 'pdf' && <p className="muted and__hint">PDF text isn't selectable here yet; the note applies to the whole document. Open it in Documents to annotate a page.</p>}
          {kind === 'document' && isDocument(entity) && extOf(entity) === 'md' && (
            <div className={`and__reader ${whole ? 'is-disabled' : ''}`}>
              <RichReader key={entity.id} doc={entity} onSelect={setQuote} />
              <QuotePreview quote={quote} disabled={whole} empty={contentOf(entity) ? 'Select text in the document to quote it.' : 'This document has no text yet.'} />
            </div>
          )}
          {kind === 'document' && isDocument(entity) && extOf(entity) !== 'md' && <PassagePicker text={contentOf(entity)} value={quote} disabled={whole} onChange={setQuote} />}
          {kind === 'webpage' && (
            <textarea
              className="input and__quote"
              placeholder="Paste the sentence or paragraph this annotation is about…"
              value={quote?.exact ?? ''}
              disabled={whole}
              onChange={(e) => setQuote(e.target.value.trim() ? { exact: e.target.value } : null)}
            />
          )}
          {kind === 'image' && isImage(entity) && <ImageStage image={entity} box={box} disabled={whole} onBox={setBox} store={store} />}
          {kind === 'video' && isVideo(entity) && (
            <>
              <VideoPicker key={entity.id} video={entity} value={pick} disabled={whole} onChange={setPick} />
              <div className="and__quote-preview">
                {whole ? <span className="muted">Annotating the whole video.</span> : pick ? <span><Clock size={11} /> {clock(pick.start)}{pick.end != null ? ` – ${clock(pick.end)}` : ''}{pick.region ? ` · region ${Math.round(pick.region.width * 100)}×${Math.round(pick.region.height * 100)}% of the frame` : ''}</span> : <span className="muted">Play to the moment, then Note at / In–Out / Draw box.</span>}
              </div>
            </>
          )}
          {kind === 'audio' && isAudio(entity) && (
            <>
              <AudioPicker key={entity.id} audio={entity} value={range} disabled={whole} onChange={setRange} />
              <div className="and__quote-preview">
                {whole ? <span className="muted">Annotating the whole track.</span> : range ? <span><Clock size={11} /> {clock(range.start)}{range.end != null ? ` – ${clock(range.end)}` : ''}</span> : <span className="muted">Play to the moment, then Note at or In–Out.</span>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="field">
        <label>Comment</label>
        <textarea
          ref={commentRef}
          className="input and__comment"
          value={comment}
          placeholder={hasSelection ? 'What do you want to say about it?' : 'Your note…'}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="and__row">
        <div className="field">
          <label>Label (optional)</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Defaults to the comment or the quote" />
        </div>
        <div className="field">
          <label>Tags</label>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="research, todo" />
        </div>
      </div>
    </Dialog>
  )
}

// ── Stages ─────────────────────────────────────────────────────────────

/** The document's text, read-only; select a run of it to quote (prefix/suffix are taken from the surrounding text so the quote can re-anchor later). */
function PassagePicker({ text, value, disabled, onChange }: { text: string; value: Quote | null; disabled: boolean; onChange: (q: Quote | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const read = () => {
    const el = ref.current
    if (!el || disabled) return
    const [s, e] = [el.selectionStart, el.selectionEnd]
    if (e - s < 1 || !text.slice(s, e).trim()) return
    onChange(quoteContext(text, s, e))
  }
  return (
    <div className="and__passage">
      <textarea ref={ref} className="and__text" readOnly value={text} disabled={disabled} onMouseUp={read} onKeyUp={read} onSelect={read} spellCheck={false} />
      <div className="and__quote-preview">
        {value ? (
          <>
            <Highlighter size={12} /> <span className="and__quote-text">“{value.exact.length > 160 ? value.exact.slice(0, 160) + '…' : value.exact}”</span>
          </>
        ) : (
          <span className="muted">{disabled ? 'Annotating the whole document.' : text ? 'Drag over the text to quote a passage.' : 'This document has no text yet.'}</span>
        )}
      </div>
    </div>
  )
}

function ImageStage({ image, box, disabled, onBox, store }: { image: Parameters<typeof annotateImage>[1]; box: Box | null; disabled: boolean; onBox: (b: Box | null) => void; store: ReturnType<typeof useEntityStore> }) {
  const existing = useMemo(() => regionAnnotationsOf(store, image.id), [store, image.id])
  return (
    <div className={`and__image ${disabled ? 'is-disabled' : ''}`}>
      <ImageAnnotator image={image} annotations={existing} tool={disabled ? 'select' : 'draw'} zoom="fit" selectedId={null} onSelect={() => {}} onDraw={(b) => onBox(b)} onChange={() => {}} onDelete={() => {}} />
      <div className="and__quote-preview">
        {box ? (
          <span>
            Region {Math.round(box.width)}×{Math.round(box.height)} at {Math.round(box.x)},{Math.round(box.y)}
          </span>
        ) : (
          <span className="muted">{disabled ? 'Annotating the whole image.' : 'Drag on the image to draw a box.'}</span>
        )}
      </div>
    </div>
  )
}

function QuotePreview({ quote, disabled, empty }: { quote: Quote | null; disabled: boolean; empty: string }) {
  return (
    <div className="and__quote-preview">
      {disabled ? (
        <span className="muted">Annotating the whole document.</span>
      ) : quote ? (
        <>
          <Highlighter size={12} /> <span className="and__quote-text">“{quote.exact.length > 160 ? quote.exact.slice(0, 160) + '…' : quote.exact}”</span>
        </>
      ) : (
        <span className="muted">{empty}</span>
      )}
    </div>
  )
}

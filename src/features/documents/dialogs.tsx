import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { ancestorsOf, compareDocs, descendantsOf, isFolder, parentOf, type DocumentEntity } from './documents'
import type { PendingQuote } from './editor/types'
import { Select } from '../../components/ui/Select'

export function AnnotateDialog({ quote, onClose, onSubmit }: { quote: PendingQuote; onClose: () => void; onSubmit: (comment: string, tags: string[]) => void }) {
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const submit = () => onSubmit(comment, parseTags(tags))
  return (
    <Dialog
      open
      title="Annotate selection"
      description="Stored as an annotation entity linked to this document with a text-quote selector, so it survives edits around it."
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
      <blockquote className="annd__quote">{quote.exact.length > 400 ? quote.exact.slice(0, 400) + '…' : quote.exact}</blockquote>
      <div className="field">
        <label>Comment</label>
        <textarea
          className="input"
          autoFocus
          value={comment}
          placeholder="What do you want to say about this passage?"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="field">
        <label>Tags (comma separated)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="claim, todo" />
      </div>
    </Dialog>
  )
}

export function MoveDialog({ id, docs, onClose, onMove }: { id: EntityId; docs: DocumentEntity[]; onClose: () => void; onMove: (parent: EntityId | undefined) => void }) {
  const store = useEntityStore()
  const target = store.get(id)
  const blocked = new Set<EntityId>([id, ...descendantsOf(store, id).map((d) => d.id)])
  const folders = docs.filter((d) => isFolder(d) && !blocked.has(d.id)).sort(compareDocs)
  const current = target ? parentOf(target) : undefined
  const [choice, setChoice] = useState<EntityId | ''>(current ?? '')
  const path = (f: DocumentEntity) =>
    [...ancestorsOf(store, f.id).reverse().map((a) => displayLabel(store.get(a) ?? ({ id: a } as AnyEntity))), displayLabel(f)].join(' / ')
  return (
    <Dialog
      open
      title={`Move “${target ? displayLabel(target) : id}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => onMove(choice || undefined)}>
            Move
          </button>
        </>
      }
    >
      <div className="field">
        <label>Destination folder</label>
        <Select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">(top level)</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {path(f)}
            </option>
          ))}
        </Select>
      </div>
      {folders.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No other folders yet — create one with New folder.</div>}
    </Dialog>
  )
}

import { Highlighter, Trash2, X } from 'lucide-react'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { annotationsOf, type DocumentEntity } from './documents'

export function AnnotationsPanel({
  doc,
  onClose,
  onReveal,
  onInspect,
  onDelete,
}: {
  doc: DocumentEntity
  onClose: () => void
  onReveal: (id: EntityId) => void
  onInspect: (id: EntityId) => void
  onDelete: (id: EntityId) => void
}) {
  const store = useEntityStore()
  useStoreVersion(store)
  const items = annotationsOf(store, doc.id)
  return (
    <div className="anns">
      <div className="anns__head">
        <Highlighter size={15} />
        <h3>Annotations</h3>
        <span className="count">{items.length}</span>
        <span className="spacer" />
        <button className="btn btn--sm btn--icon btn--ghost" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="anns__body">
        {items.length === 0 ? (
          <div className="anns__empty muted">
            Select some text and choose <strong>Annotate</strong> to add the first one. Annotations are entities linked to this document by an <code>annotates</code> relationship with a text-quote selector.
          </div>
        ) : (
          items.map(({ annotation: a, exact }) => {
            const color = a.tags.map((t) => store.getTagInfo(t).color).find(Boolean)
            return (
              <div key={a.id} className="ann" style={color ? { borderLeftColor: color } : undefined}>
                {exact && (
                  <button className="ann__quote" onClick={() => onReveal(a.id)} title="Show in document">
                    “{exact.length > 180 ? exact.slice(0, 180) + '…' : exact}”
                  </button>
                )}
                {a.data.comment && <div className="ann__comment">{String(a.data.comment)}</div>}
                <div className="ann__meta">
                  {a.tags.map((t) => (
                    <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
                  ))}
                  <span className="muted" title={new Date(a.meta.createdAt).toLocaleString()}>
                    {formatDate(a.meta.createdAt)}
                  </span>
                  <span className="spacer" />
                  <button className="btn btn--sm btn--ghost" onClick={() => onInspect(a.id)}>
                    Details
                  </button>
                  <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={() => onDelete(a.id)} title="Delete annotation">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

import { FileText, Folder } from 'lucide-react'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { allDocuments, compareDocs, isFolder, parentOf, type DocumentEntity } from './documents'

/** A folder's direct contents, as on the Documents page. */
export function FolderEmbed({ folder, onOpen }: { folder: DocumentEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const children = allDocuments(store)
    .filter((d) => parentOf(d) === folder.id)
    .sort(compareDocs)
  if (!children.length) return <div className="insp__empty">This folder is empty.</div>
  return (
    <div className="dp__folder-list">
      {children.map((d) => {
        const Icon = isFolder(d) ? Folder : FileText
        return (
          <button key={d.id} className="dp__folder-row" onClick={() => onOpen(d.id)}>
            <Icon size={14} />
            <span className="dp__folder-name">{displayLabel(d)}</span>
            <span className="muted">{formatDate(d.meta.updatedAt)}</span>
          </button>
        )
      })}
    </div>
  )
}

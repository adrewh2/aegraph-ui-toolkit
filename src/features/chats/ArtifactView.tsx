import { Maximize2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { entityHref } from '../../app/routes'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { Inspector } from '../resources/Inspector'
import './ChatsView.css'
import { useOpenInTab } from '../workstation/paneContext'

/**
 * `/artifact/:id` — one entity as an artifact: its own interactive form first (a document's editor, a diagram,
 * a map, a player — the Inspector's app tab) with its fields, links and annotations a tab away. Made for the
 * Chats page's panel, where a whole page would be cramped; the header's expand button opens the entity's full page as a tab
 * beside it. Works as a top-level address too.
 */
export function ArtifactView() {
  const { id = '' } = useParams()
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const [pendingDelete, setPendingDelete] = useState<EntityId[] | null>(null)
  const entity = store.get(id)
  if (!entity) return <div className="chats__host-empty muted">{id ? 'This artifact is gone — deleted, or in a project that is not open.' : 'Pick an artifact to open it here.'}</div>
  const label = displayLabel(entity)
  return (
    <div className="artifact">
      <div className="artifact__body">
        <Inspector key={id} entityId={id} app closable={false} onClose={() => {}} onOpen={(other) => navigate(`/artifact/${encodeURIComponent(other)}`)} onDelete={(ids) => setPendingDelete(ids)}
          actions={
            <button className="btn btn--sm btn--icon btn--ghost" title="Open its full page as a tab beside this one" onClick={() => openTab(entityHref(entity, registry), label)}>
              <Maximize2 size={14} />
            </button>
          }
        />
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this artifact?"
        message={`“${label}” and any relationships attached to it will be removed. This can't be undone.`}
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

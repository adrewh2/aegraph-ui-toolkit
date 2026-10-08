import { Table2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { typeHref } from '../../app/routes'
import type { EntityId } from '../../core/entity/types'
import { ConfirmDialog } from '../ui/Dialog'
import { useToast } from '../ui/useToast'
import type { ListSelection } from './useListSelection'
import './ListSelection.css'

/** The rubber-band rectangle, drawn in viewport coordinates so it works in any scroll container. */
export function MarqueeOverlay({ sel }: { sel: ListSelection }) {
  const r = sel.marqueeRect
  const el = sel.scrollEl
  if (!r || !el) return null
  const b = el.getBoundingClientRect()
  return <div className="lsel__marquee" style={{ left: r.left - el.scrollLeft + b.left, top: r.top - el.scrollTop + b.top, width: r.width, height: r.height }} />
}

/**
 * Floating bar for the current selection: count, open the same set in the
 * Library or Knowledge table, delete. `deleteMany` decides what deletion
 * means for this list (documents take their descendants along).
 */
export function SelectionToolbar({ sel, noun, deleteMany, confirmDeleteIds, onConfirmHandled }: { sel: ListSelection; noun: string; deleteMany: (ids: EntityId[]) => void; confirmDeleteIds?: EntityId[] | null; onConfirmHandled?: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const [pending, setPending] = useState<EntityId[] | null>(null)
  const ids = [...sel.selected]
  const asking = confirmDeleteIds ?? pending
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const sample = ids.map((id) => store.get(id)).filter(Boolean)
  const type = sample[0]?.type ?? 'all'
  const list = ids.join(',')

  const closeConfirm = () => {
    setPending(null)
    onConfirmHandled?.()
  }
  const confirm = () => {
    const target = asking ?? []
    deleteMany(target)
    toast(`Deleted ${plural(target.length)}`)
    sel.clear()
    closeConfirm()
  }

  return (
    <>
      {ids.length > 0 && (
        <div className="lsel__bar" role="toolbar" aria-label="Selection">
          <strong>{plural(ids.length)}</strong>
          {ids.length === 1 && <span className="muted lsel__name">{displayLabel(sample[0]!)}</span>}
          <button className="btn btn--sm" onClick={() => navigate(`${typeHref(type, registry.categoryOf(type))}&sel=${list}`)} title="Open the selection in the Entities table">
            <Table2 size={13} /> Entities
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => setPending(ids)}>
            <Trash2 size={13} /> Delete
          </button>
          <button className="btn btn--sm btn--icon btn--ghost" onClick={sel.clear} aria-label="Clear selection" title="Clear (Esc)">
            <X size={13} />
          </button>
        </div>
      )}
      <ConfirmDialog
        open={!!asking && asking.length > 0}
        title={asking && asking.length === 1 ? `Delete this ${noun}?` : `Delete ${plural(asking?.length ?? 0)}?`}
        message={
          asking && asking.length === 1
            ? `“${displayLabel(store.get(asking[0]) ?? ({ id: asking[0] } as never))}” and any relationships attached will be removed. This can't be undone.`
            : `${plural(asking?.length ?? 0)} and any relationships attached will be removed. This can't be undone.`
        }
        confirmLabel="Delete"
        danger
        onConfirm={confirm}
        onCancel={closeConfirm}
      />
    </>
  )
}

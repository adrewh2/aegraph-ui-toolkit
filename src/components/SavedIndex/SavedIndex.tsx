import { Plus, Search, Trash2, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '../ui/Dialog'
import { TagChip } from '../ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import './SavedIndex.css'
import { Select } from '../ui/Select'

/**
 * The landing page for a kind of saved thing — scripts, charts, scenes —
 * the way the resource tabs list documents and images: what is already
 * there as cards, a search, a sort, and one button that makes a new one.
 * Opening a saved thing is a click; the tool itself lives one route on.
 */
type Sort = 'updated' | 'created' | 'title'
const SORT_LABELS: Record<Sort, string> = { updated: 'Last edited', created: 'Made', title: 'Name' }

export interface SavedIndexProps {
  items: AnyEntity[]
  /** "script" / "chart" / "scene" — used in the empty state and the buttons. */
  noun: string
  plural: string
  icon: LucideIcon
  blurb: string
  onOpen: (e: AnyEntity) => void
  onNew: () => void
  newLabel?: string
  /** A line under the name: what this one is, in the kind's own terms. */
  meta?: (e: AnyEntity) => string | undefined
  /** A picture for the card, when the kind has one. */
  preview?: (e: AnyEntity) => ReactNode
  /** `gallery`: wider cards with the picture across the top — for kinds whose picture is the point (scenes, charts). */
  layout?: 'list' | 'gallery'
  /** Anything else to offer above the list (a second way in, a note). */
  actions?: ReactNode
}

export function SavedIndex({ items, noun, plural, icon: Icon, blurb, onOpen, onNew, newLabel, meta, preview, actions, layout = 'list' }: SavedIndexProps) {
  const store = useEntityStore()
  useStoreVersion(store)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('updated')
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)

  const q = search.trim().toLowerCase()
  const list = useMemo(() => {
    const matches = q ? items.filter((e) => `${displayLabel(e)} ${e.description ?? ''} ${e.tags.join(' ')}`.toLowerCase().includes(q)) : items
    const byTime = (k: 'updatedAt' | 'createdAt') => (a: AnyEntity, b: AnyEntity) => (b.meta[k] ?? '').localeCompare(a.meta[k] ?? '')
    return [...matches].sort(sort === 'title' ? (a, b) => displayLabel(a).localeCompare(displayLabel(b)) : byTime(sort === 'created' ? 'createdAt' : 'updatedAt'))
  }, [items, q, sort])

  return (
    <div className="si">
      <header className="si__head">
        <div>
          {/* The section's title as Documents has it: the word alone (the tab and the sidebar carry the icon). */}
          <h1 className="page-title">{plural}</h1>
          <p className="si__blurb muted">{blurb}</p>
        </div>
        <div className="si__actions">
          {actions}
          <button className="btn btn--primary" onClick={onNew}>
            <Plus size={14} /> {newLabel ?? `New ${noun}`}
          </button>
        </div>
      </header>

      {items.length > 0 && (
        <div className="si__bar">
          <label className="si__search">
            <Search size={14} />
            <input className="input" value={search} placeholder={`Search ${plural.toLowerCase()}…`} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <span className="si__count muted">
            {list.length === items.length ? `${items.length} ${items.length === 1 ? noun : plural.toLowerCase()}` : `${list.length} of ${items.length}`}
          </span>
          <Select className="input si__sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
      )}

      {items.length === 0 ? (
        <div className="si__empty">
          <Icon size={26} />
          <p>
            No {plural.toLowerCase()} yet. {blurb}
          </p>
          <button className="btn btn--primary" onClick={onNew}>
            <Plus size={14} /> {newLabel ?? `New ${noun}`}
          </button>
        </div>
      ) : list.length === 0 ? (
        <p className="si__none muted">Nothing matches “{search.trim()}”.</p>
      ) : (
        <div className={`si__grid${layout === 'gallery' ? ' si__grid--gallery' : ''}`}>
          {list.map((e) => (
            <article key={e.id} className="si__card" role="button" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(ev) => ev.key === 'Enter' && onOpen(e)}>
              <div className="si__thumb">{preview?.(e) ?? <Icon size={20} />}</div>
              <div className="si__body">
                <h2 className="si__title">{displayLabel(e)}</h2>
                {meta?.(e) && <p className="si__meta">{meta(e)}</p>}
                {e.description && <p className="si__desc">{e.description}</p>}
                <div className="si__foot">
                  <span className="si__when muted">{formatDate(e.meta.updatedAt)}</span>
                  {e.tags.slice(0, 3).map((t) => (
                    <TagChip key={t} tag={t} />
                  ))}
                </div>
              </div>
              <button
                className="si__del"
                title={`Delete this ${noun}`}
                aria-label={`Delete this ${noun}`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  setPendingDelete(e.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete this ${noun}?`}
        message={`“${pendingDelete ? displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity)) : ''}” is removed from this workspace. What it was made from stays.`}
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

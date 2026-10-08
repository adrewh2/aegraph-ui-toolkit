import { Highlighter, LayoutGrid, List as ListIcon, MoreHorizontal } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { TagChip } from '../ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { type MediaLayout } from './useMediaLayout'
import './MediaList.css'

/**
 * The list half of the media indexes (Images, Videos, Audio). Documents has
 * its own rows; these share one row shape: thumbnail, title, a short meta
 * column, tags, edited date, and the "more" button. The grid/list choice is
 * remembered per index.
 */


export function LayoutToggle({ layout, onChange }: { layout: MediaLayout; onChange: (l: MediaLayout) => void }) {
  return (
    <div className="di__layout" role="group" aria-label="Layout">
      <button className={`di__layout-btn ${layout === 'grid' ? 'is-active' : ''}`} onClick={() => onChange('grid')} title="Grid" aria-pressed={layout === 'grid'}>
        <LayoutGrid size={14} />
      </button>
      <button className={`di__layout-btn ${layout === 'list' ? 'is-active' : ''}`} onClick={() => onChange('list')} title="List" aria-pressed={layout === 'list'}>
        <ListIcon size={14} />
      </button>
    </div>
  )
}

export function MediaList({ metaLabel, children }: { metaLabel: string; children: ReactNode }) {
  return (
    <div className="di__list ml">
      <div className="ml__row ml__row--head muted">
        <span />
        <span>Name</span>
        <span>{metaLabel}</span>
        <span>Tags</span>
        <span>Edited</span>
        <span />
      </div>
      {children}
    </div>
  )
}

export function MediaRow({ entity, selected, thumb, meta, count, onOpen, onMenu }: { entity: AnyEntity; selected?: boolean; thumb: ReactNode; meta?: ReactNode; count: number; onOpen: (e?: MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  return (
    <div
      className={`ml__row ${selected ? 'is-selected' : ''}`}
      data-id={entity.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <span className="ml__thumb">{thumb}</span>
      <span className="ml__name">
        <span className="di__card-title">{displayLabel(entity)}</span>
        {count > 0 && (
          <span className="ml__count" title={`${count} annotation${count === 1 ? '' : 's'}`}>
            <Highlighter size={11} /> {count}
          </span>
        )}
      </span>
      <span className="muted ml__meta">{meta}</span>
      <span className="di__row-tags">
        {entity.tags.slice(0, 3).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {entity.tags.length > 3 && <span className="badge">+{entity.tags.length - 3}</span>}
      </span>
      <span className="muted" title={new Date(entity.meta.updatedAt).toLocaleString()}>
        {formatDate(entity.meta.updatedAt)}
      </span>
      <button
        className="btn btn--sm btn--icon btn--ghost"
        aria-label="More"
        onClick={(e) => {
          e.stopPropagation()
          onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
}

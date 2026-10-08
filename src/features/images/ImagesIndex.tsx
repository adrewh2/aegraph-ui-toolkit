import { ChevronDown, Highlighter, Image as ImageIcon, Link as LinkIcon, MoreHorizontal, Plus, Search, Upload, X } from 'lucide-react'
import { DataImage } from '../../components/RemoteImage'
import { useMemo, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { MarqueeOverlay, SelectionToolbar } from '../../components/ListSelection/ListSelection'
import { useListSelection } from '../../components/ListSelection/useListSelection'
import { LayoutToggle, MediaList, MediaRow } from '../../components/MediaList/MediaList'
import { useMediaLayout } from '../../components/MediaList/useMediaLayout'
import { TagChip } from '../../components/ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { annotationsOf } from '../../core/resources/annotations'
import { formatDate, formatNumber } from '../../lib/format'
import { isInline, type ImageEntity } from './images'

type Sort = 'updated' | 'created' | 'title'
const SORT_LABELS: Record<Sort, string> = { updated: 'Last edited', created: 'Added', title: 'Title' }

interface Props {
  images: ImageEntity[]
  onAddUrl: () => void
  onUpload: () => void
  onDropFiles: (files: File[]) => void
  contextItems: (i: ImageEntity) => MenuItem[]
}

export function ImagesIndex({ images, onAddUrl, onUpload, onDropFiles, contextItems }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('updated')
  const [menu, setMenuState] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: Element } | null>(null)
  /** Opening a menu from the button that already owns the open one closes it instead. */
  const setMenu = (next: { x: number; y: number; items: MenuItem[]; anchor?: Element } | null) => setMenuState((cur) => (next && cur && next.anchor && cur.anchor === next.anchor ? null : next))
  const [dragOver, setDragOver] = useState(false)
  const [layout, setLayout] = useMediaLayout('aegraph:images:layout')

  const q = search.trim().toLowerCase()
  const items = useMemo(() => {
    let list = images
    if (q) list = list.filter((i) => displayLabel(i).toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)) || (i.data.url ?? '').toLowerCase().includes(q))
    if (tag) list = list.filter((i) => i.tags.includes(tag))
    const byTime = (k: 'updatedAt' | 'createdAt') => (a: ImageEntity, b: ImageEntity) => b.meta[k].localeCompare(a.meta[k])
    return [...list].sort(sort === 'title' ? (a, b) => displayLabel(a).localeCompare(displayLabel(b)) : byTime(sort === 'created' ? 'createdAt' : 'updatedAt'))
  }, [images, q, tag, sort])
  const [bulkDelete, setBulkDelete] = useState<EntityId[] | null>(null)
  const ids = useMemo(() => items.map((x) => x.id), [items])
  const { rootRef, sel } = useListSelection(ids, setBulkDelete)
  const tags = useMemo(() => [...new Set(images.flatMap((i) => i.tags))].sort(), [images])
  const at = (e: React.MouseEvent<HTMLButtonElement>) => ({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget as Element })

  const chip = (label: string, active: boolean, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, onClear?: () => void) => (
    <button className={`di__chip ${active ? 'is-active' : ''}`} onClick={onClick}>
      {label}
      {active && onClear ? (
        <span className="di__chip-x" role="button" aria-label="Clear" onClick={(e) => (e.stopPropagation(), onClear())}>
          <X size={11} />
        </span>
      ) : (
        <ChevronDown size={12} className="faint" />
      )}
    </button>
  )

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) onDropFiles(files)
  }

  return (
    <div
      ref={rootRef}
      data-sel-root=""
      onMouseDown={sel.onMouseDown}
      className={`di ig ${dragOver ? 'is-dragover' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="di__head">
        <div className="di__head-left">
          <h1 className="page-title">Images</h1>
          <p className="page-subtitle">Pictures you can draw on. Every box is an annotation entity.</p>
        </div>
        <div className="di__head-actions">
          <button className="btn" onClick={onAddUrl}>
            <LinkIcon size={14} /> From URL
          </button>
          <button className="btn btn--primary" onClick={onUpload}>
            <Upload size={14} /> Upload
          </button>
        </div>
      </header>

      <div className="di__filters">
        {chip(tag ?? 'Tag', !!tag, (e) => setMenu({ ...at(e), items: tags.length ? tags.map((t) => ({ kind: 'item', label: t, onSelect: () => setTag(t) })) : [{ kind: 'label', label: 'No tags yet' }] }), () => setTag(null))}
        {chip(`Sort: ${SORT_LABELS[sort]}`, false, (e) => setMenu({ ...at(e), items: (Object.keys(SORT_LABELS) as Sort[]).map((s) => ({ kind: 'item', label: SORT_LABELS[s], onSelect: () => setSort(s) })) }))}
        <span className="spacer" />
        <LayoutToggle layout={layout} onChange={setLayout} />
        <label className="di__search">
          <Search size={14} className="faint" />
          <input placeholder="Search images" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
      </div>

      {items.length === 0 ? (
        <div className="di__empty">
          <div className="di__empty-inner">
            <ImageIcon size={28} strokeWidth={1.5} className="faint" />
            <h2>{q || tag ? 'Nothing matches' : 'No images yet'}</h2>
            <p className="muted">{q || tag ? 'Try a different search or clear the filter.' : 'Upload a file, paste a URL, or drop images anywhere on this page.'}</p>
            {!q && !tag && (
              <div className="di__empty-actions">
                <button className="btn btn--primary" onClick={onUpload}>
                  <Upload size={14} /> Upload
                </button>
                <button className="btn" onClick={onAddUrl}>
                  <LinkIcon size={14} /> From URL
                </button>
              </div>
            )}
          </div>
        </div>
      ) : layout === 'grid' ? (
        <div className="ig__grid">
          {items.map((img, i) => (
            <ImageCard key={img.id} image={img} selected={sel.isSelected(img.id)} count={annotationsOf(store, img.id).length} onOpen={(e) => (e && sel.click(e, img.id, i)) || navigate(`/images/${img.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(img) })} />
          ))}
        </div>
      ) : (
        <MediaList metaLabel="Size">
          {items.map((img, i) => (
            <MediaRow
              key={img.id}
              entity={img}
              selected={sel.isSelected(img.id)}
              thumb={<DataImage src={img.data.src} providers compact alt="" loading="lazy" draggable={false} />}
              meta={imageDims(img)}
              count={annotationsOf(store, img.id).length}
              onOpen={(e) => (e && sel.click(e, img.id, i)) || navigate(`/images/${img.id}`)}
              onMenu={(x, y) => setMenu({ x, y, items: contextItems(img) })}
            />
          ))}
        </MediaList>
      )}

      {dragOver && (
        <div className="ig__drop">
          <Plus size={20} /> Drop to add images
        </div>
      )}
      <MarqueeOverlay sel={sel} />
      <SelectionToolbar sel={sel} noun="image" deleteMany={(ids) => store.remove(ids)} confirmDeleteIds={bulkDelete} onConfirmHandled={() => setBulkDelete(null)} />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  )
}

const imageDims = (image: ImageEntity) => (image.data.width && image.data.height ? `${formatNumber(image.data.width)}×${formatNumber(image.data.height)}` : isInline(image) ? 'uploaded' : 'linked')

function ImageCard({ image, selected, count, onOpen, onMenu }: { image: ImageEntity; selected: boolean; count: number; onOpen: (e?: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  const dims = imageDims(image)
  return (
    <div
      className={`ig__card ${selected ? 'is-selected' : ''}`}
      data-id={image.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="ig__thumb">
        <DataImage src={image.data.src} providers compact alt={image.label ?? ''} loading="lazy" draggable={false} />
        {count > 0 && (
          <span className="ig__count" title={`${count} annotation${count === 1 ? '' : 's'}`}>
            <Highlighter size={11} /> {count}
          </span>
        )}
      </div>
      <div className="di__card-foot">
        <div className="di__card-name">
          <span className="di__card-title">{displayLabel(image)}</span>
          <button
            className="btn btn--sm btn--icon btn--ghost di__card-more"
            aria-label="More"
            onClick={(e) => {
              e.stopPropagation()
              onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
        <div className="di__card-meta">
          <span className="muted">{dims}</span>
          <span className="muted" title={new Date(image.meta.updatedAt).toLocaleString()}>
            {formatDate(image.meta.updatedAt)}
          </span>
          {image.tags.slice(0, 2).map((t) => (
            <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
          ))}
          {image.tags.length > 2 && <span className="badge">+{image.tags.length - 2}</span>}
        </div>
      </div>
    </div>
  )
}

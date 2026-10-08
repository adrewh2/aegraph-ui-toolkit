import { ChevronDown, Highlighter, Link as LinkIcon, MoreHorizontal, Search, Music as AudioIcon, X } from 'lucide-react'
import { DataImage } from '../../components/RemoteImage'
import { useMemo, useState } from 'react'
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
import { formatDate, formatDuration } from '../../lib/format'
import type { AudioEntity } from './audio'

type Sort = 'updated' | 'created' | 'title'
const SORT_LABELS: Record<Sort, string> = { updated: 'Last edited', created: 'Added', title: 'Title' }

interface Props {
  items: AudioEntity[]
  onAdd: () => void
  contextItems: (v: AudioEntity) => MenuItem[]
}

export function AudioIndex({ items: all, onAdd, contextItems }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('updated')
  const [menu, setMenuState] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: Element } | null>(null)
  /** Opening a menu from the button that already owns the open one closes it instead. */
  const setMenu = (next: { x: number; y: number; items: MenuItem[]; anchor?: Element } | null) => setMenuState((cur) => (next && cur && next.anchor && cur.anchor === next.anchor ? null : next))
  const [layout, setLayout] = useMediaLayout('aegraph:audio:layout')

  const q = search.trim().toLowerCase()
  const items = useMemo(() => {
    let list = all
    if (q) list = list.filter((v) => displayLabel(v).toLowerCase().includes(q) || (v.data.artist ?? '').toLowerCase().includes(q) || v.tags.some((t) => t.toLowerCase().includes(q)))
    if (tag) list = list.filter((v) => v.tags.includes(tag))
    const byTime = (k: 'updatedAt' | 'createdAt') => (a: AudioEntity, b: AudioEntity) => b.meta[k].localeCompare(a.meta[k])
    return [...list].sort(sort === 'title' ? (a, b) => displayLabel(a).localeCompare(displayLabel(b)) : byTime(sort === 'created' ? 'createdAt' : 'updatedAt'))
  }, [all, q, tag, sort])
  const [bulkDelete, setBulkDelete] = useState<EntityId[] | null>(null)
  const ids = useMemo(() => items.map((x) => x.id), [items])
  const { rootRef, sel } = useListSelection(ids, setBulkDelete)
  const tags = useMemo(() => [...new Set(all.flatMap((v) => v.tags))].sort(), [all])
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

  return (
    <div ref={rootRef} data-sel-root="" onMouseDown={sel.onMouseDown} className="di">
      <header className="di__head">
        <div className="di__head-left">
          <h1 className="page-title">Audio</h1>
          <p className="page-subtitle">Spotify tracks, albums, playlists and episodes you can annotate by moment or by time range.</p>
        </div>
        <div className="di__head-actions">
          <button className="btn btn--primary" onClick={onAdd}>
            <LinkIcon size={14} /> Add Spotify link
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
          <input placeholder="Search audio" value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <AudioIcon size={28} strokeWidth={1.5} className="faint" />
            <h2>{q || tag ? 'Nothing matches' : 'No audio yet'}</h2>
            <p className="muted">{q || tag ? 'Try a different search or clear the filter.' : 'Paste a Spotify link to start annotating.'}</p>
            {!q && !tag && (
              <div className="di__empty-actions">
                <button className="btn btn--primary" onClick={onAdd}>
                  <LinkIcon size={14} /> Add Spotify link
                </button>
              </div>
            )}
          </div>
        </div>
      ) : layout === 'grid' ? (
        <div className="ig__grid vg__grid">
          {items.map((v, i) => (
            <AudioCard key={v.id} audio={v} selected={sel.isSelected(v.id)} count={annotationsOf(store, v.id).length} onOpen={(e) => (e && sel.click(e, v.id, i)) || navigate(`/audio/${v.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(v) })} />
          ))}
        </div>
      ) : (
        <MediaList metaLabel="Artist">
          {items.map((v, i) => (
            <MediaRow
              key={v.id}
              entity={v}
              selected={sel.isSelected(v.id)}
              thumb={v.data.thumbnailUrl ? <DataImage src={v.data.thumbnailUrl} providers compact alt="" loading="lazy" draggable={false} /> : <AudioIcon size={18} strokeWidth={1.5} />}
              meta={
                <>
                  {v.data.artist ?? v.data.spotifyType}
                  {v.data.duration ? ` · ${formatDuration(v.data.duration)}` : ''}
                </>
              }
              count={annotationsOf(store, v.id).length}
              onOpen={(e) => (e && sel.click(e, v.id, i)) || navigate(`/audio/${v.id}`)}
              onMenu={(x, y) => setMenu({ x, y, items: contextItems(v) })}
            />
          ))}
        </MediaList>
      )}
      <MarqueeOverlay sel={sel} />
      <SelectionToolbar sel={sel} noun="item" deleteMany={(ids) => store.remove(ids)} confirmDeleteIds={bulkDelete} onConfirmHandled={() => setBulkDelete(null)} />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  )
}

function AudioCard({ audio, selected, count, onOpen, onMenu }: { audio: AudioEntity; selected: boolean; count: number; onOpen: (e?: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  return (
    <div
      className={`ig__card ${selected ? 'is-selected' : ''}`}
      data-id={audio.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="ig__thumb vg__thumb mg__thumb">
        {audio.data.thumbnailUrl ? <DataImage src={audio.data.thumbnailUrl} providers compact alt="" loading="lazy" draggable={false} /> : <div className="mg__art-fallback"><AudioIcon size={28} strokeWidth={1.5} /></div>}
        <span className="mg__kind">{audio.data.spotifyType}</span>
        {audio.data.duration ? <span className="vg__duration">{formatDuration(audio.data.duration)}</span> : null}
        {count > 0 && (
          <span className="ig__count" title={`${count} annotation${count === 1 ? '' : 's'}`}>
            <Highlighter size={11} /> {count}
          </span>
        )}
      </div>
      <div className="di__card-foot">
        <div className="di__card-name">
          <span className="di__card-title">{displayLabel(audio)}</span>
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
          {audio.data.artist && <span className="muted">{audio.data.artist}</span>}
          <span className="muted" title={new Date(audio.meta.updatedAt).toLocaleString()}>
            {formatDate(audio.meta.updatedAt)}
          </span>
          {audio.tags.slice(0, 2).map((t) => (
            <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
          ))}
          {audio.tags.length > 2 && <span className="badge">+{audio.tags.length - 2}</span>}
        </div>
      </div>
    </div>
  )
}

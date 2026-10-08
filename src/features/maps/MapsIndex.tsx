import { ChevronDown, Globe2, Map as MapIcon, MoreHorizontal, Plus, Search, StickyNote, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MarqueeOverlay, SelectionToolbar } from '../../components/ListSelection/ListSelection'
import { useListSelection } from '../../components/ListSelection/useListSelection'
import { LayoutToggle, MediaList, MediaRow } from '../../components/MediaList/MediaList'
import { useMediaLayout } from '../../components/MediaList/useMediaLayout'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate, formatNumber } from '../../lib/format'
import { allGeo, type BaseLayer, type MapEntity } from './maps'
import type { MapCounts } from './mapIndexParts'
import { MapThumb } from './MapThumb'

/**
 * `/maps` — the index of maps, as Documents and Images have theirs: a
 * card or a row per map with a picture of what is on it (`MapThumb`: the
 * view fitted to its places, paths and areas, drawn over their tiles) and
 * when it was last touched; a search, a tag, a sort; the way to a new map
 * (`/maps/new`) and to everything on one map (`/maps/all`).
 */

type Sort = 'updated' | 'created' | 'title' | 'count'
const SORT_LABELS: Record<Sort, string> = { updated: 'Last edited', created: 'Created', title: 'Title', count: 'Most on it' }

interface Props {
  maps: MapEntity[]
  counts: Map<EntityId, MapCounts>
  contextItems: (m: MapEntity) => MenuItem[]
}

const LAYER_LABELS: Record<BaseLayer, string> = { streets: 'Streets', satellite: 'Satellite', terrain: 'Terrain' }

export function MapsIndex({ maps, counts, contextItems }: Props) {
  const store = useEntityStore()
  useStoreDataVersion(store)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('updated')
  const [menu, setMenuState] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: Element } | null>(null)
  /** Opening a menu from the button that already owns the open one closes it instead. */
  const setMenu = (next: { x: number; y: number; items: MenuItem[]; anchor?: Element } | null) => setMenuState((cur) => (next && cur && next.anchor && cur.anchor === next.anchor ? null : next))
  const [layout, setLayout] = useMediaLayout('aegraph:maps:layout')

  const q = search.trim().toLowerCase()
  const items = useMemo(() => {
    let list = maps
    if (q) list = list.filter((m) => displayLabel(m).toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q)) || (m.description ?? '').toLowerCase().includes(q))
    if (tag) list = list.filter((m) => m.tags.includes(tag))
    const byTime = (k: 'updatedAt' | 'createdAt') => (a: MapEntity, b: MapEntity) => b.meta[k].localeCompare(a.meta[k])
    const by: (a: MapEntity, b: MapEntity) => number =
      sort === 'title' ? (a, b) => displayLabel(a).localeCompare(displayLabel(b)) : sort === 'count' ? (a, b) => (counts.get(b.id)?.n ?? 0) - (counts.get(a.id)?.n ?? 0) : byTime(sort === 'created' ? 'createdAt' : 'updatedAt')
    return [...list].sort(by)
  }, [maps, q, tag, sort, counts])
  const [bulkDelete, setBulkDelete] = useState<EntityId[] | null>(null)
  const ids = useMemo(() => items.map((x) => x.id), [items])
  const { rootRef, sel } = useListSelection(ids, setBulkDelete)
  const tags = useMemo(() => [...new Set(maps.flatMap((m) => m.tags))].sort(), [maps])
  // Every location, path and area — subtypes included — which `allGeo` computes once per data version.
  const everything = allGeo(store).length
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
  const onIt = (m: MapEntity) => {
    const c = counts.get(m.id) ?? { n: 0, notes: 0 }
    return `${formatNumber(c.n)} on it${c.notes ? `, ${c.notes} note${c.notes === 1 ? '' : 's'}` : ''}`
  }

  return (
    <div ref={rootRef} data-sel-root="" onMouseDown={sel.onMouseDown} className="di ig mi">
      <header className="di__head">
        <div className="di__head-left">
          <h1 className="page-title">Maps</h1>
          <p className="page-subtitle">A saved view each — a centre, a zoom, a layer — with the locations, paths and areas that belong to it.</p>
        </div>
        <div className="di__head-actions">
          <button className="btn" onClick={() => navigate('/maps/all')} title="Every location, path and area in the workspace on one map, whatever map it belongs to">
            <Globe2 size={14} /> Everything on one map · {formatNumber(everything)}
          </button>
          <button className="btn btn--primary" onClick={() => navigate('/maps/new')}>
            <Plus size={14} /> New map
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
          <input placeholder="Search maps" value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <MapIcon size={28} strokeWidth={1.5} className="faint" />
            <h2>{q || tag ? 'Nothing matches' : 'No maps yet'}</h2>
            <p className="muted">{q || tag ? 'Try a different search or clear the filter.' : 'Make a map and add places to it, import a KML or GeoJSON file, or look at everything with a place on one map.'}</p>
            {!q && !tag && (
              <div className="di__empty-actions">
                <button className="btn btn--primary" onClick={() => navigate('/maps/new')}>
                  <Plus size={14} /> New map
                </button>
                <button className="btn" onClick={() => navigate('/maps/all')}>
                  <Globe2 size={14} /> Everything on one map
                </button>
              </div>
            )}
          </div>
        </div>
      ) : layout === 'grid' ? (
        <div className="ig__grid">
          {items.map((m, i) => (
            <MapCard key={m.id} map={m} selected={sel.isSelected(m.id)} counts={counts.get(m.id) ?? { n: 0, notes: 0 }} onOpen={(e) => (e && sel.click(e, m.id, i)) || navigate(`/maps/${m.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(m) })} />
          ))}
        </div>
      ) : (
        <MediaList metaLabel="On it">
          {items.map((m, i) => (
            <MediaRow key={m.id} entity={m} selected={sel.isSelected(m.id)} thumb={<MapThumb map={m} store={store} />} meta={onIt(m)} count={0} onOpen={(e) => (e && sel.click(e, m.id, i)) || navigate(`/maps/${m.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(m) })} />
          ))}
        </MediaList>
      )}

      <MarqueeOverlay sel={sel} />
      <SelectionToolbar sel={sel} noun="map" deleteMany={(ids) => store.remove(ids)} confirmDeleteIds={bulkDelete} onConfirmHandled={() => setBulkDelete(null)} />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  )
}

function MapCard({ map, selected, counts, onOpen, onMenu }: { map: MapEntity; selected: boolean; counts: MapCounts; onOpen: (e?: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  return (
    <div
      className={`ig__card ${selected ? 'is-selected' : ''}`}
      data-id={map.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="ig__thumb mi__thumb">
        <MapThumb map={map} store={store} />
        <span className="ig__count" title={`${counts.n} location${counts.n === 1 ? '' : 's'}, path${counts.n === 1 ? '' : 's'} and area${counts.n === 1 ? '' : 's'} on this map`}>
          <MapIcon size={11} /> {formatNumber(counts.n)}
        </span>
        {counts.notes > 0 && (
          <span className="ig__count mi__notes" title={`${counts.notes} note${counts.notes === 1 ? '' : 's'} pinned to this map`}>
            <StickyNote size={11} /> {counts.notes}
          </span>
        )}
      </div>
      <div className="di__card-foot">
        <div className="di__card-name">
          <span className="di__card-title">{displayLabel(map)}</span>
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
          <span className="muted">
            {LAYER_LABELS[map.data.layer] ?? map.data.layer} · z{Math.round(map.data.zoom)}
          </span>
          <span className="muted" title={new Date(map.meta.updatedAt).toLocaleString()}>
            {formatDate(map.meta.updatedAt)}
          </span>
          {map.tags.slice(0, 2).map((t) => (
            <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
          ))}
          {map.tags.length > 2 && <span className="badge">+{map.tags.length - 2}</span>}
        </div>
      </div>
    </div>
  )
}

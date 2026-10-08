import { ArrowLeft, Images, Map as MapIcon, PanelRightClose, PanelRightOpen, StickyNote, Waypoints, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ui/Dialog'
import type { MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { FieldDef } from '../../core/entity/schema'
import { applyLayout } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { RESOURCE_TYPES } from '../../core/resources/types'
import { graphHref } from '../../app/openIn'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { EntityTable } from '../resources/EntityTable'
import { Inspector } from '../resources/Inspector'
import { MapPendingDialog, MapStage, MapTimeline, toolHint, type MapWorkbench } from './MapWorkbench'
import { AREA_TYPE, LOCATION_TYPE, mapsShowing, PATH_TYPE, type GeoEntity, geoKindOf } from './maps'
import { enrichGeo, wikiPreviewOf } from './wikipedia'
import '../resources/ResourcesView.css'

/**
 * The map pages' body, shared by the home map and a map's own page: the
 * tools row, the map where a table would be, and on the right — resizable
 * by the standard gutter — the standard entity table over what is on the
 * map, under tabs: All · Locations · Paths · Areas, and Notes on a map.
 * The map draws exactly the rows the table shows (tab, search, column
 * filters); a filter in force is said so, with a Reset. Details take the
 * table's place with a way back.
 *
 * The list folds away — the handle on the map's edge, or `?list=0` in the
 * address for a link that means the map to fill the pane (a demo opening on
 * its city or its globe). Folding is remembered; the address is not, so a
 * link that asks for the map alone doesn't change how your own maps open.
 */
type Kind = 'all' | typeof LOCATION_TYPE | typeof PATH_TYPE | typeof AREA_TYPE | 'notes'

/** Columns shown by default here even if the type hides them in the big tables: what a pin is *about* belongs next to it — its photo and description. */
/** Whether the places list is unfolded, across maps and reloads. */
const LIST_KEY = 'aegraph:maps:list-open'

const PHOTO: FieldDef = { key: 'data.preview.image', label: 'Photo', kind: 'image', width: 72 }
const showDescription = (fields: FieldDef[], photo = true) => {
  const out = fields.map((f) => (f.key === 'description' ? { ...f, hidden: false } : f))
  if (!photo) return out
  const at = out.findIndex((f) => f.key === 'description')
  out.splice(at < 0 ? 1 : at, 0, PHOTO)
  return out
}

export function MapBody({ wb, onDeleteEntities, detailRequest, onShownGeo }: { wb: MapWorkbench; onDeleteEntities?: (ids: EntityId[]) => void; /** Bump `n` to open `id` in the details pane from outside (the map picker's Details). */ detailRequest?: { id: EntityId; n: number }; /** What the table currently shows, for the page header's actions over it. */ onShownGeo?: (geo: GeoEntity[]) => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const [selected, setSelected] = useState<Set<EntityId>>(new Set())
  const [detailId, setDetailId] = useState<EntityId | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId[] | null>(null)
  /** The entity an annotation is being written for. */
  const [kind, setKind] = useState<Kind>('all')
  /** What the table shows after its own search, column filters and sort: the map draws exactly this. */
  const [shown, setShown] = useState<AnyEntity[]>([])
  const [resetSignal, setResetSignal] = useState(0)
  const side = useResizableWidth({ storageKey: 'aegraph:maps:list-width', initial: 460, min: 300, max: 900, edge: 'start' })
  const [search] = useSearchParams()
  const [listOpen, setListOpen] = useState(() => (search.get('list') === '0' ? false : localStorage.getItem(LIST_KEY) !== '0'))
  const toggleList = () => {
    setListOpen((on) => {
      try {
        localStorage.setItem(LIST_KEY, on ? '0' : '1')
      } catch {
        /* private window: the fold lasts this page */
      }
      return !on
    })
  }

  const notes = useMemo(() => wb.visibleNotes.map((n) => n.annotation), [wb.visibleNotes])
  // One table over three types: the location's fields, plus what paths and areas add, with the type shown — and the description.
  const layout = wb.map?.data.table
  const fields = useMemo(() => {
    if (kind === 'notes') return showDescription(registry.fieldsFor(RESOURCE_TYPES.annotation), false)
    if (kind !== 'all') return showDescription(registry.fieldsFor(kind))
    const seen = new Set<string>()
    const merged = [LOCATION_TYPE, PATH_TYPE, AREA_TYPE].flatMap((t) => registry.fieldsFor(t)).filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true))).map((f) => (f.key === 'type' ? { ...f, hidden: false } : f))
    return showDescription(applyLayout(merged, layout))
  }, [registry, kind, layout])
  // What the map says its table opens with: the kinds shown on the All tab, and the sort — else the type's own layout's sort.
  const defaultFilters = useMemo(() => {
    if (kind !== 'all' || !layout?.types?.length) return undefined
    const wanted = new Set(layout.types)
    const seen = new Set<string>()
    for (const e of wb.places) seen.add(e.type)
    const types = [...seen].filter((t) => wanted.has(t) || wanted.has(geoKindOf(store, t) ?? ''))
    return types.length ? { type: types } : undefined
  }, [kind, layout, wb.places, store])
  const defaultSort = useMemo(() => layout?.sort ?? (kind === 'notes' ? undefined : registry.tableOf(kind === 'all' ? LOCATION_TYPE : kind)?.sort) ?? null, [layout, kind, registry])
  const rows = useMemo(() => {
    if (kind === 'notes') return notes
    if (kind === 'all') return wb.visiblePlaces
    const kinds = new Map<string, boolean>()
    return wb.visiblePlaces.filter((e) => {
      let hit = kinds.get(e.type)
      if (hit === undefined) kinds.set(e.type, (hit = geoKindOf(store, e.type) === kind))
      return hit
    })
  }, [wb.visiblePlaces, notes, kind, store])
  // By id, not by reference: an update to a place (a Wikipedia preview, a drag, an edit) gives the store a new object
  // while the table still reports the old one, and matching references drew nothing until the table caught up.
  const shownGeo = useMemo(() => {
    if (kind === 'notes') return wb.visiblePlaces
    // The table's rows are drawn from the visible places, so as many rows as places is all of them: no set of a
    // city's worth of ids to say so.
    if (shown.length === wb.visiblePlaces.length) return wb.visiblePlaces
    const ids = new Set<string>()
    for (const e of shown) ids.add(e.id)
    return wb.visiblePlaces.filter((p) => ids.has(p.id))
  }, [shown, wb.visiblePlaces, kind])
  const onShown = useCallback((r: AnyEntity[]) => setShown(r), [])
  // A filter is in force when the map shows less than everything: a type tab, or the table's own search / column filters.
  useEffect(() => onShownGeo?.(shownGeo as GeoEntity[]), [shownGeo]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = kind !== 'all' && kind !== 'notes' ? true : kind === 'all' && shown.length < rows.length && !detailId
  const reset = () => {
    setKind('all')
    setResetSignal((n) => n + 1)
  }
  const counts = useMemo(() => {
    // One pass, the kind looked up once per type: three filters over a city's worth of pins were a third of a second.
    const kinds = new Map<string, string | undefined>()
    const c = { location: 0, path: 0, area: 0 }
    for (const e of wb.places) {
      let k = kinds.get(e.type)
      if (k === undefined && !kinds.has(e.type)) kinds.set(e.type, (k = geoKindOf(store, e.type)))
      if (k === LOCATION_TYPE) c.location++
      else if (k === PATH_TYPE) c.path++
      else if (k === AREA_TYPE) c.area++
    }
    return c
  }, [wb.places, store])

  // Map ↔ table selection: a pin click selects the row; a row click flies to the pin.
  useEffect(() => {
    if (wb.selected && !selected.has(wb.selected)) setSelected(new Set([wb.selected]))
    // A click on bare map or globe clears the map's selection: the row it stood for goes too (a multi-row
    // selection made in the table is the table's own and stays).
    else if (!wb.selected && selected.size === 1) setSelected(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wb.selected])
  const onSelectedChange = useCallback(
    (next: Set<EntityId>) => {
      setSelected(next)
      if (next.size === 1) {
        const id = [...next][0]
        if (id !== wb.selected) wb.jumpTo(id)
      } else if (next.size === 0) wb.setSelected(null)
    },
    [wb.selected, wb.jumpTo, wb.setSelected], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const openDetail = useCallback((e: AnyEntity) => setDetailId(e.id), [])

  // First look, and each time another map is picked: frame what is on it (the map's saved view when it is empty).
  const fitted = useRef<string | null>(null)
  useEffect(() => {
    const key = wb.map?.id ?? 'all'
    if (fitted.current === key) return
    if (!wb.map && !wb.places.length) return
    if (!wb.map && wb.initial.zoom !== 2 && fitted.current === null) {
      fitted.current = key
      return
    }
    fitted.current = key
    const t = setTimeout(() => {
      if (wb.places.length) wb.fitAll()
      else if (wb.map) wb.canvas.current?.flyTo(wb.map.data.center, wb.map.data.zoom)
    }, 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wb.map?.id, wb.places.length])
  useEffect(() => {
    if (detailRequest) setDetailId(detailRequest.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRequest?.n])
  useEffect(() => {
    // A different map: the selection and any open detail belonged to the last one; so did a Notes tab.
    setSelected(new Set())
    setDetailId(null)
    setKind((k) => (k === 'notes' && !wb.map ? 'all' : k))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wb.map?.id])

  const contextItems = useCallback((e: AnyEntity): MenuItem[] => [
    { kind: 'item', label: 'Show on map', onSelect: () => wb.jumpTo(e.id) },
    { kind: 'item', label: 'Details', onSelect: () => setDetailId(e.id) },
    // On a map, a note pinned at its point (an annotation on the entity itself is the menu's Annotate…).
    ...(wb.map && geoKindOf(store, e.type) === LOCATION_TYPE ? [{ kind: 'item' as const, label: 'Pin note here', icon: StickyNote, onSelect: () => wb.setPending({ kind: 'note', at: { lat: (e as GeoEntity).data.lat, lng: (e as GeoEntity).data.lng } }) }] : []),
    ...(e.type === RESOURCE_TYPES.annotation ? [] : [{ kind: 'item' as const, label: wikiPreviewOf(e as GeoEntity) ? 'Refetch photo & summary' : 'Find photo & summary', icon: Images, onSelect: () => void enrichGeo(store, e as GeoEntity, { force: true }).then((p) => toast(p ? `${p.title}: ${p.image ? 'photo and summary' : 'summary'} from Wikipedia` : 'Nothing on Wikipedia near there')) }]),
    ...(wb.map ? [] : mapsShowing(store, e.id).map<MenuItem>((m) => ({ kind: 'item', label: `Open on “${displayLabel(m)}”`, icon: MapIcon, onSelect: () => navigate(`/maps/${m.id}`) }))),
  ], [wb, store, navigate, toast])
  const detail = detailId ? store.get(detailId) : undefined
  const tabs: [Kind, string, number, ReturnType<typeof registry.get> | undefined][] = [
    ['all', 'All', wb.places.length, undefined],
    [LOCATION_TYPE, 'Locations', counts.location, registry.get(LOCATION_TYPE)],
    [PATH_TYPE, 'Paths', counts.path, registry.get(PATH_TYPE)],
    [AREA_TYPE, 'Areas', counts.area, registry.get(AREA_TYPE)],
    ...(wb.map ? [['notes', 'Notes', notes.length, { ...registry.get(RESOURCE_TYPES.annotation), icon: StickyNote, color: '#e9a23b' }] as [Kind, string, number, ReturnType<typeof registry.get>]] : []),
  ]

  return (
    <>
      <div className="res__body">
        <div className="res__table geo__stage">
          <MapStage wb={wb} features={detailId ? wb.visiblePlaces : shownGeo} featureItems={contextItems} />
          <button className="geo__list-handle" onClick={toggleList} title={listOpen ? 'Fold the list away — the map fills the pane' : 'Show the places on the map as a table'} aria-label={listOpen ? 'Hide the list' : 'Show the list'}>
            {listOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        </div>
        {listOpen && <div className="pane-gutter" onPointerDown={side.onPointerDown} onDoubleClick={side.reset} title="Drag to resize · double-click to reset" />}
        <div className="res__inspector geo-all__list" style={{ width: side.width }} hidden={!listOpen}>
          <div className="res__tabs" role="tablist" aria-label="Kind">
            {tabs.map(([k, label, n, t]) => {
              const Icon = t?.icon
              return (
                <button key={k} role="tab" aria-selected={kind === k} className={`res__tab ${kind === k ? 'is-active' : ''}`} onClick={() => (setKind(k), setDetailId(null))}>
                  {Icon && (
                    <span style={{ color: t?.color, display: 'inline-flex' }}>
                      <Icon size={14} />
                    </span>
                  )}
                  {label}
                  <span className="count">{n}</span>
                </button>
              )
            })}
            <span className="spacer" />
            {filtered ? (
              <span className="geo-all__filtered">
                {shownGeo.length} of {wb.places.length}
                <button className="btn btn--sm btn--ghost" onClick={reset} title="Show everything again">
                  <X size={12} /> Reset
                </button>
              </span>
            ) : (
              <span className="geo-all__hint muted">{toolHint(wb.tool) || (selected.size ? `${selected.size} selected` : '')}</span>
            )}
          </div>
          {detail ? (
            <div className="geo-all__detail">
              <button className="btn btn--sm btn--ghost geo-all__back" onClick={() => setDetailId(null)}>
                <ArrowLeft size={13} /> Back
              </button>
              <Inspector entityId={detail.id} app initialTab="fields" onClose={() => setDetailId(null)} onOpen={(id) => (store.get(id)?.type === 'map' ? navigate(`/maps/${id}`) : setDetailId(id))} onDelete={(ids) => setPendingDelete(ids)} />
            </div>
          ) : (
            <EntityTable
              entities={rows}
              fields={fields}
              selected={selected}
              onSelectedChange={onSelectedChange}
              onOpen={openDetail}
              onDelete={setPendingDelete}
              contextItems={contextItems}
              showOpenIn
              storageKey={`maps:${kind}`}
              defaultFilters={defaultFilters}
              defaultSort={defaultSort}
              onVisibleRowsChange={onShown}
              resetSignal={resetSignal}
              emptyMessage={kind === 'notes' ? 'No pinned notes — Pin note (top right), then click the map. A note can be about a moment or a span of time.' : 'Nothing here yet — Add location, Add path or Add area (top right), search the map, paste a Google Maps link, or import KML / GeoJSON.'}
            />
          )}
        </div>
      </div>
      {/* The timeline runs under the stage and the list alike: the window and the playhead filter both. */}
      <MapTimeline wb={wb} />

      <MapPendingDialog wb={wb} />
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${pendingDelete?.length === 1 ? 'this' : `these ${pendingDelete?.length}`}?`}
        message="Removed from the workspace and from the map they were on."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            if (onDeleteEntities) onDeleteEntities(pendingDelete)
            else store.remove(pendingDelete)
            toast(`Deleted ${pendingDelete.length}`)
            setSelected(new Set())
            if (detailId && pendingDelete.includes(detailId)) setDetailId(null)
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

/** Photos and summaries from Wikipedia for what the table shows and lacks one — the page header's action over the list. */
/**
 * The map's rows in Unigraph, every one where it stands: the same entities as a graph, with the geographic placement
 * as the rule in force (relationships among them drawn, the engine's tools at hand) — the map as a graph view.
 */
export function UnigraphButton({ wb, shown }: { wb: MapWorkbench; shown: GeoEntity[] }) {
  const navigate = useNavigate()
  const rows = shown.length ? shown : wb.visiblePlaces
  return (
    <button className="btn" disabled={!rows.length} title="Show these in Unigraph, each where it is on Earth — the map as a graph, with the links among them drawn" onClick={() => navigate(graphHref(rows.map((e) => e.id), wb.map ? displayLabel(wb.map) : 'On the map', '2d', true, undefined, true))}>
      <Waypoints size={14} /> Unigraph
    </button>
  )
}

export function EnrichButton({ wb, shown }: { wb: MapWorkbench; shown: GeoEntity[] }) {
  const store = useEntityStore()
  const toast = useToast()
  const [enriching, setEnriching] = useState<{ done: number; of: number } | null>(null)
  const enrichShown = async () => {
    const todo = (shown.length ? shown : wb.visiblePlaces).filter((e) => !wikiPreviewOf(e) && !e.data.previewCheckedAt) as GeoEntity[]
    if (!todo.length) return toast('Everything shown already has a preview (or was checked). Use the row menu to refetch one.')
    setEnriching({ done: 0, of: todo.length })
    let found = 0
    for (const [i, e] of todo.entries()) {
      if (await enrichGeo(store, e).catch(() => undefined)) found++
      await new Promise((r) => setTimeout(r, 600)) // gently: Wikimedia throttles bursts
      setEnriching({ done: i + 1, of: todo.length })
    }
    setEnriching(null)
    toast(`Found photos and summaries for ${found} of ${todo.length}`)
  }
  return (
    <button className="btn" disabled={!!enriching} title="Photos and summaries from Wikipedia for what is shown (only what has none yet)" onClick={() => void enrichShown()}>
      <Images size={14} /> {enriching ? `Photos… ${enriching.done}/${enriching.of}` : 'Photos & summaries'}
    </button>
  )
}

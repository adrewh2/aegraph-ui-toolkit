import { Check, ChevronDown, Globe2, Info, List, Map as MapIcon, PenLine, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { openInItems } from '../../app/openIn'
import { useOpenInTab, useViewActive } from '../workstation/paneContext'
import { registerGlobeHandle, type GlobeHandle } from '../globe/globeHandle'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion, useStoreVersion } from '../../core/entity/hooks'
import { formatDate } from '../../lib/format'
import { EnrichButton, MapBody, UnigraphButton } from './MapBody'
import { MapNewDialog } from './MapNewDialog'
import { MapAddButtons, MapToolbar, useMapWorkbench } from './MapWorkbench'
import { allGeo, allMaps, AREA_TYPE, geoAnnotationsOf, geoOf, LOCATION_TYPE, PATH_TYPE, type GeoEntity, type MapEntity, geoKindOf } from './maps'
import { unnamed } from './mapIndexParts'
import '../resources/ResourcesView.css'

/**
 * `/maps/:id` and `/maps/all` — one page. The map is a filter, not a place:
 * the picker top right says which map is in view (or all of them) and the
 * map and table show what belongs to it; picking another changes nothing
 * else on the page. The picker also holds the map's own actions: rename,
 * details, delete. The index of maps is `/maps` (MapsIndex); `/maps/new`
 * makes one and opens it here, asking for its name.
 */
const countsCache = new WeakMap<object, { points: number; arcs: number; polygons: number }>()

export function MapsHome({ map }: { map: MapEntity | null }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  // A map just made (`/maps/new`) arrives asking for its name — once.
  const [dialog, setDialog] = useState<'name' | 'rename' | null>(() => (map && unnamed.delete(map.id) ? 'name' : null))
  const [shownGeo, setShownGeo] = useState<GeoEntity[]>([])
  const [pendingDelete, setPendingDelete] = useState<MapEntity | null>(null)
  const [detailRequest, setDetailRequest] = useState<{ id: string; n: number } | undefined>()
  const wb = useMapWorkbench(map)
  // The `globe` tool drives this page — either stage — through a page-global handle while it is on screen.
  const viewActive = useViewActive()
  const wbRef = useRef(wb)
  wbRef.current = wb
  useEffect(() => {
    const h: GlobeHandle = {
      getState: () => {
        const w = wbRef.current
        const ents = w.visiblePlaces
        // Counting a hundred thousand entities three times over is not free: once per list, then remembered.
        let c = countsCache.get(ents)
        if (!c) {
          c = { points: 0, arcs: 0, polygons: 0 }
          for (const e of ents) {
            const k = geoKindOf(store, e.type)
            if (k === LOCATION_TYPE) c.points++
            else if (k === PATH_TYPE) c.arcs += Math.max(0, (e.data.geometry?.type === 'LineString' ? e.data.geometry.coordinates.length : 2) - 1)
            else if (k === AREA_TYPE) c.polygons++
          }
          countsCache.set(ents, c)
        }
        return {
          mode: w.mode,
          layer: w.globeLayer,
          selectedId: w.selected ?? undefined,
          playhead: w.playhead === undefined ? undefined : new Date(w.playhead).toISOString(),
          playing: w.playing,
          window: w.window ? { from: new Date(w.window.from).toISOString(), to: new Date(w.window.to).toISOString() } : undefined,
          entities: ents.length,
          points: c.points,
          arcs: c.arcs,
          polygons: c.polygons,
          range: w.span ? { from: new Date(w.span.min).toISOString(), to: new Date(w.span.max).toISOString() } : undefined,
          selection: { mapId: w.map?.id },
          camera: w.globe.current?.pointOfView(),
        }
      },
      setMode: (m) => wbRef.current.setMode(m),
      setLayer: (l) => (l === 'night' ? wbRef.current.setGlobeNight(true) : (wbRef.current.setLayer(l), wbRef.current.setGlobeNight(false))),
      setWindow: (win) => wbRef.current.setWindow(win ? { from: Date.parse(win.from), to: Date.parse(win.to) } : null),
      flyTo: (lat, lng, altitude, ms) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('fly needs finite lat and lng.')
        const w = wbRef.current
        if (w.mode === 'globe') w.globe.current?.flyTo(lat, lng, altitude, ms)
        else w.canvas.current?.flyTo({ lat, lng })
      },
      fit: () => wbRef.current.fitAll(),
      select: (id) => (id ? wbRef.current.jumpTo(id) : wbRef.current.setSelected(null)),
      setPlayhead: (iso) => wbRef.current.setPlayhead(iso ? Date.parse(iso) : undefined),
      play: (on) => wbRef.current.setPlaying(on),
      spin: (on) => wbRef.current.globe.current?.spin(on),
    }
    return registerGlobeHandle(h, viewActive)
  }, [viewActive])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // The maps and what is on each, for the picker: a walk over every geo entity per map, so once per data version,
  // not per render — a zoom saves the view and re-renders this page, and a city's trees are not to be counted again
  // for it. (The picker's order by last update settles at the next material write.)
  const dataVersion = useStoreDataVersion(store)
  const maps = useMemo(() => allMaps(store).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)), [store, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const onMap = useMemo(() => new Map(maps.map((m) => [m.id, { n: geoOf(store, m).length, notes: geoAnnotationsOf(store, m.id).length }])), [store, maps, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickerItems: MenuItem[] = [
    { kind: 'item', label: `Everything on one map  ·  ${allGeo(store).length}`, icon: map ? undefined : Check, onSelect: () => navigate('/maps/all') },
    { kind: 'item', label: 'All maps', icon: List, onSelect: () => navigate('/maps') },
    { kind: 'sep' },
    ...(maps.length
      ? maps.map<MenuItem>((m) => {
          const { n, notes } = onMap.get(m.id) ?? { n: 0, notes: 0 }
          return { kind: 'item', label: `${displayLabel(m)}  ·  ${n} on it${notes ? `, ${notes} note${notes === 1 ? '' : 's'}` : ''}  ·  ${formatDate(m.meta.updatedAt)}`, icon: map?.id === m.id ? Check : undefined, onSelect: () => navigate(`/maps/${m.id}`) }
        })
      : [{ kind: 'item' as const, label: 'No maps yet', disabled: true, onSelect: () => {} }]),
    { kind: 'sep' },
    { kind: 'item', label: 'New map', icon: Plus, onSelect: () => navigate('/maps/new') },
    ...(map
      ? [
          { kind: 'sep' as const },
          { kind: 'label' as const, label: displayLabel(map) },
          { kind: 'item' as const, label: 'Rename…', icon: PenLine, onSelect: () => setDialog('rename') },
          { kind: 'item' as const, label: 'Details', icon: Info, onSelect: () => setDetailRequest({ id: map.id, n: (detailRequest?.n ?? 0) + 1 }) },
          ...openInItems(map, navigate, undefined, { store, open: openTab }),
          { kind: 'item' as const, label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setPendingDelete(map) },
        ]
      : []),
  ]

  return (
    <div className="res geo-all">
      <div className="res__head">
        <div>
          <h1 className="page-title">Maps</h1>
          {map && <p className="page-subtitle">“{displayLabel(map)}”</p>}
        </div>
        <div className="res__head-actions">
          <div className="gx-tabs" role="tablist" aria-label="View">
            <button role="tab" aria-selected={wb.mode === '2d'} className={`gx-tab ${wb.mode === '2d' ? 'is-active' : ''}`} onClick={() => wb.setMode('2d')} title="The flat map">
              <MapIcon size={12} /> 2D
            </button>
            <button role="tab" aria-selected={wb.mode === 'globe'} className={`gx-tab ${wb.mode === 'globe' ? 'is-active' : ''}`} onClick={() => wb.setMode('globe')} title="Earth as a globe — the same places, the same selection and time window">
              <Globe2 size={12} /> Globe
            </button>
          </div>
          <MapToolbar wb={wb} compact />
          <UnigraphButton wb={wb} shown={shownGeo} />
          <EnrichButton wb={wb} shown={shownGeo} />
          <span className="tb__sep" />
          <MapAddButtons wb={wb} />
          <button className={`btn ${map ? 'is-on' : ''}`} onClick={(e) => setPicker({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })} title="Which map is in view — a filter over everything with a place">
            <MapIcon size={14} /> {map ? displayLabel(map) : 'Everything on one map'} <ChevronDown size={13} />
          </button>
          <button className="btn btn--primary" onClick={() => navigate('/maps/new')}>
            <Plus size={14} /> New map
          </button>
        </div>
      </div>

      <MapBody wb={wb} detailRequest={detailRequest} onShownGeo={setShownGeo} />

      {picker && <Menu x={picker.x} y={picker.y} items={pickerItems} onClose={() => setPicker(null)} />}
      {(dialog === 'rename' || dialog === 'name') && map && (
        <MapNewDialog
          title={dialog === 'name' ? 'Name the map' : 'Rename map'}
          initial={map.label ?? ''}
          onClose={() => setDialog(null)}
          onSubmit={(label) => {
            store.update(map.id, { label })
            setDialog(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete “${pendingDelete ? displayLabel(pendingDelete) : ''}”?`}
        message="The map is removed; what it showed stays in the workspace, on no map. Notes pinned to the map go with it."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            store.remove(pendingDelete.id)
            toast(`Deleted ${displayLabel(pendingDelete)}`)
            if (map?.id === pendingDelete.id) navigate('/maps')
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

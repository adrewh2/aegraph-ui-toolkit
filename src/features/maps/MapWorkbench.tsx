import { Check, Copy, Crosshair, Download, ExternalLink, Hexagon, Info, Layers, Link, LocateFixed, MapPin, Maximize2, Route, Search, StickyNote, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useToast } from '../../components/ui/useToast'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { useEntityMenu } from '../resources/entityMenu'
import { downloadText, pickFile } from '../../lib/download'
import { formatDate } from '../../lib/format'
import { MapCanvas, type MapCanvasHandle, type MapTool } from './MapCanvas'
import type { MapLink } from './pointLayer'
import { GlobeStage, type GlobeStageHandle } from '../globe/GlobeStage'
import {
  allGeo,
  allMaps,
  annotateMap,
  boundsOf,
  createArea,
  createLocation,
  createMap,
  createPath,
  distanceM,
  formatArea,
  formatDistance,
  geoAnnotationsOf,
  geoOf,
  geoKindOf,
  LOCATION_TYPE,
  isGeoIn,
  geocode,
  googleEarthUrl,
  googleMapsUrl,
  importFeatures,
  inWindow,
  MAP_ACCEPT,
  geoPreview,
  moveGeoAnnotation,
  parseGoogleMapsUrl,
  parseMapFile,
  placesToGeoJson,
  placesToKml,
  pointsOf,
  removeFromMap,
  reverseGeocode,
  timeSpanOf,
  type BaseLayer,
  type PinMode,
  POINTS_FROM,
  pinModeFor,
  type GeocodeHit,
  type Geometry,
  type LatLng,
  type GeoEntity,
  type MapEntity,
} from './maps'
import { fetchWikiGallery, readMoreUrl } from './placeCard'
import { altitudeForView, zoomForAltitude } from './viewSync'
import { enrichGeo, wikiPreviewOf } from './wikipedia'

type Tool = MapTool

/** Where the all-places map's view (centre, zoom, base layer, flat or globe) is remembered; a map's own is kept on its entity. */
const ALL_VIEW_KEY = 'aegraph:maps:all-view'
/** A link between two places with no coloured tag: the engine's own quiet grey. */
const LINK_COLOR = '#b5b2aa'
/** Whether the hover cards are shown — off until asked for. A preference of the person, not of a map, so it is one key for the page. */
const CARDS_KEY = 'aegraph:maps:cards'
export type MapMode = '2d' | 'globe'

/**
 * Everything the map page, the all-places map and the detail-panel embed
 * share. With a map: its places and pinned notes, view remembered on the
 * entity. With `null`: every place in the workspace and every pinned
 * note, view remembered locally.
 */
export function useMapWorkbench(map: MapEntity | null, opts: { onOpenEntity?: (id: EntityId) => void } = {}) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  // What is on the map changes with the data, not with bookkeeping: the saved view is written volatile (below), and a
  // city's worth of trees must not be re-collected and re-sorted for it.
  const dataVersion = useStoreDataVersion(store)
  const toast = useToast()
  const canvas = useRef<MapCanvasHandle>(null)
  const [tool, setTool] = useState<Tool>('browse')
  const [selected, setSelected] = useState<EntityId | null>(null)
  const [pending, setPending] = useState<{ kind: 'location' | 'note'; at: LatLng } | { kind: 'path' | 'area'; at: LatLng; geometry: Geometry } | null>(null)
  const [window_, setWindow] = useState<{ from: number; to: number } | null>(null)
  // 2D (Leaflet) or the globe. Both stages stay mounted; this only says which is in front. From the URL so links and tools can ask for one.
  const [params, setParams] = useSearchParams()
  const mode: MapMode = params.get('view') === 'globe' ? 'globe' : '2d'
  /** The view handed from the stage leaving to the one arriving, applied once the arriving stage is on screen. */
  const handover = useRef<{ lat: number; lng: number; altitude?: number; zoom?: number } | null>(null)
  useEffect(() => {
    const v = handover.current
    if (!v) return
    handover.current = null
    if (mode === 'globe' && v.altitude !== undefined) globe.current?.setView(v.lat, v.lng, v.altitude)
    if (mode === '2d' && v.zoom !== undefined) canvas.current?.setView(v, v.zoom)
  }, [mode])
  const setMode = useCallback(
    (m: MapMode) => {
      if (m === mode) return
      // The stage coming to the front takes over the view of the one leaving: the same centre, and the height
      // (altitude) that shows what the zoom showed, or the other way round — so the switch changes the projection
      // and nothing else. Read now, while the leaving stage is the one on screen (a hidden Leaflet map has no
      // size); applied once the arriving stage is (the effect below).
      if (m === 'globe') {
        const c = canvas.current
        if (c) {
          const at = c.center()
          handover.current = { lat: at.lat, lng: at.lng, altitude: altitudeForView(c.zoom(), at.lat, c.size().y) }
        }
      } else {
        const pov = globe.current?.pointOfView()
        const h = globe.current?.size().y ?? canvas.current?.size().y ?? 748
        if (pov) handover.current = { lat: pov.lat, lng: pov.lng, zoom: zoomForAltitude(pov.altitude, pov.lat, h) }
      }
      const next = new URLSearchParams(params)
      if (m === 'globe') next.set('view', 'globe')
      else next.delete('view')
      setParams(next, { replace: true })
      writeAllView({ mode: m })
    },
    [mode, params, setParams],
  )
  // A moment on the timeline (ms); undefined shows the whole window. Playing moves it.
  const [playhead, setPlayhead] = useState<number | undefined>()
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const globe = useRef<GlobeStageHandle>(null)
  // Where the map is looking. Not page state: a pan or a zoom step would otherwise render the whole page — the
  // table of a city's trees with it — for the coordinates readout to change. The two things that show the view
  // subscribe to it through `useMapView`, and nothing else renders for it.
  const viewRef = useRef<{ center: LatLng; zoom: number }>(map ? { center: map.data.center, zoom: map.data.zoom } : readAllView())
  const viewListeners = useRef(new Set<() => void>())
  const subscribeView = useCallback((fn: () => void) => (viewListeners.current.add(fn), () => void viewListeners.current.delete(fn)), [])
  const getView = useCallback(() => viewRef.current, [])
  const [localLayer, setLocalLayer] = useState<BaseLayer>(() => readAllView().layer)
  // The globe can also show a night texture, which the flat map has no tiles for.
  const [night, setNight] = useState<boolean>(() => localStorage.getItem('aegraph:globe:night') === '1')
  // The card behind a pin, path or area is the quickest way to see what something is, and the quickest way to be
  // interrupted while reading the map underneath it. The switch is the page's, not a map's: it is how you like to
  // work rather than something about this set of places, so it is remembered here for every map.
  const [cards, setShowCards] = useState<boolean>(() => localStorage.getItem(CARDS_KEY) === '1')
  const setCards = (on: boolean) => {
    setShowCards(on)
    try {
      localStorage.setItem(CARDS_KEY, on ? '1' : '0')
    } catch {
      /* a browser with storage off still gets the switch, just not the memory of it */
    }
  }
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mapId = map?.id

  // Locations, paths and areas: the map's own, or — on the home map — every one in the workspace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const places = useMemo(() => (mapId ? geoOf(store, store.get(mapId) as MapEntity) : allGeo(store)), [store, mapId, dataVersion])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const notes = useMemo(() => (mapId ? geoAnnotationsOf(store, mapId) : allMaps(store).flatMap((m) => geoAnnotationsOf(store, m.id))), [store, mapId, dataVersion])
  const layer: BaseLayer = map ? map.data.layer : localLayer
  const globeLayer: BaseLayer | 'night' = night ? 'night' : layer
  const setGlobeNight = (on: boolean) => {
    setNight(on)
    localStorage.setItem('aegraph:globe:night', on ? '1' : '0')
  }
  const initial = useMemo(() => (map ? { center: map.data.center, zoom: map.data.zoom } : readAllView()), [map])
  const span = useMemo(() => timeSpanOf(places, notes), [places, notes])
  const windowed = useMemo(() => (window_ ? places.filter((p) => inWindow(p.data.at, p.data.until, window_.from, window_.to)) : places), [places, window_])
  // At a moment: what is happening then — spans covering it, instants within a slice of the window, undated things always.
  const visibleAtPlayhead = useMemo(() => {
    if (playhead === undefined) return windowed
    const lo = window_ ? window_.from : (span?.min ?? playhead)
    const hi = window_ ? window_.to : (span?.max ?? playhead)
    const slice = Math.max(60_000, (hi - lo) / 40)
    return windowed.filter((p) => {
      if (!p.data.at) return true
      const a = Date.parse(p.data.at)
      const u = p.data.until ? Date.parse(p.data.until) : a
      return a <= playhead && u >= playhead - slice
    })
  }, [windowed, playhead, window_, span])
  // The playhead moves thirty times a second while playing; the set of things at it changes far less often. The same
  // members keep the same array, so the stages, the table and the globe redraw only when something appears or goes.
  const lastVisible = useRef(visibleAtPlayhead)
  const visiblePlaces = useMemo(() => {
    const prev = lastVisible.current
    if (prev !== visibleAtPlayhead && prev.length === visibleAtPlayhead.length && prev.every((p, i) => p === visibleAtPlayhead[i])) return prev
    lastVisible.current = visibleAtPlayhead
    return visibleAtPlayhead
  }, [visibleAtPlayhead])
  const visibleNotes = useMemo(() => (window_ ? notes.filter((n) => inWindow(n.geo.at, n.geo.until, window_.from, window_.to)) : notes), [notes, window_])
  useEffect(() => {
    if (!playing || !span) return
    const lo = window_?.from ?? span.min
    const hi = window_?.to ?? span.max
    const step = Math.max(1000, ((hi - lo) / 900) * speed)
    const t = setInterval(() => setPlayhead((p) => ((p ?? lo) + step > hi ? lo : (p ?? lo) + step)), 33)
    return () => clearInterval(t)
  }, [playing, span, window_, speed])
  const colorOf = useCallback(
    (tags: string[]) => {
      // A loop over the tags, no arrays made: the pin index asks once per feature, a city's worth at a time.
      for (let i = 0; i < tags.length; i++) {
        const c = store.tagColor(tags[i])
        if (c) return c
      }
      return undefined
    },
    [store],
  )
  // Hover cards read linked pictures at render time; a new version rebuilds the pins with fresh ones.
  const previewOf = useCallback((e: GeoEntity) => geoPreview(store, e), [store, version]) // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * The card's extra pictures, on demand: the place's Wikipedia article is looked up (and kept) if it never was, then its
   * pictures. Not on a map of thousands — a city's tree inventory is not landmarks, and a lookup per hover would be a
   * request and a write each; *Photos & summaries* and a pin's *Find photo & summary* still look one up on purpose.
   */
  const many = places.length > 5000
  const loadMore = useCallback(
    async (e: GeoEntity) => {
      const preview = wikiPreviewOf(e) ?? (e.data.previewCheckedAt || many ? undefined : await enrichGeo(store, e).catch(() => undefined))
      return preview ? fetchWikiGallery(preview) : []
    },
    [store, many],
  )
  const readMoreOf = useCallback((e: GeoEntity) => readMoreUrl(e, wikiPreviewOf(e)), [])

  // Remember the view on the map entity, quietly: a volatile write, since where the map was left is bookkeeping, not
  // data — nothing derived from the dataset changes, autosave does not wake, and the map's own memos hold.
  const onView = useCallback(
    (center: LatLng, zoom: number) => {
      viewRef.current = { center, zoom }
      for (const fn of viewListeners.current) fn()
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const c = { lat: Math.round(center.lat * 1e5) / 1e5, lng: Math.round(center.lng * 1e5) / 1e5 }
        if (!mapId) return writeAllView({ center: c, zoom })
        const cur = store.get(mapId)
        if (cur && !Array.isArray(cur.data)) store.update(mapId, { data: { ...cur.data, center: c, zoom } }, { volatile: true })
      }, 800)
    },
    [store, mapId],
  )
  const setLayer = (l: BaseLayer) => {
    if (map) store.update(map.id, { data: { ...map.data, layer: l } })
    else {
      setLocalLayer(l)
      writeAllView({ layer: l })
    }
  }
  // The links among what is drawn — relationships with both ends in the list — for the points to draw as edges: one
  // pass over the store's relationships per list (the table's rows change the list; a data change drops the cache),
  // by feature index, coloured by the link's first coloured tag.
  const linkCache = useMemo(() => new WeakMap<GeoEntity[], MapLink[]>(), [store, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const linksFor = useCallback(
    (list: GeoEntity[]): MapLink[] => {
      const have = linkCache.get(list)
      if (have) return have
      const at = new Map<EntityId, number>()
      list.forEach((p, i) => at.set(p.id, i))
      const out: MapLink[] = []
      for (const r of store.relationships()) {
        const a = at.get(r.source.id)
        const b = at.get(r.target.id)
        if (a !== undefined && b !== undefined && a !== b) out.push([a, b, r.tags.map((t) => store.getTagInfo(t).color).find(Boolean) ?? LINK_COLOR])
      }
      linkCache.set(list, out)
      return out
    },
    [linkCache, store],
  )
  // How locations are drawn: the map's choice, else the all-places view's, else by how many there are.
  const [localPins, setLocalPins] = useState<PinMode | undefined>(() => readAllView().pins)
  const pinChoice = map ? map.data.pins : localPins
  // How many are locations, once per list of places — a city's worth, counted per render, was a hitch on every zoom step.
  const locationCount = useMemo(() => places.reduce((n, p) => n + (geoKindOf(store, p.type) === LOCATION_TYPE ? 1 : 0), 0), [store, places])
  const pins = pinModeFor(pinChoice, locationCount)
  const setPins = (p: PinMode | undefined) => {
    if (map) store.update(map.id, { data: { ...map.data, pins: p } })
    else {
      setLocalPins(p)
      writeAllView({ pins: p })
    }
  }

  const onClick = (p: LatLng) => {
    if (tool === 'location') setPending({ kind: 'location', at: p })
    else if (tool === 'note') setPending({ kind: 'note', at: p })
  }
  /** A finished drawing (path or lasso) waits for a name. */
  const onDraw = (g: Geometry) => {
    const first = g.type === 'LineString' ? g.coordinates[0] : g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates
    setPending({ kind: g.type === 'LineString' ? 'path' : 'area', at: { lat: first[1], lng: first[0] }, geometry: g })
  }
  const addPlace = (p: LatLng, label: string, extra: { address?: string; at?: string; tags?: string[]; url?: string; source?: string; description?: string } = {}) => {
    const place = createLocation(store, { label, lat: p.lat, lng: p.lng, mapId: map?.id, ...extra })
    setSelected(place.id)
    return place
  }
  const addShape = (g: Geometry, label: string, extra: { at?: string; until?: string; tags?: string[]; description?: string } = {}) => {
    const e = g.type === 'LineString' ? createPath(store, { label, coordinates: g.coordinates, mapId: map?.id, source: 'drawn', ...extra }) : g.type === 'Polygon' ? createArea(store, { label, ring: g.coordinates[0], mapId: map?.id, source: 'drawn', ...extra }) : addPlace({ lat: g.coordinates[1], lng: g.coordinates[0] }, label, extra)
    setSelected(e.id)
    return e
  }
  const addNote = (p: LatLng, comment: string, tags: string[], at?: string, until?: string, radius?: number) => {
    if (!map) throw new Error('Notes pin to a map — open one first.')
    const a = annotateMap(store, map, { lat: p.lat, lng: p.lng, at, until, radius }, comment, tags)
    setSelected(a.id)
    return a
  }
  const fitAll = () => {
    const pts = [...places.flatMap(pointsOf), ...notes.map((n) => ({ lat: n.geo.lat, lng: n.geo.lng }))]
    canvas.current?.fit(pts)
    globe.current?.fit(pts)
  }
  // Both stages fly, so whichever is in front arrives — the globe to the height that shows what the flat map's zoom does.
  const flyBoth = (p: LatLng, zoom: number) => {
    canvas.current?.flyTo(p, zoom)
    globe.current?.flyTo(p.lat, p.lng, altitudeForView(zoom, p.lat, canvas.current?.size().y ?? 748))
  }
  const locate = async () => {
    try {
      const p = await canvas.current!.locate()
      flyBoth(p, 15)
      toast(`You are near ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`)
      return p
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }
  const importFile = async () => {
    const file = await pickFile(MAP_ACCEPT)
    if (!file) return
    try {
      const { features, source, name } = await parseMapFile(file)
      if (!features.length) return toast('Nothing found in that file.')
      // On the home map, a file becomes a map of its own.
      const target = map ?? createMap(store, { label: name ?? file.name.replace(/\.[^.]+$/, ''), source: file.name })
      const added = importFeatures(store, target, features, source, ['from-' + source])
      toast(`Added ${added.length} from ${file.name}`)
      queueMicrotask(() => canvas.current?.fit(added.flatMap(pointsOf)))
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }
  const addFromLink = async (text: string) => {
    const hit = parseGoogleMapsUrl(text)
    if (!hit) {
      toast(text.includes('goo.gl') ? 'Short Google links can’t be resolved here — open it and paste the full address-bar link.' : 'That doesn’t look like a Google Maps link or a lat, lng pair.')
      return undefined
    }
    const address = hit.label ?? (await reverseGeocode(hit))
    const p = addPlace(hit, hit.label ?? address ?? `${hit.lat}, ${hit.lng}`, { address, url: /^https?:/.test(text.trim()) ? text.trim() : undefined, source: 'google-maps' })
    flyBoth(hit, hit.zoom ?? 15)
    return p
  }
  const exportAs = (what: 'geojson' | 'kml') => {
    const name = (map?.label ?? 'all-maps').replace(/[^\w.-]+/g, '_')
    if (what === 'geojson') downloadText(`${name}.geojson`, placesToGeoJson(places, notes), 'application/geo+json')
    else downloadText(`${name}.kml`, placesToKml(map?.label ?? 'All maps', places, notes), 'application/vnd.google-earth.kml+xml')
  }
  const remove = (id: EntityId) => {
    const e = store.get(id)
    if (!e) return
    if (isGeoIn(store, e) && map) removeFromMap(store, map, id)
    else store.remove(id)
    if (selected === id) setSelected(null)
  }
  // Only the stage in front moves: the hidden one has no size, and Leaflet throws on a fly-to it cannot project —
  // which used to stop the globe from ever getting its turn.
  const jumpTo = (id: EntityId) => {
    setSelected(id)
    const p = places.find((x) => x.id === id)
    const n = notes.find((x) => x.annotation.id === id)
    const onGlobe = mode === 'globe'
    try {
      if (p && p.data.geometry && p.data.geometry.type !== 'Point') {
        if (onGlobe) globe.current?.fit(pointsOf(p))
        else canvas.current?.fit(pointsOf(p))
      } else if (p) {
        if (onGlobe) globe.current?.flyTo(p.data.lat, p.data.lng, 0.35)
        else canvas.current?.flyTo({ lat: p.data.lat, lng: p.data.lng })
      } else if (n) {
        if (onGlobe) globe.current?.flyTo(n.geo.lat, n.geo.lng, 0.35)
        else canvas.current?.flyTo({ lat: n.geo.lat, lng: n.geo.lng })
      }
    } catch (err) {
      console.warn('[maps] could not move to the selection:', err)
    }
  }

  return { store, toast, canvas, globe, mode, setMode, globeLayer, night, setGlobeNight, cards, setCards, pins, pinChoice, setPins, linksFor, windowed, playhead, setPlayhead, playing, setPlaying, speed, setSpeed, tool, setTool, selected, setSelected, pending, setPending, window: window_, setWindow, subscribeView, getView, initial, layer, onView, flyBoth, setLayer, onClick, onDraw, addPlace, addShape, addNote, fitAll, locate, importFile, addFromLink, exportAs, remove, jumpTo, places, notes, visiblePlaces, visibleNotes, span, colorOf, previewOf, loadMore, readMoreOf, map, onOpenEntity: opts.onOpenEntity }
}

export type MapWorkbench = ReturnType<typeof useMapWorkbench>

/** The all-places map's remembered view — where a new map opens too. */
export function readAllView(): { center: LatLng; zoom: number; layer: BaseLayer; mode?: MapMode; pins?: PinMode } {
  try {
    const v = JSON.parse(localStorage.getItem(ALL_VIEW_KEY) ?? '{}') as Partial<{ center: LatLng; zoom: number; layer: BaseLayer; mode: MapMode; pins: PinMode }>
    return { center: v.center ?? { lat: 20, lng: 0 }, zoom: v.zoom ?? 2, layer: v.layer ?? 'streets', mode: v.mode, pins: v.pins }
  } catch {
    return { center: { lat: 20, lng: 0 }, zoom: 2, layer: 'streets' }
  }
}
function writeAllView(patch: Partial<{ center: LatLng; zoom: number; layer: BaseLayer; mode: MapMode; pins: PinMode | undefined }>) {
  try {
    localStorage.setItem(ALL_VIEW_KEY, JSON.stringify({ ...readAllView(), ...patch }))
  } catch {
    /* ignore */
  }
}

/** The map with its overlays: search, layers, coordinates, and the pending marker. */
export function MapStage({
  wb,
  compact = false,
  features,
  featureItems,
}: {
  wb: MapWorkbench
  compact?: boolean
  /** What to draw instead of everything visible (a type tab's subset). */
  features?: MapWorkbench['visiblePlaces']
  /** The page's own items for a feature's right-click menu (Show on map, Details…), before the menu every entity has. */
  featureItems?: (e: AnyEntity) => MenuItem[]
}) {
  const { canvas, tool, selected, setSelected, onClick, onDraw, onView, visiblePlaces, visibleNotes, pending, colorOf, previewOf, loadMore, readMoreOf, store, initial, layer, pins, linksFor } = wb
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<GeocodeHit[]>([])
  const [layersMenu, setLayersMenu] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    if (!q.trim()) return setHits([])
    if (parseGoogleMapsUrl(q)) return setHits([])
    timer.current = setTimeout(() => geocode(q).then(setHits).catch(() => setHits([])), 450)
  }, [q])
  const pick = (h: GeocodeHit) => {
    setHits([])
    setQ('')
    wb.flyBoth(h, 15)
    wb.setPending({ kind: 'location', at: h })
  }
  const layerItems: MenuItem[] = [
    ...(['streets', 'satellite', 'terrain'] as BaseLayer[]).map<MenuItem>((l) => ({ kind: 'item', label: l === 'streets' ? 'Streets (OpenStreetMap)' : l === 'satellite' ? 'Satellite (Esri imagery)' : 'Terrain (OpenTopoMap)', icon: wb.layer === l && !wb.night ? Check : undefined, onSelect: () => (wb.setLayer(l), wb.setGlobeNight(false)) })),
    ...(wb.mode === 'globe' ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: 'Night lights (globe only)', icon: wb.night ? Check : undefined, onSelect: () => wb.setGlobeNight(!wb.night) }] : []),
    { kind: 'sep' },
    { kind: 'label', label: 'Locations' },
    { kind: 'item', label: 'Points — every one, at every zoom', icon: wb.pins === 'points' ? Check : undefined, onSelect: () => wb.setPins('points') },
    { kind: 'item', label: 'Pins, bubbled where they crowd', icon: wb.pins === 'bubbles' ? Check : undefined, onSelect: () => wb.setPins('bubbles') },
    ...(wb.pinChoice ? [{ kind: 'item' as const, label: `Decide by count (points from ${POINTS_FROM.toLocaleString()})`, onSelect: () => wb.setPins(undefined) }] : []),
  ]
  /** Points on the path being drawn; the HUD's Finish needs two. */
  const [drawn, setDrawn] = useState(0)
  /** Right-click on the map: add things at that point. */
  const [mapMenu, setMapMenu] = useState<{ x: number; y: number; at: LatLng } | null>(null)
  /** Right-click on a feature: the menu of the entity it draws (`entityMenu.tsx`), the page's items first. */
  const entityMenu = useEntityMenu()
  const [featureMenu, setFeatureMenu] = useState<{ x: number; y: number; id: EntityId } | null>(null)
  const featureEntity = featureMenu ? store.get(featureMenu.id) : undefined
  const openFeatureMenu = (id: EntityId, p: { x: number; y: number }) => {
    setSelected(id)
    setFeatureMenu({ ...p, id })
  }
  const mapMenuItems = (at: LatLng): MenuItem[] => [
    { kind: 'item', label: 'Add location here', icon: MapPin, onSelect: () => wb.setPending({ kind: 'location', at }) },
    ...(wb.map ? [{ kind: 'item' as const, label: 'Pin note here', icon: StickyNote, onSelect: () => wb.setPending({ kind: 'note', at }) }] : []),
    { kind: 'item', label: 'Start a path here', icon: Route, onSelect: () => (wb.setTool('path'), setTimeout(() => (wb.mode === 'globe' ? wb.globe.current : canvas.current)?.addPoint(at), 0)) },
    { kind: 'item', label: 'Draw an area', icon: Hexagon, onSelect: () => wb.setTool('area') },
    { kind: 'sep' },
    { kind: 'item', label: `Copy coordinates  ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`, icon: Copy, onSelect: () => void navigator.clipboard?.writeText(`${at.lat.toFixed(6)}, ${at.lng.toFixed(6)}`).then(() => wb.toast('Coordinates copied')) },
    { kind: 'item', label: 'Open in Google Maps', icon: ExternalLink, onSelect: () => window.open(googleMapsUrl(at), '_blank', 'noopener') },
  ]
  const globeActive = wb.mode === 'globe'
  return (
    <div className={`geo__map ${globeActive ? 'is-globe' : ''}`}>
      {/* Both stages stay mounted — switching keeps each one's camera and costs nothing; only the front one is shown. */}
      <div className="geo__stage-2d" hidden={globeActive}>
      <MapCanvas
        ref={canvas}
        center={initial.center}
        zoom={initial.zoom}
        layer={layer}
        pins={pins}
        links={linksFor(features ?? visiblePlaces)}
        features={features ?? visiblePlaces}
        notes={visibleNotes}
        selectedId={selected}
        tool={tool}
        onSelect={setSelected}
        onClick={onClick}
        onDraw={onDraw}
        onMovePlace={(id, to) => {
          const p = store.get(id)
          if (p) store.update(id, { data: { ...p.data, lat: to.lat, lng: to.lng } })
        }}
        onMoveNote={(a, to) => moveGeoAnnotation(store, a, to)}
        onView={onView}
        colorOf={colorOf}
        pending={pending && (pending.kind === 'location' || pending.kind === 'note') ? pending.at : null}
        cards={wb.cards}
        previewOf={previewOf}
        loadMore={loadMore}
        readMoreOf={readMoreOf}
        onDrawProgress={setDrawn}
        onContextMenu={(at, p) => setMapMenu({ ...p, at })}
          onFeatureMenu={openFeatureMenu}
      />
      </div>
      <div className="geo__stage-globe" hidden={!globeActive}>
        <GlobeStage
          ref={wb.globe}
          features={features ?? visiblePlaces}
          allFeatures={features ? undefined : wb.windowed}
          selectedId={selected}
          onSelect={setSelected}
          layer={wb.globeLayer}
          active={globeActive}
          colorOf={colorOf}
          playing={wb.playing}
          mapId={wb.map?.id}
          notes={visibleNotes}
          tool={tool}
          onClick={onClick}
          onDraw={onDraw}
          onMovePlace={(id, to) => {
            const p = store.get(id)
            if (p) store.update(id, { data: { ...p.data, lat: to.lat, lng: to.lng } })
          }}
          onMoveNote={(a, to) => moveGeoAnnotation(store, a, to)}
          pending={pending && (pending.kind === 'location' || pending.kind === 'note') ? pending.at : null}
          cards={wb.cards}
          previewOf={previewOf}
          loadMore={loadMore}
          readMoreOf={readMoreOf}
          onDrawProgress={setDrawn}
          onContextMenu={(at, p) => setMapMenu({ ...p, at })}
          onFeatureMenu={openFeatureMenu}
        />
      </div>
      {tool !== 'browse' && (
        <div className="geo__hud" role="status">
          {tool === 'path' ? (
            <>
              <Route size={14} />
              <span>
                <b>Drawing a path</b> · {drawn === 0 ? 'click the map to start' : drawn === 1 ? '1 point — click to add more' : `${drawn} points — click to add more`}
                <span className="geo__hud-keys">Enter or double-click finishes · Esc cancels</span>
              </span>
              <button className="btn btn--sm btn--primary" disabled={drawn < 2} onClick={() => (globeActive ? wb.globe.current : canvas.current)?.finishDrawing()}>
                <Check size={13} /> Finish
              </button>
            </>
          ) : tool === 'area' ? (
            <>
              <Hexagon size={14} />
              <span>
                <b>Drawing an area</b> · press on the map and drag around it; release to finish
              </span>
            </>
          ) : (
            <>
              {tool === 'note' ? <StickyNote size={14} /> : <MapPin size={14} />}
              <span>
                <b>{tool === 'note' ? 'Pinning a note' : 'Adding a location'}</b> · click the map where it goes
              </span>
            </>
          )}
          <button className="btn btn--sm btn--ghost" onClick={() => ((globeActive ? wb.globe.current : canvas.current)?.cancelDrawing(), wb.setTool('browse'))} title="Stop (Esc)">
            <X size={13} /> Cancel
          </button>
        </div>
      )}
      {mapMenu && <Menu x={mapMenu.x} y={mapMenu.y} items={mapMenuItems(mapMenu.at)} onClose={() => setMapMenu(null)} />}
      {featureMenu && featureEntity && (
        <Menu
          x={featureMenu.x}
          y={featureMenu.y}
          items={entityMenu.items(featureEntity, {
            lead: [{ kind: 'label', label: displayLabel(featureEntity).slice(0, 48) }, ...(featureItems?.(featureEntity) ?? [{ kind: 'item', label: 'Show on map', icon: Crosshair, onSelect: () => wb.jumpTo(featureEntity.id) } as MenuItem])],
            showOpenIn: true,
          })}
          onClose={() => setFeatureMenu(null)}
        />
      )}
      {entityMenu.dialogs}
      {!globeActive && (
      <div className="geo__search">
        <div className="geo__search-box">
          <Search size={13} className="faint" />
          <input
            placeholder={compact ? 'Search…' : 'Search a place, or paste a Google Maps link…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQ('')
                setHits([])
              }
              if (e.key === 'Enter' && parseGoogleMapsUrl(q)) void wb.addFromLink(q).then(() => setQ(''))
              else if (e.key === 'Enter' && hits[0]) pick(hits[0])
            }}
          />
          {q && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => (setQ(''), setHits([]))} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>
        {parseGoogleMapsUrl(q) && (
          <div className="geo__results">
            <button className="geo__result" onClick={() => void wb.addFromLink(q).then(() => setQ(''))}>
              <Link size={12} /> Add this Google Maps location
            </button>
          </div>
        )}
        {hits.length > 0 && (
          <div className="geo__results">
            {hits.map((h, i) => (
              <button key={i} className="geo__result" onClick={() => pick(h)}>
                {h.label}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
      <div className="geo__layers">
        <button
          className={`btn btn--sm btn--icon ${wb.cards ? 'is-on' : ''}`}
          aria-pressed={wb.cards}
          onClick={() => wb.setCards(!wb.cards)}
          title={wb.cards ? 'Cards on: a card opens over a location, path or area under the pointer. Click to stop them.' : 'Cards off: nothing opens over the map on hover. Click to bring them back.'}
        >
          <Info size={13} />
        </button>
        <button className="btn btn--sm btn--icon" title="Fit everything" onClick={wb.fitAll}>
          <Maximize2 size={13} />
        </button>
        <button className="btn btn--sm btn--icon" title="My location" onClick={() => void wb.locate()}>
          <LocateFixed size={13} />
        </button>
        <button className="btn btn--sm" onClick={(e) => setLayersMenu({ x: e.currentTarget.getBoundingClientRect().right - 220, y: e.currentTarget.getBoundingClientRect().bottom + 4 })} title="Base layer">
          <Layers size={13} /> {globeActive && wb.night ? 'Night' : layer === 'streets' ? 'Streets' : layer === 'satellite' ? 'Satellite' : 'Terrain'}
        </button>
      </div>
      {!globeActive && <Coords wb={wb} />}
      {layersMenu && <Menu x={layersMenu.x} y={layersMenu.y} items={layerItems} onClose={() => setLayersMenu(null)} />}
    </div>
  )
}

/**
 * The header's actions, top right like every page: Add location, Add path,
 * Add area (and Pin note on a map). Each is a tool that stays on until the
 * thing is added; pressing it again goes back to browsing.
 */
export function MapAddButtons({ wb, compact = false }: { wb: MapWorkbench; compact?: boolean }) {
  const { tool, setTool } = wb
  const toggle = (t: Tool) => setTool(tool === t ? 'browse' : t)
  const b = (t: Tool, icon: React.ReactNode, label: string, title: string) => (
    <button className={`btn ${compact ? 'btn--sm' : ''} ${tool === t ? 'is-on' : ''}`} aria-pressed={tool === t} title={title} onClick={() => toggle(t)}>
      {icon} {label}
    </button>
  )
  return (
    <>
      {b('location', <MapPin size={14} />, compact ? 'Location' : 'Add location', 'Click the map where the location is')}
      {b('path', <Route size={14} />, compact ? 'Path' : 'Add path', 'Click the map point by point; double-click (or Enter) to finish, Escape to cancel')}
      {b('area', <Hexagon size={14} />, compact ? 'Area' : 'Add area', 'Lasso: press on the map and draw around the area')}
      {wb.map && b('note', <StickyNote size={14} />, compact ? 'Note' : 'Pin note', 'Click the map to pin a note — optionally at a time')}
    </>
  )
}

/** What the current tool wants from the pointer, for a status line. */
export function toolHint(tool: Tool): string {
  return tool === 'location' ? 'Click the map to add a location.' : tool === 'path' ? 'Click point by point; double-click or Enter to finish, Escape to cancel.' : tool === 'area' ? 'Press on the map and draw around the area; release to finish.' : tool === 'note' ? 'Click the map to pin a note.' : ''
}

/** Import and export (fit and locate live on the map itself, by the layer picker). */
export function MapToolbar({ wb, compact = false }: { wb: MapWorkbench; compact?: boolean }) {
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className="tb" role="toolbar" aria-label="Map">
      <button className={`btn ${compact ? 'btn--icon' : ''}`} title="Import KML (Google Earth) or GeoJSON" onClick={() => void wb.importFile()}>
        <Upload size={14} /> {compact ? '' : 'Import'}
      </button>
      <button className={`btn ${compact ? 'btn--icon' : ''}`} title="Export as GeoJSON or KML" onClick={(e) => setExportMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
        <Download size={14} /> {compact ? '' : 'Export'}
      </button>
      {exportMenu && (
        <Menu
          x={exportMenu.x}
          y={exportMenu.y}
          items={[
            { kind: 'item', label: 'GeoJSON (.geojson)', onSelect: () => wb.exportAs('geojson') },
            { kind: 'item', label: 'KML for Google Earth (.kml)', onSelect: () => wb.exportAs('kml') },
          ]}
          onClose={() => setExportMenu(null)}
        />
      )}
    </div>
  )
}

/** Where the map is looking, for a component that shows it: renders that component as the view moves, and nothing else. */
export const useMapView = (wb: MapWorkbench) => useSyncExternalStore(wb.subscribeView, wb.getView)

/** The centre and zoom, bottom left of the flat map; renders on its own as the view moves. */
function Coords({ wb }: { wb: MapWorkbench }) {
  const view = useMapView(wb)
  return (
    <div className="geo__coords">
      {view.center.lat.toFixed(4)}, {view.center.lng.toFixed(4)} · z{Math.round(view.zoom * 10) / 10}
    </div>
  )
}

export { MapTimeline } from './MapTimeline'

/** Places and pinned notes as a list; click to fly there. */
export function MapList({ wb, kind }: { wb: MapWorkbench; kind: 'places' | 'notes' }) {
  const { visiblePlaces, visibleNotes, selected, jumpTo, remove, colorOf, store, onOpenEntity, map } = wb
  const view = useMapView(wb)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const filterPlaces = needle ? visiblePlaces.filter((p) => `${displayLabel(p)} ${p.data.address ?? ''} ${p.tags.join(' ')}`.toLowerCase().includes(needle)) : visiblePlaces
  if (kind === 'places') {
    if (!visiblePlaces.length) return <div className="geo__empty">Nothing here yet — search above, paste a Google Maps link, import KML/GeoJSON, or use Add location / path / area.</div>
    return (
      <>
        {visiblePlaces.length > 8 && (
          <label className="geo__list-search">
            <Search size={12} className="faint" />
            <input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        )}
        {filterPlaces.map((p) => (
          <div key={p.id} className={`geo__item ${selected === p.id ? 'is-selected' : ''}`} onClick={() => jumpTo(p.id)}>
            <span className="geo__item-dot" style={{ background: colorOf(p.tags) ?? (p.type === 'path' ? '#2a6f97' : p.type === 'area' ? '#7b4fa3' : '#e76f51') }} />
            <div className="geo__item-main">
              <div className="geo__item-title">{displayLabel(p)}</div>
              {p.description && <div className="geo__item-desc">{p.description}</div>}
              <div className="geo__item-meta">
                {p.data.address ? `${p.data.address} · ` : ''}
                {typeof p.data.lengthM === 'number' ? `${formatDistance(p.data.lengthM)} long · ` : typeof p.data.areaM2 === 'number' ? `${formatArea(p.data.areaM2)} · ` : ''}
                {formatDistance(distanceM(view.center, { lat: p.data.lat, lng: p.data.lng }))} from centre
                {p.data.at ? ` · ${formatDate(p.data.at)}` : ''}
              </div>
              {p.tags.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  {p.tags.map((t) => (
                    <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
                  ))}
                </div>
              )}
            </div>
            <span style={{ display: 'inline-flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
              {onOpenEntity && (
                <button className="btn btn--sm btn--ghost" title="Details" onClick={() => onOpenEntity(p.id)}>
                  ⋯
                </button>
              )}
              <a className="btn btn--sm btn--icon btn--ghost" href={googleMapsUrl({ lat: p.data.lat, lng: p.data.lng })} target="_blank" rel="noreferrer noopener" title="Open in Google Maps">
                <Link size={12} />
              </a>
              <button className="btn btn--sm btn--icon btn--ghost btn--danger" title={map ? 'Remove from this map' : 'Delete'} onClick={() => remove(p.id)}>
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </>
    )
  }
  if (!visibleNotes.length) return <div className="geo__empty">No pinned notes — choose Pin a note and click the map. A note can be about a moment or a span of time.</div>
  return (
    <>
      {visibleNotes.map((n, i) => (
        <div key={n.annotation.id} className={`geo__item ${selected === n.annotation.id ? 'is-selected' : ''}`} onClick={() => jumpTo(n.annotation.id)}>
          <span className="geo__item-dot" style={{ background: colorOf(n.annotation.tags) ?? '#e9a23b' }}>
            <span style={{ display: 'none' }}>{i + 1}</span>
          </span>
          <div className="geo__item-main">
            <div className="geo__item-title">{n.annotation.data.comment || n.annotation.label}</div>
            <div className="geo__item-meta">
              {n.geo.lat.toFixed(4)}, {n.geo.lng.toFixed(4)}
              {n.geo.radius ? ` ±${formatDistance(n.geo.radius)}` : ''}
              {n.geo.at ? ` · ${new Date(n.geo.at).toLocaleString()}${n.geo.until ? ` – ${new Date(n.geo.until).toLocaleString()}` : ''}` : ''}
            </div>
          </div>
          <span style={{ display: 'inline-flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
            {onOpenEntity && (
              <button className="btn btn--sm btn--ghost" title="Details" onClick={() => onOpenEntity(n.annotation.id)}>
                ⋯
              </button>
            )}
            <button className="btn btn--sm btn--icon btn--ghost btn--danger" title="Delete note" onClick={() => remove(n.annotation.id)}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      ))}
    </>
  )
}

/** The dialog after a click or a drawing: a location (name, address, when), a path or area (name, when), or a pinned note (comment, tags, when, radius). */
export function MapPendingDialog({ wb }: { wb: MapWorkbench }) {
  const { pending, setPending, addPlace, addShape, addNote, toast } = wb
  const [label, setLabel] = useState('')
  const [comment, setComment] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [address, setAddress] = useState<string | undefined>()
  const [at, setAt] = useState('')
  const [until, setUntil] = useState('')
  const [radius, setRadius] = useState('')
  useEffect(() => {
    setLabel('')
    setComment('')
    setDescription('')
    setTags('')
    setAt('')
    setUntil('')
    setRadius('')
    setAddress(undefined)
    if (pending?.kind === 'location') reverseGeocode(pending.at).then((a) => setAddress(a))
  }, [pending])
  if (!pending) return null
  const p = pending.at
  const shape = pending.kind === 'path' || pending.kind === 'area' ? pending.geometry : undefined
  const submit = () => {
    if (pending.kind === 'location') {
      addPlace(p, label.trim() || address || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, { address, at: at ? new Date(at).toISOString() : undefined, tags: parseTags(tags), description: description.trim() || undefined })
      toast('Location added')
    } else if (shape) {
      addShape(shape, label.trim() || (pending.kind === 'path' ? 'Path' : 'Area'), { at: at ? new Date(at).toISOString() : undefined, until: until ? new Date(until).toISOString() : undefined, tags: parseTags(tags), description: description.trim() || undefined })
      toast(pending.kind === 'path' ? 'Path added' : 'Area added')
    } else {
      if (!comment.trim()) return
      addNote(p, comment.trim(), parseTags(tags), at ? new Date(at).toISOString() : undefined, until ? new Date(until).toISOString() : undefined, radius ? Number(radius) : undefined)
      toast('Note pinned')
    }
    setPending(null)
    wb.setTool('browse')
  }
  return (
    <Dialog
      open
      title={pending.kind === 'location' ? 'Add a location' : pending.kind === 'path' ? 'Add a path' : pending.kind === 'area' ? 'Add an area' : 'Pin a note'}
      description={shape ? (shape.type === 'LineString' ? `${shape.coordinates.length} points` : `${shape.type === 'Polygon' ? shape.coordinates[0].length - 1 : 0} points around ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`) : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${address ? ` · ${address}` : ''}`}
      onClose={() => setPending(null)}
      footer={
        <>
          <button className="btn" onClick={() => setPending(null)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={pending.kind === 'note' && !comment.trim()}>
            {pending.kind === 'location' ? 'Add location' : pending.kind === 'path' ? 'Add path' : pending.kind === 'area' ? 'Add area' : 'Pin note'}
          </button>
        </>
      }
    >
      {pending.kind !== 'note' ? (
        <>
          <div className="field">
            <label>Name</label>
            <input className="input" autoFocus value={label} placeholder={pending.kind === 'location' ? (address ?? 'What is here?') : pending.kind === 'path' ? 'Where does it go?' : 'What is this area?'} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          <div className="field">
            <label>
              Description <span className="field__opt">optional</span>
            </label>
            <textarea className="input" rows={2} value={description} placeholder="What is it, why it matters" onChange={(e) => setDescription(e.target.value)} />
          </div>
        </>
      ) : (
        <div className="field">
          <label>Note</label>
          <textarea className="input" autoFocus value={comment} placeholder="What happened here?" onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()} />
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="field">
          <label>
            {pending.kind === 'note' ? 'At' : 'When'} <span className="field__opt">optional</span>
          </label>
          <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        {pending.kind === 'note' || shape ? (
          <div className="field">
            <label>
              Until <span className="field__opt">optional</span>
            </label>
            <input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
        ) : (
          <div className="field">
            <label>
              Tags <span className="field__opt">optional</span>
            </label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="visited, office" />
          </div>
        )}
      </div>
      {(pending.kind === 'note' || shape) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {pending.kind === 'note' ? (
            <div className="field">
              <label>
                Radius (m) <span className="field__opt">optional</span>
              </label>
              <input className="input" type="number" min={0} value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="e.g. 200" />
            </div>
          ) : (
            <span />
          )}
          <div className="field">
            <label>
              Tags <span className="field__opt">optional</span>
            </label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sighting, meeting" />
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 10 }}>
        <a href={googleMapsUrl(p)} target="_blank" rel="noreferrer noopener">
          Open in Google Maps
        </a>
        <a href={googleEarthUrl(p)} target="_blank" rel="noreferrer noopener">
          Google Earth
        </a>
      </div>
    </Dialog>
  )
}

export const mapBounds = boundsOf

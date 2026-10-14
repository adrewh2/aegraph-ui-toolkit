import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { useExternalServices } from '../account/settings'
import type { EntityId } from '../../core/entity/types'
import { GeoCard } from './GeoCard'
import { simplifyCoords, type BaseLayer, type GeoAnnotation, type Geometry, type GeoEntity, type GeoPreview, type LatLng } from './maps'
import { GEO_COLORS } from './mapCard'
import { CLUSTER_PX, cellOf, cellsAt, featureIndex, mercX, mercY, pinIndex, unproject } from './pinIndex'
import { MapPointLayer, type MapLink } from './pointLayer'
import type { PinMode } from './maps'
import './maps.css'
import { cssColor } from '../../lib/cssColor'
import { currentTheme, themeInfo, themeToken, useTheme } from '../../app/theme'

/**
 * The Leaflet map: base layers (OpenStreetMap streets, Esri satellite,
 * OpenTopoMap terrain), location pins, path lines and area polygons,
 * pinned notes, and the interactions the page wires up — click to add,
 * click-by-click to draw a path, lasso to draw an area, drag to move,
 * select. Kept imperative behind a small handle; React owns the data,
 * Leaflet the pixels.
 */

export type MapTool = 'browse' | 'location' | 'note' | 'path' | 'area'

export interface MapCanvasHandle {
  fit: (points: LatLng[]) => void
  flyTo: (p: LatLng, zoom?: number) => void
  center: () => LatLng
  zoom: () => number
  /** The view at once, no animation: what the globe was showing, as the stages switch. */
  setView: (p: LatLng, zoom: number) => void
  /** The stage's size in px. */
  size: () => { x: number; y: number }
  locate: () => Promise<LatLng>
  /** End the path being drawn (needs two points); the drawing-tool HUD's Finish button. */
  finishDrawing: () => void
  /** Drop the drawing in progress. */
  cancelDrawing: () => void
  /** Add a vertex to the path being drawn (starting one if none): "Start a path here" from the map's menu. */
  addPoint: (p: LatLng) => void
}

export interface MapCanvasProps {
  center: LatLng
  zoom: number
  layer: BaseLayer
  /** How locations are drawn: every one a point on the engine's canvas, or pins that bubble up when they pile. */
  pins: PinMode
  /** Relationships among the features, by index, for the points to draw as edges (none when the list is a subset). */
  links?: MapLink[]
  features: GeoEntity[]
  notes: GeoAnnotation[]
  selectedId: EntityId | null
  /** What the pointer does on empty map: browse, hand back a point (location, note), or draw (path: click, click…, double-click; area: lasso drag). */
  tool: MapTool
  onSelect: (id: EntityId | null) => void
  onClick: (p: LatLng) => void
  /** A finished drawing: a LineString (path) or a Polygon (area). */
  onDraw: (g: Geometry) => void
  onMovePlace: (id: EntityId, to: LatLng) => void
  onMoveNote: (a: GeoAnnotation, to: LatLng) => void
  onView: (center: LatLng, zoom: number) => void
  colorOf?: (tags: string[]) => string | undefined
  /** A pending point (drawn while a dialog is open). */
  pending?: LatLng | null
  /** Whether the cards behind pins, paths and areas open at all (default true). Off, the map is only the map. */
  cards?: boolean
  /** Pictures and link counts for a feature's hover card; without it the card is text only. */
  previewOf?: (e: GeoEntity) => GeoPreview | undefined
  /** More pictures for the card, fetched when it opens. */
  loadMore?: (e: GeoEntity) => Promise<string[]>
  /** Where the card's "read more" goes. */
  readMoreOf?: (e: GeoEntity) => { href: string; label: string }
  /** How many points the path being drawn has (0 when none), for the drawing HUD. */
  onDrawProgress?: (points: number) => void
  /** Right-click on the map: where, and the screen point to open a menu at. */
  onContextMenu?: (p: LatLng, at: { x: number; y: number }) => void
  /** Right-click on a feature — a point, a pin, a path, an area, a note: which, and where to open its menu. */
  onFeatureMenu?: (id: EntityId, at: { x: number; y: number }) => void
}

const LAYERS: Record<BaseLayer, { url: string; attribution: string; maxZoom: number }> = {
  streets: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
  terrain: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors, SRTM · &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17 },
}

// The type colours (maps.ts): coral, cerulean, plum, amber — saturated enough to read over pale tiles (a sage line
// vanishes on a park), warm enough for the theme. Every line is drawn over a casing in the page's surface (white on
// Paper) so it reads on any tile; the selected one over a casing in ink — Paper's near-black, a dark theme's text.
const { location: PLACE_COLOR, path: PATH_COLOR, area: AREA_COLOR, note: NOTE_COLOR } = GEO_COLORS
type Casing = { color: string; opacity: number }
const casings = (): { plain: Casing; selected: Casing } => ({
  plain: { color: themeToken('--surface', '#ffffff'), opacity: 0.9 },
  selected: { color: themeInfo(currentTheme()).scheme === 'dark' ? themeToken('--text', '#ecebe6') : '#111111', opacity: 0.85 },
})
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
/** A single pin's footprint on screen, for deciding whether two touch. */
const PIN_PX = 26
/** How many of a bubble's members its ring is tallied from, at most. */
const TALLY_SAMPLE = 2000

const clusterSize = (n: number) => Math.round(Math.min(56, 28 + 6 * Math.log2(n)))

/** A cluster: the count, in a bubble sized by it, ringed by the colours of what it holds (their share of the ring). */
const clusterIcon = (counts: Map<string, number>, n: number, sampled = n) => {
  const size = clusterSize(n)
  let acc = 0
  const stops = [...counts.entries()].map(([c, k]) => {
    const from = (acc / sampled) * 100
    acc += k
    return `${cssColor(c, '#888')} ${from}% ${(acc / sampled) * 100}%`
  })
  return L.divIcon({
    className: 'geo-cluster',
    html: `<span class="geo-cluster__ring" style="width:${size}px;height:${size}px;background:conic-gradient(${stops.join(', ')})"><span class="geo-cluster__count">${n}</span></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}
/** A shape being drawn: dashed, in the page's ink. Read when a drawing starts, so it is the theme's at the time. */
const drawStyle = () => ({ color: themeToken('--text', '#1f1e1b'), weight: 2, dashArray: '6 4', fillOpacity: 0.08 })

/** A path's or an area's two layers: the casing under it and the shape itself, styled for selected / dimmed. */
function shapeLayers(latlngs: [number, number][], kind: 'path' | 'area', color: string, sel: boolean, dimmed: boolean, cs: { plain: Casing; selected: Casing }): [L.Layer, L.Layer] {
  const w = kind === 'path' ? (sel ? 7 : 3) : sel ? 4 : 2
  const opacity = dimmed ? 0.3 : 1
  const casing = kind === 'path' ? L.polyline(latlngs, { ...(sel ? cs.selected : cs.plain), weight: w + 4, opacity: dimmed ? 0.25 : sel ? 0.85 : cs.plain.opacity, interactive: false }) : L.polygon(latlngs, { ...(sel ? cs.selected : cs.plain), weight: w + 3, fill: false, opacity: dimmed ? 0.25 : sel ? 0.85 : cs.plain.opacity, interactive: false })
  const shape = kind === 'path' ? L.polyline(latlngs, { color, weight: w, opacity }) : L.polygon(latlngs, { color, weight: w, opacity, fillColor: color, fillOpacity: sel ? 0.35 : dimmed ? 0.08 : 0.2 })
  return [casing, shape]
}

/** What the hover label says of a feature: its name, and its time when it has one. */
const labelOf = (p: GeoEntity) => `${p.label ?? p.id}${p.data.at ? ` · ${new Date(p.data.at).toLocaleString()}` : ''}`

/**
 * A pin. Leaflet takes it as markup, and the colour is data (a tag's, a type's): it is checked again here, at the
 * sink, so a colour that is not one never reaches the string (`lib/cssColor`; a shared icon element is not an option,
 * since Leaflet moves an element given to it rather than copying it).
 */
const pin = (raw: string, selected: boolean, kind: 'place' | 'note', n?: number) => {
  const color = cssColor(raw, '#888')
  return L.divIcon({
    className: `geo-pin geo-pin--${kind} ${selected ? 'is-selected' : ''}`,
    // One element per pin (the stem the style hides is not made): fewer nodes for the browser to lay out by the hundred.
    html: kind === 'place' ? `<span class="geo-pin__dot" style="background:${color}"></span>` : `<span class="geo-pin__note" style="background:${color}">${typeof n === 'number' ? n : ''}</span>`,
    iconSize: kind === 'place' ? [18, 26] : [22, 22],
    iconAnchor: kind === 'place' ? [9, 26] : [11, 11],
  })
}

/**
 * A right-click on a feature layer (a pin, a path, an area, a note): its entity's menu, not the map's — the event goes
 * no further, so the map's own menu does not open under it. With no feature menu wired, the map's menu as before.
 */
function featureMenuOn(e: L.LeafletMouseEvent, id: EntityId, open: ((id: EntityId, at: { x: number; y: number }) => void) | undefined): boolean {
  if (!open) return false
  L.DomEvent.stop(e)
  open(id, { x: e.originalEvent.clientX, y: e.originalEvent.clientY })
  return true
}

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas({ center, zoom, layer, pins, links, features, notes, selectedId, tool, onSelect, onClick, onDraw, onMovePlace, onMoveNote, onView, colorOf, pending, cards = true, previewOf, loadMore, readMoreOf, onDrawProgress, onContextMenu, onFeatureMenu }, ref) {
  const host = useRef<HTMLDivElement>(null)
  // Shapes' casings are drawn in the theme's colours: a theme change draws them again.
  const theme = useTheme()
  /** Offline mode draws the places on plain ground: no tiles are fetched (`account/settings.ts`). */
  const external = useExternalServices()
  const map = useRef<L.Map | null>(null)
  const tiles = useRef<L.TileLayer | null>(null)
  const layerGroup = useRef<L.LayerGroup | null>(null)
  /** What is drawn, by a key that says all a marker depends on: a redraw keeps the layers whose key it makes again and only builds the rest. */
  const kept = useRef(new Map<string, L.Layer[]>())
  const pendingMarker = useRef<L.Marker | null>(null)
  const cb = useRef({ onSelect, onClick, onDraw, onMovePlace, onMoveNote, onView, tool, onDrawProgress, onContextMenu, onFeatureMenu, cards, features })
  cb.current = { onSelect, onClick, onDraw, onMovePlace, onMoveNote, onView, tool, onDrawProgress, onContextMenu, onFeatureMenu, cards, features }
  /** The engine's canvas of points, when locations are drawn that way (pointLayer.ts); made on first need, kept until the mode changes. */
  const points = useRef<MapPointLayer | null>(null)
  /** The features list and links the point layer holds. */
  const pointsFor = useRef<{ features: GeoEntity[]; links: MapLink[] | undefined } | null>(null)
  /** A point being dragged: its feature index. */
  const pointDrag = useRef<number | null>(null)
  /** Whether the pointer was over a point at the last move (so leaving one releases the card once). */
  const pointHover = useRef(false)
  /** Bumped on zoom, so shapes can decide whether they are too small on screen to be seen without a pin. */
  const [zoomTick, setZoomTick] = useState(0)
  /** The bounds the pins were last drawn for (the view padded by a screen each way), or null when everything was. */
  const drawn = useRef<L.LatLngBounds | null>(null)
  /** Bumped while the map moves, so an open card follows its pin. */
  const [viewTick, setViewTick] = useState(0)
  /**
   * The card that is open: for which feature and where it points (a pin's point, or where the pointer met a shape).
   * It closes a moment after the pointer has left both the feature and the card, so the card can be used.
   */
  const [card, setCard] = useState<{ id: EntityId; at: L.LatLng; kind: string } | null>(null)
  /** The name of what the pointer is over, shown bottom left while the cards are off (as the globe shows it). */
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  // Read by the map's move handler: the card follows the map, so a move re-renders only while one is open.
  const cardOpen = useRef(false)
  cardOpen.current = card !== null
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const openCard = (id: EntityId, at: L.LatLng, kind: string) => {
    if (cb.current.tool !== 'browse' || cb.current.cards === false) return
    clearTimeout(closeTimer.current)
    setCard((c) => (c?.id === id ? c : { id, at, kind }))
  }
  const holdCard = () => clearTimeout(closeTimer.current)
  const releaseCard = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setCard(null), 350)
  }
  const featureMenu = (e: L.LeafletMouseEvent, id: EntityId) => featureMenuOn(e, id, cb.current.onFeatureMenu)
  const closeCard = () => {
    clearTimeout(closeTimer.current)
    setCard(null)
  }
  // Turning the cards off with one open takes it away at once, rather than leaving the last one on the map.
  useEffect(() => {
    if (!cards) closeCard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards])
  /** The drawing in progress: a path's vertices (click by click) or a lasso's samples (while the button is down). */
  const draw = useRef<{ kind: 'path' | 'area'; points: L.LatLng[]; shape: L.Polyline | L.Polygon; vertices: L.LayerGroup; lassoing: boolean } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el || map.current) return
    // The wheel and a trackpad zoom by how far they moved, at once — as the globe does — rather than by whole
    // levels in quarter-second animations (a burst of ticks queued a stack of them, and Leaflet's own handler
    // sat out most of a burst). Zoom is fractional; the buttons still step by one, animated. The point layer
    // follows any zoom, and the tiles scale between levels until the next level's arrive.
    const m = L.map(el, { center: [center.lat, center.lng], zoom, zoomControl: false, attributionControl: true, zoomSnap: 0, zoomDelta: 1, scrollWheelZoom: false })
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // A mouse notch is ~100 px, a trackpad a stream of small ones; a pinch comes as a wheel with ctrl held.
      const px = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      const dz = Math.max(-1, Math.min(1, -px / (e.ctrlKey ? 100 : 250)))
      if (dz) m.setZoomAround(m.mouseEventToContainerPoint(e), m.getZoom() + dz, { animate: false })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    L.control.zoom({ position: 'bottomright' }).addTo(m)
    layerGroup.current = L.layerGroup().addTo(m)
    m.on('click', (e) => {
      const t = cb.current.tool
      // A click on a point (the engine's canvas takes no events of its own): that location is selected.
      const hit = t === 'browse' && points.current ? points.current.pick(e.containerPoint) : -1
      if (hit >= 0) {
        cb.current.onSelect(cb.current.features[hit].id)
        return
      }
      closeCard()
      if (t === 'browse') cb.current.onSelect(null)
      else if (t === 'path') addVertex(m, e.latlng)
      else if (t !== 'area') cb.current.onClick({ lat: e.latlng.lat, lng: e.latlng.lng })
    })
    // Right-click: on a point, that entity's menu; on empty map, the map's (Leaflet already suppresses the browser's).
    // Pins, paths, areas and notes are layers of their own and answer before this (`featureMenu` below).
    m.on('contextmenu', (e) => {
      if (draw.current) return
      const hit = cb.current.tool === 'browse' && points.current ? points.current.pick(e.containerPoint) : -1
      if (hit >= 0 && cb.current.onFeatureMenu) {
        cb.current.onFeatureMenu(cb.current.features[hit].id, { x: e.originalEvent.clientX, y: e.originalEvent.clientY })
        return
      }
      cb.current.onContextMenu?.({ lat: e.latlng.lat, lng: e.latlng.lng }, { x: e.originalEvent.clientX, y: e.originalEvent.clientY })
    })
    // A path: the last click is a double-click, which also finishes it.
    m.on('dblclick', (e) => {
      if (cb.current.tool !== 'path' || !draw.current) return
      L.DomEvent.stop(e)
      finishDrawing(m)
    })
    // A press on a point drags it (the map's own drag waits until the button is up), as a pin's drag does.
    m.on('mousedown', (e) => {
      if (cb.current.tool !== 'browse' || !points.current || e.originalEvent.button !== 0) return
      const hit = points.current.pick(e.containerPoint)
      if (hit < 0) return
      L.DomEvent.stop(e)
      closeCard()
      m.dragging.disable()
      pointDrag.current = hit
      // On the document, not the map: the pointer may leave the map before the button comes up.
      const move = (ev: MouseEvent) => points.current?.setPlace(hit, m.mouseEventToLatLng(ev))
      const up = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        m.dragging.enable()
        pointDrag.current = null
        const at = m.mouseEventToLatLng(ev)
        const p = cb.current.features[hit]
        if (p && (at.lat !== p.data.lat || at.lng !== p.data.lng)) cb.current.onMovePlace(p.id, { lat: at.lat, lng: at.lng })
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
    // A lasso: press, drag around the area, release.
    m.on('mousedown', (e) => {
      if (cb.current.tool !== 'area') return
      L.DomEvent.stop(e)
      m.dragging.disable()
      draw.current = { kind: 'area', points: [e.latlng], shape: L.polygon([e.latlng], drawStyle()).addTo(m), vertices: L.layerGroup(), lassoing: true }
    })
    m.on('mousemove', (e) => {
      const pl = points.current
      if (pl) {
        if (pointDrag.current !== null) return
        // Hover over a point: the engine marks it, and the card opens as it does over a pin.
        const hit = cb.current.tool === 'browse' ? pl.pick(e.containerPoint) : -1
        pl.setHovered(hit)
        el.classList.toggle('geo-points-hover', hit >= 0)
        if (hit >= 0) {
          const p = cb.current.features[hit]
          openCard(p.id, L.latLng(p.data.lat, p.data.lng), 'Location')
          setHoverLabel(labelOf(p))
        } else if (pointHover.current) {
          releaseCard()
          setHoverLabel(null)
        }
        pointHover.current = hit >= 0
      }
      const d = draw.current
      if (d?.kind === 'area' && d.lassoing) {
        d.points.push(e.latlng)
        ;(d.shape as L.Polygon).setLatLngs(d.points)
      } else if (d?.kind === 'path' && d.points.length) {
        // A rubber band from the last vertex to the pointer.
        ;(d.shape as L.Polyline).setLatLngs([...d.points, e.latlng])
      }
    })
    const endLasso = () => {
      const d = draw.current
      if (d?.kind !== 'area' || !d.lassoing) return
      d.lassoing = false
      m.dragging.enable()
      finishDrawing(m)
    }
    m.on('mouseup', endLasso)
    m.getContainer().addEventListener('mouseleave', endLasso)
    m.on('moveend zoomend', () => {
      const c = m.getCenter()
      cb.current.onView({ lat: c.lat, lng: c.lng }, m.getZoom())
    })
    m.on('zoomend', () => setZoomTick((t) => t + 1))
    // Pins are drawn for the view and a margin around it; a pan that leaves that margin redraws.
    m.on('moveend', () => drawn.current && !drawn.current.contains(m.getBounds()) && setZoomTick((t) => t + 1))
    m.on('move', () => cardOpen.current && setViewTick((t) => t + 1))
    map.current = m
    // Leaflet measures its container once; a pane that appears later needs a nudge.
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      points.current?.destroy()
      points.current = null
      pointsFor.current = null
      m.remove()
      map.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Base layer. Offline (Third-party services off in the account settings) there is none: the pins, paths and
  // areas — the data — are drawn on plain ground, and the note below the map says why.
  useEffect(() => {
    const m = map.current
    if (!m) return
    tiles.current?.remove()
    tiles.current = null
    if (!external) return
    const def = LAYERS[layer]
    // Drawn maps take the theme's tile filter (maps.css › .geo-tiles); a photograph is shown as it was taken.
    const t = L.tileLayer(def.url, { attribution: def.attribution, maxZoom: def.maxZoom, className: layer === 'satellite' ? '' : 'geo-tiles' }).addTo(m)
    // A zoom set at once (the wheel, a stage switch) goes through Leaflet's view reset, on which a tile layer
    // throws every tile away and makes them again, fading in from nothing — a white flash on every wheel tick,
    // even one that stays on the same tile level. Without that one listener the reset is handled as the end of a
    // zoom animation is: the level's tiles stay, another level's are kept until the new ones have loaded.
    m.off('viewprereset', (t as unknown as { _invalidateAll: () => void })._invalidateAll, t)
    tiles.current = t
  }, [layer, external])

  // Cursor by tool; leaving a drawing tool drops an unfinished drawing. Escape does too.
  useEffect(() => {
    const el = host.current
    const m = map.current
    el?.classList.toggle('is-placing', tool !== 'browse')
    el?.classList.toggle('is-drawing', tool === 'path' || tool === 'area')
    if (m && tool !== 'path' && tool !== 'area') cancelDrawing(m)
    if (m) {
      if (tool === 'path' || tool === 'area') m.doubleClickZoom.disable()
      else m.doubleClickZoom.enable()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!m) return
      if (e.key === 'Escape') {
        cancelDrawing(m)
        closeCard()
      }
      if (e.key === 'Enter' && draw.current?.kind === 'path') finishDrawing(m)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool])

  function addVertex(m: L.Map, at: L.LatLng) {
    let cur = draw.current
    if (cur?.kind === 'path') {
      cur.points.push(at)
      ;(cur.shape as L.Polyline).setLatLngs(cur.points)
    } else cur = draw.current = { kind: 'path', points: [at], shape: L.polyline([at], drawStyle()).addTo(m), vertices: L.layerGroup().addTo(m), lassoing: false }
    // Each vertex is marked, so the path reads as points joined rather than a stray line.
    cur.vertices.addLayer(L.circleMarker(at, { radius: 5, color: themeToken('--surface', '#ffffff'), weight: 2, fillColor: themeToken('--text', '#1f1e1b'), fillOpacity: 1, interactive: false }))
    cb.current.onDrawProgress?.(cur.points.length)
  }
  function cancelDrawing(m: L.Map) {
    const d = draw.current
    if (!d) return
    d.shape.remove()
    d.vertices.remove()
    draw.current = null
    m.dragging.enable()
    cb.current.onDrawProgress?.(0)
  }
  /** Hand the drawing back as GeoJSON-style coordinates ([lng, lat]); a lasso is thinned to what describes it at this zoom. */
  function finishDrawing(m: L.Map) {
    const d = draw.current
    if (!d) return
    // A path needs two points: a single one stays on screen until the second click, and Finish does nothing yet.
    if (d.kind === 'path' && d.points.length < 2) return
    d.shape.remove()
    d.vertices.remove()
    draw.current = null
    m.dragging.enable()
    cb.current.onDrawProgress?.(0)
    // The double-click that ends a path also clicked twice: consecutive repeats go.
    let cs = d.points.map((p) => [p.lng, p.lat] as [number, number]).filter((c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1])
    if (d.kind === 'area') {
      // About 3 screen pixels at the current zoom.
      const px = m.containerPointToLatLng([0, 0])
      const px3 = m.containerPointToLatLng([3, 0])
      cs = simplifyCoords(cs, Math.abs(px3.lng - px.lng))
    }
    if ((d.kind === 'path' && cs.length < 2) || (d.kind === 'area' && cs.length < 3)) return
    cb.current.onDraw(d.kind === 'path' ? { type: 'LineString', coordinates: cs } : { type: 'Polygon', coordinates: [[...cs, cs[0]]] })
  }

  // Locations, paths, areas, notes.
  useEffect(() => {
    const g = layerGroup.current
    const m = map.current
    if (!g || !m) return
    const zoom = m.getZoom()
    const ix = pinIndex(features, colorOf, PLACE_COLOR)
    host.current?.classList.toggle('has-selection', selectedId !== null)
    // Markers are kept between redraws by key — a pin's feature, colour and state; a bubble's zoom, members and place —
    // so a selection, a card or a pan that leaves the margin rebuilds only what changed, not five hundred elements.
    const prev = kept.current
    const next = new Map<string, L.Layer[]>()
    const keep = (key: string, make: () => L.Layer[]) => {
      let layers = prev.get(key)
      if (layers) prev.delete(key)
      else {
        layers = make()
        for (const l of layers) g.addLayer(l)
      }
      next.set(key, layers)
    }
    // The selected shape goes on last, above everything else drawn.
    const selectedShapes: L.Layer[] = []
    // A bubble in the making: the feature indices it holds, its centre in Mercator pixels at this zoom, and the
    // cell it is filed under for finding neighbours.
    type Group = { members: ArrayLike<number>; x: number; y: number; kind: 'location' | 'path' | 'area' }
    const groups: Group[] = []
    const selectedIdx = selectedId === null ? -1 : featureIndex(ix, features, selectedId)
    const cs = casings()

    // Pass one: shapes. A path or an area is drawn as itself; one too small on screen to be seen joins the pins.
    for (let k = 0; k < ix.shapes.length; k++) {
      const p = features[ix.shapes[k]]
      const sel = selectedId === p.id
      const geo = p.data.geometry as Exclude<Geometry, { type: 'Point' }>
      const kind = geo.type === 'LineString' ? 'path' : 'area'
      const color = colorOf?.(p.tags) ?? (kind === 'path' ? PATH_COLOR : AREA_COLOR)
      const latlngs = (geo.type === 'LineString' ? geo.coordinates : geo.coordinates[0]).map(([lng, lat]) => [lat, lng] as [number, number])
      const px = latlngs.map(([lat, lng]) => m.latLngToLayerPoint([lat, lng]))
      const size = Math.max(Math.max(...px.map((q) => q.x)) - Math.min(...px.map((q) => q.x)), Math.max(...px.map((q) => q.y)) - Math.min(...px.map((q) => q.y)))
      if (size < 36) groups.push({ members: [ix.shapes[k]], x: mercX(p.data.lng, zoom), y: mercY(p.data.lat, zoom), kind })
      // The selected shape is drawn thick over a dark casing and the rest fade back, so it can be told apart
      // among thousands of others; nothing selected, every shape is drawn plainly. The selected one goes on last,
      // above everything else, so it is made afresh each time it is selected.
      const dimmed = selectedId !== null && !sel
      const wire = (shape: L.Layer) => {
        shape.on('click', (e) => (L.DomEvent.stopPropagation(e), cb.current.onSelect(p.id)))
        shape.on('contextmenu', (e) => featureMenu(e as L.LeafletMouseEvent, p.id))
        shape.on('mouseover', (e) => (openCard(p.id, (e as L.LeafletMouseEvent).latlng, kind === 'path' ? 'Path' : 'Area'), setHoverLabel(labelOf(p))))
        shape.on('mouseout', () => (releaseCard(), setHoverLabel(null)))
        return shape
      }
      if (sel) {
        const [casing, shape] = shapeLayers(latlngs, kind, color, true, false, cs)
        selectedShapes.push(casing, wire(shape))
        continue
      }
      keep(`s:${ix.shapes[k]}:${color}:${dimmed}:${theme}`, () => {
        const [casing, shape] = shapeLayers(latlngs, kind, color, false, dimmed, cs)
        // A faded shape goes without its casing: thousands of pale casings would wash the map out.
        return dimmed ? [wire(shape)] : [casing, wire(shape)]
      })
    }

    if (pins === 'points') {
      // Every location a point on the engine's canvas (pointLayer.ts): the layer holds the whole list once and is
      // told only what changed — the list, the selection — while Leaflet's moves reach it directly.
      const pl = (points.current ??= new MapPointLayer(m))
      if (pointsFor.current?.features !== features || pointsFor.current.links !== links) {
        pl.load(ix, links)
        pointsFor.current = { features, links }
      }
      pl.setSelected(selectedIdx)
      drawn.current = null
    } else {
      if (points.current) {
        points.current.destroy()
        points.current = null
        pointsFor.current = null
      }
      // Pass two: the points, as this zoom's cells — every non-empty cell of CLUSTER_PX inside the view (plus a
      // screen's margin each way when there are many: markers off screen cost as much as the ones on it, and a pan
      // that leaves the margin redraws) is one bubble to begin with. The selected point always stays its own pin.
      const cull = ix.order.length > 5000 ? m.getBounds().pad(1) : null
      drawn.current = cull
      const box = cull ? { minX: mercX(cull.getWest(), zoom) - CLUSTER_PX, maxX: mercX(cull.getEast(), zoom) + CLUSTER_PX, minY: mercY(cull.getNorth(), zoom) - CLUSTER_PX, maxY: mercY(cull.getSouth(), zoom) + CLUSTER_PX } : undefined
      const selectedCell = selectedIdx >= 0 ? cellOf(ix, zoom, selectedIdx) : null
      for (const cell of cellsAt(ix, zoom, box)) {
        const members: ArrayLike<number> = ix.order.subarray(cell.start, cell.end)
        if (selectedCell && cell.col === selectedCell[0] && cell.row === selectedCell[1]) {
          // The selected point leaves its cell and stands alone; the cell's centre is recomputed without it.
          const rest = Array.from(members).filter((i) => i !== selectedIdx)
          groups.push({ members: [selectedIdx], x: mercX(ix.coords[2 * selectedIdx + 1], zoom), y: mercY(ix.coords[2 * selectedIdx], zoom), kind: 'location' })
          if (!rest.length) continue
          let sx = 0
          let sy = 0
          for (const i of rest) {
            sx += mercX(ix.coords[2 * i + 1], zoom)
            sy += mercY(ix.coords[2 * i], zoom)
          }
          groups.push({ members: rest, x: sx / rest.length, y: sy / rest.length, kind: 'location' })
          continue
        }
        groups.push({ members, x: cell.x, y: cell.y, kind: 'location' })
      }

      // Bubbles that would still touch merge, until nothing does — a single pin included, and a small shape's pin
      // among them. Bubbles are at most 56px across, so only bubbles in the same or a neighbouring MERGE_PX cell can
      // touch: each pass is one look at the neighbours per bubble, not every pair.
      const footprint = (gr: Group) => (gr.members.length === 1 ? PIN_PX : clusterSize(gr.members.length))
      const pinned = (gr: Group) => gr.members.length === 1 && gr.members[0] === selectedIdx
      const MERGE_PX = 64
      const mergeCols = Math.ceil((256 * 2 ** zoom) / MERGE_PX) + 1
      let live = groups
      for (let merged = true; merged; ) {
        merged = false
        const cells = new Map<number, Group[]>()
        for (const gr of live) {
          const k = Math.floor(gr.y / MERGE_PX) * mergeCols + Math.floor(gr.x / MERGE_PX)
          const bucket = cells.get(k)
          if (bucket) bucket.push(gr)
          else cells.set(k, [gr])
        }
        for (const a of live) {
          if (!a.members.length || pinned(a)) continue
          const cx = Math.floor(a.x / MERGE_PX)
          const cy = Math.floor(a.y / MERGE_PX)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const bucket = cells.get((cy + dy) * mergeCols + cx + dx)
              if (!bucket) continue
              for (const b of bucket) {
                if (b === a || !b.members.length || pinned(b)) continue
                if (Math.hypot(a.x - b.x, a.y - b.y) < (footprint(a) + footprint(b)) / 2 + 4) {
                  const n = a.members.length + b.members.length
                  a.x = (a.x * a.members.length + b.x * b.members.length) / n
                  a.y = (a.y * a.members.length + b.y * b.members.length) / n
                  const joined = new Array<number>(n)
                  for (let i = 0; i < a.members.length; i++) joined[i] = a.members[i]
                  for (let i = 0; i < b.members.length; i++) joined[a.members.length + i] = b.members[i]
                  a.members = joined
                  b.members = []
                  merged = true
                }
              }
            }
        }
        if (merged) live = live.filter((gr) => gr.members.length)
      }

      // Pass three: markers. A bubble's ring is the colours of what it holds, tallied from the index.
      for (const gr of live) {
        if (gr.members.length === 1) {
          const p = features[gr.members[0]]
          const kind = gr.kind
          const sel = selectedId === p.id
          const color = kind === 'location' ? ix.palette[ix.colorIdx[gr.members[0]]] : (colorOf?.(p.tags) ?? (kind === 'path' ? PATH_COLOR : AREA_COLOR))
          const draggable = kind === 'location'
          const kindLabel = kind === 'location' ? 'Location' : kind === 'path' ? 'Path' : 'Area'
          // Not dimmed here: with something selected the map's own class fades every unselected pin, so a selection
          // remakes the pin it picks and the one it leaves, not every pin on screen.
          keep(`p:${gr.members[0]}:${color}:${sel}:${p.data.lat}:${p.data.lng}`, () => {
            const mk = L.marker([p.data.lat, p.data.lng], { icon: pin(color, sel, 'place'), draggable, title: p.label ?? '', zIndexOffset: sel ? 900 : kind === 'location' ? 0 : 100 })
            mk.on('click', (e) => (L.DomEvent.stopPropagation(e), cb.current.onSelect(p.id)))
            mk.on('contextmenu', (e) => featureMenu(e as L.LeafletMouseEvent, p.id))
            if (draggable)
              mk.on('dragend', () => {
                const ll = mk.getLatLng()
                cb.current.onMovePlace(p.id, { lat: ll.lat, lng: ll.lng })
              })
            // The card opens above the pin; once it is on screen and its height is known, it flips below when it would
            // be cut off by the map's top edge (and there is more room below), and slides sideways to stay within the
            // map, with the arrow kept on the pin.
            mk.on('mouseover', () => (openCard(p.id, mk.getLatLng(), kindLabel), setHoverLabel(labelOf(p))))
            mk.on('mouseout', () => (releaseCard(), setHoverLabel(null)))
            mk.on('dragstart', closeCard)
            return [mk]
          })
          continue
        }
        const members = gr.members
        const n = members.length
        // The ring's colours, from the index alone — and for a bubble holding a hundred thousand points, from every
        // k-th of them: the ring reads the same, and walking each member was the last thing a redraw spent on. The
        // bubble's place is the group's centre, projected back.
        const counts = new Uint32Array(ix.palette.length)
        let shapeColors: Map<string, number> | undefined
        const stride = Math.max(1, Math.floor(n / TALLY_SAMPLE))
        let sampled = 0
        for (let i = 0; i < n; i += stride) {
          const f = members[i]
          sampled++
          if (ix.coords[2 * f] === ix.coords[2 * f]) counts[ix.colorIdx[f]]++
          else {
            const p = features[f]
            const c = colorOf?.(p.tags) ?? (p.data.geometry?.type === 'LineString' ? PATH_COLOR : AREA_COLOR)
            shapeColors ??= new Map()
            shapeColors.set(c, (shapeColors.get(c) ?? 0) + 1)
          }
        }
        const tally = new Map<string, number>()
        for (let c = 0; c < counts.length; c++) if (counts[c]) tally.set(ix.palette[c], (tally.get(ix.palette[c]) ?? 0) + counts[c])
        if (shapeColors) for (const [c, k] of shapeColors) tally.set(c, (tally.get(c) ?? 0) + k)
        const at = unproject(gr.x, gr.y, zoom)
        keep(`b:${zoom}:${members[0]}:${n}:${Math.round(gr.x)}:${Math.round(gr.y)}`, () => {
        const mk = L.marker(at, { icon: clusterIcon(tally, n, sampled), zIndexOffset: 200 })
        const names: string[] = []
        for (let i = 0; i < Math.min(6, n); i++) names.push(features[members[i]].label ?? 'location')
        mk.bindTooltip(esc(`${n} here: ${names.join(', ')}${n > 6 ? ', …' : ''}`), { direction: 'top', offset: [0, -18] })
        mk.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          let s = 90
          let no = -90
          let w = 180
          let e_ = -180
          for (let i = 0; i < n; i++) {
            const f = members[i]
            const la = ix.coords[2 * f] === ix.coords[2 * f] ? ix.coords[2 * f] : features[f].data.lat
            const ln = ix.coords[2 * f] === ix.coords[2 * f] ? ix.coords[2 * f + 1] : features[f].data.lng
            if (la < s) s = la
            if (la > no) no = la
            if (ln < w) w = ln
            if (ln > e_) e_ = ln
          }
          const b = L.latLngBounds([s, w], [no, e_])
          // Members at one spot cannot be spread by zooming: go two levels in and let them be.
          if (b.getNorthEast().equals(b.getSouthWest())) m.setView(b.getCenter(), Math.min(m.getZoom() + 2, 19))
          else m.fitBounds(b, { padding: [60, 60], maxZoom: 18 })
        })
        return [mk]
        })
      }
    }
    // Whatever the last redraw made and this one did not ask for again goes; the selected shape goes on last.
    for (const layers of prev.values()) for (const l of layers) g.removeLayer(l)
    kept.current = next
    for (const l of selectedShapes) g.addLayer(l)
    next.set('selected-shapes', selectedShapes)
    notes.forEach((a, i) => {
      const color = colorOf?.(a.annotation.tags) ?? NOTE_COLOR
      const sel = selectedId === a.annotation.id
      keep(`n:${a.annotation.id}:${i}:${color}:${sel}:${a.geo.lat}:${a.geo.lng}:${a.geo.radius ?? ''}:${a.geo.at ?? ''}:${a.annotation.data.comment ?? ''}`, () => {
        const layers: L.Layer[] = []
        if (a.geo.radius) layers.push(L.circle([a.geo.lat, a.geo.lng], { radius: a.geo.radius, color, weight: 1, fillOpacity: 0.12, interactive: false }))
        const mk = L.marker([a.geo.lat, a.geo.lng], { icon: pin(color, sel, 'note', i + 1), draggable: true, zIndexOffset: 500 })
        mk.on('click', (e) => (L.DomEvent.stopPropagation(e), cb.current.onSelect(a.annotation.id)))
        mk.on('contextmenu', (e) => featureMenu(e as L.LeafletMouseEvent, a.annotation.id))
        mk.on('dragend', () => {
          const ll = mk.getLatLng()
          cb.current.onMoveNote(a, { lat: ll.lat, lng: ll.lng })
        })
        const when = a.geo.at ? ` · ${new Date(a.geo.at).toLocaleString()}` : ''
        mk.bindTooltip(esc(`${a.annotation.data.comment || a.annotation.label || 'Note'}${when}`), { direction: 'top', offset: [0, -14] })
        layers.push(mk)
        return layers
      })
    })
  }, [features, notes, selectedId, colorOf, zoomTick, pins, links, theme])

  // Pending point while a dialog is open.
  useEffect(() => {
    const m = map.current
    if (!m) return
    pendingMarker.current?.remove()
    pendingMarker.current = null
    if (pending) pendingMarker.current = L.marker([pending.lat, pending.lng], { icon: pin(NOTE_COLOR, true, 'note', undefined), interactive: false, zIndexOffset: 1000 }).addTo(m)
  }, [pending])

  useImperativeHandle(ref, () => ({
    fit: (points) => {
      const m = map.current
      if (!m || !points.length) return
      if (points.length === 1) m.setView([points[0].lat, points[0].lng], Math.max(m.getZoom(), 14))
      else m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40], maxZoom: 16 })
    },
    flyTo: (p, z) => map.current?.flyTo([p.lat, p.lng], z ?? Math.max(map.current.getZoom(), 14), { duration: 0.6 }),
    center: () => {
      const c = map.current?.getCenter()
      return c ? { lat: c.lat, lng: c.lng } : center
    },
    zoom: () => map.current?.getZoom() ?? zoom,
    setView: (p, z) => {
      const m = map.current
      if (!m) return
      // Measured afresh: the stage may just have come back on screen, and Leaflet last measured it hidden.
      m.invalidateSize({ animate: false, pan: false })
      m.setView([p.lat, p.lng], z, { animate: false })
    },
    size: () => {
      const s = map.current?.getSize()
      return s ? { x: s.x, y: s.y } : { x: host.current?.clientWidth ?? 800, y: host.current?.clientHeight ?? 600 }
    },
    locate: () =>
      new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocation is not available in this browser.'))
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => reject(new Error(err.message)),
          { enableHighAccuracy: true, timeout: 10000 },
        )
      }),
    finishDrawing: () => map.current && finishDrawing(map.current),
    cancelDrawing: () => map.current && cancelDrawing(map.current),
    addPoint: (p) => map.current && addVertex(map.current, L.latLng(p.lat, p.lng)),
  }))

  // The card is a React element beside the Leaflet host, placed by the feature's point in container pixels.
  const cardEntity = card ? features[featureIndex(pinIndex(features, colorOf, PLACE_COLOR), features, card.id)] : undefined
  const m = map.current
  const anchor = card && m ? m.latLngToContainerPoint(card.at) : null
  void viewTick
  return (
    <div className={`geo-canvas-wrap ${external ? '' : 'is-offline'}`}>
      <div ref={host} className="geo-canvas" />
      {!external && (
        <div className="geo__offline" role="status">
          No map background: <strong>Third-party services</strong> is off in your account settings, so no tiles are fetched. Your places are still here.
        </div>
      )}
      {hoverLabel && !(card && cardEntity) && <div className="geo__hover">{hoverLabel}</div>}
      {card && cardEntity && m && anchor && (
        <GeoCard
          key={card.id}
          entity={cardEntity}
          kind={card.kind}
          preview={previewOf?.(cardEntity)}
          anchor={{ x: anchor.x, y: anchor.y }}
          size={{ x: m.getSize().x, y: m.getSize().y }}
          loadMore={loadMore}
          readMore={readMoreOf?.(cardEntity) ?? { href: `https://www.google.com/search?q=${encodeURIComponent(cardEntity.label ?? '')}`, label: 'Search' }}
          onEnter={holdCard}
          onLeave={releaseCard}
        />
      )}
    </div>
  )
})

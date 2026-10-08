import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { AmbientLight, LinearFilter, Raycaster, Vector2, type Camera, type Mesh, type MeshBasicMaterial, type Object3D } from 'three'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { observeSettledSize } from '../../lib/settledResize'
import type { LatLng } from '../maps/maps'
import { geoKindOf, pointsOf, simplifyCoords, type GeoAnnotation, type Geometry, type GeoEntity, type GeoPreview } from '../maps/maps'
import { GeoCard } from '../maps/GeoCard'
import { altitudeOfZoom } from '../maps/viewSync'
import type { MapTool } from '../maps/MapCanvas'
import { colorFor, type GlobeArc, type GlobePoint, type GlobePolygon } from './globeData'
import { hitsGlobe, pickLayerObject, polygonAt, rayToLatLng } from './globePick'
import { buildTrackLayer, type TrackLayer } from './trackLayer'
import './globe.css'
import { useExternalServices } from '../account/settings'
import { cssColor } from '../../lib/cssColor'

// three.js and globe.gl load with the first globe, not with the app.
const Globe = lazy(() => import('react-globe.gl'))

/**
 * The Maps page's 3D stage: the same places the 2D canvas draws — the
 * workbench's visible locations, paths and areas, its selection, its
 * time window — on Earth as a globe, with the 2D page's own layer
 * choice (satellite, streets, terrain) or a night texture. It stays
 * mounted behind the 2D canvas so switching is instant and the camera
 * keeps its place; `active` says whether it is in front.
 */

export interface GlobeStageHandle {
  flyTo: (lat: number, lng: number, altitude?: number, ms?: number) => void
  fit: (points: LatLng[]) => void
  spin: (on: boolean) => void
  pointOfView: () => { lat: number; lng: number; altitude: number } | undefined
  /** The camera at once, no flight: what the flat map was showing, as the stages switch. Kept for a globe not yet ready. */
  setView: (lat: number, lng: number, altitude: number) => void
  /** The stage's size in px. */
  size: () => { x: number; y: number }
  /** Drawing, as the flat map's handle has them: hand the drawing over, drop it, add a vertex. */
  finishDrawing: () => void
  cancelDrawing: () => void
  addPoint: (p: LatLng) => void
}

export type GlobeLayer = 'streets' | 'satellite' | 'terrain' | 'night'
/** The tile sources, with the finest level each serves — the same as the flat map's. */
const TILES: Record<Exclude<GlobeLayer, 'night'>, { url: (x: number, y: number, z: number) => string; maxLevel: number }> = {
  satellite: { url: (x, y, z) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, maxLevel: 19 },
  streets: { url: (x, y, z) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, maxLevel: 19 },
  terrain: { url: (x, y, z) => `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`, maxLevel: 17 },
}
const NIGHT_IMAGE = 'https://unpkg.com/three-globe/example/img/earth-night.jpg'
/** The coarse tile level held while the camera is in flight. */
const TILE_MAX_LEVEL_IN_FLIGHT = 4
/**
 * How close the camera comes, in radii above the surface: 2.5e-5 is 160 m up, a view some 150 m tall — the flat
 * map's deepest zoom (19). globe.gl stops at 0.0011 (7 km, about zoom 14), where its camera's near plane is; the
 * near plane here follows the altitude (see `onZoom`), and the tile engine's level thresholds are set from the
 * view (see `tuneTiles`) so the tiles are as detailed as the flat map's at every height.
 */
const MIN_ALTITUDE = 2.5e-5
const GLOBE_R = 100
const toVec = (lat: number, lng: number): [number, number, number] => {
  const φ = (lat * Math.PI) / 180
  const λ = (lng * Math.PI) / 180
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
}
const fromVec = (v: [number, number, number]): [number, number] => [(Math.atan2(v[2], Math.hypot(v[0], v[1])) * 180) / Math.PI, (Math.atan2(v[1], v[0]) * 180) / Math.PI]
const POV_KEY = 'aegraph:globe:pov'

interface Props {
  /** What is drawn now (the time window and the playhead applied). */
  features: GeoEntity[]
  /** Everything the window allows, playhead aside: past BULK_FROM the merged layer is built from these and filtered to `features`. */
  allFeatures?: GeoEntity[]
  selectedId: EntityId | null
  onSelect: (id: EntityId | null) => void
  layer: GlobeLayer
  active: boolean
  colorOf: (tags: string[]) => string | undefined
  /** A moment on the timeline: arcs are drawn moving while it plays. */
  playing?: boolean
  /** The map on the page (none for the all-places view): the camera is remembered per map, and a first look at a map frames its places. */
  mapId?: string
  // ── The interactions the flat map has, the same here ──
  /** Notes pinned to the map, as markers that can be clicked and dragged. */
  notes?: GeoAnnotation[]
  /** What a click does: browse (pick, drag a point), add a location or a note, draw a path click by click, lasso an area. */
  tool?: MapTool
  /** A click with the location or note tool, at this point. */
  onClick?: (p: LatLng) => void
  /** A finished drawing, as GeoJSON-style geometry. */
  onDraw?: (g: Geometry) => void
  onMovePlace?: (id: EntityId, to: LatLng) => void
  onMoveNote?: (a: GeoAnnotation, to: LatLng) => void
  /** A point about to be added (a dialog is open), marked meanwhile. */
  pending?: LatLng | null
  /** Whether hovering opens the card (pictures, summary, link); off, the name shows at the bottom left instead. */
  cards?: boolean
  previewOf?: (e: GeoEntity) => GeoPreview | undefined
  loadMore?: (e: GeoEntity) => Promise<string[]>
  readMoreOf?: (e: GeoEntity) => { href: string; label: string }
  /** How many vertices the drawing has (for the HUD's Finish button). */
  onDrawProgress?: (n: number) => void
  /** A right-click on the globe: the app's menu for that point. */
  onContextMenu?: (at: LatLng, screen: { x: number; y: number }) => void
  /** A right-click on a feature (a point, a path, an area): its entity's menu instead. */
  onFeatureMenu?: (id: EntityId, screen: { x: number; y: number }) => void
}

/** Above this many features the per-mesh arcs and points give way to one merged line/point layer. */
const BULK_FROM = 400
const POLYGON_SIDE = () => 'rgba(0,0,0,0.15)'
const NO_NOTES: GeoAnnotation[] = []
/**
 * The camera put somewhere at once. The tile engine picks its tiles on the camera move, from a view matrix that
 * only the next render brings up to date: a single jump (as against a flight, frame by frame) chose tiles for
 * where the camera had been and never looked again. So the jump is made twice, the second time after a frame.
 */
function jumpTo(g: GlobeApi, pov: { lat: number; lng: number; altitude: number }) {
  g.pointOfView(pov, 0)
  requestAnimationFrame(() => requestAnimationFrame(() => g.pointOfView(pov, 0)))
}
const NOTE_COLOR = '#e9a23b'

type GlobeApi = { lights: (l: AmbientLight[]) => unknown; renderer?: () => { capabilities: { getMaxAnisotropy: () => number } }; pointOfView: (pov?: { lat?: number; lng?: number; altitude?: number }, ms?: number) => { lat: number; lng: number; altitude: number }; controls: () => { autoRotate: boolean; autoRotateSpeed: number; minDistance: number; zoomSpeed: number; enabled: boolean }; camera: () => Camera; scene: () => Object3D; getScreenCoords: (lat: number, lng: number, altitude?: number) => { x: number; y: number }; pauseAnimation: () => unknown; resumeAnimation: () => unknown }

/** A colour faded back behind the selection: `#rrggbb` → `rgba(r,g,b,0.25)` (three.js reads no 8-digit hex); anything else as it is. */
const faded = (color: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},0.25)` : color
}
/**
 * How the camera frames a set of coordinates — a feature after a click, a map on its first look: their mean, at an
 * altitude from their spread (a point close up, a shape or a set by its extent in degrees → globe radii). Two passes
 * over the coordinates and nothing made on the way: a city's 688,335 trees are framed without 688,335 objects.
 */
function frameOf(pts: readonly LatLng[]): { lat: number; lng: number; altitude: number } {
  const n = pts.length
  if (!n) return { lat: 0, lng: 0, altitude: 2.5 }
  let sLat = 0
  let sLng = 0
  for (let i = 0; i < n; i++) {
    sLat += pts[i].lat
    sLng += pts[i].lng
  }
  const lat = sLat / n
  const lng = sLng / n
  if (n === 1) return { lat, lng, altitude: 0.25 }
  let spread = 0
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i].lat - lat, pts[i].lng - lng)
    if (d > spread) spread = d
  }
  return { lat, lng, altitude: Math.min(2.5, Math.max(0.06, spread / 25)) }
}
/** The frame of everything in a list: points by their own coordinates, shapes by their vertices. */
function frameOfFeatures(list: readonly GeoEntity[]): { lat: number; lng: number; altitude: number } | undefined {
  if (!list.length) return undefined
  // Points (the bulk of any big list) are read in place; only shapes' vertices are materialised.
  let shapes = 0
  for (let i = 0; i < list.length; i++) if (list[i].data.geometry && list[i].data.geometry!.type !== 'Point') shapes++
  if (!shapes) return frameOf(list.map((e) => e.data) as LatLng[])
  const pts: LatLng[] = []
  for (const e of list) {
    const g = e.data.geometry
    if (g && g.type !== 'Point') pts.push(...pointsOf(e))
    else pts.push(e.data as LatLng)
  }
  return frameOf(pts)
}

export const GlobeStage = forwardRef<GlobeStageHandle, Props>(function GlobeStage({ features: liveFeatures, allFeatures: liveAll, selectedId: liveSelected, onSelect, layer: liveLayer, active, colorOf, playing: livePlaying, mapId, notes = NO_NOTES, tool = 'browse', onClick, onDraw, onMovePlace, onMoveNote, pending = null, cards = false, previewOf, loadMore, readMoreOf, onDrawProgress, onContextMenu, onFeatureMenu }, ref) {
  // Behind the flat map the globe holds what it last showed: its inputs stand still, so a selection, a hover or a
  // playhead tick on the map costs it nothing — and its render loop is paused below. Coming to the front it takes
  // the live values and catches up in one pass.
  const held = useRef({ features: liveFeatures, allFeatures: liveAll, selectedId: liveSelected, layer: liveLayer, playing: livePlaying })
  if (active) held.current = { features: liveFeatures, allFeatures: liveAll, selectedId: liveSelected, layer: liveLayer, playing: livePlaying }
  const { features, allFeatures, selectedId, layer, playing } = held.current
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const hostRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<GlobeApi | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hover, setHover] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const build = useCallback((list: GeoEntity[]) => {
    const points: GlobePoint[] = []
    const arcs: GlobeArc[] = []
    const polygons: GlobePolygon[] = []
    // The kind of each type once, not once per entity: a city of one type is 688,335 lookups otherwise.
    const kinds = new Map<string, ReturnType<typeof geoKindOf>>()
    for (const e of list) {
      const color = colorOf(e.tags) ?? colorFor(store, registry, e)
      const label = e.label ?? e.id
      const g = e.data.geometry
      let kind = kinds.get(e.type)
      if (kind === undefined && !kinds.has(e.type)) kinds.set(e.type, (kind = geoKindOf(store, e.type)))
      if (kind === 'path' && g?.type === 'LineString') {
        const cs = g.coordinates
        for (let i = 0; i + 1 < cs.length; i++) arcs.push({ id: e.id, startLng: cs[i][0], startLat: cs[i][1], endLng: cs[i + 1][0], endLat: cs[i + 1][1], label, color, at: e.data.at, until: e.data.until, leg: i, legs: cs.length - 1 })
      } else if (kind === 'area' && g?.type === 'Polygon') {
        polygons.push({ id: e.id, coordinates: g.coordinates, label, color })
      } else {
        points.push({ id: e.id, lat: e.data.lat, lng: e.data.lng, label, color, at: e.data.at, size: 0.45 })
      }
    }
    return { points, arcs, polygons }
  }, [colorOf, store, registry])
  const base = allFeatures ?? features
  const bulk = base.length > BULK_FROM
  // Small sets: globe.gl's own arcs and points from what is visible. Big sets: one merged layer from everything, filtered.
  const scene = useMemo(() => (bulk ? { points: [], arcs: [], polygons: build(features.filter((e) => e.data.geometry?.type === 'Polygon')).polygons } : build(features)), [bulk, build, features])
  // The merged layer is always there — its marks (the hovered point's ring, a pending point, a drawing) serve every
  // scene; a small scene's points and arcs stay globe.gl's own and the layer holds none.
  const bulkScene = useMemo(() => (bulk ? build(base) : { points: [], arcs: [], polygons: [] }), [bulk, build, base])
  const layerRef = useRef<TrackLayer | null>(null)
  const customData = useMemo(() => [{ key: 'tracks', scene: bulkScene }], [bulkScene])
  /** Run before each render of the layer: the tiles that have arrived since are sharpened (see `sharpenTiles`). */
  const frameHook = useRef<(() => void) | null>(null)
  const customObject = useCallback(() => {
    layerRef.current?.dispose()
    const l = buildTrackLayer(bulkScene.arcs, bulkScene.points, () => frameHook.current?.())
    layerRef.current = l
    l.pending(pendingRef.current)
    return l.group
  }, [bulkScene])
  const pendingRef = useRef<LatLng | null>(pending)
  pendingRef.current = pending
  useEffect(() => {
    layerRef.current?.pending(pending)
  }, [pending, bulkScene])
  useEffect(() => {
    if (!bulk || !layerRef.current) return
    layerRef.current.filter(features.length === base.length ? undefined : features, selectedId)
  }, [bulk, features, base, selectedId, bulkScene])
  useEffect(() => () => layerRef.current?.dispose(), [])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    return observeSettledSize(el, (r) => {
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
  }, [])
  // Coming to the front: the host may have been 0×0 while hidden; measure again.
  useEffect(() => {
    if (!active) return
    const el = hostRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
  }, [active])
  // Hidden, the globe does not draw: three.js would otherwise render every frame into a canvas nobody sees.
  useEffect(() => {
    const g = globeRef.current
    if (!g || !ready) return
    if (active) g.resumeAnimation()
    else g.pauseAnimation()
  }, [active, ready])

  // The camera flies the way an aircraft does: along the great circle, climbing for a far target and descending
  // onto it, eased at both ends — one motion driven frame by frame, so nothing pauses at a waypoint. While it moves
  // the tile engine is held to coarse tiles; the sharp ones arrive once it has landed, so the burst of texture
  // uploads (the thing that used to freeze the flight into a cut) comes after the motion, not during it.
  const flight = useRef(0)
  const external = useExternalServices()
  const tileMaxLevelOf = layer === 'night' ? 17 : TILES[layer].maxLevel
  const [tileMaxLevel, setTileMaxLevel] = useState(tileMaxLevelOf)
  const flyTo = useCallback((lat: number, lng: number, altitude = 1.2, ms = 900) => {
    const g = globeRef.current
    if (!g) return
    cancelAnimationFrame(flight.current)
    const from = g.pointOfView()
    if (!from) {
      g.pointOfView({ lat, lng, altitude }, 0)
      return
    }
    const a = toVec(from.lat, from.lng)
    const b = toVec(lat, lng)
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
    const angle = Math.acos(dot)
    const far = (angle * 180) / Math.PI
    const bump = far < 12 ? 0 : Math.max(0, Math.min(2.4, far / 45) - Math.max(from.altitude, altitude) * 0.5)
    const duration = Math.min(2400, Math.max(ms, 700 + far * 12))
    setTileMaxLevel(TILE_MAX_LEVEL_IN_FLIGHT)
    const t0 = performance.now()
    const step = () => {
      const g2 = globeRef.current
      if (!g2) return
      const t = Math.min(1, (performance.now() - t0) / duration)
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      // Spherical interpolation between the two points of view (a straight line in lat/lng would wobble near the poles).
      let p: [number, number, number]
      if (angle < 1e-6) p = b
      else {
        const s = Math.sin(angle)
        const wa = Math.sin((1 - e) * angle) / s
        const wb = Math.sin(e * angle) / s
        p = [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]]
      }
      const [plat, plng] = fromVec(p)
      const alt = from.altitude + (altitude - from.altitude) * e + bump * Math.sin(Math.PI * e)
      g2.pointOfView({ lat: plat, lng: plng, altitude: alt }, 0)
      if (t < 1) flight.current = requestAnimationFrame(step)
      else {
        flight.current = 0
        setTileMaxLevel(tileMaxLevelOf)
      }
    }
    flight.current = requestAnimationFrame(step)
  }, [tileMaxLevelOf])
  // The layer changed (its finest level with it) with no flight on: the cap follows.
  useEffect(() => {
    if (!flight.current) setTileMaxLevel(tileMaxLevelOf)
  }, [tileMaxLevelOf])
  useEffect(() => () => cancelAnimationFrame(flight.current), [])
  // The tile engine picks its level only when the camera moves, and the level cap goes back up after the camera
  // has stopped: without a nudge the coarse tiles of the flight stayed until the globe was touched.
  useEffect(() => {
    const g = globeRef.current
    if (!g || !ready || tileMaxLevel !== tileMaxLevelOf) return
    const pov = g.pointOfView()
    if (pov) g.pointOfView(pov, 0)
  }, [tileMaxLevel, tileMaxLevelOf, ready])
  const fit = useCallback(
    (pts: LatLng[]) => {
      if (!pts.length) return
      const f = frameOf(pts)
      flyTo(f.lat, f.lng, f.altitude)
    },
    [flyTo],
  )
  // Looked up by hover and selection; built on the first ask, not on every change of the list (688,335 entries take a while).
  const byIdRef = useRef<{ base: GeoEntity[]; map: Map<EntityId, GeoEntity> } | null>(null)
  const byId = useMemo(() => {
    const get = (id: EntityId) => {
      if (byIdRef.current?.base !== base) byIdRef.current = { base, map: new Map(base.map((e) => [e.id, e])) }
      return byIdRef.current.map.get(id)
    }
    return { get }
  }, [base])
  // A click on a feature selects it — the table on the right follows the workbench's selection — and the camera
  // stays where it is, as on the flat map (a row clicked in the table flies; a click on the globe does not: on a
  // city whose every spot lies in a ward, a click beside a tree selected the ward and flew off to frame it).
  const select = useCallback((id: EntityId) => onSelect(id), [onSelect])
  // Picking is the stage's own (globe.gl's pointer interaction is off — see globePick): a ray from the pointer,
  // then the merged layer's grid for a point or a leg, the meshes of a small scene's points and arcs, an area by
  // its ring, and last the globe itself. A click that moved the globe more than a few pixels is a drag, not a pick.
  const polygons = scene.polygons
  const raycast = useCallback(
    (clientX: number, clientY: number): { id?: EntityId; label?: string; onGlobe: boolean } => {
      const host = hostRef.current
      const globe = globeRef.current
      if (!host || !globe) return { onGlobe: false }
      const r = host.getBoundingClientRect()
      const cam = globe.camera()
      const ray = new Raycaster()
      ray.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), cam)
      // A few pixels of slack, in world units at the surface's distance (the globe's radius is 100).
      const dist = Math.max(0.05, cam.position.length() - 100)
      ray.params.Line.threshold = dist * 0.008
      ray.params.Points.threshold = dist * 0.008
      const onGlobe = hitsGlobe(ray)
      const id = bulk ? layerRef.current?.pick(ray) : pickLayerObject(globe.scene(), ray)
      if (id !== undefined) return { id, onGlobe }
      if (polygons.length && onGlobe) {
        const at = rayToLatLng(ray)
        const p = at && polygonAt(polygons, at.lat, at.lng)
        if (p) return { id: p.id, label: p.label, onGlobe }
      }
      return { onGlobe }
    },
    [bulk, polygons],
  )
  // ── The pointer: the flat map's interactions, on the globe ──
  const cb = useRef({ tool, cards, onClick, onDraw, onMovePlace, onMoveNote, onDrawProgress, onContextMenu, onFeatureMenu, onSelect })
  cb.current = { tool, cards, onClick, onDraw, onMovePlace, onMoveNote, onDrawProgress, onContextMenu, onFeatureMenu, onSelect }
  /** The point on the globe under a pointer event, or null off it. */
  const latLngAt = useCallback((clientX: number, clientY: number): LatLng | null => {
    const host = hostRef.current
    const globe = globeRef.current
    if (!host || !globe) return null
    const r = host.getBoundingClientRect()
    const ray = new Raycaster()
    ray.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), globe.camera())
    return rayToLatLng(ray)
  }, [])
  const kindLabel = useCallback((e: GeoEntity) => (geoKindOf(store, e.type) === 'path' ? 'Path' : geoKindOf(store, e.type) === 'area' ? 'Area' : 'Location'), [store])
  const isLocation = useCallback((e: GeoEntity) => !e.data.geometry || e.data.geometry.type === 'Point', [])

  // The card behind a feature: opens on hover (with the cards on and the browse tool), stays while the pointer is on
  // the feature or the card, follows its point as the globe turns.
  const [card, setCard] = useState<{ id: EntityId; at: LatLng; kind: string } | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const openCard = (id: EntityId, at: LatLng, kind: string) => {
    if (cb.current.tool !== 'browse' || !cb.current.cards) return
    clearTimeout(closeTimer.current)
    setCard((c) => (c?.id === id ? c : { id, at, kind }))
  }
  const holdCard = () => clearTimeout(closeTimer.current)
  const releaseCard = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setCard(null), 350)
  }
  const closeCard = () => {
    clearTimeout(closeTimer.current)
    setCard(null)
  }
  useEffect(() => {
    if (!cards) closeCard()
  }, [cards])
  useEffect(() => {
    if (!card) {
      setAnchor(null)
      return
    }
    let raf = 0
    const tick = () => {
      const g = globeRef.current
      if (g) {
        const p = g.getScreenCoords(card.at.lat, card.at.lng, 0)
        setAnchor((a) => (a && Math.abs(a.x - p.x) < 0.5 && Math.abs(a.y - p.y) < 0.5 ? a : { x: p.x, y: p.y }))
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [card])

  /** A press: where it began, so a release within a few pixels is a click and further is a turn of the globe. */
  const down = useRef<{ x: number; y: number } | null>(null)
  /** A point being dragged, by feature id (and its index in the merged layer, where it moves live). */
  const drag = useRef<{ id: EntityId; index: number; at: LatLng; entity: GeoEntity } | null>(null)
  /** The drawing in progress: a path's vertices (click by click) or a lasso's samples (while the button is down). */
  const draw = useRef<{ kind: 'path' | 'area'; points: LatLng[]; lassoing: boolean } | null>(null)
  const hovered = useRef<EntityId | null>(null)
  const controlsOn = (on: boolean) => {
    const c = globeRef.current?.controls()
    if (c) c.enabled = on
  }
  const showDraft = () => {
    const d = draw.current
    layerRef.current?.draft(d ? { points: d.points, closed: d.kind === 'area' } : null)
  }
  const addVertex = (at: LatLng) => {
    let cur = draw.current
    if (cur?.kind === 'path') cur.points.push(at)
    else cur = draw.current = { kind: 'path', points: [at], lassoing: false }
    showDraft()
    cb.current.onDrawProgress?.(cur.points.length)
  }
  const cancelDrawing = () => {
    if (!draw.current) return
    draw.current = null
    showDraft()
    controlsOn(true)
    cb.current.onDrawProgress?.(0)
  }
  /** Hand the drawing back as GeoJSON-style coordinates ([lng, lat]); a lasso is thinned to what describes it at this height. */
  const finishDrawing = () => {
    const d = draw.current
    if (!d) return
    if (d.kind === 'path' && d.points.length < 2) return
    draw.current = null
    showDraft()
    controlsOn(true)
    cb.current.onDrawProgress?.(0)
    let cs = d.points.map((p) => [p.lng, p.lat] as [number, number]).filter((c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1])
    if (d.kind === 'area') {
      // About 3 screen pixels at this height: the view is ~0.93 × altitude radii tall, a radius is 57.3°.
      const alt = globeRef.current?.pointOfView()?.altitude ?? 1
      const h = hostRef.current?.clientHeight || 600
      cs = simplifyCoords(cs, ((3 * alt * 0.93) / h) * 57.3)
    }
    if ((d.kind === 'path' && cs.length < 2) || (d.kind === 'area' && cs.length < 3)) return
    cb.current.onDraw?.(d.kind === 'path' ? { type: 'LineString', coordinates: cs } : { type: 'Polygon', coordinates: [[...cs, cs[0]]] })
  }
  // Leaving a drawing tool drops an unfinished drawing; the cursor says which tool is in hand.
  useEffect(() => {
    if (tool !== 'path' && tool !== 'area') cancelDrawing()
    if (tool !== 'browse') {
      layerRef.current?.hover(null)
      closeCard()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelDrawing()
        closeCard()
      }
      if (e.key === 'Enter' && draw.current?.kind === 'path') finishDrawing()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // A press, before the globe's own controls see it (capture): on a point with the browse tool it begins a drag of
  // that point; with the area tool it begins a lasso. Either holds the globe still until the button comes up.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    down.current = { x: e.clientX, y: e.clientY }
    const t = cb.current.tool
    if (t === 'browse') {
      const hit = raycast(e.clientX, e.clientY)
      const ent = hit.id ? byId.get(hit.id) : undefined
      if (!ent || !isLocation(ent)) return
      controlsOn(false)
      closeCard()
      layerRef.current?.hover(null)
      const index = layerRef.current?.indexOf(ent.id) ?? -1
      drag.current = { id: ent.id, index, at: { lat: ent.data.lat, lng: ent.data.lng }, entity: ent }
      // On the document, not the stage: the pointer may leave it before the button comes up.
      const move = (ev: PointerEvent) => {
        const d = drag.current
        const at = latLngAt(ev.clientX, ev.clientY)
        if (!d || !at) return
        d.at = at
        // A merged point moves live; a small scene's point (globe.gl's mesh) shows the pending mark until it lands.
        if (d.index >= 0) layerRef.current?.setPlace(d.index, at.lat, at.lng)
        else layerRef.current?.pending(at)
      }
      const up = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        controlsOn(true)
        const d = drag.current
        drag.current = null
        down.current = null
        if (!d) return
        if (d.index < 0) layerRef.current?.pending(pendingRef.current)
        if (d.at.lat !== d.entity.data.lat || d.at.lng !== d.entity.data.lng) cb.current.onMovePlace?.(d.id, d.at)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
    } else if (t === 'area') {
      const at = latLngAt(e.clientX, e.clientY)
      if (!at) return
      controlsOn(false)
      draw.current = { kind: 'area', points: [at], lassoing: true }
      showDraft()
    }
  }
  const endLasso = () => {
    const d = draw.current
    if (d?.kind !== 'area' || !d.lassoing) return
    d.lassoing = false
    finishDrawing()
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current) return
    if (draw.current?.kind === 'area' && draw.current.lassoing) {
      down.current = null
      endLasso()
      return
    }
    const d = down.current
    down.current = null
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
    const t = cb.current.tool
    if (t === 'browse') {
      const hit = raycast(e.clientX, e.clientY)
      if (hit.id) select(hit.id)
      else if (hit.onGlobe) onSelect(null)
      return
    }
    const at = latLngAt(e.clientX, e.clientY)
    if (!at) return
    closeCard()
    if (t === 'path') addVertex(at)
    else if (t === 'location' || t === 'note') cb.current.onClick?.(at)
  }
  // A path: the last click is a double-click, which also finishes it.
  const onDoubleClick = () => {
    if (cb.current.tool === 'path' && draw.current) finishDrawing()
  }
  // Right-click on the globe: the app's menu for that point.
  const onContextMenuEvent = (e: React.MouseEvent) => {
    e.preventDefault()
    if (draw.current) return
    // On a feature, its entity's menu; elsewhere, the globe's.
    if (cb.current.onFeatureMenu && cb.current.tool === 'browse') {
      const hit = raycast(e.clientX, e.clientY)
      if (hit.id) return cb.current.onFeatureMenu(hit.id, { x: e.clientX, y: e.clientY })
    }
    const at = latLngAt(e.clientX, e.clientY)
    if (at) cb.current.onContextMenu?.(at, { x: e.clientX, y: e.clientY })
  }
  // Hover: the point under the pointer is ringed and its card opens (or its name shows, with the cards off);
  // twenty times a second at most. While a lasso is drawn the samples follow the pointer; while a path is drawn
  // a rubber band does.
  const hoverAt = useRef(0)
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) return
    const d = draw.current
    if (d?.kind === 'area' && d.lassoing) {
      const at = latLngAt(e.clientX, e.clientY)
      if (at) {
        d.points.push(at)
        showDraft()
      }
      return
    }
    if (d?.kind === 'path' && d.points.length) {
      const at = latLngAt(e.clientX, e.clientY)
      layerRef.current?.draft({ points: at ? [...d.points, at] : d.points, closed: false })
    }
    if (down.current) return
    const now = performance.now()
    if (now - hoverAt.current < 50) return
    hoverAt.current = now
    const hit = cb.current.tool === 'browse' ? raycast(e.clientX, e.clientY) : { onGlobe: false }
    const ent = hit.id ? byId.get(hit.id) : undefined
    const host = hostRef.current
    host?.classList.toggle('is-hover', !!hit.id)
    layerRef.current?.hover(ent && isLocation(ent) ? { lat: ent.data.lat, lng: ent.data.lng } : null)
    setHover(ent ? `${ent.label ?? ent.id}${ent.data.at ? ` · ${new Date(ent.data.at).toLocaleString()}` : ''}` : (hit.label ?? null))
    if (ent) {
      const at = isLocation(ent) ? { lat: ent.data.lat, lng: ent.data.lng } : (latLngAt(e.clientX, e.clientY) ?? { lat: ent.data.lat, lng: ent.data.lng })
      openCard(ent.id, at, kindLabel(ent))
    } else if (hovered.current) releaseCard()
    hovered.current = hit.id ?? null
  }
  const onPointerLeave = () => {
    setHover(null)
    hostRef.current?.classList.remove('is-hover')
    layerRef.current?.hover(null)
    if (hovered.current) releaseCard()
    hovered.current = null
    if (draw.current?.kind === 'area' && draw.current.lassoing) endLasso()
  }

  // Notes pinned to the map: the flat map's markers, placed by globe.gl's HTML layer, clickable and draggable.
  const noteData = useMemo(
    () =>
      notes.map((a, i) => {
        const color = colorOf(a.annotation.tags) ?? NOTE_COLOR
        return { a, i, lat: a.geo.lat, lng: a.geo.lng, color, sel: selectedId === a.annotation.id }
      }),
    [notes, colorOf, selectedId],
  )
  const noteElement = useCallback(
    (d: object) => {
      const n = d as (typeof noteData)[number]
      const el = document.createElement('div')
      el.className = `geo-pin geo-pin--note globe__note ${n.sel ? 'is-selected' : ''}`
      // Built, not written as markup: the colour is data.
      const dot = document.createElement('span')
      dot.className = 'geo-pin__note'
      dot.style.background = cssColor(n.color, NOTE_COLOR)
      dot.textContent = String(n.i + 1)
      el.appendChild(dot)
      const when = n.a.geo.at ? ` · ${new Date(n.a.geo.at).toLocaleString()}` : ''
      el.title = `${n.a.annotation.data.comment || n.a.annotation.label || 'Note'}${when}`
      el.style.pointerEvents = 'auto'
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        controlsOn(false)
        let at: LatLng | null = null
        const move = (ev: PointerEvent) => {
          at = latLngAt(ev.clientX, ev.clientY)
          if (at) layerRef.current?.pending(at)
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          controlsOn(true)
          layerRef.current?.pending(pendingRef.current)
          if (at) cb.current.onMoveNote?.(n.a, at)
          else cb.current.onSelect(n.a.annotation.id)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      })
      return el
    },
    [latLngAt],
  )
  // The selected feature, drawn on its own by the merged layer so it stands out: a track as a tube, a point as a
  // pulsing ring. (globe.gl's own paths and rings layers compiled a shader on every selection and were raycast on
  // every frame, which is what made the camera flight stutter.)
  useEffect(() => {
    const layer = layerRef.current
    if (!bulk || !layer) return
    const e = selectedId ? byId.get(selectedId) : undefined
    const g = e?.data.geometry
    if (!e) layer.highlight(null)
    else if (g?.type === 'LineString') layer.highlight({ kind: 'track', points: g.coordinates.map(([lng, lat]) => ({ lat, lng })) })
    else if (geoKindOf(store, e.type) === 'location') layer.highlight({ kind: 'point', lat: e.data.lat, lng: e.data.lng })
    else layer.highlight(null)
  }, [bulk, selectedId, byId, store, bulkScene])
  const povKey = mapId ? `${POV_KEY}:${mapId}` : POV_KEY
  /** The map whose first look has been taken (its camera restored or its places framed) — or set by hand. */
  const seenKey = useRef<string | null>(null)
  useImperativeHandle(
    ref,
    () => ({
      flyTo,
      fit,
      spin: (on) => {
        const c = globeRef.current?.controls()
        if (c) {
          c.autoRotate = on
          c.autoRotateSpeed = 0.6
        }
      },
      pointOfView: () => globeRef.current?.pointOfView(),
      size: () => ({ x: size.w, y: size.h }),
      setView: (lat, lng, altitude) => {
        seenKey.current = povKey
        const g = globeRef.current
        if (g && ready) jumpTo(g, { lat, lng, altitude })
        else pendingView.current = { lat, lng, altitude }
      },
      finishDrawing,
      cancelDrawing,
      addPoint: (p) => addVertex(p),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flyTo, fit, povKey, ready, size],
  )

  // The camera is remembered across visits (and across the dormant release of a kept page) — per map, so each map
  // keeps its own; a map never looked at before opens framed on its places rather than wherever the last one left off.
  const restore = useCallback(() => {
    const g = globeRef.current
    if (!g) return
    let pov: { lat?: number } | null = null
    try {
      pov = JSON.parse(localStorage.getItem(povKey) ?? 'null')
    } catch {
      /* ignore */
    }
    if (pov && typeof pov.lat === 'number') jumpTo(g, pov as { lat: number; lng: number; altitude: number })
    else {
      const frame = frameOfFeatures(allFeatures ?? features)
      if (frame) jumpTo(g, frame)
    }
  }, [povKey, allFeatures, features])
  /** A view set before the globe was ready, applied when it is — and, either way, the first look's own framing is then not wanted. */
  const pendingView = useRef<{ lat: number; lng: number; altitude: number } | null>(null)
  const onReady = useCallback(() => {
    const g = globeRef.current
    if (g) {
      // Lit flat: the tiles as their images are, as the flat map shows them. globe.gl's own lights — a grey ambient
      // and a sun off to one side — shaded them, and the globe read dimmer than the map beside it.
      g.lights([new AmbientLight(0xffffff, Math.PI)])
      if (pendingView.current) {
        jumpTo(g, pendingView.current)
        pendingView.current = null
      }
      g.controls().minDistance = GLOBE_R * (1 + MIN_ALTITUDE)
    }
    setReady(true)
  }, [])
  /**
   * The tile engine, three-slippy-map-globe's group: it picks its level by the camera's altitude against a list of
   * thresholds (level L below `thresholds[L]` radii) — a fixed list, 8 / 2^L, two levels coarser than the flat map
   * shows at the same scale. The list is set from the view instead: the altitude at which this stage, at this
   * latitude, shows what the flat map shows at zoom 0, halved per level (and √2 down, since the engine takes the first
   * level whose threshold the altitude is under: the level is then the zoom rounded, as Leaflet rounds), and the tiles are as detailed as the flat map's at every height.
   */
  type TileEngine = Object3D & { thresholds?: number[]; updatePov?: (c: Camera) => void }
  const tileEngine = useRef<TileEngine | null>(null)
  /** The engine, found in the scene on first need: it is not there yet when the globe reports ready. */
  const findTileEngine = (g: GlobeApi): TileEngine | null => {
    if (!tileEngine.current) g.scene().traverse((o) => Array.isArray((o as TileEngine).thresholds) && (tileEngine.current = o as TileEngine))
    return tileEngine.current
  }
  const thresholdBase = useRef(0)
  const maxAniso = useRef(0)
  const sharpened = useRef(new WeakSet<object>())
  const tuneTiles = useCallback((lat: number) => {
    const g = globeRef.current
    const engine = g && findTileEngine(g)
    if (!engine || !g) return
    const k = altitudeOfZoom(0, lat, size.h) / Math.SQRT2
    if (Math.abs(k - thresholdBase.current) / k > 0.02) {
      thresholdBase.current = k
      engine.thresholds = Array.from({ length: 30 }, (_, l) => k / 2 ** l)
      engine.updatePov?.(g.camera())
    }
  }, [size.h])
  // Every tile's texture sampled anisotropically and without a mip chain: a tile is shown near its own size (the
  // level follows the view), and mip blending at a touch of minification blurred the lettering the flat map shows
  // crisp; on the curve a tile is seen at an angle, which anisotropy keeps sharp. Before each frame, for the tiles
  // that have arrived since (a tile loads after the camera has settled, when no camera event would catch it).
  const sharpenTiles = useCallback(() => {
    const g = globeRef.current
    const engine = g && findTileEngine(g)
    if (!engine || !g) return
    if (!maxAniso.current) maxAniso.current = (g.renderer?.().capabilities.getMaxAnisotropy() as number | undefined) ?? 1
    for (const o of engine.children) {
      const map = (o as Mesh).material && ((o as Mesh).material as MeshBasicMaterial).map
      if (map && !sharpened.current.has(map)) {
        sharpened.current.add(map)
        map.anisotropy = maxAniso.current
        map.minFilter = LinearFilter
        map.generateMipmaps = false
        map.needsUpdate = true
      }
    }
  }, [])
  frameHook.current = sharpenTiles
  // On every camera change (globe.gl reports it after setting its own speeds): the near plane follows the altitude,
  // so the camera can come down to a street without clipping the ground (a fixed near plane of 0.1 — six
  // kilometres — is what held globe.gl at 7 km up); and the zoom step is a share of the altitude, not of the
  // distance to the globe's centre, so a wheel tick near the ground is a tenth of the height, not most of it.
  const onZoom = useCallback((pov: { lat: number; altitude: number }) => {
    const g = globeRef.current
    if (!g) return
    tuneTiles(pov.lat)
    const cam = g.camera() as Camera & { near: number; updateProjectionMatrix?: () => void }
    // A tenth of the height: nothing drawn is nearer, and the depth buffer's resolution at the surface follows the
    // camera down — from orbit it keeps the area caps, sixty metres up, apart from the tiles.
    const near = Math.max(1e-4, pov.altitude * GLOBE_R * 0.1)
    if (Math.abs(cam.near - near) / near > 0.05) {
      cam.near = near
      cam.updateProjectionMatrix?.()
    }
    const c = g.controls()
    c.zoomSpeed = Math.min(Math.sqrt(pov.altitude) * 0.5, (2 * pov.altitude) / (1 + pov.altitude))
  }, [tuneTiles])
  // The first look at a map — the globe ready, in front, its places known — and every other map after it: its own
  // camera, or framed on its places.
  useEffect(() => {
    if (!ready || !active || seenKey.current === povKey) return
    if (!(allFeatures ?? features).length) return
    seenKey.current = povKey
    restore()
  }, [ready, active, povKey, restore, allFeatures, features])
  useEffect(() => {
    if (!ready) return
    const t = setInterval(() => {
      const pov = globeRef.current?.pointOfView()
      if (pov && active) localStorage.setItem(povKey, JSON.stringify(pov))
    }, 2000)
    return () => clearInterval(t)
  }, [ready, povKey, active])

  // With something selected, the rest of the per-mesh layer fades so the white one stands out. The accessors keep
  // their identity between renders: globe.gl rebuilds a layer whenever one changes, which is the whole scene.
  const pointColor = useCallback((p: object) => ((p as GlobePoint).id === selectedId ? '#ffffff' : selectedId ? faded((p as GlobePoint).color) : (p as GlobePoint).color), [selectedId])
  const pointAltitude = useCallback((p: object) => ((p as GlobePoint).id === selectedId ? 0.08 : 0.03), [selectedId])
  const arcColor = useCallback((a: object) => ((a as GlobeArc).id === selectedId ? '#ffffff' : selectedId ? faded((a as GlobeArc).color) : (a as GlobeArc).color), [selectedId])
  const arcStroke = useCallback((a: object) => ((a as GlobeArc).id === selectedId ? 2.2 : 0.8), [selectedId])
  // The flat map's fills: a fifth, a third when selected, a shade behind another selection.
  const polygonCapColor = useCallback((p: object) => `${(p as GlobePolygon).color}${(p as GlobePolygon).id === selectedId ? '59' : selectedId ? '14' : '33'}`, [selectedId])
  const polygonStrokeColor = useCallback((p: object) => ((p as GlobePolygon).id === selectedId ? '#ffffff' : (p as GlobePolygon).color), [selectedId])
  // Thin slabs, in globe radii: 1e-5 is sixty metres — below the camera's lowest altitude, so a street-level look
  // is never under a cap, and no parallax to speak of (higher, areas slid off their streets at the edge of a low
  // view); the near plane follows the camera down (`onZoom`), which keeps them apart from the tiles from orbit.
  const polygonAltitude = useCallback((p: object) => ((p as GlobePolygon).id === selectedId ? 2e-5 : 1e-5), [selectedId])
  const polygonsData = useMemo(() => scene.polygons.map((p) => ({ ...p, geometry: { type: 'Polygon', coordinates: p.coordinates } })), [scene.polygons])
  // Offline (Third-party services off) the earth has no imagery — the pins, paths, areas and arcs are the globe.
  const tileUrl = !external || layer === 'night' ? null : TILES[layer].url
  const cardEntity = card ? byId.get(card.id) : undefined

  return (
    <div className={`globe__stage ${tool !== 'browse' ? 'is-placing' : ''} ${tool === 'path' || tool === 'area' ? 'is-drawing' : ''}`} ref={hostRef} onPointerDownCapture={onPointerDownCapture} onPointerUp={onPointerUp} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onDoubleClick={onDoubleClick} onContextMenu={onContextMenuEvent}>
      <Suspense fallback={<div className="globe__loading muted">Loading the globe…</div>}>
        <Globe
          ref={globeRef as never}
          width={size.w}
          height={size.h}
          backgroundColor="#0b0d12"
          globeImageUrl={external && layer === 'night' ? NIGHT_IMAGE : null}
          globeTileEngineUrl={tileUrl}
          {...({ globeTileEngineMaxLevel: tileMaxLevel } as object)} // globe.gl has it; react-globe.gl's types do not yet
          showAtmosphere
          atmosphereColor="#9cc4ff"
          atmosphereAltitude={0.18}
          onGlobeReady={onReady}
          onZoom={onZoom}
          enablePointerInteraction={false}
          htmlElementsData={noteData}
          htmlLat="lat"
          htmlLng="lng"
          htmlAltitude={0}
          htmlElement={noteElement}
          htmlTransitionDuration={0}
          customLayerData={customData}
          customThreeObject={customObject}
          customThreeObjectUpdate={() => {}}
          pointsData={scene.points}
          pointLat="lat"
          pointLng="lng"
          pointColor={pointColor}
          pointAltitude={pointAltitude}
          pointRadius={(p: object) => (p as GlobePoint).size}
          pointResolution={16}
          arcsData={scene.arcs}
          arcStartLat="startLat"
          arcStartLng="startLng"
          arcEndLat="endLat"
          arcEndLng="endLng"
          arcColor={arcColor}
          arcStroke={arcStroke}
          arcAltitudeAutoScale={0.3}
          arcDashLength={0.6}
          arcDashGap={0.2}
          arcDashInitialGap={(a: object) => ((a as GlobeArc).leg % 3) * 0.3}
          arcDashAnimateTime={playing ? 1200 : 3000}
          polygonsData={polygonsData}
          polygonCapColor={polygonCapColor}
          polygonSideColor={POLYGON_SIDE}
          polygonStrokeColor={polygonStrokeColor}
          polygonAltitude={polygonAltitude}
        />
      </Suspense>
      {hover && !(card && cardEntity) && <div className="geo__hover">{hover}</div>}
      {card && cardEntity && anchor && hostRef.current && (
        <GeoCard
          key={card.id}
          entity={cardEntity}
          kind={card.kind}
          preview={previewOf?.(cardEntity)}
          anchor={anchor}
          size={{ x: size.w, y: size.h }}
          loadMore={loadMore}
          readMore={readMoreOf?.(cardEntity) ?? { href: `https://www.google.com/search?q=${encodeURIComponent(cardEntity.label ?? '')}`, label: 'Search' }}
          onEnter={holdCard}
          onLeave={releaseCard}
        />
      )}
    </div>
  )
})

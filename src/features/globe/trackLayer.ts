import { AdditiveBlending, BufferAttribute, BufferGeometry, CatmullRomCurve3, DoubleSide, DynamicDrawUsage, Group, Line, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Points, RingGeometry, ShaderMaterial, TubeGeometry, Vector3, type PerspectiveCamera, type Raycaster } from 'three'
import type { EntityId } from '../../core/entity/types'
import type { GlobeArc, GlobePoint } from './globeData'

/**
 * Thousands of tracks — or a city of points — as one draw call each.
 * globe.gl's arcs and points are a mesh apiece, which is fine for a
 * hundred journeys and hopeless for seven thousand flights or 688,335
 * trees. This layer puts every leg into one LineSegments buffer and every
 * location into one Points buffer, coloured per vertex, and *filters* by
 * writing a per-vertex byte — the buffers are built once per feature set
 * and only a byte per vertex changes as the playhead moves; a selection
 * changes a uniform and nothing is uploaded at all.
 *
 * Picking is the layer's own. three's `Points.raycast` walks every point,
 * and globe.gl runs a raycast over the whole scene every 50 ms while the
 * pointer is on the globe — with a city of points that was most of a
 * second per frame. Both objects opt out of raycasting (`raycast` is a
 * no-op, so globe.gl's pass skips them) and `pick` answers from a grid
 * over the points: a few thousand cells, each with its bounding sphere,
 * and only the cells the ray passes near are searched.
 *
 * How many points are drawn follows the camera. Blending is serial per
 * pixel: a city's 688,335 dots seen from orbit all land on the same
 * thirty pixels, and the GPU blends them one after another — 200 ms a
 * frame for a blob three pixels wide. The points are stored in shuffled
 * order, so any prefix of the buffer is a uniform sample of the whole,
 * and before each render the draw range is set from the screen area the
 * points cover: enough for a few per pixel, never fewer than DRAW_FLOOR,
 * everything once the camera is close. A pan or a zoom changes an
 * integer; nothing is rebuilt.
 *
 * Coordinates: the globe's own polar → cartesian, exactly on the surface
 * (radius 100), stored about the points' own centre with the objects
 * placed there — a float32 at a radius of 100 is good to half a metre,
 * which at street level is a jitter of pixels; about a city's centre it is
 * good to millimetres. Nothing is lifted: any height shows as parallax — trees
 * standing kilometres above their streets slide off them towards the edge
 * of the view, the more the closer the camera. Instead the layer draws
 * without a depth test, after the tiles and the area caps (render order),
 * and the shader discards what lies beyond the horizon — a vertex is
 * visible when the eye is on its side of the tangent plane, and along a
 * leg that test interpolates exactly.
 */

const R = 100
/** A point on the surface, in globe units. */
const xyz = (lat: number, lng: number) => {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((90 - lng) * Math.PI) / 180
  return [R * Math.sin(phi) * Math.cos(theta), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(theta)] as const
}
/** Draw order among the transparent objects: after globe.gl's own layers (0), lines under points, the highlight on top. */
const ORDER_LINES = 10
const ORDER_POINTS = 11
const ORDER_HIGHLIGHT = 12
/** Points drawn per screen pixel of the area they cover, and the fewest drawn whatever the distance. */
const DRAW_DENSITY = 4
const DRAW_FLOOR = 20_000

/** A permutation of 0..n−1, the same every time (a seeded xorshift), so the buffer order — and every pick — is stable. */
function shuffled(n: number): Uint32Array {
  const perm = new Uint32Array(n)
  for (let i = 0; i < n; i++) perm[i] = i
  let x = 0x9e3779b9 | 0
  for (let i = n - 1; i > 0; i--) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    const j = (x >>> 0) % (i + 1)
    const t = perm[i]
    perm[i] = perm[j]
    perm[j] = t
  }
  return perm
}

/** `#rrggbb` (or any CSS colour, via a canvas) to bytes, once per distinct colour: a city has 73 of them, not 688,335. */
const rgbCache = new Map<string, [number, number, number]>()
let rgbCtx: CanvasRenderingContext2D | null | undefined
function rgbOf(color: string): [number, number, number] {
  let c = rgbCache.get(color)
  if (c) return c
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (m) {
    const v = parseInt(m[1], 16)
    c = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  } else {
    // Named colours, rgb(), hsl(): the canvas parses them.
    if (rgbCtx === undefined) rgbCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (rgbCtx) {
      rgbCtx.fillStyle = color
      const s = rgbCtx.fillStyle
      const mm = /^#([0-9a-f]{6})/i.exec(s)
      const v = mm ? parseInt(mm[1], 16) : 0x999999
      c = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    } else c = [153, 153, 153]
  }
  rgbCache.set(color, c)
  return c
}

// One vertex shader for both objects: colour and the on/off byte in, alpha = on × dim × base; how far the vertex is
// on the eye's side of the horizon (positive: visible), interpolated along a leg.
const VERT = /* glsl */ `
attribute float on;
uniform float dim;
uniform float base;
uniform float size;
varying vec4 vColor;
varying float vVis;
varying float vSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #ifdef POINTS
  gl_PointSize = size;
  #endif
  vSize = size;
  vColor = vec4(color, on * dim * base);
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  vVis = dot(world, cameraPosition) - 10000.0;
}`
// A dot is opaque to its edge, with one pixel of anti-aliasing — a small one is simply a solid square: a soft
// edge over most of a three-pixel sprite left it half transparent, and a city of them read greyer than the flat
// map's crisp points.
const FRAG_POINTS = /* glsl */ `
varying vec4 vColor;
varying float vVis;
varying float vSize;
void main() {
  if (vVis <= 0.0) discard;
  float a = vColor.a;
  if (vSize >= 4.0) {
    float soft = 1.0 / vSize;
    a *= 1.0 - smoothstep(0.5 - soft, 0.5, length(gl_PointCoord - 0.5));
  }
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`
const FRAG_LINES = /* glsl */ `
varying vec4 vColor;
varying float vVis;
void main() {
  if (vVis <= 0.0 || vColor.a <= 0.0) discard;
  gl_FragColor = vColor;
}`

export interface TrackLayer {
  group: Group
  /**
   * Show only these features (undefined: all) — the same array again costs nothing — with the selected one's
   * company faded back so it stands out (the selected feature itself is drawn by `highlight`).
   */
  filter: (visible: readonly { id: EntityId }[] | undefined, selected: EntityId | null) => void
  /**
   * Draw the selected feature on its own: a track as a tube, a location as a pulsing ring — meshes that share one
   * material each (built once, no shader compile per selection) and that no raycast looks at.
   */
  highlight: (h: { kind: 'track'; points: { lat: number; lng: number }[] } | { kind: 'point'; lat: number; lng: number } | null) => void
  /** The feature under a ray: the point nearest the pointer, else the nearest leg — of those the filter left visible, on the near side of the globe. */
  pick: (ray: Raycaster) => EntityId | undefined
  /** The point index of a feature id (for a drag), or -1. */
  indexOf: (id: EntityId) => number
  /** A point moved (a drag): its buffer position follows at once; the pick grid is rebuilt on the next pick. */
  setPlace: (index: number, lat: number, lng: number) => void
  /** The point under the pointer, ringed as the flat map's engine rings its hovered point — or none. */
  hover: (at: { lat: number; lng: number } | null) => void
  /** A point about to be added (a dialog is open), marked as the flat map marks it — or none. */
  pending: (at: { lat: number; lng: number } | null) => void
  /** A drawing in progress: a path's vertices or a lasso's samples, as a dashed line with a dot per vertex; closed for an area. */
  draft: (d: { points: { lat: number; lng: number }[]; closed: boolean } | null) => void
  dispose: () => void
  count: { legs: number; points: number }
}

/** Points binned by latitude and longitude, each cell with the sphere that bounds its members. */
interface PointGrid {
  offsets: Uint32Array
  members: Uint32Array
  centre: Float32Array
  radius: Float32Array
  cells: number
}

function buildGrid(lat: Float32Array, lng: Float32Array, pos: Float32Array): PointGrid {
  const n = lat.length
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (let i = 0; i < n; i++) {
    if (lat[i] < minLat) minLat = lat[i]
    if (lat[i] > maxLat) maxLat = lat[i]
    if (lng[i] < minLng) minLng = lng[i]
    if (lng[i] > maxLng) maxLng = lng[i]
  }
  // Up to 64 × 64 cells over the points' extent; a few points get a grid of one.
  const side = n < 64 ? 1 : 64
  const dLat = Math.max(1e-6, (maxLat - minLat) / side)
  const dLng = Math.max(1e-6, (maxLng - minLng) / side)
  const cells = side * side
  const cellOf = new Uint32Array(n)
  const counts = new Uint32Array(cells + 1)
  for (let i = 0; i < n; i++) {
    const r = Math.min(side - 1, Math.floor((lat[i] - minLat) / dLat))
    const c = Math.min(side - 1, Math.floor((lng[i] - minLng) / dLng))
    const cell = r * side + c
    cellOf[i] = cell
    counts[cell + 1]++
  }
  for (let c = 0; c < cells; c++) counts[c + 1] += counts[c]
  const offsets = counts
  const fill = new Uint32Array(offsets.subarray(0, cells))
  const members = new Uint32Array(n)
  const lo = new Float32Array(cells * 3).fill(Infinity)
  const hi = new Float32Array(cells * 3).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    const cell = cellOf[i]
    members[fill[cell]++] = i
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k]
      if (v < lo[cell * 3 + k]) lo[cell * 3 + k] = v
      if (v > hi[cell * 3 + k]) hi[cell * 3 + k] = v
    }
  }
  const centre = new Float32Array(cells * 3)
  const radius = new Float32Array(cells)
  for (let c = 0; c < cells; c++) {
    if (offsets[c] === offsets[c + 1]) continue
    const ex = (hi[c * 3] - lo[c * 3]) / 2
    const ey = (hi[c * 3 + 1] - lo[c * 3 + 1]) / 2
    const ez = (hi[c * 3 + 2] - lo[c * 3 + 2]) / 2
    centre[c * 3] = lo[c * 3] + ex
    centre[c * 3 + 1] = lo[c * 3 + 1] + ey
    centre[c * 3 + 2] = lo[c * 3 + 2] + ez
    radius[c] = Math.sqrt(ex * ex + ey * ey + ez * ez)
  }
  return { offsets, members, centre, radius, cells }
}

export function buildTrackLayer(arcs: GlobeArc[], points: GlobePoint[], onFrame?: () => void): TrackLayer {
  const group = new Group()
  // Legs add up where they overlap (additive blending), so the more there are the fainter each one is drawn: a
  // hundred thousand flights over Europe would otherwise burn to white. Ten thousand legs keep the full alpha.
  const BASE = Math.max(0.1, Math.min(0.85, (0.85 * 10_000) / Math.max(1, arcs.length)))
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1)

  // ── Legs ──
  const legPos = new Float32Array(arcs.length * 6)
  const legCol = new Uint8Array(arcs.length * 6)
  const legOn = new Uint8Array(arcs.length * 2).fill(255)
  const legIds: EntityId[] = new Array(arcs.length)
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i]
    const [x0, y0, z0] = xyz(a.startLat, a.startLng)
    const [x1, y1, z1] = xyz(a.endLat, a.endLng)
    const o = i * 6
    legPos[o] = x0
    legPos[o + 1] = y0
    legPos[o + 2] = z0
    legPos[o + 3] = x1
    legPos[o + 4] = y1
    legPos[o + 5] = z1
    const [r, g, b] = rgbOf(a.color)
    legCol[o] = legCol[o + 3] = r
    legCol[o + 1] = legCol[o + 4] = g
    legCol[o + 2] = legCol[o + 5] = b
    legIds[i] = a.id
  }
  const legGeo = new BufferGeometry()
  legGeo.setAttribute('color', new BufferAttribute(legCol, 3, true))
  const legOnAttr = new BufferAttribute(legOn, 1, true)
  legOnAttr.setUsage(DynamicDrawUsage)
  legGeo.setAttribute('on', legOnAttr)
  const lineMaterial = new ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_LINES, uniforms: { dim: { value: 1 }, base: { value: BASE }, size: { value: 1 } }, vertexColors: true, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending })
  const lines = new LineSegments(legGeo, lineMaterial)
  lines.frustumCulled = false
  lines.renderOrder = ORDER_LINES
  const lineRaycast = lines.raycast
  lines.raycast = () => {}
  group.add(lines)

  // ── Points ──
  const n = points.length
  const perm = shuffled(n)
  const ptPos = new Float32Array(n * 3)
  const ptCol = new Uint8Array(n * 3)
  const ptOn = new Uint8Array(n).fill(255)
  const ptIds: EntityId[] = new Array(n)
  const ptLat = new Float32Array(n)
  const ptLng = new Float32Array(n)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    const p = points[perm[i]]
    const [x, y, z] = xyz(p.lat, p.lng)
    const o = i * 3
    ptPos[o] = x
    ptPos[o + 1] = y
    ptPos[o + 2] = z
    if (x < lo[0]) lo[0] = x
    if (x > hi[0]) hi[0] = x
    if (y < lo[1]) lo[1] = y
    if (y > hi[1]) hi[1] = y
    if (z < lo[2]) lo[2] = z
    if (z > hi[2]) hi[2] = z
    const [r, g, b] = rgbOf(p.color)
    ptCol[o] = r
    ptCol[o + 1] = g
    ptCol[o + 2] = b
    ptIds[i] = p.id
    ptLat[i] = p.lat
    ptLng[i] = p.lng
  }
  // The sphere around all the points, for the draw budget.
  const extent = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
  const extentR = n ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 : 0
  // The local origin: the centre of everything's extent (legs count too, so a scene of legs alone is centred as well).
  for (let i = 0; i < legPos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (legPos[i + k] < lo[k]) lo[k] = legPos[i + k]
      if (legPos[i + k] > hi[k]) hi[k] = legPos[i + k]
    }
  }
  const origin = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
  if (!Number.isFinite(origin.x)) origin.set(0, 0, 0)
  for (let i = 0; i < legPos.length; i += 3) {
    legPos[i] -= origin.x
    legPos[i + 1] -= origin.y
    legPos[i + 2] -= origin.z
  }
  for (let i = 0; i < ptPos.length; i += 3) {
    ptPos[i] -= origin.x
    ptPos[i + 1] -= origin.y
    ptPos[i + 2] -= origin.z
  }
  legGeo.setAttribute('position', new BufferAttribute(legPos, 3))
  lines.position.copy(origin)
  const ptGeo = new BufferGeometry()
  ptGeo.setAttribute('position', new BufferAttribute(ptPos, 3))
  ptGeo.setAttribute('color', new BufferAttribute(ptCol, 3, true))
  const ptOnAttr = new BufferAttribute(ptOn, 1, true)
  ptOnAttr.setUsage(DynamicDrawUsage)
  ptGeo.setAttribute('on', ptOnAttr)
  // A dot is a few screen pixels whatever the distance — not a disc of kilometres: sized in world units, a city's
  // 688,335 trees were each ten kilometres across up close, one smear over the map and a frame a second of overdraw.
  // How many pixels follows how crowded they are on screen (see `beforeRender`): a city seen from orbit packs
  // several to a pixel and gets the smallest dot; a street with a tree every fifty pixels gets the flat map's.
  const DOT_MIN = 3
  const DOT_MAX = 6
  let dotSize = DOT_MIN
  const pointMaterial = new ShaderMaterial({ defines: { POINTS: '' }, vertexShader: VERT, fragmentShader: FRAG_POINTS, uniforms: { dim: { value: 1 }, base: { value: 1 }, size: { value: DOT_MIN * pixelRatio } }, vertexColors: true, transparent: true, depthWrite: false, depthTest: false })
  const dots = new Points(ptGeo, pointMaterial)
  dots.position.copy(origin)
  dots.frustumCulled = false
  dots.renderOrder = ORDER_POINTS
  dots.raycast = () => {}
  group.add(dots)
  let grid = buildGrid(ptLat, ptLng, ptPos)
  let gridStale = false
  // Before each render: the camera's altitude (the highlight is sized to it) and the draw budget — the points'
  // sphere projected to a disc on screen, a few points per pixel of it. (On both objects, so a scene of legs alone
  // keeps up too.)
  let drawn = n
  let altitude = 2.5
  const camPos = new Vector3()
  let placeHighlight: (() => void) | null = null
  const beforeRender = (renderer: { domElement: HTMLCanvasElement }, _scene: unknown, camera: unknown) => {
    const cam = camera as PerspectiveCamera
    camPos.setFromMatrixPosition(cam.matrixWorld)
    altitude = camPos.length() / R - 1
    onFrame?.()
    placeHighlight?.()
    marks.hover?.place()
    marks.pending?.forEach((m) => m.place())
    marks.draft?.place()
    const tanHalf = Math.tan(((cam.fov ?? 50) * Math.PI) / 360)
    const heightPx = renderer.domElement.height / pixelRatio
    // Globe units per screen pixel at the surface below the camera, and from it the points' crowding: how many
    // of them share a pixel if they were spread evenly over their extent.
    const unitsPerPx = (2 * Math.max(1e-6, altitude * R) * tanHalf) / heightPx
    const density = extentR > 0 ? (n * unitsPerPx * unitsPerPx) / (Math.PI * extentR * extentR) : 0
    const size = Math.max(DOT_MIN, Math.min(DOT_MAX, 0.7 / Math.sqrt(Math.max(1e-9, density))))
    if (Math.abs(size - dotSize) > 0.1) {
      dotSize = size
      pointMaterial.uniforms.size.value = size * pixelRatio
    }
    if (n <= DRAW_FLOOR) return
    const dist = camPos.distanceTo(extent) - extentR
    let k = n
    if (dist > 0) {
      const radiusPx = (extentR * heightPx) / (2 * dist * tanHalf)
      k = Math.min(n, Math.max(DRAW_FLOOR, Math.round(Math.PI * radiusPx * radiusPx * DRAW_DENSITY)))
    }
    if (k !== drawn) {
      drawn = k
      ptGeo.setDrawRange(0, k)
    }
  }
  dots.onBeforeRender = beforeRender
  lines.onBeforeRender = beforeRender

  // ── Filtering ──
  let shown: readonly { id: EntityId }[] | undefined
  let ptIndex: Map<EntityId, number> | undefined
  let legIndex: Map<EntityId, number[]> | undefined
  const filter: TrackLayer['filter'] = (visible, selected) => {
    // With something selected the rest fades well back, so the bright feature reads on its own.
    pointMaterial.uniforms.dim.value = selected !== null ? 0.35 : 1
    // Legs fade to 0.15 of their alpha, but never below 0.04 — nor, with a hundred thousand legs already fainter than that, above where they were.
    lineMaterial.uniforms.dim.value = selected !== null ? Math.min(1, Math.max(0.15, 0.04 / BASE)) : 1
    if (visible === shown) return
    shown = visible
    if (!visible) {
      ptOn.fill(255)
      legOn.fill(255)
    } else {
      // The maps by id are built on the first filtered call: a map with no time window never asks.
      if (!ptIndex) {
        ptIndex = new Map()
        for (let i = 0; i < ptIds.length; i++) ptIndex.set(ptIds[i], i)
        legIndex = new Map()
        for (let i = 0; i < legIds.length; i++) {
          const l = legIndex.get(legIds[i])
          if (l) l.push(i)
          else legIndex.set(legIds[i], [i])
        }
      }
      ptOn.fill(0)
      legOn.fill(0)
      for (const f of visible) {
        const i = ptIndex.get(f.id)
        if (i !== undefined) ptOn[i] = 255
        const ls = legIndex!.get(f.id)
        if (ls) for (const l of ls) legOn[l * 2] = legOn[l * 2 + 1] = 255
      }
    }
    ptOnAttr.needsUpdate = true
    legOnAttr.needsUpdate = true
  }

  // ── The selected feature ──
  const tubeMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false })
  const ringMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false, depthTest: false })
  const dotMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, depthTest: false })
  let tube: Mesh | null = null
  let ring: Mesh | null = null
  let ringDot: Mesh | null = null
  let ringAnim = 0
  const noRaycast = () => {}
  const clearHighlight = () => {
    if (tube) (group.remove(tube), tube.geometry.dispose(), (tube = null))
    if (ring) (group.remove(ring), ring.geometry.dispose(), (ring = null))
    if (ringDot) (group.remove(ringDot), ringDot.geometry.dispose(), (ringDot = null))
    if (ringAnim) (cancelAnimationFrame(ringAnim), (ringAnim = 0))
    placeHighlight = null
  }
  const highlight: TrackLayer['highlight'] = (h) => {
    clearHighlight()
    if (!h) return
    if (h.kind === 'track') {
      if (h.points.length < 2) return
      const pts = h.points.map((p) => new Vector3(...xyz(p.lat, p.lng)))
      // A smooth curve through the samples, thickness in globe units (radius 100).
      const curve = new CatmullRomCurve3(pts, false, 'centripetal')
      const t = new Mesh(new TubeGeometry(curve, Math.min(400, Math.max(8, pts.length * 6)), 0.22, 6, false), tubeMaterial)
      t.raycast = noRaycast
      t.frustumCulled = false
      t.renderOrder = ORDER_HIGHLIGHT
      group.add((tube = t))
    } else {
      const at = new Vector3(...xyz(h.lat, h.lng))
      const up = at.clone().normalize()
      const r = new Mesh(new RingGeometry(0.75, 1, 40), ringMaterial)
      r.position.copy(at)
      r.lookAt(at.clone().add(up))
      r.raycast = noRaycast
      r.frustumCulled = false
      r.renderOrder = ORDER_HIGHLIGHT
      group.add((ring = r))
      const d = new Mesh(new RingGeometry(0, 0.28, 24), dotMaterial)
      d.position.copy(at)
      d.lookAt(at.clone().add(up))
      d.raycast = noRaycast
      d.frustumCulled = false
      d.renderOrder = ORDER_HIGHLIGHT
      group.add((ringDot = d))
      // The ring swells and fades, over and over, so the spot is found among five thousand dots.
      const t0 = performance.now()
      let k = 1
      const pulse = () => {
        if (!ring) return
        const t = ((performance.now() - t0) % 1100) / 1100
        k = 1 + 2.2 * t
        ringMaterial.opacity = 0.9 * (1 - t)
        ringAnim = requestAnimationFrame(pulse)
      }
      pulse()
      // Sized to the view — a share of its height at any altitude, from orbit to a street — so it neither vanishes
      // far away nor swallows the city close up.
      placeHighlight = () => {
        const size = Math.min(1, altitude * 1.4)
        r.scale.setScalar(k * size)
        d.scale.setScalar(size)
      }
    }
  }

  // ── Picking ──
  /** The visible point nearest the ray within `thr` world units, on the near side of the globe, or -1. */
  const pickPoint = (ray: Raycaster, thr: number): number => {
    // The ray in the points' local frame (a translation, so distances are the same).
    const ox = ray.ray.origin.x - origin.x
    const oy = ray.ray.origin.y - origin.y
    const oz = ray.ray.origin.z - origin.z
    const { x: dx, y: dy, z: dz } = ray.ray.direction
    if (gridStale) {
      grid = buildGrid(ptLat, ptLng, ptPos)
      gridStale = false
    }
    const { offsets, members, centre, radius, cells } = grid
    let best = -1
    let bestD = thr * thr
    for (let c = 0; c < cells; c++) {
      const start = offsets[c]
      const end = offsets[c + 1]
      if (start === end) continue
      // The cell's bounding sphere against the ray: skip the cell unless the ray comes within reach of it.
      const vx = centre[c * 3] - ox
      const vy = centre[c * 3 + 1] - oy
      const vz = centre[c * 3 + 2] - oz
      const t = vx * dx + vy * dy + vz * dz
      const r = radius[c]
      if (t + r < 0) continue
      const reach = thr + r
      if (vx * vx + vy * vy + vz * vz - t * t > reach * reach) continue
      for (let k = start; k < end; k++) {
        const i = members[k]
        if (i >= drawn || ptOn[i] === 0) continue
        const px = ptPos[i * 3]
        const py = ptPos[i * 3 + 1]
        const pz = ptPos[i * 3 + 2]
        const wx = px - ox
        const wy = py - oy
        const wz = pz - oz
        const s = wx * dx + wy * dy + wz * dz
        if (s < 0) continue
        const d2 = wx * wx + wy * wy + wz * wz - s * s
        if (d2 >= bestD) continue
        // Beyond the horizon — the point's tangent plane has the eye on the far side — it is hidden by the globe.
        const gx = px + origin.x
        const gy = py + origin.y
        const gz = pz + origin.z
        if (gx * ray.ray.origin.x + gy * ray.ray.origin.y + gz * ray.ray.origin.z <= gx * gx + gy * gy + gz * gz) continue
        bestD = d2
        best = i
      }
    }
    return best
  }
  const pick: TrackLayer['pick'] = (ray) => {
    const i = pickPoint(ray, ray.params.Points.threshold)
    if (i >= 0) return ptIds[i]
    if (!arcs.length) return undefined
    const hits: Parameters<typeof lineRaycast>[1] = []
    lineRaycast.call(lines, ray, hits)
    hits.sort((a, b) => a.distance - b.distance)
    const eye = ray.ray.origin
    for (const h of hits) {
      const leg = Math.floor((h.index ?? 0) / 2)
      if (legOn[leg * 2] === 0) continue
      const p = h.point
      if (p.dot(eye) <= p.lengthSq()) continue
      return legIds[leg]
    }
    return undefined
  }

  // ── The pointer's marks: the hovered point, a pending one, a drawing in progress ──
  // Flat rings on the surface, sized to the view like the selection ring; no depth test, drawn last.
  const hoverMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: DoubleSide, depthWrite: false, depthTest: false })
  const pendingMaterial = new MeshBasicMaterial({ color: 0xe9a23b, transparent: true, opacity: 0.95, side: DoubleSide, depthWrite: false, depthTest: false })
  const draftMaterial = new LineBasicMaterial({ color: 0x1f1e1b, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false })
  const draftDotMaterial = new MeshBasicMaterial({ color: 0x1f1e1b, depthWrite: false, depthTest: false })
  /** A ring (inner, outer radius in view units) facing up at a point, kept sized to the view. */
  const markAt = (at: { lat: number; lng: number }, material: MeshBasicMaterial, inner: number, outer: number, order: number): { mesh: Mesh; place: () => void } => {
    const p = new Vector3(...xyz(at.lat, at.lng))
    const mesh = new Mesh(new RingGeometry(inner, outer, 32), material)
    mesh.position.copy(p)
    mesh.lookAt(p.clone().add(p.clone().normalize()))
    mesh.raycast = noRaycast
    mesh.frustumCulled = false
    mesh.renderOrder = order
    group.add(mesh)
    return { mesh, place: () => mesh.scale.setScalar(Math.min(1, altitude * 1.4)) }
  }
  const marks: { hover?: { mesh: Mesh; place: () => void }; pending?: { mesh: Mesh; place: () => void }[]; draft?: { line: Line; dots: Mesh[]; place: () => void } } = {}
  const dropMark = (m: { mesh: Mesh } | undefined) => {
    if (!m) return
    group.remove(m.mesh)
    m.mesh.geometry.dispose()
  }
  const hover: TrackLayer['hover'] = (at) => {
    dropMark(marks.hover)
    marks.hover = at ? markAt(at, hoverMaterial, 0.55, 0.75, ORDER_HIGHLIGHT + 1) : undefined
    marks.hover?.place()
  }
  const pending: TrackLayer['pending'] = (at) => {
    marks.pending?.forEach(dropMark)
    marks.pending = at ? [markAt(at, pendingMaterial, 0, 0.3, ORDER_HIGHLIGHT + 2), markAt(at, pendingMaterial, 0.6, 0.8, ORDER_HIGHLIGHT + 2)] : undefined
    marks.pending?.forEach((m) => m.place())
  }
  const dropDraft = () => {
    const d = marks.draft
    if (!d) return
    group.remove(d.line)
    d.line.geometry.dispose()
    for (const dot of d.dots) {
      group.remove(dot)
      dot.geometry.dispose()
    }
    marks.draft = undefined
  }
  const draft: TrackLayer['draft'] = (d) => {
    dropDraft()
    if (!d || !d.points.length) return
    const pts = d.points.map((p) => new Vector3(...xyz(p.lat, p.lng)))
    if (d.closed && pts.length > 2) pts.push(pts[0].clone())
    const geo = new BufferGeometry().setFromPoints(pts)
    const line = new Line(geo, draftMaterial)
    line.raycast = noRaycast
    line.frustumCulled = false
    line.renderOrder = ORDER_HIGHLIGHT + 3
    group.add(line)
    // A dot per vertex on a path, so it reads as points joined; a lasso's samples are too many to mark.
    const dots = d.closed ? [] : d.points.map((p) => markAt(p, draftDotMaterial, 0, 0.22, ORDER_HIGHLIGHT + 4))
    marks.draft = { line, dots: dots.map((x) => x.mesh), place: () => dots.forEach((x) => x.place()) }
    marks.draft.place()
  }
  const indexOf: TrackLayer['indexOf'] = (id) => {
    if (!ptIndex) {
      ptIndex = new Map()
      for (let i = 0; i < ptIds.length; i++) ptIndex.set(ptIds[i], i)
    }
    return ptIndex.get(id) ?? -1
  }
  const setPlace: TrackLayer['setPlace'] = (i, lat, lng) => {
    if (i < 0 || i >= n) return
    const [x, y, z] = xyz(lat, lng)
    ptPos[i * 3] = x - origin.x
    ptPos[i * 3 + 1] = y - origin.y
    ptPos[i * 3 + 2] = z - origin.z
    ptLat[i] = lat
    ptLng[i] = lng
    ;(ptGeo.getAttribute('position') as BufferAttribute).needsUpdate = true
    gridStale = true
  }

  const dispose = () => {
    clearHighlight()
    hover(null)
    pending(null)
    dropDraft()
    hoverMaterial.dispose()
    pendingMaterial.dispose()
    draftMaterial.dispose()
    draftDotMaterial.dispose()
    legGeo.dispose()
    ptGeo.dispose()
    lineMaterial.dispose()
    pointMaterial.dispose()
    tubeMaterial.dispose()
    ringMaterial.dispose()
    dotMaterial.dispose()
  }
  return { group, filter, highlight, pick, indexOf, setPlace, hover, pending, draft, dispose, count: { legs: arcs.length, points: points.length } }
}

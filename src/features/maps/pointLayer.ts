/**
 * Every location on the map as a point, drawn by Unigraph's engine on a
 * canvas over the tiles — the whole inventory at every zoom, no bubbles,
 * no element per pin. The engine draws a million nodes; a city's trees
 * are 688,335 of them, coloured by tag as its node types, and a zoom or a
 * pan is one camera update, not a redraw of anything.
 *
 * Leaflet owns the map: the tiles, the shapes, the panning and zooming,
 * the mouse. This layer keeps the engine's flat camera on Leaflet's view
 * — on every `move`, exactly; through a zoom animation, the same easing
 * over the same fixed point, frame by frame — and answers hit tests
 * through the engine's grid, so a hover, a click or a drag on a point is
 * Leaflet's mouse event and `pick`.
 *
 * World units are Web Mercator pixels at BASE_ZOOM about a local origin
 * (the points' centre): a float32 holds a city to a hundredth of a pixel
 * at that zoom, and would not hold the whole world.
 */
import L from 'leaflet'
import { packColor } from '../../core/packed/color'
import { GraphEngine } from '../gpugraph/engine/engine'
import { BASE_ZOOM, mercX, mercY, type PinIndex } from './pinIndex'
import { bezier, cameraFor, fixedPointOfZoom } from './pointMath'

/** Leaflet's zoom animation: 250 ms of cubic-bezier(0, 0, 0.25, 1) on the pane's transform. */
const ZOOM_MS = 250
const ease = bezier(0, 0, 0.25, 1)

/** A link between two located features, by feature index, with the colour to draw it in. */
export type MapLink = [from: number, to: number, color: string]

/** How big a point is drawn, in px at its largest (the engine shrinks them when crowded). */
const POINT_PX = 6
const SELECTED_PX = 9

export class MapPointLayer {
  readonly el: HTMLDivElement
  readonly engine = new GraphEngine()
  private map: L.Map
  private ready = false
  private pending: (() => void) | null = null
  /** World origin: Mercator pixels at BASE_ZOOM of the points' centre. */
  private ox = 0
  private oy = 0
  /** Node index → feature index, and back. */
  private featureOf: Uint32Array = new Uint32Array(0)
  private nodeOf = new Map<number, number>()
  private anim: number | null = null
  private hovered = -1
  private selectedNode = -1
  private offs: (() => void)[] = []
  private ro: ResizeObserver

  constructor(map: L.Map) {
    this.map = map
    const el = document.createElement('div')
    el.className = 'geo-points'
    map.getContainer().appendChild(el)
    this.el = el
    this.engine.labelMode = 'none'
    this.engine.camera.minScale = 1e-7
    this.engine.camera.maxScale = 1e3
    this.engine.attach(el, { transparent: true })
    this.offs.push(this.engine.on('ready', () => {
      this.ready = true
      this.pending?.()
      this.pending = null
      this.sync()
    }))
    map.on('move', this.sync)
    map.on('zoomanim', this.onZoomAnim)
    map.on('zoomend', this.onZoomEnd)
    // The engine holds its picture through a resize — it pans its camera by what the container's centre moved,
    // which is what a graph view wants — but this camera is Leaflet's view, and Leaflet keeps its centre. Observed
    // after the engine's own observer (they fire in the order they were made), so the camera is put back on the
    // view in the same layout step; the points otherwise sat off their streets after a panel opened or closed, by
    // more the further in the map was zoomed.
    this.ro = new ResizeObserver(() => this.sync())
    this.ro.observe(el)
  }

  destroy() {
    const m = this.map
    m.off('move', this.sync)
    m.off('zoomanim', this.onZoomAnim)
    m.off('zoomend', this.onZoomEnd)
    if (this.anim) cancelAnimationFrame(this.anim)
    this.ro.disconnect()
    for (const off of this.offs) off()
    this.engine.destroy()
    this.el.remove()
  }

  /**
   * The points to draw — the index's points, coloured by its palette — and the links among them: relationships whose
   * two ends are both points here, as `[from, to, colour]` by feature index, drawn as the engine's edges.
   */
  load(ix: PinIndex, links: MapLink[] = []) {
    const run = () => {
      const n = ix.order.length
      // The origin: the centre of the points' extent at BASE_ZOOM.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let k = 0; k < n; k++) {
        const f = ix.order[k]
        const x = mercX(ix.coords[2 * f + 1], BASE_ZOOM)
        const y = mercY(ix.coords[2 * f], BASE_ZOOM)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      this.ox = n ? (minX + maxX) / 2 : 0
      this.oy = n ? (minY + maxY) / 2 : 0
      const positions = new Float32Array(n * 3)
      const nodeType = new Uint16Array(n)
      this.featureOf = new Uint32Array(n)
      this.nodeOf = new Map()
      for (let k = 0; k < n; k++) {
        const f = ix.order[k]
        positions[3 * k] = mercX(ix.coords[2 * f + 1], BASE_ZOOM) - this.ox
        // The engine's y goes up; Mercator's goes down.
        positions[3 * k + 1] = this.oy - mercY(ix.coords[2 * f], BASE_ZOOM)
        nodeType[k] = ix.colorIdx[f]
        this.featureOf[k] = f
        this.nodeOf.set(f, k)
      }
      const typeColors = ix.palette.map((c) => packColor(c))
      // The links: one edge type per colour.
      const edgeColors: string[] = []
      const edgeSlot = new Map<string, number>()
      const kept = links.filter((l) => this.nodeOf.has(l[0]) && this.nodeOf.has(l[1]))
      const edgeSource = new Uint32Array(kept.length)
      const edgeTarget = new Uint32Array(kept.length)
      const edgeType = new Uint16Array(kept.length)
      kept.forEach(([a, b, color], e) => {
        edgeSource[e] = this.nodeOf.get(a)!
        edgeTarget[e] = this.nodeOf.get(b)!
        let slot = edgeSlot.get(color)
        if (slot === undefined) {
          slot = edgeColors.length
          edgeColors.push(color)
          edgeSlot.set(color, slot)
        }
        edgeType[e] = slot
      })
      this.engine.showEdges = kept.length > 0
      // What the layer holds, readable from the page (a smoke test's check, a person's curiosity in the inspector).
      this.el.dataset.points = String(n)
      this.el.dataset.links = String(kept.length)
      this.engine.loadPacked({ idPrefix: 'p', nodeType, edgeSource, edgeTarget, edgeType, positions, nodeTypes: ix.palette.map((_, i) => `c${i}`), edgeTypes: edgeColors.map((_, i) => `e${i}`), directed: true }, { typeColors, edgeTypeColors: edgeColors.map((c) => packColor(c)), size: () => POINT_PX })
      this.hovered = -1
      this.selectedNode = -1
      this.sync()
    }
    if (this.ready) run()
    else this.pending = run
  }

  /** The feature a container point is over, or -1. */
  pick(p: L.Point): number {
    const i = this.engine.pick(p.x, p.y)
    return i < 0 ? -1 : this.featureOf[i]
  }

  /** The selected feature drawn as such — bigger, ringed by the engine — or none. */
  setSelected(feature: number) {
    const node = feature < 0 ? -1 : (this.nodeOf.get(feature) ?? -1)
    if (node === this.selectedNode) return
    const size = (i: number, px: number) => {
      if (i < 0 || i >= this.featureOf.length) return
      this.engine.posr[i * 4 + 3] = px
      this.engine.setPosition(i, this.engine.posr[i * 4], this.engine.posr[i * 4 + 1])
    }
    size(this.selectedNode, POINT_PX)
    size(node, SELECTED_PX)
    this.selectedNode = node
    this.engine.setSelection(node >= 0 ? [node] : [], 'replace')
  }

  /** The feature the pointer is over, drawn as such (or none). */
  setHovered(feature: number) {
    const node = feature < 0 ? -1 : (this.nodeOf.get(feature) ?? -1)
    if (node === this.hovered) return
    this.hovered = node
    this.engine.setHover(node)
  }

  /** A point's place changed (a drag, an edit). */
  setPlace(feature: number, at: L.LatLng) {
    const node = this.nodeOf.get(feature)
    if (node === undefined) return
    this.engine.setPosition(node, mercX(at.lng, BASE_ZOOM) - this.ox, this.oy - mercY(at.lat, BASE_ZOOM))
  }

  // ── The camera on Leaflet's view ──

  /** The engine's camera at a Leaflet view: a centre and a zoom (fractional through an animation). */
  private setCamera(center: L.LatLng, zoom: number) {
    const cam = this.engine.camera
    const c = cameraFor(center, zoom, { x: this.ox, y: this.oy })
    cam.x = c.x
    cam.y = c.y
    cam.setScale(c.scale)
    cam.stop()
    this.engine.cameraChanged()
  }

  private sync = () => {
    if (this.anim) return
    this.setCamera(this.map.getCenter(), this.map.getZoom())
  }

  /**
   * Leaflet animates a zoom by scaling its panes about the point that stays put, over ZOOM_MS with its easing; the
   * camera follows the same curve, so the points sit on the tiles through the animation and land with them.
   */
  private onZoomAnim = (e: L.ZoomAnimEvent) => {
    if (this.anim) cancelAnimationFrame(this.anim)
    const m = this.map
    const size = m.getSize()
    const z0 = m.getZoom()
    const z1 = e.zoom
    const k1 = 2 ** (z1 - z0)
    if (Math.abs(k1 - 1) < 1e-9) return
    // The fixed point: where the target centre is now on screen, scaled about it, lands at the screen's centre.
    const { x: fx, y: fy } = fixedPointOfZoom(size, m.latLngToContainerPoint(e.center), k1)
    const wf = m.containerPointToLatLng([fx, fy])
    const wfx = mercX(wf.lng, BASE_ZOOM) - this.ox
    const wfy = this.oy - mercY(wf.lat, BASE_ZOOM)
    const s0 = 2 ** (z0 - BASE_ZOOM)
    const start = performance.now()
    const cam = this.engine.camera
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ZOOM_MS)
      const k = 1 + (k1 - 1) * ease(t)
      const s = s0 * k
      cam.setScale(s)
      // The world point under the fixed screen point stays there.
      cam.x = wfx - (fx - cam.width / 2) / s
      cam.y = wfy + (fy - cam.height / 2) / s
      cam.stop()
      this.engine.cameraChanged()
      this.anim = t < 1 ? requestAnimationFrame(step) : null
    }
    this.anim = requestAnimationFrame(step)
  }

  private onZoomEnd = () => {
    if (this.anim) cancelAnimationFrame(this.anim)
    this.anim = null
    this.sync()
  }
}

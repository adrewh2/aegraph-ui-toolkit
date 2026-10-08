import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { EntityId } from '../../core/entity/types'
import { arrangeStack, BEAT_HEIGHT, beatWidth, leafBlocks, placementKey, slidesBox, wireId, type BeatInfo, type BlockInfo, type CompositionLink, type DeckInfo, type LayerSwitches, type PlacedSlide, type SlideInfo, type StoryInfo, type WebBounds } from '../../core/slides/slides'
import { Composition, Leaf } from './Composition'
import { measureCard, type CardAnchors } from './cardAnchors'
import { measure } from '../../lib/measure'
import { multiply, type Mat4 } from './engine/mat4'
import type { EngineOverlay, GraphEngine } from './engine/engine'

/** The size a card is laid out at, in CSS px; the transform scales it to its width in the world. */
const CARD_W = 560
const CARD_H = 350
/** A block's plate is laid out smaller, so its boxes read at the same size on a card half as wide. */
const PLATE_W = 340
const PLATE_H = 212
/** A beat card's height as laid out; its width follows its shape (`beatWidth`). */
const BEAT_H = 64
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

interface Props {
  engine: GraphEngine | null
  /** The decks shown, their slides in order. */
  decks: DeckInfo[]
  /** Every block, for composed slides. */
  blocks: Map<EntityId, BlockInfo>
  /** Hang composed slides' blocks as plates of their own beneath them. */
  parts: boolean
  /** The stories whose decks are shown. */
  stories: StoryInfo[]
  /** The story layer, the spatial layer, and the finished slides (see `SlidesView`). */
  story: boolean
  spatial: boolean
  final: boolean
  /** A click on a beat: what it cites is selected. */
  onBeatClick: (beat: EntityId, keys: { shift: boolean; meta: boolean }) => void
  /** An entity's label, for a box that names none of its own. */
  labelOf: (id: EntityId) => string | undefined
  /** A click on a block's plate: what it shows is selected. */
  onBlockClick: (block: EntityId, keys: { shift: boolean; meta: boolean }) => void
  /** The slide in front: its beams drawn bright, the others dimmed. */
  focus?: EntityId
  onClick: (slide: EntityId, keys: { shift: boolean; meta: boolean }) => void
  /** A double-click: the camera turns to face the slide. */
  onOpen: (slide: EntityId) => void
  /** The slides and plates as placed, whenever they move (for the camera to fly to one), with the arrangement's key (`placementKey`). */
  onPlaced?: (placed: Map<EntityId, PlacedSlide>, key: string) => void
}

/**
 * The slide layer of the 3D view: every slide of the decks shown as a card
 * hung at a fixed place in the world above the graph, and a beam from each
 * card down to each node it shows. The cards are DOM — the text is the
 * browser's — placed by one `matrix3d` each, the view-projection matrix of
 * the orbit camera times the card's own frame, so they stand in the scene
 * with the right perspective and stay where they are as the camera orbits.
 * The beams are a 2D canvas over the picture.
 *
 * Nothing here is React per frame: the engine's `frame` event (after the
 * camera has been updated for the frame) writes the transforms and redraws
 * the beams; React renders the cards only when the slides change. Clicks
 * reach the cards through the engine's overlay hook (`GraphEngine.overlays`),
 * so a press on a card still orbits when dragged.
 */
export const SlideLayer = memo(function SlideLayer({ engine, decks, blocks, parts, stories, story, spatial, final, labelOf, focus, onClick, onOpen, onBlockClick, onBeatClick, onPlaced }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cards = useRef(new Map<EntityId, HTMLDivElement>())
  /** The view has been orbited, panned or zoomed by hand: the layer no longer frames it on its own. */
  const touched = useRef(false)
  const live = useRef({ onClick, onOpen, onBlockClick, onBeatClick, onPlaced, focus })
  live.current = { onClick, onOpen, onBlockClick, onBeatClick, onPlaced, focus }
  const slides = useMemo(() => {
    const m = new Map<EntityId, { slide: SlideInfo; deck: DeckInfo; index: number }>()
    for (const d of decks) d.slides.forEach((s, i) => m.set(s.id, { slide: s, deck: d, index: i }))
    return m
  }, [decks])
  /** The beats placed in the story layer — the chapters a shown slide realizes and their points — with their story and deck. */
  const beats = useMemo(() => {
    const m = new Map<EntityId, { beat: BeatInfo; story: StoryInfo; deck: DeckInfo; index: number; slide: EntityId }>()
    if (!story) return m
    const realized = new Map<EntityId, EntityId>()
    for (const d of decks) for (const s of d.slides) if (s.beat) realized.set(s.beat, s.id)
    const deckOf = new Map(decks.map((d) => [d.id, d]))
    for (const st of stories) {
      const deck = st.deck ? deckOf.get(st.deck) : undefined
      if (!deck) continue
      let chapter = -1
      let point = 0
      let slide: EntityId | undefined
      for (const b of st.beats) {
        if (b.kind === 'chapter') {
          chapter++
          point = 0
          slide = realized.get(b.id)
          if (slide) m.set(b.id, { beat: b, story: st, deck, index: chapter, slide })
        } else if (slide && b.parent && m.has(b.parent)) m.set(b.id, { beat: b, story: st, deck, index: point++, slide })
      }
    }
    return m
  }, [decks, stories, story])
  /** Which slide each card or blueprint belongs with, for lighting a slide's whole column — its beats, blueprint and itself. */
  const groupOf = useMemo(() => {
    const m = new Map<EntityId, EntityId>()
    for (const id of slides.keys()) {
      m.set(id, id)
      m.set(wireId(id), id)
    }
    for (const [id, b] of beats) m.set(id, b.slide)
    return m
  }, [slides, beats])
  /** The blocks hung as plates: each leaf block of a composed slide shown, once, with the deck of the first slide using it. */
  const plates = useMemo(() => {
    const m = new Map<EntityId, { block: BlockInfo; deck: DeckInfo; usedBy: Set<EntityId> }>()
    if (!parts || story || spatial) return m
    for (const d of decks)
      for (const s of d.slides)
        if (s.compose)
          for (const b of leafBlocks(s.compose, blocks)) {
            if (!m.has(b.id)) m.set(b.id, { block: b, deck: d, usedBy: new Set() })
            m.get(b.id)!.usedBy.add(s.id)
          }
    return m
  }, [decks, blocks, parts, story, spatial])

  useEffect(() => {
    if (!engine) return
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const host = root.parentElement?.querySelector<HTMLElement>('.gg-host') ?? null
    let bounds: WebBounds | null = null
    let boundsAt = -Infinity
    let placed: PlacedSlide[] = []
    let placedPlates: PlacedSlide[] = []
    let placedBeats: PlacedSlide[] = []
    let placedWires: PlacedSlide[] = []
    let links: CompositionLink[] = []
    const sw: LayerSwitches = { parts, story, spatial }
    let placedById = new Map<EntityId, PlacedSlide>()
    /** Where each card's boxes and blocks are on it, read once the card is first shown (a hidden card has no layout). */
    const anchors = new Map<EntityId, CardAnchors>()
    /** Each shown card's matrix this frame: card px → screen px, for anchors on it. */
    const mats = new Map<EntityId, Float32Array>()
    let hovered: EntityId | null = null
    let framed = false
    /** Each card's corners on screen this frame (x0 y0 … x3 y3), nearest card first, for hits. */
    let quads: { id: EntityId; q: Float64Array; back: boolean }[] = []
    const model = new Float32Array(16) as Mat4
    const screen = new Float32Array(16) as Mat4
    const tmp = new Float32Array(16) as Mat4
    const out = new Float32Array(16) as Mat4
    const pt = { x: 0, y: 0 }

    const place = (b: WebBounds) => {
      bounds = b
      const layers = arrangeStack(decks, blocks, stories, b, sw)
      placed = layers.slides
      placedPlates = layers.plates
      placedBeats = layers.beats
      placedWires = layers.wires
      links = layers.links
      placedById = new Map([...placed, ...placedPlates, ...placedBeats, ...placedWires].map((p) => [p.id, p]))
      live.current.onPlaced?.(placedById, placementKey(decks, sw))
    }
    // Asked at the moment of a fit — a scene's, a restore's, the button's — so a fit that lands before the layer has
    // placed anything (the picture's first frame races the layer's mount) still takes the slides in.
    engine.fitExtra = () => {
      const b = bounds ?? webBounds(engine)
      if (!b) return null
      const layers = placed.length ? { slides: placed, plates: placedPlates, beats: placedBeats, wires: placedWires } : arrangeStack(decks, blocks, stories, b, sw)
      const s = slidesBox([...layers.slides, ...layers.plates, ...layers.beats, ...layers.wires])
      if (!s) return null
      // The slides and the body of the web (to its 98th-percentile radius): what the picture is, framed whole — with
      // headroom over the slides, whose near edge the perspective lifts above the box when the camera is nearly level.
      const r = b.outer ?? b.radius
      return { box: { minX: Math.min(s.minX, b.cx - r), minY: Math.min(s.minY, b.cy - r), minZ: Math.min(s.minZ, b.cz - r), maxX: Math.max(s.maxX, b.cx + r), maxY: Math.max(s.maxY, b.cy + r) + b.radius * 0.45, maxZ: Math.max(s.maxZ, b.cz + r) }, replace: true }
    }
    /** Once the camera is at rest, a view that leaves slides out is framed to take them in — unless someone has moved it. */
    // Checked twice: as soon as the slides first hang (the view's first fit may have come before the layer was there
    // to be asked), at once; and again when the camera is at rest, gliding, after which the view is left alone.
    const frameIfOutside = (atRest: boolean) => {
      // Only over a view a fit placed — not a scene's camera, a remembered one, a tool's, the keys', a slide faced on
      // purpose — and not once the view has been handled by hand.
      if (framed || touched.current || live.current.focus || !placed.length || engine.dims !== 3 || !engine.atLastFit()) return
      const cam = engine.camera3
      if (cam.width <= 1) return
      if (atRest) framed = true
      // With blocks hung as plates the three layers read best nearly side-on — from the usual height above, the
      // plates on the near side of the ring sit over the web. The first framing levels the camera for them.
      if (!atRest && (placedPlates.length || placedBeats.length || placedWires.length) && cam.pitch > 0.24) {
        cam.pitch = 0.16
        engine.fit({ padding: 0.08, ms: 0 })
        return
      }
      cam.update()
      let outside = false
      for (const p of placed) if (cam.project(p.center[0], p.center[1], p.center[2], pt) <= 0 || pt.x < 0 || pt.x > cam.width || pt.y < 0 || pt.y > cam.height) outside = true
      if (outside) engine.fit({ padding: 0.04, ms: atRest ? 450 : 0 })
    }
    const onTouch = () => (touched.current = true)
    /** The web's centre and radius, re-read now and then; a change under a sixth of the radius keeps the slides where they hang. */
    let settle = 0
    const readBounds = (now: number, trailing = false) => {
      // Moving pictures (a layout landing, the live simulation) are re-read once a second, and once more a second
      // after the last frame, so the slides end where the picture came to rest.
      if (!trailing) {
        clearTimeout(settle)
        settle = window.setTimeout(() => {
          const before = bounds
          boundsAt = -Infinity
          readBounds(performance.now(), true)
          if (bounds !== before) engine.requestRender()
          frameIfOutside(true)
        }, 1100)
      }
      if (now - boundsAt < 1000 && bounds) return
      boundsAt = now
      const b = webBounds(engine)
      if (!b) return
      if (bounds) {
        const moved = Math.hypot(b.cx - bounds.cx, b.cy - bounds.cy, b.cz - bounds.cz)
        if (Math.abs(b.radius - bounds.radius) < bounds.radius / 6 && moved < bounds.radius / 6) return
      }
      const first = !placed.length
      place(b)
      if (first) frameIfOutside(false)
    }

    const sync = () => {
      if (engine.dims !== 3) return
      const cam = engine.camera3
      const W = cam.width, H = cam.height
      readBounds(performance.now())
      // Clip → CSS px: x' = W/2 (x + w), y' = H/2 (w − y); z kept so the matrix stays invertible (the layer is flat).
      screen.fill(0)
      screen[0] = W / 2
      screen[12] = W / 2
      screen[5] = -H / 2
      screen[13] = H / 2
      screen[10] = 1
      screen[15] = 1
      multiply(tmp, screen, cam.viewProj)
      const [ex, ey, ez] = cam.eye
      const nextQuads: { id: EntityId; q: Float64Array; w: number; back: boolean }[] = []
      mats.clear()
      /** A placed card's matrix (card px → screen px), its corners on screen, its depth; null when any corner is behind the eye. */
      const frame = (p: PlacedSlide, cw: number, ch: number) => {
        const s = p.width / cw
        const back = (ex - p.center[0]) * p.normal[0] + (ey - p.center[1]) * p.normal[1] + (ez - p.center[2]) * p.normal[2] < 0
        // Seen from behind, the card is drawn mirrored back so it still reads — from its top-right corner leftwards.
        const ux = back ? -p.u[0] : p.u[0], uy = back ? -p.u[1] : p.u[1], uz = back ? -p.u[2] : p.u[2]
        const ox = p.center[0] - (ux * p.width + p.v[0] * p.height) / 2
        const oy = p.center[1] - (uy * p.width + p.v[1] * p.height) / 2
        const oz = p.center[2] - (uz * p.width + p.v[2] * p.height) / 2
        model.fill(0)
        model[0] = ux * s
        model[1] = uy * s
        model[2] = uz * s
        model[4] = p.v[0] * s
        model[5] = p.v[1] * s
        model[6] = p.v[2] * s
        model[8] = p.normal[0] * s
        model[9] = p.normal[1] * s
        model[10] = p.normal[2] * s
        model[12] = ox
        model[13] = oy
        model[14] = oz
        model[15] = 1
        multiply(out, tmp, model)
        // Any corner at or behind the eye and the projection is not a card any more: hidden until it is in front again.
        const q = new Float64Array(8)
        let wSum = 0
        const corners = [0, 0, cw, 0, cw, ch, 0, ch]
        for (let k = 0; k < 4; k++) {
          const cx = corners[k * 2], cy = corners[k * 2 + 1]
          const w = out[3] * cx + out[7] * cy + out[15]
          if (w <= cam.near) return null
          q[k * 2] = (out[0] * cx + out[4] * cy + out[12]) / w
          q[k * 2 + 1] = (out[1] * cx + out[5] * cy + out[13]) / w
          wSum += w
        }
        return { q, wSum, back }
      }
      for (const [id, el] of cards.current) {
        const p = placedById.get(id)
        if (!p) {
          el.style.display = 'none'
          continue
        }
        const [cw, ch] = sizeOf(id, p)
        const f = frame(p, cw, ch)
        if (!f) {
          el.style.display = 'none'
          continue
        }
        el.style.display = ''
        if (!anchors.has(id)) anchors.set(id, measureCard(el))
        mats.set(id, Float32Array.from(out))
        el.style.transform = `matrix3d(${Array.from(out).join(',')})`
        el.style.zIndex = String(Math.max(1, 1_000_000 - Math.round(f.wSum)))
        el.classList.toggle('is-back', f.back)
        // A finished slide hidden (the layers under it alone) is still laid out — the blueprint is read from it — but
        // neither drawn nor hit.
        if (!(slides.has(id) && !final)) nextQuads.push({ id, q: f.q, w: f.wSum, back: f.back })
      }
      // The blueprints have no card of their own: their matrices are the slides' frames a level down.
      for (const p of placedWires) if (frame(p, CARD_W, CARD_H)) mats.set(p.id, Float32Array.from(out))
      nextQuads.sort((a, b) => a.w - b.w)
      quads = nextQuads
      drawBeams(W, H)
    }

    /** The size a card is laid out at. */
    const sizeOf = (id: EntityId, p: PlacedSlide): [number, number] => (plates.has(id) && !slides.has(id) ? [PLATE_W, PLATE_H] : beats.has(id) ? [Math.round((BEAT_H * p.width) / p.height), BEAT_H] : [CARD_W, CARD_H])

    /** A point on a card (its own px) on screen, or null when it is behind the eye. */
    const onCard = (id: EntityId, x: number, y: number, o: { x: number; y: number }) => {
      const m = mats.get(id)
      if (!m) return null
      const w = m[3] * x + m[7] * y + m[15]
      if (w <= engine.camera3.near) return null
      o.x = (m[0] * x + m[4] * y + m[12]) / w
      o.y = (m[1] * x + m[5] * y + m[13]) / w
      return o
    }

    /** Corners of a card's rectangle (its own px) on screen as a path; false when any is behind the eye. */
    const rectPath = (g: CanvasRenderingContext2D, id: EntityId, x: number, y: number, w: number, h: number) => {
      const c = { x: 0, y: 0 }
      g.beginPath()
      const pts = [x, y, x + w, y, x + w, y + h, x, y + h]
      for (let k = 0; k < 4; k++) {
        if (!onCard(id, pts[k * 2], pts[k * 2 + 1], c)) return false
        if (k === 0) g.moveTo(c.x, c.y)
        else g.lineTo(c.x, c.y)
      }
      g.closePath()
      return true
    }

    /**
     * The spatial layer: each slide's blueprint a level beneath it — the outer rectangle (the slide's frame), the inner
     * rectangles (the regions its composition gives each block, as measured on the slide's card, labelled with the beat
     * each realizes) and, faint inside them, the boxes — and dotted lines from its corners up to the finished slide's.
     */
    const drawWires = (g: CanvasRenderingContext2D, lit: Set<EntityId>, pass: boolean, lead: EntityId | null) => {
      const c = { x: 0, y: 0 }
      const d = { x: 0, y: 0 }
      for (const p of placedWires) {
        const sid = groupOf.get(p.id)
        const info = sid ? slides.get(sid) : undefined
        if (!sid || !info || lit.has(p.id) !== pass || !mats.has(p.id)) continue
        const on = pass
        const color = info.deck.color
        const dim = !on && !!lead
        g.globalAlpha = dim ? 0.12 : on ? 0.95 : 0.6
        g.strokeStyle = color
        g.lineWidth = on ? 1.8 : 1.2
        g.fillStyle = color
        if (rectPath(g, p.id, 0, 0, CARD_W, CARD_H)) {
          g.save()
          g.globalAlpha *= 0.06
          g.fill()
          g.restore()
          g.stroke()
        }
        const anchorsOf = anchors.get(sid)
        if (anchorsOf) {
          g.lineWidth = on ? 1.4 : 1
          for (const r of anchorsOf.regions) {
            if (!rectPath(g, p.id, r.x, r.y, r.w, r.h)) continue
            g.save()
            g.globalAlpha *= 0.22
            g.fill()
            g.restore()
            g.stroke()
            // The region names the point it makes visible, else its block.
            const block = blocks.get(r.block)
            const beat = block?.beat ? beats.get(block.beat)?.beat : undefined
            const label = beat?.label ?? block?.label ?? ''
            const e = { x: 0, y: 0 }
            // Sized by the rectangle it names, as seen: a far blueprint's labels shrink with it rather than float over it.
            const px = onCard(p.id, r.x + r.w / 2, r.y, e) && onCard(p.id, r.x + r.w / 2, r.y + r.h, d) ? Math.min(on ? 14 : 12, Math.hypot(e.x - d.x, e.y - d.y) * 0.34) : 0
            if (label && !dim && px >= 7 && onCard(p.id, r.x + r.w / 2, r.y + r.h / 2, c) && onCard(p.id, r.x, r.y + r.h / 2, d) && Math.abs(c.x - d.x) > 34) {
              g.save()
              g.globalAlpha = dim ? 0.15 : 0.9
              g.fillStyle = color
              g.font = `600 ${px.toFixed(1)}px system-ui, sans-serif`
              g.textAlign = 'center'
              g.textBaseline = 'middle'
              g.fillText(fitText(g, label, Math.abs(c.x - d.x) * 1.8), c.x, c.y)
              g.restore()
            }
          }
          g.save()
          g.globalAlpha *= 0.4
          g.lineWidth = 0.7
          for (const r of anchorsOf.refs) if (rectPath(g, p.id, r.x, r.y, r.w, r.h)) g.stroke()
          g.restore()
        }
        // Up to the finished slide: its four corners.
        if (final && mats.has(sid)) {
          g.setLineDash([2, 4])
          g.globalAlpha = dim ? 0.06 : on ? 0.6 : 0.3
          g.beginPath()
          for (const [x, y] of [[0, 0], [CARD_W, 0], [CARD_W, CARD_H], [0, CARD_H]]) if (onCard(p.id, x, y, c) && onCard(sid, x, y, d)) {
            g.moveTo(c.x, c.y)
            g.lineTo(d.x, d.y)
          }
          g.stroke()
          g.setLineDash([])
        }
      }
    }

    /**
     * The story layer: the outline as a directed path — an arrow from each beat to the next in reading order — beams
     * from each beat down to what it cites, and from each beat up into what realizes it: a chapter to its slide's frame
     * (on the blueprint, or on the slide when the spatial layer is folded), a point to the region its block takes.
     */
    const drawStory = (g: CanvasRenderingContext2D, lit: Set<EntityId>, pass: boolean, lead: EntityId | null, a: { x: number; y: number }, b: { x: number; y: number }, beams: (from: { x: number; y: number }, ids: Iterable<EntityId>, color: string, on: boolean) => void) => {
      const dim = !pass && !!lead
      for (const st of stories) {
        let prev: { id: EntityId; w: number; h: number } | null = null
        for (const bt of st.beats) {
          const info = beats.get(bt.id)
          const p = placedById.get(bt.id)
          if (!info || !p || !mats.has(bt.id)) continue
          const [cw, ch] = sizeOf(bt.id, p)
          const on = lit.has(bt.id)
          if (on === pass) {
            // Down to what it cites.
            if (onCard(bt.id, cw / 2, ch, a)) beams(a, bt.cites, info.deck.color, on)
            // Up into what realizes it.
            const target = spatial ? wireId(info.slide) : info.slide
            const anchorsOf = anchors.get(info.slide)
            let tx = CARD_W / 2, ty = CARD_H
            if (bt.kind === 'point' && anchorsOf) {
              const r = anchorsOf.regions.find((x) => blocks.get(x.block)?.beat === bt.id)
              if (r) {
                tx = r.x + r.w / 2
                ty = r.y + r.h
              }
            }
            if ((spatial || final) && mats.has(target) && onCard(bt.id, cw / 2, 0, a) && onCard(target, tx, ty, b)) {
              g.strokeStyle = info.deck.color
              g.globalAlpha = on ? 0.85 : dim ? 0.06 : 0.4
              g.lineWidth = on ? 1.6 : 1
              g.setLineDash([1, 3])
              g.beginPath()
              g.moveTo(a.x, a.y)
              g.lineTo(b.x, b.y)
              g.stroke()
              g.setLineDash([])
            }
          }
          // The directed path: from the previous beat's right edge to this one's left, an arrowhead at this end.
          if (prev && (lit.has(prev.id) || on) === pass && onCard(prev.id, prev.w, prev.h / 2, a) && onCard(bt.id, 0, ch / 2, b)) {
            g.strokeStyle = info.deck.color
            g.fillStyle = info.deck.color
            g.globalAlpha = pass ? 1 : dim ? 0.12 : 0.85
            g.lineWidth = pass ? 2.4 : 1.8
            g.beginPath()
            g.moveTo(a.x, a.y)
            g.lineTo(b.x, b.y)
            g.stroke()
            const ang = Math.atan2(b.y - a.y, b.x - a.x)
            const k = pass ? 9 : 7
            g.beginPath()
            g.moveTo(b.x, b.y)
            g.lineTo(b.x - k * Math.cos(ang - 0.45), b.y - k * Math.sin(ang - 0.45))
            g.lineTo(b.x - k * Math.cos(ang + 0.45), b.y - k * Math.sin(ang + 0.45))
            g.closePath()
            g.fill()
          }
          prev = { id: bt.id, w: cw, h: ch }
        }
      }
    }

    /**
     * Three kinds of line, in two passes (the dim ones under the lit): a slide's beams to what it shows (from just under
     * a plain card; from each bound box of a composed one when its blocks are not hung as plates), a composition line
     * from the region a block takes on a slide down to that block's plate, and a plate's beams from each box to its
     * entity. What is lit follows the slide or plate under the pointer, else the slide in front — with the plates it is
     * made of, or the slides a plate is used by.
     */
    const drawBeams = (W: number, H: number) => {
      const dpr = window.devicePixelRatio || 1
      const pw = Math.round(W * dpr), ph = Math.round(H * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      const g = canvas.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const cam = engine.camera3
      const lead = hovered ?? live.current.focus ?? null
      const lit = new Set<EntityId>()
      if (lead) {
        lit.add(lead)
        for (const l of links) {
          if (l.slide === lead) lit.add(l.block)
          if (l.block === lead) lit.add(l.slide)
        }
        // A slide, its beats and its blueprint light as one column.
        const group = groupOf.get(lead)
        if (group) for (const [id, gid] of groupOf) if (gid === group) lit.add(id)
      }
      const a = { x: 0, y: 0 }
      const b = { x: 0, y: 0 }
      const alphaOf = (on: boolean) => (on ? 0.7 : lead ? 0.05 : 0.2)
      for (const pass of [false, true]) {
        if (pass && !lead) break
        const beams = (from: { x: number; y: number }, ids: Iterable<EntityId>, color: string, on: boolean) => {
          g.strokeStyle = color
          g.fillStyle = color
          g.globalAlpha = alphaOf(on)
          g.lineWidth = on ? 1.4 : 1
          g.beginPath()
          const ends: number[] = []
          for (const id of ids) {
            const i = engine.nodeIndex(id)
            if (!engine.isShown(i) || !engine.projectNode(i, pt)) continue
            g.moveTo(from.x, from.y)
            g.lineTo(pt.x, pt.y)
            ends.push(pt.x, pt.y)
          }
          g.stroke()
          g.globalAlpha = on ? 0.95 : lead ? 0.08 : 0.35
          g.beginPath()
          for (let k = 0; k < ends.length; k += 2) {
            g.moveTo(ends[k] + (on ? 4 : 2.5), ends[k + 1])
            g.arc(ends[k], ends[k + 1], on ? 4 : 2.5, 0, Math.PI * 2)
          }
          if (on) {
            g.lineWidth = 1.6
            g.stroke()
          } else g.fill()
          g.globalAlpha = on ? 1 : 0.5
          g.beginPath()
          g.arc(from.x, from.y, on ? 3 : 2, 0, Math.PI * 2)
          g.fill()
        }
        /** Each bound box on a card beams to its entity. */
        const boxBeams = (card: EntityId, color: string, on: boolean) => {
          for (const r of anchors.get(card)?.refs ?? []) if (onCard(card, r.x + r.w / 2, r.y + r.h, a)) beams(a, [r.ref], color, on)
        }
        for (const p of placed) {
          const info = slides.get(p.id)
          // A finished slide hidden draws nothing of its own, its beams included.
          if (!info || !final || lit.has(p.id) !== pass) continue
          const on = pass
          if (!info.slide.compose) {
            // The beams leave from just under the card's lower edge, like light from a lens.
            const bx = p.center[0] + p.v[0] * p.height * 0.56, by = p.center[1] + p.v[1] * p.height * 0.56, bz = p.center[2] + p.v[2] * p.height * 0.56
            if (cam.project(bx, by, bz, a) > 0) beams(a, info.slide.members, info.deck.color, on)
          } else if (!plates.size && !story) boxBeams(p.id, info.deck.color, on)
        }
        if (spatial) drawWires(g, lit, pass, lead)
        if (story) drawStory(g, lit, pass, lead, a, b, beams)
        if (plates.size) {
          // Composition lines: dashed, from the bottom of a block's region on the slide to the top of its plate.
          g.setLineDash([5, 4])
          for (const l of links) {
            if (!final) break
            const on = lit.has(l.slide) && lit.has(l.block)
            if (on !== pass) continue
            const info = slides.get(l.slide)
            const region = anchors.get(l.slide)?.regions.find((r) => r.block === l.block)
            if (!info || !region || !onCard(l.slide, region.x + region.w / 2, region.y + region.h, a) || !onCard(l.block, PLATE_W / 2, 0, b)) continue
            g.strokeStyle = info.deck.color
            g.globalAlpha = on ? 0.9 : lead ? 0.08 : 0.45
            g.lineWidth = on ? 2 : 1.2
            g.beginPath()
            g.moveTo(a.x, a.y)
            g.lineTo(b.x, b.y)
            g.stroke()
          }
          g.setLineDash([])
          for (const p of placedPlates) {
            if (lit.has(p.id) !== pass) continue
            const info = plates.get(p.id)
            if (info) boxBeams(p.id, info.deck.color, pass)
          }
        }
      }
      g.globalAlpha = 1
    }

    const inQuad = (q: Float64Array, x: number, y: number) => {
      // Convex, either winding: the point is on the same side of all four edges.
      let sign = 0
      for (let k = 0; k < 4; k++) {
        const x0 = q[k * 2], y0 = q[k * 2 + 1], x1 = q[((k + 1) % 4) * 2], y1 = q[((k + 1) % 4) * 2 + 1]
        const c = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)
        if (c === 0) continue
        const sg = c > 0 ? 1 : -1
        if (sign === 0) sign = sg
        else if (sg !== sign) return false
      }
      return true
    }
    const slideAt = (x: number, y: number): EntityId | null => {
      if (engine.dims !== 3) return null
      for (const { id, q } of quads) if (inQuad(q, x, y)) return id
      return null
    }

    const overlay: EngineOverlay = {
      hit: (x, y) => slideAt(x, y) !== null,
      click: (x, y, keys) => {
        const id = slideAt(x, y)
        if (id && slides.has(id)) live.current.onClick(id, keys)
        else if (id && beats.has(id)) live.current.onBeatClick(id, keys)
        else if (id) live.current.onBlockClick(id, keys)
      },
      double: (x, y) => {
        const id = slideAt(x, y)
        if (id && slides.has(id)) live.current.onOpen(id)
      },
      // A picture of the view (a scene's card, an export) has the slides in it: the beams as drawn, and each card
      // painted from its corners — the far ones first.
      draw: (g, dpr) => {
        if (engine.dims !== 3) return
        g.save()
        g.drawImage(canvas, 0, 0, engine.camera3.width * dpr, engine.camera3.height * dpr)
        g.scale(dpr, dpr)
        const css = getComputedStyle(root)
        const colors = { surface: css.getPropertyValue('--surface').trim() || '#ffffff', text: css.getPropertyValue('--text').trim() || '#1f1e1b', muted: css.getPropertyValue('--text-muted').trim() || '#6d6b66' }
        for (let k = quads.length - 1; k >= 0; k--) {
          const { id, q, back } = quads[k]
          const info = slides.get(id)
          const plate = plates.get(id)
          if (info && !final) continue
          if (info) paintCard(g, q, info.slide, info.deck, info.index, back, live.current.focus, colors, anchors.get(id))
          else if (plate) paintPlate(g, q, plate.block, plate.deck, back, colors, anchors.get(id))
          else if (beats.has(id)) paintBeat(g, q, beats.get(id)!, cards.current.get(id), colors)
        }
        g.restore()
      },
    }
    engine.overlays.push(overlay)

    const setHovered = (id: EntityId | null) => {
      if (id === hovered) return
      if (hovered) cards.current.get(hovered)?.classList.remove('is-hovered')
      hovered = id
      if (id) cards.current.get(id)?.classList.add('is-hovered')
      drawBeams(engine.camera3.width, engine.camera3.height)
    }
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return
      const r = root.getBoundingClientRect()
      const id = slideAt(e.clientX - r.left, e.clientY - r.top)
      setHovered(id)
      if (id && host) host.style.cursor = 'pointer'
    }
    const onLeave = () => setHovered(null)
    host?.addEventListener('pointermove', onMove)
    host?.addEventListener('pointerleave', onLeave)
    host?.addEventListener('pointerdown', onTouch)
    host?.addEventListener('wheel', onTouch, { passive: true })
    const off = engine.on('frame', () => {
      const t0 = performance.now()
      sync()
      measure('gg:slides', { start: t0, end: performance.now() })
    })
    // Placed now, not at the next frame: the first fit (and the scene's) already counts the slides.
    readBounds(performance.now())
    engine.requestRender()
    sync()
    return () => {
      clearTimeout(settle)
      off()
      host?.removeEventListener('pointermove', onMove)
      host?.removeEventListener('pointerleave', onLeave)
      host?.removeEventListener('pointerdown', onTouch)
      host?.removeEventListener('wheel', onTouch)
      engine.overlays = engine.overlays.filter((o) => o !== overlay)
      engine.fitExtra = null
      const g = canvas.getContext('2d')
      g?.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [engine, decks, slides, blocks, plates, parts, beats, groupOf, stories, story, spatial, final])

  // The focus changes what is lit: redrawn at the next frame the engine draws.
  useEffect(() => {
    engine?.requestRender()
  }, [engine, focus])

  const cardRef = (id: EntityId) => (el: HTMLDivElement | null) => {
    if (el) cards.current.set(id, el)
    else cards.current.delete(id)
  }
  return (
    <div ref={rootRef} className="gg-slides" aria-label="Slides">
      <canvas ref={canvasRef} className="gg-slides__beams" />
      {decks.flatMap((d) =>
        d.slides.map((s, i) => (
          <div key={s.id} ref={cardRef(s.id)} className={`gg-slide${s.compose ? ' gg-slide--composed' : ''}${final ? '' : ' is-ghost'}${focus === s.id ? ' is-focus' : focus ? ' is-dim' : ''}`} style={{ width: CARD_W, height: CARD_H, ['--deck' as string]: d.color, display: 'none' }} data-slide={s.id}>
            <div className="gg-slide__head">
              <span className="gg-slide__deck">{d.label}</span>
              <span className="gg-slide__num">
                {i + 1} / {d.slides.length}
              </span>
            </div>
            {s.kicker && <div className="gg-slide__kicker">{s.kicker}</div>}
            <div className="gg-slide__title">{s.label}</div>
            {s.compose ? (
              <>
                {s.body && <div className="gg-slide__sub">{s.body.split('\n')[0].replace(/\*\*/g, '')}</div>}
                <div className="gg-slide__compose">
                  <Composition id={s.compose} blocks={blocks} labelOf={labelOf} />
                </div>
              </>
            ) : (
              <>
                <div className="gg-slide__body">{slideBody(s.body)}</div>
                <div className="gg-slide__foot">Shows {s.members.length.toLocaleString()}</div>
              </>
            )}
          </div>
        )),
      )}
      {[...beats.values()].map(({ beat, story: st, deck, index, slide }) => {
        const points = st.beats.filter((x) => x.kind === 'point' && x.parent === (beat.kind === 'chapter' ? beat.id : beat.parent)).length
        const h = BEAT_H
        const w = Math.round((BEAT_H * beatWidth(beat.kind, points)) / BEAT_HEIGHT)
        const first = beat.kind === 'chapter' && index === 0
        return (
          <div key={`beat:${beat.id}`} ref={cardRef(beat.id)} className={`gg-slide gg-beat gg-beat--${beat.kind}${focus && focus !== slide ? ' is-dim' : ''}`} style={{ width: w, height: h, ['--deck' as string]: deck.color, display: 'none' }} data-beat={beat.id} data-label={beat.label} data-num={beat.kind === 'chapter' ? (ROMAN[index] ?? String(index + 1)) : String.fromCharCode(97 + index)}>
            {first && <span className="gg-beat__story">{st.label}</span>}
            <span className="gg-beat__line">
              <span className="gg-beat__num">{beat.kind === 'chapter' ? (ROMAN[index] ?? index + 1) : String.fromCharCode(97 + index)}</span>
              <span className="gg-beat__label">{beat.label}</span>
            </span>
          </div>
        )
      })}
      {[...plates.values()].map(({ block, deck, usedBy }) => (
        <div key={`plate:${block.id}`} ref={cardRef(block.id)} className={`gg-slide gg-plate${focus && !usedBy.has(focus) ? ' is-dim' : ''}`} style={{ width: PLATE_W, height: PLATE_H, ['--deck' as string]: deck.color, display: 'none' }} data-block-plate={block.id}>
          <div className="gg-plate__title">{block.label}</div>
          <div className="gg-plate__body">
            <Leaf block={block} labelOf={labelOf} />
          </div>
        </div>
      ))}
    </div>
  )
})

/** A slide's text as React elements: `- ` lines as bullets, `**bold**` inline, the rest as paragraphs. Never HTML. */
function slideBody(text: string): ReactNode {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  const out: ReactNode[] = []
  let bullets: ReactNode[] = []
  const flush = () => {
    if (bullets.length) out.push(<ul key={`ul${out.length}`}>{bullets}</ul>)
    bullets = []
  }
  lines.forEach((l, k) => {
    const m = /^\s*[-*•]\s+(.*)$/.exec(l)
    if (m) bullets.push(<li key={k}>{inline(m[1])}</li>)
    else {
      flush()
      out.push(<p key={k}>{inline(l.trim())}</p>)
    }
  })
  flush()
  return out
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part))
}

/**
 * Where the web is, for hanging slides over it: the centre of the nodes shown and the distance within which nine in
 * ten of them lie (and within which 98 in 100 do, which the ring clears) — not the extent, which one far-flung node (an isolated one, a long chain) can double, leaving the
 * ring of slides far out over a small cloud. A sample of at most 20,000 nodes stands for a bigger picture.
 */
function webBounds(engine: GraphEngine): WebBounds | null {
  const n = engine.graph.nodeCount
  const step = Math.max(1, Math.floor(n / 20_000))
  const p = engine.posr
  let cx = 0, cy = 0, cz = 0, k = 0
  for (let i = 0; i < n; i += step) {
    if (!engine.isShown(i)) continue
    cx += p[i * 4]
    cy += p[i * 4 + 1]
    cz += p[i * 4 + 2]
    k++
  }
  if (!k) return null
  cx /= k
  cy /= k
  cz /= k
  const d = new Float32Array(k)
  let j = 0
  for (let i = 0; i < n && j < k; i += step) if (engine.isShown(i)) d[j++] = Math.hypot(p[i * 4] - cx, p[i * 4 + 1] - cy, p[i * 4 + 2] - cz)
  d.sort()
  const radius = d[Math.min(k - 1, Math.floor(k * 0.9))] || 1
  const outer = d[Math.min(k - 1, Math.floor(k * 0.98))] || radius
  return { cx, cy, cz, radius, outer }
}

/**
 * A card painted onto a 2D canvas from its four corners on screen, for a snapshot of the view: the card's own layout
 * (CARD_W × CARD_H) mapped by the affine transform of three of its corners — exact for a card seen square on, close
 * enough for a picture of one seen at an angle. The DOM cards are what is read; this is what is photographed.
 */
function paintCard(g: CanvasRenderingContext2D, q: Float64Array, slide: SlideInfo, deck: DeckInfo, index: number, back: boolean, focus: EntityId | undefined, c: { surface: string; text: string; muted: string }, anchors?: CardAnchors) {
  const [x0, y0, x1, y1, , , x3, y3] = q
  g.save()
  g.globalAlpha = back ? 0.55 : focus && focus !== slide.id ? 0.45 : 1
  g.setTransform(g.getTransform().multiply(new DOMMatrix([(x1 - x0) / CARD_W, (y1 - y0) / CARD_W, (x3 - x0) / CARD_H, (y3 - y0) / CARD_H, x0, y0])))
  if (slide.compose && anchors) {
    paintFrame(g, CARD_W, CARD_H, deck.color, c)
    g.textBaseline = 'top'
    g.font = '600 13px system-ui, sans-serif'
    g.fillStyle = deck.color
    g.fillText(fitText(g, `${deck.label.toUpperCase()}   ${index + 1} / ${deck.slides.length}`, CARD_W - 64), 32, 30)
    g.font = '700 24px system-ui, sans-serif'
    g.fillStyle = c.text
    g.fillText(fitText(g, slide.label, CARD_W - 64), 32, slide.kicker ? 74 : 54)
    paintAnchors(g, anchors, deck.color, c)
    g.restore()
    return
  }
  g.fillStyle = c.surface
  g.strokeStyle = deck.color
  g.lineWidth = 2
  g.beginPath()
  g.roundRect(0, 0, CARD_W, CARD_H, 10)
  g.fill()
  g.stroke()
  g.fillStyle = deck.color
  g.fillRect(0, 0, CARD_W, 10)
  g.textBaseline = 'top'
  const fit = (t: string, w: number) => {
    if (g.measureText(t).width <= w) return t
    let s = t
    while (s.length > 1 && g.measureText(`${s}…`).width > w) s = s.slice(0, -1)
    return `${s}…`
  }
  let y = 30
  g.font = '600 13px system-ui, sans-serif'
  g.fillStyle = deck.color
  g.fillText(fit(`${deck.label.toUpperCase()}   ${index + 1} / ${deck.slides.length}`, CARD_W - 64), 32, y)
  y += 26
  if (slide.kicker) {
    g.font = '600 14px system-ui, sans-serif'
    g.fillText(fit(slide.kicker, CARD_W - 64), 32, y)
    y += 22
  }
  g.font = '700 30px system-ui, sans-serif'
  g.fillStyle = c.text
  g.fillText(fit(slide.label, CARD_W - 64), 32, y)
  y += 46
  g.font = '18px system-ui, sans-serif'
  for (const line of slide.body.split('\n')) {
    const t = line.trim().replace(/\*\*/g, '')
    if (!t) continue
    if (y > CARD_H - 50) break
    g.fillText(fit(/^[-*•]\s+/.test(t) ? `•  ${t.replace(/^[-*•]\s+/, '')}` : t, CARD_W - 64), 32, y)
    y += 26
  }
  g.font = '13px system-ui, sans-serif'
  g.fillStyle = c.muted
  g.fillText(`Shows ${slide.members.length.toLocaleString()}`, 32, CARD_H - 34)
  g.restore()
}

/** A block's plate painted for a snapshot, like `paintCard`. */
function paintPlate(g: CanvasRenderingContext2D, q: Float64Array, block: BlockInfo, deck: DeckInfo, back: boolean, c: { surface: string; text: string; muted: string }, anchors?: CardAnchors) {
  const [x0, y0, x1, y1, , , x3, y3] = q
  g.save()
  g.globalAlpha = back ? 0.55 : 1
  g.setTransform(g.getTransform().multiply(new DOMMatrix([(x1 - x0) / PLATE_W, (y1 - y0) / PLATE_W, (x3 - x0) / PLATE_H, (y3 - y0) / PLATE_H, x0, y0])))
  paintFrame(g, PLATE_W, PLATE_H, deck.color, c)
  g.textBaseline = 'top'
  g.font = '600 13px system-ui, sans-serif'
  g.fillStyle = deck.color
  g.fillText(fitText(g, block.label.toUpperCase(), PLATE_W - 32), 16, 20)
  if (anchors) paintAnchors(g, anchors, deck.color, c)
  g.restore()
}

function paintFrame(g: CanvasRenderingContext2D, w: number, h: number, color: string, c: { surface: string }) {
  g.fillStyle = c.surface
  g.strokeStyle = color
  g.lineWidth = 2
  g.beginPath()
  g.roundRect(0, 0, w, h, 10)
  g.fill()
  g.stroke()
  g.fillStyle = color
  g.fillRect(0, 0, w, 8)
}

/** A card's measured blocks and boxes, painted where they are on it: the block titles, each box with its figure and label. */
function paintAnchors(g: CanvasRenderingContext2D, a: CardAnchors, color: string, c: { text: string; muted: string }) {
  g.textBaseline = 'top'
  for (const r of a.regions) {
    if (!r.title) continue
    g.font = '600 11px system-ui, sans-serif'
    g.fillStyle = c.muted
    g.fillText(fitText(g, r.title.toUpperCase(), r.w), r.x, r.y)
  }
  for (const r of a.refs) {
    g.strokeStyle = color
    g.lineWidth = 1.5
    g.beginPath()
    g.roundRect(r.x, r.y, r.w, r.h, 6)
    g.stroke()
    let y = r.y + 5
    if (r.value) {
      g.font = '700 15px system-ui, sans-serif'
      g.fillStyle = c.text
      g.fillText(fitText(g, r.value, r.w - 10), r.x + 6, y)
      y += 19
    }
    g.font = '12px system-ui, sans-serif'
    g.fillStyle = c.text
    if (y < r.y + r.h - 10) g.fillText(fitText(g, r.label, r.w - 10), r.x + 6, y)
  }
}

function fitText(g: CanvasRenderingContext2D, t: string, w: number) {
  if (g.measureText(t).width <= w) return t
  let s = t
  while (s.length > 1 && g.measureText(`${s}…`).width > w) s = s.slice(0, -1)
  return `${s}…`
}

/** A beat's card painted for a snapshot: its frame, its numeral and its line. */
function paintBeat(g: CanvasRenderingContext2D, q: Float64Array, info: { deck: DeckInfo }, el: HTMLDivElement | undefined, c: { surface: string; text: string }) {
  const [x0, y0, x1, y1, , , x3, y3] = q
  const w = el?.offsetWidth || 200, h = el?.offsetHeight || BEAT_H
  g.save()
  g.setTransform(g.getTransform().multiply(new DOMMatrix([(x1 - x0) / w, (y1 - y0) / w, (x3 - x0) / h, (y3 - y0) / h, x0, y0])))
  g.fillStyle = c.surface
  g.strokeStyle = info.deck.color
  g.lineWidth = 2
  g.beginPath()
  g.roundRect(0, 0, w, h, 8)
  g.fill()
  g.stroke()
  g.textBaseline = 'middle'
  g.font = '700 15px system-ui, sans-serif'
  g.fillStyle = info.deck.color
  g.fillText(el?.dataset.num ?? '', 10, h / 2)
  g.font = '600 13px system-ui, sans-serif'
  g.fillStyle = c.text
  g.fillText(fitText(g, el?.dataset.label ?? '', w - 40), 34, h / 2)
  g.restore()
}

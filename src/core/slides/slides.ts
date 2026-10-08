import { BookOpenText, GalleryHorizontalEnd, LayoutPanelTop, ListTree, RectangleHorizontal } from 'lucide-react'
import { createEntity, createRelationship, displayLabel } from '../entity/entity'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { EntityStore } from '../entity/store'
import { cssColor } from '../../lib/cssColor'
import type { AnyEntity, EntityData, EntityId } from '../entity/types'

/**
 * Decks and slides: the human-sized layer over a web too dense to read at
 * once. A **slide** is a rectangle with a title and a few lines, and it
 * *shows* some entities (`shows` relationships, slide → entity) — a
 * projection of a handful of things scattered across the web onto one page.
 * A **deck** is an ordered set of slides (each slide names its deck in
 * `data.deck`), with a colour.
 *
 * Both are `project`-category types, so the graph's Dataset stage leaves
 * them out of the picture: the web is drawn as it is, and Unigraph's 3D
 * view draws the slides as cards fixed in space above it, with a beam from
 * each card down to every node it shows (`features/gpugraph/SlideLayer`).
 * Which decks are up is the view's (`ExplorerState.slides`, a scene's
 * `view.slides`) — switching decks never moves the web.
 */

export const DECK_TYPE = 'deck'
export const SLIDE_TYPE = 'slide'
/** The relationship from a slide to each entity it draws on. */
export const SHOWS = 'shows'
/** A reusable piece of a slide: a flow, stats, a list, a timeline, text — or a row or column of other blocks. */
export const BLOCK_TYPE = 'block'
/** From a slide to the block it is made of, and from a row or column to each block in it. */
export const COMPOSES = 'composes'
/** A story: the directed outline of a document a deck is made from. */
export const STORY_TYPE = 'story'
/** One line of a story's outline: a chapter, or a point under one. */
export const BEAT_TYPE = 'beat'
/** From a beat to each entity it draws on. */
export const CITES = 'cites'
/** From a beat to the beat after it in reading order. */
export const NEXT = 'next'
/** From a slide (a chapter) or a block (a point) to the beat it makes visible. */
export const REALIZES = 'realizes'

export interface DeckData extends EntityData {
  /** The deck's colour: its slides' accent and their beams. */
  color?: string
  /** Where the deck sits among the others (lowest first); ties by label. */
  order?: number
  description?: string
}

/**
 * Where a slide hangs, when it is placed by hand. Units are the web's
 * radius (half its largest extent), from its centre, so a slide keeps its
 * place over the web when the layout is scaled or re-run: `y: 1.6` is
 * 1.6 radii above the centre. `yaw` turns the card about the vertical
 * (0 faces +z, radians), `tilt` leans its top back (radians), `width` is
 * in radii (the height follows the card's 16:10 shape).
 */
export interface SlidePlane {
  x: number
  y: number
  z: number
  yaw?: number
  tilt?: number
  width?: number
}

export interface SlideData extends EntityData {
  /** The deck the slide belongs to. */
  deck?: EntityId
  /** Its place in the deck, from 1. */
  order?: number
  /** A small label above the title. */
  kicker?: string
  /** The slide's text: a few Markdown lines (`- bullets`, `**bold**`). */
  body?: string
  /** A fixed place of its own; without one the slide is arranged with its deck (`arrangeSlides`). */
  plane?: SlidePlane
  /** The block the slide is composed of (a row, a column or a single block); its text is then a subtitle. */
  compose?: EntityId
  /** The chapter of a story this slide makes visible. */
  beat?: EntityId
}

export interface StoryData extends EntityData {
  /** The deck the story becomes. */
  deck?: EntityId
  order?: number
  summary?: string
}
export type BeatKind = 'chapter' | 'point'
export interface BeatData extends EntityData {
  story?: EntityId
  kind?: BeatKind
  /** A point's chapter. */
  parent?: EntityId
  /** Its place among its chapter's points, or a chapter's among the story's chapters, from 1. */
  order?: number
  /** The line said more fully. */
  text?: string
}

/** The kinds of block: four that hold items bound to entities, text, and two that lay out other blocks. */
export const BLOCK_KINDS = ['flow', 'stats', 'list', 'timeline', 'text', 'row', 'column'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]
/** One box of a block: the entity it is bound to (`ref`), what it says, a figure, a line under it. */
export interface BlockItem {
  ref?: EntityId
  label?: string
  value?: string
  note?: string
}
export interface BlockData extends EntityData {
  kind?: BlockKind
  /** flow, stats, list, timeline: the boxes, in order. */
  items?: BlockItem[]
  /** row, column: the blocks laid side by side or one under another. */
  children?: EntityId[]
  /** text: a line or two of Markdown. */
  text?: string
  /** Whether a leaf block's title is drawn over it (default true). */
  showTitle?: boolean
  /** The point of a story this block makes visible. */
  beat?: EntityId
}

export const deckType: EntityTypeDef = defineEntityType({
  type: DECK_TYPE,
  label: 'Deck',
  pluralLabel: 'Decks',
  category: 'project',
  icon: GalleryHorizontalEnd,
  color: '#0ea5e9',
  description: 'An ordered set of slides made from the data: in Unigraph’s 3D view they hang above the graph, each beaming down to what it shows.',
  fields: [
    { key: 'data.order', label: 'Order', kind: 'number', width: 70 },
    { key: 'data.color', label: 'Colour', kind: 'text', width: 90 },
    { key: 'data.description', label: 'About', kind: 'longtext', width: 320 },
  ],
})

export const blockType: EntityTypeDef = defineEntityType({
  type: BLOCK_TYPE,
  label: 'Block',
  pluralLabel: 'Blocks',
  category: 'project',
  icon: LayoutPanelTop,
  color: '#7c3aed',
  description: 'A reusable piece of a slide: a flow, stats, a list or a timeline whose boxes are bound to entities (`shows`), text, or a row or column of other blocks (`composes`). Slides are composed of blocks; a block can be used by many slides.',
  fields: [
    { key: 'data.kind', label: 'Kind', kind: 'text', width: 90 },
    { key: 'data.items', label: 'Items', kind: 'json', width: 260 },
    { key: 'data.children', label: 'Blocks', kind: 'json', width: 200 },
  ],
})

export const storyType: EntityTypeDef = defineEntityType({
  type: STORY_TYPE,
  label: 'Story',
  pluralLabel: 'Stories',
  category: 'project',
  icon: BookOpenText,
  color: '#0d9488',
  description: 'The directed outline of a document, collected from the data: chapters and, under them, points (`beat`s), each citing the entities it draws on. A deck of slides is made from it — each chapter a slide, each point a region of one.',
  fields: [
    { key: 'data.deck', label: 'Deck', kind: 'ref', width: 180 },
    { key: 'data.summary', label: 'Summary', kind: 'longtext', width: 320 },
  ],
})

export const beatType: EntityTypeDef = defineEntityType({
  type: BEAT_TYPE,
  label: 'Beat',
  pluralLabel: 'Beats',
  category: 'project',
  icon: ListTree,
  color: '#14b8a6',
  description: 'A line of a story\'s outline: a chapter, or a point under one (`parent`), in order. It `cites` the entities it draws on and is followed by the `next` beat; the slide or block that `realizes` it shows it.',
  fields: [
    { key: 'data.story', label: 'Story', kind: 'ref', width: 180 },
    { key: 'data.kind', label: 'Kind', kind: 'text', width: 80 },
    { key: 'data.parent', label: 'Chapter', kind: 'ref', width: 180 },
    { key: 'data.order', label: 'Order', kind: 'number', width: 70 },
    { key: 'data.text', label: 'Text', kind: 'longtext', width: 320 },
  ],
})

export const slideType: EntityTypeDef = defineEntityType({
  type: SLIDE_TYPE,
  label: 'Slide',
  pluralLabel: 'Slides',
  category: 'project',
  icon: RectangleHorizontal,
  color: '#0284c7',
  description: 'A rectangle of a deck: a title and a few lines over the entities it shows (`shows` relationships). Drawn in Unigraph’s 3D view at a fixed place above the graph.',
  fields: [
    { key: 'data.deck', label: 'Deck', kind: 'ref', width: 180 },
    { key: 'data.order', label: 'Order', kind: 'number', width: 70 },
    { key: 'data.kicker', label: 'Kicker', kind: 'text', width: 140 },
    { key: 'data.body', label: 'Text', kind: 'longtext', width: 360 },
  ],
})

export interface DeckInfo {
  id: EntityId
  label: string
  color: string
  order: number
  description?: string
  slides: SlideInfo[]
}

export interface SlideInfo {
  id: EntityId
  label: string
  deck?: EntityId
  order: number
  kicker?: string
  body: string
  plane?: SlidePlane
  /** The root block of a composed slide. */
  compose?: EntityId
  /** The chapter it makes visible. */
  beat?: EntityId
  /** What it shows, in the order the relationships were made — for a composed slide, what its blocks show too. */
  members: EntityId[]
}

export interface BlockInfo {
  id: EntityId
  label: string
  kind: BlockKind
  items: BlockItem[]
  children: EntityId[]
  text: string
  showTitle: boolean
  /** The point it makes visible. */
  beat?: EntityId
}

const isKind = (k: unknown): k is BlockKind => typeof k === 'string' && (BLOCK_KINDS as readonly string[]).includes(k)
export const isLayoutKind = (k: BlockKind) => k === 'row' || k === 'column'

/** A block as the view reads it; an unknown kind reads as text. */
export function blockInfo(e: AnyEntity): BlockInfo {
  const d = e.data as BlockData
  const items = Array.isArray(d.items) ? d.items.filter((i): i is BlockItem => !!i && typeof i === 'object').map((i) => ({ ...(typeof i.ref === 'string' ? { ref: i.ref } : {}), ...(typeof i.label === 'string' ? { label: i.label } : {}), ...(typeof i.value === 'string' ? { value: i.value } : {}), ...(typeof i.note === 'string' ? { note: i.note } : {}) })) : []
  return { id: e.id, label: displayLabel(e), kind: isKind(d.kind) ? d.kind : 'text', items, children: Array.isArray(d.children) ? d.children.filter((c): c is string => typeof c === 'string') : [], text: typeof d.text === 'string' ? d.text : '', showTitle: d.showTitle !== false, ...(typeof d.beat === 'string' ? { beat: d.beat } : {}) }
}

/** Every block in scope, by id. */
export function readBlocks(store: EntityStore): Map<EntityId, BlockInfo> {
  const out = new Map<EntityId, BlockInfo>()
  for (const e of store.ofType(BLOCK_TYPE)) out.set(e.id, blockInfo(e))
  return out
}

/** The leaf blocks under a block, in reading order, each once — a cycle or a missing block is skipped, never followed twice. */
/** The most blocks a composition is read through: a slide is a handful; a chain of thousands from data is cut, never recursed. */
export const MAX_COMPOSED_BLOCKS = 256

export function leafBlocks(root: EntityId, blocks: Map<EntityId, BlockInfo>): BlockInfo[] {
  const out: BlockInfo[] = []
  const seen = new Set<EntityId>()
  // Depth first in reading order, with an explicit stack: a 50,000-deep chain of rows overflowed the call stack.
  const stack: EntityId[] = [root]
  while (stack.length && seen.size < MAX_COMPOSED_BLOCKS) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const b = blocks.get(id)
    if (!b) continue
    if (isLayoutKind(b.kind)) for (let i = b.children.length - 1; i >= 0; i--) stack.push(b.children[i])
    else out.push(b)
  }
  return out
}

/** What a block shows: its items' entities (a row or column: its blocks'), each once. */
export function blockMembers(root: EntityId, blocks: Map<EntityId, BlockInfo>): EntityId[] {
  const out = new Set<EntityId>()
  for (const b of leafBlocks(root, blocks)) for (const i of b.items) if (i.ref) out.add(i.ref)
  return [...out]
}

/** The palette a deck without a colour takes, by its place among the decks. */
export const DECK_COLORS = ['#0ea5e9', '#f97316', '#10b981', '#a855f7', '#e11d48', '#eab308', '#14b8a6', '#6366f1']
/** The deck slides without one are listed under. */
export const LOOSE_DECK = 'deck:(none)'

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** A slide as the view reads it. `members` from the store's `shows` relationships. */
export function slideInfo(store: EntityStore, e: AnyEntity): SlideInfo {
  const d = e.data as SlideData
  const members: EntityId[] = []
  for (const r of store.relationshipsOf(e.id, 'out')) if (r.type === SHOWS && r.source.id === e.id) members.push(r.target.id)
  const plane = d.plane && typeof d.plane === 'object' && [d.plane.x, d.plane.y, d.plane.z].every((v) => typeof v === 'number' && Number.isFinite(v)) ? d.plane : undefined
  const compose = typeof d.compose === 'string' && store.get(d.compose)?.type === BLOCK_TYPE ? d.compose : undefined
  if (compose) {
    // Read only the blocks under this slide: a slide is composed of a handful.
    const blocks = new Map<EntityId, BlockInfo>()
    const stack: EntityId[] = [compose]
    while (stack.length && blocks.size < MAX_COMPOSED_BLOCKS) {
      const id = stack.pop()!
      if (blocks.has(id)) continue
      const b = store.get(id)
      if (!b || b.type !== BLOCK_TYPE) continue
      const info = blockInfo(b)
      blocks.set(id, info)
      stack.push(...info.children)
    }
    for (const m of blockMembers(compose, blocks)) if (!members.includes(m) && store.has(m)) members.push(m)
  }
  return { id: e.id, label: displayLabel(e), deck: typeof d.deck === 'string' ? d.deck : undefined, order: num(d.order, Number.MAX_SAFE_INTEGER), kicker: typeof d.kicker === 'string' ? d.kicker : undefined, body: typeof d.body === 'string' ? d.body : '', plane, compose, members, ...(typeof d.beat === 'string' ? { beat: d.beat } : {}) }
}

/**
 * Every deck in scope with its slides in order, decks in order. Slides
 * whose deck is missing are gathered in one deck of their own
 * (`LOOSE_DECK`) so nothing made is lost from sight.
 */
export function readDecks(store: EntityStore): DeckInfo[] {
  const decks = new Map<EntityId, DeckInfo>()
  for (const e of store.ofType(DECK_TYPE)) {
    const d = e.data as DeckData
    // A colour from data is a colour or nothing: it becomes a CSS custom property every card is painted with, and a
    // `url(…)` there would fetch a remote image without asking (`lib/cssColor.ts`).
    decks.set(e.id, { id: e.id, label: displayLabel(e), color: cssColor(d.color, ''), order: num(d.order, Number.MAX_SAFE_INTEGER), description: typeof d.description === 'string' ? d.description : undefined, slides: [] })
  }
  for (const e of store.ofType(SLIDE_TYPE)) {
    const s = slideInfo(store, e)
    let deck = s.deck ? decks.get(s.deck) : undefined
    if (!deck) {
      deck = decks.get(LOOSE_DECK)
      if (!deck) decks.set(LOOSE_DECK, (deck = { id: LOOSE_DECK, label: 'Slides without a deck', color: '#64748b', order: Number.MAX_SAFE_INTEGER, slides: [] }))
    }
    deck.slides.push(s)
  }
  const out = [...decks.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  out.forEach((d, i) => {
    if (!d.color) d.color = DECK_COLORS[i % DECK_COLORS.length]
    d.slides.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  })
  return out
}

/** The decks a view shows: those named (in their own order), or all of them. */
export function shownDecks(decks: DeckInfo[], names?: EntityId[]): DeckInfo[] {
  if (!names) return decks
  const want = new Set(names)
  return decks.filter((d) => want.has(d.id))
}

// ── Placement ──

/** A card's shape: 16:10. */
export const SLIDE_ASPECT = 0.625

/** A slide placed in world space: its centre, the unit vectors along its width (`u`, rightwards seen from the front) and down its height (`v`), its size. */
export interface PlacedSlide {
  id: EntityId
  deck: EntityId
  center: [number, number, number]
  u: [number, number, number]
  v: [number, number, number]
  /** Facing out of the front. */
  normal: [number, number, number]
  width: number
  height: number
  /** Which tier of the ring it hangs on (0 the lowest). */
  tier?: number
}

export interface WebBounds {
  cx: number
  cy: number
  cz: number
  /** The web's size: the distance most of it lies within (cards are sized by it). */
  radius: number
  /** How far its outskirts reach (the ring clears it); `radius` when not given. */
  outer?: number
}

function axes(yaw: number, tilt: number) {
  // Seen from the front (from along the normal) the card's width runs to the viewer's right and its height down.
  const u: [number, number, number] = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const ct = Math.cos(tilt), st = Math.sin(tilt)
  // Tilting leans the top back: down the card goes towards the viewer as well as down.
  const v: [number, number, number] = [Math.sin(yaw) * st, -ct, Math.cos(yaw) * st]
  const normal: [number, number, number] = [Math.sin(yaw) * ct, st, Math.cos(yaw) * ct]
  return { u, v, normal }
}

/** The most slides one tier of the ring holds before the decks are stacked on tiers. */
export const TIER_MAX = 14

/** Where the arrangement starts: the slide first in reading order faces the orbit camera's opening yaw. */
export const RING_START_YAW = 0.6

/**
 * Hang the slides of the decks shown over the web, deterministically: a
 * ring above it, each card facing out, the decks one after another round
 * it with a gap between them, reading order clockwise seen from above — so
 * from outside the ring a deck reads left to right. Past `TIER_MAX` slides
 * the decks are stacked on tiers, each a ring of its own, the first deck
 * lowest; a ring widens as its slides grow in number rather than the cards
 * shrinking past legibility.
 * A slide with a `plane` of its own hangs there instead.
 */
export function arrangeSlides(decks: DeckInfo[], web: WebBounds, opts: { lift?: number; pitch?: (height: number) => number; tierMax?: number } = {}): PlacedSlide[] {
  const R = web.radius > 0 ? web.radius : 1
  const groups = decks.map((d) => ({ deck: d.id, slides: d.slides.filter((s) => !s.plane) })).filter((g) => g.slides.length)
  const n = groups.reduce((m, g) => m + g.slides.length, 0)
  // Past a ring's worth the decks go on tiers stacked one above another — whole decks, in order, the tiers as even as
  // whole decks allow — so many slides make a taller crown rather than a wider one the web shrinks to a dot inside.
  const tierCount = Math.max(1, Math.min(groups.length, Math.ceil(n / (opts.tierMax ?? TIER_MAX))))
  const tiers: (typeof groups)[] = Array.from({ length: tierCount }, () => [])
  let left = n
  let t = 0
  let inTier = 0
  for (const g of groups) {
    const want = left / (tierCount - t)
    if (inTier > 0 && t < tierCount - 1 && inTier + g.slides.length / 2 > want) {
      left -= inTier
      t++
      inTier = 0
    }
    tiers[t].push(g)
    inTier += g.slides.length
  }
  const perTier = tiers.map((ts) => ts.reduce((m, g) => m + g.slides.length, 0))
  const most = Math.max(0, ...perTier)
  const width = R * (most <= 6 ? 0.8 : most <= 12 ? 0.7 : 0.6)
  const height = width * SLIDE_ASPECT
  const deckGap = 0.7
  const slotsOf = (ts: typeof groups) => ts.reduce((m, g) => m + g.slides.length, 0) + (ts.length > 1 ? deckGap * ts.length : 0)
  const outer = Math.max(R, web.outer ?? R)
  const radius = Math.max(R * 1.35, outer * 1.12, ...tiers.map((ts) => (slotsOf(ts) * width * 1.2) / (2 * Math.PI)))
  const y0 = web.cy + Math.max(R * 1.1, outer * 0.9) + height / 2
  const out: PlacedSlide[] = []
  tiers.forEach((ts, k) => {
    const slots = slotsOf(ts)
    const step = slots > 0 ? (2 * Math.PI) / Math.max(slots, 3) : 0
    const y = y0 + (opts.lift ?? 0) + k * (opts.pitch ? opts.pitch(height) : height * 1.18)
    let slot = 0
    ts.forEach((g, gi) => {
      if (gi > 0) slot += deckGap
      for (const s of g.slides) {
        const yaw = RING_START_YAW + slot * step
        out.push({ id: s.id, deck: g.deck, center: [web.cx + radius * Math.sin(yaw), y, web.cz + radius * Math.cos(yaw)], ...axes(yaw, 0), width, height, tier: k })
        slot += 1
      }
    })
  })
  for (const d of decks)
    for (const s of d.slides) {
      if (!s.plane) continue
      const p = s.plane
      const w = R * (p.width && p.width > 0 ? p.width : 0.8)
      out.push({ id: s.id, deck: d.id, center: [web.cx + p.x * R, web.cy + p.y * R, web.cz + p.z * R], ...axes(p.yaw ?? 0, p.tilt ?? 0), width: w, height: w * SLIDE_ASPECT })
    }
  return out
}

/** A composition line: from the region a block takes on a slide down to the block's own plate. */
export interface CompositionLink {
  slide: EntityId
  block: EntityId
}

/**
 * The three layers: the slides, and — with `parts` — the leaf blocks of the
 * composed ones as plates of their own, hung between the web and the slides.
 * A slide's plates hang side by side under it, facing as it does; a block
 * used by several slides hangs once, under the first that uses it, and every
 * slide that uses it gets a line down to it. Each tier of slides rises by
 * the height of its plate level so tiers never collide. Without `parts`, or
 * with no composed slide among them, it is `arrangeSlides`.
 */
export function arrangeLayers(decks: DeckInfo[], blocks: Map<EntityId, BlockInfo>, web: WebBounds, parts: boolean): { slides: PlacedSlide[]; plates: PlacedSlide[]; links: CompositionLink[] } {
  const composed = decks.some((d) => d.slides.some((s) => s.compose))
  if (!parts || !composed) return { slides: arrangeSlides(decks, web), plates: [], links: [] }
  const R = web.radius > 0 ? web.radius : 1
  const probe = arrangeSlides(decks, web)
  const W = probe[0]?.width ?? R * 0.8
  const H = W * SLIDE_ASPECT
  // A plate is at most half a slide wide; the plate level is a plate's height, a gap for the lines above it, and room
  // below it so the plates clear the top of the web.
  const plateLevel = W * 0.5 * SLIDE_ASPECT + R * 0.55 + R * 0.3
  const slides = arrangeSlides(decks, web, { lift: plateLevel, pitch: (h) => h * 1.12 + plateLevel })
  const byId = new Map(slides.map((p) => [p.id, p]))
  const plates: PlacedSlide[] = []
  const links: CompositionLink[] = []
  const placed = new Set<EntityId>()
  for (const d of decks)
    for (const s of d.slides) {
      const p = byId.get(s.id)
      if (!p || !s.compose) continue
      const leaves = leafBlocks(s.compose, blocks)
      for (const b of leaves) links.push({ slide: s.id, block: b.id })
      const fresh = leaves.filter((b) => !placed.has(b.id))
      if (!fresh.length) continue
      const k = fresh.length
      const w = Math.min(W * 0.5, (W * 1.04) / k)
      const h = w * SLIDE_ASPECT
      const gap = w * 0.08
      const span = k * w + (k - 1) * gap
      // The plate level of the slide's own tier: its bottom edge a plate-level below the slide's.
      const y = p.center[1] - H / 2 - R * 0.55 - h / 2
      fresh.forEach((b, i) => {
        placed.add(b.id)
        const off = -span / 2 + w / 2 + i * (w + gap)
        plates.push({ id: b.id, deck: p.deck, center: [p.center[0] + p.u[0] * off, y, p.center[2] + p.u[2] * off], u: p.u, v: p.v, normal: p.normal, width: w, height: h, tier: p.tier })
      })
    }
  return { slides, plates, links }
}

export interface BeatInfo {
  id: EntityId
  label: string
  kind: BeatKind
  story: EntityId
  parent?: EntityId
  order: number
  text?: string
  /** What it draws on (`cites`). */
  cites: EntityId[]
}
export interface StoryInfo {
  id: EntityId
  label: string
  deck?: EntityId
  order: number
  summary?: string
  /** Its outline in reading order: each chapter followed by its points. */
  beats: BeatInfo[]
}

/** Every story in scope with its outline in reading order (chapters by order, each followed by its points by order). */
export function readStories(store: EntityStore): StoryInfo[] {
  const stories = new Map<EntityId, StoryInfo>()
  for (const e of store.ofType(STORY_TYPE)) {
    const d = e.data as StoryData
    stories.set(e.id, { id: e.id, label: displayLabel(e), deck: typeof d.deck === 'string' ? d.deck : undefined, order: num(d.order, Number.MAX_SAFE_INTEGER), summary: typeof d.summary === 'string' ? d.summary : undefined, beats: [] })
  }
  const beats: BeatInfo[] = []
  for (const e of store.ofType(BEAT_TYPE)) {
    const d = e.data as BeatData
    if (typeof d.story !== 'string' || !stories.has(d.story)) continue
    const cites: EntityId[] = []
    for (const r of store.relationshipsOf(e.id, 'out')) if (r.type === CITES && r.source.id === e.id && store.has(r.target.id)) cites.push(r.target.id)
    beats.push({ id: e.id, label: displayLabel(e), kind: d.kind === 'point' ? 'point' : 'chapter', story: d.story, ...(typeof d.parent === 'string' ? { parent: d.parent } : {}), order: num(d.order, Number.MAX_SAFE_INTEGER), ...(typeof d.text === 'string' ? { text: d.text } : {}), cites })
  }
  const byOrder = (a: BeatInfo, b: BeatInfo) => a.order - b.order || a.label.localeCompare(b.label)
  for (const s of stories.values()) {
    const mine = beats.filter((b) => b.story === s.id)
    const chapters = mine.filter((b) => b.kind === 'chapter').sort(byOrder)
    const ids = new Set(chapters.map((c) => c.id))
    for (const c of chapters) s.beats.push(c, ...mine.filter((b) => b.kind === 'point' && b.parent === c.id).sort(byOrder))
    // Points whose chapter is missing still belong to the story, after the rest.
    s.beats.push(...mine.filter((b) => b.kind === 'point' && (!b.parent || !ids.has(b.parent))).sort(byOrder))
  }
  return [...stories.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
}

/** The four layers' switches as the arrangement reads them (see `SlidesView`). */
export interface LayerSwitches {
  parts: boolean
  story: boolean
  spatial: boolean
}

/** A beat card's height, a chapter's width, and the gap between cards, in slide widths. */
export const BEAT_HEIGHT = 0.22
/** The gap between beat cards, in slide widths: narrower as a chapter's points grow in number, so the gaps never eat the row. */
export const beatGap = (points: number) => Math.min(0.03, 0.2 / Math.max(1, points))
/** A beat card's width in slide widths: a chapter's fixed, its points sharing the rest of the slide's width. */
export function beatWidth(kind: BeatKind, points: number): number {
  if (kind === 'chapter') return 0.3
  return points > 0 ? (1 - 0.3 - beatGap(points) * points) / points : 0.3
}

/** The id of a slide's blueprint in the spatial layer. */
export const wireId = (slide: EntityId) => `wire:${slide}`

/**
 * The full stack, bottom to top: the web; the **story** — each story's outline as a row of beat cards under the
 * slides of its deck, a chapter under its slide's left edge and its points across the slide, in reading order, so the
 * outline runs left to right round the ring; the **spatial** layer — each slide's blueprint (`wireId`), the same frame
 * a level below it, whose inner rectangles are the slide's regions; and the **decks**. Each level adds its height to
 * the lift of the slides above, and the ring stays one tier (the levels would collide across tiers). With neither
 * the story nor the spatial layer, the parts layer (`arrangeLayers`) as before.
 */
export function arrangeStack(decks: DeckInfo[], blocks: Map<EntityId, BlockInfo>, stories: StoryInfo[], web: WebBounds, sw: LayerSwitches): { slides: PlacedSlide[]; plates: PlacedSlide[]; links: CompositionLink[]; beats: PlacedSlide[]; wires: PlacedSlide[] } {
  const realizedSlide = new Map<EntityId, EntityId>()
  for (const d of decks) for (const s of d.slides) if (s.beat) realizedSlide.set(s.beat, s.id)
  const story = sw.story && stories.some((st) => st.beats.some((b) => realizedSlide.has(b.id)))
  if (!story && !sw.spatial) return { ...arrangeLayers(decks, blocks, web, sw.parts), beats: [], wires: [] }
  const R = web.radius > 0 ? web.radius : 1
  const outer = Math.max(R, web.outer ?? R)
  const probe = arrangeSlides(decks, web, { tierMax: Infinity })
  const W = probe[0]?.width ?? R * 0.8
  const H = W * SLIDE_ASPECT
  const beatH = W * BEAT_HEIGHT
  const webTop = web.cy + Math.max(R * 1.1, outer * 0.9)
  const yStory = webTop + R * 0.3 + beatH / 2
  const above = story ? yStory + beatH / 2 + R * 0.55 : webTop + R * 0.2
  const yWire = above + H / 2
  const ySlide = sw.spatial ? yWire + H / 2 + R * 0.35 + H / 2 : above + H / 2
  const slides = arrangeSlides(decks, web, { lift: ySlide - (webTop + H / 2), tierMax: Infinity })
  const wires = sw.spatial ? slides.map((p) => ({ ...p, id: wireId(p.id), center: [p.center[0], yWire, p.center[2]] as [number, number, number] })) : []
  const beats: PlacedSlide[] = []
  if (story) {
    const bySlide = new Map(slides.map((p) => [p.id, p]))
    for (const st of stories)
      for (const b of st.beats) {
        if (b.kind !== 'chapter') continue
        const sid = realizedSlide.get(b.id)
        const p = sid ? bySlide.get(sid) : undefined
        if (!p) continue
        const points = st.beats.filter((x) => x.kind === 'point' && x.parent === b.id)
        // A row across the slide's width: the chapter at its left, the points after it.
        const chapterW = W * beatWidth('chapter', points.length)
        const gap = W * beatGap(points.length)
        const pointW = W * beatWidth('point', points.length)
        const at = (off: number, w: number, id: EntityId) => beats.push({ id, deck: p.deck, center: [p.center[0] + p.u[0] * off, yStory, p.center[2] + p.u[2] * off], u: p.u, v: p.v, normal: p.normal, width: w, height: beatH })
        at(-W / 2 + chapterW / 2, chapterW, b.id)
        points.forEach((pt, i) => at(-W / 2 + chapterW + gap * (i + 1) + pointW * (i + 0.5), pointW, pt.id))
      }
  }
  return { slides, plates: [], links: [], beats, wires }
}

/** What an arrangement depends on besides the web: the decks shown and whether blocks hang as plates. */
export function placementKey(decks: DeckInfo[], sw: LayerSwitches): string {
  return `${sw.parts ? 1 : 0}${sw.story ? 1 : 0}${sw.spatial ? 1 : 0}|${decks.map((d) => d.id).join(',')}`
}

/** The box the placed slides take, for a fit that keeps them in frame. */
export function slidesBox(placed: PlacedSlide[]): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
  if (!placed.length) return null
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  for (const p of placed)
    for (const su of [-0.5, 0.5])
      for (const sv of [-0.5, 0.5]) {
        const x = p.center[0] + p.u[0] * p.width * su + p.v[0] * p.height * sv
        const y = p.center[1] + p.u[1] * p.width * su + p.v[1] * p.height * sv
        const z = p.center[2] + p.u[2] * p.width * su + p.v[2] * p.height * sv
        if (x < b.minX) b.minX = x
        if (x > b.maxX) b.maxX = x
        if (y < b.minY) b.minY = y
        if (y > b.maxY) b.maxY = y
        if (z < b.minZ) b.minZ = z
        if (z > b.maxZ) b.maxZ = z
      }
  return b
}

// ── Making them ──

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'untitled'

function freeId(store: EntityStore, base: string): EntityId {
  if (!store.has(base)) return base
  for (let i = 2; ; i++) if (!store.has(`${base}-${i}`)) return `${base}-${i}`
}

/** A new deck, last in order unless told otherwise. */
export function createDeck(store: EntityStore, init: { label: string; color?: string; description?: string; order?: number; source?: string }): AnyEntity {
  const existing = store.ofType(DECK_TYPE)
  const order = init.order ?? existing.reduce((m, e) => Math.max(m, num((e.data as DeckData).order, 0)), 0) + 1
  const deck = createEntity<DeckData>({
    id: freeId(store, `deck:${slug(init.label)}`),
    type: DECK_TYPE,
    label: init.label,
    data: { order, ...(init.color ? { color: init.color } : {}), ...(init.description ? { description: init.description } : {}) },
    meta: init.source ? { source: init.source } : undefined,
  })
  store.upsert(deck)
  return deck
}

/** A new slide at the end of its deck (or at `order`), showing `members` — the ids the store does not hold are skipped. */
export function createSlide(store: EntityStore, init: { deck: EntityId; label: string; body?: string; kicker?: string; members?: EntityId[]; order?: number; plane?: SlidePlane; source?: string }): { slide: AnyEntity; members: EntityId[] } {
  if (!store.has(init.deck)) throw new Error(`No deck ${init.deck}`)
  const siblings = store.ofType(SLIDE_TYPE).filter((e) => (e.data as SlideData).deck === init.deck)
  const order = init.order ?? siblings.reduce((m, e) => Math.max(m, num((e.data as SlideData).order, 0)), 0) + 1
  const base = init.deck.startsWith('deck:') ? init.deck.slice(5) : slug(init.deck)
  const slide = createEntity<SlideData>({
    id: freeId(store, `slide:${base}-${order}`),
    type: SLIDE_TYPE,
    label: init.label,
    data: { deck: init.deck, order, ...(init.kicker ? { kicker: init.kicker } : {}), body: init.body ?? '', ...(init.plane ? { plane: init.plane } : {}) },
    meta: init.source ? { source: init.source } : undefined,
  })
  let shown: EntityId[] = []
  store.transaction(() => {
    store.upsert(slide)
    shown = addShows(store, slide.id, init.members ?? [], init.source)
  })
  return { slide, members: shown }
}

/** Make the slide show these too; returns the ids added (ones already shown, missing, or slides and decks themselves are skipped). */
export function addShows(store: EntityStore, slideId: EntityId, ids: EntityId[], source?: string): EntityId[] {
  const have = new Set(store.relationshipsOf(slideId, 'out').filter((r) => r.type === SHOWS).map((r) => r.target.id))
  const added: EntityId[] = []
  const rels = []
  for (const id of ids) {
    const e = store.get(id)
    if (!e || have.has(id) || e.kind === 'relationship' || e.type === SLIDE_TYPE || e.type === DECK_TYPE || e.type === BLOCK_TYPE) continue
    have.add(id)
    added.push(id)
    rels.push(createRelationship({ id: `${slideId}:::${SHOWS}:::${id}`, type: SHOWS, source: slideId, target: id, meta: source ? { source } : undefined }))
  }
  if (rels.length) store.upsertMany(rels)
  return added
}

/** Stop the slide showing these; returns the ids removed. */
export function removeShows(store: EntityStore, slideId: EntityId, ids: EntityId[]): EntityId[] {
  const drop = new Set(ids)
  const rels = store.relationshipsOf(slideId, 'out').filter((r) => r.type === SHOWS && drop.has(r.target.id))
  if (rels.length) store.remove(rels.map((r) => r.id))
  return rels.map((r) => r.target.id)
}

// ── Blocks ──

/**
 * The relationships a block's data implies, written to match it: `shows` to each item's entity, `composes` to each
 * child block. Called on every write of a block, so the graph (the inspector, a filter, the slide's members) always
 * says what the block is made of.
 */
function syncBlockLinks(store: EntityStore, id: EntityId, info: BlockInfo, source?: string) {
  const want = new Map<string, { type: string; target: EntityId }>()
  for (const i of info.items) {
    const t = i.ref ? store.get(i.ref) : undefined
    if (t && t.kind === 'entity' && t.type !== SLIDE_TYPE && t.type !== DECK_TYPE && t.type !== BLOCK_TYPE) want.set(`${SHOWS}|${t.id}`, { type: SHOWS, target: t.id })
  }
  for (const c of info.children) if (store.get(c)?.type === BLOCK_TYPE && c !== id) want.set(`${COMPOSES}|${c}`, { type: COMPOSES, target: c })
  const have = store.relationshipsOf(id, 'out').filter((r) => r.source.id === id && (r.type === SHOWS || r.type === COMPOSES))
  const drop = have.filter((r) => !want.delete(`${r.type}|${r.target.id}`)).map((r) => r.id)
  if (drop.length) store.remove(drop)
  const add = [...want.values()].map(({ type, target }) => createRelationship({ id: `${id}:::${type}:::${target}`, type, source: id, target, meta: source ? { source } : undefined }))
  if (add.length) store.upsertMany(add)
}

export interface BlockInit {
  label: string
  kind: BlockKind
  items?: BlockItem[]
  children?: EntityId[]
  text?: string
  showTitle?: boolean
  source?: string
}

const blockData = (init: Partial<BlockInit>, base: BlockData = {}): BlockData => {
  const d: BlockData = { ...base }
  if (init.kind) d.kind = init.kind
  if (init.items) d.items = init.items
  if (init.children) d.children = init.children
  if (init.text !== undefined) d.text = init.text
  if (init.showTitle !== undefined) d.showTitle = init.showTitle
  return d
}

/** A new block, its `shows` and `composes` relationships with it. */
export function createBlock(store: EntityStore, init: BlockInit): AnyEntity {
  if (!(BLOCK_KINDS as readonly string[]).includes(init.kind)) throw new Error(`A block is one of ${BLOCK_KINDS.join(', ')}`)
  const block = createEntity<BlockData>({ id: freeId(store, `block:${slug(init.label)}`), type: BLOCK_TYPE, label: init.label, data: blockData(init), meta: init.source ? { source: init.source } : undefined })
  store.transaction(() => {
    store.upsert(block)
    syncBlockLinks(store, block.id, blockInfo(block), init.source)
  })
  return block
}

/** Change a block (what is given replaces what it had) and its relationships with it. */
export function updateBlock(store: EntityStore, id: EntityId, patch: Partial<BlockInit>): AnyEntity {
  const e = store.get(id)
  if (!e || e.type !== BLOCK_TYPE) throw new Error(`${id} is not a block`)
  if (patch.kind && !(BLOCK_KINDS as readonly string[]).includes(patch.kind)) throw new Error(`A block is one of ${BLOCK_KINDS.join(', ')}`)
  let next = e
  store.transaction(() => {
    next = store.update(id, { ...(patch.label !== undefined ? { label: patch.label } : {}), data: blockData(patch, e.data as BlockData) })
    syncBlockLinks(store, id, blockInfo(next), patch.source)
  })
  return next
}

/** Compose a slide of a block (or of nothing: `undefined`), with the `composes` relationship to match. */
export function composeSlide(store: EntityStore, slideId: EntityId, blockId: EntityId | undefined, source?: string) {
  const e = store.get(slideId)
  if (!e || e.type !== SLIDE_TYPE) throw new Error(`${slideId} is not a slide`)
  if (blockId && store.get(blockId)?.type !== BLOCK_TYPE) throw new Error(`${blockId} is not a block`)
  store.transaction(() => {
    const d = { ...(e.data as SlideData) }
    if (blockId) d.compose = blockId
    else delete d.compose
    store.update(slideId, { data: d })
    const old = store.relationshipsOf(slideId, 'out').filter((r) => r.type === COMPOSES && r.source.id === slideId && r.target.id !== blockId)
    if (old.length) store.remove(old.map((r) => r.id))
    if (blockId) store.upsert(createRelationship({ id: `${slideId}:::${COMPOSES}:::${blockId}`, type: COMPOSES, source: slideId, target: blockId, meta: source ? { source } : undefined }))
  })
}

// ── Stories ──

/** A new story, the directed outline a deck is made from. */
export function createStory(store: EntityStore, init: { label: string; deck?: EntityId; summary?: string; order?: number; source?: string }): AnyEntity {
  if (init.deck && store.get(init.deck)?.type !== DECK_TYPE) throw new Error(`${init.deck} is not a deck`)
  const order = init.order ?? store.ofType(STORY_TYPE).reduce((m, e) => Math.max(m, num((e.data as StoryData).order, 0)), 0) + 1
  const story = createEntity<StoryData>({ id: freeId(store, `story:${slug(init.label)}`), type: STORY_TYPE, label: init.label, data: { order, ...(init.deck ? { deck: init.deck } : {}), ...(init.summary ? { summary: init.summary } : {}) }, meta: init.source ? { source: init.source } : undefined })
  store.upsert(story)
  return story
}

/** Write a beat's `cites` to match `ids` (existing entities only, never a slide, deck, block, story or beat). */
function syncCites(store: EntityStore, beat: EntityId, ids: EntityId[], source?: string) {
  const skip = new Set([SLIDE_TYPE, DECK_TYPE, BLOCK_TYPE, STORY_TYPE, BEAT_TYPE])
  const want = new Set(ids.filter((id) => {
    const e = store.get(id)
    return !!e && e.kind === 'entity' && !skip.has(e.type)
  }))
  const have = store.relationshipsOf(beat, 'out').filter((r) => r.type === CITES && r.source.id === beat)
  const drop = have.filter((r) => !want.delete(r.target.id)).map((r) => r.id)
  if (drop.length) store.remove(drop)
  if (want.size) store.upsertMany([...want].map((t) => createRelationship({ id: `${beat}:::${CITES}:::${t}`, type: CITES, source: beat, target: t, meta: source ? { source } : undefined })))
}

/** The `next` relationships of a story, rewritten to follow its outline's reading order. */
export function syncNext(store: EntityStore, storyId: EntityId, source?: string) {
  const story = readStories(store).find((s) => s.id === storyId)
  if (!story) return
  const ids = new Set(story.beats.map((b) => b.id))
  const old = store.relationships().filter((r) => r.type === NEXT && ids.has(r.source.id))
  if (old.length) store.remove(old.map((r) => r.id))
  const rels = story.beats.slice(1).map((b, i) => createRelationship({ id: `${story.beats[i].id}:::${NEXT}:::${b.id}`, type: NEXT, source: story.beats[i].id, target: b.id, meta: source ? { source } : undefined }))
  if (rels.length) store.upsertMany(rels)
}

/** A new beat at the end of its chapter (a point) or its story (a chapter), unless `order` says where; with its `cites` and the story's `next` chain. */
export function createBeat(store: EntityStore, init: { story: EntityId; label: string; kind: BeatKind; parent?: EntityId; order?: number; text?: string; cites?: EntityId[]; source?: string }): AnyEntity {
  if (store.get(init.story)?.type !== STORY_TYPE) throw new Error(`${init.story} is not a story`)
  if (init.kind === 'point') {
    const parent = init.parent ? store.get(init.parent) : undefined
    if (!parent || parent.type !== BEAT_TYPE || (parent.data as BeatData).kind === 'point' || (parent.data as BeatData).story !== init.story) throw new Error('A point needs `parent`: a chapter of the same story')
  }
  const siblings = store.ofType(BEAT_TYPE).filter((e) => {
    const d = e.data as BeatData
    return d.story === init.story && (init.kind === 'point' ? d.parent === init.parent : d.kind !== 'point')
  })
  const order = init.order ?? siblings.reduce((m, e) => Math.max(m, num((e.data as BeatData).order, 0)), 0) + 1
  const base = init.kind === 'point' && init.parent ? `${init.parent}-${order}` : `beat:${init.story.replace(/^story:/, '')}-${order}`
  const beat = createEntity<BeatData>({ id: freeId(store, base), type: BEAT_TYPE, label: init.label, data: { story: init.story, kind: init.kind, order, ...(init.parent && init.kind === 'point' ? { parent: init.parent } : {}), ...(init.text ? { text: init.text } : {}) }, meta: init.source ? { source: init.source } : undefined })
  store.transaction(() => {
    store.upsert(beat)
    syncCites(store, beat.id, init.cites ?? [], init.source)
    syncNext(store, init.story, init.source)
  })
  return beat
}

/** Change a beat: its line, its fuller text, its place, what it cites (replacing what it cited). */
export function updateBeat(store: EntityStore, id: EntityId, patch: { label?: string; text?: string; order?: number; cites?: EntityId[]; source?: string }): AnyEntity {
  const e = store.get(id)
  if (!e || e.type !== BEAT_TYPE) throw new Error(`${id} is not a beat`)
  let next = e
  store.transaction(() => {
    const d = { ...(e.data as BeatData) }
    if (patch.text !== undefined) d.text = patch.text
    if (patch.order !== undefined) d.order = patch.order
    next = store.update(id, { ...(patch.label !== undefined ? { label: patch.label } : {}), data: d })
    if (patch.cites) syncCites(store, id, patch.cites, patch.source)
    if (patch.order !== undefined && d.story) syncNext(store, d.story, patch.source)
  })
  return next
}

/** Say that a slide (for a chapter) or a leaf block (for a point) makes a beat visible — or nothing, with `undefined`. */
export function realizeBeat(store: EntityStore, realizer: EntityId, beatId: EntityId | undefined, source?: string) {
  const e = store.get(realizer)
  if (!e || (e.type !== SLIDE_TYPE && e.type !== BLOCK_TYPE)) throw new Error(`${realizer} is not a slide or a block`)
  const beat = beatId ? store.get(beatId) : undefined
  if (beatId && (!beat || beat.type !== BEAT_TYPE)) throw new Error(`${beatId} is not a beat`)
  if (beat) {
    const kind = (beat.data as BeatData).kind === 'point' ? 'point' : 'chapter'
    if (e.type === SLIDE_TYPE && kind !== 'chapter') throw new Error('A slide realizes a chapter; a block realizes a point')
    if (e.type === BLOCK_TYPE && kind !== 'point') throw new Error('A slide realizes a chapter; a block realizes a point')
  }
  store.transaction(() => {
    const d = { ...(e.data as SlideData & BlockData) }
    if (beatId) d.beat = beatId
    else delete d.beat
    store.update(realizer, { data: d })
    const old = store.relationshipsOf(realizer, 'out').filter((r) => r.type === REALIZES && r.source.id === realizer && r.target.id !== beatId)
    if (old.length) store.remove(old.map((r) => r.id))
    if (beatId) store.upsert(createRelationship({ id: `${realizer}:::${REALIZES}:::${beatId}`, type: REALIZES, source: realizer, target: beatId, meta: source ? { source } : undefined }))
  })
}

/**
 * Delete beats and keep their stories whole: a chapter goes with its points, and each story's `next` chain is
 * rewritten over what is left. Returns the ids removed.
 */
export function deleteBeats(store: EntityStore, ids: EntityId[], source?: string): EntityId[] {
  const gone = new Set<EntityId>()
  const stories = new Set<EntityId>()
  for (const id of ids) {
    const e = store.get(id)
    if (!e || e.type !== BEAT_TYPE) continue
    gone.add(id)
    const d = e.data as BeatData
    if (d.story) stories.add(d.story)
    if (d.kind !== 'point') for (const p of store.ofType(BEAT_TYPE)) if ((p.data as BeatData).parent === id) gone.add(p.id)
  }
  if (!gone.size) return []
  store.transaction(() => {
    store.remove([...gone])
    for (const st of stories) syncNext(store, st, source)
  })
  return [...gone]
}

import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { datasetGraph } from '../../graph/dataset'
import { addShows, arrangeLayers, arrangeStack, beatWidth, deleteBeats, createBeat, createStory, NEXT, readStories, realizeBeat, wireId, CITES, arrangeSlides, blockMembers, composeSlide, COMPOSES, createBlock, leafBlocks, readBlocks, SHOWS, TIER_MAX, updateBlock, createDeck, createSlide, LOOSE_DECK, readDecks, removeShows, RING_START_YAW, shownDecks, slidesBox, SLIDE_TYPE } from '../slides'

function world() {
  const store = new EntityStore()
  for (let i = 0; i < 6; i++) store.upsert(createEntity({ id: `n${i}`, type: 'fact', label: `n${i}` }))
  const a = createDeck(store, { label: 'Alpha', order: 2 })
  const b = createDeck(store, { label: 'Beta', order: 1, color: '#123456' })
  createSlide(store, { deck: a.id, label: 'A2', members: ['n0', 'n1'], order: 2 })
  createSlide(store, { deck: a.id, label: 'A1', members: ['n2'], order: 1 })
  createSlide(store, { deck: b.id, label: 'B1', members: ['n3', 'n4', 'n5'] })
  return { store, a: a.id, b: b.id }
}

describe('decks and slides', () => {
  it('reads decks in order with their slides in order and what each shows', () => {
    const { store, a, b } = world()
    const decks = readDecks(store)
    expect(decks.map((d) => d.id)).toEqual([b, a])
    expect(decks[0].color).toBe('#123456')
    expect(decks[1].color).toMatch(/^#/)
    expect(decks[1].slides.map((s) => s.label)).toEqual(['A1', 'A2'])
    expect(decks[1].slides[1].members).toEqual(['n0', 'n1'])
    expect(shownDecks(decks, [a]).map((d) => d.id)).toEqual([a])
    expect(shownDecks(decks)).toBe(decks)
  })

  it('gathers slides whose deck is gone under one deck of their own', () => {
    const { store, a } = world()
    store.remove(a)
    const decks = readDecks(store)
    expect(decks.at(-1)!.id).toBe(LOOSE_DECK)
    expect(decks.at(-1)!.slides).toHaveLength(2)
  })

  it('adds and removes what a slide shows without duplicates, and never shows a slide or a deck', () => {
    const { store, a } = world()
    const s = store.ofType(SLIDE_TYPE).find((e) => e.label === 'A1')!
    expect(addShows(store, s.id, ['n2', 'n3', a, s.id, 'missing'])).toEqual(['n3'])
    expect(removeShows(store, s.id, ['n2'])).toEqual(['n2'])
    expect(readDecks(store).find((d) => d.id === a)!.slides[0].members).toEqual(['n3'])
  })

  it('keeps decks and slides out of the graph the Dataset stage draws', () => {
    const { store } = world()
    const g = datasetGraph(store, new TypeRegistry(store))
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'])
    expect(g.edges).toHaveLength(0)
  })

  it('hangs the slides on a ring above the web, facing out, a deck reading left to right from outside', () => {
    const { store } = world()
    const web = { cx: 10, cy: -5, cz: 3, radius: 100 }
    const placed = arrangeSlides(readDecks(store), web)
    expect(placed.map((p) => p.id)).toEqual(['slide:beta-1', 'slide:alpha-1', 'slide:alpha-2'])
    for (const p of placed) {
      // Above the web, outside it, facing away from its axis.
      expect(p.center[1] - p.height / 2).toBeGreaterThan(web.cy + web.radius)
      const out = [p.center[0] - web.cx, p.center[2] - web.cz]
      expect(Math.hypot(out[0], out[1])).toBeGreaterThan(web.radius)
      expect(p.normal[0] * out[0] + p.normal[2] * out[1]).toBeGreaterThan(0)
      // Width and height square to each other and to the normal.
      expect(Math.abs(p.u[0] * p.v[0] + p.u[1] * p.v[1] + p.u[2] * p.v[2])).toBeLessThan(1e-9)
      expect(Math.abs(p.u[0] * p.normal[0] + p.u[1] * p.normal[1] + p.u[2] * p.normal[2])).toBeLessThan(1e-9)
    }
    // The first faces the camera's opening yaw; the next is to its right as seen from outside.
    expect(Math.atan2(placed[0].normal[0], placed[0].normal[2])).toBeCloseTo(RING_START_YAW)
    const [p0, p1] = [placed[1], placed[2]]
    const step = [p1.center[0] - p0.center[0], p1.center[2] - p0.center[2]]
    expect(step[0] * p0.u[0] + step[1] * p0.u[2]).toBeGreaterThan(0)
    const box = slidesBox(placed)!
    expect(box.minY).toBeGreaterThan(web.cy + web.radius)
  })

  it('hangs a slide with a plane of its own where it says, in radii of the web', () => {
    const { store, b } = world()
    createSlide(store, { deck: b, label: 'Fixed', plane: { x: 0, y: 2, z: -1, yaw: Math.PI, width: 0.5 } })
    const placed = arrangeSlides(readDecks(store), { cx: 0, cy: 0, cz: 0, radius: 10 })
    const p = placed.find((x) => x.id === 'slide:beta-2')!
    expect(p.center).toEqual([0, 20, -10])
    expect(p.width).toBe(5)
    expect(p.normal[2]).toBeCloseTo(-1)
  })

  it('stacks many decks on tiers, whole decks each, the first deck lowest', () => {
    const store = new EntityStore()
    for (let d = 0; d < 5; d++) {
      const deck = createDeck(store, { label: `D${d}`, order: d })
      for (let i = 0; i < 6; i++) createSlide(store, { deck: deck.id, label: `S${d}.${i}` })
    }
    const decks = readDecks(store)
    const placed = arrangeSlides(decks, { cx: 0, cy: 0, cz: 0, radius: 10 })
    expect(placed).toHaveLength(30)
    const heights = [...new Set(placed.map((p) => p.center[1]))].sort((a, b) => a - b)
    expect(heights.length).toBe(Math.ceil(30 / TIER_MAX))
    // A deck never spans two tiers, and the tiers rise in deck order.
    const tierOf = (deck: string) => new Set(placed.filter((p) => p.deck === deck).map((p) => p.center[1]))
    for (const d of decks) expect(tierOf(d.id).size).toBe(1)
    const tierIndex = decks.map((d) => heights.indexOf([...tierOf(d.id)][0]))
    expect([...tierIndex].sort((a, b) => a - b)).toEqual(tierIndex)
    // No tier is a ring wider than one tier of the same slides would need.
    const radius = Math.hypot(placed[0].center[0], placed[0].center[2])
    expect(radius).toBeLessThan(arrangeRadiusOneTier(30, 10))
  })
})

describe('blocks and composed slides', () => {
  function composed() {
    const { store, a, b } = world()
    const flow = createBlock(store, { label: 'Supply', kind: 'flow', items: [{ ref: 'n0', value: '1,200 t' }, { ref: 'n1' }, { ref: 'n2' }, { ref: 'missing' }, { ref: a }] })
    const stats = createBlock(store, { label: 'Numbers', kind: 'stats', items: [{ ref: 'n3', value: '92%' }, { ref: 'n4', value: '$62' }] })
    const row = createBlock(store, { label: 'Row', kind: 'row', children: [flow.id, stats.id] })
    const col = createBlock(store, { label: 'Col', kind: 'column', children: [stats.id, flow.id] })
    const s1 = store.ofType('slide').find((e) => e.label === 'A1')!
    const s2 = store.ofType('slide').find((e) => e.label === 'B1')!
    composeSlide(store, s1.id, row.id)
    composeSlide(store, s2.id, col.id)
    return { store, a, b, flow, stats, row, col, s1, s2 }
  }

  it('writes a block\'s relationships from its data: shows to each bound entity, composes to each child', () => {
    const { store, flow, row } = composed()
    const out = (id: string, type: string) => store.relationshipsOf(id, 'out').filter((r) => r.type === type).map((r) => r.target.id)
    // A missing entity and a deck are bound to nothing.
    expect(out(flow.id, SHOWS)).toEqual(['n0', 'n1', 'n2'])
    expect(out(row.id, COMPOSES).length).toBe(2)
    updateBlock(store, flow.id, { items: [{ ref: 'n5' }] })
    expect(out(flow.id, SHOWS)).toEqual(['n5'])
  })

  it('reads a composed slide\'s members through its blocks, and its leaves in reading order', () => {
    const { store, row, flow, stats } = composed()
    const decks = readDecks(store)
    const s1 = decks.flatMap((d) => d.slides).find((s) => s.label === 'A1')!
    expect(s1.compose).toBe(row.id)
    expect(s1.members).toEqual(expect.arrayContaining(['n0', 'n1', 'n2', 'n3', 'n4']))
    const blocks = readBlocks(store)
    expect(leafBlocks(row.id, blocks).map((b) => b.id)).toEqual([flow.id, stats.id])
    expect(blockMembers(stats.id, blocks)).toEqual(['n3', 'n4'])
  })

  it('never follows a block that contains itself', () => {
    const { store, row, flow } = composed()
    updateBlock(store, row.id, { children: [row.id, flow.id] })
    expect(leafBlocks(row.id, readBlocks(store)).map((b) => b.id)).toEqual([flow.id])
  })

  it('hangs a shared block once, under the first slide using it, with a line from every slide that does', () => {
    const { store, flow, stats, s1, s2 } = composed()
    const web = { cx: 0, cy: 0, cz: 0, radius: 10 }
    const decks = readDecks(store)
    const { slides, plates, links } = arrangeLayers(decks, readBlocks(store), web, true)
    expect(plates.map((p) => p.id).sort()).toEqual([flow.id, stats.id].sort())
    expect(links.filter((l) => l.block === flow.id).map((l) => l.slide).sort()).toEqual([s1.id, s2.id].sort())
    // Plates between the web and the slides, under the slide that places them.
    const top = Math.min(...slides.map((s) => s.center[1] - s.height / 2))
    for (const p of plates) {
      expect(p.center[1] + p.height / 2).toBeLessThan(top)
      expect(p.center[1] - p.height / 2).toBeGreaterThan(web.cy + web.radius)
    }
    // Folded, the slides hang as before and nothing else does.
    const flat = arrangeLayers(decks, readBlocks(store), web, false)
    expect(flat.plates).toHaveLength(0)
    expect(flat.slides.map((s) => s.center)).toEqual(arrangeSlides(decks, web).map((s) => s.center))
  })
})

describe('stories and the stack', () => {
  function told() {
    const { store, a } = world()
    const flow = createBlock(store, { label: 'Flow', kind: 'flow', items: [{ ref: 'n0' }, { ref: 'n1' }] })
    const stats = createBlock(store, { label: 'Stats', kind: 'stats', items: [{ ref: 'n2' }] })
    const row = createBlock(store, { label: 'Row', kind: 'row', children: [flow.id, stats.id] })
    const slide = store.ofType('slide').find((e) => e.label === 'A1')!
    composeSlide(store, slide.id, row.id)
    const st = createStory(store, { label: 'The A story', deck: a })
    const ch2 = createBeat(store, { story: st.id, label: 'Then', kind: 'chapter', order: 2 })
    const ch1 = createBeat(store, { story: st.id, label: 'First', kind: 'chapter', order: 1, cites: ['n3', a, 'missing'] })
    const p2 = createBeat(store, { story: st.id, label: 'Second point', kind: 'point', parent: ch1.id, order: 2, cites: ['n2'] })
    const p1 = createBeat(store, { story: st.id, label: 'First point', kind: 'point', parent: ch1.id, order: 1, cites: ['n0', 'n1'] })
    realizeBeat(store, slide.id, ch1.id)
    realizeBeat(store, flow.id, p1.id)
    realizeBeat(store, stats.id, p2.id)
    return { store, a, st, ch1, ch2, p1, p2, slide, flow }
  }

  it('reads a story as an outline in reading order, each beat citing only real entities', () => {
    const { store, st, ch1, ch2, p1, p2 } = told()
    const s = readStories(store).find((x) => x.id === st.id)!
    expect(s.beats.map((b) => b.id)).toEqual([ch1.id, p1.id, p2.id, ch2.id])
    expect(s.beats[0].cites).toEqual(['n3'])
    // The next chain follows that order.
    const next = store.relationships().filter((r) => r.type === NEXT).map((r) => `${r.source.id}>${r.target.id}`)
    expect(next.sort()).toEqual([`${ch1.id}>${p1.id}`, `${p1.id}>${p2.id}`, `${p2.id}>${ch2.id}`].sort())
    expect(store.relationshipsOf(p1.id, 'out').filter((r) => r.type === CITES).length).toBe(2)
  })

  it('refuses a point without a chapter and a realizer of the wrong kind', () => {
    const { store, st, ch1, p1, slide, flow } = told()
    expect(() => createBeat(store, { story: st.id, label: 'x', kind: 'point' })).toThrow(/parent/)
    expect(() => realizeBeat(store, slide.id, p1.id)).toThrow(/slide realizes a chapter/)
    expect(() => realizeBeat(store, flow.id, ch1.id)).toThrow(/block realizes a point/)
  })

  it('stacks the layers: the story above the web, the blueprints above it, the slides on top', () => {
    const { store, slide, ch1, p1, p2 } = told()
    const web = { cx: 0, cy: 0, cz: 0, radius: 10 }
    const decks = readDecks(store)
    const out = arrangeStack(decks, readBlocks(store), readStories(store), web, { parts: true, story: true, spatial: true })
    const s = out.slides.find((p) => p.id === slide.id)!
    const w = out.wires.find((p) => p.id === wireId(slide.id))!
    const beats = out.beats.filter((b) => [ch1.id, p1.id, p2.id].includes(b.id))
    expect(beats).toHaveLength(3)
    expect(out.plates).toHaveLength(0)
    const top = (p: { center: number[]; height: number }) => p.center[1] + p.height / 2
    const bottom = (p: { center: number[]; height: number }) => p.center[1] - p.height / 2
    for (const b of beats) {
      expect(bottom(b)).toBeGreaterThan(web.cy + web.radius)
      expect(top(b)).toBeLessThan(bottom(w))
    }
    expect(top(w)).toBeLessThan(bottom(s))
    // The chapter at the slide's left, its points after it, in order, along the slide's width.
    const along = (p: { center: number[] }) => (p.center[0] - s.center[0]) * s.u[0] + (p.center[2] - s.center[2]) * s.u[2]
    expect(beats.map(along)).toEqual([...beats.map(along)].sort((x, y) => x - y))
    // Without the story or the blueprints, the parts layer as before.
    const flat = arrangeStack(decks, readBlocks(store), readStories(store), web, { parts: false, story: false, spatial: false })
    expect(flat.beats).toHaveLength(0)
    expect(flat.wires).toHaveLength(0)
  })
})

describe('slides — what the review found', () => {
  it('drops a deck colour that is not a colour (a url() would be a remote fetch)', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'deck:x', type: 'deck', label: 'X', data: { color: 'url(https://tracker.example/p.gif)' } }))
    store.upsert(createEntity({ id: 'deck:y', type: 'deck', label: 'Y', data: { color: '#123abc' } }))
    const decks = readDecks(store)
    expect(decks.find((d) => d.id === 'deck:x')!.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(decks.find((d) => d.id === 'deck:y')!.color).toBe('#123abc')
  })

  it('keeps every beat card a positive width however many points a chapter has', () => {
    for (const n of [1, 3, 15, 24, 60]) {
      const w = beatWidth('point', n)
      expect(w).toBeGreaterThan(0)
      expect(0.3 + n * w).toBeLessThanOrEqual(1.0001)
    }
  })

  it('deletes a chapter with its points and keeps the reading order whole', () => {
    const store = new EntityStore()
    for (const id of ['n0', 'n1']) store.upsert(createEntity({ id, type: 'fact', label: id }))
    const st = createStory(store, { label: 'S' })
    const c1 = createBeat(store, { story: st.id, label: 'One', kind: 'chapter', order: 1 })
    const p1 = createBeat(store, { story: st.id, label: 'p', kind: 'point', parent: c1.id, cites: ['n0'] })
    const c2 = createBeat(store, { story: st.id, label: 'Two', kind: 'chapter', order: 2 })
    const c3 = createBeat(store, { story: st.id, label: 'Three', kind: 'chapter', order: 3 })
    expect(deleteBeats(store, [c2.id]).sort()).toEqual([c2.id])
    const chain = () => store.relationships().filter((r) => r.type === NEXT).map((r) => `${r.source.id}>${r.target.id}`).sort()
    expect(chain()).toEqual([`${c1.id}>${p1.id}`, `${p1.id}>${c3.id}`].sort())
    expect(deleteBeats(store, [c1.id]).sort()).toEqual([c1.id, p1.id].sort())
    expect(chain()).toEqual([])
    expect(readStories(store)[0].beats.map((b) => b.id)).toEqual([c3.id])
  })
})

describe('slides — deep data', () => {
  it('reads a 50,000-deep chain of rows without overflowing, and caps what it reads', () => {
    const store = new EntityStore()
    const deck = createDeck(store, { label: 'D' })
    const blocks = new Map()
    let next = 'block:leaf'
    blocks.set(next, { id: next, label: 'leaf', kind: 'stats', items: [], children: [], text: '', showTitle: true })
    for (let i = 0; i < 50_000; i++) {
      const id = `block:r${i}`
      blocks.set(id, { id, label: id, kind: 'row', items: [], children: [next], text: '', showTitle: true })
      next = id
    }
    expect(() => leafBlocks(next, blocks)).not.toThrow()
    for (const b of [...blocks.values()].slice(-300)) store.upsert(createEntity({ id: b.id, type: 'block', label: b.label, data: { kind: b.kind, children: b.children } }))
    const { slide } = createSlide(store, { deck: deck.id, label: 'S' })
    composeSlide(store, slide.id, next)
    expect(() => readDecks(store)).not.toThrow()
  })
})

/** The radius one ring of n slides at the 0.6-radius width would take. */
const arrangeRadiusOneTier = (n: number, R: number) => (n * R * 0.6 * 1.2) / (2 * Math.PI)

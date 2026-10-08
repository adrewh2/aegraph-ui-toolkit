import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel, quoteLabel } from '../../core/entity/entity'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { addShows, BEAT_TYPE, createBeat, deleteBeats, createStory, readStories, realizeBeat, STORY_TYPE, updateBeat, BLOCK_KINDS, BLOCK_TYPE, blockInfo, blockMembers, composeSlide, createBlock, createDeck, createSlide, DECK_TYPE, readBlocks, readDecks, removeShows, SLIDE_TYPE, slideInfo, updateBlock, type BeatData, type BlockData, type BlockItem, type BlockKind, type DeckData, type SlideData, type SlidePlane } from '../../core/slides/slides'
import { isCssColor } from '../../lib/cssColor'
import { getExplorerHandle, waitForExplorer, type ExplorerHandle } from '../graph/explorerHandle'
import { json, requireEntity } from './toolkit'
import type { AppHost } from './tools'

/**
 * Decks and slides over MCP (`core/slides`): read them, make and change
 * them, and drive the slide layer of Unigraph's 3D view — which decks hang
 * over the graph and which slide is in front, the camera turned to face it.
 */

const PLANE_SCHEMA = {
  type: 'object',
  description: 'A fixed place of the slide\'s own, in radii of the graph (half its largest extent) from its centre: x, y (up), z; yaw turns it about the vertical (0 faces +z), tilt leans its top back (radians); width in radii. Without one the slide hangs in its deck\'s place on the ring above the graph.',
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, yaw: { type: 'number' }, tilt: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 } },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
} as const

const ITEMS_SCHEMA = {
  type: 'array',
  description: 'create_block / update_block (flow, stats, list, timeline): the boxes in order, each bound to an entity — { ref: entity id, label?: short text (else the entity\'s label), value?: a figure ("92.1%", "22 wk", the date on a timeline), note?: a line under it }',
  items: { type: 'object', properties: { ref: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
} as const

type Input = {
  action: 'list' | 'get' | 'create' | 'create_deck' | 'create_block' | 'create_story' | 'create_beat' | 'update' | 'update_block' | 'update_beat' | 'delete' | 'view'
  story?: string
  beat?: string | null
  beat_kind?: 'chapter' | 'point'
  parent?: string
  summary?: string
  cites?: string[]
  final?: boolean
  spatial?: boolean
  story_layer?: boolean
  kind?: BlockKind
  items?: BlockItem[]
  children?: string[]
  text?: string
  show_title?: boolean
  compose?: string | null
  parts?: boolean
  id?: string
  deck?: string
  title?: string
  body?: string
  kicker?: string
  order?: number
  color?: string
  description?: string
  members?: string[]
  from_selection?: boolean
  add?: string[]
  remove?: string[]
  plane?: SlidePlane | null
  show?: boolean
  decks?: string[] | null
  focus?: string | null
  face?: boolean
}

export function createSlideTools(host: AppHost) {
  const { store } = host

  /** The open Unigraph in 3D — switched to it, or opened — for the view action. */
  async function explorer3d(): Promise<ExplorerHandle> {
    const current = getExplorerHandle()
    if (current && current.dims === 3) return current
    if (current) current.switchMode('3d')
    else host.navigate('/unigraph/3d')
    const h = await waitForExplorer(3)
    if (!h) throw new Error('Unigraph did not open in 3D. Navigate to /unigraph/3d in the app and try again.')
    return h
  }

  const slide = (id: string) => {
    const e = requireEntity(store, id)
    if (e.type !== SLIDE_TYPE) throw new Error(`${id} is a ${e.type}, not a slide`)
    return e
  }
  const deck = (id: string) => {
    const e = requireEntity(store, id)
    if (e.type !== DECK_TYPE) throw new Error(`${id} is a ${e.type}, not a deck`)
    return e
  }
  /** What `compose` and `beat` would be refused for, checked before anything is written: the store has no rollback. */
  const checkLinks = (realizer: 'slide' | 'block', compose: string | null | undefined, beat: string | null | undefined) => {
    if (compose && store.get(compose)?.type !== BLOCK_TYPE) throw new Error(`${compose} is not a block`)
    if (beat) {
      const b = store.get(beat)
      if (!b || b.type !== BEAT_TYPE) throw new Error(`${beat} is not a beat`)
      const kind = (b.data as { kind?: string }).kind === 'point' ? 'point' : 'chapter'
      if ((realizer === 'slide') !== (kind === 'chapter')) throw new Error('A slide realizes a chapter; a block realizes a point')
    }
  }
  const checkColor = (c: string | undefined) => {
    if (c !== undefined && !isCssColor(c)) throw new Error(`${c} is not a colour (a hex, rgb(), hsl() or a CSS colour name)`)
  }
  const describe = (id: string, withMembers: boolean) => {
    const s = slideInfo(store, slide(id))
    return {
      id: s.id,
      title: s.label,
      deck: s.deck,
      order: s.order === Number.MAX_SAFE_INTEGER ? undefined : s.order,
      kicker: s.kicker,
      body: s.body,
      plane: s.plane,
      shows: s.members.length,
      ...(withMembers ? { members: s.members.map((m) => ({ id: m, label: store.has(m) ? displayLabel(store.get(m)!) : undefined, type: store.get(m)?.type })) } : {}),
    }
  }

  return [
    betaTool({
      name: 'slides',
      description:
        'Decks, slides and the blocks slides are composed of: the human-sized layer over a graph too dense to read at once. A slide can be **composed** (`compose`: a block id) of blocks: a flow `[A] → [B] → [C]`, stats, a list, a timeline — each box bound to an entity — or text, laid out in rows and columns of other blocks (a block\'s `children`); a block can be used by many slides. In 3D a composed slide\'s blocks hang beneath it as plates (`view {parts}`), each box beaming down to its entity and a line up to every slide that uses the block. Block actions: create_block (title, kind, items | children | text, show_title), update_block (id + what changes; items and children replace the old), get/delete with a block id. Slide actions take compose (a block id; null to un-compose). **Stories** are the layer under the slides: the directed outline of a document a deck is made from — chapters and their points (`beat`s), each citing the entities it draws on, in reading order — and each chapter is realized by a slide, each point by a leaf block of it (`beat` on create/update and update_block; null to unlink). Story actions: create_story (title, deck, summary), create_beat (story, title, beat_kind chapter | point, parent chapter for a point, order, text, cites), update_beat (id + title/text/order/cites), get/delete with a story or beat id (deleting a chapter takes its points, after asking — so does deleting a point with text; the reading order is rewritten over what is left). In 3D the stack reads web → story (beats in a directed row under their slides, beams down to what they cite, lines up into what realizes them) → spatial (each slide\'s blueprint: its frame and the rectangles of its regions) → decks; `view` switches them: story_layer, spatial, final (the finished slides). A slide is a title and a few Markdown lines that *shows* some entities (`shows` relationships, slide → entity); a deck is an ordered set of slides with a colour. In Unigraph\'s 3D view the slides of the decks shown hang at fixed places above the graph, each with a beam down to every node it shows; switching decks never moves the graph. Actions: list (every deck with its slides and how many things each shows), get (a slide with what it shows), create_deck (title, color, description, order), create (a slide: deck, title, body, kicker, order, members — or from_selection: the graph\'s selection — and plane for a fixed place), update (a slide: title/body/kicker/order/deck/plane, add/remove members; or a deck: title/color/description/order), delete (a slide; a deck with all its slides — the user is asked first when a deck has slides, or a slide, block or beat has text of its own), view (the 3D slide layer: show, decks — null for all — and focus, a slide brought to the front with what it shows selected and, with face (default true), the camera turned square on to it; opens Unigraph in 3D if needed).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'create_deck', 'create_block', 'create_story', 'create_beat', 'update', 'update_block', 'update_beat', 'delete', 'view'] },
          kind: { type: 'string', enum: [...BLOCK_KINDS], description: 'create_block / update_block: flow (boxes with arrows), stats (big figures), list, timeline (value = the date), text, row / column (of `children` blocks)' },
          items: ITEMS_SCHEMA,
          children: { type: 'array', items: { type: 'string' }, description: 'create_block / update_block (row, column): the block ids laid out, in order' },
          text: { type: 'string', description: 'create_block / update_block (text): a line or two of Markdown' },
          show_title: { type: 'boolean', description: 'create_block / update_block: draw the block\'s title over it on the slide (default true)' },
          compose: { type: ['string', 'null'], description: 'create / update a slide: the block it is composed of (a row, column or a single block); null to un-compose' },
          parts: { type: 'boolean', description: 'view: hang composed slides\' blocks as plates beneath them (true, the default) or fold them into the slides' },
          story: { type: 'string', description: 'create_beat: the story the beat belongs to' },
          beat: { type: ['string', 'null'], description: 'create / update a slide (a chapter) or update_block (a point): the beat it realizes; null to unlink' },
          beat_kind: { type: 'string', enum: ['chapter', 'point'], description: 'create_beat: a chapter of the story, or a point under one (`parent`)' },
          parent: { type: 'string', description: 'create_beat (point): its chapter' },
          summary: { type: 'string', description: 'create_story: one sentence on what the story argues' },
          cites: { type: 'array', items: { type: 'string' }, description: 'create_beat / update_beat: the entities the beat draws on (update replaces)' },
          story_layer: { type: 'boolean', description: 'view: the story layer (default on when the project has stories)' },
          spatial: { type: 'boolean', description: 'view: the blueprints — each composed slide\'s frame and the rectangles of its regions (default on when the project has stories)' },
          final: { type: 'boolean', description: 'view: the finished slides (default on); off shows the layers under them alone' },
          id: { type: 'string', description: 'get / update / delete: the slide or deck' },
          deck: { type: 'string', description: 'create: the deck the slide goes in; update: move the slide to this deck' },
          title: { type: 'string', description: 'The slide\'s or deck\'s title' },
          body: { type: 'string', description: 'A slide\'s text: a few Markdown lines ("- " bullets, **bold**)' },
          kicker: { type: 'string', description: 'A small label above a slide\'s title' },
          order: { type: 'number', description: 'Place in its deck (a slide) or among the decks (a deck), from 1' },
          color: { type: 'string', description: 'A deck\'s colour (CSS), its slides\' accent and beams' },
          description: { type: 'string', description: 'A deck\'s one-sentence description' },
          members: { type: 'array', items: { type: 'string' }, description: 'create: entity ids the slide shows' },
          from_selection: { type: 'boolean', description: 'create: the slide shows what is selected in the open Unigraph' },
          add: { type: 'array', items: { type: 'string' }, description: 'update: entity ids the slide shows too' },
          remove: { type: 'array', items: { type: 'string' }, description: 'update: entity ids the slide stops showing' },
          plane: { ...PLANE_SCHEMA, type: ['object', 'null'], description: `${PLANE_SCHEMA.description} update: null puts it back on the ring.` },
          show: { type: 'boolean', description: 'view: hang the slides (true) or hide them' },
          decks: { type: ['array', 'null'], items: { type: 'string' }, description: 'view: the deck ids to show; null for every deck' },
          focus: { type: ['string', 'null'], description: 'view: the slide to bring to the front (its members selected); null for none' },
          face: { type: 'boolean', description: 'view with focus: turn the camera square on to the slide (default true)' },
        },
        required: ['action'],
        additionalProperties: false,
      } as const,
      run: async (raw) => {
        const a = raw as unknown as Input
        switch (a.action) {
          case 'list': {
            const decks = readDecks(store)
            const stories = readStories(store)
            const blocks = readBlocks(store)
            const usedBy = new Map<string, string[]>()
            for (const d of decks) for (const sl of d.slides) if (sl.compose) for (const b of [sl.compose, ...collectBlocks(sl.compose, blocks)]) usedBy.set(b, [...(usedBy.get(b) ?? []), sl.id])
            return json({
              stories: stories.map((st) => ({ id: st.id, title: st.label, deck: st.deck, outline: st.beats.map((b) => ({ id: b.id, kind: b.kind, title: b.label, cites: b.cites.length })) })),
              blocks: [...blocks.values()].map((b) => ({ id: b.id, title: b.label, kind: b.kind, ...(b.children.length ? { children: b.children } : { boxes: b.items.length }), usedBy: [...new Set(usedBy.get(b.id) ?? [])] })),
              decks: decks.map((d) => ({ id: d.id, title: d.label, color: d.color, description: d.description, slides: d.slides.map((s) => ({ id: s.id, title: s.label, order: s.order === Number.MAX_SAFE_INTEGER ? undefined : s.order, shows: s.members.length })) })),
              slides: decks.reduce((n, d) => n + d.slides.length, 0),
            })
          }
          case 'get': {
            if (!a.id) throw new Error('get needs id (a slide or a block)')
            const e = requireEntity(store, a.id)
            if (e.type === STORY_TYPE) {
              const st = readStories(store).find((x) => x.id === e.id)!
              return json({ id: st.id, title: st.label, deck: st.deck, summary: st.summary, outline: st.beats.map((b) => ({ id: b.id, kind: b.kind, title: b.label, text: b.text, cites: b.cites })) })
            }
            if (e.type === BEAT_TYPE) {
              const b = readStories(store).flatMap((x) => x.beats).find((x) => x.id === e.id)
              const realizedBy = store.relationshipsOf(e.id, 'in').filter((r) => r.type === 'realizes').map((r) => r.source.id)
              return json({ ...(b ?? { id: e.id, title: e.label }), realizedBy })
            }
            if (e.type === BLOCK_TYPE) {
              const b = blockInfo(e)
              return json({ id: b.id, title: b.label, kind: b.kind, items: b.items, children: b.children, text: b.text || undefined, showTitle: b.showTitle, shows: blockMembers(b.id, readBlocks(store)).filter((m) => store.has(m)).length })
            }
            return json(describe(a.id, true))
          }
          case 'create_story': {
            if (!a.title?.trim()) throw new Error('create_story needs a title')
            if (a.deck) deck(a.deck)
            const st = createStory(store, { label: a.title.trim(), deck: a.deck, summary: a.summary, order: a.order, source: 'assistant' })
            return json({ id: st.id })
          }
          case 'create_beat': {
            if (!a.story) throw new Error('create_beat needs story')
            if (!a.title?.trim()) throw new Error('create_beat needs a title')
            const missing = (a.cites ?? []).filter((c) => !store.has(c))
            const b = createBeat(store, { story: a.story, label: a.title.trim(), kind: a.beat_kind ?? 'chapter', parent: a.parent, order: a.order, text: a.text, cites: a.cites, source: 'assistant' })
            return json({ id: b.id, ...(missing.length ? { missing } : {}) })
          }
          case 'update_beat': {
            if (!a.id) throw new Error('update_beat needs id')
            const b = updateBeat(store, a.id, { label: a.title, text: a.text, order: a.order, cites: a.cites, source: 'assistant' })
            return json({ id: b.id, title: b.label })
          }
          case 'create_block': {
            if (!a.title?.trim()) throw new Error('create_block needs a title')
            if (!a.kind) throw new Error(`create_block needs a kind: ${BLOCK_KINDS.join(', ')}`)
            for (const c of a.children ?? []) if (store.get(c)?.type !== BLOCK_TYPE) throw new Error(`${c} is not a block`)
            const missing = (a.items ?? []).map((i) => i.ref).filter((r): r is string => !!r && !store.has(r))
            const b = createBlock(store, { label: a.title.trim(), kind: a.kind, items: a.items, children: a.children, text: a.text, showTitle: a.show_title, source: 'assistant' })
            return json({ id: b.id, kind: a.kind, ...(missing.length ? { missing } : {}) })
          }
          case 'update_block': {
            if (!a.id) throw new Error('update_block needs id')
            if (store.get(a.id)?.type !== BLOCK_TYPE) throw new Error(`${a.id} is not a block`)
            checkLinks('block', undefined, a.beat)
            for (const c of a.children ?? []) if (store.get(c)?.type !== BLOCK_TYPE) throw new Error(`${c} is not a block`)
            const b = updateBlock(store, a.id, { ...(a.title !== undefined ? { label: a.title } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.items ? { items: a.items } : {}), ...(a.children ? { children: a.children } : {}), ...(a.text !== undefined ? { text: a.text } : {}), ...(a.show_title !== undefined ? { showTitle: a.show_title } : {}), source: 'assistant' })
            if (a.beat !== undefined) realizeBeat(store, a.id, a.beat ?? undefined, 'assistant')
            const info = blockInfo(store.get(a.id) ?? b)
            return json({ id: info.id, title: info.label, kind: info.kind, boxes: info.items.length, children: info.children, ...(info.beat ? { beat: info.beat } : {}) })
          }
          case 'create_deck': {
            if (!a.title?.trim()) throw new Error('create_deck needs a title')
            checkColor(a.color)
            const d = createDeck(store, { label: a.title.trim(), color: a.color, description: a.description, order: a.order, source: 'assistant' })
            return json({ id: d.id, title: a.title.trim() })
          }
          case 'create': {
            if (!a.deck) throw new Error('create needs deck (see create_deck, or list for the decks there are)')
            deck(a.deck)
            if (!a.title?.trim()) throw new Error('create needs a title')
            checkLinks('slide', a.compose, a.beat)
            let members = a.members ?? []
            if (a.from_selection) {
              const h = getExplorerHandle()
              if (!h) throw new Error('from_selection needs Unigraph open with a selection')
              members = [...members, ...h.getState().selectedIds]
            }
            const missing = members.filter((m) => !store.has(m))
            const { slide: s, members: shown } = createSlide(store, { deck: a.deck, label: a.title.trim(), body: a.body, kicker: a.kicker, order: a.order, members, plane: a.plane ?? undefined, source: 'assistant' })
            if (a.compose) composeSlide(store, s.id, a.compose, 'assistant')
            if (a.beat) realizeBeat(store, s.id, a.beat, 'assistant')
            return json({ id: s.id, shows: shown.length, ...(a.compose ? { compose: a.compose } : {}), ...(missing.length ? { missing } : {}) })
          }
          case 'update': {
            if (!a.id) throw new Error('update needs id')
            const e = requireEntity(store, a.id)
            if (e.type === DECK_TYPE) {
              checkColor(a.color)
              const d = e.data as DeckData
              store.update(e.id, { ...(a.title !== undefined ? { label: a.title } : {}), data: { ...d, ...(a.color !== undefined ? { color: a.color } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.order !== undefined ? { order: a.order } : {}) } })
              return json({ id: e.id, updated: 'deck' })
            }
            slide(a.id)
            if (a.deck) deck(a.deck)
            checkLinks('slide', a.compose, a.beat)
            const d = { ...(e.data as SlideData) }
            if (a.deck) d.deck = a.deck
            if (a.body !== undefined) d.body = a.body
            if (a.kicker !== undefined) d.kicker = a.kicker
            if (a.order !== undefined) d.order = a.order
            if (a.plane === null) delete d.plane
            else if (a.plane) d.plane = a.plane
            let added: EntityId[] = []
            let removed: EntityId[] = []
            store.transaction(() => {
              store.update(e.id, { ...(a.title !== undefined ? { label: a.title } : {}), data: d })
              if (a.add?.length) added = addShows(store, e.id, a.add, 'assistant')
              if (a.remove?.length) removed = removeShows(store, e.id, a.remove)
              if (a.compose !== undefined) composeSlide(store, e.id, a.compose ?? undefined, 'assistant')
              if (a.beat !== undefined) realizeBeat(store, e.id, a.beat ?? undefined, 'assistant')
            })
            return json({ ...describe(e.id, false), added: added.length, removed: removed.length })
          }
          case 'delete': {
            if (!a.id) throw new Error('delete needs id')
            const e = requireEntity(store, a.id)
            const DELETE = { yes: 'Delete', danger: true } as const
            if (e.type === BEAT_TYPE) {
              // A chapter goes with its points, after asking; the story's reading order is rewritten over what is left.
              const points = store.ofType(BEAT_TYPE).filter((b) => (b.data as { parent?: string }).parent === e.id)
              if (points.length && !(await host.confirm(`Delete a chapter and its ${points.length} point${points.length === 1 ? '' : 's'}: ${quoteLabel(displayLabel(e))}?`, DELETE))) throw new Error('The user kept the chapter')
              // A point (or a chapter with none) that says something is the user's writing: asked about too.
              if (!points.length && authoredText(e) && !(await host.confirm(`Delete a ${(e.data as BeatData).parent ? 'point' : 'chapter'} with text of its own: ${quoteLabel(displayLabel(e))}?`, DELETE))) throw new Error('The user kept it')
              return json({ deleted: deleteBeats(store, [e.id], 'assistant') })
            }
            if (e.type === SLIDE_TYPE || e.type === BLOCK_TYPE) {
              // A slide or block with words of its own is asked about; an empty one (a layout, a placeholder) just goes.
              if (authoredText(e) && !(await host.confirm(`Delete a ${e.type === SLIDE_TYPE ? 'slide' : 'block'} with text of its own: ${quoteLabel(displayLabel(e))}?`, DELETE))) throw new Error('The user kept it')
              // A block a slide or another block still uses leaves a gap there; the layer draws around a missing block.
              store.remove(e.id)
              return json({ deleted: [e.id] })
            }
            if (e.type === STORY_TYPE) {
              const beats = store.ofType(BEAT_TYPE).filter((b) => (b.data as { story?: string }).story === e.id)
              if (beats.length && !(await host.confirm(`Delete a story and its ${beats.length} beat${beats.length === 1 ? '' : 's'} (its deck and slides stay): ${quoteLabel(displayLabel(e))}?`, DELETE))) throw new Error('The user kept the story')
              store.remove([e.id, ...beats.map((b) => b.id)])
              return json({ deleted: [e.id, ...beats.map((b) => b.id)] })
            }
            deck(a.id)
            const slides = store.ofType(SLIDE_TYPE).filter((s) => (s.data as SlideData).deck === e.id)
            if (slides.length && !(await host.confirm(`Delete a deck and its ${slides.length} slide${slides.length === 1 ? '' : 's'} (what they show stays): ${quoteLabel(displayLabel(e))}?`, DELETE))) throw new Error('The user kept the deck')
            store.remove([e.id, ...slides.map((s) => s.id)])
            return json({ deleted: [e.id, ...slides.map((s) => s.id)] })
          }
          case 'view': {
            const h = await explorer3d()
            const patch: { show?: boolean; decks?: EntityId[] | undefined; focus?: EntityId | undefined; parts?: boolean; story?: boolean; spatial?: boolean; final?: boolean } = {}
            if (a.story_layer !== undefined) patch.story = a.story_layer
            if (a.spatial !== undefined) patch.spatial = a.spatial
            if (a.final !== undefined) patch.final = a.final
            if (a.show !== undefined) patch.show = a.show
            if (a.parts !== undefined) patch.parts = a.parts
            if (a.decks !== undefined) {
              for (const d of a.decks ?? []) deck(d)
              patch.decks = a.decks ?? undefined
            }
            let members: EntityId[] = []
            if (a.focus !== undefined) {
              if (a.focus) {
                const s = slideInfo(store, slide(a.focus))
                members = s.members.filter((m) => store.has(m))
                // A slide brought forward is shown: its deck joins the decks shown, and the layer is on.
                const shown = a.decks !== undefined ? patch.decks : h.getState().slides.decks
                if (shown && s.deck && !shown.includes(s.deck)) patch.decks = [...shown, s.deck]
                patch.show = true
              }
              patch.focus = a.focus ?? undefined
            }
            h.setSlides(patch)
            if (a.focus) h.setSelection(members, 'replace')
            // The layer places the slides on its next frame: the camera turns once they hang.
            let faced = false
            if (a.focus && a.face !== false) {
              for (let k = 0; k < 20 && !faced; k++) {
                faced = h.faceSlide?.(a.focus) ?? false
                if (!faced) await new Promise((r) => setTimeout(r, 100))
              }
            }
            const st = h.getState().slides
            return json({ slides: st, ...(a.focus ? { selected: members.length, faced } : {}) })
          }
        }
      },
    }),
  ]
}

/** Every block under a block (rows, columns and leaves), each once. */
function collectBlocks(root: string, blocks: Map<string, { children: string[] }>): string[] {
  const out: string[] = []
  const walk = (id: string) => {
    for (const c of blocks.get(id)?.children ?? []) {
      if (out.includes(c) || c === root) continue
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

/** Whether a slide, block or beat says something of its own — a body, a kicker, a text, words in its items — which a delete would lose. */
function authoredText(e: AnyEntity): boolean {
  const d = e.data as SlideData & BlockData & BeatData
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  return has(d.body) || has(d.kicker) || has(d.text) || (Array.isArray(d.items) && d.items.some((it: BlockItem) => has(it.label) || has(it.value) || has(it.note)))
}

import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import type { EntityId } from '../../../core/entity/types'
import type { SlidesView } from '../../../core/graph/scene'
import { SHOWS } from '../../../core/slides/slides'
import { registerExplorerHandle, type ExplorerHandle } from '../../graph/explorerHandle'
import { createSlideTools } from '../slideTools'
import { withInputChecks } from '../validate'
import type { AppHost } from '../tools'

/**
 * The slides tool: decks and slides written through the store (slides
 * showing entities by `shows` relationships), and the 3D view's slide layer
 * driven through the explorer's handle — a fake one here, recording what
 * it was told.
 */
function setup(confirm = true) {
  const store = new EntityStore()
  for (const id of ['fact:a', 'fact:b', 'doc:c', 'person:d']) store.upsert(createEntity({ id, type: id.split(':')[0], label: id }))
  const asked: string[] = []
  const host: AppHost = { store, navigate: () => undefined, getContext: () => ({ route: '/' }), confirm: async (m) => (asked.push(m), confirm) }
  const tool = createSlideTools(host).map(withInputChecks).find((t) => t.name === 'slides') as BetaRunnableTool
  const run = async (input: unknown) => JSON.parse(String(await tool.run(tool.parse(input))))
  return { store, run, asked }
}

function fakeExplorer(selected: EntityId[] = []) {
  let slides: SlidesView = { show: true }
  const calls: string[] = []
  const h = {
    dims: 3,
    renderer: '3d',
    getState: () => ({ slides, selectedIds: selected }),
    setSlides: (patch: Partial<SlidesView>) => {
      const next = { ...slides, ...patch }
      if ('decks' in patch && patch.decks === undefined) delete next.decks
      if ('focus' in patch && patch.focus === undefined) delete next.focus
      slides = next
      calls.push(`slides:${JSON.stringify(patch)}`)
    },
    setSelection: (ids: EntityId[], mode?: string) => calls.push(`select:${mode}:${ids.join(',')}`),
    faceSlide: (id: EntityId) => (calls.push(`face:${id}`), true),
    switchMode: (m: string) => calls.push(`mode:${m}`),
  } as unknown as ExplorerHandle
  return { h, calls }
}

let unregister: (() => void) | null = null
afterEach(() => {
  unregister?.()
  unregister = null
})

describe('slides', () => {
  it('makes a deck and a slide that shows entities, and lists and reads them', async () => {
    const { store, run } = setup()
    const deck = await run({ action: 'create_deck', title: 'Board update', color: '#0ea5e9' })
    expect(deck.id).toBe('deck:board-update')
    const s = await run({ action: 'create', deck: deck.id, title: 'Where we are', body: '- **Cost** fell\n- yield rose', members: ['fact:a', 'doc:c', 'nope'] })
    expect(s).toMatchObject({ id: 'slide:board-update-1', shows: 2, missing: ['nope'] })
    expect(store.relationshipsOf(s.id, 'out').filter((r) => r.type === SHOWS).map((r) => r.target.id)).toEqual(['fact:a', 'doc:c'])
    const list = await run({ action: 'list' })
    expect(list.decks[0]).toMatchObject({ id: 'deck:board-update', title: 'Board update', slides: [{ id: s.id, title: 'Where we are', order: 1, shows: 2 }] })
    const got = await run({ action: 'get', id: s.id })
    expect(got.members.map((m: { id: string }) => m.id)).toEqual(['fact:a', 'doc:c'])
    expect(got.body).toContain('**Cost**')
  })

  it('updates a slide — text, members, a place of its own — and a deck', async () => {
    const { store, run } = setup()
    const { id: deck } = await run({ action: 'create_deck', title: 'Pitch' })
    const { id } = await run({ action: 'create', deck, title: 'One', members: ['fact:a'] })
    const r = await run({ action: 'update', id, title: 'Two', add: ['fact:b', 'fact:a'], remove: ['fact:a'], plane: { x: 0, y: 2, z: 1, yaw: 0.5 } })
    expect(r).toMatchObject({ title: 'Two', shows: 1, added: 1, removed: 1, plane: { x: 0, y: 2, z: 1, yaw: 0.5 } })
    await run({ action: 'update', id, plane: null })
    expect((store.get(id)!.data as { plane?: unknown }).plane).toBeUndefined()
    await run({ action: 'update', id: deck, title: 'Series B', color: '#f97316' })
    expect(store.get(deck)).toMatchObject({ label: 'Series B', data: { color: '#f97316' } })
    await expect(run({ action: 'update', id: 'fact:a', title: 'x' })).rejects.toThrow(/not a slide/)
  })

  it('deletes a deck with its slides only when the user agrees, leaving what they showed', async () => {
    const no = setup(false)
    const { id: deck } = await no.run({ action: 'create_deck', title: 'Old' })
    await no.run({ action: 'create', deck, title: 'S', members: ['fact:a'] })
    await expect(no.run({ action: 'delete', id: deck })).rejects.toThrow(/kept the deck/)
    expect(no.asked[0]).toMatch(/1 slide/)
    const yes = setup(true)
    const d2 = await yes.run({ action: 'create_deck', title: 'Old' })
    const s2 = await yes.run({ action: 'create', deck: d2.id, title: 'S', members: ['fact:a'] })
    const r = await yes.run({ action: 'delete', id: d2.id })
    expect(r.deleted).toEqual([d2.id, s2.id])
    expect(yes.store.has('fact:a')).toBe(true)
  })

  it('makes a slide from the graph selection', async () => {
    const { run } = setup()
    const { h } = fakeExplorer(['person:d', 'doc:c'])
    unregister = registerExplorerHandle(h)
    const { id: deck } = await run({ action: 'create_deck', title: 'D' })
    const r = await run({ action: 'create', deck, title: 'Picked', from_selection: true })
    expect(r.shows).toBe(2)
  })

  it('drives the slide layer: decks shown, a slide in front with what it shows selected, the camera turned to it', async () => {
    const { run } = setup()
    const { h, calls } = fakeExplorer()
    unregister = registerExplorerHandle(h)
    const a = await run({ action: 'create_deck', title: 'A' })
    const b = await run({ action: 'create_deck', title: 'B' })
    const s = await run({ action: 'create', deck: b.id, title: 'In B', members: ['fact:a', 'fact:b'] })
    let r = await run({ action: 'view', decks: [a.id] })
    expect(r.slides).toEqual({ show: true, decks: [a.id] })
    // Bringing a slide of another deck forward shows its deck too.
    r = await run({ action: 'view', focus: s.id })
    expect(r).toMatchObject({ slides: { show: true, decks: [a.id, b.id], focus: s.id }, selected: 2, faced: true })
    expect(calls).toContain(`select:replace:fact:a,fact:b`)
    expect(calls).toContain(`face:${s.id}`)
    r = await run({ action: 'view', decks: null, focus: null, show: false })
    expect(r.slides).toEqual({ show: false })
    await expect(run({ action: 'view', decks: ['fact:a'] })).rejects.toThrow(/not a deck/)
  })

  it('makes blocks, composes a slide of them, reads them back and folds the parts layer', async () => {
    const { store, run } = setup()
    const { h, calls } = fakeExplorer()
    unregister = registerExplorerHandle(h)
    const { id: deck } = await run({ action: 'create_deck', title: 'D' })
    const flow = await run({ action: 'create_block', title: 'Supply chain', kind: 'flow', items: [{ ref: 'fact:a', label: 'Mine', value: '1,200 t' }, { ref: 'doc:c' }, { ref: 'nope' }] })
    expect(flow).toMatchObject({ id: 'block:supply-chain', kind: 'flow', missing: ['nope'] })
    const stats = await run({ action: 'create_block', title: 'Numbers', kind: 'stats', items: [{ ref: 'fact:b', value: '92%' }] })
    const row = await run({ action: 'create_block', title: 'Both', kind: 'row', children: [flow.id, stats.id] })
    await expect(run({ action: 'create_block', title: 'Bad', kind: 'row', children: ['fact:a'] })).rejects.toThrow(/not a block/)
    const s = await run({ action: 'create', deck, title: 'Composed', compose: row.id })
    expect(s.compose).toBe(row.id)
    const got = await run({ action: 'get', id: s.id })
    expect(got.members.map((m: { id: string }) => m.id).sort()).toEqual(['doc:c', 'fact:a', 'fact:b'])
    const b = await run({ action: 'get', id: flow.id })
    expect(b).toMatchObject({ kind: 'flow', shows: 2 })
    await run({ action: 'update_block', id: flow.id, items: [{ ref: 'person:d' }] })
    expect((await run({ action: 'get', id: s.id })).members.map((m: { id: string }) => m.id).sort()).toEqual(['fact:b', 'person:d'])
    const list = await run({ action: 'list' })
    expect(list.blocks.find((x: { id: string }) => x.id === flow.id).usedBy).toEqual([s.id])
    await run({ action: 'update', id: s.id, compose: null })
    expect((store.get(s.id)!.data as { compose?: string }).compose).toBeUndefined()
    const v = await run({ action: 'view', parts: false })
    expect(v.slides.parts).toBe(false)
    expect(calls.some((c) => c.includes('"parts":false'))).toBe(true)
  })

  it('makes a story whose chapters and points slides and blocks realize, and switches the layers', async () => {
    const { store, run } = setup()
    const { h } = fakeExplorer()
    unregister = registerExplorerHandle(h)
    const { id: deck } = await run({ action: 'create_deck', title: 'D' })
    const block = await run({ action: 'create_block', title: 'Flow', kind: 'flow', items: [{ ref: 'fact:a' }] })
    const slide = await run({ action: 'create', deck, title: 'S', compose: block.id })
    const st = await run({ action: 'create_story', title: 'The story', deck, summary: 'It argues.' })
    const ch = await run({ action: 'create_beat', story: st.id, title: 'Chapter one', beat_kind: 'chapter', cites: ['doc:c', 'nope'] })
    expect(ch.missing).toEqual(['nope'])
    const pt = await run({ action: 'create_beat', story: st.id, title: 'A point', beat_kind: 'point', parent: ch.id, cites: ['fact:a'] })
    await expect(run({ action: 'create_beat', story: st.id, title: 'Orphan', beat_kind: 'point' })).rejects.toThrow(/parent/)
    await run({ action: 'update', id: slide.id, beat: ch.id })
    await run({ action: 'update_block', id: block.id, beat: pt.id })
    await expect(run({ action: 'update', id: slide.id, beat: pt.id })).rejects.toThrow(/realizes a chapter/)
    const got = await run({ action: 'get', id: st.id })
    expect(got.outline.map((b: { id: string }) => b.id)).toEqual([ch.id, pt.id])
    const beat = await run({ action: 'get', id: pt.id })
    expect(beat.realizedBy).toEqual([block.id])
    await run({ action: 'update_beat', id: pt.id, cites: ['person:d'] })
    expect((await run({ action: 'get', id: pt.id })).cites).toEqual(['person:d'])
    const list = await run({ action: 'list' })
    expect(list.stories[0].outline).toHaveLength(2)
    const v = await run({ action: 'view', story_layer: true, spatial: true, final: false })
    expect(v.slides).toMatchObject({ story: true, spatial: true, final: false })
    expect(store.has(st.id)).toBe(true)
  })

  it('checks everything before it writes: a refused call leaves nothing half made', async () => {
    const { store, run } = setup()
    const { id: deck } = await run({ action: 'create_deck', title: 'D' })
    const before = store.ofType('slide').length
    await expect(run({ action: 'create', deck, title: 'X', compose: 'fact:a' })).rejects.toThrow(/not a block/)
    expect(store.ofType('slide').length).toBe(before)
    const st = await run({ action: 'create_story', title: 'S', deck })
    const ch = await run({ action: 'create_beat', story: st.id, title: 'C', beat_kind: 'chapter' })
    const pt = await run({ action: 'create_beat', story: st.id, title: 'P', beat_kind: 'point', parent: ch.id })
    const { id } = await run({ action: 'create', deck, title: 'Y' })
    await expect(run({ action: 'update', id, title: 'Renamed', add: ['fact:a'], beat: pt.id })).rejects.toThrow(/realizes a chapter/)
    expect(store.get(id)!.label).toBe('Y')
    expect(store.relationshipsOf(id, 'out').filter((r) => r.type === 'shows')).toHaveLength(0)
    await expect(run({ action: 'create_deck', title: 'Bad', color: 'url(https://x.example/a.png)' })).rejects.toThrow(/not a colour/)
    // Deleting a chapter asks, takes its points, and keeps the chain.
    const del = await run({ action: 'delete', id: ch.id })
    expect(del.deleted.sort()).toEqual([ch.id, pt.id].sort())
  })
})

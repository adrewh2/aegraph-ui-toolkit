import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createChatTools } from '../chatTools'
import { withInputChecks } from '../validate'
import { chatEntityId } from '../record'
import type { AppHost } from '../tools'

/**
 * The chat tool over a stand-in for the panel's chats (the real module
 * holds sessions, which hold the tools — chats.test.ts covers it): the
 * tool's own work is naming the tabs, moving between them, and the
 * errors a caller can fix.
 */
type Fake = { id: string; title: string; busy: boolean; active: boolean; users: number; extra?: unknown[] }
const tabs: Fake[] = []
let next = 1
const session = (t: Fake) => ({ id: t.id, getState: () => ({ items: [...Array.from({ length: t.users }, () => ({ kind: 'user' })), ...(t.extra ?? [])] }) })
const fake = {
  list: () => tabs.map(({ id, title, busy, active }) => ({ id, title, busy, active })),
  get: (id: string) => {
    const t = tabs.find((x) => x.id === id)
    return t ? session(t) : undefined
  },
  create: () => {
    for (const t of tabs) t.active = false
    const t: Fake = { id: `c${next++}`, title: 'New chat', busy: false, active: true, users: 0 }
    tabs.push(t)
    return session(t)
  },
  open: (id: string) => {
    for (const t of tabs) t.active = t.id === id
  },
  close: (id: string) => {
    const i = tabs.findIndex((t) => t.id === id)
    if (i >= 0) tabs.splice(i, 1)
  },
  rename: (id: string, title: string) => {
    const t = tabs.find((x) => x.id === id)
    if (t) t.title = title
  },
  delete: (id: string, store: EntityStore) => {
    const i = tabs.findIndex((t) => t.id === id)
    if (i >= 0) tabs.splice(i, 1)
    const entity = store.get(id) ? id : undefined
    if (entity) store.remove(entity)
    return { ...(i >= 0 ? { chat: id } : {}), ...(entity ? { entity } : {}) }
  },
  resume: (e: { id: string; type: string; meta: { source?: string } } | undefined) => {
    if (!e || e.type !== 'conversation' || e.meta.source !== 'assistant') return undefined
    const s = fake.create()
    const t = tabs.find((x) => x.id === s.id)!
    t.title = 'Resumed'
    t.users = 3
    return session(t)
  },
}
vi.mock('../chats', () => ({ chats: fake }))

function setup({ answer = true } = {}) {
  const store = new EntityStore()
  const went: string[] = []
  const asked: string[] = []
  const host: AppHost = { store, navigate: (p: string) => void went.push(p), getContext: () => ({ route: '/' }), confirm: async (m: string) => (asked.push(m), answer) }
  const t = withInputChecks(createChatTools(host).find((x) => x.name === 'chat') as BetaRunnableTool)
  const run = async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  return { store, run, went, asked }
}

describe('chat tool', () => {
  beforeEach(() => {
    tabs.length = 0
    next = 1
    fake.create()
  })

  it('lists the tabs with their conversation entities, opens new ones, switches, renames and closes', async () => {
    const { run } = setup()
    const first = await run({ action: 'list' })
    expect(first.chats).toEqual([{ id: 'c1', title: 'New chat', busy: false, active: true, messages: 0, entity: chatEntityId('c1') }])
    const opened = await run({ action: 'new', title: 'Planning' })
    expect(opened.opened).toBe('c2')
    expect(opened.chats.map((c: { title: string; active: boolean }) => [c.title, c.active])).toEqual([
      ['New chat', false],
      ['Planning', true],
    ])
    expect((await run({ action: 'open', id: 'c1' })).chats.find((c: { id: string }) => c.id === 'c1').active).toBe(true)
    expect((await run({ action: 'rename', id: 'c1', title: 'Notes' })).chats[0].title).toBe('Notes')
    expect((await run({ action: 'close', id: 'c2' })).chats.map((c: { id: string }) => c.id)).toEqual(['c1'])
  })

  it('resumes a recorded conversation and refuses one the assistant did not record', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: chatEntityId('old'), type: 'conversation', label: 'Old chat', data: { messages: [] }, meta: { source: 'assistant' } }))
    store.upsert(createEntity({ id: 'gpt', type: 'conversation', label: 'Imported', data: { messages: [] }, meta: { source: 'chatgpt-export' } }))
    const r = await run({ action: 'resume', id: chatEntityId('old') })
    expect(r.opened).toBe('c2')
    expect(r.messages).toBe(3)
    expect(r.chats.find((c: { id: string }) => c.id === 'c2')).toMatchObject({ title: 'Resumed', active: true, messages: 3 })
    await expect(run({ action: 'resume', id: 'gpt' })).rejects.toThrow(/not a conversation recorded by the assistant/)
    await expect(run({ action: 'resume', id: 'missing' })).rejects.toThrow(/not a conversation/)
  })

  it('lists what a chat made — live or recorded — and shows it on the Chats page', async () => {
    const { store, run, went } = setup()
    store.upsert(createEntity({ id: 'doc-1', type: 'document', label: 'Plan', data: {} }))
    store.upsert(createEntity({ id: 'dia-1', type: 'diagram', label: 'Flow', data: {} }))
    store.upsert(createEntity({ id: 'scene-1', type: 'scene:unigraph', label: 'People', data: {} }))
    const live = await run({ action: 'new' })
    tabs.find((t) => t.id === live.opened)!.extra = [
      { kind: 'tool', id: 't1', name: 'create_document', input: { title: 'Plan' }, status: 'done', result: '{"id":"doc-1","type":"document"}', startedAt: 1000 },
      { kind: 'tool', id: 't2', name: 'graph_save', input: {}, status: 'done', result: '{"id":"scene-1"}', startedAt: 2000 },
      { kind: 'tool', id: 't3', name: 'get_entity', input: { id: 'dia-1' }, status: 'done', result: '{"id":"dia-1"}' },
    ]
    const listed = await run({ action: 'artifacts', id: live.opened })
    expect(listed.artifacts.map((a: { id: string; kind: string; opens: string }) => [a.id, a.kind, a.opens])).toEqual([
      ['scene-1', 'scene', '/unigraph/2d?scene=scene-1'],
      ['doc-1', 'document', '/artifact/doc-1'],
    ])
    // The chat in front is the default.
    expect((await run({ action: 'artifacts' })).chat).toBe(live.opened)
    // A recorded chat, not open: its record's list, found by its entity id.
    store.upsert(createEntity({ id: chatEntityId('old2'), type: 'conversation', label: 'Old', data: { source: 'assistant', sourceId: 'old2', messages: [], artifacts: [{ id: 'dia-1', tool: 'create_diagram' }] }, meta: { source: 'assistant' } }))
    expect((await run({ action: 'artifacts', id: chatEntityId('old2') })).artifacts.map((a: { id: string }) => a.id)).toEqual(['dia-1'])
    // show: no page listening, so it navigates there, with the artifact to open.
    expect(await run({ action: 'show', id: live.opened, artifact: 'doc-1' })).toMatchObject({ shown: live.opened, artifact: 'doc-1' })
    expect(went.at(-1)).toBe(`/chats/${live.opened}?artifact=doc-1`)
    // Any entity can be shown there, not only what the chat made; a missing one is refused.
    expect(await run({ action: 'show', id: live.opened, artifact: 'dia-1' })).toMatchObject({ artifact: 'dia-1' })
    await expect(run({ action: 'show', id: live.opened, artifact: 'gone' })).rejects.toThrow(/No entity gone/)
    await expect(run({ action: 'artifacts', id: 'nope' })).rejects.toThrow(/neither a chat/)
  })

  it('deletes a chat or a conversation for good, only once the user confirms', async () => {
    const { store, run, asked } = setup()
    await run({ action: 'new', title: 'Scratch' })
    const r = await run({ action: 'delete', id: 'c2' })
    expect(asked[0]).toMatch(/^Delete a chat for good .* “Scratch”\?$/)
    expect(r).toMatchObject({ deleted: true, chat: 'c2' })
    expect(r.chats.map((c: { id: string }) => c.id)).toEqual(['c1'])
    // An imported conversation, by its entity.
    store.upsert(createEntity({ id: 'gpt', type: 'conversation', label: 'Imported', data: { messages: [] }, meta: { source: 'chatgpt-export' } }))
    expect(await run({ action: 'delete', id: 'gpt' })).toMatchObject({ deleted: true, entity: 'gpt' })
    expect(store.get('gpt')).toBeUndefined()
    // Anything else is refused before anyone is asked.
    store.upsert(createEntity({ id: 'doc', type: 'document', label: 'Doc', data: {} }))
    await expect(run({ action: 'delete', id: 'doc' })).rejects.toThrow(/neither a chat nor a conversation/)
    expect(asked).toHaveLength(2)
  })

  it('deletes nothing when the user declines', async () => {
    const { run } = setup({ answer: false })
    expect(await run({ action: 'delete', id: 'c1' })).toEqual({ deleted: false, reason: 'The user declined.' })
    expect(tabs.map((t) => t.id)).toEqual(['c1'])
  })

  it('says what is missing', async () => {
    const { run } = setup()
    await expect(run({ action: 'open' })).rejects.toThrow(/needs an id/)
    await expect(run({ action: 'open', id: 'nope' })).rejects.toThrow(/No chat nope/)
    await expect(run({ action: 'rename', id: 'c1' })).rejects.toThrow(/needs a title/)
    await expect(run({ action: 'rename', id: 'c1', title: '  ' })).rejects.toThrow(/needs a title/)
    await expect(run({ action: 'delete' })).rejects.toThrow(/needs an id/)
  })
})

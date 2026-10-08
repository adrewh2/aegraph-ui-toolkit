import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A localStorage for node: the chats list and each chat's transcript live in it. */
const storage = new Map<string, string>()
const fakeStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) }

// Each test imports the chats module afresh (resetModules), and with it the sessions and the whole tool set — seconds of
// transform on a machine running other suites in parallel; the default five would fail on load alone, not on the logic.
describe('chats', { timeout: 30_000 }, () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts with one empty chat, opens more, switches, closes, and the last tab closes into a fresh one', async () => {
    const { chats: c } = await import('../chats')
    expect(c.list()).toHaveLength(1)
    const first = c.active()
    expect(c.create()).toBe(first) // an empty chat in front is the new chat
    first.rename('Planning')
    const second = c.create()
    expect(second).not.toBe(first)
    expect(c.list().map((t) => [t.title, t.active])).toEqual([
      ['Planning', false],
      ['New chat', true],
    ])
    c.open(first.id)
    expect(c.active()).toBe(first)
    c.close(first.id)
    expect(c.active()).toBe(second)
    c.close(second.id)
    expect(c.list()).toHaveLength(1)
    expect(c.active()).not.toBe(second)
  })

  /**
   * The id is the chat's storage key, its address and its conversation entity, so two chats must never mint the
   * same one. It used to be a timestamp in base 36 with a counter that starts again on every page load — two tabs
   * opening a chat in the same millisecond collided and shared a transcript.
   */
  it('mints a UUID for every chat', async () => {
    const { chats: c } = await import('../chats')
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const first = c.active()
    first.rename('Planning') // an empty, unnamed chat in front *is* the new chat
    const second = c.create()
    expect(first.id).toMatch(UUID)
    expect(second.id).toMatch(UUID)
    expect(second.id).not.toBe(first.id)
  })

  it('keeps the list and each chat under its own key, and brings them back', async () => {
    const { chats: c } = await import('../chats')
    const a = c.active()
    c.rename(a.id, 'First')
    const b = c.create()
    c.rename(b.id, 'Second')
    expect(JSON.parse(storage.get('aegraph:ai:chats')!)).toMatchObject({ ids: [a.id, b.id], active: b.id })
    await new Promise((r) => setTimeout(r, 500)) // the chats persist a little after the last change
    expect(storage.has(`aegraph:ai:session:${a.id}`)).toBe(true)
    vi.resetModules() // a reload
    const { chats: again } = await import('../chats')
    expect(again.list().map((t) => [t.id, t.title, t.active])).toEqual([
      [a.id, 'First', false],
      [b.id, 'Second', true],
    ])
  })

  it('turns the single chat from before tabs into the first tab', async () => {
    storage.set('aegraph:ai:session', JSON.stringify({ history: [], items: [{ kind: 'user', id: 'u1', text: 'What is on screen right now?' }] }))
    const { chats: c } = await import('../chats')
    expect(c.list()).toHaveLength(1)
    expect(c.active().title()).toBe('What is on screen right now?')
    expect(storage.has('aegraph:ai:session')).toBe(false)
  })
})

describe('chats as conversation entities', { timeout: 30_000 }, () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('records a chat in the open project as a conversation, keeps it current, and keeps it when the tab closes', async () => {
    const { EntityStore } = await import('../../../core/entity/store')
    const { createEntity } = await import('../../../core/entity/entity')
    const { isConversation } = await import('../../conversations/conversation')
    const { chatEntityId } = await import('../record')
    storage.set('aegraph:ai:chats', JSON.stringify({ ids: ['c1'], active: 'c1' }))
    storage.set('aegraph:ai:session:c1', JSON.stringify({ history: [], items: [{ kind: 'user', id: 'u1', text: 'Filter the graph to people' }, { kind: 'tool', id: 't1', name: 'graph_filter', input: { types: ['person'] }, status: 'done', result: '{"nodes":84}' }, { kind: 'assistant', id: 'a1', text: 'Filtered to 84 people.', streaming: false }] }))
    const { chats: c } = await import('../chats')
    const store = new EntityStore()
    const project = createEntity({ type: 'project', label: 'P', data: {} })
    store.upsert(project)
    store.setScope(project.id)
    c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
    expect(c.recordNow()).toBe(1)
    const e = store.get(chatEntityId('c1'))
    expect(isConversation(e)).toBe(true)
    if (!isConversation(e)) return
    expect(e.label).toBe('Filter the graph to people')
    expect(e.data.source).toBe('assistant')
    expect(e.meta.projects).toEqual([project.id])
    expect(e.data.messages.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(e.data.messages[1].content).toContain('graph_filter {"types":["person"]}')
    expect(e.data.messageCount).toBe(2)
    // A read (graph_filter) is not an artifact: nothing made, nothing listed.
    expect(e.data.artifacts).toBeUndefined()
    // Unchanged: nothing rewritten.
    expect(c.recordNow()).toBe(0)
    // A change (here, a rename) is written on the next pass, to the same entity, still in the project.
    c.rename('c1', 'People filter')
    expect(c.recordNow()).toBe(1)
    expect(store.get(chatEntityId('c1'))?.label).toBe('People filter')
    expect(store.get(chatEntityId('c1'))?.meta.projects).toEqual([project.id])
    // Closing the tab keeps the record.
    c.close('c1')
    expect(store.get(chatEntityId('c1'))).toBeTruthy()
    expect(store.all().filter((x) => x.type === 'conversation')).toHaveLength(1)
  })

  it('keeps what the chat made, whole, in the record — and across a resume', async () => {
    const { EntityStore } = await import('../../../core/entity/store')
    const { isConversation } = await import('../../conversations/conversation')
    const { chatEntityId } = await import('../record')
    const long = 'x'.repeat(2000) // past what the record keeps of a result: the id still survives in `artifacts`
    storage.set('aegraph:ai:chats', JSON.stringify({ ids: ['c2'], active: 'c2' }))
    storage.set('aegraph:ai:session:c2', JSON.stringify({ history: [], items: [{ kind: 'user', id: 'u1', text: 'Write a plan' }, { kind: 'tool', id: 't1', name: 'create_document', input: { title: 'Plan', content: long }, status: 'done', result: JSON.stringify({ id: 'doc-1', type: 'document', note: long }), startedAt: 1000 }] }))
    const { chats: c } = await import('../chats')
    const store = new EntityStore()
    c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
    c.recordNow()
    const e = store.get(chatEntityId('c2'))
    if (!isConversation(e)) throw new Error('not recorded')
    expect(e.data.artifacts).toEqual([{ id: 'doc-1', tool: 'create_document', at: new Date(1000).toISOString() }])
    // Closed and resumed from the record: the truncated tool result no longer names the document, the list still does.
    c.close('c2')
    const s = c.resume(store.get(chatEntityId('c2')))!
    // The next turn, as a live chat adds it (push is how the session appends an item).
    const push = (s as unknown as { push: (it: unknown) => void }).push.bind(s)
    push({ kind: 'user', id: 'u2', text: 'And a diagram' })
    push({ kind: 'tool', id: 't2', name: 'create_diagram', input: {}, status: 'done', result: '{"id":"dia-1"}', startedAt: 2000 })
    c.recordNow()
    const again = store.get(chatEntityId('c2'))
    if (!isConversation(again)) throw new Error('not recorded')
    expect(again.data.artifacts?.map((r) => r.id)).toEqual(['doc-1', 'dia-1'])
  })

  it('writes the record when a message is sent and when the reply is complete — never token by token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { EntityStore } = await import('../../../core/entity/store')
      const { isConversation } = await import('../../conversations/conversation')
      const { chatEntityId } = await import('../record')
      const { chats: c } = await import('../chats')
      const store = new EntityStore()
      let writes = 0
      store.subscribe(() => void writes++)
      c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
      const s = c.active()
      const set = (s as unknown as { set: (p: object) => void }).set.bind(s)
      const user = { kind: 'user', id: 'u1', text: 'Write a document about snakes' }
      // Sent: the turn starts.
      set({ busy: true, items: [user] })
      vi.advanceTimersByTime(1500)
      const atSend = writes
      expect(atSend).toBeGreaterThan(0)
      // A reply streaming, token by token, for ten seconds: no record writes.
      let text = ''
      for (let i = 0; i < 200; i++) {
        text += 'snakes are legless reptiles. '
        set({ items: [user, { kind: 'assistant', id: 'a1', text, streaming: true }] })
        vi.advanceTimersByTime(50)
      }
      expect(writes).toBe(atSend)
      // Received in full: the turn ends, and the record holds the whole reply.
      set({ busy: false, items: [user, { kind: 'assistant', id: 'a1', text, streaming: false }] })
      vi.advanceTimersByTime(1500)
      expect(writes).toBeGreaterThan(atSend)
      const e = store.get(chatEntityId(s.id))
      if (!isConversation(e)) throw new Error('not recorded')
      expect(e.data.messages.at(-1)?.content).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes a chat for good — its tab, its transcript, its artifact tabs and its record — or a recorded one by its entity', async () => {
    const { EntityStore } = await import('../../../core/entity/store')
    const { chatEntityId } = await import('../record')
    const said = (text: string) => JSON.stringify({ history: [], items: [{ kind: 'user', id: 'u1', text }, { kind: 'assistant', id: 'a1', text: 'Done.', streaming: false }] })
    storage.set('aegraph:ai:chats', JSON.stringify({ ids: ['c1', 'c2'], active: 'c1' }))
    storage.set('aegraph:ai:session:c1', said('First'))
    storage.set('aegraph:ai:session:c2', said('Second'))
    storage.set('aegraph:chats:artifacts:c1', '{}')
    const { chats: c } = await import('../chats')
    const store = new EntityStore()
    c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
    expect(c.recordNow()).toBe(2)
    // The chat in front, deleted: the next one comes forward and nothing of it is left.
    expect(c.delete('c1')).toEqual({ chat: 'c1', entity: chatEntityId('c1') })
    expect(c.get('c1')).toBeUndefined()
    expect(c.active().id).toBe('c2')
    expect(store.get(chatEntityId('c1'))).toBeUndefined()
    expect(storage.has('aegraph:ai:session:c1')).toBe(false)
    expect(storage.has('aegraph:chats:artifacts:c1')).toBe(false)
    // A pending record write does not bring it back.
    expect(c.recordNow()).toBe(0)
    expect(store.get(chatEntityId('c1'))).toBeUndefined()
    // A chat closed earlier, deleted by its record.
    c.close('c2')
    expect(store.get(chatEntityId('c2'))).toBeTruthy()
    expect(c.delete(chatEntityId('c2'))).toEqual({ chat: 'c2', entity: chatEntityId('c2') })
    expect(store.get(chatEntityId('c2'))).toBeUndefined()
    expect(c.delete('nothing')).toBeNull()
  })

  it('records nothing for a chat nobody has spoken in', async () => {
    const { EntityStore } = await import('../../../core/entity/store')
    const { chats: c } = await import('../chats')
    const store = new EntityStore()
    c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
    c.create()
    expect(c.recordNow()).toBe(0)
    expect(store.all()).toHaveLength(0)
  })
  it('a closed chat stays forgotten: a write already scheduled does not store its transcript again', async () => {
    vi.useFakeTimers()
    try {
      const { chats: c } = await import('../chats')
      const { storageKeyFor } = await import('../session')
      const gone = c.create()
      gone.rename('Soon closed') // schedules the transcript's write
      c.close(gone.id)
      vi.advanceTimersByTime(2000)
      expect(storage.has(storageKeyFor(gone.id))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a tool card's text, not a copy of the picture it returned", async () => {
    const { cardText } = await import('../session')
    const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } }, { type: 'text', text: '{"id":"img-1","width":640}' }]
    expect(cardText(blocks)).toBe('[image]\n{"id":"img-1","width":640}')
    expect(cardText({ id: 'x' })).toBe('{"id":"x"}')
  })
})

describe('resuming a recorded chat', { timeout: 30_000 }, () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('rebuilds the transcript and an alternating history from the record', async () => {
    const { rebuildChat } = await import('../record')
    const { items, history } = rebuildChat([
      { id: 'u1', role: 'user', content: 'Filter the graph to people' },
      { id: 't1', role: 'tool', content: 'graph_filter {"types":["person"]}\n→ {"nodes":84}' },
      { id: 'a1', role: 'assistant', content: 'Filtered to 84 people.' },
      { id: 'q1', role: 'system', content: 'Which one? [The map / A note] — chose A note' },
      { id: 'u2', role: 'user', content: 'and frame Ada' },
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant', 'error', 'user'])
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'graph_filter', input: { types: ['person'] }, status: 'done', result: '{"nodes":84}' })
    expect(history.map((h) => h.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[1].content).toContain('(used graph_filter: {"nodes":84})')
    expect(history[1].content).toContain('Filtered to 84 people.')
    expect(history[3].content).toContain('resumed')
  })

  it('reopens the tab when it is still there, else seeds a new one from the entity, and keeps recording to it', async () => {
    const { EntityStore } = await import('../../../core/entity/store')
    const { chatEntityId } = await import('../record')
    const { isConversation } = await import('../../conversations/conversation')
    storage.set('aegraph:ai:chats', JSON.stringify({ ids: ['c1'], active: 'c1' }))
    storage.set('aegraph:ai:session:c1', JSON.stringify({ history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], claudeSession: 'cc-123', items: [{ kind: 'user', id: 'u1', text: 'hi' }, { kind: 'assistant', id: 'a1', text: 'hello', streaming: false }] }))
    // The module reads the list and each chat's transcript as it evaluates, so it has to be a *fresh* copy that sees
    // what was just written: an earlier test's import can still be in flight when `beforeEach` resets the registry,
    // and the copy it finishes loading would have read an empty store. (Only ever under load — which is a full run.)
    vi.resetModules()
    const { chats: c } = await import('../chats')
    const store = new EntityStore()
    c.attachHost({ store, navigate: () => {}, getContext: () => ({ route: '/' }) })
    c.recordNow()
    const entity = store.get(chatEntityId('c1'))
    expect(isConversation(entity) && entity.data.claudeSession).toBe('cc-123')
    // Still open: the same tab comes to the front.
    c.create()
    expect(c.active().id).not.toBe('c1')
    expect(c.resume(entity)).toBe(c.get('c1'))
    expect(c.active().id).toBe('c1')
    // Closed: a new tab with the same id, seeded from the record, with the Claude Code session to resume.
    c.close('c1')
    expect(c.get('c1')).toBeUndefined()
    const again = c.resume(store.get(chatEntityId('c1')))!
    expect(again.id).toBe('c1')
    expect(again.getState().items.map((i) => i.kind)).toEqual(['user', 'assistant'])
    expect(again.claudeSessionId).toBe('cc-123')
    expect(c.active()).toBe(again)
    // It records to the same entity.
    c.rename('c1', 'Greetings')
    c.recordNow()
    expect(store.get(chatEntityId('c1'))?.label).toBe('Greetings')
    expect(store.all().filter((e) => e.type === 'conversation')).toHaveLength(1)
    // Not a recorded chat: nothing to resume.
    expect(c.resume(undefined)).toBeNull()
  })

  /** A new chat nobody has typed in is a tab in the panel, not a chat on the Chats page or in the sidebar's count. */
  it('leaves a blank chat out of what the list and the sidebar count read, until something is typed in it', async () => {
    const { chats: c } = await import('../chats')
    const { openChatIds } = await import('../instance')
    const a = c.active()
    expect(c.list()).toMatchObject([{ id: a.id, blank: true }])
    expect(c.ids()).toEqual([])
    expect(JSON.parse(storage.get('aegraph:ai:chats')!).blank).toEqual([a.id])
    c.rename(a.id, 'Planning')
    expect(c.list()[0].blank).toBe(false)
    expect(c.ids()).toEqual([`${a.id}\t`])
    expect(openChatIds()).toBe(`${a.id}\t`)
    expect(JSON.parse(storage.get('aegraph:ai:chats')!).blank).toEqual([])
  })

  it('does not count a stored blank chat before the chats load', async () => {
    storage.set('aegraph:ai:chats', JSON.stringify({ ids: ['x', 'y'], blank: ['y'], projects: { x: 'p1', y: 'p1' } }))
    const { openChatIds } = await import('../instance')
    expect(openChatIds()).toBe('x\tp1')
  })
})

describe('a chat restored after the page reloaded', { timeout: 30_000 }, () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows a call that was running as outcome unknown — it may have finished — not as failed', async () => {
    const { AssistantSession, storageKeyFor, RELOADED } = await import('../session')
    storage.set(storageKeyFor('c1'), JSON.stringify({ history: [], items: [
      { kind: 'tool', id: 't1', name: 'move_document', input: { id: 'a', folder_id: 'f' }, status: 'done', result: '{}' },
      { kind: 'tool', id: 't2', name: 'move_document', input: {}, partial: '{"id":"ee14', status: 'running', startedAt: 1 },
    ] }))
    const s = new AssistantSession('c1')
    const [done, cut] = s.getState().items as { status: string; result?: string; partial?: string }[]
    expect(done.status).toBe('done')
    expect(cut).toMatchObject({ status: 'unknown', result: RELOADED, partial: '{"id":"ee14' })
    expect(RELOADED).toMatch(/may well have finished/)
  })
})

describe('chats belong to a project', { timeout: 30_000 }, () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows only the open project’s chats, brings its own forward on a switch, and records each where it started', async () => {
    const { chats: c } = await import('../chats')
    const { EntityStore } = await import('../../../core/entity/store')
    const { createEntity } = await import('../../../core/entity/entity')
    const { chatEntityId } = await import('../chatIds')
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'project:a', type: 'project', label: 'A' }), createEntity({ id: 'project:b', type: 'project', label: 'B' })])
    store.setScope('project:a')
    c.attachHost({ store, navigate: () => {}, getContext: () => ({}) as never })
    const inA = c.active()
    inA.rename('Planning A')
    const second = c.create()
    second.rename('Second in A')
    expect(c.list().map((t) => t.title)).toEqual(['Planning A', 'Second in A'])

    // Project B: a fresh chat of its own, and A's are not among its tabs.
    store.setScope('project:b')
    const inB = c.active()
    expect(inB).not.toBe(second)
    expect(c.list().map((t) => t.id)).toEqual([inB.id])
    expect(c.projectOf(inB.id)).toBe('project:b')

    // Back to A: the chat that was in front there comes back.
    store.setScope('project:a')
    expect(c.active()).toBe(second)
    expect(c.list()).toHaveLength(2)

    // The Library shows every chat.
    store.setScope(null)
    expect(c.list()).toHaveLength(3)

    // A chat is recorded into the project it started in, whichever is open when the record is written.
    inB.seed([{ kind: 'user', id: 'u', text: 'hello from B' }], [])
    store.setScope('project:a')
    c.recordNow()
    expect(store.get(chatEntityId(inB.id))?.meta.projects).toEqual(['project:b'])
  })
})

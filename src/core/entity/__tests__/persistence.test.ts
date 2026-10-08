import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../entity'
import { Persistence } from '../persistence'
import { EntityStore } from '../store'

/**
 * The store as this browser keeps it. Each test gets an empty IndexedDB (fake-indexeddb: the real semantics —
 * transactions, cursors, key order — in memory), and no BroadcastChannel, so two instances here are two writers
 * on one database and nothing else: what a second tab, or the instance a dev server's hot swap leaves behind, is.
 */
const notes = (prefix: string, n: number, label = 'v1') => Array.from({ length: n }, (_, i) => createEntity({ id: `${prefix}-${i}`, type: 'note', label }))

async function reread(): Promise<EntityStore> {
  const store = new EntityStore()
  await new Persistence().load(store)
  return store
}

async function attached(): Promise<{ store: EntityStore; p: Persistence }> {
  const store = new EntityStore()
  const p = new Persistence()
  await p.load(store)
  p.attach(store)
  return { store, p }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('BroadcastChannel', undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('the store in IndexedDB', () => {
  it('preserves an older database atomically instead of erasing it during upgrade', async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('aegraph', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('legacy', { keyPath: 'id' }).put({ id: 'only-copy', text: 'saved work' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    old.close()
    await expect(new Persistence().load(new EntityStore())).rejects.toThrow(/data has been preserved/)
    const back = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('aegraph', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(back.version).toBe(1)
    const record = await new Promise((resolve, reject) => {
      const request = back.transaction('legacy').objectStore('legacy').get('only-copy')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(record).toEqual({ id: 'only-copy', text: 'saved work' })
    back.close()
  })

  it('keeps a bulk write and a small one', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('bulk', 1200))
    store.upsert(createEntity({ id: 'one', type: 'note', label: 'one' }))
    await p.flush()
    expect(p.getStatus().state).toBe('idle')
    const back = await reread()
    expect(back.ofType('note')).toHaveLength(1201)
  })

  it('reads back the newest of every entity, in the order first written: later pages over earlier, small writes over pages, deletions gone', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('n', 1200))
    await p.flush()
    // A second bulk write rewrites some and adds more; small writes change one again; deletions.
    store.upsertMany([...notes('n', 3, 'v2'), ...notes('m', 1100)])
    await p.flush()
    store.upsert(createEntity({ id: 'n-1', type: 'note', label: 'v3' }))
    store.remove(['n-2', 'm-5'])
    await p.flush()
    const back = await reread()
    const ids = back.all().map((e) => e.id)
    expect(ids).toHaveLength(1200 + 1100 - 2)
    expect(ids.slice(0, 3)).toEqual(['n-0', 'n-1', 'n-3'])
    expect(ids.indexOf('m-0')).toBe(1199)
    expect(back.get('n-0')?.label).toBe('v2')
    expect(back.get('n-1')?.label).toBe('v3')
    expect(back.get('n-2')).toBeUndefined()
    expect(back.get('m-5')).toBeUndefined()
  })

  it('keeps two writers’ pages apart: neither overwrites the other’s', async () => {
    // Both read an empty database, so each would have counted its pages from 0.
    const a = await attached()
    const b = await attached()
    a.store.upsertMany(notes('a', 900))
    await a.p.flush()
    b.store.upsertMany(notes('b', 700))
    await b.p.flush()
    a.store.upsertMany(notes('a2', 600))
    await a.p.flush()
    const back = await reread()
    expect(back.ofType('note')).toHaveLength(2200)
    expect(back.get('a-0')).toBeTruthy()
    expect(back.get('b-0')).toBeTruthy()
    expect(back.get('a2-599')).toBeTruthy()
  })

  it('opens the database again when its connection is closed under it, rather than failing every write after', async () => {
    const { store, p } = await attached()
    store.upsert(createEntity({ id: 'before', type: 'note' }))
    await p.flush()
    // What the browser does to a connection when the database is deleted or upgraded elsewhere, or storage fails.
    ;(p as unknown as { db: IDBDatabase }).db.close()
    store.upsertMany(notes('after', 800))
    store.upsert(createEntity({ id: 'small-after', type: 'note' }))
    await p.flush()
    expect(p.getStatus()).toMatchObject({ state: 'idle', pending: 0 })
    const back = await reread()
    expect(back.get('before')).toBeTruthy()
    expect(back.ofType('note')).toHaveLength(802)
  })

  it('keeps a write that fails every attempt and lands it, in order, with the next one', async () => {
    const { store, p } = await attached()
    const real = IDBDatabase.prototype.transaction
    let failures = 3
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (failures-- > 0) throw new DOMException('the disk said no', 'UnknownError')
      return real.apply(this, args)
    })
    store.upsert(createEntity({ id: 'x', type: 'note', label: 'first' }))
    await p.flush()
    expect(p.getStatus()).toMatchObject({ state: 'error', unsaved: 1 })
    expect(p.getStatus().error).toContain('the disk said no')
    // The same entity changed again: the failed write goes first, so the newer one is what stays.
    store.upsert(createEntity({ id: 'x', type: 'note', label: 'second' }))
    store.upsert(createEntity({ id: 'y', type: 'note' }))
    await p.flush()
    spy.mockRestore()
    expect(p.getStatus()).toMatchObject({ state: 'idle', pending: 0 })
    const back = await reread()
    expect(back.get('x')?.label).toBe('second')
    expect(back.get('y')).toBeTruthy()
  })

  it('sets aside an entity no write can store, says so, and saves every change after it', async () => {
    const { store, p } = await attached()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A value IndexedDB cannot clone (a function), and one nested past what the clone and the pack's encoder follow.
    let deep: unknown[] = []
    for (let i = 0; i < 200_000; i++) deep = [deep]
    store.upsertMany([createEntity({ id: 'ok-1', type: 'note' }), createEntity({ id: 'fn', type: 'note', data: { f: () => 1 } }), createEntity({ id: 'ok-2', type: 'note' })])
    store.upsert(createEntity({ id: 'deep', type: 'note', data: { deep } }))
    store.upsertMany([...notes('bulk', 600), createEntity({ id: 'deep-in-bulk', type: 'note', data: { deep } })])
    await p.flush()
    expect(p.getStatus()).toMatchObject({ state: 'error', pending: 0, lost: 3 })
    expect(p.getStatus().error).toMatch(/3 changes cannot be stored in this browser and were set aside/)
    expect([...p.lostIds()].sort()).toEqual(['deep', 'deep-in-bulk', 'fn'])
    store.upsert(createEntity({ id: 'later', type: 'note' }))
    await p.flush()
    expect(p.getStatus()).toMatchObject({ state: 'error', pending: 0, lost: 3 })
    const back = await reread()
    for (const id of ['ok-1', 'ok-2', 'later', 'bulk-0', 'bulk-599']) expect(back.has(id), id).toBe(true)
    for (const id of ['fn', 'deep', 'deep-in-bulk']) expect(back.has(id), id).toBe(false)
    warn.mockRestore()
  }, 30_000)

  it('retries what failed when asked, without a new write', async () => {
    const { store, p } = await attached()
    const real = IDBDatabase.prototype.transaction
    let failures = 3
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (failures-- > 0) throw new DOMException('busy', 'UnknownError')
      return real.apply(this, args)
    })
    store.upsert(createEntity({ id: 'scene', type: 'scene:unigraph', label: 'arXiv' }))
    await p.flush()
    expect(p.getStatus().state).toBe('error')
    await p.retry()
    spy.mockRestore()
    expect(p.getStatus().state).toBe('idle')
    expect((await reread()).get('scene')?.label).toBe('arXiv')
  })

  it('un-deletes an entity written again after a retried write, not only after a first-time one', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('t', 3))
    store.remove(['t-1'])
    await p.flush()
    const real = IDBDatabase.prototype.transaction
    let failures = 1
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (failures-- > 0) throw new DOMException('once', 'UnknownError')
      return real.apply(this, args)
    })
    store.upsert(createEntity({ id: 't-1', type: 'note', label: 'back' }))
    await p.flush()
    spy.mockRestore()
    expect((await reread()).get('t-1')?.label).toBe('back')
  })

  it('lets a bulk write replace what an earlier small write kept of the same entities', async () => {
    // The small write goes to the overlay, the bulk one to pages; the overlay is read over the pages, so a stale overlay
    // record used to bring the old version back at the next load.
    const { store, p } = await attached()
    store.upsert(createEntity({ id: 'n-0', type: 'note', label: 'old' }))
    await p.flush()
    store.upsertMany(notes('n', 800, 'new'))
    await p.flush()
    const back = await reread()
    expect(back.get('n-0')?.label).toBe('new')
    expect(back.ofType('note')).toHaveLength(800)
  })

  it('loads the rest when one saved page cannot be read, says so, and leaves the page on disk', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('a', 600))
    await p.flush()
    store.upsertMany(notes('b', 600))
    await p.flush()
    // Spoil the first page.
    const db = (p as unknown as { db: IDBDatabase }).db
    await new Promise<void>((done, fail) => {
      const t = db.transaction('pages', 'readwrite')
      const pages = t.objectStore('pages')
      const first = pages.openCursor()
      first.onsuccess = () => {
        const c = first.result!
        c.update({ ...c.value, packed: new Uint8Array([1, 2, 3]).buffer })
      }
      t.oncomplete = () => done()
      t.onerror = () => fail(t.error)
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const back = new EntityStore()
    const again = new Persistence()
    await again.load(back)
    quiet.mockRestore()
    expect(again.getStatus().skipped).toBe(1)
    expect(back.get('b-0')).toBeTruthy()
    expect(back.get('a-0')).toBeUndefined()
    const pages = await new Promise<number>((done) => {
      const r = (again as unknown as { db: IDBDatabase }).db.transaction('pages').objectStore('pages').count()
      r.onsuccess = () => done(r.result)
    })
    expect(pages).toBeGreaterThanOrEqual(2)
  })
})

// ── What another writer does, and what a crash leaves ────────────────────────────────────────────────────────────

/** Tabs' channels, delivered by hand: a message reaches the others only when the test says so, in the order sent. */
class Hub {
  channels = new Set<FakeChannel>()
  sent: { from: FakeChannel; data: unknown }[] = []
  deliver() {
    const sent = this.sent
    this.sent = []
    for (const m of sent) for (const c of this.channels) if (c !== m.from) c.receive(m.data)
  }
}
let hub: Hub
class FakeChannel {
  listeners = new Set<(ev: MessageEvent) => void>()
  constructor() {
    hub.channels.add(this)
  }
  postMessage(data: unknown) {
    hub.sent.push({ from: this, data: structuredClone(data) })
  }
  addEventListener(_type: string, l: (ev: MessageEvent) => void) {
    this.listeners.add(l)
  }
  removeEventListener(_type: string, l: (ev: MessageEvent) => void) {
    this.listeners.delete(l)
  }
  close() {}
  receive(data: unknown) {
    for (const l of this.listeners) l({ data } as MessageEvent)
  }
}
/** Tabs that hear each other — through `hub.deliver()`, as the platform's BroadcastChannel. */
function withChannels() {
  hub = new Hub()
  vi.stubGlobal('BroadcastChannel', FakeChannel)
}

const dbOf = (p: Persistence) => (p as unknown as { db: IDBDatabase }).db
function inDb<T>(p: Persistence, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((done, fail) => {
    const t = dbOf(p).transaction(stores, mode)
    const req = run(t)
    t.oncomplete = () => done(req ? req.result : undefined)
    t.onerror = () => fail(t.error)
  })
}
const pageKeys = (p: Persistence) => inDb(p, ['pages'], 'readonly', (t) => t.objectStore('pages').getAllKeys())

/** A database holding one page in the pre-pack layout — which the next load compacts, whatever else holds. */
async function legacyDatabase(entities = notes('x', 10)) {
  const p = new Persistence()
  await p.load(new EntityStore())
  await inDb(p, ['pages'], 'readwrite', (t) => void t.objectStore('pages').put({ n: 0, entities }))
}

/** Lets `allowed` read-write transactions through, then fails every one after: a tab that dies mid-write, as the disk sees it. */
function failWritesAfter(allowed: number) {
  const real = IDBDatabase.prototype.transaction
  return vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    if (args[1] === 'readwrite' && allowed-- <= 0) throw new DOMException('the tab died', 'UnknownError')
    return real.apply(this, args)
  })
}

/** Every queued write landed, including those the ones before queued. */
async function settle(...ps: Persistence[]) {
  for (let i = 0; i < 20; i++) {
    for (const p of ps) await p.flush()
    await new Promise((r) => setTimeout(r, 0))
    if (ps.every((p) => p.getStatus().pending === 0)) return
  }
}

/** Runs `before` ahead of an instance's private step, each time the step is taken. */
function hookBefore(p: Persistence, step: string, before: () => Promise<void>) {
  const target = p as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const original = target[step].bind(p)
  target[step] = async (...args) => {
    await before()
    return original(...args)
  }
}

describe('writers that share the database', () => {
  it('lets a write bring back what another writer deleted, which this one never heard of', async () => {
    const a = await attached()
    a.store.upsertMany(notes('t', 600))
    await a.p.flush()
    const b = await attached()
    a.store.remove(['t-1', 't-2'])
    await a.p.flush()
    // B never heard of the deletes: its bulk write and its small one both carry the ids again.
    b.store.upsertMany(notes('t', 600, 'v2'))
    await b.p.flush()
    b.store.upsert(createEntity({ id: 't-2', type: 'note', label: 'small' }))
    await b.p.flush()
    const back = await reread()
    expect(back.get('t-1')?.label).toBe('v2')
    expect(back.get('t-2')?.label).toBe('small')
  })

  it('compacts without losing what another writer put down meanwhile', async () => {
    const b = await attached() // on an empty database: its own load has nothing to compact
    await legacyDatabase()
    const a = new Persistence()
    // Between A's read at load and its compaction, B edits one of the entities and adds one.
    hookBefore(a, 'rewriteAll', async () => {
      b.store.upsert(createEntity({ id: 'x-1', type: 'note', label: 'B edit' }))
      b.store.upsert(createEntity({ id: 'y', type: 'note', label: 'B new' }))
      await b.p.flush()
    })
    await a.load(new EntityStore())
    await a.flush()
    const back = await reread()
    expect(back.get('x-1')?.label).toBe('B edit')
    expect(back.get('y')?.label).toBe('B new')
    expect(back.ofType('note')).toHaveLength(11)
    // The compaction did happen: the old page is gone, one packed page stands for it.
    expect(await pageKeys(a)).toEqual([1])
  })

  it('gives a compaction up when another writer puts a page down first, rather than outranking it with stale pages', async () => {
    const b = await attached()
    await legacyDatabase()
    const a = new Persistence()
    hookBefore(a, 'rewriteAll', async () => {
      b.store.upsertMany(notes('x', 600, 'B bulk'))
      await b.p.flush()
    })
    await a.load(new EntityStore())
    await a.flush()
    const back = await reread()
    expect(back.get('x-0')?.label).toBe('B bulk')
    expect(back.ofType('note')).toHaveLength(600)
  })

  it('gives a compaction up when another writer puts a page down after its check, under the pages it then writes', async () => {
    const b = await attached()
    await legacyDatabase()
    const a = new Persistence()
    // B's page lands after A looked and before A writes: A's pages would be numbered above it and outrank it.
    hookBefore(a, 'writePages', async () => {
      b.store.upsertMany(notes('x', 600, 'B bulk'))
      await b.p.flush()
    })
    await a.load(new EntityStore())
    await a.flush()
    expect(a.getStatus().state).toBe('idle')
    const back = await reread()
    expect(back.get('x-0')?.label).toBe('B bulk')
    expect(back.ofType('note')).toHaveLength(600)
  })

  it('keeps everything when a compaction dies before it is done', async () => {
    await legacyDatabase(notes('x', 700))
    const spy = failWritesAfter(1)
    const a = new Persistence()
    await a.load(new EntityStore())
    await a.flush()
    spy.mockRestore()
    expect(a.getStatus().state).toBe('error')
    const back = await reread()
    expect(back.ofType('note')).toHaveLength(700)
  })

  it('reads again when a page it listed is gone by the time it fetches it (another writer compacted meanwhile)', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('n', 600))
    await p.flush()
    const real = IDBObjectStore.prototype.get
    let vanish = 1
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      return real.call(this, this.name === 'pages' && vanish-- > 0 ? -1 : key)
    })
    const back = await reread()
    spy.mockRestore()
    expect(back.ofType('note')).toHaveLength(600)
  })

  it('takes the Web Lock: shared to read and write, exclusive to compact', async () => {
    await legacyDatabase()
    const modes: string[] = []
    const locks = {
      request: <T,>(name: string, opts: { mode: 'shared' | 'exclusive' }, fn: () => Promise<T>) => {
        expect(name).toBe('aegraph-persistence')
        modes.push(opts.mode)
        return fn()
      },
    }
    const store = new EntityStore()
    const p = new Persistence({ locks })
    await p.load(store)
    p.attach(store)
    await p.flush()
    expect(modes).toEqual(['shared', 'exclusive'])
    store.upsert(createEntity({ id: 'n', type: 'note' }))
    await p.flush()
    expect(modes).toEqual(['shared', 'exclusive', 'shared'])
  })
})

describe('a replace', () => {
  it('leaves exactly the new contents', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('old', 600))
    store.upsert(createEntity({ id: 'old-small', type: 'note' }))
    store.remove(['old-3'])
    store.setTagInfo('red', { color: '#f00' })
    await p.flush()
    store.loadDocument({ $schema: 'aegraph/v1', exportedAt: '', entities: [...notes('new', 600), createEntity({ id: 'new-small', type: 'note' })], tags: [{ tag: 'blue', color: '#00f' }] }, { replace: true })
    await p.flush()
    expect(p.getStatus().state).toBe('idle')
    const back = await reread()
    expect(back.ofType('note')).toHaveLength(601)
    expect(back.get('old-0')).toBeUndefined()
    expect(back.get('old-small')).toBeUndefined()
    expect(back.tagInfos().map((t) => t.tag)).toEqual(['blue'])
  })

  it('writes the new contents before it deletes the old: a tab that dies half-way loses nothing', async () => {
    const { store, p } = await attached()
    store.upsertMany(notes('old', 600))
    await p.flush()
    const spy = failWritesAfter(1)
    store.loadDocument({ $schema: 'aegraph/v1', exportedAt: '', entities: notes('new', 600) }, { replace: true })
    await p.flush()
    spy.mockRestore()
    expect(p.getStatus().state).toBe('error')
    const back = await reread()
    expect(back.get('new-599')).toBeTruthy()
  })
})

describe('another tab’s changes', () => {
  beforeEach(withChannels)

  it('arrive while this tab is still loading, and are applied once it is attached', async () => {
    const a = await attached()
    const store = new EntityStore()
    const b = new Persistence()
    await b.load(store)
    a.store.upsert(createEntity({ id: 'during-boot', type: 'note', label: 'A' }))
    await a.p.flush()
    hub.deliver()
    b.attach(store)
    await settle(b)
    expect(store.get('during-boot')?.label).toBe('A')
  })

  it('a bulk write elsewhere: the difference applied, the open project and this tab’s own edit kept', async () => {
    const a = await attached()
    a.store.upsert(createEntity({ id: 'proj', type: 'project', label: 'P' }))
    a.store.upsert(createEntity({ id: 'same', type: 'note', label: 'unchanged' }))
    a.store.upsert(createEntity({ id: 'doomed', type: 'note' }))
    await a.p.flush()
    const b = await attached()
    b.store.setScope('proj')
    const unchanged = b.store.get('same')
    a.store.remove(['doomed'])
    a.store.upsertMany(notes('n', 600, 'A'))
    await a.p.flush()
    hub.deliver()
    // B edits before the reload is applied: the edit stays, in memory and on disk.
    b.store.upsert(createEntity({ id: 'z', type: 'note', label: 'B local' }))
    await settle(a.p, b.p)
    expect(b.store.scope).toBe('proj')
    expect(b.store.get('z')?.label).toBe('B local')
    expect(b.store.get('n-0')?.label).toBe('A')
    expect(b.store.get('doomed')).toBeUndefined()
    // What did not change is the same object: nothing downstream sees it as an edit.
    expect(b.store.get('same')).toBe(unchanged)
    const back = await reread()
    expect(back.get('z')?.label).toBe('B local')
    expect(back.get('n-599')?.label).toBe('A')
  })

  it('waits for a transaction this tab has open, and neither loses its writes nor writes a reset', async () => {
    const a = await attached()
    a.store.upsert(createEntity({ id: 'kept', type: 'note', label: 'A small' }))
    await a.p.flush()
    const b = await attached()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const open = b.store.transactionAsync(async () => {
      b.store.upsert(createEntity({ id: 'w', type: 'note', label: 'in B’s transaction' }))
      await gate
    })
    a.store.upsertMany(notes('n', 600, 'A'))
    await a.p.flush()
    hub.deliver()
    await settle(b.p)
    expect(b.store.get('n-0')).toBeUndefined()
    release()
    await open
    await settle(a.p, b.p)
    expect(b.store.get('w')).toBeTruthy()
    expect(b.store.get('n-0')?.label).toBe('A')
    const back = await reread()
    expect(back.get('w')).toBeTruthy()
    expect(back.get('kept')?.label).toBe('A small')
    expect(back.get('n-599')).toBeTruthy()
  })
})

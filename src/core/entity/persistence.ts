import { gunzipBytes, MAX_PACK_INFLATED_BYTES } from '../exchange/gunzip'
import { packDocument, unpackDocument } from '../exchange/pack/pack'
import { MAX_STORED_DEPTH } from '../exchange/limits'
import type { BulkSource, EntityStore, StoreEvent } from './store'
import type { AnyEntity, EntityId, TagInfo } from './types'

/**
 * IndexedDB persistence, tuned for both big loads and small edits.
 *
 * Per-record puts cost ~50µs each, so 600k entities would take half a
 * minute to land and several seconds to read back. Instead:
 *
 *  - Bulk upserts are written as *pages* of ~2,000 entities (one record each).
 *  - Small upserts go to an *overlay* keyed by id; removes go to *tombstones*.
 *  - Load = pages, then overlay on top, minus tombstones. If the overlay has
 *    grown large, the result is compacted back into fresh pages.
 *
 * Everything is queued and applied in order, so events never race.
 *
 * A write that fails is not a write forgotten. The connection is dropped and
 * opened again — the browser closes one for its own reasons (the database
 * deleted or upgraded elsewhere, a storage fault), and a closed connection
 * kept in hand failed every write after it for the rest of the page's life,
 * silently — and the write is tried again. What still fails stays queued: it
 * is written before the next write (or on `retry`), and the status says
 * `error`, with how many writes are waiting, until it lands.
 *
 * A page's number is taken inside the transaction that writes it, from the
 * last page on disk: two writers on one database — two tabs, or the instance
 * a dev server's hot swap left beside the new one — each counting from what
 * it last read would put pages under the same numbers, and the later write
 * would take the earlier one's place.
 *
 * A page write is the newest word on the ids it carries, whoever wrote what
 * before: in the transaction that writes the page it deletes the overlay
 * records (read over the pages, they would bring the old version back) and the
 * tombstones (another tab's delete this tab never heard of) of those ids.
 *
 * Nothing is deleted before what replaces it is on disk. Compaction writes the
 * new pages first, numbered above the old, then deletes in one transaction
 * exactly the pages, overlay records and tombstones it read at load — an
 * overlay record only if it is still the one read, and nothing at all if
 * another writer has put a page down since (the rewrite would be stale; the
 * next load tries again). A replace (a `reset` — an import in replace mode, a
 * cleared Library) writes the new contents first and then deletes, in one
 * transaction, the keys that were on disk when it began. Between the first
 * new write and that last transaction a crash leaves old and new side by side
 * — the next load shows both, the old overlay records over the new pages for
 * ids in both — rather than an empty database. A page that could not be read
 * at load is never deleted.
 *
 * Tabs share the database. Where the platform has Web Locks, every write takes
 * `aegraph-persistence` shared and compaction takes it exclusive, so no tab
 * writes while another compacts; without them the checks above still hold.
 * Another tab's change arrives on a BroadcastChannel, listened to from the
 * moment this instance exists (what arrives before `attach` waits, in order).
 * It is read from the database first and applied to the store in one step
 * afterwards, as the difference — entities that changed, entities gone —
 * never by clearing the store, so the open project and whatever this tab
 * changed in the meantime stay: an entity this tab wrote after the message
 * arrived keeps this tab's version (its write lands after), and a change that
 * lands while the store has a transaction open waits for it to end.
 */

const DB_NAME = 'aegraph'
const DB_VERSION = 2
const PAGES = 'pages'
const OVERLAY = 'overlay'
const TOMBSTONES = 'tombstones'
const TAGS = 'tags'
const PAGE_SIZE = 4000
/** A page's target size in bytes (JSON-measured); heavy entities get smaller pages. */
const PAGE_BYTES = 6 * 1024 * 1024
/** Upserts at or above this size are written as pages rather than overlay records. */
const BULK_THRESHOLD = 500
/** Let input and rendering run between pieces of a long write. */
const yieldToEvents = (): Promise<void> => {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return sch?.yield ? sch.yield() : new Promise((r) => setTimeout(r, 0))
}
/** Compact on load when the overlay + tombstones exceed this. */
const COMPACT_THRESHOLD = 20_000
/** How many times a write is tried, on a fresh connection each time, before it waits for the next write. */
const ATTEMPTS = 3
/** How many entities another tab's reload compares between turns of the event loop. */
const DIFF_CHUNK = 20_000
/** The Web Lock every writer on the database takes: shared to write, exclusive to compact. */
const LOCK = 'aegraph-persistence'

/** `unsaved`: writes that failed and wait to be tried again — changes the store holds and this browser has not kept. */
/** `skipped`: saved pages the last load could not read — left out of the store, kept on disk untouched (never compacted away). */
/**
 * `lost`: entities this browser cannot store at all (a value IndexedDB or the pack cannot take — nested past what a
 * clone or the encoder can follow), set aside so the writes after them land; the store holds them until the page
 * closes. The status stays `error` while there are any, and says so.
 */
export type PersistStatus = { state: 'idle' | 'saving' | 'error'; pending: number; error?: string; unsaved?: number; skipped?: number; lost?: number }
type StatusListener = (s: PersistStatus) => void

type LockMode = 'shared' | 'exclusive'
/** The part of the Web Locks API used here (`navigator.locks`). */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: LockMode }, callback: () => Promise<T>): Promise<T>
}
/** The part of a BroadcastChannel used here. */
export interface SyncChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
}
export interface PersistenceOptions {
  /** The cross-tab channel; by default a BroadcastChannel where there is one. `null`: none. */
  channel?: SyncChannel | null
  /** By default `navigator.locks` where there is one. `null`: none. */
  locks?: LockManagerLike | null
}

/**
 * A page is one aegraph pack (src/core/exchange/pack) in an ArrayBuffer:
 * one blob per 4,000 entities, which IndexedDB stores and hands back as a
 * plain copy. Measured on 250k generated entities against the structured
 * clone of the entity objects that pages used to be: a fifth the bytes on
 * disk and ~2.5× faster to read back (decoding included). Pages written
 * before the pack still carry `entities`; they load as they are and are
 * rewritten as packs at the next compaction.
 */
interface PageRecord {
  n: number
  packed?: ArrayBuffer
  /**
   * A whole file, as it was opened: the `.aeb` of a bundle whose every entity went into the store as decoded
   * (`BulkSource`), kept as the bytes that arrived — gzipped, when they were — rather than packed again, page by page.
   * One record however big: a Blob, which the browser keeps on disk rather than as a copy in the page's memory.
   */
  file?: Blob
  /** The pre-pack layout. */
  entities?: AnyEntity[]
}

const packPage = (entities: AnyEntity[]): ArrayBuffer => {
  const bytes = packDocument({ entities })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
/**
 * Delete these ids' records from an id-keyed object store, inside the caller's transaction, at the cost of the smaller
 * side: the store's keys when it holds fewer records than there are ids (an overlay or tombstones of a few thousand
 * against a page write of a million), else a delete per id. Never a set over the ids themselves.
 */
function dropIds(os: IDBObjectStore, ids: readonly EntityId[]) {
  if (!ids.length) return
  const count = os.count()
  count.onsuccess = () => {
    if (!count.result) return
    if (count.result > ids.length) {
      for (const id of ids) os.delete(id)
      return
    }
    const keys = os.getAllKeys()
    keys.onsuccess = () => {
      const held = new Set(keys.result as EntityId[])
      for (const id of ids) if (held.has(id)) os.delete(id)
    }
  }
}
/**
 * Drop the records a page write supersedes, inside that write's transaction. Load applies the overlay over the pages
 * (a small edit is newer than the bulk it edited), so an overlay record older than a later page write would otherwise
 * win on the next load: edit one entity, then have a bulk write — a restore, a rename across the project, a bundle
 * opened again — carry a newer version of it, and after a reload the old edit came back. A tombstone of one of these
 * ids is dropped too, whichever tab wrote it: the page is the later word.
 */
function dropSuperseded(t: IDBTransaction, ids: readonly EntityId[]) {
  dropIds(t.objectStore(OVERLAY), ids)
  dropIds(t.objectStore(TOMBSTONES), ids)
}
/** What this app wrote itself reads with the looser nesting bound (`limits.ts`): a page must not go unread for a value it once took. */
const STORED = { maxDepth: MAX_STORED_DEPTH }
const unpackPage = (p: PageRecord): AnyEntity[] => (p.packed ? unpackDocument(new Uint8Array(p.packed), STORED).entities : (p.entities ?? []))
/** A whole-file page's entities: the pack, gunzipped first when it was kept gzipped — within the pack's ceiling, as when it was opened. */
async function unpackFile(file: Blob): Promise<AnyEntity[]> {
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzipBytes(bytes, MAX_PACK_INFLATED_BYTES)
  return unpackDocument(bytes, STORED).entities
}
/** The ids of every upsert that carries `source` — what a whole-file page stands for, for un-deleting. */
const idsOf = (events: StoreEvent[], source: BulkSource): EntityId[] => events.flatMap((e) => (e.type === 'upsert' && e.source === source ? e.entities.map((x) => x.id) : []))
/**
 * The files a batch of writes can be saved as: those whose tagged upserts carry, between them, exactly as many
 * entities as the file stands for. A file some of whose entities went in otherwise — or not at all — is written the
 * ordinary way.
 */
function wholeFiles(events: StoreEvent[]): Set<BulkSource> {
  const carried = new Map<BulkSource, number>()
  for (const e of events) if (e.type === 'upsert' && e.source) carried.set(e.source, (carried.get(e.source) ?? 0) + e.entities.length)
  const whole = new Set<BulkSource>()
  for (const [source, n] of carried) if (n === source.expected) whole.add(source)
  return whole
}

/**
 * Whether two entities hold the same thing — a record read back from disk against the one the store holds. JSON-shaped
 * values compared by value; a key whose value is `undefined` counts as absent, as it does once written. Anything that
 * is not a plain object or array compares by identity, so the doubt costs a needless upsert, never a missed one.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const arr = Array.isArray(a)
  if (arr !== Array.isArray(b)) return false
  if (arr) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!same(x[i], y[i])) return false
    return true
  }
  const pa = Object.getPrototypeOf(a)
  const pb = Object.getPrototypeOf(b)
  if ((pa !== Object.prototype && pa !== null) || (pb !== Object.prototype && pb !== null)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  let n = 0
  for (const k in x) {
    if (x[k] === undefined) continue
    n++
    if (!same(x[k], y[k])) return false
  }
  for (const k in y) if (y[k] !== undefined) n--
  return n === 0
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      // From v1 (one record per entity, long gone) there is no verified migration, and the Library in it may be the
      // only copy: refuse the upgrade atomically rather than delete it. A later version migrates what it changes and
      // keeps the rest — an upgrade that dropped every store would delete every Library that opened it.
      if (ev.oldVersion > 0 && ev.oldVersion < 2) {
        req.transaction?.abort()
        reject(new Error('This browser holds an older Library format. Its data has been preserved. Export it with the previous app version before upgrading; do not clear site data.'))
        return
      }
      if (ev.oldVersion === 0) {
        db.createObjectStore(PAGES, { keyPath: 'n' })
        db.createObjectStore(OVERLAY, { keyPath: 'id' })
        db.createObjectStore(TOMBSTONES, { keyPath: 'id' })
        db.createObjectStore(TAGS, { keyPath: 'tag' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'))
  })
}

function tx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
    try {
      run(t)
    } catch (err) {
      // A put that threw (a value the database cannot clone): nothing of this transaction lands, and the error is the one reported.
      try {
        t.abort()
      } catch {
        /* already finished */
      }
      reject(err)
    }
  })
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

function getOne<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

function getAllKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** The keys of the pages, the overlay and the tombstones, read together in one transaction. */
function keysOnDisk(db: IDBDatabase): Promise<{ pages: IDBValidKey[]; overlay: IDBValidKey[]; tombs: IDBValidKey[] }> {
  return new Promise((resolve, reject) => {
    const t = db.transaction([PAGES, OVERLAY, TOMBSTONES], 'readonly')
    const out = { pages: [] as IDBValidKey[], overlay: [] as IDBValidKey[], tombs: [] as IDBValidKey[] }
    const pages = t.objectStore(PAGES).getAllKeys()
    pages.onsuccess = () => (out.pages = pages.result)
    const overlay = t.objectStore(OVERLAY).getAllKeys()
    overlay.onsuccess = () => (out.overlay = overlay.result)
    const tombs = t.objectStore(TOMBSTONES).getAllKeys()
    tombs.onsuccess = () => (out.tombs = tombs.result)
    t.oncomplete = () => resolve(out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
  })
}

/**
 * Cross-tab sync. Every tab on the origin shares the IndexedDB, so a write
 * in one (the MCP bridge creating a diagram, say) is announced on a
 * BroadcastChannel and the others pull just those records into their
 * stores — no reload needed. Bulk writes and resets tell the others to
 * reload outright.
 */
const CHANNEL = 'aegraph-store'
type SyncPayload = { type: 'upsert'; ids: EntityId[] } | { type: 'remove'; ids: EntityId[] } | { type: 'tags' } | { type: 'reload' }
type SyncMessage = SyncPayload & { from: string }
/** Messages kept for a store not attached yet; past this many they are one reload. */
const INBOX_MAX = 1000

function getMany<T>(db: IDBDatabase, store: string, keys: IDBValidKey[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readonly').objectStore(store)
    const out: T[] = []
    let left = keys.length
    if (!left) return resolve(out)
    for (const k of keys) {
      const req = os.get(k)
      req.onsuccess = () => {
        if (req.result !== undefined) out.push(req.result as T)
        if (--left === 0) resolve(out)
      }
      req.onerror = () => reject(req.error)
    }
  })
}

/** The whole database as one tab read it. */
interface DiskRead {
  /**
   * Each page's entities in key order, then the overlay, tombstoned ids left out: what the store should hold, when
   * written in this order — a later write of an id replaces an earlier one where it stands, which is the merge. No
   * `Map` of every entity is built (0.9 s and a copy of the Library at the moment a big one loads).
   */
  lists: AnyEntity[][]
  tags: TagInfo[]
  /** The pages decoded, and those that could not be (never deleted: see `rewriteAll`). */
  pageKeys: number[]
  unreadableKeys: number[]
  /** The overlay records as read, before anything was done to them: what compaction compares against. */
  overlay: AnyEntity[]
  tombs: EntityId[]
  pageTotal: number
  legacyPages: number
}

/**
 * What compaction may delete once its pages are down: exactly what the load read — and `written`, the pages an earlier
 * attempt of the same compaction put down before it failed, which hold the same entities and go too.
 */
type CompactionBase = Pick<DiskRead, 'pageKeys' | 'unreadableKeys' | 'overlay' | 'tombs'> & { written: number[] }

/**
 * `salvage`: for a write that failed for good (`isPermanent`), the same write entity by entity, returning the ids it
 * could not store — so one entity nobody can store does not hold every later write behind it.
 */
type Work = { run: () => Promise<void>; mode: LockMode | null; salvage?: () => Promise<EntityId[]> }

/**
 * A failure trying again cannot mend: the value itself is what IndexedDB or the encoder refuses (a clone error, a
 * recursion past the stack). A closed connection, a full disk or an aborted transaction is worth another attempt.
 */
export const isPermanent = (err: unknown): boolean => err instanceof RangeError || (!!err && typeof err === 'object' && ['DataCloneError', 'DataError'].includes(String((err as { name?: unknown }).name)))

export class Persistence {
  private db: IDBDatabase | null = null
  private queue: Promise<void> = Promise.resolve()
  private status: PersistStatus = { state: 'idle', pending: 0 }
  private listeners = new Set<StatusListener>()
  private unsubscribe?: () => void
  private nextPage = 0
  /** Writes that failed every attempt, oldest first: written before the next one, so the order holds. */
  private failed: Work[] = []
  /** What could never be stored (see `PersistStatus.lost`): how many, the first ids, and why. */
  private lost: { count: number; ids: EntityId[]; error: string } = { count: 0, ids: [], error: '' }
  private readonly channel: SyncChannel | null
  private readonly locks: LockManagerLike | null
  private readonly tabId = Math.random().toString(36).slice(2)
  /** True while applying another tab's change, so the mirror doesn't write (and announce) it again. */
  private applyingRemote = false
  /** The store messages go to once attached; until then they wait in `inbox`, in order. */
  private target: EntityStore | null = null
  private inbox: SyncMessage[] = []
  /** A reload is queued and has not begun: another asks for nothing more. */
  private reloadQueued = false
  /**
   * What this tab changed while another tab's change waited to be applied: an id's last local change (a sequence
   * number), and the last local bulk write or reset. Kept only while a remote change is pending, so it holds the ids
   * of a few edits, never the Library's.
   */
  private remotePending = 0
  private localSeq = 0
  private localChanged = new Map<EntityId, number>()
  private localBulkSeq = 0
  /** During a replace: the overlay records and tombstones it wrote itself, which its closing delete must keep. */
  private replacing: { overlay: Set<EntityId>; tombs: Set<EntityId> } | null = null

  constructor(opts: PersistenceOptions = {}) {
    this.channel = opts.channel !== undefined ? opts.channel : typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
    this.locks = opts.locks !== undefined ? opts.locks : typeof nav?.locks?.request === 'function' ? nav.locks : null
    // Listening from the start: a tab still reading its Library would otherwise miss what another wrote meanwhile.
    this.channel?.addEventListener('message', this.onMessage)
  }

  static isSupported() {
    return typeof indexedDB !== 'undefined'
  }

  /**
   * Ask the browser to keep this origin's storage — the workspace is the only copy there is — rather than evict it
   * under storage pressure. Called once at boot, after the workspace is read. The browser answers on its own terms
   * (Chrome and Edge grant it silently to a site in use, Firefox asks, Safari decides by its own rules), so this only
   * asks: it never throws, never waits on the boot, and resolves to whether storage is persistent now, or `undefined`
   * where the browser has no such thing. The Projects page's storage card says which.
   */
  static async keepStorage(storage: Partial<Pick<StorageManager, 'persist' | 'persisted'>> | undefined = globalThis.navigator?.storage): Promise<boolean | undefined> {
    if (!storage?.persist) return undefined
    try {
      if (await storage.persisted?.()) return true
      return await storage.persist()
    } catch {
      return false
    }
  }

  getStatus() {
    return this.status
  }

  subscribe(l: StatusListener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /**
   * Loads everything into the store (replacing its contents). Returns entity
   * count. A load already in flight is shared: React's dev-mode double
   * effect used to start two, and whichever finished second replaced the
   * store again — after the first one's caller had already set it up.
   */
  load(store: EntityStore): Promise<number> {
    if (!this.loading) this.loading = this.loadInto(store).finally(() => (this.loading = undefined))
    return this.loading
  }

  private loading?: Promise<number>

  /**
   * The store from disk, and — when the database has grown wasteful — a compaction queued from what was just read.
   * Only here, at this tab's own load: a tab catching up with another's write applies the difference instead.
   */
  private async loadInto(store: EntityStore): Promise<number> {
    const db = await this.open()
    const read = await this.locked('shared', () => this.readDisk(db))

    store.transaction(() => {
      store.clear()
      for (const t of read.tags) store.setTagInfo(t.tag, t)
      // What is on disk was accepted when it was written: the guard does not re-judge it.
      for (const list of read.lists) store.upsertMany(list, { unchecked: true })
    })
    read.lists.length = 0

    const loaded = store.library.size()
    const unreadable = read.unreadableKeys.length
    const wasteful = read.pageTotal - loaded
    this.setStatus({ ...this.status, skipped: unreadable || undefined })
    // Compaction also moves pages of the old layout to packs, once — never while a page could not be read.
    if (!unreadable && (read.overlay.length + read.tombs.length > COMPACT_THRESHOLD || wasteful > COMPACT_THRESHOLD || read.legacyPages > 0)) {
      const entities = store.library.all()
      const base: CompactionBase = { pageKeys: read.pageKeys, unreadableKeys: read.unreadableKeys, overlay: read.overlay, tombs: read.tombs, written: [] }
      this.enqueue(() => this.rewriteAll(entities, base), 'exclusive')
    }
    return loaded
  }

  /**
   * Every page, the overlay over them, minus tombstones — a page at a time, so only one page's bytes are alive at once.
   * The pages are listed first and fetched one by one, so a page listed and gone by the time it is fetched means
   * another writer deleted it meanwhile (a compaction, a replace — which put its contents in pages numbered above the
   * list): the read starts over rather than go without it. Holding the shared Web Lock, that cannot happen.
   */
  private async readDisk(db: IDBDatabase): Promise<DiskRead> {
    for (let tries = 1; ; tries++) {
      const read = await this.readDiskOnce(db, tries < 5)
      if (read) return read
    }
  }

  /** One read; null when a page vanished under it and `strict` says to start over. */
  private async readDiskOnce(db: IDBDatabase, strict: boolean): Promise<DiskRead | null> {
    const [overlay, tombs, tags] = await Promise.all([getAll<AnyEntity>(db, OVERLAY), getAllKeys(db, TOMBSTONES), getAll<TagInfo>(db, TAGS)])
    // Pages arrive in key order (later pages win); overlay wins over pages; tombstones remove.
    const read: DiskRead = { lists: [], tags, pageKeys: [], unreadableKeys: [], overlay, tombs: tombs as EntityId[], pageTotal: 0, legacyPages: 0 }
    const tombstoned = new Set(read.tombs)
    const live = (list: AnyEntity[]) => (tombstoned.size ? list.filter((e) => !tombstoned.has(e.id)) : list)
    this.nextPage = 0
    // A whole-file page, which has to be read and decoded asynchronously, takes its turn in the order like any other.
    // A page that cannot be read (a corrupt record, a file past the pack's ceiling) is left out and counted, not allowed
    // to stop the rest of the Library loading — which used to leave the tab on an empty store with nothing saved.
    for (const key of await getAllKeys(db, PAGES)) {
      const p = await getOne<PageRecord>(db, PAGES, key)
      if (!p) {
        if (strict) return null
        continue
      }
      this.nextPage = Math.max(this.nextPage, p.n + 1)
      let list: AnyEntity[]
      try {
        list = p.file ? await unpackFile(p.file) : unpackPage(p)
      } catch (err) {
        read.unreadableKeys.push(p.n)
        console.error(`[aegraph] saved page ${String(key)} could not be read and was left out:`, err)
        continue
      }
      read.pageKeys.push(p.n)
      if (!p.packed && !p.file) read.legacyPages++
      read.pageTotal += list.length
      read.lists.push(live(list))
    }
    // A copy: `overlay` stays as read, for compaction to compare against.
    if (overlay.length) read.lists.push(tombstoned.size ? live(overlay) : overlay.slice())
    // Type definitions saved before the `graph` category became `project` are brought forward as they load.
    for (const list of read.lists)
      for (let i = 0; i < list.length; i++) {
        const e = list[i]
        if (e.type === 'schema:type' && e.data.category === 'graph') list[i] = { ...e, data: { ...e.data, category: 'project' } }
      }
    return read
  }

  /** Mirrors every store change into IndexedDB, and other tabs' changes into the store. Returns a stop function. */
  attach(store: EntityStore): () => void {
    this.unsubscribe?.()
    const stopStore = store.subscribe((event) => {
      if (this.applyingRemote) return
      if (this.remotePending) this.noteLocal(event, ++this.localSeq)
      this.enqueue(() => this.apply(store, event), 'shared', () => this.applyEach(store, event))
    })
    this.target = store
    // What arrived while the store was loading, in order; everything before a reload is part of what it reads.
    const waiting = this.inbox
    this.inbox = []
    const lastReload = waiting.map((m) => m.type).lastIndexOf('reload')
    for (const msg of lastReload >= 0 ? waiting.slice(lastReload) : waiting) this.deliver(store, msg)
    this.unsubscribe = () => {
      stopStore()
      if (this.target === store) this.target = null
    }
    return () => {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  private readonly onMessage = (ev: MessageEvent) => {
    const msg = ev.data as SyncMessage | undefined
    if (!msg || msg.from === this.tabId) return
    if (this.target) return this.deliver(this.target, msg)
    this.inbox.push(msg)
    if (this.inbox.length > INBOX_MAX) this.inbox = [{ type: 'reload', from: msg.from }]
  }

  private announce(msg: SyncPayload) {
    try {
      this.channel?.postMessage({ ...msg, from: this.tabId })
    } catch {
      // A closed channel or an unserialisable message: the other tabs catch up on their next load.
    }
  }

  /** What this tab changed since a remote change arrived: the ids of small writes, and when a bulk write or reset came. */
  private noteLocal(event: StoreEvent, seq: number) {
    switch (event.type) {
      case 'batch':
        for (const e of event.events) this.noteLocal(e, seq)
        return
      case 'reset':
        this.localBulkSeq = seq
        return
      case 'upsert':
        if (event.entities.length >= BULK_THRESHOLD) this.localBulkSeq = seq
        else for (const e of event.entities) this.localChanged.set(e.id, seq)
        return
      case 'remove':
        if (event.ids.length >= BULK_THRESHOLD) this.localBulkSeq = seq
        else for (const id of event.ids) this.localChanged.set(id, seq)
        return
    }
  }

  /** Queue another tab's change for this store, remembering what this tab changes from now on. */
  private deliver(store: EntityStore, msg: SyncMessage) {
    if (msg.type === 'reload') {
      if (this.reloadQueued) return
      this.reloadQueued = true
    }
    this.remotePending++
    const since = this.localSeq
    let settled = false
    this.enqueue(async () => {
      if (msg.type === 'reload') this.reloadQueued = false
      await this.applyRemote(store, msg, since)
      if (settled) return
      settled = true
      if (--this.remotePending === 0) this.localChanged.clear()
    }, null)
  }

  /** The same change, again, once no transaction is open — queued behind whatever this tab wrote meanwhile. */
  private later(store: EntityStore, msg: SyncMessage) {
    store.afterTransaction(() => this.deliver(store, msg))
  }

  /**
   * Another tab wrote to the shared database: bring this store level with it, without writing again. The database is
   * read first; the store is changed afterwards, in one synchronous step, and only then is `applyingRemote` set — so a
   * change this tab makes while the read is under way is written like any other. Nothing is applied inside a
   * transaction the store has open (its events are held, and would be written back as this tab's): that waits for it
   * to end. An entity this tab changed since the message arrived keeps this tab's version — its write is queued
   * after this, and lands last; after a bulk write or a reset of this tab's, the change is read again once that
   * write has landed.
   */
  private async applyRemote(store: EntityStore, msg: SyncMessage, since: number): Promise<void> {
    const mustWait = () => store.inTransaction || this.localBulkSeq > since
    const localWins = (id: EntityId) => (this.localChanged.get(id) ?? 0) > since
    if (mustWait()) return this.later(store, msg)
    const db = await this.open()
    if (msg.type === 'reload') return this.applyReload(store, db, msg, mustWait, localWins)
    if (msg.type === 'tags') {
      const tags = await getAll<TagInfo>(db, TAGS)
      if (mustWait()) return this.later(store, msg)
      this.asRemote(() => store.transaction(() => this.applyTags(store, tags)))
      return
    }
    if (msg.type === 'remove') {
      const present = msg.ids.filter((id) => store.has(id) && !localWins(id))
      if (!present.length) return
      this.asRemote(() => store.remove(present, { cascade: false }))
      return
    }
    const entities = await getMany<AnyEntity>(db, OVERLAY, msg.ids)
    if (mustWait()) return this.later(store, msg)
    // What this store already holds as it is keeps its object: nothing downstream sees an edit that is not one.
    const fresh = entities.filter((e) => !localWins(e.id) && !same(store.get(e.id), e))
    if (fresh.length) this.asRemote(() => store.upsertMany(fresh, { unchecked: true }))
  }

  /**
   * Another tab's bulk write or replace: the whole database read, compared with the store by id in one pass (in
   * slices, the event loop between them) and the difference applied — the records read are what goes in, nothing is
   * copied, and an entity that has not changed keeps its object. No map of the read is built: the lists are walked
   * newest first, so the first version met of an id the store holds is the one on disk, and a bit per store handle
   * says it was met; every version of an id the store does not hold goes in, in order, and the last one wins, as at a
   * load. Each list is let go once walked. The store's entities no bit was set for are gone from disk — unless a page
   * could not be read, when nothing is removed: what is missing from the read may only be unreadable.
   */
  private async applyReload(store: EntityStore, db: IDBDatabase, msg: SyncMessage, mustWait: () => boolean, localWins: (id: EntityId) => boolean) {
    const read = await this.locked('shared', () => this.readDisk(db))
    // Handles given out during the walk (this tab's own new entities) are past the end: never met, and local.
    const met = new Uint8Array(store.handleCapacity)
    const changed: AnyEntity[] = []
    let n = 0
    for (let l = read.lists.length - 1; l >= 0; l--) {
      const list = read.lists[l]
      read.lists[l] = []
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i]
        const h = store.handleOf(e.id)
        if (h === undefined) changed.push(e)
        else if (!met[h]) {
          met[h] = 1
          if (!same(store.entityAt(h), e)) changed.push(e)
        }
        if (++n % DIFF_CHUNK === 0) await yieldToEvents()
      }
    }
    changed.reverse()
    if (mustWait()) return this.later(store, msg)
    const gone: EntityId[] = []
    if (!read.unreadableKeys.length) {
      for (let h = 0, cap = store.handleCapacity; h < cap; h++) {
        if (met[h]) continue
        const e = store.entityAt(h)
        if (e && !localWins(e.id)) gone.push(e.id)
      }
    }
    const upserts = changed.filter((e) => !localWins(e.id))
    this.asRemote(() =>
      store.transaction(() => {
        this.applyTags(store, read.tags)
        if (gone.length) store.remove(gone, { cascade: false })
        if (upserts.length) store.upsertMany(upserts, { unchecked: true })
        // The open project stays open — unless the other tab deleted it.
        if (store.scope && !store.has(store.scope)) store.setScope(null)
      }),
    )
  }

  private applyTags(store: EntityStore, tags: TagInfo[]) {
    const now = new Map(store.tagInfos().map((t) => [t.tag, t]))
    for (const t of tags) if (!same(now.get(t.tag), t)) store.setTagInfo(t.tag, t)
  }

  private asRemote(fn: () => void) {
    this.applyingRemote = true
    try {
      fn()
    } finally {
      this.applyingRemote = false
    }
  }

  /** Waits for every queued write to land (or to fail every attempt: `getStatus()` says which). */
  flush(): Promise<void> {
    return this.queue
  }

  /** Tries the writes that failed again now, rather than with the next one. */
  retry(): Promise<void> {
    if (this.failed.length) this.enqueue(async () => {})
    return this.queue
  }

  /** Empties the database — in the queue, after what is already in it, and with no other tab writing meanwhile. */
  async wipe() {
    let failure: unknown
    this.enqueue(async () => {
      try {
        await this.clearAll(await this.open())
      } catch (err) {
        failure = err
        throw err
      }
    }, 'exclusive')
    await this.queue
    if (failure !== undefined && this.failed.length) throw failure
  }

  private async open() {
    if (!this.db) {
      const db = await openDb()
      // Closed under us — the browser's doing, or a database deleted or upgraded elsewhere (which waits for us to let
      // go): the next write opens a new connection rather than failing on this one.
      db.onclose = () => {
        if (this.db === db) this.db = null
      }
      db.onversionchange = () => {
        db.close()
        if (this.db === db) this.db = null
      }
      this.db = db
    }
    return this.db
  }

  private dropConnection() {
    try {
      this.db?.close()
    } catch {
      /* already closed */
    }
    this.db = null
  }

  /** `fn` holding the database's Web Lock in `mode` (null: none), where the platform has Web Locks. */
  private locked<T>(mode: LockMode | null, fn: () => Promise<T>): Promise<T> {
    return mode && this.locks ? this.locks.request(LOCK, { mode }, fn) : fn()
  }

  /** One write, tried on a fresh connection after each failure. */
  private async attempt(work: Work): Promise<void> {
    let last: unknown
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        return await this.locked(work.mode, work.run)
      } catch (err) {
        last = err
        if (isPermanent(err)) break
        this.dropConnection()
        await new Promise((r) => setTimeout(r, 100 * (i + 1)))
      }
    }
    throw last
  }

  /**
   * `mode`: the Web Lock the work holds — shared for a write, exclusive for a compaction, none for applying another
   * tab's change (which takes the lock itself for its read: a queued work never asks for a second lock while it
   * holds one, which could wait on another tab's exclusive request that waits on it).
   */
  private enqueue(run: () => Promise<void>, mode: LockMode | null = 'shared', salvage?: () => Promise<EntityId[]>) {
    this.setStatus({ ...this.status, state: 'saving', pending: this.status.pending + 1 })
    this.queue = this.queue.then(async () => {
      // What failed before goes first, so a later write of the same entity still lands last.
      const todo: Work[] = [...this.failed, { run, mode, salvage }]
      this.failed = []
      let error: unknown
      for (let i = 0; i < todo.length; i++) {
        try {
          await this.attempt(todo[i])
        } catch (err) {
          let failure = err
          // Failed for good: written entity by entity, and what cannot be stored is set aside, said, and passed —
          // kept at the head of the queue it would stop every save after it for the rest of the page's life.
          if (isPermanent(err)) {
            try {
              const salvage = todo[i].salvage
              this.setAside(salvage ? await this.locked(todo[i].mode, salvage) : [], err, salvage ? 0 : 1)
              continue
            } catch (again) {
              failure = again
            }
          }
          error = failure
          this.failed = todo.slice(i)
          break
        }
      }
      const pending = this.status.pending - 1
      const skipped = this.status.skipped
      if (error !== undefined) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        console.warn('[aegraph] not saved to this browser:', error)
        this.setStatus({ state: 'error', pending, error: message, unsaved: this.failed.length, skipped })
      } else this.setStatus({ state: pending > 0 ? 'saving' : 'idle', pending, skipped })
    })
  }

  private setAside(ids: EntityId[], err: unknown, writes: number) {
    if (!ids.length && !writes) return
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.warn(`[aegraph] ${ids.length || writes} change(s) cannot be stored in this browser and were set aside:`, ids.slice(0, 20), err)
    this.lost = { count: this.lost.count + (ids.length || writes), ids: [...this.lost.ids, ...ids].slice(0, 100), error: why }
  }

  /** The ids set aside as impossible to store, the first hundred (see `PersistStatus.lost`). */
  lostIds(): readonly EntityId[] {
    return this.lost.ids
  }

  /**
   * `apply` for a write that failed for good: the events in order, upserts as overlay records a slice at a time and
   * one by one within a slice that fails, so only what cannot be stored is left out. A replace is not taken apart:
   * its delete of what was there must follow everything it writes.
   */
  private async applyEach(store: EntityStore, event: StoreEvent): Promise<EntityId[]> {
    const events = event.type === 'batch' ? event.events : [event]
    if (events.some((e) => e.type === 'reset')) throw new Error('A replace could not be stored.')
    const db = await this.open()
    const lost: EntityId[] = []
    for (const e of events) {
      if (e.type !== 'upsert') {
        await this.writeOne(store, db, e, false)
        continue
      }
      for (let i = 0; i < e.entities.length; i += 500) {
        const slice = e.entities.slice(i, i + 500)
        try {
          await this.writeOverlay(db, slice)
        } catch (err) {
          if (!isPermanent(err)) throw err
          for (const x of slice) {
            try {
              await this.writeOverlay(db, [x])
            } catch (one) {
              if (!isPermanent(one)) throw one
              lost.push(x.id)
            }
          }
        }
      }
      this.announce({ type: 'upsert', ids: e.entities.map((x) => x.id) })
    }
    return lost
  }

  private async apply(store: EntityStore, event: StoreEvent): Promise<void> {
    // A replace (`clear`, then what goes in instead: an import in replace mode) — the batch starts with the reset.
    if (event.type === 'reset') return this.replaceAll(store, [])
    if (event.type === 'batch' && event.events[0]?.type === 'reset') return this.replaceAll(store, event.events.slice(1))
    await this.writeEvents(store, await this.open(), event.type === 'batch' ? event.events : [event], false)
  }

  /** Events in order. `quiet`: part of a replace, which tells the other tabs once, at its end. */
  private async writeEvents(store: EntityStore, db: IDBDatabase, events: StoreEvent[], quiet: boolean): Promise<void> {
    // An opened file whose entities all went in as decoded is written once, as the file, where its first upsert
    // stood; the rest of the batch keeps its order around it.
    const whole = events.length > 1 ? wholeFiles(events) : new Set<BulkSource>()
    const written = new Set<BulkSource>()
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e.type === 'reset') return this.replaceAll(store, events.slice(i + 1))
      if (e.type === 'upsert' && e.source && whole.has(e.source)) {
        if (written.has(e.source)) continue
        written.add(e.source)
        await this.writeFile(db, e.source, idsOf(events, e.source))
        if (!quiet) this.announce({ type: 'reload' })
        continue
      }
      await this.writeOne(store, db, e, quiet)
    }
  }

  private async writeOne(store: EntityStore, db: IDBDatabase, event: StoreEvent, quiet: boolean): Promise<void> {
    switch (event.type) {
      case 'upsert':
        if (event.source && event.entities.length === event.source.expected) {
          await this.writeFile(db, event.source, event.entities.map((e) => e.id))
          if (!quiet) this.announce({ type: 'reload' })
        } else if (event.entities.length >= BULK_THRESHOLD) {
          await this.writePages(db, event.entities)
          if (!quiet) this.announce({ type: 'reload' })
        } else {
          await this.writeOverlay(db, event.entities)
          if (!quiet) this.announce({ type: 'upsert', ids: event.entities.map((e) => e.id) })
        }
        return
      case 'remove':
        await this.writeTombstones(db, event.ids)
        if (!quiet) this.announce({ type: 'remove', ids: event.ids })
        return
      case 'tags':
        await tx(db, TAGS, 'readwrite', (t) => {
          const os = t.objectStore(TAGS)
          os.clear()
          for (const info of store.tagInfos()) os.put(info)
        })
        if (!quiet) this.announce({ type: 'tags' })
        return
    }
  }

  /**
   * A replace: what the store holds now goes down first, and only then — in one transaction — goes what was on disk
   * when it began (the keys read here, less the overlay records and tombstones the replace wrote itself), and the
   * tags become the store's. The window a crash can hit is between the first write and that transaction; it leaves
   * old and new side by side on disk (see the note at the top), never nothing. A retry starts again from a fresh read
   * of the keys, which then include what the failed attempt wrote — deleted at the end, and written again before.
   */
  private async replaceAll(store: EntityStore, rest: StoreEvent[]): Promise<void> {
    const db = await this.open()
    const before = await keysOnDisk(db)
    const kept = (this.replacing = { overlay: new Set<EntityId>(), tombs: new Set<EntityId>() })
    try {
      await this.writeEvents(store, db, rest, true)
      await tx(db, [PAGES, OVERLAY, TOMBSTONES, TAGS], 'readwrite', (t) => {
        const pages = t.objectStore(PAGES)
        for (const k of before.pages) pages.delete(k)
        const ov = t.objectStore(OVERLAY)
        for (const k of before.overlay) if (!kept.overlay.has(k as EntityId)) ov.delete(k)
        const ts = t.objectStore(TOMBSTONES)
        for (const k of before.tombs) if (!kept.tombs.has(k as EntityId)) ts.delete(k)
        const tags = t.objectStore(TAGS)
        tags.clear()
        for (const info of store.tagInfos()) tags.put(info)
      })
    } finally {
      this.replacing = null
    }
    this.announce({ type: 'reload' })
  }

  /**
   * Entities as pages, numbered after the last page on disk. `alone`: leave the overlay and tombstones as they are —
   * compaction's pages, which are not a newer word on anything. `into`: where each page's number goes as it is given,
   * so a write that fails half-way still says which pages it may have put down.
   */
  private async writePages(db: IDBDatabase, entities: AnyEntity[], { alone = false, into = [] as number[] } = {}): Promise<void> {
    const numbers = into
    // Pages are sized by bytes, not only by count: 4,000 chat transcripts would be one 60 MB record — slow to put,
    // slow to read back, and its pack buffer doubled its way up through memory. A sample says how heavy these are.
    let sampled = 0
    for (let i = 0; i < entities.length && i < 24; i++) sampled += JSON.stringify(entities[Math.floor((i * entities.length) / Math.min(24, entities.length))]).length
    const meanBytes = Math.max(64, sampled / Math.min(24, entities.length))
    const pageSize = Math.max(100, Math.min(PAGE_SIZE, Math.round(PAGE_BYTES / meanBytes)))
    for (let i = 0; i < entities.length; i += pageSize * 10) {
      const slice = entities.slice(i, i + pageSize * 10)
      // Packing is the CPU: a page at a time, the event loop between pages, so a big bundle's first write is many
      // short tasks the page stays responsive through (ten pages packed inside one transaction was a third of a
      // second each with nothing else able to run — the Unigraph open right after a 700k-entity bundle stuttered on it).
      const packed: ArrayBuffer[] = []
      for (let j = 0; j < slice.length; j += pageSize) {
        packed.push(packPage(slice.slice(j, j + pageSize)))
        await yieldToEvents()
      }
      await tx(db, [PAGES, TOMBSTONES, OVERLAY], 'readwrite', (t) => {
        if (!alone) dropSuperseded(t, slice.map((e) => e.id))
        const pages = t.objectStore(PAGES)
        // Numbered after the last page on disk, read in this transaction: see the note at the top.
        const last = pages.openKeyCursor(null, 'prev')
        last.onsuccess = () => {
          let n = Math.max(last.result ? Math.floor(Number(last.result.key)) + 1 : 0, this.nextPage)
          for (const bytes of packed) {
            numbers.push(n)
            pages.put({ n: n++, packed: bytes } satisfies PageRecord)
          }
          this.nextPage = n
        }
      })
    }
  }

  /** A whole file as one page (see `PageRecord.file`), numbered like any other, superseding what it brings back. */
  private async writeFile(db: IDBDatabase, source: BulkSource, ids: EntityId[]) {
    const file = new Blob([source.bytes as Uint8Array<ArrayBuffer>])
    await tx(db, [PAGES, TOMBSTONES, OVERLAY], 'readwrite', (t) => {
      dropSuperseded(t, ids)
      const pages = t.objectStore(PAGES)
      const last = pages.openKeyCursor(null, 'prev')
      last.onsuccess = () => {
        const n = Math.max(last.result ? Math.floor(Number(last.result.key)) + 1 : 0, this.nextPage)
        pages.put({ n, file } satisfies PageRecord)
        this.nextPage = n + 1
      }
    })
  }

  private async writeOverlay(db: IDBDatabase, entities: AnyEntity[]) {
    await tx(db, [OVERLAY, TOMBSTONES], 'readwrite', (t) => {
      const ov = t.objectStore(OVERLAY)
      const ts = t.objectStore(TOMBSTONES)
      for (const e of entities) {
        ov.put(e)
        // Whoever deleted it — this tab or another — it is back.
        ts.delete(e.id)
      }
    })
    if (this.replacing) for (const e of entities) this.replacing.overlay.add(e.id)
  }

  private async writeTombstones(db: IDBDatabase, ids: EntityId[]) {
    for (let i = 0; i < ids.length; i += 20_000) {
      const slice = ids.slice(i, i + 20_000)
      await tx(db, [OVERLAY, TOMBSTONES], 'readwrite', (t) => {
        const ov = t.objectStore(OVERLAY)
        const ts = t.objectStore(TOMBSTONES)
        for (const id of slice) {
          ov.delete(id)
          ts.put({ id })
        }
      })
      if (this.replacing) for (const id of slice) this.replacing.tombs.add(id)
    }
  }

  /**
   * Compaction: the entities the load read, written as fresh pages above the old ones, then — in one transaction —
   * exactly what was read deleted: those pages, the overlay records still as they were read (one another tab has
   * written since is newer than the pages and stays), the tombstones read. If another writer has put a page down
   * since the load read (checked before and again in that last transaction), this rewrite is stale — its pages could
   * outrank that one — so it deletes its own pages and gives up until the next load. A page that could not be read
   * is never deleted. Runs holding the exclusive lock where there are Web Locks, so no tab writes meanwhile.
   */
  private async rewriteAll(entities: AnyEntity[], base: CompactionBase) {
    const db = await this.open()
    const ours = () => new Set([...base.pageKeys, ...base.written])
    const foreign = (keys: IDBValidKey[]) => {
      const known = new Set([...base.pageKeys, ...base.unreadableKeys, ...base.written])
      return keys.some((k) => !known.has(Number(k)))
    }
    if (foreign(await getAllKeys(db, PAGES))) return
    const mine = base.written.length
    await this.writePages(db, entities, { alone: true, into: base.written })
    const fresh = new Set(base.written.slice(mine))
    const overlayRead = new Map(base.overlay.map((e) => [e.id, e]))
    await tx(db, [PAGES, OVERLAY, TOMBSTONES], 'readwrite', (t) => {
      const pages = t.objectStore(PAGES)
      const now = pages.getAllKeys()
      now.onsuccess = () => {
        if (foreign(now.result)) {
          for (const n of fresh) pages.delete(n)
          return
        }
        for (const n of ours()) if (!fresh.has(n)) pages.delete(n)
        const ts = t.objectStore(TOMBSTONES)
        for (const id of base.tombs) ts.delete(id)
        const cursor = t.objectStore(OVERLAY).openCursor()
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c) return
          const was = overlayRead.get(c.primaryKey as EntityId)
          if (was && same(was, c.value)) c.delete()
          c.continue()
        }
      }
    })
  }

  private async clearAll(db: IDBDatabase) {
    await tx(db, [PAGES, OVERLAY, TOMBSTONES, TAGS], 'readwrite', (t) => {
      t.objectStore(PAGES).clear()
      t.objectStore(OVERLAY).clear()
      t.objectStore(TOMBSTONES).clear()
      t.objectStore(TAGS).clear()
    })
    this.nextPage = 0
  }

  private setStatus(s: PersistStatus) {
    // What was set aside is not saved, and says so until the page closes.
    if (this.lost.count) s = { ...s, lost: this.lost.count, ...(s.state === 'idle' ? { state: 'error' as const, error: `${this.lost.count} change${this.lost.count === 1 ? '' : 's'} cannot be stored in this browser and ${this.lost.count === 1 ? 'was' : 'were'} set aside (${this.lost.error}); later changes are saved.` } : {}) }
    this.status = s
    for (const l of this.listeners) l(s)
  }
}

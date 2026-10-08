import type { AnyEntity, EntityId } from '../entity/types'
import { packDocument, unpackDocument } from '../exchange/pack/pack'
import { MAX_STORED_DEPTH } from '../exchange/limits'
import type { CommitBlob } from './versioning'

/**
 * Where commit content lives: its own IndexedDB database, beside the
 * Library's (`aegraph`), one record per commit keyed by the commit id.
 * The commit *entities* are in the store like everything else; the blobs
 * are read only when a diff is viewed, a tree is rebuilt or a commit is
 * restored, so history costs the store no memory. Without IndexedDB
 * (tests, a headless run) an in-memory map does the same job for the
 * session.
 */
export interface BlobStore {
  get(id: EntityId): Promise<CommitBlob | undefined>
  put(blob: CommitBlob): Promise<void>
  delete(ids: EntityId[]): Promise<void>
  keys(): Promise<EntityId[]>
  /**
   * What a commit did to the tree — the ids it wrote with their hashes, and
   * the ids it removed — without its content. Rebuilding HEAD's tree needs
   * only this, and on a big project the content is the whole project: read
   * through `get`, a reload held a second copy of it. Optional: a store
   * without it is read through `get`.
   */
  hashes?(id: EntityId): Promise<CommitHashes | undefined>
}

/** A commit's effect on the tree: `ids[i]` was written with `hashes[i]`; `removed` left it. */
export interface CommitHashes {
  ids: EntityId[]
  hashes: string[]
  removed: EntityId[]
}

/** The tree record of a blob. */
export function hashesOf(blob: CommitBlob): CommitHashes {
  const ids: EntityId[] = []
  const hashes: string[] = []
  for (const list of [blob.added, blob.modified])
    for (const e of list) {
      ids.push(e.id)
      hashes.push(blob.hashes[e.id])
    }
  return { ids, hashes, removed: blob.removed.map((e) => e.id) }
}

export class MemoryBlobs implements BlobStore {
  private map = new Map<EntityId, CommitBlob>()
  async get(id: EntityId) {
    return this.map.get(id)
  }
  async put(blob: CommitBlob) {
    this.map.set(blob.id, blob)
  }
  async delete(ids: EntityId[]) {
    for (const id of ids) this.map.delete(id)
  }
  async keys() {
    return [...this.map.keys()]
  }
  async hashes(id: EntityId) {
    const b = this.map.get(id)
    return b && hashesOf(b)
  }
}

/**
 * How a commit is kept in IndexedDB. A small one as it is; one past
 * PACK_FROM entities as the pack (`packDocument`, what the Library's pages
 * use), in chunks: a structured clone of a 700k-entity commit is the whole
 * project again, on the main thread, and the pack is a fraction of it. Its
 * tree — ids and hashes, one string each — goes in a store of its own, so
 * a tree is rebuilt without reading any content.
 */
type StoredBlob = CommitBlob | { id: EntityId; project: EntityId; packed: { added: ArrayBuffer[]; modified: ArrayBuffer[]; removed: ArrayBuffer[] } }
/** Lists joined into one string each (one clone, not 700k); a list holding the separator itself is kept as an array. */
type StoredList = string | string[]
type StoredTree = { id: EntityId; ids: StoredList; hashes: StoredList; removed: StoredList }
const PACK_FROM = 2000
const CHUNK = 20000
const SEP = '\n'

const toBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
/** Pack a list a chunk at a time, letting the page breathe between chunks. */
async function packChunks(list: AnyEntity[]): Promise<ArrayBuffer[]> {
  const out: ArrayBuffer[] = []
  for (let i = 0; i < list.length; i += CHUNK) {
    out.push(toBuffer(packDocument({ entities: list.slice(i, i + CHUNK) })))
    if (i + CHUNK < list.length) await new Promise((r) => setTimeout(r, 0))
  }
  return out
}
const unpackChunks = (chunks: ArrayBuffer[]): AnyEntity[] => chunks.flatMap((c) => unpackDocument(new Uint8Array(c), { maxDepth: MAX_STORED_DEPTH }).entities)
const joinIds = (ids: string[]): StoredList => (ids.some((id) => id.includes(SEP)) ? ids : ids.join(SEP))
const splitIds = (s: StoredList): string[] => (Array.isArray(s) ? s : s ? s.split(SEP) : [])

const DB_NAME = 'aegraph-history'
const DB_VERSION = 2
const STORE = 'commits'
/** Each commit's tree record (v2): what `hashes` reads. A commit written before it has none until first read. */
const TREES = 'trees'

export class IdbBlobs implements BlobStore {
  private db: Promise<IDBDatabase> | null = null

  static isSupported() {
    return typeof indexedDB !== 'undefined'
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
          if (!db.objectStoreNames.contains(TREES)) db.createObjectStore(TREES, { keyPath: 'id' })
        }
        req.onsuccess = () => {
          const db = req.result
          // Closed under us — by the browser, or a version change elsewhere: the next request opens a new connection,
          // rather than every commit failing on this one for the rest of the page's life (as the main database's did).
          db.onclose = () => (this.db = null)
          db.onversionchange = () => {
            db.close()
            this.db = null
          }
          resolve(db)
        }
        req.onerror = () => reject(req.error)
        req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'))
      })
      this.db.catch(() => (this.db = null))
    }
    return this.db
  }

  private request<T>(mode: IDBTransactionMode, run: (os: IDBObjectStore) => IDBRequest<T>, name = STORE): Promise<T> {
    const once = () =>
      this.open().then(
        (db) =>
          new Promise<T>((resolve, reject) => {
            const t = db.transaction(name, mode)
            const req = run(t.objectStore(name))
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
            t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
          }),
      )
    // A connection that closed without saying so throws when a transaction is asked of it: drop it and try once more.
    return once().catch((err) => {
      if (!(err instanceof DOMException && err.name === 'InvalidStateError')) throw err
      this.db = null
      return once()
    })
  }

  async get(id: EntityId): Promise<CommitBlob | undefined> {
    const stored = await this.request<StoredBlob | undefined>('readonly', (os) => os.get(id) as IDBRequest<StoredBlob | undefined>)
    if (!stored || !('packed' in stored)) return stored
    const tree = await this.readTree(id)
    const hashes: Record<EntityId, string> = {}
    if (tree) {
      const ids = splitIds(tree.ids)
      const hs = splitIds(tree.hashes)
      for (let i = 0; i < ids.length; i++) hashes[ids[i]] = hs[i]
    }
    return { id: stored.id, project: stored.project, added: unpackChunks(stored.packed.added), modified: unpackChunks(stored.packed.modified), removed: unpackChunks(stored.packed.removed), hashes }
  }

  async put(blob: CommitBlob): Promise<void> {
    const t = hashesOf(blob)
    const tree: StoredTree = { id: blob.id, ids: joinIds(t.ids), hashes: joinIds(t.hashes), removed: joinIds(t.removed) }
    const big = blob.added.length + blob.modified.length + blob.removed.length >= PACK_FROM
    const stored: StoredBlob = big ? { id: blob.id, project: blob.project, packed: { added: await packChunks(blob.added), modified: await packChunks(blob.modified), removed: await packChunks(blob.removed) } } : blob
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE, TREES], 'readwrite')
      t.objectStore(STORE).put(stored)
      t.objectStore(TREES).put(tree)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
    })
  }

  async hashes(id: EntityId): Promise<CommitHashes | undefined> {
    const tree = await this.readTree(id)
    if (tree) return { ids: splitIds(tree.ids), hashes: splitIds(tree.hashes), removed: splitIds(tree.removed) }
    // A commit from before the tree records: read it once, and keep its record so the next rebuild doesn't.
    const blob = await this.get(id)
    if (!blob) return undefined
    const h = hashesOf(blob)
    await this.request('readwrite', (os) => os.put({ id, ids: joinIds(h.ids), hashes: joinIds(h.hashes), removed: joinIds(h.removed) } satisfies StoredTree), TREES).catch(() => {})
    return h
  }

  private readTree(id: EntityId): Promise<StoredTree | undefined> {
    return this.request<StoredTree | undefined>('readonly', (os) => os.get(id) as IDBRequest<StoredTree | undefined>, TREES)
  }

  async delete(ids: EntityId[]): Promise<void> {
    if (!ids.length) return
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([STORE, TREES], 'readwrite')
      const os = t.objectStore(STORE)
      const trees = t.objectStore(TREES)
      for (const id of ids) os.delete(id), trees.delete(id)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
    })
  }

  keys(): Promise<EntityId[]> {
    return this.request<IDBValidKey[]>('readonly', (os) => os.getAllKeys()).then((ks) => ks.map(String))
  }
}

export const defaultBlobs = (): BlobStore => (IdbBlobs.isSupported() ? new IdbBlobs() : new MemoryBlobs())

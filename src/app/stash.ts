/**
 * Stashing this browser: a copy of everything aegraph keeps in IndexedDB — every database of the origin, each with its
 * version, its stores and indexes and every record — and in localStorage, kept in a database of its own
 * (`aegraph-stash`) that clearing the browser leaves alone. Restoring one puts this browser back as it was when the
 * stash was taken. It is what makes *Clear this browser* safe to use for a look at the app as a new user sees it:
 * stash, clear, look around, restore. The This browser page (`/browser`) and the `account` tool (`stash_browser`,
 * `stashes`, `restore_stash`, `delete_stash`) use it.
 *
 * Taking a stash reads the running app's databases (reads do not disturb it). Restoring is done like clearing, across
 * a reload: `requestStashRestore` leaves a note in this tab's sessionStorage and reloads, and `finishStashRestore` runs
 * at the top of the next load (`main.tsx`), before the app has opened a database — it deletes every database but the
 * stash's own, recreates each stashed one at its version with its stores, and copies the records back.
 *
 * Records are copied in batches of about `BATCH_BYTES`, never a whole store at once: the Library's pages are packs of
 * up to 6 MB each, and a Library can hold hundreds.
 *
 * A restore is all or, until it is, still asked for. Before anything is deleted it checks that the stash fits in what
 * the browser has free (`navigator.storage.estimate`) and refuses, changing nothing, when it does not. Once it starts
 * it keeps its note — in localStorage too (`RESTORING`), which the clearing keeps — until the last record and key are
 * back, so a restore cut short (a full disk, the tab closed) is taken up again at the next load rather than leaving the
 * app to start on part of a browser. A database that will not be deleted stops it before the stash is laid over what
 * is left, and so does one that turns out not to be new when it is recreated.
 *
 * The secrets (`isSecretKey`: the assistant's Claude key, the OpenAI key, the Spotify
 * session, the bridge's address with its token) are not stashed unless the stash is taken with `includeKeys` (and a
 * sign-in token a hosted copy left on this origin, `sb-…`, never is): a stash is a plain copy
 * that clearing never deletes, and a key has no business outliving the browser state it was entered in. A restore
 * keeps the secrets this browser has now, and lays a stash's own over them only when it holds some. A browser keeps
 * at most `MAX_STASHES`, and a stash is not started without room for it.
 */

import { browserDatabases, clearBrowser, STASH_DB } from './reset'

export { STASH_DB }
const STASH_VERSION = 1
const STASHES = 'stashes'
const RECORDS = 'records'
const NOTE = 'aegraph:restore-stash'
/** A restore under way: set before the browser is cleared (which keeps it), removed once the restore is whole. */
const RESTORING = 'aegraph:restoring-stash'
/** A batch of records, read and written in one go: about this many bytes, however many records that is. */
const BATCH_BYTES = 24 * 1024 * 1024
const BATCH_MAX = 2000

/**
 * localStorage entries that hold a secret: the assistant's settings (a Claude key), voice's (an
 * OpenAI key), the Spotify session and its sign-in in flight, the bridge's address (which carries its token). Left
 * out of a stash unless it is taken with `includeKeys`; kept as they are by a restore that has none of its own.
 */
export const SECRET_KEYS: readonly string[] = ['aegraph:ai:settings', 'aegraph:voice:settings', 'aegraph:spotify:auth', 'aegraph:spotify:pkce', 'aegraph:bridge:url']
/**
 * A sign-in token left by a hosted copy of the app on the same origin (Supabase's `sb-…` keys). This edition has no
 * sign-in, so it is never stashed — not even with `includeKeys` — and a restore does not keep it.
 */
export const isSignInKey = (k: string) => k.startsWith('sb-')
export const isSecretKey = (k: string) => SECRET_KEYS.includes(k) || isSignInKey(k)

/** How many stashes a browser keeps: past it, taking another is refused until one is deleted. */
export const MAX_STASHES = 10

/** Taking a stash refused before anything was copied: too many stashes, or no room for another. */
export class StashRefused extends Error {}

export interface StoreShape {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[]
  records: number
}
export interface DatabaseShape {
  name: string
  version: number
  stores: StoreShape[]
}

/** A stash as listed: what it holds, not the records themselves. */
export interface Stash {
  id: string
  name: string
  createdAt: string
  databases: DatabaseShape[]
  /** localStorage as it was, the secrets (`isSecretKey`) left out unless `keys`. */
  localStorage: [string, string][]
  /** Whether it was taken with `includeKeys`, so holds the secrets that were in localStorage then. */
  keys?: boolean
  records: number
  /** Roughly how much it holds (records measured as they are copied, plus localStorage). */
  bytes: number
  /** False while it is being taken, and for good if taking it failed partway: such a stash is not offered to restore. */
  complete: boolean
}

/** One batch of one store's records, in the stash database. */
interface RecordBatch {
  stash: string
  db: string
  store: string
  n: number
  keys: IDBValidKey[]
  values: unknown[]
}

// ── IndexedDB in promises ────────────────────────────────────────────

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const committed = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
  })

function openStashDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STASH_DB, STASH_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STASHES)) db.createObjectStore(STASHES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: ['stash', 'db', 'store', 'n'] })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('The stash database is held by another aegraph tab.'))
  })
}

/** Open a database as it is, without creating it or changing its version. Null when it does not exist. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let absent = false
    const req = indexedDB.open(name)
    req.onupgradeneeded = () => {
      // It did not exist (a known name the browser could not list): abort, and it is not created.
      absent = true
      req.transaction?.abort()
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => (absent ? resolve(null) : reject(req.error))
  })
}

/** Every record of a stash's batches lies in this range: [id] … [id, []] (an array sorts above every other key). */
export const stashRange = (id: string, db?: string, store?: string) => {
  const head = [id, ...(db !== undefined ? [db] : []), ...(store !== undefined ? [store] : [])]
  return IDBKeyRange.bound(head, [...head, []])
}

/** Roughly how many bytes a record holds: the binary and text in it, a couple of levels down. Enough to size a batch. */
export function roughBytes(v: unknown, depth = 0): number {
  if (v == null) return 8
  if (typeof v === 'string') return v.length * 2
  if (typeof v !== 'object') return 8
  if (v instanceof ArrayBuffer) return v.byteLength
  if (ArrayBuffer.isView(v)) return v.byteLength
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size
  if (depth > 3) return 64
  let n = 16
  if (Array.isArray(v)) for (const x of v) n += roughBytes(x, depth + 1)
  else for (const x of Object.values(v as Record<string, unknown>)) n += roughBytes(x, depth + 1)
  return n
}

/** How many records to read next, from the size of the last batch: about BATCH_BYTES. */
export function nextBatchSize(lastCount: number, lastBytes: number): number {
  if (!lastCount || !lastBytes) return 64
  const per = lastBytes / lastCount
  return Math.max(1, Math.min(BATCH_MAX, Math.floor(BATCH_BYTES / per)))
}

function shapeOf(db: IDBDatabase): Omit<DatabaseShape, 'stores'> & { stores: Omit<StoreShape, 'records'>[] } {
  const stores = [...db.objectStoreNames].map((s) => {
    const os = db.transaction(s, 'readonly').objectStore(s)
    return {
      name: s,
      keyPath: os.keyPath as string | string[] | null,
      autoIncrement: os.autoIncrement,
      indexes: [...os.indexNames].map((i) => {
        const ix = os.index(i)
        return { name: i, keyPath: ix.keyPath as string | string[], unique: ix.unique, multiEntry: ix.multiEntry }
      }),
    }
  })
  return { name: db.name, version: db.version, stores }
}

// ── Taking one ───────────────────────────────────────────────────────

export interface StashProgress {
  db: string
  store: string
  records: number
}

/**
 * Stash this browser now, under `name`. Reads every database of the origin (but the stash's own) and localStorage,
 * and returns the stash. `onProgress` is told as each batch lands.
 */
export async function stashBrowser(name: string, onProgress: (p: StashProgress) => void = () => {}, { includeKeys = false }: { includeKeys?: boolean } = {}): Promise<Stash> {
  const target = await openStashDb()
  try {
    // Every stash, whole or cut short, counts: one left half-taken still holds its records.
    const existing = await done(target.transaction(STASHES, 'readonly').objectStore(STASHES).getAll() as IDBRequest<Stash[]>)
    if (existing.length >= MAX_STASHES) throw new StashRefused(`This browser already keeps ${existing.length} stashes, the most it keeps. Delete one you no longer need, then stash again.`)
    // The copy needs about as much room again as what is not already a stash.
    const kept = existing.reduce((n, x) => n + (x.bytes || 0), 0)
    const usage = await globalThis.navigator?.storage?.estimate?.().then((e) => e.usage).catch(() => undefined)
    if (typeof usage === 'number') {
      const room = await stashRoom(Math.max(0, usage - kept))
      if (room && !room.fits) throw new StashRefused(`A stash of this browser needs about ${mb(room.need)} and it has about ${mb(room.free)} free. Nothing was stashed. Delete stashes you no longer need, then try again.`)
    }
  } catch (e) {
    target.close()
    throw e
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const local: [string, string][] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && !isSignInKey(k) && (includeKeys || !isSecretKey(k))) local.push([k, localStorage.getItem(k) ?? ''])
    }
  } catch {
    /* no storage */
  }
  const stash: Stash = { id, name: name.trim() || `Stash of ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), databases: [], localStorage: local, ...(includeKeys ? { keys: true } : {}), records: 0, bytes: local.reduce((n, [k, v]) => n + (k.length + v.length) * 2, 0), complete: false }
  const writeMeta = async () => {
    const t = target.transaction(STASHES, 'readwrite')
    t.objectStore(STASHES).put(stash)
    await committed(t)
  }
  try {
    await writeMeta()
    for (const name of await browserDatabases()) {
      if (name === STASH_DB) continue
      const source = await openExisting(name)
      if (!source) continue
      try {
        const shape = shapeOf(source)
        const dbShape: DatabaseShape = { name: shape.name, version: shape.version, stores: [] }
        for (const s of shape.stores) {
          let n = 0
          let count = 0
          let after: IDBValidKey | undefined
          let size = 64
          for (;;) {
            const t = source.transaction(s.name, 'readonly')
            const os = t.objectStore(s.name)
            const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
            const [keys, values] = await Promise.all([done(os.getAllKeys(range, size)), done(os.getAll(range, size))])
            if (!keys.length) break
            const bytes = values.reduce<number>((b, v) => b + roughBytes(v), 0)
            const w = target.transaction(RECORDS, 'readwrite')
            w.objectStore(RECORDS).put({ stash: id, db: name, store: s.name, n: n++, keys, values } satisfies RecordBatch)
            await committed(w)
            count += keys.length
            stash.records += keys.length
            stash.bytes += bytes
            after = keys[keys.length - 1]
            size = nextBatchSize(keys.length, bytes)
            onProgress({ db: name, store: s.name, records: count })
          }
          dbShape.stores.push({ ...s, records: count })
        }
        stash.databases.push(dbShape)
      } finally {
        source.close()
      }
    }
    stash.complete = true
    await writeMeta()
    return stash
  } catch (e) {
    // What was copied so far goes: a stash is whole or not kept.
    await removeStash(target, id).catch(() => {})
    throw e
  } finally {
    target.close()
  }
}

// ── Listing, deleting ────────────────────────────────────────────────

/** The stashes in this browser, newest first. Only whole ones: one being taken (or cut short) is left out. */
export async function listStashes(): Promise<Stash[]> {
  const db = await openStashDb()
  try {
    const all = await done(db.transaction(STASHES, 'readonly').objectStore(STASHES).getAll() as IDBRequest<Stash[]>)
    return all.filter((s) => s.complete).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } finally {
    db.close()
  }
}

async function removeStash(db: IDBDatabase, id: string) {
  const t = db.transaction([STASHES, RECORDS], 'readwrite')
  t.objectStore(STASHES).delete(id)
  t.objectStore(RECORDS).delete(stashRange(id))
  await committed(t)
}

/** Delete a stash for good. False when there is none by that id. */
export async function deleteStash(id: string): Promise<boolean> {
  const db = await openStashDb()
  try {
    const had = await done(db.transaction(STASHES, 'readonly').objectStore(STASHES).count(id))
    if (!had) return false
    await removeStash(db, id)
    return true
  } finally {
    db.close()
  }
}

// ── Restoring one ────────────────────────────────────────────────────

/** Restore a stash on the next load, and reload now. */
export function requestStashRestore(id: string, reload: () => void = () => location.reload()) {
  sessionStorage.setItem(NOTE, JSON.stringify({ id }))
  reload()
}

const noteId = (raw: string | null): string | null => {
  try {
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { id?: unknown }
    return typeof parsed?.id === 'string' ? parsed.id : null
  } catch {
    return null
  }
}
const read = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

/** The stash this load was asked to restore (see `requestStashRestore`), or one whose restore was cut short; or null. */
export function stashRestorePending(): string | null {
  return noteId(read(() => sessionStorage, NOTE)) ?? noteId(read(() => localStorage, RESTORING))
}

/** The restore is done with — whole, refused, or given up on: no load takes it up again. */
export function clearStashRestore() {
  for (const [storage, key] of [
    [() => sessionStorage, NOTE],
    [() => localStorage, RESTORING],
  ] as const)
    try {
      storage().removeItem(key)
    } catch {
      /* no storage */
    }
}

/** A restore refused before anything was touched: the browser is as it was. */
export class StashRestoreRefused extends Error {}

const MB = 1024 * 1024
const mb = (n: number) => `${Math.max(1, Math.round(n / MB)).toLocaleString()} MB`

/**
 * Whether a stash of `bytes` fits in what this browser has free for the origin, from `navigator.storage.estimate()`
 * (null when the browser cannot say — then the restore goes ahead). The stash's own copy stays while its records are
 * written back beside it, so the room needed is the stash again, with a margin for the databases' own overhead.
 */
export async function stashRoom(bytes: number, storage: { estimate?: () => Promise<{ quota?: number; usage?: number }> } | undefined = globalThis.navigator?.storage): Promise<{ fits: boolean; need: number; free: number } | null> {
  try {
    const e = await storage?.estimate?.()
    if (!e || typeof e.quota !== 'number' || typeof e.usage !== 'number') return null
    const need = Math.ceil(bytes * 1.1)
    const free = Math.max(0, e.quota - e.usage)
    return { fits: free >= need, need, free }
  } catch {
    return null
  }
}

const leftOver = (name: string) => new Error(`${name} was still there after clearing; nothing was written into it.`)

/** Recreate a stashed database, empty. One that is already there (its delete did not happen) is an error, never filled. */
function createDatabase(shape: DatabaseShape): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(shape.name, shape.version)
    let fresh = false
    let stale = false
    req.onupgradeneeded = (e) => {
      if (e.oldVersion !== 0) {
        stale = true
        return req.transaction?.abort()
      }
      fresh = true
      const db = req.result
      for (const s of shape.stores) {
        const os = db.createObjectStore(s.name, { keyPath: s.keyPath ?? undefined, autoIncrement: s.autoIncrement })
        for (const i of s.indexes) os.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry })
      }
    }
    req.onsuccess = () => {
      if (fresh) return resolve(req.result)
      req.result.close()
      reject(leftOver(shape.name))
    }
    req.onerror = () => reject(stale ? leftOver(shape.name) : req.error)
    req.onblocked = () => reject(new Error(`${shape.name} is held by another aegraph tab.`))
  })
}

/**
 * Put this browser back as the stash `id` holds it: every database but the stash's own is deleted, each stashed one
 * recreated and filled, and localStorage replaced (the keys here kept unless the stash holds its own). Returns the stash, or null when there is none
 * by that id (then nothing is touched). Throws `StashRestoreRefused`, touching nothing, when the stash will not fit in
 * the room the browser has; any other error leaves the restore noted as under way (`stashRestorePending`), to be taken
 * up again. `onBlocked` is told when another tab holds a database open.
 */
export async function restoreStash(id: string, onBlocked: () => void = () => {}, onProgress: (p: StashProgress) => void = () => {}): Promise<Stash | null> {
  const stashDb = await openStashDb()
  try {
    const stash = await done(stashDb.transaction(STASHES, 'readonly').objectStore(STASHES).get(id) as IDBRequest<Stash | undefined>)
    if (!stash?.complete) return null
    const room = await stashRoom(stash.bytes)
    if (room && !room.fits)
      throw new StashRestoreRefused(
        `This stash needs about ${mb(room.need)} and this browser has about ${mb(room.free)} free. Nothing was changed. Clear this browser first (stashes are kept), or delete stashes you no longer need, then restore it.`,
      )
    // From here the restore is under way until it is whole: noted where the clearing below leaves it.
    localStorage.setItem(RESTORING, JSON.stringify({ id }))
    // The secrets this browser has now stay — a stash taken without them would otherwise sign the user out of
    // everything — and the stash's own, if it holds any, are laid over them below.
    await clearBrowser({ keepKeys: [RESTORING, ...SECRET_KEYS], strict: true }, onBlocked)
    for (const shape of stash.databases) {
      const db = await createDatabase(shape)
      try {
        for (const s of shape.stores) {
          let count = 0
          let n = 0
          for (;;) {
            const batch = await done(stashDb.transaction(RECORDS, 'readonly').objectStore(RECORDS).get([id, shape.name, s.name, n++]) as IDBRequest<RecordBatch | undefined>)
            if (!batch) break
            const t = db.transaction(s.name, 'readwrite')
            const os = t.objectStore(s.name)
            batch.values.forEach((v, i) => (s.keyPath === null ? os.put(v, batch.keys[i]) : os.put(v)))
            await committed(t)
            count += batch.keys.length
            onProgress({ db: shape.name, store: s.name, records: count })
          }
        }
      } finally {
        db.close()
      }
    }
    for (const [k, v] of stash.localStorage) if (k !== RESTORING) localStorage.setItem(k, v)
    clearStashRestore()
    return stash
  } finally {
    stashDb.close()
  }
}

/**
 * The second step of a restore, at the top of `main.tsx` (and at every load after one cut short): restore, then load
 * the front page. Says what it is doing; a restore that fails part-way is not left for the app to start on — the page
 * offers to try again, or to open the app as it is.
 */
export async function finishStashRestore(id: string) {
  const root = document.getElementById('root')
  // Text only: the progress names databases and stores, and an error carries whatever a browser put in it — none of
  // it is markup. A link back to the app is an action like the buttons.
  const say = (text: string, actions: { label: string; run: () => void }[] = [], home = false) => {
    if (!root) return
    const p = document.createElement('p')
    p.style.cssText = 'font: 14px system-ui, sans-serif; padding: 48px 48px 12px; text-align: center; color: #666'
    p.textContent = text
    if (home) {
      const a = document.createElement('a')
      a.href = '/'
      a.textContent = 'Open aegraph'
      p.append(' ', a)
    }
    const row = document.createElement('p')
    row.style.textAlign = 'center'
    for (const a of actions) {
      const b = document.createElement('button')
      b.textContent = a.label
      b.style.margin = '0 6px'
      b.onclick = a.run
      row.append(b)
    }
    root.replaceChildren(p, row)
  }
  const clean = (e: unknown) => String((e as Error)?.message ?? e)
  say('Restoring a stash…')
  try {
    const restored = await restoreStash(
      id,
      () => say('Restoring a stash… another aegraph tab is still open — close it (or reload it) to finish.'),
      (p) => say(`Restoring a stash… ${p.db} · ${p.store} · ${p.records.toLocaleString()} records`),
    )
    if (!restored) {
      clearStashRestore()
      say('That stash is not in this browser any more. Nothing was changed.', [], true)
      return
    }
  } catch (e) {
    if (e instanceof StashRestoreRefused) {
      clearStashRestore()
      say(`The stash was not restored. ${clean(e)}`, [], true)
      return
    }
    say(`The stash could not be restored: ${clean(e)}. This browser is part-way through it, so aegraph does not start on it; the stash itself is untouched.`, [
      { label: 'Try again', run: () => location.reload() },
      {
        label: 'Open aegraph as it is',
        run: () => {
          clearStashRestore()
          location.replace('/')
        },
      },
    ])
    return
  }
  location.replace('/')
}

import type { Positions } from '../../core/graph/layouts'
import type { Position } from '../../core/graph/types'
import { PositionStore } from './positionStore'

/**
 * Where the explorer's held (unsaved) positions survive a reload. Small
 * sets go to localStorage as JSON, read synchronously when the state is
 * restored. Past `LOCAL_CAP` nodes (a big GPU view) they go to IndexedDB
 * as packed arrays — ids and x, y, z — with a marker in localStorage saying
 * so, so the restoring state knows positions are on their way and no
 * layout starts in the meantime. Without IndexedDB (tests) big sets are
 * simply not kept.
 *
 * What is written is read straight out of the held store (`PositionStore`),
 * entry by entry: at the sizes a session accumulates, materialising the
 * whole set as an object first is tens of milliseconds of main-thread work
 * on every save, and the save runs 800ms after a drag where it would be
 * felt. A plain positions object is still accepted (the tests pass one).
 */
/**
 * The most nodes kept in localStorage; more go to IndexedDB. localStorage is small (5M characters an origin) and
 * shared with everything else the app keeps there — chat transcripts, tables, the flight recorder — and a full one
 * fails every write in the tab quietly. At 20,000 a few explorer sessions filled it (29 sets, 7.8 MB, seen in the
 * wild); at 1,000 a set is tens of kilobytes.
 */
export const LOCAL_CAP = 1000
const DB_NAME = 'aegraph-explorer'
const DB_VERSION = 1
const STORE = 'positions'

interface Packed extends PackedPositions {
  key: string
}

/**
 * Positions as numbers, from a caller that already holds them that way — the engine's own arrays while a live
 * simulation runs. Writing these costs a fill of a Float32Array instead of an object per node, which is what a
 * picture of a million nodes needs if it is to be saved while it moves.
 */
export interface PackedPositions {
  ids: string[]
  xyz: Float32Array
  dims: 2 | 3
  count: number
}

let dbPromise: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'))
    })
    dbPromise.catch(() => (dbPromise = null))
  }
  return dbPromise
}
const hasIdb = () => typeof indexedDB !== 'undefined'

/** Positions to write: the held store, or a plain object. Read once, in one pass, either way. */
export type HeldSource = PositionStore | Positions
const sizeOf = (h: HeldSource) => (h instanceof PositionStore ? h.size : Object.keys(h).length)
function* entriesOf(h: HeldSource): Generator<[string, Position]> {
  if (h instanceof PositionStore) yield* h.entries()
  else for (const id in h) yield [id, h[id]]
}

export function pack(key: string, positions: HeldSource): Packed {
  const n = sizeOf(positions)
  const ids: string[] = new Array(n)
  const xyz = new Float32Array(n * 3)
  let dims: 2 | 3 = 2
  let i = 0
  for (const [id, p] of entriesOf(positions)) {
    ids[i] = id
    xyz[i * 3] = p.x
    xyz[i * 3 + 1] = p.y
    xyz[i * 3 + 2] = p.z ?? 0
    if (p.z !== undefined) dims = 3
    i++
  }
  return { key, ids, xyz, dims, count: n }
}
export function unpack(p: Packed): Positions {
  const out: Positions = {}
  for (let i = 0; i < p.ids.length; i++) out[p.ids[i]] = p.dims === 3 ? { x: p.xyz[i * 3], y: p.xyz[i * 3 + 1], z: p.xyz[i * 3 + 2] } : { x: p.xyz[i * 3], y: p.xyz[i * 3 + 1] }
  return out
}

/** What localStorage holds under the key: the positions themselves, or a note that IndexedDB has them. */
type Marker = { positions: Positions } | { idb: true; count: number }

/** Persist; the returned promise settles when the write is done (IndexedDB) or at once (localStorage). */
export async function saveHeldPositions(key: string, positions: HeldSource): Promise<void> {
  prefetched.delete(key)
  const n = sizeOf(positions)
  if (n === 0) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
    if (hasIdb()) await remove(key).catch(() => undefined)
    return
  }
  if (n <= LOCAL_CAP || !hasIdb()) {
    try {
      localStorage.setItem(key, JSON.stringify({ positions: positions instanceof PositionStore ? positions.asObject() : positions } satisfies Marker))
    } catch {
      // localStorage is full: IndexedDB if there is one — its copy is the one that counts, and must not be removed below.
      if (hasIdb()) {
        try {
          localStorage.removeItem(key) // the stale value, so the marker fits
        } catch {
          /* ignore */
        }
        await put(key, positions, n)
      }
      return
    }
    if (hasIdb()) await remove(key).catch(() => undefined)
    return
  }
  await put(key, positions, n)
}
/**
 * The same, for positions a caller hands over already packed (see `PackedPositions`).
 *
 * `idsUnchanged` says the ids are the ones the last write stored — the case while a simulation moves the same
 * nodes over and over — and then only the numbers are written. IndexedDB copies whatever it is given, and copying
 * 820,000 strings every second was a tenth of a second of main thread each time; the float buffer alone is a
 * memcpy. The ids go in a record of their own beside the numbers, written whenever they do change.
 */
export async function saveHeldPositionsPacked(key: string, p: PackedPositions, idsUnchanged = false): Promise<void> {
  prefetched.delete(key)
  if (p.count === 0) return saveHeldPositions(key, {})
  if (p.count <= LOCAL_CAP || !hasIdb()) return saveHeldPositions(key, unpack({ key, ...p }))
  await putPacked({ key, ...p }, p.count, idsUnchanged)
}

/** Where the ids of a big set are kept, beside the numbers. */
const idsKey = (key: string) => `${key}::ids`

async function put(key: string, positions: HeldSource, n: number) {
  return putPacked(pack(key, positions), n)
}
async function putPacked(packed: Packed, n: number, idsUnchanged = false) {
  const key = packed.key
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    // The numbers, and the ids beside them when they are not the ones already stored.
    store.put({ key, xyz: packed.xyz, dims: packed.dims, count: packed.count })
    if (!idsUnchanged) store.put({ key: idsKey(key), ids: packed.ids })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  try {
    localStorage.setItem(key, JSON.stringify({ idb: true, count: n } satisfies Marker))
  } catch {
    /* ignore */
  }
}
async function remove(key: string) {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.objectStore(STORE).delete(idsKey(key))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** The synchronous half of a restore: positions from localStorage, or how many IndexedDB holds. */
export function readHeldPositionsSync(raw: string | null): { positions: Positions } | { pending: number } | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as Partial<Marker>
    if ('idb' in m && m.idb) return { pending: (m as { count?: number }).count ?? 0 }
    if ('positions' in m && m.positions && typeof m.positions === 'object') return { positions: m.positions }
  } catch {
    /* ignore */
  }
  return null
}

/** The asynchronous half: the packed positions from IndexedDB, or none. */
export async function readHeldPositionsIdb(key: string): Promise<Positions | null> {
  const p = await readHeldPositionsPacked(key)
  return p ? unpack({ ...p, key }) : null
}

/** The positions as they are stored — ids and a column of numbers — with no object per node. */
async function readPacked(key: string): Promise<PackedPositions | null> {
  if (!hasIdb()) return null
  const db = await open()
  const get = <T>(k: string) =>
    new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(k)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  const rec = await get<Packed>(key)
  if (!rec) return null
  // Written before the ids moved into their own record, or written with them: either reads.
  const ids = rec.ids ?? (await get<{ ids: string[] }>(idsKey(key)))?.ids
  if (!ids) return null
  return { ids, xyz: rec.xyz, dims: rec.dims, count: rec.count }
}

/**
 * Reads started before anyone asked (`prefetchHeldPositions`), by key. A big view's positions are tens of megabytes
 * read out of IndexedDB; the explorer asks for them only once it has mounted — after the Library has loaded and the
 * view has been filtered and styled, twenty seconds into a reload at a million entities — so the read is started at
 * boot instead, beside the Library's, and is done by then. What nobody claims is dropped after `PREFETCH_TTL_MS`.
 */
const prefetched = new Map<string, Promise<PackedPositions | null>>()
const PREFETCH_TTL_MS = 120_000

/**
 * The packed positions under `key` from IndexedDB — the read started at boot when there was one. It stays cached
 * for its time rather than being handed over once: a mount that asks twice (React's development double mount, a
 * view mounted, dropped and mounted again) must not read tens of megabytes twice. A save to the key drops it.
 */
export function readHeldPositionsPacked(key: string): Promise<PackedPositions | null> {
  return prefetched.get(key) ?? readPacked(key)
}

/** Start reading these keys' positions now, when storage says IndexedDB holds them (a big view's). */
export function prefetchHeldPositions(keys: string[], storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  const started: string[] = []
  for (const key of keys) {
    if (prefetched.has(key) || !hasIdb()) continue
    const r = readHeldPositionsSync(storage.getItem(key))
    if (!r || !('pending' in r)) continue
    const read = readPacked(key).catch(() => null)
    prefetched.set(key, read)
    setTimeout(() => {
      if (prefetched.get(key) === read) prefetched.delete(key)
    }, PREFETCH_TTL_MS)
    started.push(key)
  }
  return started
}

/** Where the explorer keeps a session's held positions (`explorerState.tsx` scopes it by the tab's session). */
export const POSITIONS_KEY = 'aegraph:explorer:positions:v1'

/**
 * The explorer sessions a reload is about to show: the one in the address (`?session=`) and the one in front in each
 * pane the app will open — the Workstation's and each section host's tabs, whose paths carry the session. Not every
 * tab: a tab behind another mounts only when brought forward, and its read can wait for that.
 */
export function sessionsToRestore(href: string, storage: Pick<Storage, 'getItem' | 'key' | 'length'> = localStorage): string[] {
  const out = new Set<string>()
  const add = (path: unknown) => {
    const m = typeof path === 'string' ? /[?&]session=([A-Za-z0-9_-]+)/.exec(path) : null
    if (m) out.add(m[1])
  }
  add(href)
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    const o = v as { tabs?: unknown; active?: unknown }
    if (Array.isArray(o.tabs) && typeof o.active === 'number') add((o.tabs[o.active] as { path?: unknown } | undefined)?.path)
    for (const x of Object.values(v as Record<string, unknown>)) walk(x)
  }
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (!k || !/^aegraph:(workstation|[a-z-]+):v1$/.test(k) || k.startsWith('aegraph:explorer')) continue
    try {
      walk(JSON.parse(storage.getItem(k) ?? 'null'))
    } catch {
      /* not JSON */
    }
  }
  return [...out]
}

/**
 * Once at startup: position sets that an earlier version kept in localStorage (up to 20,000 nodes each) move to
 * IndexedDB, leaving the marker that says so — freeing localStorage for what must be there. Returns how many moved.
 */
export async function migrateHeldPositions(prefix = 'aegraph:explorer:positions:'): Promise<number> {
  if (!hasIdb()) return 0
  let moved = 0
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) keys.push(k)
    }
  } catch {
    return 0
  }
  for (const key of keys) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      continue
    }
    if (!raw) continue
    const got = readHeldPositionsSync(raw)
    if (!got || !('positions' in got)) continue // a marker already, or unreadable
    const n = Object.keys(got.positions).length
    if (n <= LOCAL_CAP) continue
    try {
      localStorage.removeItem(key)
      await put(key, got.positions, n)
      moved++
    } catch {
      /* leave it: it is readable where it is */
    }
  }
  return moved
}

/** The keys an explorer session writes under its own id (`<prefix><session>`). */
export const SESSION_PREFIXES = ['aegraph:explorer:v1:', 'aegraph:explorer:positions:v1:', 'aegraph:explorer:detail-tabs:'] as const

/**
 * Before anything renders: the keys of explorer sessions nothing refers to any more. A session is one Unigraph
 * tab, and its filter, positions and detail tabs were kept under its id for good — close the tab and they stayed,
 * so storage grew with every tab ever opened. A session is kept while its id appears in anything else stored —
 * the workstation's tabs, a project's stashed screen, a pick — which is conservative by design: a stray match keeps
 * a key, it never loses one; `extraRefs` adds what the Library holds (a saved workstation's tabs). Run at boot, after
 * the Library is read and before any page mounts, so no tab opened in this visit is judged.
 * Returns the positions keys removed, whose IndexedDB records `sweepExplorerSessionData` then deletes.
 */
export function sweepExplorerSessions(storage: Storage = localStorage, others: Storage[] = typeof sessionStorage === 'undefined' ? [] : [sessionStorage], extraRefs = ''): string[] {
  const own: { key: string; session: string }[] = []
  let refs = extraRefs
  try {
    for (const s of [storage, ...others])
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)
        if (!k) continue
        const prefix = s === storage ? SESSION_PREFIXES.find((p) => k.startsWith(p)) : undefined
        const session = prefix ? k.slice(prefix.length) : ''
        if (prefix && session && !session.includes(':')) own.push({ key: k, session })
        else refs += `${k}\n${s.getItem(k) ?? ''}\n`
      }
  } catch {
    return []
  }
  const removed: string[] = []
  for (const { key, session } of own) {
    if (refs.includes(session)) continue
    try {
      storage.removeItem(key)
      if (key.startsWith('aegraph:explorer:positions:v1:')) removed.push(key)
    } catch {
      /* leave it */
    }
  }
  return removed
}

/**
 * The IndexedDB half: position sets whose key is gone from localStorage — a swept session's, or one whose marker
 * was removed without its record. Every big set has its marker there, so a record without one is unreachable.
 */
export async function sweepExplorerSessionData(): Promise<number> {
  if (!hasIdb()) return 0
  const db = await open()
  const keys = await new Promise<string[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String))
    req.onerror = () => reject(req.error)
  })
  const orphans = [...new Set(keys.map((k) => (k.endsWith('::ids') ? k.slice(0, -'::ids'.length) : k)))].filter((k) => localStorage.getItem(k) === null)
  for (const k of orphans) await remove(k).catch(() => undefined)
  return orphans.length
}

/**
 * Pictures of scenes this browser has actually drawn.
 *
 * A scene's card should show the scene as it opens: the camera it was saved
 * with, the renderer it was saved on, its colours and sizes and depth. A
 * picture drawn from the layout's numbers cannot be that — it is a top-down
 * scatter of x and y, with no camera, no style and no third dimension — so
 * the only faithful preview is the engine's own frame.
 *
 * A scene saved in the app carries one (`data.preview`). A scene made
 * elsewhere — a demo bundle, the headless engine, a generator — has none, and
 * the first time it is opened here the view captures what it drew and keeps it
 * *here*, not on the entity: writing to the entity would make opening a scene
 * an unsaved change in the project, and a picture of a view is not a change to
 * the project. So it lives in its own IndexedDB database, keyed by the scene
 * and the moment it last changed, and is thrown away when the scene moves on.
 */

const DB = 'aegraph-previews'
const STORE = 'scenes'
const MAX = 300

export const previewKey = (id: string, updatedAt: string) => `${id}@${updatedAt}`

/** Where the pictures are kept. IndexedDB in the app; a Map in the tests (`usePreviewStore`). */
export interface PreviewStore {
  get(key: string): Promise<string | null>
  put(key: string, dataUrl: string): Promise<void>
}

/** A store held in memory — the test seam, and what a browser without IndexedDB falls back to. */
export function memoryPreviewStore(max = MAX): PreviewStore {
  const m = new Map<string, string>()
  return {
    get: async (key) => m.get(key) ?? null,
    put: async (key, url) => {
      m.set(key, url)
      // Keys carry the scene's timestamp, so the oldest sort first.
      if (m.size > max) for (const k of [...m.keys()].sort().slice(0, m.size - max)) m.delete(k)
    },
  }
}

let store: PreviewStore | null = null
/** Test seam: keep the pictures somewhere else. */
export function usePreviewStore(s: PreviewStore | null) {
  store = s
}
const backing = (): PreviewStore => store ?? (store = typeof indexedDB === 'undefined' ? memoryPreviewStore() : idbStore())

/**
 * One connection for the page, opened on first use. Every card reads its picture on mount and again whenever one
 * lands, and a connection opened per read stayed open until the collector found it — dozens at a time on a page of
 * cards. A failed open is not remembered, so the next read tries again.
 */
let db: Promise<IDBDatabase | null> | null = null
function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return (db ??= new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => {
      const conn = req.result
      // Another tab upgrading the database: step aside, and open afresh on the next read.
      conn.onversionchange = () => {
        conn.close()
        db = null
      }
      // Closed under us (the site's data cleared): the next read opens afresh.
      conn.onclose = () => {
        db = null
      }
      resolve(conn)
    }
    req.onerror = () => {
      db = null
      resolve(null)
    }
  }))
}

/** IndexedDB, dropping the oldest keys once there are more than MAX. */
function idbStore(): PreviewStore {
  return {
    get: async (key) => {
      const db = await open()
      if (!db) return null
      return new Promise((resolve) => {
        const req = db.transaction(STORE).objectStore(STORE).get(key)
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
        req.onerror = () => resolve(null)
      })
    },
    put: async (key, dataUrl) => {
      const db = await open()
      if (!db) return
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        const os = tx.objectStore(STORE)
        os.put(dataUrl, key)
        const count = os.count()
        count.onsuccess = () => {
          if (count.result <= MAX) return
          const keys = os.getAllKeys()
          keys.onsuccess = () => {
            const all = keys.result as IDBValidKey[]
            for (const k of all.slice(0, all.length - MAX)) os.delete(k)
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      })
    },
  }
}

/** What this browser has drawn for that scene at that version, if anything. */
export const readPreview = (key: string): Promise<string | null> => backing().get(key)

/** Keep a picture, and tell the cards so a sketch becomes the real thing. */
export async function writePreview(key: string, dataUrl: string): Promise<void> {
  await backing().put(key, dataUrl)
  listeners.forEach((l) => l())
}

const listeners = new Set<() => void>()
/** Re-render the cards when a picture arrives. */
export function onPreviewCached(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * Clearing this browser: everything aegraph keeps here — every IndexedDB database of the origin (the Library, project
 * history, held graph positions, previews, settings), localStorage (chats, page state, the bridge, the keys),
 * sessionStorage and Cache Storage — so the next load is a first visit, as a new user sees it. The This browser
 * page (`/browser`) and the `account` tool (`reset_browser`) ask for it.
 *
 * It is done in two steps, across a reload. `requestBrowserReset` only leaves a note in sessionStorage and reloads;
 * `finishBrowserReset` runs at the top of the next load (`main.tsx`), before the app has opened a database or started
 * anything that writes. Wiping from inside the running app instead loses to the app itself: its open connections
 * block the deletes, and its unload handlers (autosave, the chats list, the memory watch) write state straight back.
 * The note is in sessionStorage — this tab's, unreachable from a link — so nothing but this origin's own page can ask.
 *
 * Stashes (`stash.ts`, the `aegraph-stash` database) are never cleared: they are how the state cleared here comes back.
 */

const NOTE = 'aegraph:reset-browser'

/** The IndexedDB databases the app opens: deleted by name where the browser cannot list them (`indexedDB.databases`). */
const KNOWN_DATABASES = ['aegraph', 'aegraph-history', 'aegraph-settings', 'aegraph-previews', 'aegraph-explorer']

/** Where stashes of this browser are kept (`stash.ts`): the one database clearing leaves alone. */
export const STASH_DB = 'aegraph-stash'

export interface ResetOptions {
  /** Databases to leave alone, besides the stashes (a restore keeps nothing else either). */
  keepDatabases?: string[]
  /** localStorage keys to keep (a stash restore's own note, so a restore cut short is taken up again). */
  keepKeys?: string[]
  /**
   * Stop at a database that will not go, with nothing else cleared after it, rather than pass over it: a stash restore
   * must not lay the stash over what was left. By default a reset reports it and carries on.
   */
  strict?: boolean
}

/** Clear this browser on the next load, and reload now. */
export function requestBrowserReset(options: ResetOptions = {}, reload: () => void = () => location.reload()) {
  sessionStorage.setItem(NOTE, JSON.stringify(options))
  reload()
}

/** Whether this load was asked to clear the browser (see `requestBrowserReset`). */
export function browserResetPending(): ResetOptions | null {
  try {
    const raw = sessionStorage.getItem(NOTE)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ResetOptions) : {}
  } catch {
    return null
  }
}

/** Every IndexedDB database of the origin: those the browser lists, and the app's own by name where it cannot. */
export async function browserDatabases(): Promise<string[]> {
  try {
    const listed = (await indexedDB.databases?.())?.map((d) => d.name).filter((n): n is string => !!n)
    if (listed) return [...new Set([...listed, ...KNOWN_DATABASES])]
  } catch {
    /* no listing: the known names */
  }
  return KNOWN_DATABASES
}

/** Delete one database; `onBlocked` is told when another tab's open connection holds it (the delete waits for it). */
function deleteDatabase(name: string, onBlocked: () => void, strict = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    // A database that will not go is passed over — the rest of the reset still happens — unless the caller is about
    // to write into its place.
    req.onerror = () => (strict ? reject(new Error(`${name} could not be deleted: ${req.error?.message ?? 'unknown error'}`)) : resolve())
    req.onblocked = onBlocked
  })
}

/**
 * Clear everything and return what was deleted. `onBlocked` is told when another aegraph tab keeps a database open:
 * the delete finishes once that tab closes or reloads.
 */
export async function clearBrowser(options: ResetOptions = {}, onBlocked: () => void = () => {}): Promise<{ databases: string[] }> {
  const keep = new Set([STASH_DB, ...(options.keepDatabases ?? [])])
  const names = (await browserDatabases()).filter((n) => !keep.has(n))
  await Promise.all(names.map((n) => deleteDatabase(n, onBlocked, options.strict)))
  try {
    const kept: [string, string][] = []
    const keepKeys = new Set(options.keepKeys ?? [])
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && keepKeys.has(k)) kept.push([k, localStorage.getItem(k) ?? ''])
    }
    localStorage.clear()
    for (const [k, v] of kept) localStorage.setItem(k, v)
  } catch {
    /* no storage */
  }
  try {
    sessionStorage.clear()
  } catch {
    /* no storage */
  }
  try {
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) await caches.delete(k)
  } catch {
    /* no Cache Storage */
  }
  return { databases: names }
}

/**
 * The second step, at the top of `main.tsx`: clear everything, then load the app's front page as a first visit. Says
 * on the page what it is doing, and what it waits for when another tab holds a database open.
 */
export async function finishBrowserReset(options: ResetOptions) {
  const root = document.getElementById('root')
  const say = (text: string) => {
    if (root) root.innerHTML = `<p style="font: 14px system-ui, sans-serif; padding: 48px; text-align: center; color: #666">${text}</p>`
  }
  say('Clearing this browser…')
  await clearBrowser(options, () => say('Clearing this browser… another aegraph tab is still open — close it (or reload it) to finish.'))
  location.replace('/')
}

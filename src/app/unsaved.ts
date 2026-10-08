/**
 * Changes still on their way to this browser's storage, as the page's own reloads and the browser's unload see them.
 * The store's writes are queued (`core/entity/persistence.ts`): a reload in the middle loses what had not landed, and a
 * write that failed stays in memory only until it is tried again. So the reloads the app makes itself (a deploy's
 * missing chunk) wait for them, and one the app does not make — the reload button, the tab closed, a dev server
 * reloading the page after a change to its files — is asked about first, while there is something to lose.
 */

interface Writes {
  getStatus(): { state: string; pending: number; unsaved?: number; error?: string }
  flush(): Promise<void>
}

let writes: Writes | null = null

/** Where the store's writes stand — `idle`, `saving`, or `error` with the reason and how many wait — or null with none attached. */
export function saveStatus(): ReturnType<Writes['getStatus']> | null {
  return writes?.getStatus() ?? null
}

/**
 * Other things that can hold work this browser has not kept, each answering "is there some now?". One is the store
 * itself when the workspace could not be read at the start (`unpersistedStore`): the app runs, and nothing written to
 * it is saved — the database was never attached, so the writes' status above stays idle and would say all is well.
 */
const others = new Set<() => boolean>()

/** Counts `dirty` among the unsaved work until the returned function is called. */
export function addUnsavedSource(dirty: () => boolean): () => void {
  others.add(dirty)
  return () => void others.delete(dirty)
}

/**
 * The store the app runs on when the workspace could not be loaded: nothing written to it reaches this browser's
 * storage, so from the first write on, leaving the page asks first (and the app's own reload for a new version stays
 * its hand). Returns the function that stops counting it.
 */
export function unpersistedStore(store: { readonly version: number }): () => void {
  const at = store.version
  return addUnsavedSource(() => store.version !== at)
}

/** True while a change has not reached this browser's storage: queued, being written, or failed and waiting. */
export function hasUnsaved(w: Writes | null = writes): boolean {
  for (const dirty of others) if (dirty()) return true
  if (!w) return false
  const s = w.getStatus()
  return s.pending > 0 || s.state === 'error' || (s.unsaved ?? 0) > 0
}

/**
 * Whether the database `name` is in this browser, from `indexedDB.databases()`: null when the browser cannot say (no
 * listing, or it failed). Asked when the workspace could not be read, before putting anything in its place — a start
 * that cannot read a database it has must not treat it as a first visit.
 */
export async function databaseExists(name: string, factory: { databases?: () => Promise<{ name?: string }[]> } | undefined = globalThis.indexedDB): Promise<boolean | null> {
  try {
    if (!factory?.databases) return null
    return (await factory.databases()).some((d) => d.name === name)
  } catch {
    return null
  }
}

/** Asks before the page unloads with changes unsaved; returns the function that stops asking. */
export function guardUnsaved(w: Writes): () => void {
  writes = w
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!hasUnsaved(w)) return
    e.preventDefault()
    // The browser shows its own words ("Changes you made may not be saved"); older ones want the property set.
    e.returnValue = ''
  }
  addEventListener('beforeunload', onBeforeUnload)
  return () => {
    removeEventListener('beforeunload', onBeforeUnload)
    if (writes === w) writes = null
  }
}

/** Resolves once the queued writes have landed (or failed), or after `ms` — a reload is not held up for ever. */
export function whenSaved(ms = 10_000): Promise<void> {
  if (!writes || !hasUnsaved(writes)) return Promise.resolve()
  return Promise.race([writes.flush().catch(() => undefined), new Promise<void>((r) => setTimeout(r, ms))])
}

import { createElement, lazy, useState, type ComponentType } from 'react'
import { hasUnsaved, whenSaved } from './unsaved'

/**
 * Code the app loads on demand, loaded ahead of time. A page's chunks are
 * fetched while the workspace is read from IndexedDB — behind the one boot
 * screen — so a refresh shows that screen and then the page, not a
 * "Loading…" for the route and another for the renderer inside it.
 *
 * `chunk(loader)` wraps a dynamic import so it can be started early and
 * read synchronously once it has arrived; `preloaded(chunk, pick)` is the
 * component: rendered straight from the module when it is already here,
 * through React's lazy (and a Suspense fallback) only when it is not —
 * navigation to a page nobody preloaded still works, it just shows the
 * fallback. `preloadFor(pathname)` starts what the address will need.
 */
export interface Chunk<M> {
  load: () => Promise<M>
  peek: () => M | undefined
}

export function chunk<M>(loader: () => Promise<M>): Chunk<M> {
  let mod: M | undefined
  let pending: Promise<M> | undefined
  return {
    load: () =>
      (pending ??= loader().then(
        (m) => (mod = m),
        (err) => {
          // A failed import is not remembered: the next attempt fetches again. Caching the rejection left every view
          // that needed this chunk broken for the life of the page — and the usual cause is not a broken chunk but an
          // old one: a deploy replaced the files under an open tab, so the name this page is asking for is gone.
          pending = undefined
          if (isStaleChunk(err)) reloadForNewVersion()
          throw err
        },
      )),
    peek: () => mod,
  }
}

/** A dynamic import that failed because the file is no longer there — the page is running a version the server has replaced. */
export function isStaleChunk(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(m)
}

const RELOADED_KEY = 'aegraph:reloaded-for-version'

/**
 * Pick up the deployed version. A page open across a deploy asks for chunk names that no longer exist, and every
 * view that has not been loaded yet fails — a reload is the only way back. It waits for the changes still on their
 * way to this browser's storage (`whenSaved`), so it costs nothing the app has not persisted; a write that failed and
 * is waiting to be tried again is not left to a reload at all — the page stays, and says so. Once per page, and never
 * twice within a minute, so a chunk that fails for any other reason cannot put the tab in a reload loop; after that
 * the view says what happened and offers the button.
 */
export function reloadForNewVersion(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()))
  } catch {
    return // no sessionStorage to remember it by: better to leave the page alone than to risk a loop
  }
  void whenSaved().then(() => {
    if (!hasUnsaved()) location.reload()
  })
}

export function preloaded<M, P extends object>(c: Chunk<M>, pick: (m: M) => ComponentType<P>): ComponentType<P> {
  const Lazy = lazy(() => c.load().then((m) => ({ default: pick(m) })))
  return function Preloaded(props: P) {
    // Decided once per mount: a component that began through lazy stays there, so the view is not remounted the moment
    // the module lands (the two are different component types to React).
    const [sync] = useState(() => !!c.peek())
    const m = sync ? c.peek() : undefined
    return createElement(m ? pick(m) : Lazy, props)
  }
}

/** The chunks each page needs, by the start of its address; the renderer chunks by the explorer's mode. */
const routes: { match: (path: string) => boolean; chunks: () => Chunk<unknown>[] }[] = []

export function registerPreload(match: (path: string) => boolean, chunks: () => Chunk<unknown>[]) {
  routes.push({ match, chunks })
}

/**
 * Everything the page at `pathname` renders on arrival. A chunk may register chunks of its own once it is evaluated
 * (the explorer registers its renderers), so this goes round until a round finds nothing new. Resolves when it is all
 * here, or failed — a failure is the page's to report when it renders.
 */
export async function preloadFor(pathname: string): Promise<void> {
  const seen = new Set<Chunk<unknown>>()
  for (;;) {
    const wanted = routes.filter((r) => r.match(pathname)).flatMap((r) => r.chunks()).filter((c) => !seen.has(c))
    if (!wanted.length) return
    wanted.forEach((c) => seen.add(c))
    await Promise.all(wanted.map((c) => c.load().catch(() => undefined)))
  }
}

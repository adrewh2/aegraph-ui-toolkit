import { useSyncExternalStore } from 'react'
import type { Chats } from './chats'
import type { AssistantSession } from './session'
import type { AppHost } from './tools'

/**
 * The chats, reachable without the panel. The chats module (with the
 * session, the API SDK and every tool behind it) stays off the entry chunk:
 * it loads the first time something needs a chat — the panel opening, or a
 * voice command arriving. Whoever holds a live app host (the always-mounted
 * VoiceControl, the panel) registers it here, so a chat started headless
 * still has the store and the router.
 */

type Host = Omit<AppHost, 'confirm'>

/** Where the open chats' ids are kept (`chats.ts` writes it); read here so the sidebar can count them unloaded. */
export const CHATS_LIST_KEY = 'aegraph:ai:chats'

let host: Host | null = null
let loading: Promise<Chats> | null = null
let loaded: Chats | null = null

/** The host to run tools against; the newest wins, and loaded chats get it at once. */
export function provideAppHost(h: Host) {
  host = h
  loaded?.attachHost(h)
}

/** Load (once) and return the chats, attached to the current host. */
export function loadChats(): Promise<Chats> {
  loading ??= import('./chats').then((m) => {
    loaded = m.chats
    if (host) loaded.attachHost(host)
    return loaded
  })
  return loading
}

/** The chat in front, loading the chats if need be. */
export function loadAssistant(): Promise<AssistantSession> {
  return loadChats().then((c) => c.active())
}

const onLoad = new Set<() => void>()
let storedIds: string | undefined
/** The chats as soon as their module has run, however it was reached — the Chats page imports it directly. */
let known: Pick<Chats, 'ids' | 'subscribe'> | null = null

/**
 * Called by `chats.ts` as its module runs (and again after a hot update), so the open chats' readers follow the live
 * list — and the chats get the app host however their module was reached: the `chat` tool and the Chats page import
 * it directly, and a registry without a host follows no project and records nothing.
 */
export function announceChats(c: Pick<Chats, 'ids' | 'subscribe'> & Partial<Pick<Chats, 'attachHost'>>) {
  known = c
  if (c.attachHost) {
    loaded = c as Chats
    if (host) c.attachHost(host)
  }
  onLoad.forEach((l) => l())
}

/**
 * The open chats' ids with their projects — `id<tab>project` (empty: the Library), one per line, blank chats left out — a string, so a reader re-renders only when the set of open chats changes, not
 * when one of them streams, renames or goes busy. Before the chats are loaded (the panel never opened, never on
 * /chats) the list is read once from storage, where they will load from; loading them is never triggered from here.
 */
export function openChatIds(): string {
  if (known) return known.ids().join('\n')
  if (storedIds === undefined) {
    try {
      const list = JSON.parse(localStorage.getItem(CHATS_LIST_KEY) ?? 'null') as { ids?: unknown; blank?: unknown; projects?: Record<string, unknown> } | null
      // A blank chat (nothing typed in it) is not counted, as `Chats.ids` leaves it out.
      const blank = new Set(Array.isArray(list?.blank) ? list.blank : [])
      const ids = Array.isArray(list?.ids) ? list.ids.filter((x) => !blank.has(x)) : undefined
      const project = (id: string) => (typeof list?.projects?.[id] === 'string' ? (list.projects[id] as string) : '')
      storedIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string').map((id) => `${id}\t${project(id)}`).join('\n') : ''
    } catch {
      storedIds = ''
    }
  }
  return storedIds
}

/** Told when the open chats change: the list itself once loaded, and the load. */
export function subscribeOpenChats(cb: () => void): () => void {
  let off = known?.subscribe(cb)
  const load = () => {
    off?.()
    off = known?.subscribe(cb)
    cb()
  }
  onLoad.add(load)
  return () => {
    onLoad.delete(load)
    off?.()
  }
}

/** The open chats' ids as a hook (see `openChatIds`). */
export function useOpenChatIds(): string {
  return useSyncExternalStore(subscribeOpenChats, openChatIds, openChatIds)
}

/** The chats if they have been loaded, without loading them. */
export function loadedChats(): Chats | null {
  return loaded
}

// A hot update of the chats module gives the panel new instances; forget the old ones so voice follows.
if (import.meta.hot) import.meta.hot.dispose(() => {
  loading = null
  loaded = null
  storedIds = undefined
})

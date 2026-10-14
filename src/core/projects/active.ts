import type { EntityStore } from '../entity/store'
import type { EntityId } from '../entity/types'
import { isProjectEntity } from './project'

/**
 * The active project, remembered across reloads, and the UI state that
 * travels with it.
 *
 * Pages keep their working state in localStorage under fixed keys (the
 * explorer's filter/layout/positions/camera, the workstation arrangement,
 * the Scenes page's last scene, the plot draft). That state is about *this
 * project's* data, so switching projects swaps it: the outgoing project's
 * values are stashed under its id, the incoming project's are put back
 * under the fixed keys, and the app remounts so every page re-reads them.
 * Two projects therefore feel like two windows; the keys themselves — and
 * the pages that own them — don't change.
 */
const ACTIVE_KEY = 'aegraph:project'
/**
 * Where a scope's UI state is stashed. A project's key has a prefix of its own, so no project id — a bundle chooses
 * its own — can name the Library's. `legacyKey` is where the state was kept before; it is read once and moved.
 */
const stashKey = (id: EntityId | null) => (id === null ? 'aegraph:ui:library' : `aegraph:ui:p:${id}`)
const legacyKey = (id: EntityId) => `aegraph:ui:${id}`
/** How much one scope's stashed UI state may hold, in characters: the stash shares localStorage with everything else. */
export const MAX_STASH_CHARS = 2_000_000

/** The per-project UI state, by storage key. Order matters when space runs out: the last ones are dropped first. */
export const PROJECT_UI_KEYS = [
  'aegraph:workstation:v1',
  'aegraph:entities:v1',
  'aegraph:unigraph:v1',
  'aegraph:charts:v1',
  'aegraph:scripts:v1',
  'aegraph:datasets:v1',
  'aegraph:documents:v1',
  'aegraph:diagrams:v1',
  'aegraph:images:v1',
  'aegraph:videos:v1',
  'aegraph:audio:v1',
  'aegraph:maps:v1',
  'aegraph:scenes:v1',
  'aegraph:ontology:v1',
  'aegraph:projects:v1',
  'aegraph:analytics:v1',
  'aegraph:graph:v1',
  'aegraph:display:last',
  'aegraph:plots:draft',
  'aegraph:explorer:v1',
  'aegraph:explorer:camera',
  'aegraph:explorer:positions:v1',
] as const

const ls = () => (typeof localStorage !== 'undefined' ? localStorage : undefined)

export function getActiveProjectId(): EntityId | null {
  return ls()?.getItem(ACTIVE_KEY) || null
}

/** The current values of the project-scoped UI keys. */
export function readUiState(): Record<string, string> {
  const out: Record<string, string> = {}
  const s = ls()
  if (!s) return out
  for (const k of PROJECT_UI_KEYS) {
    const v = s.getItem(k)
    if (v !== null) out[k] = v
  }
  return out
}

/** Replace the live UI state (keys not mentioned are cleared). */
export function writeUiState(state: Record<string, string>) {
  const s = ls()
  if (!s) return
  for (const k of PROJECT_UI_KEYS) {
    const v = state[k]
    if (v === undefined) s.removeItem(k)
    else safeSet(s, k, v)
  }
}

/**
 * Remember a project's UI state for when it is next opened (e.g. from an imported bundle). Only the keys in
 * `PROJECT_UI_KEYS` with string values are kept — the state may come from a file — and at most `MAX_STASH_CHARS`.
 */
export function stashUiState(project: EntityId | null, state: Record<string, string>) {
  const s = ls()
  if (!s) return
  const copy: Record<string, string> = {}
  if (state && typeof state === 'object') for (const k of PROJECT_UI_KEYS) if (Object.hasOwn(state, k) && typeof state[k] === 'string') copy[k] = state[k]
  // Positions can be large; past the cap, or when storage is full, drop from the end of PROJECT_UI_KEYS until it fits.
  let chars = 0
  for (const k in copy) chars += k.length + copy[k].length
  for (let drop = PROJECT_UI_KEYS.length; drop > 0 && chars > MAX_STASH_CHARS; drop--) {
    const k = PROJECT_UI_KEYS[drop - 1]
    if (copy[k] !== undefined) chars -= k.length + copy[k].length
    delete copy[k]
  }
  for (let drop = PROJECT_UI_KEYS.length; drop >= 0; drop--) {
    try {
      s.setItem(stashKey(project), JSON.stringify(copy))
      return
    } catch {
      const k = PROJECT_UI_KEYS[drop - 1]
      if (!k) return
      delete copy[k]
    }
  }
}

export function readStashedUiState(project: EntityId | null): Record<string, string> {
  try {
    const s = ls()
    let raw = s?.getItem(stashKey(project))
    // Stashed before projects had a prefix of their own: moved over (a project named `library` shared the Library's key, and keeps nothing).
    if (raw == null && project !== null && project !== 'library' && s) {
      raw = s.getItem(legacyKey(project))
      if (raw != null) {
        s.removeItem(legacyKey(project))
        safeSet(s, stashKey(project), raw)
      }
    }
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function clearStashedUiState(project: EntityId) {
  ls()?.removeItem(stashKey(project))
  if (project !== 'library') ls()?.removeItem(legacyKey(project))
}

function safeSet(s: Storage, k: string, v: string) {
  try {
    s.setItem(k, v)
  } catch {
    /* quota — the page starts fresh for this key */
  }
}

// ── Switching ──────────────────────────────────────────────────────────

type Listener = () => void
const listeners = new Set<Listener>()
let epoch = 0

/** Bumps whenever the active project changes; the app remounts on it. */
export const projectEpoch = {
  get: () => epoch,
  subscribe(l: Listener) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}

/**
 * Make a project (or the Library, `null`) active: stash the outgoing UI
 * state, restore the incoming, scope the store, remount. Returns false if
 * the id isn't a project, or if its scope cannot be read (the Library is then open).
 *
 * `screen`: the project's stashed screen is put in place even when it is the project already open — a bundle of it
 * just opened over it changed what it holds, so the screen comes from the file too: its workstation with fresh tabs,
 * each scene loaded anew. Without it, a tab kept from before held its own copy of a scene's filter, layout and style,
 * and went on drawing the old version over the new data.
 */
export function switchProject(store: EntityStore, id: EntityId | null, opts: { route?: string; screen?: boolean } = {}): boolean {
  if (id && !isProjectEntity(store.get(id))) return false
  const from = store.scope
  const home = id ? (store.get(id)?.data.home as { route?: string } | undefined)?.route : undefined
  if (from === id && opts.screen) {
    // The project you are in, its screen taken afresh: the stashed state replaces this one, and the app remounts on it.
    writeUiState(readStashedUiState(id))
    go(opts.route ?? home)
    epoch++
    for (const l of listeners) l()
    return true
  }
  if (from === id) {
    // Same scope: no remount, so let the router see the change. Opening the project you are in still takes you to
    // its home — that is what opening means — unless the caller says where.
    if (go(opts.route ?? home)) dispatchEvent(new PopStateEvent('popstate'))
    return true
  }
  stashUiState(from, readUiState())
  // Scoped first and remembered only once its scope reads: a project that cannot be read must not become the one
  // every load opens on. Such a project leaves the Library open instead.
  store.setScope(id)
  const opened = !id || scopeReads(store)
  if (!opened) {
    console.warn(`[aegraph] project ${id} could not be opened; the Library is open instead.`)
    id = null
    store.setScope(null)
  }
  writeUiState(readStashedUiState(id))
  const s = ls()
  if (s) {
    if (id) s.setItem(ACTIVE_KEY, id)
    else s.removeItem(ACTIVE_KEY)
  }
  // The app remounts (router included) on the epoch, so the URL is set directly: the new tree reads it.
  if (opened) go(opts.route ?? home)
  epoch++
  for (const l of listeners) l()
  return opened
}

function go(route: string | undefined): boolean {
  if (!route || typeof history === 'undefined' || typeof location === 'undefined' || location.pathname + location.search === route) return false
  history.pushState(null, '', route)
  return true
}

/** On startup: scope the store to the remembered project, if it still exists. */
export function restoreActiveProject(store: EntityStore) {
  const id = getActiveProjectId()
  if (id && isProjectEntity(store.get(id))) {
    store.setScope(id)
    if (scopeReads(store)) return
    console.warn(`[aegraph] project ${id} could not be opened; the Library is open instead.`)
    store.setScope(null)
  }
  if (id) ls()?.removeItem(ACTIVE_KEY)
}

/** Whether the store can read the scope's project: its marks and what it includes. */
function scopeReads(store: EntityStore): boolean {
  try {
    if (store.scope) store.scopeOf(store.scope)
    return true
  } catch {
    return false
  }
}

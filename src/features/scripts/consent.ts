import type { Language } from '../../scripting/types'

/**
 * Which scripts may run without being asked. A script is code, and a script
 * in a bundle, an import or a template is someone else's code: the pages
 * that run a script on arrival — the inspector's "run on open", the Scripts
 * page re-running a script after a reload, `?run=1` — run only code this
 * browser has seen its owner run (or save) here.
 *
 * Consent is the script's id **and** a hash of its code, kept in this
 * browser's storage and nowhere a bundle can reach (the per-project UI keys a
 * bundle restores are a fixed list that does not include it): a bundle cannot
 * ship it, cannot claim it through `meta.source` (copied from the file), and
 * an import that rewrites a script the owner ran gets no consent for the new
 * code. A Visual script never runs on arrival at all — its frame has a DOM
 * and a network stack the Content-Security-Policy does not fully govern.
 *
 * A run that never came back — the tab hung or died mid-run — leaves its
 * marker in sessionStorage; the next load sees it and does not run that
 * script again by itself, so a script that hangs cannot hang every reload.
 */

const KEY = 'aegraph:scripts:consent:v1'
const RUNNING_KEY = 'aegraph:scripts:running'
/** The most recent consents kept; the oldest go first. */
const MAX = 2000

/** 53 bits of hash; two with different seeds make the key collision-resistant enough that nobody will match a script they cannot see. */
function cyrb53(s: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
export const codeHash = (code: string): string => `${cyrb53(code, 1)}.${cyrb53(code, 0x9e3779b9)}.${code.length}`
const entry = (id: string, code: string) => `${id}\u0000${codeHash(code)}`

const ls = (): Storage | undefined => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined
  }
}
const ss = (): Storage | undefined => {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined
  } catch {
    return undefined
  }
}

function read(): string[] {
  try {
    const v = JSON.parse(ls()?.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Whether this browser's owner ran (or saved) exactly this code under this id here. */
export function hasConsent(id: string, code: string): boolean {
  return read().includes(entry(id, code))
}

/** The owner ran or saved this code: it may run again on its own (a reload, the inspector). */
export function recordConsent(id: string, code: string): void {
  const e = entry(id, code)
  const all = read().filter((x) => x !== e)
  all.push(e)
  try {
    ls()?.setItem(KEY, JSON.stringify(all.slice(-MAX)))
  } catch {
    /* no storage: nothing runs on its own, which is the safe way to fail */
  }
}

function running(): string[] {
  try {
    const v = JSON.parse(ss()?.getItem(RUNNING_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const writeRunning = (ids: string[]) => {
  try {
    if (ids.length) ss()?.setItem(RUNNING_KEY, JSON.stringify(ids))
    else ss()?.removeItem(RUNNING_KEY)
  } catch {
    /* no storage */
  }
}
/** Set before a run starts; cleared when it ends, however it ends. */
export const markRunning = (id: string) => writeRunning([...running().filter((x) => x !== id), id])
export const clearRunning = (id: string) => writeRunning(running().filter((x) => x !== id))
/** A run of this script started in this tab and never finished: the page was reloaded (or died) under it. */
export const wasRunning = (id: string) => running().includes(id)

/** Why a script will not run on arrival, or null when it may. */
export function autorunRefusal(id: string, code: string, language: Language | undefined): string | null {
  if (language === 'view') return 'A Visual script runs only when you press Run.'
  if (wasRunning(id)) return 'Its last run did not finish (the page was reloaded or closed under it): press Run to run it again.'
  if (!hasConsent(id, code)) return 'Not run here yet — press Run. A script from an import, a template or another browser runs only when you ask.'
  return null
}

/** Run `fn` with the running marker held for `id`, cleared when it settles. */
export async function withRunningMarker<T>(id: string, fn: () => Promise<T>): Promise<T> {
  markRunning(id)
  try {
    return await fn()
  } finally {
    clearRunning(id)
  }
}

import { useSyncExternalStore } from 'react'

/**
 * The user's own settings — what the settings menu at the foot of the sidebar keeps, apart from the assistant's
 * connection (`src/core/ai/settings.ts`). They are this browser's, in localStorage.
 */
export interface UserSettings {
  /** Shows the tools for working on aegraph itself: the GPU view's Benchmark menu. */
  developerTools: boolean
  /**
   * Whether the app may call anyone but this machine and its own site: map tiles, place search,
   * Wikipedia, the embedding model, the media embeds. On — turning it off is offline mode.
   */
  externalServices: boolean
}

const KEY = 'aegraph:account:settings'
const DEFAULTS: UserSettings = { developerTools: false, externalServices: true }

let current: UserSettings = load()
const listeners = new Set<() => void>()

function load(): UserSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<UserSettings>
    // A setting this browser has never seen takes the default: a new switch does not silently turn something off.
    return { developerTools: parsed.developerTools === true, externalServices: parsed.externalServices !== false }
  } catch {
    return DEFAULTS
  }
}

export const getUserSettings = () => current

export function setUserSettings(patch: Partial<UserSettings>): UserSettings {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
  return current
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function useUserSettings(): UserSettings {
  return useSyncExternalStore(subscribe, getUserSettings, getUserSettings)
}

/**
 * Offline mode: the one switch over everything that leaves this machine.
 *
 * With **Third-party services** off, nothing in the app calls anyone but this machine and the site
 * it was served from — no map tiles, no place search, no Wikipedia, no embedding model, no YouTube
 * or Spotify embed, no linked-data endpoint. The assistant is not covered: it reaches the Claude API
 * only with a key the user entered, or Claude Code on this machine, as the assistant settings say (`/docs/privacy`).
 *
 * A feature that needs the network asks `externalServicesAllowed()` before its first request and
 * says so in the view, or throws `OfflineError` where a caller (a tool, a page) will report it.
 */
export const externalServicesAllowed = () => current.externalServices

/** What a feature that needs the network throws while offline mode is on; the message names the feature and the way back. */
export class OfflineError extends Error {
  constructor(what: string) {
    super(`${what} needs a third-party service, and Third-party services is off in your account settings (the button at the foot of the sidebar).`)
    this.name = 'OfflineError'
  }
}

/** Throw unless the app may call out. `what` is the feature, as the user would name it ("Place search"). */
export function requireExternalServices(what: string): void {
  if (!current.externalServices) throw new OfflineError(what)
}

/** Whether the app may call out, re-rendering when that changes. */
export function useExternalServices(): boolean {
  return useSyncExternalStore(subscribe, externalServicesAllowed, externalServicesAllowed)
}

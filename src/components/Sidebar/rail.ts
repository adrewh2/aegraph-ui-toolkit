import { useSyncExternalStore } from 'react'

/**
 * Whether the sidebar is folded to its icon rail — one value for the page, remembered across reloads.
 *
 * It lives outside the Sidebar so other views can fold it: the explorer's Full view folds the sidebar with its own
 * side panel (`GraphExplorer.setFullView`), and ⌘B in the Sidebar toggles the same value. Nothing else on the page
 * follows it — the details panel and the assistant keep their own state.
 */
const RAIL_KEY = 'aegraph:sidebar:rail'

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1'
  } catch {
    return false
  }
}

let rail = readRail()
const listeners = new Set<() => void>()

export function isSidebarRail(): boolean {
  return rail
}

export function setSidebarRail(on: boolean): void {
  if (rail === on) return
  rail = on
  try {
    localStorage.setItem(RAIL_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

export function toggleSidebarRail(): void {
  setSidebarRail(!rail)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The rail state as React state: re-renders when anyone sets it. */
export function useSidebarRail(): boolean {
  return useSyncExternalStore(subscribe, isSidebarRail, isSidebarRail)
}

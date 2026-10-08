import { createContext, useContext, useRef, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * What a view rendered inside a pane may ask of its host: open a path as a
 * new tab beside this one. Outside any pane the same call is a plain
 * navigation, so views never need to know where they are mounted.
 */
export interface PaneHost {
  paneId: string
  openTab: (path: string, title?: string) => void
  /** Whether this tab is the one in front. A pane keeps recently shown tabs mounted (hidden), so a view can idle while it is behind. */
  active: boolean
  /** The name the user gave this tab (double-click on it), when they did: a view shows it in its own title. */
  title?: string
}

export const PaneContext = createContext<PaneHost | null>(null)

/** `open(path, title?)`: a new tab in the containing pane, or navigation when there is no pane. */
export function useOpenInTab(): (path: string, title?: string) => void {
  const host = useContext(PaneContext)
  const navigate = useNavigate()
  return host ? host.openTab : (path) => navigate(path)
}

export const usePaneHost = () => useContext(PaneContext)

/** The tab's own name, when the user gave it one — "Scripts — Q3 review" reads better than a row of tabs all called Scripts. */
export const usePaneTitle = (): string | undefined => useContext(PaneContext)?.title

/** Whether the view is on screen: pages and tabs behind the front one stay mounted (see KeptPages, the workstation's panes). */
export const ViewActiveContext = createContext(true)
export function useViewActive(): boolean {
  const host = useContext(PaneContext)
  const page = useContext(ViewActiveContext)
  return page && (host?.active ?? true)
}

/** The same, as a ref that is always current — for window-level listeners, which a view behind must sit out. */
export function useViewActiveRef(): RefObject<boolean> {
  const active = useViewActive()
  const ref = useRef(active)
  ref.current = active
  return ref
}

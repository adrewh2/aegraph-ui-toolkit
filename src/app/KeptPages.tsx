import { useEffect, useState, type ReactNode } from 'react'
import { parsePath, useLocation, useNavigate } from 'react-router-dom'
import { PaneRouter } from '../features/workstation/PaneRouter'
import { ViewActiveContext } from '../features/workstation/paneContext'
import { unloadsBehind } from './routes'

/**
 * The pages the sidebar switches between stay mounted behind the one on
 * screen — the last few, by section (`/graph`, `/entities`, `/documents`…)
 * — so coming back finds a page exactly as it was left: its selection, its
 * camera, the detail pane's tab, the rows ticked in a table, the scroll.
 * A page behind runs under its own frozen location, the way a workstation
 * tab does, so its hooks keep reading the URL it was left on rather than
 * the one in front. The page in front follows the address bar as before.
 * Unigraph is not kept (`unloadsBehind`): leaving it lets its engine go, and it comes back from what it saved.
 */
const KEPT = 3

/** The section a path belongs to: its first segment — two under `/analytics`, where Scripts, Datasets and Charts are each a page of their own. */
const sectionOf = (pathname: string) => {
  const [, first = '', second] = pathname.split('/')
  return first === 'analytics' && second ? `/${first}/${second}` : `/${first}`
}

export function KeptPages({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const here = `${location.pathname}${location.search}${location.hash}`
  const section = sectionOf(location.pathname)
  // Sections shown so far, least recent first, and the path each was last on.
  const [recent, setRecent] = useState<string[]>([])
  const [lastPath, setLastPath] = useState<Record<string, string>>({})
  useEffect(() => {
    setRecent((r) => (r[r.length - 1] === section ? r : [...r.filter((s) => s !== section), section].slice(-KEPT)))
    setLastPath((p) => (p[section] === here ? p : { ...p, [section]: here }))
  }, [section, here])
  const kept = [...recent.filter((s) => s !== section && !unloadsBehind(s)).slice(-(KEPT - 1)), section]
  // A page behind the one on screen still renders, and what it renders may navigate — a redirect route it sits on
  // (`/dashboard` → `/`, `/graph/…` → `/unigraph/…`), a pane host putting its tab's address back. Only the page in front
  // may move the browser: a hidden page's move stays on its own frozen address, and a move out of its section lets the
  // section go — otherwise its redirect would pull the browser back to it on every render, and the two would loop.
  const navigateFor = (s: string) => (path: string, replace: boolean) => {
    if (s === section) return navigate(path, { replace })
    if (sectionOf(parsePath(path).pathname || '/') === s) setLastPath((p) => (p[s] === path ? p : { ...p, [s]: path }))
    else setRecent((r) => r.filter((x) => x !== s))
  }
  const goFor = (s: string) => (delta: number) => {
    if (s === section) navigate(delta)
  }
  // A page coming to the front re-measures: the renderers size themselves on window resize.
  useEffect(() => {
    const raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(raf)
  }, [section])
  return (
    <>
      {kept.map((s) => {
        const active = s === section
        return (
          <div key={s} className="app-page" hidden={!active}>
            <PaneRouter path={active ? here : (lastPath[s] ?? s)} navKey={active ? location.key : undefined} onNavigate={navigateFor(s)} onGo={goFor(s)}>
              <ViewActiveContext.Provider value={active}>{children}</ViewActiveContext.Provider>
            </PaneRouter>
          </div>
        )
      })}
    </>
  )
}

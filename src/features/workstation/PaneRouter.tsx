import { useMemo, type ReactNode } from 'react'
import { createPath, parsePath, UNSAFE_LocationContext, UNSAFE_NavigationContext, UNSAFE_RouteContext, type Location, type To } from 'react-router-dom'

/**
 * A router scoped to one workstation tab. It supplies the same contexts a
 * <Router> would — location, navigator, and a fresh route context — so
 * every hook the views use (useParams, useNavigate, useSearchParams, Link)
 * works against the tab's own path instead of the browser URL. Navigation
 * is reported upward and stored on the tab, which keeps per-tab history.
 *
 * react-router refuses to nest <Router> elements; providing the contexts
 * directly sidesteps that guard for exactly this use.
 */
export function PaneRouter({ path, navKey, onNavigate, onGo, children }: { path: string; /** The navigation's own key, when there is one (the page in front): a second visit to the same address is still a visit. */ navKey?: string; onNavigate: (path: string, replace: boolean) => void; onGo: (delta: number) => void; children: ReactNode }) {
  const location = useMemo<Location>(() => {
    const p = parsePath(path)
    return { pathname: p.pathname || '/', search: p.search || '', hash: p.hash || '', state: null, key: navKey ?? path }
  }, [path, navKey])

  const navigation = useMemo(
    () => ({
      basename: '/',
      navigator: {
        createHref: (to: To) => (typeof to === 'string' ? to : createPath(to)),
        encodeLocation: (to: To) => {
          const p = typeof to === 'string' ? parsePath(to) : to
          return { pathname: p.pathname ?? '/', search: p.search ?? '', hash: p.hash ?? '' }
        },
        go: (n: number) => onGo(n),
        push: (to: To) => onNavigate(resolve(to, location.pathname), false),
        replace: (to: To) => onNavigate(resolve(to, location.pathname), true),
      },
      static: false,
      useTransitions: false,
      future: {},
    }),
    [onNavigate, onGo, location.pathname],
  )

  return (
    <UNSAFE_NavigationContext.Provider value={navigation}>
      <UNSAFE_LocationContext.Provider value={{ location, navigationType: 'PUSH' as never }}>
        <UNSAFE_RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>{children}</UNSAFE_RouteContext.Provider>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_NavigationContext.Provider>
  )
}

/** Turn a `To` into an absolute path string, resolving relative pathnames against the current one. */
function resolve(to: To, current: string): string {
  const p = typeof to === 'string' ? parsePath(to) : to
  let pathname = p.pathname ?? current
  if (!pathname.startsWith('/')) {
    const base = current.endsWith('/') ? current : current.replace(/\/[^/]*$/, '/')
    pathname = new URL(pathname, `http://x${base}`).pathname
  }
  return `${pathname}${p.search ?? ''}${p.hash ?? ''}`
}

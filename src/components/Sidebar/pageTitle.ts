import { useEffect } from 'react'
import { otherPages, primaryNav, secondaryNav, type NavLeaf } from './nav'

/**
 * The browser tab's title, per page: "Documents · aegraph". Browser tabs, history and a screen reader announcing the
 * page all tell the pages apart by it. The names are the sidebar's (`nav.tsx`), so a page is called the same
 * everywhere; a deeper address takes the name of the page it sits in (`/documents/<id>` is Documents).
 */
export const APP_NAME = 'aegraph'

const pages = (): NavLeaf[] => [...primaryNav, ...secondaryNav].flatMap((item) => [item, ...(item.children ?? [])]).concat(otherPages)

/** The name of the page at `pathname`: the longest page address it is, or sits under; null for none. */
export function pageName(pathname: string, list: readonly NavLeaf[] = pages()): string | null {
  let best: NavLeaf | null = null
  for (const p of list) {
    if (!p.to) continue
    const hit = p.to === '/' ? pathname === '/' : pathname === p.to || pathname.startsWith(p.to + '/')
    if (hit && (!best || p.to.length > best.to!.length)) best = p
  }
  return best?.label ?? null
}

export function documentTitle(pathname: string): string {
  const name = pageName(pathname)
  return name ? `${name} · ${APP_NAME}` : APP_NAME
}

/** Keep `document.title` on the page at `pathname`. */
export function useDocumentTitle(pathname: string) {
  useEffect(() => {
    document.title = documentTitle(pathname)
  }, [pathname])
}

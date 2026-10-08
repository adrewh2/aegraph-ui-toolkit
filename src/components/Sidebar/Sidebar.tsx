import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, PanelLeft, PanelLeftOpen, Search, Sparkles } from 'lucide-react'
import { useEntityStore, useStoreDataVersion } from '../../core/entity/hooks'
import { formatNumber } from '../../lib/format'
import { BridgeStatus } from '../../features/bridge/BridgeStatus'
import { AccountButton } from '../../features/account/AccountMenu'
import { EDITION } from '../../app/edition'
import { useDismiss } from '../ui/useDismiss'
import { ProjectSwitcher } from '../../features/projects/ProjectSwitcher'
import { openSearch } from '../../features/search/CommandPalette'
import { TrailButtons } from '../Layout/Trail'
import { sidebarCounts } from './counts'
import { useOpenChatIds } from '../../features/assistant/instance'
import { toggleSidebarRail, useSidebarRail } from './rail'
import { primaryNav, secondaryNav, type NavItem, type NavLeaf } from './nav'
import './Sidebar.css'

// The pages it lists, and their names, are `nav.tsx`'s: the browser tab's title reads them too (`pageTitle.ts`).

export function Sidebar() {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Folded to the icon rail or not: shared state (`rail.ts`), so the explorer's Full view can fold it too.
  const rail = useSidebarRail()
  // ⌘B / Ctrl+B: fold or unfold the sidebar. (⌘K is the command palette's, in CommandPalette.tsx.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebarRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const isActive = (item: NavLeaf) => {
    if (item.to === undefined) return false
    if (item.to === '/') return pathname === '/'
    if (item.to.includes('?')) {
      // A section of one page: the path and the `category` param both have to match.
      const [path, query] = item.to.split('?')
      return pathname === path && new URLSearchParams(search).get('category') === new URLSearchParams(query).get('category')
    }
    return pathname === item.to || pathname.startsWith(item.to + '/')
  }

  const toggle = (label: string) =>
    setCollapsed((c) => ({ ...c, [label]: !c[label] }))

  // ── On the rail, a row says what it is beside itself ──────────────────
  // Folded, every row is a bare icon, so the pointer gets an answer at once: a leaf names itself, a group opens as
  // a menu to the right of its icon (hovered, or clicked to keep it there). A portal and fixed coordinates, because
  // the nav scrolls and the sidebar clips — an absolutely positioned panel would be cut off at the rail's edge.
  type Flyout = { item: NavItem; top: number; left: number; stuck: boolean }
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const cancelClose = () => window.clearTimeout(closeTimer.current)
  // A moment's grace so the pointer can cross the gap between the icon and the panel without it vanishing.
  const closeSoon = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setFlyout((f) => (f?.stuck ? f : null)), 140)
  }
  const openFlyout = (item: NavItem, el: HTMLElement, stuck = false) => {
    cancelClose()
    const r = el.getBoundingClientRect()
    setFlyout((f) => ({ item, top: r.top, left: r.right + 8, stuck: stuck || (f?.item.label === item.label && f.stuck) }))
  }
  useEffect(() => () => cancelClose(), [])
  useEffect(() => {
    if (!rail) setFlyout(null)
  }, [rail])
  // A pinned menu closes the way any menu does: a click elsewhere, or Escape.
  useDismiss(() => setFlyout(null), { active: !!flyout?.stuck, inside: () => [flyoutRef.current] })
  // Keep it on screen when it opens near the bottom. Written straight to the node: no second render for a hover.
  useLayoutEffect(() => {
    const el = flyoutRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const max = window.innerHeight - r.height - 8
    if (r.top > max) el.style.top = `${Math.max(8, max)}px`
  }, [flyout])
  /** The hover behaviour every rail row shares; off the rail there is nothing to explain. */
  const railHover = (item: NavItem) =>
    rail
      ? {
          onMouseEnter: (e: MouseEvent<HTMLElement>) => openFlyout(item, e.currentTarget),
          onMouseLeave: closeSoon,
          onFocus: (e: FocusEvent<HTMLElement>) => openFlyout(item, e.currentTarget),
          onBlur: closeSoon,
        }
      : {}

  // How much each page holds — the chats, the entities, each resource — read off the store's indexes and counters
  // and re-read when the data changes.
  const store = useEntityStore()
  const dataVersion = useStoreDataVersion(store)
  // The open chats count on the Chats row until they are recorded: their ids only, so a streaming reply renders nothing here.
  const openChats = useOpenChatIds()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => sidebarCounts(store, openChats), [store, dataVersion, openChats])

  const renderLeaf = (item: NavItem, nested = false, icon?: ReactNode) => {
    const count = item.to ? counts.byRoute[item.to] : undefined
    return (
      <button
        key={item.label}
        className={`sb-item ${nested ? 'sb-item--nested' : ''} ${
          isActive(item) ? 'sb-item--active' : ''
        }`}
        {...(nested ? {} : railHover(item))}
        onClick={() => item.to && navigate(item.to)}
      >
        {icon && <span className="sb-item__icon">{icon}</span>}
        <span className="sb-item__label">{item.label}</span>
        {item.badge && <span className="sb-badge">{item.badge}</span>}
        {item.trailing && <span className="sb-item__trailing">{item.trailing}</span>}
        {count !== undefined && <span className="sb-item__count">{formatNumber(count)}</span>}
      </button>
    )
  }

  const renderItem = (item: NavItem) => {
    if (!item.children) return renderLeaf(item, false, item.icon)
    if (rail) {
      // On the rail a group is one icon: lit when any child is the page. It has no page of its own to go to — a
      // click opens the group beside it (and keeps it open) rather than guessing at one of its children.
      const active = item.children.some(isActive) || (item.to !== undefined && pathname === item.to)
      return (
        <button
          key={item.label}
          className={`sb-item ${active ? 'sb-item--active' : ''} ${flyout?.item.label === item.label ? 'sb-item--open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={flyout?.item.label === item.label}
          {...railHover(item)}
          onClick={(e) => openFlyout(item, e.currentTarget, true)}
        >
          <span className="sb-item__icon">{item.icon}</span>
          <span className="sb-item__label">{item.label}</span>
        </button>
      )
    }
    const open = !collapsed[item.label]
    const counted =
      item.label === 'Resources' && counts.resources > 0 ? counts.resources : item.label === 'Analytics' && counts.analytics > 0 ? counts.analytics : undefined
    const childrenId = `sb-group-${item.label.toLowerCase().replace(/\W+/g, '-')}`
    return (
      <div key={item.label} className="sb-group">
        {item.to ? (
          // A group that is also a page: the row opens it (and expands); the chevron beside it — its own button, not
          // one nested in the row's — only folds and unfolds.
          <div className={`sb-item sb-item--split ${!open && pathname === item.to ? 'sb-item--active' : ''}`}>
            <button
              className="sb-item__main"
              onClick={() => {
                navigate(item.to!)
                if (!open) toggle(item.label)
              }}
            >
              <span className="sb-item__icon">{item.icon}</span>
              <span className="sb-item__label">{item.label}</span>
              {counted !== undefined && <span className="sb-item__count">{formatNumber(counted)}</span>}
            </button>
            <button
              className="sb-item__chevron"
              aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
              aria-expanded={open}
              aria-controls={childrenId}
              onClick={() => toggle(item.label)}
            >
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
        ) : (
          // A group with no page of its own: the whole row folds and unfolds it.
          <button className="sb-item" aria-expanded={open} aria-controls={childrenId} onClick={() => toggle(item.label)}>
            <span className="sb-item__icon">{item.icon}</span>
            <span className="sb-item__label">{item.label}</span>
            {counted !== undefined && <span className="sb-item__count">{formatNumber(counted)}</span>}
            <span className="sb-item__chevron" aria-hidden>
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
          </button>
        )}
        {open && (
          <div className="sb-group__children" id={childrenId}>
            {item.children.map((child) => renderLeaf(child, true))}
          </div>
        )}
      </div>
    )
  }

  // Folded, the sidebar is an icon rail: the same rows without their labels (each named by its tooltip), no search,
  // project switcher or account row, and the fold button at the top to unfold it. ⌘B toggles either way.
  return (
    <aside className={`sb ${rail ? 'sb--rail' : ''}`}>
      <header className="sb-header">
        {!rail && <span className="sb-title">aegraph</span>}
        <span className="sb-header__actions">
          {!rail && <TrailButtons />}
          {/* Folded, the button that unfolds is the mark itself — "ae", the head of the wordmark the open sidebar
              shows — so the rail is still signed. The panel icon takes its place under the pointer. */}
          <button className={`sb-icon-btn ${rail ? 'sb-logo-btn' : ''}`} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={rail ? 'Expand the sidebar (⌘B)' : 'Collapse the sidebar (⌘B)'} onClick={() => toggleSidebarRail()}>
            {rail ? (
              <>
                <span className="sb-logo-btn__mark">ae</span>
                <span className="sb-logo-btn__icon">
                  <PanelLeftOpen size={18} />
                </span>
              </>
            ) : (
              <PanelLeft size={18} />
            )}
          </button>
        </span>
      </header>

      {!rail && <ProjectSwitcher />}

      {!rail && (
        // The front door to the ⌘K palette: a click opens it, a keystroke opens it with that character typed. One
        // search, one set of results — the box is just where the eye looks for it.
        <button type="button" className="sb-search" onClick={() => openSearch()} onKeyDown={(e) => e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && (e.preventDefault(), openSearch(e.key))} title="Search everything (⌘K)">
          <Search size={15} className="sb-search__icon" />
          <span className="sb-search__placeholder">Search everything…</span>
          <span className="sb-kbd-group">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </button>
      )}

      <nav className="sb-nav sb-nav--scroll">{primaryNav.map(renderItem)}</nav>

      <div className="sb-spacer" />
      <div className="sb-divider" />

      <nav className="sb-nav">
        {secondaryNav.map(renderItem)}
        <button className="sb-item" {...railHover({ label: 'Assistant' })} onClick={() => window.dispatchEvent(new CustomEvent('aegraph:assistant'))} title={rail ? undefined : 'Toggle the assistant (⌘J)'}>
          <span className="sb-item__icon">
            <Sparkles size={16} />
          </span>
          <span className="sb-item__label">Assistant</span>
          <span className="sb-kbd-group">
            <kbd>⌘</kbd>
            <kbd>J</kbd>
          </span>
        </button>
        <BridgeStatus />
      </nav>

      {/* Settings: This browser and the user's settings (src/features/account). Where this edition's
          code is public, a link to its repository sits to its left (`app/edition.ts`). */}
      <div className={`sb-foot ${rail ? 'sb-foot--rail' : ''}`}>
        {EDITION.repoLinkInSidebar && <RepoLink />}
        <AccountButton rail={rail} />
      </div>

      {rail &&
        flyout &&
        createPortal(
          <div
            ref={flyoutRef}
            className={`sb-flyout ${flyout.item.children ? '' : 'sb-flyout--tip'}`}
            style={{ top: flyout.top, left: flyout.left }}
            role={flyout.item.children ? 'menu' : undefined}
            onMouseEnter={cancelClose}
            onMouseLeave={closeSoon}
          >
            <div className="sb-flyout__title">{flyout.item.label}</div>
            {flyout.item.children?.map((child) => {
              const count = child.to ? counts.byRoute[child.to] : undefined
              return (
                <button
                  key={child.label}
                  className={`sb-flyout__item ${isActive(child) ? 'sb-flyout__item--active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    if (child.to) navigate(child.to)
                    setFlyout(null)
                  }}
                >
                  <span className="sb-flyout__label">{child.label}</span>
                  {count !== undefined && <span className="sb-item__count">{formatNumber(count)}</span>}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </aside>
  )
}

/**
 * This edition's repository, as the GitHub mark (the path is Simple Icons', CC0; the mark is GitHub's trademark, used
 * here only to point at the code on GitHub). A plain link, opened in a new tab: nothing is fetched until it is clicked.
 */
function RepoLink() {
  const where = EDITION.repo.replace(/^https:\/\//, '')
  return (
    <a className="sb-repo" href={EDITION.repo} target="_blank" rel="noopener noreferrer" title={`The code: ${where}`} aria-label={`${EDITION.name} on GitHub`}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    </a>
  )
}


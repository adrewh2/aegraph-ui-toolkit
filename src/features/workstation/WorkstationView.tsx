import { ArrowLeft, ArrowRight, BarChart3, ChevronDown, Code2, Columns2, Copy, LayoutTemplate, Pencil, Plus, Rows2, Table2, X } from 'lucide-react'
import { unloadsBehind } from '../../app/routes'
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppRoutes } from '../../app/AppRoutes'
import { ErrorBoundary } from '../../components/ErrorBoundary/ErrorBoundary'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { createEntity, displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { GRAPH_TYPES } from '../../core/graph/types'
import { datasetsIn } from '../../core/datasets/dataset'
import { PLOT_TYPE } from '../../core/graph/plot'
import { scriptsIn } from '../scripts/script'
import { SavedPicker } from '../graph/SavedPicker'
import {
  activateTab,
  addTab,
  closePane,
  closeTab,
  defaultWorkstation,
  describeWorkstation,
  ensureLists,
  findPane,
  fromPreset,
  goTab,
  makeTab,
  moveTab,
  navigateInHost,
  navigateTab,
  openInHost,
  panes,
  pathWithin,
  PRESETS,
  retitleTab,
  setRatio,
  splitPane,
  toPreset,
  updatePane,
  viewForPath,
  VIEWS,
  type ListDef,
  type Node,
  type PaneNode,
  type SplitNode,
  type Tab,
  type Workstation,
} from './model'
import { PaneRouter } from './PaneRouter'
import { registerHost, type HostCommand } from './hosts'
import { PaneContext, type PaneHost } from './paneContext'
import { useViewActive, useViewActiveRef } from './paneContext'
import { readGraphSetup, readPick } from '../../app/openIn'
import { scrollBehavior } from '../../lib/motion'
import './workstation.css'

const STORAGE_KEY = 'aegraph:workstation:v1'
const DRAG_MIME = 'application/x-aegraph-tab'

type Action =
  | HostCommand
  | { type: 'set'; ws: Workstation; presetId?: EntityId }
  | { type: 'markSaved'; presetId: EntityId }
  | { type: 'closePane'; paneId: string }
  | { type: 'ratio'; splitId: string; ratio: number }
  | { type: 'move'; from: string; tabId: string; to: string; index?: number }
  | { type: 'navigate'; paneId: string; tabId: string; path: string; replace: boolean; /** What to name a tab this opens (a list opening an item). */ title?: string }
  | { type: 'go'; paneId: string; tabId: string; delta: number }
  /** A path arriving from outside the host (the address bar, a link): see `openInHost`. */
  | { type: 'open'; path: string; title?: string }

interface State {
  ws: Workstation
  presetId?: EntityId
  dirty: boolean
}

function reducer(s: State, a: Action, fallbackPath = '/', lists: ListDef[] = []): State {
  const next = step(s, a, fallbackPath, lists)
  // A host with lists keeps them whatever happened: one tab each, at the front, never closed.
  const ws = ensureLists(next.ws, lists)
  return ws === next.ws ? next : { ...next, ws }
}

function step(s: State, a: Action, fallbackPath: string, lists: ListDef[]): State {
  const touch = (ws: Workstation, structural = true) => ({ ...s, ws, dirty: structural ? !!s.presetId || s.dirty : s.dirty })
  if (lists.length) {
    // In a host with lists, opening and navigating follow the lists: an item never lands in a list's tab.
    if (a.type === 'addTab') return touch(openInHost(s.ws, lists, a.tab.path, { paneId: a.paneId, tab: a.tab }))
    if (a.type === 'open') return touch(openInHost(s.ws, lists, a.path, { title: a.title }), false)
    if (a.type === 'navigate') return touch(navigateInHost(s.ws, lists, a.paneId, a.tabId, a.path, a.replace, a.title), false)
  }
  switch (a.type) {
    case 'open':
      return touch(addTab(s.ws, s.ws.focused, makeTab(a.path, a.title)))
    case 'set':
      return { ws: a.ws, presetId: a.presetId, dirty: false }
    case 'markSaved':
      return { ...s, presetId: a.presetId, dirty: false }
    case 'focus':
      return { ...s, ws: { ...s.ws, focused: a.paneId } }
    case 'split':
      return touch(splitPane(s.ws, a.paneId, a.dir, a.tab))
    case 'closePane':
      return touch(closePane(s.ws, a.paneId))
    case 'ratio':
      return touch(setRatio(s.ws, a.splitId, a.ratio))
    case 'addTab':
      return touch(addTab(s.ws, a.paneId, a.tab))
    case 'closeTab':
      return touch(closeTab(s.ws, a.paneId, a.tabId, fallbackPath))
    case 'retitle':
      return touch(retitleTab(s.ws, a.paneId, a.tabId, a.title))
    case 'activate':
      return touch(activateTab(s.ws, a.paneId, a.index), false)
    case 'move':
      return touch(moveTab(s.ws, a.from, a.tabId, a.to, a.index))
    case 'navigate':
      return touch(navigateTab(s.ws, a.paneId, a.tabId, a.path, a.replace), false)
    case 'go':
      return touch(goTab(s.ws, a.paneId, a.tabId, a.delta), false)
  }
}

/** A hand-off (`?pick=`) names its tab after what was picked. */
function tabTitleFor(path: string): string | undefined {
  const pick = /[?&](?:pick|only)=([^&]+)/.exec(path)?.[1]
  if (pick) return readPick(decodeURIComponent(pick))?.label
  const setup = /[?&]setup=([^&]+)/.exec(path)?.[1]
  return setup ? readGraphSetup(decodeURIComponent(setup))?.label : undefined
}

/**
 * A host that stands for one page (Entities) keeps only that page's paths as tabs; anything else — a graph explorer
 * opened from a row, say — leaves for its own page instead of becoming a tab inside the wrong host.
 */
const HostScope = createContext<{ keeps: (path: string) => boolean; leave: (path: string) => void } | null>(null)

function initial(storageKey: string, fallback: () => Workstation, keeps?: (path: string) => boolean, lists: ListDef[] = []): State {
  const s = loadInitial(storageKey, fallback, keeps)
  return { ...s, ws: ensureLists(s.ws, lists) }
}

function loadInitial(storageKey: string, fallback: () => Workstation, keeps?: (path: string) => boolean): State {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const saved = JSON.parse(raw) as { ws: unknown; presetId?: string; dirty?: boolean }
      let ws = fromPreset(saved.ws)
      // Tabs of the wrong kind that got in before the host kept to its page are let go; a pane never ends up empty.
      if (ws && keeps) {
        const fb = fallback()
        const fbPath = panes(fb.root)[0]?.tabs[0]?.path ?? '/'
        for (const p of panes(ws.root)) {
          const kept = p.tabs.filter((t) => keeps(t.path))
          if (kept.length !== p.tabs.length) {
            const active = Math.max(0, Math.min(kept.length - 1, kept.indexOf(p.tabs[p.active])))
            ws = updatePane(ws, p.id, (x) => ({ ...x, tabs: kept.length ? kept : [makeTab(fbPath)], active: kept.length ? active : 0 }))
          }
        }
      }
      if (ws) return { ws, presetId: saved.presetId, dirty: !!saved.dirty }
    }
  } catch {
    /* ignore */
  }
  return { ws: fallback(), dirty: false }
}

export interface WorkstationProps {
  /** Where the arrangement is remembered (one per host). */
  storageKey?: string
  /** The arrangement a fresh host starts with. */
  initialWorkstation?: () => Workstation
  /** `full`: the workstation page with its title bar and presets; `tabs`: just the panes, for a page that hosts tabs of one kind. */
  chrome?: 'full' | 'tabs'
  /**
   * Keep the browser URL and the focused pane's active tab in step: the URL
   * navigates the tab, the tab's own navigation updates the URL. For pages
   * like Entities that are one view with many filtered tabs.
   */
  syncUrl?: (path: string) => boolean
  /** Paths that arrive through the URL and should open as a new tab (a filtered view) rather than replace the active one. */
  newTabWhen?: (path: string) => boolean
  /** The views a pane can add or split off (view ids); a host of one kind of page offers only that kind. Default: every view. */
  views?: string[]
  /**
   * How many of a pane's recently shown tabs stay mounted, the front one included (default WARM_TABS). Each kept tab holds its whole
   * view — a graph engine, a map, a diagram, with their GPU contexts — so a host that fills with heavy views keeps fewer.
   */
  warmTabs?: number
  /** Offer splitting a pane (the buttons, the tab menu's split items, ⌘D). Off for a host that is one strip of tabs. Default on. */
  splits?: boolean
  /** Closing the last tab of a single pane calls this instead of leaving a blank tab behind — the host goes away. */
  onLastTabClosed?: () => void
  /**
   * The section's lists (see `ListDef`, `hosts.ts`): each a tab at the front that cannot be closed, and whatever is
   * opened from one opens as a tab of its own beside it. A host with lists offers no "+": its tabs are what was opened.
   */
  lists?: ListDef[]
}

/** `/workstation` — iTerm-style split panes, each with tabs of app views. Also the host behind tabbed pages (Entities). */
export function WorkstationView({ storageKey = STORAGE_KEY, initialWorkstation = defaultWorkstation, chrome = 'full', syncUrl, newTabWhen, views, warmTabs = WARM_TABS, splits = true, onLastTabClosed, lists = NO_LISTS }: WorkstationProps = {}) {
  const allowedViews = views ? VIEWS.filter((v) => views.includes(v.id)) : VIEWS
  const hostOptions = useMemo(() => ({ warmTabs, splits, onLastTabClosed, lists }), [warmTabs, splits, onLastTabClosed, lists])
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const fallbackPath = allowedViews[0]?.path ?? '/'
  // A section keeps whatever was opened from its lists, from any page (a graph scene opened from Scenes is Unigraph):
  // only a host without lists lets go of tabs of the wrong kind on the way in.
  const location = useLocation()
  // A deep link into a host without lists (Unigraph's `/unigraph/2d?scene=…`) goes into the active tab in the initial
  // state — the move the address effect below would make one render later. Made by the effect, the tab first mounted
  // on its restored address (`?session=…`), so its view built the last-used picture — on a fresh tab the whole project,
  // a million nodes for the WildChat atlas — before the scene it was opened on arrived. A section with lists, a link
  // that asks for a new tab, and the bare section (which keeps the tab's deeper path) are left to the effect.
  const [state, dispatch] = useReducer((st: State, a: Action) => reducer(st, a, fallbackPath, lists), undefined, () => {
    const s = initial(storageKey, initialWorkstation, lists.length ? undefined : syncUrl, lists)
    const here = `${location.pathname}${location.search}${location.hash}`
    if (lists.length || !syncUrl?.(here) || newTabWhen?.(here)) return s
    const pane = findPane(s.ws.root, s.ws.focused)
    const tab = pane?.tabs[pane.active]
    if (!pane || !tab || tab.path === here || pathWithin(here, tab.path)) return s
    return reducer(s, { type: 'navigate', paneId: pane.id, tabId: tab.id, path: here, replace: true }, fallbackPath, lists)
  })
  const { ws } = state
  const navigate = useNavigate()
  const hostScope = useMemo(() => (syncUrl ? { keeps: syncUrl, leave: (path: string) => navigate(path) } : null), [syncUrl, navigate])
  const browserPath = `${location.pathname}${location.search}${location.hash}`
  const focusedPane = findPane(ws.root, ws.focused)
  const activeTab = focusedPane?.tabs[focusedPane.active]

  // The URL the host mounted on, when it points into the host: a deep link wins over the restored tab until the tab has reached it.
  const deepLink = useRef(syncUrl?.(browserPath) ? browserPath : null)
  // Where the address was before this change: a section's own link followed from inside the section is "show me the
  // list"; followed from elsewhere it is "back to where I was".
  const prevBrowserPath = useRef(browserPath)
  // Whether the page was in front at the last render: a page kept behind another (KeptPages) keeps the address it was
  // left on, and coming back to it is arriving from elsewhere, not a move inside it.
  const pageActive = useViewActive()
  const wasInFront = useRef(pageActive)
  // URL → tab: a link into this page (sidebar, deep link) navigates the active tab instead of leaving the host.
  // The bare section (`/entities`, the sidebar's link) is "back to where I was": the tab keeps its deeper path and the
  // address bar follows it, so switching pages never resets the browser's filters and selection.
  useEffect(() => {
    const prev = prevBrowserPath.current
    prevBrowserPath.current = browserPath
    if (!syncUrl || !syncUrl(browserPath) || !focusedPane || !activeTab) return
    if (activeTab.path === browserPath) return
    const fromInside = wasInFront.current && prev !== browserPath && syncUrl(prev)
    const toList = lists.some((l) => l.is(browserPath))
    if (pathWithin(browserPath, activeTab.path) && !(fromInside && toList && !activeTab.list)) {
      deepLink.current = null
      navigate(activeTab.path, { replace: true })
      return
    }
    // A section: the list comes forward on a list's address, an item to its tab (or a new one).
    if (lists.length) dispatch({ type: 'open', path: browserPath, title: tabTitleFor(browserPath) })
    else if (newTabWhen?.(browserPath) && !focusedPane.tabs.some((t) => t.path === browserPath)) dispatch({ type: 'addTab', paneId: focusedPane.id, tab: makeTab(browserPath, tabTitleFor(browserPath)) })
    else dispatch({ type: 'navigate', paneId: focusedPane.id, tabId: activeTab.id, path: browserPath, replace: true })
    // The key too: the section's link followed while a tab from another page is in front (a Unigraph scene opened from
    // Scenes, which the address bar cannot show) is the same address again, and still means "show me the list".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserPath, lists.length ? location.key : ''])
  // After the address effect, which reads what it was: whether this page is in front now.
  useEffect(() => {
    wasInFront.current = pageActive
  })
  // Tab → URL: what the active tab shows is what the address bar says, so refresh and share keep working.
  // Restoring the tab on mount replaces (the user didn't go anywhere); later tab moves push, so the trail records them.
  const syncedOnce = useRef(false)
  useEffect(() => {
    if (!syncUrl || !activeTab || !syncUrl(activeTab.path)) return
    if (deepLink.current) {
      if (activeTab.path !== deepLink.current) return
      deepLink.current = null
    }
    if (activeTab.path !== browserPath) navigate(activeTab.path, { replace: !syncedOnce.current })
    syncedOnce.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.path, activeTab?.id])
  // `/workstation?preset=<id>` opens a saved arrangement (a project's home route, a shared link) and then drops the param.
  useEffect(() => {
    if (chrome !== 'full') return
    const presetId = new URLSearchParams(location.search).get('preset')
    if (!presetId) return
    const e = store.get(presetId)
    const loaded = e?.type === GRAPH_TYPES.workstation ? fromPreset(e.data) : undefined
    if (loaded) dispatch({ type: 'set', ws: loaded, presetId })
    else toast('That workstation could not be found')
    navigate(location.pathname, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; paneId: string; anchor?: Element } | null>(null)
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number; anchor?: Element } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ws: toPreset(ws), presetId: state.presetId, dirty: state.dirty }))
    } catch {
      /* ignore */
    }
  }, [ws, state.presetId, state.dirty, storageKey])
  // Tools (the assistant, MCP) reach a mounted host through the registry: open a tab here, close one, switch.
  const wsRef = useRef(ws)
  wsRef.current = ws
  useEffect(() => registerHost({ key: storageKey, get: () => wsRef.current, run: dispatch }), [storageKey])

  // Other parts of the app can ask for a view to be opened here (the workstation page only).
  useEffect(() => {
    if (chrome !== 'full') return
    const onOpen = (e: Event) => {
      const { path, split } = (e as CustomEvent<{ path: string; split?: 'row' | 'col' }>).detail
      if (split) dispatch({ type: 'split', paneId: ws.focused, dir: split, tab: makeTab(path) })
      else dispatch({ type: 'addTab', paneId: ws.focused, tab: makeTab(path) })
    }
    window.addEventListener('aegraph:workstation:open', onOpen)
    return () => window.removeEventListener('aegraph:workstation:open', onOpen)
  }, [ws.focused, chrome])

  // Keyboard: ⌘D split right, ⌘⇧D split down, ⌘⇧W close pane, ⌘⇧] / ⌘⇧[ next/previous tab, ⌥⌘← / → previous/next pane.
  const viewActive = useViewActiveRef()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      // A view that took the key first (the dataset grid's ⌘D fills down) keeps it.
      if (e.defaultPrevented) return
      const el = e.target as HTMLElement
      if (el.isContentEditable && e.key !== 'd' && e.key !== 'D') return
      const pane = findPane(ws.root, ws.focused)
      if (!pane) return
      if (e.key.toLowerCase() === 'd') {
        if (!splits) return
        e.preventDefault()
        dispatch({ type: 'split', paneId: pane.id, dir: e.shiftKey ? 'col' : 'row' })
      } else if (e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        dispatch({ type: 'closePane', paneId: pane.id })
      } else if (e.shiftKey && (e.key === ']' || e.key === '}')) {
        e.preventDefault()
        dispatch({ type: 'activate', paneId: pane.id, index: (pane.active + 1) % pane.tabs.length })
      } else if (e.shiftKey && (e.key === '[' || e.key === '{')) {
        e.preventDefault()
        dispatch({ type: 'activate', paneId: pane.id, index: (pane.active - 1 + pane.tabs.length) % pane.tabs.length })
      } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault()
        const all = panes(ws.root)
        const i = all.findIndex((p) => p.id === pane.id)
        dispatch({ type: 'focus', paneId: all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].id })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, splits])

  const viewItems = (paneId: string, split?: 'row' | 'col'): MenuItem[] => {
    const items: MenuItem[] = []
    const sections = (['Resources', 'Entities', 'Display', 'Build'] as const).filter((section) => allowedViews.some((x) => x.section === section))
    for (const section of sections) {
      // One kind of view only: no heading to sort it under.
      if (sections.length > 1) items.push({ kind: 'label', label: section })
      for (const v of allowedViews.filter((x) => x.section === section)) items.push({ kind: 'item', label: v.label, icon: v.icon, onSelect: () => (split ? dispatch({ type: 'split', paneId, dir: split, tab: makeTab(v.path) }) : dispatch({ type: 'addTab', paneId, tab: makeTab(v.path) })) })
    }
    return items
  }

  const savePreset = (name: string, existing?: AnyEntity) => {
    const data = toPreset(ws) as unknown as Record<string, unknown>
    if (existing) {
      store.update(existing.id, { label: name, data })
      dispatch({ type: 'markSaved', presetId: existing.id })
    } else {
      const e = createEntity({ type: GRAPH_TYPES.workstation, label: name, data, meta: { source: 'user' } })
      store.upsert(e)
      dispatch({ type: 'markSaved', presetId: e.id })
    }
  }

  const paneCount = panes(ws.root).length

  return (
    <HostOptions.Provider value={hostOptions}>
    <div className={`ws ${chrome === 'tabs' ? 'ws--tabs' : ''} ${lists.length ? 'ws--lists' : ''}`}>
      {chrome === 'full' && (
      <div className="ws-top">
        <span className="ws-title">Workstation</span>
        <span className="ws-sep" />
        <SavedPicker
          type={GRAPH_TYPES.workstation}
          noun="workstation"
          icon={LayoutTemplate}
          activeId={state.presetId}
          dirty={state.dirty}
          summary={describeWorkstation(ws)}
          onLoad={(e) => {
            const loaded = fromPreset(e.data)
            if (!loaded) return toast('That workstation could not be loaded')
            dispatch({ type: 'set', ws: loaded, presetId: e.id })
          }}
          onSave={savePreset}
          onClear={() => dispatch({ type: 'set', ws: defaultWorkstation() })}
          clearLabel="Reset to default"
        />
        <button className="btn btn--sm" onClick={(e) => setPresetMenu(presetMenu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
          Templates <ChevronDown size={12} />
        </button>
        <span className="ws-sep" />
        <button className="btn btn--sm" title="Split the focused pane vertically (⌘D)" onClick={() => dispatch({ type: 'split', paneId: ws.focused, dir: 'row' })}>
          <Columns2 size={13} /> Split right
        </button>
        <button className="btn btn--sm" title="Split the focused pane horizontally (⌘⇧D)" onClick={() => dispatch({ type: 'split', paneId: ws.focused, dir: 'col' })}>
          <Rows2 size={13} /> Split down
        </button>
        <button className="btn btn--sm" title="Add a view to the focused pane" onClick={(e) => setAddMenu(addMenu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, paneId: ws.focused, anchor: e.currentTarget })}>
          <Plus size={13} /> Add view
        </button>
        <span className="spacer" />
        <span className="ws-hint muted">
          {paneCount} pane{paneCount === 1 ? '' : 's'} · <kbd className="kbd">⌘D</kbd> split · <kbd className="kbd">⌘⇧D</kbd> split down · <kbd className="kbd">⌘⇧W</kbd> close pane · drag tabs between panes
        </span>
      </div>
      )}
      <div className="ws-body">
        <HostScope.Provider value={hostScope}>
          <TreeNode node={ws.root} ws={ws} dispatch={dispatch} onAddMenu={(x, y, paneId) => setAddMenu({ x, y, paneId })} />
        </HostScope.Provider>
      </div>
      {addMenu && <Menu x={addMenu.x} y={addMenu.y} anchor={addMenu.anchor} items={viewItems(addMenu.paneId)} onClose={() => setAddMenu(null)} />}
      {presetMenu && (
        <Menu
          anchor={presetMenu.anchor}
          x={presetMenu.x}
          y={presetMenu.y}
          items={PRESETS.map<MenuItem>((p) => ({
            kind: 'item',
            label: `${p.label} — ${p.description}`,
            onSelect: () => dispatch({ type: 'set', ws: p.build() }),
          }))}
          onClose={() => setPresetMenu(null)}
        />
      )}
    </div>
    </HostOptions.Provider>
  )
}

// ── Tree ───────────────────────────────────────────────────────────────

function TreeNode({ node, ws, dispatch, onAddMenu }: { node: Node; ws: Workstation; dispatch: (a: Action) => void; onAddMenu: (x: number, y: number, paneId: string) => void }) {
  if (node.kind === 'pane') return <Pane pane={node} focused={ws.focused === node.id} single={ws.root.kind === 'pane'} dispatch={dispatch} onAddMenu={onAddMenu} />
  return <Split node={node} ws={ws} dispatch={dispatch} onAddMenu={onAddMenu} />
}

function Split({ node, ws, dispatch, onAddMenu }: { node: SplitNode; ws: Workstation; dispatch: (a: Action) => void; onAddMenu: (x: number, y: number, paneId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const el = ref.current!
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const ratio = node.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height
      dispatch({ type: 'ratio', splitId: node.id, ratio })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove(node.dir === 'row' ? 'ws-resizing-x' : 'ws-resizing-y')
    }
    document.body.classList.add(node.dir === 'row' ? 'ws-resizing-x' : 'ws-resizing-y')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={ref} className={`ws-split ws-split--${node.dir}`}>
      <div className="ws-split__child" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <TreeNode node={node.children[0]} ws={ws} dispatch={dispatch} onAddMenu={onAddMenu} />
      </div>
      <div className={`ws-gutter ws-gutter--${node.dir}`} onPointerDown={onDown} onDoubleClick={() => dispatch({ type: 'ratio', splitId: node.id, ratio: 0.5 })} title="Drag to resize · double-click to even out" />
      <div className="ws-split__child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <TreeNode node={node.children[1]} ws={ws} dispatch={dispatch} onAddMenu={onAddMenu} />
      </div>
    </div>
  )
}

// ── Pane ───────────────────────────────────────────────────────────────

/** How many of a pane's recently shown tabs stay mounted, the front one included, unless the host says otherwise (`warmTabs`). */
const WARM_TABS = 4
/** A host without lists (the workstation page, Entities, Unigraph). */
const NO_LISTS: ListDef[] = []
/** What a pane takes from its host: how many tabs it keeps mounted, whether it offers splits, what closing its last tab does, its lists. */
const HostOptions = createContext<{ warmTabs: number; splits: boolean; onLastTabClosed?: () => void; lists: ListDef[] }>({ warmTabs: WARM_TABS, splits: true, lists: NO_LISTS })

function Pane({ pane, focused, single, dispatch, onAddMenu }: { pane: PaneNode; focused: boolean; single: boolean; dispatch: (a: Action) => void; onAddMenu: (x: number, y: number, paneId: string) => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const hostLists = useContext(HostOptions).lists
  const tab = pane.tabs[pane.active]
  const [over, setOver] = useState<number | null>(null)
  // Double-click a tab to name it; Enter keeps the name, Escape drops the edit, an empty name goes back to the derived one.
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null)
  /** Right-click on a tab: rename, duplicate, split, close — and for a Charts, Scripts or Datasets tab, the saved ones to open beside it. */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: Tab; index: number } | null>(null)
  const tabMenuItems = (t: Tab, index: number): MenuItem[] => {
    const base = t.path.split('?')[0]
    const kind = base === '/analytics/charts' ? 'charts' : base === '/analytics/scripts' ? 'scripts' : base === '/analytics/datasets' ? 'datasets' : null
    const items: MenuItem[] = [
      { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: () => setEditing({ tabId: t.id, value: t.title ?? titleOf(t) }) },
      { kind: 'item', label: 'Duplicate', icon: Copy, onSelect: () => dispatch({ type: 'addTab', paneId: pane.id, tab: makeTab(t.path, t.title ? `${t.title} copy` : undefined) }) },
      ...(splits
        ? ([
            { kind: 'item', label: 'Split right with a copy', icon: Columns2, onSelect: () => dispatch({ type: 'split', paneId: pane.id, dir: 'row', tab: makeTab(t.path, t.title) }) },
            { kind: 'item', label: 'Split down with a copy', icon: Rows2, onSelect: () => dispatch({ type: 'split', paneId: pane.id, dir: 'col', tab: makeTab(t.path, t.title) }) },
          ] as MenuItem[])
        : []),
    ]
    if (kind) {
      // Saving is the tool's own Save; here, what was saved, to open beside this tab — a tab named after it.
      const of = { charts: { list: () => store.ofType(PLOT_TYPE), noun: 'chart', icon: BarChart3, fresh: '/analytics/charts?plot=new', param: 'plot' }, scripts: { list: () => scriptsIn(store), noun: 'script', icon: Code2, fresh: '/analytics/scripts', param: 'script' }, datasets: { list: () => datasetsIn(store), noun: 'dataset', icon: Table2, fresh: '/analytics/datasets/new', param: 'id' } }[kind]
      const saved = of.list().sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)).slice(0, 12)
      items.push({ kind: 'sep' }, { kind: 'item', label: `New ${of.noun}`, icon: of.icon, onSelect: () => dispatch({ type: 'addTab', paneId: pane.id, tab: makeTab(of.fresh) }) })
      if (saved.length) items.push({ kind: 'label', label: `Open a saved ${of.noun}` })
      for (const e of saved) items.push({ kind: 'item', label: displayLabel(e), onSelect: () => dispatch({ type: 'addTab', paneId: pane.id, tab: makeTab(`${base}?${of.param}=${encodeURIComponent(e.id)}`, displayLabel(e)) }) })
    }
    // A list tab is never closed: it closes the others, not itself.
    const closable = pane.tabs.filter((x) => !x.list)
    items.push(
      { kind: 'sep' },
      ...(t.list ? [] : ([{ kind: 'item', label: 'Close', shortcut: '⌘W', onSelect: () => dispatch({ type: 'closeTab', paneId: pane.id, tabId: t.id }) }] as MenuItem[])),
      { kind: 'item', label: t.list ? 'Close the open tabs' : 'Close others', disabled: !closable.some((x) => x.id !== t.id), onSelect: () => closable.filter((x) => x.id !== t.id).forEach((x) => dispatch({ type: 'closeTab', paneId: pane.id, tabId: x.id })) },
      { kind: 'item', label: 'Close tabs to the right', disabled: !pane.tabs.slice(index + 1).some((x) => !x.list), onSelect: () => pane.tabs.slice(index + 1).filter((x) => !x.list).forEach((x) => dispatch({ type: 'closeTab', paneId: pane.id, tabId: x.id })) },
    )
    return items
  }
  const commitTitle = () => {
    if (!editing) return
    dispatch({ type: 'retitle', paneId: pane.id, tabId: editing.tabId, title: editing.value })
    setEditing(null)
  }

  /** What an address names, when it names one thing: a hand-off, a type's page, an entity in the query or the path. */
  const itemTitle = useCallback(
    (path: string): string | undefined => {
      const picked = tabTitleFor(path)
      if (picked) return picked
      // A type's page (`/ontology/type/<type>`) shows the type's name.
      const typePage = /^\/ontology\/type\/([^/?#]+)/.exec(path)
      if (typePage) return registry.get(decodeURIComponent(typePage[1])).label
      // An item named in the query (`?plot=`, `?script=`, `?id=`, `?scene=`) shows the entity's label.
      const q = new URLSearchParams(path.split('#')[0].split('?')[1] ?? '')
      for (const k of ['plot', 'script', 'id', 'scene']) {
        const e = q.get(k) ? store.get(q.get(k)!) : undefined
        if (e) return displayLabel(e)
      }
      const parts = path.split('?')[0].split('/').filter(Boolean)
      const e = parts.length >= 2 ? store.get(parts[parts.length - 1]) : undefined
      return e ? displayLabel(e) : undefined
    },
    [store, registry],
  )
  const titleOf = useCallback(
    (t: Tab) => {
      if (t.title) return t.title
      if (t.list) return hostLists.find((l) => l.id === t.list)?.title ?? 'List'
      return itemTitle(t.path) ?? viewForPath(t.path)?.label ?? t.path
    },
    [itemTitle, hostLists],
  )

  const onDragStart = (e: DragEvent, t: Tab) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: pane.id, tabId: t.id }))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDrop = (e: DragEvent, index?: number) => {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    setOver(null)
    if (!raw) return
    e.preventDefault()
    const { from, tabId } = JSON.parse(raw) as { from: string; tabId: string }
    dispatch({ type: 'move', from, tabId, to: pane.id, index })
  }
  const allowDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) e.preventDefault()
  }

  // Tabs shown recently stay mounted behind the one in front, so coming back finds the view exactly as it was left —
  // its selection, scroll, inner tabs, camera. The least recently shown beyond the host's warmTabs are let go.
  const { warmTabs, splits, onLastTabClosed, lists } = useContext(HostOptions)
  const [warm, setWarm] = useState<string[]>([])
  useEffect(() => {
    if (tab) setWarm((w) => [...w.filter((id) => id !== tab.id), tab.id].slice(-Math.max(1, warmTabs)))
  }, [tab?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // A Unigraph tab is not kept warm (`unloadsBehind`): behind the front tab it would hold a whole graph engine.
  const mounted = pane.tabs.filter((t) => t.id === tab?.id || (warm.includes(t.id) && !unloadsBehind(t.path)))
  // A view that just came to the front re-measures: the renderers size themselves on window resize.
  useEffect(() => {
    const raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(raf)
  }, [tab?.id])
  const scope = useContext(HostScope)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const hosts = useRef(new Map<string, { onNavigate: (path: string, replace: boolean) => void; onGo: (delta: number) => void; host: PaneHost }>())
  const hostFor = (t: Tab, active: boolean) => {
    let h = hosts.current.get(t.id)
    if (!h || h.host.active !== active || h.host.title !== t.title) {
      // A path the host doesn't keep leaves for its own page — whether opened as a tab or navigated to in this one —
      // except from a list: whatever a section's list opens becomes a tab of the section, from whichever page it is.
      const outside = (path: string) => {
        const sc = scopeRef.current
        if (!sc || sc.keeps(path) || t.list) return false
        // A tab a list opened on another page (a Unigraph scene in Scenes) moves within that page as it likes — the
        // explorer turning `?scene=` into its session, say; only a way out to yet another page leaves.
        const page = (p: string) => p.split(/[?#]/)[0].split('/')[1]
        if (!sc.keeps(t.path) && page(path) === page(t.path)) return false
        sc.leave(path)
        return true
      }
      h = {
        // A list opening another page's view (a scene in Unigraph) names its tab now: that view may rewrite its own
        // address past naming it. The section's own items keep their live names.
        onNavigate: (path, replace) => outside(path) || dispatch({ type: 'navigate', paneId: pane.id, tabId: t.id, path, replace, ...(t.list && !scopeRef.current?.keeps(path) ? { title: itemTitle(path) } : {}) }),
        onGo: (delta) => dispatch({ type: 'go', paneId: pane.id, tabId: t.id, delta }),
        host: { paneId: pane.id, openTab: (path, title) => outside(path) || dispatch({ type: 'addTab', paneId: pane.id, tab: makeTab(path, title) }), active, title: t.title },
      }
      hosts.current.set(t.id, h)
    }
    return h
  }
  for (const id of [...hosts.current.keys()]) if (!mounted.some((t) => t.id === id)) hosts.current.delete(id)
  const onGo = useCallback((delta: number) => dispatch({ type: 'go', paneId: pane.id, tabId: tab.id, delta }), [dispatch, pane.id, tab.id])
  // The tabs scroll sideways when there are many: keep the active one in view — on arrival too, not only when it changes —
  // and show an arrow on whichever side has more tabs hidden.
  const stripRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.ws-tab.is-active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pane.active, pane.tabs.length])
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const measure = () => {
      const left = strip.scrollLeft > 1
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }))
    }
    measure()
    strip.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    for (const c of strip.children) ro.observe(c)
    return () => {
      strip.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [pane.tabs.length])
  const scrollTabs = (dir: -1 | 1) => stripRef.current?.scrollBy({ left: dir * Math.max(120, (stripRef.current.clientWidth * 2) / 3), behavior: scrollBehavior() })

  return (
    <section className={`ws-pane ${focused ? 'is-focused' : ''}`} onPointerDownCapture={() => !focused && dispatch({ type: 'focus', paneId: pane.id })}>
      <div className="ws-tabbar" onDragOver={allowDrop} onDrop={(e) => onDrop(e)}>
        {/* The strip and its overflow arrows: the arrows lie over the strip's ends, so they take no room and never shift the tabs. */}
        <div className="ws-tabs__wrap">
        <button className={`ws-tabs__more ws-tabs__more--left ${overflow.left ? 'is-on' : ''}`} title="More tabs to the left" aria-hidden={!overflow.left} tabIndex={overflow.left ? 0 : -1} onClick={() => scrollTabs(-1)} />
      <div ref={stripRef} className="ws-tabs">
        {pane.tabs.map((t, i) => {
          const v = viewForPath(t.path)
          const Icon = v?.icon
          return (
            <div
              key={t.id}
              className={`ws-tab ${i === pane.active ? 'is-active' : ''} ${over === i ? 'is-over' : ''} ${t.list ? 'is-list' : ''}`}
              draggable={!t.list}
              onDragStart={(e) => onDragStart(e, t)}
              onDragOver={(e) => (allowDrop(e), setOver(i))}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => (e.stopPropagation(), onDrop(e, i))}
              onClick={() => dispatch({ type: 'activate', paneId: pane.id, index: i })}
              onDoubleClick={() => setEditing({ tabId: t.id, value: t.title ?? titleOf(t) })}
              onAuxClick={(e) => e.button === 1 && !t.list && dispatch({ type: 'closeTab', paneId: pane.id, tabId: t.id })}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, tab: t, index: i })
              }}
              title={t.list ? `${t.path} · the list: what you open from it opens as a tab beside it` : `${t.path} · double-click to rename · right-click for more`}
            >
              {Icon && <Icon size={12} />}
              {editing?.tabId === t.id ? (
                <input
                  className="ws-tab__rename"
                  autoFocus
                  value={editing.value}
                  aria-label="Tab name"
                  onChange={(e) => setEditing({ tabId: t.id, value: e.target.value })}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTitle()
                    else if (e.key === 'Escape') setEditing(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <span className="ws-tab__label">{titleOf(t)}</span>
              )}
              {!t.list && (
                <button
                  className="ws-tab__x"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (onLastTabClosed && single && pane.tabs.length === 1) onLastTabClosed()
                    else dispatch({ type: 'closeTab', paneId: pane.id, tabId: t.id })
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )
        })}
      </div>
        <button className={`ws-tabs__more ws-tabs__more--right ${overflow.right ? 'is-on' : ''}`} title="More tabs to the right" aria-hidden={!overflow.right} tabIndex={overflow.right ? 0 : -1} onClick={() => scrollTabs(1)} />
        </div>
        {!lists.length && (
          <button className="ws-tabs__add" title="Add a view" onClick={(e) => onAddMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4, pane.id)}>
            <Plus size={13} />
          </button>
        )}
        <span className="spacer" />
        <button className="ws-tabs__btn" title="Back" disabled={!tab?.back.length} onClick={() => onGo(-1)}>
          <ArrowLeft size={12} />
        </button>
        <button className="ws-tabs__btn" title="Forward" disabled={!tab?.forward.length} onClick={() => onGo(1)}>
          <ArrowRight size={12} />
        </button>
        {splits && (
          <>
            <button className="ws-tabs__btn" title="Split right (⌘D)" onClick={() => dispatch({ type: 'split', paneId: pane.id, dir: 'row' })}>
              <Columns2 size={12} />
            </button>
            <button className="ws-tabs__btn" title="Split down (⌘⇧D)" onClick={() => dispatch({ type: 'split', paneId: pane.id, dir: 'col' })}>
              <Rows2 size={12} />
            </button>
          </>
        )}
        {!single && (
          <button className="ws-tabs__btn" title="Close pane (⌘⇧W)" onClick={() => dispatch({ type: 'closePane', paneId: pane.id })}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="ws-pane__body" onDragOver={allowDrop} onDrop={(e) => onDrop(e)}>
        {mounted.map((t) => {
          const active = t.id === tab?.id
          const h = hostFor(t, active)
          return (
            <div key={t.id} className="ws-pane__view" hidden={!active}>
              <PaneRouter path={t.path} onNavigate={h.onNavigate} onGo={h.onGo}>
                <PaneContext.Provider value={h.host}>
                  <ErrorBoundary what="This view" scope="workstation" key={t.path.split('?')[0].split('/').slice(0, 2).join('/')}>
                    <AppRoutes embedded />
                  </ErrorBoundary>
                </PaneContext.Provider>
              </PaneRouter>
            </div>
          )
        })}
      </div>
      {tabMenu && <Menu x={tabMenu.x} y={tabMenu.y} items={tabMenuItems(tabMenu.tab, tabMenu.index)} onClose={() => setTabMenu(null)} />}
    </section>
  )
}


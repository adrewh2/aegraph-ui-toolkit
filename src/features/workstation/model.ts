import type { ComponentType } from 'react'
import {
  BarChart3,
  BookOpen,
  Boxes,
  Code2,
  FileText,
  FlaskConical,
  GitFork,
  House,
  Image as ImageIcon,
  Map as MapIcon,
  MessagesSquare,
  Music as Audio,
  Network,
  ScanSearch,
  Table2,
  Video,
} from 'lucide-react'
import { UnigraphIcon } from '../../components/icons/UnigraphIcon'
import { modernGraphPath } from '../../app/routes'

/**
 * A workstation is a binary split tree (like iTerm2's panes). Leaves are
 * panes; each pane holds tabs; each tab is a view identified by an app
 * path with its own navigation history.
 */

export interface Tab {
  id: string
  /** Current app path, e.g. `/documents/abc?x=1`. */
  path: string
  /** Back stack (paths before `path`). */
  back: string[]
  forward: string[]
  /** Pinned title; otherwise derived from the path. */
  title?: string
  /**
   * A host's list tab (its `ListDef.id`): the section's index, which cannot be closed, stays at the front of its pane,
   * and hands whatever is opened from it to a tab of its own (`navigateInHost`).
   */
  list?: string
  /** The address the tab was opened on, when a view has since moved it (a scene opened in Unigraph becomes a session): the same item opened again finds it. */
  origin?: string
}

/**
 * One list a tabbed host keeps (`WorkstationProps.lists`): the index of a section — the documents, the charts. `is`
 * says whether a path is this list (a folder or a search inside it is still the list; `/documents/<id>` is an item).
 */
export interface ListDef {
  id: string
  path: string
  title: string
  is: (path: string) => boolean
}

const pathnameOf = (path: string) => path.split(/[?#]/)[0]
const paramsOf = (path: string) => new URLSearchParams(path.split('#')[0].split('?')[1] ?? '')
/** A list at `pathname`, as long as none of `itemParams` names an item in it (`/scenes?id=…` is a scene, not the list). */
export const listAt = (id: string, pathname: string, title = 'List', itemParams: string[] = []): ListDef => ({
  id,
  path: pathname,
  title,
  is: (path) => pathnameOf(path) === pathname && !itemParams.some((k) => paramsOf(path).has(k)),
})

export interface PaneNode {
  kind: 'pane'
  id: string
  tabs: Tab[]
  active: number
}

export interface SplitNode {
  kind: 'split'
  id: string
  /** `row` puts children side by side (a vertical divider); `col` stacks them. */
  dir: 'row' | 'col'
  children: [Node, Node]
  /** Share of the first child, 0–1. */
  ratio: number
}

export type Node = PaneNode | SplitNode

export interface Workstation {
  root: Node
  focused: string
}

let seq = 0
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`

export const makeTab = (path: string, title?: string): Tab => ({ id: uid('t'), path, back: [], forward: [], title })
export const makePane = (tabs: Tab[] = [makeTab('/')]): PaneNode => ({ kind: 'pane', id: uid('p'), tabs, active: 0 })

/**
 * Whether a tab already sits somewhere inside the address asked for — `/unigraph` against a tab on
 * `/unigraph/2d?session=k3f9`, `/entities` against `/entities?q=kepler`. A host reads the bare section (what the
 * sidebar links to) as "back to where I was": the tab keeps its deeper path and the address bar follows it,
 * rather than the tab being sent to the bare address, which would drop the part naming the view and the session
 * and make the page tear its picture down and build another on the way in. An address carrying a query or a
 * fragment of its own names a different place and is followed as one.
 */
export const pathWithin = (asked: string, tab: string) => !/[?#]/.test(asked) && tab.startsWith(asked) && /^[/?#]/.test(tab.slice(asked.length))

/**
 * The front door: one pane, Chats in front and the project's whole graph in 3D behind it (mounted only when first
 * shown, so the landing costs a chat list). What a new project, a cleared workstation and a first run open on.
 */
export const defaultWorkstation = (): Workstation => {
  const pane = makePane([makeTab('/chats', 'Chats'), makeTab('/unigraph/3d', 'Unigraph · 3D')])
  return { root: pane, focused: pane.id }
}

/**
 * The screen a first run opens on (see `providers.tsx`), whatever the default project's bundle carries: one pane, one
 * tab — by default the project's whole graph in 3D, unfiltered (`fresh`: not the last-used tab's filter), with the
 * force simulation running live (`physics`), so the site opens on a picture that is already moving. A deployment
 * whose default demo ships a scene for its first picture (settled positions, its own force settings) names that
 * scene's address instead (`DEFAULT_DEMO_TAB`): it opens in shape, and the simulation carries on from there.
 */
export const FIRST_RUN_TAB = { path: '/unigraph/3d?physics=1&fresh=1', title: 'Unigraph · 3D' }
export const firstRunWorkstation = (tab: { path: string; title: string } = FIRST_RUN_TAB): Workstation => {
  const pane = makePane([makeTab(tab.path, tab.title)])
  return { root: pane, focused: pane.id }
}

// ── Tree helpers ───────────────────────────────────────────────────────

export function panes(n: Node): PaneNode[] {
  return n.kind === 'pane' ? [n] : [...panes(n.children[0]), ...panes(n.children[1])]
}

export function findPane(n: Node, id: string): PaneNode | undefined {
  return panes(n).find((p) => p.id === id)
}

/** Apply `f` to every node, bottom-up. `f` sees a node whose children were already mapped. */
function mapTree(n: Node, f: (n: Node) => Node): Node {
  if (n.kind === 'split') return f({ ...n, children: [mapTree(n.children[0], f), mapTree(n.children[1], f)] })
  return f(n)
}

/** Swap the node with `id` for `replacement` (which is not descended into). */
function replaceNode(n: Node, id: string, replacement: Node): Node {
  if (n.id === id) return replacement
  if (n.kind === 'split') return { ...n, children: [replaceNode(n.children[0], id, replacement), replaceNode(n.children[1], id, replacement)] }
  return n
}

export function updatePane(ws: Workstation, id: string, f: (p: PaneNode) => PaneNode): Workstation {
  return { ...ws, root: mapTree(ws.root, (n) => (n.kind === 'pane' && n.id === id ? f(n) : n)) }
}

/** Split a pane; the new pane goes right (row) or below (col) and takes focus. */
export function splitPane(ws: Workstation, id: string, dir: 'row' | 'col', tab?: Tab): Workstation {
  const fresh = makePane([tab ?? makeTab('/')])
  const target = findPane(ws.root, id)
  if (!target) return ws
  const root = replaceNode(ws.root, id, { kind: 'split', id: uid('s'), dir, ratio: 0.5, children: [target, fresh] } as SplitNode)
  return { root, focused: fresh.id }
}

/** Remove a pane; its sibling takes its place. The last pane can't be closed. */
export function closePane(ws: Workstation, id: string): Workstation {
  if (ws.root.kind === 'pane') return ws
  const remove = (n: Node): Node => {
    if (n.kind === 'pane') return n
    if (n.children[0].kind === 'pane' && n.children[0].id === id) return remove(n.children[1])
    if (n.children[1].kind === 'pane' && n.children[1].id === id) return remove(n.children[0])
    return { ...n, children: [remove(n.children[0]), remove(n.children[1])] }
  }
  const root = remove(ws.root)
  const remaining = panes(root)
  return { root, focused: remaining.some((p) => p.id === ws.focused) ? ws.focused : remaining[0].id }
}

export function setRatio(ws: Workstation, splitId: string, ratio: number): Workstation {
  return { ...ws, root: mapTree(ws.root, (n) => (n.kind === 'split' && n.id === splitId ? { ...n, ratio: clampRatio(ratio, n.ratio) } : n)) }
}
/** Dividers stop a tenth from either edge; a ratio that is not a number (a drag that divided by zero, a stored junk value) is left as it was. */
const clampRatio = (ratio: unknown, fallback: number) => (typeof ratio === 'number' && Number.isFinite(ratio) ? Math.max(0.1, Math.min(0.9, ratio)) : fallback)

export function addTab(ws: Workstation, paneId: string, tab: Tab): Workstation {
  return { ...updatePane(ws, paneId, (p) => ({ ...p, tabs: [...p.tabs, tab], active: p.tabs.length })), focused: paneId }
}

/** A tab's own name, shown instead of the view's or the entity's; empty or undefined goes back to the derived title. */
export function retitleTab(ws: Workstation, paneId: string, tabId: string, title: string | undefined): Workstation {
  const t = title?.trim()
  return updatePane(ws, paneId, (p) => ({ ...p, tabs: p.tabs.map((x) => (x.id === tabId ? { ...x, title: t || undefined } : x)) }))
}

/** `fallbackPath` is what the last pane shows once its last tab closes (a host of one kind of view keeps that kind). A list tab stays. */
export function closeTab(ws: Workstation, paneId: string, tabId: string, fallbackPath = '/'): Workstation {
  const pane = findPane(ws.root, paneId)
  if (!pane) return ws
  const idx = pane.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0 || pane.tabs[idx].list) return ws
  const tabs = pane.tabs.filter((t) => t.id !== tabId)
  if (tabs.length === 0) return panes(ws.root).length > 1 ? closePane(ws, paneId) : updatePane(ws, paneId, (p) => ({ ...p, tabs: [makeTab(fallbackPath)], active: 0 }))
  return updatePane(ws, paneId, (p) => ({ ...p, tabs, active: Math.min(idx <= p.active ? Math.max(0, p.active - (idx < p.active ? 1 : 0)) : p.active, tabs.length - 1) }))
}

export function activateTab(ws: Workstation, paneId: string, index: number): Workstation {
  return { ...updatePane(ws, paneId, (p) => ({ ...p, active: Math.max(0, Math.min(p.tabs.length - 1, index)) })), focused: paneId }
}

/** Move a tab to another pane (or reorder within one). */
export function moveTab(ws: Workstation, fromPane: string, tabId: string, toPane: string, toIndex?: number): Workstation {
  const src = findPane(ws.root, fromPane)
  const tab = src?.tabs.find((t) => t.id === tabId)
  // A destination that is not there would swallow the tab: the close below has nowhere to put it.
  if (!src || !tab || !findPane(ws.root, toPane)) return ws
  if (fromPane === toPane) {
    const rest = src.tabs.filter((t) => t.id !== tabId)
    const at = Math.max(0, Math.min(rest.length, toIndex ?? rest.length))
    rest.splice(at, 0, tab)
    return updatePane(ws, fromPane, (p) => ({ ...p, tabs: rest, active: at }))
  }
  let next = closeTab(ws, fromPane, tabId)
  next = updatePane(next, toPane, (p) => {
    const tabs = [...p.tabs]
    const at = Math.max(0, Math.min(tabs.length, toIndex ?? tabs.length))
    tabs.splice(at, 0, tab)
    return { ...p, tabs, active: at }
  })
  return { ...next, focused: toPane }
}

/** Navigate the active tab of a pane; records history. */
export function navigateTab(ws: Workstation, paneId: string, tabId: string, path: string, replace = false): Workstation {
  return updatePane(ws, paneId, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id !== tabId || t.path === path ? t : replace ? { ...t, path } : { ...t, back: [...t.back.slice(-49), t.path], forward: [], path })),
  }))
}

export function goTab(ws: Workstation, paneId: string, tabId: string, delta: number): Workstation {
  return updatePane(ws, paneId, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => {
      if (t.id !== tabId) return t
      if (delta < 0 && t.back.length) return { ...t, forward: [t.path, ...t.forward], path: t.back[t.back.length - 1], back: t.back.slice(0, -1) }
      if (delta > 0 && t.forward.length) return { ...t, back: [...t.back, t.path], path: t.forward[0], forward: t.forward.slice(1) }
      return t
    }),
  }))
}

// ── Lists: a section's index as a tab that stays ─────────────────────────

/** Where a host's tab is: its pane and index. */
function locate(ws: Workstation, match: (t: Tab) => boolean): { pane: PaneNode; index: number } | undefined {
  for (const pane of panes(ws.root)) {
    const index = pane.tabs.findIndex(match)
    if (index >= 0) return { pane, index }
  }
  return undefined
}

/** Bring a tab to the front of its pane and focus the pane. */
function show(ws: Workstation, at: { pane: PaneNode; index: number }): Workstation {
  return activateTab(ws, at.pane.id, at.index)
}

/** The list a path is, if any. */
export const listFor = (lists: ListDef[], path: string) => lists.find((l) => l.is(path))

/**
 * Keep a host's lists in place: every list has exactly one tab, marked, at the front of its pane (in the lists' order);
 * one that is missing — a fresh host, an old arrangement, a pane closed with it — comes back at the front of the first
 * pane on its own address. A tab that already shows a list but is not marked becomes it. Returns `ws` itself when
 * nothing had to change.
 */
export function ensureLists(ws: Workstation, lists: ListDef[]): Workstation {
  if (!lists.length) return ws
  let next = ws
  // A duplicate mark (two tabs claiming one list, in any panes) keeps the first; a mark of no list is dropped.
  const claimed = new Set<string>()
  for (const pane of panes(next.root)) {
    const drop = pane.tabs.filter((t) => t.list && (claimed.has(t.list) || !lists.some((l) => l.id === t.list) || (claimed.add(t.list), false)))
    if (drop.length) next = updatePane(next, pane.id, (p) => ({ ...p, tabs: p.tabs.map((t) => (drop.includes(t) ? { ...t, list: undefined } : t)) }))
  }
  for (const l of lists) {
    const marked = locate(next, (t) => t.list === l.id)
    if (marked) continue
    const shows = locate(next, (t) => !t.list && l.is(t.path))
    if (shows) next = updatePane(next, shows.pane.id, (p) => ({ ...p, tabs: p.tabs.map((t, i) => (i === shows.index ? { ...t, list: l.id } : t)) }))
    else {
      const first = panes(next.root)[0]
      next = updatePane(next, first.id, (p) => ({ ...p, tabs: [{ ...makeTab(l.path), list: l.id }, ...p.tabs], active: p.active + 1 }))
    }
  }
  // Lists first in each pane, in the lists' order; the active tab stays the same tab.
  const order = (t: Tab) => (t.list ? lists.findIndex((l) => l.id === t.list) : lists.length)
  for (const pane of panes(next.root)) {
    const sorted = [...pane.tabs].sort((a, b) => order(a) - order(b))
    if (sorted.some((t, i) => t !== pane.tabs[i])) {
      const active = pane.tabs[pane.active]
      next = updatePane(next, pane.id, (p) => ({ ...p, tabs: sorted, active: Math.max(0, sorted.indexOf(active)) }))
    }
  }
  return next
}

/**
 * Open `path` in a host with lists: a list comes to the front on it (navigated there unless it already is), an item
 * goes to the tab that shows it or to a new one beside the list — never into the list's own tab. `paneId` is where a
 * new item tab goes (default: the focused pane).
 */
export function openInHost(ws: Workstation, lists: ListDef[], path: string, opts: { paneId?: string; title?: string; replace?: boolean; tab?: Tab } = {}): Workstation {
  const l = listFor(lists, path)
  if (l) {
    const at = locate(ws, (t) => t.list === l.id)
    if (at) {
      const shown = show(ws, at)
      // The bare list (the sidebar's link) finds the list as it was left — its folder, its search.
      const was = at.pane.tabs[at.index].path
      return was === path || pathWithin(path, was) ? shown : navigateTab(shown, at.pane.id, at.pane.tabs[at.index].id, path, opts.replace ?? true)
    }
  }
  const open = locate(ws, (t) => !t.list && (t.path === path || t.origin === path))
  if (open) return show(ws, open)
  const paneId = opts.paneId && findPane(ws.root, opts.paneId) ? opts.paneId : ws.focused
  return addTab(ws, paneId, { ...(opts.tab ?? makeTab(path, opts.title)), origin: path })
}

/**
 * A tab navigating in a host with lists. A list tab that is sent to an item opens the item beside it and stays the
 * list; any tab sent to a list brings that list's tab forward (and leaves itself as it was); otherwise the tab moves,
 * as any tab does.
 */
export function navigateInHost(ws: Workstation, lists: ListDef[], paneId: string, tabId: string, path: string, replace = false, title?: string): Workstation {
  const tab = findPane(ws.root, paneId)?.tabs.find((t) => t.id === tabId)
  if (!tab) return ws
  const target = listFor(lists, path)
  if (tab.list) {
    if (target?.id === tab.list) return navigateTab(ws, paneId, tabId, path, replace)
    return openInHost(ws, lists, path, { paneId, title })
  }
  if (target) return openInHost(ws, lists, path)
  return navigateTab(ws, paneId, tabId, path, replace)
}

// ── Views ──────────────────────────────────────────────────────────────

export interface ViewDef {
  id: string
  label: string
  path: string
  section: 'Resources' | 'Entities' | 'Display' | 'Build'
  icon: ComponentType<{ size?: number }>
}

export const VIEWS: ViewDef[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/', section: 'Build', icon: House },
  { id: 'documents', label: 'Documents', path: '/documents', section: 'Resources', icon: FileText },
  { id: 'diagrams', label: 'Diagrams', path: '/diagrams', section: 'Resources', icon: GitFork },
  { id: 'images', label: 'Images', path: '/images', section: 'Resources', icon: ImageIcon },
  { id: 'videos', label: 'Videos', path: '/videos', section: 'Resources', icon: Video },
  { id: 'audio', label: 'Audio', path: '/audio', section: 'Resources', icon: Audio },
  { id: 'maps', label: 'Maps', path: '/maps', section: 'Resources', icon: MapIcon },
  { id: 'chats', label: 'Chats', path: '/chats', section: 'Build', icon: MessagesSquare },
  { id: 'entities', label: 'Entities', path: '/entities', section: 'Entities', icon: Boxes },
  { id: 'ontology', label: 'Ontology', path: '/ontology', section: 'Entities', icon: Network },
  { id: 'unigraph2d', label: 'Unigraph · 2D', path: '/unigraph/2d', section: 'Display', icon: UnigraphIcon },
  { id: 'unigraph3d', label: 'Unigraph · 3D', path: '/unigraph/3d', section: 'Display', icon: UnigraphIcon },
  { id: 'display', label: 'Scenes', path: '/scenes', section: 'Display', icon: ScanSearch },
  { id: 'charts', label: 'Charts', path: '/analytics/charts', section: 'Display', icon: BarChart3 },
  { id: 'scripts', label: 'Scripts', path: '/analytics/scripts', section: 'Display', icon: Code2 },
  { id: 'datasets', label: 'Datasets', path: '/analytics/datasets', section: 'Display', icon: Table2 },
  // The Projects dialog, opened over the Dashboard — not the datasets of Analytics.
  { id: 'data', label: 'Projects dialog', path: '/datasets', section: 'Build', icon: FlaskConical },
  { id: 'docs', label: 'Documentation', path: '/docs', section: 'Build', icon: BookOpen },
]

/** The registered view a path belongs to (longest prefix wins). */
export function viewForPath(path: string): ViewDef | undefined {
  const p = path.split('?')[0]
  return [...VIEWS].sort((a, b) => b.path.length - a.path.length).find((v) => (v.path === '/' ? p === '/' : p === v.path || p.startsWith(v.path + '/')))
}

// ── Serialisation ──────────────────────────────────────────────────────

/** Strip per-tab history so presets stay small and portable. */
export function toPreset(ws: Workstation): Workstation {
  const strip = (n: Node): Node => (n.kind === 'pane' ? { ...n, tabs: n.tabs.map((t) => ({ ...t, back: [], forward: [] })) } : { ...n, children: [strip(n.children[0]), strip(n.children[1])] })
  return { root: strip(ws.root), focused: ws.focused }
}

/** Re-mint ids so a preset can be loaded twice without collisions, and repair anything missing. `keepIds` keeps the stored ids (a tool editing a stored arrangement between reads). */
export function fromPreset(raw: unknown, opts: { keepIds?: boolean } = {}): Workstation | undefined {
  const w = raw as Partial<Workstation> | undefined
  if (!w?.root) return undefined
  const id = (kind: string, old: unknown) => (opts.keepIds && typeof old === 'string' && old ? old : uid(kind))
  const fix = (n: Node): Node => {
    if (n.kind === 'pane') {
      const tabs = (n.tabs ?? []).filter((t) => typeof t?.path === 'string').map((t) => ({ id: id('t', t.id), path: modernGraphPath(t.path), title: t.title, back: [], forward: [], ...(typeof t.list === 'string' ? { list: t.list } : {}), ...(typeof t.origin === 'string' ? { origin: t.origin } : {}) }))
      return { kind: 'pane', id: id('p', n.id), tabs: tabs.length ? tabs : [makeTab('/')], active: Math.max(0, Math.min(n.active ?? 0, Math.max(0, tabs.length - 1))) }
    }
    return { kind: 'split', id: id('s', n.id), dir: n.dir === 'col' ? 'col' : 'row', ratio: clampRatio(n.ratio, 0.5), children: [fix(n.children[0]), fix(n.children[1])] }
  }
  try {
    const root = fix(w.root)
    const ps = panes(root)
    return { root, focused: opts.keepIds && ps.some((p) => p.id === w.focused) ? w.focused! : ps[0].id }
  } catch {
    return undefined
  }
}

export function describeWorkstation(ws: Workstation): string {
  const ps = panes(ws.root)
  const tabs = ps.reduce((n, p) => n + p.tabs.length, 0)
  return `${ps.length} pane${ps.length === 1 ? '' : 's'} · ${tabs} tab${tabs === 1 ? '' : 's'}`
}

export const PRESETS: { id: string; label: string; description: string; build: () => Workstation }[] = [
  {
    id: 'research',
    label: 'Research',
    description: 'Documents beside the graph, entities below.',
    build: () => {
      const docs = makePane([makeTab('/documents')])
      const graph = makePane([makeTab('/unigraph/2d')])
      const ents = makePane([makeTab('/entities'), makeTab('/entities?category=relationships')])
      return { root: { kind: 'split', id: uid('s'), dir: 'row', ratio: 0.45, children: [docs, { kind: 'split', id: uid('s'), dir: 'col', ratio: 0.6, children: [graph, ents] }] }, focused: docs.id }
    },
  },
  {
    id: 'curate',
    label: 'Curate',
    description: 'Resources, knowledge entities, and types side by side.',
    build: () => {
      const a = makePane([makeTab('/entities?category=resource')])
      const b = makePane([makeTab('/entities?category=knowledge')])
      const c = makePane([makeTab('/entities?category=types'), makeTab('/entities?category=tags')])
      return { root: { kind: 'split', id: uid('s'), dir: 'row', ratio: 0.34, children: [a, { kind: 'split', id: uid('s'), dir: 'row', ratio: 0.5, children: [b, c] }] }, focused: a.id }
    },
  },
  {
    id: 'media',
    label: 'Media review',
    description: 'Video and audio players with diagrams underneath.',
    build: () => {
      const v = makePane([makeTab('/videos')])
      const m = makePane([makeTab('/audio')])
      const d = makePane([makeTab('/diagrams')])
      return { root: { kind: 'split', id: uid('s'), dir: 'col', ratio: 0.6, children: [{ kind: 'split', id: uid('s'), dir: 'row', ratio: 0.5, children: [v, m] }, d] }, focused: v.id }
    },
  },
  {
    id: 'single',
    label: 'Single pane',
    description: 'One pane, tabs only.',
    build: () => {
      const p = makePane([makeTab('/')])
      return { root: p, focused: p.id }
    },
  },
]

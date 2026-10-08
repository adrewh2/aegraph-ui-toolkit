import { defaultWorkstation, ensureLists, listAt, makePane, makeTab, panes, toPreset, fromPreset, type ListDef, type Tab, type Workstation } from './model'
import { pathOff } from '../../app/features'

/**
 * The pane hosts of the app, addressable by name: the workstation page and
 * the tabbed pages, each remembering its arrangement under its own storage
 * key. Entities and Unigraph are tabs of one view; the sections — the
 * Resources pages, Ontology, Projects, and Analytics' Scenes, Scripts,
 * Datasets and Charts — keep their
 * index as a **list** tab (`lists`) that stays at the front and cannot be
 * closed, and open what is picked in it as tabs beside it. A mounted host
 * registers a handle here so tools can open, close and switch its tabs; a
 * host that is not mounted is changed through its stored arrangement, which
 * it reads when it next mounts.
 */

export type HostName = 'workstation' | 'entities' | 'unigraph' | 'charts' | 'scripts' | 'datasets' | 'documents' | 'diagrams' | 'images' | 'videos' | 'audio' | 'maps' | 'scenes' | 'ontology' | 'projects'

export interface HostDef {
  key: string
  /** The page the host lives on. */
  route: string
  initial: () => Workstation
  /** The paths the host keeps as tabs; anything else leaves for its own page. Default: `route` and below. */
  keeps?: (path: string) => boolean
  /** The section's lists, each a tab that stays (see `ListDef`). */
  lists?: ListDef[]
}

const oneTab = (path: string) => (): Workstation => {
  const pane = makePane([makeTab(path)])
  return { root: pane, focused: pane.id }
}
/** A section host: its lists and nothing else, the first in front. */
const listsOnly = (lists: ListDef[]) => (): Workstation => {
  const pane = makePane([makeTab(lists[0].path)])
  return ensureLists({ root: pane, focused: pane.id }, lists)
}
/** A path at `route` or below it. */
export const under = (route: string) => (path: string) => path === route || /^[/?#]/.test(path.slice(route.length)) && path.startsWith(route)
/** A section whose list is its bare address and whose items are addresses below it: `/documents`, `/documents/<id>`. */
const section = (name: string, route: string, itemParams: string[] = []): HostDef => {
  const lists = [listAt(name, route, 'List', itemParams)]
  return { key: `aegraph:${name}:v1`, route, keeps: under(route), lists, initial: listsOnly(lists) }
}

export const HOSTS: Record<HostName, HostDef> = {
  workstation: { key: 'aegraph:workstation:v1', route: '/workstation', initial: defaultWorkstation },
  entities: { key: 'aegraph:entities:v1', route: '/entities', initial: oneTab('/entities') },
  unigraph: { key: 'aegraph:unigraph:v1', route: '/unigraph', initial: oneTab('/unigraph/2d') },
  // Analytics' three are sections of their own, as the sidebar lists them: a chart, a script or a dataset opens beside its list.
  charts: section('charts', '/analytics/charts', ['plot']),
  scripts: section('scripts', '/analytics/scripts', ['script']),
  datasets: section('datasets', '/analytics/datasets', ['id']),
  documents: section('documents', '/documents'),
  diagrams: section('diagrams', '/diagrams'),
  images: section('images', '/images'),
  videos: section('videos', '/videos'),
  audio: section('audio', '/audio'),
  maps: section('maps', '/maps'),
  scenes: section('scenes', '/scenes', ['id']),
  ontology: section('ontology', '/ontology'),
  projects: section('projects', '/projects'),
}

/** The host a path belongs to (the workstation page takes any path, so it is never the answer here). */
export function hostForPath(path: string): HostName | undefined {
  return HOST_NAMES.find((n) => n !== 'workstation' && (HOSTS[n].keeps ?? under(HOSTS[n].route))(path))
}

/** The hosts this deployment has: a section of a feature it turned off (`app/features.ts`) is not one. */
export const HOST_NAMES = (Object.keys(HOSTS) as HostName[]).filter((n) => !pathOff(HOSTS[n].route))

/** The commands a host takes from outside; the same shapes as the host's own actions. */
export type HostCommand =
  | { type: 'addTab'; paneId: string; tab: Tab }
  | { type: 'closeTab'; paneId: string; tabId: string }
  | { type: 'activate'; paneId: string; index: number }
  | { type: 'retitle'; paneId: string; tabId: string; title?: string }
  | { type: 'split'; paneId: string; dir: 'row' | 'col'; tab?: Tab }
  | { type: 'focus'; paneId: string }

export interface HostHandle {
  key: string
  get: () => Workstation
  run: (cmd: HostCommand) => void
}

const mounted = new Map<string, HostHandle>()

export function registerHost(h: HostHandle): () => void {
  mounted.set(h.key, h)
  return () => {
    if (mounted.get(h.key) === h) mounted.delete(h.key)
  }
}

export const mountedHost = (key: string) => mounted.get(key)

/** The stored arrangement of a host, or its initial one. */
export function storedWorkstation(def: HostDef): { ws: Workstation; presetId?: string; dirty: boolean } {
  try {
    const raw = localStorage.getItem(def.key)
    if (raw) {
      const saved = JSON.parse(raw) as { ws: unknown; presetId?: string; dirty?: boolean }
      const ws = fromPreset(saved.ws, { keepIds: true })
      if (ws) return { ws, presetId: saved.presetId, dirty: !!saved.dirty }
    }
  } catch {
    /* ignore */
  }
  return { ws: def.initial(), dirty: false }
}

export function writeStoredWorkstation(def: HostDef, next: { ws: Workstation; presetId?: string; dirty: boolean }) {
  try {
    localStorage.setItem(def.key, JSON.stringify({ ws: toPreset(next.ws), presetId: next.presetId, dirty: next.dirty }))
  } catch {
    /* ignore */
  }
}

/** A host's tabs, pane by pane, for tools and status. */
export function describeHost(ws: Workstation) {
  return panes(ws.root).map((p) => ({ pane: p.id, focused: p.id === ws.focused, active: p.tabs[p.active]?.id, tabs: p.tabs.map((t) => ({ id: t.id, path: t.path, title: t.title, ...(t.list ? { list: true } : {}) })) }))
}

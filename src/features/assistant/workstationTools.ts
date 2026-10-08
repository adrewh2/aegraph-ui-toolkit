import { modernGraphPath } from '../../app/routes'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { entityHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { addTab, activateTab, closeTab, ensureLists, findPane, makeTab, openInHost, panes, retitleTab, splitPane } from '../workstation/model'
import { describeHost, HOST_NAMES, hostForPath, HOSTS, mountedHost, storedWorkstation, writeStoredWorkstation, type HostCommand, type HostName } from '../workstation/hosts'
import { json, requireEntity } from './toolkit'
import type { AppHost } from './tools'

/**
 * The pane hosts — the workstation page, Entities and Unigraph, and the
 * sections (Documents, Diagrams, Images, Videos, Audio, Maps, Scenes,
 * Scripts, Datasets, Charts, Ontology, Projects), each with its list as an
 * inner tab that stays —
 * as a tool: list their tabs, open a path or an entity as a tab (a document
 * beside the Documents list, a chart in Analytics), close and switch tabs,
 * split. A host on screen changes live; one that is not gets its stored
 * arrangement changed and shows it when opened.
 */

export function createWorkstationTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  /** Read a host's arrangement and apply a change to it, live or stored. */
  const change = (name: HostName, f: (cmd: (c: HostCommand) => void, ws: () => ReturnType<typeof storedWorkstation>['ws']) => void) => {
    const def = HOSTS[name]
    const live = mountedHost(def.key)
    if (live) {
      f(live.run, live.get)
      return { live: true, tabs: describeHost(live.get()) }
    }
    const saved = storedWorkstation(def)
    const lists = def.lists ?? []
    let ws = ensureLists(saved.ws, lists)
    f(
      (c) => {
        // A section: an item goes beside its list (or to its open tab), a list comes forward — as the live host does.
        if (c.type === 'addTab') ws = lists.length ? openInHost(ws, lists, c.tab.path, { paneId: c.paneId, tab: c.tab }) : addTab(ws, c.paneId, c.tab)
        else if (c.type === 'closeTab') ws = closeTab(ws, c.paneId, c.tabId, panes(def.initial().root)[0].tabs[0].path)
        else if (c.type === 'activate') ws = activateTab(ws, c.paneId, c.index)
        else if (c.type === 'retitle') ws = retitleTab(ws, c.paneId, c.tabId, c.title)
        else if (c.type === 'split') ws = splitPane(ws, c.paneId, c.dir, c.tab)
        else if (c.type === 'focus') ws = { ...ws, focused: c.paneId }
      },
      () => ws,
    )
    writeStoredWorkstation(def, { ws, presetId: saved.presetId, dirty: true })
    return { live: false, tabs: describeHost(ws) }
  }

  const workstation = betaTool({
    name: 'workstation',
    description:
      'The pane hosts: the workstation page (`workstation`), the tabbed pages `entities` and `unigraph` (the graph explorer), and the sections — `documents`, `diagrams`, `images`, `videos`, `audio`, `maps`, `scenes`, `scripts`, `datasets`, `charts`, `ontology`, `projects` — each of which keeps its list as an inner tab at the front that cannot be closed and opens what is picked from it (a document, a map, a chart) as an inner tab beside it. Opening a list\'s own address brings that list forward rather than adding a tab; an item already open comes forward rather than opening twice. Actions: state (every host\'s panes and tabs, and which are on screen), open_tab (a new tab in a host: give `path`, or `entity` — a chart opens as a Charts tab, a script as a Scripts tab, anything else where it is browsed; `title` names the tab; `pane` picks the pane, default the focused one; `split` puts it in a new pane beside it; `go` shows the host page afterwards), close_tab (`tab` id), activate (`tab` id: bring it to the front), retitle (`tab`, `title`). A host on screen changes live; otherwise its stored arrangement is changed and shows when the page opens. Charts, scripts and datasets are paths like /analytics/charts?plot=<id>, /analytics/scripts?script=<id>, /analytics/datasets?id=<id>; /analytics/charts?plot=new is a blank chart.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['state', 'open_tab', 'close_tab', 'activate', 'retitle'] },
        host: { type: 'string', enum: HOST_NAMES, description: 'Which host (default: the section the path belongs to, else workstation)' },
        path: { type: 'string', description: 'open_tab: the view to open, e.g. /analytics/charts?plot=<id>' },
        entity: { type: 'string', description: 'open_tab: an entity id to open where it lives (a chart → Charts tab, a script → Scripts tab)' },
        title: { type: 'string', description: 'open_tab/retitle: the tab\'s name (default: the view\'s own)' },
        pane: { type: 'string', description: 'open_tab: pane id (default: the focused pane)' },
        split: { type: 'string', enum: ['row', 'col'], description: 'open_tab: open in a new pane split off beside (row) or below (col) the pane' },
        tab: { type: 'string', description: 'close_tab/activate/retitle: the tab id (from state or open_tab), or the tab\'s path' },
        go: { type: 'boolean', description: 'open_tab/activate: navigate to the host page afterwards (default true for open_tab)' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: ({ action, host: hostName, path, entity, title, pane, split, tab, go }) => {
      if (action === 'state') {
        return json(
          Object.fromEntries(
            HOST_NAMES.map((n) => {
              const def = HOSTS[n]
              const live = mountedHost(def.key)
              return [n, { route: def.route, mounted: !!live, panes: describeHost(live ? live.get() : storedWorkstation(def).ws) }]
            }),
          ),
        )
      }
      if (action === 'open_tab') {
        let target = path
        let label = title
        if (entity) {
          const e = requireEntity(store, entity)
          target = entityHref(e, registry())
          label ??= displayLabel(e)
        }
        if (!target) throw new Error('open_tab needs a path or an entity.')
        target = modernGraphPath(target)
        const name = hostName ?? hostForPath(target) ?? 'workstation'
        const def = HOSTS[name]
        if (name !== 'workstation' && !target.startsWith(def.route)) throw new Error(`The ${name} host holds ${def.route} views only; use host "workstation" for ${target}.`)
        const newTab = makeTab(target, label)
        const res = change(name, (cmd, ws) => {
          const w = ws()
          const paneId = pane && findPane(w.root, pane) ? pane : w.focused
          if (split) cmd({ type: 'split', paneId, dir: split, tab: newTab })
          else cmd({ type: 'addTab', paneId, tab: newTab })
        })
        if (go ?? true) host.navigate(def.route)
        // In a section the path may have gone to a tab already there (its list, or the item open before): report that one.
        const holder = res.tabs.flatMap((p) => p.tabs).find((t) => t.id === newTab.id) ?? res.tabs.flatMap((p) => p.tabs).find((t) => t.path === target)
        return json({ host: name, tab: { id: holder?.id ?? newTab.id, path: holder?.path ?? target, title: label }, ...res })
      }
      if (!tab) throw new Error(`${action} needs a tab id (see state).`)
      const name = hostName ?? 'workstation'
      const def = HOSTS[name]
      // A tab by id (from state or open_tab), else by its path — a host that mounts re-mints its ids.
      const find = (ws: ReturnType<typeof storedWorkstation>['ws']) => {
        for (const by of [(t: { id: string; path: string }) => t.id === tab, (t: { id: string; path: string }) => t.path === tab]) {
          for (const p of panes(ws.root)) {
            const i = p.tabs.findIndex(by)
            if (i >= 0) return { paneId: p.id, index: i, tabId: p.tabs[i].id }
          }
        }
        throw new Error(`No tab ${tab} in ${name}.`)
      }
      const res = change(name, (cmd, ws) => {
        const at = find(ws())
        if (action === 'close_tab') cmd({ type: 'closeTab', paneId: at.paneId, tabId: at.tabId })
        else if (action === 'activate') {
          cmd({ type: 'focus', paneId: at.paneId })
          cmd({ type: 'activate', paneId: at.paneId, index: at.index })
        } else if (action === 'retitle') cmd({ type: 'retitle', paneId: at.paneId, tabId: at.tabId, title: title || undefined })
      })
      if (action === 'activate' && go) host.navigate(def.route)
      return json({ host: name, action, tab, ...res })
    },
  })

  return [workstation]
}

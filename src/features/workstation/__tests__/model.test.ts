import { describe, expect, it } from 'vitest'
import { activateTab, addTab, closePane, closeTab, defaultWorkstation, firstRunWorkstation, fromPreset, goTab, makePane, makeTab, moveTab, navigateTab, panes, pathWithin, retitleTab, setRatio, splitPane, toPreset, viewForPath, type Workstation } from '../model'

const single = (): Workstation => {
  const p = makePane([makeTab('/documents'), makeTab('/graph/2d')])
  return { root: p, focused: p.id }
}

describe('workstation tree', () => {
  it('splits and closes panes', () => {
    let ws = single()
    const first = ws.focused
    ws = splitPane(ws, first, 'row')
    expect(ws.root.kind).toBe('split')
    expect(panes(ws.root).length).toBe(2)
    expect(ws.focused).not.toBe(first)
    const second = ws.focused
    ws = splitPane(ws, second, 'col', makeTab('/knowledge'))
    expect(panes(ws.root).length).toBe(3)
    expect(panes(ws.root)[2].tabs[0].path).toBe('/knowledge')
    ws = closePane(ws, second)
    expect(panes(ws.root).length).toBe(2)
    expect(panes(ws.root).map((p) => p.id)).toContain(first)
    ws = closePane(ws, ws.focused)
    ws = closePane(ws, ws.focused) // last pane stays
    expect(panes(ws.root).length).toBe(1)
  })

  it('manages tabs', () => {
    let ws = single()
    const id = ws.focused
    ws = addTab(ws, id, makeTab('/tags'))
    expect(panes(ws.root)[0].tabs.length).toBe(3)
    expect(panes(ws.root)[0].active).toBe(2)
    ws = activateTab(ws, id, 0)
    ws = closeTab(ws, id, panes(ws.root)[0].tabs[0].id)
    expect(panes(ws.root)[0].tabs.map((t) => t.path)).toEqual(['/graph/2d', '/tags'])
    expect(panes(ws.root)[0].active).toBe(0)
    ws = closeTab(ws, id, panes(ws.root)[0].tabs[0].id)
    ws = closeTab(ws, id, panes(ws.root)[0].tabs[0].id)
    expect(panes(ws.root)[0].tabs.map((t) => t.path)).toEqual(['/'])
  })

  it('names tabs, and a host of one kind of view refills with that kind', () => {
    let ws = single()
    const id = ws.focused
    const tab = panes(ws.root)[0].tabs[0]
    ws = retitleTab(ws, id, tab.id, '  Before the merge ')
    expect(panes(ws.root)[0].tabs[0].title).toBe('Before the merge')
    ws = retitleTab(ws, id, tab.id, '   ')
    expect(panes(ws.root)[0].tabs[0].title).toBeUndefined()
    ws = closeTab(ws, id, panes(ws.root)[0].tabs[0].id, '/graph/2d')
    ws = closeTab(ws, id, panes(ws.root)[0].tabs[0].id, '/graph/2d')
    expect(panes(ws.root)[0].tabs.map((t) => t.path)).toEqual(['/graph/2d'])
  })

  it('moves tabs between panes and closes emptied panes', () => {
    const base = single()
    let ws = splitPane(base, base.focused, 'row')
    const [a, b] = panes(ws.root)
    const tab = a.tabs[0]
    ws = moveTab(ws, a.id, tab.id, b.id, 0)
    expect(panes(ws.root)[1].tabs[0].id).toBe(tab.id)
    expect(panes(ws.root)[0].tabs.length).toBe(1)
    ws = moveTab(ws, a.id, panes(ws.root)[0].tabs[0].id, b.id)
    expect(panes(ws.root).length).toBe(1)
    expect(panes(ws.root)[0].tabs.length).toBe(3)
  })

  it('keeps per-tab history', () => {
    let ws = single()
    const pane = ws.focused
    const tab = panes(ws.root)[0].tabs[0]
    ws = navigateTab(ws, pane, tab.id, '/documents/x')
    ws = navigateTab(ws, pane, tab.id, '/documents/y')
    ws = navigateTab(ws, pane, tab.id, '/documents/y?q=1', true)
    let t = panes(ws.root)[0].tabs[0]
    expect(t.path).toBe('/documents/y?q=1')
    expect(t.back).toEqual(['/documents', '/documents/x'])
    ws = goTab(ws, pane, tab.id, -1)
    t = panes(ws.root)[0].tabs[0]
    expect(t.path).toBe('/documents/x')
    expect(t.forward).toEqual(['/documents/y?q=1'])
    ws = goTab(ws, pane, tab.id, 1)
    expect(panes(ws.root)[0].tabs[0].path).toBe('/documents/y?q=1')
  })

  it('clamps ratios and round-trips presets with fresh ids', () => {
    const base = single()
    let ws = splitPane(base, base.focused, 'row')
    ws = setRatio(ws, ws.root.id, 0.02)
    expect((ws.root as { ratio: number }).ratio).toBe(0.1)
    const back = fromPreset(JSON.parse(JSON.stringify(toPreset(ws))))!
    expect(panes(back.root).length).toBe(2)
    expect(panes(back.root)[0].id).not.toBe(panes(ws.root)[0].id)
    expect(panes(back.root)[0].tabs[0].path).toBe('/documents')
    expect(fromPreset({})).toBeUndefined()
    expect(fromPreset(defaultWorkstation())).toBeDefined()
  })

  it('the front door is one pane: Chats in front, the graph in 3D behind', () => {
    const ws = defaultWorkstation()
    const [pane] = panes(ws.root)
    expect(panes(ws.root)).toHaveLength(1)
    expect(pane.tabs.map((t) => t.path)).toEqual(['/chats', '/unigraph/3d'])
    expect(pane.active).toBe(0)
    expect(ws.focused).toBe(pane.id)
  })

  it('a first run is one pane with one tab: the whole graph in 3D, unfiltered, the simulation running live', () => {
    const ws = firstRunWorkstation()
    const [pane] = panes(ws.root)
    expect(panes(ws.root)).toHaveLength(1)
    expect(pane.tabs).toHaveLength(1)
    const url = new URL(pane.tabs[0].path, 'http://x')
    expect(url.pathname).toBe('/unigraph/3d')
    expect(url.searchParams.get('physics')).toBe('1')
    expect(url.searchParams.get('fresh')).toBe('1')
    expect(url.searchParams.get('scene')).toBeNull()
    expect(ws.focused).toBe(pane.id)
  })

  it('a first run can open on the default demo’s own scene instead, still one pane with one tab', () => {
    const ws = firstRunWorkstation({ path: '/unigraph/3d?scene=scene:demo:whole&physics=1', title: 'The whole map' })
    const [pane] = panes(ws.root)
    expect(panes(ws.root)).toHaveLength(1)
    expect(pane.tabs.map((t) => [t.path, t.title])).toEqual([['/unigraph/3d?scene=scene:demo:whole&physics=1', 'The whole map']])
  })

  it('reads the bare section as "where I already am", and a different address as somewhere else', () => {
    // What the sidebar links to, against the tab that is open: the tab stays where it is.
    expect(pathWithin('/unigraph', '/unigraph/2d?session=k3f9')).toBe(true)
    expect(pathWithin('/graph', '/graph/2d')).toBe(true)
    expect(pathWithin('/entities', '/entities?q=kepler')).toBe(true)
    expect(pathWithin('/documents', '/documents/abc#notes')).toBe(true)
    // Somewhere else, and followed: another section, a section that merely starts with the same letters, and an
    // address that names a query or a fragment of its own — that is a place, not "back to where I was".
    expect(pathWithin('/entities', '/graph/2d')).toBe(false)
    expect(pathWithin('/graph', '/graphics/1')).toBe(false)
    expect(pathWithin('/unigraph?fresh=1', '/unigraph/2d?session=k3f9')).toBe(false)
    expect(pathWithin('/unigraph#top', '/unigraph/2d')).toBe(false)
    // The same address is not "within" itself: the caller has already dealt with that, and a tab told to stay
    // where it is would be navigated to the address it is on.
    expect(pathWithin('/unigraph/2d', '/unigraph/2d')).toBe(false)
  })

  it('maps paths to views', () => {
    expect(viewForPath('/documents/abc')?.label).toBe('Documents')
    expect(viewForPath('/entities?category=types')?.label).toBe('Entities')
    expect(viewForPath('/entities?type=x')?.label).toBe('Entities')
    expect(viewForPath('/')?.label).toBe('Dashboard')
  })
})

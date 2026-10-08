import { describe, expect, it } from 'vitest'
import { closeTab, ensureLists, fromPreset, listAt, makePane, makeTab, navigateInHost, navigateTab, openInHost, panes, splitPane, toPreset, type Workstation } from '../model'

/**
 * A tabbed section's list: the index tab that stays at the front, cannot be closed, and hands whatever is opened
 * from it to a tab of its own — the way Documents, the Resources pages, Scenes, Ontology, Projects and Analytics work.
 */
const docs = [listAt('documents', '/documents')]
const analytics = [listAt('charts', '/analytics/charts', 'Charts', ['plot']), listAt('scripts', '/analytics/scripts', 'Scripts', ['script'])]
const one = (...paths: string[]): Workstation => {
  const p = makePane(paths.map((x) => makeTab(x)))
  return { root: p, focused: p.id }
}
const tabs = (ws: Workstation) => panes(ws.root).map((p) => p.tabs.map((t) => `${t.list ? '*' : ''}${t.path}`))
const front = (ws: Workstation) => {
  const p = panes(ws.root).find((x) => x.id === ws.focused)!
  return p.tabs[p.active].path
}

describe('a host’s lists', () => {
  it('are made when missing, marked when a tab already shows one, kept first and in order', () => {
    expect(tabs(ensureLists(one('/documents/a'), docs))).toEqual([['*/documents', '/documents/a']])
    expect(tabs(ensureLists(one('/documents/a', '/documents?folder=x'), docs))).toEqual([['*/documents?folder=x', '/documents/a']])
    const ws = ensureLists(one('/analytics/scripts', '/analytics/charts?plot=p1'), analytics)
    expect(tabs(ws)).toEqual([['*/analytics/charts', '*/analytics/scripts', '/analytics/charts?plot=p1']])
    // The tab that was in front still is, wherever the lists moved it.
    const w0 = one('/documents/a', '/documents/b')
    expect(front(ensureLists({ ...w0, root: { ...(w0.root as ReturnType<typeof makePane>), active: 1 } }, docs))).toBe('/documents/b')
    // Nothing to do: the same object back.
    const done = ensureLists(one('/documents'), docs)
    expect(ensureLists(done, docs)).toBe(done)
  })

  it('cannot be closed, and survive a round trip through storage', () => {
    const ws = ensureLists(one('/documents', '/documents/a'), docs)
    const p = panes(ws.root)[0]
    expect(closeTab(ws, p.id, p.tabs[0].id)).toBe(ws)
    expect(tabs(fromPreset(toPreset(ws))!)).toEqual([['*/documents', '/documents/a']])
  })

  it('open what is opened from them in a tab of its own, or bring back the one already open', () => {
    let ws = ensureLists(one('/documents'), docs)
    const list = panes(ws.root)[0].tabs[0]
    ws = navigateInHost(ws, docs, ws.focused, list.id, '/documents/a')
    expect(tabs(ws)).toEqual([['*/documents', '/documents/a']])
    expect(front(ws)).toBe('/documents/a')
    // The list moves within itself (a folder, a search) as any tab does.
    ws = navigateInHost(ws, docs, ws.focused, list.id, '/documents?folder=f')
    expect(tabs(ws)[0][0]).toBe('*/documents?folder=f')
    // The same document again: its tab comes forward, no second one.
    ws = navigateInHost(ws, docs, ws.focused, list.id, '/documents/a')
    expect(tabs(ws)).toEqual([['*/documents?folder=f', '/documents/a']])
  })

  it('come forward when a tab or a link goes to them, and leave that tab where it was', () => {
    let ws = ensureLists(one('/documents', '/documents/a'), docs)
    const item = panes(ws.root)[0].tabs[1]
    ws = navigateInHost(ws, docs, ws.focused, item.id, '/documents?folder=f')
    expect(tabs(ws)).toEqual([['*/documents?folder=f', '/documents/a']])
    expect(front(ws)).toBe('/documents?folder=f')
    // An item tab going to another item moves, as a browser tab does.
    ws = navigateInHost(ws, docs, ws.focused, item.id, '/documents/b')
    expect(tabs(ws)).toEqual([['*/documents?folder=f', '/documents/b']])
    // A link from outside: to a list (the bare one finds it as it was left), to an open item, to a new one.
    expect(front(openInHost(ws, docs, '/documents'))).toBe('/documents?folder=f')
    expect(front(openInHost(ws, docs, '/documents?folder=g'))).toBe('/documents?folder=g')
    expect(tabs(openInHost(ws, docs, '/documents/b'))).toEqual(tabs(ws))
    expect(tabs(openInHost(ws, docs, '/documents/c'))).toEqual([['*/documents?folder=f', '/documents/b', '/documents/c']])
  })

  it('know an item by the address it was opened on, after its view has moved it', () => {
    const scenes = [listAt('scenes', '/scenes', 'List', ['id'])]
    let ws = ensureLists(one('/scenes'), scenes)
    const list = panes(ws.root)[0].tabs[0]
    // A graph scene opens in Unigraph, whose explorer turns `?scene=` into its session.
    ws = navigateInHost(ws, scenes, ws.focused, list.id, '/unigraph/3d?scene=s1', false, 'The whole graph')
    const opened = panes(ws.root)[0].tabs[1]
    expect(opened.title).toBe('The whole graph')
    ws = navigateTab(ws, ws.focused, opened.id, '/unigraph/3d?session=k3', true)
    ws = navigateInHost(ws, scenes, ws.focused, list.id, '/unigraph/3d?scene=s1')
    expect(tabs(ws)).toEqual([['*/scenes', '/unigraph/3d?session=k3']])
    expect(front(ws)).toBe('/unigraph/3d?session=k3')
  })

  it('with several lists, each item goes to a tab and each list to its own tab', () => {
    let ws = ensureLists(one('/analytics/charts'), analytics)
    const charts = panes(ws.root)[0].tabs[0]
    ws = navigateInHost(ws, analytics, ws.focused, charts.id, '/analytics/charts?plot=p1')
    ws = navigateInHost(ws, analytics, ws.focused, charts.id, '/analytics/scripts')
    expect(tabs(ws)).toEqual([['*/analytics/charts', '*/analytics/scripts', '/analytics/charts?plot=p1']])
    expect(front(ws)).toBe('/analytics/scripts')
  })

  it('come back to the first pane when the pane that held them is closed', () => {
    let ws = ensureLists(one('/documents'), docs)
    ws = splitPane(ws, ws.focused, 'row', makeTab('/documents/a'))
    const [left] = panes(ws.root)
    const moved = { ...ws, root: (ws.root as { children: unknown[] }).children[1] } as Workstation
    expect(tabs(ensureLists(moved, docs))).toEqual([['*/documents', '/documents/a']])
    expect(left.tabs[0].list).toBe('documents')
  })
})

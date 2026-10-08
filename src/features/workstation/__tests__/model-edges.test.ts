import { describe, expect, it } from 'vitest'
import { activateTab, addTab, closePane, closeTab, describeWorkstation, fromPreset, goTab, makePane, makeTab, moveTab, navigateTab, panes, retitleTab, setRatio, splitPane, toPreset, viewForPath, type PaneNode, type SplitNode, type Workstation } from '../model'

/**
 * The workstation tree at its edges: which tab is active after the active
 * one closes (first, middle, last), a close naming a tab or pane that is
 * not there, the last tab of a nested pane, a tab moved within its pane
 * to the ends and beyond, moved to a pane that does not exist, ratios at
 * 0, 1 and NaN, fifty levels of splits, history capped and unchanged by a
 * repeat, and a stored layout with a missing child, junk values, a
 * negative active index, duplicate tab ids and a focus nobody has.
 */
const three = (active = 0): Workstation => {
  const p = makePane([makeTab('/a'), makeTab('/b'), makeTab('/c')])
  return { root: { ...p, active }, focused: p.id }
}
const pane = (ws: Workstation, i = 0) => panes(ws.root)[i]
const paths = (ws: Workstation, i = 0) => pane(ws, i).tabs.map((t) => t.path)

describe('workstation model edges', () => {
  it('closing the active tab activates the next one, or the previous when it was last; closing before the active keeps the same tab active; a tab or pane that is not there changes nothing', () => {
    let ws = three(1)
    ws = closeTab(ws, ws.focused, pane(ws).tabs[1].id)
    expect([paths(ws), pane(ws).active]).toEqual([['/a', '/c'], 1]) // /c, the next
    ws = closeTab(ws, ws.focused, pane(ws).tabs[1].id)
    expect([paths(ws), pane(ws).active]).toEqual([['/a'], 0]) // it was last: the previous
    ws = three(2)
    ws = closeTab(ws, ws.focused, pane(ws).tabs[0].id)
    expect([paths(ws), pane(ws).active]).toEqual([['/b', '/c'], 1]) // /c stays active
    ws = three(0)
    ws = closeTab(ws, ws.focused, pane(ws).tabs[2].id)
    expect([paths(ws), pane(ws).active]).toEqual([['/a', '/b'], 0])
    const before = three(2)
    expect(closeTab(before, before.focused, 'nope')).toEqual(before)
    expect(closeTab(before, 'nopane', pane(before).tabs[0].id)).toBe(before)
  })

  it('the last tab of a nested pane closes the pane and its sibling split takes the place; focus moves only when the focused pane went', () => {
    let ws = three()
    const first = ws.focused
    ws = splitPane(ws, first, 'row', makeTab('/x'))
    const second = ws.focused
    ws = splitPane(ws, second, 'col', makeTab('/y'))
    const third = ws.focused
    expect(panes(ws.root).map((p) => p.id)).toEqual([first, second, third])
    ws = activateTab(ws, first, 0)
    ws = closeTab(ws, second, panes(ws.root)[1].tabs[0].id)
    expect(panes(ws.root).map((p) => p.id)).toEqual([first, third])
    expect(ws.focused).toBe(first)
    expect((ws.root as SplitNode).children[1].id).toBe(third) // the split that held second and third collapsed to third
    ws = closeTab(ws, first, pane(ws, 0).tabs[0].id)
    ws = closeTab(ws, first, pane(ws, 0).tabs[0].id)
    ws = closeTab(ws, first, pane(ws, 0).tabs[0].id)
    expect(panes(ws.root).map((p) => p.id)).toEqual([third])
    expect(ws.focused).toBe(third)
    expect(closePane(ws, third)).toBe(ws)
    expect(closePane(three(), 'nope').root.kind).toBe('pane')
  })

  it('moves a tab within its pane to the front, the end and past it, and a tab to a pane that does not exist stays where it was', () => {
    let ws = three()
    const id = ws.focused
    const [a, b, c] = pane(ws).tabs
    ws = moveTab(ws, id, c.id, id, 0)
    expect([paths(ws), pane(ws).active]).toEqual([['/c', '/a', '/b'], 0])
    ws = moveTab(ws, id, c.id, id)
    expect([paths(ws), pane(ws).active]).toEqual([['/a', '/b', '/c'], 2])
    ws = moveTab(ws, id, a.id, id, 99)
    expect([paths(ws), pane(ws).active]).toEqual([['/b', '/c', '/a'], 2])
    ws = moveTab(ws, id, b.id, id, -5)
    expect(paths(ws)).toEqual(['/b', '/c', '/a'])
    expect(moveTab(ws, id, 'nope', id, 0)).toBe(ws)
    expect(moveTab(ws, 'nope', b.id, id, 0)).toBe(ws)
    const lost = moveTab(ws, id, b.id, 'nopane')
    expect(paths(lost)).toEqual(['/b', '/c', '/a'])
    expect(lost.focused).toBe(id)
    // Across panes and back: the tab keeps its history and title.
    ws = splitPane(ws, id, 'row')
    const other = ws.focused
    ws = retitleTab(ws, id, b.id, 'Bee')
    ws = navigateTab(ws, id, b.id, '/b/2')
    ws = moveTab(ws, id, b.id, other, 0)
    expect(pane(ws, 1).tabs.map((t) => [t.path, t.title, t.back])).toEqual([['/b/2', 'Bee', ['/b']], ['/', undefined, []]])
    ws = moveTab(ws, other, b.id, id, 1)
    expect([paths(ws, 0), pane(ws, 0).active, ws.focused]).toEqual([['/c', '/b/2', '/a'], 1, id])
  })

  it('ratios clamp to a tenth and nine tenths, ignore NaN, and leave other splits alone; fifty nested splits open and close', () => {
    const base = three()
    let ws = splitPane(base, base.focused, 'row')
    const s = ws.root.id
    expect((setRatio(ws, s, 0).root as SplitNode).ratio).toBe(0.1)
    expect((setRatio(ws, s, 1).root as SplitNode).ratio).toBe(0.9)
    expect((setRatio(ws, s, -3).root as SplitNode).ratio).toBe(0.1)
    expect((setRatio(ws, s, NaN).root as SplitNode).ratio).toBe(0.5)
    expect((setRatio(ws, s, Infinity).root as SplitNode).ratio).toBe(0.5) // not finite: left as it was, like NaN
    expect(setRatio(ws, 'nope', 0.3)).toEqual(ws)
    for (let i = 0; i < 50; i++) ws = splitPane(ws, ws.focused, i % 2 ? 'row' : 'col')
    expect(panes(ws.root).length).toBe(52)
    expect(describeWorkstation(ws)).toBe('52 panes · 54 tabs')
    let depth = 0
    for (let n = ws.root; n.kind === 'split'; n = n.children[1]) depth++
    expect(depth).toBe(51)
    while (panes(ws.root).length > 1) ws = closePane(ws, ws.focused)
    expect(ws.root.kind).toBe('pane')
    expect(describeWorkstation(ws)).toBe('1 pane · 1 tab') // focus fell back to the first pane each time, so the three-tab one went too
  })

  it('a repeat of the same path leaves history alone, back is capped at fifty, going past either end stays, a replace keeps the forward stack, and activation clamps', () => {
    let ws = three()
    const id = ws.focused
    const t = pane(ws).tabs[0]
    ws = navigateTab(ws, id, t.id, '/a')
    expect(pane(ws).tabs[0].back).toEqual([])
    for (let i = 1; i <= 60; i++) ws = navigateTab(ws, id, t.id, `/a/${i}`)
    expect(pane(ws).tabs[0].back.length).toBe(50)
    expect(pane(ws).tabs[0].back[0]).toBe('/a/10')
    ws = goTab(ws, id, t.id, 1)
    expect(pane(ws).tabs[0].path).toBe('/a/60')
    for (let i = 0; i < 60; i++) ws = goTab(ws, id, t.id, -1)
    expect(pane(ws).tabs[0].path).toBe('/a/10')
    expect(pane(ws).tabs[0].forward.length).toBe(50)
    ws = navigateTab(ws, id, t.id, '/a/10?x', true)
    expect(pane(ws).tabs[0].forward.length).toBe(50)
    ws = navigateTab(ws, id, t.id, '/fresh')
    expect(pane(ws).tabs[0].forward).toEqual([])
    expect(goTab(ws, id, 'nope', -1)).toEqual(ws)
    expect(pane(activateTab(ws, id, 99)).active).toBe(2)
    expect(pane(activateTab(ws, id, -1)).active).toBe(0)
    expect(activateTab(ws, id, 1).focused).toBe(id)
    // The same path twice is two tabs: the model does not dedupe.
    ws = addTab(addTab(ws, id, makeTab('/same')), id, makeTab('/same'))
    expect(paths(ws).filter((p) => p === '/same')).toHaveLength(2)
    expect(pane(ws).active).toBe(4)
    expect(retitleTab(ws, id, 'nope', 'x')).toEqual(ws)
  })

  it('restores a stored layout: junk dir and ratio go to defaults, a negative or oversized active clamps, an empty pane gets a tab, a missing child or kind fails whole, duplicate ids are re-minted unless kept, and a focus nobody has goes to the first pane', () => {
    const stored = {
      root: {
        kind: 'split',
        id: 's1',
        dir: 'diagonal',
        ratio: '0.3',
        children: [
          { kind: 'pane', id: 'p1', tabs: [{ id: 't', path: '/a' }, { id: 't', path: '/b', title: 'B' }, { path: 7 }, null], active: -2 },
          { kind: 'pane', id: 'p2', tabs: [], active: 9 },
        ],
      },
      focused: 'ghost',
    }
    const fresh = fromPreset(JSON.parse(JSON.stringify(stored)))!
    const root = fresh.root as SplitNode
    expect([root.dir, root.ratio]).toEqual(['row', 0.5])
    const [p1, p2] = panes(fresh.root)
    expect(p1.tabs.map((t) => [t.path, t.title])).toEqual([['/a', undefined], ['/b', 'B']])
    expect(p1.active).toBe(0)
    expect(new Set(p1.tabs.map((t) => t.id)).size).toBe(2)
    expect(p1.id).not.toBe('p1')
    expect(p2.tabs.map((t) => t.path)).toEqual(['/'])
    expect(p2.active).toBe(0)
    expect(fresh.focused).toBe(p1.id)
    const kept = fromPreset(stored, { keepIds: true })!
    expect(panes(kept.root).map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(panes(kept.root)[0].tabs.map((t) => t.id)).toEqual(['t', 't']) // kept as stored, duplicates and all
    expect(kept.focused).toBe('p1')
    expect(fromPreset({ ...stored, focused: 'p2' }, { keepIds: true })!.focused).toBe('p2')
    expect(fromPreset({ root: { kind: 'split', id: 's', dir: 'row', ratio: 0.5, children: [{ kind: 'pane', id: 'p', tabs: [] }] } })).toBeUndefined()
    expect(fromPreset({ root: { kind: 'tabs', id: 'x' } })).toBeUndefined()
    expect(fromPreset(null)).toBeUndefined()
    expect(fromPreset({ root: null })).toBeUndefined()
    // A ratio outside the range the dividers allow comes in clamped, like a drag would leave it.
    expect((fromPreset({ root: { ...stored.root, ratio: 5 } })!.root as SplitNode).ratio).toBe(0.9)
    expect((fromPreset({ root: { ...stored.root, ratio: -1 } })!.root as SplitNode).ratio).toBe(0.1)
    expect((fromPreset({ root: { ...stored.root, ratio: NaN } })!.root as SplitNode).ratio).toBe(0.5)
    // A preset strips history, keeps titles, and comes back the same shape with new ids.
    let ws = three()
    ws = navigateTab(ws, ws.focused, pane(ws).tabs[0].id, '/a/1')
    ws = retitleTab(ws, ws.focused, pane(ws).tabs[0].id, 'One')
    const preset = toPreset(ws)
    expect((preset.root as PaneNode).tabs[0]).toEqual({ ...pane(ws).tabs[0], back: [], forward: [] })
    expect(pane(ws).tabs[0].back).toEqual(['/a'])
    const back = fromPreset(preset)!
    expect(pane(back).tabs.map((t) => [t.path, t.title])).toEqual([['/a/1', 'One'], ['/b', undefined], ['/c', undefined]])
  })

  it('maps a path to the longest registered view prefix, only at a segment boundary, the query ignored, and the root only to the dashboard', () => {
    expect(viewForPath('/')?.id).toBe('dashboard')
    expect(viewForPath('/?x=1')?.id).toBe('dashboard')
    expect(viewForPath('/unigraph/2d')?.id).toBe('unigraph2d')
    expect(viewForPath('/unigraph/2d?session=x')?.id).toBe('unigraph2d')
    expect(viewForPath('/unigraph/2d/extra')?.id).toBe('unigraph2d')
    expect(viewForPath('/unigraph/2dx')).toBeUndefined()
    expect(viewForPath('/unigraph')).toBeUndefined()
    expect(viewForPath('/documents/abc')?.id).toBe('documents')
    expect(viewForPath('/documentsx')).toBeUndefined()
    expect(viewForPath('/analytics')).toBeUndefined()
    expect(viewForPath('/analytics/charts/1')?.id).toBe('charts')
    expect(viewForPath('')).toBeUndefined()
    expect(viewForPath('documents')).toBeUndefined()
  })
})

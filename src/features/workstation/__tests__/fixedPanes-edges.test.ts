import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixedLayoutStorage, fixedPane, fixedPaneIds, fixedSplit, maximizeFixedPane, setFixedRatio, toggleFixedPane, type FixedLayout } from '../FixedPanes'
import { describeHost, HOSTS, mountedHost, registerHost, storedWorkstation, writeStoredWorkstation, type HostHandle } from '../hosts'
import { makePane, makeTab, navigateTab, panes, type Workstation } from '../model'

/**
 * The fixed-pane layout at its edges: a stored tree naming the panes in
 * another order, twice, or with one missing; junk in storage; the
 * maximize marker across a reload; collapse then maximize, a maximized
 * pane toggled, an id nobody has; ratios on a pane, on nothing, NaN;
 * three levels with one branch collapsed. Then the hosts: the stored
 * arrangement of a host (junk, history stripped, ids kept), the mounted
 * registry, and the description of a host with an active index off the end.
 */
let mem: Record<string, string>
beforeEach(() => {
  mem = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
})

const deep = fixedSplit('top', 'row', 0.5, fixedSplit('left', 'col', 0.5, fixedPane('a'), fixedPane('b')), fixedSplit('right', 'col', 0.5, fixedPane('c'), fixedSplit('rr', 'row', 0.5, fixedPane('d'), fixedPane('e'))))
const fresh = (): FixedLayout => ({ root: deep, collapsed: {} })

describe('fixed panes edges', () => {
  it('takes a stored tree that names the panes in any order, not one that repeats or lacks a pane, nor junk; a stored maximize comes back as collapsed panes without its marker', () => {
    const store = fixedLayoutStorage('k', ['a', 'b', 'c', 'd', 'e'])
    const fallback = fresh()
    const reordered = fixedSplit('x', 'col', 0.3, fixedPane('e'), fixedSplit('y', 'row', 0.7, fixedPane('d'), fixedSplit('z', 'row', 0.5, fixedPane('c'), fixedSplit('w', 'col', 0.5, fixedPane('b'), fixedPane('a')))))
    store.write({ root: reordered, collapsed: { a: true } })
    expect(store.read(fallback).root).toEqual(reordered)
    // A tree with `a` twice, or without `e`, is not this page's set.
    store.write({ root: fixedSplit('x', 'row', 0.5, fixedPane('a'), fixedSplit('y', 'row', 0.5, fixedPane('a'), fixedSplit('z', 'row', 0.5, fixedPane('b'), fixedSplit('w', 'row', 0.5, fixedPane('c'), fixedPane('d'))))), collapsed: {} })
    expect(store.read(fallback)).toBe(fallback)
    store.write({ root: fixedSplit('x', 'row', 0.5, fixedPane('a'), fixedSplit('y', 'row', 0.5, fixedPane('b'), fixedSplit('z', 'row', 0.5, fixedPane('c'), fixedPane('d')))), collapsed: {} })
    expect(store.read(fallback)).toBe(fallback)
    for (const junk of ['{not json', '{}', '{"root":null}', '{"root":{"kind":"split","id":"s"}}', 'null', '[]']) {
      mem.k = junk
      expect(store.read(fallback), junk).toBe(fallback)
    }
    mem.k = JSON.stringify({ root: deep })
    expect(store.read(fallback)).toEqual({ root: deep, collapsed: {} })
    // A maximize rebuilds the collapsed map from the tree (a flag for a pane the tree lacks goes into `before` only); it is stored whole but read back only as its collapsed panes.
    const maxed = maximizeFixedPane({ root: deep, collapsed: { ghost: true } }, 'c')
    expect(maxed.maximized?.before).toEqual({ ghost: true })
    store.write(maxed)
    const back = store.read(fallback)
    expect(back.collapsed).toEqual({ a: true, b: true, c: false, d: true, e: true })
    expect(back.maximized).toBeUndefined()
    // A page of one pane.
    const one = fixedLayoutStorage('one', ['solo'])
    one.write({ root: fixedPane('solo'), collapsed: {} })
    expect(one.read({ root: fixedPane('other'), collapsed: {} }).root).toEqual(fixedPane('solo'))
  })

  it('collapse then maximize remembers the collapse for the restore; toggling the maximized pane itself is refused; toggling another ends the maximize; an id nobody has changes nothing', () => {
    let l = toggleFixedPane(fresh(), 'a')
    l = toggleFixedPane(l, 'e')
    l = maximizeFixedPane(l, 'c')
    expect(l.collapsed).toEqual({ a: true, b: true, c: false, d: true, e: true })
    expect(l.maximized).toEqual({ id: 'c', before: { a: true, e: true } })
    expect(toggleFixedPane(l, 'c')).toBe(l)
    const opened = toggleFixedPane(l, 'b')
    expect(opened.maximized).toBeUndefined()
    expect(opened.collapsed).toEqual({ a: true, b: false, c: false, d: true, e: true })
    expect(maximizeFixedPane(l, 'c')).toEqual({ root: deep, collapsed: { a: true, e: true } })
    // Maximize a second pane, then that one again: back to the original "before", not to the first maximize's picture.
    const second = maximizeFixedPane(l, 'd')
    expect(second.maximized).toEqual({ id: 'd', before: { a: true, e: true } })
    expect(maximizeFixedPane(second, 'd').collapsed).toEqual({ a: true, e: true })
    // Ids the tree does not have.
    expect(toggleFixedPane(fresh(), 'nope')).toEqual(fresh())
    expect(maximizeFixedPane(fresh(), 'nope')).toEqual(fresh())
    // Only one pane open, and it is asked to maximize: every other stays collapsed, and it restores to the same.
    const lone = { root: deep, collapsed: { a: true, b: true, d: true, e: true } }
    expect(maximizeFixedPane(lone, 'c').collapsed).toEqual({ a: true, b: true, c: false, d: true, e: true })
    expect(maximizeFixedPane(maximizeFixedPane(lone, 'c'), 'c')).toEqual(lone)
  })

  it('a ratio on a pane id or an unknown id changes nothing, NaN leaves the split as it was, and the edges clamp; a fully collapsed branch three deep still leaves one pane open', () => {
    expect(setFixedRatio(deep, 'a', 0.2)).toEqual(deep)
    expect(setFixedRatio(deep, 'nope', 0.2)).toEqual(deep)
    const nan = setFixedRatio(deep, 'rr', NaN)
    expect(fixedPaneIds(nan)).toEqual(['a', 'b', 'c', 'd', 'e'])
    const rrOf = (n: typeof deep) => (n.kind === 'split' && n.children[1].kind === 'split' && n.children[1].children[1].kind === 'split' ? n.children[1].children[1].ratio : NaN)
    expect(rrOf(nan)).toBe(0.5)
    expect(rrOf(setFixedRatio(deep, 'rr', 0))).toBe(0.1)
    expect(rrOf(setFixedRatio(deep, 'rr', 7))).toBe(0.9)
    let l = fresh()
    for (const id of ['c', 'd', 'e', 'a']) l = toggleFixedPane(l, id)
    expect(l.collapsed).toEqual({ c: true, d: true, e: true, a: true })
    expect(toggleFixedPane(l, 'b')).toBe(l)
    expect(fixedPaneIds(deep).filter((id) => !l.collapsed[id])).toEqual(['b'])
  })
})

describe('hosts', () => {
  it('reads a host’s stored arrangement with its ids kept and its history stripped, falls back to the initial one on junk, and writes a preset', () => {
    const def = HOSTS.unigraph
    expect(panes(storedWorkstation(def).ws.root)[0].tabs[0].path).toBe('/unigraph/2d')
    expect(storedWorkstation(def).dirty).toBe(false)
    let ws: Workstation = (() => {
      const p = makePane([makeTab('/unigraph/2d'), makeTab('/unigraph/3d', 'Three')])
      return { root: p, focused: p.id }
    })()
    ws = navigateTab(ws, ws.focused, panes(ws.root)[0].tabs[0].id, '/unigraph/2d?x=1')
    writeStoredWorkstation(def, { ws, presetId: 'mine', dirty: true })
    const got = storedWorkstation(def)
    expect(got.presetId).toBe('mine')
    expect(got.dirty).toBe(true)
    expect(panes(got.ws.root)[0].id).toBe(panes(ws.root)[0].id)
    expect(panes(got.ws.root)[0].tabs.map((t) => [t.id, t.path, t.title, t.back])).toEqual([[panes(ws.root)[0].tabs[0].id, '/unigraph/2d?x=1', undefined, []], [panes(ws.root)[0].tabs[1].id, '/unigraph/3d', 'Three', []]])
    expect(got.ws.focused).toBe(ws.focused)
    for (const junk of ['{oops', '{}', '{"ws":null}', '{"ws":{"root":{"kind":"split","id":"s"}}}']) {
      mem[def.key] = junk
      expect(panes(storedWorkstation(def).ws.root)[0].tabs[0].path, junk).toBe('/unigraph/2d')
    }
    expect(storedWorkstation(HOSTS.workstation).ws.root.kind).toBe('pane')
  })

  it('the mounted registry keeps the latest handle per key, and unregistering a stale handle does not drop the newer one; a host is described pane by pane with the active tab id, or none off the end', () => {
    const handle = (n: number): HostHandle => ({ key: 'k', get: () => ({ root: makePane([makeTab(`/${n}`)]), focused: 'p' }), run: () => {} })
    const h1 = handle(1)
    const off1 = registerHost(h1)
    const h2 = handle(2)
    const off2 = registerHost(h2)
    expect(mountedHost('k')).toBe(h2)
    off1()
    expect(mountedHost('k')).toBe(h2)
    off2()
    expect(mountedHost('k')).toBeUndefined()
    off2()
    expect(mountedHost('nope')).toBeUndefined()
    const p = makePane([makeTab('/a', 'A'), makeTab('/b')])
    const ws: Workstation = { root: { ...p, active: 5 }, focused: p.id }
    expect(describeHost(ws)).toEqual([{ pane: p.id, focused: true, active: undefined, tabs: [{ id: p.tabs[0].id, path: '/a', title: 'A' }, { id: p.tabs[1].id, path: '/b', title: undefined }] }])
    expect(describeHost({ root: makePane([]), focused: 'x' })[0]).toMatchObject({ focused: false, active: undefined, tabs: [] })
  })
})

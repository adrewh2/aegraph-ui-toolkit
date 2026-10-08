import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixedLayoutStorage, fixedPane, fixedPaneIds, fixedSplit, maximizeFixedPane, setFixedRatio, toggleFixedPane, type FixedLayout } from '../FixedPanes'

beforeEach(() => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
})

describe('fixed panes', () => {
  const tree = fixedSplit('main', 'row', 0.4, fixedPane('code'), fixedSplit('right', 'col', 0.3, fixedPane('about'), fixedPane('output')))
  it('lists panes and sets a split ratio within bounds', () => {
    expect(fixedPaneIds(tree)).toEqual(['code', 'about', 'output'])
    const t = setFixedRatio(tree, 'right', 0.95)
    expect(t.kind === 'split' && t.children[1].kind === 'split' && t.children[1].ratio).toBe(0.9)
    expect(t.kind === 'split' && t.ratio).toBe(0.4)
  })
  it("remembers a layout only while it still names the page's panes", () => {
    const store = fixedLayoutStorage('k', ['code', 'about', 'output'])
    const fallback = { root: tree, collapsed: {} }
    expect(store.read(fallback)).toBe(fallback)
    store.write({ root: setFixedRatio(tree, 'main', 0.6), collapsed: { about: true } })
    const got = store.read(fallback)
    expect(got.root.kind === 'split' && got.root.ratio).toBe(0.6)
    expect(got.collapsed).toEqual({ about: true })
    const other = fixedLayoutStorage('k', ['code', 'output'])
    expect(other.read(fallback)).toBe(fallback)
  })

  it('never lets every pane collapse: the last open one stays', () => {
    let l = { root: tree, collapsed: {} as Record<string, boolean> }
    l = toggleFixedPane(l, 'code')
    l = toggleFixedPane(l, 'about')
    expect(l.collapsed).toEqual({ code: true, about: true })
    expect(toggleFixedPane(l, 'output')).toBe(l)
    l = toggleFixedPane(l, 'code')
    expect(l.collapsed.code).toBe(false)
    expect(toggleFixedPane(l, 'output').collapsed.output).toBe(true)
  })

  it('maximizes one pane and restores what was open before', () => {
    let l: FixedLayout = { root: tree, collapsed: { about: true } }
    l = maximizeFixedPane(l, 'output')
    expect(l.collapsed).toEqual({ code: true, about: true, output: false })
    expect(l.maximized?.id).toBe('output')
    // maximizing another pane keeps the original "before"
    l = maximizeFixedPane(l, 'code')
    expect(l.collapsed).toEqual({ code: false, about: true, output: true })
    l = maximizeFixedPane(l, 'code')
    expect(l.collapsed).toEqual({ about: true })
    expect(l.maximized).toBeUndefined()
    // a manual toggle ends the maximize
    l = maximizeFixedPane(l, 'about')
    l = toggleFixedPane(l, 'code')
    expect(l.maximized).toBeUndefined()
    expect(l.collapsed.code).toBe(false)
  })
})

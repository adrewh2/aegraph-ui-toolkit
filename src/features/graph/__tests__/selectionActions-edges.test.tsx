import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../../../components/ui/useToast'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import '../../../core/graph/types'
import '../../../core/graph/scene'
import { readPick } from '../../../app/openIn'
import { PaneContext, type PaneHost } from '../../workstation/paneContext'
import { ExplorerProvider, useExplorer, type ExplorerContextValue, type ExplorerState } from '../explorerState'
import { useSelectionActions } from '../useSelectionActions'

/**
 * The selection actions at their edges, driven through the mounted
 * provider (see explorerProvider-edges for the container without a DOM):
 * hiding and what the exclude list holds after, unhiding some or all,
 * pins on and off, focus on nothing and on something with the depth
 * kept, removing the primary node, tagging with tags old and new and
 * untagging, the path added to the selection, the export's file, opening
 * in a new graph through a pane host and without one, and the linked
 * entities a view is missing.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const g = globalThis as Record<string, unknown>
g.window = globalThis
g.HTMLIFrameElement = class {}
/** The document `downloadText` needs: an anchor it can click, a body to hold it, and blobs to point at. */
const downloads: { name: string; blob: Blob }[] = []
const blobs = new Map<string, Blob>()
g.document = {
  nodeType: 9,
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
  body: { appendChild() {} },
  createElement: () => {
    const a = { href: '', download: '', click: () => downloads.push({ name: a.download, blob: blobs.get(a.href)! }), remove() {} }
    return a
  },
}
URL.createObjectURL = (b: Blob) => {
  const u = `blob:${blobs.size}`
  blobs.set(u, b)
  return u
}
URL.revokeObjectURL = () => {}

function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'document', label: 'A', tags: ['x'] }),
    createEntity({ id: 'b', type: 'note', label: 'B' }),
    createEntity({ id: 'c', type: 'document', label: 'C', tags: ['x', 'y'] }),
    createEntity({ id: 'd', type: 'note', label: 'D' }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c' }),
  ])
  return s
}

/** The toasts shown, in order — the text the toast provider had the document render. */
const toasts: string[] = []
/** Enough of an element for react-dom to render the toast provider's `<div class="toast">text</div>` into. */
const container = () => {
  // A single text child is set as `textContent`; more than one would come as text nodes.
  const el = (nodeName: string): Record<string, unknown> => ({ nodeType: 1, nodeName, tagName: nodeName, namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, style: {}, childNodes: [], setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, insertBefore() {}, addEventListener() {}, removeEventListener() {}, set textContent(v: string) { if (v) toasts.push(v) } })
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, createElement: (n: string) => el(n.toUpperCase()), createTextNode: (t: string) => (toasts.push(t), { nodeType: 3, data: t, nodeValue: t }) }
  return el('DIV') as unknown as Element
}

type Actions = ReturnType<typeof useSelectionActions>
/** The provider under a router at `/graph/<mode>`, a toast provider, and (optionally) a pane host; hands out the hook's value, the context and where the router is. */
async function mount(store: EntityStore, { mode = '2d', host, seed }: { mode?: '2d' | '3d'; host?: PaneHost; seed?: (s: ExplorerState) => ExplorerState } = {}) {
  let actions: Actions | undefined
  let ctx: ExplorerContextValue | undefined
  let where = ''
  function Where() {
    const l = useLocation()
    where = l.pathname + l.search
    return null
  }
  function Capture() {
    actions = useSelectionActions()
    ctx = useExplorer()
    return <Where />
  }
  const root: Root = createRoot(container())
  const tree = (
    <ExplorerProvider seed={seed}>
      <Capture />
    </ExplorerProvider>
  )
  await act(async () => {
    root.render(
      <EntityStoreContext.Provider value={store}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/graph/${mode}`]}>
            <Routes>
              <Route path="/graph/:mode" element={host ? <PaneContext.Provider value={host}>{tree}</PaneContext.Provider> : tree} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </EntityStoreContext.Provider>,
    )
  })
  const run = async <T,>(f: (a: Actions) => T): Promise<T> => {
    let out!: T
    await act(async () => void (out = f(actions!)))
    return out
  }
  return { run, get: () => ctx!, state: () => ctx!.state, where: () => where, dispatch: (a: Parameters<ExplorerContextValue['dispatch']>[0]) => act(() => ctx!.dispatch(a)), unmount: () => act(() => root.unmount()) }
}
const select = (h: Awaited<ReturnType<typeof mount>>, ids: string[]) => h.dispatch({ type: 'select', ids, mode: 'replace' })

describe('selection actions edges', () => {
  it('hide puts the nodes on the exclude list without repeats and drops them from the selection; unhide takes some or all back; hiding nothing is nothing', async () => {
    const h = await mount(fixture())
    await select(h, ['a', 'b'])
    await h.run((a) => a.hide([]))
    expect(h.state().filter.exclude ?? []).toEqual([])
    toasts.length = 0
    await h.run((a) => a.hide(['a']))
    expect(toasts).toEqual(['Hid 1 node — Filter › Hidden to restore'])
    expect(h.state().filter.exclude).toEqual(['a'])
    expect(h.state().selectedIds).toEqual(['b'])
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['b', 'c', 'd'])
    await h.run((a) => a.hide(['a', 'c', 'c']))
    expect(h.state().filter.exclude).toEqual(['a', 'c'])
    expect(h.state().selectedIds).toEqual(['b'])
    await h.run((a) => a.unhide(['a', 'nope']))
    expect(h.state().filter.exclude).toEqual(['c'])
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd'])
    await h.run((a) => a.unhide())
    expect(h.state().filter.exclude).toEqual([])
    await h.unmount()
  })

  it('pins go on and off by id, allPinned reads the selection against them, and a pin names a node whether or not it is in view', async () => {
    const h = await mount(fixture())
    await select(h, ['a', 'b'])
    expect(await h.run((a) => a.allPinned)).toBe(false)
    await h.run((a) => a.pin(['a', 'b', 'ghost'], true))
    expect(h.state().pinned).toEqual(['a', 'b', 'ghost'])
    expect(await h.run((a) => a.allPinned)).toBe(true)
    await h.run((a) => a.pin(['a', 'a'], false))
    expect(h.state().pinned).toEqual(['b', 'ghost'])
    expect(await h.run((a) => a.allPinned)).toBe(false)
    await select(h, [])
    expect(await h.run((a) => a.allPinned)).toBe(false) // nothing selected is not "all pinned"
    await h.unmount()
  })

  it('focus on nothing does nothing; on a node it sets roots at depth 1, keeps the depth already chosen when refocusing, and takes a depth given', async () => {
    const h = await mount(fixture())
    await h.run((a) => a.focus([]))
    expect(h.state().filter.roots ?? []).toEqual([])
    toasts.length = 0
    await h.run((a) => a.focus(['a']))
    expect(toasts).toEqual(['Focused on neighbourhood'])
    expect([h.state().filter.roots, h.state().filter.depth]).toEqual([['a'], 1])
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    await h.dispatch({ type: 'patchFilter', patch: { depth: 3 } })
    await h.run((a) => a.focus(['c']))
    expect([h.state().filter.roots, h.state().filter.depth]).toEqual([['c'], 3])
    await h.run((a) => a.focus(['a', 'd'], 0))
    expect([h.state().filter.roots, h.state().filter.depth]).toEqual([['a', 'd'], 0])
    expect(toasts.at(-1)).toBe('Focused on 2 nodes')
    await h.unmount()
  })

  it('remove deletes the nodes from the store (their relationships with them), takes them out of the selection, and the view; removing nothing is nothing', async () => {
    const store = fixture()
    const h = await mount(store)
    await select(h, ['a', 'b'])
    expect(await h.run((a) => a.primary)).toBe('b')
    await h.run((a) => a.remove([]))
    expect(store.get('b')).toBeDefined()
    toasts.length = 0
    await h.run((a) => a.remove(['b', 'nope']))
    expect(toasts).toEqual(['Deleted 2 nodes']) // the count is what was asked, not what existed
    expect(store.get('b')).toBeUndefined()
    expect(store.get('ab')).toBeUndefined()
    expect(h.state().selectedIds).toEqual(['a'])
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['a', 'c', 'd'])
    expect(h.get().slice.edges).toEqual([])
    await h.unmount()
  })

  it('tag adds tags old and new (cleaned, no repeats) and counts only the nodes that changed; untag removes; empty targets or tags change nothing', async () => {
    const store = fixture()
    const h = await mount(store)
    expect(await h.run((a) => a.tag(['a', 'b'], ['x', ' new ', 'new'], true))).toBe(2)
    expect(store.get('a')!.tags).toEqual(['x', 'new'])
    expect(store.get('b')!.tags).toEqual(['x', 'new'])
    toasts.length = 0
    expect(await h.run((a) => a.tag(['a', 'b', 'nope'], ['x'], true))).toBe(0)
    expect(toasts).toEqual(['Tagged 0 nodes'])
    expect(await h.run((a) => a.tag(['a', 'c'], ['new', 'y'], false))).toBe(2)
    expect(store.get('a')!.tags).toEqual(['x'])
    expect(store.get('c')!.tags).toEqual(['x'])
    expect(await h.run((a) => a.tag([], ['x'], true))).toBe(0)
    toasts.length = 0
    expect(await h.run((a) => a.tag(['a'], [' ', ''], true))).toBe(0)
    expect(toasts).toEqual([])
    await h.unmount()
  })

  it('the path is added after the selection, once, and only when there is one; clear, all and invert go through the same ops', async () => {
    const h = await mount(fixture())
    await select(h, ['d'])
    await h.run((a) => a.addPathToSelection())
    expect(h.state().selectedIds).toEqual(['d'])
    await h.dispatch({ type: 'setPath', path: { nodes: ['a', 'b', 'c'], edges: ['ab', 'bc'], length: 2, from: 'a', to: 'c', directed: false, weighted: false } })
    await h.run((a) => a.addPathToSelection())
    expect(h.state().selectedIds).toEqual(['d', 'a', 'b', 'c'])
    await h.run((a) => a.addPathToSelection())
    expect(h.state().selectedIds).toEqual(['d', 'a', 'b', 'c'])
    expect(await h.run((a) => [a.count, a.visibleCount])).toEqual([4, 4])
    await h.run((a) => a.clear())
    expect(h.state().selectedIds).toEqual([])
    expect(await h.run((a) => a.invert())).toEqual(['a', 'b', 'c', 'd'])
    await h.unmount()
  })

  it('export writes an aegraph document of the entities that exist, named by their count', async () => {
    const h = await mount(fixture())
    downloads.length = 0
    await h.run((a) => a.exportJson(['a', 'nope', 'ab']))
    expect(downloads).toHaveLength(1)
    expect(downloads[0].name).toBe('selection-2.ae.json')
    const doc = JSON.parse(await downloads[0].blob.text()) as { $schema: string; entities: { id: string }[] }
    expect(doc.$schema).toBe('aegraph/v1')
    expect(doc.entities.map((e) => e.id).sort()).toEqual(['a', 'ab'])
    await h.unmount()
  })

  it('open in a new graph hands the ids over as a pick in the same mode, to the pane host when there is one and to the router otherwise; open goes to the browser', async () => {
    const opened: [string, string | undefined][] = []
    const host: PaneHost = { paneId: 'p', openTab: (path, title) => opened.push([path, title]), active: true }
    const h = await mount(fixture(), { mode: '3d', host })
    await h.run((a) => a.openInNewGraph([]))
    expect(opened).toEqual([])
    await h.run((a) => a.openInNewGraph(['a']))
    await h.run((a) => a.openInNewGraph(['a', 'b']))
    expect(opened.map(([, t]) => t)).toEqual(['A', '2 entities'])
    const url = new URL(opened[0][0], 'http://x')
    expect(url.pathname).toBe('/graph/3d')
    expect(url.searchParams.get('fresh')).toBe('1')
    expect(readPick(url.searchParams.get('only')!)).toEqual({ ids: ['a'], label: 'A' })
    expect(readPick(new URL(opened[1][0], 'http://x').searchParams.get('only')!)!.ids).toEqual(['a', 'b'])
    await h.unmount()
    const alone = await mount(fixture())
    await alone.run((a) => a.openInNewGraph(['c']))
    expect(alone.where()).toMatch(/^\/graph\/2d\?only=\w+&fresh=1$/)
    await alone.run((a) => a.open('ab'))
    expect(alone.where()).toBe('/entities?category=relationships&sel=ab')
    await alone.run((a) => a.open('nope'))
    expect(alone.where()).toBe('/entities?category=relationships&sel=ab')
    await alone.unmount()
  })

  it('linkedMissing names what the view lacks around the nodes — not what is hidden on purpose; addLinked puts it on the include list and says when there is nothing', async () => {
    const h = await mount(fixture(), { seed: (s) => ({ ...s, filter: { ...s.filter, types: ['document'] } }) })
    expect(h.get().slice.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(await h.run((a) => a.linkedMissing(['a', 'c']))).toEqual(['b'])
    expect(await h.run((a) => a.linkedMissing(['d']))).toEqual([])
    toasts.length = 0
    expect(await h.run((a) => a.addLinked(['a']))).toBe(1)
    expect(toasts).toEqual(['Added 1 linked entity — Filter › Added to remove'])
    expect(h.state().filter.include).toEqual(['b'])
    expect(h.get().slice.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']) // the included come after the filtered
    expect(await h.run((a) => a.addLinked(['a']))).toBe(0)
    expect(toasts.at(-1)).toBe('Everything linked is already in view')
    expect(h.state().filter.include).toEqual(['b'])
    // Hidden by hand is not missing.
    await h.run((a) => a.hide(['b']))
    expect(await h.run((a) => a.linkedMissing(['a']))).toEqual([])
    await h.unmount()
  })
})

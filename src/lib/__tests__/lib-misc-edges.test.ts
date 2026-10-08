import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../core/entity/entity'
import { EntityStore } from '../../core/entity/store'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { DEFAULT_RENDERING, type EdgeStyle, type NodeStyle } from '../../core/graph/rendering'
import '../../core/graph/types'
import { downloadBlob, downloadFiles, exportView, VIEW_EXPORT_LABELS, type ViewExportContext } from '../../features/graph/exportView'
import { downloadText, toCsv } from '../download'
import { observeSettledSize } from '../settledResize'

/**
 * The rest of src/lib and the view export around it: CSV cells of every
 * shape (quotes, commas, newlines, arrays, objects, null, unicode, no
 * rows, no columns); downloads through a stub document (name, mime,
 * the blob, the revoke a second later); the settled-size observer (a
 * burst of resizes reports once, the last size, and nothing after
 * disconnect); the view exported as SVG, JSON, every graph format, PNG
 * through a snapshot, and the errors; the snapshot's size clamps.
 */
// The GEXF browser build needs DOMParser; vitest runs in node, so route it to the node build.
vi.mock('graphology-gexf/browser', async () => import('graphology-gexf/node'))

describe('toCsv', () => {
  it('quotes what needs it, joins arrays, JSONs objects, blanks null, keeps unicode, and gives a header alone for no rows or an empty line for no columns', () => {
    const cols = [{ key: 'a', label: 'A, or "a"' }, { key: 'b', label: 'B' }]
    const rows = [
      { a: 'plain', b: 1 },
      { a: 'has "quotes"', b: 'line\nbreak' },
      { a: ['x', 'y,z'], b: { k: 'v' } },
      { a: null, b: undefined },
      { a: 'ünï 🎉', b: 0 },
      { a: '  padded  ', b: false },
      {},
    ]
    expect(toCsv(rows, cols).split('\n')).toEqual(['"A, or ""a""",B', 'plain,1', '"has ""quotes""","line', 'break"', '"x; y,z","{""k"":""v""}"', ',', 'ünï 🎉,0', '  padded  ,false', ','])
    expect(toCsv([], cols)).toBe('"A, or ""a""",B')
    expect(toCsv(rows.slice(0, 1), [])).toBe('\n')
    expect(toCsv([], [])).toBe('')
    expect(toCsv([{ a: 'x' }], [{ key: 'missing', label: 'M' }])).toBe('M\n')
    // A carriage return is a line break to a CSV reader, so it is quoted; a tab inside is plain.
    expect(toCsv([{ a: 'a\rb', b: 'a\tb' }], cols).split('\n')[1]).toBe('"a\rb",a\tb')
  })
})

/** A document whose anchors record what they were asked to download. */
function stubDownloads() {
  const saved: { name: string; url: string; blob: Blob }[] = []
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  vi.stubGlobal('document', {
    createElement: () => {
      const a = { href: '', download: '', click: () => saved.push({ name: a.download, url: a.href, blob: blobs.get(a.href)! }), remove() {} }
      return a
    },
    body: { appendChild() {} },
  })
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    const u = `blob:${blobs.size}`
    blobs.set(u, b as Blob)
    return u
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u))
  return { saved, revoked, restore: () => (create.mockRestore(), revoke.mockRestore()) }
}

describe('downloads', () => {
  let d: ReturnType<typeof stubDownloads>
  beforeEach(() => {
    vi.useFakeTimers()
    d = stubDownloads()
  })
  afterEach(() => {
    d.restore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('downloadText names the file, types the blob (JSON by default), holds the text whole, and revokes the URL a second later; files and blobs go the same way', async () => {
    downloadText('a.ae.json', '{"x":1}')
    downloadText('b.csv', 'a,b', 'text/csv')
    expect(d.saved.map((s) => [s.name, s.blob.type])).toEqual([['a.ae.json', 'application/json'], ['b.csv', 'text/csv']])
    expect(await d.saved[0].blob.text()).toBe('{"x":1}')
    expect(d.revoked).toEqual([])
    vi.advanceTimersByTime(999)
    expect(d.revoked).toEqual([])
    vi.advanceTimersByTime(1)
    expect(d.revoked).toEqual(['blob:0', 'blob:1'])
    downloadFiles([{ name: 'x.svg', text: '<svg/>', mime: 'image/svg+xml' }, { name: 'y.txt', text: '', mime: 'text/plain' }])
    expect(d.saved.slice(2).map((s) => [s.name, s.blob.type, s.blob.size])).toEqual([['x.svg', 'image/svg+xml', 6], ['y.txt', 'text/plain', 0]])
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    downloadBlob('z.png', png)
    expect(d.saved[4].blob).toBe(png)
    expect(d.saved[4].name).toBe('z.png')
    downloadText('big.txt', 'x'.repeat(5_000_000), 'text/plain')
    expect(d.saved[5].blob.size).toBe(5_000_000)
  })
})

describe('observeSettledSize', () => {
  let callbacks: ((entries: { contentRect: DOMRectReadOnly }[]) => void)[]
  let disconnected: number
  beforeEach(() => {
    vi.useFakeTimers()
    callbacks = []
    disconnected = 0
    class FakeRO {
      cb: (entries: { contentRect: DOMRectReadOnly }[]) => void
      constructor(cb: (entries: { contentRect: DOMRectReadOnly }[]) => void) {
        this.cb = cb
        callbacks.push(cb)
      }
      observe() {}
      disconnect() {
        disconnected++
      }
    }
    vi.stubGlobal('ResizeObserver', FakeRO)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const rect = (w: number) => ({ width: w, height: 1 }) as DOMRectReadOnly

  it('a burst of resizes reports once with the last size after the settle time, a lone resize after the wait, and nothing once disconnected', () => {
    const seen: number[] = []
    const stop = observeSettledSize({} as Element, (r) => seen.push(r.width))
    const fire = (w: number) => callbacks[0]([{ contentRect: rect(w) }])
    for (let i = 1; i <= 20; i++) {
      fire(i * 10)
      vi.advanceTimersByTime(16)
    }
    expect(seen).toEqual([])
    vi.advanceTimersByTime(33) // 16 ms already passed since the last resize
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([200])
    fire(300)
    vi.advanceTimersByTime(50)
    expect(seen).toEqual([200, 300])
    fire(400)
    stop()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([200, 300])
    expect(disconnected).toBe(1)
    // A custom settle time, and a zero one still waits a tick.
    const quick: number[] = []
    observeSettledSize({} as Element, (r) => quick.push(r.width), 0)
    callbacks[1]([{ contentRect: rect(7) }])
    expect(quick).toEqual([])
    vi.advanceTimersByTime(0)
    expect(quick).toEqual([7])
  })
})

function viewFixture(): ViewExportContext {
  const s = new EntityStore()
  const a = createEntity({ id: 'a', type: 'person', label: 'Ada & Co' })
  const b = createEntity({ id: 'b', type: 'work', label: 'B' })
  const e = createRelationship({ id: 'e', type: 'wrote', source: 'a', target: 'b', directed: true })
  s.upsertMany([a, b, e])
  return {
    slice: { nodes: [a, b], edges: [e] },
    positions: { a: { x: 0, y: 0 }, b: { x: 100, y: 50 } },
    styles: {
      nodes: new Map<string, NodeStyle>([
        ['a', { color: '#ff0000', size: 8, shape: 'circle', opacity: 1, visible: true, label: true }],
        ['b', { color: '#00ff00', size: 5, shape: 'square', opacity: 1, visible: true, label: true }],
      ]),
      edges: new Map<string, EdgeStyle>([['e', { color: '#111111', width: 1, opacity: 1, visible: true, arrow: true }]]),
    },
    registry: new TypeRegistry(s),
    rendering: DEFAULT_RENDERING,
    labels: 'all',
  }
}

describe('exportView', () => {
  it('writes SVG with the view options, aegraph JSON of nodes and edges, every graph format under the view name, PNG through the snapshot, and refuses what it cannot', async () => {
    const ctx = viewFixture()
    const svg = (await exportView('svg', ctx, { width: 300, height: 200 })) as { name: string; text: string; mime: string }[]
    expect(svg[0].name).toBe('graph-view.svg')
    expect(svg[0].mime).toBe('image/svg+xml')
    expect(svg[0].text).toContain('Ada &amp; Co')
    expect(svg[0].text).toMatch(/width="300"/)
    const json = (await exportView('json', { ...ctx, name: 'mine' })) as { name: string; text: string }[]
    expect(json[0].name).toBe('mine.ae.json')
    const doc = JSON.parse(json[0].text) as { entities: { id: string }[]; tags: unknown[] }
    expect(doc.entities.map((x) => x.id)).toEqual(['a', 'b', 'e'])
    // RDF is import-only: its label exists, its export says so.
    await expect(exportView('rdf', ctx)).rejects.toThrow(/RDF export is not supported/)
    for (const id of ['gexf', 'graphml', 'cyjs', 'nodes_edges_csv'] as const) {
      const files = (await exportView(id, ctx)) as { name: string; text: string }[]
      expect(files.length, id).toBeGreaterThan(0)
      for (const f of files) expect(f.name, id).toMatch(/^graph-view/)
      expect(files.map((f) => f.text).join('\n'), id).toContain('a')
      expect(VIEW_EXPORT_LABELS[id]).toBeTruthy()
    }
    expect(Object.keys(VIEW_EXPORT_LABELS).sort()).toEqual(['cyjs', 'gexf', 'graphml', 'json', 'node_link_json', 'nodes_edges_csv', 'parquet', 'png', 'rdf', 'svg'])
    await expect(exportView('png', ctx)).rejects.toThrow(/cannot produce a PNG/)
    await expect(exportView('png', { ...ctx, snapshot: async () => null })).rejects.toThrow(/not ready/)
    const asked: unknown[] = []
    const blob = await exportView('png', { ...ctx, snapshot: async (o) => (asked.push(o), new Blob(['png'])) }, { width: 10, height: 20, background: 'transparent' })
    expect(blob).toBeInstanceOf(Blob)
    expect(asked).toEqual([{ width: 10, height: 20, background: 'transparent' }])
    await expect(exportView('bmp' as never, ctx)).rejects.toThrow(/Unknown export format bmp/)
    // An empty view still exports.
    const empty = (await exportView('svg', { ...ctx, slice: { nodes: [], edges: [] }, positions: {} })) as { text: string }[]
    expect(empty[0].text).toContain('<svg')
  })
})


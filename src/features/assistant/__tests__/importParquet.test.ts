import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { createAppTools } from '../tools'
import { withInputChecks } from '../validate'

/** import_graph over Parquet: fetched as bytes by URL (a points file, and a links file as edges_url), found by its PAR1 marker. */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../core/exchange/graph/__tests__/fixtures')
const serve = (f: string) => new Response(readFileSync(join(fixtures, f)), { headers: { 'content-type': 'application/octet-stream' } })

function setup() {
  const store = new EntityStore()
  const tools = createAppTools({ store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true })
  const t = withInputChecks(tools.find((x) => x.name === 'import_graph')!)
  return { store, run: async (input: unknown) => JSON.parse(String(await t.run(t.parse(input)))) }
}

describe('import_graph: parquet', () => {
  beforeEach(() => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:5199/'))
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) => serve(String(u).includes('links') ? 'links.parquet' : 'points.parquet')))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('imports points and links by URL: nodes typed by a column, positions as a layout, edges as relationships', async () => {
    const { store, run } = setup()
    const dry = await run({ url: '/datasets/points.parquet', edges_url: '/datasets/links.parquet', mapping: { type_attr: 'cluster', edge_type_attr: 'kind' }, parquet: { columns: ['cluster'] }, dry_run: true })
    expect(dry).toMatchObject({ dryRun: true, format: 'parquet', nodes: 5, edges: 3, mapping: { typeAttr: 'cluster', edgeTypeAttr: 'kind' } })
    // The columns asked for — and the id a repeated row was given, kept on its numbered node.
    expect(dry.attributeKeys.nodes).toEqual(['cluster', 'id'])
    const real = await run({ url: '/datasets/points.parquet', edges_url: '/datasets/links.parquet', mapping: { type_attr: 'cluster', edge_type_attr: 'kind' }, parquet: { columns: ['cluster'] } })
    expect(real).toMatchObject({ format: 'parquet', created: 5, relationships: 3 })
    expect(real.layout).toBeDefined()
    const labels = store.all().filter((e) => e.kind === 'entity' && e.meta.source === 'import:parquet').map((e) => e.label).sort()
    expect(labels).toEqual(expect.arrayContaining(['Graphs', 'Maps', 'Stars']))
  })

  it('knows a Parquet file by its bytes when the URL does not say, and refuses Parquet as text', async () => {
    const { run } = setup()
    expect(await run({ url: '/files/download?id=7', dry_run: true })).toMatchObject({ format: 'parquet', nodes: 5 })
    await expect(run({ format: 'parquet', text: 'PAR1' })).rejects.toThrow(/from a `url`/)
    await expect(run({ format: 'cyjs', text: '{}', edges_url: '/x.parquet' })).rejects.toThrow(/two-file format/)
  })

  it('refuses a fetched file past the graph file bound — by the size the server gives, or as it arrives', async () => {
    const { run } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-type': 'text/turtle', 'content-length': String(200 * 1024 * 1024) } })))
    await expect(run({ url: '/datasets/huge.nt', dry_run: true })).rejects.toThrow(/huge\.nt is 200\.0 MB — a graph file can be at most 128 MB/)
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => void ((sent += chunk.length), c.enqueue(chunk)) }), { headers: { 'content-type': 'text/turtle' } })))
    await expect(run({ url: '/datasets/endless.nt', dry_run: true })).rejects.toThrow(/endless\.nt is more than 128 MB/)
    expect(sent).toBeLessThan(140 * 1024 * 1024)
  })
})

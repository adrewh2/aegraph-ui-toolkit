import { describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import { EntityStore } from '../../../entity/store'
import '../../../graph/types'
import { parseCyjs } from '../cyjs'
import { splitGexfList } from '../gexf'
import { checkGraphBytes, checkGraphShape, GRAPH_FILE_LIMITS, GraphTooLargeError, readGraphResponse } from '../limits'
import { applyGraphPlan, distinctNodeId, inferGraphMapping, planGraphImport } from '../mapping'
import { parseParquetGraph } from '../parquet'
import { parseRdf } from '../rdf'
import { XmlDomParser } from './xmlParsers'

vi.mock('graphology-gexf/browser', async () => (await import('./xmlParsers')).gexfBrowser())
vi.mock('graphology-graphml/browser', async () => (await import('./xmlParsers')).graphmlBrowser())
vi.stubGlobal('DOMParser', XmlDomParser)

/**
 * A graph file is someone else's words about names and ids. The XML libraries key plain objects by what a file
 * says, so a name a plain object already answers to is refused before they see it; every reader drops keys that
 * would reach an object's machinery; an import touches only what an import made unless asked; and a file is bounded
 * in bytes, nodes and edges.
 */
const graphml = (keys: string, body = '<node id="a"><data key="d">x</data></node>') =>
  `<?xml version="1.0"?><graphml xmlns="http://graphml.graphdrawing.org/xmlns">${keys}<graph edgedefault="directed">${body}</graph></graphml>`
const gexf = (attrs: string, nodes: string) => `<?xml version="1.0"?><gexf xmlns="http://gexf.net/1.2" version="1.2"><graph defaultedgetype="directed"><attributes class="node">${attrs}</attributes><nodes>${nodes}</nodes><edges/></graph></gexf>`
const clean = () => {
  const o = {} as Record<string, unknown>
  return o.baseURL === undefined && o.evilkey === undefined && o.z === undefined && typeof Object.fromEntries === 'function' && Object.keys(Object.prototype).length === 0
}

describe('GraphML and GEXF are read before the libraries see them', () => {
  it('refuses a <key> whose scope, id or name a plain object already answers to — Object.prototype stays untouched', async () => {
    const { parseGraphml } = await import('../graphml')
    const attacks = [
      '<key id="baseURL" for="__proto__" attr.name="baseURL"><default>https://attacker.example/</default></key>',
      '<key id="fromEntries" for="constructor" attr.name="x"/>',
      '<key id="d" for="node" attr.name="__proto__"/>',
      '<key id="toString" for="node" attr.name="t"/>',
      '<key id="d" for="nodes" attr.name="t"/>',
    ]
    for (const k of attacks) await expect(parseGraphml(graphml(k)), k).rejects.toThrow(/This GraphML file (uses|has)/)
    await expect(parseGraphml(graphml('<key id="d" for="node" attr.name="t"/>', '<node id="a"><data key="__proto__">x</data></node>'))).rejects.toThrow(/as a data key/)
    expect(clean()).toBe(true)
  })

  it('still reads keys for all, unknown attribute types as text, and refuses a document type declaration', async () => {
    const { parseGraphml } = await import('../graphml')
    const g = await parseGraphml(graphml('<key id="w" for="all" attr.name="w" attr.type="int"/><key id="s" for="node" attr.name="s" attr.type="constructor"/>', '<node id="a"><data key="w">3</data><data key="s">x</data></node><node id="b"/><edge source="a" target="b"><data key="w">5</data></edge>'))
    expect(g.nodes.find((n) => n.id === 'a')?.attrs).toMatchObject({ w: 3, s: 'x' })
    expect(g.edges[0].attrs).toMatchObject({ w: 5 })
    await expect(parseGraphml(`<?xml version="1.0"?><!DOCTYPE g [<!ENTITY a "AAAA">]>${graphml('').slice(21)}`)).rejects.toThrow(/declares a document type/)
  })

  it('refuses a GEXF attribute named for an object’s machinery, and splits list values in one pass', async () => {
    const { parseGexf } = await import('../gexf')
    await expect(parseGexf(gexf('<attribute id="__proto__" title="__proto__" type="string"><default>z</default></attribute>', '<node id="x"/>'))).rejects.toThrow(/This GEXF file uses "__proto__"/)
    await expect(parseGexf(gexf('', '<node id="x"><attvalues><attvalue for="constructor" value="1"/></attvalues></node>'))).rejects.toThrow(/"constructor"/)
    expect(clean()).toBe(true)
    const spaces = 'a' + ' '.repeat(200_000) + 'b,c'
    const t = performance.now()
    const g = await parseGexf(gexf('<attribute id="0" title="l" type="liststring"/><attribute id="1" title="n" type="listinteger"/>', `<node id="x"><attvalues><attvalue for="0" value="${spaces}"/><attvalue for="1" value="[1, 2, 3]"/></attvalues></node>`))
    expect(performance.now() - t).toBeLessThan(2_000)
    expect(g.nodes[0].attrs).toEqual({ l: ['a' + ' '.repeat(200_000) + 'b', 'c'], n: [1, 2, 3] })
    expect(splitGexfList('a | b|c')).toEqual(['a', 'b', 'c'])
    expect(splitGexfList('["a,b", \'c\', d\\,e]')).toEqual(['a,b', 'c', 'd,e'])
    expect(splitGexfList('plain')).toEqual(['plain'])
  })
})

describe('keys that name an object’s machinery are dropped', () => {
  it('from Cytoscape JSON, RDF predicates and the import plan', async () => {
    const p = await parseCyjs('{"elements":{"nodes":[{"data":{"id":"a","label":"A","__proto__":{"injected":"yes"},"constructor":{"x":1},"ok":1}}],"edges":[]}}')
    expect(Object.keys(p.nodes[0].attrs)).toEqual(['ok'])
    const store = new EntityStore()
    applyGraphPlan(store, planGraphImport(store, p, inferGraphMapping(p, 'x.cyjs')))
    const e = store.all().find((x) => x.label === 'A')!
    expect(Object.getPrototypeOf(e.data)).toBe(Object.prototype)
    expect((e.data as Record<string, unknown>).injected).toBeUndefined()
    const rdf = parseRdf('@prefix ex: <http://ex.org/> .\nex:a ex:__proto__ "x" ; ex:constructor "y" ; ex:name "A" .')
    expect(Object.getPrototypeOf(rdf.nodes[0].attrs)).toBe(Object.prototype)
    expect(Object.keys(rdf.nodes[0].attrs).sort()).toEqual(['iri', 'name'])
  })

  it('keeps a node’s colour only when it is a colour: it is drawn as CSS', async () => {
    const p = await parseCyjs('{"elements":{"nodes":[{"data":{"id":"a","label":"A","color":"red;background:url(https://evil.example/x)"}},{"data":{"id":"b","label":"B","color":"#3366ff"}}],"edges":[]}}')
    const store = new EntityStore()
    applyGraphPlan(store, planGraphImport(store, p, { ...inferGraphMapping(p, 'x.cyjs'), importColors: true }))
    const of = (label: string) => (store.all().find((x) => x.label === label)!.data as Record<string, unknown>).color
    expect(of('A')).toBeUndefined()
    expect(of('B')).toBe('#3366ff')
  })

  it('keeps RDF de-duplication linear in a subject’s statements', () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `<http://ex.org/s> <http://ex.org/p> <http://ex.org/o${i % 15_000}> .`).join('\n')
    const t = performance.now()
    const g = parseRdf(lines, { format: 'N-Triples' })
    expect(performance.now() - t).toBeLessThan(5_000)
    expect(g.edges).toHaveLength(15_000)
  })
})

describe('an import touches only what an import made, unless asked', () => {
  const library = () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'victim', type: 'person', label: 'Alice', data: { note: 'kept' } }),
      createEntity({ id: 'v2', type: 'person', label: 'Bob' }),
      createRelationship({ id: 'rel', type: 'knows', source: 'victim', target: 'v2' }),
    ])
    return store
  }
  const evil = async () => parseCyjs(JSON.stringify({ elements: { nodes: [{ data: { id: 'victim', label: 'PWNED', note: 'overwritten', type: 'hacked' } }, { data: { id: 'n2' } }], edges: [{ data: { id: 'rel', source: 'n2', target: 'n2', type: 'hijacked' } }] } }))

  it('by default: a node id that names someone else’s entity gets an id of its own, and a relationship id is not taken', async () => {
    const store = library()
    const p = await evil()
    const m = inferGraphMapping(p, 'evil.cyjs')
    expect(m.reuseExistingIds).toBe(false)
    applyGraphPlan(store, planGraphImport(store, p, m))
    expect(store.get('victim')).toMatchObject({ label: 'Alice', type: 'person', data: { note: 'kept' } })
    expect(store.get('rel')).toMatchObject({ type: 'knows', source: { id: 'victim' }, target: { id: 'v2' } })
  })

  it('when asked: a reused entity keeps its type, and a relationship id is reused only between the same two entities', async () => {
    const store = library()
    const p = await evil()
    applyGraphPlan(store, planGraphImport(store, p, { ...inferGraphMapping(p, 'evil.cyjs'), reuseExistingIds: true }))
    expect(store.get('victim')).toMatchObject({ label: 'PWNED', type: 'person' })
    expect(store.get('rel')).toMatchObject({ type: 'knows', source: { id: 'victim' }, target: { id: 'v2' } })
  })

  it('verbatim ids (RDF) update what a graph import wrote, and leave anything else where it is', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'dbr:Berlin', type: 'city', label: 'My Berlin', data: { note: 'kept' } }))
    const rdf = parseRdf('<http://dbpedia.org/resource/Berlin> <http://ex.org/twin> <http://dbpedia.org/resource/Paris> .', { format: 'N-Triples' })
    const m = inferGraphMapping(rdf, 'x.nt')
    expect(m.idMode).toBe('verbatim')
    const plan = planGraphImport(store, rdf, m, 'import:rdf')
    expect(plan.entities.map((e) => e.id)).toEqual([distinctNodeId(m.importKey, 'dbr:Berlin'), 'dbr:Paris'])
    applyGraphPlan(store, plan)
    expect(store.get('dbr:Berlin')).toMatchObject({ label: 'My Berlin', type: 'city', data: { note: 'kept' } })
    // Read again, the import's own entities are updated in place.
    expect(planGraphImport(store, rdf, m, 'import:rdf')).toMatchObject({ created: 0, updated: 2 })
    // What a graph import wrote is the same IRI read again.
    const fresh = new EntityStore()
    applyGraphPlan(fresh, planGraphImport(fresh, rdf, m, 'import:rdf'))
    expect(planGraphImport(fresh, rdf, m, 'import:rdf').entities.map((e) => e.id)).toEqual(['dbr:Berlin', 'dbr:Paris'])
  })
})

describe('graph files are bounded', () => {
  it('refuses a file past the byte bound, a graph past the node or edge bound, and a download past the bound as it arrives', async () => {
    expect(() => checkGraphBytes('g.graphml', GRAPH_FILE_LIMITS.bytes + 1)).toThrow(GraphTooLargeError)
    expect(() => checkGraphShape('g', { nodes: { length: 11 }, edges: [] }, { ...GRAPH_FILE_LIMITS, nodes: 10 })).toThrow(/11 nodes — a graph import takes at most 10/)
    expect(() => checkGraphShape('g', { nodes: [], edges: { length: 3 } }, { ...GRAPH_FILE_LIMITS, edges: 2 })).toThrow(/3 edges/)
    const limits = { ...GRAPH_FILE_LIMITS, bytes: 1_000 }
    const said = new Response('x', { headers: { 'content-length': '5000' } })
    await expect(readGraphResponse(said, 'big.nt', limits)).rejects.toThrow(/big\.nt is 0\.0 MB — a graph file can be at most 0 MB/)
    let sent = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 512
        c.enqueue(new Uint8Array(512))
      },
    })
    await expect(readGraphResponse(new Response(endless), 'stream.nt', limits)).rejects.toThrow(GraphTooLargeError)
    expect(sent).toBeLessThan(10_000)
    expect(new Uint8Array(await readGraphResponse(new Response('abc'), 'ok.nt', limits))).toEqual(new TextEncoder().encode('abc'))
  })

  it('reads a Parquet points table through the bounded reader, its rows against the node bound', async () => {
    const { parquetBomb } = await import('../../../datasets/__tests__/parquetBomb')
    const ok = await parseParquetGraph(parquetBomb(4, 20).slice().buffer as ArrayBuffer)
    expect(ok.nodes).toHaveLength(20)
    await expect(parseParquetGraph(parquetBomb(4, 20).slice().buffer as ArrayBuffer, undefined, { limits: { ...GRAPH_FILE_LIMITS, nodes: 10 } })).rejects.toThrow(GraphTooLargeError)
  })
})

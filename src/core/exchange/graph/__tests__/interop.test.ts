import { XmlDomParser } from './xmlParsers'
import { describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import { EntityStore } from '../../../entity/store'
import { TypeRegistry } from '../../../entity/typeRegistry'
import { curvatureFor, indexParallelEdges } from '../../../graph/parallel'
import type { EdgeStyle, NodeStyle } from '../../../graph/rendering'
import '../../../graph/types'
import { parseCyjs, writeCyjs } from '../cyjs'
import { findGraphFormat, GRAPH_FORMATS, graphFormat, matchGraphImport } from '../graphFormats'
import { graphmlString } from '../graphml'
import { fromGraphology, toGraphology } from '../graphology'
import { applyGraphPlan, inferGraphMapping, planGraphImport, removeGraphImport } from '../mapping'
import { parseNodesEdgesCsv, writeNodesEdgesCsv } from '../nodesEdgesCsv'
import { svgFromView } from '../svg'

// The browser builds need DOMParser; vitest runs in node, so route them to the node builds, and read the document
// (`xml.ts › parseXmlDocument`, before the library sees it) with xmldom's.
vi.mock('graphology-gexf/browser', async () => (await import('./xmlParsers')).gexfBrowser())
vi.mock('graphology-graphml/browser', async () => (await import('./xmlParsers')).graphmlBrowser())
vi.stubGlobal('DOMParser', XmlDomParser)

function fixture() {
  const s = new EntityStore()
  const a = createEntity({ id: 'a', type: 'person', label: 'Ada & Co', tags: ['x', 'y'], data: { year: 1900, label: 'reserved', nested: { k: 1 } } })
  const b = createEntity({ id: 'b', type: 'person', label: 'Bob', data: { year: 1950.5 } })
  const c = createEntity({ id: 'c', type: 'work', label: 'C', data: {} })
  s.upsertMany([a, b, c])
  const edges = [
    createRelationship({ id: 'e1', type: 'knows', source: 'a', target: 'b', directed: true, data: { weight: 2 } }),
    createRelationship({ id: 'e2', type: 'knows', source: 'a', target: 'b', directed: true }),
    createRelationship({ id: 'e3', type: 'wrote', source: 'b', target: 'c', directed: false }),
  ]
  s.upsertMany(edges)
  const nodes = [a, b, c]
  const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 50 }, c: { x: 50, y: 100 } }
  const styles = {
    nodes: new Map<string, NodeStyle>([
      ['a', { color: '#ff0000', size: 8, shape: 'circle', opacity: 1, visible: true, label: true }],
      ['b', { color: '#00ff00', size: 5, shape: 'square', opacity: 0.5, visible: true, label: true }],
      ['c', { color: '#0000ff', size: 4, shape: 'diamond', opacity: 1, visible: true, label: false }],
    ]),
    edges: new Map<string, EdgeStyle>([
      ['e1', { color: '#111111', width: 1, opacity: 0.6, visible: true, arrow: true }],
      ['e2', { color: '#222222', width: 2, opacity: 0.6, visible: true, arrow: true }],
      ['e3', { color: '#333333', width: 1, opacity: 0.6, visible: false, arrow: true }],
    ]),
  }
  return { s, nodes, edges, positions, styles, registry: new TypeRegistry(s) }
}

describe('registry', () => {
  it('finds formats by extension and matches dropped file sets', () => {
    expect(findGraphFormat('x.gexf')?.id).toBe('gexf')
    expect(findGraphFormat('x.GRAPHML')?.id).toBe('graphml')
    expect(findGraphFormat('x.csv')).toBeUndefined()
    expect(matchGraphImport([{ name: 'g.cyjs' }])?.format.id).toBe('cyjs')
    expect(matchGraphImport([{ name: 'my-nodes.csv' }, { name: 'my-edges.csv' }])?.format.id).toBe('nodes_edges_csv')
    expect(matchGraphImport([{ name: 'a.csv' }, { name: 'b.csv' }])).toBeUndefined()
    expect(GRAPH_FORMATS.every((f) => f.canImport)).toBe(true)
    expect(GRAPH_FORMATS.filter((f) => !f.canExport).map((f) => f.id)).toEqual(['node_link_json', 'rdf', 'parquet'])
    // Node-link JSON is named or recognised by what a file holds, never claimed by `.json`, which is aegraph's own.
    expect(findGraphFormat('miserables.json')).toBeUndefined()
    expect(graphFormat('gexf').files).toBe(1)
  })
})

describe('graphology adapter', () => {
  it('round-trips attributes, viz and directedness', () => {
    const { nodes, edges, positions, styles } = fixture()
    const g = toGraphology({ nodes, edges, positions, styles })
    expect(g.getNodeAttributes('a')).toMatchObject({ label: 'Ada & Co', type: 'person', tags: ['x', 'y'], color: '#ff0000', size: 8, x: 0, y: 0, year: 1900, data_label: 'reserved', nested: '{"k":1}' })
    expect(g.isDirected('e1')).toBe(true)
    expect(g.isUndirected('e3')).toBe(true)
    expect(g.getEdgeAttribute('e1', 'weight')).toBe(2)
    const p = fromGraphology(g)
    expect(p.nodes.find((n) => n.id === 'a')).toMatchObject({ label: 'Ada & Co', viz: { color: '#ff0000', size: 8, x: 0, y: 0 } })
    expect(p.edges.find((e) => e.id === 'e3')?.directed).toBe(false)
    expect(p.attributeKeys.nodes).toContain('type')
  })
})

describe('gexf & graphml', () => {
  it('writes and parses GEXF with viz data', async () => {
    const { nodes, edges, positions, styles, s } = fixture()
    const { parseGexf, writeGexf } = await import('../gexf')
    const [file] = await writeGexf({ nodes, edges, positions, styles, name: 'v' })
    expect(file.name).toBe('v.gexf')
    expect(file.text).toContain('<gexf')
    expect(file.text).toContain('viz:position')
    expect(file.text).toContain('viz:color')
    const parsed = await parseGexf(file.text)
    expect(parsed.nodes).toHaveLength(3)
    expect(parsed.nodes.find((n) => n.id === 'b')?.viz).toMatchObject({ x: 100, y: 50, color: '#00ff00' })
    expect(parsed.edges.find((e) => e.id === 'e3')?.directed).toBe(false)
    // Round trip into the store, reusing ids when asked (off by default): ids reused, layout captured.
    const m = inferGraphMapping(parsed, 'v.gexf')
    expect(m.typeAttr).toBe('type')
    expect(m.reuseExistingIds).toBe(false)
    const plan = planGraphImport(s, parsed, { ...m, reuseExistingIds: true })
    expect(plan).toMatchObject({ created: 0, updated: 0, reused: 3, skippedEdges: 0 })
    expect(plan.layout?.data.positions.b).toEqual({ x: 100, y: 50 })
    expect(plan.relationships.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e3'])
  })
  it('parses a Gephi-style GEXF and writes GraphML with typed keys', async () => {
    const gexf = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://www.gexf.net/1.2draft" xmlns:viz="http://www.gexf.net/1.2draft/viz" version="1.2">
<graph defaultedgetype="directed"><attributes class="node"><attribute id="0" title="category" type="string"/></attributes>
<nodes><node id="n1" label="One"><attvalues><attvalue for="0" value="Person"/></attvalues><viz:color r="255" g="0" b="0"/><viz:position x="1" y="2" z="0"/></node><node id="n2" label="Two"/></nodes>
<edges><edge id="x" source="n1" target="n2" weight="3" type="undirected"/></edges></graph></gexf>`
    const { parseGexf } = await import('../gexf')
    const p = await parseGexf(gexf)
    expect(p.nodes[0]).toMatchObject({ id: 'n1', label: 'One', attrs: { category: 'Person' }, viz: { color: '#ff0000', x: 1, y: 2 } })
    expect(p.edges[0]).toMatchObject({ directed: false, weight: 3 })
    const m = inferGraphMapping(p, 'people.gexf')
    expect(m.typeAttr).toBe('category')
    const s = new EntityStore()
    const plan = planGraphImport(s, p, m)
    expect(plan.entities[0]).toMatchObject({ type: 'person', label: 'One', data: { importedId: 'n1', color: '#ff0000' } })
    expect(plan.entities[1].type).toBe('node')
    expect(plan.relationships[0]).toMatchObject({ directed: false, data: { weight: 3 } })
    applyGraphPlan(s, plan)
    expect(s.entityCount()).toBe(3) // two nodes + the layout entity
    expect(planGraphImport(s, p, m)).toMatchObject({ created: 0, updated: 2 })
    expect(removeGraphImport(s, m.importKey)).toBe(4)

    const { nodes, edges } = fixture()
    const xml = graphmlString({ nodes, edges })
    expect(xml).toContain('attr.name="year" attr.type="double"')
    expect(xml).toContain('attr.name="type" attr.type="string"')
    expect(xml).toContain('directed="false"')
    expect(xml).toContain('Ada &amp; Co')
    const { parseGraphml } = await import('../graphml')
    const back = await parseGraphml(xml)
    expect(back.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
    expect(back.nodes.find((n) => n.id === 'a')?.attrs.year).toBe(1900)
    expect(back.edges.find((e) => e.id === 'e3')?.directed).toBe(false)
  })
})

describe('cyjs & csv', () => {
  it('round-trips Cytoscape JSON in both shapes', async () => {
    const { nodes, edges, positions } = fixture()
    const [file] = await writeCyjs({ nodes, edges, positions })
    const doc = JSON.parse(file.text)
    expect(doc.elements.nodes[0].data.id).toBe('a')
    expect(doc.elements.nodes[1].position).toEqual({ x: 100, y: -50 })
    const p = await parseCyjs(file.text)
    expect(p.nodes.find((n) => n.id === 'b')?.viz).toMatchObject({ x: 100, y: 50 })
    expect(p.edges).toHaveLength(3)
    const flat = await parseCyjs(JSON.stringify([{ data: { id: 'n1', name: 'N' } }, { data: { id: 'n2' } }, { data: { source: 'n1', target: 'n2' } }, { data: { id: 'bad' }, group: 'edges' }]))
    expect(flat.nodes[0].label).toBe('N')
    expect(flat.edges).toHaveLength(1)
    expect(flat.warnings).toHaveLength(1)
  })
  it('writes and parses Gephi nodes/edges CSV', async () => {
    const { nodes, edges, positions, s } = fixture()
    const [n, e] = await writeNodesEdgesCsv({ nodes, edges, positions, name: 'g' })
    expect(n.name).toBe('g-nodes.csv')
    expect(n.text.split('\n')[0]).toBe('Id,Label,Type,Tags,X,Y,year,nested')
    expect(e.text).toContain('a,b,Directed,e1,knows,2,knows')
    expect(e.text).toContain('b,c,Undirected,e3')
    const p = await parseNodesEdgesCsv(n.text, e.text)
    expect(p.nodes.find((x) => x.id === 'a')).toMatchObject({ label: 'Ada & Co', attrs: { Type: 'person', year: 1900 }, viz: { x: 0, y: 0 } })
    expect(p.edges.find((x) => x.id === 'e3')?.directed).toBe(false)
    const m = inferGraphMapping(p, 'g-nodes.csv')
    expect(m.typeAttr).toBe('Type')
    expect(m.edgeTypeAttr).toBe('RelationshipType')
    const plan = planGraphImport(s, p, { ...m, reuseExistingIds: true })
    expect(plan.reused).toBe(3)
    expect(plan.relationships.find((r) => r.id === 'e1')?.type).toBe('knows')
    await expect(parseNodesEdgesCsv('Id\n1', 'From,To\n1,2')).rejects.toThrow('Source and Target')
  })
})

describe('svg & parallel edges', () => {
  it('indexes parallel bundles symmetrically', () => {
    const { edges } = fixture()
    const idx = indexParallelEdges(edges)
    expect(idx.get('e1')).toEqual({ index: -0.5, count: 2 })
    expect(idx.get('e2')).toEqual({ index: 0.5, count: 2 })
    expect(idx.has('e3')).toBe(false)
    expect(curvatureFor(undefined)).toBeUndefined()
    expect(curvatureFor({ index: 0, count: 3 })).toBeUndefined()
    expect(curvatureFor({ index: 1, count: 3 })).toBeGreaterThan(0)
    expect(curvatureFor({ index: -1, count: 3 })).toBeLessThan(0)
  })
  it('renders shapes, edges, markers, labels and flips y', () => {
    const { nodes, edges, positions, styles } = fixture()
    const svg = svgFromView({ nodes, edges }, positions, styles, { width: 400, height: 300, labels: 'all', curvedEdges: true, edgeLabels: true })
    expect(svg).toContain('<circle')
    expect(svg).toContain('<rect x=')
    expect(svg).toContain('<polygon')
    expect(svg.match(/<path d="M[\d.]+ /g)?.length).toBe(2) // the parallel pair curves
    expect(svg).not.toContain('data-id="e3"') // hidden edge
    expect(svg).toContain('marker-end="url(#a0)"')
    expect(svg).toContain('Ada &amp; Co')
    expect(svg).toContain('>knows<')
    expect(svg).not.toContain('>C<') // label:false
    // c has the highest graph y, so it must be the topmost (smallest svg y) node.
    const cy = (id: string) => Number(/data-id="c"/.test(svg) ? svg.match(new RegExp(`points="([\\d.]+),([\\d.]+)[^"]*" fill="#0000ff"[^>]*data-id="${id}"`))?.[2] : NaN)
    const cxa = Number(svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)"/)?.[2])
    expect(cy('c')).toBeLessThan(cxa)
    expect(svgFromView({ nodes, edges }, positions, styles, { width: 400, height: 300 })).toBe(svgFromView({ nodes, edges }, positions, styles, { width: 400, height: 300 }))
    expect(svgFromView({ nodes: [], edges: [] }, {}, styles)).toContain('<svg')
  })
})

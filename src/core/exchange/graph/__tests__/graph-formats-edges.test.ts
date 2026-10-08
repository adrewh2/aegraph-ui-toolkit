import { XmlDomParser } from './xmlParsers'
import { describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import { EntityStore } from '../../../entity/store'
import '../../../graph/types'
import { parseCyjs, writeCyjs } from '../cyjs'
import { colorToHex, fromGraphology, toGraphology } from '../graphology'
import { applyGraphPlan, distinctNodeId, importKeyFor, inferGraphMapping, planGraphImport, removeGraphImport, slugType, type GraphMappingSpec } from '../mapping'
import { attributeKeys, type ParsedGraph } from '../model'
import { parseNodesEdgesCsv, writeNodesEdgesCsv } from '../nodesEdgesCsv'
import { inferAttrType, xmlEscape } from '../xml'

vi.mock('graphology-gexf/browser', async () => (await import('./xmlParsers')).gexfBrowser())
vi.mock('graphology-graphml/browser', async () => (await import('./xmlParsers')).graphmlBrowser())
vi.stubGlobal('DOMParser', XmlDomParser)

/**
 * The graph interchange formats at their edges: each parser on a node
 * without an id or label, duplicate ids, an edge to a node that is not
 * there, a self-loop, typed attributes, an undirected default, an empty
 * document; the mapping on every spelling of the spec (verbatim ids,
 * no reuse, forced direction, stubs, edge ids given twice, labels that
 * equal the type); the helpers; and what each writer carries back.
 */
const parsed = (over: Partial<ParsedGraph> = {}): ParsedGraph => ({ nodes: [], edges: [], directedDefault: true, attributeKeys: { nodes: [], edges: [] }, warnings: [], ...over })
const spec = (over: Partial<GraphMappingSpec> = {}): GraphMappingSpec => ({ importKey: 'k1', typeBy: 'fixed', fixedType: 'node', edgeTypeBy: 'fixed', fixedEdgeType: 'related', directed: 'file', attrsToData: true, importLayout: true, importColors: true, reuseExistingIds: true, tags: [], ...over })

describe('cyjs', () => {
  it('numbers a node without an id, takes a name as the label and keeps it as an attribute, drops the edge that lacks an end, keeps a self-loop and one to nowhere, and reads an empty document', async () => {
    const p = await parseCyjs(JSON.stringify({ elements: { nodes: [{ data: {} }, { data: { id: 7, name: 'Seven', label: 'L' } }, { data: { id: 'p', color: 'red' }, position: { x: '1', y: 2 } }], edges: [{ data: { source: 7, target: 7, directed: false } }, { data: { source: 'p', target: 'ghost' } }, { data: { id: 'half', source: 'p' } }] } }))
    expect(p.nodes.map((n) => n.id)).toEqual(['n0', '7', 'p'])
    expect(p.nodes[1]).toMatchObject({ label: 'L', attrs: { name: 'Seven' } })
    expect(p.nodes[2].viz).toEqual({ color: 'red' }) // a position with a string x is not one
    expect(p.nodes[2].attrs).toEqual({ color: 'red' })
    expect(p.edges).toHaveLength(2)
    expect(p.edges[0]).toMatchObject({ source: '7', target: '7', directed: false, attrs: {} }) // `directed` is read, not kept as an attribute
    expect(p.edges[0].id).toBeUndefined()
    expect(p.warnings).toEqual(['Skipped an edge without source/target.'])
    for (const empty of ['{}', '[]', '{"elements":[]}', '{"elements":{}}']) expect(await parseCyjs(empty)).toEqual(parsed())
    // A flat list sorts by group first, then by the presence of both ends.
    const flat = await parseCyjs(JSON.stringify([{ group: 'nodes', data: { id: 'n', source: 'a', target: 'b' } }, { data: { id: 'e', source: 'n', target: 'n' } }]))
    expect(flat.nodes.map((n) => n.id)).toEqual(['n'])
    expect(flat.edges.map((e) => e.id)).toEqual(['e'])
  })

  it('writes what the mapping reads back without leaving format fields in the data, and drops edges to nodes not exported', async () => {
    const s = new EntityStore()
    const a = createEntity({ id: 'a', type: 'person', label: 'A', tags: ['t1', 't2'], data: { n: 1 } })
    const b = createEntity({ id: 'b', type: 'person' })
    const e = createRelationship({ id: 'e', type: 'knows', source: 'a', target: 'b', directed: false, data: { since: 1999 } })
    const stray = createRelationship({ id: 'x', type: 'knows', source: 'a', target: 'zz' })
    const [file] = await writeCyjs({ nodes: [a, b], edges: [e, stray] })
    const doc = JSON.parse(file.text)
    expect(doc.elements.edges).toHaveLength(1)
    expect(doc.elements.nodes[1].data.label).toBe('b') // no label: the id stands in
    const p = await parseCyjs(file.text)
    const m = inferGraphMapping(p, 'x.cyjs')
    expect(m).toMatchObject({ typeAttr: 'type', tagsAttr: 'tags', edgeTypeAttr: 'type', importLayout: false, importColors: false })
    const plan = planGraphImport(s, p, m)
    expect(plan.entities[0]).toMatchObject({ id: 'gi-' + m.importKey + '-n-a', type: 'person', label: 'A', tags: ['t1', 't2'], data: { n: 1, importedId: 'a' } })
    expect(plan.relationships[0]).toMatchObject({ type: 'knows', directed: false, data: { since: 1999 } })
    expect(plan.relationships[0].label).toBeUndefined() // the label equalled the type
    expect(Object.keys(plan.relationships[0].data).sort()).toEqual(['since', 'tags']) // edge tags come back as data: the mapping's tags column is for nodes
  })
})

describe('nodes/edges csv', () => {
  it('finds the id column by name or takes the first, numbers a blank id, coerces cells, reads colour and positions, and warns on an edge row without ends', async () => {
    const p = await parseNodesEdgesCsv('Name,Label,Colour,X,Y,Size,n,b,sci\nn1,One,#f00,1,2,3,007,true,1e3\n,Two,,,,,, ,TRUE\n', 'Source,Target,Type,Weight,Id\nn1,n1,undirected,2,e\nn1,,,,\n')
    expect(p.nodes[0]).toMatchObject({ id: 'n1', label: 'One', attrs: { n: 7, b: true, sci: 1000 }, viz: { color: '#f00', x: 1, y: 2, size: 3 } })
    expect(p.nodes[1]).toMatchObject({ id: 'n1', label: 'Two', attrs: { b: ' ', sci: 'TRUE' } })
    expect(p.nodes[1].viz).toBeUndefined()
    expect(p.edges[0]).toMatchObject({ id: 'e', source: 'n1', target: 'n1', directed: false, weight: 2, attrs: {} })
    expect(p.warnings).toEqual(['Skipped an edge row without source/target.'])
    // No id-like column: the first column is the id; no edges file: no edges; an empty file: no nodes.
    expect((await parseNodesEdgesCsv('Foo,Bar\nx,y\n')).nodes[0]).toMatchObject({ id: 'x', attrs: { Bar: 'y' } })
    expect((await parseNodesEdgesCsv('Id\na\n')).edges).toEqual([])
    expect(await parseNodesEdgesCsv('')).toEqual(parsed())
    // A Type cell that is not "undirected" is directed; a missing Type leaves it to the default.
    const t = await parseNodesEdgesCsv('Id\na\n', 'Source,Target,Type\na,a,Mutual\na,a,\n')
    expect(t.edges.map((e) => e.directed)).toEqual([true, undefined])
  })

  it('does not put NaN in a weight or a position it cannot read', async () => {
    const p = await parseNodesEdgesCsv('Id,X,Y\na,here,2\n', 'Source,Target,Weight\na,a,heavy\n')
    expect(p.nodes[0].viz).toEqual({ y: 2 }) // half a position: the mapping wants both
    expect(p.edges[0].weight).toBeUndefined()
    expect(p.edges[0].attrs).toEqual({})
  })

  it('writes Type, Tags and data columns, positions and styles when given, a default weight of 1, and drops reserved data keys', async () => {
    const a = createEntity({ id: 'a', type: 'person', label: 'A', tags: ['x', 'y'], data: { label: 'reserved', year: 1900, nested: { k: 1 }, list: [1, 2] } })
    const b = createEntity({ id: 'b', type: 'work' })
    const e = createRelationship({ id: 'e', type: 'wrote', source: 'a', target: 'b', label: 'Wrote it', data: { weight: 3, note: 'n' } })
    const f = createRelationship({ id: 'f', type: 'wrote', source: 'b', target: 'a' })
    const [n, ed] = await writeNodesEdgesCsv({ nodes: [a, b], edges: [e, f] })
    expect(n.name).toBe('graph-nodes.csv')
    expect(n.text).toBe('Id,Label,Type,Tags,list,nested,year\na,A,person,x;y,1;2,"{""k"":1}",1900\nb,b,work,,,,\n') // data columns by count, then name
    expect(ed.text).toBe('Source,Target,Type,Id,Label,Weight,RelationshipType,Tags,note\na,b,Directed,e,Wrote it,3,wrote,,n\nb,a,Directed,f,wrote,1,wrote,,\n')
    const p = await parseNodesEdgesCsv(n.text, ed.text)
    const m = inferGraphMapping(p, 'graph-nodes.csv')
    const plan = planGraphImport(new EntityStore(), p, m)
    expect(plan.entities[0]).toMatchObject({ type: 'person', tags: ['x', 'y'], data: { year: 1900, nested: '{"k":1}', list: '1;2', importedId: 'a' } }) // nested and list come back as text
    expect(plan.entities[0].data).not.toHaveProperty('label')
    expect(plan.relationships[0]).toMatchObject({ type: 'wrote', label: 'Wrote it', data: { weight: 3, note: 'n' } })
    expect(plan.relationships[1]).toMatchObject({ type: 'wrote', data: { weight: 1 } })
    expect(plan.relationships[1].label).toBeUndefined()
  })
})

describe('graphml & gexf', () => {
  it('types attributes by their key, adds a missing node for an edge, honours the file default and a per-edge override, and refuses a duplicate id', async () => {
    const { parseGraphml } = await import('../graphml')
    const xml = (body: string, edgedefault = 'undirected') => `<?xml version="1.0"?><graphml xmlns="http://graphml.graphdrawing.org/xmlns"><key id="i" for="node" attr.name="i" attr.type="int"/><key id="d" for="node" attr.name="d" attr.type="double"/><key id="b" for="node" attr.name="b" attr.type="boolean"/><key id="s" for="node" attr.name="s" attr.type="string"/><key id="e_directed" for="edge" attr.name="directed" attr.type="boolean"/><graph id="G" edgedefault="${edgedefault}">${body}</graph></graphml>`
    const p = await parseGraphml(xml('<node id="a"><data key="i">3</data><data key="d">1.5</data><data key="b">true</data><data key="s">3</data></node><edge id="e1" source="a" target="a"/><edge id="e2" source="a" target="ghost"><data key="e_directed">true</data></edge><edge id="e3" source="a" target="a"><data key="e_directed">0</data></edge>'))
    expect(p.nodes.find((n) => n.id === 'a')?.attrs).toEqual({ i: 3, d: 1.5, b: true, s: '3' })
    expect(p.nodes.map((n) => n.id).sort()).toEqual(['a', 'ghost'])
    expect(p.nodes.find((n) => n.id === 'ghost')).toEqual({ id: 'ghost', label: undefined, attrs: {}, viz: undefined })
    expect(p.edges.map((e) => [e.id, e.directed])).toEqual([['e1', false], ['e2', true], ['e3', false]])
    expect(p.edges.every((e) => !('directed' in e.attrs))).toBe(true)
    await expect(parseGraphml(xml('<node id="a"/><node id="a"/>'))).rejects.toThrow()
    expect(await parseGraphml(xml(''))).toMatchObject({ nodes: [], edges: [] })
  })

  it('writes GraphML with sanitised key ids, tags joined, nested data as JSON, and reads it back typed; GEXF carries tags as a list and an undirected default', async () => {
    const { parseGraphml, graphmlString } = await import('../graphml')
    const { parseGexf, writeGexf } = await import('../gexf')
    const a = createEntity({ id: 'a', type: 'person', label: 'A', tags: ['x', 'y'], data: { 'odd key!': 1, nested: { k: 1 }, flag: false, mixed: 1 } })
    const b = createEntity({ id: 'b', type: 'person', data: { mixed: 1.5 } })
    const e = createRelationship({ id: 'e', type: 'knows', source: 'a', target: 'a', directed: false })
    const xml = graphmlString({ nodes: [a, b], edges: [e] })
    expect(xml).toContain('<key id="n_odd_key_" for="node" attr.name="odd key!" attr.type="int"/>')
    expect(xml).toContain('attr.name="mixed" attr.type="double"')
    expect(xml).toContain('attr.name="flag" attr.type="boolean"')
    expect(xml).toContain('<data key="n_tags">x;y</data>')
    expect(xml).toContain('<data key="n_nested">{&quot;k&quot;:1}</data>')
    const back = await parseGraphml(xml)
    expect(back.nodes[0].attrs).toEqual({ type: 'person', tags: 'x;y', 'odd key!': 1, nested: '{"k":1}', flag: false, mixed: 1 })
    expect(back.edges[0]).toMatchObject({ source: 'a', target: 'a', directed: false })
    const m = inferGraphMapping(back, 'g.graphml')
    expect(planGraphImport(new EntityStore(), back, m).entities[0].tags).toEqual(['x', 'y'])
    const [gexf] = await writeGexf({ nodes: [a, b], edges: [e] })
    const g = await parseGexf(gexf.text)
    expect(g.nodes[0].attrs.tags).toEqual(['x', 'y'])
    expect(g.edges[0].directed).toBe(false)
    // A Gephi file with no per-edge type takes the graph's default.
    const und = await parseGexf('<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2"><graph defaultedgetype="undirected"><nodes><node id="1"/><node id="2"/></nodes><edges><edge source="1" target="2"/></edges></graph></gexf>')
    expect(und.edges[0].directed).toBe(false)
    expect(und.edges[0].id).toBeDefined() // graphology names it
    expect(und.nodes[0].label).toBeUndefined()
    expect(und.directedDefault).toBe(false) // graphology-gexf builds an undirected graph from the default
  })

  it('the graphology adapter keeps self-loops, skips edges to missing nodes, renames reserved data keys, and drops nulls', () => {
    const a = createEntity({ id: 'a', type: 't', data: { color: 'clash', size: 2, gone: null, list: [1, 'x'], deep: [{ k: 1 }] } })
    const g = toGraphology({ nodes: [a], edges: [createRelationship({ id: 'loop', type: 'r', source: 'a', target: 'a' }), createRelationship({ id: 'off', type: 'r', source: 'a', target: 'b' })] })
    expect(g.getNodeAttributes('a')).toEqual({ label: 'a', type: 't', data_color: 'clash', data_size: 2, list: [1, 'x'], deep: '[{"k":1}]' })
    expect(g.edges()).toEqual(['loop'])
    const p = fromGraphology(g)
    expect(p.nodes[0].viz).toBeUndefined()
    expect(p.edges[0]).toMatchObject({ source: 'a', target: 'a', directed: true })
  })
})

describe('mapping', () => {
  const two = () => parsed({ nodes: [{ id: 'a', attrs: { Kind: 'Person!', tags: 'x|y', name: 'Ada' } }, { id: 'b', attrs: {} }], edges: [{ source: 'a', target: 'b', attrs: {} }, { source: 'a', target: 'b', attrs: {}, label: 'Knows' }, { source: 'a', target: 'zz', attrs: {} }], attributeKeys: { nodes: ['Kind', 'tags', 'name'], edges: [] } })

  it('infers the spec from the keys: a type column, tags, a label column only when nodes have no labels, edge types from labels, iri means verbatim ids', () => {
    const m = inferGraphMapping(two(), 'people.graphml')
    expect(m).toMatchObject({ idMode: 'keyed', typeBy: 'attr', typeAttr: 'Kind', tagsAttr: 'tags', labelAttr: 'name', edgeTypeBy: 'label', importLayout: false, importColors: false, importKey: importKeyFor('people') })
    expect(inferGraphMapping(parsed({ nodes: [{ id: 'a', label: 'A', attrs: { name: 'n' } }], attributeKeys: { nodes: ['name'], edges: [] } })).labelAttr).toBeUndefined()
    expect(inferGraphMapping(parsed({ attributeKeys: { nodes: ['iri'], edges: [] } })).idMode).toBe('verbatim')
    expect(inferGraphMapping(parsed()).edgeTypeBy).toBe('fixed')
    expect(importKeyFor('x')).toMatch(/^[0-9a-f]{8}$/)
    expect(importKeyFor('x')).not.toBe(importKeyFor('y'))
    expect(slugType(' Foo-Bar_Baz 9 ')).toBe('foo bar baz 9')
    expect(slugType('!!!')).toBe('node')
  })

  it('plans keyed ids with the label, type and tags drawn from the attributes and taken out of the data, skips the edge to nowhere, numbers parallel edges, keeps a label only when it is not the type', () => {
    const s = new EntityStore()
    const m = inferGraphMapping(two(), 'people')
    const plan = planGraphImport(s, two(), { ...m, tags: ['imported'] })
    expect(plan).toMatchObject({ created: 2, updated: 0, reused: 0, skippedEdges: 1 })
    expect(plan.entities[0]).toMatchObject({ id: `gi-${m.importKey}-n-a`, type: 'person', label: 'Ada', tags: ['x', 'y', 'imported'], data: { importedId: 'a' } })
    expect(plan.entities[1]).toMatchObject({ type: 'node', label: 'b', tags: ['imported'] })
    expect(plan.relationships.map((r) => r.id)).toEqual([`gi-${m.importKey}-r-a_related_b`, `gi-${m.importKey}-r-a_knows_b`])
    expect(plan.relationships.map((r) => r.type)).toEqual(['related', 'knows'])
    expect(plan.relationships[1].label).toBeUndefined() // "Knows" slugs to the type
    expect(plan.relationships.map((r) => r.tags)).toEqual([['imported'], ['imported']])
    expect(plan.layout).toBeUndefined()
    const again = planGraphImport(s, parsed({ nodes: [{ id: 'a', attrs: {} }], edges: [{ source: 'a', target: 'a', attrs: {} }, { source: 'a', target: 'a', attrs: {} }] }), spec())
    expect(again.relationships.map((r) => r.id)).toEqual(['gi-k1-r-a_related_a', 'gi-k1-r-a_related_a-1'])
  })

  it('reuses a plain entity by node id, but not a relationship, a type definition or a project; verbatim ids and no-reuse take the node id or a keyed one', () => {
    const s = new EntityStore()
    s.upsertMany([createEntity({ id: 'a', type: 'person', label: 'Ada', tags: ['old'], data: { keep: 1 } }), createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [] } }), createRelationship({ id: 'r', type: 'x', source: 'a', target: 'a' })])
    const p = parsed({ nodes: [{ id: 'a', attrs: { n: 2 } }, { id: 'p', attrs: {} }, { id: 'r', attrs: {} }] })
    const plan = planGraphImport(s, p, spec({ typeBy: 'fixed', fixedType: 'thing' }))
    expect(plan).toMatchObject({ created: 2, reused: 1 })
    expect(plan.entities[0]).toMatchObject({ id: 'a', type: 'person', label: 'a', tags: ['old'], data: { keep: 1, n: 2, importedId: 'a' } }) // reused: its type stays, the label is the file's
    expect(plan.entities[1].id).toBe('gi-k1-n-p')
    expect(plan.entities[2].id).toBe('gi-k1-n-r')
    expect(planGraphImport(s, p, spec({ reuseExistingIds: false })).entities[0].id).toBe('gi-k1-n-a')
    // Verbatim ids over what is already there: a plain entity is reused when asked (its type kept), a project and a
    // relationship are not the file's to touch — each node takes an id of its own.
    const v = planGraphImport(s, p, spec({ idMode: 'verbatim' }))
    expect(v.entities.map((e) => e.id)).toEqual(['a', distinctNodeId('k1', 'p'), distinctNodeId('k1', 'r')])
    expect(v.entities[0]).toMatchObject({ type: 'person' })
    expect(v.entities[0].data).not.toHaveProperty('importedId')
    expect(v.warnings.join(' ')).toMatch(/2 node ids name something in the Library/)
    expect(planGraphImport(s, p, spec({ idMode: 'verbatim', reuseExistingIds: false })).entities[0].id).toBe(distinctNodeId('k1', 'a'))
  })

  it('updates its own earlier entities in place, lets a stub add without overwriting, forces direction, and removes only what it made', () => {
    const s = new EntityStore()
    const first = planGraphImport(s, parsed({ nodes: [{ id: 'a', label: 'A1', attrs: { k: 1 } }], edges: [{ id: 'e', source: 'a', target: 'a', attrs: {}, directed: false }] }), spec())
    applyGraphPlan(s, first)
    const second = planGraphImport(s, parsed({ nodes: [{ id: 'a', label: 'A2', attrs: { k: 2, stub: true } }], edges: [{ id: 'e', source: 'a', target: 'a', attrs: {}, directed: false }] }), spec({ fixedType: 'other', directed: 'directed', tags: ['t'] }))
    expect(second).toMatchObject({ created: 0, updated: 1 })
    expect(second.entities[0]).toMatchObject({ id: 'gi-k1-n-a', label: 'A1', type: 'node', tags: ['t'], data: { k: 1, stub: true } }) // the stub keeps the label, type and data already known
    expect(second.relationships[0]).toMatchObject({ id: 'gi-k1-r-e', directed: true })
    const third = planGraphImport(s, parsed({ nodes: [{ id: 'a', label: 'A3', attrs: { k: 3 } }] }), spec({ fixedType: 'other', directed: 'undirected' }))
    expect(third.entities[0]).toMatchObject({ label: 'A3', type: 'other', data: { k: 3 } })
    s.upsert(createEntity({ id: 'mine', type: 'note' }))
    expect(removeGraphImport(s, 'k1')).toBe(2)
    expect(s.has('mine')).toBe(true)
    expect(removeGraphImport(s, 'k1')).toBe(0)
  })

  it('captures a layout only when every position is complete, in 3D if any node has a z, keeping an earlier layout label', () => {
    const s = new EntityStore()
    const p = parsed({ nodes: [{ id: 'a', attrs: {}, viz: { x: 1, y: 2 } }, { id: 'b', attrs: {}, viz: { x: 3 } }, { id: 'c', attrs: {}, viz: { x: 0, y: 0, z: 5, size: 4, color: '#123456' } }] })
    const plan = planGraphImport(s, p, spec())
    expect(plan.layout?.data).toMatchObject({ algorithm: 'imported', dimensions: 3, positions: { 'gi-k1-n-a': { x: 1, y: 2 }, 'gi-k1-n-c': { x: 0, y: 0, z: 5 } } })
    expect(plan.layout?.data.positions).not.toHaveProperty('gi-k1-n-b')
    expect(plan.entities[2].data).toMatchObject({ size: 4, color: '#123456' })
    expect(planGraphImport(s, p, spec({ importColors: false })).entities[2].data).not.toHaveProperty('color')
    expect(planGraphImport(s, p, spec({ importLayout: false })).layout).toBeUndefined()
    applyGraphPlan(s, plan)
    s.update(plan.layout!.id, { label: 'My layout' })
    expect(planGraphImport(s, p, spec()).layout?.label).toBe('My layout')
  })
})

describe('helpers', () => {
  it('ranks attribute keys by count then name, infers the narrowest type, escapes XML, and reads colours in every form', () => {
    expect(attributeKeys([{ attrs: { b: 1, a: 1 } }, { attrs: { b: 2 } }, { attrs: {} }])).toEqual(['b', 'a'])
    expect(inferAttrType([1, 2])).toBe('int')
    expect(inferAttrType([1, 2.5])).toBe('double')
    expect(inferAttrType([2.5, 1])).toBe('double')
    expect(inferAttrType([true, null, undefined])).toBe('boolean')
    expect(inferAttrType([1, true])).toBe('string')
    expect(inferAttrType([])).toBe('string')
    expect(inferAttrType([null])).toBe('string')
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;')
    expect(xmlEscape(undefined)).toBe('')
    expect(xmlEscape(0)).toBe('0')
    expect(colorToHex('rgb(255, 0, 16)')).toBe('#ff0010')
    expect(colorToHex('rgba(1,2,3,0.5)')).toBe('#010203')
    expect(colorToHex('#abc')).toBe('#abc')
    expect(colorToHex('tomato')).toBe('tomato')
    expect(colorToHex({ r: 300, g: -1, b: 1.5 })).toBe('#ff0002')
    expect(colorToHex(7)).toBeUndefined()
    expect(colorToHex({ g: 1 })).toBeUndefined()
  })
})

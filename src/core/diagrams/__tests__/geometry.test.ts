import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { projectionFromPlan } from '../../graph/projection'
import { createDiagramEntityForTest } from './helpers'
import { detectDiagramFormat, parseDiagram, writeDiagram } from '../index'
import { parseExcalidraw, writeExcalidraw } from '../excalidraw'
import { geometryFromGraphvizJson, pathToGeom, splineFromPos } from '../extract'
import { edgePath, geometryBounds, geometryToSvg, straightRoute } from '../geometry'
import { inferMapping, planImport } from '../mapping'

const excalidrawFixture = {
  type: 'excalidraw',
  version: 2,
  elements: [
    { id: 'r1', type: 'rectangle', x: 100, y: 100, width: 160, height: 60, strokeColor: '#1e1e1e', backgroundColor: '#ffec99', boundElements: [{ id: 't1', type: 'text' }], roundness: { type: 3 } },
    { id: 't1', type: 'text', x: 110, y: 120, width: 140, height: 20, text: 'Alpha', originalText: 'Alpha', containerId: 'r1', strokeColor: '#333', fontSize: 16 },
    { id: 'e1', type: 'ellipse', x: 400, y: 90, width: 120, height: 80, strokeColor: '#e03131', backgroundColor: 'transparent', boundElements: [{ id: 't2', type: 'text' }] },
    { id: 't2', type: 'text', x: 420, y: 120, width: 80, height: 20, text: 'Beta', containerId: 'e1' },
    { id: 'a1', type: 'arrow', x: 260, y: 130, width: 140, height: 0, points: [[0, 0], [140, 0]], startBinding: { elementId: 'r1' }, endBinding: { elementId: 'e1' }, endArrowhead: 'arrow', startArrowhead: null, boundElements: [{ id: 't3', type: 'text' }] },
    { id: 't3', type: 'text', x: 300, y: 110, width: 60, height: 20, text: 'flows', containerId: 'a1' },
    { id: 'loose', type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]], startBinding: null, endBinding: null },
    { id: 'free', type: 'text', x: 10, y: 300, width: 100, height: 20, text: 'A note', containerId: null },
    { id: 'f1', type: 'frame', x: 80, y: 70, width: 480, height: 130, name: 'Pipeline' },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
}

describe('Excalidraw', () => {
  it('is detected and parsed with geometry', () => {
    const src = JSON.stringify(excalidrawFixture)
    expect(detectDiagramFormat(src)).toBe('excalidraw')
    const d = parseDiagram(src, 'excalidraw')
    expect(d.kind).toBe('excalidraw')
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['r1', 'Alpha', 'box'],
      ['e1', 'Beta', 'ellipse'],
      ['free', 'A note', 'text'],
    ])
    expect(d.edges).toHaveLength(1)
    expect(d.edges[0]).toMatchObject({ source: 'r1', target: 'e1', label: 'flows', directed: true })
    expect(d.groups[0]).toMatchObject({ id: 'f1', label: 'Pipeline' })
    expect(d.warnings[0]).toMatch(/1 arrow.*not part of the graph/)
    const g = d.geometry!
    expect(g.nodes.r1).toMatchObject({ x: 180, y: 130, width: 160, height: 60, fill: '#ffec99', shape: 'rounded', color: '#333', fontSize: 16 })
    expect(g.nodes.e1).toMatchObject({ x: 460, y: 130, shape: 'ellipse', stroke: '#e03131', fill: '#fff' })
    expect(g.edges.a1.points).toEqual([
      { x: 260, y: 130 },
      { x: 400, y: 130 },
    ])
    expect(g.edges.a1.arrowEnd).toBe(true)
    expect(g.groups.f1).toMatchObject({ x: 80, y: 70, width: 480, height: 130 })
  })

  it('round-trips through the writer', () => {
    const d = parseExcalidraw(JSON.stringify(excalidrawFixture))
    const back = parseExcalidraw(writeExcalidraw(d))
    expect(back.nodes.map((n) => n.label)).toEqual(['Alpha', 'Beta', 'A note'])
    expect(back.edges[0]).toMatchObject({ source: 'r1', target: 'e1', label: 'flows' })
    expect(back.geometry!.nodes.r1).toMatchObject({ x: 180, y: 130, width: 160, height: 60 })
    expect(back.groups[0].label).toBe('Pipeline')
  })

  it('converts from DOT, layering nodes along the flow when there is no geometry', () => {
    const d = parseDiagram('digraph { a -> b }', 'dot')
    const out = writeDiagram(d, 'excalidraw')
    const back = parseExcalidraw(out)
    expect(back.nodes).toHaveLength(2)
    expect(back.edges).toHaveLength(1)
    // Top-down by default: same column, b below a.
    expect(back.geometry!.nodes.a.x).toBe(back.geometry!.nodes.b.x)
    expect(back.geometry!.nodes.b.y).toBeGreaterThan(back.geometry!.nodes.a.y)
    const lr = parseExcalidraw(writeDiagram(parseDiagram('digraph { rankdir=LR; a -> b }', 'dot'), 'excalidraw'))
    expect(lr.geometry!.nodes.b.x).toBeGreaterThan(lr.geometry!.nodes.a.x)
  })
})

describe('Graphviz geometry', () => {
  const json = {
    bb: '0,0,170.89,93',
    objects: [
      { name: 'cluster_a', bb: '8,8,78,85', nodes: [1], _gvid: 0, label: 'A', lp: '43,74' },
      { name: 'x', pos: '43,34', width: '0.75', height: '0.5', shape: 'box', fillcolor: '#ffcc00', style: 'filled', _gvid: 1 },
      { name: 'y', pos: '143.89,34', width: '0.75', height: '0.5', shape: 'ellipse', _gvid: 2 },
    ],
    edges: [{ tail: 1, head: 2, pos: 'e,116.53,34 70.241,34 80.97,34 93.583,34 105.26,34', lp: '93.445,42.4', label: 'to' }],
  }
  const parsed = parseDiagram('digraph { subgraph cluster_a { label="A"; x [shape=box, fillcolor="#ffcc00", style=filled]; } x -> y [label="to"]; y [shape=ellipse] }', 'dot')

  it('flips y, scales inches to points, and keeps colours and shapes', () => {
    const g = geometryFromGraphvizJson(json, parsed)
    expect(g.width).toBe(179)
    expect(g.nodes.x).toMatchObject({ x: 47, y: 93 - 34 + 4, width: 54, height: 36, shape: 'box', fill: '#ffcc00' })
    expect(g.nodes.y.shape).toBe('ellipse')
    expect(g.nodes.y.fill).toBe('#fff')
    expect(g.groups.cluster_a).toMatchObject({ x: 12, y: 93 - 85 + 4, width: 70, height: 77 })
    const e = g.edges[parsed.edges[0].id]
    expect(e.curve).toBe('bezier')
    expect(e.arrowEnd).toBe(true)
    expect(e.points[0]).toEqual({ x: 74.241, y: 63 })
    expect(e.points.at(-1)).toEqual({ x: 120.53, y: 63 })
    expect(e.label).toEqual({ x: 97.445, y: 93 - 42.4 + 4 })
    expect(edgePath(e)).toMatch(/^M74.241 63 C/)
  })

  it('parses splines and svg paths', () => {
    const s = splineFromPos('e,10,0 0,0 3,0 6,0 9,0')
    expect(s.points).toHaveLength(7)
    expect(s.curve).toBe('bezier')
    const p = pathToGeom('M0,0L10,0L20,5')
    expect(p.curve).toBe('poly')
    const c = pathToGeom('M0 0 C 1 1 2 2 3 3')
    expect(c.curve).toBe('bezier')
    expect(c.points).toHaveLength(4)
  })
})

describe('projection from an import plan', () => {
  it('rekeys geometry by the entity and relationship ids the plan assigned', () => {
    const store = new EntityStore()
    const src = JSON.stringify(excalidrawFixture)
    const diagram = createDiagramEntityForTest(store, 'Sketch', src, 'excalidraw')
    const parsed = parseDiagram(src, 'excalidraw')
    const plan = planImport(store, diagram, parsed, inferMapping(parsed, 'Sketch'))
    const proj = projectionFromPlan(diagram, parsed, parsed.geometry!, plan)
    expect(Object.keys(proj.data.nodes)).toHaveLength(3)
    const alpha = plan.nodeIds.r1
    expect(proj.data.nodes[alpha]).toMatchObject({ x: 180, y: 130 })
    const rel = plan.edgeIds.a1
    expect(proj.data.edges[rel].points).toHaveLength(2)
    expect(proj.data.groups.f1.members).toEqual([alpha, plan.nodeIds.e1])
    expect((proj.data.source as { diagramId?: string })?.diagramId).toBe(diagram.id)
    expect(proj.id).toBe(`dg-${diagram.id.slice(0, 8)}-projection`)
  })

  it('draws a static svg and computes bounds and straight routes', () => {
    const d = parseExcalidraw(JSON.stringify(excalidrawFixture))
    const svg = geometryToSvg(d.geometry!, { nodes: { r1: 'Alpha' } })
    expect(svg).toContain('<rect')
    expect(svg).toContain('Alpha')
    const b = geometryBounds(d.geometry!)
    expect(b.x).toBeLessThan(100)
    const r = straightRoute(d.geometry!.nodes.r1, d.geometry!.nodes.e1)
    expect(r[0].x).toBe(260)
    expect(r[1].x).toBe(400)
  })
})

describe('projection → diagram', () => {
  it('writes a hand-arranged scene back out as Excalidraw with its geometry', async () => {
    const { diagramFromProjection } = await import('../../graph/projection')
    const { createEntity, createRelationship } = await import('../../entity/entity')
    const a = createEntity({ id: 'a', type: 'person', label: 'Ada' })
    const b = createEntity({ id: 'b', type: 'work', label: 'Notes' })
    const r = createRelationship({ id: 'r', type: 'wrote', source: 'a', target: 'b' })
    const d = diagramFromProjection(
      { kind: '2d', width: 600, height: 300, nodes: { a: { x: 100, y: 100, width: 120, height: 50, shape: 'rounded', fill: '#fee' }, b: { x: 400, y: 100, width: 120, height: 50, shape: 'ellipse' } }, edges: {}, groups: { g: { x: 20, y: 40, width: 260, height: 120, title: 'People', members: ['a'] } } },
      new Map([
        ['a', a],
        ['b', b],
      ]),
      [{ id: r.id, source: 'a', target: 'b', type: 'wrote', directed: true }],
    )
    expect(d.nodes.map((n) => [n.id, n.label, n.group])).toEqual([
      ['a', 'Ada', 'g'],
      ['b', 'Notes', undefined],
    ])
    const back = parseExcalidraw(writeExcalidraw(d))
    expect(back.nodes.map((n) => n.label)).toEqual(['Ada', 'Notes'])
    expect(back.geometry!.nodes.a).toMatchObject({ x: 100, y: 100, width: 120, height: 50, fill: '#fee' })
    expect(back.edges[0]).toMatchObject({ source: 'a', target: 'b', directed: true })
    expect(back.groups[0].label).toBe('People')
  })
})

import { describe, expect, it } from 'vitest'
import { parseDot } from '../dot'
import { geometryFromGraphvizJson, pathToGeom, splineFromPos } from '../extract'
import { borderPoint, edgePath, emptyGeometry, geometryBounds, geometryToSvg, shapeOutline, shiftGeometry, straightRoute, type EdgeGeom, type NodeGeom } from '../geometry'
import { autoLayout } from '../layout'
import { emptyDiagram } from '../model'

/**
 * The renderer-free layout, the geometry helpers and the Graphviz
 * extraction at their edges: an empty diagram, one node, a cycle, a
 * self-loop, disconnected parts, groups with one member or none, edges
 * back into an earlier group or with constraint=false, LR against TD
 * and the other spellings; paths with no, one, or a wrong count of
 * points, border points on every shape, a zero-size node and identical
 * centres, bounds of nothing and of negative coordinates, shifting,
 * outlines, the SVG's escaping and every shape; Graphviz JSON without
 * bb, objects or edges, unknown clusters and nodes, every shape word,
 * fills, parallel edges, arrow tips at either end, and odd path data.
 */
const box = (x: number, y: number, over: Partial<NodeGeom> = {}): NodeGeom => ({ x, y, width: 100, height: 50, ...over })

describe('autoLayout', () => {
  it('lays out nothing, one node, a cycle without looping forever, and disconnected parts side by side', () => {
    const empty = autoLayout(emptyDiagram('dot'))
    expect(empty).toEqual({ width: 80, height: 80, nodes: {}, edges: {}, groups: {} })
    const one = autoLayout(parseDot('digraph { a [label="A"] }'))
    expect(one.nodes.a).toMatchObject({ x: 40 + 96 / 2, y: 40 + 44 / 2, width: 96, height: 44 })
    expect([one.width, one.height]).toEqual([96 + 80 + 28 * 1.5, 44 + 80])
    const cyc = autoLayout(parseDot('digraph { a -> b -> c -> a; a -> a; d; e -> f }'))
    const y = (id: string) => cyc.nodes[id].y
    expect([y('a'), y('b'), y('c')]).toEqual([62, 62 + 44 + 90, 62 + 2 * (44 + 90)]) // a→b→c layered; the back edge c→a ignored
    expect(y('d')).toBe(y('a')) // a source in the same rank sits beside a
    expect([y('e'), y('f')]).toEqual([y('a'), y('b')])
    expect(cyc.nodes.a.x).toBeLessThan(cyc.nodes.d.x)
    expect(Object.keys(cyc.edges)).toHaveLength(5)
    const loop = Object.values(cyc.edges).find((e) => e.points[0].x === e.points[1].x && e.points[0].y === e.points[1].y)
    expect(loop).toBeDefined() // a self-loop gets a zero-length route rather than nothing
  })

  it('gives every group its own band, sized to one member, none for an empty group, and never lets an edge back into an earlier group drag ranks', () => {
    const d = parseDot('digraph { subgraph cluster_a { label="A"; a } subgraph cluster_b { label="B"; b; c } subgraph cluster_empty { label="E" } a -> b; b -> a; b -> c [constraint=false]; c -> a [constraint=false] }')
    const g = autoLayout(d)
    expect(Object.keys(g.groups)).toEqual(['cluster_a', 'cluster_b'])
    const A = g.groups.cluster_a
    const B = g.groups.cluster_b
    // Top-down: the band runs across in x (pad, title, node, pad), the flow in y (a rank's extent plus the pad each side).
    expect(A).toMatchObject({ x: 40, y: 40 - 24, width: 24 + 28 + 96 + 24, height: 44 + 48, stroke: '#9ca3af', label: { x: 50, y: 40 - 24 + 18 } })
    expect(B.x).toBeGreaterThanOrEqual(A.x + A.width) // bands across the flow, apart
    expect(g.nodes.a.x).toBeGreaterThan(A.x)
    expect(g.nodes.a.x).toBeLessThan(A.x + A.width)
    // b is ranked below a (a→b); c stays a source: constraint=false edges do not rank, and b→a leads into an earlier group.
    expect(g.nodes.b.y).toBeGreaterThan(g.nodes.a.y)
    expect(g.nodes.c.y).toBe(g.nodes.a.y)
    expect(g.nodes.b.y).toBe(g.nodes.a.y + 44 + 90)
    expect(Object.keys(g.edges)).toHaveLength(4)
  })

  it('reads the direction from rankdir, direction or the option, treats TD as TB and RL/BT as their axis, and routes edges with labels, dashes and arrows', () => {
    const src = 'digraph { a -> b [label="go", style=dashed]; b -> c [dir=none] }'
    const tb = autoLayout(parseDot(src))
    expect(tb.nodes.b.x).toBe(tb.nodes.a.x)
    expect(tb.nodes.b.y).toBeGreaterThan(tb.nodes.a.y)
    const lr = autoLayout(parseDot(src), { rankdir: 'lr' })
    expect(lr.nodes.b.y).toBe(lr.nodes.a.y)
    expect(lr.nodes.b.x).toBeGreaterThan(lr.nodes.a.x)
    const d = parseDot(src)
    d.attrs.direction = 'LR'
    expect(autoLayout(d).nodes.b.x).toBeGreaterThan(autoLayout(d).nodes.a.x)
    expect(autoLayout(parseDot(src), { rankdir: 'TD' }).nodes.b.x).toBe(tb.nodes.b.x)
    expect(autoLayout(parseDot(src), { rankdir: 'RL' }).nodes.b.x).toBeGreaterThan(lr.nodes.a.x) // RL is not reversed: the flow still runs left to right
    expect(autoLayout(parseDot(src), { rankdir: 'BT' }).nodes.b.y).toBeGreaterThan(tb.nodes.a.y)
    const e = Object.values(tb.edges)
    expect(e[0]).toMatchObject({ curve: 'line', dashed: true, arrowEnd: true, label: { x: tb.nodes.a.x, y: (tb.nodes.a.y + tb.nodes.b.y) / 2 } })
    expect(e[0].points).toEqual([{ x: tb.nodes.a.x, y: tb.nodes.a.y + 22 }, { x: tb.nodes.b.x, y: tb.nodes.b.y - 22 }])
    expect(e[1]).toMatchObject({ dashed: false, arrowEnd: true, label: undefined }) // dir=none is not read: DOT's arrow is the graph's
    const sized = autoLayout(parseDot('digraph { a [label="two\\nlines and a long label"]; b }'), { nodeWidth: () => 200, nodeHeight: (l) => l.split('\n').length * 30, rankGap: 10, nodeGap: 5 })
    expect(sized.nodes.a).toMatchObject({ width: 200, height: 60 })
    expect(sized.nodes.b.x).toBe(sized.nodes.a.x + 200 + 5)
  })
})

describe('geometry helpers', () => {
  it('writes a path for no points, one point, a bezier with a wrong count, and a polyline', () => {
    expect(edgePath({ points: [], curve: 'line' })).toBe('')
    expect(edgePath({ points: [{ x: 1, y: 2 }], curve: 'bezier' })).toBe('M1 2')
    expect(edgePath({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], curve: 'bezier' })).toBe('M0 0 L1 1 L2 2') // two points after M is not a cubic
    expect(edgePath({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], curve: 'bezier' })).toBe('M0 0 C1 1 2 2 3 3')
    expect(edgePath({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], curve: 'poly' })).toBe('M0 0 L5 0')
  })

  it('finds border points on boxes, ellipses and diamonds, from identical centres, straight up, and on a zero-size node', () => {
    const a = box(0, 0)
    expect(borderPoint(a, box(200, 0))).toEqual({ x: 50, y: 0 })
    expect(borderPoint(a, box(0, 200))).toEqual({ x: 0, y: 25 })
    expect(borderPoint(a, box(100, 100))).toEqual({ x: 25, y: 25 }) // leaves through the top/bottom edge first
    expect(borderPoint(a, box(0, 0))).toEqual({ x: 0, y: 0 })
    expect(borderPoint(box(0, 0, { width: 0, height: 0 }), box(10, 10))).toEqual({ x: 0, y: 0 })
    const el = borderPoint(box(0, 0, { shape: 'ellipse' }), box(0, 100))
    expect(el.x).toBeCloseTo(0)
    expect(el.y).toBeCloseTo(25)
    expect(borderPoint(box(0, 0, { shape: 'circle', width: 50, height: 50 }), box(100, 0))).toEqual({ x: 25, y: 0 })
    const dm = borderPoint(box(0, 0, { shape: 'diamond' }), box(100, 100))
    expect(dm.x).toBeCloseTo(100 / 6) // on the diamond's edge: x/50 + y/25 = 1
    expect(dm.y).toBeCloseTo(100 / 6)
    expect(straightRoute(a, a)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }])
    expect(straightRoute(box(0, 0), box(300, 0))).toEqual([{ x: 50, y: 0 }, { x: 250, y: 0 }])
  })

  it('bounds nothing to a default, everything else with padding, including edges, groups and negative coordinates; shifts every coordinate', () => {
    expect(geometryBounds(emptyGeometry())).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(geometryBounds({ ...emptyGeometry(), width: 10, height: 20 })).toEqual({ x: 0, y: 0, width: 10, height: 20 })
    const g = { ...emptyGeometry(), nodes: { a: box(-100, -50) }, edges: { e: { points: [{ x: 500, y: 0 }], curve: 'line' as const } }, groups: { g: { x: -200, y: 300, width: 10, height: 10 } } }
    expect(geometryBounds(g, 0)).toEqual({ x: -200, y: -75, width: 700, height: 385 })
    expect(geometryBounds(g)).toEqual({ x: -224, y: -99, width: 748, height: 433 })
    const s = shiftGeometry({ ...g, background: '#fff', edges: { e: { ...g.edges.e, label: { x: 1, y: 1 } }, f: { points: [], curve: 'line' } }, groups: { g: { ...g.groups.g, label: { x: 0, y: 0 } } } }, 10, -10)
    expect(s.nodes.a).toMatchObject({ x: -90, y: -60 })
    expect(s.edges.e).toMatchObject({ points: [{ x: 510, y: -10 }], label: { x: 11, y: -9 } })
    expect(s.edges.f.label).toBeUndefined()
    expect(s.groups.g).toMatchObject({ x: -190, y: 290, label: { x: 10, y: -10 } })
    expect(s.background).toBe('#fff')
  })

  it('outlines the polygon shapes only, and draws every shape, escapes labels, marks arrows and dashes, rotates, and stacks lines in the SVG', () => {
    expect(shapeOutline(box(0, 0, { shape: 'diamond' }))).toBe('0,-25 50,0 0,25 -50,0')
    expect(shapeOutline(box(0, 0, { shape: 'triangle' }))).toBe('0,-25 50,25 -50,25')
    expect(shapeOutline(box(0, 0, { shape: 'hexagon' }))!.split(' ')).toHaveLength(6)
    expect(shapeOutline(box(0, 0, { shape: 'parallelogram' }))!.split(' ')).toHaveLength(4)
    expect(shapeOutline(box(0, 0, { shape: 'box' }))).toBeNull()
    expect(shapeOutline(box(0, 0))).toBeNull()
    const g = {
      ...emptyGeometry(),
      background: '#fafafa',
      nodes: { r: box(100, 100, { shape: 'rounded', rotation: Math.PI / 2, fontSize: 20, color: '#00f' }), e: box(300, 100, { shape: 'ellipse', dashed: true, strokeWidth: 3 }), d: box(500, 100, { shape: 'diamond' }), t: box(700, 100, { shape: 'text' }), p: box(900, 100, { shape: 'plain' }) },
      edges: { l: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], curve: 'line' as const, arrowEnd: true, arrowStart: true, dashed: true, label: { x: 5, y: 5 } } as EdgeGeom, n: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], curve: 'line' as const } as EdgeGeom },
      groups: { g: { x: 0, y: 0, width: 50, height: 50, fill: '#eee' } },
    }
    const svg = geometryToSvg(g, { nodes: { r: 'a <b> & "c"\nline 2', t: 'just text', p: 'plain' }, edges: { l: 'lbl <', n: 'never: no label point' }, groups: { g: 'G & co' } })
    expect(svg).toContain('<rect x="-24" y="-24" width="998" height="173" fill="#fafafa"/>') // y from the group's top to the nodes' bottom
    expect(svg).toContain('<rect x="0" y="0" width="50" height="50" rx="4" fill="#eee" stroke="#999"/>')
    expect(svg).toContain('font-size="12" fill="#555">G &amp; co</text>')
    expect(svg).toContain('<path d="M0 0 L10 10" fill="none" stroke="#333" stroke-width="1.5" stroke-dasharray="6 4" marker-end="url(#arrow)" marker-start="url(#arrow)"/>')
    expect(svg).toContain('>lbl &lt;</text>')
    expect(svg).not.toContain('never: no label point')
    expect(svg).toContain('<rect x="50" y="75" width="100" height="50" rx="8" fill="#fff" stroke="#333" stroke-width="1.5" transform="rotate(90 100 100)"/>')
    expect(svg).toContain('<ellipse cx="300" cy="100" rx="50" ry="25" fill="#fff" stroke="#333" stroke-width="3" stroke-dasharray="6 4"/>')
    expect(svg).toContain('<polygon points="500,75 550,100 500,125 450,100"')
    expect(svg).toContain('<rect x="850" y="75" width="100" height="50" rx="2"') // an unknown shape word is a box
    expect(svg).not.toMatch(/x="650"/) // a text node draws no box
    expect(svg).toContain('<text x="100" y="88" font-size="20" text-anchor="middle" dominant-baseline="central" fill="#00f" transform="rotate(90 100 100)"><tspan x="100" dy="0">a &lt;b&gt; &amp; &quot;c&quot;</tspan><tspan x="100" dy="24">line 2</tspan></text>')
    expect(svg).toContain('>just text</tspan>')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-24 -24 998 173"')).toBe(true)
  })
})

describe('Graphviz extraction', () => {
  const parsed = (src: string) => parseDot(src)
  it('copes with no bb, no objects and no edges, skips clusters it does not know by name but keeps them under theirs, skips nodes without a position or not in the diagram, and defaults sizes', () => {
    const g = geometryFromGraphvizJson({}, parsed('digraph { a }'))
    expect(g).toEqual({ width: 8, height: 8, nodes: {}, edges: {}, groups: {} })
    const g2 = geometryFromGraphvizJson(
      { bb: '0,0,100,50', objects: [{ name: 'cluster_x', bb: '0,0,10,10', _gvid: 0, bgcolor: 'none', pencolor: 'red' }, { name: 'a', pos: '10,10', _gvid: 1 }, { name: 'ghost', pos: '20,20', _gvid: 2, width: '1' }, { name: 'nopos', _gvid: 3 }] },
      parsed('digraph { a }'),
    )
    expect(g2.groups.cluster_x).toEqual({ x: 4, y: 44, width: 10, height: 10, fill: undefined, stroke: 'red', label: undefined })
    expect(g2.nodes.a).toEqual({ x: 14, y: 44, width: 54, height: 36, shape: 'ellipse', fill: '#fff', stroke: '#1f1e1b', strokeWidth: undefined, dashed: false, color: undefined, fontSize: 14 })
    expect(Object.keys(g2.nodes)).toEqual(['a'])
  })

  it('normalises every shape word, reads fills only when filled, pens and fonts, and matches parallel edges in order with arrow tips at either end', () => {
    const words: [string, string][] = [['ellipse', 'ellipse'], ['oval', 'ellipse'], ['circle', 'circle'], ['doublecircle', 'circle'], ['point', 'circle'], ['Mdiamond', 'diamond'], ['octagon', 'hexagon'], ['triangle', 'triangle'], ['parallelogram', 'parallelogram'], ['note', 'note'], ['cylinder', 'cylinder'], ['plaintext', 'text'], ['none', 'text'], ['record', 'box'], ['box', 'box']]
    const p = parsed(`digraph { ${words.map(([w]) => `n_${w}`).join('; ')}; a -> b; a -> b; a -> b; b -> a }`)
    const objects = words.map(([w, _], i) => ({ name: `n_${w}`, pos: '0,0', shape: w, _gvid: i }))
    const base = objects.length
    const json = {
      bb: '0,0,10,10',
      objects: [...objects, { name: 'a', pos: '0,0', _gvid: base, style: 'filled,dashed', color: 'blue', penwidth: '2', fontsize: '9', fontcolor: 'green' }, { name: 'b', pos: '5,5', _gvid: base + 1, style: 'filled', fillcolor: 'transparent' }],
      edges: [
        { tail: base, head: base + 1, pos: 'e,5,5 0,0 1,1 2,2 3,3', color: 'red', penwidth: '3', style: 'dotted', lp: '2,2' },
        { tail: base, head: base + 1, pos: 's,0,0 1,1 2,2 3,3 4,4' },
        { tail: base, head: base + 1, pos: '0,0 1,1' },
        { tail: base + 1, head: base, pos: 'e,0,0 s,5,5 5,5 4,4 3,3 2,2' },
        { tail: base, head: 99, pos: '0,0 1,1 2,2 3,3' },
      ],
    }
    const g = geometryFromGraphvizJson(json, p)
    for (const [w, want] of words) expect(g.nodes[`n_${w}`].shape, w).toBe(want)
    expect(g.nodes.a).toMatchObject({ fill: 'blue', stroke: 'blue', strokeWidth: 2, dashed: true, fontSize: 9, color: 'green' }) // filled with no fillcolor: the pen colour
    expect(g.nodes.b.fill).toBe('#d3d3d3') // filled with a transparent fillcolor: Graphviz's grey
    const [e1, e2, e3, e4] = p.edges.map((e) => g.edges[e.id])
    expect(e1).toMatchObject({ curve: 'bezier', arrowEnd: true, arrowStart: false, stroke: 'red', strokeWidth: 3, dashed: true, label: { x: 6, y: 12 } })
    expect(e1.points).toHaveLength(7)
    expect(e1.points.at(-1)).toEqual({ x: 9, y: 9 })
    expect(e2).toMatchObject({ arrowStart: true, arrowEnd: false })
    expect(e2.points).toHaveLength(7)
    expect(e3).toMatchObject({ curve: 'poly' }) // two points: not a cubic
    expect(e4).toMatchObject({ arrowStart: true, arrowEnd: true })
    expect(e4.points).toHaveLength(10)
    expect(Object.keys(g.edges)).toHaveLength(4)
  })

  it('reads splines and path data on odd input: empty, tips alone, lowercase and relative commands ignored, quadratics elevated, a lone move', () => {
    expect(splineFromPos('')).toEqual({ points: [], curve: 'poly', arrowEnd: false, arrowStart: false })
    expect(splineFromPos('e,1,1')).toEqual({ points: [], curve: 'poly', arrowEnd: true, arrowStart: false })
    // Each tip adds a degenerate cubic: start, start, first … last, end, end — seven points, one bezier.
    expect(splineFromPos('s,0,0 e,9,9 1,1')).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 9, y: 9 }, { x: 9, y: 9 }], curve: 'bezier', arrowStart: true, arrowEnd: true })
    expect(splineFromPos('1,1', (x) => x * 2, (y) => -y).points).toEqual([{ x: 2, y: -1 }])
    expect(pathToGeom('')).toEqual({ points: [], curve: 'line' })
    expect(pathToGeom('M3,4')).toEqual({ points: [{ x: 3, y: 4 }], curve: 'bezier' }) // a lone move counts as zero cubics; edgePath draws it as M either way
    expect(pathToGeom('M0,0 L10,0')).toEqual({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], curve: 'line' })
    const q = pathToGeom('M0,0 Q10,10 20,0')
    expect(q.curve).toBe('bezier')
    expect(q.points.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000])).toEqual([[0, 0], [6.667, 6.667], [13.333, 6.667], [20, 0]])
    expect(pathToGeom('M0,0 C1,1 2,2 3,3 L4,4 Z')).toMatchObject({ curve: 'poly', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }] })
    expect(pathToGeom('m0,0 l10,10')).toEqual({ points: [], curve: 'line' }) // relative commands are not read
    expect(pathToGeom('M1e2,-2.5e1 L1.5,.5')).toEqual({ points: [{ x: 100, y: -25 }, { x: 1.5, y: 0.5 }], curve: 'line' })
  })
})

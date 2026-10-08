import { describe, expect, it } from 'vitest'
import { parseDot } from '../dot'
import { writeExcalidraw } from '../excalidraw'
import { elbowRoute, flattenRoute, type DiagramGeometry, type NodeGeom } from '../geometry'
import { autoLayout } from '../layout'

type El = Record<string, any>
const els = (src: string) => JSON.parse(src).elements as El[]
const box = (x: number, y: number): NodeGeom => ({ x, y, width: 100, height: 50, shape: 'box' })

describe('arrow routes in a drawing', () => {
  it('samples a Graphviz spline along the curve and draws it smooth', () => {
    const pts = flattenRoute({ points: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }], curve: 'bezier' })
    expect(pts.length).toBe(7)
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts[6]).toEqual({ x: 100, y: 0 })
    // The mid sample sits on the curve (x=50, y=75 for this symmetric cubic), not at a control point.
    expect(pts[3].x).toBeCloseTo(50)
    expect(pts[3].y).toBeCloseTo(75)

    const d = parseDot('digraph { a -> b }')
    const g: DiagramGeometry = { width: 300, height: 200, nodes: { a: box(50, 25), b: box(250, 125) }, edges: { [d.edges[0].id]: { points: [{ x: 100, y: 25 }, { x: 150, y: 25 }, { x: 150, y: 125 }, { x: 200, y: 125 }], curve: 'bezier' } }, groups: {} }
    const arrow = els(writeExcalidraw({ ...d, geometry: g }))!.find((e) => e.type === 'arrow')!
    expect(arrow.points.length).toBe(7)
    expect(arrow.roundness).toEqual({ type: 2 })
    expect(arrow.elbowed).toBe(false)
  })

  it('routes an elbow between boxes and enters them square-on', () => {
    // Side by side, offset vertically: out the right, down the gap, in the left.
    expect(elbowRoute(box(50, 25), box(350, 225))).toEqual([{ x: 100, y: 25 }, { x: 200, y: 25 }, { x: 200, y: 225 }, { x: 300, y: 225 }])
    // Stacked: out the bottom, across the gap, in the top.
    expect(elbowRoute(box(50, 25), box(250, 325))).toEqual([{ x: 50, y: 50 }, { x: 50, y: 175 }, { x: 250, y: 175 }, { x: 250, y: 300 }])
    // Back edge (target to the left): out the left, in the right.
    expect(elbowRoute(box(350, 25), box(50, 25))).toEqual([{ x: 300, y: 25 }, { x: 100, y: 25 }])
  })

  it('draws elbow arrows bound at fixed points when nothing rendered the diagram', () => {
    const d = parseDot('digraph { rankdir=LR; a -> b [label="x"] }')
    const out = writeExcalidraw({ ...d, geometry: autoLayout(d) })
    const arrow = els(out).find((e) => e.type === 'arrow')!
    expect(arrow.elbowed).toBe(true)
    expect(arrow.fixedSegments).toEqual([])
    expect(arrow.startBinding.fixedPoint[0]).toBe(1) // leaves the source's right side
    expect(arrow.endBinding.fixedPoint[0]).toBe(0) // enters the target's left side
    for (let i = 1; i < arrow.points.length; i++) {
      const [x0, y0] = arrow.points[i - 1]
      const [x1, y1] = arrow.points[i]
      expect(x0 === x1 || y0 === y1).toBe(true) // every segment is axis-aligned
    }
    // The label sits on the route, not off it.
    const label = els(out).find((e) => e.type === 'text' && e.containerId === arrow.id)!
    const ys = arrow.points.map(([, y]: number[]) => arrow.y + y)
    expect(label.y + label.height / 2).toBeGreaterThanOrEqual(Math.min(...ys) - 1)
    expect(label.y + label.height / 2).toBeLessThanOrEqual(Math.max(...ys) + 1)
  })

  it('warns when a bare Graphviz keyword is used as a node id', () => {
    const d = parseDot('digraph { api -> graph; "graph" -> db }')
    expect(d.warnings.some((w) => /"graph" is a Graphviz keyword/.test(w))).toBe(true)
    expect(d.warnings.filter((w) => /keyword/.test(w)).length).toBe(1) // the quoted one is fine
  })
})

describe('arrow attachment', () => {
  it('lists every arrow on both endpoint shapes so Excalidraw moves them with the shape', () => {
    const d = parseDot('digraph { a -> b; a -> c; b -> c }')
    const e = els(writeExcalidraw({ ...d, geometry: autoLayout(d) }))
    const arrows = e.filter((x) => x.type === 'arrow')
    const bound = (id: string) => (e.find((x) => x.id === id)!.boundElements as { id: string; type: string }[]).filter((b) => b.type === 'arrow').map((b) => b.id).sort()
    const of = (src: string, tgt: string) => arrows.find((x) => x.startBinding.elementId === src && x.endBinding.elementId === tgt)!.id
    expect(bound('a')).toEqual([of('a', 'b'), of('a', 'c')].sort())
    expect(bound('b')).toEqual([of('a', 'b'), of('b', 'c')].sort())
    expect(bound('c')).toEqual([of('a', 'c'), of('b', 'c')].sort())
    // Labels stay registered too.
    expect((e.find((x) => x.id === 'a')!.boundElements as { type: string }[]).some((b) => b.type === 'text')).toBe(true)
  })
})

describe('round trip back to Graphviz', () => {
  it('comes back exactly when the drawing was not touched, and reconciles with positions when a node moved', async () => {
    const { switchDiagramFormat } = await import('../sync')
    const DOT = 'digraph { rankdir=LR; a [shape=cylinder]; a -> b [label="x"]; b -> c }'
    const d = parseDot(DOT)
    // A renderer's placement stands in for Graphviz here.
    const rendered = autoLayout(d)
    for (const g of Object.values(rendered.nodes)) g.pinned = false
    const toDrawing = switchDiagramFormat({ format: 'dot', source: DOT, sources: undefined, rendered }, 'excalidraw')
    const back = switchDiagramFormat({ format: 'excalidraw', source: toDrawing.source, sources: toDrawing.sources }, 'dot')
    expect(back.how).toBe('exact')
    expect(back.source).toBe(DOT)

    const file = JSON.parse(toDrawing.source)
    const shape = file.elements.find((e: El) => e.id === 'a')
    shape.x += 200
    const moved = switchDiagramFormat({ format: 'excalidraw', source: JSON.stringify(file), sources: back.sources }, 'dot')
    expect(moved.how).toBe('reconciled')
    const aLine = moved.source.split('\n').find((l) => /^\s*a \[/.test(l))!
    expect(aLine).toMatch(/shape=cylinder/) // the shape word survived the drawing
    expect(aLine).toMatch(/pos="/) // and the move is written as a pinned position
  })
})

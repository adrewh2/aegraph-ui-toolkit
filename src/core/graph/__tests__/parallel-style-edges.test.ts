import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { svgFromView } from '../../exchange/graph/svg'
import { curvatureFor, DEFAULT_EDGE_CURVATURE, indexParallelEdges } from '../parallel'
import type { EdgeStyle, NodeStyle } from '../rendering'
import { edgeColor, nodeColor, toHexColor } from '../style'

/**
 * Parallel-edge bundles and colours at their edges: a pair in opposite
 * directions must curve to opposite sides of the line, not onto the
 * same one; bundles of three and four; a self-loop never in a bundle;
 * singletons absent; the middle of an odd bundle straight; curvature
 * symmetric, damped past three, scaled by a base; and the colour forms
 * toHexColor does and does not read.
 */
const E = (id: string, s: string, t: string) => ({ id, source: { id: s }, target: { id: t } })
/** The side of the a→b line an edge's control point lands on: curvature relative to its own direction, flipped for edges drawn b→a. */
const side = (e: { source: { id: string }; target: { id: string } }, curv: number | undefined) => (curv === undefined ? 0 : Math.sign(curv) * (e.source.id < e.target.id ? 1 : -1))

describe('parallel bundles', () => {
  it('puts a pair drawn in opposite directions on opposite sides of the line', () => {
    const edges = [E('ab', 'a', 'b'), E('ba', 'b', 'a')]
    const idx = indexParallelEdges(edges)
    expect(idx.get('ab')?.count).toBe(2)
    expect(idx.get('ba')?.count).toBe(2)
    const sides = edges.map((e) => side(e, curvatureFor(idx.get(e.id))))
    expect(sides[0]).not.toBe(0)
    expect(sides[0]).toBe(-sides[1])
    // Three edges, one of them the other way: three distinct sides/offsets on the a→b line.
    const three = [E('1', 'a', 'b'), E('2', 'b', 'a'), E('3', 'a', 'b')]
    const i3 = indexParallelEdges(three)
    const offsets = three.map((e) => (curvatureFor(i3.get(e.id)) ?? 0) * (e.source.id < e.target.id ? 1 : -1))
    expect(new Set(offsets).size).toBe(3)
    expect(offsets).toContain(0)
    // On paper: the SVG writer bends the two arrows through two different control points, one above and one below the line.
    const nodes = [createEntity({ id: 'a', type: 't' }), createEntity({ id: 'b', type: 't' })]
    const rels = [createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }), createRelationship({ id: 'ba', type: 'r', source: 'b', target: 'a' })]
    const ns: NodeStyle = { color: '#000', size: 4, shape: 'circle', opacity: 1, visible: true, label: false }
    const es: EdgeStyle = { color: '#000', width: 1, opacity: 1, visible: true, arrow: true }
    const svg = svgFromView({ nodes, edges: rels }, { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } }, { nodes: new Map([['a', ns], ['b', ns]]), edges: new Map([['ab', es], ['ba', es]]) }, { width: 400, height: 200, curvedEdges: true })
    const controls = [...svg.matchAll(/ Q([\d.]+) ([\d.]+) /g)].map((m) => Number(m[2]))
    expect(controls).toHaveLength(2)
    expect(Math.sign(controls[0] - 100)).toBe(-Math.sign(controls[1] - 100)) // one control point above the line's y, one below
  })

  it('indexes bundles of two, three and four symmetrically, leaves singletons and self-loops out, and keeps declaration order', () => {
    const idx = indexParallelEdges([E('s', 'x', 'y'), E('l1', 'a', 'a'), E('l2', 'a', 'a'), E('p', 'a', 'b'), E('q', 'a', 'b'), E('r', 'a', 'b'), E('t1', 'c', 'd'), E('t2', 'c', 'd'), E('t3', 'c', 'd'), E('t4', 'c', 'd')])
    expect(idx.has('s')).toBe(false)
    expect(idx.has('l1')).toBe(false)
    expect(idx.has('l2')).toBe(false)
    expect(['p', 'q', 'r'].map((id) => idx.get(id))).toEqual([{ index: -1, count: 3 }, { index: 0, count: 3 }, { index: 1, count: 3 }])
    expect(['t1', 't2', 't3', 't4'].map((id) => idx.get(id)!.index)).toEqual([-1.5, -0.5, 0.5, 1.5])
    expect(indexParallelEdges([]).size).toBe(0)
  })

  it('curves symmetrically, straight in the middle, damped past three, and scaled by the base', () => {
    expect(curvatureFor(undefined)).toBeUndefined()
    expect(curvatureFor({ index: 0, count: 3 })).toBeUndefined()
    expect(curvatureFor({ index: -0.5, count: 2 })).toBe(-0.5 * DEFAULT_EDGE_CURVATURE)
    expect(curvatureFor({ index: 0.5, count: 2 })).toBe(0.5 * DEFAULT_EDGE_CURVATURE)
    expect(curvatureFor({ index: 1, count: 3 })).toBe(DEFAULT_EDGE_CURVATURE)
    expect(curvatureFor({ index: 1.5, count: 4 })).toBeCloseTo(1.5 * DEFAULT_EDGE_CURVATURE * 0.7)
    expect(curvatureFor({ index: -1, count: 5 })).toBeCloseTo(-DEFAULT_EDGE_CURVATURE * 0.7)
    expect(curvatureFor({ index: 1, count: 2 }, 0.5)).toBe(0.5)
    expect(curvatureFor({ index: 1, count: 2 }, 0)).toBe(0) // a zero base is a curve of nothing, not straight
  })
})

describe('colour forms', () => {
  it('reads hex in both lengths, rgb() with or without alpha, hsl() in the space form, clamps, and passes everything else through', () => {
    expect(toHexColor('#ABCDEF')).toBe('#abcdef')
    expect(toHexColor('#abcd')).toBe('#abcd') // four digits: not a form it knows
    expect(toHexColor('#12345')).toBe('#12345')
    expect(toHexColor('rgb(300, 5, 12)')).toBe('#ff050c') // clamped
    expect(toHexColor('rgb(300, -5, 12)')).toBe('rgb(300, -5, 12)') // a negative channel is not a form it reads
    expect(toHexColor('rgb( 1, 2, 3)')).toBe('rgb( 1, 2, 3)') // a space after the bracket is not read
    expect(toHexColor('RGB(1,2,3)')).toBe('RGB(1,2,3)') // nor upper case
    expect(toHexColor('rgb(100%, 0%, 0%)')).toBe('rgb(100%, 0%, 0%)')
    expect(toHexColor('hsl(0, 100%, 50%)')).toBe('hsl(0, 100%, 50%)') // the comma form is not read
    expect(toHexColor('hsl(360 100% 100%)')).toBe('#ffffff')
    expect(toHexColor('hsl(0 0% 0%)')).toBe('#000000')
    expect(toHexColor('transparent')).toBe('transparent')
  })

  it('hashes a type without a colour to a readable hex or grey-mixed rgb, never hsl, and gives edges a pale hex', () => {
    for (const type of ['a', 'person', 'work', 'zzz', 'Programming Language', '']) {
      const c = nodeColor(undefined, type)
      expect(c, type).toMatch(/^#[0-9a-f]{6}$|^rgb\(\d+, \d+, \d+\)$/)
      expect(edgeColor(type), type).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(nodeColor('#000000', 'x')).toBe('#000000')
    expect(nodeColor('rgb(0,0,0)', 'x')).toBe('#000000')
    expect(nodeColor('#fff', 'x')).toBe(nodeColor('#ffffff', 'x'))
  })
})

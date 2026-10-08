import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import type { EdgeStyle, NodeStyle } from '../../../graph/rendering'
import '../../../graph/types'
import { svgFromView } from '../svg'

/**
 * The SVG writer at its edges: an empty view, a single node and a line of
 * nodes (centred, not cornered), labels auto/all/none and their escaping,
 * a node without a position or hidden and the edges that lose an end, a
 * self-loop, edge labels from the type, markers per colour and only for
 * directed arrows, curved parallels, coordinates huge and negative fitted
 * inside the padding, a zero-size view, every shape, opacity, scale and
 * the minimum radius, font and background options, determinism.
 */
const nodeStyle = (over: Partial<NodeStyle> = {}): NodeStyle => ({ color: '#ff0000', size: 8, shape: 'circle', opacity: 1, visible: true, label: true, ...over })
const edgeStyle = (over: Partial<EdgeStyle> = {}): EdgeStyle => ({ color: '#111111', width: 1, opacity: 1, visible: true, arrow: true, ...over })
const node = (id: string, label = id, type = 't') => createEntity({ id, type, label })
const edge = (id: string, source: string, target: string, directed = true, label?: string) => createRelationship({ id, type: 'rel', source, target, directed, label })
const styles = (nodes: Record<string, Partial<NodeStyle>>, edges: Record<string, Partial<EdgeStyle>> = {}) => ({ nodes: new Map(Object.entries(nodes).map(([k, v]) => [k, nodeStyle(v)])), edges: new Map(Object.entries(edges).map(([k, v]) => [k, edgeStyle(v)])) })
const circles = (svg: string) => [...svg.matchAll(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), r: Number(m[3]) }))

describe('svg edges', () => {
  it('an empty view is a bare document; a single node sits in the middle; a row of nodes is centred vertically; every position lands inside the padding whatever the coordinates', () => {
    const empty = svgFromView({ nodes: [], edges: [] }, {}, styles({}))
    expect(empty).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"></svg>\n')
    const one = circles(svgFromView({ nodes: [node('a')], edges: [] }, { a: { x: 5, y: -7 } }, styles({ a: {} }), { width: 400, height: 300 }))
    expect(one).toEqual([{ x: 200, y: 150, r: 8 }])
    const row = circles(svgFromView({ nodes: [node('a'), node('b'), node('c')], edges: [] }, { a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, c: { x: 100, y: 0 } }, styles({ a: {}, b: {}, c: {} }), { width: 400, height: 300, padding: 20 }))
    expect(row.map((p) => p.y)).toEqual([150, 150, 150])
    expect(row.map((p) => p.x)).toEqual([20, 200, 380])
    const wild = circles(svgFromView({ nodes: [node('a'), node('b'), node('c')], edges: [] }, { a: { x: -1e9, y: 1e9 }, b: { x: 1e9, y: -1e9 }, c: { x: 0, y: 0 } }, styles({ a: {}, b: {}, c: {} }), { width: 400, height: 300, padding: 30 }))
    expect(wild).toEqual([{ x: 80, y: 30, r: 8 }, { x: 320, y: 270, r: 8 }, { x: 200, y: 150, r: 8 }]) // a is top-left: graph y grows upward
    for (const p of wild) {
      expect(p.x).toBeGreaterThanOrEqual(30)
      expect(p.x).toBeLessThanOrEqual(370)
      expect(p.y).toBeGreaterThanOrEqual(30)
      expect(p.y).toBeLessThanOrEqual(270)
    }
    // A zero-size view still writes a document with finite numbers.
    const zero = svgFromView({ nodes: [node('a'), node('b')], edges: [] }, { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, styles({ a: {}, b: {} }), { width: 0, height: 0, padding: 0 })
    expect(zero).toContain('width="0" height="0"')
    expect(zero).not.toMatch(/NaN|Infinity/)
  })

  it('labels: auto shows them from radius 6, all shows every labelled node, none shows nothing; text is escaped, emoji kept, the label falling back to the id', () => {
    const nodes = [node('big', 'A <b> & "q" \'s\' 🎉'), node('small', 'tiny'), createEntity({ id: 'nolabel', type: 't' })]
    const positions = { big: { x: 0, y: 0 }, small: { x: 10, y: 0 }, nolabel: { x: 20, y: 0 } }
    const st = styles({ big: { size: 6 }, small: { size: 5.9 }, nolabel: { size: 10 } })
    const auto = svgFromView({ nodes, edges: [] }, positions, st)
    expect(auto).toContain('>A &lt;b&gt; &amp; &quot;q&quot; &apos;s&apos; 🎉</text>')
    expect(auto).not.toContain('>tiny<')
    expect(auto).toContain('>nolabel</text>')
    const all = svgFromView({ nodes, edges: [] }, positions, st, { labels: 'all' })
    expect(all).toContain('>tiny</text>')
    const none = svgFromView({ nodes, edges: [] }, positions, st, { labels: 'none' })
    expect(none).not.toContain('<g class="labels">')
    expect(svgFromView({ nodes, edges: [] }, positions, styles({ big: { label: false }, small: { label: false }, nolabel: { label: false } }), { labels: 'all' })).not.toContain('<text')
    // Scale grows the radius and so the auto threshold; a size of 0 is still a radius of 1.
    expect(svgFromView({ nodes: [nodes[1]], edges: [] }, positions, styles({ small: { size: 3 } }), { scale: 2 })).toContain('>tiny</text>')
    expect(circles(svgFromView({ nodes: [nodes[1]], edges: [] }, positions, styles({ small: { size: 0 } })))[0].r).toBe(1)
  })

  it('a node without a position or hidden is left out with its edges; a self-loop is never drawn; an edge with no style is skipped; an edge label falls back to the type and is escaped', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')]
    const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd', true, 'x < y'), edge('aa', 'a', 'a'), edge('ad', 'a', 'd')]
    const positions = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 0 }, d: { x: 30, y: 0 } }
    const st = styles({ a: {}, b: { visible: false }, c: {}, d: {} }, { ab: {}, bc: {}, cd: {}, aa: {}, ad: { visible: false } })
    const svg = svgFromView({ nodes, edges }, { ...positions, c: undefined as never }, st, { edgeLabels: true })
    expect(svg).not.toContain('data-id="b"')
    expect(svg).not.toContain('data-id="c"')
    for (const id of ['ab', 'bc', 'cd', 'aa', 'ad']) expect(svg, id).not.toContain(`data-id="${id}"`)
    const drawn = svgFromView({ nodes, edges }, positions, styles({ a: {}, b: {}, c: {}, d: {} }, { ab: {}, cd: {}, aa: {} }), { edgeLabels: true })
    expect(drawn).toContain('data-id="ab"')
    expect(drawn).not.toContain('data-id="bc"') // no style, no edge
    expect(drawn).not.toContain('data-id="aa"')
    expect(drawn).toContain('>rel</text>')
    expect(drawn).toContain('>x &lt; y</text>')
    expect(drawn).toContain('font-size="9.6"')
  })

  it('markers: one per colour, only on directed edges whose style has an arrow, the line shortened for it; undirected and arrowless edges end at the radius; curved parallels bend either way', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: 100 } }
    const edges = [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('ac', 'a', 'c', false), edge('bc', 'b', 'c'), edge('cb', 'c', 'b', true)]
    const st = styles({ a: { size: 10 }, b: { size: 10 }, c: { size: 10 } }, { ab: { color: '#111' }, ba: { color: '#222', width: 2 }, ac: { color: '#111' }, bc: { color: '#111', arrow: false }, cb: { color: '#222', width: 2 } })
    const svg = svgFromView({ nodes, edges }, positions, st, { width: 300, height: 300, padding: 50 })
    expect([...svg.matchAll(/<marker id="(a\d)"[^>]*><path[^>]*fill="(#\d+)"/g)].map((m) => [m[1], m[2]])).toEqual([['a0', '#111'], ['a1', '#222']])
    expect(svg.match(/marker-end="url\(#a0\)"/g)?.length).toBe(1) // ab only: ac is undirected, bc has no arrow
    expect(svg.match(/marker-end="url\(#a1\)"/g)?.length).toBe(2)
    const line = (id: string) => svg.match(new RegExp(`<line x1="([\\d.]+)" y1="([\\d.]+)" x2="([\\d.]+)" y2="([\\d.]+)"[^>]*data-id="${id}"`))!.slice(1, 5).map(Number)
    expect(line('ab')).toEqual([60, 250, 237, 250]) // a at (50,250), b at (250,250): starts at r=10, ends at r + 3·width
    expect(line('ba')).toEqual([240, 250, 66, 250]) // width 2: ends 16 short
    expect(line('ac')).toEqual([50, 240, 50, 60]) // undirected: both ends at the radius
    expect(line('bc')).toEqual([242.93, 242.93, 57.07, 57.07])
    const curved = svgFromView({ nodes, edges }, positions, st, { width: 300, height: 300, padding: 50, curvedEdges: true })
    const paths = [...curved.matchAll(/<path d="M([\d.]+) ([\d.]+) Q([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"[^>]*data-id="(\w+)"/g)].map((m) => [m[7], ...m.slice(1, 7).map(Number)])
    expect(paths.map((p) => p[0])).toEqual(['ab', 'ba', 'bc', 'cb'])
    const ab = paths.find((p) => p[0] === 'ab')!
    const ba = paths.find((p) => p[0] === 'ba')!
    expect(ab[4]).not.toBe(250) // the control point leaves the line
    expect(Math.sign(Number(ab[4]) - 250)).toBe(-Math.sign(Number(ba[4]) - 250)) // each bends to its own left, so the pair lands on opposite sides of the page: two curves, not one
    expect(curved).not.toContain('data-id="ac"' + '"') // no crash on the lone undirected edge
  })

  it('shapes, opacity, colour fallbacks, font and background options, and the same input twice is the same document', () => {
    const nodes = [node('c'), node('s'), node('d'), node('t'), node('x', 'x', 'odd')]
    const positions = { c: { x: 0, y: 0 }, s: { x: 1, y: 0 }, d: { x: 2, y: 0 }, t: { x: 3, y: 0 }, x: { x: 4, y: 0 } }
    const st = styles({ c: { opacity: 0.25 }, s: { shape: 'square' }, d: { shape: 'diamond' }, t: { shape: 'triangle' }, x: { shape: 'hexagon' as never, color: undefined as never } })
    const svg = svgFromView({ nodes, edges: [] }, positions, st, { fontFamily: 'Inter, "Helvetica Neue"', fontSize: 14, background: 'rgb(1, 2, 3)' })
    expect(svg).toContain('<circle cx="24" cy="400" r="8" fill="#ff0000" fill-opacity="0.25" data-id="c"/>')
    expect(svg).toContain('<rect x="304" y="392" width="16" height="16"')
    expect(svg).toContain('<polygon points="600,392 608,400 600,408 592,400"')
    expect(svg).toContain('<polygon points="888,392 896,408 880,408"')
    // An unknown shape is a circle; with no colour of its own the type's own colour stands in — dark enough to read
    // as it is (hex), or mixed toward grey when the palette hands back something near white (`rgb(...)`).
    expect(svg).toMatch(/<circle cx="1176" cy="400" r="8" fill="(#[0-9a-f]{6}|rgb\()/)
    expect(svg).toContain('font-family="Inter, &quot;Helvetica Neue&quot;" font-size="14"')
    expect(svg).toContain('<rect width="100%" height="100%" fill="rgb(1, 2, 3)"/>')
    expect(svgFromView({ nodes, edges: [] }, positions, st, { background: 'transparent' })).not.toContain('width="100%"')
    expect(svgFromView({ nodes, edges: [] }, positions, st)).toBe(svgFromView({ nodes, edges: [] }, positions, st))
    expect(svg.endsWith('</svg>\n')).toBe(true)
  })
})

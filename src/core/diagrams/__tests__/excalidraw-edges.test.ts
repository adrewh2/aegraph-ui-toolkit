import { describe, expect, it } from 'vitest'
import { parseDot } from '../dot'
import { parseExcalidraw, writeExcalidraw } from '../excalidraw'
import { addEdge, emptyDiagram, upsertNode } from '../model'

/**
 * The Excalidraw parser and writer at their edges: deleted elements and
 * what they take with them, text bound, free or orphaned, arrows bound
 * at one end, at neither, to a frame, or a line bound at both, frames
 * named, unnamed, magic, nested, membership by id or by containment,
 * every element type, colours and strokes into attrs and geometry, the
 * canvas size, files that are not drawings; and the writer on a diagram
 * without geometry, ids in any spelling, shapes from other formats,
 * labels appearing and disappearing, a previous drawing reused with its
 * strays kept and its removed elements dropped, edges re-routed only
 * when an end moved, restyling, and what parse(write(d)) preserves.
 */
type El = Record<string, unknown> & { id: string; type: string }
const file = (elements: El[], appState: Record<string, unknown> = {}) => JSON.stringify({ type: 'excalidraw', version: 2, elements, appState, files: {} })
const rect = (id: string, x: number, y: number, over: Record<string, unknown> = {}): El => ({ id, type: 'rectangle', x, y, width: 100, height: 50, strokeColor: '#1e1e1e', backgroundColor: 'transparent', ...over })
const text = (id: string, containerId: string | null, t: string, over: Record<string, unknown> = {}): El => ({ id, type: 'text', x: 0, y: 0, width: 50, height: 20, text: t, containerId, ...over })
const arrow = (id: string, s: string | null, t: string | null, over: Record<string, unknown> = {}): El => ({ id, type: 'arrow', x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]], startBinding: s ? { elementId: s } : null, endBinding: t ? { elementId: t } : null, endArrowhead: 'arrow', ...over })
const els = (src: string) => JSON.parse(src).elements as El[]

describe('parsing', () => {
  it('ignores deleted elements and what was bound to them, skips text bound to nothing that exists, and reads free text as a text node', () => {
    const d = parseExcalidraw(file([
      rect('gone', 0, 0, { isDeleted: true, boundElements: [{ id: 'gone_t', type: 'text' }] }),
      text('gone_t', 'gone', 'Gone'),
      rect('a', 0, 0, { boundElements: [{ id: 'a_t', type: 'text' }, { id: 'zz', type: 'text' }] }),
      text('a_t', 'a', ' A ', { isDeleted: true }),
      text('orphan', 'missing', 'Orphan'),
      text('free', null, 'Free', { originalText: 'Free\noriginal' }),
      text('empty', null, '   '),
      arrow('e', 'gone', 'a'),
      { id: 'f', type: 'frame', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
      rect('inf', 1, 1, { frameId: 'f' }),
    ]))
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([['a', '', 'box'], ['free', 'Free\noriginal', 'text'], ['empty', '', 'text'], ['inf', '', 'box']])
    expect(d.edges).toEqual([])
    expect(d.groups).toEqual([])
    expect(d.nodes.find((n) => n.id === 'inf')?.group).toBeUndefined() // the frame it names is deleted, and no live frame contains it
    expect(d.warnings).toEqual(['1 arrow/line not attached at both ends is not part of the graph (kept in the drawing).'])
    expect(d.geometry!.nodes.free).toMatchObject({ shape: 'text', fill: undefined, stroke: undefined, pinned: true })
  })

  it('makes edges only from arrows or lines bound at both ends to nodes, reading direction from the head and the type', () => {
    const d = parseExcalidraw(file([
      rect('a', 0, 0), rect('b', 200, 0), { id: 'fr', type: 'frame', x: -10, y: -10, width: 400, height: 100, name: 'F' },
      arrow('half', 'a', null), arrow('none', null, null), arrow('toFrame', 'a', 'fr'), arrow('toText', 'a', 'lbl'), text('lbl', null, 'L'),
      arrow('ok', 'a', 'b', { boundElements: [{ id: 'ok_t', type: 'text' }], startArrowhead: 'bar', points: [[0, 0], [50, 30], [100, 0]], x: 100, y: 25, strokeStyle: 'dotted', strokeColor: '#c00', strokeWidth: 2 }),
      text('ok_t', 'ok', 'label'),
      arrow('noHead', 'b', 'a', { endArrowhead: null }),
      arrow('undef', 'b', 'a', { endArrowhead: undefined }),
      { id: 'line', type: 'line', x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } },
      { id: 'draw', type: 'freedraw', x: 0, y: 0, width: 5, height: 5, points: [[0, 0], [5, 5]] },
      { id: 'draw2', type: 'freedraw', x: 0, y: 0, width: 5, height: 5, points: [[0, 0], [5, 5]] },
    ]))
    expect(d.edges.map((e) => [e.id, e.source, e.target, e.directed, e.label, e.style])).toEqual([
      ['toText', 'a', 'lbl', true, undefined, undefined], // free text is a node, so an arrow to it is an edge
      ['ok', 'a', 'b', true, 'label', 'dotted'],
      ['noHead', 'b', 'a', false, undefined, undefined],
      ['undef', 'b', 'a', true, undefined, undefined],
      ['line', 'a', 'b', false, undefined, undefined],
    ])
    expect(d.geometry!.edges.ok).toMatchObject({ curve: 'poly', stroke: '#c00', strokeWidth: 2, dashed: true, arrowStart: true, arrowEnd: true, points: [{ x: 100, y: 25 }, { x: 150, y: 55 }, { x: 200, y: 25 }], label: { x: 150, y: 47 } })
    expect(d.geometry!.edges.line).toMatchObject({ curve: 'line', arrowStart: false, arrowEnd: false })
    expect(d.warnings).toEqual(['3 arrows/lines not attached at both ends are not part of the graph (kept in the drawing).', '2 freehand strokes are not part of the graph (kept in the drawing).'])
  })

  it('reads frames named or not, magic frames, nesting without a parent, and membership by id or by the centre falling inside', () => {
    const d = parseExcalidraw(file([
      { id: 'outer', type: 'frame', x: 0, y: 0, width: 400, height: 400, name: '  ' },
      { id: 'inner', type: 'magicframe', x: 50, y: 50, width: 100, height: 100, name: 'Inner', strokeColor: '#abc' },
      rect('byId', 300, 300, { frameId: 'inner' }),
      rect('byBox', 60, 60),
      rect('outside', 900, 900),
      rect('edge', 150, 10), // centre at (200, 35): inside outer only
    ]))
    expect(d.groups.map((g) => [g.id, g.label, g.parent])).toEqual([['outer', 'Frame', undefined], ['inner', 'Inner', undefined]])
    expect(d.nodes.map((n) => [n.id, n.group])).toEqual([['byId', 'inner'], ['byBox', 'outer'], ['outside', undefined], ['edge', 'outer']]) // the first frame whose box holds the centre
    expect(d.geometry!.groups.outer).toMatchObject({ x: 0, y: 0, width: 400, height: 400, stroke: '#bbb', label: { x: 6, y: -6 } })
    expect(d.geometry!.groups.inner.stroke).toBe('#abc')
  })

  it('reads every element type, colours, strokes, rotation, roundness, groups and links into attrs and geometry, and sizes the canvas', () => {
    const d = parseExcalidraw(file([
      rect('r', 10, 10, { backgroundColor: '#fee', strokeColor: '#f00', strokeWidth: 4, strokeStyle: 'dashed', angle: 0.5, roundness: { type: 3 }, groupIds: ['g1', 'g2'], link: 'https://x', boundElements: [{ id: 'r_t', type: 'text' }] }),
      text('r_t', 'r', 'R', { strokeColor: '#00f', fontSize: 20 }),
      { id: 'el', type: 'ellipse', x: 200, y: 10, width: 80, height: 80, roundness: { type: 2 } },
      { id: 'di', type: 'diamond', x: 400, y: 10, width: 80, height: 80, backgroundColor: 'transparent' },
      { id: 'im', type: 'image', x: 600, y: 10, width: 80, height: 80, fileId: 'abc', boundElements: [{ id: 'im_t', type: 'text' }] },
      text('im_t', 'im', 'Pic'),
      { id: 'web', type: 'embeddable', x: 0, y: 0, width: 10, height: 10 },
    ], { viewBackgroundColor: '#fafafa' }))
    expect(d.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([['r', 'box', 'R'], ['el', 'ellipse', ''], ['di', 'diamond', ''], ['im', 'box', 'Pic']])
    expect(d.nodes[0]).toMatchObject({ classes: ['group:g1'], attrs: { link: 'https://x', fillcolor: '#fee', color: '#f00' } })
    expect(d.nodes[2].attrs).toEqual({})
    expect(d.geometry!.nodes.r).toEqual({ x: 60, y: 35, width: 100, height: 50, shape: 'rounded', fill: '#fee', stroke: '#f00', strokeWidth: 4, dashed: true, color: '#00f', fontSize: 20, rotation: 0.5, pinned: true })
    expect(d.geometry!.nodes.el).toMatchObject({ shape: 'ellipse', fill: '#fff', stroke: '#1e1e1e', rotation: undefined })
    expect(d.geometry!.nodes.di.shape).toBe('diamond')
    expect(d.geometry!.background).toBe('#fafafa')
    expect([d.geometry!.width, d.geometry!.height]).toEqual([720, 130])
    expect(parseExcalidraw(file([])).geometry).toMatchObject({ width: 40, height: 40, background: undefined })
    expect(parseExcalidraw(file([], { viewBackgroundColor: '#ffffff' })).geometry!.background).toBeUndefined()
  })

  it('refuses what is not a drawing', () => {
    expect(() => parseExcalidraw('{"type":"svg","elements":[]}')).toThrow(/Not an Excalidraw file/)
    expect(() => parseExcalidraw('{"type":"excalidraw"}')).toThrow(/Not an Excalidraw file/)
    expect(() => parseExcalidraw('[]')).toThrow(/Not an Excalidraw file/)
    expect(() => parseExcalidraw('{oops')).toThrow(SyntaxError)
    expect(parseExcalidraw({ type: 'excalidraw', elements: [] }).nodes).toEqual([])
  })
})

describe('writing', () => {
  it('lays out a diagram without geometry, keeps ids in any spelling, maps shapes from other formats, binds labels and frames, and reads back the same', () => {
    const d = parseDot('digraph { subgraph cluster_g { label="G"; "a-1" [label="Alpha\\nBeta", shape=circle, fillcolor="#fee", color="#f00", penwidth=3, style="filled,dashed", fontcolor="#00f"]; } b [shape=Mdiamond]; c [shape=stadium]; t [shape=text, label="just text"]; "a-1" -> b [label=go, color="#0f0", style=dotted]; b -> c; c -> nowhere }')
    d.edges = d.edges.filter((e) => e.target !== 'nowhere')
    d.nodes = d.nodes.filter((n) => n.id !== 'nowhere')
    const out = writeExcalidraw(d)
    const e = els(out)
    const a = e.find((x) => x.id === 'a-1')!
    // A shape lists its label and every arrow bound to it, so Excalidraw moves the arrows with the shape.
    expect(a).toMatchObject({ type: 'ellipse', backgroundColor: '#fee', strokeColor: '#f00', strokeWidth: 3, strokeStyle: 'dashed', frameId: 'cluster_g', boundElements: [{ id: expect.any(String), type: 'text' }, { id: 'e1', type: 'arrow' }] })
    const at = e.find((x) => x.containerId === 'a-1')!
    expect(at).toMatchObject({ type: 'text', text: 'Alpha\nBeta', strokeColor: '#00f', frameId: 'cluster_g', width: 5 * 16 * 0.6, height: 2 * 16 * 1.25 })
    expect(e.find((x) => x.id === 'b')).toMatchObject({ type: 'diamond', roundness: null, frameId: null })
    expect(e.find((x) => x.id === 'c')).toMatchObject({ type: 'rectangle', roundness: { type: 3 } })
    expect(e.find((x) => x.id === 't')).toMatchObject({ type: 'text', text: 'just text', containerId: null })
    expect(e[0]).toMatchObject({ type: 'frame', id: 'cluster_g', name: 'G' })
    const ab = e.find((x) => x.type === 'arrow' && (x.startBinding as { elementId: string }).elementId === 'a-1')!
    expect(ab).toMatchObject({ strokeColor: '#0f0', strokeStyle: 'dashed', endArrowhead: 'arrow', frameId: null })
    expect(e.find((x) => x.containerId === ab.id)?.text).toBe('go')
    const back = parseExcalidraw(out)
    // Shape words Excalidraw has no element for (Mdiamond, stadium, cylinder) ride along in customData and come back as written.
    expect(back.nodes.map((n) => [n.id, n.label, n.shape, n.group])).toEqual([['a-1', 'Alpha\nBeta', 'ellipse', 'cluster_g'], ['b', 'b', 'Mdiamond', undefined], ['c', 'c', 'stadium', undefined], ['t', 'just text', 'text', undefined]])
    expect(back.edges.map((x) => [x.source, x.target, x.label, x.directed, x.style])).toEqual([['a-1', 'b', 'go', true, 'dotted'], ['b', 'c', undefined, true, undefined]])
    expect(back.geometry!.nodes.c.shape).toBe('stadium') // drawn rounded, read back as the word it was written with
    expect(back.warnings).toEqual([])
  })

  it('writes no frame for a group the geometry does not place, and skips an edge to a node it did not draw', () => {
    const d = emptyDiagram('dot')
    upsertNode(d, 'a', { label: 'A', group: 'g' })
    d.groups.push({ id: 'g', label: 'G', attrs: {} })
    addEdge(d, { source: 'a', target: 'ghost', directed: true, attrs: {} })
    d.geometry = { width: 100, height: 100, nodes: { a: { x: 50, y: 50, width: 80, height: 40, pinned: true } }, edges: {}, groups: {} }
    const e = els(writeExcalidraw(d))
    expect(e.map((x) => x.type)).toEqual(['rectangle', 'text'])
    expect(e[0].frameId).toBeNull()
  })

  it('reuses a previous drawing: untouched elements keep their style and seed, strays stay, removed nodes go with their labels, a label appears or changes, a frame is renamed', () => {
    const prev = file([
      { id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 200, name: 'Old name' },
      rect('a', 10, 10, { seed: 42, backgroundColor: '#ffd', roughness: 2, boundElements: [{ id: 'a_t', type: 'text' }], frameId: 'f' }),
      text('a_t', 'a', 'A', { fontSize: 20, seed: 7 }),
      rect('b', 200, 10, { boundElements: [] }),
      rect('c', 400, 10, { boundElements: [{ id: 'c_t', type: 'text' }] }),
      text('c_t', 'c', 'C'),
      arrow('ab', 'a', 'b', { seed: 9, points: [[0, 0], [40, 40], [90, 0]] }),
      arrow('ac', 'a', 'c'),
      arrow('loose', null, null),
      { id: 'draw', type: 'freedraw', x: 0, y: 0, width: 5, height: 5, points: [[0, 0]] },
      text('note', null, 'a note'),
      { id: 'pic', type: 'image', x: 0, y: 300, width: 10, height: 10, fileId: 'img' },
    ], { viewBackgroundColor: '#123456', gridSize: 20 })
    const d = parseExcalidraw(prev)
    // Rename A, give B a label, drop C, rename the frame; leave positions as they are.
    d.nodes.find((n) => n.id === 'a')!.label = 'A2'
    d.nodes.find((n) => n.id === 'b')!.label = 'Bee'
    d.nodes = d.nodes.filter((n) => n.id !== 'c' && n.id !== 'pic')
    d.edges = d.edges.filter((e) => e.id !== 'ac')
    d.groups[0].label = 'New name'
    const out = writeExcalidraw(d, { previous: prev })
    const e = els(out)
    expect(e.map((x) => x.id).filter((id) => !id.startsWith('ae'))).toEqual(['f', 'a', 'a_t', 'b', 'note', 'ab', 'loose', 'draw', 'pic']) // frames, nodes (free text is one), edges, then the strays
    expect(e.find((x) => x.id === 'a')).toMatchObject({ seed: 42, backgroundColor: '#ffd', roughness: 2, version: 2, frameId: 'f' })
    expect(e.find((x) => x.id === 'a_t')).toMatchObject({ text: 'A2', originalText: 'A2', fontSize: 20, seed: 7 })
    const bt = e.find((x) => x.type === 'text' && x.containerId === 'b')!
    expect(bt.text).toBe('Bee')
    expect(e.find((x) => x.id === 'b')!.boundElements).toEqual([{ id: bt.id, type: 'text' }, { id: 'ab', type: 'arrow' }])
    expect(e.find((x) => x.id === 'ab')).toMatchObject({ seed: 9, points: [[0, 0], [40, 40], [90, 0]] }) // no end moved: the route is kept
    expect(e.find((x) => x.id === 'f')).toMatchObject({ name: 'New name', width: 500 })
    expect(JSON.parse(out).appState).toEqual({ viewBackgroundColor: '#123456', gridSize: 20 })
    // The image stayed although it was dropped as a node: it was never modelled by the diagram as a shape with text.
    expect(e.find((x) => x.id === 'pic')?.type).toBe('image')
  })

  it('re-routes an arrow when a pinned end moved, restyles from stated attributes only, and keeps unstated ones', () => {
    const prev = file([
      rect('a', 0, 0, { backgroundColor: '#ffd', strokeColor: '#123', strokeStyle: 'dashed', boundElements: [{ id: 'a_t', type: 'text' }] }),
      text('a_t', 'a', 'A'),
      rect('b', 300, 0, { boundElements: [] }),
      arrow('ab', 'a', 'b', { points: [[0, 0], [100, 80], [300, 0]], strokeColor: '#999' }),
    ])
    const d = parseExcalidraw(prev)
    d.geometry!.nodes.b.x = 600
    d.nodes[0].attrs = { fillcolor: '#0f0', style: 'solid' }
    d.edges[0].attrs.color = '#f00'
    d.edges[0].style = 'solid'
    const e = els(writeExcalidraw(d, { previous: prev }))
    // Re-routed border to border (an elbow route between boxes on one row is a straight run), not centre to centre.
    expect(e.find((x) => x.id === 'ab')).toMatchObject({ points: [[0, 0], [450, 0]], strokeColor: '#f00', x: 100, y: 25 })
    expect(e.find((x) => x.id === 'a')).toMatchObject({ backgroundColor: '#0f0', strokeColor: '#123', strokeStyle: 'solid' })
    expect(e.find((x) => x.id === 'b')).toMatchObject({ x: 550, y: 0 })
    // A previous that is not a drawing is ignored rather than trusted.
    expect(els(writeExcalidraw(d, { previous: '{"type":"nope"}' })).find((x) => x.id === 'a')?.version).toBe(2)
    expect(els(writeExcalidraw(d, { previous: 'not json' })).length).toBeGreaterThan(0)
  })
})

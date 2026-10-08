import { describe, expect, it } from 'vitest'
import { parseDot } from '../dot'
import { patchDot } from '../dotPatch'
import { parseMermaid } from '../mermaid'
import { emptyDiagram, upsertNode, addEdge } from '../model'
import { alignIds, canonGroupId, canonId, canonShape, fingerprint, flowDirection, switchDiagramFormat, withDotPositions, type DiagramSources } from '../sync'

/**
 * Format switching at its edges: the same format asked for (exact), a
 * kept text that no longer parses (converted afresh), a comment or a
 * hand edit in DOT surviving a round trip through Mermaid, a rename, a
 * reshaped node, a deleted node and a removed edge reaching a stale
 * Mermaid, a colour change alone forcing a rebuild, renderer positions
 * filling in for unpinned nodes; and dotPatch on chained edges, quoted
 * ids, comments after statements, labels equal to ids, a fill on a node
 * without `filled`, new nodes in and out of groups, undirected graphs,
 * and the layout hint written once. Plus the helpers.
 */
const DOT = `digraph G {\n  // header\n  a [label="Start"];\n  b [label="End", shape=circle];\n  a -> b [label="go"];\n}\n`
const go = (format: 'dot' | 'mermaid' | 'excalidraw', source: string, target: typeof format, sources?: DiagramSources) => switchDiagramFormat({ format, source, sources }, target)

describe('switching', () => {
  it('is exact for the same format, converts afresh when the kept text no longer parses, and does not fail on it', () => {
    const same = go('dot', DOT, 'dot')
    expect(same).toMatchObject({ how: 'exact', source: DOT })
    expect(same.sources.dot).toEqual({ source: DOT, fingerprint: fingerprint(parseDot(DOT)) })
    const first = go('dot', DOT, 'excalidraw')
    expect(first.how).toBe('converted')
    const broken: DiagramSources = { ...first.sources, excalidraw: { source: '{not json', fingerprint: first.sources.excalidraw!.fingerprint } }
    const again = go('dot', DOT, 'excalidraw', broken)
    expect(again.how).toBe('converted')
    expect(JSON.parse(again.source).type).toBe('excalidraw')
  })

  it('keeps a comment and a hand edit in DOT across a trip through Mermaid, and rebuilds Mermaid when DOT changed structure', () => {
    const toMmd = go('dot', DOT, 'mermaid')
    expect(toMmd.how).toBe('converted')
    expect(toMmd.source).toMatch(/Start/)
    // Only a comment changed in DOT: Mermaid is still exact, and DOT comes back as the user left it.
    const commented = DOT.replace('// header', '// my note')
    const mmd2 = go('dot', commented, 'mermaid', toMmd.sources)
    expect(mmd2).toMatchObject({ how: 'exact', source: toMmd.source })
    const backToDot = go('mermaid', mmd2.source, 'dot', mmd2.sources)
    expect(backToDot).toMatchObject({ how: 'exact', source: commented })
    // A rename, a reshape, a removed edge and a removed node in DOT all reach a stale Mermaid.
    const edited = commented.replace('Start', 'Begin').replace('shape=circle', 'shape=diamond').replace('  a -> b [label="go"];\n', '')
    const mmd3 = go('dot', edited, 'mermaid', backToDot.sources)
    expect(mmd3.how).toBe('reconciled')
    const p = parseMermaid(mmd3.source)
    expect(p.nodes.map((n) => [n.id, n.label, canonShape(n.shape)])).toEqual([['a', 'Begin', 'box'], ['b', 'End', 'diamond']])
    expect(p.edges).toEqual([])
    const fewer = edited.replace('  b [label="End", shape=diamond];\n', '')
    const mmd4 = go('dot', fewer, 'mermaid', mmd3.sources)
    expect(mmd4.how).toBe('reconciled')
    expect(parseMermaid(mmd4.source).nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('rebuilds on a colour change alone, but not on a change only one side states', () => {
    const src = DOT.replace('[label="Start"]', '[label="Start", fillcolor="#eef", style=filled]')
    const draw = go('dot', src, 'excalidraw')
    const recoloured = src.replace('#eef', '#fee')
    expect(go('dot', recoloured, 'excalidraw', draw.sources).how).toBe('reconciled')
    const withFont = src.replace('[label="Start"', '[label="Start", fontname=Courier')
    expect(go('dot', withFont, 'excalidraw', draw.sources).how).toBe('exact') // nothing the drawing states differs
  })

  it('takes renderer positions for nodes without a pinned one, and lets pinned ones win', () => {
    const rendered = { width: 500, height: 300, nodes: { a: { x: 10, y: 20, width: 100, height: 50 }, b: { x: 300, y: 20, width: 100, height: 50 } }, edges: {}, groups: {} }
    const pinned = DOT.replace('[label="End", shape=circle]', '[label="End", shape=circle, pos="99,-77!"]')
    const r = switchDiagramFormat({ format: 'dot', source: pinned, rendered }, 'excalidraw')
    const els = JSON.parse(r.source).elements as { id: string; x: number; y: number; width: number }[]
    const a = els.find((e) => e.id === 'a')!
    const b = els.find((e) => e.id === 'b')!
    expect(a.x + a.width / 2).toBeCloseTo(10, 0)
    expect(b.x + b.width / 2).toBeCloseTo(99, 0)
    expect(b.y + 28).toBeCloseTo(77, 0) // default height 56 when the text gives none
  })
})

describe('helpers', () => {
  it('canonicalises shapes, ids and group ids', () => {
    for (const s of ['box', 'RECT', 'rounded', 'note', 'stadium', 'plaintext', undefined, '']) expect(canonShape(s)).toBe('box')
    for (const s of ['ellipse', 'Circle', 'oval', 'doublecircle', 'point']) expect(canonShape(s)).toBe('ellipse')
    for (const s of ['diamond', 'rhombus', 'Mdiamond']) expect(canonShape(s)).toBe('diamond')
    expect(canonShape('hexagon')).toBe('hexagon')
    expect(canonId('a-1')).toBe('n_a_1')
    expect(canonId('9x')).toBe('9x')
    expect(canonId('end')).toBe('end_') // a Mermaid keyword
    expect(canonGroupId('cluster_f1')).toBe('f1')
    expect(canonGroupId('CLUSTERf1')).toBe('f1')
    expect(canonGroupId('f-1')).toBe('n_f_1')
  })

  it('fingerprints structure only, in any order, including groups and direction', () => {
    const a = parseDot('digraph { subgraph cluster_g { label="G"; x } y; x -> y [label=l] }')
    const b = parseDot('digraph { y [color=red]; subgraph cluster_g { label="G"; x [pos="1,2!"] } x -> y [label=l, style=dotted] }')
    expect(fingerprint(a)).toBe(fingerprint(withDotPositions(b)))
    expect(fingerprint(parseDot('graph { x -- y }'))).not.toBe(fingerprint(parseDot('digraph { x -> y }')))
    expect(fingerprint(parseDot('digraph { x -> y }'))).not.toBe(fingerprint(parseDot('digraph { y -> x }')))
    expect(fingerprint(parseDot('digraph { x [shape=box] }'))).toBe(fingerprint(parseDot('digraph { x [shape=rect] }')))
    expect(fingerprint(parseDot('digraph { subgraph cluster_g { label="G"; x } }'))).not.toBe(fingerprint(parseDot('digraph { subgraph cluster_g { label="H"; x } }')))
    expect(fingerprint(emptyDiagram('dot'))).toBe('[[],[],[]]')
  })

  it('reads DOT positions, pinned or not, with sizes in inches or defaults, and leaves a diagram without any untouched', () => {
    const d = parseDot('digraph { a [pos="10,20!", width=2, height=0.5]; b [pos=" -3 , 4 "]; c [pos="x,y"]; d [width=1] }')
    const g = withDotPositions(d).geometry!.nodes
    expect(g.a).toMatchObject({ x: 10, y: -20, width: 144, height: 36, pinned: true })
    expect(g.b).toMatchObject({ x: -3, y: -4, width: 120, height: 56, pinned: true }) // no `!`: read as pinned all the same
    expect(g.c).toBeUndefined()
    expect(g.d).toBeUndefined()
    const none = parseDot('digraph { a }')
    expect(withDotPositions(none)).toBe(none)
  })

  it('aligns ids with a previous rendition, matches edges by ends and label, and remaps geometry', () => {
    const prev = emptyDiagram('excalidraw')
    upsertNode(prev, 'a-1', { label: 'A', group: 'f1' })
    upsertNode(prev, 'b', { label: 'B' })
    prev.groups.push({ id: 'f1', label: 'F', attrs: {} })
    addEdge(prev, { source: 'a-1', target: 'b', directed: true, label: 'l', attrs: {} }) // e1
    addEdge(prev, { source: 'b', target: 'a-1', directed: true, attrs: {} }) // e2
    const cur = emptyDiagram('mermaid')
    upsertNode(cur, 'n_a_1', { label: 'A', group: 'cluster_f1' })
    upsertNode(cur, 'b', { label: 'B' })
    upsertNode(cur, 'c', { label: 'C' })
    cur.groups.push({ id: 'cluster_f1', label: 'F', attrs: {} })
    addEdge(cur, { source: 'n_a_1', target: 'b', directed: true, label: 'l', attrs: {} }) // e1: same id
    addEdge(cur, { source: 'c', target: 'n_a_1', directed: true, attrs: {} }) // e2 by number, but not the same edge
    addEdge(cur, { source: 'b', target: 'n_a_1', directed: true, attrs: {} }) // e3: matches prev e2 by ends
    cur.geometry = { width: 0, height: 0, nodes: { n_a_1: { x: 1, y: 2, width: 3, height: 4 } }, edges: { e3: { points: [] } as never }, groups: { cluster_f1: { x: 0, y: 0, width: 1, height: 1 } as never } }
    const al = alignIds(cur, prev)
    expect(al.nodes.map((n) => [n.id, n.group])).toEqual([['a-1', 'f1'], ['b', undefined], ['c', undefined]])
    expect(al.groups[0].id).toBe('f1')
    expect(al.edges.map((e) => [e.id, e.source, e.target])).toEqual([['e1', 'a-1', 'b'], ['e2', 'c', 'a-1'], ['e2', 'b', 'a-1']])
    expect(Object.keys(al.geometry!.nodes)).toEqual(['a-1'])
    expect(Object.keys(al.geometry!.groups)).toEqual(['f1'])
    expect(Object.keys(al.geometry!.edges)).toEqual(['e2'])
  })

  it('reads the flow from pinned arrows only', () => {
    const d = parseDot('digraph { a [pos="0,0!"]; b [pos="300,10!"]; c [pos="0,-300!"]; d; a -> b; a -> d }')
    expect(flowDirection(withDotPositions(d))).toBe('LR')
    const down = parseDot('digraph { a [pos="0,0!"]; c [pos="0,-300!"]; a -> c }')
    expect(flowDirection(withDotPositions(down))).toBe('TD')
    const square = parseDot('digraph { a [pos="0,0!"]; c [pos="100,-100!"]; a -> c }')
    expect(flowDirection(withDotPositions(square))).toBe('TD') // not wider than tall by a fifth
    expect(flowDirection(parseDot('digraph { a -> b }'))).toBeUndefined()
    expect(flowDirection(withDotPositions(parseDot('digraph { a [pos="0,0!"]; b [pos="9,9!"] }')))).toBeUndefined()
  })
})

describe('patching DOT', () => {
  const patch = (text: string, edit: (d: ReturnType<typeof parseDot>) => void, positions = false) => {
    const previous = withDotPositions(parseDot(text))
    const current = structuredClone(previous)
    edit(current)
    if (positions) current.geometry = { width: 0, height: 0, nodes: Object.fromEntries(current.nodes.map((n, i) => [n.id, { x: 100 * i, y: 50, width: 72, height: 36, pinned: true }])), edges: {}, groups: {} }
    return patchDot(text, current, previous)
  }

  it('gives up on a chained edge that names a removed node, so the caller rewrites instead of leaving the node in the chain, and on a graph written on one line', () => {
    const text = 'digraph {\n  a;\n  b;\n  c;\n  a -> b -> c;\n}'
    expect(patch(text, (d) => { d.nodes = d.nodes.filter((n) => n.id !== 'c'); d.edges = d.edges.filter((e) => e.target !== 'c') })).toBeUndefined()
    // A chain that no change touches is left alone.
    expect(patch(text, (d) => { d.nodes[0].label = 'A' })).toBe(text.replace('a;', 'a [label=A];'))
    // One line: there is nowhere to put a statement, so the caller rewrites.
    expect(patch('digraph { a; b; a -> b; }', (d) => { d.nodes[0].label = 'A' })).toBeUndefined()
  })

  it('edits labels in place keeping attribute order and comments, drops a label equal to the id, quotes what needs it, and adds filled with a fill', () => {
    const text = `digraph {\n  "my node" [color=red, label="Old"]; // keep me\n  b [label=b]; # also\n  c;\n  "my node" -> b;\n}`
    const out = patch(text, (d) => {
      d.nodes.find((n) => n.id === 'my node')!.label = 'New "one"'
      d.nodes.find((n) => n.id === 'b')!.label = 'b'
      const c = d.nodes.find((n) => n.id === 'c')!
      c.label = 'c'
      c.attrs.fillcolor = '#ABC'
    })!
    expect(out.split('\n')[1]).toBe('  "my node" [color=red, label="New \\"one\\""]; // keep me')
    expect(out.split('\n')[2]).toBe('  b [label=b]; # also') // unchanged: the label was already the id
    expect(out.split('\n')[3]).toBe('  c [fillcolor="#ABC", style=filled];')
    expect(out.split('\n')[4]).toBe('  "my node" -> b;')
  })

  it('puts a new node in its group, another before the closing brace, new edges last with their attributes, and undirected edges as --', () => {
    const text = `graph {\n  subgraph cluster_g {\n    label="G";\n    x;\n  }\n  y;\n  x -- y;\n}`
    const out = patch(text, (d) => {
      upsertNode(d, 'z', { label: 'Zed', group: 'cluster_g', shape: 'circle', attrs: { color: '#1e1e1e', fontcolor: 'blue' } })
      upsertNode(d, 'w', { label: 'w' })
      addEdge(d, { source: 'z', target: 'w', directed: false, label: 'link', style: 'dotted', attrs: { color: 'red' } })
    })!
    expect(out).toBe(`graph {\n  subgraph cluster_g {\n    label="G";\n    x;\n    z [label=Zed, shape=circle, fontcolor=blue];\n  }\n  y;\n  x -- y;\n  w;\n  z -- w [label=link, style=dotted, color=red];\n}`)
  })

  it('removes a node with its edge lines and a removed edge alone, and refuses when the edge line cannot be found', () => {
    const text = `digraph {\n  a; b; c;\n  a -> b [label=l];\n  b -> c;\n  a -> c;\n}`
    const out = patch(text, (d) => { d.nodes = d.nodes.filter((n) => n.id !== 'c'); d.edges = d.edges.filter((e) => e.target !== 'c' && e.label !== 'l') })
    expect(out).toBeUndefined() // `a; b; c;` is three statements on a line: c cannot be removed safely
    const lines = text.replace('  a; b; c;', '  a;\n  b;\n  c;')
    const gone = patch(lines, (d) => { d.nodes = d.nodes.filter((n) => n.id !== 'c'); d.edges = d.edges.filter((e) => e.target !== 'c' && e.label !== 'l') })
    expect(gone).toBe(`digraph {\n  a;\n  b;\n}`)
    const twoOnALine = `digraph {\n  a; b;\n  a -> b; b -> a;\n}`
    expect(patch(twoOnALine, (d) => { d.edges = d.edges.filter((e) => e.source !== 'b') })).toBeUndefined()
  })

  it('writes positions and sizes onto every pinned node and the layout hint once', () => {
    const text = `digraph {\n  layout=dot;\n  a;\n  b [label=B];\n  a -> b;\n}`
    const out = patch(text, () => {}, true)!
    expect(out).toBe(`digraph {\n  layout=dot;\n  a [pos="0,-50!", width=1, height=0.5, fixedsize=true];\n  b [label=B, pos="100,-50!", width=1, height=0.5, fixedsize=true];\n  a -> b;\n}`)
    const hinted = patch(`digraph {\n  a;\n}`, () => {}, true)!
    expect(hinted).toBe(`digraph {\n  layout=neato; inputscale=72; overlap=true; splines=true;\n  a [pos="0,-50!", width=1, height=0.5, fixedsize=true];\n}`)
    expect(patch(hinted, () => {}, true)).toBe(hinted)
  })
})

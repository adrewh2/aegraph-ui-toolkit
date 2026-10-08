import { describe, expect, it } from 'vitest'
import { parseExcalidraw, writeExcalidraw } from '../excalidraw'
import { parseDot } from '../dot'
import { fingerprint, switchDiagramFormat, withDotPositions, type DiagramSources } from '../sync'

const DOT = `digraph G {\n  rankdir=LR;\n  a [label="Start", fillcolor="#eef", style=filled];\n  b [label="End"];\n  a -> b [label="go", color="#c00"];\n}\n`

/** A drawing from the DOT, with a freehand stroke and a moved node added by hand — and the sources chain it came with. */
function drawn(): { drawing: string; sources: DiagramSources } {
  const first = switchDiagramFormat({ format: 'dot', source: DOT }, 'excalidraw')
  const file = JSON.parse(first.source) as { elements: Record<string, unknown>[] }
  const a = file.elements.find((e) => e.id === 'a')!
  a.x = 500
  a.y = 300
  a.backgroundColor = '#ffd'
  a.roughness = 2
  file.elements.push({ id: 'scribble', type: 'freedraw', x: 10, y: 10, width: 50, height: 50, points: [[0, 0], [50, 50]], isDeleted: false, strokeColor: '#000' })
  return { drawing: JSON.stringify(file), sources: first.sources }
}

describe('switching formats without loss', () => {
  it('comes back to the drawing exactly when nothing changed in between', () => {
    const { drawing, sources } = drawn()
    const toDot = switchDiagramFormat({ format: 'excalidraw', source: drawing, sources }, 'dot')
    expect(toDot.how).toBe('reconciled')
    // Element x=500 with the writer's width 96 for "Start" → centre 548; DOT's y points up.
    expect(toDot.source).toMatch(/a \[.*pos="548,-?\d+(\.\d+)?!"/)
    expect(toDot.source).toMatch(/layout=neato/)
    const back = switchDiagramFormat({ format: 'dot', source: toDot.source, sources: toDot.sources }, 'excalidraw')
    expect(back.how).toBe('exact')
    expect(back.source).toBe(drawing)
  })

  it('carries a position edited in DOT into the drawing, keeping its styling and scribbles', () => {
    const { drawing, sources } = drawn()
    const toDot = switchDiagramFormat({ format: 'excalidraw', source: drawing, sources }, 'dot')
    const moved = toDot.source.replace(/pos="548,(-?[\d.]+)!"/, 'pos="900,$1!"')
    expect(moved).not.toBe(toDot.source)
    const back = switchDiagramFormat({ format: 'dot', source: moved, sources: toDot.sources }, 'excalidraw')
    expect(back.how).toBe('reconciled')
    const file = JSON.parse(back.source) as { elements: Record<string, unknown>[] }
    const a = file.elements.find((e) => e.id === 'a')!
    expect(a.x).toBeCloseTo(900 - (a.width as number) / 2, 0)
    expect(a.backgroundColor).toBe('#ffd')
    expect(a.roughness).toBe(2)
    expect(file.elements.some((e) => e.id === 'scribble')).toBe(true)
  })

  it('keeps DOT-only attributes when the drawing changes structure, and drops removed nodes', () => {
    const { drawing, sources } = drawn()
    const toDot = switchDiagramFormat({ format: 'excalidraw', source: drawing, sources }, 'dot')
    // Add a node in the drawing, then go to DOT again: the edge colour DOT had survives, the new node appears.
    const file = JSON.parse(drawing) as { elements: Record<string, unknown>[] }
    file.elements.push({ id: 'c', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, isDeleted: false, boundElements: [], strokeColor: '#000', backgroundColor: 'transparent' })
    const again = switchDiagramFormat({ format: 'excalidraw', source: JSON.stringify(file), sources: toDot.sources }, 'dot')
    expect(again.how).toBe('reconciled')
    expect(again.source).toMatch(/color="#c00"/)
    expect(again.source).toMatch(/\bc \[/)
    const parsed = withDotPositions(parseDot(again.source))
    expect(parsed.geometry?.nodes.c?.pinned).toBe(true)
  })

  it('round-trips through Mermaid, which has no positions, and returns to the identical drawing', () => {
    const { drawing, sources } = drawn()
    const toMmd = switchDiagramFormat({ format: 'excalidraw', source: drawing, sources }, 'mermaid')
    expect(toMmd.source).toMatch(/flowchart/)
    const back = switchDiagramFormat({ format: 'mermaid', source: toMmd.source, sources: toMmd.sources }, 'excalidraw')
    expect(back.how).toBe('exact')
    expect(back.source).toBe(drawing)
    // Relabel in Mermaid: the drawing keeps its positions and styling, gets the new label.
    const relabelled = toMmd.source.replace('Start', 'Begin')
    const merged = switchDiagramFormat({ format: 'mermaid', source: relabelled, sources: toMmd.sources }, 'excalidraw')
    expect(merged.how).toBe('reconciled')
    const p = parseExcalidraw(merged.source)
    expect(p.nodes.find((n) => n.id === 'a')?.label).toBe('Begin')
    expect(p.geometry?.nodes.a.x).toBeCloseTo(500 + (JSON.parse(drawing).elements.find((e: { id: string }) => e.id === 'a').width as number) / 2, 0)
    expect(JSON.parse(merged.source).elements.some((e: { id: string }) => e.id === 'scribble')).toBe(true)
  })

  it('fingerprints ignore positions and styling', () => {
    const a = parseDot(DOT)
    const b = parseDot(DOT.replace('fillcolor="#eef"', 'fillcolor="#fee", pos="1,2!"'))
    expect(fingerprint(a)).toBe(fingerprint(withDotPositions(b)))
    void writeExcalidraw
  })
})

describe('DOT keeps its formatting', () => {
  const SRC = `digraph knowledge {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#f5f4f0", fontname="Helvetica"];

  subgraph cluster_people {
    label="People";
    plato [label="Plato"];
    aristotle [label="Aristotle"];
  }
  subgraph cluster_works {
    label="Major works";
    republic [label="Republic", shape=note];  // a note
  }

  plato -> aristotle [label="taught"];
  plato -> republic [label="wrote"];
  aristotle -> plato [label="disagrees with", style=dashed];
}
`
  it('is edited in place when the drawing moves, adds and removes things', () => {
    const draw = switchDiagramFormat({ format: 'dot', source: SRC }, 'excalidraw')
    const file = JSON.parse(draw.source) as { elements: Record<string, unknown>[] }
    const plato = file.elements.find((e) => e.id === 'plato')!
    plato.x = 400
    plato.y = 40
    // Remove the "wrote" arrow, add a node in the works cluster and an arrow to it.
    file.elements = file.elements.filter((e) => e.id !== 'e2' && (e as { containerId?: string }).containerId !== 'e2')
    file.elements.push({ id: 'poetics', type: 'rectangle', x: 700, y: 300, width: 120, height: 50, isDeleted: false, frameId: 'cluster_works', boundElements: [{ id: 'poetics_t', type: 'text' }], strokeColor: '#000', backgroundColor: 'transparent' })
    file.elements.push({ id: 'poetics_t', type: 'text', x: 710, y: 310, width: 100, height: 20, isDeleted: false, containerId: 'poetics', text: 'Poetics', originalText: 'Poetics', fontSize: 16 })
    file.elements.push({ id: 'e_new', type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]], isDeleted: false, startBinding: { elementId: 'aristotle' }, endBinding: { elementId: 'poetics' }, endArrowhead: 'arrow', strokeColor: '#000' })
    const back = switchDiagramFormat({ format: 'excalidraw', source: JSON.stringify(file), sources: draw.sources }, 'dot')
    expect(back.how).toBe('reconciled')
    const s = back.source
    // The user's text is still theirs.
    expect(s).toMatch(/^digraph knowledge \{/)
    expect(s).toMatch(/rankdir=LR;/)
    expect(s).toMatch(/node \[shape=box, style="rounded,filled", fillcolor="#f5f4f0", fontname="Helvetica"\];/)
    expect(s).toMatch(/republic \[label="Republic", shape=note, pos=/)
    expect(s).toMatch(/\/\/ a note/)
    expect(s).toMatch(/layout=neato; inputscale=72/)
    // Plato moved; a "wrote" arrow is gone; Poetics is in its cluster and linked.
    expect(s).toMatch(/plato \[label="Plato", pos="4\d\d,-\d+!"/)
    expect(s).not.toMatch(/plato -> republic/)
    expect(s).toMatch(/republic \[[^\n]*\n\s+poetics \[label=Poetics[^\n]*\];\n\s*\}/)
    expect(s).toMatch(/aristotle -> poetics;/)
    expect(s).toMatch(/aristotle -> plato \[label="disagrees with", style=dashed\];/)
  })
})

describe('ids as the canvas makes them', () => {
  const drawing = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [
      { id: 'Ab-c1_x', type: 'rectangle', x: 100, y: 100, width: 160, height: 60, isDeleted: false, backgroundColor: '#ffd8a8', boundElements: [{ id: 't1', type: 'text' }] },
      { id: 't1', type: 'text', x: 130, y: 120, width: 100, height: 20, text: 'Ingest', originalText: 'Ingest', fontSize: 16, containerId: 'Ab-c1_x', isDeleted: false },
      { id: '9Zq-r', type: 'ellipse', x: 450, y: 320, width: 180, height: 90, isDeleted: false, boundElements: [{ id: 't3', type: 'text' }] },
      { id: 't3', type: 'text', x: 500, y: 355, width: 80, height: 20, text: 'Store', originalText: 'Store', fontSize: 16, containerId: '9Zq-r', isDeleted: false },
      { id: 'a-1', type: 'arrow', x: 260, y: 130, width: 190, height: 200, points: [[0, 0], [190, 200]], startBinding: { elementId: 'Ab-c1_x' }, endBinding: { elementId: '9Zq-r' }, endArrowhead: 'arrow', isDeleted: false, strokeColor: '#c92a2a' },
    ],
    appState: {},
    files: {},
  })
  it('come back identical through every route between the three formats', () => {
    let src = drawing
    let sources: DiagramSources | undefined
    let fmt: 'dot' | 'mermaid' | 'excalidraw' = 'excalidraw'
    const go = (t: typeof fmt) => {
      const r = switchDiagramFormat({ format: fmt, source: src, sources }, t)
      src = r.source
      sources = r.sources
      fmt = t
      return r.how
    }
    expect([go('mermaid'), go('excalidraw')]).toEqual(['converted', 'exact'])
    expect(src).toBe(drawing)
    expect([go('dot'), go('mermaid'), go('excalidraw')]).toEqual(['converted', 'exact', 'exact'])
    expect(src).toBe(drawing)
    expect([go('mermaid'), go('dot'), go('excalidraw')]).toEqual(['exact', 'exact', 'exact'])
    expect(src).toBe(drawing)
  })
  it('a label edited in Mermaid reaches the drawing with everything else kept', () => {
    const mmd = switchDiagramFormat({ format: 'excalidraw', source: drawing }, 'mermaid')
    const back = switchDiagramFormat({ format: 'mermaid', source: mmd.source.replace('Ingest', 'Intake'), sources: mmd.sources }, 'excalidraw')
    expect(back.how).toBe('reconciled')
    const els = JSON.parse(back.source).elements as Record<string, unknown>[]
    expect(els.map((e) => e.id)).toEqual(['Ab-c1_x', 't1', '9Zq-r', 't3', 'a-1'])
    expect(els.find((e) => e.id === 't1')?.text).toBe('Intake')
    expect(els.find((e) => e.id === 'Ab-c1_x')?.backgroundColor).toBe('#ffd8a8')
    expect(els.find((e) => e.id === 'a-1')?.strokeColor).toBe('#c92a2a')
  })
})

describe('style and structure edits in text reach the drawing', () => {
  it('a fill changed in DOT recolours the element; a removed node takes its label with it; frames stay the user\'s', () => {
    const drawing = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [
        { id: 'f1', type: 'frame', x: 0, y: 0, width: 900, height: 500, name: 'Area', isDeleted: false },
        { id: 'n1', type: 'rectangle', x: 100, y: 100, width: 160, height: 60, backgroundColor: '#ffd8a8', strokeColor: '#1e1e1e', isDeleted: false, frameId: 'f1', boundElements: [{ id: 't1', type: 'text' }] },
        { id: 't1', type: 'text', x: 130, y: 120, width: 100, height: 20, text: 'One', originalText: 'One', fontSize: 16, containerId: 'n1', isDeleted: false, frameId: 'f1' },
        { id: 'n2', type: 'rectangle', x: 400, y: 100, width: 160, height: 60, backgroundColor: 'transparent', strokeColor: '#1e1e1e', isDeleted: false, frameId: 'f1', boundElements: [{ id: 't2', type: 'text' }] },
        { id: 't2', type: 'text', x: 430, y: 120, width: 100, height: 20, text: 'Two', originalText: 'Two', fontSize: 16, containerId: 'n2', isDeleted: false, frameId: 'f1' },
        { id: 'a1', type: 'arrow', x: 260, y: 130, width: 140, height: 0, points: [[0, 0], [140, 0]], startBinding: { elementId: 'n1' }, endBinding: { elementId: 'n2' }, endArrowhead: 'arrow', isDeleted: false },
      ],
      appState: {},
      files: {},
    })
    const dot = switchDiagramFormat({ format: 'excalidraw', source: drawing }, 'dot')
    const edited = dot.source
      .replace('fillcolor="#ffd8a8"', 'fillcolor="#c3fae8"')
      .split('\n')
      .filter((l) => !/^\s*n2 \[/.test(l) && !/n1 -> n2/.test(l))
      .join('\n')
    const back = switchDiagramFormat({ format: 'dot', source: edited, sources: dot.sources }, 'excalidraw')
    expect(back.how).toBe('reconciled')
    const els = JSON.parse(back.source).elements as Record<string, unknown>[]
    expect(els.find((e) => e.id === 'n1')?.backgroundColor).toBe('#c3fae8')
    expect(els.map((e) => e.id)).toEqual(['f1', 'n1', 't1'])
    expect(els.find((e) => e.id === 'f1')?.width).toBe(900)
  })
})

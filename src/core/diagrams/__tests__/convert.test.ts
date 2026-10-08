import { describe, expect, it } from 'vitest'
import { autoLayout, parseDiagram, writeDiagram } from '../index'

const PIPELINE = `digraph pipeline {
  rankdir=LR;
  subgraph cluster_source { label="Sources"; workspace [label="Workspace", shape=cylinder, fillcolor="#e0f2fe", color="#0284c7", style="filled"]; project [label="Project\\n(exported view)", shape=cylinder]; }
  subgraph cluster_stages { label="Stages"; style="rounded"; dataset [style="filled,rounded", fillcolor="#dbeafe"]; filter; style [label="Style"]; end [label="End"]; }
  subgraph cluster_inputs { label="Inputs"; values [label="Values\\ndata.* · metric.*", shape=note]; }
  workspace -> dataset [label="loads"];
  project -> dataset [label="loads"];
  dataset -> filter -> style -> end [penwidth=2, color="#374151"];
  values -> filter [label="predicates", style=dashed];
  end -> project [label="creates", color="#0f766e"];
}`

describe('DOT → Mermaid → DOT', () => {
  const d = parseDiagram(PIPELINE, 'dot')
  const mm = writeDiagram(d, 'mermaid')
  const back = parseDiagram(mm, 'mermaid')

  it('renames ids Mermaid reserves and keeps their labels', () => {
    expect(mm).toContain('style_["Style"]')
    expect(mm).toContain('end_["End"]')
    expect(mm).not.toMatch(/^\s+end\[/m)
    expect(back.nodes.find((n) => n.id === 'style_')?.label).toBe('Style')
  })

  it('writes multi-line labels as <br/> on one line and reads them back', () => {
    expect(mm).toContain('"Project<br/>(exported view)"')
    expect(mm.split('\n').every((l) => !/^\s*\(exported/.test(l))).toBe(true)
    expect(back.nodes.find((n) => n.id === 'project')?.label).toBe('Project\n(exported view)')
    expect(back.warnings).toEqual([])
  })

  it('keeps structure, groups, colours and dashes', () => {
    expect(back.nodes).toHaveLength(d.nodes.length)
    expect(back.edges).toHaveLength(d.edges.length)
    expect(back.groups.map((g) => g.label)).toEqual(['Sources', 'Stages', 'Inputs'])
    expect(back.nodes.find((n) => n.id === 'workspace')).toMatchObject({ group: 'cluster_source', shape: 'cylinder', attrs: { fillcolor: '#e0f2fe', color: '#0284c7' } })
    expect(back.nodes.find((n) => n.id === 'dataset')?.shape).toBe('rounded')
    expect(mm).toContain('linkStyle 2 stroke:#374151,stroke-width:2px')
    const dashed = back.edges.find((e) => e.source === 'values')
    expect(dashed?.style).toBe('dotted')
    expect(back.edges.find((e) => e.label === 'creates')?.attrs.color).toBe('#0f766e')
  })

  it('writes valid DOT again: rounded boxes, filled fills', () => {
    const dot = writeDiagram(back, 'dot')
    expect(dot).toMatch(/dataset \[[^\]]*shape=box[^\]]*\]/)
    expect(dot).toMatch(/dataset \[[^\]]*style="?[^"\]]*rounded[^"\]]*filled|dataset \[[^\]]*style="?[^"\]]*filled[^"\]]*rounded/)
    expect(dot).not.toContain('shape=rounded')
    const again = parseDiagram(dot, 'dot')
    expect(again.nodes).toHaveLength(d.nodes.length)
    expect(again.edges).toHaveLength(d.edges.length)
  })
})

describe('DOT → Excalidraw', () => {
  const d = parseDiagram(PIPELINE, 'dot')
  const ex = writeDiagram(d, 'excalidraw')
  const file = JSON.parse(ex) as { elements: { type: string; id: string; frameId?: string | null; name?: string; roundness?: unknown; backgroundColor?: string; strokeStyle?: string; text?: string }[] }
  const back = parseDiagram(ex, 'excalidraw')

  it('writes a frame per group with members inside it', () => {
    const frames = file.elements.filter((e) => e.type === 'frame')
    expect(frames.map((f) => f.name)).toEqual(['Sources', 'Stages', 'Inputs'])
    expect(file.elements.find((e) => e.id === 'workspace')?.frameId).toBe('cluster_source')
    expect(back.groups).toHaveLength(3)
    expect(back.nodes.map((n) => `${n.id}:${n.group}`)).toContain('dataset:cluster_stages')
  })

  it('carries fills, rounded corners, dashes and multi-line text', () => {
    expect(file.elements.find((e) => e.id === 'dataset')).toMatchObject({ backgroundColor: '#dbeafe', roundness: { type: 3 } })
    expect(file.elements.find((e) => e.id === 'workspace')?.roundness).toBeNull()
    expect(file.elements.find((e) => e.type === 'arrow' && e.id === d.edges.find((x) => x.source === 'values')!.id)?.strokeStyle).toBe('dashed')
    expect(file.elements.some((e) => e.type === 'text' && e.text === 'Project\n(exported view)')).toBe(true)
    expect(back.edges).toHaveLength(d.edges.length)
  })

  it('lays groups out in bands that never overlap', () => {
    const g = autoLayout(d)
    const boxes = Object.values(g.groups)
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `groups ${i} and ${j} overlap`).toBe(false)
      }
    // A loop back into an earlier group does not drag its target downstream: Sources stay at the left.
    expect(g.nodes.project.x).toBeLessThan(g.nodes.dataset.x)
    for (const n of d.nodes) {
      const box = g.groups[n.group!]
      const p = g.nodes[n.id]
      expect(p.x).toBeGreaterThan(box.x)
      expect(p.x).toBeLessThan(box.x + box.width)
      expect(p.y).toBeGreaterThan(box.y)
      expect(p.y).toBeLessThan(box.y + box.height)
    }
  })
})

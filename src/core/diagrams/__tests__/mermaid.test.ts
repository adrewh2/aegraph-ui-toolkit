import { describe, expect, it } from 'vitest'
import { mermaidKind, parseMermaid, writeMermaid } from '../mermaid'
import { parseDot } from '../dot'

describe('mermaid flowchart', () => {
  const src = `%% comment
flowchart LR
  subgraph people [Thinkers]
    plato[Plato]:::ancient
    aristotle(Aristotle)
  end
  republic{{"The Republic"}}
  plato -->|taught| aristotle
  plato -- wrote --> republic
  aristotle -.-> ethics[(Ethics)]
  a & b ==> c
  d --- e
  classDef ancient fill:#eee
  class aristotle ancient
`
  const d = parseMermaid(src)

  it('detects kind and direction', () => {
    expect(mermaidKind(src)).toBe('flowchart')
    expect(d.kind).toBe('flowchart')
    expect(d.attrs.direction).toBe('LR')
    expect(d.warnings).toEqual([])
  })

  it('reads nodes with shapes, labels, classes, and subgraphs', () => {
    expect(d.nodes.find((n) => n.id === 'plato')).toMatchObject({ label: 'Plato', shape: 'box', group: 'people', classes: ['ancient'] })
    expect(d.nodes.find((n) => n.id === 'aristotle')).toMatchObject({ label: 'Aristotle', shape: 'rounded', classes: ['ancient'] })
    expect(d.nodes.find((n) => n.id === 'republic')).toMatchObject({ label: 'The Republic', shape: 'hexagon' })
    expect(d.nodes.find((n) => n.id === 'ethics')).toMatchObject({ label: 'Ethics', shape: 'cylinder' })
    expect(d.nodes.find((n) => n.id === 'plato')!.attrs['classDef:ancient']).toBe('fill:#eee')
    expect(d.groups).toEqual([{ id: 'people', label: 'Thinkers', parent: undefined, attrs: {} }])
  })

  it('reads edges with labels, styles, and fan-in', () => {
    expect(d.edges.find((e) => e.source === 'plato' && e.target === 'aristotle')).toMatchObject({ label: 'taught', directed: true, style: 'solid' })
    expect(d.edges.find((e) => e.target === 'republic')!.label).toBe('wrote')
    expect(d.edges.find((e) => e.target === 'ethics')!.style).toBe('dotted')
    expect(d.edges.filter((e) => e.target === 'c').map((e) => e.source).sort()).toEqual(['a', 'b'])
    expect(d.edges.find((e) => e.target === 'c')!.style).toBe('thick')
    expect(d.edges.find((e) => e.source === 'd')!.directed).toBe(false)
  })

  it('writes a flowchart that parses back', () => {
    const out = writeMermaid(d)
    const again = parseMermaid(out)
    expect(again.nodes.map((n) => n.id).sort()).toEqual(d.nodes.map((n) => n.id).sort())
    expect(again.edges.length).toBe(d.edges.length)
    expect(again.groups[0].label).toBe('Thinkers')
    expect(out).toContain('flowchart LR')
  })

  it('converts DOT to Mermaid', () => {
    const dot = parseDot('digraph { rankdir=LR; a [label="A node", shape=ellipse]; a -> b [label="to"]; }')
    const mm = writeMermaid(dot)
    expect(mm).toContain('flowchart LR')
    expect(mm).toContain('a(("A node"))')
    expect(mm).toContain('a -->|"to"| b')
  })
})

describe('other mermaid kinds', () => {
  it('classDiagram', () => {
    const d = parseMermaid(`classDiagram
  class Animal {
    +String name
    +speak()
  }
  Animal <|-- Dog
  Dog "1" *-- "many" Leg : has
  Animal ..> Food : eats
  <<interface>> Food
`)
    expect(d.kind).toBe('classDiagram')
    const animal = d.nodes.find((n) => n.id === 'Animal')!
    expect(animal.attrs.attributes).toBe('+String name')
    expect(animal.attrs.methods).toBe('+speak()')
    expect(d.edges.find((e) => e.style === 'inheritance')).toMatchObject({ source: 'Dog', target: 'Animal' })
    expect(d.edges.find((e) => e.style === 'composition')).toMatchObject({ source: 'Dog', target: 'Leg', label: 'has', attrs: { sourceCardinality: '1', targetCardinality: 'many' } })
    expect(d.edges.find((e) => e.style === 'dependency')).toMatchObject({ source: 'Animal', target: 'Food', label: 'eats' })
    expect(d.nodes.find((n) => n.id === 'Food')!.classes).toEqual(['interface'])
  })

  it('erDiagram', () => {
    const d = parseMermaid(`erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER {
    int id PK
    string status
  }
`)
    expect(d.kind).toBe('erDiagram')
    expect(d.edges[0]).toMatchObject({ source: 'CUSTOMER', target: 'ORDER', label: 'places', attrs: { sourceCardinality: 'exactly one', targetCardinality: 'zero or more' } })
    expect(d.nodes.find((n) => n.id === 'ORDER')!.attrs.attributes).toBe('int id PK\nstring status')
  })

  it('stateDiagram', () => {
    const d = parseMermaid(`stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  state Running {
    Warm --> Hot
  }
  Running --> [*]
`)
    expect(d.kind).toBe('stateDiagram')
    expect(d.edges.find((e) => e.label === 'start')).toMatchObject({ source: 'Idle', target: 'Running' })
    expect(d.nodes.find((n) => n.id === 'Warm')!.group).toBe('Running')
    expect(d.groups[0].id).toBe('Running')
  })

  it('mindmap', () => {
    const d = parseMermaid(`mindmap
  root((Aegraph))
    Model
      Entities
      Relationships
    Views
`)
    expect(d.kind).toBe('mindmap')
    expect(d.nodes.map((n) => n.label)).toEqual(['Aegraph', 'Model', 'Entities', 'Relationships', 'Views'])
    expect(d.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['root>Model', 'Model>Entities', 'Model>Relationships', 'root>Views'])
  })

  it('unknown', () => {
    expect(parseMermaid('pie\n "a": 1').warnings.length).toBe(1)
  })
})

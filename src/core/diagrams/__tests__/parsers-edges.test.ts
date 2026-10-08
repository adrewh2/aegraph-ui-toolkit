import { describe, expect, it } from 'vitest'
import { parseDot, writeDot } from '../dot'
import { mermaidKind, mmId, parseMermaid, writeMermaid } from '../mermaid'

/**
 * The DOT and Mermaid parsers at their edges. DOT: strict and a quoted
 * name, ids quoted, numeric, hyphenated and concatenated, escapes and
 * `\N`, defaults applying only to nodes declared after them and scoped
 * to their block, a node declared in two clusters, non-cluster and
 * anonymous subgraphs, nested clusters, edge groups on both ends and a
 * subgraph as an endpoint, ports, attribute lists in every spelling,
 * every comment kind including a `#` not at line start, an unterminated
 * graph and string, trailing content, and what the writer round-trips.
 * Mermaid: every shape bracket and the `@{}` form, quoted labels with
 * brackets and entities, fan-out on both sides, chains with mixed
 * arrows, every arrow kind and both label spellings, subgraphs by title
 * and nested, `end`, class/classDef/style/linkStyle, direction lines,
 * front matter and directives, numeric ids, the other diagram kinds at
 * their edges, the writer's ids, labels and shapes, and an unknown kind.
 */
const ids = (d: { nodes: { id: string }[] }) => d.nodes.map((n) => n.id)
const edges = (d: { edges: { source: string; target: string }[] }) => d.edges.map((e) => `${e.source}>${e.target}`)

describe('DOT parser edges', () => {
  it('reads strict, a quoted name, every id spelling, escapes, concatenation and \\N', () => {
    const d = parseDot(`strict digraph "My Graph" {\n  "a \\"b\\"" -> 1.5 -> -2 -> foo-bar;\n  "x" + "y" [label="line\\nbreak\\lend"];\n  n [label="\\N"];\n  e [label=""];\n}`)
    expect(d.kind).toBe('digraph')
    expect(d.attrs.name).toBe('My Graph')
    expect(ids(d)).toEqual(['a "b"', '1.5', '-2', 'foo-bar', 'xy', 'n', 'e'])
    expect(d.nodes.find((n) => n.id === 'xy')?.label).toBe('line\nbreak\nend')
    expect(d.nodes.find((n) => n.id === 'n')?.label).toBe('n')
    expect(d.nodes.find((n) => n.id === 'e')?.label).toBe('')
    expect(edges(d)).toEqual(['a "b">1.5', '1.5>-2', '-2>foo-bar'])
    expect(d.warnings).toEqual([])
  })

  it('applies node and edge defaults to what comes after, scoped to the block, and never to a node already seen', () => {
    const d = parseDot(`digraph {\n  early;\n  node [shape=circle, color=red];\n  edge [style=dotted];\n  mid;\n  subgraph cluster_c { node [shape=box]; inner; early [label=E]; }\n  late -> early;\n}`)
    const at = (id: string) => d.nodes.find((n) => n.id === id)!
    expect(at('early')).toMatchObject({ label: 'E', attrs: {} })
    expect(at('early').shape).toBeUndefined()
    expect(at('early').group).toBeUndefined() // first seen outside: stays outside
    expect(at('mid')).toMatchObject({ shape: 'circle', attrs: { color: 'red' } })
    expect(at('inner')).toMatchObject({ shape: 'box', group: 'cluster_c', attrs: { color: 'red' } }) // inner override, outer colour
    expect(at('late')).toMatchObject({ shape: 'circle' }) // the cluster's default did not leak
    expect(d.edges[0]).toMatchObject({ source: 'late', target: 'early', style: 'dotted' })
  })

  it('reads non-cluster and anonymous subgraphs as no group, nested clusters with parents, edge groups on both ends, a subgraph endpoint and ports', () => {
    const d = parseDot(`digraph {\n  subgraph plain { p }\n  { q }\n  subgraph cluster_outer { label=Outer; subgraph cluster_inner { i } o }\n  { a b } -> { c d } [label=fan];\n  x -> subgraph cluster_s { s1 s2 };\n  a:p:n -> b:s [label=ports];\n}`)
    expect(d.nodes.find((n) => n.id === 'p')?.group).toBeUndefined()
    expect(d.nodes.find((n) => n.id === 'q')?.group).toBeUndefined()
    expect(d.groups.map((g) => [g.id, g.label, g.parent])).toEqual([['cluster_inner', 'inner', 'cluster_outer'], ['cluster_outer', 'Outer', undefined], ['cluster_s', 's', undefined]])
    expect(d.nodes.find((n) => n.id === 'i')?.group).toBe('cluster_inner')
    expect(d.nodes.find((n) => n.id === 'o')?.group).toBe('cluster_outer')
    expect(edges(d).sort()).toEqual(['a>b', 'a>c', 'a>d', 'b>c', 'b>d', 'x>s1', 'x>s2'])
    expect(d.edges.filter((e) => e.label === 'fan')).toHaveLength(4)
    expect(d.edges.find((e) => e.label === 'ports')).toMatchObject({ source: 'a', target: 'b' })
    expect(d.nodes.find((n) => n.id === 's1')?.group).toBe('cluster_s')
  })

  it('reads attribute lists in every spelling, graph attributes with and without brackets, and classes on nodes and edges', () => {
    const d = parseDot(`digraph {\n  graph [rankdir=TB, bgcolor="#fff"];\n  label="Title";\n  a [x=1; y=2] [flag] [];\n  b [class="p  q"] ;\n  a -> b [class=link, weight=2]\n}`)
    expect(d.attrs).toEqual({ rankdir: 'TB', bgcolor: '#fff', label: 'Title' })
    expect(d.nodes[0].attrs).toEqual({ x: '1', y: '2', flag: 'true' })
    expect(d.nodes[1].classes).toEqual(['p', 'q'])
    expect(d.edges[0].attrs).toEqual({ weight: '2', class: 'link' })
    expect(d.warnings).toEqual([])
  })

  it('strips every comment kind, but a # not at the start of a line is junk it skips with a line number; an unterminated graph or string still yields what it has', () => {
    const d = parseDot(`# top\ndigraph { // one\n  /* two\n  lines */ a -> b; # three\n  c\n}\ntrailing`)
    expect(edges(d)).toEqual(['a>b'])
    expect(ids(d)).toEqual(['a', 'b', 'three', 'c']) // the words after a mid-line # read as nodes
    expect(d.warnings).toEqual(['line 4: skipped unexpected token "#"', 'line 7: trailing content after the graph body was ignored'])
    const open = parseDot('digraph { a -> b')
    expect(edges(open)).toEqual(['a>b'])
    expect(open.warnings).toEqual([])
    const str = parseDot('digraph { a [label="unterminated] }')
    expect(str.nodes[0].label).toBe('unterminated] }')
    expect(parseDot('{ a }')).toMatchObject({ kind: 'digraph', warnings: ['expected "graph" or "digraph" at the start; assuming digraph'] })
    expect(parseDot('digraph G a -> b }').warnings[0]).toMatch(/expected "\{"/)
    expect(parseDot('').warnings).toHaveLength(2)
  })

  it('writes ids that need quoting, labels with quotes and newlines, undirected graphs, shapes from other formats, and reads them back', () => {
    const d = parseDot(`graph { "my node" [label="say \\"hi\\"\\nnow", shape=stadium, fillcolor="#eee"]; 1 -- "my node" [label=l]; x [shape=trapezoid] }`)
    const out = writeDot(d)
    expect(out).toContain('graph G {')
    expect(out).toContain('"my node" [fillcolor="#eee", label="say \\"hi\\"\\nnow", shape=box, style="rounded,filled"];') // attributes first, then what the writer derives
    expect(out).toContain('1 -- "my node" [label=l];')
    expect(out).toContain('x [shape=trapezium];')
    const back = parseDot(out)
    expect(back.nodes.find((n) => n.id === 'my node')?.label).toBe('say "hi"\nnow')
    expect(back.edges[0]).toMatchObject({ source: '1', target: 'my node', directed: false })
    expect(writeDot(d, { directed: true, name: 'N N', rankdir: 'LR' })).toMatch(/^digraph "N N" \{\n  rankdir=LR;/)
    // A previous rendition lends its attributes, never the derived ones.
    const prev = parseDot('digraph { a [color=red, label=Old, pos="1,2!"]; a -> b [color=blue] }')
    const cur = parseDot('digraph { a [label=New]; a -> b }')
    const lent = writeDot(cur, { previous: prev })
    expect(lent).toContain('a [color=red, label=New];')
    expect(lent).toContain('a -> b [color=blue];')
  })
})

describe('Mermaid flowchart edges', () => {
  it('reads every shape bracket and the @{} form', () => {
    const d = parseMermaid(`flowchart TD\n a[box]\n b(rounded)\n c([stadium])\n d[[sub]]\n e[(db)]\n f((circle))\n g>flag]\n h{diamond}\n i{{hex}}\n j[/para/]\n k[\\alt\\]\n l[/trap\\]\n m[\\trapalt/]\n n(((double)))\n o@{ shape: cyl, label: "At" }\n p`)
    expect(d.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ['a', 'box', 'box'], ['b', 'rounded', 'rounded'], ['c', 'stadium', 'stadium'], ['d', 'subroutine', 'sub'], ['e', 'cylinder', 'db'], ['f', 'circle', 'circle'], ['g', 'asymmetric', 'flag'], ['h', 'diamond', 'diamond'], ['i', 'hexagon', 'hex'],
      ['j', 'parallelogram', 'para'], ['k', 'parallelogram-alt', 'alt'], ['l', 'trapezoid', 'trap'], ['m', 'trapezoid-alt', 'trapalt'], ['n', 'double-circle', 'double'], ['o', 'cyl', 'At'], ['p', undefined, 'p'],
    ])
    expect(d.warnings).toEqual([])
  })

  it('reads quoted labels with brackets, quotes and line breaks, keeps other entities, and takes numeric ids', () => {
    const d = parseMermaid(`graph LR\n a["with [brackets] and (parens)"]\n b["say #quot;hi#quot;<br/>now"]\n c["&amp; kept"]\n 1 --> 2`)
    expect(d.nodes.find((n) => n.id === 'a')?.label).toBe('with [brackets] and (parens)')
    expect(d.nodes.find((n) => n.id === 'b')?.label).toBe('say "hi"\nnow')
    expect(d.nodes.find((n) => n.id === 'c')?.label).toBe('&amp; kept')
    expect(edges(d)).toEqual(['1>2'])
    expect(d.attrs.direction).toBe('LR')
    expect(d.warnings).toEqual([])
  })

  it('fans out on both sides, chains with mixed arrows, and reads every arrow kind with labels in both spellings', () => {
    const d = parseMermaid(`flowchart TD\n a & b --> c & d\n e --> f -.-> g ==> h\n i --- j\n k -.- l\n m === n\n o --o p\n q --x r\n s <--> t\n u -- text --> v\n w -->|piped| x\n y -. dotted text .-> z\n aa == thick text ==> bb;`)
    expect(edges(d).slice(0, 4).sort()).toEqual(['a>c', 'a>d', 'b>c', 'b>d'])
    expect(d.edges.slice(4, 7).map((e) => [e.source, e.target, e.style])).toEqual([['e', 'f', 'solid'], ['f', 'g', 'dotted'], ['g', 'h', 'thick']])
    const by = (s: string) => d.edges.find((e) => e.source === s)!
    expect(by('i')).toMatchObject({ directed: false, style: 'solid' })
    expect(by('k')).toMatchObject({ directed: false, style: 'dotted' })
    expect(by('m')).toMatchObject({ directed: false, style: 'thick' })
    expect(by('o')).toMatchObject({ directed: true, style: 'solid circle' })
    expect(by('q')).toMatchObject({ directed: true, style: 'solid cross' })
    expect(by('s')).toMatchObject({ directed: true })
    expect(by('u')).toMatchObject({ label: 'text', directed: true })
    expect(by('w')).toMatchObject({ label: 'piped' })
    expect(by('y')).toMatchObject({ label: 'dotted text', style: 'dotted' })
    expect(by('aa')).toMatchObject({ label: 'thick text', style: 'thick', target: 'bb' })
    expect(d.warnings).toEqual([])
  })

  it('reads subgraphs by id and title or title alone, nested with parents, direction lines, classes, styles and link styles', () => {
    const d = parseMermaid(`---\ntitle: T\n---\n%%{init: {"theme":"dark"}}%%\nflowchart\n subgraph one [First]\n  direction LR\n  a\n  subgraph Two words\n   b\n  end\n end\n c:::x\n class a,b y\n classDef x,y fill:#f00\n style c fill:#0f0,stroke:#333,stroke-width:2px,stroke-dasharray:5\n a --> b\n linkStyle 0 stroke:#00f\n click a href "x"`)
    expect(d.attrs.direction).toBeUndefined()
    expect(d.groups.map((g) => [g.id, g.label, g.parent])).toEqual([['one', 'First', undefined], ['Two words', 'Two words', 'one']])
    expect(d.nodes.map((n) => [n.id, n.group, n.classes])).toEqual([['a', 'one', ['y']], ['b', 'Two words', ['y']], ['c', undefined, ['x']]])
    expect(d.nodes.find((n) => n.id === 'c')?.attrs).toEqual({ 'classDef:x': 'fill:#f00', fillcolor: '#0f0', color: '#333', penwidth: '2', style: 'dashed' })
    expect(d.nodes.find((n) => n.id === 'a')?.attrs).toEqual({ 'classDef:y': 'fill:#f00' })
    expect(d.edges[0].attrs).toEqual({ color: '#00f' })
    expect(d.warnings).toEqual([])
    expect(mermaidKind('---\nx: 1\n---\n%% c\n  GRAPH TD')).toBe('flowchart')
  })

  it('warns once for a line it cannot read and keeps going', () => {
    const d = parseMermaid(`flowchart TD\n a --> b\n --> nothing\n c`)
    expect(edges(d)).toEqual(['a>b'])
    expect(ids(d)).toEqual(['a', 'b', 'c'])
    expect(d.warnings).toEqual(['could not parse: --> nothing'])
  })

  it('writes ids Mermaid can read, labels with quotes, breaks and nothing, every shape, styles and link styles, and reads back the same structure', () => {
    const dot = parseDot(`digraph { rankdir=LR; "a-1" [label="say \\"hi\\"\\nnow", shape=ellipse, fillcolor="#eee", color=red]; end [label="", shape=diamond, style=rounded]; "a-1" -> end [label=go, style=dashed, color=blue]; end -> end [style=bold]; x -- y }`)
    const mm = writeMermaid(dot)
    expect(mm).toContain('flowchart LR')
    expect(mm).toContain('n_a_1(("say #quot;hi#quot;<br/>now"))')
    expect(mm).toContain('end_{" "}')
    expect(mm).toContain('n_a_1 -.->|"go"| end_')
    expect(mm).toContain('end_ ==> end_')
    expect(mm).toContain('style n_a_1 fill:#eee,stroke:red')
    expect(mm).toContain('linkStyle 0 stroke:blue')
    expect(mmId('class')).toBe('class_')
    expect(mmId('ok_1')).toBe('ok_1')
    const back = parseMermaid(mm)
    expect(back.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([['n_a_1', 'circle', 'say "hi"\nnow'], ['end_', 'diamond', ' '], ['x', 'box', 'x'], ['y', 'box', 'y']])
    expect(back.edges.map((e) => [e.source, e.target, e.style, e.directed, e.label])).toEqual([['n_a_1', 'end_', 'dotted', true, 'go'], ['end_', 'end_', 'thick', true, undefined], ['x', 'y', 'solid', true, undefined]])
    expect(back.warnings).toEqual([])
    const rounded = writeMermaid(parseDot('digraph { a [style="rounded,filled"] }'))
    expect(rounded).toContain('a("a")')
  })
})

describe('other Mermaid kinds at their edges', () => {
  it('classDiagram: labelled classes, every arrow direction, namespaces, and a line it cannot read', () => {
    const d = parseMermaid(`classDiagram\n class A["Label A"]\n A --> B\n C <-- A\n A -- D\n A .. E\n F o-- A\n A --* G\n <<enum>> A\n namespace N {\n }\n what is this`)
    expect(d.nodes.find((n) => n.id === 'A')).toMatchObject({ label: 'Label A', shape: 'class', classes: ['enum'] })
    expect(d.edges.map((e) => [e.source, e.target, e.style])).toEqual([['A', 'B', 'association'], ['A', 'C', 'association'], ['A', 'D', 'link'], ['A', 'E', 'dashed link'], ['F', 'A', 'aggregation'], ['G', 'A', 'composition']])
    expect(d.groups.map((g) => g.id)).toEqual(['N'])
    expect(d.warnings).toEqual(['could not parse: what is this'])
  })

  it('erDiagram: quoted names, every cardinality, a non-identifying link, and an entity alias', () => {
    const d = parseMermaid(`erDiagram\n "Order Line" }|..|| PRODUCT : refers\n A |o--o{ B : has\n C ["The C"] {\n  int id\n }`)
    expect(d.edges[0]).toMatchObject({ source: 'Order Line', target: 'PRODUCT', style: 'non-identifying', attrs: { sourceCardinality: 'one or more', targetCardinality: 'exactly one' } })
    expect(d.edges[1]).toMatchObject({ style: 'identifying', attrs: { sourceCardinality: 'zero or one', targetCardinality: 'zero or more' } })
    expect(d.nodes.find((n) => n.id === 'C')).toMatchObject({ label: 'The C', attrs: { attributes: 'int id' } })
  })

  it('stateDiagram: aliases, descriptions, start and end inside a composite, annotations, and notes ignored', () => {
    const d = parseMermaid(`stateDiagram-v2\n state "Long name" as L\n S : described\n state Comp {\n  [*] --> In\n  In --> [*]\n }\n state Ch <<choice>>\n L --> Comp : go\n note right of L\n  hi\n end note`)
    expect(d.nodes.find((n) => n.id === 'L')).toMatchObject({ label: 'Long name', shape: 'state' })
    expect(d.nodes.find((n) => n.id === 'S')).toMatchObject({ label: 'described' })
    expect(d.nodes.find((n) => n.id === 'Comp.[*]')).toMatchObject({ shape: 'terminal', group: 'Comp' })
    expect(d.nodes.find((n) => n.id === 'Ch')?.shape).toBe('choice')
    expect(edges(d)).toEqual(['Comp.[*]>In', 'In>Comp.[*]', 'L>Comp'])
    expect(d.warnings).toEqual(['could not parse: hi'])
  })

  it('mindmap: shapes, icons, classes, a repeated label, and depth by indentation', () => {
    const d = parseMermaid(`mindmap\n  root((Root))\n    A[Box]\n      ::icon(fa fa-book)\n    B(Round):::cls\n      A[Box]\n    Plain text here\n  Second root`)
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([['root', 'Root', 'circle'], ['A', 'Box', 'box'], ['B', 'Round', 'rounded'], ['A_1', 'Box', 'box'], ['Plain_text_here', 'Plain text here', undefined], ['Second_root', 'Second root', undefined]])
    expect(d.nodes.find((n) => n.id === 'A')?.attrs).toEqual({ icon: 'fa fa-book' }) // the icon line decorates the node above
    expect(d.nodes.find((n) => n.id === 'B')?.classes).toEqual(['cls'])
    expect(edges(d)).toEqual(['root>A', 'root>B', 'B>A_1', 'root>Plain_text_here'])
  })

  it('sequenceDiagram: participants with aliases and messages of both kinds; an unknown kind warns and imports nothing', () => {
    const d = parseMermaid(`sequenceDiagram\n participant A as Alice\n actor B\n A->>B: hi\n B-->>A: back\n A-xB: lost`)
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([['A', 'Alice', 'participant'], ['B', 'B', 'actor']])
    expect(d.edges.map((e) => [e.source, e.target, e.label, e.style])).toEqual([['A', 'B', 'hi', 'solid'], ['B', 'A', 'back', 'dotted'], ['A', 'B', 'lost', 'solid']])
    expect(d.warnings).toEqual(['Sequence diagrams import participants and messages only.'])
    expect(parseMermaid('gantt\n title x')).toMatchObject({ kind: 'unknown', nodes: [], warnings: ['Unrecognised Mermaid diagram type; nothing imported.'] })
    expect(parseMermaid('')).toMatchObject({ kind: 'unknown' })
  })
})

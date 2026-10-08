import { EMPTY_SCENE } from '../../diagram-editor'
import { createEntity } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity } from '../../core/entity/types'
import { detectDiagramFormat, parseDiagram, writeExcalidraw, type DiagramFormat, type ParsedDiagram } from '../../core/diagrams'
import { RESOURCE_TYPES, type DiagramData } from '../../core/resources/types'

export type DiagramEntity = Entity<DiagramData>

export const isDiagram = (e: AnyEntity | undefined): e is DiagramEntity => !!e && !isRelationship(e) && e.type === RESOURCE_TYPES.diagram && typeof e.data.source === 'string'
export const allDiagrams = (store: EntityStore): DiagramEntity[] => store.ofType(RESOURCE_TYPES.diagram).filter(isDiagram)

export function createDiagram(store: EntityStore, init: { label: string; source: string; format?: DiagramFormat; tags?: string[]; source_?: string }): DiagramEntity {
  const format = init.format ?? detectDiagramFormat(init.source)
  const parsed = safeParse(init.source, format)
  const e = createEntity<DiagramData>({
    type: RESOURCE_TYPES.diagram,
    label: init.label,
    tags: init.tags,
    data: { format, source: init.source, kind: parsed?.kind },
    meta: { source: init.source_ ?? 'user' },
  })
  store.upsert(e)
  return e
}

export function safeParse(source: string, format: DiagramFormat): ParsedDiagram | undefined {
  try {
    return parseDiagram(source, format)
  } catch {
    return undefined
  }
}

export const TEMPLATES: { id: string; label: string; format: DiagramFormat; source: string }[] = [
  { id: 'canvas-blank', label: 'Blank canvas (draw)', format: 'excalidraw', source: EMPTY_SCENE },
  {
    id: 'dot-basic',
    label: 'Graphviz: knowledge sketch',
    format: 'dot',
    source: `digraph knowledge {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#f5f4f0", fontname="Helvetica"];

  subgraph cluster_people {
    label="People";
    plato [label="Plato"];
    aristotle [label="Aristotle"];
  }
  subgraph cluster_works {
    label="Major works";
    republic [label="Republic", shape=note];
    ethics [label="Nicomachean Ethics", shape=note];
  }

  plato -> aristotle [label="taught"];
  plato -> republic [label="wrote"];
  aristotle -> ethics [label="wrote"];
  aristotle -> plato [label="disagrees with", style=dashed];
}
`,
  },
  {
    id: 'mmd-flow',
    label: 'Mermaid: flowchart',
    format: 'mermaid',
    source: `flowchart LR
  subgraph people [People]
    plato[Plato]
    aristotle[Aristotle]
  end
  subgraph works [Major works]
    republic[(Republic)]
  end
  plato -->|taught| aristotle
  plato -->|wrote| republic
  aristotle -. disagrees with .-> plato
`,
  },
  {
    id: 'mmd-class',
    label: 'Mermaid: class diagram',
    format: 'mermaid',
    source: `classDiagram
  class Entity {
    +String id
    +String type
    +String[] tags
  }
  class Relationship {
    +Ref source
    +Ref target
  }
  Entity <|-- Relationship : is an
  Relationship "1" --> "1" Entity : source
  Relationship "1" --> "1" Entity : target
`,
  },
  {
    id: 'mmd-er',
    label: 'Mermaid: ER diagram',
    format: 'mermaid',
    source: `erDiagram
  AUTHOR ||--o{ BOOK : wrote
  BOOK }o--|| PUBLISHER : "published by"
  BOOK {
    string title
    int year
  }
`,
  },
  {
    id: 'mmd-mindmap',
    label: 'Mermaid: mindmap',
    format: 'mermaid',
    source: `mindmap
  root((Aegraph))
    Model
      Entities
      Relationships
      Tags
    Views
      Table
      Graph
      Documents
`,
  },
  {
    id: 'excalidraw-sketch',
    label: 'Excalidraw: whiteboard sketch',
    format: 'excalidraw',
    source: writeExcalidraw({
      format: 'excalidraw',
      kind: 'excalidraw',
      attrs: {},
      warnings: [],
      groups: [{ id: 'frame-ideas', label: 'Ideas', attrs: {} }],
      nodes: [
        { id: 'question', label: 'Question', shape: 'box', group: 'frame-ideas', classes: [], attrs: {} },
        { id: 'hypothesis', label: 'Hypothesis', shape: 'ellipse', group: 'frame-ideas', classes: [], attrs: {} },
        { id: 'evidence', label: 'Evidence', shape: 'box', classes: [], attrs: {} },
        { id: 'decision', label: 'Decision', shape: 'diamond', classes: [], attrs: {} },
      ],
      edges: [
        { id: 'a1', source: 'question', target: 'hypothesis', label: 'suggests', directed: true, attrs: {} },
        { id: 'a2', source: 'hypothesis', target: 'evidence', label: 'needs', directed: true, attrs: {} },
        { id: 'a3', source: 'evidence', target: 'decision', directed: true, attrs: {} },
      ],
      geometry: {
        width: 900,
        height: 420,
        nodes: {
          question: { x: 160, y: 120, width: 180, height: 64, shape: 'rounded', fill: '#fff3bf', stroke: '#1e1e1e' },
          hypothesis: { x: 460, y: 120, width: 200, height: 90, shape: 'ellipse', fill: '#d0ebff', stroke: '#1971c2' },
          evidence: { x: 460, y: 300, width: 180, height: 64, shape: 'rounded', fill: '#d3f9d8', stroke: '#2f9e44' },
          decision: { x: 760, y: 300, width: 160, height: 120, shape: 'diamond', fill: '#ffe8cc', stroke: '#e8590c' },
        },
        edges: {},
        groups: { 'frame-ideas': { x: 40, y: 40, width: 560, height: 160 } },
      },
    }),
  }
]

export const DIAGRAM_ACCEPT = '.dot,.gv,.mmd,.mermaid,.excalidraw,.txt,.json,text/plain,application/json'

/** Import a `.dot` / `.gv`, `.mmd` / `.mermaid` or `.excalidraw` file; the format comes from the extension, or is sniffed (`.txt`, `.json`). */
export async function importDiagramFile(store: EntityStore, file: File): Promise<DiagramEntity> {
  const text = await file.text()
  const ext = file.name.split('.').pop()?.toLowerCase()
  const format: DiagramFormat = ext === 'dot' || ext === 'gv' ? 'dot' : ext === 'mmd' || ext === 'mermaid' ? 'mermaid' : ext === 'excalidraw' ? 'excalidraw' : detectDiagramFormat(text)
  return createDiagram(store, { label: file.name.replace(/\.[^.]+$/, ''), source: text, format, source_: 'import:file' })
}

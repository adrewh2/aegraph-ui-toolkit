import { parseDot, writeDot, type DotWriteOptions } from './dot'
import { mermaidKind, parseMermaid, writeMermaid, type MermaidWriteOptions } from './mermaid'
import { isExcalidraw, parseExcalidraw, writeExcalidraw } from './excalidraw'
import type { DiagramFormat, ParsedDiagram } from './model'
import type { AnyEntity, Relationship } from '../entity/types'
import type { TypeRegistry } from '../entity/typeRegistry'
import { displayLabel } from '../entity/entity'

export * from './model'
export * from './dot'
export * from './mermaid'
export * from './mapping'
export * from './geometry'
export * from './excalidraw'
export * from './extract'
export * from './layout'
export * from './sync'

/** Guess the format from the text itself. */
export function detectDiagramFormat(src: string): DiagramFormat {
  if (/^\s*\{/.test(src)) {
    try {
      if (isExcalidraw(JSON.parse(src))) return 'excalidraw'
    } catch {
      /* not JSON */
    }
  }
  const head = src.replace(/^\s*(\/\/[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/|%%[^\n]*\n|---[\s\S]*?---\s*)*/, '').trimStart().slice(0, 40).toLowerCase()
  if (/^(strict\s+)?(di)?graph\b[^{]*\{/.test(head)) return 'dot'
  if (mermaidKind(src) !== 'unknown') return 'mermaid'
  return /\{/.test(src) && /(->|--)/.test(src) ? 'dot' : 'mermaid'
}

export const DIAGRAM_EXTENSIONS: Record<string, DiagramFormat> = { dot: 'dot', gv: 'dot', mmd: 'mermaid', mermaid: 'mermaid', excalidraw: 'excalidraw' }

export function parseDiagram(src: string, format: DiagramFormat): ParsedDiagram {
  return format === 'dot' ? parseDot(src) : format === 'excalidraw' ? parseExcalidraw(src) : parseMermaid(src)
}

export function writeDiagram(d: ParsedDiagram, format: DiagramFormat, opts: DotWriteOptions & MermaidWriteOptions = {}): string {
  return format === 'dot' ? writeDot(d, opts) : format === 'excalidraw' ? writeExcalidraw(d) : writeMermaid(d, opts)
}

/**
 * Entities + relationships → a diagram. Types become groups (clusters /
 * subgraphs) so the ontology survives the round trip; type colors ride
 * along as `fillcolor` / classDefs.
 */
export function diagramFromEntities(nodes: AnyEntity[], edges: Relationship[], registry: TypeRegistry, opts: { groupByType?: boolean; name?: string } = {}): ParsedDiagram {
  const groupByType = opts.groupByType ?? true
  const d: ParsedDiagram = { format: 'dot', kind: 'digraph', attrs: { name: opts.name ?? 'aegraph', rankdir: 'LR' }, nodes: [], edges: [], groups: [], warnings: [] }
  const types = new Set(nodes.map((n) => n.type))
  for (const t of types) {
    const def = registry.get(t)
    if (groupByType) d.groups.push({ id: `cluster_${slug(t)}`, label: def.pluralLabel, attrs: def.color ? { color: def.color } : {} })
  }
  for (const n of nodes) {
    const def = registry.get(n.type)
    d.nodes.push({
      id: n.id,
      label: displayLabel(n),
      shape: def.category === 'resource' ? 'note' : 'box',
      group: groupByType ? `cluster_${slug(n.type)}` : undefined,
      classes: [slug(n.type)],
      attrs: { ...(def.color ? { fillcolor: def.color, style: 'filled' } : {}), ...(n.tags.length ? { tooltip: n.tags.join(', ') } : {}) },
    })
  }
  const ids = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!ids.has(e.source.id) || !ids.has(e.target.id)) continue
    d.edges.push({ id: e.id, source: e.source.id, target: e.target.id, label: e.type, directed: e.directed, attrs: {} })
  }
  return d
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

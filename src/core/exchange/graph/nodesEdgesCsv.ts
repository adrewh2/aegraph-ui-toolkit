import { displayLabel } from '../../entity/entity'
import { CsvParser, csvEscape, restoreCell } from '../formats'
import { attributeKeys, isUnsafeKey, type ExportFile, type GEdge, type GNode, type GraphExportInput, type ParsedGraph } from './model'

/**
 * Gephi's two-file CSV: nodes.csv (Id, Label, …) and edges.csv (Source,
 * Target, Type, Id, Label, Weight, …). Column names are matched
 * case-insensitively; unknown columns become attributes.
 */
export function parseCsvTable(text: string): { header: string[]; rows: string[][] } {
  const p = new CsvParser()
  const rows: string[][] = []
  // A cell written with a `'` in front so a spreadsheet would not run it (`defuseCell`) reads back as it was.
  const add = (r: string[]) => rows.push(r.map(restoreCell))
  p.push(text, add)
  p.end(add)
  const header = (rows.shift() ?? []).map((h) => h.trim())
  return { header, rows }
}

const pick = (lower: string[], row: string[], names: string[]): string | undefined => {
  for (const n of names) {
    const i = lower.indexOf(n)
    if (i >= 0 && row[i] !== undefined && row[i] !== '') return row[i]
  }
  return undefined
}
const num = (s: string): number | undefined => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined)
const coerce = (s: string): unknown => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s)

export async function parseNodesEdgesCsv(nodesText: string, edgesText?: string): Promise<ParsedGraph> {
  const warnings: string[] = []
  const nt = parseCsvTable(nodesText)
  const lowerN = nt.header.map((h) => h.toLowerCase())
  const idCol = ['id', 'name', 'node'].map((n) => lowerN.indexOf(n)).find((i) => i >= 0) ?? 0
  const nodes: GNode[] = nt.rows.map((row, r) => {
    const id = row[idCol] || `n${r}`
    const attrs: Record<string, unknown> = {}
    const viz: NonNullable<GNode['viz']> = {}
    let label: string | undefined
    nt.header.forEach((h, i) => {
      const v = row[i]
      if (i === idCol || v === undefined || v === '') return
      const k = h.toLowerCase()
      if (k === 'label') label = v
      else if (k === 'x' || k === 'y' || k === 'z' || k === 'size') {
        const n = num(v)
        if (n !== undefined) (viz as Record<string, number>)[k] = n
      }
      else if (k === 'color' || k === 'colour') viz.color = v
      else if (!isUnsafeKey(h)) attrs[h] = coerce(v)
    })
    return { id, label, attrs, viz: Object.keys(viz).length ? viz : undefined }
  })
  const edges: GEdge[] = []
  if (edgesText) {
    const et = parseCsvTable(edgesText)
    const lower = et.header.map((h) => h.toLowerCase())
    if (!lower.includes('source') || !lower.includes('target')) throw new Error('edges.csv needs Source and Target columns.')
    for (const row of et.rows) {
      const source = pick(lower, row, ['source'])
      const target = pick(lower, row, ['target'])
      if (!source || !target) {
        warnings.push('Skipped an edge row without source/target.')
        continue
      }
      const attrs: Record<string, unknown> = {}
      let directed: boolean | undefined
      let label: string | undefined
      let weight: number | undefined
      let id: string | undefined
      et.header.forEach((h, i) => {
        const v = row[i]
        if (v === undefined || v === '') return
        const k = h.toLowerCase()
        if (k === 'source' || k === 'target') return
        if (k === 'type') directed = v.toLowerCase() !== 'undirected'
        else if (k === 'id') id = v
        else if (k === 'label') label = v
        else if (k === 'weight') weight = num(v)
        else if (!isUnsafeKey(h)) attrs[h] = coerce(v)
      })
      edges.push({ id, source, target, directed, label, weight, attrs })
    }
  }
  return { nodes, edges, directedDefault: true, attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings }
}

export async function writeNodesEdgesCsv(input: GraphExportInput): Promise<ExportFile[]> {
  const ids = new Set(input.nodes.map((n) => n.id))
  const nodeKeys = attributeKeys(input.nodes.map((n) => ({ attrs: n.data }))).filter((k) => !['id', 'label', 'type', 'tags', 'x', 'y', 'size', 'color'].includes(k.toLowerCase()))
  const edgeKeys = attributeKeys(input.edges.map((e) => ({ attrs: e.data }))).filter((k) => !['source', 'target', 'type', 'id', 'label', 'weight', 'relationshiptype'].includes(k.toLowerCase()))
  const cell = (v: unknown) => csvEscape(v === undefined || v === null ? '' : Array.isArray(v) ? v.join(';') : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const nodeHeader = ['Id', 'Label', 'Type', 'Tags', ...(input.positions ? ['X', 'Y'] : []), ...(input.styles ? ['Color', 'Size'] : []), ...nodeKeys]
  const nodeLines = input.nodes.map((n) => {
    const p = input.positions?.[n.id]
    const st = input.styles?.nodes.get(n.id)
    return [n.id, displayLabel(n), n.type, n.tags.join(';'), ...(input.positions ? [p?.x ?? '', p?.y ?? ''] : []), ...(input.styles ? [st?.color ?? '', st?.size ?? ''] : []), ...nodeKeys.map((k) => n.data[k])].map(cell).join(',')
  })
  const edgeHeader = ['Source', 'Target', 'Type', 'Id', 'Label', 'Weight', 'RelationshipType', 'Tags', ...edgeKeys]
  const edgeLines = input.edges.filter((e) => ids.has(e.source.id) && ids.has(e.target.id)).map((e) => [e.source.id, e.target.id, e.directed ? 'Directed' : 'Undirected', e.id, e.label ?? e.type, typeof e.data.weight === 'number' ? e.data.weight : 1, e.type, e.tags.join(';'), ...edgeKeys.map((k) => e.data[k])].map(cell).join(','))
  const base = input.name ?? 'graph'
  return [
    { name: `${base}-nodes.csv`, text: [nodeHeader.join(','), ...nodeLines].join('\n') + '\n', mime: 'text/csv' },
    { name: `${base}-edges.csv`, text: [edgeHeader.join(','), ...edgeLines].join('\n') + '\n', mime: 'text/csv' },
  ]
}

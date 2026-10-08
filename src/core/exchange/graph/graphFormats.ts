import { checkGraphBytes, checkGraphShape } from './limits'
import type { ExportFile, GraphExportInput, ParsedGraph } from './model'

/**
 * Registry of graph interchange formats. Each entry lazy-loads its module,
 * so the explorer's export menu and the Datasets importer pay only for the
 * formats they use. aegraph's own json/jsonl/csv live in ../formats.ts.
 */
export type GraphFormatId = 'gexf' | 'graphml' | 'cyjs' | 'nodes_edges_csv' | 'rdf' | 'parquet' | 'node_link_json'

/** A file handed to a parser: its text, or for a binary format (`binary`) its bytes. */
export interface GraphFile {
  name: string
  text: string
  bytes?: ArrayBuffer
}

export interface GraphFormat {
  id: GraphFormatId
  label: string
  extensions: string[]
  mime: string
  /** How many files the format is made of. */
  files: 1 | 2
  canImport: boolean
  canExport: boolean
  /** Read as bytes, not text (Parquet): the parser gets `bytes` and an empty `text`. */
  binary?: boolean
  parse: (files: GraphFile[]) => Promise<ParsedGraph>
  write: (input: GraphExportInput) => Promise<ExportFile[]>
}

/**
 * A parser behind the graph file bounds (`limits.ts › GRAPH_FILE_LIMITS`): each file's size before it is parsed, the
 * nodes and edges it became after. Every format in the registry is read through this, whoever reads it.
 */
const bounded =
  (parse: (files: GraphFile[]) => Promise<ParsedGraph>) =>
  async (files: GraphFile[]): Promise<ParsedGraph> => {
    for (const f of files) checkGraphBytes(f.name, f.bytes?.byteLength ?? f.text.length)
    const g = await parse(files)
    checkGraphShape(files[0]?.name ?? 'The file', g)
    return g
  }

const isNodesFile = (name: string) => /node/i.test(name)
const isEdgesFile = (name: string) => /edge|link|rel/i.test(name)

export const GRAPH_FORMATS: GraphFormat[] = [
  {
    id: 'gexf',
    label: 'GEXF (Gephi)',
    extensions: ['gexf'],
    mime: 'application/gexf+xml',
    files: 1,
    canImport: true,
    canExport: true,
    parse: bounded(async ([f]) => (await import('./gexf')).parseGexf(f.text)),
    write: async (input) => (await import('./gexf')).writeGexf(input),
  },
  {
    id: 'graphml',
    label: 'GraphML',
    extensions: ['graphml', 'xml'],
    mime: 'application/graphml+xml',
    files: 1,
    canImport: true,
    canExport: true,
    parse: bounded(async ([f]) => (await import('./graphml')).parseGraphml(f.text)),
    write: async (input) => (await import('./graphml')).writeGraphml(input),
  },
  {
    id: 'cyjs',
    label: 'Cytoscape JSON',
    extensions: ['cyjs'],
    mime: 'application/json',
    files: 1,
    canImport: true,
    canExport: true,
    parse: bounded(async ([f]) => (await import('./cyjs')).parseCyjs(f.text)),
    write: async (input) => (await import('./cyjs')).writeCyjs(input),
  },
  {
    // Named, never guessed from `.json` alone, which is aegraph's own document: `import_graph` tells them apart by
    // what the file holds (`isNodeLink`).
    id: 'node_link_json',
    label: 'Node-link JSON (d3, NetworkX)',
    extensions: [],
    mime: 'application/json',
    files: 1,
    canImport: true,
    canExport: false,
    parse: bounded(async ([f]) => (await import('./nodeLink')).parseNodeLink(f.text)),
    write: async () => {
      throw new Error('Node-link JSON export is not supported')
    },
  },
  {
    id: 'rdf',
    label: 'RDF (N-Triples, Turtle — DBpedia, Wikidata)',
    extensions: ['nt', 'ntriples', 'ttl', 'nq', 'trig', 'n3'],
    mime: 'text/turtle',
    files: 1,
    canImport: true,
    canExport: false,
    parse: bounded(async ([f]) => {
      const m = await import('./rdf')
      return m.parseRdf(f.text, { format: m.rdfFormatFor(f.name) })
    }),
    write: async () => {
      throw new Error('RDF export is not supported')
    },
  },
  {
    id: 'nodes_edges_csv',
    label: 'Nodes + edges CSV (Gephi)',
    extensions: ['csv'],
    mime: 'text/csv',
    files: 2,
    canImport: true,
    canExport: true,
    parse: bounded(async (files) => {
      const nodes = files.find((f) => isNodesFile(f.name)) ?? files[0]
      const edges = files.find((f) => f !== nodes && (isEdgesFile(f.name) || files.length === 2))
      return (await import('./nodesEdgesCsv')).parseNodesEdgesCsv(nodes.text, edges?.text)
    }),
    write: async (input) => (await import('./nodesEdgesCsv')).writeNodesEdgesCsv(input),
  },
  {
    id: 'parquet',
    label: 'Parquet (points, + links)',
    extensions: ['parquet'],
    mime: 'application/vnd.apache.parquet',
    files: 1,
    canImport: true,
    canExport: false,
    binary: true,
    parse: bounded(async (files) => {
      // One table of points, or a points table and a links table (named so: nodes/points, edges/links).
      const edgesFile = files.length === 2 ? (files.find((f) => isEdgesFile(f.name)) ?? files[1]) : undefined
      const nodesFile = files.find((f) => f !== edgesFile) ?? files[0]
      if (!nodesFile.bytes) throw new Error('Parquet is read as bytes.')
      return (await import('./parquet')).parseParquetGraph(nodesFile.bytes, edgesFile?.bytes)
    }),
    write: async () => {
      throw new Error('Parquet export is not supported')
    },
  },
]

export const graphFormat = (id: GraphFormatId): GraphFormat => GRAPH_FORMATS.find((f) => f.id === id)!
export const isGraphFormatId = (id: unknown): id is GraphFormatId => GRAPH_FORMATS.some((f) => f.id === id)

const ext = (name: string) => name.toLowerCase().replace(/\.gz$/, '').split('.').pop() ?? ''

/** The single-file format for a filename (plain .csv is not claimed: aegraph's own CSV takes it unless paired). */
export function findGraphFormat(filename: string): GraphFormat | undefined {
  const e = ext(filename)
  return GRAPH_FORMATS.find((f) => f.files === 1 && f.extensions.includes(e))
}

/** Match a dropped file set to a graph format: one recognised file, or a nodes/edges CSV pair. */
export function matchGraphImport(files: { name: string }[]): { format: GraphFormat; files: { name: string }[] } | undefined {
  if (files.length === 1) {
    const f = findGraphFormat(files[0].name)
    return f ? { format: f, files } : undefined
  }
  const parquets = files.filter((f) => ext(f.name) === 'parquet')
  if (parquets.length === 2) return { format: graphFormat('parquet'), files: parquets }
  const csvs = files.filter((f) => ext(f.name) === 'csv')
  if (csvs.length === 2 && (csvs.some((f) => isNodesFile(f.name)) || csvs.some((f) => isEdgesFile(f.name)))) return { format: graphFormat('nodes_edges_csv'), files: csvs }
  return undefined
}

/** Accept string for file inputs. */
export const GRAPH_IMPORT_ACCEPT = '.gexf,.graphml,.cyjs,.nt,.ntriples,.ttl,.nq,.trig,.n3,.parquet'

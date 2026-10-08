import { parquetMetadata } from 'hyparquet'
import { DatasetTooLargeError, type DatasetFileLimits } from '../../datasets/files'
import { readParquetRows } from '../../datasets/parquet'
import { GRAPH_FILE_LIMITS, GraphTooLargeError, type GraphFileLimits } from './limits'
import { attributeKeys, isUnsafeKey, type GEdge, type GNode, type ParsedGraph } from './model'

/**
 * Apache Parquet as a graph: a table of points (one row a node) and, optionally, a table of links (one row an edge)
 * — how Cosmograph, graph notebooks and most data tools ship a large graph. Read with hyparquet (pure JavaScript, no
 * WebAssembly, in a tab and in Node alike), which decodes Snappy and uncompressed files; a file compressed otherwise
 * (ZSTD, GZIP, Brotli, LZ4) is refused with the codec named.
 *
 * Columns are matched by name, case-insensitively, like the Gephi CSV pair: the node's id (`id`, `node`, `key`,
 * `name`), its label (`label`, `title`, `name`), its position and look (`x`, `y`, `z`, `size`, `color`); an edge's
 * `source` / `target` (or `from` / `to`, `src` / `dst`), `label`, `weight`. Every other column becomes an attribute,
 * which the import mapping can turn into the type (a `cluster` column, say), tags or the description. A point table
 * with no id column gets row numbers.
 *
 * A file is read whole into memory (it is in memory already, fetched or dropped), but only the columns asked for are
 * decoded — a 100,000-row table's abstracts can be left out with `columns`. Both tables go through the datasets'
 * bounded reader (`datasets/parquet.ts › readParquetRows`: every page header checked before a page is decoded, every
 * page's decompression and the cells' text counted) within `GRAPH_FILE_LIMITS` — points against `nodes`, links
 * against `edges`.
 */

export interface ParquetGraphOptions {
  /** Only these point columns (the id, label and position columns are read whatever this says). */
  columns?: string[]
  /** At most this many point rows. */
  limit?: number
  idColumn?: string
  labelColumn?: string
  sourceColumn?: string
  targetColumn?: string
  /** Fit the positions to a spread that suits the number of points (default true); false keeps them as written. */
  rescale?: boolean
  limits?: GraphFileLimits
}

/**
 * How wide a set of `n` points is laid out: about 40 units a point along a side, from 800 to 20,000. Data tools write
 * positions in whatever units their projection gave (Cosmograph's run 0–12 and it rescales them itself); aegraph's
 * layouts are in screen-sized units, and 100,000 points in a 12-unit square are a dot.
 */
export const spreadFor = (n: number) => Math.min(20_000, Math.max(800, Math.sqrt(n) * 40))

/** Scale and centre the nodes' x/y (z with them) to `spreadFor`; returns the factor, or undefined with nothing to scale. */
export function rescalePositions(nodes: GNode[]): number | undefined {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0
  for (const v of nodes) {
    if (v.viz?.x === undefined || v.viz.y === undefined) continue
    n++
    if (v.viz.x < minX) minX = v.viz.x
    if (v.viz.x > maxX) maxX = v.viz.x
    if (v.viz.y < minY) minY = v.viz.y
    if (v.viz.y > maxY) maxY = v.viz.y
  }
  const extent = Math.max(maxX - minX, maxY - minY)
  if (!n || !(extent > 0)) return undefined
  const k = spreadFor(n) / extent
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (const v of nodes) {
    if (!v.viz) continue
    if (v.viz.x !== undefined) v.viz.x = (v.viz.x - cx) * k
    if (v.viz.y !== undefined) v.viz.y = (v.viz.y - cy) * k
    if (v.viz.z !== undefined) v.viz.z *= k
  }
  return k
}

const ID = ['id', 'node', 'key', 'name']
const LABEL = ['label', 'title', 'name']
const SOURCE = ['source', 'src', 'from', 'start']
const TARGET = ['target', 'tgt', 'to', 'dst', 'end']
const VIZ = new Set(['x', 'y', 'z', 'size', 'color', 'colour'])

/** Whether bytes are a Parquet file: `PAR1` at both ends. */
export function isParquet(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false
  const d = new Uint8Array(bytes)
  const par1 = (at: number) => d[at] === 0x50 && d[at + 1] === 0x41 && d[at + 2] === 0x52 && d[at + 3] === 0x31
  return par1(0) && par1(d.length - 4)
}

/** A cell as the entity store can keep it: numbers, strings, booleans, plain lists and objects of those. */
export function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString()
  if (v instanceof Uint8Array) return undefined
  if (Array.isArray(v)) return v.map(cellValue)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== '__proto__' && k !== 'prototype' && k !== 'constructor') out[k] = cellValue(x)
    return out
  }
  return v
}

interface Table {
  columns: string[]
  /** Each row by column name; the object has no prototype, so a column called `__proto__` is just a column. */
  rows: Record<string, unknown>[]
  total: number
}

async function readTable(bytes: ArrayBuffer, what: string, rows: number, graphLimits: GraphFileLimits, keep?: (columns: string[]) => string[] | undefined, limit?: number): Promise<Table> {
  if (!isParquet(bytes)) throw new Error(`The ${what} file is not Parquet (no PAR1 marker).`)
  const meta = parquetMetadata(bytes)
  const codecs = new Set(meta.row_groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec).filter((c): c is NonNullable<typeof c> => !!c)))
  const unreadable = [...codecs].filter((c) => c !== 'SNAPPY' && c !== 'UNCOMPRESSED')
  if (unreadable.length) throw new Error(`The ${what} file is compressed with ${unreadable.join(', ')}, which aegraph does not read yet (Snappy and uncompressed files are). Re-save it with Snappy compression.`)
  const limits: DatasetFileLimits = { bytes: graphLimits.bytes, rows, columns: graphLimits.columns, cells: graphLimits.cells, inflatedBytes: graphLimits.inflatedBytes, cellText: graphLimits.cellText }
  try {
    const read = await readParquetRows(bytes, { name: `The ${what} file`, limits, columns: keep, rowEnd: limit, cell: cellValue })
    const objects = read.rows.map((cells) => {
      const row: Record<string, unknown> = Object.create(null)
      read.columns.forEach((c, i) => (row[c] = cells[i]))
      return row
    })
    return { columns: read.columns, rows: objects, total: read.total }
  } catch (e) {
    // The dataset reader's sentences name a dataset's bounds; a graph's are its own.
    if (e instanceof DatasetTooLargeError) throw new GraphTooLargeError(e.message.replace(/a (dataset|table) (read )?from a file keeps/g, 'a graph import takes'))
    throw e
  }
}

/** The first of `names` among `columns`, case-insensitively, as the column is spelled. */
const findColumn = (columns: string[], names: string[], exclude?: string): string | undefined => {
  for (const n of names) {
    const hit = columns.find((c) => c.toLowerCase() === n && c !== exclude)
    if (hit) return hit
  }
  return undefined
}

const asId = (v: unknown): string | undefined => {
  const c = cellValue(v)
  return c === undefined || c === '' || typeof c === 'object' ? undefined : String(c)
}

export async function parseParquetGraph(points: ArrayBuffer, links?: ArrayBuffer, opts: ParquetGraphOptions = {}): Promise<ParsedGraph> {
  const warnings: string[] = []
  const lower = (s?: string) => s?.toLowerCase()
  const limits = opts.limits ?? GRAPH_FILE_LIMITS
  const nodeTable = await readTable(
    points,
    'points',
    limits.nodes,
    limits,
    opts.columns?.length
      ? (all) => {
          // The columns asked for, plus whatever makes a node a node (its id, label and position).
          const need = new Set(opts.columns!.map((c) => c.toLowerCase()))
          for (const c of [opts.idColumn, opts.labelColumn, findColumn(all, ID), findColumn(all, LABEL), ...all.filter((c) => VIZ.has(c.toLowerCase()))]) if (c) need.add(c.toLowerCase())
          const picked = all.filter((c) => need.has(c.toLowerCase()))
          const missing = opts.columns!.filter((c) => !all.some((a) => a.toLowerCase() === c.toLowerCase()))
          if (missing.length) warnings.push(`No column ${missing.join(', ')} in the points file (it has ${all.join(', ')}).`)
          return picked
        }
      : undefined,
    opts.limit,
  )
  const cols = nodeTable.columns
  const idCol = opts.idColumn ? findColumn(cols, [lower(opts.idColumn)!]) : findColumn(cols, ID)
  if (opts.idColumn && !idCol) throw new Error(`No column ${opts.idColumn} in the points file (it has ${cols.join(', ')}).`)
  const labelCol = opts.labelColumn ? findColumn(cols, [lower(opts.labelColumn)!]) : findColumn(cols, LABEL, idCol)
  if (nodeTable.rows.length < nodeTable.total) warnings.push(`Read the first ${nodeTable.rows.length.toLocaleString()} of ${nodeTable.total.toLocaleString()} points.`)

  // A repeated id is another row, not the same one again: in a points table the "id" is often a title, and two papers
  // can share one. The first keeps the id (links to it land there); each repeat is `id#2`, `id#3`…
  const seen = new Map<string, number>()
  let duplicates = 0
  const nodes: GNode[] = []
  nodeTable.rows.forEach((row, r) => {
    const given = (idCol ? asId(row[idCol]) : undefined) ?? `row-${r}`
    const times = (seen.get(given) ?? 0) + 1
    seen.set(given, times)
    if (times > 1) duplicates++
    const id = times > 1 ? `${given}#${times}` : given
    const attrs: Record<string, unknown> = {}
    const viz: NonNullable<GNode['viz']> = {}
    let label: string | undefined
    if (times > 1 && idCol) attrs[idCol] = given
    for (const c of cols) {
      if (c === idCol) continue
      const v = cellValue(row[c])
      if (v === undefined || v === '') continue
      const k = c.toLowerCase()
      if (c === labelCol) label = String(v)
      else if (k === 'x' || k === 'y' || k === 'z' || k === 'size') {
        if (typeof v === 'number') viz[k] = v
      } else if (k === 'color' || k === 'colour') {
        if (typeof v === 'string') viz.color = v
        else if (!isUnsafeKey(c)) attrs[c] = v
      } else if (!isUnsafeKey(c)) attrs[c] = v
    }
    nodes.push({ id, ...(label ? { label } : {}), attrs, ...(Object.keys(viz).length ? { viz } : {}) })
  })
  if (duplicates) warnings.push(`${duplicates.toLocaleString()} rows repeat an id already read; each is its own node, numbered (id#2, id#3…), and a link to the id goes to the first.`)
  if (opts.rescale !== false) {
    const k = rescalePositions(nodes)
    if (k !== undefined && Math.abs(k - 1) > 0.01) warnings.push(`Positions rescaled ×${k.toPrecision(3)} and centred, to a ${Math.round(spreadFor(nodes.filter((v) => v.viz?.x !== undefined).length)).toLocaleString()}-unit spread (parquet.rescale: false keeps them as written).`)
  }

  const edges: GEdge[] = []
  if (links) {
    const linkTable = await readTable(links, 'links', limits.edges, limits)
    const lc = linkTable.columns
    const src = opts.sourceColumn ? findColumn(lc, [lower(opts.sourceColumn)!]) : findColumn(lc, SOURCE)
    const tgt = opts.targetColumn ? findColumn(lc, [lower(opts.targetColumn)!]) : findColumn(lc, TARGET)
    if (!src || !tgt) throw new Error(`The links file needs a source and a target column (it has ${lc.join(', ')}); name them with source_column / target_column.`)
    const labelC = findColumn(lc, ['label'])
    const weightC = findColumn(lc, ['weight', 'value'])
    let skipped = 0
    for (const row of linkTable.rows) {
      const source = asId(row[src])
      const target = asId(row[tgt])
      if (!source || !target) {
        skipped++
        continue
      }
      const attrs: Record<string, unknown> = {}
      for (const c of lc) {
        if (c === src || c === tgt || c === labelC || c === weightC) continue
        const v = cellValue(row[c])
        if (v !== undefined && v !== '' && !isUnsafeKey(c)) attrs[c] = v
      }
      const label = labelC ? cellValue(row[labelC]) : undefined
      const weight = weightC ? cellValue(row[weightC]) : undefined
      edges.push({ source, target, attrs, ...(label !== undefined ? { label: String(label) } : {}), ...(typeof weight === 'number' ? { weight } : {}) })
    }
    if (skipped) warnings.push(`Skipped ${skipped.toLocaleString()} link rows without a source or target.`)
  }
  return { nodes, edges, directedDefault: true, attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings }
}

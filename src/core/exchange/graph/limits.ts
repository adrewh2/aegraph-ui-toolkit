/**
 * How large a graph file may be — dropped on the Import tab, or fetched by `import_graph` from a URL — and what it
 * may become. A graph file is data from outside, like a dataset's (`datasets/files.ts › DATASET_FILE_LIMITS`), so it
 * is refused at a bound with a sentence saying which, never cut short: the bytes before anything is parsed (and as
 * a download arrives, whatever the server said it would send), the nodes and edges once it is read, and for
 * Parquet the columns, cells, page sizes and cell text as it is read.
 *
 * Generous for the graphs people import — Cosmograph's 100,000-paper arXiv map is a 53 MB Parquet file — and short
 * of what would take the tab down: every node becomes an entity, held in memory and in IndexedDB.
 */
export interface GraphFileLimits {
  /** The file itself (each file of a pair), before it is parsed. */
  bytes: number
  nodes: number
  edges: number
  /** Parquet: the columns of a table, the cells read, what its pages decompress to, the characters of its text cells. */
  columns: number
  cells: number
  inflatedBytes: number
  cellText: number
}

export const GRAPH_FILE_LIMITS: GraphFileLimits = {
  bytes: 128 * 1024 * 1024,
  nodes: 1_000_000,
  edges: 2_000_000,
  columns: 1_000,
  cells: 20_000_000,
  inflatedBytes: 512 * 1024 * 1024,
  cellText: 256 * 1024 * 1024,
}

/** A graph file refused for its size: the message says which bound, for the person to read. */
export class GraphTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphTooLargeError'
  }
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`
const n = (x: number) => x.toLocaleString('en-US')

/** Refuses a file larger than the byte bound, before it is read. */
export function checkGraphBytes(name: string, size: number, limits: GraphFileLimits = GRAPH_FILE_LIMITS) {
  if (size > limits.bytes) throw new GraphTooLargeError(`${name} is ${(size / (1024 * 1024)).toFixed(1)} MB — a graph file can be at most ${mb(limits.bytes)}.`)
}

/** Refuses a parsed graph with more nodes or edges than an import takes. */
export function checkGraphShape(name: string, g: { nodes: ArrayLike<unknown>; edges: ArrayLike<unknown> }, limits: GraphFileLimits = GRAPH_FILE_LIMITS): void {
  if (g.nodes.length > limits.nodes) throw new GraphTooLargeError(`${name} has ${n(g.nodes.length)} nodes — a graph import takes at most ${n(limits.nodes)}.`)
  if (g.edges.length > limits.edges) throw new GraphTooLargeError(`${name} has ${n(g.edges.length)} edges — a graph import takes at most ${n(limits.edges)}.`)
}

/**
 * A fetched graph file's bytes, refused past the byte bound: by its `content-length` before a byte is read, and by
 * what has arrived as it is read (a server can say one size and send another).
 */
export async function readGraphResponse(res: Response, name: string, limits: GraphFileLimits = GRAPH_FILE_LIMITS): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limits.bytes) {
    await res.body?.cancel().catch(() => {})
    checkGraphBytes(name, declared, limits)
  }
  if (!res.body) return new ArrayBuffer(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > limits.bytes) throw new GraphTooLargeError(`${name} is more than ${mb(limits.bytes)} — a graph file can be at most ${mb(limits.bytes)}.`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
    await res.body.cancel().catch(() => {})
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out.buffer
}

/** A fetched graph file's text, decoded as `Response.text()` would (UTF-8), within the byte bound. */
export async function readGraphText(res: Response, name: string, limits: GraphFileLimits = GRAPH_FILE_LIMITS): Promise<string> {
  return new TextDecoder().decode(await readGraphResponse(res, name, limits))
}

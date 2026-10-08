import type { ColumnChunk, Compressors, FileMetaData, SchemaTree } from 'hyparquet'
import { columnsFromHeaders, squareRows, type DatasetData } from './dataset'
import { cellTextLimit, checkShape, DATASET_FILE_LIMITS, DatasetTooLargeError, plainValue, textWeight, type DatasetFileLimits } from './files'
// (files.ts loads this module on demand; hyparquet itself is loaded only when a Parquet file is read.)

/**
 * Parquet files read in the page, through hyparquet (pure JavaScript, MIT) and its codecs (hyparquet-compressors:
 * gzip, zstd, brotli, LZ4; Snappy is hyparquet's own), both loaded only when a Parquet file is read.
 *
 * Bounded before and during the read: the footer's row count and columns against the file limits before a page is
 * touched; every page header of the columns to be read, walked before any is decoded (`checkPages`) — a page's
 * value count is what hyparquet allocates for it, so one above its row group's rows (a column of single values) or
 * above the cells a dataset keeps is refused, never allocated; the sizes the footer declares for its column chunks;
 * and every page's decompression — each codec is handed a buffer of the size the page header states and no more,
 * and the running total of those sizes is capped. What the cells hold together is counted as the rows are made
 * (`cellText`), so a dictionary of one long string repeated down a column is refused, not copied.
 *
 * The graph importer (`exchange/graph/parquet.ts`) reads its points and links through `readParquetRows`, with
 * limits of its own.
 */

export interface ReadParquetOptions {
  name?: string
  limits?: DatasetFileLimits
}

/** A Parquet file as a dataset's data: its top-level columns, every row. Nested values (lists, structs, maps) are JSON cells. */
export async function readParquet(bytes: Uint8Array, opts: ReadParquetOptions = {}): Promise<DatasetData> {
  const name = opts.name ?? 'The file'
  const limits = opts.limits ?? DATASET_FILE_LIMITS
  const read = await readParquetRows(bytes, { name, limits })
  const columns = columnsFromHeaders(read.columns)
  return { columns, rows: squareRows(read.rows, columns.length) }
}

export interface ParquetRowsOptions {
  name: string
  limits: DatasetFileLimits
  /** Only these top-level columns, in this order (all of them otherwise). */
  columns?: (names: string[]) => string[] | undefined
  /** At most this many rows, from the first. */
  rowEnd?: number
  /** What a cell becomes (default `plainValue`); a DATE column's dates are their day whatever this is. */
  cell?: (v: unknown) => unknown
}

export interface ParquetRows {
  /** The columns read, in the order of each row's cells. */
  columns: string[]
  /** Each row's cells as `cell` made them (plain values by default), a DATE column's as `YYYY-MM-DD`. */
  rows: unknown[][]
  /** The rows the file holds, read or not. */
  total: number
}

/** Rows of a Parquet file, bounded throughout (see the module's comment). Throws a sentence, never a half-read table. */
export async function readParquetRows(bytes: Uint8Array | ArrayBuffer, opts: ParquetRowsOptions): Promise<ParquetRows> {
  const { name, limits } = opts
  const { parquetMetadata, parquetRead, parquetSchema, snappyUncompress } = await import('hyparquet')
  const { compressors, decompressZstd } = await import('hyparquet-compressors')
  const file = bytes instanceof ArrayBuffer ? bytes : bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer)

  let meta: FileMetaData
  try {
    meta = parquetMetadata(file)
  } catch {
    throw new Error(`${name} is not a Parquet file — its footer could not be read.`)
  }
  const tree: SchemaTree = parquetSchema(meta)
  const all = tree.children.map((c) => c.element.name)
  const chosen = opts.columns?.(all) ?? all
  const total = Number(meta.num_rows)
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${name} is damaged: its footer gives ${String(meta.num_rows)} rows.`)
  let groupRows = 0
  for (const rg of meta.row_groups) groupRows += Number(rg.num_rows)
  if (!Number.isSafeInteger(groupRows) || groupRows > total) throw new Error(`${name} is damaged: its row groups hold more rows than its footer says.`)
  const rowEnd = Math.min(total, opts.rowEnd ?? total)
  checkShape(name, rowEnd, chosen.length, limits)

  const wanted = new Set(chosen)
  const flat = new Set(tree.children.filter((c) => c.element.repetition_type !== 'REPEATED' && !c.children.length).map((c) => c.element.name))
  const tooLarge = () => new DatasetTooLargeError(`${name} decompresses to more than ${Math.round(limits.inflatedBytes / (1024 * 1024))} MB, so it is not being read.`)
  let declared = 0
  for (const rg of meta.row_groups) for (const c of rg.columns) if (wanted.has(c.meta_data?.path_in_schema[0] ?? '')) declared += Number(c.meta_data?.total_uncompressed_size ?? 0)
  if (declared > limits.inflatedBytes) throw tooLarge()
  checkPages(new Uint8Array(file), meta, { name, limits, wanted, flat, rowEnd })

  // Every codec gets exactly the buffer the page header asks for, counted against the budget first.
  let spent = 0
  const spend = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} is damaged: a page declares a size of ${n}.`)
    spent += n
    if (spent > limits.inflatedBytes) throw tooLarge()
  }
  const bounded: Compressors = {
    SNAPPY: (input, n) => {
      spend(n)
      const out = new Uint8Array(n)
      snappyUncompress(input, out)
      return out
    },
    GZIP: (input, n) => (spend(n), compressors.GZIP!(input, n)),
    BROTLI: (input, n) => (spend(n), compressors.BROTLI!(input, n)),
    LZ4: (input, n) => (spend(n), compressors.LZ4!(input, n)),
    LZ4_RAW: (input, n) => (spend(n), compressors.LZ4_RAW!(input, n)),
    // fzstd writes into the buffer it is given and stops at its end, where on its own it grows to whatever the frame says.
    ZSTD: (input, n) => (spend(n), decompressZstd(input, new Uint8Array(n))),
  }

  let raw: unknown[][] = []
  try {
    // Rows as arrays in the order asked for: an object per row would be keyed by column names, which the file chooses.
    if (rowEnd > 0 && chosen.length) await parquetRead({ file, metadata: meta, columns: chosen, compressors: bounded, rowEnd, onComplete: (r) => (raw = r as unknown[][]) })
  } catch (e) {
    if (e instanceof DatasetTooLargeError) throw e
    throw new Error(`${name} could not be read: ${e instanceof Error ? e.message : String(e)}`)
  }

  // A DATE column is a day; every other date-like value keeps its time.
  const byName = new Map(tree.children.map((c) => [c.element.name, c]))
  const dateOnly = chosen.map((c) => {
    const el = byName.get(c)?.element
    return el?.logical_type?.type === 'DATE' || el?.converted_type === 'DATE'
  })
  // What the cells hold together, counted as they are made: a repeated dictionary value is a reference in hyparquet's
  // output and a copy in everything that later writes the table out.
  const textLimit = cellTextLimit(limits)
  let text = 0
  const cell = opts.cell ?? plainValue
  const rows = raw.map((row) => {
    const cells = row.map((v, i) => (dateOnly[i] && v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : cell(v)))
    for (const c of cells) text += textWeight(c)
    if (text > textLimit) throw new DatasetTooLargeError(`${name} holds more than ${Math.round(textLimit / (1024 * 1024))} million characters of cell text — more than a table read from a file keeps.`)
    return cells
  })
  return { columns: chosen, rows, total }
}

// ── Page headers ────────────────────────────────────────────────────

interface PageCheck {
  name: string
  limits: DatasetFileLimits
  wanted: Set<string>
  flat: Set<string>
  rowEnd: number
}

/**
 * Walks the page headers of every column chunk that will be read (the columns asked for, in the row groups the rows
 * asked for reach), before hyparquet decodes any: hyparquet sizes a page's arrays by the value count its header
 * gives, so a hundred-byte page that claims two billion values would take the tab. A data page's values are at most
 * its row group's rows in a flat column, and the values of every page read at most the cells a table keeps; a
 * dictionary page's at most the cells. A header that runs past its chunk is a damaged file.
 */
export function checkPages(bytes: Uint8Array, meta: FileMetaData, check: PageCheck) {
  const { name, limits } = check
  const damaged = (why: string) => new Error(`${name} is damaged: ${why}.`)
  const tooMany = (n: number) => new DatasetTooLargeError(`${name} has a page of ${n.toLocaleString('en-US')} values — more than a table read from a file keeps (${limits.cells.toLocaleString('en-US')} cells).`)
  let values = 0
  let groupStart = 0
  for (const rg of meta.row_groups) {
    if (groupStart >= check.rowEnd) break
    const rows = Number(rg.num_rows)
    groupStart += rows
    for (const chunk of rg.columns) {
      const md = (chunk as ColumnChunk).meta_data
      const column = md?.path_in_schema[0]
      if (!md || column === undefined || !check.wanted.has(column)) continue
      const start = Number(md.dictionary_page_offset || md.data_page_offset)
      const end = start + Number(md.total_compressed_size)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > bytes.byteLength || end < start) throw damaged(`the column ${JSON.stringify(column)} lies outside the file`)
      let at = start
      let inChunk = 0
      while (at < end - 1) {
        const h = readPageHeader(bytes, at, end, damaged)
        if (h.values !== undefined) {
          if (!Number.isSafeInteger(h.values) || h.values < 0) throw damaged(`a page declares ${h.values} values`)
          if (h.values > limits.cells) throw tooMany(h.values)
          if (h.data) {
            inChunk += h.values
            if (check.flat.has(column) && inChunk > rows) throw damaged(`the column ${JSON.stringify(column)} has more values than its row group has rows`)
            values += h.values
            if (values > limits.cells) throw tooMany(values)
          }
        }
        if (!Number.isSafeInteger(h.compressed) || h.compressed < 0) throw damaged(`a page declares a size of ${h.compressed}`)
        at = h.next + h.compressed
      }
    }
  }
}

/** One page header (Thrift compact protocol): its type's value count, its compressed size, and where its data begins. */
function readPageHeader(bytes: Uint8Array, at: number, end: number, damaged: (why: string) => Error): { values?: number; data: boolean; compressed: number; next: number } {
  const r = new CompactReader(bytes, at, end, damaged)
  const top = r.struct(0)
  const type = top.get(1)
  const sub = (id: number) => top.get(id) as Map<number, unknown> | undefined
  // 0 a data page, 2 a dictionary page, 3 a data page (v2); their value counts are field 1 of fields 5, 7 and 8.
  const header = type === 0 ? sub(5) : type === 2 ? sub(7) : type === 3 ? sub(8) : undefined
  const values = header?.get(1)
  return { values: typeof values === 'number' ? values : undefined, data: type === 0 || type === 3, compressed: Number(top.get(3) ?? -1), next: r.at }
}

/** Just enough of Thrift's compact protocol to read a page header: integers kept, everything else stepped over. */
class CompactReader {
  private readonly bytes: Uint8Array
  at: number
  private readonly end: number
  private readonly damaged: (why: string) => Error
  constructor(bytes: Uint8Array, at: number, end: number, damaged: (why: string) => Error) {
    this.bytes = bytes
    this.at = at
    this.end = end
    this.damaged = damaged
  }
  private byte(): number {
    if (this.at >= this.end) throw this.damaged('a page header runs past its column')
    return this.bytes[this.at++]
  }
  private varint(): number {
    let out = 0
    let mul = 1
    for (let i = 0; i < 10; i++) {
      const b = this.byte()
      out += (b & 0x7f) * mul
      if (!(b & 0x80)) return out
      mul *= 128
    }
    throw this.damaged('a page header holds a malformed number')
  }
  private zigzag(): number {
    const v = this.varint()
    return v % 2 ? -(v + 1) / 2 : v / 2
  }
  private skip(n: number) {
    if (n < 0 || this.at + n > this.end) throw this.damaged('a page header runs past its column')
    this.at += n
  }
  private value(type: number, depth: number): unknown {
    switch (type) {
      case 1:
        return true
      case 2:
        return false
      case 3:
        return this.byte()
      case 4:
      case 5:
      case 6:
        return this.zigzag()
      case 7:
        return this.skip(8)
      case 8:
        return this.skip(this.varint())
      case 9:
      case 10: {
        const head = this.byte()
        const size = head >> 4 === 15 ? this.varint() : head >> 4
        const elem = head & 0x0f
        if (size > this.end - this.at) throw this.damaged('a page header lists more than it holds')
        for (let i = 0; i < size; i++) {
          if (elem === 1 || elem === 2) this.byte()
          else this.value(elem, depth + 1)
        }
        return undefined
      }
      case 11: {
        const size = this.varint()
        if (!size) return undefined
        const kv = this.byte()
        if (size > this.end - this.at) throw this.damaged('a page header lists more than it holds')
        for (let i = 0; i < size; i++) {
          this.value(kv >> 4, depth + 1)
          this.value(kv & 0x0f, depth + 1)
        }
        return undefined
      }
      case 12:
        return this.struct(depth + 1)
      default:
        throw this.damaged(`a page header holds an unknown type (${type})`)
    }
  }
  struct(depth: number): Map<number, unknown> {
    if (depth > 8) throw this.damaged('a page header nests too deeply')
    const out = new Map<number, unknown>()
    let id = 0
    for (;;) {
      const head = this.byte()
      const type = head & 0x0f
      if (type === 0) return out
      const delta = head >> 4
      id = delta ? id + delta : this.zigzag()
      out.set(id, this.value(type, depth))
    }
  }
}

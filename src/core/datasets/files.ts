import { CsvParser, CsvTooWideError, restoreCell } from '../exchange/formats'
import { gunzipText, TooLargeError } from '../exchange/gunzip'
import { columnsFromHeaders, parseCell, squareRows, type DatasetData, type DatasetFileFormat, type DatasetSource } from './dataset'

/**
 * Datasets read from files: delimited text (CSV, TSV, or a text file with a separator someone names), an Excel
 * workbook (`xlsx.ts`, a sheet per dataset) and Parquet (`parquet.ts`, through hyparquet). What a chat attachment,
 * the `dataset` tool and anything else that takes a table from a file go through, in the tab and headless alike.
 *
 * A file is data from outside, so everything here is bounded: the file's size before it is read, the rows, columns
 * and cells as they are read (a file past a bound is refused with a sentence saying which, never cut short
 * silently), what a compressed file becomes (`gunzip.ts`, and the same ceiling on a workbook's members and a Parquet
 * file's pages), and the keys a header or a nested value can give (`columnKey` renames the ones that name an
 * object's machinery; `plainValue` drops them from JSON cells). Long parses yield to the page between chunks, so
 * a large file never holds the tab for more than a slice at a time.
 */

export interface DatasetFileLimits {
  /** The file itself, before anything is read. */
  bytes: number
  /** Data rows (the header is not counted). */
  rows: number
  columns: number
  /** Rows × columns: a wide file and a long one are bounded by what they hold together. */
  cells: number
  /** What a compressed file — a gzip, a workbook's members, a Parquet file's pages — may become. */
  inflatedBytes: number
  /**
   * The characters every cell's text holds together (default `DEFAULT_CELL_TEXT`). A workbook's shared string or a
   * Parquet dictionary value is stored once and may stand in a hundred thousand cells; the table that is kept, saved
   * and versioned holds each of those copies.
   */
  cellText?: number
}

/** 128 million characters: a 50 MB file of text holds at most 50 million, so no file a person would attach gets near it. */
export const DEFAULT_CELL_TEXT = 128 * 1024 * 1024
export const cellTextLimit = (limits: DatasetFileLimits) => limits.cellText ?? DEFAULT_CELL_TEXT

/** What a plain value weighs as text: a string its length, JSON its strings and keys, anything else a few characters. */
export function textWeight(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length
  if (v === null || typeof v !== 'object' || depth > 20) return 4
  let n = 2
  if (Array.isArray(v)) for (const x of v) n += textWeight(x, depth + 1) + 1
  else for (const k of Object.keys(v)) n += k.length + textWeight((v as Record<string, unknown>)[k], depth + 1) + 2
  return n
}

/**
 * Generous for anything a person would attach — a year of transactions, a census table, a sensor log — and far
 * short of what would take the tab down with it: a dataset is one entity, kept in memory, in the project's
 * versions and in IndexedDB.
 */
export const DATASET_FILE_LIMITS: DatasetFileLimits = {
  bytes: 50 * 1024 * 1024,
  rows: 200_000,
  columns: 500,
  cells: 5_000_000,
  inflatedBytes: 256 * 1024 * 1024,
}

/** A file refused for its size or shape: the message says what the bound was, for the person to read. */
export class DatasetTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetTooLargeError'
  }
}

const n = (x: number) => x.toLocaleString('en-US')
const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

// ── Which files ─────────────────────────────────────────────────────

/** The file extensions a dataset is read from (the chat's file picker lists them). */
export const DATASET_ACCEPT = '.csv,.tsv,.tab,.xlsx,.parquet,.pq,.csv.gz,.tsv.gz,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const lower = (name: string) => name.trim().toLowerCase()
const isGzipped = (name: string) => lower(name).endsWith('.gz')

/** What a file would be read as, from its name (and type): `txt` is text whose separator someone has to say. */
export function datasetFileFormat(file: { name: string; type?: string }): DatasetFileFormat | undefined {
  const name = lower(file.name).replace(/\.gz$/, '')
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (ext === 'csv' || file.type === 'text/csv') return 'csv'
  if (ext === 'tsv' || ext === 'tab' || file.type === 'text/tab-separated-values') return 'tsv'
  if (ext === 'xlsx' || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  if (ext === 'parquet' || ext === 'pq') return 'parquet'
  if (ext === 'txt' || ext === 'text') return 'txt'
  return undefined
}

/** The file's name without its extensions: `sales.csv.gz` is `sales` — what the dataset is called. */
export function baseName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? name
  const stripped = leaf.replace(/\.gz$/i, '').replace(/\.(csv|tsv|tab|txt|text|xlsx|parquet|pq)$/i, '')
  return stripped.trim() || leaf.trim() || 'Dataset'
}

// ── Separators ─────────────────────────────────────────────────────

/** A separator: one character (quoted fields honoured, as in CSV), `whitespace` (runs of spaces and tabs), or a longer string split on as it is. */
export type Delimiter = string

export const DELIMITERS: { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: '\t', label: 'Tab' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '|', label: 'Pipe  |' },
  { value: 'whitespace', label: 'Spaces or tabs' },
]

/** How a delimited file is read: its separator, and whether its first row names the columns. */
export interface DelimitedOptions {
  delimiter: Delimiter
  header: boolean
}

/** A separator as a person or a tool may name it (`comma`, `tab`, `\t`, `;`…) as the one it is. */
export function normalizeDelimiter(d: string | undefined): Delimiter {
  if (d === undefined || d === '') return ','
  const named: Record<string, Delimiter> = { comma: ',', tab: '\t', '\\t': '\t', semicolon: ';', pipe: '|', whitespace: 'whitespace', space: 'whitespace', spaces: 'whitespace' }
  const key = d.toLowerCase()
  if (Object.hasOwn(named, key)) return named[key]
  if (/[\r\n"]/.test(d)) throw new Error(`A separator cannot hold a quote or a line break (got ${JSON.stringify(d)}).`)
  return d
}

/**
 * The separator a sample of text most likely uses: the candidate that splits the most lines into the same number of
 * fields (more than one). A tab or a comma wins a tie; plain prose splits on nothing consistently and reads as
 * whitespace only when every line does.
 */
export function sniffDelimiter(text: string): Delimiter {
  // A sample is a sample: thirty lines, each cut at 64 KB, whatever the text holds.
  const lines = sampleLines(text, 30)
  if (!lines.length) return ','
  let best: { d: Delimiter; score: number } = { d: ',', score: 0 }
  for (const d of ['\t', ',', ';', '|', 'whitespace'] as const) {
    const counts = lines.map((l) => splitLine(l, d).length)
    const mode = modeOf(counts)
    if (mode < 2) continue
    const agree = counts.filter((c) => c === mode).length / counts.length
    // Whitespace splits any sentence; it has to agree everywhere to count.
    const score = d === 'whitespace' ? (agree === 1 ? 0.5 : 0) : agree + Math.min(mode, 20) / 100
    if (score > best.score) best = { d, score }
  }
  return best.d
}

function modeOf(xs: number[]): number {
  const seen = new Map<number, number>()
  let best = 0
  let bestN = 0
  for (const x of xs) {
    const c = (seen.get(x) ?? 0) + 1
    seen.set(x, c)
    if (c > bestN || (c === bestN && x > best)) {
      best = x
      bestN = c
    }
  }
  return best
}

/** The first `count` non-empty lines of a text (any line ending), each at most 64 KB — read without splitting the whole text. */
function sampleLines(text: string, count: number): string[] {
  const out: string[] = []
  const isEnd = (c: string) => c === '\n' || c === '\r'
  let i = 0
  while (i < text.length && out.length < count) {
    const stop = Math.min(text.length, i + SAMPLE_LINE)
    let j = i
    while (j < stop && !isEnd(text[j])) j++
    const line = text.slice(i, j)
    while (j < text.length && !isEnd(text[j])) j++ // the rest of a line longer than a sample
    if (line.trim() !== '') out.push(line)
    i = j + (text[j] === '\r' && text[j + 1] === '\n' ? 2 : 1)
  }
  return out
}
const SAMPLE_LINE = 64 * 1024

/**
 * One line split on a separator (the preview and the sniff use it for every kind, on lines they have cut short).
 * Split on whitespace or a longer separator, it stops one field past `max`, so a caller can tell there were more.
 */
function splitLine(line: string, d: Delimiter, max = Infinity): string[] {
  if (d === 'whitespace') return countedSplit(line.trim(), /[ \t]+/g, max)
  if (d.length === 1) {
    const out: string[] = []
    const p = new CsvParser(d)
    p.push(line, (r) => out.push(...r))
    p.end((r) => out.push(...r))
    return out
  }
  return countedSplit(line, d, max)
}

/** How many fields a line splits into on a separator, counted without making them. */
function countFields(line: string, d: Delimiter): number {
  if (d === 'whitespace') {
    let count = 0
    const t = line.trim()
    for (let i = 0; i < t.length; ) {
      count++
      while (i < t.length && t[i] !== ' ' && t[i] !== '\t') i++
      while (i < t.length && (t[i] === ' ' || t[i] === '\t')) i++
    }
    return count
  }
  let count = 1
  for (let i = line.indexOf(d); i >= 0; i = line.indexOf(d, i + d.length)) count++
  return count
}

/** `line.split(sep)`, stopping one field past `max` instead of making every field of a line of separators. */
function countedSplit(line: string, sep: string | RegExp, max: number): string[] {
  if (!Number.isFinite(max)) return line.split(sep)
  const out: string[] = []
  if (typeof sep === 'string') {
    let start = 0
    for (;;) {
      const i = line.indexOf(sep, start)
      if (i < 0 || out.length > max) break
      out.push(line.slice(start, i))
      start = i + sep.length
    }
    if (out.length <= max) out.push(line.slice(start))
    return out
  }
  let start = 0
  sep.lastIndex = 0
  for (let m = sep.exec(line); m && out.length <= max; m = sep.exec(line)) {
    if (!m[0]) {
      sep.lastIndex++
      continue
    }
    out.push(line.slice(start, m.index))
    start = m.index + m[0].length
  }
  if (out.length <= max) out.push(line.slice(start))
  return out
}

// ── Reading delimited text ───────────────────────────────────────────

/** Let the page breathe between chunks of a long parse. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A chunk of text parsed between breaths: large enough to be quick, small enough to stay under a long task. */
const CHUNK = 256 * 1024

/** How wide and how full a split may get before it stops: a row's fields, and every field together. */
export interface SplitBounds {
  maxRows?: number
  /** Fields in one row: a row past it is refused (`CsvTooWideError`) as it is read. */
  maxFields?: number
  /** Fields in every row together. */
  maxCells?: number
}

/**
 * Text as rows of strings, split on a separator. `maxRows` stops the read one row past it (so a caller knows there
 * were more) — the file is never split to the end just to be refused. `maxFields` and `maxCells` refuse a row, or
 * the whole, as soon as either is passed (`CsvTooWideError`): a line of nothing but separators would otherwise be
 * an array of millions of empty strings before anything could count them.
 */
export async function splitDelimited(text: string, delimiter: Delimiter, bounds: number | SplitBounds = Infinity): Promise<string[][]> {
  const { maxRows = Infinity, maxFields, maxCells } = typeof bounds === 'number' ? { maxRows: bounds } : bounds
  const rows: string[][] = []
  const full = () => rows.length > maxRows
  if (delimiter.length === 1) {
    const p = new CsvParser(delimiter, { maxFields, maxCells })
    // A cell a spreadsheet-safe export wrote with a `'` in front (`defuseCell`) reads back as it was.
    const take = (r: string[]) => {
      if (!full()) rows.push(r.map(restoreCell))
    }
    for (let i = 0; i < text.length && !full(); i += CHUNK) {
      p.push(text.slice(i, i + CHUNK), take)
      if (i + CHUNK < text.length) await breathe()
    }
    p.end(take)
    return rows
  }
  let start = 0
  let sinceBreath = 0
  let cells = 0
  while (start <= text.length && !full()) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    const line = text.slice(start, end).replace(/\r$/, '')
    if (line.trim() !== '') {
      const row = splitLine(line, delimiter, maxFields ?? Infinity)
      if (maxFields !== undefined && row.length > maxFields) throw new CsvTooWideError('fields', maxFields, countFields(line, delimiter))
      cells += row.length
      if (maxCells !== undefined && cells > maxCells) throw new CsvTooWideError('cells', maxCells)
      rows.push(row)
    }
    sinceBreath += end - start + 1
    start = end + 1
    if (sinceBreath > CHUNK) {
      sinceBreath = 0
      await breathe()
    }
  }
  return rows
}

/** The first rows of a text as a separator would read them — for the attach dialog's preview. */
export function previewDelimited(text: string, opts: DelimitedOptions, count = 5): { headers: string[]; rows: string[][]; columns: number } {
  const lines = sampleLines(text, count + 1)
  // A preview shows what a person can read: the first 500 fields of a line at most.
  const rows = lines.map((l) => splitLine(l, opts.delimiter).slice(0, PREVIEW_FIELDS))
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const headers = opts.header ? (rows.shift() ?? []) : letters(columns)
  return { headers, rows: rows.slice(0, count), columns }
}

const PREVIEW_FIELDS = 500

/** `a`, `b`, … `z`, `aa` — what columns are called when the first row is data, as the grid names a column added by hand. */
export function letters(count: number): string[] {
  const out: string[] = []
  for (let k = 1; k <= count; k++) {
    let key = ''
    for (let i = k; i > 0; i = Math.floor((i - 1) / 26)) key = String.fromCharCode(97 + ((i - 1) % 26)) + key
    out.push(key)
  }
  return out
}

/** Rows of text as a dataset's data: the header (or letters), every cell read as the grid reads what is typed. */
export function tableFromStrings(raw: string[][], header: boolean, name: string, limits: DatasetFileLimits = DATASET_FILE_LIMITS): DatasetData {
  const width = raw.reduce((m, r) => Math.max(m, r.length), 0)
  const body = header ? raw.slice(1) : raw
  // The shape is checked before any column is named: `letters(width)` of a line of a million commas is a million names.
  checkShape(name, body.length, width, limits)
  const headers = header ? (raw[0] ?? []) : letters(width)
  const columns = columnsFromHeaders(headers.length < width ? [...headers, ...letters(width).slice(headers.length)] : headers)
  const textLimit = cellTextLimit(limits)
  let text = 0
  const rows = squareRows(
    body.map((r) => {
      for (const s of r) text += s.length
      if (text > textLimit) throw new DatasetTooLargeError(`${name} holds more than ${Math.round(textLimit / (1024 * 1024))} million characters of cell text — more than a table read from a file keeps.`)
      return r.map((s) => plainValue(parseCell(s, undefined)))
    }),
    columns.length,
  )
  return { columns, rows }
}

/** Delimited text as a dataset's data, bounded; the parse yields between chunks. */
export async function readDelimited(text: string, opts: DelimitedOptions, name = 'The file', limits: DatasetFileLimits = DATASET_FILE_LIMITS): Promise<DatasetData> {
  let raw: string[][]
  try {
    // Columns and cells are bounded as the text is split, not after: the header row's fields are cells too.
    raw = await splitDelimited(text, opts.delimiter, { maxRows: limits.rows + (opts.header ? 1 : 0), maxFields: limits.columns, maxCells: limits.cells + limits.columns })
  } catch (e) {
    if (!(e instanceof CsvTooWideError)) throw e
    throw new DatasetTooLargeError(e.bound === 'fields' ? `${name} has ${e.count !== undefined ? n(e.count) : `more than ${n(limits.columns)}`} columns — a dataset from a file keeps at most ${n(limits.columns)}.` : `${name} has more than ${n(limits.cells)} cells — a dataset from a file keeps at most ${n(limits.cells)}.`)
  }
  if (raw.length > limits.rows + (opts.header ? 1 : 0)) throw new DatasetTooLargeError(`${name} has more than ${n(limits.rows)} rows — a dataset from a file keeps at most ${n(limits.rows)}. Split it, or filter it before attaching it.`)
  if (!raw.length) throw new Error(`${name} has no rows.`)
  return tableFromStrings(raw, opts.header, name, limits)
}

/** Refuses a table past the column, row or cell bounds, saying which. */
export function checkShape(name: string, rows: number, columns: number, limits: DatasetFileLimits = DATASET_FILE_LIMITS) {
  if (columns > limits.columns) throw new DatasetTooLargeError(`${name} has ${n(columns)} columns — a dataset from a file keeps at most ${n(limits.columns)}.`)
  if (rows > limits.rows) throw new DatasetTooLargeError(`${name} has ${n(rows)} rows — a dataset from a file keeps at most ${n(limits.rows)}. Split it, or filter it before attaching it.`)
  if (rows * columns > limits.cells) throw new DatasetTooLargeError(`${name} has ${n(rows * columns)} cells (${n(rows)} rows × ${n(columns)} columns) — a dataset from a file keeps at most ${n(limits.cells)}.`)
}

// ── Values ──────────────────────────────────────────────────────────

const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * A value as a dataset keeps it: numbers, strings, booleans, null, or plain JSON. A big integer is a number when it
 * fits and its digits when it does not, a date its ISO text, bytes a note of their length; in nested values a key
 * that names an object's machinery is dropped, and nesting is cut at a depth no real record reaches.
 */
export function plainValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `binary (${n(v.byteLength)} bytes)`
  if (depth > 20) return null
  if (Array.isArray(v)) return v.map((x) => plainValue(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object)) if (!RESERVED.has(k)) out[k] = plainValue((v as Record<string, unknown>)[k], depth + 1)
    return out
  }
  return String(v)
}

// ── Reading a file ──────────────────────────────────────────────────

/** A dataset read from a file: its name, its data, and where it came from — a workbook gives one per sheet. */
export interface ReadDataset {
  label: string
  data: DatasetData
  source: Extract<DatasetSource, { kind: 'file' }>
}

export interface ReadDatasetOptions {
  /** Delimited text: the separator (default: comma for .csv, tab for .tsv, sniffed for .txt) and whether the first row is the header (default true). */
  delimiter?: Delimiter
  header?: boolean
  /** A workbook: only this sheet (by name) — every sheet with cells otherwise. */
  sheet?: string
  limits?: DatasetFileLimits
}

/** What a file-like thing needs to be read: a `File`, or bytes with a name (the tool's data: URL). */
export interface DatasetFileInput {
  name: string
  type?: string
  size: number
  arrayBuffer: () => Promise<ArrayBuffer>
}

/**
 * A file as one or more datasets' data, bounded throughout. Delimited text is read with its separator; a workbook's
 * sheets are a dataset each (or the one named); a Parquet file is one. Throws a sentence the person can act on —
 * too large (and which bound), not a table, a password-protected workbook — never a half-read table.
 */
export async function readDatasetFile(file: DatasetFileInput, opts: ReadDatasetOptions = {}): Promise<ReadDataset[]> {
  const limits = opts.limits ?? DATASET_FILE_LIMITS
  const format = datasetFileFormat(file)
  if (!format) throw new Error(`${file.name} is not a file a dataset is read from — CSV, TSV, text, Excel (.xlsx) or Parquet.`)
  if (file.size > limits.bytes) throw new DatasetTooLargeError(`${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB — a dataset file can be at most ${mb(limits.bytes)}.`)
  const importedAt = new Date().toISOString()
  const base = baseName(file.name)
  const source = (sheet?: string): ReadDataset['source'] => ({ kind: 'file', filename: file.name, format, ...(sheet ? { sheet } : {}), importedAt })
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (format === 'xlsx') {
    const { readXlsx } = await import('./xlsx')
    const sheets = await readXlsx(bytes, { name: file.name, limits, sheet: opts.sheet })
    // A sheet is named with its workbook when it is one of several, or the one asked for.
    return sheets.map((s) => ({ label: sheets.length > 1 || opts.sheet !== undefined ? `${base} · ${s.name}` : base, data: s.data, source: source(s.name) }))
  }
  if (format === 'parquet') {
    const { readParquet } = await import('./parquet')
    return [{ label: base, data: await readParquet(bytes, { name: file.name, limits }), source: source() }]
  }
  const text = await textOf(file.name, bytes, limits)
  const delimiter = opts.delimiter !== undefined ? normalizeDelimiter(opts.delimiter) : format === 'tsv' ? '\t' : format === 'csv' ? csvDelimiter(text) : sniffDelimiter(text.slice(0, 64 * 1024))
  const data = await readDelimited(text, { delimiter, header: opts.header ?? true }, file.name, limits)
  return [{ label: base, data, source: source() }]
}

/**
 * A file handed over as a `data:` URL (base64 or percent-encoded) as bytes — how a tool call carries a file — refused
 * before it is decoded when it is larger than a dataset file may be.
 */
export function bytesOfDataUrl(url: string, limits: DatasetFileLimits = DATASET_FILE_LIMITS): Uint8Array {
  const m = /^data:([^,]*),/i.exec(url)
  if (!m) throw new Error('file must be a data: URL — data:<type>;base64,<the file>.')
  const payload = url.slice(m[0].length)
  const base64 = /;base64$/i.test(m[1])
  const size = base64 ? Math.floor((payload.length * 3) / 4) : payload.length
  if (size > limits.bytes) throw new DatasetTooLargeError(`The file is about ${(size / (1024 * 1024)).toFixed(1)} MB — a dataset file can be at most ${mb(limits.bytes)}.`)
  if (!base64) return new TextEncoder().encode(decodeURIComponent(payload))
  const bin = atob(payload.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A .csv is comma-separated unless its header says semicolons (what spreadsheets write where the comma is the decimal point). */
function csvDelimiter(text: string): Delimiter {
  const first = text.slice(0, Math.max(0, text.indexOf('\n')) || 4096)
  return !first.includes(',') && first.includes(';') ? ';' : first.includes(',') ? ',' : sniffDelimiter(text.slice(0, 64 * 1024))
}

/** The file's text: a gzipped one through the bounded reader, a byte-order mark dropped. */
async function textOf(name: string, bytes: Uint8Array, limits: DatasetFileLimits): Promise<string> {
  let text: string
  if (isGzipped(name) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    try {
      text = await gunzipText(bytes, limits.inflatedBytes)
    } catch (e) {
      if (e instanceof TooLargeError) throw new DatasetTooLargeError(`${name} decompresses to more than ${mb(limits.inflatedBytes)}, so it is not being read.`)
      throw new Error(`${name} could not be decompressed: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else text = new TextDecoder().decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

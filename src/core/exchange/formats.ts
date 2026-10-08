import { defuseCell, restoreCell } from '../../lib/csvCell'
import { uniqueTags } from '../entity/entity'
import type { AnyEntity, EntityRef, Selector, TagInfo } from '../entity/types'
import { isCssColor } from '../../lib/cssColor'
import { MAX_DATA_DEPTH, nestsDeeperThan } from './limits'

/**
 * Exchange formats. All four carry the same aegraph/v1 information; they
 * differ in how well they stream, how small and fast they are, and what
 * other tools can read them.
 */
export type FormatId = 'json' | 'jsonl' | 'csv' | 'pack'

export interface FormatInfo {
  id: FormatId
  label: string
  extension: string
  mime: string
  description: string
  /** Can be parsed incrementally without holding the whole file as one string. */
  streaming: boolean
}

export const FORMATS: Record<FormatId, FormatInfo> = {
  json: {
    id: 'json',
    label: 'aegraph document (.ae.json)',
    extension: '.ae.json',
    mime: 'application/json',
    description: 'One aegraph/v1 document, ready to load as-is — the format other systems write (see Documentation → File format). JSON inside; parsed in one go, so best under ~100 MB.',
    streaming: false,
  },
  jsonl: {
    id: 'jsonl',
    label: 'JSON Lines',
    extension: '.ae.jsonl',
    mime: 'application/x-ndjson',
    description: 'One entity per line. Streams in and out; the right choice for large datasets.',
    streaming: true,
  },
  csv: {
    id: 'csv',
    label: 'CSV',
    extension: '.ae.csv',
    mime: 'text/csv',
    description: 'Flat table with entities and relationships in one sheet. Data is a JSON column. Streams.',
    streaming: true,
  },
  pack: {
    id: 'pack',
    label: 'aegraph pack (.aeb)',
    extension: '.aeb',
    mime: 'application/octet-stream',
    description: 'The same document as bytes: every string once, fields as flags and varints, gzip on top — about a sixth the size of .ae.json and quicker to load. aegraph’s own format; other tools want .ae.json.',
    streaming: false,
  },
}

export const CSV_COLUMNS = [
  'id',
  'kind',
  'type',
  'label',
  'description',
  'tags',
  'source_id',
  'source_selector',
  'target_id',
  'target_selector',
  'directed',
  'created_at',
  'updated_at',
  'accessed_at',
  'created_by',
  'origin',
  'data',
] as const

export function detectFormat(filename: string): { format: FormatId; gzip: boolean } | undefined {
  const lower = filename.toLowerCase()
  const gzip = lower.endsWith('.gz')
  const base = gzip ? lower.slice(0, -3) : lower
  // A pack carries its own compression (the reader looks at the bytes), so `.aeb.gz` is just `.aeb`.
  if (base.endsWith('.aeb')) return { format: 'pack', gzip: false }
  if (base.endsWith('.jsonl') || base.endsWith('.ndjson')) return { format: 'jsonl', gzip }
  if (base.endsWith('.csv')) return { format: 'csv', gzip }
  // `.ae.json` is the aegraph document itself (a bare `.ae` is accepted); plain `.json` may be a document or an array of records.
  if (base.endsWith('.ae') || base.endsWith('.json')) return { format: 'json', gzip }
  return undefined
}

export const supportsGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

// ── Normalization ──────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString()

/**
 * Coerce an arbitrary record into a valid entity. Lenient on purpose: an
 * object with just an `id` (or even just a `label`) becomes an entity, so
 * foreign data can be imported without a converter. Returns undefined only
 * when there's nothing usable at all — or when a value in it nests deeper than
 * `MAX_DATA_DEPTH`, which the app's storage cannot hold.
 */
export function normalizeEntity(raw: unknown, fallbackId?: string): AnyEntity | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id) ?? fallbackId
  if (!id) return undefined
  const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>
  // Nested past what the app's own machinery takes (`limits.ts`): refused, not cut — the entity is counted as skipped.
  if (nestsDeeperThan(r.data, MAX_DATA_DEPTH) || nestsDeeperThan(meta, MAX_DATA_DEPTH) || nestsDeeperThan(r.source, MAX_DATA_DEPTH) || nestsDeeperThan(r.target, MAX_DATA_DEPTH)) return undefined
  const createdAt = str(meta.createdAt) ?? str(r.created_at) ?? nowIso()
  const base = {
    id,
    type: str(r.type) ?? 'entity',
    label: str(r.label) ?? str(r.title) ?? str(r.name),
    description: str(r.description),
    tags: uniqueTags(Array.isArray(r.tags) ? r.tags.map(String) : typeof r.tags === 'string' ? r.tags.split(/[;,]/) : []),
    data: (r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}) as Record<string, unknown>,
    meta: {
      createdAt,
      updatedAt: str(meta.updatedAt) ?? str(r.updated_at) ?? createdAt,
      accessedAt: str(meta.accessedAt) ?? str(r.accessed_at),
      createdBy: str(meta.createdBy) ?? str(r.created_by),
      source: str(meta.source) ?? str(r.origin),
      projects: Array.isArray(meta.projects) ? meta.projects.filter((p): p is string => typeof p === 'string') : undefined,
    },
  }
  // A type definition from before the category was renamed: `graph` reads as `project`.
  if (base.type === 'schema:type' && base.data.category === 'graph') base.data = { ...base.data, category: 'project' }
  stripUndefined(base)
  stripUndefined(base.meta)

  const source = toRef(r.source)
  const target = toRef(r.target)
  // A declared kind wins; without one, two ends make a relationship.
  const isRel = r.kind === 'relationship' || (r.kind !== 'entity' && source && target)
  if (isRel) {
    if (!source || !target) return undefined
    return { ...base, kind: 'relationship', source, target, directed: r.directed === undefined ? true : bool(r.directed) }
  }
  return { ...base, kind: 'entity' }
}

export function normalizeTagInfo(raw: unknown): TagInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const tag = str(r.tag) ?? str(r.$tag)
  if (!tag) return undefined
  const info: TagInfo = { tag }
  // A tag's colour reaches pins, rings and published pages: a colour and nothing else (`lib/cssColor`).
  if (isCssColor(r.color)) info.color = r.color.trim()
  if (str(r.description)) info.description = str(r.description)
  return info
}

function toRef(v: unknown): EntityRef | undefined {
  if (typeof v === 'string' && v) return { id: v }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const id = str(o.id)
    if (!id) return undefined
    return o.selector && typeof o.selector === 'object' ? { id, selector: o.selector as Selector } : { id }
  }
  return undefined
}

/** A boolean from foreign data, where "false", "0" and "no" as strings mean false. */
function bool(v: unknown): boolean {
  return typeof v === 'string' ? !['false', '0', 'no', ''].includes(v.trim().toLowerCase()) : Boolean(v)
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return typeof v === 'string' ? v : String(v)
}

function stripUndefined(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
}

// ── CSV row <-> entity ─────────────────────────────────────────────────

export function entityToCsvRow(e: AnyEntity): string[] {
  const rel = e.kind === 'relationship' ? e : undefined
  return [
    e.id,
    e.kind,
    e.type,
    e.label ?? '',
    e.description ?? '',
    e.tags.join(';'),
    rel?.source.id ?? '',
    rel?.source.selector ? JSON.stringify(rel.source.selector) : '',
    rel?.target.id ?? '',
    rel?.target.selector ? JSON.stringify(rel.target.selector) : '',
    rel ? String(rel.directed) : '',
    e.meta.createdAt,
    e.meta.updatedAt,
    e.meta.accessedAt ?? '',
    e.meta.createdBy ?? '',
    e.meta.source ?? '',
    Object.keys(e.data).length ? JSON.stringify(e.data) : '',
  ]
}

/** Where each of the CSV columns is in a header, worked out once per header (an import reads one header for every row). */
const headerIndexes = new WeakMap<string[], Map<string, number>>()
function columnIndex(header: string[]): Map<string, number> {
  let at = headerIndexes.get(header)
  if (!at) {
    at = new Map()
    const wanted = new Set<string>(CSV_COLUMNS)
    for (let i = 0; i < header.length; i++) if (wanted.has(header[i]) && !at.has(header[i])) at.set(header[i], i)
    headerIndexes.set(header, at)
  }
  return at
}

export function csvRowToEntity(header: string[], row: string[]): AnyEntity | undefined {
  const at = columnIndex(header)
  const get = (k: (typeof CSV_COLUMNS)[number]) => {
    const i = at.get(k)
    return i !== undefined && row[i] !== undefined ? restoreCell(row[i]) : undefined
  }
  const parseJson = (s?: string) => {
    if (!s) return undefined
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const sourceId = get('source_id')
  const targetId = get('target_id')
  return normalizeEntity({
    id: get('id'),
    kind: get('kind') || (sourceId && targetId ? 'relationship' : 'entity'),
    type: get('type'),
    label: get('label'),
    description: get('description'),
    tags: get('tags'),
    source: sourceId ? { id: sourceId, selector: parseJson(get('source_selector')) } : undefined,
    target: targetId ? { id: targetId, selector: parseJson(get('target_selector')) } : undefined,
    directed: get('directed') === '' || get('directed') === undefined ? undefined : get('directed') === 'true',
    created_at: get('created_at'),
    updated_at: get('updated_at'),
    accessed_at: get('accessed_at'),
    created_by: get('created_by'),
    origin: get('origin'),
    data: parseJson(get('data')) ?? {},
  })
}

export { defuseCell, restoreCell }

/** A cell for a CSV line: defused (`defuseCell`), then quoted when it holds a quote, a comma or a line break. */
export function csvEscape(v: string): string {
  return csvEscapeRaw(defuseCell(v))
}

/** A cell for a CSV line written exactly as it is — for a file only this app will read, where nothing is a formula. */
export function csvEscapeRaw(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** A row with more fields than the parser was told to take (`count`: how many it had), or more fields in all (`bound` says which). */
export class CsvTooWideError extends Error {
  readonly bound: 'fields' | 'cells'
  readonly limit: number
  readonly count?: number
  constructor(bound: 'fields' | 'cells', limit: number, count?: number) {
    super(bound === 'fields' ? `A CSV row has ${count !== undefined ? count.toLocaleString('en-US') : `more than ${limit.toLocaleString('en-US')}`} fields (at most ${limit.toLocaleString('en-US')}).` : `The CSV has more than ${limit.toLocaleString('en-US')} fields in all.`)
    this.name = 'CsvTooWideError'
    this.bound = bound
    this.limit = limit
    this.count = count
  }
}

/** Fields in one row unless a caller says otherwise: far past any real table, short of a line of a million commas. */
export const CSV_MAX_FIELDS = 100_000

/**
 * Incremental CSV parser. Feed it text chunks; it yields complete rows and
 * keeps partial state (including quoted fields spanning chunks) between calls.
 * The separator is a comma unless another single character is given (a tab,
 * a semicolon, a pipe); quoting works the same whichever it is.
 *
 * Bounded as it reads: a row of more than `maxFields` fields (default
 * `CSV_MAX_FIELDS`) keeps no field past the bound, only counts them, and
 * throws `CsvTooWideError` with the count where the row ends; more than
 * `maxCells` fields in all throws at the field that passes it. What a file of
 * separators would otherwise become is an array of millions of empty strings.
 */
export class CsvParser {
  private readonly delimiter: string
  private readonly maxFields: number
  private readonly maxCells: number
  private cells = 0
  /** Fields of the current row past `maxFields`: counted, not kept. */
  private over = 0
  constructor(delimiter = ',', bounds: { maxFields?: number; maxCells?: number } = {}) {
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new Error(`A CSV separator is one character other than a quote or a line break (got ${JSON.stringify(delimiter)}).`)
    this.delimiter = delimiter
    this.maxFields = bounds.maxFields ?? CSV_MAX_FIELDS
    this.maxCells = bounds.maxCells ?? Infinity
  }
  private take(field: string) {
    if (this.row.length >= this.maxFields) {
      this.over++
      return
    }
    this.row.push(field)
    if (++this.cells > this.maxCells) throw new CsvTooWideError('cells', this.maxCells)
  }
  /** The row is complete: refused with its width if it passed the bound. */
  private checkRow() {
    if (!this.over) return
    const count = this.row.length + this.over
    this.over = 0
    this.row = []
    throw new CsvTooWideError('fields', this.maxFields, count)
  }
  private field = ''
  private row: string[] = []
  private inQuotes = false
  private prevQuote = false
  private prevCr = false

  push(chunk: string, emit: (row: string[]) => void) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (this.inQuotes) {
        if (this.prevQuote) {
          this.prevQuote = false
          if (ch === '"') {
            this.field += '"'
            continue
          }
          this.inQuotes = false
          // fall through: ch terminates the field
        } else if (ch === '"') {
          this.prevQuote = true
          continue
        } else {
          this.field += ch
          continue
        }
      }
      if (ch === '"' && this.field === '') {
        this.inQuotes = true
      } else if (ch === this.delimiter) {
        this.take(this.field)
        this.field = ''
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\n' && this.prevCr) {
          this.prevCr = false
          continue
        }
        this.prevCr = ch === '\r'
        this.take(this.field)
        this.field = ''
        this.checkRow()
        if (this.row.length > 1 || this.row[0] !== '') emit(this.row)
        this.row = []
        continue
      } else {
        this.field += ch
      }
      this.prevCr = false
    }
  }

  end(emit: (row: string[]) => void) {
    if (this.field !== '' || this.row.length) {
      this.take(this.field)
      this.checkRow()
      emit(this.row)
    }
    this.field = ''
    this.row = []
  }
}

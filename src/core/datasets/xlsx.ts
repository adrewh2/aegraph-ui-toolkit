import { inflateRawText, TooLargeError } from '../exchange/gunzip'
import { cellText, columnsFromHeaders, squareRows, type DatasetData } from './dataset'
import { cellTextLimit, checkShape, DATASET_FILE_LIMITS, DatasetTooLargeError, letters, type DatasetFileLimits } from './files'
// (files.ts loads this module on demand; the import back is for the bounds and helpers it shares.)

/**
 * Excel workbooks (`.xlsx`) read in the page, with nothing but the platform: an `.xlsx` is a zip of XML parts, so
 * this reads the zip's directory itself, inflates only the parts a table needs — the workbook, its relationships,
 * the shared strings, the styles (for which numbers are dates) and the sheets — through `DecompressionStream`
 * behind the same ceiling as every other decompression (`gunzip.ts › inflateRawText`), and scans the sheet XML for
 * rows and cells. A library would have unzipped the whole file first, however large its members said they were.
 *
 * The XML is scanned with `indexOf`, never a regular expression that backtracks: `elements` finds each element
 * and its closing tag in one forward pass and stops at the first that is not closed, so a part of unclosed markup
 * costs its length, not its length squared.
 *
 * Values come out as the sheet shows them: numbers, text, booleans, error codes as their text, and a number in a
 * date format as its ISO date (or date and time). Formulas are read as their last computed value; formatting,
 * merged cells, charts and pictures are not read. A sheet's first row with anything in it is its header.
 */

export interface XlsxSheet {
  name: string
  data: DatasetData
}

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  size: number
  offset: number
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** The zip's members, from its central directory (at the end of the file). */
export function zipEntries(bytes: Uint8Array, name = 'The file'): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const notZip = () => new Error(`${name} is not an Excel workbook (.xlsx) — it could not be opened as one.`)
  if (bytes.byteLength < 22) throw notZip()
  let eocd = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw notZip()
  const count = view.getUint16(eocd + 10, true)
  const dirOffset = view.getUint32(eocd + 16, true)
  if (dirOffset === 0xffffffff || count === 0xffff) throw new DatasetTooLargeError(`${name} is a zip64 workbook — larger than a dataset file can be.`)
  const out = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  let p = dirOffset
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== 0x02014b50) throw notZip()
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const entryName = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    out.set(entryName.replace(/^\/+/, ''), {
      name: entryName,
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** One member of the zip as text, inflated behind what is left of the budget. */
async function entryText(bytes: Uint8Array, e: ZipEntry, budget: { left: number; limit: number }, name: string): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (e.flags & 1) throw new Error(`${name} is password-protected — save it without a password to read it.`)
  if (e.offset + 30 > bytes.byteLength || view.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`${name} is damaged: ${e.name} could not be found in it.`)
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true)
  const data = bytes.subarray(start, start + e.compressedSize)
  const tooLarge = () => new DatasetTooLargeError(`${name} expands to more than ${mb(budget.limit)} of spreadsheet, so it is not being read.`)
  let text: string
  if (e.method === 0) {
    if (data.byteLength > budget.left) throw tooLarge()
    text = new TextDecoder().decode(data)
  } else if (e.method === 8) {
    try {
      text = await inflateRawText(data, budget.left)
    } catch (err) {
      if (err instanceof TooLargeError) throw tooLarge()
      throw new Error(`${name} is damaged: ${e.name} could not be decompressed.`)
    }
  } else throw new Error(`${name} uses a compression this reader does not know (method ${e.method}).`)
  budget.left -= text.length
  return text
}

// ── XML, just enough ─────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text as the characters it stands for — entities, character references, and Excel's `_x000D_` escapes. */
export function decodeXml(s: string): string {
  if (s.includes('&')) {
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
      if (ref[0] === '#') {
        const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
      }
      const name = ref.toLowerCase()
      return Object.hasOwn(ENTITY, name) ? ENTITY[name] : m
    })
  }
  if (s.includes('_x')) s = s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  return s
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 58 || c === 46 || c === 45
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13

/** An element's attributes, by their full name (`r:id`), and by their local one (`id`) when no unprefixed attribute has it. */
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  const local: [string, string][] = []
  const n = s.length
  let i = 0
  while (i < n) {
    while (i < n && !isNameStart(s.charCodeAt(i))) i++
    let j = i
    while (j < n && isNameChar(s.charCodeAt(j))) j++
    if (j === i) break
    const name = s.slice(i, j)
    let k = j
    while (k < n && isSpace(s.charCodeAt(k))) k++
    if (s[k] !== '=') {
      i = j
      continue
    }
    k++
    while (k < n && isSpace(s.charCodeAt(k))) k++
    const q = s[k]
    if (q !== '"' && q !== "'") {
      i = k
      continue
    }
    const close = s.indexOf(q, k + 1)
    if (close < 0) break
    const value = decodeXml(s.slice(k + 1, close))
    out[name] = value
    const colon = name.indexOf(':')
    if (colon >= 0) local.push([name.slice(colon + 1), value])
    i = close + 1
  }
  for (const [k, v] of local) if (!(k in out)) out[k] = v
  return out
}

interface XmlElement {
  /** Where its start tag begins and where the element ends (past its closing tag). */
  start: number
  end: number
  /** The text of its start tag after the name: its attributes. */
  attrs: string
  /** What is between its tags; '' for `<x/>`. */
  inner: string
}

/**
 * Every element called `local` (any prefix) in `xml[from, to)`, in order: found with `indexOf`, the start tag's end
 * and the matching closing tag each searched for once, so the scan is one forward pass over the text. Elements of
 * the same name are not nested in the parts read here. An element with no `>` or no closing tag ends the scan:
 * nothing after it is read.
 */
export function* elements(xml: string, local: string, from = 0, to = xml.length): Generator<XmlElement> {
  let i = from
  while (i < to) {
    const lt = xml.indexOf('<', i)
    if (lt < 0 || lt >= to) return
    let j = lt + 1
    while (j < to && isNameChar(xml.charCodeAt(j))) j++
    if (j === lt + 1) {
      i = j
      continue
    }
    const qname = xml.slice(lt + 1, j)
    const colon = qname.lastIndexOf(':')
    if ((colon >= 0 ? qname.slice(colon + 1) : qname) !== local) {
      i = j
      continue
    }
    const gt = xml.indexOf('>', j)
    if (gt < 0 || gt >= to) return
    if (xml.charCodeAt(gt - 1) === 47 /* / */) {
      yield { start: lt, end: gt + 1, attrs: xml.slice(j, gt - 1), inner: '' }
      i = gt + 1
      continue
    }
    const closer = `</${qname}`
    let k = xml.indexOf(closer, gt + 1)
    while (k >= 0 && k < to && isNameChar(xml.charCodeAt(k + closer.length))) k = xml.indexOf(closer, k + closer.length)
    if (k < 0 || k >= to) return
    const ce = xml.indexOf('>', k + closer.length)
    if (ce < 0 || ce >= to) return
    yield { start: lt, end: ce + 1, attrs: xml.slice(j, gt), inner: xml.slice(gt + 1, k) }
    i = ce + 1
  }
}

/** The first element called `local` in `xml`, or undefined. */
function firstElement(xml: string, local: string): XmlElement | undefined {
  for (const e of elements(xml, local)) return e
  return undefined
}

/** Every `<t>` in a fragment, joined — a shared string's runs, an inline string — without the phonetic guides (`<rPh>`). */
function textRuns(fragment: string): string {
  let plain = fragment
  if (fragment.includes('rPh')) {
    plain = ''
    let last = 0
    for (const e of elements(fragment, 'rPh')) {
      plain += fragment.slice(last, e.start)
      last = e.end
    }
    plain += fragment.slice(last)
  }
  let out = ''
  for (const t of elements(plain, 't')) out += t.inner
  return decodeXml(out)
}

// ── Dates ───────────────────────────────────────────────────────────

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56])

type DateStyle = 'date' | 'datetime' | 'time' | undefined

/** Whether a number format shows a date, a date and time, or a time — or none of them. */
export function dateStyleOf(id: number, code: string | undefined): DateStyle {
  if (BUILTIN_DATE.has(id)) return id === 22 ? 'datetime' : 'date'
  if (BUILTIN_TIME.has(id)) return 'time'
  // Excel keeps a format code to 255 characters; a longer one is not a date format this reader will scan.
  if (!code || code.length > 1024) return undefined
  // Quoted text, escaped characters, colours and conditions are not tokens; `[h]`-style elapsed times are durations.
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0]
  if (/general/i.test(bare) || !bare) return undefined
  const date = /[yd]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare))
  const time = /[hs]/i.test(bare) || /am\/pm|a\/p/i.test(bare)
  return date && time ? 'datetime' : date ? 'date' : time ? 'time' : undefined
}

const DAY_MS = 86_400_000
const EPOCH_1900 = Date.UTC(1899, 11, 30)

/** A serial date number as ISO text: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, or `HH:MM:SS` for a time of day. */
export function excelDate(serial: number, style: Exclude<DateStyle, undefined>, date1904 = false): string | undefined {
  // The 1900 system counts a 29 February 1900 that never was: before it, serials are a day early. Excel has no dates
  // before 1900; the negative serials some writers use for them count back from the same epoch as everything after.
  const days = date1904 ? serial + 1462 : serial > 0 && serial < 61 ? serial + 1 : serial
  const at = new Date(EPOCH_1900 + Math.round(days * DAY_MS / 1000) * 1000)
  // A serial no calendar reaches (1e300 in a date-formatted cell) is a number, not a date.
  if (Number.isNaN(at.getTime())) return undefined
  const iso = at.toISOString()
  if (style === 'time') return iso.slice(11, 19)
  return style === 'date' ? iso.slice(0, 10) : iso.slice(0, 19)
}

// ── The workbook ────────────────────────────────────────────────────

/** A cell reference's column (`A1` → 0, `AB7` → 27), or -1. */
function colOf(ref: string): number {
  let c = 0
  let i = 0
  for (; i < ref.length; i++) {
    const ch = ref.charCodeAt(i)
    if (ch >= 65 && ch <= 90) c = c * 26 + (ch - 64)
    else if (ch >= 97 && ch <= 122) c = c * 26 + (ch - 96)
    else break
  }
  return i ? c - 1 : -1
}

export interface ReadXlsxOptions {
  name?: string
  limits?: DatasetFileLimits
  /** Only this sheet, by name. */
  sheet?: string
}

/** The sheets a workbook may have read at once: past this, it is a pile of tables, not a dataset per sheet. */
export const MAX_SHEETS = 100
/** Rows read between breaths, so a long sheet never holds the page for more than a slice. */
const ROWS_PER_SLICE = 2_000

/**
 * A workbook's sheets as datasets' data, in the workbook's order: each visible sheet with anything in it (or only
 * the one named). Bounded by the file limits — the members' inflated size, and each sheet's rows, columns and cells,
 * checked as the sheet is read.
 */
export async function readXlsx(bytes: Uint8Array, opts: ReadXlsxOptions = {}): Promise<XlsxSheet[]> {
  const name = opts.name ?? 'The workbook'
  const limits = opts.limits ?? DATASET_FILE_LIMITS
  const entries = zipEntries(bytes, name)
  const budget = { left: limits.inflatedBytes, limit: limits.inflatedBytes }
  const part = async (path: string) => {
    const e = entries.get(path)
    return e ? entryText(bytes, e, budget, name) : undefined
  }
  const workbook = await part('xl/workbook.xml')
  if (workbook === undefined) throw new Error(`${name} is not an Excel workbook (.xlsx) — it has no workbook in it${entries.has('word/document.xml') ? ' (it is a Word document)' : ''}.`)
  const pr = firstElement(workbook, 'workbookPr')
  const date1904 = pr !== undefined && /^(?:1|true)$/i.test(attrs(pr.attrs).date1904 ?? '')

  // Sheets and where each lives.
  const rels = new Map<string, string>()
  for (const m of elements((await part('xl/_rels/workbook.xml.rels')) ?? '', 'Relationship')) {
    const a = attrs(m.attrs)
    if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, '')}`)
  }
  const sheets: { name: string; path: string; hidden: boolean }[] = []
  for (const m of elements(workbook, 'sheet')) {
    const a = attrs(m.attrs)
    const path = rels.get(a['r:id'] ?? a.id ?? '')
    if (path && a.name) sheets.push({ name: a.name, path: path.replace(/\/[^/]+\/\.\.\//g, '/'), hidden: a.state === 'hidden' || a.state === 'veryHidden' })
  }
  let wanted = opts.sheet !== undefined ? sheets.filter((s) => s.name === opts.sheet) : sheets.filter((s) => !s.hidden)
  if (opts.sheet !== undefined && !wanted.length) throw new Error(`${name} has no sheet called ${JSON.stringify(opts.sheet)} — its sheets are ${sheets.map((s) => JSON.stringify(s.name)).join(', ')}.`)
  if (!wanted.length) wanted = sheets
  if (wanted.length > MAX_SHEETS) throw new DatasetTooLargeError(`${name} has ${wanted.length.toLocaleString('en-US')} sheets — a workbook is read as at most ${MAX_SHEETS} datasets. Name the sheet to read.`)

  // Shared strings and which styles are dates.
  const shared: string[] = []
  const sst = await part('xl/sharedStrings.xml')
  if (sst) {
    for (const m of elements(sst, 'si')) {
      shared.push(m.inner ? textRuns(m.inner) : '')
      if (shared.length > limits.cells) throw new DatasetTooLargeError(`${name} holds more than ${limits.cells.toLocaleString('en-US')} strings — more than a dataset from a file keeps.`)
    }
  }
  const dateStyles: DateStyle[] = []
  const styles = await part('xl/styles.xml')
  if (styles) {
    const codes = new Map<number, string>()
    for (const m of elements(styles, 'numFmt')) {
      const a = attrs(m.attrs)
      if (a.numFmtId) codes.set(Number(a.numFmtId), a.formatCode ?? '')
    }
    const xfs = firstElement(styles, 'cellXfs')?.inner ?? ''
    for (const m of elements(xfs, 'xf')) {
      const id = Number(attrs(m.attrs).numFmtId ?? 0)
      dateStyles.push(dateStyleOf(id, codes.get(id)))
    }
  }

  const out: XlsxSheet[] = []
  // The cells' text across every sheet read, against one budget.
  const text = { left: cellTextLimit(limits) }
  for (const s of wanted) {
    const xml = await part(s.path)
    if (xml === undefined) continue
    const data = await readSheet(xml, { shared, dateStyles, date1904, name: `${name} › ${s.name}`, limits, text })
    if (data) out.push({ name: s.name, data })
    // Let the page breathe between sheets.
    await new Promise<void>((r) => setTimeout(r, 0))
  }
  if (!out.length) throw new Error(`${name} has no cells to read${opts.sheet !== undefined ? ` on ${JSON.stringify(opts.sheet)}` : ''}.`)
  return out
}

interface SheetContext {
  shared: string[]
  dateStyles: DateStyle[]
  date1904: boolean
  name: string
  limits: DatasetFileLimits
  /** Characters of cell text still allowed, shared by the workbook's sheets. */
  text: { left: number }
}

/**
 * One sheet's cells as a table — its first non-empty row the header — or undefined when it has none. Each cell's
 * text is charged to the workbook's budget as it is read: a shared string is stored once and may fill every cell.
 */
export async function readSheet(xml: string, ctx: SheetContext): Promise<DatasetData | undefined> {
  const { limits } = ctx
  const sheetData = xml.indexOf('sheetData')
  const body = sheetData < 0 ? xml : xml.slice(sheetData)
  const byRow = new Map<number, unknown[]>()
  let nextRow = 0
  let width = 0
  let first = Infinity
  let last = -1
  let cells = 0
  let sinceBreath = 0
  const textLimit = cellTextLimit(limits)
  for (const rm of elements(body, 'row')) {
    if (++sinceBreath >= ROWS_PER_SLICE) {
      sinceBreath = 0
      await new Promise<void>((r) => setTimeout(r, 0))
    }
    const ra = attrs(rm.attrs)
    const r = ra.r ? Number(ra.r) - 1 : nextRow
    nextRow = r + 1
    if (!rm.inner || !Number.isFinite(r) || r < 0) continue
    const row: unknown[] = []
    let nextCol = 0
    for (const cm of elements(rm.inner, 'c')) {
      const ca = attrs(cm.attrs)
      const c = ca.r ? colOf(ca.r) : nextCol
      nextCol = c + 1
      if (c < 0 || !cm.inner) continue
      const v = cellValue(ca.t, ca.s, cm.inner, ctx)
      if (v === null) continue
      if (typeof v === 'string') {
        ctx.text.left -= v.length
        if (ctx.text.left < 0) throw new DatasetTooLargeError(`${ctx.name} holds more than ${Math.round(textLimit / (1024 * 1024))} million characters of cell text — more than a table read from a file keeps.`)
      }
      if (c >= limits.columns) throw new DatasetTooLargeError(`${ctx.name} has cells in column ${c + 1} — a dataset from a file keeps at most ${limits.columns.toLocaleString('en-US')} columns.`)
      row[c] = v
      if (c + 1 > width) width = c + 1
      if (++cells > limits.cells) throw new DatasetTooLargeError(`${ctx.name} has more than ${limits.cells.toLocaleString('en-US')} cells — more than a dataset from a file keeps.`)
    }
    if (!row.length) continue
    if (r < first) first = r
    if (r > last) last = r
    // The header row is not a data row: one more than the row bound, counted from the first row with anything in it.
    if (last - first > limits.rows) throw new DatasetTooLargeError(`${ctx.name} has more than ${limits.rows.toLocaleString('en-US')} rows — a dataset from a file keeps at most ${limits.rows.toLocaleString('en-US')}. Split it, or filter it before attaching it.`)
    byRow.set(r, row)
  }
  if (!byRow.size) return undefined
  const headerRow = byRow.get(first) ?? []
  const headers = Array.from({ length: width }, (_, i) => (headerRow[i] === undefined || headerRow[i] === null ? '' : cellText(headerRow[i])))
  const fallback = letters(width)
  const count = last - first
  checkShape(ctx.name, count, width, limits)
  const rows: unknown[][] = []
  for (let r = first + 1; r <= last; r++) {
    const row = byRow.get(r)
    rows.push(row ? Array.from({ length: width }, (_, i) => row[i] ?? null) : new Array(width).fill(null))
  }
  const columns = columnsFromHeaders(headers.map((h, i) => h || fallback[i]))
  return { columns, rows: squareRows(rows, columns.length) }
}

/** A cell's value by its type (`t`) and style (`s`): shared or inline text, a number (a date when its format is one), a boolean, an error's code. */
function cellValue(t: string | undefined, s: string | undefined, inner: string, ctx: SheetContext): unknown {
  if (t === 'inlineStr') {
    const text = textRuns(inner)
    return text === '' ? null : text
  }
  const raw = firstElement(inner, 'v')?.inner
  if (raw === undefined) return null
  if (t === 's') {
    const text = ctx.shared[Number(raw)]
    return text === undefined || text === '' ? null : text
  }
  if (t === 'b') return raw.trim() === '1' || raw.trim() === 'true'
  if (t === 'str' || t === 'e' || t === 'd') {
    const text = decodeXml(raw)
    return text === '' ? null : text
  }
  const num = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(num)) {
    const text = decodeXml(raw)
    return text === '' ? null : text
  }
  const style = s !== undefined ? ctx.dateStyles[Number(s)] : undefined
  return (style && excelDate(num, style, ctx.date1904)) || num
}

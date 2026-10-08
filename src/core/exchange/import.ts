import type { EntityStore } from '../entity/store'
import type { AegraphDocument, AnyEntity, TagInfo } from '../entity/types'
import { CsvParser, csvRowToEntity, detectFormat, normalizeEntity, normalizeTagInfo, supportsGzip, type FormatId } from './formats'
import { yieldToUi } from './export'
import { isPacked, PACK_MAGIC, unpackDocument, type PackedDocument } from './pack/pack'
import { boundedStream, gunzipBytes, MAX_PACK_INFLATED_BYTES } from './gunzip'

export interface ImportProgress {
  phase: 'reading' | 'indexing' | 'done'
  /** Bytes read so far (reading) or entities indexed (indexing). */
  done: number
  total: number
  count: number
}

export interface ImportOptions {
  format?: FormatId
  gzip?: boolean
  /** `merge` upserts into the current store; `replace` clears it first. */
  mode?: 'merge' | 'replace'
  onProgress?: (p: ImportProgress) => void
  signal?: AbortSignal
}

export interface ImportResult {
  count: number
  tags: number
  skipped: number
  ms: number
  format: FormatId
}

/** Parsed-but-not-yet-loaded content. Lets callers preview or combine sources before committing. */
export interface ParsedDocument {
  entities: AnyEntity[]
  tags: TagInfo[]
  skipped: number
}

/**
 * Streams a File into entities. JSONL and CSV are parsed incrementally; JSON
 * is read whole (a streaming JSON parser isn't worth its weight here — use
 * JSONL for big files).
 */
export async function parseFile(file: File, opts: ImportOptions = {}): Promise<ParsedDocument & { format: FormatId }> {
  const detected = detectFormat(file.name)
  const format = opts.format ?? detected?.format
  if (!format) throw new Error(`Can't tell the format of “${file.name}”. Use .ae.json / .json, .jsonl, .csv (optionally .gz) or .aeb.`)
  const gzip = opts.gzip ?? detected?.gzip ?? false
  if (gzip && !supportsGzip()) throw new Error('This browser cannot decompress gzip in-page')

  if (format === 'pack') {
    const out: ParsedDocument = { entities: [], tags: [], skipped: 0 }
    const doc = await readPack(new Uint8Array(await file.arrayBuffer()))
    opts.onProgress?.({ phase: 'reading', done: file.size, total: file.size, count: 0 })
    for (const t of doc.tags) pushTag(out, t)
    for (let i = 0; i < doc.entities.length; i++) {
      pushEntity(out, doc.entities[i], `import-${i}`)
      if (i % 20000 === 0) await yieldToUi()
    }
    return { ...out, format }
  }

  // lib.dom types BufferSource for these transforms; the runtime pairs are fine.
  let stream = file.stream() as ReadableStream<BufferSource>
  // Gzip expands without bound, so what comes out is counted and refused past the limit (see `gunzip.ts`).
  if (gzip) stream = boundedStream(stream.pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>) as unknown as ReadableStream<BufferSource>
  const text = stream.pipeThrough(new TextDecoderStream())

  const out: ParsedDocument = { entities: [], tags: [], skipped: 0 }
  const report = (bytes: number) => opts.onProgress?.({ phase: 'reading', done: bytes, total: file.size, count: out.entities.length })

  if (format === 'json') {
    const whole = await readAll(text, file.size, report, opts.signal)
    const doc = JSON.parse(whole) as Partial<AegraphDocument> | unknown[]
    const list = Array.isArray(doc) ? doc : Array.isArray(doc.entities) ? doc.entities : undefined
    if (!list) throw new Error('JSON must be an aegraph document ({ entities: [...] }) or an array of entities')
    if (!Array.isArray(doc)) for (const t of doc.tags ?? []) pushTag(out, t)
    for (let i = 0; i < list.length; i++) {
      pushEntity(out, list[i], `import-${i}`)
      if (i % 20000 === 0) await yieldToUi()
    }
    return { ...out, format }
  }

  if (format === 'jsonl') {
    let lineNo = 0
    await readLines(text, file.size, report, opts.signal, (line) => {
      lineNo++
      if (!line.trim()) return
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        out.skipped++
        return
      }
      if (obj && typeof obj === 'object' && '$schema' in (obj as object)) return
      if (obj && typeof obj === 'object' && '$tag' in (obj as object)) pushTag(out, obj)
      else pushEntity(out, obj, `line-${lineNo}`)
    })
    return { ...out, format }
  }

  // csv
  const parser = new CsvParser()
  let header: string[] | undefined
  const onRow = (row: string[]) => {
    if (!header) {
      header = row.map((h) => h.trim().toLowerCase())
      return
    }
    const e = csvRowToEntity(header, row)
    if (e) out.entities.push(e)
    else out.skipped++
  }
  await readChunks(text, file.size, report, opts.signal, (chunk) => parser.push(chunk, onRow))
  parser.end(onRow)
  return { ...out, format }
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b

/**
 * The bytes of an `.aeb` — a pack, gzipped or not — as a document; a gzipped one may become up to `limitBytes`. A gzip
 * that does not hold a pack (an `.ae.json.gz`) is told from its first inflated bytes and refused before the rest is
 * inflated: the text path reads it under its own, lower ceiling, and it was once inflated under both.
 */
export async function readPack(bytes: Uint8Array, limitBytes = MAX_PACK_INFLATED_BYTES): Promise<PackedDocument> {
  if (isGzip(bytes)) {
    if (!(await gzipHoldsPack(bytes))) throw new Error('Not an aegraph pack (.aeb).')
    bytes = await gunzipBytes(bytes, limitBytes)
  }
  if (!isPacked(bytes)) throw new Error('Not an aegraph pack (.aeb).')
  return unpackDocument(bytes)
}

/** Whether a gzip's content starts with the pack's magic: inflated only as far as the first chunk, then let go. */
export async function gzipHoldsPack(bytes: Uint8Array): Promise<boolean> {
  if (!supportsGzip()) return true
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  }) as ReadableStream<BufferSource>
  const reader = (source.pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>).getReader()
  const head = new Uint8Array(PACK_MAGIC.length)
  let got = 0
  try {
    while (got < head.length) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(head.length - got, value.byteLength)
      head.set(value.subarray(0, take), got)
      got += take
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
  return got === head.length && PACK_MAGIC.every((b, i) => head[i] === b)
}

/**
 * A response's body as bytes, refused past `limitBytes` as it arrives. The browser undoes a `Content-Encoding`
 * (gzip, br) before the body is read, so what the server sent says nothing about what this becomes; `arrayBuffer()`
 * would read it to the end whatever its size. One buffer, sized from `Content-Length` when that is the body's.
 */
export async function readResponseBytes(res: Response, limitBytes = MAX_PACK_INFLATED_BYTES): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const declared = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0
  let out = new Uint8Array(declared > 0 && declared <= limitBytes ? declared : 1 << 20)
  let total = 0
  const reader = boundedStream(res.body, limitBytes).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > out.byteLength) {
      const grown = new Uint8Array(Math.min(limitBytes, Math.max(total + value.byteLength, out.byteLength * 2)))
      grown.set(out.subarray(0, total))
      out = grown
    }
    out.set(value, total)
    total += value.byteLength
  }
  return total === out.byteLength ? out : out.slice(0, total)
}

/** Whether bytes are an aegraph pack (possibly gzipped) rather than text. */
export const looksPacked = (bytes: Uint8Array) => isPacked(bytes) || (isGzip(bytes) && bytes.length > 12)

/** Parse then load into the store in one transaction. */
export async function importFile(file: File, store: EntityStore, opts: ImportOptions = {}): Promise<ImportResult> {
  const t0 = performance.now()
  const parsed = await parseFile(file, opts)
  await loadParsed(parsed, store, opts)
  return { count: parsed.entities.length, tags: parsed.tags.length, skipped: parsed.skipped, ms: performance.now() - t0, format: parsed.format }
}

/** How many entities go into the store between turns of the event loop on a big load. */
const INDEX_CHUNK = 25_000

export async function loadParsed(parsed: ParsedDocument, store: EntityStore, opts: Pick<ImportOptions, 'mode' | 'onProgress'> = {}) {
  opts.onProgress?.({ phase: 'indexing', done: 0, total: parsed.entities.length, count: parsed.entities.length })
  await yieldToUi()
  // In chunks, with the event loop between them: a million entities in one call is a six-second freeze, and the
  // page cannot even draw the progress it is being told about. The transaction still holds the events, so nothing
  // downstream sees a half-loaded store — only the progress does.
  await store.transactionAsync(async () => {
    if (opts.mode === 'replace') store.clear()
    for (const t of parsed.tags) store.setTagInfo(t.tag, t)
    if (parsed.entities.length <= INDEX_CHUNK) {
      store.upsertMany(parsed.entities)
      return
    }
    for (let i = 0; i < parsed.entities.length; i += INDEX_CHUNK) {
      store.upsertMany(parsed.entities.slice(i, i + INDEX_CHUNK))
      opts.onProgress?.({ phase: 'indexing', done: Math.min(i + INDEX_CHUNK, parsed.entities.length), total: parsed.entities.length, count: parsed.entities.length })
      await yieldToUi()
    }
  })
  opts.onProgress?.({ phase: 'done', done: parsed.entities.length, total: parsed.entities.length, count: parsed.entities.length })
}

// ── Stream helpers ─────────────────────────────────────────────────────

function pushEntity(out: ParsedDocument, raw: unknown, fallbackId: string) {
  const e = normalizeEntity(raw, fallbackId)
  if (e) out.entities.push(e)
  else out.skipped++
}

function pushTag(out: ParsedDocument, raw: unknown) {
  const t = normalizeTagInfo(raw)
  if (t) out.tags.push(t)
}

async function readChunks(
  text: ReadableStream<string>,
  total: number,
  report: (bytes: number) => void,
  signal: AbortSignal | undefined,
  onChunk: (chunk: string) => void,
) {
  const reader = text.getReader()
  let bytes = 0
  let sinceYield = 0
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new DOMException('Import cancelled', 'AbortError')
    }
    const { value, done } = await reader.read()
    if (done) break
    onChunk(value)
    bytes += value.length
    sinceYield += value.length
    if (sinceYield > 1_000_000) {
      sinceYield = 0
      report(Math.min(bytes, total))
      await yieldToUi()
    }
  }
  report(total)
}

async function readLines(
  text: ReadableStream<string>,
  total: number,
  report: (bytes: number) => void,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
) {
  let carry = ''
  await readChunks(text, total, report, signal, (chunk) => {
    const s = carry + chunk
    let start = 0
    for (;;) {
      const nl = s.indexOf('\n', start)
      if (nl < 0) break
      onLine(s.slice(start, nl))
      start = nl + 1
    }
    carry = s.slice(start)
  })
  if (carry) onLine(carry)
}

async function readAll(text: ReadableStream<string>, total: number, report: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  const parts: string[] = []
  await readChunks(text, total, report, signal, (c) => parts.push(c))
  return parts.join('')
}

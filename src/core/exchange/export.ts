import type { AegraphDocument, AnyEntity, TagInfo } from '../entity/types'
import { CSV_COLUMNS, csvEscape, entityToCsvRow, FORMATS, supportsGzip, type FormatId } from './formats'
import { packDocument } from './pack/pack'

export interface ExportSource {
  entities: AnyEntity[]
  tags?: TagInfo[]
  /** Bundle keys (json only): the project this file is, and the screen state to reopen it. */
  project?: string
  state?: AegraphDocument['state']
}

export interface ExportOptions {
  format: FormatId
  gzip?: boolean
  /** Pretty-print (json only). Off by default for size. */
  pretty?: boolean
  onProgress?: (done: number, total: number) => void
}

export interface ExportResult {
  blob: Blob
  filename: string
  ms: number
  bytes: number
  count: number
}

const CHUNK = 2000

/** Produces the file as string chunks so large exports never build one giant string. (The pack is bytes: see `packBytes`.) */
export function* serialize(source: ExportSource, format: FormatId, pretty = false): Generator<string, void, void> {
  const { entities, tags = [], project, state } = source
  if (format === 'pack') throw new Error('The pack is binary; use packBytes / exportToBlob.')
  if (format === 'json') {
    const exportedAt = new Date().toISOString()
    const bundle = project ? { project, ...(state ? { state } : {}) } : {}
    if (pretty) {
      yield JSON.stringify({ $schema: 'aegraph/v1', exportedAt, ...bundle, tags, entities }, null, 2)
      return
    }
    const head = project ? `"project":${JSON.stringify(project)},${state ? `"state":${JSON.stringify(state)},` : ''}` : ''
    yield `{"$schema":"aegraph/v1","exportedAt":${JSON.stringify(exportedAt)},${head}"tags":${JSON.stringify(tags)},"entities":[`
    for (let i = 0; i < entities.length; i += CHUNK) {
      const parts: string[] = []
      for (let j = i; j < Math.min(i + CHUNK, entities.length); j++) parts.push(JSON.stringify(entities[j]))
      yield (i > 0 ? ',' : '') + parts.join(',')
    }
    yield ']}'
    return
  }
  if (format === 'jsonl') {
    yield `{"$schema":"aegraph/v1","exportedAt":${JSON.stringify(new Date().toISOString())}}\n`
    if (tags.length) yield tags.map((t) => JSON.stringify({ $tag: t.tag, color: t.color, description: t.description })).join('\n') + '\n'
    for (let i = 0; i < entities.length; i += CHUNK) {
      const parts: string[] = []
      for (let j = i; j < Math.min(i + CHUNK, entities.length); j++) parts.push(JSON.stringify(entities[j]))
      yield parts.join('\n') + '\n'
    }
    return
  }
  // csv
  yield CSV_COLUMNS.join(',') + '\n'
  for (let i = 0; i < entities.length; i += CHUNK) {
    const parts: string[] = []
    for (let j = i; j < Math.min(i + CHUNK, entities.length); j++) parts.push(entityToCsvRow(entities[j]).map(csvEscape).join(','))
    yield parts.join('\n') + '\n'
  }
}

/** The pack of a source: the bytes of an `.aeb` before compression. */
export const packBytes = (source: ExportSource): Uint8Array => packDocument({ entities: source.entities, tags: source.tags ?? [], project: source.project, state: source.state })

export async function exportToBlob(source: ExportSource, opts: ExportOptions, baseName = 'workspace'): Promise<ExportResult> {
  const t0 = performance.now()
  const info = FORMATS[opts.format]
  if (opts.format === 'pack') {
    // Always gzipped when the browser can (the extension stays `.aeb`; readers look at the bytes).
    const raw = packBytes(source)
    let blob = new Blob([raw as BlobPart], { type: info.mime })
    if (opts.gzip !== false && supportsGzip()) blob = new Blob([await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob()], { type: info.mime })
    opts.onProgress?.(1, 1)
    return { blob, filename: baseName + info.extension, ms: performance.now() - t0, bytes: blob.size, count: source.entities.length }
  }
  const parts: string[] = []
  let done = 0
  const total = Math.max(1, Math.ceil(source.entities.length / CHUNK) + 2)
  for (const chunk of serialize(source, opts.format, opts.pretty)) {
    parts.push(chunk)
    done++
    if (opts.onProgress && done % 10 === 0) {
      opts.onProgress(done, total)
      await yieldToUi()
    }
  }
  let blob = new Blob(parts, { type: info.mime })
  let filename = baseName + info.extension
  if (opts.gzip) {
    if (!supportsGzip()) throw new Error('This browser cannot gzip in-page (CompressionStream unsupported)')
    const compressed = blob.stream().pipeThrough(new CompressionStream('gzip'))
    blob = await new Response(compressed).blob()
    blob = new Blob([blob], { type: 'application/gzip' })
    filename += '.gz'
  }
  opts.onProgress?.(total, total)
  return { blob, filename, ms: performance.now() - t0, bytes: blob.size, count: source.entities.length }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

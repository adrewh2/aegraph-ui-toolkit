/**
 * Decompression with a ceiling.
 *
 * A bundle may arrive gzipped — `.aeb`, `.ae.json.gz` — from a file someone
 * sends, a `/open?url=…` link, or an app that embeds this one and hands it
 * whatever a user uploaded. Compression ratios are unbounded: a megabyte of
 * zeros is gigabytes expanded, and `new Response(stream).text()` reads to the
 * end however far away that is, so one small file could take the tab, and the
 * product around it, out of memory. Nothing else here limits it: the file's own
 * `size` says nothing about what it becomes.
 *
 * So decompression reads in chunks and stops the moment the total passes a
 * limit, cancelling the stream rather than filling the heap. The limit is
 * generous next to a real bundle and is an argument, so an embedder can set
 * its own.
 */

/** How much a gzipped bundle may become before it is refused. Generous: a real project is orders of magnitude under it. */
export const MAX_INFLATED_BYTES = 128 * 1024 * 1024

/**
 * How much a gzipped **pack** (`.aeb`) may become. A pack is the form for the
 * very big projects — it decodes straight into entities, with no copy of the
 * text beside them — and those are hundreds of megabytes decoded: the
 * million-entity conversation atlas among the demos is 342 MB (92 MB on the
 * wire), Toronto's 688,335 street trees 102 MB. Text (`.ae.json.gz`) keeps the
 * lower ceiling, because it is parsed whole and costs twice its size.
 */
export const MAX_PACK_INFLATED_BYTES = 512 * 1024 * 1024

export class TooLargeError extends Error {
  readonly limitBytes: number
  constructor(limitBytes: number) {
    super(`This file decompresses to more than ${Math.round(limitBytes / (1024 * 1024))} MB, so it is not being read. A project bundle is far smaller than that; a file this size is either not a bundle or is built to exhaust memory.`)
    this.name = 'TooLargeError'
    this.limitBytes = limitBytes
  }
}

export const supportsGunzip = () => typeof DecompressionStream !== 'undefined'

/**
 * Read a stream to the end, refusing past `limitBytes`. The chunks are handed
 * back as they arrive so a caller can decode or count them; the running total
 * is what is checked, not any one chunk.
 */
async function readBounded(stream: ReadableStream<Uint8Array>, limitBytes: number, take: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (!value) continue
      total += value.byteLength
      if (total > limitBytes) throw new TooLargeError(limitBytes)
      take(value)
    }
  } finally {
    // Whether it ended, threw or was refused: let go of the source rather than leave it draining.
    reader.releaseLock?.()
    await stream.cancel().catch(() => {})
  }
}

/**
 * A gzipped stream as bytes, refusing past `limitBytes`. The output is one
 * buffer written as the chunks arrive — sized from `sizeHint` when there is
 * one, grown by doubling when not (or when the hint was wrong) — never a list
 * of chunks joined at the end: that held the whole output twice at its peak,
 * 200 MB of a 100 MB pack.
 */
export async function gunzipStream(stream: ReadableStream<Uint8Array>, limitBytes = MAX_INFLATED_BYTES, sizeHint = 0): Promise<Uint8Array> {
  if (!supportsGunzip()) throw new Error('This browser cannot decompress gzip in-page')
  let out = new Uint8Array(sizeHint > 0 && sizeHint <= limitBytes ? sizeHint : 1 << 20)
  let total = 0
  await readBounded((stream as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>, limitBytes, (c) => {
    if (total + c.byteLength > out.byteLength) {
      const grown = new Uint8Array(Math.min(limitBytes, Math.max(total + c.byteLength, out.byteLength * 2)))
      grown.set(out.subarray(0, total))
      out = grown
    }
    out.set(c, total)
    total += c.byteLength
  })
  return total === out.byteLength ? out : out.slice(0, total)
}

/**
 * The size a gzip file says it holds: its last four bytes, the uncompressed
 * length modulo 2³² (RFC 1952). Only a hint — a file of several members
 * gives the last one's — so `gunzipStream` grows past it when it is short.
 */
export function gzipSizeHint(bytes: Uint8Array): number {
  const n = bytes.byteLength
  if (n < 18) return 0
  return (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0
}

/** The bytes as a stream, without the copy a `Blob` makes of them. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Gzipped bytes as bytes, refusing past `limitBytes`. */
export const gunzipBytes = (bytes: Uint8Array, limitBytes = MAX_INFLATED_BYTES): Promise<Uint8Array> => gunzipStream(streamOf(bytes), limitBytes, gzipSizeHint(bytes))

/** Gzipped bytes as text, refusing past `limitBytes` of decompressed data (counted before it is decoded). */
export const gunzipText = (bytes: Uint8Array, limitBytes = MAX_INFLATED_BYTES): Promise<string> => inflateText(bytes, 'gzip', limitBytes)

/**
 * Raw-deflated bytes as text — one member of a zip file (a spreadsheet's sheet, its shared strings) — refusing past
 * `limitBytes`, like a gzip. A zip says how large each member is, but that is the file's word, not a bound.
 */
export const inflateRawText = (bytes: Uint8Array, limitBytes = MAX_INFLATED_BYTES): Promise<string> => inflateText(bytes, 'deflate-raw', limitBytes)

async function inflateText(bytes: Uint8Array, format: 'gzip' | 'deflate-raw', limitBytes: number): Promise<string> {
  if (!supportsGunzip()) throw new Error('This browser cannot decompress in-page')
  const decoder = new TextDecoder()
  let text = ''
  const source = streamOf(bytes) as ReadableStream<BufferSource>
  await readBounded(source.pipeThrough(new DecompressionStream(format)) as ReadableStream<Uint8Array>, limitBytes, (c) => {
    text += decoder.decode(c, { stream: true })
  })
  return text + decoder.decode()
}

/**
 * A `ReadableStream` that refuses past `limitBytes`, for the streaming reader
 * (`import.ts`) which decodes as it goes and must not be made to buffer.
 */
export function boundedStream(stream: ReadableStream<Uint8Array>, limitBytes = MAX_INFLATED_BYTES): ReadableStream<Uint8Array> {
  let total = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > limitBytes) throw new TooLargeError(limitBytes)
        controller.enqueue(chunk)
      },
    }),
  )
}

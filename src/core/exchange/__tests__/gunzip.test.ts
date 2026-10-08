import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { boundedStream, gunzipBytes, gunzipText, MAX_INFLATED_BYTES, MAX_PACK_INFLATED_BYTES, TooLargeError } from '../gunzip'

/**
 * A gzipped bundle arrives from a file someone sent, an `/open?url=…` link, or
 * a product that embeds this one and hands it what a user uploaded. Compression
 * ratios are unbounded, so what matters is that decompression stops rather than
 * filling the heap — and that an ordinary bundle is untouched by the limit.
 */
const streamOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]).stream() as ReadableStream<BufferSource>

describe('decompressing with a ceiling', () => {
  it('reads an ordinary bundle exactly', async () => {
    const doc = JSON.stringify({ $schema: 'aegraph/v1', entities: [{ id: 'a', type: 'note', label: 'Kyoto' }] })
    const gz = new Uint8Array(gzipSync(Buffer.from(doc)))
    expect(await gunzipText(gz)).toBe(doc)
    expect(new TextDecoder().decode(await gunzipBytes(gz))).toBe(doc)
  })

  it('refuses a bomb instead of inflating it — 8 MB of zeros in a few hundred bytes, against a 1 MB limit', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(8 * 1024 * 1024)))
    // The point of the case: the file is tiny and what it becomes is not.
    expect(bomb.byteLength).toBeLessThan(20_000)

    await expect(gunzipText(bomb, 1024 * 1024)).rejects.toThrow(TooLargeError)
    await expect(gunzipBytes(bomb, 1024 * 1024)).rejects.toThrow(/decompresses to more than 1 MB/)
  })

  it('says how big the limit was, so a caller can tell the user', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(4 * 1024 * 1024)))
    const err = await gunzipText(bomb, 64 * 1024).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect((err as TooLargeError).limitBytes).toBe(64 * 1024)
  })

  it('the streaming form refuses too, for the reader that decodes as it goes', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(4 * 1024 * 1024)))
    const inflated = streamOf(bomb).pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>
    const reader = boundedStream(inflated, 32 * 1024).getReader()
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return
        }
      })(),
    ).rejects.toThrow(TooLargeError)
  })

  it('has a limit far above any real bundle, so nothing ordinary is refused', () => {
    // The largest dataset this repo ships is a little over a megabyte.
    expect(MAX_INFLATED_BYTES).toBeGreaterThan(64 * 1024 * 1024)
    // A pack is the form for the very big projects: the million-entity demo decodes to 342 MB, and must open.
    expect(MAX_PACK_INFLATED_BYTES).toBeGreaterThanOrEqual(400 * 1024 * 1024)
    // Still a ceiling: well inside the 4 GB a tab's heap gets, so a bomb dressed as a pack is refused.
    expect(MAX_PACK_INFLATED_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024)
  })
})

describe('one buffer, sized from the trailer', () => {
  it('reads the size a gzip file records, and decompresses into exactly that', async () => {
    const { gzipSync } = await import('node:zlib')
    const { gunzipBytes, gzipSizeHint } = await import('../gunzip')
    const raw = new Uint8Array(3_000_000).map((_, i) => (i * 7) & 255)
    const gz = new Uint8Array(gzipSync(raw))
    expect(gzipSizeHint(gz)).toBe(raw.byteLength)
    const out = await gunzipBytes(gz)
    expect(out.byteLength).toBe(raw.byteLength)
    expect(out.buffer.byteLength).toBe(raw.byteLength)
    expect(Buffer.from(out).equals(Buffer.from(raw))).toBe(true)
  })

  it('is right when the trailer is wrong (several members), growing past it', async () => {
    const { gzipSync } = await import('node:zlib')
    const { gunzipBytes, gzipSizeHint } = await import('../gunzip')
    const a = new Uint8Array(2_000_000).fill(1)
    const b = new Uint8Array(1000).fill(2)
    const gz = new Uint8Array(Buffer.concat([gzipSync(a), gzipSync(b)]))
    expect(gzipSizeHint(gz)).toBe(1000)
    const out = await gunzipBytes(gz)
    expect(out.byteLength).toBe(2_001_000)
    expect(out[0]).toBe(1)
    expect(out[2_000_500]).toBe(2)
  })

  it('still refuses past the limit, whatever the trailer claims', async () => {
    const { gzipSync } = await import('node:zlib')
    const { gunzipBytes, TooLargeError } = await import('../gunzip')
    const gz = new Uint8Array(gzipSync(new Uint8Array(5_000_000)))
    // A trailer rewritten to claim a few bytes.
    gz.set([10, 0, 0, 0], gz.byteLength - 4)
    await expect(gunzipBytes(gz, 1_000_000)).rejects.toBeInstanceOf(TooLargeError)
  })
})

describe('a zip member (raw deflate) — what a spreadsheet is made of', () => {
  it('reads one exactly, and refuses one that inflates past the limit', async () => {
    const { deflateRawSync } = await import('node:zlib')
    const { inflateRawText, TooLargeError } = await import('../gunzip')
    const xml = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'
    expect(await inflateRawText(new Uint8Array(deflateRawSync(Buffer.from(xml))))).toBe(xml)
    const bomb = new Uint8Array(deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x20)))
    expect(bomb.byteLength).toBeLessThan(20_000)
    await expect(inflateRawText(bomb, 1024 * 1024)).rejects.toBeInstanceOf(TooLargeError)
  })
})

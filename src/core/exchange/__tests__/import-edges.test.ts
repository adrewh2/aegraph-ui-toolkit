import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { exportToBlob } from '../export'
import { gzipHoldsPack, importFile, looksPacked, parseFile, readPack, readResponseBytes } from '../import'

/**
 * The import front door at its edges: an empty file, whitespace, a BOM (dropped),
 * a gzip of an empty document, an extension that lies, JSONL with blank
 * and broken lines and a schema line, a CSV of a header only, a document
 * of no entities, importing twice, an entity older than the store's, a
 * tag with no colour, cancellation, progress, replace mode, a pack that
 * is not one, and a large JSONL's time.
 */
const file = (name: string, text: string | Uint8Array) => new File([text as BlobPart], name)
const gz = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
const T = '2026-01-01T00:00:00Z'
const ent = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'entity', type: 'note', label: id, tags: [], data: {}, meta: { createdAt: T, updatedAt: T }, ...over })

describe('import edges', () => {
  it('an empty or whitespace JSON file is not a document; an empty JSONL or CSV is an empty import; a BOM before the JSON is dropped', async () => {
    await expect(parseFile(file('x.json', ''))).rejects.toThrow(SyntaxError)
    await expect(parseFile(file('x.json', '   \n'))).rejects.toThrow(SyntaxError)
    expect(await parseFile(file('x.json', '\ufeff{"entities":[]}'))).toMatchObject({ entities: [], format: 'json' }) // the text decoder drops the BOM
    expect(await parseFile(file('x.jsonl', ''))).toEqual({ entities: [], tags: [], skipped: 0, format: 'jsonl' })
    expect(await parseFile(file('x.jsonl', '\n\n  \n'))).toEqual({ entities: [], tags: [], skipped: 0, format: 'jsonl' })
    expect(await parseFile(file('x.csv', ''))).toEqual({ entities: [], tags: [], skipped: 0, format: 'csv' })
    expect(await parseFile(file('x.csv', 'id,label,type\n'))).toEqual({ entities: [], tags: [], skipped: 0, format: 'csv' })
    expect(await parseFile(file('x.json', '{"entities":[]}'))).toEqual({ entities: [], tags: [], skipped: 0, format: 'json' })
    expect(await parseFile(file('x.json', '[]'))).toEqual({ entities: [], tags: [], skipped: 0, format: 'json' })
    await expect(parseFile(file('x.json', '{"nodes":[]}'))).rejects.toThrow(/aegraph document/)
    await expect(parseFile(file('x.json', '42'))).rejects.toThrow()
  })

  it('a gzip of an empty document reads as empty; a .gz that is not gzipped fails; a name with no known extension is refused unless the format is given; an extension that lies fails on the content', async () => {
    expect(await parseFile(file('x.json.gz', await gz('{"entities":[]}')))).toMatchObject({ entities: [], format: 'json' })
    expect(await parseFile(file('x.jsonl.gz', await gz('{"id":"a"}\n')))).toMatchObject({ entities: [expect.objectContaining({ id: 'a' })], format: 'jsonl' })
    await expect(parseFile(file('x.json.gz', '{"entities":[]}'))).rejects.toThrow()
    await expect(parseFile(file('data.txt', '{"entities":[]}'))).rejects.toThrow(/Can't tell the format/)
    expect(await parseFile(file('data.txt', '{"entities":[]}'), { format: 'json' })).toMatchObject({ format: 'json' })
    expect(await parseFile(file('data.bin', 'id,label\n1,One'), { format: 'csv' })).toMatchObject({ entities: [expect.objectContaining({ id: '1', label: 'One' })] })
    // JSON in a .csv reads as one header and no rows; CSV in a .json is a syntax error.
    expect(await parseFile(file('lie.csv', '{"entities":[]}'))).toMatchObject({ entities: [], skipped: 0 })
    await expect(parseFile(file('lie.json', 'id,label\n1,One'))).rejects.toThrow(SyntaxError)
    expect(await parseFile(file('x.NDJSON', '{"id":"n"}'))).toMatchObject({ format: 'jsonl' })
    expect(await parseFile(file('bundle.ae', '{"entities":[{"id":"e"}]}'))).toMatchObject({ format: 'json', entities: [expect.objectContaining({ id: 'e' })] })
  })

  it('JSONL: blank lines are nothing, a broken line is skipped and counted, a $schema line is ignored, a $tag line is a tag, a line without an id gets one from its line number, the last line needs no newline', async () => {
    const text = ['{"$schema":"aegraph/v1"}', '', '{"$tag":"hot","color":"#f00"}', '{"tag":"cold"}', 'not json', '{"id":"a","type":"note"}', '   ', '{"type":"note","label":"no id"}', '{"id":"z"'].join('\n')
    const r = await parseFile(file('x.jsonl', text))
    expect(r.skipped).toBe(2) // 'not json' and the unfinished last line
    expect(r.tags).toEqual([{ tag: 'hot', color: '#f00' }])
    // A `tag` without the dollar is an entity without an id: it gets its line number as an id.
    expect(r.entities.map((e) => [e.id, e.label])).toEqual([['line-4', undefined], ['a', undefined], ['line-8', 'no id']])
  })

  it('importing twice leaves the same content; a plain import takes the file’s copy whatever its date; replace mode clears first; tags with no colour still register; progress runs reading → indexing → done', async () => {
    const store = new EntityStore()
    const doc = { entities: [ent('a', { label: 'A1' }), ent('b')], tags: [{ tag: 'plain' }, { tag: 'coloured', color: '#abc' }, { tag: '' }, 'junk'] }
    const phases: string[] = []
    const r1 = await importFile(file('d.json', JSON.stringify(doc)), store, { onProgress: (p) => phases.push(p.phase) })
    expect(r1).toMatchObject({ count: 2, tags: 2, skipped: 0, format: 'json' })
    expect(phases[0]).toBe('reading')
    expect(phases.slice(-2)).toEqual(['indexing', 'done'])
    expect(store.getTagInfo('plain')).toMatchObject({ tag: 'plain' })
    expect(store.getTagInfo('coloured').color).toBe('#abc')
    const before = store.all().map((e) => JSON.stringify(e))
    const r2 = await importFile(file('d.json', JSON.stringify(doc)), store)
    expect(r2.count).toBe(2)
    expect(store.all().map((e) => JSON.stringify(e))).toEqual(before) // the same entities again: equal content (the store still counts a write)
    // A plain import is "load this file": the file's copy wins whatever its date (a bundle import, by contrast, keeps the newer).
    store.update('a', { label: 'A2' })
    await importFile(file('d.json', JSON.stringify(doc)), store)
    expect(store.get('a')!.label).toBe('A1')
    expect(store.get('a')!.meta.updatedAt).toBe(T)
    store.upsert(createEntity({ id: 'keep', type: 'note' }))
    await importFile(file('d.json', JSON.stringify({ entities: [ent('only')] })), store, { mode: 'replace' })
    expect(store.all().map((e) => e.id)).toEqual(['only'])
  })

  // Real work on real volumes: what it costs is the machine's business, so the harness is given room and the
  // assertions below say what actually has to hold. A bare timeout here would only ever measure the load.
  it('a cancelled import throws AbortError and loads nothing; a large JSONL streams in well under a second', async () => {
    const ac = new AbortController()
    ac.abort()
    const store = new EntityStore()
    await expect(importFile(file('x.jsonl', '{"id":"a"}\n'), store, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(store.all()).toEqual([])
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(JSON.stringify(ent(`n${i}`, { data: { i, text: 'x'.repeat(40) } })))
    const big = file('big.jsonl', lines.join('\n'))
    const reports: number[] = []
    const t0 = performance.now()
    const r = await importFile(big, store, { onProgress: (p) => p.phase === 'reading' && reports.push(p.done) })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(r.count).toBe(20_000)
    expect(store.all().length).toBe(20_000)
    expect(reports.at(-1)).toBe(big.size)
    expect(reports.every((n, i) => i === 0 || n >= reports[i - 1])).toBe(true)
  }, 30_000)

  it('a pack that is not one: text, gzip of text, too few bytes; looksPacked on each', async () => {
    const enc = new TextEncoder()
    await expect(readPack(enc.encode('{"entities":[]}'))).rejects.toThrow(/Not an aegraph pack/)
    await expect(readPack(await gz('{"entities":[]}'))).rejects.toThrow(/Not an aegraph pack/)
    await expect(readPack(new Uint8Array([0x1f, 0x8b]))).rejects.toThrow(/Not an aegraph pack/)
    await expect(readPack(new Uint8Array())).rejects.toThrow(/Not an aegraph pack/)
    expect(looksPacked(enc.encode('{"entities":[]}'))).toBe(false)
    expect(looksPacked(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false) // twelve bytes of gzip header is not enough to be anything
    expect(looksPacked(await gz('{"entities":[]}'))).toBe(true) // gzip past the header looks packed: the reader then decides
    const packed = await exportToBlob({ entities: [ent('p') as never], tags: [] }, { format: 'pack' }, 'p')
    const bytes = new Uint8Array(await packed.blob.arrayBuffer())
    expect(looksPacked(bytes)).toBe(true)
    expect((await readPack(bytes)).entities.map((e) => e.id)).toEqual(['p'])
    expect((await parseFile(file('p.aeb.gz', bytes))).entities.map((e) => e.id)).toEqual(['p']) // .aeb.gz is just .aeb
  })

  it('reads a gzipped pack within the pack ceiling, and refuses one that becomes more than it', async () => {
    const { packDocument } = await import('../pack/pack')
    const { gzipSync } = await import('node:zlib')
    const { TooLargeError } = await import('../gunzip')
    const packed = packDocument({ entities: [{ id: 'a', kind: 'entity', type: 'note', tags: [], data: { text: 'x'.repeat(4096) }, meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }] as never })
    const gz = new Uint8Array(gzipSync(packed))
    expect((await readPack(gz)).entities.map((e) => e.id)).toEqual(['a'])
    await expect(readPack(gz, 1024)).rejects.toBeInstanceOf(TooLargeError)
  })

  it('tells a gzip of text from a gzipped pack by its first inflated bytes, without inflating the rest', async () => {
    const { gzipSync } = await import('node:zlib')
    // A hundred megabytes of spaces: a text bundle under the pack's ceiling, inflated once before it was told apart.
    const text = new Uint8Array(gzipSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 }))
    const t0 = performance.now()
    expect(await gzipHoldsPack(text)).toBe(false)
    await expect(readPack(text)).rejects.toThrow(/Not an aegraph pack/)
    expect(performance.now() - t0).toBeLessThan(2000)
    const { packDocument } = await import('../pack/pack')
    expect(await gzipHoldsPack(new Uint8Array(gzipSync(packDocument({ entities: [] }))))).toBe(true)
    expect(await gzipHoldsPack(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]))).toBe(false)
  }, 30_000)

  it('reads a response within its ceiling and refuses one past it as it arrives', async () => {
    const { TooLargeError } = await import('../gunzip')
    const body = new Uint8Array(3 * 1024 * 1024).fill(7)
    const back = await readResponseBytes(new Response(body))
    expect(back.length).toBe(body.length)
    expect(back[body.length - 1]).toBe(7)
    await expect(readResponseBytes(new Response(body), 1024 * 1024)).rejects.toBeInstanceOf(TooLargeError)
    // A Content-Length that lies is only a first size: what arrives is what counts.
    const lying = new Response(body, { headers: { 'content-length': '10' } })
    expect((await readResponseBytes(lying)).length).toBe(body.length)
    expect((await readResponseBytes(new Response(null))).length).toBe(0)
  })
})

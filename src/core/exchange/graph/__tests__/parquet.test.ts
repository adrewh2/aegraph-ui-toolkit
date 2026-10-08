import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cellValue, isParquet, parseParquetGraph } from '../parquet'
import { findGraphFormat, matchGraphImport } from '../graphFormats'

/**
 * Parquet as a graph, over two small files made with hyparquet-writer (Snappy): points — id, Title, x, y, cluster,
 * citations (INT64, one past 2^53), abstract; a repeated id and a null id among them — and links — Source, Target,
 * weight, kind; one without a source.
 */
const here = dirname(fileURLToPath(import.meta.url))
const bytes = (f: string) => {
  const b = readFileSync(join(here, 'fixtures', f))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe('Parquet graphs', () => {
  it('reads points as nodes: id, label, position, the rest as attributes', async () => {
    const g = await parseParquetGraph(bytes('points.parquet'), undefined, { rescale: false })
    // A repeated id is another row: its own node, numbered, with the id it was given kept as an attribute.
    expect(g.nodes.map((n) => n.id)).toEqual(['p1', 'p2', 'p3', 'p3#2', 'row-4'])
    expect(g.nodes[3]).toMatchObject({ label: 'Stars again', attrs: { id: 'p3' } })
    expect(g.nodes[0]).toEqual({ id: 'p1', label: 'Graphs', attrs: { cluster: 'Cluster: 1', citations: 10, abstract: 'long text a' }, viz: { x: 0.5, y: 1 } })
    // An integer past 2^53 is kept exactly, as text.
    expect(g.nodes[2].attrs.citations).toBe('9007199254740993')
    expect(g.warnings).toEqual(['1 rows repeat an id already read; each is its own node, numbered (id#2, id#3…), and a link to the id goes to the first.'])
    expect(g.attributeKeys.nodes).toEqual(expect.arrayContaining(['cluster', 'citations', 'abstract']))
  })

  it('leaves out columns not asked for — but never the id, label or position — and reads the first rows only', async () => {
    const g = await parseParquetGraph(bytes('points.parquet'), undefined, { columns: ['cluster'], limit: 2, rescale: false })
    expect(g.nodes).toEqual([
      { id: 'p1', label: 'Graphs', attrs: { cluster: 'Cluster: 1' }, viz: { x: 0.5, y: 1 } },
      { id: 'p2', label: 'Maps', attrs: { cluster: 'Cluster: 2' }, viz: { x: 1.5, y: 2 } },
    ])
    expect(g.warnings).toContain('Read the first 2 of 5 points.')
  })

  it('reads links as edges, with weight, and names what it skipped', async () => {
    const g = await parseParquetGraph(bytes('points.parquet'), bytes('links.parquet'))
    expect(g.edges).toEqual([
      { source: 'p1', target: 'p2', attrs: { kind: 'cites' }, weight: 1.5 },
      { source: 'p2', target: 'p3', attrs: { kind: 'cites' }, weight: 2 },
      { source: 'p1', target: 'p3', attrs: { kind: 'extends' }, weight: 0.5 },
    ])
    expect(g.warnings).toContain('Skipped 1 link rows without a source or target.')
    await expect(parseParquetGraph(bytes('points.parquet'), bytes('links.parquet'), { sourceColumn: 'from_id' })).rejects.toThrow(/needs a source and a target column/)
  })

  it('takes columns by name when told, and refuses what is not Parquet', async () => {
    const g = await parseParquetGraph(bytes('points.parquet'), undefined, { idColumn: 'Title', labelColumn: 'cluster' })
    expect(g.nodes[0]).toMatchObject({ id: 'Graphs', label: 'Cluster: 1', attrs: { id: 'p1' } })
    await expect(parseParquetGraph(bytes('points.parquet'), undefined, { idColumn: 'nope' })).rejects.toThrow(/No column nope/)
    await expect(parseParquetGraph(new TextEncoder().encode('id,x\n1,2\n').buffer as ArrayBuffer)).rejects.toThrow(/not Parquet/)
    expect(isParquet(bytes('links.parquet'))).toBe(true)
  })

  it('fits positions to a spread for the number of points, centred, unless told not to', async () => {
    const g = await parseParquetGraph(bytes('points.parquet'))
    const xs = g.nodes.map((n) => n.viz!.x!)
    const ys = g.nodes.map((n) => n.viz!.y!)
    // Five points: the minimum spread, 800 units, along the wider side (x runs -2…9, y 1…9), centred on 0.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(800)
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo((800 * 8) / 11)
    expect(g.warnings.some((w) => /Positions rescaled ×72\.7/.test(w))).toBe(true)
  })

  it('keeps cells the store can hold', () => {
    expect(cellValue(5n)).toBe(5)
    expect(cellValue(new Date('2026-09-29T00:00:00Z'))).toBe('2026-09-29T00:00:00.000Z')
    expect(cellValue(new Uint8Array([1]))).toBeUndefined()
    expect(cellValue(NaN)).toBeUndefined()
    expect(cellValue({ a: 1n, ['__proto__']: 1 })).toEqual({ a: 1 })
  })

  it('is found by extension, alone or as a points + links pair', () => {
    expect(findGraphFormat('arxiv.parquet')?.id).toBe('parquet')
    expect(matchGraphImport([{ name: 'nodes.parquet' }, { name: 'edges.parquet' }])?.format.id).toBe('parquet')
  })
})

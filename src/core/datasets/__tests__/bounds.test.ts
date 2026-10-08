import { describe, expect, it } from 'vitest'
import { parseParquetGraph } from '../../exchange/graph/parquet'
import { DATASET_FILE_LIMITS, DatasetTooLargeError, normalizeDelimiter, readDatasetFile, readDelimited, type DatasetFileLimits } from '../files'
import { readParquet } from '../parquet'
import { decodeXml, excelDate, MAX_SHEETS, readXlsx } from '../xlsx'
import { parquetBomb } from './parquetBomb'
import { zip } from './zip'

/**
 * What a table file may claim, and what it may make the reader do: a Parquet page's value count is what gets
 * allocated, a shared string or a dictionary value may stand in every cell, unclosed markup must not make a scan
 * quadratic, and a line of separators must not become millions of fields. Each case was a tab-sized allocation or
 * a hang before; the time budgets are generous.
 */
const small = (over: Partial<DatasetFileLimits>): DatasetFileLimits => ({ ...DATASET_FILE_LIMITS, ...over })
const fileOf = (name: string, bytes: Uint8Array) => ({ name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer })
const timed = async <T>(f: () => Promise<T>): Promise<[T | Error, number]> => {
  const t = performance.now()
  try {
    return [await f(), performance.now() - t]
  } catch (e) {
    return [e as Error, performance.now() - t]
  }
}

describe('Parquet page headers are read before a page is', () => {
  it('refuses a page that claims more values than its row group has rows (122 bytes claiming 300 million took the tab)', async () => {
    const bomb = parquetBomb(4, 1, 300_000_000)
    expect(bomb.byteLength).toBeLessThan(200)
    const [err, ms] = await timed(() => readParquet(bomb, { name: 'p.parquet' }))
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/p\.parquet (is damaged: the column "a" has more values than its row group has rows|has a page of 300,000,000 values)/)
    expect(ms).toBeLessThan(2_000)
    // Through the attach path too, and through the graph importer, which reads its tables with the same reader.
    await expect(readDatasetFile(fileOf('p.parquet', bomb))).rejects.toThrow(/p\.parquet/)
    await expect(parseParquetGraph(bomb.slice().buffer as ArrayBuffer)).rejects.toThrow(/points file/)
  })

  it('refuses a page of more values than a table keeps cells, and reads an honest one', async () => {
    await expect(readParquet(parquetBomb(4, 50, 50), { name: 'p.parquet', limits: small({ cells: 10 }) })).rejects.toThrow(/p\.parquet has (a page of 50 values|50 cells)/)
    const ok = await readParquet(parquetBomb(4, 50, 50), { name: 'p.parquet' })
    expect(ok.rows).toHaveLength(50)
    expect(ok.rows[0]).toEqual(['AAAA'])
  })

  it('counts a dictionary value once per cell it fills: one long value down every row is refused, not copied', async () => {
    const [err, ms] = await timed(() => readParquet(parquetBomb(1024 * 1024, 100_000), { name: 'dict.parquet' }))
    expect(err).toBeInstanceOf(DatasetTooLargeError)
    expect((err as Error).message).toMatch(/dict\.parquet holds more than 128 million characters of cell text/)
    expect(ms).toBeLessThan(5_000)
    await expect(readParquet(parquetBomb(100, 1_000), { name: 'd.parquet', limits: small({ cellText: 10_000 }) })).rejects.toThrow(/cell text/)
  })
})

// ── Excel ────────────────────────────────────────────────────────────

const WB = (sheets: number) =>
  `<workbook xmlns:r="r"><sheets>${Array.from({ length: sheets }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId${i}"/>`).join('')}</sheets></workbook>`
const RELS = (sheets: number) => `<Relationships>${Array.from({ length: sheets }, (_, i) => `<Relationship Id="rId${i}" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`
const book = (sheet: string, extra: { name: string; text: string }[] = [], sheets = 1) =>
  zip([{ name: 'xl/workbook.xml', text: WB(sheets) }, { name: 'xl/_rels/workbook.xml.rels', text: RELS(sheets) }, { name: 'xl/worksheets/sheet0.xml', text: sheet, deflate: true }, ...extra.map((e) => ({ ...e, deflate: true }))])

describe('Excel workbooks', () => {
  it('charges each cell’s text to a budget: one long shared string in every cell is refused', async () => {
    const long = 'x'.repeat(1024 * 1024)
    const rows = Array.from({ length: 201 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="s"><v>0</v></c></row>`).join('')
    const wb = book(`<worksheet><sheetData>${rows}</sheetData></worksheet>`, [{ name: 'xl/sharedStrings.xml', text: `<sst><si><t>${long}</t></si></sst>` }])
    await expect(readXlsx(wb, { name: 'b.xlsx' })).rejects.toThrow(/b\.xlsx › S0 holds more than 128 million characters of cell text/)
    const fine = await readXlsx(wb, { name: 'b.xlsx', limits: small({ cellText: 250 * 1024 * 1024 }) })
    expect(fine[0].data.rows).toHaveLength(200)
  })

  it('scans unclosed markup in one pass: rows, shared strings, phonetic runs and long start tags', async () => {
    const cases = [
      book(`<worksheet><sheetData><row r="1"><c><v>1</v></c></row>${'<row>'.repeat(200_000)}</sheetData></worksheet>`),
      book(`<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row></sheetData></worksheet>`, [{ name: 'xl/sharedStrings.xml', text: `<sst><si><t>a</t></si>${'<si>'.repeat(200_000)}</sst>` }]),
      book(`<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row></sheetData></worksheet>`, [{ name: 'xl/sharedStrings.xml', text: `<sst><si><t>a</t>${'<rPh>'.repeat(200_000)}</si></sst>` }]),
      book(`<worksheet><sheetData><row r="1" ${'a'.repeat(1_000_000)}><c><v>1</v></c></row></sheetData></worksheet>`),
      book(`<worksheet><sheetData><row r="1"><c ${'x="'.repeat(300_000)}><v>1</v></c></row></sheetData></worksheet>`),
    ]
    const [, ms] = await timed(async () => {
      for (const wb of cases) await readXlsx(wb, { name: 'u.xlsx' }).catch(() => undefined)
    })
    expect(ms).toBeLessThan(5_000)
    const [first] = await readXlsx(cases[0], { name: 'u.xlsx' })
    expect(first.data.columns).toEqual([{ key: '1' }])
  })

  it('reads at most MAX_SHEETS sheets at once, names an entity only by its own name, and keeps a serial no calendar reaches as a number', async () => {
    await expect(readXlsx(book('<worksheet/>', [], MAX_SHEETS + 1), { name: 'many.xlsx' })).rejects.toThrow(/many\.xlsx has 101 sheets — a workbook is read as at most 100 datasets/)
    expect(decodeXml('&constructor; &toString; &amp;')).toBe('&constructor; &toString; &')
    expect(excelDate(1e300, 'date')).toBeUndefined()
    const styles = { name: 'xl/styles.xml', text: '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' }
    const [s] = await readXlsx(book('<worksheet><sheetData><row r="1"><c><v>1</v></c></row><row r="2"><c s="1"><v>1e300</v></c></row></sheetData></worksheet>', [styles]), { name: 'd.xlsx' })
    expect(s.data.rows).toEqual([[1e300]])
  })
})

// ── Delimited text ───────────────────────────────────────────────────

describe('delimited text', () => {
  it('refuses a line of separators at the column bound as it splits, rather than after making every field', async () => {
    const commas = ','.repeat(4_000_000)
    for (const header of [true, false]) {
      const [err, ms] = await timed(() => readDelimited(commas, { delimiter: ',', header }, 'c.csv'))
      expect(err).toBeInstanceOf(DatasetTooLargeError)
      expect((err as Error).message).toMatch(header ? /c\.csv has 4,000,001 columns — a dataset from a file keeps at most 500/ : /c\.csv has 4,000,001 columns/)
      expect(ms).toBeLessThan(2_000)
    }
    await expect(readDelimited('a::b\n' + '::'.repeat(1_000_000), { delimiter: '::', header: true }, 'm.txt')).rejects.toThrow(/m\.txt has 1,000,001 columns/)
    await expect(readDelimited('a b\n' + 'x '.repeat(1_000_000), { delimiter: 'whitespace', header: true }, 'w.txt')).rejects.toThrow(/w\.txt has 1,000,000 columns/)
    const cells = Array.from({ length: 30 }, () => 'a,b,c').join('\n')
    await expect(readDelimited(cells, { delimiter: ',', header: false }, 'n.csv', small({ cells: 60, columns: 3 }))).rejects.toThrow(/n\.csv has more than 60 cells/)
  })

  it('names a separator only by its own names', () => {
    expect(normalizeDelimiter('constructor')).toBe('constructor')
    expect(normalizeDelimiter('toString')).toBe('toString')
    expect(normalizeDelimiter('tab')).toBe('\t')
  })
})

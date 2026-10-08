import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { columnKey, datasetRecords } from '../dataset'
import { baseName, DATASET_FILE_LIMITS, datasetFileFormat, DatasetTooLargeError, normalizeDelimiter, plainValue, previewDelimited, readDatasetFile, readDelimited, sniffDelimiter, type DatasetFileLimits } from '../files'
import { dateStyleOf, excelDate, readXlsx } from '../xlsx'
import { readParquet } from '../parquet'
import { zip } from './zip'

/**
 * Datasets from files — CSV, TSV, text with a separator, Excel, Parquet — and the bounds on each: a file is data
 * from outside, so its size, its rows, columns and cells, what it decompresses to and the keys it can name are all
 * checked, and a file past a bound is refused with a sentence rather than read half-way or left to hang the tab.
 */

const fileOf = (name: string, content: string | Uint8Array, type = '') => {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
}
const small = (over: Partial<DatasetFileLimits>): DatasetFileLimits => ({ ...DATASET_FILE_LIMITS, ...over })

describe('which files are datasets', () => {
  it('reads the format from the name, gzipped or not, and the dataset is called by the name without it', () => {
    expect(datasetFileFormat({ name: 'Sales.CSV' })).toBe('csv')
    expect(datasetFileFormat({ name: 'sales.csv.gz' })).toBe('csv')
    expect(datasetFileFormat({ name: 'x.tsv' })).toBe('tsv')
    expect(datasetFileFormat({ name: 'book.xlsx' })).toBe('xlsx')
    expect(datasetFileFormat({ name: 'part-0.parquet' })).toBe('parquet')
    expect(datasetFileFormat({ name: 'notes.txt' })).toBe('txt')
    expect(datasetFileFormat({ name: 'paper.pdf' })).toBeUndefined()
    expect(baseName('dir/sales.csv.gz')).toBe('sales')
    expect(baseName('book.xlsx')).toBe('book')
  })

  it('names separators the way a person or a tool would', () => {
    expect(normalizeDelimiter('tab')).toBe('\t')
    expect(normalizeDelimiter('\\t')).toBe('\t')
    expect(normalizeDelimiter('semicolon')).toBe(';')
    expect(normalizeDelimiter('spaces')).toBe('whitespace')
    expect(normalizeDelimiter('::')).toBe('::')
    expect(normalizeDelimiter(undefined)).toBe(',')
    expect(() => normalizeDelimiter('"')).toThrow(/quote or a line break/)
  })

  it('guesses the separator of a text file from its lines', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t')
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';')
    expect(sniffDelimiter('a|b\n1|2')).toBe('|')
    expect(sniffDelimiter('x  y  z\n1 2 3\n4   5 6')).toBe('whitespace')
    expect(sniffDelimiter('a,b\n"1,5",2')).toBe(',')
  })
})

describe('delimited text', () => {
  it('reads any separator, quoted fields included, cells as the grid reads what is typed', async () => {
    const d = await readDelimited('name;score;ok\n"Smith; J";3.5;true\nLee;;false\n', { delimiter: ';', header: true })
    expect(d.columns.map((c) => c.key)).toEqual(['name', 'score', 'ok'])
    expect(d.rows).toEqual([
      ['Smith; J', 3.5, true],
      ['Lee', null, false],
    ])
    const ws = await readDelimited('a   b\tc\n1 2 3\n', { delimiter: 'whitespace', header: true })
    expect(ws.rows).toEqual([[1, 2, 3]])
    const multi = await readDelimited('x::y\n1::2\n', { delimiter: '::', header: true })
    expect(multi.rows).toEqual([[1, 2]])
  })

  it('without a header the first row is data and the columns are lettered', async () => {
    const d = await readDelimited('1|2|3\n4|5\n', { delimiter: '|', header: false })
    expect(d.columns.map((c) => c.key)).toEqual(['a', 'b', 'c'])
    expect(d.rows).toEqual([
      [1, 2, 3],
      [4, 5, null],
    ])
  })

  it('previews the first rows as the chosen separator reads them', () => {
    const p = previewDelimited('h1|h2\n1|2\n3|4\n5|6', { delimiter: '|', header: true }, 2)
    expect(p).toEqual({ headers: ['h1', 'h2'], rows: [['1', '2'], ['3', '4']], columns: 2 })
    expect(previewDelimited('1,2', { delimiter: ',', header: false }).headers).toEqual(['a', 'b'])
  })

  it('a header that names an object’s machinery is kept as the label, under another key; nested keys like it are dropped', async () => {
    expect(columnKey('constructor', 0)).toBe('constructor_col')
    expect(columnKey('__proto__', 0)).toBe('proto')
    const d = await readDelimited('constructor,prototype,json\n1,2,"{""__proto__"":{""x"":1},""ok"":2}"\n', { delimiter: ',', header: true })
    expect(d.columns).toEqual([{ key: 'constructor_col', label: 'constructor' }, { key: 'prototype_col', label: 'prototype' }, { key: 'json' }])
    expect(d.rows[0][2]).toEqual({ ok: 2 })
    expect(Object.getPrototypeOf(datasetRecords(d)[0])).toBe(Object.prototype)
    expect(plainValue({ a: [1n, new Date(0)], constructor: 1 })).toEqual({ a: [1, '1970-01-01T00:00:00.000Z'] })
  })

  it('refuses a file past the rows, the columns or the cells, and one too large to open, saying which', async () => {
    const rows = 'a,b\n' + Array.from({ length: 11 }, (_, i) => `${i},${i}`).join('\n')
    await expect(readDelimited(rows, { delimiter: ',', header: true }, 'rows.csv', small({ rows: 10 }))).rejects.toThrow(/rows\.csv has more than 10 rows/)
    await expect(readDelimited('a,b,c\n1,2,3', { delimiter: ',', header: true }, 'wide.csv', small({ columns: 2 }))).rejects.toThrow(/3 columns — a dataset from a file keeps at most 2/)
    await expect(readDelimited('a,b\n1,2\n3,4', { delimiter: ',', header: true }, 'cells.csv', small({ cells: 3 }))).rejects.toThrow(/4 cells/)
    await expect(readDatasetFile(fileOf('big.csv', 'a\n1\n'), { limits: small({ bytes: 3 }) })).rejects.toBeInstanceOf(DatasetTooLargeError)
    await expect(readDatasetFile(fileOf('paper.pdf', '%PDF'))).rejects.toThrow(/not a file a dataset is read from/)
  })

  it('reads a file: .csv by comma (or semicolon when its header says so), .tsv by tab, a gzipped one through the bounded reader', async () => {
    const [csv] = await readDatasetFile(fileOf('trees.csv', '\ufeffspecies,height\noak,20\n'))
    expect(csv.label).toBe('trees')
    expect(csv.data.rows).toEqual([['oak', 20]])
    expect(csv.source).toMatchObject({ kind: 'file', filename: 'trees.csv', format: 'csv' })
    const [semi] = await readDatasetFile(fileOf('eu.csv', 'a;b\n1,5;2\n'))
    expect(semi.data.rows).toEqual([['1,5', 2]])
    const [tsv] = await readDatasetFile(fileOf('t.tsv', 'a\tb\n1\t2\n'))
    expect(tsv.data.rows).toEqual([[1, 2]])
    const [txt] = await readDatasetFile(fileOf('log.txt', 'x|y\n1|2\n'), { delimiter: '|', header: true })
    expect(txt.source.format).toBe('txt')
    expect(txt.data.rows).toEqual([[1, 2]])

    const gz = new Uint8Array(gzipSync(Buffer.from('a,b\n1,2\n')))
    const [unzipped] = await readDatasetFile(fileOf('g.csv.gz', gz))
    expect(unzipped.data.rows).toEqual([[1, 2]])
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61)))
    await expect(readDatasetFile(fileOf('bomb.csv.gz', bomb), { limits: small({ inflatedBytes: 1024 * 1024 }) })).rejects.toThrow(/decompresses to more than 1 MB/)
  })

  it('reads a long file in slices, yielding to the page between them', async () => {
    const text = 'n\n' + Array.from({ length: 60_000 }, (_, i) => String(i)).join('\n')
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const d = await readDelimited(text, { delimiter: ',', header: true })
    clearInterval(timer)
    expect(d.rows.length).toBe(60_000)
    expect(ticks).toBeGreaterThan(0)
  })
})

// ── Excel ────────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s)

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns="x" xmlns:r="r"><workbookPr/><sheets>
  <sheet name="People &amp; places" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Blank" sheetId="3" r:id="rId3"/><sheet name="Nums" sheetId="4" r:id="rId4"/></sheets></workbook>`
const RELS = `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="ws" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="ws" Target="/xl/worksheets/sheet4.xml"/></Relationships>`
const SHARED = `<sst><si><t>Name</t></si><si><t>Born</t></si><si><r><t>Ada </t></r><r><t xml:space="preserve">Lovelace</t></r><rPh><t>ignored</t></rPh></si><si><t>constructor</t></si><si/></sst>`
const STYLES = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/></cellXfs></styleSheet>`
const SHEET1 = `<worksheet><sheetData>
  <row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="s"><v>3</v></c><c r="E2" t="inlineStr"><is><t>Note</t></is></c></row>
  <row r="3"><c r="B3" t="s"><v>2</v></c><c r="C3" s="1"><v>45292</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="str"><f>A1</f><v>x &lt; y</v></c></row>
  <row r="5"><c r="B5"><v>3.5</v></c><c r="C5" s="2"><v>45292.5</v></c><c r="D5" t="e"><v>#DIV/0!</v></c></row>
</sheetData></worksheet>`
const SHEET2 = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`
const SHEET3 = `<worksheet><sheetData/></worksheet>`
const SHEET4 = `<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c><c><v>4</v></c></row></sheetData></worksheet>`

const workbook = (sheet1 = SHEET1, extra: { deflate?: boolean; flags?: number } = {}) =>
  zip([
    { name: 'xl/workbook.xml', text: WORKBOOK, ...extra },
    { name: 'xl/_rels/workbook.xml.rels', text: RELS },
    { name: 'xl/sharedStrings.xml', text: SHARED, deflate: true },
    { name: 'xl/styles.xml', text: STYLES },
    { name: 'xl/worksheets/sheet1.xml', text: sheet1, deflate: true },
    { name: 'xl/worksheets/sheet2.xml', text: SHEET2 },
    { name: 'xl/worksheets/sheet3.xml', text: SHEET3 },
    { name: 'xl/worksheets/sheet4.xml', text: SHEET4 },
  ])

describe('Excel workbooks', () => {
  it('reads every visible sheet with cells: shared and inline text, dates by their format, booleans, formulas’ values, errors', async () => {
    const sheets = await readXlsx(workbook(), { name: 'book.xlsx' })
    expect(sheets.map((s) => s.name)).toEqual(['People & places', 'Nums'])
    const people = sheets[0].data
    // The first row with anything in it is the header, from its first column; an empty first column stays.
    expect(people.columns.map((c) => c.key)).toEqual(['a', 'name', 'born', 'constructor_col', 'note'])
    expect(people.rows).toEqual([
      [null, 'Ada Lovelace', '2024-01-01', true, 'x < y'],
      [null, null, null, null, null],
      [null, 3.5, '2024-01-01T12:00:00', '#DIV/0!', null],
    ])
    // Rows and cells without an `r` follow on from the last.
    expect(sheets[1].data).toEqual({ columns: [{ key: '1' }, { key: '2' }], rows: [[3, 4]] })
  })

  it('reads one sheet by name, and says which sheets there are when the name is wrong', async () => {
    const [only] = await readXlsx(workbook(), { sheet: 'Hidden' })
    expect(only.name).toBe('Hidden')
    await expect(readXlsx(workbook(), { name: 'book.xlsx', sheet: 'Nope' })).rejects.toThrow(/no sheet called "Nope" — its sheets are "People & places", "Hidden", "Blank", "Nums"/)
  })

  it('knows a date format from a number format', () => {
    expect(dateStyleOf(14, undefined)).toBe('date')
    expect(dateStyleOf(22, undefined)).toBe('datetime')
    expect(dateStyleOf(20, undefined)).toBe('time')
    expect(dateStyleOf(164, 'dd/mm/yyyy')).toBe('date')
    expect(dateStyleOf(165, '[Red]0.00;"days"')).toBeUndefined()
    expect(dateStyleOf(166, 'General')).toBeUndefined()
    expect(excelDate(1, 'date')).toBe('1900-01-01')
    expect(excelDate(60 + 1, 'date')).toBe('1900-03-01')
    expect(excelDate(0.75, 'time')).toBe('18:00:00')
    expect(excelDate(0, 'date', true)).toBe('1904-01-01')
    // Before 1900, as a writer such as exceljs stores Ada Lovelace's birthday.
    expect(excelDate(-30701, 'date')).toBe('1815-12-10')
  })

  it('refuses what is not a workbook, a password-protected one, and one that inflates past the bound', async () => {
    await expect(readXlsx(enc('not a zip at all, just text'), { name: 'x.xlsx' })).rejects.toThrow(/not an Excel workbook/)
    await expect(readXlsx(zip([{ name: 'word/document.xml', text: '<w/>' }]), { name: 'x.xlsx' })).rejects.toThrow(/it is a Word document/)
    await expect(readXlsx(workbook(SHEET1, { flags: 1 }), { name: 'x.xlsx' })).rejects.toThrow(/password-protected/)
    const bomb = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>${' '.repeat(4 * 1024 * 1024)}</worksheet>`
    await expect(readXlsx(workbook(bomb), { name: 'x.xlsx', limits: small({ inflatedBytes: 1024 * 1024 }) })).rejects.toThrow(/expands to more than 1 MB/)
  })

  it('refuses a sheet past the rows or the columns as it reads, before building the table', async () => {
    const far = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="A1048576"><v>2</v></c></row></sheetData></worksheet>`
    await expect(readXlsx(workbook(far), { name: 'x.xlsx' })).rejects.toThrow(/more than 200,000 rows/)
    const wide = `<worksheet><sheetData><row r="1"><c r="XFD1"><v>1</v></c></row></sheetData></worksheet>`
    await expect(readXlsx(workbook(wide), { name: 'x.xlsx' })).rejects.toThrow(/column 16384/)
  })

  it('reads through readDatasetFile as one dataset per sheet, named by the file and the sheet', async () => {
    const read = await readDatasetFile(fileOf('book.xlsx', workbook()))
    expect(read.map((r) => r.label)).toEqual(['book · People & places', 'book · Nums'])
    expect(read[0].source).toMatchObject({ kind: 'file', format: 'xlsx', sheet: 'People & places', filename: 'book.xlsx' })
  })
})

// ── Parquet ─────────────────────────────────────────────────────────

// Written by hyparquet-writer: name (string), Year Born (int32), big (int64), score (double), alive (bool), at (timestamp), constructor (string).
const PEOPLE_SNAPPY =
  'UEFSMRUGFSQVKFwVBhUCFQYVABUEFQAAAAMDEDwDAAAAQWRhBQAAAEdyYWNlFQYVHBUgXBUGFQAVBhUAFQQVAAAAAwcMLBcHAAByBwAAeAcAABUGFSQVKFwVBhUCFQYVABUEFQAAAAMDEDwBAAAAAAAAAAEAAAAAACAAFQYVJBUkXBUGFQIVBhUAFQQVAAAAAwMQAAAFAST4PwAAAAAAAAJAFQYVBhUKXBUGFQAVBhUAFQQVAAAAAwcBAAQVBhUkFShcFQYVAhUGFQAVBBUAAAADBRA8iNggyIwBAAAAiC1tcgEAABUGFSIVJlwVBhUAFQYVABUEFQAAAAMHDzgBAAAAeAEAAAB5AQAAAHoVBBmMSARyb290FQ4AFQwlAhgEbmFtZSUAABUCJQIYCVllYXIgQm9ybgAVBCUCGANiaWcAFQolAhgFc2NvcmUAFQAlAhgFYWxpdmUAFQQlAhgCYXQlEgAVDCUCGAtjb25zdHJ1Y3RvciUAABYGGRwZfCYIHBUMGRUAGRgEbmFtZRUCFgYWUhZSJgg8NgIoBUdyYWNlGANBZGEAGRwVBhUAFQIAAAAmWhwVAhkVABkYCVllYXIgQm9ybhUCFgYWShZKJlo8NgAoBHgHAAAYBBcHAAAAGRwVBhUAFQIAAAAmpAEcFQQZFQAZGANiaWcVAhYGFlIWUiakATw2AigIAQAAAAAAIAAYCAEAAAAAAAAAABkcFQYVABUCAAAAJvYBHBUKGRUAGRgFc2NvcmUVAhYGFk4WTib2ATw2AigIAAAAAAAAAkAYCAAAAAAAAPg/ABkcFQYVABUCAAAAJsQCHBUAGRUAGRgFYWxpdmUVAhYGFjQWNCbEAjw2ACgBARgBAAAZHBUGFQAVAgAAACb4AhwVBBkVABkYAmF0FQIWBhZSFlIm+AI8NgIAGRwVBhUAFQIAAAAmygMcFQwZFQAZGAtjb25zdHJ1Y3RvchUCFgYWUBZQJsoDPDYAKAF6GAF4ABkcFQYVABUCAAAAFpIEFgYAKAloeXBhcnF1ZXQA/AEAAFBBUjE='
const PEOPLE_GZIP =
  'UEFSMRUGFSQVSFwVBhUCFQYVABUEFQAAAAMDH4sIAAAAAAAAE2NmYGBwTElkBVLuRYnJqQBpK/LrEAAAABUGFRwVPlwVBhUAFQYVABUEFQAAAAMHH4sIAAAAAAAAExNnZ2AoAuIKIAYACuF4qgwAAAAVBhUkFTxcFQYVAhUGFQAVBBUAAAADAx+LCAAAAAAAABNjZIAARjCpwAAA+P79GxAAAAAVBhUkFUBcFQYVAhUGFQAVBBUAAAADAx+LCAAAAAAAABNjYACBH/ZgioHJAQApq0JaEAAAABUGFQYVLlwVBhUAFQYVABUEFQAAAAMHH4sIAAAAAAAAE2MBAJQrb9UBAAAAFQYVJBVKXBUGFQIVBhUAFQQVAAAAAwUfiwgAAAAAAAAT67ihcKKHkYGBoUM3twhIAwDpAJxDEAAAABUGFSIVQlwVBhUAFQYVABUEFQAAAAMHH4sIAAAAAAAAE2NkYGCoYAQSlSCiCgAc7ZZkDwAAABUEGYxIBHJvb3QVDgAVDCUCGARuYW1lJQAAFQIlAhgJWWVhciBCb3JuABUEJQIYA2JpZwAVCiUCGAVzY29yZQAVACUCGAVhbGl2ZQAVBCUCGAJhdCUSABUMJQIYC2NvbnN0cnVjdG9yJQAAFgYZHBl8JggcFQwZFQAZGARuYW1lFQQWBhZyFnImCDw2AigFR3JhY2UYA0FkYQAZHBUGFQAVAgAAACZ6HBUCGRUAGRgJWWVhciBCb3JuFQQWBhZoFmgmejw2ACgEeAcAABgEFwcAAAAZHBUGFQAVAgAAACbiARwVBBkVABkYA2JpZxUEFgYWZhZmJuIBPDYCKAgBAAAAAAAgABgIAQAAAAAAAAAAGRwVBhUAFQIAAAAmyAIcFQoZFQAZGAVzY29yZRUEFgYWahZqJsgCPDYCKAgAAAAAAAACQBgIAAAAAAAA+D8AGRwVBhUAFQIAAAAmsgMcFQAZFQAZGAVhbGl2ZRUEFgYWWBZYJrIDPDYAKAEBGAEAABkcFQYVABUCAAAAJooEHBUEGRUAGRgCYXQVBBYGFnQWdCaKBDw2AgAZHBUGFQAVAgAAACb+BBwVDBkVABkYC2NvbnN0cnVjdG9yFQQWBhZsFmwm/gQ8NgAoAXoYAXgAGRwVBhUAFQIAAAAW4gUWBgAoCWh5cGFycXVldAD8AQAAUEFSMQ=='
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

describe('Parquet files', () => {
  const expected = [
    ['Ada', 1815, 1, 1.5, false, '2024-01-02T03:04:05.000Z', 'x'],
    ['Grace', 1906, '9007199254740993', 2.25, false, null, 'y'],
    [null, 1912, null, null, true, '2020-06-01T00:00:00.000Z', 'z'],
  ]

  it('reads its columns and rows — Snappy or gzip — with big integers kept exact and dates as ISO text', async () => {
    for (const fixture of [PEOPLE_SNAPPY, PEOPLE_GZIP]) {
      const d = await readParquet(b64(fixture), { name: 'people.parquet' })
      expect(d.columns).toEqual([{ key: 'name' }, { key: 'year_born', label: 'Year Born' }, { key: 'big' }, { key: 'score' }, { key: 'alive' }, { key: 'at' }, { key: 'constructor_col', label: 'constructor' }])
      expect(d.rows).toEqual(expected)
    }
  })

  it('refuses a file past the rows before reading a page, one whose pages decompress past the bound, and one that is not Parquet', async () => {
    await expect(readParquet(b64(PEOPLE_SNAPPY), { name: 'p.parquet', limits: small({ rows: 2 }) })).rejects.toThrow(/p\.parquet has 3 rows/)
    await expect(readParquet(b64(PEOPLE_GZIP), { name: 'p.parquet', limits: small({ inflatedBytes: 64 }) })).rejects.toThrow(/decompresses to more than 0 MB/)
    await expect(readParquet(enc('PAR1 nope'), { name: 'p.parquet' })).rejects.toThrow(/not a Parquet file/)
  })

  it('reads through readDatasetFile', async () => {
    const [p] = await readDatasetFile(fileOf('people.parquet', b64(PEOPLE_SNAPPY)))
    expect(p.label).toBe('people')
    expect(p.source).toMatchObject({ kind: 'file', format: 'parquet' })
    expect(p.data.rows.length).toBe(3)
  })
})

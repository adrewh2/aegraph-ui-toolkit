import { describe, expect, it } from 'vitest'
import { narrate } from '../narrate'
import { runAnalyses } from '../run'
import { ANALYSIS_IDS, type AnalysisInput } from '../types'

/** Three communities of people around a document each, a hub bridging them, dupes, isolated notes, a burst. */
function synthetic(): AnalysisInput {
  const ids: string[] = []
  const types: string[] = []
  const labels: string[] = []
  const tags: string[][] = []
  const props: string[][] = []
  const created: number[] = []
  const updated: number[] = []
  const src: number[] = []
  const dst: number[] = []
  const edgeTypes: string[] = []
  const t0 = Date.UTC(2024, 0, 1)
  const DAY = 86_400_000
  const add = (type: string, label: string, day: number, p: string[] = [], tg: string[] = []) => {
    ids.push(`e${ids.length}`)
    types.push(type)
    labels.push(label)
    tags.push(tg)
    props.push(p)
    created.push(t0 + day * DAY)
    updated.push(t0 + (day + 5) * DAY)
    return ids.length - 1
  }
  const link = (a: number, b: number, kind: string) => {
    src.push(a)
    dst.push(b)
    edgeTypes.push(kind)
  }
  const hub = add('organization', 'Acme', 0, ['name'])
  for (let c = 0; c < 3; c++) {
    const doc = add('document', `Report ${c}`, 10 + c * 30, ['title', 'body'], [`topic-${c}`])
    const people: number[] = []
    for (let k = 0; k < 12; k++) {
      // A burst: community 1 arrives in one week.
      const day = c === 1 ? 40 + (k % 3) : 10 + c * 30 + k * 2
      const p = add('person', `Person ${c}-${k}`, day, k % 6 === 0 ? ['name'] : ['name', 'role'], [`topic-${c}`])
      people.push(p)
      link(p, doc, 'authored')
      if (k) link(people[k - 1], p, 'knows')
      if (k > 1) link(people[k - 2], p, 'knows')
    }
    link(people[0], hub, 'affiliated-with')
    link(people[1], hub, 'affiliated-with')
  }
  add('person', 'Person 0-1', 90, ['name', 'role'])
  add('note', 'Loose note', 100)
  add('note', 'Another note', 101)
  const n = ids.length
  return {
    ids,
    types,
    labels,
    tags,
    props,
    created: Float64Array.from(created),
    updated: Float64Array.from(updated),
    src: Uint32Array.from(src),
    dst: Uint32Array.from(dst),
    directed: new Uint8Array(src.length).fill(1),
    edgeTypes,
    edgeIds: src.map((_, j) => `r${j}`),
    schema: [
      { type: 'person', label: 'Person', category: 'knowledge', properties: ['name', 'role', 'email'], declared: true },
      { type: 'document', label: 'Document', category: 'resource', properties: ['title', 'body'], declared: true },
      { type: 'organization', label: 'Organization', category: 'knowledge', properties: ['name'], declared: true },
      { type: 'event', label: 'Event', category: 'knowledge', properties: [], declared: true },
      { type: 'note', label: 'Note', category: 'resource', properties: [], declared: false },
    ],
    scope: { label: 'Synthetic' },
    key: `${n}:${src.length}:test`,
  }
}

describe('analysis harness', () => {
  const { report, metrics } = runAnalyses(synthetic(), ANALYSIS_IDS, { seed: 1 })
  const by = (id: string) => report.findings.find((f) => f.id === id)

  it('runs every analysis and ranks findings across them', () => {
    expect(report.runs.map((r) => r.id)).toEqual(ANALYSIS_IDS)
    for (const r of report.runs) expect(r.findings.length, r.id).toBeGreaterThan(0)
    const scores = report.findings.map((f) => f.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(new Set(report.findings.map((f) => f.id)).size).toBe(report.findings.length)
    expect(metrics.columns.pagerank).toBeDefined()
  })

  it('finds the hub and the communities', () => {
    // The three documents (12 authors each) lead PageRank; the organisation everyone touches is the bridge.
    expect(by('centrality:hubs')?.entities?.slice(0, 3)).toEqual(['e1', 'e14', 'e27'])
    expect((by('centrality:bridges') ?? by('centrality:connectors'))?.entities).toContain('e0')
    expect(report.findings.find((f) => f.id === 'communities:overview')?.data?.count).toBeGreaterThanOrEqual(3)
    const comp = by('communities:composition')
    expect(comp?.visual?.kind).toBe('plot')
  })

  it('reads the ontology in use', () => {
    expect(by('schema:patterns')?.title).toMatch(/person —knows→ person/)
    expect(String(by('schema:coverage')?.title)).toMatch(/email|role/)
    expect(by('schema:declared-vs-used')?.data?.empty).toEqual(['event'])
    expect(by('schema:declared-vs-used')?.data?.inferred).toEqual([{ type: 'note', count: 2 }])
  })

  it('sees the burst and the arrivals', () => {
    expect(by('temporal:bursts')?.title).toMatch(/burst/)
    expect(by('temporal:growth')?.visual?.kind).toBe('plot')
  })

  it('flags duplicates, orphans, missing properties and missing links', () => {
    expect(by('anomalies:duplicates')?.title).toMatch(/1 labels? appear/)
    expect(by('anomalies:isolated')?.data?.count).toBe(3)
    expect(by('anomalies:missing-properties')?.title).toMatch(/lack “role”/)
    expect(by('anomalies:missing-links')?.visual?.kind).toBe('graph')
  })

  it('narrates', () => {
    const md = narrate(report)
    expect(md).toContain('**Most interesting**')
    expect(md).toContain('Key players')
  })

  it('survives an empty input', () => {
    const empty: AnalysisInput = { ...synthetic(), ids: [], types: [], labels: [], tags: [], props: [], created: new Float64Array(0), updated: new Float64Array(0), src: new Uint32Array(0), dst: new Uint32Array(0), directed: new Uint8Array(0), edgeTypes: [], edgeIds: [], key: '0:0:x' }
    const r = runAnalyses(empty)
    expect(r.report.findings).toEqual([])
    expect(r.report.runs.every((x) => x.note)).toBe(true)
  })
})

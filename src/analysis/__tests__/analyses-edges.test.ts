import { describe, expect, it } from 'vitest'
import { describeSpan } from '../analyses/temporal'
import { runAnalyses } from '../run'
import type { AnalysisInput, Finding } from '../types'

/**
 * Two of Insights' analyses at their edges. Anomalies: fewer than five
 * nodes, a ring where nobody stands out against a star with one hub,
 * everybody isolated, labels that are the same once normalised (case,
 * accents, articles, punctuation) and short labels that never count,
 * properties on nine of ten against all or few. Temporal: fewer than
 * five dated nodes, every date on one instant, a day of hours, a span
 * of centuries, a burst against a steady stream, a dataset gone quiet,
 * unparsable dates and undated nodes, a fixed unit. Every finding's
 * score in 0–1, its entities in the slice, its id unique; two runs the same.
 */
const DAY = 86_400_000
const T0 = Date.UTC(2024, 0, 1)

interface Spec {
  nodes: { type?: string; label?: string; created?: number; updated?: number; props?: string[] }[]
  edges?: [number, number, string?][]
}
function input(spec: Spec): AnalysisInput {
  const n = spec.nodes.length
  const edges = spec.edges ?? []
  return {
    ids: spec.nodes.map((_, i) => `n${i}`),
    types: spec.nodes.map((x) => x.type ?? 'thing'),
    labels: spec.nodes.map((x, i) => x.label ?? `Thing ${i}`),
    tags: spec.nodes.map(() => []),
    props: spec.nodes.map((x) => x.props ?? []),
    created: Float64Array.from(spec.nodes, (x) => x.created ?? NaN),
    updated: Float64Array.from(spec.nodes, (x) => x.updated ?? NaN),
    src: Uint32Array.from(edges, (e) => e[0]),
    dst: Uint32Array.from(edges, (e) => e[1]),
    directed: new Uint8Array(edges.length).fill(1),
    edgeTypes: edges.map((e) => e[2] ?? 'rel'),
    edgeIds: edges.map((_, j) => `r${j}`),
    schema: [],
    scope: { label: 'edges' },
    key: `${n}:${edges.length}:${Math.random()}`,
  }
}
const run = (spec: Spec, which: ('anomalies' | 'temporal')[] = ['anomalies', 'temporal'], options = {}) => runAnalyses(input(spec), which, { seed: 1, ...options }).report.findings
const by = (fs: Finding[], id: string) => fs.find((f) => f.id === id)
/** Every finding well-formed against its input. */
function sound(fs: Finding[], spec: Spec) {
  const ids = new Set(spec.nodes.map((_, i) => `n${i}`))
  expect(new Set(fs.map((f) => f.id)).size).toBe(fs.length)
  for (const f of fs) {
    expect(f.score, f.id).toBeGreaterThanOrEqual(0)
    expect(f.score, f.id).toBeLessThanOrEqual(1)
    for (const e of f.entities ?? []) expect(ids.has(e), `${f.id} → ${e}`).toBe(true)
    expect(f.title, f.id).toBeTruthy()
  }
}

describe('anomalies at the edges', () => {
  it('fewer than five nodes is nothing; a ring where everyone has two links has no outlier; a star has one, its hub named, and its leaves are not "isolated"', () => {
    expect(run({ nodes: [{}, {}, {}, {}], edges: [[0, 1], [1, 2]] }, ['anomalies'])).toEqual([])
    expect(run({ nodes: [{}] }, ['anomalies'])).toEqual([])
    const ring: Spec = { nodes: Array.from({ length: 40 }, () => ({})), edges: Array.from({ length: 40 }, (_, i) => [i, (i + 1) % 40]) }
    const r = run(ring, ['anomalies'])
    sound(r, ring)
    expect(by(r, 'anomalies:degree-outliers')).toBeUndefined()
    expect(by(r, 'anomalies:isolated')).toBeUndefined()
    const star: Spec = { nodes: Array.from({ length: 101 }, (_, i) => ({ label: i ? `Leaf ${i}` : 'Hub' })), edges: Array.from({ length: 100 }, (_, i) => [i + 1, 0]) }
    const s = run(star, ['anomalies'])
    sound(s, star)
    const o = by(s, 'anomalies:degree-outliers')!
    expect(o.entities).toEqual(['n0'])
    expect(o.title).toMatch(/^“Hub” has 100 relationships/)
    expect(o.data?.outliers).toHaveLength(1)
    expect(by(s, 'anomalies:isolated')).toBeUndefined()
  })

  it('everybody isolated is a finding of 100%; labels the same once normalised are duplicates, short ones never; two-letter labels and the empty label are skipped', () => {
    const lonely: Spec = { nodes: Array.from({ length: 12 }, (_, i) => ({ type: i % 2 ? 'a' : 'b' })) }
    const r = run(lonely, ['anomalies'])
    sound(r, lonely)
    const iso = by(r, 'anomalies:isolated')!
    expect(iso.title).toBe('12 entities (100%) have no relationships at all')
    expect(iso.data?.count).toBe(12)
    expect(iso.score).toBe(1)
    expect(iso.entities).toHaveLength(12)
    const dupes: Spec = { nodes: [{ label: 'The Café' }, { label: 'cafe' }, { label: 'CAFE!' }, { label: 'a cafe' }, { label: 'Ab' }, { label: 'ab' }, { label: '' }, { label: '' }, { label: 'X Y' }, { label: 'x-y', type: 'other' }], edges: [[0, 1]] }
    const d = run(dupes, ['anomalies'])
    sound(d, dupes)
    const f = by(d, 'anomalies:duplicates')!
    expect(f.title).toBe('2 labels appear on more than one entity — 1 within a single type')
    expect(f.data?.groups).toEqual([
      { label: 'The Café', count: 4, types: ['thing'], ids: ['n0', 'n1', 'n2', 'n3'] },
      { label: 'X Y', count: 2, types: ['thing', 'other'], ids: ['n8', 'n9'] },
    ])
    expect(f.entities).toEqual(['n0', 'n1', 'n2', 'n3', 'n8', 'n9'])
  })

  it('a property on nine of ten is a gap; on every one or on few it is not; types under ten entities are not judged; the cap on listed outliers holds', () => {
    const nodes = (share: number, count = 10) => Array.from({ length: count }, (_, i) => ({ type: 'person', props: i < share * count ? ['name', 'role'] : ['name'] }))
    const gap: Spec = { nodes: nodes(0.9), edges: [[0, 1]] }
    const g = run(gap, ['anomalies'])
    sound(g, gap)
    expect(by(g, 'anomalies:missing-properties')?.title).toMatch(/lack “role”/)
    expect(by(run({ nodes: nodes(1), edges: [[0, 1]] }, ['anomalies']), 'anomalies:missing-properties')).toBeUndefined()
    expect(by(run({ nodes: nodes(0.7), edges: [[0, 1]] }, ['anomalies']), 'anomalies:missing-properties')).toBeUndefined()
    expect(by(run({ nodes: nodes(0.9, 9).concat([{ type: 'x', props: [] }]), edges: [[0, 1]] }, ['anomalies']), 'anomalies:missing-properties')).toBeUndefined()
    // Five hubs over 300 leaves; topK 2 lists two.
    const hubs = 5
    const leaves = 300
    const multi: Spec = { nodes: Array.from({ length: hubs + leaves }, (_, i) => ({ label: i < hubs ? `Hub ${i}` : `Leaf ${i}` })), edges: Array.from({ length: leaves }, (_, i) => [hubs + i, i % hubs]) }
    const m = run(multi, ['anomalies'], { topK: 2 })
    sound(m, multi)
    const o = by(m, 'anomalies:degree-outliers')!
    expect(o.entities).toHaveLength(2)
    expect(o.detail).toMatch(/^5 entities sit/)
  })
})

describe('temporal at the edges', () => {
  const dated = (days: number[], extra: Partial<Spec['nodes'][number]> = {}) => days.map((d) => ({ created: T0 + d * DAY, ...extra }))

  it('fewer than five dated nodes, every date on one instant, or unparsable dates give nothing; a day of hours is one period by the day', () => {
    expect(run({ nodes: dated([0, 1, 2, 3]) }, ['temporal'])).toEqual([])
    expect(run({ nodes: dated([0, 0, 0, 0, 0, 0]) }, ['temporal'])).toEqual([])
    expect(run({ nodes: Array.from({ length: 8 }, () => ({ created: NaN })) }, ['temporal'])).toEqual([])
    expect(run({ nodes: [...dated([0, 1, 2, 3]), { created: NaN }, { created: Infinity }] }, ['temporal'])).toEqual([]) // four finite dates
    const hours: Spec = { nodes: Array.from({ length: 6 }, (_, i) => ({ created: T0 + i * 3_600_000 })) }
    const h = run(hours, ['temporal'])
    sound(h, hours)
    const g = by(h, 'temporal:growth')!
    expect(g.title).toBe('6 entities created over 5 hours, 6.0 per day on average')
    expect(g.data).toMatchObject({ unit: 'day', periods: 1 })
    expect(by(h, 'temporal:bursts')).toBeUndefined()
    expect(by(h, 'temporal:recency')).toBeUndefined() // under a fortnight
  })

  it('a steady stream has no burst; fifty on one day among a trickle is one, its members listed, no other period standing out; a fixed unit is honoured', () => {
    const steady: Spec = { nodes: dated(Array.from({ length: 60 }, (_, i) => i)) }
    const s = run(steady, ['temporal'])
    sound(s, steady)
    expect(by(s, 'temporal:bursts')).toBeUndefined()
    expect(by(s, 'temporal:growth')?.data).toMatchObject({ unit: 'week', periods: 9 })
    const burst: Spec = { nodes: [...dated(Array.from({ length: 30 }, (_, i) => i)), ...dated(Array.from({ length: 50 }, () => 10))] }
    const b = run(burst, ['temporal'])
    sound(b, burst)
    const f = by(b, 'temporal:bursts')!
    expect(f.title).toBe('A burst in the day of 2024-01-11: 51 entities, 51× a typical day') // thirty days: by the day
    expect(f.detail).toMatch(/No other period stands out\.$/)
    expect(f.entities!.length).toBeGreaterThan(0)
    expect(f.data?.bursts).toHaveLength(1)
    const weekly = run(burst, ['temporal'], { unit: 'week' })
    expect(by(weekly, 'temporal:growth')?.data).toMatchObject({ unit: 'week', periods: 5 })
    expect(by(weekly, 'temporal:bursts')).toBeUndefined() // five weeks are too few periods to call one a burst
  })

  it('a dataset gone quiet says so; one still arriving says it is growing; a span of centuries goes by the quarter with the series capped; two runs are the same', () => {
    const old: Spec = { nodes: dated(Array.from({ length: 20 }, (_, i) => i * 3)) } // 2024, long ago
    const o = run(old, ['temporal'])
    sound(o, old)
    expect(by(o, 'temporal:recency')?.title).toMatch(/^Gone quiet: nothing created in /)
    const now = Date.now()
    // An even pace scores 0 and is kept out by the floor; half the dataset in the last days is worth saying.
    const even: Spec = { nodes: Array.from({ length: 20 }, (_, i) => ({ created: now - (19 - i) * DAY })) }
    expect(by(run(even, ['temporal']), 'temporal:recency')).toBeUndefined()
    const fresh: Spec = { nodes: [...Array.from({ length: 10 }, (_, i) => ({ created: now - (30 - i * 3) * DAY })), ...Array.from({ length: 10 }, () => ({ created: now - 3_600_000 }))] }
    const fr = run(fresh, ['temporal'])
    sound(fr, fresh)
    expect(by(fr, 'temporal:recency')?.title).toMatch(/^Still growing fast: 5\d% of entities arrived in the last 3 days/) // the window is a tenth of the span
    const centuries: Spec = { nodes: Array.from({ length: 50 }, (_, i) => ({ created: Date.UTC(1800 + i * 4, 5, 1) })) }
    const c = run(centuries, ['temporal'])
    sound(c, centuries)
    const g = by(c, 'temporal:growth')!
    expect(g.data).toMatchObject({ unit: 'quarter', first: '1800-06-01T00:00:00.000Z', last: '1996-06-01T00:00:00.000Z' })
    expect(g.data?.periods).toBe(785)
    expect((g.data?.series as unknown[]).length).toBe(400)
    expect(g.title).toMatch(/over 196\.\d years/)
    const a = run(burstSpec(), ['temporal', 'anomalies'])
    const b2 = run(burstSpec(), ['temporal', 'anomalies'])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b2))
  })

  it('arrivals and staleness need thirty days and enough of a type; undated updates are skipped; describeSpan at its thresholds', () => {
    const arr: Spec = { nodes: [...dated(Array.from({ length: 10 }, (_, i) => i * 4), { type: 'early' }), ...dated([60, 61, 62], { type: 'late' })] }
    const r = run(arr, ['temporal'])
    sound(r, arr)
    expect(by(r, 'temporal:arrivals')?.title).toMatch(/^late entities only appear from 2024-03-01, after 77% of the dataset existed/)
    const stale: Spec = { nodes: [...Array.from({ length: 6 }, (_, i) => ({ type: 'old', created: T0 + i * DAY, updated: T0 + 40 * DAY })), ...Array.from({ length: 6 }, (_, i) => ({ type: 'new', created: T0 + i * DAY, updated: Date.now() - DAY })), { type: 'undated', created: T0 + 50 * DAY, updated: NaN }] }
    const s = run(stale, ['temporal'])
    sound(s, stale)
    expect(by(s, 'temporal:staleness')?.title).toMatch(/^old entities are the stalest .*; new the freshest \(1 days\)$/)
    expect(by(run({ nodes: stale.nodes.slice(0, 9) }, ['temporal']), 'temporal:staleness')).toBeUndefined() // fewer than ten updated
    expect([describeSpan(0), describeSpan(0.5), describeSpan(1), describeSpan(13.6), describeSpan(14), describeSpan(89), describeSpan(90), describeSpan(729), describeSpan(730), describeSpan(3652.5)]).toEqual(['1 hours', '12 hours', '1 days', '14 days', '2 weeks', '13 weeks', '3 months', '24 months', '2.0 years', '10.0 years'])
  })
})

const burstSpec = (): Spec => ({ nodes: [...Array.from({ length: 30 }, (_, i) => ({ created: T0 + i * DAY, label: `L${i % 7}` })), ...Array.from({ length: 50 }, () => ({ created: T0 + 10 * DAY }))], edges: Array.from({ length: 40 }, (_, i) => [i, (i * 7) % 80]) })

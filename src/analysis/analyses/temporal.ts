import { clamp01, col, countBy, fixed, list, meanStd, median, num, pct, rank, sortedEntries, type Context } from '../shared'
import type { Finding, RunOptions } from '../types'

type Unit = NonNullable<RunOptions['unit']>
const DAY = 86_400_000

/**
 * Activity over time: how the dataset grew, when the bursts were, whether
 * it is still growing, which types arrived last and which have gone stale.
 */
export function temporal(ctx: Context, unit?: Unit): Finding[] {
  const { n, input } = ctx
  const out: Finding[] = []
  const dated: number[] = []
  for (let i = 0; i < n; i++) if (Number.isFinite(input.created[i])) dated.push(i)
  if (dated.length < 5) return out
  let lo = Infinity
  let hi = -Infinity
  for (const i of dated) {
    const t = input.created[i]
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  const spanDays = (hi - lo) / DAY
  if (spanDays < 1 / 24) return out
  const u = unit ?? pickUnit(spanDays)
  const per = new Map<number, number[]>()
  for (const i of dated) {
    const b = floorTo(input.created[i], u)
    let arr = per.get(b)
    if (!arr) per.set(b, (arr = []))
    arr.push(i)
  }
  const starts = [...per.keys()].sort((a, b) => a - b)
  // Every period between the first and last, zeros included, so the trend is honest.
  const all: number[] = []
  for (let t = starts[0]; t <= starts[starts.length - 1]; t = nextPeriod(t, u)) all.push(t)
  const counts = all.map((t) => per.get(t)?.length ?? 0)
  const degree = col(ctx, 'degree')

  // ── Growth ──
  const busiest = all[counts.indexOf(Math.max(...counts))]
  out.push({
    id: 'temporal:growth',
    analysis: 'temporal',
    title: `${num(dated.length)} entities created over ${describeSpan(spanDays)}, ${fixed(dated.length / Math.max(1, all.length), 1)} per ${u} on average`,
    detail: `From ${fmt(lo)} to ${fmt(hi)}; busiest ${u} started ${fmt(busiest)} with ${num(per.get(busiest)!.length)}. ${pct(all.filter((_, k) => counts[k] === 0).length / all.length)} of ${u}s saw nothing.`,
    score: 0.35,
    data: { unit: u, first: iso(lo), last: iso(hi), periods: all.length, series: all.map((t, k) => ({ start: iso(t), count: counts[k] })).slice(0, 400) },
    visual: { kind: 'plot', title: 'Growth by type', spec: { traces: [{ kind: 'bar', x: 'meta.createdAt', bin: u, agg: 'count', group: 'type', name: 'created' }], layout: { title: `Entities created per ${u}, by type`, barmode: 'stack', yaxis: { title: 'entities' } } } },
  })

  // ── Bursts ──
  if (all.length >= 6) {
    const { mean, std } = meanStd(counts)
    const typical = median(counts.filter((c) => c > 0)) || mean
    const bursts = all
      .map((t, k) => ({ t, count: counts[k], z: std ? (counts[k] - mean) / std : 0 }))
      .filter((b) => b.z >= 2.5 && b.count >= 5)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
    if (bursts.length) {
      const b0 = bursts[0]
      const members = per.get(b0.t)!
      const types = sortedEntries(countBy(members.map((i) => input.types[i])))
      const lead = degree ? rank(Float64Array.from(members, (i) => degree[i]), 20).map((k) => members[k]) : members.slice(0, 20)
      out.push({
        id: 'temporal:bursts',
        analysis: 'temporal',
        title: `A burst in the ${u} of ${fmt(b0.t)}: ${num(b0.count)} entities, ${fixed(b0.count / Math.max(1, typical), 0)}× a typical ${u}`,
        detail: `Mostly ${list(types.slice(0, 3).map(([t, c]) => `${t} (${num(c)})`), 3)}. ${bursts.length > 1 ? `Other bursts: ${list(bursts.slice(1).map((b) => `${fmt(b.t)} (${num(b.count)})`), 4)}.` : 'No other period stands out.'}`,
        score: clamp01(0.4 + Math.min(0.5, (b0.z - 2.5) * 0.1) + Math.min(0.1, bursts.length * 0.03)),
        entities: lead.map((i) => input.ids[i]),
        data: { unit: u, typical, bursts: bursts.map((b) => ({ start: iso(b.t), count: b.count, z: Number(b.z.toFixed(2)) })) },
        visual: { kind: 'plot', title: 'Bursts', spec: { traces: [{ kind: 'bar', x: 'meta.createdAt', bin: u, agg: 'count', name: 'created' }, { kind: 'scatter', selector: { ids: members.map((i) => input.ids[i]) }, x: 'meta.createdAt', bin: u, agg: 'count', name: `burst of ${fmt(b0.t)}`, fill: '#d94f2b', mode: 'markers' }], layout: { title: `Entities created per ${u}`, yaxis: { title: 'entities' } } } },
      })
    }
  }

  // ── Still growing, or gone quiet ──
  if (spanDays >= 14) {
    const tail = Math.max(DAY, (hi - lo) * 0.1)
    const recent = dated.filter((i) => input.created[i] >= hi - tail).length
    const now = Date.now()
    const quietDays = (now - hi) / DAY
    const rate = recent / dated.length
    const quiet = quietDays > Math.max(30, spanDays * 0.25)
    out.push({
      id: 'temporal:recency',
      analysis: 'temporal',
      title: quiet ? `Gone quiet: nothing created in ${describeSpan(quietDays)}` : rate >= 0.2 ? `Still growing fast: ${pct(rate)} of entities arrived in the last ${describeSpan(tail / DAY)}` : `Growth has slowed: ${pct(rate)} of entities arrived in the last ${describeSpan(tail / DAY)}`,
      detail: `The newest entity dates from ${fmt(hi)}. An even pace would put 10% in that window.`,
      score: clamp01(quiet ? 0.3 + Math.min(0.3, quietDays / 365) : Math.abs(rate - 0.1) * 2.5),
      data: { recentShare: rate, windowDays: Math.round(tail / DAY), quietDays: Math.round(quietDays) },
      visual: { kind: 'plot', title: 'Cumulative growth', spec: { traces: [{ kind: 'area', x: 'meta.createdAt', bin: u, agg: 'count', cumulative: true, name: 'entities' }], layout: { title: 'Cumulative entities', yaxis: { title: 'entities' } } } },
    })
  }

  // ── Which types arrived last ──
  const firstByType = new Map<string, number>()
  const countByType = countBy(dated.map((i) => input.types[i]))
  for (const i of dated) {
    const t = input.types[i]
    const c = input.created[i]
    if (c < (firstByType.get(t) ?? Infinity)) firstByType.set(t, c)
  }
  const arrivals = [...firstByType.entries()].filter(([t]) => (countByType.get(t) ?? 0) >= 3).sort((a, b) => b[1] - a[1])
  if (arrivals.length >= 2 && spanDays >= 30) {
    const [lateType, lateAt] = arrivals[0]
    const before = dated.filter((i) => input.created[i] < lateAt).length / dated.length
    if (before >= 0.3) {
      out.push({
        id: 'temporal:arrivals',
        analysis: 'temporal',
        title: `${lateType} entities only appear from ${fmt(lateAt)}, after ${pct(before)} of the dataset existed`,
        detail: `Order of first appearance: ${list([...arrivals].reverse().map(([t, at]) => `${t} (${fmt(at)})`), 6)}.`,
        score: clamp01(0.2 + before * 0.5),
        data: { arrivals: arrivals.map(([type, at]) => ({ type, first: iso(at), count: countByType.get(type) })) },
        visual: { kind: 'plot', title: 'When each type arrived', spec: { traces: [{ kind: 'scatter', x: 'meta.createdAt', y: 'type', mode: 'markers', name: 'entities', opacity: 0.5 }], layout: { title: 'Creation dates by type', yaxis: { type: 'category' } } } },
      })
    }
  }

  // ── Staleness by type ──
  const updated: number[] = []
  for (let i = 0; i < n; i++) if (Number.isFinite(input.updated[i])) updated.push(i)
  if (updated.length >= 10 && spanDays >= 30) {
    const now = Date.now()
    const byType = new Map<string, number[]>()
    for (const i of updated) {
      let arr = byType.get(input.types[i])
      if (!arr) byType.set(input.types[i], (arr = []))
      arr.push((now - input.updated[i]) / DAY)
    }
    const rows = [...byType.entries()]
      .filter(([, ages]) => ages.length >= 5)
      .map(([type, ages]) => ({ type, count: ages.length, medianAgeDays: median(ages), touchedLastMonth: ages.filter((a) => a <= 30).length / ages.length }))
      .sort((a, b) => b.medianAgeDays - a.medianAgeDays)
    if (rows.length >= 2) {
      const stale = rows[0]
      const fresh = rows[rows.length - 1]
      out.push({
        id: 'temporal:staleness',
        analysis: 'temporal',
        title: `${stale.type} entities are the stalest (median ${describeSpan(stale.medianAgeDays)} since an edit); ${fresh.type} the freshest (${describeSpan(fresh.medianAgeDays)})`,
        detail: list(rows.map((r) => `${r.type}: ${describeSpan(r.medianAgeDays)}, ${pct(r.touchedLastMonth)} touched in the last month`), 5) + '.',
        score: clamp01(0.15 + Math.min(0.4, Math.log10(Math.max(1, stale.medianAgeDays / Math.max(1, fresh.medianAgeDays))) * 0.3)),
        data: { types: rows.map((r) => ({ ...r, medianAgeDays: Math.round(r.medianAgeDays), touchedLastMonth: Number(r.touchedLastMonth.toFixed(3)) })) },
        visual: { kind: 'plot', title: 'Last edited, by type', spec: { traces: [{ kind: 'box', x: 'type', y: 'meta.updatedAt', name: 'last edited' }], layout: { title: 'When entities were last edited, by type', xaxis: { type: 'category' } } } },
      })
    }
  }

  return out
}

function pickUnit(spanDays: number): Unit {
  if (spanDays <= 45) return 'day'
  if (spanDays <= 400) return 'week'
  if (spanDays <= 2000) return 'month'
  return 'quarter'
}

function floorTo(t: number, u: Unit): number {
  const d = new Date(t)
  switch (u) {
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    case 'week': {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      const dow = (d.getUTCDay() + 6) % 7
      return day - dow * DAY
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1)
  }
}

function nextPeriod(t: number, u: Unit): number {
  const d = new Date(t)
  switch (u) {
    case 'day':
      return t + DAY
    case 'week':
      return t + 7 * DAY
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1)
  }
}

const iso = (t: number) => new Date(t).toISOString()
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10)

export function describeSpan(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`
  if (days < 14) return `${Math.round(days)} days`
  if (days < 90) return `${Math.round(days / 7)} weeks`
  if (days < 730) return `${Math.round(days / 30.4)} months`
  return `${(days / 365.25).toFixed(1)} years`
}

import { buildUndirected, type Csr } from '../core/graph/metrics/csr'
import type { MetricsResult } from '../core/graph/metrics/types'
import type { AnalysisInput, Finding } from './types'

/**
 * What every analysis gets: the input, the shared metric columns, the
 * undirected adjacency (built once) and a few index helpers.
 */
export interface Context {
  input: AnalysisInput
  metrics: MetricsResult
  csr: Csr
  n: number
  /** Node index by id. */
  index: Map<string, number>
  topK: number
  seed: number
}

export function makeContext(input: AnalysisInput, metrics: MetricsResult, opts: { topK: number; seed: number }): Context {
  const index = new Map<string, number>()
  input.ids.forEach((id, i) => index.set(id, i))
  const csr = buildUndirected({ ids: input.ids, src: input.src, dst: input.dst, directed: input.directed })
  return { input, metrics, csr, n: input.ids.length, index, topK: opts.topK, seed: opts.seed }
}

export const col = (ctx: Context, id: keyof MetricsResult['columns']): Float64Array | undefined => ctx.metrics.columns[id]

/** Indices sorted by a column, highest first, skipping non-finite values. */
export function rank(colv: Float64Array, k = Infinity): number[] {
  const idx: number[] = []
  for (let i = 0; i < colv.length; i++) if (Number.isFinite(colv[i])) idx.push(i)
  idx.sort((a, b) => colv[b] - colv[a])
  return Number.isFinite(k) ? idx.slice(0, k) : idx
}

/** Rank position (0 = highest) of every index under a column. */
export function ranks(colv: Float64Array): Float64Array {
  const order = rank(colv)
  const out = new Float64Array(colv.length).fill(NaN)
  order.forEach((i, r) => (out[i] = r))
  return out
}

/** Gini coefficient of a non-negative column: 0 = evenly spread, →1 = concentrated in a few. */
export function gini(colv: ArrayLike<number>): number {
  const v = Array.from(colv).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  const n = v.length
  if (n < 2) return 0
  let sum = 0
  let weighted = 0
  for (let i = 0; i < n; i++) {
    sum += v[i]
    weighted += (i + 1) * v[i]
  }
  if (sum === 0) return 0
  return (2 * weighted) / (n * sum) - (n + 1) / n
}

/** Share of the column's total held by the top k entries. */
export function topShare(colv: Float64Array, k: number): number {
  let total = 0
  for (let i = 0; i < colv.length; i++) if (Number.isFinite(colv[i])) total += colv[i]
  if (!total) return 0
  let top = 0
  for (const i of rank(colv, k)) top += colv[i]
  return top / total
}

export function meanStd(values: ArrayLike<number>): { mean: number; std: number; n: number } {
  let n = 0
  let s = 0
  let s2 = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    n++
    s += v
    s2 += v * v
  }
  if (!n) return { mean: 0, std: 0, n: 0 }
  const mean = s / n
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n }
}

export function median(values: number[]): number {
  if (!values.length) return NaN
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Shannon entropy of a count map, normalised to 0–1 by log(k). */
export function normalisedEntropy(counts: Iterable<number>): number {
  const c = [...counts].filter((x) => x > 0)
  const total = c.reduce((a, b) => a + b, 0)
  if (c.length < 2 || !total) return 0
  let h = 0
  for (const x of c) {
    const p = x / total
    h -= p * Math.log(p)
  }
  return h / Math.log(c.length)
}

export function countBy<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>()
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1)
  return m
}

export const sortedEntries = <T>(m: Map<T, number>): [T, number][] => [...m.entries()].sort((a, b) => b[1] - a[1])

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
export const num = (x: number) => Math.round(x).toLocaleString('en-US')
export const fixed = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—')
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Quote a label for prose. */
export const q = (s: string) => `“${s}”`
export const labelOf = (ctx: Context, i: number) => ctx.input.labels[i] || ctx.input.ids[i]
export const list = (items: string[], max = 3) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`)

/** Keep the best findings, dropping the ones below a floor. */
export function keep(findings: Finding[], n: number, floor = 0.05): Finding[] {
  return findings
    .filter((f) => f.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

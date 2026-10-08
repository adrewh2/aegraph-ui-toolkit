/** Numeric and categorical scales that turn raw values into palette positions. */

export type Domain = [number, number] | 'auto'

/** Resolve a domain from observed values; log domains clamp to the smallest positive value. */
export function domainOf(values: Iterable<number>, domain: Domain | undefined, log = false): [number, number] {
  if (domain && domain !== 'auto') return log ? [Math.max(domain[0], 1e-9), Math.max(domain[1], 1e-9)] : domain
  let min = Infinity
  let max = -Infinity
  let minPos = Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
    if (v > 0 && v < minPos) minPos = v
  }
  if (min === Infinity) return [0, 1]
  if (log) return [Number.isFinite(minPos) ? minPos : 1e-9, Math.max(max, Number.isFinite(minPos) ? minPos : 1e-9)]
  return [min, max]
}

/** Map a value into [0,1] over a domain (NaN when missing). */
export function normalizer(domain: [number, number], log = false): (v: number) => number {
  if (log) {
    const lo = Math.log10(Math.max(domain[0], 1e-9))
    const hi = Math.log10(Math.max(domain[1], 1e-9))
    const w = hi - lo
    return (v) => (Number.isFinite(v) && v > 0 ? (w === 0 ? 0.5 : Math.max(0, Math.min(1, (Math.log10(v) - lo) / w))) : NaN)
  }
  const w = domain[1] - domain[0]
  return (v) => (Number.isFinite(v) ? (w === 0 ? 0.5 : Math.max(0, Math.min(1, (v - domain[0]) / w))) : NaN)
}

export interface Categories {
  /** Keys in palette order (most frequent first). */
  keys: string[]
  counts: Map<string, number>
  index: Map<string, number>
  /** Every key's position by frequency, the overflow included — so a colour can still be drawn for what the legend has no room for. */
  rank: Map<string, number>
  /** Items whose key fell outside the top `max`. */
  overflow: number
}

/** Bucket categorical values, most frequent first; keys beyond `max` are grouped as overflow (rendered as "other"). */
export function categories(values: Iterable<string | number | undefined | null>, max = 12): Categories {
  const counts = new Map<string, number>()
  let overflow = 0
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue
    const k = String(v)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
  const keys = sorted.slice(0, max).map(([k]) => k)
  for (const [, c] of sorted.slice(max)) overflow += c
  const index = new Map(keys.map((k, i) => [k, i]))
  const rank = new Map(sorted.map(([k], i) => [k, i]))
  return { keys, counts, index, rank, overflow }
}

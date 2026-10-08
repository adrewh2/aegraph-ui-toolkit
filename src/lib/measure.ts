/**
 * `performance.measure`, keeping only the recent measures of each name. The
 * timeline holds every measure until something clears it, and some of these
 * are taken per frame (`dg:draw`) or per pointer move while a simulation runs
 * (`gg:grid`), so over a long session they add up to tens of megabytes. The
 * profiler and the headless checks read the latest ones
 * (`performance.getEntriesByName`), which stay.
 */
const KEPT = 500
const counts = new Map<string, number>()

export function measure(name: string, options: PerformanceMeasureOptions) {
  const n = (counts.get(name) ?? 0) + 1
  if (n > KEPT) performance.clearMeasures(name)
  counts.set(name, n > KEPT ? 1 : n)
  performance.measure(name, options)
}

import { clamp01, countBy, fixed, list, normalisedEntropy, num, pct, q, sortedEntries, type Context } from '../shared'
import type { Finding } from '../types'

const SEP = '§'
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * Ontology in use: the type mix, which types connect through which
 * relationship kinds, the cardinality of each kind, how completely
 * properties are filled against what the schema declares, and declared
 * types nobody instantiated.
 */
export function schema(ctx: Context): Finding[] {
  const { n, input } = ctx
  const out: Finding[] = []
  if (!n) return out
  const declared = new Map(input.schema.map((t) => [t.type, t]))

  // ── Type mix ──
  const typeCounts = sortedEntries(countBy(input.types))
  const top3 = typeCounts.slice(0, 3).reduce((s, [, c]) => s + c, 0) / n
  const spread = normalisedEntropy(typeCounts.map(([, c]) => c))
  out.push({
    id: 'schema:type-mix',
    analysis: 'schema',
    title: typeCounts.length === 1 ? `Everything is a ${typeCounts[0][0]}` : top3 > 0.8 ? `Three types make up ${pct(top3)} of the dataset` : `${num(typeCounts.length)} types in use, ${spread > 0.7 ? 'fairly evenly' : 'unevenly'} spread`,
    detail: `${list(typeCounts.slice(0, 6).map(([t, c]) => `${num(c)} ${t}`), 6)}. ${num(input.src.length)} relationships of ${num(new Set(input.edgeTypes).size)} kinds.`,
    score: clamp01(0.2 + (1 - spread) * 0.4),
    data: { types: typeCounts.map(([type, count]) => ({ type, count, share: count / n })) },
    visual: { kind: 'plot', title: 'Entities by type', spec: { traces: [{ kind: 'bar', x: 'type', agg: 'count', name: 'entities' }], layout: { title: 'Entities by type', xaxis: { type: 'category' }, yaxis: { title: 'entities' } } } },
  })

  // ── Type × relationship × type patterns ──
  const patterns = new Map<string, number>()
  const perKind = new Map<string, { pairs: Set<string>; count: number; outBy: Map<number, number>; inBy: Map<number, number> }>()
  for (let j = 0; j < input.src.length; j++) {
    const s = input.src[j]
    const t = input.dst[j]
    const k = input.edgeTypes[j]
    const key = `${input.types[s]}${SEP}${k}${SEP}${input.types[t]}`
    patterns.set(key, (patterns.get(key) ?? 0) + 1)
    let pk = perKind.get(k)
    if (!pk) perKind.set(k, (pk = { pairs: new Set(), count: 0, outBy: new Map(), inBy: new Map() }))
    pk.pairs.add(`${input.types[s]}→${input.types[t]}`)
    pk.count++
    pk.outBy.set(s, (pk.outBy.get(s) ?? 0) + 1)
    pk.inBy.set(t, (pk.inBy.get(t) ?? 0) + 1)
  }
  const patternRows = sortedEntries(patterns).map(([key, count]) => {
    const [from, kind, to] = key.split(SEP)
    return { from, kind, to, count }
  })
  if (patternRows.length) {
    const p0 = patternRows[0]
    const polymorphic = [...perKind.entries()].filter(([, v]) => v.pairs.size >= 3).sort((a, b) => b[1].pairs.size - a[1].pairs.size)
    out.push({
      id: 'schema:patterns',
      analysis: 'schema',
      title: `${p0.from} —${p0.kind}→ ${p0.to} is the dominant pattern (${num(p0.count)}, ${pct(p0.count / input.src.length)} of relationships)`,
      detail: `${num(patternRows.length)} distinct type–relationship–type patterns. ${polymorphic.length ? `Polymorphic kinds: ${list(polymorphic.slice(0, 3).map(([k, v]) => `${k} joins ${v.pairs.size} type pairs`), 3)}.` : 'Every relationship kind joins a single pair of types.'}`,
      score: clamp01(0.3 + Math.min(0.3, patternRows.length / 60) + (polymorphic.length ? 0.15 : 0)),
      data: { patterns: patternRows.slice(0, 40), polymorphic: polymorphic.slice(0, 10).map(([k, v]) => ({ kind: k, typePairs: v.pairs.size, count: v.count })) },
      visual: { kind: 'table', title: 'How types connect', columns: ['from', 'relationship', 'to', 'count'], rows: patternRows.slice(0, 40).map((r) => [r.from, r.kind, r.to, r.count]) },
    })
  }

  // ── Cardinality per relationship kind ──
  const card = [...perKind.entries()]
    .filter(([, v]) => v.count >= 5)
    .map(([kind, v]) => {
      const outMax = Math.max(...v.outBy.values())
      const inMax = Math.max(...v.inBy.values())
      const outAvg = v.count / v.outBy.size
      const inAvg = v.count / v.inBy.size
      const many = (avg: number, max: number) => avg > 1.2 || max > 3
      const shape = `${many(inAvg, inMax) ? 'n' : '1'}:${many(outAvg, outMax) ? 'n' : '1'}`
      return { kind, count: v.count, sources: v.outBy.size, targets: v.inBy.size, outAvg, outMax, inAvg, inMax, shape }
    })
    .sort((a, b) => b.count - a.count)
  if (card.length) {
    const funnels = card.filter((c) => c.shape === 'n:1' || (c.inAvg > 5 && c.outAvg < 1.5))
    const c0 = funnels[0] ?? card[0]
    out.push({
      id: 'schema:cardinality',
      analysis: 'schema',
      title: funnels.length ? `${q(c0.kind)} is many-to-one: each source has ~${fixed(c0.outAvg, 1)}, each target gathers ${fixed(c0.inAvg, 1)} (max ${num(c0.inMax)})` : `Relationship kinds are mostly many-to-many`,
      detail: list(card.slice(0, 5).map((c) => `${c.kind}: ${c.shape} (${num(c.count)} ties, ${num(c.sources)} sources → ${num(c.targets)} targets)`), 5) + '.',
      score: clamp01(0.2 + Math.min(0.35, funnels.length * 0.12) + Math.min(0.2, Math.log10(Math.max(1, c0.inMax)) * 0.1)),
      data: { kinds: card.map((c) => ({ ...c, outAvg: Number(c.outAvg.toFixed(2)), inAvg: Number(c.inAvg.toFixed(2)) })) },
      visual: { kind: 'table', title: 'Cardinality per relationship kind', columns: ['relationship', 'shape', 'ties', 'sources', 'targets', 'per source', 'per target', 'max per target'], rows: card.map((c) => [c.kind, c.shape, c.count, c.sources, c.targets, Number(c.outAvg.toFixed(1)), Number(c.inAvg.toFixed(1)), c.inMax]) },
    })
  }

  // ── Property coverage vs. the declared schema ──
  const byType = new Map<string, number[]>()
  input.types.forEach((t, i) => {
    let arr = byType.get(t)
    if (!arr) byType.set(t, (arr = []))
    arr.push(i)
  })
  const coverage: { type: string; property: string; declared: boolean; coverage: number; instances: number }[] = []
  for (const [type, idx] of byType) {
    if (idx.length < 3) continue
    const present = countBy(idx.flatMap((i) => input.props[i]))
    const decl = declared.get(type)
    const keys = new Set<string>([...(decl?.properties ?? []), ...present.keys()])
    for (const key of keys) coverage.push({ type, property: key, declared: !!decl?.properties.includes(key), coverage: (present.get(key) ?? 0) / idx.length, instances: idx.length })
  }
  const gaps = coverage.filter((c) => c.declared && c.coverage < 0.5).sort((a, b) => b.instances * (1 - b.coverage) - a.instances * (1 - a.coverage))
  const undeclared = coverage.filter((c) => !c.declared && c.coverage >= 0.5 && declared.get(c.type)?.declared).sort((a, b) => b.instances * b.coverage - a.instances * a.coverage)
  if (gaps.length || undeclared.length) {
    const g0 = gaps[0]
    const u0 = undeclared[0]
    out.push({
      id: 'schema:coverage',
      analysis: 'schema',
      title: g0 ? `${q(g0.property)} is set on only ${pct(g0.coverage)} of ${num(g0.instances)} ${g0.type} entities` : `${q(u0.property)} is used on ${pct(u0.coverage)} of ${u0.type} entities but the schema does not declare it`,
      detail: `${gaps.length ? `Declared but sparse: ${list(gaps.slice(0, 4).map((c) => `${c.type}.${c.property} ${pct(c.coverage)}`), 4)}. ` : ''}${undeclared.length ? `Used but undeclared: ${list(undeclared.slice(0, 4).map((c) => `${c.type}.${c.property} ${pct(c.coverage)}`), 4)}.` : ''}`,
      score: clamp01(0.25 + Math.min(0.35, gaps.length * 0.06) + Math.min(0.25, undeclared.length * 0.08)),
      data: { gaps: gaps.slice(0, 30), undeclared: undeclared.slice(0, 30) },
      visual: { kind: 'table', title: 'Property coverage', columns: ['type', 'property', 'declared', 'coverage', 'instances'], rows: [...gaps.slice(0, 20), ...undeclared.slice(0, 20)].map((c) => [c.type, c.property, c.declared ? 'yes' : 'no', `${(c.coverage * 100).toFixed(0)}%`, c.instances]) },
    })
  }

  // ── Declared types without instances; inferred types without a declaration ──
  const empty = input.schema.filter((t) => t.declared && !byType.has(t.type))
  const inferred = [...byType.keys()].filter((t) => !declared.get(t)?.declared)
  if (empty.length || inferred.length) {
    out.push({
      id: 'schema:declared-vs-used',
      analysis: 'schema',
      title: empty.length && inferred.length ? `${num(empty.length)} declared ${plural(empty.length, 'type has', 'types have')} no entities; ${num(inferred.length)} ${plural(inferred.length, 'type in use is', 'types in use are')} undeclared` : empty.length ? `${num(empty.length)} declared ${empty.length === 1 ? 'type has' : 'types have'} no entities` : `${num(inferred.length)} ${inferred.length === 1 ? 'type is' : 'types are'} in use without a declaration`,
      detail: `${empty.length ? `Empty: ${list(empty.map((t) => t.type), 6)}. ` : ''}${inferred.length ? `Undeclared: ${list(inferred.map((t) => `${t} (${num(byType.get(t)!.length)})`), 6)}.` : ''}`,
      score: clamp01(0.15 + Math.min(0.3, empty.length * 0.05) + Math.min(0.3, inferred.length * 0.05)),
      data: { empty: empty.map((t) => t.type), inferred: inferred.map((t) => ({ type: t, count: byType.get(t)!.length })) },
    })
  }

  // ── Types that never link ──
  const linked = new Uint8Array(n)
  for (let j = 0; j < input.src.length; j++) {
    linked[input.src[j]] = 1
    linked[input.dst[j]] = 1
  }
  const lonely = [...byType.entries()]
    .filter(([, idx]) => idx.length >= 5)
    .map(([type, idx]) => ({ type, count: idx.length, unlinked: idx.filter((i) => !linked[i]).length / idx.length }))
    .filter((t) => t.unlinked >= 0.5)
    .sort((a, b) => b.unlinked * b.count - a.unlinked * a.count)
  if (lonely.length) {
    const l0 = lonely[0]
    out.push({
      id: 'schema:unlinked-types',
      analysis: 'schema',
      title: `${pct(l0.unlinked)} of ${l0.type} entities have no relationships`,
      detail: `Types whose instances mostly stand alone: ${list(lonely.map((t) => `${t.type} ${pct(t.unlinked)} of ${num(t.count)}`), 5)}. They cannot take part in any graph analysis until linked.`,
      score: clamp01(0.2 + Math.min(0.5, (l0.count * l0.unlinked) / n) + Math.min(0.2, lonely.length * 0.05)),
      data: { types: lonely },
    })
  }

  return out
}

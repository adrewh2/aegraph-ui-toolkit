import { clamp01, col, countBy, fixed, labelOf, list, meanStd, num, pct, q, sortedEntries, type Context } from '../shared'
import type { Finding } from '../types'

/**
 * Outliers and gaps: degree outliers (overall and against their type),
 * isolated entities, near-duplicate labels, entities missing the
 * properties their type usually carries, unlinked pairs that share many
 * neighbours, and relationships joining an unusual pair of types.
 */
export function anomalies(ctx: Context): Finding[] {
  const { n, input, topK } = ctx
  const out: Finding[] = []
  const degree = col(ctx, 'degree')
  if (!degree || n < 5) return out
  const ids = (idx: number[]) => idx.map((i) => input.ids[i])

  // ── Degree outliers, against the whole and against the type ──
  {
    const logDeg = Float64Array.from(degree, (d) => Math.log1p(d))
    const { mean, std } = meanStd(logDeg)
    const byType = new Map<string, number[]>()
    input.types.forEach((t, i) => {
      let arr = byType.get(t)
      if (!arr) byType.set(t, (arr = []))
      arr.push(i)
    })
    const typeStats = new Map<string, { mean: number; std: number; n: number }>()
    for (const [t, idx] of byType) typeStats.set(t, meanStd(Float64Array.from(idx, (i) => logDeg[i])))
    const rows = []
    for (let i = 0; i < n; i++) {
      const z = std ? (logDeg[i] - mean) / std : 0
      const ts = typeStats.get(input.types[i])!
      const zt = ts.n >= 5 && ts.std ? (logDeg[i] - ts.mean) / ts.std : 0
      // Far out overall, or far out for its type — and always by a real margin, not a tight type's noise.
      const typeMean = Math.expm1(ts.mean)
      if (degree[i] >= 8 && (z >= 3 || (zt >= 3.5 && degree[i] >= typeMean * 4))) rows.push({ i, z, zt, typeMean })
    }
    rows.sort((a, b) => Math.max(b.z, b.zt) - Math.max(a.z, a.zt))
    const top = rows.slice(0, topK)
    if (top.length) {
      const r0 = top[0]
      out.push({
        id: 'anomalies:degree-outliers',
        analysis: 'anomalies',
        title: `${q(labelOf(ctx, r0.i))} has ${num(degree[r0.i])} relationships where a typical ${input.types[r0.i]} has ${fixed(r0.typeMean, 1)}`,
        detail: `${num(rows.length)} entities sit more than 3σ above the norm (on log degree). ${list(top.slice(0, 5).map((r) => `${labelOf(ctx, r.i)} (${input.types[r.i]}, ${num(degree[r.i])})`), 5)}. Hubs this far out are either the dataset's real anchors or a modelling shortcut (a catch-all node).`,
        score: clamp01(0.3 + Math.min(0.4, (Math.max(r0.z, r0.zt) - 3) * 0.15) + Math.min(0.2, rows.length * 0.02)),
        entities: ids(top.map((r) => r.i)),
        data: { outliers: top.map((r) => ({ id: input.ids[r.i], label: labelOf(ctx, r.i), type: input.types[r.i], degree: degree[r.i], z: Number(r.z.toFixed(2)), zWithinType: Number(r.zt.toFixed(2)), typicalForType: Number(r.typeMean.toFixed(1)) })) },
        visual: { kind: 'plot', title: 'Degree by type', spec: { traces: [{ kind: 'box', x: 'type', y: 'degree', name: 'degree' }, { kind: 'scatter', selector: { ids: ids(top.map((r) => r.i)) }, x: 'type', y: 'degree', mode: 'markers', name: 'outliers', fill: '#d94f2b' }], layout: { title: 'Relationships per entity, by type', xaxis: { type: 'category' }, yaxis: { title: 'degree', type: 'log' } } } },
      })
    }
  }

  // ── Isolated entities ──
  {
    const iso: number[] = []
    for (let i = 0; i < n; i++) if (degree[i] === 0) iso.push(i)
    if (iso.length) {
      const byType = sortedEntries(countBy(iso.map((i) => input.types[i])))
      out.push({
        id: 'anomalies:isolated',
        analysis: 'anomalies',
        title: `${num(iso.length)} entities (${pct(iso.length / n)}) have no relationships at all`,
        detail: `Mostly ${list(byType.slice(0, 4).map(([t, c]) => `${t} (${num(c)})`), 4)}. They are invisible to every graph view and metric until linked.`,
        score: clamp01(0.1 + (iso.length / n) * 0.9),
        entities: ids(iso.slice(0, 50)),
        data: { count: iso.length, byType: byType.map(([type, count]) => ({ type, count })) },
        visual: { kind: 'plot', title: 'Isolated entities by type', spec: { selector: { ids: ids(iso) }, traces: [{ kind: 'bar', x: 'type', agg: 'count', name: 'isolated' }], layout: { title: 'Entities without relationships, by type', xaxis: { type: 'category' } } } },
      })
    }
  }

  // ── Near-duplicate labels ──
  {
    const groups = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const key = normalise(input.labels[i])
      if (key.length < 3) continue
      let arr = groups.get(key)
      if (!arr) groups.set(key, (arr = []))
      arr.push(i)
    }
    const dupes = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length)
    if (dupes.length) {
      const sameType = dupes.filter((g) => new Set(g.map((i) => input.types[i])).size === 1)
      const d0 = sameType[0] ?? dupes[0]
      out.push({
        id: 'anomalies:duplicates',
        analysis: 'anomalies',
        title: `${num(dupes.length)} ${dupes.length === 1 ? 'label appears' : 'labels appear'} on more than one entity${sameType.length ? ` — ${num(sameType.length)} within a single type` : ''}`,
        detail: `${q(input.labels[d0[0]])} × ${d0.length} (${list([...new Set(d0.map((i) => input.types[i]))])}). ${dupes.length > 1 ? `Also ${list(dupes.filter((g) => g !== d0).slice(0, 3).map((g) => `${q(input.labels[g[0]])} × ${g.length}`), 3)}. ` : ''}Same-type duplicates are usually the same thing entered twice.`,
        score: clamp01(0.2 + Math.min(0.5, sameType.length * 0.06) + Math.min(0.2, dupes.length * 0.01)),
        entities: ids(dupes.slice(0, 10).flat()),
        data: { groups: dupes.slice(0, 40).map((g) => ({ label: input.labels[g[0]], count: g.length, types: [...new Set(g.map((i) => input.types[i]))], ids: ids(g) })) },
        visual: { kind: 'table', title: 'Duplicate labels', columns: ['label', 'copies', 'types', 'degrees'], rows: dupes.slice(0, 40).map((g) => [input.labels[g[0]], g.length, [...new Set(g.map((i) => input.types[i]))].join(', '), g.map((i) => degree[i]).join(', ')]) },
      })
    }
  }

  // ── Missing properties ──
  {
    const byType = new Map<string, number[]>()
    input.types.forEach((t, i) => {
      let arr = byType.get(t)
      if (!arr) byType.set(t, (arr = []))
      arr.push(i)
    })
    const gaps: { type: string; property: string; expected: number; missing: number[] }[] = []
    for (const [type, idx] of byType) {
      if (idx.length < 10) continue
      const present = countBy(idx.flatMap((i) => input.props[i]))
      for (const [key, c] of present) {
        const share = c / idx.length
        if (share < 0.8 || share === 1) continue
        const missing = idx.filter((i) => !input.props[i].includes(key))
        gaps.push({ type, property: key, expected: share, missing })
      }
    }
    gaps.sort((a, b) => b.missing.length - a.missing.length)
    if (gaps.length) {
      const g0 = gaps[0]
      out.push({
        id: 'anomalies:missing-properties',
        analysis: 'anomalies',
        title: `${num(g0.missing.length)} ${g0.type} entities lack ${q(g0.property)}, which ${pct(g0.expected)} of ${g0.type} entities carry`,
        detail: list(gaps.slice(0, 5).map((g) => `${g.type}.${g.property}: ${num(g.missing.length)} missing of ${num(g.missing.length / (1 - g.expected))}`), 5) + '.',
        score: clamp01(0.2 + Math.min(0.4, gaps.reduce((s, g) => s + g.missing.length, 0) / n) + Math.min(0.2, gaps.length * 0.04)),
        entities: ids(g0.missing.slice(0, 50)),
        data: { gaps: gaps.slice(0, 20).map((g) => ({ type: g.type, property: g.property, expected: Number(g.expected.toFixed(3)), missing: g.missing.length, ids: ids(g.missing.slice(0, 50)) })) },
        visual: { kind: 'table', title: 'Missing properties', columns: ['type', 'property', 'usually present', 'missing on', 'examples'], rows: gaps.slice(0, 20).map((g) => [g.type, g.property, `${(g.expected * 100).toFixed(0)}%`, g.missing.length, g.missing.slice(0, 3).map((i) => labelOf(ctx, i)).join(', ')]) },
      })
    }
  }

  // ── Probable missing links: unlinked pairs with many shared neighbours ──
  {
    const { offsets, neighbors } = ctx.csr
    const CAP = 40
    const shared = new Map<number, number>()
    for (let w = 0; w < n; w++) {
      const a = offsets[w]
      const b = offsets[w + 1]
      const d = b - a
      if (d < 2 || d > CAP) continue
      for (let x = a; x < b; x++)
        for (let y = x + 1; y < b; y++) {
          const u = neighbors[x]
          const v = neighbors[y]
          const key = u < v ? u * n + v : v * n + u
          shared.set(key, (shared.get(key) ?? 0) + 1)
        }
    }
    const adjacent = (u: number, v: number) => {
      for (let k = offsets[u]; k < offsets[u + 1]; k++) if (neighbors[k] === v) return true
      return false
    }
    const cands: { u: number; v: number; shared: number; jaccard: number }[] = []
    for (const [key, s] of shared) {
      if (s < 3) continue
      const u = Math.floor(key / n)
      const v = key % n
      if (adjacent(u, v)) continue
      const du = offsets[u + 1] - offsets[u]
      const dv = offsets[v + 1] - offsets[v]
      cands.push({ u, v, shared: s, jaccard: s / (du + dv - s) })
    }
    cands.sort((a, b) => b.jaccard * b.shared - a.jaccard * a.shared)
    const top = cands.slice(0, topK)
    if (top.length) {
      const c0 = top[0]
      out.push({
        id: 'anomalies:missing-links',
        analysis: 'anomalies',
        title: `${q(labelOf(ctx, c0.u))} and ${q(labelOf(ctx, c0.v))} share ${num(c0.shared)} neighbours but are not linked`,
        detail: `${num(cands.length)} unlinked pairs share three or more neighbours. Strongest: ${list(top.slice(0, 4).map((c) => `${labelOf(ctx, c.u)} ↔ ${labelOf(ctx, c.v)} (${num(c.shared)} shared, Jaccard ${fixed(c.jaccard)})`), 4)}. These are the relationships most worth checking or adding.`,
        score: clamp01(0.3 + Math.min(0.4, c0.jaccard) + Math.min(0.2, Math.log10(Math.max(1, cands.length)) * 0.07)),
        entities: ids(top.flatMap((c) => [c.u, c.v])),
        data: { pairs: top.map((c) => ({ a: { id: input.ids[c.u], label: labelOf(ctx, c.u), type: input.types[c.u] }, b: { id: input.ids[c.v], label: labelOf(ctx, c.v), type: input.types[c.v] }, shared: c.shared, jaccard: Number(c.jaccard.toFixed(3)) })) },
        visual: { kind: 'graph', title: 'Probable missing links', filter: { roots: ids(top.slice(0, 5).flatMap((c) => [c.u, c.v])), depth: 1 }, style: { color: { by: 'type' }, size: { by: 'degree', min: 3, max: 16, log: true }, highlight: ids(top.slice(0, 5).flatMap((c) => [c.u, c.v])), labels: 'auto' }, layout: 'force', focus: ids(top.slice(0, 5).flatMap((c) => [c.u, c.v])) },
      })
    }
  }

  // ── Relationships joining an unusual pair of types ──
  {
    const byKind = new Map<string, Map<string, number[]>>()
    for (let j = 0; j < input.src.length; j++) {
      const k = input.edgeTypes[j]
      const pair = `${input.types[input.src[j]]} → ${input.types[input.dst[j]]}`
      let m = byKind.get(k)
      if (!m) byKind.set(k, (m = new Map()))
      let arr = m.get(pair)
      if (!arr) m.set(pair, (arr = []))
      arr.push(j)
    }
    const odd: { kind: string; pair: string; edges: number[]; usual: string; usualCount: number }[] = []
    for (const [kind, m] of byKind) {
      const total = [...m.values()].reduce((s, a) => s + a.length, 0)
      if (total < 20) continue
      const [usual, usualEdges] = sortedEntries(new Map([...m.entries()].map(([p, a]) => [p, a.length])))[0]
      for (const [pair, edges] of m) if (pair !== usual && edges.length / total <= 0.02) odd.push({ kind, pair, edges, usual, usualCount: usualEdges })
    }
    odd.sort((a, b) => b.usualCount - a.usualCount)
    if (odd.length) {
      const o0 = odd[0]
      out.push({
        id: 'anomalies:odd-patterns',
        analysis: 'anomalies',
        title: `${num(o0.edges.length)} ${q(o0.kind)} ${o0.edges.length === 1 ? 'relationship links' : 'relationships link'} ${o0.pair}, unlike the ${num(o0.usualCount)} that link ${o0.usual}`,
        detail: `${num(odd.length)} rare type pairings (≤ 2% of their kind). ${list(odd.slice(1, 4).map((o) => `${o.kind}: ${o.pair} × ${o.edges.length}`), 3)}. Either a modelling exception or a mis-typed endpoint.`,
        score: clamp01(0.2 + Math.min(0.4, odd.length * 0.05)),
        entities: ids([...new Set(odd.slice(0, 5).flatMap((o) => o.edges.slice(0, 5).flatMap((j) => [input.src[j], input.dst[j]])))]),
        data: { odd: odd.slice(0, 20).map((o) => ({ kind: o.kind, pair: o.pair, count: o.edges.length, usual: o.usual, usualCount: o.usualCount, relationshipIds: o.edges.slice(0, 20).map((j) => input.edgeIds[j]) })) },
        visual: { kind: 'table', title: 'Unusual type pairings', columns: ['relationship', 'links', 'count', 'usually links', 'usual count'], rows: odd.slice(0, 20).map((o) => [o.kind, o.pair, o.edges.length, o.usual, o.usualCount]) },
      })
    }
  }

  return out
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

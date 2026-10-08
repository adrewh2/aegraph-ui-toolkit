import { clamp01, col, fixed, gini, labelOf, list, num, pct, q, rank, ranks, topShare, type Context } from '../shared'
import type { Finding, Visual } from '../types'

/**
 * Key players: who matters (PageRank), who holds the graph together
 * (betweenness far above degree), how concentrated influence is, and the
 * shape of the degree distribution.
 */
export function centrality(ctx: Context): Finding[] {
  const { n, input, topK } = ctx
  const out: Finding[] = []
  const degree = col(ctx, 'degree')
  const pagerank = col(ctx, 'pagerank')
  const betweenness = col(ctx, 'betweenness')
  const community = col(ctx, 'community')
  if (!degree || n < 3) return out
  const ids = (idx: number[]) => idx.map((i) => input.ids[i])
  const big = n > 2000

  // ── Hubs ──
  if (pagerank) {
    const top = rank(pagerank, topK)
    const share = topShare(pagerank, topK)
    const g = gini(pagerank)
    const lead = top[0]
    const secondShare = top[1] !== undefined ? pagerank[top[1]] : 0
    const dominance = secondShare ? pagerank[lead] / secondShare : 1
    out.push({
      id: 'centrality:hubs',
      analysis: 'centrality',
      title: `${q(labelOf(ctx, lead))} is the most influential entity${dominance >= 1.5 ? `, ${fixed(dominance, 1)}× the runner-up` : ''}`,
      detail: `The top ${top.length} by PageRank hold ${pct(share)} of all influence (Gini ${fixed(g)} — ${g > 0.6 ? 'highly concentrated' : g > 0.35 ? 'moderately concentrated' : 'evenly spread'}). Leaders: ${list(top.slice(0, 5).map((i) => `${labelOf(ctx, i)} (${input.types[i]}, degree ${num(degree[i])})`), 5)}.`,
      score: clamp01(0.45 + g * 0.55),
      entities: ids(top),
      data: { top: top.map((i) => ({ id: input.ids[i], label: labelOf(ctx, i), type: input.types[i], pagerank: round6(pagerank[i]), degree: degree[i] })), gini: g, topShare: share },
      visual: graphVisual(`Hubs by PageRank`, ids(top), big, { color: community ? { by: 'community' } : { by: 'type' }, size: { by: 'metric', metric: 'pagerank', min: 3, max: 22, log: false } }),
    })
    // Concentration as a chart.
    const top20 = rank(pagerank, 20)
    out.push({
      id: 'centrality:concentration',
      analysis: 'centrality',
      title: share > 0.5 ? `A handful of entities carry most of the influence` : share > 0.25 ? `Influence sits with a visible top tier` : `Influence is spread out; no entity dominates`,
      detail: `The top ${top.length} of ${num(n)} entities hold ${pct(share)} of PageRank; the top 1% (${num(Math.max(1, Math.ceil(n / 100)))}) hold ${pct(topShare(pagerank, Math.max(1, Math.ceil(n / 100))))}.`,
      score: clamp01(Math.abs(share - 0.2) * 1.6),
      entities: ids(top20),
      data: { topShare: share },
      visual: { kind: 'plot', title: 'Top 20 by PageRank', spec: { selector: { ids: ids(top20) }, traces: [{ kind: 'bar', x: 'label', y: 'metric.pagerank', name: 'PageRank', text: 'type' }], layout: { title: 'Top 20 entities by PageRank', xaxis: { type: 'category' } } } },
    })
  }

  // ── Bridges: central to paths, modest in degree ──
  if (betweenness) {
    const bRank = ranks(betweenness)
    const dRank = ranks(degree)
    const cand: { i: number; lift: number }[] = []
    const window = Math.min(n, Math.max(20, Math.round(n * 0.02)))
    for (let i = 0; i < n; i++) {
      if (!(bRank[i] < window) || betweenness[i] <= 0) continue
      const lift = (dRank[i] + 1) / (bRank[i] + 1)
      if (lift >= 3) cand.push({ i, lift })
    }
    cand.sort((a, b) => b.lift - a.lift)
    const bridges = cand.slice(0, topK)
    if (bridges.length) {
      const b0 = bridges[0]
      out.push({
        id: 'centrality:bridges',
        analysis: 'centrality',
        title: `${bridges.length} ${bridges.length === 1 ? 'entity is a bridge' : 'entities are bridges'}: on many shortest paths despite few connections`,
        detail: `${q(labelOf(ctx, b0.i))} ranks #${num(bRank[b0.i] + 1)} by betweenness but only #${num(dRank[b0.i] + 1)} by degree (${num(degree[b0.i])} links). Removing bridges like ${list(bridges.slice(0, 3).map((b) => labelOf(ctx, b.i)))} would cut the graph apart.`,
        score: clamp01(0.4 + 0.12 * bridges.length + 0.02 * Math.log(b0.lift)),
        entities: ids(bridges.map((b) => b.i)),
        data: { bridges: bridges.map((b) => ({ id: input.ids[b.i], label: labelOf(ctx, b.i), type: input.types[b.i], betweenness: round6(betweenness[b.i]), betweennessRank: bRank[b.i] + 1, degree: degree[b.i], degreeRank: dRank[b.i] + 1 })) },
        visual: graphVisual('Bridges', ids(bridges.map((b) => b.i)), big, { color: community ? { by: 'community' } : { by: 'type' }, size: { by: 'metric', metric: 'betweenness', min: 3, max: 22 } }),
      })
    }
  }

  // ── Connectors: neighbours span many communities ──
  if (community) {
    const { offsets, neighbors } = ctx.csr
    const spans = new Float64Array(n)
    const seen = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      seen.clear()
      for (let k = offsets[i]; k < offsets[i + 1]; k++) seen.set(community[neighbors[k]], 1)
      spans[i] = seen.size
    }
    const communityCount = ctx.metrics.communities?.count ?? 0
    const top = rank(spans, topK).filter((i) => spans[i] >= 3 && spans[i] > 1 + degree[i] * 0.15)
    if (top.length && communityCount > 3) {
      const t0 = top[0]
      out.push({
        id: 'centrality:connectors',
        analysis: 'centrality',
        title: `${q(labelOf(ctx, t0))} connects ${num(spans[t0])} of the ${num(communityCount)} communities`,
        detail: `Connectors have neighbours across many communities relative to their degree: ${list(top.slice(0, 4).map((i) => `${labelOf(ctx, i)} (${num(spans[i])} communities, ${num(degree[i])} links)`), 4)}.`,
        score: clamp01(0.3 + 0.1 * Math.min(6, spans[t0] - 2)),
        entities: ids(top),
        data: { connectors: top.map((i) => ({ id: input.ids[i], label: labelOf(ctx, i), type: input.types[i], communities: spans[i], degree: degree[i] })) },
        visual: graphVisual('Community connectors', ids(top), big, { color: { by: 'community' }, size: { by: 'degree', min: 3, max: 18, log: true } }),
      })
    }
  }

  // ── Degree distribution ──
  {
    const top1 = Math.max(1, Math.ceil(n / 100))
    const edgeShare = topShare(degree, top1)
    let sum = 0
    let max = 0
    let isolated = 0
    for (let i = 0; i < n; i++) {
      sum += degree[i]
      if (degree[i] > max) max = degree[i]
      if (degree[i] === 0) isolated++
    }
    const mean = sum / n
    const heavy = edgeShare > 0.25
    out.push({
      id: 'centrality:degree-distribution',
      analysis: 'centrality',
      title: heavy ? `Connections are heavy-tailed: the top 1% of entities touch ${pct(edgeShare)} of relationship ends` : `Connections are spread evenly: the top 1% touch only ${pct(edgeShare)} of relationship ends`,
      detail: `Mean degree ${fixed(mean, 1)}, maximum ${num(max)} (${fixed(max / Math.max(mean, 1e-9), 0)}× the mean)${isolated ? `; ${num(isolated)} entities (${pct(isolated / n)}) have no relationships at all` : ''}.`,
      score: clamp01(Math.abs(edgeShare - 0.12) * 2.2 + (isolated / n) * 0.5),
      data: { meanDegree: mean, maxDegree: max, top1PercentShare: edgeShare, isolated },
      visual: { kind: 'plot', title: 'Degree distribution', spec: { traces: [{ kind: 'histogram', x: 'degree', name: 'entities' }], layout: { title: 'How many relationships entities have', xaxis: { title: 'degree' }, yaxis: { title: 'entities', type: 'log' } } } },
    })
  }

  return out
}

function graphVisual(title: string, focus: string[], big: boolean, style: NonNullable<Extract<Visual, { kind: 'graph' }>['style']>): Visual {
  return { kind: 'graph', title, filter: big ? { roots: focus, depth: 1, hideIsolated: true } : { hideIsolated: true }, style: { ...style, highlight: focus, labels: 'auto' }, layout: 'force', focus }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

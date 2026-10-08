import { clamp01, col, countBy, fixed, labelOf, list, normalisedEntropy, num, pct, q, sortedEntries, type Context } from '../shared'
import type { Finding } from '../types'

export interface CommunityProfile {
  id: number
  size: number
  /** A name: the tag or type that characterises it plus its most central member. */
  label: string
  types: { type: string; count: number; share: number }[]
  tags: { tag: string; count: number; share: number }[]
  top: { id: string; label: string; type: string; pagerank: number }[]
  /** Edges inside / edges touching: 1 = sealed off, 0 = all ties lead out. */
  cohesion: number
  internalEdges: number
  externalEdges: number
}

/**
 * Community map: what the Louvain groups are made of, how sealed off each
 * one is, and which pairs of groups talk most.
 */
export function communities(ctx: Context): Finding[] {
  const { n, input, topK } = ctx
  const community = col(ctx, 'community')
  const pagerank = col(ctx, 'pagerank') ?? col(ctx, 'degree')
  const out: Finding[] = []
  if (!community || !pagerank || n < 6) return out
  const count = ctx.metrics.communities?.count ?? 0
  if (count < 2) return out
  const Q = ctx.metrics.summary.modularity ?? 0

  // ── Membership and edges per community ──
  const members: number[][] = Array.from({ length: count }, () => [])
  for (let i = 0; i < n; i++) members[community[i]]?.push(i)
  const internal = new Float64Array(count)
  const external = new Float64Array(count)
  const between = new Map<string, number>()
  for (let j = 0; j < input.src.length; j++) {
    const a = community[input.src[j]]
    const b = community[input.dst[j]]
    if (a === b) internal[a]++
    else {
      external[a]++
      external[b]++
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      between.set(key, (between.get(key) ?? 0) + 1)
    }
  }

  // ── Profiles ──
  const overallTypeShare = new Map<string, number>()
  for (const t of input.types) overallTypeShare.set(t, (overallTypeShare.get(t) ?? 0) + 1 / n)
  const overallTagShare = new Map<string, number>()
  for (const tags of input.tags) for (const t of tags) overallTagShare.set(t, (overallTagShare.get(t) ?? 0) + 1 / n)
  const profiles: CommunityProfile[] = members.map((m, c) => {
    const types = sortedEntries(countBy(m.map((i) => input.types[i]))).map(([type, cnt]) => ({ type, count: cnt, share: cnt / m.length }))
    const tags = sortedEntries(countBy(m.flatMap((i) => input.tags[i]))).map(([tag, cnt]) => ({ tag, count: cnt, share: cnt / m.length }))
    const top = [...m].sort((a, b) => pagerank[b] - pagerank[a]).slice(0, topK).map((i) => ({ id: input.ids[i], label: labelOf(ctx, i), type: input.types[i], pagerank: pagerank[i] }))
    // A tag a third of members carry and that is at least twice as common here as overall, else a dominant type that is likewise over-represented, then the lead member.
    const tag = tags.find((t) => t.share >= 0.34 && t.share >= (overallTagShare.get(t.tag) ?? 0) * 2)
    const t0 = types[0]
    const distinctive = tag ? `#${tag.tag}` : t0 && t0.share > (overallTypeShare.get(t0.type) ?? 0) * 1.5 && t0.share > 0.5 ? t0.type : ''
    const lead = top[0]?.label ?? ''
    // Named after its most central member; the distinctive tag or type is added only when it says something the name does not.
    const redundant = distinctive && lead && slugOf(distinctive).includes(slugOf(lead))
    const label = lead ? `${q(lead)}${distinctive && !redundant ? ` · ${distinctive}` : ''}` : distinctive || `Community ${c + 1}`
    const touching = internal[c] + external[c]
    return { id: c, size: m.length, label, types: types.slice(0, 5), tags: tags.slice(0, 5), top, cohesion: touching ? internal[c] / touching : 0, internalEdges: internal[c], externalEdges: external[c] }
  })
  const giant = profiles[0]
  const inGiant = giant.size / n

  // ── Overview ──
  const sizes = profiles.map((p) => p.size)
  const meaningful = profiles.filter((p) => p.size >= Math.max(3, n * 0.01))
  out.push({
    id: 'communities:overview',
    analysis: 'communities',
    title: Q >= 0.55 ? `The graph splits cleanly into ${num(count)} communities (modularity ${fixed(Q)})` : Q >= 0.3 ? `${num(count)} communities with moderate separation (modularity ${fixed(Q)})` : `Communities are weak: ${num(count)} groups at modularity ${fixed(Q)}`,
    detail: `${num(meaningful.length)} hold at least 1% of entities; the largest, ${giant.label}, has ${num(giant.size)} (${pct(inGiant)}). ${list(meaningful.slice(0, 5).map((p) => `${p.label} (${num(p.size)})`), 5)}.`,
    score: clamp01(0.35 + Q * 0.6 + (inGiant > 0.6 ? 0.1 : 0)),
    data: { modularity: Q, count, sizes: sizes.slice(0, 50), profiles: profiles.slice(0, 25).map(brief) },
    visual: { kind: 'graph', title: 'Communities', filter: n > 3000 ? { hideIsolated: true, componentMin: 3 } : { hideIsolated: true }, style: { color: { by: 'community' }, size: { by: 'degree', min: 2, max: 14, log: true }, labels: 'auto' }, layout: 'force' },
  })

  // ── What each community is made of ──
  const mixed = profiles.slice(0, 12).filter((p) => p.size >= 3)
  if (mixed.length >= 2) {
    // Communities whose type mix differs most from the whole: the interesting ones to name.
    const purity = mixed.map((p) => 1 - normalisedEntropy(p.types.map((t) => t.count)))
    const purest = mixed.map((p, k) => ({ p, purity: purity[k] })).sort((a, b) => b.purity - a.purity)[0]
    out.push({
      id: 'communities:composition',
      analysis: 'communities',
      title: purest.purity > 0.6 ? `${purest.p.label} is almost all ${purest.p.types[0].type} (${pct(purest.p.types[0].share)})` : `Communities mix types rather than split by them`,
      detail:
        mixed
          .slice(0, 4)
          .map((p) => `${p.label}: ${p.types.slice(0, 2).map((t) => `${pct(t.share)} ${t.type}`).join(', ')}`)
          .join('. ') + '.',
      score: clamp01(0.3 + purest.purity * 0.5),
      entities: mixed.flatMap((p) => p.top.slice(0, 2).map((t) => t.id)),
      data: { communities: mixed.map(brief) },
      visual: { kind: 'plot', title: 'What each community is made of', spec: { traces: [{ kind: 'bar', x: 'metric.community', group: 'type', agg: 'count', name: 'entities' }], layout: { title: 'Entities per community, by type', barmode: 'stack', xaxis: { title: 'community' }, yaxis: { title: 'entities' } } } },
    })
  }

  // ── Cohesion: sealed-off and porous communities ──
  const sized = profiles.filter((p) => p.size >= Math.max(5, n * 0.01) && p.internalEdges + p.externalEdges > 0)
  if (sized.length >= 2) {
    const sealed = [...sized].sort((a, b) => b.cohesion - a.cohesion)[0]
    const porous = [...sized].sort((a, b) => a.cohesion - b.cohesion)[0]
    if (sealed !== porous && sealed.cohesion - porous.cohesion > 0.25) {
      out.push({
        id: 'communities:cohesion',
        analysis: 'communities',
        title: `${sealed.label} is sealed off (${pct(sealed.cohesion)} of its ties stay inside); ${porous.label} is porous (${pct(porous.cohesion)})`,
        detail: `A sealed community is a self-contained topic; a porous one is a crossroads. ${sealed.label}: ${num(sealed.internalEdges)} internal vs ${num(sealed.externalEdges)} outgoing ties. ${porous.label}: ${num(porous.internalEdges)} vs ${num(porous.externalEdges)}.`,
        score: clamp01(0.25 + (sealed.cohesion - porous.cohesion) * 0.7),
        entities: [...sealed.top.slice(0, 3), ...porous.top.slice(0, 3)].map((t) => t.id),
        data: { sealed: brief(sealed), porous: brief(porous) },
        visual: { kind: 'table', title: 'Cohesion per community', columns: ['community', 'size', 'internal ties', 'outgoing ties', 'cohesion'], rows: sized.map((p) => [p.label, p.size, p.internalEdges, p.externalEdges, Number(p.cohesion.toFixed(2))]) },
      })
    }
  }

  // ── Strongest cross-community ties ──
  const pairs = [...between.entries()].map(([k, w]) => ({ pair: k.split(':').map(Number) as [number, number], edges: w })).sort((a, b) => b.edges - a.edges)
  if (pairs.length) {
    const p0 = pairs[0]
    const [a, b] = p0.pair
    const expected = (external[a] * external[b]) / Math.max(1, [...between.values()].reduce((s, v) => s + v, 0) * 2)
    out.push({
      id: 'communities:ties',
      analysis: 'communities',
      title: `${profiles[a].label} and ${profiles[b].label} are the most connected pair (${num(p0.edges)} ties)`,
      detail: `${pairs.length} of ${num((count * (count - 1)) / 2)} possible community pairs touch at all. Strongest: ${list(pairs.slice(0, 4).map((x) => `${profiles[x.pair[0]].label} ↔ ${profiles[x.pair[1]].label} (${num(x.edges)})`), 4)}.`,
      score: clamp01(0.2 + Math.min(0.5, Math.log10(Math.max(1, p0.edges / Math.max(1, expected))) * 0.3)),
      entities: [...profiles[a].top.slice(0, 3), ...profiles[b].top.slice(0, 3)].map((t) => t.id),
      data: { pairs: pairs.slice(0, 20).map((x) => ({ a: profiles[x.pair[0]].label, b: profiles[x.pair[1]].label, edges: x.edges })) },
      visual: { kind: 'table', title: 'Ties between communities', columns: ['community', 'community', 'ties'], rows: pairs.slice(0, 20).map((x) => [profiles[x.pair[0]].label, profiles[x.pair[1]].label, x.edges]) },
    })
  }

  return out
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

const brief = (p: CommunityProfile) => ({ id: p.id, label: p.label, size: p.size, cohesion: Number(p.cohesion.toFixed(3)), types: p.types.slice(0, 3).map((t) => `${t.type} ${(t.share * 100).toFixed(0)}%`), tags: p.tags.slice(0, 3).map((t) => t.tag), top: p.top.slice(0, 5).map((t) => t.label) })

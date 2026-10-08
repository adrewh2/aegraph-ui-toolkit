import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { narrate } from '../../analysis/narrate'
import { ANALYSES, ANALYSIS_IDS, analysisInfo, type AnalysisId, type Finding } from '../../analysis/types'
import { getLatestAnalysis } from '../analysis/latest'
import { showFinding } from '../analysis/materialize'
import { runInsights } from '../analysis/runInsights'
import { claimFor, communityMembers, nameCommunity, saveFindingAsClaim } from '../knowledge/claims'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * The analytics harness for the assistant: run the five analyses over the
 * open dataset (in a worker), read the ranked findings, and put a finding's
 * visual on screen — a plot on the Scenes page or Unigraph, filtered and styled.
 */
export function createAnalysisTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  const compact = (f: Finding, rank: number) => ({ rank, id: f.id, score: Number(f.score.toFixed(2)), title: f.title, detail: f.detail, visual: f.visual ? `${f.visual.kind}: ${f.visual.title}` : undefined, entities: f.entities?.slice(0, 5) })

  const analyze = betaTool({
    name: 'analyze',
    description:
      'The analytics harness: genuinely interesting things about the open dataset, ranked, each with a visualization ready to show. Analyses: centrality (key players: hubs, bridges, connectors, degree shape), communities (Louvain groups: what each is made of, cohesion, ties), schema (the ontology in use: type mix, type×relationship patterns, cardinality, property coverage, declared vs used), temporal (growth, bursts, recency, arrivals, staleness), anomalies (degree outliers, isolated entities, duplicate labels, missing properties, probable missing links, odd type pairings). Actions: run (all or some analyses; returns a Markdown briefing plus the ranked findings — start here for "show me interesting things"), findings (the latest run\'s ranked list, filterable by analysis), get (one finding with its data rows), show (put a finding\'s visual on screen: a plot on the Scenes page or a filtered, styled Graph Explorer view with the entities of interest selected; pass save_as to keep a plot as an entity), keep (save a finding as a claim entity — its evidence entities point at it through "supports" links, so it sits in the graph and the ontology; saving the same finding again refreshes it), name_community (turn a Louvain community of the latest run into a community entity its members belong to through "member-of": pass `community` — the number in a finding\'s data — and `label`), catalog (the analyses and the questions they answer). Runs off the main thread; a dataset of 50k entities takes a few seconds. Metric refs (metric.pagerank, metric.community, metric.betweenness) then work in plot specs and the plot builder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'findings', 'get', 'show', 'keep', 'name_community', 'catalog'] },
        analyses: { type: 'array', items: { type: 'string', enum: ANALYSIS_IDS }, description: 'run/findings: which analyses (default all)' },
        top: { type: 'integer', minimum: 1, maximum: 50, description: 'run/findings: how many findings to return (default 10)' },
        per_analysis: { type: 'integer', minimum: 1, maximum: 12, description: 'run: findings kept per analysis (default 8)' },
        unit: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'run: time bin for the temporal analysis (default: chosen from the span)' },
        force: { type: 'boolean', description: 'run: recompute even when the latest run covers the same dataset' },
        finding: { type: 'string', description: 'get/show: a finding id from run or findings, e.g. centrality:hubs' },
        save_as: { type: 'string', description: 'show: save a chart visual as a chart (plot) entity with this name' },
        community: { type: 'integer', minimum: 0, description: 'name_community: the community number (communities findings carry {id, label, …} per community in their data)' },
        label: { type: 'string', description: 'name_community: the name to give it' },
        description: { type: 'string', description: 'name_community: what it is, in a sentence' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, analyses, top, per_analysis, unit, force, finding, save_as, community, label, description }) => {
      if (action === 'catalog') return json({ analyses: ANALYSES.map((a) => ({ id: a.id, label: a.label, question: a.question, description: a.description, cost: a.cost })) })
      if (action === 'run') {
        const which = (analyses?.length ? analyses : ANALYSIS_IDS) as AnalysisId[]
        const { report } = await runInsights(store, registry(), which, { perAnalysis: per_analysis, unit }, { force })
        const k = top ?? 10
        return json({
          briefing: narrate(report, { top: Math.min(k, 6), perAnalysis: 3 }),
          scope: report.scope,
          nodes: report.nodes,
          edges: report.edges,
          ms: report.ms,
          findings: report.findings.slice(0, k).map((f, i) => compact(f, i + 1)),
          runs: report.runs.map((r) => ({ id: r.id, findings: r.findings.length, ms: r.ms, note: r.note })),
          hint: 'analyze {action:"show", finding:<id>} puts a finding on screen; {action:"get"} returns its data rows. The Insights page (/insights) lists everything.',
        })
      }
      const latest = getLatestAnalysis()
      if (!latest) throw new Error('No analysis has run yet. Use analyze {action:"run"} first.')
      if (action === 'findings') {
        const want = new Set(analyses ?? ANALYSIS_IDS)
        return json({ computedAt: latest.report.computedAt, scope: latest.report.scope, findings: latest.report.findings.filter((f) => want.has(f.analysis)).slice(0, top ?? 10).map((f, i) => compact(f, i + 1)) })
      }
      if (action === 'name_community') {
        if (typeof community !== 'number') throw new Error('name_community needs `community` (a number from a communities finding).')
        if (!label?.trim()) throw new Error('name_community needs a `label`.')
        const members = communityMembers(latest.metrics, community)
        if (!members.length) throw new Error(`The latest run has no community ${community} (or its members are gone). Run the analyses again, or check a communities finding\'s data for the numbers.`)
        const r = nameCommunity(store, { label: label.trim(), description, members, community, metricsKey: latest.metrics.sliceKey })
        return json({ id: r.entity.id, label: r.entity.label, members: r.members, created: r.created, hint: 'The community entity is in the Ontology\'s Claims tab and the graph; graph_select it to see its members.' })
      }
      const f = latest.report.findings.find((x) => x.id === finding)
      if (!f) throw new Error(`No finding ${finding}. Ids: ${latest.report.findings.map((x) => x.id).join(', ')}`)
      if (action === 'get') return json({ ...compact(f, latest.report.findings.indexOf(f) + 1), entities: f.entities, data: f.data, visual: f.visual, claim: claimFor(store, f)?.id })
      if (action === 'keep') {
        const r = saveFindingAsClaim(store, f, latest.report, analysisInfo(f.analysis).label)
        return json({ id: r.claim.id, label: r.claim.label, evidence: r.evidence, created: r.created, hint: 'Claims live in the Ontology\'s Claims tab; get_entity shows the claim with the entities supporting it.' })
      }
      const shown = await showFinding(f, host, { saveAs: save_as })
      return json({ shown: shown.kind, route: shown.route, plotId: shown.plotId, finding: f.id, title: f.title })
    },
  })

  return [analyze]
}

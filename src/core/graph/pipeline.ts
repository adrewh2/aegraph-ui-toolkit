import type { FilterSpec } from './filter'
import { filterComputedRefs } from './filter'
import type { MetricsResult } from './metrics/types'
import { describePlacement, type LayoutRule } from './placement'
import { attrUsesMetrics, describeRendering, type Channel, type EdgeAppearance, type NodeAppearance, type RenderingSpec } from './rendering'
import { describeFilter } from './filter'
import { refUsesMetrics } from './values'

/**
 * The explorer works in one fixed order:
 *
 *   Dataset ─▶ Filter ─▶ Layout ─▶ Style ─▶ Analysis ─▶ Export
 *
 * Each stage reads only what precedes it. Analysis is computed over the
 * view; its numbers become *data* only by exporting a project and loading
 * it as the next Dataset. Layout and Style may preview `metric.*` from the
 * current analysis (a feedback arrow in the bar); Filter never can.
 */
export type StageId = 'dataset' | 'filter' | 'layout' | 'style' | 'analysis' | 'export'
export const PIPELINE_ORDER: StageId[] = ['dataset', 'filter', 'layout', 'style', 'analysis', 'export']

export interface Stage {
  id: StageId
  label: string
  summary: string
  /** Reads `metric.*` from this iteration's analysis (layout/style preview). */
  usesMetrics: boolean
  stale: boolean
  notes: string[]
}

export interface PipelineInput {
  dataset: { source: 'workspace' | 'project'; label: string; nodes: number; edges: number; breadcrumb: string[] }
  filter: FilterSpec
  view: { nodes: number; edges: number }
  layout: { algorithm: string; positions: number; rule?: LayoutRule; layoutId?: string; dirty: boolean }
  rendering: RenderingSpec
  analysis: { metrics?: MetricsResult; stale: boolean; running: boolean; auto: boolean }
}

export interface Pipeline {
  order: StageId[]
  stages: Stage[]
  /** Layout/Style read this iteration's metrics — export to make them data. */
  feedback: boolean
  notes: string[]
}

const channelsOf = (a: NodeAppearance | EdgeAppearance): (Channel | undefined)[] => {
  const n = a as NodeAppearance & EdgeAppearance
  return [n.color, n.size, n.width, n.opacity, n.shape]
}

export function renderingUsesMetrics(r: RenderingSpec): boolean {
  const scopes = [r.nodes.default, ...Object.values(r.nodes.types), ...Object.values(r.nodes.tags), r.edges.default, ...Object.values(r.edges.types), ...Object.values(r.edges.tags)]
  return scopes.some((a) => channelsOf(a).some((c) => c && c.mode !== 'constant' && attrUsesMetrics(c.attr)))
}

export function ruleUsesMetrics(rule: LayoutRule | undefined): boolean {
  if (!rule) return false
  const refs = [rule.spec.x, rule.spec.y, rule.spec.z, rule.spec.order, rule.selector.sort, ...(rule.selector.fields ?? []).map((f) => f.path)]
  return refs.some((r) => r && refUsesMetrics(r))
}

export function describePipeline(input: PipelineInput): Pipeline {
  const notes: string[] = []
  const filterRefs = filterComputedRefs(input.filter)
  const filterNotes: string[] = []
  if (filterRefs.metrics.length) filterNotes.push(`Predicates on ${filterRefs.metrics.map((m) => `metric.${m}`).join(', ')} are ignored: a filter can't read this iteration's analysis. Export the view as a project and filter that.`)
  const layoutUses = ruleUsesMetrics(input.layout.rule)
  const styleUses = renderingUsesMetrics(input.rendering)
  const hasMetrics = !!input.analysis.metrics
  const cols = hasMetrics ? Object.keys(input.analysis.metrics!.columns) : []
  const stages: Stage[] = [
    { id: 'dataset', label: 'Dataset', summary: `${input.dataset.label} · ${input.dataset.nodes.toLocaleString()} nodes`, usesMetrics: false, stale: false, notes: [] },
    { id: 'filter', label: 'Filter', summary: `${describeFilter(input.filter)} · ${input.view.nodes.toLocaleString()} nodes`, usesMetrics: false, stale: false, notes: filterNotes },
    {
      id: 'layout',
      label: 'Layout',
      summary: input.layout.rule ? describePlacement(input.layout.rule.spec) : `${input.layout.algorithm} · ${input.layout.positions.toLocaleString()} positions`,
      usesMetrics: layoutUses,
      stale: layoutUses && (input.analysis.stale || !hasMetrics),
      notes: layoutUses && !hasMetrics ? ['The layout rule needs metrics that have not been computed.'] : [],
    },
    { id: 'style', label: 'Style', summary: describeRendering(input.rendering), usesMetrics: styleUses, stale: styleUses && (input.analysis.stale || !hasMetrics), notes: styleUses && !hasMetrics ? ['A style channel maps a metric that has not been computed.'] : [] },
    {
      id: 'analysis',
      label: 'Analysis',
      summary: input.analysis.running ? 'running…' : hasMetrics ? `${cols.join(', ')}${input.analysis.stale ? ' · stale' : ''}` : 'not run',
      usesMetrics: false,
      stale: hasMetrics && input.analysis.stale,
      notes: input.analysis.auto ? ['Re-runs automatically when the view changes.'] : [],
    },
    { id: 'export', label: 'Export', summary: hasMetrics ? 'view + analysis → project' : 'view → project', usesMetrics: false, stale: false, notes: [] },
  ]
  const feedback = layoutUses || styleUses
  if (feedback) notes.push('Layout/Style preview this analysis; export a project to make the values part of the data.')
  notes.push(...filterNotes)
  return { order: PIPELINE_ORDER, stages, feedback, notes }
}

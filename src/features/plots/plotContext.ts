import { useMemo } from 'react'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { datasetGraph } from '../../core/graph/dataset'
import type { GraphSlice } from '../../core/graph/filter'
import type { PlotBuildContext } from '../../core/graph/plot'
import { isProject, projectMembers, projectOverlay } from '../../core/graph/project'
import { resolveSelector, type Selector } from '../../core/graph/selector'
import { listValueRefs, makeValueContext, type ValueRefInfo } from '../../core/graph/values'
import { partialMetrics } from '../../core/graph/metrics/cache'
import { sliceKey } from '../../core/graph/metrics/serialize'
import { METRIC_IDS } from '../../core/graph/metrics/types'
import { getLatestAnalysis, metricsForKey, useLatestAnalysis } from '../analysis/latest'

/**
 * Plots read the whole dataset (or a loaded project), not the explorer's
 * filtered view: a selector's `view` scope and `dataset` scope mean the
 * same thing here. One slice per store version, shared by every plot.
 */
export function plotContextFor(store: EntityStore, registry: TypeRegistry, projectId?: EntityId): PlotBuildContext & { slice: GraphSlice; refs: (rows?: AnyEntity[]) => ValueRefInfo[] } {
  const p = projectId ? store.get(projectId) : undefined
  const project = isProject(p) ? p : undefined
  const members = project ? projectMembers(project) : undefined
  const { nodes, edges } = datasetGraph(store, registry, members)
  const degree = new Map<EntityId, number>()
  for (const e of edges) {
    degree.set(e.source.id, (degree.get(e.source.id) ?? 0) + 1)
    degree.set(e.target.id, (degree.get(e.target.id) ?? 0) + 1)
  }
  const slice: GraphSlice = { nodes, edges, degree, truncated: 0, candidates: nodes.length }
  // Metric columns (`metric.pagerank`, `metric.community`, …) are lent by a run over this exact node and edge set: the latest
  // analytics run, or else the widest result the shared metrics cache holds for it (a Stats run over the whole dataset).
  const key = sliceKey({ nodes, edges })
  const latest = getLatestAnalysis()
  const metrics = (latest && latest.report.nodes === nodes.length && latest.report.edges === edges.length ? metricsForKey(key) : undefined) ?? partialMetrics(key, { metrics: METRIC_IDS, paths: { exactBelow: 0, sampleSources: 0, seed: 1 } })?.base
  const values = makeValueContext({ scope: 'dataset', store, slice, metrics, overlay: project ? projectOverlay(project) : undefined })
  const resolve = (sel: Selector): AnyEntity[] => resolveSelector({ ...sel, scope: 'dataset' }, { store, registry, slice, values, members }).nodes
  return { resolve, values, slice, refs: (rows?: AnyEntity[]) => listValueRefs(values, rows ?? nodes) }
}

export function usePlotContext(projectId?: EntityId) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const { latest } = useLatestAnalysis()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => plotContextFor(store, registry, projectId), [store, registry, projectId, version, latest])
}

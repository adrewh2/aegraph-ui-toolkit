import { createEntity, displayLabel } from '../entity/entity'
import type { EntityStore } from '../entity/store'
import type { AnyEntity, Entity, EntityId } from '../entity/types'
import type { GraphSlice } from './filter'
import type { MetricsResult, NodeMetricId } from './metrics/types'
import { GRAPH_TYPES, type ProjectData } from './types'

/**
 * Export = materialise the current view as a project entity. Load = make
 * that project the Dataset stage. This is how analysis results become
 * data: a project carries the metric values that were computed for its
 * members, and they read as `data.<metric>` while it is loaded.
 */
export type ProjectEntity = Entity<ProjectData>

export const isProject = (e: AnyEntity | undefined): e is ProjectEntity => !!e && e.kind === 'entity' && e.type === GRAPH_TYPES.project && Array.isArray(e.data.members)

export function buildProject(
  label: string,
  slice: Pick<GraphSlice, 'nodes' | 'edges'>,
  metrics: MetricsResult | undefined,
  provenance: { parentProjectId?: EntityId; filterId?: EntityId; layoutId?: EntityId; renderingId?: EntityId; analysisId?: EntityId } = {},
  source = 'user',
): ProjectEntity {
  const members = [...slice.nodes.map((n) => n.id), ...slice.edges.map((e) => e.id)]
  let values: ProjectData['values']
  const metricNames: string[] = []
  if (metrics) {
    const cols = Object.entries(metrics.columns).filter(([, c]) => c) as [NodeMetricId, Float64Array][]
    if (cols.length) {
      values = {}
      const inView = new Set(slice.nodes.map((n) => n.id))
      metrics.ids.forEach((id, i) => {
        if (!inView.has(id)) return
        const row: Record<string, number> = {}
        for (const [k, col] of cols) if (Number.isFinite(col[i])) row[k] = Math.round(col[i] * 1e6) / 1e6
        if (Object.keys(row).length) values![id] = row
      })
      metricNames.push(...cols.map(([k]) => k))
    }
  }
  return createEntity<ProjectData>({
    type: GRAPH_TYPES.project,
    label,
    tags: [],
    data: { members, ...(values ? { values } : {}), ...provenance, summary: { nodes: slice.nodes.length, edges: slice.edges.length, metrics: metricNames } },
    meta: { source },
  })
}

export function projectMembers(p: ProjectEntity): Set<EntityId> {
  return new Set(p.data.members)
}

/** Exported metric values as a per-node overlay for the value context. */
export function projectOverlay(p: ProjectEntity): Map<EntityId, Record<string, number>> | undefined {
  if (!p.data.values) return undefined
  return new Map(Object.entries(p.data.values))
}

/** Workspace ▸ Parent ▸ … ▸ this project. */
export function projectBreadcrumb(store: EntityStore, id: EntityId | undefined): { id?: EntityId; label: string }[] {
  const chain: { id?: EntityId; label: string }[] = []
  const seen = new Set<EntityId>()
  let cur = id ? store.get(id) : undefined
  while (cur && isProject(cur) && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift({ id: cur.id, label: displayLabel(cur) })
    cur = cur.data.parentProjectId ? store.get(cur.data.parentProjectId) : undefined
  }
  // The root is what the pipeline reads from: the open project, or the whole Library.
  const root = store.scope ? store.get(store.scope) : undefined
  chain.unshift({ label: root ? displayLabel(root) : 'Library' })
  return chain
}

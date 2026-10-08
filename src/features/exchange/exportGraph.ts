import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { graphFormat, type GraphFormatId } from '../../core/exchange/graph/graphFormats'
import type { ExportFile } from '../../core/exchange/graph/model'
import { datasetGraph } from '../../core/graph/dataset'
import { GRAPH_TYPES, type LayoutData } from '../../core/graph/types'

/** The whole workspace as a graph: every browsable entity, the relationships among them, and the newest saved layout's positions. */
export function workspaceGraph(store: EntityStore, registry: TypeRegistry) {
  const { nodes, edges } = datasetGraph(store, registry)
  const layouts = store.ofType(GRAPH_TYPES.layout).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
  const positions = (layouts[0]?.data as LayoutData | undefined)?.positions
  return { nodes, edges, positions }
}

export async function exportWorkspaceGraph(store: EntityStore, registry: TypeRegistry, format: GraphFormatId, name = 'workspace'): Promise<ExportFile[]> {
  const { nodes, edges, positions } = workspaceGraph(store, registry)
  return graphFormat(format).write({ nodes, edges, positions, registry, name })
}

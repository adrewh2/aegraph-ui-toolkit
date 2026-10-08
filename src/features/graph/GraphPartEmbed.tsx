import { Box, Waypoints } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { graphHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { describeFilter, toFilterSpec } from '../../core/graph/filter'
import { layoutInfo, type LayoutAlgorithm } from '../../core/graph/layouts'
import { describeRendering, toRenderingSpec, type RenderingData } from '../../core/graph/rendering'
import { isGraphSceneType, SCENE_PARTS, type SceneData, UNIGRAPH_SCENE_TYPE } from '../../core/graph/scene'
import { GRAPH_TYPES, type AnalysisData, type FilterData, type LayoutData } from '../../core/graph/types'
import { metricInfo } from '../../core/graph/metrics'
import './GraphPartEmbed.css'

/**
 * The inspector's first tab for a saved graph picture — a scene — or one of
 * its parts (filter, layout, style, analysis): what it holds in a sentence
 * or two, and the buttons that open it in Unigraph, 2D or 3D.
 * A scene lists its parts, each a link to that entity.
 */
export default function GraphPartEmbed({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const rows = describe(entity, store)
  const noun = isGraphSceneType(entity.type) ? 'scene' : entity.type === GRAPH_TYPES.rendering ? 'style' : entity.type
  return (
    <div className="gp">
      <div className="gp__actions">
        <button className="btn btn--sm btn--primary" onClick={() => navigate(graphHref(entity, 2))} title={`Open this ${noun} in 2D${entity.type === UNIGRAPH_SCENE_TYPE ? ' on Unigraph' : ''}`}>
          <Waypoints size={14} /> Open in 2D
        </button>
        <button className="btn btn--sm" onClick={() => navigate(graphHref(entity, 3))} title={`Open this ${noun} in 3D${entity.type === UNIGRAPH_SCENE_TYPE ? ' on Unigraph' : ''}`}>
          <Box size={14} /> Open in 3D
        </button>
      </div>
      <dl className="gp__rows">
        {rows.map((r) => (
          <div key={r.label} className="gp__row">
            <dt>{r.label}</dt>
            <dd>
              {r.ref ? (
                <button className="gp__ref" onClick={() => onOpen(r.ref!)} title="Show this part">
                  {r.value}
                </button>
              ) : (
                r.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="gp__hint muted">
        {isGraphSceneType(entity.type)
          ? 'Opening a scene loads its filter, layout and style together; the parts stay shared, so editing one updates every scene that uses it.'
          : `Opening a ${noun} loads it into whatever the explorer is showing, leaving the other parts as they are.`}
      </p>
    </div>
  )
}

interface Row {
  label: string
  value: string
  /** Another entity this row names, opened in the inspector on click. */
  ref?: EntityId
}

function describe(e: AnyEntity, store: ReturnType<typeof useEntityStore>): Row[] {
  const d = e.data
  const partRow = (label: string, id: EntityId | undefined): Row => {
    if (!id) return { label, value: 'none' }
    const p = store.get(id)
    return p ? { label, value: displayLabel(p), ref: p.id } : { label, value: 'missing (deleted)' }
  }
  switch (isGraphSceneType(e.type) ? 'scene' : e.type) {
    case 'scene': {
      const s = d as SceneData
      return [
        { label: 'View', value: s.renderer === '3d' ? '3D' : '2D' },
        ...SCENE_PARTS.map((p) => partRow(p.label, s[p.idKey])),
        ...(s.algorithm ? [{ label: 'Algorithm', value: layoutInfo(s.algorithm)?.label ?? s.algorithm }] : []),
        ...(s.projectId ? [partRow('Dataset', s.projectId)] : []),
        ...(s.analysis?.auto ? [{ label: 'Analysis', value: `auto · ${s.analysis.options.metrics.join(', ')}` }] : []),
      ]
    }
    case GRAPH_TYPES.filter:
      return [{ label: 'Shows', value: describeFilter(toFilterSpec(d as FilterData)) }]
    case GRAPH_TYPES.layout: {
      const l = d as LayoutData
      const n = Object.keys(l.positions ?? {}).length
      return [
        { label: 'Positions', value: `${n.toLocaleString()} node${n === 1 ? '' : 's'}${l.dimensions ? ` · ${l.dimensions}D` : ''}` },
        ...(l.algorithm ? [{ label: 'Algorithm', value: layoutInfo(l.algorithm as LayoutAlgorithm)?.label ?? l.algorithm }] : []),
        ...(l.pinned?.length ? [{ label: 'Pinned', value: String(l.pinned.length) }] : []),
      ]
    }
    case GRAPH_TYPES.rendering:
      return [{ label: 'Style', value: describeRendering(toRenderingSpec(d as RenderingData)) }]
    case GRAPH_TYPES.analysis: {
      const a = d as AnalysisData
      const metrics = Object.keys(a.columns ?? {}).map((m) => metricInfo(m as Parameters<typeof metricInfo>[0])?.label ?? m)
      return [
        { label: 'Metrics', value: metrics.join(', ') || 'none' },
        { label: 'Over', value: `${(a.ids?.length ?? 0).toLocaleString()} nodes` },
        ...(a.computedAt ? [{ label: 'Computed', value: new Date(a.computedAt).toLocaleString() }] : []),
        ...(a.filterId ? [partRow('Filter', a.filterId)] : []),
      ]
    }
  }
  return []
}

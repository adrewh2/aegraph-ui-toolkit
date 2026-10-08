import { Database, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { buildProject, isProject } from '../../core/graph/project'
import { GRAPH_TYPES } from '../../core/graph/types'
import { formatDate } from '../../lib/format'
import { useExplorer } from './explorerState'

/**
 * The explorer's dataset stage, in the toolbar: a chip saying which
 * exported project the view is working on (only when one is loaded, with
 * a way back to the whole dataset), the picker for those projects, and
 * the "export view as a project" dialog — both opened from the Export
 * menu. The pipeline itself (Dataset → Filter → Layout → Style → Analysis
 * → Export) is the order of the panel buttons; it no longer needs a
 * breadcrumb of its own.
 */
export interface DatasetBarRequest {
  /** Open the "export view as a project" dialog. */
  exportAt?: number
  /** Open the dataset picker at these screen coordinates. */
  datasetMenuAt?: { x: number; y: number; at: number }
}
export function PipelineBar({ request, exportProvenance }: { request?: DatasetBarRequest; exportProvenance: () => { filterId?: EntityId; layoutId?: EntityId; renderingId?: EntityId; analysisId?: EntityId } }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const { state, dispatch, slice, dataset, metricsStale } = useExplorer()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  // The Export menu asks for the dialog or the picker by bumping a timestamp.
  useEffect(() => {
    if (request?.exportAt) {
      setName('')
      setNaming(true)
    }
  }, [request?.exportAt])
  useEffect(() => {
    if (request?.datasetMenuAt) setMenu({ x: request.datasetMenuAt.x, y: request.datasetMenuAt.y })
  }, [request?.datasetMenuAt])
  const projects = store.ofType(GRAPH_TYPES.project).filter(isProject).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))

  const exportProject = () => {
    const prov = exportProvenance()
    const p = buildProject(name.trim(), slice, state.metrics && !metricsStale ? state.metrics : undefined, { ...prov, parentProjectId: state.projectId })
    store.upsert(p)
    toast(`Project “${p.label}” created — load it from Dataset to iterate on it`)
    setNaming(false)
  }

  const items: MenuItem[] = [
    { kind: 'label', label: 'Dataset' },
    { kind: 'item', label: store.scope ? `${displayLabel(store.get(store.scope)!)} (the open project)` : 'Library (everything)', icon: !state.projectId ? Database : undefined, onSelect: () => dispatch({ type: 'loadProject', id: undefined }) },
    { kind: 'sep' },
    { kind: 'label', label: 'Projects' },
    ...(projects.length
      ? projects.map<MenuItem>((p) => ({ kind: 'item', label: `${displayLabel(p)}  ·  ${p.data.summary?.nodes ?? p.data.members.length} nodes  ·  ${formatDate(p.meta.updatedAt)}`, icon: p.id === state.projectId ? Database : undefined, onSelect: () => dispatch({ type: 'loadProject', id: p.id }) }))
      : [{ kind: 'item' as const, label: 'No projects yet — export the view to make one', disabled: true, onSelect: () => {} }]),
  ]

  return (
    <div className="gx-dataset">
      {dataset.breadcrumb.length > 1 && (
        <span className="gx-dataset__crumbs" title="The view is working on an exported project (its analysis values are data). Back to the whole dataset with ×.">
          <Database size={12} />
          {dataset.breadcrumb.map((b, i) => (
            <span key={b.id ?? 'ws'}>
              {i > 0 && ' ▸ '}
              {b.label}
            </span>
          ))}
          <button className="gx-chip-x" title="Back to the whole dataset" onClick={() => dispatch({ type: 'loadProject', id: undefined })}>
            <X size={11} />
          </button>
        </span>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      <Dialog
        open={naming}
        title="Export view as a project"
        description={`${slice.nodes.length.toLocaleString()} nodes · ${slice.edges.length.toLocaleString()} relationships${state.metrics && !metricsStale ? ` · analysis values: ${Object.keys(state.metrics.columns).join(', ')}` : state.metrics ? ' · analysis is stale and will not be included' : ''}`}
        onClose={() => setNaming(false)}
        footer={
          <>
            <button className="btn" onClick={() => setNaming(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={!name.trim() || !slice.nodes.length} onClick={exportProject}>
              Create project
            </button>
          </>
        }
      >
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && exportProject()} />
        </div>
        <p className="muted">A project is the exported view with its analysis values as data. Load it from Export ▸ Use a project as the dataset to filter, lay out and analyse it further — that is how subprojects are made.</p>
      </Dialog>
    </div>
  )
}

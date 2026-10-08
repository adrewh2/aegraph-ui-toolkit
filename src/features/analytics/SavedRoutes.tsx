import { BarChart3, Clapperboard, Code2, ScanSearch, Table2 } from 'lucide-react'
import { Suspense, lazy } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { graphHref } from '../../app/routes'
import { SavedIndex } from '../../components/SavedIndex/SavedIndex'
import { DATASET_SUBTYPES, datasetsIn, describeDataset, isDataset } from '../../core/datasets/dataset'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { savedCount } from '../../core/graph/counts'
import { describePlot, isPlot, PLOT_TYPE } from '../../core/graph/plot'
import { SCENE_FAMILY, sceneKindOf } from '../../core/graph/projection'
import { formatNumber } from '../../lib/format'
import { headerComment, scriptKindOf, scriptsIn } from '../scripts/script'
import { ChartPicture, ScenePicture } from './SavedPictures'

/**
 * Scripts, charts and scenes get a landing page of their own — the same
 * shape the resource tabs have: what is saved, as cards, and one button
 * that opens the tool on a new one. The tool itself answers the same
 * routes it always did, so `?script=`, `?plot=` and `?id=` (and the tabs
 * of a saved workstation) go straight to it; `/…/new` opens it empty.
 */
const ChartsView = lazy(() => import('./ChartsView').then((m) => ({ default: m.ChartsView })))
const ScriptsView = lazy(() => import('../scripts/ScriptsView').then((m) => ({ default: m.ScriptsView })))
const ScenesView = lazy(() => import('../scenes/ScenesView').then((m) => ({ default: m.ScenesView })))
const DatasetView = lazy(() => import('./DatasetView').then((m) => ({ default: m.DatasetView })))
const loading = <div className="page-loading">Loading…</div>

/** Whether the URL already names something to work on — then the tool, not the list. */
const wants = (params: URLSearchParams, keys: string[], pathname: string) => keys.some((k) => params.get(k)) || pathname.endsWith('/new')

export function ScriptsRoute() {
  const store = useEntityStore()
  useStoreVersion(store)
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  if (wants(params, ['script', 'run'], pathname)) {
    return (
      <Suspense fallback={loading}>
        <ScriptsView />
      </Suspense>
    )
  }
  const items = scriptsIn(store)
  return (
    <SavedIndex
      items={items}
      noun="script"
      plural="Scripts"
      icon={Code2}
      blurb="Code over the workspace: JavaScript or Python in a sandbox, or a visual script with a canvas. A script returns a figure, a table, a scene — or writes back."
      onOpen={(e) => navigate(`/analytics/scripts?script=${encodeURIComponent(e.id)}`)}
      onNew={() => navigate('/analytics/scripts/new')}
      meta={(e) => {
        const d = e.data as { language?: string; lastRun?: { summary?: string; at?: string } }
        return [d.language ?? 'js', scriptKindOf(e.type), savedCount(e), d.lastRun?.summary].filter(Boolean).join(' · ')
      }}
      preview={() => <Code2 size={20} />}
    />
  )
}

export function ChartsRoute() {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  useStoreVersion(store)
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  if (wants(params, ['plot', 'types', 'tags', 'text', 'pick'], pathname)) {
    return (
      <Suspense fallback={loading}>
        <ChartsView />
      </Suspense>
    )
  }
  const items = store.ofType(PLOT_TYPE)
  return (
    <SavedIndex
      items={items}
      noun="chart"
      plural="Charts"
      icon={BarChart3}
      blurb="A chart is a small spec over the same values the graph and the tables read: pick the rows, the kind, and what the axes say."
      onOpen={(e) => navigate(`/analytics/charts?plot=${encodeURIComponent(e.id)}`)}
      onNew={() => navigate('/analytics/charts/new')}
      meta={(e) => (isPlot(e) ? [describePlot(e.data.spec), savedCount(e)].filter(Boolean).join(' · ') : undefined)}
      layout="gallery"
      preview={(e) => <ChartPicture e={e} store={store} registry={registry} fallback={<BarChart3 size={20} />} />}
    />
  )
}

export function ScenesRoute() {
  const store = useEntityStore()
  useStoreVersion(store)
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  if (wants(params, ['id', 'plot', 'over'], pathname)) {
    return (
      <Suspense fallback={loading}>
        <ScenesView />
      </Suspense>
    )
  }
  // The whole family: scenes, the ones scripts made, and graph scenes (Unigraph compositions, which open there).
  const items = store.query({ type: [...SCENE_FAMILY] })
  return (
    <SavedIndex
      items={items}
      noun="scene"
      plural="Scenes"
      icon={ScanSearch}
      blurb="A scene is a saved picture: entities placed on a canvas, in groups, with the graph behind them — arranged by hand, captured from a diagram, or drawn by a script (a script scene) — or a graph scene, a Graph Explorer composition that opens there."
      onOpen={(e) => (sceneKindOf(e.type) === 'graph' ? navigate(graphHref(e, (e.data as { renderer?: string }).renderer === '3d' ? 3 : 2)) : navigate(`/scenes?id=${encodeURIComponent(e.id)}`))}
      onNew={() => navigate('/scenes/new')}
      meta={(e) => {
        const kind = sceneKindOf(e.type)
        if (kind === 'graph') {
          const d = e.data as { renderer?: string; mode?: string; filterId?: string; layoutId?: string; renderingId?: string; analysisId?: string; stats?: { nodes: number; edges: number } }
          return ['Unigraph scene', d.mode === '3d' || d.mode === 'gpu3d' || (!d.mode && d.renderer === '3d') ? '3D' : '2D', savedCount(e, store), [d.filterId && 'filter', d.layoutId && 'layout', d.renderingId && 'style', d.analysisId && 'analysis'].filter(Boolean).join(' + ') || 'the whole dataset'].filter(Boolean).join(' · ')
        }
        const d = e.data as { nodes?: Record<string, unknown>; groups?: Record<string, unknown>; source?: { scriptId?: string } }
        const n = Object.keys(d.nodes ?? {}).length
        const g = Object.keys(d.groups ?? {}).length
        const by = kind === 'script' ? (d.source?.scriptId && store.get(d.source.scriptId) ? `by ${displayLabel(store.get(d.source.scriptId)!)}` : 'by a script') : ''
        return [kind === 'script' ? 'script scene' : '', n ? `${formatNumber(n)} placed` : 'empty', g ? `${g} group${g === 1 ? '' : 's'}` : '', by].filter(Boolean).join(' · ')
      }}
      layout="gallery"
      preview={(e) => <ScenePicture e={e} store={store} fallback={sceneKindOf(e.type) === 'graph' ? <Clapperboard size={20} /> : <ScanSearch size={20} />} />}
    />
  )
}

export function DatasetsRoute() {
  const store = useEntityStore()
  useStoreVersion(store)
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  if (wants(params, ['id'], pathname)) {
    return (
      <Suspense fallback={loading}>
        <DatasetView />
      </Suspense>
    )
  }
  const items = datasetsIn(store)
  return (
    <SavedIndex
      items={items}
      noun="dataset"
      plural="Datasets"
      icon={Table2}
      blurb="A dataset is a table kept as one entity: the rows an analytics script returns, a CSV, TSV, text, Excel or Parquet file (attached to a chat, or handed to the assistant), or cells typed in — edited in place, read by charts. What it was read from is its kind. The flow is scene → script → dataset → chart."
      onOpen={(e) => navigate(`/analytics/datasets?id=${encodeURIComponent(e.id)}`)}
      onNew={() => navigate('/analytics/datasets/new')}
      meta={(e) => {
        if (!isDataset(e)) return undefined
        const s = e.data.source
        const script = s?.kind === 'script' ? store.get(s.scriptId) : undefined
        const kind = DATASET_SUBTYPES.find((k) => k.type === e.type)?.label
        const about = describeDataset(e.data, script ? displayLabel(script) : undefined)
        return kind ? `${kind} · ${about}` : about
      }}
      preview={() => <Table2 size={20} />}
    />
  )
}

/** What each landing page lists, without React: `./kinds.ts`, which the sidebar's counts read too. */
export { SAVED_KINDS } from './kinds'

export const labelOf = (e: AnyEntity) => displayLabel(e)
export const scriptBlurb = (code: string) => headerComment(code)

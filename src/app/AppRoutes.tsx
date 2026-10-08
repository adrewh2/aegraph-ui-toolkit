import { modernGraphPath } from './routes'
import { lazy, Suspense, type ReactNode } from 'react'
import { chunk, preloaded, registerPreload } from './preload'
import { Navigate, useLocation, useNavigate, Route, Routes, useParams } from 'react-router-dom'
import { DashboardView } from '../features/dashboard/DashboardView'
// Entities, Unigraph and Analytics are all workstation hosts, so the pane host is in the entry chunk anyway.
import { WorkstationView } from '../features/workstation/WorkstationView'
import { SectionHost } from '../features/workstation/SectionHost'
import type { HostName } from '../features/workstation/hosts'
import { DatasetsView } from '../features/datasets/DatasetsView'
import { ProjectsDialog } from '../features/datasets/ProjectsDialog'
import { InsightsView } from '../features/analysis/InsightsView'
import { DocumentsView } from '../features/documents/DocumentsView'
import { ImagesView } from '../features/images/ImagesView'
import { VideosView } from '../features/videos/VideosView'
import { AudioView } from '../features/audio/AudioView'
import { OpenBundleRoute, ProjectsView } from '../features/projects/ProjectsView'
import { SpotifyCallback } from '../features/spotify/SpotifyCallback'
import { EntitiesView, LegacyBrowserRedirect } from '../features/entities/EntitiesView'
import { EntitiesWorkspace } from '../features/entities/EntitiesWorkspace'

// Heavy views (three.js, sigma, graphviz wasm, mermaid) load on first use — or ahead of it, behind the boot screen,
// when the address on arrival is theirs (`preloadFor` in preload.ts; the renderer chunks register in GraphExplorer).
const mapsChunk = chunk(() => import('../features/maps/MapsView'))
const savedChunk = chunk(() => import('../features/analytics/SavedRoutes'))
const explorerChunk = chunk(() => import('../features/graph/GraphExplorer'))
const unigraphChunk = chunk(() => import('../features/gpugraph/UnigraphWorkspace'))
const diagramsChunk = chunk(() => import('../features/diagrams/DiagramsView'))
registerPreload((p) => p.startsWith('/maps'), () => [mapsChunk])
registerPreload((p) => p.startsWith('/analytics') || p === '/scenes' || p.startsWith('/scenes/'), () => [savedChunk])
registerPreload((p) => p === '/unigraph' || p.startsWith('/unigraph/'), () => [unigraphChunk, explorerChunk])
registerPreload((p) => p.startsWith('/diagrams'), () => [diagramsChunk])
const MapsView = preloaded(mapsChunk, (m) => m.MapsView)
const ChartsRoute = preloaded(savedChunk, (m) => m.ChartsRoute)
const ScriptsRoute = preloaded(savedChunk, (m) => m.ScriptsRoute)
const ScriptReferencePage = lazy(() => import('../features/scripts/ScriptReferencePage').then((m) => ({ default: m.ScriptReferencePage })))
const ScenesRoute = preloaded(savedChunk, (m) => m.ScenesRoute)
const DatasetsRoute = preloaded(savedChunk, (m) => m.DatasetsRoute)
const GraphExplorer = preloaded(explorerChunk, (m) => m.GraphExplorer)
const UnigraphWorkspace = preloaded(unigraphChunk, (m) => m.UnigraphWorkspace)
const DiagramsView = preloaded(diagramsChunk, (m) => m.DiagramsView)
const DocsView = lazy(() => import('../features/docs/DocsView').then((m) => ({ default: m.DocsView })))
const OntologyView = lazy(() => import('../features/ontology/OntologyView').then((m) => ({ default: m.OntologyView })))
const TypePage = lazy(() => import('../features/ontology/TypePage').then((m) => ({ default: m.TypePage })))
const TypeEditPage = lazy(() => import('../features/ontology/TypeEditor').then((m) => ({ default: m.TypeEditPage })))
const ProjectChangesRoute = lazy(() => import('../features/projects/history').then((m) => ({ default: m.ProjectChangesRoute })))
const ProjectHistoryRoute = lazy(() => import('../features/projects/history').then((m) => ({ default: m.ProjectHistoryRoute })))
const ProjectSettingsRoute = lazy(() => import('../features/projects/history').then((m) => ({ default: m.ProjectSettingsRoute })))
// The Chats page holds the assistant (its SDK and every tool): loaded when first visited, like the panel.
const ChatsView = lazy(() => import('../features/chats/ChatsView').then((m) => ({ default: m.ChatsView })))
const ArtifactView = lazy(() => import('../features/chats/ArtifactView').then((m) => ({ default: m.ArtifactView })))
const BrowserView = lazy(() => import('../features/account/BrowserView').then((m) => ({ default: m.BrowserView })))

const loading = <div className="page-loading">Loading…</div>

/**
 * Every page in the app. Rendered once under the BrowserRouter, and again
 * inside each workstation pane under its own in-memory router — so the same
 * views work as top-level pages and as tabs. `embedded` hides routes that
 * must not nest (the workstation itself).
 */
export function AppRoutes({ embedded = false }: { embedded?: boolean }) {
  // A section is its pane host at the top level (the list as a tab that stays, what is opened from it as tabs) and
  // the page itself inside a tab.
  const section = (name: HostName, page: ReactNode) => (embedded ? page : <SectionHost name={name} />)
  return (
    <Routes>
      <Route path="/" element={<DashboardView />} />
      {!embedded && (
        <Route
          path="/workstation"
          element={
            <Suspense fallback={loading}>
              <WorkstationView />
            </Suspense>
          }
        />
      )}
      {/* Top level: the browser in a tabbed pane host; inside a pane: the browser itself. */}
      <Route path="/chats" element={<Suspense fallback={loading}><ChatsView /></Suspense>} />
      <Route path="/chats/:id" element={<Suspense fallback={loading}><ChatsView /></Suspense>} />
      <Route path="/artifact" element={<Suspense fallback={loading}><ArtifactView /></Suspense>} />
      <Route path="/artifact/:id" element={<Suspense fallback={loading}><ArtifactView /></Suspense>} />
      <Route path="/entities" element={embedded ? <EntitiesView /> : <EntitiesWorkspace />} />
      <Route
        path="/ontology"
        element={section(
          'ontology',
          <Suspense fallback={null}>
            <OntologyView />
          </Suspense>,
        )}
      />
      {/* An entity type's own page: its properties, relationships, tags and lineage with the whole width. */}
      <Route
        path="/ontology/type/:type"
        element={section(
          'ontology',
          <Suspense fallback={loading}>
            <TypePage />
          </Suspense>,
        )}
      />
      {/* An entity type's editor: its names, place, colour, description and properties, row by row. */}
      <Route
        path="/ontology/type/:type/edit"
        element={section(
          'ontology',
          <Suspense fallback={loading}>
            <TypeEditPage />
          </Suspense>,
        )}
      />
      <Route path="/projects" element={section('projects', <ProjectsView />)} />
      <Route path="/projects/:id" element={section('projects', <ProjectsView />)} />
      <Route path="/projects/:id/changes" element={section('projects', <Suspense fallback={loading}><ProjectChangesRoute /></Suspense>)} />
      <Route path="/projects/:id/history" element={section('projects', <Suspense fallback={loading}><ProjectHistoryRoute /></Suspense>)} />
      <Route path="/projects/:id/history/:commit" element={section('projects', <Suspense fallback={loading}><ProjectHistoryRoute /></Suspense>)} />
      <Route path="/projects/:id/settings" element={section('projects', <Suspense fallback={loading}><ProjectSettingsRoute /></Suspense>)} />
      <Route path="/open" element={<OpenBundleRoute />} />
      <Route path="/browser" element={<Suspense fallback={loading}><BrowserView /></Suspense>} />
      <Route path="/spotify/callback" element={<SpotifyCallback />} />
      <Route path="/entities/relationships" element={<LegacyBrowserRedirect section="relationships" />} />
      <Route path="/entities/types" element={<LegacyBrowserRedirect section="types" />} />
      <Route path="/entities/tags" element={<LegacyBrowserRedirect section="tags" />} />
      {/* Resources and Knowledge were separate tables; both live in Entities now. */}
      <Route path="/resources" element={<LegacyBrowserRedirect category="resource" />} />
      <Route path="/resources/:tab" element={<LegacyBrowserRedirect category="resource" />} />
      <Route path="/knowledge" element={<LegacyBrowserRedirect category="knowledge" />} />
      <Route path="/knowledge/types" element={<LegacyBrowserRedirect section="types" />} />
      <Route path="/knowledge/relationships" element={<LegacyBrowserRedirect section="relationships" />} />
      <Route path="/tags" element={<LegacyBrowserRedirect section="tags" />} />
      {/* Layouts, renderings, scenes… live in Entities › Project now. */}
      <Route path="/graph/layouts" element={<Navigate to="/entities?category=project" replace />} />
      <Route
        path="/maps"
        element={section(
          'maps',
          <Suspense fallback={loading}>
            <MapsView />
          </Suspense>,
        )}
      />
      <Route
        path="/maps/:id"
        element={section(
          'maps',
          <Suspense fallback={loading}>
            <MapsView />
          </Suspense>,
        )}
      />
      <Route path="/scenes" element={section('scenes', <Suspense fallback={loading}><ScenesRoute /></Suspense>)} />
      <Route path="/scenes/new" element={section('scenes', <Suspense fallback={loading}><ScenesRoute /></Suspense>)} />
      <Route path="/datasets" element={<DatasetsView />} />
      <Route path="/insights" element={<InsightsView />} />
      {/* Top level: Charts and Scripts as tabs in a pane host; inside a pane: the tool itself. */}
      <Route path="/analytics" element={<AnalyticsRedirect tab="charts" />} />
      <Route path="/analytics/charts" element={section('charts', <Suspense fallback={loading}><ChartsRoute /></Suspense>)} />
      <Route path="/analytics/charts/new" element={section('charts', <Suspense fallback={loading}><ChartsRoute /></Suspense>)} />
      <Route path="/analytics/scripts" element={section('scripts', <Suspense fallback={loading}><ScriptsRoute /></Suspense>)} />
      <Route path="/analytics/scripts/new" element={section('scripts', <Suspense fallback={loading}><ScriptsRoute /></Suspense>)} />
      <Route path="/analytics/scripts/reference" element={<Suspense fallback={loading}><ScriptReferencePage /></Suspense>} />
      <Route path="/analytics/datasets" element={section('datasets', <Suspense fallback={loading}><DatasetsRoute /></Suspense>)} />
      <Route path="/analytics/datasets/new" element={section('datasets', <Suspense fallback={loading}><DatasetsRoute /></Suspense>)} />
      {/* Everything to do with data, opened over the Dashboard: /new is the way in for a project. */}
      <Route path="/new" element={<NewProjectRoute />} />
      <Route path="/charts" element={<Navigate to="/analytics/charts" replace />} />
      <Route path="/charts/new" element={<Navigate to="/analytics/charts/new" replace />} />
      <Route path="/scripts/new" element={<Navigate to="/analytics/scripts/new" replace />} />
      {/* The Scenes page was /display until 2026-09: old links, bookmarks and workstation tabs keep working, query intact. */}
      <Route path="/display" element={<LegacyRedirect to="/scenes" />} />
      <Route path="/display/new" element={<LegacyRedirect to="/scenes/new" />} />
      {/* Scripts and the plot tool live on the Analytics page now; old links keep working. */}
      <Route path="/scripts" element={<AnalyticsRedirect tab="scripts" />} />
      <Route path="/model" element={<Navigate to="/docs/model" replace />} />
      {/* The Graph Explorer's addresses (sigma / three.js, retired) open Unigraph: the same state, the engine's picture. */}
      <Route path="/graph" element={<GraphRedirect />} />
      <Route path="/graph/:mode" element={<GraphRedirect />} />
      <Route path="/inspector" element={<LegacyRedirect to="/scenes" />} />
      {/* Unigraph: the graph explorer on the engine (its tabs are /unigraph/2d and /unigraph/3d). */}
      <Route
        path="/unigraph"
        element={
          <Suspense fallback={loading}>
            {embedded ? <GraphExplorer /> : <UnigraphWorkspace />}
          </Suspense>
        }
      />
      <Route
        path="/unigraph/:mode"
        element={
          <Suspense fallback={loading}>
            {embedded ? <GraphExplorer /> : <UnigraphWorkspace />}
          </Suspense>
        }
      />
      {/* `/<tab>/new` opens that tab's way of making one — the view reads `new` where an id would be. */}
      <Route path="/documents" element={section('documents', <DocumentsView />)} />
      <Route path="/documents/:id" element={section('documents', <DocumentsView />)} />
      <Route path="/images" element={section('images', <ImagesView />)} />
      <Route path="/images/:id" element={section('images', <ImagesView />)} />
      <Route path="/videos" element={section('videos', <VideosView />)} />
      <Route path="/videos/:id" element={section('videos', <VideosView />)} />
      <Route path="/audio" element={section('audio', <AudioView />)} />
      <Route path="/audio/:id" element={section('audio', <AudioView />)} />
      {/* Audio was called Music; keep old links and saved workstations working. */}
      <Route path="/music" element={<Navigate to="/audio" replace />} />
      <Route path="/music/:id" element={<LegacyMusicRedirect />} />
      <Route
        path="/diagrams"
        element={section(
          'diagrams',
          <Suspense fallback={loading}>
            <DiagramsView />
          </Suspense>,
        )}
      />
      <Route
        path="/diagrams/:id"
        element={section(
          'diagrams',
          <Suspense fallback={loading}>
            <DiagramsView />
          </Suspense>,
        )}
      />
      <Route
        path="/docs"
        element={
          <Suspense fallback={loading}>
            <DocsView />
          </Suspense>
        }
      />
      <Route
        path="/docs/:page"
        element={
          <Suspense fallback={loading}>
            <DocsView />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function LegacyMusicRedirect() {
  const { id } = useParams()
  return <Navigate to={`/audio/${id}`} replace />
}

/**
 * Old addresses onto the Analytics tabs, query intact: `/scripts?script=x` → `/analytics/scripts?script=x`;
 * `/analytics?tab=plot&plot=x` (the first cut of the page) → `/analytics/charts?plot=x`; a `?script=` alone means Scripts.
 */
function AnalyticsRedirect({ tab }: { tab: 'charts' | 'scripts' | 'datasets' }) {
  const { search } = useLocation()
  const p = new URLSearchParams(search)
  const t = p.get('tab')
  const which = t === 'scripts' || (!t && p.has('script')) ? 'scripts' : t === 'plot' || t === 'charts' ? 'charts' : tab
  p.delete('tab')
  const q = p.toString()
  return <Navigate to={`/analytics/${which}${q ? `?${q}` : ''}`} replace />
}

/** `/new`: the app as it was, with the way into a project open over it. */
function NewProjectRoute() {
  const navigate = useNavigate()
  return (
    <>
      <DashboardView />
      <Suspense fallback={null}>
        <ProjectsDialog tab="projects" onClose={() => navigate('/')} />
      </Suspense>
    </>
  )
}

function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}
/** `/graph/<mode>` → `/unigraph/<dimensions>`, the query (a scene, a pick, a session) kept. */
function GraphRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={`${modernGraphPath(pathname)}${search}`} replace />
}

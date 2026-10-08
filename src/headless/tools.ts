import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createAeTools } from '../features/assistant/aeTools'
import { createWebTools } from '../features/assistant/webTools'
import { createAnalysisTools } from '../features/assistant/analysisTools'
import { createAppNavigationTools } from '../features/assistant/appTools'
import { createConstraintTools } from '../features/assistant/constraintTools'
import { createDocumentTools } from '../features/assistant/documentTools'
import { createEntityTools } from '../features/assistant/entityTools'
import { createMemoryTools } from '../features/assistant/memoryTools'
import { createMoreTools } from '../features/assistant/moreTools'
import { createPlotTools } from '../features/assistant/plotTools'
import { createProjectTools } from '../features/assistant/projectTools'
import { createScriptTools } from '../features/assistant/scriptTools'
import { createDatasetTools } from '../features/assistant/datasetTools'
import { withInputChecks } from '../features/assistant/validate'
import type { AppHost } from '../features/assistant/tools'
import type { HeadlessEngine } from './engine'
import { createHeadlessGraphTools } from './graphTools'
import { createSceneTools } from './sceneTools'
import { createWorkspaceTools } from './workspaceTools'

/**
 * What the engine can do without a screen.
 *
 * The tools are the app's own — the same files the assistant and the bridge
 * load in the tab — minus the groups whose answer is a picture or a pointer
 * at one: the explorer's canvas and camera, the globe, the media players,
 * the workstation, the voice loop. Those are the renderer's business, and a
 * headless caller has no use for "it is now on screen".
 *
 * Two kinds of tool take their place: the graph computed rather than drawn
 * (`graph_slice`, `graph_metrics`, `graph_layout`, and `graph_scene`, which
 * composes data + filter + layout + style into a scene the app opens) and
 * the workspace file itself (`workspace_status`, `workspace_save`…). Everything else — the
 * entity store, documents, the ontology, projects and their history,
 * constraints, analyses, plots, maps, diagrams — behaves exactly as it does
 * in the browser, because it is the same code.
 */

/** Tools the engine registers but that need something only a browser has; they are dropped with a note in `describe()`. */
const NEEDS_A_SCREEN = new Set([
  // A download and a hosted URL.
  'project_save',
  'project_publish',
  // Rendering: an SVG/PNG of a diagram, a still from a video, a page in a tab.
  'view_diagram',
  'annotate_webpage',
  // The maps page's own state.
  'map_state',
  // The explorer's, replaced by graph_slice / graph_metrics / graph_layout.
  'open',
  'open_entities',
])

export function createHeadlessTools(engine: HeadlessEngine): BetaRunnableTool[] {
  const host: AppHost = engine.host()
  const groups: BetaRunnableTool[][] = [
    createWorkspaceTools(engine),
    createHeadlessGraphTools(engine),
    createSceneTools(engine),
    createEntityTools(host),
    createDocumentTools(host),
    createProjectTools(host),
    createMoreTools(host),
    createAppNavigationTools(host),
    createAnalysisTools(host),
    createConstraintTools(host),
    createMemoryTools(host),
    createPlotTools(host),
    createDatasetTools(host),
    createScriptTools(host),
    createAeTools(host),
    createWebTools(host),
  ]
  const tools = groups.flat().filter((t) => !NEEDS_A_SCREEN.has(t.name))
  // Every runner goes through `parse`: the arguments are checked against the schema before a tool sees them.
  return tools.map(withInputChecks)
}

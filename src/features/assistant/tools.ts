import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import type { EntityId } from '../../core/entity/types'
import { createAnalysisTools } from './analysisTools'
import { createAppNavigationTools } from './appTools'
import { createDocumentTools } from './documentTools'
import { createEntityTools } from './entityTools'
import { createGraphTools } from './graphTools'
import { createMediaTools } from './mediaTools'
import { createMoreTools } from './moreTools'
import { createPlotTools } from './plotTools'
import { createDisplayTools } from './displayTools'
import { createDatasetTools } from './datasetTools'
import { createAeTools } from './aeTools'
import { createProjectTools } from './projectTools'
import { createScriptTools } from './scriptTools'
import { createWorkstationTools } from './workstationTools'
import { createDiagnosticsTools } from './diagnosticsTools'
import { createConstraintTools } from './constraintTools'
import { createVoiceTools } from './voiceTools'
import { createMemoryTools } from './memoryTools'
import { createChatTools } from './chatTools'
import { createGlobeTools } from './globeTools'
import { createSlideTools } from './slideTools'
import { createGpuGraphTools } from './gpuGraphTools'
import { createAccountTools } from './accountTools'
import { createWebTools } from './webTools'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { withInputChecks } from './validate'

/**
 * What the assistant can do in the app. Each tool is a thin, validated
 * wrapper over the entity store or the router; the model never touches
 * either directly. Results are compact JSON so they stay cheap in context.
 * The tools live one file per domain; this is the host contract and the
 * list the assistant and the MCP bridge both get.
 */

export interface AppContext {
  route: string
  /** No browser: this is the engine hosted in Node (`src/headless`), driven over MCP. Nothing is on screen. */
  headless?: boolean
  /** Uncaught errors in the tab (newest last), when any — why a page might not have mounted. */
  recentErrors?: { at: string; message: string; source?: string }[]
  /** The document open in the editor, if any. */
  document?: {
    id: string
    label: string
    extension: string
    folderPath: string[]
  }
  /** Text the user has selected in the page, if any. */
  selection?: string
  /** The video open in the player, with the playhead position. */
  video?: {
    id: string
    label: string
    currentTime: number
    playing: boolean
    duration?: number
  }
  /** The Spotify track/episode open in the player, with the playhead position. */
  audio?: {
    id: string
    label: string
    currentTime: number
    playing: boolean
    duration?: number
  }
  /** The image open in the annotator, if any. */
  image?: { id: string; label: string; width?: number; height?: number }
  /** The open project (the store's scope), or none for the whole Library. */
  project?: { id: string; label: string; entities: number }
  /** The open project's version state: HEAD, what is unsaved since it (undefined while the tree is still being read), and the saving mode. */
  versioning?: {
    head?: { id: string; short: string; message: string; at: string; auto: boolean }
    commits: number
    unsaved?: { added: number; modified: number; removed: number; total: number }
    autosave: boolean
  }
  /** The graph explorer, when one is open. */
  graph?: {
    /** The renderer: sigma (2d), force-graph (3d), or the GPU engine flat (gpu) or in three dimensions (gpu3d). */
    mode: '2d' | '3d' | 'gpu' | 'gpu3d'
    filter: string
    layout: string
    style: string
    nodes: number
    edges: number
    /** The primary selected node (the last selected). */
    selectedId?: string
    /** The selection, first 12, with labels and types. */
    selected?: { id: string; label: string; type: string }[]
    /** How many selected beyond those listed. */
    selectedMore?: number
    selectedEdge?: { id: string; label: string }
    /** What the detail pane shows: the selection, the nodes/edges tables, or a pinned entity. */
    detail?: string
  }
  /** The tables on screen: what each shows and which rows are selected. */
  tables?: { view: string; showing: string; rows: number; selected: string[] }[]
  /** The open tabs of each pane host on screen. */
  tabs?: { host: string; tabs: { id: string; title: string; path: string; active: boolean }[] }[]
  /** The in-app documentation on screen: the /docs page, or the active docs tabs of the workstation's panes (the focused pane first). */
  /** On the Chats page: the chat in front and the tabs open in its artifacts panel. */
  chatsPage?: { chat: string; panel: { title: string; path: string; active: boolean }[] }
  docs?: { id: string; title: string; blurb?: string; section?: string; where: 'page' | 'focused pane' | 'pane' }[]
  /** Voice control is on: the user spoke the message and hears the reply. */
  voice?: boolean
  /** The assistant's notes for this project (the memory document), as far as the context carries them. */
  memory?: string
  /** Memory documents that came with an import rather than being written here: someone else's notes, carried as untrusted data. */
  sharedMemory?: string
}

/**
 * How a confirmation's yes reads: the word on the button ("Delete", "Allow", "Clear"), and red when it loses something.
 * `kind` says what yes lets happen, for a host with no one to ask (the headless engine answers each by how it was
 * started): `fetch` reaches a site the tool was handed; anything else (`change`, the default) deletes, replaces or
 * changes something.
 */
export interface ConfirmOptions {
  yes?: string
  danger?: boolean
  kind?: 'fetch' | 'change'
}

export interface AppHost {
  store: EntityStore
  /** The effective ontology; built from the store when the host doesn't supply one. */
  registry?: TypeRegistry
  navigate: (to: string) => void
  getContext: () => AppContext
  /**
   * Ask the user before something is lost, reached or changed on their behalf. Resolves false if they decline. The
   * button that says yes reads `yes` ("Yes" when left out), in red when `danger` — a question that deletes says so.
   */
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>
  /** Put a question with options to the user (the ask_user tool). Resolves with the option, or null if they decline. */
  choose?: (message: string, options: string[]) => Promise<string | null>
  /** Notify the UI that a document was written, so the editor can refresh. */
  notify?: (message: string) => void
  /**
   * Show what a tool just made without leaving the page, where the page has a place for it — on the Chats page, a tab
   * in the chat's artifacts panel. False when there is none, and the tool goes to the thing's own page (`openMade`).
   */
  reveal?: (id: EntityId) => boolean
  /**
   * The hosts the user has let `web_fetch` read, for as long as the caller lasts: a chat (across its turns), one Claude
   * Code session over the bridge. Absent, the tool set keeps its own — what a yes allowed never outlives the tools it
   * was given to, nor reaches another caller's.
   */
  webApprovals?: Set<string>
}

export function createAppTools(host: AppHost) {
  const [context, ...navigation] = createAppNavigationTools(host)
  // Each group is typed as the runner's tools on its own: one literal spreading every group would ask the compiler for the union of every tool's type, which past a hundred tools it will not represent.
  const groups: BetaRunnableTool[][] = [[context], createDocumentTools(host), createMediaTools(host), createGraphTools(host), createEntityTools(host), navigation, createMoreTools(host), createPlotTools(host), createDisplayTools(host), createDatasetTools(host), createAeTools(host), createProjectTools(host), createAnalysisTools(host), createScriptTools(host), createWorkstationTools(host), createDiagnosticsTools(host), createGlobeTools(host), createGpuGraphTools(host), createSlideTools(host), createConstraintTools(host), createVoiceTools(host), createMemoryTools(host), createChatTools(host), createAccountTools(host), createWebTools(host)]
  const tools = groups.flat()
  // Every runner (the in-app session, the bridge, the tests) goes through `parse`: check the arguments against the schema there.
  return tools.map(withInputChecks)
}

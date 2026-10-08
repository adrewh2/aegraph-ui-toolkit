/**
 * Scripts: code written by the assistant or the user, run over a read-only
 * snapshot of the dataset in a sandbox — JavaScript in QuickJS (WebAssembly;
 * no DOM, no network, no storage — the interpreter has no I/O at all),
 * Python in Pyodide inside an opaque-origin iframe, or a Visual script in
 * such an iframe with a DOM and WebGL — returning plots, tables or scenes
 * the app draws (a Visual script's frame is itself the output). Time and
 * memory are capped; a runaway script is interrupted, not the tab.
 */

import type { StyleOverlay } from '../core/graph/rendering'

/** One entity as the script sees it. */
export interface SnapEntity {
  id: string
  type: string
  label: string
  description?: string
  tags: string[]
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface SnapRelationship {
  id: string
  type: string
  source: string
  target: string
  directed: boolean
  data: Record<string, unknown>
}

/** A type definition as a script sees it: the ontology, one entry per type in use or declared. */
export interface SnapType {
  type: string
  label: string
  category: string
  kind: 'entity' | 'relationship'
  parent?: string
  description?: string
  color?: string
  /** Entities (or relationships) of the type in the dataset. */
  count: number
  /** Declared properties (data keys), from the type's definition and its ancestors'. */
  properties: { key: string; label?: string; kind?: string; description?: string; options?: string[]; required?: boolean }[]
}

export interface SnapTag {
  tag: string
  count: number
  color?: string
  description?: string
}

/** What the host loads into the sandbox as `ds`. */
export interface Snapshot {
  scope: { label: string; projectId?: string; /** When the snapshot was narrowed: the only types it holds. */ types?: string[] }
  /** The open project, when one is. */
  project?: { id: string; label: string; description?: string; includes: string[]; source?: string; createdAt: string; updatedAt: string }
  entities: SnapEntity[]
  relationships: SnapRelationship[]
  /** The ontology: every type the dataset uses or declares, with its declared properties. */
  ontology?: SnapType[]
  /** The tags in use, with their colours. */
  tags?: SnapTag[]
  /** metric id → entity id → value, from the latest analysis run over this dataset. */
  metrics?: Record<string, Record<string, number>>
}

/** js: QuickJS sandbox · python: Pyodide · view: a sandboxed iframe with a DOM, canvas and WebGL (three.js, d3, Plotly). */
export type Language = 'js' | 'python' | 'view'

export interface RunOptions {
  /** Wall-clock cap for one run (default 5000 ms). */
  timeoutMs?: number
  /** Heap cap for the sandbox (default 512 MB). */
  memoryMb?: number
  /**
   * Read only these entity types (with the relationships between them). A script sees the whole project by
   * default, which a project of hundreds of thousands of entities will not fit into a sandbox — and a script
   * about the genera of a city's trees does not need the trees. Subtypes come with their parent.
   */
  types?: string[]
  /**
   * Code its owner has not run here before (a script from an import or a template, before its first run): nothing it
   * leaves in the engine may reach a later run, so the JavaScript context is rebuilt and the Python worker restarted
   * once it is done.
   */
  untrusted?: boolean
}

export interface ScriptError {
  message: string
  stack?: string
}

export interface RunResult {
  /** The script's return value, JSON-safe (Maps become objects, Sets arrays, NaN null). */
  value: unknown
  logs: string[]
  error?: ScriptError
  /** Milliseconds: loading the snapshot into the sandbox (0 when cached) and running the script. */
  ms: { load: number; run: number }
}

/** What a result carries once interpreted: each key of the returned object the app knows how to draw. */
export type Output =
  | { kind: 'figure'; data: Record<string, unknown>[]; layout: Record<string, unknown> }
  | { kind: 'table'; columns: string[]; rows: unknown[][] }
  | { kind: 'scene'; label?: string; positions: Record<string, { x: number; y: number; width?: number; height?: number }>; groups?: Record<string, { title?: string; members: string[] }>; scale?: number }
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: string }
  /** Positions per entity id for the Graph Explorer (see `layout()` in metrics.js): a saved layout that remembers the script. */
  | { kind: 'layout'; label?: string; positions: Record<string, { x: number; y: number; z?: number }>; dimensions?: 2 | 3 }
  /** Styles per entity id for the Graph Explorer (see `style()` in metrics.js), an optional rendering spec for the rest. */
  | { kind: 'style'; label?: string; overlay: StyleOverlay; spec?: Record<string, unknown> }
  | { kind: 'value'; value: unknown }

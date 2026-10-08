import { Clapperboard } from 'lucide-react'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { EntityData, EntityId } from '../entity/types'
import type { LayoutAlgorithm, LayoutParams } from './layouts'
import type { MetricsOptions } from './metrics/types'

/**
 * A scene is the composition Unigraph works in: which filter, which
 * layout, which style, and whether it's the 2D or 3D view. It references
 * the three saved parts by id rather than copying them, so editing a
 * shared filter updates every scene that uses it.
 *
 * `scene` is the graph scene itself — a subtype of the Scenes page's scene,
 * so it is listed there with the others. A save writes `scene:unigraph`;
 * the bare `scene` (scenes saved before the subtype, the templates ship
 * some) and `scene:explorer` (saved on the Graph Explorer, the sigma /
 * three.js page Unigraph replaced) are read the same way.
 */

export const SCENE_TYPE = 'scene'
export const EXPLORER_SCENE_TYPE = 'scene:explorer'
export const UNIGRAPH_SCENE_TYPE = 'scene:unigraph'
/** Every type a graph scene can have — the bare one, Unigraph's and the retired explorer's — for `store.query({ type })`. */
export const GRAPH_SCENE_TYPES = [SCENE_TYPE, EXPLORER_SCENE_TYPE, UNIGRAPH_SCENE_TYPE] as const
export const isGraphSceneType = (type: string) => (GRAPH_SCENE_TYPES as readonly string[]).includes(type)
/** The subtype a save writes. */
export const graphSceneTypeFor = () => UNIGRAPH_SCENE_TYPE
/**
 * The dimensions a mode names — an address segment or a scene's `mode` / `renderer` — with the names the Graph
 * Explorer's tabs once had (`gpu`, `gpu3d` were the engine's tabs there; `2d`, `3d` sigma and three.js) read as the
 * engine's; anything else is unknown.
 */
export const sceneDimensions = (m: string | undefined): '2d' | '3d' | undefined => (m === '2d' || m === 'gpu' ? '2d' : m === '3d' || m === 'gpu3d' ? '3d' : undefined)

export interface SceneData extends EntityData {
  filterId?: EntityId
  layoutId?: EntityId
  renderingId?: EntityId
  /** The analysis (computed metrics) the view had, saved as an entity of its own like the other parts. */
  analysisId?: EntityId
  /** The view's dimensions: the engine's flat camera or its orbit camera. */
  renderer: '2d' | '3d'
  /** Scenes saved on the Graph Explorer named their renderer here (`gpu`, `gpu3d` the engine's tabs; `2d`, `3d` sigma and three.js); read as the dimensions now. */
  mode?: '2d' | '3d' | 'gpu' | 'gpu3d'
  algorithm?: LayoutAlgorithm
  params?: Partial<Omit<LayoutParams, 'dimensions'>>
  /** The Dataset stage: a loaded project, or the workspace when absent. */
  projectId?: EntityId
  /** Analysis settings: what the auto/next run computes and whether it re-runs on view changes. */
  analysis?: { auto: boolean; options: MetricsOptions }
  /** Everything else about the view and the UI around it, so loading the scene puts the screen back as it was. */
  view?: SceneView
  /** A small picture of the view as it was saved (a data: URL, JPEG about 320 px wide) for the Scenes list's card. */
  preview?: string
  /** What the view held when it was saved: the nodes and edges in view after the filter (the scene picker's card shows them). */
  stats?: { nodes: number; edges: number }
}

/**
 * The state of the view and the UI at the moment a scene was saved — what
 * the parts (filter, layout, style, analysis) do not hold: the camera, the
 * toggles in the toolbar, the selection and the tools, which panels were
 * open. Loading the scene restores all of it; physics is recorded but
 * loads off, because a running simulation would move the picture away
 * from the one that was saved.
 */
export interface SceneView {
  /** The camera as the renderer reports it (2D: centre, ratio, angle; 3D: position and look-at). */
  camera?: SceneCamera
  labels?: 'auto' | 'all' | 'none'
  showEdges?: boolean
  showLegend?: boolean
  /** The slide layer (3D): drawn or not, which decks, the slide in front. */
  slides?: SlidesView
  physics?: boolean
  /** Neighbourhood hops for selections and focus. */
  hops?: number
  tool?: 'select' | 'path'
  pathOptions?: Record<string, unknown>
  selectedIds?: EntityId[]
  selectedEdgeId?: EntityId
  /** The side panel open beside the picture (filter, layout, style, stats, selection), or none, and its width. */
  panel?: 'filter' | 'layout' | 'style' | 'stats' | 'selection' | null
  sideWidth?: number
  /** The details pane: folded to its strip, given the whole row, which tab was showing, which entities were pinned as tabs. */
  detail?: { minimized: boolean; maximized: boolean; active: string; pinned: EntityId[]; width?: number }
}
export type SceneCamera = { kind: '2d'; x: number; y: number; ratio: number; angle: number; center: { x: number; y: number } } | { kind: '3d'; position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }

export const sceneType: EntityTypeDef = defineEntityType({
  type: SCENE_TYPE,
  label: 'Graph scene',
  pluralLabel: 'Graph scenes',
  // A subtype of Scene (`projection`, in ./projection.ts): the Scenes page lists it with the others and hands it to Unigraph.
  parent: 'projection',
  category: 'project',
  icon: Clapperboard,
  color: '#f43f5e',
  description: 'A scene that is a Unigraph composition rather than fixed positions: a filter + a layout + a style, in 2D or 3D, referencing the three saved parts by id.',
  fields: [
    { key: 'data.renderer', label: 'View', kind: 'text', width: 60 },
    // What the scene held when it was saved: the size of the picture, without opening it.
    { key: 'data.stats.nodes', label: 'Nodes', kind: 'number', width: 80 },
    { key: 'data.stats.edges', label: 'Edges', kind: 'number', width: 80 },
    { key: 'data.filterId', label: 'Filter', kind: 'ref', width: 160 },
    { key: 'data.layoutId', label: 'Layout', kind: 'ref', width: 160 },
    { key: 'data.renderingId', label: 'Style', kind: 'ref', width: 160 },
    { key: 'data.analysisId', label: 'Analysis', kind: 'ref', width: 160 },
  ],
})

export const explorerSceneType: EntityTypeDef = defineEntityType({
  type: EXPLORER_SCENE_TYPE,
  label: 'Graph Explorer scene',
  pluralLabel: 'Graph Explorer scenes',
  parent: SCENE_TYPE,
  category: 'project',
  icon: Clapperboard,
  color: '#f43f5e',
  description: 'A graph scene saved on the Graph Explorer, the page Unigraph replaced; opens in Unigraph in the dimensions it had.',
  fields: sceneType.fields,
})

export const unigraphSceneType: EntityTypeDef = defineEntityType({
  type: UNIGRAPH_SCENE_TYPE,
  label: 'Unigraph scene',
  pluralLabel: 'Unigraph scenes',
  parent: SCENE_TYPE,
  category: 'project',
  icon: Clapperboard,
  color: '#e11d48',
  description: 'A graph scene composed in Unigraph (the GPU engine, 2D or 3D); opens there.',
  fields: sceneType.fields,
})

/**
 * The slide layer of the 3D view (`core/slides`): whether the decks' slides
 * hang over the graph, which decks (every deck when `decks` is absent), the
 * slide brought to the front (its members selected, the camera facing it),
 * and whether composed slides' blocks hang as plates beneath them.
 */
export interface SlidesView {
  show: boolean
  decks?: EntityId[]
  focus?: EntityId
  /** Composed slides' blocks hung as plates of their own between the graph and the slides (default on). */
  parts?: boolean
  /** The story layer: each story's outline as a directed row of beats under its deck (default on when there are stories). */
  story?: boolean
  /** The spatial layer: each composed slide's blueprint — its frame and the rectangles of its regions — under it (default on when there are stories). */
  spatial?: boolean
  /** The finished slides themselves (default on); off shows the layers under them alone. */
  final?: boolean
}

/** A slides view read from saved data — a scene, local storage — or undefined when it is not one. */
export function slidesViewOf(v: unknown): SlidesView | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out: SlidesView = { show: o.show !== false }
  if (Array.isArray(o.decks)) out.decks = o.decks.filter((d): d is string => typeof d === 'string')
  if (typeof o.focus === 'string') out.focus = o.focus
  if (typeof o.parts === 'boolean') out.parts = o.parts
  if (typeof o.story === 'boolean') out.story = o.story
  if (typeof o.spatial === 'boolean') out.spatial = o.spatial
  if (typeof o.final === 'boolean') out.final = o.final
  return out
}

export type ScenePart = 'filter' | 'layout' | 'rendering' | 'analysis'
export const SCENE_PARTS: { key: ScenePart; idKey: 'filterId' | 'layoutId' | 'renderingId' | 'analysisId'; label: string }[] = [
  { key: 'filter', idKey: 'filterId', label: 'Filter' },
  { key: 'layout', idKey: 'layoutId', label: 'Layout' },
  { key: 'rendering', idKey: 'renderingId', label: 'Style' },
  { key: 'analysis', idKey: 'analysisId', label: 'Analysis' },
]

import { SCHEMA_TYPE, type TypeCategory } from '../core/entity/categories'
import type { TypeRegistry } from '../core/entity/typeRegistry'
import { isRelationship, type AnyEntity } from '../core/entity/types'
import { RESOURCE_TYPES } from '../core/resources/types'
import { isDatasetType } from '../core/datasets/dataset'
import { GRAPH_TYPES } from '../core/graph/types'
import { EXPLORER_SCENE_TYPE, SCENE_TYPE, UNIGRAPH_SCENE_TYPE } from '../core/graph/scene'

/**
 * Views let go the moment they are behind — not kept mounted behind the page in front (`KeptPages`) or behind a
 * pane's front tab (`WorkstationView`), as other pages are for a quick return. A Unigraph view is a graph engine: GPU
 * buffers, the slice, the held positions and a simulation, over a project that can be a million entities. Kept
 * behind, it held all of that while another page was used, and it saves what it needs to come back as it was (its
 * view state, camera and positions).
 */
const UNLOADED_BEHIND = ['unigraph', 'graph']
export const unloadsBehind = (path: string) => UNLOADED_BEHIND.includes(path.split(/[?#]/)[0].split('/')[1] ?? '')

/** Where an entity is browsed, given the current ontology. */
export function entityHref(e: AnyEntity, registry: TypeRegistry): string {
  if (isRelationship(e)) return `/entities?category=relationships&sel=${e.id}`
  if (e.type === RESOURCE_TYPES.document) return `/documents/${e.id}`
  if (e.type === RESOURCE_TYPES.image) return `/images/${e.id}`
  if (e.type === RESOURCE_TYPES.video) return `/videos/${e.id}`
  if (e.type === RESOURCE_TYPES.audio) return `/audio/${e.id}`
  if (e.type === RESOURCE_TYPES.diagram) return `/diagrams/${e.id}`
  if (e.type === 'map') return `/maps/${e.id}`
  // Charts and scripts open in their Analytics tab.
  if (e.type === 'plot') return `/analytics/charts?plot=${encodeURIComponent(e.id)}`
  if (e.type === 'script' || e.type.startsWith('script:')) return `/analytics/scripts?script=${encodeURIComponent(e.id)}`
  // A scene with geometry — the plain one or a script scene — opens on the Scenes page; a graph scene is a graph part (below).
  if (e.type === 'projection' || e.type === 'scene:script') return `/scenes?id=${encodeURIComponent(e.id)}`
  if (isDatasetType(e.type)) return `/analytics/datasets?id=${encodeURIComponent(e.id)}`
  if (e.type === SCHEMA_TYPE) return `/entities?category=types&type=${encodeURIComponent(String(e.data.name ?? ''))}`
  if (isGraphPart(e)) return graphHref(e, 2)
  return typeHref(e.type, registry.categoryOf(e.type)) + `&sel=${e.id}`
}

/** The saved pieces of a graph picture: a scene, or one of its parts (filter, layout, style, analysis). */
const GRAPH_PARTS: Record<string, string> = { [SCENE_TYPE]: 'scene', [EXPLORER_SCENE_TYPE]: 'scene', [UNIGRAPH_SCENE_TYPE]: 'scene', [GRAPH_TYPES.filter]: 'filter', [GRAPH_TYPES.layout]: 'layout', [GRAPH_TYPES.rendering]: 'style', [GRAPH_TYPES.analysis]: 'analysis' }
export const isGraphPart = (e: AnyEntity) => !isRelationship(e) && e.type in GRAPH_PARTS
/** Unigraph opened straight onto the entity: `/unigraph/2d?scene=<id>`, `?filter=`, `?layout=`, `?style=`, `?analysis=`. */
export function graphHref(e: AnyEntity, dims: 2 | 3 = 2): string {
  return `/unigraph/${dims}d?${GRAPH_PARTS[e.type] ?? 'scene'}=${encodeURIComponent(e.id)}`
}

/** The Entities browser filtered to one type. Always carries a `?` so callers can append `&sel=`. */
export function typeHref(type: string, category: TypeCategory): string {
  if (category === 'schema') return `/entities?category=types&type=${encodeURIComponent(type)}`
  return `/entities?category=${category}&type=${encodeURIComponent(type)}`
}

/** The Entities browser filtered to one category. */
export const categoryHref = (category: TypeCategory | 'all') => (category === 'schema' ? '/entities?category=types' : category === 'all' ? '/entities' : `/entities?category=${category}`)

/**
 * The Graph Explorer's addresses, read as Unigraph's: `/graph` and `/graph/2d` are `/unigraph/2d`, `/graph/3d` is
 * `/unigraph/3d`, and `/graph/gpu`, `/graph/gpu3d` (the engine's tabs there) their dimensions. Anything else is
 * returned as it is. Links, saved workstations and scenes from before the explorer went keep working through this.
 */
export function modernGraphPath(path: string): string {
  const m = /^\/graph(?:\/(2d|3d|gpu|gpu3d))?(?=[/?#]|$)(.*)$/.exec(path)
  if (!m) return path
  const mode = m[1] === '3d' || m[1] === 'gpu3d' ? '3d' : '2d'
  return `/unigraph/${mode}${m[2]}`
}

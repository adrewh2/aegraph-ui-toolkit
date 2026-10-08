import { DATASET_FAMILY, DATASET_TYPE } from '../../core/datasets/dataset'
import { PLOT_TYPE } from '../../core/graph/plot'
import { PROJECTION_TYPE, SCENE_FAMILY } from '../../core/graph/projection'
import { SCRIPT_FAMILY, SCRIPT_TYPE } from '../scripts/script'

/**
 * What Analytics keeps, one entry per landing page: the route, the type it
 * is about, and the whole family that page lists — a script is any of its
 * kinds (filter, constraint, scene, layout, style), a scene is one arranged
 * by hand, one a script drew, or a Unigraph composition. One list, so the
 * page, the sidebar's counts and anything else asking "how many charts are
 * there?" agree by construction.
 */
export interface SavedKind {
  route: string
  type: string
  noun: string
  plural: string
  /** Every type the page lists; the type itself when it has no family. */
  family: readonly string[]
}

export const SAVED_KINDS: SavedKind[] = [
  { route: '/scenes', type: PROJECTION_TYPE, noun: 'scene', plural: 'scenes', family: SCENE_FAMILY },
  { route: '/analytics/scripts', type: SCRIPT_TYPE, noun: 'script', plural: 'scripts', family: SCRIPT_FAMILY },
  { route: '/analytics/datasets', type: DATASET_TYPE, noun: 'dataset', plural: 'datasets', family: DATASET_FAMILY },
  { route: '/analytics/charts', type: PLOT_TYPE, noun: 'chart', plural: 'charts', family: [PLOT_TYPE] },
]

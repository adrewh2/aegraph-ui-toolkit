import { displayLabel } from '../core/entity/entity'
import type { EntityStore } from '../core/entity/store'
import type { AnyEntity } from '../core/entity/types'
import { isGraphSceneType, sceneDimensions, type SceneData } from '../core/graph/scene'
import type { ProjectEntity } from '../core/projects/project'

/**
 * A link that opens a demo project: `?demo=<id>` on any page of the site, and optionally `&scene=<scene>` — the
 * scene's id, or only the part after `scene:<demo>:` (`?demo=kestrel-story&scene=from-information-to-decks`). The
 * boot opens the demo as a project of its own (updating it in place if this browser has it) and lands on that scene
 * in Unigraph, on a workstation of one pane; without a scene, on the demo's own first screen. The id is only looked up
 * in this site's demo catalog and the scene only in the opened project, so a link can name nothing else to fetch.
 */
export interface DemoLink {
  demo: string
  scene?: string
}

/** A demo id is a plain name, as the catalog's are (`scripts/demos/catalog.mjs`). */
const PLAIN = /^[\w-][\w.-]*$/

/** The demo link in an address's query, if it carries one. */
export function readDemoLink(search: string): DemoLink | undefined {
  const p = new URLSearchParams(search)
  const demo = p.get('demo')?.trim()
  if (!demo || !PLAIN.test(demo)) return undefined
  const scene = p.get('scene')?.trim() || undefined
  return { demo, scene }
}

/** The address with the link's own parameters taken out (whatever else it carried stays). */
export function withoutDemoLink(search: string): string {
  const p = new URLSearchParams(search)
  p.delete('demo')
  p.delete('scene')
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** A link to a demo, or to one of its scenes, on `origin` — the scene by its short name when it has the demo's prefix. */
export function demoLink(origin: string, demo: string, scene?: string): string {
  const u = new URL('/', origin)
  u.searchParams.set('demo', demo)
  if (scene) u.searchParams.set('scene', scene.startsWith(`scene:${demo}:`) ? scene.slice(`scene:${demo}:`.length) : scene)
  return u.href
}

/** The graph scene a link names, by its id or its short name under the demo. */
export function linkedScene(store: EntityStore, link: DemoLink): AnyEntity | undefined {
  if (!link.scene) return undefined
  for (const id of [link.scene, `scene:${link.demo}:${link.scene}`]) {
    const e = store.get(id)
    if (e && isGraphSceneType(e.type)) return e
  }
  return undefined
}

/** The Unigraph tab that opens a scene as it was saved: its renderer, and the simulation if the scene ran one. */
export function sceneTab(scene: AnyEntity): { path: string; title: string } {
  const d = scene.data as SceneData
  const dims = sceneDimensions(d.mode) ?? sceneDimensions(d.renderer) ?? '3d'
  const physics = !!(d.view as { physics?: boolean } | undefined)?.physics
  return { path: `/unigraph/${dims}?scene=${encodeURIComponent(scene.id)}${physics ? '&physics=1' : ''}`, title: displayLabel(scene) }
}

/** The demo a project was opened from, by the bundle path it remembers (`/demos/<id>/…`), or undefined. */
export function demoIdOf(project: ProjectEntity | undefined): string | undefined {
  const m = project?.data.demo ? /^\/demos\/([^/]+)\//.exec(project.data.demo) : null
  return m && PLAIN.test(m[1]) ? m[1] : undefined
}

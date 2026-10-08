import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { graphHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { isPlot, PLOT_TYPE } from '../../core/graph/plot'
import { diagramSourceOf, isProjection, SCENE_FAMILY, sceneKindOf, scriptSourceOf } from '../../core/graph/projection'
import { getSceneHandle, waitForDisplay } from '../scenes/sceneHandle'
import type { AppHost } from './tools'

const json = (v: unknown) => JSON.stringify(v)

/**
 * One tool over the Scenes page: what it shows (a scene or a plot),
 * a scene to compare against, its selection, and saving. Mirrors what the
 * view's own buttons do, so the assistant — and later dictation — can drive
 * it the way a person would.
 */
export function createDisplayTools(host: AppHost) {
  const { store } = host
  const labelOf = (id: string) => {
    const e = store.get(id)
    return e ? displayLabel(e) : id
  }
  const open = async () => {
    let h = getSceneHandle()
    if (h) return h
    host.navigate('/scenes')
    h = await waitForDisplay()
    if (!h) throw new Error('The Scenes page did not open. Navigate to /scenes and try again.')
    return h
  }
  const state = (h: ReturnType<typeof getSceneHandle>) => {
    if (!h) return { open: false }
    const s = h.getState()
    return {
      open: true,
      scene: s.scene ? { id: s.scene, label: labelOf(s.scene) } : s.unsaved ? { unsaved: true } : undefined,
      plot: s.plot ? { id: s.plot, label: s.plot === 'new' ? 'new plot' : labelOf(s.plot) } : undefined,
      comparingWith: s.over ? { id: s.over, label: labelOf(s.over) } : undefined,
      dirty: s.dirty,
      selection: s.selection,
      nodes: s.nodes,
      edges: s.edges,
      url: s.plot ? `/scenes?plot=${s.plot}` : s.scene ? `/scenes?id=${s.scene}${s.over ? `&over=${s.over}` : ''}` : '/scenes',
    }
  }

  const display = betaTool({
    name: 'display',
    description:
      'The Scenes page (/scenes; workstation panes host it too; the tool keeps its old name "display"). Scenes are a family: a scene (positions, arranged by hand or captured from a diagram), a script scene (positions a script drew with scene(positions); it remembers the script) and a graph scene (a Graph Explorer composition — list shows it with kind "graph"; show opens it in the Explorer). It shows one scene — a 2D arrangement of entities: positions, sizes, shapes, colours, edge routes, group boxes, drawn without the graph engines — or one plot. Actions: state (what it shows now); show (a scene by id, or a plot by id / "new"); compare (draw another scene underneath, faded, to check two arrangements against each other; omit the id to stop); select (highlight entities and open the first in the side panel); fit; save (persist the working copy as a scene, updating it when id names one); list (saved scenes and plots). Diagram imports make scenes (diagram_to_dataset with capture_geometry).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['state', 'show', 'compare', 'select', 'fit', 'save', 'list'] },
        scene: { type: 'string', description: 'show/compare: a scene entity id' },
        plot: { type: 'string', description: 'show: a chart (plot) entity id, or "new" — opens it in Analytics' },
        ids: { type: 'array', items: { type: 'string' }, description: 'select: entity ids' },
        name: { type: 'string', description: 'save: the scene name' },
        id: { type: 'string', description: 'save: an existing scene to update' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, scene, plot, ids, name, id }) => {
      if (action === 'list')
        return json({
          // The whole family: kind says which — a scene (positions), a script scene (positions, by a script) or a graph scene (a Unigraph composition; show opens it there).
          scenes: store.query({ type: [...SCENE_FAMILY] }).map((e) => {
            const kind = sceneKindOf(e.type) ?? 'scene'
            const script = isProjection(e) ? scriptSourceOf(e.data) : undefined
            return { id: e.id, label: displayLabel(e), kind, nodes: isProjection(e) ? Object.keys(e.data.nodes).length : undefined, from: isProjection(e) ? diagramSourceOf(e.data)?.format : undefined, ...(script ? { script: script.scriptId, ranAt: script.ranAt } : {}), ...(kind === 'graph' ? { renderer: (e.data as { renderer?: string }).renderer ?? '2d' } : {}) }
          }),
          plots: store.ofType(PLOT_TYPE).map((e) => ({ id: e.id, label: displayLabel(e) })),
        })
      if (action === 'state') return json(state(getSceneHandle()))
      if (action === 'show') {
        if (plot) {
          if (plot !== 'new' && !isPlot(store.get(plot))) throw new Error(`No plot with id ${plot}.`)
          host.navigate(`/scenes?plot=${encodeURIComponent(plot)}`)
        } else if (scene) {
          const e = store.get(scene)
          if (sceneKindOf(e?.type ?? '') === 'graph') {
            // A graph scene has no positions of its own: it opens in Unigraph, which is where it is edited too.
            const to = graphHref(e!, (e!.data as { renderer?: string }).renderer === '3d' ? 3 : 2)
            host.navigate(to)
            return json({ opened: to, kind: 'graph', type: e!.type, note: 'A graph scene is a Unigraph composition; it opened there. graph_state reads it.' })
          }
          if (!isProjection(e)) throw new Error(`No scene with id ${scene}. Use display {action:"list"}; diagram imports and scripts make scenes.`)
          host.navigate(`/scenes?id=${encodeURIComponent(scene)}`)
        } else throw new Error('show needs a scene or a plot.')
        const h = await waitForDisplay()
        return json(state(h))
      }
      const h = await open()
      if (action === 'compare') {
        if (scene && !isProjection(store.get(scene))) throw new Error(`No scene with id ${scene}.`)
        h.compareWith(scene ?? null)
        return json(state(h))
      }
      if (action === 'select') {
        const want = (ids ?? []).filter((x) => store.has(x))
        h.select(want)
        return json({ selected: want, ...state(h) })
      }
      if (action === 'fit') {
        h.fit()
        return json({ fit: true })
      }
      if (action === 'save') {
        if (!name && !id) throw new Error('save needs a name (or an id of a scene to update).')
        const existing = id ? store.get(id) : undefined
        if (id && !isProjection(existing)) throw new Error(`No scene with id ${id}.`)
        const label = name ?? displayLabel(existing!)
        const saved = h.save(label, id)
        if (!saved) throw new Error('Nothing to save: the view shows no scene.')
        return json({ id: saved, label, updated: !!existing, ...state(h) })
      }
      throw new Error(`Unknown action ${action as string}`)
    },
  })

  return [display]
}

import { describe, expect, it } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import type { EntityId } from '../../../core/entity/types'
import { registerDisplayHandle, type SceneHandle } from '../../scenes/sceneHandle'
import { createDisplayTools } from '../displayTools'
import type { AppHost } from '../tools'

function setup() {
  const store = new EntityStore()
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createDisplayTools(host)
  const t = tools.find((x) => x.name === 'display') as BetaRunnableTool
  const run = async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  const scene = (id: string, label: string) => createEntity({ id, type: 'projection', label, data: { kind: '2d', width: 100, height: 100, nodes: { a: { x: 1, y: 1, width: 10, height: 10, shape: 'box' } }, edges: {}, groups: {} } })
  store.upsertMany([scene('s1', 'One'), scene('s2', 'Two'), createEntity({ id: 'a', type: 'person', label: 'Ada' }), createEntity({ id: 'pl', type: 'plot', label: 'Chart', data: { spec: {} } })])
  // The rest of the family: a scene a script drew, and a graph scene (a Unigraph composition).
  store.upsertMany([
    createEntity({ id: 'script1', type: 'script', label: 'Place by year', data: { code: '', language: 'js' } }),
    createEntity({ id: 's3', type: 'scene:script', label: 'By year', data: { kind: '2d', width: 100, height: 100, nodes: { a: { x: 1, y: 1, width: 10, height: 10, shape: 'box' } }, edges: {}, groups: {}, source: { scriptId: 'script1', ranAt: '2026-09-19T00:00:00Z' } } }),
    createEntity({ id: 'g1', type: 'scene', label: 'Hubs in 3D', data: { renderer: '3d', filterId: 'f1' } }),
  ])
  return { store, navigated, run }
}

/** A stand-in for the open view: holds what it shows the way the real one does. */
function fakeView(store: EntityStore) {
  let scene: EntityId | undefined = 's1'
  let plot: EntityId | undefined
  let over: EntityId | undefined
  let selection: EntityId[] = []
  const h: SceneHandle = {
    getState: () => ({ scene, unsaved: false, plot, over, selection, dirty: false, nodes: 1, edges: 0 }),
    show: (t) => {
      scene = t.scene
      plot = t.plot
      over = undefined
    },
    compareWith: (id) => {
      over = id ?? undefined
    },
    select: (ids) => {
      selection = ids
    },
    save: (name, existing) => {
      if (existing) {
        store.update(existing, { label: name })
        return existing
      }
      const e = createEntity({ type: 'projection', label: name, data: { kind: '2d', width: 1, height: 1, nodes: {}, edges: {}, groups: {} } })
      store.upsert(e)
      scene = e.id
      return e.id
    },
    fit: () => {},
  }
  return { handle: h, unregister: registerDisplayHandle(h) }
}

describe('display tool', () => {
  it('lists scenes and plots; show navigates to the right URL', async () => {
    const { store, navigated, run } = setup()
    const list = await run({ action: 'list' })
    expect(list.scenes.map((p: { label: string; kind: string }) => [p.label, p.kind])).toEqual([
      ['One', 'scene'],
      ['Two', 'scene'],
      ['By year', 'script'],
      ['Hubs in 3D', 'graph'],
    ])
    expect(list.scenes[2]).toMatchObject({ script: 'script1', ranAt: '2026-09-19T00:00:00Z', nodes: 1 })
    expect(list.scenes[3]).toMatchObject({ renderer: '3d' })
    expect(list.scenes[3].nodes).toBeUndefined()
    expect(list.plots.map((p: { label: string }) => p.label)).toEqual(['Chart'])
    const view = fakeView(store)
    await run({ action: 'show', scene: 's2' })
    await run({ action: 'show', plot: 'new' })
    await run({ action: 'show', plot: 'pl' })
    expect(navigated).toEqual(['/scenes?id=s2', '/scenes?plot=new', '/scenes?plot=pl'])
    await expect(run({ action: 'show', scene: 'nope' })).rejects.toThrow(/No scene/)
    view.unregister()
  })

  it('compares, selects, saves, and reports state with a stable URL', async () => {
    const { store, run } = setup()
    const view = fakeView(store)
    let s = await run({ action: 'compare', scene: 's2' })
    expect(s.comparingWith).toEqual({ id: 's2', label: 'Two' })
    expect(s.url).toBe('/scenes?id=s1&over=s2')
    s = await run({ action: 'compare' })
    expect(s.comparingWith).toBeUndefined()
    s = await run({ action: 'select', ids: ['a', 'missing'] })
    expect(s.selected).toEqual(['a'])
    s = await run({ action: 'save', name: 'Arranged' })
    expect(store.get(s.id)?.type).toBe('projection')
    expect(s.scene).toEqual({ id: s.id, label: 'Arranged' })
    s = await run({ action: 'save', id: 's2', name: 'Two, renamed' })
    expect(s.updated).toBe(true)
    expect(store.get('s2')?.label).toBe('Two, renamed')
    view.unregister()
  })
})

describe('display tool and the scene family', () => {
  it('shows a script scene on the Scenes page like any scene, and hands a graph scene to Unigraph in its own dimensions', async () => {
    const { store, navigated, run } = setup()
    fakeView(store)
    await run({ action: 'show', scene: 's3' })
    const graph = await run({ action: 'show', scene: 'g1' })
    expect(graph).toMatchObject({ opened: '/unigraph/3d?scene=g1', kind: 'graph' })
    expect(navigated).toEqual(['/scenes?id=s3', '/unigraph/3d?scene=g1'])
    await expect(run({ action: 'show', scene: 'nope' })).rejects.toThrow(/No scene with id nope/)
  })
})

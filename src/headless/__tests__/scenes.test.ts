import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../core/entity/entity'
import { DEFAULT_RENDERING, toRenderingSpec, type RenderingData } from '../../core/graph/rendering'
import { applyStyleChannels } from '../../core/graph/styleChannels'
import type { LayoutData } from '../../core/graph/types'
import type { SceneData } from '../../core/graph/scene'
import { HeadlessEngine } from '../engine'
import { createHeadlessTools } from '../tools'

/**
 * A scene composed with no canvas: the four parts the explorer saves —
 * data, filter, layout, style — written as the same entities, so the app
 * opens the picture this described.
 */
describe('composing a scene headlessly', () => {
  let dir: string
  let engine: HeadlessEngine
  let tools: ReturnType<typeof createHeadlessTools>
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!
    return JSON.parse(String(await tool.run(tool.parse(input)))) as Record<string, never>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegraph-scene-test-'))
    engine = new HeadlessEngine({ file: join(dir, 'w.ae.json'), autosave: false })
    // A small platform: three services in a chain, one store off the end.
    const ids = ['gateway', 'orders', 'ledger'].map((label) => {
      const e = createEntity({ type: 'service', label, tags: ['service'], data: { rps: label === 'gateway' ? 4000 : 500 } })
      engine.store.upsert(e)
      return e.id
    })
    const store = createEntity({ type: 'datastore', label: 'postgres', tags: ['service'] })
    engine.store.upsert(store)
    engine.store.upsert(createRelationship({ type: 'depends-on', source: ids[0], target: ids[1], directed: true }))
    engine.store.upsert(createRelationship({ type: 'depends-on', source: ids[1], target: ids[2], directed: true }))
    engine.store.upsert(createRelationship({ type: 'reads-writes', source: ids[2], target: store.id, directed: true }))
    tools = createHeadlessTools(engine)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a filter, a layout with positions, a style and the scene that binds them', async () => {
    const r = await call('graph_scene', {
      action: 'save',
      name: 'The chain',
      filter: { types: ['service', 'datastore'] },
      layout: { algorithm: 'layered', direction: 'LR' },
      metrics: ['degree', 'pagerank'],
      style: {
        channels: [
          { scope: 'nodes', by: 'all', channel: 'color', mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' },
          { scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 5, max: 20 },
        ],
      },
      view: { labels: 'all', show_legend: true, panel: 'style', slides: { show: true, decks: ['deck:board'] } },
    })
    expect(r).toMatchObject({ type: 'scene:unigraph', renderer: '2d', stats: { nodes: 4, edges: 3 } })

    const scene = engine.store.get(r.id as unknown as string)!
    const d = scene.data as SceneData
    const layout = engine.store.get(d.layoutId!)!
    const style = engine.store.get(d.renderingId!)!
    expect(engine.store.get(d.filterId!)!.data).toMatchObject({ types: ['service', 'datastore'] })
    expect(Object.keys((layout.data as LayoutData).positions)).toHaveLength(4)
    expect((layout.data as LayoutData).algorithm).toBe('layered')
    // The style is a rendering spec, and it is the one the channels describe.
    const spec = toRenderingSpec(style.data as RenderingData)
    expect(spec.nodes.default.color).toMatchObject({ mode: 'partition', attr: { kind: 'type' } })
    expect(spec.nodes.default.size).toMatchObject({ mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 5, max: 20 })
    // The metrics ride along as an analysis, and the view says how the scene opens.
    expect(engine.store.get(d.analysisId!)?.type).toBe('analysis')
    expect(d.view).toMatchObject({ labels: 'all', showLegend: true, panel: 'style', physics: false, slides: { show: true, decks: ['deck:board'] } })
    // No canvas to capture, so the Scenes card's picture is drawn from the slice and its positions.
    expect(d.preview).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(d.preview!.split(',')[1]).match(/<circle/g)).toHaveLength(4)
  })

  it('gives a chart saved here its card picture too', async () => {
    const r = await call('plot', { action: 'save', name: 'Load', spec: { selector: { types: ['service'] }, traces: [{ kind: 'bar', x: 'label', y: 'data.rps' }] } })
    const preview = (engine.store.get(r.id as unknown as string)!.data as { preview?: string }).preview
    expect(preview).toMatch(/^data:image\/svg\+xml/)
  })

  it('leaves a 2D scene to the app to frame, and gives a 3D scene the camera it opens on', async () => {
    const flat = await call('graph_scene', { action: 'save', name: 'Flat', layout: { algorithm: 'force' } })
    const deep = await call('graph_scene', { action: 'save', name: 'Deep', dimensions: 3, layout: { algorithm: 'force' } })
    expect((engine.store.get(flat.id as unknown as string)!.data as SceneData).view?.camera).toBeUndefined()
    const camera = (engine.store.get(deep.id as unknown as string)!.data as SceneData).view?.camera
    expect(camera?.kind).toBe('3d')
    expect(camera && 'position' in camera && Number.isFinite(camera.position.z)).toBe(true)
  })

  it('reuses saved parts rather than writing new ones, and refuses a style over metrics the scene does not compute', async () => {
    const first = await call('graph_scene', { action: 'save', name: 'First', layout: { algorithm: 'force' } })
    const parts = (engine.store.get(first.id as unknown as string)!.data as SceneData)
    const second = await call('graph_scene', { action: 'save', name: 'Second', filter_id: parts.filterId, layout_id: parts.layoutId, style_id: parts.renderingId })
    const reused = engine.store.get(second.id as unknown as string)!.data as SceneData
    expect([reused.filterId, reused.layoutId, reused.renderingId]).toEqual([parts.filterId, parts.layoutId, parts.renderingId])
    expect(engine.store.library.ofType('filter')).toHaveLength(1)

    await expect(
      call('graph_scene', { action: 'save', name: 'Ranked by nothing', layout: { algorithm: 'force' }, style: { channels: [{ scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'metric', key: 'betweenness' } }] } }),
    ).rejects.toThrow(/betweenness/)
  })

  it('describes a scene and lists it, and the style channels are the explorer\'s own', async () => {
    const saved = await call('graph_scene', { action: 'save', name: 'Listed', layout: { algorithm: 'force' } })
    const list = await call('graph_scene', { action: 'list' })
    expect((list.scenes as unknown as { id: string }[]).map((s) => s.id)).toContain(saved.id)
    const got = await call('graph_scene', { action: 'get', id: saved.id as unknown as string })
    expect(got).toMatchObject({ id: saved.id, layout: { positions: 4 } })

    // The same channel vocabulary the tab's graph_style takes, applied to the same spec.
    const { spec, changes } = applyStyleChannels(DEFAULT_RENDERING, [{ scope: 'nodes', by: 'types', key: 'service', channel: 'color', mode: 'constant', value: '#0f766e' }])
    expect(spec.nodes.types.service.color).toEqual({ mode: 'constant', value: '#0f766e' })
    expect(changes).toHaveLength(1)
  })
})

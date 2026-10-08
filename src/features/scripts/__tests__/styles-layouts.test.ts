import { describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { legendFor, resolveEdgeStyle, resolveNodeStyles, styleContext, toRenderingSpec, type RenderingData } from '../../../core/graph/rendering'
import { GRAPH_TYPES, type LayoutData } from '../../../core/graph/types'
import { outputsOf } from '../../../scripting/outputs'
import { applyLayoutScript, layoutOfScript } from '../layouts'
import { saveScript } from '../script'
import { applyStyleScript, renderingOfScript, scriptOfRendering } from '../styles'
import '../../../core/graph/types'
import '../script'

// The worker has no place in a test: the same QuickJS sandbox runs in-process over the real snapshot.
vi.mock('../runner', async () => {
  const { Sandbox } = await import('../../../scripting/sandbox')
  const { snapshotProvider } = await import('../snapshot')
  const sb = new Sandbox()
  return {
    runScript: async (store: EntityStore, registry: TypeRegistry, code: string) => {
      const snap = snapshotProvider(store, registry)()
      await sb.load(snap.key, await snap.json())
      const r = await sb.run(code)
      return { value: r.value, logs: r.logs, error: r.error, ms: { load: 0, run: r.ms.run, snapshot: 0 } }
    },
  }
})

/**
 * Style and layout scripts put to use: the script runs in the sandbox,
 * what it returns becomes the script's rendering / layout entity (one per
 * script, updated on a rerun), and the rendering pipeline draws the
 * overlay on top of the rules — with the script's legend.
 */
function store() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'person', label: 'A' }),
    createEntity({ id: 'b', type: 'person', label: 'B' }),
    createEntity({ id: 'c', type: 'org', label: 'C', tags: ['hot'] }),
    createRelationship({ id: 'r1', type: 'knows', source: 'a', target: 'b' }),
    createRelationship({ id: 'r2', type: 'works-at', source: 'b', target: 'c' }),
  ])
  return s
}
const STYLE = `
  const { degree } = ds.compute(['degree'])
  const nodes = {}
  for (const e of ds.entities) nodes[e.id] = { color: e.type === 'org' ? '#ff0000' : '#0000ff', size: 4 + degree[e.id] * 5 }
  return style(nodes, { edges: { r2: { width: 6 } }, legend: { title: 'Kind', items: [{ label: 'People', color: '#0000ff' }, { label: 'Orgs', color: '#ff0000' }] } })
`
const LAYOUT = `
  const positions = {}
  ds.entities.forEach((e, i) => { positions[e.id] = { x: i * 50, y: e.type === 'org' ? 100 : 0 } })
  return layout(positions, { label: 'Rows by type' })
`

describe('style scripts', () => {
  it('run, become the script\'s rendering with the overlay and the source, and update on a rerun', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const script = saveScript(s, STYLE, 'By degree')
    const applied = await applyStyleScript(s, reg, script.id)
    expect(applied.updated).toBe(false)
    expect(applied.rendering.type).toBe(GRAPH_TYPES.rendering)
    expect(applied.rendering.label).toBe('By degree')
    expect(Object.keys(applied.output.overlay.nodes ?? {})).toEqual(['a', 'b', 'c'])
    expect(applied.spec.overlay?.source?.scriptId).toBe(script.id)
    expect(applied.spec.overlay?.nodes?.c).toEqual({ color: '#ff0000', size: 9 })
    expect(applied.spec.overlay?.edges?.r2).toEqual({ width: 6 })
    // The script is now a style script, and the rendering finds its way back to it.
    expect(s.get(script.id)?.type).toBe('script:style')
    expect(renderingOfScript(s, script.id)?.id).toBe(applied.rendering.id)
    expect(scriptOfRendering(s, applied.rendering)?.id).toBe(script.id)
    // A rerun updates the same entity.
    const again = await applyStyleScript(s, reg, script.id)
    expect(again.updated).toBe(true)
    expect(again.rendering.id).toBe(applied.rendering.id)
    expect(s.ofType(GRAPH_TYPES.rendering).length).toBe(1)
  })

  it('draws the overlay over the rules and shows the script\'s legend; the stored data round-trips', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const script = saveScript(s, STYLE, 'By degree')
    const { rendering } = await applyStyleScript(s, reg, script.id)
    // As the explorer loads it: from the entity's data.
    const spec = toRenderingSpec(rendering.data as RenderingData)
    expect(spec.overlay?.nodes?.a).toEqual({ color: '#0000ff', size: 9 })
    const nodes = s.library.all().filter((e) => e.kind === 'entity')
    const degree = new Map(nodes.map((n) => [n.id, 1]))
    const ctx = styleContext(reg, nodes, degree, spec)
    const styles = resolveNodeStyles(nodes, spec, ctx)
    expect(styles.get('c')?.color).toBe('#ff0000')
    expect(styles.get('c')?.size).toBe(9)
    expect(styles.get('a')?.size).toBe(9)
    // Two nodes of one type would share a resolved style; overridden ones are their own objects.
    expect(styles.get('a')).not.toBe(styles.get('b'))
    const edge = s.get('r2')!
    expect(edge.kind === 'relationship' && resolveEdgeStyle(edge, spec, () => '#999', ctx).width).toBe(6)
    const legend = legendFor(spec, ctx, nodes)
    expect(legend?.kind === 'categories' && legend.scripted && legend.items.map((i) => i.label)).toEqual(['People', 'Orgs'])
  })

  it('refuses a script that returns no style, and one that fails', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const plain = saveScript(s, 'return { text: "hi" }', 'plain')
    await expect(applyStyleScript(s, reg, plain.id)).rejects.toThrow(/returned no style/)
    const broken = saveScript(s, 'throw new Error("boom")', 'broken')
    await expect(applyStyleScript(s, reg, broken.id)).rejects.toThrow(/boom/)
    await expect(applyStyleScript(s, reg, 'nope')).rejects.toThrow(/No script/)
  })

  it('a style output checks its fields: bad colours, sizes out of range and unknown shapes are dropped', () => {
    const outs = outputsOf({ style: { nodes: { a: { color: 'not a colour', size: 999, shape: 'star', opacity: 2 }, b: { color: '#123', visible: false }, c: 5 } } })
    expect(outs[0].kind).toBe('style')
    if (outs[0].kind === 'style') expect(outs[0].overlay.nodes).toEqual({ a: { size: 200, opacity: 1 }, b: { color: '#123', visible: false } })
    expect(() => outputsOf({ style: { nodes: {} } })).toThrow(/needs styles per entity id/)
  })
})

describe('layout scripts', () => {
  it('run, become the script\'s layout (algorithm script, source), and update on a rerun', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const script = saveScript(s, LAYOUT, 'Rows')
    const applied = await applyLayoutScript(s, reg, script.id)
    expect(applied.layout.type).toBe(GRAPH_TYPES.layout)
    expect(applied.layout.label).toBe('Rows by type')
    expect(applied.dimensions).toBe(2)
    const d = applied.layout.data as LayoutData
    expect(d.algorithm).toBe('script')
    expect(d.source?.scriptId).toBe(script.id)
    expect(d.positions.c).toEqual({ x: 100, y: 100 })
    expect(s.get(script.id)?.type).toBe('script:layout')
    expect(layoutOfScript(s, script.id)?.id).toBe(applied.layout.id)
    const again = await applyLayoutScript(s, reg, script.id)
    expect(again.updated).toBe(true)
    expect(s.ofType(GRAPH_TYPES.layout).length).toBe(1)
  })

  it('takes a scene script\'s positions as a layout too, and reads 3D off a z', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const script = saveScript(s, `return scene({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } })`, 'Scene')
    const applied = await applyLayoutScript(s, reg, script.id)
    expect(Object.keys(applied.positions)).toEqual(['a', 'b'])
    const three = saveScript(s, `return layout({ a: { x: 1, y: 2, z: 3 } })`, 'Three')
    expect((await applyLayoutScript(s, reg, three.id)).dimensions).toBe(3)
    const none = saveScript(s, `return { text: 'x' }`, 'none')
    await expect(applyLayoutScript(s, reg, none.id)).rejects.toThrow(/returned no layout/)
  })
})

describe('a Visual script is not a style, a layout or a filter', () => {
  it('is refused before anything runs (it would draw nowhere, and its frame would run on)', async () => {
    const s = store()
    const reg = new TypeRegistry(s)
    const e = saveScript(s, 'document.body.textContent = "x"', 'Drawn', undefined, undefined, 'view')
    await expect(applyStyleScript(s, reg, e.id)).rejects.toThrow(/Visual script cannot be used as a style/)
    await expect(applyLayoutScript(s, reg, e.id)).rejects.toThrow(/Visual script cannot be used as a layout/)
    const { runFilterScript } = await import('../filters')
    await expect(runFilterScript(s, reg, e.id)).rejects.toThrow(/Visual script cannot be used as a filter/)
  })
})

import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { DEFAULT_RENDERING, resolveNodeStyle, resolveNodeStyles, styleContext, toRenderingSpec, type RenderingSpec } from '../rendering'

/**
 * resolveNodeStyles answers the same as resolveNodeStyle per node, and shares one
 * style object across nodes that are alike in everything a style reads: type,
 * the tags a rule names, data.color, and every mapped channel's value.
 */
describe('node style classes', () => {
  const store = new EntityStore()
  const nodes = [
    createEntity({ id: 'a', type: 'tree', tags: ['genus:acer', 'ward:1'], data: { dbh: 10 } }),
    createEntity({ id: 'b', type: 'tree', tags: ['genus:acer', 'ward:2'], data: { dbh: 20 } }),
    createEntity({ id: 'c', type: 'tree', tags: ['genus:tilia'], data: { dbh: 10 } }),
    createEntity({ id: 'd', type: 'tree', tags: ['genus:acer'], data: { color: '#ff0000' } }),
    createEntity({ id: 'e', type: 'ward', tags: [] }),
  ]
  store.upsertMany([...nodes, schemaTypeEntity('tree', { color: '#228833' })])
  const registry = new TypeRegistry(store)
  const degree = new Map([['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 3]])
  const same = (spec: RenderingSpec) => {
    const ctx = styleContext(registry, nodes, degree, spec)
    const all = resolveNodeStyles(nodes, spec, ctx)
    for (const n of nodes) expect(all.get(n.id)).toEqual(resolveNodeStyle(n, spec, ctx))
    return all
  }

  it('matches per-node resolution under the default style and shares by type, own colour and degree', () => {
    const all = same(DEFAULT_RENDERING)
    // Same type, same degree, no ruled tags, no own colour: one object.
    expect(all.get('a')).toBe(all.get('b'))
    expect(all.get('a')).toBe(all.get('c'))
    // An own colour is its own class; another type too.
    expect(all.get('d')).not.toBe(all.get('a'))
    expect(all.get('d')!.color).toBe('#ff0000')
    expect(all.get('e')).not.toBe(all.get('a'))
  })

  it('splits classes by the tags a rule names and by a partition\'s value, not by tags nobody styles', () => {
    let spec = toRenderingSpec({ ...DEFAULT_RENDERING, nodes: { ...DEFAULT_RENDERING.nodes, tags: { 'genus:tilia': { color: '#0000ff' } } } })
    let all = same(spec)
    expect(all.get('a')).toBe(all.get('b'))
    expect(all.get('c')).not.toBe(all.get('a'))
    expect(all.get('c')!.color).toBe('#0000ff')
    // Partition colour by the tag namespace: acer and tilia differ; the ward tags still do not split acer.
    spec = toRenderingSpec({ ...DEFAULT_RENDERING, nodes: { ...DEFAULT_RENDERING.nodes, default: { ...DEFAULT_RENDERING.nodes.default, color: { mode: 'partition', attr: { kind: 'tag', prefix: 'genus' }, palette: 'tableau10' } } } })
    all = same(spec)
    expect(all.get('a')).toBe(all.get('b'))
    expect(all.get('a')!.color).not.toBe(all.get('c')!.color)
  })

  it('a continuous mapping still resolves per value', () => {
    const spec = toRenderingSpec({ ...DEFAULT_RENDERING, nodes: { ...DEFAULT_RENDERING.nodes, default: { ...DEFAULT_RENDERING.nodes.default, size: { mode: 'ranking', attr: { kind: 'field', key: 'dbh' }, min: 2, max: 20 } } } })
    const all = same(spec)
    expect(all.get('a')).toBe(all.get('c'))
    expect(all.get('a')!.size).not.toBe(all.get('b')!.size)
  })
})

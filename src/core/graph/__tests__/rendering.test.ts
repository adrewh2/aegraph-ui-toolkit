import { describe, expect, it } from 'vitest'
import { computeMetrics, serializeSlice } from '../metrics'
import { legendFor, setDefault, type NodeDefaults } from '../rendering'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { hashColor } from '../../../lib/format'
import { DEFAULT_RENDERING, describeRendering, resolveEdgeStyle, resolveNodeStyle, setRule, styleContext, toRenderingSpec, typeColorFor, withAlpha, type RenderingSpec } from '../rendering'

const store = new EntityStore()
store.upsertMany([
  createEntity({ id: 'a', type: 'philosopher', tags: ['ancient'], data: { born: -400 } }),
  createEntity({ id: 'b', type: 'philosopher', tags: [], data: { born: 1700 } }),
  createEntity({ id: 'c', type: 'concept', tags: ['ancient', 'disputed'] }),
  schemaTypeEntity('philosopher', { color: '#112233' }),
  createRelationship({ id: 'r', type: 'influenced', source: 'a', target: 'b', tags: ['disputed'] }),
])
const registry = new TypeRegistry(store)
const nodes = store.query({ kind: 'entity' })
const degree = new Map([['a', 5], ['b', 1]])
const ctx = (spec: RenderingSpec) => styleContext(registry, nodes, degree, spec)
const node = (id: string) => store.get(id)!
const sizeDefault = DEFAULT_RENDERING.nodes.default.size as { min: number; max: number }

describe('rendering resolution', () => {
  it('falls back to type colors and degree sizing', () => {
    const st = resolveNodeStyle(node('a'), DEFAULT_RENDERING, ctx(DEFAULT_RENDERING))
    expect(st.color).toBe('#112233')
    expect(st.shape).toBe('circle')
    expect(st.visible).toBe(true)
    const small = resolveNodeStyle(node('b'), DEFAULT_RENDERING, ctx(DEFAULT_RENDERING))
    expect(st.size).toBeGreaterThan(small.size)
    expect(st.size).toBe(sizeDefault.max)
  })

  it('applies type and tag rules with precedence, and hidden always wins', () => {
    let spec = setRule(DEFAULT_RENDERING, 'nodes', 'types', 'philosopher', { color: { mode: 'constant', value: '#ff0000' }, shape: { mode: 'constant', value: 'square' } })
    spec = setRule(spec, 'nodes', 'tags', 'ancient', { color: { mode: 'constant', value: '#00ff00' }, sizeScale: 2 })
    const typeWins = resolveNodeStyle(node('a'), spec, ctx(spec))
    expect(typeWins.color).toBe('#ff0000')
    expect(typeWins.shape).toBe('square')
    expect(typeWins.size).toBe(sizeDefault.max * 2) // multiplier came from the tag rule; type rule didn't set one
    const tagSpec = { ...spec, precedence: 'tag' as const }
    expect(resolveNodeStyle(node('a'), tagSpec, ctx(tagSpec)).color).toBe('#00ff00')
    const hidden = setRule(tagSpec, 'nodes', 'types', 'philosopher', { visible: false })
    expect(resolveNodeStyle(node('a'), hidden, ctx(hidden)).visible).toBe(false)
    expect(resolveNodeStyle(node('b'), hidden, ctx(hidden)).visible).toBe(false)
    expect(resolveNodeStyle(node('c'), hidden, ctx(hidden)).visible).toBe(true)
  })

  it('ranks size by a numeric data field', () => {
    const spec = setDefault(DEFAULT_RENDERING, 'nodes', { size: { mode: 'ranking', attr: { kind: 'field', key: 'born' }, min: 2, max: 10 } })
    const c = ctx(spec)
    expect(resolveNodeStyle(node('a'), spec, c).size).toBe(2)
    expect(resolveNodeStyle(node('b'), spec, c).size).toBe(10)
    expect(resolveNodeStyle(node('c'), spec, c).size).toBe(2) // missing value → min
  })

  it('a per-type mapping ranks over that type only', () => {
    // All nodes: constant size. Philosophers: rank opacity by `born` within philosophers.
    let spec = setDefault(DEFAULT_RENDERING, 'nodes', { size: { mode: 'constant', value: 5 } })
    spec = setRule(spec, 'nodes', 'types', 'philosopher', { opacity: { mode: 'ranking', attr: { kind: 'field', key: 'born' }, min: 0.2, max: 1 } })
    const c = ctx(spec)
    expect(resolveNodeStyle(node('a'), spec, c)).toMatchObject({ size: 5, opacity: 0.2 })
    expect(resolveNodeStyle(node('b'), spec, c)).toMatchObject({ size: 5, opacity: 1 })
    expect(resolveNodeStyle(node('c'), spec, c).opacity).toBe(1) // concept inherits the constant
  })

  it('partitions shape and colour by a categorical attribute', () => {
    const spec = setDefault(DEFAULT_RENDERING, 'nodes', { shape: { mode: 'partition', attr: { kind: 'type' } }, color: { mode: 'partition', attr: { kind: 'tag' }, palette: 'tableau10', colors: { ancient: '#abcdef' } } })
    const c = ctx(spec)
    expect(resolveNodeStyle(node('a'), spec, c).shape).toBe('circle') // most frequent type → first shape
    expect(resolveNodeStyle(node('c'), spec, c).shape).toBe('square')
    expect(resolveNodeStyle(node('a'), spec, c).color).toBe('#abcdef') // explicit override for the category
    expect(resolveNodeStyle(node('b'), spec, c).color).toBe('#c9c6bf') // no tag → missing colour
  })

  it('colours a tag partition with each tag\'s own colour, as its chip everywhere else', () => {
    const spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'tag' }, palette: 'tableau10', maxCategories: 1 } })
    const tagColor = (t: string) => (t === 'disputed' ? '#123456' : undefined)
    const c = styleContext(registry, nodes, degree, spec, { tagColor })
    expect(resolveNodeStyle(node('c'), spec, c).color).toBe(hashColor('ancient')) // first tag, no stored colour → the chip's hash colour
    const disputedFirst = createEntity({ id: 'd', type: 'concept', tags: ['disputed'] })
    expect(resolveNodeStyle(disputedFirst, spec, c).color).toBe('#123456') // past the legend's room, still its own colour
    const legend = legendFor(spec, c, nodes)
    expect(legend?.kind === 'categories' && legend.items[0]).toMatchObject({ key: 'ancient', color: hashColor('ancient') })
    expect(legend?.kind === 'categories' && legend.palette).toBeUndefined()
  })

  it('resolves edge styles and clears rules', () => {
    const edge = store.relationships()[0]
    let spec = setRule(DEFAULT_RENDERING, 'edges', 'tags', 'disputed', { color: { mode: 'constant', value: '#abcdef' }, width: { mode: 'constant', value: 3 }, arrow: false })
    const st = resolveEdgeStyle(edge, spec, () => '#000')
    expect(st).toMatchObject({ color: '#abcdef', width: 3, arrow: false, visible: true })
    spec = setRule(spec, 'edges', 'tags', 'disputed', null)
    expect(resolveEdgeStyle(edge, spec, () => '#000').color).toBe('#000')
    expect(describeRendering(spec)).toBe('Default style')
  })

  it('migrates every older rendering shape', () => {
    // Original aegraph shape: plain values, isVisible, mode.
    let spec = toRenderingSpec({ mode: 'tag', nodes: { types: { field: { color: '#eee', isVisible: false, size: 1.5, shape: 'diamond' } }, tags: {} }, edges: { types: { r: { color: '#123', width: 2 } }, tags: {} } })
    expect(spec.precedence).toBe('tag')
    expect(spec.nodes.types.field).toEqual({ color: { mode: 'constant', value: '#eee' }, sizeScale: 1.5, shape: { mode: 'constant', value: 'diamond' }, visible: false })
    expect(spec.edges.types.r).toEqual({ color: { mode: 'constant', value: '#123' }, width: { mode: 'constant', value: 2 } })
    expect(spec.nodes.default.size).toEqual(DEFAULT_RENDERING.nodes.default.size)
    // colorBy / sizing / widthBy shape.
    spec = toRenderingSpec({
      nodes: { colorBy: { source: 'metric', key: 'pagerank', scale: 'sequential', palette: 'bogus' } },
      sizing: { by: 'field', field: 'born', min: 2, max: 9, log: true },
      edges: { widthBy: { source: 'field', key: 'weight', min: 1, max: 5 }, colorBy: { source: 'type', scale: 'categorical', palette: 'tableau10' } },
    })
    expect(spec.nodes.default.color).toEqual({ mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, palette: 'viridis' })
    expect(spec.nodes.default.size).toEqual({ mode: 'ranking', attr: { kind: 'field', key: 'born' }, min: 2, max: 9, log: true })
    expect(spec.edges.default.width).toEqual({ mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 1, max: 5 })
    expect(spec.edges.default.color).toEqual({ mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' })
    expect(toRenderingSpec({ sizing: { by: 'metric' } }).nodes.default.size).toEqual(DEFAULT_RENDERING.nodes.default.size)
    expect(toRenderingSpec({ sizing: { by: 'uniform', min: 4, max: 4 } }).nodes.default.size).toEqual({ mode: 'constant', value: 4 })
    expect(toRenderingSpec({}).curvedEdges).toBe(true)
    // The current shape round-trips.
    const cur = setDefault(DEFAULT_RENDERING, 'nodes', { shape: { mode: 'partition', attr: { kind: 'type' }, shapes: { concept: 'triangle' } } })
    expect(toRenderingSpec(cur)).toEqual(cur)
  })

  it('withAlpha handles hex, rgb, hsl', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(withAlpha('rgb(1, 2, 3)', 0.2)).toBe('rgba(1, 2, 3, 0.2)')
    expect(withAlpha('hsl(10 20% 30%)', 0.3)).toBe('hsl(10 20% 30% / 0.3)')
    expect(withAlpha('#ff0000', 1)).toBe('#ff0000')
  })

  it('maps colours and sizes to fields, metrics and communities with rule overrides', () => {
    const s = new EntityStore()
    const nodes = [
      createEntity({ id: 'p', type: 'person', label: 'p', tags: ['x'], data: { year: 1900 } }),
      createEntity({ id: 'q', type: 'person', label: 'q', data: { year: 2000 } }),
      createEntity({ id: 'w', type: 'work', label: 'w', data: {} }),
    ]
    s.upsertMany(nodes)
    const edges = [createRelationship({ id: 'e1', type: 'r', source: 'p', target: 'q', data: { weight: 4 } }), createRelationship({ id: 'e2', type: 'r', source: 'q', target: 'w', data: { weight: 1 } })]
    s.upsertMany(edges)
    const registry = new TypeRegistry(s)
    const degree = new Map([['p', 1], ['q', 2], ['w', 1]])
    // Colour by field, sequential.
    let spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'ranking', attr: { kind: 'field', key: 'year' }, palette: 'greys' } })
    let ctx = styleContext(registry, nodes, degree, spec)
    expect(resolveNodeStyle(nodes[0], spec, ctx).color).toBe('#e5e5e5')
    expect(resolveNodeStyle(nodes[1], spec, ctx).color).toBe('#000000')
    expect(resolveNodeStyle(nodes[2], spec, ctx).color).toBe('#c9c6bf')
    const lg = legendFor(spec, ctx, nodes)
    expect(lg).toMatchObject({ kind: 'gradient', title: 'Year', domain: [1900, 2000] })
    // A tag rule's constant colour overrides the global mapping.
    spec = setRule(spec, 'nodes', 'tags', 'x', { color: { mode: 'constant', value: '#ff0000' } })
    ctx = styleContext(registry, nodes, degree, spec)
    expect(resolveNodeStyle(nodes[0], spec, ctx).color).toBe('#ff0000')
    // Partition by type yields a legend with counts.
    spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' } })
    ctx = styleContext(registry, nodes, degree, spec)
    const cat = legendFor(spec, ctx, nodes)
    expect(cat).toMatchObject({ kind: 'categories', items: [{ key: 'person', count: 2, color: '#4e79a7' }, { key: 'work', count: 1, color: '#f28e2c' }] })
    // Metrics: colour by community and size by pagerank; in-degree needs edges.
    const metrics = computeMetrics(serializeSlice({ nodes, edges }), { metrics: ['pagerank', 'community'] })
    spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'metric', key: 'community' }, palette: 'set3' }, size: { mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 2, max: 10 } })
    ctx = styleContext(registry, nodes, degree, spec, { edges, metrics })
    const sizes = nodes.map((n) => resolveNodeStyle(n, spec, ctx).size)
    expect(Math.max(...sizes)).toBe(10)
    expect(Math.min(...sizes)).toBe(2)
    expect(resolveNodeStyle(nodes[0], spec, ctx).color).toMatch(/^#[0-9a-f]{6}$/)
    const inDeg: Partial<NodeDefaults> = { size: { mode: 'ranking', attr: { kind: 'degree', dir: 'in' }, min: 1, max: 3 } }
    spec = setDefault(DEFAULT_RENDERING, 'nodes', inDeg)
    ctx = styleContext(registry, nodes, degree, spec, { edges })
    expect(resolveNodeStyle(nodes[0], spec, ctx).size).toBe(1) // p has no incoming edge
    expect(resolveNodeStyle(nodes[1], spec, ctx).size).toBe(3)
    // Edge width by weight, edge colour by type.
    spec = setDefault(DEFAULT_RENDERING, 'edges', { width: { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 1, max: 5 }, color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' } })
    ctx = styleContext(registry, nodes, degree, spec, { edges })
    expect(resolveEdgeStyle(edges[0], spec, () => '#000', ctx).width).toBe(5)
    expect(resolveEdgeStyle(edges[1], spec, () => '#000', ctx).width).toBe(1)
    expect(resolveEdgeStyle(edges[1], spec, () => '#000', ctx).color).toBe('#4e79a7')
    // Own data.color shows when no rule/mapping applies; describe.
    const own = createEntity({ id: 'o', type: 'person', label: 'o', data: { color: '#123456' } })
    expect(resolveNodeStyle(own, DEFAULT_RENDERING, styleContext(registry, [own], degree, DEFAULT_RENDERING)).color).toBe('#123456')
    expect(describeRendering(spec)).toContain('edge width by weight')
    expect(describeRendering(spec)).toContain('edge colour by type')
  })
})

describe('typeColorFor — what the lists beside the picture show for a type', () => {
  /** Every node's canvas colour, its type's legend swatch and typeColorFor must be one colour. */
  const agree = (spec: RenderingSpec) => {
    const c = ctx(spec)
    const legend = legendFor(spec, c, nodes)
    // A node with a colour of its own (data.color) is drawn in it, whatever its type's colour is.
    for (const n of nodes.filter((x) => typeof x.data.color !== 'string')) {
      const drawn = resolveNodeStyle(n, spec, c).color
      expect(typeColorFor(spec, c, n.type), n.type).toBe(drawn)
      if (legend?.kind === 'categories') expect(legend.items.find((it) => it.key === n.type)?.color, n.type).toBe(drawn)
    }
  }

  it('colouring by type: the palette colour the canvas draws, not the type’s own colour', () => {
    const spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' } } as Partial<NodeDefaults>)
    agree(spec)
    // The philosopher type has its own colour; under the palette the picture does not use it, and neither does the list.
    expect(typeColorFor(spec, ctx(spec), 'philosopher')).not.toBe('#112233')
  })

  it('a per-type constant colour wins, as it does on the canvas', () => {
    const base = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' } } as Partial<NodeDefaults>)
    const spec = setRule(base, 'nodes', 'types', 'concept', { color: { mode: 'constant', value: '#abcdef' } })
    agree(spec)
    expect(typeColorFor(spec, ctx(spec), 'concept')).toBe('#abcdef')
  })

  it('with the types’ own colours (the default), the type’s colour; one colour for all when the default is one', () => {
    agree(DEFAULT_RENDERING)
    expect(typeColorFor(DEFAULT_RENDERING, ctx(DEFAULT_RENDERING), 'philosopher')).toBe('#112233')
    const flat = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'constant', value: '#777777' } } as Partial<NodeDefaults>)
    expect(typeColorFor(flat, ctx(flat), 'concept')).toBe('#777777')
  })

  it('a type the view does not hold falls back to its own colour rather than the missing grey', () => {
    const spec = setDefault(DEFAULT_RENDERING, 'nodes', { color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' } } as Partial<NodeDefaults>)
    expect(typeColorFor(spec, ctx(spec), 'unseen-type')).toBe(registry.colorOf('unseen-type'))
  })
})

describe('colour channels from data hold colours', () => {
  const evil = 'url(https://evil.example/x)'

  it('a constant, a type’s rule and a partition’s own colours that are not colours are dropped', () => {
    const spec = toRenderingSpec({
      nodes: {
        default: { color: { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10', colors: { person: evil, place: '#123456', thing: 'red;background:url(https://evil.example/y)' } } },
        types: { person: { color: { mode: 'constant', value: evil } }, place: { color: evil }, org: { color: '  teal ' } },
        tags: {},
      },
      edges: { default: { color: { mode: 'constant', value: 'red"><x' } }, types: {}, tags: {} },
    } as never)
    expect(spec.nodes.default.color).toMatchObject({ mode: 'partition', colors: { place: '#123456' } })
    expect(JSON.stringify(spec)).not.toContain('evil.example')
    expect(spec.nodes.types.person.color).toEqual({ mode: 'constant' })
    expect(spec.nodes.types.place.color).toBeUndefined()
    expect(spec.nodes.types.org.color).toEqual({ mode: 'constant', value: 'teal' })
    expect(spec.edges.default.color).toEqual({ mode: 'constant' })
  })

  it('so the colour the lists beside the picture use is one', () => {
    const store = new EntityStore()
    const registry = new TypeRegistry(store)
    const spec = toRenderingSpec({ nodes: { default: { color: { mode: 'constant', value: evil } }, types: { person: { color: { mode: 'constant', value: evil } } }, tags: {} } } as never)
    const ctx = styleContext(registry, [], new Map(), spec)
    expect(typeColorFor(spec, ctx, 'person')).toBe(registry.colorOf('person'))
  })
})

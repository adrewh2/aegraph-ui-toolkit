import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { MISSING_COLOR, paletteColor } from '../palettes'
import { attrKey, attrLabel, attrUsesMetrics, DEFAULT_RENDERING, describeRendering, isCategoricalAttr, isDefaultRendering, legendFor, normEdgeRule, normNodeRule, paletteKindFor, resolveEdgeStyle, resolveNodeStyle, setDefault, setRule, styleContext, toRenderingSpec, withAlpha, type Attr, type RenderingSpec, LEGEND_ROWS } from '../rendering'
import '../types'

/**
 * What the first rendering pass left: a numeric channel over values all
 * equal, over text, NaN and zeros on a log scale, a metric channel with
 * no run behind it; sizes and opacities clamped and scaled from any
 * scope; visibility and labels from a tag rule; edge channels by
 * direction, tag rule, width scale, arrows, and attrs edges do not have;
 * the legend in every mode (gradient, partition by type with a rule
 * override, by tag with its prefix stripped, by community, the type
 * legend past fourteen types, nothing for no nodes); the attr helpers on
 * every kind; the rule normalisers on junk and legacy shapes; the spec
 * from nothing and from junk; setRule/setDefault; the description; the
 * palette kind; and alpha.
 */
function fixture(extraNodes: ReturnType<typeof createEntity>[] = []) {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', tags: ['hot', 'topic:ai'], data: { w: 5, txt: '12', zero: 0 } }),
    createEntity({ id: 'b', type: 'paper', tags: ['topic:ml'], data: { w: 5, txt: 'abc', zero: 0 } }),
    createEntity({ id: 'c', type: 'note', tags: [], data: { w: 5, txt: '3', zero: 10 } }),
    schemaTypeEntity('paper', { color: '#112233', label: 'Paper' }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b', directed: true, data: { s: 1 } }),
    createRelationship({ id: 'bc', type: 'cites', source: 'b', target: 'c', directed: false, data: { s: 3 }, tags: ['weak'] }),
    ...extraNodes,
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const spec = (patch: (r: RenderingSpec) => void): RenderingSpec => {
    const r = structuredClone(DEFAULT_RENDERING)
    patch(r)
    return r
  }
  const ctxFor = (r: RenderingSpec, extras: Parameters<typeof styleContext>[4] = {}) => styleContext(registry, slice.nodes, slice.degree, r, { edges: slice.edges, tagColor: (t) => (t === 'topic:ai' ? '#0a0a0a' : undefined), ...extras })
  const node = (id: string) => s.get(id)!
  const edge = (id: string) => slice.edges.find((e) => e.id === id)!
  const nodeStyle = (id: string, r: RenderingSpec, extras?: Parameters<typeof styleContext>[4]) => resolveNodeStyle(node(id), r, ctxFor(r, extras))
  const edgeStyle = (id: string, r: RenderingSpec) => resolveEdgeStyle(edge(id), r, () => '#999999', ctxFor(r))
  return { s, registry, slice, spec, ctxFor, node, edge, nodeStyle, edgeStyle }
}

describe('numeric channels at their edges', () => {
  it('puts values all equal in the middle, text that is a number on the scale, text that is not at the bottom, and zeros on a log scale at the bottom', () => {
    const { spec, nodeStyle, ctxFor, slice } = fixture()
    const flat = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'w' }, min: 2, max: 10 }))
    expect(nodeStyle('a', flat).size).toBe(6)
    expect(legendFor(spec((r) => (r.nodes.default.color = { mode: 'ranking', attr: { kind: 'field', key: 'w' }, palette: 'viridis' })), ctxFor(spec((r) => (r.nodes.default.color = { mode: 'ranking', attr: { kind: 'field', key: 'w' }, palette: 'viridis' }))), slice.nodes)).toMatchObject({ kind: 'gradient', domain: [5, 5] })
    const txt = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'txt' }, min: 0, max: 12 }))
    expect(nodeStyle('a', txt).size).toBe(12) // "12" reads as 12, the top of a [3, 12] domain
    expect(nodeStyle('c', txt).size).toBe(0)
    expect(nodeStyle('b', txt).size).toBe(0) // "abc" is not a number: the minimum
    const col = spec((r) => (r.nodes.default.color = { mode: 'ranking', attr: { kind: 'field', key: 'txt' }, palette: 'viridis' }))
    expect(nodeStyle('b', col).color).toBe(MISSING_COLOR)
    const log = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'zero' }, min: 1, max: 9, log: true }))
    expect(nodeStyle('a', log).size).toBe(1) // zero has no log: the bottom
    expect(nodeStyle('c', log).size).toBe(5) // the only positive value: a flat domain, the middle
    const logCol = spec((r) => (r.nodes.default.color = { mode: 'ranking', attr: { kind: 'field', key: 'zero' }, palette: 'viridis', log: true }))
    expect(nodeStyle('a', logCol).color).toBe(MISSING_COLOR)
    expect(nodeStyle('c', logCol).color).toBe(paletteColor('viridis', 0.5))
  })

  it('leaves a metric channel grey and at the minimum without a run, with a gradient legend over the empty domain', () => {
    const { spec, nodeStyle, ctxFor, slice } = fixture()
    const m = spec((r) => {
      r.nodes.default.color = { mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, palette: 'viridis' }
      r.nodes.default.size = { mode: 'ranking', attr: { kind: 'metric', key: 'betweenness' }, min: 4, max: 8 }
    })
    expect(nodeStyle('a', m)).toMatchObject({ color: MISSING_COLOR, size: 4 })
    expect(legendFor(m, ctxFor(m), slice.nodes)).toMatchObject({ kind: 'gradient', title: 'Pagerank', domain: [0, 1] })
    expect(attrUsesMetrics({ kind: 'metric', key: 'pagerank' })).toBe(true)
    expect(attrUsesMetrics({ kind: 'value', ref: 'metric.pagerank' })).toBe(true)
    expect(attrUsesMetrics({ kind: 'value', ref: 'data.x' })).toBe(false)
    expect(attrUsesMetrics(undefined)).toBe(false)
  })

  it('clamps opacity into [0, 1] whatever the channel says, scales size from any scope, and takes visibility and labels from a tag rule', () => {
    const { spec, nodeStyle } = fixture()
    const wild = spec((r) => {
      r.nodes.default.opacity = { mode: 'ranking', attr: { kind: 'field', key: 'w' }, min: -3, max: 9 }
      r.nodes.default.size = { mode: 'constant', value: 4 }
      r.nodes.tags.hot = { sizeScale: 2.5, label: false }
      r.nodes.tags['topic:ml'] = { visible: false, opacity: { mode: 'constant', value: 7 } }
      r.nodes.types.note = { opacity: { mode: 'constant', value: -1 } }
    })
    expect(nodeStyle('a', wild)).toMatchObject({ opacity: 1, size: 10, label: false, visible: true }) // a flat domain lands in the middle of [-3, 9], 3, then clamps to 1
    expect(nodeStyle('b', wild)).toMatchObject({ visible: false, opacity: 1 })
    expect(nodeStyle('c', wild)).toMatchObject({ opacity: 0, size: 4, label: true })
  })
})

describe('edge channels at their edges', () => {
  it('partitions by direction, ranks width with a scale from a tag rule, drops the arrow by rule, and reads no degree on an edge', () => {
    const { spec, edgeStyle } = fixture()
    const r = spec((s) => {
      s.edges.default.color = { mode: 'partition', attr: { kind: 'directed' }, palette: 'tableau10', colors: { directed: '#ff0000', undirected: '#0000ff' } }
      s.edges.default.width = { mode: 'ranking', attr: { kind: 'field', key: 's' }, min: 1, max: 3 }
      s.edges.tags.weak = { widthScale: 0.5, arrow: false, opacity: { mode: 'constant', value: 0.3 } }
      s.edges.types.cites = { width: { mode: 'ranking', attr: { kind: 'degree' }, min: 2, max: 4 } }
    })
    expect(edgeStyle('ab', r)).toMatchObject({ color: '#ff0000', width: 2, arrow: true, opacity: 0.6 }) // a degree attr on an edge reads nothing: the type rule's minimum
    expect(edgeStyle('bc', r)).toMatchObject({ color: '#0000ff', width: 1, arrow: false, opacity: 0.3 }) // the tag rule halves it
    const byValue = spec((s) => (s.edges.default.width = { mode: 'ranking', attr: { kind: 'value', ref: 'data.s' }, min: 1, max: 3 }))
    expect(edgeStyle('ab', byValue).width).toBe(1)
    expect(edgeStyle('bc', byValue).width).toBe(3)
    const noCtx = resolveEdgeStyle(fixture().edge('ab'), byValue, () => '#abc')
    expect(noCtx).toMatchObject({ color: '#abc', width: 1 }) // no scales given: the minimum and the default colour
  })
})

describe('legends', () => {
  it('shows a type partition with a constant type rule overriding the swatch, a tag partition without its prefix and with the tag’s own colour, and a community', () => {
    const { spec, ctxFor, slice } = fixture()
    const byType = spec((r) => {
      r.nodes.default.color = { mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' }
      r.nodes.types.note = { color: { mode: 'constant', value: '#123456' } }
    })
    const lt = legendFor(byType, ctxFor(byType), slice.nodes)
    expect(lt).toMatchObject({ kind: 'categories', title: 'Type', palette: 'tableau10', missing: 0, overflow: 0, more: 0 })
    expect((lt as { items: { key: string; label: string; color: string; count: number }[] }).items).toEqual([{ key: 'paper', label: 'Paper', color: expect.any(String), count: 2 }, { key: 'note', label: 'Note', color: '#123456', count: 1 }])
    const underTag = { ...byType, precedence: 'tag' as const }
    expect((legendFor(underTag, ctxFor(underTag), slice.nodes) as { items: { color: string }[] }).items[1].color).not.toBe('#123456') // under tag precedence the type rule no longer wins on the canvas
    const byTag = spec((r) => (r.nodes.default.color = { mode: 'partition', attr: { kind: 'tag', prefix: 'topic:' }, palette: 'tableau10' }))
    const ltag = legendFor(byTag, ctxFor(byTag), slice.nodes)
    expect(ltag).toMatchObject({ kind: 'categories', title: 'Tag topic:…', palette: undefined, missing: 1 })
    expect((ltag as { items: { key: string; label: string; color: string }[] }).items.map((i) => [i.key, i.label, i.color])).toEqual([['topic:ai', 'ai', '#0a0a0a'], ['topic:ml', 'ml', expect.stringMatching(/^hsl|^#/)]])
    const noColon = spec((r) => (r.nodes.default.color = { mode: 'partition', attr: { kind: 'tag', prefix: 'topic' }, palette: 'tableau10' }))
    expect((legendFor(noColon, ctxFor(noColon), slice.nodes) as { items: { label: string }[] }).items.map((i) => i.label)).toEqual(['ai', 'ml']) // the panel spells the prefix without the colon
    const community = spec((r) => (r.nodes.default.color = { mode: 'partition', attr: { kind: 'metric', key: 'community' }, palette: 'tableau10' }))
    const lc = legendFor(community, ctxFor(community, { metrics: { ids: ['a', 'b', 'c'], columns: { community: [0, 0, 1] } } as never }), slice.nodes)
    expect((lc as { items: { label: string }[] }).items.map((i) => i.label)).toEqual(['Community 0', 'Community 1'])
  })

  it('lists every type by count with rule or constant colours — the list scrolls, nothing is folded away — and gives nothing for no nodes', () => {
    const many = Array.from({ length: 16 }, (_, i) => createEntity({ id: `t${i}`, type: `type${i}` }))
    const { spec, ctxFor, slice } = fixture(many)
    const plain = spec((r) => {
      r.nodes.default.color = { mode: 'constant', value: '#ffffff' }
      r.nodes.types.paper = { color: { mode: 'constant', value: '#654321' } }
    })
    const l = legendFor(plain, ctxFor(plain), slice.nodes) as { items: { key: string; color: string; count: number }[]; overflow: number; more: number }
    expect(l.items).toHaveLength(18)
    expect(l.items[0]).toEqual({ key: 'paper', label: 'Paper', color: '#654321', count: 2 })
    expect(l.items[2].color).toBe('#ffffff') // no rule and no type colour: the constant channel
    expect([l.overflow, l.more]).toEqual([0, 0]) // 18 types in view, every one listed
    expect(legendFor(plain, ctxFor(plain), [])).toBeNull()
  })

  it('stops at LEGEND_ROWS rows, counting the rest — a tag namespace of thousands is not thousands of rows', () => {
    const many = Array.from({ length: LEGEND_ROWS + 20 }, (_, i) => createEntity({ id: `n${i}`, type: `kind${i}` }))
    const { spec, ctxFor, slice } = fixture(many)
    const plain = spec(() => {})
    const l = legendFor(plain, ctxFor(plain), slice.nodes) as { items: unknown[]; more: number; overflow: number }
    expect(l.items).toHaveLength(LEGEND_ROWS)
    expect(l.more).toBeGreaterThanOrEqual(20)
    expect(l.overflow).toBeGreaterThanOrEqual(20)
  })
})

describe('helpers', () => {
  it('names, keys and classifies every attr kind', () => {
    const attrs: [Attr, string, string, boolean][] = [
      [{ kind: 'degree' }, 'degree', 'degree:both', false],
      [{ kind: 'degree', dir: 'in' }, 'in-degree', 'degree:in', false],
      [{ kind: 'field', key: 'a.b' }, 'a.b', 'field:a.b', false],
      [{ kind: 'metric', key: 'pagerank' }, 'pagerank', 'metric:pagerank', false],
      [{ kind: 'metric', key: 'community' }, 'community (louvain)', 'metric:community', true],
      [{ kind: 'type' }, 'type', 'type', true],
      [{ kind: 'tag' }, 'first tag', 'tag:', true],
      [{ kind: 'tag', prefix: 'topic:' }, 'tag topic:…', 'tag:topic:', true],
      [{ kind: 'directed' }, 'directed', 'directed', true],
      [{ kind: 'value', ref: 'type' }, 'type', 'value:type', true],
      [{ kind: 'value', ref: 'degree.in:cites' }, 'in-degree via cites', 'value:degree.in:cites', false],
    ]
    for (const [a, label, key, cat] of attrs) {
      expect(attrLabel(a), key).toBe(label)
      expect(attrKey(a), key).toBe(key)
      expect(isCategoricalAttr(a), key).toBe(cat)
    }
    expect(attrLabel({ kind: 'metric', key: 'nope' as never })).toBe('nope')
  })

  it('normalises rules from junk and from the legacy shape, and fills a spec from nothing or from junk', () => {
    expect(normNodeRule(null)).toEqual({})
    expect(normNodeRule('x')).toEqual({})
    expect(normNodeRule({ size: 2, isVisible: false, shape: 'hexagon', color: '#fff', label: 'yes' })).toEqual({ sizeScale: 2, visible: false, color: { mode: 'constant', value: '#fff' } })
    expect(normNodeRule({ size: { mode: 'ranking', attr: { kind: 'degree' } }, opacity: 0.5 })).toEqual({ size: { mode: 'ranking', attr: { kind: 'degree' }, min: 3, max: 14 }, opacity: { mode: 'constant', value: 0.5 } })
    expect(normNodeRule({ color: { mode: 'ranking', attr: { kind: 'nope' } } })).toEqual({})
    expect(normEdgeRule({ width: 3, arrow: false, widthScale: 2, opacity: 'x' })).toEqual({ width: { mode: 'constant', value: 3 }, arrow: false, widthScale: 2 })
    expect(toRenderingSpec(undefined)).toEqual(DEFAULT_RENDERING)
    expect(toRenderingSpec({ nodes: 'junk', edges: 5, precedence: 'weird', edgeLabels: 'no' } as never)).toEqual(DEFAULT_RENDERING)
    expect(toRenderingSpec({ mode: 'tag' } as never).precedence).toBe('tag')
    expect(toRenderingSpec({ nodes: { types: { paper: 'junk', note: { size: 2 } } } } as never).nodes.types).toEqual({ paper: {}, note: { sizeScale: 2 } })
  })

  it('sets and clears rules and defaults without touching the old spec, and describes what it sees', () => {
    const base = DEFAULT_RENDERING
    const withRule = setRule(base, 'nodes', 'types', 'paper', { sizeScale: 2, label: false })
    expect(withRule.nodes.types.paper).toEqual({ sizeScale: 2, label: false })
    expect(base.nodes.types).toEqual({})
    const unset = setRule(withRule, 'nodes', 'types', 'paper', { sizeScale: undefined })
    expect(unset.nodes.types.paper).toEqual({ label: false })
    expect(setRule(unset, 'nodes', 'types', 'paper', { label: undefined }).nodes.types).toEqual({}) // nothing left: the rule goes
    expect(setRule(withRule, 'nodes', 'types', 'paper', null).nodes.types).toEqual({})
    expect(setRule(withRule, 'edges', 'tags', 'weak', { arrow: false }).edges.tags.weak).toEqual({ arrow: false })
    const d = setDefault(base, 'nodes', { sizeScale: 3 })
    expect(d.nodes.default.sizeScale).toBe(3)
    expect(setDefault(d, 'nodes', { sizeScale: undefined }).nodes.default).not.toHaveProperty('sizeScale')
    expect(isDefaultRendering(base)).toBe(true)
    expect(isDefaultRendering(withRule)).toBe(false)
    expect(describeRendering(withRule)).toBe('1 node type rule')
    const busy = setDefault(setDefault(withRule, 'nodes', { color: { mode: 'partition', attr: { kind: 'tag' }, palette: 'tableau10' }, size: { mode: 'constant', value: 5 } }), 'edges', { width: { mode: 'ranking', attr: { kind: 'field', key: 's' }, min: 1, max: 2 } })
    expect(describeRendering({ ...busy, edgeLabels: true, nodes: { ...busy.nodes, tags: { a: {}, b: {} } } })).toBe('colour by first tag · uniform size · 1 node type rule · 2 node tag rules · edge width by s · edge labels')
    expect(describeRendering(setDefault(base, 'nodes', { size: { mode: 'ranking', attr: { kind: 'degree', dir: 'in' }, min: 1, max: 2 } }))).toBe('size by in-degree')
    expect(paletteKindFor({ mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' })).toBe('categorical')
    expect(paletteKindFor({ mode: 'ranking', attr: { kind: 'degree' }, palette: 'RdBu' })).toBe('diverging')
    expect(paletteKindFor({ mode: 'ranking', attr: { kind: 'degree' }, palette: 'viridis' })).toBe('sequential')
    expect(paletteKindFor({ mode: 'constant' })).toBe('sequential')
    expect(withAlpha('#ff0000', 1)).toBe('#ff0000')
    expect(withAlpha('#ff0000', 2)).toBe('#ff0000')
    expect(withAlpha('tomato', 0.5)).toBe('tomato')
  })
})

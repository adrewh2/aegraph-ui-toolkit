import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { applyFilter, describeFilter, emptyFilter } from '../filter'
import { bounds, computeLayout, DEFAULT_LAYOUT_PARAMS, HEAVY_LAYOUT_NODES, isHeavyLayout, LAYOUTS, resolvePositions, type LayoutAlgorithm } from '../layouts'
import { leanSlice } from '../runLayoutInWorker'
import '../types'

function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'plato', type: 'philosopher', label: 'Plato', tags: ['ancient', 'greek'] }),
    createEntity({ id: 'aristotle', type: 'philosopher', label: 'Aristotle', tags: ['ancient', 'greek'] }),
    createEntity({ id: 'kant', type: 'philosopher', label: 'Kant', tags: ['modern'] }),
    createEntity({ id: 'republic', type: 'major work', label: 'Republic', tags: ['ancient'] }),
    createEntity({ id: 'ethics', type: 'major work', label: 'Ethics' }),
    createEntity({ id: 'island', type: 'concept', label: 'Lonely island' }),
    createEntity({ id: 'layout1', type: 'layout', label: 'A layout', data: { positions: {} } }),
    schemaTypeEntity('philosopher', { parent: 'person' }),
    createRelationship({ id: 'r1', type: 'influenced', source: 'plato', target: 'aristotle' }),
    createRelationship({ id: 'r2', type: 'contributed', source: 'plato', target: 'republic' }),
    createRelationship({ id: 'r3', type: 'contributed', source: 'aristotle', target: 'ethics' }),
    createRelationship({ id: 'r4', type: 'influenced', source: 'aristotle', target: 'kant' }),
  ])
  return { s, r: new TypeRegistry(s) }
}

describe('applyFilter', () => {
  it('shows every knowledge/resource node by default and hides graph/schema entities', () => {
    const { s, r } = fixture()
    const g = applyFilter(s, r, emptyFilter())
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'ethics', 'island', 'kant', 'plato', 'republic'])
    expect(g.edges.length).toBe(4)
    expect(g.degree.get('aristotle')).toBe(3)
  })

  it('narrows by type, relationship type, and tags', () => {
    const { s, r } = fixture()
    expect(applyFilter(s, r, { ...emptyFilter(), types: ['philosopher'] }).nodes.length).toBe(3)
    const inf = applyFilter(s, r, { ...emptyFilter(), relationshipTypes: ['influenced'] })
    expect(inf.edges.map((e) => e.id).sort()).toEqual(['r1', 'r4'])
    expect(applyFilter(s, r, { ...emptyFilter(), tags: ['greek', 'modern'], tagMode: 'any' }).nodes.length).toBe(3)
    expect(applyFilter(s, r, { ...emptyFilter(), tags: ['ancient', 'greek'], tagMode: 'all' }).nodes.length).toBe(2)
  })

  it('restricts to a neighbourhood', () => {
    const { s, r } = fixture()
    const one = applyFilter(s, r, { ...emptyFilter(), roots: ['plato'], depth: 1 })
    expect(one.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'plato', 'republic'])
    // The checklists still decide what is drawn: a root of a type left unticked stays out, its neighbours come along.
    const around = applyFilter(s, r, { ...emptyFilter(), roots: ['plato'], depth: 1, types: ['major work'] })
    expect(around.nodes.map((n) => n.id)).toEqual(['republic'])
    const two = applyFilter(s, r, { ...emptyFilter(), roots: ['plato'], depth: 2 })
    expect(two.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'ethics', 'kant', 'plato', 'republic'])
  })

  it('prunes by degree and caps by connectivity', () => {
    const { s, r } = fixture()
    expect(applyFilter(s, r, { ...emptyFilter(), hideIsolated: true }).nodes.some((n) => n.id === 'island')).toBe(false)
    expect(applyFilter(s, r, { ...emptyFilter(), minDegree: 2 }).nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'plato'])
    const capped = applyFilter(s, r, { ...emptyFilter(), maxNodes: 2 })
    expect(capped.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'plato'])
    expect(capped.truncated).toBe(4)
    expect(capped.edges.map((e) => e.id)).toEqual(['r1'])
  })

  it('brings included nodes in past the checklists and the neighbourhood, but not past the hidden list', () => {
    const { s, r } = fixture()
    // Only philosophers — plus the Republic, added by hand: it comes with its edge to Plato.
    const added = applyFilter(s, r, { ...emptyFilter(), types: ['philosopher'], include: ['republic', 'layout1', 'nothing'] })
    expect(added.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'kant', 'plato', 'republic'])
    expect(added.edges.map((e) => e.id).sort()).toEqual(['r1', 'r2', 'r4'])
    // Outside a neighbourhood too.
    const hood = applyFilter(s, r, { ...emptyFilter(), roots: ['plato'], depth: 1, include: ['kant'] })
    expect(hood.nodes.map((n) => n.id).sort()).toEqual(['aristotle', 'kant', 'plato', 'republic'])
    // Hidden wins over added.
    expect(applyFilter(s, r, { ...emptyFilter(), types: ['philosopher'], include: ['republic'], exclude: ['republic'] }).nodes.some((n) => n.id === 'republic')).toBe(false)
  })

  it('describes itself', () => {
    expect(describeFilter(emptyFilter())).toBe('Everything')
    expect(describeFilter({ ...emptyFilter(), types: ['a'], text: 'x', hideIsolated: true })).toBe('1 type · “x” · no isolated')
    expect(describeFilter({ ...emptyFilter(), include: ['a', 'b'] })).toBe('2 added')
  })
})

describe('layouts', () => {
  const { s, r } = fixture()
  const slice = applyFilter(s, r, emptyFilter())

  it('every algorithm places every node, deterministically', () => {
    for (const info of LAYOUTS) {
      for (const dims of info.dims) {
        const params = { ...DEFAULT_LAYOUT_PARAMS, dimensions: dims, iterations: 50 }
        const a = computeLayout(info.id, slice, params)
        const b = computeLayout(info.id, slice, params)
        expect(Object.keys(a).length, info.id).toBe(slice.nodes.length)
        expect(a, `${info.id} ${dims}D deterministic`).toEqual(b)
        for (const id in a) {
          expect(Number.isFinite(a[id].x) && Number.isFinite(a[id].y), `${info.id} finite`).toBe(true)
          if (dims === 3 && info.id !== 'layered') expect(a[id].z, `${info.id} has z`).toBeDefined()
        }
      }
    }
  })

  it('a lean slice lays out exactly like the full one, weights included (what the worker receives)', () => {
    const weighted = { ...slice, edges: slice.edges.map((e, i) => ({ ...e, data: { ...e.data, strength: i + 1 } })) }
    for (const weightField of [undefined, 'data.strength']) {
      const params = { ...DEFAULT_LAYOUT_PARAMS, iterations: 50, weightField }
      const leanParams = { ...params, weightField: weightField ? 'data.weight' : undefined }
      for (const alg of ['force', 'layered', 'clusters-by-type'] as const) {
        expect(computeLayout(alg, leanSlice(weighted, weightField), leanParams), `${alg} ${weightField}`).toEqual(computeLayout(alg, weighted, params))
      }
    }
    const lean = leanSlice(weighted)
    expect(Object.keys(lean.nodes[0])).toEqual(['id', 'type'])
    expect(lean.edges[0].data).toEqual({ weight: 1 })
    expect(isHeavyLayout('force', HEAVY_LAYOUT_NODES)).toBe(true)
    expect(isHeavyLayout('force', HEAVY_LAYOUT_NODES - 1)).toBe(false)
    expect(isHeavyLayout('circular', 1e6)).toBe(false)
    // Overlap removal is the slow part of an instant layout: with it on, a big 2D view goes to the worker whatever the algorithm.
    expect(isHeavyLayout('circular', HEAVY_LAYOUT_NODES, { noverlap: true, dimensions: 2 })).toBe(true)
    expect(isHeavyLayout('radial-by-type', HEAVY_LAYOUT_NODES - 1, { noverlap: true, dimensions: 2 })).toBe(false)
    expect(isHeavyLayout('circular', 1e6, { noverlap: false, dimensions: 2 })).toBe(false)
    expect(isHeavyLayout('circular', 1e6, { noverlap: true, dimensions: 3 })).toBe(false)
  })

  it('force layouts refine previous positions rather than restart', () => {
    const params = { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 as const, iterations: 100 }
    const first = computeLayout('force', slice, params)
    const again = computeLayout('force', slice, { ...params, iterations: 1 }, first)
    for (const id in first) expect(Math.hypot(again[id].x - first[id].x, again[id].y - first[id].y)).toBeLessThan(50)
  })

  it('resolvePositions keeps saved spots and places newcomers beside them', () => {
    const params = { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 as const }
    const saved = { plato: { x: 0, y: 0 }, aristotle: { x: 10, y: 0 } }
    const { positions, unplaced } = resolvePositions(slice, saved, 'grid', params)
    expect(unplaced).toBe(4)
    expect(positions.plato).toEqual({ x: 0, y: 0 })
    expect(Object.keys(positions).length).toBe(6)
    const b = bounds(positions)
    expect(positions.kant.x).toBeGreaterThan(10)
    expect(b.maxX).toBeGreaterThan(10)
    expect(resolvePositions(slice, undefined, 'circular', params).unplaced).toBe(0)
  })

  it('rejects nothing: unknown algorithm ids are a type error, not a runtime one', () => {
    expect(() => computeLayout('grid' as LayoutAlgorithm, { ...slice, nodes: [], edges: [] }, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 })).not.toThrow()
  })
})

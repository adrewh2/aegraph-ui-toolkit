import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { datasetGraph, datasetKeyOf } from '../dataset'
import { applyFilter, emptyFilter } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { describePipeline, renderingUsesMetrics, ruleUsesMetrics, type PipelineInput } from '../pipeline'
import { buildProject, isProject, projectBreadcrumb, projectMembers, projectOverlay } from '../project'
import { DEFAULT_RENDERING, toRenderingSpec } from '../rendering'
import { GRAPH_TYPES } from '../types'
import '../types'

/**
 * The last three of core/graph at their edges: the dataset graph hiding
 * the schema and project categories and keeping edges only among what it
 * shows, a member set restricting nodes and edges, a key that ignores
 * order and notices any id; a project built with and without metrics,
 * values holding only finite numbers, provenance, members with the
 * relationships, breadcrumbs through parents and round a cycle, look-alike
 * entities; and the pipeline's stages, flags and notes in every state.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', label: 'A' }),
    createEntity({ id: 'b', type: 'paper', label: 'B' }),
    createEntity({ id: 'c', type: 'note', label: 'C' }),
    schemaTypeEntity('paper', { color: '#123456' }),
    createEntity({ id: 'proj', type: GRAPH_TYPES.project, label: 'P', data: { members: ['a'] } }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b' }),
    createRelationship({ id: 'bc', type: 'cites', source: 'b', target: 'c' }),
    createRelationship({ id: 'ap', type: 'in', source: 'a', target: 'proj' }),
  ])
  return { s, registry: new TypeRegistry(s) }
}

describe('the dataset graph', () => {
  it('hides schema and project entities, keeps edges only among what it shows, and honours a member set on nodes and edges', () => {
    const { s, registry } = fixture()
    const g = datasetGraph(s, registry)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
    expect(g.edges.map((e) => e.id).sort()).toEqual(['ab', 'bc']) // a→proj leaves with the project
    const m = datasetGraph(s, registry, new Set(['a', 'b', 'ab', 'proj']))
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(m.edges.map((e) => e.id)).toEqual(['ab'])
    // Members naming both ends but not the relationship: the edge is not drawn.
    expect(datasetGraph(s, registry, new Set(['a', 'b'])).edges).toEqual([])
    expect(datasetGraph(new EntityStore(), registry)).toEqual({ nodes: [], edges: [] })
  })

  it('keys a graph by its ids whatever their order, and changes with any id, node or edge', () => {
    const g = { nodes: [{ id: 'x' }, { id: 'y' }], edges: [{ id: 'e1' }] }
    const same = datasetKeyOf({ nodes: [...g.nodes].reverse(), edges: g.edges })
    expect(datasetKeyOf(g)).toBe(same)
    expect(datasetKeyOf(g)).toMatch(/^dataset:2:1:[0-9a-f]+$/)
    expect(datasetKeyOf({ nodes: [{ id: 'x' }, { id: 'z' }], edges: g.edges })).not.toBe(same)
    expect(datasetKeyOf({ nodes: g.nodes, edges: [{ id: 'e2' }] })).not.toBe(same)
    expect(datasetKeyOf({ nodes: g.nodes, edges: [] })).not.toBe(same)
    // A node id and an edge id that read the same are not the same thing.
    expect(datasetKeyOf({ nodes: [{ id: 'q' }], edges: [] })).not.toBe(datasetKeyOf({ nodes: [], edges: [{ id: 'q' }] }))
    expect(datasetKeyOf({ nodes: [], edges: [] })).toBe('dataset:0:0:0')
  })
})

describe('projects', () => {
  it('builds a project from a view with its relationships, only the finite metric values of its members, and the provenance given', () => {
    const { s, registry } = fixture()
    const slice = applyFilter(s, registry, { ...emptyFilter(), types: ['paper'] })
    expect(slice.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    const bare = buildProject('Bare', slice, undefined)
    expect(isProject(bare)).toBe(true)
    expect(bare.data.members).toEqual(['a', 'b', 'ab'])
    expect(bare.data.values).toBeUndefined()
    expect(bare.data.summary).toEqual({ nodes: 2, edges: 1, metrics: [] })
    expect(bare.meta.source).toBe('user')
    expect(projectOverlay(bare)).toBeUndefined()
    expect([...projectMembers(bare)].sort()).toEqual(['a', 'ab', 'b'])
    // Metrics computed over a wider slice: only the members' rows are kept, rounded, and NaN columns left out.
    const whole = applyFilter(s, registry, emptyFilter())
    const m = computeMetrics(serializeSlice(whole), { metrics: ['degree', 'pagerank'] })
    m.columns.pagerank![0] = NaN // the first node's PageRank is unknown
    const p = buildProject('Ranked', slice, m, { parentProjectId: bare.id, filterId: 'f1', analysisId: 'an' }, 'assistant')
    expect(p.data.summary?.metrics).toEqual(['degree', 'pagerank'])
    expect(Object.keys(p.data.values!).sort()).toEqual(['a', 'b'])
    const first = m.ids[0]
    expect(p.data.values![first].pagerank).toBeUndefined()
    expect(typeof p.data.values![first].degree).toBe('number')
    expect(p.data).toMatchObject({ parentProjectId: bare.id, filterId: 'f1', analysisId: 'an' })
    expect(p.data.layoutId).toBeUndefined()
    expect(p.meta.source).toBe('assistant')
    expect(projectOverlay(p)!.get('a')).toEqual(p.data.values!.a)
    // Metrics present but with no column: no values at all, no metric names.
    const empty = buildProject('Empty', slice, { ...m, columns: {} })
    expect(empty.data.values).toBeUndefined()
    expect(empty.data.summary?.metrics).toEqual([])
  })

  it('recognises a project only by kind, type and a members list, and walks breadcrumbs through parents and round a cycle', () => {
    const { s } = fixture()
    expect(isProject(undefined)).toBe(false)
    expect(isProject(s.get('a'))).toBe(false)
    expect(isProject(createEntity({ type: GRAPH_TYPES.project, label: 'no members', data: {} }))).toBe(false)
    expect(isProject(createEntity({ type: GRAPH_TYPES.project, label: 'members', data: { members: [] } }))).toBe(true)
    expect(isProject(createRelationship({ type: GRAPH_TYPES.project, source: 'a', target: 'b', data: { members: [] } }))).toBe(false)
    const root = buildProject('Root', { nodes: [], edges: [] }, undefined)
    const mid = buildProject('Mid', { nodes: [], edges: [] }, undefined, { parentProjectId: root.id })
    const leaf = buildProject('Leaf', { nodes: [], edges: [] }, undefined, { parentProjectId: mid.id })
    s.upsertMany([root, mid, leaf])
    expect(projectBreadcrumb(s, leaf.id).map((b) => b.label)).toEqual(['Library', 'Root', 'Mid', 'Leaf'])
    expect(projectBreadcrumb(s, undefined)).toEqual([{ label: 'Library' }])
    expect(projectBreadcrumb(s, 'nope')).toEqual([{ label: 'Library' }])
    // A parent that is missing ends the chain; a cycle is walked once.
    const orphan = buildProject('Orphan', { nodes: [], edges: [] }, undefined, { parentProjectId: 'gone' })
    s.upsert(orphan)
    expect(projectBreadcrumb(s, orphan.id).map((b) => b.label)).toEqual(['Library', 'Orphan'])
    s.update(root.id, { data: { ...root.data, parentProjectId: leaf.id } })
    expect(projectBreadcrumb(s, leaf.id).map((b) => b.label)).toEqual(['Library', 'Root', 'Mid', 'Leaf'])
  })
})

describe('the pipeline description', () => {
  const base = (): PipelineInput => ({
    dataset: { source: 'workspace', label: 'Library', nodes: 30, edges: 40, breadcrumb: ['Library'] },
    filter: emptyFilter(),
    view: { nodes: 12, edges: 9 },
    layout: { algorithm: 'force', positions: 12, dirty: false },
    rendering: DEFAULT_RENDERING,
    analysis: { stale: false, running: false, auto: false },
  })
  it('describes a plain state with nothing flagged', () => {
    const p = describePipeline(base())
    expect(p.stages.map((s) => s.id)).toEqual(p.order)
    expect(p.stages.map((s) => s.summary)).toEqual(['Library · 30 nodes', 'Everything · 12 nodes', 'force · 12 positions', 'Default style', 'not run', 'view → project'])
    expect(p.stages.every((s) => !s.usesMetrics && !s.stale && s.notes.length === 0)).toBe(true)
    expect(p.feedback).toBe(false)
    expect(p.notes).toEqual([])
  })

  it('flags a layout rule or a style channel that reads metrics, stale or absent, and says so', () => {
    const { s, registry } = fixture()
    const m = computeMetrics(serializeSlice(applyFilter(s, registry, emptyFilter())), { metrics: ['degree'] })
    const rule = { kind: 'placement' as const, selector: { sort: 'metric.degree' }, spec: { arrangement: 'grid' as const, region: { of: 'viewport' as const } } }
    expect(ruleUsesMetrics(rule)).toBe(true)
    expect(ruleUsesMetrics({ ...rule, selector: { fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }] } })).toBe(true)
    expect(ruleUsesMetrics({ ...rule, selector: {}, spec: { ...rule.spec, x: 'data.year' } })).toBe(false)
    // Absent metrics: stale with a note.
    const missing = describePipeline({ ...base(), layout: { algorithm: 'force', positions: 1, dirty: false, rule } })
    expect(missing.stages.find((x) => x.id === 'layout')).toMatchObject({ usesMetrics: true, stale: true, notes: ['The layout rule needs metrics that have not been computed.'] })
    expect(missing.feedback).toBe(true)
    expect(missing.notes[0]).toContain('export a project')
    // Fresh metrics: used, not stale, no note.
    const fresh = describePipeline({ ...base(), layout: { algorithm: 'force', positions: 1, dirty: false, rule }, analysis: { metrics: m, stale: false, running: false, auto: false } })
    expect(fresh.stages.find((x) => x.id === 'layout')).toMatchObject({ usesMetrics: true, stale: false, notes: [] })
    expect(fresh.stages.find((x) => x.id === 'analysis')?.summary).toBe('degree')
    expect(fresh.stages.find((x) => x.id === 'export')?.summary).toBe('view + analysis → project')
    // A style channel on a metric, in an edge scope or a tag scope, counts too; a constant channel does not.
    const edgeStyle = toRenderingSpec({ edges: { types: { cites: { width: { mode: 'ranking', attr: { kind: 'field', key: 'w' }, min: 1, max: 2 } } } }, nodes: { tags: { hot: { size: { mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 1, max: 9 } } } } })
    expect(renderingUsesMetrics(edgeStyle)).toBe(true)
    expect(renderingUsesMetrics(toRenderingSpec({ nodes: { default: { color: { mode: 'constant', value: '#000' } } } }))).toBe(false)
    const staleStyle = describePipeline({ ...base(), rendering: edgeStyle, analysis: { metrics: m, stale: true, running: false, auto: true } })
    expect(staleStyle.stages.find((x) => x.id === 'style')).toMatchObject({ usesMetrics: true, stale: true, notes: [] })
    expect(staleStyle.stages.find((x) => x.id === 'analysis')).toMatchObject({ stale: true, summary: 'degree · stale', notes: ['Re-runs automatically when the view changes.'] })
    expect(staleStyle.feedback).toBe(true)
  })

  it('notes a filter that names a metric, and shows an analysis that is running', () => {
    const p = describePipeline({ ...base(), filter: { ...emptyFilter(), fields: [{ path: 'metric.betweenness', op: 'gte', value: 0.1 }, { path: 'degree', op: 'gt', value: 2 }] }, analysis: { stale: false, running: true, auto: false } })
    const filter = p.stages.find((x) => x.id === 'filter')!
    expect(filter.notes).toHaveLength(1)
    expect(filter.notes[0]).toContain('metric.betweenness')
    expect(filter.summary).toBe('metric.betweenness ≥ 0.1 · degree > 2 · 12 nodes') // predicates read as symbols
    expect(p.notes).toEqual(filter.notes)
    expect(p.feedback).toBe(false)
    expect(p.stages.find((x) => x.id === 'analysis')?.summary).toBe('running…')
    expect(describePipeline({ ...base(), dataset: { source: 'project', label: 'Thesis', nodes: 5, edges: 2, breadcrumb: ['Library', 'Thesis'] } }).stages[0].summary).toBe('Thesis · 5 nodes')
  })
})

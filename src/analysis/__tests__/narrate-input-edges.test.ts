import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../core/entity/entity'
import { EntityStore } from '../../core/entity/store'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { createProject } from '../../core/projects/project'
import '../../core/resources/types'
import '../../core/graph/types'
import { buildAnalysisInput } from '../../features/analysis/buildInput'
import { narrate } from '../narrate'
import { runAnalyses } from '../run'
import { analysisInfo, type Finding, type Report } from '../types'

/**
 * The narrator at its edges: an empty report, one finding, findings
 * with no entities or no visual, very long titles and Markdown
 * characters passed through untouched, the order of sections, the caps
 * on the headline list and per analysis, a run with a note. Then the
 * input builder: an entity of no type, relationships to missing ends
 * and among graph types, a project scope, dates that are not ISO, empty
 * data values, the key's stability across a label edit against an
 * added node or edge, and the schema's declared flag.
 */
const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'anomalies:x', analysis: 'anomalies', title: 'Something', detail: 'Because.', score: 0.5, ...over })
const report = (over: Partial<Report> = {}): Report => ({ computedAt: '2026-09-18T00:00:00Z', key: 'k', scope: { label: 'Scope' }, nodes: 1234, edges: 5678, runs: [], findings: [], metrics: [], ms: 1234, ...over })

describe('narrate edges', () => {
  it('an empty report is one line; a run with nothing shows its note or a default; sections come in run order after the headlines', () => {
    expect(narrate(report())).toBe('**Scope** — 1,234 entities, 5,678 relationships; 0 analyses in 1.2 s.')
    const r = report({ runs: [{ id: 'temporal', ms: 1, findings: [], note: 'No dates.' }, { id: 'schema', ms: 1, findings: [] }] })
    expect(narrate(r).split('\n')).toEqual([
      '**Scope** — 1,234 entities, 5,678 relationships; 2 analyses in 1.2 s.',
      '',
      `**Activity over time** · _${analysisInfo('temporal').question}_`,
      '- No dates.',
      '',
      `**Ontology in use** · _${analysisInfo('schema').question}_`,
      '- Nothing stood out.',
    ])
    expect(narrate(report({ ms: 0 }))).toContain('in 0.0 s')
    expect(narrate(report({ ms: 61_250 }))).toContain('in 61.3 s')
    expect(narrate(report({ nodes: 0, edges: 0 }))).toContain('0 entities, 0 relationships')
  })

  it('one finding heads the list and its analysis; no entities and no visual change nothing; a visual is named in italics; the caps on headlines and per analysis hold', () => {
    const f = finding({ visual: { kind: 'plot', title: 'A chart', spec: { traces: [] } } as Finding['visual'] })
    const r = report({ runs: [{ id: 'anomalies', ms: 1, findings: [f] }], findings: [f] })
    const md = narrate(r)
    expect(md).toContain('**Most interesting**\n\n- Something. Because. _(plot: A chart)_')
    expect(md).toContain('**Outliers and gaps**')
    expect(md.match(/- Something\. Because\./g)?.length).toBe(2)
    const many = Array.from({ length: 9 }, (_, i) => finding({ id: `anomalies:f${i}`, title: `F${i}` }))
    const big = report({ runs: [{ id: 'anomalies', ms: 1, findings: many }], findings: many })
    const lines = narrate(big).split('\n')
    expect(lines.filter((l) => l.startsWith('- F')).length).toBe(5 + 4)
    expect(narrate(big, { top: 2, perAnalysis: 1 }).split('\n').filter((l) => l.startsWith('- F')).length).toBe(3)
    expect(narrate(big, { top: 0 })).not.toContain('Most interesting')
  })

  it('titles of any length and Markdown characters in them pass through as they are; the narrator does not escape', () => {
    const long = 'x'.repeat(5000)
    const f = finding({ title: long, detail: '*bold* [link](x) <b>html</b> | pipe' })
    const md = narrate(report({ findings: [f] }))
    expect(md).toContain(long)
    expect(md).toContain('*bold* [link](x) <b>html</b> | pipe')
    expect(md).toContain(`- ${long}. *bold*`)
  })
})

describe('buildAnalysisInput edges', () => {
  it('an entity whose type is the empty string keeps it; relationships to missing ends and among graph types are left out; empty, null, blank and empty-list values are not properties; base keys are skipped', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'a', type: '', label: 'A', data: { s: '', n: null, u: undefined, l: [], keep: 0, also: false, label: 'base key', list: [1] } }),
      createEntity({ id: 'b', type: 'note', label: '' }),
      createEntity({ id: 'l', type: 'layout', data: { positions: {} } }),
      createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'a-gone', type: 'r', source: 'a', target: 'gone' }),
      createRelationship({ id: 'a-l', type: 'r', source: 'a', target: 'l' }),
    ])
    const input = buildAnalysisInput(store, new TypeRegistry(store))
    expect(input.ids).toEqual(['a', 'b'])
    expect(input.types).toEqual(['', 'note']) // an explicit empty type is kept as written (only a missing one becomes "entity")
    expect(input.labels[1]).toBe('b') // a blank label shows as the id
    expect([...input.props[0]].sort()).toEqual(['also', 'keep', 'list'])
    expect(input.edgeIds).toEqual(['ab'])
    expect([input.src[0], input.dst[0]]).toEqual([0, 1])
    expect(input.scope).toEqual({ label: 'Library', projectId: undefined })
    expect(input.schema.map((t) => t.type)).not.toContain('layout')
    expect(input.schema.find((t) => t.type === 'note')?.declared).toBe(true) // a built-in type
    expect(input.schema.find((t) => t.type === '')).toBeDefined() // and the registry lists it as a type in use
  })

  it('dates that are not ISO are NaN, a missing meta date too; a project scope narrows the input and names it; the key changes with a node or an edge but not with a label edit', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'a', type: 'note', label: 'A', meta: { createdAt: 'yesterday', updatedAt: '' } }),
      createEntity({ id: 'b', type: 'note', label: 'B', meta: { createdAt: '2024-05-01', updatedAt: '2024-05-01T10:00:00+02:00' } }),
      createEntity({ id: 'c', type: 'note', label: 'C' }),
      createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c' }),
    ])
    const registry = new TypeRegistry(store)
    const all = buildAnalysisInput(store, registry)
    expect(Number.isNaN(all.created[0])).toBe(true)
    expect(Number.isNaN(all.updated[0])).toBe(true)
    expect(all.created[1]).toBe(Date.parse('2024-05-01'))
    expect(all.updated[1]).toBe(Date.parse('2024-05-01T08:00:00Z'))
    const key1 = all.key
    store.update('a', { label: 'A renamed', description: 'more' })
    expect(buildAnalysisInput(store, registry).key).toBe(key1)
    store.upsert(createEntity({ id: 'd', type: 'note', label: 'D' }))
    const key2 = buildAnalysisInput(store, registry).key
    expect(key2).not.toBe(key1)
    store.upsert(createRelationship({ id: 'cd', type: 'r', source: 'c', target: 'd' }))
    expect(buildAnalysisInput(store, registry).key).not.toBe(key2)
    store.remove('cd')
    expect(buildAnalysisInput(store, registry).key).toBe(key2)
    // A project scope: only its members and the relationships among them; the scope is named.
    store.upsert(createProject({ id: 'proj', label: 'Mine' }))
    store.mark(['a', 'b'], 'proj')
    store.setScope('proj')
    const scoped = buildAnalysisInput(store, new TypeRegistry(store))
    expect(scoped.ids).toEqual(['a', 'b'])
    expect(scoped.edgeIds).toEqual(['ab'])
    expect(scoped.scope).toEqual({ label: 'Mine', projectId: 'proj' })
    expect(scoped.key).not.toBe(key2)
    // The whole thing runs end to end on that scope and narrates.
    const { report: rep } = runAnalyses(scoped, ['schema'])
    expect(rep.scope.label).toBe('Mine')
    expect(narrate(rep)).toMatch(/^\*\*Mine\*\* — 2 entities, 1 relationships; 1 analyses/)
    store.setScope(null)
  })
})

import { describe, expect, it } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createProject } from '../../../core/projects/project'
import { createScriptTools } from '../scriptTools'
import type { AppHost } from '../tools'

/** The script tool's `schema` action: what the dataset holds, as a script sees it, for an agent about to write one. */
describe('script schema', () => {
  it('lists the project, the types with their properties (kind, coverage, sample), the relationship types and what they join, the tags', async () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['reviewed'], data: { born: 1815, email: 'ada@x' } }),
      createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912 } }),
      createEntity({ id: 'w1', type: 'paper', label: 'Notes', data: { year: 1843 } }),
      createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
    ])
    store.upsert(createProject({ id: 'proj', label: 'Papers' }))
    store.mark(['p1', 'p2', 'w1'], 'proj')
    store.setScope('proj')
    const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
    const t = createScriptTools(host).find((x) => x.name === 'script') as BetaRunnableTool
    const r = JSON.parse(String(await t.run(t.parse({ action: 'schema' }))))
    expect(r.project).toEqual({ id: 'proj', label: 'Papers' })
    expect([r.entities, r.relationships]).toEqual([3, 1])
    expect(r.types.map((x: { type: string; count: number }) => [x.type, x.count])).toEqual([['person', 2], ['paper', 1]])
    expect(r.types[0].properties).toEqual([
      { key: 'born', kind: 'number', coverage: 1, sample: '1815' },
      { key: 'email', kind: 'string', coverage: 0.5, sample: 'ada@x' },
    ])
    expect(r.relationshipTypes).toEqual([{ type: 'wrote', count: 1, joins: ['person → paper'] }])
    expect(r.tags).toEqual(['reviewed'])
    expect(r.metrics).toEqual([])
    expect(r.hint).toMatch(/ds\.describe\(\)/)
  })
})

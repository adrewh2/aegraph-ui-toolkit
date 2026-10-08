import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { createDiagnosticsTools } from '../diagnosticsTools'
import { withInputChecks } from '../validate'
import type { AppHost } from '../tools'

/**
 * app_diagnostics over a store in node: the counts, the bytes by type
 * ordered heaviest first, which data key makes a type heavy, the
 * heaviest single entities capped by `top`, and — with no DOM and no
 * Chrome heap — no memory figure and nothing mounted.
 */
function setup() {
  const store = new EntityStore()
  const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
  const t = withInputChecks(createDiagnosticsTools(host).find((x) => x.name === 'app_diagnostics') as BetaRunnableTool)
  const run = async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  return { store, run }
}

describe('app_diagnostics', () => {
  it('weighs the store by type, names the heavy keys and the heaviest entities, and reports nothing mounted', async () => {
    const { store, run } = setup()
    const long = 'x'.repeat(20_000)
    store.upsertMany([
      createEntity({ id: 'd1', type: 'document', label: 'Big', data: { extension: 'md', content: long } }),
      createEntity({ id: 'd2', type: 'document', label: 'Small', data: { extension: 'md', content: 'hi' } }),
      createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: 1815 } }),
      createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912 } }),
      createRelationship({ id: 'r1', type: 'wrote', source: { id: 'p1' }, target: { id: 'd1' } }),
    ])
    const r = await run({ top: 2 })
    expect(r.memory).toBeUndefined()
    // No persistence attached in node: nothing to report about saving.
    expect(r.saving).toBeNull()
    expect(r.store).toMatchObject({ entities: 4, relationships: 1 })
    expect(r.store.estimatedMB).toBeGreaterThanOrEqual(0)
    // Heaviest type first; the document's weight is its content.
    expect(r.types[0].type).toBe('document')
    expect(r.types[0]).toMatchObject({ kind: 'entity', count: 2 })
    expect(r.types[0].heaviestKeys[0].key).toBe('content')
    expect(r.types[0].heaviestKeys[0].share).toBeGreaterThan(0.9)
    expect(r.types[0].meanBytes).toBeGreaterThan(10_000)
    expect(r.types.map((t: { type: string }) => t.type)).toHaveLength(2)
    expect(r.heaviestEntities).toHaveLength(2)
    expect(r.heaviestEntities[0]).toMatchObject({ id: 'd1', type: 'document', label: 'Big' })
    expect(r.heaviestEntities[0].kb).toBeGreaterThanOrEqual(19)
    expect(r.mounted).toEqual({ hosts: [], keptPages: [], canvases: 0 })
  })

  it('relationship types are weighed too, and a bounded sample still scales to the whole type', async () => {
    const { store, run } = setup()
    const people = Array.from({ length: 60 }, (_, i) => createEntity({ id: `p${i}`, type: 'person', label: `P${i}`, data: { note: 'n'.repeat(100) } }))
    store.upsertMany([...people, ...people.slice(1).map((p, i) => createRelationship({ id: `r${i}`, type: 'knows', source: { id: 'p0' }, target: { id: p.id } }))])
    const r = await run({ sample: 10, top: 5 })
    const person = r.types.find((t: { type: string }) => t.type === 'person')
    const knows = r.types.find((t: { type: string }) => t.type === 'knows')
    expect(person).toMatchObject({ count: 60, kind: 'entity' })
    expect(person.meanBytes).toBeGreaterThan(100)
    expect(knows).toMatchObject({ count: 59, kind: 'relationship' })
    expect(r.heaviestEntities.length).toBeLessThanOrEqual(5)
  })

  it('checks its arguments', async () => {
    const { run } = setup()
    await expect(run({ top: 0 })).rejects.toThrow(/top/)
    await expect(run({ sample: 3 })).rejects.toThrow(/sample/)
    await expect(run({ extra: 1 })).rejects.toThrow(/extra/)
  })
})

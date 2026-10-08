import { describe, expect, it, vi } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { ConstraintEngine } from '../../../core/constraints/engine'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { createProject } from '../../../core/projects/project'
import { createConstraintTools } from '../constraintTools'
import type { AppHost } from '../tools'

/**
 * The constraint tool end to end: templates rendered from params, graph
 * scope, project scoping and enable/disable, user templates, script-backed
 * constraints in the audit, and the wording an agent gets back.
 */

vi.mock('../../scripts/runner', () => ({
  runScript: async (_store: unknown, _registry: unknown, code: string) => {
    // A stand-in sandbox: the code names its verdict.
    if (code.includes('FAIL')) return { value: [{ id: 'w2', message: 'flagged by script' }], logs: [], ms: { load: 0, run: 1, snapshot: 0 } }
    if (code.includes('TABLE')) return { value: { table: { columns: ['id', 'message'], rows: [['w1', 'from a table']] } }, logs: [], ms: { load: 0, run: 1, snapshot: 0 } }
    if (code.includes('THROW')) return { value: undefined, logs: [], error: { message: 'boom' }, ms: { load: 0, run: 1, snapshot: 0 } }
    return { value: true, logs: [], ms: { load: 0, run: 1, snapshot: 0 } }
  },
}))

function setup() {
  const store = new EntityStore()
  store.setGuard(new ConstraintEngine(store).guard)
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: 1815 } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes' }),
    createEntity({ id: 'w2', type: 'paper', label: 'Orphan' }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
  ])
  const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = createConstraintTools(host)
  const t = tools.find((x) => x.name === 'constraint') as BetaRunnableTool
  const run = async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  return { store, run }
}

describe('constraint tool', () => {
  it('lists templates with their parameter forms and defines a constraint from one', async () => {
    const { store, run } = setup()
    const t = await run({ action: 'templates' })
    const atLeast = t.templates.find((x: { id: string }) => x.id === 'at-least')
    expect(atLeast.scope).toBe('graph')
    expect(atLeast.paramsSchema.required).toEqual(['type', 'rel', 'dir', 'n'])
    expect(atLeast.params.map((p: { kind: string }) => p.kind)).toEqual(['type', 'relationship', 'enum', 'number'])
    const d = await run({ action: 'define', template: 'at-least', params: { type: 'paper', rel: 'wrote', dir: 'in', n: 1 } })
    expect(d.defined).toMatchObject({ label: 'every paper has ≥ 1 wrote', scope: 'graph', template: 'at-least', params: { type: 'paper', rel: 'wrote', dir: 'in', n: 1 }, project: 'library', inForce: true, watches: 'the whole graph' })
    expect(d.audit.violations.map((v: { entity: string }) => v.entity)).toEqual(['Orphan (paper)'])
    // A new paper without an author is refused by the store; a graph violation already there does not block others.
    expect(() => store.upsert(createEntity({ id: 'w3', type: 'paper', label: 'Three' }))).toThrow(/needs at least 1 wrote/)
    store.upsert(createEntity({ id: 'p2', type: 'person', label: 'Alan' }))
    expect(store.has('p2')).toBe(true)
    // Bad parameters are named.
    await expect(run({ action: 'define', template: 'at-least', params: { type: 'paper' } })).rejects.toThrow(/Relationship.*required/)
    await expect(run({ action: 'define', template: 'nope' })).rejects.toThrow(/No template/)
  })

  it('scopes a constraint to a project on define and update, and enables / disables it', async () => {
    const { store, run } = setup()
    const proj = createProject({ id: 'proj', label: 'Papers' })
    store.upsert(proj)
    const d = await run({ action: 'define', label: 'born', applies: { types: ['person'] }, rule: { required: ['data.born'] }, project: 'Papers' })
    expect(d.defined.project).toEqual([{ id: 'proj', label: 'Papers' }])
    expect(d.defined.inForce).toBe(true)
    // Not in force with another project open.
    store.upsert(createProject({ id: 'other', label: 'Other' }))
    store.setScope('other')
    expect((await run({ action: 'list' })).constraints[0].inForce).toBe(false)
    expect((await run({ action: 'list' })).scope).toEqual({ id: 'other', label: 'Other' })
    // A Library constraint defined while a project is open stays in the Library.
    const lib = await run({ action: 'define', label: 'labelled', rule: { required: ['label'] }, project: 'library' })
    expect(lib.defined.project).toBe('library')
    expect(lib.defined.inForce).toBe(true)
    // Without `project`, it belongs to the open project.
    const mine = await run({ action: 'define', label: 'mine', rule: { required: ['label'] } })
    expect(mine.defined.project).toEqual([{ id: 'other', label: 'Other' }])
    // Move it to the Library; then disable and enable.
    expect((await run({ action: 'update', id: mine.defined.id, project: 'library' })).updated.project).toBe('library')
    expect((await run({ action: 'disable', id: mine.defined.id })).updated).toMatchObject({ enabled: false, inForce: false })
    expect((await run({ action: 'enable', id: mine.defined.id })).updated).toMatchObject({ enabled: true, inForce: true })
    await expect(run({ action: 'define', label: 'x', rule: { required: ['label'] }, project: 'Nowhere' })).rejects.toThrow(/No project/)
  })

  it('a user template: defined over MCP, rendered with params, re-rendered on update, deleted', async () => {
    const { run } = setup()
    const t = await run({ action: 'define_template', label: 'Born after', scope: 'entity', code: "get('data.born') >= params.year || 'born too early'", param_specs: [{ name: 'type', kind: 'type' }, { name: 'year', kind: 'number' }], applies: { types: ['{{type}}'] }, label_pattern: '{{type}} born after {{year}}' })
    expect(t.defined).toMatchObject({ builtin: false, scope: 'entity', params: [{ name: 'type', kind: 'type' }, { name: 'year', kind: 'number' }] })
    expect((await run({ action: 'templates' })).templates.map((x: { id: string }) => x.id)).toContain(t.defined.id)
    const c = await run({ action: 'define', template: t.defined.id, params: { type: 'person', year: 1900 } })
    expect(c.defined).toMatchObject({ label: 'person born after 1900', watches: 'entities and relationships of type person', rule: 'a JavaScript check' })
    expect(c.audit.violations.map((v: { message: string }) => v.message)).toEqual(['born too early'])
    const u = await run({ action: 'update', id: c.defined.id, params: { year: 1800 } })
    expect(u.updated.params).toEqual({ type: 'person', year: 1800 })
    expect((await run({ action: 'audit' })).violations).toBe(0)
    const del = await run({ action: 'delete_template', id: t.defined.id })
    expect(del.note).toMatch(/1 constraint made from it/)
    await expect(run({ action: 'delete_template', id: 'required' })).rejects.toThrow(/Built-in/)
  })

  it('a script-backed constraint is judged by the audit, from a list, a table, or an error', async () => {
    const { store, run } = setup()
    store.upsert(createEntity({ id: 's1', type: 'script', label: 'authors', data: { code: '// FAIL', language: 'js' } }))
    store.upsert(createEntity({ id: 's2', type: 'script', label: 'tabled', data: { code: '# TABLE', language: 'python' } }))
    store.upsert(createEntity({ id: 's3', type: 'script', label: 'broken', data: { code: '// THROW', language: 'js' } }))
    const d = await run({ action: 'define', label: 'by script', scope: 'graph', rule: { script: 's1' }, severity: 'warn' })
    expect(d.defined.rule).toBe('a script (audited)')
    expect(d.audit).toMatch(/script-backed/)
    await run({ action: 'define', label: 'by table', scope: 'graph', rule: { script: 's2' } })
    await run({ action: 'define', label: 'by broken', scope: 'graph', rule: { script: 's3' } })
    await expect(run({ action: 'define', label: 'no script', scope: 'graph', rule: { script: 'nope' } })).rejects.toThrow(/No script/)
    const a = await run({ action: 'audit' })
    expect(a.list.map((v: { constraint: string; entity: string; message: string }) => [v.constraint, v.entity, v.message])).toEqual([
      ['by script', 'Orphan (paper)', 'flagged by script'],
      ['by table', 'Notes (paper)', 'from a table'],
      ['by broken', 'the graph', 'the script failed: boom'],
    ])
    expect(a.scripted.map((r: { script: string; error?: string }) => [r.script, r.error])).toEqual([['s1', undefined], ['s2', undefined], ['s3', 'boom']])
    // Scripts do not run at write time: check says so.
    const c = await run({ action: 'check', entity: { type: 'paper', label: 'New' } })
    expect(c.accepted).toBe(true)
    expect(c.note).toMatch(/audit/)
    // Only violations on the asked-for types.
    expect((await run({ action: 'audit', types: ['person'] })).list.map((v: { constraint: string }) => v.constraint)).toEqual(['by broken'])
  })

  it('a hand-written graph rule and check against it', async () => {
    const { run } = setup()
    const d = await run({ action: 'define', label: 'few papers', scope: 'graph', rule: { js: "count(ofType('paper')) <= params.max || 'too many papers'" }, params: { max: 2 } })
    expect(d.defined.scope).toBe('graph')
    const c = await run({ action: 'check', entity: { type: 'paper', label: 'Third' } })
    expect(c.accepted).toBe(false)
    expect(c.violations.map((v: { message: string }) => v.message)).toEqual(['too many papers'])
    expect(c.inForce).toEqual(['few papers'])
    const bad = await run({ action: 'define', label: 'broken', scope: 'graph', rule: { js: 'not (valid' } })
    expect(bad.error).toMatch(/does not compile/)
  })
})

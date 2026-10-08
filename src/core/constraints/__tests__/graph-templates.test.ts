import { describe, expect, it, beforeAll, vi } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity, EntityId } from '../../entity/types'
import { EntityStore, GuardRejection } from '../../entity/store'
import { createConstraint, inForce } from '../constraint'
import { ConstraintEngine } from '../engine'
import { compileGraphRule, findCycle, graphVerdict, overlay } from '../rules'
import { BUILTIN_TEMPLATES, coerceParams, createTemplate, effectiveRule, findTemplate, instantiate, listTemplates, paramsSchema } from '../templates'
import { loadRuleRealm } from '../realm'

beforeAll(() => loadRuleRealm())

/**
 * Graph-scoped constraints (one rule over the whole dataset, the write
 * laid on top), templates (built-in and user-defined, rendered from
 * parameters), params bound in rules, and project scoping.
 */

const setup = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: 1815 } }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912 } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes' }),
    createEntity({ id: 'w2', type: 'paper', label: 'Orphan paper' }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
    createEntity({ id: 'f1', type: 'folder', label: 'a' }),
    createEntity({ id: 'f2', type: 'folder', label: 'b' }),
    createRelationship({ id: 'pa', type: 'parent', source: 'f1', target: 'f2' }),
  ])
  const engine = new ConstraintEngine(store)
  store.setGuard(engine.guard)
  return { store, engine }
}

describe('graph rules', () => {
  it('the overlay lays a write over the store: replaced, added, and relationships moved', () => {
    const { store } = setup()
    const others = new Map<EntityId, AnyEntity>([
      ['p1', createEntity({ id: 'p1', type: 'person', label: 'Ada L.' })],
      ['p3', createEntity({ id: 'p3', type: 'person', label: 'New' })],
      ['r1', createRelationship({ id: 'r1', type: 'wrote', source: 'p2', target: 'w1' })],
    ])
    const v = overlay(store, others)
    expect(v.entity('p1')?.label).toBe('Ada L.')
    expect(v.ofType('person').map((e) => e.id).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(v.relationshipsOf('p1', 'out')).toEqual([])
    expect(v.relationshipsOf('p2', 'out').map((r) => r.id)).toEqual(['r1'])
    expect(v.all().length).toBe(store.all().length + 1)
    expect(overlay(store, new Map()).all()).toBe(store.all())
  })

  it('finds a cycle through one relationship type, and none where there is none', () => {
    const { store } = setup()
    expect(findCycle(overlay(store, new Map()), 'parent')).toBeUndefined()
    const cyc = new Map<EntityId, AnyEntity>([['pb', createRelationship({ id: 'pb', type: 'parent', source: 'f2', target: 'f1' })]])
    expect(findCycle(overlay(store, cyc), 'parent')).toEqual(['f1', 'f2', 'f1'])
    expect(findCycle(overlay(store, cyc), 'wrote')).toBeUndefined()
  })

  it('a verdict: true passes; false or a string is one unnamed violation; a list names entities', () => {
    expect(graphVerdict(true)).toEqual([])
    expect(graphVerdict(undefined)).toEqual([])
    expect(graphVerdict(false)).toEqual([{ message: 'the check returned false' }])
    expect(graphVerdict('bad')).toEqual([{ message: 'bad' }])
    expect(graphVerdict([{ id: 'x', message: 'm' }, 'plain', createEntity({ id: 'y', type: 't' }), null])).toEqual([
      { id: 'x', message: 'm' },
      { message: 'plain' },
      { id: 'y', message: 'flagged by the check' },
    ])
    expect(graphVerdict({ violations: [{ id: 'z', message: 'q' }] })).toEqual([{ id: 'z', message: 'q' }])
    expect(graphVerdict(42)).toEqual([{ message: 'the check returned 42' }])
  })

  it('the graph vocabulary walks the overlaid dataset and binds params', () => {
    const { store } = setup()
    const rule = compileGraphRule("ofType(params.type).filter((x) => !inn(x, 'wrote').length).map((x) => violation(x, 'no author'))")
    expect(graphVerdict(rule({ store, others: new Map(), params: { type: 'paper' } }))).toEqual([{ id: 'w2', message: 'no author' }])
    const fix = new Map<EntityId, AnyEntity>([['r2', createRelationship({ id: 'r2', type: 'wrote', source: 'p2', target: 'w2' })]])
    expect(graphVerdict(rule({ store, others: fix, params: { type: 'paper' } }))).toEqual([])
    expect(compileGraphRule("types()")({ store, others: new Map() })).toEqual(['folder', 'paper', 'person'])
    expect(compileGraphRule("relTypes()")({ store, others: new Map() })).toEqual(['parent', 'wrote'])
    expect(compileGraphRule("count(neighbors('p1', 'wrote')) === 1 && degree('w2') === 0")({ store, others: new Map() })).toBe(true)
  })

  it('a rejecting graph constraint blames the entities it names in the write; one naming none fails the whole write', () => {
    const { store, engine } = setup()
    store.upsert(createConstraint({ label: 'acyclic', scope: 'graph', rule: { js: "const c = cycle('parent'); return c ? c.map((id) => violation(id, 'cycle')) : true" } }))
    expect(engine.active().map((c) => c.scope)).toEqual(['graph'])
    // A relationship closing the cycle is named (its ends are, and the write's own entities are what is blamed) → rejected.
    const closing = createRelationship({ id: 'pb', type: 'parent', source: 'f2', target: 'f1' })
    const r = engine.check([closing], { previous: (id) => store.get(id) })
    expect(r.violations.map((v) => v.entityId)).toEqual(['f1', 'f2', 'f1'])
    // The cycle names f1 and f2, which are not in the write → the whole write is refused.
    expect(r.rejected.map((e) => e.id)).toEqual(['pb'])
    expect(() => store.upsert(closing)).toThrow(GuardRejection)
    expect(store.has('pb')).toBe(false)
    // A rule that names entities of the write drops just those.
    store.upsert(createConstraint({ label: 'no empty labels in the batch', scope: 'graph', rule: { js: "others().filter((o) => !o.label).map((o) => violation(o, 'unlabelled'))" } }))
    const good = createEntity({ id: 'g', type: 'person', label: 'Good' })
    const bad = createEntity({ id: 'b', type: 'person' })
    const r2 = engine.check([good, bad])
    expect(r2.accepted.map((e) => e.id)).toEqual(['g'])
    expect(r2.rejected.map((e) => e.id)).toEqual(['b'])
    // A warning graph constraint reports and lets the write in.
    store.upsert(createConstraint({ label: 'few papers', scope: 'graph', severity: 'warn', rule: { js: "count(ofType('paper')) <= 2 || 'too many papers'" } }))
    const r3 = engine.check([createEntity({ id: 'w3', type: 'paper', label: 'Third' })])
    expect(r3.accepted.length).toBe(1)
    expect(r3.violations.map((v) => [v.severity, v.message, v.entity])).toEqual([['warn', 'too many papers', 'the graph']])
  })

  it('the audit runs graph rules over the store as it stands, and a broken rule reports once', () => {
    const { store, engine } = setup()
    store.upsert(createConstraint({ label: 'authored', scope: 'graph', rule: { js: "ofType('paper').filter((x) => !inn(x, 'wrote').length).map((x) => violation(x, 'no author'))" } }))
    store.upsert(createConstraint({ label: 'broken', scope: 'graph', rule: { js: 'this is not (javascript' } }))
    const a = engine.audit()
    expect(a.violations.map((v) => [v.constraint, v.entity])).toEqual([
      ['authored', 'Orphan paper (paper)'],
      ['broken', 'the graph'],
    ])
    expect(a.violations[1].message).toMatch(/does not compile/)
    expect(engine.audit({ types: ['person'] }).violations.map((v) => v.constraint)).toEqual(['broken'])
  })

  it('a bookkeeping write never runs a graph rule; a scripted constraint is left to the audit', () => {
    const { store, engine } = setup()
    // A rule cannot write to the host (it runs in the QuickJS realm), so count its runs by the store reads it makes.
    store.upsert(createConstraint({ label: 'counts', scope: 'graph', rule: { js: 'types(); return true' } }))
    store.upsert(createConstraint({ label: 'scripted', scope: 'graph', rule: { script: 'some-script' } }))
    expect(engine.scripted().map((c) => c.entity.label)).toEqual(['scripted'])
    expect(engine.graphRules().map((c) => c.entity.label)).toEqual(['counts'])
    const reads = vi.spyOn(store, 'all')
    const p1 = store.get('p1')!
    engine.check([{ ...p1, meta: { ...p1.meta, accessedAt: 'now' } }], { previous: (id) => store.get(id) })
    expect(reads).not.toHaveBeenCalled()
    engine.check([createEntity({ id: 'n', type: 'person', label: 'N' })])
    expect(reads).toHaveBeenCalled()
  })

  it('a violation already in the data never blocks an unrelated write; the write that introduces one is refused', () => {
    const { store, engine } = setup()
    // w2 has no author already: the rule is violated before anything is written.
    store.upsert(createConstraint({ label: 'authored', scope: 'graph', rule: { js: "ofType('paper').filter((x) => !inn(x, 'wrote').length).map((x) => violation(x, 'no author'))" } }))
    expect(engine.audit().violations.map((v) => v.entity)).toEqual(['Orphan paper (paper)'])
    // Unrelated writes go in.
    store.upsert(createEntity({ id: 'p9', type: 'person', label: 'Nine' }))
    expect(store.has('p9')).toBe(true)
    // A new paper without an author is what the rule is for.
    expect(() => store.upsert(createEntity({ id: 'w9', type: 'paper', label: 'Nine' }))).toThrow(/no author/)
    // …unless its author arrives in the same write.
    store.upsertMany([createEntity({ id: 'w9', type: 'paper', label: 'Nine' }), createRelationship({ id: 'r9', type: 'wrote', source: 'p9', target: 'w9' })])
    expect(store.has('w9') && store.has('r9')).toBe(true)
  })

  it('a graph rule taken out of force drops its baseline', () => {
    const { store, engine } = setup()
    const baselines = (engine as unknown as { baselines: Map<EntityId, unknown> }).baselines
    const rule = createConstraint({ label: 'authored', scope: 'graph', rule: { js: "ofType('paper').filter((x) => !inn(x, 'wrote').length).map((x) => violation(x, 'no author'))" } })
    store.upsert(rule)
    store.upsert(createEntity({ id: 'p9', type: 'person', label: 'Nine' }))
    expect(baselines.has(rule.id)).toBe(true)
    store.remove(rule.id)
    store.upsert(createEntity({ id: 'p10', type: 'person', label: 'Ten' }))
    expect(baselines.size).toBe(0)
  })

  it('an entity rule reads params', () => {
    const { store, engine } = setup()
    store.upsert(createConstraint({ label: 'born after', applies: { types: ['person'] }, rule: { js: "get('data.born') >= params.min || 'too early'" }, params: { min: 1900 } }))
    expect(engine.check([createEntity({ id: 'x', type: 'person', label: 'X', data: { born: 1850 } })]).violations.map((v) => v.message)).toEqual(['too early'])
    expect(engine.check([createEntity({ id: 'y', type: 'person', label: 'Y', data: { born: 1950 } })]).violations).toEqual([])
  })
})

describe('templates', () => {
  it('every built-in renders from its declared parameters into a rule that compiles', () => {
    const { store, engine } = setup()
    const sample: Record<string, Record<string, unknown>> = {
      required: { type: 'person', path: 'data.born' },
      unique: { type: 'person', path: 'label' },
      'label-pattern': { type: 'person', pattern: '^[A-Z]' },
      'value-in': { type: 'person', path: 'data.role', values: 'a, b' },
      range: { type: 'person', path: 'data.born', min: 1000, max: 2100 },
      'date-order': { type: 'person', before: 'data.born', after: 'data.died' },
      'relationship-ends': { rel: 'wrote', source: ['person'], target: ['paper'] },
      'no-self-links': { rel: 'wrote' },
      'at-most': { rel: 'wrote', end: 'target', n: 1 },
      'at-least': { type: 'paper', rel: 'wrote', dir: 'in', n: 1 },
      acyclic: { rel: 'parent' },
      'no-orphans': { type: 'paper' },
      'max-count': { type: 'paper', n: 10 },
      'declared-types': {},
      'declared-properties': { type: 'person' },
      'types-described': {},
    }
    expect(Object.keys(sample).sort()).toEqual(BUILTIN_TEMPLATES.map((t) => t.id).sort())
    for (const t of BUILTIN_TEMPLATES) {
      const r = instantiate(t, sample[t.id])
      expect(r.label, t.id).toBeTruthy()
      expect(Object.keys(r.rule).length, t.id).toBeGreaterThan(0)
      store.upsert(createConstraint({ label: r.label, applies: r.applies, rule: r.rule, scope: r.scope, template: t.id, params: r.params, message: r.message }))
    }
    expect(engine.active().filter((c) => c.jsError)).toEqual([])
    const a = engine.audit()
    const by = new Map<string, string[]>()
    for (const v of a.violations) by.set(v.constraint, [...(by.get(v.constraint) ?? []), v.entity])
    expect(by.get('every paper has ≥ 1 wrote')).toEqual(['Orphan paper (paper)'])
    expect(by.get('no orphan paper')).toEqual(['Orphan paper (paper)'])
    // No schema:type entities: every type in use is undeclared; person carries `born` undeclared.
    expect(by.get('every type in use is declared')?.length).toBe(3)
    expect(by.get('person carries only declared properties')?.length).toBe(2)
    expect(by.get('parent is acyclic')).toBeUndefined()
  })

  it('coerces and checks parameters', () => {
    const t = findTemplate(new EntityStore(), 'range')!
    expect(() => instantiate(t, { type: 'person' })).toThrow(/Property.*required/)
    expect(() => instantiate(t, { type: 'person', path: 'data.x' })).toThrow(/minimum, a maximum/)
    expect(instantiate(t, { type: 'person', path: 'data.x', min: '5' }).params).toEqual({ type: 'person', path: 'data.x', min: 5 })
    expect(() => coerceParams([{ name: 'n', kind: 'number' }], { n: 'x' })).toThrow(/must be a number/)
    expect(() => coerceParams([{ name: 'e', kind: 'enum', options: ['a'] }], { e: 'b' })).toThrow(/one of a/)
    expect(coerceParams([{ name: 'ts', kind: 'types' }], { ts: 'a, b' })).toEqual({ ts: ['a', 'b'] })
    expect(coerceParams([{ name: 'ts', kind: 'types', required: false }], {})).toEqual({})
    expect(paramsSchema(t.params)).toEqual({ type: 'object', properties: expect.objectContaining({ min: expect.objectContaining({ type: 'number' }), type: expect.objectContaining({ type: 'string' }) }), required: ['type', 'path'] })
  })

  it('a user template is an entity: its code follows into every constraint made from it, and editing it changes them', () => {
    const { store, engine } = setup()
    const t = createTemplate({ label: 'Born after', scope: 'entity', params: [{ name: 'type', kind: 'type' }, { name: 'year', kind: 'number' }], code: "get('data.born') >= params.year || 'born too early'", applies: { types: ['{{type}}'] }, labelPattern: '{{type}} born after {{year}}' })
    store.upsert(t)
    expect(listTemplates(store).map((x) => x.id)).toContain(t.id)
    const r = instantiate(findTemplate(store, t.id)!, { type: 'person', year: '1900' })
    expect(r).toMatchObject({ label: 'person born after 1900', applies: { types: ['person'] }, rule: { js: t.data.code }, scope: 'entity', params: { type: 'person', year: 1900 } })
    const c = createConstraint({ label: r.label, applies: r.applies, rule: r.rule, scope: r.scope, template: t.id, params: r.params })
    store.upsert(c)
    expect(engine.check([createEntity({ id: 'x', type: 'person', label: 'X', data: { born: 1850 } })]).violations.map((v) => v.message)).toEqual(['born too early'])
    // Edit the template: constraints made from it follow.
    store.update(t.id, { data: { ...t.data, code: "get('data.born') >= params.year - 100 || 'far too early'" } })
    expect(effectiveRule(store, store.get(c.id) as typeof c).rule.js).toMatch(/far too early/)
    expect(engine.check([createEntity({ id: 'x', type: 'person', label: 'X', data: { born: 1850 } })]).violations).toEqual([])
    expect(engine.check([createEntity({ id: 'x', type: 'person', label: 'X', data: { born: 1750 } })]).violations.map((v) => v.message)).toEqual(['far too early'])
    // A user template expands a `types` parameter and works graph-scoped.
    const g = createTemplate({ label: 'Bounded', scope: 'graph', params: [{ name: 'types', kind: 'types' }, { name: 'n', kind: 'number' }], code: 'params.types.flatMap((t) => (count(ofType(t)) > params.n ? [`too many ${t}`] : []))' })
    store.upsert(g)
    const gr = instantiate(findTemplate(store, g.id)!, { types: 'person, paper', n: 1 })
    store.upsert(createConstraint({ label: gr.label, applies: gr.applies, rule: gr.rule, scope: gr.scope, template: g.id, params: gr.params }))
    expect(engine.audit().violations.map((v) => v.message)).toEqual(['too many person', 'too many paper'])
  })
})

describe('project scoping', () => {
  it('a constraint made in a project is in force there only; the Library’s applies everywhere; disabled is never in force', () => {
    const { store, engine } = setup()
    store.upsert(createEntity({ id: 'proj', type: 'project', label: 'P', data: {} }))
    store.upsert(createEntity({ id: 'other', type: 'project', label: 'Q', data: {} }))
    const lib = createConstraint({ label: 'lib', applies: { types: ['person'] }, rule: { required: ['data.born'] } })
    const mine = createConstraint({ label: 'mine', applies: { types: ['person'] }, rule: { required: ['data.died'] }, projects: ['proj'] })
    const off = createConstraint({ label: 'off', applies: { types: ['person'] }, rule: { required: ['label'] }, enabled: false })
    store.upsertMany([lib, mine, off])
    expect(inForce(lib, null) && inForce(lib, 'proj') && inForce(lib, 'other')).toBe(true)
    expect([inForce(mine, null), inForce(mine, 'proj'), inForce(mine, 'other')]).toEqual([true, true, false])
    expect(inForce(off, 'proj')).toBe(false)
    store.setScope('proj')
    expect(engine.active().map((c) => c.entity.label).sort()).toEqual(['lib', 'mine'])
    store.setScope('other')
    expect(engine.active().map((c) => c.entity.label)).toEqual(['lib'])
    store.setScope(null)
    expect(engine.active().map((c) => c.entity.label).sort()).toEqual(['lib', 'mine'])
    // Enabling / disabling takes a constraint in and out of force at once.
    store.update(off.id, { data: { ...off.data, enabled: true } })
    expect(engine.active().map((c) => c.entity.label).sort()).toEqual(['lib', 'mine', 'off'])
  })
})

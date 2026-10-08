import { describe, expect, it, beforeAll } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore, GuardRejection } from '../../entity/store'
import { createConstraint, describeApplies, describeRule } from '../constraint'
import { ConstraintEngine } from '../engine'
import { compileRule, helpersFor, verdict } from '../rules'
import { loadRuleRealm } from '../realm'

beforeAll(() => loadRuleRealm())

/**
 * The constraints at their edges: a rule on a type nobody has; required
 * against present-but-empty values of every kind; uniqueness across a
 * case difference, an update of the same entity, twins in one write,
 * numbers against strings; relationship rules with a subtype at an end,
 * ends in the same write, self-links and per-end caps; a JavaScript
 * check that throws, returns a non-boolean, or does not compile; a bad
 * label pattern; the audit over nothing, over an entity failing three
 * rules, and its limit; disabled rules; the order of messages and the
 * message prefix; a bookkeeping touch of an entity that would fail.
 */
const guarded = () => {
  const store = new EntityStore()
  const engine = new ConstraintEngine(store)
  store.setGuard(engine.guard)
  return { store, engine }
}
const messages = (fn: () => unknown) => {
  try {
    fn()
    return []
  } catch (err) {
    if (err instanceof GuardRejection) return err.violations.map((v) => v.message)
    throw err
  }
}

describe('constraints edges', () => {
  it('a rule on a type nobody has watches nothing; required fails on "", null and [] but passes 0, false, {} and a blank string; forbidden is the mirror', () => {
    const { store, engine } = guarded()
    store.upsert(createConstraint({ label: 'ghost', applies: { types: ['unicorn'] }, rule: { required: ['label'] } }))
    store.upsert(createEntity({ id: 'n', type: 'note' }))
    expect(engine.audit().checked).toBe(0)
    store.upsert(createConstraint({ label: 'has x', applies: { types: ['thing'] }, rule: { required: ['data.x'], forbidden: ['data.y'] } }))
    const thing = (id: string, data: Record<string, unknown>) => createEntity({ id, type: 'thing', label: id, data })
    for (const [name, x] of Object.entries({ empty: '', nil: null, list: [] })) expect(messages(() => store.upsert(thing(name, { x }))), name).toEqual(['data.x is required'])
    for (const [name, x] of Object.entries({ zero: 0, no: false, obj: {}, blank: '  ' })) expect(messages(() => store.upsert(thing(name, { x }))), name).toEqual([])
    expect(messages(() => store.upsert(thing('y', { x: 1, y: 0 })))).toEqual(['data.y must not be set'])
    expect(messages(() => store.upsert(thing('y2', { x: 1, y: '' })))).toEqual([])
    expect(messages(() => store.upsert(thing('both', { y: [1] })))).toEqual(['data.x is required', 'data.y must not be set'])
  })

  it('unique: a case difference is a different value, an entity may keep its own value on update, the second twin in one write is dropped, a number and its spelling collide, another type does not count', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'unique labels', applies: { types: ['person'] }, rule: { unique: ['label', 'data.n'] } }))
    const p = (id: string, label: string, n?: unknown) => createEntity({ id, type: 'person', label, data: n === undefined ? {} : { n } })
    store.upsert(p('a', 'Ada', 1))
    expect(messages(() => store.upsert(p('b', 'ada')))).toEqual([])
    expect(messages(() => store.upsert(p('c', 'Ada')))).toEqual(['label must be unique: "Ada" is already on Ada (person)'])
    expect(messages(() => store.upsert(p('a', 'Ada', 1)))).toEqual([]) // itself
    expect(messages(() => store.upsert(p('d', 'Dee', '1')))).toEqual(['data.n must be unique: "1" is already on Ada (person)'])
    expect(messages(() => store.upsert(createEntity({ id: 'w', type: 'work', label: 'Ada' })))).toEqual([])
    store.upsertMany([p('t1', 'Twin'), p('t2', 'Twin'), p('t3', 'Twin')])
    expect(store.has('t1')).toBe(true)
    expect(store.has('t2')).toBe(false)
    expect(store.has('t3')).toBe(false)
    // An empty value is never a clash.
    expect(messages(() => store.upsertMany([p('e1', ''), p('e2', '')]))).toEqual([])
  })

  it('relationship rules: an end of a subtype is not the allowed type (types are matched by name), ends in the same write count, self-links and per-end caps, missing ends', () => {
    const { store } = guarded()
    store.upsertMany([createEntity({ id: 'p', type: 'person', label: 'P' }), createEntity({ id: 's', type: 'student', label: 'S' }), createEntity({ id: 'w', type: 'work', label: 'W' }), createEntity({ id: 'w2', type: 'work', label: 'W2' })])
    store.upsert(createConstraint({ label: 'wrote', applies: { kinds: ['relationship'], types: ['wrote'] }, rule: { ends: { source: ['person'], target: ['work'], noSelf: true, maxPerSource: 1, maxPerTarget: 1, endsExist: true } } }))
    const rel = (id: string, source: string, target: string) => createRelationship({ id, type: 'wrote', source, target })
    expect(messages(() => store.upsert(rel('r1', 'p', 'w')))).toEqual([])
    expect(messages(() => store.upsert(rel('r2', 's', 'w2')))).toEqual(['source must be person, not student'])
    expect(messages(() => store.upsert(rel('r3', 'p', 'w2')))).toEqual(['P (person) would have 2 wrote relationships; at most 1 allowed'])
    expect(messages(() => store.upsert(rel('r1', 'p', 'w')))).toEqual([]) // the same relationship again is not a second one
    expect(messages(() => store.upsert(rel('r4', 'w', 'w')))).toEqual(['source must be person, not work', 'an entity may not link to itself', 'W (work) would be the target of 2 wrote relationships; at most 1 allowed'])
    expect(messages(() => store.upsert(rel('r5', 'p', 'nope')))).toEqual(['target nope does not exist', 'P (person) would have 2 wrote relationships; at most 1 allowed'])
    // Ends in the same write are seen.
    store.upsertMany([createEntity({ id: 'p2', type: 'person', label: 'P2' }), createEntity({ id: 'w3', type: 'work', label: 'W3' }), rel('r6', 'p2', 'w3')])
    expect(store.has('r6')).toBe(true)
    // sameType, and a rule that only applies to relationships never sees an entity.
    store.upsert(createConstraint({ label: 'peers', applies: { kinds: ['relationship'], types: ['peer'] }, rule: { ends: { sameType: true } } }))
    expect(messages(() => store.upsert(createRelationship({ id: 'pe', type: 'peer', source: 'p', target: 'w' })))).toEqual(['both ends must be of the same type (person → work)'])
    expect(messages(() => store.upsert(createEntity({ id: 'peer-entity', type: 'peer', label: 'x' })))).toEqual([])
  })

  it('a JavaScript check that throws fails with the error; a non-boolean, non-string result passes; a rule that does not compile fails everything it applies to with the reason; so does a bad label pattern', () => {
    const { store } = guarded()
    const thing = (id: string, data: Record<string, unknown> = {}) => createEntity({ id, type: 'thing', label: id, data })
    store.upsert(createConstraint({ label: 'js', applies: { types: ['thing'] }, rule: { js: `if (get('data.boom')) throw new Error('kaboom'); return get('data.v')` } }))
    expect(messages(() => store.upsert(thing('t0', { boom: true })))).toEqual(['the JavaScript check threw: kaboom'])
    for (const v of [0, null, undefined, '', 1, 'ok?', {}, []]) {
      // Only false or a non-empty string fail; every other value passes — a string is a message.
      const expected = v === 'ok?' ? ['ok?'] : []
      expect(messages(() => store.upsert(thing(`v-${JSON.stringify(v) ?? 'undefined'}`, { v }))), JSON.stringify(v)).toEqual(expected)
    }
    expect(messages(() => store.upsert(thing('f', { v: false })))).toEqual(['the check returned false'])
    store.upsert(createConstraint({ label: 'broken', applies: { types: ['thing'] }, rule: { js: 'this is not javascript (' } }))
    expect(messages(() => store.upsert(thing('any', { v: true })))).toEqual([expect.stringMatching(/^the JavaScript check does not compile: /)])
    store.upsert(createConstraint({ label: 'pattern', applies: { types: ['other'] }, rule: { labelPattern: '[unclosed' } }))
    expect(messages(() => store.upsert(createEntity({ id: 'o', type: 'other', label: 'x' })))).toEqual([expect.stringMatching(/^bad label pattern: /)])
    expect(verdict(false)).toBe('the check returned false')
    expect(verdict('')).toBeUndefined()
    expect(verdict(NaN)).toBeUndefined()
    expect(() => compileRule('return (')).toThrow(SyntaxError)
  })

  it('the audit over nothing checks nothing; an entity failing three rules reports three, in the constraints’ order, with the message prefix; the limit stops between entities, not within one', () => {
    const { store, engine } = guarded()
    expect(engine.audit()).toEqual({ checked: 0, violations: [] })
    store.upsert(createConstraint({ label: 'A', applies: { types: ['thing'] }, rule: { required: ['data.a'] }, message: 'needs a' }))
    expect(engine.audit()).toEqual({ checked: 0, violations: [] })
    store.upsert(createEntity({ id: 't', type: 'thing', label: 'T' }), { unchecked: true })
    store.upsert(createConstraint({ label: 'B', applies: { types: ['thing'] }, rule: { required: ['data.b'], forbidden: ['label'] } }))
    store.upsert(createConstraint({ label: 'C', applies: { types: ['thing'] }, rule: { labelPattern: '^t' }, severity: 'warn' }))
    const r = engine.audit()
    expect(r.checked).toBe(1)
    expect(r.violations.map((v) => [v.constraint, v.severity, v.message])).toEqual([
      ['A', 'reject', 'needs a — data.a is required'],
      ['B', 'reject', 'data.b is required'],
      ['B', 'reject', 'label must not be set'],
      ['C', 'warn', 'label “T” does not match /^t/'],
    ])
    expect(engine.audit({ limit: 1 }).violations.length).toBe(4) // one entity's violations come whole
    expect(engine.audit({ types: ['other'] })).toEqual({ checked: 0, violations: [] })
    // Disabling a rule takes it out of the audit and the guard; enabling it again brings it back.
    const b = store.ofType('constraint').find((c) => c.label === 'B')!
    store.update(b.id, { data: { ...b.data, enabled: false } })
    expect(engine.audit().violations.map((v) => v.constraint)).toEqual(['A', 'C'])
    store.update(b.id, { data: { ...b.data, enabled: true } })
    expect(engine.audit().violations.map((v) => v.constraint)).toEqual(['A', 'B', 'B', 'C'])
    // A write that fails a rejecting rule and a warning one is dropped; the rejection carries only the rejecting messages (the warning went out through the event).
    const vs = messages(() => store.upsert(createEntity({ id: 'u', type: 'thing', label: 'U', data: { a: 1, b: 1 } })))
    expect(vs).toEqual(['label must not be set'])
  })

  it('an existing entity that would fail is left alone by a touch that changes nothing a rule sees, and rejected by one that does; a tag-scoped rule sees only tagged entities', () => {
    const { store } = guarded()
    store.upsert(createEntity({ id: 'old', type: 'thing', label: 'Old' }))
    store.upsert(createConstraint({ label: 'needs a', applies: { types: ['thing'] }, rule: { required: ['data.a'] } }))
    // The same entity object again: nothing material changed.
    expect(messages(() => store.upsert(store.get('old')!))).toEqual([])
    expect(messages(() => store.update('old', { label: 'Older' }))).toEqual(['data.a is required'])
    expect(store.get('old')!.label).toBe('Old')
    store.upsert(createConstraint({ label: 'hot ones', applies: { tags: ['hot'] }, rule: { required: ['data.temp'] } }))
    expect(messages(() => store.upsert(createEntity({ id: 'cold', type: 'x', label: 'c' })))).toEqual([])
    expect(messages(() => store.upsert(createEntity({ id: 'hot', type: 'x', label: 'h', tags: ['hot'] })))).toEqual(['data.temp is required'])
    expect(describeApplies({ tags: ['hot'] })).toBe('entities and relationships tagged hot')
    expect(describeApplies({ kinds: ['relationship'], types: ['wrote'] })).toBe('relationships of type wrote')
    expect(describeRule({})).toBe('no conditions')
    expect(describeRule({ ends: { maxPerSource: 0, endsExist: true } })).toBe('≤ 0 per source · both ends must exist')
  })

  it('the rule vocabulary: has/isEmpty on every empty kind, matches on non-strings, count of lists, sets and scalars, others without itself, unique seeing the same write', () => {
    const store = new EntityStore()
    const e = createEntity({ id: 'e', type: 't', label: 'E', tags: [], data: { s: '', n: 0, l: [], o: {} } })
    const twin = createEntity({ id: 'twin', type: 't', label: 'E' })
    const h = helpersFor(e, { store, others: new Map([[e.id, e], [twin.id, twin]]) }) as Record<string, (...a: unknown[]) => unknown>
    expect([h.has('data.s'), h.has('data.n'), h.has('data.l'), h.has('data.o'), h.has('tags'), h.has('nope')]).toEqual([false, true, false, true, false, false])
    expect([h.isEmpty(null), h.isEmpty(0), h.isEmpty([]), h.isEmpty([0])]).toEqual([true, false, true, false])
    expect([h.matches('data.n', /0/), h.matches('label', 'E'), h.matches('label', /^e$/i), h.matches('nope', /.*/)]).toEqual([false, true, true, false])
    expect([h.count([1, 2]), h.count(new Set([1])), h.count(new Map()), h.count('x'), h.count(null), h.count(0)]).toEqual([2, 1, 0, 1, 0, 0])
    expect((h.others() as { id: string }[]).map((o) => o.id)).toEqual(['twin'])
    expect(h.unique('label')).toBe(false) // the twin in the same write carries the same label
    expect(h.unique('data.s')).toBe(true) // empty is never a clash
    expect(h.fail('')).toBe('failed')
    expect(compileRule('has("label") || fail("no label")')(e, { store, others: new Map() })).toBe(true)
    expect(compileRule('if (!has("data.z")) return fail("no z")')(e, { store, others: new Map() })).toBe('no z')
  })
})

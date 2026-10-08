import { describe, expect, it, beforeAll } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore, GuardRejection } from '../../entity/store'
import { createConstraint, describeRule } from '../constraint'
import { ConstraintEngine } from '../engine'
import { loadRuleRealm } from '../realm'

beforeAll(() => loadRuleRealm())

const guarded = () => {
  const store = new EntityStore()
  const engine = new ConstraintEngine(store)
  store.setGuard(engine.guard)
  return { store, engine }
}

describe('constraint engine', () => {
  it('rejects an entity that fails a rejecting constraint, and says why', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'People have birth years', applies: { types: ['person'] }, rule: { required: ['data.born'], fields: [{ path: 'data.born', op: 'gte', value: 1000 }] } }))
    expect(() => store.upsert(createEntity({ id: 'p1', type: 'person', label: 'Ada' }))).toThrow(/data\.born is required/)
    expect(store.has('p1')).toBe(false)
    expect(() => store.upsert(createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 12 } }))).toThrow(/does not hold/)
    store.upsert(createEntity({ id: 'p3', type: 'person', label: 'Grace', data: { born: 1906 } }))
    expect(store.has('p3')).toBe(true)
    // Other types are not its business.
    store.upsert(createEntity({ id: 'w1', type: 'paper', label: 'Notes' }))
    expect(store.has('w1')).toBe(true)
  })

  it('drops the failing entities of a bulk write, keeps the rest, and reports through an event', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'Labelled', rule: { required: ['label'] }, applies: { kinds: ['entity'] } }))
    const events: string[] = []
    store.subscribe((ev) => events.push(ev.type === 'rejected' ? `rejected ${ev.rejected.join(',')}` : ev.type))
    store.upsertMany([createEntity({ id: 'a', type: 'note', label: 'A' }), createEntity({ id: 'b', type: 'note' }), createEntity({ id: 'c', type: 'note', label: 'C' })])
    expect(store.has('a') && store.has('c')).toBe(true)
    expect(store.has('b')).toBe(false)
    expect(events.some((e) => e === 'rejected b')).toBe(true)
  })

  it('a warning constraint lets the entity in and only reports', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'Describe things', severity: 'warn', rule: { required: ['description'] }, applies: { kinds: ['entity'], types: ['note'] } }))
    let warned = 0
    store.subscribe((ev) => ev.type === 'rejected' && (warned += ev.violations.length))
    store.upsert(createEntity({ id: 'n', type: 'note', label: 'N' }))
    expect(store.has('n')).toBe(true)
    expect(warned).toBe(1)
  })

  it('uniqueness, label patterns and relationship ends', () => {
    const { store } = guarded()
    store.upsertMany([
      createConstraint({ label: 'Unique person labels', applies: { types: ['person'] }, rule: { unique: ['label'], labelPattern: '^[A-Z]' } }),
      createConstraint({ label: 'Authorship joins a person to a paper', applies: { kinds: ['relationship'], types: ['wrote'] }, rule: { ends: { source: ['person'], target: ['paper'], noSelf: true, endsExist: true, maxPerTarget: 1 } } }),
    ])
    store.upsertMany([createEntity({ id: 'p1', type: 'person', label: 'Ada' }), createEntity({ id: 'w1', type: 'paper', label: 'Notes' })])
    expect(() => store.upsert(createEntity({ id: 'p2', type: 'person', label: 'Ada' }))).toThrow(/must be unique/)
    expect(() => store.upsert(createEntity({ id: 'p3', type: 'person', label: 'ada' }))).toThrow(/does not match/)
    // Two twins in one write: the second is the one refused.
    store.upsertMany([createEntity({ id: 'p4', type: 'person', label: 'Grace' }), createEntity({ id: 'p5', type: 'person', label: 'Grace' })])
    expect(store.has('p4')).toBe(true)
    expect(store.has('p5')).toBe(false)
    expect(() => store.upsert(createRelationship({ id: 'r1', type: 'wrote', source: 'w1', target: 'p1' }))).toThrow(/source must be person/)
    expect(() => store.upsert(createRelationship({ id: 'r2', type: 'wrote', source: 'p1', target: 'nobody' }))).toThrow(/does not exist/)
    store.upsert(createRelationship({ id: 'r3', type: 'wrote', source: 'p1', target: 'w1' }))
    expect(() => store.upsert(createRelationship({ id: 'r4', type: 'wrote', source: 'p4', target: 'w1' }))).toThrow(/at most 1/)
    // A relationship whose end arrives in the same write passes endsExist.
    store.upsertMany([createEntity({ id: 'w2', type: 'paper', label: 'More' }), createRelationship({ id: 'r5', type: 'wrote', source: 'p4', target: 'w2' })])
    expect(store.has('r5')).toBe(true)
  })

  it('runs a JavaScript check, and treats a throw as a failure', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'Born before death', applies: { types: ['person'] }, rule: { js: 'if (e.data.died !== undefined && e.data.died < e.data.born) return `died ${e.data.died} before born ${e.data.born}`; return true' } }))
    expect(() => store.upsert(createEntity({ id: 'p', type: 'person', label: 'X', data: { born: 1900, died: 1850 } }))).toThrow(/died 1850 before born 1900/)
    store.upsert(createConstraint({ label: 'Broken', applies: { types: ['person'] }, rule: { js: 'return e.data.nothing.at.all' } }))
    expect(() => store.upsert(createEntity({ id: 'q', type: 'person', label: 'Y', data: { born: 1900 } }))).toThrow(/threw/)
  })

  it('leaves existing entities alone unless a write changes what a rule sees; unchecked and volatile writes bypass', () => {
    const { store } = guarded()
    store.upsert(createEntity({ id: 'p1', type: 'person', label: 'Ada' }), { unchecked: true })
    store.upsert(createConstraint({ label: 'Birth year', applies: { types: ['person'] }, rule: { required: ['data.born'] } }))
    // A bookkeeping touch of an entity that would now fail: fine.
    store.touch('p1')
    expect(store.get('p1')?.meta.accessedAt).toBeDefined()
    // A material change is judged.
    expect(() => store.update('p1', { label: 'Ada L.' })).toThrow(/required/)
    store.update('p1', { data: { born: 1815 } })
    expect(store.get('p1')?.data.born).toBe(1815)
    // A disabled constraint is out of force.
    const c = store.ofType('constraint')[0]
    store.update(c.id, { data: { ...c.data, enabled: false } })
    store.upsert(createEntity({ id: 'p2', type: 'person', label: 'Alan' }))
    expect(store.has('p2')).toBe(true)
  })

  it('audits the data as it stands', () => {
    const { store, engine } = guarded()
    store.upsertMany([createEntity({ id: 'a', type: 'person', label: 'A' }), createEntity({ id: 'b', type: 'person', label: 'B', data: { born: 1 } })])
    store.upsert(createConstraint({ label: 'Birth year', applies: { types: ['person'] }, rule: { required: ['data.born'] } }))
    const r = engine.audit()
    expect(r.checked).toBe(2)
    expect(r.violations.map((v) => v.entityId)).toEqual(['a'])
    expect(describeRule({ required: ['data.born'], unique: ['label'] })).toBe('requires data.born · unique label')
  })

  it('a single rejected write throws a GuardRejection carrying the violations', () => {
    const { store } = guarded()
    store.upsert(createConstraint({ label: 'Labelled', rule: { required: ['label'] } }))
    try {
      store.upsert(createEntity({ id: 'x', type: 'note' }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(GuardRejection)
      expect((err as GuardRejection).violations[0]).toMatchObject({ constraint: 'Labelled', entityId: 'x', severity: 'reject' })
    }
  })
})

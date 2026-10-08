import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { importBundle } from '../../projects/bundle'
import { createProject } from '../../projects/project'
import { createConstraint, isConstraint } from '../constraint'
import { ConstraintEngine, WRITE_BUDGET_MS } from '../engine'
import { loadRuleRealm } from '../realm'
import { createTemplate } from '../templates'

/**
 * Constraints run on the page's thread before a write lands (security review, pass 6, finding 5): one write has a
 * budget for all of them, a constraint can always be switched off, and constraints that arrive in a bundle come in
 * switched off.
 */
beforeAll(() => loadRuleRealm())

const guarded = () => {
  const store = new EntityStore()
  const engine = new ConstraintEngine(store)
  store.setGuard(engine.guard)
  return { store, engine }
}
const LOOP = 'while (true) {} return true'

describe('the write budget', () => {
  it('a write spends at most the budget on checks; what does not fit is skipped with a warning, not a rejection', () => {
    const { store, engine } = guarded()
    store.upsert(createConstraint({ id: 'g1', label: 'Slow graph rule', scope: 'graph', rule: { js: LOOP } }))
    store.upsert(createConstraint({ id: 'g2', label: 'Another', scope: 'graph', rule: { js: LOOP } }))
    const t0 = performance.now()
    const r = engine.check([createEntity({ id: 'n1', type: 'note', label: 'N' })])
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(WRITE_BUDGET_MS + 400)
    expect(r.accepted.map((e) => e.id)).toEqual(['n1'])
    expect(r.violations.filter((v) => v.severity === 'warn').map((v) => v.constraintId).sort()).toEqual(['g1', 'g2'])
    expect(r.violations.every((v) => /not checked/.test(v.message))).toBe(true)
  }, 20_000)

  it('entity rules share the budget: after it, the rest are skipped', () => {
    const { store, engine } = guarded()
    for (let i = 0; i < 4; i++) store.upsert(createConstraint({ id: `e${i}`, label: `Loop ${i}`, severity: 'warn', applies: { types: ['note'] }, rule: { js: LOOP } }))
    const t0 = performance.now()
    const r = engine.check([createEntity({ id: 'n1', type: 'note', label: 'N' }), createEntity({ id: 'n2', type: 'note', label: 'N2' })])
    expect(performance.now() - t0).toBeLessThan(WRITE_BUDGET_MS + 400)
    expect(r.violations.some((v) => /not checked/.test(v.message))).toBe(true)
  }, 20_000)
})

describe('a constraint can always be switched off', () => {
  it('even one that rejects every write', () => {
    const { store } = guarded()
    // Entity-scoped and watching everything: it would reject the write that switches it off, being an entity itself.
    const c = createConstraint({ id: 'no', label: 'Nothing gets in', rule: { js: 'false' } })
    store.upsert(c)
    expect(() => store.upsert(createEntity({ id: 'n', type: 'note', label: 'N' }))).toThrow()
    store.upsert({ ...c, data: { ...c.data, enabled: false } })
    expect(isConstraint(store.get('no')) && store.get('no')!.data.enabled).toBe(false)
    store.upsert(createEntity({ id: 'n', type: 'note', label: 'N' }))
    expect(store.has('n')).toBe(true)
  })
})

describe('constraints from a bundle come in switched off', () => {
  // A bundle writes only its own project's entities: these name a project of the reader's that holds what they change.
  const bundle = (entities: unknown[]) => ({ $schema: 'aegraph/v1', exportedAt: '2026-01-01T00:00:00Z', project: 'shared', entities: [{ id: 'shared', type: 'project', label: 'Shared' }, ...entities] })
  // An open clamps a file's future dates to now: the clock moves on before each, so the file's copy is the newer one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())
  const open = (store: EntityStore, doc: unknown) => {
    vi.setSystemTime(Date.now() + 60_000)
    return importBundle(store, doc as never)
  }
  const inShared = (store: EntityStore, ...ids: string[]) => {
    if (!store.has('shared')) store.upsert(createProject({ id: 'shared', label: 'Shared' }))
    store.mark(ids, 'shared')
  }
  it('a new constraint, and a changed one, are off; an unchanged one keeps its owner’s switch', () => {
    const { store } = guarded()
    const mine = createConstraint({ id: 'mine', label: 'Labelled', rule: { required: ['label'] } })
    store.upsert(mine)
    inShared(store, 'mine')
    const later = (e: ReturnType<typeof createConstraint>) => ({ ...e, meta: { ...e.meta, updatedAt: '2099-01-01T00:00:00Z', source: 'user' } })
    open(store, bundle([
      later(createConstraint({ id: 'new', label: 'From the file', scope: 'graph', rule: { js: 'false' } })),
      later({ ...mine, data: { ...mine.data, rule: { js: 'false' } } } as ReturnType<typeof createConstraint>),
    ]))
    for (const id of ['new', 'mine']) {
      const c = store.get(id)
      expect(isConstraint(c) && c.data.enabled, id).toBe(false)
    }
    // Not in force: writes go through.
    store.upsert(createEntity({ id: 'free', type: 'note' }))
    expect(store.has('free')).toBe(true)
    // The same constraint again, unchanged, enabled by its owner meanwhile: the file does not switch it back off.
    const c = store.get('new')!
    store.upsert({ ...c, data: { ...c.data, enabled: true, rule: { required: ['label'] }, scope: undefined } } as never)
    const now = store.get('new')!
    open(store, bundle([{ ...now, data: { ...now.data, enabled: false }, meta: { ...now.meta, updatedAt: '2199-01-01T00:00:00Z' } }]))
    expect(isConstraint(store.get('new')) && store.get('new')!.data.enabled).toBe(true)
  })

  it('a template the file changes switches off the constraints that follow it', () => {
    const { store } = guarded()
    const t = createTemplate({ id: 'tpl', label: 'T', code: 'true', params: [] })
    store.upsert(t)
    store.upsert(createConstraint({ id: 'follows', label: 'Follows', template: 'tpl', rule: { js: 'true' } }))
    inShared(store, 'tpl')
    open(store, bundle([{ ...t, data: { ...t.data, code: 'false' }, meta: { ...t.meta, updatedAt: '2099-01-01T00:00:00Z' } }]))
    const c = store.get('follows')
    expect(isConstraint(c) && c.data.enabled).toBe(false)
  })
})

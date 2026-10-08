import { describe, expect, it, beforeAll } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import type { AnyEntity } from '../../entity/types'
import { compileRule, isBody, verdict } from '../rules'
import { loadRuleRealm } from '../realm'

beforeAll(() => loadRuleRealm())

const setup = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['reviewed'], data: { born: 1815, email: 'ada@x' } }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912, email: 'alan@x' } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes' }),
    createEntity({ id: 'w2', type: 'paper', label: 'More' }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
    createRelationship({ id: 'r2', type: 'wrote', source: 'p1', target: 'w2' }),
    createRelationship({ id: 'r3', type: 'cites', source: 'w2', target: 'w1' }),
  ])
  return store
}
const run = (store: EntityStore, code: string, id: string) => verdict(compileRule(code)(store.get(id)!, { store, others: new Map() }))

describe('rule expressions', () => {
  it('an expression passes on true and fails on false or a message; a return makes a body', () => {
    const store = setup()
    expect(isBody('has("label")')).toBe(false)
    expect(isBody('if (!has("label")) return "no"; return true')).toBe(true)
    expect(run(store, "has('data.born')", 'p1')).toBeUndefined()
    expect(run(store, "has('data.died')", 'p1')).toBe('the check returned false')
    expect(run(store, "has('data.died') || 'no death date'", 'p1')).toBe('no death date')
    expect(run(store, "if (get('data.born') < 1900) return fail('too old'); return true", 'p1')).toBe('too old')
  })

  it('reads paths, tags, and walks relationships', () => {
    const store = setup()
    expect(run(store, "get('data.email').endsWith('@x') && e.tags.includes('reviewed')", 'p1')).toBeUndefined()
    expect(run(store, "matches('label', /^A/)", 'p2')).toBeUndefined()
    expect(run(store, "out('wrote').length <= 1 || 'writes too much'", 'p1')).toBe('writes too much')
    expect(run(store, "count(neighbors('wrote')) === 2", 'p1')).toBeUndefined()
    expect(run(store, "neighbors().every((n) => n.type === 'paper')", 'p1')).toBeUndefined()
    expect(run(store, "inn('cites').length === 1", 'w1')).toBeUndefined()
    expect(run(store, "typeOf(source().id) === 'paper' && target().label === 'Notes'", 'r3')).toBeUndefined()
    expect(run(store, "unique('data.email')", 'p1')).toBeUndefined()
    expect(run(store, "ofType('person').length === 2 && store.has('w1')", 'p1')).toBeUndefined()
  })

  it('sees the rest of the same write', () => {
    const store = setup()
    const p3 = createEntity({ id: 'p3', type: 'person', label: 'Grace', data: { email: 'ada@x' } })
    const r4 = createRelationship({ id: 'r4', type: 'wrote', source: 'p3', target: 'w1' })
    const others = new Map<string, AnyEntity>([[p3.id, p3], [r4.id, r4]])
    expect(verdict(compileRule("unique('data.email')")(p3, { store, others }))).toBe('the check returned false')
    expect(verdict(compileRule("out('wrote').length === 1")(p3, { store, others }))).toBeUndefined()
    expect(verdict(compileRule("others().length === 1 && others()[0].type === 'wrote'")(p3, { store, others }))).toBeUndefined()
  })

  it('refuses code that does not parse', () => {
    expect(() => compileRule("has('label'")).toThrow()
  })
})

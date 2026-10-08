import { beforeAll, describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { createConstraint } from '../constraint'
import { ConstraintEngine } from '../engine'
import { compileGraphRule, compileRule, verdict } from '../rules'
import { loadRuleRealm } from '../realm'

beforeAll(() => loadRuleRealm())

const setup = () => {
  const store = new EntityStore()
  store.upsert(createEntity({ id: 'p1', type: 'person', label: 'Ada', data: { born: 1815 } }))
  return store
}

describe('a JavaScript check runs walled off from the host', () => {
  const probes = [
    "typeof process === 'undefined' && typeof globalThis.process === 'undefined'",
    "typeof fetch === 'undefined' && typeof XMLHttpRequest === 'undefined' && typeof WebSocket === 'undefined'",
    "typeof document === 'undefined' && typeof window === 'undefined' && typeof localStorage === 'undefined'",
    "typeof require === 'undefined' && typeof importScripts === 'undefined'",
    "(() => { const g = Function('return this')(); return typeof g.process === 'undefined' && typeof g.fetch === 'undefined' && typeof g.document === 'undefined' })()",
    "(() => { const g = (0, eval)('this'); return typeof g.process === 'undefined' && typeof g.setTimeout === 'undefined' })()",
    "(() => { const F = get.constructor; return typeof F('return typeof process')() === 'string' && F('return typeof process')() === 'undefined' })()",
  ]

  for (const code of probes) {
    it(`sees none of the host: ${code.slice(0, 60)}`, () => {
      const store = setup()
      // Every probe is an expression that must be exactly true (a body with no return would pass vacuously).
      expect(compileRule(`return (${code}) === true ? true : 'reached the host'`)(store.get('p1')!, { store, others: new Map() })).toBe(true)
      expect(compileGraphRule(`return (${code}) === true ? true : 'reached the host'`)({ store, others: new Map() })).toBe(true)
    })
  }

  it('gets copies: a rule that writes to e, a neighbour or the store changes nothing outside', () => {
    const store = setup()
    const e = store.get('p1')!
    const code = "e.label = 'hacked'; e.data.born = 0; const x = store.get('p1'); x.label = 'hacked'; store.get = null; return true"
    expect(verdict(compileRule(code)(e, { store, others: new Map() }))).toBeUndefined()
    expect(store.get('p1')!.label).toBe('Ada')
    expect(store.get('p1')!.data.born).toBe(1815)
    expect(typeof store.get).toBe('function')
  })

  it('a loop that never ends is stopped and fails the check with a message; the next rule runs normally', () => {
    const store = setup()
    const engine = new ConstraintEngine(store)
    store.upsert(createConstraint({ label: 'spins', applies: { types: ['person'] }, rule: { js: 'while (true) {} return true' } }))
    const t = performance.now()
    const r = engine.check([createEntity({ id: 'p2', type: 'person', label: 'Alan' })])
    expect(performance.now() - t).toBeLessThan(5000)
    expect(r.rejected.map((x) => x.id)).toEqual(['p2'])
    expect(r.violations[0].message).toMatch(/budget and was stopped/)
    expect(verdict(compileRule("has('label')")(store.get('p1')!, { store, others: new Map() }))).toBeUndefined()
  })

  it('a graph rule that loops is stopped too, and a rule that eats memory fails rather than taking the tab', () => {
    const store = setup()
    expect(() => compileGraphRule('for (;;) {} return true')({ store, others: new Map() })).toThrow(/budget and was stopped/)
    expect(() => compileRule("const a = []; for (;;) a.push('x'.repeat(1 << 20)); return true")(store.get('p1')!, { store, others: new Map() })).toThrow(/out of memory|budget/)
    expect(verdict(compileRule("get('data.born') === 1815")(store.get('p1')!, { store, others: new Map() }))).toBeUndefined()
  }, 30_000)

  it('a rule that does not parse is a SyntaxError at compile time', () => {
    expect(() => compileRule('return (')).toThrow(SyntaxError)
  })
})

import { describe, expect, it } from 'vitest'
import { Sandbox } from '../sandbox'
import type { Snapshot } from '../types'

/**
 * The warm context is shared between runs, so no run may change what the next one computes (security review, pass
 * 6, finding 2): an imported script that replaced a built-in, a prelude function or `ds` used to have every later
 * run of the owner's own scripts return what it chose.
 */
const snapshot = (): Snapshot => ({
  scope: { label: 'iso' },
  entities: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, type: i % 2 ? 'a' : 'b', label: `E${i}`, tags: [], data: { n: i }, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })),
  relationships: [{ id: 'r1', type: 'to', source: 'e0', target: 'e1', directed: true, data: {} }],
  tags: [{ tag: 't', count: 1 }],
})

/** The owner's script: a figure, a log line, a count. Its result must be the same after any attack. */
const HONEST = `log('n', entities.length); return figure(bar(entities.map((e) => e.id), entities.map((e) => e.data.n)), 'Counts')`

const ATTACKS: [string, string][] = [
  ['a built-in prototype', `Array.prototype.map = function () { return ['exfil'] }`],
  ['a built-in prototype by defineProperty', `Object.defineProperty(Array.prototype, 'map', { value: () => ['exfil'] })`],
  ['JSON.stringify', `JSON.stringify = () => '{"plot":{"data":[{"type":"bar"}],"layout":{"images":[{"source":"https://evil"}]}}}'`],
  ['a prelude function', `figure = () => ({ text: 'exfil' })`],
  ['a prelude function through globalThis', `globalThis.figure = () => ({ text: 'exfil' }); globalThis.bar = () => ({})`],
  ['ds', `globalThis.ds = { entities: [] }`],
  ['a collection method', `entities.constructor.prototype.map = () => ['exfil']`],
  ['Object.prototype', `Object.prototype.toJSON = function () { return 'exfil' }`],
  ['the log', `__logs.push = () => {}; Object.defineProperty(__logs, 'push', { value: () => {} })`],
  ['a global left for the next run', `globalThis.HONEST_HELPER = 1; Object.defineProperty(globalThis, 'stay', { value: 1, configurable: false })`],
  ['the tag rows', `ds.tags().push({ tag: 'x' }); ds.tags()[0].count = 99`],
  ['a computed metric column', `const c = ds.compute(['degree']).degree; c.e0 = 999`],
  ['an iterator prototype', `Object.getPrototypeOf([][Symbol.iterator]()).next = () => ({ done: true })`],
  ['the global object', `Object.preventExtensions(globalThis)`],
]

describe('a run cannot change the next run’s result', () => {
  it.each(ATTACKS)('%s', async (_name, attack) => {
    const sb = new Sandbox()
    await sb.load('iso', JSON.stringify(snapshot()))
    const before = await sb.run(HONEST)
    expect(before.error).toBeUndefined()
    // The attack may fail (frozen) or succeed within its own run: what matters is the run after.
    await sb.run(attack)
    const after = await sb.run(HONEST)
    expect(after.error).toBeUndefined()
    expect(after.value).toEqual(before.value)
    expect(after.logs).toEqual(before.logs)
    const deg = await sb.run(`return [ds.compute(['degree']).degree.e0, ds.tags().length, ds.tags()[0].count, typeof HONEST_HELPER]`)
    expect(deg.value).toEqual([1, 1, 1, 'undefined'])
    sb.dispose()
  }, 30_000)

  it('ordinary scripts still work: own classes, error names, sloppy globals within a run, sorting copies', async () => {
    const sb = new Sandbox()
    await sb.load('iso2', JSON.stringify(snapshot()))
    const r = await sb.run(`
      class MyError extends Error { constructor(m) { super(m); this.name = 'MyError' } }
      let caught
      try { throw new MyError('x') } catch (e) { caught = e.name + ':' + e.message }
      const o = {}; o.toString = () => 'mine'
      tmp = 5
      class Bag extends Array {}
      const b = Bag.from([3, 1, 2]).sort()
      return { text: [caught, String(o), tmp, [...b].join(','), sortBy(entities, 'label', true)[0].id].join(' ') }
    `)
    expect(r.error).toBeUndefined()
    expect(r.value).toEqual({ text: 'MyError:x mine 5 1,2,3 e5' })
    // The sloppy global was swept: the next run does not see it.
    const next = await sb.run(`return typeof tmp`)
    expect(next.value).toBe('undefined')
    sb.dispose()
  }, 30_000)

  it('an untrusted run leaves no context behind for the next', async () => {
    const sb = new Sandbox()
    await sb.load('iso3', JSON.stringify(snapshot()))
    await sb.run(`return 1`, { untrusted: true })
    // Nothing observable but the result: the next run is correct and rebuilt the context (load time is measured).
    const r = await sb.run(HONEST)
    expect(r.error).toBeUndefined()
    expect(r.ms.load).toBeGreaterThanOrEqual(0)
    sb.dispose()
  }, 30_000)
})

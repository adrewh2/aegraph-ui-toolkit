import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { importBundle } from '../../projects/bundle'
import { validateAe } from '../ae/validate'
import { normalizeEntity } from '../formats'
import { MAX_DATA_DEPTH, nestsDeeperThan } from '../limits'

/** What an entity from outside may be (`limits.ts`), and the validator's answer to names every object inherits. */
const nested = (levels: number): unknown => {
  const top: unknown[] = []
  let cur = top
  for (let i = 1; i < levels; i++) cur.push((cur = []))
  return top
}

describe('nesting from outside', () => {
  it('measures nesting without following a value built to exhaust the stack', () => {
    expect(nestsDeeperThan('x', 0)).toBe(false)
    expect(nestsDeeperThan({}, 1)).toBe(false)
    expect(nestsDeeperThan({ a: [{}] }, 2)).toBe(true)
    expect(nestsDeeperThan({ a: [{}] }, 3)).toBe(false)
    expect(nestsDeeperThan(JSON.parse('['.repeat(200_000) + ']'.repeat(200_000)), MAX_DATA_DEPTH)).toBe(true)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(nestsDeeperThan(cycle, MAX_DATA_DEPTH)).toBe(true)
  })

  it('refuses an entity nested past the bound — counted as skipped, and every later save still lands — and takes one at it', () => {
    expect(normalizeEntity({ id: 'ok', data: { a: nested(MAX_DATA_DEPTH - 1) } })).toBeTruthy()
    expect(normalizeEntity({ id: 'deep', data: { a: nested(MAX_DATA_DEPTH) } })).toBeUndefined()
    expect(normalizeEntity({ id: 'deep-meta', meta: { derivedFrom: nested(MAX_DATA_DEPTH + 1) } })).toBeUndefined()
    expect(normalizeEntity({ id: 'deep-end', source: { id: 'a', selector: nested(MAX_DATA_DEPTH + 1) }, target: 'b' })).toBeUndefined()
    const store = new EntityStore()
    const text = '{"$schema":"aegraph/v1","entities":[{"id":"d","type":"x","data":{"a":' + '['.repeat(100_000) + ']'.repeat(100_000) + '}},{"id":"fine","type":"x"}]}'
    const r = importBundle(store, JSON.parse(text), { name: 'deep' })
    expect(r.skipped).toBe(1)
    expect(store.has('d')).toBe(false)
    expect(store.has('fine')).toBe(true)
  })
})

describe('validateAe and inherited names', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('reports a selector of kind %s as an issue rather than throwing', (kind) => {
    const now = '2024-01-01T00:00:00.000Z'
    const doc = {
      $schema: 'aegraph/v1',
      entities: [
        { id: 'a', type: 'x', tags: [], data: {}, meta: { createdAt: now, updatedAt: now } },
        { id: 'r', kind: 'relationship', type: 'x', tags: [], data: {}, meta: { createdAt: now, updatedAt: now }, source: { id: 'a', selector: { kind } }, target: { id: 'a' } },
      ],
    }
    const r = validateAe(doc)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.path)).toContain('/entities/1/source/selector')
  })
})

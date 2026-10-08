import { describe, expect, it } from 'vitest'
import { createEntity } from '../entity'
import { fieldPatch, getField } from '../schema'

/**
 * A field key is data: it comes from a table column, a tool call, a CSV header,
 * an import. Writing one must put the value in the entity's own `data` and
 * nowhere else — never through an object's prototype, which would reach every
 * object in the page.
 */
const note = () => createEntity({ type: 'note', label: 'a', data: { depth: 1, at: { lat: 1 } } })

describe('setting a field by a dotted key', () => {
  it('sets a top-level field and a nested one, copying rather than mutating', () => {
    const e = note()
    expect(fieldPatch(e, 'label', 'b')).toEqual({ label: 'b' })
    const patch = fieldPatch(e, 'data.at.lng', 2) as { data: { at: { lat: number; lng: number } } }
    expect(patch.data.at).toEqual({ lat: 1, lng: 2 })
    expect(e.data.at).toEqual({ lat: 1 })
  })

  it('refuses a key that names an object’s machinery, at the top or inside', () => {
    const e = note()
    for (const key of ['__proto__', 'constructor', 'prototype', 'data.__proto__', 'data.__proto__.polluted', 'data.at.constructor.prototype.polluted', 'data.x.prototype']) {
      expect(() => fieldPatch(e, key, 'yes'), key).toThrow(/not a field|machinery/)
    }
  })

  it('leaves every other object in the page alone — the point of refusing', () => {
    const e = note()
    expect(() => fieldPatch(e, 'data.__proto__.polluted', 'yes')).toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reading a dotted key off an entity finds only its own data', () => {
    const e = note()
    expect(getField(e, 'data.depth')).toBe(1)
    expect(getField(e, 'data.at.lat')).toBe(1)
    expect(getField(e, 'data.missing.deep')).toBeUndefined()
  })
})

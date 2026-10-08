import { describe, expect, it } from 'vitest'
import { PositionStore } from '../positionStore'

/**
 * The working layout: what it answers, what it costs, and the one thing it
 * gives up (an older wrapper is not a picture of the past) along with the
 * journal that stands in for it.
 */
describe('PositionStore', () => {
  it('reads what it was given and replaces rather than merges', () => {
    const s = PositionStore.from({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } })
    expect(s.size).toBe(2)
    expect(s.get('a')).toEqual({ x: 1, y: 2 })
    expect(s.has('c')).toBe(false)
    expect(PositionStore.empty().size).toBe(0)
    const other = PositionStore.replace({ c: { x: 5, y: 6 } })
    expect([...other.entries()].map(([id]) => id)).toEqual(['c'])
    expect(s.get('a')).toEqual({ x: 1, y: 2 }) // a different layout altogether: the first is untouched
  })

  it('a move is the move, not a copy: the version tells memos what changed, and the object is built once per change', () => {
    const s0 = PositionStore.from({ a: { x: 1, y: 1 } })
    const s1 = s0.movedOne('b', { x: 2, y: 2 })
    expect(s1).not.toBe(s0)
    expect(s1.version).toBe(s0.version + 1)
    expect(s1.size).toBe(2)
    const o = s1.asObject()
    expect(o).toEqual({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } })
    expect(s1.asObject()).toBe(o) // cached until the next change
    const s2 = s1.moved({ a: { x: 9, y: 9 }, c: { x: 3, y: 3 } })
    expect(s2.asObject()).not.toBe(o)
    expect(s2.asObject()).toEqual({ a: { x: 9, y: 9 }, b: { x: 2, y: 2 }, c: { x: 3, y: 3 } })
    // Applying the same move twice (StrictMode) lands in the same place.
    expect(s1.moved({ a: { x: 9, y: 9 }, c: { x: 3, y: 3 } }).asObject()).toEqual(s2.asObject())
  })

  it('movedSince names what changed while something else was running, and says so when it cannot tell', () => {
    let s = PositionStore.from({ a: { x: 0, y: 0 } })
    const at = s.version
    expect(s.movedSince(at)).toEqual([])
    s = s.movedOne('a', { x: 1, y: 1 })
    s = s.moved({ b: { x: 2, y: 2 }, c: { x: 3, y: 3 } })
    expect(s.movedSince(at)?.sort()).toEqual(['a', 'b', 'c'])
    expect(s.movedSince(s.version)).toEqual([])
    // Past the journal's reach: unknown, not silently empty.
    for (let i = 0; i < 40; i++) s = s.movedOne(`n${i}`, { x: i, y: i })
    expect(s.movedSince(at)).toBeUndefined()
    expect(s.movedSince(s.version - 2)?.sort()).toEqual(['n38', 'n39'])
    // A version this store never reached is unknown too.
    expect(s.movedSince(s.version + 5)).toBeUndefined()
  })

  it('a writer recognises its own changes by their tag, however many versions its dispatches take', () => {
    // The simulation's hand-back: it reads the store at a version, writes back under its tag, and must not then
    // mistake its own write for the person's. The reducer runs twice under StrictMode, so the version it lands on
    // is not the one it would have guessed.
    let s = PositionStore.from({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } })
    let readAt = s.version
    s = s.moved({ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }, 'physics')
    s = s.moved({ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }, 'physics') // StrictMode's second invocation
    expect(s.movedSince(readAt, { ignore: 'physics' })).toEqual([])
    expect(s.movedSince(readAt)?.sort()).toEqual(['a', 'a', 'b', 'b'])
    // The person drags a node between the read and the write: that one is theirs and stays theirs.
    readAt = s.version
    s = s.movedOne('a', { x: 9, y: 9 })
    s = s.moved({ a: { x: 2, y: 2 }, b: { x: 2, y: 2 } }, 'physics')
    expect(s.movedSince(readAt, { ignore: 'physics' })).toEqual(['a'])
  })

  it('counts the simulation\u2019s own hand-backs apart, and says when a set is another layout', () => {
    // What the caches key on while a run is going: the picture on screen is the engine's, so a hand-back must not
    // make the explorer resolve the whole view again — but anything the person does still must.
    const s0 = PositionStore.from({ a: { x: 0, y: 0 } })
    const s1 = s0.moved({ a: { x: 1, y: 1 } }, 'physics')
    expect(s1.version).toBe(s0.version + 1)
    expect(s1.quietVersion).toBe(s0.quietVersion)
    const s2 = s1.movedOne('a', { x: 5, y: 5 }) // a drag
    expect(s2.quietVersion).toBe(s2.version)
    expect(s2.quietVersion).not.toBe(s1.quietVersion)
    // The same positions, moved, keep their id; another layout is another set.
    expect(s2.id).toBe(s0.id)
    expect(PositionStore.replace({ b: { x: 0, y: 0 } }).id).not.toBe(s0.id)
    expect(PositionStore.empty().id).not.toBe(s0.id)
  })
})

describe('PositionStore.fromPacked', () => {
  it('holds the packed positions by id, 2D without z and 3D with it', () => {
    const two = PositionStore.fromPacked({ ids: ['a', 'b'], xyz: new Float32Array([1, 2, 0, 3, 4, 0]), dims: 2 })
    expect(two.size).toBe(2)
    expect(two.get('b')).toEqual({ x: 3, y: 4 })
    const three = PositionStore.fromPacked({ ids: ['a'], xyz: new Float32Array([1, 2, 3]), dims: 3 })
    expect(three.get('a')).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe('PositionStore.movedPacked', () => {
  it('moves the packed nodes in place, leaves the rest, and counts as a hand-back when tagged', () => {
    const s0 = PositionStore.from({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 9, y: 9 } })
    const s1 = s0.movedPacked({ ids: ['a', 'b'], xyz: new Float32Array([1, 2, 0, 3, 4, 0]), dims: 2 }, 'physics')
    expect(s1.get('a')).toEqual({ x: 1, y: 2 })
    expect(s1.get('b')).toEqual({ x: 3, y: 4 })
    expect(s1.get('c')).toEqual({ x: 9, y: 9 })
    expect(s1.version).toBe(s0.version + 1)
    expect(s1.quietVersion).toBe(s0.quietVersion)
    expect(s1.id).toBe(s0.id)
    // Listed for `movedSince`, and a writer that ignores its own tag sees nothing else moved.
    expect(s1.movedSince(s0.version)).toEqual(['a', 'b'])
    expect(s1.movedSince(s0.version, { ignore: 'physics' })).toEqual([])
    const s2 = s1.movedPacked({ ids: ['c'], xyz: new Float32Array([1, 2, 3]), dims: 3 })
    expect(s2.get('c')).toEqual({ x: 1, y: 2, z: 3 })
    expect(s2.quietVersion).toBe(s2.version)
  })
})

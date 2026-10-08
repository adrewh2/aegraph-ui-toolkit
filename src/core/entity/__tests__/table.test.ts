import { describe, expect, it } from 'vitest'
import { createEntity } from '../entity'
import { HandleSet } from '../handleSet'
import { EntityStore } from '../store'
import { EntityTable } from '../table'

describe('the entity table', () => {
  it('gives each id a handle for good, keeps the Map’s order, and never gives a handle to another id', () => {
    const t = new EntityTable()
    const a = createEntity({ id: 'a' }), b = createEntity({ id: 'b' }), c = createEntity({ id: 'c' })
    t.set('a', a).set('b', b).set('c', c)
    expect([t.handleOf('a'), t.handleOf('b'), t.handleOf('c')]).toEqual([0, 1, 2])
    // Written again: the same handle, the same place in the order.
    const a2 = { ...a, label: 'A' }
    t.set('a', a2)
    expect(t.handleOf('a')).toBe(0)
    expect(t.valuesArray()).toEqual([a2, b, c])
    // Removed: its slot is empty, its id still known by its handle, and nothing else ever takes the handle.
    expect(t.delete('b')).toBe(true)
    expect([t.size, t.at(1), t.idAt(1), t.get('b')]).toEqual([2, undefined, 'b', undefined])
    t.set('b', b)
    expect(t.handleOf('b')).toBe(3)
    expect([...t.values()].map((e) => e.id)).toEqual(['a', 'c', 'b'])
    expect(t.capacity).toBe(4)
    // Cleared: a new generation, and handles start again.
    const g = t.generation
    t.clear()
    expect([t.size, t.capacity, t.generation]).toEqual([0, 0, g + 1])
  })

  it('is what the store keeps: handles through reads, writes and removals, and a removal names the handles it freed', () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'x' }), createEntity({ id: 'y' })])
    const hy = store.handleOf('y')!
    expect(store.entityAt(hy)?.id).toBe('y')
    const events: unknown[] = []
    store.subscribe((e) => events.push(e))
    store.remove('y')
    expect(events).toEqual([{ type: 'remove', ids: ['y'], handles: [hy] }])
    expect([store.entityAt(hy), store.idAt(hy), store.handleOf('y')]).toEqual([undefined, 'y', undefined])
    expect(store.all().map((e) => e.id)).toEqual(['x'])
  })
})

describe('a set of handles', () => {
  it('grows as handles do and keeps its size as it goes', () => {
    const s = new HandleSet()
    for (const h of [3, 5000, 3, 2_000_000]) s.add(h)
    expect(s.size).toBe(3)
    expect([s.has(3), s.has(4), s.has(5000), s.has(2_000_000), s.has(9_999_999)]).toEqual([true, false, true, true, false])
    expect(s.delete(5000)).toBe(true)
    expect(s.delete(5000)).toBe(false)
    const seen: number[] = []
    s.forEach((h) => seen.push(h))
    expect([s.size, seen]).toEqual([2, [3, 2_000_000]])
    s.clear()
    expect([s.size, s.has(3)]).toEqual([0, false])
  })
})

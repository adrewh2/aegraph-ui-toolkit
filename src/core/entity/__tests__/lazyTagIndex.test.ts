import { describe, expect, it } from 'vitest'
import { createEntity } from '../entity'
import { EntityStore } from '../store'

/**
 * The tag index is built after a load, a slice at a time (`warmTagIndex`), or at once by whoever asks first
 * (`withTag`, `tags`, `tagUsage`). Writes made while it is half built — tags changed, entities removed or added on
 * either side of where it has got to — must leave it exactly as if it had been built after them.
 */
const TAGS = ['red', 'green', 'blue', 'amber', 'violet']
const brute = (s: EntityStore, tag: string) => s.all().filter((e) => e.tags.includes(tag)).map((e) => e.id).sort()
const viaIndex = (s: EntityStore, tag: string) => s.withTag(tag).map((e) => e.id).sort()

function loaded(n: number) {
  const s = new EntityStore()
  s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `e${i}`, type: 'thing', label: `e${i}`, tags: [TAGS[i % 5], TAGS[(i * 7) % 5]] })))
  return s
}

describe('the tag index, built after the load', () => {
  it('answers the same whether built at once, in slices, or with writes in between', () => {
    const s = loaded(20_000)
    // A slice: past the first 4,096 handles, not to the end.
    expect(s.warmTagIndex(0)).toBe(false)
    // Writes on both sides of the cursor.
    s.update('e10', { tags: ['violet', 'new'] }) // indexed already
    s.update('e15000', { tags: ['new'] }) // not yet
    s.remove(['e20', 'e19000'])
    s.upsert(createEntity({ id: 'late', type: 'thing', label: 'late', tags: ['new', 'red'] }))
    expect(s.warmTagIndex(0)).toBe(false)
    for (const tag of [...TAGS, 'new']) expect(viaIndex(s, tag)).toEqual(brute(s, tag))
    expect(s.tagUsage('new')).toBe(3)
    // Once built, writes keep it level.
    s.update('late', { tags: [] })
    expect(viaIndex(s, 'new')).toEqual(['e10', 'e15000'])
    expect(s.warmTagIndex()).toBe(true)
  })

  it('starts again after a clear, and a small store builds it on first ask', () => {
    const s = loaded(10)
    expect(s.withTag('red').length).toBe(brute(s, 'red').length)
    s.clear()
    s.upsert(createEntity({ id: 'x', type: 'thing', label: 'x', tags: ['red'] }))
    expect(viaIndex(s, 'red')).toEqual(['x'])
    expect(s.tags()).toContain('red')
  })
})

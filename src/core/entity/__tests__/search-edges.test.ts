import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'
import '../../graph/types'

/**
 * The plain text search — `store.query({ text })`, a case-folded substring
 * over id, label, description, type, tags and the first 8,000 characters of
 * the data's JSON — at its edges: an empty store, a needle of whitespace or
 * punctuation, one letter, accents and unicode, a very long needle, an
 * empty label, the same word in label / data / tags / type / id, a phrase
 * (order matters, no tokens), numbers and keys inside the data, the data
 * cap, an entity replaced (old words gone) and one mutated in place (the
 * cache is per object), removal, scope, relationships, the filters
 * combined, and thousands of entities within bounds.
 */
const ids = (list: { id: string }[]) => list.map((e) => e.id).sort()

describe('text search edges', () => {
  it('an empty store finds nothing; a blank needle is no filter; punctuation and one letter are plain substrings', () => {
    const s = new EntityStore()
    expect(s.query({ text: 'anything' })).toEqual([])
    expect(s.query({ text: '' })).toEqual([])
    s.upsertMany([createEntity({ id: 'a', type: 'note', label: 'Alpha!' }), createEntity({ id: 'b', type: 'note', label: 'Beta?' })])
    expect(ids(s.query({ text: '   ' }))).toEqual(['a', 'b'])
    expect(ids(s.query({ text: '!' }))).toEqual(['a'])
    expect(ids(s.query({ text: '?!' }))).toEqual([])
    expect(ids(s.query({ text: 'a' }))).toEqual(['a', 'b']) // 'a' is in both labels and both are notes
    expect(ids(s.query({ text: '  ALPHA  ' }))).toEqual(['a'])
  })

  it('folds case but not accents; unicode ids and labels are found as written', () => {
    const s = new EntityStore()
    s.upsertMany([createEntity({ id: 'café-🎉', type: 'note', label: 'Émile ZOLA' }), createEntity({ id: 'plain', type: 'note', label: 'Emile' })])
    expect(ids(s.query({ text: 'émile' }))).toEqual(['café-🎉'])
    expect(ids(s.query({ text: 'ÉMILE' }))).toEqual(['café-🎉'])
    expect(ids(s.query({ text: 'emile' }))).toEqual(['plain'])
    expect(ids(s.query({ text: '🎉' }))).toEqual(['café-🎉'])
    expect(ids(s.query({ text: 'zola' }))).toEqual(['café-🎉'])
  })

  it('a very long needle matches nothing and costs nothing; an entity with an empty label is found by its id, type and data', () => {
    const s = new EntityStore()
    s.upsert(createEntity({ id: 'e1', type: 'note', label: '', data: { body: 'hello' } }))
    const t = performance.now()
    expect(s.query({ text: 'x'.repeat(100_000) })).toEqual([])
    expect(performance.now() - t).toBeLessThan(200)
    expect(ids(s.query({ text: 'e1' }))).toEqual(['e1'])
    expect(ids(s.query({ text: 'note' }))).toEqual(['e1'])
    expect(ids(s.query({ text: 'hello' }))).toEqual(['e1'])
  })

  it('finds a word wherever it sits — label, description, tag, type, id, a data key or value, a number; several words in any order; a "quoted phrase" only as written', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'in-label', type: 'note', label: 'Quartz crystal' }),
      createEntity({ id: 'in-desc', type: 'note', label: 'Stone', description: 'a quartz vein' }),
      createEntity({ id: 'in-tag', type: 'note', label: 'Rock', tags: ['quartz'] }),
      createEntity({ id: 'in-data', type: 'note', label: 'Mineral', data: { kind: 'quartz', hardness: 7, note: 'seven point zero' } }),
      createEntity({ id: 'in-key', type: 'note', label: 'Keyed', data: { quartzIndex: 1 } }),
      createEntity({ id: 'other', type: 'quartz', label: 'Type only' }),
    ])
    expect(ids(s.query({ text: 'quartz' }))).toEqual(['in-data', 'in-desc', 'in-key', 'in-label', 'in-tag', 'other'])
    expect(ids(s.query({ text: 'quartz crystal' }))).toEqual(['in-label'])
    expect(ids(s.query({ text: 'crystal quartz' }))).toEqual(['in-label']) // both words, any order
    expect(ids(s.query({ text: '"quartz crystal"' }))).toEqual(['in-label'])
    expect(ids(s.query({ text: '"crystal quartz"' }))).toEqual([]) // the phrase, as written
    expect(ids(s.query({ text: '  quartz   crystal  ' }))).toEqual(['in-label'])
    expect(ids(s.query({ text: '""' }))).toEqual(ids(s.query({}))) // an empty phrase is no filter
    expect(ids(s.query({ text: '7' }))).toEqual(['in-data'])
    expect(ids(s.query({ text: '"hardness":7' }))).toEqual(['in-data']) // the data is searched as JSON, punctuation included
    expect(ids(s.query({ text: 'point' }))).toEqual(['in-data'])
    expect(ids(s.query({ text: 'in-' }))).toEqual(['in-data', 'in-desc', 'in-key', 'in-label', 'in-tag'])
  })

  it('reads only the first 8,000 characters of the data, so a word past the cap is not found', () => {
    const s = new EntityStore()
    s.upsert(createEntity({ id: 'long', type: 'note', data: { head: 'needle-early', pad: 'p'.repeat(9000), tail: 'needle-late' } }))
    expect(ids(s.query({ text: 'needle-early' }))).toEqual(['long'])
    expect(ids(s.query({ text: 'needle-late' }))).toEqual([])
  })

  it('an entity replaced by upsert loses its old words; one mutated in place keeps the text it was first indexed with; a removed one is gone', () => {
    const s = new EntityStore()
    s.upsert(createEntity({ id: 'a', type: 'note', label: 'before', tags: ['old'] }))
    expect(ids(s.query({ text: 'before' }))).toEqual(['a'])
    s.upsert({ ...s.get('a')!, label: 'after', tags: [] })
    expect(ids(s.query({ text: 'before' }))).toEqual([])
    expect(ids(s.query({ text: 'old' }))).toEqual([])
    expect(ids(s.query({ text: 'after' }))).toEqual(['a'])
    // The search text is cached per entity object: mutating a stored object is outside the contract, and the search shows it.
    const held = s.get('a')!
    ;(held as { label?: string }).label = 'mutated'
    s.upsert(held)
    expect(ids(s.query({ text: 'after' }))).toEqual(['a'])
    expect(ids(s.query({ text: 'mutated' }))).toEqual([])
    s.remove('a')
    expect(s.query({ text: 'after' })).toEqual([])
    expect(s.query({ text: 'a' })).toEqual([])
  })

  it('sees only the scope, searches relationships by type and data, and combines text with kind, type, every tag and a predicate', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'project:p', type: 'project', label: 'P' }),
      createEntity({ id: 'a', type: 'note', label: 'shared word', tags: ['t1', 't2'], meta: { projects: ['project:p'] } }),
      createEntity({ id: 'b', type: 'note', label: 'shared word', tags: ['t1'] }),
      createEntity({ id: 'c', type: 'paper', label: 'shared word', tags: ['t1', 't2'] }),
      createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b', data: { page: 'shared' } }),
    ])
    expect(ids(s.query({ text: 'shared' }))).toEqual(['a', 'ab', 'b', 'c'])
    expect(ids(s.query({ text: 'shared', kind: 'relationship' }))).toEqual(['ab'])
    expect(ids(s.query({ text: 'cites' }))).toEqual(['ab'])
    expect(ids(s.query({ text: 'shared', kind: 'entity', type: ['note', 'paper'] }))).toEqual(['a', 'b', 'c'])
    expect(ids(s.query({ text: 'shared', tags: ['t1', 't2'] }))).toEqual(['a', 'c'])
    expect(ids(s.query({ text: 'shared', tags: ['t2'], type: 'note' }))).toEqual(['a'])
    expect(ids(s.query({ text: 'shared', predicate: (e) => e.id > 'a' }))).toEqual(['ab', 'b', 'c'])
    s.setScope('project:p')
    expect(ids(s.query({ text: 'shared' }))).toEqual(['a'])
    expect(ids(s.query({ text: 'shared', type: 'note' }))).toEqual(['a'])
    expect(ids(s.query({ text: 'shared', tags: ['t1'] }))).toEqual(['a'])
    expect(ids(s.library.query({ text: 'shared' }))).toEqual(['a', 'ab', 'b', 'c'])
    s.setScope(null)
  })

  // Real work on real volumes: what it costs is the machine's business, so the harness is given room and the
  // assertions below say what actually has to hold. A bare timeout here would only ever measure the load.
  it('twenty thousand entities: the first search builds the text, the next ones are quick, and the order is the store’s', () => {
    const s = new EntityStore()
    const n = 20_000
    s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `e${String(i).padStart(5, '0')}`, type: i % 3 ? 'note' : 'paper', label: `Item ${i}`, tags: [`t${i % 10}`], data: { i, text: `lorem ipsum ${i % 100}` } })))
    const t0 = performance.now()
    const first = s.query({ text: '"ipsum 42"' })
    const firstMs = performance.now() - t0
    const t1 = performance.now()
    const second = s.query({ text: '"ipsum 42"' })
    const secondMs = performance.now() - t1
    expect(first.length).toBe(200)
    expect(s.query({ text: 'ipsum 42' }).length).toBeGreaterThan(200) // unquoted: "42" anywhere — ids, the counter, 142…
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id))
    expect(first.map((e) => e.id)).toEqual([...first.map((e) => e.id)].sort())
    expect(firstMs).toBeLessThan(3000)
    expect(secondMs).toBeLessThan(firstMs)
    expect(secondMs).toBeLessThan(500)
  }, 30_000)
})

describe('search text is a cache for a burst of searches', () => {
  it('is let go once searching has been idle, and rebuilt when asked again', async () => {
    const { vi } = await import('vitest')
    const { searchTextOf, releaseSearchText, SEARCH_IDLE_MS } = await import('../store')
    const { createEntity } = await import('../entity')
    // Earlier tests left a release pending on the real clock: start from none.
    releaseSearchText()
    vi.useFakeTimers()
    try {
      const e = createEntity({ id: 'n1', type: 'note', label: 'Maple Street' })
      const sym = () => Object.getOwnPropertySymbols(e).map((k) => (e as unknown as Record<symbol, unknown>)[k])
      expect(searchTextOf(e)).toContain('maple street')
      expect(sym()).toContain(searchTextOf(e))
      vi.advanceTimersByTime(SEARCH_IDLE_MS + 5000)
      expect(sym().filter((v) => v !== undefined)).toEqual([])
      // Not stale, not lost: asked again, built again.
      expect(searchTextOf(e)).toContain('maple street')
    } finally {
      vi.useRealTimers()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { SCHEMA_TYPE } from '../../entity/categories'
import { validateAe } from '../ae/validate'
import { entitiesToDocument } from '../subset'

/**
 * The export of a selection at its edges: nothing selected, rows the store
 * has never heard of, a relationship with only one end in, a relationship
 * selected outright, the same row twice, which tag infos come along and
 * which do not, what a selected layout or scene leaves pointing outside,
 * type definitions (only when picked), the same selection taken twice, and
 * a thousand rows for time. The document is checked with the validator the
 * app reads files with, so "self-contained" means what the format says.
 */
const store = () => {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'person', label: 'Ada', tags: ['friend', 'plain'] }),
    createEntity({ id: 'b', type: 'person', label: 'Bo', tags: ['friend'] }),
    createEntity({ id: 'c', type: 'person', label: 'Cy' }),
    createRelationship({ id: 'ab', type: 'knows', source: 'a', target: 'b' }),
    createRelationship({ id: 'ac', type: 'knows', source: 'a', target: 'c' }),
  ])
  s.setTagInfo('friend', { color: '#ff0000' })
  return s
}
const idsOf = (doc: { entities: { id: string }[] }) => doc.entities.map((e) => e.id).sort()

describe('entitiesToDocument', () => {
  it('makes a valid, empty document out of nothing selected', () => {
    const doc = entitiesToDocument(store(), [])
    expect(doc.entities).toEqual([])
    expect(doc.tags).toBeUndefined() // no tags key at all rather than an empty list
    expect(doc.$schema).toBe('aegraph/v1')
    expect(Date.parse(doc.exportedAt!)).not.toBeNaN()
    expect(validateAe(doc)).toMatchObject({ ok: true, entities: 0, relationships: 0, unresolved: [], duplicates: [] })
  })

  it('brings the relationships between the rows and leaves out the one with an end outside', () => {
    const s = store()
    const doc = entitiesToDocument(s, [s.get('a')!, s.get('b')!])
    expect(idsOf(doc)).toEqual(['a', 'ab', 'b']) // ac is left behind: c is not in the selection
    expect(validateAe(doc)).toMatchObject({ ok: true, entities: 2, relationships: 1, unresolved: [] })
  })

  it('keeps a relationship that was itself selected, once, even though its ends make it dangle', () => {
    const s = store()
    const doc = entitiesToDocument(s, [s.get('ab')!])
    expect(idsOf(doc)).toEqual(['ab'])
    // Picked on purpose, so it is exported as picked; the ends it names are simply not in this file, which the
    // validator reports as unresolved references rather than as a broken document.
    expect(validateAe(doc)).toMatchObject({ ok: true, relationships: 1, unresolved: ['a', 'b'] })
  })

  it('exports a row the store has never seen, and still finds the relationships the store holds for it', () => {
    const s = store()
    const invented = createEntity({ id: 'z', type: 'person', label: 'Zoe' })
    const doc = entitiesToDocument(s, [invented, s.get('a')!, s.get('c')!])
    expect(idsOf(doc)).toEqual(['a', 'ac', 'c', 'z'])
    expect(validateAe(doc)).toMatchObject({ ok: true, unresolved: [] })
  })

  it('writes an entity once however many times it was picked', () => {
    const s = store()
    const a = s.get('a')!
    const doc = entitiesToDocument(s, [a, a, s.get('b')!, s.get('b')!])
    expect(idsOf(doc)).toEqual(['a', 'ab', 'b'])
    expect(validateAe(doc).duplicates).toEqual([])
  })

  it('carries the tag infos the rows use that say something, and no others', () => {
    const s = store()
    const doc = entitiesToDocument(s, [s.get('a')!, s.get('b')!])
    expect(doc.tags).toEqual([{ tag: 'friend', color: '#ff0000' }]) // `plain` has neither colour nor description: nothing to carry
    expect(entitiesToDocument(s, [s.get('c')!]).tags).toBeUndefined()
  })

  it('takes a type definition only when it was picked, never because a row has that type', () => {
    const s = store()
    s.upsert(createEntity({ id: 'schema:person', type: SCHEMA_TYPE, label: 'Person', data: { name: 'person' } }))
    expect(idsOf(entitiesToDocument(s, [s.get('a')!]))).toEqual(['a'])
    expect(idsOf(entitiesToDocument(s, [s.get('a')!, s.get('schema:person')!]))).toEqual(['a', 'schema:person'])
  })

  it('leaves a picked layout pointing at whatever it pointed at, in or out of the selection', () => {
    const s = store()
    s.upsert(createEntity({ id: 'lay', type: 'layout', label: 'A layout', data: { algorithm: 'imported', dimensions: 2, positions: { a: { x: 1, y: 2 }, c: { x: 3, y: 4 } } } }))
    const doc = entitiesToDocument(s, [s.get('a')!, s.get('lay')!])
    // Positions are data, not references: the layout keeps the node it names outside the selection, and opening
    // the file simply has nothing to place there. (The validator only follows real refs, so it stays quiet.)
    expect(doc.entities.find((e) => e.id === 'lay')?.data).toMatchObject({ positions: { a: { x: 1, y: 2 }, c: { x: 3, y: 4 } } })
    expect(validateAe(doc)).toMatchObject({ ok: true, unresolved: [] })
  })

  it('gives the same selection the same document twice over, but for the moment it was taken', () => {
    const s = store()
    const rows = [s.get('a')!, s.get('b')!]
    const one = entitiesToDocument(s, rows)
    const two = entitiesToDocument(s, rows)
    expect({ ...two, exportedAt: one.exportedAt }).toEqual(one)
  })

  it('takes a thousand rows out of a larger store quickly', () => {
    const s = new EntityStore()
    s.upsertMany([
      ...Array.from({ length: 2000 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `Note ${i}`, tags: [`t${i % 5}`] })),
      ...Array.from({ length: 4000 }, (_, i) => createRelationship({ id: `r${i}`, type: 'links', source: `n${i % 2000}`, target: `n${(i * 3 + 1) % 2000}` })),
    ])
    const rows = s.all().filter((e) => e.kind === 'entity').slice(0, 1000)
    const t0 = performance.now()
    const doc = entitiesToDocument(s, rows)
    const ms = performance.now() - t0
    expect(doc.entities.length).toBeGreaterThan(1000)
    expect(validateAe(doc).duplicates).toEqual([])
    expect(ms).toBeLessThan(400) // generous: one pass over the relationships, single-digit milliseconds unloaded
  })
})

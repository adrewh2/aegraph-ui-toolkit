import { afterEach, describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { isRelationship } from '../../entity/types'
import { seedStore, seedWelcome, WELCOME_DOC_ID } from '../seed'
import { RESOURCE_TYPES } from '../types'

/**
 * What a fresh workspace is given: the welcome document (written once per
 * browser, never over the top of one already there, and gone for good
 * once deleted), and the sample resources — every relationship with both
 * its ends, every selector the annotators use, ids that do not move when
 * it is seeded twice, and nothing the type registry does not know. Also
 * that the welcome text does not send a new reader to a page that is no
 * longer in the app.
 */
const withStorage = (store: Map<string, string>) => {
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true })
}
afterEach(() => {
  Reflect.deleteProperty(globalThis as object, 'localStorage')
})

describe('seedWelcome', () => {
  it('writes the welcome document once, and not again once this browser has had it — even after it is deleted', () => {
    const kept = new Map<string, string>()
    withStorage(kept)
    const s = new EntityStore()
    seedWelcome(s)
    const doc = s.get(WELCOME_DOC_ID)!
    expect(doc).toMatchObject({ type: RESOURCE_TYPES.document, label: 'Welcome to aegraph', tags: ['guide'] })
    expect(String(doc.data.content)).toContain('# Welcome to aegraph')
    seedWelcome(s)
    expect(s.library.all().filter((e) => e.id === WELCOME_DOC_ID)).toHaveLength(1)
    // Deleting it sticks: the flag in this browser outlives the document.
    s.remove([WELCOME_DOC_ID])
    seedWelcome(s)
    expect(s.has(WELCOME_DOC_ID)).toBe(false)
  })

  it('never writes over a welcome document that is already there, flag or no flag', () => {
    withStorage(new Map())
    const s = new EntityStore()
    s.upsert(createEntity({ id: WELCOME_DOC_ID, type: RESOURCE_TYPES.document, label: 'My own notes', data: { extension: 'md', content: 'Mine.' } }))
    seedWelcome(s)
    expect(s.get(WELCOME_DOC_ID)).toMatchObject({ label: 'My own notes', data: { content: 'Mine.' } })
  })

  it('seeds anyway when the browser has no storage to remember with', () => {
    const s = new EntityStore()
    seedWelcome(s) // no localStorage defined at all: the read throws, and the document is still written
    expect(s.has(WELCOME_DOC_ID)).toBe(true)
  })

  it('sends the reader to pages the app still has', () => {
    const s = new EntityStore()
    seedWelcome(s)
    const text = String(s.get(WELCOME_DOC_ID)!.data.content)
    // The Datasets tab became the project dialog; the welcome must not name a sidebar entry that is not there.
    expect(text).not.toMatch(/\*\*Datasets\*\* \(left sidebar\)/)
    for (const page of ['Documents', 'Unigraph', 'Documentation', 'Workstation']) expect(text).toContain(`**${page}**`)
  })
})

describe('seedStore', () => {
  it('gives a connected sample: every relationship has both its ends, and every entity a type the app knows', () => {
    const s = new EntityStore()
    seedStore(s)
    const all = s.library.all()
    const ids = new Set(all.map((e) => e.id))
    const rels = all.filter(isRelationship)
    expect(all.length - rels.length).toBeGreaterThan(10)
    expect(rels.length).toBeGreaterThan(5)
    for (const r of rels) {
      expect(ids.has(r.source.id), `${r.id} source`).toBe(true)
      expect(ids.has(r.target.id), `${r.id} target`).toBe(true)
    }
    const known = new Set(Object.values(RESOURCE_TYPES))
    for (const e of all.filter((e) => !isRelationship(e))) expect(known.has(e.type as never), `${e.id} is a ${e.type}`).toBe(true)
  })

  it('carries a selector of every kind the annotators write, and tag colours for the tags it uses', () => {
    const s = new EntityStore()
    seedStore(s)
    const kinds = s.library
      .all()
      .filter(isRelationship)
      .map((r) => (r.target as { selector?: { kind?: string } }).selector?.kind)
      .filter(Boolean)
    expect(new Set(kinds)).toEqual(new Set(['text', 'region', 'time']))
    // A time selector with a region on it: an annotation of part of a frame.
    const framed = s.library.all().filter(isRelationship).find((r) => (r.target as { selector?: { region?: unknown } }).selector?.region)
    expect(framed).toBeDefined()
    expect(s.getTagInfo('protocol')).toMatchObject({ color: '#c7d2fe' })
    expect(s.getTagInfo('draft').color).toBe('#fde68a')
    expect(s.getTagInfo('reference').description).toBeTruthy()
  })

  it('seeds the same sample twice over without doubling it', () => {
    const s = new EntityStore()
    seedStore(s)
    const first = s.library.all().map((e) => e.id).sort()
    seedStore(s)
    expect(s.library.all().map((e) => e.id).sort()).toEqual(first)
  })

  it('leaves what is already in the store alone', () => {
    const s = new EntityStore()
    s.upsert(createEntity({ id: 'mine', type: RESOURCE_TYPES.note, label: 'Mine', data: { text: 'kept' } }))
    seedStore(s)
    expect(s.get('mine')).toMatchObject({ label: 'Mine' })
  })
})

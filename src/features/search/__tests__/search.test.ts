import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { classify, searchEntities, snippetOf } from '../search'

const make = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'doc', type: 'document', label: 'Field notes', data: { content: 'Day one.\nWe reached the quartz outcrop at noon; the light on the quartz was extraordinary.\nDay two.' } }),
    createEntity({ id: 'quartz', type: 'concept', label: 'Quartz', description: 'A mineral' }),
    createEntity({ id: 'rose', type: 'concept', label: 'Rose quartz', tags: ['mineral:silicate'] }),
    createEntity({ id: 'tagged', type: 'note', label: 'Untitled', tags: ['quartz'] }),
    createEntity({ id: 'desc', type: 'note', label: 'Reading', description: 'about quartz veins' }),
    createEntity({ id: 'page', type: 'webpage', label: 'Wikipedia', data: { url: 'https://en.wikipedia.org/wiki/Quartz', text: 'Quartz is a hard, crystalline mineral composed of silica.' } }),
    createEntity({ id: 'view', type: 'view', label: 'Quartz view', data: {} }),
    createRelationship({ id: 'r', type: 'mentions', label: 'quartz mention', source: 'doc', target: 'quartz' }),
    createEntity({ id: 'far', type: 'note', label: 'Unrelated', data: { content: 'nothing here' } }),
  ])
  return { store, registry: new TypeRegistry(store) }
}

describe('search behind ⌘K', () => {
  it('says where each entity matched — name first, then tag, description, the text it carries — and counts everything', () => {
    const { store, registry } = make()
    const r = searchEntities(store, registry, 'quartz', { limit: 10 })
    expect(r.total).toBe(8) // everything but "Unrelated" (a relationship counts by its own label, not its ends)
    expect(r.partial).toBe(false)
    const where = Object.fromEntries([...r.entities, ...r.content].map((h) => [h.entity.id, h.where]))
    expect(where).toEqual({ quartz: 'label', rose: 'label', view: 'label', tagged: 'tag', desc: 'description', doc: 'content', page: 'content', r: 'label' })
    // Name hits: a name that starts with the word before one that contains it; saved views after the user's material; relationships last.
    expect(r.entities.map((h) => h.entity.id)).toEqual(['quartz', 'rose', 'tagged', 'desc', 'view', 'r'])
    expect(r.content.map((h) => h.entity.id)).toEqual(['doc', 'page'])
  })

  it('a text hit carries the field and the line it matched on, the match marked, trimmed to the line', () => {
    const { store, registry } = make()
    const r = searchEntities(store, registry, 'outcrop', { limit: 10 })
    expect(r.entities).toEqual([])
    const [hit] = r.content
    expect(hit.entity.id).toBe('doc')
    expect(hit.field).toBe('content')
    expect(hit.snippet).toEqual({ before: 'We reached the quartz ', match: 'outcrop', after: ' at noon; the light on the quartz was extraordinary.' })
    const page = searchEntities(store, registry, 'silica', { limit: 10 }).content[0]
    expect(page.field).toBe('text') // the longest field that holds the word, not the URL
    expect(page.snippet?.match).toBe('silica')
  })

  it('every word must occur; the snippet sits at the first of them; a "quoted phrase" matches as written', () => {
    const { store, registry } = make()
    expect(searchEntities(store, registry, 'quartz noon', { limit: 10 }).total).toBe(1)
    expect(searchEntities(store, registry, 'noon quartz', { limit: 10 }).content[0].snippet?.match).toBe('quartz')
    expect(searchEntities(store, registry, '"quartz outcrop"', { limit: 10 }).total).toBe(1)
    expect(searchEntities(store, registry, '"outcrop quartz"', { limit: 10 }).total).toBe(0)
    expect(searchEntities(store, registry, 'QUARTZ', { limit: 10 }).total).toBe(8)
    expect(searchEntities(store, registry, '   ', { limit: 10 })).toMatchObject({ total: 0, entities: [], content: [] })
  })

  it('keeps only the best `limit` of each group while still counting all, and stops at the time budget', () => {
    const { store, registry } = make()
    const r = searchEntities(store, registry, 'quartz', { limit: 2 })
    expect(r.entities.map((h) => h.entity.id)).toEqual(['quartz', 'rose'])
    expect(r.content).toHaveLength(2)
    expect(r.total).toBe(8)
    store.upsertMany(Array.from({ length: 300 }, (_, i) => createEntity({ id: `q${i}`, type: 'note', label: `Quartz sample ${i}` })))
    let t = 0
    const slow = searchEntities(store, registry, 'quartz', { limit: 10, budgetMs: 1, now: () => (t += 1000) })
    expect(slow.partial).toBe(true)
    expect(slow.total).toBeLessThan(308)
    expect(searchEntities(store, registry, 'quartz', { limit: 10 })).toMatchObject({ total: 308, partial: false })
  })

  it('snippets: at the start or end of a line no ellipsis; far into a long line, a window with ellipses; whitespace folded', () => {
    expect(snippetOf('quartz first', ['quartz'])).toEqual({ before: '', match: 'quartz', after: ' first' })
    const long = `${'a '.repeat(100)}quartz${' b'.repeat(100)}`
    const s = snippetOf(long, ['quartz'])!
    expect(s.before.startsWith('…')).toBe(true)
    expect(s.after.endsWith('…')).toBe(true)
    expect(s.before.length).toBeLessThanOrEqual(62)
    expect(snippetOf('line one\n\tindented   quartz\nline three', ['quartz'])).toEqual({ before: ' indented ', match: 'quartz', after: '' })
    expect(snippetOf('nothing', ['quartz'])).toBeUndefined()
  })

  it('classify: a schema-less data value, a nested field, a list of strings, and terms split across fields', () => {
    const e = createEntity({ id: 'x', type: 'place', label: 'Somewhere', data: { address: { city: 'Paris', country: 'France' }, aliases: ['Lutetia', 'Paname'], src: 'data:image/png;base64,AAAA' } })
    expect(classify(e, ['paris'])).toMatchObject({ where: 'content', field: 'address.city', snippet: { match: 'Paris' } })
    expect(classify(e, ['paname'])).toMatchObject({ where: 'content', field: 'aliases' })
    expect(classify(e, ['base64'])).toEqual({ where: 'other' }) // data URLs are never "text"
    expect(classify(e, ['paris', 'somewhere'])).toMatchObject({ where: 'content', field: 'address.city' }) // one word in the name, one in the data: the text field that holds most
    expect(classify(e, ['some'])).toEqual({ where: 'label' })
  })
})

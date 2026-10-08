import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { buildVocabulary, describeVocabulary, embeddingRank, lexicalRank, tagText, terms, typeText, vocabularyTexts } from '../vocabulary'

/**
 * The search vocabulary at its edges: an empty store; queries of one or
 * two characters, of stop words, of punctuation; the crude stemmer on
 * short words and every suffix; diacritics and non-Latin labels, which
 * the tokeniser cannot see; emoji in samples; a name that is both a type
 * and a tag; prefixes at the boundary and containment; ties keeping the
 * count order; the caps on samples, tags and links; relationships to
 * missing ends; a store of thousands and its time; the texts for a model.
 */
describe('vocabulary edges', () => {
  it('an empty store is an empty vocabulary that ranks nothing; queries of one or two characters, of stop words or of punctuation have no terms', () => {
    const store = new EntityStore()
    const v = buildVocabulary(store, new TypeRegistry(store))
    expect(v).toEqual({ types: [], tags: [] })
    expect(lexicalRank('architecture', v)).toEqual({ method: 'lexical', types: [], tags: [], terms: ['architecture'] })
    expect(describeVocabulary(v)).toBe('')
    expect(vocabularyTexts(v)).toEqual({ types: [], tags: [] })
    for (const q of ['', 'a', 'ab', 'the', 'show me everything about the things', '?!,.', '   ', '🎉']) expect(terms(q), JSON.stringify(q)).toEqual([])
    expect(terms('abc')).toEqual(['abc'])
    expect(terms('A B C abc ABC')).toEqual(['abc'])
  })

  it('the stemmer: plural and verb endings come off, but never so far that a word vanishes — red, king, thing, users keep enough of themselves', () => {
    expect(terms('services documents studies applied boxes bushes classes houses')).toEqual(['service', 'document', 'study', 'apply', 'box', 'bush', 'class', 'house'])
    expect(terms('buildings building workers')).toEqual(['build', 'worker'])
    expect(terms('red king thing ring bed users papers')).toEqual(['red', 'king', 'thing', 'ring', 'bed', 'user', 'paper'])
    expect(terms('runs runes')).toEqual(['run', 'rune'])
  })

  it('diacritics split a word and non-Latin labels have no terms — a limit of the tokeniser; emoji stay in the samples; case never matters', () => {
    expect(terms('café Zürich naïve')).toEqual(['caf', 'rich'])
    expect(terms('会議 データ')).toEqual([])
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'c', type: 'café', label: 'Café 🎉', tags: ['Ünï'] }), createEntity({ id: 'j', type: '会議', label: '会議' })])
    const v = buildVocabulary(store, new TypeRegistry(store))
    expect(v.types.map((t) => t.name)).toEqual(['café', '会議'])
    expect(v.types[0].samples).toEqual(['Café 🎉'])
    expect(lexicalRank('CAFÉ', v).types.map((r) => [r.key, r.score])).toEqual([['café', 1]])
    expect(lexicalRank('会議', v).types).toEqual([])
    expect(lexicalRank('Ünï', v).tags).toEqual([]) // no term survives the tokeniser, so nothing can match
  })

  it('a name that is a type and a tag ranks in both lists; prefixes at the boundary score 0.6, exact stems 1, a word in a description 0.8; ties keep the count order', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'a', type: 'topology', label: 'A', tags: ['topology'] }),
      createEntity({ id: 'b', type: 'topology', label: 'B' }),
      createEntity({ id: 'c', type: 'service', label: 'C', tags: ['tier:app'] }),
      createEntity({ id: 'd', type: 'sermon', label: 'D' }),
    ])
    store.setTagInfo('tier:app', { description: 'The topology tier' })
    const v = buildVocabulary(store, new TypeRegistry(store))
    const r = lexicalRank('topology', v)
    expect(r.types.map((x) => [x.key, x.score])).toEqual([['topology', 1]])
    expect(r.tags.map((x) => [x.key, x.score])).toEqual([['topology', 1], ['tier:app', 0.8]]) // 0.8 × 1: the word is in the description
    store.setTagInfo('tier:app', { description: 'The topological tier' })
    expect(lexicalRank('topology', buildVocabulary(store, new TypeRegistry(store))).tags.map((x) => x.key)).toEqual(['topology']) // "topological" is not a prefix match either way
    expect(lexicalRank('topolog', v).types[0]).toEqual({ key: 'topology', score: 0.6 })
    expect(lexicalRank('topologies', v).types[0]).toEqual({ key: 'topology', score: 1 })
    expect(lexicalRank('app', v).tags.map((x) => [x.key, x.score])).toEqual([['tier:app', 1]])
    expect(lexicalRank('tier', v).tags.map((x) => [x.key, x.score])).toEqual([['tier:app', 1]])
    // Two words, one matching: half.
    expect(lexicalRank('topology unicorn', v).types[0]).toEqual({ key: 'topology', score: 0.5 })
    // 'ser' is a prefix of both service and sermon: the same score, the bigger type first.
    expect(lexicalRank('ser', v).types.map((x) => [x.key, x.score])).toEqual([['service', 0.6], ['sermon', 0.6]])
    expect(lexicalRank('unicorn', v)).toMatchObject({ types: [], tags: [], terms: ['unicorn'] })
  })

  it('samples stop at six, tags and links at five, relationships to missing ends and among one type count once; texts and lines for a model', () => {
    const store = new EntityStore()
    const ents = Array.from({ length: 10 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: i === 3 ? '   ' : `Note ${i}`, tags: [`t${i % 7}`, 'common'] }))
    store.upsertMany([...ents, createEntity({ id: 'p', type: 'person', label: 'P' })])
    store.upsertMany([
      ...Array.from({ length: 7 }, (_, i) => createRelationship({ id: `r${i}`, type: `rel${i}`, source: 'n0', target: 'n1' })),
      createRelationship({ id: 'x', type: 'knows', source: 'n0', target: 'p' }),
      createRelationship({ id: 'gone', type: 'ghost', source: 'n0', target: 'nowhere' }),
    ])
    const v = buildVocabulary(store, new TypeRegistry(store))
    const note = v.types.find((t) => t.name === 'note')!
    expect(note.count).toBe(10)
    expect(note.samples).toEqual(['Note 0', 'Note 1', 'Note 2', 'Note 4', 'Note 5', 'Note 6']) // six, the blank label skipped
    expect(note.tags.length).toBe(5)
    expect(note.tags[0]).toBe('common')
    expect(note.links.length).toBe(5)
    const person = v.types.find((t) => t.name === 'person')!
    expect(person.links).toEqual(['knows'])
    const common = v.tags.find((t) => t.tag === 'common')!
    expect(common).toMatchObject({ count: 10, types: ['Note'] })
    expect(common.samples.length).toBe(6)
    expect(typeText(person)).toBe('Person; e.g. P; linked by knows')
    expect(tagText(v.tags.find((t) => t.tag === 't0')!)).toBe('t0; on Note; e.g. Note 0, Note 7')
    store.setTagInfo('t0', { description: 'the first' })
    const v2 = buildVocabulary(store, new TypeRegistry(store))
    expect(tagText(v2.tags.find((t) => t.tag === 't0')!)).toBe('t0 — the first; on Note; e.g. Note 0, Note 7')
    const lines = describeVocabulary(v2, 1).split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^type note · (knowledge|entity|resource) · 10 · Note/)
    expect(lines[1]).toMatch(/^tag common · 10 · common; on Note; e\.g\. /)
    const texts = vocabularyTexts(v2)
    expect(texts.types[0].key).toBe(`type:note:${texts.types[0].text}`)
    expect(texts.tags.find((t) => t.key.startsWith('tag:t0:'))!.text).toBe('t0 — the first; on Note; e.g. Note 0, Note 7')
  })

  it('five thousand entities of fifty types build and rank in well under a second; the embedding rank asks for the phrase and its bare words, clamps and sorts', async () => {
    const store = new EntityStore()
    store.upsertMany(Array.from({ length: 5000 }, (_, i) => createEntity({ id: `e${i}`, type: `kind${i % 50}`, label: `Entity ${i}`, tags: [`tag${i % 100}`] })))
    const t0 = performance.now()
    const v = buildVocabulary(store, new TypeRegistry(store))
    const r = lexicalRank('kind7 tag99', v)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(v.types.length).toBe(50)
    expect(v.tags.length).toBe(100)
    expect(r.types[0].key).toBe('kind7')
    expect(r.tags[0].key).toBe('tag99')
    const asked: string[][] = []
    const embed = async (items: { key: string; text: string }[]) => {
      asked.push(items.map((i) => i.text))
      return items.map((i) => new Float32Array([i.text.toLowerCase().includes('kind7') ? 2 : i.text.startsWith('everything') ? 1 : -1]))
    }
    const small = { types: v.types.filter((t) => ['kind0', 'kind1', 'kind7'].includes(t.name)), tags: v.tags.slice(0, 2) }
    const er = await embeddingRank('everything about kind7', small, embed)
    expect(asked[0]).toEqual(['everything about kind7', 'kind7'])
    expect(er.method).toBe('embedding')
    expect(er.terms).toEqual(['kind7'])
    expect(er.types.every((t) => t.score >= 0 && t.score <= 1)).toBe(true)
    expect(er.types[0].key).toBe('kind7')
    expect(er.types[0].score).toBe(1) // clamped from 4
    expect(er.tags.every((t) => t.score === 0)).toBe(true) // negative similarities clamp to 0
  })
})

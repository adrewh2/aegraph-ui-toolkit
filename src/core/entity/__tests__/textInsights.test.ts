import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'
import { normalizeText, textInsights } from '../textInsights'
import '../../graph/types'

const labels = (list: { entity: { label?: string } }[]) => list.map((m) => m.entity.label)

function project() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'ada', type: 'person', label: 'Ada Lovelace', tags: ['mathematics'], data: { aliases: ['Countess of Lovelace'] } }),
    createEntity({ id: 'babbage', type: 'person', label: 'Charles Babbage', tags: ['mathematics', 'topic:engines'] }),
    createEntity({ id: 'engine', type: 'thing', label: 'Analytical Engine', tags: ['topic:engines'] }),
    createEntity({ id: 'the', type: 'thing', label: 'The' }),
    createEntity({ id: 'note', type: 'note', label: 'Reading notes', data: { content: 'Menabrea wrote about the Analytical Engine in 1842.' } }),
    createEntity({ id: 'doc', type: 'document', label: 'Sketch of the Engine', data: { content: 'Ada Lovelace translated it.' } }),
  ])
  s.upsert(createRelationship({ id: 'r', type: 'worked_with', source: 'ada', target: 'babbage', label: 'Ada Lovelace' }))
  return s
}

describe('what a passage has to do with the graph', () => {
  it('names the entities whose names appear in it as whole words, longest first — never relationships or stop words', () => {
    const r = textInsights(project(), 'In 1843 Ada Lovelace published notes on the Analytical Engine designed by Charles Babbage.')
    expect(labels(r.named)).toEqual(['Analytical Engine', 'Charles Babbage', 'Ada Lovelace'])
    expect(r.named.every((m) => m.how === 'phrase')).toBe(true)
    // Long selections are not searched as a phrase.
    expect(r.mentions).toEqual([])
  })

  it('finds an alias, and ignores case, accents and punctuation', () => {
    expect(labels(textInsights(project(), 'the COUNTESS of lovelace’s notes').named)).toEqual(['Ada Lovelace'])
    expect(normalizeText('Ádá-Lovelace: «notes»')).toBe('ada lovelace notes')
  })

  it('a short selection is also found inside longer names, and as a phrase in other entities’ text', () => {
    const r = textInsights(project(), 'Analytical Engine')
    expect(r.named[0]).toMatchObject({ how: 'whole', entity: { id: 'engine' } })
    expect(r.mentions.map((e) => e.id)).toEqual(['note'])
    const ada = textInsights(project(), 'Ada')
    expect(ada.named.map((m) => [m.entity.id, m.how])).toEqual([['ada', 'partial']])
  })

  it('matches tags by their name or last segment, with how many carry each', () => {
    const r = textInsights(project(), 'the history of mathematics and of engines')
    expect(r.tags).toEqual([
      { tag: 'mathematics', count: 2, matched: 'mathematics' },
      { tag: 'topic:engines', count: 2, matched: 'engines' },
    ])
  })

  it('leaves out what it is told to — the document the text came from', () => {
    const r = textInsights(project(), 'Engine', { exclude: ['doc'] })
    expect(r.named.map((m) => m.entity.id)).toEqual(['engine'])
    expect(textInsights(project(), 'Engine').named.map((m) => m.entity.id).sort()).toEqual(['doc', 'engine'])
  })

  it('follows a rename, and says nothing for nothing', () => {
    const s = project()
    expect(textInsights(s, 'the difference engine').named).toEqual([])
    s.upsert({ ...s.get('engine')!, label: 'Difference Engine' })
    expect(labels(textInsights(s, 'the difference engine').named)).toEqual(['Difference Engine'])
    expect(textInsights(s, '  ')).toMatchObject({ named: [], tags: [], mentions: [] })
  })
})

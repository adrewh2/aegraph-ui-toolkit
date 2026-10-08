import { describe, expect, it } from 'vitest'
import { isRelationship, type AnyEntity } from '../../entity/types'
import { validateAe } from '../ae/validate'
import { GENERATOR_TAG_INFO, generateAcademicGraph } from '../generate'

/**
 * The synthetic academic graph at its edges, on a few thousand entities
 * (its 200k timing test lives in bench.test.ts): a target of 0, 1 and 2
 * still gives the smallest world; a seed's determinism whatever the
 * chunk size; the id and label shapes; every relationship's ends in the
 * document and never itself; the vocabulary of types, eras and tags;
 * dates inside the three-year window and lives that make sense; the
 * chunked path adding up to the collected one; the document validating.
 */
const ERAS = ['ancient', 'medieval', 'renaissance', 'enlightenment', 'modern', 'contemporary']
const PERSON_TYPES = new Set(['philosopher', 'mathematician', 'scientist', 'poet', 'writer', 'artist', 'astronomer', 'polymath', 'playwright', 'physicist', 'chemist', 'biologist', 'economist', 'linguist', 'engineer', 'composer', 'historian', 'logician', 'physician', 'architect'])

describe('generator edges', () => {
  it('a target of 0, 1 or 2 gives the smallest world — five people, the top fields, the vocabulary — with the stats adding up and the total matching the list', () => {
    for (const target of [0, 1, 2, 60]) {
      const r = generateAcademicGraph({ target, seed: 9 })
      expect(r.stats.people, `target ${target}`).toBe(5)
      expect(r.stats.fields).toBe(25) // never fewer than the top-level fields
      expect(r.stats.schema).toBe(1 + 20 + 3)
      expect(r.stats.total).toBe(r.entities.length)
      expect(r.stats.people + r.stats.works + r.stats.concepts + r.stats.fields + r.stats.annotations + r.stats.relationships + r.stats.schema).toBe(r.stats.total)
      expect(r.stats.ms).toBeGreaterThanOrEqual(0)
    }
    expect(generateAcademicGraph({ target: 3000, seed: 9 }).stats.people).toBe(Math.round(3000 / 12.7))
    expect(generateAcademicGraph({ target: 3000 }).entities[0].id).toBe('type:person') // the default seed is 42 and the ontology comes first
  })

  it('the same seed gives the same document whatever the chunk size; the chunked path hands out every entity exactly once with a monotonic count, and returns none', () => {
    const whole = generateAcademicGraph({ target: 2500, seed: 5 })
    const chunks: AnyEntity[][] = []
    const counts: number[] = []
    const estimates = new Set<number>()
    const chunked = generateAcademicGraph({
      target: 2500,
      seed: 5,
      chunkSize: 100,
      onChunk: (entities, produced, estimated) => {
        chunks.push(entities)
        counts.push(produced)
        estimates.add(estimated)
      },
    })
    expect(chunked.entities).toEqual([])
    expect(chunked.stats).toMatchObject({ ...whole.stats, ms: expect.any(Number) })
    const joined = chunks.flat()
    expect(joined.map((e) => e.id)).toEqual(whole.entities.map((e) => e.id))
    expect(JSON.stringify(joined)).toBe(JSON.stringify(whole.entities))
    expect(counts.at(-1)).toBe(whole.entities.length)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1])
    expect(chunks.length).toBeGreaterThan(10)
    expect(estimates.size).toBe(1)
    expect([...estimates][0]).toBe(Math.round(Math.round(2500 / 12.7) * 12.7))
    // A chunk size of 1 (or nonsense) still delivers everything, one chunk per flush.
    const tiny: number[] = []
    generateAcademicGraph({ target: 200, seed: 5, chunkSize: 1, onChunk: (es) => tiny.push(es.length) })
    expect(tiny.reduce((a, b) => a + b, 0)).toBe(generateAcademicGraph({ target: 200, seed: 5 }).entities.length)
    const zero: number[] = []
    generateAcademicGraph({ target: 200, seed: 5, chunkSize: 0, onChunk: (es) => zero.push(es.length) })
    expect(zero.reduce((a, b) => a + b, 0)).toBe(tiny.reduce((a, b) => a + b, 0))
    // Two seeds differ in content and in every id prefix.
    const other = generateAcademicGraph({ target: 2500, seed: 6 })
    expect(other.entities.filter((e) => e.id.startsWith('gen6-')).length).toBe(other.entities.length - whole.stats.schema)
    expect(whole.entities.filter((e) => e.id.startsWith('gen5-')).length).toBe(whole.entities.length - whole.stats.schema)
  })

  it('ids are unique and shaped by kind; every relationship joins two entities in the document and never itself; the undirected ones are the disagreements between people', () => {
    const { entities, stats } = generateAcademicGraph({ target: 4000, seed: 11 })
    const ids = new Set(entities.map((e) => e.id))
    expect(ids.size).toBe(entities.length)
    const shapes = { f: 0, p: 0, w: 0, c: 0, a: 0, r: 0, type: 0 }
    for (const e of entities) {
      const m = /^gen11-([fpwcar])-/.exec(e.id)
      if (m) shapes[m[1] as keyof typeof shapes]++
      else if (e.id.startsWith('type:')) shapes.type++
      else throw new Error(`unexpected id ${e.id}`)
    }
    expect(shapes).toEqual({ f: stats.fields, p: stats.people, w: stats.works, c: stats.concepts, a: stats.annotations, r: stats.relationships, type: stats.schema })
    const byId = new Map(entities.map((e) => [e.id, e]))
    let undirected = 0
    for (const e of entities) {
      if (!isRelationship(e)) continue
      expect(ids.has(e.source.id), e.id).toBe(true)
      expect(ids.has(e.target.id), e.id).toBe(true)
      expect(e.source.id, e.id).not.toBe(e.target.id)
      if (!e.directed) {
        undirected++
        expect(e.type).toBe('disagrees with')
        expect(PERSON_TYPES.has(byId.get(e.source.id)!.type)).toBe(true)
        expect(PERSON_TYPES.has(byId.get(e.target.id)!.type)).toBe(true)
      }
      if (e.type === 'annotates') expect(e.target.selector).toMatchObject({ kind: 'text', exact: expect.any(String) })
      if (e.type === 'influenced') expect(e.tags.every((t) => t === 'disputed')).toBe(true)
      else expect(e.tags).toEqual([])
    }
    expect(undirected).toBeGreaterThan(0)
    // Every work has exactly one author and one field; every subfield one parent.
    const inbound = new Map<string, number>()
    for (const e of entities) if (isRelationship(e) && e.type === 'contributed') inbound.set(e.target.id, (inbound.get(e.target.id) ?? 0) + 1)
    for (const e of entities) if (e.type === 'major work') expect(inbound.get(e.id), e.id).toBe(1)
    const parents = entities.filter((e) => isRelationship(e) && e.type === 'subcategory of').length
    expect(parents).toBe(stats.fields - 25)
  })

  it('types, eras and tags come from the vocabulary; lives, works and concepts are dated inside them; every createdAt lies in the three-year window; labels are never empty', () => {
    const { entities } = generateAcademicGraph({ target: 4000, seed: 13 })
    const lo = Date.UTC(2023, 0, 1)
    const hi = Date.UTC(2026, 0, 1)
    const tagVocabulary = new Set([...PERSON_TYPES, ...ERAS, 'work', 'lost', 'annotation', 'todo', 'concept', 'field', 'disputed'])
    for (const e of entities) {
      const t = Date.parse(e.meta.createdAt)
      expect(t, e.id).toBeGreaterThanOrEqual(lo)
      expect(t, e.id).toBeLessThan(hi)
      expect(e.meta.updatedAt).toBe(e.meta.createdAt)
      expect(e.meta.source).toBe('generator')
      if (isRelationship(e)) continue
      expect(e.label, e.id).toBeTruthy()
      for (const tag of e.tags) expect(tagVocabulary.has(tag) || /^[a-z-]+$/.test(tag), `${e.id} ${tag}`).toBe(true)
      if (PERSON_TYPES.has(e.type)) {
        const d = e.data as { born: number; died: number; era: string; nationality: string; primaryField: string }
        expect(ERAS).toContain(d.era)
        expect(d.died - d.born).toBeGreaterThanOrEqual(35)
        expect(d.died - d.born).toBeLessThanOrEqual(95)
        expect(e.tags).toEqual([e.type, d.era, expect.stringMatching(/^[a-z-]+$/)])
      } else if (e.type === 'major work') {
        expect(e.tags[0]).toBe('work')
        expect(typeof (e.data as { year: number }).year).toBe('number')
        expect(e.description).toBeTruthy()
      } else if (e.type === 'concept') {
        expect(e.tags[0]).toBe('concept')
      } else if (e.type === 'field') {
        expect(e.tags[0]).toBe('field')
        expect([0, 1]).toContain((e.data as { depth: number }).depth)
      } else if (e.type === 'annotation') {
        expect(e.data).toMatchObject({ annotationType: 'text', comment: expect.any(String), selectedText: expect.any(String) })
        expect((e.label ?? '').length).toBeLessThanOrEqual(48)
      } else expect(e.type).toBe('schema:type')
    }
    // Works fall within the author's productive years.
    const people = new Map(entities.filter((e) => PERSON_TYPES.has(e.type)).map((e) => [e.id, e.data as { born: number; died: number }]))
    for (const e of entities) {
      if (!isRelationship(e) || e.type !== 'contributed') continue
      const p = people.get(e.source.id)!
      const year = (e.data as { year: number }).year
      expect(year, e.id).toBeGreaterThanOrEqual(p.born + 20)
      expect(year, e.id).toBeLessThanOrEqual(Math.min(p.died, p.born + 70))
    }
    for (const info of GENERATOR_TAG_INFO) expect(tagVocabulary.has(info.tag)).toBe(true)
  })

  it('the generated document validates as aegraph/v1: every type definition well-formed, no duplicates, nothing unresolved', () => {
    const { entities } = generateAcademicGraph({ target: 3000, seed: 17 })
    const report = validateAe({ $schema: 'aegraph/v1', entities })
    expect(report.issues).toEqual([])
    expect(report).toMatchObject({ ok: true, duplicates: [], unresolved: [] })
    expect(report.entities + report.relationships).toBe(entities.length)
    const defs = entities.filter((e) => e.type === 'schema:type')
    expect(defs.map((d) => d.id)).toContain('type:major work')
    expect(defs.filter((d) => (d.data as { parent?: string }).parent === 'person').length).toBe(20)
  })
})

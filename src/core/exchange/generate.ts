import { SCHEMA_TYPE, schemaTypeId } from '../entity/categories'
import type { AnyEntity, Entity, Relationship } from '../entity/types'

/**
 * Deterministic synthetic academic knowledge graph, shaped like AcademicsKG:
 * people → works → fields, a field hierarchy, concepts people wrote/invented,
 * influence and disagreement between people and concepts, and a sprinkling
 * of annotations on works.
 *
 * Pure and seedable: the same (seed, scale) always yields the same ids and
 * content, so regenerating merges idempotently. No DOM or store dependency,
 * so it runs unchanged inside a Web Worker.
 */

export interface GenerateOptions {
  /** Approximate total entities including relationships. */
  target: number
  seed?: number
  /** Called with chunks as they're produced; when given, the return value omits `entities`. */
  onChunk?: (entities: AnyEntity[], produced: number, estimated: number) => void
  chunkSize?: number
}

export interface GenerateStats {
  people: number
  works: number
  concepts: number
  fields: number
  annotations: number
  relationships: number
  schema: number
  total: number
  ms: number
}

export interface GenerateResult {
  stats: GenerateStats
  entities: AnyEntity[]
}

// ── PRNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Vocabulary ────────────────────────────────────────────────────────

const TOP_FIELDS = [
  'Mathematics', 'Physics', 'Philosophy', 'Computer Science', 'Chemistry', 'Biology', 'Literature', 'Art', 'Astronomy',
  'Political Science', 'Economics', 'Linguistics', 'Medicine', 'Engineering', 'Music', 'History', 'Geology', 'Psychology',
  'Sociology', 'Law', 'Architecture', 'Theology', 'Anthropology', 'Statistics', 'Logic',
]
const FIELD_PREFIXES = [
  'Applied', 'Theoretical', 'Computational', 'Experimental', 'Comparative', 'Classical', 'Modern', 'Quantitative', 'Analytic',
  'Continental', 'Structural', 'Cognitive', 'Evolutionary', 'Molecular', 'Abstract', 'Formal', 'Historical', 'Social', 'Mathematical',
  'Political', 'Moral', 'Natural', 'Organic', 'Digital', 'Urban', 'Medieval', 'Renaissance', 'Baroque', 'Romantic', 'Ancient',
]
const PERSON_TYPES = [
  'philosopher', 'mathematician', 'scientist', 'poet', 'writer', 'artist', 'astronomer', 'polymath', 'playwright', 'physicist',
  'chemist', 'biologist', 'economist', 'linguist', 'engineer', 'composer', 'historian', 'logician', 'physician', 'architect',
]
const ERAS: [string, number, number][] = [
  ['ancient', -800, 400],
  ['medieval', 400, 1400],
  ['renaissance', 1400, 1650],
  ['enlightenment', 1650, 1800],
  ['modern', 1800, 1950],
  ['contemporary', 1950, 2020],
]
const FIRST = [
  'Ada', 'Alan', 'Albert', 'Alhazen', 'Anaximander', 'Aristarchus', 'Augustine', 'Avicenna', 'Bertrand', 'Blaise', 'Carl', 'Charles',
  'Claude', 'David', 'Dmitri', 'Emmy', 'Erwin', 'Euclid', 'Fibonacci', 'Francis', 'Galileo', 'Georg', 'Gottfried', 'Grace', 'Hannah',
  'Henri', 'Hildegard', 'Hypatia', 'Ibn', 'Immanuel', 'Isaac', 'Jane', 'Johannes', 'John', 'Karl', 'Kurt', 'Leonhard', 'Lise', 'Ludwig',
  'Marie', 'Max', 'Michael', 'Niels', 'Nikola', 'Noam', 'Omar', 'Paul', 'Pierre', 'René', 'Richard', 'Rosalind', 'Simone', 'Sofia',
  'Srinivasa', 'Thomas', 'Virginia', 'Werner', 'William', 'Wolfgang', 'Zeno', 'Amara', 'Bao', 'Chidi', 'Dara', 'Elif', 'Farah', 'Gita',
  'Hiro', 'Inés', 'Jun', 'Kofi', 'Leila', 'Mateo', 'Nadia', 'Olu', 'Priya', 'Quinn', 'Rafael', 'Sana', 'Tariq', 'Uma', 'Vikram', 'Wen',
  'Ximena', 'Yara', 'Zara',
]
const LAST = [
  'Lovelace', 'Turing', 'Einstein', 'Bohr', 'Curie', 'Noether', 'Euler', 'Gauss', 'Leibniz', 'Newton', 'Kepler', 'Galilei', 'Descartes',
  'Kant', 'Hume', 'Russell', 'Gödel', 'Hilbert', 'Riemann', 'Cantor', 'Pascal', 'Fermat', 'Laplace', 'Fourier', 'Maxwell', 'Faraday',
  'Darwin', 'Mendel', 'Franklin', 'Hopper', 'Shannon', 'Neumann', 'Chomsky', 'Arendt', 'Beauvoir', 'Woolf', 'Austen', 'Goethe', 'Dante',
  'Ovid', 'Virgil', 'Homer', 'Sappho', 'Khayyam', 'Sina', 'Haytham', 'Bingen', 'Aquinas', 'Ockham', 'Bacon', 'Boyle', 'Lavoisier',
  'Mendeleev', 'Tesla', 'Planck', 'Heisenberg', 'Schrödinger', 'Meitner', 'Ramanujan', 'Kovalevskaya', 'Weil', 'Okafor', 'Nakamura',
  'Haddad', 'Ivanova', 'Rossi', 'Schmidt', 'Dubois', 'Nguyen', 'Mensah', 'Rahman', 'Silva', 'Kowalski', 'Andersen', 'Yamamoto',
  'Castillo', 'Petrov', 'Bakshi', 'Osei', 'Lindqvist', 'Fischer', 'Moreau', 'Tanaka', 'Adeyemi', 'Varga',
]
const TOPICS = [
  'motion', 'number', 'form', 'being', 'knowledge', 'justice', 'light', 'the soul', 'infinity', 'probability', 'language', 'the state',
  'value', 'time', 'space', 'life', 'mind', 'harmony', 'proportion', 'chance', 'virtue', 'the heavens', 'the elements', 'perception',
  'memory', 'the will', 'beauty', 'truth', 'evidence', 'computation', 'symmetry', 'change', 'the atom', 'the cell', 'the gene',
  'the market', 'the sign', 'the sublime', 'method', 'doubt', 'measure', 'the void', 'the continuum', 'induction', 'the good',
]
const ADJ = ['general', 'special', 'pure', 'natural', 'critical', 'universal', 'elementary', 'transcendental', 'analytic', 'synthetic', 'first', 'new', 'complete', 'partial', 'dynamic', 'static']
const NOUN = ['theory', 'principle', 'method', 'paradox', 'law', 'conjecture', 'lemma', 'doctrine', 'axiom', 'hypothesis', 'model', 'calculus', 'algebra', 'system', 'problem', 'critique']
const WORK_TEMPLATES = [
  'On {topic}',
  'Principles of {field}',
  'A Treatise on {topic}',
  'Elements of {field}',
  'Critique of {topic}',
  'Meditations on {topic}',
  'The {Adj} {Noun}',
  '{Topic}: A {Adj} Approach',
  'Discourse on {topic}',
  'Essay concerning {topic}',
  'Foundations of {field}',
  'Dialogues on {topic}',
  'The Nature of {topic}',
  'An Inquiry into {topic}',
  'Lectures on {field}',
  'Notes toward a {Adj} {Noun}',
]
const DESC_TEMPLATES = [
  'Treatise on {topic} within {field}',
  'Foundational text of {field}',
  'Argues that {topic} is prior to {topic2}',
  'A {adj} account of {topic}',
  'Introduces the {adj} {noun} of {topic}',
  'Reply to critics concerning {topic}',
  'Collected lectures on {topic} and {topic2}',
]
const CONCEPT_TEMPLATES = ['{adj} {noun} of {topic}', "{Last}'s {noun}", 'the {noun} of {topic}', '{adj} {topic}', '{Topic} {noun}']
const COMMENTS = [
  'Key passage — cite in the overview.',
  'This anticipates later work by decades.',
  'Disputed attribution; check the manuscript history.',
  'Compare with the treatment in {field}.',
  'The argument here is weaker than usually claimed.',
  'Useful summary of {topic}.',
  'Translation differs from the standard edition.',
]
const NATIONS = ['Greek', 'Persian', 'Chinese', 'Indian', 'Arab', 'Italian', 'French', 'German', 'English', 'Dutch', 'Russian', 'Japanese', 'Nigerian', 'Brazilian', 'Egyptian', 'Turkish', 'Polish', 'Swedish', 'Mexican', 'Korean']

// ── Generator ─────────────────────────────────────────────────────────

export function generateAcademicGraph(opts: GenerateOptions): GenerateResult {
  const t0 = performance.now()
  const seed = opts.seed ?? 42
  const rnd = mulberry32(seed)
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const chance = (p: number) => rnd() < p
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  // Each person yields ≈ 1 + 2.4 works + 1.6 concepts + rels(2 per work, 1.5 per concept, 2 influence, 0.3 disagree, 0.4 annotations*2)
  // ≈ 12.7 entities per person. Solve for people from the target.
  const perPerson = 12.7
  const peopleN = Math.max(5, Math.round(opts.target / perPerson))
  const fieldsN = Math.min(4000, Math.max(TOP_FIELDS.length, Math.round(Math.sqrt(peopleN) * 3)))
  const chunkSize = opts.chunkSize ?? 5000
  const estimated = Math.round(peopleN * perPerson)

  const prefix = `gen${seed}`
  const out: AnyEntity[] = []
  const collected: AnyEntity[] = []
  let produced = 0
  const stats = { people: 0, works: 0, concepts: 0, fields: 0, annotations: 0, relationships: 0, schema: 0 }

  const flush = (force = false) => {
    if (out.length === 0) return
    if (!force && out.length < chunkSize) return
    produced += out.length
    if (opts.onChunk) opts.onChunk(out.splice(0), produced, estimated)
    else collected.push(...out.splice(0))
  }

  const iso = (yearOffset: number) => {
    // Spread created dates over the last ~3 years, deterministic.
    const d = new Date(Date.UTC(2023, 0, 1) + Math.floor(rnd() * 3 * 365 * 86_400_000) + yearOffset)
    return d.toISOString()
  }

  const entity = (id: string, type: string, label: string, data: Record<string, unknown>, tags: string[], description?: string): Entity => {
    const createdAt = iso(0)
    const e: Entity = { id, kind: 'entity', type, label, tags, data, meta: { createdAt, updatedAt: createdAt, source: 'generator' } }
    if (description) e.description = description
    out.push(e)
    return e
  }

  const rel = (type: string, source: string, target: string, extra?: Partial<Relationship>): Relationship => {
    const createdAt = iso(0)
    const r: Relationship = {
      id: `${prefix}-r-${stats.relationships}`,
      kind: 'relationship',
      type,
      tags: [],
      data: {},
      meta: { createdAt, updatedAt: createdAt, source: 'generator' },
      source: { id: source },
      target: { id: target },
      directed: true,
      ...extra,
    }
    stats.relationships++
    out.push(r)
    return r
  }

  // Ontology: the person subtypes and the structural types, as schema entities.
  const schema = (name: string, label: string, extra: Record<string, unknown>, description?: string): Entity => {
    const createdAt = iso(0)
    return {
      id: schemaTypeId(name),
      kind: 'entity',
      type: SCHEMA_TYPE,
      label,
      description,
      tags: [],
      data: { name, category: 'knowledge', ...extra },
      meta: { createdAt, updatedAt: createdAt, source: 'generator' },
    }
  }
  out.push(schema('person', 'Person', { color: '#f8fafc' }, 'A thinker. Roles are subtypes.'))
  for (const t of PERSON_TYPES) out.push(schema(t, cap(t), { parent: 'person', color: `hsl(${(PERSON_TYPES.indexOf(t) * 137) % 360} 45% 85%)` }))
  out.push(schema('major work', 'Major work', { color: '#a4c0db', pluralLabel: 'Major works' }, 'A significant work by a person.'))
  out.push(schema('field', 'Field', { color: '#eadbc8' }, 'A field of study.'))
  out.push(schema('concept', 'Concept', { color: '#bcccdc' }, 'An idea, theory, or invention.'))
  stats.schema = out.length

  // Fields: top-level first, then prefixed subfields with parent links.
  const fieldIds: string[] = []
  const fieldLabels: string[] = []
  const fieldTop: string[] = []
  for (let i = 0; i < fieldsN; i++) {
    const top = i < TOP_FIELDS.length ? TOP_FIELDS[i] : TOP_FIELDS[Math.floor(rnd() * TOP_FIELDS.length)]
    const label = i < TOP_FIELDS.length ? top : `${pick(FIELD_PREFIXES)} ${top}${i >= TOP_FIELDS.length + TOP_FIELDS.length * FIELD_PREFIXES.length ? ` ${i}` : ''}`
    const id = `${prefix}-f-${i}`
    fieldIds.push(id)
    fieldLabels.push(label)
    fieldTop.push(top)
    entity(id, 'field', label, { topLevel: top, depth: i < TOP_FIELDS.length ? 0 : 1 }, ['field', top.toLowerCase().replace(/\s+/g, '-')])
    stats.fields++
    if (i >= TOP_FIELDS.length) rel('subcategory of', id, `${prefix}-f-${TOP_FIELDS.indexOf(top)}`)
    flush()
  }

  // People, with era + primary field. Keep a per-era list for plausible influence edges.
  const peopleByEra: string[][] = ERAS.map(() => [])
  const personEra: number[] = []
  const personLast: string[] = []
  const personField: number[] = []
  const conceptIds: string[] = []
  for (let i = 0; i < peopleN; i++) {
    const eraIdx = Math.floor(rnd() * ERAS.length)
    const [era, from, to] = ERAS[eraIdx]
    const born = int(from, to - 30)
    const died = born + int(35, 95)
    const type = pick(PERSON_TYPES)
    const fi = Math.floor(rnd() * fieldIds.length)
    const first = pick(FIRST)
    const last = pick(LAST)
    const id = `${prefix}-p-${i}`
    const nationality = pick(NATIONS)
    entity(
      id,
      type,
      `${first} ${last}${chance(0.08) ? ` ${['the Elder', 'the Younger', 'of ' + pick(['Alexandria', 'Miletus', 'Basra', 'Cordoba', 'Padua', 'Uppsala'])][int(0, 2)]}` : ''}`,
      { born, died, era, nationality, primaryField: fieldLabels[fi] },
      [type, era, fieldTop[fi].toLowerCase().replace(/\s+/g, '-')],
    )
    stats.people++
    peopleByEra[eraIdx].push(id)
    personEra.push(eraIdx)
    personLast.push(last)
    personField.push(fi)

    // Works
    const worksN = int(1, 4)
    for (let w = 0; w < worksN; w++) {
      const topic = pick(TOPICS)
      const topic2 = pick(TOPICS)
      const wf = chance(0.7) ? fi : Math.floor(rnd() * fieldIds.length)
      const field = fieldLabels[wf]
      const fill = (t: string) =>
        t
          .replace('{topic}', topic)
          .replace('{Topic}', cap(topic))
          .replace('{topic2}', topic2)
          .replace('{field}', field)
          .replace('{Adj}', cap(pick(ADJ)))
          .replace('{adj}', pick(ADJ))
          .replace('{Noun}', cap(pick(NOUN)))
          .replace('{noun}', pick(NOUN))
          .replace('{Last}', last)
      const wid = `${prefix}-w-${i}-${w}`
      const year = int(born + 20, Math.min(died, born + 70))
      entity(wid, 'major work', fill(pick(WORK_TEMPLATES)), { year, field, pages: int(40, 900), language: pick(['Greek', 'Latin', 'Arabic', 'English', 'French', 'German', 'Chinese', 'Sanskrit']) }, ['work', era, ...(chance(0.15) ? ['lost'] : [])], fill(pick(DESC_TEMPLATES)))
      stats.works++
      rel('contributed', id, wid, { data: { year } })
      rel('within the field of', wid, fieldIds[wf])

      // Annotations on some works, with a text selector into the description.
      if (chance(0.15)) {
        const aid = `${prefix}-a-${i}-${w}`
        const comment = fill(pick(COMMENTS))
        entity(aid, 'annotation', comment.slice(0, 48), { annotationType: 'text', comment, selectedText: topic }, ['annotation', ...(chance(0.3) ? ['todo'] : [])])
        stats.annotations++
        rel('annotates', aid, wid, { target: { id: wid, selector: { kind: 'text', exact: topic } } })
      }
    }

    // Concepts
    const conceptsN = int(0, 3)
    for (let c = 0; c < conceptsN; c++) {
      const topic = pick(TOPICS)
      const label = pick(CONCEPT_TEMPLATES)
        .replace('{adj}', pick(ADJ))
        .replace('{noun}', pick(NOUN))
        .replace('{topic}', topic)
        .replace('{Topic}', cap(topic))
        .replace('{Last}', last)
      const cid = `${prefix}-c-${i}-${c}`
      entity(cid, 'concept', label, { field: fieldLabels[fi], introduced: int(born + 20, died) }, ['concept', fieldTop[fi].toLowerCase().replace(/\s+/g, '-')])
      stats.concepts++
      rel(pick(['wrote', 'invented', 'developed', 'adopted', 'adopted']), id, cid)
      if (chance(0.5)) rel('within the field of', cid, fieldIds[fi])
      // Concept-to-concept tension with an earlier concept from anyone.
      if (chance(0.3) && conceptIds.length > 5) {
        rel(pick(['contradicts', 'disagrees with', 'extends', 'refines']), cid, conceptIds[Math.floor(rnd() * conceptIds.length)])
      }
      conceptIds.push(cid)
    }
    flush()
  }

  // Influence: earlier-or-same era → this person. Two per person on average.
  for (let i = 0; i < peopleN; i++) {
    const era = personEra[i]
    const n = int(0, 4)
    for (let k = 0; k < n; k++) {
      const fromEra = int(0, era)
      const pool = peopleByEra[fromEra]
      if (pool.length === 0) continue
      const src = pool[Math.floor(rnd() * pool.length)]
      if (src === `${prefix}-p-${i}`) continue
      rel('influenced', src, `${prefix}-p-${i}`, chance(0.2) ? { tags: ['disputed'] } : undefined)
    }
    if (chance(0.3)) {
      const pool = peopleByEra[era]
      const other = pool[Math.floor(rnd() * pool.length)]
      if (other && other !== `${prefix}-p-${i}`) rel('disagrees with', `${prefix}-p-${i}`, other, { directed: false })
    }
    if (i % 2000 === 0) flush()
  }
  flush(true)

  const total = stats.people + stats.works + stats.concepts + stats.fields + stats.annotations + stats.relationships + stats.schema
  return { stats: { ...stats, total, ms: performance.now() - t0 }, entities: collected }
}

export const GENERATOR_TAG_INFO = [
  { tag: 'disputed', color: '#fecaca', description: 'Attribution or influence not firmly established.' },
  { tag: 'lost', color: '#e5e7eb', description: 'Work known only through later references.' },
  { tag: 'todo', color: '#fde68a' },
]

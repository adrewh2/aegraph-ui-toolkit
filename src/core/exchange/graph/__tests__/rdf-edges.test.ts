import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../entity/store'
import '../../../graph/types'
import { applyGraphPlan, inferGraphMapping, planGraphImport } from '../mapping'
import { compactIri, expandIri, localName, parseRdf, rdfFormatFor, words } from '../rdf'

/**
 * The RDF importer at its edges: literals of every datatype and what the
 * attributes hold, labels and text chosen by language, descriptions from
 * a comment or a long abstract, types from broad, ranked and tied
 * classes, tags from two predicates capped, web addresses kept as data,
 * blank nodes counted, Turtle prefixes, a base and comments, escapes,
 * a duplicated triple, a thing first only referred to and later
 * described, malformed input, predicates asked to be skipped, and the
 * helpers.
 */
const EX = 'http://example.org/'
const ttl = (body: string) => `@prefix ex: <${EX}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n@prefix dct: <http://purl.org/dc/terms/> .\n@prefix dbo: <http://dbpedia.org/ontology/> .\n@prefix schema: <http://schema.org/> .\n@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n${body}`
const one = (body: string, opts = {}) => parseRdf(ttl(body), opts).nodes.find((n) => n.id === 'ex:a')!

describe('rdf edges', () => {
  it('reads literals by datatype: numbers of every numeric type, booleans, dates and plain text as text, a number that is not one as its text', () => {
    const a = one(`ex:a ex:i "3"^^xsd:integer ; ex:d "2.5"^^xsd:decimal ; ex:f "1e3"^^xsd:double ; ex:n "-7"^^xsd:nonNegativeInteger ; ex:t "true"^^xsd:boolean ; ex:no "false"^^xsd:boolean ; ex:date "2020-02-29"^^xsd:date ; ex:plain "text" ; ex:bad "abc"^^xsd:integer ; ex:big "123456789012345678901234567890"^^xsd:integer .`)
    expect(a.attrs).toMatchObject({ i: 3, d: 2.5, f: 1000, n: -7, t: true, no: false, date: '2020-02-29', plain: 'text', bad: 'abc' })
    expect(a.attrs.big).toBe(1.2345678901234568e29) // precision lost, but a number
    expect(a.label).toBe('a') // no label: the local name
  })

  it('picks the label and text in the asked language, else with no language, else the first language alone, and never mixes languages', () => {
    const body = `ex:a rdfs:label "de"@de , "fr"@fr , "en"@en ; ex:name "x"@fr , "y"@de , "z"@de ; ex:t "plain" , "p2"@en .`
    expect(one(body).label).toBe('en')
    expect(one(body, { lang: 'fr' }).label).toBe('fr')
    expect(one(body, { lang: 'nl' }).label).toBe('de') // none asked: the first language seen, alone
    expect(one(body, { lang: 'nl' }).attrs.name).toBe('x') // fr came first for name
    expect(one(body, { lang: 'de' }).attrs.name).toEqual(['y', 'z'])
    expect(one(body, { lang: 'nl' }).attrs.t).toBe('plain') // no language beats a wrong one
    expect(one(body).attrs.t).toBe('p2')
    // Every label predicate counts, and skos:prefLabel is one of them.
    expect(one(`ex:a skos:prefLabel "Pref"@en ; foaf:name "Name"@en .`).label).toBe('Pref')
    expect(one(`ex:a foaf:name "Name" .`).label).toBe('Name')
  })

  it('describes from a comment, else a shortened abstract, keeps the abstract beside a comment, and drops literals that would clash with the reserved keys', () => {
    const long = 'word '.repeat(100).trim()
    const cut = one(`ex:a dbo:abstract "${long}"@en .`).attrs.description as string
    expect(cut).toMatch(/^(word )+word…$/) // cut at a word, no partial word before the ellipsis
    expect(cut.length).toBeLessThanOrEqual(400)
    expect(cut.length).toBeGreaterThan(390)
    expect(one(`ex:a dbo:abstract "${long}"@en .`).attrs.abstract).toBeUndefined()
    const both = one(`ex:a rdfs:comment "Short."@en ; dbo:abstract "${long}"@en ; schema:description "Other"@en .`)
    expect(both.attrs.description).toBe('Short.')
    expect(both.attrs.abstract).toBe(long)
    expect(one(`ex:a ex:type "literal type" ; ex:description "lit" ; ex:tags "lit" ; ex:iri "lit" ; ex:kept "k" .`).attrs).toEqual({ iri: EX + 'a', kept: 'k' })
  })

  it('types by the most specific class: ranked namespaces, then the rarer class in the file, then the longer name; broad classes only when alone; foreign ontologies never', () => {
    const g = parseRdf(ttl(`ex:a a dbo:Person , dbo:Writer , dbo:Artist , <http://www.wikidata.org/entity/Q5> .\nex:b a dbo:Writer .\nex:c a dbo:Person .\nex:d a <http://www.wikidata.org/entity/Q5> .\nex:e a foaf:Agent , schema:Book .\nex:f a dbo:Language , dbo:ProgrammingLanguage .\nex:g a ex:Local .`))
    const type = (id: string) => g.nodes.find((n) => n.id === id)!.attrs.type
    expect(type('ex:a')).toBe('Artist') // Writer has two members, Artist one
    expect(type('ex:c')).toBe('Person')
    expect(type('ex:d')).toBeUndefined()
    expect(type('ex:e')).toBe('Book') // schema outranks foaf
    expect(type('ex:f')).toBe('Programming Language') // same rank and count: the longer name
    expect(type('ex:g')).toBe('Local')
    const m = inferGraphMapping(g, 'x.ttl')
    const plan = planGraphImport(new EntityStore(), g, m)
    expect(plan.entities.find((e) => e.id === 'ex:d')?.type).toBe('node')
    expect(plan.entities.find((e) => e.id === 'ex:a')?.type).toBe('artist')
  })

  it('tags from subjects and broader terms, deduplicated and capped; web addresses and bare namespaces as data, never nodes; several values as a list', () => {
    const cats = Array.from({ length: 5 }, (_, i) => `dct:subject <${EX}Category:C${i}>`).join(' ; ')
    const a = one(`ex:a ${cats} ; skos:broader <${EX}Category:C0> ; foaf:homepage <https://a.example/> , <https://b.example/> ; schema:url <https://u.example/x> ; ex:site <https://site.example/> ; ex:link <${EX}b> .`, { maxTags: 3 })
    expect(a.attrs.tags).toEqual(['C0', 'C1', 'C2'])
    expect(a.attrs.homepage).toEqual(['https://a.example/', 'https://b.example/'])
    expect(a.attrs.url).toBe('https://u.example/x')
    expect(a.attrs.site).toBe('https://site.example/') // an IRI ending in `/` has no name of its own
    const g = parseRdf(ttl(`ex:a foaf:homepage <https://a.example/> ; ex:link <${EX}b> .`))
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['ex:a', 'ex:b'])
    expect(g.edges).toEqual([{ source: 'ex:a', target: 'ex:b', directed: true, attrs: { type: 'link', predicate: 'ex:link' } }])
  })

  it('counts blank nodes out on either side, reads a base, comments and blank lines, and unescapes strings', () => {
    const g = parseRdf(`@base <${EX}> .\n# a comment\n\n<a> <p> _:b1 .\n_:b1 <p> <c> .\n<a> <http://www.w3.org/2000/01/rdf-schema#label> "say \\"hi\\"\\n\\u00e9" .\n<a> <q> <c> .\n`)
    expect(g.nodes.map((n) => n.id)).toEqual([EX + 'a', EX + 'c']) // no prefix declared for the base: full IRIs stand
    expect(g.nodes[0].label).toBe('say "hi"\né')
    expect(g.edges).toHaveLength(1)
    expect(g.warnings).toEqual(['2 triples with blank nodes skipped', '1 things only referred to were added with just a label — turn stubs off to leave them out'])
  })

  it("uses the document's prefixes for ids and skip lists, but a known prefix is not redefined", () => {
    const g = parseRdf(`@prefix my: <${EX}> .\n@prefix dbr: <http://not-dbpedia.example/> .\nmy:a my:knows my:b ; my:noise my:c .\n<http://dbpedia.org/resource/X> my:knows my:a .\n<http://not-dbpedia.example/Y> my:knows my:a .\n`, { skipPredicates: ['my:noise'] })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['dbr:X', 'http://not-dbpedia.example/Y', 'my:a', 'my:b'])
    expect(g.edges.map((e) => e.attrs.predicate)).toEqual(['my:knows', 'my:knows', 'my:knows'])
    expect(g.warnings[0]).toMatch(/^1 triples on wiki-plumbing/)
  })

  it('does not repeat an edge for a triple stated twice', () => {
    const g = parseRdf(ttl(`ex:a ex:knows ex:b .\nex:a ex:knows ex:b .\nex:a ex:knows ex:c .`))
    expect(g.edges.map((e) => e.target)).toEqual(['ex:b', 'ex:c'])
  })

  it('makes a stub for a thing only referred to, none when it is described later in the file, and the stub mark leaves once the thing is described', () => {
    const g = parseRdf(ttl(`ex:a ex:knows ex:b .\nex:b rdfs:label "B"@en .`))
    expect(g.nodes.map((n) => [n.id, n.attrs.stub])).toEqual([['ex:a', undefined], ['ex:b', undefined]])
    expect(g.warnings).toEqual([])
    const off = parseRdf(ttl(`ex:a ex:knows ex:zz .`), { stubs: false })
    expect(off.nodes).toHaveLength(1)
    expect(off.edges).toHaveLength(0)
    expect(off.warnings).toEqual(['1 links to things not in the file left out'])
    // First file: only a reference. Second: the thing itself.
    const s = new EntityStore()
    const first = parseRdf(ttl(`ex:a ex:knows ex:b .`))
    applyGraphPlan(s, planGraphImport(s, first, inferGraphMapping(first, 'one.ttl')))
    expect(s.get('ex:b')).toMatchObject({ label: 'b', type: 'node', data: { stub: true } })
    const second = parseRdf(ttl(`ex:b rdfs:label "Bee"@en ; a ex:Thing ; ex:n "1"^^xsd:integer .`))
    const plan = planGraphImport(s, second, inferGraphMapping(second, 'two.ttl'))
    expect(plan.updated).toBe(1)
    applyGraphPlan(s, plan)
    expect(s.get('ex:b')).toMatchObject({ label: 'Bee', type: 'thing', data: { n: 1 } })
    expect(s.get('ex:b')!.data).not.toHaveProperty('stub')
  })

  it('reports where malformed input fails and accepts quads and an explicit format', () => {
    expect(() => parseRdf(`<${EX}a> <${EX}p> "unterminated .\n<${EX}a> <${EX}p> <${EX}b> .`)).toThrow(/Not valid RDF: .*line 1/)
    expect(() => parseRdf(`<${EX}a> <${EX}p> <${EX}b> .\nthis is not rdf`)).toThrow(/line 2/)
    expect(() => parseRdf(`<${EX}a> <${EX}p> <${EX}b> ;`, { format: 'N-Triples' })).toThrow(/Not valid RDF/)
    expect(parseRdf(`<${EX}a> <${EX}p> <${EX}b> <${EX}g> .`).edges).toHaveLength(1)
    expect(parseRdf('').nodes).toEqual([])
    expect(parseRdf('# only a comment\n\n')).toMatchObject({ nodes: [], edges: [], warnings: [] })
  })

  it('helpers: the longest namespace wins compaction, expansion only for known prefixes, local names by # or /, words decode and split, formats by extension', () => {
    expect(compactIri('http://dbpedia.org/resource/Category:X')).toBe('dbc:X')
    expect(compactIri('http://dbpedia.org/resource/X', { a: 'http://dbpedia.org/', b: 'http://dbpedia.org/resource/' })).toBe('b:X')
    expect(expandIri('dbr:X')).toBe('http://dbpedia.org/resource/X')
    expect(expandIri('mailto:x@y')).toBe('mailto:x@y')
    expect(expandIri('http://x/y')).toBe('http://x/y')
    expect(localName('http://x/y#z')).toBe('z')
    expect(localName('http://x/y/')).toBe('')
    expect(localName('plain')).toBe('plain')
    expect(words('Caf%C3%A9_au_lait')).toBe('Café au lait')
    expect(words('HTML5Parser')).toBe('HTML5 Parser')
    expect(words('100%')).toBe('100%')
    expect(rdfFormatFor('X.NQ')).toBe('N-Quads')
    expect(rdfFormatFor('x.trig')).toBe('TriG')
    expect(rdfFormatFor('x.n3')).toBe('N3')
    expect(rdfFormatFor('x.ntriples')).toBe('N-Triples')
    expect(rdfFormatFor('x.rdf')).toBeUndefined()
  })
})

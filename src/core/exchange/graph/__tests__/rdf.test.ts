import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../entity/store'
import '../../../graph/types'
import { findGraphFormat, graphFormat, matchGraphImport } from '../graphFormats'
import { applyGraphPlan, inferGraphMapping, planGraphImport } from '../mapping'
import { compactIri, parseRdf, rdfFormatFor, words } from '../rdf'

const NT = `
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dbpedia.org/ontology/ProgrammingLanguage> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Thing> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dbpedia.org/ontology/Language> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.wikidata.org/entity/Q9143> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/2000/01/rdf-schema#label> "Python (programming language)"@en .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/2000/01/rdf-schema#label> "Python (langage)"@fr .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/2000/01/rdf-schema#comment> "Python is a high-level language."@en .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/abstract> "Python is a high-level, general-purpose programming language. Its design philosophy emphasizes code readability."@en .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/influencedBy> <http://dbpedia.org/resource/ABC_(programming_language)> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/designer> <http://dbpedia.org/resource/Guido_van_Rossum> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/wikiPageID> "23862"^^<http://www.w3.org/2001/XMLSchema#integer> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/property/year> "1991"^^<http://www.w3.org/2001/XMLSchema#integer> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/property/typing> "duck"@en .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/property/typing> "dynamic"@en .
<http://dbpedia.org/resource/Python_(programming_language)> <http://purl.org/dc/terms/subject> <http://dbpedia.org/resource/Category:Object-oriented_programming_languages> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/wikiPageWikiLink> <http://dbpedia.org/resource/Monty_Python> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://www.w3.org/2002/07/owl#sameAs> <http://www.wikidata.org/entity/Q28865> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://xmlns.com/foaf/0.1/homepage> <https://www.python.org/> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://xmlns.com/foaf/0.1/isPrimaryTopicOf> <http://en.wikipedia.org/wiki/Python_(programming_language)> .
<http://dbpedia.org/resource/Python_(programming_language)> <http://dbpedia.org/ontology/thumbnail> <http://commons.wikimedia.org/wiki/Special:FilePath/Python-logo-notext.svg?width=300> .
<http://dbpedia.org/resource/Guido_van_Rossum> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dbpedia.org/ontology/Person> .
<http://dbpedia.org/resource/Guido_van_Rossum> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dbpedia.org/ontology/Scientist> .
<http://dbpedia.org/resource/Guido_van_Rossum> <http://www.w3.org/2000/01/rdf-schema#label> "Guido van Rossum"@en .
<http://dbpedia.org/resource/Guido_van_Rossum> <http://dbpedia.org/ontology/birthDate> "1956-01-31"^^<http://www.w3.org/2001/XMLSchema#date> .
<http://dbpedia.org/resource/Guido_van_Rossum> <http://dbpedia.org/ontology/birthPlace> <http://dbpedia.org/resource/Haarlem> .
`

describe('RDF import', () => {
  it('compacts IRIs and words names', () => {
    expect(compactIri('http://dbpedia.org/resource/Berlin')).toBe('dbr:Berlin')
    expect(compactIri('http://dbpedia.org/resource/Category:Cities')).toBe('dbc:Cities')
    expect(compactIri('http://example.org/x')).toBe('http://example.org/x')
    expect(words('ProgrammingLanguage')).toBe('Programming Language')
    expect(words('influencedBy')).toBe('influenced By')
    expect(words('Category:Object-oriented_programming_languages')).toBe('Object-oriented programming languages')
    expect(rdfFormatFor('x.nt')).toBe('N-Triples')
    expect(rdfFormatFor('x.ttl.gz')).toBe('Turtle')
  })

  it('turns DBpedia triples into typed, labelled nodes with data, tags and predicate-typed edges', () => {
    const g = parseRdf(NT, { format: 'N-Triples' })
    const py = g.nodes.find((n) => n.id === 'dbr:Python_(programming_language)')!
    expect(py.label).toBe('Python (programming language)')
    expect(py.attrs.type).toBe('Programming Language')
    expect(py.attrs.description).toBe('Python is a high-level language.')
    expect(py.attrs.abstract).toMatch(/^Python is a high-level, general-purpose/)
    expect(py.attrs.wikiPageID).toBe(23862)
    expect(py.attrs.year).toBe(1991)
    expect(py.attrs.typing).toEqual(['duck', 'dynamic'])
    expect(py.attrs.tags).toEqual(['Object-oriented programming languages'])
    expect(py.attrs.iri).toBe('http://dbpedia.org/resource/Python_(programming_language)')
    // Web addresses are facts, not nodes.
    expect(py.attrs.homepage).toBe('https://www.python.org/')
    expect(py.attrs.wikipedia).toBe('http://en.wikipedia.org/wiki/Python_(programming_language)')
    expect(py.attrs.thumbnail).toMatch(/^http:\/\/commons/)
    // The specific class wins over Person; the wiki plumbing is gone.
    const guido = g.nodes.find((n) => n.id === 'dbr:Guido_van_Rossum')!
    expect(guido.attrs.type).toBe('Scientist')
    expect(guido.attrs.birthDate).toBe('1956-01-31')
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['dbr:ABC_(programming_language)', 'dbr:Guido_van_Rossum', 'dbr:Haarlem', 'dbr:Python_(programming_language)'])
    expect(g.nodes.find((n) => n.id === 'dbr:Haarlem')).toMatchObject({ label: 'Haarlem', attrs: { stub: true } })
    expect(g.edges.map((e) => [e.source, e.attrs.type, e.target])).toEqual([
      ['dbr:Python_(programming_language)', 'influenced By', 'dbr:ABC_(programming_language)'],
      ['dbr:Python_(programming_language)', 'designer', 'dbr:Guido_van_Rossum'],
      ['dbr:Guido_van_Rossum', 'birth Place', 'dbr:Haarlem'],
    ])
    expect(g.warnings.join(' ')).toMatch(/2 triples on wiki-plumbing/)
    expect(g.attributeKeys.nodes).toContain('iri')
    const noStubs = parseRdf(NT, { stubs: false })
    expect(noStubs.nodes.length).toBe(2)
    expect(noStubs.edges.length).toBe(1)
  })

  it('is a registered format that maps to entities under their IRIs', async () => {
    expect(findGraphFormat('langs.nt')?.id).toBe('rdf')
    expect(matchGraphImport([{ name: 'x.ttl' }])?.format.id).toBe('rdf')
    const g = await graphFormat('rdf').parse([{ name: 'langs.nt', text: NT }])
    const m = inferGraphMapping(g, 'langs.nt')
    expect(m.idMode).toBe('verbatim')
    expect(m.typeAttr).toBe('type')
    expect(m.tagsAttr).toBe('tags')
    expect(m.descriptionAttr).toBe('description')
    const store = new EntityStore()
    const plan = planGraphImport(store, g, m, 'import:rdf')
    applyGraphPlan(store, plan)
    const py = store.get('dbr:Python_(programming_language)')!
    expect(py.type).toBe('programming language')
    expect(py.label).toBe('Python (programming language)')
    expect(py.description).toBe('Python is a high-level language.')
    expect(py.tags).toEqual(['Object-oriented programming languages'])
    expect(py.data.year).toBe(1991)
    expect(py.data.description).toBeUndefined()
    expect(py.data.importedId).toBeUndefined()
    expect(store.relationshipsOf('dbr:Guido_van_Rossum').map((r) => r.type).sort()).toEqual(['birth place', 'designer'])
    // A second file that only refers to Guido keeps what is known about him.
    const again = parseRdf('<http://dbpedia.org/resource/Jython> <http://dbpedia.org/ontology/designer> <http://dbpedia.org/resource/Guido_van_Rossum> .\n<http://dbpedia.org/resource/Jython> <http://www.w3.org/2000/01/rdf-schema#label> "Jython"@en .')
    const plan2 = planGraphImport(store, again, inferGraphMapping(again, 'jython.nt'))
    applyGraphPlan(store, plan2)
    expect(store.get('dbr:Guido_van_Rossum')?.type).toBe('scientist')
    expect(store.get('dbr:Guido_van_Rossum')?.data.birthDate).toBe('1956-01-31')
    expect(store.relationshipsOf('dbr:Guido_van_Rossum').length).toBe(3)
    expect(plan2.updated).toBe(1)
  })

  it('reports syntax errors', () => {
    expect(() => parseRdf('<a> <b> .', { format: 'N-Triples' })).toThrow(/Not valid RDF/)
  })
})

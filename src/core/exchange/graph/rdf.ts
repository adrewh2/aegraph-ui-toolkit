import { Parser, type Quad, type Term } from 'n3'
import { checkGraphShape } from './limits'
import { attributeKeys, isUnsafeKey, type GEdge, type GNode, type ParsedGraph } from './model'

/**
 * RDF (N-Triples, Turtle, N-Quads, TriG) as a graph — the shape DBpedia,
 * Wikidata dumps and most linked-data exports come in. Subjects become
 * nodes whose id is the compact IRI (`dbr:Berlin`), so anything imported
 * twice, or from two files about the same things, lands on the same
 * entity. `rdf:type` picks the node's type (the most specific class in
 * the file), labels and descriptions come from the usual predicates in
 * the language asked for, other literals become data keyed by the
 * predicate's local name, categories (`dct:subject`) become tags, and
 * every other IRI-valued triple is an edge typed by its predicate.
 * Wiki-link noise is skipped.
 */
export interface RdfOptions {
  /** N3's format names: 'N-Triples', 'Turtle', 'N-Quads', 'TriG', 'N3'. Default: sniffed by the parser (Turtle reads N-Triples). */
  format?: string
  /** Preferred language for labels, descriptions and text (default 'en'); another language is used only when it is the only one. */
  lang?: string
  /** Nodes for IRIs that only appear as objects (default true — DBpedia pages link to things not in the file). */
  stubs?: boolean
  /** Predicates never imported (full IRIs or compact); the DBpedia wiki plumbing is skipped by default. */
  skipPredicates?: string[]
  /** How many category tags a node keeps (default 12). */
  maxTags?: number
}

export const RDF_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  dct: 'http://purl.org/dc/terms/',
  dc: 'http://purl.org/dc/elements/1.1/',
  prov: 'http://www.w3.org/ns/prov#',
  schema: 'http://schema.org/',
  geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
  dbo: 'http://dbpedia.org/ontology/',
  dbp: 'http://dbpedia.org/property/',
  dbr: 'http://dbpedia.org/resource/',
  dbc: 'http://dbpedia.org/resource/Category:',
  yago: 'http://dbpedia.org/class/yago/',
  wd: 'http://www.wikidata.org/entity/',
  wdt: 'http://www.wikidata.org/prop/direct/',
  wikipedia: 'http://en.wikipedia.org/wiki/',
}

const RDF_TYPE = RDF_PREFIXES.rdf + 'type'
const LABELS = [RDF_PREFIXES.rdfs + 'label', RDF_PREFIXES.skos + 'prefLabel', RDF_PREFIXES.foaf + 'name', RDF_PREFIXES.schema + 'name', RDF_PREFIXES.dbp + 'name', RDF_PREFIXES.dc + 'title', RDF_PREFIXES.dct + 'title']
const DESCRIPTIONS = [RDF_PREFIXES.rdfs + 'comment', RDF_PREFIXES.schema + 'description', RDF_PREFIXES.dct + 'description', RDF_PREFIXES.dc + 'description', RDF_PREFIXES.skos + 'definition', RDF_PREFIXES.dbo + 'abstract']
const TAG_PREDICATES = [RDF_PREFIXES.dct + 'subject', RDF_PREFIXES.skos + 'broader']
/** DBpedia's wiki plumbing: link soup, revision ids, redirects — not knowledge about the thing. */
export const DEFAULT_SKIP = ['dbo:wikiPageWikiLink', 'dbo:wikiPageExternalLink', 'dbo:wikiPageRedirects', 'dbo:wikiPageDisambiguates', 'dbo:wikiPageRevisionID', 'dbo:wikiPageLength', 'dbo:wikiPageUsesTemplate', 'dbp:wikiPageUsesTemplate', 'owl:sameAs', 'prov:wasDerivedFrom', 'dbo:wikiPageInterLanguageLink', 'dbp:wikiPageInterLanguageLink', 'foaf:primaryTopic']
/** IRIs that are web addresses about the thing, not things themselves: kept as data (`homepage`, `wikipedia`, `thumbnail`), never as nodes. */
const URL_PREDICATES: Record<string, string> = { [RDF_PREFIXES.foaf + 'homepage']: 'homepage', [RDF_PREFIXES.foaf + 'page']: 'page', [RDF_PREFIXES.foaf + 'depiction']: 'depiction', [RDF_PREFIXES.foaf + 'isPrimaryTopicOf']: 'wikipedia', [RDF_PREFIXES.dbo + 'thumbnail']: 'thumbnail', [RDF_PREFIXES.schema + 'url']: 'url', [RDF_PREFIXES.schema + 'image']: 'image', [RDF_PREFIXES.schema + 'sameAs']: 'sameAs' }
/** Classes too broad to name a type when anything more specific is present. */
const BROAD_CLASSES = new Set([RDF_PREFIXES.owl + 'Thing', RDF_PREFIXES.dbo + 'Agent', RDF_PREFIXES.dbo + 'Work', RDF_PREFIXES.dbo + 'Person', RDF_PREFIXES.dbo + 'Organisation', RDF_PREFIXES.dbo + 'Place', RDF_PREFIXES.dbo + 'Software', RDF_PREFIXES.schema + 'Thing', RDF_PREFIXES.foaf + 'Person', RDF_PREFIXES.schema + 'Person', RDF_PREFIXES.schema + 'Organization', RDF_PREFIXES.schema + 'Place', RDF_PREFIXES.schema + 'CreativeWork'])

/** Prefer the ontology's own classes for typing; Wikidata Q-ids, YAGO and DUL classes are noise for a table. */
const typeRank = (iri: string) => (iri.startsWith(RDF_PREFIXES.dbo) ? 0 : iri.startsWith(RDF_PREFIXES.schema) ? 1 : iri.startsWith(RDF_PREFIXES.foaf) ? 2 : /wikidata\.org|dbpedia\.org\/class\/yago|ontologydesignpatterns/.test(iri) ? 9 : 3)

/** `http://dbpedia.org/resource/Berlin` → `dbr:Berlin`, using the known prefixes and the document's own. */
export function compactIri(iri: string, prefixes: Record<string, string> = RDF_PREFIXES): string {
  let best: [string, string] | undefined
  for (const [p, ns] of Object.entries(prefixes)) if (iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns]
  return best ? `${best[0]}:${iri.slice(best[1].length)}` : iri
}

export function expandIri(compact: string, prefixes: Record<string, string> = RDF_PREFIXES): string {
  const m = /^([A-Za-z][\w-]*):(.*)$/.exec(compact)
  if (m && Object.hasOwn(prefixes, m[1])) return prefixes[m[1]] + m[2]
  return compact
}

/** The last path segment or fragment of an IRI. */
export const localName = (iri: string) => {
  const i = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'))
  return i >= 0 ? iri.slice(i + 1) : iri
}

/** `ProgrammingLanguage` → `programming language`; `influencedBy` → `influenced by`; `Category:Foo_bar` → `Foo bar`. */
const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
export const words = (s: string) =>
  decode(s)
    .replace(/^Category:/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()

const literalValue = (t: Term): unknown => {
  if (t.termType !== 'Literal') return t.value
  const dt = t.datatype?.value ?? ''
  if (/#(integer|int|long|short|byte|nonNegativeInteger|positiveInteger|decimal|double|float)$/.test(dt)) {
    const n = Number(t.value)
    return Number.isFinite(n) ? n : t.value
  }
  if (dt.endsWith('#boolean')) return t.value === 'true'
  return t.value
}

interface Subject {
  iri: string
  types: string[]
  labels: { value: string; lang: string }[]
  descriptions: { value: string; lang: string; pred: string }[]
  tags: string[]
  literals: Map<string, { value: unknown; lang: string }[]>
  edges: { pred: string; object: string }[]
  /** The edges' predicate and object, joined, so a repeated statement is found in one lookup. */
  edgeKeys: Set<string>
}

/** Parse RDF text into a graph. Throws on syntax errors with the line. */
export function parseRdf(text: string, opts: RdfOptions = {}): ParsedGraph {
  const lang = opts.lang ?? 'en'
  const prefixes: Record<string, string> = { ...RDF_PREFIXES }
  const parser = new Parser(opts.format ? { format: opts.format } : {})
  let quads: Quad[]
  try {
    quads = parser.parse(text, undefined, (prefix, iri) => {
      if (!Object.hasOwn(prefixes, prefix) && !isUnsafeKey(prefix)) prefixes[prefix] = iri.value
    })
  } catch (err) {
    throw new Error(`Not valid RDF: ${err instanceof Error ? err.message : String(err)}`)
  }
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipPredicates ?? [])].map((p) => expandIri(p, prefixes)))
  const subjects = new Map<string, Subject>()
  const at = (iri: string) => {
    let s = subjects.get(iri)
    if (!s) {
      s = { iri, types: [], labels: [], descriptions: [], tags: [], literals: new Map(), edges: [], edgeKeys: new Set() }
      subjects.set(iri, s)
    }
    return s
  }
  const objectsOnly = new Map<string, number>()
  const classCount = new Map<string, number>()
  let skipped = 0
  let blank = 0
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') {
      blank++
      continue
    }
    const pred = q.predicate.value
    if (skip.has(pred)) {
      skipped++
      continue
    }
    const s = at(q.subject.value)
    const o = q.object
    if (pred === RDF_TYPE && o.termType === 'NamedNode') {
      s.types.push(o.value)
      classCount.set(o.value, (classCount.get(o.value) ?? 0) + 1)
      continue
    }
    if (o.termType === 'Literal') {
      const l = o.language ?? ''
      if (LABELS.includes(pred)) s.labels.push({ value: o.value, lang: l })
      else if (DESCRIPTIONS.includes(pred)) s.descriptions.push({ value: o.value, lang: l, pred })
      else {
        const key = localName(pred)
        const list = s.literals.get(key) ?? []
        list.push({ value: literalValue(o), lang: l })
        s.literals.set(key, list)
      }
      continue
    }
    if (o.termType === 'NamedNode') {
      if (TAG_PREDICATES.includes(pred)) {
        s.tags.push(words(localName(o.value)))
        continue
      }
      // A web address, or an IRI with no name of its own (ends in `/`): a fact about the subject, not a node.
      const urlKey = (Object.hasOwn(URL_PREDICATES, pred) ? URL_PREDICATES[pred] : undefined) ?? (/[/#]$/.test(o.value) ? localName(pred) : undefined)
      if (urlKey) {
        const list = s.literals.get(urlKey) ?? []
        list.push({ value: o.value, lang: '' })
        s.literals.set(urlKey, list)
        continue
      }
      // RDF is a set of triples: the same statement twice is one edge.
      const key = `${pred}\u0000${o.value}`
      if (!s.edgeKeys.has(key)) {
        s.edgeKeys.add(key)
        s.edges.push({ pred, object: o.value })
      }
      if (!subjects.has(o.value)) objectsOnly.set(o.value, (objectsOnly.get(o.value) ?? 0) + 1)
    } else blank++
  }

  // A literal in the preferred language wins; otherwise whatever there is, but no second language beside it.
  const pick = <T extends { lang: string }>(xs: T[]): T[] => {
    if (!xs.length) return xs
    const pref = xs.filter((x) => x.lang === lang)
    if (pref.length) return pref
    const plain = xs.filter((x) => !x.lang)
    if (plain.length) return plain
    const first = xs[0].lang
    return xs.filter((x) => x.lang === first)
  }
  const typeOf = (s: Subject): string | undefined => {
    const own = s.types.filter((t) => typeRank(t) < 9)
    if (!own.length) return undefined
    const specific = own.filter((t) => !BROAD_CLASSES.has(t))
    const pool = specific.length ? specific : own
    // Most specific ≈ best namespace, then the class with the fewest members in this file, then the longer name (ProgrammingLanguage over Language).
    pool.sort((a, b) => typeRank(a) - typeRank(b) || (classCount.get(a) ?? 0) - (classCount.get(b) ?? 0) || localName(b).length - localName(a).length)
    return words(localName(pool[0]))
  }

  const nodes: GNode[] = []
  const stubs = opts.stubs !== false
  const maxTags = opts.maxTags ?? 12
  for (const s of subjects.values()) {
    const id = compactIri(s.iri, prefixes)
    const label = pick(s.labels)[0]?.value ?? words(localName(s.iri))
    const desc = pick(s.descriptions)
    // A comment is a sentence; an abstract is paragraphs. The sentence describes, the abstract stays as data.
    const comment = desc.find((d) => d.pred !== RDF_PREFIXES.dbo + 'abstract')
    const abstract = desc.find((d) => d.pred === RDF_PREFIXES.dbo + 'abstract')
    const attrs: Record<string, unknown> = { iri: s.iri }
    const type = typeOf(s)
    if (type) attrs.type = type
    if (comment) attrs.description = comment.value
    else if (abstract) attrs.description = abstract.value.length > 400 ? abstract.value.slice(0, 397).replace(/\s+\S*$/, '') + '…' : abstract.value
    if (abstract && comment) attrs.abstract = abstract.value
    if (s.tags.length) attrs.tags = [...new Set(s.tags)].slice(0, maxTags)
    for (const [key, list] of s.literals) {
      // A predicate whose local name is `__proto__`, `prototype` or `constructor` is not a field anything can hold.
      if (key === 'iri' || key === 'type' || key === 'description' || key === 'tags' || isUnsafeKey(key)) continue
      const vals = [...new Set(pick(list).map((x) => x.value))]
      attrs[key] = vals.length === 1 ? vals[0] : vals
    }
    nodes.push({ id, label, attrs })
  }
  const known = new Set(nodes.map((n) => n.id))
  let added = 0
  if (stubs) for (const iri of objectsOnly.keys()) {
    const id = compactIri(iri, prefixes)
    if (known.has(id)) continue // referred to before it was described
    known.add(id)
    added++
    nodes.push({ id, label: words(localName(iri)), attrs: { iri, stub: true } })
  }

  const edges: GEdge[] = []
  let dangling = 0
  for (const s of subjects.values()) {
    const source = compactIri(s.iri, prefixes)
    for (const e of s.edges) {
      const target = compactIri(e.object, prefixes)
      if (!known.has(target)) {
        dangling++
        continue
      }
      edges.push({ source, target, directed: true, attrs: { type: words(localName(e.pred)), predicate: compactIri(e.pred, prefixes) } })
    }
  }
  // Read through the registry or straight from `import_graph`, an RDF file is held to the graph bounds.
  checkGraphShape('The RDF', { nodes, edges })
  const warnings: string[] = []
  if (skipped) warnings.push(`${skipped} triples on wiki-plumbing predicates skipped (links, redirects, revisions, sameAs)`)
  if (blank) warnings.push(`${blank} triples with blank nodes skipped`)
  if (added) warnings.push(`${added} things only referred to were added with just a label — turn stubs off to leave them out`)
  if (!stubs && dangling) warnings.push(`${dangling} links to things not in the file left out`)
  return { nodes, edges, directedDefault: true, attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings }
}

/** The N3 format name for a file name, or undefined to let the parser sniff. */
export function rdfFormatFor(filename: string): string | undefined {
  const e = filename.toLowerCase().replace(/\.gz$/, '').split('.').pop()
  return e === 'nt' || e === 'ntriples' ? 'N-Triples' : e === 'ttl' ? 'Turtle' : e === 'nq' ? 'N-Quads' : e === 'trig' ? 'TriG' : e === 'n3' ? 'N3' : undefined
}

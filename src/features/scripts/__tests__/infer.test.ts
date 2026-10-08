import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../../core/entity/typeRegistry'
import type { Language } from '../../../scripting/types'
import { buildExprSchema } from '../../expr/schema'
import { hoverFor, scriptCompletion } from '../completion'
import { collectBindings, parseChain, receiverBefore, splitArgs } from '../infer'

/**
 * Introspection: completion follows the data through the code — a variable
 * bound to entities of a type, a loop over relationships, the entity behind
 * an id, a categorical property's values — in JavaScript and in Python.
 */

const setup = () => {
  const store = new EntityStore()
  const ents = []
  for (let i = 0; i < 12; i++) ents.push(createEntity({ id: `p${i}`, type: 'person', label: `P${i}`, tags: i % 2 ? ['reviewed'] : [], data: { born: 1800 + i, role: ['author', 'editor', 'reviewer'][i % 3], email: i < 6 ? `p${i}@x` : undefined } }))
  for (let i = 0; i < 5; i++) ents.push(createEntity({ id: `w${i}`, type: 'paper', label: `W${i}`, data: { year: 1900 + i, venue: i % 2 ? 'ICML' : 'NeurIPS' } }))
  ents.push(createEntity({ id: 'v1', type: 'venue', label: 'ICML', data: { city: 'Vienna' } }))
  store.upsertMany(ents)
  store.upsertMany([
    createRelationship({ id: 'r1', type: 'wrote', source: 'p0', target: 'w0', data: { order: 1 } }),
    createRelationship({ id: 'r2', type: 'wrote', source: 'p1', target: 'w1', data: { order: 2 } }),
    createRelationship({ id: 'r3', type: 'cites', source: 'w1', target: 'w0' }),
    createRelationship({ id: 'r4', type: 'held_at', source: 'w0', target: 'v1' }),
  ])
  store.upsert(schemaTypeEntity('person', { properties: [{ key: 'role', kind: 'text', options: ['author', 'editor', 'reviewer', 'chair'] }] }))
  const schema = buildExprSchema(store, new TypeRegistry(store))
  const complete = (doc: string, language: Language = 'js', pos = doc.length) => {
    const state = EditorState.create({ doc })
    return scriptCompletion({ schema: () => schema, language: () => language, metrics: () => ['pagerank'] })(new CompletionContext(state, pos, true))
  }
  const labels = (doc: string, language: Language = 'js') => complete(doc, language)?.options.map((o) => o.label) ?? null
  return { schema, complete, labels, hover: (doc: string, name: string, language: Language = 'js') => hoverFor(schema, language, doc, doc.length, name) }
}

describe('the schema carries values and relationship ends', () => {
  it('a categorical property has its values (declared options first, then seen); a free one has none; a relationship knows its ends and its data', () => {
    const { schema } = setup()
    const person = schema.properties.get('person')!
    expect(person.find((p) => p.key === 'role')!.values).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(person.find((p) => p.key === 'born')!.values).toEqual(['1800', '1801', '1802', '1803', '1804', '1805', '1806', '1807', '1808', '1809', '1810', '1811'])
    expect(person.find((p) => p.key === 'email')!.values).toBeDefined()
    expect(schema.properties.get('paper')!.find((p) => p.key === 'venue')!.values).toEqual(['NeurIPS', 'ICML'])
    const wrote = schema.relationshipTypes.find((r) => r.type === 'wrote')!
    expect([wrote.sources, wrote.targets]).toEqual([['person'], ['paper']])
    expect(schema.properties.get('wrote')!.map((p) => p.key)).toEqual(['order'])
  })
})

describe('parsing', () => {
  it('finds the receiver before a position over balanced brackets and strings', () => {
    const at = (s: string) => receiverBefore(s, s.length - 1)
    expect(at("ds.byType('person').filter((e) => e.data.born > 1800)[0].data.")).toBe("ds.byType('person').filter((e) => e.data.born > 1800)[0].data")
    expect(at('x = ds.get(r.target).')).toBe('ds.get(r.target)')
    expect(at('if (people.')).toBe('people')
    expect(at('return people.')).toBe('people')
    expect(at("ds.get('a)b').")).toBe("ds.get('a)b')")
    expect(at('for (const t of ds.ontology) t.')).toBe('t')
    expect(at('a . b.')).toBe('a . b')
    expect(at('for (.')).toBeNull()
    expect(at('return (.')).toBeNull()
  })

  it('parses a chain into a head and segments, splitting arguments at top-level commas', () => {
    expect(parseChain("ds.byType('person', 'paper')[0].data")).toEqual({ head: { kind: 'name', text: 'ds' }, segments: [{ kind: 'member', name: 'byType' }, { kind: 'call', args: ["'person'", "'paper'"] }, { kind: 'index', text: '0' }, { kind: 'member', name: 'data' }] })
    expect(splitArgs("a, f(b, c), 'x,y', [1, 2]")).toEqual(['a', 'f(b, c)', "'x,y'", '[1, 2]'])
    expect(parseChain("(ds.get('p1')).data")!.head).toEqual({ kind: 'paren', text: "ds.get('p1')" })
    expect(parseChain('people?.[0]!.data')!.segments.map((s) => s.kind)).toEqual(['index', 'member'])
    expect(parseChain('1 + 2')).toBeNull()
  })

  it('collects bindings: const, for-of, destructuring, callbacks, the state scaffold, and Python assignments and loops', () => {
    const js = collectBindings(["const people = ds.byType('person')", 'for (const p of people) {', "  const rels = ds.out(p.id, 'wrote')", "  rels.map((r) => r.target).forEach(id => log(id))", '}', 'const { project, ontology } = ds', 'function main({ entities, tags }) {}', 'ds.where((e) => e.type)'].join('\n'), 'js')
    expect(js.map((b) => [b.name, b.expr, !!b.element])).toEqual([
      ['people', "ds.byType('person')", false],
      ['p', 'people', true],
      ['rels', "ds.out(p.id, 'wrote')", false],
      ['r', 'rels', true],
      ['id', 'rels.map((r) => r.target)', true],
      ['project', 'ds.project', false],
      ['ontology', 'ds.ontology', false],
      ['entities', 'ds.entities', false],
      ['tags', 'ds.tags()', false],
      ['e', 'ds.entities', true],
    ])
    // Statements on one line, separated by semicolons; the loop body on the same line.
    const one = collectBindings("const people = ds.byType('person'); for (const p of people) { for (const r of ds.out(p.id, 'wrote')) { const paper = ds.get(r.target); paper.data.", 'js')
    expect(one.map((b) => [b.name, b.expr, !!b.element])).toEqual([
      ['people', "ds.byType('person')", false],
      ['p', 'people', true],
      ['r', "ds.out(p.id, 'wrote')", true],
      ['paper', 'ds.get(r.target)', false],
    ])
    const py = collectBindings(["df = by_type('person')", "for e in ds['entities']:", '    x = 1', 'if a == b:'].join('\n'), 'python')
    expect(py.map((b) => [b.name, b.expr, !!b.element])).toEqual([
      ['df', "by_type('person')", false],
      ['e', "ds['entities']", true],
      ['x', '1', false],
    ])
  })
})

describe('completion follows the data', () => {
  it('a variable bound to entities of a type completes that type’s properties, with kind, coverage and values', () => {
    const { labels, complete } = setup()
    expect(labels("const people = ds.byType('person')\npeople[0].data.")).toEqual(['born', 'role', 'email'])
    const role = complete("const people = ds.byType('person')\npeople[0].data.")!.options.find((o) => o.label === 'role')!
    expect(role.detail).toBe('text · 100%')
    expect(role.info).toMatch(/values: author, editor, reviewer, chair/)
    expect(labels("const people = ds.byType('person')\nfor (const p of people) {\n  p.data.")).toEqual(['born', 'role', 'email'])
    expect(labels("ds.byType('paper').filter((w) => w.data.")).toEqual(['venue', 'year'])
    expect(labels("ds.byType('paper').map((w) => w.")).toEqual(['id', 'type', 'label', 'description', 'tags', 'data', 'createdAt', 'updatedAt'])
    // Two types: the union of their properties.
    expect(labels("const xs = ds.byType('person', 'paper')\nxs[0].data.")).toEqual(['born', 'role', 'email', 'venue', 'year'])
    // Sorted, sliced, topK'd lists keep their element type; a mapped one does not.
    expect(labels("const top = topK(ds.byType('paper'), 'year', 3)\ntop[0].data.")).toEqual(['venue', 'year'])
    expect(labels("sortBy(ds.byType('paper'), 'label').slice(0, 2)[0].data.")).toEqual(['venue', 'year'])
    expect(labels("ds.byType('paper').map((w) => w.label)[0].")).toBeNull()
  })

  it('a relationship knows its ends: the entity behind r.target is a paper, behind r.source a person', () => {
    const { labels, hover } = setup()
    const doc = "for (const p of ds.byType('person')) {\n  for (const r of ds.out(p.id, 'wrote')) {\n    const w = ds.get(r.target)\n    w.data."
    expect(labels(doc)).toEqual(['venue', 'year'])
    expect(labels("const people = ds.byType('person'); for (const p of people) { for (const r of ds.out(p.id, 'wrote')) { const paper = ds.get(r.target); paper.data.")).toEqual(['venue', 'year'])
    expect(labels("for (const r of ds.relationships.filter((r) => r.type === 'cites')) ds.get(r.source).data.")).toEqual(['venue', 'year'])
    expect(labels("const r = ds.out('p0', 'wrote')[0]\nds.get(r.source).data.")).toEqual(['born', 'role', 'email'])
    expect(labels("ds.out('p0', 'wrote')[0].data.")).toEqual(['order'])
    // neighbors through one relationship type: the far ends of both directions.
    expect(labels("ds.neighbors('w0', 'held_at')[0].data.")).toEqual(['venue', 'year', 'city'])
    expect(labels("ds.neighbors('w0')[0].data.")).toEqual(['born', 'role', 'email', 'venue', 'year', 'city'])
    expect(hover("for (const r of ds.out('p0', 'wrote')) {\n", 'r')).toEqual({ signature: 'r', doc: 'a relationship: wrote relationship (person → paper)' })
    expect(hover("const people = ds.byType('person')\n", 'people')!.doc).toBe('a collection of person entities (12) — data: born, role, email')
    expect(hover("const w = ds.get(ds.out('p0', 'wrote')[0].target)\n", 'w')!.doc).toBe('an entity: paper entity — data: venue, year')
  })

  it('a comparison on a categorical property offers its values; on .type the types; on tags the tags', () => {
    const { labels } = setup()
    expect(labels("ds.byType('person').filter((e) => e.data.role === '")).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(labels("ds.byType('paper').filter((e) => e.data.venue !== '")).toEqual(['NeurIPS', 'ICML'])
    expect(labels("ds.byType('paper').filter((e) => e.data.venue === 'NeurIPS' || e.data.venue === '")).toEqual(['NeurIPS', 'ICML'])
    expect(labels("ds.entities.filter((e) => e.type === '")).toEqual(['person', 'paper', 'venue'])
    expect(labels("ds.entities.filter((e) => e.tags.includes('")).toEqual(['reviewed'])
    expect(labels("ds.byType('person').filter((e) => e.data['")).toEqual(['born', 'role', 'email'])
    expect(labels("ds.byType('person')[0]['")).toEqual(['id', 'type', 'label', 'description', 'tags', 'data', 'createdAt', 'updatedAt'])
    expect(labels("ds.metrics['")).toEqual(['pagerank'])
    // A free-text property has no values to offer.
    expect(labels("ds.byType('person').filter((e) => e.label === '")).toBeNull()
  })

  it('the ontology, the project, the summary and rollups are followed too', () => {
    const { labels } = setup()
    expect(labels("ds.type('person').")).toEqual(['type', 'label', 'category', 'kind', 'parent', 'description', 'color', 'count', 'properties'])
    expect(labels("ds.type('person').properties[0].")).toEqual(['key', 'label', 'kind', 'description', 'options', 'required'])
    expect(labels("for (const t of ds.ontology) t.")).toContain('properties')
    expect(labels("ds.properties('person')[0].")).toEqual(['key', 'kind', 'count', 'coverage', 'declared', 'sample', 'label', 'description'])
    expect(labels('ds.tags()[0].')).toEqual(['tag', 'count', 'color', 'description'])
    expect(labels('const { project } = ds\nproject.')).toEqual(['id', 'label', 'description', 'includes', 'source', 'createdAt', 'updatedAt'])
    expect(labels('ds.describe().types[0].')).toEqual(['type', 'count', 'properties'])
    expect(labels('function main({ entities, tags }) {\n  entities[0].data.')).toEqual(['born', 'role', 'email', 'venue', 'year', 'city'])
    expect(labels('function main({ entities, tags }) {\n  tags[0].')).toEqual(['tag', 'count', 'color', 'description'])
    expect(labels("const m = rollup(ds.byType('paper'), 'venue')\nm[0].items[0].data.")).toEqual(['venue', 'year'])
    expect(labels("const m = rollup(ds.byType('paper'), 'venue')\nm[0].")).toEqual(['key', 'value', 'n', 'items'])
    const coll = labels("ds.byType('paper').")!
    for (const m of ['types', 'type', 'get', 'filter', 'sort', 'top', 'neighbors', 'out', 'into', 'table', 'rollup', 'length', 'map']) expect(coll).toContain(m)
  })

  it('the chained query API is followed in both languages: types namespace, spec keys, graph steps, paths', () => {
    const { labels, hover } = setup()
    // JavaScript
    expect(labels('entities.types.')).toEqual(['person', 'paper', 'venue', 'list', 'has'])
    expect(labels('entities.types.papers.get(\'w0\').data.')).toEqual(['venue', 'year'])
    expect(labels("entities.types.person.filter({ min_degree: 2 }).neighbors('wrote').first().data.")).toEqual(['venue', 'year'])
    expect(labels("entities.filter({ types: '")).toEqual(['person', 'paper', 'venue'])
    expect(labels("entities.filter({ types: ['person'], tags: '")).toEqual(['reviewed'])
    expect(labels("entities.filter({ data: { role: '")).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(labels("entities.types.person.filter({ has: '")).toEqual(['born', 'role', 'email'])
    expect(labels("relationships.filter({ source_type: '")).toEqual(['person', 'paper', 'venue'])
    expect(labels("relationships.types.")).toEqual(['wrote', 'cites', 'held_at', 'list', 'has'])
    expect(labels("relationships.types.wrote.targets()[0].data.")).toEqual(['venue', 'year'])
    expect(labels("relationships.filter({ types: 'cites' }).sources().first().data.")).toEqual(['venue', 'year'])
    expect(labels("entities.types.person.out('")).toEqual(['wrote', 'cites', 'held_at'])
    expect(labels("entities.types.paper.sort('")).toEqual(['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt', 'data.venue', 'data.year'])
    expect(labels("entities.types.paper.table(['")).toContain('data.year')
    expect(labels("entities.types.paper.rollup('data.venue', 'data.year', '")).toEqual(['count', 'sum', 'mean', 'median', 'min', 'max', 'distinct'])
    expect(labels("const xs = entities.filter({ types: ['person', 'paper'] })\nxs.first().data.")).toEqual(['born', 'role', 'email', 'venue', 'year'])
    expect(labels("for (const r of entities.types.person.rollup('data.role')) r.items.first().data.")).toEqual(['born', 'role', 'email'])
    expect(hover("const hot = entities.types.paper.filter({ tags: 'draft' })\n", 'hot')!.doc).toBe('a collection of paper entities (5) — data: venue, year')
    // Python: the same names, keyword specs
    expect(labels('entities.types.', 'python')).toEqual(['person', 'paper', 'venue', 'list', 'has'])
    expect(labels("entities.types.person.filter(min_degree=2).neighbors('wrote').first()['data']['", 'python')).toEqual(['venue', 'year'])
    expect(labels("entities.filter(types='", 'python')).toEqual(['person', 'paper', 'venue'])
    expect(labels("entities.filter(data={'role': '", 'python')).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(labels("relationships.filter(source_type='", 'python')).toEqual(['person', 'paper', 'venue'])
    expect(labels("relationships.types.wrote.targets().df['", 'python')).toEqual(['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt', 'venue', 'year'])
    expect(labels("entities.types.paper.sort('", 'python')).toContain('data.year')
    expect(labels("df = entities.types.paper.df\ndf['", 'python')).toContain('venue')
    expect(labels("entities.types.paper.df['venue'] == '", 'python')).toEqual(['NeurIPS', 'ICML'])
    expect(labels("entities['role'] == '", 'python')).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(hover("hot = entities.types.paper.filter(tags='draft')\n", 'hot', 'python')!.doc).toBe('a collection of paper entities (5) — data: venue, year')
  })

  it('bare names include the document’s variables with what they hold', () => {
    const { complete } = setup()
    const r = complete("const people = ds.byType('person')\nconst n = 3\npe")!
    const people = r.options.find((o) => o.label === 'people')!
    expect(people.type).toBe('variable')
    expect(people.info).toBe('a collection of person entities (12) — data: born, role, email')
    expect(r.options.find((o) => o.label === 'n')?.info).toBeUndefined()
    expect(r.options.some((o) => o.label === 'rollup')).toBe(true)
  })

  it('Python: a DataFrame of a type completes its columns; a row its keys; dict access its values', () => {
    const { labels, hover } = setup()
    expect(labels("df = by_type('paper')\ndf['", 'python')).toEqual(['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt', 'venue', 'year'])
    expect(labels("df = by_type('paper')\ndf.", 'python')).toContain('venue')
    expect(labels("df = by_type('paper')\ndf.sort_values('year').head()['", 'python')).toContain('venue')
    expect(labels("df = by_type('paper')\ndf[df['venue'] == '", 'python')).toEqual(['NeurIPS', 'ICML'])
    expect(labels("for e in ds['entities']:\n    e['", 'python')).toEqual(['id', 'type', 'label', 'description', 'tags', 'data', 'createdAt', 'updatedAt'])
    expect(labels("for e in ds['entities']:\n    e['data']['", 'python')).toEqual(['born', 'role', 'email', 'venue', 'year', 'city'])
    expect(labels("w = get(out('p0', 'wrote')[0]['target'])\nw['data']['", 'python')).toEqual(['venue', 'year'])
    expect(labels("for e in ds['entities']:\n    if e['type'] == '", 'python')).toEqual(['person', 'paper', 'venue'])
    expect(labels("for e in neighbors('w0', 'held_at'):\n    if e['tags'][0] == '", 'python')).toEqual(['reviewed'])
    expect(labels("t = type_def('person')\nt['", 'python')).toEqual(['type', 'label', 'category', 'kind', 'parent', 'description', 'color', 'count', 'properties'])
    expect(labels("metrics['", 'python')).toEqual(['pagerank'])
    expect(labels("ds['", 'python')).toEqual(['entities', 'relationships', 'ontology', 'project', 'tags', 'metrics', 'scope'])
    expect(labels("for e in ds['entities']:\n    if e['type'] == 'person' and e['data']['role'] == '", 'python')).toEqual(['author', 'editor', 'reviewer', 'chair'])
    expect(hover("df = by_type('paper')\n", 'df', 'python')!.doc).toBe('a DataFrame of paper entities: label, venue, year')
    // A lambda's parameter and a comprehension's variable are elements of their receiver.
    expect(labels("entities.types.person.filter(lambda e: e['data']['", 'python')).toEqual(['born', 'role', 'email'])
    expect(labels("[p['data']['", 'python')).toBeNull()
    // …even when the `for` comes after the cursor: the whole line is read.
    expect(labels("[p['data'][' for p in entities.types.paper]", 'python')).toEqual(['venue', 'year'])
    expect(labels("rows = [p['label'] for p in entities.types.paper if p['data']['", 'python')).toEqual(['venue', 'year'])
  })
})

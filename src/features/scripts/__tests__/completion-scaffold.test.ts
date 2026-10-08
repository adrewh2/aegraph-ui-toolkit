import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import type { Language } from '../../../scripting/types'
import { buildExprSchema } from '../../expr/schema'
import { scriptCompletion } from '../completion'
import { scaffoldRelationship, scaffoldState, scaffoldType } from '../scaffold'
import { DS_MEMBERS, JS_HELPERS, PY_HELPERS, VIEW_MEMBERS } from '../vocabulary'

/**
 * The script editor's completion knows the data and the vocabulary; the
 * scaffolds write scripts from the data as it stands.
 */

const setup = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['reviewed'], data: { born: 1815, email: 'ada@x' } }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912 } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes', data: { year: 1843, 'odd key': 1 } }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
  ])
  const schema = buildExprSchema(store, new TypeRegistry(store))
  const complete = (doc: string, language: Language = 'js', explicit = true) => {
    const state = EditorState.create({ doc })
    const ctx = new CompletionContext(state, doc.length, explicit)
    return scriptCompletion({ schema: () => schema, language: () => language, metrics: () => ['pagerank', 'community'] })(ctx)
  }
  return { schema, complete }
}
const labels = (r: ReturnType<ReturnType<typeof setup>['complete']>) => (r ? r.options.map((o) => o.label) : null)

describe('script completion', () => {
  it('completes ds. with its members, and the arguments of its calls with the data', () => {
    const { complete } = setup()
    expect(labels(complete('ds.'))).toEqual(DS_MEMBERS.map((m) => m.name))
    expect(labels(complete("ds.byType('"))).toEqual(['person', 'paper'])
    expect(complete("ds.byType('")!.options[0].detail).toBe('2 entities')
    expect(labels(complete("ds.byType('person', '"))).toEqual(['person', 'paper'])
    expect(labels(complete("ds.out(e.id, '"))).toEqual(['wrote'])
    expect(labels(complete("ds.neighbors('p1', '"))).toEqual(['wrote'])
    // The first argument of out() is an id, not a relationship.
    expect(complete("ds.out('")).toBeNull()
    expect(labels(complete("ds.tagged('"))).toEqual(['reviewed'])
    expect(labels(complete("ds.metric('"))).toEqual(['pagerank', 'community'])
    expect(labels(complete("ds.type('"))).toEqual(['person', 'paper'])
    expect(labels(complete("bin(e.data.born, '"))).toEqual(['hour', 'day', 'week', 'month', 'quarter', 'year'])
    expect(labels(complete("rollup(xs, 'type', null, '"))).toEqual(['count', 'sum', 'mean', 'median', 'min', 'max', 'distinct'])
  })

  it('completes properties after data., entity fields after a loop variable, and the project', () => {
    const { complete } = setup()
    expect(labels(complete('e.data.'))).toEqual(['born', 'email', 'odd key', 'year'])
    const born = complete('e.data.')!.options[0]
    expect(born.detail).toBe('number · 100%')
    expect(born.info).toMatch(/e\.g\. 1815/)
    expect(labels(complete('for (const x of ds.entities) x.'))).toEqual(['id', 'type', 'label', 'description', 'tags', 'data', 'createdAt', 'updatedAt'])
    expect(labels(complete("ds.get('p1')."))).toContain('data')
    expect(labels(complete('ds.project.'))).toEqual(['id', 'label', 'description', 'includes', 'source', 'createdAt', 'updatedAt'])
    expect(labels(complete("e.type === '"))).toEqual(['person', 'paper', 'wrote'])
    expect(labels(complete("e.tags.includes('"))).toEqual(['reviewed'])
  })

  it('offers the helpers as bare names — the language’s own — and nothing on a single letter unless asked', () => {
    const { complete } = setup()
    expect(labels(complete('ro'))).toEqual(JS_HELPERS.map((h) => h.name))
    expect(complete('r', 'js', false)).toBeNull()
    expect(complete('ro')!.options.find((o) => o.label === 'rollup')?.apply).toBe('rollup(')
    expect(labels(complete('by', 'python'))).toEqual(PY_HELPERS.map((h) => h.name))
    expect(labels(complete("by_type('", 'python'))).toEqual(['person', 'paper'])
    expect(labels(complete("out(id, '", 'python'))).toEqual(['wrote'])
    expect(labels(complete("entities['", 'python'))).toEqual(['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt', 'born', 'email', 'odd key', 'year'])
    expect(labels(complete("entities.types.", 'python'))).toEqual(['person', 'paper', 'list', 'has'])
    expect(labels(complete("metrics['", 'python'))).toEqual(['pagerank', 'community'])
    expect(complete('ds.', 'python')).toBeNull()
    expect(labels(complete('aegraph.', 'view'))).toEqual(VIEW_MEMBERS.map((m) => m.name))
    expect(labels(complete("aegraph.load('", 'view'))).toEqual(['d3', 'plotly'])
    expect(complete('aegraph.', 'js')).toBeNull()
  })
})

describe('scaffolds', () => {
  it('a type scaffold names the real properties with kind and coverage, in every language', () => {
    const { schema } = setup()
    const ctx = { schema, project: { id: 'x', label: 'Papers' }, metrics: ['pagerank'] }
    const js = scaffoldType(ctx, 'person')
    expect(js).toContain('const rows = entities.types.person.map((e) => ({')
    expect(js).toContain('born: e.data.born, // number · 100% · e.g. 1815')
    expect(js).toContain('email: e.data.email, // string · 50% · e.g. ada@x')
    expect(js).toContain("return table(sortBy(rows, 'label'))")
    // An odd key is quoted.
    expect(scaffoldType(ctx, 'paper')).toContain('"odd key": e.data["odd key"]')
    const py = scaffoldType(ctx, 'person', 'python')
    expect(py).toContain('df = entities.types.person.df')
    expect(py).toContain("df[['id', 'label', 'born', 'email']]")
    expect(scaffoldType(ctx, 'person', 'view')).toContain('aegraph.result(table(rows))')
  })

  it('a relationship scaffold says what it joins; the state scaffold describes the whole project with real counts', () => {
    const { schema } = setup()
    const ctx = { schema, project: { id: 'x', label: 'Papers' }, metrics: ['pagerank'] }
    expect(scaffoldRelationship(ctx, 'wrote')).toContain('// wrote: 1 relationships joining person → paper')
    expect(scaffoldRelationship(ctx, 'wrote')).toContain('const rows = relationships.types.wrote.map((r) => {')
    expect(scaffoldRelationship(ctx, 'wrote', 'python')).toContain("rel = relationships.types['wrote'].df")
    const state = scaffoldState(ctx)
    expect(state).toContain('//   project        Papers (x)')
    expect(state).toContain('//   entities       3: person (2), paper (1)')
    expect(state).toContain('//   relationships  1: wrote (1)')
    expect(state).toContain('//   tags           reviewed')
    expect(state).toContain('//   metrics        pagerank')
    expect(state).toContain('function main({ project, ontology, entities, relationships, tags, metrics })')
    expect(state).toContain('return main({ ...ds, tags: ds.tags() })')
    const lib = scaffoldState({ schema })
    expect(lib).toContain('null — the Library is open')
    expect(lib).toContain('none yet — run Insights')
    expect(scaffoldState(ctx, 'python')).toContain('def main(project, ontology, entities, relationships, tags, metrics):')
    expect(scaffoldState(ctx, 'view')).toContain("document.getElementById('app')")
  })
})

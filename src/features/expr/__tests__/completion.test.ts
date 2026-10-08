import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { exprCompletion } from '../completion'
import { buildExprSchema } from '../schema'

const setup = () => {
  const store = new EntityStore()
  store.upsertMany([
    createEntity({ id: 'p1', type: 'person', label: 'Ada', tags: ['reviewed'], data: { born: 1815, email: 'ada@x' } }),
    createEntity({ id: 'p2', type: 'person', label: 'Alan', data: { born: 1912 } }),
    createEntity({ id: 'w1', type: 'paper', label: 'Notes', data: { year: 1843 } }),
    createRelationship({ id: 'r1', type: 'wrote', source: 'p1', target: 'w1' }),
  ])
  const schema = buildExprSchema(store, new TypeRegistry(store))
  return { schema, complete: (doc: string, types?: string[]) => {
    const state = EditorState.create({ doc })
    const ctx = new CompletionContext(state, doc.length, true)
    return exprCompletion(() => schema, () => types)(ctx)
  } }
}
const labels = (r: ReturnType<ReturnType<typeof setup>['complete']>) => (r ? r.options.map((o) => o.label) : null)

describe('expression completion', () => {
  it('knows the data: properties with kind and coverage, relationship types, entity types, tags', () => {
    const { schema, complete } = setup()
    expect(schema.properties.get('person')?.map((p) => [p.key, p.kind, p.coverage])).toEqual([['born', 'number', 1], ['email', 'string', 0.5]])
    expect(schema.relationshipTypes[0]).toMatchObject({ type: 'wrote', count: 1, pairs: ['person → paper'] })
    expect(labels(complete('e.data.', ['person']))).toEqual(['born', 'email'])
    expect(complete('e.data.', ['person'])?.options[0].detail).toBe('number · 100%')
    expect(labels(complete('e.data.'))).toEqual(expect.arrayContaining(['born', 'email', 'year']))
    expect(labels(complete("out('"))).toEqual(['wrote'])
    expect(labels(complete("neighbors('wr"))).toEqual(['wrote'])
    expect(labels(complete("ofType('"))).toEqual(['person', 'paper'])
    expect(labels(complete("e.type === '"))).toEqual(expect.arrayContaining(['person', 'paper', 'wrote']))
    expect(labels(complete("e.tags.includes('"))).toEqual(['reviewed'])
    expect(labels(complete("get('"))).toEqual(expect.arrayContaining(['label', 'tags', 'data.born', 'meta.createdAt']))
  })

  it('knows the vocabulary: entity fields, meta, the store, and the helpers', () => {
    const { complete } = setup()
    expect(labels(complete('e.'))).toEqual(expect.arrayContaining(['id', 'type', 'label', 'data', 'source']))
    expect(labels(complete('source().'))).toEqual(expect.arrayContaining(['label', 'data']))
    expect(labels(complete('e.meta.'))).toEqual(expect.arrayContaining(['createdAt', 'source']))
    expect(labels(complete('store.'))).toEqual(expect.arrayContaining(['get', 'ofType', 'relationshipsOf']))
    const bare = complete('ne')
    expect(labels(bare)).toEqual(expect.arrayContaining(['neighbors', 'has', 'get', 'unique', 'e']))
    expect(bare?.options.find((o) => o.label === 'neighbors')?.apply).toBe('neighbors(')
  })
})

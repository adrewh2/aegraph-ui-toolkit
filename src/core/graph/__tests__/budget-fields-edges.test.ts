import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity } from '../../entity/types'
import { breakdown, DEFAULT_VIEW_BUDGET, exceedsBudget, shouldGate, suggestTrim, viewLoad } from '../budget'
import { coerce, dataAt, describePredicate, getPath, matchPredicate, sampleDataKeys, type FieldPredicate } from '../fields'

/**
 * What the first budget pass left: a view of edges only, a budget of zero
 * or less, a smaller view after a big one was accepted, duplicate edges,
 * and a trim on a view that only its node cap can trim. Then the filter's
 * attribute predicates at their edges: each operator against arrays,
 * objects, booleans, null, the empty string and zero; `in` from a string
 * with separators; `between` with too few bounds; a data key that is
 * itself dotted; the description of a predicate; the keys a builder is
 * offered.
 */
const load = (nodes: number, edges: number) => ({ nodes, edges })

describe('the view budget, again', () => {
  it('a view of edges only is over budget by its edges; a budget of zero gates any node, a negative one gates an empty view too', () => {
    const b = DEFAULT_VIEW_BUDGET
    expect(exceedsBudget(load(0, 15001), b)).toBe(true)
    expect(exceedsBudget(load(0, 0), { nodes: 0, edges: 0 })).toBe(false)
    expect(exceedsBudget(load(1, 0), { nodes: 0, edges: 0 })).toBe(true)
    expect(exceedsBudget(load(0, 0), { nodes: -1, edges: 0 })).toBe(true)
    // Accepted 10,000 nodes: 11,000 is the same picture, 11,001 is not; a smaller view is never asked about; the same view again is not.
    expect(shouldGate(load(11_000, 0), b, load(10_000, 0))).toBe(false)
    expect(shouldGate(load(11_001, 0), b, load(10_000, 0))).toBe(true)
    expect(shouldGate(load(3001, 0), b, load(10_000, 0))).toBe(false)
    expect(shouldGate(load(10_000, 0), b, load(10_000, 0))).toBe(false)
    // Accepted on nodes, then edges grow past the budget: that is a new picture.
    expect(shouldGate(load(10_000, 15_001), b, load(10_000, 100))).toBe(true)
    expect(shouldGate(load(0, 0), { nodes: -1, edges: 0 }, load(0, 0))).toBe(false) // accepted covers even the impossible budget
  })

  it('duplicate edges each count; a trim that cannot fit the edges keeps the last type; a view over on nodes alone is trimmed by the cap only', () => {
    const nodes = [createEntity({ id: 'a', type: 't' }), createEntity({ id: 'b', type: 't' })]
    const e = createRelationship({ id: 'e', type: 'r', source: 'a', target: 'b' })
    const twice = { nodes, edges: [e, e] }
    expect(viewLoad(twice)).toEqual({ nodes: 2, edges: 2 })
    expect(breakdown(twice).relTypes).toEqual([{ type: 'r', count: 2 }])
    expect(breakdown(twice).triples.get('r\tt\tt')).toBe(2)
    expect(suggestTrim(breakdown(twice), { nodes: 1, edges: 1 })).toEqual({ nodeTypes: new Set(['t']), relTypes: new Set(['r']), maxNodes: 1 })
    // Two types, both over: the bigger goes, the smaller stays even though it is over the budget alone.
    const f = createRelationship({ id: 'f', type: 's', source: 'b', target: 'a' })
    expect(suggestTrim(breakdown({ nodes, edges: [e, e, e, f, f] }), { nodes: 5, edges: 1 }).relTypes).toEqual(new Set(['s']))
    // Ties in count: the type earlier in the alphabet is listed first, so it is the first to go.
    expect(suggestTrim(breakdown({ nodes, edges: [e, f] }), { nodes: 5, edges: 1 }).relTypes).toEqual(new Set(['s']))
    expect(suggestTrim(breakdown({ nodes, edges: [] }), { nodes: 1, edges: 0 })).toEqual({ nodeTypes: new Set(['t']), relTypes: new Set(), maxNodes: 1 })
  })
})

const entity = (data: Record<string, unknown>, more: Partial<AnyEntity> = {}) => createEntity({ id: 'e', type: 'note', label: 'Label', tags: ['x', 'Y'], data, ...more }) as AnyEntity
const hit = (e: AnyEntity, path: string, op: FieldPredicate['op'], value?: unknown) => matchPredicate(e, { path, op, value })

describe('field predicates', () => {
  it('reads dotted data keys literally first, then as a path, never into arrays; meta and the base fields by name; anything else off the entity', () => {
    const e = entity({ 'a.b': 1, a: { b: 2, list: [{ c: 3 }] }, n: null })
    expect(dataAt(e.data, 'a.b')).toBe(1)
    expect(dataAt(e.data, 'a.list.0.c')).toBeUndefined()
    expect(dataAt(e.data, 'a.b.c')).toBeUndefined()
    expect(dataAt(e.data, 'n.x')).toBeUndefined()
    expect(getPath(e, 'data.a.b')).toBe(1)
    expect(getPath(e, 'meta.createdAt')).toMatch(/^\d{4}-/)
    expect(getPath(e, 'meta.nope')).toBeUndefined()
    expect([getPath(e, 'label'), getPath(e, 'type'), getPath(e, 'id'), getPath(e, 'tags'), getPath(e, 'description')]).toEqual(['Label', 'note', 'e', ['x', 'Y'], undefined])
    expect(getPath(e, 'kind')).toBe('entity')
    expect(getPath(e, 'data')).toBe(e.data)
  })

  it('exists is present-and-not-empty: null, undefined and "" are absent, 0 and false and [] are present; neq is true of the absent', () => {
    const e = entity({ zero: 0, no: false, empty: '', nil: null, list: [], obj: {} })
    for (const k of ['zero', 'no', 'list', 'obj']) expect(hit(e, `data.${k}`, 'exists'), k).toBe(true)
    for (const k of ['empty', 'nil', 'missing']) expect(hit(e, `data.${k}`, 'exists'), k).toBe(false)
    expect(hit(e, 'data.missing', 'neq', 1)).toBe(true)
    expect(hit(e, 'data.empty', 'neq', '')).toBe(true)
    for (const op of ['eq', 'contains', 'gt', 'gte', 'lt', 'lte', 'between', 'in'] as const) expect(hit(e, 'data.missing', op, 1), op).toBe(false)
    expect(hit(e, 'data.zero', 'eq', 0)).toBe(true)
    expect(hit(e, 'data.zero', 'eq', '0')).toBe(true)
    expect(hit(e, 'data.zero', 'lt', 1)).toBe(true)
    expect(hit(e, 'data.no', 'eq', false)).toBe(true)
    expect(hit(e, 'data.no', 'eq', 'false')).toBe(true)
    expect(hit(e, 'data.no', 'eq', 0)).toBe(false) // a boolean is compared as its word
  })

  it('compares numbers as numbers whatever their spelling, ISO dates as instants, and the rest as lowercase text; booleans as words', () => {
    expect(coerce('10', 9)).toEqual([10, 9])
    expect(coerce(' 10 ', '9')).toEqual([10, 9])
    expect(coerce('', 0)).toEqual(['', '0'])
    expect(coerce('2024-01-02', '2024-01-01T00:00:00Z')).toEqual([Date.parse('2024-01-02'), Date.parse('2024-01-01T00:00:00Z')])
    expect(coerce('2024-01-02', 'yesterday')).toEqual(['2024-01-02', 'yesterday'])
    expect(coerce('2024-13-45', '2024-01-01')).toEqual(['2024-13-45', '2024-01-01']) // an ISO-looking date that does not parse stays text
    expect(coerce(true, 'TRUE')).toEqual(['true', 'TRUE'])
    expect(coerce(null, undefined)).toEqual(['', ''])
    expect(coerce('Abc', 'aBC')).toEqual(['abc', 'abc'])
    expect(coerce(1e3, '1e3')).toEqual([1000, 1000])
    expect(coerce('0x10', 16)).toEqual([16, 16])
    expect(coerce('Infinity', 1)).toEqual(['infinity', '1']) // Infinity is not finite: text
    const e = entity({ year: '1999', when: '2024-05-01', name: 'Ada Lovelace' })
    expect(hit(e, 'data.year', 'gte', 1999)).toBe(true)
    expect(hit(e, 'data.year', 'lt', '2000')).toBe(true)
    expect(hit(e, 'data.year', 'between', ['1990', 2000])).toBe(true)
    expect(hit(e, 'data.year', 'between', [2000])).toBe(false)
    expect(hit(e, 'data.year', 'between', 'not a list')).toBe(false)
    expect(hit(e, 'data.when', 'between', ['2024-05-01', '2024-05-01'])).toBe(true)
    expect(hit(e, 'data.when', 'gt', '2024-04-30T23:59:59Z')).toBe(true)
    expect(hit(e, 'data.name', 'gt', 'ada')).toBe(true) // "ada lovelace" > "ada"
    expect(hit(e, 'data.name', 'lte', 'ADA LOVELACE')).toBe(true)
  })

  it('arrays match when any member does — eq, neq, in, contains — tags included; contains searches objects as JSON and numbers as text; in reads a string list on commas, semicolons or bars', () => {
    const e = entity({ list: ['Alpha', 2, null], obj: { deep: { key: 'Needle' } }, n: 12345, word: 'Haystack' })
    expect(hit(e, 'tags', 'eq', 'y')).toBe(true)
    expect(hit(e, 'tags', 'neq', 'y')).toBe(false)
    expect(hit(e, 'tags', 'neq', 'z')).toBe(true)
    expect(hit(e, 'tags', 'contains', 'X')).toBe(true)
    expect(hit(e, 'tags', 'in', 'a, y')).toBe(true)
    expect(hit(e, 'data.list', 'eq', 2)).toBe(true)
    expect(hit(e, 'data.list', 'eq', '2')).toBe(true)
    expect(hit(e, 'data.list', 'contains', 'alp')).toBe(true)
    expect(hit(e, 'data.list', 'contains', 'null')).toBe(true) // String(null) is searched too
    expect(hit(e, 'data.list', 'in', ['alpha'])).toBe(true)
    expect(hit(e, 'data.list', 'gt', 1)).toBe(true) // order ops do not look into arrays: the list's text "alpha,2," is compared with "1"
    expect(hit(e, 'data.obj', 'contains', 'needle')).toBe(true)
    expect(hit(e, 'data.obj', 'contains', '"deep"')).toBe(true)
    expect(hit(e, 'data.n', 'contains', '234')).toBe(true)
    expect(hit(e, 'data.word', 'contains', '')).toBe(true)
    expect(hit(e, 'data.word', 'contains', undefined)).toBe(true)
    expect(hit(e, 'data.word', 'in', 'hay;haystack|x')).toBe(true)
    expect(hit(e, 'data.word', 'in', ' , ; ')).toBe(false)
    expect(hit(e, 'data.word', 'in', undefined)).toBe(false)
    expect(hit(e, 'data.n', 'in', '12345.0,1')).toBe(true)
    expect(hit(e, 'data.word', 'in', ['HAYSTACK'])).toBe(true)
  })

  it('describes a predicate the way the filter bar shows it, quoting only what needs it; offers the primitive data keys of the first rows plus the base fields', () => {
    expect(describePredicate({ path: 'data.year', op: 'gte', value: 1990 })).toBe('data.year ≥ 1990')
    expect(describePredicate({ path: 'label', op: 'contains', value: 'two words' })).toBe('label contains “two words”')
    expect(describePredicate({ path: 'label', op: 'eq', value: 'a'.repeat(30) })).toBe(`label = “${'a'.repeat(22)}…”`)
    expect(describePredicate({ path: 'data.x', op: 'exists', value: 'ignored' })).toBe('data.x exists')
    expect(describePredicate({ path: 'data.x', op: 'between', value: [1, 'ten'] })).toBe('data.x in [1, ten]')
    expect(describePredicate({ path: 'data.x', op: 'between', value: 5 })).toBe('data.x between 5')
    expect(describePredicate({ path: 'type', op: 'in', value: ['a', 'b c'] })).toBe('type in {a, “b c”}')
    expect(describePredicate({ path: 'type', op: 'in', value: 'a,b' })).toBe('type in {a,b}')
    expect(describePredicate({ path: 'data.x', op: 'bogus' as FieldPredicate['op'], value: null })).toBe('data.x bogus null')
    const rows = [entity({ s: 'x', n: 1, b: true, nil: null, u: undefined, o: {}, l: [] }), entity({ later: 'y' })]
    expect(sampleDataKeys(rows)).toEqual(['data.b', 'data.later', 'data.n', 'data.s', 'label', 'meta.createdAt', 'meta.updatedAt', 'tags', 'type'])
    expect(sampleDataKeys(rows, 1)).not.toContain('data.later')
    expect(sampleDataKeys([])).toEqual(['label', 'meta.createdAt', 'meta.updatedAt', 'tags', 'type'])
  })
})
